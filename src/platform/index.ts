import { browserPlatform } from "./browser";
import { tauriPlatform } from "./tauri";
import type { Platform } from "./types";

export * from "./types";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** The host platform: Tauri on desktop, browser APIs otherwise. */
export const platform: Platform = inTauri ? tauriPlatform : browserPlatform;
