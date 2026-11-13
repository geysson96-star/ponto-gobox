'use strict';
(function () {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // Cria elementos com texto seguro (nunca innerHTML com dados).
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v === null || v === undefined) continue;
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  const fmtData = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  const fmtNum = (n) => Number(n || 0).toLocaleString('pt-BR');

  const NOMES_SITUACAO = {
    na_agencia: 'Na agência', retirado: 'Retirado', enviado: 'Enviado', saiu: 'Saiu', outro: 'Outro'
  };
  const PILULA_SITUACAO = {
    na_agencia: 'atualizado', retirado: 'sem_dados', enviado: 'sem_dados', saiu: 'sem_dados', outro: 'desatualizado'
  };
  const NOMES_SITUACAO_FONTE = {
    atualizado: 'Atualizado', desatualizado: 'Desatualizado', falhou: 'Falhou', sem_dados: 'Sem dados'
  };
  const NOMES_SITUACAO_IMPORTACAO = {
    processando: 'Processando', aguardando_confirmacao: 'Aguardando confirmação',
    sucesso: 'Sucesso', falhou: 'Falhou', cancelada: 'Cancelada'
  };
  const PILULA_IMPORTACAO = {
    processando: 'sem_dados', aguardando_confirmacao: 'desatualizado',
    sucesso: 'atualizado', falhou: 'falhou', cancelada: 'sem_dados'
  };

  async function api(path, options = {}) {
    const opts = { credentials: 'same-origin', ...options, headers: { ...(options.headers || {}) } };
    if (opts.body && !(opts.body instanceof FormData)) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    const resp = await fetch('/admin/api' + path, opts);
    const dados = await resp.json().catch(() => ({}));
    if (resp.status === 401 && path !== '/login') {
      mostrarLogin();
      throw new Error(dados.erro || 'Sessão expirada.');
    }
    if (!resp.ok) {
      const e = new Error(dados.erro || 'Algo deu errado. Tente novamente.');
      e.dados = dados;
      e.status = resp.status;
      throw e;
    }
    return dados;
  }

  // ---------- Login ----------
  function mostrarLogin() {
    $('#tela-painel').hidden = true;
    $('#tela-login').hidden = false;
    $('#usuario').focus();
  }
  function mostrarPainel() {
    $('#tela-login').hidden = true;
    $('#tela-painel').hidden = false;
    // Volta para a aba que estava aberta (o endereço guarda a aba, ex.: /admin/#fretes).
    const salva = location.hash.slice(1);
    trocarAba($(`.item-menu[data-aba="${salva}"]`) ? salva : 'pacotes');
  }

  $('#form-login').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('#erro-login').textContent = '';
    const botao = ev.submitter || $('#form-login button[type="submit"]');
    botao.disabled = true;
    try {
      await api('/login', { method: 'POST', body: { usuario: $('#usuario').value, senha: $('#senha').value } });
      $('#senha').value = '';
      mostrarPainel();
    } catch (e) {
      $('#erro-login').textContent = e.message;
    } finally {
      botao.disabled = false;
    }
  });

  $('#botao-sair').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    mostrarLogin();
  });

  // ---------- Abas ----------
  function trocarAba(aba) {
    for (const b of $$('.item-menu')) {
      if (b.dataset.aba === aba) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
    for (const s of $$('.aba')) s.hidden = s.id !== `aba-${aba}`;
    if (location.hash.slice(1) !== aba) history.replaceState(null, '', `#${aba}`);
    if (aba === 'pacotes') { carregarRobo(); carregarFontes(); carregarPacotes(); }
    if (aba === 'importacoes') carregarImportacoes();
    if (aba === 'configuracoes') carregarConfiguracoes();
    if (window.goboxFinanceiro) window.goboxFinanceiro[aba === 'financeiro' ? 'abrir' : 'fechar']();
    if (window.goboxSacas) window.goboxSacas[aba === 'sacas' ? 'abrir' : 'fechar']();
    if (window.goboxAcessos) window.goboxAcessos[aba === 'acessos' ? 'abrir' : 'fechar']();
    if (window.goboxFretes) window.goboxFretes[aba === 'fretes' ? 'abrir' : 'fechar']();
    // Aba Ponto: carrega o painel do ponto só quando for aberta pela primeira vez.
    if (aba === 'ponto' && !$('#ponto-frame').getAttribute('src')) $('#ponto-frame').setAttribute('src', '/admin/ponto/');
    if (aba === 'motoboys' && !$('#motoboys-frame').getAttribute('src')) $('#motoboys-frame').setAttribute('src', 'https://script.google.com/macros/s/AKfycby24wASP9-pR6fO6ofSnGSgyMn2Rt3r6uv0jJKvoDVG263gsfyfKv3YTJ046nokghdAsQ/exec?p=admin');
    if (aba === 'contabilidade' && !$('#contabilidade-frame').getAttribute('src')) $('#contabilidade-frame').setAttribute('src', '/admin/contabilidade/');
  }
  for (const b of $$('.item-menu')) b.addEventListener('click', () => trocarAba(b.dataset.aba));

  // ---------- Fontes ----------
  async function carregarFontes() {
    const area = $('#cartoes-fontes');
    try {
      const { fontes } = await api('/fontes');
      area.replaceChildren(...fontes.map(cartaoFonte));
    } catch (e) {
      area.replaceChildren(el('p', { class: 'nota erro' }, e.message));
    }
  }

  function cartaoFonte(f) {
    let nota;
    let classeNota = 'nota';
    if (f.state === 'falhou' && f.lastImport) {
      nota = `A última importação falhou: ${f.lastImport.error_message || 'erro desconhecido.'}`;
      classeNota = 'nota erro';
    } else if (f.state === 'desatualizado') {
      nota = `Sem importação bem-sucedida há mais de ${f.staleHours} h. Os dados podem estar desatualizados.`;
      classeNota = 'nota alerta';
    } else if (f.state === 'sem_dados') {
      nota = 'Nenhum relatório importado ainda.';
    } else {
      nota = 'Dados vindos do último relatório importado.';
    }
    if (f.pendingConfirmations > 0) {
      nota += ` ${f.pendingConfirmations} importação(ões) aguardando sua confirmação.`;
      classeNota = 'nota alerta';
    }
    return el('article', { class: 'cartao-fonte' },
      el('div', { class: 'cartao-topo' },
        el('h2', {}, f.name),
        el('span', { class: `pilula ${f.state}` }, NOMES_SITUACAO_FONTE[f.state] || f.state)),
      el('div', { class: 'dado' }, el('span', {}, 'Última importação bem-sucedida'), el('span', {}, fmtData(f.lastSuccessAt))),
      el('div', { class: 'dado' }, el('span', {}, 'Pacotes na consulta'), el('span', {}, fmtNum(f.activePackages))),
      el('p', { class: classeNota }, nota),
      el('div', { class: 'cartao-acoes' },
        el('button', { type: 'button', class: 'botao-secundario', onclick: () => abrirImportacao(f.id) }, 'Importar arquivo'),
        el('button', {
          type: 'button', class: 'botao-texto',
          onclick: () => { $('#filtro-importacoes').value = f.id; trocarAba('importacoes'); }
        }, 'Ver histórico')));
  }

  const NOMES_FONTE = { shopee: 'Shopee SPX', ml: 'Mercado Livre', correios: 'Correios' };

  async function carregarRobo() {
    try {
      const r = await api('/robo');
      const info = $('#info-robo');
      $('#botao-robo').hidden = !r.ativo;
      info.hidden = false;
      info.textContent = r.ativo
        ? `Robô ligado: lê ${r.fontes.map((f) => NOMES_FONTE[f] || f).join(' e ')} direto dos portais a cada ${r.intervaloMinutos} min.` +
          (r.ultimo ? ` Última passada: ${fmtData(r.ultimo.em)}.` : ' Primeira passada em instantes.')
        : 'Robô desligado: os dados entram só por importação de relatório.';
    } catch { /* sem robô */ }
  }

  $('#botao-robo').addEventListener('click', async (ev) => {
    const b = ev.currentTarget;
    b.disabled = true;
    b.textContent = 'Sincronizando…';
    const aviso = $('#aviso-geral');
    try {
      const r = await api('/robo/sincronizar', { method: 'POST' });
      const partes = (r.resultados || []).map((x) => `${NOMES_FONTE[x.fonte] || x.fonte}: ${
        x.situacao === 'sucesso' ? `${fmtNum(x.codigos)} pacote(s)` :
          x.situacao === 'aguardando_confirmacao' ? 'aguardando sua confirmação em Importações' : x.erro}`);
      aviso.textContent = r.erro ? r.erro : `Sincronização concluída. ${partes.join(' · ')}`;
    } catch (e) {
      aviso.textContent = e.message;
    } finally {
      aviso.hidden = false;
      b.disabled = false;
      b.textContent = 'Sincronizar portais agora';
      carregarFontes();
      carregarPacotes();
      carregarRobo();
    }
  });

  $('#botao-verificar-entrada').addEventListener('click', async (ev) => {
    const b = ev.currentTarget;
    b.disabled = true;
    const aviso = $('#aviso-geral');
    try {
      const { resultado } = await api('/entrada/verificar', { method: 'POST' });
      const total = resultado.reduce((n, r) => n + ((r.results && r.results.length) || 0), 0);
      aviso.textContent = total
        ? `${total} arquivo(s) processado(s) da pasta de entrada. Veja os detalhes em Importações.`
        : 'Nenhum arquivo novo na pasta de entrada.';
      aviso.hidden = false;
      carregarFontes();
      carregarPacotes();
    } catch (e) {
      aviso.textContent = e.message;
      aviso.hidden = false;
    } finally {
      b.disabled = false;
    }
  });

  // ---------- Pacotes ----------
  const filtro = { fonte: '', situacao: 'ativos', busca: '', pagina: 1, paginas: 1 };

  for (const chip of $$('.chip')) {
    chip.addEventListener('click', () => {
      for (const c of $$('.chip')) c.setAttribute('aria-pressed', String(c === chip));
      filtro.fonte = chip.dataset.fonte;
      filtro.pagina = 1;
      carregarPacotes();
    });
  }
  $('#filtro-situacao').addEventListener('change', (e) => { filtro.situacao = e.target.value; filtro.pagina = 1; carregarPacotes(); });
  let espera;
  $('#filtro-busca').addEventListener('input', (e) => {
    clearTimeout(espera);
    espera = setTimeout(() => { filtro.busca = e.target.value.trim(); filtro.pagina = 1; carregarPacotes(); }, 300);
  });
  $('#pagina-anterior').addEventListener('click', () => { if (filtro.pagina > 1) { filtro.pagina -= 1; carregarPacotes(); } });
  $('#pagina-proxima').addEventListener('click', () => { if (filtro.pagina < filtro.paginas) { filtro.pagina += 1; carregarPacotes(); } });

  async function carregarPacotes() {
    const corpo = $('#corpo-pacotes');
    const qs = new URLSearchParams({ fonte: filtro.fonte, situacao: filtro.situacao, busca: filtro.busca, pagina: filtro.pagina });
    try {
      const d = await api(`/pacotes?${qs}`);
      filtro.paginas = d.paginas;
      if (!d.itens.length) {
        corpo.replaceChildren(el('tr', {}, el('td', { colspan: '6', class: 'tabela-vazia' }, 'Nenhum pacote encontrado com esses filtros.')));
      } else {
        corpo.replaceChildren(...d.itens.map((p) => el('tr', {},
          el('td', { class: 'codigo' }, p.codigo),
          el('td', {}, el('span', { class: 'tag' }, p.fonteNome)),
          el('td', {},
            el('span', { class: `pilula ${PILULA_SITUACAO[p.situacao] || 'sem_dados'}` }, NOMES_SITUACAO[p.situacao] || p.situacao),
            p.status ? el('div', { class: 'nota' }, p.status) : null),
          el('td', {}, fmtData(p.recebidoEm || p.primeiraImportacao)),
          el('td', {}, fmtData(p.saidaEm)),
          el('td', {}, fmtData(p.ultimaAtualizacao)))));
      }
      $('#info-paginacao').textContent = `${fmtNum(d.total)} pacote(s) · página ${d.pagina} de ${d.paginas}`;
      $('#pagina-anterior').disabled = d.pagina <= 1;
      $('#pagina-proxima').disabled = d.pagina >= d.paginas;
    } catch (e) {
      corpo.replaceChildren(el('tr', {}, el('td', { colspan: '6', class: 'tabela-vazia' }, e.message)));
    }
  }

  // ---------- Importações ----------
  $('#filtro-importacoes').addEventListener('change', carregarImportacoes);

  async function carregarImportacoes() {
    const corpo = $('#corpo-importacoes');
    const fonte = $('#filtro-importacoes').value;
    try {
      const { importacoes } = await api(`/importacoes?fonte=${encodeURIComponent(fonte)}`);
      if (!importacoes.length) {
        corpo.replaceChildren(el('tr', {}, el('td', { colspan: '8', class: 'tabela-vazia' }, 'Nenhuma importação ainda.')));
        return;
      }
      corpo.replaceChildren(...importacoes.map(linhaImportacao));
    } catch (e) {
      corpo.replaceChildren(el('tr', {}, el('td', { colspan: '8', class: 'tabela-vazia' }, e.message)));
    }
  }

  function linhaImportacao(i) {
    const detalhe = i.situacao === 'falhou'
      ? i.erro
      : [i.arquivo, i.colunaCodigo ? `coluna "${i.colunaCodigo}"` : null].filter(Boolean).join(' · ');
    const acoes = i.situacao === 'aguardando_confirmacao'
      ? el('div', { class: 'acoes-linha' },
        el('button', { type: 'button', class: 'botao-principal', onclick: () => confirmarImportacao(i) }, 'Confirmar'),
        el('button', { type: 'button', class: 'botao-secundario', onclick: () => cancelarImportacao(i.id) }, 'Cancelar'))
      : '';
    return el('tr', {},
      el('td', {}, fmtData(i.inicio)),
      el('td', {}, i.fonteNome),
      el('td', {}, { entrada: 'Pasta de entrada', robo: 'Robô (portal)', extensao: 'Extensão do Edge' }[i.origem] || 'Envio pelo painel'),
      el('td', {}, el('span', { class: `pilula ${PILULA_IMPORTACAO[i.situacao] || 'sem_dados'}` }, NOMES_SITUACAO_IMPORTACAO[i.situacao] || i.situacao)),
      el('td', {}, i.situacao === 'falhou' ? '—' : fmtNum(i.codigosValidos)),
      el('td', {}, i.situacao === 'falhou' ? '—' : `${fmtNum(i.novos)} / ${fmtNum(i.atualizados)} / ${fmtNum(i.removidos)}`),
      el('td', {}, detalhe || '—'),
      el('td', {}, acoes));
  }

  async function confirmarImportacao(i) {
    if (i.removidos > 0) {
      const ok = window.confirm(`Esta importação vai tirar ${fmtNum(i.removidos)} pacote(s) da consulta de ${i.fonteNome}. Confirmar?`);
      if (!ok) return;
    }
    try {
      await api(`/importacoes/${i.id}/confirmar`, { method: 'POST' });
    } catch (e) {
      window.alert(e.message);
    }
    carregarImportacoes();
  }
  async function cancelarImportacao(id) {
    try { await api(`/importacoes/${id}/cancelar`, { method: 'POST' }); } catch (e) { window.alert(e.message); }
    carregarImportacoes();
  }

  // ---------- Diálogo de importação ----------
  const dialogo = $('#dialogo-importacao');
  let importacaoAtual = null;

  function abrirImportacao(fonte) {
    importacaoAtual = null;
    $('#importacao-fonte').value = fonte || '';
    $('#importacao-arquivo').value = '';
    $('#passo-arquivo').hidden = false;
    $('#passo-previa').hidden = true;
    $('#passo-previa').replaceChildren();
    $('#erro-importacao').textContent = '';
    $('#importacao-ler').hidden = false;
    $('#importacao-confirmar').hidden = true;
    $('#importacao-fechar').textContent = 'Cancelar';
    dialogo.showModal();
  }
  for (const b of $$('[data-abrir-importacao]')) b.addEventListener('click', () => abrirImportacao(''));

  $('#importacao-fechar').addEventListener('click', async () => {
    if (importacaoAtual && importacaoAtual.situacao === 'aguardando_confirmacao') {
      await api(`/importacoes/${importacaoAtual.id}/cancelar`, { method: 'POST' }).catch(() => {});
    }
    dialogo.close();
  });

  $('#importacao-ler').addEventListener('click', async (ev) => {
    const b = ev.currentTarget;
    $('#erro-importacao').textContent = '';
    const fonte = $('#importacao-fonte').value;
    const arquivo = $('#importacao-arquivo').files[0];
    if (!fonte) { $('#erro-importacao').textContent = 'Escolha a empresa do relatório.'; return; }
    if (!arquivo) { $('#erro-importacao').textContent = 'Escolha o arquivo exportado.'; return; }
    const fd = new FormData();
    fd.append('fonte', fonte);
    fd.append('arquivo', arquivo);
    b.disabled = true;
    b.textContent = 'Lendo…';
    try {
      const { importacao } = await api('/importacoes', { method: 'POST', body: fd });
      importacaoAtual = importacao;
      mostrarPrevia(importacao);
    } catch (e) {
      const imp = e.dados && e.dados.importacao;
      const detalhe = e.dados && e.dados.detalhe ? ` ${e.dados.detalhe}` : '';
      $('#erro-importacao').textContent = (imp && imp.erro ? imp.erro : e.message) + detalhe;
    } finally {
      b.disabled = false;
      b.textContent = 'Ler arquivo';
    }
  });

  function mostrarPrevia(i) {
    $('#passo-arquivo').hidden = true;
    const previa = $('#passo-previa');
    const itens = [
      ['Empresa', i.fonteNome],
      ['Coluna de código usada', i.colunaCodigo],
      ['Linhas lidas', fmtNum(i.linhasLidas)],
      ['Códigos válidos', fmtNum(i.codigosValidos)],
      ['Pacotes novos', fmtNum(i.novos)],
      ['Pacotes já existentes (atualizados)', fmtNum(i.atualizados)],
      ['Saem da consulta', fmtNum(i.removidos)]
    ];
    const partes = [el('div', { class: 'previa' }, itens.flatMap(([k, v]) => [el('span', {}, k), el('strong', {}, v)]))];
    if (i.removidos > 0) {
      partes.push(el('p', { class: 'alerta-remocao' },
        `${fmtNum(i.removidos)} pacote(s) que estão na consulta hoje não aparecem neste relatório e deixarão de ser encontrados. ` +
        'Confirme só se o relatório estiver completo.'));
    }
    previa.replaceChildren(...partes);
    previa.hidden = false;
    $('#importacao-ler').hidden = true;
    $('#importacao-confirmar').hidden = false;
    $('#importacao-confirmar').focus();
  }

  $('#importacao-confirmar').addEventListener('click', async (ev) => {
    if (!importacaoAtual) return;
    const b = ev.currentTarget;
    b.disabled = true;
    try {
      await api(`/importacoes/${importacaoAtual.id}/confirmar`, { method: 'POST' });
      importacaoAtual = null;
      dialogo.close();
      const aviso = $('#aviso-geral');
      aviso.textContent = 'Importação concluída. A consulta pública já usa os novos dados.';
      aviso.hidden = false;
      carregarFontes();
      carregarPacotes();
    } catch (e) {
      $('#erro-importacao').textContent = e.message;
    } finally {
      b.disabled = false;
    }
  });

  // ---------- Configurações ----------
  async function carregarConfiguracoes() {
    const area = $('#lista-configuracoes');
    try {
      const { fontes, intervaloEntradaMinutos } = await api('/configuracoes');
      let info = $('#info-entrada');
      if (!info) {
        info = el('p', { id: 'info-entrada', class: 'descricao' });
        area.before(info);
      }
      info.textContent = intervaloEntradaMinutos > 0
        ? `A pasta de entrada é verificada automaticamente a cada ${intervaloEntradaMinutos} min (ajuste INBOX_INTERVAL_MINUTES no servidor).`
        : 'A verificação automática da pasta de entrada está desligada no servidor.';
      area.replaceChildren(await cartaoExtensao(), ...fontes.map(formConfig));
    } catch (e) {
      area.replaceChildren(el('p', { class: 'nota erro' }, e.message));
    }
  }

  async function cartaoExtensao() {
    const info = await api('/extensao');
    const situacao = el('p', { class: 'ajuda' },
      info.configurada
        ? `Chave criada em ${fmtData(info.criadaEm)}. Último envio da extensão: ${fmtData(info.ultimoEnvio)}.`
        : 'Nenhuma chave criada ainda.');
    const saida = el('div', { role: 'status' });
    const botao = el('button', { type: 'button', class: 'botao-principal botao-medio' },
      info.configurada ? 'Gerar nova chave' : 'Gerar chave da extensão');
    botao.addEventListener('click', async () => {
      if (info.configurada && !window.confirm('A chave atual deixa de funcionar. Gerar uma nova?')) return;
      const { chave } = await api('/extensao/chave', { method: 'POST' });
      const campo = el('input', { type: 'text', readonly: true, value: chave });
      const copiar = el('button', { type: 'button', class: 'botao-secundario' }, 'Copiar');
      copiar.addEventListener('click', async () => {
        await navigator.clipboard.writeText(chave).catch(() => campo.select());
        copiar.textContent = 'Copiada';
      });
      saida.replaceChildren(
        el('p', { class: 'nota alerta' }, 'Copie agora e cole na extensão (ícone GoBox no Edge → Configurar). Ela não aparece de novo.'),
        campo, copiar);
      campo.select();
    });
    return el('section', { class: 'form-config' },
      el('h2', {}, 'Extensão do Edge'),
      el('p', { class: 'ajuda' }, 'A extensão lê a Shopee SPX e o Mercado Livre Places nas abas que você já abre no Edge e envia só os códigos para cá.'),
      situacao, botao, saida);
  }

  function formConfig(f) {
    const id = (n) => `cfg-${f.id}-${n}`;
    const salvo = el('p', { class: 'salvo', role: 'status' });
    const modo = el('select', { id: id('modo') },
      el('option', { value: 'snapshot' }, 'Relatório completo'),
      el('option', { value: 'incremental' }, 'Só adicionar (nunca remove)'));
    modo.value = f.mode;
    const colCodigo = el('input', { id: id('col'), type: 'text', value: f.codeColumn || '', placeholder: 'Detectar automaticamente', maxlength: '100' });
    const colId = el('input', { id: id('colid'), type: 'text', value: f.idColumn || '', placeholder: 'Opcional', maxlength: '100' });
    const horas = el('input', { id: id('horas'), type: 'number', min: '1', max: '720', value: String(f.staleHours) });
    const pct = el('input', { id: id('pct'), type: 'number', min: '0', max: '100', value: String(f.maxDeactivatePercent) });

    const form = el('form', { class: 'form-config' },
      el('h2', {}, f.nome),
      el('label', { for: id('col') }, 'Nome da coluna com o código'), colCodigo,
      el('p', { class: 'ajuda' }, 'Igual ao cabeçalho do relatório exportado. Em branco, o sistema tenta reconhecer sozinho.'),
      el('label', { for: id('colid') }, 'Coluna com o ID da fonte'), colId,
      el('label', { for: id('modo') }, 'Tipo de relatório'), modo,
      el('p', { class: 'ajuda' }, 'Relatório completo: quem não aparece no arquivo sai da consulta.'),
      el('label', { for: id('horas') }, 'Considerar desatualizado após (horas)'), horas,
      el('label', { for: id('pct') }, 'Pasta de entrada: pedir confirmação se remover mais de (%)'), pct,
      el('p', { class: 'ajuda' }, 'Proteção contra relatório incompleto colocado na pasta de entrada.'),
      salvo,
      el('button', { type: 'submit', class: 'botao-principal botao-medio' }, 'Salvar'));

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      salvo.textContent = '';
      try {
        await api(`/configuracoes/${f.id}`, {
          method: 'PUT',
          body: {
            codeColumn: colCodigo.value, idColumn: colId.value, mode: modo.value,
            staleHours: Number(horas.value), maxDeactivatePercent: Number(pct.value)
          }
        });
        salvo.textContent = 'Configuração salva.';
      } catch (e) {
        salvo.textContent = e.message;
      }
    });
    return form;
  }

  // ---------- Início ----------
  api('/me').then((d) => (d.autenticado ? mostrarPainel() : mostrarLogin())).catch(mostrarLogin);
})();
'use strict';
(function () {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // Cria elementos com texto seguro (nunca innerHTML com dados).
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v === null || v === undefined) continue;
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  const fmtData = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  const fmtNum = (n) => Number(n || 0).toLocaleString('pt-BR');

  const NOMES_SITUACAO = {
    na_agencia: 'Na agência', retirado: 'Retirado', enviado: 'Enviado', saiu: 'Saiu', outro: 'Outro'
  };
  const PILULA_SITUACAO = {
    na_agencia: 'atualizado', retirado: 'sem_dados', enviado: 'sem_dados', saiu: 'sem_dados', outro: 'desatualizado'
  };
  const NOMES_SITUACAO_FONTE = {
    atualizado: 'Atualizado', desatualizado: 'Desatualizado', falhou: 'Falhou', sem_dados: 'Sem dados'
  };
  const NOMES_SITUACAO_IMPORTACAO = {
    processando: 'Processando', aguardando_confirmacao: 'Aguardando confirmação',
    sucesso: 'Sucesso', falhou: 'Falhou', cancelada: 'Cancelada'
  };
  const PILULA_IMPORTACAO = {
    processando: 'sem_dados', aguardando_confirmacao: 'desatualizado',
    sucesso: 'atualizado', falhou: 'falhou', cancelada: 'sem_dados'
  };

  async function api(path, options = {}) {
    const opts = { credentials: 'same-origin', ...options, headers: { ...(options.headers || {}) } };
    if (opts.body && !(opts.body instanceof FormData)) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
    const resp = await fetch('/admin/api' + path, opts);
    const dados = await resp.json().catch(() => ({}));
    if (resp.status === 401 && path !== '/login') {
      mostrarLogin();
      throw new Error(dados.erro || 'Sessão expirada.');
    }
    if (!resp.ok) {
      const e = new Error(dados.erro || 'Algo deu errado. Tente novamente.');
      e.dados = dados;
      e.status = resp.status;
      throw e;
    }
    return dados;
  }

  // ---------- Login ----------
  function mostrarLogin() {
    $('#tela-painel').hidden = true;
    $('#tela-login').hidden = false;
    $('#usuario').focus();
  }
  function mostrarPainel() {
    $('#tela-login').hidden = true;
    $('#tela-painel').hidden = false;
    // Volta para a aba que estava aberta (o endereço guarda a aba, ex.: /admin/#fretes).
    const salva = location.hash.slice(1);
    trocarAba($(`.item-menu[data-aba="${salva}"]`) ? salva : 'pacotes');
  }

  $('#form-login').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('#erro-login').textContent = '';
    const botao = ev.submitter || $('#form-login button[type="submit"]');
    botao.disabled = true;
    try {
      await api('/login', { method: 'POST', body: { usuario: $('#usuario').value, senha: $('#senha').value } });
      $('#senha').value = '';
      mostrarPainel();
    } catch (e) {
      $('#erro-login').textContent = e.message;
    } finally {
      botao.disabled = false;
    }
  });

  $('#botao-sair').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    mostrarLogin();
  });

  // ---------- Abas ----------
  function trocarAba(aba) {
    for (const b of $$('.item-menu')) {
      if (b.dataset.aba === aba) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
    for (const s of $$('.aba')) s.hidden = s.id !== `aba-${aba}`;
    if (location.hash.slice(1) !== aba) history.replaceState(null, '', `#${aba}`);
    if (aba === 'pacotes') { carregarRobo(); carregarFontes(); carregarPacotes(); }
    if (aba === 'importacoes') carregarImportacoes();
    if (aba === 'configuracoes') carregarConfiguracoes();
    if (window.goboxFinanceiro) window.goboxFinanceiro[aba === 'financeiro' ? 'abrir' : 'fechar']();
    if (window.goboxSacas) window.goboxSacas[aba === 'sacas' ? 'abrir' : 'fechar']();
    if (window.goboxAcessos) window.goboxAcessos[aba === 'acessos' ? 'abrir' : 'fechar']();
    if (window.goboxFretes) window.goboxFretes[aba === 'fretes' ? 'abrir' : 'fechar']();
    // Aba Ponto: carrega o painel do ponto só quando for aberta pela primeira vez.
    if (aba === 'ponto' && !$('#ponto-frame').getAttribute('src')) $('#ponto-frame').setAttribute('src', '/admin/ponto/');
    if (aba === 'contabilidade' && !$('#contabilidade-frame').getAttribute('src')) $('#contabilidade-frame').setAttribute('src', '/admin/contabilidade/');
  }
  for (const b of $$('.item-menu')) b.addEventListener('click', () => trocarAba(b.dataset.aba));

  // ---------- Fontes ----------
  async function carregarFontes() {
    const area = $('#cartoes-fontes');
    try {
      const { fontes } = await api('/fontes');
      area.replaceChildren(...fontes.map(cartaoFonte));
    } catch (e) {
      area.replaceChildren(el('p', { class: 'nota erro' }, e.message));
    }
  }

  function cartaoFonte(f) {
    let nota;
    let classeNota = 'nota';
    if (f.state === 'falhou' && f.lastImport) {
      nota = `A última importação falhou: ${f.lastImport.error_message || 'erro desconhecido.'}`;
      classeNota = 'nota erro';
    } else if (f.state === 'desatualizado') {
      nota = `Sem importação bem-sucedida há mais de ${f.staleHours} h. Os dados podem estar desatualizados.`;
      classeNota = 'nota alerta';
    } else if (f.state === 'sem_dados') {
      nota = 'Nenhum relatório importado ainda.';
    } else {
      nota = 'Dados vindos do último relatório importado.';
    }
    if (f.pendingConfirmations > 0) {
      nota += ` ${f.pendingConfirmations} importação(ões) aguardando sua confirmação.`;
      classeNota = 'nota alerta';
    }
    return el('article', { class: 'cartao-fonte' },
      el('div', { class: 'cartao-topo' },
        el('h2', {}, f.name),
        el('span', { class: `pilula ${f.state}` }, NOMES_SITUACAO_FONTE[f.state] || f.state)),
      el('div', { class: 'dado' }, el('span', {}, 'Última importação bem-sucedida'), el('span', {}, fmtData(f.lastSuccessAt))),
      el('div', { class: 'dado' }, el('span', {}, 'Pacotes na consulta'), el('span', {}, fmtNum(f.activePackages))),
      el('p', { class: classeNota }, nota),
      el('div', { class: 'cartao-acoes' },
        el('button', { type: 'button', class: 'botao-secundario', onclick: () => abrirImportacao(f.id) }, 'Importar arquivo'),
        el('button', {
          type: 'button', class: 'botao-texto',
          onclick: () => { $('#filtro-importacoes').value = f.id; trocarAba('importacoes'); }
        }, 'Ver histórico')));
  }

  const NOMES_FONTE = { shopee: 'Shopee SPX', ml: 'Mercado Livre', correios: 'Correios' };

  async function carregarRobo() {
    try {
      const r = await api('/robo');
      const info = $('#info-robo');
      $('#botao-robo').hidden = !r.ativo;
      info.hidden = false;
      info.textContent = r.ativo
        ? `Robô ligado: lê ${r.fontes.map((f) => NOMES_FONTE[f] || f).join(' e ')} direto dos portais a cada ${r.intervaloMinutos} min.` +
          (r.ultimo ? ` Última passada: ${fmtData(r.ultimo.em)}.` : ' Primeira passada em instantes.')
        : 'Robô desligado: os dados entram só por importação de relatório.';
    } catch { /* sem robô */ }
  }

  $('#botao-robo').addEventListener('click', async (ev) => {
    const b = ev.currentTarget;
    b.disabled = true;
    b.textContent = 'Sincronizando…';
    const aviso = $('#aviso-geral');
    try {
      const r = await api('/robo/sincronizar', { method: 'POST' });
      const partes = (r.resultados || []).map((x) => `${NOMES_FONTE[x.fonte] || x.fonte}: ${
        x.situacao === 'sucesso' ? `${fmtNum(x.codigos)} pacote(s)` :
          x.situacao === 'aguardando_confirmacao' ? 'aguardando sua confirmação em Importações' : x.erro}`);
      aviso.textContent = r.erro ? r.erro : `Sincronização concluída. ${partes.join(' · ')}`;
    } catch (e) {
      aviso.textContent = e.message;
    } finally {
      aviso.hidden = false;
      b.disabled = false;
      b.textContent = 'Sincronizar portais agora';
      carregarFontes();
      carregarPacotes();
      carregarRobo();
    }
  });

  $('#botao-verificar-entrada').addEventListener('click', async (ev) => {
    const b = ev.currentTarget;
    b.disabled = true;
    const aviso = $('#aviso-geral');
    try {
      const { resultado } = await api('/entrada/verificar', { method: 'POST' });
      const total = resultado.reduce((n, r) => n + ((r.results && r.results.length) || 0), 0);
      aviso.textContent = total
        ? `${total} arquivo(s) processado(s) da pasta de entrada. Veja os detalhes em Importações.`
        : 'Nenhum arquivo novo na pasta de entrada.';
      aviso.hidden = false;
      carregarFontes();
      carregarPacotes();
    } catch (e) {
      aviso.textContent = e.message;
      aviso.hidden = false;
    } finally {
      b.disabled = false;
    }
  });

  // ---------- Pacotes ----------
  const filtro = { fonte: '', situacao: 'ativos', busca: '', pagina: 1, paginas: 1 };

  for (const chip of $$('.chip')) {
    chip.addEventListener('click', () => {
      for (const c of $$('.chip')) c.setAttribute('aria-pressed', String(c === chip));
      filtro.fonte = chip.dataset.fonte;
      filtro.pagina = 1;
      carregarPacotes();
    });
  }
  $('#filtro-situacao').addEventListener('change', (e) => { filtro.situacao = e.target.value; filtro.pagina = 1; carregarPacotes(); });
  let espera;
  $('#filtro-busca').addEventListener('input', (e) => {
    clearTimeout(espera);
    espera = setTimeout(() => { filtro.busca = e.target.value.trim(); filtro.pagina = 1; carregarPacotes(); }, 300);
  });
  $('#pagina-anterior').addEventListener('click', () => { if (filtro.pagina > 1) { filtro.pagina -= 1; carregarPacotes(); } });
  $('#pagina-proxima').addEventListener('click', () => { if (filtro.pagina < filtro.paginas) { filtro.pagina += 1; carregarPacotes(); } });

  async function carregarPacotes() {
    const corpo = $('#corpo-pacotes');
    const qs = new URLSearchParams({ fonte: filtro.fonte, situacao: filtro.situacao, busca: filtro.busca, pagina: filtro.pagina });
    try {
      const d = await api(`/pacotes?${qs}`);
      filtro.paginas = d.paginas;
      if (!d.itens.length) {
        corpo.replaceChildren(el('tr', {}, el('td', { colspan: '6', class: 'tabela-vazia' }, 'Nenhum pacote encontrado com esses filtros.')));
      } else {
        corpo.replaceChildren(...d.itens.map((p) => el('tr', {},
          el('td', { class: 'codigo' }, p.codigo),
          el('td', {}, el('span', { class: 'tag' }, p.fonteNome)),
          el('td', {},
            el('span', { class: `pilula ${PILULA_SITUACAO[p.situacao] || 'sem_dados'}` }, NOMES_SITUACAO[p.situacao] || p.situacao),
            p.status ? el('div', { class: 'nota' }, p.status) : null),
          el('td', {}, fmtData(p.recebidoEm || p.primeiraImportacao)),
          el('td', {}, fmtData(p.saidaEm)),
          el('td', {}, fmtData(p.ultimaAtualizacao)))));
      }
      $('#info-paginacao').textContent = `${fmtNum(d.total)} pacote(s) · página ${d.pagina} de ${d.paginas}`;
      $('#pagina-anterior').disabled = d.pagina <= 1;
      $('#pagina-proxima').disabled = d.pagina >= d.paginas;
    } catch (e) {
      corpo.replaceChildren(el('tr', {}, el('td', { colspan: '6', class: 'tabela-vazia' }, e.message)));
    }
  }

  // ---------- Importações ----------
  $('#filtro-importacoes').addEventListener('change', carregarImportacoes);

  async function carregarImportacoes() {
    const corpo = $('#corpo-importacoes');
    const fonte = $('#filtro-importacoes').value;
    try {
      const { importacoes } = await api(`/importacoes?fonte=${encodeURIComponent(fonte)}`);
      if (!importacoes.length) {
        corpo.replaceChildren(el('tr', {}, el('td', { colspan: '8', class: 'tabela-vazia' }, 'Nenhuma importação ainda.')));
        return;
      }
      corpo.replaceChildren(...importacoes.map(linhaImportacao));
    } catch (e) {
      corpo.replaceChildren(el('tr', {}, el('td', { colspan: '8', class: 'tabela-vazia' }, e.message)));
    }
  }

  function linhaImportacao(i) {
    const detalhe = i.situacao === 'falhou'
      ? i.erro
      : [i.arquivo, i.colunaCodigo ? `coluna "${i.colunaCodigo}"` : null].filter(Boolean).join(' · ');
    const acoes = i.situacao === 'aguardando_confirmacao'
      ? el('div', { class: 'acoes-linha' },
        el('button', { type: 'button', class: 'botao-principal', onclick: () => confirmarImportacao(i) }, 'Confirmar'),
        el('button', { type: 'button', class: 'botao-secundario', onclick: () => cancelarImportacao(i.id) }, 'Cancelar'))
      : '';
    return el('tr', {},
      el('td', {}, fmtData(i.inicio)),
      el('td', {}, i.fonteNome),
      el('td', {}, { entrada: 'Pasta de entrada', robo: 'Robô (portal)', extensao: 'Extensão do Edge' }[i.origem] || 'Envio pelo painel'),
      el('td', {}, el('span', { class: `pilula ${PILULA_IMPORTACAO[i.situacao] || 'sem_dados'}` }, NOMES_SITUACAO_IMPORTACAO[i.situacao] || i.situacao)),
      el('td', {}, i.situacao === 'falhou' ? '—' : fmtNum(i.codigosValidos)),
      el('td', {}, i.situacao === 'falhou' ? '—' : `${fmtNum(i.novos)} / ${fmtNum(i.atualizados)} / ${fmtNum(i.removidos)}`),
      el('td', {}, detalhe || '—'),
      el('td', {}, acoes));
  }

  async function confirmarImportacao(i) {
    if (i.removidos > 0) {
      const ok = window.confirm(`Esta importação vai tirar ${fmtNum(i.removidos)} pacote(s) da consulta de ${i.fonteNome}. Confirmar?`);
      if (!ok) return;
    }
    try {
      await api(`/importacoes/${i.id}/confirmar`, { method: 'POST' });
    } catch (e) {
      window.alert(e.message);
    }
    carregarImportacoes();
  }
  async function cancelarImportacao(id) {
    try { await api(`/importacoes/${id}/cancelar`, { method: 'POST' }); } catch (e) { window.alert(e.message); }
    carregarImportacoes();
  }

  // ---------- Diálogo de importação ----------
  const dialogo = $('#dialogo-importacao');
  let importacaoAtual = null;

  function abrirImportacao(fonte) {
    importacaoAtual = null;
    $('#importacao-fonte').value = fonte || '';
    $('#importacao-arquivo').value = '';
    $('#passo-arquivo').hidden = false;
    $('#passo-previa').hidden = true;
    $('#passo-previa').replaceChildren();
    $('#erro-importacao').textContent = '';
    $('#importacao-ler').hidden = false;
    $('#importacao-confirmar').hidden = true;
    $('#importacao-fechar').textContent = 'Cancelar';
    dialogo.showModal();
  }
  for (const b of $$('[data-abrir-importacao]')) b.addEventListener('click', () => abrirImportacao(''));

  $('#importacao-fechar').addEventListener('click', async () => {
    if (importacaoAtual && importacaoAtual.situacao === 'aguardando_confirmacao') {
      await api(`/importacoes/${importacaoAtual.id}/cancelar`, { method: 'POST' }).catch(() => {});
    }
    dialogo.close();
  });

  $('#importacao-ler').addEventListener('click', async (ev) => {
    const b = ev.currentTarget;
    $('#erro-importacao').textContent = '';
    const fonte = $('#importacao-fonte').value;
    const arquivo = $('#importacao-arquivo').files[0];
    if (!fonte) { $('#erro-importacao').textContent = 'Escolha a empresa do relatório.'; return; }
    if (!arquivo) { $('#erro-importacao').textContent = 'Escolha o arquivo exportado.'; return; }
    const fd = new FormData();
    fd.append('fonte', fonte);
    fd.append('arquivo', arquivo);
    b.disabled = true;
    b.textContent = 'Lendo…';
    try {
      const { importacao } = await api('/importacoes', { method: 'POST', body: fd });
      importacaoAtual = importacao;
      mostrarPrevia(importacao);
    } catch (e) {
      const imp = e.dados && e.dados.importacao;
      const detalhe = e.dados && e.dados.detalhe ? ` ${e.dados.detalhe}` : '';
      $('#erro-importacao').textContent = (imp && imp.erro ? imp.erro : e.message) + detalhe;
    } finally {
      b.disabled = false;
      b.textContent = 'Ler arquivo';
    }
  });

  function mostrarPrevia(i) {
    $('#passo-arquivo').hidden = true;
    const previa = $('#passo-previa');
    const itens = [
      ['Empresa', i.fonteNome],
      ['Coluna de código usada', i.colunaCodigo],
      ['Linhas lidas', fmtNum(i.linhasLidas)],
      ['Códigos válidos', fmtNum(i.codigosValidos)],
      ['Pacotes novos', fmtNum(i.novos)],
      ['Pacotes já existentes (atualizados)', fmtNum(i.atualizados)],
      ['Saem da consulta', fmtNum(i.removidos)]
    ];
    const partes = [el('div', { class: 'previa' }, itens.flatMap(([k, v]) => [el('span', {}, k), el('strong', {}, v)]))];
    if (i.removidos > 0) {
      partes.push(el('p', { class: 'alerta-remocao' },
        `${fmtNum(i.removidos)} pacote(s) que estão na consulta hoje não aparecem neste relatório e deixarão de ser encontrados. ` +
        'Confirme só se o relatório estiver completo.'));
    }
    previa.replaceChildren(...partes);
    previa.hidden = false;
    $('#importacao-ler').hidden = true;
    $('#importacao-confirmar').hidden = false;
    $('#importacao-confirmar').focus();
  }

  $('#importacao-confirmar').addEventListener('click', async (ev) => {
    if (!importacaoAtual) return;
    const b = ev.currentTarget;
    b.disabled = true;
    try {
      await api(`/importacoes/${importacaoAtual.id}/confirmar`, { method: 'POST' });
      importacaoAtual = null;
      dialogo.close();
      const aviso = $('#aviso-geral');
      aviso.textContent = 'Importação concluída. A consulta pública já usa os novos dados.';
      aviso.hidden = false;
      carregarFontes();
      carregarPacotes();
    } catch (e) {
      $('#erro-importacao').textContent = e.message;
    } finally {
      b.disabled = false;
    }
  });

  // ---------- Configurações ----------
  async function carregarConfiguracoes() {
    const area = $('#lista-configuracoes');
    try {
      const { fontes, intervaloEntradaMinutos } = await api('/configuracoes');
      let info = $('#info-entrada');
      if (!info) {
        info = el('p', { id: 'info-entrada', class: 'descricao' });
        area.before(info);
      }
      info.textContent = intervaloEntradaMinutos > 0
        ? `A pasta de entrada é verificada automaticamente a cada ${intervaloEntradaMinutos} min (ajuste INBOX_INTERVAL_MINUTES no servidor).`
        : 'A verificação automática da pasta de entrada está desligada no servidor.';
      area.replaceChildren(await cartaoExtensao(), ...fontes.map(formConfig));
    } catch (e) {
      area.replaceChildren(el('p', { class: 'nota erro' }, e.message));
    }
  }

  async function cartaoExtensao() {
    const info = await api('/extensao');
    const situacao = el('p', { class: 'ajuda' },
      info.configurada
        ? `Chave criada em ${fmtData(info.criadaEm)}. Último envio da extensão: ${fmtData(info.ultimoEnvio)}.`
        : 'Nenhuma chave criada ainda.');
    const saida = el('div', { role: 'status' });
    const botao = el('button', { type: 'button', class: 'botao-principal botao-medio' },
      info.configurada ? 'Gerar nova chave' : 'Gerar chave da extensão');
    botao.addEventListener('click', async () => {
      if (info.configurada && !window.confirm('A chave atual deixa de funcionar. Gerar uma nova?')) return;
      const { chave } = await api('/extensao/chave', { method: 'POST' });
      const campo = el('input', { type: 'text', readonly: true, value: chave });
      const copiar = el('button', { type: 'button', class: 'botao-secundario' }, 'Copiar');
      copiar.addEventListener('click', async () => {
        await navigator.clipboard.writeText(chave).catch(() => campo.select());
        copiar.textContent = 'Copiada';
      });
      saida.replaceChildren(
        el('p', { class: 'nota alerta' }, 'Copie agora e cole na extensão (ícone GoBox no Edge → Configurar). Ela não aparece de novo.'),
        campo, copiar);
      campo.select();
    });
    return el('section', { class: 'form-config' },
      el('h2', {}, 'Extensão do Edge'),
      el('p', { class: 'ajuda' }, 'A extensão lê a Shopee SPX e o Mercado Livre Places nas abas que você já abre no Edge e envia só os códigos para cá.'),
      situacao, botao, saida);
  }

  function formConfig(f) {
    const id = (n) => `cfg-${f.id}-${n}`;
    const salvo = el('p', { class: 'salvo', role: 'status' });
    const modo = el('select', { id: id('modo') },
      el('option', { value: 'snapshot' }, 'Relatório completo'),
      el('option', { value: 'incremental' }, 'Só adicionar (nunca remove)'));
    modo.value = f.mode;
    const colCodigo = el('input', { id: id('col'), type: 'text', value: f.codeColumn || '', placeholder: 'Detectar automaticamente', maxlength: '100' });
    const colId = el('input', { id: id('colid'), type: 'text', value: f.idColumn || '', placeholder: 'Opcional', maxlength: '100' });
    const horas = el('input', { id: id('horas'), type: 'number', min: '1', max: '720', value: String(f.staleHours) });
    const pct = el('input', { id: id('pct'), type: 'number', min: '0', max: '100', value: String(f.maxDeactivatePercent) });

    const form = el('form', { class: 'form-config' },
      el('h2', {}, f.nome),
      el('label', { for: id('col') }, 'Nome da coluna com o código'), colCodigo,
      el('p', { class: 'ajuda' }, 'Igual ao cabeçalho do relatório exportado. Em branco, o sistema tenta reconhecer sozinho.'),
      el('label', { for: id('colid') }, 'Coluna com o ID da fonte'), colId,
      el('label', { for: id('modo') }, 'Tipo de relatório'), modo,
      el('p', { class: 'ajuda' }, 'Relatório completo: quem não aparece no arquivo sai da consulta.'),
      el('label', { for: id('horas') }, 'Considerar desatualizado após (horas)'), horas,
      el('label', { for: id('pct') }, 'Pasta de entrada: pedir confirmação se remover mais de (%)'), pct,
      el('p', { class: 'ajuda' }, 'Proteção contra relatório incompleto colocado na pasta de entrada.'),
      salvo,
      el('button', { type: 'submit', class: 'botao-principal botao-medio' }, 'Salvar'));

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      salvo.textContent = '';
      try {
        await api(`/configuracoes/${f.id}`, {
          method: 'PUT',
          body: {
            codeColumn: colCodigo.value, idColumn: colId.value, mode: modo.value,
            staleHours: Number(horas.value), maxDeactivatePercent: Number(pct.value)
          }
        });
        salvo.textContent = 'Configuração salva.';
      } catch (e) {
        salvo.textContent = e.message;
      }
    });
    return form;
  }

  // ---------- Início ----------
  api('/me').then((d) => (d.autenticado ? mostrarPainel() : mostrarLogin())).catch(mostrarLogin);
})();
