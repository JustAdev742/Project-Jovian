//! Forwarding this machine's diagnostics to the coordinator.
//!
//! WHY THE LAUNCHER IS THE ONE THAT DOES THIS.
//!
//! Cobalt and Project Reboot see the failures, but neither holds a credential and neither should —
//! Cobalt in particular sees the player's bearer token as a matter of course, since it hooks the
//! call that sets curl's URL. A component that authenticated its own telemetry by borrowing that
//! token would be doing exactly what the diagnostics design forbids.
//!
//! So they report anonymously to the LOCAL agent, which keeps a small bounded queue, and this
//! forwards that queue to the coordinator under the launcher's own token. The in-game components
//! never touch identity; attribution happens here, once, at the only place that legitimately has it.
//!
//! ```text
//!   Cobalt / Reboot ──► 127.0.0.1 /nova/api/diagnostics/local   (anonymous, localhost only)
//!                                     │  bounded queue
//!   this module      ◄── GET  /nova/api/diagnostics/pending     (drains it)
//!                    ──► POST <coordinator>/nova/api/diagnostics/ingest   (with our token)
//! ```
//!
//! RESILIENCE RULES, because telemetry must never be why someone cannot play:
//!   * Every failure is swallowed. A coordinator that is down, slow, or rejecting simply means this
//!     cycle does nothing.
//!   * The drained batch is DROPPED on a failed upload rather than retried forever. The local queue
//!     is already bounded and lossy by design; adding an unbounded retry buffer here would move the
//!     leak rather than remove it, and stale diagnostics are worth little anyway.
//!   * A 429 backs off. The coordinator tells us its ceiling; ignoring that would be the client
//!     behaviour this whole system exists to detect.

use serde_json::Value;
use std::time::Duration;

/// How often to drain. The local emitter flushes every 30 s, so anything faster mostly polls an
/// empty queue; anything much slower lets a bounded queue overflow during a real incident.
const INTERVAL: Duration = Duration::from_secs(60);
/// Backoff after the coordinator says 429, or after a transport failure.
const BACKOFF: Duration = Duration::from_secs(300);
/// Match the backend's `LIMITS.MAX_BATCH` — a larger batch is rejected wholesale.
const MAX_BATCH: usize = 50;

/// What one cycle achieved, and whether the next one should wait longer.
#[derive(Debug, Default, PartialEq)]
pub struct Cycle {
    pub accepted: usize,
    /// Set when the coordinator rate-limited us or was unreachable. The loop honours it; ignoring a
    /// 429 and polling at the same rate would be exactly the client behaviour this system exists to
    /// detect.
    pub back_off: bool,
}

/// Drain the local queue once and forward it.
///
/// Public so it can be triggered directly (a test, or a "send diagnostics now" action) rather than
/// only on the timer.
pub async fn forward_once(agent: &str, coordinator: &str, token: &str) -> Cycle {
    let client = match reqwest::Client::builder().timeout(Duration::from_secs(15)).build() {
        Ok(c) => c,
        Err(_) => return Cycle::default(),
    };

    // 1. Drain. This is destructive on the agent side, so anything that goes wrong after here costs
    //    those events — see the resilience note above for why that is the accepted trade.
    let pending: Value = match client
        .get(format!("{}/nova/api/diagnostics/pending", agent.trim_end_matches('/')))
        .send()
        .await
    {
        Ok(r) => match r.json().await {
            Ok(v) => v,
            Err(_) => return Cycle::default(),
        },
        // Agent not up yet. Normal during startup, and NOT a reason to back off — the coordinator is
        // not the thing that failed.
        Err(_) => return Cycle::default(),
    };

    let events = match pending.get("events").and_then(|e| e.as_array()) {
        Some(e) if !e.is_empty() => e.clone(),
        _ => return Cycle::default(),
    };

    // 2. Forward in batches the backend will accept.
    let mut accepted = 0usize;
    let mut back_off = false;
    for chunk in events.chunks(MAX_BATCH) {
        let body = serde_json::json!({ "events": chunk });
        let res = client
            .post(format!("{}/nova/api/diagnostics/ingest", coordinator.trim_end_matches('/')))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await;

        match res {
            Ok(r) if r.status().as_u16() == 429 => {
                back_off = true;
                break;
            }
            Ok(r) if r.status().is_success() => {
                accepted += r
                    .json::<Value>()
                    .await
                    .ok()
                    .and_then(|v| v.get("accepted").and_then(|a| a.as_u64()))
                    .unwrap_or(0) as usize;
            }
            _ => {
                // Unreachable or rejected: stop this cycle, keep the launcher healthy, and slow down.
                back_off = true;
                break;
            }
        }
    }
    Cycle { accepted, back_off }
}

/// Start the background forwarder. Fire-and-forget; it lives for the process.
///
/// Takes the token by value because the caller's copy may be refreshed underneath us — a stale token
/// here costs one cycle of telemetry and nothing else, which is not worth a shared lock on the hot
/// path of a launcher.
pub fn spawn(agent: String, coordinator: String, token: String) {
    tauri::async_runtime::spawn(async move {
        loop {
            let cycle = forward_once(&agent, &coordinator, &token).await;
            // Quiet on success: this runs every minute forever, and a line per cycle would drown the
            // very diagnostics it is shipping. Only say something when there was something.
            if cycle.accepted > 0 {
                println!("[Diagnostics] forwarded {} event(s) to the coordinator", cycle.accepted);
            }
            tokio::time::sleep(if cycle.back_off { BACKOFF } else { INTERVAL }).await;
        }
    });
}

/// The Tauri command, so the UI can force a send (e.g. from the Self-check screen) without waiting
/// for the timer.
#[tauri::command]
pub async fn diagnostics_forward_now(
    agent: String,
    coordinator: String,
    token: String,
) -> Result<usize, String> {
    Ok(forward_once(&agent, &coordinator, &token).await.accepted)
}

/// Start the background forwarder. Called once by the UI after sign-in, when a token first exists.
///
/// Idempotent: a second call is ignored rather than starting a second loop, because the UI may
/// re-run its effects and two loops would double every batch.
#[tauri::command]
pub fn diagnostics_start_forwarding(agent: String, coordinator: String, token: String) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    spawn(agent, coordinator, token);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_size_matches_the_backend_limit() {
        // The backend truncates a batch at 50 (LIMITS.MAX_BATCH). Sending more would silently lose
        // the remainder, which is the worst possible failure mode for a diagnostics pipeline.
        assert_eq!(MAX_BATCH, 50);
    }

    #[test]
    fn a_missing_agent_is_not_an_error() {
        // The agent is often not up yet when the launcher starts. This must be a quiet no-op rather
        // than an error the user sees.
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let c = rt.block_on(forward_once("http://127.0.0.1:1", "http://127.0.0.1:1", "t"));
        assert_eq!(c.accepted, 0);
        assert!(!c.back_off, "an absent local agent is not the coordinator's fault");
    }

    #[test]
    fn backoff_is_longer_than_the_interval() {
        // Otherwise a coordinator that is rate-limiting us would be polled at the same rate anyway,
        // which is the behaviour the 429 is asking us to stop.
        assert!(BACKOFF > INTERVAL);
    }
}
