use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use winapi::shared::minwindef::FALSE;
use winapi::um::handleapi::CloseHandle;
use winapi::um::processthreadsapi::{OpenThread, SuspendThread};
use winapi::um::tlhelp32::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};

use winapi::um::winnt::HANDLE;
use winapi::um::winnt::THREAD_SUSPEND_RESUME;

use sysinfo::System;

const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Undo a display config the HEADLESS SERVER wrecked, without touching settings the player chose.
///
/// The server is the same executable as the client and shares one config folder, but it runs with
/// `-nullrhi` — no real render surface — so on exit it saves a degenerate window size. Observed:
/// `ResolutionSizeX=160`, `ResolutionSizeY=28`, `FullscreenMode=2`. The next client launch honours
/// that faithfully and the game opens as a 160x28 sliver.
///
/// So this repairs only values that cannot have come from a person: anything at or above a modest
/// minimum is left completely alone, which is what keeps the in-game video settings working. Pick
/// 800x600 windowed in game and it survives; get handed 160x28 by a headless server and it doesn't.
fn repair_client_display_settings() {
    const MIN_SANE_W: i64 = 640;
    const MIN_SANE_H: i64 = 480;

    let local_app_data = match std::env::var("LOCALAPPDATA") {
        Ok(v) => v,
        Err(_) => return,
    };
    let mut path = std::path::PathBuf::from(local_app_data);
    path.push("FortniteGame");
    path.push("Saved");
    path.push("Config");
    path.push("WindowsClient");
    path.push("GameUserSettings.ini");

    // No file yet means a fresh install; the game picks its own sensible defaults.
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return,
    };

    let value_of = |key: &str| -> Option<i64> {
        content.lines().find_map(|l| {
            let t = l.trim();
            t.strip_prefix(key)
                .and_then(|r| r.strip_prefix('='))
                .and_then(|v| v.trim().parse::<i64>().ok())
        })
    };

    let w = value_of("ResolutionSizeX").unwrap_or(0);
    let h = value_of("ResolutionSizeY").unwrap_or(0);
    if w >= MIN_SANE_W && h >= MIN_SANE_H {
        return; // a real resolution — the player's choice, leave it be
    }

    // The game records the actual desktop size here, so it adapts to whatever monitor this is.
    let target_w = value_of("DesiredScreenWidth").filter(|v| *v >= MIN_SANE_W).unwrap_or(1920);
    let target_h = value_of("DesiredScreenHeight").filter(|v| *v >= MIN_SANE_H).unwrap_or(1080);

    println!(
        "[Display] GameUserSettings had {}x{} — restoring {}x{} fullscreen",
        w, h, target_w, target_h
    );

    let rewritten: Vec<String> = content
        .lines()
        .map(|line| {
            let t = line.trim_start();
            let set = |v: i64| -> Option<String> { Some(format!("{}={}", t.split('=').next().unwrap_or("").trim(), v)) };
            let replaced = if t.starts_with("ResolutionSizeX=") || t.starts_with("LastUserConfirmedResolutionSizeX=") {
                set(target_w)
            } else if t.starts_with("ResolutionSizeY=") || t.starts_with("LastUserConfirmedResolutionSizeY=") {
                set(target_h)
            // 0 = Fullscreen, 1 = Windowed Fullscreen, 2 = Windowed. Fullscreen is the normal default,
            // and it stays changeable in game because we only ever get here when the value is broken.
            } else if t.starts_with("FullscreenMode=")
                || t.starts_with("LastConfirmedFullscreenMode=")
                || t.starts_with("PreferredFullscreenMode=")
            {
                set(0)
            } else {
                None
            };
            replaced.unwrap_or_else(|| line.to_string())
        })
        .collect();

    // Keep the file's own line endings — it is a Windows INI written by the game, and there is no
    // reason for a repair to also rewrite every line's terminator.
    let newline = if content.contains("\r\n") { "\r\n" } else { "\n" };
    let mut out = rewritten.join(newline);
    if content.ends_with('\n') {
        out.push_str(newline);
    }

    if let Err(e) = std::fs::write(&path, out) {
        eprintln!("[Display] could not repair GameUserSettings.ini: {}", e);
    }
}

/// Point Fortnite's XMPP at Nova, and PROVE it landed.
///
/// Returns an error the player can act on. Every launch path propagates it rather than launching
/// anyway — see the verification block below for why an unpatched ini is fatal rather than degraded.
fn patch_local_engine_ini() -> Result<(), String> {
    let local_app_data = std::env::var("LOCALAPPDATA").map_err(|_| {
        "Windows did not report a LOCALAPPDATA folder, so Nova cannot find Fortnite's config."
            .to_string()
    })?;
    let mut engine_ini_path = std::path::PathBuf::from(local_app_data);
    engine_ini_path.push("FortniteGame");
    engine_ini_path.push("Saved");
    engine_ini_path.push("Config");
    engine_ini_path.push("WindowsClient");
    engine_ini_path.push("Engine.ini");
    patch_engine_ini_at(&engine_ini_path)
}

/// The BUILD's own config, inside the Fortnite folder.
///
/// This is where `ws://127.0.0.1:80` actually comes from. Repacked 7.40 builds ship a
/// DefaultEngine.ini already pointed at 127.0.0.1 but with NO port, so ws:// falls back to its
/// default of 80, nothing is listening there, and the client force-logs-out ~400ms after signing in.
/// The launcher has only ever written the `:3551` form, so a portless address in a player's log can
/// only have come from the build itself.
///
/// Saved/Config outranks this file, so patching both means EITHER landing is enough — a machine
/// where the Saved write doesn't stick still gets a correct address from here. Non-fatal on purpose:
/// the Saved patch is already verified and fatal, so failing to also patch the build (read-only
/// install, game folder on a locked drive) is not a reason to refuse a launch that would work.
fn patch_build_engine_ini(base: &std::path::Path) -> Result<(), String> {
    let mut p = base.to_path_buf();
    p.push("FortniteGame");
    p.push("Config");
    p.push("DefaultEngine.ini");
    patch_engine_ini_at(&p)
}

