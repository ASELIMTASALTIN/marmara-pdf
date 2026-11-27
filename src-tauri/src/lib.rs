//! Marmara PDF — native backend.
//!
//! The backend is intentionally thin: all PDF processing happens locally in the
//! webview (pdf.js / pdf-lib / MuPDF WASM). Rust is responsible for things the
//! webview cannot do safely on its own:
//!   * binary file I/O with atomic writes (never leaves a half-written PDF),
//!   * crash-recovery (autosave) storage in the app data directory,
//!   * passing a PDF given on the command line ("Open with…") to the UI,
//!   * running the local AI assistant engine (llama.cpp) on 127.0.0.1.

mod ai;
mod files;
mod recovery;

use tauri::Manager;

/// PDF path passed on the command line (file association / "Open with").
#[tauri::command]
fn startup_file() -> Option<String> {
    std::env::args().skip(1).find(|a| {
        let p = std::path::Path::new(a);
        p.extension()
            .map(|e| e.eq_ignore_ascii_case("pdf"))
            .unwrap_or(false)
            && p.is_file()
    })
}

/// Version and install kind. A portable copy (a `portable.txt` file next to the
/// executable) cannot replace itself with the installer, so it only links to the
/// download page when an update is available.
#[derive(serde::Serialize)]
struct AppInfo {
    version: String,
    portable: bool,
}

#[tauri::command]
fn app_info(app: tauri::AppHandle) -> AppInfo {
    let portable = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("portable.txt").is_file()))
        .unwrap_or(false);
    AppInfo { version: app.package_info().version.to_string(), portable }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?.join("recovery");
            std::fs::create_dir_all(&dir)?;
            app.manage(recovery::RecoveryDir(dir));
            app.manage(ai::AiState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            startup_file,
            files::read_file,
            files::write_file,
            files::file_exists,
            recovery::recovery_save,
            recovery::recovery_list,
            recovery::recovery_read,
            recovery::recovery_delete,
            ai::ai_status,
            ai::ai_start,
            ai::ai_stop,
            ai::ai_set_model,
            ai::ai_download_model,
            ai::ai_cancel_download,
            app_info,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Marmara PDF")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                ai::shutdown(app);
            }
        });
}
