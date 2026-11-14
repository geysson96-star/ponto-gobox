'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { criar } = require('../src/ponto-acesso');

test('com a chave de serviço, entrega token assinado e nunca a senha', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const conta = JSON.stringify({ client_email: 'svc@exemplo.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  const fetchFn = async () => ({ ok: true, json: async () => ({ localId: 'uid-admin' }) });
  const a = criar({ config: { PONTO_EMAIL: 'p@x.com', PONTO_SENHA: 'segredo', FIREBASE_API_KEY: 'k', FIREBASE_CONTA_SERVICO: conta }, fetchFn });
  const r = await a.acesso();
  assert.ok(r.token && !r.senha);
  const [h, c, s] = r.token.split('.');
  assert.ok(crypto.createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s, 'base64url')));
  const corpo = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.equal(corpo.uid, 'uid-admin');
  assert.ok(corpo.exp - corpo.iat <= 3600);
});

test('sem a chave, continua funcionando como antes', async () => {
  const a = criar({ config: { PONTO_EMAIL: 'p@x.com', PONTO_SENHA: 'segredo' } });
  assert.equal(a.seguro, false);
  assert.deepEqual(await a.acesso(), { email: 'p@x.com', senha: 'segredo' });
});