fn patch_engine_ini_at(engine_ini_path: &std::path::Path) -> Result<(), String> {
    {
        println!("Patching Engine.ini at: {:?}", engine_ini_path);

        let xmpp_sections = "
[OnlineSubsystemMcp.Xmpp]
bUseSSL=false
ServerAddr=\"ws://127.0.0.1:3551\"
ServerPort=3551

[OnlineSubsystemMcp.Xmpp Prod]
bUseSSL=false
ServerAddr=\"ws://127.0.0.1:3551\"
ServerPort=3551

[OnlineSubsystemMcp]
bUsePartySystemV2=false

[OnlineSubsystemMcp.OnlinePartySystemMcpAdapter]
bUsePartySystemV2=false

[XMPP]
bEnableWebsockets=true

[/Script/Engine.NetworkSettings]
n.VerifyPeer=false
";

        let mut existing_content = String::new();
        if engine_ini_path.exists() {
            existing_content = std::fs::read_to_string(&engine_ini_path).unwrap_or_default();
        } else {
            if let Some(parent) = engine_ini_path.parent() {
                std::fs::create_dir_all(parent).unwrap_or_default();
            }
        }

        let sections_to_remove = [
            "OnlineSubsystemMcp.Xmpp",
            "OnlineSubsystemMcp.Xmpp Prod",
            "OnlineSubsystemMcp",
            "OnlineSubsystemMcp.OnlinePartySystemMcpAdapter",
            "XMPP",
            "/Script/Engine.NetworkSettings",
        ];

        let mut filtered_lines = Vec::new();
        let mut skip_section = false;

        for line in existing_content.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with('[') && trimmed.ends_with(']') {
                let section_name = &trimmed[1..trimmed.len() - 1];
                skip_section = sections_to_remove.contains(&section_name);
                if skip_section {
                    continue;
                }
            }
            if skip_section {
                if trimmed.is_empty() {
                    continue;
                }
                if trimmed.starts_with('[') {
                    skip_section = false;
                } else {
                    continue;
                }
            }
            filtered_lines.push(line);
        }

        // Collapse runs of blank lines and trim the tail before re-appending. Without this the file
        // grows every single launch: stripping our sections leaves their surrounding blank lines
        // behind, and `xmpp_sections` starts with a newline, so each run adds several more. A real
        // Engine.ini here had reached 78 lines of which 53 were blank — and since this now runs on
        // all three launch paths rather than one, it was accumulating three times as fast.
        let mut compacted: Vec<&str> = Vec::with_capacity(filtered_lines.len());
        let mut prev_blank = false;
        for line in filtered_lines {
            let blank = line.trim().is_empty();
            if blank && prev_blank {
                continue;
            }
            prev_blank = blank;
            compacted.push(line);
        }
        while compacted.last().map_or(false, |l| l.trim().is_empty()) {
            compacted.pop();
        }

        let mut final_content = compacted.join("\n");
        final_content.push_str("\n");
        final_content.push_str(xmpp_sections);

        // Clear read-only before writing. Repacked 7.40 builds very often ship Engine.ini read-only,
        // or the player is told to set it read-only so the game stops overwriting their settings —
        // and std::fs::write on a read-only file fails with PermissionDenied. This used to be a
        // silent eprintln, which is exactly how a laptop ended up launching with an UNPATCHED ini.
        if let Ok(meta) = std::fs::metadata(&engine_ini_path) {
            let mut perms = meta.permissions();
            if perms.readonly() {
                println!("Engine.ini is read-only — clearing the attribute so Nova can patch it.");
                perms.set_readonly(false);
                let _ = std::fs::set_permissions(&engine_ini_path, perms);
            }
        }

        std::fs::write(&engine_ini_path, &final_content)
            .map_err(|e| format!("Nova could not write Fortnite's Engine.ini ({e}). Close Fortnite and the Epic Games Launcher, then try again."))?;

        // VERIFY. A write that "succeeded" is not the same as a file the game will read: antivirus
        // and controlled-folder-access can silently discard it, and a sync client can restore the
        // previous copy a moment later. Read it back and confirm our port is actually on disk.
        //
        // This matters more than any other check here, because the failure is invisible and fatal.
        // Without the patch the client falls back to the SHIPPED xmpp-service-prod address, Cobalt
        // rewrites the host to 127.0.0.1, and the port defaults to the ws:// default of 80 — where
        // nothing listens. The game logs `New XMPP connection configured to Server=[ws://127.0.0.1:80]`,
        // the socket dies, and ~400ms later it reports `AppES: closing code 0` and force-logs-out
        // with "Fortnite was not started correctly". That dialog blames the launcher; the real cause
        // is this file. Fail here, loudly, instead of launching into a guaranteed logout.
        match std::fs::read_to_string(&engine_ini_path) {
            Ok(readback) if readback.contains("ServerAddr=\"ws://127.0.0.1:3551\"") => {
                println!("Local Engine.ini patched and verified (XMPP -> 127.0.0.1:3551).");
                Ok(())
            }
            Ok(_) => Err(
                "Nova wrote Fortnite's Engine.ini but the change did not stick. Antivirus or \
                 Controlled Folder Access is most likely reverting it. Allow Nova to write to \
                 %LOCALAPPDATA%\\FortniteGame\\Saved\\Config\\WindowsClient, then try again."
                    .to_string(),
            ),
            Err(e) => Err(format!(
                "Nova patched Fortnite's Engine.ini but could not read it back to confirm ({e})."
            )),
        }
    }
}


pub fn kill() {
    let mut system = System::new_all();
    system.refresh_all();

    let processes = vec![
        "EpicGamesLauncher.exe",
        "FortniteLauncher.exe",
        "FortniteClient-Win64-Shipping_EAC.exe",
        "FortniteClient-Win64-Shipping_BE.exe",
        "FortniteClient-Win64-Shipping.exe",
        "EasyAntiCheat_EOS.exe",
        "EpicWebHelper.exe",
    ];

    for process in processes.iter() {
        let cmd = std::process::Command::new("cmd")
            .creation_flags(CREATE_NO_WINDOW)
            .args(&["/C", "taskkill", "/F", "/IM", process])
            .spawn();

        // Don't abort the whole loop if one taskkill fails â€” keep killing the remaining processes.
        let _ = cmd;
    }

    std::thread::sleep(std::time::Duration::from_millis(10));
}

/// Is this EpicGamesLauncher.exe the EOS bootstrapper the GAME depends on?
///
/// `p.cmd()` is a slice of OsString, so it is flattened to a lossy String before matching, and the
/// comparison is case-insensitive — the flag's casing is Epic's to change, not ours.
fn is_eos_bootstrapper(p: &sysinfo::Process) -> bool {
    let cmdline = p
        .cmd()
        .iter()
        .map(|s| s.to_string_lossy().to_lowercase())
        .collect::<Vec<_>>()
        .join(" ");
    cmdline.contains("-eosbootstrappedflag") || cmdline.contains("-epicportal")
}

