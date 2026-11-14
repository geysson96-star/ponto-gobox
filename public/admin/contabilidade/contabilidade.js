// Aba Contabilidade do painel GoBox: contracheques quinzenais e notas fiscais.
// Funcionários e horas extras vêm do Ponto GoBox (mesmas regras de cálculo do ponto).
// O módulo do Ponto (Firebase) é carregado só para os contracheques: se ele falhar,
// as notas fiscais continuam funcionando e as horas podem ser digitadas à mão.
let P = null;
const pad2 = n => String(n).padStart(2, "0");
const keyToDate = k => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
const dayKey = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const today = () => dayKey(new Date());
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const horasTxt = min => { min = Math.round(min || 0); const h = Math.floor(min / 60), m = min % 60; return m ? `${h}h${pad2(m)}` : `${h}h`; };
let toastT;
function toast(msg, err = false) {
  const r = document.querySelector("#toast-root"); if (!r) return;
  r.innerHTML = `<div class="toast ${err ? "err" : ""}" role="status">${esc(msg)}</div>`;
  clearTimeout(toastT); toastT = setTimeout(() => { r.innerHTML = ""; }, err ? 6000 : 3500);
}

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const raiz = $("#raiz");
const brl = v => (Number(v) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const br = s => s ? s.split("-").reverse().join("/") : "—";
const DS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const brw = s => s ? `${DS[keyToDate(s).getDay()]}, ${br(s).slice(0, 5)}` : "—";
const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const pad = n => String(n).padStart(2, "0");
const cent = v => Math.round((Number(v) || 0) * 100) / 100;
const hrs = h => horasTxt(Math.round((Number(h) || 0) * 60));
const NOME = { correios: "Correios", ml: "Mercado Livre", shopee: "Shopee" };

const S = {
  aba: "cc", hoje: today(), ref: null, sel: null,
  emps: {}, cfg: {}, escalas: {}, ponto: {}, pontoEstado: "carregando", pontoErro: "",
  salarios: {}, cc: {}, dados: null
};
S.ref = quinzenaDe(S.hoje);

/* ---------------- servidor ---------------- */
async function api(path, opts = {}) {
  const o = { credentials: "same-origin", cache: "no-store", ...opts, headers: {} };
  if (o.body) { o.headers["Content-Type"] = "application/json"; o.body = JSON.stringify(o.body); }
  const r = await fetch("/admin/api" + path, o);
  const d = await r.json().catch(() => ({}));
  if (r.status === 401) throw new Error("A sessão do painel expirou. Saia e entre de novo.");
  if (!r.ok) throw new Error(d.erro || "Não consegui falar com o servidor.");
  return d;
}
async function carregarDados() {
  const d = await api(`/contabilidade?quinzena=${encodeURIComponent(S.ref)}`);
  S.dados = d; S.salarios = d.salarios || {}; S.cc = d.contracheques || {}; S.hoje = d.hoje || S.hoje;
}

/* ---------------- quinzenas ---------------- */
function quinzenaDe(dia) { return `${dia.slice(0, 7)}-Q${Number(dia.slice(8)) <= 15 ? 1 : 2}`; }
function limitesQ(ref) {
  const [a, m, q] = [Number(ref.slice(0, 4)), Number(ref.slice(5, 7)), Number(ref.slice(9))];
  const ult = new Date(a, m, 0).getDate();
  return { ini: `${ref.slice(0, 7)}-${q === 1 ? "01" : "16"}`, fim: `${ref.slice(0, 7)}-${q === 1 ? "15" : pad(ult)}`, q, mes: m, ano: a };
}
function mudarQuinzena(passo) {
  const l = limitesQ(S.ref);
  const d = keyToDate(passo < 0 ? l.ini : l.fim);
  d.setDate(d.getDate() + (passo < 0 ? -1 : 1));
  S.ref = quinzenaDe(dayKey(d));
}
const rotuloQ = ref => { const l = limitesQ(ref); return `${l.q}ª quinzena de ${MESES[l.mes - 1]}/${l.ano}`; };

/* ---------------- Ponto GoBox ---------------- */
async function conectarPonto() {
  if (!P) P = await import("../ponto/common.js?v=unif1");
  const { configured, auth, db, signInWithEmailAndPassword, signInWithCustomToken, doc, collection, getDoc, getDocs, setRodizio } = P;
  if (!configured) throw new Error("O Ponto GoBox não está configurado.");
  if (auth.authStateReady) await auth.authStateReady();
  if (!auth.currentUser) {
    const r = await fetch("/admin/api/ponto/acesso", { credentials: "same-origin", cache: "no-store" });
    if (!r.ok) throw new Error("O acesso ao ponto não está configurado no servidor.");
    const d = await r.json();
    if (d.token) await signInWithCustomToken(auth, d.token);
    else await signInWithEmailAndPassword(auth, d.email, d.senha);
  }
  const [fs, cfg] = await Promise.all([getDocs(collection(db, "funcionarios")), getDoc(doc(db, "config", "geral"))]);
  const emps = {}; fs.forEach(d => { emps[d.id] = { id: d.id, ...d.data() }; });
  S.emps = emps; S.cfg = cfg.exists() ? cfg.data() : {}; setRodizio(S.cfg.rodizio);
}
const tol = () => Number.isFinite(S.cfg.tolerancia) ? S.cfg.tolerancia : 10;
async function carregarMeses(de, ate) {
  const { db, doc, getDoc } = P;
  const meses = []; let d = keyToDate(de.slice(0, 7) + "-01");
  while (dayKey(d).slice(0, 7) <= ate.slice(0, 7)) { meses.push(dayKey(d).slice(0, 7)); d = new Date(d.getFullYear(), d.getMonth() + 1, 1); }
  await Promise.all(meses.filter(m => !(m in S.escalas)).map(async m => { const s = await getDoc(doc(db, "escala", m)); S.escalas[m] = s.exists() ? s.data() : {}; }));
}
// Mesmo cálculo do relatório do Ponto: extras 50%, 100%, horas devidas e faltas no período.
async function carregarPonto() {
  const ref = S.ref;
  S.pontoEstado = "carregando"; S.ponto = {};
  try {
    if (!Object.keys(S.emps).length) await conectarPonto();
    const { db, collection, getDocs, query, where, derive, isOpen, previsto, extrasDia, agoraMs } = P;
    const { ini, fim } = limitesQ(ref);
    const td = today(), ate = fim < td ? fim : td;
    if (ini > td) { S.pontoEstado = "futuro"; return; }
    const lista = Object.values(S.emps);
    await carregarMeses(ini, ate);
    const snaps = await Promise.all(lista.map(e => getDocs(query(collection(db, "funcionarios", e.id, "dias"), where("data", ">=", ini), where("data", "<=", ate)))));
    if (ref !== S.ref) return;
    lista.forEach((e, i) => {
      const porDia = {}; snaps[i].docs.forEach(d => { const x = d.data(); if ((x.marcacoes || []).length) porDia[x.data] = x; });
      const inicio = e.inicio || (e.criado ? dayKey(new Date(e.criado)) : ini);
      let ex50 = 0, ex100 = 0, deb = 0, faltas = 0, dias = 0;
      const detalhe = [];
      for (let d = keyToDate(ini); dayKey(d) <= ate; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
        const dia = dayKey(d), reg = porDia[dia];
        if (reg) {
          const atual = e.dia === dia && isOpen(e);
          const min = derive(reg.marcacoes, { now: atual ? agoraMs() : null, incompleto: reg.incompleto }).liveMin;
          const x = extrasDia(e, dia, min, tol(), S.escalas);
          ex50 += x.ex50; ex100 += x.ex100; if (!atual) deb += x.deb; dias++;
          detalhe.push({ dia, min, prev: x.prev.min, tipo: x.prev.tipo, ex50: x.ex50, ex100: x.ex100, deb: atual ? 0 : x.deb, aberto: atual });
        } else {
          const p = previsto(e, dia, S.escalas);
          if (p.min && dia < td && dia >= inicio) { faltas++; deb += p.min; detalhe.push({ dia, min: 0, prev: p.min, tipo: p.tipo, falta: true, deb: p.min }); }
        }
      }
      S.ponto[e.id] = { he50: cent(ex50 / 60), he100: cent(ex100 / 60), deb, faltas, dias, detalhe };
    });
    S.pontoEstado = "ok";
  } catch (e) {
    console.warn("[contabilidade] ponto:", e);
    S.pontoEstado = "erro";
    S.pontoErro = e && /configurado/.test(e.message || "") ? e.message : "Não consegui ler as horas no Ponto GoBox agora. Tento de novo sozinho em alguns segundos.";
    // Tenta de novo sozinho; quando conseguir, o aviso some.
    if (!/configurado/.test((e && e.message) || "")) {
      clearTimeout(S.pontoRetry);
      S.pontoRetry = setTimeout(async () => {
        if (ref !== S.ref) return;
        await carregarPonto();
        if (S.aba === "cc") renderCC(); else if (S.aba === "rel") renderRel();
      }, 15000);
    }
  }
}

/* ---------------- cálculo do contracheque ---------------- */
function slip(fid) {
  if (!S.cc[fid]) S.cc[fid] = { base: null, he50: null, he100: null, m50: 1.5, m100: 2, linhas: [], pagoEm: null };
  return S.cc[fid];
}
function calc(fid) {
  const sal = S.salarios[fid] || { salario: 0, carga: 220 };
  const s = slip(fid), p = S.ponto[fid];
  const he50 = s.he50 ?? (p ? p.he50 : 0), he100 = s.he100 ?? (p ? p.he100 : 0);
  const vh = sal.salario / (sal.carga || 220);
  const base = s.base ?? sal.salario / 2;
  const v50 = cent(he50 * vh * s.m50), v100 = cent(he100 * vh * s.m100);
  const prov = s.linhas.filter(l => l.tipo === "p").reduce((a, l) => a + (+l.valor || 0), 0);
  const desc = s.linhas.filter(l => l.tipo === "d").reduce((a, l) => a + (+l.valor || 0), 0);
  const bruto = cent(cent(base) + v50 + v100 + prov);
  return { sal, s, p, he50, he100, vh, base: cent(base), v50, v100, prov: cent(prov), desc: cent(desc), bruto, liq: cent(bruto - desc) };
}
const empsDaQuinzena = () => Object.values(S.emps)
  .filter(e => e.ativo !== false || S.cc[e.id] || (S.ponto[e.id] && S.ponto[e.id].dias))
  .sort((a, b) => (a.nome || "").localeCompare(b.nome || "", "pt-BR"));

let salvarT = {};
function salvarDepois(chave, fn) {
  clearTimeout(salvarT[chave]);
  const ind = $("#salvo"); if (ind) ind.textContent = "Salvando…";
  salvarT[chave] = setTimeout(async () => {
    try { await fn(); const i = $("#salvo"); if (i) i.textContent = "Alterações salvas"; }
    catch (e) { toast(e.message, true); const i = $("#salvo"); if (i) i.textContent = "Não salvou"; }
  }, 500);
}
const salvarSlip = fid => salvarDepois("cc" + fid, () => api(`/contabilidade/contracheques/${S.ref}/${encodeURIComponent(fid)}`, { method: "PUT", body: slip(fid) }));
const salvarSal = fid => salvarDepois("sal" + fid, () => api(`/contabilidade/salarios/${encodeURIComponent(fid)}`, { method: "PUT", body: S.salarios[fid] }));

/* ---------------- tela ---------------- */
function render() {
  raiz.innerHTML = `
    <div class="topo">
      <div><h1>Contabilidade</h1><p>Contracheques da equipe e notas fiscais das empresas.</p></div>
      <div class="subabas" role="tablist">
        <button role="tab" data-aba="cc" aria-selected="${S.aba === "cc"}">Contracheques</button>
        <button role="tab" data-aba="nf" aria-selected="${S.aba === "nf"}">Notas fiscais</button>
        <button role="tab" data-aba="rel" aria-selected="${S.aba === "rel"}">Relatórios</button>
      </div>
    </div>
    <section id="vista"></section>`;
  $$("[data-aba]").forEach(b => b.onclick = () => { S.aba = b.dataset.aba; render(); });
  if (S.aba === "cc") renderCC(); else if (S.aba === "rel") renderRel(); else renderNF();
}

/* ======== CONTRACHEQUES ======== */
function renderCC() {
  const v = $("#vista");
  const emps = empsDaQuinzena();
  if (!S.sel || !emps.find(e => e.id === S.sel)) S.sel = emps[0] && emps[0].id;
  let aviso = "";
  if (S.pontoEstado === "carregando") aviso = `<div class="aviso">Lendo as horas no Ponto GoBox…</div>`;
  else if (S.pontoEstado === "erro") aviso = `<div class="aviso erro">${esc(S.pontoErro)} As horas extras podem ser digitadas à mão.</div>`;
  else if (S.pontoEstado === "futuro") aviso = `<div class="aviso">Essa quinzena ainda não começou: o ponto não tem horas para ela.</div>`;
  v.innerHTML = `
    ${aviso}
    <div class="barra-cc">
      <div class="navq">
        <button class="btn sm" data-q="-1" aria-label="Quinzena anterior">‹</button>
        <strong>${rotuloQ(S.ref)}</strong>
        <button class="btn sm" data-q="1" aria-label="Próxima quinzena">›</button>
        ${S.ref !== quinzenaDe(today()) ? `<button class="btn sm fantasma" data-q="0">Atual</button>` : ""}
      </div>
      <div class="folha" id="folha"></div>
    </div>
    ${!emps.length ? `<div class="bloco vazio">${S.pontoEstado === "carregando" ? "Carregando funcionários…" : "Nenhum funcionário no Ponto GoBox."}</div>` : `
    <div class="grade-cc">
      <div class="lista" role="listbox" aria-label="Funcionários do Ponto GoBox" id="lista"></div>
      <div class="coluna"><div class="bloco" id="editor"></div><div id="recibo-wrap"></div></div>
    </div>`}`;
  $$("[data-q]").forEach(b => b.onclick = async () => {
    const p = Number(b.dataset.q);
    if (p === 0) S.ref = quinzenaDe(today()); else mudarQuinzena(p);
    await trocarQuinzena();
  });
  if (!emps.length) return;
  renderEditor(); atualizarCC();
}
async function trocarQuinzena() {
  S.cc = {}; S.pontoEstado = "carregando"; renderCC();
  try { await carregarDados(); } catch (e) { toast(e.message, true); }
  renderCC();
  await carregarPonto(); if (S.aba === "cc") renderCC(); else if (S.aba === "rel") renderRel();
}
function atualizarCC() {
  const emps = empsDaQuinzena();
  const tot = emps.reduce((a, e) => a + calc(e.id).liq, 0);
  const pagos = emps.filter(e => slip(e.id).pagoEm).length;
  $("#folha").innerHTML = `<span>Folha da quinzena · ${pagos} de ${emps.length} pagos</span><b>${brl(tot)}</b>`;
  $("#lista").innerHTML = emps.map(e => {
    const c = calc(e.id);
    const he = c.he50 + c.he100;
    return `<button class="pessoa" role="option" data-fid="${esc(e.id)}" aria-selected="${e.id === S.sel}">
      <span class="n">${esc(e.nome || "Sem nome")}</span><span class="v">${c.sal.salario ? brl(c.liq) : `<span class="pill p-alerta">sem salário</span>`}</span>
      <span class="m">${esc(e.cargo || "")}${e.ativo === false ? " · desativado" : ""}</span>
      <span class="m r">${slip(e.id).pagoEm ? `<span class="pill p-ok">pago</span>` : he ? hrs(he) + " extras" : ""}</span></button>`;
  }).join("");
  $$(".pessoa").forEach(b => b.onclick = () => { S.sel = b.dataset.fid; renderEditor(); atualizarCC(); });
  $("#recibo-wrap").innerHTML = reciboHTML(S.sel);
}

function renderEditor() {
  const fid = S.sel, e = S.emps[fid], c = calc(fid), s = c.s, p = c.p;
  const el = $("#editor");
  const pontoTxt = p ? `<div class="ponto-info"><span>No ponto nesta quinzena:</span>
      <span>extras 50% <b>${hrs(p.he50)}</b></span><span>extras 100% <b>${hrs(p.he100)}</b></span>
      <span>horas devidas <b>${horasTxt(p.deb)}</b></span><span>faltas <b>${p.faltas}</b></span></div>` : "";
  el.innerHTML = `
    <div class="bloco-h"><h2>${esc(e.nome || "")}</h2><span class="salvo" id="salvo"></span></div>
    <div class="campos">
      <label class="campo">Salário base mensal<input id="f-sal" type="number" step="0.01" min="0" value="${c.sal.salario || ""}" placeholder="Ex.: 1800"><span class="dica">Vale para as próximas quinzenas</span></label>
      <label class="campo">Carga mensal (horas)<input id="f-carga" type="number" min="1" value="${c.sal.carga || 220}"><span class="dica">Valor da hora: ${brl(c.vh)}</span></label>
      <label class="campo">Valor da quinzena<input id="f-base" type="number" step="0.01" min="0" value="${c.base.toFixed(2)}"><span class="dica">${s.base == null ? "Metade do salário" : `Alterado só nesta quinzena · <button type="button" id="b-base">voltar à metade</button>`}</span></label>
    </div>
    <div class="campos" style="margin-top:12px">
      <label class="campo">Horas extras comuns<input id="f-he50" type="number" step="0.25" min="0" value="${c.he50}"><span class="dica">${s.he50 == null ? (p ? "Do ponto" : "Digite as horas") : `Alterado · <button type="button" data-volta="he50">usar o do ponto</button>`}</span></label>
      <label class="campo">Adicional<select id="f-m50">${[1.5, 1.6, 1.7, 1.8, 2].map(m => `<option value="${m}" ${m === s.m50 ? "selected" : ""}>${Math.round((m - 1) * 100)}%</option>`).join("")}</select></label>
      <label class="campo">Horas extras 100%<input id="f-he100" type="number" step="0.25" min="0" value="${c.he100}"><span class="dica">${s.he100 == null ? "Domingos e feriados" : `Alterado · <button type="button" data-volta="he100">usar o do ponto</button>`}</span></label>
    </div>
    ${pontoTxt}
    <div class="linhas">${s.linhas.map((l, i) => `
      <div class="lin">
        <input type="text" aria-label="Descrição" data-i="${i}" data-k="desc" value="${esc(l.desc)}" placeholder="Descrição" maxlength="60">
        <select aria-label="Tipo" data-i="${i}" data-k="tipo"><option value="p" ${l.tipo === "p" ? "selected" : ""}>+ Provento</option><option value="d" ${l.tipo === "d" ? "selected" : ""}>− Desconto</option></select>
        <input type="number" step="0.01" min="0" aria-label="Valor" data-i="${i}" data-k="valor" value="${l.valor}">
        <button class="btn sm fantasma" data-del="${i}" aria-label="Remover">✕</button>
      </div>`).join("")}</div>
    <div class="atalhos">
      <button class="atalho" data-add="p|">+ Provento</button><button class="atalho" data-add="d|">− Desconto</button>
      <button class="atalho" data-add="p|Bônus">Bônus</button><button class="atalho" data-add="d|Vale-transporte">Vale-transporte</button>
      <button class="atalho" data-add="d|Adiantamento">Adiantamento</button><button class="atalho" data-add="d|Falta">Falta</button>
      <button class="atalho" data-add="d|INSS">INSS</button>
    </div>
    <div class="pago">
      <label class="campo" style="flex-direction:row;align-items:center;gap:8px">Pago em<input id="f-pago" type="date" value="${s.pagoEm || ""}"></label>
      <div class="linha">${s.pagoEm ? "" : `<button class="btn" id="b-pago">Paguei hoje</button>`}<button class="btn primario" id="b-imp">Imprimir recibo</button></div>
    </div>`;

  const mudou = (fn, sal = false) => ev => { fn(ev.target.value); sal ? salvarSal(fid) : salvarSlip(fid); atualizarCC(); };
  const salAtual = () => (S.salarios[fid] = S.salarios[fid] || { salario: 0, carga: 220 });
  $("#f-sal").onchange = mudou(v => { salAtual().salario = cent(v); }, true);
  $("#f-carga").onchange = mudou(v => { salAtual().carga = Math.max(1, Math.round(+v || 220)); }, true);
  $("#f-base").onchange = mudou(v => { s.base = cent(v); });
  $("#f-he50").onchange = mudou(v => { s.he50 = cent(v); });
  $("#f-he100").onchange = mudou(v => { s.he100 = cent(v); });
  $("#f-m50").onchange = mudou(v => { s.m50 = Number(v); });
  $("#f-pago").onchange = ev => { s.pagoEm = ev.target.value || null; salvarSlip(fid); renderEditor(); atualizarCC(); };
  const bp = $("#b-pago"); if (bp) bp.onclick = () => { s.pagoEm = today(); salvarSlip(fid); renderEditor(); atualizarCC(); };
  const bb = $("#b-base"); if (bb) bb.onclick = () => { s.base = null; salvarSlip(fid); renderEditor(); atualizarCC(); };
  $$("[data-volta]").forEach(b => b.onclick = () => { s[b.dataset.volta] = null; salvarSlip(fid); renderEditor(); atualizarCC(); });
  $$(".lin [data-k]").forEach(i => i.onchange = ev => {
    const l = s.linhas[+i.dataset.i]; l[i.dataset.k] = i.dataset.k === "valor" ? cent(ev.target.value) : ev.target.value;
    salvarSlip(fid); atualizarCC();
  });
  $$("[data-del]").forEach(b => b.onclick = () => { s.linhas.splice(+b.dataset.del, 1); salvarSlip(fid); renderEditor(); atualizarCC(); });
  $$("[data-add]").forEach(b => b.onclick = () => {
    const [t, d] = b.dataset.add.split("|"); s.linhas.push({ tipo: t, desc: d, valor: 0 });
    salvarSlip(fid); renderEditor(); atualizarCC();
    const ins = $$(`.lin [data-k="${d ? "valor" : "desc"}"]`); const u = ins[ins.length - 1]; if (u) u.focus();
  });
  $("#b-imp").onclick = () => imprimir(reciboHTML(fid));
}

function reciboHTML(fid) {
  if (!fid) return "";
  const e = S.emps[fid] || {}, c = calc(fid), s = c.s, l = limitesQ(S.ref);
  const linhas = [
    ["Salário (quinzena)", "15 dias", c.base, null],
    ...(c.he50 ? [[`Horas extras ${Math.round((s.m50 - 1) * 100)}%`, hrs(c.he50), c.v50, null]] : []),
    ...(c.he100 ? [["Horas extras 100%", hrs(c.he100), c.v100, null]] : []),
    ...s.linhas.filter(x => x.tipo === "p").map(x => [x.desc || "Provento", "", +x.valor || 0, null]),
    ...s.linhas.filter(x => x.tipo === "d").map(x => [x.desc || "Desconto", "", null, +x.valor || 0])
  ];
  return `<article class="recibo" aria-label="Recibo de pagamento">
    <header>
      <div><div class="marca"><img src="/assets/cubo.png" alt=""><img class="nome" src="/assets/wordmark.png" alt="GoBox"></div><small class="muted" style="font-size:8.5px;letter-spacing:.12em;font-weight:600">CENTRO DE DISTRIBUIÇÃO • PONTO DE COLETA</small></div>
      <div class="doc"><b>Recibo de pagamento</b>${rotuloQ(S.ref)}<br>Período ${br(l.ini)} a ${br(l.fim)}</div>
    </header>
    <div class="quem">
      <div><span>Funcionário</span>${esc(e.nome || "")}</div>
      <div><span>Função</span>${esc(e.cargo || "—")}</div>
      <div><span>Salário mensal</span>${brl(c.sal.salario)}</div>
      <div><span>Pago em</span>${br(s.pagoEm)}</div>
    </div>
    <table><thead><tr><th>Descrição</th><th class="r">Ref.</th><th class="r">Proventos</th><th class="r">Descontos</th></tr></thead>
    <tbody>${linhas.map(r => `<tr><td>${esc(r[0])}</td><td class="r">${r[1]}</td><td class="r">${r[2] != null ? brl(r[2]) : ""}</td><td class="r">${r[3] != null ? brl(r[3]) : ""}</td></tr>`).join("")}
    <tr class="tot"><td colspan="2">Totais</td><td class="r">${brl(c.bruto)}</td><td class="r">${brl(c.desc)}</td></tr></tbody></table>
    <div class="liquido"><span>Valor líquido a receber</span><b>${brl(c.liq)}</b></div>
    <p class="declaro">Declaro ter recebido da GoBox a importância líquida acima, referente à ${rotuloQ(S.ref)}.</p>
    <div class="assin"><div>GoBox</div><div>${esc(e.nome || "Funcionário")}</div></div>
  </article>`;
}
function imprimir(html) {
  const a = $("#area-impressao"); a.innerHTML = html;
  setTimeout(() => window.print(), 50);
}

/* ======== RELATÓRIOS ======== */
// 1) Folha da quinzena para quem faz os contracheques (dias, horas extras, faltas, valores).
// 2) Escala dos sábados (rodízio do Ponto: um de manhã, um à tarde, os outros de folga).
const DSEM = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const diaBr = d => `${d.slice(8)}/${d.slice(5, 7)} ${DSEM[keyToDate(d).getDay()]}`;
const hm = horasTxt;
let relSabados = 8;

function folhaLinhas() {
  return empsDaQuinzena().map(e => {
    const c = calc(e.id), p = S.ponto[e.id] || {};
    return { e, c, p };
  });
}
function relatorioFolhaHTML(paraImprimir) {
  const l = limitesQ(S.ref), linhas = folhaLinhas();
  const tot = linhas.reduce((a, x) => a + x.c.liq, 0);
  const resumo = `<table class="rel-tab"><thead><tr><th>Funcionário</th><th class="r">Dias</th><th class="r">Faltas</th><th class="r">Extras 50%</th><th class="r">Extras 100%</th><th class="r">Horas devidas</th><th class="r">Base</th><th class="r">Extras (R$)</th><th class="r">Outros</th><th class="r">Líquido</th></tr></thead><tbody>
    ${linhas.map(({ e, c, p }) => `<tr><td><b>${esc(e.nome || "")}</b><br><small class="muted">${esc(e.cargo || "")}</small></td>
      <td class="r">${p.dias ?? "—"}</td><td class="r">${p.faltas ?? "—"}</td><td class="r">${hrs(c.he50)}</td><td class="r">${hrs(c.he100)}</td>
      <td class="r">${p.deb ? hm(p.deb) : "—"}</td><td class="r">${brl(c.base)}</td><td class="r">${brl(c.v50 + c.v100)}</td>
      <td class="r">${c.prov || c.desc ? `${c.prov ? "+" + brl(c.prov) : ""}${c.desc ? " −" + brl(c.desc) : ""}` : "—"}</td><td class="r"><b>${brl(c.liq)}</b></td></tr>`).join("")}
    <tr class="tot"><td colspan="9">Total da folha</td><td class="r">${brl(tot)}</td></tr></tbody></table>`;
  const detalhes = linhas.filter(x => (x.p.detalhe || []).length).map(({ e, p }) => `<section class="rel-pessoa"><h3>${esc(e.nome || "")}</h3>
    <table class="rel-tab"><thead><tr><th>Dia</th><th class="r">Previsto</th><th class="r">Trabalhado</th><th class="r">Extra 50%</th><th class="r">Extra 100%</th><th class="r">Devendo</th><th>Obs.</th></tr></thead><tbody>
    ${p.detalhe.map(d => `<tr${d.falta ? ' class="falta"' : ""}><td>${diaBr(d.dia)}</td><td class="r">${d.prev ? hm(d.prev) : "folga"}</td><td class="r">${d.falta ? "—" : hm(d.min)}</td>
      <td class="r">${d.ex50 ? hm(d.ex50) : ""}</td><td class="r">${d.ex100 ? hm(d.ex100) : ""}</td><td class="r">${d.deb ? hm(d.deb) : ""}</td>
      <td>${d.falta ? "Falta" : d.aberto ? "Em andamento" : d.tipo === "feriado" ? "Feriado" : !d.prev ? "Dia de folga" : ""}</td></tr>`).join("")}</tbody></table></section>`).join("");
  return `<article class="relatorio${paraImprimir ? " impresso" : ""}">
    <header class="rel-cab"><div><b>GoBox · Folha da quinzena</b><br><span class="muted">${rotuloQ(S.ref)} · ${br(l.ini)} a ${br(l.fim)}</span></div>
    <div class="muted r">Gerado em ${new Date().toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}<br>Horas do Ponto GoBox · tolerância ${tol()} min</div></header>
    ${resumo}
    <p class="muted rel-nota">Extras 50%: o que passou do previsto no dia (e folgas trabalhadas). Extras 100%: domingos e feriados. Horas devidas: atrasos, saídas cedo e faltas.</p>
    ${detalhes}</article>`;
}
function relatorioFolhaTexto() {
  const l = limitesQ(S.ref);
  return [`GoBox · Folha da ${rotuloQ(S.ref)} (${br(l.ini)} a ${br(l.fim)})`, ""].concat(folhaLinhas().map(({ e, c, p }) =>
    `${e.nome}: ${p.dias ?? 0} dias, ${p.faltas ?? 0} falta(s), extras 50% ${hrs(c.he50)}, extras 100% ${hrs(c.he100)}${p.deb ? `, devendo ${hm(p.deb)}` : ""} · base ${brl(c.base)} · líquido ${brl(c.liq)}`)).join("\n");
}

function proximosSabados(n) {
  const d = keyToDate(today()); d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7));
  const out = []; for (let i = 0; i < n; i++) { out.push(dayKey(d)); d.setDate(d.getDate() + 7); }
  return out;
}
function escalaSabados(n) {
  const emps = Object.values(S.emps).filter(e => e.ativo !== false).sort((a, b) => (a.nome || "").localeCompare(b.nome || "", "pt-BR"));
  return proximosSabados(n).map(dia => {
    const t = { manha: [], tarde: [], trabalho: [], folga: [] };
    for (const e of emps) {
      const p = P.previsto(e, dia, S.escalas);
      if (p.turno === "manha" || p.turno === "tarde") t[p.turno].push(e.nome);
      else if (p.min) t.trabalho.push(e.nome);
      else t.folga.push(p.tipo === "feriado" ? `${e.nome} (feriado)` : e.nome);
    }
    return { dia, ...t };
  });
}
function escalaHTML(lista) {
  return `<article class="relatorio"><header class="rel-cab"><div><b>GoBox · Escala dos sábados</b><br><span class="muted">${br(lista[0].dia)} a ${br(lista[lista.length - 1].dia)}</span></div>
    <div class="muted r">Manhã e tarde pelo rodízio do Ponto GoBox</div></header>
    <table class="rel-tab"><thead><tr><th>Sábado</th><th>Manhã</th><th>Tarde</th><th>Folga</th></tr></thead><tbody>
    ${lista.map(s => `<tr><td><b>${br(s.dia)}</b></td><td>${esc([...s.manha, ...s.trabalho].join(", ") || "—")}</td><td>${esc(s.tarde.join(", ") || "—")}</td><td class="muted">${esc(s.folga.join(", ") || "—")}</td></tr>`).join("")}
    </tbody></table></article>`;
}
function escalaTexto(lista) {
  return ["*Escala dos sábados · GoBox*", ""].concat(lista.map(s => `${br(s.dia).slice(0, 5)}: manhã ${[...s.manha, ...s.trabalho].join(", ") || "—"} · tarde ${s.tarde.join(", ") || "—"} · folga ${s.folga.join(", ") || "—"}`)).join("\n");
}
async function copiar(txt) {
  try { await navigator.clipboard.writeText(txt); toast("Copiado. É só colar no WhatsApp."); }
  catch { toast("Não consegui copiar. Selecione o texto e copie.", true); }
}

