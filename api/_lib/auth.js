// Funções compartilhadas de autenticação — usadas por api/login.js e pelos demais
// endpoints que exigem usuário logado (Gerente ou Promotor).
//
// Não usa nenhuma biblioteca externa (só o módulo "crypto" nativo do Node), para não
// depender de instalação de pacotes no Vercel.
//
// Senha: guardamos só o hash (SHA-256 da senha + um "tempero" fixo do ambiente),
// nunca a senha em texto puro.
//
// Token: um token simples e assinado (não é um JWT de verdade, mas segue a mesma ideia).
// Formato: base64url(JSON com {login, nome, cargo, exp}) + "." + assinatura HMAC-SHA256.
// Isso evita que alguém forje um token sem conhecer o AUTH_SECRET do servidor.

const crypto = require("crypto");

const VALIDADE_TOKEN_MS = 1000 * 60 * 60 * 24 * 30; // 30 dias

function obterSegredo() {
  const segredo = process.env.AUTH_SECRET;
  if (!segredo) {
    throw new Error("Variável de ambiente AUTH_SECRET não configurada.");
  }
  return segredo;
}

function base64urlEncode(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function base64urlDecode(str) {
  return JSON.parse(Buffer.from(str, "base64url").toString("utf8"));
}

function hashSenha(senha) {
  const segredo = obterSegredo();
  return crypto.createHash("sha256").update(String(senha) + segredo).digest("hex");
}

function senhaConfere(senha, hashGuardado) {
  const calculado = hashSenha(senha);
  // comparação em tempo constante, para evitar ataques de timing
  const a = Buffer.from(calculado, "hex");
  const b = Buffer.from(String(hashGuardado || ""), "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function criarToken({ login, nome, cargo }) {
  const segredo = obterSegredo();
  const payload = { login, nome, cargo, exp: Date.now() + VALIDADE_TOKEN_MS };
  const parte = base64urlEncode(payload);
  const assinatura = crypto.createHmac("sha256", segredo).update(parte).digest("base64url");
  return `${parte}.${assinatura}`;
}

function verificarToken(token) {
  try {
    const segredo = obterSegredo();
    const [parte, assinatura] = String(token || "").split(".");
    if (!parte || !assinatura) return null;

    const assinaturaEsperada = crypto.createHmac("sha256", segredo).update(parte).digest("base64url");
    const a = Buffer.from(assinatura);
    const b = Buffer.from(assinaturaEsperada);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    const payload = base64urlDecode(parte);
    if (!payload.exp || payload.exp < Date.now()) return null;

    return payload; // { login, nome, cargo, exp }
  } catch (err) {
    return null;
  }
}

// Extrai e valida o usuário logado a partir do cabeçalho Authorization: Bearer <token>
// Retorna null se não houver token válido.
function usuarioDaRequisicao(req) {
  const cabecalho = req.headers["authorization"] || "";
  const token = cabecalho.startsWith("Bearer ") ? cabecalho.slice(7) : null;
  if (!token) return null;
  return verificarToken(token);
}

module.exports = {
  hashSenha,
  senhaConfere,
  criarToken,
  verificarToken,
  usuarioDaRequisicao
};
