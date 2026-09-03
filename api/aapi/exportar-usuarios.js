// ENDPOINT TEMPORÁRIO — só existe para migrar a tabela "Usuarios" do SharePoint para o
// Supabase. Lê os usuários via Graph API (mesma tabela que api/login.js usa), converte a
// senha de cada um em hash (nunca devolve a senha em texto puro) e devolve tudo pronto
// para virar um CSV de importação no Supabase.
//
// IMPORTANTE: apagar este arquivo (api/exportar-usuarios.js) assim que a migração da
// tabela Usuarios terminar — ele não deve continuar publicado.
//
// GET /api/exportar-usuarios

const { hashSenha } = require("./_lib/auth");

const DRIVE_ID_PADRAO = "b!239ib2QZ802QpEwVD6oJsGCs3VafFl1DpVud7XH4EwnllXBIIGjKQLlfWeBP3ZEo";
const ITEM_ID_PADRAO = "01EEWFJSXC3HLY3IR45NBJ7GFSWWONG7BK";
const TABLE_USUARIOS_PADRAO = "Usuarios";

function normalizarCargo(cargo) {
  const c = String(cargo || "").trim().toLowerCase();
  if (c.includes("desenvolv")) return "Desenvolvedor";
  if (c.includes("gerente")) return "Gerente";
  return "Promotor";
}

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
    const tableName = process.env.TABLE_USUARIOS || TABLE_USUARIOS_PADRAO;

    const urlGraph = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/workbook/tables('${tableName}')/rows?$select=values`;
    const respGraph = await fetch(urlGraph, { method: "GET", headers: { "Authorization": `Bearer ${tokenGraph}` } });
    const dadosGraph = await respGraph.json().catch(() => ({}));
    if (!respGraph.ok) {
      res.status(502).json({ erro: "Falha ao consultar usuários via Graph API.", detalhe: dadosGraph });
      return;
    }

    const linhas = (dadosGraph.value || []).map(r => r.values && r.values[0]).filter(Boolean);
    const usuarios = linhas
      .filter(l => l[0] && String(l[0]).trim())
      .map(l => {
        const [nome, cargo, senhaPlana] = l;
        return {
          login: String(nome).trim(),
          nome: String(nome).trim(),
          cargo: normalizarCargo(cargo).toLowerCase(),
          senha_hash: hashSenha(String(senhaPlana || "").trim())
        };
      });

    res.status(200).json({ usuarios });
  } catch (err) {
    res.status(500).json({ erro: "Erro interno.", detalhe: String(err.message || err) });
  }
};
