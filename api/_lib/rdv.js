// Despesas dos promotores: RDV semanal e CI (Comunicação Interna).
// Fluxo: promotor preenche -> cai na fila do gestor -> gestor completa (classificação,
// descrição, emissão, vencimento, valor) e dá OK -> o sistema gera a planilha Excel e
// preenche o formulário do Kanban (POST multipart) com a planilha + fotos anexadas.
//
// Fica em _lib (não conta como função Vercel). É chamado por api/agenda.js quando a
// requisição traz ?recurso=rdv.
//
// GET  /api/agenda?recurso=rdv                  -> minhas solicitações (gestor: ?fila=1 -> todas)
// GET  /api/agenda?recurso=rdv&id=N             -> detalhe de uma solicitação
// POST /api/agenda?recurso=rdv  {acao:"salvar", id?, tipo:"RDV"|"CI", dados:{...}}
// POST ... {acao:"excluir", id}                 -> promotor (dono) enquanto pendente/recusada
// POST ... {acao:"aprovar", id, classificacao, descricao, emissao, vencimento, valor, numero?}  (gestor)
// POST ... {acao:"recusar", id, motivo}         (gestor)
// POST ... {acao:"reenviar", id, ...mesmos campos de aprovar (opcionais)}  (gestor; após erro no Kanban)
//
// Variáveis de ambiente opcionais: KANBAN_URL, KANBAN_ESTABELECIMENTO, KANBAN_SOLICITANTE,
// KANBAN_EMAIL, RDV_VALOR_KM, KANBAN_ENVIO_ATIVO ("0" desliga o envio real — modo teste).
// Tabela: solicitacoes_despesa (ver sql_solicitacoes_despesa.sql).

const crypto = require("crypto");
const { Planilha } = require("./xlsx_min");

const BUCKET = "fotos";
const KANBAN_URL = () => process.env.KANBAN_URL || "http://177.220.156.108:5050/external_expense";
const KANBAN_ESTABELECIMENTO = () => process.env.KANBAN_ESTABELECIMENTO || "1 - HARA AGRONEGOCIOS";
const KANBAN_SOLICITANTE = () => process.env.KANBAN_SOLICITANTE || "Fabio Ferri";
const KANBAN_EMAIL = () => process.env.KANBAN_EMAIL || "ferrif937@gmail.com";
const TIPO_PAGAMENTO = "Compensação Financeira (Acerto)";
const VALOR_KM = () => { const n = Number(process.env.RDV_VALOR_KM); return n > 0 ? n : 1.33; };
const COORDENADOR = "FÁBIO FERRI";
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const DIAS_SEMANA = ["SEGUNDA-FEIRA", "TERÇA-FEIRA", "QUARTA-FEIRA", "QUINTA-FEIRA", "SEXTA-FEIRA", "SÁBADO"];

/* ---------- utilidades ---------- */
class ErroValidacao extends Error {}
const falha = (m) => { throw new ErroValidacao(m); };
const txt = (v, max) => String(v === undefined || v === null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max || 300);
const txtLongo = (v, max) => String(v === undefined || v === null ? "" : v).replace(/\r/g, "").trim().slice(0, max || 2000);
const cent = (n) => Math.round(Number(n) * 100) / 100;
function numero(v, nome, { min = 0, max = 1e7, obrigatorio = false } = {}) {
  if (v === undefined || v === null || v === "") { if (obrigatorio) falha(`Informe ${nome}.`); return 0; }
  const n = Number(typeof v === "string" ? (v.includes(",") ? v.replace(/\./g, "").replace(",", ".") : v) : v);
  if (!isFinite(n)) falha(`${nome} inválido.`);
  if (n < min) falha(`${nome} não pode ser menor que ${min}.`);
  if (n > max) falha(`${nome} acima do permitido.`);
  return n;
}
function dataIso(v, nome, obrigatorio) {
  const s = String(v || "").slice(0, 10);
  if (!s) { if (obrigatorio) falha(`Informe ${nome}.`); return ""; }
  if (!ISO.test(s) || isNaN(Date.parse(s + "T00:00:00Z"))) falha(`${nome} inválida.`);
  return s;
}
const ms = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const paraIso = (m) => new Date(m).toISOString().slice(0, 10);
const br = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "");
const brl = (n) => "R$ " + cent(n).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Só aceita URLs do nosso próprio armazenamento (evita que alguém mande o servidor buscar
// um endereço qualquer).
function urlsDoStorage(lista, max) {
  const base = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "") + `/storage/v1/object/public/${BUCKET}/`;
  const arr = Array.isArray(lista) ? lista : [];
  const ok = arr.filter(u => typeof u === "string" && u.startsWith(base) && u.length < 400);
  return ok.slice(0, max || 10);
}
function umaUrl(v) { return urlsDoStorage([v], 1)[0] || ""; }

