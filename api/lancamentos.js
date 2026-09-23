// Vercel Serverless Function — grava lançamentos (pedidos) na tabela "lancamentos" no
// Supabase (Postgres). Última tabela migrada do SharePoint/Excel para o banco de verdade
// (depois de "propriedades", "produtos", "usuarios" e "visitas") — migração completa.
//
// As propriedades já são cadastradas antes, com dados completos, pelo assistente de
// cadastro (ver api/propriedades.js). Esta função só grava a transação de venda.
//
// PEDIDO BALCÃO (alterado em 21/09/2026): Propriedade deixou de ser obrigatória. Um
// pedido pode ser vinculado só à revenda, sem fazenda — usado quando a venda acontece no
// balcão, não numa visita a campo. Nesse caso o front-end manda Propriedade = "" e a
// exigência de Observacao_Visita também é dispensada (não existe "o que foi tratado na
// visita" quando não houve visita). Pedido vinculado a uma fazenda continua exigindo a
// observação, como sempre. Não foi preciso mudar nada no schema: propriedade vazia já é
// tratada corretamente pelos agregados de api/relatorios.js (entradas sem propriedade são
// ignoradas em porFazenda/totalFazendas, mas continuam contando em totalPedidos/valorPedidos
// e em porRevenda).
//
// Cada pedido agora exige que o promotor descreva o que foi tratado na visita
// (Observacao_Visita, obrigatório quando há fazenda) e permite deixar uma nota opcional do
// que tratar na próxima visita (Proxima_Visita). Essa nota, quando preenchida, também é
// salva na própria fazenda (coluna "proximo_assunto" em "propriedades") para aparecer como
// lembrete da próxima vez que alguém abrir essa fazenda pra lançar um pedido/visita — só se
// aplica a pedido vinculado a fazenda, é ignorada no pedido balcão.
//
// GET também aceita, combináveis: ?propriedade=X (busca parcial no nome da fazenda),
// ?revenda=X (busca parcial no nome da revenda), ?quinzena=AAAA-MM-N (só lançamentos
// daquela quinzena) — usados na busca de histórico e no drill-down do relatório
// (Gerente/Desenvolvedor).
//
// id_envio: identificador único gerado pelo CELULAR, um por LINHA (não por pedido — ver
// OFFLINE.md, seção 6), usado só pela fila offline. Num reenvio de um pedido que já foi
// gravado, o índice único recusa TODAS as linhas (mesmo UUID de novo) e esta função
// devolve 200 com duplicado:true, para o app limpar a fila sem duplicar o pedido.
//
// EDIÇÃO COM LOG (novo em 23/09/2026): pedido já lançado pode ser editado depois — pelo
// próprio promotor que lançou ou por Gerente/Desenvolvedor — via PATCH /api/lancamentos.
// Cada edição fica registrada em texto na coluna "historico_edicoes" (quem, quando, o que
// mudou de/para), devolvida pro front como Historico_Edicoes. Por isso o GET agora também
// devolve o Id (chave da linha no banco), necessário pra apontar qual lançamento editar —
// PATCH /api/lancamentos              -> { Id, ...campos a alterar }
//
// Colunas da tabela "lancamentos" no Supabase: id, nome_promotor, revenda, propriedade,
// produto, unidade, preco_unitario, volume, valor_total, dia_lancamento, quinzena,
// observacao_visita, proxima_visita, id_envio, historico_edicoes.
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
    Revenda: l.revenda || "",
    Propriedade: l.propriedade || "",
    Produto: l.produto || "",
    Unidade: l.unidade || "",
    Preco_Unitario: l.preco_unitario === undefined || l.preco_unitario === null ? 0 : Number(l.preco_unitario),
    Volume: l.volume === undefined || l.volume === null ? 0 : Number(l.volume),
    Valor_Total: l.valor_total === undefined || l.valor_total === null ? 0 : Number(l.valor_total),
    Dia_Lancamento: l.dia_lancamento || "",
    Quinzena: l.quinzena || "",
    Observacao_Visita: l.observacao_visita || "",
    Proxima_Visita: l.proxima_visita || "",
    Id_Envio: l.id_envio || "",
    Historico_Edicoes: l.historico_edicoes || ""
  };
}

