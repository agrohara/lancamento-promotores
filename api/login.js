// Vercel Serverless Function — autentica o usuário (Gerente ou Promotor) contra a
// tabela "Usuarios" do Excel no SharePoint, via Microsoft Graph API, e devolve um
// token assinado que o app guarda no navegador para as próximas requisições.
//
// Tabela "Usuarios" — colunas nesta ordem:
//   PROMOTOR | CARGO | SENHA
//   (PROMOTOR é usado como nome de exibição E como login; CARGO = "PROMOTOR",
//   "GERENTE" ou "DESENVOLVER"; SENHA fica em texto puro — aceitável para esta
//   ferramenta interna de baixo risco. Sem coluna de "Ativo": todo mundo na
//   tabela é considerado ativo.)
//
// Variáveis de ambiente necessárias (além das já existentes TENANT_ID, CLIENT_ID,
// CLIENT_SECRET, API_KEY, DRIVE_ID, ITEM_ID):
//   AUTH_SECRET   - uma string secreta qualquer, só sua, usada para assinar os tokens.
//                   Troque por algo longo e aleatório.
// Opcional: TABLE_USUARIOS (padrão "Usuarios")

const { hashSenha, criarToken } = require("./_lib/auth");

// Normaliza variações de escrita do cargo (ex.: "Gerente", "Desenvolver",
// "Desenvolvedor") para os valores canônicos que o resto do sistema espera:
// "Gerente", "Desenvolvedor" ou "Promotor".
function normalizarCargo(cargo) {
  const c = String(cargo || "").trim().toLowerCase();
  if (c.includes("desenvolv")) return "Desenvolvedor";
  if (c.includes("gerente")) return "Gerente";
  return "Promotor";
}

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
    // cada linha: [PROMOTOR, CARGO, SENHA] — o valor de PROMOTOR serve como nome E como login
    const linhaUsuario = linhas.find(l => String(l[0] || "").trim().toLowerCase() === String(login).trim().toLowerCase());

    if (!linhaUsuario) {
      res.status(401).json({ erro: "Login ou senha inválidos." });
      return;
    }

    const [nome, cargo, senhaPlana] = linhaUsuario;

    if (String(senha) !== String(senhaPlana || "").trim()) {
      res.status(401).json({ erro: "Login ou senha inválidos." });
      return;
    }

    const cargoNormalizado = normalizarCargo(cargo);
    const token = criarToken({ login: String(login).trim(), nome, cargo: cargoNormalizado });
    res.status(200).json({ token, nome, cargo: cargoNormalizado });
  } catch (err) {
    res.status(500).json({ erro: "Erro interno.", detalhe: String(err.message || err) });
  }
};

// Exportado só para eu conseguir gerar hashes de senha localmente ao preparar a
// tabela Usuarios pela primeira vez (não é chamado pelo Vercel).
module.exports.hashSenha = hashSenha;
