'use strict';
// Portal de etiquetas dos clientes.
//
// Fluxo:
//  1. No painel, o administrador cadastra o cliente (só o nome) e gera um link secreto.
//     As lojas saem do REMETENTE de cada etiqueta e são agrupadas sozinhas.
//  2. Pelo link, o cliente sobe as etiquetas (PDF lido no navegador dele, ou códigos digitados).
//     Cada envio vira um LOTE.
//  3. A extensão "Subir Etiquetas" (no computador da GoBox, logado no SPX) pega o próximo
//     lote, sobe no Recebimento de Postagem e devolve o resultado de cada código.
//  4. Quando o cliente leva os pacotes, a equipe bipa: o pacote recebe baixa e sai
//     da lista "falta entregar" do cliente e do painel.
//
// Tudo fica na tabela settings (chave "__portal"), que o site já copia para o Firebase.

const crypto = require('node:crypto');
const eventos = require('./eventos');

const CHAVE = '__portal';
const COD_RE = /^BR\d{12}[0-9A-Z]$/;
const MAX_POR_ENVIO = 600;
const RESERVA_EXPIRA_MIN = 20;     // extensão pegou o lote e não respondeu: volta para a fila
const GUARDAR_ENTREGUES_DIAS = 45;
const GUARDAR_LOTES_DIAS = 20;

// ---------- armazenamento ----------
function ler(db) {
  const row = db.prepare('SELECT json FROM settings WHERE source = ?').get(CHAVE);
  const d = row ? JSON.parse(row.json) : {};
  return { clientes: d.clientes || {}, pacotes: d.pacotes || {}, lotes: d.lotes || [] };
}
function gravar(db, dados, agora = Date.now()) {
  const corteP = agora - GUARDAR_ENTREGUES_DIAS * 86400_000;
  for (const [k, p] of Object.entries(dados.pacotes)) {
    if (p.entregueEm && Date.parse(p.entregueEm) < corteP) delete dados.pacotes[k];
  }
  const corteL = agora - GUARDAR_LOTES_DIAS * 86400_000;
  dados.lotes = dados.lotes.filter((l) => l.situacao !== 'concluido' || Date.parse(l.concluidoEm) >= corteL);
  db.prepare(`INSERT INTO settings (source, json) VALUES (?, ?)
              ON CONFLICT(source) DO UPDATE SET json = excluded.json`).run(CHAVE, JSON.stringify(dados));
  eventos.emit('estado');
}

