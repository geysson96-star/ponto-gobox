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

// Cópia dos dados no Firebase: restaura antes de atender e salva a cada mudança.
const persistencia = require('./persistencia').criar({ db, config });
app.locals.persistenciaAtiva = persistencia.ativo;
let server;
(async () => {
  if (persistencia.ativo) {
    const r = await Promise.race([
      persistencia.restaurar(),
      new Promise((ok) => setTimeout(() => ok({ erro: 'demorou mais de 25 s' }), 25_000))
    ]);
    if (r.erro) console.warn(`[persistência] não restaurei tudo: ${r.erro}`);
    else console.log(`[persistência] restaurado do Firebase: estado ${r.estado ? 'sim' : 'vazio'}, pacotes ${JSON.stringify(r.pacotes)}`);
    persistencia.ligar();
    // Só depois de restaurar com sucesso, para não sobrescrever as notas salvas no Firebase.
    if (!r.erro) console.log(`[contabilidade] notas de out/2026 registradas: ${require('./contabilidade').registrarNotasIniciais(db)}`);
  } else {
    console.log('[persistência] desligada (sem PONTO_EMAIL/PONTO_SENHA).');
    require('./contabilidade').registrarNotasIniciais(db);
  }
  server = app.listen(config.PORT, () => {
  console.log(`GoBox consulta rodando em http://localhost:${config.PORT}`);
  console.log(`Pasta de entrada: ${config.INBOX_DIR}`);
  if (robo) {
    console.log(`Robô ligado: ${config.ROBO_FONTES.join(', ')} a cada ${config.ROBO_INTERVALO_MINUTOS} min.`);
    robo.iniciar();
  } else {
    console.log('Robô desligado (ROBO_ATIVO=false).');
  }
  });
})();

async function shutdown() {
  if (robo) await robo.parar();
  await persistencia.esvaziar().catch(() => {});
  if (!server) process.exit(0);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Guarda o fechamento do mês atual e do anterior (para o relatório do ano), a cada 6 horas.
function fecharMeses() {
  try {
    const fin = require('./financeiro');
    const atual = fin.mesAtual();
    const [a, m] = atual.split('-').map(Number);
    const anterior = m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, '0')}`;
    for (const mes of [anterior, atual]) fin.registrarFechamento(db, fin.resumo(db, mes));
  } catch (e) { console.warn('[financeiro] não guardei o fechamento:', e.message); }
}
setTimeout(fecharMeses, 2 * 60_000).unref();
setInterval(fecharMeses, 6 * 3600_000).unref();

// Diagnóstico: avisa no log quando o servidor fica travado (atraso > 1,5 s).
let esperado = Date.now() + 1000;
setInterval(() => {
  const atraso = Date.now() - esperado;
  if (atraso > 1500) console.warn(`[lento] servidor travado por ${atraso} ms (memória ${Math.round(process.memoryUsage().rss / 1048576)} MB)`);
  esperado = Date.now() + 1000;
}, 1000).unref();