pub fn kill_epic() {
    // Spares the EOS bootstrapper, for the same reason suppress_epic_launcher does: killing that
    // particular EpicGamesLauncher.exe drops the game's app-services connection and it logs itself
    // out with "Fortnite was not started correctly". This runs early enough that the bootstrapper
    // usually does not exist yet — but "usually" is exactly the kind of assumption that produced a
    // bug reproducing on one machine and not another, so it is checked rather than assumed.
    let mut system = System::new_all();
    system.refresh_all();

    for p in system.processes().values() {
        if !p.name().eq_ignore_ascii_case("EpicGamesLauncher.exe") {
            continue;
        }
        if is_eos_bootstrapper(p) {
            continue;
        }
        // Each switch as its own argv element. The previous form passed "taskkill /F /IM" as ONE
        // argument; cmd happens to strip the quotes and run it anyway, but that is an accident of
        // cmd's quote handling rather than something to rely on.
        let _ = std::process::Command::new("cmd")
            .creation_flags(CREATE_NO_WINDOW)
            .args(&["/C", "taskkill", "/F", "/PID", &p.pid().to_string()])
            .spawn();
    }

    std::thread::sleep(std::time::Duration::from_millis(10));
}

/// Close an Epic Games Launcher window the player did not ask for — and ONLY that one.
///
/// ── WHY THIS IS NARROW NOW ──────────────────────────────────────────────────────────────────────
/// This used to kill every EpicGamesLauncher.exe it saw for two minutes after launch, and that was
/// the cause of "Fortnite was not started correctly and needs to be closed."
///
/// The game's own log gives the mechanism exactly:
///
///     LogInit: Error: AppES: closing code 0
///     LogOnlineAccount: ForceLogout requested. Local=false
///       LogoutReason=[Fortnite was not started correctly and needs to be closed. ...]
///
/// `Local=false` means the client did not decide that itself — the logout followed its connection
/// to Epic's app-services bootstrapper dropping. That bootstrapper IS an EpicGamesLauncher.exe
/// process, started as part of the normal launch chain with `-EOSBootstrappedFlag`. Killing it
/// severs a connection the game depends on, and the game responds by logging out with a message
/// blaming the way it was started. The old comment here even noted the process was part of the
/// launch chain, and killed it anyway.
///
/// It looked intermittent because it is a race: whether the bootstrapper appears (and is killed)
/// inside the window varies by machine speed and by whether EGL is installed at all. One PC would
/// play fine while another failed every time on the same build.
///
/// So the watchdog now leaves the bootstrapped instance completely alone and closes only an EGL
/// that was started some other way — the storefront window popping up over the game, which is what
/// this was ever meant to stop.
pub fn suppress_epic_launcher(seconds: u64) {
    std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(seconds);
        let mut system = System::new_all();

        while std::time::Instant::now() < deadline {
            system.refresh_all();

            for p in system.processes().values() {
                if !p.name().eq_ignore_ascii_case("EpicGamesLauncher.exe") {
                    continue;
                }
                // The bootstrapper the GAME needs. Identified by its own command line rather than
                // by timing, so this is a fact about the process instead of a guess.
                if is_eos_bootstrapper(p) {
                    continue;
                }
                println!("[Epic] Closing a stray Epic Games Launcher window (pid {}).", p.pid());
                let _ = std::process::Command::new("cmd")
                    .creation_flags(CREATE_NO_WINDOW)
                    .args(&["/C", "taskkill", "/F", "/PID", &p.pid().to_string()])
                    .spawn();
            }

            std::thread::sleep(std::time::Duration::from_millis(1500));
        }
    });
}

// (removed: unused multi-threaded file downloader - generate_ranges/DownloadProgress/
//  OVERWRITE_LIST/download. Nova never downloads builds; it launches an existing install.)

pub fn suspend_process(pid: u32) -> (u32, bool) {
    unsafe {
        let mut has_err = false;
        let mut count: u32 = 0;

        let te: &mut THREADENTRY32 = &mut std::mem::zeroed();
        (*te).dwSize = std::mem::size_of::<THREADENTRY32>() as u32;

        let snapshot: HANDLE = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);

        if Thread32First(snapshot, te) == 1 {
            loop {
                if pid == (*te).th32OwnerProcessID {
                    let tid = (*te).th32ThreadID;

                    let thread: HANDLE = OpenThread(THREAD_SUSPEND_RESUME, FALSE, tid);
                    has_err |= SuspendThread(thread) as i32 == -1i32;

                    CloseHandle(thread);
                    count += 1;
                }

                if Thread32Next(snapshot, te) == 0 {
                    break;
                }
            }
        }

        CloseHandle(snapshot);

        (count, has_err)
    }
}

pub fn is_process_suspended(pid: u32) -> bool {
    unsafe {
        let mut is_suspended = true;

        let te: &mut THREADENTRY32 = &mut std::mem::zeroed();
        (*te).dwSize = std::mem::size_of::<THREADENTRY32>() as u32;

        let snapshot: HANDLE = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);

        if Thread32First(snapshot, te) == 1 {
            loop {
                if pid == (*te).th32OwnerProcessID {
                    let tid = (*te).th32ThreadID;

                    let thread: HANDLE = OpenThread(THREAD_SUSPEND_RESUME, FALSE, tid);
                    let suspend_count = SuspendThread(thread) as i32;

                    if suspend_count == -1i32 {
                        is_suspended = false;
                    } else {
                        is_suspended &= suspend_count > 0;
                    }

                    CloseHandle(thread);
                }

                if Thread32Next(snapshot, te) == 0 {
                    break;
                }
            }
        }

        CloseHandle(snapshot);

        is_suspended
    }
}

