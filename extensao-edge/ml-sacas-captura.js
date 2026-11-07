'use strict';
// Roda no contexto da própria página "Entrada de unidades" (Mercado Livre Envios).
// Só observa as respostas que a página já recebe do Mercado Livre (fetch/XHR em JSON)
// e repassa para o leitor da extensão. Não faz nenhuma chamada nova.
(function () {
  const MARCA = 'gobox-sacas-resposta';
  const LIMITE = 400_000; // caracteres
  function repassar(url, texto) {
    try {
      if (!texto || texto.length > LIMITE) return;
      const t = texto.trim();
      if (t[0] !== '{' && t[0] !== '[') return;
      window.postMessage({ marca: MARCA, url: String(url), texto: t }, window.location.origin);
    } catch { /* nada */ }
  }
  const fetchOriginal = window.fetch;
  window.fetch = async function (...args) {
    const resp = await fetchOriginal.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      const tipo = resp.headers.get('content-type') || '';
      if (tipo.includes('json')) resp.clone().text().then((t) => repassar(url, t)).catch(() => {});
    } catch { /* nada */ }
    return resp;
  };
  const abrir = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (metodo, url, ...resto) {
    this.__goboxUrl = url;
    this.addEventListener('load', () => {
      try {
        const tipo = this.getResponseHeader('content-type') || '';
        if (tipo.includes('json') && (this.responseType === '' || this.responseType === 'text')) repassar(this.__goboxUrl, this.responseText);
      } catch { /* nada */ }
    });
    return abrir.call(this, metodo, url, ...resto);
  };
}());
