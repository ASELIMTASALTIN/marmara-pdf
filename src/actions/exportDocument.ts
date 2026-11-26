import { countAnnotations } from "../core/annotations/types";
import { useDoc } from "../state/documentStore";

/**
 * Produces the final PDF bytes for saving: the current document bytes with all
 * editable annotations written in as real PDF annotations, re-encrypted when
 * the original file was password protected.
 */
export async function exportDocument(): Promise<Uint8Array> {
  const { doc, annotations, formValues } = useDoc.getState();
  if (!doc) throw new Error("No document is open");
  let bytes = doc.bytes;
  if (Object.keys(formValues).length) {
    const { applyFormValues } = await import("../core/forms/forms");
    bytes = await applyFormValues(bytes, formValues);
  }
  if (countAnnotations(annotations) > 0) {
    const { bakeAnnotations } = await import("../core/annotations/bake");
    bytes = await bakeAnnotations(bytes, doc.pageIds, annotations);
  }
  if (doc.protection?.userPassword) {
    const { encryptPdf } = await import("../core/mupdf/security");
    bytes = await encryptPdf(bytes, doc.protection.userPassword);
  }
  return bytes;
}
