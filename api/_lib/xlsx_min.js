// Gerador mínimo de planilha .xlsx (uma aba) SEM dependências externas — só o módulo "zlib"
// nativo do Node. Foi escrito para não precisar alterar o package.json do projeto.
//
// Suporta: textos, números, datas, fórmulas (com valor já calculado, para abrir certo em
// qualquer leitor), mesclagem de células, largura de coluna, altura de linha, bordas,
// preenchimento, negrito, alinhamento, quebra de linha e impressão em paisagem/1 página de largura.
//
// Uso:
//   const p = new Planilha("RDV");
//   p.largura("A", 18); p.altura(1, 30);
//   p.cel("A1", "Título", { b: true, sz: 14, h: "center", fill: "DDEBDD" }); p.mescla("A1:K1");
//   p.cel("E5", 123.4, { fmt: "moeda", borda: true }, { f: "C5*D5" });
//   const buffer = p.gerar();

const zlib = require("zlib");

/* ---------- CRC32 (necessário para o formato ZIP) ---------- */
const TABELA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABELA_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function montarZip(arquivos) {
  const partes = [];
  const central = [];
  let deslocamento = 0;
  const dataDos = ((2026 - 1980) << 9) | (1 << 5) | 1; // 01/01/2026 (valor fixo)
  for (const a of arquivos) {
    const nome = Buffer.from(a.nome, "utf8");
    const bruto = Buffer.isBuffer(a.dados) ? a.dados : Buffer.from(a.dados, "utf8");
    const comp = zlib.deflateRawSync(bruto);
    const crc = crc32(bruto);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(20, 4);
    loc.writeUInt16LE(0x0800, 6); // nomes em UTF-8
    loc.writeUInt16LE(8, 8);
    loc.writeUInt16LE(0, 10);
    loc.writeUInt16LE(dataDos, 12);
    loc.writeUInt32LE(crc, 14);
    loc.writeUInt32LE(comp.length, 18);
    loc.writeUInt32LE(bruto.length, 22);
    loc.writeUInt16LE(nome.length, 26);
    loc.writeUInt16LE(0, 28);
    partes.push(loc, nome, comp);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(dataDos, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(bruto.length, 24);
    cen.writeUInt16LE(nome.length, 28);
    cen.writeUInt32LE(deslocamento, 42);
    central.push(cen, nome);
    deslocamento += 30 + nome.length + comp.length;
  }
  const tamCentral = central.reduce((s, b) => s + b.length, 0);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(arquivos.length, 8);
  fim.writeUInt16LE(arquivos.length, 10);
  fim.writeUInt32LE(tamCentral, 12);
  fim.writeUInt32LE(deslocamento, 16);
  return Buffer.concat([...partes, ...central, fim]);
}

/* ---------- utilidades ---------- */
function esc(s) {
  return String(s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function letraColuna(n) { // 1 -> A
  let s = "";
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function colunaNumero(letras) {
  let n = 0;
  for (const ch of letras) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
function separaRef(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) throw new Error("Referência inválida: " + ref);
  return { col: colunaNumero(m[1]), lin: Number(m[2]) };
}
function serialData(iso) { // "2026-08-17" -> número de série do Excel
  const [a, m, d] = iso.split("-").map(Number);
  return Math.round((Date.UTC(a, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
}

const FORMATOS = {
  geral: 0,
  int: 3,        // #,##0
  dec2: 4,       // #,##0.00
  data: 164,     // dd/mm/yyyy
  moeda: 165,    // "R$" #,##0.00
  km: 166        // #,##0
};

class Planilha {
  constructor(nomeAba) {
    this.nomeAba = String(nomeAba || "Planilha").slice(0, 31);
    this.celulas = new Map();     // "lin:col" -> {ref, v, tipo, estilo, f}
    this.merges = [];
    this.larguras = {};
    this.alturas = {};
    this.estilos = [{}];          // 0 = padrão
    this.mapaEstilo = new Map([["{}", 0]]);
    this.paisagem = true;
  }

  _estilo(e) {
    const chave = JSON.stringify(e || {});
    if (this.mapaEstilo.has(chave)) return this.mapaEstilo.get(chave);
    this.estilos.push(e || {});
    const idx = this.estilos.length - 1;
    this.mapaEstilo.set(chave, idx);
    return idx;
  }

  // valor: string | number | null.  Para data, passe {data:"AAAA-MM-DD"} em opcoes ou use fmt:"data" com número serial.
  cel(ref, valor, estilo, opcoes) {
    const { col, lin } = separaRef(ref);
    const o = opcoes || {};
    let tipo = "vazio", v = null;
    if (o.data) { tipo = "num"; v = serialData(o.data); estilo = Object.assign({ fmt: "data" }, estilo || {}); }
    else if (typeof valor === "number" && isFinite(valor)) { tipo = "num"; v = valor; }
    else if (valor !== null && valor !== undefined && String(valor) !== "") { tipo = "txt"; v = String(valor); }
    this.celulas.set(lin + ":" + col, { col, lin, tipo, v, f: o.f || null, s: this._estilo(estilo) });
  }

  // Aplica um estilo a um intervalo (útil para bordas em células mescladas/vazias).
  estiloIntervalo(intervalo, estilo) {
    const [a, b] = intervalo.split(":");
    const i = separaRef(a), f = separaRef(b || a);
    for (let l = i.lin; l <= f.lin; l++) for (let c = i.col; c <= f.col; c++) {
      const k = l + ":" + c;
      if (!this.celulas.has(k)) this.celulas.set(k, { col: c, lin: l, tipo: "vazio", v: null, f: null, s: this._estilo(estilo) });
    }
  }

  mescla(intervalo) { this.merges.push(intervalo); }
  largura(letra, w) { this.larguras[colunaNumero(letra)] = w; }
  altura(lin, h) { this.alturas[lin] = h; }

  _xmlEstilos() {
    const fontes = [{ b: false, sz: 10, cor: null }];
    const preenchimentos = [null, "gray125"];
    const bordas = [false];
    const idxFonte = (e) => {
      const f = { b: !!e.b, sz: e.sz || 10, cor: e.cor || null };
      const k = JSON.stringify(f);
      let i = fontes.findIndex(x => JSON.stringify(x) === k);
      if (i < 0) { fontes.push(f); i = fontes.length - 1; }
      return i;
    };
    const idxFill = (e) => {
      if (!e.fill) return 0;
      let i = preenchimentos.indexOf(e.fill);
      if (i < 0) { preenchimentos.push(e.fill); i = preenchimentos.length - 1; }
      return i;
    };
    const idxBorda = (e) => (e.borda ? 1 : 0);
    if (true) bordas.push(true);

    const xfs = this.estilos.map(e => {
      const nf = FORMATOS[e.fmt || "geral"] || 0;
      const al = [];
      if (e.h) al.push(`horizontal="${e.h}"`);
      al.push(`vertical="${e.v || "center"}"`);
      if (e.wrap) al.push('wrapText="1"');
      return `<xf numFmtId="${nf}" fontId="${idxFonte(e)}" fillId="${idxFill(e)}" borderId="${idxBorda(e)}" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment ${al.join(" ")}/></xf>`;
    });

    const xmlFontes = fontes.map(f =>
      `<font>${f.b ? "<b/>" : ""}<sz val="${f.sz}"/>${f.cor ? `<color rgb="FF${f.cor}"/>` : ""}<name val="Calibri"/><family val="2"/></font>`).join("");
    const xmlFills = preenchimentos.map(p => {
      if (p === null) return '<fill><patternFill patternType="none"/></fill>';
      if (p === "gray125") return '<fill><patternFill patternType="gray125"/></fill>';
      return `<fill><patternFill patternType="solid"><fgColor rgb="FF${p}"/><bgColor indexed="64"/></patternFill></fill>`;
    }).join("");
    const lado = (n) => `<${n} style="thin"><color rgb="FF808080"/></${n}>`;
    const xmlBordas = bordas.map(b => b
      ? `<border>${lado("left")}${lado("right")}${lado("top")}${lado("bottom")}<diagonal/></border>`
      : "<border><left/><right/><top/><bottom/><diagonal/></border>").join("");

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="&quot;R$&quot; #,##0.00"/><numFmt numFmtId="166" formatCode="#,##0"/></numFmts>
<fonts count="${fontes.length}">${xmlFontes}</fonts>
<fills count="${preenchimentos.length}">${xmlFills}</fills>
<borders count="${bordas.length}">${xmlBordas}</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
  }

  _xmlPlanilha() {
    const linhas = new Map();
    let maxLin = 1, maxCol = 1;
    for (const c of this.celulas.values()) {
      if (!linhas.has(c.lin)) linhas.set(c.lin, []);
      linhas.get(c.lin).push(c);
      maxLin = Math.max(maxLin, c.lin); maxCol = Math.max(maxCol, c.col);
    }
    for (const l of Object.keys(this.alturas)) { if (!linhas.has(Number(l))) linhas.set(Number(l), []); maxLin = Math.max(maxLin, Number(l)); }

    const xmlLinhas = [...linhas.keys()].sort((a, b) => a - b).map(l => {
      const cels = linhas.get(l).sort((a, b) => a.col - b.col).map(c => {
        const ref = letraColuna(c.col) + c.lin;
        if (c.tipo === "txt" && !c.f) return `<c r="${ref}" s="${c.s}" t="inlineStr"><is><t xml:space="preserve">${esc(c.v)}</t></is></c>`;
        if (c.f) {
          const f = `<f>${esc(c.f)}</f>`;
          if (c.tipo === "num") return `<c r="${ref}" s="${c.s}">${f}<v>${c.v}</v></c>`;
          if (c.tipo === "txt") return `<c r="${ref}" s="${c.s}" t="str">${f}<v>${esc(c.v)}</v></c>`;
          return `<c r="${ref}" s="${c.s}">${f}</c>`;
        }
        if (c.tipo === "num") return `<c r="${ref}" s="${c.s}"><v>${c.v}</v></c>`;
        return `<c r="${ref}" s="${c.s}"/>`;
      }).join("");
      const h = this.alturas[l] ? ` ht="${this.alturas[l]}" customHeight="1"` : "";
      return `<row r="${l}"${h}>${cels}</row>`;
    }).join("");

    const cols = Object.keys(this.larguras).map(Number).sort((a, b) => a - b)
      .map(n => `<col min="${n}" max="${n}" width="${this.larguras[n]}" customWidth="1"/>`).join("");
    const merges = this.merges.length
      ? `<mergeCells count="${this.merges.length}">${this.merges.map(m => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>` : "";

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
<dimension ref="A1:${letraColuna(maxCol)}${maxLin}"/>
<sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
${cols ? `<cols>${cols}</cols>` : ""}
<sheetData>${xmlLinhas}</sheetData>
${merges}
<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>
<pageSetup paperSize="9" orientation="${this.paisagem ? "landscape" : "portrait"}" fitToWidth="1" fitToHeight="0"/>
</worksheet>`;
  }

  gerar() {
    return montarZip([
      { nome: "[Content_Types].xml", dados: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
      { nome: "_rels/.rels", dados: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
      { nome: "xl/workbook.xml", dados: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(this.nomeAba)}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
      { nome: "xl/_rels/workbook.xml.rels", dados: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
      { nome: "xl/styles.xml", dados: this._xmlEstilos() },
      { nome: "xl/worksheets/sheet1.xml", dados: this._xmlPlanilha() }
    ]);
  }
}

module.exports = { Planilha, serialData };
