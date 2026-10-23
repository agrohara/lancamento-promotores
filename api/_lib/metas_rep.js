// Metas por REPRESENTANTE (promotor/vendedor) com período (mensal, trimestral, semestral ou
// anual) e ano — meta geral (R$ em pedidos) e metas de CESTA de produtos. Fica em _lib (não
// conta como função Vercel) e é chamado por api/agenda.js quando a requisição traz
// ?recurso=metas.
//
// GET  /api/agenda?recurso=metas&acao=periodo&tipo=mensal&ano=2026&periodo=10
//        -> metas cadastradas + progresso de um período específico (tela de cadastro e seção
//           "Metas" da visão gerencial). Gerente vê todos; promotor só o próprio.
// GET  /api/agenda?recurso=metas&acao=vigentes[&representante=X]
//        -> progresso de todas as metas cujo período contém hoje (Início/Relatórios do app).
// POST /api/agenda?recurso=metas   (só Gerente/Desenvolvedor)
//        body { escopo:"geral"|"cesta", tipo, ano, periodo, itens:[{representante, cesta?, valor}] }
//        valor 0 (ou vazio) REMOVE a meta daquele item. Tudo é gravado no log (nunca apagado).
//
// Tabelas (ver sql_metas_representante.sql): metas_representante, metas_cesta_representante,
// metas_representante_log. Realizado = soma de lancamentos.valor_total do representante dentro
// do período; na cesta, só os produtos que pertencem à cesta (tabela cestas).

const DIA = 86400000;
const TIPOS = { mensal: 12, trimestral: 4, semestral: 2, anual: 1 };
const MESES = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const pad = n => String(n).padStart(2, "0");
const ms = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const iso = m => new Date(m).toISOString().slice(0, 10);
const r2 = n => Math.round(n * 100) / 100;
const igual = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();

function falha(msg, status) { const e = new Error(msg); e.http = status || 400; throw e; }

// "Hoje" no horário de Brasília (o servidor roda em UTC).
function hojeBR() { return new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10); }

function validarPeriodo(tipo, ano, periodo) {
  tipo = String(tipo || "").toLowerCase();
  if (!TIPOS[tipo]) falha("Escolha o tipo da meta: mensal, trimestral, semestral ou anual.");
  ano = Number(ano);
  if (!Number.isInteger(ano) || ano < 2020 || ano > 2100) falha("Informe um ano válido.");
  periodo = tipo === "anual" ? 1 : Number(periodo);
  if (!Number.isInteger(periodo) || periodo < 1 || periodo > TIPOS[tipo]) falha("Escolha o período da meta.");
  return { tipo, ano, periodo };
}

function intervalo(tipo, ano, periodo) {
  let m1, m2;
  if (tipo === "mensal") { m1 = m2 = periodo; }
  else if (tipo === "trimestral") { m1 = (periodo - 1) * 3 + 1; m2 = periodo * 3; }
  else if (tipo === "semestral") { m1 = (periodo - 1) * 6 + 1; m2 = periodo * 6; }
  else { m1 = 1; m2 = 12; }
  const ini = `${ano}-${pad(m1)}-01`;
  const fim = `${ano}-${pad(m2)}-${pad(new Date(Date.UTC(ano, m2, 0)).getUTCDate())}`;
  const rotulo = tipo === "mensal" ? `${MESES[m1 - 1]}/${ano}` : tipo === "trimestral" ? `${periodo}º tri/${ano}` : tipo === "semestral" ? `${periodo}º sem/${ano}` : String(ano);
  return { ini, fim, rotulo };
}

// Período (de cada tipo) que contém uma data.
function periodoDaData(tipo, dataIso) {
  const ano = +dataIso.slice(0, 4), mes = +dataIso.slice(5, 7);
  const periodo = tipo === "mensal" ? mes : tipo === "trimestral" ? Math.ceil(mes / 3) : tipo === "semestral" ? Math.ceil(mes / 6) : 1;
  return { tipo, ano, periodo };
}

async function paginar(montar) {
  let todas = [], inicio = 0;
  for (;;) {
    const { data, error } = await montar().range(inicio, inicio + 999);
    if (error) throw error;
    todas = todas.concat(data || []);
    if (!data || data.length < 1000) break;
    inicio += 1000;
  }
  return todas;
}

async function representantesCadastrados(supabase) {
  const { data } = await supabase.from("usuarios").select("nome, cargo").ilike("cargo", "promotor");
  return (data || []).map(u => String(u.nome || "").trim()).filter(Boolean).sort((a, b) => a.localeCompare(b, "pt-BR"));
}

