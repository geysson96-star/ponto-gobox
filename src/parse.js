'use strict';
// Leitura de relatórios exportados (CSV ou XLSX).
// Só as colunas de código e ID da fonte são extraídas; o restante do arquivo
// (que pode conter nomes, telefones e endereços) é descartado na leitura.

const { parse: parseCsv } = require('csv-parse/sync');
const ExcelJS = require('exceljs');
const { normalizeCode } = require('./normalize');

class ImportError extends Error {}

function headerKey(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function decodeText(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    // Muitos portais brasileiros exportam em Windows-1252 / Latin-1.
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

function detectDelimiter(text) {
  const firstLines = text.split(/\r?\n/).slice(0, 5).join('\n');
  const counts = { ',': 0, ';': 0, '\t': 0 };
  for (const ch of firstLines) if (ch in counts) counts[ch] += 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

function readCsv(buffer) {
  const text = decodeText(buffer).replace(/^﻿/, '');
  const rows = parseCsv(text, {
    delimiter: detectDelimiter(text),
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true
  });
  return rows;
}

function cellValue(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if ('text' in v) return v.text;                 // hyperlink
    if ('richText' in v) return v.richText.map((p) => p.text).join('');
    if ('result' in v) return v.result ?? '';       // fórmula
    if (v instanceof Date) return v.toISOString();
    return '';
  }
  return v;
}

async function readXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch {
    throw new ImportError('Não foi possível abrir a planilha. Verifique se o arquivo é .xlsx válido.');
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new ImportError('A planilha não tem nenhuma aba.');
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const values = [];
    for (let c = 1; c <= row.cellCount; c += 1) values.push(cellValue(row.getCell(c).value));
    rows.push(values);
  });
  return rows;
}

function detectFormat(filename, buffer) {
  const lower = String(filename || '').toLowerCase();
  if (lower.endsWith('.xlsx')) return 'xlsx';
  if (lower.endsWith('.csv') || lower.endsWith('.txt') || lower.endsWith('.tsv')) return 'csv';
  // Assinatura ZIP = xlsx
  if (buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) return 'xlsx';
  return 'csv';
}

function findColumn(headers, explicit, candidates) {
  const keys = headers.map(headerKey);
  if (explicit) {
    const idx = keys.indexOf(headerKey(explicit));
    return idx;
  }
  for (const cand of candidates) {
    const idx = keys.indexOf(headerKey(cand));
    if (idx !== -1) return idx;
  }
  return -1;
}

/**
 * Extrai os códigos de um relatório.
 * @returns {{rowsRead:number, codes:Map<string,string|null>, codeColumn:string}}
 */
async function extractCodes({ buffer, filename, source, settings }) {
  if (!buffer || buffer.length === 0) throw new ImportError('O arquivo está vazio.');
  const format = detectFormat(filename, buffer);
  const rows = format === 'xlsx' ? await readXlsx(buffer) : readCsv(buffer);
  if (rows.length === 0) throw new ImportError('O arquivo não tem linhas.');

  // Procura a linha de cabeçalho nas primeiras 15 linhas.
  let headerIdx = -1;
  let codeIdx = -1;
  let idIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i += 1) {
    const headers = rows[i].map((h) => String(cellValue(h)));
    const ci = findColumn(headers, settings.codeColumn, source.codeColumnCandidates);
    if (ci !== -1) {
      headerIdx = i;
      codeIdx = ci;
      idIdx = settings.idColumn || source.idColumnCandidates.length
        ? findColumn(headers, settings.idColumn, source.idColumnCandidates)
        : -1;
      if (idIdx === codeIdx) idIdx = -1;
      break;
    }
  }

  if (headerIdx === -1) {
    const seen = (rows[0] || []).map((h) => String(cellValue(h)).trim()).filter(Boolean).slice(0, 30);
    const wanted = settings.codeColumn
      ? `a coluna configurada "${settings.codeColumn}"`
      : 'uma coluna de código reconhecida';
    // A lista de cabeçalhos vai só na resposta imediata ao administrador (não é
    // gravada no histórico), porque um arquivo sem cabeçalho teria dados de
    // clientes na primeira linha.
    const err = new ImportError(
      `Não encontrei ${wanted}. Ajuste o nome da coluna em Configurações ` +
      '(envie o arquivo pelo painel para ver os cabeçalhos encontrados).'
    );
    err.detail = `Cabeçalhos da primeira linha: ${seen.length ? seen.join(' | ') : '(nenhum)'}`;
    throw err;
  }

  const headers = rows[headerIdx].map((h) => String(cellValue(h)).trim());
  const codes = new Map();
  let rowsRead = 0;
  for (let i = headerIdx + 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || row.every((v) => String(cellValue(v)).trim() === '')) continue;
    rowsRead += 1;
    const code = normalizeCode(cellValue(row[codeIdx]));
    if (!code || code.length > 64) continue;
    const ext = idIdx >= 0 ? String(cellValue(row[idIdx]) ?? '').trim().slice(0, 128) || null : null;
    codes.set(code, ext);
  }

  return { rowsRead, codes, codeColumn: headers[codeIdx] };
}

module.exports = { extractCodes, ImportError, headerKey };
