//! Local AI assistant engine.
//!
//! Runs the bundled llama.cpp server (`ai/llama-server.exe`, built by
//! scripts/build-engine.mjs) with a GGUF model. The server listens on
//! 127.0.0.1 only, on a free port, protected by a random API key, and is tied
//! to this process with a Windows job object so it never outlives the app.
//! Nothing leaves the computer.

use serde::{Deserialize, Serialize};
use std::fs;
use std::hash::{BuildHasher, RandomState};
use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, State};

pub struct Engine {
    child: Child,
    port: u16,
    key: String,
    model: PathBuf,
    gpu: bool,
    #[cfg(windows)]
    _job: job::Job,
}

impl Drop for Engine {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
pub struct AiState(pub Mutex<Option<Engine>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    path: String,
    name: String,
    size: u64,
    /// "bundled", "user" (app data), "lmstudio", "dev" or "selected".
    source: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    /// Folder of the engine, or None when it is not installed.
    engine: Option<String>,
    models: Vec<ModelInfo>,
    selected: Option<String>,
    running: bool,
    port: Option<u16>,
    key: Option<String>,
    gpu: bool,
    /// Last lines of the engine log when it stopped unexpectedly.
    error: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct Settings {
    model: Option<String>,
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("ai.json"))
}

fn load_settings(app: &AppHandle) -> Settings {
    settings_path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, s: &Settings) {
    if let Some(p) = settings_path(app) {
        if let Some(d) = p.parent() {
            let _ = fs::create_dir_all(d);
        }
        let _ = fs::write(p, serde_json::to_string_pretty(s).unwrap_or_default());
    }
}

/// Per-user model folder (%LOCALAPPDATA%\com.marmara.pdf\models). Installers and updates
/// never touch it; the NSIS installer copies a model shipped next to it into this folder.
fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_local_data_dir().map(|d| d.join("models")).map_err(|e| e.to_string())
}

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(Path::to_path_buf)
}

/// Folders that may contain the engine (installed resources, portable layout, dev tree).
fn engine_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Ok(d) = std::env::var("MARMARA_AI_ENGINE") {
        v.push(PathBuf::from(d));
    }
    if let Ok(r) = app.path().resource_dir() {
        v.push(r.join("ai"));
    }
    if let Some(e) = exe_dir() {
        v.push(e.join("ai"));
    }
    if cfg!(debug_assertions) {
        v.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("ai-engine"));
    }
    v
}

fn find_engine(app: &AppHandle) -> Option<PathBuf> {
    engine_dirs(app).into_iter().find(|d| d.join("llama-server.exe").is_file())
}

fn gguf_in(dir: &Path, source: &str, depth: u32, out: &mut Vec<ModelInfo>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            if depth > 0 {
                gguf_in(&p, source, depth - 1, out);
            }
        } else if p
            .extension()
            .map(|x| x.eq_ignore_ascii_case("gguf"))
            .unwrap_or(false)
        {
            let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
            // Vision projectors are not chat models.
            if name.to_lowercase().starts_with("mmproj") {
                continue;
            }
            let size = e.metadata().map(|m| m.len()).unwrap_or(0);
            out.push(ModelInfo { path: p.to_string_lossy().to_string(), name, size, source: source.into() });
        }
    }
}

fn list_models(app: &AppHandle) -> Vec<ModelInfo> {
    let mut out = Vec::new();
    for d in engine_dirs(app) {
        gguf_in(&d.join("models"), "bundled", 1, &mut out);
    }
    if let Ok(d) = models_dir(app) {
        gguf_in(&d, "user", 1, &mut out);
    }
    if cfg!(debug_assertions) {
        gguf_in(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("models"), "dev", 0, &mut out);
    }
    if let Ok(home) = std::env::var("USERPROFILE") {
        gguf_in(&Path::new(&home).join(".lmstudio").join("models"), "lmstudio", 3, &mut out);
    }
    if let Some(sel) = load_settings(app).model {
        if Path::new(&sel).is_file() && !out.iter().any(|m| same_path(&m.path, &sel)) {
            let size = fs::metadata(&sel).map(|m| m.len()).unwrap_or(0);
            let name = Path::new(&sel).file_name().unwrap_or_default().to_string_lossy().to_string();
            out.insert(0, ModelInfo { path: sel, name, size, source: "selected".into() });
        }
    }
    // Same file reachable twice (e.g. dev + selected): keep the first.
    let mut seen: Vec<String> = Vec::new();
    out.retain(|m| {
        let k = m.path.to_lowercase();
        if seen.contains(&k) {
            false
        } else {
            seen.push(k);
            true
        }
    });
    out
}

