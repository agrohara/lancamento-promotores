// Vercel Serverless Function — agrega os dados de "Lancamentos" (pedidos) e "Visitas"
// para alimentar a tela de Relatórios. Exige usuário logado (token do /api/login):
// um Promotor só recebe os próprios números; Gerente/Desenvolvedor pode ver todo
// mundo, ou filtrar por um promotor específico.
//
// GET /api/relatorios              -> Promotor: relatório completo (todo o período) da
//                                     própria carteira. Gerente sem ?promotor=: visão geral
//                                     de todos + ranking por promotor.
// GET /api/relatorios?promotor=X   -> Gerente/Desenvolvedor: relatório detalhado do
//                                     promotor X (fazendas, revendas, totais).
// GET /api/relatorios?quinzena=AAAA-MM-N -> restringe o relatório a essa quinzena.
//                                     Sem esse parâmetro, o relatório considera TODO o
//                                     histórico — não é mais obrigatório escolher uma
//                                     quinzena para ver resultado.
//                                     "porQuinzena" (gráfico) e "todasQuinzenas" (dropdown)
//                                     sempre trazem TODOS os períodos, independente disso.
//
// Variáveis de ambiente: as mesmas dos outros endpoints (TENANT_ID, CLIENT_ID,
// CLIENT_SECRET, API_KEY, AUTH_SECRET). Opcionais: DRIVE_ID, ITEM_ID,
// TABLE_NAME (Lancamentos), TABLE_VISITAS (Visitas)

const { usuarioDaRequisicao } = require("./_lib/auth");
const { paraISO } = require("./_lib/datas");
const { paraNumero } = require("./_lib/numeros");
const { quinzenaChave, quinzenaRotulo } = require("./_lib/quinzenas");

const DRIVE_ID_PADRAO = "b!239ib2QZ802QpEwVD6oJsGCs3VafFl1DpVud7XH4EwnllXBIIGjKQLlfWeBP3ZEo";
const ITEM_ID_PADRAO = "01EEWFJSXC3HLY3IR45NBJ7GFSWWONG7BK";
const TABLE_LANCAMENTOS_PADRAO = "Lancamentos";
const TABLE_VISITAS_PADRAO = "Visitas";

const CARGOS_GESTAO = ["gerente", "desenvolvedor"];

