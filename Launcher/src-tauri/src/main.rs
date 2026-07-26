#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::env;
use std::fs::create_dir_all;
use std::os::windows::process::CommandExt;
use sysinfo::System;
use tauri::{AppHandle, Manager, Window};
mod anticheat;
mod carter;
mod discord;
mod host;
mod tailscale;

#[derive(Debug)]
pub struct MyError;

impl warp::reject::Reject for MyError {}

impl std::fmt::Display for MyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "An error occurred")
    }
}

#[tauri::command]
fn close_launcher(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn window_minimize(window: Window) {
    let _ = window.minimize(); // ignore rather than panic the command thread
}

#[tauri::command]
async fn firstlaunch(
    path: String,
    app: AppHandle,
    account_id: String,
    token: String,
    eor: bool,
    headless: Option<bool>,
) -> Result<bool, String> {
    dbg_log(&format!("firstlaunch: begin (path={}, headless={:?})", path, headless));
    carter::kill();
    carter::kill_epic();

    // launch_fn already runs launch_real_launcher internally — calling it here too was
    // double-launching FortniteLauncher.exe and doubling the kill/suspend sequence every Play.
    let res = carter::launch_fn(&path, app, account_id, token, eor, headless.unwrap_or(false)).await;
    if let Err(e) = res {
        dbg_log(&format!("firstlaunch: launch_fn FAILED -> {}", e));
        return Err(e.to_string());
    }
    dbg_log("firstlaunch: launch_fn returned OK (Fortnite process spawned; if the game window never appears it crashed AFTER launch — check FortniteGame\\Saved\\Logs)");

    discord::set_presence("In a Match", "Project Nova — Fortnite 7.40");

    Ok(true)
}

#[tauri::command]
fn window_close(window: Window) {
    let _ = window.close(); // ignore rather than panic the command thread
}

/// Fallback location of the Node backend, used only if it can't be found relative to the exe or
/// via NOVA_BACKEND_DIR. Kept for the original dev machine's layout so nothing regresses there.
const BACKEND_DIR_FALLBACK: &str = "C:\\Users\\Admin\\Documents\\Project Nova\\Main backend";

/// Resolve the "Main backend" folder WITHOUT hardcoding a machine-specific path: prefer
/// NOVA_BACKEND_DIR, then a "Main backend" folder found by walking up from the launcher exe,
/// then the fallback constant. Fixes the launcher breaking on any machine but the original.
/// Folder names the backend ships under. The dev tree calls it "Main backend"; the distributable
/// calls it "Backend-Coordinator". Only the first was ever searched for, so on any machine but this
/// one the search fell through to the hardcoded dev path, which does not exist there — the host agent
/// then silently never started and that player could never host, however the election went.
const BACKEND_DIR_NAMES: [&str; 4] = ["Main backend", "Backend-Coordinator", "nova-backend", "backend"];

fn resolve_backend_dir() -> String {
    if let Ok(d) = std::env::var("NOVA_BACKEND_DIR") {
        if !d.trim().is_empty() {
            return d;
        }
    }
    // An installed build ships the agent as a bundled resource; that always wins.
    for name in BACKEND_DIR_NAMES {
        if let Some(found) = host::beside_exe(name) {
            if std::path::Path::new(&found).join("package.json").exists() {
                return found;
            }
        }
    }

    // Two passes, because "found a backend" and "found a backend that can actually run" are different
    // things. A copy whose dependencies were never installed would otherwise win purely by sitting
    // closer to the exe, and shadow a perfectly good one a folder up.
    let mut first_seen: Option<String> = None;
    if let Ok(exe) = std::env::current_exe() {
        let mut cur = exe.parent().map(|p| p.to_path_buf());
        while let Some(dir) = cur {
            for name in BACKEND_DIR_NAMES {
                let candidate = dir.join(name);
                if candidate.join("package.json").exists() {
                    if candidate.join("node_modules").exists() {
                        return candidate.to_string_lossy().to_string();
                    }
                    first_seen.get_or_insert_with(|| candidate.to_string_lossy().to_string());
                }
            }
            cur = dir.parent().map(|p| p.to_path_buf());
        }
    }
    // Nothing installed anywhere — return the closest one we saw so the error names a real folder.
    first_seen.unwrap_or_else(|| BACKEND_DIR_FALLBACK.to_string())
}

/// Start the Project Nova backend (`npm run dev`) from the Main backend folder.
///
/// Two roles, chosen by the caller:
///   - LOCAL BACKEND (no args): serves the game itself on 3551. Single-PC / LAN.
///   - HOST AGENT (`port` = 3552, `coordinator` set): the game is served by the shared coordinator
///     via nova-proxy, which owns 3551. The backend runs alongside on its own port purely to run a
///     gameserver when the coordinator elects this machine. Two processes cannot share 3551, and
///     when they raced for it whichever lost simply never came up.
#[tauri::command]
fn start_backend(
    path: Option<String>,
    port: Option<u16>,
    coordinator: Option<String>,
) -> Result<bool, String> {
    let dir = path.unwrap_or_else(resolve_backend_dir);
    if !std::path::Path::new(&dir).join("package.json").exists() {
        return Err(format!(
            "Nova backend not found (looked for {} next to the launcher, and at {})",
            BACKEND_DIR_NAMES.join(" / "),
            dir
        ));
    }
    // `npm run dev` against a backend with no dependencies installed fails a few seconds later, in a
    // hidden console, leaving the launcher waiting on an agent that is never coming. Say it up front.
    if !std::path::Path::new(&dir).join("node_modules").exists() {
        return Err(format!(
            "the Nova backend at {} has no dependencies installed — run 1-setup.bat in that folder once (needs Node.js)",
            dir
        ));
    }
    // Run node directly rather than `cmd /C cd /d … && npm run dev`. That old form depended on cmd's
    // quoting rules for a path containing a space, and on npm being on PATH — two ways to fail that
    // both produce nothing but a hidden window closing.
    //
    // An INSTALLED build ships compiled JS (dist/), so it needs no TypeScript toolchain at all — that
    // is 34 MB of tsx + typescript we do not have to put in the installer. A dev tree has no dist, so
    // fall back to running the sources through tsx there.
    let dist = std::path::Path::new(&dir).join("dist/index.js");
    let tsx = std::path::Path::new(&dir).join("node_modules/tsx/dist/cli.mjs");

    let script_args: Vec<String> = if dist.exists() {
        vec![dist.to_string_lossy().into_owned()]
    } else if tsx.exists() {
        vec![tsx.to_string_lossy().into_owned(), "src/index.ts".to_string()]
    } else {
        return Err(format!(
            "the Nova backend at {} has neither a compiled dist/ nor tsx — reinstall, or run 1-setup.bat in that folder",
            dir
        ));
    };

    // THE important part. The launcher is a GUI process with no console, so a child that inherits its
    // stdout/stderr gets invalid handles and Node dies the moment it prints its first line — silently,
    // with no window and no log. Give it a real file to write to: the crash becomes visible instead of
    // the backend just never existing.
    let log_path = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|p| p.join("nova-agent.log")))
        .unwrap_or_else(|| std::path::PathBuf::from("nova-agent.log"));
    let log = std::fs::File::create(&log_path)
        .map_err(|e| format!("could not open {}: {}", log_path.display(), e))?;
    let log_err = log
        .try_clone()
        .map_err(|e| format!("could not open the backend log: {}", e))?;

    let mut cmd = std::process::Command::new(host::node_exe());
    cmd.args(&script_args).current_dir(&dir);
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::from(log));
    cmd.stderr(std::process::Stdio::from(log_err));
    if let Some(p) = port {
        cmd.env("NOVA_PORT", p.to_string());
    }
    if let Some(c) = coordinator.as_deref().filter(|c| !c.trim().is_empty()) {
        cmd.env("NOVA_COORDINATOR", c);
        // The agent must run the same election rules as the coordinator it obeys, or it would read
        // every verdict through the "host election disabled" path and never host.
        cmd.env("NOVA_HOST_ELECTION", "1");
        // No game client ever connects to the agent — the proxy owns that. Binding the standalone
        // XMPP listener on port 80 would only risk a clash with whatever else wants it.
        cmd.env("NOVA_DISABLE_STANDALONE_XMPP", "1");
    }
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    let child = cmd
        .spawn()
        .map_err(|e| format!("could not start the Nova backend (is Node.js installed?): {}", e))?;
    dbg_log(&format!(
        "start_backend: pid {} from {} (port {}, coordinator {}) -> {}",
        child.id(),
        dir,
        port.unwrap_or(3551),
        coordinator.as_deref().unwrap_or("none — standalone"),
        log_path.display()
    ));
    Ok(true)
}

