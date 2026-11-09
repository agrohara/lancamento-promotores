// Gera a planilha da CI (Comunicação Interna) a partir do modelo oficial (ci_modelo_b64.js):
// mantém logos, 1ª e 2ª via e formatação do arquivo do Fábio, e só troca os valores das células.
// Sem dependências externas — só "zlib".
const zlib = require("zlib");
const MODELO_B64 = require("./ci_modelo_b64");

/* ---------- leitura/escrita de zip (mínimo) ---------- */
function lerZip(buf) {
  let fim = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { fim = i; break; }
  if (fim < 0) throw new Error("modelo da CI inválido");
  const total = buf.readUInt16LE(fim + 10);
  let pos = buf.readUInt32LE(fim + 16);
  const arqs = [];
  for (let n = 0; n < total; n++) {
    const metodo = buf.readUInt16LE(pos + 10);
    const tamComp = buf.readUInt32LE(pos + 20);
    const nomeLen = buf.readUInt16LE(pos + 28), extraLen = buf.readUInt16LE(pos + 30), comLen = buf.readUInt16LE(pos + 32);
    const locPos = buf.readUInt32LE(pos + 42);
    const nome = buf.slice(pos + 46, pos + 46 + nomeLen).toString("utf8");
    const dadosPos = locPos + 30 + buf.readUInt16LE(locPos + 26) + buf.readUInt16LE(locPos + 28);
    const comp = buf.slice(dadosPos, dadosPos + tamComp);
    arqs.push({ nome, dados: metodo === 0 ? comp : zlib.inflateRawSync(comp) });
    pos += 46 + nomeLen + extraLen + comLen;
  }
  return arqs;
}
const TAB = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = TAB[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function montarZip(arqs) {
  const partes = [], central = []; let off = 0;
  for (const a of arqs) {
    const nome = Buffer.from(a.nome, "utf8"), bruto = a.dados;
    const comp = /\.(png|jpe?g)$/i.test(a.nome) ? bruto : zlib.deflateRawSync(bruto);
    const metodo = comp === bruto ? 0 : 8, crc = crc32(bruto);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(0x0800, 6); loc.writeUInt16LE(metodo, 8);
    loc.writeUInt32LE(crc, 14); loc.writeUInt32LE(comp.length, 18); loc.writeUInt32LE(bruto.length, 22); loc.writeUInt16LE(nome.length, 26);
    partes.push(loc, nome, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(metodo, 10);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(bruto.length, 24); cen.writeUInt16LE(nome.length, 28); cen.writeUInt32LE(off, 42);
    central.push(cen, nome);
    off += 30 + nome.length + comp.length;
  }
  const cenBuf = Buffer.concat(central);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0); fim.writeUInt16LE(arqs.length, 8); fim.writeUInt16LE(arqs.length, 10);
  fim.writeUInt32LE(cenBuf.length, 12); fim.writeUInt32LE(off, 16);
  return Buffer.concat([...partes, cenBuf, fim]);
}

/* ---------- edição das células ---------- */
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r?\n/g, "&#10;");
const colNum = (l) => l.split("").reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);

function definirCelula(xml, ref, valor, estiloPadrao) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  const col = m[1], lin = m[2];
  let novo;
  const montar = (s) => {
    const atr = s ? ` s="${s}"` : "";
    if (valor === "" || valor === null || valor === undefined) return `<c r="${ref}"${atr}/>`;
    if (typeof valor === "number") return `<c r="${ref}"${atr}><v>${valor}</v></c>`;
    return `<c r="${ref}"${atr} t="inlineStr"><is><t xml:space="preserve">${esc(valor)}</t></is></c>`;
  };
  const re = new RegExp(`<c r="${ref}"( s="(\\d+)")?[^>]*?(/>|>[\\s\\S]*?</c>)`);
  const ex = re.exec(xml);
  if (ex) return xml.replace(re, () => montar(ex[2] || estiloPadrao));
  // célula inexistente: insere na linha, na ordem certa das colunas
  const reLinha = new RegExp(`(<row r="${lin}"[^>]*?)(/>|>([\\s\\S]*?)</row>)`);
  const l = reLinha.exec(xml);
  if (!l) return xml;
  const novaCel = montar(estiloPadrao);
  if (l[2] === "/>") return xml.replace(reLinha, () => `${l[1]}>${novaCel}</row>`);
  const corpo = l[3];
  const cels = corpo.match(/<c r="[A-Z]+\d+"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || [];
  let inserido = false, saida = "";
  for (const c of cels) {
    const cc = /<c r="([A-Z]+)\d+"/.exec(c)[1];
    if (!inserido && colNum(cc) > colNum(col)) { saida += novaCel; inserido = true; }
    saida += c;
  }
  if (!inserido) saida += novaCel;
  return xml.replace(reLinha, () => `${l[1]}>${saida}</row>`);
}

