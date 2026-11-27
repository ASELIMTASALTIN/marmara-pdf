import { openMupdf } from "../../core/mupdf/loader";
import type { Rect } from "../../core/annotations/types";
import { newId } from "../../core/ids";
import { defineCommand, P, UsageError, WRITES } from "../registry";
import { guardSignatures, loadPdf, outputPath, pageGeometries, pageIndex, readBytes, rectToUser, resolvePath, selectPages, writeAtomic, writePdf } from "../io";
import { searchDoc } from "../text";
import { existsSync } from "node:fs";

defineCommand({
  name: "redact",
  group: "Redact & security",
  summary: "Permanently remove text, images and graphics under found phrases and/or areas (true redaction, not a black box overlay).",
  details: "The content under each area is deleted from the file. The result reports how many matches of each phrase are still findable afterwards (should be 0).",
  params: {
    input: P.input,
    find: { type: "string[]", description: "Phrase to redact everywhere (repeatable)." },
    match_case: { type: "boolean", description: "Case-sensitive --find." },
    whole_word: { type: "boolean", description: "Whole words only." },
    pages: { ...P.pages, description: "Pages searched with --find (default all)." },
    area: { type: "string[]", description: 'Area "PAGE:x0,y0,x1,y1" in points from the top-left (repeatable), e.g. "1:72,90,300,110".' },
    black_boxes: { type: "boolean", description: "Draw black boxes where content was removed (default true).", default: true },
    remove_metadata: { type: "boolean", description: "Also clear title, author, subject, keywords and XMP metadata." },
    ...WRITES,
    break_signatures: P.breakSignatures,
  },
  examples: ['redact contract.pdf --find "12345678901" --find "Ayşe Yılmaz"', 'redact scan.pdf --area "1:50,700,300,740"'],
  async run(a, ctx) {
    const input = await loadPdf(ctx, a.input as string, a.password as string);
    guardSignatures(input, a);
    const finds = (a.find as string[] | undefined) ?? [];
    const areasArg = (a.area as string[] | undefined) ?? [];
    if (!finds.length && !areasArg.length && !a.remove_metadata) throw new UsageError("Give --find and/or --area (or --remove-metadata).");
    const geoms = await pageGeometries(input.bytes);
    const byPage = new Map<number, Rect[]>();
    const add = (p: number, r: Rect) => byPage.set(p, [...(byPage.get(p) ?? []), r]);
    const found: Record<string, number> = {};
    const opts = { matchCase: !!a.match_case, wholeWord: !!a.whole_word };
    const pages = selectPages(a.pages, geoms.length);
    if (finds.length) {
      const { doc } = await openMupdf(input.bytes);
      try {
        for (const f of finds) {
          const { matches, total } = searchDoc(doc, f, pages, opts);
          found[f] = total;
          for (const m of matches) for (const r of m.rects) add(m.page - 1, rectToUser(geoms[m.page - 1], [r[0] - 0.5, r[1] - 0.5, r[2] + 0.5, r[3] + 0.5]));
        }
      } finally {
        doc.destroy();
      }
    }
    for (const s of areasArg) {
      const m = /^\s*(\d+)\s*:\s*(.+)$/.exec(s);
      const nums = m ? m[2].split(/[\s,]+/).map(Number) : [];
      if (!m || nums.length !== 4 || nums.some((x) => !Number.isFinite(x))) throw new UsageError(`Bad --area "${s}". Expected "PAGE:x0,y0,x1,y1".`);
      const p = pageIndex(m[1], geoms.length);
      add(p, rectToUser(geoms[p], nums));
    }
    const areas = [...byPage].map(([pageIndex, rects]) => ({ pageIndex, rects }));
    if (!areas.length && !a.remove_metadata) return { output: null, redacted_areas: 0, found, message: "Nothing to redact: the phrases were not found." };
    const { applyRedactions } = await import("../../core/redact/redact");
    const out = await applyRedactions(input.bytes, areas, { blackBoxes: a.black_boxes as boolean, removeMetadata: !!a.remove_metadata });
    const remaining: Record<string, number> = {};
    if (finds.length) {
      const { doc } = await openMupdf(out);
      try {
        for (const f of finds) remaining[f] = searchDoc(doc, f, pages, opts).total;
      } finally {
        doc.destroy();
      }
    }
    return {
      output: await writePdf(ctx, a, input, out, "redacted"),
      redacted_areas: areas.reduce((n, x) => n + x.rects.length, 0),
      pages: areas.map((x) => x.pageIndex + 1),
      found: finds.length ? found : undefined,
      still_findable: finds.length ? remaining : undefined,
      metadata_removed: !!a.remove_metadata || undefined,
    };
  },
});

