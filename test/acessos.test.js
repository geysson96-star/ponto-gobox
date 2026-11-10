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
    PUBLIC_RATE_PER_MINUTE: 1000, MAX_UPLOAD_MB: 5
  };
  await new Promise((r) => { server = createApp({ config, db }).listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/admin/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ usuario: 'adm', senha: 'senha-teste-123' })
  });
  cookie = login.headers.get('set-cookie').split(';')[0];
});
after(() => { server.close(); db.close(); });

const visitar = (ua) => fetch(`${base}/api/visita`, { method: 'POST', headers: { 'User-Agent': ua } });
const pesquisar = (codigo, ua) => fetch(`${base}/api/consulta`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': ua }, body: JSON.stringify({ codigo })
});

test('resumo de acessos exige login', async () => {
  assert.equal((await fetch(`${base}/admin/api/acessos`)).status, 401);
});

test('conta visitas, pesquisas e pessoas sem guardar dados do visitante', async () => {
  assert.equal((await visitar('Navegador-A')).status, 204);
  await visitar('Navegador-A');
  await visitar('Navegador-B');
  await pesquisar('BR000NAOEXISTE1', 'Navegador-A');
  const d = await (await fetch(`${base}/admin/api/acessos`, { headers: { Cookie: cookie } })).json();
  assert.equal(d.hoje.visitas, 3);
  assert.equal(d.hoje.visitantes, 2);
  assert.equal(d.hoje.consultas, 1);
  assert.equal(d.hoje.encontrados, 0);
  assert.equal(d.total.visitas, 3);
  assert.equal(d.dias.length, 1);
  // Nada de IP, navegador ou código pesquisado no banco.
  const tudo = JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
    .map(({ name }) => db.prepare(`SELECT * FROM ${name}`).all()));
  for (const proibido of ['Navegador-A', '127.0.0.1', 'BR000NAOEXISTE1']) assert.ok(!tudo.includes(proibido), proibido);
});
