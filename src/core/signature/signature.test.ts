import { describe, expect, it } from "vitest";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { PDFDocument, StandardFonts } from "pdf-lib";
import * as mupdf from "mupdf";
import { certField, createSelfSignedId, digitalIdBytes, importDigitalId, unlockDigitalId } from "./identity";
import { signPdf } from "./sign";
import { verifySignatures } from "./verify";

async function samplePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText("Contract between Marmara Ltd and the customer.", { x: 60, y: 760, size: 14, font });
  doc.addPage([595, 842]);
  return doc.save();
}

const OPENSSL = ["C:/Program Files/Git/usr/bin/openssl.exe", "C:/Program Files/Git/mingw64/bin/openssl.exe"].find((p) => existsSync(p));

describe("digital signatures", () => {
  it("creates, imports and unlocks a self-signed digital ID", async () => {
    const stored = await createSelfSignedId({ name: "Ayşe Yılmaz", email: "ayse@example.com", organization: "Marmara" }, "secret123", "id1");
    expect(stored.name).toBe("Ayşe Yılmaz");
    expect(stored.selfSigned).toBe(true);
    const unlocked = unlockDigitalId(stored, "secret123");
    expect(certField(unlocked.cert, "subject", "CN")).toBe("Ayşe Yılmaz");
    expect(() => unlockDigitalId(stored, "wrong")).toThrow(/password/i);
    // round trip through a .pfx file
    const again = importDigitalId(digitalIdBytes(stored), "secret123", "id2");
    expect(again.fingerprint).toBe(stored.fingerprint);
  }, 30000);

  it("signs visibly and verifies; detects tampering; supports a second signature", async () => {
    const stored = await createSelfSignedId({ name: "Ayşe Yılmaz" }, "secret123", "id1");
    const id = unlockDigitalId(stored, "secret123");
    const original = await samplePdf();
    const signed = await signPdf(original, id, { pageIndex: 0, rect: [350, 60, 550, 120], reason: "Approved", location: "İstanbul" });

    // earlier bytes are untouched (incremental update)
    expect(signed.subarray(0, original.length)).toEqual(original);

    let sigs = await verifySignatures(signed);
    expect(sigs).toHaveLength(1);
    expect(sigs[0].cms.integrity).toBe(true);
    expect(sigs[0].cms.signatureValid).toBe(true);
    expect(sigs[0].coversWholeFile).toBe(true);
    expect(sigs[0].status).toBe("unknown-identity"); // valid, self-signed
    expect(sigs[0].reason).toBe("Approved");
    expect(sigs[0].location).toBe("İstanbul");
    expect(sigs[0].page).toBe(1);
    expect(sigs[0].cms.signer).toBe("Ayşe Yılmaz");
    expect(sigs[0].name).toBe("Ayşe Yılmaz");

    // the widget has an appearance and the file opens fine
    const doc = mupdf.Document.openDocument(signed, "application/pdf").asPDF()!;
    const w = (doc.loadPage(0) as mupdf.PDFPage).getWidgets();
    expect(w.some((x) => x.getFieldType() === "signature")).toBe(true);
    doc.destroy();

    // tamper with a byte inside the signed range
    const tampered = signed.slice();
    const pos = tampered.indexOf(0x43); // first 'C'
    tampered[pos] = 0x44;
    sigs = await verifySignatures(tampered);
    expect(sigs[0].status).toBe("invalid");

    // second (invisible) signature keeps the first one valid but marks it as followed by changes
    const twice = await signPdf(signed, id, { pageIndex: 1, rect: null, reason: "Counter-signed" });
    sigs = await verifySignatures(twice);
    expect(sigs).toHaveLength(2);
    expect(sigs.every((s) => s.cms.integrity && s.cms.signatureValid)).toBe(true);
    expect(sigs.find((s) => s.reason === "Approved")!.status).toBe("valid-modified");
    expect(sigs.find((s) => s.reason === "Counter-signed")!.coversWholeFile).toBe(true);

    mkdirSync(".playwright-mcp", { recursive: true });
    writeFileSync(".playwright-mcp/signed.pdf", twice);
  }, 60000);

  it("keeps signatures valid when annotations and form values are saved incrementally", async () => {
    const { bakeAnnotations } = await import("../annotations/bake");
    const stored = await createSelfSignedId({ name: "Signer" }, "secret123", "id1");
    const signed = await signPdf(await samplePdf(), unlockDigitalId(stored, "secret123"), { pageIndex: 0, rect: [350, 60, 550, 120] });
    const annotated = await bakeAnnotations(signed, ["a", "b"], {
      a: [{ id: "n1", type: "note", point: [100, 700], text: "Checked", color: "#ffd02f", opacity: 1, createdAt: Date.now() }],
    }, true);
    expect(annotated.subarray(0, signed.length)).toEqual(signed);
    const sigs = await verifySignatures(annotated);
    expect(sigs[0].cms.integrity).toBe(true);
    expect(sigs[0].cms.signatureValid).toBe(true);
    expect(sigs[0].status).toBe("valid-modified");
  }, 60000);

  it.skipIf(!OPENSSL)("produces CMS that OpenSSL verifies", async () => {
    const stored = await createSelfSignedId({ name: "OpenSSL Check" }, "secret123", "id1");
    const id = unlockDigitalId(stored, "secret123");
    const signed = await signPdf(await samplePdf(), id, { pageIndex: 0, rect: null });
    // extract ByteRange + Contents
    const text = new TextDecoder("latin1").decode(signed);
    const m = /\/ByteRange\s*\[(\d+) (\d+) (\d+) (\d+)\s*\]/.exec(text)!;
    const [, , b, c, d] = m.map(Number);
    const content = new Uint8Array(b + d);
    content.set(signed.subarray(0, b), 0);
    content.set(signed.subarray(c, c + d), b);
    let hex = text.slice(b + 1, c - 1).replace(/(00)+$/, "");
    if (hex.length % 2) hex += "0";
    const cms = Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
    mkdirSync(".playwright-mcp", { recursive: true });
    writeFileSync(".playwright-mcp/sig.der", cms);
    writeFileSync(".playwright-mcp/sig-content.bin", content);
    const out = execFileSync(OPENSSL!, ["cms", "-verify", "-inform", "DER", "-in", ".playwright-mcp/sig.der", "-content", ".playwright-mcp/sig-content.bin", "-binary", "-noverify", "-out", ".playwright-mcp/sig-out.bin"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(out).toBeDefined(); // exits 0 on success ("Verification successful" on stderr)
  }, 60000);
});
