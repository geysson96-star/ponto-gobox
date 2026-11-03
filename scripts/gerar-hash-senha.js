'use strict';
// Gera o hash bcrypt da senha do administrador para colocar em ADMIN_PASSWORD_HASH.
// Uso: npm run senha
// A senha é digitada no terminal sem aparecer na tela.
const readline = require('node:readline');
const bcrypt = require('bcryptjs');

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = (s) => { if (!muted) rl.output.write(s); };
    rl.question(question, (answer) => {
      rl.output.write('\n');
      rl.close();
      resolve(answer);
    });
    muted = true;
  });
}

(async () => {
  const s1 = await askHidden('Nova senha do administrador: ');
  const s2 = await askHidden('Repita a senha: ');
  if (s1 !== s2) { console.error('As senhas não conferem.'); process.exit(1); }
  if (s1.length < 10) { console.error('Use pelo menos 10 caracteres.'); process.exit(1); }
  const hash = bcrypt.hashSync(s1, 12);
  console.log('\nCopie a linha abaixo para o arquivo .env do servidor:\n');
  console.log(`ADMIN_PASSWORD_HASH='${hash}'`);
})();
