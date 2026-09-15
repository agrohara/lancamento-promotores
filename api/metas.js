// Vercel Serverless Function — meta semanal de vendas por revenda, cadastrada pelo
// Gerente/Desenvolvedor. Usada pra mostrar ao promotor (e ao gestor) o progresso da
// semana atual em relação à meta de cada revenda (ver api/relatorios.js, que junta essa
// meta com o total vendido na semana).
//
// GET  /api/metas                       -> qualquer usuário logado pode ler (precisa pra
//                                          mostrar o progresso). Devolve a meta ATUAL de
//                                          cada revenda.
// GET  /api/metas?historico=1&revenda=X -> histórico de metas já cadastradas pra essa
//                                          revenda (valor + semana em que foi definido),
//                                          mais recente primeiro.
// POST /api/metas                       -> só Gerente/Desenvolvedor. Body: { Revenda,
//                                          Meta_Semanal }. Atualiza o valor atual (upsert
//                                          pelo nome da revenda) E grava uma linha nova no
//                                          histórico, com a semana em que foi cadastrado —
//                                          o histórico nunca é sobrescrito/apagado.
//
// Colunas da tabela "metas_revenda" no Supabase: revenda (chave), meta_semanal,
// atualizado_por, atualizado_em.
// Colunas da tabela "metas_revenda_historico": revenda, meta_semanal, semana_cadastro,
// atualizado_por, criado_em.
//
// Variáveis de ambiente necessárias: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, API_KEY,
// AUTH_SECRET.

const { usuarioDaRequisicao } = require("./_lib/auth");
const { obterSupabase } = require("./_lib/supabase");
const { quinzenaChave, quinzenaRotulo } = require("./_lib/quinzenas");

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
    const querHistorico = req.query && (req.query.historico === "1" || req.query.historico === "true");
    if (querHistorico) {
      const revendaBuscada = String((req.query && req.query.revenda) || "").trim();
      if (!revendaBuscada) {
        res.status(400).json({ erro: "Informe a revenda pra ver o histórico." });
        return;
      }
      try {
        const { data, error } = await supabase
          .from("metas_revenda_historico")
          .select("revenda, meta_semanal, semana_cadastro, atualizado_por, criado_em")
          .ilike("revenda", revendaBuscada)
          .order("criado_em", { ascending: false });
        if (error) throw error;
        const historico = (data || []).map(h => ({
          Revenda: h.revenda,
          Meta_Semanal: Number(h.meta_semanal) || 0,
          Semana_Cadastro: h.semana_cadastro || "",
          Atualizado_Por: h.atualizado_por || "",
          Criado_Em: h.criado_em
        }));
        res.status(200).json({ historico });
      } catch (err) {
        res.status(502).json({ erro: "Falha ao ler o histórico de metas.", detalhe: String(err.message || err) });
      }
      return;
    }

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

    // Registra no histórico — nunca sobrescreve, só acrescenta. Se isso falhar por algum
    // motivo, não desfaz o salvamento da meta atual (que já deu certo acima).
    const semanaCadastro = quinzenaRotulo(quinzenaChave(new Date().toISOString().slice(0, 10)));
    await supabase.from("metas_revenda_historico").insert({
      revenda,
      meta_semanal: meta,
      semana_cadastro: semanaCadastro,
      atualizado_por: usuario.nome
    });

    res.status(200).json({ status: "ok" });
  } catch (err) {
    res.status(502).json({ erro: "Falha ao salvar a meta.", detalhe: String(err.message || err) });
  }
};
