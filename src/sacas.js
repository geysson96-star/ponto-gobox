'use strict';
// Sacas do Mercado Livre (tela "Entrada de unidades" do Envios).
//
// A extensão do Edge envia os envios do dia: número, situação (a caminho / recebido),
// quantidade de sacas (para entregar e Mercado Envios Extra), horários e zonas.
// Aqui o site:
//  - guarda cada envio pelo número (atualizar a página várias vezes não repete nada);
//  - percebe quando um envio passa a "recebido" e cria UM aviso para o grupo dos entregadores;
//  - separa por tipo: Delivery (para entregar) e Next (Mercado Envios Extra), cada um no seu grupo;
//  - o primeiro envio que chega no dia é a M1; os que chegam depois são M2;
//  - entrega os avisos prontos ao n8n, que manda no WhatsApp e confirma o envio.
//
// Tudo fica na tabela settings (chave "__sacas"), que o site já copia para o Firebase:
// se o servidor do Render reiniciar, ele não esquece o que já avisou.

const crypto = require('node:crypto');
const eventos = require('./eventos');

const CHAVE = '__sacas';
const FUSO = 'America/Bahia';
const DIAS_GUARDADOS = 7;
const AVISOS_GUARDADOS = 60;
const RESERVA_EXPIRA_MIN = 10;   // n8n pegou e não confirmou: marca como falhou

const PADRAO = {
  ativo: false,        // false = modo teste: as mensagens aparecem no painel, nada é enviado
  avisoCaminho: false, // avisar também quando o envio sai ("a caminho")
  zonas: true,         // incluir a distribuição por zonas na mensagem
  janelaMin: 180       // envio que o site vê pela 1ª vez já recebido: avisa só se chegou há menos que isso
};

// ---------- datas no fuso da Bahia ----------
const fmtDia = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' });
const fmtHora = new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, hour: '2-digit', minute: '2-digit', hour12: false });
const diaDe = (d) => fmtDia.format(d ? new Date(d) : new Date());
const horaDe = (iso) => (iso ? fmtHora.format(new Date(iso)) : null);
const valido = (iso) => typeof iso === 'string' && !Number.isNaN(Date.parse(iso));
const min = (ms) => ms * 60_000;

// ---------- armazenamento ----------
function ler(db) {
  const row = db.prepare('SELECT json FROM settings WHERE source = ?').get(CHAVE);
  const d = row ? JSON.parse(row.json) : {};
  return { config: { ...PADRAO, ...(d.config || {}) }, envios: d.envios || {}, avisos: d.avisos || [], ultimaLeitura: d.ultimaLeitura || null };
}
function gravar(db, dados) {
  const corte = diaDe(Date.now() - DIAS_GUARDADOS * 86400_000);
  for (const [k, e] of Object.entries(dados.envios)) if (e.dia < corte) delete dados.envios[k];
  dados.avisos = dados.avisos.slice(-AVISOS_GUARDADOS);
  db.prepare(`INSERT INTO settings (source, json) VALUES (?, ?)
              ON CONFLICT(source) DO UPDATE SET json = excluded.json`).run(CHAVE, JSON.stringify(dados));
  eventos.emit('estado');
}

// ---------- validação do que a extensão manda ----------
const inteiro = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 0 && n < 100_000 ? n : null; };
const texto = (v, max = 40) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const STATUS = new Set(['agendado', 'a_caminho', 'recebido']);

