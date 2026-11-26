import { useEffect, useRef, useState } from "react";
import { Eraser, Trash2, Upload } from "lucide-react";
import { openDialog } from "../../state/dialogStore";
import { platform } from "../../platform";

const STORE_KEY = "marmara.signatures";
const FONTS = ["Segoe Script", "Lucida Handwriting", "Ink Free", "Brush Script MT", "cursive"];

export interface SignatureImage {
  dataUrl: string;
  width: number;
  height: number;
}

function savedSignatures(): SignatureImage[] {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
  } catch {
    return [];
  }
}
function storeSignatures(list: SignatureImage[]) {
  localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, 6)));
}

/** Crops transparent margins of a canvas and returns a PNG. */
function trimCanvas(src: HTMLCanvasElement): SignatureImage | null {
  const ctx = src.getContext("2d")!;
  const { width, height } = src;
  const data = ctx.getImageData(0, 0, width, height).data;
  let x0 = width,
    y0 = height,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[(y * width + x) * 4 + 3] > 10) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return null;
  const pad = 6;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad);
  y1 = Math.min(height - 1, y1 + pad);
  const out = document.createElement("canvas");
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext("2d")!.drawImage(src, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return { dataUrl: out.toDataURL("image/png"), width: out.width / 2, height: out.height / 2 };
}

function bytesToDataUrl(bytes: Uint8Array, name: string): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const mime = /\.png$/i.test(name) || (bytes[0] === 0x89 && bytes[1] === 0x50) ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${btoa(bin)}`;
}

export function loadImageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("The image could not be read"));
    img.src = dataUrl;
  });
}

export async function pickImageFile(): Promise<SignatureImage | null> {
  const f = await platform.pickImage();
  if (!f) return null;
  const dataUrl = bytesToDataUrl(f.bytes, f.name);
  const size = await loadImageSize(dataUrl);
  return { dataUrl, ...size };
}

type Result = { current: SignatureImage | null };

function SignaturePad({ result }: { result: Result }) {
  const [tab, setTab] = useState<"draw" | "type" | "saved">(savedSignatures().length ? "saved" : "draw");
  const [saved, setSaved] = useState(savedSignatures);
  const [name, setName] = useState("");
  const [font, setFont] = useState(FONTS[0]);
  const [remember, setRemember] = useState(true);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef<{ x: number; y: number } | null>(null);
  const [hasInk, setHasInk] = useState(false);
  const [chosen, setChosen] = useState<number | null>(null);

  const W = 480;
  const H = 170;

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    c.width = W * 2;
    c.height = H * 2;
    const ctx = c.getContext("2d")!;
    ctx.scale(2, 2);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0b1f4b";
    ctx.lineWidth = 2.4;
    if (tab === "type") {
      ctx.clearRect(0, 0, W, H);
      if (name.trim()) {
        ctx.fillStyle = "#0b1f4b";
        let size = 64;
        ctx.font = `${size}px "${font}"`;
        while (ctx.measureText(name).width > W - 30 && size > 18) ctx.font = `${(size -= 2)}px "${font}"`;
        ctx.textBaseline = "middle";
        ctx.fillText(name, 15, H / 2);
      }
      result.current = name.trim() ? trimCanvas(c) : null;
    }
    setHasInk(false);
  }, [tab, name, font]);

  // Keep the result up to date for the dialog's "Use" button.
  const sync = (remembered = remember) => {
    if (tab === "saved") {
      result.current = chosen !== null ? saved[chosen] : null;
      return;
    }
    const c = canvasRef.current;
    const img = c ? trimCanvas(c) : null;
    result.current = img;
    (result as Result & { remember?: boolean }).remember = remembered;
  };

  const pos = (e: React.PointerEvent) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  return (
    <div className="signature-pad">
      <div className="seg-tabs" role="tablist">
        {saved.length > 0 && (
          <button className={tab === "saved" ? "active" : ""} onClick={() => setTab("saved")}>
            Saved
          </button>
        )}
        <button className={tab === "draw" ? "active" : ""} onClick={() => setTab("draw")}>
          Draw
        </button>
        <button className={tab === "type" ? "active" : ""} onClick={() => setTab("type")}>
          Type
        </button>
        <button
          onClick={async () => {
            const img = await pickImageFile();
            if (img) {
              const list = [img, ...saved];
              storeSignatures(list);
              setSaved(list);
              setChosen(0);
              setTab("saved");
              result.current = img;
            }
          }}
        >
          <Upload size={13} /> Upload image
        </button>
      </div>

      {tab === "saved" ? (
        <div className="saved-signatures">
          {saved.map((s, i) => (
            <div key={i} className={`saved-sig${chosen === i ? " active" : ""}`} onClick={() => { setChosen(i); result.current = s; }}>
              <img src={s.dataUrl} alt="Saved signature" />
              <button
                className="row-action"
                title="Delete saved signature"
                onClick={(e) => {
                  e.stopPropagation();
                  const list = saved.filter((_, k) => k !== i);
                  storeSignatures(list);
                  setSaved(list);
                  setChosen(null);
                  result.current = null;
                  if (!list.length) setTab("draw");
                }}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <>
          {tab === "type" && (
            <div className="type-row">
              <input autoFocus placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => sync()} />
              <select value={font} onChange={(e) => setFont(e.target.value)}>
                {FONTS.map((f) => (
                  <option key={f} value={f} style={{ fontFamily: f }}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="sig-canvas-wrap">
            <canvas
              ref={canvasRef}
              className="sig-canvas"
              style={{ width: W, height: H, cursor: tab === "draw" ? "crosshair" : "default" }}
              onPointerDown={(e) => {
                if (tab !== "draw") return;
                e.currentTarget.setPointerCapture(e.pointerId);
                drawing.current = pos(e);
              }}
              onPointerMove={(e) => {
                if (!drawing.current) return;
                const p = pos(e);
                const ctx = canvasRef.current!.getContext("2d")!;
                ctx.beginPath();
                ctx.moveTo(drawing.current.x, drawing.current.y);
                ctx.lineTo(p.x, p.y);
                ctx.stroke();
                drawing.current = p;
                setHasInk(true);
              }}
              onPointerUp={() => {
                drawing.current = null;
                sync();
              }}
            />
            <div className="sig-baseline" />
            {tab === "draw" && hasInk && (
              <button
                className="btn sm sig-clear"
                onClick={() => {
                  const c = canvasRef.current!;
                  c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
                  setHasInk(false);
                  result.current = null;
                }}
              >
                <Eraser size={13} /> Clear
              </button>
            )}
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => {
                setRemember(e.target.checked);
                sync(e.target.checked);
              }}
            />
            Save this signature on this computer
          </label>
        </>
      )}
    </div>
  );
}

/** Asks the user for a signature. Resolves to a trimmed PNG or null. */
export async function chooseSignature(): Promise<SignatureImage | null> {
  const result: Result & { remember?: boolean } = { current: null, remember: true };
  const r = await openDialog({
    title: "Add signature",
    body: () => <SignaturePad result={result} />,
    buttons: [
      { id: "cancel", label: "Cancel" },
      { id: "ok", label: "Use signature", variant: "primary" },
    ],
    validate: (_v, b) => (b === "ok" && !result.current ? "Draw, type or choose a signature first" : null),
    width: 540,
  });
  if (r.button !== "ok" || !result.current) return null;
  if (result.remember) {
    const list = savedSignatures();
    if (!list.some((s) => s.dataUrl === result.current!.dataUrl)) storeSignatures([result.current, ...list]);
  }
  return result.current;
}
