'use strict';
const eventos = require('./eventos');
// Painel financeiro: quanto a GoBox ganhou no mês com cada empresa.
//
// Shopee: conta o total EXPEDIDO no mês (drop-offs coletados pela Shopee) e as
// retiradas feitas no mês, pela data de saída. Mercado Livre e Correios: pelo mês
// em que o pacote chegou na agência (recebido_em; ou a primeira vez que o site o viu). Itens que os portais não
// mostram (devoluções da Shopee, falhas e rotas NEx do Mercado Livre) entram como
// ajuste manual no painel. Os ajustes também corrigem as contagens automáticas.

const FUSO_MS = -3 * 3600 * 1000; // America/Bahia (UTC-03:00, sem horário de verão)

// Shopee: valor por pacote cai por faixa de quantidade no mês (planilha "COMISSÃO SHOPEE").
const FAIXAS_SHOPEE = [[500, 0.70], [500, 0.60], [4000, 0.50], [5000, 0.40], [5000, 0.30], [Infinity, 0.20]];
const DEVOLUCAO_SHOPEE = 0.80;
const MEDALHAS_PADRAO = {
  bronze: { nome: 'Bronze', percentual: 0, fixo: 0 },
  prata: { nome: 'Prata', percentual: 1, fixo: 150 },
  ouro: { nome: 'Ouro', percentual: 2, fixo: 250 },
  platina: { nome: 'Platina', percentual: 4, fixo: 350 }
};
// Mercado Livre (tela "Confira seu acumulado atual"), fecha por quinzena.
const VALORES_ML = { delivery: 2.60, pickup: 0.65, falhas: 0.65, nex: 10.00 };
const VALOR_CORREIOS = 1.20;

const ITENS = {
  shopee: ['expedidos', 'retiradas', 'devolucoes'],
  ml: ['delivery', 'pickup', 'falhas', 'nex'],
  correios: ['pacotes']
};

const centavos = (v) => Math.round(v * 100) / 100;

function porFaixas(n) {
  let resto = Math.max(0, Math.floor(n));
  let total = 0;
  for (const [qtd, valor] of FAIXAS_SHOPEE) {
    const u = Math.min(resto, qtd);
    total += u * valor;
    resto -= u;
    if (resto <= 0) break;
  }
  return total;
}
// Valor do n-ésimo pacote (1 = primeiro do mês) na tabela de faixas.
function valorDoPacote(n) {
  let limite = 0;
  for (const [qtd, valor] of FAIXAS_SHOPEE) { limite += qtd; if (n <= limite) return valor; }
  return FAIXAS_SHOPEE[FAIXAS_SHOPEE.length - 1][1];
}

function calcularShopee(q, medalha) {
  const exp = porFaixas(q.expedidos - q.devolucoes);
  const ret = porFaixas(q.retiradas);
  const dev = q.devolucoes * DEVOLUCAO_SHOPEE;
  const base = exp + ret + dev;
  const total = base * (1 + medalha.percentual / 100) + (base > 0 ? medalha.fixo : 0);
  return {
    itens: { expedidos: centavos(exp), retiradas: centavos(ret), devolucoes: centavos(dev) },
    base: centavos(base), bonusMedalha: centavos(total - base), total: centavos(total)
  };
}
function calcularMlQuinzena(q) {
  const itens = {};
  let total = 0;
  for (const k of ITENS.ml) { itens[k] = centavos(q[k] * VALORES_ML[k]); total += q[k] * VALORES_ML[k]; }
  return { itens, total: centavos(total) };
}