/* ---------- validação e cálculo ---------- */
function normalizarRdv(d, rascunho) {
  d = d || {};
  const semana = dataIso(d.semana, "a semana", true);
  if (new Date(semana + "T00:00:00Z").getUTCDay() !== 1) falha("A semana deve começar na segunda-feira.");
  const kmInicial = numero(d.kmInicial, "o KM inicial", { obrigatorio: true, max: 9999999 });
  const hodIni = umaUrl(d.fotoHodometroIni);
  const hodFim = umaUrl(d.fotoHodometroFim);
  if (!rascunho && !hodIni) falha("Envie a foto do hodômetro inicial.");
  if (!rascunho && !hodFim) falha("Envie a foto do hodômetro final.");

  const entrada = Array.isArray(d.dias) ? d.dias : [];
  let kmAnterior = kmInicial;
  const dias = [];
  let temMovimento = false;
  for (let i = 0; i < 6; i++) {
    const dia = entrada.find(x => x && x.data === paraIso(ms(semana) + i * 86400000)) || entrada[i] || {};
    const data = paraIso(ms(semana) + i * 86400000);
    const kmFimBruto = dia.kmFim === "" || dia.kmFim === undefined || dia.kmFim === null ? null : numero(dia.kmFim, `o KM final de ${DIAS_SEMANA[i].toLowerCase()}`, { max: 9999999 });
    // O KM inicial do dia normalmente é o KM final do dia anterior; o gestor pode corrigi-lo
    // dia a dia (kmIniManual), e a cadeia dos dias seguintes continua a partir do que ele ajustou.
    const manual = dia.kmIniManual === "" || dia.kmIniManual === undefined || dia.kmIniManual === null ? null : numero(dia.kmIniManual, `o KM inicial de ${DIAS_SEMANA[i].toLowerCase()}`, { max: 9999999 });
    const kmIni = manual !== null ? manual : kmAnterior;
    if (!rascunho && kmFimBruto !== null && kmFimBruto < kmIni) falha(`KM final de ${DIAS_SEMANA[i].toLowerCase()} (${kmFimBruto}) é menor que o inicial (${kmIni}).`);
    const kmFim = kmFimBruto === null ? kmIni : kmFimBruto;
    const rod = Math.max(0, kmFim - kmIni);
    const reg = {
      data, kmIni, kmFim, kmRodado: rod, kmFimInformado: kmFimBruto,
      hotel: cent(numero(dia.hotel, "hotel", { max: 100000 })),
      almoco: cent(numero(dia.almoco, "almoço", { max: 100000 })),
      jantar: cent(numero(dia.jantar, "jantar", { max: 100000 })),
      aviso: cent(numero(dia.aviso, "despesa com aviso prévio", { max: 100000 })),
      descricao: txt(dia.descricao, 400),
      kmDescricao: txt(dia.kmDescricao, 300),
      hotelDescricao: txt(dia.hotelDescricao, 200),
      ...(manual !== null ? { kmIniManual: manual } : {}),
      almocoPessoas: [1, 2, 3].includes(Number(dia.almocoPessoas)) ? Number(dia.almocoPessoas) : 1,
      fotos: urlsDoStorage(dia.fotos, 8)
    };
    // Almoço acompanhado: quem estava (nome, função, loja/propriedade). Só guarda os n-1 acompanhantes.
    const CARGOS_PART = ["Proprietário", "Veterinário", "Balconista", "Outro"];
    reg.participantes = (Array.isArray(dia.participantes) ? dia.participantes : []).slice(0, reg.almocoPessoas - 1)
      .map(p => ({ nome: txt(p && p.nome, 120), cargo: CARGOS_PART.includes(p && p.cargo) ? p.cargo : "", local: txt(p && p.local, 160) }));
    // Jantar acompanhado: mesma regra do almoço (quem estava), segmentado no Excel.
    reg.jantarPessoas = [1, 2, 3].includes(Number(dia.jantarPessoas)) ? Number(dia.jantarPessoas) : 1;
    reg.jantarParticipantes = (Array.isArray(dia.jantarParticipantes) ? dia.jantarParticipantes : []).slice(0, reg.jantarPessoas - 1)
      .map(p => ({ nome: txt(p && p.nome, 120), cargo: CARGOS_PART.includes(p && p.cargo) ? p.cargo : "", local: txt(p && p.local, 160) }));
    if (!rascunho && reg.jantar > 0 && reg.jantarPessoas > 1) {
      for (let k = 0; k < reg.jantarPessoas - 1; k++) {
        const pp = reg.jantarParticipantes[k] || {};
        if (!pp.nome || !pp.cargo || !pp.local) falha(`Jantar de ${DIAS_SEMANA[i].toLowerCase()} (${br(data)}): informe nome, função e loja/propriedade de quem jantou com você (pessoa ${k + 1}).`);
      }
    }
    if (!rascunho && reg.almoco > 0 && reg.almocoPessoas > 1) {
      for (let k = 0; k < reg.almocoPessoas - 1; k++) {
        const pp = reg.participantes[k] || {};
        if (!pp.nome || !pp.cargo || !pp.local) falha(`Almoço de ${DIAS_SEMANA[i].toLowerCase()} (${br(data)}): informe nome, função e loja/propriedade de quem almoçou com você (pessoa ${k + 1}).`);
      }
    }
    const gastou = reg.hotel + reg.almoco + reg.jantar + reg.aviso;
    if (!rascunho && rod > 0 && !reg.kmDescricao) falha(`Informe para onde foi o deslocamento de ${DIAS_SEMANA[i].toLowerCase()} (${br(data)}): cidades, fazendas ou revendas.`);
    if (!rascunho && reg.hotel > 0 && !reg.hotelDescricao) falha(`Informe o nome e a cidade do hotel de ${DIAS_SEMANA[i].toLowerCase()} (${br(data)}).`);
    if (!rascunho && (reg.almoco + reg.jantar + reg.aviso) > 0 && !reg.descricao) falha(`Informe a descrição (justificativa) da despesa de ${DIAS_SEMANA[i].toLowerCase()} (${br(data)}).`);
    if (!rascunho && gastou > 0 && reg.fotos.length === 0) falha(`Anexe a foto da nota de ${DIAS_SEMANA[i].toLowerCase()} (${br(data)}).`);
    if (rod > 0 || gastou > 0) temMovimento = true;
    kmAnterior = kmFim;
    dias.push(reg);
  }
  if (!rascunho && !temMovimento) falha("Preencha pelo menos um dia da semana.");
  // KM do hodômetro final (o que o promotor lê no painel): precisa bater com o último KM dos dias.
  const kmHodFinal = numero(d.kmFinalHodometro, "o KM do hodômetro final", { obrigatorio: !rascunho, max: 9999999 });
  if (!rascunho && kmHodFinal !== kmAnterior) {
    falha(`O KM do hodômetro final (${kmHodFinal}) não bate com o último KM informado nos dias (${kmAnterior}). Confira os KM finais de cada dia.`);
  }
  return {
    semana, kmInicial, kmFinal: kmAnterior, kmFinalHodometro: kmHodFinal || null, fotoHodometroIni: hodIni, fotoHodometroFim: hodFim,
    veiculo: txt(d.veiculo, 60), placa: txt(d.placa, 12).toUpperCase(),
    observacao: txtLongo(d.observacao, 800), dias,
    diasSemAgenda: (Array.isArray(d.diasSemAgenda) ? d.diasSemAgenda : []).slice(0, 7)
      .map(x => ({ data: String((x && x.data) || "").slice(0, 10), motivo: txt(x && x.motivo, 200) }))
      .filter(x => ISO.test(x.data))
  };
}

/* ---------- trava: agenda da próxima semana ---------- */
// Para ENVIAR o RDV ao gestor, o promotor precisa ter a agenda da semana seguinte (seg–sex)
// preenchida: ao menos 1 compromisso por dia útil, ou o dia marcado como "sem agenda" com
// motivo. Rascunho não é afetado. Dias da semana seguinte que já passaram não são exigidos
// (RDV enviado com atraso). Gestor/desenvolvedor não têm a trava.
const hojeBrasil = () => new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
async function situacaoAgendaProxima(supabase, nomePromotor, semana, diasSemAgenda) {
  const proxima = paraIso(ms(semana) + 7 * 86400000);
  const hoje = hojeBrasil();
  const datas = [0, 1, 2, 3, 4].map(i => paraIso(ms(proxima) + i * 86400000));
  const { data, error } = await supabase.from("agenda_compromissos").select("data").ilike("nome_promotor", nomePromotor).gte("data", datas[0]).lte("data", datas[4]);
  if (error) throw error;
  const contagem = {};
  for (const l of data || []) contagem[l.data] = (contagem[l.data] || 0) + 1;
  const livres = {};
  for (const x of diasSemAgenda || []) if (x.motivo && x.motivo.length >= 5) livres[x.data] = x.motivo;
  const dias = datas.map((d, i) => ({
    data: d, dia: DIAS_SEMANA[i], compromissos: contagem[d] || 0,
    exigido: d >= hoje, semAgenda: !!livres[d], motivo: livres[d] || ""
  }));
  const faltam = dias.filter(x => x.exigido && x.compromissos === 0 && !x.semAgenda).map(x => x.data);
  return { proxima, dias, faltam };
}

function totaisRdv(d) {
  const vkm = VALOR_KM();
  const km = d.dias.reduce((s, x) => s + x.kmRodado, 0);
  const valorKm = cent(km * vkm);
  const hotel = cent(d.dias.reduce((s, x) => s + x.hotel, 0));
  const almoco = cent(d.dias.reduce((s, x) => s + x.almoco, 0));
  const jantar = cent(d.dias.reduce((s, x) => s + x.jantar, 0));
  const aviso = cent(d.dias.reduce((s, x) => s + x.aviso, 0));
  // Refeições segmentadas: individual x "em conjunto" (almoço/jantar com mais de uma pessoa,
  // que é a Despesa Pré Aprovada).
  const conjA = cent(d.dias.reduce((s, x) => s + ((x.almocoPessoas || 1) > 1 ? x.almoco : 0), 0));
  const conjJ = cent(d.dias.reduce((s, x) => s + ((x.jantarPessoas || 1) > 1 ? x.jantar : 0), 0));
  const almocoInd = cent(almoco - conjA), jantarInd = cent(jantar - conjJ);
  const total = cent(valorKm + hotel + almoco + jantar + aviso);
  const porDia = d.dias.map(x => cent(x.kmRodado * vkm + x.hotel + x.almoco + x.jantar + x.aviso));
  return { km, valorKm, hotel, almoco, jantar, aviso, almocoInd, almocoConj: conjA, jantarInd, jantarConj: conjJ,
    refeicoesInd: cent(almocoInd + jantarInd), refeicoesConj: cent(conjA + conjJ), porDia, total, vkm };
}

