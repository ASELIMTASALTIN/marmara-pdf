import { create } from "zustand";
import type { Rect } from "../core/annotations/types";
import type { StoredDigitalId } from "../core/signature/identity";
import type { SignatureInfo } from "../core/signature/verify";
import { exclusive, markSaved, useDoc, withBusy } from "../state/documentStore";
import { setTool, useUi } from "../state/uiStore";
import { errorMessage, openDialog, toast } from "../state/dialogStore";
import { platform } from "../platform";
import { exportDocument } from "./exportDocument";
import { openFile } from "./fileActions";
import { newId } from "../core/ids";

// ---------------------------------------------------------------------------
// Digital ID storage (password-protected PKCS#12 blobs in local storage)
// ---------------------------------------------------------------------------

const IDS_KEY = "marmara.digitalIds";

export function listDigitalIds(): StoredDigitalId[] {
  try {
    return JSON.parse(localStorage.getItem(IDS_KEY) || "[]");
  } catch {
    return [];
  }
}
function storeIds(ids: StoredDigitalId[]) {
  localStorage.setItem(IDS_KEY, JSON.stringify(ids));
  window.dispatchEvent(new Event("marmara:ids"));
}

export async function createDigitalIdDialog(): Promise<StoredDigitalId | null> {
  const r = await openDialog({
    title: "Create a digital ID",
    message:
      "Creates a personal, self-signed certificate for signing. Others can verify that the document was not changed after you signed it; to prove your identity to them, use a certificate from a certification authority (import a .pfx file).",
    fields: [
      { kind: "text", key: "name", label: "Full name", placeholder: "e.g. Ayşe Yılmaz" },
      { kind: "text", key: "organization", label: "Organisation (optional)" },
      { kind: "text", key: "email", label: "E-mail (optional)" },
      { kind: "text", key: "password", label: "Password (protects the private key)", password: true },
      { kind: "text", key: "password2", label: "Repeat password", password: true },
    ],
    buttons: [
      { id: "cancel", label: "Cancel" },
      { id: "ok", label: "Create", variant: "primary" },
    ],
    validate: (v, b) => {
      if (b !== "ok") return null;
      if (!v.name.trim()) return "Enter your name.";
      if (v.password.length < 6) return "Use a password of at least 6 characters.";
      if (v.password !== v.password2) return "The passwords do not match.";
      if (v.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) return "The e-mail address is not valid.";
      return null;
    },
    width: 480,
  });
  if (r.button !== "ok") return null;
  try {
    const { createSelfSignedId } = await import("../core/signature/identity");
    const id = await withBusy("Creating digital ID…", () =>
      createSelfSignedId({ name: r.values.name, organization: r.values.organization, email: r.values.email }, r.values.password, newId()),
    );
    storeIds([...listDigitalIds(), id]);
    toast(`Digital ID created for ${id.name}`, "success");
    return id;
  } catch (e) {
    toast(errorMessage(e), "error");
    return null;
  }
}

