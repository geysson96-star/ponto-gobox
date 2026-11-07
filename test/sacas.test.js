'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const sacas = require('../src/sacas');

// 7 de nov. de 2026, horários da Bahia (UTC-3).
const T = (hhmm) => Date.parse(`2026-11-07T${hhmm}:00-03:00`);
const ISO = (hhmm) => new Date(T(hhmm)).toISOString();
const DIA = '2026-11-07';

function banco() { return openDb(':memory:'); }

const avisos = (db, agora) => sacas.resumo(db, { agora }).avisos;

test('envio misto (1 delivery + 4 next) gera um aviso para cada grupo, uma única vez', () => {
  const db = banco();
  sacas.salvarConfig(db, { ativo: true });
  let r = sacas.registrar(db, [{ numero: '078', status: 'a_caminho', dia: DIA, entregar: 1, extra: 4, caminhoEm: ISO('06:24') }], { agora: T('06:30') });
  assert.equal(r.novosAvisos, 0);
  r = sacas.registrar(db, [{ numero: '078', status: 'recebido', dia: DIA, entregar: 1, extra: 4 }], { agora: T('07:10') });
  assert.equal(r.novosAvisos, 2);
  r = sacas.registrar(db, [{ numero: '078', status: 'recebido', dia: DIA, entregar: 1, extra: 4 }], { agora: T('07:16') });
  assert.equal(r.novosAvisos, 0, 'atualizar de novo não repete');
  const a = avisos(db, T('07:16'));
  assert.deepEqual(a.map((x) => x.grupo).sort(), ['delivery', 'nex']);
  assert.ok(a.every((x) => x.onda === 'M1'));
  db.close();
});

test('cada grupo tem a própria numeração do dia', () => {
  const db = banco();
  sacas.registrar(db, [
    { numero: '078', status: 'a_caminho', dia: DIA, entregar: 1, extra: 4 },
    { numero: '095', status: 'a_caminho', dia: DIA, entregar: 0, extra: 6 },
    { numero: '929', status: 'a_caminho', dia: DIA, entregar: 1, extra: 0 }
  ], { agora: T('06:30') });
  sacas.registrar(db, [{ numero: '078', status: 'recebido', dia: DIA, entregar: 1, extra: 4 }], { agora: T('07:00') });
  sacas.registrar(db, [{ numero: '095', status: 'recebido', dia: DIA, entregar: 0, extra: 6 }], { agora: T('09:30') });
  sacas.registrar(db, [{ numero: '929', status: 'recebido', dia: DIA, entregar: 1, extra: 0 }], { agora: T('11:00') });
  const ondas = Object.fromEntries(sacas.resumo(db, { agora: T('11:00') }).envios.map((e) => [e.numero, e.ondas]));
  assert.deepEqual(ondas, { '078': { delivery: 'M1', nex: 'M1' }, '095': { nex: 'M2' }, '929': { delivery: 'M2' } });
  const a = avisos(db, T('11:00'));
  assert.equal(a.length, 4);
  assert.equal(a.filter((x) => x.grupo === 'nex').length, 2);
  db.close();
});

test('modo teste: aviso fica só no painel e o n8n não recebe nada', () => {
  const db = banco();
  sacas.registrar(db, [{ numero: '078', status: 'a_caminho', dia: DIA, entregar: 1, extra: 4 }], { agora: T('06:30') });
  sacas.registrar(db, [{ numero: '078', status: 'recebido', dia: DIA, entregar: 1, extra: 4 }], { agora: T('07:10') });
  assert.ok(avisos(db, T('07:10')).every((x) => x.situacao === 'teste'));
  assert.equal(sacas.reservarProximo(db, { agora: T('07:11') }), null);
  db.close();
});

test('n8n: reserva, confirma e não entrega o mesmo aviso duas vezes', () => {
  const db = banco();
  sacas.salvarConfig(db, { ativo: true });
  sacas.registrar(db, [{ numero: '078', status: 'a_caminho', dia: DIA, entregar: 1, extra: 4 }], { agora: T('06:30') });
  sacas.registrar(db, [{ numero: '078', status: 'recebido', dia: DIA, entregar: 1, extra: 4 }], { agora: T('07:10') });
  const a1 = sacas.reservarProximo(db, { agora: T('07:11') });
  const a2 = sacas.reservarProximo(db, { agora: T('07:11') });
  assert.ok(a1 && a2 && a1.grupo !== a2.grupo);
  assert.equal(sacas.reservarProximo(db, { agora: T('07:11') }), null);
  assert.equal(sacas.confirmar(db, a1.id, { ok: true }, { agora: T('07:12') }).situacao, 'enviado');
  assert.equal(sacas.confirmar(db, a2.id, { ok: false, erro: 'sem rede' }, { agora: T('07:12') }).situacao, 'falhou');
  assert.equal(sacas.reservarProximo(db, { agora: T('07:13') }), null);
  db.close();
});

