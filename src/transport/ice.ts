// src/transport/ice.ts
// =============================================================================
// PROJECT NOVA — Phase 2: ICE configuration, TURN fallback, symmetric-NAT detect.
//
// All free, publicly-operated infra (zero project servers):
//   STUN : stun.l.google.com:19302 (+ a few Google mirrors) — reflexive addr.
//   TURN : openrelay.metered.ca — the most reliable currently-free open relay.
//          Falls back to a couple of other community relays. PLUG A CUSTOM ONE
//          in one line via addTurn() (see bottom).
//
// Symmetric NAT is the killer for P2P: it maps a DIFFERENT external port per
// destination, so the reflexive candidate gathered against STUN is useless for
// a third peer. We DETECT it heuristically from the candidate set and degrade:
//   - force iceTransportPolicy:'relay' (everything via TURN), and
//   - DEMOTE the peer from host eligibility (a symmetric-NAT authority cannot be
//     reliably dialed; election.ts should never put it at chain[0]).
// =============================================================================

/** Free, publicly-operated STUN servers (Google). */
export const STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

/**
 * Free/open TURN relays. openrelay.metered.ca publishes static creds and is the
 * most dependable no-cost option as of early 2026. These are best-effort,
 * shared, rate-limited — fine for an educational build, not production SLAs.
 */
export const TURN_SERVERS: RTCIceServer[] = [
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp', // last-resort TCP/443
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

/** Mutable pool so a custom relay can be injected at runtime (see addTurn). */
const customTurn: RTCIceServer[] = [];

/**
 * Plug a custom TURN relay in ONE line, e.g.:
 *   addTurn('turn:my.relay:3478', 'user', 'pass');
 */
export function addTurn(urls: string | string[], username: string, credential: string): void {
  customTurn.push({ urls, username, credential });
}

export interface IceProfile {
  /** When true: route everything through TURN (symmetric NAT / strict CG-NAT). */
  forceRelay: boolean;
}

/** Build the RTCConfiguration for a peer connection given its NAT profile. */
export function buildIceConfig(profile: IceProfile = { forceRelay: false }): RTCConfiguration {
  return {
    iceServers: [...STUN_SERVERS, ...TURN_SERVERS, ...customTurn],
    iceTransportPolicy: profile.forceRelay ? 'relay' : 'all',
    // Bundle + mux keep us to a single transport (lower CG-NAT port pressure).
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    iceCandidatePoolSize: 4,
  };
}

// -----------------------------------------------------------------------------
// Symmetric-NAT detection
// -----------------------------------------------------------------------------

interface ParsedCandidate {
  type: 'host' | 'srflx' | 'prflx' | 'relay';
  ip: string;
  port: number;
  relatedPort?: number;
}

/** Parse the fields we care about out of a raw ICE candidate line. */
function parseCandidate(line: string): ParsedCandidate | null {
  // candidate:... 1 udp <pri> <ip> <port> typ <type> [raddr <ip> rport <port>]
  const m = line.match(
    /candidate:\S+ \d+ \S+ \d+ (\S+) (\d+) typ (host|srflx|prflx|relay)(?:.*rport (\d+))?/,
  );
  if (!m) return null;
  return {
    ip: m[1],
    port: parseInt(m[2], 10),
    type: m[3] as ParsedCandidate['type'],
    relatedPort: m[4] ? parseInt(m[4], 10) : undefined,
  };
}

/**
 * Probe NAT behaviour by gathering candidates against TWO different STUN
 * servers and comparing the reflexive (srflx) external PORTS.
 *
 * Heuristic (the candidate-pattern test):
 *   - We open a throwaway RTCPeerConnection, gather host+srflx candidates.
 *   - If we get >=2 srflx candidates (from different STUN servers / mirrors)
 *     whose EXTERNAL PORTS DIFFER for the SAME local socket, the NAT is mapping
 *     per-destination => SYMMETRIC. A cone/port-restricted NAT keeps the same
 *     external port across destinations => srflx ports match.
 *   - No srflx at all (only host) usually means open/no-NAT or a blocked STUN.
 *
 * This is a heuristic, not RFC 5780 STUN behaviour discovery (which needs a
 * STUN server with the CHANGE-REQUEST attribute — Google's doesn't expose it),
 * but the differing-srflx-port signal is the reliable, browser-only tell.
 */
export async function detectSymmetricNat(timeoutMs = 3000): Promise<{
  symmetric: boolean;
  srflxPorts: number[];
  reason: string;
}> {
  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  });

  const srflxPorts: number[] = [];
  const srflxByRelated = new Map<number, Set<number>>(); // localPort -> ext ports

  return new Promise((resolve) => {
    const done = (symmetric: boolean, reason: string) => {
      pc.onicecandidate = null;
      pc.close();
      resolve({ symmetric, srflxPorts, reason });
    };

    const timer = setTimeout(() => {
      // Decide from whatever we gathered.
      decide();
    }, timeoutMs);

    const decide = () => {
      clearTimeout(timer);
      if (srflxPorts.length === 0) {
        return done(false, 'no srflx candidates (open NAT or STUN blocked)');
      }
      // Symmetric if any single local socket produced >1 distinct external port.
      for (const ports of srflxByRelated.values()) {
        if (ports.size > 1) {
          return done(true, 'differing external ports for same local socket');
        }
      }
      // Also symmetric if two srflx candidates differ in port with same IP.
      const uniquePorts = new Set(srflxPorts);
      const symmetric = uniquePorts.size > 1;
      done(
        symmetric,
        symmetric ? 'multiple distinct reflexive ports' : 'stable reflexive port',
      );
    };

    pc.onicecandidate = (ev) => {
      if (!ev.candidate) {
        // End-of-candidates marker.
        return decide();
      }
      const c = parseCandidate(ev.candidate.candidate);
      if (c && c.type === 'srflx') {
        srflxPorts.push(c.port);
        const local = c.relatedPort ?? 0;
        if (!srflxByRelated.has(local)) srflxByRelated.set(local, new Set());
        srflxByRelated.get(local)!.add(c.port);
      }
    };

    // Kick off gathering with a dummy data channel.
    pc.createDataChannel('nat-probe');
    pc.createOffer()
      .then((o) => pc.setLocalDescription(o))
      .catch(() => done(false, 'offer failed; assume non-symmetric'));
  });
}

/**
 * Convenience: turn a NAT probe into an IceProfile + host-eligibility flag the
 * matchmaking layer reads. Symmetric NAT => force relay AND demote from host.
 */
export async function profileNat(): Promise<{
  ice: IceProfile;
  hostEligible: boolean;
  detail: string;
}> {
  const r = await detectSymmetricNat();
  return {
    ice: { forceRelay: r.symmetric },
    hostEligible: !r.symmetric, // election.ts should skip non-eligible at chain[0]
    detail: r.reason,
  };
}