const serial = (iso) => (iso ? Math.round((Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 86400000) : "");
const br = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "");

const PARA = "FINANCEIRO/VIVIANE E ALINE";
const DESLOC_2A_VIA = 39;

// sol: solicitação (sol.dados já validado, sol.promotor_nome); extra: { numero, emissao, valor, hoje, aprovador }
function planilhaCiModelo(sol, extra, emitente) {
  const d = sol.dados || {};
  const arqs = lerZip(Buffer.from(MODELO_B64, "base64"));
  const iSheet = arqs.findIndex(a => a.nome === "xl/worksheets/sheet1.xml");
  let xml = arqs[iSheet].dados.toString("utf8");

  const periodo = d.periodoIni ? `${br(d.periodoIni)} a ${br(d.periodoFim || d.periodoIni)}` : "";
  const e = d.entrega || {};
  const campos = [
    ["D3", emitente], ["M3", extra.numero || ""], ["D4", PARA], ["M4", serial(extra.emissao)],
    ["D5", d.acao || ""], ["M5", serial(d.execucao)],
    ["D8", d.brinde || ""], ["D9", d.cliente || ""], ["E10", String(sol.promotor_nome || "")], ["H11", periodo],
    ["C13", d.tipoAcordo || ""], ["H21", d.cartaoPresente ? "SIM" : "NÃO"], ["J21", d.titular || ""], ["M21", d.cpfCnpj || ""],
    ["D23", Number(extra.valor) || 0], ["J23", d.observacao || ""],
    ["F26", e.endereco || ""], ["F27", e.numero || ""], ["F28", e.bairro || ""], ["F29", e.cidade || ""],
    ["F31", e.recebedor || ""], ["F32", e.telefone || ""], ["F34", d.centroCusto || ""], ["L34", emitente]
  ];
  // estilo de cada célula da 1ª via: serve de padrão se a mesma célula da 2ª via não existir
  const estilo = (ref) => { const m = new RegExp(`<c r="${ref}"(?: s="(\\d+)")?`).exec(xml); return m ? m[1] : ""; };
  const estilos1 = campos.map(([ref]) => estilo(ref));
  campos.forEach(([ref, v], i) => { xml = definirCelula(xml, ref, v, estilos1[i]); });
  campos.forEach(([ref, v], i) => {
    const m = /^([A-Z]+)(\d+)$/.exec(ref);
    const ref2 = m[1] + (Number(m[2]) + DESLOC_2A_VIA);
    xml = definirCelula(xml, ref2, v, estilos1[i]);
  });
  xml = definirCelula(xml, "F" + (21 + DESLOC_2A_VIA), "", "2"); // "NÃO" solto da 2ª via do modelo
  xml = xml.replace(/<f>[^<]*<\/f>/g, "").replace(/<f [^>]*>[^<]*<\/f>/g, "").replace(/<f [^>]*\/>/g, "");
  arqs[iSheet].dados = Buffer.from(xml, "utf8");

  // sem cadeia de cálculo (não há mais fórmulas) e com título/autor do arquivo limpos
  const saida = arqs.filter(a => a.nome !== "xl/calcChain.xml").map(a => {
    if (a.nome === "[Content_Types].xml") a.dados = Buffer.from(a.dados.toString("utf8").replace(/<Override[^>]*calcChain[^>]*\/>/, ""), "utf8");
    if (a.nome === "xl/_rels/workbook.xml.rels") a.dados = Buffer.from(a.dados.toString("utf8").replace(/<Relationship [^>]*calcChain[^>]*\/>/, ""), "utf8");
    return a;
  });
  return montarZip(saida);
}

module.exports = { planilhaCiModelo };