// ---------- utilidades ----------
const iso = (t) => new Date(t).toISOString();
const texto = (v, max = 60) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const normLoja = (s) => texto(s, 80).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const normCodigo = (s) => String(s || '').toUpperCase().replace(/\s+/g, '');
const novoToken = () => crypto.randomBytes(18).toString('base64url');
const novoId = () => crypto.randomBytes(6).toString('hex');
function erro(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

function limparLojas(lista) {
  const vistas = new Set();
  const out = [];
  for (const l of Array.isArray(lista) ? lista : []) {
    const t = texto(l, 60);
    if (!t || vistas.has(normLoja(t))) continue;
    vistas.add(normLoja(t));
    out.push(t);
  }
  return out.slice(0, 30);
}

// Lojas que o cliente já tem: as cadastradas (versões antigas) + as lidas nas etiquetas.
function lojasConhecidas(dados, c) {
  const vistas = new Map();
  for (const l of c.lojas || []) if (!vistas.has(normLoja(l))) vistas.set(normLoja(l), l);
  for (const p of Object.values(dados.pacotes)) {
    if (p.cliente === c.id && p.loja && !vistas.has(normLoja(p.loja))) vistas.set(normLoja(p.loja), p.loja);
  }
  return [...vistas.values()];
}
// Liga o remetente lido na etiqueta a uma loja que o cliente já tem (mesmo nome, sem
// diferença de maiúsculas/acentos), para a mesma loja não aparecer duas vezes.
function acharLoja(lojas, nome) {
  const n = normLoja(nome);
  if (!n) return null;
  return lojas.find((l) => normLoja(l) === n) || null;
}

// ---------- clientes (painel) ----------
function criarCliente(db, { nome, lojas } = {}) {
  const n = texto(nome, 60);
  if (!n) throw erro('Digite o nome do cliente.');
  const ls = limparLojas(lojas);
  const dados = ler(db);
  const c = { id: novoId(), nome: n, lojas: ls, token: novoToken(), ativo: true, criadoEm: iso(Date.now()) };
  dados.clientes[c.id] = c;
  gravar(db, dados);
  return c;
}
function editarCliente(db, id, patch = {}) {
  const dados = ler(db);
  const c = dados.clientes[id];
  if (!c) throw erro('Cliente não encontrado.', 404);
  if (patch.nome !== undefined) { const n = texto(patch.nome, 60); if (!n) throw erro('Digite o nome do cliente.'); c.nome = n; }
  if (patch.lojas !== undefined) c.lojas = limparLojas(patch.lojas);
  if (patch.ativo !== undefined) c.ativo = patch.ativo === true;
  gravar(db, dados);
  return c;
}
function novoLink(db, id) {
  const dados = ler(db);
  const c = dados.clientes[id];
  if (!c) throw erro('Cliente não encontrado.', 404);
  c.token = novoToken();
  gravar(db, dados);
  return c;
}

// Exclui o cliente: o link para de funcionar na hora e os pacotes dele saem do sistema.
function excluirCliente(db, id) {
  const dados = ler(db);
  if (!dados.clientes[id]) throw erro('Cliente não encontrado.', 404);
  delete dados.clientes[id];
  for (const [k, p] of Object.entries(dados.pacotes)) if (p.cliente === id) delete dados.pacotes[k];
  dados.lotes = dados.lotes.filter((l) => l.cliente !== id);
  gravar(db, dados);
  return { ok: true };
}

function clienteDoToken(dados, token) {
  const t = String(token || '');
  if (t.length < 16) return null;
  const c = Object.values(dados.clientes).find((x) => {
    const a = Buffer.from(x.token); const b = Buffer.from(t);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
  return c && c.ativo ? c : null;
}

// ---------- contagens ----------
function contar(dados, c) {
  const meus = Object.values(dados.pacotes).filter((p) => p.cliente === c.id);
  const porLoja = new Map();
  const tot = { subidos: 0, entregues: 0, faltam: 0, noSpx: 0, aguardandoSpx: 0, erroSpx: 0 };
  for (const p of meus) {
    const nome = p.loja || 'Sem loja';
    if (!porLoja.has(nome)) porLoja.set(nome, { loja: nome, subidos: 0, entregues: 0, faltam: 0 });
    const g = porLoja.get(nome);
    g.subidos++; tot.subidos++;
    if (p.entregueEm) { g.entregues++; tot.entregues++; } else { g.faltam++; tot.faltam++; }
    if (p.spx === 'subido') tot.noSpx++; else if (p.spx === 'erro') tot.erroSpx++; else tot.aguardandoSpx++;
  }
  // Lojas com pacotes faltando primeiro, depois as maiores.
  const lojas = [...porLoja.values()].sort((a, b) => b.faltam - a.faltam || b.subidos - a.subidos || a.loja.localeCompare(b.loja, 'pt-BR'));
  return { totais: tot, lojas, pacotes: meus };
}

const pacotePublico = (p) => ({
  codigo: p.codigo, loja: p.loja || '', subidoEm: p.subidoEm, entregueEm: p.entregueEm || null,
  spx: p.spx, origem: p.origem
});

// ---------- página do cliente ----------
function painelCliente(db, token) {
  const dados = ler(db);
  const c = clienteDoToken(dados, token);
  if (!c) throw erro('Link inválido ou desativado. Peça um link novo à GoBox.', 404);
  const { totais, lojas, pacotes } = contar(dados, c);
  pacotes.sort((a, b) => String(b.entregueEm || b.subidoEm).localeCompare(String(a.entregueEm || a.subidoEm)));
  return {
    cliente: c.nome,
    lojasConhecidas: lojasConhecidas(dados, c),
    totais: { subidos: totais.subidos, entregues: totais.entregues, faltam: totais.faltam },
    lojas,
    pacotes: pacotes.map(pacotePublico)
  };
}

// lista: [{codigo, loja}] — loja = remetente lido no PDF ou a loja escolhida ao digitar.
function subirEtiquetas(db, token, { pacotes, origem } = {}, { agora = Date.now() } = {}) {
  const dados = ler(db);
  const c = clienteDoToken(dados, token);
  if (!c) throw erro('Link inválido ou desativado. Peça um link novo à GoBox.', 404);
  if (!Array.isArray(pacotes) || !pacotes.length) throw erro('Nenhum código enviado.');
  if (pacotes.length > MAX_POR_ENVIO) throw erro(`Mande no máximo ${MAX_POR_ENVIO} etiquetas por vez.`);
  const org = origem === 'pdf' ? 'pdf' : 'digitado';
  const r = { novos: 0, jaSubidos: 0, deOutroCliente: 0, invalidos: [], porLoja: {} };
  const conhecidas = lojasConhecidas(dados, c);
  const vistos = new Set();
  const lote = { id: novoId(), cliente: c.id, criadoEm: iso(agora), codigos: [], situacao: 'pendente' };
  for (const item of pacotes) {
    const codigo = normCodigo(item && item.codigo);
    if (!COD_RE.test(codigo)) { if (codigo) r.invalidos.push(codigo.slice(0, 20)); continue; }
    if (vistos.has(codigo)) continue;
    vistos.add(codigo);
    const existe = dados.pacotes[codigo];
    if (existe) { if (existe.cliente === c.id) r.jaSubidos++; else r.deOutroCliente++; continue; }
    const lido = texto(item.loja, 60);
    let loja = acharLoja(conhecidas, lido);
    if (!loja && lido) { loja = lido; conhecidas.push(lido); }
    loja = loja || '';
    r.porLoja[loja || 'Sem loja'] = (r.porLoja[loja || 'Sem loja'] || 0) + 1;
    dados.pacotes[codigo] = {
      codigo, cliente: c.id, loja, origem: org,
      subidoEm: iso(agora), lote: lote.id, spx: 'pendente', spxEm: null, spxErro: null, entregueEm: null
    };
    lote.codigos.push(codigo);
    r.novos++;
  }
  if (lote.codigos.length) dados.lotes.push(lote);
  gravar(db, dados, agora);
  r.invalidos = r.invalidos.slice(0, 20);
  r.faltam = contar(dados, c).totais.faltam;
  return r;
}

// O cliente pode tirar um código que subiu errado, enquanto ainda não foi para o SPX.
function removerEtiqueta(db, token, codigo) {
  const dados = ler(db);
  const c = clienteDoToken(dados, token);
  if (!c) throw erro('Link inválido ou desativado.', 404);
  const cod = normCodigo(codigo);
  const p = dados.pacotes[cod];
  if (!p || p.cliente !== c.id) throw erro('Código não encontrado.', 404);
  if (p.spx === 'subido' || p.entregueEm) throw erro('Esse pacote já foi registrado pela GoBox e não pode ser tirado.');
  delete dados.pacotes[cod];
  for (const l of dados.lotes) l.codigos = l.codigos.filter((x) => x !== cod);
  dados.lotes = dados.lotes.filter((l) => l.codigos.length || l.situacao === 'concluido');
  gravar(db, dados);
  return { ok: true };
}

// ---------- extensão (computador da GoBox) ----------
function expirarReservas(dados, agora) {
  for (const l of dados.lotes) {
    if (l.situacao === 'reservado' && agora - Date.parse(l.reservadoEm) > RESERVA_EXPIRA_MIN * 60_000) {
      l.situacao = 'pendente'; l.reservadoEm = null;
    }
  }
}

function fila(db, { agora = Date.now() } = {}) {
  const dados = ler(db);
  expirarReservas(dados, agora);
  return dados.lotes
    .filter((l) => l.situacao !== 'concluido')
    .map((l) => {
      const c = dados.clientes[l.cliente];
      const pend = l.codigos.filter((k) => dados.pacotes[k] && dados.pacotes[k].spx !== 'subido');
      return { id: l.id, cliente: c ? c.nome : '?', criadoEm: l.criadoEm, situacao: l.situacao, quantidade: pend.length, lojas: porLojaDe(dados, pend) };
    })
    .filter((l) => l.quantidade > 0);
}

// { "NOME DA LOJA": [códigos] } — lojas lidas do remetente das etiquetas.
function porLojaDe(dados, codigos) {
  const out = {};
  for (const k of codigos) { const n = (dados.pacotes[k] && dados.pacotes[k].loja) || 'Sem loja'; (out[n] = out[n] || []).push(k); }
  return out;
}

// Reserva um lote (o indicado, ou o mais antigo) e entrega os códigos que faltam subir.
function reservarLote(db, id, { agora = Date.now() } = {}) {
  const dados = ler(db);
  expirarReservas(dados, agora);
  const candidatos = dados.lotes.filter((l) => l.situacao !== 'concluido');
  const l = id ? candidatos.find((x) => x.id === id) : candidatos.find((x) => x.situacao === 'pendente');
  if (!l) return null;
  const codigos = l.codigos.filter((k) => dados.pacotes[k] && dados.pacotes[k].spx !== 'subido');
  if (!codigos.length) { l.situacao = 'concluido'; l.concluidoEm = iso(agora); gravar(db, dados, agora); return null; }
  l.situacao = 'reservado'; l.reservadoEm = iso(agora);
  gravar(db, dados, agora);
  const c = dados.clientes[l.cliente];
  return { id: l.id, cliente: c ? c.nome : '?', criadoEm: l.criadoEm, codigos, lojas: porLojaDe(dados, codigos) };
}

// resultado: { ok: [codigos], erros: [{codigo, erro}] }
function resultadoLote(db, id, { ok, erros } = {}, { agora = Date.now() } = {}) {
  const dados = ler(db);
  const l = dados.lotes.find((x) => x.id === id);
  if (!l) throw erro('Lote não encontrado.', 404);
  let subidos = 0, comErro = 0;
  for (const k of Array.isArray(ok) ? ok : []) {
    const p = dados.pacotes[normCodigo(k)];
    if (p && p.lote === l.id) { p.spx = 'subido'; p.spxEm = iso(agora); p.spxErro = null; subidos++; }
  }
  for (const e of Array.isArray(erros) ? erros : []) {
    const p = dados.pacotes[normCodigo(e && e.codigo)];
    if (p && p.lote === l.id && p.spx !== 'subido') { p.spx = 'erro'; p.spxErro = texto(e.erro, 120) || 'erro no SPX'; comErro++; }
  }
  // Fica concluído; o que deu erro pode voltar para a fila pelo painel (Tentar de novo).
  l.situacao = 'concluido'; l.concluidoEm = iso(agora);
  gravar(db, dados, agora);
  return { subidos, comErro };
}

// Erros do SPX voltam para a fila num lote novo.
function tentarDeNovo(db, clienteId, { agora = Date.now() } = {}) {
  const dados = ler(db);
  const cods = Object.values(dados.pacotes).filter((p) => p.spx === 'erro' && !p.entregueEm && (!clienteId || p.cliente === clienteId));
  const porCliente = new Map();
  for (const p of cods) { if (!porCliente.has(p.cliente)) porCliente.set(p.cliente, []); porCliente.get(p.cliente).push(p); }
  for (const [cli, lista] of porCliente) {
    const lote = { id: novoId(), cliente: cli, criadoEm: iso(agora), codigos: lista.map((p) => p.codigo), situacao: 'pendente' };
    for (const p of lista) { p.spx = 'pendente'; p.spxErro = null; p.lote = lote.id; }
    dados.lotes.push(lote);
  }
  gravar(db, dados, agora);
  return { reenviados: cods.length };
}

// ---------- bipagem (baixa na entrega) ----------
function bipar(db, codigo, { agora = Date.now() } = {}) {
  const dados = ler(db);
  const cod = normCodigo(codigo);
  if (!cod) throw erro('Bipe ou digite um código.');
  const p = dados.pacotes[cod];
  if (!p) return { situacao: 'desconhecido', codigo: cod };
  const c = dados.clientes[p.cliente];
  if (p.entregueEm) return { situacao: 'ja_bipado', codigo: cod, cliente: c && c.nome, loja: p.loja, entregueEm: p.entregueEm };
  p.entregueEm = iso(agora);
  gravar(db, dados, agora);
  const faltam = Object.values(dados.pacotes).filter((x) => x.cliente === p.cliente && !x.entregueEm).length;
  const faltamLoja = Object.values(dados.pacotes).filter((x) => x.cliente === p.cliente && x.loja === p.loja && !x.entregueEm).length;
  return { situacao: 'baixa', codigo: cod, cliente: c && c.nome, loja: p.loja, faltam, faltamLoja };
}
function desfazerBaixa(db, codigo) {
  const dados = ler(db);
  const p = dados.pacotes[normCodigo(codigo)];
  if (!p) throw erro('Código não encontrado.', 404);
  p.entregueEm = null;
  gravar(db, dados);
  return { ok: true };
}

// ---------- painel ----------
function resumo(db, { agora = Date.now() } = {}) {
  const dados = ler(db);
  expirarReservas(dados, agora);
  const clientes = Object.values(dados.clientes)
    .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'))
    .map((c) => {
      const { totais, lojas, pacotes } = contar(dados, c);
      const ultimo = pacotes.reduce((m, p) => (p.subidoEm > m ? p.subidoEm : m), '');
      return {
        id: c.id, nome: c.nome, lojas: c.lojas, ativo: c.ativo, token: c.token, criadoEm: c.criadoEm,
        totais, porLoja: lojas, ultimoEnvio: ultimo || null
      };
    });
  const pacotes = Object.values(dados.pacotes).map((p) => ({
    ...pacotePublico(p), cliente: p.cliente, clienteNome: (dados.clientes[p.cliente] || {}).nome || '?',
    spxErro: p.spxErro
  })).sort((a, b) => String(b.entregueEm || b.subidoEm).localeCompare(String(a.entregueEm || a.subidoEm)));
  return { clientes, pacotes, fila: fila(db, { agora }) };
}

module.exports = {
  criarCliente, editarCliente, novoLink, excluirCliente, painelCliente, subirEtiquetas, removerEtiqueta,
  fila, reservarLote, resultadoLote, tentarDeNovo, bipar, desfazerBaixa, resumo
};
