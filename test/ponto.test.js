'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');

async function subir(extra) {
  const config = {
    ROOT: path.resolve(__dirname, '..'), ADMIN_USER: 'admin-teste', ADMIN_PASSWORD_HASH: bcrypt.hashSync('senha-teste-1', 4),
    SESSION_HOURS: 1, COOKIE_SECURE: false, TRUST_PROXY: false, INBOX_DIR: path.join(__dirname, 'nao-existe'),
    INBOX_INTERVAL_MINUTES: 0, PUBLIC_RATE_PER_MINUTE: 1000, MAX_UPLOAD_MB: 5, ...extra
  };
  const app = createApp({ config, db: openDb(':memory:') });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
async function entrar(base) {
  const r = await fetch(`${base}/admin/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ usuario: 'admin-teste', senha: 'senha-teste-1' }) });
  return r.headers.get('set-cookie').split(';')[0];
}

test('Ponto: acesso automático só para quem entrou no painel', async () => {
  const { server, base } = await subir({ PONTO_EMAIL: 'ponto@teste.local', PONTO_SENHA: 'valor-de-teste' });
  try {
    assert.equal((await fetch(`${base}/admin/api/ponto/acesso`)).status, 401);
    const cookie = await entrar(base);
    const r = await fetch(`${base}/admin/api/ponto/acesso`, { headers: { Cookie: cookie, Origin: base } });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).email, 'ponto@teste.local');
    const pg = await fetch(`${base}/admin/ponto/`);
    assert.equal(pg.status, 200);
    assert.match(pg.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  } finally { server.close(); }
});

test('Ponto: sem acesso configurado, a aba pede o login normal', async () => {
  const { server, base } = await subir({});
  try {
    const cookie = await entrar(base);
    assert.equal((await fetch(`${base}/admin/api/ponto/acesso`, { headers: { Cookie: cookie, Origin: base } })).status, 404);
  } finally { server.close(); }
});
