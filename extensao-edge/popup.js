'use strict';
const $ = (s) => document.querySelector(s);
const FONTES = [
  { id: 'shopee', nome: 'Shopee SPX', url: 'https://sp.spx.shopee.com.br/*' },
  { id: 'ml', nome: 'Mercado Livre', url: 'https://places.mercadolivre.com.br/*' },
  { id: 'correios', nome: 'Correios', url: 'https://correiosatende.correios.com.br/*' },
  { id: 'sacas', nome: 'Sacas (ML Envios)', url: 'https://envios.mercadolivre.com.br/*' }
];
const ROTULO = {
  sucesso: ['Enviado', 'ok'],
  aguardando_confirmacao: ['Confirmar no painel', 'alerta'],
  falhou: ['Falhou', 'erro'],
  erro_envio: ['Não enviado', 'erro']
};

function quando(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

async function desenhar() {
  const { status = {} } = await chrome.storage.local.get('status');
  const abas = await chrome.tabs.query({ url: FONTES.map((f) => f.url) });
  const area = $('#lista-status');
  area.replaceChildren();
  for (const f of FONTES) {
    const s = status[f.id];
    const aberta = abas.some((t) => t.url && t.url.startsWith(f.url.replace('*', '')));
    const [rotulo, classe] = s ? (ROTULO[s.situacao] || ['—', 'nada']) : ['Aguardando', 'nada'];
    const linha = document.createElement('div');
    linha.className = 'fonte';
    const esq = document.createElement('div');
    const nome = document.createElement('div');
    nome.className = 'nome';
    nome.textContent = f.nome;
    const det = document.createElement('div');
    det.className = 'det';
    const partes = [];
    if (!aberta) partes.push('Aba não está aberta.');
    if (f.id === 'sacas' && s && s.em) partes.push(quando(s.em));
    else if (s && s.codigos !== undefined && s.situacao === 'sucesso') partes.push(`${s.codigos} pacote(s) · ${quando(s.em)}`);
    else if (s && s.em) partes.push(quando(s.em));
    if (s && s.detalhe) partes.push(s.detalhe);
    det.textContent = partes.join(' ');
    esq.append(nome, det);
    const pil = document.createElement('span');
    pil.className = `pilula ${classe}`;
    pil.textContent = rotulo;
    linha.append(esq, pil);
    area.append(linha);
  }
}

async function carregarConfig() {
  const { servidor = 'http://localhost:3000', chave = '', trocarPontoShopee = true, mcuCorreios = '', recarregarMin = 5 } =
    await chrome.storage.local.get(['servidor', 'chave', 'trocarPontoShopee', 'mcuCorreios', 'recarregarMin']);
  $('#recarregar-min').value = String(recarregarMin);
  $('#mcu').value = mcuCorreios;
  $('#servidor').value = servidor;
  $('#chave').value = chave;
  $('#trocar-ponto').checked = trocarPontoShopee;
  if (!chave) $('#config').open = true;
}

$('#salvar').addEventListener('click', async () => {
  const msg = $('#msg-config');
  const servidor = ($('#servidor').value.trim() || 'http://localhost:3000').replace(/\/+$/, '');
  const chave = $('#chave').value.trim();
  try {
    const u = new URL(servidor);
    if (u.protocol === 'https:') {
      const ok = await chrome.permissions.request({ origins: [`${u.origin}/*`] });
      if (!ok) { msg.textContent = 'Permissão para o endereço do site negada.'; return; }
    } else if (!['localhost', '127.0.0.1'].includes(u.hostname)) {
      msg.textContent = 'Use https:// para um site fora deste computador.';
      return;
    }
  } catch {
    msg.textContent = 'Endereço inválido.';
    return;
  }
  const mcu = $('#mcu').value.replace(/\D/g, '').slice(0, 8);
  await chrome.storage.local.set({ servidor, chave, trocarPontoShopee: $('#trocar-ponto').checked, ...(mcu ? { mcuCorreios: mcu } : {}) });
  msg.textContent = 'Testando…';
  try {
    const r = await fetch(`${servidor}/api/extensao/status`, { headers: { Authorization: `Bearer ${chave}` } });
    const d = await r.json().catch(() => ({}));
    msg.textContent = r.ok ? 'Conectado ao site da GoBox.' : (d.erro || `O site respondeu ${r.status}.`);
  } catch {
    msg.textContent = 'Não consegui falar com o site. Ele está aberto (iniciar.bat)?';
  }
});

$('#agora').addEventListener('click', async () => {
  const abas = await chrome.tabs.query({ url: FONTES.map((f) => f.url) });
  if (!abas.length) {
    $('#lista-status').insertAdjacentHTML('beforeend', '<p class="ajuda">Abra a Shopee SPX e/ou o Mercado Livre Places e faça login.</p>');
    return;
  }
  for (const t of abas) chrome.tabs.sendMessage(t.id, { tipo: 'gobox-agora' }).catch(() => {});
  $('#agora').textContent = 'Sincronizando…';
  setTimeout(() => { $('#agora').textContent = 'Sincronizar agora'; desenhar(); }, 6000);
});

// Diagnóstico: formato das respostas da tela de sacas (sem dados de clientes), para colar no chat.
$('#diag-sacas').addEventListener('click', async () => {
  const { amostrasSacas = [] } = await chrome.storage.local.get('amostrasSacas');
  const msg = $('#msg-diag');
  if (!amostrasSacas.length) {
    msg.textContent = 'Nada capturado ainda: abra "Entrada de unidades", clique num envio e em "Ver distribuição por zonas".';
    return;
  }
  await navigator.clipboard.writeText(JSON.stringify(amostrasSacas, null, 1));
  msg.textContent = `Copiado (${amostrasSacas.length} resposta(s)). Cole no chat com o Claude.`;
});

chrome.storage.onChanged.addListener((mud) => { if (mud.status) desenhar(); });
carregarConfig();
desenhar();

// O tempo de recarga vale na hora, sem precisar de "Salvar e testar".
$('#recarregar-min').addEventListener('change', (ev) => chrome.storage.local.set({ recarregarMin: Number(ev.target.value) }));
