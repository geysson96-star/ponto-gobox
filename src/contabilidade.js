'use strict';
// Aba Contabilidade do painel.
//
// 1) Contracheques quinzenais. Funcionários e horas vêm do Ponto GoBox (o navegador
//    calcula as horas extras com as mesmas regras do ponto). Aqui ficam só o salário
//    de cada funcionário e o que for alterado em cada quinzena (base, horas,
//    proventos e descontos), além da data em que foi pago.
// 2) Notas fiscais por empresa (Correios e Shopee mensais, Mercado Livre quinzenal),
//    com o dia de pagamento previsto pelo histórico de cada empresa.
//
// Tudo fica na tabela "financeiro" com chaves "contab:*", que já é salva no Firebase
// pela persistência. Para tirar a aba, basta apagar este arquivo e as rotas: as
// chaves que sobrarem não afetam nada.

const crypto = require('node:crypto');
const eventos = require('./eventos');
const financeiro = require('./financeiro');

const FUSO_MS = -3 * 3600 * 1000; // America/Bahia
const EMPRESAS = [
  { id: 'correios', nome: 'Correios', ciclo: 'mensal' },
  { id: 'ml', nome: 'Mercado Livre', ciclo: 'quinzenal' },
  { id: 'shopee', nome: 'Shopee', ciclo: 'mensal' }
];
const EMPRESA = Object.fromEntries(EMPRESAS.map((e) => [e.id, e]));
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

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

// ---------- datas (texto AAAA-MM-DD, sem fuso) ----------
const RE_DIA = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const pad = (n) => String(n).padStart(2, '0');
const paraData = (s) => { const [a, m, d] = s.split('-').map(Number); return new Date(Date.UTC(a, m - 1, d)); };
const deData = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const somarDias = (s, n) => { const d = paraData(s); d.setUTCDate(d.getUTCDate() + n); return deData(d); };
const diasEntre = (a, b) => Math.round((paraData(b) - paraData(a)) / 864e5);
const util = (s) => { const w = paraData(s).getUTCDay(); return w !== 0 && w !== 6; };
const proximoUtil = (s) => { let d = s; while (!util(d)) d = somarDias(d, 1); return d; };
function uteisEntre(a, b) { let n = 0; for (let d = a; d < b;) { d = somarDias(d, 1); if (util(d)) n += 1; } return n; }
function somarUteis(s, n) { let d = s; let k = 0; while (k < n) { d = somarDias(d, 1); if (util(d)) k += 1; } return d; }
const ultimoDiaMes = (a, m) => new Date(Date.UTC(a, m, 0)).getUTCDate();
function hoje(agora = Date.now()) { return deData(new Date(agora + FUSO_MS)); }

// ---------- períodos ----------
// Quinzena: "AAAA-MM-Q1" (dias 1 a 15) ou "AAAA-MM-Q2" (16 ao fim). Mês: "AAAA-MM".
const RE_QUINZENA = /^(\d{4})-(0[1-9]|1[0-2])-Q([12])$/;
const RE_MES = /^(\d{4})-(0[1-9]|1[0-2])$/;
function limites(ref) {
  let m = RE_QUINZENA.exec(ref);
  if (m) {
    const a = Number(m[1]); const mes = Number(m[2]); const q = Number(m[3]);
    return { ini: `${m[1]}-${m[2]}-${q === 1 ? '01' : '16'}`, fim: `${m[1]}-${m[2]}-${q === 1 ? '15' : pad(ultimoDiaMes(a, mes))}`, mes: `${m[1]}-${m[2]}`, quinzena: q };
  }
  m = RE_MES.exec(ref);
  if (m) return { ini: `${ref}-01`, fim: `${ref}-${pad(ultimoDiaMes(Number(m[1]), Number(m[2])))}`, mes: ref, quinzena: null };
  return null;
}
function rotulo(ref) {
  const l = limites(ref);
  if (!l) return ref;
  const [a, m] = l.mes.split('-').map(Number);
  return `${l.quinzena ? `${l.quinzena}ª quinz. ` : ''}${MESES[m - 1]}/${a}`;
}
// Período (da empresa) que contém o dia, e o anterior.
function periodoDe(ciclo, dia) {
  const mes = dia.slice(0, 7);
  return ciclo === 'quinzenal' ? `${mes}-Q${Number(dia.slice(8)) <= 15 ? 1 : 2}` : mes;
}
function periodoAnterior(ciclo, ref) { return periodoDe(ciclo, somarDias(limites(ref).ini, -1)); }

