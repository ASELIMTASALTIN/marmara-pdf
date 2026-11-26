import { openMupdf, saveMupdf } from "../mupdf/loader";

type PDFObject = import("mupdf").PDFObject;
type MDoc = import("mupdf").PDFDocument;
const R = (o: PDFObject): PDFObject => (o.isNull() ? o : o.resolve());
/** Null-safe dictionary lookup (MuPDF's shared Null object has no document). */
const G = (o: PDFObject, key: string): PDFObject => (o.isNull() ? o : o.get(key));

export type CheckLevel = "pass" | "warning" | "error" | "info";
export type CheckGroup = "Accessibility" | "Archiving (PDF/A)" | "Print & general";

export interface CheckItem {
  id: string;
  group: CheckGroup;
  level: CheckLevel;
  title: string;
  detail?: string;
  /** Automatic fix available via fixDocument(). */
  fixable?: boolean;
}

export interface CheckReport {
  version: string;
  pages: number;
  items: CheckItem[];
  fonts: { name: string; embedded: boolean; type: string }[];
}

function str(o: PDFObject): string | undefined {
  const r = R(o);
  return r.isString() ? r.asString() : undefined;
}

function hasJavaScript(doc: MDoc): boolean {
  const root = R(doc.getTrailer().get("Root"));
  const names = R(root.get("Names"));
  if (names.isDictionary() && !R(names.get("JavaScript")).isNull()) return true;
  const oa = R(root.get("OpenAction"));
  if (oa.isDictionary() && R(oa.get("S")).isName() && R(oa.get("S")).asName() === "JavaScript") return true;
  if (!R(root.get("AA")).isNull()) return true;
  for (let i = 0; i < doc.countPages(); i++) {
    const annots = R((doc.loadPage(i) as import("mupdf").PDFPage).getObject().get("Annots"));
    if (!annots.isArray()) continue;
    for (let k = 0; k < annots.length; k++) {
      const a = R(annots.get(k));
      const act = R(a.get("A"));
      if (act.isDictionary() && R(act.get("S")).isName() && R(act.get("S")).asName() === "JavaScript") return true;
      if (!R(a.get("AA")).isNull()) return true;
    }
  }
  return false;
}

function collectFonts(doc: MDoc): CheckReport["fonts"] {
  const seen = new Map<string, CheckReport["fonts"][number]>();
  const visitRes = (res: PDFObject, depth: number) => {
    if (!res.isDictionary() || depth > 4) return;
    const fonts = R(res.get("Font"));
    if (fonts.isDictionary()) {
      const keys: string[] = [];
      fonts.forEach((_v, k) => keys.push(String(k)));
      for (const k of keys) {
        const f = R(fonts.get(k));
        const name = R(f.get("BaseFont")).isName() ? R(f.get("BaseFont")).asName() : k;
        const type = R(f.get("Subtype")).isName() ? R(f.get("Subtype")).asName() : "?";
        let desc = R(f.get("FontDescriptor"));
        if (type === "Type0") {
          const df = R(f.get("DescendantFonts"));
          desc = df.isArray() && df.length ? R(G(R(df.get(0)), "FontDescriptor")) : desc;
        }
        const embedded = type === "Type3" || (desc.isDictionary() && ["FontFile", "FontFile2", "FontFile3"].some((x) => !desc.get(x).isNull()));
        if (!seen.has(name)) seen.set(name, { name: name.replace(/^[A-Z]{6}\+/, ""), embedded, type });
      }
    }
    const xo = R(res.get("XObject"));
    if (xo.isDictionary()) {
      const keys: string[] = [];
      xo.forEach((_v, k) => keys.push(String(k)));
      for (const k of keys) {
        const x = R(xo.get(k));
        if (R(x.get("Subtype")).isName() && R(x.get("Subtype")).asName() === "Form") visitRes(R(x.get("Resources")), depth + 1);
      }
    }
  };
  for (let i = 0; i < doc.countPages(); i++) visitRes(R((doc.loadPage(i) as import("mupdf").PDFPage).getObject().getInheritable("Resources")), 0);
  return [...seen.values()];
}

