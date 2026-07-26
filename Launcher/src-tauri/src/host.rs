// ─────────────────────────────────────────────────────────────────────────────
//  Nova P2P host-mode
//  Ties the launcher to the coordinator's host-election + the playit.gg tunnel that
//  makes a locally-hosted Reboot gameserver reachable globally.
//
//  Flow (driven from the UI on "Play"):
//    1. p2p_should_i_host()  → ask the coordinator whether to HOST or JOIN.
//    2. if HOST → setup_playit() (one-time claim) gives a public UDP address for 7777,
//       then p2p_register_host() announces it so joiners are routed to us.
//    3. Reboot injection (separate step, added once host-launch timing is validated in-game).
// ─────────────────────────────────────────────────────────────────────────────
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;

const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Per-user folder where Nova keeps helper tools (the playit agent, etc.).
fn nova_data_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".to_string());
    let mut p = PathBuf::from(base);
    p.push("ProjectNova");
    let _ = std::fs::create_dir_all(&p);
    p
}

fn playit_path() -> PathBuf {
    let mut p = nova_data_dir();
    p.push("playit.exe");
    p
}

/// Download the playit agent to the Nova data folder if it isn't there yet.
async fn ensure_playit() -> Result<PathBuf, String> {
    let path = playit_path();
    if path.exists() {
        return Ok(path);
    }
    // Official signed Windows build (playit-cloud/playit-agent latest release).
    let url = "https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-windows-x86_64-signed.exe";
    let client = reqwest::Client::new();
    let res = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("playit download request failed: {}", e))?;
    if !res.status().is_success() {
        return Err(format!("playit download HTTP {}", res.status()));
    }
    let bytes = res
        .bytes()
        .await
        .map_err(|e| format!("playit download read failed: {}", e))?;
    std::fs::write(&path, &bytes).map_err(|e| format!("failed to save playit: {}", e))?;
    Ok(path)
}

/// Ensure playit is downloaded, then open it in a visible console. The FIRST time, the agent
/// prints a claim URL — the user links it to their free playit.gg account (one-time) and creates
/// a UDP tunnel to 127.0.0.1:7777; after that it runs automatically and shows the public address.
#[tauri::command]
pub async fn setup_playit() -> Result<String, String> {
    let path = ensure_playit().await?;
    let path_str = path
        .to_str()
        .ok_or_else(|| "playit path is not valid UTF-8".to_string())?
        .to_string();
    // `cmd /C start "" "<playit.exe>"` opens it in its own visible window (so the user can see the
    // claim link + tunnel address). We intentionally do NOT hide this window.
    Command::new("cmd")
        .args(["/C", "start", "", &path_str])
        .spawn()
        .map_err(|e| format!("failed to launch playit: {}", e))?;
    Ok(path_str)
}

/// Just download playit without launching it (so the UI can pre-fetch it).
#[tauri::command]
pub async fn download_playit() -> Result<String, String> {
    let path = ensure_playit().await?;
    Ok(path.to_string_lossy().to_string())
}

// ── Coordinator integration ──────────────────────────────────────────────────

/// Mirrors the coordinator's should-i-host response. Fields are camelCase on BOTH sides: the
/// coordinator sends camelCase, and Tauri re-serializes this struct to the UI, which reads
/// `retryMs`/`tsIp`. Any field missing here is silently dropped before the UI ever sees it — that
/// is why the mesh fields are declared explicitly rather than relying on pass-through.
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HostDecision {
    pub host: bool,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub server: Option<String>,
    #[serde(default)]
    pub playlist: String,
    #[serde(default)]
    pub region: String,
    /// This machine's Tailscale address, as the coordinator knows it.
    #[serde(default)]
    pub ts_ip: Option<String>,
    /// Set when a better-suited machine is being given a chance to host first.
    #[serde(default)]
    pub better_host: Option<String>,
    /// How long the launcher should wait before asking again.
    #[serde(default)]
    pub retry_ms: Option<u64>,
    /// This machine's capability score (CPU/RAM/network), for display and diagnosis.
    #[serde(default)]
    pub score: Option<f64>,
}