// ---------- previsão do pagamento ----------
// Três padrões são testados no histórico de cada empresa; vale o mais regular,
// com mais peso para os pagamentos recentes.
const METODOS = {
  corridos: { texto: (m) => `${m} dias corridos após a nota`, unidade: 'dias', valor: (n) => diasEntre(n.emissao, n.pagamento), projetar: (em, m) => proximoUtil(somarDias(em, m)) },
  uteis: { texto: (m) => `${m} dias úteis após a nota`, unidade: 'dias úteis', valor: (n) => uteisEntre(n.emissao, n.pagamento), projetar: (em, m) => somarUteis(em, m) },
  diaDoMes: { texto: (m) => `por volta do dia ${m} de cada mês`, unidade: 'dia do mês', valor: (n) => Number(n.pagamento.slice(8)), projetar: (em, m) => noDia(em, m), soMensal: true }
};
function noDia(emissao, dia) {
  const [a, m] = emissao.split('-').map(Number);
  let d = `${a}-${pad(m)}-${pad(Math.min(dia, ultimoDiaMes(a, m)))}`;
  if (d <= somarDias(emissao, 2)) {
    const p = new Date(Date.UTC(a, m, 1));
    const pa = p.getUTCFullYear(); const pm = p.getUTCMonth() + 1;
    d = `${pa}-${pad(pm)}-${pad(Math.min(dia, ultimoDiaMes(pa, pm)))}`;
  }
  return proximoUtil(d);
}
function ponderado(vals) {
  const w = vals.map((_, i) => i + 1);
  const W = w.reduce((a, b) => a + b, 0);
  const media = vals.reduce((a, v, i) => a + v * w[i], 0) / W;
  const desvio = Math.sqrt(vals.reduce((a, v, i) => a + w[i] * (v - media) ** 2, 0) / W);
  return { media, desvio };
}
const pagas = (notas, empresa) => notas
  .filter((n) => n.empresa === empresa && n.emissao && n.pagamento && n.pagamento >= n.emissao)
  .sort((a, b) => a.pagamento.localeCompare(b.pagamento));

function modelo(empresa, historico, regra = null) {
  const temRegra = regra && METODOS[regra.tipo] && regra.valor > 0 && !(METODOS[regra.tipo].soMensal && EMPRESA[empresa].ciclo !== 'mensal');
  if (historico.length < 3 && temRegra) {
    // Pouco histórico: vale o prazo informado pela empresa.
    const M = METODOS[regra.tipo];
    return { metodo: regra.tipo, valores: historico.map(M.valor), media: regra.valor, desvio: 0, n: historico.length, folga: 2,
      confianca: 'regra', texto: M.texto(regra.valor), unidade: M.unidade, pelaRegra: true };
  }
  if (!historico.length) return null;
  const ciclo = EMPRESA[empresa].ciclo;
  let melhor = null;
  for (const [id, M] of Object.entries(METODOS)) {
    if (M.soMensal && ciclo !== 'mensal') continue;
    if (historico.length < 3 && id !== 'corridos') continue;
    const valores = historico.map(M.valor);
    const s = ponderado(valores);
    if (!melhor || s.desvio < melhor.desvio - 0.05) melhor = { metodo: id, valores, media: Math.round(s.media), desvio: s.desvio };
  }
  const n = historico.length;
  const folga = Math.max(1, Math.ceil(n < 3 ? Math.max(melhor.desvio, 3) : melhor.desvio));
  const confianca = n >= 4 && melhor.desvio <= 1.5 ? 'alta' : n >= 3 && melhor.desvio <= 3 ? 'media' : 'baixa';
  return { ...melhor, n, folga, confianca, texto: METODOS[melhor.metodo].texto(melhor.media), unidade: METODOS[melhor.metodo].unidade, pelaRegra: false };
}
function projetar(m, emissao) {
  if (!m || !emissao) return null;
  const M = METODOS[m.metodo];
  const data = M.projetar(emissao, m.media);
  let cedo = M.projetar(emissao, Math.max(1, m.media - m.folga));
  let tarde = M.projetar(emissao, m.media + m.folga);
  if (cedo > data) cedo = data;
  if (tarde < data) tarde = data;
  return { data, cedo, tarde };
}
// Prevê cada pagamento antigo usando só os anteriores: mostra quanto a previsão erra.
function acerto(empresa, historico, regra = null) {
  const erros = [];
  for (let i = 2; i < historico.length; i += 1) {
    const p = projetar(modelo(empresa, historico.slice(0, i), regra), historico[i].emissao);
    if (p) erros.push(Math.abs(diasEntre(p.data, historico[i].pagamento)));
  }
  return erros.length ? { erroMedio: Math.round((erros.reduce((a, b) => a + b, 0) / erros.length) * 10) / 10, testes: erros.length } : null;
}

