//! `marmara` — console launcher for the Marmara PDF command line.
//!
//! The command line itself is JavaScript (the same document engine as the
//! app). The installer puts it in `cli\` next to this executable together with
//! a private Node.js runtime; this launcher runs it with the console's stdin,
//! stdout and stderr, so it works in terminals, scripts and as an MCP server.
use std::env;
use std::path::PathBuf;
use std::process::{Command, exit};

fn main() {
    let base = env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(PathBuf::from))
        .unwrap_or_default();
    let cli = base.join("cli");
    let script = cli.join("marmara.mjs");
    if !script.exists() {
        eprintln!(
            "Marmara PDF command line not found at {}. Reinstall Marmara PDF.",
            script.display()
        );
        exit(3);
    }
    let bundled = cli.join("node.exe");
    let node = if bundled.exists() { bundled } else { PathBuf::from("node") };
    let status = Command::new(&node)
        .arg("--no-warnings")
        .arg(&script)
        .args(env::args_os().skip(1))
        .env_remove("NODE_OPTIONS")
        .status();
    match status {
        Ok(s) => exit(s.code().unwrap_or(1)),
        Err(e) => {
            eprintln!("Could not start Node.js ({}): {e}", node.display());
            exit(3);
        }
    }
}