pub async fn launch_real_launcher(root: &str) -> Result<bool, String> {
    println!("Launching real launcher at path: {}", root);

    let base = std::path::PathBuf::from(root);
    let mut resource_path = base.clone();
    resource_path.push("FortniteGame\\Binaries\\Win64\\FortniteLauncher.exe");

    println!("Launcher path: {:?}", resource_path);

    let mut cwd = std::path::PathBuf::from(root);
    cwd.push("FortniteGame\\Binaries\\Win64");

    println!("Current directory for launcher: {:?}", cwd);

    kill_epic();
    println!("Killed Epic process.");

    let cmd = std::process::Command::new(resource_path.clone())
        .creation_flags(CREATE_NO_WINDOW | 0x00000004)
        .current_dir(cwd)
        .spawn();

    if cmd.is_err() {
        println!("Failed to launch '{}'", resource_path.to_str().unwrap());
        return Err(format!(
            "Failed to launch '{}'",
            resource_path.to_str().unwrap()
        ));
    }

    let pid = cmd.unwrap().id();
    println!("Launched process with PID: {}", pid);

    // Bounded, not `while !suspended {}`: if a thread handle can't be opened (permissions, or the
    // process died), is_process_suspended never returns true and the old loop spun forever with the
    // launcher frozen mid-Play. FortniteLauncher only has to EXIST for the game's check, so give up
    // after ~3s and carry on instead of hanging the launch.
    let mut tries = 0;
    while !is_process_suspended(pid) && tries < 30 {
        let (_, _) = suspend_process(pid);
        tries += 1;
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    if tries >= 30 {
        crate::dbg_log(&format!(
            "launch: could not confirm FortniteLauncher (pid {}) suspended after 3s — continuing anyway",
            pid
        ));
    }
    kill_epic();
    Ok(true)
}

#[tauri::command]
async fn dll_replace(path: &str, app: AppHandle) -> Result<bool, String> {
    println!("Experience function called for path: {}", path);

    // Kept only to assert the main window exists before we start swapping DLLs; nothing is emitted
    // to it (the progress events it used to carry belonged to the removed downloader).
    let _window = app.get_window("main").unwrap();

    println!("Killed any existing processes.");

    let path = PathBuf::from(path);
    println!("Converted path to PathBuf: {:?}", path);

    let mut nvidia_path = path.clone();
    nvidia_path.push(
        "Engine\\Binaries\\ThirdParty\\NVIDIA\\NVaftermath\\Win64\\GFSDK_Aftermath_Lib.x64.dll",
    );
    println!("NVIDIA DLL path: {:?}", nvidia_path);

    let mut attempts = 0;
    while nvidia_path.exists() {
        if std::fs::remove_file(&nvidia_path).is_ok() {
            println!("Removed existing NVIDIA DLL: {:?}", nvidia_path);
            break;
        }
        attempts += 1;
        if attempts >= 50 {
            // ~5s of retries. Bail instead of hanging forever (e.g. the file is locked because
            // the game is still running).
            return Err("Could not replace GFSDK_Aftermath DLL â€” is the game still open? Close it and press Play again.".to_string());
        }
        println!("Failed to remove NVIDIA DLL, retrying... ({}/50)", attempts);
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    // Resolve Cobalt.dll: prefer the copy shipped NEXT TO the launcher exe (portable bundle), then
    // fall back to the dev layout (the exe lives at src-tauri/target/release/, so three parents up is
    // src-tauri). The old code ONLY did the 3-parents-up dev path, so a distributed bundle — where the
    // exe sits at the package root — walked outside the folder and reported "Cobalt.dll not found".
    let current_exe = std::env::current_exe().unwrap();
    let exe_dir = current_exe.parent().unwrap();

    // Resolution order:
    //   1. next to the launcher exe            — how a distributed bundle is laid out
    //   2. cobalt/x64/Release/Cobalt.dll        — what `cobalt/build.ps1` produces in the dev tree
    //   3. the older loose dev-tree locations   — kept so an existing checkout still works
    // Cobalt's source now lives in Launcher/cobalt/, so the build output is the canonical dev copy.
    // An INSTALLED build keeps its bundled files under `resources/`, which none of the paths below
    // knew about — so a fresh install found no Cobalt.dll and refused to launch the game, even though
    // the installer had shipped it correctly. beside_exe checks both layouts; ask it first.
    let mut cobalt_path = match crate::host::beside_exe("Cobalt.dll") {
        Some(found) => std::path::PathBuf::from(found),
        None => exe_dir.join("Cobalt.dll"),
    };
    if !cobalt_path.exists() {
        if let Some(launcher_dir) = current_exe
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
        {
            let built = launcher_dir.join("cobalt").join("x64").join("Release").join("Cobalt.dll");
            if built.exists() {
                cobalt_path = built;
            }
        }
    }
    if !cobalt_path.exists() {
        if let Some(tauri_dir) = current_exe
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
        {
            let dev = tauri_dir.join("Cobalt.dll");
            cobalt_path = if dev.exists() { dev } else { tauri_dir.join("src-tauri").join("Cobalt.dll") };
        }
    }

    println!("Looking for Cobalt.dll at: {:?}", cobalt_path);

    if !cobalt_path.exists() {
        println!("Cobalt.dll not found in launcher directory");
        return Err("Cobalt.dll not found".to_string());
    }

    // ── Check the DLL is intact BEFORE writing it into the game ─────────────────────────────────
    //
    // This used to be `exists()` and copy. A truncated or zero-byte Cobalt.dll passes `exists()`
    // perfectly well, gets written over the engine's Aftermath library, and Fortnite then dies the
    // instant it loads it — no window, no crash log, not even a Saved folder, because UE never gets
    // far enough to make one. From the outside that is indistinguishable from "the game is broken",
    // and the only thing that actually fixes it is a reinstall, which is a miserable answer.
    //
    // An interrupted update is enough to produce exactly that file, and we have already seen an
    // install halt part-way through on this project.
    if let Err(reason) = validate_dll(&cobalt_path) {
        println!("Cobalt.dll failed its integrity check: {}", reason);
        return Err(format!(
            "Nova's game files are damaged ({reason}). Reinstall Nova — the update was probably interrupted."
        ));
    }

    if let Err(e) = std::fs::copy(&cobalt_path, &nvidia_path) {
        println!("Failed to copy Cobalt.dll: {}", e);
        return Err("Failed to copy Cobalt.dll".to_string());
    }

    // And confirm what landed, rather than trusting the copy. A disk that filled up mid-write, or
    // an antivirus that quarantined the file the moment it appeared, both return Ok(()) here.
    match std::fs::metadata(&nvidia_path) {
        Ok(m) if m.len() == std::fs::metadata(&cobalt_path).map(|s| s.len()).unwrap_or(0) => {
            println!("Successfully copied Cobalt.dll to GFSDK_Aftermath_Lib.x64.dll ({} bytes)", m.len());
        }
        Ok(m) => {
            return Err(format!(
                "Nova could not install its game files correctly (wrote {} bytes). Check that your antivirus isn't removing them.",
                m.len()
            ));
        }
        Err(e) => {
            return Err(format!(
                "Nova could not install its game files ({e}). Check that your antivirus isn't removing them."
            ));
        }
    }

    Ok(true)
}

/// Is this actually a 64-bit Windows DLL, and not a truncated download or an empty placeholder?
///
/// Deliberately cheap: read the first bytes and the length. The point is to catch the file being
/// obviously wrong — not to verify it is the RIGHT build, which a hash would do and which would
/// then need updating on every rebuild.
pub fn validate_dll(path: &std::path::Path) -> Result<(), String> {
    use std::io::Read;

    let len = std::fs::metadata(path).map_err(|e| format!("unreadable: {e}"))?.len();
    // Any real DLL here is tens of kilobytes. 4 KB is comfortably below the smallest plausible
    // build and comfortably above "empty" or "a few stray bytes".
    if len < 4096 {
        return Err(format!("{} is only {} bytes", file_leaf(path), len));
    }

    let mut head = [0u8; 2];
    std::fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut head))
        .map_err(|e| format!("unreadable: {e}"))?;
    // Every PE image starts "MZ". A partial download, an HTML error page saved as a .dll, or a
    // quarantined stub will not.
    if &head != b"MZ" {
        return Err(format!("{} is not a valid Windows library", file_leaf(path)));
    }
    Ok(())
}

