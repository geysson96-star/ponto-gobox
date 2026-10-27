// Ponto GoBox — código compartilhado entre o painel (computador) e o terminal (celular).
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, initializeAuth, inMemoryPersistence, onAuthStateChanged, signInWithEmailAndPassword,
  signOut, createUserWithEmailAndPassword, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, memoryLocalCache,
  doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot, query, where, writeBatch, deleteField
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./config.js";

export const configured = !!(firebaseConfig && firebaseConfig.apiKey && !String(firebaseConfig.apiKey).startsWith("COLE"));
export const app = configured ? initializeApp(firebaseConfig) : null;
export const auth = app ? getAuth(app) : null;
let _db = null;
if (app) {
  try { _db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
  catch { _db = initializeFirestore(app, { localCache: memoryLocalCache() }); }
}
export const db = _db;
export {
  onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail,
  doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot, query, where, writeBatch, deleteField
};

/* Cria um login novo sem desconectar o administrador */
export async function createLogin(email, senha) {
  const sec = initializeApp(firebaseConfig, "sec-" + Date.now());
  try {
    const a = initializeAuth(sec, { persistence: inMemoryPersistence });
    const cred = await createUserWithEmailAndPassword(a, email, senha);
    await signOut(a);
    return cred.user.uid;
  } finally { deleteApp(sec).catch(() => {}); }
}

/* ---------- helpers ---------- */
export const $ = (s, el = document) => el.querySelector(s);
export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const pad = n => String(n).padStart(2, "0");
export const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/* ---------- Relógio pela internet ----------
   O horário vem do servidor (cabeçalho Date da resposta HTTP), não do relógio do aparelho.
   Guardamos a diferença entre o servidor e o aparelho e corrigimos todo horário com ela. */
export const relogio = { offset: 0, ok: false, ultimo: 0, erro: false };
export const agoraMs = () => Date.now() + relogio.offset;
export const agora = () => new Date(agoraMs());
async function amostra() {
  const t0 = Date.now();
  const r = await fetch(`config.js?relogio=${t0}`, { method: "HEAD", cache: "no-store" });
  const t1 = Date.now();
  const h = r.headers.get("date"); if (!h) throw new Error("sem data");
  const srv = new Date(h).getTime() + 500; // o cabeçalho vem em segundos inteiros
  return { offset: srv - (t0 + t1) / 2, rtt: t1 - t0 };
}
export async function sincronizarRelogio() {
  try {
    const amostras = [];
    for (let i = 0; i < 3; i++) { try { amostras.push(await amostra()); } catch {} }
    if (!amostras.length) throw new Error("offline");
    amostras.sort((a, b) => a.rtt - b.rtt);
    relogio.offset = Math.round(amostras[0].offset); relogio.ok = true; relogio.ultimo = Date.now(); relogio.erro = false;
  } catch { relogio.erro = true; }
  return relogio.ok;
}
export const today = () => dayKey(agora());
export const keyToDate = k => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
export const hm = ts => { const d = new Date(ts); return pad(d.getHours()) + ":" + pad(d.getMinutes()); };
export const dur = min => { min = Math.max(0, Math.round(min)); return Math.floor(min / 60) + "h" + pad(min % 60); };
export const hmm = min => { const neg = min < 0; min = Math.abs(Math.round(min)); return (neg ? "-" : "") + Math.floor(min / 60) + ":" + pad(min % 60); };
export const saldoTxt = min => { const r = Math.round(min); return (r < 0 ? "−" : "+") + dur(Math.abs(r)); };
export const DOW = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
export const DOWC = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
export const DOWL = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
export const MES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
export const fmtDay = k => { const d = keyToDate(k); return `${DOW[d.getDay()]}, ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`; };
export const longDate = d => `${DOWL[d.getDay()]}, ${d.getDate()} de ${MES[d.getMonth()]}`;
export const LABEL = { entrada: "Entrada", pausa: "Início da pausa", retorno: "Fim da pausa", saida: "Saída" };
export const SHORT = { entrada: "Entrada", pausa: "Pausa", retorno: "Retorno", saida: "Saída" };
export const STATUS = { trabalhando: "Trabalhando", pausa: "Em pausa", fora: "Fora" };
export const DIAS_PADRAO = [1, 2, 3, 4, 5];

/* Situação e minutos trabalhados a partir das marcações de um dia */
export function derive(marc, opts = {}) {
  const m = [...(marc || [])].sort((a, b) => a.ts - b.ts);
  let closed = 0, open = null, status = "fora", desde = null;
  for (const x of m) {
    if (x.t === "entrada" || x.t === "retorno") { if (open === null) open = x.ts; status = "trabalhando"; }
    else { if (open !== null) { closed += x.ts - open; open = null; } status = x.t === "pausa" ? "pausa" : "fora"; }
    desde = x.ts;
  }
  let live = closed;
  if (opts.incompleto) status = "fora";
  else if (open !== null && opts.now) live += Math.max(0, opts.now - open);
  return { status, desde, closedMin: closed / 60000, liveMin: live / 60000, open };
}
export const isOpen = e => !!(e && e.status && e.status !== "fora" && !e.incompleto);
export const isStale = e => isOpen(e) && e.dia && e.dia !== today();
export const minHoje = e => (e && e.dia === today()) ? derive(e.hoje, { now: agoraMs(), incompleto: e.incompleto }).liveMin : 0;
export const empStatus = e => isOpen(e) ? e.status : "fora";

/* ---------- Jornada e escala ----------
   Cada funcionário tem uma jornada padrão por dia da semana (minutos; 0 = folga).
   A escala do mês (documento escala/AAAA-MM) guarda ajustes por dia: { [fid]: { "DD": {tipo, min} } }
   tipo: "trabalho" (min = horas previstas), "folga" ou "feriado". */
export const PADRAO_SEMANA = { 0: 0, 1: 480, 2: 480, 3: 480, 4: 480, 5: 480, 6: 240 };
export function semanaDe(e) {
  if (e && e.jornadaSemana) { const o = {}; for (let i = 0; i < 7; i++) o[i] = Number(e.jornadaSemana[i]) || 0; return o; }
  if (e && (Array.isArray(e.diasTrab) || e.jornadaMin)) {
    const dias = Array.isArray(e.diasTrab) ? e.diasTrab : DIAS_PADRAO, jm = e.jornadaMin || 480, o = {};
    for (let i = 0; i < 7; i++) o[i] = dias.includes(i) ? jm : 0;
    return o;
  }
  return { ...PADRAO_SEMANA };
}
export const mesDe = dia => dia.slice(0, 7);
/* Rodízio de sábado: config/geral.rodizio = { ativo, ordem: [fid...], inicio: "AAAA-MM-DD" (um sábado), manhaMin, tardeMin }
   No sábado N (contado a partir de "inicio"), a pessoa na posição i da ordem pega o turno (i + N) mod n:
   posição 0 = manhã, 1 = tarde, as demais folgam. Assim todos giram e trabalham as mesmas horas. */
let ROD = null;
export const setRodizio = r => { ROD = r && r.ativo && Array.isArray(r.ordem) && r.ordem.length && r.inicio ? r : null; };
export function turnoRodizio(fid, dia, rod = ROD) {
  if (!rod || keyToDate(dia).getDay() !== 6 || dia < rod.inicio) return null;
  const i = rod.ordem.indexOf(fid); if (i < 0) return null;
  const n = rod.ordem.length;
  const semanas = Math.round((keyToDate(dia) - keyToDate(rod.inicio)) / 6048e5);
  const pos = (((i - semanas) % n) + n) % n;
  if (pos === 0) return { turno: "manha", min: Number(rod.manhaMin) || 240 };
  if (pos === 1) return { turno: "tarde", min: Number(rod.tardeMin) || 240 };
  return { turno: "folga", min: 0 };
}
export const TURNO = { manha: "Manhã", tarde: "Tarde", folga: "Folga" };
/* Horas previstas num dia, considerando o ajuste da escala quando existir */
export function previsto(e, dia, escalas) {
  const ov = escalas && escalas[mesDe(dia)] && escalas[mesDe(dia)][e.id] && escalas[mesDe(dia)][e.id][dia.slice(8)];
  if (ov && ov.tipo) return { min: ov.tipo === "trabalho" ? (Number(ov.min) || 0) : 0, tipo: ov.tipo, ajustado: true };
  const r = turnoRodizio(e.id, dia);
  if (r) return { min: r.min, tipo: r.min ? "trabalho" : "folga", turno: r.turno, ajustado: false };
  const m = semanaDe(e)[keyToDate(dia).getDay()] || 0;
  return { min: m, tipo: m ? "trabalho" : "folga", ajustado: false };
}
/* Horas extras: o que passa do previsto (50%). Em dia sem jornada: domingo e feriado contam 100%, demais folgas 50%.
   Diferenças até a tolerância (padrão 10 min, CLT art. 58 §1º) não contam. */
export function extrasDia(e, dia, min, tol, escalas) {
  const p = previsto(e, dia, escalas);
  if (!p.min) {
    const cem = p.tipo === "feriado" || keyToDate(dia).getDay() === 0;
    return { util: false, prev: p, ex50: cem ? 0 : min, ex100: cem ? min : 0, deb: 0 };
  }
  const diff = min - p.min;
  return { util: true, prev: p, ex50: diff > tol ? diff : 0, ex100: 0, deb: diff < -tol ? -diff : 0 };
}
export const horasTxt = min => { min = Math.round(min || 0); const h = Math.floor(min / 60), m = min % 60; return m ? `${h}h${pad(m)}` : `${h}h`; };

/* Grava um dia (e atualiza o resumo do funcionário quando é o dia mais recente) numa única operação */
export function batchDay(b, e, dia, marc, { incompleto = false, editado = false } = {}) {
  marc = [...marc].sort((a, b2) => a.ts - b2.ts).map(x => ({ t: x.t, ts: x.ts }));
  const d = derive(marc, { incompleto });
  const now = agoraMs();
  b.set(doc(db, "funcionarios", e.id, "dias", dia), { data: dia, marcacoes: marc, minutos: Math.round(d.closedMin), incompleto, editado, atualizado: now });
  if (!e.dia || dia >= e.dia) {
    b.update(doc(db, "funcionarios", e.id), { dia, hoje: marc, status: d.status, desde: d.desde, incompleto, editado, atualizado: now });
  }
}

export function errMsg(e) {
  const c = e && e.code ? String(e.code) : "";
  if (c.includes("permission-denied")) return "Esta conta não tem permissão para isso.";
  if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found") || c.includes("invalid-email")) return "E-mail ou senha incorretos.";
  if (c.includes("email-already-in-use")) return "Já existe um acesso com esse e-mail.";
  if (c.includes("weak-password")) return "A senha precisa ter pelo menos 6 caracteres.";
  if (c.includes("too-many-requests")) return "Muitas tentativas. Aguarde alguns minutos.";
  if (c.includes("network") || c.includes("unavailable")) return "Sem conexão com a internet. Tente de novo.";
  return "Não foi possível concluir agora. Tente de novo.";
}

let toastT;
export function toast(msg, err = false) {
  const r = $("#toast-root"); if (!r) return;
  r.innerHTML = `<div class="toast ${err ? "err" : ""}" role="status">${esc(msg)}</div>`;
  clearTimeout(toastT); toastT = setTimeout(() => r.innerHTML = "", err ? 6000 : 3500);
}

export function notConfigured(root) {
  root.innerHTML = `<div class="gate"><img src="logo.png" alt="GoBox" style="width:200px;margin:0 auto"><h1>Falta conectar o Firebase</h1><p class="muted">Preencha o arquivo config.js com a configuração do seu projeto Firebase.</p></div>`;
}