test('chegou sem as sacas por tipo: espera o detalhe; sem ele, manda a mensagem geral no Delivery após 10 min', () => {
  const db = banco();
  sacas.registrar(db, [{ numero: '078', status: 'a_caminho', dia: DIA, sacas: 5 }], { agora: T('06:30') });
  let r = sacas.registrar(db, [{ numero: '078', status: 'recebido', dia: DIA, sacas: 5 }], { agora: T('07:10') });
  assert.equal(r.novosAvisos, 0);
  r = sacas.registrar(db, [{ numero: '078', status: 'recebido', dia: DIA }], { agora: T('07:21') });
  assert.equal(r.novosAvisos, 1);
  const [a] = avisos(db, T('07:21'));
  assert.equal(a.grupo, 'delivery');
  assert.match(a.texto, /Total: 5 sacas/);
  // E quando o detalhe chega antes dos 10 min, sai separado por grupo.
  sacas.registrar(db, [{ numero: '095', status: 'a_caminho', dia: DIA, sacas: 6 }], { agora: T('08:00') });
  sacas.registrar(db, [{ numero: '095', status: 'recebido', dia: DIA, sacas: 6 }], { agora: T('09:00') });
  r = sacas.registrar(db, [{ numero: '095', status: 'recebido', dia: DIA, entregar: 0, extra: 6 }], { agora: T('09:02') });
  assert.equal(r.novosAvisos, 1);
  assert.equal(avisos(db, T('09:02'))[0].grupo, 'nex');
  db.close();
});

test('envio visto pela 1ª vez já recebido há muito tempo não gera aviso, mas conta na numeração', () => {
  const db = banco();
  let r = sacas.registrar(db, [{ numero: '111', status: 'recebido', dia: DIA, entregar: 1, extra: 0, recebidoEm: ISO('06:00') }], { agora: T('11:00') });
  assert.equal(r.novosAvisos, 0);
  r = sacas.registrar(db, [{ numero: '222', status: 'recebido', dia: DIA, entregar: 2, extra: 0, recebidoEm: ISO('10:30') }], { agora: T('11:00') });
  assert.equal(r.novosAvisos, 1);
  assert.equal(avisos(db, T('11:00'))[0].onda, 'M2');
  db.close();
});

test('recebido sem número na lista é ligado ao envio a caminho com as mesmas sacas', () => {
  const db = banco();
  sacas.registrar(db, [
    { numero: '078', status: 'a_caminho', dia: DIA, sacas: 5, entregar: 1, extra: 4 },
    { numero: '095', status: 'a_caminho', dia: DIA, sacas: 6, entregar: 0, extra: 6 }
  ], { agora: T('06:30') });
  const r = sacas.registrar(db, [
    { numero: null, status: 'recebido', dia: DIA, sacas: 6 },
    { numero: '078', status: 'a_caminho', dia: DIA, sacas: 5 }
  ], { agora: T('07:00') });
  assert.equal(r.novosAvisos, 1);
  const e = sacas.resumo(db, { agora: T('07:00') }).envios.find((x) => x.numero === '095');
  assert.equal(e.status, 'recebido');
  assert.deepEqual(e.ondas, { nex: 'M1' });
  db.close();
});

test('aviso de "a caminho" só quando ligado, um por grupo', () => {
  const db = banco();
  let r = sacas.registrar(db, [{ numero: '078', status: 'a_caminho', dia: DIA, entregar: 1, extra: 4 }], { agora: T('06:30') });
  assert.equal(r.novosAvisos, 0);
  sacas.salvarConfig(db, { avisoCaminho: true });
  r = sacas.registrar(db, [{ numero: '095', status: 'a_caminho', dia: DIA, entregar: 0, extra: 6, caminhoEm: ISO('06:40') }], { agora: T('06:41') });
  assert.equal(r.novosAvisos, 1);
  assert.match(avisos(db, T('06:41'))[0].texto, /NEXT — SACAS A CAMINHO/);
  db.close();
});