// ---------- modelos de emissão (como cada empresa quer a nota) ----------
// Preenchidos com o que as empresas publicam; o resto o administrador completa no painel.
// Na descrição e nas observações dá para usar {periodo}, {inicio}, {fim}, {valor}, {quantidade} e {empresa}.
const NFSE = 'NFS-e pelo Emissor Nacional (Tobias Barreto/SE)';
const SERVICO = '11.04.01'; // Armazenamento, depósito, guarda de bens de qualquer espécie
const MODELOS_PADRAO = {
  correios: {
    tipo: NFSE,
    tomadorNome: 'EMPRESA BRASILEIRA DE CORREIOS E TELEGRAFOS', tomadorCnpj: '34.028.316/0032-00',
    tomadorEndereco: 'R Laranjeiras, 229, Centro, Aracaju/SE, CEP 49.010-000', tomadorEmail: '',
    codigoServico: SERVICO, cnae: '',
    descricao: 'Servico de recebimento e entrega de mercadorias.',
    observacoes: '',
    janela: 'No início do mês, referente ao mês anterior (a nota de out/2026 foi emitida em 03/11).',
    envio: '',
    fonte: 'Dados copiados da NFS-e nº 76 (out/2026). Prazo de pagamento: o contrato publicado pelos Correios para pontos de coleta (modelo das lotéricas) diz que a nota atestada até o dia 15 é paga no dia 28. Confirme com o seu contrato.',
    regra: { tipo: 'diaDoMes', valor: 28 },
    checklist: ['Conferir o valor do mês com os Correios', 'Tomador: CNPJ 34.028.316/0032-00 (Aracaju)', 'Código 11.04.01', 'Enviar a nota para os Correios']
  },
  ml: {
    tipo: NFSE,
    tomadorNome: 'MERCADO LIVRE BRASIL LTDA', tomadorCnpj: '03.007.331/0001-41',
    tomadorEndereco: 'Av. das Nacoes Unidas, 3003, Letra Parte A, Bonfim, Osasco/SP, CEP 06.233-903', tomadorEmail: '',
    codigoServico: SERVICO, cnae: '',
    descricao: 'Servico de recebimento e entrega de mercadorias.',
    observacoes: '',
    janela: 'A cada quinzena, depois do fechamento do "Recebimento estimado" no Places (a nota da 2ª quinzena de out/2026 foi emitida em 03/11).',
    envio: 'Portal Places',
    fonte: 'Dados copiados da NFS-e nº 77 (2ª quinzena de out/2026). O Mercado Livre não publica o prazo de pagamento das agências: a previsão aprende pelo histórico.',
    regra: { tipo: '', valor: 0 },
    checklist: ['Conferir o acumulado da quinzena no Places', 'Tomador: CNPJ 03.007.331/0001-41', 'Código 11.04.01', 'Enviar a nota pelo Places']
  },
  shopee: {
    tipo: NFSE,
    tomadorNome: 'SHPX LOGISTICA LTDA.', tomadorCnpj: '42.446.277/0001-92',
    tomadorEndereco: 'Av. Brig. Faria Lima, 3732, Andar 22 e 23, Itaim Bibi, São Paulo/SP, CEP 04.538-132', tomadorEmail: '',
    codigoServico: SERVICO, cnae: '',
    descricao: '#PUDO Serviço de Armazenamento',
    observacoes: '',
    janela: 'Do dia 1 ao dia 7 de cada mês, referente ao mês anterior.',
    envio: '',
    fonte: 'Dados copiados da NFS-e nº 78 (out/2026). A descrição começa com a hashtag #PUDO. Central de Ajuda da Shopee (Agências): emissão do dia 1 ao 7, pagamento 30 dias corridos depois do dia 7.',
    regra: { tipo: 'corridos', valor: 30 },
    checklist: ['Emitir entre os dias 1 e 7', 'Tomador: SHPX LOGISTICA LTDA., CNPJ 42.446.277/0001-92', 'Descrição começando com #PUDO', 'Código 11.04.01']
  }
};
const CAMPOS_MODELO = ['tipo', 'tomadorNome', 'tomadorCnpj', 'tomadorEndereco', 'tomadorEmail', 'codigoServico', 'cnae', 'descricao', 'observacoes', 'janela', 'envio', 'fonte'];
function modelos(db) {
  const salvos = ler(db, 'contab:modelos', {});
  const out = {};
  for (const e of EMPRESAS) {
    const s = salvos[e.id] || {};
    out[e.id] = { ...MODELOS_PADRAO[e.id], ...s, regra: { ...MODELOS_PADRAO[e.id].regra, ...(s.regra || {}) }, checklist: s.checklist || MODELOS_PADRAO[e.id].checklist };
  }
  return out;
}
function salvarModelo(db, empresa, b) {
  if (!EMPRESA[empresa]) throw new Error('Empresa inválida.');
  const salvos = ler(db, 'contab:modelos', {});
  const m = {};
  for (const k of CAMPOS_MODELO) if (k in b) m[k] = String(b[k] ?? '').replace(/\r/g, '').slice(0, k === 'descricao' || k === 'observacoes' || k === 'fonte' ? 1500 : 200);
  if (b.regra) {
    const tipo = ['corridos', 'uteis', 'diaDoMes', ''].includes(b.regra.tipo) ? b.regra.tipo : '';
    const valor = Math.round(Number(b.regra.valor) || 0);
    if (tipo && !(valor >= 1 && valor <= (tipo === 'diaDoMes' ? 31 : 120))) throw new Error('Prazo da regra inválido.');
    m.regra = { tipo, valor: tipo ? valor : 0 };
  }
  if (Array.isArray(b.checklist)) m.checklist = b.checklist.map((x) => String(x || '').trim().slice(0, 140)).filter(Boolean).slice(0, 15);
  salvos[empresa] = { ...(salvos[empresa] || {}), ...m };
  gravar(db, 'contab:modelos', salvos);
  return modelos(db)[empresa];
}

