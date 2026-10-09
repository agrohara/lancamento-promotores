// Vercel Serverless Function — devolve e GRAVA um backup com TODAS as tabelas do
// Supabase num único JSON.
//
// A tabela "usuarios" foi removida da lista de propósito: ela nunca existiu no Supabase
// (o cadastro de usuários mora numa planilha Excel no SharePoint), e fazia toda chamada
// a este endpoint falhar com erro 500. Também foram adicionadas as tabelas que faltavam
// (metas_revenda, metas_revenda_historico, cestas, metas_cesta, agenda_compromissos).
//
// Aceita duas formas de autenticação:
//   a) x-api-key (chamada manual / teste);
//   b) Authorization: Bearer <CRON_SECRET> (chamada automática do Vercel Cron,
//      configurada em vercel.json, na raiz do projeto).
// Em qualquer chamada autenticada, o resultado é gravado no Supabase Storage, no bucket
// "backups", como um arquivo datado (backup-AAAA-MM-DD.json).

const { obterSupabase, buscarTodasLinhas } = require("./_lib/supabase");

const TABELAS = [
  "propriedades",
  "produtos",
  "lancamentos",
  "visitas",
  "metas_revenda",
  "metas_revenda_historico",
  "cestas",
  "metas_cesta",
  "agenda_compromissos"
];

const NOME_BUCKET = "backups";

function autenticado(req) {
  const chaveEnviada = req.headers["x-api-key"];
  if (process.env.API_KEY && chaveEnviada === process.env.API_KEY) return true;

  const auth = req.headers["authorization"] || "";
  if (process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`) return true;

  return false;
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "GET") { res.status(405).json({ erro: "Use GET." }); return; }

  if (!autenticado(req)) {
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
      // Uma tabela com problema não derruba o backup inteiro.
      try {
        resultados[tabela] = await buscarTodasLinhas(supabase, tabela, "*", null);
      } catch (erroTabela) {
        resultados[tabela] = { erro: String(erroTabela.message || erroTabela) };
      }
    }

    const geradoEm = new Date();
    const corpo = {
      geradoEm: geradoEm.toISOString(),
      tabelas: resultados
    };

    const dataArquivo = geradoEm.toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
    const caminhoArquivo = `backup-${dataArquivo}.json`;
    let salvoNoStorage = false;
    let erroStorage = null;
    try {
      const { error: erroUpload } = await supabase.storage
        .from(NOME_BUCKET)
        .upload(caminhoArquivo, Buffer.from(JSON.stringify(corpo, null, 2)), {
          contentType: "application/json",
          upsert: true
        });
      if (erroUpload) throw erroUpload;
      salvoNoStorage = true;
    } catch (erro) {
      erroStorage = String(erro.message || erro);
    }

    res.status(200).json({
      ...corpo,
      salvoNoStorage,
      arquivo: salvoNoStorage ? `${NOME_BUCKET}/${caminhoArquivo}` : null,
      erroStorage
    });
  } catch (err) {
    res.status(500).json({ erro: "Falha ao gerar backup.", detalhe: String(err.message || err) });
  }
};
