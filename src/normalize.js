'use strict';
// Normalização única usada na importação E na consulta pública, para que
// a comparação seja sempre exata entre os dois lados.
//
// Regras:
//  1. remove espaços e caracteres invisíveis no início e no fim
//     (inclui espaço não separável e caracteres de largura zero);
//  2. converte letras para maiúsculas (códigos de rastreio não diferenciam
//     maiúsculas de minúsculas na prática: "xx123br" e "XX123BR" são o mesmo);
//  3. NÃO remove nem troca nenhum outro caractere (hífens, pontos, barras,
//     espaços internos continuam como estão).
// Depois disso a busca exige igualdade exata — sem busca parcial.

const EDGE_INVISIBLE = /^[\s ​-‍⁠﻿]+|[\s ​-‍⁠﻿]+$/g;

const MAX_LENGTH = 64;

function normalizeCode(value) {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'number' ? numberToString(value) : String(value);
  s = s.replace(EDGE_INVISIBLE, '');
  s = s.toUpperCase();
  return s;
}

// Números vindos de planilhas (ex.: IDs numéricos longos) sem notação científica.
function numberToString(n) {
  if (Number.isInteger(n)) return BigInt(n).toString();
  return String(n);
}

// Validação para a barra de pesquisa pública: tamanho e caracteres de controle.
function isAcceptableQuery(normalized) {
  if (!normalized) return false;
  if (normalized.length > MAX_LENGTH) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(normalized)) return false;
  return true;
}

module.exports = { normalizeCode, isAcceptableQuery, MAX_LENGTH };
