// Vercel Serverless Function — módulo "Agenda" dos consultores. Grava/lê/edita/exclui
// compromissos (visitas planejadas) na tabela "agenda_compromissos" no Supabase (Postgres).
//
// Criado em 22/09/2026, substituindo o planejamento semanal feito hoje em Excel. Cada
// compromisso é um horário reservado para visitar uma REVENDA ou uma PROPRIEDADE (o
// consultor escolhe qual das duas na hora de criar — ver Tipo_Cliente) num dia/hora
// específicos, com um assunto curto ("o que será tratado?").
//
// REGRA DE PRAZO (combinada com o Marcelo): o consultor tem até sexta-feira 17:00
// (horário de Brasília) pra planejar a semana seguinte. Se perder o prazo, só aquela
// semana específica fica travada (🔒) pra novos compromissos/edições — a semana atual
// nunca trava. Essa regra é calculada em api/_lib/agenda_prazo.js e é reforçada AQUI no
// servidor (não só visualmente no front-end): POST/PATCH/DELETE numa semana travada
// devolvem 403.
//
// GET  /api/agenda?semana=AAAA-MM-DD          -> compromissos do promotor logado nessa
//                                                 semana (AAAA-MM-DD = segunda-feira da
//                                                 semana) + StatusSemana (aberta/travada)
// GET  /api/agenda?dia=AAAA-MM-DD              -> compromissos do promotor logado nesse dia
// GET  /api/agenda?semana=X&equipe=1           -> (Gerente/Desenvolvedor) todos os
//                                                 compromissos de TODOS os promotores
//                                                 nessa semana, agrupados por promotor
//                                                 ("Agenda da Equipe")
// GET  /api/agenda?dia=X&equipe=1              -> idem, mas só do dia
// GET  /api/agenda?semana=X&promotor=NOME      -> (Gerente/Desenvolvedor) agenda de um
//                                                 promotor específico
// POST /api/agenda                             -> cria um compromisso novo
// PATCH /api/agenda                            -> edita um compromisso existente (por Id)
// DELETE /api/agenda?id=N                      -> exclui um compromisso
//
// Colunas da tabela "agenda_compromissos" no Supabase: nome_promotor, tipo_cliente
// ('revenda' ou 'propriedade'), cliente_nome, data, hora_inicio, duracao_minutos, assunto,
// criado_em, atualizado_em.
//
// Variáveis de ambiente necessárias: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, API_KEY,
// AUTH_SECRET.

const { usuarioDaRequisicao } = require("./_lib/auth");
const { obterSupabase } = require("./_lib/supabase");
const { segundaFeira, somarDias, statusSemana } = require("./_lib/agenda_prazo");

const CARGOS_GESTAO = ["gerente", "desenvolvedor"];
const TIPOS_CLIENTE_VALIDOS = ["revenda", "propriedade"];

function paraObjeto(l) {
  return {
    Id: l.id,
    Nome_Promotor: l.nome_promotor || "",
    Tipo_Cliente: l.tipo_cliente || "",
    Cliente_Nome: l.cliente_nome || "",
    Data: l.data || "",
    Hora_Inicio: l.hora_inicio || "",
    Duracao_Minutos: l.duracao_minutos === undefined || l.duracao_minutos === null ? 60 : Number(l.duracao_minutos),
    Assunto: l.assunto || ""
  };
}

