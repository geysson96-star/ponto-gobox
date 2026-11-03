'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { lerShopee, lerMercadoLivre, SessaoExpirada } = require('../src/robo/conectores');
const { Robo } = require('../src/robo/robo');

// Respostas simuladas no formato dos portais (dados fictícios).
function shopeeFake({ dropoff = [], collection = [], retcode = 0, pontoAtual = 8 } = {}) {
  const chamadas = [];
  const estado = { ponto: pontoAtual };
  const fn = async (url, opcoes = {}) => {
    chamadas.push(url);
    if (retcode !== 0) return { retcode, message: 'need login' };
    if (url.startsWith('/sp-api/current_user/list_point')) {
      return { retcode: 0, data: { point_list: [{ point_id: 7341, point_name: 'Agência Teste' }, { point_id: 8, point_name: 'Admin' }] } };
    }
    if (url.startsWith('/sp-api/current_user/change_point')) {
      assert.equal(opcoes.method, 'POST');
      estado.ponto = opcoes.body.point_id;
      return { retcode: 0 };
    }
    if (url.startsWith('/sp-api/current_user')) return { retcode: 0, data: { current_point_id: estado.ponto } };
    if (estado.ponto !== 7341) return { retcode: 0, data: { total: 0, list: [] } };
    const u = new URL(url, 'https://x');
    const lista = u.pathname.includes('dropoff') ? dropoff : collection;
    const pag = Number(u.searchParams.get('pageno'));
    const qtd = Number(u.searchParams.get('count'));
    const itens = lista.slice((pag - 1) * qtd, pag * qtd).map((c) => ({
      shipment_id: c, scan_tracking_number: c, sender_name: 'Fulano Teste', recipient_phone: '0000'
    }));
    return { retcode: 0, message: 'success', data: { pageno: pag, count: qtd, total: lista.length, list: itens } };
  };
  fn.chamadas = chamadas;
  return fn;
}

function mlFake(ids) {
  return async (url) => {
    const cursor = decodeURIComponent(new URL(url, 'https://x').searchParams.get('cursor'));
    const [pag, tam] = cursor.split(',').map(Number);
    const itens = ids.slice((pag - 1) * tam, pag * tam).map((id) => ({ id, label: 'x', type: 'pick_up' }));
    const temMais = pag * tam < ids.length;
    return { cursor: temMais ? [String(pag + 1), String(tam)] : null, total: ids.length, partial: ids.length, details: { items: itens } };
  };
}

test('Shopee: junta drop-off recebidos e self-collection, com paginação', async () => {
  const drop = Array.from({ length: 150 }, (_, i) => `BR26000000${String(i).padStart(3, '0')}X`);
  const fn = shopeeFake({ dropoff: drop, collection: ['br269999999999z'] });
  const codigos = await lerShopee(fn, 1_800_000_000);
  assert.equal(codigos.size, 151);
  assert.ok(codigos.has('BR269999999999Z'));
  assert.ok(fn.chamadas.some((u) => u.includes('status=2')));
  assert.ok(fn.chamadas.some((u) => u.includes('collection/list')));
  // Estava no ponto "Admin": o robô trocou para o ponto da agência antes de ler.
  assert.ok(fn.chamadas.includes('/sp-api/current_user/change_point'));
});

test('Shopee: já no ponto certo, não troca o ponto', async () => {
  const fn = shopeeFake({ dropoff: ['BR1'], pontoAtual: 7341 });
  await lerShopee(fn, 1_800_000_000);
  assert.ok(!fn.chamadas.includes('/sp-api/current_user/change_point'));
});

test('Shopee: sessão expirada é detectada', async () => {
  await assert.rejects(lerShopee(shopeeFake({ retcode: -1 })), SessaoExpirada);
});

test('Mercado Livre: percorre o cursor até o fim', async () => {
  const ids = Array.from({ length: 97 }, (_, i) => String(48000000000 + i));
  const codigos = await lerMercadoLivre(mlFake(ids));
  assert.equal(codigos.size, 97);
});

test('Robô: sincroniza, não guarda dados pessoais e uma falha não afeta a outra fonte', async () => {
  const db = openDb(':memory:');
  const conectores = {
    shopee: { id: 'shopee', ler: async () => { throw new SessaoExpirada('Shopee: sessão expirada. Faça login de novo.'); } },
    ml: { id: 'ml', ler: (buscar) => lerMercadoLivre(buscar) }
  };
  const robo = new Robo({ db, config: { ROBO_FONTES: ['shopee', 'ml'] }, conectores, log: { log() {}, warn() {}, error() {} } });
  const fakeMl = mlFake(['48100000001', '48100000002']);
  robo.paginaDe = async () => ({});
  conectores.ml.ler = () => lerMercadoLivre(fakeMl);
  robo.fecharNavegador = async () => {};

  const r = await robo.sincronizarTudo();
  const porFonte = Object.fromEntries(r.resultados.map((x) => [x.fonte, x]));
  assert.equal(porFonte.shopee.situacao, 'falhou');
  assert.match(porFonte.shopee.erro, /sessão expirada/i);
  assert.equal(porFonte.ml.situacao, 'sucesso');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM packages WHERE source='ml' AND active=1").get().n, 2);

  // Segunda passada: um pacote saiu da agência -> sai da consulta; sem duplicatas.
  conectores.ml.ler = () => lerMercadoLivre(mlFake(['48100000001', '48100000003']));
  await robo.sincronizarTudo();
  const ativos = db.prepare("SELECT code FROM packages WHERE source='ml' AND active=1 ORDER BY code").all().map((x) => x.code);
  assert.deepEqual(ativos, ['48100000001', '48100000003']);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM packages WHERE source='ml'").get().n, 3);

  // Lista que esvaziaria a consulta fica aguardando confirmação.
  conectores.ml.ler = async () => new Map();
  const r3 = await robo.sincronizarTudo();
  assert.equal(r3.resultados.find((x) => x.fonte === 'ml').situacao, 'aguardando_confirmacao');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM packages WHERE source='ml' AND active=1").get().n, 2);
  db.close();
});