// ---------- validação ----------
const dinheiro = (v) => { const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > 1e7) throw new Error('Valor inválido.'); return Math.round(n * 100) / 100; };
const texto = (v, max = 80) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const dia = (v) => { if (v === null || v === undefined || v === '') return null; if (!RE_DIA.test(String(v))) throw new Error('Data inválida.'); return String(v); };
const RE_FID = /^[A-Za-z0-9_-]{1,64}$/;
// Documento de emissão guardado com a nota: os campos como foram preenchidos.
function documento(d) {
  if (!d) return null;
  const campos = Array.isArray(d.campos) ? d.campos.slice(0, 30).map((c) => ({ rotulo: texto(c.rotulo, 60), valor: String(c.valor ?? '').slice(0, 1500) })) : [];
  const checklist = Array.isArray(d.checklist) ? d.checklist.slice(0, 15).map((c) => ({ texto: texto(c.texto, 140), feito: Boolean(c.feito) })) : [];
  return { salvoEm: new Date().toISOString(), campos, checklist };
}

// ---------- funcionários (salário) ----------
function salarios(db) { return ler(db, 'contab:salarios', {}); }
function salvarSalario(db, fid, b) {
  if (!RE_FID.test(fid)) throw new Error('Funcionário inválido.');
  const s = salarios(db);
  const carga = Number(b.carga ?? 220);
  if (!(carga >= 1 && carga <= 400)) throw new Error('Carga horária inválida.');
  s[fid] = { salario: dinheiro(b.salario), carga: Math.round(carga) };
  gravar(db, 'contab:salarios', s);
  return s[fid];
}

