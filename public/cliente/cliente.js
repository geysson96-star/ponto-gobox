'use strict';
// Página do cliente (link secreto /c/<token>): sobe etiquetas e acompanha a entrega.
(function () {
  const $ = (s) => document.querySelector(s);
  const token = decodeURIComponent((location.pathname.match(/^\/c\/([^/]+)/) || [])[1] || '');
  const COD_RE = /BR\d{12}[0-9A-Z]/g;
  const quando = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Bahia' }) : '');
  let dados = null;
  let lista = 'faltam';
  let previa = null; // pacotes lidos do PDF, aguardando confirmação
  const abertas = new Set(); // lojas abertas na lista (continuam abertas quando a página atualiza)

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

  async function api(caminho, opcoes = {}) {
    const o = { ...opcoes, headers: {} };
    if (o.body) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(o.body); }
    const r = await fetch(`/api/portal/${encodeURIComponent(token)}${caminho}`, o);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(d.erro || 'Não consegui falar com a GoBox. Tente de novo.'); e.status = r.status; throw e; }
    return d;
  }

  function aviso(tipo, titulo, detalhe) {
    const a = $('#aviso');
    a.className = `aviso ${tipo || ''}`;
    a.replaceChildren(...[el('span', {}, titulo), detalhe ? el('small', {}, detalhe) : null].filter(Boolean));
    a.hidden = false;
  }

  // ---------- leitura do PDF (mesma lógica da extensão Subir Etiquetas) ----------
  function remetenteDaPagina(items) {
    const r = items.find((i) => (i.str || '').trim().toUpperCase() === 'REMETENTE');
    if (!r) return '';
    const [a, , , , rx, ry] = r.transform;
    const girado = Math.abs(a) < 0.01;
    const cand = items.filter((i) => i !== r && (i.str || '').trim() && (girado
      ? Math.abs(i.transform[5] - ry) < 4 && i.transform[4] < rx
      : Math.abs(i.transform[4] - rx) < 20 && i.transform[5] < ry));
    cand.sort((p, q) => (girado ? q.transform[4] - p.transform[4] : q.transform[5] - p.transform[5]));
    return cand[0] ? cand[0].str.trim() : '';
  }
  async function lerPdf(file) {
    const pdfjs = window.pdfjsLib;
    if (!pdfjs) throw new Error('o leitor de PDF não carregou; atualize a página');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), verbosity: 0, isEvalSupported: false }).promise;
    const pacotes = [], avisos = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const items = (await (await doc.getPage(p)).getTextContent()).items;
      const achados = [...new Set(items.map((i) => i.str).join(' ').toUpperCase().match(COD_RE) || [])];
      if (achados.length !== 1) avisos.push(`${file.name}, pág. ${p}: ${achados.length ? `${achados.length} códigos` : 'nenhum código BR'}`);
      const loja = remetenteDaPagina(items);
      for (const c of achados) pacotes.push({ codigo: c, loja });
    }
    return { pacotes, avisos };
  }

  const normLoja = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  // Mesmo nome de loja já usado antes (sem diferença de maiúsculas/acentos).
  function lojaConhecida(nome) {
    const n = normLoja(nome);
    return n ? dados.lojasConhecidas.find((l) => normLoja(l) === n) || null : null;
  }

  async function lerArquivos(files) {
    files = [...files].filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!files.length) return aviso('alerta', 'Escolha um arquivo PDF.');
    $('#aviso').hidden = true;
    const box = $('#previa');
    box.hidden = false;
    box.replaceChildren(el('p', {}, 'Lendo PDF…'));
    try {
      const todos = [], avisos = [];
      for (const f of files) { const r = await lerPdf(f); todos.push(...r.pacotes); avisos.push(...r.avisos); }
      const vistos = new Set();
      const unicos = todos.filter((p) => !vistos.has(p.codigo) && vistos.add(p.codigo));
      if (!unicos.length) { box.hidden = true; return aviso('erro', 'Não achei nenhum código BR nesse PDF.', 'Confira se é o PDF das etiquetas da Shopee.'); }
      previa = unicos;
      mostrarPrevia(unicos, avisos, todos.length - unicos.length);
    } catch (e) {
      box.hidden = true;
      aviso('erro', 'Não consegui ler o PDF.', e.message);
    }
  }

  function mostrarPrevia(pacotes, avisos, repetidos) {
    const porLoja = {};
    for (const p of pacotes) {
      const nome = lojaConhecida(p.loja) || p.loja || 'Sem loja (remetente não lido)';
      porLoja[nome] = (porLoja[nome] || 0) + 1;
    }
    const box = $('#previa');
    box.replaceChildren(el('div', { class: 'previa' },
      el('strong', {}, `${pacotes.length} etiqueta(s) encontrada(s)`),
      el('ul', {}, Object.entries(porLoja).sort((a, b) => b[1] - a[1]).map(([n, q]) => el('li', {}, el('b', {}, n), `: ${q} etiqueta${q === 1 ? '' : 's'}`))),
      repetidos ? el('p', { class: 'dica' }, `${repetidos} código(s) repetido(s) no PDF foram ignorados.`) : null,
      avisos.length ? el('p', { class: 'dica' }, `Atenção: ${avisos.slice(0, 5).join(' · ')}`) : null,
      el('div', { class: 'acoes' },
        el('button', { type: 'button', class: 'botao-principal', onclick: (ev) => enviar(previa, 'pdf', ev.target) }, `Confirmar e subir ${pacotes.length}`),
        el('button', { type: 'button', class: 'botao-sec', onclick: () => { previa = null; box.hidden = true; $('#arquivo').value = ''; } }, 'Cancelar'))));
  }

  async function enviar(pacotes, origem, botao) {
    if (botao) botao.disabled = true;
    try {
      const r = await api('/etiquetas', { method: 'POST', body: { pacotes, origem } });
      previa = null; $('#previa').hidden = true; $('#arquivo').value = '';
      if (origem === 'digitado') $('#codigos').value = '';
      const det = [];
      if (r.jaSubidos) det.push(`${r.jaSubidos} já tinham sido subidas antes`);
      if (r.deOutroCliente) det.push(`${r.deOutroCliente} já estão cadastradas por outro cliente (fale com a GoBox)`);
      if (r.invalidos && r.invalidos.length) det.push(`${r.invalidos.length} código(s) inválido(s)`);
      aviso(r.novos ? 'ok' : 'alerta',
        r.novos ? `${r.novos} etiqueta(s) subida(s)! Agora você tem ${r.faltam} pacote(s) para levar na GoBox.` : 'Nenhuma etiqueta nova foi subida.',
        det.join(' · '));
      await carregar();
    } catch (e) {
      aviso('erro', e.message);
    } finally { if (botao) botao.disabled = false; }
  }

  // ---------- desenho ----------
  function desenhar() {
    $('#ola').textContent = `Olá, ${dados.cliente}`;
    $('#n-faltam').textContent = dados.totais.faltam;
    $('#n-subidos').textContent = dados.totais.subidos;
    $('#n-entregues').textContent = dados.totais.entregues;

    $('#lojas-conhecidas').replaceChildren(...dados.lojasConhecidas.map((l) => el('option', { value: l })));

    $('#lojas').replaceChildren(...(dados.lojas.length ? dados.lojas.map((l) => {
      const dela = dados.pacotes.filter((p) => (p.loja || 'Sem loja') === l.loja)
        .sort((a, b) => Boolean(a.entregueEm) - Boolean(b.entregueEm));
      const d = el('details', { class: 'loja', open: abertas.has(l.loja) },
        el('summary', {}, el('span', { class: 'loja-nome' }, l.loja),
          el('span', { class: 'loja-n' }, `${l.subidos} etiqueta${l.subidos === 1 ? '' : 's'}`),
          el('span', { class: 'loja-n entregue' }, `${l.entregues} entregue${l.entregues === 1 ? '' : 's'}`),
          el('span', { class: 'loja-n falta' }, `${l.faltam} falta${l.faltam === 1 ? '' : 'm'}`)),
        el('ul', { class: 'etiquetas' }, dela.map((p) => el('li', {}, el('code', {}, p.codigo),
          el('span', { class: p.entregueEm ? 'ok' : 'pend' }, p.entregueEm ? `entregue ${quando(p.entregueEm)}` : 'falta entregar')))));
      d.addEventListener('toggle', () => { if (d.open) abertas.add(l.loja); else abertas.delete(l.loja); });
      return d;
    }) : [el('p', { class: 'vazio' }, 'Nenhuma etiqueta ainda.')]));

    const faltam = dados.pacotes.filter((p) => !p.entregueEm);
    const entregues = dados.pacotes.filter((p) => p.entregueEm);
    $('#c-faltam').textContent = `(${faltam.length})`;
    $('#c-entregues').textContent = `(${entregues.length})`;
    const ver = lista === 'faltam' ? faltam : entregues;
    $('#th-data').textContent = lista === 'faltam' ? 'Subida em' : 'Entregue em';
    $('#pacotes').replaceChildren(...(ver.length ? ver.map((p) => el('tr', {},
      el('td', { class: 'mono' }, p.codigo), el('td', {}, p.loja || '—'),
      el('td', {}, quando(lista === 'faltam' ? p.subidoEm : p.entregueEm)),
      el('td', {}, lista === 'faltam' && p.spx !== 'subido'
        ? el('button', { type: 'button', class: 'botao-mini', onclick: () => remover(p.codigo) }, 'tirar') : null)))
      : [el('tr', {}, el('td', { colspan: '4', class: 'vazio' }, lista === 'faltam' ? 'Nenhum pacote faltando. Tudo entregue! ✅' : 'Nenhum pacote entregue ainda.'))]));
    $('#dica-lista').textContent = lista === 'faltam' && faltam.length
      ? `Leve estes ${faltam.length} pacote(s) até a GoBox. Quando a equipe bipar, eles saem daqui sozinhos.` : '';
  }

  async function remover(codigo) {
    if (!confirm(`Tirar a etiqueta ${codigo}?`)) return;
    try { await api(`/etiquetas/${encodeURIComponent(codigo)}`, { method: 'DELETE' }); await carregar(); } catch (e) { aviso('erro', e.message); }
  }

  async function carregar() {
    try {
      dados = await api('');
      $('#carregando').hidden = true; $('#conteudo').hidden = false;
      desenhar();
    } catch (e) {
      $('#carregando').hidden = true;
      if (e.status === 404 || !token) { $('#conteudo').hidden = true; $('#invalido').hidden = false; return; }
      if (dados) aviso('erro', e.message); else { $('#carregando').hidden = false; $('#carregando').textContent = e.message; }
    }
  }

  // ---------- eventos ----------
  for (const b of document.querySelectorAll('.ab')) b.addEventListener('click', () => {
    for (const x of document.querySelectorAll('.ab')) x.classList.toggle('on', x === b);
    $('#modo-pdf').hidden = b.dataset.modo !== 'pdf';
    $('#modo-digitar').hidden = b.dataset.modo !== 'digitar';
  });
  for (const b of document.querySelectorAll('.al')) b.addEventListener('click', () => {
    for (const x of document.querySelectorAll('.al')) x.classList.toggle('on', x === b);
    lista = b.dataset.lista; desenhar();
  });
  const soltar = $('#soltar');
  $('#arquivo').addEventListener('change', (e) => lerArquivos(e.target.files));
  soltar.addEventListener('dragover', (e) => { e.preventDefault(); soltar.classList.add('sobre'); });
  soltar.addEventListener('dragleave', () => soltar.classList.remove('sobre'));
  soltar.addEventListener('drop', (e) => { e.preventDefault(); soltar.classList.remove('sobre'); lerArquivos(e.dataTransfer.files); });
  $('#enviar-digitados').addEventListener('click', (ev) => {
    const cods = [...new Set(($('#codigos').value.toUpperCase().match(COD_RE) || []))];
    if (!cods.length) return aviso('alerta', 'Não achei nenhum código BR.', 'O código começa com BR e tem 15 caracteres, ex.: BR261234567890A.');
    const loja = $('#loja-digitar').value.trim();
    enviar(cods.map((codigo) => ({ codigo, loja })), 'digitado', ev.target);
  });

  carregar();
  setInterval(() => { if (!document.hidden && !previa) carregar(); }, 20_000);
}());