function limpar(e) {
  if (!e || typeof e !== 'object') return null;
  const status = STATUS.has(e.status) ? e.status : null;
  if (!status) return null;
  const numero = e.numero === null || e.numero === undefined ? null : (texto(String(e.numero), 12) || '').replace(/^#/, '') || null;
  const zonas = Array.isArray(e.zonas)
    ? e.zonas.slice(0, 40).map((z) => ({ nome: texto(z && z.nome), paradas: inteiro(z && z.paradas), pacotes: inteiro(z && z.pacotes) }))
      .filter((z) => z.nome && z.pacotes !== null)
    : null;
  return {
    numero,
    status,
    dia: /^\d{4}-\d{2}-\d{2}$/.test(String(e.dia || '')) ? e.dia : null,
    sacas: inteiro(e.sacas),
    entregar: inteiro(e.entregar),
    extra: inteiro(e.extra),
    paradas: inteiro(e.paradas),
    pacotes: inteiro(e.pacotes),
    zonas: zonas && zonas.length ? zonas : null,
    agendadoEm: valido(e.agendadoEm) ? e.agendadoEm : null,
    caminhoEm: valido(e.caminhoEm) ? e.caminhoEm : null,
    recebidoEm: valido(e.recebidoEm) ? e.recebidoEm : null
  };
}

// ---------- mensagem ----------
const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
const zonaNome = (z) => z.replace(/^zona\b/i, 'Zona');

// Cada tipo de saca vai para um grupo do WhatsApp:
//   delivery: "Saca para entregar"           -> grupo Delivery - GoBox
//   nex:      "Mercado Envios Extra" (Next)  -> grupo Gobox_Entregadores
// Cada grupo tem a própria numeração do dia (M1, M2...).
const GRUPOS = {
  delivery: { campo: 'entregar', titulo: 'DELIVERY', emoji: '📦', rotulo: 'Delivery' },
  nex: { campo: 'extra', titulo: 'NEXT', emoji: '⚡', rotulo: 'Next' }
};

function linhaDelivery(e, config) {
  const out = [`🛵 ${plural(e.entregar, 'saca', 'sacas')} para entregar`];
  if (e.pacotes !== null && e.pacotes !== undefined) {
    out.push(`📦 Total: ${plural(e.pacotes, 'pacote', 'pacotes')}${e.paradas !== null && e.paradas !== undefined ? ` · ${plural(e.paradas, 'parada', 'paradas')}` : ''}`);
  }
  if (config.zonas && e.zonas) {
    for (const z of e.zonas) {
      out.push(`• ${zonaNome(z.nome)}: ${plural(z.pacotes, 'pacote', 'pacotes')}${z.paradas !== null ? ` (${plural(z.paradas, 'parada', 'paradas')})` : ''}`);
    }
  }
  return out;
}

// grupo: 'delivery', 'nex' ou null (sem o detalhe por tipo: mensagem geral com o total).
function montarTexto(e, tipo, grupo, config, onda) {
  const g = GRUPOS[grupo];
  const linhas = [];
  if (tipo === 'caminho') {
    linhas.push(`🚚 ${g ? `*${g.titulo} — ` : '*'}SACAS A CAMINHO*`);
    linhas.push(`Envio #${e.numero}`);
    if (e.caminhoEm) linhas.push(`🕗 Saiu às ${horaDe(e.caminhoEm)}`);
  } else {
    linhas.push(`${g ? `${g.emoji} *${g.titulo} — ` : '📦 *'}SACAS CHEGARAM${onda ? ` (${onda})` : ''}*`);
    linhas.push(`Envio #${e.numero}`);
    if (e.recebidoEm) linhas.push(`🕗 Chegou às ${horaDe(e.recebidoEm)}`);
  }
  linhas.push('');
  if (grupo === 'delivery') linhas.push(...linhaDelivery(e, config));
  else if (grupo === 'nex') linhas.push(`⚡ ${plural(e.extra, 'saca', 'sacas')} Next (Mercado Envios Extra)`);
  else if (e.sacas !== null) linhas.push(`*Total: ${plural(e.sacas, 'saca', 'sacas')}*`);
  return linhas.join('\n');
}

// ---------- regras ----------
function chaveEnvio(dia, numero) { return `${dia}#${numero}`; }

// Grupos que este envio atende (vazio = ainda não sabemos as sacas por tipo).
function gruposDo(e) {
  if (e.entregar === null && e.extra === null) return [];
  return Object.keys(GRUPOS).filter((g) => (e[GRUPOS[g].campo] || 0) > 0);
}

// Onda do envio no dia: o primeiro envio que chega é a M1; todos os que chegam depois são M2.
// (A onda é do envio; cada grupo recebe a parte dele com a mesma onda.)
const chegadaDe = (x) => x.recebidoEm || x.caminhoEm || x.vistoPrimeiro || '';
function ondaEnvio(dados, e) {
  if (!e || e.status !== 'recebido') return null;
  if (e.mOnda) return e.mOnda;
  const doDia = Object.values(dados.envios).filter((x) => x.dia === e.dia && x.status === 'recebido');
  if (doDia.some((x) => x.chave !== e.chave && x.mOnda)) return 'M2';
  const primeiro = doDia.sort((a, b) => String(chegadaDe(a)).localeCompare(String(chegadaDe(b))))[0];
  return primeiro && primeiro.chave !== e.chave ? 'M2' : 'M1';
}
function darOndas(dados, e) {
  if (e.status === 'recebido' && !e.mOnda) e.mOnda = ondaEnvio(dados, e);
}

function criarAviso(dados, e, tipo, grupo, agora, generico = false) {
  if (dados.avisos.some((a) => a.envio === e.chave && a.tipo === tipo && !a.generico && (a.grupo || 'delivery') === grupo)) return null;
  const aviso = {
    id: crypto.randomBytes(6).toString('hex'),
    envio: e.chave,
    tipo,
    grupo,
    generico,
    situacao: dados.config.ativo ? 'pendente' : 'teste',
    criadoEm: new Date(agora).toISOString(),
    enviadoEm: null,
    erro: null
  };
  dados.avisos.push(aviso);
  return aviso;
}

// Cria os avisos de chegada (um por grupo). Sem as sacas por tipo (Delivery / Next),
// não manda nada: espera a extensão trazer o detalhe, para não avisar o grupo errado.
function avisarChegada(dados, e, agora) {
  let n = 0;
  const grupos = gruposDo(e);
  if (grupos.length) {
    darOndas(dados, e);
    for (const g of grupos) if (criarAviso(dados, e, 'chegada', g, agora)) n += 1;
    delete e.aguardaDetalhe;
  } else if (!e.aguardaDetalhe) {
    e.aguardaDetalhe = new Date(agora).toISOString();
  }
  return n;
}

// "A caminho": só com as sacas por tipo; sem elas, fica pendente até o detalhe chegar.
function avisarCaminho(dados, e, agora) {
  let n = 0;
  const grupos = gruposDo(e);
  if (!grupos.length) { e.aguardaCaminho = true; return 0; }
  for (const g of grupos) if (criarAviso(dados, e, 'caminho', g, agora)) n += 1;
  delete e.aguardaCaminho;
  return n;
}

// Registra os envios lidos agora. Devolve um resumo do que mudou.
function registrar(db, lista, { agora = Date.now() } = {}) {
  const dados = ler(db);
  const hoje = diaDe(agora);
  const resumo = { envios: 0, novosAvisos: 0 };
  const limpos = (Array.isArray(lista) ? lista : []).slice(0, 60).map(limpar).filter(Boolean)
    // Quem saiu primeiro é contado primeiro (M1, M2...) quando vários chegam na mesma leitura.
    .sort((a, b) => String(a.caminhoEm || '9').localeCompare(String(b.caminhoEm || '9')));

  // Envios recebidos que a lista mostra sem número: liga ao envio "a caminho" de hoje
  // com a mesma quantidade de sacas que ainda não chegou.
  for (const e of limpos) {
    e.dia = e.dia || diaDe(e.recebidoEm || e.caminhoEm || agora);
    if (e.numero) continue;
    if (e.status !== 'recebido' || e.dia !== hoje) continue;
    const par = Object.values(dados.envios).find((x) => x.dia === hoje && x.status !== 'recebido' && x.numero
      && x.sacas === e.sacas && !limpos.some((y) => y.numero === x.numero));
    if (par) e.numero = par.numero;
  }

  for (const e of limpos) {
    if (!e.numero) continue; // sem número e sem par: não dá para acompanhar
    const k = chaveEnvio(e.dia, e.numero);
    const antes = dados.envios[k];
    const atual = { ...(antes || {}), chave: k, numero: e.numero, dia: e.dia, vistoUltimo: new Date(agora).toISOString() };
    if (!antes) atual.vistoPrimeiro = atual.vistoUltimo;
    // Campos novos só substituem quando vieram preenchidos (o detalhe chega em outra leitura).
    for (const c of ['sacas', 'entregar', 'extra', 'paradas', 'pacotes', 'zonas', 'agendadoEm', 'caminhoEm', 'recebidoEm']) {
      if (e[c] !== null && e[c] !== undefined) atual[c] = e[c];
      else if (atual[c] === undefined) atual[c] = null;
    }
    if (atual.sacas === null && (atual.entregar !== null || atual.extra !== null)) atual.sacas = (atual.entregar || 0) + (atual.extra || 0);
    // A situação só avança (agendado → a caminho → recebido).
    const ordem = { agendado: 0, a_caminho: 1, recebido: 2 };
    atual.status = !antes || ordem[e.status] >= ordem[antes.status] ? e.status : antes.status;
    dados.envios[k] = atual;

    const chegouAgora = atual.status === 'recebido' && (!antes || antes.status !== 'recebido');
    if (chegouAgora) {
      if (!atual.recebidoEm && antes) atual.recebidoEm = new Date(agora).toISOString(); // visto mudar agora
      // Já estava recebido quando o site viu pela 1ª vez: só avisa se chegou há pouco.
      const recente = antes || (atual.recebidoEm && agora - Date.parse(atual.recebidoEm) <= min(dados.config.janelaMin));
      if (atual.dia === hoje && recente) resumo.novosAvisos += avisarChegada(dados, atual, agora);
      else darOndas(dados, atual); // conta na numeração do dia, sem avisar
    } else if (atual.status === 'recebido' && atual.dia === hoje
      && (atual.aguardaDetalhe || dados.avisos.some((a) => a.envio === k && a.tipo === 'chegada' && a.generico))) {
      // O detalhe chegou depois (ou só saiu a mensagem geral): completa os avisos de cada grupo.
      resumo.novosAvisos += avisarChegada(dados, atual, agora);
    }
    const saiuAgora = dados.config.avisoCaminho && atual.status === 'a_caminho'
      && (!antes || antes.status === 'agendado' || atual.aguardaCaminho);
    if (saiuAgora && atual.dia === hoje) resumo.novosAvisos += avisarCaminho(dados, atual, agora);
    if (atual.status !== 'a_caminho') delete atual.aguardaCaminho;
    resumo.envios += 1;
  }
  dados.ultimaLeitura = new Date(agora).toISOString();
  gravar(db, dados);
  return resumo;
}

const ESPERA_PACOTES_MIN = 5; // chegada do Delivery espera o total de pacotes (zonas) por até 5 min
function pronto(dados, a, agora) {
  const e = dados.envios[a.envio];
  if (a.situacao !== 'pendente' || !e) return false;
  if (a.tipo === 'chegada' && a.grupo === 'delivery' && !a.generico && !a.manual
    && (e.pacotes === null || e.pacotes === undefined)
    && agora - Date.parse(a.criadoEm) < min(ESPERA_PACOTES_MIN)) return false;
  return true;
}

function expirarReservas(dados, agora) {
  let mudou = false;
  for (const a of dados.avisos) {
    if (a.situacao === 'enviando' && agora - Date.parse(a.reservadoEm) >= min(RESERVA_EXPIRA_MIN)) {
      a.situacao = 'falhou';
      a.erro = 'O n8n pegou o aviso e não confirmou o envio.';
      mudou = true;
    }
  }
  return mudou;
}

function comTexto(dados, a) {
  const e = dados.envios[a.envio];
  const grupo = a.grupo || 'delivery';
  const onda = ondaEnvio(dados, e);
  return {
    ...a,
    grupo,
    grupoRotulo: GRUPOS[grupo].rotulo,
    numero: e ? e.numero : null,
    onda,
    texto: e ? montarTexto(e, a.tipo, a.generico || !a.grupo ? null : grupo, dados.config, onda) : ''
  };
}

// n8n: pega o próximo aviso pronto (e o reserva para não sair duas vezes).
function reservarProximo(db, { agora = Date.now() } = {}) {
  const dados = ler(db);
  let mudou = expirarReservas(dados, agora);
  const a = dados.config.ativo ? dados.avisos.find((x) => pronto(dados, x, agora)) : null;
  if (a) { a.situacao = 'enviando'; a.reservadoEm = new Date(agora).toISOString(); mudou = true; }
  if (mudou) gravar(db, dados);
  return a ? comTexto(dados, a) : null;
}

// n8n: confirma o resultado do envio.
function confirmar(db, id, { ok, erro } = {}, { agora = Date.now() } = {}) {
  const dados = ler(db);
  const a = dados.avisos.find((x) => x.id === id);
  if (!a) return null;
  if (a.situacao !== 'enviando') return comTexto(dados, a);
  a.situacao = ok ? 'enviado' : 'falhou';
  a.enviadoEm = ok ? new Date(agora).toISOString() : null;
  a.erro = ok ? null : (texto(String(erro || ''), 200) || 'Falha no envio.');
  gravar(db, dados);
  return comTexto(dados, a);
}

// Painel: mandar agora a mensagem de chegada de um envio para um grupo (cria um aviso novo).
function novoAvisoManual(dados, e, grupo, agora) {
  darOndas(dados, e);
  const aviso = {
    id: crypto.randomBytes(6).toString('hex'), envio: e.chave, tipo: e.status === 'recebido' ? 'chegada' : 'caminho',
    grupo, generico: false, manual: true, situacao: 'pendente',
    criadoEm: new Date(agora).toISOString(), enviadoEm: null, erro: null
  };
  dados.avisos.push(aviso);
  return aviso;
}

function enviarAgora(db, chave, grupo, { agora = Date.now() } = {}) {
  const dados = ler(db);
  if (!dados.config.ativo) throw new Error('Ligue "Enviar para o grupo" antes.');
  const e = dados.envios[chave];
  if (!e) throw new Error('Envio não encontrado.');
  if (!gruposDo(e).includes(grupo)) throw new Error('Este envio não tem sacas desse tipo.');
  const a = novoAvisoManual(dados, e, grupo, agora);
  gravar(db, dados);
  return comTexto(dados, a);
}

// Painel: manda de novo a mensagem de chegada de cada envio recebido hoje, em cada grupo.
function reenviarHoje(db, { agora = Date.now() } = {}) {
  const dados = ler(db);
  if (!dados.config.ativo) throw new Error('Ligue "Enviar para o grupo" antes.');
  const hoje = diaDe(agora);
  const naFila = (e, g) => dados.avisos.some((a) => a.envio === e.chave && (a.grupo || 'delivery') === g
    && !a.generico && (a.situacao === 'pendente' || a.situacao === 'enviando'));
  let n = 0;
  const envios = Object.values(dados.envios).filter((e) => e.dia === hoje && e.status === 'recebido')
    .sort((a, b) => String(a.caminhoEm || '9').localeCompare(String(b.caminhoEm || '9')));
  for (const e of envios) {
    for (const g of gruposDo(e)) {
      if (naFila(e, g)) continue;
      novoAvisoManual(dados, e, g, agora);
      n += 1;
    }
  }
  gravar(db, dados);
  return { novos: n };
}

// Painel: reenviar um aviso (volta para a fila do n8n).
function reenviar(db, id) {
  const dados = ler(db);
  const a = dados.avisos.find((x) => x.id === id);
  if (!a) return null;
  if (!dados.config.ativo) throw new Error('Ligue o envio para o grupo antes de reenviar.');
  if (a.generico) throw new Error('Este é um aviso antigo (mensagem geral, sem separar Delivery e Next). Use "Enviar agora" no envio.');
  a.situacao = 'pendente'; a.erro = null; a.enviadoEm = null; delete a.reservadoEm;
  gravar(db, dados);
  return comTexto(dados, a);
}

function salvarConfig(db, patch = {}) {
  const dados = ler(db);
  for (const k of ['ativo', 'avisoCaminho', 'zonas']) if (typeof patch[k] === 'boolean') dados.config[k] = patch[k];
  const j = Number(patch.janelaMin);
  if (Number.isInteger(j) && j >= 10 && j <= 720) dados.config.janelaMin = j;
  gravar(db, dados);
  return dados.config;
}

// Painel: envios de hoje (e dos últimos dias) com as mensagens prontas.
function resumo(db, { agora = Date.now() } = {}) {
  const dados = ler(db);
  const hoje = diaDe(agora);
  const envios = Object.values(dados.envios)
    .sort((a, b) => (b.dia.localeCompare(a.dia)) || String(a.caminhoEm || a.vistoPrimeiro).localeCompare(String(b.caminhoEm || b.vistoPrimeiro)))
    .map((e) => {
      const tipo = e.status === 'recebido' ? 'chegada' : 'caminho';
      const grupos = gruposDo(e);
      const previas = grupos.length
        ? grupos.map((g) => ({ grupo: g, grupoRotulo: GRUPOS[g].rotulo, texto: montarTexto(e, tipo, g, dados.config, ondaEnvio(dados, e)) }))
        : [{ grupo: null, grupoRotulo: 'nenhum ainda', texto: 'Aguardando a extensão informar quantas sacas são Delivery e quantas são Next. Nada é enviado até lá.' }];
      const onda = ondaEnvio(dados, e);
      return { ...e, onda, ondas: Object.fromEntries(grupos.map((g) => [g, onda]).filter(([, o]) => o)), hoje: e.dia === hoje, previas };
    });
  return {
    config: dados.config,
    hoje,
    ultimaLeitura: dados.ultimaLeitura,
    envios,
    avisos: dados.avisos.slice().reverse().map((a) => comTexto(dados, a))
  };
}

module.exports = { GRUPOS, registrar, reservarProximo, confirmar, reenviar, enviarAgora, reenviarHoje, salvarConfig, resumo, montarTexto, _limpar: limpar, PADRAO };
