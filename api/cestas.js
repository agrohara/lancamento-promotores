// Vercel Serverless Function — cestas de produtos (ex.: "Cesta Reprodução"), cada uma
// com uma lista de produtos do catálogo. Cadastradas pelo Gerente/Desenvolvedor. A meta
// semanal de cada cesta (por promotor) fica em api/metas-cesta.js; este arquivo só cuida
// do CADASTRO da cesta (nome + quais produtos entram nela).
//
// GET    /api/cestas         -> lista todas as cestas com seus produtos (qualquer logado).
// POST   /api/cestas          -> só Gerente/Desenvolvedor. Body: { Nome, Produtos: [...] }.
//                                Cria a cesta se não existir, ou atualiza a lista de
//                                produtos se já existir (upsert pelo nome).
// DELETE /api/cestas?nome=X  -> só Gerente/Desenvolvedor. Remove a cesta e as metas dela.
//
// Colunas da tabela "cestas" no Supabase: nome (chave), produtos (array de texto),
// criado_por, criado_em.
//
// Variáveis de ambiente necessárias: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, API_KEY,
// AUTH_SECRET.

const { usuarioDaRequisicao } = require("./_lib/auth");
const { obterSupabase } = require("./_lib/supabase");

const CARGOS_GESTAO = ["gerente", "desenvolvedor"];

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

  const usuario = usuarioDaRequisicao(req);
  if (!usuario) {
    res.status(401).json({ erro: "Sessão expirada ou inválida. Faça login novamente." });
    return;
  }

  const supabase = obterSupabase();
  const ehGestor = CARGOS_GESTAO.includes(String(usuario.cargo || "").toLowerCase());

  if (req.method === "GET") {
    try {
      const { data, error } = await supabase.from("cestas").select("nome, produtos").order("nome");
      if (error) throw error;
      const cestas = (data || []).map(c => ({ Nome: c.nome, Produtos: c.produtos || [] }));
      res.status(200).json({ cestas });
    } catch (err) {
      res.status(502).json({ erro: "Falha ao ler cestas no banco.", detalhe: String(err.message || err) });
    }
    return;
  }

  if (!ehGestor) {
    res.status(403).json({ erro: "Só Gerente/Desenvolvedor pode cadastrar cestas." });
    return;
  }

  if (req.method === "DELETE") {
    const nome = String((req.query && req.query.nome) || "").trim();
    if (!nome) {
      res.status(400).json({ erro: "Informe a cesta a excluir." });
      return;
    }
    try {
      await supabase.from("metas_cesta").delete().ilike("cesta", nome);
      const { error } = await supabase.from("cestas").delete().ilike("nome", nome);
      if (error) throw error;
      res.status(200).json({ status: "ok" });
    } catch (err) {
      res.status(502).json({ erro: "Falha ao excluir a cesta.", detalhe: String(err.message || err) });
    }
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ erro: "Use GET, POST ou DELETE." });
    return;
  }

  const corpo = req.body || {};
  const nome = String(corpo.Nome || "").trim();
  const produtos = Array.isArray(corpo.Produtos) ? corpo.Produtos.map(p => String(p || "").trim()).filter(Boolean) : [];
  if (!nome) {
    res.status(400).json({ erro: "Informe o nome da cesta." });
    return;
  }
  if (produtos.length === 0) {
    res.status(400).json({ erro: "Selecione ao menos um produto pra essa cesta." });
    return;
  }

  try {
    const { error } = await supabase
      .from("cestas")
      .upsert(
        { nome, produtos, criado_por: usuario.nome },
        { onConflict: "nome" }
      );
    if (error) throw error;
    res.status(200).json({ status: "ok" });
  } catch (err) {
    res.status(502).json({ erro: "Falha ao salvar a cesta.", detalhe: String(err.message || err) });
  }
};
