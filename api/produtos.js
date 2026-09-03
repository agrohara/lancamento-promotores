// Vercel Serverless Function — catálogo de produtos, agora gravado no Supabase (Postgres)
// em vez do Excel/SharePoint. Segunda tabela migrada (depois de "propriedades").
//
// GET   /api/produtos           -> lista os produtos (todos, com o campo Ativo)
// POST  /api/produtos           -> cadastra um produto novo (só Gerente/Desenvolvedor)
// PATCH /api/produtos           -> edita um produto existente, buscando pelo nome atual
//                                   (só Gerente/Desenvolvedor)
//
// Colunas da tabela "produtos" no Supabase: produto, unidade, preco_padrao, ativo.
// O restante do app (index.html) continua enviando/recebendo os nomes de sempre
// (Produto, Unidade, Preco_Padrao, Ativo) — a conversão acontece só aqui dentro.
//
// Variáveis de ambiente necessárias: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, API_KEY,
// AUTH_SECRET (para validar o login de quem está editando).

const { usuarioDaRequisicao } = require("./_lib/auth");
const { obterSupabase, buscarTodasLinhas } = require("./_lib/supabase");

const CARGOS_QUE_EDITAM = ["gerente", "desenvolvedor"];

function paraObjeto(l) {
  return {
    Produto: l.produto || "",
    Unidade: l.unidade || "",
    Preco_Padrao: l.preco_padrao === undefined || l.preco_padrao === null ? null : Number(l.preco_padrao),
    Ativo: l.ativo !== false
  };
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

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ erro: "Banco de dados não configurado (faltam SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)." });
    return;
  }

  const supabase = obterSupabase();

  if (req.method === "GET") {
    try {
      const data = await buscarTodasLinhas(supabase, "produtos", "*", "produto");
      res.status(200).json({ produtos: data.map(paraObjeto) });
    } catch (err) {
      res.status(502).json({ erro: "Falha ao ler produtos no banco.", detalhe: String(err.message || err) });
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
      ? null : Number(corpo.Preco_Padrao);

    if (!nome) {
      res.status(400).json({ erro: "Informe o nome do produto." });
      return;
    }
    if (preco !== null && (Number.isNaN(preco) || preco < 0)) {
      res.status(400).json({ erro: "Preço padrão inválido." });
      return;
    }

    try {
      const { data: existente, error: erroBusca } = await supabase
        .from("produtos")
        .select("produto")
        .ilike("produto", nome)
        .limit(1)
        .maybeSingle();
      if (erroBusca) throw erroBusca;
      if (existente) {
        res.status(409).json({ erro: "Já existe um produto cadastrado com esse nome." });
        return;
      }

      const { error: erroInsert } = await supabase
        .from("produtos")
        .insert({ produto: nome, unidade, preco_padrao: preco, ativo: true });
      if (erroInsert) throw erroInsert;

      res.status(201).json({ status: "ok", produto: nome });
    } catch (err) {
      res.status(502).json({ erro: "Falha ao cadastrar produto.", detalhe: String(err.message || err) });
    }
    return;
  }

  if (req.method === "PATCH") {
    const corpo = req.body || {};
    const nomeAtual = String(corpo.Produto_Atual || "").trim();
    const novoNome = String(corpo.Produto || nomeAtual || "").trim();
    const unidade = String(corpo.Unidade || "").trim();
    const preco = corpo.Preco_Padrao === "" || corpo.Preco_Padrao === undefined || corpo.Preco_Padrao === null
      ? null : Number(corpo.Preco_Padrao);
    const ativo = corpo.Ativo !== false;

    if (!nomeAtual || !novoNome) {
      res.status(400).json({ erro: "Informe o produto a editar." });
      return;
    }
    if (preco !== null && (Number.isNaN(preco) || preco < 0)) {
      res.status(400).json({ erro: "Preço padrão inválido." });
      return;
    }

    try {
      const { data: linhaAlvo, error: erroBusca } = await supabase
        .from("produtos")
        .select("id")
        .ilike("produto", nomeAtual)
        .limit(1)
        .maybeSingle();
      if (erroBusca) throw erroBusca;
      if (!linhaAlvo) {
        res.status(404).json({ erro: "Produto não encontrado (a lista pode ter mudado, recarregue o catálogo)." });
        return;
      }

      const { error: erroUpdate } = await supabase
        .from("produtos")
        .update({ produto: novoNome, unidade, preco_padrao: preco, ativo })
        .eq("id", linhaAlvo.id);
      if (erroUpdate) throw erroUpdate;

      res.status(200).json({ status: "ok", produto: novoNome });
    } catch (err) {
      res.status(502).json({ erro: "Falha ao atualizar produto.", detalhe: String(err.message || err) });
    }
    return;
  }

  res.status(405).json({ erro: "Use GET, POST ou PATCH." });
};
