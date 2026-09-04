// Vercel Serverless Function — devolve TODAS as tabelas do Supabase (propriedades,
// produtos, usuarios, visitas, lancamentos) num único JSON, pra servir de backup.
// Fica publicado (protegido pela mesma x-api-key de sempre) e é chamado uma vez por
// semana por uma tarefa agendada, que salva a resposta como um arquivo datado.
//
// GET /api/backup

const { obterSupabase, buscarTodasLinhas } = require("./_lib/supabase");

const TABELAS = ["propriedades", "produtos", "usuarios", "visitas", "lancamentos"];

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "GET") { res.status(405).json({ erro: "Use GET." }); return; }

  const chaveEnviada = req.headers["x-api-key"];
  if (!process.env.API_KEY || chaveEnviada !== process.env.API_KEY) {
    res.status(401).json({ erro: "Não autorizado." });
    return;
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ erro: "Banco de dados não configurado (faltam SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)." });
    return;
  }

  try {
    const supabase = obterSupabase();
    const resultados = {};
    for (const tabela of TABELAS) {
      resultados[tabela] = await buscarTodasLinhas(supabase, tabela, "*", null);
    }
    res.status(200).json({
      geradoEm: new Date().toISOString(),
      tabelas: resultados
    });
  } catch (err) {
    res.status(500).json({ erro: "Falha ao gerar backup.", detalhe: String(err.message || err) });
  }
};
