'use strict';
// Pasta de entrada monitorada: um subdiretório por empresa.
//   data/entrada/shopee/   data/entrada/ml/   data/entrada/correios/
// Qualquer relatório .csv/.xlsx colocado ali é importado na próxima
// verificação. Cada empresa é processada de forma independente: um erro
// numa fonte não impede as outras. O arquivo é apagado depois de lido
// (sucesso ou falha), para não guardar dados pessoais do relatório.

const fs = require('node:fs');
const path = require('node:path');
const { SOURCE_IDS } = require('./sources');
const { prepareImport, applyImport, needsConfirmation } = require('./importer');

const ACCEPTED = /\.(csv|tsv|txt|xlsx)$/i;
const running = new Set();

function ensureInboxDirs(inboxDir) {
  for (const s of SOURCE_IDS) fs.mkdirSync(path.join(inboxDir, s), { recursive: true });
}

// Ignora arquivos que ainda estão sendo copiados (modificados há menos de 10 s).
function isSettled(file) {
  const st = fs.statSync(file);
  return st.isFile() && Date.now() - st.mtimeMs > 10_000;
}

async function processSource(db, inboxDir, sourceId) {
  if (running.has(sourceId)) return { source: sourceId, skipped: true };
  running.add(sourceId);
  const results = [];
  try {
    const dir = path.join(inboxDir, sourceId);
    if (!fs.existsSync(dir)) return { source: sourceId, results };
    const files = fs.readdirSync(dir)
      .filter((f) => ACCEPTED.test(f) && !f.startsWith('.'))
      .map((f) => path.join(dir, f))
      .filter(isSettled)
      .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);

    for (const file of files) {
      let buffer;
      try {
        buffer = fs.readFileSync(file);
      } finally {
        try { fs.unlinkSync(file); } catch { /* já removido */ }
      }
      const prepared = await prepareImport(db, {
        sourceId, buffer, filename: path.basename(file), origin: 'entrada'
      });
      if (prepared.failed) {
        results.push({ importId: prepared.importId, status: 'falhou' });
      } else if (needsConfirmation(prepared)) {
        results.push({ importId: prepared.importId, status: 'aguardando_confirmacao' });
      } else {
        applyImport(db, prepared.importId);
        results.push({ importId: prepared.importId, status: 'sucesso' });
      }
    }
    return { source: sourceId, results };
  } catch (err) {
    console.error(`[entrada:${sourceId}]`, err && err.message ? err.message : err);
    return { source: sourceId, error: true, results };
  } finally {
    running.delete(sourceId);
  }
}

async function processAll(db, inboxDir) {
  // allSettled: cada fonte isolada.
  const out = await Promise.allSettled(SOURCE_IDS.map((s) => processSource(db, inboxDir, s)));
  return out.map((r, i) => (r.status === 'fulfilled' ? r.value : { source: SOURCE_IDS[i], error: true }));
}

function startScheduler(db, inboxDir, minutes) {
  ensureInboxDirs(inboxDir);
  if (!minutes || minutes <= 0) return null;
  const tick = () => processAll(db, inboxDir).catch((e) => console.error('[entrada]', e));
  setTimeout(tick, 5_000).unref();
  const timer = setInterval(tick, minutes * 60_000);
  timer.unref();
  return timer;
}

module.exports = { processAll, processSource, startScheduler, ensureInboxDirs };
