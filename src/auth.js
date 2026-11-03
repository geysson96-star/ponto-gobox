'use strict';
// Autenticação do administrador. Usuário e hash da senha ficam em variáveis
// de ambiente do servidor; a senha em texto nunca é gravada. A sessão é um
// token aleatório em cookie HttpOnly; no banco fica só o hash do token.

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { nowIso } = require('./db');

const COOKIE = 'gobox_admin';

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

// Hash fixo usado quando o usuário não confere, para o tempo de resposta não revelar isso.
let dummyHash = null;
function getDummyHash() {
  if (!dummyHash) dummyHash = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 12);
  return dummyHash;
}

async function checkCredentials(config, user, password) {
  if (!config.ADMIN_USER || !config.ADMIN_PASSWORD_HASH) return false;
  const userOk = safeEqual(user || '', config.ADMIN_USER);
  const hash = userOk ? config.ADMIN_PASSWORD_HASH : getDummyHash();
  let passOk = false;
  try {
    passOk = await bcrypt.compare(String(password || ''), hash);
  } catch {
    passOk = false;
  }
  return userOk && passOk;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieAttrs(config, maxAgeSeconds) {
  const attrs = [`Path=/`, 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`];
  if (config.COOKIE_SECURE) attrs.push('Secure');
  return attrs.join('; ');
}

function createSession(db, config, res) {
  const token = crypto.randomBytes(32).toString('base64url');
  const created = nowIso();
  const expires = new Date(Date.now() + config.SESSION_HOURS * 3600 * 1000).toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(created);
  db.prepare('INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)').run(sha256(token), created, expires);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; ${cookieAttrs(config, config.SESSION_HOURS * 3600)}`);
}

function destroySession(db, config, req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieAttrs(config, 0)}`);
}

function isAuthenticated(db, req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return false;
  const row = db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(sha256(token));
  return Boolean(row && Date.parse(row.expires_at) > Date.now());
}

function requireAdmin(db) {
  return (req, res, next) => {
    if (isAuthenticated(db, req)) return next();
    res.status(401).json({ erro: 'Sessão expirada. Entre novamente.' });
  };
}

// Proteção extra contra CSRF: requisições que alteram dados precisam vir do próprio site.
function sameOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin) {
    try {
      if (new URL(origin).host === host) return next();
    } catch { /* origem inválida */ }
    return res.status(403).json({ erro: 'Origem não permitida.' });
  }
  if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') {
    return res.status(403).json({ erro: 'Origem não permitida.' });
  }
  return next();
}

module.exports = {
  checkCredentials, createSession, destroySession, isAuthenticated, requireAdmin, sameOrigin, COOKIE
};
