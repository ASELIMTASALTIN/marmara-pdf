// End-to-end test of the command line: runs every command of the built CLI on copies of the
// test fixtures and checks the results. Usage:
//   npm run build:cli && node tests/cli/smoke.mjs [path\to\marmara.exe | path/to/marmara.mjs]
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const target = process.argv[2] ? resolve(process.argv[2]) : join(root, "dist-cli", "marmara.mjs");
const dir = mkdtempSync(join(tmpdir(), "marmara-cli-"));
for (const f of readdirSync(join(root, "test-fixtures"))) if (f.endsWith(".pdf")) copyFileSync(join(root, "test-fixtures", f), join(dir, f));

let failures = 0;
const results = [];
function cli(args, { expectFail = false } = {}) {
  const [cmd, argv] = target.endsWith(".mjs") ? [process.execPath, [target, ...args, "--compact"]] : [target, [...args, "--compact"]];
  const r = spawnSync(cmd, argv, { cwd: dir, encoding: "utf8", timeout: 300000, windowsHide: true });
  let out;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    out = { ok: false, error: `Not JSON (exit ${r.status}): ${r.stdout.slice(0, 300)} ${r.stderr.slice(0, 300)}` };
  }
  if (!!out.ok === expectFail) {
    failures++;
    console.log(`FAIL ${args.join(" ")}\n     ${JSON.stringify(out).slice(0, 400)}`);
  }
  return out;
}
function check(name, cond, info) {
  results.push(name);
  if (!cond) {
    failures++;
    console.log(`FAIL ${name}${info !== undefined ? ` — ${JSON.stringify(info).slice(0, 400)}` : ""}`);
  } else console.log(`ok   ${name}`);
}

// ---- inspect
const info = cli(["info", "sample.pdf"]);
check("info", info.page_count === 5 && info.metadata?.title === "Marmara sample", info);
const scanInfo = cli(["info", "scanned.pdf"]);
check("info detects scanned pages", scanInfo.scanned_pages?.length >= 1, scanInfo.scanned_pages);
const s = cli(["search", "sample.pdf", "lighthouse"]);
check("search", s.total === 8 && s.matches[0].rects.length === 1, s.total);
const tr = cli(["search", "sample.pdf", "istanbul"]);
check("search is Turkish-aware (istanbul → İstanbul)", tr.total >= 1, tr);
const t = cli(["text", "sample.pdf", "--pages", "2"]);
check("text", t.pages?.[0]?.text.includes("Page 2"), t.pages?.[0]?.text?.slice(0, 80));

// ---- pages
check("rotate", cli(["rotate", "sample.pdf", "--pages", "2", "--angle", "90", "-o", "rot.pdf"]).ok);
check("rotated page reported", cli(["info", "rot.pdf"]).pages?.[1]?.rotation === 90);
check("delete-pages", cli(["delete-pages", "sample.pdf", "--pages", "5", "-o", "del.pdf"]).page_count === 4);
check("merge", cli(["merge", "sample.pdf", "form.pdf", "-o", "merged.pdf"]).page_count === 6);
check("split", cli(["split", "sample.pdf", "--at", "3"]).files?.length === 2);
check("extract-pages", cli(["extract-pages", "sample.pdf", "--pages", "2-3", "-o", "ext.pdf"]).page_count === 2);
check("move-pages", cli(["move-pages", "sample.pdf", "--pages", "5", "--to", "1", "-o", "mv.pdf"]).order?.join() === "5,1,2,3,4");
check("reorder", cli(["reorder", "sample.pdf", "--order", "5,4,3,2,1", "-o", "rev.pdf"]).ok);
check("reorder applied", cli(["text", "rev.pdf", "--pages", "1"]).pages?.[0]?.text.includes("Page 5"));
check("duplicate-pages", cli(["duplicate-pages", "sample.pdf", "--pages", "1", "-o", "dup.pdf"]).page_count === 6);
check("insert-blank", cli(["insert-blank", "sample.pdf", "--at", "1", "--size", "a4", "--landscape", "-o", "blank.pdf"]).page_count === 6);
check("insert-pages", cli(["insert-pages", "sample.pdf", "--from", "form.pdf", "--at", "2", "-o", "ins.pdf"]).inserted === 1);
check("never overwrites without --overwrite", cli(["rotate", "sample.pdf", "-o", "rot.pdf"], { expectFail: true }).ok === false);

