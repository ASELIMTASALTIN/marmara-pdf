//! Marmara PDF — native backend.
//!
//! The backend is intentionally thin: all PDF processing happens locally in the
//! webview (pdf.js / pdf-lib / MuPDF WASM). Rust is responsible for things the
//! webview cannot do safely on its own:
//!   * binary file I/O with atomic writes (never leaves a half-written PDF),
//!   * crash-recovery (autosave) storage in the app data directory,
//!   * passing a PDF given on the command line ("Open with…") to the UI.

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?.join("recovery");
            std::fs::create_dir_all(&dir)?;
            app.manage(recovery::RecoveryDir(dir));
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Marmara PDF");
}
