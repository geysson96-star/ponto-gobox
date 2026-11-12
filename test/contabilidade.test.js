'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const c = require('../src/contabilidade');

const nota = (empresa, ref, emissao, pagamento, valor = 100) => ({ empresa, ref, emissao, pagamento, valor });

test('Contabilidade: períodos mensais e quinzenais', () => {
  assert.deepEqual(c.limites('2026-02-Q2'), { ini: '2026-02-16', fim: '2026-02-28', mes: '2026-02', quinzena: 2 });
  assert.equal(c.limites('2026-11').fim, '2026-11-30');
  assert.equal(c.periodoDe('quinzenal', '2026-11-15'), '2026-11-Q1');
  assert.equal(c.periodoDe('quinzenal', '2026-11-16'), '2026-11-Q2');
  assert.equal(c.periodoAnterior('quinzenal', '2026-11-Q1'), '2026-10-Q2');
  assert.equal(c.periodoAnterior('mensal', '2026-01'), '2025-12');
  assert.equal(c.rotulo('2026-11-Q2'), '2ª quinz. nov/2026');
});

test('Contabilidade: previsão escolhe o padrão mais regular do histórico', () => {
  // Correios paga sempre perto do dia 20, emitindo em dias diferentes.
  const hist = c.pagas([
    nota('correios', '2026-06', '2026-07-02', '2026-07-20'),
    nota('correios', '2026-07', '2026-08-06', '2026-08-20'),
    nota('correios', '2026-08', '2026-09-01', '2026-09-21'),
    nota('correios', '2026-09', '2026-10-05', '2026-10-20')
  ], 'correios');
  const m = c.modelo('correios', hist);
  assert.equal(m.metodo, 'diaDoMes');
  assert.equal(m.media, 20);
  const p = c.projetar(m, '2026-11-04');
  assert.equal(p.data, '2026-11-20');
  assert.ok(p.cedo <= p.data && p.data <= p.tarde);

  // Mercado Livre: prazo fixo em dias após a nota (sem o método de dia do mês, que é só mensal).
  const ml = c.pagas([
    nota('ml', '2026-09-Q1', '2026-09-16', '2026-09-24'),
    nota('ml', '2026-09-Q2', '2026-10-01', '2026-10-09'),
    nota('ml', '2026-10-Q1', '2026-10-16', '2026-10-24')
  ], 'ml');
  const mm = c.modelo('ml', ml);
  assert.notEqual(mm.metodo, 'diaDoMes');
  // Cai em dia útil.
  const d = new Date(`${c.projetar(mm, '2026-11-03').data}T12:00:00Z`).getUTCDay();
  assert.ok(d !== 0 && d !== 6);
});

test('Contabilidade: com pouco histórico vale a regra da empresa', () => {
  const m = c.modelo('shopee', [], { tipo: 'corridos', valor: 30 });
  assert.equal(m.pelaRegra, true);
  assert.equal(c.projetar(m, '2026-11-05').data, '2026-12-07'); // 05/12 é sábado: vai para segunda
  assert.equal(c.modelo('ml', [], { tipo: '', valor: 0 }), null);
});

