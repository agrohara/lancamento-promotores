// Helper compartilhado: cálculo de quinzena (1ª = dias 1-15, 2ª = dias 16-fim do mês)
// a partir de uma data ISO ("AAAA-MM-DD"). Usado por relatorios.js e lancamentos.js
// para agrupar e filtrar por período.

const NOMES_MES = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];

function quinzenaChave(dataISO) {
  const partes = String(dataISO || "").split("-");
  if (partes.length !== 3) return null;
  const [ano, mes, dia] = partes.map(Number);
  if (!ano || !mes || !dia) return null;
  const metade = dia <= 15 ? 1 : 2;
  return `${ano}-${String(mes).padStart(2, "0")}-${metade}`;
}

function quinzenaRotulo(chave) {
  const [ano, mes, metade] = String(chave || "").split("-");
  if (!ano || !mes || !metade) return "";
  return `${metade === "1" ? "1ª" : "2ª"} Quinzena - ${NOMES_MES[Number(mes) - 1]}/${ano}`;
}

module.exports = { quinzenaChave, quinzenaRotulo };
