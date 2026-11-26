import { strToU8, zipSync } from "fflate";

/** Minimal, dependency-free Office Open XML (.docx) writer. */

export interface DocxRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  /** Font size in points. */
  size?: number;
  font?: string;
  color?: string; // rrggbb
}

export type DocxItem =
  | { kind: "p"; runs: DocxRun[]; align?: "left" | "center" | "right" | "both"; spaceAfterPt?: number; indentPt?: number }
  | { kind: "img"; png: Uint8Array; widthPt: number; heightPt: number; align?: "left" | "center" };

export interface DocxPage {
  widthPt: number;
  heightPt: number;
  items: DocxItem[];
}

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export function xmlEscape(s: string): string {
  return s
    // XML 1.0 forbids most control characters.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const twips = (pt: number) => Math.round(pt * 20);
const emu = (pt: number) => Math.round(pt * 12700);

function runXml(r: DocxRun): string {
  const props: string[] = [];
  if (r.font) {
    const f = xmlEscape(r.font);
    props.push(`<w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:cs="${f}" w:eastAsia="${f}"/>`);
  }
  if (r.bold) props.push("<w:b/><w:bCs/>");
  if (r.italic) props.push("<w:i/><w:iCs/>");
  if (r.color && /^[0-9a-fA-F]{6}$/.test(r.color) && r.color.toLowerCase() !== "000000") props.push(`<w:color w:val="${r.color}"/>`);
  if (r.size) props.push(`<w:sz w:val="${Math.round(r.size * 2)}"/><w:szCs w:val="${Math.round(r.size * 2)}"/>`);
  return `<w:r>${props.length ? `<w:rPr>${props.join("")}</w:rPr>` : ""}<w:t xml:space="preserve">${xmlEscape(r.text)}</w:t></w:r>`;
}

function imageXml(relId: string, id: number, wPt: number, hPt: number): string {
  const cx = emu(wPt);
  const cy = emu(hPt);
  return (
    `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${id}"/>` +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="image${id}.png"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
  );
}

/** Builds a .docx file. Each PDF page becomes a section with the same page size. */
export function buildDocx(pages: DocxPage[], title = "Document"): Uint8Array {
  const media: Record<string, Uint8Array> = {};
  const rels: string[] = [`<Relationship Id="rIdStyles" Type="${R}/styles" Target="styles.xml"/>`];
  let imgId = 0;
  const body: string[] = [];

  pages.forEach((page, pi) => {
    const margin = 36; // 0.5in
    const maxImgW = page.widthPt - 2 * margin;
    for (const it of page.items) {
      if (it.kind === "p") {
        const pPr: string[] = [];
        if (it.align && it.align !== "left") pPr.push(`<w:jc w:val="${it.align}"/>`);
        pPr.push(`<w:spacing w:before="0" w:after="${twips(it.spaceAfterPt ?? 4)}"/>`);
        if (it.indentPt && it.indentPt > 1) pPr.push(`<w:ind w:left="${twips(it.indentPt)}"/>`);
        body.push(`<w:p><w:pPr>${pPr.join("")}</w:pPr>${it.runs.map(runXml).join("")}</w:p>`);
      } else {
        imgId++;
        const name = `image${imgId}.png`;
        media[`word/media/${name}`] = it.png;
        const relId = `rIdImg${imgId}`;
        rels.push(`<Relationship Id="${relId}" Type="${R}/image" Target="media/${name}"/>`);
        const scale = Math.min(1, maxImgW / it.widthPt);
        body.push(
          `<w:p><w:pPr>${it.align === "center" ? '<w:jc w:val="center"/>' : ""}<w:spacing w:after="80"/></w:pPr>${imageXml(relId, imgId, it.widthPt * scale, it.heightPt * scale)}</w:p>`,
        );
      }
    }
    const sect = `<w:sectPr><w:pgSz w:w="${twips(page.widthPt)}" w:h="${twips(page.heightPt)}"${page.widthPt > page.heightPt ? ' w:orient="landscape"' : ""}/><w:pgMar w:top="${twips(margin)}" w:right="${twips(margin)}" w:bottom="${twips(margin)}" w:left="${twips(margin)}" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`;
    if (pi < pages.length - 1) body.push(`<w:p><w:pPr>${sect}</w:pPr></w:p>`);
    else body.push(sect);
  });

  const document =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
    `<w:body>${body.join("")}</w:body></w:document>`;

  const styles =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:lang w:val="tr-TR"/></w:rPr></w:rPrDefault>` +
    `<w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
    `</Types>`;

  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const core =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${xmlEscape(title)}</dc:title><dc:creator>Marmara PDF</dc:creator>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created></cp:coreProperties>`;

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/>` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    ),
    "docProps/core.xml": strToU8(core),
    "word/document.xml": strToU8(document),
    "word/styles.xml": strToU8(styles),
    "word/_rels/document.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`,
    ),
    ...media,
  };
  return zipSync(files, { level: 6 });
}
