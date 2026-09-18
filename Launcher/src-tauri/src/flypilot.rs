//! Fly pilot — the experimental toggle for the connectome-driven pawn.
//!
//! The game-server DLL reads `flypilot.json` from its working directory, which is
//! `<build>\FortniteGame\Binaries\Win64` (the same directory the game is launched in, see
//! `carter::launch_real_launcher`). All this module does is write that file and report whether the
//! brain data is actually installed, because the toggle is meaningless without it: the network is a
//! ~121 MB blob built offline by `fly-pilot/flypilot/export_blob.py`, and it is not shipped with the
//! launcher.
//!
//! Turning the switch on with no blob present would look like a no-op bug, so `status` reports the
//! blob separately and the UI says which half is missing.

use std::fs;
use std::path::{Path, PathBuf};

/// Where the DLL looks, relative to its working directory.
const BLOB_RELATIVE: &str = "Reboot Resources\\flybrain.bin";
const CONFIG_NAME: &str = "flypilot.json";

fn server_dir(root: &str) -> PathBuf {
    let mut p = PathBuf::from(root);
    p.push("FortniteGame\\Binaries\\Win64");
    p
}

fn config_path(root: &str) -> PathBuf {
    server_dir(root).join(CONFIG_NAME)
}

fn blob_path(root: &str) -> PathBuf {
    server_dir(root).join(BLOB_RELATIVE)
}

#[derive(serde::Serialize)]
pub struct FlyPilotStatus {
    pub enabled: bool,
    pub blob_present: bool,
    pub blob_mb: f64,
    pub config_path: String,
    pub blob_path: String,
}

#[tauri::command]
pub fn flypilot_status(path: String) -> FlyPilotStatus {
    let cfg = config_path(&path);
    let blob = blob_path(&path);

    let enabled = fs::read_to_string(&cfg)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("enabled").and_then(|e| e.as_bool()))
        .unwrap_or(false);

    let bytes = fs::metadata(&blob).map(|m| m.len()).unwrap_or(0);

    FlyPilotStatus {
        enabled,
        blob_present: bytes > 0,
        blob_mb: bytes as f64 / 1024.0 / 1024.0,
        config_path: cfg.display().to_string(),
        blob_path: blob.display().to_string(),
    }
}

/// Write `flypilot.json`. Existing keys are preserved so hand-tuned values (gains, the retina size,
/// which pawn to fly) survive a toggle; only `enabled` is rewritten.
#[tauri::command]
pub fn flypilot_set_enabled(path: String, enabled: bool) -> Result<(), String> {
    let dir = server_dir(&path);
    if !Path::new(&dir).is_dir() {
        return Err(format!(
            "{} does not exist — pick your Fortnite build folder first",
            dir.display()
        ));
    }
    let cfg = config_path(&path);

    let mut value: serde_json::Value = fs::read_to_string(&cfg)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| {
            serde_json::json!({
                "_comment": "Experimental. A simulation of the Janelia male CNS connectome flies a \
                             pawn. Written by the Nova launcher; safe to hand-edit.",
                "blobPath": BLOB_RELATIVE.replace('\\', "/"),
                "stepsPerTick": 20,
                "synGain": 0.10,
                "bgHz": 0.0,
                "gradedBias": 1.0,
                "prGain": 26.0,
                "retinaW": 96,
                "retinaH": 54,
                "hfov": 120.0,
                "vfov": 68.0,
                "sensitivity": 1.0,
                "deadZone": 0.22,
                "yawRateDegPerSec": 90.0,
                "allowMovement": true,
                "allowLook": true,
                "allowJump": true,
                "targetPlayerName": "",
                "spawnOwnPawn": true,
                "spawnNearPlayer": true,
                "spawnOffsetUnits": 700.0,
                "moveSpeedUnits": 420.0
            })
        });

    value["enabled"] = serde_json::Value::Bool(enabled);

    let text = serde_json::to_string_pretty(&value)
        .map_err(|e| format!("Could not serialise {}: {}", cfg.display(), e))?;
    fs::write(&cfg, text).map_err(|e| format!("Could not write {}: {}", cfg.display(), e))
}
