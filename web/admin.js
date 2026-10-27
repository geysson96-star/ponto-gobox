// Ponto GoBox — painel do administrador (computador).
import {
  configured, auth, db, onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail, createLogin,
  doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot, query, where, writeBatch, batchDay, deleteField,
  $, esc, pad, dayKey, today, keyToDate, hm, dur, hmm, saldoTxt, fmtDay, longDate, DOWC, DOWL, MES,
  LABEL, SHORT, STATUS, DIAS_PADRAO, derive, isOpen, isStale, minHoje, empStatus, extrasDia, errMsg, toast, notConfigured,
  PADRAO_SEMANA, semanaDe, previsto, mesDe, horasTxt
} from "./common.js";

const root = $("#root");
const S = { me: null, emps: {}, cfg: {}, users: {}, tab: "agora", unsub: [], rep: { data: null, open: {}, seq: 0 }, escalas: {}, escSubs: {}, escMes: null };
/* Mantém a escala de um mês sincronizada (escala/AAAA-MM) */
function watchMes(mes) {
  if (S.escSubs[mes]) return;
  S.escSubs[mes] = onSnapshot(doc(db, "escala", mes), s => { S.escalas[mes] = s.exists() ? s.data() : {}; refresh(); }, () => {});
}
async function loadMeses(de, ate) {
  const meses = []; let d = keyToDate(de.slice(0, 7) + "-01");
  while (dayKey(d).slice(0, 7) <= ate.slice(0, 7)) { meses.push(dayKey(d).slice(0, 7)); d = new Date(d.getFullYear(), d.getMonth() + 1, 1); }
  await Promise.all(meses.filter(m => !(m in S.escalas)).map(async m => { const s = await getDoc(doc(db, "escala", m)); S.escalas[m] = s.exists() ? s.data() : {}; }));
}
const DIAS_SEMANA = [1, 2, 3, 4, 5, 6, 0];
function semanaTxt(e) {
  const w = semanaDe(e), grupos = [];
  for (const i of DIAS_SEMANA) { const g = grupos[grupos.length - 1]; if (g && g.min === w[i]) g.fim = i; else grupos.push({ ini: i, fim: i, min: w[i] }); }
  return grupos.filter(g => g.min).map(g => (g.ini === g.fim ? DOWC[g.ini] : DOWC[g.ini] + "–" + DOWC[g.fim]) + " " + horasTxt(g.min)).join(" · ") || "Sem jornada";
}
const tol = () => Number.isFinite(S.cfg.tolerancia) ? S.cfg.tolerancia : 10;
const empsSorted = (all = false) => Object.values(S.emps).filter(e => all || e.ativo !== false).sort((a, b) => (a.nome || "").localeCompare(b.nome || "", "pt-BR"));
const empRef = fid => doc(db, "funcionarios", fid);

/* ================= LOGIN / PRIMEIRO ACESSO ================= */
if (!configured) notConfigured(root);
else onAuthStateChanged(auth, async user => {
  if (S.settingUp) return; // durante o primeiro acesso, quem decide é o formulário
  S.unsub.forEach(u => u()); S.unsub = [];
  Object.values(S.escSubs).forEach(u => u()); S.escSubs = {}; S.escalas = {};
  if (!user) return renderLogin();
  let me = null;
  try { const u = await getDoc(doc(db, "usuarios", user.uid)); me = u.exists() ? u.data() : null; } catch {}
  if (!me || me.role !== "admin") {
    await signOut(auth);
    return renderLogin(me && me.role === "terminal" ? "Esse é o acesso do celular. No computador, entre com uma conta de administrador." : "Esta conta não tem acesso de administrador.");
  }
  S.me = { uid: user.uid, email: user.email, ...me };
  renderShell(); startData();
});

async function renderLogin(msg = "") {
  let precisaSetup = false;
  try { precisaSetup = !(await getDoc(doc(db, "config", "setup"))).exists(); } catch {}
  root.innerHTML = `<div class="login">
    <img src="logo.png" alt="GoBox" style="width:240px;margin:0 auto">
    <div class="k-card">
      <h2 class="k-title">${precisaSetup ? "Criar o administrador" : "Entrar no painel"}</h2>
      ${precisaSetup ? `<p class="muted" style="margin:0">Primeiro acesso. Esta será a conta principal de administrador da GoBox.</p>` : ""}
      <form id="lg" style="display:grid;gap:12px">
        ${precisaSetup ? `<label class="field">Seu nome<input id="lg-nome" required maxlength="60"></label>` : ""}
        <label class="field">E-mail<input id="lg-email" type="email" autocomplete="username" required></label>
        <label class="field">Senha${precisaSetup ? " (mínimo 6 caracteres)" : ""}<input id="lg-senha" type="password" autocomplete="${precisaSetup ? "new-password" : "current-password"}" required></label>
        <div class="form-err" role="alert">${esc(msg)}</div>
        <button class="btn primary" type="submit" style="min-height:48px">${precisaSetup ? "Criar e entrar" : "Entrar"}</button>
      </form>
      ${precisaSetup ? "" : `<button class="linkbtn" id="lg-reset">Esqueci a senha</button>`}
    </div></div>`;
  $("#lg").addEventListener("submit", async ev => {
    ev.preventDefault();
    const btn = $("#lg button[type=submit]"), err = $("#lg .form-err"); btn.disabled = true; err.textContent = "";
    const email = $("#lg-email").value.trim(), senha = $("#lg-senha").value;
    try {
      if (precisaSetup) {
        const nome = $("#lg-nome").value.trim();
        S.settingUp = true;
        const uid = await createLogin(email, senha);
        await signInWithEmailAndPassword(auth, email, senha);
        const b = writeBatch(db);
        b.set(doc(db, "config", "setup"), { admin: uid, criado: Date.now() });
        b.set(doc(db, "usuarios", uid), { role: "admin", email, nome, criado: Date.now() });
        await b.commit();
        location.reload();
      } else await signInWithEmailAndPassword(auth, email, senha);
    } catch (e) { S.settingUp = false; btn.disabled = false; err.textContent = errMsg(e); }
  });
  $("#lg-reset")?.addEventListener("click", async () => {
    const email = $("#lg-email").value.trim();
    if (!email) return $("#lg .form-err").textContent = "Digite seu e-mail acima e clique de novo em Esqueci a senha.";
    try { await sendPasswordResetEmail(auth, email); toast("Enviamos um link para criar uma nova senha no seu e-mail."); }
    catch (e) { $("#lg .form-err").textContent = errMsg(e); }
  });
}

