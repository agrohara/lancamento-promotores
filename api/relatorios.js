// Vercel Serverless Function — agrega os dados de "Lancamentos" (pedidos) e "Visitas"
// para alimentar a tela de Relatórios. Exige usuário logado (token do /api/login):
// um Promotor só recebe os próprios números; Gerente/Desenvolvedor pode ver todo
// mundo, ou filtrar por um promotor específico.
//
// GET /api/relatorios              -> Promotor: seus dados da quinzena atual. Gerente: todos.
// GET /api/relatorios?promotor=X   -> Gerente/Desenvolvedor: só os dados do promotor X.
//                                     (Promotor comum ignora esse parâmetro — sempre vê só o próprio.)
// GET /api/relatorios?quinzena=AAAA-MM-N -> mostra o resumo dessa quinzena específica
//                                     (chave devolvida em "todasQuinzenas") em vez da atual.
//
// Variáveis de ambiente: as mesmas dos outros endpoints (TENANT_ID, CLIENT_ID,
// CLIENT_SECRET, API_KEY, AUTH_SECRET). Opcionais: DRIVE_ID, ITEM_ID,
// TABLE_NAME (Lancamentos), TABLE_VISITAS (Visitas)

const { usuarioDaRequisicao } = require("./_lib/auth");
const { paraISO } = require("./_lib/datas");
const { paraNumero } = require("./_lib/numeros");

const DRIVE_ID_PADRAO = "b!239ib2QZ802QpEwVD6oJsGCs3VafFl1DpVud7XH4EwnllXBIIGjKQLlfWeBP3ZEo";
const ITEM_ID_PADRAO = "01EEWFJSXC3HLY3IR45NBJ7GFSWWONG7BK";
const TABLE_LANCAMENTOS_PADRAO = "Lancamentos";
const TABLE_VISITAS_PADRAO = "Visitas";

const CARGOS_GESTAO = ["gerente", "desenvolvedor"];
const NOMES_MES = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];

async function obterToken() {
  const url = `https://login.microsoftonline.com/${process.env.TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.CLIENT_ID,
    client_secret: process.env.CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default"
  });
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const dados = await resp.json();
  if (!resp.ok) {
    throw new Error("Falha ao obter token: " + JSON.stringify(dados));
  }
  return dados.access_token;
}

async function obterLinhas(token, driveId, itemId, tableName) {
  const urlGraph = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/workbook/tables('${tableName}')/rows?$select=values`;
  const resp = await fetch(urlGraph, {
    method: "GET",
    headers: { "Authorization": `Bearer ${token}` }
  });
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const erro = new Error("Falha ao ler tabela '" + tableName + "'.");
    erro.detalhe = dados;
    throw erro;
  }
  return (dados.value || []).map(r => r.values && r.values[0]).filter(Boolean);
}

function quinzenaChave(dataISO) {
  const partes = String(dataISO || "").split("-");
  if (partes.length !== 3) return null;
  const [ano, mes, dia] = partes.map(Number);
  if (!ano || !mes || !dia) return null;
  const metade = dia <= 15 ? 1 : 2;
  return `${ano}-${String(mes).padStart(2, "0")}-${metade}`;
}

