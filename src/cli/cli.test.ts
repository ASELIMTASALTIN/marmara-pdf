import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./main";
import { parseArgv } from "./args";
import { getCommand } from "./registry";
import { outputPath, pageGeometries, rectFromUser, rectToUser, resolvePath, selectPages } from "./io";
import { inputSchema } from "./describe";

const fixture = (n: string) => join(process.cwd(), "test-fixtures", n);

describe("CLI arguments", () => {
  const cmd = getCommand("annotate")!;
  it("parses positionals, flags, short flags, booleans and typed values", () => {
    const a = parseArgv(cmd, ["in.pdf", "--type=rect", "--page", "2", "--rect", "10,20,30,40", "-o", "out.pdf", "--overwrite"]);
    expect(a).toMatchObject({ input: "in.pdf", type: "rect", page: 2, rect: [10, 20, 30, 40], output: "out.pdf", overwrite: true });
  });
  it("rejects bad enums, unknown options and missing required values", () => {
    expect(() => parseArgv(cmd, ["in.pdf", "--type", "circle"])).toThrow(/must be one of/);
    expect(() => parseArgv(cmd, ["in.pdf", "--type", "rect", "--colour", "red"])).toThrow(/Unknown option --colour/);
    expect(() => parseArgv(cmd, ["in.pdf"])).toThrow(/Missing required option --type/);
    expect(() => parseArgv(cmd, ["in.pdf", "--type", "rect", "--rect", "1,2,3"])).toThrow(/x0,y0,x1,y1/);
  });
  it("collects repeatable and multi-file arguments", () => {
    expect(parseArgv(getCommand("merge")!, ["a.pdf", "b.pdf", "c.pdf"]).inputs).toEqual(["a.pdf", "b.pdf", "c.pdf"]);
    expect(parseArgv(getCommand("fill")!, ["f.pdf", "--set", "A=1", "--set", "B=İzmir"]).set).toEqual(["A=1", "B=İzmir"]);
    expect(parseArgv(getCommand("redact")!, ["f.pdf", "--find", "x", "--no-black-boxes"]).black_boxes).toBe(false);
  });
  it("produces JSON Schemas for MCP", () => {
    const s = inputSchema(getCommand("annotate")!) as { properties: Record<string, { type: string; enum?: string[] }>; required: string[] };
    expect(s.required).toEqual(["input", "type"]);
    expect(s.properties.rect.type).toBe("array");
    expect(s.properties.type.enum).toContain("highlight");
  });
});

describe("CLI helpers", () => {
  it("selects 1-based page ranges", () => {
    expect(selectPages(undefined, 4)).toEqual([0, 1, 2, 3]);
    expect(selectPages("2-3, 1", 5)).toEqual([1, 2, 0]);
    expect(selectPages("4-", 5)).toEqual([3, 4]);
    expect(selectPages("last", 5)).toEqual([4]);
    expect(() => selectPages("7", 5)).toThrow();
  });
  it("never picks an existing output name and keeps the input unless overwrite is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcli-"));
    const input = join(dir, "a.pdf");
    writeFileSync(input, "x");
    writeFileSync(join(dir, "a.rotated.pdf"), "x");
    const ctx = { cwd: dir, progress: () => {} };
    expect(outputPath(ctx, {}, input, "rotated", ".pdf")).toBe(join(dir, "a.rotated-2.pdf"));
    expect(outputPath(ctx, { overwrite: true }, input, "rotated", ".pdf")).toBe(input);
    expect(() => outputPath(ctx, { output: "a.rotated.pdf" }, input, "rotated", ".pdf")).toThrow(/already exists/);
  });
  it("restricts paths to the allowed roots", () => {
    const docs = join(tmpdir(), "docs");
    const ctx = { cwd: docs, progress: () => {}, roots: [docs] };
    expect(resolvePath(ctx, join("sub", "a.pdf"))).toBe(join(docs, "sub", "a.pdf"));
    expect(() => resolvePath(ctx, join("..", "secret.pdf"))).toThrow(/not allowed/);
    expect(() => resolvePath(ctx, join(tmpdir(), "docs2", "a.pdf"))).toThrow(/not allowed/);
  });
  it("converts display rectangles to user space and back (rotated page too)", async () => {
    const bytes = new Uint8Array(readFileSync(fixture("sample.pdf")));
    const { rotatePages } = await import("../core/pdf/pageOps");
    const rotated = await rotatePages(bytes, [0], 90);
    for (const b of [bytes, rotated]) {
      const [g] = await pageGeometries(b);
      const r = [50, 60, 150, 90];
      expect(rectFromUser(g, rectToUser(g, r))).toEqual(r);
    }
    const [g] = await pageGeometries(rotated);
    expect(g.rotation).toBe(90);
    expect(g.width).toBeGreaterThan(g.height);
  });
});

describe("CLI commands (in-process)", () => {
  it("returns JSON results and JSON errors", async () => {
    const ok = await run(["info", fixture("sample.pdf"), "--compact"]);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ ok: true, page_count: 5 });
    const bad = await run(["info", fixture("missing.pdf")]);
    expect(bad.code).toBe(2);
    expect(JSON.parse(bad.stdout)).toMatchObject({ ok: false });
    const unknown = await run(["serch"]);
    expect(JSON.parse(unknown.stdout).error).toMatch(/Did you mean: search/);
  });
  it("searches with Turkish folding and reports rectangles", async () => {
    const r = JSON.parse((await run(["search", fixture("sample.pdf"), "ISTANBUL", "--compact"])).stdout);
    expect(r.total).toBeGreaterThan(0);
    expect(r.matches[0].rects[0]).toHaveLength(4);
  });
  it("help lists every group", async () => {
    const h = (await run(["help"])).stdout;
    for (const g of ["Inspect", "Pages", "Forms", "Signatures", "OCR & convert"]) expect(h).toContain(`${g}:`);
  });
});
