import { create } from "zustand";
import type { PageText, TextRange } from "../core/search/textSearch";

export interface SearchHit extends TextRange {
  page: number;
}

export interface SearchState {
  open: boolean;
  query: string;
  matchCase: boolean;
  wholeWord: boolean;
  hits: SearchHit[];
  /** Index into `hits` of the focused match, -1 if none. */
  active: number;
  running: boolean;
  /** Pages scanned so far (for progress). */
  scanned: number;
  focusToken: number;
}

export const useSearch = create<SearchState>(() => ({
  open: false,
  query: "",
  matchCase: false,
  wholeWord: false,
  hits: [],
  active: -1,
  running: false,
  scanned: 0,
  focusToken: 0,
}));

/** Page texts cached per pdf.js proxy (cleared automatically when the proxy is dropped). */
export const pageTextCache = new WeakMap<object, Map<string, PageText>>();