async function renderRel() {
  const v = $("#vista");
  let aviso = "";
  if (S.pontoEstado === "carregando") aviso = `<div class="aviso">Lendo as horas no Ponto GoBox…</div>`;
  else if (S.pontoEstado === "erro") aviso = `<div class="aviso erro">${esc(S.pontoErro)}</div>`;
  v.innerHTML = `${aviso}
    <div class="bloco rel-bloco">
      <div class="rel-topo"><div><h2>Folha da quinzena</h2><p class="muted">Para quem faz os contracheques: dias, horas extras, faltas e valores de cada funcionário.</p></div>
        <div class="rel-acoes"><div class="navq"><button class="btn sm" data-q="-1" aria-label="Quinzena anterior">‹</button><strong>${rotuloQ(S.ref)}</strong><button class="btn sm" data-q="1" aria-label="Próxima quinzena">›</button></div>
        <button class="btn" id="rel-copiar">Copiar resumo</button><button class="btn primary" id="rel-imprimir">Imprimir ou salvar PDF</button></div></div>
      <div class="rel-previa">${Object.keys(S.emps).length ? relatorioFolhaHTML(false) : `<p class="muted">Carregando funcionários…</p>`}</div>
    </div>
    <div class="bloco rel-bloco">
      <div class="rel-topo"><div><h2>Escala dos sábados</h2><p class="muted">Quem trabalha de manhã, quem trabalha à tarde e quem folga, pelo rodízio do Controle de ponto. Trocas feitas na escala do mês já aparecem aqui.</p></div>
        <div class="rel-acoes"><label class="muted">Próximos <select id="rel-n">${[4, 8, 12, 26].map(n => `<option value="${n}"${n === relSabados ? " selected" : ""}>${n} sábados</option>`).join("")}</select></label>
        <button class="btn" id="esc-copiar">Copiar para o WhatsApp</button><button class="btn primary" id="esc-imprimir">Imprimir ou salvar PDF</button></div></div>
      <div class="rel-previa" id="esc-previa"><p class="muted">Montando a escala…</p></div>
    </div>`;
  $$("[data-q]").forEach(b => b.onclick = async () => { mudarQuinzena(Number(b.dataset.q)); await trocarQuinzena(); });
  $("#rel-imprimir").onclick = () => imprimir(relatorioFolhaHTML(true));
  $("#rel-copiar").onclick = () => copiar(relatorioFolhaTexto());
  $("#rel-n").onchange = (ev) => { relSabados = Number(ev.target.value); montarEscala(); };
  await montarEscala();
}
async function montarEscala() {
  const box = $("#esc-previa"); if (!box) return;
  try {
    if (!Object.keys(S.emps).length) await conectarPonto();
    const sab = proximosSabados(relSabados);
    await carregarMeses(sab[0], sab[sab.length - 1]);
    const rod = S.cfg.rodizio;
    const lista = escalaSabados(relSabados);
    box.innerHTML = (!rod || !rod.ativo ? `<div class="aviso">O rodízio de sábado está desligado no Controle de ponto (aba Escala › Rodízio de sábado). Abaixo, quem está escalado pela jornada de cada um.</div>` : "") + escalaHTML(lista);
    $("#esc-imprimir").onclick = () => imprimir(escalaHTML(lista));
    $("#esc-copiar").onclick = () => copiar(escalaTexto(lista));
  } catch (e) {
    box.innerHTML = `<div class="aviso erro">Não consegui montar a escala agora. Confira a internet e abra a aba de novo.</div>`;
  }
}