// ---- text editing
const blocks = cli(["text-blocks", "sample.pdf", "--page", "1"]);
check("text-blocks", blocks.blocks?.length > 2, blocks.blocks?.length);
const e = cli(["edit-text", "sample.pdf", "--find", "lighthouse", "--replace", "deniz feneri", "-o", "edited.pdf"]);
check("edit-text find/replace", e.edits?.length >= 4, e.edits?.length);
check("edit-text result searchable", cli(["search", "edited.pdf", "deniz feneri"]).total >= 4 && cli(["search", "edited.pdf", "lighthouse"]).total === 0);
const b = blocks.blocks?.[1];
const eb = cli(["edit-text", "sample.pdf", "--page", "1", "--block", b?.id, "--text", "Çok güzel bir İstanbul sabahı.", "-o", "edited-block.pdf"]);
check("edit-text block with Turkish text", eb.edits?.[0]?.mode, eb.edits);
check("edited block text present", cli(["search", "edited-block.pdf", "güzel bir İstanbul", "--match-case"]).total === 1);
check("add-text", cli(["add-text", "sample.pdf", "--page", "1", "--at", "72,780", "--text", "Onaylandı – Şubat", "--size", "14", "--color", "#d1242f", "--bold", "-o", "added.pdf"]).ok);
check("added text present", cli(["search", "added.pdf", "Onaylandı"]).matches?.[0]?.rects?.[0]?.[1] > 770);
const objs = cli(["objects", "sample.pdf", "--page", "1"]);
check("objects", Array.isArray(objs.objects), objs);
if (objs.objects?.length) {
  const o = objs.objects[0];
  check("edit-object recolor", cli(["edit-object", "sample.pdf", "--page", "1", "--id", o.id, "--action", o.kind === "path" ? "recolor" : "delete", "--fill", "#2da44e", "-o", "obj.pdf"]).ok);
}

// ---- comments
const hl = cli(["annotate", "sample.pdf", "--type", "highlight", "--find", "lighthouse", "--author", "Ayşe", "-o", "hl.pdf"]);
check("annotate highlight by search", hl.added === 8, hl);
check("annotate note", cli(["annotate", "hl.pdf", "--type", "note", "--page", "2", "--at", "500,80", "--text", "Kontrol et", "-o", "note.pdf"]).added === 1);
check("annotate rect", cli(["annotate", "note.pdf", "--type", "rect", "--page", "1", "--rect", "100,200,300,260", "-o", "rect.pdf"]).ok);
check("annotate arrow", cli(["annotate", "rect.pdf", "--type", "arrow", "--page", "1", "--from", "50,50", "--to", "150,120", "-o", "arrow.pdf"]).ok);
check("annotate ink", cli(["annotate", "arrow.pdf", "--type", "ink", "--page", "1", "--points", "60,300 80,320 100,310; 60,340 120,340", "-o", "ink.pdf"]).ok);
check("annotate freetext", cli(["annotate", "ink.pdf", "--type", "freetext", "--page", "3", "--rect", "300,400,520,440", "--text", "Şirket notu", "-o", "comments.pdf"]).ok);
const list = cli(["annotations", "comments.pdf"]);
check("annotations list", list.count === 13 && list.annotations.some((x) => x.author === "Ayşe"), list.count);
const xf = cli(["export-comments", "comments.pdf", "-o", "c.xfdf"]);
check("export-comments", xf.count === 13, xf);
check("import-comments", cli(["import-comments", "sample.pdf", "--xfdf", "c.xfdf", "-o", "imported.pdf"]).imported === 13);
check("delete-annotations by type", cli(["delete-annotations", "comments.pdf", "--type", "Highlight", "-o", "nohl.pdf"]).removed === 8);

