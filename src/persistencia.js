'use strict';
// Guarda os dados do site no Firebase (Firestore) do Ponto GoBox, para que nada se perca
// quando o servidor do Render dorme, reinicia ou é publicado de novo.
//
// Leve de propósito:
//  - pacotes: um documento compactado (gzip) por empresa, gravado só quando algo mudou;
//  - estado (financeiro, configurações, sessões do painel): um documento pequeno;
//  - pacotes que já saíram há mais de RETENCAO_DIAS são apagados.
// Ao iniciar, o servidor restaura tudo antes de atender.
//
// Acesso: o mesmo login de administrador do Ponto (PONTO_EMAIL e PONTO_SENHA).
// Regra necessária no Firestore: match /consulta/{doc} { allow read, write: if isAdmin(); }

const zlib = require('node:zlib');
const crypto = require('node:crypto');
const eventos = require('./eventos');
const { SOURCE_IDS } = require('./sources');

const COLECAO = 'consulta';
const TAMANHO_PARTE = 900_000; // caracteres por documento (limite do Firestore: ~1 MB)
const ESPERA_MS = 4000;        // junta várias mudanças seguidas numa gravação só

function criar({ db, config, fetchFn = fetch, log = console }) {
  const apiKey = config.FIREBASE_API_KEY;
  const projeto = config.FIREBASE_PROJETO;
  const ativo = Boolean(config.PONTO_EMAIL && config.PONTO_SENHA && apiKey && projeto);
  const retencaoMs = (config.RETENCAO_DIAS || 60) * 86400_000;
  const base = `https://firestore.googleapis.com/v1/projects/${projeto}/databases/(default)/documents/${COLECAO}`;
  const ultimoHash = new Map();
  const timers = new Map();
  let token = null;
  let tokenAte = 0;
  let restaurando = false;
  let falhas = 0;

  // ---------- login no Firebase (REST) ----------
  async function idToken(forcar = false) {
    if (!forcar && token && Date.now() < tokenAte) return token;
    const r = await fetchFn(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: config.PONTO_EMAIL, password: config.PONTO_SENHA, returnSecureToken: true })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.idToken) throw new Error(`login no Firebase recusado (${(d.error && d.error.message) || r.status})`);
    token = d.idToken;
    tokenAte = Date.now() + (Number(d.expiresIn || 3600) - 300) * 1000;
    return token;
  }
  async function chamar(url, opcoes = {}, tentativa = 0) {
    const t = await idToken(tentativa > 0);
    const r = await fetchFn(url, { ...opcoes, headers: { ...(opcoes.headers || {}), Authorization: `Bearer ${t}` } });
    if (r.status === 401 && tentativa === 0) return chamar(url, opcoes, 1);
    return r;
  }

  // ---------- documentos ----------
  const campo = (v) => (typeof v === 'number' ? { integerValue: String(v) } : { stringValue: String(v) });
  const valor = (f) => (!f ? null : f.stringValue !== undefined ? f.stringValue : f.integerValue !== undefined ? Number(f.integerValue) : null);
  async function gravarDoc(id, campos) {
    const fields = {};
    for (const [k, v] of Object.entries(campos)) fields[k] = campo(v);
    const r = await chamar(`${base}/${encodeURIComponent(id)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields })
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(`Firebase recusou gravar ${id} (${r.status}${d.error && d.error.message ? `: ${d.error.message}` : ''})`);
    }
  }
  async function lerDoc(id) {
    const r = await chamar(`${base}/${encodeURIComponent(id)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Firebase recusou ler ${id} (${r.status})`);
    const d = await r.json();
    const out = {};
    for (const [k, f] of Object.entries(d.fields || {})) out[k] = valor(f);
    return out;
  }
  async function apagarDoc(id) {
    await chamar(`${base}/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
  }

  // Texto grande (base64 do gzip) em partes, com um documento de índice.
  async function gravarGrande(id, texto, extra) {
    const partes = [];
    for (let i = 0; i < texto.length; i += TAMANHO_PARTE) partes.push(texto.slice(i, i + TAMANHO_PARTE));
    if (!partes.length) partes.push('');
    const anterior = await lerDoc(id).catch(() => null);
    for (let i = 0; i < partes.length; i += 1) await gravarDoc(`${id}~${i}`, { dados: partes[i] });
    await gravarDoc(id, { partes: partes.length, ...extra });
    for (let i = partes.length; anterior && i < (anterior.partes || 0); i += 1) await apagarDoc(`${id}~${i}`);
  }
  async function lerGrande(id) {
    const indice = await lerDoc(id);
    if (!indice) return null;
    let texto = '';
    for (let i = 0; i < (indice.partes || 0); i += 1) {
      const p = await lerDoc(`${id}~${i}`);
      if (!p) throw new Error(`parte ${i} de ${id} não encontrada`);
      texto += p.dados || '';
    }
    return { indice, texto };
  }
  const compactar = (obj) => zlib.gzipSync(Buffer.from(JSON.stringify(obj)), { level: 9 }).toString('base64');
  const descompactar = (txt) => JSON.parse(zlib.gunzipSync(Buffer.from(txt, 'base64')).toString('utf8'));
  const hash = (txt) => crypto.createHash('sha1').update(txt).digest('hex');

  // ---------- pacotes ----------
  const seg = (iso) => (iso ? Math.round(Date.parse(iso) / 1000) : 0);
  const iso = (s) => (s ? new Date(s * 1000).toISOString() : null);

  function fotoPacotes(fonte) {
    // Limpeza: pacotes que já saíram há mais tempo que a retenção.
    const corte = new Date(Date.now() - retencaoMs).toISOString();
    db.prepare(`DELETE FROM packages WHERE source = ? AND active = 0 AND COALESCE(saida_em, last_updated_at) < ?`).run(fonte, corte);
    const rows = db.prepare(
      `SELECT code, external_id, active, first_seen_at, last_updated_at, situacao, rotulo, tipo, recebido_em, saida_em, volume
       FROM packages WHERE source = ? ORDER BY code`
    ).all(fonte);
    // Dicionário de textos repetidos (situação, rótulo, tipo, volume) para ficar compacto.
    const textos = [];
    const indice = new Map();
    const t = (s) => { if (s === null || s === undefined) return -1; if (!indice.has(s)) { indice.set(s, textos.length); textos.push(s); } return indice.get(s); };
    const p = rows.map((r) => [
      r.code, r.external_id && r.external_id !== r.code ? r.external_id : 0, r.active ? 1 : 0,
      seg(r.first_seen_at), seg(r.last_updated_at), t(r.situacao), t(r.rotulo), t(r.tipo), seg(r.recebido_em), seg(r.saida_em), t(r.volume)
    ]);
    const ultima = db.prepare(
      "SELECT finished_at FROM imports WHERE source = ? AND status = 'sucesso' ORDER BY id DESC LIMIT 1"
    ).get(fonte);
    return { v: 1, t: textos, p, ultimaSync: ultima ? ultima.finished_at : null };
  }

  function restaurarPacotes(fonte, foto) {
    const tx = (i) => (i >= 0 ? foto.t[i] : null);
    const agora = new Date().toISOString();
    const importId = db.prepare(
      `INSERT INTO imports (source, origin, file_label, status, started_at, finished_at, rows_read, codes_valid)
       VALUES (?, 'restaurado', 'cópia salva no Firebase', 'sucesso', ?, ?, ?, ?)`
    ).run(fonte, foto.ultimaSync || agora, foto.ultimaSync || agora, foto.p.length, foto.p.length).lastInsertRowid;
    const ins = db.prepare(
      `INSERT OR REPLACE INTO packages (source, code, external_id, active, first_seen_at, last_updated_at, last_seen_import_id,
         situacao, rotulo, tipo, recebido_em, saida_em, volume)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    db.transaction(() => {
      for (const [code, ext, act, fs, lu, sit, rot, tipo, rec, sai, vol] of foto.p) {
        ins.run(fonte, code, ext || code, act, iso(fs) || agora, iso(lu) || agora, act ? importId : null,
          tx(sit), tx(rot), tx(tipo), iso(rec), iso(sai), tx(vol));
      }
    })();
  }

  // ---------- estado (financeiro, configurações, sessões) ----------
  function fotoEstado() {
    const tem = (t) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    return {
      v: 1,
      financeiro: tem('financeiro') ? db.prepare('SELECT chave, json FROM financeiro').all() : [],
      settings: db.prepare('SELECT source, json FROM settings').all(),
      sessions: db.prepare('SELECT token_hash, created_at, expires_at FROM sessions WHERE expires_at > ?').all(new Date().toISOString()),
      acessos: tem('acessos') ? db.prepare('SELECT dia, visitas, consultas, encontrados, visitantes FROM acessos').all() : []
    };
  }
  function restaurarEstado(e) {
    db.exec('CREATE TABLE IF NOT EXISTS financeiro (chave TEXT PRIMARY KEY, json TEXT NOT NULL)');
    require('./acessos').preparar(db);
    db.transaction(() => {
      const f = db.prepare('INSERT OR REPLACE INTO financeiro (chave, json) VALUES (?, ?)');
      for (const r of e.financeiro || []) f.run(r.chave, r.json);
      const s = db.prepare('INSERT OR REPLACE INTO settings (source, json) VALUES (?, ?)');
      for (const r of e.settings || []) s.run(r.source, r.json);
      const se = db.prepare('INSERT OR REPLACE INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)');
      for (const r of e.sessions || []) se.run(r.token_hash, r.created_at, r.expires_at);
      // Contador de acessos: fica o maior valor (o servidor pode ter contado algo antes de restaurar).
      const a = db.prepare(`INSERT INTO acessos (dia, visitas, consultas, encontrados, visitantes) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(dia) DO UPDATE SET visitas = MAX(visitas, excluded.visitas), consultas = MAX(consultas, excluded.consultas),
        encontrados = MAX(encontrados, excluded.encontrados), visitantes = MAX(visitantes, excluded.visitantes)`);
      for (const r of e.acessos || []) a.run(r.dia, r.visitas || 0, r.consultas || 0, r.encontrados || 0, r.visitantes || 0);
    })();
  }

  // ---------- salvar ----------
  async function salvar(id, foto, extra = {}) {
    const texto = compactar(foto);
    const h = hash(texto);
    if (ultimoHash.get(id) === h) return false; // nada mudou: não grava
    await gravarGrande(id, texto, { hash: h, salvoEm: new Date().toISOString(), ...extra });
    ultimoHash.set(id, h);
    return true;
  }
  async function salvarAgora(alvo) {
    if (!ativo || restaurando) return;
    try {
      if (alvo === 'estado') await salvar('estado', fotoEstado());
      else {
        const foto = fotoPacotes(alvo);
        await salvar(`pacotes_${alvo}`, foto, { quantidade: foto.p.length });
      }
      falhas = 0;
    } catch (e) {
      falhas += 1;
      if (falhas <= 3 || falhas % 20 === 0) log.warn(`[persistência] não salvei ${alvo}: ${e.message}`);
    }
  }
  function agendar(alvo) {
    if (!ativo || restaurando) return;
    clearTimeout(timers.get(alvo));
    timers.set(alvo, setTimeout(() => { timers.delete(alvo); salvarAgora(alvo); }, ESPERA_MS));
  }

  // ---------- restaurar ao iniciar ----------
  async function restaurar() {
    if (!ativo) return { ativo: false };
    restaurando = true;
    const resultado = { ativo: true, pacotes: {}, estado: false };
    try {
      const est = await lerGrande('estado');
      if (est) {
        restaurarEstado(descompactar(est.texto));
        ultimoHash.set('estado', est.indice.hash);
        resultado.estado = true;
      }
      for (const fonte of SOURCE_IDS) {
        const g = await lerGrande(`pacotes_${fonte}`);
        if (!g) continue;
        const foto = descompactar(g.texto);
        restaurarPacotes(fonte, foto);
        ultimoHash.set(`pacotes_${fonte}`, g.indice.hash);
        resultado.pacotes[fonte] = foto.p.length;
      }
    } catch (e) {
      resultado.erro = e.message;
    } finally {
      restaurando = false;
    }
    return resultado;
  }

  function ligar() {
    if (!ativo) return;
    eventos.on('pacotes', (fonte) => agendar(fonte));
    eventos.on('estado', () => agendar('estado'));
  }

  async function esvaziar() {
    // Grava o que estiver pendente (ao desligar o servidor).
    const pendentes = [...timers.keys()];
    for (const k of pendentes) { clearTimeout(timers.get(k)); timers.delete(k); }
    for (const k of pendentes) await salvarAgora(k);
  }

  return { ativo, restaurar, ligar, salvarAgora, esvaziar, _fotoPacotes: fotoPacotes, _restaurarPacotes: restaurarPacotes, _compactar: compactar };
}

module.exports = { criar };