/// Ask the coordinator whether this player should host (spin up Reboot) or join an existing host.
#[tauri::command]
pub async fn p2p_should_i_host(
    coordinator: String,
    account_id: String,
    playlist: String,
    region: String,
) -> Result<HostDecision, String> {
    let base = coordinator.trim_end_matches('/');
    let url = format!(
        "{}/nova/api/matchmaking/should-i-host?accountId={}&playlist={}&region={}",
        base, account_id, playlist, region
    );
    let client = reqwest::Client::new();
    let res = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("should-i-host request failed: {}", e))?;
    if !res.status().is_success() {
        return Err(format!("should-i-host HTTP {}", res.status()));
    }
    res.json::<HostDecision>()
        .await
        .map_err(|e| format!("should-i-host parse failed: {}", e))
}

/// Register this host's public (playit) address with the coordinator so joiners are routed to it.
/// Call this once the playit tunnel is up. Re-call every ~30s to heartbeat (the coordinator drops
/// a dynamic server after 60s of silence).
#[tauri::command]
pub async fn p2p_register_host(
    coordinator: String,
    address: String,
    port: u16,
    name: Option<String>,
) -> Result<bool, String> {
    let base = coordinator.trim_end_matches('/');
    let url = format!("{}/nova/api/gameserver/register", base);
    let body = serde_json::json!({
        "address": address,
        "port": port,
        "playlist": "*",
        "name": name.unwrap_or_else(|| "Nova host".to_string()),
    });
    let client = reqwest::Client::new();
    let res = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("register request failed: {}", e))?;
    Ok(res.status().is_success())
}

/// Remove this host from the coordinator (call when the host stops hosting).
#[tauri::command]
pub async fn p2p_unregister_host(
    coordinator: String,
    address: String,
    port: u16,
) -> Result<bool, String> {
    let base = coordinator.trim_end_matches('/');
    let url = format!("{}/nova/api/gameserver/unregister", base);
    let body = serde_json::json!({ "address": address, "port": port, "playlist": "*" });
    let client = reqwest::Client::new();
    let res = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("unregister request failed: {}", e))?;
    Ok(res.status().is_success())
}

/// Is a Fortnite gameserver/client instance currently running that we could inject into?
#[tauri::command]
pub fn is_gameserver_running() -> bool {
    use sysinfo::System;
    let mut system = System::new_all();
    system.refresh_all();
    system
        .processes()
        .values()
        .any(|p| p.name().to_string_lossy().eq_ignore_ascii_case("FortniteClient-Win64-Shipping.exe"))
}

// ── Reboot injection ─────────────────────────────────────────────────────────

/// Default location of the compiled cheat-free Reboot gameserver DLL (dev build path).
/// For distribution, copy it next to the launcher and pass the path explicitly.
const DEFAULT_REBOOT_DLL: &str =
    "C:\\Users\\Admin\\Documents\\backends\\_extracted\\Project-Reboot-main\\Project Reboot\\x64\\Release\\Project Reboot.dll";

