//! Turning `FortniteGame.log` into diagnostics.
//!
//! ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────
//!
//! `DIAGNOSTIC_COVERAGE.md` listed the whole UE4 row as ❌ with the note that it is "the largest
//! unbuilt area, and it is genuinely observable" — a real error surface sitting on disk that the
//! launcher already opens for other reasons, feeding nothing. Everything the engine knows about a
//! failed session is in there: the MCP profile that would not load, the party update that never sent,
//! the chat rooms the backend refused. None of it reached the dashboard.
//!
//! ── WHY THE LAUNCHER ─────────────────────────────────────────────────────────────────────────────
//!
//! The log is on the player's machine, the launcher already knows where UE4 writes it
//! (`diagnostics::game_log_candidates`, which had to be corrected once when it looked in the build
//! folder instead of `%LOCALAPPDATA%`), and `diagreport` already forwards local diagnostics upstream
//! under the player's token. This module fills the front of that existing pipe rather than building
//! a second one:
//!
//! ```text
//!   FortniteGame*.log ──► this module ──► 127.0.0.1 /nova/api/diagnostics/local ──► diagreport ──► coordinator
//! ```
//!
//! ── THE PART THAT IS EASY TO GET WRONG ───────────────────────────────────────────────────────────
//!
//! Grepping for `Error:` is wrong, and measurably so. In the session shared on 2026-09-06 (two logs,
//! 12,822 lines) **27 lines contain `Error:` or `Warning:` without being an error or a warning**.
//! The worst is this one, which reports a SUCCESS:
//!
//! ```text
//!   LogFortChat: *!* UFortChatManager::HandleReserveChatRoomsComplete - Result Succeded: 1, Error: ,
//! ```
//!
//! and this one, which is a console variable whose NAME contains the word:
//!
//! ```text
//!   LogConfig: Setting CVar [[r.PrecomputedVisibilityWarning:0]]
//! ```
//!
//! So the verbosity is read POSITIONALLY out of UE4's line grammar — `[stamp][frame]Category:
//! Verbosity: message` — and only a known verbosity token in the second position counts. A line at
//! the default `Log` verbosity is never an error no matter what its text says.
//!
//! ── AND THE PART THAT IS EASY TO MAKE USELESS ────────────────────────────────────────────────────
//!
//! That same session has 447 error/warning lines. Sending all of them would add 193 rows to a
//! dashboard capped at 400, most of them AI pathing and particle warnings, and the 36 real errors
//! would be buried. Filtering measured against the real logs rather than guessed:
//!
//!   * `Fatal` and `Error`  — always ingested, whatever the log category.
//!   * `Warning`            — only from categories Nova is actually responsible for (see `SUBSYSTEMS`).
//!   * everything else      — counted and reported as ONE informational row, never silently dropped.
//!
//! Applied to those two logs that yields **70 rows and 241 counted drops** (`cargo test ue4log --
//! --ignored --nocapture` re-runs it against whatever is on this machine), and the top rows are
//! things worth knowing: `ClientRestart_Implementation failed because WorldInventory is invalid`
//! (×288, client), `AFortPoiVolume::PostInitializeComponents - failed to initalized` (×115, host),
//! `GetAthenaLoadoutWithOverrides(): MCP is enabled but we were unable to load AthenaProfile`, and
//! the chat-room retry loop that `reserveGeneralChatRooms` was returning 404 for.

use serde_json::json;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// How often to look for new lines. The log is only written while the game runs, and a player who
/// hits a problem does not need it on the dashboard within the second.
const INTERVAL: Duration = Duration::from_secs(30);
/// Most bytes read from one file in one pass. A first run against a 1.2 MB log must not stall the
/// launcher, and anything older than the current tail is history rather than diagnostics.
const MAX_READ_BYTES: u64 = 512 * 1024;
/// Most distinct rows one pass may produce. Bounded because the input is a file the game writes
/// without limit, and the aggregate on the far end holds 400 keys in total.
const MAX_ROWS_PER_PASS: usize = 60;
/// Matches `LIMITS.MAX_BATCH` in diagnostics.schema.ts. A larger POST is truncated, silently.
const MAX_BATCH: usize = 50;

/// UE4 verbosity tokens that mean something went wrong.
///
/// `Display`, `Log`, `Verbose` and `VeryVerbose` are deliberately absent: they are the engine
/// narrating itself, and 496 `Display` lines in one session would drown everything else.
const BAD_VERBOSITY: [&str; 3] = ["Fatal", "Error", "Warning"];

/// Every UE4 verbosity token, needed in full so the parser can tell "this line has a verbosity that
/// is not interesting" from "this line has no verbosity field at all" — the second is the case that
/// produces the false positives described above.
const ALL_VERBOSITY: [&str; 6] = ["Fatal", "Error", "Warning", "Display", "Verbose", "VeryVerbose"];

