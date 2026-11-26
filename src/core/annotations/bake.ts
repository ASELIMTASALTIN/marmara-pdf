import type { AnnotationMap } from "./types";

/** Writes editable annotations into the PDF as real annotations (implemented in the annotation phase). */
export async function bakeAnnotations(bytes: Uint8Array, _pageIds: string[], _annotations: AnnotationMap): Promise<Uint8Array> {
  return bytes;
}