function validarCompromisso(c, { exigirCompleto }) {
  if (!c || typeof c !== "object") return false;
  if (exigirCompleto) {
    if (!c.Nome_Promotor || !c.Cliente_Nome || !c.Data || !c.Hora_Inicio || !c.Assunto) return false;
    if (!TIPOS_CLIENTE_VALIDOS.includes(String(c.Tipo_Cliente || "").toLowerCase())) return false;
  }
  if (c.Data !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(c.Data))) return false;
  if (c.Hora_Inicio !== undefined && !/^\d{2}:\d{2}$/.test(String(c.Hora_Inicio))) return false;
  if (c.Duracao_Minutos !== undefined) {
    const dur = Number(c.Duracao_Minutos);
    if (Number.isNaN(dur) || dur <= 0) return false;
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

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ erro: "Banco de dados não configurado (faltam SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)." });
    return;
  }

  const usuario = usuarioDaRequisicao(req);
  if (!usuario) {
    res.status(401).json({ erro: "Sessão expirada ou inválida. Faça login novamente." });
    return;
  }
  const ehGestor = CARGOS_GESTAO.includes(String(usuario.cargo || "").toLowerCase());

  const supabase = obterSupabase();

  if (req.method === "GET") {
    try {
      const semanaFiltro = String((req.query && req.query.semana) || "").trim();
      const diaFiltro = String((req.query && req.query.dia) || "").trim();
      const visaoEquipe = ehGestor && String((req.query && req.query.equipe) || "") === "1";
      const promotorFiltro = ehGestor ? String((req.query && req.query.promotor) || "").trim() : usuario.nome;

      if (!semanaFiltro && !diaFiltro) {
        res.status(400).json({ erro: "Informe ?semana=AAAA-MM-DD (segunda-feira) ou ?dia=AAAA-MM-DD." });
        return;
      }

      let consulta = supabase.from("agenda_compromissos").select("*");
      if (diaFiltro) {
        consulta = consulta.eq("data", diaFiltro);
      } else {
        // Semana = segunda a sexta (dias úteis de visita a campo).
        consulta = consulta.gte("data", semanaFiltro).lte("data", somarDias(semanaFiltro, 4));
      }
      if (promotorFiltro) {
        consulta = consulta.ilike("nome_promotor", promotorFiltro);
      }

      const { data, error } = await consulta.order("data", { ascending: true }).order("hora_inicio", { ascending: true });
      if (error) throw error;

      const compromissos = (data || []).map(paraObjeto);

      const resposta = { compromissos };
      const segundaReferencia = semanaFiltro || segundaFeira(diaFiltro);
      if (segundaReferencia) {
        resposta.StatusSemana = statusSemana(segundaReferencia);
      }
      if (visaoEquipe) {
        const porPromotor = {};
        for (const c of compromissos) {
          if (!porPromotor[c.Nome_Promotor]) porPromotor[c.Nome_Promotor] = [];
          porPromotor[c.Nome_Promotor].push(c);
        }
        resposta.PorPromotor = porPromotor;
      }

      res.status(200).json(resposta);
    } catch (err) {
      res.status(502).json({ erro: "Falha ao ler a agenda no banco.", detalhe: String(err.message || err) });
    }
    return;
  }

  if (req.method === "POST") {
    let corpo = req.body || {};
    if (!ehGestor) corpo = { ...corpo, Nome_Promotor: usuario.nome };

    if (!validarCompromisso(corpo, { exigirCompleto: true })) {
      res.status(400).json({ erro: "Dados incompletos: informe cliente (revenda ou propriedade), data (AAAA-MM-DD), horário (HH:MM) e o que será tratado." });
      return;
    }

    const segunda = segundaFeira(corpo.Data);
    const status = statusSemana(segunda);
    if (status.bloqueada) {
      res.status(403).json({ erro: "O prazo para planejar essa semana já passou (sexta-feira 17:00). Fale com seu gestor.", statusSemana: status });
      return;
    }

    try {
      const linhaNova = {
        nome_promotor: String(corpo.Nome_Promotor).trim(),
        tipo_cliente: String(corpo.Tipo_Cliente).toLowerCase().trim(),
        cliente_nome: String(corpo.Cliente_Nome).trim(),
        data: corpo.Data,
        hora_inicio: corpo.Hora_Inicio,
        duracao_minutos: corpo.Duracao_Minutos ? Number(corpo.Duracao_Minutos) : 60,
        assunto: String(corpo.Assunto).trim(),
        atualizado_em: new Date().toISOString()
      };
      const { data, error } = await supabase.from("agenda_compromissos").insert(linhaNova).select("*").single();
      if (error) throw error;
      res.status(201).json({ status: "ok", compromisso: paraObjeto(data) });
    } catch (err) {
      res.status(502).json({ erro: "Falha ao gravar o compromisso no banco.", detalhe: String(err.message || err) });
    }
    return;
  }

  if (req.method === "PATCH") {
    const corpo = req.body || {};
    const id = Number(corpo.Id);
    if (!id) {
      res.status(400).json({ erro: "Informe o Id do compromisso." });
      return;
    }
    if (!validarCompromisso(corpo, { exigirCompleto: false })) {
      res.status(400).json({ erro: "Dados inválidos." });
      return;
    }

    try {
      const { data: existente, error: erroBusca } = await supabase
        .from("agenda_compromissos")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (erroBusca) throw erroBusca;
      if (!existente) {
        res.status(404).json({ erro: "Compromisso não encontrado." });
        return;
      }
      if (!ehGestor && String(existente.nome_promotor || "").toLowerCase() !== usuario.nome.toLowerCase()) {
        res.status(403).json({ erro: "Você só pode editar compromissos da sua própria agenda." });
        return;
      }

      const dataFinal = corpo.Data || existente.data;
      const segunda = segundaFeira(dataFinal);
      const status = statusSemana(segunda);
      if (status.bloqueada) {
        res.status(403).json({ erro: "O prazo para alterar essa semana já passou (sexta-feira 17:00). Fale com seu gestor.", statusSemana: status });
        return;
      }

      const atualizacao = { atualizado_em: new Date().toISOString() };
      if (corpo.Tipo_Cliente !== undefined) atualizacao.tipo_cliente = String(corpo.Tipo_Cliente).toLowerCase().trim();
      if (corpo.Cliente_Nome !== undefined) atualizacao.cliente_nome = String(corpo.Cliente_Nome).trim();
      if (corpo.Data !== undefined) atualizacao.data = corpo.Data;
      if (corpo.Hora_Inicio !== undefined) atualizacao.hora_inicio = corpo.Hora_Inicio;
      if (corpo.Duracao_Minutos !== undefined) atualizacao.duracao_minutos = Number(corpo.Duracao_Minutos);
      if (corpo.Assunto !== undefined) atualizacao.assunto = String(corpo.Assunto).trim();

      const { data: atualizado, error: erroUpdate } = await supabase
        .from("agenda_compromissos")
        .update(atualizacao)
        .eq("id", id)
        .select("*")
        .single();
      if (erroUpdate) throw erroUpdate;

      res.status(200).json({ status: "ok", compromisso: paraObjeto(atualizado) });
    } catch (err) {
      res.status(502).json({ erro: "Falha ao atualizar o compromisso.", detalhe: String(err.message || err) });
    }
    return;
  }

  if (req.method === "DELETE") {
    const id = Number((req.query && req.query.id) || (req.body && req.body.Id));
    if (!id) {
      res.status(400).json({ erro: "Informe o Id do compromisso (?id=N)." });
      return;
    }

    try {
      const { data: existente, error: erroBusca } = await supabase
        .from("agenda_compromissos")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (erroBusca) throw erroBusca;
      if (!existente) {
        res.status(404).json({ erro: "Compromisso não encontrado." });
        return;
      }
      if (!ehGestor && String(existente.nome_promotor || "").toLowerCase() !== usuario.nome.toLowerCase()) {
        res.status(403).json({ erro: "Você só pode excluir compromissos da sua própria agenda." });
        return;
      }

      const segunda = segundaFeira(existente.data);
      const status = statusSemana(segunda);
      if (status.bloqueada) {
        res.status(403).json({ erro: "O prazo para alterar essa semana já passou (sexta-feira 17:00). Fale com seu gestor.", statusSemana: status });
        return;
      }

      const { error: erroDelete } = await supabase.from("agenda_compromissos").delete().eq("id", id);
      if (erroDelete) throw erroDelete;

      res.status(200).json({ status: "ok" });
    } catch (err) {
      res.status(502).json({ erro: "Falha ao excluir o compromisso.", detalhe: String(err.message || err) });
    }
    return;
  }

  res.status(405).json({ erro: "Use GET, POST, PATCH ou DELETE." });
};