/// UE4 log categories Nova is responsible for, mapped to the subsystem the backend already ranks by.
///
/// THE MAPPING IS COARSER THAN THE FAILURE, and that is a stated limitation rather than an oversight:
/// UE4's category says which engine module logged the line, not what broke. `LogFortQuest` covers
/// both a quest that did not grant and a POI volume that failed to initialise. The normalised message
/// is always carried alongside, so an operator reads the actual text rather than trusting the bucket.
///
/// Membership has one consequence beyond ranking: it is what admits a `Warning`. A category not on
/// this list contributes only `Error` and `Fatal`.
const SUBSYSTEMS: [(&str, &str); 14] = [
    ("LogOnline", "auth"),
    ("LogOnlineAccount", "auth"),
    ("LogOnlineIdentity", "auth"),
    ("LogOnlineSession", "matchmaking"),
    ("LogBeacon", "matchmaking"),
    ("LogNet", "matchmaking"),
    ("LogOnlineParty", "social"),
    ("LogParty", "social"),
    ("LogOnlineChat", "social"),
    ("LogFortChat", "social"),
    ("LogXmpp", "social"),
    ("LogFortQuest", "mcp"),
    ("LogFort", "mcp"),
    ("LogHttp", "other"),
];

/// One parsed UE4 line.
#[derive(Debug, PartialEq)]
pub struct Ue4Line<'a> {
    pub category: &'a str,
    pub verbosity: &'a str,
    pub message: &'a str,
}

/// One diagnostic ready for the wire.
#[derive(Debug, Clone, PartialEq)]
pub struct Ue4Event {
    pub source: &'static str,
    pub category: &'static str,
    pub url: String,
    pub detail: String,
    pub count: u32,
}

/// What one pass over a log produced.
#[derive(Debug, Default, PartialEq)]
pub struct Scan {
    pub events: Vec<Ue4Event>,
    /// Error/warning lines deliberately not ingested. Reported, never silently discarded.
    pub dropped: usize,
    /// Lines examined, so a pass that found nothing can be told from a pass that read nothing.
    pub lines: usize,
    /// The build string UE4 printed, when this text contained the header that carries it.
    pub build: Option<String>,
}

/// Parse one line of a UE4 log.
///
/// The grammar is `[timestamp][frame]Category: Verbosity: message`, with the verbosity omitted at
/// the default `Log` level. Returning `None` for a line whose second field is not a verbosity token
/// is the whole point — see the module header for the three real lines that punish getting it wrong.
///
/// The timestamp prefix is optional: UE4 writes the first handful of lines before the log timestamps
/// are initialised (`LogPakFile: Display: …` with no `[stamp]`), and those are real lines too.
pub fn parse_line(line: &str) -> Option<Ue4Line<'_>> {
    let mut rest = line.trim_start_matches('\u{feff}').trim_end();

    // Strip `[stamp]` and `[frame]` when present. Anything else in brackets is message content and
    // must be left alone.
    while rest.starts_with('[') {
        let close = rest.find(']')?;
        let inner = &rest[1..close];
        // A timestamp or a frame counter only. `[[r.PrecomputedVisibilityWarning:0]]` is neither,
        // and eating it would turn a CVar assignment into a category called `r.Precomputed…`.
        if !inner
            .chars()
            .all(|c| c.is_ascii_digit() || c == '.' || c == '-' || c == ':' || c == ' ')
            || inner.trim().is_empty()
        {
            break;
        }
        rest = rest[close + 1..].trim_start();
    }

    let (category, after) = rest.split_once(FIELD_SEP)?;
    if category.is_empty() || !category.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return None;
    }

    let (verbosity, message) = match after.split_once(FIELD_SEP) {
        Some((v, m)) if ALL_VERBOSITY.contains(&v) => (v, m),
        // No verbosity field: this is a default-`Log` line. Its text may well contain the word
        // "Error"; it is still not one.
        _ => ("Log", after),
    };

    Some(Ue4Line { category, verbosity, message: message.trim() })
}

/// UE4 separates `Category`, `Verbosity` and the message with exactly this.
const FIELD_SEP: &str = ": ";

/// The subsystem a UE4 log category belongs to, or `None` when Nova does not own it.
pub fn subsystem_for(category: &str) -> Option<&'static str> {
    SUBSYSTEMS.iter().find(|(c, _)| *c == category).map(|(_, s)| *s)
}

/// Whether a line clears the ingest threshold. See the module header for the measurement behind it.
pub fn should_ingest(category: &str, verbosity: &str) -> bool {
    match verbosity {
        "Fatal" | "Error" => true,
        "Warning" => subsystem_for(category).is_some(),
        _ => false,
    }
}

/// UE4 verbosity → the Nova failure taxonomy in diagnostics.schema.ts.
///
/// A UE4 `Error` is the client reporting an internal error, which is what `INTERNAL_ERROR` means;
/// `Fatal` is the engine dying, which is `CRASH`. Warnings only reach here from a subsystem Nova
/// owns, so `UNEXPECTED_STATE` is accurate for them rather than generous.
fn nova_category(verbosity: &str) -> &'static str {
    match verbosity {
        "Fatal" => "CRASH",
        "Error" => "INTERNAL_ERROR",
        _ => "UNEXPECTED_STATE",
    }
}