// ---------- datas no fuso da agência ----------
function mesAtual(agora = Date.now()) {
  const d = new Date(agora + FUSO_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function limitesDoMes(mes) {
  const [a, m] = mes.split('-').map(Number);
  const ini = Date.UTC(a, m - 1, 1) - FUSO_MS;
  const meio = Date.UTC(a, m - 1, 16) - FUSO_MS;
  const fim = Date.UTC(a, m, 1) - FUSO_MS;
  const iso = (t) => new Date(t).toISOString();
  const ultimoDia = new Date(Date.UTC(a, m, 0)).getUTCDate();
  return { ini: iso(ini), meio: iso(meio), fim: iso(fim), ultimoDia };
}

// ---------- configuração e ajustes (guardados no banco) ----------
function garantirTabela(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS financeiro (chave TEXT PRIMARY KEY, json TEXT NOT NULL)`);
}
function ler(db, chave, padrao) {
  garantirTabela(db);
  const r = db.prepare('SELECT json FROM financeiro WHERE chave = ?').get(chave);
  if (!r) return padrao;
  try { return JSON.parse(r.json); } catch { return padrao; }
}
function gravar(db, chave, valor) {
  garantirTabela(db);
  db.prepare(`INSERT INTO financeiro (chave, json) VALUES (?, ?)
              ON CONFLICT(chave) DO UPDATE SET json = excluded.json`).run(chave, JSON.stringify(valor));
  eventos.emit('estado');
}
function configuracao(db) {
  const c = ler(db, 'config', {});
  const medalhas = {};
  for (const [id, p] of Object.entries(MEDALHAS_PADRAO)) medalhas[id] = { ...p, ...((c.medalhas || {})[id] || {}) };
  const medalhaPorMes = c.medalhaPorMes || {};
  const incluirEstimadoMl = c.incluirEstimadoMl !== false; // ligado por padrão
  const incluirEstimadoShopee = c.incluirEstimadoShopee !== false;
  return { medalhas, medalhaPorMes, incluirEstimadoMl, incluirEstimadoShopee };
}
// Liga ou desliga o recebimento estimado (Mercado Livre ou Shopee) na conta.
function salvarEstimado(db, fonte, ligado) {
  const c = ler(db, 'config', {});
  if (fonte === 'ml') c.incluirEstimadoMl = Boolean(ligado);
  else if (fonte === 'shopee') c.incluirEstimadoShopee = Boolean(ligado);
  else throw new Error('Empresa inválida.');
  gravar(db, 'config', c);
  return Boolean(ligado);
}
const salvarEstimadoMl = (db, ligado) => salvarEstimado(db, 'ml', ligado);
function ajustesVazios() {
  return { shopee: { expedidos: 0, retiradas: 0, devolucoes: 0 },
    ml: { q1: { delivery: 0, pickup: 0, falhas: 0, nex: 0 }, q2: { delivery: 0, pickup: 0, falhas: 0, nex: 0 } },
    correios: { pacotes: 0 } };
}
function ajustesDoMes(db, mes) {
  const a = ler(db, `ajustes:${mes}`, null);
  const v = ajustesVazios();
  if (!a) return v;
  for (const k of ITENS.shopee) v.shopee[k] = Number(a.shopee?.[k]) || 0;
  for (const q of ['q1', 'q2']) for (const k of ITENS.ml) v.ml[q][k] = Number(a.ml?.[q]?.[k]) || 0;
  v.correios.pacotes = Number(a.correios?.pacotes) || 0;
  return v;
}

const inteiro = (v, min, max) => {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.min(max, Math.max(min, n));
};
function salvarAjustes(db, mes, entrada) {
  const v = ajustesVazios();
  for (const k of ITENS.shopee) v.shopee[k] = inteiro(entrada?.shopee?.[k], -100000, 100000);
  for (const q of ['q1', 'q2']) for (const k of ITENS.ml) v.ml[q][k] = inteiro(entrada?.ml?.[q]?.[k], -100000, 100000);
  v.correios.pacotes = inteiro(entrada?.correios?.pacotes, -100000, 100000);
  gravar(db, `ajustes:${mes}`, v);
  return v;
}
function salvarMedalha(db, mes, entrada) {
  const c = configuracao(db);
  if (entrada.medalha !== undefined) {
    if (!MEDALHAS_PADRAO[entrada.medalha]) throw new Error('Medalha inválida.');
    c.medalhaPorMes[mes] = entrada.medalha;
  }
  if (entrada.valores && typeof entrada.valores === 'object') {
    for (const [id, p] of Object.entries(entrada.valores)) {
      if (!MEDALHAS_PADRAO[id]) continue;
      const pct = Number(p.percentual); const fixo = Number(p.fixo);
      if (Number.isFinite(pct) && pct >= 0 && pct <= 100) c.medalhas[id].percentual = Math.round(pct * 100) / 100;
      if (Number.isFinite(fixo) && fixo >= 0 && fixo <= 100000) c.medalhas[id].fixo = Math.round(fixo * 100) / 100;
    }
  }
  gravar(db, 'config', c);
  return c;
}

// ---------- contagem automática ----------
// Um pacote pode estar guardado com dois códigos (ex.: Shopee guarda o ID do envio
// e o código de rastreio); external_id junta os dois para não contar em dobro.
function contar(db, mes) {
  const { ini, meio, fim } = limitesDoMes(mes);
  const chegada = 'COALESCE(recebido_em, first_seen_at)';
  const rows = db.prepare(
    `SELECT source, tipo, situacao, volume, ${chegada} AS chegada, saida_em, COALESCE(external_id, code) AS chave, code
     FROM packages
     WHERE (${chegada} >= ? AND ${chegada} < ?) OR (saida_em >= ? AND saida_em < ?)`
  ).all(ini, fim, ini, fim);
  const vistos = new Set();
  const lista = [];
  for (const r of rows) {
    // Shopee: conta o que SAIU no mês (total expedido e retiradas feitas), pela data de saída.
    // Mercado Livre e Correios: contam pela data de chegada na agência.
    let em;
    if (r.source === 'shopee') {
      const saiu = r.tipo === 'retirada' ? r.situacao === 'retirado' : (r.situacao === 'enviado' || r.situacao === 'saiu');
      if (!saiu || !r.saida_em) continue;
      em = r.saida_em;
    } else {
      em = r.chegada;
    }
    if (!(em >= ini && em < fim)) continue;
    const k = `${r.source}|${r.chave}`;
    if (vistos.has(k)) continue;
    vistos.add(k);
    lista.push({ ...r, em });
  }
  lista.sort((a, b) => (a.em < b.em ? -1 : a.em > b.em ? 1 : 0));

  const auto = ajustesVazios();
  for (const r of lista) {
    if (r.source === 'shopee') {
      if (r.tipo === 'retirada') auto.shopee.retiradas += 1; else auto.shopee.expedidos += 1;
    } else if (r.source === 'ml') {
      const q = r.em < meio ? 'q1' : 'q2';
      if (r.volume && r.volume !== 'shipment') continue; // saca: os pacotes dela contam
      if (r.tipo === 'retirada') auto.ml[q].pickup += 1;
      else if (r.tipo !== 'nex') auto.ml[q].delivery += 1; // NEx é pago por rota
    } else if (r.source === 'correios') {
      auto.correios.pacotes += 1;
    }
  }
  return { auto, lista };
}

// Últimos pacotes do mês com o valor que cada um somou (antes da medalha).
function ultimos(lista, limite = 12) {
  const n = { exp: 0, ret: 0 };
  const saida = [];
  for (const r of lista) {
    let item; let valor;
    if (r.source === 'shopee') {
      if (r.tipo === 'retirada') { n.ret += 1; item = 'Retirada'; valor = valorDoPacote(n.ret); }
      else { n.exp += 1; item = 'Expedido'; valor = valorDoPacote(n.exp); }
    } else if (r.source === 'ml') {
      if (r.volume && r.volume !== 'shipment') { item = 'Saca'; valor = 0; }
      else if (r.tipo === 'nex') { item = 'NEx (pago por rota)'; valor = 0; }
      else if (r.tipo === 'retirada') { item = 'Pick Up'; valor = VALORES_ML.pickup; }
      else { item = 'Delivery'; valor = VALORES_ML.delivery; }
    } else if (r.source === 'correios') { item = 'Pacote'; valor = VALOR_CORREIOS; } else continue;
    saida.push({ fonte: r.source, item, codigo: r.code, em: r.em, valor });
  }
  return saida.slice(-limite).reverse();
}

function somar(a, b) {
  const v = ajustesVazios();
  for (const k of ITENS.shopee) v.shopee[k] = Math.max(0, a.shopee[k] + b.shopee[k]);
  for (const q of ['q1', 'q2']) for (const k of ITENS.ml) v.ml[q][k] = Math.max(0, a.ml[q][k] + b.ml[q][k]);
  v.correios.pacotes = Math.max(0, a.correios.pacotes + b.correios.pacotes);
  return v;
}

// ---------- Shopee: totais do mês lidos do portal ----------
function salvarTotaisShopee(db, d) {
  const mes = d && typeof d.mes === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(d.mes) ? d.mes : null;
  const n = (v) => { const x = Math.trunc(Number(v)); return Number.isFinite(x) && x >= 0 && x <= 1e7 ? x : null; };
  const expedidos = n(d && d.expedidos);
  const retiradas = n(d && d.retiradas);
  if (!mes || expedidos === null || retiradas === null) throw new Error('Totais da Shopee em formato inesperado.');
  const reg = { mes, expedidos, retiradas, recebidos: n(d.recebidos), retiradasRecebidas: n(d.retiradasRecebidas), lidoEm: new Date().toISOString() };
  gravar(db, `shopee_portal:${mes}`, reg);
  return reg;
}

// ---------- Mercado Livre: acumulado oficial + estimado do dia ----------
// A extensão lê a tela "Recebimento estimado" do Places (valores já calculados pelo
// Mercado Livre). O que chegou depois da última atualização oficial é estimado aqui,
// pelos pacotes e sacas que entram no estoque da agência.
const TIPOS_OFICIAIS_ML = { dc: 'delivery', pickup: 'pickup', rtn: 'falhas', nex_car: 'nex' };

function salvarOficialMl(db, d) {
  const data = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
  const de = data(d && d.de);
  const ate = data(d && d.ate);
  if (!de || !ate || !Array.isArray(d.itens)) throw new Error('Acumulado do Mercado Livre em formato inesperado.');
  const itens = {};
  let total = 0;
  for (const i of d.itens.slice(0, 20)) {
    const k = TIPOS_OFICIAIS_ML[String(i.tipo)];
    const qtd = Math.max(0, Math.trunc(Number(i.quantidade) || 0));
    const valor = Math.max(0, Number(i.total) || 0);
    if (String(i.tipo) === 'total') { total = valor; continue; }
    if (k) itens[k] = { quantidade: qtd, total: centavos(valor) };
  }
  const reg = { de, ate, atualizadoEm: data(d.atualizadoEm) || de, itens, total: centavos(total), lidoEm: new Date().toISOString() };
  gravar(db, `ml_oficial:${de}`, reg);
  return reg;
}

// Pacotes e sacas do Mercado Livre que chegaram entre dois instantes.
function chegadasMl(db, desde, ate) {
  const rows = db.prepare(
    `SELECT tipo, volume, COALESCE(external_id, code) AS chave
     FROM packages WHERE source = 'ml' AND COALESCE(recebido_em, first_seen_at) >= ? AND COALESCE(recebido_em, first_seen_at) < ?`
  ).all(desde, ate);
  const vistos = new Set();
  const c = { delivery: 0, pickup: 0, nex: 0, sacas: 0 };
  for (const r of rows) {
    if (vistos.has(r.chave)) continue;
    vistos.add(r.chave);
    if (r.volume && r.volume !== 'shipment') { c.sacas += 1; continue; }
    if (r.tipo === 'retirada') c.pickup += 1;
    else if (r.tipo === 'nex') c.nex += 1;
    else c.delivery += 1;
  }
  return c;
}

function quinzenaMl(db, mes, qk, contagem, ajuste, incluirEstimado = true) {
  const { ini, meio, fim } = limitesDoMes(mes);
  const qIni = qk === 'q1' ? ini : meio;
  const qFim = qk === 'q1' ? meio : fim;
  const chave = `${mes}-${qk === 'q1' ? '01' : '16'}`;
  const oficial = ler(db, `ml_oficial:${chave}`, null);
  const somaAjuste = (q) => { const r = {}; for (const k of ITENS.ml) r[k] = Math.max(0, q[k] + ajuste[k]); return r; };

  if (!oficial) {
    const qtd = somaAjuste(contagem);
    return { ...calcularMlQuinzena(qtd), quantidades: qtd, fonte: 'contagem', oficial: null, estimadoDia: null };
  }
  // O oficial vale até o início do dia da última atualização; dali em diante, estimado.
  const [a, m, d] = oficial.atualizadoEm.split('-').map(Number);
  const corte = new Date(Math.min(Math.max(Date.UTC(a, m - 1, d) - FUSO_MS, Date.parse(qIni)), Date.parse(qFim))).toISOString();
  const chegou = chegadasMl(db, corte, qFim);
  const estimado = {
    desde: corte, delivery: chegou.delivery, pickup: chegou.pickup, sacas: chegou.sacas,
    valor: centavos(chegou.delivery * VALORES_ML.delivery + chegou.pickup * VALORES_ML.pickup),
    incluido: incluirEstimado
  };
  const qtd = {};
  const itens = {};
  let total = 0;
  for (const k of ITENS.ml) {
    const of = oficial.itens[k] || { quantidade: 0, total: 0 };
    const est = !incluirEstimado ? 0 : k === 'delivery' ? chegou.delivery : k === 'pickup' ? chegou.pickup : 0;
    qtd[k] = Math.max(0, of.quantidade + est + ajuste[k]);
    const v = of.total + (est + ajuste[k]) * VALORES_ML[k];
    itens[k] = centavos(Math.max(0, v));
    total += Math.max(0, v);
  }
  return {
    itens, total: centavos(total), quantidades: qtd, fonte: 'oficial',
    oficial: { atualizadoEm: oficial.atualizadoEm, lidoEm: oficial.lidoEm, total: oficial.total }, estimadoDia: estimado
  };
}

function resumo(db, mes = mesAtual()) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) throw new Error('Mês inválido.');
  const cfg = configuracao(db);
  const medalhaId = cfg.medalhaPorMes[mes] || 'bronze';
  const { auto, lista } = contar(db, mes);
  // Shopee: quando a extensão mandou os totais do portal, eles valem (mais exatos).
  const portalShopee = ler(db, `shopee_portal:${mes}`, null);
  if (portalShopee) {
    auto.shopee.expedidos = portalShopee.expedidos;
    auto.shopee.retiradas = portalShopee.retiradas;
  }
  const ajustes = ajustesDoMes(db, mes);
  const q = somar(auto, ajustes);

  const shopeePago = calcularShopee(q.shopee, cfg.medalhas[medalhaId]);
  // Recebimento estimado da Shopee: o total RECEBIDO no mês, como se tudo já tivesse saído.
  let estimadoShopee = null;
  if (portalShopee && portalShopee.recebidos !== null && portalShopee.recebidos !== undefined) {
    const qEst = {
      expedidos: Math.max(q.shopee.expedidos, portalShopee.recebidos + ajustes.shopee.expedidos),
      retiradas: Math.max(q.shopee.retiradas, (portalShopee.retiradasRecebidas ?? 0) + ajustes.shopee.retiradas),
      devolucoes: q.shopee.devolucoes
    };
    const calc = calcularShopee(qEst, cfg.medalhas[medalhaId]);
    estimadoShopee = {
      recebidos: portalShopee.recebidos, retiradasRecebidas: portalShopee.retiradasRecebidas ?? 0,
      aguardandoColeta: qEst.expedidos - q.shopee.expedidos, aguardandoRetirada: qEst.retiradas - q.shopee.retiradas,
      valor: centavos(Math.max(0, calc.total - shopeePago.total)), totalComEstimado: calc.total,
      incluido: cfg.incluirEstimadoShopee
    };
  }
  const shopee = { ...shopeePago, pago: shopeePago.total, estimado: estimadoShopee,
    total: estimadoShopee && estimadoShopee.incluido ? centavos(shopeePago.total + estimadoShopee.valor) : shopeePago.total };
  const q1 = quinzenaMl(db, mes, 'q1', auto.ml.q1, ajustes.ml.q1, cfg.incluirEstimadoMl);
  const q2 = quinzenaMl(db, mes, 'q2', auto.ml.q2, ajustes.ml.q2, cfg.incluirEstimadoMl);
  const ml = { q1, q2, total: centavos(q1.total + q2.total) };
  q.ml.q1 = q1.quantidades;
  q.ml.q2 = q2.quantidades;
  const correios = { total: centavos(q.correios.pacotes * VALOR_CORREIOS) };
  const pacotes = q.shopee.expedidos + q.shopee.retiradas + q.shopee.devolucoes
    + ['q1', 'q2'].reduce((s, k) => s + q.ml[k].delivery + q.ml[k].pickup + q.ml[k].falhas, 0)
    + q.correios.pacotes;
  const { ultimoDia } = limitesDoMes(mes);
  return {
    mes, ultimoDia, mesAtual: mesAtual(), quinzenaAtual: new Date(Date.now() + FUSO_MS).getUTCDate() <= 15 ? 'q1' : 'q2',
    total: centavos(shopee.total + ml.total + correios.total), pacotes,
    quantidades: q, automatico: auto, ajustes,
    shopee: { ...shopee, medalha: medalhaId, portal: portalShopee ? { lidoEm: portalShopee.lidoEm } : null },
    ml, correios,
    medalhas: cfg.medalhas,
    valores: { faixasShopee: FAIXAS_SHOPEE.map(([qtd, v]) => [qtd === Infinity ? null : qtd, v]), devolucaoShopee: DEVOLUCAO_SHOPEE, ml: VALORES_ML, correios: VALOR_CORREIOS },
    ultimos: ultimos(lista),
    agora: new Date().toISOString()
  };
}

module.exports = {
  resumo, salvarAjustes, salvarMedalha, salvarEstimado, salvarEstimadoMl, salvarOficialMl, salvarTotaisShopee, mesAtual, limitesDoMes,
  calcularShopee, calcularMlQuinzena, porFaixas, valorDoPacote, MEDALHAS_PADRAO
};
