import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowUp, Check, Cpu, Download, FolderOpen, Loader2, RotateCcw, Settings2, Sparkles, Square, Wrench, X } from "lucide-react";
import { useAssistant, type ChatItem } from "../../state/assistantStore";
import { cancelDownload, chooseModelFile, connectEngine, DEFAULT_MODEL, downloadDefaultModel, setGpu, switchModel } from "../../ai/engine";
import { newChat, send, stopAgent } from "../../ai/agent";
import { IconButton } from "../common/IconButton";

const NO_MODELS: never[] = [];

const SUGGESTIONS = [
  "Bu sayfayı özetle",
  "Her sayfanın altına sayfa numarası ekle",
  "“önemli” kelimesini vurgula",
  "Formdaki alanları listele",
];

export function AssistantPanel() {
  const engine = useAssistant((s) => s.engine);
  const items = useAssistant((s) => s.items);
  const busy = useAssistant((s) => s.busy);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    if (useAssistant.getState().engine === "idle") void connectEngine();
  }, []);

  return (
    <aside className="assistant" aria-label="Assistant">
      <header className="assistant-head">
        <Sparkles size={16} className="assistant-logo" />
        <span className="assistant-title">Assistant</span>
        <EngineBadge />
        <span className="assistant-spacer" />
        <IconButton icon={RotateCcw} label="New conversation" size={15} disabled={!items.length && !busy} onClick={newChat} />
        <IconButton icon={Settings2} label="Model settings" size={15} active={showSettings} onClick={() => setShowSettings((v) => !v)} />
        <IconButton icon={X} label="Close assistant" command="view.assistant" size={15} onClick={() => useAssistant.setState({ open: false })} />
      </header>
      {showSettings && <ModelSettings onClose={() => setShowSettings(false)} />}
      {engine === "ready" ? <Conversation /> : <EngineCard />}
      <Composer />
    </aside>
  );
}

function EngineBadge() {
  const engine = useAssistant((s) => s.engine);
  const speed = useAssistant((s) => s.speed);
  const gpu = useAssistant((s) => s.status?.gpu);
  if (engine === "ready")
    return (
      <span className="assistant-badge ok" title={speed ? `${speed.toFixed(0)} tokens/s` : undefined}>
        {gpu ? "GPU" : "CPU"}
        {speed ? ` · ${speed.toFixed(0)} t/s` : ""}
      </span>
    );
  if (engine === "starting" || engine === "loading" || engine === "checking") return <span className="assistant-badge">Loading…</span>;
  if (engine === "idle") return null;
  return <span className="assistant-badge warn">Offline</span>;
}

function EngineCard() {
  const engine = useAssistant((s) => s.engine);
  const detail = useAssistant((s) => s.detail);
  const models = useAssistant((s) => s.status?.models) ?? NO_MODELS;
  const download = useAssistant((s) => s.download);
  if (download) {
    const pct = download.total ? Math.min(100, (download.received / download.total) * 100) : 0;
    return (
      <div className="assistant-card">
        <Download size={22} className="assistant-logo" />
        <strong>Downloading the AI model…</strong>
        <span className="muted small">{DEFAULT_MODEL.name}</span>
        <div className="assistant-progress" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
          <div style={{ width: `${pct}%` }} />
        </div>
        <span className="muted small">
          {(download.received / 1024 ** 3).toFixed(2)} / {(download.total / 1024 ** 3).toFixed(2)} GB
        </span>
        <button className="btn" onClick={cancelDownload}>
          Cancel
        </button>
      </div>
    );
  }
  if (engine === "starting" || engine === "loading" || engine === "checking" || engine === "idle")
    return (
      <div className="assistant-card">
        <Loader2 size={22} className="spin" />
        <strong>{engine === "loading" ? "Loading the model…" : "Starting the AI engine…"}</strong>
        {detail && <span className="muted small">{detail}</span>}
        <span className="muted small">The first start takes a little longer. Everything runs on this computer.</span>
      </div>
    );
  return (
    <div className="assistant-card">
      <AlertTriangle size={22} className="warn-icon" />
      <strong>{engine === "missing-model" ? "No AI model found" : engine === "missing-engine" ? "AI engine not installed" : "The assistant could not start"}</strong>
      {detail && <pre className="assistant-detail">{detail}</pre>}
      {engine === "missing-model" && (
        <span className="muted small">
          Download {DEFAULT_MODEL.name} ({(DEFAULT_MODEL.size / 1024 ** 3).toFixed(1)} GB, once) from Hugging Face, or choose a GGUF model file you already have.
        </span>
      )}
      <div className="assistant-card-actions">
        {engine === "missing-model" && (
          <button className="btn primary" onClick={() => void downloadDefaultModel()}>
            <Download size={14} /> Download the model
          </button>
        )}
        {(engine === "missing-model" || engine === "error") && (
          <button className="btn" onClick={() => void chooseModelFile()}>
            <FolderOpen size={14} /> Choose model file…
          </button>
        )}
        {engine === "error" && models.length > 0 && (
          <button className="btn" onClick={() => void connectEngine({ restart: true })}>
            <RotateCcw size={14} /> Try again
          </button>
        )}
      </div>
    </div>
  );
}

