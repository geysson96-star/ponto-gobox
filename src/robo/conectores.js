'use strict';
// Conectores do robô. Cada um recebe `buscarJson(url)`, que faz a requisição
// DENTRO da página do portal já logada (mesma sessão que você usa no navegador),
// e devolve um Map código -> id da fonte. Só os códigos são lidos; nomes,
// telefones e demais dados dos clientes são ignorados aqui mesmo.
//
// Estes endereços são os que o próprio site do portal usa. Não são uma API
// oficial: se o portal mudar, o conector falha e o painel avisa.

const { normalizeCode } = require('../normalize');

class SessaoExpirada extends Error {}
class RespostaInesperada extends Error {}

const DIA = 86400;

// ---------------- Shopee SPX (Agência / Service Point) ----------------
// Considera "na agência":
//  - Drop-off com status 2 (aba "DOP Received": recebido do vendedor e ainda não saiu);
//  - Self-Collection nos status da aba "Ready For Collection" (aguardando o comprador retirar).
const SHOPEE = {
  id: 'shopee',
  origem: 'https://sp.spx.shopee.com.br',
  paginaInicial: 'https://sp.spx.shopee.com.br/order-management/drop-off',
  diasJanela: 90,
  porPagina: 100,
  listas: [
    { nome: 'drop-off recebidos', caminho: '/sp-api/point/order/dropoff/list', status: '2' },
    { nome: 'self-collection prontos para retirada', caminho: '/sp-api/point/order/collection/list', status: '1,2,3,4,5,69,70,71,60,61,62,63' }
  ]
};

// A conta pode ter mais de um ponto (ex.: o da agência e um "Admin"), e o portal
// às vezes volta sozinho para o "Admin", onde as listas ficam vazias. Antes de
// ler, o robô garante que o ponto ativo é o da agência. Se SHOPEE_PONTO_ID não
// estiver configurado, usa o único ponto que não se chama "Admin".
async function garantirPontoShopee(buscarJson, pontoConfigurado) {
  const lista = await buscarJson('/sp-api/current_user/list_point');
  if (!lista || lista.retcode !== 0) throw new SessaoExpirada('Shopee: sessão expirada. Faça login de novo.');
  const pontos = (lista.data && lista.data.point_list) || [];
  let alvo;
  if (pontoConfigurado) {
    alvo = pontos.find((p) => String(p.point_id) === String(pontoConfigurado));
    if (!alvo) throw new RespostaInesperada(`Shopee: o ponto ${pontoConfigurado} (SHOPEE_PONTO_ID) não existe nesta conta.`);
  } else {
    const reais = pontos.filter((p) => !/^admin$/i.test(String(p.point_name || '').trim()));
    if (reais.length !== 1) {
      throw new RespostaInesperada('Shopee: a conta tem mais de um ponto. Defina SHOPEE_PONTO_ID no .env.');
    }
    [alvo] = reais;
  }
  const atual = await buscarJson('/sp-api/current_user?ignore_point_list_flag=true');
  if (atual && atual.retcode === 0 && atual.data && String(atual.data.current_point_id) === String(alvo.point_id)) {
    return alvo.point_id;
  }
  const r = await buscarJson('/sp-api/current_user/change_point', { method: 'POST', body: { point_id: alvo.point_id } });
  if (!r || r.retcode !== 0) throw new RespostaInesperada('Shopee: não consegui selecionar o ponto da agência.');
  return alvo.point_id;
}

async function lerShopee(buscarJson, agora = Math.floor(Date.now() / 1000), opcoes = {}) {
  if (opcoes.garantirPonto !== false) await garantirPontoShopee(buscarJson, opcoes.pontoId);
  const codigos = new Map();
  const inicio = agora - SHOPEE.diasJanela * DIA;
  for (const lista of SHOPEE.listas) {
    let total = Infinity;
    let lidos = 0;
    for (let pagina = 1; lidos < total && pagina <= 200; pagina += 1) {
      const url = `${lista.caminho}?inbound_time_start=${inicio}&inbound_time_end=${agora}` +
        `&pageno=${pagina}&count=${SHOPEE.porPagina}&status=${encodeURIComponent(lista.status)}`;
      const r = await buscarJson(url);
      if (!r || typeof r !== 'object') throw new RespostaInesperada('Shopee: resposta vazia.');
      if (r.retcode === 2104016) {
        throw new RespostaInesperada('Shopee: o ponto ativo mudou durante a leitura. Tento de novo na próxima passada.');
      }
      if (r.retcode !== 0) {
        const msg = String(r.message || '').toLowerCase();
        if (r.retcode === -1 || /login|cookie|token|auth|session/.test(msg)) {
          throw new SessaoExpirada('Shopee: sessão expirada. Faça login de novo.');
        }
        throw new RespostaInesperada(`Shopee: o portal respondeu com erro (${r.retcode}).`);
      }
      const itens = (r.data && r.data.list) || [];
      total = Number((r.data && r.data.total) ?? itens.length);
      if (itens.length === 0) break;
      lidos += itens.length;
      for (const it of itens) {
        const codigo = normalizeCode(it.shipment_id || it.scan_tracking_number);
        if (!codigo) continue;
        codigos.set(codigo, null);
        const scan = normalizeCode(it.scan_tracking_number);
        if (scan && scan !== codigo) codigos.set(scan, codigo);
      }
    }
  }
  return codigos;
}

// ---------------- Mercado Livre Places ("Estoque na sua agência") ----------------
const ML = {
  id: 'ml',
  origem: 'https://places.mercadolivre.com.br',
  paginaInicial: 'https://places.mercadolivre.com.br/reports/stock/v2',
  porPagina: 20
};

async function lerMercadoLivre(buscarJson) {
  const codigos = new Map();
  let cursor = `1,${ML.porPagina}`;
  let total = Infinity;
  for (let i = 0; i < 500 && codigos.size < total; i += 1) {
    const r = await buscarJson(`/api/reports/stock/v2/details?by_action=&cursor=${encodeURIComponent(cursor)}`);
    if (!r || typeof r !== 'object' || !r.details) {
      throw new RespostaInesperada('Mercado Livre: resposta em formato inesperado.');
    }
    const itens = r.details.items || [];
    total = Number(r.total ?? itens.length);
    if (itens.length === 0) break;
    for (const it of itens) {
      const codigo = normalizeCode(it.id);
      if (codigo) codigos.set(codigo, null);
    }
    if (!Array.isArray(r.cursor) || !r.cursor[0]) break;
    const proximo = r.cursor.join(',');
    if (proximo === cursor) break;
    cursor = proximo;
  }
  return codigos;
}

const CONECTORES = {
  shopee: {
    ...SHOPEE,
    ler: (buscarJson, config = {}) => lerShopee(buscarJson, undefined, { pontoId: config.SHOPEE_PONTO_ID })
  },
  ml: { ...ML, ler: lerMercadoLivre }
};

module.exports = { CONECTORES, lerShopee, lerMercadoLivre, SessaoExpirada, RespostaInesperada };
