'use strict';
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');

const { SOURCES, SOURCE_IDS, isSource } = require('./sources');
const { normalizeCode, isAcceptableQuery } = require('./normalize');
const { getSettings, saveSettings, allSourceStatus } = require('./db');
const {
  prepareImport, prepareFromCodes, recordFailure, applyImport, cancelImport, needsConfirmation, ImportError
} = require('./importer');
const extensao = require('./extensao');
const { processAll } = require('./inbox');
const auth = require('./auth');
const financeiro = require('./financeiro');

function createApp({ config, db, robo = null }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.TRUST_PROXY) app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'script-src': ["'self'"],
        'style-src': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"]
      }
    },
    strictTransportSecurity: config.COOKIE_SECURE ? undefined : false
  }));
  const jsonPequeno = express.json({ limit: '4kb' });
  app.use((req, res, next) => (req.path.startsWith('/api/extensao/') ? next() : jsonPequeno(req, res, next)));

  const publicDir = path.join(config.ROOT, 'public');

  // ---------------- Extensão do Edge ----------------
  // A extensão roda no navegador do administrador, lê as listas dos portais
  // abertos (com a sessão dele) e envia SÓ os códigos para cá, com uma chave.
  const extensaoLimiter = rateLimit({
    windowMs: 60_000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ erro: 'Muitas sincronizações seguidas.' })
  });
  const exigirChaveExtensao = (req, res, next) => {
    const h = String(req.headers.authorization || '');
    const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    if (!token || !extensao.verificarChave(db, token)) {
      return res.status(401).json({ erro: 'Chave da extensão inválida. Gere uma nova no painel (Configurações).' });
    }
    res.set('Cache-Control', 'no-store');
    return next();
  };

  app.get('/api/extensao/status', extensaoLimiter, exigirChaveExtensao, (req, res) => {
    res.json({ ok: true, fontes: allSourceStatus(db).map((f) => ({ id: f.id, nome: f.name, situacao: f.state, ultima: f.lastSuccessAt })) });
  });

  // Registro simples dos envios da extensão (sem dados de clientes), para diagnóstico.
  app.use('/api/extensao/', (req, res, next) => {
    res.on('finish', () => {
      const tam = req.headers['content-length'] || 0;
      console.log(`[extensão] ${req.method} ${req.path} -> ${res.statusCode} (${tam} bytes)`);
    });
    next();
  });

  app.post('/api/extensao/sincronizar', extensaoLimiter, exigirChaveExtensao,
    express.json({ limit: '8mb' }), (req, res) => {
      const b = req.body || {};
      const fonte = String(b.fonte || '');
      if (!isSource(fonte)) return res.status(400).json({ erro: 'Empresa desconhecida.' });
      if (b.erro) {
        // A extensão avisa quando não conseguiu ler (ex.: sessão expirada no portal).
        recordFailure(db, { sourceId: fonte, origin: 'extensao', label: 'extensão do Edge', message: String(b.erro).slice(0, 200) });
        return res.json({ situacao: 'falhou' });
      }
      // Formato novo: `pacotes` [{codigo, situacao, rotulo, tipo, recebidoEm, saidaEm}] + `modo`.
      // Formato antigo: `codigos` [string] (só presença, modo estoque).
      const lista = Array.isArray(b.pacotes) ? b.pacotes : (Array.isArray(b.codigos) ? b.codigos : null);
      if (!lista || lista.length > 50_000) {
        return res.status(400).json({ erro: 'Lista de códigos inválida.' });
      }
      const codigos = new Map();
      for (const item of lista) {
        const bruto = item && typeof item === 'object' ? item.codigo : item;
        const n = normalizeCode(typeof bruto === 'string' || typeof bruto === 'number' ? bruto : '');
        if (!n || !isAcceptableQuery(n)) continue;
        if (item && typeof item === 'object') {
          codigos.set(n, {
            situacao: item.situacao, rotulo: item.rotulo, tipo: item.tipo,
            recebidoEm: item.recebidoEm, saidaEm: item.saidaEm,
            idFonte: typeof item.idFonte === 'string' && item.idFonte.length <= 64 ? item.idFonte : null
          });
        } else {
          codigos.set(n, null);
        }
      }
      const modo = b.modo === 'eventos' ? 'eventos' : 'estoque';
      const prep = prepareFromCodes(db, { sourceId: fonte, codes: codigos, origin: 'extensao', label: 'extensão do Edge', modo });
      if (needsConfirmation(prep)) {
        return res.json({ situacao: 'aguardando_confirmacao', codigos: codigos.size, removidos: prep.toDeactivate });
      }
      applyImport(db, prep.importId);
      return res.json({ situacao: 'sucesso', codigos: codigos.size, novos: prep.toInsert, removidos: prep.toDeactivate });
    });

  // Verificação de funcionamento (usada pela hospedagem e pelo "manter acordado").
  app.get('/saude', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ ok: true }); });

  // Horário da última atualização bem-sucedida (qualquer empresa), para a página pública.
  const ultimaStmt = db.prepare("SELECT MAX(finished_at) AS em FROM imports WHERE status = 'sucesso'");
  app.get('/api/atualizacao', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ultimaAtualizacao: ultimaStmt.get().em || null });
  });

  // ---------------- Consulta pública ----------------
  const publicLimiter = rateLimit({
    windowMs: 60_000,
    limit: config.PUBLIC_RATE_PER_MINUTE,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ erro: 'Muitas consultas seguidas. Aguarde um minuto e tente de novo.' })
  });

  // O mesmo código pode aparecer em mais de uma lista; vale o registro mais recente.
  const findStmt = db.prepare(
    `SELECT situacao, rotulo, tipo, recebido_em, saida_em, first_seen_at, active
     FROM packages WHERE code = ? ORDER BY active DESC, last_updated_at DESC LIMIT 1`
  );

  app.post('/api/consulta', publicLimiter, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const raw = req.body && typeof req.body.codigo === 'string' ? req.body.codigo : '';
    const code = normalizeCode(raw);
    if (!code) return res.status(400).json({ erro: 'Digite um código para consultar.' });
    // Correspondência exata após a normalização. Só a situação do próprio pacote é
    // devolvida: nenhum nome, telefone, endereço, empresa ou outro código.
    const p = isAcceptableQuery(code) ? findStmt.get(code) : null;
    if (!p) return res.json({ encontrado: false });
    const situacao = p.situacao || (p.active ? 'na_agencia' : 'saiu');
    return res.json({
      encontrado: true,
      situacao,
      status: p.rotulo || null,
      tipo: p.tipo === 'retirada' ? 'retirada' : (p.tipo ? 'envio' : null),
      recebidoEm: p.recebido_em || p.first_seen_at || null,
      saidaEm: situacao === 'na_agencia' ? null : (p.saida_em || null)
    });
  });

  // Situação pública das fontes (só nome, estado e hora da última atualização),
  // mostrada abaixo da busca na página de consulta.
  app.get('/api/status', publicLimiter, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      fontes: allSourceStatus(db).map((f) => ({ id: f.id, nome: f.name, situacao: f.state, ultima: f.lastSuccessAt }))
    });
  });

  // ---------------- Área administrativa ----------------
  const admin = express.Router();
  admin.use(auth.sameOrigin);
  admin.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  const loginLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ erro: 'Muitas tentativas de login. Aguarde 15 minutos.' })
  });

  admin.post('/login', loginLimiter, async (req, res) => {
    const { usuario, senha } = req.body || {};
    if (!config.ADMIN_USER || !config.ADMIN_PASSWORD_HASH) {
      return res.status(503).json({ erro: 'Acesso administrativo não configurado no servidor.' });
    }
    const ok = await auth.checkCredentials(config, usuario, senha);
    if (!ok) return res.status(401).json({ erro: 'Usuário ou senha incorretos.' });
    auth.createSession(db, config, res);
    return res.json({ ok: true });
  });

  admin.post('/logout', (req, res) => {
    auth.destroySession(db, config, req, res);
    res.json({ ok: true });
  });

  admin.get('/me', (req, res) => res.json({ autenticado: auth.isAuthenticated(db, req) }));

  const requireAdmin = auth.requireAdmin(db);

  // ---------- Financeiro ----------
  admin.get('/financeiro', requireAdmin, (req, res) => {
    try { res.json(financeiro.resumo(db, req.query.mes ? String(req.query.mes) : undefined)); }
    catch (e) { res.status(400).json({ erro: e.message }); }
  });
  admin.put('/financeiro/:mes/ajustes', requireAdmin, (req, res) => {
    try {
      financeiro.resumo(db, req.params.mes); // valida o mês
      financeiro.salvarAjustes(db, req.params.mes, req.body || {});
      res.json(financeiro.resumo(db, req.params.mes));
    } catch (e) { res.status(400).json({ erro: e.message }); }
  });
  admin.put('/financeiro/:mes/medalha', requireAdmin, (req, res) => {
    try {
      financeiro.resumo(db, req.params.mes);
      financeiro.salvarMedalha(db, req.params.mes, req.body || {});
      res.json(financeiro.resumo(db, req.params.mes));
    } catch (e) { res.status(400).json({ erro: e.message }); }
  });

  admin.get('/fontes', requireAdmin, (req, res) => {
    res.json({ fontes: allSourceStatus(db), agora: new Date().toISOString() });
  });

  admin.get('/pacotes', requireAdmin, (req, res) => {
    const pageSize = 50;
    const page = Math.max(1, parseInt(req.query.pagina, 10) || 1);
    const where = [];
    const args = [];
    const fonte = String(req.query.fonte || '');
    if (fonte && isSource(fonte)) { where.push('source = ?'); args.push(fonte); }
    const situacao = String(req.query.situacao || 'ativos');
    if (situacao === 'ativos') where.push("COALESCE(situacao, CASE WHEN active = 1 THEN 'na_agencia' ELSE 'saiu' END) = 'na_agencia'");
    else if (situacao === 'inativos') where.push("COALESCE(situacao, CASE WHEN active = 1 THEN 'na_agencia' ELSE 'saiu' END) <> 'na_agencia'");
    const q = normalizeCode(String(req.query.busca || '')).slice(0, 64);
    if (q) {
      where.push("code LIKE ? ESCAPE '\\'");
      args.push(`%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM packages ${w}`).get(...args).n;
    const items = db.prepare(
      `SELECT source, code, external_id, active, first_seen_at, last_updated_at,
              situacao, rotulo, tipo, recebido_em, saida_em FROM packages ${w}
       ORDER BY last_updated_at DESC, id DESC LIMIT ? OFFSET ?`
    ).all(...args, pageSize, (page - 1) * pageSize).map((r) => ({
      fonte: r.source,
      fonteNome: SOURCES[r.source] ? SOURCES[r.source].name : r.source,
      codigo: r.code,
      idFonte: r.external_id,
      ativo: Boolean(r.active),
      primeiraImportacao: r.first_seen_at,
      ultimaAtualizacao: r.last_updated_at,
      situacao: r.situacao || (r.active ? 'na_agencia' : 'saiu'),
      status: r.rotulo,
      tipo: r.tipo,
      recebidoEm: r.recebido_em,
      saidaEm: r.saida_em
    }));
    res.json({ itens: items, total, pagina: page, paginas: Math.max(1, Math.ceil(total / pageSize)) });
  });

  admin.get('/importacoes', requireAdmin, (req, res) => {
    const fonte = String(req.query.fonte || '');
    const rows = fonte && isSource(fonte)
      ? db.prepare('SELECT * FROM imports WHERE source = ? ORDER BY id DESC LIMIT 100').all(fonte)
      : db.prepare('SELECT * FROM imports ORDER BY id DESC LIMIT 100').all();
    res.json({ importacoes: rows.map(formatImport) });
  });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => cb(null, /\.(csv|tsv|txt|xlsx)$/i.test(file.originalname))
  });

  admin.post('/importacoes', requireAdmin, (req, res, next) => {
    upload.single('arquivo')(req, res, (err) => {
      if (err) {
        const msg = err.code === 'LIMIT_FILE_SIZE'
          ? `Arquivo maior que ${config.MAX_UPLOAD_MB} MB.`
          : 'Não foi possível receber o arquivo.';
        return res.status(400).json({ erro: msg });
      }
      return next();
    });
  }, async (req, res) => {
    const fonte = String((req.body && req.body.fonte) || '');
    if (!isSource(fonte)) return res.status(400).json({ erro: 'Escolha a empresa do relatório.' });
    if (!req.file) return res.status(400).json({ erro: 'Envie um arquivo .csv ou .xlsx.' });
    const prepared = await prepareImport(db, {
      sourceId: fonte, buffer: req.file.buffer, filename: req.file.originalname, origin: 'upload'
    });
    const imp = db.prepare('SELECT * FROM imports WHERE id = ?').get(prepared.importId);
    res.status(prepared.failed ? 422 : 200).json({ importacao: formatImport(imp), detalhe: prepared.detail || null });
  });

  admin.post('/importacoes/:id/confirmar', requireAdmin, (req, res) => {
    try {
      const imp = applyImport(db, Number(req.params.id));
      res.json({ importacao: formatImport(imp) });
    } catch (e) {
      if (e instanceof ImportError) return res.status(409).json({ erro: e.message });
      throw e;
    }
  });

  admin.post('/importacoes/:id/cancelar', requireAdmin, (req, res) => {
    try {
      cancelImport(db, Number(req.params.id));
      res.json({ ok: true });
    } catch (e) {
      if (e instanceof ImportError) return res.status(409).json({ erro: e.message });
      throw e;
    }
  });

  admin.post('/entrada/verificar', requireAdmin, async (req, res) => {
    const resultado = await processAll(db, config.INBOX_DIR);
    res.json({ resultado });
  });

  admin.get('/extensao', requireAdmin, (req, res) => {
    res.json(extensao.info(db));
  });

  admin.post('/extensao/chave', requireAdmin, (req, res) => {
    // A chave aparece uma única vez; no banco fica só o hash.
    res.json({ chave: extensao.gerarChave(db) });
  });

  admin.get('/robo', requireAdmin, (req, res) => {
    res.json({
      ativo: Boolean(robo),
      fontes: robo ? config.ROBO_FONTES : [],
      intervaloMinutos: config.ROBO_INTERVALO_MINUTOS,
      rodando: Boolean(robo && robo.rodando),
      ultimo: robo ? robo.ultimoResultado : null
    });
  });

  admin.post('/robo/sincronizar', requireAdmin, async (req, res) => {
    if (!robo) return res.status(409).json({ erro: 'O robô está desligado no servidor (ROBO_ATIVO=false).' });
    const r = await robo.sincronizarTudo();
    if (r.ignorado) return res.status(409).json({ erro: r.motivo });
    res.json(r);
  });

  admin.get('/configuracoes', requireAdmin, (req, res) => {
    res.json({
      fontes: SOURCE_IDS.map((s) => ({ id: s, nome: SOURCES[s].name, ...getSettings(db, s) })),
      intervaloEntradaMinutos: config.INBOX_INTERVAL_MINUTES
    });
  });

  admin.put('/configuracoes/:fonte', requireAdmin, (req, res) => {
    const fonte = req.params.fonte;
    if (!isSource(fonte)) return res.status(404).json({ erro: 'Empresa desconhecida.' });
    const b = req.body || {};
    const patch = {};
    if (typeof b.codeColumn === 'string') patch.codeColumn = b.codeColumn.trim().slice(0, 100);
    if (typeof b.idColumn === 'string') patch.idColumn = b.idColumn.trim().slice(0, 100);
    if (b.mode === 'snapshot' || b.mode === 'incremental') patch.mode = b.mode;
    const sh = Number(b.staleHours);
    if (Number.isFinite(sh) && sh >= 1 && sh <= 24 * 30) patch.staleHours = Math.round(sh);
    const mp = Number(b.maxDeactivatePercent);
    if (Number.isFinite(mp) && mp >= 0 && mp <= 100) patch.maxDeactivatePercent = Math.round(mp);
    res.json({ fonte: { id: fonte, nome: SOURCES[fonte].name, ...saveSettings(db, fonte, patch) } });
  });

  app.use('/admin/api', admin);

  // Arquivos estáticos (página pública e painel).
  app.use(express.static(publicDir, { index: 'index.html', extensions: ['html'] }));

  app.use((req, res) => res.status(404).type('text').send('Página não encontrada.'));

  // Erros: detalhe só no log do servidor, nunca na resposta.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[erro]', err && err.stack ? err.stack : err);
    if (res.headersSent) return;
    res.status(500).json({ erro: 'Erro interno. Tente novamente.' });
  });

  return app;
}

function formatImport(r) {
  if (!r) return null;
  return {
    id: r.id,
    fonte: r.source,
    fonteNome: SOURCES[r.source] ? SOURCES[r.source].name : r.source,
    origem: r.origin,
    arquivo: r.file_label,
    situacao: r.status,
    inicio: r.started_at,
    fim: r.finished_at,
    linhasLidas: r.rows_read,
    codigosValidos: r.codes_valid,
    novos: r.to_insert,
    atualizados: r.to_update,
    removidos: r.to_deactivate,
    colunaCodigo: r.code_column,
    erro: r.error_message
  };
}

module.exports = { createApp };