fn same_path(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

fn selected_model(app: &AppHandle, models: &[ModelInfo]) -> Option<String> {
    if let Some(sel) = load_settings(app).model {
        if Path::new(&sel).is_file() {
            return Some(sel);
        }
    }
    let rank = |s: &str| match s {
        "bundled" => 0,
        "user" => 1,
        "dev" => 2,
        _ => 3,
    };
    models.iter().min_by_key(|m| rank(&m.source)).map(|m| m.path.clone())
}

fn log_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("ai-engine.log"))
}

fn log_tail(app: &AppHandle, lines: usize) -> Option<String> {
    let f = fs::File::open(log_path(app)?).ok()?;
    let all: Vec<String> = BufReader::new(f).lines().map_while(Result::ok).collect();
    let start = all.len().saturating_sub(lines);
    Some(all[start..].join("\n"))
}

fn random_key() -> String {
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let a = RandomState::new().hash_one(t);
    let b = RandomState::new().hash_one(t ^ 0x9e37_79b9_7f4a_7c15);
    format!("{a:016x}{b:016x}")
}

fn status_of(app: &AppHandle, state: &State<AiState>) -> AiStatus {
    let models = list_models(app);
    let selected = selected_model(app, &models);
    let mut guard = state.0.lock().unwrap();
    let mut error = None;
    if let Some(engine) = guard.as_mut() {
        if let Ok(Some(code)) = engine.child.try_wait() {
            error = Some(format!(
                "The AI engine stopped (exit code {}).\n{}",
                code.code().unwrap_or(-1),
                log_tail(app, 25).unwrap_or_default()
            ));
            *guard = None;
        }
    }
    let running = guard.as_ref();
    AiStatus {
        engine: find_engine(app).map(|p| p.to_string_lossy().to_string()),
        selected: running.map(|e| e.model.to_string_lossy().to_string()).or(selected),
        models,
        running: running.is_some(),
        port: running.map(|e| e.port),
        key: running.map(|e| e.key.clone()),
        gpu: running.map(|e| e.gpu).unwrap_or(false),
        error,
    }
}

#[tauri::command]
pub fn ai_status(app: AppHandle, state: State<AiState>) -> AiStatus {
    status_of(&app, &state)
}

/// Starts the engine (or keeps the running one when the model is unchanged).
/// The UI then polls `GET /health` until the model is loaded.
#[tauri::command]
pub fn ai_start(app: AppHandle, state: State<AiState>, model: Option<String>, gpu: Option<bool>, context: Option<u32>) -> Result<AiStatus, String> {
    let engine_dir = find_engine(&app).ok_or("The AI engine is not installed (ai\\llama-server.exe is missing).")?;
    let models = list_models(&app);
    let model = model.or_else(|| selected_model(&app, &models)).ok_or("No AI model (.gguf) was found.")?;
    let model_path = PathBuf::from(&model);
    if !model_path.is_file() {
        return Err(format!("Model file not found: {model}"));
    }
    let gpu = gpu.unwrap_or(true);
    {
        let mut guard = state.0.lock().unwrap();
        if let Some(e) = guard.as_mut() {
            let alive = matches!(e.child.try_wait(), Ok(None));
            if alive && e.model == model_path && e.gpu == gpu {
                drop(guard);
                return Ok(status_of(&app, &state));
            }
        }
        *guard = None; // stops the old engine (Drop)
    }
    let port = TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map(|a| a.port()).map_err(|e| e.to_string())?;
    let key = random_key();
    let log = log_path(&app).ok_or("No app data folder")?;
    if let Some(d) = log.parent() {
        fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let out = fs::File::create(&log).map_err(|e| e.to_string())?;
    let err = out.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(engine_dir.join("llama-server.exe"));
    cmd.current_dir(&engine_dir)
        .arg("--model").arg(&model_path)
        .args(["--host", "127.0.0.1", "--port", &port.to_string(), "--api-key", &key])
        .args(["--ctx-size", &context.unwrap_or(8192).to_string(), "--parallel", "1"])
        .args(["--n-gpu-layers", if gpu { "99" } else { "0" }])
        // This model answers best when it may think first (llama.cpp returns the thoughts separately).
        .args(["--jinja", "--no-webui", "--reasoning-budget", "1024"])
        .stdin(Stdio::null())
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let child = cmd.spawn().map_err(|e| format!("Could not start the AI engine: {e}"))?;
    #[cfg(windows)]
    let job = job::Job::kill_on_close(&child);
    save_settings(&app, &Settings { model: Some(model.clone()) });
    *state.0.lock().unwrap() = Some(Engine {
        child,
        port,
        key,
        model: model_path,
        gpu,
        #[cfg(windows)]
        _job: job,
    });
    Ok(status_of(&app, &state))
}

#[tauri::command]
pub fn ai_stop(state: State<AiState>) {
    *state.0.lock().unwrap() = None;
}

/// Remembers a model file chosen by the user.
#[tauri::command]
pub fn ai_set_model(app: AppHandle, state: State<AiState>, path: String) -> Result<AiStatus, String> {
    let p = Path::new(&path);
    if !p.is_file() || !p.extension().map(|x| x.eq_ignore_ascii_case("gguf")).unwrap_or(false) {
        return Err("Choose a .gguf model file.".into());
    }
    save_settings(&app, &Settings { model: Some(path) });
    Ok(status_of(&app, &state))
}

static CANCEL_DOWNLOAD: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    received: u64,
    total: Option<u64>,
}