defineCommand({
  name: "encrypt",
  group: "Redact & security",
  summary: "Password-protect a PDF (AES-256).",
  params: {
    input: P.input,
    user_password: { type: "string", description: "Password needed to open the file.", required: true },
    owner_password: { type: "string", description: "Owner (permissions) password (default: same as user password)." },
    output: P.output,
    overwrite: P.overwrite,
    password: { type: "string", description: "Current password, if the input is already encrypted." },
    break_signatures: P.breakSignatures,
  },
  async run(a, ctx) {
    const input = await loadPdf(ctx, a.input as string, a.password as string);
    guardSignatures(input, a);
    if (!a.user_password) throw new UsageError("--user-password must not be empty.");
    const { encryptPdf } = await import("../../core/mupdf/security");
    const out = await encryptPdf(input.bytes, a.user_password as string, (a.owner_password as string) || (a.user_password as string));
    const path = outputPath(ctx, a, input.path, "protected", ".pdf");
    writeAtomic(path, out);
    return { output: path, encryption: "AES-256" };
  },
});

defineCommand({
  name: "decrypt",
  group: "Redact & security",
  summary: "Remove the password from a PDF (the correct password is required).",
  params: { input: P.input, password: { ...P.password, description: "Current password." }, output: P.output, overwrite: P.overwrite },
  async run(a, ctx) {
    const input = await loadPdf(ctx, a.input as string, a.password as string);
    const path = outputPath(ctx, a, input.path, "unlocked", ".pdf");
    writeAtomic(path, input.bytes);
    return { output: path, was_encrypted: !!input.password };
  },
});

// ---------- digital signatures ----------

defineCommand({
  name: "create-id",
  group: "Signatures",
  summary: "Create a self-signed digital ID (RSA-2048 certificate + key) as a password-protected .pfx file.",
  params: {
    name: { type: "string", description: "Signer name (certificate common name).", required: true },
    email: { type: "string", description: "E-mail address." },
    organization: { type: "string", description: "Organisation." },
    country: { type: "string", description: "Two-letter country code, e.g. TR." },
    id_password: { type: "string", description: "Password protecting the .pfx file.", required: true },
    years: { type: "integer", description: "Validity in years (default 5).", default: 5 },
    output: { type: "path", short: "o", description: "Where to write the .pfx file.", required: true },
    overwrite: P.overwrite,
  },
  examples: ['create-id --name "Ayşe Yılmaz" --email ayse@example.com --id-password "…" -o ayse.pfx'],
  async run(a, ctx) {
    const path = resolvePath(ctx, a.output as string);
    if (existsSync(path) && !a.overwrite) throw new UsageError(`${path} already exists. Pass --overwrite to replace it.`);
    if (String(a.id_password).length < 4) throw new UsageError("--id-password must have at least 4 characters.");
    const { createSelfSignedId, digitalIdBytes } = await import("../../core/signature/identity");
    const id = await createSelfSignedId({ name: a.name as string, email: a.email as string, organization: a.organization as string, country: a.country as string }, a.id_password as string, newId(), a.years as number);
    writeAtomic(path, digitalIdBytes(id));
    return { output: path, name: id.name, email: id.email, issuer: id.issuer, self_signed: id.selfSigned, valid_from: id.notBefore, valid_to: id.notAfter, fingerprint_sha256: id.fingerprint };
  },
});

