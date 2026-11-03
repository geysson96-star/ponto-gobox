'use strict';
// Importação em duas fases: (1) preparar = ler o arquivo, guardar só os
// códigos e calcular o que vai mudar; (2) aplicar = gravar na base local.
// Uploads pelo painel sempre param na fase 1 para o administrador confirmar.
// A pasta de entrada aplica sozinha, exceto quando a importação desativaria
// pacotes demais (proteção contra relatório incompleto).

const { SOURCES } = require('./sources');
const { extractCodes, ImportError } = require('./parse');
const { nowIso, getSettings } = require('./db');

function safeLabel(name) {
  // Guarda só um rótulo curto do arquivo para o histórico.
  return String(name || 'arquivo').replace(/[^\w.\- ]+/g, '_').slice(0, 80);
}

function safeError(err) {
  if (err instanceof ImportError) return err.message;
  // Erros inesperados: mensagem genérica no histórico; detalhe só no log do servidor.
  console.error('[importação] erro inesperado:', err && err.stack ? err.stack : err);
  return 'Erro inesperado ao processar o arquivo. Veja o registro do servidor.';
}

async function prepareImport(db, { sourceId, buffer, filename, origin }) {
  const source = SOURCES[sourceId];
  const settings = getSettings(db, sourceId);
  const startedAt = nowIso();
  const importId = db.prepare(
    `INSERT INTO imports (source, origin, file_label, status, started_at)
     VALUES (?, ?, ?, 'processando', ?)`
  ).run(sourceId, origin, safeLabel(filename), startedAt).lastInsertRowid;

  try {
    const { rowsRead, codes, codeColumn } = await extractCodes({ buffer, filename, source, settings });
    if (codes.size === 0) {
      throw new ImportError(`Nenhum código válido encontrado na coluna "${codeColumn}".`);
    }

    const stage = db.transaction(() => {
      const ins = db.prepare('INSERT OR REPLACE INTO import_rows (import_id, code, external_id) VALUES (?, ?, ?)');
      for (const [code, ext] of codes) ins.run(importId, code, ext);
    });
    stage();

    const diff = computeDiff(db, importId, sourceId, settings.mode);
    db.prepare(
      `UPDATE imports SET status = 'aguardando_confirmacao', rows_read = ?, codes_valid = ?,
         to_insert = ?, to_update = ?, to_deactivate = ?, code_column = ? WHERE id = ?`
    ).run(rowsRead, codes.size, diff.toInsert, diff.toUpdate, diff.toDeactivate, codeColumn, importId);

    return { importId, ...diff, rowsRead, codesValid: codes.size, codeColumn, settings };
  } catch (err) {
    db.prepare(
      "UPDATE imports SET status = 'falhou', finished_at = ?, error_message = ? WHERE id = ?"
    ).run(nowIso(), safeError(err), importId);
    db.prepare('DELETE FROM import_rows WHERE import_id = ?').run(importId);
    const detail = err instanceof ImportError && err.detail ? err.detail : null;
    return { importId, failed: true, error: safeError(err), detail };
  }
}

