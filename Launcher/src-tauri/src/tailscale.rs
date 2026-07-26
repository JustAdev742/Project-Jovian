// ─────────────────────────────────────────────────────────────────────────────
//  Nova Tailscale auto-mesh
//  The "silent background service" that makes multiplayer automatic. On login the launcher brings
//  a Tailscale node up (joined headlessly with a pre-authorized auth key served by the
//  coordinator), then announces this machine — its Tailscale 100.x IP plus CPU/RAM/network — as a
//  candidate host. The coordinator picks the best-suited machine; the host's Reboot server is
//  reachable at its 100.x address with NAT traversal handled by Tailscale.
//
//  Why 100.x matters: it is a NUMERIC IP, so Fortnite's session code can always parse it (a
//  hostname like a playit address cannot be — that was a real FindSessionFailure bug).
// ─────────────────────────────────────────────────────────────────────────────
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

const CREATE_NO_WINDOW: u32 = 0x08000000;
const TS_MSI_URL: &str = "https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi";

/// Standard install locations for the Tailscale CLI.
fn tailscale_exe() -> Option<PathBuf> {
    let candidates = [
        "C:\\Program Files\\Tailscale\\tailscale.exe",
        "C:\\Program Files (x86)\\Tailscale\\tailscale.exe",
    ];
    for c in candidates.iter() {
        let p = PathBuf::from(c);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

/// Why a CLI call didn't produce output. Timeout is called out separately because it has a specific,
/// actionable cause (see `ts_run`).
#[derive(Debug)]
pub enum TsError {
    NotInstalled,
    /// The daemon never answered. On Windows this overwhelmingly means the wintun driver was just
    /// installed and the machine has not been restarted yet, so tailscaled is stuck in
    /// "Failed to setup adapter (problem code: 0x38 / CM_PROB_NEED_RESTART)" and its local API
    /// never becomes ready. Every CLI call then blocks FOREVER, which is why there is a timeout.
    Timeout,
    Failed(String),
}

impl std::fmt::Display for TsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TsError::NotInstalled => write!(f, "Tailscale is not installed"),
            TsError::Timeout => write!(
                f,
                "Tailscale isn't responding — Windows needs to restart to finish installing its network driver"
            ),
            TsError::Failed(e) => write!(f, "{}", e),
        }
    }
}

/// Run the Tailscale CLI with a HARD timeout and capture stdout (trimmed).
///
/// The timeout is not defensive padding: a freshly installed Tailscale whose driver needs a reboot
/// leaves the daemon unable to serve its local API, and the CLI waits on it indefinitely. Without a
/// timeout the launcher hangs on "Joining the player network…" with no explanation, and the 30s
/// announce timer piles up one stuck process per tick.
fn ts_run_timeout(args: &[&str], timeout_secs: u64) -> Result<String, TsError> {
    let exe = tailscale_exe().ok_or(TsError::NotInstalled)?;
    let mut child = Command::new(exe)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| TsError::Failed(format!("failed to run tailscale {:?}: {}", args, e)))?;

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(TsError::Timeout);
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(e) => return Err(TsError::Failed(format!("tailscale {:?}: {}", args, e))),
        }
    }

    // Already exited, so this returns immediately and drains both pipes.
    let out = child
        .wait_with_output()
        .map_err(|e| TsError::Failed(format!("tailscale {:?}: {}", args, e)))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(TsError::Failed(if err.is_empty() {
            format!("tailscale {:?} failed", args)
        } else {
            err
        }));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}


#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MeshStatus {
    pub installed: bool,
    pub connected: bool,
    /// The machine's Tailscale IPv4 (100.x) once connected.
    pub ip: Option<String>,
    pub detail: String,
    /// True when the only thing standing between this machine and the mesh is a Windows restart.
    /// The UI must say so plainly — the user cannot guess it, and everything else looks healthy.
    pub needs_restart: bool,
}

impl MeshStatus {
    fn offline(detail: impl Into<String>, installed: bool, needs_restart: bool) -> Self {
        MeshStatus { installed, connected: false, ip: None, detail: detail.into(), needs_restart }
    }
}

