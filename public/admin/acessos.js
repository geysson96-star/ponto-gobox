'use strict';
// Aba Acessos do painel: uso da página pública de consulta.
(function () {
  const $ = (s) => document.querySelector(s);
  const num = (n) => Number(n || 0).toLocaleString('pt-BR');
  const diaBr = (d) => { const [a, m, dd] = d.split('-'); return `${dd}/${m}/${a}`; };
  const semana = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '');
  let timer = null;

  function cartao(titulo, s) {
    const c = document.createElement('article');
    c.className = 'ace-cartao';
    const h = document.createElement('h2'); h.textContent = titulo;
    const n = document.createElement('div'); n.className = 'ace-numero'; n.textContent = num(s.visitantes);
    const p = document.createElement('div'); p.className = 'ace-detalhe';
    p.textContent = `pessoas · ${num(s.visitas)} visitas · ${num(s.consultas)} pesquisas (${num(s.encontrados)} encontradas)`;
    c.append(h, n, p);
    return c;
  }

  async function carregar() {
    const aviso = $('#ace-aviso');
    try {
      const r = await fetch('/admin/api/acessos', { credentials: 'same-origin' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.erro || 'Não consegui carregar os acessos.');
      aviso.hidden = true;
      const box = $('#ace-cartoes');
      box.replaceChildren(cartao('Hoje', d.hoje), cartao('Últimos 7 dias', d.semana), cartao('Últimos 30 dias', d.mes), cartao('Desde o início', d.total));
      $('#ace-desde').textContent = d.desde ? `Contando desde ${diaBr(d.desde)}` : 'Ainda sem acessos registrados';
      const corpo = $('#ace-dias');
      corpo.replaceChildren();
      const max = Math.max(1, ...d.dias.map((x) => x.visitantes));
      if (!d.dias.length) {
        const tr = document.createElement('tr'); const td = document.createElement('td');
        td.colSpan = 5; td.textContent = 'Nenhum acesso ainda. Assim que alguém abrir a página de consulta, aparece aqui.';
        tr.append(td); corpo.append(tr);
      }
      for (const x of d.dias) {
        const tr = document.createElement('tr');
        const c0 = document.createElement('td'); c0.textContent = `${diaBr(x.dia)} (${semana(x.dia)})`;
        const c1 = document.createElement('td'); c1.textContent = num(x.visitantes);
        const barra = document.createElement('span'); barra.className = 'ace-barra'; barra.style.width = `${Math.round((x.visitantes / max) * 80)}px`;
        c1.append(barra);
        const c2 = document.createElement('td'); c2.textContent = num(x.visitas);
        const c3 = document.createElement('td'); c3.textContent = num(x.consultas);
        const c4 = document.createElement('td'); c4.textContent = num(x.encontrados);
        tr.append(c0, c1, c2, c3, c4);
        corpo.append(tr);
      }
    } catch (e) {
      aviso.textContent = e.message;
      aviso.hidden = false;
    }
  }

  $('#ace-atualizar')?.addEventListener('click', carregar);
  window.goboxAcessos = {
    abrir() { carregar(); clearInterval(timer); timer = setInterval(carregar, 60_000); },
    fechar() { clearInterval(timer); timer = null; }
  };
}());
