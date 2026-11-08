//! The fleet doctor on this PC: start `nova-doctor live` and own its on/off switch.
//!
//! The doctor ships inside the installer (`resources/doctor/`, staged by `tools/stage-doctor.mjs`)
//! and runs on the node the launcher already bundles. It watches this machine's logs and reports
//! problems to the LOCAL agent; `diagreport.rs` forwards them to the coordinator under the player's
//! token, so the doctor never holds a credential.
//!
//! Light by construction, because it shares the machine with Fortnite:
//!   - started once per launcher session, at BELOW_NORMAL priority, with no window;
//!   - it reads only appended log bytes, and scans fully only when a game session is over
//!     (doctor/lib/live.mjs LIMITS);
//!   - it exits by itself when this launcher process goes away (`--parent`).
//!
//! The Settings switch is a marker file, like the bumper's: `%LOCALAPPDATA%\ProjectNova\doctor.off`.
//! With it present the doctor still writes the player's own local report but sends nothing.

use std::fs;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

fn nova_dir() -> Option<PathBuf> {
    let dir = PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("ProjectNova");
    let _ = fs::create_dir_all(&dir);
    Some(dir)
}

fn off_marker() -> Option<PathBuf> {
    nova_dir().map(|d| d.join("doctor.off"))
}

/// Is sharing on? Absent marker means on — the default the project chose.
pub fn sharing_enabled() -> bool {
    off_marker().map(|p| !p.exists()).unwrap_or(true)
}

#[derive(serde::Serialize)]
pub struct DoctorStatus {
    pub sharing: bool,
    pub running: bool,
    pub bundled: bool,
}

static STARTED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn doctor_status() -> DoctorStatus {
    DoctorStatus {
        sharing: sharing_enabled(),
        running: STARTED.load(Ordering::SeqCst),
        bundled: crate::host::beside_exe("doctor/nova-doctor.mjs").is_some(),
    }
}

#[tauri::command]
pub fn doctor_set_sharing(enabled: bool) -> Result<(), String> {
    let marker = off_marker().ok_or("LOCALAPPDATA is not set")?;
    if enabled {
        match fs::remove_file(&marker) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("Could not remove {}: {}", marker.display(), e)),
        }
    } else {
        fs::write(&marker, b"Sharing diagnostics with the Nova admins is switched off in Settings.\n")
            .map_err(|e| format!("Could not write {}: {}", marker.display(), e))
    }
}

/// Start `nova-doctor live`. Idempotent: the UI may re-run its effects, and two doctors would
/// double every line.
#[tauri::command]
pub fn doctor_start_live(agent: String) -> Result<bool, String> {
    if STARTED.swap(true, Ordering::SeqCst) {
        return Ok(false);
    }
    let script = match crate::host::beside_exe("doctor/nova-doctor.mjs") {
        Some(s) => s,
        None => {
            // A dev build that never staged the doctor. Not an error a player can see.
            crate::dbg_log("doctor: not bundled (run node tools/stage-doctor.mjs) - live doctor not started");
            STARTED.store(false, Ordering::SeqCst);
            return Ok(false);
        }
    };

    let log_dir = nova_dir().map(|d| d.join("Logs")).ok_or("LOCALAPPDATA is not set")?;
    let _ = fs::create_dir_all(&log_dir);
    let log_path = log_dir.join("doctor-live.log");
    if fs::metadata(&log_path).map(|m| m.len() > MAX_LOG_BYTES).unwrap_or(false) {
        let _ = fs::rename(&log_path, log_dir.join("doctor-live.log.1"));
    }
    let log = fs::OpenOptions::new().create(true).append(true).open(&log_path)
        .map_err(|e| format!("could not open {}: {}", log_path.display(), e))?;
    let log_err = log.try_clone().map_err(|e| e.to_string())?;

    let mut cmd = std::process::Command::new(crate::host::node_exe());
    cmd.args([
        script.as_str(),
        "live",
        "--agent", agent.as_str(),
        "--parent", &std::process::id().to_string(),
    ]);
    // Below normal from the first instruction, not after the doctor gets round to lowering itself.
    cmd.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);
    // Its own version, so the doctor never spends a PowerShell call (~0.9 s of CPU) finding it out.
    cmd.env("NOVA_LAUNCHER_VERSION", env!("CARGO_PKG_VERSION"));
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::from(log));
    cmd.stderr(std::process::Stdio::from(log_err));

    match cmd.spawn() {
        Ok(child) => {
            crate::dbg_log(&format!("doctor: live doctor started (pid {}, sharing {})", child.id(), if sharing_enabled() { "on" } else { "off" }));
            Ok(true)
        }
        Err(e) => {
            STARTED.store(false, Ordering::SeqCst);
            Err(format!("could not start the doctor: {}", e))
        }
    }
}