// ---- forms
const fields = cli(["fields", "form.pdf"]);
check("fields", fields.count >= 3, fields.fields?.map((f) => `${f.name}:${f.type}`));
const textField = fields.fields?.find((f) => f.type === "text");
const checkbox = fields.fields?.find((f) => f.type === "checkbox");
const fill = cli(["fill", "form.pdf", "--set", `${textField?.name}=Ayşe Yılmaz`, ...(checkbox ? ["--set", `${checkbox.name}=yes`] : []), "-o", "filled.pdf"]);
check("fill", fill.filled?.[textField?.name] === "Ayşe Yılmaz" && (!checkbox || fill.filled?.[checkbox.name] === true), fill);
check("add-field", cli(["add-field", "sample.pdf", "--kind", "text", "--name", "Ad Soyad", "--page", "1", "--rect", "150,600,400,622", "-o", "newfield.pdf"]).ok);
check("new field listed", cli(["fields", "newfield.pdf"]).fields?.some((f) => f.name === "Ad Soyad"));
check("add-field dropdown", cli(["add-field", "newfield.pdf", "--kind", "dropdown", "--name", "Şehir", "--page", "1", "--rect", "150,630,300,650", "--options", "İstanbul, İzmir, Ankara", "-o", "newfield2.pdf"]).ok);
check("fill dropdown", cli(["fill", "newfield2.pdf", "--values", JSON.stringify({ Şehir: "İzmir" }), "-o", "newfield3.pdf"]).filled?.["Şehir"] === "İzmir");
check("remove-field", cli(["remove-field", "newfield3.pdf", "--name", "Ad Soyad", "-o", "nofield.pdf"]).ok);

// ---- stamps & bookmarks
check("header-footer", cli(["header-footer", "sample.pdf", "--footer-center", "Sayfa {page} / {pages}", "-o", "hf.pdf"]).pages === 5);
check("watermark keeps footer", cli(["watermark", "hf.pdf", "--text", "TASLAK", "-o", "wm.pdf"]).ok && cli(["search", "wm.pdf", "Sayfa 2 / 5"]).total === 1 && cli(["search", "wm.pdf", "TASLAK"]).total === 5);
const bates = cli(["bates", "wm.pdf", "--prefix", "DAVA-", "--start", "101", "--digits", "5", "-o", "bates.pdf"]);
check("bates", bates.first === "DAVA-00101" && bates.last === "DAVA-00105" && cli(["search", "bates.pdf", "DAVA-00103"]).total === 1, bates);
check("remove-stamps", cli(["remove-stamps", "bates.pdf", "-o", "unstamped.pdf"]).pages === 5 && cli(["search", "unstamped.pdf", "TASLAK"]).total === 0);
const bm = cli(["set-bookmarks", "sample.pdf", "--bookmarks", JSON.stringify([{ title: "Giriş", page: 1 }, { title: "Bölüm 1", page: 2, children: [{ title: "1.1 Ayrıntı", page: 3 }] }]), "-o", "bm.pdf"]);
check("set-bookmarks", bm.ok, bm);
check("add-bookmark nested", cli(["add-bookmark", "bm.pdf", "--title", "1.2 Ek", "--page", "4", "--parent", "Bölüm 1", "-o", "bm2.pdf"]).ok);
const bml = cli(["bookmarks", "bm2.pdf"]);
check("bookmarks", bml.bookmarks?.[1]?.children?.map((c) => c.title).join("|") === "1.1 Ayrıntı|1.2 Ek", bml);

