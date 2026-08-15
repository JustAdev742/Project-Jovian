//! Reaching the coordinator when this PC's name resolution has been hijacked.
//!
//! WHY THIS EXISTS — the deadlock it breaks.
//!
//! The coordinator lives at a `*.ts.net` address. Tailscale, once installed, claims EVERY name under
//! that suffix and answers those lookups itself. That is fine while the machine is on the right
//! tailnet. It is fatal when it is not: Tailscale says "no such name" and never hands the question
//! back to normal DNS, so the address becomes unresolvable on that PC alone.
//!
//! It happened for real, and the shape of it is what makes it worth code rather than a support note:
//!
//!   1. Player uninstalls/reinstalls Tailscale and signs in with their own account
//!   2. That puts them on a fresh, empty personal tailnet — not Nova's
//!   3. Tailscale now hijacks the coordinator's name and has no answer for it
//!   4. The launcher cannot reach the coordinator
//!   5. So it cannot fetch a tailnet auth key
//!   6. So it can never rejoin the right tailnet — back to (3)
//!
//! The launcher already knows how to join the tailnet; it just could not reach the one server that
//! hands out the key. Every layer of that loop is doing its job, and the player is bricked with a
//! message blaming the servers, which are fine.
//!
//! THE WAY OUT is to stop depending on this PC's opinion of the name. When the OS resolver fails we
//! ask a public DNS-over-HTTPS resolver instead and connect straight to the address. DoH is the right
//! tool: it is a plain HTTPS request to a DIFFERENT hostname, so nothing about the local `.ts.net`
//! hijack can touch it.
//!
//! Deliberately NOT done here:
//!   * No writes to the hosts file, no registry edits, no touching Tailscale's config. Repairing the
//!     launcher must not mean editing the player's system behind their back — they may use Tailscale
//!     for other things, and a launcher that logs them out to fix itself is a worse bug.
//!   * TLS is still verified normally. Only the ADDRESS is overridden; the certificate is still
//!     checked against the real hostname, so this cannot be used to talk to an impostor.

use std::net::{IpAddr, SocketAddr};

/// Split a coordinator URL into (host, port). Defaults to 443 for https, 80 for http.
pub fn split_host_port(url: &str) -> Option<(String, u16)> {
    let rest = url
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    let authority = rest.split('/').next()?;
    if authority.is_empty() {
        return None;
    }
    let default_port = if url.trim_start().starts_with("http://") { 80 } else { 443 };
    match authority.rsplit_once(':') {
        Some((h, p)) => Some((h.to_string(), p.parse().unwrap_or(default_port))),
        None => Some((authority.to_string(), default_port)),
    }
}

/// Can the OPERATING SYSTEM resolve this name?
///
/// This is the question that matters, not whether some DNS server can: the launcher, the game and
/// every other program go through the OS resolver. `nslookup` talks to a DNS server directly and so
/// reports success on a machine where nothing else can resolve anything — which is exactly how this
/// class of fault hides.
pub fn os_can_resolve(host: &str, port: u16) -> bool {
    use std::net::ToSocketAddrs;
    let target = format!("{}:{}", host, port);
    std::thread::spawn(move || target.to_socket_addrs().map(|mut i| i.next().is_some()).unwrap_or(false))
        .join()
        .unwrap_or(false)
}

/// Ask a public DNS-over-HTTPS resolver for the addresses of `host`.
///
/// Queries by IP with an explicit Host header so this works even if the OS resolver is unhealthy in
/// general — otherwise we would be relying on the very thing we are routing around. Cloudflare is the
/// fallback so one provider being blocked is not fatal.
pub async fn resolve_via_doh(host: &str) -> Result<Vec<IpAddr>, String> {
    // (resolver address, Host header, path prefix)
    const RESOLVERS: [(&str, &str, &str); 2] = [
        ("8.8.8.8", "dns.google", "/resolve"),
        ("1.1.1.1", "cloudflare-dns.com", "/dns-query"),
    ];

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| format!("http client: {}", e))?;

    let mut last_err = String::new();
    for (ip, host_header, path) in RESOLVERS {
        let mut found: Vec<IpAddr> = Vec::new();
        // A and AAAA separately — some networks have one path working and not the other.
        for rtype in ["A", "AAAA"] {
            let url = format!("https://{}{}?name={}&type={}", ip, path, host, rtype);
            let res = client
                .get(&url)
                .header("host", host_header)
                .header("accept", "application/dns-json")
                .send()
                .await;
            let Ok(res) = res else {
                last_err = format!("{} unreachable", host_header);
                continue;
            };
            let Ok(v) = res.json::<serde_json::Value>().await else {
                last_err = format!("{} gave an unreadable answer", host_header);
                continue;
            };
            if let Some(answers) = v.get("Answer").and_then(|a| a.as_array()) {
                for a in answers {
                    if let Some(s) = a.get("data").and_then(|d| d.as_str()) {
                        if let Ok(parsed) = s.parse::<IpAddr>() {
                            found.push(parsed);
                        }
                    }
                }
            }
        }
        if !found.is_empty() {
            return Ok(found);
        }
    }
    Err(if last_err.is_empty() {
        "no public DNS record".to_string()
    } else {
        last_err
    })
}

/// An HTTP client that can reach `url` even if this PC cannot resolve its name.
///
/// Returns the client plus a note describing what had to be done, so callers can say so in a log
/// rather than silently papering over a broken machine.
///
/// The normal path costs nothing: if the OS resolves the name, this is a plain client and no DoH
/// request is made at all.
pub async fn resilient_client(url: &str) -> Result<(reqwest::Client, Option<String>), String> {
    let (host, port) = split_host_port(url).ok_or_else(|| format!("bad url: {}", url))?;

    if os_can_resolve(&host, port) {
        let c = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .map_err(|e| format!("http client: {}", e))?;
        return Ok((c, None));
    }

    // The OS cannot resolve it. Go around.
    let ips = resolve_via_doh(&host).await.map_err(|e| {
        format!(
            "this PC cannot look up {} ({}), and public DNS could not be reached either",
            host, e
        )
    })?;

    let mut builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(20));
    for ip in &ips {
        // Only the address is overridden. TLS still validates against the real hostname, so this
        // cannot be pointed at an impostor by a poisoned answer.
        builder = builder.resolve(&host, SocketAddr::new(*ip, port));
    }
    let c = builder.build().map_err(|e| format!("http client: {}", e))?;

    let note = format!(
        "This PC could not look up {} — something on it (usually Tailscale, when signed in to the \
         wrong account) is answering for that address and has no answer. Reached it directly at {} \
         instead.",
        host,
        ips.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(", ")
    );
    Ok((c, Some(note)))
}
