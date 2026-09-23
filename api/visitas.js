// Vercel Serverless Function — grava registros de VISITA (separados do PEDIDO) na tabela
// "visitas" no Supabase (Postgres).
//
// A Visita guarda o "como foi" (tipo, observação, foto). O Pedido (ver api/lancamentos.js)
// guarda o "o que foi vendido". São duas gravações separadas, feitas em telas separadas no
// app, mas para a mesma fazenda/dia.
//
// POST /api/visitas               -> grava uma visita nova
// GET  /api/visitas               -> lista visitas do promotor logado
// GET  /api/visitas?promotor=X    -> (Gerente/Desenvolvedor) lista visitas de um promotor
// GET  /api/visitas?propriedade=X -> busca parcial pelo nome da fazenda (combinável)
// GET  /api/visitas?quinzena=AAAA-MM-DD -> só visitas dessa semana (chave = segunda-feira
//                                    daquela semana, combinável) — o filtro é feito em JS
//                                    recalculando a chave a partir de dia_visita, porque a
//                                    coluna "quinzena" guarda o texto já formatado pra
//                                    exibição ("Semana 07–13/Set/2026"), não a chave.
// Ambos os GET exigem Authorization: Bearer <token do login>
//
// id_envio: identificador único gerado pelo CELULAR, usado só pela fila offline (ver
// OFFLINE.md). Num reenvio de algo que já foi gravado, o índice único recusa e esta
// função devolve 200 com duplicado:true, para o app limpar a fila sem duplicar a visita.
//
// EDIÇÃO COM LOG (novo em 23/09/2026): visita já registrada pode ser editada depois — pelo
// próprio promotor que registrou ou por Gerente/Desenvolvedor — via PATCH /api/visitas.
// Cada edição fica registrada em texto na coluna "historico_edicoes" (quem, quando, o que
// mudou de/para), devolvida pro front como Historico_Edicoes. Por isso o GET agora também
// devolve o Id (chave da linha no banco) e a Latitude/Longitude (já eram gravadas no POST,
// mas não vinham de volta no GET) — necessários pra editar.
// PATCH /api/visitas                  -> { Id, ...campos a alterar }
//
// Colunas da tabela "visitas" no Supabase: id, nome_promotor, propriedade, tipo_visita,
// observacao, foto_url, latitude, longitude, dia_visita, quinzena, id_envio,
// historico_edicoes.
//
// Variáveis de ambiente necessárias: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, API_KEY,
// AUTH_SECRET.

const { usuarioDaRequisicao } = require("./_lib/auth");
const { obterSupabase } = require("./_lib/supabase");
const { quinzenaChave } = require("./_lib/quinzenas");

const CARGOS_GESTAO = ["gerente", "desenvolvedor"];

function paraObjeto(l) {
  return {
    Id: l.id,
    Nome_Promotor: l.nome_promotor || "",
    Propriedade: l.propriedade || "",
    Tipo_Visita: l.tipo_visita || "",
    Observacao: l.observacao || "",
    Foto_URL: l.foto_url || "",
    Latitude: l.latitude === undefined || l.latitude === null ? null : Number(l.latitude),
    Longitude: l.longitude === undefined || l.longitude === null ? null : Number(l.longitude),
    Dia_Visita: l.dia_visita || "",
    Quinzena: l.quinzena || "",
    Id_Envio: l.id_envio || "",
    Historico_Edicoes: l.historico_edicoes || ""
  };
}

function validarVisita(v) {
  if (!v || typeof v !== "object") return false;
  if (!v.Nome_Promotor || !v.Propriedade || !v.Tipo_Visita || !v.Observacao || !v.Dia_Visita || !v.Quinzena) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v.Dia_Visita))) return false;
  return true;
}

// Campos que o PATCH aceita alterar. Nome_Promotor, Dia_Visita e Quinzena ficam de fora
// de propósito, pelo mesmo motivo do lançamento: mudar dono/data de um registro já
// contabilizado em relatórios/metas fechados pode bagunçar o período.
const CAMPOS_EDITAVEIS_VISITA = {
  Propriedade: "propriedade",
  Tipo_Visita: "tipo_visita",
  Observacao: "observacao",
  Latitude: "latitude",
  Longitude: "longitude"
};
const CAMPOS_NUMERICOS_VISITA = ["Latitude", "Longitude"];