function validarRegistro(r) {
  if (!r || typeof r !== "object") return false;
  if (!r.Nome_Promotor || !r.Revenda || !r.Produto || !r.Dia_Lancamento || !r.Quinzena) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.Dia_Lancamento))) return false;

  // O promotor precisa descrever o que foi tratado na visita SE o pedido estiver
  // vinculado a uma fazenda. Pedido balcão (sem Propriedade) não passa por essa exigência,
  // porque não houve visita nenhuma associada.
  const temFazenda = !!(r.Propriedade && String(r.Propriedade).trim());
  if (temFazenda && (!r.Observacao_Visita || !String(r.Observacao_Visita).trim())) return false;

  const preco = Number(r.Preco_Unitario);
  const volume = Number(r.Volume);
  if (Number.isNaN(preco) || preco < 0) return false;
  if (Number.isNaN(volume) || volume <= 0) return false;

  return true;
}

// Campos que o PATCH aceita alterar, e o nome da coluna correspondente. Nome_Promotor,
// Dia_Lancamento e Quinzena ficam de fora de propósito — trocar o dono ou a data de um
// pedido já lançado bagunçaria relatórios/metas fechados daquele período; quem lançou
// errado deve pedir pro gestor cancelar/relançar, não "mover" o registro.
const CAMPOS_EDITAVEIS_LANCAMENTO = {
  Revenda: "revenda",
  Propriedade: "propriedade",
  Produto: "produto",
  Unidade: "unidade",
  Preco_Unitario: "preco_unitario",
  Volume: "volume",
  Observacao_Visita: "observacao_visita",
  Proxima_Visita: "proxima_visita"
};
const CAMPOS_NUMERICOS_LANCAMENTO = ["Preco_Unitario", "Volume"];

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
      const revendaFiltro = String((req.query && req.query.revenda) || "").trim();
      const quinzenaFiltro = String((req.query && req.query.quinzena) || "").trim();

      function montarConsulta() {
        let c = supabase.from("lancamentos").select("*");
        if (promotorFiltro) c = c.ilike("nome_promotor", promotorFiltro);
        if (propriedadeFiltro) c = c.ilike("propriedade", `%${propriedadeFiltro}%`);
        if (revendaFiltro) c = c.ilike("revenda", `%${revendaFiltro}%`);
        // O filtro de semana NÃO é feito aqui no banco: a coluna "quinzena" guarda o texto
        // já formatado ("Semana 07–13/Set/2026"), enquanto o front manda a CHAVE (a data
        // da segunda-feira, "2026-09-07") — nunca dariam match num .eq() direto. Em vez
        // disso, filtra em JS recalculando a chave a partir de dia_lancamento (ver abaixo).
        return c;
      }

      // Busca em blocos de 1000 (limite padrão do Supabase), aplicando os mesmos filtros
      // em cada bloco.
      const TAMANHO_BLOCO = 1000;
      let todasLinhas = [];
      let inicio = 0;
      while (true) {
        const { data, error } = await montarConsulta()
          .order("dia_lancamento", { ascending: false })
          .range(inicio, inicio + TAMANHO_BLOCO - 1);
        if (error) throw error;
        todasLinhas = todasLinhas.concat(data || []);
        if (!data || data.length < TAMANHO_BLOCO) break;
        inicio += TAMANHO_BLOCO;
      }

      let lancamentos = todasLinhas.map(paraObjeto);
      if (quinzenaFiltro) {
        lancamentos = lancamentos.filter(l => quinzenaChave(l.Dia_Lancamento) === quinzenaFiltro);
      }
      res.status(200).json({ lancamentos });
    } catch (err) {
      res.status(502).json({ erro: "Falha ao ler lançamentos no banco.", detalhe: String(err.message || err) });
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
      res.status(400).json({ erro: "Informe o Id do pedido a editar." });
      return;
    }

    try {
      const { data: existente, error: erroBusca } = await supabase
        .from("lancamentos")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (erroBusca) throw erroBusca;
      if (!existente) {
        res.status(404).json({ erro: "Pedido não encontrado." });
        return;
      }
      if (!ehGestor && String(existente.nome_promotor || "").toLowerCase() !== usuario.nome.toLowerCase()) {
        res.status(403).json({ erro: "Você só pode editar pedidos lançados por você." });
        return;
      }

      const atualizacao = {};
      const mudancas = [];
      for (const [chaveFront, colunaBanco] of Object.entries(CAMPOS_EDITAVEIS_LANCAMENTO)) {
        if (!Object.prototype.hasOwnProperty.call(corpo, chaveFront)) continue;
        let novoValor = corpo[chaveFront];
        if (CAMPOS_NUMERICOS_LANCAMENTO.includes(chaveFront)) {
          novoValor = Number(novoValor);
          if (Number.isNaN(novoValor)) {
            res.status(400).json({ erro: `Valor inválido para ${chaveFront}.` });
            return;
          }
        } else {
          novoValor = String(novoValor || "").trim();
        }
        const valorAtual = existente[colunaBanco];
        const mudou = CAMPOS_NUMERICOS_LANCAMENTO.includes(chaveFront)
          ? Number(valorAtual) !== novoValor
          : String(valorAtual || "").trim() !== novoValor;
        if (mudou) {
          mudancas.push(`${chaveFront}: ${formatarValorLog(valorAtual)} → ${formatarValorLog(novoValor)}`);
          atualizacao[colunaBanco] = novoValor;
        }
      }

      // Um pedido vinculado a fazenda continua exigindo a descrição do que foi tratado —
      // mesma regra do lançamento novo, agora reaplicada considerando o valor final (já
      // atualizado ou o que já existia).
      const propriedadeFinal = atualizacao.propriedade !== undefined ? atualizacao.propriedade : (existente.propriedade || "");
      const observacaoFinal = atualizacao.observacao_visita !== undefined ? atualizacao.observacao_visita : (existente.observacao_visita || "");
      if (String(propriedadeFinal).trim() && !String(observacaoFinal).trim()) {
        res.status(400).json({ erro: "Pedido vinculado a uma fazenda precisa da descrição do que foi tratado na visita." });
        return;
      }

      if (Object.keys(atualizacao).length === 0) {
        res.status(200).json({ status: "ok", semAlteracoes: true });
        return;
      }

      // Recalcula o valor total se preço ou volume mudaram.
      if (atualizacao.preco_unitario !== undefined || atualizacao.volume !== undefined) {
        const precoFinal = atualizacao.preco_unitario !== undefined ? atualizacao.preco_unitario : Number(existente.preco_unitario) || 0;
        const volumeFinal = atualizacao.volume !== undefined ? atualizacao.volume : Number(existente.volume) || 0;
        atualizacao.valor_total = precoFinal * volumeFinal;
      }

      const agora = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
      const linhaLog = `[${agora}] ${usuario.nome} alterou: ${mudancas.join("; ")}`;
      const historicoAtual = String(existente.historico_edicoes || "").trim();
      atualizacao.historico_edicoes = historicoAtual ? `${historicoAtual}\n${linhaLog}` : linhaLog;

      const { error: erroUpdate } = await supabase.from("lancamentos").update(atualizacao).eq("id", id);
      if (erroUpdate) throw erroUpdate;

      // Se a próxima visita foi alterada e o pedido está vinculado a uma fazenda, atualiza
      // o lembrete gravado na própria fazenda, igual acontece no lançamento novo.
      if (atualizacao.proxima_visita !== undefined && String(propriedadeFinal).trim()) {
        await supabase.from("propriedades").update({ proximo_assunto: atualizacao.proxima_visita }).ilike("propriedade", propriedadeFinal);
      }

      res.status(200).json({ status: "ok" });
    } catch (err) {
      res.status(502).json({ erro: "Falha ao atualizar o pedido.", detalhe: String(err.message || err) });
    }
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ erro: "Use GET, POST ou PATCH." });
    return;
  }

  let lancamentos = (req.body && req.body.lancamentos) || [];
  if (!Array.isArray(lancamentos) || lancamentos.length === 0) {
    res.status(400).json({ erro: "Envie 'lancamentos' como um array não vazio." });
    return;
  }

  // Se o usuário logado não for Gerente/Desenvolvedor, o nome do promotor gravado
  // é sempre o do próprio usuário logado — evita que alguém lance venda em nome de
  // outro promotor só editando o payload.
  const usuario = usuarioDaRequisicao(req);
  if (usuario && !CARGOS_GESTAO.includes(String(usuario.cargo || "").toLowerCase())) {
    lancamentos = lancamentos.map(r => ({ ...r, Nome_Promotor: usuario.nome }));
  }

  const invalidos = lancamentos.filter(r => !validarRegistro(r));
  if (invalidos.length > 0) {
    res.status(400).json({
      erro: "Um ou mais registros estão incompletos (falta revenda/produto/data), sem a descrição do que foi tratado na visita quando vinculados a uma fazenda, com data em formato inválido (esperado AAAA-MM-DD) ou preço/volume inválidos.",
      invalidos
    });
    return;
  }

  try {
    const linhasNovas = lancamentos.map(r => ({
      nome_promotor: String(r.Nome_Promotor).trim(),
      revenda: String(r.Revenda).trim(),
      propriedade: String(r.Propriedade || "").trim(),
      produto: String(r.Produto).trim(),
      unidade: String(r.Unidade || "").trim(),
      preco_unitario: Number(r.Preco_Unitario),
      volume: Number(r.Volume),
      valor_total: Number(r.Preco_Unitario) * Number(r.Volume),
      dia_lancamento: r.Dia_Lancamento,
      quinzena: r.Quinzena,
      observacao_visita: String(r.Observacao_Visita || "").trim(),
      proxima_visita: String(r.Proxima_Visita || "").trim(),
      id_envio: r.Id_Envio ? String(r.Id_Envio).trim() : null
    }));

    const { error: erroInsert } = await supabase.from("lancamentos").insert(linhasNovas);

    // Índice único de id_envio recusou pelo menos uma linha: como o insert é uma
    // transação só, isso significa que o pedido INTEIRO já foi gravado antes (reenvio
    // da fila offline, mesmos Id_Envio por linha). Devolve sucesso com duplicado:true
    // pro app limpar a fila sem duplicar o pedido.
    if (erroInsert && erroInsert.code === "23505") {
      res.status(200).json({ status: "ok", duplicado: true, inseridos: linhasNovas.length });
      return;
    }
    if (erroInsert) throw erroInsert;

    // Se alguma nota de "próxima visita" foi preenchida, salva na própria fazenda como
    // lembrete — aparece pro promotor da próxima vez que abrir essa fazenda pra lançar.
    // Só se aplica quando o pedido está vinculado a uma fazenda (pedido balcão não tem
    // propriedade pra gravar o lembrete).
    const notaProximaVisita = String(lancamentos[0].Proxima_Visita || "").trim();
    const nomeFazenda = String(lancamentos[0].Propriedade || "").trim();
    if (notaProximaVisita && nomeFazenda) {
      await supabase.from("propriedades").update({ proximo_assunto: notaProximaVisita }).ilike("propriedade", nomeFazenda);
    }

    res.status(200).json({ status: "ok", inseridos: linhasNovas.length });
  } catch (err) {
    res.status(502).json({ erro: "Falha ao gravar os lançamentos no banco.", detalhe: String(err.message || err) });
  }
};
