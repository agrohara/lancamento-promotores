// Vercel Serverless Function — lê e cria registros na tabela "Propriedades" do Excel,
// via Microsoft Graph API. O catálogo é GLOBAL (uma propriedade não pertence a uma
// única revenda — pode ser atendida por revendas diferentes da carteira de cada promotor).
//
// GET  /api/propriedades          -> lista os nomes de todas as propriedades cadastradas
// POST /api/propriedades          -> cadastra uma propriedade nova, com os dados completos
//
// Ordem das colunas na tabela "Propriedades":
//   Propriedade | Municipio | Proprietario | Decisor | Vendedor_Responsavel | Tipo_Propriedade |
//   Matrizes | Primiparas | Novilhas | Bezerros_Machos | Bezerros_Femeas | Garrotes | Touros |
//   Equinos | Cadastrada_Por | Data_Cadastro
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

function validarCadastro(p) {
  if (!p || typeof p !== "object") return false;
  if (!p.Propriedade || !String(p.Propriedade).trim()) return false;
  if (!p.Municipio || !String(p.Municipio).trim()) return false;
  if (!p.Proprietario || !String(p.Proprietario).trim()) return false;
  if (!p.Vendedor_Responsavel || !String(p.Vendedor_Responsavel).trim()) return false;
  if (!p.Tipo_Propriedade || !String(p.Tipo_Propriedade).trim()) return false;

  const camposNumericos = ["Matrizes", "Primiparas", "Novilhas", "Bezerros_Machos", "Bezerros_Femeas", "Garrotes", "Touros", "Equinos"];
  for (const campo of camposNumericos) {
    const valor = Number(p[campo]);
    if (Number.isNaN(valor) || valor < 0) return false;
  }
  return true;
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

  const driveId = process.env.DRIVE_ID || DRIVE_ID_PADRAO;
  const itemId = process.env.ITEM_ID || ITEM_ID_PADRAO;
  const tableName = process.env.TABLE_PROPRIEDADES || TABLE_PROPRIEDADES_PADRAO;

  if (req.method === "GET") {
    try {
      const token = await obterToken();
      const linhas = await obterLinhas(token, driveId, itemId, tableName);

      const propriedades = [...new Set(
        linhas
          .map(l => String(l[0] || "").trim())
          .filter(Boolean)
      )].sort((a, b) => a.localeCompare(b, "pt-BR"));

      res.status(200).json({ propriedades });
    } catch (err) {
      res.status(502).json({ erro: "Falha ao ler propriedades via Graph API.", detalhe: err.detalhe || String(err.message || err) });
    }
    return;
  }

  if (req.method === "POST") {
    const dadosBody = req.body || {};
    if (!validarCadastro(dadosBody)) {
      res.status(400).json({ erro: "Dados incompletos ou inválidos para o cadastro da propriedade." });
      return;
    }

    try {
      const token = await obterToken();
      const linhas = await obterLinhas(token, driveId, itemId, tableName);
      const nomeNovo = String(dadosBody.Propriedade).trim();

      const jaExiste = linhas.some(l => String(l[0] || "").trim().toLowerCase() === nomeNovo.toLowerCase());
      if (jaExiste) {
        res.status(409).json({ erro: "Já existe uma propriedade cadastrada com esse nome. Busque por ela na tela anterior." });
        return;
      }

      const agora = new Date();
      const dataCadastro = agora.toISOString().slice(0, 10);

      const linhaNova = [[
        nomeNovo,
        String(dadosBody.Municipio).trim(),
        String(dadosBody.Proprietario).trim(),
        String(dadosBody.Decisor || "").trim(),
        String(dadosBody.Vendedor_Responsavel).trim(),
        String(dadosBody.Tipo_Propriedade).trim(),
        Number(dadosBody.Matrizes) || 0,
        Number(dadosBody.Primiparas) || 0,
        Number(dadosBody.Novilhas) || 0,
        Number(dadosBody.Bezerros_Machos) || 0,
        Number(dadosBody.Bezerros_Femeas) || 0,
        Number(dadosBody.Garrotes) || 0,
        Number(dadosBody.Touros) || 0,
        Number(dadosBody.Equinos) || 0,
        String(dadosBody.Cadastrada_Por || "").trim(),
        dataCadastro
      ]];

      const urlAdd = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/workbook/tables('${tableName}')/rows/add`;
      const respAdd = await fetch(urlAdd, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ values: linhaNova })
      });
      const dadosAdd = await respAdd.json().catch(() => ({}));

      if (!respAdd.ok) {
        res.status(502).json({ erro: "Falha ao gravar a propriedade via Graph API.", detalhe: dadosAdd });
        return;
      }

      res.status(201).json({ status: "ok", propriedade: nomeNovo });
    } catch (err) {
      res.status(502).json({ erro: "Falha ao cadastrar propriedade.", detalhe: err.detalhe || String(err.message || err) });
    }
    return;
  }

  res.status(405).json({ erro: "Use GET ou POST." });
};
