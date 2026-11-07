'use strict';
/* global goboxBuscarJson */
// Mercado Livre Envios: tela "Entrada de unidades" (sacas que chegam na agência).
//
// Principal: a cada 2 minutos lê os envios do dia nos dados da própria página
// (para entregar, Mercado Envios Extra, situação e horário), sem precisar clicar.
// Complemento/alternativa, lendo o que a tela mostra:
//  - lista:   "Envio #078 a caminho" + "5 sacas" (seção "Hoje");
//  - detalhe: "1 Saca para entregar", "4 Sacas para Mercado Envios Extra", horários;
//  - zonas:   "Envio #078 · Hoje", "49 paradas, 69 pacotes", "zona 01 · 2 · 3".
// E envia ao site da GoBox, que decide quando avisar o grupo dos entregadores.
//
// Também guarda (sem dados de clientes) o formato das respostas que a página recebe,
// para o botão "Copiar diagnóstico das sacas" do popup.

(function () {
  const FUSO = 'America/Bahia';
  const MESES = { jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12 };
  const hoje = () => new Intl.DateTimeFormat('en-CA', { timeZone: FUSO }).format(new Date());

  // ---------- leitura da tela ----------
  function linhas() {
    return (document.body ? document.body.innerText : '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  }
  const RE_CARTAO = /^Envio\s*(?:#\s*(\d+))?\s*(a caminho|recebido|agendado)\b/i;
  const RE_SACAS = /^(\d+)\s+sacas?\b/i;
  const RE_DATA = /^(\d{1,2}) de ([a-zç]{3})[a-zç]*\.?\s*\|\s*(\d{1,2}):(\d{2})/i;
  const RE_DIA_TITULO = /^(\d{1,2}) de [a-zç]+$/i;
  const status = (t) => ({ 'a caminho': 'a_caminho', recebido: 'recebido', agendado: 'agendado' })[t.toLowerCase()];

  function dataIso(l) {
    const m = RE_DATA.exec(l);
    if (!m) return null;
    const mes = MESES[m[2].toLowerCase()];
    if (!mes) return null;
    const ano = Number(hoje().slice(0, 4));
    const p = (n) => String(n).padStart(2, '0');
    return new Date(`${ano}-${p(mes)}-${p(m[1])}T${p(m[3])}:${m[4]}:00-03:00`).toISOString();
  }

  // Lista "Entrada de unidades": só a seção "Hoje".
  function lerLista(ls) {
    const i = ls.findIndex((l) => /^hoje$/i.test(l));
    if (i < 0) return [];
    const out = [];
    for (let j = i + 1; j < ls.length; j += 1) {
      if (RE_DIA_TITULO.test(ls[j])) break; // "6 de novembro": acabou o dia de hoje
      const m = RE_CARTAO.exec(ls[j]);
      if (!m) continue;
      const s = RE_SACAS.exec(ls[j + 1] || '');
      out.push({ numero: m[1] || null, status: status(m[2]), dia: hoje(), sacas: s ? Number(s[1]) : null });
    }
    return out;
  }

  // "Status do envio": não mostra o número; usamos o cartão em que você clicou.
  function lerDetalhe(ls) {
    const i = ls.findIndex((l) => /^voc[eê] (vai receber|recebeu)$/i.test(l));
    if (i < 0) return null;
    const d = { sacas: null, entregar: 0, extra: 0, agendadoEm: null, caminhoEm: null, recebidoEm: null, status: null };
    const s = RE_SACAS.exec(ls[i + 1] || '');
    if (s) d.sacas = Number(s[1]);
    for (let j = i; j < ls.length; j += 1) {
      const l = ls[j];
      let m = /^(\d+)\s+sacas?\s+para\s+entregar$/i.exec(l);
      if (m) d.entregar = Number(m[1]);
      m = /^(\d+)\s+sacas?\s+para\s+mercado\s+envios\s+extra$/i.exec(l);
      if (m) d.extra = Number(m[1]);
      const prox = dataIso(ls[j + 1] || '');
      if (/^envio agendado$/i.test(l) && prox) d.agendadoEm = prox;
      if (/^a caminho$/i.test(l) && prox) d.caminhoEm = prox;
      if (/^recebido$/i.test(l) && prox) d.recebidoEm = prox;
    }
    d.status = d.recebidoEm ? 'recebido' : d.caminhoEm ? 'a_caminho' : 'agendado';
    return d;
  }

  // "Distribuição por zonas" (filtro "Envio #078 · Hoje").
  function lerZonas(ls) {
    if (!ls.some((l) => /^distribui[cç][aã]o por zonas$/i.test(l))) return null;
    const filtro = ls.map((l) => /Envio\s*#\s*(\d+)\s*·\s*Hoje/i.exec(l)).find(Boolean);
    if (!filtro) return null;
    const z = { numero: filtro[1], paradas: null, pacotes: null, zonas: [] };
    for (let j = 0; j < ls.length; j += 1) {
      const t = /^(\d+)\s+paradas?,\s*(\d+)\s+pacotes?$/i.exec(ls[j]);
      if (t) { z.paradas = Number(t[1]); z.pacotes = Number(t[2]); continue; }
      // Nome da zona e, na mesma linha ou nas seguintes, paradas e pacotes.
      const m = /^(zona\s*[\w-]+|sem zona)\s*(\d+)?\s*(\d+)?$/i.exec(ls[j]);
      if (!m) continue;
      const nums = [m[2], m[3]].filter(Boolean).map(Number);
      let k = j + 1;
      while (nums.length < 2 && /^\d+(\s+\d+)?$/.test(ls[k] || '')) { nums.push(...ls[k].split(/\s+/).map(Number)); k += 1; }
      if (nums.length >= 2) { z.zonas.push({ nome: m[1], paradas: nums[0], pacotes: nums[1] }); j = k - 1; }
    }
    return z;
  }

  // ---------- estado do dia (sobrevive a recarregar a página) ----------
  const CHAVE = 'goboxSacasDia';
  function estado() {
    try {
      const e = JSON.parse(sessionStorage.getItem(CHAVE) || '{}');
      return e.dia === hoje() ? e : { dia: hoje(), envios: {}, aberto: null };
    } catch { return { dia: hoje(), envios: {}, aberto: null }; }
  }
  function guardar(e) { try { sessionStorage.setItem(CHAVE, JSON.stringify(e)); } catch { /* nada */ } }

  // Lembra qual envio você abriu (o detalhe não mostra o número).
  document.addEventListener('click', (ev) => {
    let n = ev.target;
    for (let k = 0; n && k < 8; k += 1, n = n.parentElement) {
      const m = RE_CARTAO.exec((n.innerText || '').trim());
      if (m && m[1]) { const e = estado(); e.aberto = m[1]; guardar(e); return; }
    }
  }, true);

  // ---------- dados da própria página (sem cliques) ----------
  // A tela busca os envios do dia em /logistics/dist-ops/api/reports/inbound:
  //   routeId 468853078 -> "Envio #078" (3 últimos dígitos)
  //   quantity -> sacas para entregar; nexQuantity -> sacas Mercado Envios Extra
  //   status ON_WAY / RECEIVED; date -> quando saiu (a caminho)
  const STATUS_API = { ON_WAY: 'a_caminho', RECEIVED: 'recebido' };
  let api = null; // { em, envios }
  // Transforma a resposta do Mercado Livre nos envios do dia.
  function aplicarInbound(r) {
    if (!r || !Array.isArray(r.currentShipping)) return false;
    const envios = [];
    for (const x of r.currentShipping) {
      const rota = String(x.routeId || '');
      if (!/^\d{3,}$/.test(rota)) continue;
      const entregar = Number(x.quantity) || 0;
      const extra = Number(x.nexQuantity) || 0;
      const saiu = x.date && !Number.isNaN(Date.parse(x.date)) ? new Date(x.date).toISOString() : null;
      const status = STATUS_API[String(x.status || '').toUpperCase()] || 'agendado';
      envios.push({
        numero: rota.slice(-3), rota, status, entregar, extra, sacas: entregar + extra,
        caminhoEm: status !== 'agendado' ? saiu : null
      });
    }
    api = { em: Date.now(), envios };
    return true;
  }

  // Busca por conta própria (pode ser recusada pelo portal; aí vale a resposta que a página recebe).
  async function lerApi() {
    try {
      const r = await goboxBuscarJson('/logistics/dist-ops/api/reports/inbound');
      if (!aplicarInbound(r)) throw new Error('formato inesperado');
    } catch {
      if (api && Date.now() - api.em > 10 * 60_000) api = null; // volta a ler só a tela
    }
    ler(true);
  }

  let ultimoEnviado = '';
  let ultimoEnvioEm = 0;
  function ler(forcar = false) {
    const ls = linhas();
    const e = estado();
    const juntar = (num, dados) => { e.envios[num] = { ...(e.envios[num] || {}), ...dados, numero: num, dia: e.dia }; };

    if (api) {
      // Dados completos da página: dispensam a lista e o detalhe lidos da tela.
      for (const x of api.envios) juntar(x.numero, x);
      e.semNumero = [];
    }
    const lista = api ? [] : lerLista(ls);
    const naLista = new Set(lista.filter((c) => c.numero).map((c) => c.numero));
    for (const c of lista) {
      if (c.numero) { juntar(c.numero, { status: c.status, ...(c.sacas !== null ? { sacas: c.sacas } : {}) }); continue; }
      // "Envio recebido" sem número: é o envio que sumiu da lista com a mesma quantidade de sacas.
      const par = c.status === 'recebido' && Object.values(e.envios)
        .find((x) => x.status !== 'recebido' && !naLista.has(x.numero) && x.sacas === c.sacas);
      if (par) { naLista.add(par.numero); juntar(par.numero, { status: 'recebido' }); }
      else if (c.status === 'recebido') e.semNumero = [...(e.semNumero || []).filter((x) => x.sacas !== c.sacas), c];
    }
    const det = api ? null : lerDetalhe(ls);
    if (det && e.aberto) {
      const limpo = Object.fromEntries(Object.entries(det).filter(([, v]) => v !== null));
      juntar(e.aberto, limpo);
    }
    const z = lerZonas(ls);
    if (z) juntar(z.numero, { paradas: z.paradas, pacotes: z.pacotes, zonas: z.zonas.length ? z.zonas : null });
    guardar(e);

    const envios = [...Object.values(e.envios).filter((x) => x.status), ...(e.semNumero || [])];
    if (!envios.length) return;
    const assinatura = JSON.stringify(envios);
    // Manda quando algo mudou, ou a cada 5 min para o site saber que a leitura está viva.
    if (!forcar && assinatura === ultimoEnviado && Date.now() - ultimoEnvioEm < 5 * 60_000) return;
    ultimoEnviado = assinatura;
    ultimoEnvioEm = Date.now();
    try { chrome.runtime.sendMessage({ tipo: 'gobox-sacas', envios }); } catch { /* extensão recarregada */ }
  }

  // A tela é um app: relê quando o conteúdo muda (com folga) e a cada minuto.
  let espera = null;
  new MutationObserver(() => { clearTimeout(espera); espera = setTimeout(() => ler(), 1500); })
    .observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  setTimeout(lerApi, 3000);
  setInterval(lerApi, 2 * 60_000); // os envios do dia, a cada 2 minutos
  setInterval(() => ler(), 60_000);

  chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.tipo === 'gobox-agora') lerApi(); });

  // ---------- diagnóstico: formato das respostas da página, sem dados de clientes ----------
  const SENSIVEL = /(address|street|addr|name|nome|phone|tel|receiver|buyer|lat|lng|lon|document|doc_|cpf|cnpj|email|zip|cep|token|cookie)/i;
  function limpar(v, chave = '', nivel = 0) {
    if (nivel > 8) return '…';
    if (Array.isArray(v)) return v.slice(0, 4).map((x) => limpar(x, chave, nivel + 1)).concat(v.length > 4 ? [`(+${v.length - 4})`] : []);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v).slice(0, 60)) o[k] = SENSIVEL.test(k) ? '•' : limpar(x, k, nivel + 1);
      return o;
    }
    if (typeof v === 'string') return SENSIVEL.test(chave) ? '•' : v.slice(0, 60);
    return v;
  }
  window.addEventListener('message', async (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.marca !== 'gobox-sacas-resposta') return;
    let corpo;
    try { corpo = JSON.parse(d.texto); } catch { return; }
    let caminho;
    try { const u = new URL(d.url, location.href); caminho = u.origin + u.pathname; } catch { return; }
    // A própria página buscou os envios do dia: usa essa resposta (é a fonte mais confiável).
    if (caminho.includes('/logistics/dist-ops/api/reports/inbound') && aplicarInbound(corpo)) ler(true);
    const { amostrasSacas = [] } = await chrome.storage.local.get('amostrasSacas');
    const resto = amostrasSacas.filter((a) => a.caminho !== caminho);
    resto.push({ caminho, em: new Date().toISOString(), corpo: limpar(corpo) });
    await chrome.storage.local.set({ amostrasSacas: resto.slice(-20) });
  });
}());
