'use strict';
// Ajustes do site público e do painel, ligados e desligados em "Integrações e ajustes".
// Fica na tabela "financeiro" (chave "site:ajustes"), salva no Firebase pela persistência.

const eventos = require('./eventos');

const CHAVE = 'site:ajustes';
const ABAS_MENU = ['inicio', 'pacotes', 'sacas', 'fretes', 'ponto', 'motoboys', 'financeiro', 'contabilidade', 'acessos'];

const PADRAO = {
  aviso: { ativo: false, texto: '' },
  horario: {
    ativo: true,
    linhas: ['Seg a sex · 8h às 18h', 'Sáb · 8h às 12h'],
    endereco: 'Av. José David dos Santos, 1455 · Tobias Barreto/SE',
    mapa: ''
  },
  whatsapp: { ativo: true, numero: '79999579897', mensagem: 'Olá, GoBox! Vim pelo site.' },
  abas: { frete: true, entregador: true },
  selos: true,
  manutencao: false,
  menuOculto: []
};

const texto = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const bool = (v, padrao) => (typeof v === 'boolean' ? v : padrao);

function garantir(db) { db.exec('CREATE TABLE IF NOT EXISTS financeiro (chave TEXT PRIMARY KEY, json TEXT NOT NULL)'); }

function ajustes(db) {
  garantir(db);
  const r = db.prepare('SELECT json FROM financeiro WHERE chave = ?').get(CHAVE);
  let s = {};
  if (r) { try { s = JSON.parse(r.json); } catch { s = {}; } }
  return {
    aviso: { ...PADRAO.aviso, ...(s.aviso || {}) },
    horario: { ...PADRAO.horario, ...(s.horario || {}) },
    whatsapp: { ...PADRAO.whatsapp, ...(s.whatsapp || {}) },
    abas: { ...PADRAO.abas, ...(s.abas || {}) },
    selos: bool(s.selos, PADRAO.selos),
    manutencao: bool(s.manutencao, PADRAO.manutencao),
    menuOculto: Array.isArray(s.menuOculto) ? s.menuOculto.filter((x) => ABAS_MENU.includes(x)) : []
  };
}

function salvar(db, corpo) {
  const a = ajustes(db);
  const c = corpo || {};
  if (c.aviso) a.aviso = { ativo: bool(c.aviso.ativo, a.aviso.ativo), texto: texto(c.aviso.texto ?? a.aviso.texto, 160) };
  if (c.horario) {
    a.horario = {
      ativo: bool(c.horario.ativo, a.horario.ativo),
      linhas: Array.isArray(c.horario.linhas) ? c.horario.linhas.map((l) => texto(l, 60)).filter(Boolean).slice(0, 4) : a.horario.linhas,
      endereco: texto(c.horario.endereco ?? a.horario.endereco, 120),
      mapa: /^https:\/\/[^\s"'<>]+$/.test(String(c.horario.mapa ?? a.horario.mapa)) ? String(c.horario.mapa ?? a.horario.mapa).slice(0, 300) : ''
    };
  }
  if (c.whatsapp) {
    const n = String(c.whatsapp.numero ?? a.whatsapp.numero).replace(/\D/g, '').slice(0, 13);
    a.whatsapp = { ativo: bool(c.whatsapp.ativo, a.whatsapp.ativo), numero: n, mensagem: texto(c.whatsapp.mensagem ?? a.whatsapp.mensagem, 120) };
  }
  if (c.abas) a.abas = { frete: bool(c.abas.frete, a.abas.frete), entregador: bool(c.abas.entregador, a.abas.entregador) };
  a.selos = bool(c.selos, a.selos);
  a.manutencao = bool(c.manutencao, a.manutencao);
  if (Array.isArray(c.menuOculto)) a.menuOculto = [...new Set(c.menuOculto.filter((x) => ABAS_MENU.includes(x)))];
  garantir(db);
  db.prepare(`INSERT INTO financeiro (chave, json) VALUES (?, ?)
              ON CONFLICT(chave) DO UPDATE SET json = excluded.json`).run(CHAVE, JSON.stringify(a));
  eventos.emit('estado');
  return a;
}

// O que a página pública precisa (sem nada do painel).
function publico(db) {
  const a = ajustes(db);
  const zap = a.whatsapp.ativo && a.whatsapp.numero.length >= 10
    ? { numero: a.whatsapp.numero.length <= 11 ? `55${a.whatsapp.numero}` : a.whatsapp.numero, mensagem: a.whatsapp.mensagem }
    : null;
  return {
    aviso: a.aviso.ativo && a.aviso.texto ? a.aviso.texto : null,
    horario: a.horario.ativo ? { linhas: a.horario.linhas, endereco: a.horario.endereco, mapa: a.horario.mapa || null } : null,
    whatsapp: zap,
    abas: a.abas,
    selos: a.selos,
    manutencao: a.manutencao
  };
}

module.exports = { ajustes, salvar, publico, ABAS_MENU };
