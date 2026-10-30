// Visão gerencial (gestor.html): indicadores do período, comparação com o período anterior
// de mesmo tamanho, séries, rankings e detalhamento. Fica em _lib (não conta como função
// Vercel) e é chamado por api/relatorios.js quando a requisição traz ?recurso=gestor.
//
// GET /api/relatorios?recurso=gestor&de=AAAA-MM-DD&ate=AAAA-MM-DD[&promotor=X][&revenda=Y][&fazenda=Z]
// Só Gerente/Desenvolvedor (a checagem é feita em relatorios.js antes de delegar).

const { obterSupabase, buscarTodasLinhas } = require("./supabase");

const DIA = 86400000;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function paraMs(iso) { return Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)); }
function paraIso(ms) { return new Date(ms).toISOString().slice(0, 10); }
function var_(atual, ant) { return ant > 0 ? Math.round(((atual - ant) / ant) * 1000) / 10 : null; }
function igual(a, b) { return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase(); }

async function tratarGestor(req, res, opcoes) {
  // opcoes.vendedor = nome do promotor logado quando NÃO é gestor: a visão fica travada nos dados dele.
  const vendedor = opcoes && opcoes.vendedor ? String(opcoes.vendedor).trim() : "";
  const q = req.query || {};
  const hoje = new Date().toISOString().slice(0, 10);
  let de = ISO.test(q.de || "") ? q.de : hoje.slice(0, 8) + "01";
  let ate = ISO.test(q.ate || "") ? q.ate : hoje;
  if (de > ate) [de, ate] = [ate, de];
  const dias = Math.round((paraMs(ate) - paraMs(de)) / DIA) + 1;
  if (dias > 800) { res.status(400).json({ erro: "Período muito longo (máx. ~2 anos)." }); return; }
  const deAnt = paraIso(paraMs(de) - dias * DIA);
  const ateAnt = paraIso(paraMs(de) - DIA);
  const fPromotor = vendedor || String(q.promotor || "").trim();
  const fRevenda = String(q.revenda || "").trim();
  const fFazenda = String(q.fazenda || "").trim();

  const supabase = obterSupabase();
  const [linL, linV, usuarios] = await Promise.all([
    // "revenda_origem" (Projeto AGD's) só existe depois de rodar sql_revenda_origem_agd.sql;
    // se a coluna ainda não existir, cai para a consulta antiga em vez de quebrar o painel.
    buscarTodasLinhas(supabase, "lancamentos", "id,nome_promotor,revenda,revenda_origem,propriedade,produto,unidade,volume,valor_total,dia_lancamento,id_envio", null)
      .catch(() => buscarTodasLinhas(supabase, "lancamentos", "id,nome_promotor,revenda,propriedade,produto,unidade,volume,valor_total,dia_lancamento,id_envio", null)),
    buscarTodasLinhas(supabase, "visitas", "nome_promotor,propriedade,tipo_visita,dia_visita", null),
    supabase.from("usuarios").select("nome, cargo").ilike("cargo", "promotor").then(r => r.data || []).catch(() => [])
  ]);

  const todosPed = linL.map(l => ({
    promotor: String(l.nome_promotor || "").trim(), revenda: String(l.revenda || "").trim(), origem: String(l.revenda_origem || "").trim(),
    fazenda: String(l.propriedade || "").trim(), produto: String(l.produto || "").trim(),
    unidade: String(l.unidade || "").trim(), volume: Number(l.volume) || 0,
    // chave do pedido: um pedido tem vários itens (linhas) com o mesmo id_envio; registros
    // antigos sem id_envio contam cada linha como um pedido.
    pk: l.id_envio ? String(l.id_envio) : "linha-" + l.id,
    valor: Number(l.valor_total) || 0, data: String(l.dia_lancamento || "").slice(0, 10)
  })).filter(p => p.promotor && ISO.test(p.data));
  const todasVis = linV.map(v => ({
    promotor: String(v.nome_promotor || "").trim(), fazenda: String(v.propriedade || "").trim(),
    tipo: String(v.tipo_visita || "").trim() || "Não informado", data: String(v.dia_visita || "").slice(0, 10)
  })).filter(v => v.promotor && ISO.test(v.data));

  const promotoresCadastrados = vendedor ? [vendedor] : usuarios.map(u => String(u.nome || "").trim()).filter(Boolean).sort((a, b) => a.localeCompare(b, "pt-BR"));
  // vendedor só vê as revendas das próprias vendas (não vaza carteira dos outros)
  const revendasTodas = [...new Set(todosPed.filter(p => !vendedor || igual(p.promotor, vendedor)).map(p => p.revenda).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));

  // Filtros de detalhamento (promotor / revenda / fazenda). Visita não tem revenda: com
  // filtro de revenda, as visitas ficam de fora (só pedidos têm essa informação).
  const passaP = x => !fPromotor || igual(x.promotor, fPromotor);
  const passaF = x => !fFazenda || igual(x.fazenda, fFazenda);
  const ped = todosPed.filter(p => passaP(p) && passaF(p) && (!fRevenda || igual(p.revenda, fRevenda)));
  const vis = fRevenda ? [] : todasVis.filter(v => passaP(v) && passaF(v));

  const emP = (x, a, b) => x.data >= a && x.data <= b;
  const pedA = ped.filter(p => emP(p, de, ate)), pedB = ped.filter(p => emP(p, deAnt, ateAnt));
  const visA = vis.filter(v => emP(v, de, ate)), visB = vis.filter(v => emP(v, deAnt, ateAnt));

  const soma = arr => arr.reduce((s, p) => s + p.valor, 0);
  // Visita em revenda é gravada como "Revenda: NOME" no campo propriedade — não conta como fazenda.
  const nFaz = (p, v) => new Set([...p.map(x => x.fazenda), ...v.map(x => x.fazenda)].filter(f => f && !/^Revenda: /i.test(f))).size;
  const nProm = (p, v) => new Set([...p.map(x => x.promotor), ...v.map(x => x.promotor)]).size;
  const nPed = arr => new Set(arr.map(x => x.pk)).size;
  const kpi = (p, v) => ({
    valor: soma(p), pedidos: nPed(p), itens: p.length, visitas: v.length, fazendas: nFaz(p, v), promotoresAtivos: nProm(p, v),
    ticket: nPed(p) ? soma(p) / nPed(p) : 0
  });
  const kA = kpi(pedA, visA), kB = kpi(pedB, visB);
  const variacao = {};
  Object.keys(kA).forEach(k => { variacao[k] = var_(kA[k], kB[k]); });

  // Série: dia a dia (até 14 dias) ou semana a semana; o período anterior entra alinhado
  // pelo índice do bloco para dar para sobrepor as duas linhas.
  const passo = dias <= 14 ? 1 : 7;
  const nBlocos = Math.ceil(dias / passo);
  const serie = [];
  for (let i = 0; i < nBlocos; i++) {
    const ini = paraMs(de) + i * passo * DIA;
    const fim = Math.min(ini + (passo - 1) * DIA, paraMs(ate));
    const iniB = paraMs(deAnt) + i * passo * DIA;
    const fimB = Math.min(iniB + (passo - 1) * DIA, paraMs(ateAnt));
    const a = paraIso(ini), b = paraIso(fim), ab = paraIso(iniB), bb = paraIso(fimB);
    serie.push({
      inicio: a, fim: b,
      valor: soma(pedA.filter(p => emP(p, a, b))), valorAnt: soma(pedB.filter(p => emP(p, ab, bb))),
      visitas: visA.filter(v => emP(v, a, b)).length, visitasAnt: visB.filter(v => emP(v, ab, bb)).length
    });
  }

  // Ranking de promotores (com cadastrados sem atividade só quando não há filtro de recorte).
  const nomesP = new Set([...pedA, ...pedB, ...visA, ...visB].map(x => x.promotor));
  if (!fRevenda && !fFazenda) promotoresCadastrados.forEach(n => nomesP.add(n));
  const porPromotor = [...nomesP].filter(n => !fPromotor || igual(n, fPromotor)).map(n => {
    const pa = pedA.filter(x => igual(x.promotor, n)), pb = pedB.filter(x => igual(x.promotor, n));
    const va = visA.filter(x => igual(x.promotor, n)), vb = visB.filter(x => igual(x.promotor, n));
    return {
      promotor: n, valor: soma(pa), valorAnt: soma(pb), variacao: var_(soma(pa), soma(pb)),
      pedidos: nPed(pa), itens: pa.length, visitas: va.length, visitasAnt: vb.length, fazendas: nFaz(pa, va),
      spark: serie.map(b => soma(pa.filter(x => emP(x, b.inicio, b.fim)))),
      semAtividade: !pa.length && !va.length
    };
  }).sort((a, b) => b.valor - a.valor || b.visitas - a.visitas);

  // Revendas. (As metas agora são por REPRESENTANTE — ver _lib/metas_rep.js; a tabela de
  // revenda não tem mais meta própria.)
  const mapaRev = new Map();
  pedA.forEach(p => { if (p.revenda) { const r = mapaRev.get(p.revenda) || { revenda: p.revenda, valor: 0, valorAnt: 0, pedidos: 0 }; r.valor += p.valor; mapaRev.set(p.revenda, r); } });
  pedB.forEach(p => { if (p.revenda) { const r = mapaRev.get(p.revenda) || { revenda: p.revenda, valor: 0, valorAnt: 0, pedidos: 0 }; r.valorAnt += p.valor; mapaRev.set(p.revenda, r); } });
  mapaRev.forEach((r, nome) => { r.pedidos = nPed(pedA.filter(x => x.revenda === nome)); });
  const totalRev = [...mapaRev.values()].reduce((s, r) => s + r.valor, 0);
  const porRevenda = [...mapaRev.values()].map(r => {
    return {
      ...r, variacao: var_(r.valor, r.valorAnt), participacao: totalRev ? Math.round((r.valor / totalRev) * 1000) / 10 : 0,
      metaPeriodo: null, atingimento: null
    };
  }).filter(r => r.valor || r.valorAnt).sort((a, b) => b.valor - a.valor);

  // Fazendas
  const mapaFaz = new Map();
  const faz = n => { if (!mapaFaz.has(n)) mapaFaz.set(n, { fazenda: n, valor: 0, pedidos: 0, visitas: 0 }); return mapaFaz.get(n); };
  pedA.forEach(p => { if (p.fazenda) { const f = faz(p.fazenda); f.valor += p.valor; f.pedidos++; } }); // pedidos = itens aqui (uso interno)
  visA.forEach(v => { if (v.fazenda) faz(v.fazenda).visitas++; });
  const porFazenda = [...mapaFaz.values()].sort((a, b) => b.valor - a.valor || b.visitas - a.visitas).slice(0, 15);

  // Tipos de visita
  const mapaTipo = new Map();
  visA.forEach(v => { const t = mapaTipo.get(v.tipo) || { tipo: v.tipo, total: 0, totalAnt: 0 }; t.total++; mapaTipo.set(v.tipo, t); });
  visB.forEach(v => { const t = mapaTipo.get(v.tipo) || { tipo: v.tipo, total: 0, totalAnt: 0 }; t.totalAnt++; mapaTipo.set(v.tipo, t); });
  const porTipoVisita = [...mapaTipo.values()].sort((a, b) => b.total - a.total);

  // Produtos
  const mapaProd = new Map();
  pedA.forEach(p => { if (p.produto) { const r = mapaProd.get(p.produto) || { produto: p.produto, valor: 0, pedidos: 0 }; r.valor += p.valor; r.pedidos++; mapaProd.set(p.produto, r); } });
  const porProduto = [...mapaProd.values()].sort((a, b) => b.valor - a.valor).slice(0, 10);

  // Últimos registros do recorte atual
  const registros = [
    ...pedA.map(p => ({ tipo: "Pedido", data: p.data, promotor: p.promotor, fazenda: p.fazenda, revenda: p.revenda, origem: p.origem, detalhe: p.produto, valor: p.valor })),
    ...visA.map(v => ({ tipo: "Visita", data: v.data, promotor: v.promotor, fazenda: v.fazenda, revenda: "", detalhe: v.tipo, valor: null }))
  ].sort((a, b) => b.data.localeCompare(a.data)).slice(0, 40);

  // CUBO de vendas (quem vendeu × para onde × o quê): agregado no menor nível
  // (promotor, revenda, fazenda, produto, unidade) para o navegador fazer o drill-down sem
  // novas chamadas. v = valor, q = quantidade (soma do volume), i = itens, n = pedidos distintos.
  const SEP = "\u0001";
  const cuboMap = new Map(), pedMap = new Map(), antMap = new Map();
  pedA.forEach(x => {
    const k = [x.promotor, x.revenda, x.fazenda, x.produto, x.unidade].join(SEP);
    const c = cuboMap.get(k) || { p: x.promotor, r: x.revenda, f: x.fazenda, pr: x.produto, un: x.unidade, v: 0, q: 0, i: 0, peds: new Set() };
    c.v += x.valor; c.q += x.volume; c.i++; c.peds.add(x.pk); cuboMap.set(k, c);
    const k2 = [x.promotor, x.revenda, x.fazenda].join(SEP);
    const c2 = pedMap.get(k2) || { p: x.promotor, r: x.revenda, f: x.fazenda, peds: new Set() };
    c2.peds.add(x.pk); pedMap.set(k2, c2);
  });
  pedB.forEach(x => {
    const k = [x.promotor, x.revenda, x.fazenda, x.produto].join(SEP);
    const c = antMap.get(k) || { p: x.promotor, r: x.revenda, f: x.fazenda, pr: x.produto, v: 0 };
    c.v += x.valor; antMap.set(k, c);
  });
  const r2 = n => Math.round(n * 100) / 100;
  const cubo = [...cuboMap.values()].map(c => ({ p: c.p, r: c.r, f: c.f, pr: c.pr, un: c.un, v: r2(c.v), q: r2(c.q), i: c.i, n: c.peds.size }));
  const cuboPed = [...pedMap.values()].map(c => ({ p: c.p, r: c.r, f: c.f, n: c.peds.size }));
  const cuboAnt = [...antMap.values()].map(c => ({ p: c.p, r: c.r, f: c.f, pr: c.pr, v: r2(c.v) }));

  res.status(200).json({
    modoVendedor: !!vendedor,
    cubo, cuboPed, cuboAnt,
    periodo: { de, ate, dias, deAnt, ateAnt },
    filtros: { promotor: fPromotor || null, revenda: fRevenda || null, fazenda: fFazenda || null },
    opcoes: { promotores: promotoresCadastrados, revendas: revendasTodas },
    kpi: kA, kpiAnterior: kB, variacao, serie, passo,
    porPromotor, porRevenda, porFazenda, porTipoVisita, porProduto, registros,
    semAtividade: porPromotor.filter(p => p.semAtividade).map(p => p.promotor)
  });
}

module.exports = { tratarGestor };