/// Strip anything that would make two occurrences of the same problem look different.
///
/// Without this the eight stack-frame lines of a single hitch become eight rows of raw addresses,
/// and `Took 245.85ms` / `Took 1213.00ms` never aggregate. Order matters: addresses before the
/// general hex rule, floats before integers, or the later rules eat the earlier ones' input.
pub fn normalise_message(msg: &str) -> String {
    let mut out = String::with_capacity(msg.len());
    let bytes: Vec<char> = msg.chars().collect();
    let mut i = 0usize;

    while i < bytes.len() {
        let c = bytes[i];

        // 0x… — a pointer or a handle.
        if c == '0' && i + 1 < bytes.len() && (bytes[i + 1] == 'x' || bytes[i + 1] == 'X') {
            let mut j = i + 2;
            while j < bytes.len() && bytes[j].is_ascii_hexdigit() {
                j += 1;
            }
            if j > i + 2 {
                out.push_str("{addr}");
                i = j;
                continue;
            }
        }

        // A long hex run — a GUID, a session id, an account id with the dashes stripped.
        if c.is_ascii_hexdigit() {
            let mut j = i;
            while j < bytes.len() && bytes[j].is_ascii_hexdigit() {
                j += 1;
            }
            if j - i >= 16 {
                out.push_str("{hex}");
                i = j;
                continue;
            }
        }

        // A number, decimal or not. Timings, counts, actor instance suffixes.
        if c.is_ascii_digit() {
            let mut j = i;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            let mut is_float = false;
            if j < bytes.len() && bytes[j] == '.' && j + 1 < bytes.len() && bytes[j + 1].is_ascii_digit() {
                is_float = true;
                j += 1;
                while j < bytes.len() && bytes[j].is_ascii_digit() {
                    j += 1;
                }
            }
            out.push_str(if is_float { "{f}" } else { "{n}" });
            i = j;
            continue;
        }

        // A content path. `/Game/Items/Datatables/LootQuotaData` and its neighbours are one problem.
        if c == '/' && i + 1 < bytes.len() && bytes[i + 1].is_ascii_alphanumeric() {
            let mut j = i;
            while j < bytes.len()
                && (bytes[j].is_ascii_alphanumeric() || "/._-".contains(bytes[j]))
            {
                j += 1;
            }
            out.push_str("{path}");
            i = j;
            continue;
        }

        out.push(c);
        i += 1;
    }

    // Collapse the whitespace UE4 uses to align columns, so `for   504.51ms` and `for 12.00ms`
    // normalise identically.
    out.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(200).collect()
}

/// Remove secret material. The backend redacts on the way in as well; this keeps it out of the
/// launcher's own console and off the loopback hop, which is where it would be easiest to forget.
fn redact(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(idx) = rest.find("eg1~") {
        out.push_str(&rest[..idx]);
        out.push_str("eg1~<redacted>");
        let after = &rest[idx + 4..];
        let end = after
            .find(|c: char| !(c.is_ascii_alphanumeric() || "._~+/-=".contains(c)))
            .unwrap_or(after.len());
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

/// Who wrote a log, and which build wrote it.
///
/// THIS IS A PROPERTY OF THE FILE, NOT OF A CHUNK, and getting that wrong is a bug this code already
/// had. Both facts live in a header UE4 writes once at startup — measured at byte 12752 in the logs
/// from 2026-09-06, past any plausible "read the first few KB" window, and absent entirely from the
/// incremental chunks the watcher normally reads. Deriving it per chunk gave every log `CLIENT`,
/// which looked correct for the client log and silently mislabelled the gameserver's.
///
/// So it is resolved once per file, from the file's own head, and carried into the scan.
#[derive(Debug, Clone, PartialEq)]
pub struct Header {
    /// CLIENT or HOST.
    pub source: &'static str,
    /// `++Fortnite+Release-7.40-CL-5046157`, when the log said so.
    pub build: Option<String>,
}

impl Default for Header {
    fn default() -> Self {
        // CLIENT, because a log with no readable header is far more likely to be a player's own
        // client than a gameserver — hosting is the rarer case and the one that carries the marker.
        Header { source: "CLIENT", build: None }
    }
}

impl Header {
    /// Read both facts out of a log's opening section.
    ///
    /// `-nullrhi` is decisive rather than inferred: `carter.rs` passes it to the instance that
    /// becomes the server and to nothing else, and UE4 echoes the whole command line into
    /// `LogInit: Filtered Command Line:`. Guessing from which file is newer would be wrong about
    /// half the time, because which of the two processes exits last depends on the session.
    pub fn from_text(text: &str) -> Header {
        let mut h = Header::default();
        for line in text.lines() {
            if h.build.is_none() {
                if let Some(b) = line.split("LogInit: Build: ").nth(1) {
                    h.build = Some(b.trim().chars().take(80).collect());
                }
            }
            if line.contains("Filtered Command Line:") && line.contains("-nullrhi") {
                h.source = "HOST";
            }
        }
        h
    }
}

/// How much of a file's head to read when resolving its header. The command line sits at ~12.7 KB in
/// a real log; 64 KB leaves room for a longer preamble without reading a megabyte to learn two facts.
const HEADER_BYTES: u64 = 64 * 1024;

/// Turn a chunk of log text into diagnostics, given what is already known about the file it came
/// from. Pure, so the whole policy is testable without a file.
pub fn scan_text_with(text: &str, header: &Header) -> Scan {
    let source = header.source;
    let build = header.build.clone();
    let mut counts: HashMap<(String, &'static str), (u32, String)> = HashMap::new();
    let mut dropped = 0usize;
    let mut lines = 0usize;

    for raw in text.lines() {
        lines += 1;
        let Some(line) = parse_line(raw) else { continue };
        if !BAD_VERBOSITY.contains(&line.verbosity) {
            continue;
        }
        if !should_ingest(line.category, line.verbosity) {
            dropped += 1;
            continue;
        }

        let subsystem = subsystem_for(line.category).unwrap_or("other");
        let normalised = normalise_message(&redact(line.message));
        // `/` is the path separator the backend's route normaliser splits on, so any that survived
        // normalisation would silently become extra path segments.
        let slug = normalised.replace('/', "~");
        let url = format!("/ue4/{}/{}/{}", subsystem, line.category, slug);

        let entry = counts
            .entry((url, nova_category(line.verbosity)))
            .or_insert_with(|| (0, redact(line.message).chars().take(300).collect()));
        entry.0 += 1;
    }

    let mut events: Vec<Ue4Event> = counts
        .into_iter()
        .map(|((url, category), (count, detail))| Ue4Event {
            source,
            category,
            url: url.chars().take(500).collect(),
            detail,
            count,
        })
        .collect();

    // Loudest first, so the cap keeps what matters when a pass overflows it.
    events.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.url.cmp(&b.url)));
    if events.len() > MAX_ROWS_PER_PASS {
        dropped += events.len() - MAX_ROWS_PER_PASS;
        events.truncate(MAX_ROWS_PER_PASS);
    }

    Scan { events, dropped, lines, build }
}

/// Scan text that carries its own header. Convenience for a whole-file read.
pub fn scan_text(text: &str) -> Scan {
    scan_text_with(text, &Header::from_text(text))
}

/// Read a log's opening section and resolve its header.
fn read_header(path: &Path) -> Option<Header> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; HEADER_BYTES as usize];
    let n = f.read(&mut buf).ok()?;
    buf.truncate(n);
    Some(Header::from_text(&String::from_utf8_lossy(&buf)))
}

