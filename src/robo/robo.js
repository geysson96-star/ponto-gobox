'use strict';
// Robô de sincronização. Usa o Microsoft Edge instalado no Windows com um
// PERFIL PRÓPRIO (pasta data/robo-perfil). Você faz login uma vez nesse perfil
// (npm run robo:login); o robô reaproveita a sessão para ler as listas dos
// portais a cada X minutos. Nenhuma senha é lida, digitada ou guardada pelo
// sistema: só os cookies de sessão que o próprio navegador mantém nesse perfil.

const path = require('node:path');
const fs = require('node:fs');
const { CONECTORES, SessaoExpirada, RespostaInesperada } = require('./conectores');
const { prepareFromCodes, recordFailure, applyImport, needsConfirmation } = require('../importer');

let playwright = null;
function carregarPlaywright() {
  if (!playwright) playwright = require('playwright-core');
  return playwright;
}

function opcoesNavegador(config, visivel) {
  return {
    channel: config.ROBO_NAVEGADOR || 'msedge',
    headless: !visivel,
    viewport: { width: 1280, height: 900 },
    args: ['--no-first-run', '--no-default-browser-check']
  };
}

async function abrirContexto(config, visivel) {
  const pw = carregarPlaywright();
  fs.mkdirSync(config.ROBO_PERFIL_DIR, { recursive: true });
  return pw.chromium.launchPersistentContext(config.ROBO_PERFIL_DIR, opcoesNavegador(config, visivel));
}

// Faz a requisição dentro da página logada e devolve o JSON.
async function buscarJsonNaPagina(page, url, opcoes = {}) {
  const r = await page.evaluate(async ({ u, metodo, corpo }) => {
    try {
      const init = { method: metodo, credentials: 'include', headers: { Accept: 'application/json' } };
      if (corpo !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(corpo);
      }
      const resp = await fetch(u, init);
      const texto = await resp.text();
      return { status: resp.status, url: resp.url, texto };
    } catch (e) {
      return { erroRede: String(e && e.message ? e.message : e) };
    }
  }, { u: url, metodo: opcoes.method || 'GET', corpo: opcoes.body });
  if (r.erroRede) throw new RespostaInesperada('Falha de rede ao acessar o portal.');
  if (r.status === 401 || r.status === 403) throw new SessaoExpirada('Sessão expirada. Faça login de novo.');
  if (r.status >= 500) throw new RespostaInesperada(`O portal está com instabilidade (HTTP ${r.status}).`);
  try {
    return JSON.parse(r.texto);
  } catch {
    // Página de login em vez de dados.
    throw new SessaoExpirada('Sessão expirada. Faça login de novo.');
  }
}

function mesmaOrigem(urlAtual, origem) {
  try {
    // Host exato: a página de login costuma ficar em outro subdomínio.
    return new URL(urlAtual).host === new URL(origem).host;
  } catch {
    return false;
  }
}

class Robo {
  constructor({ db, config, conectores = CONECTORES, log = console }) {
    this.db = db;
    this.config = config;
    this.conectores = conectores;
    this.log = log;
    this.contexto = null;
    this.paginas = new Map();
    this.rodando = false;
    this.ultimoResultado = null;
  }

  async garantirContexto() {
    if (this.contexto) return this.contexto;
    this.contexto = await abrirContexto(this.config, this.config.ROBO_VISIVEL);
    this.contexto.on('close', () => { this.contexto = null; this.paginas.clear(); });
    return this.contexto;
  }

