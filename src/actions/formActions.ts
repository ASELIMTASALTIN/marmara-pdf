import type { Rect } from "../core/annotations/types";
import type { FieldKind } from "../core/forms/create";
import { commit, exclusive, useDoc, withBusy } from "../state/documentStore";
import { useUi } from "../state/uiStore";
import { errorMessage, openDialog, toast, type DialogField } from "../state/dialogStore";

export const FIELD_LABELS: Record<FieldKind, string> = {
  text: "Text field",
  multiline: "Multi-line text",
  checkbox: "Checkbox",
  radio: "Radio button",
  dropdown: "Dropdown list",
  signature: "Signature field",
};

const PREFIX: Record<FieldKind, string> = { text: "Text", multiline: "Notes", checkbox: "Check", radio: "Choice", dropdown: "List", signature: "Signature" };

export async function createFieldFlow(pageIndex: number, rect: Rect) {
  const { doc } = useDoc.getState();
  if (!doc) return;
  const kind = useUi.getState().formFieldKind;
  const { fieldNames, addFormField } = await import("../core/forms/create");
  const names = new Set(await fieldNames(doc.bytes).catch(() => [] as string[]));
  let n = 1;
  while (names.has(`${PREFIX[kind]}${n}`)) n++;
  const radioGroups = [...names];
  const fields: DialogField[] = [
    { kind: "text", key: "name", label: kind === "radio" ? "Group name (buttons with the same name form one choice)" : "Field name", value: kind === "radio" && radioGroups.length ? radioGroups[radioGroups.length - 1] : `${PREFIX[kind]}${n}` },
  ];
  if (kind === "dropdown") fields.push({ kind: "text", key: "options", label: "Choices (comma separated)", value: "Option 1, Option 2, Option 3" });
  if (kind === "radio") fields.push({ kind: "text", key: "value", label: "Value of this button", value: "Option 1" });
  if (kind !== "signature")
    fields.push({ kind: "select", key: "required", label: "Required", value: "no", options: [{ value: "no", label: "Optional" }, { value: "yes", label: "Required" }] });
  const r = await openDialog({
    title: `Add ${FIELD_LABELS[kind].toLowerCase()}`,
    fields,
    buttons: [
      { id: "cancel", label: "Cancel" },
      { id: "ok", label: "Add field", variant: "primary" },
    ],
    validate: (v, b) => {
      if (b !== "ok") return null;
      if (!v.name.trim()) return "Enter a field name.";
      if (/[.]/.test(v.name)) return "Field names cannot contain dots.";
      if (kind !== "radio" && names.has(v.name.trim())) return "A field with this name already exists.";
      return null;
    },
  });
  if (r.button !== "ok") return;
  await exclusive(async () => {
    try {
      const d = useDoc.getState().doc!;
      const options = kind === "dropdown" ? r.values.options.split(",").map((s) => s.trim()).filter(Boolean) : kind === "radio" ? [r.values.value.trim() || "Option"] : undefined;
      const bytes = await withBusy("Adding field…", () =>
        addFormField(d.bytes, { kind, name: r.values.name.trim(), pageIndex, rect, options, required: r.values.required === "yes" }),
      );
      await commit(`Add ${FIELD_LABELS[kind].toLowerCase()}`, { bytes });
    } catch (e) {
      toast(`Could not add the field: ${errorMessage(e)}`, "error");
    }
  });
}

export async function removeFieldAction(name: string) {
  await exclusive(async () => {
    try {
      const d = useDoc.getState().doc!;
      const { removeFormField } = await import("../core/forms/create");
      await commit(`Remove field “${name}”`, { bytes: await removeFormField(d.bytes, name) });
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  });
}
