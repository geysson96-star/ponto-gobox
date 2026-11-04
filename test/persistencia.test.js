'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const f = require('../src/financeiro');
const { criar } = require('../src/persistencia');

// Firestore falso, em memória, com o mesmo formato da API REST.
function firestoreFalso() {
  const docs = new Map();
  let gravacoes = 0;
  const fetchFn = async (url, op = {}) => {
    const resp = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (url.includes('signInWithPassword')) return resp(200, { idToken: 'tk', expiresIn: '3600' });
    const id = decodeURIComponent(url.split('/documents/consulta/')[1]);
    if (op.method === 'PATCH') { docs.set(id, JSON.parse(op.body)); gravacoes += 1; return resp(200, {}); }
    if (op.method === 'DELETE') { docs.delete(id); return resp(200, {}); }
    return docs.has(id) ? resp(200, docs.get(id)) : resp(404, {});
  };
  return { fetchFn, docs, gravacoes: () => gravacoes };
}
const cfg = { PONTO_EMAIL: 'a@b.c', PONTO_SENHA: 'x', FIREBASE_API_KEY: 'k', FIREBASE_PROJETO: 'p', RETENCAO_DIAS: 60 };
const silencio = { warn() {}, log() {} };

test('Persistência: salva e restaura pacotes, financeiro e sessões; não grava sem mudança', async () => {
  const fs = firestoreFalso();
  const db1 = openDb(':memory:');
  const ins = db1.prepare(`INSERT INTO packages (source, code, external_id, active, first_seen_at, last_updated_at, situacao, rotulo, tipo, recebido_em, saida_em, volume)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const agora = new Date().toISOString();
  ins.run('shopee', 'BR1', 'SPX1', 1, agora, agora, 'na_agencia', 'Na agência', 'drop_off', agora, null, null);
  ins.run('shopee', 'SPX1', 'SPX1', 1, agora, agora, 'na_agencia', 'Na agência', 'drop_off', agora, null, null);
  ins.run('ml', 'ML1', null, 1, agora, agora, 'na_agencia', 'Disponível para retirada', 'retirada', agora, null, 'shipment');
  const velho = new Date(Date.now() - 90 * 86400_000).toISOString();
  ins.run('ml', 'ML-VELHO', null, 0, velho, velho, 'saiu', 'Retirado', 'retirada', velho, velho, 'shipment');
  db1.prepare("INSERT INTO imports (source, origin, status, started_at, finished_at) VALUES ('shopee','extensao','sucesso',?,?)").run(agora, agora);
  f.salvarTotaisShopee(db1, { mes: '2026-11', expedidos: 4565, retiradas: 97, recebidos: 8783, retiradasRecebidas: 113 });
  f.salvarMedalha(db1, '2026-11', { medalha: 'ouro' });
  db1.prepare("INSERT INTO sessions (token_hash, created_at, expires_at) VALUES ('h1', ?, ?)").run(agora, new Date(Date.now() + 3600e3).toISOString());

  const p1 = criar({ db: db1, config: cfg, fetchFn: fs.fetchFn, log: silencio });
  for (const a of ['shopee', 'ml', 'estado']) await p1.salvarAgora(a);
  const n = fs.gravacoes();
  await p1.salvarAgora('shopee'); // nada mudou: não grava
  assert.equal(fs.gravacoes(), n);
  assert.equal(db1.prepare("SELECT COUNT(*) n FROM packages WHERE code = 'ML-VELHO'").get().n, 0); // retenção

  const db2 = openDb(':memory:');
  const p2 = criar({ db: db2, config: cfg, fetchFn: fs.fetchFn, log: silencio });
  const r = await p2.restaurar();
  assert.deepEqual(r.pacotes, { shopee: 2, ml: 1 });
  assert.equal(r.estado, true);
  const ml = db2.prepare("SELECT * FROM packages WHERE code = 'ML1'").get();
  assert.equal(ml.tipo, 'retirada'); assert.equal(ml.volume, 'shipment'); assert.equal(ml.rotulo, 'Disponível para retirada');
  const res = f.resumo(db2, '2026-11');
  assert.equal(res.quantidades.shopee.expedidos, 4565);
  assert.equal(res.shopee.medalha, 'ouro');
  assert.equal(db2.prepare("SELECT COUNT(*) n FROM sessions").get().n, 1);
  // status da fonte volta como atualizado
  const { allSourceStatus } = require('../src/db');
  assert.equal(allSourceStatus(db2).find((s) => s.id === 'shopee').state, 'atualizado');
});

test('Persistência: 10.000 pacotes cabem em poucos documentos', async () => {
  const fs = firestoreFalso();
  const db = openDb(':memory:');
  const ins = db.prepare(`INSERT INTO packages (source, code, external_id, active, first_seen_at, last_updated_at, situacao, rotulo, tipo, recebido_em, saida_em)
                          VALUES ('shopee', ?, ?, 1, ?, ?, 'na_agencia', 'Na agência, aguardando coleta da Shopee', 'drop_off', ?, NULL)`);
  const base = Date.now();
  db.transaction(() => { for (let i = 0; i < 10000; i += 1) { const t = new Date(base - i * 60000).toISOString(); ins.run(`BR${String(2600000000 + i * 7919)}`, `SPXBR${50000000000 + i * 13}`, t, t, t); } })();
  const p = criar({ db, config: cfg, fetchFn: fs.fetchFn, log: silencio });
  await p.salvarAgora('shopee');
  const tamanho = [...fs.docs.entries()].filter(([k]) => k.startsWith('pacotes_shopee~')).reduce((s, [, d]) => s + d.fields.dados.stringValue.length, 0);
  console.log(`# 10.000 pacotes = ${(tamanho / 1024).toFixed(0)} KB no Firebase, ${fs.docs.size} documentos`);
  assert.ok(tamanho < 900_000 * 2);
});

test('Persistência: desligada sem o acesso do ponto', () => {
  const p = criar({ db: openDb(':memory:'), config: { FIREBASE_API_KEY: 'k', FIREBASE_PROJETO: 'p' }, fetchFn: async () => { throw new Error('não deveria chamar'); } });
  assert.equal(p.ativo, false);
});
