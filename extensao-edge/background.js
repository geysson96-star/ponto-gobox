'use strict';
// Recebe os códigos lidos nas abas dos portais e envia ao site da GoBox.
// A chave da extensão fica só neste navegador (armazenamento da extensão).

const NOMES = { shopee: 'Shopee SPX', ml: 'Mercado Livre', correios: 'Correios' };

async function config() {
  const { servidor = 'https://gobox-consulta.onrender.com', chave = '' } = await chrome.storage.local.get(['servidor', 'chave']);
  return { servidor: servidor.replace(/\/+$/, ''), chave };
}

async function guardarStatus(fonte, status) {
  const { status: todos = {} } = await chrome.storage.local.get('status');
  todos[fonte] = { ...status, em: new Date().toISOString() };
  await chrome.storage.local.set({ status: todos });
  const algumErro = Object.values(todos).some((s) => s.situacao === 'falhou' || s.situacao === 'erro_envio');
  chrome.action.setBadgeText({ text: algumErro ? '!' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#C41A05' });
}

async function enviar(msg) {
  const { servidor, chave } = await config();
  if (!chave) {
    await guardarStatus(msg.fonte, { situacao: 'erro_envio', detalhe: 'Cole a chave da extensão (gerada no painel do site).' });
    return;
  }
  let corpo;
  if (msg.erro) corpo = { fonte: msg.fonte, erro: msg.erro };
  else if (Array.isArray(msg.pacotes)) corpo = { fonte: msg.fonte, pacotes: msg.pacotes, modo: msg.modo };
  else corpo = { fonte: msg.fonte, codigos: msg.codigos };
  try {
    const resp = await fetch(`${servidor}/api/extensao/sincronizar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${chave}` },
      body: JSON.stringify(corpo)
    });
    const dados = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      await guardarStatus(msg.fonte, { situacao: 'erro_envio', detalhe: dados.erro || `O site respondeu ${resp.status}.` });
      return;
    }
    if (msg.erro) {
      await guardarStatus(msg.fonte, { situacao: 'falhou', detalhe: msg.erro });
    } else {
      await guardarStatus(msg.fonte, {
        situacao: dados.situacao,
        codigos: dados.codigos,
        detalhe: dados.situacao === 'aguardando_confirmacao'
          ? 'A lista veio bem menor que a anterior: confirme no painel (Importações).'
          : null
      });
    }
  } catch {
    await guardarStatus(msg.fonte, { situacao: 'erro_envio', detalhe: 'Não consegui falar com o site. Ele está aberto (iniciar.bat)?' });
  }
}

// Configuração automática: se a pasta da extensão tem config-local.json
// (criado pelo site no seu computador) e ainda não há chave salva, usa ela.
// O arquivo pode ser atualizado depois (ex.: quando o site for publicado na internet):
// se ele tiver "atualizadoEm" mais novo que o já aplicado, a nova configuração vale.
async function configurarSozinha() {
  const { chave, configAplicadaEm = '' } = await chrome.storage.local.get(['chave', 'configAplicadaEm']);
  try {
    const r = await fetch(chrome.runtime.getURL('config-local.json'));
    if (!r.ok) return;
    const c = await r.json();
    if (!c || !c.chave) return;
    const novo = c.atualizadoEm && String(c.atualizadoEm) > String(configAplicadaEm);
    if (!chave || novo) {
      await chrome.storage.local.set({
        servidor: c.servidor || 'http://localhost:3000',
        chave: c.chave,
        configAplicadaEm: c.atualizadoEm || configAplicadaEm
      });
    }
  } catch { /* sem arquivo: configurar pelo popup */ }
}
chrome.runtime.onInstalled.addListener(configurarSozinha);
chrome.runtime.onStartup.addListener(configurarSozinha);
configurarSozinha();

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.tipo === 'gobox-sincronizar' && NOMES[msg.fonte]) enviar(msg);
});