  async paginaDe(conector) {
    const ctx = await this.garantirContexto();
    let page = this.paginas.get(conector.id);
    if (!page || page.isClosed()) {
      page = await ctx.newPage();
      this.paginas.set(conector.id, page);
    }
    // Recarrega a página do portal a cada ciclo para manter a sessão viva.
    await page.goto(conector.paginaInicial, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(1500);
    if (!mesmaOrigem(page.url(), conector.origem)) {
      throw new SessaoExpirada('Sessão expirada: o portal pediu login. Rode "entrar-nos-portais.bat".');
    }
    return page;
  }

  async sincronizarFonte(id) {
    const conector = this.conectores[id];
    const rotulo = 'robô (portal)';
    try {
      const page = await this.paginaDe(conector);
      const codigos = await conector.ler((url, opcoes) => buscarJsonNaPagina(page, url, opcoes), this.config);
      // Se a lista vier muito menor que a atual (ex.: falha silenciosa do portal),
      // a importação fica aguardando sua confirmação no painel em vez de apagar a consulta.
      const prep = prepareFromCodes(this.db, { sourceId: id, codes: codigos, origin: 'robo', label: rotulo });
      if (needsConfirmation(prep)) {
        return { fonte: id, situacao: 'aguardando_confirmacao', importId: prep.importId, codigos: codigos.size };
      }
      applyImport(this.db, prep.importId);
      return { fonte: id, situacao: 'sucesso', importId: prep.importId, codigos: codigos.size };
    } catch (err) {
      const msg = err instanceof SessaoExpirada || err instanceof RespostaInesperada
        ? err.message
        : 'Erro inesperado no robô. Veja o registro do servidor.';
      if (!(err instanceof SessaoExpirada || err instanceof RespostaInesperada)) {
        this.log.error(`[robô:${id}]`, err && err.stack ? err.stack : err);
      } else {
        this.log.warn(`[robô:${id}] ${msg}`);
      }
      recordFailure(this.db, { sourceId: id, origin: 'robo', label: rotulo, message: msg });
      return { fonte: id, situacao: 'falhou', erro: msg };
    }
  }

  async sincronizarTudo() {
    if (this.rodando) return { ignorado: true, motivo: 'Uma sincronização já está em andamento.' };
    this.rodando = true;
    try {
      const resultados = [];
      // Uma de cada vez (menos carga nos portais); falha numa não para a outra.
      for (const id of this.config.ROBO_FONTES) {
        if (!this.conectores[id]) continue;
        resultados.push(await this.sincronizarFonte(id));
      }
      this.ultimoResultado = { em: new Date().toISOString(), resultados };
      // Fecha o navegador entre um ciclo e outro: a sessão fica salva no perfil
      // e o perfil fica livre para você abrir o "entrar-nos-portais" se precisar.
      await this.fecharNavegador();
      return this.ultimoResultado;
    } catch (err) {
      this.log.error('[robô]', err && err.message ? err.message : err);
      await this.fecharNavegador();
      // Se o navegador não abriu (ex.: Edge não encontrado, ou a janela de login
      // do robô está aberta usando o mesmo perfil), registra em todas as fontes.
      const msg = 'O robô não conseguiu abrir o navegador. Se a janela "entrar nos portais" estiver aberta, feche-a.';
      for (const id of this.config.ROBO_FONTES) recordFailure(this.db, { sourceId: id, origin: 'robo', label: 'robô (portal)', message: msg });
      return { erro: msg };
    } finally {
      this.rodando = false;
    }
  }

  iniciar() {
    const minutos = this.config.ROBO_INTERVALO_MINUTOS;
    const ciclo = () => this.sincronizarTudo().then((r) => {
      if (r && r.resultados) {
        const resumo = r.resultados.map((x) => `${x.fonte}: ${x.situacao}${x.codigos !== undefined ? ` (${x.codigos})` : ''}`).join(' | ');
        this.log.log(`[robô] ${new Date().toLocaleTimeString('pt-BR')} ${resumo}`);
      }
    }).catch((e) => this.log.error('[robô]', e));
    setTimeout(ciclo, 10_000).unref();
    this.timer = setInterval(ciclo, Math.max(2, minutos) * 60_000);
    this.timer.unref();
  }

  async fecharNavegador() {
    const ctx = this.contexto;
    this.contexto = null;
    this.paginas.clear();
    if (ctx) await ctx.close().catch(() => {});
  }

  async parar() {
    clearInterval(this.timer);
    await this.fecharNavegador();
  }
}

// Modo login: abre o Edge do robô VISÍVEL com os portais, para você entrar.
async function abrirParaLogin(config) {
  const ctx = await abrirContexto(config, true);
  const fontes = config.ROBO_FONTES.filter((id) => CONECTORES[id]);
  const [primeira] = ctx.pages();
  for (let i = 0; i < fontes.length; i += 1) {
    const page = i === 0 && primeira ? primeira : await ctx.newPage();
    await page.goto(CONECTORES[fontes[i]].paginaInicial).catch(() => {});
  }
  await new Promise((resolve) => ctx.on('close', resolve));
}

module.exports = { Robo, abrirParaLogin, buscarJsonNaPagina };
