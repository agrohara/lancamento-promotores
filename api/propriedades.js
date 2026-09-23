// Vercel Serverless Function — lê e cria registros na tabela "propriedades" no Supabase
// (Postgres). Primeira tabela migrada do SharePoint/Excel para o banco de verdade — as
// demais (Lancamentos, Visitas, Usuarios, Produtos) continuam no SharePoint por enquanto,
// migração acontece aos poucos.
//
// VISIBILIDADE (alterado em 21/09/2026): o catálogo de propriedades NÃO é mais global.
// Cada Promotor só vê (lista, detalhe e exportação completa) as fazendas que ele mesmo
// cadastrou (campo "cadastrada_por"). Gerente/Desenvolvedor continua vendo todas. Antes
// disso o GET não exigia identidade nenhuma — só a x-api-key — e por isso um promotor via
// fazendas cadastradas por outro. Agora o GET passa a exigir também
// Authorization: Bearer <token>, igual aos outros endpoints protegidos.
//
// EDIÇÃO (alterado em 23/09/2026): o PATCH deixou de aceitar só latitude/longitude — agora
// aceita qualquer um dos campos editáveis do cadastro (útil, por exemplo, quando a fazenda
// foi cadastrada sem localização e o promotor volta lá depois pra marcar no mapa). E foi
// corrigida uma falha de segurança: o PATCH não checava QUEM estava editando. Agora exige
// Authorization: Bearer <token> como o GET, e só permite editar quem cadastrou a fazenda
// (cadastrada_por) ou Gerente/Desenvolvedor — mesma regra usada em Pedido e Visita.
//
// GET   /api/propriedades              -> lista os nomes das propriedades visíveis pro usuário logado
// GET   /api/propriedades?nome=X       -> devolve os dados completos de UMA propriedade (só se visível pro usuário)
// GET   /api/propriedades?completo=1   -> devolve os dados completos de TODAS as visíveis (usado na exportação)
// POST  /api/propriedades              -> cadastra uma propriedade nova, com os dados completos
// PATCH /api/propriedades              -> atualiza um ou mais campos de uma propriedade já
//                                         cadastrada, pelo nome (Propriedade). Só quem cadastrou
//                                         a fazenda ou Gerente/Desenvolvedor pode editar.
//
// Colunas da tabela "propriedades" no Supabase (todas em minúsculo/snake_case, padrão do
// Postgres): propriedade, municipio, proprietario, decisor, vendedor_responsavel,
// tipo_propriedade, matrizes, primiparas, novilhas, bezerros_machos, bezerros_femeas,
// garrotes, touros, equinos, cadastrada_por, data_cadastro, latitude, longitude,
// personalidade_decisor, personalidade_observacao, proximo_assunto (o que o promotor
// combinou tratar na próxima visita — preenchido no Novo Pedido, ver api/lancamentos.js).
// O restante do app (index.html) continua enviando/recebendo os nomes em
// Maiusculas_Com_Underscore de sempre — a conversão acontece só aqui dentro.
//
// Variáveis de ambiente necessárias: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (chave
// secreta — nunca a "anon"/"publishable" — pois esta função grava dados e ignora RLS de
// propósito), API_KEY (mesma chave compartilhada com o front-end de sempre), AUTH_SECRET
// (necessária agora pro GET/PATCH verificar o token do usuário).

const { usuarioDaRequisicao } = require("./_lib/auth");
const { obterSupabase, buscarTodasLinhas } = require("./_lib/supabase");

const CARGOS_GESTAO = ["gerente", "desenvolvedor"];

function paraObjeto(l) {
  return {
    Propriedade: l.propriedade || "",
    Municipio: l.municipio || "",
    Proprietario: l.proprietario || "",
    Decisor: l.decisor || "",
    Vendedor_Responsavel: l.vendedor_responsavel || "",
    Tipo_Propriedade: l.tipo_propriedade || "",
    Matrizes: Number(l.matrizes) || 0,
    Primiparas: Number(l.primiparas) || 0,
    Novilhas: Number(l.novilhas) || 0,
    Bezerros_Machos: Number(l.bezerros_machos) || 0,
    Bezerros_Femeas: Number(l.bezerros_femeas) || 0,
    Garrotes: Number(l.garrotes) || 0,
    Touros: Number(l.touros) || 0,
    Equinos: Number(l.equinos) || 0,
    Cadastrada_Por: l.cadastrada_por || "",
    Data_Cadastro: l.data_cadastro || "",
    Latitude: l.latitude === undefined || l.latitude === null ? null : Number(l.latitude),
    Longitude: l.longitude === undefined || l.longitude === null ? null : Number(l.longitude),
    Personalidade_Decisor: l.personalidade_decisor || "",
    Personalidade_Observacao: l.personalidade_observacao || "",
    Proximo_Assunto: l.proximo_assunto || ""
  };
}

