// Vercel Serverless Function — recebe uma foto (já reduzida/comprimida no navegador)
// em base64 e grava no Supabase Storage (bucket PÚBLICO "fotos"). Devolve a URL pública,
// que o app guarda junto da visita/pedido e embute nos PDFs.
//
// (Reescrita em 17/10/2026: antes subia para uma pasta do SharePoint via Microsoft Graph,
// cujo link exige login da Microsoft e não pode ser usado dentro de um PDF.)
//
// POST /api/upload-foto
// Corpo: { nomeArquivo: "visita.jpg", base64: "<...>", pasta: "visitas" | "pedidos" | "calendarios" }
// Cabeçalhos: x-api-key + Authorization: Bearer <token da sessão>
// Resposta: { status: "ok", url: "https://<projeto>.supabase.co/storage/v1/object/public/fotos/..." }
//
// Pré-requisito (uma vez): criar no Supabase o bucket "fotos" marcado como Public.
// Variáveis de ambiente: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, API_KEY, AUTH_SECRET.
//
// Limite: o corpo de uma função Vercel é limitado a ~4,5 MB; o navegador comprime a foto
// (lado maior 1280 px, JPEG ~0,72 ≈ 150–400 KB) antes de enviar.

const crypto = require("crypto");
const { usuarioDaRequisicao } = require("./_lib/auth");
const { obterSupabase } = require("./_lib/supabase");

const BUCKET = "fotos";
const PASTAS_VALIDAS = ["visitas", "pedidos", "calendarios", "despesas"];

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ erro: "Use POST." }); return; }

  if (!process.env.API_KEY || req.headers["x-api-key"] !== process.env.API_KEY) {
    res.status(401).json({ erro: "Não autorizado." });
    return;
  }
  const usuario = usuarioDaRequisicao(req);
  if (!usuario) {
    res.status(401).json({ erro: "Sessão expirada ou inválida. Faça login novamente." });
    return;
  }

  const { nomeArquivo, base64, pasta } = req.body || {};
  if (!base64 || typeof base64 !== "string") {
    res.status(400).json({ erro: "Envie o arquivo em base64 no campo 'base64'." });
    return;
  }
  const limpo = base64.includes(",") ? base64.split(",").pop() : base64;
  const buffer = Buffer.from(limpo, "base64");
  if (buffer.length === 0) { res.status(400).json({ erro: "Arquivo vazio." }); return; }
  if (buffer.length > 4 * 1024 * 1024) {
    res.status(413).json({ erro: "Arquivo muito grande (limite ~4MB)." });
    return;
  }

  const ehPng = /\.png$/i.test(String(nomeArquivo || ""));
  const extensao = ehPng ? "png" : "jpg";
  const tipoConteudo = ehPng ? "image/png" : "image/jpeg";
  const pastaFinal = PASTAS_VALIDAS.includes(pasta) ? pasta : "visitas";
  const agora = new Date();
  const mes = `${agora.getUTCFullYear()}-${String(agora.getUTCMonth() + 1).padStart(2, "0")}`;
  // Nome aleatório: a URL pública não é adivinhável.
  const caminho = `${pastaFinal}/${mes}/${crypto.randomUUID()}.${extensao}`;

  try {
    const supabase = obterSupabase();
    const { error } = await supabase.storage.from(BUCKET).upload(caminho, buffer, {
      contentType: tipoConteudo,
      upsert: false
    });
    if (error) throw error;
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(caminho);
    res.status(200).json({ status: "ok", url: data.publicUrl });
  } catch (err) {
    res.status(502).json({ erro: "Falha ao gravar a foto no armazenamento.", detalhe: String(err.message || err) });
  }
};
