'use strict';
// Código compartilhado pelos leitores dos portais.
// Roda DENTRO da aba do portal que você já abriu, com o seu login.
// Lê apenas os códigos dos pacotes; nome, telefone e demais dados são ignorados.

/* eslint-disable no-unused-vars */
const GOBOX_INTERVALO_MIN = 10;

function goboxNormalizar(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/^[\s ​-‍⁠﻿]+|[\s ​-‍⁠﻿]+$/g, '').toUpperCase();
}

class GoboxSessaoExpirada extends Error {}

async function goboxBuscarJson(url, opcoes = {}) {
  const init = { method: opcoes.method || 'GET', credentials: 'include', headers: { Accept: 'application/json' } };
  if (opcoes.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opcoes.body);
  }
  const resp = await fetch(url, init);
  if (resp.status === 401 || resp.status === 403) throw new GoboxSessaoExpirada('Sessão expirada no portal: faça login de novo.');
  const texto = await resp.text();
  try {
    return JSON.parse(texto);
  } catch {
    throw new GoboxSessaoExpirada('Sessão expirada no portal: faça login de novo.');
  }
}

function goboxEnviar(fonte, resultado) {
  try {
    chrome.runtime.sendMessage({ tipo: 'gobox-sincronizar', fonte, ...resultado });
  } catch {
    // Extensão recarregada: a próxima passada envia.
  }
}

// Executa a leitura agora, a cada X minutos enquanto a aba estiver aberta,
// e quando o popup pedir "Sincronizar agora".
function goboxAgendar(fonte, ler) {
  let rodando = false;
  const passada = async () => {
    if (rodando) return;
    rodando = true;
    try {
      const resultado = await ler();
      // Leitores novos devolvem { pacotes, modo }; os antigos, um Set de códigos.
      if (resultado && Array.isArray(resultado.pacotes)) goboxEnviar(fonte, resultado);
      else goboxEnviar(fonte, { codigos: [...resultado] });
    } catch (e) {
      goboxEnviar(fonte, { erro: e && e.message ? e.message : 'Falha ao ler o portal.' });
    } finally {
      rodando = false;
    }
  };
  setTimeout(passada, 5000);
  setInterval(passada, GOBOX_INTERVALO_MIN * 60_000);
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.tipo === 'gobox-agora') passada();
  });
}