// Calcula o progresso de uma lista de metas [{escopo,cesta,representante,tipo,ano,periodo,valor}].
async function calcularProgresso(supabase, metas, hoje) {
  if (!metas.length) return [];
  let minIni = "9999-12-31", maxFim = "0000-01-01";
  const comIntervalo = metas.map(m => {
    const it = intervalo(m.tipo, m.ano, m.periodo);
    if (it.ini < minIni) minIni = it.ini;
    if (it.fim > maxFim) maxFim = it.fim;
    return { m, it };
  });
  const reps = [...new Set(metas.map(m => String(m.representante).toLowerCase()))];
  const unico = reps.length === 1 ? metas[0].representante : null;

  const lanc = await paginar(() => {
    let q = supabase.from("lancamentos").select("nome_promotor,produto,valor_total,dia_lancamento").gte("dia_lancamento", minIni).lte("dia_lancamento", maxFim);
    if (unico) q = q.ilike("nome_promotor", String(unico).replace(/[\\%_]/g, c => "\\" + c));
    return q;
  });
  const pedidos = lanc.map(l => ({
    rep: String(l.nome_promotor || "").trim().toLowerCase(), produto: String(l.produto || "").trim().toLowerCase(),
    valor: Number(l.valor_total) || 0, data: String(l.dia_lancamento || "").slice(0, 10)
  }));

  // cestas -> conjunto de produtos
  const cestasUsadas = [...new Set(metas.filter(m => m.escopo === "cesta").map(m => m.cesta))];
  const prodDaCesta = new Map();
  if (cestasUsadas.length) {
    const { data } = await supabase.from("cestas").select("nome, produtos");
    (data || []).forEach(c => prodDaCesta.set(String(c.nome || "").trim(), new Set((c.produtos || []).map(p => String(p || "").trim().toLowerCase()))));
  }

  return comIntervalo.map(({ m, it }) => {
    const set = m.escopo === "cesta" ? (prodDaCesta.get(m.cesta) || new Set()) : null;
    let realizado = 0;
    for (const p of pedidos) {
      if (p.rep !== String(m.representante).toLowerCase() || p.data < it.ini || p.data > it.fim) continue;
      if (set && !set.has(p.produto)) continue;
      realizado += p.valor;
    }
    realizado = r2(realizado);
    const diasTotal = Math.round((ms(it.fim) - ms(it.ini)) / DIA) + 1;
    let diasDecorridos = Math.round((ms(hoje) - ms(it.ini)) / DIA) + 1;
    diasDecorridos = Math.max(0, Math.min(diasTotal, diasDecorridos));
    const futura = hoje < it.ini, encerrada = hoje > it.fim;
    const meta = Number(m.valor) || 0;
    const esperado = r2(meta * diasDecorridos / diasTotal);
    let situacao;
    if (futura) situacao = "futura";
    else if (realizado >= meta) situacao = "batida";
    else if (encerrada) situacao = "nao_batida";
    else situacao = realizado >= esperado * 0.95 ? "no_ritmo" : "atrasada";
    return {
      escopo: m.escopo, cesta: m.cesta || null, representante: m.representante, tipo: m.tipo, ano: m.ano, periodo: m.periodo,
      rotulo: it.rotulo, ini: it.ini, fim: it.fim, meta, realizado,
      percentual: meta > 0 ? Math.round((realizado / meta) * 1000) / 10 : 0,
      falta: r2(Math.max(0, meta - realizado)), diasTotal, diasDecorridos, diasRestantes: encerrada ? 0 : Math.max(0, diasTotal - diasDecorridos),
      esperado, projecao: diasDecorridos > 0 && !futura ? r2(encerrada ? realizado : realizado / diasDecorridos * diasTotal) : 0, situacao
    };
  });
}

async function lerMetas(supabase, filtro) {
  // filtro: { tipo, ano, periodo, representante }
  const aplicar = q => {
    if (filtro.tipo) q = q.eq("tipo", filtro.tipo);
    if (filtro.ano) q = q.eq("ano", filtro.ano);
    if (filtro.periodo) q = q.eq("periodo", filtro.periodo);
    if (filtro.representante) q = q.ilike("representante", String(filtro.representante).replace(/[\\%_]/g, c => "\\" + c));
    return q;
  };
  const [g, c] = await Promise.all([
    paginar(() => aplicar(supabase.from("metas_representante").select("representante,tipo,ano,periodo,valor"))),
    paginar(() => aplicar(supabase.from("metas_cesta_representante").select("cesta,representante,tipo,ano,periodo,valor")))
  ]);
  return [
    ...g.map(x => ({ escopo: "geral", cesta: null, representante: x.representante, tipo: x.tipo, ano: Number(x.ano), periodo: Number(x.periodo), valor: Number(x.valor) })),
    ...c.map(x => ({ escopo: "cesta", cesta: x.cesta, representante: x.representante, tipo: x.tipo, ano: Number(x.ano), periodo: Number(x.periodo), valor: Number(x.valor) }))
  ];
}

const ordenar = lista => lista.sort((a, b) => (a.escopo === b.escopo ? 0 : a.escopo === "geral" ? -1 : 1) || String(a.representante).localeCompare(String(b.representante), "pt-BR") || String(a.cesta || "").localeCompare(String(b.cesta || ""), "pt-BR"));

