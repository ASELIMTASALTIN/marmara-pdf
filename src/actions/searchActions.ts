import { buildPageText, findInPage, type PageText, type TextItemLike } from "../core/search/textSearch";
import { TEXT_CONTENT_OPTIONS, type PDFDocumentProxy } from "../core/pdf/pdfjs";
import { useDoc } from "../state/documentStore";
import { pageTextCache, useSearch, type SearchHit } from "../state/searchStore";
import { viewer } from "../components/viewer/viewerController";

let generation = 0;

/** Extra text per page id (e.g. OCR results) merged into search. */
export const extraPageText = new Map<string, TextItemLike[]>();

export async function getPageText(pdf: PDFDocumentProxy, pageIndex: number, matchCase = false): Promise<PageText> {
  let cache = pageTextCache.get(pdf);
  if (!cache) pageTextCache.set(pdf, (cache = new Map()));
  const key = `${pageIndex}:${matchCase ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const page = await pdf.getPage(pageIndex + 1);
  const content = await page.getTextContent(TEXT_CONTENT_OPTIONS);
  const pt = buildPageText(content.items as TextItemLike[], matchCase);
  cache.set(key, pt);
  return pt;
}

/** Runs a search over the whole document, publishing hits progressively. */
export async function runSearch(): Promise<void> {
  const gen = ++generation;
  const { query, matchCase, wholeWord } = useSearch.getState();
  const { pdf } = useDoc.getState();
  if (!pdf || !query.trim()) {
    useSearch.setState({ hits: [], active: -1, running: false, scanned: 0 });
    return;
  }
  useSearch.setState({ hits: [], active: -1, running: true, scanned: 0 });
  const hits: SearchHit[] = [];
  let lastPublish = performance.now();
  for (let i = 0; i < pdf.numPages; i++) {
    let pt: PageText;
    try {
      pt = await getPageText(pdf, i, matchCase);
    } catch {
      continue;
    }
    if (gen !== generation || useDoc.getState().pdf !== pdf) return;
    for (const r of findInPage(pt, query, { matchCase, wholeWord })) hits.push({ page: i, ...r });
    if (performance.now() - lastPublish > 120 || i === pdf.numPages - 1) {
      lastPublish = performance.now();
      const first = useSearch.getState().active < 0 && hits.length > 0;
      useSearch.setState({ hits: [...hits], scanned: i + 1, ...(first ? { active: 0 } : {}) });
      if (first) focusHit(0);
    }
  }
  useSearch.setState({ running: false, scanned: pdf.numPages });
}

export function focusHit(index: number) {
  const { hits } = useSearch.getState();
  if (!hits.length) return;
  const i = ((index % hits.length) + hits.length) % hits.length;
  useSearch.setState((s) => ({ active: i, focusToken: s.focusToken + 1 }));
  viewer.revealPage(hits[i].page);
}

export function nextHit(dir: 1 | -1) {
  const { active, hits } = useSearch.getState();
  if (!hits.length) return;
  focusHit(active < 0 ? 0 : active + dir);
}

export function clearSearch() {
  generation++;
  useSearch.setState({ hits: [], active: -1, running: false, scanned: 0 });
}
