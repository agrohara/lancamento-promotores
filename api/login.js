// Vercel Serverless Function — autentica o usuário (Gerente ou Promotor) contra a tabela
// "usuarios" no Supabase (Postgres). Terceira tabela migrada do SharePoint/Excel para o
// banco de verdade (depois de "propriedades" e "produtos").
//
// A senha NUNCA é guardada nem comparada em texto puro: usamos o hash (senha_hash),
// gerado com a mesma função hashSenha()/senhaConfere() de sempre (api/_lib/auth.js).
//
// Colunas da tabela "usuarios" no Supabase: login, nome, cargo, senha_hash.
//
// Variáveis de ambiente necessárias: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, API_KEY,
// AUTH_SECRET (para gerar/validar o hash da senha e assinar o token).

const { senhaConfere, criarToken } = require("./_lib/auth");
const { obterSupabase } = require("./_lib/supabase");

function normalizarCargo(cargo) {
  const c = String(cargo || "").trim().toLowerCase();
  if (c.includes("desenvolv")) return "Desenvolvedor";
  if (c.includes("gerente")) return "Gerente";
  return "Promotor";
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ erro: "Use POST." }); return; }

  const chaveEnviada = req.headers["x-api-key"];
  if (!process.env.API_KEY || chaveEnviada !== process.env.API_KEY) {
    res.status(401).json({ erro: "Não autorizado." });
    return;
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ erro: "Banco de dados não configurado (faltam SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)." });
    return;
  }

  const { login, senha } = req.body || {};
  if (!login || !senha) { res.status(400).json({ erro: "Informe login e senha." }); return; }

  try {
    const supabase = obterSupabase();
    const { data: usuario, error } = await supabase
      .from("usuarios")
      .select("login, nome, cargo, senha_hash")
      .ilike("login", String(login).trim())
      .limit(1)
      .maybeSingle();
    if (error) throw error;

    if (!usuario || !senhaConfere(senha, usuario.senha_hash)) {
      res.status(401).json({ erro: "Login ou senha inválidos." });
      return;
    }

    const cargoNormalizado = normalizarCargo(usuario.cargo);
    const token = criarToken({ login: usuario.login, nome: usuario.nome, cargo: cargoNormalizado });
    res.status(200).json({ token, nome: usuario.nome, cargo: cargoNormalizado });
  } catch (err) {
    res.status(500).json({ erro: "Erro interno.", detalhe: String(err.message || err) });
  }
};
