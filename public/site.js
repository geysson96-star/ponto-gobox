'use strict';
// Ajustes do site ligados no painel (Integrações e ajustes › Site público):
// aviso no topo, horário e endereço, botão do WhatsApp, abas e situação das empresas.
(function () {
  function aplicar(a) {
    if (!a) return;
    if (a.aviso) {
      var f = document.createElement('div');
      f.className = 'faixa-aviso'; f.setAttribute('role', 'note'); f.textContent = a.aviso;
      document.body.insertBefore(f, document.body.firstChild);
    }
    var abas = a.abas || {};
    var links = document.querySelectorAll('.abas-site a');
    for (var i = 0; i < links.length; i++) {
      var h = links[i].getAttribute('href');
      if ((h === '/frete' && abas.frete === false) || (h === '/entregador' && abas.entregador === false)) links[i].hidden = true;
    }
    var fontes = document.getElementById('fontes');
    if (fontes && a.selos === false) fontes.hidden = true;
    var lugar = document.getElementById('site-horario');
    if (lugar && a.horario) {
      (a.horario.linhas || []).forEach(function (l) { var s = document.createElement('span'); s.textContent = l; lugar.append(s); });
      if (a.horario.endereco) {
        var e = document.createElement(a.horario.mapa ? 'a' : 'span');
        e.textContent = a.horario.endereco;
        if (a.horario.mapa) { e.href = a.horario.mapa; e.target = '_blank'; e.rel = 'noopener'; }
        lugar.append(e);
      }
      lugar.hidden = false;
      var rod = document.querySelector('.rodape'); if (rod) rod.hidden = true; // o endereço já aparece aqui
    }
    if (a.whatsapp) {
      var z = document.createElement('a');
      z.className = 'zap-flutuante';
      z.href = 'https://wa.me/' + a.whatsapp.numero + (a.whatsapp.mensagem ? '?text=' + encodeURIComponent(a.whatsapp.mensagem) : '');
      z.target = '_blank'; z.rel = 'noopener'; z.setAttribute('aria-label', 'Falar com a GoBox no WhatsApp');
      z.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.2-.4.7-1.4.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 11.9 11.9 0 0 0 4.6 4c1.7.7 2.4.8 3.2.7.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.3-.2-.5-.3z"/></svg>';
      document.body.append(z);
    }
  }
  fetch('/api/site').then(function (r) { return r.ok ? r.json() : null; }).then(aplicar).catch(function () {});
}());
