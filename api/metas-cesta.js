// Vercel Serverless Function — meta semanal de cada CESTA de produtos, por promotor.
// A cesta em si (nome + quais produtos entram) é cadastrada em api/cestas.js; aqui só
// fica o valor da meta de cada promotor pra cada cesta.
//
// GET  /api/metas-cesta               -> Gerente/Desenvolvedor vê todas; Promotor vê só
//                                        as próprias.
// POST /api/metas-cesta                -> só Gerente/Desenvolvedor. Body: { Cesta,
//                                        Promotor, Meta_Semanal }. Upsert por (cesta,
//                                        promotor).
//
// Colunas da tabela "metas_cesta" no Supabase: cesta, promotor, meta_semanal,
// atualizado_por, atualizado_em (chave composta: cesta + promotor).
//
// Variáveis de ambiente necessárias: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, API_KEY,
// AUTH_SECRET.

const { usuarioDaRequisicao } = require("./_lib/auth");
const { obterSupabase } = require("./_lib/supabase");

const CARGOS_GESTAO = ["gerente", "desenvolvedor"];

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

  const usuario = usuarioDaRequisicao(req);
  if (!usuario) {
    res.status(401).json({ erro: "Sessão expirada ou inválida. Faça login novamente." });
    return;
  }

  const supabase = obterSupabase();
  const ehGestor = CARGOS_GESTAO.includes(String(usuario.cargo || "").toLowerCase());

  if (req.method === "GET") {
    try {
      let consulta = supabase.from("metas_cesta").select("cesta, promotor, meta_semanal");
      if (!ehGestor) consulta = consulta.ilike("promotor", usuario.nome);
      const { data, error } = await consulta;
      if (error) throw error;
      const metas = (data || []).map(m => ({ Cesta: m.cesta, Promotor: m.promotor, Meta_Semanal: Number(m.meta_semanal) || 0 }));
      res.status(200).json({ metas });
    } catch (err) {
      res.status(502).json({ erro: "Falha ao ler metas de cesta no banco.", detalhe: String(err.message || err) });
    }
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ erro: "Use GET ou POST." });
    return;
  }

  if (!ehGestor) {
    res.status(403).json({ erro: "Só Gerente/Desenvolvedor pode cadastrar metas de cesta." });
    return;
  }

  const corpo = req.body || {};
  const cesta = String(corpo.Cesta || "").trim();
  const promotor = String(corpo.Promotor || "").trim();
  const meta = Number(corpo.Meta_Semanal);
  if (!cesta || !promotor) {
    res.status(400).json({ erro: "Informe a cesta e o promotor." });
    return;
  }
  if (Number.isNaN(meta) || meta < 0) {
    res.status(400).json({ erro: "Informe uma meta semanal válida (número maior ou igual a zero)." });
    return;
  }

  try {
    const { error } = await supabase
      .from("metas_cesta")
      .upsert(
        { cesta, promotor, meta_semanal: meta, atualizado_por: usuario.nome, atualizado_em: new Date().toISOString() },
        { onConflict: "cesta,promotor" }
      );
    if (error) throw error;
    res.status(200).json({ status: "ok" });
  } catch (err) {
    res.status(502).json({ erro: "Falha ao salvar a meta da cesta.", detalhe: String(err.message || err) });
  }
};
