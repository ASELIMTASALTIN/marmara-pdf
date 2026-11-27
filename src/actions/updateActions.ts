/**
 * "Check for updates": asks GitHub Releases (latest.json, signed with the
 * project's updater key) whether a newer version exists, downloads and
 * verifies the installer, installs it and restarts. Portable copies only
 * link to the download page.
 */
import { platform } from "../platform";
import { confirmCloseAll } from "./fileActions";
import { errorMessage, openDialog, toast } from "../state/dialogStore";
import { setBusyLabel, withBusy } from "../state/documentStore";

export const REPO_URL = "https://github.com/ASELIMTASALTIN/marmara-pdf";
const RELEASES_URL = `${REPO_URL}/releases/latest`;

async function openUrl(url: string) {
  if (platform.isDesktop) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else window.open(url, "_blank", "noopener");
}

export async function checkForUpdates(): Promise<void> {
  if (!platform.isDesktop) {
    toast("Updates are installed by the desktop app.", "info");
    return;
  }
  const info = await platform.appInfo();
  let update: import("@tauri-apps/plugin-updater").Update | null;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    update = await withBusy("Checking for updates…", () => check({ timeout: 20000 }));
  } catch (e) {
    await openDialog({
      title: "Could not check for updates",
      message: `${errorMessage(e)}\n\nCheck your internet connection, or download the latest version from GitHub.`,
      buttons: [
        { id: "close", label: "Close" },
        { id: "web", label: "Open GitHub", variant: "primary" },
      ],
    }).then(async (r) => {
      if (r.button === "web") await openUrl(RELEASES_URL);
    });
    return;
  }
  if (!update) {
    await openDialog({ title: "Marmara PDF is up to date", message: `You have the latest version (${info.version}).`, buttons: [{ id: "ok", label: "OK", variant: "primary" }] });
    return;
  }
  // Release notes are Markdown; show them as plain text.
  const notes = (update.body ?? "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
  const r = await openDialog({
    title: `Marmara PDF ${update.version} is available`,
    message: `You have version ${info.version}.${notes ? `\n\n${notes.slice(0, 1200)}` : ""}${info.portable ? "\n\nThis is a portable copy: download the new version from GitHub." : ""}`,
    buttons: [
      { id: "later", label: "Later" },
      info.portable ? { id: "web", label: "Open download page", variant: "primary" } : { id: "install", label: "Install and restart", variant: "primary" },
    ],
  });
  if (r.button === "web") return void openUrl(RELEASES_URL);
  if (r.button !== "install") return;
  // The installer closes the app: make sure nothing unsaved is lost.
  if (!(await confirmCloseAll())) return;
  try {
    let total = 0;
    let received = 0;
    await withBusy("Downloading the update…", () =>
      update!.downloadAndInstall((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength ?? 0;
        else if (ev.event === "Progress") {
          received += ev.data.chunkLength;
          if (total) setBusyLabel(`Downloading the update… ${Math.round((received / total) * 100)}%`);
        } else if (ev.event === "Finished") setBusyLabel("Installing the update…");
      }),
    );
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e) {
    toast(`The update failed: ${errorMessage(e)}`, "error", 8000);
  }
}

export async function showAbout(): Promise<void> {
  const info = await platform.appInfo();
  const r = await openDialog({
    title: "About Marmara PDF",
    message: [
      `Version ${info.version}${info.portable ? " (portable)" : ""}`,
      "A free PDF reader and editor. Everything — including the AI assistant — runs locally on this computer.",
      "Licensed under AGPL-3.0-or-later. Built with Tauri, pdf.js, pdf-lib, MuPDF, Tesseract and llama.cpp.",
    ].join("\n\n"),
    buttons: [
      { id: "close", label: "Close" },
      { id: "web", label: "Project on GitHub", variant: "primary" },
    ],
  });
  if (r.button === "web") await openUrl(REPO_URL);
}