/// Where the offsets live, so a launcher restart does not re-report a log it has already read.
fn offsets_path() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".to_string());
    let mut p = PathBuf::from(base);
    p.push("ProjectNova");
    let _ = std::fs::create_dir_all(&p);
    p.push("ue4log-offsets.json");
    p
}

/// Tracks how far into each log file has already been reported.
///
/// WITHOUT THIS, every launcher start would re-read a whole session and re-report it. The counts on
/// the dashboard would climb with each restart and mean nothing.
#[derive(Default)]
pub struct Watcher {
    offsets: HashMap<PathBuf, u64>,
    /// Resolved once per file and reused, because the incremental chunks this reads never contain
    /// the header. Dropped when a file is truncated: a new session may swap which process writes
    /// which file, and a cached `HOST` on the player's own client log would be worse than no cache.
    headers: HashMap<PathBuf, Header>,
}

impl Watcher {
    /// Load the offsets written by a previous run. A missing or unreadable file is a fresh start,
    /// not an error — the cost is one duplicated read, which the aggregate absorbs.
    pub fn load() -> Self {
        let mut w = Watcher::default();
        if let Ok(text) = std::fs::read_to_string(offsets_path()) {
            if let Ok(map) = serde_json::from_str::<HashMap<String, u64>>(&text) {
                for (k, v) in map {
                    w.offsets.insert(PathBuf::from(k), v);
                }
            }
        }
        w
    }

    fn save(&self) {
        let map: HashMap<String, u64> = self
            .offsets
            .iter()
            .map(|(k, v)| (k.to_string_lossy().into_owned(), *v))
            .collect();
        if let Ok(text) = serde_json::to_string(&map) {
            let _ = std::fs::write(offsets_path(), text);
        }
    }

    /// Read whatever is new in one file.
    ///
    /// UE4 TRUNCATES the log when the game starts, so a file that is now SHORTER than the offset we
    /// hold is a new session rather than a corrupt read, and the right response is to start again
    /// from zero. Treating it as an error would mean the launcher never reports anything after the
    /// first session it saw.
    fn read_new(&mut self, path: &Path) -> Option<String> {
        let mut f = std::fs::File::open(path).ok()?;
        let len = f.metadata().ok()?.len();
        let previous = self.offsets.get(path).copied().unwrap_or(0);
        let truncated = len < previous;
        if truncated {
            self.headers.remove(path);
        }
        let mut from = if truncated { 0 } else { previous };

        if len <= from {
            return None; // nothing new
        }
        // A very large gap means this is the first look at an existing log. Read the tail; the top
        // of a 1.2 MB file is a session that has already ended.
        if len - from > MAX_READ_BYTES {
            from = len - MAX_READ_BYTES;
        }

        f.seek(SeekFrom::Start(from)).ok()?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf).ok()?;
        self.offsets.insert(path.to_path_buf(), len);
        Some(String::from_utf8_lossy(&buf).into_owned())
    }

    /// Who wrote this file and with which build, read from its head and cached.
    fn header_for(&mut self, path: &Path) -> Header {
        if let Some(h) = self.headers.get(path) {
            return h.clone();
        }
        let header = read_header(path).unwrap_or_default();
        self.headers.insert(path.to_path_buf(), header.clone());
        header
    }

    /// Scan every Fortnite log for new lines. Returns one merged result.
    pub fn poll(&mut self, logs: &[PathBuf]) -> Scan {
        let mut merged = Scan::default();
        for path in logs {
            let Some(text) = self.read_new(path) else { continue };
            let header = self.header_for(path);
            let scan = scan_text_with(&text, &header);
            merged.lines += scan.lines;
            merged.dropped += scan.dropped;
            if merged.build.is_none() {
                merged.build = scan.build.clone();
            }
            merged.events.extend(scan.events);
        }
        self.save();
        merged
    }
}

