// Vercel Serverless Function — autentica o usuário (Gerente ou Promotor) contra a
// tabela "Usuarios" do Excel no SharePoint, via Microsoft Graph API, e devolve um
// token assinado que o app guarda no navegador para as próximas requisições.
//
// Tabela "Usuarios" — colunas nesta ordem:
//   Nome | Login | Senha_Hash | Cargo | Ativo
//   (Cargo = "Gerente" ou "Promotor"; Ativo = TRUE/FALSE)
//
// Variáveis de ambiente necessárias (além das já existentes TENANT_ID, CLIENT_ID,
// CLIENT_SECRET, API_KEY, DRIVE_ID, ITEM_ID):
//   AUTH_SECRET   - uma string secreta qualquer, só sua, usada para assinar os tokens
//                   e gerar os hashes de senha. Troque por algo longo e aleatório.
// Opcional: TABLE_USUARIOS (padrão "Usuarios")

const { hashSenha, senhaConfere, criarToken } = require("./_lib/auth");

const DRIVE_ID_PADRAO = "b!239ib2QZ802QpEwVD6oJsGCs3VafFl1DpVud7XH4EwnllXBIIGjKQLlfWeBP3ZEo";
const ITEM_ID_PADRAO = "01EEWFJSXC3HLY3IR45NBJ7GFSWWONG7BK";
const TABLE_USUARIOS_PADRAO = "Usuarios";

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

  if (req.method !== "POST") {
    res.status(405).json({ erro: "Use POST." });
    return;
  }

  const chaveEnviada = req.headers["x-api-key"];
  if (!process.env.API_KEY || chaveEnviada !== process.env.API_KEY) {
    res.status(401).json({ erro: "Não autorizado." });
    return;
  }

  const { login, senha } = req.body || {};
  if (!login || !senha) {
    res.status(400).json({ erro: "Informe login e senha." });
    return;
  }

  try {
    const tokenGraph = await obterToken();
    const driveId = process.env.DRIVE_ID || DRIVE_ID_PADRAO;
    const itemId = process.env.ITEM_ID || ITEM_ID_PADRAO;
    const tableName = process.env.TABLE_USUARIOS || TABLE_USUARIOS_PADRAO;

    const urlGraph = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/workbook/tables('${tableName}')/rows?$select=values`;
    const respGraph = await fetch(urlGraph, {
      method: "GET",
      headers: { "Authorization": `Bearer ${tokenGraph}` }
    });
    const dadosGraph = await respGraph.json().catch(() => ({}));

    if (!respGraph.ok) {
      res.status(502).json({ erro: "Falha ao consultar usuários via Graph API.", detalhe: dadosGraph });
      return;
    }

    const linhas = (dadosGraph.value || []).map(r => r.values && r.values[0]).filter(Boolean);
    // cada linha: [Nome, Login, Senha_Hash, Cargo, Ativo]
    const linhaUsuario = linhas.find(l => String(l[1] || "").trim().toLowerCase() === String(login).trim().toLowerCase());

    if (!linhaUsuario) {
      res.status(401).json({ erro: "Login ou senha inválidos." });
      return;
    }

    const [nome, , senhaHash, cargo, ativo] = linhaUsuario;

    const estaAtivo = ativo === true || String(ativo).trim().toUpperCase() === "TRUE" || String(ativo).trim() === "1";
    if (!estaAtivo) {
      res.status(401).json({ erro: "Usuário desativado. Fale com seu gerente." });
      return;
    }

    if (!senhaConfere(senha, senhaHash)) {
      res.status(401).json({ erro: "Login ou senha inválidos." });
      return;
    }

    const token = criarToken({ login: String(login).trim(), nome, cargo });
    res.status(200).json({ token, nome, cargo });
  } catch (err) {
    res.status(500).json({ erro: "Erro interno.", detalhe: String(err.message || err) });
  }
};

// Exportado só para eu conseguir gerar hashes de senha localmente ao preparar a
// tabela Usuarios pela primeira vez (não é chamado pelo Vercel).
module.exports.hashSenha = hashSenha;
