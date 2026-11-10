'use strict';
// Contador de acessos da página pública de consulta.
//
// Conta, por dia: visitas (página aberta), consultas feitas, consultas encontradas e
// pessoas diferentes (aproximado). Privacidade: nenhum IP, código consultado ou navegador
// é guardado. Para saber se a pessoa já foi contada hoje, fica só na memória um resumo
// (hash) do IP + navegador com um segredo aleatório que nunca é gravado; tudo isso é
// descartado na virada do dia (e se o servidor reiniciar).

const crypto = require('node:crypto');
const eventos = require('./eventos');

const FUSO = 'America/Bahia';
const DIAS_GUARDADOS = 400;
const AVISO_MS = 60_000; // salva a cópia no Firebase no máximo 1 vez por minuto

function hoje(agora = new Date()) {
  // en-CA dá AAAA-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(agora);
}

function preparar(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS acessos (
      dia TEXT PRIMARY KEY,
      visitas INTEGER NOT NULL DEFAULT 0,
      consultas INTEGER NOT NULL DEFAULT 0,
      encontrados INTEGER NOT NULL DEFAULT 0,
      visitantes INTEGER NOT NULL DEFAULT 0
    );
  `);
}

function criar(db) {
  preparar(db);
  let ultimoAviso = 0;
  let avisoPendente = null;
  function avisar() {
    const falta = ultimoAviso + AVISO_MS - Date.now();
    if (falta <= 0) { ultimoAviso = Date.now(); eventos.emit('estado'); return; }
    if (!avisoPendente) {
      avisoPendente = setTimeout(() => { avisoPendente = null; ultimoAviso = Date.now(); eventos.emit('estado'); }, falta);
      avisoPendente.unref?.();
    }
  }

  // Só na memória: segredo e resumos do dia.
  let segredo = crypto.randomBytes(24);
  let vistos = new Set();

  const garantirDia = db.prepare('INSERT OR IGNORE INTO acessos (dia) VALUES (?)');
  const somar = {
    visitas: db.prepare('UPDATE acessos SET visitas = visitas + 1 WHERE dia = ?'),
    consultas: db.prepare('UPDATE acessos SET consultas = consultas + 1 WHERE dia = ?'),
    encontrados: db.prepare('UPDATE acessos SET consultas = consultas + 1, encontrados = encontrados + 1 WHERE dia = ?'),
    visitantes: db.prepare('UPDATE acessos SET visitantes = visitantes + 1 WHERE dia = ?')
  };
  const limparDias = db.prepare('DELETE FROM acessos WHERE dia < ?');
  let diaLimpo = null;

  function marcarVisitante(dia, ip, navegador) {
    const resumo = crypto.createHmac('sha256', segredo)
      .update(`${dia}|${ip || ''}|${String(navegador || '').slice(0, 300)}`)
      .digest('hex').slice(0, 20);
    if (vistos.has(resumo) || vistos.size > 200_000) return;
    vistos.add(resumo);
    somar.visitantes.run(dia);
  }

  function limpar(dia) {
    if (diaLimpo === dia) return;
    diaLimpo = dia;
    segredo = crypto.randomBytes(24);
    vistos = new Set();
    const corte = hoje(new Date(Date.now() - DIAS_GUARDADOS * 86400_000));
    limparDias.run(corte);
  }

  return {
    // Página pública aberta.
    visita({ ip, navegador }) {
      const dia = hoje();
      db.transaction(() => {
        limpar(dia);
        garantirDia.run(dia);
        somar.visitas.run(dia);
        marcarVisitante(dia, ip, navegador);
      })();
      avisar();
    },
    // Consulta feita (com ou sem pacote encontrado).
    consulta({ encontrado, ip, navegador }) {
      const dia = hoje();
      db.transaction(() => {
        limpar(dia);
        garantirDia.run(dia);
        (encontrado ? somar.encontrados : somar.consultas).run(dia);
        marcarVisitante(dia, ip, navegador);
      })();
      avisar();
    },
    resumo({ dias = 30 } = {}) {
      const d = hoje();
      const desde = (n) => hoje(new Date(Date.now() - (n - 1) * 86400_000));
      const soma = (de) => db.prepare(
        `SELECT COALESCE(SUM(visitas),0) AS visitas, COALESCE(SUM(consultas),0) AS consultas,
                COALESCE(SUM(encontrados),0) AS encontrados, COALESCE(SUM(visitantes),0) AS visitantes
         FROM acessos WHERE dia >= ?`).get(de);
      const lista = db.prepare('SELECT dia, visitas, consultas, encontrados, visitantes FROM acessos WHERE dia >= ? ORDER BY dia DESC')
        .all(desde(dias));
      const primeiro = db.prepare('SELECT MIN(dia) AS dia FROM acessos').get().dia || null;
      return {
        hoje: soma(d),
        semana: soma(desde(7)),
        mes: soma(desde(30)),
        total: soma('0000-00-00'),
        desde: primeiro,
        dias: lista
      };
    }
  };
}

module.exports = { criar, preparar, hoje };