// ---- redact & security
const red = cli(["redact", "sample.pdf", "--find", "lighthouse", "--area", "1:40,25,300,55", "-o", "red.pdf"]);
check("redact", red.redacted_areas >= 9 && red.still_findable?.lighthouse === 0, red);
check("redacted text is gone", cli(["text", "red.pdf"]).pages?.every((p) => !/lighthouse/i.test(p.text)));
check("encrypt", cli(["encrypt", "sample.pdf", "--user-password", "gizli123", "-o", "enc.pdf"]).ok);
check("encrypted needs password", cli(["info", "enc.pdf"], { expectFail: true }).ok === false);
check("password keeps encryption", cli(["rotate", "enc.pdf", "--password", "gizli123", "-o", "enc-rot.pdf"]).ok && cli(["info", "enc-rot.pdf", "--password", "gizli123"]).encrypted === true);
check("decrypt", cli(["decrypt", "enc.pdf", "--password", "gizli123", "-o", "dec.pdf"]).ok && cli(["info", "dec.pdf"]).encrypted === false);

// ---- signatures
const id = cli(["create-id", "--name", "Ayşe Yılmaz", "--email", "ayse@example.com", "--id-password", "pfx-pass", "-o", "ayse.pfx"]);
check("create-id", id.name === "Ayşe Yılmaz", id);
const sig = cli(["sign", "sample.pdf", "--id", "ayse.pfx", "--id-password", "pfx-pass", "--page", "1", "--rect", "350,700,550,760", "--reason", "Onaylıyorum", "-o", "signed.pdf"]);
check("sign", sig.signatures === 1 && sig.status === "unknown-identity", sig);
const v = cli(["verify", "signed.pdf"]);
check("verify", v.count === 1 && v.signatures[0].integrity && v.signatures[0].signature_valid && v.signatures[0].signer === "Ayşe Yılmaz", v);
check("signed file refuses rewrite", /break-signatures/.test(cli(["rotate", "signed.pdf", "-o", "x.pdf"], { expectFail: true }).error));
check("comments on signed file keep signature", cli(["annotate", "signed.pdf", "--type", "highlight", "--find", "lighthouse", "-o", "signed-hl.pdf"]).ok && cli(["verify", "signed-hl.pdf"]).signatures?.[0]?.integrity === true);

// ---- optimise
const ck = cli(["check", "sample.pdf"]);
check("check", Array.isArray(ck.items) && ck.items.length > 5, ck.items?.length);
check("fix", cli(["fix", "sample.pdf", "--lang", "tr-TR", "-o", "fixed.pdf"]).ok);
check("set-metadata", cli(["set-metadata", "sample.pdf", "--title", "Yıllık Rapor", "--author", "Ayşe", "-o", "meta.pdf"]).ok && cli(["info", "meta.pdf"]).metadata?.title === "Yıllık Rapor");
const cmp = cli(["compress", "large-400.pdf", "--preset", "screen", "-o", "small.pdf"]);
check("compress", cmp.ok, cmp);
if (existsSync("C:\\Windows\\System32\\spool\\drivers\\color\\sRGB Color Space Profile.icm")) {
  const pa = cli(["pdfa", "sample.pdf", "-o", "pdfa.pdf"]);
  check("pdfa", pa.ok && Array.isArray(pa.remaining_issues), pa);
}

// ---- compare
const c = cli(["compare", "sample.pdf", "edited.pdf", "-o", "compared.pdf"]);
check("compare", c.added_words >= 8 && c.removed_words >= 4 && c.output, { added: c.added_words, removed: c.removed_words });

// ---- convert & OCR
const img = cli(["to-images", "sample.pdf", "--pages", "1-2", "--dpi", "72"]);
check("to-images", img.files?.length === 2 && Math.abs(img.files[0].width_px - 595) <= 1, img.files?.[0]);
check("to-word", cli(["to-word", "sample.pdf", "-o", "sample.docx"]).size_bytes > 2000);
check("text to file", cli(["text", "sample.pdf", "-o", "sample.txt"]).ok);
const pngs = img.files?.map((f) => f.output) ?? [];
check("images-to-pdf", cli(["images-to-pdf", ...pngs, "--fit", "image", "-o", "fromimages.pdf"]).pages === 2);
const ocr = cli(["ocr", "scanned.pdf", "-o", "ocr.pdf"]);
check("ocr", ocr.recognised_pages?.[0]?.words > 5, ocr);
check("ocr text searchable", cli(["search", "ocr.pdf", "invoice"]).total >= 1);