test('Contabilidade: notas, contracheques, salários e modelos ficam salvos', () => {
  const db = openDb(':memory:');
  const n = c.criarNota(db, { empresa: 'ml', ref: '2026-10-Q2', valor: 2512.4, emissao: '2026-11-03' });
  assert.throws(() => c.criarNota(db, { empresa: 'ml', ref: '2026-10-Q2', valor: 1 }), /Já existe/);
  assert.throws(() => c.criarNota(db, { empresa: 'ml', ref: '2026-10', valor: 1 }), /Período inválido/);
  assert.throws(() => c.editarNota(db, n.id, { pagamento: '2026-11-01' }), /antes da emissão/);
  c.editarNota(db, n.id, { pagamento: '2026-11-10', documento: { campos: [{ rotulo: 'Valor', valor: 'R$ 2.512,40' }], checklist: [{ texto: 'Enviar', feito: true }] } });
  const r = c.resumoNotas(db, Date.parse('2026-11-12T12:00:00Z'));
  const salva = r.notas.find((x) => x.id === n.id);
  assert.equal(salva.situacao, 'paga');
  assert.equal(salva.prazo, 7);
  assert.equal(salva.documento.campos[0].valor, 'R$ 2.512,40');
  // A 1ª quinzena de novembro ainda está aberta: não é pendente, é a próxima.
  const ml = r.empresas.find((e) => e.id === 'ml');
  assert.equal(ml.proxima.ref, '2026-11-Q1');
  assert.equal(ml.pendentes.length, 0);
  assert.equal(r.empresas.find((e) => e.id === 'correios').pendentes[0].ref, '2026-10');

  c.salvarModelo(db, 'shopee', { tomadorCnpj: '00.000.000/0001-00', observacoes: '#AGENCIA {periodo}', regra: { tipo: 'corridos', valor: 31 } });
  const ms = c.modelos(db).shopee;
  assert.equal(ms.tomadorCnpj, '00.000.000/0001-00');
  assert.equal(ms.regra.valor, 31);
  assert.ok(ms.janela.includes('dia 1 ao dia 7') && ms.descricao.startsWith('#PUDO')); // padrões continuam
  assert.throws(() => c.salvarModelo(db, 'shopee', { regra: { tipo: 'diaDoMes', valor: 40 } }), /Prazo/);

  c.salvarSalario(db, 'abc123', { salario: 1800, carga: 220 });
  assert.deepEqual(c.salarios(db).abc123, { salario: 1800, carga: 220 });
  c.salvarContracheque(db, '2026-11-Q1', 'abc123', { he50: 4.5, linhas: [{ tipo: 'd', desc: 'Vale-transporte', valor: 54 }] });
  const cc = c.contracheques(db, '2026-11-Q1').abc123;
  assert.equal(cc.he50, 4.5);
  assert.equal(cc.he100, null); // sem alteração: usa o do ponto
  assert.equal(cc.m50, 1.5);
  assert.throws(() => c.salvarContracheque(db, '2026-11', 'abc123', {}), /Quinzena inválida/);
  assert.throws(() => c.salvarSalario(db, '../x', { salario: 1 }), /Funcionário inválido/);
});

test('Contabilidade: rotas do painel exigem login', async () => {
  const { createApp } = require('../src/app');
  const db = openDb(':memory:');
  const app = createApp({ config: { ROOT: require('node:path').join(__dirname, '..'), ADMIN_USER: 'a', ADMIN_PASSWORD_HASH: 'x', SESSION_HOURS: 1, COOKIE_SECURE: false, TRUST_PROXY: false, INBOX_INTERVAL_MINUTES: 0, PUBLIC_RATE_PER_MINUTE: 1000, MAX_UPLOAD_MB: 5 }, db });
  const srv = app.listen(0);
  try {
    const port = srv.address().port;
    const r = await fetch(`http://127.0.0.1:${port}/admin/api/contabilidade`);
    assert.equal(r.status, 401);
    const p = await fetch(`http://127.0.0.1:${port}/admin/contabilidade/`);
    assert.equal(p.status, 200);
    assert.match(p.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  } finally { srv.close(); }
});

test('Contabilidade: notas de out/2026 entram uma vez só', () => {
  const db = openDb(':memory:');
  c.criarNota(db, { empresa: 'shopee', ref: '2026-10', valor: 1 });
  assert.equal(c.registrarNotasIniciais(db), 2);
  assert.equal(c.registrarNotasIniciais(db), 0);
  const r = c.resumoNotas(db, Date.parse('2026-11-12T12:00:00Z'));
  assert.equal(r.notas.length, 3);
  assert.equal(r.notas.find((n) => n.empresa === 'ml').numero, '77');
  assert.equal(r.notas.find((n) => n.empresa === 'correios').previsao.data, '2026-11-30');
});