/// Resolve a file/folder that ships ALONGSIDE the launcher exe (portable / zipped install). Returns
/// it only if it actually exists next to the exe, so a distributed bundle finds its own copies while
/// a dev build still falls back to the hardcoded dev paths below.
pub fn beside_exe(rel: &str) -> Option<String> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    // An INSTALLED build has its bundled payload under `resources/` (that is where Tauri puts
    // anything listed in bundle.resources); a dev build has these sitting next to the exe. Check both
    // so the same lookup works whether someone ran the installer or built from source.
    for candidate in [dir.join(rel), dir.join("resources").join(rel)] {
        if candidate.exists() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

/// Which Node to run. Prefers the copy shipped inside the installer so a fresh machine needs nothing
/// preinstalled; falls back to whatever is on PATH for dev builds.
pub fn node_exe() -> String {
    beside_exe("node/node.exe").unwrap_or_else(|| "node".to_string())
}

/// Inject Project Reboot.dll into the running Fortnite client, turning THAT instance into the
/// gameserver (it flips to server mode, travels to Athena_Terrain, listens on 7777).
///
/// IMPORTANT: call only AFTER the client has finished loading to the main menu — injecting too
/// early crashes the game. The UI exposes this as a button the host clicks once at the menu, so
/// the timing is user-controlled while we validate it in-game.
#[tauri::command]
pub fn inject_reboot(dll_path: Option<String>, pid: Option<u32>) -> Result<bool, String> {
    use injrs::inject_windows::*;
    use injrs::process_windows::Process;
    let dll = dll_path
        .or_else(|| beside_exe("Project Reboot.dll"))
        .unwrap_or_else(|| DEFAULT_REBOOT_DLL.to_string());
    if !std::path::Path::new(&dll).exists() {
        return Err(format!("Reboot DLL not found at {}", dll));
    }

    // Target the instance we actually launched as the server. Once the host is also playing there
    // are TWO processes with this exact name, and "first by name" is a coin flip — injecting into
    // the host's own game instead of the server would turn their client into a second server and
    // leave nobody hosting the match.
    //
    // `pid` is passed by the caller when the HOST AGENT spawned the server: that process belongs to
    // the backend, not to this launcher, so get_server_pid() knows nothing about it and the
    // find-by-name fallback would be exactly the coin flip described above.
    let process = match pid.or_else(crate::carter::get_server_pid) {
        Some(p) if crate::carter::pid_is_fortnite(p) => Process::from_pid(p)
            .ok_or_else(|| format!("could not open the game process (pid {})", p))?,
        Some(p) => return Err(format!("pid {} is not a running Fortnite process", p)),
        None => Process::find_first_by_name("FortniteClient-Win64-Shipping.exe")
            .ok_or_else(|| "Fortnite client not running (launch the game first)".to_string())?,
    };

    process
        .inject(&dll)
        .map_err(|e| format!("Reboot injection failed: {:?}", e))?;
    Ok(true)
}

// ── Local proxy (127.0.0.1:3551 -> coordinator) ──────────────────────────────
// Cobalt is hard-coded to redirect the game to 127.0.0.1:3551. The nova-proxy forwards that
// (HTTP + WebSocket, TLS to the coordinator) up to the shared global backend, so the game can
// use the coordinator without touching Cobalt. Start it before launching in global P2P mode.

const DEFAULT_COORDINATOR: &str = "https://clientfinder.tail0a8fd0.ts.net:8443";
const DEFAULT_PROXY_DIR: &str = "C:\\Users\\Admin\\Documents\\Project Nova\\nova-proxy";

fn proxy_pid_file() -> PathBuf {
    let mut p = nova_data_dir();
    p.push("proxy.pid");
    p
}

/// Where the local host agent (the backend in agent mode) listens. The proxy keeps host control and
/// this machine's logs here instead of forwarding them to the coordinator — see nova-proxy/proxy.js.
pub const LOCAL_AGENT: &str = "http://127.0.0.1:3552";

/// Start the local proxy so the game (via Cobalt→127.0.0.1:3551) reaches the global coordinator.
/// Pass a custom coordinator URL for a different deployment; defaults to the Tailscale Funnel URL.
#[tauri::command]
pub fn start_proxy(coordinator: Option<String>, proxy_dir: Option<String>) -> Result<bool, String> {
    stop_proxy(); // replace any previous instance
    let dir = proxy_dir
        .or_else(|| beside_exe("nova-proxy"))
        .unwrap_or_else(|| DEFAULT_PROXY_DIR.to_string());
    let script = std::path::Path::new(&dir).join("proxy.js");
    if !script.exists() {
        let m = format!("nova-proxy not found at {}", script.display());
        crate::dbg_log(&m);
        return Err(m);
    }
    let coord = coordinator.unwrap_or_else(|| DEFAULT_COORDINATOR.to_string());
    let child = Command::new(node_exe())
        .arg("proxy.js")
        .current_dir(&dir)
        .env("NOVA_COORDINATOR", coord)
        .env("NOVA_LOCAL_AGENT", LOCAL_AGENT)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| {
            let m = format!("failed to start proxy (is Node installed?): {}", e);
            crate::dbg_log(&m);
            m
        })?;
    let _ = std::fs::write(proxy_pid_file(), child.id().to_string());
    Ok(true)
}