fn file_leaf(p: &std::path::Path) -> String {
    p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| p.display().to_string())
}

/// Extra args for the instance that will become the SERVER. `-nullrhi` is the important one: it
/// swaps the render hardware interface for a null one, so the process simulates the match but does
/// no rendering at all â€” no game window, no GPU work, far less RAM. That turns the server into a
/// background process whose only visible surface is Reboot's own log console. The rest just trims
/// audio/splash/texture-streaming work the server has no use for.
const HEADLESS_SERVER_ARGS: &[&str] = &[
    "-nullrhi",
    "-nosound",
    // "-noaudio" was here: it is NOT a UE4 argument (the engine binary has no such switch), so it
    // was silently ignored. "-nosound" is the real one and is what Phoenix/ATLAS-Link use.
    // Sets SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX in WinMain, so a
    // crashing headless server dies quietly instead of blocking on a modal dialog nobody can see.
    "-unattended",
    "-notexturestreaming",
    // Make the server's log reach our pipe, so watch_server_output can actually see readiness and
    // login failures. Notes, all verified against UE 4.22 source:
    //   * `-stdout` is what creates FOutputDeviceStdOutput. Do NOT use `-log` for this — `-log`
    //     calls GLogConsole->Show(true) -> AllocConsole(), and that block sits OUTSIDE the
    //     `!UE_BUILD_SHIPPING` guard, so it pops a real console window. CREATE_NO_WINDOW does not
    //     suppress it either: that flag is ignored for a GUI-subsystem exe, which this is.
    //   * Bare `-stdout` only emits at Display verbosity; `-AllowStdOutLogVerbosity` raises it to
    //     Log, which is where the ordinary engine/game messages live. (`-FullStdOutLogOutput`
    //     raises it to All — far more volume than we need.)
    //   * IsStdoutAttachedToConsole() is false when the handle is a pipe, so UE falls through to
    //     plain printf/fflush — exactly what Stdio::piped() wants, and no window appears.
    // Reboot still hijacks stdout with AllocConsole()+freopen("CONOUT$") once it is injected, but
    // readiness and the login result both happen BEFORE injection, so we still catch them.
    "-stdout",
    "-AllowStdOutLogVerbosity",
    // Run the server single-threaded. A crash.dmp from a host showed an access violation reading
    // 0x0 (null deref) on a PhysX worker thread during load-in — the classic UE4 async-physics
    // race, with no Reboot frames on the faulting thread. -onethread removes the worker thread so
    // physics runs on the game thread, eliminating that race. Negligible cost for a private match.
    "-onethread",
];

/// The ONE place Fortnite's command line is built.
///
/// This used to be copy-pasted into `launch_fn`, `launch_server_only` and `launch_client_only`.
/// Three copies of a 19-element list is a standing invitation to drift — and they had already
/// drifted in ways that mattered (see `spawn_fortnite`).
///
/// `account_id` / `token` come from the launcher's live Nova session (login.tsx stores them after
/// `/account/api/oauth/token`). They are deliberately passed straight through: the game
/// re-authenticates with them, and the backend resolves the token back to this exact account, so
/// the in-game player IS the account the launcher is signed in as. Never substitute a placeholder
/// login here — a hardcoded credential makes every player share one account.
fn build_fortnite_args(account_id: &str, token: &str, eor: bool, headless: bool) -> Vec<String> {
    let mut args: Vec<String> = vec![
        // ── Identity ────────────────────────────────────────────────────────────────────────
        "-AUTH_TYPE=epic".into(),
        format!("-AUTH_LOGIN={}", account_id),
        format!("-AUTH_PASSWORD={}", token),
        "-epicapp=Fortnite".into(),
        "-epicenv=Prod".into(),
        "-epiclocale=en-us".into(),
        "-epicportal".into(),
        // ── Anti-cheat / patch checks ───────────────────────────────────────────────────────
        // BattlEye shipped with Fortnite from 1.7.1 (Oct 2017), so -nobe IS meaningful on 7.40.
        "-nobe".into(),
        // "-fromfl" = "from FortniteLauncher": which anti-cheat bootstrapper the client believes it
        // was started under. The retail pairs are mutually exclusive — `-fromfl=eac -nobe` or
        // `-fromfl=be -noeac`.
        //
        // RETAIL 7.40 ACTUALLY SHIPPED ON THE BATTLEYE PATH: the per-version token table records
        // 7.30 and 7.40 as `-noeac -fromfl=be`, and only 8.51 onward as `-nobe -fromfl=eac`.
        // So the retail-correct set here would be `-noeac -fromfl=be -fltoken=db04e37196g0h6h8e003c19d`.
        //
        // We keep `-fromfl=eac` anyway, deliberately: the anti-cheat is bypassed entirely (Cobalt
        // replaces the AC module and launch_fn starts the bootstrapper CREATE_SUSPENDED so it never
        // runs), which makes this value inert — and Reboot-Launcher ships `-fromfl=eac` for every
        // build from 1.0 to 21.50 on that basis. This combination is also what has actually played
        // full matches on this setup. Switching to the retail pair is a one-line experiment worth
        // trying if the AC handshake ever starts failing, but it is not a fix for a working system.
        "-fromfl=eac".into(),
        // Value is inert on a private server — it is validated by the AC bootstrapper, which never
        // runs here. (Retail 7.40's real token was db04e37196g0h6h8e003c19d.)
        "-fltoken=nova-anticheat-bypass".into(),
        // Frequently missed, and genuinely needed: skips the build/patch version check.
        "-skippatchcheck".into(),
        // -noeac is CORRECT for 7.40 (see above — this build is BattlEye-era, so EAC is the one to
        // disable). An earlier read of this called it incoherent with -fromfl=eac; that was right
        // about retail pairing but wrong about which AC 7.40 used.
        "-noeac".into(),
        "-nosplash".into(),
        // REMOVED — `-caldera=eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9`: that string is only a base64
        // JWT *header*, not a JWT, and Caldera is the modern EAC-EOS handshake that does not exist
        // before ~19.00. Unrecognised args are ignored, so this was a no-op either way.
        //
        // REMOVED — four `-ini:Engine:[...]` overrides. UE4 gates command-line INI overrides on
        // ALLOW_INI_OVERRIDE_FROM_COMMANDLINE = (UE_SERVER || !UE_BUILD_SHIPPING), so in a Shipping
        // *client* — which is what FortniteClient-Win64-Shipping.exe is, for both the game and the
        // headless server — FConfigFile::OverrideFromCommandline is compiled out entirely. They
        // never did anything. `Saved/Config` also outranks command-line overrides even where they
        // are enabled, so patch_local_engine_ini() (which writes exactly these keys to
        // %LOCALAPPDATA%\FortniteGame\Saved\Config\WindowsClient\Engine.ini) is the mechanism that
        // actually works — which is why it now runs on all three launch paths, not just one.
    ];

    // Conditional push, NOT `if eor { "-eor" } else { "" }`. The old form always appended an
    // argument — an EMPTY one when eor was false — which Rust passes to CreateProcess as a literal
    // `""` token in the command line for UE's parser to trip over.
    if eor {
        args.push("-eor".into());
    }

    if headless {
        args.extend(HEADLESS_SERVER_ARGS.iter().map(|s| s.to_string()));
    }

    args
}

