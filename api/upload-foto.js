// Vercel Serverless Function — recebe uma foto (já reduzida/comprimida no navegador)
// em base64 e sobe para uma pasta "Fotos Visitas" no mesmo Drive do SharePoint onde
// fica a planilha, via Microsoft Graph API. Devolve o link do arquivo para ser
// guardado na coluna Foto_URL da tabela "Visitas".
//
// POST /api/upload-foto
// Corpo esperado: { nomeArquivo: "visita.jpg", base64: "<...sem o prefixo data:...>" }
//
// Variáveis de ambiente: as mesmas de propriedades.js (TENANT_ID, CLIENT_ID,
// CLIENT_SECRET, API_KEY). Opcionais: DRIVE_ID, PASTA_FOTOS (padrão "Fotos Visitas")
//
// Limite: uploads simples via Graph (PUT direto) só funcionam até ~4MB. Por isso o
// navegador deve comprimir a foto (redimensionar + JPEG qualidade média) antes de
// enviar — ver função comprimirFoto() no index.html.

const DRIVE_ID_PADRAO = "b!239ib2QZ802QpEwVD6oJsGCs3VafFl1DpVud7XH4EwnllXBIIGjKQLlfWeBP3ZEo";
const PASTA_FOTOS_PADRAO = "Fotos Visitas";

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

async function garantirPasta(token, driveId, nomePasta) {
  const urlCheck = `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${encodeURIComponent(nomePasta)}`;
  const respCheck = await fetch(urlCheck, { headers: { "Authorization": `Bearer ${token}` } });
  if (respCheck.ok) return;

  const urlCreate = `https://graph.microsoft.com/v1.0/drives/${driveId}/root/children`;
  await fetch(urlCreate, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: nomePasta,
      folder: {},
      "@microsoft.graph.conflictBehavior": "fail"
    })
  });
}

function nomeSeguro(nome) {
  return String(nome || "foto")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 80);
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ erro: "Use POST." });
    return;
  }

  const chaveEnviada = req.headers["x-api-key"];
  if (!process.env.API_KEY || chaveEnviada !== process.env.API_KEY) {
    res.status(401).json({ erro: "Não autorizado." });
    return;
  }

  const { nomeArquivo, base64 } = req.body || {};
  if (!base64 || typeof base64 !== "string") {
    res.status(400).json({ erro: "Envie a foto em base64 no campo 'base64'." });
    return;
  }

  const base64Limpo = base64.includes(",") ? base64.split(",").pop() : base64;
  const buffer = Buffer.from(base64Limpo, "base64");

  const LIMITE_BYTES = 4 * 1024 * 1024;
  if (buffer.length > LIMITE_BYTES) {
    res.status(413).json({ erro: "Foto muito grande. Reduza a qualidade/tamanho antes de enviar (limite ~4MB)." });
    return;
  }

  try {
    const token = await obterToken();
    const driveId = process.env.DRIVE_ID || DRIVE_ID_PADRAO;
    const pasta = process.env.PASTA_FOTOS || PASTA_FOTOS_PADRAO;

    await garantirPasta(token, driveId, pasta);

    const arquivo = `${Date.now()}_${nomeSeguro(nomeArquivo)}`;
    if (!/\.(jpg|jpeg|png)$/i.test(arquivo)) {
      res.status(400).json({ erro: "Formato de arquivo não suportado (use jpg ou png)." });
      return;
    }

    const urlUpload = `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${encodeURIComponent(pasta)}/${encodeURIComponent(arquivo)}:/content`;
    const respUpload = await fetch(urlUpload, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": /\.png$/i.test(arquivo) ? "image/png" : "image/jpeg"
      },
      body: buffer
    });
    const dadosUpload = await respUpload.json().catch(() => ({}));

    if (!respUpload.ok) {
      res.status(502).json({ erro: "Falha ao subir a foto via Graph API.", detalhe: dadosUpload });
      return;
    }

    res.status(200).json({ status: "ok", url: dadosUpload.webUrl || "" });
  } catch (err) {
    res.status(500).json({ erro: "Erro interno.", detalhe: String(err.message || err) });
  }
};
