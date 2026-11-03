'use strict';
/* global goboxBuscarJson, goboxNormalizar, goboxAgendar */
// Mercado Livre Places: tela "Estoque na sua agência".
// A lista só tem o que está na agência agora (com data de entrada e tipo).
// Quando um pacote some da lista, o site registra que ele saiu.

(function () {
  function dataIso(v) {
    if (!v) return null;
    // Corta frações de segundo além dos milissegundos (o portal manda nanossegundos).
    const s = String(v).replace(/(\.\d{3})\d+/, '$1');
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  function descrever(it) {
    if (it.type === 'pick_up') {
      return {
        tipo: 'retirada',
        rotulo: it.subStatus === 'expired' ? 'Prazo de retirada vencido' : 'Disponível para retirada'
      };
    }
    return { tipo: 'envio', rotulo: 'Na agência, aguardando coleta do Mercado Livre' };
  }

  async function ler() {
    const pacotes = new Map();
    let cursor = '1,20';
    let total = Infinity;
    for (let i = 0; i < 500 && pacotes.size < total; i += 1) {
      const r = await goboxBuscarJson(`/api/reports/stock/v2/details?by_action=&cursor=${encodeURIComponent(cursor)}`);
      if (!r || !r.details) throw new Error('Mercado Livre: resposta em formato inesperado.');
      const itens = r.details.items || [];
      total = Number(r.total ?? itens.length);
      if (!itens.length) break;
      for (const it of itens) {
        const c = goboxNormalizar(it.id);
        if (!c) continue;
        pacotes.set(c, { codigo: c, situacao: 'na_agencia', recebidoEm: dataIso(it.inbound_date), saidaEm: null, ...descrever(it) });
      }
      if (!Array.isArray(r.cursor) || !r.cursor[0]) break;
      const proximo = r.cursor.join(',');
      if (proximo === cursor) break;
      cursor = proximo;
    }
    return { pacotes: [...pacotes.values()], modo: 'estoque' };
  }

  goboxAgendar('ml', ler);
}());