async function tratarMetasRep(req, res, { usuario, ehGestor, supabase }) {
  try {
    const q = req.query || {};
    if (req.method === "GET") {
      const hoje = hojeBR();
      const acao = String(q.acao || "vigentes");
      // promotor só enxerga as próprias metas; gestor pode filtrar por representante
      const rep = ehGestor ? String(q.representante || "").trim() : usuario.nome;

      if (acao === "periodo") {
        const p = validarPeriodo(q.tipo, q.ano, q.periodo);
        const it = intervalo(p.tipo, p.ano, p.periodo);
        const metas = await lerMetas(supabase, { ...p, representante: rep });
        const progresso = ordenar(await calcularProgresso(supabase, metas, hoje));
        const representantes = ehGestor ? await representantesCadastrados(supabase) : [usuario.nome];
        res.status(200).json({ ...p, rotulo: it.rotulo, ini: it.ini, fim: it.fim, vigente: hoje >= it.ini && hoje <= it.fim, hoje, representantes, metas: progresso });
        return;
      }
      if (acao === "vigentes") {
        const alvo = ["mensal", "trimestral", "semestral", "anual"].map(t => periodoDaData(t, hoje));
        let todas = [];
        for (const p of alvo) todas = todas.concat(await lerMetas(supabase, { ...p, representante: rep }));
        const progresso = await calcularProgresso(supabase, todas, hoje);
        const ordemTipo = { mensal: 0, trimestral: 1, semestral: 2, anual: 3 };
        progresso.sort((a, b) => ordemTipo[a.tipo] - ordemTipo[b.tipo] || (a.escopo === b.escopo ? 0 : a.escopo === "geral" ? -1 : 1) || String(a.representante).localeCompare(String(b.representante), "pt-BR") || String(a.cesta || "").localeCompare(String(b.cesta || ""), "pt-BR"));
        res.status(200).json({ hoje, metas: progresso });
        return;
      }
      falha("Ação inválida.");
    }

    if (req.method === "POST") {
      if (!ehGestor) falha("Só Gerente/Desenvolvedor pode cadastrar metas.", 403);
      const b = req.body || {};
      const p = validarPeriodo(b.tipo, b.ano, b.periodo);
      const escopo = b.escopo === "cesta" ? "cesta" : "geral";
      const itens = Array.isArray(b.itens) ? b.itens : [];
      if (!itens.length) falha("Nenhuma meta para salvar.");
      if (itens.length > 200) falha("Itens demais em uma só chamada.");
      const validos = new Set(await representantesCadastrados(supabase).then(l => l.map(x => x.toLowerCase())));
      let cestasOk = null;
      if (escopo === "cesta") {
        const { data } = await supabase.from("cestas").select("nome");
        cestasOk = new Map((data || []).map(c => [String(c.nome || "").trim().toLowerCase(), String(c.nome).trim()]));
      }
      const tabela = escopo === "cesta" ? "metas_cesta_representante" : "metas_representante";
      let salvas = 0, removidas = 0;
      for (const it of itens) {
        const representante = String(it.representante || "").trim();
        if (!representante) falha("Informe o representante.");
        if (validos.size && !validos.has(representante.toLowerCase())) falha("Representante desconhecido: " + representante + ".");
        let cesta = null;
        if (escopo === "cesta") {
          cesta = cestasOk.get(String(it.cesta || "").trim().toLowerCase());
          if (!cesta) falha("Cesta não encontrada: " + String(it.cesta || "") + ".");
        }
        const bruto = it.valor === "" || it.valor == null ? 0 : Number(it.valor);
        if (!Number.isFinite(bruto) || bruto < 0 || bruto > 1e10) falha("Valor de meta inválido para " + representante + ".");
        const valor = r2(bruto);
        const chave = escopo === "cesta" ? { cesta, representante, ...p } : { representante, ...p };
        if (valor === 0) {
          let del = supabase.from(tabela).delete();
          Object.keys(chave).forEach(k => { del = del.eq(k, chave[k]); });
          const { error } = await del; if (error) throw error;
          removidas++;
        } else {
          const { error } = await supabase.from(tabela).upsert(
            { ...chave, valor, atualizado_por: usuario.nome, atualizado_em: new Date().toISOString() },
            { onConflict: Object.keys(chave).join(",") });
          if (error) throw error;
          salvas++;
        }
        // histórico (melhor esforço: não desfaz a meta já salva)
        try { await supabase.from("metas_representante_log").insert({ escopo, cesta, representante, ...p, valor, atualizado_por: usuario.nome }); } catch (e) { /* ignora */ }
      }
      res.status(200).json({ status: "ok", salvas, removidas });
      return;
    }

    res.status(405).json({ erro: "Use GET ou POST." });
  } catch (err) {
    if (err.http) { res.status(err.http).json({ erro: err.message }); return; }
    res.status(502).json({ erro: "Falha ao processar as metas.", detalhe: err.detalhe || String(err.message || err) });
  }
}

module.exports = { tratarMetasRep, intervalo, periodoDaData, validarPeriodo, calcularProgresso, hojeBR };
