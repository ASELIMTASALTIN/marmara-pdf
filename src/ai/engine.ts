/**
 * Starts the local AI engine through the platform layer and waits until the
 * model is loaded. State is published in the assistant store.
 */
import { platform } from "../platform";
import { useAssistant } from "../state/assistantStore";
import { engineHealthy } from "./client";

let connecting: Promise<boolean> | null = null;

const set = useAssistant.setState;
const modelName = (path: string | null | undefined) => (path ? path.split(/[\\/]/).pop()!.replace(/\.gguf$/i, "") : null);

/** Ensures the engine is running and the model is loaded. Resolves true when ready. */
export function connectEngine(opts: { model?: string; restart?: boolean } = {}): Promise<boolean> {
  if (connecting && !opts.restart) return connecting;
  connecting = (async () => {
    try {
      set({ engine: "checking", detail: null });
      let status = await platform.ai.status();
      set({ status });
      if (!status.engine) {
        set({ engine: "missing-engine", detail: "The AI engine is not installed with this copy of Marmara PDF." });
        return false;
      }
      if (opts.restart) {
        await platform.ai.stop();
        status = await platform.ai.status();
      }
      if (!status.running) {
        const model = opts.model ?? status.selected ?? undefined;
        if (!model && !status.models.length) {
          set({ engine: "missing-model", detail: "No AI model (.gguf) was found." });
          return false;
        }
        set({ engine: "starting", detail: modelName(model) });
        status = await platform.ai.start({ model, gpu: useAssistant.getState().useGpu });
        set({ status });
      }
      if (!status.baseUrl) {
        set({ engine: "error", detail: status.error ?? "The AI engine did not start." });
        return false;
      }
      const ep = { baseUrl: status.baseUrl, key: status.key };
      set({ engine: "loading", detail: modelName(status.selected) });
      const started = Date.now();
      for (let i = 0; ; i++) {
        const h = await engineHealthy(ep);
        if (h === "ok") break;
        if (i % 4 === 3) {
          const s = await platform.ai.status();
          if (!s.running) {
            set({ engine: "error", detail: s.error ?? "The AI engine stopped while loading the model.", status: s });
            return false;
          }
        }
        if (Date.now() - started > 240_000) {
          set({ engine: "error", detail: "Loading the model took too long." });
          return false;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      set({ engine: "ready", endpoint: ep, detail: modelName(status.selected) });
      return true;
    } catch (e) {
      set({ engine: "error", detail: (e as Error)?.message || String(e) });
      return false;
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}

/** The model the assistant was built and tested with (Apache-2.0, ~3.1 GB). */
export const DEFAULT_MODEL = {
  name: "Gemma 4 E2B heretic-ara (Q4_K_S)",
  file: "gemma-4-E2B-it-heretic-ara.Q4_K_S.gguf",
  url: "https://huggingface.co/mradermacher/gemma-4-E2B-it-heretic-ara-GGUF/resolve/main/gemma-4-E2B-it-heretic-ara.Q4_K_S.gguf",
  size: 3365070080,
};

/** Downloads the default model, then starts the engine with it. */
export async function downloadDefaultModel(): Promise<void> {
  set({ download: { received: 0, total: DEFAULT_MODEL.size }, detail: null });
  try {
    const path = await platform.ai.downloadModel(DEFAULT_MODEL.url, DEFAULT_MODEL.file, (received, total) => set({ download: { received, total: total ?? DEFAULT_MODEL.size } }));
    set({ download: null });
    await connectEngine({ model: path, restart: true });
  } catch (e) {
    const msg = (e as Error)?.message || String(e);
    set({ download: null, engine: msg === "Cancelled" ? "missing-model" : "error", detail: msg === "Cancelled" ? "Download cancelled." : msg });
  }
}

export function cancelDownload() {
  void platform.ai.cancelDownload();
}

export async function chooseModelFile(): Promise<void> {
  const path = await platform.ai.pickModel();
  if (!path) return;
  await platform.ai.setModel(path);
  await connectEngine({ model: path, restart: true });
}

export async function switchModel(path: string): Promise<void> {
  await platform.ai.setModel(path);
  await connectEngine({ model: path, restart: true });
}

export async function setGpu(on: boolean): Promise<void> {
  localStorage.setItem("marmara.aiGpu", on ? "1" : "0");
  set({ useGpu: on });
  if (useAssistant.getState().engine === "ready") await connectEngine({ restart: true });
}

export async function stopEngine(): Promise<void> {
  await platform.ai.stop();
  set({ engine: "idle", endpoint: null });
}
