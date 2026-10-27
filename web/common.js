// Ponto GoBox — código compartilhado entre o painel (computador) e o terminal (celular).
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, initializeAuth, inMemoryPersistence, onAuthStateChanged, signInWithEmailAndPassword,
  signOut, createUserWithEmailAndPassword, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, memoryLocalCache,
  doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot, query, where, writeBatch
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
  doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot, query, where, writeBatch
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
export const today = () => dayKey(new Date());
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
export const minHoje = e => (e && e.dia === today()) ? derive(e.hoje, { now: Date.now(), incompleto: e.incompleto }).liveMin : 0;
export const empStatus = e => isOpen(e) ? e.status : "fora";

/* Horas extras: em dia de trabalho, o que passa da jornada (50%); em folga/domingo, tudo (100%).
   Diferenças até a tolerância (padrão 10 min, CLT art. 58 §1º) não contam. */
export function extrasDia(e, dia, min, tol) {
  const jm = e.jornadaMin || 480;
  const dias = Array.isArray(e.diasTrab) ? e.diasTrab : DIAS_PADRAO;
  const util = dias.includes(keyToDate(dia).getDay());
  if (!util) return { util, ex50: 0, ex100: min, deb: 0 };
  const diff = min - jm;
  return { util, ex50: diff > tol ? diff : 0, ex100: 0, deb: diff < -tol ? -diff : 0 };
}

/* Grava um dia (e atualiza o resumo do funcionário quando é o dia mais recente) numa única operação */
export function batchDay(b, e, dia, marc, { incompleto = false, editado = false } = {}) {
  marc = [...marc].sort((a, b2) => a.ts - b2.ts).map(x => ({ t: x.t, ts: x.ts }));
  const d = derive(marc, { incompleto });
  const now = Date.now();
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
