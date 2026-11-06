// Avisos no celular (Web Push) — SÓ para gestor (Gerente/Desenvolvedor).
// Quando um consultor envia um RDV ou uma CI para aprovação, os celulares dos gestores que
// ativaram os avisos recebem uma notificação; o toque abre gestor.html na aba de despesas.
//
// GET  /api/agenda?recurso=push&chave=1                 -> { chave } (chave pública VAPID)
// POST /api/agenda?recurso=push  { acao:"inscrever", inscricao:{endpoint,keys:{p256dh,auth}} }
// POST /api/agenda?recurso=push  { acao:"cancelar", endpoint }
// Só gestor consegue se inscrever (checagem no servidor). Consultor nunca recebe aviso.
//
// Tabela: push_inscricoes (ver sql_push.sql). Variáveis de ambiente (Vercel):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (ex.: mailto:alguem@agrohara.com.br)
// Dependência: "web-push" no package.json. Sem ela ou sem as chaves, NADA quebra: o envio
// é ignorado e o RDV/CI é gravado normalmente.

let _wp; // undefined = ainda não tentou; null = indisponível
function biblioteca() {
  if (_wp !== undefined) return _wp;
  try {
    const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) { _wp = null; return _wp; }
    const wp = require("web-push");
    wp.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    _wp = wp;
  } catch (e) { console.warn("[push] indisponível:", e.message); _wp = null; }
  return _wp;
}

async function tratarPush(req, res, ctx) {
  const { usuario, ehGestor, supabase } = ctx;
  if (!ehGestor) { res.status(403).json({ erro: "Avisos disponíveis só para o gestor." }); return; }
  const q = req.query || {};
  try {
    if (req.method === "GET") {
      res.status(200).json({ chave: process.env.VAPID_PUBLIC_KEY || "", ativo: !!biblioteca() });
      return;
    }
    if (req.method !== "POST") { res.status(405).json({ erro: "Use GET ou POST." }); return; }
    const b = req.body || {};
    if (b.acao === "inscrever") {
      const i = b.inscricao || {}, k = i.keys || {};
      if (!i.endpoint || !/^https:\/\//.test(String(i.endpoint)) || !k.p256dh || !k.auth) { res.status(400).json({ erro: "Inscrição inválida." }); return; }
      const linha = {
        endpoint: String(i.endpoint), p256dh: String(k.p256dh), auth: String(k.auth),
        usuario_login: String(usuario.login || "").toLowerCase(), usuario_nome: String(usuario.nome || ""), cargo: String(usuario.cargo || "")
      };
      const { error } = await supabase.from("push_inscricoes").upsert(linha, { onConflict: "endpoint" });
      if (error) throw error;
      res.status(200).json({ status: "ok" });
      return;
    }
    if (b.acao === "cancelar") {
      if (!b.endpoint) { res.status(400).json({ erro: "Informe o endpoint." }); return; }
      const { error } = await supabase.from("push_inscricoes").delete().eq("endpoint", String(b.endpoint)).eq("usuario_login", String(usuario.login || "").toLowerCase());
      if (error) throw error;
      res.status(200).json({ status: "ok" });
      return;
    }
    res.status(400).json({ erro: "Ação desconhecida." });
  } catch (err) {
    res.status(502).json({ erro: "Falha ao salvar os avisos.", detalhe: String(err.message || err) });
  }
}

// Envia para todos os celulares de gestores inscritos (menos quem enviou, se for gestor).
// NUNCA lança erro: a gravação do RDV/CI não pode depender do aviso.
async function avisarGestores(supabase, aviso, opcoes) {
  try {
    const wp = biblioteca();
    if (!wp) return { enviados: 0, motivo: "avisos não configurados" };
    const { data, error } = await supabase.from("push_inscricoes").select("endpoint,p256dh,auth,usuario_login,cargo");
    if (error || !data) return { enviados: 0, motivo: "sem tabela" };
    const gestor = c => ["gerente", "desenvolvedor"].includes(String(c || "").toLowerCase());
    const exceto = String((opcoes && opcoes.exceto) || "").toLowerCase();
    const alvo = data.filter(i => gestor(i.cargo) && (!exceto || String(i.usuario_login || "").toLowerCase() !== exceto));
    const corpo = JSON.stringify(aviso);
    let enviados = 0;
    const envio = Promise.all(alvo.map(async i => {
      try {
        await wp.sendNotification({ endpoint: i.endpoint, keys: { p256dh: i.p256dh, auth: i.auth } }, corpo, { TTL: 86400, urgency: "high" });
        enviados++;
      } catch (e) {
        if (e && (e.statusCode === 404 || e.statusCode === 410)) { try { await supabase.from("push_inscricoes").delete().eq("endpoint", i.endpoint); } catch (_) {} }
      }
    }));
    await Promise.race([envio, new Promise(r => setTimeout(r, 4000))]);
    return { enviados };
  } catch (e) { console.warn("[push] falha ao avisar:", e.message); return { enviados: 0 }; }
}

module.exports = { tratarPush, avisarGestores };
