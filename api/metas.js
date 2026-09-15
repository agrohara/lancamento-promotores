// Vercel Serverless Function — meta semanal de vendas por revenda, cadastrada pelo
// Gerente/Desenvolvedor. Usada pra mostrar ao promotor (e ao gestor) o progresso da
// semana atual em relação à meta de cada revenda (ver api/relatorios.js, que junta essa
// meta com o total vendido na semana).
//
// GET  /api/metas   -> qualquer usuário logado pode ler (precisa pra mostrar o progresso).
// POST /api/metas    -> só Gerente/Desenvolvedor. Body: { Revenda, Meta_Semanal }.
//                       Cria a meta se não existir, ou atualiza o valor se já existir
//                       (upsert pelo nome da revenda).
//
// Colunas da tabela "metas_revenda" no Supabase: revenda (chave), meta_semanal,
// atualizado_por, atualizado_em.
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

  if (req.method === "GET") {
    try {
      const { data, error } = await supabase.from("metas_revenda").select("revenda, meta_semanal");
      if (error) throw error;
      const metas = (data || []).map(m => ({ Revenda: m.revenda, Meta_Semanal: Number(m.meta_semanal) || 0 }));
      res.status(200).json({ metas });
    } catch (err) {
      res.status(502).json({ erro: "Falha ao ler metas no banco.", detalhe: String(err.message || err) });
    }
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ erro: "Use GET ou POST." });
    return;
  }

  const ehGestor = CARGOS_GESTAO.includes(String(usuario.cargo || "").toLowerCase());
  if (!ehGestor) {
    res.status(403).json({ erro: "Só Gerente/Desenvolvedor pode cadastrar metas." });
    return;
  }

  const corpo = req.body || {};
  const revenda = String(corpo.Revenda || "").trim();
  const meta = Number(corpo.Meta_Semanal);
  if (!revenda) {
    res.status(400).json({ erro: "Informe a revenda." });
    return;
  }
  if (Number.isNaN(meta) || meta < 0) {
    res.status(400).json({ erro: "Informe uma meta semanal válida (número maior ou igual a zero)." });
    return;
  }

  try {
    const { error } = await supabase
      .from("metas_revenda")
      .upsert(
        { revenda, meta_semanal: meta, atualizado_por: usuario.nome, atualizado_em: new Date().toISOString() },
        { onConflict: "revenda" }
      );
    if (error) throw error;
    res.status(200).json({ status: "ok" });
  } catch (err) {
    res.status(502).json({ erro: "Falha ao salvar a meta.", detalhe: String(err.message || err) });
  }
};
