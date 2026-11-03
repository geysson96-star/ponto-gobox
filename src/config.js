'use strict';
// Configuração lida SOMENTE de variáveis de ambiente do servidor.
// Nada aqui é enviado ao navegador.
const path = require('node:path');
const fs = require('node:fs');

// Carrega um arquivo .env local (opcional) sem dependências externas.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

const ROOT = path.resolve(__dirname, '..');
loadDotEnv(path.join(ROOT, '.env'));

function int(name, def) {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : def;
}
function bool(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'sim', 'yes'].includes(String(v).toLowerCase());
}

const NODE_ENV = process.env.NODE_ENV || 'development';
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');

module.exports = {
  ROOT,
  NODE_ENV,
  PORT: int('PORT', 3000),
  DATA_DIR,
  DB_FILE: path.join(DATA_DIR, 'gobox.sqlite'),
  INBOX_DIR: path.resolve(ROOT, process.env.INBOX_DIR || path.join(DATA_DIR, 'entrada')),
  ADMIN_USER: process.env.ADMIN_USER || '',
  ADMIN_PASSWORD_HASH: process.env.ADMIN_PASSWORD_HASH || '',
  SESSION_HOURS: int('SESSION_HOURS', 12),
  COOKIE_SECURE: bool('COOKIE_SECURE', NODE_ENV === 'production'),
  TRUST_PROXY: bool('TRUST_PROXY', false),
  // Intervalo da verificação automática da pasta de entrada (minutos). 0 desliga.
  INBOX_INTERVAL_MINUTES: int('INBOX_INTERVAL_MINUTES', 5),
  // Limite de consultas públicas por IP por minuto.
  PUBLIC_RATE_PER_MINUTE: int('PUBLIC_RATE_PER_MINUTE', 20),
  MAX_UPLOAD_MB: int('MAX_UPLOAD_MB', 20),
  // Robô de sincronização com os portais (usa o Edge com perfil próprio).
  // Robô com navegador próprio (alternativa à extensão do Edge). Desligado por padrão.
  ROBO_ATIVO: bool('ROBO_ATIVO', false),
  ROBO_INTERVALO_MINUTOS: int('ROBO_INTERVALO_MINUTOS', 10),
  ROBO_FONTES: String(process.env.ROBO_FONTES || 'shopee,ml').split(',').map((s) => s.trim()).filter(Boolean),
  ROBO_VISIVEL: bool('ROBO_VISIVEL', false),
  ROBO_NAVEGADOR: process.env.ROBO_NAVEGADOR || 'msedge',
  // Ponto da agência na Shopee (vazio = detecta o único ponto que não é "Admin").
  SHOPEE_PONTO_ID: process.env.SHOPEE_PONTO_ID || '',
  ROBO_PERFIL_DIR: path.resolve(ROOT, process.env.ROBO_PERFIL_DIR || path.join(DATA_DIR, 'robo-perfil'))
};
