import { openMupdf } from "../../core/mupdf/loader";
import { defineCommand, P, UsageError, WRITES } from "../registry";
import { guardSignatures, loadPdf, pageGeometries, pageIndex, rectToUser, writePdf } from "../io";

type PDFObject = import("mupdf").PDFObject;

function onState(obj: PDFObject): string | null {
  const ap = obj.get("AP");
  if (ap.isNull()) return null;
  const n = ap.resolve().get("N");
  if (n.isNull() || !n.resolve().isDictionary()) return null;
  let on: string | null = null;
  n.resolve().forEach((_v, k) => {
    if (String(k) !== "Off") on = String(k);
  });
  return on;
}

interface FieldInfo {
  name: string;
  type: string;
  value: string | boolean;
  options?: string[];
  pages: number[];
  rects: number[][];
  required?: boolean;
  read_only?: boolean;
  multiline?: boolean;
}

async function readFields(bytes: Uint8Array): Promise<FieldInfo[]> {
  const { mupdf, doc } = await openMupdf(bytes);
  try {
    const byName = new Map<string, FieldInfo>();
    for (let i = 0; i < doc.countPages(); i++) {
      const page = doc.loadPage(i) as import("mupdf").PDFPage;
      for (const w of page.getWidgets()) {
        const name = w.getName();
        const type = w.isCheckbox() ? "checkbox" : w.isRadioButton() ? "radio" : w.isComboBox() ? "dropdown" : w.isListBox() ? "list" : w.isText() ? "text" : w.getFieldType();
        const r = w.getRect().map((v) => Math.round(v * 100) / 100);
        const raw = w.getValue();
        let f = byName.get(name);
        if (!f) {
          f = {
            name,
            type,
            value: type === "checkbox" ? raw !== "Off" && raw !== "" : type === "radio" ? (raw === "Off" ? "" : raw) : raw,
            pages: [],
            rects: [],
            required: (w.getFieldFlags() & mupdf.PDFWidget.FIELD_IS_REQUIRED) !== 0 || undefined,
            read_only: w.isReadOnly() || undefined,
            multiline: (w.isText() && w.isMultiline()) || undefined,
          };
          if (w.isChoice()) f.options = w.getOptions();
          byName.set(name, f);
        }
        if (type === "radio") {
          const on = onState(w.getObject());
          if (on) f.options = [...new Set([...(f.options ?? []), on])];
          if (raw && raw !== "Off") f.value = raw;
        }
        if (!f.pages.includes(i + 1)) f.pages.push(i + 1);
        f.rects.push(r);
      }
    }
    return [...byName.values()];
  } finally {
    doc.destroy();
  }
}

defineCommand({
  name: "fields",
  group: "Forms",
  summary: "List the form fields with type, current value, choices, page and rectangle.",
  readOnly: true,
  params: { input: P.input, password: P.password },
  async run(a, ctx) {
    const input = await loadPdf(ctx, a.input as string, a.password as string);
    const fields = await readFields(input.bytes);
    return { count: fields.length, fields };
  },
});

