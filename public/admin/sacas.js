'use strict';
// Aba Sacas do painel: envios do Mercado Livre do dia, prévia das mensagens e avisos enviados.
(function () {
  const $ = (s) => document.querySelector(s);
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
    if (!r.ok) throw new Error(d.erro || 'Não consegui carregar as sacas.');
    return d;
  }
  const hora = (iso) => (iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bahia' }) : '');
  const quando = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Bahia' }) : '');
  const STATUS = { agendado: 'Agendado', a_caminho: 'A caminho', recebido: 'Recebido' };
  const SITUACAO = {
    teste: 'Modo teste (não enviado)', pendente: 'Na fila do n8n (sai em até 1 min)', enviando: 'Enviando…', enviado: 'Enviado', falhou: 'Falhou'
  };

  let timer = null;

  function chave(id, rotulo, marcado, onchange) {
    const input = el('input', { type: 'checkbox', id, onchange });
    input.checked = Boolean(marcado);
    return el('label', { class: 'fin-chave', for: id }, input, el('span', { class: 'fin-chave-trilho', 'aria-hidden': 'true' }), rotulo);
  }
  async function salvar(patch) {
    try { await api('/sacas/config', { method: 'PUT', body: patch }); } catch (e) { alert(e.message); }
    carregar();
  }

  function desenharConfig(c) {
    const box = $('#sac-config');
    box.replaceChildren(
      chave('sac-ativo', 'Enviar para o grupo', c.ativo, (ev) => {
        const ligar = ev.target.checked;
        if (ligar && !confirm('Ligar o envio? A partir de agora, cada envio que chegar vai para o grupo dos entregadores pelo n8n.')) { ev.target.checked = false; return; }
        salvar({ ativo: ligar });
      }),
      chave('sac-caminho', 'Avisar também quando sair (a caminho)', c.avisoCaminho, (ev) => salvar({ avisoCaminho: ev.target.checked })),
      chave('sac-zonas', 'Incluir zonas na mensagem', c.zonas, (ev) => salvar({ zonas: ev.target.checked })),
      el('p', { class: 'sac-estado' }, c.ativo
        ? 'Envio ligado: os avisos novos entram na fila e o n8n manda no grupo.'
        : 'Modo teste: os avisos aparecem abaixo para você conferir, mas nada é enviado.'),
      c.ativo ? el('button', {
        type: 'button', class: 'botao-secundario',
        onclick: async (ev) => {
          if (!confirm('Mandar de novo, nos grupos, a mensagem de chegada de cada envio recebido hoje? O n8n manda uma por minuto.')) return;
          ev.target.disabled = true;
          try { const r = await api('/sacas/reenviar-hoje', { method: 'POST' }); alert(`${r.novos} mensagem(ns) na fila. O n8n manda uma por minuto.`); } catch (err) { alert(err.message); }
          ev.target.disabled = false;
          carregar();
        }
      }, 'Reenviar as mensagens de hoje') : null
    );
  }

  function cartaoEnvio(e) {
    const numeros = [];
    const pl = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
    if (e.sacas !== null) numeros.push(pl(e.sacas, 'saca', 'sacas'));
    if (e.entregar) numeros.push(`${e.entregar} Delivery`);
    if (e.extra) numeros.push(`${e.extra} Next`);
    if (e.pacotes !== null) numeros.push(pl(e.pacotes, 'pacote', 'pacotes'));
    if (e.caminhoEm) numeros.push(`saiu ${hora(e.caminhoEm)}`);
    if (e.recebidoEm) numeros.push(`chegou ${hora(e.recebidoEm)}`);
    return el('article', { class: 'sac-envio' },
      el('div', { class: 'sac-envio-topo' },
        el('span', { class: 'sac-envio-num' }, `Envio #${e.numero}`),
        el('span', { class: 'sac-selos' },
          e.onda ? el('span', { class: 'sac-selo onda' }, e.onda) : null,
          el('span', { class: `sac-selo ${e.status === 'recebido' ? 'recebido' : ''}` }, STATUS[e.status] || e.status))),
      el('div', { class: 'sac-numeros' }, numeros.map((n) => el('span', {}, n))),
      (e.previas || []).map((p) => el('div', { class: 'sac-previa-bloco' },
        el('div', { class: 'sac-previa-topo' },
          el('span', { class: 'nota' }, `Grupo ${p.grupoRotulo}`),
          p.grupo && e.status === 'recebido' ? el('button', {
            type: 'button', class: 'botao-texto',
            onclick: async () => {
              if (!confirm(`Mandar agora esta mensagem do envio #${e.numero} no grupo ${p.grupoRotulo}?`)) return;
              try { await api('/sacas/enviar', { method: 'POST', body: { envio: e.chave, grupo: p.grupo } }); } catch (err) { alert(err.message); }
              carregar();
            }
          }, 'Enviar agora') : null),
        el('pre', { class: 'sac-previa', 'aria-label': `Prévia da mensagem para o grupo ${p.grupoRotulo}` }, p.texto))));
  }

  function linhaAviso(a) {
    const acoes = [];
    if (a.situacao === 'falhou' || a.situacao === 'enviado') {
      acoes.push(el('button', {
        type: 'button', class: 'botao-texto',
        onclick: async () => {
          if (!confirm('Mandar este aviso de novo para o grupo?')) return;
          try { await api(`/sacas/avisos/${a.id}/reenviar`, { method: 'POST' }); } catch (e) { alert(e.message); }
          carregar();
        }
      }, 'Reenviar'));
    }
    return el('li', { class: 'sac-aviso' },
      el('div', { class: 'sac-aviso-topo' },
        el('strong', {}, `${a.grupoRotulo} · ${a.tipo === 'caminho' ? 'A caminho' : 'Chegada'} · Envio #${a.numero || '?'}${a.onda ? ` · ${a.onda}` : ''}`),
        el('span', { class: 'nota' }, `${SITUACAO[a.situacao] || a.situacao} · ${quando(a.enviadoEm || a.criadoEm)}`),
        acoes),
      a.erro ? el('span', { class: 'mensagem-erro' }, a.erro) : null,
      el('pre', { class: 'sac-previa' }, a.texto));
  }

  async function carregar() {
    let d;
    try { d = await api('/sacas'); } catch (e) {
      $('#sac-envios').replaceChildren(el('p', { class: 'sac-vazio' }, e.message));
      return;
    }
    desenharConfig(d.config);
    $('#sac-leitura').textContent = d.ultimaLeitura ? `Última leitura da extensão: ${quando(d.ultimaLeitura)}` : 'A extensão ainda não leu a tela de sacas.';
    const hoje = d.envios.filter((e) => e.hoje);
    $('#sac-envios').replaceChildren(...(hoje.length
      ? hoje.map(cartaoEnvio)
      : [el('p', { class: 'sac-vazio' }, 'Nenhum envio hoje ainda. Abra a tela “Entrada de unidades” do Mercado Livre no Edge.')]));
    $('#sac-avisos').replaceChildren(...(d.avisos.length
      ? d.avisos.map(linhaAviso)
      : [el('li', { class: 'sac-vazio' }, 'Nenhum aviso ainda.')]));
  }

  window.goboxSacas = {
    abrir() { carregar(); clearInterval(timer); timer = setInterval(() => { if (!document.hidden) carregar(); }, 30_000); },
    fechar() { clearInterval(timer); timer = null; }
  };
}());
