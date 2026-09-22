// Helper compartilhado: cálculo de semana (segunda a sexta, dias úteis de visita) e do
// prazo de planejamento da Agenda — usado por api/agenda.js.
//
// Regra combinada com o Marcelo (22/09/2026): o consultor precisa preencher a agenda da
// PRÓXIMA semana até sexta-feira às 17:00 (horário de Brasília). Se perder o prazo, só
// AQUELA semana específica fica travada (🔒) — a semana atual nunca é travada, e isso
// precisa aparecer para o gestor (ver api/agenda.js, GET com ?visaoGestor=1).
//
// Brasil não tem mais horário de verão desde 2019 (Lei/Decreto de 2019), então
// America/Sao_Paulo é sempre UTC-3 o ano inteiro — não precisamos de Intl.DateTimeFormat
// nem de biblioteca de timezone, só aritmética fixa (+3h / -3h contra UTC), igual ao
// resto do projeto (ver quinzenas.js).

const NOMES_DIA_SEMANA = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

function segundaFeira(dataISO) {
  const partes = String(dataISO || "").split("-");
  if (partes.length !== 3) return null;
  const [ano, mes, dia] = partes.map(Number);
  if (!ano || !mes || !dia) return null;
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  const diaSemana = d.getUTCDay(); // 0=domingo, 1=segunda, ..., 6=sábado
  const deslocamento = diaSemana === 0 ? -6 : 1 - diaSemana;
  d.setUTCDate(d.getUTCDate() + deslocamento);
  return d.toISOString().slice(0, 10);
}

function somarDias(dataISO, n) {
  const partes = String(dataISO || "").split("-");
  const [ano, mes, dia] = partes.map(Number);
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Data de hoje (AAAA-MM-DD) já no horário de Brasília (UTC-3), não em UTC — importante
// porque o servidor do Vercel roda em UTC e "hoje" pode já ter virado lá sem ter virado
// aqui.
function hojeISOemSP() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Converte uma data (AAAA-MM-DD) + hora local de Brasília ("HH:MM") no instante UTC
// correspondente (milissegundos desde epoch), somando o offset fixo de +3h.
function instanteUTC(dataISO, horaLocal) {
  const [ano, mes, dia] = String(dataISO).split("-").map(Number);
  const [hora, minuto] = String(horaLocal || "00:00").split(":").map(Number);
  return Date.UTC(ano, mes - 1, dia, hora + 3, minuto || 0, 0);
}

function diaDaSemanaLabel(dataISO) {
  const partes = String(dataISO || "").split("-");
  const [ano, mes, dia] = partes.map(Number);
  const d = new Date(Date.UTC(ano, mes - 1, dia));
  return NOMES_DIA_SEMANA[d.getUTCDay()];
}

// Retorna o status de planejamento de uma semana (identificada pela segunda-feira dela).
//   - Semana passada: sempre travada.
//   - Semana atual: NUNCA travada (o consultor sempre pode ajustar a semana em andamento).
//   - Semana futura: aberta até sexta-feira 17:00 (horário de Brasília) da semana anterior
//     a ela; depois disso, travada — só aquela semana específica.
function statusSemana(segundaISO, agoraMs) {
  const agora = agoraMs === undefined ? Date.now() : agoraMs;
  const segundaAtual = segundaFeira(hojeISOemSP());

  if (!segundaISO || !segundaAtual) {
    return { bloqueada: true, motivo: "data_invalida", prazoISO: null };
  }

  if (segundaISO < segundaAtual) {
    return { bloqueada: true, motivo: "semana_passada", prazoISO: null };
  }

  if (segundaISO === segundaAtual) {
    return { bloqueada: false, motivo: "semana_atual", prazoISO: null };
  }

  // Semana futura: prazo é sexta-feira (3 dias antes da segunda-feira dessa semana) às
  // 17:00 horário de Brasília.
  const sextaAnteriorISO = somarDias(segundaISO, -3);
  const prazoMs = instanteUTC(sextaAnteriorISO, "17:00");
  const bloqueada = agora > prazoMs;

  return {
    bloqueada,
    motivo: bloqueada ? "prazo_perdido" : "aberta",
    prazoISO: `${sextaAnteriorISO}T17:00:00-03:00`
  };
}

module.exports = {
  segundaFeira,
  somarDias,
  hojeISOemSP,
  instanteUTC,
  diaDaSemanaLabel,
  statusSemana
};