/// Has the Tailscale driver been installed but not yet activated by a restart?
/// Reads tailscaled's own log for the adapter failure rather than guessing.
fn driver_needs_restart() -> bool {
    let dir = std::path::Path::new("C:\\ProgramData\\Tailscale\\Logs");
    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().map(|x| x == "txt").unwrap_or(false) {
                if let Ok(meta) = e.metadata() {
                    if let Ok(m) = meta.modified() {
                        if newest.as_ref().map(|(t, _)| m > *t).unwrap_or(true) {
                            newest = Some((m, p));
                        }
                    }
                }
            }
        }
    }
    let Some((_, path)) = newest else { return false };
    let Ok(text) = std::fs::read_to_string(&path) else { return false };
    // Only look at the tail — an old failure from a previous boot is not current state.
    let tail: String = text.chars().rev().take(20_000).collect::<String>().chars().rev().collect();
    tail.contains("problem code: 0x38") || tail.contains("0x000010DF")
}

/// Where is this machine on the mesh right now?
#[tauri::command]
pub fn ts_status() -> MeshStatus {
    if tailscale_exe().is_none() {
        return MeshStatus::offline("Tailscale not installed", false, false);
    }
    match ts_run_timeout(&["ip", "-4"], 6) {
        Ok(ip) => {
            let ip = ip.lines().next().unwrap_or("").trim().to_string();
            if ip.starts_with("100.") {
                MeshStatus { installed: true, connected: true, ip: Some(ip), detail: "connected".into(), needs_restart: false }
            } else {
                MeshStatus::offline("installed but not connected", true, false)
            }
        }
        Err(TsError::Timeout) => {
            let restart = driver_needs_restart();
            MeshStatus::offline(
                if restart {
                    "Restart your PC to finish setting up Tailscale — Windows installed its network driver but can't use it until you reboot."
                } else {
                    "Tailscale isn't responding yet."
                },
                true,
                restart,
            )
        }
        Err(e) => MeshStatus::offline(e.to_string(), true, false),
    }
}

/// Download + silently install the Tailscale client if it isn't present.
/// This is the ONE step that needs elevation (it installs a network adapter driver); Windows will
/// show a single UAC prompt. Everything after this is silent.
#[tauri::command]
pub async fn ts_ensure_installed() -> Result<bool, String> {
    if tailscale_exe().is_some() {
        return Ok(true);
    }
    let mut msi = std::env::temp_dir();
    msi.push("tailscale-setup-nova.msi");

    let client = reqwest::Client::new();
    let res = client
        .get(TS_MSI_URL)
        .send()
        .await
        .map_err(|e| format!("Tailscale download failed: {}", e))?;
    if !res.status().is_success() {
        return Err(format!("Tailscale download HTTP {}", res.status()));
    }
    let bytes = res.bytes().await.map_err(|e| format!("Tailscale download read failed: {}", e))?;
    std::fs::write(&msi, &bytes).map_err(|e| format!("failed to save installer: {}", e))?;

    let status = Command::new("msiexec")
        .args(["/i", msi.to_string_lossy().as_ref(), "/quiet", "/norestart"])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|e| format!("failed to run installer (needs admin): {}", e))?;
    if !status.success() {
        return Err("Tailscale installer did not complete (approve the admin prompt and retry)".into());
    }
    Ok(tailscale_exe().is_some())
}

