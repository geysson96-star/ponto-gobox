// Ponto GoBox — terminal do celular da agência (só para os funcionários baterem ponto).
import {
  configured, auth, db, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  doc, collection, getDoc, onSnapshot, writeBatch, batchDay,
  $, esc, pad, dayKey, today, hm, dur, fmtDay, longDate, LABEL, SHORT, STATUS,
  derive, isOpen, isStale, minHoje, empStatus, errMsg, toast, notConfigured, previsto, mesDe, horasTxt, setRodizio, TURNO, agora, agoraMs, relogio, sincronizarRelogio
} from "./common.js";

const root = $("#root");
const S = {
  emps: {}, cfg: {}, escalas: {}, ready: false, online: navigator.onLine, email: "",
  k: { screen: "pin", fid: null, pin: "", err: "", fails: 0, lockUntil: 0, ok: null, busy: false },
  unsub: [], idle: null, okTimer: null, wake: null
};
const ativos = () => Object.values(S.emps).filter(e => e.ativo !== false);

if (!configured) notConfigured(root);
else onAuthStateChanged(auth, async user => {
  S.unsub.forEach(u => u()); S.unsub = []; S.ready = false;
  if (!user) return renderLogin();
  let role = null;
  try { const u = await getDoc(doc(db, "usuarios", user.uid)); role = u.exists() ? u.data().role : null; } catch {}
  if (role !== "terminal") {
    await signOut(auth);
    return renderLogin(role === "admin"
      ? "Essa é uma conta de administrador. No celular use o acesso do celular, criado no painel em Acessos."
      : "Este acesso não está liberado. Crie um acesso do celular no painel, em Acessos.");
  }
  S.email = user.email || "";
  renderShell();
  S.unsub.push(onSnapshot(collection(db, "funcionarios"), snap => {
    const o = {}; snap.forEach(d => { o[d.id] = { id: d.id, ...d.data() }; });
    S.emps = o; S.ready = true; renderBody();
  }, () => toast("Não foi possível ler a equipe. Verifique a internet.", true)));
  S.unsub.push(onSnapshot(doc(db, "config", "geral"), s => { S.cfg = s.exists() ? s.data() : {}; setRodizio(S.cfg.rodizio); renderBody(); const b = $("#k-brand"); if (b) b.textContent = S.cfg.nome || "Ponto"; }, () => {}));
  const mes = mesDe(today());
  S.unsub.push(onSnapshot(doc(db, "escala", mes), s => { S.escalas[mes] = s.exists() ? s.data() : {}; renderBody(); }, () => {}));
  requestWake();
});

/* ---------- login do celular (feito uma vez pelo administrador) ---------- */
function renderLogin(msg = "") {
  root.innerHTML = `<div class="login">
    <img src="logo.png" alt="GoBox" style="width:220px;margin:0 auto">
    <div class="k-card">
      <h2 class="k-title">Conectar este celular</h2>
      <p class="muted" style="margin:0">Entre com o acesso do celular criado pelo administrador no painel. Isso é feito só uma vez.</p>
      <form id="lg" style="display:grid;gap:12px">
        <label class="field">E-mail<input id="lg-email" type="email" autocomplete="username" required></label>
        <label class="field">Senha<input id="lg-senha" type="password" autocomplete="current-password" required></label>
        <div class="form-err" role="alert">${esc(msg)}</div>
        <button class="btn primary" type="submit" style="min-height:52px;font-size:17px">Conectar</button>
      </form>
    </div></div>`;
  $("#lg").addEventListener("submit", async ev => {
    ev.preventDefault();
    const btn = $("#lg button"); btn.disabled = true;
    try { await signInWithEmailAndPassword(auth, $("#lg-email").value.trim(), $("#lg-senha").value); }
    catch (e) { btn.disabled = false; $("#lg .form-err").textContent = errMsg(e); }
  });
}

