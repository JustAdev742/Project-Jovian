// ─────────────────────────────────────────────────────────────────────────────
//  Client-side attestation
//  Enumerates the DLLs loaded into the running Fortnite process and reports the list to the
//  coordinator, which compares it against the known-good set (see anticheat.service.ts).
//
//  Honest framing: this is SELF-REPORTED. A player who patches the launcher can send whatever list
//  they like, and a cheat that only reads game memory never shows up here at all. It raises the
//  effort required to cheat casually; it is not protection.
// ─────────────────────────────────────────────────────────────────────────────
use sysinfo::System;
use winapi::um::handleapi::{CloseHandle, INVALID_HANDLE_VALUE};
use winapi::um::tlhelp32::{
    CreateToolhelp32Snapshot, Module32FirstW, Module32NextW, MODULEENTRY32W, TH32CS_SNAPMODULE,
    TH32CS_SNAPMODULE32,
};

const GAME_EXE: &str = "FortniteClient-Win64-Shipping.exe";

fn fortnite_pid() -> Option<u32> {
    let mut sys = System::new_all();
    sys.refresh_all();
    for (pid, p) in sys.processes() {
        if p.name().to_string_lossy().eq_ignore_ascii_case(GAME_EXE) {
            return Some(pid.as_u32());
        }
    }
    None
}

/// Wide, NUL-padded fixed buffer → String.
fn wide_to_string(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

/// Names of every module currently loaded in the game process.
#[tauri::command]
pub fn list_game_modules() -> Result<Vec<String>, String> {
    let pid = fortnite_pid().ok_or_else(|| "Fortnite is not running".to_string())?;
    let mut out: Vec<String> = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
        if snap == INVALID_HANDLE_VALUE {
            return Err("could not inspect the game process".into());
        }
        let mut entry: MODULEENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<MODULEENTRY32W>() as u32;
        if Module32FirstW(snap, &mut entry) != 0 {
            loop {
                let name = wide_to_string(&entry.szModule);
                if !name.is_empty() {
                    out.push(name);
                }
                if Module32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
    }
    Ok(out)
}

/// Enumerate the game's modules and send them to the coordinator for review.
/// Silently succeeds with `false` when the game isn't running — this is called on a timer and a
/// closed game is the normal case, not an error worth surfacing to the player.
#[tauri::command]
pub async fn attest_now(coordinator: String, token: String) -> Result<bool, String> {
    let modules = match list_game_modules() {
        Ok(m) => m,
        Err(_) => return Ok(false), // game not running
    };
    if modules.is_empty() {
        return Ok(false);
    }
    let base = coordinator.trim_end_matches('/');
    let url = format!("{}/nova/api/anticheat/attest", base);
    let client = reqwest::Client::new();
    let res = client
        .post(&url)
        .header("Authorization", format!("bearer {}", token))
        .json(&serde_json::json!({ "modules": modules }))
        .send()
        .await
        .map_err(|e| format!("attestation failed: {}", e))?;
    Ok(res.status().is_success())
}