/// Force-close the running game / anti-cheat processes (a "Stop Game" button).
#[tauri::command]
fn stop_game() {
    for proc in [
        "FortniteClient-Win64-Shipping.exe",
        "FortniteClient-Win64-Shipping_EAC.exe",
        "FortniteClient-Win64-Shipping_BE.exe",
        "FortniteLauncher.exe",
    ] {
        let _ = std::process::Command::new("cmd")
            .creation_flags(0x08000000)
            .args(&["/C", "taskkill", "/F", "/IM", proc])
            .spawn();
    }
}

/// Append a line to `launcher-startup.log` next to the exe. Best-effort; this is how we catch a
/// silent immediate-close on a machine that shows no console output and no Event Viewer entry.
pub fn dbg_log(msg: &str) {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            use std::io::Write;
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("launcher-startup.log"))
            {
                let _ = writeln!(f, "{}", msg);
            }
        }
    }
}

#[tokio::main]
async fn main() {
    // Record ANY panic (e.g. a failed webview/window init inside `.run()`) so a silent close leaves a
    // readable reason behind instead of vanishing.
    std::panic::set_hook(Box::new(|info| dbg_log(&format!("PANIC: {}", info))));
    dbg_log("--- launcher start ---");

    // This assumed the dev machine (Program Files needs admin). Non-fatal — just note if it fails.
    if let Err(e) = create_dir_all("C:\\Program Files\\Project Launcher") {
        dbg_log(&format!("note: could not create Program Files dir (non-fatal): {}", e));
    }

    dbg_log("entering tauri run (creating window + webview)...");
    tauri::Builder::default()
        .setup(|app| {
            discord::init();
            let window = match app.get_window("main") {
                Some(w) => w,
                None => {
                    dbg_log("setup: no 'main' window found — check window config");
                    return Ok(());
                }
            };
            window.on_window_event(|event| {
                if let tauri::WindowEvent::CloseRequested { .. } = event {
                    carter::kill();

                    // Stop the helpers this launcher started — but ONLY if the player's game has
                    // already exited.
                    //
                    // Two reasons this matters. The obvious one: the host agent answering the
                    // coordinator's elections on behalf of somebody who has closed the launcher
                    // means matches get handed to a machine nobody is watching.
                    //
                    // The one that actually bit us: both helpers run `resources/node/node.exe` from
                    // INSIDE the install folder, and Windows will not let a running executable be
                    // overwritten. A helper left over from a previous session makes the next update
                    // fail halfway through with "Error opening file for writing", which is a
                    // miserable thing to hand someone who pressed Update.
                    //
                    // The guard is the point. The agent is deliberately allowed to outlive the
                    // launcher window while a match is in progress, because killing it would drop
                    // every player connected through this machine.
                    if !is_fortnite_client_running() {
                        host::stop_proxy();
                        let _ = host::free_port(3552); // the host agent
                    }
                }
            });

            // (A release-only "close devtools" block used to sit here. It was gated on a `devtools`
            //  cargo feature that does not exist in Cargo.toml, so the body was always stripped and
            //  the block did nothing at all. Removed rather than silenced.)
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            window_minimize,
            window_close,
            firstlaunch,
            is_fortnite_client_running,
            close_launcher,
            start_backend,
            stop_game,
            host::setup_playit,
            host::download_playit,
            host::p2p_should_i_host,
            host::p2p_register_host,
            host::p2p_unregister_host,
            host::is_gameserver_running,
            host::start_proxy,
            host::stop_proxy,
            host::is_proxy_running,
            host::free_port,
            host::inject_reboot,
            carter::launch_client_only,
            carter::launch_server_only,
            carter::server_launch_spec,
            carter::host_session_state,
            carter::server_readiness,
            carter::stop_server_instance,
            tailscale::ts_status,
            tailscale::ts_ensure_installed,
            tailscale::ts_up,
            tailscale::ts_ip,
            tailscale::ts_ensure_firewall,
            tailscale::mesh_specs,
            tailscale::mesh_announce,
            tailscale::ts_fetch_authkey,
            tailscale::mesh_bring_up,
            tailscale::reboot_dll_present,
            anticheat::list_game_modules,
            anticheat::attest_now
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| dbg_log(&format!("tauri run FAILED: {:?}", e)));
    dbg_log("--- launcher exited ---");
}

#[tauri::command]
fn is_fortnite_client_running() -> bool {
    let mut system = System::new_all();
    system.refresh_all();

    for (_, process) in system.processes() {
        if process
            .name()
            .to_string_lossy()
            .contains("FortniteClient-Win64-Shipping.exe")
        {
            return true;
        }
    }

    false
}