/* ================= PAINEL ================= */
function renderShell() {
  root.innerHTML = `<main class="wrap">
  <header class="a-head">
    <div class="a-brandbox"><img class="a-logo" alt="GoBox" src="logo.png">
      <div class="lbl"><h1>Controle de ponto</h1><div class="sub" id="a-date"></div></div></div>
    <div class="right">
      <span class="a-clock" id="a-time">--:--</span>
      <button class="btn" data-act="cfg">Configurações</button>
      <button class="btn ghost" data-act="sair" title="${esc(S.me.email)}">Sair</button>
    </div>
  </header>
  <nav class="tabs" role="tablist">
    ${[["agora", "Agora"], ["relatorio", "Relatório"], ["escala", "Escala"], ["equipe", "Equipe"], ["acessos", "Acessos"]].map(([k, l]) => `<button role="tab" data-tab="${k}" aria-selected="${S.tab === k}">${l}</button>`).join("")}
  </nav>
  <section id="tab-agora">
    <div class="kpis" id="kpis"></div>
    <div class="cols">
      <div class="panel"><div class="panel-h"><h2>Equipe hoje</h2><span class="muted">Atualiza sozinho</span></div><div class="table-wrap" id="agora-table"></div></div>
      <div class="panel"><div class="panel-h"><h2>Registros de hoje</h2></div><ul class="feed" id="feed"></ul></div>
    </div>
  </section>
  <section id="tab-relatorio" hidden>
    <div class="toolbar">
      <label class="field">De<input type="date" id="r-de"></label>
      <label class="field">Até<input type="date" id="r-ate"></label>
      <label class="field">Funcionário<select id="r-fid"><option value="todos">Todos</option></select></label>
      <button class="btn" data-act="r-mes">Este mês</button>
      <button class="btn" data-act="r-mesant">Mês passado</button>
      <span style="flex:1"></span>
      <button class="btn primary" data-act="r-csv">Baixar planilha (CSV)</button>
    </div>
    <div class="panel"><div class="table-wrap" id="rep-out"></div></div>
  </section>
  <section id="tab-escala" hidden>
    <div class="toolbar">
      <button class="btn" data-act="esc-prev" aria-label="Mês anterior">‹</button>
      <h2 id="esc-mes" style="font-size:20px;min-width:170px;text-align:center;text-transform:capitalize"></h2>
      <button class="btn" data-act="esc-next" aria-label="Próximo mês">›</button>
      <span style="flex:1"></span>
      <span class="esc-leg"><i class="c-aj"></i>Ajustado <i class="c-fe"></i>Feriado <i class="c-fo"></i>Folga</span>
    </div>
    <div class="panel"><div class="table-wrap" id="esc-out"></div></div>
    <p class="muted" style="font-size:13px;margin:10px 2px 0">Clique num dia para mudar as horas de um funcionário. Clique no número do dia no topo para aplicar a todos (por exemplo, um feriado). Os dias sem ajuste seguem a jornada padrão de cada funcionário, definida na aba Equipe.</p>
  </section>
  <section id="tab-equipe" hidden>
    <div class="toolbar"><span class="muted" id="eq-count"></span><span style="flex:1"></span><button class="btn primary" data-act="emp-new">Adicionar funcionário</button></div>
    <div class="cards" id="eq-list"></div>
  </section>
  <section id="tab-acessos" hidden>
    <div class="apk"><img src="icon-192.png" alt="">
      <div class="txt"><b>App do celular (Android)</b><div class="muted">Baixe no celular da agência, instale e entre com um acesso do celular criado abaixo.</div></div>
      <a class="btn primary" href="ponto-gobox.apk" download>Baixar APK</a></div>
    <div class="toolbar"><span class="muted">Quem pode entrar no sistema</span><span style="flex:1"></span>
      <button class="btn" data-act="u-new" data-role="admin">Adicionar administrador</button>
      <button class="btn primary" data-act="u-new" data-role="terminal">Criar acesso do celular</button></div>
    <div class="panel"><div class="table-wrap" id="u-list"></div></div>
    <div class="howto">
      <h3>Como preparar o celular da agência</h3>
      <ol>
        <li>Clique em <b>Criar acesso do celular</b> e defina um e-mail e uma senha só para o celular.</li>
        <li>No celular, abra este painel no navegador, toque em <b>Baixar APK</b> e instale. O Android pode pedir para permitir a instalação desse arquivo.</li>
        <li>Abra o app <b>Ponto GoBox</b> e entre com o acesso do celular. Isso é feito uma vez só.</li>
        <li>Passe a cada funcionário o código dele (aba Equipe). Para desconectar o celular, segure o logo por 3 segundos.</li>
      </ol>
    </div>
  </section>
</main>`;
  ["r-de", "r-ate", "r-fid"].forEach(id => $("#" + id).addEventListener("change", loadRep));
  showTab(); tick();
}
function startData() {
  watchMes(mesDe(today()));
  S.unsub.push(onSnapshot(collection(db, "funcionarios"), snap => {
    const o = {}; snap.forEach(d => { o[d.id] = { id: d.id, ...d.data() }; }); S.emps = o; refresh();
  }, e => toast(errMsg(e), true)));
  S.unsub.push(onSnapshot(doc(db, "config", "geral"), s => { S.cfg = s.exists() ? s.data() : {}; refresh(); }, () => {}));
  S.unsub.push(onSnapshot(collection(db, "usuarios"), snap => {
    const o = {}; snap.forEach(d => { o[d.id] = { id: d.id, ...d.data() }; }); S.users = o; if (S.tab === "acessos") renderAcessos();
  }, () => {}));
}
function showTab() {
  document.querySelectorAll(".tabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === S.tab)));
  ["agora", "relatorio", "escala", "equipe", "acessos"].forEach(t => $("#tab-" + t).hidden = S.tab !== t);
  refresh();
}
function refresh() {
  if (!$("#tab-agora")) return;
  if (S.tab === "agora") renderAgora();
  if (S.tab === "equipe") renderEquipe();
  if (S.tab === "acessos") renderAcessos();
  if (S.tab === "escala") renderEscala();
  if (S.tab === "relatorio") { fillRepSelect(); if (S.rep.data) renderRep(); }
}

function tick() {
  const d = new Date();
  const at = $("#a-time"); if (at) at.textContent = pad(d.getHours()) + ":" + pad(d.getMinutes());
  const ad = $("#a-date"); if (ad) ad.textContent = longDate(d);
  document.querySelectorAll("[data-live]").forEach(el => { const e = S.emps[el.dataset.live]; if (e) el.textContent = dur(minHoje(e)); });
}
setInterval(tick, 1000);
let lastDay = today();
setInterval(() => { if (today() !== lastDay) { lastDay = today(); refresh(); } else if (S.tab === "agora") renderAgora(); }, 30000);

/* ---------- Agora ---------- */
function renderAgora() {
  if (!$("#kpis")) return;
  const list = empsSorted(); const td = today();
  const c = { trabalhando: 0, pausa: 0, fora: 0 }; let total = 0, extra = 0;
  list.forEach(e => { c[empStatus(e)]++; const m = minHoje(e); total += m; if (e.dia === td) { const x = extrasDia(e, td, m, tol(), S.escalas); extra += x.ex50 + x.ex100; } });
  $("#kpis").innerHTML = `
    <div class="kpi k-work"><span class="l">Trabalhando</span><span class="v">${c.trabalhando}</span></div>
    <div class="kpi k-pause"><span class="l">Em pausa</span><span class="v">${c.pausa}</span></div>
    <div class="kpi"><span class="l">Fora</span><span class="v">${c.fora}</span></div>
    <div class="kpi"><span class="l">Horas hoje · extras</span><span class="v">${dur(total)}<small class="muted" style="font-size:.5em"> · ${dur(extra)}</small></span></div>`;
  $("#agora-table").innerHTML = !list.length
    ? `<div class="empty">Nenhum funcionário cadastrado. <button class="btn sm primary" data-act="emp-new">Adicionar o primeiro</button></div>`
    : `<table><thead><tr><th>Funcionário</th><th>Situação</th><th>Marcações de hoje</th><th class="r">Hoje</th><th class="r">Extra hoje</th><th class="hide-sm">Jornada</th></tr></thead><tbody>${list.map(e => {
      const st = empStatus(e), stale = isStale(e);
      const marcs = e.dia === td ? (e.hoje || []) : [];
      const pv = previsto(e, td, S.escalas), jm = pv.min, m = minHoje(e), pct = jm ? Math.min(100, m / jm * 100) : (m ? 100 : 0);
      const x = e.dia === td ? extrasDia(e, td, m, tol(), S.escalas) : null, ex = x ? x.ex50 + x.ex100 : 0;
      const pill = stale ? `<span class="pill alerta">Sem saída em ${fmtDay(e.dia)}</span>` : `<span class="pill ${st}">${STATUS[st]}${st !== "fora" && e.desde ? " · " + hm(e.desde) : ""}</span>`;
      return `<tr><td class="who"><div class="nm">${esc(e.nome)}</div><div class="cg">${esc(e.codigo || "")}${e.cargo ? " · " + esc(e.cargo) : ""}</div></td>
        <td>${pill}</td>
        <td>${marcs.length ? `<div class="chips">${marcs.map(y => `<span class="chip t-${y.t}">${SHORT[y.t]} <b>${hm(y.ts)}</b></span>`).join("")}</div>` : `<span class="muted">—</span>`}</td>
        <td class="r num" data-live="${esc(e.id)}">${dur(m)}</td>
        <td class="r num">${ex > 0 ? `<b class="neg">+${dur(ex)}</b> <span class="muted" style="font-size:12px">${x.ex100 ? "100%" : "50%"}</span>` : `<span class="muted">—</span>`}</td>
        <td class="hide-sm"><div class="bar ${m > jm ? "over" : ""}"><i style="width:${pct.toFixed(1)}%"></i></div><div class="muted num" style="font-size:12px;margin-top:3px">${jm ? "de " + dur(jm) : (pv.tipo === "feriado" ? "feriado" : "folga hoje")}</div></td></tr>`;
    }).join("")}</tbody></table>`;
  const feed = [];
  list.forEach(e => { if (e.dia === td) (e.hoje || []).forEach(y => feed.push({ ...y, nome: e.nome })); });
  feed.sort((a, b) => b.ts - a.ts);
  $("#feed").innerHTML = feed.length ? feed.map(y => `<li><span class="t">${hm(y.ts)}</span><span><b>${esc(y.nome)}</b><br><span class="w">${LABEL[y.t]}</span></span></li>`).join("")
    : `<li class="empty" style="display:block">Ainda não há registros hoje.</li>`;
}

/* ---------- Equipe ---------- */
function diasTxt(d) { d = Array.isArray(d) ? d : DIAS_PADRAO; const k = [...d].sort().join(","); if (k === "1,2,3,4,5") return "seg a sex"; if (k === "1,2,3,4,5,6") return "seg a sáb"; return [...d].sort().map(i => DOWC[i].toLowerCase()).join(", "); }
function codigoLivre() { const usados = new Set(Object.values(S.emps).map(e => e.codigo)); for (let i = 0; i < 300; i++) { const c = String(1000 + Math.floor(Math.random() * 9000)); if (!usados.has(c)) return c; } return ""; }
function renderEquipe() {
  const all = empsSorted(true);
  $("#eq-count").textContent = `${all.filter(e => e.ativo !== false).length} ativos` + (all.some(e => e.ativo === false) ? ` · ${all.filter(e => e.ativo === false).length} desativados` : "");
  $("#eq-list").innerHTML = all.length ? all.map(e => `<div class="card ${e.ativo === false ? "off" : ""}">
      <div class="row"><h3>${esc(e.nome)}</h3>${e.ativo === false ? `<span class="tag ed">Desativado</span>` : `<span class="pill ${empStatus(e)}">${STATUS[empStatus(e)]}</span>`}</div>
      <div class="codebox"><span class="muted">Código</span> <b class="num">${esc(e.codigo || "—")}</b></div>
      <div class="muted">${esc(e.cargo || "Sem cargo")}</div>
      <div class="muted" style="font-size:13px">${esc(semanaTxt(e))}</div>
      <div class="row"><button class="btn sm" data-act="emp-edit" data-fid="${esc(e.id)}">Editar</button><button class="btn sm ghost" data-act="emp-hist" data-fid="${esc(e.id)}">Ver histórico</button></div>
    </div>`).join("")
    : `<div class="card"><h3>Comece pela equipe</h3><p class="muted" style="margin:0">Cadastre cada funcionário. Ele recebe um código de 4 números e usa esse código para bater o ponto no celular.</p><div><button class="btn primary" data-act="emp-new">Adicionar funcionário</button></div></div>`;
}

function openModal(html) {
  $("#modal-root").innerHTML = `<div class="overlay" data-act="modal-bg"><div class="dialog" role="dialog" aria-modal="true">${html}</div></div>`;
  const f = $("#modal-root .dialog input, #modal-root .dialog select"); f && f.focus();
}
const closeModal = () => { $("#modal-root").innerHTML = ""; };

function empForm(fid) {
  const e = fid ? S.emps[fid] : null;
  const semana = e ? semanaDe(e) : { ...PADRAO_SEMANA };
  openModal(`<h2>${e ? "Editar funcionário" : "Novo funcionário"}</h2>
    <label class="field">Nome<input id="f-nome" maxlength="60" value="${esc(e?.nome || "")}" autocomplete="off"></label>
    <label class="field">Cargo<input id="f-cargo" maxlength="40" value="${esc(e?.cargo || "")}" placeholder="Ex.: Conferente"></label>
    <label class="field">Código do funcionário (4 números, usado no celular)<input id="f-cod" class="num" inputmode="numeric" maxlength="4" autocomplete="off" value="${esc(e?.codigo || codigoLivre())}"></label>
    <fieldset class="field" style="border:0;padding:0;margin:0"><legend style="margin-bottom:6px">Jornada padrão (horas por dia; 0 = folga)</legend>
      <div class="weekgrid">${DIAS_SEMANA.map(i => `<label><span>${DOWC[i]}</span><input type="number" min="0" max="16" step="0.5" data-wd="${i}" value="${(semana[i] || 0) / 60}"></label>`).join("")}</div>
      <span class="muted" style="font-size:12.5px;font-weight:400;margin-top:4px">Sábados alternados e folgas específicas você ajusta na aba Escala.</span></fieldset>
    ${e ? `<label class="check"><input type="checkbox" id="f-ativo" ${e.ativo !== false ? "checked" : ""}> Ativo (consegue bater ponto)</label>` : ""}
    <div class="form-err" id="f-err" role="alert"></div>
    <div class="foot"><button class="btn" data-act="modal-close">Cancelar</button><button class="btn primary" data-act="emp-save" data-fid="${esc(fid || "")}">Salvar</button></div>`);
}
async function empSave(fid, btn) {
  const nome = $("#f-nome").value.trim(), cargo = $("#f-cargo").value.trim();
  const codigo = $("#f-cod").value.trim();
  const jornadaSemana = {}; let semErro = false;
  document.querySelectorAll(".weekgrid input").forEach(x => { const h = parseFloat(String(x.value || "0").replace(",", ".")); if (!(h >= 0 && h <= 16)) semErro = true; jornadaSemana[x.dataset.wd] = Math.round((h || 0) * 60); });
  const err = $("#f-err");
  if (!nome) return err.textContent = "Informe o nome.";
  if (semErro) return err.textContent = "As horas de cada dia devem ficar entre 0 e 16.";
  if (!/^\d{4}$/.test(codigo)) return err.textContent = "O código precisa ter exatamente 4 números.";
  const dono = Object.values(S.emps).find(x => x.codigo === codigo && x.id !== fid);
  if (dono) return err.textContent = `O código ${codigo} já é de ${dono.nome}. Escolha outro.`;
  if (!Object.values(jornadaSemana).some(Boolean)) return err.textContent = "Informe as horas de pelo menos um dia.";
  btn.disabled = true;
  try {
    if (fid) await updateDoc(empRef(fid), { nome, cargo, jornadaSemana, codigo, ativo: $("#f-ativo").checked });
    else await setDoc(doc(collection(db, "funcionarios")), { nome, cargo, jornadaSemana, codigo, ativo: true, status: "fora", criado: Date.now(), inicio: today() });
    closeModal(); toast(fid ? "Funcionário atualizado" : `${nome} foi adicionado com o código ${codigo}`);
  } catch (e) { btn.disabled = false; err.textContent = errMsg(e); }
}

/* ---------- Acessos (logins) ---------- */
function renderAcessos() {
  const list = Object.values(S.users).sort((a, b) => (a.role || "").localeCompare(b.role || "") || (a.email || "").localeCompare(b.email || ""));
  $("#u-list").innerHTML = `<table><thead><tr><th>Acesso</th><th>Tipo</th><th class="hide-sm">Criado em</th><th></th></tr></thead><tbody>${list.map(u => `<tr>
    <td class="who"><div class="nm">${esc(u.nome || u.email)}</div><div class="cg">${esc(u.email || "")}</div></td>
    <td><span class="role ${esc(u.role)}">${u.role === "admin" ? "Administrador" : "Celular"}</span></td>
    <td class="hide-sm muted num">${u.criado ? new Date(u.criado).toLocaleDateString("pt-BR") : "—"}</td>
    <td class="r">${u.id === S.me.uid ? `<span class="muted">Você</span>` : `<button class="btn sm danger" data-act="u-del" data-uid="${esc(u.id)}">Remover acesso</button>`}</td></tr>`).join("")}</tbody></table>`;
}
function userForm(role) {
  openModal(`<h2>${role === "admin" ? "Adicionar administrador" : "Criar acesso do celular"}</h2>
    <p class="muted" style="margin:0">${role === "admin" ? "Essa pessoa vai poder ver tudo, cadastrar funcionários e ajustar registros pelo computador." : "Use esse e-mail e senha uma vez para conectar o app no celular da agência. Pode ser um e-mail como ponto@gobox.com.br, não precisa existir caixa de entrada."}</p>
    <label class="field">Nome<input id="u-nome" maxlength="60" value="${role === "admin" ? "" : "Celular da agência"}"></label>
    <label class="field">E-mail<input id="u-email" type="email" autocomplete="off"></label>
    <label class="field">Senha (mínimo 6 caracteres)<input id="u-senha" type="text" autocomplete="new-password"></label>
    <div class="form-err" id="u-err" role="alert"></div>
    <div class="foot"><button class="btn" data-act="modal-close">Cancelar</button><button class="btn primary" data-act="u-save" data-role="${role}">Criar acesso</button></div>`);
}
async function userSave(role, btn) {
  const nome = $("#u-nome").value.trim(), email = $("#u-email").value.trim(), senha = $("#u-senha").value;
  const err = $("#u-err");
  if (!email) return err.textContent = "Informe o e-mail.";
  if (senha.length < 6) return err.textContent = "A senha precisa ter pelo menos 6 caracteres.";
  btn.disabled = true;
  try {
    const uid = await createLogin(email, senha);
    await setDoc(doc(db, "usuarios", uid), { role, email, nome, criado: Date.now() });
    closeModal(); toast(role === "admin" ? "Administrador criado" : "Acesso do celular criado. Use esse e-mail e senha no app.");
  } catch (e) { btn.disabled = false; err.textContent = errMsg(e); }
}
function userDelForm(uid) {
  const u = S.users[uid];
  openModal(`<h2>Remover acesso</h2><p style="margin:0">${esc(u.nome || u.email)} (${esc(u.email)}) não vai mais conseguir entrar${u.role === "terminal" ? ", e o celular conectado com esse acesso para de registrar ponto" : ""}.</p>
    <div class="foot"><button class="btn" data-act="modal-close">Cancelar</button><button class="btn primary" data-act="u-del-ok" data-uid="${esc(uid)}">Remover</button></div>`);
}

/* ---------- Configurações ---------- */
function cfgForm() {
  openModal(`<h2>Configurações</h2>
    <label class="field">Nome que aparece no celular<input id="c-nome" maxlength="50" value="${esc(S.cfg.nome || "")}" placeholder="Ponto"></label>
    <label class="field">Tolerância diária para hora extra e atraso (minutos)<input id="c-tol" type="number" min="0" max="60" step="1" value="${tol()}"></label>
    <p class="muted" style="margin:0;font-size:13px">A CLT permite até 10 minutos por dia sem contar como extra ou atraso.</p>
    <div class="form-err" id="c-err" role="alert"></div>
    <div class="foot"><button class="btn" data-act="modal-close">Cancelar</button><button class="btn primary" data-act="cfg-save">Salvar</button></div>`);
}
async function cfgSave(btn) {
  const nome = $("#c-nome").value.trim(), t = parseInt($("#c-tol").value, 10);
  if (!(t >= 0 && t <= 60)) return $("#c-err").textContent = "A tolerância deve ficar entre 0 e 60 minutos.";
  btn.disabled = true;
  try { await setDoc(doc(db, "config", "geral"), { nome, tolerancia: t }); closeModal(); toast("Configurações salvas"); }
  catch (e) { btn.disabled = false; $("#c-err").textContent = errMsg(e); }
}

/* ---------- Relatório ---------- */
function monthRange(off) {
  const n = new Date(); const a = new Date(n.getFullYear(), n.getMonth() + off, 1);
  const b = off === 0 ? n : new Date(n.getFullYear(), n.getMonth() + off + 1, 0);
  return [dayKey(a), dayKey(b)];
}
function fillRepSelect() {
  const sel = $("#r-fid"); const cur = sel.value || "todos";
  sel.innerHTML = `<option value="todos">Todos</option>` + empsSorted(true).map(e => `<option value="${esc(e.id)}">${esc(e.nome)}${e.ativo === false ? " (desativado)" : ""}</option>`).join("");
  sel.value = (S.emps[cur] || cur === "todos") ? cur : "todos";
  if (!$("#r-de").value) { const [a, b] = monthRange(0); $("#r-de").value = a; $("#r-ate").value = b; }
  if (!S.rep.data && !S.rep.loading) loadRep();
}
async function loadRep() {
  const de = $("#r-de").value, ate = $("#r-ate").value, f = $("#r-fid").value || "todos";
  if (!de || !ate || de > ate) { $("#rep-out").innerHTML = `<div class="empty">Escolha um período válido.</div>`; return; }
  const fids = f === "todos" ? empsSorted(true).map(e => e.id) : [f];
  const seq = ++S.rep.seq; S.rep.loading = true;
  $("#rep-out").innerHTML = `<div class="empty">Carregando…</div>`;
  try {
    const [snaps] = await Promise.all([
      Promise.all(fids.map(fid => getDocs(query(collection(db, "funcionarios", fid, "dias"), where("data", ">=", de), where("data", "<=", ate))))),
      loadMeses(de, ate)
    ]);
    if (seq !== S.rep.seq) return;
    const data = {};
    fids.forEach((fid, i) => { data[fid] = snaps[i].docs.map(d => d.data()).sort((a, b) => a.data.localeCompare(b.data)); });
    S.rep.data = { de, ate, fids, data };
  } catch (e) { if (seq === S.rep.seq) $("#rep-out").innerHTML = `<div class="empty">${esc(errMsg(e))}</div>`; S.rep.loading = false; return; }
  S.rep.loading = false; renderRep();
}
function summarize(fid) {
  const e = S.emps[fid] || {}, R = S.rep.data, td = today();
  const porDia = {}; (R.data[fid] || []).forEach(d => { if ((d.marcacoes || []).length) porDia[d.data] = d; });
  const inicio = e.inicio || (e.criado ? dayKey(new Date(e.criado)) : R.de);
  let tot = 0, inc = 0, ex50 = 0, ex100 = 0, deb = 0, prevTot = 0, faltas = 0, diasTrab = 0;
  const rows = [];
  for (let d = keyToDate(R.de); dayKey(d) <= R.ate && dayKey(d) <= td; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    const dia = dayKey(d), reg = porDia[dia];
    if (reg) {
      const current = e.dia === dia && isOpen(e);
      const min = derive(reg.marcacoes, { now: current ? Date.now() : null, incompleto: reg.incompleto }).liveMin;
      const x = extrasDia(e, dia, min, tol(), S.escalas);
      tot += min; ex50 += x.ex50; ex100 += x.ex100; if (!current) deb += x.deb; prevTot += x.prev.min; diasTrab++;
      if (reg.incompleto) inc++;
      rows.push({ dia, d: reg, min, current, ...x });
    } else {
      const p = previsto(e, dia, S.escalas);
      if (p.min && dia < td && dia >= inicio) { faltas++; deb += p.min; prevTot += p.min; rows.push({ dia, d: null, min: 0, falta: true, prev: p, ex50: 0, ex100: 0, deb: p.min }); }
    }
  }
  return { rows, tot, inc, dias: diasTrab, faltas, prevTot, ex50, ex100, deb, saldo: ex50 + ex100 - deb };
}
function renderRep() {
  const R = S.rep.data, out = $("#rep-out"); if (!R || !out) return;
  const sums = R.fids.filter(f => S.emps[f]).map(f => ({ f, ...summarize(f) }));
  if (!sums.length) { out.innerHTML = `<div class="empty">Nenhum funcionário neste filtro.</div>`; return; }
  const T = sums.reduce((a, x) => ({ ex50: a.ex50 + x.ex50, ex100: a.ex100 + x.ex100, deb: a.deb + x.deb, tot: a.tot + x.tot }), { ex50: 0, ex100: 0, deb: 0, tot: 0 });
  const exCell = v => v > 0 ? `<b class="neg">${dur(v)}</b>` : `<span class="muted">—</span>`;
  out.innerHTML = `<div class="kpis" style="padding:14px 14px 0;margin:0">
      <div class="kpi"><span class="l">Horas no período</span><span class="v">${dur(T.tot)}</span></div>
      <div class="kpi k-pause"><span class="l">Extras 50%</span><span class="v">${dur(T.ex50)}</span></div>
      <div class="kpi k-pause"><span class="l">Extras 100% (folgas)</span><span class="v">${dur(T.ex100)}</span></div>
      <div class="kpi k-work"><span class="l">Horas devidas</span><span class="v">${dur(T.deb)}</span></div></div>
  <table style="margin-top:14px"><thead><tr><th>Funcionário</th><th class="r">Dias</th><th class="r">Previstas</th><th class="r">Horas</th><th class="r">Extras 50%</th><th class="r">Extras 100%</th><th class="r">Devidas</th><th class="r">Banco</th><th>Pendências</th></tr></thead><tbody>${sums.map(s => {
    const e = S.emps[s.f], open = !!S.rep.open[s.f];
    const det = !open ? "" : `<tr class="detail"><td colspan="9"><div class="detail-in"><div class="table-wrap"><table><thead><tr><th>Data</th><th>Marcações</th><th class="r">Previsto</th><th class="r">Horas</th><th class="r">Extra</th><th class="r">Devida</th><th></th></tr></thead><tbody>${
      s.rows.length ? s.rows.map(r => r.falta ? `<tr><td class="num" style="white-space:nowrap">${fmtDay(r.dia)}</td>
        <td><span class="tag inc">Falta</span> <span class="muted" style="font-size:12.5px">sem registro de ponto</span></td>
        <td class="r num">${horasTxt(r.prev.min)}</td><td class="r num">0h00</td><td class="r num"><span class="muted">—</span></td>
        <td class="r num"><span class="pos">−${dur(r.deb)}</span></td>
        <td class="r" style="white-space:nowrap"><button class="btn sm" data-act="esc-folga" data-fid="${esc(s.f)}" data-dia="${esc(r.dia)}">Abonar</button> <button class="btn sm" data-act="day-new" data-fid="${esc(s.f)}" data-dia="${esc(r.dia)}">Lançar</button></td></tr>`
      : `<tr><td class="num" style="white-space:nowrap">${fmtDay(r.d.data)}${r.prev.min ? "" : ` <span class="tag ed">${r.prev.tipo === "feriado" ? "feriado" : "folga"}</span>`}</td>
        <td><div class="chips">${(r.d.marcacoes || []).map(y => `<span class="chip t-${y.t}">${SHORT[y.t]} <b>${hm(y.ts)}</b></span>`).join("")}
          ${r.d.incompleto ? `<span class="tag inc">Sem saída</span>` : ""}${r.current ? `<span class="tag live">Em andamento</span>` : ""}${r.d.editado ? `<span class="tag ed">Ajustado</span>` : ""}</div></td>
        <td class="r num">${r.prev.min ? horasTxt(r.prev.min) : "—"}</td>
        <td class="r num">${dur(r.min)}</td>
        <td class="r num">${r.ex50 + r.ex100 > 0 ? `<b class="neg">+${dur(r.ex50 + r.ex100)}</b> <span class="muted" style="font-size:12px">${r.ex100 ? "100%" : "50%"}</span>` : `<span class="muted">—</span>`}</td>
        <td class="r num">${r.deb > 0 ? `<span class="pos">−${dur(r.deb)}</span>` : `<span class="muted">—</span>`}</td>
        <td class="r"><button class="btn sm" data-act="day-edit" data-fid="${esc(s.f)}" data-dia="${esc(r.d.data)}">Ajustar</button></td></tr>`).join("")
      : `<tr><td colspan="7" class="muted">Sem registros no período.</td></tr>`}</tbody></table></div>
      <div style="margin-top:8px"><button class="btn sm" data-act="day-new" data-fid="${esc(s.f)}">Lançar dia manualmente</button></div></div></td></tr>`;
    return `<tr class="sum ${open ? "open" : ""}" data-act="rep-toggle" data-fid="${esc(s.f)}" tabindex="0">
      <td class="who"><span class="caret">▸</span><span class="nm">${esc(e.nome)}</span> <span class="cg">${esc(e.codigo || "")}</span></td>
      <td class="r num">${s.dias}${s.faltas ? ` <span class="tag inc">${s.faltas} falta${s.faltas > 1 ? "s" : ""}</span>` : ""}</td><td class="r num">${dur(s.prevTot)}</td><td class="r num">${dur(s.tot)}</td>
      <td class="r num">${exCell(s.ex50)}</td><td class="r num">${exCell(s.ex100)}</td>
      <td class="r num">${s.deb > 0 ? `<span class="pos">${dur(s.deb)}</span>` : `<span class="muted">—</span>`}</td>
      <td class="r num ${s.saldo >= 0 ? "neg" : "pos"}">${s.dias ? saldoTxt(s.saldo) : "—"}</td>
      <td>${s.inc ? `<span class="tag inc">${s.inc} dia${s.inc > 1 ? "s" : ""} sem saída</span>` : `<span class="muted">—</span>`}</td></tr>${det}`;
  }).join("")}</tbody></table>
  <p class="muted" style="margin:0;padding:10px 14px;font-size:13px;border-top:1px solid var(--line)">Previstas: horas da escala no período. Extras 50%: o que passa do previsto, e horas trabalhadas em sábados ou dias de folga. Extras 100%: domingos e feriados. Devidas: horas que faltaram, incluindo faltas (use Abonar para atestados e folgas combinadas). Diferenças de até ${tol()} minutos por dia não contam. Banco = extras − devidas. Clique numa linha para ver os dias.</p>`;
}
async function exportCsv() {
  if (!S.rep.data) await loadRep();
  const R = S.rep.data; if (!R) return;
  const q = v => { v = String(v ?? ""); return /[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  const lines = [["Código", "Funcionário", "Cargo", "Data", "Dia da semana", "Entrada", "Saída", "Marcações", "Previsto", "Horas trabalhadas", "Extras 50%", "Extras 100%", "Horas devidas", "Situação"].join(";")];
  R.fids.filter(f => S.emps[f]).forEach(f => {
    const e = S.emps[f], s = summarize(f);
    s.rows.forEach(r => {
      const m = r.d ? (r.d.marcacoes || []) : [];
      const ent = m.find(x => x.t === "entrada"), sai = [...m].reverse().find(x => x.t === "saida");
      const sit = r.falta ? "Falta" : [r.d.incompleto ? "Sem saída" : "", r.current ? "Em andamento" : "", r.d.editado ? "Ajustado" : "", r.prev.min ? "" : (r.prev.tipo === "feriado" ? "Feriado" : "Folga")].filter(Boolean).join(", ");
      const dt = keyToDate(r.dia);
      lines.push([e.codigo || "", e.nome, e.cargo || "", `${pad(dt.getDate())}/${pad(dt.getMonth() + 1)}/${dt.getFullYear()}`, DOWL[dt.getDay()],
        ent ? hm(ent.ts) : "", sai ? hm(sai.ts) : "", m.map(x => `${SHORT[x.t]} ${hm(x.ts)}`).join(" | "),
        hmm(r.prev.min), hmm(r.min), hmm(r.ex50), hmm(r.ex100), hmm(r.deb), sit].map(q).join(";"));
    });
    if (s.rows.length) lines.push([e.codigo || "", e.nome, e.cargo || "", "TOTAL", `${s.dias} dias, ${s.faltas} faltas`, "", "", "", hmm(s.prevTot), hmm(s.tot), hmm(s.ex50), hmm(s.ex100), hmm(s.deb), `Banco ${hmm(s.saldo)}` + (s.inc ? ` · ${s.inc} sem saída` : "")].map(q).join(";"));
  });
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `ponto_gobox_${R.de}_a_${R.ate}.csv`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ---------- Escala ---------- */
function renderEscala() {
  if (!S.escMes) S.escMes = mesDe(today());
  const mes = S.escMes; watchMes(mes);
  const [y, m] = mes.split("-").map(Number);
  $("#esc-mes").textContent = `${MES[m - 1]} ${y}`;
  const out = $("#esc-out"), list = empsSorted();
  if (!list.length) { out.innerHTML = `<div class="empty">Cadastre funcionários na aba Equipe para montar a escala.</div>`; return; }
  const nDias = new Date(y, m, 0).getDate(), td = today();
  const dias = Array.from({ length: nDias }, (_, i) => `${mes}-${pad(i + 1)}`);
  const doMes = S.escalas[mes] || {};
  out.innerHTML = `<table class="esc"><thead><tr><th class="esc-nome">Funcionário</th>${dias.map(d => { const w = keyToDate(d).getDay(); return `<th class="esc-d ${w === 0 || w === 6 ? "fds" : ""} ${d === td ? "hoje" : ""}"><button data-act="esc-col" data-dia="${d}" title="Aplicar a todos em ${fmtDay(d)}">${DOWC[w][0]}<b>${Number(d.slice(8))}</b></button></th>`; }).join("")}<th class="r">Total</th></tr></thead><tbody>${list.map(e => {
    let tot = 0;
    const cells = dias.map(d => {
      const p = previsto(e, d, S.escalas); tot += p.min;
      const w = keyToDate(d).getDay();
      const cls = [p.ajustado ? "aj" : "", p.tipo === "feriado" ? "fe" : (!p.min ? "fo" : ""), w === 0 || w === 6 ? "fds" : "", d === td ? "hoje" : ""].join(" ");
      const txt = p.tipo === "feriado" ? "F" : (p.min ? horasTxt(p.min).replace(/h$/, "") : "–");
      return `<td class="esc-c ${cls}"><button data-act="esc-cell" data-fid="${esc(e.id)}" data-dia="${d}" title="${esc(e.nome)} · ${fmtDay(d)}: ${p.tipo === "feriado" ? "feriado" : p.min ? horasTxt(p.min) : "folga"}${p.ajustado ? " (ajustado)" : ""}">${txt}</button></td>`;
    }).join("");
    return `<tr><td class="esc-nome"><div class="nm">${esc(e.nome)}</div><div class="cg">${esc(e.codigo || "")}</div></td>${cells}<td class="r num"><b>${dur(tot)}</b></td></tr>`;
  }).join("")}</tbody></table>`;
}
function escForm(fid, dia) {
  const e = fid ? S.emps[fid] : null;
  const p = e ? previsto(e, dia, S.escalas) : null;
  const padrao = e ? semanaDe(e)[keyToDate(dia).getDay()] : null;
  const opt = (label, tipo, min, extra = "") => `<button class="btn esc-opt" data-act="esc-set" data-tipo="${tipo}" data-min="${min}" data-fid="${esc(fid || "")}" data-dia="${dia}">${label}${extra}</button>`;
  openModal(`<h2>${e ? esc(e.nome) : "Todos os funcionários"}</h2>
    <div class="muted" style="text-transform:capitalize">${DOWL[keyToDate(dia).getDay()]}, ${Number(dia.slice(8))} de ${MES[Number(dia.slice(5, 7)) - 1]}${p ? ` · hoje na escala: ${p.tipo === "feriado" ? "feriado" : p.min ? horasTxt(p.min) : "folga"}` : ""}</div>
    <div class="esc-opts">
      ${opt("Trabalha 8h", "trabalho", 480)}
      ${opt("Trabalha 4h", "trabalho", 240)}
      ${opt("Folga", "folga", 0)}
      ${opt("Feriado", "feriado", 0, ` <span class="muted" style="font-size:12px">extra 100%</span>`)}
    </div>
    <div class="grid2" style="align-items:end">
      <label class="field">Outra quantidade de horas<input id="esc-h" type="number" min="0.5" max="16" step="0.5" placeholder="Ex.: 6"></label>
      <button class="btn" data-act="esc-set" data-tipo="outro" data-fid="${esc(fid || "")}" data-dia="${dia}">Aplicar horas</button>
    </div>
    <div class="form-err" id="esc-err" role="alert"></div>
    <div class="foot">
      <button class="btn ghost" data-act="esc-set" data-tipo="padrao" data-fid="${esc(fid || "")}" data-dia="${dia}">Voltar ao padrão${e ? ` (${padrao ? horasTxt(padrao) : "folga"})` : ""}</button>
      <button class="btn" data-act="modal-close">Fechar</button>
    </div>`);
}
async function escSalvar(fids, dia, val) {
  const mes = mesDe(dia), dd = dia.slice(8), ref = doc(db, "escala", mes);
  if (val === null) {
    const atual = S.escalas[mes] || {};
    const patch = {}; fids.forEach(f => { if (atual[f] && atual[f][dd]) patch[`${f}.${dd}`] = deleteField(); });
    if (Object.keys(patch).length) await updateDoc(ref, patch);
  } else {
    const data = {}; fids.forEach(f => { data[f] = { [dd]: val }; });
    await setDoc(ref, data, { merge: true });
  }
  if (!S.escSubs[mes]) { const s = await getDoc(ref); S.escalas[mes] = s.exists() ? s.data() : {}; }
}
async function escSet(el) {
  const fid = el.dataset.fid, dia = el.dataset.dia, tipo = el.dataset.tipo;
  let val;
  if (tipo === "padrao") val = null;
  else if (tipo === "outro") {
    const h = parseFloat(String($("#esc-h").value).replace(",", "."));
    if (!(h > 0 && h <= 16)) return $("#esc-err").textContent = "Informe entre 0,5 e 16 horas.";
    val = { tipo: "trabalho", min: Math.round(h * 60) };
  } else val = { tipo, min: Number(el.dataset.min) || 0 };
  const fids = fid ? [fid] : empsSorted().map(e => e.id);
  el.disabled = true;
  try { await escSalvar(fids, dia, val); closeModal(); toast(fid ? "Escala atualizada" : "Escala atualizada para todos"); if (S.rep.data) renderRep(); }
  catch (x) { el.disabled = false; $("#esc-err").textContent = errMsg(x); }
}

/* ---------- Ajuste de dia ---------- */
const rowHtml = r => `<div class="mrow"><select data-role="t">${Object.keys(LABEL).map(k => `<option value="${k}" ${k === r.t ? "selected" : ""}>${LABEL[k]}</option>`).join("")}</select>
  <input type="time" data-role="time" value="${r.time}" data-off="${r.off}"><button class="btn sm ghost" data-act="mrow-rm" aria-label="Remover">✕</button></div>`;
function dayForm(fid, dia, novaData) {
  const e = S.emps[fid];
  const d = dia ? (S.rep.data?.data[fid] || []).find(x => x.data === dia) : null;
  const base = dia ? keyToDate(dia).getTime() : null;
  const rows = (d?.marcacoes || []).map(x => ({ t: x.t, time: hm(x.ts), off: base ? Math.floor((x.ts - base) / 864e5) : 0 }));
  if (!rows.length) rows.push({ t: "entrada", time: "08:00", off: 0 }, { t: "saida", time: "17:00", off: 0 });
  openModal(`<h2>${dia ? "Ajustar " + fmtDay(dia) : "Lançar dia"}</h2>
    <div class="muted">${esc(e.nome)} · código ${esc(e.codigo || "")}</div>
    ${dia ? "" : `<label class="field">Data<input type="date" id="d-dia" value="${novaData || today()}" max="${today()}"></label>`}
    <div id="mrows" style="display:grid;gap:8px">${rows.map(rowHtml).join("")}</div>
    <div><button class="btn sm" data-act="mrow-add">Adicionar marcação</button></div>
    <p class="muted" style="margin:0;font-size:13px">O dia fica marcado como ajustado no relatório. Remova todas as marcações para apagar o dia.</p>
    <div class="form-err" id="d-err" role="alert"></div>
    <div class="foot"><button class="btn" data-act="modal-close">Cancelar</button><button class="btn primary" data-act="day-save" data-fid="${esc(fid)}" data-dia="${esc(dia || "")}">Salvar dia</button></div>`);
}
async function daySave(fid, diaArg, btn) {
  const dia = diaArg || $("#d-dia")?.value, err = $("#d-err");
  if (!dia) return err.textContent = "Escolha a data.";
  const base = keyToDate(dia).getTime(), marc = [];
  for (const row of document.querySelectorAll("#mrows .mrow")) {
    const t = $("[data-role=t]", row).value, inp = $("[data-role=time]", row), v = inp.value;
    if (!v) return err.textContent = "Preencha todos os horários.";
    const [h, mi] = v.split(":").map(Number);
    const d = new Date(base); d.setDate(d.getDate() + Number(inp.dataset.off || 0)); d.setHours(h, mi, 0, 0);
    marc.push({ t, ts: d.getTime() });
  }
  marc.sort((a, b) => a.ts - b.ts);
  if (marc.length && marc[0].t !== "entrada") return err.textContent = "A primeira marcação do dia precisa ser uma entrada.";
  const e = S.emps[fid], last = marc[marc.length - 1];
  const incompleto = !!last && last.t !== "saida" && dia < today();
  btn.disabled = true;
  try {
    const b = writeBatch(db);
    if (!marc.length) {
      b.delete(doc(db, "funcionarios", fid, "dias", dia));
      if (e.dia === dia) b.update(empRef(fid), { hoje: [], status: "fora", desde: null, incompleto: false });
    } else batchDay(b, e, dia, marc, { incompleto, editado: true });
    await b.commit();
    closeModal(); toast("Dia salvo"); await loadRep();
  } catch (x) { btn.disabled = false; err.textContent = errMsg(x); }
}

/* ---------- eventos ---------- */
document.addEventListener("click", async ev => {
  const el = ev.target.closest("[data-act],[data-tab]"); if (!el) return;
  if (el.dataset.tab) { S.tab = el.dataset.tab; showTab(); return; }
  const a = el.dataset.act, fid = el.dataset.fid;
  switch (a) {
    case "modal-bg": if (ev.target === el) closeModal(); break;
    case "modal-close": closeModal(); break;
    case "sair": await signOut(auth); location.reload(); break;
    case "cfg": cfgForm(); break;
    case "cfg-save": cfgSave(el); break;
    case "emp-new": empForm(null); break;
    case "emp-edit": empForm(fid); break;
    case "emp-save": empSave(fid || null, el); break;
    case "emp-hist": S.tab = "relatorio"; showTab(); $("#r-fid").value = fid; S.rep.open[fid] = true; loadRep(); break;
    case "u-new": userForm(el.dataset.role); break;
    case "u-save": userSave(el.dataset.role, el); break;
    case "u-del": userDelForm(el.dataset.uid); break;
    case "u-del-ok": el.disabled = true; try { await deleteDoc(doc(db, "usuarios", el.dataset.uid)); closeModal(); toast("Acesso removido"); } catch (x) { el.disabled = false; toast(errMsg(x), true); } break;
    case "rep-toggle": S.rep.open[fid] = !S.rep.open[fid]; renderRep(); break;
    case "r-mes": case "r-mesant": { const [x, y] = monthRange(a === "r-mes" ? 0 : -1); $("#r-de").value = x; $("#r-ate").value = y; loadRep(); break; }
    case "r-csv": exportCsv(); break;
    case "day-edit": dayForm(fid, el.dataset.dia); break;
    case "day-new": dayForm(fid, null, el.dataset.dia); break;
    case "esc-prev": case "esc-next": { const [y, m] = S.escMes.split("-").map(Number); S.escMes = dayKey(new Date(y, m - 1 + (a === "esc-next" ? 1 : -1), 1)).slice(0, 7); renderEscala(); break; }
    case "esc-cell": escForm(el.dataset.fid, el.dataset.dia); break;
    case "esc-col": escForm(null, el.dataset.dia); break;
    case "esc-set": escSet(el); break;
    case "esc-folga": escSalvar([fid], el.dataset.dia, { tipo: "folga", min: 0 }).then(() => { toast("Dia abonado como folga"); loadRep(); }); break;
    case "day-save": daySave(fid, el.dataset.dia, el); break;
    case "mrow-rm": el.closest(".mrow").remove(); break;
    case "mrow-add": { const t = document.createElement("div"); t.innerHTML = rowHtml({ t: "saida", time: "", off: 0 }); $("#mrows").appendChild(t.firstElementChild); break; }
  }
});
document.addEventListener("keydown", ev => {
  if (ev.key === "Escape" && $("#modal-root").innerHTML) closeModal();
  if ((ev.key === "Enter" || ev.key === " ") && ev.target.matches("tr.sum")) { ev.preventDefault(); ev.target.click(); }
});