// ---------- contracheques ----------
function contracheques(db, ref) {
  if (!RE_QUINZENA.test(ref)) throw new Error('Quinzena inválida.');
  return ler(db, `contab:cc:${ref}`, {});
}
function salvarContracheque(db, ref, fid, b) {
  if (!RE_QUINZENA.test(ref)) throw new Error('Quinzena inválida.');
  if (!RE_FID.test(fid)) throw new Error('Funcionário inválido.');
  const horas = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); if (!(n >= 0 && n <= 400)) throw new Error('Horas inválidas.'); return Math.round(n * 100) / 100; };
  const mult = (v, p) => { const n = Number(v ?? p); if (!(n >= 1 && n <= 3)) throw new Error('Adicional inválido.'); return n; };
  const linhas = Array.isArray(b.linhas) ? b.linhas.slice(0, 30).map((l) => ({
    tipo: l.tipo === 'd' ? 'd' : 'p', desc: texto(l.desc, 60), valor: dinheiro(l.valor || 0)
  })) : [];
  const cc = contracheques(db, ref);
  cc[fid] = {
    base: b.base === null || b.base === undefined || b.base === '' ? null : dinheiro(b.base),
    he50: horas(b.he50), he100: horas(b.he100), m50: mult(b.m50, 1.5), m100: mult(b.m100, 2),
    linhas, pagoEm: dia(b.pagoEm)
  };
  gravar(db, `contab:cc:${ref}`, cc);
  return cc[fid];
}

// ---------- notas fiscais ----------
function notas(db) { return ler(db, 'contab:notas', []); }
function validarNota(b, atual = {}) {
  const empresa = b.empresa ?? atual.empresa;
  if (!EMPRESA[empresa]) throw new Error('Empresa inválida.');
  const ref = b.ref ?? atual.ref;
  const l = limites(String(ref || ''));
  if (!l || Boolean(l.quinzena) !== (EMPRESA[empresa].ciclo === 'quinzenal')) throw new Error('Período inválido para essa empresa.');
  const n = {
    id: atual.id || crypto.randomUUID(), empresa, ref,
    valor: dinheiro(b.valor ?? atual.valor ?? 0),
    numero: texto(b.numero ?? atual.numero ?? '', 30),
    emissao: 'emissao' in b ? dia(b.emissao) : (atual.emissao || null),
    pagamento: 'pagamento' in b ? dia(b.pagamento) : (atual.pagamento || null),
    quantidade: 'quantidade' in b ? (b.quantidade === null || b.quantidade === '' ? null : Math.max(0, Math.round(Number(b.quantidade) || 0))) : (atual.quantidade ?? null),
    documento: 'documento' in b ? documento(b.documento) : (atual.documento || null)
  };
  if (n.pagamento && !n.emissao) throw new Error('Informe a emissão antes do pagamento.');
  if (n.pagamento && n.pagamento < n.emissao) throw new Error('O pagamento não pode ser antes da emissão.');
  return n;
}
function criarNota(db, b) {
  const lista = notas(db);
  const n = validarNota(b || {});
  if (lista.some((x) => x.empresa === n.empresa && x.ref === n.ref)) throw new Error(`Já existe uma nota de ${EMPRESA[n.empresa].nome} para ${rotulo(n.ref)}.`);
  if (lista.length >= 500) throw new Error('Limite de notas atingido.');
  lista.push(n);
  gravar(db, 'contab:notas', lista);
  return n;
}
function editarNota(db, id, b) {
  const lista = notas(db);
  const i = lista.findIndex((x) => x.id === id);
  if (i < 0) throw new Error('Nota não encontrada.');
  const n = validarNota(b || {}, lista[i]);
  if (lista.some((x, j) => j !== i && x.empresa === n.empresa && x.ref === n.ref)) throw new Error('Já existe outra nota para esse período.');
  lista[i] = n;
  gravar(db, 'contab:notas', lista);
  return n;
}
function apagarNota(db, id) {
  const lista = notas(db);
  const nova = lista.filter((x) => x.id !== id);
  if (nova.length === lista.length) throw new Error('Nota não encontrada.');
  gravar(db, 'contab:notas', nova);
}

// Valor e quantidade do período pelo painel Financeiro (sugestão para a nota).
function doFinanceiro(db, empresa, ref) {
  try {
    const l = limites(ref);
    const r = financeiro.resumo(db, l.mes);
    if (empresa === 'correios') return { valor: r.correios.total, quantidade: r.quantidades.correios.pacotes };
    if (empresa === 'shopee') {
      const q = r.quantidades.shopee;
      return { valor: r.shopee.total, quantidade: q.expedidos + q.retiradas + q.devolucoes };
    }
    const qk = l.quinzena === 1 ? 'q1' : 'q2';
    const q = r.quantidades.ml[qk];
    return { valor: r.ml[qk].total, quantidade: q.delivery + q.pickup + q.falhas };
  } catch { return { valor: null, quantidade: null }; }
}

