// Vercel Serverless Function — catálogo de produtos, agora editável pelo Gerente
// direto no app (antes era uma lista fixa dentro do HTML).
//
// GET   /api/produtos           -> lista os produtos (todos, com o campo Ativo)
// POST  /api/produtos           -> cadastra um produto novo (só Gerente/Desenvolvedor)
// PATCH /api/produtos           -> edita um produto existente, buscando pelo nome atual
//                                   (só Gerente/Desenvolvedor)
//
// Ordem das colunas na tabela "Produtos":
//   Produto | Unidade | Preco_Padrao | Ativo
//
// Usa as mesmas variáveis de ambiente dos outros endpoints:
//   TENANT_ID, CLIENT_ID, CLIENT_SECRET, API_KEY, AUTH_SECRET
// Opcionais: DRIVE_ID, ITEM_ID, TABLE_PRODUTOS (padrão "Produtos")

const { usuarioDaRequisicao } = require("./_lib/auth");

const DRIVE_ID_PADRAO = "b!239ib2QZ802QpEwVD6oJsGCs3VafFl1DpVud7XH4EwnllXBIIGjKQLlfWeBP3ZEo";
const ITEM_ID_PADRAO = "01EEWFJSXC3HLY3IR45NBJ7GFSWWONG7BK";
const TABLE_PRODUTOS_PADRAO = "Produtos";

const CARGOS_QUE_EDITAM = ["gerente", "desenvolvedor"];

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

async function obterLinhasComIndice(token, driveId, itemId, tableName) {
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
  return (dados.value || []).map((r, i) => ({ indice: i, valores: r.values && r.values[0] })).filter(l => l.valores);
}

function podeEditar(usuario) {
  return !!usuario && CARGOS_QUE_EDITAM.includes(String(usuario.cargo || "").toLowerCase());
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
  const tableName = process.env.TABLE_PRODUTOS || TABLE_PRODUTOS_PADRAO;

  if (req.method === "GET") {
    try {
      const token = await obterToken();
      const linhas = await obterLinhasComIndice(token, driveId, itemId, tableName);

      const produtos = linhas.map(l => ({
        Produto: String(l.valores[0] || "").trim(),
        Unidade: String(l.valores[1] || "").trim(),
        Preco_Padrao: l.valores[2] === "" || l.valores[2] === undefined ? null : Number(l.valores[2]),
        // Trata como ativo tudo que não for explicitamente "falso" — cobre TRUE/VERDADEIRO/1/
        // vazio, já que nem todo cliente do Excel grava o booleano do mesmo jeito.
        Ativo: !["false", "falso", "0", "não", "nao", "inativo"].includes(
          String(l.valores[3] === undefined || l.valores[3] === null ? "" : l.valores[3]).trim().toLowerCase()
        )
      })).filter(p => p.Produto);

      produtos.sort((a, b) => a.Produto.localeCompare(b.Produto, "pt-BR"));

      res.status(200).json({ produtos });
    } catch (err) {
      res.status(502).json({ erro: "Falha ao ler produtos via Graph API.", detalhe: err.detalhe || String(err.message || err) });
    }
    return;
  }

  const usuario = usuarioDaRequisicao(req);
  if (!podeEditar(usuario)) {
    res.status(403).json({ erro: "Só Gerente ou Desenvolvedor podem editar o catálogo." });
    return;
  }

  if (req.method === "POST") {
    const corpo = req.body || {};
    const nome = String(corpo.Produto || "").trim();
    const unidade = String(corpo.Unidade || "").trim();
    const preco = corpo.Preco_Padrao === "" || corpo.Preco_Padrao === undefined || corpo.Preco_Padrao === null
      ? "" : Number(corpo.Preco_Padrao);

    if (!nome) {
      res.status(400).json({ erro: "Informe o nome do produto." });
      return;
    }
    if (preco !== "" && (Number.isNaN(preco) || preco < 0)) {
      res.status(400).json({ erro: "Preço padrão inválido." });
      return;
    }

    try {
      const token = await obterToken();
      const linhas = await obterLinhasComIndice(token, driveId, itemId, tableName);
      const jaExiste = linhas.some(l => String(l.valores[0] || "").trim().toLowerCase() === nome.toLowerCase());
      if (jaExiste) {
        res.status(409).json({ erro: "Já existe um produto cadastrado com esse nome." });
        return;
      }

      const urlAdd = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/workbook/tables('${tableName}')/rows/add`;
      const respAdd = await fetch(urlAdd, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: [[nome, unidade, preco, true]] })
      });
      const dadosAdd = await respAdd.json().catch(() => ({}));
      if (!respAdd.ok) {
        res.status(502).json({ erro: "Falha ao gravar o produto via Graph API.", detalhe: dadosAdd });
        return;
      }

      res.status(201).json({ status: "ok", produto: nome });
    } catch (err) {
      res.status(502).json({ erro: "Falha ao cadastrar produto.", detalhe: err.detalhe || String(err.message || err) });
    }
    return;
  }

  if (req.method === "PATCH") {
    const corpo = req.body || {};
    const nomeAtual = String(corpo.Produto_Atual || "").trim();
    const novoNome = String(corpo.Produto || nomeAtual || "").trim();
    const unidade = String(corpo.Unidade || "").trim();
    const preco = corpo.Preco_Padrao === "" || corpo.Preco_Padrao === undefined || corpo.Preco_Padrao === null
      ? "" : Number(corpo.Preco_Padrao);
    const ativo = corpo.Ativo !== false;

    if (!nomeAtual || !novoNome) {
      res.status(400).json({ erro: "Informe o produto a editar." });
      return;
    }
    if (preco !== "" && (Number.isNaN(preco) || preco < 0)) {
      res.status(400).json({ erro: "Preço padrão inválido." });
      return;
    }

    try {
      const token = await obterToken();
      const linhas = await obterLinhasComIndice(token, driveId, itemId, tableName);
      const linhaAlvo = linhas.find(l => String(l.valores[0] || "").trim().toLowerCase() === nomeAtual.toLowerCase());
      if (!linhaAlvo) {
        res.status(404).json({ erro: "Produto não encontrado (a lista pode ter mudado, recarregue o catálogo)." });
        return;
      }

      const urlPatch = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/workbook/tables('${tableName}')/rows/itemAt(index=${linhaAlvo.indice})`;
      const respPatch = await fetch(urlPatch, {
        method: "PATCH",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ values: [[novoNome, unidade, preco, ativo]] })
      });
      const dadosPatch = await respPatch.json().catch(() => ({}));
      if (!respPatch.ok) {
        res.status(502).json({ erro: "Falha ao atualizar o produto via Graph API.", detalhe: dadosPatch });
        return;
      }

      res.status(200).json({ status: "ok", produto: novoNome });
    } catch (err) {
      res.status(502).json({ erro: "Falha ao atualizar produto.", detalhe: err.detalhe || String(err.message || err) });
    }
    return;
  }

  res.status(405).json({ erro: "Use GET, POST ou PATCH." });
};