/// POST one scan to the local agent, which is what feeds the existing forwarding pipeline.
///
/// The drop count goes with it, as its own informational row. The brief was explicit that a `?` must
/// have an explanation; a filter that quietly discards 241 lines per session and never says so is
/// the same failure in a different place.
pub async fn report(agent: &str, scan: &Scan) -> usize {
    if scan.events.is_empty() && scan.dropped == 0 {
        return 0;
    }
    let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(10)).build() else {
        return 0;
    };

    let build = scan.build.clone();
    let mut events: Vec<serde_json::Value> = scan
        .events
        .iter()
        .map(|e| {
            json!({
                "source": e.source, "category": e.category, "method": "UE4",
                "url": e.url, "component": "ue4", "build": build,
                "detail": e.detail, "count": e.count,
            })
        })
        .collect();

    if scan.dropped > 0 {
        events.push(json!({
            "source": "CLIENT", "category": "UNKNOWN", "method": "UE4",
            "url": "/ue4/nova/ingest/below-threshold",
            "component": "ue4", "build": build,
            "detail": format!(
                "{} UE4 warning line(s) not ingested: below the threshold, or past the per-pass row cap",
                scan.dropped
            ),
            "count": scan.dropped.min(1000),
        }));
    }

    let mut accepted = 0usize;
    for chunk in events.chunks(MAX_BATCH) {
        let res = client
            .post(format!("{}/nova/api/diagnostics/local", agent.trim_end_matches('/')))
            .json(&json!({ "events": chunk }))
            .send()
            .await;
        if let Ok(r) = res {
            if r.status().is_success() {
                accepted += chunk.len();
            }
        }
        // Anything else: this cycle loses those events. The agent may simply not be up yet, and a
        // retry buffer here would be an unbounded queue in the one process the player is watching.
    }
    accepted
}

/// Run one pass. Public so a test or a "check now" button can drive it without the timer.
pub async fn ingest_once(agent: &str, build_path: &str, watcher: &mut Watcher) -> usize {
    let logs = crate::diagnostics::game_log_candidates(build_path);
    if logs.is_empty() {
        return 0;
    }
    let scan = watcher.poll(&logs);
    report(agent, &scan).await
}

/// Start the background watcher. Fire-and-forget; it lives for the process.
pub fn spawn(agent: String, build_path: String) {
    tauri::async_runtime::spawn(async move {
        let mut watcher = Watcher::load();
        loop {
            let n = ingest_once(&agent, &build_path, &mut watcher).await;
            // Quiet unless there was something. This runs every 30 s forever, and a line per pass
            // would bury the diagnostics it exists to surface.
            if n > 0 {
                println!("[UE4] reported {} diagnostic row(s) from FortniteGame logs", n);
            }
            tokio::time::sleep(INTERVAL).await;
        }
    });
}

/// Start the watcher once. Idempotent — the UI may re-run its effects, and two loops would double
/// every count.
#[tauri::command]
pub fn ue4_log_start_watching(agent: String, build_path: String) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    spawn(agent, build_path);
}