/* ---------- terminal ---------- */
function renderShell() {
  root.innerHTML = `
    <div class="k-top">
      <div style="display:flex;align-items:center;gap:10px;min-width:0">
        <img class="k-logo" id="k-logo" src="cube.png" alt="GoBox" title="Segure 3 segundos para desconectar">
        <div class="k-brand" id="k-brand">${esc(S.cfg.nome || "Ponto")}</div>
      </div>
      <span class="net" id="k-net" ${S.online ? "hidden" : ""}>Sem internet</span>
      <span class="net" id="k-clk" ${relogio.ok ? "hidden" : ""}>Conferindo horário…</span>
    </div>
    <div class="k-clock"><div class="time" id="k-time">--:--</div><div class="date" id="k-date"></div></div>
    <section id="k-body"><div class="gate" style="margin-top:20px"><div class="spinner"></div></div></section>`;
  // segurar o logo por 3 s abre a opção de desconectar o celular
  let t; const lg = $("#k-logo");
  const start = () => { t = setTimeout(disconnectForm, 3000); }, stop = () => clearTimeout(t);
  lg.addEventListener("pointerdown", start); ["pointerup", "pointerleave", "pointercancel"].forEach(ev => lg.addEventListener(ev, stop));
  lg.addEventListener("contextmenu", e => e.preventDefault());
  tick(); sync();
}

function resetKiosk() {
  clearTimeout(S.okTimer);
  Object.assign(S.k, { screen: "pin", fid: null, pin: "", err: "", ok: null, busy: false });
}
function bumpIdle() {
  clearTimeout(S.idle);
  if (S.k.screen !== "pin" || S.k.pin) S.idle = setTimeout(() => { resetKiosk(); renderBody(); }, 45000);
}

