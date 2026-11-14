'use strict';
// Aba "Etiquetas dos clientes": clientes com link secreto, fila para o SPX, bipagem e pacotes.
(function () {
  const $ = (s) => document.querySelector(s);
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
  async function api(caminho, opts = {}) {
    const o = { credentials: 'same-origin', ...opts, headers: {} };
    if (o.body) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(o.body); }
    const r = await fetch('/admin/api' + caminho, o);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.erro || 'Não consegui carregar as etiquetas.');
    return d;
  }
  const quando = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Bahia' }) : '—');
  const linkDe = (c) => `${location.origin}/c/${c.token}`;
  const SPX = { pendente: ['Na fila', 'fila'], subido: ['No SPX ✓', 'ok'], erro: ['Erro', 'erro'] };

  const trocar = (no, ...filhos) => no.replaceChildren(...filhos.flat().filter((f) => f !== null && f !== undefined && f !== false));
  let dados = null;
  let timer = null;
  let editando = null; // id do cliente com as lojas em edição

  // ---------- bipagem ----------
  $('#ptl-form-bipar').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const inp = $('#ptl-bip');
    const codigo = inp.value.trim();
    if (!codigo) return;
    inp.value = '';
    const msg = $('#ptl-bip-msg');
    try {
      const r = await api('/portal/bipar', { method: 'POST', body: { codigo } });
      let tipo, texto;
      if (r.situacao === 'baixa') { tipo = 'ok'; texto = `✅ ${r.codigo} — baixa dada. ${r.cliente}${r.loja ? ` · ${r.loja}` : ''}. Faltam ${r.faltam} desse cliente${r.loja ? ` (${r.faltamLoja} dessa loja)` : ''}.`; }
      else if (r.situacao === 'ja_bipado') { tipo = 'alerta'; texto = `⚠ ${r.codigo} já tinha baixa (${quando(r.entregueEm)}) — ${r.cliente}.`; }
      else { tipo = 'erro'; texto = `✖ ${r.codigo} não foi subido por nenhum cliente do portal.`; }
      msg.className = `ptl-msg ${tipo}`; msg.textContent = texto; msg.hidden = false;
      carregar();
    } catch (e) { msg.className = 'ptl-msg erro'; msg.textContent = e.message; msg.hidden = false; }
    inp.focus();
  });

  // ---------- novo cliente ----------
  $('#ptl-novo-btn').addEventListener('click', () => { $('#ptl-novo').hidden = false; $('#ptl-nome').focus(); });
  $('#ptl-novo-cancelar').addEventListener('click', () => { $('#ptl-novo').hidden = true; });
  $('#ptl-novo').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const { cliente } = await api('/portal/clientes', { method: 'POST', body: { nome: $('#ptl-nome').value } });
      $('#ptl-nome').value = ''; $('#ptl-novo').hidden = true;
      await carregar();
      copiar(linkDe(cliente), `Cliente ${cliente.nome} criado. Link copiado — é só mandar para ele.`);
    } catch (e) { alert(e.message); }
  });

  async function copiar(texto, aviso) {
    try { await navigator.clipboard.writeText(texto); if (aviso) alert(aviso); } catch { prompt('Copie o link:', texto); }
  }

  async function acao(fn, pergunta) {
    if (pergunta && !confirm(pergunta)) return;
    try { await fn(); await carregar(); } catch (e) { alert(e.message); }
  }

  // ---------- desenho ----------
  function numeros(t) {
    return el('div', { class: 'ptl-mini' },
      el('span', { class: 'falta' }, el('b', {}, t.faltam), 'faltam'),
      el('span', {}, el('b', {}, t.subidos), 'subidas'),
      el('span', { class: 'ok' }, el('b', {}, t.entregues), 'entregues'));
  }

  // Lojas lidas do remetente das etiquetas: quantidade e a lista de etiquetas de cada uma.
  const abertas = new Set(); // lojas abertas (para não fechar quando a tela atualiza)
  function lojasDoCliente(c) {
    if (!c.porLoja.length) return el('p', { class: 'nota' }, 'As lojas aparecem aqui quando o cliente subir as etiquetas.');
    const pacs = dados.pacotes.filter((p) => p.cliente === c.id);
    return el('div', { class: 'ptl-lojas-lista' }, c.porLoja.map((l) => {
      const chave = `${c.id}|${l.loja}`;
      const dela = pacs.filter((p) => (p.loja || 'Sem loja') === l.loja)
        .sort((a, b) => Boolean(a.entregueEm) - Boolean(b.entregueEm) || String(b.subidoEm).localeCompare(String(a.subidoEm)));
      const d = el('details', { class: 'ptl-loja', open: abertas.has(chave) },
        el('summary', {},
          el('span', { class: 'ptl-loja-nome' }, l.loja),
          el('span', { class: 'ptl-loja-num' }, `${l.subidos} etiqueta${l.subidos === 1 ? '' : 's'}`),
          el('span', { class: 'ptl-loja-num ok' }, `${l.entregues} entregue${l.entregues === 1 ? '' : 's'}`),
          el('span', { class: 'ptl-loja-num falta' }, `${l.faltam} falta${l.faltam === 1 ? '' : 'm'}`)),
        el('ul', { class: 'ptl-etiquetas' }, dela.map((p) => el('li', {},
          el('code', {}, p.codigo),
          p.entregueEm ? el('span', { class: 'ptl-selo ok' }, `entregue ${quando(p.entregueEm)}`) : el('span', { class: 'ptl-selo fila' }, 'falta entregar'),
          p.spx === 'erro' ? el('span', { class: 'ptl-selo erro', title: p.spxErro || '' }, 'erro no SPX') : null))));
      d.addEventListener('toggle', () => { if (d.open) abertas.add(chave); else abertas.delete(chave); });
      return d;
    }));
  }

  function cartaoCliente(c) {
    const emEdicao = editando === c.id;
    return el('article', { class: `ptl-cliente${c.ativo ? '' : ' inativo'}` },
      el('div', { class: 'ptl-cliente-topo' },
        el('div', {}, el('h3', {}, c.nome, c.ativo ? null : el('span', { class: 'ptl-selo' }, 'desativado')),
          el('p', { class: 'nota' }, c.ultimoEnvio ? `Último envio: ${quando(c.ultimoEnvio)}` : 'Ainda não subiu etiquetas')),
        numeros(c.totais)),
      lojasDoCliente(c),
      emEdicao ? el('form', {
        class: 'ptl-editar',
        onsubmit: (ev) => { ev.preventDefault(); acao(async () => { await api(`/portal/clientes/${c.id}`, { method: 'PUT', body: { nome: ev.target.nome.value } }); editando = null; }); }
      },
      el('div', { class: 'campo' }, el('label', {}, 'Nome'), el('input', { type: 'text', name: 'nome', value: c.nome, maxlength: '60' })),
      el('div', { class: 'ptl-acoes' }, el('button', { type: 'submit', class: 'botao-principal botao-medio' }, 'Salvar'),
        el('button', { type: 'button', class: 'botao-secundario', onclick: () => { editando = null; desenhar(); } }, 'Cancelar'))) : null,
      el('div', { class: 'ptl-link' },
        el('code', {}, c.ativo ? linkDe(c) : 'Link desativado'),
        c.ativo ? el('button', { type: 'button', class: 'botao-secundario', onclick: () => copiar(linkDe(c), 'Link copiado.') }, 'Copiar link') : null),
      el('div', { class: 'ptl-acoes' },
        el('button', { type: 'button', class: 'botao-texto', onclick: () => { editando = c.id; desenhar(); } }, 'Editar nome'),
        el('button', { type: 'button', class: 'botao-texto', onclick: () => acao(() => api(`/portal/clientes/${c.id}/link`, { method: 'POST' }), `Gerar um link novo para ${c.nome}? O link antigo para de funcionar na hora.`) }, 'Gerar link novo'),
        el('button', { type: 'button', class: 'botao-texto', onclick: () => acao(() => api(`/portal/clientes/${c.id}`, { method: 'PUT', body: { ativo: !c.ativo } }), c.ativo ? `Desativar o link de ${c.nome}? Ele não consegue mais entrar até você ativar de novo.` : null) }, c.ativo ? 'Desativar link' : 'Ativar link'),
        el('button', { type: 'button', class: 'botao-texto perigo', onclick: () => acao(() => api(`/portal/clientes/${c.id}`, { method: 'DELETE' }), `Excluir ${c.nome}? O link para de funcionar e os pacotes dele saem do sistema. Não dá para desfazer.`) }, 'Excluir cliente')));
  }

  function desenhar() {
    if (!dados) return;
    const tot = dados.clientes.reduce((a, c) => ({ faltam: a.faltam + c.totais.faltam, subidos: a.subidos + c.totais.subidos, entregues: a.entregues + c.totais.entregues, erro: a.erro + c.totais.erroSpx }), { faltam: 0, subidos: 0, entregues: 0, erro: 0 });
    const naFila = dados.fila.reduce((a, l) => a + l.quantidade, 0);
    $('#ptl-resumo').replaceChildren(
      el('div', { class: 'falta' }, el('b', {}, tot.faltam), 'faltam entregar'),
      el('div', {}, el('b', {}, naFila), 'na fila para o SPX'),
      el('div', { class: 'ok' }, el('b', {}, tot.entregues), 'entregues'),
      el('div', {}, el('b', {}, dados.clientes.length), 'clientes'));

    // fila
    $('#ptl-fila-nota').textContent = 'A extensão Subir Etiquetas, aberta no SPX, pega estes lotes';
    trocar($('#ptl-fila'),
      dados.fila.length ? el('ul', { class: 'ptl-fila' }, dados.fila.map((l) => el('li', {},
        el('strong', {}, l.cliente), ` · ${l.quantidade} etiqueta(s) · enviado ${quando(l.criadoEm)}`,
        el('span', { class: 'nota ptl-fila-lojas' }, Object.entries(l.lojas || {}).map(([n, cs]) => `${n}: ${cs.length}`).join(' · ')),
        el('span', { class: `ptl-selo ${l.situacao === 'reservado' ? '' : 'alerta'}` }, l.situacao === 'reservado' ? 'subindo no SPX…' : 'aguardando')))) :
        el('p', { class: 'nota' }, 'Nenhum lote esperando. Tudo que os clientes subiram já foi para o SPX.'),
      tot.erro ? el('p', { class: 'nota erro' }, `${tot.erro} etiqueta(s) deram erro no SPX. `,
        el('button', { type: 'button', class: 'botao-texto', onclick: () => acao(() => api('/portal/tentar-de-novo', { method: 'POST', body: {} })) }, 'Mandar de novo para a fila')) : null);

    // clientes
    $('#ptl-clientes').replaceChildren(...(dados.clientes.length ? dados.clientes.map(cartaoCliente)
      : [el('p', { class: 'tabela-vazia' }, 'Nenhum cliente ainda. Clique em "+ Novo cliente".')]));

    // filtro de clientes
    const fc = $('#ptl-f-cliente'); const atual = fc.value;
    fc.replaceChildren(el('option', { value: '' }, 'Todos os clientes'), ...dados.clientes.map((c) => el('option', { value: c.id }, c.nome)));
    fc.value = dados.clientes.some((c) => c.id === atual) ? atual : '';

    // pacotes
    const sit = $('#ptl-f-sit').value;
    const lista = dados.pacotes.filter((p) => (!fc.value || p.cliente === fc.value)
      && (sit === 'todos' || (sit === 'faltam' && !p.entregueEm) || (sit === 'entregues' && p.entregueEm) || (sit === 'erro' && p.spx === 'erro')));
    $('#ptl-pacotes').replaceChildren(...(lista.length ? lista.slice(0, 500).map((p) => {
      const [rot, cls] = SPX[p.spx] || ['—', ''];
      return el('tr', {},
        el('td', { class: 'mono' }, p.codigo), el('td', {}, p.clienteNome),
        el('td', {}, p.loja || '—'),
        el('td', {}, quando(p.subidoEm)),
        el('td', { title: p.spxErro || '' }, el('span', { class: `ptl-selo ${cls}` }, rot)),
        el('td', {}, p.entregueEm ? quando(p.entregueEm) : el('span', { class: 'falta' }, 'falta')),
        el('td', {}, p.entregueEm ? el('button', { type: 'button', class: 'botao-texto', onclick: () => acao(() => api('/portal/desfazer', { method: 'POST', body: { codigo: p.codigo } })) }, 'desfazer') : null));
    }) : [el('tr', {}, el('td', { colspan: '7', class: 'tabela-vazia' }, 'Nenhum pacote com esse filtro.'))]));
  }
  $('#ptl-f-cliente').addEventListener('change', desenhar);
  $('#ptl-f-sit').addEventListener('change', desenhar);

  async function carregar() {
    try { dados = await api('/portal'); desenhar(); } catch (e) {
      $('#ptl-clientes').replaceChildren(el('p', { class: 'tabela-vazia' }, e.message));
    }
  }

  window.goboxPortal = {
    abrir() {
      carregar();
      clearInterval(timer);
      timer = setInterval(() => { if (!document.hidden && editando === null && $('#ptl-novo').hidden) carregar(); }, 15_000);
      setTimeout(() => $('#ptl-bip').focus(), 50);
    },
    fechar() { clearInterval(timer); timer = null; }
  };
  if (location.hash === '#etiquetas' && !$('#aba-etiquetas').hidden) window.goboxPortal.abrir();
}());
