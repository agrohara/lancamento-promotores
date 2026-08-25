// Vercel Serverless Function — grava lançamentos direto na tabela Excel "Lancamentos"
// do arquivo no SharePoint, via Microsoft Graph API.
//
// As propriedades já são cadastradas antes, com dados completos, pelo assistente de
// cadastro (ver api/propriedades.js). Esta função só grava a transação de venda.
//
// Sem Power Automate, sem Power Apps, sem Azure — só Vercel (gratuito, sem cartão)
// + Microsoft Graph API + App Registration (client credentials) no Entra ID.
//
// CONFIGURAÇÃO (ver guia): defina estas variáveis em
// Vercel Dashboard > (seu projeto) > Settings > Environment Variables
//   TENANT_ID       - Directory (tenant) ID do App Registration
//   CLIENT_ID       - Application (client) ID do App Registration
//   CLIENT_SECRET   - segredo gerado no App Registration
//   API_KEY         - uma senha simples inventada por você, para proteger este endpoint
//                     (o HTML envia esse valor no cabeçalho x-api-key)
// Opcionais (só se o arquivo mudar de lugar): DRIVE_ID, ITEM_ID, TABLE_NAME

const { usuarioDaRequisicao } = require("./_lib/auth");

const DRIVE_ID_PADRAO = "b!239ib2QZ802QpEwVD6oJsGCs3VafFl1DpVud7XH4EwnllXBIIGjKQLlfWeBP3ZEo";
const ITEM_ID_PADRAO = "01EEWFJSXC3HLY3IR45NBJ7GFSWWONG7BK";
const TABLE_LANCAMENTOS_PADRAO = "Lancamentos";
const CARGOS_GESTAO = ["gerente", "desenvolvedor"];

function validarRegistro(r) {
  if (!r || typeof r !== "object") return false;
  // A observação da visita agora é registrada separadamente (ver api/visitas.js),
  // então aqui ela é opcional — o pedido pode ser lançado sozinho.
  if (!r.Nome_Promotor || !r.Revenda || !r.Propriedade || !r.Produto || !r.Dia_Lancamento || !r.Quinzena) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.Dia_Lancamento))) return false;

  const preco = Number(r.Preco_Unitario);
  const volume = Number(r.Volume);
  if (Number.isNaN(preco) || preco < 0) return false;
  if (Number.isNaN(volume) || volume <= 0) return false;

  return true;
}

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

async function obterLinhas(token, driveId, itemId, tableName) {
  const urlGraph = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/workbook/tables('${tableName}')/rows?$select=values`;
  const resp = await fetch(urlGraph, {
    method: "GET",
    headers: { "Authorization": `Bearer ${token}` }
  });
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const erro = new Error("Falha ao ler tabela '" + tableName + "'.");
    erro.detalhe = dados;
    throw erro;
  }
  return (dados.value || []).map(r => r.values && r.values[0]).filter(Boolean);
}

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

  if (req.method === "GET") {
    const usuario = usuarioDaRequisicao(req);
    if (!usuario) {
      res.status(401).json({ erro: "Sessão expirada ou inválida. Faça login novamente." });
      return;
    }
    const ehGestor = CARGOS_GESTAO.includes(String(usuario.cargo || "").toLowerCase());
    const promotorFiltro = ehGestor ? String((req.query && req.query.promotor) || "").trim() : usuario.nome;

    try {
      const token = await obterToken();
      const driveId = process.env.DRIVE_ID || DRIVE_ID_PADRAO;
      const itemId = process.env.ITEM_ID || ITEM_ID_PADRAO;
      const tableLancamentos = process.env.TABLE_NAME || TABLE_LANCAMENTOS_PADRAO;

      const linhas = await obterLinhas(token, driveId, itemId, tableLancamentos);
      let lancamentos = linhas.map(l => ({
        Nome_Promotor: String(l[0] || ""),
        Revenda: String(l[1] || ""),
        Propriedade: String(l[2] || ""),
        Produto: String(l[3] || ""),
        Unidade: String(l[4] || ""),
        Preco_Unitario: Number(l[5]) || 0,
        Volume: Number(l[6]) || 0,
        Valor_Total: Number(l[7]) || 0,
        Dia_Lancamento: String(l[8] || ""),
        Quinzena: String(l[9] || "")
      }));

      if (promotorFiltro) {
        lancamentos = lancamentos.filter(r => r.Nome_Promotor.toLowerCase() === promotorFiltro.toLowerCase());
      }

      lancamentos.sort((a, b) => b.Dia_Lancamento.localeCompare(a.Dia_Lancamento));

      res.status(200).json({ lancamentos });
    } catch (err) {
      res.status(502).json({ erro: "Falha ao ler lançamentos via Graph API.", detalhe: err.detalhe || String(err.message || err) });
    }
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ erro: "Use GET ou POST." });
    return;
  }

  let lancamentos = (req.body && req.body.lancamentos) || [];
  if (!Array.isArray(lancamentos) || lancamentos.length === 0) {
    res.status(400).json({ erro: "Envie 'lancamentos' como um array não vazio." });
    return;
  }

  // Se o usuário logado não for Gerente/Desenvolvedor, o nome do promotor gravado
  // é sempre o do próprio usuário logado — evita que alguém lance venda em nome de
  // outro promotor só editando o payload.
  const usuario = usuarioDaRequisicao(req);
  if (usuario && !CARGOS_GESTAO.includes(String(usuario.cargo || "").toLowerCase())) {
    lancamentos = lancamentos.map(r => ({ ...r, Nome_Promotor: usuario.nome }));
  }

  const invalidos = lancamentos.filter(r => !validarRegistro(r));
  if (invalidos.length > 0) {
    res.status(400).json({
      erro: "Um ou mais registros estão incompletos, com data em formato inválido (esperado AAAA-MM-DD) ou preço/volume inválidos.",
      invalidos
    });
    return;
  }

  try {
    const token = await obterToken();
    const driveId = process.env.DRIVE_ID || DRIVE_ID_PADRAO;
    const itemId = process.env.ITEM_ID || ITEM_ID_PADRAO;
    const tableLancamentos = process.env.TABLE_NAME || TABLE_LANCAMENTOS_PADRAO;

    const values = lancamentos.map(r => [
      r.Nome_Promotor,
      r.Revenda,
      r.Propriedade,
      r.Produto,
      r.Unidade || "",
      Number(r.Preco_Unitario),
      Number(r.Volume),
      Number(r.Preco_Unitario) * Number(r.Volume),
      r.Dia_Lancamento,
      r.Quinzena,
      r.Observacao_Visita || ""
    ]);

    const urlGraph = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/workbook/tables('${tableLancamentos}')/rows/add`;
    const respGraph = await fetch(urlGraph, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ values })
    });

    const dadosGraph = await respGraph.json().catch(() => ({}));

    if (!respGraph.ok) {
      res.status(502).json({ erro: "Falha ao gravar no Excel via Graph API.", detalhe: dadosGraph });
      return;
    }

    res.status(200).json({ status: "ok", inseridos: lancamentos.length });
  } catch (err) {
    res.status(500).json({ erro: "Erro interno.", detalhe: String(err.message || err) });
  }
};
