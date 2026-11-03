'use strict';
/* global goboxBuscarJson, goboxNormalizar, goboxAgendar, GoboxSessaoExpirada */
// Correios Atende: usa a mesma pesquisa da tela "Objetos Captados" (por período).
// Para cada objeto o portal informa:
//   "a coletar" -> captado no balcão e ainda na agência (com horário de captação);
//   "coletado"  -> já recolhido pelos Correios (horário de captação e de coleta).
// Só os códigos e os horários são enviados ao site.

(function () {
  // Só depois do login (as páginas internas ficam em /app/).
  if (!location.pathname.startsWith('/app/')) return;

  // Período: do dia 1º do mês até hoje. O portal aceita no máximo 7 dias por
  // pesquisa, então o mês é dividido em blocos (1–7, 8–14, 15–21, 22–28, 29–hoje).
  const MAX_DIAS_POR_PESQUISA = 7;

  function ymd(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function blocosDoMes(agora = new Date()) {
    const blocos = [];
    const hojeDia = agora.getDate();
    for (let ini = 1; ini <= hojeDia; ini += MAX_DIAS_POR_PESQUISA) {
      const fim = Math.min(ini + MAX_DIAS_POR_PESQUISA - 1, hojeDia);
      blocos.push([
        ymd(new Date(agora.getFullYear(), agora.getMonth(), ini)),
        ymd(new Date(agora.getFullYear(), agora.getMonth(), fim))
      ]);
    }
    return blocos;
  }

  // "03-11-2026T16:18:05" (formato do portal, horário de Brasília) -> ISO
  function dataCorreios(v) {
    if (!v) return null;
    const m = String(v).match(/^(\d{2})-(\d{2})-(\d{4})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (m) return new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6] || '00'}-03:00`).toISOString();
    const d = new Date(String(v));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  // Código da agência (MCU): procura no que a própria página guarda/mostra.
  async function descobrirMcu() {
    const salvo = (await chrome.storage.local.get('mcuCorreios')).mcuCorreios;
    for (const k of Object.keys(localStorage)) {
      const m = String(localStorage.getItem(k) || '').match(/"mcuGeo"\s*:\s*"?(\d{8})/);
      if (m) return m[1];
    }
    const naTela = (document.body && document.body.innerText.match(/\b(\d{8})\s*-\s*[A-ZÀ-Ú]/)) || null;
    if (naTela) return naTela[1];
    if (salvo) return salvo;
    throw new Error('Correios: não encontrei o código da agência (MCU). Informe em Configurar.');
  }

  function corpo(item) {
    if (!item) return null;
    if (typeof item.body === 'string') {
      try { return JSON.parse(item.body); } catch { return null; }
    }
    return item.body;
  }

  async function ler() {
    const mcu = await descobrirMcu();
    await chrome.storage.local.set({ mcuCorreios: mcu });
    let r = [];
    for (const [ini, fim] of blocosDoMes()) {
      const url = '/app/atendimento/resumo/busca-objetos-coletados.php?statusAtual=PAGO,ESTORNADO&page=0' +
        `&data=${ini}&dataFim=${fim}&mcuAgencia=${mcu}&size=2000&sort=dataHora,desc`;
      const parte = await goboxBuscarJson(url);
      r = r.concat(Array.isArray(parte) ? parte : [parte]);
    }

    const pacotes = new Map();
    for (const parte of r) {
      if (parte && parte.erro) {
        const msg = String((parte.body && parte.body.msgs) || '');
        if (/nenhum|não encontrad|nao encontrad/i.test(msg)) continue; // período sem objetos
        if (/sess|login|token|autentic/i.test(msg)) throw new GoboxSessaoExpirada('Correios: sessão expirada. Faça login de novo.');
        throw new Error(`Correios: ${msg.slice(0, 120) || 'o portal respondeu com erro.'}`);
      }
      const b = corpo(parte);
      for (const it of (b && b.itens) || []) {
        if (it.coletado && !it.coletado.mensagem && it.coletado.codObjeto) {
          const ev = it.coletado.eventos || [];
          const c = goboxNormalizar(it.coletado.codObjeto);
          if (c) {
            pacotes.set(c, {
              codigo: c, situacao: 'enviado', rotulo: 'Coletado pelos Correios', tipo: 'envio',
              recebidoEm: dataCorreios(ev.length ? ev[ev.length - 1].dtHrCriado : null),
              saidaEm: dataCorreios(ev.length ? ev[0].dtHrCriado : null)
            });
          }
        } else if (it.acoletar && it.acoletar.codObjeto) {
          const ev = it.acoletar.eventos || [];
          const c = goboxNormalizar(it.acoletar.codObjeto);
          if (c && !pacotes.has(c)) {
            pacotes.set(c, {
              codigo: c, situacao: 'na_agencia', rotulo: 'Na agência, aguardando coleta dos Correios', tipo: 'envio',
              recebidoEm: dataCorreios(ev.length ? ev[0].dtHrCriado : null), saidaEm: null
            });
          }
        }
      }
    }
    return { pacotes: [...pacotes.values()], modo: 'eventos' };
  }

  goboxAgendar('correios', ler);
}());
