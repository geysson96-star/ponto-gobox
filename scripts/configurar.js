'use strict';
// Configuração rápida para TESTE LOCAL: cria/atualiza o .env com o usuário
// e o hash da senha do administrador. A senha não aparece na tela e não é
// gravada em texto, só o hash bcrypt.
// Uso: npm run configurar
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const bcrypt = require('bcryptjs');

const ENV = path.resolve(__dirname, '..', '.env');

function ask(question, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    if (hidden) rl._writeToOutput = (s) => { if (!muted) rl.output.write(s); };
    rl.question(question, (answer) => {
      if (hidden) rl.output.write('\n');
      rl.close();
      resolve(answer.trim());
    });
    muted = true;
  });
}

function setVar(text, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(text) ? text.replace(re, () => line) : `${text.trimEnd()}\n${line}\n`;
}

(async () => {
  let text = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : [
    '# Configuração LOCAL de teste. Não envie este arquivo para ninguém nem para o Git.',
    'NODE_ENV=development',
    'PORT=3000',
    'COOKIE_SECURE=false',
    'TRUST_PROXY=false',
    'DATA_DIR=data',
    'INBOX_INTERVAL_MINUTES=1',
    'PUBLIC_RATE_PER_MINUTE=20',
    '# Robô que lê os portais sozinho (Shopee e Mercado Livre)',
    'ROBO_ATIVO=false',
    'ROBO_INTERVALO_MINUTOS=10',
    'ROBO_FONTES=shopee,ml',
    '# Ponto da agência na Shopee (vazio = detecta automaticamente)',
    'SHOPEE_PONTO_ID=',
    ''
  ].join('\n');

  console.log('\n=== Acesso ao painel GoBox ===\n');
  let usuario = '';
  while (!usuario) usuario = await ask('Usuário do administrador (ex.: admin): ');
  let s1 = '';
  for (;;) {
    s1 = await ask('Senha (mínimo 10 caracteres, não aparece na tela): ', true);
    if (s1.length < 10) { console.log('Senha curta demais. Tente de novo.'); continue; }
    const s2 = await ask('Repita a senha: ', true);
    if (s1 !== s2) { console.log('As senhas não conferem. Tente de novo.'); continue; }
    break;
  }
  const hash = bcrypt.hashSync(s1, 12);
  // Garante as opções do robô também em um .env antigo.
  for (const [k, v] of [['ROBO_ATIVO', 'false'], ['ROBO_INTERVALO_MINUTOS', '10'], ['ROBO_FONTES', 'shopee,ml'], ['SHOPEE_PONTO_ID', '']]) {
    if (!new RegExp(`^${k}=`, 'm').test(text)) text = setVar(text, k, v);
  }
  text = setVar(text, 'ADMIN_USER', usuario);
  text = setVar(text, 'ADMIN_PASSWORD_HASH', `'${hash}'`);
  fs.writeFileSync(ENV, text, { encoding: 'utf8', mode: 0o600 });
  console.log('\nPronto! Acesso salvo no arquivo .env (só o hash da senha).\n');
})();
