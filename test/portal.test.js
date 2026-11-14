'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const extensao = require('../src/extensao');
const portal = require('../src/portal');

const SENHA = 'senha-de-teste-123';
let server, base, db, cookie = '', chave;
const C1 = 'BR261234567890A', C2 = 'BR261234567891B', C3 = 'BR261234567892C';

before(async () => {
  db = openDb(':memory:');
  const config = {
    ROOT: path.resolve(__dirname, '..'), ADMIN_USER: 'adm', ADMIN_PASSWORD_HASH: bcrypt.hashSync(SENHA, 4),
    SESSION_HOURS: 1, COOKIE_SECURE: false, TRUST_PROXY: false, INBOX_DIR: '/tmp/nada', INBOX_INTERVAL_MINUTES: 0,
    PUBLIC_RATE_PER_MINUTE: 1000, MAX_UPLOAD_MB: 5
  };
  server = await new Promise((ok) => { const s = createApp({ config, db }).listen(0, () => ok(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  chave = extensao.gerarChave(db);
});
after(() => { server.close(); db.close(); });

async function req(method, p, { body, headers = {} } = {}) {
  const h = { Origin: base, ...headers };
  if (cookie) h.Cookie = cookie;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await res.text(); let json = null; try { json = JSON.parse(t); } catch {}
  return { res, json, text: t };
}

test('fluxo completo: cliente com link, sobe etiquetas, extensão sobe no SPX, bipagem dá baixa', async () => {
  let r = await req('POST', '/admin/api/login', { body: { usuario: 'adm', senha: SENHA } });
  if (r.res.status !== 200) r = await req('POST', '/admin/api/login', { body: { user: 'adm', password: SENHA } });
  assert.equal(r.res.status, 200, r.text);
  cookie = r.res.headers.get('set-cookie').split(';')[0];

  // sem login, não cria cliente
  const semLogin = await fetch(base + '/admin/api/portal/clientes', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{"nome":"x","lojas":["x"]}' });
  assert.equal(semLogin.status, 401);

  r = await req('POST', '/admin/api/portal/clientes', { body: { nome: 'Anthony' } });
  assert.equal(r.res.status, 200, r.text);
  const cli = r.json.cliente;
  assert.ok(cli.token.length >= 20);

  // link inválido
  const inv = await fetch(`${base}/api/portal/token-que-nao-existe-123`);
  assert.equal(inv.status, 404);
  const pagina = await fetch(`${base}/c/${cli.token}`);
  assert.equal(pagina.status, 200);

  // cliente sobe: 2 do PDF (remetente lido) e 1 digitado
  r = await req('POST', `/api/portal/${cli.token}/etiquetas`, { body: { origem: 'pdf', pacotes: [{ codigo: C1, loja: 'LOJA DO ANTHONY' }, { codigo: C2, loja: 'ANTHONY KIDS' }, { codigo: C1, loja: 'x' }, { codigo: 'XX1', loja: '' }] } });
  assert.equal(r.res.status, 200, r.text);
  assert.equal(r.json.novos, 2);
  r = await req('POST', `/api/portal/${cli.token}/etiquetas`, { body: { origem: 'digitado', pacotes: [{ codigo: C3.toLowerCase(), loja: 'Anthony Kids' }, { codigo: C1, loja: '' }] } });
  assert.equal(r.json.novos, 1);
  assert.equal(r.json.jaSubidos, 1);

  r = await req('GET', `/api/portal/${cli.token}`);
  assert.equal(r.json.totais.subidos, 3);
  assert.equal(r.json.totais.faltam, 3);
  // lojas saem do remetente; o mesmo nome com outra grafia entra na mesma loja
  assert.deepEqual(r.json.lojas.map((l) => [l.loja, l.subidos]), [['ANTHONY KIDS', 2], ['LOJA DO ANTHONY', 1]]);
  assert.deepEqual(r.json.lojasConhecidas.sort(), ['ANTHONY KIDS', 'LOJA DO ANTHONY']);

  // extensão: sem chave não entra
  assert.equal((await fetch(`${base}/api/extensao/portal/fila`)).status, 401);
  const H = { Authorization: `Bearer ${chave}` };
  r = await req('GET', '/api/extensao/portal/fila', { headers: H });
  assert.equal(r.json.lotes.length, 2);
  r = await req('POST', '/api/extensao/portal/reservar', { headers: H, body: {} });
  assert.equal(r.json.cliente, 'Anthony');
  assert.deepEqual(r.json.codigos.sort(), [C1, C2].sort());
  r = await req('POST', `/api/extensao/portal/lotes/${r.json.id}/resultado`, { headers: H, body: { ok: [C1], erros: [{ codigo: C2, erro: 'não encontrado' }] } });
  assert.deepEqual(r.json, { subidos: 1, comErro: 1 });

  // cliente não pode tirar o que já está no SPX
  r = await req('DELETE', `/api/portal/${cli.token}/etiquetas/${C1}`);
  assert.equal(r.res.status, 400);

  // bipagem no painel
  r = await req('POST', '/admin/api/portal/bipar', { body: { codigo: C1 } });
  assert.equal(r.json.situacao, 'baixa');
  assert.equal(r.json.faltam, 2);
  r = await req('POST', '/admin/api/portal/bipar', { body: { codigo: C1 } });
  assert.equal(r.json.situacao, 'ja_bipado');
  r = await req('POST', '/admin/api/portal/bipar', { body: { codigo: 'BR999999999999Z' } });
  assert.equal(r.json.situacao, 'desconhecido');

  r = await req('GET', `/api/portal/${cli.token}`);
  assert.equal(r.json.totais.entregues, 1);
  assert.equal(r.json.totais.faltam, 2);

  // erro do SPX volta para a fila
  r = await req('POST', '/admin/api/portal/tentar-de-novo', { body: {} });
  assert.equal(r.json.reenviados, 1);

  // link novo: o antigo para de funcionar
  r = await req('POST', `/admin/api/portal/clientes/${cli.id}/link`);
  assert.equal((await fetch(`${base}/api/portal/${cli.token}`)).status, 404);
  const novo = r.json.cliente.token;
  assert.equal((await fetch(`${base}/api/portal/${novo}`)).status, 200);

  // excluir cliente
  r = await req('DELETE', `/admin/api/portal/clientes/${cli.id}`);
  assert.equal(r.res.status, 200);
  assert.equal((await fetch(`${base}/api/portal/${novo}`)).status, 404);
  assert.equal(portal.resumo(db).pacotes.length, 0);
});

test('outro site não consegue subir etiquetas pelo link do cliente', async () => {
  const c = portal.criarCliente(db, { nome: 'Teste' });
  const r = await fetch(`${base}/api/portal/${c.token}/etiquetas`, { method: 'POST', headers: { Origin: 'https://malicioso.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ pacotes: [{ codigo: C1 }] }) });
  assert.equal(r.status, 403);
});
