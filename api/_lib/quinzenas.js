// Helper compartilhado: cálculo do período de análise/lançamento a partir de uma data ISO
// ("AAAA-MM-DD"). Usado por relatorios.js, lancamentos.js e visitas.js para agrupar e
// filtrar por período.
//
// Havia sido "quinzena" (1ª = dias 1-15, 2ª = dias 16-fim do mês); trocado para SEMANA
// (segunda a domingo, padrão ISO) a pedido do Marcelo — período mais curto = visão mais
// atualizada do que cada promotor está fazendo. Os nomes das funções (quinzenaChave/
// quinzenaRotulo) e o nome deste arquivo ficaram os mesmos por baixo dos panos pra não
// precisar mexer em todo o resto do código que já usa esse contrato — só o CÁLCULO mudou.
//
// "chave" = data (AAAA-MM-DD) da segunda-feira daquela semana — ordena certinho e serve de
// identificador único da semana. "rótulo" = texto pra mostrar ("01–07/Set/2026").

const NOMES_MES = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];

function segundaFeiraDaSemana(dataUTC) {
  const diaSemana = dataUTC.getUTCDay(); // 0=domingo, 1=segunda, ..., 6=sábado
  const deslocamento = diaSemana === 0 ? -6 : 1 - diaSemana;
  const segunda = new Date(dataUTC);
  segunda.setUTCDate(segunda.getUTCDate() + deslocamento);
  return segunda;
}

function quinzenaChave(dataISO) {
  const partes = String(dataISO || "").split("-");
  if (partes.length !== 3) return null;
  const [ano, mes, dia] = partes.map(Number);
  if (!ano || !mes || !dia) return null;
  const segunda = segundaFeiraDaSemana(new Date(Date.UTC(ano, mes - 1, dia)));
  const anoM = segunda.getUTCFullYear();
  const mesM = String(segunda.getUTCMonth() + 1).padStart(2, "0");
  const diaM = String(segunda.getUTCDate()).padStart(2, "0");
  return `${anoM}-${mesM}-${diaM}`;
}

function quinzenaRotulo(chave) {
  const partes = String(chave || "").split("-");
  if (partes.length !== 3) return "";
  const [ano, mes, dia] = partes.map(Number);
  const inicio = new Date(Date.UTC(ano, mes - 1, dia));
  const fim = new Date(inicio);
  fim.setUTCDate(fim.getUTCDate() + 6);

  const diaI = String(inicio.getUTCDate()).padStart(2, "0");
  const diaF = String(fim.getUTCDate()).padStart(2, "0");
  const mesF = NOMES_MES[fim.getUTCMonth()];
  const anoF = fim.getUTCFullYear();

  if (inicio.getUTCMonth() === fim.getUTCMonth()) {
    return `${diaI}–${diaF}/${mesF}/${anoF}`;
  }
  const mesI = NOMES_MES[inicio.getUTCMonth()];
  return `${diaI}/${mesI}–${diaF}/${mesF}/${anoF}`;
}

module.exports = { quinzenaChave, quinzenaRotulo };
