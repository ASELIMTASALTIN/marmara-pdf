import "./commands/inspect";
import "./commands/pages";
import "./commands/edit";
import "./commands/comments";
import "./commands/forms";
import "./commands/stamps";
import "./commands/security";
import "./commands/optimize";
import "./commands/convert";
import { finalize, parseArgv } from "./args";
import { commandHelp, describeAll, markdown, overview } from "./describe";
import { runMcp } from "./mcp";
import { allCommands, getCommand, UsageError, type Context } from "./registry";

declare const __APP_VERSION__: string;
export const VERSION = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";

/** Keeps stdout clean for JSON / MCP: library chatter goes to stderr. */
function protectStdout() {
  const toErr = (...a: unknown[]) => process.stderr.write(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n");
  console.log = console.info = console.warn = console.debug = toErr;
}

function suggest(name: string): string {
  const names = allCommands().map((c) => c.name);
  const close = names.filter((n) => n.includes(name) || name.includes(n) || dist(n, name) <= 2);
  return close.length ? ` Did you mean: ${close.slice(0, 4).join(", ")}?` : "";
}

function dist(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export interface RunOutput {
  code: number;
  stdout: string;
}

/** Runs one CLI invocation and returns its exit code and stdout text. */
export async function run(argv: string[], cwd = process.cwd()): Promise<RunOutput> {
  let verbose = false;
  let compact = false;
  const rest: string[] = [];
  for (const a of argv) {
    if (a === "--verbose") verbose = true;
    else if (a === "--compact") compact = true;
    else rest.push(a);
  }
  const json = (v: unknown) => JSON.stringify(v, null, compact ? 0 : 2);
  const ctx: Context = { cwd, progress: verbose ? (m) => process.stderr.write(`${m}\n`) : () => {} };
  const [name, ...args] = rest;

  if (!name || name === "help" || name === "--help" || name === "-h") {
    const c = args[0] ? getCommand(args[0]) : undefined;
    if (args[0] && !c) return { code: 2, stdout: json({ ok: false, error: `Unknown command "${args[0]}".${suggest(args[0])}` }) };
    return { code: 0, stdout: c ? commandHelp(c) : overview(VERSION) };
  }
  if (name === "--version" || name === "version") return { code: 0, stdout: VERSION };
  if (name === "commands") return { code: 0, stdout: json(describeAll()) };
  if (name === "docs") return { code: 0, stdout: markdown(VERSION) };
  if (name === "call") {
    // JSON arguments, as produced by tool-calling LLMs: marmara call <command> '<json>' (or "-" / nothing = stdin).
    const cmd = args[0] ? getCommand(args[0].replace(/^pdf_/, "").replace(/_/g, "-")) : undefined;
    if (!cmd) return { code: 2, stdout: json({ ok: false, error: args[0] ? `Unknown command "${args[0]}".${suggest(args[0])}` : 'Usage: marmara call <command> \'{"input": "…", …}\'' }) };
    try {
      const text = args[1] && args[1] !== "-" ? args[1] : await readStdin();
      const parsed = text.trim() ? JSON.parse(text) : {};
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new UsageError("The arguments must be a JSON object.");
      const result = await cmd.run(finalize(cmd, parsed), ctx);
      return { code: 0, stdout: json({ ok: true, command: cmd.name, ...result }) };
    } catch (e) {
      const message = e instanceof SyntaxError ? `Invalid JSON arguments: ${e.message}` : (e as Error)?.message || String(e);
      return { code: e instanceof UsageError || e instanceof SyntaxError ? 2 : 1, stdout: json({ ok: false, command: cmd.name, error: message }) };
    }
  }

  const cmd = getCommand(name);
  if (!cmd) return { code: 2, stdout: json({ ok: false, error: `Unknown command "${name}".${suggest(name)} Run "marmara help" for the list.` }) };
  if (args.includes("--help") || args.includes("-h")) return { code: 0, stdout: commandHelp(cmd) };
  try {
    const parsed = parseArgv(cmd, args);
    const result = await cmd.run(parsed, ctx);
    return { code: 0, stdout: json({ ok: true, command: cmd.name, ...result }) };
  } catch (e) {
    const usage = e instanceof UsageError;
    const message = (e as Error)?.message || String(e);
    if (!usage && verbose) process.stderr.write(`${(e as Error)?.stack ?? message}\n`);
    return { code: usage ? 2 : 1, stdout: json({ ok: false, command: cmd.name, error: message }) };
  }
}

export async function main(argv: string[]): Promise<void> {
  protectStdout();
  // Last resort (e.g. an error thrown inside a worker thread): still answer in JSON.
  process.on("uncaughtException", (e) => {
    const error = (e as Error)?.message || String(e);
    if (argv[0] === "mcp") {
      process.stderr.write(`[marmara mcp] ${(e as Error)?.stack ?? error}\n`);
      return;
    }
    process.stdout.write(JSON.stringify({ ok: false, command: argv[0], error }) + "\n", () => process.exit(1));
  });
  if (argv[0] === "mcp") {
    const roots: string[] = [];
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === "--root" && argv[i + 1]) roots.push(argv[++i]);
      else if (argv[i].startsWith("--root=")) roots.push(argv[i].slice(7));
      else {
        process.stderr.write(`Unknown option for mcp: ${argv[i]}\nUsage: marmara mcp [--root <folder>]…\n`);
        process.exit(2);
      }
    }
    const { resolve } = await import("node:path");
    await runMcp(VERSION, { cwd: process.cwd(), progress: () => {}, roots: roots.map((r) => resolve(r)) });
    process.exit(0);
  }
  const { code, stdout } = await run(argv);
  process.stdout.write(stdout + "\n", () => process.exit(code));
}
