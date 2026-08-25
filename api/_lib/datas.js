// Helper compartilhado: o Excel às vezes grava datas como número serial
// (dias desde 1899-12-30) em vez de manter o texto "AAAA-MM-DD" que a gente
// enviou — depende de como a coluna está formatada na tabela. Toda leitura
// de data vinda do Graph API deve passar por aqui para normalizar para
// sempre "AAAA-MM-DD", senão comparações/agregações por data quebram.
function paraISO(valorBruto) {
  const str = String(valorBruto === undefined || valorBruto === null ? "" : valorBruto).trim();
  if (!str) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);

  const serial = Number(str);
  if (!Number.isNaN(serial) && serial > 0) {
    const base = Date.UTC(1899, 11, 30);
    const data = new Date(base + serial * 86400000);
    const ano = data.getUTCFullYear();
    const mes = String(data.getUTCMonth() + 1).padStart(2, "0");
    const dia = String(data.getUTCDate()).padStart(2, "0");
    return `${ano}-${mes}-${dia}`;
  }
  return str;
}

module.exports = { paraISO };
