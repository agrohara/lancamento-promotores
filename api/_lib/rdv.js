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
function normalizarRdv(d) {
  d = d || {};
  const semana = dataIso(d.semana, "a semana", true);
  if (new Date(semana + "T00:00:00Z").getUTCDay() !== 1) falha("A semana deve começar na segunda-feira.");
  const kmInicial = numero(d.kmInicial, "o KM inicial", { obrigatorio: true, max: 9999999 });
  const hodIni = umaUrl(d.fotoHodometroIni);
  const hodFim = umaUrl(d.fotoHodometroFim);
  if (!hodIni) falha("Envie a foto do hodômetro inicial.");
  if (!hodFim) falha("Envie a foto do hodômetro final.");

  const entrada = Array.isArray(d.dias) ? d.dias : [];
  let kmAnterior = kmInicial;
  const dias = [];
  let temMovimento = false;
  for (let i = 0; i < 6; i++) {
    const dia = entrada.find(x => x && x.data === paraIso(ms(semana) + i * 86400000)) || entrada[i] || {};
    const data = paraIso(ms(semana) + i * 86400000);
    const kmFimBruto = dia.kmFim === "" || dia.kmFim === undefined || dia.kmFim === null ? null : numero(dia.kmFim, `o KM final de ${DIAS_SEMANA[i].toLowerCase()}`, { max: 9999999 });
    const kmIni = kmAnterior;
    if (kmFimBruto !== null && kmFimBruto < kmIni) falha(`KM final de ${DIAS_SEMANA[i].toLowerCase()} (${kmFimBruto}) é menor que o inicial (${kmIni}).`);
    const kmFim = kmFimBruto === null ? kmIni : kmFimBruto;
    const rod = kmFim - kmIni;
    const reg = {
      data, kmIni, kmFim, kmRodado: rod,
      hotel: cent(numero(dia.hotel, "hotel", { max: 100000 })),
      almoco: cent(numero(dia.almoco, "almoço", { max: 100000 })),
      jantar: cent(numero(dia.jantar, "jantar", { max: 100000 })),
      aviso: cent(numero(dia.aviso, "despesa com aviso prévio", { max: 100000 })),
      descricao: txt(dia.descricao, 400),
      fotos: urlsDoStorage(dia.fotos, 8)
    };
    const gastou = reg.hotel + reg.almoco + reg.jantar + reg.aviso;
    if ((rod > 0 || gastou > 0) && !reg.descricao) falha(`Descreva a atividade de ${DIAS_SEMANA[i].toLowerCase()} (${br(data)}).`);
    if (gastou > 0 && reg.fotos.length === 0) falha(`Anexe a foto da nota de ${DIAS_SEMANA[i].toLowerCase()} (${br(data)}).`);
    if (rod > 0 || gastou > 0) temMovimento = true;
    kmAnterior = kmFim;
    dias.push(reg);
  }
  if (!temMovimento) falha("Preencha pelo menos um dia da semana.");
  return {
    semana, kmInicial, kmFinal: kmAnterior, fotoHodometroIni: hodIni, fotoHodometroFim: hodFim,
    veiculo: txt(d.veiculo, 60), placa: txt(d.placa, 12).toUpperCase(),
    observacao: txtLongo(d.observacao, 800), dias
  };
}

function totaisRdv(d) {
  const vkm = VALOR_KM();
  const km = d.dias.reduce((s, x) => s + x.kmRodado, 0);
  const valorKm = cent(km * vkm);
  const hotel = cent(d.dias.reduce((s, x) => s + x.hotel, 0));
  const almoco = cent(d.dias.reduce((s, x) => s + x.almoco, 0));
  const jantar = cent(d.dias.reduce((s, x) => s + x.jantar, 0));
  const aviso = cent(d.dias.reduce((s, x) => s + x.aviso, 0));
  return { km, valorKm, hotel, almoco, jantar, aviso, total: cent(valorKm + hotel + almoco + jantar + aviso), vkm };
}

function normalizarCi(d) {
  d = d || {};
  const cartao = d.cartaoPresente === true || d.cartaoPresente === "SIM";
  const valor = cent(numero(d.valor, "o valor", { min: 0.01, obrigatorio: true, max: 1e7 }));
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
  if (!reg.acao) falha("Descreva a ação.");
  if (!reg.cliente) falha("Informe o cliente.");
  if (!reg.centroCusto) falha("Informe o centro de custo (ex.: Pecuária, PET).");
  if (cartao && !reg.titular) falha("Informe o nome do titular do cartão presente.");
  return reg;
}

