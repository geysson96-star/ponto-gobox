'use strict';
// Cotação de fretes da parceria GoBox × Azul Cargo Express.
//
// O cliente informa destino e pacote na página /frete e vê só o preço final de cada
// serviço. O custo da Azul, a margem e a taxa de transporte Tobias Barreto → Aracaju
// ficam no servidor e só aparecem no painel (aba Fretes).
//
// Preço = (frete Azul + seguro + embalagem + transporte) × (1 + margem), terminando em ,90.
//
// Tudo fica na tabela "financeiro" com chaves "fretes:*", que já é salva no Firebase
// pela persistência. Para tirar a aba, basta apagar este arquivo e as rotas.

const eventos = require('./eventos');
const PADRAO = require('./fretes-tarifas.json');

const UFS = {
  AC: 'Acre', AL: 'Alagoas', AM: 'Amazonas', AP: 'Amapá', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal',
  ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MG: 'Minas Gerais', MS: 'Mato Grosso do Sul',
  MT: 'Mato Grosso', PA: 'Pará', PB: 'Paraíba', PE: 'Pernambuco', PI: 'Piauí', PR: 'Paraná',
  RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RO: 'Rondônia', RR: 'Roraima', RS: 'Rio Grande do Sul',
  SC: 'Santa Catarina', SE: 'Sergipe', SP: 'São Paulo', TO: 'Tocantins'
};
const CAPITAIS = {
  AC: 'Rio Branco', AL: 'Maceió', AM: 'Manaus', AP: 'Macapá', BA: 'Salvador', CE: 'Fortaleza', DF: 'Brasília',
  ES: 'Vitória', GO: 'Goiânia', MA: 'São Luís', MG: 'Belo Horizonte', MS: 'Campo Grande', MT: 'Cuiabá',
  PA: 'Belém', PB: 'João Pessoa', PE: 'Recife', PI: 'Teresina', PR: 'Curitiba', RJ: 'Rio de Janeiro',
  RN: 'Natal', RO: 'Porto Velho', RR: 'Boa Vista', RS: 'Porto Alegre', SC: 'Florianópolis', SE: 'Aracaju',
  SP: 'São Paulo', TO: 'Palmas'
};
const TIPOS = { C: 'capital', I: 'interior', R: 'interior distante' };

// Seguro (ad-valorem + GRIS) da planilha "Taxas adicionais" de cada serviço: [capital, interior].
const SERVICOS = [
  { id: 'eco', nome: 'E-commerce', tag: 'Econômico', descricao: 'O melhor preço para pacotes do dia a dia.',
    seguro: [0.40, 0.90], atende: 'Capital, interior e interior distante', limites: 'De 250 g a 30 kg (acima, cobra por kg extra)' },
  { id: 'exp', nome: 'Expresso', tag: 'Mais rápido', descricao: 'Via aérea com prioridade sobre o E-commerce.',
    seguro: [0.70, 0.90], atende: 'Capital, interior e interior distante', limites: 'De 100 g a 30 kg (acima, cobra por kg extra)' },
  { id: 'pre', nome: 'Premium', tag: 'Urgente', descricao: 'Prioridade máxima no embarque. Aceita documentos.',
    seguro: [1.00, 1.30], atende: 'Somente capitais', limites: 'Documento até 100 g ou de 1 a 30 kg' },
  { id: 'std', nome: 'Standard', tag: 'Carga pesada', descricao: 'Para volumes grandes. Cobrança mínima de 30 kg.',
    seguro: [0.40, 0.90], atende: 'Cidades-base da Azul', limites: 'Mínimo de 30 kg + valor por kg extra' }
];
const SERVICO = Object.fromEntries(SERVICOS.map((s) => [s.id, s]));
const EMBALAGENS = { 0: 'Já vou levar embalado', 1.3: 'Envelope', 4.2: 'Caixa 1', 5: 'Caixa 2', 6.45: 'Caixa de vinho' };
const FATOR_CUBAGEM = 6000;
const CONFIG_PADRAO = { margem: 10, transporte: 5 };
const MAX_COTACOES = 300;

