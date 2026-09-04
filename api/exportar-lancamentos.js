// ENDPOINT TEMPORÁRIO — só existe para migrar a tabela "Lancamentos" do SharePoint para o
// Supabase. Lê todos os lançamentos via Graph API (mesma tabela que api/lancamentos.js usa)
// e devolve tudo pronto para virar um CSV de importação no Supabase.
//
// IMPORTANTE: apagar este arquivo (api/exportar-lancamentos.js) assim que a migração da
// tabela Lancamentos terminar — ele não deve continuar publicado.
//
// GET /api/exportar-lancamentos

const { paraISO } = require("./_lib/datas");
const { paraNumero } = require("./_lib/numeros");

const DRIVE_ID_PADRAO = "b!239ib2QZ802QpEwVD6oJsGCs3VafFl1DpVud7XH4EwnllXBIIGjKQLlfWeBP3ZEo";
const ITEM_ID_PADRAO = "01EEWFJSXC3HLY3IR45NBJ7GFSWWONG7BK";
const TABLE_LANCAMENTOS_PADRAO = "Lancamentos";

async function obterToken() {
  const url = `https://login.microsoftonline.com/${process.env.TENANT_ID}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    client_id: process.env.CLIENT_ID,
    client_secret: process.env.CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials"
  });
  const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params });
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error("Falha ao obter token do Graph: " + JSON.stringify(dados));
  return dados.access_token;
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "GET") { res.status(405).json({ erro: "Use GET." }); return; }

  const chaveEnviada = req.headers["x-api-key"];
  if (!process.env.API_KEY || chaveEnviada !== process.env.API_KEY) {
    res.status(401).json({ erro: "Não autorizado." });
    return;
  }

  try {
    const tokenGraph = await obterToken();
    const driveId = process.env.DRIVE_ID || DRIVE_ID_PADRAO;
    const itemId = process.env.ITEM_ID || ITEM_ID_PADRAO;
    const tableName = process.env.TABLE_NAME || TABLE_LANCAMENTOS_PADRAO;

    const urlGraph = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/workbook/tables('${tableName}')/rows?$select=values`;
    const respGraph = await fetch(urlGraph, { method: "GET", headers: { "Authorization": `Bearer ${tokenGraph}` } });
    const dadosGraph = await respGraph.json().catch(() => ({}));
    if (!respGraph.ok) {
      res.status(502).json({ erro: "Falha ao consultar lançamentos via Graph API.", detalhe: dadosGraph });
      return;
    }

    const linhas = (dadosGraph.value || []).map(r => r.values && r.values[0]).filter(Boolean);
    const lancamentos = linhas
      .filter(l => l[0] && l[2] && l[3] && l[8])
      .map(l => ({
        nome_promotor: String(l[0] || "").trim(),
        revenda: String(l[1] || "").trim(),
        propriedade: String(l[2] || "").trim(),
        produto: String(l[3] || "").trim(),
        unidade: String(l[4] || "").trim(),
        preco_unitario: paraNumero(l[5]),
        volume: paraNumero(l[6]),
        valor_total: paraNumero(l[7]),
        dia_lancamento: paraISO(l[8]),
        quinzena: String(l[9] || "").trim(),
        observacao_visita: String(l[10] || "").trim()
      }))
      .filter(r => r.dia_lancamento);

    res.status(200).json({ lancamentos });
  } catch (err) {
    res.status(500).json({ erro: "Erro interno.", detalhe: String(err.message || err) });
  }
};
