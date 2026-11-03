'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');

const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { processAll, ensureInboxDirs } = require('../src/inbox');
const { normalizeCode } = require('../src/normalize');

// Valores de TESTE apenas.
const SENHA_TESTE = 'senha-de-teste-123';
let server; let base; let db; let inbox; let cookie = '';
let config;

before(async () => {
  inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gobox-entrada-'));
  ensureInboxDirs(inbox);
  db = openDb(':memory:');
  config = {
    ROOT: path.resolve(__dirname, '..'),
    ADMIN_USER: 'admin-teste',
    ADMIN_PASSWORD_HASH: bcrypt.hashSync(SENHA_TESTE, 4),
    SESSION_HOURS: 1,
    COOKIE_SECURE: false,
    TRUST_PROXY: false,
    INBOX_DIR: inbox,
    INBOX_INTERVAL_MINUTES: 0,
    PUBLIC_RATE_PER_MINUTE: 1000,
    MAX_UPLOAD_MB: 5
  };
  const app = createApp({ config, db });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  db.close();
  fs.rmSync(inbox, { recursive: true, force: true });
});

async function req(method, p, { body, form, headers = {} } = {}) {
  const h = { Origin: base, ...headers };
  if (cookie) h.Cookie = cookie;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(base + p, { method, headers: h, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* não é json */ }
  return { res, json, text };
}

async function consultar(codigo) {
  const { res, json } = await req('POST', '/api/consulta', { body: { codigo } });
  return { status: res.status, json };
}

function arquivo(nome, conteudo) {
  const fd = new FormData();
  fd.append('arquivo', new Blob([conteudo]), nome);
  return fd;
}

async function importarPeloPainel(fonte, nome, conteudo) {
  const fd = arquivo(nome, conteudo);
  fd.append('fonte', fonte);
  const prep = await req('POST', '/admin/api/importacoes', { form: fd });
  return prep;
}

test('normalização: tira espaços das pontas, maiúsculas, mantém o resto', () => {
  assert.equal(normalizeCode('  xx123456789br  '), 'XX123456789BR');
  assert.equal(normalizeCode('​AB-12.3/4'), 'AB-12.3/4');
  assert.equal(normalizeCode('AB 12'), 'AB 12');
  assert.equal(normalizeCode(46123456789), '46123456789');
});

test('painel exige login e recusa senha errada', async () => {
  let r = await req('GET', '/admin/api/pacotes');
  assert.equal(r.res.status, 401);
  r = await req('POST', '/admin/api/login', { body: { usuario: 'admin-teste', senha: 'errada' } });
  assert.equal(r.res.status, 401);
  r = await req('POST', '/admin/api/login', { body: { usuario: 'outro', senha: SENHA_TESTE } });
  assert.equal(r.res.status, 401);
});

test('login bloqueia origem externa (CSRF)', async () => {
  const r = await req('POST', '/admin/api/login', {
    body: { usuario: 'admin-teste', senha: SENHA_TESTE }, headers: { Origin: 'https://site-malicioso.example' }
  });
  assert.equal(r.res.status, 403);
});

test('login correto cria cookie HttpOnly e SameSite', async () => {
  const r = await req('POST', '/admin/api/login', { body: { usuario: 'admin-teste', senha: SENHA_TESTE } });
  assert.equal(r.res.status, 200);
  const sc = r.res.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  cookie = sc.split(';')[0];
});

test('upload gera prévia e só altera a consulta depois de confirmado', async () => {
  const csv = 'Nome Cliente;Telefone;Tracking Number\nFulano Teste;0000-0000;BR111111111\nCiclano Teste;0000-0001;BR222222222\n';
  const prep = await importarPeloPainel('shopee', 'spx.csv', csv);
  assert.equal(prep.res.status, 200);
  const imp = prep.json.importacao;
  assert.equal(imp.situacao, 'aguardando_confirmacao');
  assert.equal(imp.codigosValidos, 2);
  assert.equal(imp.novos, 2);

  assert.equal((await consultar('BR111111111')).json.encontrado, false);
  const conf = await req('POST', `/admin/api/importacoes/${imp.id}/confirmar`);
  assert.equal(conf.res.status, 200);
  assert.equal((await consultar('BR111111111')).json.encontrado, true);
});

test('consulta pública: só encontrado true/false, correspondência exata', async () => {
  const ok = await consultar('  br111111111 ');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.encontrado, true);
  assert.equal(ok.json.situacao, 'na_agencia');
  assert.ok(ok.json.recebidoEm);
  // Só campos da situação do pacote, nada de pessoas, empresa ou outros códigos.
  assert.deepEqual(Object.keys(ok.json).sort(), ['encontrado', 'recebidoEm', 'saidaEm', 'situacao', 'status', 'tipo']);

  // Parciais e parecidos não revelam nada
  assert.deepEqual((await consultar('BR11111111')).json, { encontrado: false });
  assert.deepEqual((await consultar('BR1111111111')).json, { encontrado: false });
  assert.deepEqual((await consultar('%')).json, { encontrado: false });
  assert.deepEqual((await consultar('BR1%')).json, { encontrado: false });
  assert.deepEqual((await consultar('x'.repeat(500))).json, { encontrado: false });

  const vazio = await consultar('   ');
  assert.equal(vazio.status, 400);
});