// ---------- armazenamento ----------
function garantir(db) { db.exec('CREATE TABLE IF NOT EXISTS financeiro (chave TEXT PRIMARY KEY, json TEXT NOT NULL)'); }
function ler(db, chave, padrao) {
  garantir(db);
  const r = db.prepare('SELECT json FROM financeiro WHERE chave = ?').get(chave);
  if (!r) return padrao;
  try { return JSON.parse(r.json); } catch { return padrao; }
}
function gravar(db, chave, valor) {
  garantir(db);
  db.prepare(`INSERT INTO financeiro (chave, json) VALUES (?, ?)
              ON CONFLICT(chave) DO UPDATE SET json = excluded.json`).run(chave, JSON.stringify(valor));
  eventos.emit('estado');
}

function config(db) { return { ...CONFIG_PADRAO, ...ler(db, 'fretes:config', {}) }; }
function salvarConfig(db, b) {
  const atual = config(db);
  const num = (v, min, max, nome) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${nome} deve ficar entre ${min} e ${max}.`);
    return Math.round(n * 100) / 100;
  };
  const novo = { ...atual };
  if (b.margem !== undefined) novo.margem = num(b.margem, 0, 200, 'A margem');
  if (b.transporte !== undefined) novo.transporte = num(b.transporte, 0, 500, 'O transporte');
  gravar(db, 'fretes:config', novo);
  return novo;
}

function tarifas(db) {
  const t = { ...PADRAO };
  for (const s of ['eco', 'exp', 'pre', 'std']) {
    const novo = ler(db, `fretes:tarifa:${s}`, null);
    if (novo) { t[s] = novo.dados; t[`${s}Info`] = { vigencia: novo.vigencia, importadoEm: novo.importadoEm }; }
  }
  return t;
}

// ---------- cálculo ----------
const norm = (t) => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
const centavos = (v) => Math.round(v * 100) / 100;
// Preço termina em ,90 (o mais próximo).
const fim90 = (v) => Math.max(0.9, Math.round(v - 0.9) + 0.9);

function validarPedido(b = {}) {
  const uf = String(b.uf || '').toUpperCase();
  if (!UFS[uf]) throw new Error('Escolha o estado de destino.');
  const tipo = TIPOS[b.tipo] ? b.tipo : 'C';
  const n = (v, max) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? Math.min(x, max) : 0; };
  const peso = n(b.peso, 1000);
  if (!peso) throw new Error('Informe o peso do pacote.');
  const emb = Number(b.embalagem) || 0;
  return {
    uf, tipo, peso,
    valor: Math.min(Math.max(Number(b.valor) || 0, 0), 1_000_000),
    altura: n(b.altura, 300), largura: n(b.largura, 300), comprimento: n(b.comprimento, 300),
    embalagem: EMBALAGENS[emb] ? emb : 0,
    documento: b.documento === true,
    base: typeof b.base === 'string' ? b.base.slice(0, 12) : ''
  };
}

function pesoConsiderado(p) {
  const cub = p.altura && p.largura && p.comprimento ? (p.altura * p.largura * p.comprimento) / FATOR_CUBAGEM : 0;
  return { real: p.peso, cubado: centavos(cub), cobrado: centavos(Math.max(p.peso, cub)) };
}

function freteAzul(t, id, p, peso) {
  if (id === 'std') {
    const bases = t.std.filter((b) => b[2] === p.uf);
    if (!bases.length) return { erro: 'Sem cidade-base da Azul neste estado' };
    const b = bases.find((x) => x[0] === p.base)
      || bases.find((x) => norm(x[1]) === norm(CAPITAIS[p.uf])) || bases[0];
    const extra = Math.max(0, Math.ceil(peso - 30 - 1e-9));
    return { valor: b[3] + extra * b[4], faixa: extra ? `30 kg + ${extra} kg extra` : 'mínimo de 30 kg', base: b[0], bases };
  }
  if (id === 'pre') {
    if (p.tipo !== 'C') return { erro: 'Só atende capitais' };
    const row = t.pre.t[p.uf];
    if (!row) return { erro: 'Sem tarifa para este destino' };
    if (p.documento && peso <= 0.1) return { valor: row[0], faixa: 'documento até 100 g' };
    if (peso <= 30) { const k = Math.max(1, Math.ceil(peso - 1e-9)); return { valor: row[k], faixa: `até ${k} kg` }; }
    const extra = Math.ceil(peso - 30 - 1e-9);
    return { valor: row[30] + extra * row[31], faixa: `30 kg + ${extra} kg extra` };
  }
  const row = t[id].t[p.uf] && t[id].t[p.uf][p.tipo];
  if (!row) return { erro: 'Sem tarifa para este destino' };
  const w = t[id].w;
  const ult = w.length - 1;
  if (peso <= w[ult]) {
    const i = w.findIndex((x) => x >= peso - 1e-9);
    return { valor: row[i], faixa: `até ${String(w[i]).replace('.', ',')} kg` };
  }
  const extra = Math.ceil(peso - w[ult] - 1e-9);
  return { valor: row[ult] + extra * row[w.length], faixa: `30 kg + ${extra} kg extra` };
}

// Conta completa de um serviço (com custo e lucro: só para o painel).
function calcular(db, id, pedido, t = tarifas(db), cfg = config(db)) {
  const s = SERVICO[id];
  const pc = pesoConsiderado(pedido);
  const f = freteAzul(t, id, pedido, pc.cobrado);
  if (f.erro) return { servico: id, indisponivel: f.erro };
  const seguroPct = s.seguro[pedido.tipo === 'C' ? 0 : 1];
  const seguro = centavos((pedido.valor * seguroPct) / 100);
  const custo = centavos(f.valor + seguro + pedido.embalagem + cfg.transporte);
  const preco = centavos(fim90(custo * (1 + cfg.margem / 100)));
  return {
    servico: id, frete: centavos(f.valor), faixa: f.faixa, seguroPct, seguro, embalagem: pedido.embalagem,
    transporte: cfg.transporte, custo, margem: cfg.margem, preco, lucro: centavos(preco - custo),
    base: f.base || null, bases: f.bases || null
  };
}

// O que o cliente vê: preço final e informações do serviço, sem custo nem margem.
function cotar(db, corpo) {
  const p = validarPedido(corpo);
  const t = tarifas(db);
  const cfg = config(db);
  const pc = pesoConsiderado(p);
  const opcoes = SERVICOS.map((s) => {
    const c = calcular(db, s.id, p, t, cfg);
    const info = { id: s.id, nome: s.nome, tag: s.tag, descricao: s.descricao, atende: s.atende, limites: s.limites };
    if (c.indisponivel) return { ...info, indisponivel: c.indisponivel };
    return {
      ...info, preco: c.preco, faixa: c.faixa, seguroPct: c.seguroPct, embalagem: c.embalagem,
      base: c.base, bases: c.bases ? c.bases.map((b) => ({ codigo: b[0], cidade: b[1] })) : undefined
    };
  });
  return {
    destino: { uf: p.uf, estado: UFS[p.uf], tipo: p.tipo, capital: CAPITAIS[p.uf] },
    peso: pc, opcoes
  };
}

const brl = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const kg = (v) => `${String(Math.round(v * 100) / 100).replace('.', ',')} kg`;
const destinoTexto = (p) => (p.tipo === 'C' ? `${CAPITAIS[p.uf]} (${p.uf})` : `${TIPOS[p.tipo][0].toUpperCase()}${TIPOS[p.tipo].slice(1)} de ${UFS[p.uf]}`);

// Cliente escolheu um serviço: registra a cotação no painel e devolve a mensagem do WhatsApp.
function contratar(db, corpo, agora = new Date()) {
  const p = validarPedido(corpo);
  const id = String(corpo.servico || '');
  if (!SERVICO[id]) throw new Error('Escolha um serviço.');
  const c = calcular(db, id, p);
  if (c.indisponivel) throw new Error(`${SERVICO[id].nome}: ${c.indisponivel.toLowerCase()}.`);
  const pc = pesoConsiderado(p);
  const base = c.bases ? c.bases.find((b) => b[0] === c.base) : null;
  const mensagem = [
    'Olá, GoBox! Quero contratar um envio:',
    `• Serviço: ${SERVICO[id].nome} (${SERVICO[id].tag})`,
    `• Destino: ${destinoTexto(p)}${base ? ` · base ${base[1]}` : ''}`,
    `• Peso: ${kg(p.peso)}${pc.cobrado > p.peso ? ` (cobrado ${kg(pc.cobrado)} pelo tamanho)` : ''}${p.altura ? ` · caixa ${p.altura}×${p.largura}×${p.comprimento} cm` : ''}`,
    `• Valor do produto: ${brl(p.valor)}`,
    `• Embalagem: ${p.embalagem ? `${EMBALAGENS[p.embalagem]} (${brl(p.embalagem)})` : 'já levo embalado'}`,
    `• Preço cotado: ${brl(c.preco)}`
  ].join('\n');
  const lista = ler(db, 'fretes:cotacoes', []);
  lista.unshift({
    em: agora.toISOString(), servico: id, destino: destinoTexto(p), uf: p.uf, tipo: p.tipo,
    peso: pc.cobrado, valor: p.valor, embalagem: p.embalagem, preco: c.preco, custo: c.custo, lucro: c.lucro
  });
  gravar(db, 'fretes:cotacoes', lista.slice(0, MAX_COTACOES));
  return { preco: c.preco, servico: SERVICO[id].nome, mensagem };
}

// ---------- painel ----------
function resumo(db) {
  const t = tarifas(db);
  return {
    config: config(db),
    tabela: {
      vigencia: t.vigencia,
      servicos: SERVICOS.map((s) => ({ id: s.id, nome: s.nome, ...(t[`${s.id}Info`] || { vigencia: t.vigencia, importadoEm: null }) })),
      cidadesStandard: t.std.length
    },
    cotacoes: ler(db, 'fretes:cotacoes', []).slice(0, 100).map((c) => ({ ...c, servicoNome: SERVICO[c.servico] ? SERVICO[c.servico].nome : c.servico }))
  };
}
function simular(db, corpo) {
  const p = validarPedido(corpo);
  const t = tarifas(db);
  const cfg = config(db);
  return {
    destino: destinoTexto(p), peso: pesoConsiderado(p),
    servicos: SERVICOS.map((s) => {
      const c = calcular(db, s.id, p, t, cfg);
      delete c.bases;
      return { ...c, nome: s.nome };
    })
  };
}

// ---------- importação da planilha nova da Azul ----------
// Aceita os quatro arquivos que a Azul manda (E-commerce, Expresso, Premium e Standard).
// O serviço é descoberto pelo conteúdo da planilha. Só as rotas saindo de Sergipe (Aracaju) são guardadas.
const ehNum = (v) => typeof v === 'number' && Number.isFinite(v);
const texto = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return v.richText ? v.richText.map((r) => r.text).join('') : (v.result !== undefined ? texto(v.result) : (v.text || ''));
  return String(v);
};
const valorCel = (v) => (v && typeof v === 'object' && v.result !== undefined ? v.result : v);

async function lerPlanilhaAzul(buffer) {
  const ExcelJS = require('exceljs');
  const { Readable } = require('node:stream');
  const leitor = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from(buffer), {
    sharedStrings: 'cache', hyperlinks: 'ignore', styles: 'ignore', worksheets: 'emit'
  });
  let vigencia = null;
  let resultado = null;
  for await (const ws of leitor) {
    let modo = null;
    let pesos = null;
    let col = null;
    const tabela = {};
    const std = [];
    for await (const row of ws) {
      const v = Array.from(row.values || [], valorCel);
      const txts = v.map((x) => norm(texto(x)));
      const linha = txts.join(' ');
      if (!vigencia) { const m = /VIGENCIA:?\s*(.+)/.exec(linha); if (m) vigencia = texto(v.find((x) => /vig/i.test(texto(x)))).replace(/vig[êe]ncia:?\s*/i, '').trim(); }
      if (!modo) {
        if (txts.includes('TRECHO') && txts.some((x) => x.startsWith('MINIMO'))) {
          modo = 'std';
          col = { ori: txts.indexOf('ORIGEM'), dest: txts.lastIndexOf('DESTINO'), cid: txts.lastIndexOf('CIDADE'), uf: txts.lastIndexOf('UF'),
            min: txts.findIndex((x) => x.startsWith('MINIMO')), add: txts.findIndex((x) => x.startsWith('TARIFA ADD')) };
        } else if (txts.includes('CLASSIFICACAO') && txts.includes('DESTINO')) {
          modo = 'uf';
          const ini = txts.indexOf('SERVICO') + 1;
          pesos = []; let j = ini;
          while (ehNum(v[j])) { pesos.push(v[j]); j += 1; }
          col = { dest: txts.indexOf('DESTINO'), cls: txts.indexOf('CLASSIFICACAO'), serv: txts.indexOf('SERVICO'), ini, add: j };
        } else if (txts.some((x) => x.startsWith('DOC'))) {
          modo = 'pre';
          const ini = txts.findIndex((x) => x.startsWith('DOC'));
          let j = ini + 1; while (ehNum(v[j])) j += 1;
          col = { ini, fim: j };
        }
        continue;
      }
      if (modo === 'std') {
        const ori = norm(texto(v[col.ori]));
        if (ori !== 'AJU') continue;
        const cidade = texto(v[col.cid]).replace(/^\S+\s*-\s*/, '').split('/')[0].trim()
          .toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
        const min = Number(v[col.min]); const add = Number(v[col.add]);
        if (ehNum(min) && ehNum(add)) std.push([texto(v[col.dest]).trim(), cidade, norm(texto(v[col.uf])), centavos(min), centavos(add)]);
      } else if (modo === 'uf') {
        const cls = { CAPITAL: 'C', INTERIOR: 'I', REDESPACHO: 'R' }[txts[col.cls]];
        const uf = txts[col.dest];
        if (!cls || !UFS[uf] || txts[col.dest - 1] !== 'SE') continue;
        const vals = pesos.map((_, i) => centavos(Number(v[col.ini + i])));
        if (vals.some((x) => !ehNum(x))) continue;
        tabela[uf] = tabela[uf] || {};
        tabela[uf][cls] = [...vals, centavos(Number(v[col.add]))];
        resultado = resultado || {};
        resultado.servicoTexto = resultado.servicoTexto || txts[col.serv];
      } else if (modo === 'pre') {
        const i = txts.findIndex((x, k) => x === 'SE' && UFS[txts[k + 1]]);
        if (i < 0) continue;
        const uf = txts[i + 1];
        const vals = [];
        for (let j = i + 2; j < v.length; j += 1) if (ehNum(v[j])) vals.push(centavos(v[j]));
        if (vals.length >= 32) tabela[uf] = vals.slice(0, 32);
      }
    }
    if (modo === 'std' && std.length) return { servico: 'std', dados: std, vigencia, linhas: std.length };
    if (modo === 'pre' && Object.keys(tabela).length) {
      return { servico: 'pre', dados: { w: ['DOC', ...Array.from({ length: 30 }, (_, i) => i + 1)], t: tabela }, vigencia, linhas: Object.keys(tabela).length };
    }
    if (modo === 'uf' && Object.keys(tabela).length) {
      const st = resultado && resultado.servicoTexto ? resultado.servicoTexto : '';
      const servico = st.includes('EXPRESS') ? 'exp' : 'eco';
      return { servico, dados: { w: pesos, t: tabela }, vigencia, linhas: Object.values(tabela).reduce((a, x) => a + Object.keys(x).length, 0) };
    }
  }
  throw new Error('Não reconheci a planilha. Envie um dos tarifários da Azul (E-commerce, Expresso, Premium ou Standard).');
}

async function importarTarifa(db, buffer, agora = new Date()) {
  const r = await lerPlanilhaAzul(buffer);
  gravar(db, `fretes:tarifa:${r.servico}`, { dados: r.dados, vigencia: r.vigencia || null, importadoEm: agora.toISOString() });
  return { servico: r.servico, nome: SERVICO[r.servico].nome, vigencia: r.vigencia, linhas: r.linhas };
}

module.exports = {
  SERVICOS, UFS, CAPITAIS, config, salvarConfig, tarifas, validarPedido, pesoConsiderado, calcular,
  cotar, contratar, resumo, simular, lerPlanilhaAzul, importarTarifa, fim90
};