/// Join the tailnet headlessly with a pre-authorized auth key. `--unattended` keeps the node up
/// after logout so the background service behaves like a service.
#[tauri::command]
pub fn ts_up(auth_key: String, hostname: Option<String>) -> Result<String, String> {
    if auth_key.trim().is_empty() {
        return Err("no tailnet auth key provided".into());
    }
    // Pass the key via a FILE, not on the command line. Process command lines are readable by any
    // local process (and by anything that dumps the process list), so `--auth-key=tskey-…` leaks a
    // credential that can add devices to the tailnet. `file:` keeps it out of argv.
    let mut key_path = std::env::temp_dir();
    key_path.push("nova-tskey.tmp");
    std::fs::write(&key_path, auth_key.trim())
        .map_err(|e| format!("could not stage the auth key: {}", e))?;

    let key_arg = format!("--auth-key=file:{}", key_path.to_string_lossy());
    let host = hostname.unwrap_or_else(|| "nova-player".to_string());
    let host_arg = format!("--hostname={}", host);
    let result = ts_run_timeout(&["up", &key_arg, "--unattended", &host_arg, "--accept-routes"], 60);

    // Remove the key file whatever happened — it must not outlive the command.
    let _ = std::fs::remove_file(&key_path);

    match result {
        Ok(_) => {}
        Err(TsError::Timeout) => {
            return Err(if driver_needs_restart() {
                "Restart your PC to finish setting up Tailscale, then press Play again.".to_string()
            } else {
                "Tailscale didn't finish connecting in time.".to_string()
            })
        }
        Err(e) => return Err(e.to_string()),
    }

    let ip = ts_run_timeout(&["ip", "-4"], 10).map_err(|e| e.to_string())?;
    Ok(ip.lines().next().unwrap_or("").trim().to_string())
}

/// This machine's Tailscale IPv4 (100.x).
#[tauri::command]
pub fn ts_ip() -> Result<String, String> {
    let ip = ts_run_timeout(&["ip", "-4"], 6).map_err(|e| e.to_string())?;
    let ip = ip.lines().next().unwrap_or("").trim().to_string();
    if ip.is_empty() { Err("no Tailscale IP yet".into()) } else { Ok(ip) }
}

/// Allow inbound UDP 7777 so peers on the mesh can reach the Reboot gameserver. Windows Firewall
/// blocks inbound on the Tailscale adapter by default. Best-effort: needs admin, and it's harmless
/// (and idempotent-ish) if it fails — we just report it.
#[tauri::command]
pub fn ts_ensure_firewall() -> Result<bool, String> {
    let name = "Nova Fortnite Gameserver (UDP 7777)";
    // Remove any prior copy so we don't stack duplicates, then add.
    let _ = Command::new("netsh")
        .args(["advfirewall", "firewall", "delete", "rule", &format!("name={}", name)])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    let out = Command::new("netsh")
        .args([
            "advfirewall", "firewall", "add", "rule",
            &format!("name={}", name),
            "dir=in", "action=allow", "protocol=UDP", "localport=7777",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("failed to run netsh (needs admin): {}", e))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(true)
}

// ── Machine capability (for host selection) ──────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct MachineSpecs {
    pub cpu_cores: usize,
    pub ram_gb: f64,
    pub net_score: u32,
}

fn machine_specs() -> MachineSpecs {
    use sysinfo::System;
    let mut sys = System::new_all();
    sys.refresh_all();
    let cpu_cores = sys.cpus().len().max(1);
    // sysinfo reports bytes.
    let ram_gb = (sys.total_memory() as f64) / 1024.0 / 1024.0 / 1024.0;
    MachineSpecs { cpu_cores, ram_gb: (ram_gb * 10.0).round() / 10.0, net_score: 50 }
}

/// Report this machine's capability (CPU/RAM plus a coarse network score derived from coordinator
/// round-trip time). Used by the coordinator to pick the best host.
#[tauri::command]
pub async fn mesh_specs(coordinator: String) -> Result<MachineSpecs, String> {
    let mut specs = machine_specs();
    // Coarse network score: round-trip to the coordinator. Lower latency → higher score.
    let base = coordinator.trim_end_matches('/');
    let url = format!("{}/nova/api/info", base);
    let started = std::time::Instant::now();
    let client = reqwest::Client::new();
    let ok = client.get(&url).send().await.map(|r| r.status().is_success()).unwrap_or(false);
    if ok {
        let ms = started.elapsed().as_millis() as i64;
        // 0 ms → 100, 500 ms+ → 0
        let score = 100 - (ms / 5);
        specs.net_score = score.clamp(0, 100) as u32;
    } else {
        specs.net_score = 0;
    }
    Ok(specs)
}

