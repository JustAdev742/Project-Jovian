//! The intro bumper: the switch in Settings, and getting the clip where Cobalt looks for it.
//!
//! Cobalt (inside the game) plays `%LOCALAPPDATA%\ProjectNova\bumper.mp4` when Battle Royale is
//! chosen, unless `%LOCALAPPDATA%\ProjectNova\bumper.off` exists. Both halves of that contract are
//! files rather than settings the launcher would have to hand across a process boundary: Cobalt
//! only ever has to answer "is it there", and works on a fresh install before the launcher has
//! written anything (absent means ON).
//!
//! The clip ships inside the launcher as a resource and is copied into place on every launch when
//! missing or a different size, the same way Cobalt.dll is deployed -- so a player never has to put
//! a file anywhere by hand.

use std::fs;
use std::path::PathBuf;

/// `%LOCALAPPDATA%\ProjectNova`, created if needed. None only if LOCALAPPDATA is unset.
fn nova_dir() -> Option<PathBuf> {
    let dir = PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("ProjectNova");
    let _ = fs::create_dir_all(&dir);
    Some(dir)
}

fn off_marker() -> Option<PathBuf> {
    nova_dir().map(|d| d.join("bumper.off"))
}

fn clip_path() -> Option<PathBuf> {
    nova_dir().map(|d| d.join("bumper.mp4"))
}

#[derive(serde::Serialize)]
pub struct BumperStatus {
    /// The switch. Absent marker file means on.
    pub enabled: bool,
    /// Whether the clip is where Cobalt will look for it.
    pub clip_present: bool,
}

#[tauri::command]
pub fn bumper_status() -> BumperStatus {
    BumperStatus {
        enabled: off_marker().map(|p| !p.exists()).unwrap_or(true),
        clip_present: clip_path().map(|p| p.is_file()).unwrap_or(false),
    }
}

/// Flip the switch. On = delete the marker, off = create it. Takes effect on the next game launch;
/// Cobalt reads the marker at the moment Battle Royale is chosen, so it actually takes effect even
/// mid-session, but "next launch" is the promise the UI makes.
#[tauri::command]
pub fn bumper_set_enabled(enabled: bool) -> Result<(), String> {
    let marker = off_marker().ok_or("LOCALAPPDATA is not set")?;
    if enabled {
        match fs::remove_file(&marker) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("Could not remove {}: {}", marker.display(), e)),
        }
    } else {
        fs::write(&marker, b"The Nova intro bumper is switched off in Settings.\n")
            .map_err(|e| format!("Could not write {}: {}", marker.display(), e))
    }
}

/// Put the bundled clip -- and its soundtrack, `bumper.wav` -- where Cobalt looks, if either is
/// missing or not the bundled one.
///
/// Called on the launch path, next to the Cobalt deployment. Never fatal: a launch must not fail
/// because a bumper could not be copied, so this only reports. The first failure is returned; the
/// other file is still attempted.
pub fn stage_clip() -> Result<(), String> {
    let dir = nova_dir().ok_or("LOCALAPPDATA is not set")?;
    let mut first_err: Option<String> = None;
    for name in ["bumper.mp4", "bumper.wav"] {
        if let Err(e) = stage_one(&dir.join(name), name) {
            first_err.get_or_insert(e);
        }
    }
    match first_err {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

fn stage_one(dest: &std::path::Path, name: &str) -> Result<(), String> {
    let src = crate::host::beside_exe(name).ok_or_else(|| format!("{} is not bundled with this launcher", name))?;
    let src_len = fs::metadata(&src).map_err(|e| e.to_string())?.len();
    let up_to_date = fs::metadata(dest).map(|m| m.len() == src_len).unwrap_or(false);
    if up_to_date {
        return Ok(());
    }
    fs::copy(&src, dest).map_err(|e| format!("copy {} -> {}: {}", src, dest.display(), e))?;
    println!("Staged {} ({} bytes) to {}", name, src_len, dest.display());
    Ok(())
}
