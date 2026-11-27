/**
 * Command registry shared by the command line (`marmara <command> …`) and the
 * MCP server (`marmara mcp`). Every command declares its parameters once; the
 * CLI parser, the MCP tool schemas and the generated documentation are all
 * derived from these declarations.
 */

export type ParamType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  /** Repeatable string (`--set a=1 --set b=2`, or an array over MCP). */
  | "string[]"
  /** File path (resolved against the working directory). */
  | "path"
  /** One or more file paths. */
  | "path[]"
  /** Rectangle "x0,y0,x1,y1" in points, origin top-left of the displayed page. */
  | "rect"
  /** Point "x,y" in points, origin top-left of the displayed page. */
  | "point"
  /** JSON value (a string on the command line, any JSON over MCP). */
  | "json";

export interface Param {
  type: ParamType;
  description: string;
  required?: boolean;
  default?: unknown;
  enum?: readonly string[];
  /** Filled from positional arguments, in declaration order. */
  positional?: boolean;
  /** Single-letter short flag, e.g. "o" for -o. */
  short?: string;
  /** JSON Schema override for MCP (json parameters). */
  schema?: Record<string, unknown>;
}

export type Args = Record<string, unknown>;

export interface Context {
  /** Directory relative paths are resolved against. */
  cwd: string;
  /** Progress messages (stderr on the CLI, ignored over MCP). */
  progress: (message: string) => void;
  /** When set, every file read or written must lie inside one of these folders. */
  roots?: string[];
}

export type Result = Record<string, unknown>;

export interface Command {
  name: string;
  group: Group;
  summary: string;
  /** Longer notes shown in `marmara help <command>`. */
  details?: string;
  params: Record<string, Param>;
  /** Example invocations (without the leading "marmara"). */
  examples?: string[];
  /** Read-only commands never write files (MCP clients may auto-approve them). */
  readOnly?: boolean;
  run(args: Args, ctx: Context): Promise<Result>;
}

export const GROUPS = [
  "Inspect",
  "Pages",
  "Edit text & objects",
  "Comments",
  "Forms",
  "Headers, watermarks & bookmarks",
  "Redact & security",
  "Signatures",
  "Optimise & archive",
  "OCR & convert",
] as const;
export type Group = (typeof GROUPS)[number];

const commands = new Map<string, Command>();

export function defineCommand(c: Command): Command {
  if (commands.has(c.name)) throw new Error(`Duplicate command ${c.name}`);
  for (const k of Object.keys(c.params)) if (!/^[a-z][a-z0-9_]*$/.test(k)) throw new Error(`Bad parameter name ${c.name}.${k}`);
  commands.set(c.name, c);
  return c;
}

export function getCommand(name: string): Command | undefined {
  return commands.get(name);
}

export function allCommands(): Command[] {
  return [...commands.values()].sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || a.name.localeCompare(b.name));
}

/** Error with a message meant for the caller (no stack trace needed). */
export class UsageError extends Error {}

// ---------- shared parameter declarations ----------

export const P = {
  input: { type: "path", description: "PDF file to read.", required: true, positional: true } as Param,
  output: {
    type: "path",
    short: "o",
    description:
      "Where to write the result. Default: next to the input as <name>.<command>.pdf (never replaces an existing file unless overwrite is set).",
  } as Param,
  overwrite: {
    type: "boolean",
    description: "Allow replacing an existing output file. Without an output path, the input file itself is replaced.",
  } as Param,
  password: { type: "string", description: "Password of an encrypted input PDF. The result keeps the same password." } as Param,
  breakSignatures: {
    type: "boolean",
    description: "The input is digitally signed and this change rewrites the file, invalidating the signatures. Set to proceed anyway.",
  } as Param,
  pages: {
    type: "string",
    description: 'Pages to work on, 1-based: "all", "3", "1-4,7", "5-" (default: all).',
  } as Param,
  page: { type: "integer", description: "Page number (1-based).", required: true } as Param,
  color: { type: "string", description: "Colour as #rrggbb." } as Param,
};

/** Standard output params for commands that write a PDF. */
export const WRITES = { output: P.output, overwrite: P.overwrite, password: P.password };
