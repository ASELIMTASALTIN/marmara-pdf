import type { Worker } from "tesseract.js";

/**
 * Tesseract.js wrapper. All assets (worker, WASM core, language data) are
 * served locally from /vendor/tesseract: nothing is downloaded at runtime and
 * no document data leaves the machine.
 */

const BASE = `${import.meta.env.BASE_URL}vendor/tesseract/`;

export type OcrLanguage = "tur+eng" | "eng" | "tur";

export interface OcrWord {
  text: string;
  /** Pixel bbox in the recognised image. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  confidence: number;
}

export interface OcrLine {
  text: string;
  words: OcrWord[];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Baseline y (pixels) at x0 and x1. */
  baseline: [number, number];
}

let worker: Promise<Worker> | null = null;
let workerLang = "";
let progressSink: ((p: number) => void) | null = null;

async function getWorker(lang: OcrLanguage): Promise<Worker> {
  if (worker && workerLang === lang) return worker;
  if (worker) {
    const old = worker;
    worker = null;
    void old.then((w) => w.terminate()).catch(() => {});
  }
  const { createWorker } = await import("tesseract.js");
  workerLang = lang;
  worker = createWorker(lang.split("+"), 1 /* LSTM only */, {
    workerPath: `${BASE}worker.min.js`,
    corePath: `${BASE}core`,
    langPath: `${BASE}lang`,
    cacheMethod: "none",
    workerBlobURL: false,
    logger: (m) => {
      if (m.status === "recognizing text") progressSink?.(m.progress);
    },
  });
  worker.catch(() => {
    worker = null;
  });
  return worker;
}

export async function terminateOcr() {
  const w = worker;
  worker = null;
  if (w) await (await w).terminate().catch(() => {});
}

/** Recognises text in an image (canvas) and returns lines with word boxes. */
export async function recognizeImage(image: HTMLCanvasElement, lang: OcrLanguage, onProgress?: (p: number) => void): Promise<{ lines: OcrLine[]; confidence: number }> {
  const w = await getWorker(lang);
  progressSink = onProgress ?? null;
  try {
    const { data } = await w.recognize(image, {}, { blocks: true, text: false, hocr: false, tsv: false });
    const lines: OcrLine[] = [];
    for (const block of data.blocks ?? []) {
      for (const para of block.paragraphs) {
        for (const line of para.lines) {
          const words = line.words
            .filter((wd) => wd.text.trim() && wd.confidence > 20)
            .map((wd) => ({ text: wd.text.trim(), confidence: wd.confidence, ...wd.bbox }));
          if (!words.length) continue;
          const bl = line.baseline as unknown as { x0: number; y0: number; x1: number; y1: number; has_baseline?: boolean };
          const hasBaseline = bl && (bl.has_baseline ?? true) && Number.isFinite(bl.y0);
          const h = line.bbox.y1 - line.bbox.y0;
          lines.push({
            text: words.map((x) => x.text).join(" "),
            words,
            ...line.bbox,
            baseline: hasBaseline ? [bl.y0, bl.y1] : [line.bbox.y1 - h * 0.22, line.bbox.y1 - h * 0.22],
          });
        }
      }
    }
    return { lines, confidence: data.confidence };
  } finally {
    progressSink = null;
  }
}
