//! Crash-recovery storage. While a document has unsaved changes, the UI
//! periodically snapshots it here. Snapshots are deleted on save/close; any
//! left over at startup are offered to the user for restoration.

use crate::files::{atomic_write, header, raw_body};
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use tauri::ipc::{Request, Response};
use tauri::State;

pub struct RecoveryDir(pub PathBuf);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryEntry {
    id: String,
    name: String,
    original_path: Option<String>,
    saved_at: u64,
    size: u64,
}

fn valid_id(id: &str) -> Result<(), String> {
    if !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        Ok(())
    } else {
        Err("invalid recovery id".into())
    }
}

/// Body: PDF bytes. Headers: `x-id`, `x-name`, optional `x-original-path`.
#[tauri::command]
pub fn recovery_save(request: Request<'_>, dir: State<'_, RecoveryDir>) -> Result<(), String> {
    let id = header(&request, "x-id")?;
    valid_id(&id)?;
    let name = header(&request, "x-name")?;
    let original = header(&request, "x-original-path").ok().filter(|s| !s.is_empty());
    let data = raw_body(&request)?;
    atomic_write(&dir.0.join(format!("{id}.pdf")), data)?;
    let meta = serde_json::json!({ "name": name, "originalPath": original });
    fs::write(dir.0.join(format!("{id}.json")), meta.to_string()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn recovery_list(dir: State<'_, RecoveryDir>) -> Result<Vec<RecoveryEntry>, String> {
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir.0).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let id = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
        let pdf = dir.0.join(format!("{id}.pdf"));
        let Ok(pdf_meta) = fs::metadata(&pdf) else { continue };
        let meta: serde_json::Value = fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let saved_at = pdf_meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(RecoveryEntry {
            id,
            name: meta["name"].as_str().unwrap_or("Recovered.pdf").to_string(),
            original_path: meta["originalPath"].as_str().map(String::from),
            saved_at,
            size: pdf_meta.len(),
        });
    }
    out.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
    Ok(out)
}

#[tauri::command]
pub fn recovery_read(id: String, dir: State<'_, RecoveryDir>) -> Result<Response, String> {
    valid_id(&id)?;
    fs::read(dir.0.join(format!("{id}.pdf")))
        .map(Response::new)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn recovery_delete(id: String, dir: State<'_, RecoveryDir>) -> Result<(), String> {
    valid_id(&id)?;
    let _ = fs::remove_file(dir.0.join(format!("{id}.pdf")));
    let _ = fs::remove_file(dir.0.join(format!("{id}.json")));
    Ok(())
}
