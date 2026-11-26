import { create } from "zustand";
import type { ReactNode } from "react";

export type DialogField =
  | { kind: "text"; key: string; label: string; value?: string; placeholder?: string; hint?: string; password?: boolean }
  | { kind: "number"; key: string; label: string; value?: number; min?: number; max?: number }
  | { kind: "select"; key: string; label: string; value?: string; options: { value: string; label: string }[] }
  | { kind: "radio"; key: string; label: string; value?: string; options: { value: string; label: string; hint?: string }[] };

export interface DialogButton {
  id: string;
  label: string;
  variant?: "primary" | "danger" | "default";
}

export interface DialogSpec {
  title: string;
  message?: ReactNode;
  fields?: DialogField[];
  buttons: DialogButton[];
  /** Validates field values; return an error message to block closing. */
  validate?: (values: Record<string, string>, button: string) => string | null;
  /** Custom body (rendered below message). */
  body?: (ctx: { values: Record<string, string>; close: (button: string) => void }) => ReactNode;
  width?: number;
}

export interface DialogResult {
  button: string; // "cancel" when dismissed
  values: Record<string, string>;
}

interface OpenDialog extends DialogSpec {
  id: number;
  resolve: (r: DialogResult) => void;
}

export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  message: string;
}

interface DialogState {
  dialogs: OpenDialog[];
  toasts: Toast[];
}

export const useDialogs = create<DialogState>(() => ({ dialogs: [], toasts: [] }));

let seq = 1;

export function openDialog(spec: DialogSpec): Promise<DialogResult> {
  return new Promise((resolve) => {
    const id = seq++;
    useDialogs.setState((s) => ({
      dialogs: [
        ...s.dialogs,
        {
          ...spec,
          id,
          resolve: (r) => {
            useDialogs.setState((st) => ({ dialogs: st.dialogs.filter((d) => d.id !== id) }));
            resolve(r);
          },
        },
      ],
    }));
  });
}

export async function confirm(
  title: string,
  message: ReactNode,
  opts: { confirmLabel?: string; danger?: boolean; cancelLabel?: string } = {},
): Promise<boolean> {
  const r = await openDialog({
    title,
    message,
    buttons: [
      { id: "cancel", label: opts.cancelLabel ?? "Cancel" },
      { id: "ok", label: opts.confirmLabel ?? "OK", variant: opts.danger ? "danger" : "primary" },
    ],
  });
  return r.button === "ok";
}

export function toast(message: string, kind: Toast["kind"] = "info", ms = kind === "error" ? 6000 : 3000) {
  // Operations the user cancelled in a confirmation dialog are not errors.
  if (kind === "error" && /(^|: )Cancelled$/.test(message)) return;
  const id = seq++;
  useDialogs.setState((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, message }] }));
  setTimeout(() => useDialogs.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error && e.name === "CancelledError") return "Cancelled";
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Unexpected error";
}
