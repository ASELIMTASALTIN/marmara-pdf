import { useEffect } from "react";
import { BadgeCheck, FileSignature, KeyRound, Loader2, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import { useDoc } from "../../state/documentStore";
import { refreshSignatures, useSignatures } from "../../actions/signatureActions";
import { runCommand } from "../../actions/commands";
import type { SignatureInfo, SignatureStatus } from "../../core/signature/verify";
import { viewer } from "../viewer/viewerController";

const STATUS: Record<SignatureStatus, { icon: typeof ShieldCheck; cls: string; label: string }> = {
  valid: { icon: BadgeCheck, cls: "ok", label: "Valid" },
  "unknown-identity": { icon: ShieldCheck, cls: "ok", label: "Signed — not changed since" },
  "valid-modified": { icon: ShieldQuestion, cls: "warn", label: "Valid — later changes exist" },
  unsupported: { icon: ShieldQuestion, cls: "warn", label: "Could not be fully checked" },
  invalid: { icon: ShieldAlert, cls: "bad", label: "Invalid" },
};

function pdfDateToLocal(d?: string): string | undefined {
  const m = d && /D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/.exec(d);
  if (!m) return d;
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)).toLocaleString();
}

/** Overall status: the worst of all signatures. */
export function overallStatus(sigs: SignatureInfo[]): SignatureStatus {
  const order: SignatureStatus[] = ["invalid", "unsupported", "valid-modified", "unknown-identity", "valid"];
  for (const s of order) if (sigs.some((x) => x.status === s)) return s;
  return "valid";
}

export function useSignatureRefresh() {
  const docId = useDoc((s) => s.doc?.id);
  const sigDoc = useSignatures((s) => s.docId);
  useEffect(() => {
    if (docId && sigDoc !== docId) void refreshSignatures();
  }, [docId, sigDoc]);
}

export function SignaturePanel() {
  useSignatureRefresh();
  const { signatures, loading } = useSignatures();
  const modified = useDoc((s) => !!s.doc && s.doc.bytes !== s.doc.original);

  return (
    <div className="signature-panel">
      <div className="sig-actions">
        <button className="btn sm primary" onClick={() => runCommand("sign.document")}>
          <FileSignature size={14} /> Sign digitally…
        </button>
        <button className="btn sm" onClick={() => runCommand("sign.ids")}>
          <KeyRound size={14} /> Digital IDs
        </button>
      </div>
      {loading && (
        <div className="empty-panel muted">
          <Loader2 size={16} className="spin" /> Checking signatures…
        </div>
      )}
      {!loading && signatures && signatures.length === 0 && <div className="empty-panel muted">This document has no digital signatures.</div>}
      {modified && !!signatures?.length && (
        <div className="sig-note warn">The document has unsaved edits that rewrite it; saving them will invalidate the signatures.</div>
      )}
      {signatures?.map((s, i) => {
        const st = STATUS[s.status];
        const Icon = st.icon;
        return (
          <div key={i} className={`sig-item ${st.cls}`} onClick={() => s.page && viewer.scrollToPage(s.page - 1)}>
            <div className="sig-head">
              <Icon size={18} />
              <div>
                <div className="sig-name">{s.cms.signer ?? s.name ?? s.field}</div>
                <div className="sig-status">{st.label}</div>
              </div>
            </div>
            <div className="sig-summary">{s.summary}</div>
            <dl>
              {s.reason && (
                <>
                  <dt>Reason</dt>
                  <dd>{s.reason}</dd>
                </>
              )}
              {s.location && (
                <>
                  <dt>Location</dt>
                  <dd>{s.location}</dd>
                </>
              )}
              <dt>Signed</dt>
              <dd>{s.cms.signingTime ? s.cms.signingTime.toLocaleString() : pdfDateToLocal(s.time) ?? "—"}</dd>
              {s.cms.issuer && (
                <>
                  <dt>Certificate</dt>
                  <dd>
                    {s.cms.selfSigned ? "Self-signed" : `Issued by ${s.cms.issuer}`}
                    {s.cms.notAfter && `, valid until ${s.cms.notAfter.toLocaleDateString()}`}
                  </dd>
                </>
              )}
              {s.cms.digestAlgorithm && (
                <>
                  <dt>Algorithm</dt>
                  <dd>
                    {s.cms.digestAlgorithm} · {s.subFilter ?? "—"}
                  </dd>
                </>
              )}
              {s.page > 0 && (
                <>
                  <dt>Page</dt>
                  <dd>{s.page}</dd>
                </>
              )}
            </dl>
          </div>
        );
      })}
    </div>
  );
}

/** Thin status bar above the document when it carries signatures. */
export function SignatureBanner() {
  useSignatureRefresh();
  const sigs = useSignatures((s) => s.signatures);
  if (!sigs?.length) return null;
  const st = overallStatus(sigs);
  const info = STATUS[st];
  const Icon = info.icon;
  const text =
    st === "invalid"
      ? "At least one signature is invalid: the document was altered after signing."
      : st === "valid-modified"
        ? `Signed by ${sigs.map((s) => s.cms.signer ?? s.name).join(", ")} — changes were made after a signature.`
        : st === "unsupported"
          ? "Signed — some signatures could not be fully checked."
          : `Signed by ${sigs.map((s) => s.cms.signer ?? s.name).join(", ")} — not changed since signing.`;
  return (
    <div className={`sig-banner ${info.cls}`}>
      <Icon size={16} />
      <span>{text}</span>
      <button className="link-btn" onClick={() => runCommand("sign.panel")}>
        Signature panel
      </button>
    </div>
  );
}
