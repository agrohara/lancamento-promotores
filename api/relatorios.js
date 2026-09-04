// Vercel Serverless Function — agrega os dados de "Lancamentos" (pedidos) e "Visitas"
// para alimentar a tela de Relatórios. Migração completa: as duas tabelas já vêm do
// Supabase, sem mais dependência do SharePoint/Graph API. Exige usuário logado (token do
// /api/login): um Promotor só recebe os próprios números; Gerente/Desenvolvedor pode ver
// todo mundo, ou filtrar por um promotor específico.
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
// Variáveis de ambiente necessárias: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, API_KEY,
// AUTH_SECRET.

const { usuarioDaRequisicao } = require("./_lib/auth");
const { quinzenaChave, quinzenaRotulo } = require("./_lib/quinzenas");
const { obterSupabase, buscarTodasLinhas } = require("./_lib/supabase");

const CARGOS_GESTAO = ["gerente", "desenvolvedor"];

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

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ erro: "Banco de dados não configurado (faltam SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)." });
    return;
  }

  try {
    const supabase = obterSupabase();

    const [linhasLancamentos, linhasVisitas] = await Promise.all([
      buscarTodasLinhas(supabase, "lancamentos", "nome_promotor,revenda,propriedade,valor_total,dia_lancamento", null),
      buscarTodasLinhas(supabase, "visitas", "nome_promotor,propriedade,tipo_visita,dia_visita", null)
    ]);

    // Lancamentos (Supabase)
    let pedidos = linhasLancamentos.map(l => ({
      promotor: String(l.nome_promotor || "").trim(),
      revenda: String(l.revenda || "").trim(),
      propriedade: String(l.propriedade || "").trim(),
      valor: Number(l.valor_total) || 0,
      data: String(l.dia_lancamento || "").slice(0, 10)
    })).filter(p => p.promotor && p.data);

    // Visitas (Supabase)
    let visitas = linhasVisitas.map(v => ({
      promotor: String(v.nome_promotor || "").trim(),
      propriedade: String(v.propriedade || "").trim(),
      tipo: String(v.tipo_visita || "").trim(),
      data: String(v.dia_visita || "").slice(0, 10)
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