/* ---------- Excel ---------- */
const AZUL = "1F4D2E";
function planilhaRdv(sol, extra) {
  const d = sol.dados, t = totaisRdv(d);
  const p = new Planilha("RDV");
  p.paisagem = true;
  const larg = { A: 16, B: 12, C: 11, D: 11, E: 11, F: 13, G: 13, H: 13, I: 13, J: 19, K: 60 };
  Object.keys(larg).forEach(c => p.largura(c, larg[c]));
  const cab = { b: true, borda: true, fill: "E8F0E8", h: "center", wrap: true };
  const caixa = { borda: true, wrap: true };

  p.cel("A1", "RELATÓRIO DE DESPESAS DE VIAGEM - RDV SEMANAL", { b: true, sz: 14, h: "center", fill: AZUL, cor: "FFFFFF" });
  p.mescla("A1:K1"); p.estiloIntervalo("A1:K1", { fill: AZUL }); p.altura(1, 28);

  p.cel("A3", "NOME CONSULTOR/RDV", cab); p.mescla("A3:C3");
  p.cel("D3", "NOME COORDENADOR", cab); p.mescla("D3:F3");
  p.cel("G3", "PERÍODO", cab); p.mescla("G3:H3");
  p.cel("I3", "VEÍCULO", cab); p.mescla("I3:J3");
  p.cel("K3", "PLACA", cab);
  p.cel("A4", sol.promotor_nome.toUpperCase(), caixa); p.mescla("A4:C4");
  p.cel("D4", COORDENADOR, caixa); p.mescla("D4:F4");
  p.cel("G4", `${br(d.semana)} A ${br(paraIso(ms(d.semana) + 5 * 86400000))}`, caixa); p.mescla("G4:H4");
  p.cel("I4", d.veiculo, caixa); p.mescla("I4:J4");
  p.cel("K4", d.placa, caixa);
  ["A3:C3", "D3:F3", "G3:H3", "I3:J3", "A4:C4", "D4:F4", "G4:H4", "I4:J4"].forEach(r => p.estiloIntervalo(r, { borda: true }));

  p.cel("A6", "PRESTAÇÃO DE CONTAS", { b: true, fill: "E8F0E8", borda: true, h: "center" }); p.mescla("A6:C6");
  p.cel("D6", "DESPESA DESTE RDV:", cab); p.mescla("D6:F6");
  p.cel("G6", t.total, { b: true, fmt: "moeda", borda: true, h: "center" }, { f: "I21+J21+F21+G21+H21" }); p.mescla("G6:H6");
  p.estiloIntervalo("A6:H6", { borda: true });

  // cabeçalho da tabela (linhas 8-9)
  p.cel("A8", "DIA DA SEMANA", cab); p.mescla("A8:A9");
  p.cel("B8", "DATA", cab); p.mescla("B8:B9");
  p.cel("C8", "DESPESAS DE VIAGEM A SERVIÇO DA EMPRESA", cab); p.mescla("C8:J8");
  p.cel("K8", "DESCRIÇÃO (DETALHAR AS AÇÕES, ATIVIDADES OU JUSTIFICATIVAS QUE ORIGINARAM AS DESPESAS)", cab); p.mescla("K8:K9");
  const sub = ["KM INICIAL", "KM FINAL", "KM RODADO", `VALOR KM (R$ ${t.vkm.toFixed(2).replace(".", ",")})`, "HOTEL", "ALMOÇO", "JANTAR", "AVISO PRÉVIO (EX.: ALMOÇO COM VETERINÁRIO)"];
  sub.forEach((s, i) => p.cel(String.fromCharCode(67 + i) + "9", s, cab));
  p.estiloIntervalo("A8:K9", { borda: true, fill: "E8F0E8" });
  p.altura(8, 22); p.altura(9, 58);

  d.dias.forEach((x, i) => {
    const l = 10 + i;
    p.cel("A" + l, DIAS_SEMANA[i], { ...caixa, b: true });
    p.cel("B" + l, null, { borda: true, h: "center" }, { data: x.data });
    p.cel("C" + l, x.kmIni, { borda: true, fmt: "km" });
    p.cel("D" + l, x.kmFim, { borda: true, fmt: "km" });
    p.cel("E" + l, x.kmRodado, { borda: true, fmt: "km" }, { f: `D${l}-C${l}` });
    p.cel("F" + l, cent(x.kmRodado * t.vkm), { borda: true, fmt: "moeda" }, { f: `E${l}*${t.vkm}` });
    p.cel("G" + l, x.hotel, { borda: true, fmt: "moeda" });
    p.cel("H" + l, x.almoco, { borda: true, fmt: "moeda" });
    p.cel("I" + l, x.jantar, { borda: true, fmt: "moeda" });
    p.cel("J" + l, x.aviso, { borda: true, fmt: "moeda" });
    p.cel("K" + l, x.descricao, caixa);
    p.altura(l, x.descricao.length > 70 ? 45 : 30);
  });
  // linhas 16-20 em branco com borda (padrão do modelo)
  for (let l = 16; l <= 20; l++) p.estiloIntervalo(`A${l}:K${l}`, { borda: true });
  p.cel("A21", "SUBTOTAIS", { b: true, borda: true, fill: "E8F0E8" }); p.mescla("A21:B21"); p.estiloIntervalo("A21:K21", { borda: true, fill: "E8F0E8" });
  p.cel("E21", t.km, { b: true, borda: true, fmt: "km", fill: "E8F0E8" }, { f: "SUM(E10:E20)" });
  p.cel("F21", t.valorKm, { b: true, borda: true, fmt: "moeda", fill: "E8F0E8" }, { f: "SUM(F10:F20)" });
  p.cel("G21", t.hotel, { b: true, borda: true, fmt: "moeda", fill: "E8F0E8" }, { f: "SUM(G10:G20)" });
  p.cel("H21", t.almoco, { b: true, borda: true, fmt: "moeda", fill: "E8F0E8" }, { f: "SUM(H10:H20)" });
  p.cel("I21", t.jantar, { b: true, borda: true, fmt: "moeda", fill: "E8F0E8" }, { f: "SUM(I10:I20)" });
  p.cel("J21", t.aviso, { b: true, borda: true, fmt: "moeda", fill: "E8F0E8" }, { f: "SUM(J10:J20)" });
  // a fórmula do total em G6 usa as colunas F..J da linha 21
  p.cel("G6", t.total, { b: true, fmt: "moeda", borda: true, h: "center" }, { f: "SUM(F21:J21)" });

  p.cel("A23", "INFORMAÇÕES DE RELEVÂNCIA SOBRE AS DESPESAS", cab); p.mescla("A23:K23");
  p.cel("A24", d.observacao || "", { borda: true, wrap: true, v: "top" }); p.mescla("A24:K27"); p.estiloIntervalo("A24:K27", { borda: true });
  p.cel("A29", `Hodômetro inicial: ${d.kmInicial}  |  Hodômetro final: ${d.kmFinal}  |  Fotos do hodômetro e das notas seguem anexas no Kanban.`, { sz: 9, cor: "666666" }); p.mescla("A29:K29");
  p.cel("A30", `Enviado pelo app Gestão de Campo em ${br(extra.hoje)}${extra.aprovador ? " | Aprovado por " + extra.aprovador : ""}.`, { sz: 9, cor: "666666" }); p.mescla("A30:K30");
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
  if (l.tipo === "RDV") { try { o.totais = totaisRdv(l.dados); } catch (e) { o.totais = null; } }
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
      if (q.id) {
        const { data, error } = await supabase.from("solicitacoes_despesa").select("*").eq("id", Number(q.id)).maybeSingle();
        if (error) throw error;
        if (!data) { res.status(404).json({ erro: "Solicitação não encontrada." }); return; }
        if (!ehGestor && data.promotor_login !== loginUsuario) { res.status(403).json({ erro: "Sem permissão." }); return; }
        res.status(200).json(detalheLinha(data));
        return;
      }
      let consulta = supabase.from("solicitacoes_despesa").select("*").order("criado_em", { ascending: false }).limit(150);
      const fila = ehGestor && String(q.fila || "") === "1";
      if (!fila) consulta = consulta.eq("promotor_login", loginUsuario);
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
      const dados = tipo === "RDV" ? normalizarRdv(b.dados) : normalizarCi(b.dados);
      const periodoIni = tipo === "RDV" ? dados.semana : null;
      const periodoFim = tipo === "RDV" ? paraIso(ms(dados.semana) + 5 * 86400000) : null;
      const valorPromotor = tipo === "RDV" ? totaisRdv(dados).total : dados.valor;
      const base = {
        tipo, dados, periodo_ini: periodoIni, periodo_fim: periodoFim, valor_promotor: valorPromotor,
        status: "pendente", motivo_recusa: null, atualizado_em: new Date().toISOString()
      };
      if (b.id) {
        const { data: atual, error: e1 } = await supabase.from("solicitacoes_despesa").select("*").eq("id", Number(b.id)).maybeSingle();
        if (e1) throw e1;
        if (!atual) { res.status(404).json({ erro: "Solicitação não encontrada." }); return; }
        if (atual.promotor_login !== loginUsuario) { res.status(403).json({ erro: "Só quem criou pode alterar." }); return; }
        if (!["pendente", "recusada"].includes(atual.status)) { res.status(409).json({ erro: "Esta solicitação já foi aprovada e não pode mais ser alterada." }); return; }
        if (atual.tipo !== tipo) { res.status(400).json({ erro: "Não é possível trocar o tipo." }); return; }
        const { data, error } = await supabase.from("solicitacoes_despesa").update(base).eq("id", atual.id).select().single();
        if (error) throw error;
        res.status(200).json(detalheLinha(data));
        return;
      }
      if (tipo === "RDV") {
        const { data: dup, error: e2 } = await supabase.from("solicitacoes_despesa").select("id,status").eq("promotor_login", loginUsuario).eq("tipo", "RDV").eq("periodo_ini", periodoIni).neq("status", "recusada");
        if (e2) throw e2;
        if (dup && dup.length) { res.status(409).json({ erro: "Você já enviou o RDV desta semana. Abra-o na lista para alterar." , id: dup[0].id }); return; }
      }
      const { data, error } = await supabase.from("solicitacoes_despesa")
        .insert({ ...base, promotor_login: loginUsuario, promotor_nome: nomeUsuario, criado_em: new Date().toISOString() }).select().single();
      if (error) throw error;
      res.status(201).json(detalheLinha(data));
      return;
    }

    if (acao === "excluir") {
      const { data: atual } = await supabase.from("solicitacoes_despesa").select("*").eq("id", Number(b.id)).maybeSingle();
      if (!atual) { res.status(404).json({ erro: "Solicitação não encontrada." }); return; }
      if (atual.promotor_login !== loginUsuario && !ehGestor) { res.status(403).json({ erro: "Sem permissão." }); return; }
      if (!["pendente", "recusada"].includes(atual.status)) { res.status(409).json({ erro: "Já enviada ao Kanban: não pode ser excluída." }); return; }
      const { error } = await supabase.from("solicitacoes_despesa").delete().eq("id", atual.id);
      if (error) throw error;
      res.status(200).json({ status: "ok" });
      return;
    }

    /* ----- gestor ----- */
    if (!ehGestor) { res.status(403).json({ erro: "Acesso restrito à gestão." }); return; }

    if (acao === "recusar") {
      const motivo = txt(b.motivo, 400);
      if (!motivo) { res.status(400).json({ erro: "Informe o motivo da recusa." }); return; }
      const { data: atual } = await supabase.from("solicitacoes_despesa").select("status").eq("id", Number(b.id)).maybeSingle();
      if (!atual) { res.status(404).json({ erro: "Solicitação não encontrada." }); return; }
      if (atual.status === "enviada_kanban") { res.status(409).json({ erro: "Já enviada ao Kanban." }); return; }
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
      if (!g.classificacao) falha("Informe a Classificação da Despesa.");
      if (!g.descricao) falha("Informe a Descrição.");
      if (g.vencimento < g.emissao) falha("O vencimento não pode ser anterior à emissão.");

      const extra = { hoje: new Date().toISOString().slice(0, 10), aprovador: nomeUsuario, emissao: g.emissao, valor: g.valor, numero: g.numero };
      const buffer = sol.tipo === "RDV" ? planilhaRdv(sol, extra) : planilhaCi(sol, extra);
      const rotulo = sol.tipo === "RDV"
        ? `RDV ${sol.promotor_nome} ${sol.periodo_ini}`
        : `CI ${sol.promotor_nome} ${g.emissao}`;
      const nomeArq = rotulo.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9 _-]/g, "").replace(/\s+/g, "_") + ".xlsx";
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
        ? `RDV semanal ${br(sol.periodo_ini)} a ${br(sol.periodo_fim)} - ${sol.promotor_nome}`
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
      res.status(200).json(detalheLinha(data));
      return;
    }

    res.status(400).json({ erro: "Ação inválida." });
  } catch (err) {
    if (err instanceof ErroValidacao) { res.status(400).json({ erro: err.message }); return; }
    res.status(502).json({ erro: "Falha ao processar a solicitação.", detalhe: String((err && (err.message || err.details)) || err) });
  }
}

module.exports = { tratarRdv, normalizarRdv, totaisRdv, planilhaRdv, planilhaCi, normalizarCi };
