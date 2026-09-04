// Vercel Serverless Function — grava registros de VISITA (separados do PEDIDO) na tabela
// "visitas" no Supabase (Postgres). Quarta tabela migrada do SharePoint/Excel para o banco
// de verdade (depois de "propriedades", "produtos" e "usuarios"). "Lancamentos" (pedidos)
// continua no SharePoint por enquanto.
//
// A Visita guarda o "como foi" (tipo, observação, foto). O Pedido (ver api/lancamentos.js)
// guarda o "o que foi vendido". São duas gravações separadas, feitas em telas separadas no
// app, mas para a mesma fazenda/dia.
//
// POST /api/visitas               -> grava uma visita nova
// GET  /api/visitas               -> lista visitas do promotor logado
// GET  /api/visitas?promotor=X    -> (Gerente/Desenvolvedor) lista visitas de um promotor
// GET  /api/visitas?propriedade=X -> busca parcial pelo nome da fazenda (combinável)
// GET  /api/visitas?quinzena=AAAA-MM-N -> só visitas dessa quinzena (combinável)
// Ambos os GET exigem Authorization: Bearer <token do login>
//
// Colunas da tabela "visitas" no Supabase: nome_promotor, propriedade, tipo_visita,
// observacao, foto_url, latitude, longitude, dia_visita, quinzena.
//
// Variáveis de ambiente necessárias: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, API_KEY,
// AUTH_SECRET.

const { usuarioDaRequisicao } = require("./_lib/auth");
const { obterSupabase } = require("./_lib/supabase");

const CARGOS_GESTAO = ["gerente", "desenvolvedor"];

function paraObjeto(l) {
  return {
    Nome_Promotor: l.nome_promotor || "",
    Propriedade: l.propriedade || "",
    Tipo_Visita: l.tipo_visita || "",
    Observacao: l.observacao || "",
    Foto_URL: l.foto_url || "",
    Dia_Visita: l.dia_visita || "",
    Quinzena: l.quinzena || ""
  };
}

function validarVisita(v) {
  if (!v || typeof v !== "object") return false;
  if (!v.Nome_Promotor || !v.Propriedade || !v.Tipo_Visita || !v.Observacao || !v.Dia_Visita || !v.Quinzena) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v.Dia_Visita))) return false;
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
      const quinzenaFiltro = String((req.query && req.query.quinzena) || "").trim();

      function montarConsulta() {
        let c = supabase.from("visitas").select("*");
        if (promotorFiltro) c = c.ilike("nome_promotor", promotorFiltro);
        if (propriedadeFiltro) c = c.ilike("propriedade", `%${propriedadeFiltro}%`);
        if (quinzenaFiltro) c = c.eq("quinzena", quinzenaFiltro);
        return c;
      }

      // Busca em blocos de 1000 (limite padrão do Supabase), aplicando os mesmos filtros
      // em cada bloco — necessário porque um promotor com muito histórico pode passar
      // de 1000 linhas.
      const TAMANHO_BLOCO = 1000;
      let todasLinhas = [];
      let inicio = 0;
      while (true) {
        const { data, error } = await montarConsulta()
          .order("dia_visita", { ascending: false })
          .range(inicio, inicio + TAMANHO_BLOCO - 1);
        if (error) throw error;
        todasLinhas = todasLinhas.concat(data || []);
        if (!data || data.length < TAMANHO_BLOCO) break;
        inicio += TAMANHO_BLOCO;
      }

      const visitas = todasLinhas.map(paraObjeto);
      res.status(200).json({ visitas });
    } catch (err) {
      res.status(502).json({ erro: "Falha ao ler visitas no banco.", detalhe: String(err.message || err) });
    }
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ erro: "Use GET ou POST." });
    return;
  }

  let visita = req.body || {};

  // Se o usuário logado não for Gerente/Desenvolvedor, o nome do promotor gravado
  // é sempre o do próprio usuário logado — evita registrar visita em nome de outro.
  const usuario = usuarioDaRequisicao(req);
  if (usuario && !CARGOS_GESTAO.includes(String(usuario.cargo || "").toLowerCase())) {
    visita = { ...visita, Nome_Promotor: usuario.nome };
  }

  if (!validarVisita(visita)) {
    res.status(400).json({
      erro: "Dados incompletos: informe promotor, propriedade, tipo de visita, observação, data (AAAA-MM-DD) e quinzena."
    });
    return;
  }

  try {
    const linhaNova = {
      nome_promotor: String(visita.Nome_Promotor).trim(),
      propriedade: String(visita.Propriedade).trim(),
      tipo_visita: String(visita.Tipo_Visita).trim(),
      observacao: String(visita.Observacao).trim(),
      foto_url: String(visita.Foto_URL || "").trim(),
      latitude: visita.Latitude === undefined || visita.Latitude === null || visita.Latitude === "" ? null : Number(visita.Latitude),
      longitude: visita.Longitude === undefined || visita.Longitude === null || visita.Longitude === "" ? null : Number(visita.Longitude),
      dia_visita: visita.Dia_Visita,
      quinzena: visita.Quinzena
    };

    const { error: erroInsert } = await supabase.from("visitas").insert(linhaNova);
    if (erroInsert) throw erroInsert;

    res.status(200).json({ status: "ok" });
  } catch (err) {
    res.status(502).json({ erro: "Falha ao gravar a visita no banco.", detalhe: String(err.message || err) });
  }
};
