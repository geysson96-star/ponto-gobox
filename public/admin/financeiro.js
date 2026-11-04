'use strict';
// Aba Financeiro do painel: total do mês e de cada empresa, atualizado a cada 30 s.
(function () {
  const $ = (s) => document.querySelector(s);
  const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const num = (n) => Number(n || 0).toLocaleString('pt-BR');
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
    if (o.body) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(o.body); }
    const r = await fetch('/admin/api' + path, o);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.erro || 'Não consegui carregar o financeiro.');
    return d;
  }

  const NOME = { shopee: 'Shopee SPX', ml: 'Mercado Livre', correios: 'Correios' };
  const ITENS = {
    shopee: [['expedidos', 'Total expedido', 'Drop-offs coletados pela Shopee no mês. Faixas por quantidade.'],
      ['retiradas', 'Retiradas do comprador', 'Retiradas feitas no mês. Mesmas faixas, contadas à parte.'],
      ['devolucoes', 'Devoluções do comprador', 'R$ 0,80 cada. O portal não mostra: lance em Ajuste.']],
    ml: [['delivery', 'Delivery', 'R$ 2,60 por pacote'], ['pickup', 'Pick Up', 'R$ 0,65 por pacote'],
      ['falhas', 'Falhas de entrega', 'R$ 0,65 cada. Lance em Ajuste.'], ['nex', 'NEx', 'R$ 10,00 por rota. Lance em Ajuste.']],
    correios: [['pacotes', 'Pacotes', 'R$ 1,20 por pacote']]
  };
  const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  const nomeMes = (m) => { const [a, n] = m.split('-').map(Number); return `${MESES[n - 1][0].toUpperCase()}${MESES[n - 1].slice(1)} de ${a}`; };

  let dados = null;
  let mes = null;
  let timer = null;
  let ultimoTotal = null;
  let editando = false;

  function preencherMeses(atual) {
    const sel = $('#fin-mes');
    if (sel.options.length) return;
    const [a, m] = atual.split('-').map(Number);
    for (let i = 0; i < 12; i += 1) {
      const d = new Date(Date.UTC(a, m - 1 - i, 1));
      const v = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
      sel.append(el('option', { value: v }, nomeMes(v)));
    }
    sel.value = atual;
    sel.addEventListener('change', () => { mes = sel.value; carregar(); });
  }

  function qtd(fonte, item, quinzena) {
    const q = dados.quantidades[fonte];
    return fonte === 'ml' ? q[quinzena][item] : q[item];
  }
  function valorItem(fonte, item, quinzena) {
    if (fonte === 'shopee') return dados.shopee.itens[item];
    if (fonte === 'ml') return dados.ml[quinzena].itens[item];
    return dados.correios.total;
  }
  function campoAjuste(fonte, item, quinzena) {
    const a = fonte === 'ml' ? dados.ajustes.ml[quinzena][item] : dados.ajustes[fonte][item];
    const auto = fonte === 'ml' ? dados.automatico.ml[quinzena][item] : dados.automatico[fonte][item];
    const id = `fin-aj-${fonte}-${quinzena || 'm'}-${item}`;
    const input = el('input', { id, type: 'number', step: '1', inputmode: 'numeric', value: String(a), 'aria-label': 'Ajuste' });
    input.dataset.fonte = fonte; input.dataset.item = item; if (quinzena) input.dataset.q = quinzena;
    input.addEventListener('focus', () => { editando = true; });
    input.addEventListener('blur', () => { editando = false; });
    input.addEventListener('change', salvarAjustes);
    return el('div', { class: 'fin-ajuste' },
      el('span', { class: 'nota' }, `Automático ${num(auto)}`),
      el('label', { for: id }, 'Ajuste'), input);
  }
  function linha(fonte, [item, nome, desc], quinzena) {
    return el('div', { class: 'fin-linha' },
      el('div', { class: 'fin-linha-topo' },
        el('div', {}, el('div', { class: 'fin-item' }, nome), el('div', { class: 'nota' }, `${num(qtd(fonte, item, quinzena))} · ${desc}`)),
        el('div', { class: 'fin-item-valor' }, brl(valorItem(fonte, item, quinzena)))),
      campoAjuste(fonte, item, quinzena));
  }

  function cartaoShopee() {
    const s = dados.shopee;
    const sel = el('select', { id: 'fin-medalha', 'aria-label': 'Medalha do mês' },
      Object.entries(dados.medalhas).map(([id, m]) => el('option', { value: id, selected: id === s.medalha }, m.nome)));
    sel.addEventListener('change', () => salvarMedalha({ medalha: sel.value }));
    const m = dados.medalhas[s.medalha];
    const pct = el('input', { id: 'fin-med-pct', type: 'number', step: '0.1', min: '0', value: String(m.percentual), 'aria-label': 'Acréscimo em porcentagem' });
    const fixo = el('input', { id: 'fin-med-fixo', type: 'number', step: '1', min: '0', value: String(m.fixo), 'aria-label': 'Bônus fixo em reais' });
    const salvarValores = () => salvarMedalha({ valores: { [s.medalha]: { percentual: pct.value, fixo: fixo.value } } });
    for (const i of [pct, fixo]) {
      i.addEventListener('focus', () => { editando = true; });
      i.addEventListener('blur', () => { editando = false; });
      i.addEventListener('change', salvarValores);
    }
    return el('article', { class: 'fin-cartao' },
      el('div', { class: 'fin-cartao-topo' },
        el('div', {}, el('h2', {}, el('span', { class: 'fin-ponto shopee' }), NOME.shopee), el('div', { class: 'nota' }, 'Mês inteiro')),
        el('div', { class: 'fin-cartao-total' }, brl(s.total))),
      ITENS.shopee.map((i) => linha('shopee', i)),
      el('div', { class: 'fin-medalha' },
        el('label', { for: 'fin-medalha' }, 'Medalha do mês'), sel,
        el('div', { class: 'fin-medalha-valores' },
          el('label', { for: 'fin-med-pct' }, 'Acréscimo'), pct, '%',
          el('label', { for: 'fin-med-fixo' }, '+ R$'), fixo),
        el('p', { class: 'nota' }, `Sem medalha ${brl(s.base)} · bônus ${m.nome} ${brl(s.bonusMedalha)}`)));
  }
  function cartaoMl() {
    const qa = dados.mes === dados.mesAtual ? dados.quinzenaAtual : 'q2';
    const blocos = [['q1', `1 a 15`], ['q2', `16 a ${dados.ultimoDia}`]].map(([q, rot]) =>
      el('details', { class: 'fin-quinzena', open: q === qa },
        el('summary', {}, el('span', {}, `Quinzena ${rot}`), el('strong', {}, brl(dados.ml[q].total))),
        ITENS.ml.map((i) => linha('ml', i, q))));
    return el('article', { class: 'fin-cartao' },
      el('div', { class: 'fin-cartao-topo' },
        el('div', {}, el('h2', {}, el('span', { class: 'fin-ponto ml' }), NOME.ml), el('div', { class: 'nota' }, 'Fecha por quinzena')),
        el('div', { class: 'fin-cartao-total' }, brl(dados.ml.total))),
      blocos);
  }
  function cartaoCorreios() {
    return el('article', { class: 'fin-cartao' },
      el('div', { class: 'fin-cartao-topo' },
        el('div', {}, el('h2', {}, el('span', { class: 'fin-ponto correios' }), NOME.correios), el('div', { class: 'nota' }, 'Mês inteiro')),
        el('div', { class: 'fin-cartao-total' }, brl(dados.correios.total))),
      ITENS.correios.map((i) => linha('correios', i)));
  }

  function desenhar() {
    const d = dados;
    const tot = $('#fin-total');
    tot.textContent = brl(d.total);
    if (ultimoTotal !== null && d.total > ultimoTotal) { tot.classList.remove('fin-subiu'); void tot.offsetWidth; tot.classList.add('fin-subiu'); }
    ultimoTotal = d.total;
    $('#fin-meta').textContent = `${num(d.pacotes)} pacotes em ${nomeMes(d.mes).toLowerCase()}`;
    const partes = [['shopee', d.shopee.total], ['ml', d.ml.total], ['correios', d.correios.total]];
    $('#fin-partes').replaceChildren(...partes.map(([k, v]) => el('span', {}, NOME[k], el('b', {}, brl(v)))));
    $('#fin-barra').replaceChildren(...partes.map(([k, v]) => {
      const i = el('i', { class: k, title: NOME[k] }); i.style.width = `${d.total ? (v / d.total) * 100 : 0}%`; return i;
    }));
    if (!editando) $('#fin-cartoes').replaceChildren(cartaoShopee(), cartaoMl(), cartaoCorreios());

    const lista = $('#fin-ultimos');
    lista.replaceChildren(...(d.ultimos.length ? d.ultimos.map((u) => el('li', {},
      el('span', { class: `fin-ponto ${u.fonte}` }),
      el('span', { class: 'fin-u-txt' }, `${NOME[u.fonte]} · ${u.item}`, el('small', {}, u.codigo)),
      el('time', {}, new Date(u.em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })),
      el('b', {}, `+${brl(u.valor)}`)))
      : [el('li', { class: 'nota' }, 'Nenhum pacote contado neste mês ainda. Eles aparecem aqui assim que a extensão sincronizar os portais.')]));
    $('#fin-atualizado').textContent = `Atualizado às ${new Date(d.agora).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;

    const v = d.valores;
    const faixas = v.faixasShopee.map(([q, r], i, arr) => {
      const ini = arr.slice(0, i).reduce((s, [x]) => s + (x || 0), 0) + 1;
      return q ? `${num(ini)} a ${num(ini + q - 1)}: ${brl(r)}` : `acima de ${num(ini - 1)}: ${brl(r)}`;
    }).join(' · ');
    $('#fin-regras').replaceChildren(
      el('p', {}, el('strong', {}, 'Shopee. '), `Conta o que saiu no mês: total expedido (menos devoluções) e retiradas feitas, cada um pela tabela de faixas: ${faixas}. Devoluções ${brl(v.devolucaoShopee)} cada. A medalha soma um percentual e um bônus fixo ao total.`),
      el('p', {}, el('strong', {}, 'Mercado Livre. '), `Delivery ${brl(v.ml.delivery)}, Pick Up ${brl(v.ml.pickup)}, falhas ${brl(v.ml.falhas)}, NEx ${brl(v.ml.nex)} por rota. Fecha por quinzena. O site conta Pick Up (retiradas) e Delivery (os demais pacotes) automaticamente.`),
      el('p', {}, el('strong', {}, 'Correios. '), `${brl(v.correios)} por pacote.`),
      el('p', { class: 'nota' }, 'Ajuste soma ou subtrai da contagem automática. Use para lançar o que o portal não mostra, ou para igualar ao número oficial da empresa.'));
  }

  async function carregar() {
    try {
      dados = await api(`/financeiro${mes ? `?mes=${mes}` : ''}`);
      if (!mes) mes = dados.mes;
      preencherMeses(dados.mesAtual);
      desenhar();
    } catch (e) {
      $('#fin-cartoes').replaceChildren(el('p', { class: 'nota erro' }, e.message));
    }
  }
  async function salvarAjustes() {
    const corpo = { shopee: {}, ml: { q1: {}, q2: {} }, correios: {} };
    for (const i of document.querySelectorAll('#fin-cartoes [data-fonte]')) {
      const v = Number(i.value) || 0;
      if (i.dataset.fonte === 'ml') corpo.ml[i.dataset.q][i.dataset.item] = v;
      else corpo[i.dataset.fonte][i.dataset.item] = v;
    }
    try { editando = false; dados = await api(`/financeiro/${dados.mes}/ajustes`, { method: 'PUT', body: corpo }); desenhar(); }
    catch (e) { window.alert(e.message); }
  }
  async function salvarMedalha(corpo) {
    try { editando = false; dados = await api(`/financeiro/${dados.mes}/medalha`, { method: 'PUT', body: corpo }); desenhar(); }
    catch (e) { window.alert(e.message); }
  }

  window.goboxFinanceiro = {
    abrir() { carregar(); clearInterval(timer); timer = setInterval(() => { if (!document.hidden) carregar(); }, 30_000); },
    fechar() { clearInterval(timer); timer = null; }
  };
}());
