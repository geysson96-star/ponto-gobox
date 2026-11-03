'use strict';
// Definição das fontes. Cada empresa tem regras e configurações próprias,
// mantidas separadas. Os nomes de coluna abaixo são APENAS palpites iniciais:
// os portais não documentam publicamente o formato dos relatórios, então
// confirme a coluna certa no painel (Configurações) depois de importar um
// arquivo real. Se nenhuma coluna for reconhecida, a importação falha e o
// painel mostra os cabeçalhos encontrados no arquivo.

const SOURCES = {
  shopee: {
    id: 'shopee',
    name: 'Shopee SPX',
    defaults: {
      codeColumn: '',
      idColumn: '',
      mode: 'snapshot',
      staleHours: 12,
      maxDeactivatePercent: 50
    },
    codeColumnCandidates: [
      'tracking number', 'tracking no', 'tracking_number', 'tracking id',
      'spx tracking number', 'codigo de rastreio', 'código de rastreio',
      'codigo de rastreamento', 'código de rastreamento', 'rastreio', 'codigo', 'código'
    ],
    idColumnCandidates: ['order id', 'order sn', 'id do pedido', 'pedido']
  },
  ml: {
    id: 'ml',
    name: 'Mercado Livre',
    defaults: {
      codeColumn: '',
      idColumn: '',
      mode: 'snapshot',
      staleHours: 12,
      maxDeactivatePercent: 50
    },
    codeColumnCandidates: [
      'tracking number', 'codigo de rastreio', 'código de rastreio',
      'codigo de rastreamento', 'código de rastreamento', 'rastreio',
      'id do envio', 'shipment id', 'envio', 'codigo', 'código'
    ],
    idColumnCandidates: ['id do envio', 'shipment id', 'id do pacote', 'pack id']
  },
  correios: {
    id: 'correios',
    name: 'Correios',
    defaults: {
      codeColumn: '',
      idColumn: '',
      mode: 'snapshot',
      staleHours: 12,
      maxDeactivatePercent: 50
    },
    codeColumnCandidates: [
      'objeto', 'codigo do objeto', 'código do objeto', 'codigo de rastreio',
      'código de rastreio', 'codigo de rastreamento', 'código de rastreamento',
      'rastreio', 'etiqueta', 'codigo', 'código'
    ],
    idColumnCandidates: []
  }
};

const SOURCE_IDS = Object.keys(SOURCES);

function isSource(id) {
  return Object.prototype.hasOwnProperty.call(SOURCES, id);
}

module.exports = { SOURCES, SOURCE_IDS, isSource };