function normalizarCi(d, rascunho) {
  d = d || {};
  const cartao = d.cartaoPresente === true || d.cartaoPresente === "SIM";
  const valor = cent(numero(d.valor, "o valor", { min: rascunho ? 0 : 0.01, obrigatorio: !rascunho, max: 1e7 }));
  const reg = {
    acao: txtLongo(d.acao, 600),
    execucao: dataIso(d.execucao, "a data de execução", false),
    brinde: txt(d.brinde, 120),
    cliente: txt(d.cliente, 160),
    periodoIni: dataIso(d.periodoIni, "o início do período", false),
    periodoFim: dataIso(d.periodoFim, "o fim do período", false),
    tipoAcordo: txtLongo(d.tipoAcordo, 1500),
    cartaoPresente: cartao,
    titular: txt(d.titular, 120),
    cpfCnpj: txt(d.cpfCnpj, 30),
    valor,
    observacao: txtLongo(d.observacao, 600),
    entrega: {
      endereco: txt(d.entrega && d.entrega.endereco, 160), numero: txt(d.entrega && d.entrega.numero, 60),
      bairro: txt(d.entrega && d.entrega.bairro, 80), cidade: txt(d.entrega && d.entrega.cidade, 80),
      recebedor: txt(d.entrega && d.entrega.recebedor, 120), telefone: txt(d.entrega && d.entrega.telefone, 30)
    },
    centroCusto: txt(d.centroCusto, 80),
    fotos: urlsDoStorage(d.fotos, 8)
  };
  if (!rascunho) {
    if (!reg.acao) falha("Descreva a ação.");
    if (!reg.cliente) falha("Informe o cliente.");
    if (!reg.fotos.length) falha("Anexe ao menos uma foto ou comprovante da CI.");
    if (!reg.centroCusto) falha("Informe o centro de custo (ex.: Pecuária, PET).");
    if (cartao && !reg.titular) falha("Informe o nome do titular do cartão presente.");
  }
  return reg;
}

/* ---------- demanda da semana (cruzamento custo x venda) ---------- */
// "Demanda" = valor dos pedidos que o promotor lançou no app na semana (segunda a domingo).
// O gestor pode corrigir o valor na aprovação (ex.: sell-out oficial); o valor final fica salvo.
async function demandaDaSemana(supabase, nomePromotor, semana) {
  if (!semana || !nomePromotor) return 0;
  const fim = paraIso(ms(semana) + 6 * 86400000);
  const padrao = String(nomePromotor).replace(/[\\%_]/g, m => "\\" + m);
  const { data, error } = await supabase.from("lancamentos").select("valor_total")
    .ilike("nome_promotor", padrao).gte("dia_lancamento", semana).lte("dia_lancamento", fim);
  if (error) throw error;
  return cent((data || []).reduce((t, l) => t + (Number(l.valor_total) || 0), 0));
}
// Acrescenta ao detalhe de um RDV: custo, demanda (a salva pelo gestor ou a calculada) e o percentual.
async function anexarDemanda(supabase, l, det) {
  if (l.tipo !== "RDV" || !det.totais) return det;
  let demanda = l.gestor && l.gestor.demanda != null ? Number(l.gestor.demanda) : null;
  let origem = "gestor";
  if (demanda === null) { origem = "pedidos do app"; try { demanda = await demandaDaSemana(supabase, l.promotor_nome, l.periodo_ini); } catch (e) { demanda = 0; } }
  det.demanda = { valor: demanda, origem, custo: det.totais.total, percentual: demanda > 0 ? Math.round((det.totais.total / demanda) * 10000) / 100 : null };
  return det;
}

