// Gera a planilha da CI (Comunicação Interna) a partir do modelo oficial (ci_modelo_b64.js, layout novo):
// mantém logos, 1ª e 2ª via, fórmulas e formatação, e só troca os valores das células da 1ª via
// (a 2ª via continua automática: fórmulas com o valor já calculado).
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
const desesc = (s) => String(s).replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// Troca o valor de uma célula (que já existe no modelo), mantendo o estilo. Se a célula tem fórmula,
// a fórmula fica e só o valor calculado (cache) é atualizado; com "tirarFormula" a fórmula sai.
function setCel(xml, ref, valor, tirarFormula) {
  const re = new RegExp(`<c r="${ref}"((?: [a-zA-Z:]+="[^"]*")*)\\s*(?:/>|>([\\s\\S]*?)</c>)`);
  const ex = re.exec(xml);
  if (!ex) return xml;
  const sm = /\ss="(\d+)"/.exec(ex[1]);
  const atr = sm ? ` s="${sm[1]}"` : "";
  const fm = !tirarFormula && ex[2] ? /<f[^>]*?(?:\/>|>[\s\S]*?<\/f>)/.exec(ex[2]) : null;
  const vazio = valor === "" || valor === null || valor === undefined;
  let novo;
  if (fm) {
    if (typeof valor === "number") novo = `<c r="${ref}"${atr}>${fm[0]}<v>${valor}</v></c>`;
    else novo = `<c r="${ref}"${atr} t="str">${fm[0]}<v>${vazio ? "" : esc(valor)}</v></c>`;
  } else if (vazio) novo = `<c r="${ref}"${atr}/>`;
  else if (typeof valor === "number") novo = `<c r="${ref}"${atr}><v>${valor}</v></c>`;
  else novo = `<c r="${ref}"${atr} t="inlineStr"><is><t xml:space="preserve">${esc(valor)}</t></is></c>`;
  return xml.replace(re, () => novo);
}

const serial = (iso) => (iso ? Math.round((Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 86400000) : "");
const br = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "");

const PARA_PADRAO = "ADELITA ARAUJO";

