import { describe, expect, it } from "vitest";
import { buildPageText, findInPage, rangeToSegments } from "./textSearch";

const opts = { matchCase: false, wholeWord: false };

describe("textSearch", () => {
  const page = buildPageText([
    { str: "İstanbul Boğazı ", hasEOL: false },
    { type: "beginMarkedContent" } as never,
    { str: "öğrenci", hasEOL: true },
    { str: "Hello World" },
  ]);

  it("folds Turkish case and diacritics without shifting offsets", () => {
    expect(page.folded.length).toBe(page.raw.length);
    expect(findInPage(page, "istanbul", opts)).toEqual([{ start: 0, end: 8 }]);
    expect(findInPage(page, "bogazi", opts)).toHaveLength(1);
    expect(findInPage(page, "OGRENCI", opts)).toHaveLength(1);
  });

  it("matches across items and line breaks", () => {
    const [m] = findInPage(page, "öğrenci hello", opts);
    expect(m).toBeDefined();
    expect(rangeToSegments(page, m)).toEqual([
      { item: 1, from: 0, to: 7 },
      { item: 2, from: 0, to: 5 },
    ]);
  });

  it("respects match case and whole word", () => {
    expect(findInPage(page, "hello", { matchCase: true, wholeWord: false })).toHaveLength(0);
    expect(findInPage(page, "Hello", { matchCase: true, wholeWord: false })).toHaveLength(1);
    expect(findInPage(page, "wor", { matchCase: false, wholeWord: true })).toHaveLength(0);
    expect(findInPage(page, "world", { matchCase: false, wholeWord: true })).toHaveLength(1);
  });
});
