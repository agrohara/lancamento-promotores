// Vercel Serverless Function — grava lançamentos direto na tabela Excel "Lancamentos"
// do arquivo no SharePoint, via Microsoft Graph API. Também cadastra automaticamente,
// na tabela "Propriedades", qualquer propriedade nova informada pelo promotor.
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
// Opcionais (só se o arquivo mudar de lugar): DRIVE_ID, ITEM_ID, TABLE_NAME, TABLE_PROPRIEDADES

const DRIVE_ID_PADRAO = "b!239ib2QZ802QpEwVD6oJsGCs3VafFl1DpVud7XH4EwnllXBIIGjKQLlfWeBP3ZEo";
const ITEM_ID_PADRAO = "01EEWFJSXC3HLY3IR45NBJ7GFSWWONG7BK";
const TABLE_LANCAMENTOS_PADRAO = "Lancamentos";
const TABLE_PROPRIEDADES_PADRAO = "Propriedades";

function validarRegistro(r) {
  if (!r || typeof r !== "object") return false;
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

async function obterLinhasTabela(token, driveId, itemId, tableName) {
  const urlGraph = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/workbook/tables('${tableName}')/rows?$select=values`;
  const resp = await fetch(urlGraph, {
    method: "GET",
    headers: { "Authorization": `Bearer ${token}` }
  });
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error("Falha ao ler tabela '" + tableName + "': " + JSON.stringify(dados));
  }
  return (dados.value || []).map(r => r.values && r.values[0]).filter(Boolean);
}

async function adicionarLinhas(token, driveId, itemId, tableName, values) {
  const urlGraph = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/workbook/tables('${tableName}')/rows/add`;
  const resp = await fetch(urlGraph, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ values })
  });
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const erro = new Error("Falha ao gravar na tabela '" + tableName + "'.");
    erro.detalhe = dados;
    throw erro;
  }
  return dados;
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

  const lancamentos = (req.body && req.body.lancamentos) || [];
  if (!Array.isArray(lancamentos) || lancamentos.length === 0) {
    res.status(400).json({ erro: "Envie 'lancamentos' como um array não vazio." });
    return;
  }

  const invalidos = lancamentos.filter(r => !validarRegistro(r));
  if (invalidos.length > 0) {
    res.status(400).json({
      erro: "Um ou mais registros estão incompletos, com data em formato inválido (esperado AAAA-MM-DD), preço/volume inválidos.",
      invalidos
    });
    return;
  }

  try {
    const token = await obterToken();
    const driveId = process.env.DRIVE_ID || DRIVE_ID_PADRAO;
    const itemId = process.env.ITEM_ID || ITEM_ID_PADRAO;
    const tableLancamentos = process.env.TABLE_NAME || TABLE_LANCAMENTOS_PADRAO;
    const tablePropriedades = process.env.TABLE_PROPRIEDADES || TABLE_PROPRIEDADES_PADRAO;

    // 1) garantir que toda propriedade nova citada nos lançamentos exista na tabela "Propriedades"
    const linhasExistentes = await obterLinhasTabela(token, driveId, itemId, tablePropriedades);
    const chavesExistentes = new Set(
      linhasExistentes.map(l => `${String(l[0] || "").trim().toLowerCase()}|||${String(l[1] || "").trim().toLowerCase()}`)
    );

    const paresNovos = [];
    const jaMarcadosNestaRequisicao = new Set();
    for (const r of lancamentos) {
      const revenda = String(r.Revenda).trim();
      const propriedade = String(r.Propriedade).trim();
      const chave = `${revenda.toLowerCase()}|||${propriedade.toLowerCase()}`;
      if (!chavesExistentes.has(chave) && !jaMarcadosNestaRequisicao.has(chave)) {
        jaMarcadosNestaRequisicao.add(chave);
        paresNovos.push([revenda, propriedade, String(r.Nome_Promotor).trim(), r.Dia_Lancamento]);
      }
    }

    if (paresNovos.length > 0) {
      await adicionarLinhas(token, driveId, itemId, tablePropriedades, paresNovos);
    }

    // 2) gravar os lançamentos
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
      r.Quinzena
    ]);

    await adicionarLinhas(token, driveId, itemId, tableLancamentos, values);

    res.status(200).json({
      status: "ok",
      inseridos: lancamentos.length,
      propriedadesCadastradas: paresNovos.length
    });
  } catch (err) {
    res.status(502).json({ erro: "Falha ao gravar no Excel via Graph API.", detalhe: err.detalhe || String(err.message || err) });
  }
};