export async function importDigitalIdDialog(): Promise<StoredDigitalId | null> {
  const file = await platform.pickFile({ title: "Import digital ID", filterName: "Digital ID (PKCS#12)", extensions: ["pfx", "p12"] });
  if (!file) return null;
  for (;;) {
    const r = await openDialog({
      title: "Import digital ID",
      message: `Enter the password of “${file.name}”.`,
      fields: [{ kind: "text", key: "password", label: "Password", password: true }],
      buttons: [
        { id: "cancel", label: "Cancel" },
        { id: "ok", label: "Import", variant: "primary" },
      ],
    });
    if (r.button !== "ok") return null;
    try {
      const { importDigitalId } = await import("../core/signature/identity");
      const id = importDigitalId(file.bytes, r.values.password, newId());
      const ids = listDigitalIds().filter((x) => x.fingerprint !== id.fingerprint);
      storeIds([...ids, id]);
      toast(`Imported digital ID of ${id.name}`, "success");
      return id;
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  }
}

export async function exportDigitalId(id: StoredDigitalId) {
  const { digitalIdBytes } = await import("../core/signature/identity");
  const written = await platform.saveExport(digitalIdBytes(id), {
    suggestedName: `${id.name.replace(/[\\/:*?"<>|]/g, "_")}.pfx`,
    filterName: "Digital ID (PKCS#12)",
    extensions: ["pfx"],
  });
  if (written) toast("Digital ID exported (keep the file and its password safe)", "success");
}

export function deleteDigitalId(id: StoredDigitalId) {
  storeIds(listDigitalIds().filter((x) => x.id !== id.id));
}

// ---------------------------------------------------------------------------
// Signature placement (drag a box on the page)
// ---------------------------------------------------------------------------

let placeResolver: ((r: { pageIndex: number; rect: Rect } | null) => void) | null = null;

/** Called by the annotation layer when the user drew the signature box. */
export function signatureBoxDrawn(pageIndex: number, rect: Rect) {
  const r = placeResolver;
  placeResolver = null;
  setTool("select");
  r?.({ pageIndex, rect });
}

function placeSignature(): Promise<{ pageIndex: number; rect: Rect } | null> {
  placeResolver?.(null);
  return new Promise((resolve) => {
    placeResolver = resolve;
    setTool("digital-signature");
    toast("Drag a rectangle on the page where the signature should appear (Esc to cancel)", "info", 6000);
    // Cancel when the user switches tool.
    const unsub = useUi.subscribe((s) => {
      if (s.tool !== "digital-signature" && placeResolver === resolve) {
        placeResolver = null;
        unsub();
        resolve(null);
      } else if (s.tool !== "digital-signature") unsub();
    });
  });
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

interface SignChoice {
  id: StoredDigitalId;
  reason: string;
  location: string;
  visible: boolean;
  withImage: boolean;
}

function savedHandwritten(): string | null {
  try {
    const list = JSON.parse(localStorage.getItem("marmara.signatures") || "[]") as { dataUrl: string }[];
    return list[0]?.dataUrl ?? null;
  } catch {
    return null;
  }
}

async function chooseSigning(): Promise<SignChoice | null> {
  let ids = listDigitalIds();
  if (!ids.length) {
    const r = await openDialog({
      title: "Sign digitally",
      message: "You need a digital ID (certificate) to sign. Create one now, or import a .pfx / .p12 file from your certification authority.",
      buttons: [
        { id: "cancel", label: "Cancel" },
        { id: "import", label: "Import .pfx…" },
        { id: "create", label: "Create digital ID…", variant: "primary" },
      ],
    });
    const created = r.button === "create" ? await createDigitalIdDialog() : r.button === "import" ? await importDigitalIdDialog() : null;
    if (!created) return null;
    ids = listDigitalIds();
  }
  const hasImage = !!savedHandwritten();
  const r = await openDialog({
    title: "Sign digitally",
    message: "The signature seals the document: any later change to the signed content is detected.",
    fields: [
      {
        kind: "select",
        key: "id",
        label: "Sign as",
        value: ids[ids.length - 1].id,
        options: ids.map((i) => ({
          value: i.id,
          label: `${i.name}${i.email ? ` <${i.email}>` : ""} — ${i.selfSigned ? "self-signed" : `issued by ${i.issuer}`}, valid until ${new Date(i.notAfter).toLocaleDateString()}`,
        })),
      },
      {
        kind: "select",
        key: "reason",
        label: "Reason",
        value: "I approve this document",
        options: [
          { value: "I approve this document", label: "I approve this document" },
          { value: "I am the author of this document", label: "I am the author of this document" },
          { value: "I have reviewed this document", label: "I have reviewed this document" },
          { value: "", label: "(no reason)" },
        ],
      },
      { kind: "text", key: "location", label: "Location (optional)", placeholder: "e.g. İstanbul" },
      {
        kind: "radio",
        key: "appearance",
        label: "Appearance",
        value: "visible",
        options: [
          { value: "visible", label: "Visible signature box", hint: "You will draw its position on the page" },
          ...(hasImage ? [{ value: "visible-image", label: "Visible box with my handwritten signature", hint: "Uses your first saved signature" }] : []),
          { value: "invisible", label: "Invisible signature" },
        ],
      },
    ],
    buttons: [
      { id: "cancel", label: "Cancel" },
      { id: "ok", label: "Continue", variant: "primary" },
    ],
    width: 560,
  });
  if (r.button !== "ok") return null;
  const id = ids.find((i) => i.id === r.values.id)!;
  if (new Date(id.notAfter) < new Date()) {
    toast("This digital ID has expired. Create or import a new one.", "error");
    return null;
  }
  return {
    id,
    reason: r.values.reason,
    location: r.values.location,
    visible: r.values.appearance !== "invisible",
    withImage: r.values.appearance === "visible-image",
  };
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const b = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

/** Full signing flow: choose ID and options, place the box, unlock, sign, save as a new file, open it. */
export async function signDocumentFlow(): Promise<void> {
  const { doc } = useDoc.getState();
  if (!doc) return;
  if (doc.protection) {
    toast("Password-protected documents cannot be signed here. Save a copy without the password first.", "error", 7000);
    return;
  }
  const choice = await chooseSigning();
  if (!choice) return;
  let placement: { pageIndex: number; rect: Rect | null } = { pageIndex: useUi.getState().currentPage, rect: null };
  if (choice.visible) {
    const p = await placeSignature();
    if (!p) return;
    placement = p;
  }
  const { unlockDigitalId } = await import("../core/signature/identity");
  let unlocked: Awaited<ReturnType<typeof unlockDigitalId>> | null = null;
  while (!unlocked) {
    const r = await openDialog({
      title: "Unlock digital ID",
      message: `Enter the password of the digital ID “${choice.id.name}”.`,
      fields: [{ kind: "text", key: "password", label: "Password", password: true }],
      buttons: [
        { id: "cancel", label: "Cancel" },
        { id: "ok", label: "Sign", variant: "primary" },
      ],
    });
    if (r.button !== "ok") return;
    try {
      unlocked = unlockDigitalId(choice.id, r.values.password);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  }
  await exclusive(async () => {
    try {
      const signed = await withBusy("Signing…", async () => {
        const bytes = await exportDocument();
        const { signPdf } = await import("../core/signature/sign");
        const img = choice.withImage ? savedHandwritten() : null;
        return signPdf(bytes, unlocked!, {
          pageIndex: placement.pageIndex,
          rect: placement.rect,
          reason: choice.reason || undefined,
          location: choice.location || undefined,
          contact: choice.id.email,
          image: img ? dataUrlToBytes(img) : undefined,
        });
      });
      const stem = doc.name.replace(/\.pdf$/i, "").replace(/ \(signed\)$/i, "");
      const written = await platform.savePdf(signed, { suggestedName: `${stem} (signed).pdf`, saveAs: true });
      if (!written) {
        toast("Signing cancelled: the signed copy was not saved", "info");
        return;
      }
      // The working document's changes are now in the signed copy: open that copy.
      markSaved({});
      const name = platform.isDesktop ? written.split(/[\\/]/).pop()! : written;
      setTimeout(() => void openFile({ name, path: platform.isDesktop ? written : undefined, bytes: signed }), 0);
      toast(`Signed and saved as ${name}`, "success", 5000);
    } catch (e) {
      toast(`Signing failed: ${errorMessage(e)}`, "error");
    }
  });
}

// ---------------------------------------------------------------------------
// Verification state
// ---------------------------------------------------------------------------

interface SigState {
  docId: string | null;
  signatures: SignatureInfo[] | null;
  loading: boolean;
}
export const useSignatures = create<SigState>(() => ({ docId: null, signatures: null, loading: false }));

function hasByteRange(bytes: Uint8Array): boolean {
  const needle = [0x2f, 0x42, 0x79, 0x74, 0x65, 0x52, 0x61, 0x6e, 0x67, 0x65]; // "/ByteRange"
  outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
    if (bytes[i] !== 0x2f) continue;
    for (let k = 1; k < needle.length; k++) if (bytes[i + k] !== needle[k]) continue outer;
    return true;
  }
  return false;
}

/** Detects and verifies signatures of the opened document (called after open). */
export async function refreshSignatures(): Promise<void> {
  const { doc } = useDoc.getState();
  if (!doc) return;
  const bytes = doc.original ?? doc.bytes;
  if (!hasByteRange(bytes)) {
    useSignatures.setState({ docId: doc.id, signatures: [], loading: false });
    return;
  }
  useSignatures.setState({ docId: doc.id, signatures: null, loading: true });
  try {
    const { verifySignatures } = await import("../core/signature/verify");
    const sigs = await verifySignatures(bytes);
    if (useDoc.getState().doc?.id !== doc.id) return;
    useSignatures.setState({ docId: doc.id, signatures: sigs, loading: false });
    useDoc.setState((s) => ({ doc: s.doc && { ...s.doc, signatures: sigs.length } }));
  } catch (e) {
    console.warn("signature verification failed", e);
    useSignatures.setState({ docId: doc.id, signatures: [], loading: false });
  }
}
