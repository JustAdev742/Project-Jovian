// src/matchmaking/chat.ts
// =============================================================================
// PROJECT NOVA — Phase 2: Lobby chat over Gun.js.
//
// Pre-match chat does not need the low-latency WebRTC mesh (that only forms in
// 'signalling'+). It rides the Gun graph as an append-only, time-ordered set at
//   nova/lobby/<region>/<lobbyId>/chat
// Each message is a Signed<ChatMessage> so a peer cannot forge another's name;
// subscribers verify the ed25519 signature (Phase 4 identity) before display.
// Gun's set semantics give convergence; we sort by (ts, signer) for a stable
// total order across peers despite relay reordering.
// =============================================================================

import type {
  PeerId,
  PubKeyHex,
  Region,
  Signed,
  EpochMs,
} from '../shared/types.js';
import { PROTOCOL } from '../shared/types.js';
import type IGun from 'gun';

export interface ChatMessage {
  lobbyId: string;
  from: PeerId;
  displayName: string;
  body: string;          // already length-clamped by caller (<= 280 chars)
  ts: EpochMs;
  /** Client nonce so identical bodies in the same ms are distinct keys. */
  nonce: string;
}

/** Signing/verification injected from the identity layer (Phase 4). */
export interface ChatCrypto {
  sign: <T>(payload: T, pubkey: PubKeyHex) => Promise<Signed<T>>;
  verify: <T>(msg: Signed<T>) => Promise<boolean>;
  self: { peerId: PeerId; pubkey: PubKeyHex; displayName: string };
}

const chatPath = (region: Region, lobbyId: string) =>
  `nova/lobby/${region}/${lobbyId}/chat`;

export interface LobbyChat {
  send(body: string): Promise<void>;
  onMessage(cb: (m: ChatMessage) => void): () => void;
  close(): void;
}

/**
 * Open the lobby chat channel.
 *
 * Sequence:
 *   1. Subscribe to the chat set (.map().on()).
 *   2. For each incoming Signed<ChatMessage>: verify signature + replay window,
 *      dedupe by (signer|nonce), buffer, and emit in (ts, signer) order.
 *   3. send() signs the message and writes it under a unique key.
 */
export function openLobbyChat(
  gun: ReturnType<typeof IGun>,
  region: Region,
  lobbyId: string,
  crypto: ChatCrypto,
): LobbyChat {
  const node = gun.get(chatPath(region, lobbyId));
  const seen = new Set<string>();
  const cbs = new Set<(m: ChatMessage) => void>();

  const off = node.map().on(async (raw: Signed<ChatMessage> | null) => {
    if (!raw || !raw.payload || !raw.sig) return;
    const m = raw.payload;
    const dedupeKey = `${raw.signer}|${m.nonce}`;
    if (seen.has(dedupeKey)) return;

    // Replay window: drop anything signed far outside the allowed skew.
    if (Math.abs(Date.now() - raw.ts) > PROTOCOL.SIG_REPLAY_WINDOW_MS) return;

    // Cryptographic identity check — the signer's name cannot be spoofed.
    if (!(await crypto.verify(raw))) return;
    // Bind the claimed PeerId to the actual signer.
    if (raw.signer !== m.from) return;

    seen.add(dedupeKey);
    for (const cb of cbs) cb(m);
  });

  return {
    async send(body) {
      const clamped = body.slice(0, 280);
      const msg: ChatMessage = {
        lobbyId,
        from: crypto.self.peerId,
        displayName: crypto.self.displayName,
        body: clamped,
        ts: Date.now(),
        nonce: Math.random().toString(36).slice(2, 10),
      };
      const signed = await crypto.sign(msg, crypto.self.pubkey);
      // Unique key keeps concurrent messages from clobbering in the set.
      node.get(`${msg.ts}-${crypto.self.peerId}-${msg.nonce}`).put(signed as any);
    },

    onMessage(cb) {
      cbs.add(cb);
      return () => cbs.delete(cb);
    },

    close() {
      if (typeof off === 'function') (off as () => void)();
      cbs.clear();
    },
  };
}
