'use strict';
(function () {
  const form = document.getElementById('form-consulta');
  const input = document.getElementById('codigo');
  const botao = document.getElementById('botao-consultar');
  const resultado = document.getElementById('resultado');

  const ICONES = {
    ok: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    nao: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
    saiu: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h12M13 7l5 5-5 5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    info: '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 11v5M12 7.5v.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>'
  };

  function dataHora(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const dia = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const hora = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return `${dia} às ${hora}`;
  }

  // Título e detalhes conforme a situação informada pelo site.
  function montar(d) {
    if (!d.encontrado) {
      return { classe: 'nao', icone: 'nao', titulo: 'Pacote não encontrado.', linhas: [] };
    }
    const recebido = dataHora(d.recebidoEm);
    const saida = dataHora(d.saidaEm);
    const linhas = [];
    if (d.status) linhas.push(['Situação', d.status]);
    if (recebido) linhas.push(['Recebido na GoBox', recebido]);
    switch (d.situacao) {
      case 'retirado':
        if (saida) linhas.push(['Retirado em', saida]);
        return { classe: 'saiu', icone: 'saiu', titulo: 'Pacote já foi retirado.', linhas };
      case 'enviado':
        if (saida) linhas.push(['Enviado em', saida]);
        return { classe: 'saiu', icone: 'saiu', titulo: 'Pacote já foi enviado.', linhas };
      case 'saiu':
        if (saida) linhas.push(['Saída registrada em', saida]);
        return { classe: 'saiu', icone: 'saiu', titulo: 'Pacote já saiu da agência.', linhas };
      case 'outro':
        return { classe: 'info', icone: 'info', titulo: 'Pacote encontrado.', linhas };
      default:
        return {
          classe: 'ok', icone: 'ok',
          titulo: d.tipo === 'retirada' ? 'Pacote encontrado: disponível para retirada.' : 'Pacote encontrado.',
          linhas
        };
    }
  }

  function mostrarCartao(d) {
    const { classe, icone, titulo, linhas } = montar(d);
    resultado.innerHTML = '';
    const cartao = document.createElement('div');
    cartao.className = `cartao-resultado ${classe}`;
    const topo = document.createElement('div');
    topo.className = 'cartao-topo';
    const ic = document.createElement('span');
    ic.className = `icone-resultado ${classe}`;
    ic.innerHTML = ICONES[icone];
    const t = document.createElement('span');
    t.className = 'cartao-titulo';
    t.textContent = titulo;
    topo.append(ic, t);
    cartao.append(topo);
    if (linhas.length) {
      const dl = document.createElement('dl');
      dl.className = 'detalhes';
      for (const [k, v] of linhas) {
        const dt = document.createElement('dt');
        dt.textContent = k;
        const dd = document.createElement('dd');
        dd.textContent = v;
        dl.append(dt, dd);
      }
      cartao.append(dl);
    }
    resultado.append(cartao);
  }

  function mostrarAviso(msg) {
    resultado.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'aviso';
    p.textContent = msg;
    resultado.append(p);
  }

  // Última atualização dos dados (vem do site; atualiza a cada minuto).
  const ultima = document.getElementById('ultima-atualizacao');
  async function carregarUltima() {
    try {
      const d = await fetch('/api/atualizacao').then((r) => r.json());
      const txt = dataHora(d.ultimaAtualizacao);
      ultima.hidden = !txt;
      if (txt) ultima.textContent = `Última atualização: ${txt}`;
    } catch { /* sem conexão: mantém o que já estava */ }
  }
  carregarUltima();
  setInterval(carregarUltima, 60_000);

  input.addEventListener('input', () => { resultado.innerHTML = ''; });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const codigo = input.value.trim();
    if (!codigo) {
      mostrarAviso('Digite um código para consultar.');
      input.focus();
      return;
    }
    botao.disabled = true;
    botao.textContent = 'Consultando…';
    try {
      const resp = await fetch('/api/consulta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codigo })
      });
      const dados = await resp.json().catch(() => ({}));
      if (resp.ok && typeof dados.encontrado === 'boolean') {
        mostrarCartao(dados);
        carregarUltima();
      } else if (resp.status === 429 || resp.status === 400) {
        mostrarAviso(dados.erro || 'Não foi possível consultar agora. Tente novamente.');
      } else {
        mostrarAviso('Não foi possível consultar agora. Tente novamente em instantes.');
      }
    } catch {
      mostrarAviso('Sem conexão. Verifique sua internet e tente de novo.');
    } finally {
      botao.disabled = false;
      botao.textContent = 'Consultar';
    }
  });
}());
