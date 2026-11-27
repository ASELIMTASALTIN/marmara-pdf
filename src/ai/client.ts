/**
 * Minimal client for the local engine's OpenAI-compatible chat API (llama.cpp
 * server on 127.0.0.1). Streams the answer, the model's private reasoning and
 * tool calls as they are generated.
 */

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string; name: string };

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  tokensPerSecond?: number;
}

export interface Endpoint {
  baseUrl: string;
  key: string | null;
}

export async function engineHealthy(ep: Endpoint): Promise<"ok" | "loading" | "down"> {
  try {
    const r = await fetch(`${ep.baseUrl}/health`, { cache: "no-store" });
    if (r.ok) return "ok";
    return r.status === 503 ? "loading" : "down";
  } catch {
    return "down";
  }
}

/** One chat completion, streamed. `onText` receives the visible answer so far. */
export async function chat(
  ep: Endpoint,
  messages: ChatMessage[],
  tools: ToolSpec[],
  opts: { signal?: AbortSignal; onText?: (text: string) => void; onReasoning?: (text: string) => void; temperature?: number; maxTokens?: number } = {},
): Promise<ChatResult> {
  const res = await fetch(`${ep.baseUrl}/v1/chat/completions`, {
    method: "POST",
    signal: opts.signal,
    headers: { "content-type": "application/json", ...(ep.key ? { authorization: `Bearer ${ep.key}` } : {}) },
    body: JSON.stringify({
      messages,
      tools: tools.length ? tools : undefined,
      stream: true,
      temperature: opts.temperature ?? 0.3,
      top_p: 0.95,
      max_tokens: opts.maxTokens ?? 1536,
      chat_template_kwargs: { enable_thinking: true },
      timings_per_token: false,
    }),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    let msg = text;
    try {
      msg = JSON.parse(text).error?.message ?? text;
    } catch {
      /* not JSON */
    }
    throw new Error(`The AI engine answered ${res.status}: ${msg || res.statusText}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let content = "";
  let reasoning = "";
  let tps: number | undefined;
  const calls: { id: string; name: string; args: string }[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      let j: {
        choices?: { delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
        timings?: { predicted_per_second?: number };
        error?: { message?: string };
      };
      try {
        j = JSON.parse(data);
      } catch {
        continue;
      }
      if (j.error) throw new Error(j.error.message ?? "AI engine error");
      if (j.timings?.predicted_per_second) tps = j.timings.predicted_per_second;
      const d = j.choices?.[0]?.delta;
      if (!d) continue;
      if (d.reasoning_content) {
        reasoning += d.reasoning_content;
        opts.onReasoning?.(reasoning);
      }
      if (d.content) {
        content += d.content;
        opts.onText?.(content);
      }
      for (const tc of d.tool_calls ?? []) {
        const i = tc.index ?? calls.length;
        calls[i] ??= { id: tc.id ?? `call_${i}`, name: "", args: "" };
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) calls[i].name += tc.function.name;
        if (tc.function?.arguments) calls[i].args += tc.function.arguments;
      }
    }
  }
  return {
    content: content.trim(),
    reasoning,
    toolCalls: calls.filter(Boolean).map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } })),
    tokensPerSecond: tps,
  };
}
