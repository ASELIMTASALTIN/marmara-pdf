/**
 * The assistant's agent loop: sends the conversation and the tools to the
 * local model, runs the tool calls it makes on the open document, feeds the
 * results back, and repeats until the model answers in plain text.
 */
import { newId } from "../core/ids";
import { useDoc } from "../state/documentStore";
import { useUi } from "../state/uiStore";
import { useAssistant, type ChatItem } from "../state/assistantStore";
import { chat, type ChatMessage } from "./client";
import { runTool, TOOL_SPECS } from "./tools";

const MAX_STEPS = 8;
const MAX_HISTORY = 24;

function systemPrompt(): string {
  const { doc } = useDoc.getState();
  const page = useUi.getState().currentPage + 1;
  const docLine = doc
    ? `The open document is "${doc.name}" with ${doc.pageIds.length} page${doc.pageIds.length === 1 ? "" : "s"}; the user is looking at page ${page}.`
    : "No document is open; ask the user to open a PDF first.";
  return [
    "You are Marmara Assistant, the AI built into Marmara PDF, a PDF editor. Everything runs locally on the user's computer.",
    docLine,
    "Use the tools to do what the user asks on that document. You may call several tools one after another. Do simple, undoable edits right away without asking for confirmation.",
    "To answer questions about the content (summaries, translations, facts), read the text first with read_text.",
    "Only say you did something when the tool result has ok: true. If a tool fails, briefly say why and what the user can do.",
    "Never guess what the document contains: call a tool (e.g. find_text or read_text) before saying something is or is not in it. When asked to act on some text, call the action tool directly; it reports if the text is missing.",
    "Page numbers start at 1. Every change can be undone with Ctrl+Z.",
    "Reply briefly, in the same language as the user (Turkish when they write Turkish).",
  ].join("\n");
}

const set = useAssistant.setState;

function push(item: Omit<ChatItem, "id">): string {
  const id = newId();
  set((s) => ({ items: [...s.items, { ...item, id }] }));
  return id;
}

function patch(id: string, p: Partial<ChatItem>) {
  set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, ...p } : i)) }));
}

/** Shrinks old tool results so long conversations fit the context window. */
function compact(history: ChatMessage[]): ChatMessage[] {
  const h = history.slice(-MAX_HISTORY);
  while (h.length && h[0].role === "tool") h.shift();
  return h.map((m, i) => (m.role === "tool" && i < h.length - 6 && m.content.length > 400 ? { ...m, content: m.content.slice(0, 400) + "…" } : m));
}

let controller: AbortController | null = null;

export function stopAgent() {
  controller?.abort();
}

export async function send(text: string): Promise<void> {
  const st = useAssistant.getState();
  if (st.busy || !text.trim()) return;
  const ep = st.endpoint;
  push({ kind: "user", text: text.trim() });
  if (!ep) {
    push({ kind: "error", text: "The AI engine is not ready yet." });
    return;
  }
  controller = new AbortController();
  const signal = controller.signal;
  set({ busy: true, thinking: true });
  let history: ChatMessage[] = [...st.history, { role: "user", content: text.trim() }];
  let answerId: string | null = null;
  const recent: string[] = [];
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      answerId = null;
      set({ thinking: true });
      const res = await chat(ep, [{ role: "system", content: systemPrompt() }, ...compact(history)], TOOL_SPECS, {
        signal,
        onText: (t) => {
          set({ thinking: false });
          if (!answerId) answerId = push({ kind: "assistant", text: t, pending: true });
          else patch(answerId, { text: t });
        },
      });
      if (res.tokensPerSecond) set({ speed: res.tokensPerSecond });
      if (!res.toolCalls.length) {
        const answer = res.content || "(no answer)";
        if (answerId) patch(answerId, { text: answer, pending: false });
        else push({ kind: "assistant", text: answer });
        history = [...history, { role: "assistant", content: answer }];
        break;
      }
      if (answerId) patch(answerId, { pending: false });
      history = [...history, { role: "assistant", content: res.content, tool_calls: res.toolCalls }];
      for (const call of res.toolCalls) {
        const key = `${call.function.name}:${call.function.arguments}`;
        const stepId = push({ kind: "tool", text: humanName(call.function.name), pending: true });
        let result: Record<string, unknown>;
        let summary: string;
        if (recent.filter((k) => k === key).length >= 2) {
          result = { ok: false, error: "This exact action was already done twice; do not repeat it." };
          summary = "Skipped a repeated action";
        } else {
          ({ result, summary } = await runTool(call.function.name, call.function.arguments));
        }
        recent.push(key);
        patch(stepId, { text: summary, ok: !!result.ok, pending: false });
        history = [...history, { role: "tool", tool_call_id: call.id, name: call.function.name, content: JSON.stringify(result) }];
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      }
      if (step === MAX_STEPS - 1) push({ kind: "error", text: "Stopped after too many steps." });
    }
  } catch (e) {
    if ((e as Error)?.name === "AbortError") push({ kind: "error", text: "Stopped." });
    else push({ kind: "error", text: (e as Error)?.message || String(e) });
    if (answerId) patch(answerId, { pending: false });
  } finally {
    controller = null;
    set({ busy: false, thinking: false, history: compact(history) });
  }
}

export function newChat() {
  stopAgent();
  set({ items: [], history: [] });
}

function humanName(tool: string): string {
  return tool.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) + "…";
}