/// Announce this machine to the coordinator as available to host (call every ~30s to stay live).
#[tauri::command]
pub async fn mesh_announce(coordinator: String, account_id: String) -> Result<bool, String> {
    let ip = ts_ip().unwrap_or_default();
    // A machine with no mesh address cannot be reached by other players, so it must not present
    // itself as a host candidate. Staying silent also lets the coordinator fall back to its
    // original first-come election instead of picking an unreachable "best" machine.
    if ip.is_empty() {
        return Ok(false);
    }
    let specs = mesh_specs(coordinator.clone()).await?;
    let base = coordinator.trim_end_matches('/');
    let url = format!("{}/nova/api/mesh/announce", base);
    let body = serde_json::json!({
        "accountId": account_id,
        "tsIp": ip,
        "cpuCores": specs.cpu_cores,
        "ramGB": specs.ram_gb,
        "netScore": specs.net_score,
    });
    let client = reqwest::Client::new();
    let res = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("mesh announce failed: {}", e))?;
    Ok(res.status().is_success())
}

/// Fetch the tailnet auth key from the coordinator (requires the player's bearer token).
#[tauri::command]
pub async fn ts_fetch_authkey(coordinator: String, token: String) -> Result<String, String> {
    let base = coordinator.trim_end_matches('/');
    let url = format!("{}/nova/api/tailnet-authkey", base);
    let client = reqwest::Client::new();
    let res = client
        .get(&url)
        .header("Authorization", format!("bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("auth key request failed: {}", e))?;
    if !res.status().is_success() {
        return Err(format!("coordinator has no tailnet auth key configured (HTTP {})", res.status()));
    }
    let v: serde_json::Value = res.json().await.map_err(|e| format!("auth key parse failed: {}", e))?;
    v.get("authKey")
        .and_then(|k| k.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "coordinator returned no authKey".to_string())
}

/// One call the launcher makes after login: get the mesh fully ready.
/// install (if needed) → fetch key → join tailnet → firewall rule → announce capability.
/// Returns the machine's Tailscale IP. Degrades with a clear error if the coordinator has no key,
/// so the caller can fall back to the existing flow instead of breaking.
#[tauri::command]
pub async fn mesh_bring_up(
    coordinator: String,
    account_id: String,
    token: String,
    hostname: Option<String>,
) -> Result<MeshStatus, String> {
    // Already connected? Just refresh the announcement.
    let status = ts_status();
    if status.connected {
        let _ = ts_ensure_firewall();
        let _ = mesh_announce(coordinator.clone(), account_id.clone()).await;
        return Ok(status);
    }
    // Nothing else can succeed until the machine restarts, so say so instead of retrying.
    if status.needs_restart {
        return Ok(status);
    }

    // Fetch the key BEFORE installing anything. If the coordinator has no tailnet key configured
    // the mesh cannot work, and installing a network driver (with its admin prompt) on a player's
    // machine for a feature that is switched off would be rude.
    let key = ts_fetch_authkey(coordinator.clone(), token).await?;
    let freshly_installed = !matches!(tailscale_exe(), Some(_));
    ts_ensure_installed().await?;

    let ip = match ts_up(key, hostname) {
        Ok(ip) => ip,
        Err(e) => {
            // A brand-new install that can't talk to its daemon is the reboot case, every time.
            let restart = driver_needs_restart() || freshly_installed;
            return Ok(MeshStatus::offline(
                if restart {
                    "Restart your PC to finish setting up Tailscale, then press Play again.".to_string()
                } else {
                    e
                },
                true,
                restart,
            ));
        }
    };

    let _ = ts_ensure_firewall(); // best-effort; report via status rather than failing the whole flow
    let _ = mesh_announce(coordinator.clone(), account_id).await;

    Ok(MeshStatus {
        installed: true,
        connected: ip.starts_with("100."),
        ip: if ip.is_empty() { None } else { Some(ip) },
        detail: "mesh ready".into(),
        needs_restart: false,
    })
}

/// Is the compiled Reboot gameserver DLL present where we expect it?
#[tauri::command]
pub fn reboot_dll_present(dll_path: Option<String>) -> bool {
    match dll_path {
        Some(p) => Path::new(&p).exists(),
        None => Path::new(
            "C:\\Users\\Admin\\Documents\\backends\\_extracted\\Project-Reboot-main\\Project Reboot\\x64\\Release\\Project Reboot.dll",
        )
        .exists(),
    }
}
