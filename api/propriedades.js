// Vercel Serverless Function — lê a tabela "Propriedades" do Excel via Microsoft Graph API
// e devolve as propriedades já cadastradas para uma revenda específica.
//
// Usa as mesmas variáveis de ambiente de lancamentos.js:
//   TENANT_ID, CLIENT_ID, CLIENT_SECRET, API_KEY
// Opcionais: DRIVE_ID, ITEM_ID, TABLE_PROPRIEDADES

const DRIVE_ID_PADRAO = "b!239ib2QZ802QpEwVD6oJsGCs3VafFl1DpVud7XH4EwnllXBIIGjKQLlfWeBP3ZEo";
const ITEM_ID_PADRAO = "01EEWFJSXC3HLY3IR45NBJ7GFSWWONG7BK";
const TABLE_PROPRIEDADES_PADRAO = "Propriedades";

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

  const revenda = String(req.query.revenda || "").trim();
  if (!revenda) {
    res.status(400).json({ erro: "Informe o parâmetro 'revenda'." });
    return;
  }

  try {
    const token = await obterToken();
    const driveId = process.env.DRIVE_ID || DRIVE_ID_PADRAO;
    const itemId = process.env.ITEM_ID || ITEM_ID_PADRAO;
    const tableName = process.env.TABLE_PROPRIEDADES || TABLE_PROPRIEDADES_PADRAO;

    const urlGraph = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/workbook/tables('${tableName}')/rows?$select=values`;

    const respGraph = await fetch(urlGraph, {
      method: "GET",
      headers: { "Authorization": `Bearer ${token}` }
    });

    const dadosGraph = await respGraph.json().catch(() => ({}));

    if (!respGraph.ok) {
      res.status(502).json({ erro: "Falha ao ler propriedades via Graph API.", detalhe: dadosGraph });
      return;
    }

    const linhas = (dadosGraph.value || [])
      .map(r => r.values && r.values[0])
      .filter(Boolean);

    const propriedades = [...new Set(
      linhas
        .filter(l => String(l[0] || "").trim().toLowerCase() === revenda.toLowerCase())
        .map(l => String(l[1] || "").trim())
        .filter(Boolean)
    )].sort((a, b) => a.localeCompare(b, "pt-BR"));

    res.status(200).json({ propriedades });
  } catch (err) {
    res.status(500).json({ erro: "Erro interno.", detalhe: String(err.message || err) });
  }
};
