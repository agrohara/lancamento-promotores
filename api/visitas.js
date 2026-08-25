// Vercel Serverless Function — grava registros de VISITA (separados do PEDIDO) na
// tabela Excel "Visitas" do SharePoint, via Microsoft Graph API.
//
// A Visita guarda o "como foi" (tipo, observação, foto). O Pedido
// (ver api/lancamentos.js) guarda o "o que foi vendido". São duas gravações
// separadas, feitas em telas separadas no app, mas para a mesma fazenda/dia.
//
// POST /api/visitas               -> grava uma visita nova
// GET  /api/visitas                -> lista visitas do promotor logado
// GET  /api/visitas?promotor=X    -> (Gerente/Desenvolvedor) lista visitas de um promotor
// GET  /api/visitas?todos=1       -> (Gerente/Desenvolvedor) lista visitas de todo mundo
// Ambos os GET exigem Authorization: Bearer <token do login>
//
// Ordem das colunas na tabela "Visitas":
//   Nome_Promotor | Propriedade | Tipo_Visita | Observacao | Foto_URL | Latitude |
//   Longitude | Dia_Visita | Quinzena
//
// Variáveis de ambiente: as mesmas de lancamentos.js (TENANT_ID, CLIENT_ID,
// CLIENT_SECRET, API_KEY). Opcionais: DRIVE_ID, ITEM_ID, TABLE_VISITAS (padrão "Visitas")

const { usuarioDaRequisicao } = require("./_lib/auth");
const { paraISO } = require("./_lib/datas");

const DRIVE_ID_PADRAO = "b!239ib2QZ802QpEwVD6oJsGCs3VafFl1DpVud7XH4EwnllXBIIGjKQLlfWeBP3ZEo";
const ITEM_ID_PADRAO = "01EEWFJSXC3HLY3IR45NBJ7GFSWWONG7BK";
const TABLE_VISITAS_PADRAO = "Visitas";
const CARGOS_GESTAO = ["gerente", "desenvolvedor"];

function validarVisita(v) {
  if (!v || typeof v !== "object") return false;
  if (!v.Nome_Promotor || !v.Propriedade || !v.Tipo_Visita || !v.Observacao || !v.Dia_Visita || !v.Quinzena) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v.Dia_Visita))) return false;
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
      const tableVisitas = process.env.TABLE_VISITAS || TABLE_VISITAS_PADRAO;

      const linhas = await obterLinhas(token, driveId, itemId, tableVisitas);
      let visitas = linhas.map(l => ({
        Nome_Promotor: String(l[0] || ""),
        Propriedade: String(l[1] || ""),
        Tipo_Visita: String(l[2] || ""),
        Observacao: String(l[3] || ""),
        Foto_URL: String(l[4] || ""),
        Dia_Visita: paraISO(l[7]),
        Quinzena: String(l[8] || "")
      }));

      if (promotorFiltro) {
        visitas = visitas.filter(v => v.Nome_Promotor.toLowerCase() === promotorFiltro.toLowerCase());
      }

      visitas.sort((a, b) => b.Dia_Visita.localeCompare(a.Dia_Visita));

      res.status(200).json({ visitas });
    } catch (err) {
      res.status(502).json({ erro: "Falha ao ler visitas via Graph API.", detalhe: err.detalhe || String(err.message || err) });
    }
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ erro: "Use GET ou POST." });
    return;
  }

  let visita = req.body || {};

  // Se o usuário logado não for Gerente/Desenvolvedor, o nome do promotor gravado
  // é sempre o do próprio usuário logado — evita registrar visita em nome de outro.
  const usuario = usuarioDaRequisicao(req);
  if (usuario && !CARGOS_GESTAO.includes(String(usuario.cargo || "").toLowerCase())) {
    visita = { ...visita, Nome_Promotor: usuario.nome };
  }

  if (!validarVisita(visita)) {
    res.status(400).json({
      erro: "Dados incompletos: informe promotor, propriedade, tipo de visita, observação, data (AAAA-MM-DD) e quinzena."
    });
    return;
  }

  try {
    const token = await obterToken();
    const driveId = process.env.DRIVE_ID || DRIVE_ID_PADRAO;
    const itemId = process.env.ITEM_ID || ITEM_ID_PADRAO;
    const tableVisitas = process.env.TABLE_VISITAS || TABLE_VISITAS_PADRAO;

    const linha = [[
      visita.Nome_Promotor,
      visita.Propriedade,
      visita.Tipo_Visita,
      visita.Observacao,
      visita.Foto_URL || "",
      visita.Latitude === undefined || visita.Latitude === null ? "" : Number(visita.Latitude),
      visita.Longitude === undefined || visita.Longitude === null ? "" : Number(visita.Longitude),
      visita.Dia_Visita,
      visita.Quinzena
    ]];

    const urlGraph = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/workbook/tables('${tableVisitas}')/rows/add`;
    const respGraph = await fetch(urlGraph, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ values: linha })
    });

    const dadosGraph = await respGraph.json().catch(() => ({}));

    if (!respGraph.ok) {
      res.status(502).json({ erro: "Falha ao gravar a visita via Graph API.", detalhe: dadosGraph });
      return;
    }

    res.status(200).json({ status: "ok" });
  } catch (err) {
    res.status(500).json({ erro: "Erro interno.", detalhe: String(err.message || err) });
  }
};