/** Checks a document for accessibility, archiving (PDF/A) and general problems. */
export async function preflight(bytes: Uint8Array, encrypted = false): Promise<CheckReport> {
  const { doc } = await openMupdf(bytes);
  try {
    const items: CheckItem[] = [];
    const add = (i: CheckItem) => items.push(i);
    const root = R(doc.getTrailer().get("Root"));
    const n = doc.countPages();
    const version = (doc.getVersion() / 10).toFixed(1);

    // --- accessibility ---
    const title = doc.getMetaData("info:Title");
    add({ id: "title", group: "Accessibility", level: title ? "pass" : "error", title: title ? `Document title: “${title}”` : "The document has no title", fixable: !title });
    const lang = str(root.get("Lang"));
    add({ id: "lang", group: "Accessibility", level: lang ? "pass" : "error", title: lang ? `Document language: ${lang}` : "The document language is not set", fixable: !lang });
    const vp = R(root.get("ViewerPreferences"));
    const showTitle = vp.isDictionary() && R(vp.get("DisplayDocTitle")).isBoolean() && R(vp.get("DisplayDocTitle")).asBoolean();
    add({ id: "displaytitle", group: "Accessibility", level: showTitle ? "pass" : "warning", title: showTitle ? "Title is shown in the window title bar" : "Viewers show the file name instead of the title", fixable: !showTitle });
    const markInfo = R(root.get("MarkInfo"));
    const tagged = markInfo.isDictionary() && R(markInfo.get("Marked")).isBoolean() && R(markInfo.get("Marked")).asBoolean() && !R(root.get("StructTreeRoot")).isNull();
    add({
      id: "tagged",
      group: "Accessibility",
      level: tagged ? "pass" : "warning",
      title: tagged ? "The document is tagged (has a structure tree)" : "The document is not tagged",
      detail: tagged ? undefined : "Screen readers rely on tags for reading order, headings and tables. Re-export the document with tags from the authoring application (e.g. Word: Save as PDF with “Document structure tags”).",
    });
    let scanned = 0;
    let figuresWithoutAlt = 0;
    for (let i = 0; i < n; i++) {
      const page = doc.loadPage(i);
      const st = page.toStructuredText("preserve-images");
      const json = JSON.parse(st.asJSON()) as { blocks: { type: string; lines?: unknown[] }[] };
      st.destroy?.();
      const hasText = json.blocks.some((b) => b.type === "text" && (b.lines?.length ?? 0) > 0);
      const hasImage = json.blocks.some((b) => b.type === "image");
      if (!hasText && hasImage) scanned++;
    }
    if (tagged) {
      const walk = (o: PDFObject, depth: number) => {
        if (depth > 200) return;
        const e = R(o);
        if (e.isArray()) {
          for (let i = 0; i < e.length; i++) walk(e.get(i), depth + 1);
          return;
        }
        if (!e.isDictionary()) return;
        const s = R(e.get("S"));
        if (s.isName() && s.asName() === "Figure" && R(e.get("Alt")).isNull() && R(e.get("ActualText")).isNull()) figuresWithoutAlt++;
        const k = e.get("K");
        if (!k.isNull()) walk(k, depth + 1);
      };
      walk(R(root.get("StructTreeRoot")).get("K"), 0);
      add({
        id: "alt",
        group: "Accessibility",
        level: figuresWithoutAlt ? "warning" : "pass",
        title: figuresWithoutAlt ? `${figuresWithoutAlt} figure${figuresWithoutAlt > 1 ? "s have" : " has"} no alternative text` : "All tagged figures have alternative text",
      });
    }
    add({
      id: "scanned",
      group: "Accessibility",
      level: scanned ? "error" : "pass",
      title: scanned ? `${scanned} page${scanned > 1 ? "s are" : " is"} scanned images without text` : "All pages contain real text",
      detail: scanned ? "Run Recognise text (OCR) so the text can be read aloud, searched and copied." : undefined,
    });

    // --- archiving ---
    const fonts = collectFonts(doc);
    const notEmbedded = fonts.filter((f) => !f.embedded);
    add({
      id: "fonts",
      group: "Archiving (PDF/A)",
      level: notEmbedded.length ? "error" : "pass",
      title: notEmbedded.length ? `${notEmbedded.length} font${notEmbedded.length > 1 ? "s are" : " is"} not embedded` : `All ${fonts.length} fonts are embedded`,
      detail: notEmbedded.length ? notEmbedded.map((f) => f.name).join(", ") : undefined,
    });
    const js = hasJavaScript(doc);
    add({ id: "js", group: "Archiving (PDF/A)", level: js ? "error" : "pass", title: js ? "The document contains JavaScript" : "No JavaScript", fixable: js });
    add({ id: "encrypt", group: "Archiving (PDF/A)", level: encrypted ? "error" : "pass", title: encrypted ? "The document is password protected" : "Not encrypted" });
    const ef = R(G(R(root.get("Names")), "EmbeddedFiles"));
    add({ id: "attach", group: "Archiving (PDF/A)", level: ef.isNull() ? "pass" : "warning", title: ef.isNull() ? "No file attachments" : "The document has file attachments (not allowed in PDF/A-2b)" });
    const oi = R(root.get("OutputIntents"));
    const isPdfa = !R(root.get("Metadata")).isNull() && (() => {
      try {
        return /pdfaid:part/.test(new TextDecoder().decode(root.get("Metadata").readStream().asUint8Array()));
      } catch {
        return false;
      }
    })();
    add({
      id: "pdfa",
      group: "Archiving (PDF/A)",
      level: isPdfa && oi.isArray() ? "pass" : "info",
      title: isPdfa && oi.isArray() ? "PDF/A identification and output intent present" : "Not identified as PDF/A",
      fixable: !(isPdfa && oi.isArray()),
    });

    // --- general ---
    add({ id: "version", group: "Print & general", level: "info", title: `PDF version ${version}, ${n} page${n > 1 ? "s" : ""}` });
    const sizes = new Set<string>();
    for (let i = 0; i < n; i++) {
      const b = doc.loadPage(i).getBounds();
      sizes.add(`${Math.round(b[2] - b[0])}×${Math.round(b[3] - b[1])}`);
    }
    add({ id: "sizes", group: "Print & general", level: sizes.size > 1 ? "info" : "pass", title: sizes.size > 1 ? `Mixed page sizes (${[...sizes].join(", ")} pt)` : `All pages are ${[...sizes][0]} pt` });
    const t3 = fonts.filter((f) => f.type === "Type3").length;
    if (t3) add({ id: "type3", group: "Print & general", level: "warning", title: `${t3} Type3 (bitmap/procedural) font${t3 > 1 ? "s" : ""}`, detail: "Type3 fonts may print or zoom poorly." });

    return { version, pages: n, items, fonts };
  } finally {
    doc.destroy();
  }
}

