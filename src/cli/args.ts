import { UsageError, type Args, type Command, type Param } from "./registry";

const flagName = (key: string) => key.replace(/_/g, "-");

function parseNumbers(v: string, n: number, what: string): number[] {
  const parts = v.split(/[\s,;]+/).filter(Boolean).map(Number);
  if (parts.length !== n || parts.some((x) => !Number.isFinite(x))) throw new UsageError(`Expected ${what}, got "${v}"`);
  return parts;
}

/** Converts a raw value (CLI string or MCP JSON value) to the declared type. */
export function coerce(key: string, p: Param, raw: unknown): unknown {
  const bad = (what: string) => new UsageError(`${flagName(key)}: expected ${what}, got ${JSON.stringify(raw)}`);
  switch (p.type) {
    case "string":
    case "path": {
      if (typeof raw === "number") raw = String(raw);
      if (typeof raw !== "string") throw bad("a string");
      if (p.enum && !p.enum.includes(raw)) throw new UsageError(`${flagName(key)}: must be one of ${p.enum.join(", ")} (got "${raw}")`);
      return raw;
    }
    case "number":
    case "integer": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
      if (!Number.isFinite(n) || (p.type === "integer" && !Number.isInteger(n))) throw bad(p.type === "integer" ? "a whole number" : "a number");
      return n;
    }
    case "boolean": {
      if (typeof raw === "boolean") return raw;
      if (typeof raw === "string" && /^(true|yes|1|on)$/i.test(raw)) return true;
      if (typeof raw === "string" && /^(false|no|0|off)$/i.test(raw)) return false;
      throw bad("true or false");
    }
    case "string[]":
    case "path[]": {
      const list = Array.isArray(raw) ? raw : [raw];
      return list.map((x) => {
        if (typeof x === "number") return String(x);
        if (typeof x !== "string") throw bad("a list of strings");
        return x;
      });
    }
    case "rect": {
      if (Array.isArray(raw) && raw.length === 4 && raw.every((x) => typeof x === "number")) return raw;
      if (typeof raw === "string") return parseNumbers(raw, 4, '"x0,y0,x1,y1"');
      throw bad('a rectangle "x0,y0,x1,y1"');
    }
    case "point": {
      if (Array.isArray(raw) && raw.length === 2 && raw.every((x) => typeof x === "number")) return raw;
      if (typeof raw === "string") return parseNumbers(raw, 2, '"x,y"');
      throw bad('a point "x,y"');
    }
    case "json": {
      if (typeof raw !== "string") return raw;
      try {
        return JSON.parse(raw);
      } catch {
        throw bad("valid JSON");
      }
    }
  }
}

/** Applies defaults and checks required parameters. */
export function finalize(cmd: Command, args: Args): Args {
  const out: Args = {};
  for (const [key, p] of Object.entries(cmd.params)) {
    let v = args[key];
    if (v === undefined || v === null) v = p.default;
    if (v !== undefined) out[key] = coerce(key, p, v);
    else if (p.required) throw new UsageError(`Missing required ${p.positional ? "argument" : "option"} ${p.positional ? `<${key}>` : `--${flagName(key)}`}. See: marmara help ${cmd.name}`);
  }
  for (const key of Object.keys(args)) if (!(key in cmd.params)) throw new UsageError(`Unknown option "${key}" for ${cmd.name}`);
  return out;
}

/** Parses command-line arguments for a command. */
export function parseArgv(cmd: Command, argv: string[]): Args {
  const params = cmd.params;
  const byFlag = new Map<string, string>();
  for (const [key, p] of Object.entries(params)) {
    byFlag.set(flagName(key), key);
    if (p.short) byFlag.set(p.short, key);
  }
  const positional = Object.entries(params).filter(([, p]) => p.positional);
  const raw: Args = {};
  const push = (key: string, value: unknown) => {
    const p = params[key];
    if (p.type === "string[]" || p.type === "path[]") raw[key] = [...((raw[key] as string[]) ?? []), value];
    else raw[key] = value;
  };
  let pos = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      for (const rest of argv.slice(i + 1)) addPositional(rest);
      break;
    }
    const long = /^--([^=]+)(?:=(.*))?$/s.exec(a);
    const short = /^-([a-zA-Z])$/.exec(a);
    if (long || short) {
      let flag = long ? long[1] : short![1];
      let inline: string | undefined = long ? long[2] : undefined;
      let key = byFlag.get(flag);
      if (!key && long && flag.startsWith("no-") && byFlag.has(flag.slice(3)) && params[byFlag.get(flag.slice(3))!].type === "boolean") {
        key = byFlag.get(flag.slice(3))!;
        inline = "false";
        flag = flag.slice(3);
      }
      if (!key) throw new UsageError(`Unknown option --${flag} for ${cmd.name}. See: marmara help ${cmd.name}`);
      const p = params[key];
      if (p.type === "boolean") {
        push(key, inline ?? (argv[i + 1] && /^(true|false|yes|no)$/i.test(argv[i + 1]) ? argv[++i] : "true"));
        continue;
      }
      if (inline === undefined) {
        if (i + 1 >= argv.length) throw new UsageError(`Option --${flag} needs a value`);
        inline = argv[++i];
      }
      push(key, inline);
      continue;
    }
    addPositional(a);
  }

  function addPositional(a: string) {
    const entry = positional[Math.min(pos, positional.length - 1)];
    if (!entry || (pos >= positional.length && entry[1].type !== "path[]" && entry[1].type !== "string[]"))
      throw new UsageError(`Unexpected argument "${a}". See: marmara help ${cmd.name}`);
    push(entry[0], a);
    if (entry[1].type !== "path[]" && entry[1].type !== "string[]") pos++;
  }

  return finalize(cmd, raw);
}

export { flagName };