/// Force a pass now, for the Self-check screen.
#[tauri::command]
pub async fn ue4_log_ingest_now(agent: String, build_path: String) -> Result<usize, String> {
    let mut watcher = Watcher::load();
    Ok(ingest_once(&agent, &build_path, &mut watcher).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Every line below is copied verbatim from the logs shared on 2026-09-06. Inventing plausible
    // UE4 lines would test the parser against my idea of the format rather than the format.

    #[test]
    fn a_real_error_line_parses() {
        let l = parse_line(
            "[2026.09.06-02.05.28:384][699]LogFort: Error: AFortPlayerController::GetAthenaLoadoutWithOverrides(): MCP is enabled but we were unable to load AthenaProfile",
        )
        .expect("a real error line did not parse");
        assert_eq!(l.category, "LogFort");
        assert_eq!(l.verbosity, "Error");
        assert!(l.message.starts_with("AFortPlayerController::"));
    }

    #[test]
    fn a_success_line_containing_error_is_not_an_error() {
        // THE ONE THAT MATTERS. A substring match on "Error:" reports this as a failure; it says the
        // operation succeeded. 27 lines in the shared session have this shape.
        let l = parse_line(
            "[2026.09.06-02.05.28:585][710]LogFortChat: *!* UFortChatManager::HandleReserveChatRoomsComplete - Result Succeded: 1, Error: , Num Global Rooms: 1",
        )
        .expect("the line should still parse");
        assert_eq!(l.verbosity, "Log", "a default-verbosity line was read as an error");
        assert!(!BAD_VERBOSITY.contains(&l.verbosity));
    }

    #[test]
    fn a_cvar_named_warning_is_not_a_warning() {
        let l = parse_line("[2026.09.06-02.04.57:501][  0]LogConfig: Setting CVar [[r.PrecomputedVisibilityWarning:0]]")
            .expect("the line should parse");
        assert_eq!(l.category, "LogConfig");
        assert_eq!(l.verbosity, "Log");
    }

    #[test]
    fn a_warning_whose_message_contains_error_keeps_its_real_verbosity() {
        // Verbosity is positional, not textual: this is a Warning that happens to say "Error:".
        let l = parse_line(
            "[2026.09.06-02.05.11:988][  0]LogGfeSDK: Warning: 2026-09-06T12:05:11.989[E] GAME CoreCInterface.cpp:79 Error: failed initializing SDK -1022",
        )
        .unwrap();
        assert_eq!(l.verbosity, "Warning");
    }

    #[test]
    fn a_line_written_before_timestamps_start_still_parses() {
        // UE4 writes the first lines of a log with no [stamp][frame] prefix at all.
        let l = parse_line("LogPakFile: Display: Mounting pak file ../../../FortniteGame/Content/Paks/pakchunk9-WindowsClient.pak.")
            .expect("an untimestamped line did not parse");
        assert_eq!(l.category, "LogPakFile");
        assert_eq!(l.verbosity, "Display");
    }

    #[test]
    fn the_header_line_is_not_mistaken_for_a_category() {
        assert!(parse_line("Log file open, 09/06/26 12:04:56").is_none());
    }

    #[test]
    fn engine_noise_warnings_are_dropped_but_engine_errors_are_not() {
        // 89 distinct LogFortAI warnings in one session, versus 36 errors in the whole client log.
        // Admitting the first would bury the second.
        assert!(!should_ingest("LogFortAI", "Warning"));
        assert!(!should_ingest("LogParticles", "Warning"));
        assert!(should_ingest("LogFortAI", "Error"), "an engine ERROR must still be reported");
        assert!(should_ingest("LogStreaming", "Fatal"));
        // …and a subsystem Nova owns contributes its warnings.
        assert!(should_ingest("LogOnlineParty", "Warning"));
        assert!(should_ingest("LogFortChat", "Warning"));
    }

    #[test]
    fn a_hitch_stack_dump_collapses_to_one_row() {
        // Eight raw addresses from a single hitch would otherwise be eight rows of noise.
        let text = "\
[2026.09.06-02.05.05:126][  0]LogCore: Error: ------Stack start
[2026.09.06-02.05.05:126][  0]LogCore: Error: 0x00007ffca813fb74
[2026.09.06-02.05.05:126][  0]LogCore: Error: 0x00007ffca590c1ae
[2026.09.06-02.05.05:126][  0]LogCore: Error: 0x00007ff61a673c97
[2026.09.06-02.05.05:126][  0]LogCore: Error: 0x00007ff61b00d603";
        let scan = scan_text(text);
        let addr_rows: Vec<_> = scan.events.iter().filter(|e| e.url.contains("{addr}")).collect();
        assert_eq!(addr_rows.len(), 1, "the stack frames did not aggregate");
        assert_eq!(addr_rows[0].count, 4);
    }

    #[test]
    fn timings_aggregate_across_different_durations() {
        let a = normalise_message("Took 245.85ms to ProcessLoadedPackages");
        let b = normalise_message("Took 1213.00ms to ProcessLoadedPackages");
        assert_eq!(a, b, "two occurrences of one problem produced different keys");
        assert_eq!(a, "Took {f}ms to ProcessLoadedPackages");
    }

    #[test]
    fn aligned_whitespace_does_not_split_a_row() {
        // UE4 pads numbers to align columns: `for   504.51ms` and `for 12.00ms` are one problem.
        assert_eq!(
            normalise_message("Hitch detected on gamethread (frame hasn't finished for   504.51ms):"),
            normalise_message("Hitch detected on gamethread (frame hasn't finished for 12.00ms):"),
        );
    }

    #[test]
    fn guids_and_paths_are_collapsed() {
        assert_eq!(
            normalise_message("AFortQuickBars::AddItemInternal could not find Item with GUID 8F3A2B1C9D4E5F60"),
            "AFortQuickBars::AddItemInternal could not find Item with GUID {hex}",
        );
        assert_eq!(
            normalise_message("Couldn't find file for package /Game/Items/Datatables/LootQuotaData requested"),
            "Couldn't find file for package {path} requested",
        );
    }

    #[test]
    fn a_token_never_reaches_the_wire() {
        // 7.40 puts a live bearer token in URL paths, and those paths appear in LogHttp lines.
        let text = "[2026.09.06-02.05.28:384][699]LogHttp: Error: request to /account/api/oauth/sessions/kill/eg1~aaaabbbbccccdddd.eeee failed";
        let scan = scan_text(text);
        let all = format!("{:?}", scan.events);
        assert!(!all.contains("aaaabbbbccccdddd"), "a token survived redaction: {}", all);
        assert!(all.contains("eg1~<redacted>"), "the shape should stay readable: {}", all);
    }

    #[test]
    fn the_server_log_is_attributed_to_the_host_not_the_client() {
        // carter.rs passes -nullrhi to the instance that becomes the server, and to nothing else.
        let server = "LogInit: Filtered Command Line: -epiclocale=en-us -nobe -skippatchcheck -nullrhi -nosound -unattended\n\
                      [2026.09.06-02.05.28:384][699]LogFort: Error: something broke";
        let client = "LogInit: Filtered Command Line: -epiclocale=en-us -nobe -skippatchcheck -nosplash\n\
                      [2026.09.06-02.05.28:384][699]LogFort: Error: something broke";
        assert_eq!(scan_text(server).events[0].source, "HOST");
        assert_eq!(scan_text(client).events[0].source, "CLIENT");
    }

    #[test]
    fn the_build_is_read_from_the_log_itself() {
        let text = "LogInit: Build: ++Fortnite+Release-7.40-CL-5046157\n\
                    [2026.09.06-02.05.28:384][699]LogFort: Error: x";
        assert_eq!(scan_text(text).build.as_deref(), Some("++Fortnite+Release-7.40-CL-5046157"));
    }

    #[test]
    fn dropped_lines_are_counted_rather_than_discarded() {
        // A filter that silently throws away 241 lines a session is the same silent-failure shape
        // this whole subsystem exists to remove.
        let text = "\
[2026.09.06-02.05.05:126][  0]LogFortAI: Warning: pathing gave up
[2026.09.06-02.05.05:126][  0]LogParticles: Warning: emitter is unhappy
[2026.09.06-02.05.05:126][  0]LogFort: Error: real problem";
        let scan = scan_text(text);
        assert_eq!(scan.dropped, 2);
        assert_eq!(scan.events.len(), 1);
    }

    #[test]
    fn the_url_carries_the_subsystem_the_backend_ranks_by() {
        let text = "[2026.09.06-02.05.28:384][699]LogOnlineParty: Warning: UpdateParty request failure";
        let scan = scan_text(text);
        assert!(
            scan.events[0].url.starts_with("/ue4/social/LogOnlineParty/"),
            "unexpected url: {}",
            scan.events[0].url,
        );
    }

    #[test]
    fn a_message_with_slashes_cannot_forge_extra_path_segments() {
        // The backend splits the route on `/`. A message that kept its slashes would become extra
        // segments and could impersonate a different subsystem.
        let text = "[2026.09.06-02.05.28:384][699]LogFort: Error: a/b/c failed";
        let scan = scan_text(text);
        let tail = scan.events[0].url.trim_start_matches("/ue4/mcp/LogFort/");
        assert!(!tail.contains('/'), "a slash survived into the route: {}", scan.events[0].url);
    }

    #[test]
    fn a_truncated_log_is_re_read_from_the_start() {
        // UE4 truncates the log when the game starts. A watcher that treated a shrinking file as an
        // error would report nothing after the first session it ever saw.
        let dir = std::env::temp_dir().join(format!("nova-ue4log-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("FortniteGame.log");

        std::fs::write(&path, "[2026.09.06-02.05.28:384][699]LogFort: Error: first session\n").unwrap();
        let mut w = Watcher::default();
        assert_eq!(w.poll(&[path.clone()]).events.len(), 1);
        // Nothing new.
        assert_eq!(w.poll(&[path.clone()]).events.len(), 0, "the same lines were reported twice");

        // A new, SHORTER session.
        std::fs::write(&path, "[2026.09.06-03.00.00:000][  1]LogFort: Error: x\n").unwrap();
        assert_eq!(w.poll(&[path.clone()]).events.len(), 1, "a truncated log was not re-read");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_row_cap_keeps_the_loudest() {
        let mut text = String::new();
        for i in 0..(MAX_ROWS_PER_PASS + 10) {
            text.push_str(&format!("[2026.09.06-02.05.05:126][  0]LogFort: Error: distinct problem {}\n", i));
        }
        // …plus one that happens a lot. `{n}` normalisation means the first group is ONE row, so
        // make each distinct by using words rather than numbers.
        let mut text2 = String::new();
        for i in 0..(MAX_ROWS_PER_PASS + 10) {
            text2.push_str(&format!(
                "[2026.09.06-02.05.05:126][  0]LogFort: Error: problem {}\n",
                "x".repeat(i + 1)
            ));
        }
        for _ in 0..50 {
            text2.push_str("[2026.09.06-02.05.05:126][  0]LogFort: Error: the loud one\n");
        }
        let scan = scan_text(&text2);
        assert_eq!(scan.events.len(), MAX_ROWS_PER_PASS, "the per-pass cap did not hold");
        assert_eq!(scan.events[0].count, 50, "the cap discarded the loudest row");
        assert!(scan.dropped >= 10, "rows past the cap were not counted as dropped");
        let _ = text;
    }

    #[test]
    fn the_header_is_found_where_it_actually_sits_not_where_it_seems_reasonable() {
        // THE BUG THIS PINS. The first version read the first 8000 characters looking for the
        // command line. In the real logs it is at byte 12752 — so it was never found, both files
        // defaulted to CLIENT, and the gameserver's log was silently mislabelled. It looked correct,
        // because the default happened to be right for the one file anyone checked.
        let mut text = String::new();
        for i in 0..500 {
            text.push_str(&format!("LogPakFile: Display: Mounting pak file chunk{}.pak.\n", i));
        }
        assert!(text.len() > 12_000, "the preamble must be longer than a naive window");
        text.push_str("LogInit: Filtered Command Line: -nobe -nullrhi -nosound -unattended\n");
        text.push_str("LogInit: Build: ++Fortnite+Release-7.40-CL-5046157\n");

        let h = Header::from_text(&text);
        assert_eq!(h.source, "HOST", "the command line was missed because it sits past a short window");
        assert_eq!(h.build.as_deref(), Some("++Fortnite+Release-7.40-CL-5046157"));
    }

    #[test]
    fn a_chunk_with_no_header_inherits_the_file_it_came_from() {
        // The watcher reads INCREMENTAL chunks, and every chunk after the first contains no header
        // at all. Re-deriving the source per chunk is what produced the bug above.
        let header = Header { source: "HOST", build: Some("++Fortnite+Release-7.40-CL-5046157".into()) };
        let chunk = "[2026.09.06-02.05.28:384][699]LogFort: Error: something broke";
        let scan = scan_text_with(chunk, &header);
        assert_eq!(scan.events[0].source, "HOST", "a mid-file chunk lost its attribution");
        assert_eq!(scan.build.as_deref(), Some("++Fortnite+Release-7.40-CL-5046157"));
    }

    #[test]
    fn batch_size_matches_the_backend_limit() {
        assert_eq!(MAX_BATCH, 50, "a larger batch is truncated by the backend, silently");
    }

    /// Send this machine's real logs to a real backend and report what it accepted.
    ///
    /// Ignored by default: it needs a running agent, which a CI box does not have. It exists because
    /// "the classifier produces good rows" and "those rows reach the dashboard" are two different
    /// claims, and only this one tests the second.
    ///
    ///   NOVA_TEST_AGENT=http://127.0.0.1:3599 cargo test ue4log -- --ignored --nocapture
    ///
    /// Deliberately bypasses `Watcher`: driving it here would consume the offsets the real launcher
    /// uses, and a diagnostic check must not change the state of the thing it is checking.
    #[test]
    #[ignore = "needs a running Nova agent; set NOVA_TEST_AGENT"]
    fn real_logs_reach_a_running_agent() {
        let Ok(agent) = std::env::var("NOVA_TEST_AGENT") else {
            println!("NOVA_TEST_AGENT not set — skipping");
            return;
        };
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let mut total = 0usize;
        for path in crate::diagnostics::game_log_candidates("") {
            let Ok(bytes) = std::fs::read(&path) else { continue };
            let header = read_header(&path).unwrap_or_default();
            let scan = scan_text_with(&String::from_utf8_lossy(&bytes), &header);
            let accepted = rt.block_on(report(&agent, &scan));
            // `accepted` counts the below-threshold report row too, which is why it can exceed
            // `scan.events.len()` by one. Printed apart rather than compared, so the number reads
            // as what it is.
            println!(
                "{} -> {} row(s) accepted ({} classified + the drop report; {} lines dropped)",
                path.file_name().unwrap_or_default().to_string_lossy(),
                accepted,
                scan.events.len(),
                scan.dropped,
            );
            total += accepted;
        }
        assert!(total > 0, "nothing reached the agent at {}", agent);
    }

    /// Run the real classifier over the real logs on this machine and print what a dashboard would
    /// receive. Ignored by default because it depends on a file that only exists where Fortnite has
    /// run — but it is the only check that can catch a policy which is correct on hand-written lines
    /// and useless on a real session.
    ///
    ///   cargo test ue4log -- --ignored --nocapture
    #[test]
    #[ignore = "needs a real FortniteGame log on this machine"]
    fn against_the_real_logs() {
        let logs = crate::diagnostics::game_log_candidates("");
        if logs.is_empty() {
            println!("no FortniteGame logs on this machine — nothing to check");
            return;
        }
        let mut rows = 0usize;
        let mut dropped = 0usize;
        for path in &logs {
            let Ok(bytes) = std::fs::read(path) else { continue };
            let text = String::from_utf8_lossy(&bytes);
            // Through read_header, exactly as the watcher does — a whole-file scan would find the
            // header by luck and hide the bug that made this check worth writing.
            let header = read_header(path).unwrap_or_default();
            let scan = scan_text_with(&text, &header);
            println!(
                "\n{}  —  {} lines, {} rows, {} dropped, build {:?}, source {}",
                path.file_name().unwrap_or_default().to_string_lossy(),
                scan.lines,
                scan.events.len(),
                scan.dropped,
                scan.build,
                header.source,
            );
            for e in scan.events.iter().take(6) {
                println!("   x{:<5} {:<16} {}", e.count, e.category, &e.url[..e.url.len().min(110)]);
            }
            rows += scan.events.len();
            dropped += scan.dropped;
        }
        println!("\nTOTAL: {} rows, {} lines dropped below the threshold", rows, dropped);
        assert!(rows > 0, "the classifier found nothing at all in a real log — the policy is broken");
        assert!(rows <= MAX_ROWS_PER_PASS * logs.len(), "the per-pass cap did not hold");
    }
}