export interface FixOptions {
  title?: string;
  lang?: string;
  displayTitle?: boolean;
  removeJavaScript?: boolean;
}

function removeJs(doc: MDoc) {
  const root = R(doc.getTrailer().get("Root"));
  const names = R(root.get("Names"));
  if (names.isDictionary()) names.delete("JavaScript");
  const oa = R(root.get("OpenAction"));
  if (oa.isDictionary() && R(oa.get("S")).isName() && R(oa.get("S")).asName() === "JavaScript") root.delete("OpenAction");
  root.delete("AA");
  for (let i = 0; i < doc.countPages(); i++) {
    const page = (doc.loadPage(i) as import("mupdf").PDFPage).getObject();
    page.delete("AA");
    const annots = R(page.get("Annots"));
    if (!annots.isArray()) continue;
    for (let k = 0; k < annots.length; k++) {
      const a = R(annots.get(k));
      const act = R(a.get("A"));
      if (act.isDictionary() && R(act.get("S")).isName() && R(act.get("S")).asName() === "JavaScript") a.delete("A");
      a.delete("AA");
    }
  }
}

/** Applies document-level fixes (metadata, language, viewer preferences, JavaScript removal). */
export async function fixDocument(bytes: Uint8Array, o: FixOptions): Promise<Uint8Array> {
  const { doc } = await openMupdf(bytes);
  try {
    const root = R(doc.getTrailer().get("Root"));
    if (o.title !== undefined) doc.setMetaData("info:Title", o.title);
    if (o.lang) root.put("Lang", doc.newString(o.lang));
    if (o.displayTitle) {
      let vp = R(root.get("ViewerPreferences"));
      if (!vp.isDictionary()) {
        vp = doc.newDictionary();
        root.put("ViewerPreferences", vp);
      }
      vp.put("DisplayDocTitle", true);
    }
    if (o.removeJavaScript) removeJs(doc);
    return saveMupdf(doc, "compress");
  } finally {
    doc.destroy();
  }
}