defineCommand({
  name: "fill",
  group: "Forms",
  summary: "Fill form fields (text, checkbox, radio, dropdown). Appearances are regenerated so values show in every reader.",
  details: 'Checkboxes take true/false (yes/no, on/off, 1/0, x). Radio groups and dropdowns take one of the values listed by the fields command. On signed files the values are written as an incremental update, keeping signatures valid.',
  params: {
    input: P.input,
    set: { type: "string[]", description: 'Field value as "name=value" (repeatable).' },
    values: { type: "json", schema: { type: "object", additionalProperties: { type: ["string", "boolean", "number"] } }, description: 'All values as a JSON object, e.g. {"Ad":"Ayşe","Onay":true}.' },
    ...WRITES,
  },
  examples: ['fill form.pdf --set "Ad Soyad=Ayşe Yılmaz" --set Onay=true', `fill form.pdf --values '{"Şehir":"İzmir"}'`],
  async run(a, ctx) {
    const input = await loadPdf(ctx, a.input as string, a.password as string);
    const requested: Record<string, unknown> = {};
    for (const s of (a.set as string[] | undefined) ?? []) {
      const i = s.indexOf("=");
      if (i <= 0) throw new UsageError(`--set expects "name=value", got "${s}".`);
      requested[s.slice(0, i)] = s.slice(i + 1);
    }
    if (a.values !== undefined) {
      if (typeof a.values !== "object" || a.values === null || Array.isArray(a.values)) throw new UsageError("--values must be a JSON object.");
      Object.assign(requested, a.values);
    }
    if (!Object.keys(requested).length) throw new UsageError("Give values with --set name=value or --values '{…}'.");
    const fields = new Map((await readFields(input.bytes)).map((f) => [f.name, f]));
    const values: Record<string, string | boolean> = {};
    const warnings: string[] = [];
    for (const [name, v] of Object.entries(requested)) {
      const f = fields.get(name);
      if (!f) {
        warnings.push(`No field named "${name}".`);
        continue;
      }
      if (f.read_only) warnings.push(`"${name}" is read-only and was not changed.`);
      if (f.type === "checkbox") {
        const s = String(v).trim().toLowerCase();
        values[name] = v === true || ["true", "yes", "on", "1", "x", "evet"].includes(s);
      } else {
        values[name] = String(v);
        if ((f.type === "radio" || f.type === "dropdown" || f.type === "list") && f.options?.length && !f.options.includes(String(v)))
          warnings.push(`"${v}" is not one of the choices of "${name}": ${f.options.join(", ")}.`);
      }
    }
    if (!Object.keys(values).length) throw new UsageError(`${warnings.join(" ")} Available fields: ${[...fields.keys()].join(", ") || "none"}.`);
    const { applyFormValues } = await import("../../core/forms/forms");
    const out = await applyFormValues(input.bytes, values, input.signatures > 0 && !input.password);
    const after = new Map((await readFields(out)).map((f) => [f.name, f.value]));
    return { output: await writePdf(ctx, a, input, out, "filled"), filled: Object.fromEntries(Object.keys(values).map((k) => [k, after.get(k)])), warnings: warnings.length ? warnings : undefined };
  },
});

defineCommand({
  name: "add-field",
  group: "Forms",
  summary: "Create a form field: text, multiline, checkbox, radio, dropdown or signature.",
  params: {
    input: P.input,
    kind: { type: "string", enum: ["text", "multiline", "checkbox", "radio", "dropdown", "signature"], description: "Field type.", required: true },
    name: { type: "string", description: "Field name (radio buttons with the same name form one group).", required: true },
    page: P.page,
    rect: { type: "rect", description: 'Position "x0,y0,x1,y1" (points, top-left origin).', required: true },
    options: { type: "string", description: 'Dropdown choices, comma separated ("A, B, C").' },
    value: { type: "string", description: "Value of this radio button." },
    required: { type: "boolean", description: "Mark as required." },
    font_size: { type: "number", description: "Font size (0 = auto)." },
    ...WRITES,
    break_signatures: P.breakSignatures,
  },
  examples: ['add-field form.pdf --kind text --name "Ad Soyad" --page 1 --rect 150,200,400,222'],
  async run(a, ctx) {
    const input = await loadPdf(ctx, a.input as string, a.password as string);
    guardSignatures(input, a);
    const geoms = await pageGeometries(input.bytes);
    const p = pageIndex(a.page, geoms.length);
    const { addFormField, fieldNames } = await import("../../core/forms/create");
    const name = String(a.name).trim();
    if (!name || name.includes(".")) throw new UsageError("Field names must be non-empty and cannot contain dots.");
    if (a.kind !== "radio" && (await fieldNames(input.bytes)).includes(name)) throw new UsageError(`A field named "${name}" already exists.`);
    const options =
      a.kind === "dropdown"
        ? String(a.options ?? "Option 1, Option 2").split(",").map((s) => s.trim()).filter(Boolean)
        : a.kind === "radio"
          ? [String(a.value ?? "Option 1")]
          : undefined;
    const out = await addFormField(input.bytes, {
      kind: a.kind as never,
      name,
      pageIndex: p,
      rect: rectToUser(geoms[p], a.rect as number[]),
      options,
      required: !!a.required,
      fontSize: a.font_size as number | undefined,
    });
    return { output: await writePdf(ctx, a, input, out, "form"), field: name, kind: a.kind };
  },
});

defineCommand({
  name: "remove-field",
  group: "Forms",
  summary: "Delete a form field (all its widgets).",
  params: { input: P.input, name: { type: "string", description: "Field name.", required: true }, ...WRITES, break_signatures: P.breakSignatures },
  async run(a, ctx) {
    const input = await loadPdf(ctx, a.input as string, a.password as string);
    guardSignatures(input, a);
    const { removeFormField, fieldNames } = await import("../../core/forms/create");
    if (!(await fieldNames(input.bytes)).includes(a.name as string)) throw new UsageError(`No field named "${a.name}".`);
    const out = await removeFormField(input.bytes, a.name as string);
    return { output: await writePdf(ctx, a, input, out, "form"), removed: a.name };
  },
});
