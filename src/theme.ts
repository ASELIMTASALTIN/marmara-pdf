/**
 * Light / dark theme. The user's choice ("system", "light" or "dark") is kept
 * in localStorage; "system" follows Windows' app mode live. The resolved theme
 * is written to <html data-theme> (CSS variables in app.css) and applied to
 * the native window frame on desktop.
 */
import { create } from "zustand";

export type ThemePref = "system" | "light" | "dark";
const KEY = "marmara.theme";
const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;

function readPref(): ThemePref {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

export const useTheme = create<{ pref: ThemePref; resolved: "light" | "dark" }>(() => {
  const pref = readPref();
  return { pref, resolved: resolve(pref) };
});

function resolve(pref: ThemePref): "light" | "dark" {
  return pref === "system" ? (media?.matches ? "dark" : "light") : pref;
}

function apply() {
  const { pref } = useTheme.getState();
  const resolved = resolve(pref);
  useTheme.setState({ resolved });
  document.documentElement.dataset.theme = resolved;
  if ("__TAURI_INTERNALS__" in window) {
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(pref === "system" ? null : resolved))
      .catch(() => {});
  }
}

export function setTheme(pref: ThemePref) {
  localStorage.setItem(KEY, pref);
  useTheme.setState({ pref });
  apply();
}

export function initTheme() {
  apply();
  media?.addEventListener("change", () => {
    if (useTheme.getState().pref === "system") apply();
  });
}
