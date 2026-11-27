use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::ipc::{InvokeBody, Request, Response};

/// Header values must be ASCII, so the frontend sends paths percent-encoded
/// (`encodeURIComponent`). This decodes them back to UTF-8.
pub fn percent_decode(s: &str) -> Result<String, String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|e| e.to_string())?;
            out.push(u8::from_str_radix(hex, 16).map_err(|e| e.to_string())?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|e| e.to_string())
}

pub fn header(request: &Request<'_>, name: &str) -> Result<String, String> {
    let raw = request
        .headers()
        .get(name)
        .ok_or_else(|| format!("missing header {name}"))?
        .to_str()
        .map_err(|e| e.to_string())?;
    percent_decode(raw)
}

pub fn raw_body<'a>(request: &'a Request<'_>) -> Result<&'a [u8], String> {
    match request.body() {
        InvokeBody::Raw(data) => Ok(data),
        _ => Err("expected a binary request body".into()),
    }
}

/// Write to a temp file next to the target, flush to disk, then rename over the
/// target. On Windows `fs::rename` replaces an existing file atomically
/// (MoveFileExW + MOVEFILE_REPLACE_EXISTING), so a crash mid-save can never
/// corrupt the user's original document.
pub fn atomic_write(path: &Path, data: &[u8]) -> Result<(), String> {
    let file_name = path
        .file_name()
        .ok_or("invalid file name")?
        .to_string_lossy()
        .to_string();
    let tmp: PathBuf = path.with_file_name(format!(".{file_name}.marmara-tmp"));
    let result = (|| -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, path)
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(format!("{}: {e}", path.display()));
    }
    Ok(())
}

#[tauri::command]
pub fn read_file(path: String) -> Result<Response, String> {
    fs::read(&path)
        .map(Response::new)
        .map_err(|e| format!("{path}: {e}"))
}

/// File types that may be written by exports (PDF→Word/images/text).
const EXPORT_EXTENSIONS: &[&str] = &["docx", "png", "jpg", "jpeg", "txt", "pfx", "p12", "cer", "xfdf"];

/// Body: raw file bytes. Header `x-path`: percent-encoded destination path.
/// Header `x-kind`: "pdf" (default; content must be a PDF) or "export"
/// (destination extension must be one of EXPORT_EXTENSIONS).
#[tauri::command]
pub fn write_file(request: Request<'_>) -> Result<(), String> {
    let path = header(&request, "x-path")?;
    let kind = header(&request, "x-kind").unwrap_or_else(|_| "pdf".into());
    let data = raw_body(&request)?;
    check_kind(&kind, Path::new(&path), data)?;
    atomic_write(Path::new(&path), data)
}

fn check_kind(kind: &str, path: &Path, data: &[u8]) -> Result<(), String> {
    match kind {
        "export" => {
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase())
                .unwrap_or_default();
            if EXPORT_EXTENSIONS.contains(&ext.as_str()) {
                Ok(())
            } else {
                Err(format!("refusing to write: .{ext} is not an export format"))
            }
        }
        _ if data.len() >= 5 && &data[..5] == b"%PDF-" => Ok(()),
        _ => Err("refusing to write: data is not a PDF".into()),
    }
}

#[tauri::command]
pub fn file_exists(path: String) -> bool {
    Path::new(&path).is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_utf8_paths() {
        assert_eq!(
            percent_decode("C%3A%5CBelgeler%5C%C3%96rnek%20%C5%9Fey.pdf").unwrap(),
            "C:\\Belgeler\\Örnek şey.pdf"
        );
        assert_eq!(percent_decode("plain.pdf").unwrap(), "plain.pdf");
    }

    #[test]
    fn checks_write_kinds() {
        assert!(check_kind("pdf", Path::new("a.pdf"), b"%PDF-1.7").is_ok());
        assert!(check_kind("pdf", Path::new("a.pdf"), b"hello").is_err());
        assert!(check_kind("export", Path::new("C:/x/Report.DOCX"), b"PK").is_ok());
        assert!(check_kind("export", Path::new("a.png"), b"x").is_ok());
        assert!(check_kind("export", Path::new("evil.exe"), b"MZ").is_err());
        assert!(check_kind("export", Path::new("noext"), b"x").is_err());
    }

    #[test]
    fn atomic_write_replaces_existing() {
        let dir = std::env::temp_dir().join("marmara-test");
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("a.pdf");
        fs::write(&p, b"old").unwrap();
        atomic_write(&p, b"%PDF-new").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"%PDF-new");
        let _ = fs::remove_file(&p);
    }
}
