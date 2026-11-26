import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { commit, exclusive, setBusyLabel, useDoc, withBusy } from "../state/documentStore";
import { errorMessage, openDialog, toast } from "../state/dialogStore";
import type { CheckItem, CheckReport } from "../core/optimize/preflight";
import { platform } from "../platform";
import { exportDocument } from "./exportDocument";

const mb = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(2)} MB` : `${Math.round(n / 1e3)} KB`);

export async function compressDialog() {
  const { doc } = useDoc.getState();
  if (!doc) return;
  const { COMPRESS_PRESETS } = await import("../core/optimize/compress");
  const r = await openDialog({
    title: "Reduce file size",
    message: `Current size: ${mb(doc.bytes.length)}. Images above the chosen resolution are downsampled and re-compressed; duplicate and unused objects are removed.`,
    fields: [
      {
        kind: "radio",
        key: "preset",
        label: "Quality",
        value: "ebook",
        options: Object.entries(COMPRESS_PRESETS).map(([value, p]) => ({ value, label: p.label })),
      },
    ],
    buttons: [
      { id: "cancel", label: "Cancel" },
      { id: "ok", label: "Compress", variant: "primary" },
    ],
  });
  if (r.button !== "ok") return;
  await exclusive(async () => {
    try {
      const { compressPdf } = await import("../core/optimize/compress");
      const res = await withBusy("Compressing…", () =>
        compressPdf(useDoc.getState().doc!.bytes, COMPRESS_PRESETS[r.values.preset], (d, t) => setBusyLabel(`Compressing images — ${d} of ${t}`)),
      );
      if (res.after >= res.before) {
        toast("The document is already well optimised; the size could not be reduced further.", "info", 5000);
        return;
      }
      await commit("Reduce file size", { bytes: res.bytes });
      const pct = Math.round((1 - res.after / res.before) * 100);
      toast(`${mb(res.before)} → ${mb(res.after)} (−${pct}%)${res.imagesRecompressed ? `, ${res.imagesRecompressed} image${res.imagesRecompressed > 1 ? "s" : ""} re-compressed` : ""}. Save to keep it.`, "success", 6000);
    } catch (e) {
      toast(`Compression failed: ${errorMessage(e)}`, "error");
    }
  });
}

const LEVEL_ICON = { pass: CheckCircle2, warning: AlertTriangle, error: XCircle, info: Info };

function Report({ report }: { report: CheckReport }) {
  const groups = [...new Set(report.items.map((i) => i.group))];
  return (
    <div className="check-report">
      {groups.map((g) => (
        <section key={g}>
          <h3>{g}</h3>
          {report.items
            .filter((i) => i.group === g)
            .map((i: CheckItem) => {
              const Icon = LEVEL_ICON[i.level];
              return (
                <div key={i.id} className={`check-item ${i.level}`}>
                  <Icon size={15} />
                  <div>
                    <div>{i.title}</div>
                    {i.detail && <div className="muted small">{i.detail}</div>}
                  </div>
                </div>
              );
            })}
        </section>
      ))}
    </div>
  );
}

async function srgbProfile(): Promise<Uint8Array> {
  if (!platform.isDesktop) throw new Error("PDF/A conversion needs the Windows sRGB colour profile (desktop app only).");
  const f = await platform.readPath("C:\\Windows\\System32\\spool\\drivers\\color\\sRGB Color Space Profile.icm");
  return f.bytes;
}

/** Document check: accessibility, archiving and general issues, with fixes. */
export async function documentCheckDialog() {
  const { doc } = useDoc.getState();
  if (!doc) return;
  try {
    const { preflight } = await import("../core/optimize/preflight");
    const report = await withBusy("Checking the document…", () => preflight(doc.bytes, !!doc.protection));
    const fixable = report.items.filter((i) => i.fixable && i.id !== "pdfa");
    const errors = report.items.filter((i) => i.level === "error").length;
    const warnings = report.items.filter((i) => i.level === "warning").length;
    const r = await openDialog({
      title: "Document check",
      message: errors || warnings ? `${errors} problem${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}.` : "No problems found.",
      body: () => <Report report={report} />,
      buttons: [
        { id: "close", label: "Close" },
        { id: "pdfa", label: "Save as PDF/A…" },
        ...(fixable.length ? [{ id: "fix", label: `Fix ${fixable.length} issue${fixable.length > 1 ? "s" : ""}…`, variant: "primary" as const }] : []),
      ],
      width: 620,
    });
    if (r.button === "fix") await fixDialog(report);
    if (r.button === "pdfa") await saveAsPdfA();
  } catch (e) {
    toast(`Check failed: ${errorMessage(e)}`, "error");
  }
}

async function fixDialog(report: CheckReport) {
  const { doc } = useDoc.getState();
  if (!doc) return;
  const need = new Set(report.items.filter((i) => i.fixable).map((i) => i.id));
  const r = await openDialog({
    title: "Fix document properties",
    fields: [
      ...(need.has("title") ? [{ kind: "text" as const, key: "title", label: "Document title", value: doc.name.replace(/\.pdf$/i, "") }] : []),
      ...(need.has("lang")
        ? [
            {
              kind: "select" as const,
              key: "lang",
              label: "Document language",
              value: "tr-TR",
              options: [
                { value: "tr-TR", label: "Turkish (tr-TR)" },
                { value: "en-US", label: "English (en-US)" },
                { value: "en-GB", label: "English (en-GB)" },
                { value: "de-DE", label: "German (de-DE)" },
                { value: "fr-FR", label: "French (fr-FR)" },
              ],
            },
          ]
        : []),
    ],
    message: [
      need.has("displaytitle") ? "The title will be shown in the viewer's title bar." : "",
      need.has("js") ? "JavaScript will be removed." : "",
    ]
      .filter(Boolean)
      .join(" "),
    buttons: [
      { id: "cancel", label: "Cancel" },
      { id: "ok", label: "Apply fixes", variant: "primary" },
    ],
  });
  if (r.button !== "ok") return;
  await exclusive(async () => {
    try {
      const { fixDocument } = await import("../core/optimize/preflight");
      const bytes = await fixDocument(useDoc.getState().doc!.bytes, {
        title: need.has("title") ? r.values.title : undefined,
        lang: need.has("lang") ? r.values.lang : undefined,
        displayTitle: need.has("displaytitle"),
        removeJavaScript: need.has("js"),
      });
      await commit("Fix document properties", { bytes });
      toast("Document properties fixed. Save to keep the changes.", "success");
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  });
}

export async function saveAsPdfA() {
  const { doc } = useDoc.getState();
  if (!doc) return;
  if (doc.protection) {
    toast("PDF/A files cannot be password protected. Remove the password first.", "error");
    return;
  }
  try {
    const { convertToPdfA, preflight } = await import("../core/optimize/preflight");
    const icc = await srgbProfile();
    const out = await withBusy("Converting to PDF/A-2b…", async () =>
      convertToPdfA(await exportDocument(), icc, doc.name.replace(/\.pdf$/i, ""), "tr-TR"),
    );
    const rep = await preflight(out);
    const blocking = rep.items.filter((i) => i.group === "Archiving (PDF/A)" && i.level === "error");
    if (blocking.length) {
      const go = await openDialog({
        title: "PDF/A conversion incomplete",
        message: `The file has PDF/A identification, but these issues remain: ${blocking.map((b) => b.title + (b.detail ? ` (${b.detail})` : "")).join("; ")}. Strict validators will reject it.`,
        buttons: [
          { id: "cancel", label: "Cancel" },
          { id: "ok", label: "Save anyway", variant: "primary" },
        ],
      });
      if (go.button !== "ok") return;
    }
    const written = await platform.savePdf(out, { suggestedName: `${doc.name.replace(/\.pdf$/i, "")} (PDF-A).pdf`, saveAs: true });
    if (written) toast(`Saved PDF/A-2b copy${blocking.length ? " (with remaining issues)" : ""}`, "success");
  } catch (e) {
    toast(`PDF/A conversion failed: ${errorMessage(e)}`, "error");
  }
}
