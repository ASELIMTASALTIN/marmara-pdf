/**
 * Imperative bridge to the mounted viewer (scrolling is inherently imperative).
 * Actions call these helpers; the Viewer component registers the implementation.
 */
export interface ViewerApi {
  scrollToPage(index: number, opts?: { smooth?: boolean; offsetFraction?: number }): void;
  /** Scrolls only if the page is not already (mostly) visible. */
  revealPage(index: number): void;
  /** Scrolls so a point (fraction of page width/height) is centred. */
  revealPoint(index: number, fx: number, fy: number): void;
  scrollBy(dy: number): void;
  element(): HTMLElement | null;
}

let api: ViewerApi | null = null;

export const viewer = {
  register(a: ViewerApi | null) {
    api = a;
  },
  scrollToPage: (i: number, opts?: { smooth?: boolean; offsetFraction?: number }) => api?.scrollToPage(i, opts),
  revealPage: (i: number) => api?.revealPage(i),
  revealPoint: (i: number, fx: number, fy: number) => api?.revealPoint(i, fx, fy),
  scrollBy: (dy: number) => api?.scrollBy(dy),
  element: () => api?.element() ?? null,
};

/** Anchor for the next zoom change (viewport-relative px); null = viewport centre. */
export const zoomAnchor: { current: { x: number; y: number } | null } = { current: null };
