'use strict';
// Relatório de faturamento do ano (Shopee, Mercado Livre e Correios) para imprimir ou salvar em PDF.
(function () {
  const $ = (s) => document.querySelector(s);
  const NS = 'http://www.w3.org/2000/svg';
  const EMP = [
    { id: 'shopee', nome: 'Shopee', cor: '#E0522A' },
    { id: 'correios', nome: 'Correios', cor: '#2B59C3' },
    { id: 'ml', nome: 'Mercado Livre', cor: '#C99400' }
  ];
  const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const MESES_LONGO = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const brl0 = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
  const num = (n) => Number(n || 0).toLocaleString('pt-BR');
  const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}`.replace('.', ',') + '%' : '—');
  const nomeMes = (mes) => MESES_LONGO[Number(mes.slice(5)) - 1];
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function svg(tag, attrs, ...filhos) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
    for (const f of filhos) if (f) n.append(f);
    return n;
  }
  function titulo(t) { const x = document.createElementNS(NS, 'title'); x.textContent = t; return x; }
  function escala(max) {
    // Topo "redondo" e 4 linhas de grade.
    if (max <= 0) return { topo: 1, passo: 0.25 };
    const bruto = max / 4;
    const p = Math.pow(10, Math.floor(Math.log10(bruto)));
    const passo = [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= bruto);
    return { topo: passo * 4, passo };
  }
  // Barras empilhadas por mês (um eixo só). campo: 'valor' ou 'pacotes'.
  function barrasEmpilhadas(meses, campo, fmtEixo, fmtDica) {
    const W = 720, H = 250, E = 56, B = 26, T = 10;
    const larg = (W - E) / 12;
    const totais = meses.map((m) => (m.semDados ? 0 : EMP.reduce((s, e) => s + (m[e.id] ? m[e.id][campo] : 0), 0)));
    const { topo, passo } = escala(Math.max(...totais, 0));
    const y = (v) => T + (H - T - B) * (1 - v / topo);
    const g = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'grafico', role: 'img', 'aria-label': campo === 'valor' ? 'Faturamento por mês' : 'Pacotes por mês' });
    for (let v = 0; v <= topo + 1e-9; v += passo) {
      g.append(svg('line', { x1: E, x2: W, y1: y(v), y2: y(v), stroke: v === 0 ? '#C9CED8' : '#EEF0F4', 'stroke-width': 1 }));
      const t = svg('text', { x: E - 8, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 10, fill: '#5E6475' }); t.textContent = fmtEixo(v); g.append(t);
    }
    for (let i = 0; i < 12; i++) {
      const x = E + i * larg;
      const rot = svg('text', { x: x + larg / 2, y: H - 8, 'text-anchor': 'middle', 'font-size': 10.5, fill: '#5E6475' }); rot.textContent = MESES[i]; g.append(rot);
      const m = meses[i];
      if (!m || m.semDados) continue;
      const bw = Math.min(34, larg * 0.62), bx = x + (larg - bw) / 2;
      let acum = 0;
      const partes = EMP.map((e) => ({ e, v: m[e.id] ? m[e.id][campo] : 0 })).filter((p) => p.v > 0);
      partes.forEach((p, k) => {
        const y0 = y(acum), y1 = y(acum + p.v);
        const h = Math.max(0, y0 - y1 - (k < partes.length - 1 ? 2 : 0)); // 2px de respiro entre as partes
        const topoBarra = k === partes.length - 1;
        const r = topoBarra ? Math.min(4, h / 2, bw / 2) : 0;
        const yy = y0 - h - (k > 0 ? 0 : 0);
        const d = r
          ? `M${bx},${y0} V${yy + r} Q${bx},${yy} ${bx + r},${yy} H${bx + bw - r} Q${bx + bw},${yy} ${bx + bw},${yy + r} V${y0} Z`
          : `M${bx},${y0} V${yy} H${bx + bw} V${y0} Z`;
        g.append(svg('path', { d, fill: p.e.cor }, titulo(`${MESES_LONGO[i]} · ${p.e.nome}: ${fmtDica(p.v)}`)));
        acum += p.v;
      });
      if (totais[i] > 0) {
        const t = svg('text', { x: x + larg / 2, y: y(totais[i]) - 5, 'text-anchor': 'middle', 'font-size': 9.5, 'font-weight': 600, fill: '#141826' });
        t.textContent = campo === 'valor' ? brl0(totais[i]).replace('R$', '').trim() : num(totais[i]);
        g.append(t);
      }
    }
    return g;
  }
  const legenda = () => `<p class="legenda">${EMP.map((e) => `<span><i class="leg-${e.id}"></i>${e.nome}</span>`).join('')}</p>`;

  function montar(d) {
    const comDados = d.meses.filter((m) => !m.semDados);
    const folha = $('#folha');
    const gerado = new Date(d.geradoEm).toLocaleString('pt-BR', { dateStyle: 'long', timeStyle: 'short' });
    if (!comDados.length) {
      folha.innerHTML = `<p class="carregando">Ainda não há dados de faturamento registrados em ${d.ano}.</p>`;
      return;
    }
    const tot = { valor: 0, pacotes: 0 };
    const porEmp = Object.fromEntries(EMP.map((e) => [e.id, { valor: 0, pacotes: 0 }]));
    for (const m of comDados) {
      tot.valor += m.total; tot.pacotes += m.pacotes;
      for (const e of EMP) { porEmp[e.id].valor += m[e.id].valor; porEmp[e.id].pacotes += m[e.id].pacotes; }
    }
    const fechados = comDados.filter((m) => !m.emAndamento);
    const base = fechados.length ? fechados : comDados;
    const melhor = base.reduce((a, b) => (b.total > a.total ? b : a));
    const mediaMes = base.reduce((s, m) => s + m.total, 0) / base.length;
    const primeiro = comDados[0].mes;
    const andamento = comDados.find((m) => m.emAndamento);
    const lider = EMP.slice().sort((a, b) => porEmp[b.id].valor - porEmp[a.id].valor)[0];

    // Destaques (só fatos tirados dos números)
    const dest = [];
    dest.push(`${lider.nome} é a maior fonte de receita: ${brl(porEmp[lider.id].valor)} (${pct(porEmp[lider.id].valor, tot.valor)} do total).`);
    dest.push(`Melhor mês ${fechados.length ? 'fechado' : ''}: ${nomeMes(melhor.mes)}, com ${brl(melhor.total)} e ${num(melhor.pacotes)} pacotes.`.replace('  ', ' '));
    if (fechados.length >= 2) {
      const a = fechados[fechados.length - 2], b = fechados[fechados.length - 1];
      const v = a.total ? ((b.total - a.total) / a.total) * 100 : 0;
      dest.push(`De ${nomeMes(a.mes)} para ${nomeMes(b.mes)} o faturamento ${v >= 0 ? 'subiu' : 'caiu'} ${Math.abs(Math.round(v * 10) / 10).toString().replace('.', ',')}% (${brl(a.total)} → ${brl(b.total)}).`);
    }
    for (const e of EMP) if (porEmp[e.id].pacotes) dest.push(`${e.nome}: ${num(porEmp[e.id].pacotes)} pacotes, média de ${brl(porEmp[e.id].valor / porEmp[e.id].pacotes)} por pacote.`);
    if (andamento) dest.push(`${nomeMes(andamento.mes)[0].toUpperCase() + nomeMes(andamento.mes).slice(1)} ainda está em andamento: ${brl(andamento.total)} e ${num(andamento.pacotes)} pacotes até agora.`);

    const linhas = d.meses.map((m) => m.semDados
      ? `<tr class="vazio"><td>${MESES_LONGO[Number(m.mes.slice(5)) - 1]}</td><td colspan="7">sem registro</td></tr>`
      : `<tr><td>${nomeMes(m.mes)}${m.emAndamento ? ' *' : ''}</td>${EMP.map((e) => `<td>${num(m[e.id].pacotes)}</td><td>${brl(m[e.id].valor)}</td>`).join('')}<td><b>${brl(m.total)}</b></td></tr>`).join('');

    folha.innerHTML = `
      <header class="cab">
        <div><img src="/assets/wordmark.webp" alt="GoBox"><h1>Relatório de faturamento ${d.ano}</h1></div>
        <div class="meta">Shopee · Mercado Livre · Correios<br>Gerado em ${esc(gerado)}</div>
      </header>
      <p class="aviso-dados">Dados registrados pelo site da GoBox desde ${nomeMes(primeiro)} de ${primeiro.slice(0, 4)}. ${primeiro.slice(5) !== '01' ? 'Os meses anteriores não têm registro no site. ' : ''}Valores pelas regras do painel de Faturamento (inclui os estimados que estiverem ligados lá).${andamento ? ' * mês em andamento.' : ''}</p>
      <section class="kpis bloco">
        <div class="kpi"><small>Faturamento no ano</small><b>${brl(tot.valor)}</b><span>${comDados.length} ${comDados.length === 1 ? 'mês' : 'meses'} com dados</span></div>
        <div class="kpi"><small>Pacotes no ano</small><b>${num(tot.pacotes)}</b><span>as três empresas</span></div>
        <div class="kpi"><small>Média por pacote</small><b>${brl(tot.pacotes ? tot.valor / tot.pacotes : 0)}</b><span>faturamento ÷ pacotes</span></div>
        <div class="kpi"><small>Média por mês</small><b>${brl(mediaMes)}</b><span>${fechados.length ? 'meses fechados' : 'até agora'}</span></div>
      </section>
      <section class="bloco"><h2>Faturamento por mês</h2><p class="sub">Quanto a GoBox ganhou de cada empresa, mês a mês.</p>${legenda()}<div id="g-valor"></div></section>
      <section class="bloco"><h2>Pacotes por mês</h2><p class="sub">Pacotes que contam para o pagamento de cada empresa.</p>${legenda()}<div id="g-pacotes"></div></section>
      <section class="dois bloco">
        <div><h2>Participação no faturamento</h2><p class="sub">Parte de cada empresa no total do ano.</p><div class="part" id="part"></div></div>
        <div><h2>Destaques</h2><ul class="destaques">${dest.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>
      </section>
      <section class="bloco quebra-tabela"><h2>Mês a mês</h2>
        <div class="tabela-rolagem"><table>
          <thead><tr><th></th>${EMP.map((e) => `<th class="grupo" colspan="2">${e.nome}</th>`).join('')}<th></th></tr>
          <tr><th>Mês</th>${EMP.map(() => '<th>Pacotes</th><th>Valor</th>').join('')}<th>Total</th></tr></thead>
          <tbody>${linhas}
          <tr class="tot"><td>Total</td>${EMP.map((e) => `<td>${num(porEmp[e.id].pacotes)}</td><td>${brl(porEmp[e.id].valor)}</td>`).join('')}<td>${brl(tot.valor)}</td></tr></tbody>
        </table></div>
      </section>
      <footer class="rodape"><span>GoBox · Tobias Barreto/SE</span><span>gobox-consulta.onrender.com</span></footer>`;

    $('#g-valor').append(barrasEmpilhadas(d.meses, 'valor', (v) => brl0(v).replace(/\s/g, ' '), brl));
    $('#g-pacotes').append(barrasEmpilhadas(d.meses, 'pacotes', (v) => num(v), (v) => `${num(v)} pacotes`));
    const part = $('#part');
    for (const e of EMP.slice().sort((a, b) => porEmp[b.id].valor - porEmp[a.id].valor)) {
      const p = tot.valor ? (porEmp[e.id].valor / tot.valor) * 100 : 0;
      const linha = document.createElement('div');
      linha.className = 'part-linha';
      linha.innerHTML = `<span>${e.nome}</span><div class="part-trilho"><span></span></div><b>${pct(porEmp[e.id].valor, tot.valor)}</b>`;
      const barra = linha.querySelector('.part-trilho span');
      barra.style.width = `${p}%`;
      barra.style.background = e.cor;
      linha.title = `${e.nome}: ${brl(porEmp[e.id].valor)}`;
      part.append(linha);
    }
    document.title = `Relatório de faturamento ${d.ano} · GoBox`;
  }

  async function carregar(ano) {
    $('#folha').innerHTML = '<p class="carregando">Montando o relatório…</p>';
    try {
      const r = await fetch(`/admin/api/financeiro/relatorio?ano=${encodeURIComponent(ano)}`, { credentials: 'same-origin' });
      if (r.status === 401) { location.href = '/admin/'; return; }
      const d = await r.json();
      if (!r.ok) throw new Error(d.erro || 'Não consegui montar o relatório.');
      montar(d);
    } catch (e) {
      $('#folha').innerHTML = `<p class="erro">${esc(e.message)}</p>`;
    }
  }

  const sel = $('#ano');
  const params = new URLSearchParams(location.search);
  const anoAtual = new Date().getFullYear();
  for (let a = anoAtual; a >= 2026; a--) { const o = document.createElement('option'); o.value = a; o.textContent = a; sel.append(o); }
  sel.value = params.get('ano') || anoAtual;
  sel.addEventListener('change', () => { history.replaceState(null, '', `?ano=${sel.value}`); carregar(sel.value); });
  $('#imprimir').addEventListener('click', () => window.print());
  carregar(sel.value);
}());