function xmlEsc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Converts to PDF/A-2b (best effort): adds the XMP identification and an sRGB
 * output intent, removes JavaScript, gives annotations the Print flag. Fonts
 * must already be embedded — the preflight reports remaining violations.
 */
export async function convertToPdfA(bytes: Uint8Array, iccProfile: Uint8Array, title: string, lang?: string): Promise<Uint8Array> {
  const { doc } = await openMupdf(bytes);
  try {
    const root = R(doc.getTrailer().get("Root"));
    removeJs(doc);
    // Output intent with an sRGB ICC profile.
    const iccDict = doc.newDictionary();
    iccDict.put("N", 3);
    const iccRef = doc.addStream(iccProfile, iccDict);
    const intent = doc.newDictionary();
    intent.put("Type", doc.newName("OutputIntent"));
    intent.put("S", doc.newName("GTS_PDFA1"));
    intent.put("OutputConditionIdentifier", doc.newString("sRGB IEC61966-2.1"));
    intent.put("Info", doc.newString("sRGB IEC61966-2.1"));
    intent.put("DestOutputProfile", iccRef);
    const intents = doc.newArray();
    intents.push(doc.addObject(intent));
    root.put("OutputIntents", intents);
    // Annotations must be printable and have appearances.
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i) as import("mupdf").PDFPage;
      for (const a of page.getAnnotations()) {
        if (a.getType() === "Popup") continue;
        a.setFlags((a.getFlags() | 4) & ~(1 | 2 | 32)); // Print on; Invisible/Hidden/NoView off
        a.update();
      }
    }
    if (lang) root.put("Lang", doc.newString(lang));
    doc.setMetaData("info:Title", title);
    doc.setMetaData("info:Producer", "Marmara PDF");
    const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    const xmp =
      `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n` +
      `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
      `<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">` +
      `<pdfaid:part>2</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance>` +
      `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlEsc(title)}</rdf:li></rdf:Alt></dc:title>` +
      `<dc:format>application/pdf</dc:format><pdf:Producer>Marmara PDF</pdf:Producer>` +
      `<xmp:ModifyDate>${now}</xmp:ModifyDate><xmp:MetadataDate>${now}</xmp:MetadataDate>` +
      `</rdf:Description></rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>`;
    const md = doc.newDictionary();
    md.put("Type", doc.newName("Metadata"));
    md.put("Subtype", doc.newName("XML"));
    // Metadata streams must stay uncompressed in PDF/A.
    root.put("Metadata", doc.addRawStream(new TextEncoder().encode(xmp), md));
    return saveMupdf(doc, "garbage=compact,compress-fonts,compress-images");
  } finally {
    doc.destroy();
  }
}