/* ======== NOTAS FISCAIS ======== */
const CONF = { alta: ["Confiança alta", "p-ok"], media: ["Confiança média", "p-alerta"], baixa: ["Confiança baixa", "p-erro"], regra: ["Pela regra da empresa", "p-info"] };
const SIT = { a_emitir: ["Emitir", "p-erro"], aguardando: ["Aguardando pagamento", "p-info"], pode_cair: ["Pode cair a qualquer dia", "p-alerta"], atrasada: ["Passou do previsto", "p-erro"], paga: ["Paga", "p-ok"] };
let histAberto = false;

function renderNF() {
  const v = $("#vista"), d = S.dados;
  if (!d) { v.innerHTML = `<div class="vazio">Carregando…</div>`; return; }
  const abertas = d.notas.filter(n => !n.pagamento).sort((a, b) => (a.emissao || "9").localeCompare(b.emissao || "9"));
  const pagas = d.notas.filter(n => n.pagamento).sort((a, b) => b.pagamento.localeCompare(a.pagamento));
  const pend = d.empresas.flatMap(e => e.pendentes.map(p => ({ ...p, empresa: e.id, empresaNome: e.nome })));
  const prox = d.empresas.filter(e => e.proxima).map(e => ({ ...e.proxima, empresa: e.id }));
  const aReceber = abertas.filter(n => n.emissao).reduce((a, n) => a + n.valor, 0);
  v.innerHTML = `
    <p class="muted" style="margin:0 0 14px;max-width:760px">O dia do pagamento é previsto pelo histórico de cada empresa: testo três padrões (dias corridos depois da nota, dias úteis e dia fixo do mês) e uso o mais regular, com mais peso para os pagamentos recentes. Enquanto houver menos de 3 pagamentos registrados, vale o prazo da regra da empresa. Cada pagamento que você registra refaz a conta.</p>
    <div class="cartoes">${d.empresas.map(cartaoEmpresa).join("")}</div>

    ${pend.length ? `<div class="secao"><h2>Para emitir</h2><p>Períodos que já fecharam e ainda não têm nota. O valor vem do Financeiro e pode ser alterado.</p>
    <div class="tabela"><table><thead><tr><th>Empresa</th><th>Período</th><th class="num">Valor</th><th class="num">Qtd.</th><th>Nº da nota</th><th>Emissão</th><th>Pagamento previsto</th><th></th></tr></thead><tbody>
    ${pend.map((p, i) => `<tr>
      <td class="nowrap"><span class="bola ${p.empresa}"></span>${esc(p.empresaNome)}</td><td>${esc(p.rotulo)}</td>
      <td><input type="number" step="0.01" min="0" id="pv-${i}" value="${p.valor ?? ""}" aria-label="Valor"></td>
      <td><input type="number" min="0" id="pq-${i}" value="${p.quantidade ?? ""}" aria-label="Quantidade" style="width:90px"></td>
      <td><input type="text" id="pn-${i}" aria-label="Número da nota" placeholder="—"></td>
      <td><input type="date" id="pe-${i}" aria-label="Data de emissão" max="${S.hoje}"></td>
      <td class="prev">${p.seEmitirHoje ? `<b>${brw(p.seEmitirHoje.data)}</b><small>se emitir hoje · entre ${br(p.seEmitirHoje.cedo)} e ${br(p.seEmitirHoje.tarde)}</small>` : `<small>Sem histórico nem regra</small>`}</td>
      <td class="nowrap"><button class="btn sm" data-registrar="${i}" title="Para uma nota que você já emitiu">Já emiti</button> <button class="btn sm primario" data-preparar="${i}">Preparar nota</button></td></tr>`).join("")}
    </tbody></table></div></div>` : ""}

    <div class="secao"><h2>Em aberto${aReceber ? ` · ${brl(aReceber)} a receber` : ""}</h2>
    ${abertas.length ? `<div class="tabela"><table><thead><tr><th>Empresa</th><th>Período</th><th>Nº da nota</th><th class="num">Valor</th><th>Emissão</th><th>Pagamento previsto</th><th>Situação</th><th></th></tr></thead><tbody>
    ${abertas.map(n => { const [st, cl] = SIT[n.situacao]; return `<tr>
      <td class="nowrap"><span class="bola ${n.empresa}"></span>${NOME[n.empresa]}</td><td class="nowrap">${esc(n.rotulo)}</td>
      <td><input type="text" data-n="${n.id}" data-k="numero" value="${esc(n.numero)}" aria-label="Número da nota" placeholder="—"></td>
      <td><input type="number" step="0.01" min="0" data-n="${n.id}" data-k="valor" value="${n.valor}" aria-label="Valor"></td>
      <td><input type="date" data-n="${n.id}" data-k="emissao" value="${n.emissao || ""}" aria-label="Data de emissão"></td>
      <td class="prev nowrap">${n.previsao ? `<b>${brw(n.previsao.data)}</b><small>entre ${br(n.previsao.cedo)} e ${br(n.previsao.tarde)}</small>` : n.emissao ? `<small>Sem histórico nem regra</small>` : `<small>Depois da emissão</small>`}</td>
      <td><span class="pill ${cl}">${st}</span></td>
      <td class="nowrap"><button class="btn sm" data-doc="${n.id}">Documento${n.documento ? " ✓" : ""}</button>
        ${n.emissao ? `<button class="btn sm" data-recebi="${n.id}">Recebi hoje</button>` : `<button class="btn sm primario" data-emiti="${n.id}">Emiti hoje</button>`}
        <button class="btn sm fantasma" data-apagar="${n.id}" aria-label="Excluir nota">✕</button></td></tr>`; }).join("")}
    </tbody></table></div>` : `<div class="bloco vazio">Nenhuma nota em aberto.</div>`}</div>

    ${prox.length ? `<div class="secao"><h2>Períodos em andamento</h2><div class="tabela"><table><thead><tr><th>Empresa</th><th>Período</th><th class="num">Até agora</th><th>Emitir a partir de</th><th>Pagamento previsto</th></tr></thead><tbody>
    ${prox.map(p => `<tr><td class="nowrap"><span class="bola ${p.empresa}"></span>${NOME[p.empresa]}</td><td>${esc(p.rotulo)}</td><td class="num">${p.valor != null ? brl(p.valor) : "—"}</td><td>${br(p.liberadaEm)}</td>
      <td class="prev">${p.seEmitirNoDia ? `<b>${brw(p.seEmitirNoDia.data)}</b><small>se emitir em ${br(p.liberadaEm)}</small>` : "—"}</td></tr>`).join("")}
    </tbody></table></div></div>` : ""}

    <details class="bloco secao" id="hist" ${histAberto ? "open" : ""}><summary>Histórico de pagamentos (${pagas.length})</summary>
      ${pagas.length ? `<div class="tabela"><table><thead><tr><th>Empresa</th><th>Período</th><th class="num">Valor</th><th>Emissão</th><th>Pagamento</th><th class="num">Prazo</th><th></th></tr></thead><tbody>
      ${pagas.map(n => `<tr><td class="nowrap"><span class="bola ${n.empresa}"></span>${NOME[n.empresa]}</td><td>${esc(n.rotulo)}</td><td class="num">${brl(n.valor)}</td>
        <td><input type="date" data-n="${n.id}" data-k="emissao" value="${n.emissao}" aria-label="Emissão"></td>
        <td><input type="date" data-n="${n.id}" data-k="pagamento" value="${n.pagamento}" aria-label="Pagamento"></td>
        <td class="num">${n.prazo} dias</td><td class="nowrap"><button class="btn sm" data-doc="${n.id}">Documento${n.documento ? " ✓" : ""}</button> <button class="btn sm fantasma" data-apagar="${n.id}" aria-label="Excluir">✕</button></td></tr>`).join("")}
      </tbody></table></div>` : `<p class="muted">Ainda não há pagamentos registrados. Cadastre abaixo as notas dos últimos meses para a previsão aprender o ritmo de cada empresa.</p>`}
      <form id="f-antiga" class="linha" style="margin-top:14px">
        <label class="campo">Empresa<select id="a-emp">${d.empresas.map(e => `<option value="${e.id}">${e.nome}</option>`).join("")}</select></label>
        <label class="campo">Mês<input id="a-mes" type="month" required value="${S.hoje.slice(0, 7)}"></label>
        <label class="campo" id="a-q-wrap" hidden>Quinzena<select id="a-q"><option value="1">1ª</option><option value="2">2ª</option></select></label>
        <label class="campo">Valor<input id="a-val" type="number" step="0.01" min="0" required style="width:120px"></label>
        <label class="campo">Emissão<input id="a-emi" type="date" required></label>
        <label class="campo">Pagamento<input id="a-pag" type="date"></label>
        <button class="btn primario" type="submit">Adicionar nota</button>
      </form>
    </details>
    <dialog id="dlg" class="dlg"></dialog>`;

  // ações
  $$("[data-modelo]").forEach(b => b.onclick = () => abrirModelo(b.dataset.modelo));
  $$("[data-preparar]").forEach(b => b.onclick = () => acao(async () => {
    const i = +b.dataset.preparar, p = pend[i];
    const { nota } = await api("/contabilidade/notas", { method: "POST", body: { empresa: p.empresa, ref: p.ref, valor: Number($(`#pv-${i}`).value) || 0, quantidade: $(`#pq-${i}`).value } });
    await recarregarNotas(); abrirDocumento(nota.id);
  }));
  $$("[data-registrar]").forEach(b => b.onclick = () => acao(async () => {
    const i = +b.dataset.registrar, p = pend[i], emissao = $(`#pe-${i}`).value;
    if (!emissao) { $(`#pe-${i}`).focus(); throw new Error("Informe a data de emissão da nota."); }
    await api("/contabilidade/notas", { method: "POST", body: { empresa: p.empresa, ref: p.ref, valor: Number($(`#pv-${i}`).value) || 0, quantidade: $(`#pq-${i}`).value, numero: $(`#pn-${i}`).value, emissao } });
    await recarregarNotas();
    const n = S.dados.notas.find(x => x.empresa === p.empresa && x.ref === p.ref);
    toast(n && n.previsao ? `Nota registrada. Pagamento previsto: ${brw(n.previsao.data)}` : "Nota registrada");
  }));
  $$("[data-n]").forEach(i => i.onchange = () => acao(async () => {
    const k = i.dataset.k, val = k === "valor" ? Number(i.value) || 0 : (i.value || null);
    await api(`/contabilidade/notas/${i.dataset.n}`, { method: "PUT", body: { [k]: k === "numero" ? (i.value || "") : val } });
    await recarregarNotas();
  }));
  $$("[data-emiti]").forEach(b => b.onclick = () => acao(async () => {
    await api(`/contabilidade/notas/${b.dataset.emiti}`, { method: "PUT", body: { emissao: today() } });
    await recarregarNotas();
    const n = S.dados.notas.find(x => x.id === b.dataset.emiti);
    toast(n && n.previsao ? `Emissão registrada. Pagamento previsto: ${brw(n.previsao.data)}` : "Emissão registrada");
  }));
  $$("[data-recebi]").forEach(b => b.onclick = () => acao(async () => {
    await api(`/contabilidade/notas/${b.dataset.recebi}`, { method: "PUT", body: { pagamento: today() } });
    await recarregarNotas(); toast("Pagamento registrado. A previsão foi recalculada.");
  }));
  $$("[data-apagar]").forEach(b => b.onclick = () => {
    if (!b.dataset.armado) { b.dataset.armado = 1; b.textContent = "Excluir?"; b.classList.remove("fantasma"); b.style.color = "var(--bad)"; return; }
    acao(async () => { await api(`/contabilidade/notas/${b.dataset.apagar}`, { method: "DELETE" }); await recarregarNotas(); toast("Nota excluída"); });
  });
  $$("[data-doc]").forEach(b => b.onclick = () => abrirDocumento(b.dataset.doc));
  $("#hist").ontoggle = ev => { histAberto = ev.target.open; };
  const ae = $("#a-emp"), aq = $("#a-q-wrap");
  ae.onchange = () => { aq.hidden = ae.value !== "ml"; };
  $("#f-antiga").onsubmit = ev => { ev.preventDefault(); acao(async () => {
    const emp = ae.value, mes = $("#a-mes").value, ref = emp === "ml" ? `${mes}-Q${$("#a-q").value}` : mes;
    await api("/contabilidade/notas", { method: "POST", body: { empresa: emp, ref, valor: Number($("#a-val").value) || 0, emissao: $("#a-emi").value, pagamento: $("#a-pag").value || null } });
    histAberto = true; await recarregarNotas(); toast("Nota adicionada");
  }); };
}
async function acao(fn) { try { await fn(); } catch (e) { toast(e.message, true); } }
async function recarregarNotas() { await carregarDados(); if (S.aba === "nf") renderNF(); }