defineCommand({
  name: "sign",
  group: "Signatures",
  summary: "Digitally sign a PDF with a .pfx/.p12 ID (PAdES, SHA-256), visibly in a rectangle or invisibly.",
  details: "Signing appends an incremental update, so earlier signatures stay valid. Self-signed IDs verify as intact but 'identity not verified'.",
  params: {
    input: P.input,
    id: { type: "path", description: "Digital ID file (.pfx or .p12).", required: true },
    id_password: { type: "string", description: "Password of the digital ID.", required: true },
    page: { type: "integer", description: "Page for the visible signature (default 1).", default: 1 },
    rect: { type: "rect", description: 'Visible signature box "x0,y0,x1,y1" (omit for an invisible signature).' },
    image: { type: "path", description: "Handwritten signature image (PNG/JPEG) shown in the box." },
    reason: { type: "string", description: "Reason, e.g. Onaylıyorum." },
    location: { type: "string", description: "Location, e.g. İstanbul." },
    contact: { type: "string", description: "Contact info." },
    output: P.output,
    overwrite: P.overwrite,
  },
  examples: ['sign contract.pdf --id ayse.pfx --id-password "…" --page 3 --rect 350,700,550,760 --reason Onaylıyorum'],
  async run(a, ctx) {
    const input = await loadPdf(ctx, a.input as string);
    if (input.password) throw new UsageError("Remove the password (decrypt) before signing.");
    const geoms = await pageGeometries(input.bytes);
    const p = pageIndex(a.page, geoms.length);
    const { openPkcs12 } = await import("../../core/signature/identity");
    let id;
    try {
      id = openPkcs12(readBytes(ctx, a.id as string), a.id_password as string);
    } catch (e) {
      throw new UsageError(`Could not open the digital ID: ${(e as Error).message}`);
    }
    const { signPdf } = await import("../../core/signature/sign");
    const out = await signPdf(input.bytes, id, {
      pageIndex: p,
      rect: a.rect ? rectToUser(geoms[p], a.rect as number[]) : null,
      reason: a.reason as string | undefined,
      location: a.location as string | undefined,
      contact: a.contact as string | undefined,
      image: a.image ? readBytes(ctx, a.image as string) : undefined,
    });
    const path = await writePdf(ctx, a, input, out, "signed");
    const { verifySignatures } = await import("../../core/signature/verify");
    const sigs = await verifySignatures(out);
    const last = sigs[sigs.length - 1];
    return { output: path, signatures: sigs.length, status: last?.status, summary: last?.summary };
  },
});

defineCommand({
  name: "verify",
  group: "Signatures",
  summary: "Verify the digital signatures: integrity, cryptographic validity, whether the file changed after signing, signer and time.",
  readOnly: true,
  params: { input: P.input, password: P.password },
  async run(a, ctx) {
    const input = await loadPdf(ctx, a.input as string, a.password as string);
    const { verifySignatures } = await import("../../core/signature/verify");
    const sigs = await verifySignatures(input.bytes);
    return {
      count: sigs.length,
      signatures: sigs.map((s) => ({
        field: s.field,
        status: s.status,
        summary: s.summary,
        signer: s.cms.signer ?? s.name,
        issuer: s.cms.issuer,
        self_signed: s.cms.selfSigned,
        time: s.cms.signingTime?.toISOString?.() ?? s.time,
        reason: s.reason,
        location: s.location,
        page: s.page || undefined,
        integrity: s.cms.integrity,
        signature_valid: s.cms.signatureValid,
        covers_whole_file: s.coversWholeFile,
        digest: s.cms.digestAlgorithm,
        error: s.cms.error,
      })),
    };
  },
});
