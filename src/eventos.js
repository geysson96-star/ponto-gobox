'use strict';
// Avisos internos: quem grava dados avisa aqui, e a persistência salva no Firebase.
const { EventEmitter } = require('node:events');

const eventos = new EventEmitter();
eventos.setMaxListeners(20);

// 'pacotes' (fonte) quando os pacotes de uma empresa mudam;
// 'estado' quando financeiro, configurações ou sessões mudam.
module.exports = eventos;
