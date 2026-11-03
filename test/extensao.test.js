'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');

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
});
after(() => { server.close(); db.close(); });

const enviar = (corpo, token = chave) => fetch(`${base}/api/extensao/sincronizar`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(corpo)
});
const consultar = async (codigo) => (await (await fetch(`${base}/api/consulta`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codigo })
})).json()).encontrado;

test('sem chave a extensão é recusada', async () => {
  assert.equal((await enviar({ fonte: 'ml', codigos: ['1'] }, 'chave-errada')).status, 401);
});

test('admin gera chave (mostrada uma vez, guardada só como hash)', async () => {
  const r = await fetch(`${base}/admin/api/extensao/chave`, { method: 'POST', headers: { Cookie: cookie, Origin: base } });
  chave = (await r.json()).chave;
  assert.match(chave, /^gbx_/);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM settings').all()).includes(chave));
  const st = await fetch(`${base}/api/extensao/status`, { headers: { Authorization: `Bearer ${chave}` } });
  assert.equal(st.status, 200);
});

test('extensão envia códigos e a consulta pública encontra', async () => {
  const r = await (await enviar({ fonte: 'shopee', codigos: [' br260785121040r ', 'BR2607723241431'] })).json();
  assert.equal(r.situacao, 'sucesso');
  assert.equal(r.codigos, 2);
  assert.equal(await consultar('BR260785121040R'), true);
});

test('erro informado pela extensão marca a fonte como falhou sem apagar a consulta', async () => {
  const r = await (await enviar({ fonte: 'shopee', erro: 'Shopee: sessão expirada. Faça login de novo.' })).json();
  assert.equal(r.situacao, 'falhou');
  assert.equal(await consultar('BR260785121040R'), true);
  const f = await (await fetch(`${base}/admin/api/fontes`, { headers: { Cookie: cookie } })).json();
  assert.equal(f.fontes.find((x) => x.id === 'shopee').state, 'falhou');
});

test('lista vazia não apaga a consulta (fica aguardando confirmação)', async () => {
  const r = await (await enviar({ fonte: 'shopee', codigos: [] })).json();
  assert.equal(r.situacao, 'aguardando_confirmacao');
  assert.equal(await consultar('BR2607723241431'), true);
});

test('chave nova invalida a antiga', async () => {
  const antiga = chave;
  const r = await fetch(`${base}/admin/api/extensao/chave`, { method: 'POST', headers: { Cookie: cookie, Origin: base } });
  chave = (await r.json()).chave;
  assert.equal((await enviar({ fonte: 'ml', codigos: ['1'] }, antiga)).status, 401);
  assert.equal((await enviar({ fonte: 'ml', codigos: ['48000000001'] })).status, 200);
});

test('detalhes: Shopee (eventos) mostra situação, recebimento e saída', async () => {
  const r = await (await enviar({
    fonte: 'shopee', modo: 'eventos',
    pacotes: [
      { codigo: 'BRSTATUS001', situacao: 'na_agencia', rotulo: 'Disponível para retirada', tipo: 'retirada', recebidoEm: 1793722133 },
      { codigo: 'BRSTATUS002', situacao: 'retirado', rotulo: 'Retirado pelo comprador', tipo: 'retirada', recebidoEm: 1793722127, saidaEm: 1793729987 },
      { codigo: 'BRSTATUS003', situacao: 'enviado', rotulo: 'Coletado pela Shopee', tipo: 'drop_off', recebidoEm: 1793700000, saidaEm: 1793710000 }
    ]
  })).json();
  assert.equal(r.situacao, 'sucesso');
  const c = async (codigo) => (await fetch(`${base}/api/consulta`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codigo })
  })).json();
  const a = await c('brstatus001');
  assert.equal(a.situacao, 'na_agencia');
  assert.equal(a.tipo, 'retirada');
  assert.equal(a.recebidoEm, new Date(1793722133 * 1000).toISOString());
  assert.equal(a.saidaEm, null);
  const b = await c('BRSTATUS002');
  assert.equal(b.situacao, 'retirado');
  assert.equal(b.saidaEm, new Date(1793729987 * 1000).toISOString());
  assert.equal((await c('BRSTATUS003')).status, 'Coletado pela Shopee');
  // Modo eventos não marca ausentes: o pacote antigo continua como estava.
  assert.equal((await c('BR260785121040R')).encontrado, true);
});

test('detalhes: Mercado Livre (estoque) marca quem sumiu como retirado/coletado', async () => {
  await enviar({ fonte: 'ml', modo: 'estoque', pacotes: [
    { codigo: '48300000001', situacao: 'na_agencia', tipo: 'retirada', rotulo: 'Disponível para retirada', recebidoEm: '2026-10-23T12:58:08.286-03:00' },
    { codigo: '48300000002', situacao: 'na_agencia', tipo: 'envio', rotulo: 'Na agência, aguardando coleta do Mercado Livre' },
    { codigo: '48000000001', situacao: 'na_agencia', tipo: 'envio' },
    { codigo: '48300000003', situacao: 'na_agencia', tipo: 'envio' },
    { codigo: '48300000004', situacao: 'na_agencia', tipo: 'envio' }
  ] });
  // Saíram 2 de 5 (abaixo do limite de proteção de 50%): aplica sozinho.
  await enviar({ fonte: 'ml', modo: 'estoque', pacotes: ['48000000001', '48300000003', '48300000004'].map((codigo) => ({ codigo, situacao: 'na_agencia', tipo: 'envio' })) });
  const c = async (codigo) => (await fetch(`${base}/api/consulta`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codigo })
  })).json();
  const ret = await c('48300000001');
  assert.equal(ret.situacao, 'saiu');
  assert.equal(ret.status, 'Retirado pelo comprador');
  assert.ok(ret.saidaEm);
  assert.equal(ret.recebidoEm, new Date('2026-10-23T12:58:08.286-03:00').toISOString());
  assert.equal((await c('48300000002')).status, 'Coletado pela transportadora');
  assert.equal((await c('48000000001')).situacao, 'na_agencia');
});
