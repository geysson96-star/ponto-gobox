'use strict';
// Abre o navegador do robô (Edge com perfil próprio) para você entrar nos portais.
// Faça login em cada aba e depois FECHE a janela do navegador.
const config = require('../src/config');
const { abrirParaLogin } = require('../src/robo/robo');

console.log('\nAbrindo o navegador do robô...');
console.log('1. Faça login em cada aba (Shopee e Mercado Livre).');
console.log('2. Confira se a lista de pacotes aparece.');
console.log('3. Feche a janela do navegador. Pronto: o robô usa essa sessão.\n');

abrirParaLogin(config)
  .then(() => { console.log('Navegador fechado. Sessão salva.'); process.exit(0); })
  .catch((e) => {
    console.error('\nNão foi possível abrir o Microsoft Edge:', e.message);
    console.error('Verifique se o Edge está instalado (ou defina ROBO_NAVEGADOR=chrome no .env).');
    process.exit(1);
  });
