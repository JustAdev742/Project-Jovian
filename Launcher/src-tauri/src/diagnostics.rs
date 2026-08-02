//! Self-check: turn "it didn't work" into a specific, quotable reason.
//!
//! WHY THIS EXISTS. Every failure on the second machine this project is tested on cost a round trip:
//! the player says it didn't work, someone hunts for FortniteGame.log, someone else reads 2000 lines
//! of engine noise to find the one line that mattered. Worse, the most common failures leave the
//! launcher looking completely healthy — the game logs its own death and exits cleanly, so from the
//! outside nothing happened at all.
//!
//! Every check here exists because it ACTUALLY HAPPENED and cost real time to identify:
//!
//!   NOVA-301  Epic's own anti-cheat kicked the client 44s after launch. Reported as "the laptop
//!             doesn't work". Took two sessions to find, because -nobe/-noeac disable the OTHER two
//!             anti-cheats and this one is silent about it.
//!   NOVA-303  A request escaped the redirect to Epic's live servers, so UE4 discarded the whole
//!             hotfix batch and the client never learned where the server was. Looked random.
//!   NOVA-306  The gameserver never travelled because a fixed countdown expired before the game was
//!             ready. Presented as "matchmaking is broken".
//!
//! Codes are STABLE and are the point of the exercise. "NOVA-301" in a message is worth more than a
//! paragraph of description and a guess, and it survives being retyped from a phone screenshot.
//!
//! Ranges: 1xx install/files · 2xx services/ports · 3xx what happened last run · 4xx this machine.

use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    /// Checked, and fine.
    Ok,
    /// Works, but will bite under some conditions. Not why it is broken right now.
    Warn,
    /// This is why it is not working.
    Error,
    /// Could not determine — say so rather than implying a pass.
    Unknown,
}

#[derive(Serialize, Clone)]
pub struct Finding {
    pub code: String,
    pub level: Level,
    pub title: String,
    /// Plain English, for someone who is not a developer. No jargon that isn't explained.
    pub detail: String,
    /// What to actually do. Empty when there is nothing the player can do themselves.
    pub fix: String,
}

impl Finding {
    fn new(code: &str, level: Level, title: &str, detail: &str, fix: &str) -> Self {
        Self {
            code: code.into(),
            level,
            title: title.into(),
            detail: detail.into(),
            fix: fix.into(),
        }
    }
}

#[derive(Serialize)]
pub struct Report {
    pub findings: Vec<Finding>,
    pub machine: String,
    /// Pre-formatted for pasting into a message. The whole point: one copy, not a log hunt.
    pub summary: String,
}

/// Read at most `max` bytes from the END of a file.
///
/// FortniteGame.log runs to megabytes and everything that decides a run — the kick, the exit, the
/// crash — is at the end. Reading the tail keeps this instant even on a slow laptop, which matters
/// because a diagnostic that takes ten seconds is a diagnostic nobody runs.
fn tail(path: &Path, max: u64) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    if len > max {
        use std::io::Seek;
        f.seek(std::io::SeekFrom::Start(len - max)).ok()?;
    }
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

fn local_appdata() -> Option<PathBuf> {
    std::env::var("LOCALAPPDATA").ok().map(PathBuf::from)
}

/// Is anything listening? Used for the two local ports the game depends on.
fn port_open(port: u16) -> bool {
    use std::net::{Ipv4Addr, SocketAddr, TcpStream};
    use std::time::Duration;
    TcpStream::connect_timeout(
        &SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
        Duration::from_millis(400),
    )
    .is_ok()
}

// ── 1xx — install and files ───────────────────────────────────────────────────────────────────────

