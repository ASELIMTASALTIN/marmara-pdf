import { countAnnotations } from "../core/annotations/types";
import { useDoc } from "../state/documentStore";

/**
 * Produces the final PDF bytes for saving: the current document bytes with all
 * editable annotations written in as real PDF annotations.
 */
export async function exportDocument(): Promise<Uint8Array> {
  const { doc, annotations } = useDoc.getState();
  if (!doc) throw new Error("No document is open");
  if (countAnnotations(annotations) === 0) return doc.bytes;
  const { bakeAnnotations } = await import("../core/annotations/bake");
  return bakeAnnotations(doc.bytes, doc.pageIds, annotations);
}
