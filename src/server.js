'use strict';
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const config = require('./config');

// Registro do servidor em data/servidor.log (além da janela), sem senhas nem dados de clientes.
(function registrarEmArquivo() {
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  const arquivo = path.join(config.DATA_DIR, 'servidor.log');
  try {
    if (fs.existsSync(arquivo) && fs.statSync(arquivo).size > 2 * 1024 * 1024) fs.writeFileSync(arquivo, '');
  } catch { /* segue sem rotação */ }
  for (const nivel of ['log', 'warn', 'error']) {
    const original = console[nivel].bind(console);
    console[nivel] = (...args) => {
      original(...args);
      try {
        fs.appendFileSync(arquivo, `${new Date().toISOString()} [${nivel}] ${util.format(...args)}\n`);
      } catch { /* ignora */ }
    };
  }
}());
const { openDb } = require('./db');
const { createApp } = require('./app');
const { startScheduler } = require('./inbox');

const db = openDb(config.DB_FILE);

let robo = null;
if (config.ROBO_ATIVO) {
  const { Robo } = require('./robo/robo');
  robo = new Robo({ db, config });
}

const app = createApp({ config, db, robo });

if (!config.ADMIN_USER || !config.ADMIN_PASSWORD_HASH) {
  console.warn('[aviso] ADMIN_USER e ADMIN_PASSWORD_HASH não configurados: o painel ficará bloqueado.');
}

startScheduler(db, config.INBOX_DIR, config.INBOX_INTERVAL_MINUTES);

if (config.NODE_ENV !== 'production') {
  try {
    const criada = require('./extensao').prepararConfigLocal(db, {
      pastaExtensao: path.join(config.ROOT, 'extensao-edge'), porta: config.PORT
    });
    if (criada) console.log('Chave da extensão do Edge criada e gravada em extensao-edge/config-local.json.');
  } catch (e) {
    console.warn('[extensão] não consegui preparar a configuração local:', e.message);
  }
}

const server = app.listen(config.PORT, () => {
  console.log(`GoBox consulta rodando em http://localhost:${config.PORT}`);
  console.log(`Pasta de entrada: ${config.INBOX_DIR}`);
  if (robo) {
    console.log(`Robô ligado: ${config.ROBO_FONTES.join(', ')} a cada ${config.ROBO_INTERVALO_MINUTOS} min.`);
    robo.iniciar();
  } else {
    console.log('Robô desligado (ROBO_ATIVO=false).');
  }
});

async function shutdown() {
  if (robo) await robo.parar();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