function cartaoEmpresa(e) {
  const m = e.modelo, a = e.acerto;
  const emAberto = (S.dados.notas || []).filter(n => n.empresa === e.id && n.emissao && !n.pagamento && n.previsao).sort((x, y) => x.previsao.data.localeCompare(y.previsao.data))[0];
  const conf = m ? CONF[m.confianca] : null;
  const faltam = ["tomadorNome", "tomadorCnpj", "codigoServico", "descricao"].filter(k => !e.emissao[k]).length;
  return `<div class="cartao">
    <div class="h"><span><span class="bola ${e.id}"></span>${e.nome}</span><span class="pill p-info">${e.ciclo}</span></div>
    ${m ? `<span class="s">${m.pelaRegra ? "Regra da empresa" : "Padrão encontrado"}: paga <b>${esc(m.texto)}</b></span>
      ${m.valores.length ? `<span class="s">Últimos ${m.valores.length}: ${m.valores.join(" · ")} (${esc(m.unidade)})</span>` : ""}
      <div class="linha" style="gap:6px;align-items:center"><span class="pill ${conf[1]}">${conf[0]}</span>${a ? `<span class="s">Testado no histórico: erra em média ${String(a.erroMedio).replace(".", ",")} dia(s)</span>` : ""}</div>`
      : `<span class="s">Sem histórico nem regra. Registre os pagamentos ou informe o prazo no modelo de emissão.</span>`}
    <span class="s">${emAberto ? `Próximo pagamento: <b>${brw(emAberto.previsao.data)}</b> (entre ${br(emAberto.previsao.cedo)} e ${br(emAberto.previsao.tarde)})` : "Nenhuma nota aguardando pagamento"}</span>
    <div class="linha" style="margin-top:4px;align-items:center"><button class="btn sm" data-modelo="${e.id}">Modelo de emissão</button>${faltam ? `<span class="s">${faltam} dado(s) a preencher</span>` : ""}</div>
  </div>`;
}

