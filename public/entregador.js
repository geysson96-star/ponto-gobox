// Cadastro de entregadores/coletadores. Os dados vão para a planilha do Apps Script
// "GoBox Motoboys" (mesmo painel de antes); a página não depende mais de iframe.
(function () {
  'use strict';
  var API = 'https://script.google.com/macros/s/AKfycby24wASP9-pR6fO6ofSnGSgyMn2Rt3r6uv0jJKvoDVG263gsfyfKv3YTJ046nokghdAsQ/exec';

  // Usado se a configuração do painel não carregar (os valores nunca aparecem nesta página).
  var PADRAO = {
    servicos: [
      { id: 'ml', nome: 'Entregas Mercado Livre', para: 'Entregador', desc: 'Rota diária com os pacotes do Mercado Livre que chegam nas sacas. Ideal para quem pode fazer sempre.', dias: [1, 2, 3, 4, 5, 6], obs: '' },
      { id: 'shopee', nome: 'Entregas Shopee', para: 'Entregador', desc: 'Pacotes da Shopee nos dias de maior movimento.', dias: [5, 6, 0, 1], obs: '' },
      { id: 'azul', nome: 'Fretes Azul Cargo', para: 'Entregador', desc: 'Fretes da Azul, uma vez por semana. Pacote grande paga mais.', dias: [], obs: '1 vez por semana, dia a definir' },
      { id: 'emergencial', nome: 'Entregas expressas', para: 'Entregador', desc: 'Entregas de última hora: a GoBox chama quando surge um pedido urgente e você aceita se puder.', dias: [0, 1, 2, 3, 4, 5, 6], obs: 'Sob demanda, qualquer dia' },
      { id: 'coleta', nome: 'Coleta', para: 'Coletador', desc: 'Buscar pacotes e trazer para a GoBox.', dias: [], obs: 'Dias a definir' }
    ],
    pagamento: { titulo: 'Pagamento todo sábado', texto: 'Os fretes e pacotes da semana são contabilizados e pagos aos sábados.' }
  };

  var DN = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'], ORDER = [1, 2, 3, 4, 5, 6, 0], TURNOS = ['Manhã', 'Tarde', 'Noite'];
  var CONFIG = PADRAO;
  function $(s) { return document.querySelector(s); }
  function $$(s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function arr(v) { return Array.isArray(v) ? v : []; }

  function renderCards() {
    $('#cards').innerHTML = CONFIG.servicos.map(function (s) {
      var dias = arr(s.dias);
      return '<div class="card"><div class="who">' + esc(s.para) + '</div><h3>' + esc(s.nome) + '</h3><p>' + esc(s.desc) + '</p>' +
        '<div class="days">' + ORDER.map(function (i) { return '<div class="d' + (dias.indexOf(i) >= 0 ? ' on' : '') + '">' + DN[i] + '</div>'; }).join('') + '</div>' +
        (s.obs ? '<div class="note">' + esc(s.obs) + '</div>' : '') + '</div>';
    }).join('');
    var p = CONFIG.pagamento || PADRAO.pagamento;
    $('#payTitle').textContent = p.titulo || ''; $('#payText').textContent = p.texto || '';
  }

  function renderServ() {
    var fn = ($('[name=funcao]:checked') || {}).value || 'entregador';
    var marcados = $$('[name=serv]:checked').map(function (i) { return i.value; });
    var lista = CONFIG.servicos.filter(function (s) { return fn === 'ambos' || (fn === 'coletador') === (s.para === 'Coletador'); });
    $('#servOpts').innerHTML = lista.map(function (s) {
      var dias = arr(s.dias);
      var txt = dias.length ? ORDER.filter(function (i) { return dias.indexOf(i) >= 0; }).map(function (i) { return DN[i]; }).join(', ') : esc(s.obs);
      var on = marcados.indexOf(s.id) >= 0 || lista.length === 1;
      return '<label class="opt' + (on ? ' sel' : '') + '"><input type="checkbox" name="serv" value="' + esc(s.id) + '"' + (on ? ' checked' : '') + '><div><b>' + esc(s.nome) + '</b><small>' + txt + '</small></div></label>';
    }).join('');
  }

  function marcarOpt() { $$('.ent .opt').forEach(function (l) { var i = l.querySelector('input'); l.classList.toggle('sel', !!(i && i.checked)); }); }

  function renderGrid() {
    $('#grid').innerHTML = '<tr><th></th>' + TURNOS.map(function (t) { return '<th>' + t + '</th>'; }).join('') + '</tr>' +
      ORDER.map(function (d) {
        return '<tr><td>' + DN[d] + '</td>' + TURNOS.map(function (t) {
          return '<td class="c"><label><input type="checkbox" name="hor" value="' + DN[d] + '-' + t + '" data-d="' + d + '" aria-label="' + DN[d] + ' ' + t + '"><span></span></label></td>';
        }).join('') + '</tr>';
      }).join('');
  }

  function mask(el, fn) { el.addEventListener('input', function () { el.value = fn(el.value.replace(/\D/g, '')); }); }

  function iniciar() {
    renderCards(); renderServ(); renderGrid(); marcarOpt();
    document.addEventListener('change', function (e) {
      if (e.target.name === 'funcao') renderServ();
      marcarOpt();
    });
    $$('.quick button').forEach(function (b) {
      b.addEventListener('click', function () {
        var q = b.getAttribute('data-q');
        $$('[name=hor]').forEach(function (i) {
          var d = +i.getAttribute('data-d');
          if (q === 'all') i.checked = true; else if (q === 'none') i.checked = false;
          else if (q === 'week' && d >= 1 && d <= 5) i.checked = true; else if (q === 'fds' && (d === 0 || d === 6)) i.checked = true;
        });
      });
    });
    mask($('[name=whatsapp]'), function (v) { return v.slice(0, 11).replace(/^(\d{2})(\d)/, '($1) $2').replace(/(\d{5})(\d)/, '$1-$2'); });

    var tabs = $$('.ent-tabs a');
    tabs.forEach(function (a) {
      a.addEventListener('click', function (ev) { ev.preventDefault(); document.getElementById(a.getAttribute('data-t')).scrollIntoView({ behavior: 'smooth' }); });
    });
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (es) {
        es.forEach(function (e) { if (e.isIntersecting) tabs.forEach(function (a) { a.classList.toggle('on', a.getAttribute('data-t') === e.target.id); }); });
      }, { rootMargin: '-45% 0px -50% 0px' });
      $$('.ent section').forEach(function (s) { io.observe(s); });
    }
    $('#f').addEventListener('submit', enviar);

    // Atualiza dias e textos com o que estiver salvo no painel (Valores e dias).
    fetch(API + '?api=config').then(function (r) { return r.json(); }).then(function (c) {
      if (c && Array.isArray(c.servicos) && c.servicos.length) {
        CONFIG = { servicos: c.servicos.map(function (s) { return { id: s.id, nome: s.nome, para: s.para, desc: s.desc, dias: arr(s.dias), obs: s.obs }; }), pagamento: c.pagamento || PADRAO.pagamento };
        renderCards(); renderServ();
      }
    }).catch(function () { /* fica com o padrão */ });
  }

  function enviar(e) {
    e.preventDefault();
    var f = e.target, err = $('#err'); err.textContent = '';
    var bad = $$('#f [required]').filter(function (i) { return i.type === 'checkbox' ? !i.checked : !String(i.value).trim(); })[0];
    if (bad) { err.textContent = bad.name === 'lgpd' ? 'Marque a autorização da LGPD para enviar.' : 'Preencha todos os campos com *.'; bad.focus(); return; }
    if (f.whatsapp.value.replace(/\D/g, '').length < 10) { err.textContent = 'WhatsApp incompleto.'; f.whatsapp.focus(); return; }
    function all(n) { return $$('#f [name=' + n + ']:checked').map(function (i) { return i.value; }); }
    if (!all('serv').length) { err.textContent = 'Escolha pelo menos um serviço.'; return; }
    if (!all('hor').length) { err.textContent = 'Marque os dias e horários que você pode.'; return; }
    var data = {
      funcao: ($('[name=funcao]:checked') || {}).value, nome: f.nome.value.trim(), whatsapp: f.whatsapp.value,
      servicos: all('serv'), horarios: all('hor'), experiencia: f.experiencia.value, apps: all('apps'),
      obs: f.obs.value.trim(), lgpd: true, enviadoEm: new Date().toISOString()
    };
    var btn = f.querySelector('.send'); btn.disabled = true; btn.textContent = 'Enviando...';
    function falha(msg) { err.textContent = msg || 'Não deu para enviar agora. Confira a internet e tente de novo.'; btn.disabled = false; btn.textContent = 'Enviar cadastro'; }
    fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(data) })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (!r || !r.ok) return falha(r && r.erro ? 'Não deu para enviar: ' + r.erro : null);
        f.classList.add('hide'); $('#dn').textContent = data.nome.split(' ')[0]; $('#done').classList.remove('hide');
        $('#cadastro').scrollIntoView({ behavior: 'smooth' });
      })
      .catch(function () { falha(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar); else iniciar();
})();
