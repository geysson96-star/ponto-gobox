'use strict';
// Telas novas do painel: Visão geral, Entregadores e Integrações e ajustes › Site público.
// Também cuida dos contadores do menu e de esconder itens do menu.
(function () {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
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
    if (r.status === 401) { location.reload(); throw new Error('Sessão expirada.'); }
    if (!r.ok) throw new Error(d.erro || 'Não consegui carregar agora. Tente de novo.');
    return d;
  }
  const num = (n) => Number(n || 0).toLocaleString('pt-BR');
  const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const ir = (aba) => () => window.goboxTrocarAba && window.goboxTrocarAba(aba);
  const quando = (iso) => {
    if (!iso) return 'nunca';
    const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (min < 1) return 'agora';
    if (min < 60) return `há ${min} min`;
    const h = Math.round(min / 60);
    return h < 24 ? `há ${h} h` : new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  };
  function aviso(id, msg) { const a = $(id); if (!a) return; a.textContent = msg || ''; a.hidden = !msg; }
  function contador(aba, n) {
    const c = $(`#contador-${aba}`);
    if (!c) return;
    c.textContent = n > 99 ? '99+' : String(n || '');
    c.hidden = !n;
  }

  // ================= Visão geral =================
  let vgTimer = null;
  function cartao(titulo, valor, detalhe, aba, extra) {
    return el('button', { type: 'button', class: `vg-cartao${extra ? ` ${extra}` : ''}`, onclick: ir(aba) },
      el('span', { class: 'vg-titulo' }, titulo),
      el('span', { class: 'vg-valor' }, valor),
      el('span', { class: 'vg-detalhe' }, detalhe));
  }
  function oculto() { try { return localStorage.getItem('gobox-fin-oculto') === '1'; } catch { return false; } }

  async function carregarInicio() {
    try {
      const d = await api('/visao-geral');
      aviso('#vg-aviso', '');
      $('#vg-data').textContent = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
      const pf = d.pacotes.porFonte;
      const nomes = { shopee: 'Shopee', ml: 'ML', correios: 'Correios' };
      $('#vg-cartoes').replaceChildren(
        cartao('Pacotes na agência', num(d.pacotes.total), Object.keys(nomes).map((k) => `${nomes[k]} ${num(pf[k])}`).join(' · '), 'pacotes'),
        cartao('Pesquisas no site hoje', num(d.acessos.consultas), `${num(d.acessos.visitantes)} pessoas · ${num(d.acessos.encontrados)} encontradas`, 'acessos'),
        cartao('Faturamento do mês', d.faturamento ? (oculto() ? 'R$ ••••••' : brl(d.faturamento.total)) : '—', d.faturamento ? `${num(d.faturamento.pacotes)} pacotes` : 'sem dados', 'financeiro'),
        cartao('Entregadores', num(d.entregadores.aprovado), d.entregadores.pendente ? `${num(d.entregadores.pendente)} aguardando aceite` : 'na equipe', 'motoboys', d.entregadores.pendente ? 'destaque' : '')
      );
      const itens = [];
      for (const f of d.fontes) {
        if (f.situacao === 'falhou') itens.push(['perigo', `${f.nome}: a última atualização falhou`, 'Ver pacotes', 'pacotes']);
        else if (f.situacao === 'desatualizado') itens.push(['alerta', `${f.nome} sem atualizar ${quando(f.ultima)}`, 'Ver pacotes', 'pacotes']);
        else if (f.situacao === 'sem_dados') itens.push(['alerta', `${f.nome} ainda sem dados. Abra o portal no Edge com a extensão ligada.`, 'Integrações', 'configuracoes']);
        if (f.pendentes) itens.push(['alerta', `${f.nome}: importação aguardando sua confirmação`, 'Revisar', 'importacoes']);
      }
      if (d.entregadores.pendente) itens.push(['alerta', `${d.entregadores.pendente} cadastro(s) de entregador aguardando aceite`, 'Entregadores', 'motoboys']);
      if (d.sacas.falhas) itens.push(['perigo', `${d.sacas.falhas} aviso(s) de sacas falharam no envio`, 'Chegada de sacas', 'sacas']);
      if (d.sacas.envios) itens.push(['ok', `${d.sacas.envios} envio(s) de sacas hoje${d.sacas.envioLigado ? '' : ' (aviso em modo teste)'}`, 'Chegada de sacas', 'sacas']);
      const art = { Correios: 'dos', Shopee: 'da' };
      for (const e of d.notasParaEmitir) itens.push(['alerta', `Nota fiscal ${art[e] || 'do'} ${e} pronta para emitir`, 'Notas fiscais', 'contabilidade']);
      if (d.persistencia === false) itens.push(['perigo', 'Cópia de segurança no Firebase desligada: os dados se perdem se o servidor reiniciar', 'Integrações', 'configuracoes']);
      if (!itens.length) itens.push(['ok', 'Tudo em dia por aqui.', null, null]);
      $('#vg-lista').replaceChildren(...itens.map(([tipo, texto, rotulo, aba]) => el('li', { class: `vg-item ${tipo}` },
        el('span', { class: 'vg-ponto', 'aria-hidden': 'true' }), el('span', null, texto),
        rotulo ? el('button', { type: 'button', class: 'botao-texto', onclick: ir(aba) }, rotulo) : null)));
      $('#vg-hora').textContent = `Atualizado às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
      contador('motoboys', d.entregadores.pendente);
      contador('sacas', d.sacas.falhas);
    } catch (e) { aviso('#vg-aviso', e.message); }
  }
  $('#vg-atualizar')?.addEventListener('click', carregarInicio);
  window.goboxInicio = {
    abrir() { carregarInicio(); clearInterval(vgTimer); vgTimer = setInterval(carregarInicio, 60_000); },
    fechar() { clearInterval(vgTimer); vgTimer = null; }
  };

  // ================= Entregadores =================
  const DN = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const ORDEM = [1, 2, 3, 4, 5, 6, 0];
  const FUNCAO = { entregador: 'Entregador', coletador: 'Coletador', ambos: 'Entregador e coletador' };
  let ent = null;
  let entFiltro = 'pendente';

  const telefone = (d) => (d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`);
  function diasDe(c) {
    const por = {};
    for (const h of c.horarios || []) { const [d, t] = h.split('-'); (por[d] = por[d] || []).push(t[0]); }
    return ORDEM.map((i) => DN[i]).filter((d) => por[d]).map((d) => `${d} (${por[d].join('')})`).join(' · ');
  }
  function estrelas(c) {
    const box = el('div', { class: 'estrelas', role: 'radiogroup', 'aria-label': 'Nota' });
    for (let i = 1; i <= 5; i++) {
      box.append(el('button', {
        type: 'button', class: i <= (c.nota || 0) ? 'on' : '', 'aria-label': `${i} de 5`, title: `${i} de 5`,
        onclick: () => mudar(c, { nota: c.nota === i ? 0 : i })
      }, '★'));
    }
    return box;
  }
  async function mudar(c, patch) {
    try { const r = await api(`/entregadores/${encodeURIComponent(c.id)}`, { method: 'PUT', body: patch }); Object.assign(c, r.cadastro); desenharEnt(); }
    catch (e) { aviso('#ent-aviso', e.message); }
  }
  async function excluir(c) {
    if (!confirm(`Excluir o cadastro de ${c.nome}? Não dá para desfazer.`)) return;
    try { await api(`/entregadores/${encodeURIComponent(c.id)}`, { method: 'DELETE' }); ent.cadastros = ent.cadastros.filter((x) => x.id !== c.id); desenharEnt(); }
    catch (e) { aviso('#ent-aviso', e.message); }
  }
  function cartaoEnt(c) {
    const nomeServ = Object.fromEntries(ent.config.servicos.map((s) => [s.id, s]));
    const zap = `https://wa.me/55${c.whatsapp}?text=${encodeURIComponent(`Olá, ${c.nome.split(' ')[0]}! Aqui é da GoBox, sobre o seu cadastro de entregador.`)}`;
    const acoes = [];
    if (c.situacao !== 'aprovado') acoes.push(el('button', { type: 'button', class: 'botao-principal botao-pequeno', onclick: () => mudar(c, { situacao: 'aprovado' }) }, 'Aceitar'));
    if (c.situacao !== 'recusado') acoes.push(el('button', { type: 'button', class: 'botao-secundario botao-pequeno', onclick: () => mudar(c, { situacao: 'recusado' }) }, c.situacao === 'aprovado' ? 'Tirar da equipe' : 'Recusar'));
    if (c.situacao === 'recusado') acoes.push(el('button', { type: 'button', class: 'botao-secundario botao-pequeno', onclick: () => mudar(c, { situacao: 'pendente' }) }, 'Voltar para análise'));
    acoes.push(el('a', { class: 'botao-zap botao-pequeno', href: zap, target: '_blank', rel: 'noopener' }, 'WhatsApp'));
    acoes.push(el('button', { type: 'button', class: 'botao-texto perigo', onclick: () => excluir(c) }, 'Excluir'));
    const anot = el('input', { class: 'ent-anotacao', maxlength: '300', placeholder: 'Anotação interna (ex.: conhece os povoados)', value: c.anotacao || '' });
    anot.addEventListener('change', () => mudar(c, { anotacao: anot.value }));
    return el('article', { class: 'ent-cartao' },
      el('div', { class: 'ent-topo' },
        el('div', null, el('h3', null, c.nome), el('span', { class: 'nota' }, `${FUNCAO[c.funcao] || 'Entregador'} · ${telefone(c.whatsapp)} · desde ${new Date(c.criadoEm).toLocaleDateString('pt-BR')}`)),
        c.situacao === 'aprovado' ? estrelas(c) : null),
      el('div', { class: 'ent-servicos' }, (c.servicos || []).map((id) => el('span', { class: 'ent-chip', title: nomeServ[id] && nomeServ[id].valor ? nomeServ[id].valor : '' }, nomeServ[id] ? nomeServ[id].nome : id))),
      el('dl', { class: 'ent-dados' },
        el('dt', null, 'Disponível'), el('dd', null, diasDe(c) || '—'),
        c.experiencia ? [el('dt', null, 'Experiência'), el('dd', null, c.experiencia)] : null,
        (c.apps || []).length ? [el('dt', null, 'Já rodou em'), el('dd', null, c.apps.join(', '))] : null,
        c.obs ? [el('dt', null, 'Observação'), el('dd', null, c.obs)] : null),
      anot,
      el('div', { class: 'ent-acoes' }, acoes));
  }
  function desenharEnt() {
    if (!ent) return;
    const serv = $('#ent-servico').value;
    const cont = { pendente: 0, aprovado: 0, recusado: 0 };
    for (const c of ent.cadastros) cont[c.situacao] = (cont[c.situacao] || 0) + 1;
    for (const k of Object.keys(cont)) $(`#ent-n-${k}`).textContent = cont[k] ? `(${cont[k]})` : '';
    contador('motoboys', cont.pendente);
    for (const b of $$('[data-ent]')) { if (b.dataset.ent === entFiltro) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }
    let lista = ent.cadastros.filter((c) => c.situacao === entFiltro && (!serv || (c.servicos || []).includes(serv)));
    // Com um serviço escolhido, os melhores primeiro (nota, depois quem tem mais horários).
    if (serv || entFiltro === 'aprovado') lista = lista.slice().sort((a, b) => (b.nota || 0) - (a.nota || 0) || (b.horarios || []).length - (a.horarios || []).length);
    const vazio = { pendente: 'Nenhum cadastro aguardando aceite.', aprovado: 'Ninguém na equipe ainda. Aceite um cadastro para ele aparecer aqui.', recusado: 'Nenhum cadastro recusado.' };
    $('#ent-lista').replaceChildren(...(lista.length ? lista.map(cartaoEnt) : [el('p', { class: 'vazio' }, vazio[entFiltro])]));
  }
  async function carregarEnt() {
    try {
      ent = await api('/entregadores');
      aviso('#ent-aviso', '');
      const sel = $('#ent-servico'); const atual = sel.value;
      sel.replaceChildren(el('option', { value: '' }, 'Todos'), ...ent.config.servicos.map((s) => el('option', { value: s.id }, s.nome)));
      sel.value = atual;
      desenharEnt();
    } catch (e) { aviso('#ent-aviso', e.message); }
  }
  for (const b of $$('[data-ent]')) b.addEventListener('click', () => { entFiltro = b.dataset.ent; desenharEnt(); });
  $('#ent-servico')?.addEventListener('change', desenharEnt);

  // Serviços e valores
  function linhaServico(s) {
    const dias = el('div', { class: 'ent-dias' }, ORDEM.map((i) => el('label', { class: 'dia' },
      el('input', { type: 'checkbox', value: String(i), checked: (s.dias || []).includes(i) }), el('span', null, DN[i]))));
    return el('fieldset', { class: 'ent-servico-cfg', 'data-id': s.id },
      el('div', { class: 'linha-2' },
        el('label', { class: 'campo' }, 'Nome', el('input', { name: 'nome', value: s.nome, maxlength: '60' })),
        el('label', { class: 'campo' }, 'Valor (só no painel)', el('input', { name: 'valor', value: s.valor || '', maxlength: '80', placeholder: 'Ex.: R$ 1,50 por pacote' }))),
      el('label', { class: 'campo' }, 'Descrição', el('input', { name: 'desc', value: s.desc || '', maxlength: '240' })),
      el('div', { class: 'linha-2' },
        el('label', { class: 'campo' }, 'Para', el('select', { name: 'para' }, ['Entregador', 'Coletador'].map((p) => el('option', { value: p, selected: s.para === p }, p)))),
        el('label', { class: 'campo' }, 'Observação dos dias', el('input', { name: 'obs', value: s.obs || '', maxlength: '80' }))),
      dias);
  }
  $('#ent-config-abrir')?.addEventListener('click', () => {
    if (!ent) return;
    $('#ent-config-servicos').replaceChildren(...ent.config.servicos.map(linhaServico));
    $('#ent-pag-titulo').value = ent.config.pagamento.titulo || '';
    $('#ent-pag-texto').value = ent.config.pagamento.texto || '';
    $('#ent-config-msg').textContent = '';
    $('#ent-config').showModal();
  });
  $('#ent-config-fechar')?.addEventListener('click', () => $('#ent-config').close());
  $('#ent-config-form')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const servicos = $$('#ent-config-servicos fieldset').map((f) => ({
      id: f.dataset.id,
      nome: f.querySelector('[name=nome]').value, valor: f.querySelector('[name=valor]').value,
      desc: f.querySelector('[name=desc]').value, para: f.querySelector('[name=para]').value, obs: f.querySelector('[name=obs]').value,
      dias: Array.from(f.querySelectorAll('.ent-dias input:checked')).map((i) => Number(i.value))
    }));
    try {
      const r = await api('/entregadores/config', { method: 'PUT', body: { servicos, pagamento: { titulo: $('#ent-pag-titulo').value, texto: $('#ent-pag-texto').value } } });
      ent.config = r.config;
      $('#ent-config-msg').textContent = 'Salvo. A página pública já mostra os dias novos.';
      desenharEnt();
    } catch (e) { $('#ent-config-msg').textContent = e.message; }
  });
  window.goboxEntregadores = { abrir: carregarEnt, fechar() {} };

  // ================= Site público e menu =================
  const NOMES_MENU = {
    inicio: 'Visão geral', pacotes: 'Pacotes na agência', sacas: 'Chegada de sacas', fretes: 'Cotação de fretes',
    ponto: 'Controle de ponto', motoboys: 'Entregadores', financeiro: 'Faturamento', contabilidade: 'Folha e notas fiscais', acessos: 'Estatísticas do site'
  };
  function aplicarMenu(ocultos) {
    for (const b of $$('.item-menu')) b.hidden = (ocultos || []).includes(b.dataset.aba);
    for (const g of $$('.grupo-menu')) g.hidden = !g.querySelector('.item-menu:not([hidden])');
  }
  function campo(nome) { return $(`#site-form [name="${nome}"]`); }
  async function carregarSite() {
    try {
      const { ajustes: a } = await api('/site');
      campo('aviso.ativo').checked = a.aviso.ativo; campo('aviso.texto').value = a.aviso.texto;
      campo('horario.ativo').checked = a.horario.ativo; campo('horario.linhas').value = a.horario.linhas.join('\n');
      campo('horario.endereco').value = a.horario.endereco; campo('horario.mapa').value = a.horario.mapa;
      campo('whatsapp.ativo').checked = a.whatsapp.ativo; campo('whatsapp.numero').value = a.whatsapp.numero; campo('whatsapp.mensagem').value = a.whatsapp.mensagem;
      campo('abas.frete').checked = a.abas.frete; campo('abas.entregador').checked = a.abas.entregador;
      campo('selos').checked = a.selos; campo('manutencao').checked = a.manutencao;
      $('#site-menu').replaceChildren(...Object.entries(NOMES_MENU).map(([id, nome]) => el('label', { class: 'site-menu-item' },
        el('input', { type: 'checkbox', value: id, checked: !a.menuOculto.includes(id) }), el('span', null, nome))));
      $('#site-msg').textContent = '';
    } catch (e) { $('#site-msg').textContent = e.message; }
  }
  $('#site-form')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const corpo = {
      aviso: { ativo: campo('aviso.ativo').checked, texto: campo('aviso.texto').value },
      horario: { ativo: campo('horario.ativo').checked, linhas: campo('horario.linhas').value.split('\n'), endereco: campo('horario.endereco').value, mapa: campo('horario.mapa').value.trim() },
      whatsapp: { ativo: campo('whatsapp.ativo').checked, numero: campo('whatsapp.numero').value, mensagem: campo('whatsapp.mensagem').value },
      abas: { frete: campo('abas.frete').checked, entregador: campo('abas.entregador').checked },
      selos: campo('selos').checked, manutencao: campo('manutencao').checked,
      menuOculto: $$('#site-menu input').filter((i) => !i.checked).map((i) => i.value)
    };
    if (corpo.manutencao && !confirm('Ligar o modo manutenção? Os clientes vão ver “Voltamos em instantes” até você desligar.')) return;
    try {
      const { ajustes: a } = await api('/site', { method: 'PUT', body: corpo });
      aplicarMenu(a.menuOculto);
      $('#site-msg').textContent = `Salvo às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}.`;
    } catch (e) { $('#site-msg').textContent = e.message; }
  });
  window.goboxSite = { abrir: carregarSite, fechar() {} };

  // Ao entrar no painel: aplica o menu salvo e os contadores.
  window.addEventListener('gobox:painel', async () => {
    try { const { ajustes: a } = await api('/site'); aplicarMenu(a.menuOculto); } catch { /* menu completo */ }
    try { const d = await api('/visao-geral'); contador('motoboys', d.entregadores.pendente); contador('sacas', d.sacas.falhas); } catch { /* sem contadores */ }
  });
}());
