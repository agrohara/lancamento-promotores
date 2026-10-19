// Calendário Sanitário (Corte / Leite) — módulo chamado por api/agenda.js quando a URL traz
// ?recurso=calendario. Fica em _lib (e dentro da função /api/agenda) de propósito: a Vercel
// Hobby limita o projeto a 12 funções serverless e já estamos em 12/12.
//
// Tabela "calendarios_sanitarios" no Supabase (ver sql_calendario_sanitario.sql):
//   id, propriedade, tipo ('corte'|'leite'), ano, proprietario, nome_promotor (quem criou),
//   dados (jsonb), historico (texto, uma linha por alteração), id_envio (único, fila offline),
//   atualizado_por, criado_em, atualizado_em. Único: (propriedade, tipo, ano).
//
// "dados" = { celulas: { "<categoria>|<acao>|<mes 1-12>": "texto livre" },
//             obs: { "<categoria>": "texto" }, vet: { nome, crmv, contato } }
// O servidor não interpreta as chaves (a estrutura fixa de categorias/ações vive no front);
// só limita tamanho e garante o formato.
//
// GET    ?recurso=calendario&propriedade=X   -> calendários da fazenda (mais novos primeiro)
// GET    ?recurso=calendario&id=N            -> um calendário
// GET    ?recurso=calendario                 -> últimos 100 (qualquer usuário logado; usado pela visão do gestor)
// POST   ?recurso=calendario                 -> cria { Propriedade, Tipo, Ano, Proprietario, Dados, Id_Envio }
// PATCH  ?recurso=calendario                 -> edita { Id, Proprietario?, Dados?, Resumo_Alteracoes? }
// DELETE ?recurso=calendario&id=N            -> exclui (quem criou, ou Gerente/Desenvolvedor)
//
// Edição: qualquer usuário logado pode editar (um promotor que assume a carteira de outro
// precisa continuar o calendário). O histórico registra quem alterou e quando.

const TIPOS = ["corte", "leite"];
const LIMITE_DADOS_BYTES = 200 * 1024;

function paraObjeto(l) {
  return {
    Id: l.id,
    Propriedade: l.propriedade || "",
    Tipo: l.tipo || "",
    Ano: l.ano,
    Proprietario: l.proprietario || "",
    Nome_Promotor: l.nome_promotor || "",
    Dados: l.dados && typeof l.dados === "object" ? l.dados : {},
    Historico: l.historico || "",
    Atualizado_Por: l.atualizado_por || "",
    Criado_Em: l.criado_em || "",
    Atualizado_Em: l.atualizado_em || ""
  };
}

function dadosValidos(d) {
  if (d === undefined) return { ok: true, valor: undefined };
  if (!d || typeof d !== "object" || Array.isArray(d)) return { ok: false };
  const limpo = { celulas: {}, obs: {}, vet: {} };
  const celulas = d.celulas && typeof d.celulas === "object" ? d.celulas : {};
  for (const [k, v] of Object.entries(celulas)) {
    if (!/^[a-z0-9_]+\|[a-z0-9_]+\|(1[0-2]|[1-9])$/.test(k)) return { ok: false };
    const t = String(v === null || v === undefined ? "" : v).trim().slice(0, 600);
    if (t) limpo.celulas[k] = t;
  }
  const obs = d.obs && typeof d.obs === "object" ? d.obs : {};
  for (const [k, v] of Object.entries(obs)) {
    if (!/^[a-z0-9_]+$/.test(k)) return { ok: false };
    const t = String(v === null || v === undefined ? "" : v).trim().slice(0, 1500);
    if (t) limpo.obs[k] = t;
  }
  const vet = d.vet && typeof d.vet === "object" ? d.vet : {};
  for (const k of ["nome", "crmv", "contato"]) {
    const t = String(vet[k] || "").trim().slice(0, 120);
    if (t) limpo.vet[k] = t;
  }
  if (JSON.stringify(limpo).length > LIMITE_DADOS_BYTES) return { ok: false };
  return { ok: true, valor: limpo };
}