/* ---------- modelo de emissão (como cada empresa quer a nota) ---------- */
const CAMPOS = [
  ["tipo", "Tipo de nota"], ["tomadorNome", "Tomador (razão social)"], ["tomadorCnpj", "CNPJ do tomador"],
  ["tomadorEndereco", "Endereço do tomador"], ["tomadorEmail", "E-mail para envio"], ["codigoServico", "Código de serviço"],
  ["cnae", "CNAE"], ["janela", "Quando emitir"], ["envio", "Onde enviar a nota"]
];
function abrirModelo(emp) {
  const e = S.dados.empresas.find(x => x.id === emp), m = e.emissao, dlg = $("#dlg");
  dlg.innerHTML = `<form method="dialog" class="dlg-corpo" id="f-modelo">
    <div class="bloco-h"><h2>Modelo de emissão · ${e.nome}</h2><button class="btn sm fantasma" value="x" aria-label="Fechar">✕</button></div>
    ${m.fonte ? `<p class="aviso">${esc(m.fonte)}</p>` : ""}
    <div class="campos">${CAMPOS.map(([k, r]) => `<label class="campo">${r}<input type="text" name="${k}" value="${esc(m[k] || "")}" maxlength="200"></label>`).join("")}</div>
    <label class="campo" style="margin-top:12px">Descrição do serviço (do jeito que vai na nota, com hashtags)<textarea name="descricao" rows="3" maxlength="1500">${esc(m.descricao || "")}</textarea></label>
    <label class="campo" style="margin-top:12px">Observações (se a empresa pedir algo além da descrição)<textarea name="observacoes" rows="3" maxlength="1500" placeholder="Deixe vazio se a descrição já basta">${esc(m.observacoes || "")}</textarea>
      <span class="dica">No texto, use {periodo}, {inicio}, {fim}, {valor}, {quantidade} e {empresa}: entram os dados de cada nota.</span></label>
    <div class="campos" style="margin-top:12px">
      <label class="campo">Prazo de pagamento informado pela empresa<select name="regraTipo">
        <option value="" ${!m.regra.tipo ? "selected" : ""}>Não informado</option>
        <option value="corridos" ${m.regra.tipo === "corridos" ? "selected" : ""}>Dias corridos após a nota</option>
        <option value="uteis" ${m.regra.tipo === "uteis" ? "selected" : ""}>Dias úteis após a nota</option>
        ${e.ciclo === "mensal" ? `<option value="diaDoMes" ${m.regra.tipo === "diaDoMes" ? "selected" : ""}>Dia fixo do mês</option>` : ""}
      </select><span class="dica">Usado até haver 3 pagamentos registrados</span></label>
      <label class="campo">Dias / dia do mês<input type="number" name="regraValor" min="1" max="120" value="${m.regra.valor || ""}"></label>
    </div>
    <label class="campo" style="margin-top:12px">Lista de conferência (um item por linha)<textarea name="checklist" rows="4" maxlength="1500">${esc((m.checklist || []).join("\n"))}</textarea></label>
    <label class="campo" style="margin-top:12px">Anotações sobre as regras da empresa<textarea name="fonte" rows="2" maxlength="1500">${esc(m.fonte || "")}</textarea></label>
    <div class="linha" style="justify-content:flex-end;margin-top:16px"><button class="btn" value="x">Cancelar</button><button class="btn primario" type="button" id="b-salvar-modelo">Salvar modelo</button></div>
  </form>`;
  dlg.showModal();
  $("#b-salvar-modelo").onclick = () => acao(async () => {
    const f = new FormData($("#f-modelo")), body = {};
    for (const [k] of CAMPOS) body[k] = f.get(k) || "";
    body.descricao = f.get("descricao") || ""; body.observacoes = f.get("observacoes") || ""; body.fonte = f.get("fonte") || "";
    body.regra = { tipo: f.get("regraTipo") || "", valor: Number(f.get("regraValor")) || 0 };
    body.checklist = String(f.get("checklist") || "").split("\n").map(x => x.trim()).filter(Boolean);
    await api(`/contabilidade/modelos/${emp}`, { method: "PUT", body });
    dlg.close(); await recarregarNotas(); toast("Modelo salvo");
  });
}