// sol: solicitação (sol.dados já validado, sol.promotor_nome); extra: { numero, emissao, valor, hoje, aprovador }
function planilhaCiModelo(sol, extra, emitente) {
  const d = sol.dados || {};
  const e = d.entrega || {};
  const arqs = lerZip(Buffer.from(MODELO_B64, "base64"));
  const iSheet = arqs.findIndex(a => a.nome === "xl/worksheets/sheet1.xml");
  let xml = arqs[iSheet].dados.toString("utf8");

  const periodo = d.periodoIni ? `${br(d.periodoIni)} a ${br(d.periodoFim || d.periodoIni)}` : "";
  const valor = Number(extra.valor != null && extra.valor !== "" ? extra.valor : d.valor) || 0;
  // 1ª via: o consultor/gestor preenche. Os vermelhos do modelo: Ação, Data da execução, Nome fantasia, Razão social, Cidade, Consultor, Tipo de acordo e Valor.
  const dados = {
    H3: String(extra.numero || ""), C6: emitente, C7: d.para || PARA_PADRAO,
    H6: serial(extra.emissao || extra.hoje), H7: serial(d.execucao), C8: d.acao || "",
    C11: d.brinde || "",
    D12: d.nomeFantasia || "", D13: d.cliente || "", D14: d.cidadeLoja || "",
    D15: d.consultor || String(sol.promotor_nome || ""), D16: periodo,
    B20: d.tipoAcordo || "",
    C23: d.cartaoPresente ? "SIM" : "NÃO", E23: valor, G23: d.observacao || "", C24: d.titular || "", H24: d.cpfCnpj || "",
    C27: e.endereco || "", H27: e.numero || "", C28: e.bairro || "", G28: e.cidade || "", C29: e.recebedor || "", H29: e.telefone || "",
    D31: String(d.centroCusto || "PECUÁRIA").toUpperCase(), H31: emitente
  };
  Object.keys(dados).forEach(ref => { xml = setCel(xml, ref, dados[ref], ref === "H6"); });

  // Campos vermelhos do modelo = "preencher aqui". Depois de preenchidos ficam num rosa claro (o texto
  // fica legível); o que continuar vazio segue vermelho.
  const iEst = arqs.findIndex(a => a.nome === "xl/styles.xml");
  let est = arqs[iEst].dados.toString("utf8");
  const vermelhos = ["H7", "C8", "D12", "D14", "D15", "B20", "E23"];
  const mapaEstilo = {};
  const mf = /<fills count="(\d+)">/.exec(est), mx = /<cellXfs count="(\d+)">/.exec(est);
  if (mf && mx) {
    const idFill = Number(mf[1]);
    let nx = Number(mx[1]);
    const xfs = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(est)[1].match(/<xf [^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g) || [];
    const novos = [];
    vermelhos.forEach(ref => {
      const sm = new RegExp(`<c r="${ref}"[^>]*? s="(\\d+)"`).exec(xml);
      if (!sm || mapaEstilo[sm[1]] !== undefined) return;
      const xf = xfs[Number(sm[1])];
      if (!xf || !/fillId="\d+"/.test(xf)) return;
      mapaEstilo[sm[1]] = nx++;
      novos.push(xf.replace(/fillId="\d+"/, `fillId="${idFill}"`));
    });
    if (novos.length) {
      est = est.replace(mf[0], `<fills count="${idFill + 1}">`).replace("</fills>", '<fill><patternFill patternType="solid"><fgColor rgb="FFFDE3E3"/><bgColor indexed="64"/></patternFill></fill></fills>')
        .replace(mx[0], `<cellXfs count="${nx}">`).replace("</cellXfs>", novos.join("") + "</cellXfs>");
      arqs[iEst].dados = Buffer.from(est, "utf8");
      vermelhos.forEach(ref => {
        const v = dados[ref];
        if (v === "" || v === null || v === undefined || v === 0) return;
        xml = xml.replace(new RegExp(`(<c r="${ref}"[^>]*? s=")(\\d+)(")`), (t, a, n, c) => (mapaEstilo[n] !== undefined ? a + mapaEstilo[n] + c : t));
      });
    }
  }

  // 2ª via: fórmulas do modelo (=SE(campo="";"";campo)) com o valor já calculado, para abrir certo em qualquer leitor.
  const calc = {};
  const valorDe = (ref) => (ref in calc ? calc[ref] : ref in dados ? dados[ref] : "");
  const reCel = /<c r="([A-Z]+\d+)"((?: [a-zA-Z:]+="[^"]*")*)>(<f[^>]*>([^<]*)<\/f>)<v[^>]*?(?:\/>|>[^<]*<\/v>)<\/c>/g;
  const refazer = (valorDaFormula) => {
    xml = xml.replace(reCel, (todo, ref, atr, f, formula) => {
      const val = valorDaFormula(ref, desesc(formula));
      if (val === undefined) return todo;
      calc[ref] = val;
      const atr2 = atr.replace(/\st="[^"]*"/, "");
      if (typeof val === "number") return `<c r="${ref}"${atr2}>${f}<v>${val}</v></c>`;
      return `<c r="${ref}"${atr2} t="str">${f}<v>${esc(val)}</v></c>`;
    });
  };
  refazer((ref, fx) => { const m = /^IF\(([A-Z]+\d+)="","",\1\)$/.exec(fx); return m ? valorDe(m[1]) : undefined; });
  refazer((ref, fx) => { const m = /^LEN\(([A-Z]+\d+)\)&" \/ 1000 caracteres"$/.exec(fx); return m ? `${String(valorDe(m[1])).length} / 1000 caracteres` : undefined; });
  arqs[iSheet].dados = Buffer.from(xml, "utf8");

  // sem cadeia de cálculo (a de H6 deixou de existir); o Excel recalcula ao abrir
  const saida = arqs.filter(a => a.nome !== "xl/calcChain.xml").map(a => {
    if (a.nome === "[Content_Types].xml") a.dados = Buffer.from(a.dados.toString("utf8").replace(/<Override[^>]*calcChain[^>]*\/>/, ""), "utf8");
    if (a.nome === "xl/_rels/workbook.xml.rels") a.dados = Buffer.from(a.dados.toString("utf8").replace(/<Relationship [^>]*calcChain[^>]*\/>/, ""), "utf8");
    if (a.nome === "xl/workbook.xml") a.dados = Buffer.from(a.dados.toString("utf8").replace(/<calcPr[^>]*\/>/, '<calcPr calcId="191029" fullCalcOnLoad="1"/>'), "utf8");
    return a;
  });
  return montarZip(saida);
}

module.exports = { planilhaCiModelo };