// ---- JSON arguments (tool-calling LLMs)
check("call with JSON arguments", cli(["call", "pdf_search", JSON.stringify({ input: "sample.pdf", query: "lighthouse", whole_word: true })]).total === 8);
{
  const [cmd, argv] = target.endsWith(".mjs") ? [process.execPath, [target, "call", "annotate"]] : [target, ["call", "annotate"]];
  const r = spawnSync(cmd, argv, { cwd: dir, input: JSON.stringify({ input: "sample.pdf", type: "note", page: 1, at: [300, 300], text: "stdin ile" , output: "stdin-note.pdf" }), encoding: "utf8", windowsHide: true });
  check("call with JSON on stdin", JSON.parse(r.stdout).added === 1, r.stdout.slice(0, 300));
}
check("call rejects bad JSON", /Invalid JSON/.test(cli(["call", "info", "{nope"], { expectFail: true }).error ?? ""));

// ---- errors are JSON
check("unknown command suggests", /Did you mean/.test(cli(["serch", "sample.pdf"], { expectFail: true }).error ?? ""));
check("missing file", /File not found/.test(cli(["info", "nope.pdf"], { expectFail: true }).error ?? ""));
check("commands lists schemas", (() => {
  const r = spawnSync(target.endsWith(".mjs") ? process.execPath : target, target.endsWith(".mjs") ? [target, "commands"] : ["commands"], { encoding: "utf8" });
  const list = JSON.parse(r.stdout);
  return list.length > 40 && list.every((x) => x.parameters?.type === "object");
})());

// ---- MCP server (stdio JSON-RPC)
{
  const outside = join(root, "test-fixtures", "sample.pdf");
  const msgs = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "pdf_info", arguments: { input: join(dir, "sample.pdf") } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "pdf_annotate", arguments: { input: join(dir, "sample.pdf"), type: "rect", page: 1, rect: [100, 100, 200, 150], output: join(dir, "mcp-rect.pdf") } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "pdf_info", arguments: { input: outside } } },
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "pdf_search", arguments: { input: join(dir, "sample.pdf"), query: "lighthouse", unknown_option: 1 } } },
    { jsonrpc: "2.0", id: 7, method: "nope" },
  ];
  const [cmd, argv] = target.endsWith(".mjs") ? [process.execPath, [target, "mcp", "--root", dir]] : [target, ["mcp", "--root", dir]];
  const r = spawnSync(cmd, argv, { input: msgs.map((m) => JSON.stringify(m)).join("\n") + "\n", encoding: "utf8", timeout: 120000, windowsHide: true });
  const replies = new Map(
    r.stdout
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
      .map((m) => [m.id, m]),
  );
  check("mcp initialize", replies.get(1)?.result?.serverInfo?.name === "marmara-pdf" && replies.get(1)?.result?.protocolVersion === "2025-06-18", replies.get(1));
  const tools = replies.get(2)?.result?.tools ?? [];
  check("mcp tools/list", tools.length > 40 && tools.every((t) => t.name.startsWith("pdf_") && t.inputSchema?.type === "object"), tools.length);
  check("mcp tools/call info", replies.get(3)?.result?.structuredContent?.page_count === 5, replies.get(3));
  check("mcp array arguments (rect)", replies.get(4)?.result?.isError === false && existsSync(join(dir, "mcp-rect.pdf")), replies.get(4));
  check("mcp --root blocks other folders", replies.get(5)?.result?.isError === true && /not allowed/.test(replies.get(5)?.result?.content?.[0]?.text), replies.get(5));
  check("mcp rejects unknown options", replies.get(6)?.result?.isError === true, replies.get(6));
  check("mcp unknown method", replies.get(7)?.error?.code === -32601, replies.get(7));
  check("mcp stdout is protocol only", r.stdout.split("\n").filter((l) => l.trim()).every((l) => l.startsWith("{")));
}

console.log(`\n${results.length} checks, ${failures} failure${failures === 1 ? "" : "s"}. Files in ${dir}`);
if (!failures) rmSync(dir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