function formatarValorLog(valor) {
  if (valor === null || valor === undefined || valor === "") return "(vazio)";
  return String(valor);
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
    const usuario = usuarioDaRequisicao(req);
    if (!usuario) {
      res.status(401).json({ erro: "Sessão expirada ou inválida. Faça login novamente." });
      return;
    }
    const ehGestor = CARGOS_GESTAO.includes(String(usuario.cargo || "").toLowerCase());
    const promotorFiltro = ehGestor ? String((req.query && req.query.promotor) || "").trim() : usuario.nome;

    try {
      const propriedadeFiltro = String((req.query && req.query.propriedade) || "").trim();
      const quinzenaFiltro = String((req.query && req.query.quinzena) || "").trim();

      function montarConsulta() {
        let c = supabase.from("visitas").select("*");
        if (promotorFiltro) c = c.ilike("nome_promotor", promotorFiltro);
        if (propriedadeFiltro) c = c.ilike("propriedade", `%${propriedadeFiltro}%`);
        return c;
      }

      // Busca em blocos de 1000 (limite padrão do Supabase), aplicando os mesmos filtros
      // em cada bloco — necessário porque um promotor com muito histórico pode passar
      // de 1000 linhas.
      const TAMANHO_BLOCO = 1000;
      let todasLinhas = [];
      let inicio = 0;
      while (true) {
        const { data, error } = await montarConsulta()
          .order("dia_visita", { ascending: false })
          .range(inicio, inicio + TAMANHO_BLOCO - 1);
        if (error) throw error;
        todasLinhas = todasLinhas.concat(data || []);
        if (!data || data.length < TAMANHO_BLOCO) break;
        inicio += TAMANHO_BLOCO;
      }

      let visitas = todasLinhas.map(paraObjeto);
      if (quinzenaFiltro) {
        visitas = visitas.filter(v => quinzenaChave(v.Dia_Visita) === quinzenaFiltro);
      }
      res.status(200).json({ visitas });
    } catch (err) {
      res.status(502).json({ erro: "Falha ao ler visitas no banco.", detalhe: String(err.message || err) });
    }
    return;
  }

  if (req.method === "PATCH") {
    const usuario = usuarioDaRequisicao(req);
    if (!usuario) {
      res.status(401).json({ erro: "Sessão expirada ou inválida. Faça login novamente." });
      return;
    }
    const ehGestor = CARGOS_GESTAO.includes(String(usuario.cargo || "").toLowerCase());

    const corpo = req.body || {};
    const id = Number(corpo.Id);
    if (!id || Number.isNaN(id)) {
      res.status(400).json({ erro: "Informe o Id da visita a editar." });
      return;
    }

    try {
      const { data: existente, error: erroBusca } = await supabase
        .from("visitas")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (erroBusca) throw erroBusca;
      if (!existente) {
        res.status(404).json({ erro: "Visita não encontrada." });
        return;
      }
      if (!ehGestor && String(existente.nome_promotor || "").toLowerCase() !== usuario.nome.toLowerCase()) {
        res.status(403).json({ erro: "Você só pode editar visitas registradas por você." });
        return;
      }

      const atualizacao = {};
      const mudancas = [];
      for (const [chaveFront, colunaBanco] of Object.entries(CAMPOS_EDITAVEIS_VISITA)) {
        if (!Object.prototype.hasOwnProperty.call(corpo, chaveFront)) continue;
        let novoValor = corpo[chaveFront];
        if (CAMPOS_NUMERICOS_VISITA.includes(chaveFront)) {
          novoValor = novoValor === "" || novoValor === null || novoValor === undefined ? null : Number(novoValor);
          if (novoValor !== null && Number.isNaN(novoValor)) {
            res.status(400).json({ erro: `Valor inválido para ${chaveFront}.` });
            return;
          }
        } else {
          novoValor = String(novoValor || "").trim();
        }
        const valorAtual = existente[colunaBanco];
        const mudou = CAMPOS_NUMERICOS_VISITA.includes(chaveFront)
          ? Number(valorAtual) !== Number(novoValor) && !(valorAtual == null && novoValor == null)
          : String(valorAtual || "").trim() !== novoValor;
        if (mudou) {
          mudancas.push(`${chaveFront}: ${formatarValorLog(valorAtual)} → ${formatarValorLog(novoValor)}`);
          atualizacao[colunaBanco] = novoValor;
        }
      }

      if (Object.keys(atualizacao).length === 0) {
        res.status(200).json({ status: "ok", semAlteracoes: true });
        return;
      }

      const propriedadeFinal = atualizacao.propriedade !== undefined ? atualizacao.propriedade : (existente.propriedade || "");
      const tipoFinal = atualizacao.tipo_visita !== undefined ? atualizacao.tipo_visita : (existente.tipo_visita || "");
      const observacaoFinal = atualizacao.observacao !== undefined ? atualizacao.observacao : (existente.observacao || "");
      if (!String(propriedadeFinal).trim() || !String(tipoFinal).trim() || !String(observacaoFinal).trim()) {
        res.status(400).json({ erro: "Propriedade, tipo de visita e observação não podem ficar vazios." });
        return;
      }

      const agora = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
      const linhaLog = `[${agora}] ${usuario.nome} alterou: ${mudancas.join("; ")}`;
      const historicoAtual = String(existente.historico_edicoes || "").trim();
      atualizacao.historico_edicoes = historicoAtual ? `${historicoAtual}\n${linhaLog}` : linhaLog;

      const { error: erroUpdate } = await supabase.from("visitas").update(atualizacao).eq("id", id);
      if (erroUpdate) throw erroUpdate;

      res.status(200).json({ status: "ok" });
    } catch (err) {
      res.status(502).json({ erro: "Falha ao atualizar a visita.", detalhe: String(err.message || err) });
    }
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ erro: "Use GET, POST ou PATCH." });
    return;
  }

  let visita = req.body || {};

  // Se o usuário logado não for Gerente/Desenvolvedor, o nome do promotor gravado
  // é sempre o do próprio usuário logado — evita registrar visita em nome de outro.
  const usuario = usuarioDaRequisicao(req);
  if (usuario && !CARGOS_GESTAO.includes(String(usuario.cargo || "").toLowerCase())) {
    visita = { ...visita, Nome_Promotor: usuario.nome };
  }

  if (!validarVisita(visita)) {
    res.status(400).json({
      erro: "Dados incompletos: informe promotor, propriedade, tipo de visita, observação, data (AAAA-MM-DD) e quinzena."
    });
    return;
  }

  try {
    const linhaNova = {
      nome_promotor: String(visita.Nome_Promotor).trim(),
      propriedade: String(visita.Propriedade).trim(),
      tipo_visita: String(visita.Tipo_Visita).trim(),
      observacao: String(visita.Observacao).trim(),
      foto_url: String(visita.Foto_URL || "").trim(),
      latitude: visita.Latitude === undefined || visita.Latitude === null || visita.Latitude === "" ? null : Number(visita.Latitude),
      longitude: visita.Longitude === undefined || visita.Longitude === null || visita.Longitude === "" ? null : Number(visita.Longitude),
      dia_visita: visita.Dia_Visita,
      quinzena: visita.Quinzena,
      id_envio: visita.Id_Envio ? String(visita.Id_Envio).trim() : null
    };

    const { error: erroInsert } = await supabase.from("visitas").insert(linhaNova);

    // Índice único de id_envio recusou: já foi gravada antes (reenvio da fila offline).
    // Devolve sucesso com duplicado:true pro app limpar a fila sem duplicar a visita.
    if (erroInsert && erroInsert.code === "23505") {
      res.status(200).json({ status: "ok", duplicado: true });
      return;
    }
    if (erroInsert) throw erroInsert;

    res.status(200).json({ status: "ok" });
  } catch (err) {
    res.status(502).json({ erro: "Falha ao gravar a visita no banco.", detalhe: String(err.message || err) });
  }
};
