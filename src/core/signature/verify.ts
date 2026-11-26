import { openMupdf } from "../mupdf/loader";
import { verifyCms, type CmsVerification } from "./cms";

type PDFObject = import("mupdf").PDFObject;
const R = (o: PDFObject): PDFObject => (o.isNull() ? o : o.resolve());

export type SignatureStatus = "valid" | "valid-modified" | "unknown-identity" | "invalid" | "unsupported";

export interface SignatureInfo {
  field: string;
  name?: string;
  reason?: string;
  location?: string;
  /** Signing time from the signature (or /M). */
  time?: string;
  subFilter?: string;
  /** Byte range covers the whole file (no changes after signing). */
  coversWholeFile: boolean;
  /** 1-based page of the widget (0 = unknown). */
  page: number;
  cms: CmsVerification;
  status: SignatureStatus;
  summary: string;
}

function str(o: PDFObject): string | undefined {
  const r = R(o);
  return r.isString() ? r.asString() : undefined;
}

function collectSigFields(field: PDFObject, prefix: string, out: { name: string; obj: PDFObject }[], depth = 0) {
  if (depth > 20) return;
  const f = R(field);
  const t = str(f.get("T"));
  const name = t ? (prefix ? `${prefix}.${t}` : t) : prefix;
  const kids = R(f.get("Kids"));
  const ft = R(f.get("FT"));
  if (ft.isName() && ft.asName() === "Sig" && !R(f.get("V")).isNull()) out.push({ name, obj: field });
  if (kids.isArray()) for (let i = 0; i < kids.length; i++) collectSigFields(kids.get(i), name, out, depth + 1);
}

/** Lists and verifies all digital signatures in a PDF. */
export async function verifySignatures(bytes: Uint8Array): Promise<SignatureInfo[]> {
  const { doc } = await openMupdf(bytes);
  try {
    const root = R(doc.getTrailer().get("Root"));
    const fields = R(R(root.get("AcroForm")).get("Fields"));
    if (!fields.isArray()) return [];
    const sigs: { name: string; obj: PDFObject }[] = [];
    for (let i = 0; i < fields.length; i++) collectSigFields(fields.get(i), "", sigs);

    // Map widget objects to page numbers.
    const pageOf = new Map<number, number>();
    for (let p = 0; p < doc.countPages(); p++) {
      const annots = R((doc.loadPage(p) as import("mupdf").PDFPage).getObject().get("Annots"));
      if (annots.isArray()) for (let k = 0; k < annots.length; k++) {
        const a = annots.get(k);
        if (a.isIndirect()) pageOf.set(a.asIndirect(), p + 1);
      }
    }

    const out: SignatureInfo[] = [];
    for (const s of sigs) {
      const f = R(s.obj);
      const v = R(f.get("V"));
      const br = R(v.get("ByteRange"));
      const contents = R(v.get("Contents"));
      const subFilter = R(v.get("SubFilter")).isName() ? R(v.get("SubFilter")).asName() : undefined;
      const base = {
        field: s.name,
        name: str(v.get("Name")),
        reason: str(v.get("Reason")),
        location: str(v.get("Location")),
        time: str(v.get("M")),
        subFilter,
        page: s.obj.isIndirect() ? pageOf.get(s.obj.asIndirect()) ?? 0 : 0,
      };
      if (!br.isArray() || br.length !== 4 || !contents.isString()) {
        out.push({ ...base, coversWholeFile: false, cms: { integrity: false, signatureValid: false, error: "Malformed signature" }, status: "invalid", summary: "The signature is damaged." });
        continue;
      }
      const [a, b, c, d] = [0, 1, 2, 3].map((k) => br.get(k).asNumber());
      if (a !== 0 || b < 0 || c < b || c + d > bytes.length) {
        out.push({ ...base, coversWholeFile: false, cms: { integrity: false, signatureValid: false, error: "Byte range outside the file" }, status: "invalid", summary: "The signature's byte range is invalid." });
        continue;
      }
      const signed = new Uint8Array(b + d);
      signed.set(bytes.subarray(0, b), 0);
      signed.set(bytes.subarray(c, c + d), b);
      const coversWholeFile = c + d === bytes.length;
      if (subFilter === "ETSI.RFC3161") {
        out.push({ ...base, coversWholeFile, cms: { integrity: true, signatureValid: null }, status: "unsupported", summary: "Document timestamp (not checked)." });
        continue;
      }
      const cms = verifyCms(contents.asByteString(), signed);
      let status: SignatureStatus;
      let summary: string;
      if (!cms.integrity || cms.signatureValid === false) {
        status = "invalid";
        summary = cms.error ?? "The signed content has been altered or the signature is invalid.";
      } else if (cms.signatureValid === null) {
        status = "unsupported";
        summary = cms.error ?? "The signature algorithm is not supported; the content digest matches.";
      } else if (!coversWholeFile) {
        status = "valid-modified";
        summary = "The signature is valid, but the document was changed after signing (e.g. another signature or annotations were added).";
      } else if (cms.selfSigned) {
        status = "unknown-identity";
        summary = "The document has not been changed since it was signed. The signer's identity is not verified (self-signed certificate).";
      } else {
        status = "unknown-identity";
        summary = `The document has not been changed since it was signed. Certificate issued by ${cms.issuer}; its trust chain is not checked against a trusted root.`;
      }
      out.push({ ...base, coversWholeFile, cms, status, summary });
    }
    return out;
  } finally {
    doc.destroy();
  }
}

/** Number of signature fields that carry a signature (cheap check). */
export async function countSignatures(bytes: Uint8Array): Promise<number> {
  return (await verifySignatures(bytes)).length;
}