/// The exact command needed to run a HEADLESS gameserver, without running it.
///
/// The backend now owns the server's lifecycle — it starts one when the in-game Play press creates
/// real demand and the election picks this machine, and stops it when the host leaves. It needs the
/// command line to do that, and Fortnite's argument list is fiddly enough (and has broken enough
/// times) that duplicating it in TypeScript would guarantee the two drift apart. So this hands the
/// backend the argv built by build_fortnite_args — Rust stays the single source of truth.
#[derive(serde::Serialize)]
pub struct ServerLaunchSpec {
    pub exe: String,
    pub cwd: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

#[tauri::command]
pub fn server_launch_spec(
    path: &str,
    account_id: String,
    token: String,
    eor: bool,
) -> Result<ServerLaunchSpec, String> {
    let base = std::path::PathBuf::from(path);
    let mut exe = base.clone();
    exe.push("FortniteGame\\Binaries\\Win64\\FortniteClient-Win64-Shipping.exe");
    if !exe.exists() {
        return Err("Could not find FortniteClient-Win64-Shipping.exe".to_string());
    }
    let cwd = exe
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "Could not resolve the Win64 directory".to_string())?;

    Ok(ServerLaunchSpec {
        exe: exe.to_string_lossy().to_string(),
        cwd: cwd.to_string_lossy().to_string(),
        // headless = true: -nullrhi and friends, i.e. a server, not a second visible game.
        args: build_fortnite_args(&account_id, &token, eor, true),
        // Same OpenSSL constraint spawn_fortnite applies; see the note there.
        env: vec![("OPENSSL_ia32cap".to_string(), "~0x20000000".to_string())],
    })
}

/// Spawn Fortnite with the working directory set to its own Win64 folder.
///
/// The cwd matters and was previously only set in `launch_fn`: the game resolves relative paths
/// (and the injected Reboot DLL wrote its crash log) against the process working directory, which
/// otherwise defaults to wherever the LAUNCHER happens to live — the dev tree on this machine, an
/// unzipped bundle elsewhere. The known-good manual launch is a .bat that `cd`s into the build
/// first, so all three launch paths now match it instead of only one.
fn spawn_fortnite(
    fort_binary: &std::path::Path,
    args: Vec<String>,
    piped: bool,
) -> std::io::Result<std::process::Child> {
    let win64_dir = fort_binary
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("."));

    let mut cmd = std::process::Command::new(fort_binary);
    cmd.creation_flags(CREATE_NO_WINDOW)
        .current_dir(&win64_dir)
        // Constrain OpenSSL's CPU-feature detection. The 2019 OpenSSL statically linked into this
        // build predates modern instruction sets, and its runtime dispatch can select a code path
        // that misbehaves on a current CPU — which shows up as TLS handshake failures or a hard
        // crash rather than anything obviously SSL-shaped. ATLAS-Link sets this on both its client
        // and host launches; Nova was missing it entirely.
        .env("OPENSSL_ia32cap", "~0x20000000")
        .args(&args);

    if piped {
        cmd.stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
    }

    crate::dbg_log(&format!(
        "launch: exe={:?} cwd={:?} args={}",
        fort_binary,
        win64_dir,
        args.join(" ")
    ));

    cmd.spawn()
}

