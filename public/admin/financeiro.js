'use strict';
// Aba Financeiro do painel: total do mês e de cada empresa, atualizado a cada 30 s.
(function () {
  const $ = (s) => document.querySelector(s);
  const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const num = (n) => Number(n || 0).toLocaleString('pt-BR');

  // Olho: oculta os valores ganhos (as tarifas nas regras continuam visíveis).
  // A escolha fica salva neste navegador.
  let oculto = false;
  try { oculto = localStorage.getItem('gobox-fin-oculto') === '1'; } catch { /* sem armazenamento */ }
  const val = (v) => (oculto ? 'R$ ••••••' : brl(v));
  const OLHO_ABERTO = '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
  const OLHO_FECHADO = '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.6 5.1A10.6 10.6 0 0 1 12 5c6.4 0 10 7 10 7a17.5 17.5 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function atualizarOlho() {
    const b = document.getElementById('fin-olho');
    if (!b) return;
    b.innerHTML = oculto ? OLHO_FECHADO : OLHO_ABERTO;
    b.setAttribute('aria-pressed', String(oculto));
    b.setAttribute('aria-label', oculto ? 'Mostrar valores' : 'Ocultar valores');
    b.title = oculto ? 'Mostrar valores' : 'Ocultar valores';
    const aba = document.getElementById('aba-financeiro');
    if (aba) aba.classList.toggle('fin-valores-ocultos', oculto);
  }
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
    shopee: [['expedidos', 'Total expedido', 'Drop-off: Total Outbounded no mês. Faixas por quantidade.'],
      ['retiradas', 'Retiradas do comprador', 'Self-collection: Total de recebidos no mês. Mesmas faixas, contadas à parte.'],
      ['devolucoes', 'Devoluções do comprador', 'Self-collection: Total de saídas (comprador coletou). R$ 0,80 cada, descontadas do expedido.']],
    ml: [['delivery', 'Delivery', 'R$ 2,60 por pacote'], ['pickup', 'Pick Up', 'R$ 0,65 por pacote'],
      ['falhas', 'Falhas de entrega', 'R$ 0,65 cada'], ['nex', 'NEx', 'R$ 10,00 por rota']],
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
  function textoBase(fonte, item, quinzena) {
    if (fonte === 'ml' && dados.ml[quinzena].fonte === 'oficial') {
      const q = dados.ml[quinzena];
      const est = !q.estimadoDia.incluido ? 0 : item === 'delivery' ? q.estimadoDia.delivery : item === 'pickup' ? q.estimadoDia.pickup : 0;
      const of = q.quantidades[item] - est - dados.ajustes.ml[quinzena][item];
      return est ? `Oficial ${num(of)} + hoje ${num(est)}` : `Oficial ${num(of)}`;
    }
    const auto = fonte === 'ml' ? dados.automatico.ml[quinzena][item] : dados.automatico[fonte][item];
    if (fonte === 'shopee' && dados.shopee.portal && (item !== 'devolucoes' || dados.shopee.portal.devolucoes)) return `Portal ${num(auto)}`;
    return `Automático ${num(auto)}`;
  }
  function campoAjuste(fonte, item, quinzena) {
    const a = fonte === 'ml' ? dados.ajustes.ml[quinzena][item] : dados.ajustes[fonte][item];
    const id = `fin-aj-${fonte}-${quinzena || 'm'}-${item}`;
    const input = el('input', { id, type: 'number', step: '1', inputmode: 'numeric', value: String(a), 'aria-label': 'Ajuste' });
    input.dataset.fonte = fonte; input.dataset.item = item; if (quinzena) input.dataset.q = quinzena;
    input.addEventListener('focus', () => { editando = true; });
    input.addEventListener('blur', () => { editando = false; });
    input.addEventListener('change', salvarAjustes);
    return el('div', { class: 'fin-ajuste' },
      el('span', { class: 'nota' }, textoBase(fonte, item, quinzena)),
      el('label', { for: id }, 'Ajuste'), input);
  }
  function linha(fonte, [item, nome, desc], quinzena) {
    return el('div', { class: 'fin-linha' },
      el('div', { class: 'fin-linha-topo' },
        el('div', {}, el('div', { class: 'fin-item' }, nome), el('div', { class: 'nota' }, `${num(qtd(fonte, item, quinzena))} · ${desc}`)),
        el('div', { class: 'fin-item-valor' }, val(valorItem(fonte, item, quinzena)))),
      campoAjuste(fonte, item, quinzena));
  }

  function estimadoShopee() {
    const s = dados.shopee;
    const e = s.estimado;
    if (!e) return null;
    return el('div', { class: 'fin-origem' },
      el('div', {}, el('span', {}, 'Pago (expedido e retiradas feitas)'), el('strong', {}, val(s.pago))),
      el('div', { class: e.incluido ? '' : 'fin-desligado' },
        el('span', {}, `Recebimento estimado · recebidos no mês: ${num(e.recebidos)} drop-offs, ${num(e.retiradasRecebidas)} retiradas · ainda na agência: ${num(e.aguardandoColeta)} + ${num(e.aguardandoRetirada)}`),
        el('strong', {}, e.incluido ? `+${val(e.valor)}` : val(e.valor))),
      chaveEstimado('shopee', 'm', e.incluido));
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
        el('div', {}, el('h2', {}, el('span', { class: 'fin-ponto shopee' }), NOME.shopee),
          el('div', { class: 'nota' }, s.portal ? `Totais do portal, lidos em ${new Date(s.portal.lidoEm).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : 'Mês inteiro, contado pelos pacotes')),
        el('div', { class: 'fin-cartao-total' }, val(s.total))),
      estimadoShopee(),
      ITENS.shopee.map((i) => linha('shopee', i)),
      el('div', { class: 'fin-medalha' },
        el('label', { for: 'fin-medalha' }, 'Medalha do mês'), sel,
        el('div', { class: 'fin-medalha-valores' },
          el('label', { for: 'fin-med-pct' }, 'Acréscimo'), pct, '%',
          el('label', { for: 'fin-med-fixo' }, '+ R$'), fixo),
        el('p', { class: 'nota' }, `Sem medalha ${val(s.base)} · bônus ${m.nome} ${val(s.bonusMedalha)}`)));
  }
  // Chave para incluir ou não o estimado do dia no total do Mercado Livre.
  function chaveEstimado(fonte, q, ligado) {
    const id = `fin-estimado-${fonte}-${q}`;
    const input = el('input', { id, type: 'checkbox', role: 'switch', checked: ligado });
    input.addEventListener('change', async () => {
      input.disabled = true;
      try { dados = await api(`/financeiro/${dados.mes}/estimado`, { method: 'PUT', body: { fonte, ligado: input.checked } }); desenhar(); }
      catch (e) { input.checked = !input.checked; input.disabled = false; window.alert(e.message); }
    });
    return el('label', { class: 'fin-chave', for: id }, input, el('span', { class: 'fin-chave-trilho', 'aria-hidden': 'true' }),
      ligado ? 'Estimado entra na conta' : 'Estimado fora da conta (só o oficial)');
  }
  function cartaoMl() {
    const qa = dados.mes === dados.mesAtual ? dados.quinzenaAtual : 'q2';
    const dataBr = (iso) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const origem = (q) => {
      const m = dados.ml[q];
      if (m.fonte !== 'oficial') return el('p', { class: 'nota fin-origem' }, 'Sem o acumulado oficial desta quinzena: valor contado pelos pacotes que chegaram.');
      const e = m.estimadoDia;
      const partes = [`${num(e.delivery)} Delivery`, `${num(e.pickup)} Pick Up`];
      if (e.sacas) partes.push(`${num(e.sacas)} ${e.sacas === 1 ? 'saca' : 'sacas'}`);
      return el('div', { class: 'fin-origem' },
        el('div', {}, el('span', {}, 'Oficial do Mercado Livre'), el('strong', {}, val(m.oficial.total))),
        el('div', { class: e.incluido ? '' : 'fin-desligado' },
          el('span', {}, `Estimado desde ${dataBr(e.desde)} · ${partes.join(' · ')}`),
          el('strong', {}, e.incluido ? `+${val(e.valor)}` : val(e.valor))),
        chaveEstimado('ml', q, e.incluido),
        el('p', { class: 'nota' }, `Lido do portal em ${dataBr(m.oficial.lidoEm)}.${e.sacas ? ' Sacas aparecem para controle; os pacotes delas entram quando forem lidos no estoque.' : ''}`));
    };
    const blocos = [['q1', `1 a 15`], ['q2', `16 a ${dados.ultimoDia}`]].map(([q, rot]) =>
      el('details', { class: 'fin-quinzena', open: q === qa },
        el('summary', {}, el('span', {}, `Quinzena ${rot}`), el('strong', {}, val(dados.ml[q].total))),
        origem(q),
        ITENS.ml.map((i) => linha('ml', i, q))));
    return el('article', { class: 'fin-cartao' },
      el('div', { class: 'fin-cartao-topo' },
        el('div', {}, el('h2', {}, el('span', { class: 'fin-ponto ml' }), NOME.ml), el('div', { class: 'nota' }, 'Fecha por quinzena')),
        el('div', { class: 'fin-cartao-total' }, val(dados.ml.total))),
      blocos);
  }
  function cartaoCorreios() {
    return el('article', { class: 'fin-cartao' },
      el('div', { class: 'fin-cartao-topo' },
        el('div', {}, el('h2', {}, el('span', { class: 'fin-ponto correios' }), NOME.correios), el('div', { class: 'nota' }, 'Mês inteiro')),
        el('div', { class: 'fin-cartao-total' }, val(dados.correios.total))),
      ITENS.correios.map((i) => linha('correios', i)));
  }

  function desenhar() {
    const d = dados;
    const tot = $('#fin-total');
    tot.textContent = val(d.total);
    if (ultimoTotal !== null && d.total > ultimoTotal) { tot.classList.remove('fin-subiu'); void tot.offsetWidth; tot.classList.add('fin-subiu'); }
    ultimoTotal = d.total;
    $('#fin-meta').textContent = `${num(d.pacotes)} pacotes em ${nomeMes(d.mes).toLowerCase()}`;
    const partes = [['shopee', d.shopee.total], ['ml', d.ml.total], ['correios', d.correios.total]];
    $('#fin-partes').replaceChildren(...partes.map(([k, v]) => el('span', {}, NOME[k], el('b', {}, val(v)))));
    $('#fin-barra').replaceChildren(...partes.map(([k, v]) => {
      const i = el('i', { class: k, title: NOME[k] }); i.style.width = `${d.total ? (v / d.total) * 100 : 0}%`; return i;
    }));
    if (!editando) $('#fin-cartoes').replaceChildren(cartaoShopee(), cartaoMl(), cartaoCorreios());

    const lista = $('#fin-ultimos');
    lista.replaceChildren(...(d.ultimos.length ? d.ultimos.map((u) => el('li', {},
      el('span', { class: `fin-ponto ${u.fonte}` }),
      el('span', { class: 'fin-u-txt' }, `${NOME[u.fonte]} · ${u.item}`, el('small', {}, u.codigo)),
      el('time', {}, new Date(u.em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })),
      el('b', {}, `+${val(u.valor)}`)))
      : [el('li', { class: 'nota' }, 'Nenhum pacote contado neste mês ainda. Eles aparecem aqui assim que a extensão sincronizar os portais.')]));
    $('#fin-atualizado').textContent = `Atualizado às ${new Date(d.agora).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;

    const v = d.valores;
    const faixas = v.faixasShopee.map(([q, r], i, arr) => {
      const ini = arr.slice(0, i).reduce((s, [x]) => s + (x || 0), 0) + 1;
      return q ? `${num(ini)} a ${num(ini + q - 1)}: ${brl(r)}` : `acima de ${num(ini - 1)}: ${brl(r)}`;
    }).join(' · ');
    $('#fin-regras').replaceChildren(
      el('p', {}, el('strong', {}, 'Shopee. '), `Números do relatório da Shopee (Report Center › Reports), do dia 1 até hoje. Total expedido (Drop-off Total Outbounded, menos devoluções) e retiradas (Self-collection Total de recebidos), cada um pela tabela de faixas: ${faixas}. Devoluções (Self-collection Total de saídas, comprador coletou) ${brl(v.devolucaoShopee)} cada. A medalha soma um percentual e um bônus fixo ao total.`),
      el('p', {}, el('strong', {}, 'Mercado Livre. '), `Delivery ${brl(v.ml.delivery)}, Pick Up ${brl(v.ml.pickup)}, falhas ${brl(v.ml.falhas)}, NEx ${brl(v.ml.nex)} por rota. Fecha por quinzena. O painel usa o acumulado oficial da tela “Recebimento estimado” (lido pela extensão) e soma o estimado do que chegou depois da última atualização. Sem o oficial, conta os pacotes que chegaram.`),
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

  document.getElementById('fin-olho')?.addEventListener('click', () => {
    oculto = !oculto;
    try { localStorage.setItem('gobox-fin-oculto', oculto ? '1' : '0'); } catch { /* sem armazenamento */ }
    atualizarOlho();
    if (dados) { editando = false; desenhar(); }
  });
  atualizarOlho();

  window.goboxFinanceiro = {
    abrir() { carregar(); clearInterval(timer); timer = setInterval(() => { if (!document.hidden) carregar(); }, 30_000); },
    fechar() { clearInterval(timer); timer = null; }
  };
}());
