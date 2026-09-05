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

/// Every `FortniteGame*.log` UE4 has written, newest first.
///
/// WHERE THE LOG ACTUALLY IS. This used to look under the build folder
/// (`<build>\FortniteGame\Saved\Logs\`), which does not exist for an installed client: UE4 writes a
/// packaged build's logs to `%LOCALAPPDATA%\FortniteGame\Saved\Logs\`. So `tail()` returned None
/// every time, `check_last_run` short-circuited to "No record of a previous game launch", and
/// NOVA-301 / NOVA-303 / NOVA-305 — three of the most valuable codes in this file, and the ones the
/// module header says cost two sessions to identify — had never once evaluated against real data.
/// Verified 2026-09-05: the real file was 580 KB and a month old while the self-check reported no
/// log at all.
///
/// WHY MORE THAN ONE FILE. When this PC hosts, TWO Fortnite processes run — the player's client and
/// the gameserver — and UE4 gives the second one `FortniteGame_2.log`. Whichever is "newest" depends
/// on which exited last, so looking at only one file silently drops half the evidence on exactly the
/// machines that have the most interesting problems. Rotated `FortniteGame-backup-*.log` files are
/// included too; they are how a previous run survives.
///
/// The build folder is still searched as a fallback, so a portable or dev layout that really does
/// write there keeps working.
fn game_log_candidates(build_path: &str) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(mut p) = local_appdata() {
        p.push("FortniteGame\\Saved\\Logs");
        dirs.push(p);
    }
    if !build_path.trim().is_empty() {
        dirs.push(PathBuf::from(build_path).join("FortniteGame\\Saved\\Logs"));
    }
    scan_game_logs(&dirs)
}

/// The half of `game_log_candidates` that does not depend on the environment, so it can be tested.
/// Returns every `FortniteGame*.log` across `dirs`, newest first.
fn scan_game_logs(dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut found: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if !name.starts_with("fortnitegame") || !name.ends_with(".log") {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            let when = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
            found.push((when, entry.path()));
        }
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, p)| p).collect()
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

/// Resolve a host through the OS resolver, on a worker thread with a hard timeout.
///
/// std's ToSocketAddrs has no timeout and a black-holed lookup can block for many seconds, which
/// would make the whole self-check feel broken. Answering "could not resolve in 4s" is the same
/// answer for our purposes as "could not resolve".
///
/// Deliberately uses the OS resolver rather than querying a DNS server directly, because that is
/// what the launcher and the game actually use — and on Windows the two can DISAGREE. See NOVA-203.
fn resolve_with_timeout(host: &str, port: u16, secs: u64) -> Option<Vec<std::net::IpAddr>> {
    use std::net::ToSocketAddrs;
    use std::sync::mpsc;
    let (tx, rx) = mpsc::channel();
    let target = format!("{}:{}", host, port);
    std::thread::spawn(move || {
        let r = target
            .to_socket_addrs()
            .map(|it| it.map(|s| s.ip()).collect::<Vec<_>>());
        let _ = tx.send(r.ok());
    });
    rx.recv_timeout(std::time::Duration::from_secs(secs)).ok().flatten()
}

/// Is Tailscale present on this machine at all?
///
/// Used only to word the advice correctly — the check itself does not depend on it. A machine with
/// no Tailscale that cannot resolve the address has an ordinary DNS or internet problem; a machine
/// WITH Tailscale almost certainly has the NRPT problem described in NOVA-203.
fn tailscale_present() -> bool {
    // new_all()+refresh_all() to match how the rest of the launcher enumerates processes (host.rs),
    // rather than a second pattern that has to be kept in step with sysinfo's API changes.
    use sysinfo::System;
    let mut s = System::new_all();
    s.refresh_all();
    let running = s.processes().values().any(|p| {
        let n = p.name().to_string_lossy().to_ascii_lowercase();
        n.starts_with("tailscaled") || n.starts_with("tailscale-ipn") || n == "tailscale.exe"
    });
    running
        || Path::new("C:\\Program Files\\Tailscale\\tailscale.exe").exists()
        || Path::new("C:\\Program Files (x86)\\Tailscale\\tailscale.exe").exists()
}

// ── 2xx (continued) — can this PC actually reach Nova's servers? ──────────────────────────────────

