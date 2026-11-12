'use strict';
// Aba Fretes do painel: margem de lucro, transporte Tobias Barreto → Aracaju,
// simulador com o lucro, cotações recebidas e atualização da tabela da Azul.
(function () {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  function el(tag, attrs, ...filhos) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const f of filhos.flat()) if (f !== null && f !== undefined && f !== false) n.append(f instanceof Node ? f : document.createTextNode(String(f)));
    return n;
  }
  async function api(path, opts = {}) {
    const o = { credentials: 'same-origin', ...opts, headers: {} };
    if (o.body && !(o.body instanceof FormData)) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(o.body); }
    const r = await fetch('/admin/api' + path, o);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.erro || 'Não consegui carregar os fretes.');
    return d;
  }
  const brl = (v) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const kg = (v) => `${(Math.round(v * 100) / 100).toLocaleString('pt-BR')} kg`;
  const quando = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Bahia' }) : '—');
  const UFS = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'];

  let cfg = { margem: 10, transporte: 5 };
  let iniciado = false;

  // ---------- configuração ----------
  function mostrarConfig() {
    if (document.activeElement !== $('#frt-margem')) $('#frt-margem').value = cfg.margem;
    if (document.activeElement !== $('#frt-transporte')) $('#frt-transporte').value = cfg.transporte;
    for (const b of $$('#frt-atalhos .chip')) b.setAttribute('aria-pressed', String(Number(b.dataset.v) === cfg.margem));
  }
  let timerSalvar = null;
  function salvar(patch, imediato) {
    clearTimeout(timerSalvar);
    const ir = async () => {
      try {
        const r = await api('/fretes/config', { method: 'PUT', body: patch });
        cfg = r.config; mostrarConfig();
        $('#frt-salvo').textContent = `Salvo: margem ${cfg.margem.toLocaleString('pt-BR')}% e transporte ${brl(cfg.transporte)} por pacote.`;
        simular();
      } catch (e) { $('#frt-salvo').textContent = e.message; }
    };
    if (imediato) ir(); else timerSalvar = setTimeout(ir, 600);
  }
  function sugestao() {
    const v = Number($('#frt-viagem').value) || 0;
    const p = Math.max(1, Number($('#frt-pacotes').value) || 1);
    return Math.ceil((v / p) * 100) / 100;
  }

  // ---------- simulador ----------
  let timerSim = null;
  async function simular() {
    clearTimeout(timerSim);
    timerSim = setTimeout(async () => {
      const corpo = { uf: $('#frt-s-uf').value, tipo: $('#frt-s-tipo').value, peso: Number($('#frt-s-peso').value), valor: Number($('#frt-s-valor').value) };
      const t = $('#frt-simulacao');
      try {
        const r = await api('/fretes/simular', { method: 'POST', body: corpo });
        const S = r.servicos;
        const linha = (rot, fn, cls) => el('tr', { class: cls }, el('td', {}, rot), S.map((s) => el('td', { class: 'n' }, s.indisponivel ? '—' : fn(s))));
        t.replaceChildren(
          el('thead', {}, el('tr', {}, el('th', {}, r.destino + ' · ' + kg(r.peso.cobrado)), S.map((s) => el('th', { class: 'n' }, s.nome)))),
          el('tbody', {},
            linha('Faixa da tabela', (s) => s.faixa),
            linha('Frete Azul', (s) => brl(s.frete)),
            linha('Seguro', (s) => `${brl(s.seguro)} (${s.seguroPct.toLocaleString('pt-BR')}%)`),
            linha('Transporte TB → Aracaju', (s) => brl(s.transporte)),
            linha('Seu custo', (s) => brl(s.custo), 'total'),
            linha('Preço para o cliente', (s) => brl(s.preco), 'total'),
            linha('Seu lucro', (s) => brl(s.lucro), 'lucro'),
            el('tr', {}, el('td', {}, ''), S.map((s) => el('td', { class: 'n' }, s.indisponivel || '')))));
      } catch (e) {
        t.replaceChildren(el('tbody', {}, el('tr', {}, el('td', { class: 'tabela-vazia' }, e.message))));
      }
    }, 300);
  }

  // ---------- dados ----------
  async function carregar() {
    try {
      const r = await api('/fretes');
      cfg = r.config; mostrarConfig();
      const c = r.cotacoes;
      $('#frt-cotacoes').replaceChildren(
        el('thead', {}, el('tr', {}, ['Quando', 'Destino', 'Peso', 'Serviço'].map((h) => el('th', {}, h)), ['Preço', 'Custo', 'Lucro'].map((h) => el('th', { class: 'n' }, h)))),
        el('tbody', {}, c.length ? c.map((x) => el('tr', {},
          el('td', {}, quando(x.em)), el('td', {}, x.destino), el('td', {}, kg(x.peso)), el('td', {}, x.servicoNome),
          el('td', { class: 'n' }, el('b', {}, brl(x.preco))), el('td', { class: 'n' }, brl(x.custo)), el('td', { class: 'n lucro' }, brl(x.lucro))))
          : el('tr', {}, el('td', { colspan: '7', class: 'tabela-vazia' }, 'Nenhuma cotação contratada ainda.'))));
      $('#frt-vigencia').textContent = `Vigência: ${r.tabela.vigencia}`;
      $('#frt-servicos').replaceChildren(...r.tabela.servicos.map((s) => el('li', {}, el('b', {}, s.nome),
        s.importadoEm ? `Atualizada em ${quando(s.importadoEm)}${s.vigencia ? ` · vigência ${s.vigencia}` : ''}` : `Tabela original · vigência ${s.vigencia || r.tabela.vigencia}`)));
    } catch (e) {
      $('#frt-cotacoes').replaceChildren(el('tbody', {}, el('tr', {}, el('td', { class: 'tabela-vazia' }, e.message))));
    }
  }

  function iniciar() {
    if (iniciado) return;
    iniciado = true;
    $('#frt-s-uf').replaceChildren(...UFS.map((u) => el('option', { value: u, selected: u === 'SP' }, u)));
    $('#frt-margem').addEventListener('input', (e) => { const v = Number(e.target.value); if (e.target.value !== '' && v >= 0) salvar({ margem: v }); });
    $('#frt-transporte').addEventListener('input', (e) => { const v = Number(e.target.value); if (e.target.value !== '' && v >= 0) salvar({ transporte: v }); });
    for (const b of $$('#frt-atalhos .chip')) b.addEventListener('click', () => salvar({ margem: Number(b.dataset.v) }, true));
    const atualizarSug = () => { $('#frt-sug').textContent = brl(sugestao()); };
    $('#frt-viagem').addEventListener('input', atualizarSug);
    $('#frt-pacotes').addEventListener('input', atualizarSug);
    atualizarSug();
    $('#frt-usar').addEventListener('click', () => salvar({ transporte: sugestao() }, true));
    for (const id of ['#frt-s-uf', '#frt-s-tipo', '#frt-s-peso', '#frt-s-valor']) $(id).addEventListener('input', simular);
    $('#frt-form-tarifa').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const arq = $('#frt-arquivo').files[0];
      const msg = $('#frt-msg-tarifa');
      if (!arq) { msg.textContent = 'Escolha a planilha .xlsx da Azul.'; return; }
      const fd = new FormData(); fd.append('arquivo', arq);
      const b = ev.submitter || $('#frt-form-tarifa button');
      b.disabled = true; msg.textContent = 'Lendo a planilha…';
      try {
        const r = await api('/fretes/tarifas', { method: 'POST', body: fd });
        msg.textContent = `${r.nome} atualizado (${r.linhas} linhas${r.vigencia ? `, vigência ${r.vigencia}` : ''}).`;
        $('#frt-arquivo').value = '';
        carregar(); simular();
      } catch (e) { msg.textContent = e.message; }
      b.disabled = false;
    });
  }

  window.goboxFretes = {
    abrir() { iniciar(); carregar(); simular(); },
    fechar() {}
  };
})();