#[tauri::command]
pub async fn launch_fn(
    path: &str,
    app: AppHandle,
    account_id: String,
    token: String,
    eor: bool,
    headless: bool,
) -> Result<bool, String> {
    patch_local_engine_ini()?;
    // Also patch the build's own DefaultEngine.ini. Non-fatal: the Saved patch above is the
    // verified one, and this is the belt-and-braces copy that survives a Saved write not sticking.
    if let Err(e) = patch_build_engine_ini(std::path::Path::new(path)) {
        eprintln!("[Engine.ini] build config not patched (harmless if Saved patch landed): {}", e);
    }
    // Only for the window the PLAYER sees. The headless server has no display to get wrong, and it is
    // the thing that breaks these settings in the first place.
    if !headless {
        repair_client_display_settings();
    }
    match dll_replace(path, app).await {
        Ok(_) => {}
        Err(e) => {
            return Err(
                "Could not launch the game for reason: ".to_string() + e.to_string().as_str()
            );
        }
    }

    let base = std::path::PathBuf::from(path);
    let mut fort_ac_path = base.clone();
    fort_ac_path.push("FortniteGame\\Binaries\\Win64\\FortniteClient-Win64-Shipping_EAC.exe");
    if !fort_ac_path.exists() {
        return Err("FortniteClient-Win64-Shipping_EAC.exe not found".to_string());
    }

    let mut fort_ac_cwd = base.clone();
    fort_ac_cwd.push("FortniteGame\\Binaries\\Win64");
    let fortnite_ac_process = std::process::Command::new(fort_ac_path)
        .creation_flags(CREATE_NO_WINDOW | 0x00000004)
        .current_dir(fort_ac_cwd)
        .spawn();

    if fortnite_ac_process.is_err() {
        return Err("Failed to launch FortniteClient-Win64-Shipping_EAC.exe".to_string());
    }
    let res = launch_real_launcher(base.clone().to_str().unwrap()).await;
    if res.is_err() {
        println!("launch easy anti cheat");
        return Err("Failed to launch Fortnite Launcher".to_string());
    }

    let mut fort_binary = base.clone();
    fort_binary.push("FortniteGame\\Binaries\\Win64\\FortniteClient-Win64-Shipping.exe");
    if !fort_binary.exists() {
        return Err("Could not find FortniteClient-Win64-Shipping.exe".to_string());
    }

    let fort_args = build_fortnite_args(&account_id, &token, eor, headless);

    if headless {
        println!("Launching Fortnite HEADLESS (server instance).");
    }

    // The EOS bootstrapper reopens the Epic Games Launcher shortly after the game starts. Close it
    // for the first couple of minutes of the launch, then stop interfering.
    suppress_epic_launcher(120);

    let fort_cmd = spawn_fortnite(&fort_binary, fort_args, false);

    let child = match fort_cmd {
        Ok(c) => c,
        Err(e) => {
            crate::dbg_log(&format!("launch: spawn FAILED: {}", e));
            return Err(format!("Failed to launch Fortnite: {}", e));
        }
    };

    // Remember WHICH process this is. There can be two Fortnite processes (server + the host's own
    // client) and they share an executable name, so "first by name" would be a coin flip when
    // injecting, and would make "has the player left?" unanswerable. Headless == the server.
    if headless {
        set_server_pid(Some(child.id()));
    } else {
        set_client_pid(Some(child.id()));
    }

    println!(
        "Fortnite launched successfully (pid {}, {}).",
        child.id(),
        if headless { "server" } else { "client" }
    );

    // "Spawned" is not "running": Fortnite exits within seconds if it doesn't like its arguments or
    // environment, which is exactly the silent failure we chased on the second machine. Watch the
    // process for a bit and record whether it SURVIVED, plus its exit code if not.
    if !headless {
        let pid = child.id();
        std::thread::spawn(move || {
            let mut child = child;
            for sec in 1..=25 {
                std::thread::sleep(std::time::Duration::from_secs(1));
                match child.try_wait() {
                    Ok(Some(status)) => {
                        crate::dbg_log(&format!(
                            "launch: GAME EXITED after ~{}s (pid {}, {}) — it started then quit; \
                             this is the real failure, not the launcher",
                            sec, pid, status
                        ));
                        return;
                    }
                    Ok(None) => {}
                    Err(e) => {
                        crate::dbg_log(&format!("launch: could not poll game process: {}", e));
                        return;
                    }
                }
            }
            crate::dbg_log(&format!("launch: game still running after 25s (pid {}) — OK", pid));
        });
    }

    Ok(true)
}

/// Launch an ADDITIONAL instance to act as the gameserver, without disturbing the client that is
/// already running. Unlike `launch_fn` this does NOT kill existing processes and does NOT re-run the
/// EAC/launcher setup â€” the Cobalt hijack is already in place from the first launch. Always headless.
#[tauri::command]
pub async fn launch_server_only(
    path: &str,
    account_id: String,
    token: String,
    eor: bool,
) -> Result<bool, String> {
    let base = std::path::PathBuf::from(path);
    let mut fort_binary = base.clone();
    fort_binary.push("FortniteGame\\Binaries\\Win64\\FortniteClient-Win64-Shipping.exe");
    if !fort_binary.exists() {
        return Err("Could not find FortniteClient-Win64-Shipping.exe".to_string());
    }

    // The XMPP / party-system INI has to be in place for THIS instance too. It was previously only
    // written by launch_fn, so a host whose flow reached the server launch first ran against
    // whatever Engine.ini happened to be on disk.
    patch_local_engine_ini()?;
    // Also patch the build's own DefaultEngine.ini. Non-fatal: the Saved patch above is the
    // verified one, and this is the belt-and-braces copy that survives a Saved write not sticking.
    if let Err(e) = patch_build_engine_ini(std::path::Path::new(path)) {
        eprintln!("[Engine.ini] build config not patched (harmless if Saved patch landed): {}", e);
    }

    let fort_args = build_fortnite_args(&account_id, &token, eor, true);

    reset_server_readiness();

    let fort_cmd = spawn_fortnite(&fort_binary, fort_args, true);

    let mut child = match fort_cmd {
        Ok(c) => c,
        Err(_) => return Err("Failed to launch the server instance".to_string()),
    };
    set_server_pid(Some(child.id()));

    // Both streams are watched: the engine's own logging and Reboot's console output don't
    // consistently land on the same one. They must also be drained regardless, or a full pipe
    // buffer would block the server process.
    if let Some(out) = child.stdout.take() { watch_server_output(out); }
    if let Some(err) = child.stderr.take() { watch_server_output(err); }

    println!("Headless server instance launched (pid {}).", child.id());
    Ok(true)
}

/// Host-also-plays: launch an ADDITIONAL Fortnite CLIENT instance that will join the host's own
/// server. It does NOT kill the running server instance and does NOT inject Reboot â€” Cobalt is
/// already in the hijack slot from the server launch, so this client also redirects to the
/// backend, then matchmakes (in-game Play) and gets routed to the live server (127.0.0.1:7777 via
/// the registered address). Uses -noeac so it doesn't need its own EAC/launcher processes.
#[tauri::command]
pub async fn launch_client_only(
    path: &str,
    account_id: String,
    token: String,
    eor: bool,
) -> Result<bool, String> {
    let base = std::path::PathBuf::from(path);
    let mut fort_binary = base.clone();
    fort_binary.push("FortniteGame\\Binaries\\Win64\\FortniteClient-Win64-Shipping.exe");
    if !fort_binary.exists() {
        return Err("Could not find FortniteClient-Win64-Shipping.exe".to_string());
    }

    // Same reason as launch_server_only: this path can be the first one to start a game process.
    patch_local_engine_ini()?;
    // Also patch the build's own DefaultEngine.ini. Non-fatal: the Saved patch above is the
    // verified one, and this is the belt-and-braces copy that survives a Saved write not sticking.
    if let Err(e) = patch_build_engine_ini(std::path::Path::new(path)) {
        eprintln!("[Engine.ini] build config not patched (harmless if Saved patch landed): {}", e);
    }
    repair_client_display_settings();

    let fort_args = build_fortnite_args(&account_id, &token, eor, false);

    let fort_cmd = spawn_fortnite(&fort_binary, fort_args, false);

    let child = match fort_cmd {
        Ok(c) => c,
        Err(_) => return Err("Failed to launch the client instance".to_string()),
    };
    set_client_pid(Some(child.id()));

    println!("Host's playable client launched (pid {}).", child.id());
    Ok(true)
}

