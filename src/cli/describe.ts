import { flagName } from "./args";
import { allCommands, GROUPS, type Command, type Param } from "./registry";

export const COORDINATES =
  "Coordinates are points (1/72 inch) measured from the top-left corner of the page as displayed (rotation applied), y grows downwards — the same frame as an image from to-images (pixel = point × dpi / 72). Rectangles are x0,y0,x1,y1.";

export const CONVENTIONS = [
  "Results are JSON on stdout. On failure: {\"ok\": false, \"error\": …} and a non-zero exit code.",
  "The input file is never changed unless --overwrite is given without --output. Results go to --output, or next to the input as <name>.<command>.pdf (a free name is chosen).",
  "Pages are 1-based: \"3\", \"1-4,7\", \"5-\", \"all\".",
  "Tool-calling LLMs can pass JSON instead of flags: marmara call <command> '{\"input\": \"C:/docs/a.pdf\", …}' (parameter names as in marmara commands).",
  COORDINATES,
  "Encrypted PDFs: pass --password; results keep the same password.",
  "Digitally signed PDFs: comments and form values are added as incremental updates (signatures stay valid); changes that rewrite the file require --break-signatures.",
];

function typeLabel(p: Param) {
  if (p.enum) return p.enum.join("|");
  return { string: "text", number: "number", integer: "int", boolean: "", "string[]": "text…", path: "file", "path[]": "file…", rect: "x0,y0,x1,y1", point: "x,y", json: "json" }[p.type];
}

export function usage(c: Command): string {
  const pos = Object.entries(c.params).filter(([, p]) => p.positional).map(([k, p]) => (p.required ? `<${k}${p.type.endsWith("[]") ? "…" : ""}>` : `[${k}]`));
  return `marmara ${c.name} ${pos.join(" ")} [options]`.replace(/\s+/g, " ").trim();
}

export function commandHelp(c: Command): string {
  const lines = [`${c.name} — ${c.summary}`, "", `Usage: ${usage(c)}`];
  if (c.details) lines.push("", c.details);
  lines.push("", "Arguments and options:");
  for (const [k, p] of Object.entries(c.params)) {
    const t = typeLabel(p);
    const name = p.positional ? `<${k}>` : `--${flagName(k)}${p.short ? `, -${p.short}` : ""}${t ? ` <${t}>` : ""}`;
    const extra = [p.required && !p.positional ? "required" : "", p.default !== undefined && p.type !== "boolean" ? `default ${JSON.stringify(p.default)}` : ""].filter(Boolean).join(", ");
    lines.push(`  ${name.padEnd(34)} ${p.description}${extra ? ` (${extra})` : ""}`);
  }
  if (c.examples?.length) lines.push("", "Examples:", ...c.examples.map((e) => `  marmara ${e}`));
  return lines.join("\n");
}

export function overview(version: string): string {
  const lines = [`Marmara PDF command line ${version} — every editor feature, scriptable and usable by local LLMs.`, "", "Usage: marmara <command> [arguments] [options]", ""];
  for (const g of GROUPS) {
    const list = allCommands().filter((c) => c.group === g);
    if (!list.length) continue;
    lines.push(`${g}:`);
    for (const c of list) lines.push(`  ${c.name.padEnd(20)} ${c.summary}`);
    lines.push("");
  }
  lines.push(
    "Other:",
    `  ${"help <command>".padEnd(20)} Options and examples of a command`,
    `  ${"commands".padEnd(20)} All commands with JSON Schemas (for tool-calling LLMs)`,
    `  ${"call <cmd> <json>".padEnd(20)} Run a command with JSON arguments (or JSON on stdin)`,
    `  ${"mcp".padEnd(20)} Run as an MCP server over stdio (--root <folder> limits file access)`,
    `  ${"--version".padEnd(20)} Version`,
    "",
    "Conventions:",
    ...CONVENTIONS.map((c) => `  • ${c}`),
    "",
    "Global options: --verbose (progress on stderr), --compact (single-line JSON).",
  );
  return lines.join("\n");
}

export function paramSchema(p: Param): Record<string, unknown> {
  let s: Record<string, unknown>;
  switch (p.type) {
    case "string":
    case "path":
      s = { type: "string" };
      if (p.enum) s.enum = [...p.enum];
      break;
    case "number":
      s = { type: "number" };
      break;
    case "integer":
      s = { type: "integer" };
      break;
    case "boolean":
      s = { type: "boolean" };
      break;
    case "string[]":
    case "path[]":
      s = { type: "array", items: { type: "string" } };
      break;
    case "rect":
      s = { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 };
      break;
    case "point":
      s = { type: "array", items: { type: "number" }, minItems: 2, maxItems: 2 };
      break;
    case "json":
      s = { ...(p.schema ?? {}) };
  }
  s.description = p.description + (p.type === "path" || p.type === "path[]" ? " Use absolute paths." : "");
  if (p.default !== undefined) s.default = p.default;
  return s;
}

export function inputSchema(c: Command) {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [k, p] of Object.entries(c.params)) {
    properties[k] = paramSchema(p);
    if (p.required) required.push(k);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

export function describeAll() {
  return allCommands().map((c) => ({
    name: c.name,
    group: c.group,
    description: c.summary + (c.details ? ` ${c.details}` : ""),
    read_only: !!c.readOnly,
    usage: usage(c),
    parameters: inputSchema(c),
    examples: c.examples?.map((e) => `marmara ${e}`),
  }));
}

/** Markdown reference (docs/CLI.md is generated from this). */
export function markdown(version: string): string {
  const out = [
    "# Marmara PDF command line",
    "",
    `Reference for \`marmara\` ${version}. Generated by \`marmara docs\` — do not edit by hand.`,
    "",
    "## Conventions",
    "",
    ...CONVENTIONS.map((c) => `* ${c}`),
    "",
  ];
  for (const g of GROUPS) {
    const list = allCommands().filter((c) => c.group === g);
    if (!list.length) continue;
    out.push(`## ${g}`, "");
    for (const c of list) {
      out.push(`### \`${c.name}\``, "", c.summary, "");
      if (c.details) out.push(c.details, "");
      out.push("```", usage(c), "```", "", "| Argument / option | Type | Description |", "|---|---|---|");
      for (const [k, p] of Object.entries(c.params)) {
        const name = p.positional ? `\`<${k}>\`` : `\`--${flagName(k)}\`${p.short ? ` / \`-${p.short}\`` : ""}`;
        const extra = [p.required ? "**required**" : "", p.default !== undefined && p.type !== "boolean" ? `default \`${JSON.stringify(p.default)}\`` : ""].filter(Boolean).join(", ");
        out.push(`| ${name} | ${(typeLabel(p) || "flag").replace(/\|/g, "\\|")} | ${p.description.replace(/\|/g, "\\|")}${extra ? ` (${extra})` : ""} |`);
      }
      if (c.examples?.length) out.push("", "Examples:", "", "```", ...c.examples.map((e) => `marmara ${e}`), "```");
      out.push("");
    }
  }
  return out.join("\n");
}
