'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const f = require('../src/fretes');

const pedido = (x = {}) => ({ uf: 'SP', tipo: 'C', peso: 2, valor: 200, ...x });

test('Fretes: conta do E-commerce para SP capital (2 kg, R$ 200, margem 10%, transporte R$ 5)', () => {
  const db = openDb(':memory:');
  const c = f.calcular(db, 'eco', f.validarPedido(pedido()));
  assert.equal(c.frete, 26.84);
  assert.equal(c.seguro, 0.8);
  assert.equal(c.custo, 32.64);
  assert.equal(c.preco, 35.9);
  assert.equal(c.lucro, 3.26);
});

test('Fretes: margem e transporte do painel mudam o preço', () => {
  const db = openDb(':memory:');
  f.salvarConfig(db, { margem: 20, transporte: 8 });
  const c = f.calcular(db, 'eco', f.validarPedido(pedido()));
  assert.equal(c.custo, 35.64);
  assert.equal(c.preco, 42.9); // 42,77 → ,90 mais próximo
  assert.throws(() => f.salvarConfig(db, { margem: -1 }), /margem/);
});

test('Fretes: peso cubado, faixa acima de 30 kg, Premium só capital e Standard com mínimo', () => {
  const db = openDb(':memory:');
  const cub = f.validarPedido(pedido({ peso: 1, altura: 30, largura: 30, comprimento: 30 }));
  assert.equal(f.pesoConsiderado(cub).cobrado, 4.5);
  assert.equal(f.calcular(db, 'eco', cub).faixa, 'até 4,5 kg');
  const pesado = f.calcular(db, 'eco', f.validarPedido(pedido({ peso: 32.4 })));
  assert.equal(pesado.faixa, '30 kg + 3 kg extra');
  assert.equal(pesado.frete, Math.round((127.7 + 3 * 4.14) * 100) / 100);
  assert.match(f.calcular(db, 'pre', f.validarPedido(pedido({ tipo: 'I' }))).indisponivel, /capitais/);
  const std = f.calcular(db, 'std', f.validarPedido(pedido()));
  assert.equal(std.faixa, 'mínimo de 30 kg');
  assert.equal(std.base, 'CDSP2'); // base da capital
});

test('Fretes: cliente não recebe custo nem margem', () => {
  const db = openDb(':memory:');
  const r = f.cotar(db, pedido());
  const txt = JSON.stringify(r);
  assert.ok(!/custo|margem|lucro|transporte"/.test(txt));
  assert.equal(r.opcoes.find((o) => o.id === 'eco').preco, 35.9);
  assert.throws(() => f.cotar(db, { uf: 'XX', peso: 1 }), /estado/);
});

let server; let base; let db;
before(async () => {
  db = openDb(':memory:');
  const app = createApp({
    config: { ROOT: path.resolve(__dirname, '..'), ADMIN_USER: 'a', ADMIN_PASSWORD_HASH: bcrypt.hashSync('x', 4), SESSION_HOURS: 1, COOKIE_SECURE: false, TRUST_PROXY: false, INBOX_INTERVAL_MINUTES: 0, PUBLIC_RATE_PER_MINUTE: 1000, MAX_UPLOAD_MB: 20 },
    db
  });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('Fretes: rotas públicas e painel protegido', async () => {
  const post = (u, b) => fetch(base + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  const r = await (await post('/api/fretes/cotar', pedido())).json();
  assert.equal(r.opcoes.length, 4);
  const c = await (await post('/api/fretes/contratar', { ...pedido(), servico: 'exp' })).json();
  assert.match(c.mensagem, /Expresso/);
  assert.equal(f.resumo(db).cotacoes.length, 1);
  assert.equal((await fetch(base + '/admin/api/fretes')).status, 401);
  assert.equal((await fetch(base + '/frete')).status, 200);
});
