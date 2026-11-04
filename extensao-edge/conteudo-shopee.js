'use strict';
/* global goboxBuscarJson, goboxNormalizar, goboxAgendar, GoboxSessaoExpirada */
// Shopee SPX (Agência). Envia cada pacote com a situação e os horários:
//  - Drop-off (vendedor deixa para enviar): na agência = DOP_Received (2),
//    DOP_Packing (5), DOP_Packed (6); enviado = DOP_Outbound (3).
//  - Self-Collection (comprador retira): aguardando retirada, retirado,
//    a caminho da agência, devolvido etc.
// Nomes, telefones e demais dados do cliente NÃO são enviados.

(function () {
  const DIA = 86400;

  // Status de Self-Collection usados pela própria página do portal.
  const RETIRADA = {
    na_agencia: [1, 2, 3, 4, 5, 69, 70, 71, 60, 61, 62, 63, 34, 7, 68],
    retirado: [6],
    devolvido: [8, 53, 54, 55, 17, 19, 20],
    a_caminho: [28],
    cancelado: [30],
    verificacao: [32, 43, 40, 41, 42]
  };

  function situacaoRetirada(st) {
    if (RETIRADA.retirado.includes(st)) return ['retirado', 'Retirado pelo comprador'];
    if (RETIRADA.na_agencia.includes(st)) {
      if (st === 34) return ['na_agencia', 'Chegou na agência'];
      return ['na_agencia', 'Disponível para retirada'];
    }
    if (RETIRADA.devolvido.includes(st)) return ['enviado', 'Devolvido (não foi retirado no prazo)'];
    if (RETIRADA.a_caminho.includes(st)) return ['outro', 'A caminho da agência'];
    if (RETIRADA.cancelado.includes(st)) return ['outro', 'Pedido cancelado'];
    return ['outro', 'Em verificação na agência'];
  }

  async function garantirPonto() {
    const { trocarPontoShopee = true } = await chrome.storage.local.get('trocarPontoShopee');
    const lista = await goboxBuscarJson('/sp-api/current_user/list_point');
    if (lista.retcode !== 0) throw new GoboxSessaoExpirada('Shopee: sessão expirada. Faça login de novo.');
    const reais = ((lista.data && lista.data.point_list) || []).filter((p) => !/^admin$/i.test(String(p.point_name || '').trim()));
    if (reais.length !== 1) throw new Error('Shopee: a conta tem mais de um ponto de agência.');
    const alvo = reais[0];
    const atual = await goboxBuscarJson('/sp-api/current_user?ignore_point_list_flag=true');
    if (atual.retcode === 0 && String(atual.data.current_point_id) === String(alvo.point_id)) return;
    if (!trocarPontoShopee) {
      throw new Error('Shopee: o portal está no ponto "Admin". Selecione o ponto da agência no topo da página.');
    }
    const r = await goboxBuscarJson('/sp-api/current_user/change_point', { method: 'POST', body: { point_id: alvo.point_id } });
    if (r.retcode !== 0) throw new Error('Shopee: não consegui selecionar o ponto da agência.');
  }

  // O portal aceita no máximo 30 dias por busca: períodos maiores são lidos em partes.
  async function listar(tipoLista, dias, status) {
    const agora = Math.floor(Date.now() / 1000);
    const inicio = agora - Math.ceil(dias * DIA);
    const itens = [];
    for (let fim = agora; fim > inicio; fim -= 30 * DIA) {
      itens.push(...await listarPeriodo(tipoLista, Math.max(inicio, fim - 30 * DIA), fim, status));
    }
    return itens;
  }

  async function listarPeriodo(tipoLista, de, ate, status) {
    const itens = [];
    let total = Infinity;
    for (let p = 1; itens.length < total && p <= 100; p += 1) {
      const filtro = status ? `&status=${encodeURIComponent(status)}` : '';
      const r = await goboxBuscarJson(`/sp-api/point/order/${tipoLista}/list?inbound_time_start=${de}` +
        `&inbound_time_end=${ate}&pageno=${p}&count=500${filtro}`);
      if (r.retcode !== 0) {
        if (/login|cookie|token|auth|session/i.test(String(r.message || ''))) {
          throw new GoboxSessaoExpirada('Shopee: sessão expirada. Faça login de novo.');
        }
        throw new Error(`Shopee: o portal respondeu com erro (${r.retcode}${r.message ? `: ${String(r.message).slice(0, 80)}` : ""}).`);
      }
      const lote = (r.data && r.data.list) || [];
      total = Number((r.data && r.data.total) ?? lote.length);
      if (!lote.length) break;
      itens.push(...lote);
    }
    return itens;
  }

  const seg = (t) => (t ? Number(t) : null);

  // Dias desde a meia-noite do dia 1 do mês atual (horário da Bahia, UTC-3) até agora,
  // para o painel financeiro receber o mês inteiro, do dia 1 até a atualização.
  function diasDesdeDia1() {
    const FUSO = 3 * 3600 * 1000;
    const local = new Date(Date.now() - FUSO);
    const dia1 = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) + FUSO;
    return Math.ceil((Date.now() - dia1) / (DIA * 1000)) + 1; // +1 dia de folga
  }

  async function ler() {
    await garantirPonto();
    const pacotes = new Map();
    const guardar = (codigoBruto, dados) => {
      const c = goboxNormalizar(codigoBruto);
      if (c) pacotes.set(c, { codigo: c, ...dados });
    };

    // Do dia 1 do mês até agora, em todas as listas (o painel financeiro precisa do
    // mês inteiro). Na agência e retiradas: no mínimo 30 dias, para a consulta pública
    // achar pacotes que chegaram no mês passado e ainda estão aqui.
    const dia1 = diasDesdeDia1();
    const naAgencia = await listar('dropoff', Math.max(30, dia1), '2,5,6');
    const enviados = await listar('dropoff', Math.max(3, dia1), '3');
    for (const it of [...enviados, ...naAgencia]) {
      const st = Number(it.status);
      const dados = st === 3
        ? { situacao: 'enviado', rotulo: 'Coletado pela Shopee', tipo: 'drop_off', recebidoEm: seg(it.inbound_time), saidaEm: seg(it.outbound_time) }
        : { situacao: 'na_agencia', rotulo: 'Na agência, aguardando coleta da Shopee', tipo: 'drop_off', recebidoEm: seg(it.inbound_time), saidaEm: null };
      // O mesmo pacote pode ser guardado com dois códigos; idFonte junta os dois.
      dados.idFonte = String(it.shipment_id || it.scan_tracking_number || '') || null;
      guardar(it.shipment_id || it.scan_tracking_number, dados);
      if (it.scan_tracking_number && it.scan_tracking_number !== it.shipment_id) guardar(it.scan_tracking_number, dados);
    }

    // Self-Collection, todos os status: do dia 1 do mês (no mínimo 30 dias) até agora.
    for (const it of await listar('collection', Math.max(30, dia1), null)) {
      const [situacao, rotulo] = situacaoRetirada(Number(it.status));
      const dados = {
        situacao, rotulo, tipo: 'retirada',
        recebidoEm: seg(it.inbound_time),
        saidaEm: situacao === 'retirado' || situacao === 'enviado' ? seg(it.outbound_time) : null,
        idFonte: String(it.shipment_id || it.scan_tracking_number || '') || null
      };
      guardar(it.shipment_id || it.scan_tracking_number, dados);
      if (it.scan_tracking_number && it.scan_tracking_number !== it.shipment_id) guardar(it.scan_tracking_number, dados);
    }
    return { pacotes: [...pacotes.values()], modo: 'eventos' };
  }

  goboxAgendar('shopee', ler);
}());
