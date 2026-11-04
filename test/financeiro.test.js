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
  const sh = db.prepare(`INSERT INTO packages (source, code, external_id, active, first_seen_at, last_updated_at, tipo, situacao, recebido_em, saida_em)
                         VALUES ('shopee', ?, ?, 1, ?, ?, ?, ?, ?, ?)`);
  // Shopee conta pela SAÍDA no mês.
  sh.run('BR111', 'SPX1', t, t, 'drop_off', 'enviado', '2026-10-30T10:00:00.000Z', '2026-11-02T10:00:00.000Z'); // chegou em outubro, expedido em novembro
  sh.run('SPX1', 'SPX1', t, t, 'drop_off', 'enviado', '2026-10-30T10:00:00.000Z', '2026-11-02T10:00:00.000Z'); // mesmo pacote, outro código
  sh.run('BR444', null, t, t, 'drop_off', 'na_agencia', '2026-11-03T10:00:00.000Z', null); // ainda na agência: não conta
  sh.run('BR222', null, t, t, 'retirada', 'retirado', '2026-11-01T10:00:00.000Z', '2026-11-03T10:00:00.000Z');
  sh.run('BR555', null, t, t, 'retirada', 'na_agencia', '2026-11-02T10:00:00.000Z', null); // aguardando retirada: não conta
  sh.run('BR333', null, t, t, 'drop_off', 'enviado', '2026-10-29T10:00:00.000Z', '2026-10-31T10:00:00.000Z'); // expedido em outubro
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

test('Financeiro: Mercado Livre usa o acumulado oficial e soma o estimado do dia', () => {
  const db = openDb(':memory:');
  f.salvarOficialMl(db, {
    de: '2026-11-01T00:00:00Z', ate: '2026-11-15T00:00:00Z', atualizadoEm: '2026-11-04',
    itens: [{ tipo: 'rtn', quantidade: 4, total: 2.6 }, { tipo: 'nex_car', quantidade: 7, total: 70 },
      { tipo: 'pickup', quantidade: 116, total: 75.4 }, { tipo: 'dc', quantidade: 227, total: 590.2 },
      { tipo: 'total', quantidade: 354, total: 738.2 }]
  });
  const ins = db.prepare(`INSERT INTO packages (source, code, active, first_seen_at, last_updated_at, tipo, volume, recebido_em)
                          VALUES ('ml', ?, 1, ?, ?, ?, ?, ?)`);
  const t = '2026-11-04T12:00:00.000Z';
  ins.run('A1', t, t, 'delivery', 'shipment', '2026-11-04T13:00:00.000Z'); // hoje: estimado
  ins.run('A2', t, t, 'retirada', 'shipment', '2026-11-04T14:00:00.000Z'); // hoje: estimado
  ins.run('A3', t, t, 'delivery', 'bag', '2026-11-04T14:30:00.000Z');      // saca: só controle
  ins.run('A4', t, t, 'nex', 'shipment', '2026-11-04T15:00:00.000Z');      // NEx: pago por rota
  ins.run('A5', t, t, 'delivery', 'shipment', '2026-11-03T20:00:00.000Z'); // ontem: já no oficial
  const r = f.resumo(db, '2026-11');
  const q1 = r.ml.q1;
  assert.equal(q1.fonte, 'oficial');
  assert.equal(q1.estimadoDia.delivery, 1);
  assert.equal(q1.estimadoDia.pickup, 1);
  assert.equal(q1.estimadoDia.sacas, 1);
  assert.equal(q1.estimadoDia.valor, 3.25);
  assert.equal(q1.total, 741.45); // 738,20 + 2,60 + 0,65
  assert.equal(q1.quantidades.delivery, 228);
  assert.equal(r.ml.q2.fonte, 'contagem');
});

test('Financeiro: Shopee usa os totais do portal quando a extensão manda', () => {
  const db = openDb(':memory:');
  f.salvarTotaisShopee(db, { mes: '2026-11', expedidos: 4565, retiradas: 97 });
  const r = f.resumo(db, '2026-11');
  assert.equal(r.quantidades.shopee.expedidos, 4565);
  assert.equal(r.quantidades.shopee.retiradas, 97);
  // 4565: 500x0,70 + 500x0,60 + 3565x0,50 = 2432,50; 97 retiradas x 0,70 = 67,90
  assert.equal(r.shopee.total, 2500.4);
  assert.ok(r.shopee.portal);
  assert.throws(() => f.salvarTotaisShopee(db, { mes: 'x', expedidos: 1, retiradas: 1 }));
});