fn check_install(build_path: &str, out: &mut Vec<Finding>) {
    if build_path.trim().is_empty() {
        out.push(Finding::new(
            "NOVA-101", Level::Error, "No Fortnite folder selected",
            "Nova doesn't know where your copy of Fortnite 7.40 is, so it can't start the game or the server.",
            "Pick your 7.40 folder in the launcher — the one containing the FortniteGame folder.",
        ));
        return;
    }

    let base = PathBuf::from(build_path);
    let exe = base.join("FortniteGame\\Binaries\\Win64\\FortniteClient-Win64-Shipping.exe");
    if !exe.exists() {
        out.push(Finding::new(
            "NOVA-101", Level::Error, "Fortnite not found where Nova expects",
            &format!("There's no FortniteClient-Win64-Shipping.exe under {}.", base.display()),
            "Re-pick your Fortnite 7.40 folder. It should contain a FortniteGame folder.",
        ));
        return;
    }
    out.push(Finding::new(
        "NOVA-101", Level::Ok, "Fortnite build found", &format!("{}", base.display()), "",
    ));

    // Cobalt is installed by overwriting an NVIDIA library the game loads at startup. If that file is
    // missing or is still NVIDIA's original, nothing redirects the game to Nova and it will try to
    // reach the real Epic servers.
    let aftermath = base.join("Engine\\Binaries\\ThirdParty\\NVIDIA\\NVaftermath\\Win64\\GFSDK_Aftermath_Lib.x64.dll");
    match std::fs::metadata(&aftermath) {
        Ok(m) if m.len() > 20_000 && m.len() < 400_000 => out.push(Finding::new(
            "NOVA-102", Level::Ok, "Nova's redirect is installed in the game", "", "",
        )),
        Ok(_) => out.push(Finding::new(
            "NOVA-102", Level::Warn, "The game's NVIDIA library doesn't look like Nova's redirect",
            "Nova installs itself by replacing an NVIDIA file inside Fortnite. The file there now is an \
             unexpected size, which may mean the original was restored — for example by verifying the game files.",
            "Press Play once; Nova reinstalls it automatically at launch.",
        )),
        Err(_) => out.push(Finding::new(
            "NOVA-102", Level::Warn, "Nova's redirect isn't installed yet",
            "The file Nova replaces inside Fortnite isn't there. This is normal before your first launch.",
            "Press Play — Nova installs it automatically.",
        )),
    }
}

// ── 2xx — services ────────────────────────────────────────────────────────────────────────────────

fn check_services(out: &mut Vec<Finding>) {
    // 3551 is the local address every Epic request gets rewritten to. If nothing is listening there,
    // the game's requests fail outright — this was the first laptop failure of the night, and from
    // the game's side it just looks like the internet is broken.
    if port_open(3551) {
        out.push(Finding::new("NOVA-201", Level::Ok, "Nova's game connection is listening", "", ""));
    } else {
        out.push(Finding::new(
            "NOVA-201", Level::Error, "Nothing is listening on Nova's game port (3551)",
            "Everything the game asks for is redirected to this port. With nothing there, the game can't \
             sign in or reach a match — it will usually sit on the loading screen.",
            "Close the launcher fully and reopen it. If it persists, another program may be using port 3551.",
        ));
    }

    if port_open(3552) {
        out.push(Finding::new("NOVA-202", Level::Ok, "Nova's local service is running", "", ""));
    } else {
        out.push(Finding::new(
            "NOVA-202", Level::Warn, "Nova's local service isn't responding (3552)",
            "This is the part of Nova that runs on your own PC. It may still be starting.",
            "Give it a few seconds. If it stays down, restart the launcher.",
        ));
    }
}

// ── 3xx — what actually happened last run ─────────────────────────────────────────────────────────

fn check_last_run(build_path: &str, out: &mut Vec<Finding>) {
    let game_log = PathBuf::from(build_path).join("FortniteGame\\Saved\\Logs\\FortniteGame.log");
    let log = tail(&game_log, 900_000);

    let Some(log) = log else {
        out.push(Finding::new(
            "NOVA-300", Level::Unknown, "No record of a previous game launch",
            "Nova couldn't find Fortnite's own log, so it can't tell you what happened last time.",
            "Launch the game once, then run this check again.",
        ));
        return;
    };

    // THE ONE THAT KEEPS WINNING. -nobe and -noeac switch off BattlEye and EAC. Neither touches UAC,
    // which is Epic's own anti-cheat compiled into the client, and which kicks roughly 45 seconds in.
    let uac_ran = log.contains("UACClient initialized");
    let kicked = log.contains("was not started correctly");
    let appes = log.contains("AppES: closing code 0");

    if kicked || appes {
        out.push(Finding::new(
            "NOVA-301", Level::Error, "Fortnite's anti-cheat closed the game",
            "About 45 seconds after launching, Fortnite decided it wasn't started properly and signed you \
             out. You'd have seen it drop back to the login screen on its own. This is Fortnite's own \
             protection, not a fault in your PC or your connection, and it's the single most common reason \
             a machine can't play even though everything else looks fine.",
            "Nothing you can do from here yet — this one is still being worked on. Quote NOVA-301.",
        ));
    } else if uac_ran {
        out.push(Finding::new(
            "NOVA-301", Level::Warn, "Fortnite's own anti-cheat is active",
            "It started up and didn't interfere this time, but it's the usual cause of being kicked to the \
             login screen for no visible reason.",
            "",
        ));
    }

    // Epic answers with a correlation id; Nova never does. So one of these in the log is proof a
    // request slipped past the redirect and reached Epic's real servers.
    if log.contains("CorrId=FN-") {
        out.push(Finding::new(
            "NOVA-303", Level::Error, "Some requests reached Epic's real servers",
            "A few of the game's requests escaped Nova and went to Epic instead, which rejected them. When \
             that happens Fortnite throws away the settings telling it where your server is, so you get \
             stuck in matchmaking or kicked to the login screen. It's intermittent, which is why it can \
             work one launch and not the next.",
            "Try again — it often succeeds on a second attempt. Quote NOVA-303.",
        ));
    }

    // UE4's hotfix batch is all-or-nothing: one failed file discards every file in it, including the
    // one that points the client at the Nova server.
    if log.contains("OnHotfixCheckComplete 0") && log.contains("failed to download") {
        out.push(Finding::new(
            "NOVA-305", Level::Error, "Fortnite threw away Nova's settings",
            "One of Nova's setting files failed to download, and Fortnite discards all of them if any one \
             fails — including the file that tells it where your server is.",
            "Restart the game and try again. Quote NOVA-305.",
        ));
    }

    if !out.iter().any(|f| f.level == Level::Error && f.code.starts_with("NOVA-3")) {
        out.push(Finding::new(
            "NOVA-300", Level::Ok, "Last game launch looks clean", "", "",
        ));
    }
}

