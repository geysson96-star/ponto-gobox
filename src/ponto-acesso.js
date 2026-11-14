'use strict';
// Acesso automático do Controle de ponto (e da Folha e notas fiscais) dentro do painel.
//
// Com a chave de serviço do Firebase (FIREBASE_CONTA_SERVICO), o servidor cria um
// "token personalizado" de curta duração para a conta de administrador do Ponto: o
// navegador entra sozinho e a senha nunca sai do servidor. Sem a chave, cai no modo
// antigo (e-mail e senha), para não quebrar nada até a chave ser configurada.

const crypto = require('node:crypto');

const AUD = 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit';

function criar({ config, fetchFn = fetch }) {
  let conta = null;
  if (config.FIREBASE_CONTA_SERVICO) {
    try {
      const c = JSON.parse(config.FIREBASE_CONTA_SERVICO);
      if (c.client_email && c.private_key) conta = { email: c.client_email, chave: c.private_key.replace(/\\n/g, '\n') };
    } catch { conta = null; }
  }
  let uid = null;

  async function uidDoAdmin() {
    if (uid) return uid;
    const r = await fetchFn(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${config.FIREBASE_API_KEY}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: config.PONTO_EMAIL, password: config.PONTO_SENHA, returnSecureToken: true })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.localId) throw new Error('login do Ponto recusado');
    uid = d.localId;
    return uid;
  }

  function tokenPersonalizado(id) {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const agora = Math.floor(Date.now() / 1000);
    const corpo = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: conta.email, sub: conta.email, aud: AUD, iat: agora, exp: agora + 3600, uid: id })}`;
    const assinatura = crypto.createSign('RSA-SHA256').update(corpo).sign(conta.chave).toString('base64url');
    return `${corpo}.${assinatura}`;
  }

  return {
    configurado: Boolean(config.PONTO_EMAIL && config.PONTO_SENHA),
    seguro: Boolean(conta && config.FIREBASE_API_KEY),
    async acesso() {
      if (conta && config.FIREBASE_API_KEY) return { token: tokenPersonalizado(await uidDoAdmin()) };
      return { email: config.PONTO_EMAIL, senha: config.PONTO_SENHA };
    }
  };
}

module.exports = { criar };
