'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');

let server; let base; let db; let cookie = '';
before(async () => {
  db = openDb(':memory:');
  const config = {
    ROOT: path.resolve(__dirname, '..'), ADMIN_USER: 'adm', ADMIN_PASSWORD_HASH: bcrypt.hashSync('senha-teste-123', 4),
    SESSION_HOURS: 1, COOKIE_SECURE: false, TRUST_PROXY: false, INBOX_DIR: '/tmp/nada', INBOX_INTERVAL_MINUTES: 0,
    PUBLIC_RATE_PER_MINUTE: 1000, MAX_UPLOAD_MB: 5, PONTO_EMAIL: 'ponto@exemplo.com', PONTO_SENHA: 'senha-ponto-teste'
  };
  await new Promise((r) => { server = createApp({ config, db }).listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/admin/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ usuario: 'adm', senha: 'senha-teste-123' })
  });
  cookie = login.headers.get('set-cookie').split(';')[0];
});
after(() => { server.close(); db.close(); });

const adm = (p, o = {}) => fetch(`${base}/admin/api${p}`, { ...o, headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json', ...(o.headers || {}) } });
const cadastro = { lgpd: true, nome: 'Fulano de Tal', whatsapp: '(79) 99999-0000', servicos: ['ml'], horarios: ['Seg-Manhã'], funcao: 'entregador', experiencia: 'Sim, mais de 1 ano' };

test('telas do Ponto e da Folha exigem a sessão do painel', async () => {
  const r = await fetch(`${base}/admin/ponto/`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal((await fetch(`${base}/admin/contabilidade/contabilidade.js`)).status, 401);
  assert.equal((await fetch(`${base}/admin/contabilidade/`, { headers: { Cookie: cookie } })).status, 200);
});

test('acesso do Ponto só com sessão', async () => {
  assert.equal((await fetch(`${base}/admin/api/ponto/acesso`)).status, 401);
  assert.equal((await adm('/ponto/acesso')).status, 200);
});

test('cadastro público de entregador: valida, grava e não mostra valores', async () => {
  const cfg = await (await fetch(`${base}/api/entregadores/config`)).json();
  assert.ok(cfg.servicos.length);
  assert.ok(cfg.servicos.every((s) => !('valor' in s)));
  const ruim = await fetch(`${base}/api/entregadores`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...cadastro, lgpd: false }) });
  assert.equal(ruim.status, 400);
  const ok = await fetch(`${base}/api/entregadores`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cadastro) });
  assert.equal(ok.status, 200);
  // mesmo WhatsApp não duplica
  await fetch(`${base}/api/entregadores`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...cadastro, nome: 'Fulano T.' }) });
  const r = await (await adm('/entregadores')).json();
  assert.equal(r.cadastros.length, 1);
  assert.equal(r.cadastros[0].whatsapp, '79999990000');
  assert.equal(r.contagem.pendente, 1);
});

test('painel aceita, dá nota e exclui entregador', async () => {
  const { cadastros } = await (await adm('/entregadores')).json();
  const id = cadastros[0].id;
  const a = await (await adm(`/entregadores/${id}`, { method: 'PUT', body: JSON.stringify({ situacao: 'aprovado', nota: 4 }) })).json();
  assert.equal(a.cadastro.situacao, 'aprovado');
  assert.equal(a.cadastro.nota, 4);
  assert.equal((await adm(`/entregadores/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await (await adm('/entregadores')).json()).cadastros.length, 0);
});

test('ajustes do site: aviso, abas e manutenção', async () => {
  const pub0 = await (await fetch(`${base}/api/site`)).json();
  assert.equal(pub0.aviso, null);
  await adm('/site', { method: 'PUT', body: JSON.stringify({ aviso: { ativo: true, texto: 'Feriado amanhã' }, abas: { frete: false, entregador: false } }) });
  const pub = await (await fetch(`${base}/api/site`)).json();
  assert.equal(pub.aviso, 'Feriado amanhã');
  assert.equal((await fetch(`${base}/frete`, { redirect: 'manual' })).status, 302);
  const pausado = await fetch(`${base}/api/entregadores`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cadastro) });
  assert.equal(pausado.status, 403);
  await adm('/site', { method: 'PUT', body: JSON.stringify({ manutencao: true }) });
  assert.match(await (await fetch(`${base}/`)).text(), /Voltamos em instantes/);
  assert.equal((await fetch(`${base}/admin/`)).status, 200);
  await adm('/site', { method: 'PUT', body: JSON.stringify({ manutencao: false, abas: { frete: true, entregador: true } }) });
});

test('visão geral responde com o resumo do dia', async () => {
  const d = await (await adm('/visao-geral')).json();
  assert.equal(typeof d.pacotes.total, 'number');
  assert.ok(Array.isArray(d.fontes));
  assert.ok('pendente' in d.entregadores);
});

test('páginas saem compactadas e imagens com cache longo', async () => {
  const r = await fetch(`${base}/admin/admin.js`, { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(r.headers.get('content-encoding'), 'gzip');
  const img = await fetch(`${base}/assets/cubo.webp`);
  assert.match(img.headers.get('cache-control'), /max-age=2592000/);
});