// Usado pela extensão e pelo robô: os pacotes já vêm do portal, sem dados pessoais.
// `codes`: Map código -> (id da fonte | objeto com detalhes {situacao, rotulo, tipo, recebidoEm, saidaEm}).
// `modo`:
//   'estoque' (padrão): a lista é tudo o que está na agência agora; quem sumiu
//                       é marcado como "saiu da agência".
//   'eventos': a lista traz cada pacote com o seu status (inclusive os que já
//              saíram); nada é marcado por ausência.
function prepareFromCodes(db, { sourceId, codes, origin, label, modo = 'estoque' }) {
  const startedAt = nowIso();
  const importId = db.prepare(
    `INSERT INTO imports (source, origin, file_label, status, started_at)
     VALUES (?, ?, ?, 'processando', ?)`
  ).run(sourceId, origin, safeLabel(label), startedAt).lastInsertRowid;
  const mode = modo === 'eventos' ? 'eventos' : 'snapshot';
  const settings = { ...getSettings(db, sourceId), mode };
  db.transaction(() => {
    const ins = db.prepare('INSERT OR REPLACE INTO import_rows (import_id, code, external_id, dados) VALUES (?, ?, ?, ?)');
    for (const [code, v] of codes) {
      const detalhes = v && typeof v === 'object' ? v : null;
      ins.run(importId, code, detalhes ? (detalhes.idFonte ?? null) : (v ?? null), detalhes ? JSON.stringify(detalhes) : null);
    }
  })();
  const diff = computeDiff(db, importId, sourceId, mode);
  db.prepare(
    `UPDATE imports SET status = 'aguardando_confirmacao', rows_read = ?, codes_valid = ?,
       to_insert = ?, to_update = ?, to_deactivate = ?, code_column = ? WHERE id = ?`
  ).run(codes.size, codes.size, diff.toInsert, diff.toUpdate, diff.toDeactivate, `portal:${mode}`, importId);
  return { importId, ...diff, codesValid: codes.size, settings };
}

const SITUACOES = new Set(['na_agencia', 'retirado', 'enviado', 'saiu', 'outro']);
function limparDetalhes(json) {
  if (!json) return null;
  let d;
  try { d = JSON.parse(json); } catch { return null; }
  const txt = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
  const data = (v) => {
    if (v === null || v === undefined || v === '' || v === 0) return null;
    const t = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(String(v));
    return Number.isNaN(t.getTime()) ? null : t.toISOString();
  };
  return {
    situacao: SITUACOES.has(d.situacao) ? d.situacao : null,
    rotulo: txt(d.rotulo, 80),
    tipo: txt(d.tipo, 30),
    recebidoEm: data(d.recebidoEm),
    saidaEm: data(d.saidaEm)
  };
}

// Texto mostrado quando um pacote some da lista de estoque (modo 'estoque').
function rotuloSaida(tipo) {
  if (tipo === 'retirada') return 'Retirado pelo comprador';
  if (tipo === 'envio' || tipo === 'drop_off') return 'Coletado pela transportadora';
  return 'Saiu da agência';
}

function recordFailure(db, { sourceId, origin, label, message }) {
  const ts = nowIso();
  return db.prepare(
    `INSERT INTO imports (source, origin, file_label, status, started_at, finished_at, error_message)
     VALUES (?, ?, ?, 'falhou', ?, ?, ?)`
  ).run(sourceId, origin, safeLabel(label), ts, ts, String(message).slice(0, 300)).lastInsertRowid;
}

function computeDiff(db, importId, sourceId, mode) {
  const toInsert = db.prepare(
    `SELECT COUNT(*) AS n FROM import_rows r
     WHERE r.import_id = ? AND NOT EXISTS (SELECT 1 FROM packages p WHERE p.source = ? AND p.code = r.code)`
  ).get(importId, sourceId).n;
  const toUpdate = db.prepare(
    `SELECT COUNT(*) AS n FROM import_rows r
     JOIN packages p ON p.source = ? AND p.code = r.code WHERE r.import_id = ?`
  ).get(sourceId, importId).n;
  const toDeactivate = mode === 'snapshot'
    ? db.prepare(
      `SELECT COUNT(*) AS n FROM packages p WHERE p.source = ? AND p.active = 1
       AND NOT EXISTS (SELECT 1 FROM import_rows r WHERE r.import_id = ? AND r.code = p.code)`
    ).get(sourceId, importId).n
    : 0;
  const activeNow = db.prepare('SELECT COUNT(*) AS n FROM packages WHERE source = ? AND active = 1').get(sourceId).n;
  return { toInsert, toUpdate, toDeactivate, activeNow };
}