function renderBody() {
  const b = $("#k-body"); if (!b) return;
  const k = S.k;
  if (!S.ready) return;
  if (k.screen === "pin") {
    const locked = Date.now() < k.lockUntil;
    if (!ativos().length) { b.innerHTML = `<div class="k-empty"><h2 class="k-title">Ninguém cadastrado ainda</h2><p>O administrador cadastra a equipe pelo painel no computador. Cada funcionário recebe um código para bater o ponto aqui.</p></div>`; return; }
    b.innerHTML = `<div class="k-card">
      <div class="k-who"><h2>Bater ponto</h2></div>
      <p class="muted" style="margin:0;text-align:center;font-size:16px">${locked ? "Muitas tentativas. Aguarde 1 minuto." : "Digite seu código de 4 números"}</p>
      <div class="dots" id="k-dots">${[0, 1, 2, 3].map(i => `<span class="${i < k.pin.length ? "on" : ""}"></span>`).join("")}</div>
      <div class="k-err" role="alert">${esc(k.err)}</div>
      <div class="keypad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button data-act="key" data-k="${n}" ${locked ? "disabled" : ""}>${n}</button>`).join("")}
        <button class="fn" data-act="key" data-k="clr" ${locked ? "disabled" : ""}>Limpar</button>
        <button data-act="key" data-k="0" ${locked ? "disabled" : ""}>0</button>
        <button class="fn" data-act="key" data-k="del" ${locked ? "disabled" : ""}>Apagar</button></div>
    </div>`;
    return;
  }
  if (k.screen === "acoes") {
    const e = S.emps[k.fid]; if (!e || e.ativo === false) { resetKiosk(); return renderBody(); }
    const st = empStatus(e), stale = isStale(e), dis = k.busy ? "disabled" : "";
    let acts;
    if (stale) {
      const last = (e.hoje || []).slice(-1)[0];
      acts = `<div class="warn">Seu último registro foi ${last ? esc(LABEL[last.t].toLowerCase()) + " em " + fmtDay(e.dia) + " às " + hm(last.ts) : "em " + fmtDay(e.dia)}, sem saída. O administrador vai corrigir esse dia.</div>
        <button class="k-act entrada" data-act="new" ${dis}>Registrar entrada de hoje</button>`;
    } else if (st === "fora") acts = `<button class="k-act entrada" data-act="punch" data-t="entrada" ${dis}>Registrar entrada</button>`;
    else if (st === "trabalhando") acts = `<button class="k-act pausa" data-act="punch" data-t="pausa" ${dis}>Iniciar pausa</button><button class="k-act saida" data-act="punch" data-t="saida" ${dis}>Registrar saída</button>`;
    else acts = `<button class="k-act retorno" data-act="punch" data-t="retorno" ${dis}>Voltar da pausa</button><button class="k-act saida" data-act="punch" data-t="saida" ${dis}>Registrar saída</button>`;
    const marcs = e.dia === today() ? (e.hoje || []) : [];
    b.innerHTML = `<div class="k-card">
      <div class="k-who"><h2>Olá, ${esc((e.nome || "").split(" ")[0])}</h2><span class="pill ${stale ? "alerta" : st}">${stale ? "Sem saída" : STATUS[st]}</span></div>
      <div class="k-actions">${acts}</div>
      <div class="k-today"><div><div class="muted">Hoje</div>${marcs.length ? `<div class="chips" style="margin-top:4px">${marcs.map(m => `<span class="chip t-${m.t}">${SHORT[m.t]} <b>${hm(m.ts)}</b></span>`).join("")}</div>` : `<div>Nenhum registro ainda</div>`}</div>
        <div style="text-align:right"><div class="muted">Trabalhado</div><div class="big" data-live="${esc(e.id)}">${dur(minHoje(e))}</div><div class="muted" style="font-size:13px">${(p => p.min ? "jornada hoje " + horasTxt(p.min) + (p.turno ? " (" + TURNO[p.turno].toLowerCase() + ")" : "") : (p.tipo === "feriado" ? "hoje é feriado" : "hoje é folga"))(previsto(e, today(), S.escalas))}</div></div></div>
      <button class="btn ghost" data-act="back">Não sou eu, voltar</button>
    </div>`;
    return;
  }
  if (k.screen === "ok") {
    const o = k.ok;
    b.innerHTML = `<div class="k-card k-ok" data-act="back">
      <div class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>
      <h2>${esc(LABEL[o.t])} registrada</h2>
      <div class="when">${hm(o.ts)}</div>
      <div class="muted">${esc(o.nome)} · ${fmtDay(dayKey(new Date(o.ts)))}</div>
      ${o.fila ? `<p class="net" style="margin:6px 0 0">Sem internet: o registro foi guardado e será enviado sozinho</p>` : ""}
      <p class="muted" style="margin:8px 0 0">Toque para voltar</p></div>`;
  }
}

function keyPress(key) {
  const k = S.k;
  if (Date.now() < k.lockUntil) return;
  if (key === "del") k.pin = k.pin.slice(0, -1);
  else if (key === "clr") k.pin = "";
  else if (k.pin.length < 4) k.pin += key;
  k.err = ""; renderBody(); bumpIdle();
  if (k.pin.length < 4) return;
  const e = ativos().find(x => x.codigo === k.pin);
  k.pin = "";
  if (e) { k.fails = 0; k.fid = e.id; k.screen = "acoes"; renderBody(); bumpIdle(); return; }
  k.fails++; k.err = "Código não encontrado";
  if (k.fails >= 5) { k.lockUntil = Date.now() + 60000; k.fails = 0; k.err = ""; setTimeout(renderBody, 60500); }
  renderBody(); const d = $("#k-dots"); d && d.classList.add("shake");
}

async function punch(t, novoDia) {
  const k = S.k; const e = S.emps[k.fid]; if (!e || k.busy) return;
  k.busy = true; renderBody();
  if (!relogio.ok) {
    await sincronizarRelogio();
    if (!relogio.ok) { k.busy = false; renderBody(); toast("Sem internet para conferir o horário. Conecte o celular ao Wi-Fi ou aos dados móveis e tente de novo.", true); return; }
  }
  const now = agoraMs(), td = dayKey(new Date(now));
  const b = writeBatch(db);
  let dia, marc;
  if (novoDia && e.dia) {
    batchDay(b, { ...e, dia: null }, e.dia, e.hoje || [], { incompleto: true, editado: !!e.editado });
    dia = td; marc = [];
  } else if (isOpen(e) && e.dia) { dia = e.dia; marc = [...(e.hoje || [])]; }
  else if (e.dia === td) { dia = td; marc = [...(e.hoje || [])]; }
  else { dia = td; marc = []; }
  marc.push({ t, ts: now });
  // no "novo dia" o resumo do funcionário passa a apontar para hoje
  batchDay(b, novoDia ? { ...e, dia: null } : e, dia, marc, { editado: !novoDia && e.dia === dia && !!e.editado });
  const p = b.commit();
  // Sem internet, o Firestore guarda o registro no celular e envia depois; não travamos a tela esperando.
  const r = await Promise.race([p.then(() => "ok", err => ({ err })), new Promise(res => setTimeout(() => res("fila"), 2500))]);
  if (r && r.err) { k.busy = false; renderBody(); toast(errMsg(r.err), true); return; }
  if (r === "fila") p.catch(err => toast("Um registro não pôde ser salvo: " + errMsg(err), true));
  k.ok = { t, ts: now, nome: e.nome, fila: r === "fila" }; k.screen = "ok"; k.busy = false; renderBody();
  clearTimeout(S.okTimer); S.okTimer = setTimeout(() => { resetKiosk(); renderBody(); }, 5000);
}

function disconnectForm() {
  const r = $("#modal-root");
  r.innerHTML = `<div class="overlay"><div class="dialog" role="dialog" aria-modal="true">
    <h2>Desconectar este celular</h2>
    <p class="muted" style="margin:0">Digite a senha do acesso do celular (${esc(S.email)}). Depois disso, ninguém consegue bater ponto aqui até conectar de novo.</p>
    <label class="field">Senha<input id="dc-senha" type="password" autocomplete="current-password"></label>
    <div class="form-err" id="dc-err" role="alert"></div>
    <div class="foot"><button class="btn" data-act="dc-cancel">Cancelar</button><button class="btn primary" data-act="dc-ok">Desconectar</button></div>
  </div></div>`;
  $("#dc-senha").focus();
}

/* ---------- relógio, tela sempre ligada, rede ---------- */
function tick() {
  const d = agora();
  const kt = $("#k-time"); if (kt) kt.innerHTML = `${pad(d.getHours())}:${pad(d.getMinutes())}<small>${pad(d.getSeconds())}</small>`;
  const kd = $("#k-date"); if (kd) kd.textContent = longDate(d);
  document.querySelectorAll("[data-live]").forEach(el => { const e = S.emps[el.dataset.live]; if (e) el.textContent = dur(minHoje(e)); });
}
setInterval(tick, 1000);
/* Sincroniza o relógio ao abrir, a cada 5 minutos, ao voltar a internet e ao reabrir o app */
async function sync() {
  await sincronizarRelogio();
  const c = $("#k-clk"); if (c) { c.hidden = relogio.ok; c.textContent = relogio.ok ? "" : "Sem horário da internet"; }
  tick();
}
sync(); setInterval(sync, 5 * 60000);
addEventListener("online", sync);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") sync(); });
let lastDay = today();
setInterval(() => { if (today() !== lastDay) { lastDay = today(); renderBody(); } }, 30000);
async function requestWake() {
  if (S.wake || !("wakeLock" in navigator)) return;
  try { S.wake = await navigator.wakeLock.request("screen"); S.wake.addEventListener("release", () => S.wake = null); } catch {}
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") requestWake(); });
const net = on => { S.online = on; const n = $("#k-net"); if (n) n.hidden = on; };
addEventListener("online", () => net(true)); addEventListener("offline", () => net(false));

/* ---------- eventos ---------- */
document.addEventListener("click", async ev => {
  const el = ev.target.closest("[data-act]"); if (!el) return;
  const a = el.dataset.act;
  if (a === "key") keyPress(el.dataset.k);
  else if (a === "punch") punch(el.dataset.t, false);
  else if (a === "new") punch("entrada", true);
  else if (a === "back") { resetKiosk(); renderBody(); }
  else if (a === "dc-cancel") $("#modal-root").innerHTML = "";
  else if (a === "dc-ok") {
    el.disabled = true;
    try { await signInWithEmailAndPassword(auth, S.email, $("#dc-senha").value); $("#modal-root").innerHTML = ""; await signOut(auth); }
    catch (e) { el.disabled = false; $("#dc-err").textContent = errMsg(e); }
  }
  if (a !== "back") bumpIdle();
});
document.addEventListener("keydown", ev => {
  if ($("#modal-root").innerHTML) return;
  if (S.k.screen === "pin" && /^[0-9]$/.test(ev.key)) keyPress(ev.key);
  if (S.k.screen === "pin" && ev.key === "Backspace") keyPress("del");
});