test('chegando juntos na mesma leitura, conta primeiro quem saiu primeiro', () => {
  const db = banco();
  const lista = (st) => [
    { numero: '095', status: st, dia: DIA, entregar: 0, extra: 6, caminhoEm: ISO('08:14') },
    { numero: '078', status: st, dia: DIA, entregar: 1, extra: 4, caminhoEm: ISO('06:24') }
  ];
  sacas.registrar(db, lista('a_caminho'), { agora: T('08:20') });
  sacas.registrar(db, lista('recebido'), { agora: T('09:00') });
  const ondas = Object.fromEntries(sacas.resumo(db, { agora: T('09:00') }).envios.map((e) => [e.numero, e.ondas.nex]));
  assert.deepEqual(ondas, { '078': 'M1', '095': 'M2' });
  db.close();
});

test('texto da mensagem de cada grupo', () => {
  const e = {
    numero: '078', recebidoEm: ISO('07:10'), sacas: 5, entregar: 1, extra: 4, paradas: 49, pacotes: 69,
    zonas: [{ nome: 'zona 01', paradas: 2, pacotes: 3 }, { nome: 'Sem zona', paradas: 12, pacotes: 14 }]
  };
  assert.equal(sacas.montarTexto(e, 'chegada', 'delivery', { zonas: true }, 'M1'), [
    '📦 *DELIVERY — SACAS CHEGARAM (M1)*',
    'Envio #078 · recebido às 07:10',
    '',
    '🛵 1 saca · 69 pacotes · 49 paradas',
    '• Zona 01: 3 pacotes (2 paradas)',
    '• Sem zona: 14 pacotes (12 paradas)'
  ].join('\n'));
  assert.equal(sacas.montarTexto(e, 'chegada', 'nex', { zonas: true }, 'M1'), [
    '⚡ *NEXT — SACAS CHEGARAM (M1)*',
    'Envio #078 · recebido às 07:10',
    '',
    '⚡ 4 sacas de Mercado Envios Extra'
  ].join('\n'));
});

// ---------- rotas ----------
let server; let base; let db; let cookie = ''; let chave = '';
before(async () => {
  db = openDb(':memory:');
  const config = {
    ROOT: path.resolve(__dirname, '..'), ADMIN_USER: 'adm', ADMIN_PASSWORD_HASH: bcrypt.hashSync('senha-teste-123', 4),
    SESSION_HOURS: 1, COOKIE_SECURE: false, TRUST_PROXY: false, INBOX_DIR: '/tmp/nada', INBOX_INTERVAL_MINUTES: 0,
    PUBLIC_RATE_PER_MINUTE: 1000, MAX_UPLOAD_MB: 5
  };
  await new Promise((r) => { server = createApp({ config, db }).listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/admin/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ usuario: 'adm', senha: 'senha-teste-123' })
  });
  cookie = login.headers.get('set-cookie').split(';')[0];
  const k = await fetch(`${base}/admin/api/extensao/chave`, { method: 'POST', headers: { Cookie: cookie, Origin: base } });
  chave = (await k.json()).chave;
});
after(() => { server.close(); db.close(); });

test('rotas: extensão envia, painel liga, n8n pega e confirma', async () => {
  const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${chave}` };
  const adm = { 'Content-Type': 'application/json', Cookie: cookie, Origin: base };
  assert.equal((await fetch(`${base}/api/extensao/sacas`, { method: 'POST', headers: { ...auth, Authorization: 'Bearer errada' }, body: '{"envios":[]}' })).status, 401);
  await fetch(`${base}/admin/api/sacas/config`, { method: 'PUT', headers: adm, body: JSON.stringify({ ativo: true }) });
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bahia' }).format(new Date());
  await fetch(`${base}/api/extensao/sacas`, { method: 'POST', headers: auth, body: JSON.stringify({ envios: [{ numero: '078', status: 'a_caminho', dia: hoje, sacas: 5 }] }) });
  const r = await fetch(`${base}/api/extensao/sacas`, { method: 'POST', headers: auth, body: JSON.stringify({ envios: [{ numero: '078', status: 'recebido', dia: hoje, sacas: 1, entregar: 1, extra: 0 }] }) });
  assert.equal((await r.json()).novosAvisos, 1);
  const p = await fetch(`${base}/api/sacas/proximo`, { method: 'POST', headers: auth });
  const aviso = await p.json();
  assert.equal(aviso.grupo, 'delivery');
  assert.match(aviso.texto, /DELIVERY — SACAS CHEGARAM \(M1\)/);
  assert.equal((await fetch(`${base}/api/sacas/proximo`, { method: 'POST', headers: auth })).status, 204);
  const c = await fetch(`${base}/api/sacas/avisos/${aviso.id}/resultado`, { method: 'POST', headers: auth, body: JSON.stringify({ ok: true }) });
  assert.equal((await c.json()).situacao, 'enviado');
  const painel = await (await fetch(`${base}/admin/api/sacas`, { headers: adm })).json();
  assert.equal(painel.avisos[0].situacao, 'enviado');
});
