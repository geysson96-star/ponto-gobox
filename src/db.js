'use strict';
const fs = require('node:fs');
const path = require('node:path');
// Banco SQLite embutido no próprio Node.js (node:sqlite): não precisa
// compilar nada na instalação, funciona em qualquer Windows/Mac/Linux.
const { DatabaseSync } = require('node:sqlite');
const { SOURCES, SOURCE_IDS } = require('./sources');

// Envolve o banco com a mesma interface usada no resto do projeto
// (prepare/exec/transaction/close).
function wrap(raw) {
  const cache = new Map();
  const db = {
    raw,
    exec: (sql) => raw.exec(sql),
    prepare(sql) {
      let st = cache.get(sql);
      if (!st) {
        st = raw.prepare(sql);
        cache.set(sql, st);
      }
      return {
        get: (...args) => st.get(...args),
        all: (...args) => st.all(...args),
        run: (...args) => {
          const r = st.run(...args);
          return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
        }
      };
    },
    transaction(fn) {
      return (...args) => {
        raw.exec('BEGIN');
        try {
          const out = fn(...args);
          raw.exec('COMMIT');
          return out;
        } catch (err) {
          try { raw.exec('ROLLBACK'); } catch { /* já desfeito */ }
          throw err;
        }
      };
    },
    close: () => raw.close()
  };
  return db;
}

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = wrap(new DatabaseSync(file));
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS packages (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      code TEXT NOT NULL,
      external_id TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      first_seen_at TEXT NOT NULL,
      last_updated_at TEXT NOT NULL,
      last_seen_import_id INTEGER,
      UNIQUE (source, code)
    );
    CREATE INDEX IF NOT EXISTS idx_packages_code_active ON packages (code, active);
    CREATE INDEX IF NOT EXISTS idx_packages_source ON packages (source, active);

    CREATE TABLE IF NOT EXISTS imports (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      origin TEXT NOT NULL,            -- 'upload' | 'entrada'
      file_label TEXT,
      status TEXT NOT NULL,            -- 'processando' | 'aguardando_confirmacao' | 'sucesso' | 'falhou' | 'cancelada'
      started_at TEXT NOT NULL,
      finished_at TEXT,
      rows_read INTEGER DEFAULT 0,
      codes_valid INTEGER DEFAULT 0,
      to_insert INTEGER DEFAULT 0,
      to_update INTEGER DEFAULT 0,
      to_deactivate INTEGER DEFAULT 0,
      code_column TEXT,
      error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_imports_source ON imports (source, id DESC);

    -- Códigos extraídos e ainda não aplicados (só código e ID da fonte).
    CREATE TABLE IF NOT EXISTS import_rows (
      import_id INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      external_id TEXT,
      PRIMARY KEY (import_id, code)
    );

    CREATE TABLE IF NOT EXISTS settings (
      source TEXT PRIMARY KEY,
      json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);
  // Colunas novas (bancos já existentes ganham as colunas sem perder dados).
  const colunas = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  const add = (t, c, tipo) => { if (!colunas(t).includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${tipo}`); };
  // situacao: na_agencia | retirado | enviado | saiu | outro
  add('packages', 'situacao', 'TEXT');
  add('packages', 'rotulo', 'TEXT');      // texto do status mostrado ao cliente
  add('packages', 'tipo', 'TEXT');        // ex.: drop_off, retirada, envio
  add('packages', 'recebido_em', 'TEXT'); // quando o pacote chegou na agência (vindo do portal)
  add('packages', 'saida_em', 'TEXT');    // quando saiu (retirado/enviado), se o portal informa
  add('packages', 'volume', 'TEXT');      // pacote (shipment) ou saca, quando o portal informa
  add('import_rows', 'dados', 'TEXT');    // detalhes do pacote (JSON) vindos do portal
}

function nowIso() {
  return new Date().toISOString();
}

function getSettings(db, source) {
  const row = db.prepare('SELECT json FROM settings WHERE source = ?').get(source);
  const stored = row ? JSON.parse(row.json) : {};
  return { ...SOURCES[source].defaults, ...stored };
}

function saveSettings(db, source, patch) {
  const current = getSettings(db, source);
  const next = { ...current, ...patch };
  db.prepare(`INSERT INTO settings (source, json) VALUES (?, ?)
              ON CONFLICT(source) DO UPDATE SET json = excluded.json`).run(source, JSON.stringify(next));
  require('./eventos').emit('estado');
  return next;
}

function sourceStatus(db, source) {
  const settings = getSettings(db, source);
  const lastSuccess = db.prepare(
    "SELECT finished_at FROM imports WHERE source = ? AND status = 'sucesso' ORDER BY id DESC LIMIT 1"
  ).get(source);
  const last = db.prepare(
    "SELECT id, status, finished_at, started_at, error_message, origin FROM imports WHERE source = ? AND status != 'cancelada' ORDER BY id DESC LIMIT 1"
  ).get(source);
  const pending = db.prepare(
    "SELECT COUNT(*) AS n FROM imports WHERE source = ? AND status = 'aguardando_confirmacao'"
  ).get(source).n;
  const active = db.prepare('SELECT COUNT(*) AS n FROM packages WHERE source = ? AND active = 1').get(source).n;

  let state;
  const lastSuccessAt = lastSuccess ? lastSuccess.finished_at : null;
  const staleMs = settings.staleHours * 3600 * 1000;
  if (last && last.status === 'falhou') state = 'falhou';
  else if (!lastSuccessAt) state = 'sem_dados';
  else if (Date.now() - Date.parse(lastSuccessAt) > staleMs) state = 'desatualizado';
  else state = 'atualizado';

  return {
    id: source,
    name: SOURCES[source].name,
    state,
    lastSuccessAt,
    lastImport: last || null,
    pendingConfirmations: pending,
    activePackages: active,
    staleHours: settings.staleHours
  };
}

function allSourceStatus(db) {
  return SOURCE_IDS.map((s) => sourceStatus(db, s));
}

module.exports = { openDb, nowIso, getSettings, saveSettings, sourceStatus, allSourceStatus };
