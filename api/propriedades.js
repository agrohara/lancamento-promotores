// Vercel Serverless Function — lê e cria registros na tabela "propriedades" no Supabase
// (Postgres). Primeira tabela migrada do SharePoint/Excel para o banco de verdade — as
// demais (Lancamentos, Visitas, Usuarios, Produtos) continuam no SharePoint por enquanto,
// migração acontece aos poucos. O catálogo de propriedades é GLOBAL (uma fazenda não
// pertence a uma única revenda — pode ser atendida por revendas diferentes da carteira
// de cada promotor).
//
// GET  /api/propriedades              -> lista os nomes de todas as propriedades cadastradas
// GET  /api/propriedades?nome=X       -> devolve os dados completos de UMA propriedade
// GET  /api/propriedades?completo=1   -> devolve os dados completos de TODAS (usado na exportação)
// POST /api/propriedades              -> cadastra uma propriedade nova, com os dados completos
//
// Colunas da tabela "propriedades" no Supabase (todas em minúsculo/snake_case, padrão do
// Postgres): propriedade, municipio, proprietario, decisor, vendedor_responsavel,
// tipo_propriedade, matrizes, primiparas, novilhas, bezerros_machos, bezerros_femeas,
// garrotes, touros, equinos, cadastrada_por, data_cadastro, latitude, longitude.
// O restante do app (index.html) continua enviando/recebendo os nomes em
// Maiusculas_Com_Underscore de sempre — a conversão acontece só aqui dentro.
//
// Variáveis de ambiente necessárias: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (chave
// secreta — nunca a "anon"/"publishable" — pois esta função grava dados e ignora RLS de
// propósito), API_KEY (mesma chave compartilhada com o front-end de sempre).

const { createClient } = require("@supabase/supabase-js");

function obterSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
  });
}

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
    Longitude: l.longitude === undefined || l.longitude === null ? null : Number(l.longitude)
  };
}

function validarCadastro(p) {
  if (!p || typeof p !== "object") return false;
  if (!p.Propriedade || !String(p.Propriedade).trim()) return false;
  if (!p.Municipio || !String(p.Municipio).trim()) return false;
  if (!p.Proprietario || !String(p.Proprietario).trim()) return false;
  if (!p.Vendedor_Responsavel || !String(p.Vendedor_Responsavel).trim()) return false;
  if (!p.Tipo_Propriedade || !String(p.Tipo_Propriedade).trim()) return false;

  const camposNumericos = ["Matrizes", "Primiparas", "Novilhas", "Bezerros_Machos", "Bezerros_Femeas", "Garrotes", "Touros", "Equinos"];
  for (const campo of camposNumericos) {
    const valor = Number(p[campo]);
    if (Number.isNaN(valor) || valor < 0) return false;
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

  const supabase = obterSupabase();

  if (req.method === "GET") {
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
        if (!data) {
          res.status(404).json({ erro: "Propriedade não encontrada." });
          return;
        }
        res.status(200).json({ propriedade: paraObjeto(data) });
        return;
      }

      // .range() explícito porque o Supabase limita a 1000 linhas por padrão — sem isso a
      // lista vem cortada quando o catálogo crescer além disso.
      if (req.query && req.query.completo) {
        const { data, error } = await supabase
          .from("propriedades")
          .select("*")
          .order("propriedade", { ascending: true })
          .range(0, 19999);
        if (error) throw error;
        res.status(200).json({ propriedades: (data || []).map(paraObjeto) });
        return;
      }

      const { data, error } = await supabase
        .from("propriedades")
        .select("propriedade")
        .order("propriedade", { ascending: true })
        .range(0, 19999);
      if (error) throw error;
      res.status(200).json({ propriedades: (data || []).map(l => l.propriedade).filter(Boolean) });
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
        longitude: dadosBody.Longitude === undefined || dadosBody.Longitude === "" || dadosBody.Longitude === null ? null : Number(dadosBody.Longitude)
      };

      const { error: erroInsert } = await supabase.from("propriedades").insert(linhaNova);
      if (erroInsert) throw erroInsert;

      res.status(201).json({ status: "ok", propriedade: nomeNovo });
    } catch (err) {
      res.status(502).json({ erro: "Falha ao cadastrar propriedade.", detalhe: String(err.message || err) });
    }
    return;
  }

  res.status(405).json({ erro: "Use GET ou POST." });
};