function agora() {
  return new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

async function tratarCalendario(req, res, { usuario, ehGestor, supabase }) {
  const q = req.query || {};

  if (req.method === "GET") {
    try {
      const id = Number(q.id);
      if (id) {
        const { data, error } = await supabase.from("calendarios_sanitarios").select("*").eq("id", id).maybeSingle();
        if (error) throw error;
        if (!data) { res.status(404).json({ erro: "Calendário não encontrado." }); return; }
        res.status(200).json({ calendario: paraObjeto(data) });
        return;
      }
      let c = supabase.from("calendarios_sanitarios").select("*").order("atualizado_em", { ascending: false }).limit(100);
      const prop = String(q.propriedade || "").trim();
      if (prop) c = c.ilike("propriedade", prop);
      const { data, error } = await c;
      if (error) throw error;
      res.status(200).json({ calendarios: (data || []).map(paraObjeto) });
    } catch (err) {
      res.status(502).json({ erro: "Falha ao buscar os calendários.", detalhe: String(err.message || err) });
    }
    return;
  }

  if (req.method === "POST") {
    const b = req.body || {};
    const propriedade = String(b.Propriedade || "").trim();
    const tipo = String(b.Tipo || "").trim().toLowerCase();
    const ano = Number(b.Ano);
    if (!propriedade || !TIPOS.includes(tipo) || !Number.isInteger(ano) || ano < 2020 || ano > 2100) {
      res.status(400).json({ erro: "Informe fazenda, tipo (corte ou leite) e ano." });
      return;
    }
    const dv = dadosValidos(b.Dados === undefined ? { celulas: {}, obs: {}, vet: {} } : b.Dados);
    if (!dv.ok) { res.status(400).json({ erro: "Dados do calendário inválidos." }); return; }
    try {
      const linha = {
        propriedade, tipo, ano,
        proprietario: String(b.Proprietario || "").trim(),
        nome_promotor: usuario.nome,
        atualizado_por: usuario.nome,
        dados: dv.valor,
        historico: `[${agora()}] ${usuario.nome} criou o calendário de ${tipo === "corte" ? "Corte" : "Leite"} ${ano}`,
        id_envio: b.Id_Envio ? String(b.Id_Envio).trim() : null
      };
      const { data, error } = await supabase.from("calendarios_sanitarios").insert(linha).select("*").single();
      if (error) {
        if (error.code === "23505") {
          const dup = String(error.message || "") + String(error.details || "");
          if (dup.includes("id_envio")) { res.status(200).json({ status: "ok", duplicado: true }); return; }
          res.status(409).json({ erro: `Já existe um calendário de ${tipo === "corte" ? "Corte" : "Leite"} ${ano} para esta fazenda. Abra-o na lista para editar.` });
          return;
        }
        throw error;
      }
      res.status(200).json({ status: "ok", calendario: paraObjeto(data) });
    } catch (err) {
      res.status(502).json({ erro: "Falha ao gravar o calendário.", detalhe: String(err.message || err) });
    }
    return;
  }

  if (req.method === "PATCH") {
    const b = req.body || {};
    const id = Number(b.Id);
    if (!id) { res.status(400).json({ erro: "Informe o Id do calendário." }); return; }
    const dv = dadosValidos(b.Dados);
    if (!dv.ok) { res.status(400).json({ erro: "Dados do calendário inválidos." }); return; }
    try {
      const { data: existente, error: erroBusca } = await supabase.from("calendarios_sanitarios").select("*").eq("id", id).maybeSingle();
      if (erroBusca) throw erroBusca;
      if (!existente) { res.status(404).json({ erro: "Calendário não encontrado." }); return; }

      const atualizacao = {};
      const linhasLog = [];
      if (dv.valor !== undefined && JSON.stringify(dv.valor) !== JSON.stringify(existente.dados || {})) {
        atualizacao.dados = dv.valor;
        const resumo = String(b.Resumo_Alteracoes || "").trim().slice(0, 3000);
        linhasLog.push(resumo || "alterou o conteúdo do calendário");
      }
      if (b.Proprietario !== undefined) {
        const novo = String(b.Proprietario || "").trim();
        if (novo !== String(existente.proprietario || "").trim()) {
          atualizacao.proprietario = novo;
          linhasLog.push(`Proprietário: "${existente.proprietario || ""}" → "${novo}"`);
        }
      }
      if (linhasLog.length === 0) { res.status(200).json({ status: "ok", semAlteracoes: true }); return; }

      atualizacao.atualizado_por = usuario.nome;
      atualizacao.atualizado_em = new Date().toISOString();
      const bloco = `[${agora()}] ${usuario.nome} alterou:\n${linhasLog.join("\n")}`;
      const atual = String(existente.historico || "").trim();
      atualizacao.historico = atual ? `${atual}\n${bloco}` : bloco;

      const { data, error } = await supabase.from("calendarios_sanitarios").update(atualizacao).eq("id", id).select("*").single();
      if (error) throw error;
      res.status(200).json({ status: "ok", calendario: paraObjeto(data) });
    } catch (err) {
      res.status(502).json({ erro: "Falha ao atualizar o calendário.", detalhe: String(err.message || err) });
    }
    return;
  }

  if (req.method === "DELETE") {
    const id = Number(q.id || (req.body && req.body.Id));
    if (!id) { res.status(400).json({ erro: "Informe o Id do calendário (?id=N)." }); return; }
    try {
      const { data: existente, error: erroBusca } = await supabase.from("calendarios_sanitarios").select("id, nome_promotor").eq("id", id).maybeSingle();
      if (erroBusca) throw erroBusca;
      if (!existente) { res.status(200).json({ status: "ok", jaExcluido: true }); return; }
      if (!ehGestor && String(existente.nome_promotor || "").toLowerCase() !== usuario.nome.toLowerCase()) {
        res.status(403).json({ erro: "Só quem criou o calendário (ou o gestor) pode excluí-lo." });
        return;
      }
      const { error } = await supabase.from("calendarios_sanitarios").delete().eq("id", id);
      if (error) throw error;
      res.status(200).json({ status: "ok" });
    } catch (err) {
      res.status(502).json({ erro: "Falha ao excluir o calendário.", detalhe: String(err.message || err) });
    }
    return;
  }

  res.status(405).json({ erro: "Use GET, POST, PATCH ou DELETE." });
}

module.exports = { tratarCalendario };