function validarCadastro(p) {
  if (!p || typeof p !== "object") return false;
  if (!p.Propriedade || !String(p.Propriedade).trim()) return false;
  if (!p.Municipio || !String(p.Municipio).trim()) return false;
  if (!p.Proprietario || !String(p.Proprietario).trim()) return false;
  if (!p.Vendedor_Responsavel || !String(p.Vendedor_Responsavel).trim()) return false;
  if (!p.Tipo_Propriedade || !String(p.Tipo_Propriedade).trim()) return false;
  if (!p.Personalidade_Decisor || !String(p.Personalidade_Decisor).trim()) return false;

  const camposNumericos = ["Matrizes", "Primiparas", "Novilhas", "Bezerros_Machos", "Bezerros_Femeas", "Garrotes", "Touros", "Equinos"];
  for (const campo of camposNumericos) {
    const valor = Number(p[campo]);
    if (Number.isNaN(valor) || valor < 0) return false;
  }
  return true;
}

// Campos que o PATCH aceita alterar, e o nome da coluna correspondente no banco. A
// Propriedade (nome) NÃO está aqui de propósito — ela é a chave usada pra localizar o
// registro; renomear a fazenda por esse endpoint abriria brecha pra duplicidade/perda de
// histórico vinculado pelo nome.
const CAMPOS_EDITAVEIS_PROPRIEDADE = {
  Municipio: "municipio",
  Proprietario: "proprietario",
  Decisor: "decisor",
  Vendedor_Responsavel: "vendedor_responsavel",
  Tipo_Propriedade: "tipo_propriedade",
  Matrizes: "matrizes",
  Primiparas: "primiparas",
  Novilhas: "novilhas",
  Bezerros_Machos: "bezerros_machos",
  Bezerros_Femeas: "bezerros_femeas",
  Garrotes: "garrotes",
  Touros: "touros",
  Equinos: "equinos",
  Latitude: "latitude",
  Longitude: "longitude",
  Personalidade_Decisor: "personalidade_decisor",
  Personalidade_Observacao: "personalidade_observacao"
};
const CAMPOS_NUMERICOS_PROPRIEDADE = ["Matrizes", "Primiparas", "Novilhas", "Bezerros_Machos", "Bezerros_Femeas", "Garrotes", "Touros", "Equinos", "Latitude", "Longitude"];

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

    try {
      const nomeBuscado = String((req.query && req.query.nome) || "").trim();
      if (nomeBuscado) {
        const { data, error } = await supabase
          .from("propriedades")
          .select("*")
          .ilike("propriedade", nomeBuscado)
          .limit(1)
          .maybeSingle();
        if (error) throw error;
        if (!data || (!ehGestor && String(data.cadastrada_por || "").toLowerCase() !== usuario.nome.toLowerCase())) {
          res.status(404).json({ erro: "Propriedade não encontrada." });
          return;
        }
        res.status(200).json({ propriedade: paraObjeto(data) });
        return;
      }

      if (req.query && req.query.completo) {
        const data = await buscarTodasLinhas(supabase, "propriedades", "*", "propriedade");
        const visiveis = ehGestor
          ? data
          : data.filter(l => String(l.cadastrada_por || "").toLowerCase() === usuario.nome.toLowerCase());
        res.status(200).json({ propriedades: visiveis.map(paraObjeto) });
        return;
      }

      const data = await buscarTodasLinhas(supabase, "propriedades", "propriedade, cadastrada_por", "propriedade");
      const visiveis = ehGestor
        ? data
        : data.filter(l => String(l.cadastrada_por || "").toLowerCase() === usuario.nome.toLowerCase());
      res.status(200).json({ propriedades: visiveis.map(l => l.propriedade).filter(Boolean) });
    } catch (err) {
      res.status(502).json({ erro: "Falha ao ler propriedades no banco.", detalhe: String(err.message || err) });
    }
    return;
  }

  if (req.method === "POST") {
    const dadosBody = req.body || {};
    if (!validarCadastro(dadosBody)) {
      res.status(400).json({ erro: "Dados incompletos ou inválidos para o cadastro da propriedade." });
      return;
    }

    try {
      const nomeNovo = String(dadosBody.Propriedade).trim();

      const { data: existente, error: erroBusca } = await supabase
        .from("propriedades")
        .select("propriedade")
        .ilike("propriedade", nomeNovo)
        .limit(1)
        .maybeSingle();
      if (erroBusca) throw erroBusca;
      if (existente) {
        res.status(409).json({ erro: "Já existe uma propriedade cadastrada com esse nome. Busque por ela na tela anterior." });
        return;
      }

      const linhaNova = {
        propriedade: nomeNovo,
        municipio: String(dadosBody.Municipio).trim(),
        proprietario: String(dadosBody.Proprietario).trim(),
        decisor: String(dadosBody.Decisor || "").trim(),
        vendedor_responsavel: String(dadosBody.Vendedor_Responsavel).trim(),
        tipo_propriedade: String(dadosBody.Tipo_Propriedade).trim(),
        matrizes: Number(dadosBody.Matrizes) || 0,
        primiparas: Number(dadosBody.Primiparas) || 0,
        novilhas: Number(dadosBody.Novilhas) || 0,
        bezerros_machos: Number(dadosBody.Bezerros_Machos) || 0,
        bezerros_femeas: Number(dadosBody.Bezerros_Femeas) || 0,
        garrotes: Number(dadosBody.Garrotes) || 0,
        touros: Number(dadosBody.Touros) || 0,
        equinos: Number(dadosBody.Equinos) || 0,
        cadastrada_por: String(dadosBody.Cadastrada_Por || "").trim(),
        data_cadastro: new Date().toISOString().slice(0, 10),
        latitude: dadosBody.Latitude === undefined || dadosBody.Latitude === "" || dadosBody.Latitude === null ? null : Number(dadosBody.Latitude),
        longitude: dadosBody.Longitude === undefined || dadosBody.Longitude === "" || dadosBody.Longitude === null ? null : Number(dadosBody.Longitude),
        personalidade_decisor: String(dadosBody.Personalidade_Decisor || "").trim(),
        personalidade_observacao: String(dadosBody.Personalidade_Observacao || "").trim()
      };

      const { error: erroInsert } = await supabase.from("propriedades").insert(linhaNova);
      if (erroInsert) throw erroInsert;

      res.status(201).json({ status: "ok", propriedade: nomeNovo });
    } catch (err) {
      res.status(502).json({ erro: "Falha ao cadastrar propriedade.", detalhe: String(err.message || err) });
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
    const nome = String(corpo.Propriedade || "").trim();
    if (!nome) {
      res.status(400).json({ erro: "Informe a propriedade." });
      return;
    }

    try {
      const { data: existente, error: erroBusca } = await supabase
        .from("propriedades")
        .select("*")
        .ilike("propriedade", nome)
        .limit(1)
        .maybeSingle();
      if (erroBusca) throw erroBusca;
      if (!existente) {
        res.status(404).json({ erro: "Propriedade não encontrada." });
        return;
      }
      if (!ehGestor && String(existente.cadastrada_por || "").toLowerCase() !== usuario.nome.toLowerCase()) {
        res.status(403).json({ erro: "Você só pode editar fazendas cadastradas por você." });
        return;
      }

      const atualizacao = {};
      for (const [chaveFront, colunaBanco] of Object.entries(CAMPOS_EDITAVEIS_PROPRIEDADE)) {
        if (!Object.prototype.hasOwnProperty.call(corpo, chaveFront)) continue;
        let valor = corpo[chaveFront];
        if (CAMPOS_NUMERICOS_PROPRIEDADE.includes(chaveFront)) {
          if (valor === "" || valor === null || valor === undefined) {
            valor = ["Latitude", "Longitude"].includes(chaveFront) ? null : 0;
          } else {
            valor = Number(valor);
            if (Number.isNaN(valor)) {
              res.status(400).json({ erro: `Valor inválido para ${chaveFront}.` });
              return;
            }
          }
        } else {
          valor = String(valor || "").trim();
        }
        atualizacao[colunaBanco] = valor;
      }

      if (Object.keys(atualizacao).length === 0) {
        res.status(200).json({ status: "ok", semAlteracoes: true });
        return;
      }

      const { error: erroUpdate } = await supabase
        .from("propriedades")
        .update(atualizacao)
        .ilike("propriedade", nome);
      if (erroUpdate) throw erroUpdate;

      res.status(200).json({ status: "ok" });
    } catch (err) {
      res.status(502).json({ erro: "Falha ao atualizar a propriedade.", detalhe: String(err.message || err) });
    }
    return;
  }

  res.status(405).json({ erro: "Use GET, POST ou PATCH." });
};