/* ---------- documento de emissão de uma nota ---------- */
function preencher(txt, n) {
  return String(txt || "").replace(/\{(periodo|inicio|fim|valor|quantidade|empresa)\}/g, (_, k) => ({
    periodo: n.rotulo, inicio: br(n.inicio), fim: br(n.fim), valor: brl(n.valor),
    quantidade: n.quantidade != null ? Number(n.quantidade).toLocaleString("pt-BR") : "—", empresa: NOME[n.empresa]
  })[k]);
}
function camposDoModelo(n) {
  const m = S.dados.empresas.find(e => e.id === n.empresa).emissao;
  return [
    ["Tipo de nota", m.tipo], ["Tomador (razão social)", m.tomadorNome], ["CNPJ do tomador", m.tomadorCnpj],
    ["Endereço do tomador", m.tomadorEndereco], ["Período de referência", `${n.rotulo} (${br(n.inicio)} a ${br(n.fim)})`],
    ["Valor do serviço", brl(n.valor)], ["Quantidade", n.quantidade != null ? Number(n.quantidade).toLocaleString("pt-BR") : ""],
    ["Código de serviço", m.codigoServico], ...(m.cnae ? [["CNAE", m.cnae]] : []),
    ["Descrição do serviço", preencher(m.descricao, n)], ...(m.observacoes ? [["Observações", preencher(m.observacoes, n)]] : []),
    ["Quando emitir", m.janela], ["Onde enviar", [m.envio, m.tomadorEmail].filter(Boolean).join(" · ")]
  ].map(([rotulo, valor]) => ({ rotulo, valor: valor || "" }));
}
function abrirDocumento(id, usarModelo = false) {
  const n = S.dados.notas.find(x => x.id === id); if (!n) return;
  const m = S.dados.empresas.find(e => e.id === n.empresa).emissao;
  const salvo = n.documento && !usarModelo;
  const campos = salvo ? n.documento.campos : camposDoModelo(n);
  const check = salvo && n.documento.checklist.length ? n.documento.checklist : (m.checklist || []).map(t => ({ texto: t, feito: false }));
  const dlg = $("#dlg");
  dlg.innerHTML = `<div class="dlg-corpo">
    <div class="bloco-h"><h2>Documento de emissão</h2><div class="linha"><span class="salvo">${salvo ? `Salvo em ${new Date(n.documento.salvoEm).toLocaleString("pt-BR")}` : "Ainda não salvo"}</span><button class="btn sm fantasma" id="d-fechar" aria-label="Fechar">✕</button></div></div>
    <div class="documento" id="documento">
      <header><div class="marca"><img src="/assets/cubo.png" alt=""><img class="nome" src="/assets/wordmark.png" alt="GoBox"></div>
        <div class="doc"><b>Nota fiscal · ${NOME[n.empresa]}</b>${esc(n.rotulo)}${n.numero ? ` · NF ${esc(n.numero)}` : ""}</div></header>
      <dl>${campos.map((c, i) => `<div class="dl-l"><dt>${esc(c.rotulo)}</dt><dd>${c.valor ? `<span id="dc-${i}">${esc(c.valor)}</span>` : `<span class="falta">preencher no modelo</span>`}</dd>
        <dd class="copiar">${c.valor ? `<button class="btn sm" data-copiar="${i}">Copiar</button>` : ""}</dd></div>`).join("")}</dl>
      ${n.previsao ? `<p class="muted" style="margin:12px 0 0">Pagamento previsto: <b>${brw(n.previsao.data)}</b>, entre ${br(n.previsao.cedo)} e ${br(n.previsao.tarde)}.</p>` : ""}
      ${check.length ? `<h3 style="font-size:14px;margin:16px 0 8px">Conferência</h3><ul class="check">${check.map((c, i) => `<li><label><input type="checkbox" data-ck="${i}" ${c.feito ? "checked" : ""}> ${esc(c.texto)}</label></li>`).join("")}</ul>` : ""}
    </div>
    <div class="linha" style="justify-content:space-between;margin-top:16px">
      <div class="linha"><button class="btn sm" id="d-modelo">Editar modelo da ${NOME[n.empresa]}</button>${salvo ? `<button class="btn sm" id="d-atualizar">Refazer com o modelo atual</button>` : ""}</div>
      <div class="linha"><button class="btn" id="d-imprimir">Imprimir ou salvar PDF</button><button class="btn primario" id="d-salvar">Salvar documento</button></div>
    </div></div>`;
  if (!dlg.open) dlg.showModal();
  $("#d-fechar").onclick = () => dlg.close();
  $$("[data-copiar]").forEach(b => b.onclick = async () => {
    const t = campos[+b.dataset.copiar].valor;
    try { await navigator.clipboard.writeText(t); b.textContent = "Copiado"; setTimeout(() => b.textContent = "Copiar", 1500); }
    catch { const r = document.createRange(); r.selectNodeContents($(`#dc-${b.dataset.copiar}`)); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  });
  const marcados = () => check.map((c, i) => ({ texto: c.texto, feito: Boolean($(`[data-ck="${i}"]`) && $(`[data-ck="${i}"]`).checked) }));
  $("#d-salvar").onclick = () => acao(async () => {
    await api(`/contabilidade/notas/${n.id}`, { method: "PUT", body: { documento: { campos, checklist: marcados() } } });
    await recarregarNotas(); abrirDocumento(n.id); toast("Documento salvo com a nota");
  });
  $("#d-imprimir").onclick = () => { dlg.close(); imprimir($("#documento").outerHTML); };
  $("#d-modelo").onclick = () => abrirModelo(n.empresa);
  const da = $("#d-atualizar"); if (da) da.onclick = () => abrirDocumento(n.id, true);
}

/* ---------------- início ---------------- */
(async () => {
  try { await carregarDados(); }
  catch (e) { raiz.innerHTML = `<div class="aviso erro">${esc(e.message)}</div>`; return; }
  render();
  await carregarPonto();
  if (S.aba === "cc") renderCC();
})();