// â”€â”€ Instance tracking â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Which Fortnite process is the server, and which is the host's own player. Tracked by PID because
// both have the same executable name.

pub static SERVER_PID: std::sync::Mutex<Option<u32>> = std::sync::Mutex::new(None);
pub static CLIENT_PID: std::sync::Mutex<Option<u32>> = std::sync::Mutex::new(None);

// ── Server readiness, read from the server's own log output ──────────────────────────────────
// We used to sleep a flat 28s before injecting Reboot, which is a guess in both directions: too
// early on a slow machine (injecting before the game is ready crashes it) and needlessly slow on a
// fast one. Instead, watch the server's stdout for the point the game reaches party creation —
// the same marker Phoenix injects on — and go as soon as it appears.
//
// Fortnite may not give us usable stdout in every configuration, so SAW_OUTPUT records whether the
// pipe produced anything at all. If it stayed silent the caller falls back to the old fixed wait,
// which makes this strictly no worse than before.
pub static SERVER_READY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
pub static SERVER_SAW_OUTPUT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
pub static SERVER_FAILURE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

fn reset_server_readiness() {
    SERVER_READY.store(false, std::sync::atomic::Ordering::SeqCst);
    SERVER_SAW_OUTPUT.store(false, std::sync::atomic::Ordering::SeqCst);
    if let Ok(mut g) = SERVER_FAILURE.lock() { *g = None; }
}

/// Consume the server's piped output on a background thread, flagging readiness and login failures.
///
/// This only works because the server is launched with `-stdout -AllowStdOutLogVerbosity` (see
/// HEADLESS_SERVER_ARGS). Without those a Shipping build emits nothing here, which is why this
/// watcher used to be dead code and every host silently fell back to the fixed 28s wait.
///
/// Still true, and why the fallback stays: once Reboot is injected it calls `AllocConsole()` +
/// `freopen_s("CONOUT$", stdout)` (dllmain.cpp:184-188, log.cpp:60-64), which REPLACES the
/// inherited pipe handle — so anything Reboot itself prints goes to its console, not to us. We
/// only ever see the game's own output up to the point of injection, which is exactly the window
/// the readiness marker and a failed sign-in fall in.
///
/// If the pipe does stay silent, `SERVER_SAW_OUTPUT` stays false and onboard.tsx reverts to the
/// fixed wait — so this is strictly an improvement, never a regression.
fn watch_server_output<R: std::io::Read + Send + 'static>(stream: R) {
    std::thread::spawn(move || {
        use std::io::BufRead;
        let reader = std::io::BufReader::new(stream);

        for line in reader.lines().map_while(Result::ok) {
            SERVER_SAW_OUTPUT.store(true, std::sync::atomic::Ordering::SeqCst);

            if line.contains("CreatingParty") {
                println!("[server] ready (reached party creation)");
                SERVER_READY.store(true, std::sync::atomic::Ordering::SeqCst);
            }

            // A failed login otherwise just hangs silently until the caller times out. The game
            // states the reason; surface it instead of making the user guess.
            if let Some(start) = line.find("reason \"") {
                if line.contains("ForceLogout") {
                    let rest = &line[start + 8..];
                    let reason = rest.find('"').map(|e| &rest[..e]).unwrap_or(rest);
                    println!("[server] login failed: {}", reason);
                    if let Ok(mut g) = SERVER_FAILURE.lock() {
                        *g = Some(format!("The server couldn't sign in: {}", reason));
                    }
                }
            }
        }
    });
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ServerReadiness {
    pub ready: bool,
    /// False means stdout gave us nothing, so the caller should fall back to a timed wait.
    pub saw_output: bool,
    pub failure: Option<String>,
}

/// Whether the headless server has reported itself ready to be injected into.
#[tauri::command]
pub fn server_readiness() -> ServerReadiness {
    ServerReadiness {
        ready: SERVER_READY.load(std::sync::atomic::Ordering::SeqCst),
        saw_output: SERVER_SAW_OUTPUT.load(std::sync::atomic::Ordering::SeqCst),
        failure: SERVER_FAILURE.lock().ok().and_then(|g| g.clone()),
    }
}

pub fn set_server_pid(pid: Option<u32>) {
    if let Ok(mut g) = SERVER_PID.lock() { *g = pid; }
}
pub fn set_client_pid(pid: Option<u32>) {
    if let Ok(mut g) = CLIENT_PID.lock() { *g = pid; }
}
pub fn get_server_pid() -> Option<u32> {
    SERVER_PID.lock().ok().and_then(|g| *g)
}
pub fn get_client_pid() -> Option<u32> {
    CLIENT_PID.lock().ok().and_then(|g| *g)
}

/// Is this PID still a live Fortnite process? Checks the name too, because Windows recycles PIDs
/// and a stale PID could otherwise match some unrelated process.
pub fn pid_is_fortnite(pid: u32) -> bool {
    use sysinfo::System;
    let mut sys = System::new_all();
    sys.refresh_all();
    sys.process(sysinfo::Pid::from_u32(pid))
        .map(|p| {
            p.name()
                .to_string_lossy()
                .eq_ignore_ascii_case("FortniteClient-Win64-Shipping.exe")
        })
        .unwrap_or(false)
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HostSessionState {
    pub server_pid: Option<u32>,
    pub server_alive: bool,
    pub client_pid: Option<u32>,
    pub client_alive: bool,
}

/// Live state of the host's two instances, so the UI can tell when the player has left.
#[tauri::command]
pub fn host_session_state() -> HostSessionState {
    let server_pid = get_server_pid();
    let client_pid = get_client_pid();
    HostSessionState {
        server_alive: server_pid.map(pid_is_fortnite).unwrap_or(false),
        client_alive: client_pid.map(pid_is_fortnite).unwrap_or(false),
        server_pid,
        client_pid,
    }
}

/// Shut the hosted server down (used when the host leaves the match). Kills ONLY the tracked server
/// process â€” never a blanket taskkill, which would also close the host's own game.
#[tauri::command]
pub fn stop_server_instance() -> Result<bool, String> {
    let pid = match get_server_pid() {
        Some(p) => p,
        None => return Ok(false),
    };
    if !pid_is_fortnite(pid) {
        set_server_pid(None);
        return Ok(false);
    }
    let _ = std::process::Command::new("cmd")
        .args(["/C", "taskkill", "/F", "/PID", &pid.to_string()])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
    set_server_pid(None);
    println!("Stopped the hosted server (pid {}).", pid);
    Ok(true)
}