function quinzenaRotulo(chave) {
  const [ano, mes, metade] = chave.split("-");
  return `${metade === "1" ? "1ª" : "2ª"} Quinzena - ${NOMES_MES[Number(mes) - 1]}/${ano}`;
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ erro: "Use GET." });
    return;
  }

  const chaveEnviada = req.headers["x-api-key"];
  if (!process.env.API_KEY || chaveEnviada !== process.env.API_KEY) {
    res.status(401).json({ erro: "Não autorizado." });
    return;
  }

  const usuario = usuarioDaRequisicao(req);
  if (!usuario) {
    res.status(401).json({ erro: "Sessão expirada ou inválida. Faça login novamente." });
    return;
  }

  const ehGestor = CARGOS_GESTAO.includes(String(usuario.cargo || "").toLowerCase());
  const promotorSolicitado = (req.query && req.query.promotor) || "";
  const filtroPromotor = ehGestor ? String(promotorSolicitado || "").trim() : usuario.nome;

  try {
    const token = await obterToken();
    const driveId = process.env.DRIVE_ID || DRIVE_ID_PADRAO;
    const itemId = process.env.ITEM_ID || ITEM_ID_PADRAO;
    const tableLancamentos = process.env.TABLE_NAME || TABLE_LANCAMENTOS_PADRAO;
    const tableVisitas = process.env.TABLE_VISITAS || TABLE_VISITAS_PADRAO;

    const [linhasLancamentos, linhasVisitas] = await Promise.all([
      obterLinhas(token, driveId, itemId, tableLancamentos),
      obterLinhas(token, driveId, itemId, tableVisitas)
    ]);

    // Lancamentos: Nome_Promotor,Revenda,Propriedade,Produto,Unidade,Preco_Unitario,Volume,Valor_Total,Dia_Lancamento,Quinzena,Observacao_Visita
    let pedidos = linhasLancamentos.map(l => ({
      promotor: String(l[0] || "").trim(),
      valor: paraNumero(l[7]),
      data: paraISO(l[8])
    })).filter(p => p.promotor && p.data);

    // Visitas: Nome_Promotor,Propriedade,Tipo_Visita,Observacao,Foto_URL,Latitude,Longitude,Dia_Visita,Quinzena
    let visitas = linhasVisitas.map(v => ({
      promotor: String(v[0] || "").trim(),
      data: paraISO(v[7])
    })).filter(v => v.promotor && v.data);

    if (filtroPromotor) {
      pedidos = pedidos.filter(p => p.promotor.toLowerCase() === filtroPromotor.toLowerCase());
      visitas = visitas.filter(v => v.promotor.toLowerCase() === filtroPromotor.toLowerCase());
    }

    // Agrega por quinzena (últimos 6 períodos com dados)
    const mapaQuinzenas = new Map();
    function acessarQuinzena(chave) {
      if (!mapaQuinzenas.has(chave)) {
        mapaQuinzenas.set(chave, { chave, rotulo: quinzenaRotulo(chave), valorPedidos: 0, totalPedidos: 0, totalVisitas: 0 });
      }
      return mapaQuinzenas.get(chave);
    }
    for (const p of pedidos) {
      const chave = quinzenaChave(p.data);
      if (!chave) continue;
      const q = acessarQuinzena(chave);
      q.valorPedidos += p.valor;
      q.totalPedidos += 1;
    }
    for (const v of visitas) {
      const chave = quinzenaChave(v.data);
      if (!chave) continue;
      const q = acessarQuinzena(chave);
      q.totalVisitas += 1;
    }

    const todasQuinzenasOrdenadas = [...mapaQuinzenas.values()].sort((a, b) => a.chave.localeCompare(b.chave));
    const porQuinzena = todasQuinzenasOrdenadas.slice(-6);
    const todasQuinzenas = [...todasQuinzenasOrdenadas].reverse().map(q => ({ chave: q.chave, rotulo: q.rotulo }));

    // Ranking por promotor (só relevante quando o gestor não filtrou por um nome específico)
    const mapaPromotor = new Map();
    function acessarPromotor(nome) {
      if (!mapaPromotor.has(nome)) {
        mapaPromotor.set(nome, { promotor: nome, valorPedidos: 0, totalPedidos: 0, totalVisitas: 0 });
      }
      return mapaPromotor.get(nome);
    }
    for (const p of pedidos) {
      const r = acessarPromotor(p.promotor);
      r.valorPedidos += p.valor;
      r.totalPedidos += 1;
    }
    for (const v of visitas) {
      const r = acessarPromotor(v.promotor);
      r.totalVisitas += 1;
    }
    const porPromotor = [...mapaPromotor.values()].sort((a, b) => b.valorPedidos - a.valorPedidos);

    // Quinzena a mostrar como "atual": a pedida via ?quinzena=, ou (padrão) a quinzena de hoje.
    const quinzenaPedida = String((req.query && req.query.quinzena) || "").trim();
    const chaveAtual = quinzenaPedida || quinzenaChave(new Date().toISOString().slice(0, 10));
    const idxAtual = todasQuinzenasOrdenadas.findIndex(q => q.chave === chaveAtual);
    const atual = idxAtual >= 0 ? todasQuinzenasOrdenadas[idxAtual] : { valorPedidos: 0, totalPedidos: 0, totalVisitas: 0 };
    const anterior = idxAtual > 0 ? todasQuinzenasOrdenadas[idxAtual - 1] : null;

    res.status(200).json({
      filtroAplicado: filtroPromotor || null,
      quinzenaMostrada: chaveAtual,
      ehGestor,
      resumoAtual: {
        valorPedidos: atual.valorPedidos || 0,
        totalPedidos: atual.totalPedidos || 0,
        totalVisitas: atual.totalVisitas || 0
      },
      resumoAnterior: anterior ? {
        valorPedidos: anterior.valorPedidos || 0,
        totalPedidos: anterior.totalPedidos || 0,
        totalVisitas: anterior.totalVisitas || 0
      } : null,
      porQuinzena,
      todasQuinzenas,
      porPromotor: ehGestor && !filtroPromotor ? porPromotor : []
    });
  } catch (err) {
    res.status(502).json({ erro: "Falha ao montar relatório.", detalhe: err.detalhe || String(err.message || err) });
  }
};