/* ---------- título "RDV - CONSULTOR (NOME) | período" ---------- */
// Usado no Kanban (descrição), no título e no nome do Excel. O período vai da segunda-feira
// até o último dia da semana que teve movimento (km ou despesa); sem movimento, até o fim da semana.
const MESES_NOME = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
function periodoTextoRdv(sol) {
  const d = sol.dados || {};
  const ini = d.semana || sol.periodo_ini;
  let fim = sol.periodo_fim || paraIso(ms(ini) + 5 * 86400000);
  const movidos = (d.dias || []).filter(x => x.kmRodado > 0 || x.hotel > 0 || x.almoco > 0 || x.jantar > 0 || x.aviso > 0);
  if (movidos.length) fim = movidos[movidos.length - 1].data;
  const [ai, mi, di] = [ini.slice(0, 4), ini.slice(5, 7), ini.slice(8, 10)];
  const [af, mf, df] = [fim.slice(0, 4), fim.slice(5, 7), fim.slice(8, 10)];
  const mes = m => MESES_NOME[Number(m) - 1];
  if (ini === fim) return `${di} - ${mes(mi)} - ${ai}`;
  if (ai !== af) return `${di} - ${mes(mi)} - ${ai} a ${df} - ${mes(mf)} - ${af}`;
  if (mi !== mf) return `${di} - ${mes(mi)} a ${df} - ${mes(mf)} - ${af}`;
  return `${di} a ${df} - ${mes(mi)} - ${ai}`;
}
// Nome do consultor como deve aparecer no título/Excel do RDV. Chave = nome gravado no app (maiúsculas);
// se não estiver aqui, usa o nome como está.
const NOMES_CONSULTOR = {
  "AROLDO": "AROLDO MUNHOZ",
  "GABRIEL S": "GABRIEL SCHONHALZ",
  "GABRIEL": "GABRIEL HOSSADCZUK",
  "GIANCARLO": "GIANCARLO",
  "GUSTAVO": "GUSTAVO MULINETH",
  "JOAO TALES": "JOÃO TALES",
  "KAUANA": "KAUANA GARCIA MOLINARI",
  "LEONARDO": "LEONARDO",
  "LUCAS": "LUCAS DRUMMOND",
  "MARIANA": "MARIANA FAVARO",
  "PEDRO": "PEDRO HENRIQUE NUNES DA SILVA"
};
const semAcento = t => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toUpperCase();
function nomeConsultor(n) {
  const k = semAcento(n);
  return NOMES_CONSULTOR[k] || String(n || "").trim().toUpperCase();
}
function tituloRdv(sol) { return `RDV - CONSULTOR ${nomeConsultor(sol.promotor_nome)} | ${periodoTextoRdv(sol)}`; }
const nomeArquivoSeguro = (t, ext) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\|/g, "-").replace(/\//g, "-").replace(/[^A-Za-z0-9 _-]/g, "").replace(/\s+/g, "_") + "." + ext;

/* ---------- Excel ---------- */
const AZUL = "1F4D2E";
function planilhaRdv(sol, extra) {
  const d = sol.dados, t = totaisRdv(d);
  const p = new Planilha("RDV");
  p.paisagem = true;
  const larg = { A: 15, B: 11, C: 10, D: 10, E: 9, F: 12, G: 34, H: 12, I: 28, J: 12, K: 12, L: 24, M: 42, N: 14, O: 46, P: 14 };
  Object.keys(larg).forEach(c => p.largura(c, larg[c]));
  const cab = { b: true, borda: true, fill: "E8F0E8", h: "center", wrap: true };
  const caixa = { borda: true, wrap: true };
  const money = { borda: true, fmt: "moeda" };
  const ULT = "P";
  const COR = { km: "DCE9F7", hotel: "FCE5CD", ref: "FFF2CC", pre: "E4DAF2", out: "F8D7DA", tot: "E8F0E8" };
  const fc = (k, base) => ({ ...(base || {}), fill: COR[k] });

  p.cel("A1", tituloRdv(sol), { b: true, sz: 14, h: "center", fill: AZUL, cor: "FFFFFF" });
  p.mescla(`A1:${ULT}1`); p.estiloIntervalo(`A1:${ULT}1`, { fill: AZUL }); p.altura(1, 28);
  p.cel("A2", "RELATÓRIO DE DESPESAS DE VIAGEM - RDV SEMANAL", { b: true, sz: 9, h: "center", cor: "666666" }); p.mescla(`A2:${ULT}2`);

  p.cel("A3", "NOME CONSULTOR/RDV", cab); p.mescla("A3:C3");
  p.cel("D3", "NOME COORDENADOR", cab); p.mescla("D3:G3");
  p.cel("H3", "PERÍODO", cab); p.mescla("H3:I3");
  p.cel("J3", "VEÍCULO", cab); p.mescla("J3:M3");
  p.cel("N3", "PLACA", cab);
  p.cel("A4", nomeConsultor(sol.promotor_nome), caixa); p.mescla("A4:C4");
  p.cel("D4", COORDENADOR, caixa); p.mescla("D4:G4");
  p.cel("H4", `${br(d.semana)} A ${br(paraIso(ms(d.semana) + 5 * 86400000))}`, caixa); p.mescla("H4:I4");
  p.cel("J4", d.veiculo, caixa); p.mescla("J4:M4");
  p.cel("N4", d.placa, caixa);
  ["A3:C3", "D3:G3", "H3:I3", "J3:M3", "A4:C4", "D4:G4", "H4:I4", "J4:M4"].forEach(r => p.estiloIntervalo(r, { borda: true }));

  // linhas da tabela: cabeçalho 10-11, dias 12-17, subtotais 18
  const L0 = 12, LF = L0 + d.dias.length - 1, LS = LF + 1;

  p.cel("A6", "PRESTAÇÃO DE CONTAS", { b: true, fill: "E8F0E8", borda: true, h: "center" }); p.mescla("A6:C6");
  p.cel("D6", "DESPESA DESTE RDV:", cab); p.mescla("D6:F6");
  p.cel("G6", t.total, { b: true, fmt: "moeda", borda: true, h: "center" }, { f: `P${LS}` });
  p.estiloIntervalo("A6:G6", { borda: true });
  const dem = Number(extra.demanda) || 0;
  p.cel("D7", "DEMANDA DA SEMANA:", cab); p.mescla("D7:F7");
  p.cel("G7", dem > 0 ? dem : null, { b: true, fmt: "moeda", borda: true, h: "center" });
  p.cel("H7", "% RDV / DEMANDA:", cab); p.mescla("H7:I7");
  p.cel("J7", dem > 0 ? t.total / dem : "sem demanda informada", { b: true, fmt: "pct", borda: true, h: "left" }, dem > 0 ? { f: "G6/G7" } : undefined); p.mescla("J7:K7");
  p.estiloIntervalo("D7:K7", { borda: true });

  // custo por categoria (linhas 8-9)
  const cats = [
    ["A", "B", "RODAGEM (KM)", t.valorKm, "km"], ["C", "E", "HOTEL", t.hotel, "hotel"], ["F", "G", "REFEIÇÕES INDIVIDUAIS", t.refeicoesInd, "ref"],
    ["H", "I", "PRÉ APROVADAS (REFEIÇÃO EM CONJUNTO)", t.refeicoesConj, "pre"], ["J", "K", "AVISO PRÉVIO / OUTROS", t.aviso, "out"]
  ];
  cats.forEach(([c1, c2, nome, v, k]) => {
    p.cel(c1 + "8", nome, { ...cab, fill: COR[k] }); p.cel(c1 + "9", v, { b: true, fmt: "moeda", borda: true, h: "center", fill: COR[k] });
    if (c1 !== c2) { p.mescla(`${c1}8:${c2}8`); p.mescla(`${c1}9:${c2}9`); }
    p.estiloIntervalo(`${c1}8:${c2}8`, { borda: true, fill: COR[k] }); p.estiloIntervalo(`${c1}9:${c2}9`, { borda: true, fill: COR[k] });
  });
  p.altura(8, 30);

  // cabeçalho da tabela (linhas 10-11)
  p.cel("A10", "DIA DA SEMANA", cab); p.mescla("A10:A11");
  p.cel("B10", "DATA", cab); p.mescla("B10:B11");
  p.cel("C10", "QUILOMETRAGEM", fc("km", cab)); p.mescla("C10:G10");
  p.cel("H10", "HOTEL", fc("hotel", cab)); p.mescla("H10:I10");
  p.cel("J10", "REFEIÇÕES INDIVIDUAIS", fc("ref", cab)); p.mescla("J10:K10");
  p.cel("L10", "DESPESA PRÉ APROVADA (ALMOÇO OU JANTAR COM MAIS DE UMA PESSOA)", fc("pre", cab)); p.mescla("L10:M10");
  p.cel("N10", "OUTROS", fc("out", cab));
  p.cel("O10", "DESCRIÇÃO DA DESPESA", cab);
  p.cel("P10", "TOTAL DO DIA", cab); p.mescla("P10:P11");
  const sub = {
    C: "KM INICIAL", D: "KM FINAL", E: "KM RODADO", F: `VALOR KM (R$ ${t.vkm.toFixed(2).replace(".", ",")})`, G: "DESCRIÇÃO DO KM RODADO (CIDADES / FAZENDAS / REVENDAS)",
    H: "HOTEL (R$)", I: "DESCRIÇÃO DO HOTEL (NOME E CIDADE)", J: "ALMOÇO (R$)", K: "JANTAR (R$)",
    L: "DESPESA PRÉ APROVADA (ALMOÇO OU JANTAR COM MAIS DE UMA PESSOA) (R$)", M: "QUANTIDADE DE PESSOAS E QUEM PARTICIPOU",
    N: "AVISO PRÉVIO (R$)", O: "(AÇÃO, ATIVIDADE OU JUSTIFICATIVA QUE ORIGINOU A DESPESA)"
  };
  const grupo = { C: "km", D: "km", E: "km", F: "km", G: "km", H: "hotel", I: "hotel", J: "ref", K: "ref", L: "pre", M: "pre", N: "out" };
  p.estiloIntervalo(`A10:${ULT}11`, { borda: true, fill: COR.tot });
  ["C", "D", "E", "F", "G"].forEach(c => p.estiloIntervalo(`${c}10:${c}11`, { borda: true, fill: COR.km }));
  ["H", "I"].forEach(c => p.estiloIntervalo(`${c}10:${c}11`, { borda: true, fill: COR.hotel }));
  ["J", "K"].forEach(c => p.estiloIntervalo(`${c}10:${c}11`, { borda: true, fill: COR.ref }));
  ["L", "M"].forEach(c => p.estiloIntervalo(`${c}10:${c}11`, { borda: true, fill: COR.pre }));
  p.estiloIntervalo("N10:N11", { borda: true, fill: COR.out });
  Object.keys(sub).forEach(c => p.cel(c + "11", sub[c], { ...cab, fill: COR[grupo[c]] || COR.tot }));
  p.altura(10, 22); p.altura(11, 66);

  const quem = (rotulo, n, lista) => n > 1
    ? `${rotulo}: ${n} pessoas (você + ${n - 1}) — ` + (lista || []).map(q => `${q.nome} (${q.cargo}, ${q.local})`).join("; ") : "";
  d.dias.forEach((x, i) => {
    const l = L0 + i;
    const almConj = (x.almocoPessoas || 1) > 1, janConj = (x.jantarPessoas || 1) > 1;
    p.cel("A" + l, DIAS_SEMANA[i], { ...caixa, b: true });
    p.cel("B" + l, null, { borda: true, h: "center" }, { data: x.data });
    const K = { borda: true, fmt: "km", fill: COR.km };
    p.cel("C" + l, x.kmIni, K);
    p.cel("D" + l, x.kmFim, K);
    p.cel("E" + l, x.kmRodado, K, { f: `D${l}-C${l}` });
    p.cel("F" + l, cent(x.kmRodado * t.vkm), { ...money, fill: COR.km }, { f: `E${l}*${t.vkm}` });
    p.cel("G" + l, x.kmDescricao || "", { ...caixa, fill: COR.km });
    p.cel("H" + l, x.hotel, { ...money, fill: COR.hotel });
    p.cel("I" + l, x.hotelDescricao || "", { ...caixa, fill: COR.hotel });
    p.cel("J" + l, almConj ? 0 : x.almoco, { ...money, fill: COR.ref });
    p.cel("K" + l, janConj ? 0 : x.jantar, { ...money, fill: COR.ref });
    const conj = (almConj ? x.almoco : 0) + (janConj ? x.jantar : 0);
    p.cel("L" + l, cent(conj), { ...money, fill: COR.pre });
    const pessoas = [quem("Almoço", x.almocoPessoas || 1, x.participantes), quem("Jantar", x.jantarPessoas || 1, x.jantarParticipantes)].filter(Boolean).join("\n");
    p.cel("M" + l, pessoas, { ...caixa, fill: COR.pre });
    p.cel("N" + l, x.aviso, { ...money, fill: COR.out });
    p.cel("O" + l, x.descricao || "", caixa);
    p.cel("P" + l, t.porDia[i], { ...money, b: true, fill: COR.tot }, { f: `F${l}+H${l}+J${l}+K${l}+L${l}+N${l}` });
    const maior = Math.max((x.kmDescricao || "").length / 34, (x.hotelDescricao || "").length / 28, pessoas.length / 42, (x.descricao || "").length / 46);
    p.altura(l, Math.min(120, Math.max(30, Math.ceil(maior) * 15 + 6)));
  });
  p.estiloIntervalo(`A${LS}:${ULT}${LS}`, { borda: true, fill: COR.tot });
  p.cel("A" + LS, "SUBTOTAIS", { b: true, borda: true, fill: "E8F0E8" }); p.mescla(`A${LS}:B${LS}`);
  const sf = { b: true, borda: true, fill: "E8F0E8" };
  const soma = (c, v, fmt) => p.cel(c + LS, v, { ...sf, fmt }, { f: `SUM(${c}${L0}:${c}${LF})` });
  soma("E", t.km, "km"); soma("F", t.valorKm, "moeda"); soma("H", t.hotel, "moeda"); soma("J", t.almocoInd, "moeda"); soma("K", t.jantarInd, "moeda");
  soma("L", t.refeicoesConj, "moeda"); soma("N", t.aviso, "moeda"); soma("P", t.total, "moeda");

  const LI = LS + 2;
  p.cel("A" + LI, "INFORMAÇÕES DE RELEVÂNCIA SOBRE AS DESPESAS", cab); p.mescla(`A${LI}:${ULT}${LI}`);
  p.cel("A" + (LI + 1), d.observacao || "", { borda: true, wrap: true, v: "top" }); p.mescla(`A${LI + 1}:${ULT}${LI + 4}`); p.estiloIntervalo(`A${LI + 1}:${ULT}${LI + 4}`, { borda: true });
  p.cel("A" + (LI + 6), `Hodômetro inicial: ${d.kmInicial}  |  Hodômetro final: ${d.kmFinalHodometro || d.kmFinal}  |  Fotos do hodômetro e das notas seguem anexas no Kanban.`, { sz: 9, cor: "666666" }); p.mescla(`A${LI + 6}:${ULT}${LI + 6}`);
  p.cel("A" + (LI + 7), `Enviado pelo app Gestão de Campo em ${br(extra.hoje)}${extra.aprovador ? " | " + (extra.previa ? "Prévia gerada por " : "Aprovado por ") + extra.aprovador : ""}.`, { sz: 9, cor: "666666" }); p.mescla(`A${LI + 7}:${ULT}${LI + 7}`);
  return p.gerar();
}

function planilhaCi(sol, extra) {
  const d = sol.dados;
  const p = new Planilha("CI");
  p.paisagem = false;
  p.largura("A", 3); p.largura("B", 22); p.largura("C", 20); p.largura("D", 20); p.largura("E", 20); p.largura("F", 20); p.largura("G", 20);
  const rot = { b: true, borda: true, fill: "E8F0E8", wrap: true };
  const val = { borda: true, wrap: true };
  p.cel("B1", "COMUNICAÇÃO INTERNA - CI", { b: true, sz: 14, h: "center", fill: AZUL, cor: "FFFFFF" }); p.mescla("B1:G1"); p.estiloIntervalo("B1:G1", { fill: AZUL }); p.altura(1, 28);

  const linhaPar = (l, r1, v1, r2, v2) => {
    p.cel("B" + l, r1, rot); p.cel("C" + l, v1, val); p.mescla(`C${l}:D${l}`); p.estiloIntervalo(`C${l}:D${l}`, { borda: true });
    p.cel("E" + l, r2, rot); p.cel("F" + l, v2, val); p.mescla(`F${l}:G${l}`); p.estiloIntervalo(`F${l}:G${l}`, { borda: true });
  };
  linhaPar(3, "DE:", COORDENADOR, "Nº:", extra.numero || "");
  linhaPar(4, "PARA:", "FINANCEIRO", "EMISSÃO:", br(extra.emissao));
  linhaPar(5, "VENDEDOR/PROMOTOR:", sol.promotor_nome.toUpperCase(), "EXECUÇÃO:", br(d.execucao));
  const linhaLarga = (l, r, v, h) => { p.cel("B" + l, r, rot); p.cel("C" + l, v, val); p.mescla(`C${l}:G${l}`); p.estiloIntervalo(`C${l}:G${l}`, { borda: true }); if (h) p.altura(l, h); };
  linhaLarga(6, "AÇÃO:", d.acao, Math.max(30, Math.ceil(d.acao.length / 80) * 16));
  linhaLarga(7, "BRINDE:", d.brinde);
  linhaLarga(8, "CLIENTE:", d.cliente);
  linhaLarga(9, "PERÍODO CAMPANHA (INÍCIO E TÉRMINO):", d.periodoIni ? `${br(d.periodoIni)} a ${br(d.periodoFim || d.periodoIni)}` : "", 30);
  linhaLarga(10, "TIPO DE ACORDO (detalhar o máximo possível):", d.tipoAcordo, Math.max(45, Math.ceil(d.tipoAcordo.length / 80) * 16));
  linhaPar(11, "CARTÃO PRESENTE:", d.cartaoPresente ? "SIM" : "NÃO", "VALOR:", extra.valor);
  p.cel("F11", extra.valor, { borda: true, fmt: "moeda", b: true });
  linhaPar(12, "NOME TITULAR CARTÃO:", d.titular, "CPF / CNPJ:", d.cpfCnpj);
  linhaLarga(13, "OBSERVAÇÃO:", d.observacao, 30);
  p.cel("B15", "DADOS PARA ENTREGA", { b: true, fill: "E8F0E8", borda: true, h: "center" }); p.mescla("B15:G15"); p.estiloIntervalo("B15:G15", { borda: true, fill: "E8F0E8" });
  linhaLarga(16, "ENDEREÇO:", d.entrega.endereco);
  linhaPar(17, "NÚMERO - COMPLEMENTO:", d.entrega.numero, "BAIRRO:", d.entrega.bairro);
  linhaLarga(18, "CIDADE/ESTADO:", d.entrega.cidade);
  linhaPar(19, "NOME (RECEBEDOR):", d.entrega.recebedor, "TELEFONE:", d.entrega.telefone);
  linhaLarga(21, "CENTRO DE CUSTO VERBA:", d.centroCusto);
  p.cel("B23", "EMITENTE: " + COORDENADOR, { b: true }); p.mescla("B23:G23");
  p.cel("B24", `Solicitado por ${sol.promotor_nome} via app Gestão de Campo em ${br(extra.hoje)}${extra.aprovador ? " | Aprovado por " + extra.aprovador : ""}.`, { sz: 9, cor: "666666" }); p.mescla("B24:G24");
  return p.gerar();
}

/* ---------- Kanban ---------- */
async function baixar(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`não consegui ler o anexo (${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

async function enviarAoKanban({ campos, anexos }) {
  if (process.env.KANBAN_ENVIO_ATIVO === "0") {
    return { ok: true, simulado: true, resumo: "MODO TESTE (KANBAN_ENVIO_ATIVO=0): nada foi enviado ao Kanban." };
  }
  const form = new FormData();
  Object.entries(campos).forEach(([k, v]) => form.append(k, v));
  for (const a of anexos) form.append("attachments", new Blob([a.buffer], { type: a.tipo }), a.nome);
  let resp;
  try {
    resp = await fetch(KANBAN_URL(), { method: "POST", body: form, redirect: "manual", signal: AbortSignal.timeout(45000) });
  } catch (err) {
    return { ok: false, resumo: "Não consegui falar com o Kanban: " + String((err.cause && err.cause.code) || err.message || err) };
  }
  const local = resp.headers.get("location") || "";
  if (resp.status >= 300 && resp.status < 400 && /success=1/.test(local)) {
    return { ok: true, resumo: `Kanban respondeu OK (${resp.status}).` };
  }
  return { ok: false, resumo: `Kanban não confirmou o cadastro (HTTP ${resp.status}${local ? ", destino " + local.slice(0, 120) : ""}). Confira lá antes de reenviar.` };
}

async function subirArquivo(supabase, buffer, tipo, ext) {
  const agora = new Date();
  const caminho = `despesas/${agora.getUTCFullYear()}-${String(agora.getUTCMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from(BUCKET).upload(caminho, buffer, { contentType: tipo, upsert: false });
  if (error) throw error;
  return supabase.storage.from(BUCKET).getPublicUrl(caminho).data.publicUrl;
}

/* ---------- apresentação ---------- */
function resumoLinha(l) {
  const d = l.dados || {};
  let valorPromotor = 0;
  try { valorPromotor = l.tipo === "RDV" ? totaisRdv(d).total : Number(d.valor) || 0; } catch (e) { valorPromotor = Number(l.valor_promotor) || 0; }
  return {
    id: l.id, tipo: l.tipo, status: l.status, promotor: l.promotor_nome, login: l.promotor_login,
    periodo_ini: l.periodo_ini, periodo_fim: l.periodo_fim, valor_promotor: valorPromotor,
    criado_em: l.criado_em, gestor: l.gestor || null, motivo_recusa: l.motivo_recusa || "",
    kanban_resposta: l.kanban_resposta || "", arquivo_url: l.arquivo_url || "", enviado_kanban_em: l.enviado_kanban_em || null
  };
}
function detalheLinha(l) {
  const o = resumoLinha(l);
  o.dados = l.dados;
  if (l.tipo === "RDV") { try { o.totais = totaisRdv(l.dados); } catch (e) { o.totais = null; } try { o.titulo = tituloRdv(l); } catch (e) { o.titulo = ""; } }
  return o;
}

/* ---------- handler ---------- */
async function tratarRdv(req, res, ctx) {
  const { usuario, ehGestor, supabase } = ctx;
  const q = req.query || {};
  const loginUsuario = String(usuario.login || "").toLowerCase();
  const nomeUsuario = String(usuario.nome || usuario.login || "");

  try {
    if (req.method === "GET") {
      if (q.acao === "agenda_proxima") {
        const semana = dataIso(q.semana, "a semana", true);
        if (new Date(semana + "T00:00:00Z").getUTCDay() !== 1) falha("A semana deve começar na segunda-feira.");
        const sit = await situacaoAgendaProxima(supabase, nomeUsuario, semana, []);
        res.status(200).json({ semana, proxima: sit.proxima, dias: sit.dias, travaAtiva: !ehGestor });
        return;
      }
      if (q.acao === "agenda") {
        // Agenda do consultor: semana do RDV (o que foi planejado/realizado) e a semana seguinte.
        if (!ehGestor) { res.status(403).json({ erro: "Acesso restrito à gestão." }); return; }
        const { data: sol, error: eS } = await supabase.from("solicitacoes_despesa").select("promotor_nome,periodo_ini,tipo").eq("id", Number(q.id)).maybeSingle();
        if (eS) throw eS;
        if (!sol || sol.tipo !== "RDV" || !sol.periodo_ini) { res.status(404).json({ erro: "RDV não encontrado." }); return; }
        const busca = async (de, ate) => {
          const padrao = String(sol.promotor_nome).replace(/[\\%_]/g, m => "\\" + m);
          const { data, error } = await supabase.from("agenda_compromissos").select("*").ilike("nome_promotor", padrao).gte("data", de).lte("data", ate).order("data", { ascending: true }).order("hora_inicio", { ascending: true });
          if (error) throw error;
          return (data || []).map(c => ({ data: c.data, hora: String(c.hora_inicio || "").slice(0, 5), tipo: c.tipo_cliente, cliente: c.cliente_nome, assunto: c.assunto || "", realizada: !!c.realizada, assuntoRealizado: c.assunto_realizado || "" }));
        };
        const proxIni = paraIso(ms(sol.periodo_ini) + 7 * 86400000);
        res.status(200).json({
          promotor: sol.promotor_nome,
          semana: { de: sol.periodo_ini, ate: paraIso(ms(sol.periodo_ini) + 5 * 86400000), itens: await busca(sol.periodo_ini, paraIso(ms(sol.periodo_ini) + 5 * 86400000)) },
          proxima: { de: proxIni, ate: paraIso(ms(proxIni) + 4 * 86400000), itens: await busca(proxIni, paraIso(ms(proxIni) + 4 * 86400000)) }
        });
        return;
      }
      if (q.id) {
        const { data, error } = await supabase.from("solicitacoes_despesa").select("*").eq("id", Number(q.id)).maybeSingle();
        if (error) throw error;
        if (!data) { res.status(404).json({ erro: "Solicitação não encontrada." }); return; }
        if (data.promotor_login !== loginUsuario && (!ehGestor || data.status === "rascunho")) { res.status(403).json({ erro: "Sem permissão." }); return; }
        res.status(200).json(await anexarDemanda(supabase, data, detalheLinha(data)));
        return;
      }
      let consulta = supabase.from("solicitacoes_despesa").select("*").order("criado_em", { ascending: false }).limit(150);
      const fila = ehGestor && String(q.fila || "") === "1";
      if (!fila) consulta = consulta.eq("promotor_login", loginUsuario);
      else consulta = consulta.neq("status", "rascunho");
      const { data, error } = await consulta;
      if (error) throw error;
      res.status(200).json({ itens: (data || []).map(resumoLinha), fila });
      return;
    }

    if (req.method !== "POST") { res.status(405).json({ erro: "Método não permitido." }); return; }
    const b = req.body || {};
    const acao = String(b.acao || "");

    /* ----- promotor: salvar / excluir ----- */
    if (acao === "salvar") {
      const tipo = b.tipo === "CI" ? "CI" : b.tipo === "RDV" ? "RDV" : falha("Escolha RDV ou CI.");
      const rascunho = b.rascunho === true;
      const dados = tipo === "RDV" ? normalizarRdv(b.dados, rascunho) : normalizarCi(b.dados, rascunho);
      let bloqueio = null;
      if (tipo === "RDV" && !rascunho && !ehGestor) {
        const sit = await situacaoAgendaProxima(supabase, nomeUsuario, dados.semana, dados.diasSemAgenda);
        if (sit.faltam.length) {
          const lista = sit.faltam.map(d => `${DIAS_SEMANA[sit.dias.findIndex(x => x.data === d)].toLowerCase()} (${br(d)})`).join(", ");
          bloqueio = { faltam: sit.faltam, mensagem: `O RDV foi salvo como rascunho, mas não foi enviado ao gestor: preencha antes a agenda da próxima semana (${br(sit.proxima)} a ${br(paraIso(ms(sit.proxima) + 4 * 86400000))}). Faltam compromissos em: ${lista}. Se não houver visita em algum dia, marque "Sem agenda neste dia" e informe o motivo.` };
        }
      }
      const periodoIni = tipo === "RDV" ? dados.semana : null;
      const periodoFim = tipo === "RDV" ? paraIso(ms(dados.semana) + 5 * 86400000) : null;
      let valorPromotor = 0;
      try { valorPromotor = tipo === "RDV" ? totaisRdv(dados).total : dados.valor; } catch (e) { valorPromotor = 0; }
      const base = {
        tipo, dados, periodo_ini: periodoIni, periodo_fim: periodoFim, valor_promotor: valorPromotor,
        status: (rascunho || bloqueio) ? "rascunho" : "pendente", motivo_recusa: null, atualizado_em: new Date().toISOString()
      };
      if (b.id) {
        const { data: atual, error: e1 } = await supabase.from("solicitacoes_despesa").select("*").eq("id", Number(b.id)).maybeSingle();
        if (e1) throw e1;
        if (!atual) { res.status(404).json({ erro: "Solicitação não encontrada." }); return; }
        if (atual.promotor_login !== loginUsuario) { res.status(403).json({ erro: "Só quem criou pode alterar." }); return; }
        if (!["rascunho", "pendente", "recusada"].includes(atual.status)) { res.status(409).json({ erro: "Esta solicitação já foi aprovada e não pode mais ser alterada." }); return; }
        if (atual.tipo !== tipo) { res.status(400).json({ erro: "Não é possível trocar o tipo." }); return; }
        if (bloqueio && atual.status === "pendente") { bloqueio = null; base.status = "pendente"; } // já estava enviado: só edição
        const { data, error } = await supabase.from("solicitacoes_despesa").update(base).eq("id", atual.id).select().single();
        if (error) throw error;
        res.status(200).json({ ...detalheLinha(data), ...(bloqueio ? { bloqueio } : {}) });
        return;
      }
      if (tipo === "RDV") {
        const { data: dup, error: e2 } = await supabase.from("solicitacoes_despesa").select("id,status").eq("promotor_login", loginUsuario).eq("tipo", "RDV").eq("periodo_ini", periodoIni).neq("status", "recusada");
        if (e2) throw e2;
        if (dup && dup.length) { res.status(409).json({ erro: "Já existe um RDV desta semana. Abra-o na lista para continuar.", id: dup[0].id }); return; }
      }
      const { data, error } = await supabase.from("solicitacoes_despesa")
        .insert({ ...base, promotor_login: loginUsuario, promotor_nome: nomeUsuario, criado_em: new Date().toISOString() }).select().single();
      if (error) throw error;
      res.status(201).json({ ...detalheLinha(data), ...(bloqueio ? { bloqueio } : {}) });
      return;
    }

    if (acao === "excluir") {
      const { data: atual } = await supabase.from("solicitacoes_despesa").select("*").eq("id", Number(b.id)).maybeSingle();
      if (!atual) { res.status(404).json({ erro: "Solicitação não encontrada." }); return; }
      if (atual.promotor_login !== loginUsuario && !ehGestor) { res.status(403).json({ erro: "Sem permissão." }); return; }
      if (!["rascunho", "pendente", "recusada"].includes(atual.status)) { res.status(409).json({ erro: "Já aprovada: não pode ser excluída." }); return; }
      const { error } = await supabase.from("solicitacoes_despesa").delete().eq("id", atual.id);
      if (error) throw error;
      res.status(200).json({ status: "ok" });
      return;
    }

    /* ----- gestor ----- */
    if (!ehGestor) { res.status(403).json({ erro: "Acesso restrito à gestão." }); return; }

    // Baixar o Excel do layout ANTES de aprovar (prévia). Não altera nada.
    if (acao === "excel") {
      const { data: sol, error: eX } = await supabase.from("solicitacoes_despesa").select("*").eq("id", Number(b.id)).maybeSingle();
      if (eX) throw eX;
      if (!sol) { res.status(404).json({ erro: "Solicitação não encontrada." }); return; }
      if (sol.status === "rascunho") { res.status(409).json({ erro: "Este RDV ainda é rascunho do consultor." }); return; }
      const anterior = sol.gestor || {};
      const hoje = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
      let demanda = b.demanda !== undefined && b.demanda !== "" ? Number(b.demanda) : (anterior.demanda != null ? Number(anterior.demanda) : null);
      if (sol.tipo === "RDV" && (demanda === null || !isFinite(demanda))) { try { demanda = await demandaDaSemana(supabase, sol.promotor_nome, sol.periodo_ini); } catch (e) { demanda = 0; } }
      const extra = { hoje, aprovador: nomeUsuario, previa: sol.status !== "enviada_kanban", emissao: anterior.emissao || hoje, valor: anterior.valor, numero: anterior.numero || "", demanda: demanda || 0 };
      const buf = sol.tipo === "RDV" ? planilhaRdv(sol, extra) : planilhaCi(sol, extra);
      const rotuloArq = sol.tipo === "RDV" ? tituloRdv(sol) : `CI ${sol.promotor_nome} ${hoje}`;
      res.status(200).json({ nome: nomeArquivoSeguro(rotuloArq, "xlsx"), base64: Buffer.from(buf).toString("base64") });
      return;
    }

    // Gestor corrige a quilometragem dia a dia (KM inicial da semana, KM inicial/final de cada dia).
    if (acao === "ajustar_km") {
      const { data: sol, error: eA } = await supabase.from("solicitacoes_despesa").select("*").eq("id", Number(b.id)).maybeSingle();
      if (eA) throw eA;
      if (!sol || sol.tipo !== "RDV") { res.status(404).json({ erro: "RDV não encontrado." }); return; }
      if (!["pendente", "erro_kanban"].includes(sol.status)) { res.status(409).json({ erro: "Só dá para ajustar a quilometragem antes da aprovação." }); return; }
      const d0 = sol.dados;
      const porData = {};
      (Array.isArray(b.dias) ? b.dias : []).forEach(x => { if (x && x.data) porData[String(x.data).slice(0, 10)] = x; });
      const entrada = d0.dias.map(x => {
        const aj = porData[x.data];
        return { ...x,
          kmFim: aj && aj.kmFim !== undefined ? aj.kmFim : x.kmFimInformado,
          kmIniManual: aj && aj.kmIni !== undefined ? aj.kmIni : x.kmIniManual };
      });
      const kmInicialNovo = b.kmInicial !== undefined && b.kmInicial !== "" ? b.kmInicial : d0.kmInicial;
      const novo = normalizarRdv({ ...d0, kmInicial: kmInicialNovo, dias: entrada }, true);
      novo.dias.forEach((n, i) => {
        if (n.kmFimInformado !== null && n.kmFimInformado < n.kmIni) falha(`KM final de ${DIAS_SEMANA[i].toLowerCase()} (${n.kmFimInformado}) é menor que o inicial (${n.kmIni}).`);
      });
      // mantém os campos que o normalizador não recalcula
      novo.fotoHodometroIni = d0.fotoHodometroIni; novo.fotoHodometroFim = d0.fotoHodometroFim;
      novo.kmFinalHodometro = d0.kmFinalHodometro;
      const mud = [];
      if (Number(d0.kmInicial) !== Number(novo.kmInicial)) mud.push(`KM inicial da semana ${d0.kmInicial} → ${novo.kmInicial}`);
      d0.dias.forEach((x, i) => {
        const n = novo.dias[i];
        if (x.kmIni !== n.kmIni) mud.push(`${DIAS_SEMANA[i].toLowerCase()} KM inicial ${x.kmIni} → ${n.kmIni}`);
        if (x.kmFim !== n.kmFim) mud.push(`${DIAS_SEMANA[i].toLowerCase()} KM final ${x.kmFim} → ${n.kmFim}`);
      });
      if (!mud.length) { res.status(200).json(await anexarDemanda(supabase, sol, detalheLinha(sol))); return; }
      novo.ajustesGestor = [...(Array.isArray(d0.ajustesGestor) ? d0.ajustesGestor : []), { por: nomeUsuario, em: new Date().toISOString(), mudancas: mud }].slice(-20);
      let valorNovo = 0; try { valorNovo = totaisRdv(novo).total; } catch (e) { valorNovo = sol.valor_promotor; }
      // valor digitado antes (g.valor) deixa de valer: o total mudou
      const gNovo = sol.gestor ? { ...sol.gestor } : null; if (gNovo) delete gNovo.valor;
      const { data, error } = await supabase.from("solicitacoes_despesa").update({ dados: novo, valor_promotor: valorNovo, gestor: gNovo, atualizado_em: new Date().toISOString() }).eq("id", sol.id).select().single();
      if (error) throw error;
      res.status(200).json(await anexarDemanda(supabase, data, detalheLinha(data)));
      return;
    }

    if (acao === "recusar") {
      const motivo = txt(b.motivo, 400);
      if (!motivo) { res.status(400).json({ erro: "Informe o motivo da recusa." }); return; }
      const { data: atual } = await supabase.from("solicitacoes_despesa").select("status").eq("id", Number(b.id)).maybeSingle();
      if (!atual) { res.status(404).json({ erro: "Solicitação não encontrada." }); return; }
      if (!["pendente", "erro_kanban"].includes(atual.status)) { res.status(409).json({ erro: "Esta solicitação não está aguardando aprovação." }); return; }
      const { data, error } = await supabase.from("solicitacoes_despesa")
        .update({ status: "recusada", motivo_recusa: motivo, atualizado_em: new Date().toISOString() }).eq("id", Number(b.id)).select().single();
      if (error) throw error;
      res.status(200).json(detalheLinha(data));
      return;
    }

    if (acao === "aprovar" || acao === "reenviar") {
      const { data: sol, error: e0 } = await supabase.from("solicitacoes_despesa").select("*").eq("id", Number(b.id)).maybeSingle();
      if (e0) throw e0;
      if (!sol) { res.status(404).json({ erro: "Solicitação não encontrada." }); return; }
      if (sol.status === "enviada_kanban") { res.status(409).json({ erro: "Esta solicitação já foi enviada ao Kanban." }); return; }
      if (acao === "aprovar" && !["pendente", "erro_kanban"].includes(sol.status)) { res.status(409).json({ erro: "Esta solicitação não está pendente." }); return; }
      if (acao === "reenviar" && sol.status !== "erro_kanban") { res.status(409).json({ erro: "Só é possível reenviar após um erro no Kanban." }); return; }

      const anterior = sol.gestor || {};
      const g = {
        classificacao: txt(b.classificacao !== undefined ? b.classificacao : anterior.classificacao, 100),
        descricao: txtLongo(b.descricao !== undefined ? b.descricao : anterior.descricao, 1500),
        emissao: dataIso(b.emissao !== undefined ? b.emissao : anterior.emissao, "a Data de Emissão", true),
        vencimento: dataIso(b.vencimento !== undefined ? b.vencimento : anterior.vencimento, "a Data de Vencimento", true),
        valor: cent(numero(b.valor !== undefined ? b.valor : anterior.valor, "o valor", { min: 0.01, obrigatorio: true, max: 1e7 })),
        numero: txt(b.numero !== undefined ? b.numero : anterior.numero, 30),
        aprovador: nomeUsuario
      };
      if (sol.tipo === "RDV") {
        const dv = b.demanda !== undefined && b.demanda !== "" ? b.demanda : (anterior.demanda != null ? anterior.demanda : await demandaDaSemana(supabase, sol.promotor_nome, sol.periodo_ini));
        g.demanda = cent(numero(dv, "a demanda da semana", { min: 0, max: 1e9 }));
      }
      if (!g.classificacao) falha("Informe a Classificação da Despesa.");
      if (!g.descricao) falha("Informe a Descrição.");
      if (g.vencimento < g.emissao) falha("O vencimento não pode ser anterior à emissão.");

      const extra = { hoje: new Date().toISOString().slice(0, 10), aprovador: nomeUsuario, emissao: g.emissao, valor: g.valor, numero: g.numero, demanda: g.demanda };
      const buffer = sol.tipo === "RDV" ? planilhaRdv(sol, extra) : planilhaCi(sol, extra);
      const rotulo = sol.tipo === "RDV"
        ? tituloRdv(sol)
        : `CI ${sol.promotor_nome} ${g.emissao}`;
      const nomeArq = nomeArquivoSeguro(rotulo, "xlsx");
      const arquivoUrl = await subirArquivo(supabase, buffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx");

      // anexos: planilha primeiro, depois fotos
      const anexos = [{ nome: nomeArq, tipo: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer }];
      const fotos = [];
      if (sol.tipo === "RDV") {
        fotos.push({ url: sol.dados.fotoHodometroIni, nome: "hodometro_inicial.jpg" });
        sol.dados.dias.forEach((dia, i) => dia.fotos.forEach((u, k) => fotos.push({ url: u, nome: `nota_${["segunda","terca","quarta","quinta","sexta","sabado"][i]}_${k + 1}.jpg` })));
        fotos.push({ url: sol.dados.fotoHodometroFim, nome: "hodometro_final.jpg" });
      } else {
        (sol.dados.fotos || []).forEach((u, k) => fotos.push({ url: u, nome: `anexo_${k + 1}.jpg` }));
      }
      try {
        for (const f of fotos) anexos.push({ nome: f.nome, tipo: "image/jpeg", buffer: await baixar(f.url) });
      } catch (err) {
        const { data } = await supabase.from("solicitacoes_despesa").update({ status: "erro_kanban", gestor: g, arquivo_url: arquivoUrl, kanban_resposta: "Falha ao preparar anexos: " + err.message, atualizado_em: new Date().toISOString() }).eq("id", sol.id).select().single();
        res.status(200).json(detalheLinha(data));
        return;
      }

      const resumoCurto = sol.tipo === "RDV"
        ? tituloRdv(sol)
        : `CI - ${sol.promotor_nome} - ${txt(sol.dados.cliente, 60)}`;
      const campos = {
        establishment: KANBAN_ESTABELECIMENTO(),
        solicitante: KANBAN_SOLICITANTE(),
        email: KANBAN_EMAIL(),
        expense_classification: g.classificacao,
        description: g.descricao,
        value: g.valor.toFixed(2),
        emission_date: g.emissao,
        due_date: g.vencimento,
        payment_type: TIPO_PAGAMENTO,
        description_acerto: resumoCurto
      };
      const r = await enviarAoKanban({ campos, anexos });
      const upd = r.ok
        ? { status: "enviada_kanban", gestor: g, arquivo_url: arquivoUrl, kanban_resposta: r.resumo, enviado_kanban_em: new Date().toISOString(), motivo_recusa: null, atualizado_em: new Date().toISOString() }
        : { status: "erro_kanban", gestor: g, arquivo_url: arquivoUrl, kanban_resposta: r.resumo, atualizado_em: new Date().toISOString() };
      const { data, error } = await supabase.from("solicitacoes_despesa").update(upd).eq("id", sol.id).select().single();
      if (error) throw error;
      res.status(200).json(await anexarDemanda(supabase, data, detalheLinha(data)));
      return;
    }

    res.status(400).json({ erro: "Ação inválida." });
  } catch (err) {
    if (err instanceof ErroValidacao) { res.status(400).json({ erro: err.message }); return; }
    res.status(502).json({ erro: "Falha ao processar a solicitação.", detalhe: String((err && (err.message || err.details)) || err) });
  }
}

module.exports = { tituloRdv, periodoTextoRdv, tratarRdv, normalizarRdv, totaisRdv, planilhaRdv, planilhaCi, normalizarCi };