test('resposta pública não contém dados pessoais nem detalhes internos', async () => {
  const { text } = await req('POST', '/api/consulta', { body: { codigo: 'BR111111111' } });
  assert.equal(JSON.parse(text).encontrado, true);
  for (const proibido of ['Fulano', '0000-0000', 'shopee', 'Shopee', 'admin', SENHA_TESTE]) {
    assert.ok(!text.includes(proibido));
  }
});

test('dados pessoais do relatório não são armazenados', () => {
  const dump = JSON.stringify(db.prepare('SELECT * FROM packages').all()) +
    JSON.stringify(db.prepare('SELECT * FROM imports').all());
  assert.ok(!dump.includes('Fulano'));
  assert.ok(!dump.includes('0000-0000'));
});

test('importar o mesmo relatório de novo não cria duplicatas', async () => {
  const csv = 'Tracking Number\nBR111111111\nBR222222222\nbr222222222\n';
  const prep = await importarPeloPainel('shopee', 'spx2.csv', csv);
  const imp = prep.json.importacao;
  assert.equal(imp.codigosValidos, 2);
  assert.equal(imp.novos, 0);
  assert.equal(imp.atualizados, 2);
  await req('POST', `/admin/api/importacoes/${imp.id}/confirmar`);
  const n = db.prepare("SELECT COUNT(*) AS n FROM packages WHERE source='shopee'").get().n;
  assert.equal(n, 2);
});

test('relatório completo tira da consulta quem não aparece mais (com aviso na prévia)', async () => {
  const prep = await importarPeloPainel('shopee', 'spx3.csv', 'Tracking Number\nBR222222222\n');
  const imp = prep.json.importacao;
  assert.equal(imp.removidos, 1);
  await req('POST', `/admin/api/importacoes/${imp.id}/confirmar`);
  const saiu = (await consultar('BR111111111')).json;
  assert.equal(saiu.encontrado, true);
  assert.equal(saiu.situacao, 'saiu');
  assert.ok(saiu.saidaEm);
  assert.equal((await consultar('BR222222222')).json.encontrado, true);
});

test('arquivo sem coluna reconhecida falha com mensagem útil e marca a fonte', async () => {
  const prep = await importarPeloPainel('correios', 'errado.csv', 'Nome,Telefone\nFulano,1\n');
  assert.equal(prep.res.status, 422);
  assert.equal(prep.json.importacao.situacao, 'falhou');
  assert.match(prep.json.detalhe, /Cabeçalhos da primeira linha: Nome \| Telefone/);
  // o histórico guarda só a mensagem genérica, sem o conteúdo do arquivo
  const salvo = db.prepare('SELECT error_message FROM imports WHERE id = ?').get(prep.json.importacao.id).error_message;
  assert.ok(!salvo.includes('Telefone'));
  const { json } = await req('GET', '/admin/api/fontes');
  const correios = json.fontes.find((f) => f.id === 'correios');
  assert.equal(correios.state, 'falhou');
  const shopee = json.fontes.find((f) => f.id === 'shopee');
  assert.equal(shopee.state, 'atualizado');
  assert.ok(shopee.lastSuccessAt);
});

test('coluna configurada manualmente é usada', async () => {
  const put = await req('PUT', '/admin/api/configuracoes/correios', { body: { codeColumn: 'Objeto Postal' } });
  assert.equal(put.res.status, 200);
  const prep = await importarPeloPainel('correios', 'c.csv', 'Destinatario,Objeto Postal\nFulano,xx000000001br\n');
  assert.equal(prep.json.importacao.colunaCodigo, 'Objeto Postal');
  await req('POST', `/admin/api/importacoes/${prep.json.importacao.id}/confirmar`);
  assert.equal((await consultar('XX000000001BR')).json.encontrado, true);
});

