'use strict';
// Entregadores e coletadores parceiros (aba "Entregadores" do painel).
//
// O cadastro público (/entregador) grava aqui; o painel aceita, recusa, exclui, dá nota
// e filtra por serviço. Guardamos só o necessário para o credenciamento: nome, WhatsApp,
// serviços, dias/horários, experiência e observação (com a autorização da LGPD).
// Tudo fica na tabela "financeiro" (chaves "entreg:*"), salva no Firebase pela persistência.

const crypto = require('node:crypto');
const eventos = require('./eventos');

const PREFIXO = 'entreg:c:';
const CHAVE_CONFIG = 'entreg:config';
const MAX_CADASTROS = 2000;
const SITUACOES = ['pendente', 'aprovado', 'recusado'];
const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const TURNOS = ['Manhã', 'Tarde', 'Noite'];
const EXPERIENCIAS = ['Sim, mais de 1 ano', 'Sim, menos de 1 ano', 'Não, seria a primeira vez'];
const APPS = ['Mercado Livre', 'Shopee', 'iFood', 'Correios', 'Lalamove', 'Loggi', 'Outro'];

const CONFIG_PADRAO = {
  servicos: [
    { id: 'ml', nome: 'Entregas Mercado Livre', para: 'Entregador', desc: 'Rota diária com os pacotes do Mercado Livre que chegam nas sacas. Ideal para quem pode fazer sempre.', dias: [1, 2, 3, 4, 5, 6], obs: '', valor: '' },
    { id: 'shopee', nome: 'Entregas Shopee', para: 'Entregador', desc: 'Pacotes da Shopee nos dias de maior movimento.', dias: [5, 6, 0, 1], obs: '', valor: 'R$ 1,50 por pacote' },
    { id: 'azul', nome: 'Fretes Azul Cargo', para: 'Entregador', desc: 'Fretes da Azul, uma vez por semana. Pacote grande paga mais.', dias: [], obs: '1 vez por semana, dia a definir', valor: 'R$ 2 pacote normal · R$ 3 grande' },
    { id: 'emergencial', nome: 'Entregas expressas', para: 'Entregador', desc: 'Entregas de última hora: a GoBox chama quando surge um pedido urgente e você aceita se puder.', dias: [0, 1, 2, 3, 4, 5, 6], obs: 'Sob demanda, qualquer dia', valor: 'R$ 4 por entrega' },
    { id: 'coleta', nome: 'Coleta', para: 'Coletador', desc: 'Buscar pacotes e trazer para a GoBox.', dias: [], obs: 'Dias a definir', valor: '' }
  ],
  pagamento: { titulo: 'Pagamento todo sábado', texto: 'Os fretes e pacotes da semana são contabilizados e pagos aos sábados.' }
};

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

const texto = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const lista = (v, ok, max = 30) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x)).filter((x) => ok(x)))].slice(0, max) : []);

// ---------- configuração (serviços, dias, valores) ----------
function config(db) {
  const c = ler(db, CHAVE_CONFIG, null);
  return c && Array.isArray(c.servicos) ? c : CONFIG_PADRAO;
}
// Versão pública: nunca mostra os valores (combinados só com a GoBox).
function configPublica(db) {
  const c = config(db);
  return {
    servicos: c.servicos.map(({ id, nome, para, desc, dias, obs }) => ({ id, nome, para, desc, dias, obs })),
    pagamento: c.pagamento
  };
}
function salvarConfig(db, corpo) {
  const atual = config(db);
  const servicos = Array.isArray(corpo.servicos) ? corpo.servicos : atual.servicos;
  const limpo = {
    servicos: servicos.slice(0, 12).map((s, i) => ({
      id: texto(s.id, 24).replace(/[^a-z0-9_-]/gi, '') || `s${i + 1}`,
      nome: texto(s.nome, 60) || 'Serviço',
      para: s.para === 'Coletador' ? 'Coletador' : 'Entregador',
      desc: texto(s.desc, 240),
      dias: lista(s.dias, (d) => /^[0-6]$/.test(d), 7).map(Number),
      obs: texto(s.obs, 80),
      valor: texto(s.valor, 80)
    })),
    pagamento: {
      titulo: texto((corpo.pagamento || atual.pagamento || {}).titulo, 60),
      texto: texto((corpo.pagamento || atual.pagamento || {}).texto, 240)
    }
  };
  gravar(db, CHAVE_CONFIG, limpo);
  return limpo;
}

