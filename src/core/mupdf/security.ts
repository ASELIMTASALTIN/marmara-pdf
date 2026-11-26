import { openMupdf, saveMupdf } from "./loader";

/** Cheap check for an /Encrypt entry (trailer dictionaries are never compressed). */
export function looksEncrypted(bytes: Uint8Array): boolean {
  const scan = (from: number, to: number) => {
    const s = new TextDecoder("latin1").decode(bytes.subarray(Math.max(0, from), Math.min(bytes.length, to)));
    return s.includes("/Encrypt");
  };
  const MB = 1 << 20;
  return scan(bytes.length - 2 * MB, bytes.length) || scan(0, 2 * MB);
}

/** Returns an unencrypted copy of the PDF (requires the password if one is set). */
export async function decryptPdf(bytes: Uint8Array, password = ""): Promise<Uint8Array> {
  const { doc } = await openMupdf(bytes, password || undefined);
  try {
    return saveMupdf(doc, "decrypt,compress");
  } finally {
    doc.destroy();
  }
}

/** Encrypts the PDF with AES-256 using the given open password. */
export async function encryptPdf(bytes: Uint8Array, userPassword: string, ownerPassword = userPassword): Promise<Uint8Array> {
  const { doc } = await openMupdf(bytes);
  try {
    const esc = (s: string) => s.replace(/[,=\\]/g, (c) => `\\${c}`);
    return saveMupdf(doc, `compress,encrypt=aes-256,user-password=${esc(userPassword)},owner-password=${esc(ownerPassword)}`);
  } finally {
    doc.destroy();
  }
}
