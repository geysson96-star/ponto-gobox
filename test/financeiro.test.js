'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const f = require('../src/financeiro');

test('Financeiro: Shopee confere com a planilha e as faixas', () => {
  // Exemplo da planilha: 113 retiradas e 87 devoluções, sem expedidos, Bronze = R$ 148,70.
  assert.equal(f.calcularShopee({ expedidos: 0, retiradas: 113, devolucoes: 87 }, f.MEDALHAS_PADRAO.bronze).total, 148.7);
  // 810 expedidos - 87 devoluções = 723: 500 x 0,70 + 223 x 0,60.
  assert.equal(Math.round(f.porFaixas(723) * 100) / 100, 483.8);
  assert.equal(f.valorDoPacote(500), 0.7);
  assert.equal(f.valorDoPacote(501), 0.6);
  assert.equal(f.calcularShopee({ expedidos: 810, retiradas: 113, devolucoes: 87 }, f.MEDALHAS_PADRAO.ouro).total, 895.15);
});

test('Financeiro: Mercado Livre confere com a tela de 1 a 15/11', () => {
  assert.equal(f.calcularMlQuinzena({ delivery: 227, pickup: 116, falhas: 4, nex: 7 }).total, 738.2);
});

test('Financeiro: conta por mês e quinzena, sem dobrar códigos do mesmo pacote, com ajustes', () => {
  const db = openDb(':memory:');
  const ins = db.prepare(`INSERT INTO packages (source, code, external_id, active, first_seen_at, last_updated_at, tipo, recebido_em)
                          VALUES (?, ?, ?, 1, ?, ?, ?, ?)`);
  const t = '2026-11-04T12:00:00.000Z';
  ins.run('shopee', 'BR111', 'SPX1', t, t, 'drop_off', '2026-11-02T10:00:00.000Z');
  ins.run('shopee', 'SPX1', 'SPX1', t, t, 'drop_off', '2026-11-02T10:00:00.000Z'); // mesmo pacote, outro código
  ins.run('shopee', 'BR222', null, t, t, 'retirada', '2026-11-03T10:00:00.000Z');
  ins.run('shopee', 'BR333', null, t, t, 'drop_off', '2026-10-31T10:00:00.000Z'); // outubro
  ins.run('ml', 'ML1', null, t, t, 'envio', '2026-11-10T10:00:00.000Z');
  ins.run('ml', 'ML2', null, t, t, 'retirada', '2026-11-20T10:00:00.000Z');
  ins.run('ml', 'ML3', null, t, t, 'envio', '2026-11-16T02:30:00.000Z'); // 15/11 23:30 na Bahia: 1ª quinzena
  ins.run('correios', 'XX1', null, t, t, 'envio', '2026-11-05T10:00:00.000Z');

  let r = f.resumo(db, '2026-11');
  assert.equal(r.quantidades.shopee.expedidos, 1);
  assert.equal(r.quantidades.shopee.retiradas, 1);
  assert.equal(r.quantidades.ml.q1.delivery, 2);
  assert.equal(r.quantidades.ml.q2.pickup, 1);
  assert.equal(r.quantidades.correios.pacotes, 1);
  assert.equal(r.total, 8.45); // 0,70 + 0,70 + 2 x 2,60 + 0,65 + 1,20

  f.salvarAjustes(db, '2026-11', { shopee: { devolucoes: 2 }, ml: { q1: { nex: 1 } } });
  f.salvarMedalha(db, '2026-11', { medalha: 'prata' });
  r = f.resumo(db, '2026-11');
  assert.equal(r.quantidades.shopee.devolucoes, 2);
  assert.equal(r.ml.q1.itens.nex, 10);
  assert.equal(r.shopee.medalha, 'prata');
  assert.ok(r.shopee.total > 150);
  assert.equal(f.resumo(db, '2026-10').quantidades.shopee.expedidos, 1);
  assert.throws(() => f.resumo(db, '2026-13'));
});