test('lê XLSX com cabeçalho fora da primeira linha', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Relatório');
  ws.addRow(['Relatório de estoque']);
  ws.addRow(['ID do envio', 'Comprador']);
  ws.addRow([46123456789, 'Fulano']);
  ws.addRow(['46123456790', 'Ciclano']);
  const buf = await wb.xlsx.writeBuffer();
  const prep = await importarPeloPainel('ml', 'ml.xlsx', Buffer.from(buf));
  assert.equal(prep.json.importacao.situacao, 'aguardando_confirmacao', JSON.stringify(prep.json));
  assert.equal(prep.json.importacao.codigosValidos, 2);
  await req('POST', `/admin/api/importacoes/${prep.json.importacao.id}/confirmar`);
  assert.equal((await consultar('46123456789')).json.encontrado, true);
});

test('lê CSV em Latin-1 com ponto e vírgula', async () => {
  const conteudo = Buffer.from('Código de rastreio;Endereço\nLB000000001BR;Rua São João\n', 'latin1');
  const prep = await importarPeloPainel('correios', 'latin.csv', conteudo);
  // configuração manual da coluna (teste anterior) não existe neste arquivo: falha esperada
  assert.equal(prep.json.importacao.situacao, 'falhou');
  await req('PUT', '/admin/api/configuracoes/correios', { body: { codeColumn: '' } });
  const prep2 = await importarPeloPainel('correios', 'latin.csv', conteudo);
  assert.equal(prep2.json.importacao.colunaCodigo, 'Código de rastreio');
});

test('pasta de entrada: falha numa empresa não impede as outras', async () => {
  const antigo = Date.now() / 1000 - 60;
  const ok = path.join(inbox, 'ml', 'estoque.csv');
  const ruim = path.join(inbox, 'shopee', 'quebrado.csv');
  fs.writeFileSync(ok, 'ID do envio\n46123456789\n46123456790\n46999999999\n');
  fs.writeFileSync(ruim, 'sem,coluna\n1,2\n');
  fs.utimesSync(ok, antigo, antigo);
  fs.utimesSync(ruim, antigo, antigo);

  const resultado = await processAll(db, inbox);
  const ml = resultado.find((r) => r.source === 'ml');
  const sp = resultado.find((r) => r.source === 'shopee');
  assert.equal(ml.results[0].status, 'sucesso');
  assert.equal(sp.results[0].status, 'falhou');
  assert.equal((await consultar('46999999999')).json.encontrado, true);
  // arquivos são apagados após leitura
  assert.equal(fs.existsSync(ok), false);
  assert.equal(fs.existsSync(ruim), false);
});

test('pasta de entrada pede confirmação se o relatório remover pacotes demais', async () => {
  const f = path.join(inbox, 'ml', 'incompleto.csv');
  fs.writeFileSync(f, 'ID do envio\n46123456789\n');
  const antigo = Date.now() / 1000 - 60;
  fs.utimesSync(f, antigo, antigo);
  const resultado = await processAll(db, inbox);
  const ml = resultado.find((r) => r.source === 'ml');
  assert.equal(ml.results[0].status, 'aguardando_confirmacao');
  assert.equal((await consultar('46999999999')).json.encontrado, true);
});

test('pacotes filtrados por empresa no painel', async () => {
  const { json } = await req('GET', '/admin/api/pacotes?fonte=ml&situacao=ativos');
  assert.ok(json.itens.length > 0);
  assert.ok(json.itens.every((p) => p.fonte === 'ml'));
});

test('limite de consultas devolve 429 sem detalhes internos', async () => {
  const app2 = createApp({ config: { ...config, PUBLIC_RATE_PER_MINUTE: 3 }, db });
  const s2 = await new Promise((r) => { const s = app2.listen(0, () => r(s)); });
  const url = `http://127.0.0.1:${s2.address().port}/api/consulta`;
  let last;
  for (let i = 0; i < 4; i += 1) {
    last = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"codigo":"A1"}' });
  }
  assert.equal(last.status, 429);
  const body = await last.json();
  assert.deepEqual(Object.keys(body), ['erro']);
  s2.close();
});

test('logout encerra a sessão', async () => {
  await req('POST', '/admin/api/logout');
  const r = await req('GET', '/admin/api/pacotes');
  assert.equal(r.res.status, 401);
});

test('páginas estáticas não expõem configuração do servidor', async () => {
  for (const p of ['/', '/consulta.js', '/admin/', '/admin/admin.js']) {
    const { res, text } = await req('GET', p);
    assert.equal(res.status, 200, p);
    assert.ok(!text.includes('ADMIN_PASSWORD_HASH'));
    assert.ok(!text.includes('$2a$') && !text.includes('$2b$'));
  }
  const env = await req('GET', '/../.env');
  assert.notEqual(env.res.status, 200);
});
