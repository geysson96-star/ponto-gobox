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

  // Tipo do serviço: pick_up (retirada), delivery (entrega) ou nex (rota NEx).
  // volume: 'shipment' (pacote) ou outro valor, como uma saca.
  function descrever(it) {
    const volume = it.volume_type ? String(it.volume_type).slice(0, 20) : null;
    if (it.type === 'pick_up') {
      return {
        tipo: 'retirada', volume,
        rotulo: it.subStatus === 'expired' ? 'Prazo de retirada vencido' : 'Disponível para retirada'
      };
    }
    return { tipo: it.type === 'nex' ? 'nex' : 'delivery', volume, rotulo: 'Na agência, aguardando coleta do Mercado Livre' };
  }

  // Acumulado oficial da quinzena (tela "Recebimento estimado") e faturas da quinzena
  // já fechada. Os dados vêm no próprio HTML da página, como JSON.
  function extrairJson(html, chave) {
    const i = html.indexOf(`"${chave}":`);
    if (i < 0) return null;
    let j = i + chave.length + 3;
    const ini = j;
    let nivel = 0; let aspas = false; let esc = false;
    for (; j < html.length; j += 1) {
      const c = html[j];
      if (aspas) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') aspas = false; continue; }
      if (c === '"') aspas = true;
      else if (c === '{' || c === '[') nivel += 1;
      else if (c === '}' || c === ']') { nivel -= 1; if (nivel === 0) { j += 1; break; } }
    }
    try { return JSON.parse(html.slice(ini, j)); } catch { return null; }
  }
  async function lerFinanceiro() {
    const pagina = await fetch('/finance', { credentials: 'include' }).then((r) => r.text());
    const projecao = extrairJson(pagina, 'financeProjection');
    const id = projecao && projecao.projectionIds && projecao.projectionIds.BIWEEKLY;
    if (!id || !/^\d+$/.test(String(id))) return null;
    const est = await fetch(`/finance/${id}/invoice-estimate?biweekly=${id}`, { credentials: 'include' }).then((r) => r.text());
    const q = extrairJson(est, 'getBiweekly');
    if (!q || !q.period || !Array.isArray(q.items)) return null;
    return {
      de: q.period.from, ate: q.period.to, atualizadoEm: q.updatedAt || null,
      itens: q.items.map((i) => ({ tipo: String(i.type), quantidade: Number(i.quantity) || 0, total: Number(i.total) || 0 }))
    };
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
    let financeiro = null;
    try { financeiro = await lerFinanceiro(); } catch { /* sem o acumulado: segue só com os pacotes */ }
    return { pacotes: [...pacotes.values()], modo: 'estoque', financeiro };
  }

  goboxAgendar('ml', ler);
}());