/// NOVA-203 exists because the launcher used to say "Nova's servers are unreachable" when the servers
/// were perfectly healthy and the real fault was name resolution ON THIS PC.
///
/// The signature that makes this worth its own code, observed 2026-08-02:
///     nslookup clientfinder.tail0a8fd0.ts.net   -> resolves fine (43.245.48.235, .174, + IPv6)
///     Test-NetConnection ... -Port 8443         -> "Name resolution ... failed"
/// DNS answers correctly, and the WINDOWS RESOLVER still fails. nslookup talks to the DNS server
/// directly; everything else — the launcher, the game — goes through the Windows resolver, so the
/// two can disagree and only one of them matters.
///
/// The cause is Tailscale's NRPT rule. Tailscale registers a Name Resolution Policy Table entry
/// claiming *.ts.net and points it at its own resolver (100.100.100.100). The rule SURVIVES signing
/// out, and signing back in does not help if the device is not actually on the tailnet — the lookups
/// go to a resolver that has no answer, and never fall back to normal DNS. One machine on the tailnet
/// and one not, on the same network with the same launcher, is exactly the asymmetry it produces.
fn check_can_reach_nova(coordinator: &str, out: &mut Vec<Finding>) {
    // Take the host out of the configured URL rather than hardcoding it, so this keeps working if the
    // coordinator ever moves.
    let host = coordinator
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .split('/')
        .next()
        .unwrap_or("");
    let (hostname, port) = match host.rsplit_once(':') {
        Some((h, p)) => (h, p.parse::<u16>().unwrap_or(443)),
        None => (host, 443),
    };
    if hostname.is_empty() {
        return;
    }

    let Some(ips) = resolve_with_timeout(hostname, port, 4) else {
        let ts = tailscale_present();
        out.push(Finding::new(
            "NOVA-203", Level::Error, "This PC can't look up Nova's server address",
            &format!(
                "Windows could not turn \"{}\" into an address. Nova's servers may well be running \
                 perfectly — this is a name-lookup problem on THIS PC, which is why the launcher says \
                 the servers are down when other people can play.{}",
                hostname,
                if ts {
                    " Tailscale is installed here, and it takes over lookups for addresses ending in \
                     .ts.net. If this PC isn't properly connected to the Tailscale network, those \
                     lookups stop working — and signing out and back in does NOT undo it on its own."
                } else {
                    ""
                }
            ),
            if ts {
                "Open Tailscale and check this PC is actually connected (it should appear in your \
                 device list). If it does and this still fails, fully quit Tailscale from the system \
                 tray — not just sign out — and try again."
            } else {
                "Check this PC's internet connection. If other sites work, your DNS may be blocking it."
            },
        ));
        return;
    };

    // Resolution worked — so if we still cannot connect, it is the network, not the name.
    let reachable = {
        use std::net::{SocketAddr, TcpStream};
        ips.iter().any(|ip| {
            TcpStream::connect_timeout(
                &SocketAddr::new(*ip, port),
                std::time::Duration::from_millis(2500),
            )
            .is_ok()
        })
    };

    if reachable {
        out.push(Finding::new(
            "NOVA-203", Level::Ok, "Nova's servers are reachable from this PC",
            &format!("{} responded.", hostname), "",
        ));
    } else {
        out.push(Finding::new(
            "NOVA-204", Level::Error, "Nova's servers won't accept a connection from this PC",
            &format!(
                "The address for {} was found, but nothing answered on port {}. Either the servers are \
                 genuinely down, or something on this PC or network is blocking the connection.",
                hostname, port
            ),
            "If someone else can play right now, the block is on this PC — check a firewall or VPN.",
        ));
    }
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

/// Every `originatingService` in the log that is NOT one Nova stamps on its own errors.
///
/// Nova writes exactly two: `nova-backend` (index.ts setErrorHandler) and
/// `com.epicgames.account.public` (utils/error-handler.ts sendEpicError). An error envelope naming
/// anything else was written by a server that is not Nova — which, for a client whose every request
/// is supposed to be redirected to localhost, is the escape itself.
///
/// Returns one entry per occurrence, so the caller can report how many escaped as well as where to.
fn foreign_services(log: &str) -> Vec<String> {
    const NOVA_SERVICES: [&str; 2] = ["nova-backend", "com.epicgames.account.public"];
    const KEY: &str = "\"originatingService\":\"";
    log.match_indices(KEY)
        .filter_map(|(i, _)| {
            let rest = &log[i + KEY.len()..];
            rest.find('"').map(|end| rest[..end].to_string())
        })
        .filter(|svc| !NOVA_SERVICES.contains(&svc.as_str()))
        .collect()
}

fn check_last_run(build_path: &str, out: &mut Vec<Finding>) {
    // Read the two most recent logs, not just one: on a hosting PC those are the client and the
    // gameserver, and the interesting line can be in either. See game_log_candidates().
    let candidates = game_log_candidates(build_path);
    let log: String = candidates
        .iter()
        .take(2)
        .filter_map(|p| tail(p, 900_000))
        .collect::<Vec<_>>()
        .join("\n");

    if log.is_empty() {
        out.push(Finding::new(
            "NOVA-300", Level::Unknown, "No record of a previous game launch",
            "Nova couldn't find Fortnite's own log, so it can't tell you what happened last time.",
            "Launch the game once, then run this check again.",
        ));
        return;
    }

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

    // A request that escaped the redirect and reached Epic — identified by WHO ANSWERED.
    //
    // This used to trigger on `CorrId=FN-`, on the theory that "Epic answers with a correlation id;
    // Nova never does". That theory is unverified and probably wrong: the client itself carries
    // `X-Epic-Correlation-ID` (confirmed present in the 7.40 binary), so the id may well be one the
    // client generated and logged back, in which case it says nothing about who responded. Across
    // every log on the reference machine there is exactly ONE HTTP error, so there is no negative
    // control available and the rule cannot be tested either way.
    //
    // The response BODY settles it without any theory. Nova stamps every error envelope with
    // `originatingService` = `nova-backend` (index.ts) or `com.epicgames.account.public`
    // (error-handler.ts). Anything else came from a server that is not Nova. That is what was
    // actually observed on 2026-08-15:
    //
    //   HttpResult: 401 … "originatingService":"friends" … "Token is missing key ID value"
    //   QueryFriendSettings request failed
    //
    // — Epic's live friends service rejecting a Nova-issued JWT for having no `kid` header. Nova
    // writes neither that message nor that service name, so the escape is proven from the body alone.
    //
    // Deliberately conservative: an escape to Epic's *account* service would report
    // `com.epicgames.account.public`, which this treats as ours and misses. A false negative is the
    // right direction to fail in for a check that shows the player a red Error.
    let foreign = foreign_services(&log);
    if !foreign.is_empty() {
        let mut names: Vec<&str> = foreign.iter().map(|s| s.as_str()).collect();
        names.sort_unstable();
        names.dedup();
        out.push(Finding::new(
            "NOVA-303", Level::Error, "Some requests reached Epic's real servers",
            &format!(
                "A few of the game's requests escaped Nova and went to Epic instead, which rejected them \
                 ({} of them, from Epic's {} service). When that happens Fortnite throws away the settings \
                 telling it where your server is, so you get stuck in matchmaking or kicked to the login \
                 screen. It's intermittent, which is why it can work one launch and not the next.",
                foreign.len(),
                names.join(", "),
            ),
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

    // NOVA-307 is NOT checked here — it reads nova-agent.log, a different file, and is called
    // separately from run_diagnostics(). Putting it at the end of this function would have hidden it
    // behind the `cobalt.log` early return above: a PC with no cobalt.log would silently skip the
    // crash check too, which is the same shape of mistake as the bug being fixed.
}

/// NOVA-307 — did the gameserver this PC was running die on its own?
///
/// `[HostRunner] Gameserver exited (code=…)` comes from the BACKEND's stdout, which `start_backend`
/// in main.rs points at `nova-agent.log` beside the launcher executable. The previous version looked
/// for it in `cobalt.log`, which is written by the redirect shim inside the game and never contains
/// it — so this check was structurally incapable of firing.
///
/// Any non-zero exit is reported, not just 0xC0000005. Pinning it to one status code meant a
/// gameserver that died of anything else read as a clean run. The code is quoted in the detail so
/// it is still identifiable at a glance.
///
/// Caveat worth knowing: `nova-agent.log` is truncated every time the launcher starts
/// (`launcher-evidence-is-self-erasing`), so this answers "during this launcher session", which is
/// the question a player running the check right after a failure is actually asking.
fn check_server_crash(out: &mut Vec<Finding>) {
    let Some(agent_log) = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|p| p.join("nova-agent.log")))
    else {
        return;
    };
    let Some(log) = tail(&agent_log, 400_000) else { return };

    // Last exit line wins — earlier ones may be from a server that was deliberately stopped.
    let last_exit = log
        .lines()
        .filter(|l| l.contains("Gameserver exited"))
        .last();

    let Some(line) = last_exit else { return };
    // `…(code=3221225477 signal=null)` → "3221225477". A clean stop is code=0.
    let code = line
        .split("code=")
        .nth(1)
        .map(|s| s.trim_start().split(|c: char| !c.is_ascii_digit()).next().unwrap_or(""))
        .unwrap_or("");

    if code.is_empty() || code == "0" {
        return;
    }

    let known = match code {
        "3221225477" => " (0xC0000005 — an access violation, the usual one)",
        "3221225786" => " (0xC000013A — it was interrupted, usually a manual stop)",
        _ => "",
    };
    out.push(Finding::new(
        "NOVA-307", Level::Error, "The match server crashed",
        &format!(
            "The server this PC was running stopped unexpectedly with code {code}{known}, which ends the \
             match for everyone in it."
        ),
        "Quote NOVA-307 — the crash details are saved automatically.",
    ));
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
pub fn run_diagnostics(build_path: String, coordinator: Option<String>) -> Report {
    let mut findings = Vec::new();
    check_install(&build_path, &mut findings);
    check_services(&mut findings);
    // Default to the same coordinator host.rs uses, so the check follows the real deployment.
    let coord = coordinator.unwrap_or_else(|| crate::host::default_coordinator().to_string());
    check_can_reach_nova(&coord, &mut findings);
    check_last_run(&build_path, &mut findings);
    check_server_run(&mut findings);
    // Separate call: NOVA-307 reads nova-agent.log, not cobalt.log, so it must not sit behind
    // check_server_run's early return for a missing cobalt.log.
    check_server_crash(&mut findings);
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

// ── tests ─────────────────────────────────────────────────────────────────────────────────────────
//
// The launcher had no tests at all before this. These pin the two rules that decide whether a player
// is shown a red Error, because both were wrong in ways nothing outside could see: NOVA-303 keyed on
// evidence that does not prove what it claimed, and the whole 3xx family read a path that does not
// exist for a packaged client.

#[cfg(test)]
mod tests {
    use super::*;

    /// The real line from FortniteGame.log, 2026-08-15 07:48:55 — Epic's live friends service
    /// rejecting a Nova-issued JWT for having no `kid`. This is the only HTTP error in any log on
    /// the reference machine, which is why the detector could not be validated statistically and
    /// had to be reasoned about from the body instead.
    const REAL_ESCAPE: &str = r#"[2026.08.15-07.48.55:436][964]LogOnline: Warning: OSS: PARSE: HttpResult: 401 Code: 1014 Error: Failure ErrorCode=errors.com.epicgames.common.oauth.invalid_token, Message=Token is missing key ID value, Raw={"errorCode":"errors.com.epicgames.common.oauth.invalid_token","errorMessage":"Token is missing key ID value","messageVars":[],"numericErrorCode":1014,"originatingService":"friends","intent":"prod"}
[2026.08.15-07.48.55:436][964]LogOnline: Warning: OSS: Invalid response. CorrId=FN-Yb8rP6eIXEqknl12zZj8vQ code=401 error=Failure
[2026.08.15-07.48.55:436][964]LogOnline: Warning: OSS: QueryFriendSettings request failed. (wasUpdate: 0) Token is missing key ID value"#;

    #[test]
    fn detects_the_real_observed_escape() {
        assert_eq!(
            foreign_services(REAL_ESCAPE),
            vec!["friends".to_string()],
            "the 2026-08-15 escape must be detected",
        );
    }

    #[test]
    fn novas_own_errors_are_not_reported_as_escapes() {
        // Both envelopes Nova can produce. Reporting either would show a red "requests reached Epic"
        // to a player whose setup is working perfectly.
        let nova = r#"Raw={"errorCode":"errors.com.epicgames.common.server_error","originatingService":"nova-backend","intent":"prod"}
Raw={"errorCode":"errors.com.epicgames.common.oauth.invalid_token","originatingService":"com.epicgames.account.public","intent":"prod"}"#;
        assert!(
            foreign_services(nova).is_empty(),
            "Nova's own two service names must never count as an escape",
        );
    }

    #[test]
    fn a_correlation_id_alone_is_not_evidence() {
        // The previous rule fired on exactly this. The client carries X-Epic-Correlation-ID itself
        // (confirmed present in the 7.40 binary), so a CorrId does not establish who answered.
        let corr_only =
            "LogOnline: Warning: OSS: Invalid response. CorrId=FN-Yb8rP6eIXEqknl12zZj8vQ code=401";
        assert!(
            foreign_services(corr_only).is_empty(),
            "a bare correlation id must not be treated as proof of an escape",
        );
    }

    #[test]
    fn counts_occurrences_but_names_each_service_once() {
        let two = r#"{"originatingService":"friends"} x {"originatingService":"friends"} x {"originatingService":"fortnite"}"#;
        let found = foreign_services(two);
        assert_eq!(found.len(), 3, "the count is per occurrence, so the player is told how many escaped");
        let mut names: Vec<&str> = found.iter().map(|s| s.as_str()).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names, vec!["fortnite", "friends"]);
    }

    #[test]
    fn a_clean_log_produces_nothing() {
        let clean = "LogInit: Fortnite 7.40 CL-5046157\nLogOnline: OSS: login complete";
        assert!(foreign_services(clean).is_empty());
    }

    #[test]
    fn a_truncated_envelope_does_not_panic_or_match() {
        // tail() cuts the log mid-line by construction, so a half-written JSON body is normal input.
        let cut = r#"…{"numericErrorCode":1014,"originatingService":"frien"#;
        assert!(foreign_services(cut).is_empty(), "an unterminated value must be ignored, not guessed at");
    }

    #[test]
    fn game_logs_are_found_across_directories_newest_first() {
        // The real defect was WHICH directory was searched, so this asserts the scan itself:
        // both directories contribute, rotated and _2 logs are included, unrelated files are not,
        // and the order is newest-first because that is what check_last_run relies on.
        let root = std::env::temp_dir().join(format!("nova-diag-test-{}", std::process::id()));
        let appdata_like = root.join("appdata").join("FortniteGame").join("Saved").join("Logs");
        let build_like = root.join("build").join("FortniteGame").join("Saved").join("Logs");
        std::fs::create_dir_all(&appdata_like).unwrap();
        std::fs::create_dir_all(&build_like).unwrap();

        // Written oldest → newest so mtimes order the way the names say.
        for (dir, name) in [
            (&appdata_like, "FortniteGame-backup-2026.08.15-06.30.33.log"),
            (&build_like, "FortniteGame_2.log"),
            (&appdata_like, "FortniteGame.log"),
        ] {
            std::fs::write(dir.join(name), b"x").unwrap();
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
        // Must be ignored: right directory, wrong file.
        std::fs::write(appdata_like.join("FortniteLauncher.log"), b"x").unwrap();
        std::fs::write(appdata_like.join("DedicatedServer.log"), b"x").unwrap();

        let found = scan_game_logs(&[appdata_like.clone(), build_like.clone()]);
        let names: Vec<String> = found
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();

        assert_eq!(
            names,
            vec![
                "FortniteGame.log".to_string(),
                "FortniteGame_2.log".to_string(),
                "FortniteGame-backup-2026.08.15-06.30.33.log".to_string(),
            ],
            "newest first, both directories, FortniteLauncher.log and DedicatedServer.log excluded",
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_missing_directory_is_not_an_error() {
        // A machine that has never run the game. This must return nothing rather than panicking —
        // NOVA-300 then reports "no record of a previous launch", which is the honest answer.
        let nowhere = std::env::temp_dir().join("nova-diag-does-not-exist-9f3a");
        assert!(scan_game_logs(&[nowhere]).is_empty());
    }
}