function resumoNotas(db, agora = Date.now()) {
  const h = hoje(agora);
  const lista = notas(db);
  const mods = modelos(db);
  const empresas = EMPRESAS.map((e) => {
    const regra = mods[e.id].regra;
    const hist = pagas(lista, e.id);
    const m = modelo(e.id, hist, regra);
    // Período que já terminou e ainda não tem nota, e o período em andamento.
    const atual = periodoDe(e.ciclo, h);
    const anterior = periodoAnterior(e.ciclo, atual);
    const temNota = (ref) => lista.some((n) => n.empresa === e.id && n.ref === ref);
    const pendentes = [];
    if (!temNota(anterior)) {
      const l = limites(anterior);
      pendentes.push({ ref: anterior, rotulo: rotulo(anterior), inicio: l.ini, fim: l.fim, liberadaEm: somarDias(l.fim, 1), ...doFinanceiro(db, e.id, anterior), seEmitirHoje: projetar(m, h) });
    }
    const la = limites(atual);
    const proxima = temNota(atual) ? null : {
      ref: atual, rotulo: rotulo(atual), inicio: la.ini, fim: la.fim, liberadaEm: somarDias(la.fim, 1),
      ...doFinanceiro(db, e.id, atual), seEmitirNoDia: projetar(m, somarDias(la.fim, 1))
    };
    return {
      ...e, modelo: m ? { metodo: m.metodo, texto: m.texto, unidade: m.unidade, media: m.media, valores: m.valores.slice(-6), n: m.n, confianca: m.confianca, pelaRegra: m.pelaRegra } : null,
      acerto: acerto(e.id, hist, regra), pendentes, proxima, emissao: mods[e.id]
    };
  });
  const comPrevisao = lista.map((n) => {
    const m = modelo(n.empresa, pagas(lista, n.empresa).filter((x) => x.id !== n.id), mods[n.empresa].regra);
    const previsao = !n.pagamento && n.emissao ? projetar(m, n.emissao) : null;
    let situacao = 'paga';
    if (!n.pagamento) {
      if (!n.emissao) situacao = 'a_emitir';
      else if (!previsao) situacao = 'aguardando';
      else if (previsao.tarde < h) situacao = 'atrasada';
      else if (previsao.cedo <= h) situacao = 'pode_cair';
      else situacao = 'aguardando';
    }
    const l = limites(n.ref);
    return { ...n, rotulo: rotulo(n.ref), inicio: l.ini, fim: l.fim, previsao, situacao, prazo: n.pagamento ? diasEntre(n.emissao, n.pagamento) : null };
  });
  return { hoje: h, empresas, notas: comPrevisao };
}

// Notas de out/2026 já emitidas (NFS-e 76, 77 e 78): entram uma vez só, sem duplicar.
const NOTAS_INICIAIS = [
  { empresa: 'correios', ref: '2026-10', numero: '76', valor: 1004.30, emissao: '2026-11-03' },
  { empresa: 'ml', ref: '2026-10-Q2', numero: '77', valor: 5805.90, emissao: '2026-11-03' },
  { empresa: 'shopee', ref: '2026-10', numero: '78', valor: 16652.00, emissao: '2026-11-04' }
];
function registrarNotasIniciais(db) {
  if (ler(db, 'contab:inicial-out2026', false)) return 0;
  const lista = notas(db);
  let n = 0;
  for (const x of NOTAS_INICIAIS) {
    if (lista.some((y) => y.empresa === x.empresa && y.ref === x.ref)) continue;
    lista.push(validarNota(x));
    n += 1;
  }
  if (n) gravar(db, 'contab:notas', lista);
  gravar(db, 'contab:inicial-out2026', true);
  return n;
}

module.exports = {
  EMPRESAS, hoje, limites, rotulo, periodoDe, periodoAnterior,
  modelo, projetar, acerto, pagas,
  salarios, salvarSalario, contracheques, salvarContracheque, modelos, salvarModelo,
  notas, criarNota, editarNota, apagarNota, resumoNotas, registrarNotasIniciais
};