/// Free a local port by stopping whatever Node process is listening on it.
///
/// Exists for one situation: P2P mode needs 3551 for the proxy, and a standalone Nova backend left
/// running from a previous session holds it. The proxy then dies on EADDRINUSE, that backend keeps
/// answering the game, and the player is silently alone — no shared matchmaking, no hosting.
///
/// Deliberately narrow. The caller must already have confirmed over HTTP that the listener is a Nova
/// backend and NOT the coordinator; on top of that this refuses to touch anything that isn't a Node
/// process, so a mistaken port can't take out something unrelated.
#[tauri::command]
pub fn free_port(port: u16) -> Result<bool, String> {
    let out = Command::new("cmd")
        .args(["/C", &format!("netstat -ano -p tcp | findstr LISTENING | findstr :{}", port)])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("could not inspect port {}: {}", port, e))?;
    let text = String::from_utf8_lossy(&out.stdout);

    let mut sys = sysinfo::System::new_all();
    sys.refresh_all();

    let mut stopped = false;
    for line in text.lines() {
        // "  TCP    127.0.0.1:3551   0.0.0.0:0   LISTENING   14688"
        let pid: u32 = match line.split_whitespace().last().and_then(|p| p.parse().ok()) {
            Some(p) => p,
            None => continue,
        };
        // Only local listeners we recognise — never a random pid parsed out of unexpected output.
        //
        // The address must be followed by whitespace. Matching on the bare prefix meant freeing
        // 3551 also matched a listener on 35510 or 35519 and killed it: netstat prints
        // "127.0.0.1:35510" which contains "127.0.0.1:3551". Unlikely, but the failure mode is
        // "we silently killed someone else's server", which is not a thing to leave to luck.
        let addressed_here = line
            .split_whitespace()
            .any(|tok| tok == format!("127.0.0.1:{}", port) || tok == format!("0.0.0.0:{}", port));
        if !addressed_here {
            continue;
        }
        let is_node = sys
            .process(sysinfo::Pid::from_u32(pid))
            .map(|p| p.name().to_string_lossy().to_lowercase().contains("node"))
            .unwrap_or(false);
        if !is_node {
            crate::dbg_log(&format!("free_port: leaving pid {} on {} alone (not node)", pid, port));
            continue;
        }
        let _ = Command::new("cmd")
            .args(["/C", "taskkill", "/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        crate::dbg_log(&format!("free_port: stopped node pid {} holding port {}", pid, port));
        stopped = true;
    }
    Ok(stopped)
}

/// Stop the local proxy (kills the tracked node process).
#[tauri::command]
pub fn stop_proxy() {
    if let Ok(pid_str) = std::fs::read_to_string(proxy_pid_file()) {
        let pid = pid_str.trim().to_string();
        if !pid.is_empty() {
            let _ = Command::new("cmd")
                .args(["/C", "taskkill", "/F", "/PID", &pid])
                .creation_flags(CREATE_NO_WINDOW)
                .spawn();
        }
        let _ = std::fs::remove_file(proxy_pid_file());
    }
}

/// Is the local proxy responding on 127.0.0.1:3551? (quick TCP-less check via the pid file)
#[tauri::command]
pub fn is_proxy_running() -> bool {
    // Checking only that the pidfile EXISTS reported a dead proxy as running: the file outlives the
    // process after a crash or reboot, and Windows reuses PIDs. Verify the process is actually
    // there, and clean up the stale file so the state can't stay wrong.
    let path = proxy_pid_file();
    let pid_str = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let pid: u32 = match pid_str.trim().parse() {
        Ok(p) => p,
        Err(_) => {
            let _ = std::fs::remove_file(&path);
            return false;
        }
    };
    let mut sys = sysinfo::System::new_all();
    sys.refresh_all();
    let alive = sys
        .process(sysinfo::Pid::from_u32(pid))
        .map(|p| p.name().to_string_lossy().to_lowercase().contains("node"))
        .unwrap_or(false);
    if !alive {
        let _ = std::fs::remove_file(&path);
    }
    alive
}