fn check_server_run(out: &mut Vec<Finding>) {
    let Some(mut p) = local_appdata() else { return };
    p.push("ProjectNova\\Logs\\cobalt.log");

    let Some(log) = tail(&p, 400_000) else {
        out.push(Finding::new(
            "NOVA-304", Level::Unknown, "No server log on this PC",
            "Nova keeps a record of the match server it runs. There isn't one here, so either this PC has \
             never hosted, or the log isn't being written.",
            "If this PC has hosted a match, quote NOVA-304 — the log should exist.",
        ));
        return;
    };

    if log.contains("Never got a local player controller") {
        out.push(Finding::new(
            "NOVA-306", Level::Error, "The match server started but never opened",
            "Your PC was picked to host, the server started, but the game wasn't ready in time and it gave \
             up before opening the map. Everyone waiting would have seen matchmaking hang.",
            "Usually means this PC is loading too slowly to host. Let the other machine host. Quote NOVA-306.",
        ));
    }

    if log.contains("code=3221225477") {
        out.push(Finding::new(
            "NOVA-307", Level::Error, "The match server crashed",
            "The server this PC was running stopped unexpectedly, which ends the match for everyone in it.",
            "Quote NOVA-307 — the crash details are saved automatically.",
        ));
    }
}

// ── 4xx — this machine ────────────────────────────────────────────────────────────────────────────

fn check_capability(out: &mut Vec<Finding>) -> String {
    use sysinfo::System;
    let mut s = System::new();
    s.refresh_memory();
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0);
    let ram_gb = s.total_memory() as f64 / 1024.0 / 1024.0 / 1024.0;

    // Not a hard gate — a modest machine hosts fine for two players. This is about setting the
    // expectation that the heavier machine should host when there is a choice.
    if cores > 0 && (cores < 6 || ram_gb < 12.0) {
        out.push(Finding::new(
            "NOVA-401", Level::Warn, "This PC is on the light side for hosting",
            &format!(
                "{} cores and {:.1}GB of memory. Nova can host on this, but it takes longer to get a match \
                 started and is more likely to struggle. Nova now prefers the stronger PC automatically when \
                 both are online.",
                cores, ram_gb
            ),
            "Nothing to do — just expect the other PC to host when it's available.",
        ));
    } else if cores > 0 {
        out.push(Finding::new(
            "NOVA-401", Level::Ok, "This PC is comfortable hosting",
            &format!("{} cores, {:.1}GB memory.", cores, ram_gb), "",
        ));
    }

    format!("{} cores, {:.1}GB RAM", cores, ram_gb)
}

/// Run every check and build the pasteable summary.
#[tauri::command]
pub fn run_diagnostics(build_path: String) -> Report {
    let mut findings = Vec::new();
    check_install(&build_path, &mut findings);
    check_services(&mut findings);
    check_last_run(&build_path, &mut findings);
    check_server_run(&mut findings);
    let machine = check_capability(&mut findings);

    // Errors first, then warnings — someone scanning this wants the blocker, not a checklist.
    findings.sort_by_key(|f| match f.level {
        Level::Error => 0,
        Level::Warn => 1,
        Level::Unknown => 2,
        Level::Ok => 3,
    });

    let problems: Vec<&Finding> = findings
        .iter()
        .filter(|f| f.level == Level::Error || f.level == Level::Warn)
        .collect();

    let summary = if problems.is_empty() {
        format!("Nova self-check: no problems found. ({})", machine)
    } else {
        let mut s = format!("Nova self-check ({}):\n", machine);
        for f in &problems {
            let tag = if f.level == Level::Error { "PROBLEM" } else { "note" };
            s.push_str(&format!("  [{}] {} — {}\n", tag, f.code, f.title));
        }
        s
    };

    Report { findings, machine, summary }
}