function applyImport(db, importId) {
  const imp = db.prepare('SELECT * FROM imports WHERE id = ?').get(importId);
  if (!imp) throw new ImportError('Importação não encontrada.');
  if (imp.status !== 'aguardando_confirmacao') {
    throw new ImportError('Esta importação não está aguardando confirmação.');
  }
  let settings = getSettings(db, imp.source);
  if (imp.origin === 'robo' || imp.origin === 'extensao') {
    settings = { ...settings, mode: String(imp.code_column || '').endsWith(':eventos') ? 'eventos' : 'snapshot' };
  }
  const ts = nowIso();

  const run = db.transaction(() => {
    // Upsert sem duplicatas: chave única (empresa, código).
    const upsert = db.prepare(
      `INSERT INTO packages (source, code, external_id, active, first_seen_at, last_updated_at, last_seen_import_id,
                             situacao, rotulo, tipo, recebido_em, saida_em)
       VALUES (@source, @code, @ext, 1, @ts, @ts, @imp, @situacao, @rotulo, @tipo, @recebido, @saida)
       ON CONFLICT(source, code) DO UPDATE SET
         external_id = COALESCE(excluded.external_id, packages.external_id),
         active = 1,
         last_updated_at = excluded.last_updated_at,
         last_seen_import_id = excluded.last_seen_import_id,
         situacao = COALESCE(excluded.situacao, 'na_agencia'),
         rotulo = excluded.rotulo,
         tipo = COALESCE(excluded.tipo, packages.tipo),
         recebido_em = COALESCE(excluded.recebido_em, packages.recebido_em),
         saida_em = excluded.saida_em`
    );
    const rows = db.prepare('SELECT code, external_id, dados FROM import_rows WHERE import_id = ?').all(importId);
    for (const r of rows) {
      const d = limparDetalhes(r.dados) || {};
      upsert.run({
        source: imp.source, code: r.code, ext: r.external_id, ts, imp: importId,
        situacao: d.situacao || 'na_agencia', rotulo: d.rotulo || null, tipo: d.tipo || null,
        recebido: d.recebidoEm || null, saida: d.saidaEm || null
      });
    }

    let deactivated = 0;
    if (settings.mode === 'snapshot') {
      // Quem estava na agência e não veio na lista: saiu (data aproximada = agora).
      const sumidos = db.prepare(
        `SELECT id, tipo FROM packages
         WHERE source = ? AND active = 1 AND (last_seen_import_id IS NULL OR last_seen_import_id != ?)`
      ).all(imp.source, importId);
      const marcar = db.prepare(
        `UPDATE packages SET active = 0, situacao = 'saiu', rotulo = ?, saida_em = ?, last_updated_at = ? WHERE id = ?`
      );
      for (const p of sumidos) marcar.run(rotuloSaida(p.tipo), ts, ts, p.id);
      deactivated = sumidos.length;
    }
    db.prepare('DELETE FROM import_rows WHERE import_id = ?').run(importId);
    db.prepare(
      "UPDATE imports SET status = 'sucesso', finished_at = ?, to_deactivate = ? WHERE id = ?"
    ).run(ts, deactivated, importId);
  });
  run();
  return db.prepare('SELECT * FROM imports WHERE id = ?').get(importId);
}

function cancelImport(db, importId) {
  const imp = db.prepare('SELECT status FROM imports WHERE id = ?').get(importId);
  if (!imp) throw new ImportError('Importação não encontrada.');
  if (imp.status !== 'aguardando_confirmacao') throw new ImportError('Esta importação não pode ser cancelada.');
  db.transaction(() => {
    db.prepare('DELETE FROM import_rows WHERE import_id = ?').run(importId);
    db.prepare("UPDATE imports SET status = 'cancelada', finished_at = ? WHERE id = ?").run(nowIso(), importId);
  })();
}

// Para a pasta de entrada: aplica automaticamente se for seguro.
function needsConfirmation(prepared) {
  if (prepared.failed) return false;
  const { toDeactivate, activeNow, settings } = prepared;
  if (!toDeactivate || !activeNow) return false;
  const pct = (toDeactivate / activeNow) * 100;
  return pct > settings.maxDeactivatePercent;
}

module.exports = {
  prepareImport, prepareFromCodes, recordFailure, applyImport, cancelImport, needsConfirmation, ImportError
};