function ModelSettings({ onClose }: { onClose: () => void }) {
  const status = useAssistant((s) => s.status);
  const useGpu = useAssistant((s) => s.useGpu);
  const busy = useAssistant((s) => s.busy);
  const selected = status?.selected?.toLowerCase();
  return (
    <div className="assistant-settings">
      <div className="assistant-settings-row">
        <strong>Model</strong>
        <button className="link-btn" onClick={() => void chooseModelFile().then(onClose)} disabled={busy}>
          Choose file…
        </button>
      </div>
      <div className="assistant-models">
        {(status?.models ?? []).map((m) => (
          <button
            key={m.path}
            className={`assistant-model${m.path.toLowerCase() === selected ? " current" : ""}`}
            disabled={busy}
            title={m.path}
            onClick={() => void switchModel(m.path).then(onClose)}
          >
            {m.path.toLowerCase() === selected ? <Check size={13} /> : <span className="assistant-model-dot" />}
            <span className="assistant-model-name">{m.name.replace(/\.gguf$/i, "")}</span>
            <span className="muted small">{(m.size / 1024 ** 3).toFixed(1)} GB</span>
          </button>
        ))}
        {!status?.models.length && <span className="muted small">No models found.</span>}
      </div>
      <label className="assistant-settings-row check">
        <input type="checkbox" checked={useGpu} disabled={busy} onChange={(e) => void setGpu(e.target.checked)} />
        <Cpu size={14} /> Use the graphics card (faster)
      </label>
    </div>
  );
}

function Conversation() {
  const items = useAssistant((s) => s.items);
  const thinking = useAssistant((s) => s.thinking);
  const busy = useAssistant((s) => s.busy);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [items, thinking]);
  return (
    <div className="assistant-chat">
      {!items.length && (
        <div className="assistant-empty">
          <Sparkles size={26} className="assistant-logo" />
          <p>Ask me to read, edit, annotate, fill or reorganise this PDF. I work offline and every change can be undone (Ctrl+Z).</p>
          <div className="assistant-suggestions">
            {SUGGESTIONS.map((s) => (
              <button key={s} className="assistant-chip" onClick={() => void send(s)}>
                {s}
              </button>
            ))}
          </div>
        </div>
      )}
      {items.map((i) => (
        <Message key={i.id} item={i} />
      ))}
      {busy && thinking && (
        <div className="assistant-thinking">
          <Loader2 size={13} className="spin" /> Thinking…
        </div>
      )}
      <div ref={end} />
    </div>
  );
}

function Message({ item }: { item: ChatItem }) {
  if (item.kind === "tool")
    return (
      <div className={`assistant-step${item.pending ? " pending" : item.ok ? " ok" : " failed"}`}>
        {item.pending ? <Loader2 size={13} className="spin" /> : item.ok ? <Wrench size={13} /> : <AlertTriangle size={13} />}
        <span>{item.text}</span>
      </div>
    );
  return <div className={`assistant-msg ${item.kind}`}>{item.text}</div>;
}

function Composer() {
  const engine = useAssistant((s) => s.engine);
  const busy = useAssistant((s) => s.busy);
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const ready = engine === "ready";
  useEffect(() => {
    if (ready) ref.current?.focus();
  }, [ready]);
  const submit = () => {
    if (!text.trim() || busy || !ready) return;
    void send(text);
    setText("");
  };
  return (
    <div className="assistant-composer">
      <textarea
        ref={ref}
        rows={2}
        value={text}
        placeholder={ready ? "Ne yapmamı istersiniz? (Enter: gönder)" : "Waiting for the AI engine…"}
        disabled={!ready}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      {busy ? (
        <button className="assistant-send stop" title="Stop" aria-label="Stop" onClick={stopAgent}>
          <Square size={14} />
        </button>
      ) : (
        <button className="assistant-send" title="Send (Enter)" aria-label="Send" disabled={!text.trim() || !ready} onClick={submit}>
          <ArrowUp size={16} />
        </button>
      )}
    </div>
  );
}
