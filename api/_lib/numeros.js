// Helper compartilhado: às vezes o Excel devolve um valor monetário como texto
// formatado ("R$ 1.234,56" ou "1234,56", vírgula decimal à brasileira) em vez de
// número puro — Number() sozinho falha nesses casos e vira NaN (tratado como 0).
// Esta função tenta entender os formatos mais comuns antes de desistir.
function paraNumero(valorBruto) {
  if (typeof valorBruto === "number") return Number.isNaN(valorBruto) ? 0 : valorBruto;
  let str = String(valorBruto === undefined || valorBruto === null ? "" : valorBruto).trim();
  if (!str) return 0;

  str = str.replace(/[^\d,.-]/g, ""); // tira "R$", espaços, etc.
  if (!str) return 0;

  if (str.includes(",") && str.includes(".")) {
    // "1.234,56" -> ponto é separador de milhar, vírgula é decimal
    str = str.replace(/\./g, "").replace(",", ".");
  } else if (str.includes(",")) {
    // "1234,56" -> vírgula é decimal
    str = str.replace(",", ".");
  }

  const numero = Number(str);
  return Number.isNaN(numero) ? 0 : numero;
}

module.exports = { paraNumero };