async function obterToken() {
  const url = `https://login.microsoftonline.com/${process.env.TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.CLIENT_ID,
    client_secret: process.env.CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default"
  });
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const dados = await resp.json();
  if (!resp.ok) {
    throw new Error("Falha ao obter token: " + JSON.stringify(dados));
  }
  return dados.access_token;
}

async function obterLinhas(token, driveId, itemId, tableName) {
  const urlGraph = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/workbook/tables('${tableName}')/rows?$select=values`;
  const resp = await fetch(urlGraph, {
    method: "GET",
    headers: { "Authorization": `Bearer ${token}` }
  });
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const erro = new Error("Falha ao ler tabela '" + tableName + "'.");
    erro.detalhe = dados;
    throw erro;
  }
  return (dados.value || []).map(r => r.values && r.values[0]).filter(Boolean);
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ erro: "Use GET." });
    return;
  }

  const chaveEnviada = req.headers["x-api-key"];
  if (!process.env.API_KEY || chaveEnviada !== process.env.API_KEY) {
    res.status(401).json({ erro: "Não autorizado." });
    return;
  }

  const usuario = usuarioDaRequisicao(req);
  if (!usuario) {
    res.status(401).json({ erro: "Sessão expirada ou inválida. Faça login novamente." });
    return;
  }

  const ehGestor = CARGOS_GESTAO.includes(String(usuario.cargo || "").toLowerCase());
  const promotorSolicitado = (req.query && req.query.promotor) || "";
  const filtroPromotor = ehGestor ? String(promotorSolicitado || "").trim() : usuario.nome;

  try {
    const token = await obterToken();
    const driveId = process.env.DRIVE_ID || DRIVE_ID_PADRAO;
    const itemId = process.env.ITEM_ID || ITEM_ID_PADRAO;
    const tableLancamentos = process.env.TABLE_NAME || TABLE_LANCAMENTOS_PADRAO;
    const tableVisitas = process.env.TABLE_VISITAS || TABLE_VISITAS_PADRAO;

    const [linhasLancamentos, linhasVisitas] = await Promise.all([
      obterLinhas(token, driveId, itemId, tableLancamentos),
      obterLinhas(token, driveId, itemId, tableVisitas)
    ]);

    // Lancamentos: Nome_Promotor,Revenda,Propriedade,Produto,Unidade,Preco_Unitario,Volume,Valor_Total,Dia_Lancamento,Quinzena,Observacao_Visita
    let pedidos = linhasLancamentos.map(l => ({
      promotor: String(l[0] || "").trim(),
      revenda: String(l[1] || "").trim(),
      propriedade: String(l[2] || "").trim(),
      valor: paraNumero(l[7]),
      data: paraISO(l[8])
    })).filter(p => p.promotor && p.data);

    // Visitas: Nome_Promotor,Propriedade,Tipo_Visita,Observacao,Foto_URL,Latitude,Longitude,Dia_Visita,Quinzena
    let visitas = linhasVisitas.map(v => ({
      promotor: String(v[0] || "").trim(),
      propriedade: String(v[1] || "").trim(),
      tipo: String(v[2] || "").trim(),
      data: paraISO(v[7])
    })).filter(v => v.promotor && v.data);

    if (filtroPromotor) {
      pedidos = pedidos.filter(p => p.promotor.toLowerCase() === filtroPromotor.toLowerCase());
      visitas = visitas.filter(v => v.promotor.toLowerCase() === filtroPromotor.toLowerCase());
    }

    // Agrega por quinzena — sempre com TODO o histórico (do promotor filtrado, se houver), para
    // alimentar o gráfico e a lista de opções do dropdown de quinzenas.
    const mapaQuinzenas = new Map();
    function acessarQuinzena(chave) {
      if (!mapaQuinzenas.has(chave)) {
        mapaQuinzenas.set(chave, { chave, rotulo: quinzenaRotulo(chave), valorPedidos: 0, totalPedidos: 0, totalVisitas: 0 });
      }
      return mapaQuinzenas.get(chave);
    }
    for (const p of pedidos) {
      const chave = quinzenaChave(p.data);
      if (!chave) continue;
      const q = acessarQuinzena(chave);
      q.valorPedidos += p.valor;
      q.totalPedidos += 1;
    }
    for (const v of visitas) {
      const chave = quinzenaChave(v.data);
      if (!chave) continue;
      const q = acessarQuinzena(chave);
      q.totalVisitas += 1;
    }

    const todasQuinzenasOrdenadas = [...mapaQuinzenas.values()].sort((a, b) => a.chave.localeCompare(b.chave));
    const porQuinzena = todasQuinzenasOrdenadas.slice(-6);
    const todasQuinzenas = [...todasQuinzenasOrdenadas].reverse().map(q => ({ chave: q.chave, rotulo: q.rotulo }));

    // Resumo da quinzena corrente (independente do filtro de período abaixo) — usado pelos
    // cartões do painel Início, que sempre mostram "agora", não o período que a pessoa
    // escolheu na tela de Relatórios.
    const chaveHoje = quinzenaChave(new Date().toISOString().slice(0, 10));
    const idxHoje = todasQuinzenasOrdenadas.findIndex(q => q.chave === chaveHoje);
    const quinzenaAtualDados = idxHoje >= 0 ? todasQuinzenasOrdenadas[idxHoje] : { valorPedidos: 0, totalPedidos: 0, totalVisitas: 0 };

    // Período escolhido na tela de Relatórios: se "?quinzena=" não vier, o relatório
    // considera TODO o histórico (não obriga escolher uma quinzena para ver algo).
    const quinzenaPedida = String((req.query && req.query.quinzena) || "").trim();
    const pedidosPeriodo = quinzenaPedida ? pedidos.filter(p => quinzenaChave(p.data) === quinzenaPedida) : pedidos;
    const visitasPeriodo = quinzenaPedida ? visitas.filter(v => quinzenaChave(v.data) === quinzenaPedida) : visitas;

    const fazendasNoPeriodo = new Set([
      ...pedidosPeriodo.map(p => p.propriedade),
      ...visitasPeriodo.map(v => v.propriedade)
    ].filter(Boolean));

    const resumo = {
      valorPedidos: pedidosPeriodo.reduce((soma, p) => soma + p.valor, 0),
      totalPedidos: pedidosPeriodo.length,
      totalVisitas: visitasPeriodo.length,
      totalFazendas: fazendasNoPeriodo.size
    };

    // Por fazenda — combina pedidos (valor) e visitas (contagem) da mesma propriedade,
    // já dentro do período/promotor filtrados.
    const mapaFazenda = new Map();
    function acessarFazenda(nome) {
      if (!nome) return null;
      if (!mapaFazenda.has(nome)) mapaFazenda.set(nome, { propriedade: nome, valorPedidos: 0, totalPedidos: 0, totalVisitas: 0 });
      return mapaFazenda.get(nome);
    }
    pedidosPeriodo.forEach(p => {
      const f = acessarFazenda(p.propriedade);
      if (f) { f.valorPedidos += p.valor; f.totalPedidos += 1; }
    });
    visitasPeriodo.forEach(v => {
      const f = acessarFazenda(v.propriedade);
      if (f) f.totalVisitas += 1;
    });
    const porFazenda = [...mapaFazenda.values()].sort((a, b) => b.valorPedidos - a.valorPedidos);

    // Por revenda — só faz sentido para pedidos (visita não tem revenda associada).
    const mapaRevenda = new Map();
    pedidosPeriodo.forEach(p => {
      if (!p.revenda) return;
      if (!mapaRevenda.has(p.revenda)) mapaRevenda.set(p.revenda, { revenda: p.revenda, valorPedidos: 0, totalPedidos: 0 });
      const r = mapaRevenda.get(p.revenda);
      r.valorPedidos += p.valor;
      r.totalPedidos += 1;
    });
    const porRevenda = [...mapaRevenda.values()].sort((a, b) => b.valorPedidos - a.valorPedidos);

    // Por tipo de visita — alimenta o gráfico de rosca do modo "Visitas" no relatório.
    const mapaTipoVisita = new Map();
    visitasPeriodo.forEach(v => {
      const tipo = v.tipo || "Não informado";
      if (!mapaTipoVisita.has(tipo)) mapaTipoVisita.set(tipo, { tipo, total: 0 });
      mapaTipoVisita.get(tipo).total += 1;
    });
    const porTipoVisita = [...mapaTipoVisita.values()].sort((a, b) => b.total - a.total);

    // Ranking por promotor — só quando o gestor está vendo "todos os promotores" (sem
    // filtroPromotor). Escopo = período escolhido (ou todo o histórico, se nenhum).
    let porPromotor = [];
    if (ehGestor && !filtroPromotor) {
      const mapaPromotor = new Map();
      function acessarPromotor(nome) {
        if (!mapaPromotor.has(nome)) mapaPromotor.set(nome, { promotor: nome, valorPedidos: 0, totalPedidos: 0, totalVisitas: 0 });
        return mapaPromotor.get(nome);
      }
      pedidosPeriodo.forEach(p => {
        const r = acessarPromotor(p.promotor);
        r.valorPedidos += p.valor;
        r.totalPedidos += 1;
      });
      visitasPeriodo.forEach(v => {
        const r = acessarPromotor(v.promotor);
        r.totalVisitas += 1;
      });
      porPromotor = [...mapaPromotor.values()].sort((a, b) => b.valorPedidos - a.valorPedidos);
    }

    res.status(200).json({
      filtroAplicado: filtroPromotor || null,
      ehGestor,
      periodoSelecionado: quinzenaPedida || null,
      periodoSelecionadoRotulo: quinzenaPedida ? quinzenaRotulo(quinzenaPedida) : "Todo o período",
      resumo,
      resumoQuinzenaAtual: {
        valorPedidos: quinzenaAtualDados.valorPedidos || 0,
        totalPedidos: quinzenaAtualDados.totalPedidos || 0,
        totalVisitas: quinzenaAtualDados.totalVisitas || 0
      },
      porQuinzena,
      todasQuinzenas,
      porFazenda,
      porRevenda,
      porTipoVisita,
      porPromotor
    });
  } catch (err) {
    res.status(502).json({ erro: "Falha ao montar relatório.", detalhe: err.detalhe || String(err.message || err) });
  }
};