/// Downloads a model from Hugging Face into the per-user model folder, reporting
/// progress with `ai-download-progress` events. Returns the file path.
#[tauri::command]
pub async fn ai_download_model(app: AppHandle, url: String, file_name: String) -> Result<String, String> {
    use futures_util::StreamExt;
    use std::io::Write;
    if !url.starts_with("https://huggingface.co/") {
        return Err("Models can only be downloaded from huggingface.co.".into());
    }
    if !file_name.to_lowercase().ends_with(".gguf") || file_name.contains(['/', '\\', ':']) || file_name.starts_with('.') {
        return Err("Invalid model file name.".into());
    }
    let dir = models_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(&file_name);
    if dest.is_file() {
        save_settings(&app, &Settings { model: Some(dest.to_string_lossy().to_string()) });
        return Ok(dest.to_string_lossy().to_string());
    }
    let part = dir.join(format!("{file_name}.part"));
    CANCEL_DOWNLOAD.store(false, Ordering::SeqCst);
    let client = reqwest::Client::builder().user_agent("MarmaraPDF").build().map_err(|e| e.to_string())?;
    let resp = client.get(&url).send().await.and_then(|r| r.error_for_status()).map_err(|e| format!("Download failed: {e}"))?;
    let total = resp.content_length();
    let mut file = fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut stream = resp.bytes_stream();
    let mut received: u64 = 0;
    let mut last_emit: u64 = 0;
    let result: Result<(), String> = async {
        while let Some(chunk) = stream.next().await {
            if CANCEL_DOWNLOAD.load(Ordering::SeqCst) {
                return Err("Cancelled".into());
            }
            let chunk = chunk.map_err(|e| format!("Download interrupted: {e}"))?;
            file.write_all(&chunk).map_err(|e| format!("Could not write the model: {e}"))?;
            received += chunk.len() as u64;
            if received - last_emit >= 4 * 1024 * 1024 {
                last_emit = received;
                let _ = app.emit("ai-download-progress", DownloadProgress { received, total });
            }
        }
        if let Some(t) = total {
            if received != t {
                return Err("The download was incomplete.".into());
            }
        }
        Ok(())
    }
    .await;
    drop(file);
    if let Err(e) = result {
        let _ = fs::remove_file(&part);
        return Err(e);
    }
    fs::rename(&part, &dest).map_err(|e| e.to_string())?;
    let _ = app.emit("ai-download-progress", DownloadProgress { received, total });
    save_settings(&app, &Settings { model: Some(dest.to_string_lossy().to_string()) });
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub fn ai_cancel_download() {
    CANCEL_DOWNLOAD.store(true, Ordering::SeqCst);
}

pub fn shutdown(app: &AppHandle) {
    if let Some(state) = app.try_state::<AiState>() {
        *state.0.lock().unwrap() = None;
    }
}

#[cfg(windows)]
mod job {
    //! A job object that kills the engine when Marmara PDF exits, even after a crash.
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JobObjectExtendedLimitInformation, SetInformationJobObject,
    };

    pub struct Job(HANDLE);
    unsafe impl Send for Job {}

    impl Job {
        pub fn kill_on_close(child: &Child) -> Job {
            unsafe {
                let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if !h.is_null() {
                    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                    SetInformationJobObject(
                        h,
                        JobObjectExtendedLimitInformation,
                        &info as *const _ as *const core::ffi::c_void,
                        std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                    );
                    AssignProcessToJobObject(h, child.as_raw_handle() as HANDLE);
                }
                Job(h)
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CloseHandle(self.0) };
            }
        }
    }
}
