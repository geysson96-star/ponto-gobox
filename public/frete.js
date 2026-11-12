'use strict';
// Página pública de cotação de fretes. O servidor calcula e devolve só o preço final.
(function () {
  // Número do WhatsApp da GoBox com DDI e DDD, só dígitos (ex.: '5579999999999').
  // Vazio: o WhatsApp abre para a pessoa escolher o contato.
  const WHATSAPP = '557999579897';

  const UFS = { AC: 'Acre', AL: 'Alagoas', AM: 'Amazonas', AP: 'Amapá', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal', ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MG: 'Minas Gerais', MS: 'Mato Grosso do Sul', MT: 'Mato Grosso', PA: 'Pará', PB: 'Paraíba', PE: 'Pernambuco', PI: 'Piauí', PR: 'Paraná', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RO: 'Rondônia', RR: 'Roraima', RS: 'Rio Grande do Sul', SC: 'Santa Catarina', SE: 'Sergipe', SP: 'São Paulo', TO: 'Tocantins' };
  const ICONES = {
    eco: 'M3 7.5 12 3l9 4.5v9L12 21l-9-4.5zM3 7.5 12 12l9-4.5M12 12v9',
    exp: 'M13 3 4 14h7l-1 7 9-11h-7z',
    pre: 'M2.5 13.5 21 6l-4.5 13-4.5-5-4 3 1-5zM12 14l9-8',
    std: 'M3 9h8v11H3zM13 4h8v16h-8z'
  };
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const brl = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const kg = (v) => `${(Math.round(v * 100) / 100).toLocaleString('pt-BR')} kg`;
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
  function icone(id) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', ICONES[id]); p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '1.8'); p.setAttribute('stroke-linejoin', 'round'); p.setAttribute('stroke-linecap', 'round');
    svg.append(p);
    return el('div', { class: 'fr-icone' }, svg);
  }
  function aviso(t) { const a = $('#fr-aviso'); a.textContent = t; a.classList.add('on'); clearTimeout(aviso.t); aviso.t = setTimeout(() => a.classList.remove('on'), 1800); }
  async function post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.erro || 'Não consegui calcular agora. Tente de novo.');
    return d;
  }

  // ---------- formulário ----------
  $('#fr-uf').replaceChildren(...Object.entries(UFS).map(([k, n]) => el('option', { value: k, selected: k === 'SP' }, n)));
  let tipo = 'C';
  const bases = {};
  let escolhido = null;
  let ultimo = null;

  const num = (id) => { const v = parseFloat($(id).value); return Number.isFinite(v) && v > 0 ? v : 0; };
  function pedido() {
    const uf = $('#fr-uf').value;
    return {
      uf, tipo, peso: num('#fr-peso'), valor: num('#fr-valor'),
      altura: num('#fr-alt'), largura: num('#fr-lar'), comprimento: num('#fr-com'),
      embalagem: parseFloat($('#fr-emb').value) || 0, documento: $('#fr-doc').checked, base: bases[uf] || ''
    };
  }

  function destino(d) {
    return d.tipo === 'C' ? `${d.capital} (${d.uf})` : `${d.tipo === 'I' ? 'Interior' : 'Interior distante'} de ${d.estado}`;
  }

  function desenhar(r) {
    ultimo = r;
    $('#fr-erro').hidden = true;
    const p = r.peso;
    $('#fr-cubado').replaceChildren(p.cobrado > p.real
      ? el('b', {}, `Pelo tamanho, sua caixa conta como ${kg(p.cobrado)}.`)
      : 'Caixas grandes e leves pagam pelo tamanho.');
    $('#fr-sub').textContent = `Para ${destino(r.destino)} · ${kg(p.cobrado)} · produto de ${brl(pedido().valor)}`;
    const ok = r.opcoes.filter((o) => !o.indisponivel).sort((a, b) => a.preco - b.preco);
    const melhor = ok[0] && ok[0].id;
    const lista = [...ok, ...r.opcoes.filter((o) => o.indisponivel)];
    $('#fr-cartoes').replaceChildren(...lista.map((o) => cartao(o, o.id === melhor, p)));
    if (escolhido && !ok.find((o) => o.id === escolhido)) { escolhido = null; $('#fr-resumo').replaceChildren(); }
  }

  function cartao(o, melhor, p) {
    const titulo = el('h3', {}, o.nome, el('span', { class: 'fr-tag' }, o.tag), melhor ? el('span', { class: 'fr-selo' }, 'Mais barato') : null);
    const esq = el('div', { class: 'fr-cartao-esq' }, icone(o.id), el('div', {}, titulo, el('p', {}, o.descricao)));
    if (o.indisponivel) {
      return el('article', { class: 'fr-cartao off' }, el('div', { class: 'fr-cartao-topo' }, esq, el('div', { class: 'fr-cartao-dir' }, el('span', { class: 'fr-indisp' }, o.indisponivel))));
    }
    const dir = el('div', { class: 'fr-cartao-dir' },
      el('span', { class: 'fr-preco' }, brl(o.preco)),
      el('button', { type: 'button', class: 'fr-botao', onclick: () => contratar(o.id) }, 'Contratar'));
    let base = null;
    if (o.bases) {
      const sel = el('select', { id: 'fr-base', onchange: (e) => { bases[$('#fr-uf').value] = e.target.value; cotar(); } },
        o.bases.map((b) => el('option', { value: b.codigo, selected: b.codigo === o.base }, b.cidade)));
      base = el('div', { class: 'fr-base' }, el('label', { for: 'fr-base' }, 'Cidade-base de destino'), sel);
    }
    const inc = el('details', { class: 'fr-inc' }, el('summary', {}, 'O que está incluso'), el('ul', {},
      el('li', {}, el('b', {}, 'Peso cobrado: '), o.faixa, p.cobrado > p.real ? ' (pelo tamanho)' : ''),
      el('li', {}, el('b', {}, 'Seguro: '), `${o.seguroPct.toLocaleString('pt-BR')}% do valor do produto`),
      el('li', {}, el('b', {}, 'Transporte'), ' da GoBox até a base da Azul em Aracaju'),
      el('li', {}, el('b', {}, 'Entrega'), ' no endereço do destinatário'),
      o.embalagem ? el('li', {}, el('b', {}, 'Embalagem: '), brl(o.embalagem)) : null,
      el('li', {}, el('b', {}, 'Atende: '), `${o.atende} · ${o.limites}`),
      el('li', {}, el('b', {}, 'Prazo: '), 'confirmado pela GoBox no WhatsApp')));
    return el('article', { class: `fr-cartao${melhor ? ' melhor' : ''}${escolhido === o.id ? ' escolhido' : ''}` },
      el('div', { class: 'fr-cartao-topo' }, esq, dir), base, inc);
  }

  async function contratar(id) {
    try {
      const r = await post('/api/fretes/contratar', { ...pedido(), servico: id });
      escolhido = id;
      if (ultimo) desenhar(ultimo);
      const link = `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(r.mensagem)}`;
      const pre = el('pre', { id: 'fr-msg' }, r.mensagem);
      const caixa = el('div', { class: 'fr-resumo' },
        el('div', { class: 'fr-resumo-topo' },
          el('div', {}, el('small', {}, 'Resumo do envio'), el('h3', {}, `${r.servico} para ${destino(ultimo.destino)}`)),
          el('span', { class: 'fr-preco' }, brl(r.preco))),
        el('ol', {}, el('li', {}, 'Envie a cotação para a GoBox no WhatsApp'), el('li', {}, 'Traga o pacote na agência e pague no balcão'), el('li', {}, 'Receba o código de rastreio da Azul')),
        pre,
        el('div', { class: 'fr-acoes' },
          el('a', { class: 'fr-botao', href: link, target: '_blank', rel: 'noopener' }, 'Enviar no WhatsApp'),
          el('button', { type: 'button', class: 'fr-botao fr-botao-2', onclick: () => copiar(r.mensagem) }, 'Copiar')));
      $('#fr-resumo').replaceChildren(caixa);
      caixa.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) { erro(e.message); }
  }
  function copiar(t) {
    if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => aviso('Copiado'), () => aviso('Selecione o texto e copie'));
    else aviso('Selecione o texto e copie');
  }
  function erro(m) { const e = $('#fr-erro'); e.textContent = m; e.hidden = false; }

  let timer = null;
  let seq = 0;
  async function cotar() {
    const p = pedido();
    $('#fr-capital').textContent = ({ AC: 'Rio Branco', AL: 'Maceió', AM: 'Manaus', AP: 'Macapá', BA: 'Salvador', CE: 'Fortaleza', DF: 'Brasília', ES: 'Vitória', GO: 'Goiânia', MA: 'São Luís', MG: 'Belo Horizonte', MS: 'Campo Grande', MT: 'Cuiabá', PA: 'Belém', PB: 'João Pessoa', PE: 'Recife', PI: 'Teresina', PR: 'Curitiba', RJ: 'Rio de Janeiro', RN: 'Natal', RO: 'Porto Velho', RR: 'Boa Vista', RS: 'Porto Alegre', SC: 'Florianópolis', SE: 'Aracaju', SP: 'São Paulo', TO: 'Palmas' })[p.uf];
    if (!p.peso) { erro('Informe o peso do pacote.'); return; }
    const meu = ++seq;
    try {
      const r = await post('/api/fretes/cotar', p);
      if (meu === seq) desenhar(r);
    } catch (e) { if (meu === seq) erro(e.message); }
  }
  const agendar = () => { clearTimeout(timer); timer = setTimeout(cotar, 350); };
  $('#fr-form').addEventListener('input', agendar);
  $('#fr-form').addEventListener('submit', (e) => e.preventDefault());
  for (const b of $$('#fr-tipo button')) {
    b.addEventListener('click', () => {
      tipo = b.dataset.v;
      for (const x of $$('#fr-tipo button')) x.setAttribute('aria-pressed', String(x === b));
      cotar();
    });
  }
  cotar();
})();
