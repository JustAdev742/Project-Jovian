// src/signalling/nostrBus.ts
// =============================================================================
// PROJECT NOVA — Phase 2: Nostr signalling backend (alternative to Gun).
//
// Same SignallingBus contract, different transport. SDP/ICE ride Nostr
// ephemeral events (kind 20000, NIP per convention) tagged with the lobby +
// recipient, on public relays (damus / nos.lol / snort). Ephemeral kinds are
// not stored long-term by relays — perfect for transient signalling. Presence
// also uses kind 20000 (convention from the contract).
//
// IMPORTANT identity bridge: a Nostr event's `pubkey` IS the player's ed25519
// pubkey (hex), per conventions, so Nostr identity == Nova identity. We still
// carry our own Signed<T> envelope INSIDE the event content so the SAME
// verification path (canonical-JSON + replay window) applies regardless of bus.
// =============================================================================

import { SimplePool, type Event, type Filter } from 'nostr-tools';
import type {
  SignallingBus,
  Signed,
  PresenceInfo,
  PeerId,
} from '../shared/types.js';
import { PROTOCOL } from '../shared/types.js';

/** Public, free Nostr relays. */
export const NOSTR_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.snort.social',
];

const KIND_SIGNAL = 20000;   // ephemeral signalling + presence
const TOPIC_TAG = 't';       // we map a bus topic to a single-letter 't' tag

export interface NostrCrypto {
  verify: <T>(msg: Signed<T>) => Promise<boolean>;
  /** Sign a raw Nostr event (the player's ed25519 key, via nostr-tools). */
  signEvent: (evt: Partial<Event>) => Promise<Event>;
}

export function createNostrBus(crypto: NostrCrypto, relays = NOSTR_RELAYS): SignallingBus {
  const pool = new SimplePool();

  const verifyAndPass = async <T>(
    evt: Event,
    handler: (m: Signed<T>) => void,
  ) => {
    let raw: Signed<T>;
    try {
      raw = JSON.parse(evt.content) as Signed<T>;
    } catch {
      return;
    }
    if (!raw?.sig || !raw.payload) return;
    if (Math.abs(Date.now() - raw.ts) > PROTOCOL.SIG_REPLAY_WINDOW_MS) return;
    if (await crypto.verify(raw)) handler(raw);
  };

  return {
    async publish<T>(topic: string, msg: Signed<T>): Promise<void> {
      const evt = await crypto.signEvent({
        kind: KIND_SIGNAL,
        created_at: Math.floor(Date.now() / 1000),
        tags: [[TOPIC_TAG, topic]],
        content: JSON.stringify(msg),
      });
      // Publish to all relays; resolve when at least one accepts.
      await Promise.any(pool.publish(relays, evt));
    },

    subscribe<T>(topic: string, handler: (m: Signed<T>) => void): () => void {
      const filter: Filter = { kinds: [KIND_SIGNAL], '#t': [topic] };
      const sub = pool.subscribeMany(relays, [filter], {
        onevent: (evt) => verifyAndPass<T>(evt, handler),
      });
      return () => sub.close();
    },

    async announce(presence: Signed<PresenceInfo>): Promise<void> {
      const topic = `nova/presence/${presence.payload.lobbyId ?? 'global'}`;
      const evt = await crypto.signEvent({
        kind: KIND_SIGNAL,
        created_at: Math.floor(Date.now() / 1000),
        tags: [[TOPIC_TAG, topic]],
        content: JSON.stringify(presence),
      });
      await Promise.any(pool.publish(relays, evt));
    },

    async presence(topic: string): Promise<PresenceInfo[]> {
      const filter: Filter = { kinds: [KIND_SIGNAL], '#t': [topic] };
      const events = await pool.querySync(relays, filter);
      const out = new Map<PeerId, PresenceInfo>();
      for (const evt of events) {
        try {
          const raw = JSON.parse(evt.content) as Signed<PresenceInfo>;
          if (!(await crypto.verify(raw))) continue;
          const p = raw.payload;
          if (Date.now() - p.lastSeen <= PROTOCOL.PRESENCE_TTL_MS) out.set(p.peerId, p);
        } catch {
          /* skip malformed */
        }
      }
      return [...out.values()];
    },
  };
}
