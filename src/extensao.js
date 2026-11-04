'use strict';
// Chave de acesso da extensão do Edge. Guardada só como hash SHA-256.
const crypto = require('node:crypto');
const { nowIso } = require('./db');
const eventos = require('./eventos');

const CHAVE_SETTINGS = '__extensao';

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function ler(db) {
  const row = db.prepare('SELECT json FROM settings WHERE source = ?').get(CHAVE_SETTINGS);
  return row ? JSON.parse(row.json) : {};
}

function gravar(db, dados) {
  db.prepare(`INSERT INTO settings (source, json) VALUES (?, ?)
              ON CONFLICT(source) DO UPDATE SET json = excluded.json`).run(CHAVE_SETTINGS, JSON.stringify(dados));
  eventos.emit('estado');
}

function gerarChave(db) {
  const chave = `gbx_${crypto.randomBytes(24).toString('base64url')}`;
  gravar(db, { hash: sha256(chave), criadaEm: nowIso() });
  return chave;
}

function igual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Aceita a chave gerada no painel (hash no banco) ou a definida no servidor
// em EXTENSAO_CHAVE (útil na hospedagem: continua valendo mesmo se o banco for recriado).
function verificarChave(db, chave) {
  const hashRecebido = sha256(chave);
  const doServidor = process.env.EXTENSAO_CHAVE;
  if (doServidor && igual(hashRecebido, sha256(doServidor))) return true;
  const { hash } = ler(db);
  return Boolean(hash) && igual(hashRecebido, hash);
}

function info(db) {
  const { hash, criadaEm } = ler(db);
  const ultima = db.prepare(
    "SELECT finished_at FROM imports WHERE origin = 'extensao' ORDER BY id DESC LIMIT 1"
  ).get();
  return {
    configurada: Boolean(hash || process.env.EXTENSAO_CHAVE),
    criadaEm: criadaEm || null,
    ultimoEnvio: ultima ? ultima.finished_at : null
  };
}

// Uso local: se ainda não há chave, cria uma e grava em extensao-edge/config-local.json,
// que a extensão lê ao ser instalada. Assim ninguém precisa copiar e colar a chave.
// Esse arquivo fica só neste computador (está no .gitignore).
function prepararConfigLocal(db, { pastaExtensao, porta }) {
  const fs = require('node:fs');
  const path = require('node:path');
  if (!fs.existsSync(pastaExtensao)) return false;
  const arquivo = path.join(pastaExtensao, 'config-local.json');
  if (ler(db).hash && fs.existsSync(arquivo)) return false;
  const chave = gerarChave(db);
  fs.writeFileSync(arquivo, JSON.stringify({ servidor: `http://localhost:${porta}`, chave }, null, 2));
  return true;
}

module.exports = { gerarChave, verificarChave, info, prepararConfigLocal };