// ---------- cadastros ----------
function todos(db) {
  garantir(db);
  return db.prepare('SELECT json FROM financeiro WHERE chave LIKE ?').all(`${PREFIXO}%`)
    .map((r) => { try { return JSON.parse(r.json); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => String(b.criadoEm).localeCompare(String(a.criadoEm)));
}

function cadastrar(db, corpo, agora = new Date()) {
  if (corpo.lgpd !== true) throw new Error('Marque a autorização da LGPD para enviar.');
  const nome = texto(corpo.nome, 80);
  if (nome.length < 2) throw new Error('Digite seu nome.');
  const digitos = String(corpo.whatsapp || '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
  if (digitos.length < 10 || digitos.length > 11) throw new Error('WhatsApp incompleto.');
  const ids = config(db).servicos.map((s) => s.id);
  const servicos = lista(corpo.servicos, (s) => ids.includes(s), 12);
  if (!servicos.length) throw new Error('Escolha pelo menos um serviço.');
  const horarios = lista(corpo.horarios, (h) => DIAS.some((d) => TURNOS.some((t) => h === `${d}-${t}`)), 21);
  if (!horarios.length) throw new Error('Marque os dias e horários que você pode.');
  const funcao = ['entregador', 'coletador', 'ambos'].includes(corpo.funcao) ? corpo.funcao : 'entregador';
  const experiencia = EXPERIENCIAS.includes(corpo.experiencia) ? corpo.experiencia : '';
  const qtd = db.prepare('SELECT COUNT(*) AS n FROM financeiro WHERE chave LIKE ?').get(`${PREFIXO}%`).n;
  if (qtd >= MAX_CADASTROS) throw new Error('Cadastros temporariamente fechados. Fale com a GoBox pelo WhatsApp.');
  // Mesmo WhatsApp de novo: atualiza o cadastro existente em vez de duplicar.
  const existente = todos(db).find((c) => c.whatsapp === digitos);
  const c = {
    id: existente ? existente.id : crypto.randomBytes(8).toString('hex'),
    situacao: existente ? existente.situacao : 'pendente',
    nota: existente ? existente.nota : 0,
    anotacao: existente ? existente.anotacao : '',
    criadoEm: existente ? existente.criadoEm : agora.toISOString(),
    atualizadoEm: agora.toISOString(),
    funcao, nome, whatsapp: digitos, servicos, horarios, experiencia,
    apps: lista(corpo.apps, (a) => APPS.includes(a), 7),
    obs: texto(corpo.obs, 500)
  };
  gravar(db, PREFIXO + c.id, c);
  return { ok: true };
}

function atualizar(db, id, corpo) {
  const c = ler(db, PREFIXO + String(id), null);
  if (!c) return null;
  if (SITUACOES.includes(corpo.situacao)) c.situacao = corpo.situacao;
  if (corpo.nota !== undefined) {
    const n = Math.round(Number(corpo.nota));
    if (Number.isFinite(n) && n >= 0 && n <= 5) c.nota = n;
  }
  if (corpo.anotacao !== undefined) c.anotacao = texto(corpo.anotacao, 300);
  c.atualizadoEm = new Date().toISOString();
  gravar(db, PREFIXO + c.id, c);
  return c;
}

function apagar(db, id) {
  garantir(db);
  const r = db.prepare('DELETE FROM financeiro WHERE chave = ?').run(PREFIXO + String(id));
  if (r.changes) eventos.emit('estado');
  return r.changes > 0;
}

function resumo(db) {
  const cadastros = todos(db);
  return {
    config: config(db),
    cadastros,
    contagem: Object.fromEntries(SITUACOES.map((s) => [s, cadastros.filter((c) => c.situacao === s).length]))
  };
}

module.exports = { config, configPublica, salvarConfig, cadastrar, atualizar, apagar, resumo, todos };
