import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };
export type { PDFDocumentProxy, PDFPageProxy, PageViewport } from "pdfjs-dist";

/** 1 PDF point = 1/72 in; 1 CSS px = 1/96 in. Zoom 100% = physical size. */
export const CSS_UNITS = 96 / 72;

const VENDOR = `${import.meta.env.BASE_URL}vendor/pdfjs/`;

export class PasswordRequiredError extends Error {
  constructor(public readonly incorrect: boolean) {
    super(incorrect ? "Incorrect password" : "This PDF is password protected");
    this.name = "PasswordRequiredError";
  }
}

export class PdfLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfLoadError";
  }
}

/** Opens a PDF for rendering. The input buffer is copied (pdf.js transfers it to its worker). */
export async function openPdf(bytes: Uint8Array, password?: string): Promise<PDFDocumentProxy> {
  if (bytes.length === 0) throw new PdfLoadError("The file is empty.");
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    password,
    cMapUrl: `${VENDOR}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${VENDOR}standard_fonts/`,
    wasmUrl: `${VENDOR}wasm/`,
    iccUrl: `${VENDOR}iccs/`,
    enableXfa: false,
  });
  try {
    return await task.promise;
  } catch (e: unknown) {
    const err = e as { name?: string; code?: number; message?: string };
    if (err?.name === "PasswordException") {
      throw new PasswordRequiredError(err.code === pdfjs.PasswordResponses.INCORRECT_PASSWORD);
    }
    if (err?.name === "InvalidPDFException") {
      throw new PdfLoadError("The file is not a valid PDF or is too damaged to open.");
    }
    throw new PdfLoadError(err?.message || "The PDF could not be opened.");
  }
}

export interface PageSize {
  /** Width in CSS px at zoom 1, rotation applied. */
  w: number;
  h: number;
}

/** Reads every page's displayed size. Cheap: does not parse page content. */
export async function readPageSizes(pdf: PDFDocumentProxy): Promise<PageSize[]> {
  const sizes: PageSize[] = new Array(pdf.numPages);
  const BATCH = 64;
  for (let start = 0; start < pdf.numPages; start += BATCH) {
    const end = Math.min(pdf.numPages, start + BATCH);
    await Promise.all(
      Array.from({ length: end - start }, async (_, k) => {
        const i = start + k;
        try {
          const vp = (await pdf.getPage(i + 1)).getViewport({ scale: CSS_UNITS });
          sizes[i] = { w: vp.width, h: vp.height };
        } catch {
          sizes[i] = { w: 612 * CSS_UNITS, h: 792 * CSS_UNITS }; // damaged page: assume Letter
        }
      }),
    );
  }
  return sizes;
}

/**
 * Text-content options shared by the text layer and search. They must match so
 * that text item indices line up with the text layer's spans.
 */
export const TEXT_CONTENT_OPTIONS = { includeMarkedContent: true, disableNormalization: true } as const;
