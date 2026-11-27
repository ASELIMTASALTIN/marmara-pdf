/**
 * Minimal Model Context Protocol server over stdio (newline-delimited
 * JSON-RPC 2.0). Every CLI command is exposed as a tool named pdf_<command>.
 * Calls run one at a time; stdout carries protocol messages only.
 */
import { createInterface } from "node:readline";
import { finalize } from "./args";
import { COORDINATES, inputSchema } from "./describe";
import { allCommands, getCommand, UsageError, type Context } from "./registry";

const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
const toolName = (cmd: string) => `pdf_${cmd.replace(/-/g, "_")}`;
const byTool = () => new Map(allCommands().map((c) => [toolName(c.name), c]));

type Msg = { jsonrpc: "2.0"; id?: number | string | null; method?: string; params?: Record<string, unknown> };

export async function runMcp(version: string, ctx: Context): Promise<void> {
  const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");
  const reply = (id: Msg["id"], result: unknown) => send({ jsonrpc: "2.0", id, result });
  const fail = (id: Msg["id"], code: number, message: string) => send({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  const tools = byTool();

  const instructions = [
    "Marmara PDF: local, offline PDF editing (nothing is uploaded).",
    "Use absolute file paths.",
    "Tools that change a document never modify the input: they write a new file (returned as `output`) unless `overwrite` is true without an `output` path.",
    "Chain edits by passing the previous `output` as the next `input`.",
    "Pages are 1-based.",
    COORDINATES,
    "Start with pdf_info; use pdf_text / pdf_search to read, pdf_to_images to look at a page.",
    ctx.roots?.length ? `File access is limited to: ${ctx.roots.join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  async function handle(msg: Msg) {
    const { id, method, params } = msg;
    const isRequest = id !== undefined && id !== null;
    switch (method) {
      case "initialize": {
        const asked = String(params?.protocolVersion ?? "");
        return reply(id, {
          protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "marmara-pdf", title: "Marmara PDF", version },
          instructions,
        });
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return;
      case "ping":
        return reply(id, {});
      case "tools/list":
        return reply(id, {
          tools: [...tools].map(([name, c]) => ({
            name,
            title: c.name,
            description: c.summary + (c.details ? ` ${c.details}` : ""),
            inputSchema: inputSchema(c),
            annotations: { readOnlyHint: !!c.readOnly, destructiveHint: false, idempotentHint: !!c.readOnly, openWorldHint: false },
          })),
        });
      case "tools/call": {
        const name = String(params?.name ?? "");
        const cmd = tools.get(name) ?? getCommand(name);
        if (!cmd) return fail(id, -32602, `Unknown tool: ${name}`);
        try {
          const args = finalize(cmd, (params?.arguments as Record<string, unknown>) ?? {});
          const result = { ok: true, ...(await cmd.run(args, ctx)) };
          return reply(id, { content: [{ type: "text", text: JSON.stringify(result, null, 1) }], structuredContent: result, isError: false });
        } catch (e) {
          const error = (e as Error).message || String(e);
          const result = { ok: false, error };
          if (!(e instanceof UsageError)) process.stderr.write(`[marmara mcp] ${name}: ${(e as Error).stack ?? error}\n`);
          return reply(id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: true });
        }
      }
      default:
        if (isRequest) return fail(id, -32601, `Method not found: ${method}`);
    }
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let queue = Promise.resolve();
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: Msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return fail(null, -32700, "Parse error");
    }
    queue = queue
      .then(async () => {
        await handle(msg);
      })
      .catch((e) => {
        process.stderr.write(`[marmara mcp] ${e}\n`);
      });
  });
  await new Promise<void>((done) => rl.on("close", () => void queue.then(done)));
}
