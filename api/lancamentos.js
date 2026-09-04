// Vercel Serverless Function — grava lançamentos (pedidos) na tabela "lancamentos" no
// Supabase (Postgres). Última tabela migrada do SharePoint/Excel para o banco de verdade
// (depois de "propriedades", "produtos", "usuarios" e "visitas") — migração completa.
//
// As propriedades já são cadastradas antes, com dados completos, pelo assistente de
// cadastro (ver api/propriedades.js). Esta função só grava a transação de venda.
//
// GET também aceita, combináveis: ?propriedade=X (busca parcial no nome da fazenda),
// ?revenda=X (busca parcial no nome da revenda), ?quinzena=AAAA-MM-N (só lançamentos
// daquela quinzena) — usados na busca de histórico e no drill-down do relatório
// (Gerente/Desenvolvedor).
//
// Colunas da tabela "lancamentos" no Supabase: nome_promotor, revenda, propriedade,
// produto, unidade, preco_unitario, volume, valor_total, dia_lancamento, quinzena,
// observacao_visita.
//
// Variáveis de ambiente necessárias: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, API_KEY,
// AUTH_SECRET.

const { usuarioDaRequisicao } = require("./_lib/auth");
const { obterSupabase } = require("./_lib/supabase");

const CARGOS_GESTAO = ["gerente", "desenvolvedor"];

function paraObjeto(l) {
  return {
    Nome_Promotor: l.nome_promotor || "",
    Revenda: l.revenda || "",
    Propriedade: l.propriedade || "",
    Produto: l.produto || "",
    Unidade: l.unidade || "",
    Preco_Unitario: l.preco_unitario === undefined || l.preco_unitario === null ? 0 : Number(l.preco_unitario),
    Volume: l.volume === undefined || l.volume === null ? 0 : Number(l.volume),
    Valor_Total: l.valor_total === undefined || l.valor_total === null ? 0 : Number(l.valor_total),
    Dia_Lancamento: l.dia_lancamento || "",
    Quinzena: l.quinzena || ""
  };
}

function validarRegistro(r) {
  if (!r || typeof r !== "object") return false;
  // A observação da visita agora é registrada separadamente (ver api/visitas.js),
  // então aqui ela é opcional — o pedido pode ser lançado sozinho.
  if (!r.Nome_Promotor || !r.Revenda || !r.Propriedade || !r.Produto || !r.Dia_Lancamento || !r.Quinzena) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.Dia_Lancamento))) return false;

  const preco = Number(r.Preco_Unitario);
  const volume = Number(r.Volume);
  if (Number.isNaN(preco) || preco < 0) return false;
  if (Number.isNaN(volume) || volume <= 0) return false;

  return true;
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const chaveEnviada = req.headers["x-api-key"];
  if (!process.env.API_KEY || chaveEnviada !== process.env.API_KEY) {
    res.status(401).json({ erro: "Não autorizado." });
    return;
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ erro: "Banco de dados não configurado (faltam SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)." });
    return;
  }

  const supabase = obterSupabase();

  if (req.method === "GET") {
    const usuario = usuarioDaRequisicao(req);
    if (!usuario) {
      res.status(401).json({ erro: "Sessão expirada ou inválida. Faça login novamente." });
      return;
    }
    const ehGestor = CARGOS_GESTAO.includes(String(usuario.cargo || "").toLowerCase());
    const promotorFiltro = ehGestor ? String((req.query && req.query.promotor) || "").trim() : usuario.nome;

    try {
      const propriedadeFiltro = String((req.query && req.query.propriedade) || "").trim();
      const revendaFiltro = String((req.query && req.query.revenda) || "").trim();
      const quinzenaFiltro = String((req.query && req.query.quinzena) || "").trim();

      function montarConsulta() {
        let c = supabase.from("lancamentos").select("*");
        if (promotorFiltro) c = c.ilike("nome_promotor", promotorFiltro);
        if (propriedadeFiltro) c = c.ilike("propriedade", `%${propriedadeFiltro}%`);
        if (revendaFiltro) c = c.ilike("revenda", `%${revendaFiltro}%`);
        if (quinzenaFiltro) c = c.eq("quinzena", quinzenaFiltro);
        return c;
      }

      // Busca em blocos de 1000 (limite padrão do Supabase), aplicando os mesmos filtros
      // em cada bloco.
      const TAMANHO_BLOCO = 1000;
      let todasLinhas = [];
      let inicio = 0;
      while (true) {
        const { data, error } = await montarConsulta()
          .order("dia_lancamento", { ascending: false })
          .range(inicio, inicio + TAMANHO_BLOCO - 1);
        if (error) throw error;
        todasLinhas = todasLinhas.concat(data || []);
        if (!data || data.length < TAMANHO_BLOCO) break;
        inicio += TAMANHO_BLOCO;
      }

      const lancamentos = todasLinhas.map(paraObjeto);
      res.status(200).json({ lancamentos });
    } catch (err) {
      res.status(502).json({ erro: "Falha ao ler lançamentos no banco.", detalhe: String(err.message || err) });
    }
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ erro: "Use GET ou POST." });
    return;
  }

  let lancamentos = (req.body && req.body.lancamentos) || [];
  if (!Array.isArray(lancamentos) || lancamentos.length === 0) {
    res.status(400).json({ erro: "Envie 'lancamentos' como um array não vazio." });
    return;
  }

  // Se o usuário logado não for Gerente/Desenvolvedor, o nome do promotor gravado
  // é sempre o do próprio usuário logado — evita que alguém lance venda em nome de
  // outro promotor só editando o payload.
  const usuario = usuarioDaRequisicao(req);
  if (usuario && !CARGOS_GESTAO.includes(String(usuario.cargo || "").toLowerCase())) {
    lancamentos = lancamentos.map(r => ({ ...r, Nome_Promotor: usuario.nome }));
  }

  const invalidos = lancamentos.filter(r => !validarRegistro(r));
  if (invalidos.length > 0) {
    res.status(400).json({
      erro: "Um ou mais registros estão incompletos, com data em formato inválido (esperado AAAA-MM-DD) ou preço/volume inválidos.",
      invalidos
    });
    return;
  }

  try {
    const linhasNovas = lancamentos.map(r => ({
      nome_promotor: String(r.Nome_Promotor).trim(),
      revenda: String(r.Revenda).trim(),
      propriedade: String(r.Propriedade).trim(),
      produto: String(r.Produto).trim(),
      unidade: String(r.Unidade || "").trim(),
      preco_unitario: Number(r.Preco_Unitario),
      volume: Number(r.Volume),
      valor_total: Number(r.Preco_Unitario) * Number(r.Volume),
      dia_lancamento: r.Dia_Lancamento,
      quinzena: r.Quinzena,
      observacao_visita: String(r.Observacao_Visita || "").trim()
    }));

    const { error: erroInsert } = await supabase.from("lancamentos").insert(linhasNovas);
    if (erroInsert) throw erroInsert;

    res.status(200).json({ status: "ok", inseridos: linhasNovas.length });
  } catch (err) {
    res.status(502).json({ erro: "Falha ao gravar os lançamentos no banco.", detalhe: String(err.message || err) });
  }
};
