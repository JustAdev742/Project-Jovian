// src/signalling/gunBus.ts
// =============================================================================
// PROJECT NOVA — Phase 2: Gun.js signalling backend (SDP/ICE exchange + presence).
//
// Implements the contract's SignallingBus over the Gun graph. SDP offers /
// answers / ICE candidates ride a per-lobby topic node:
//   nova/sig/<lobbyId>/<toPeerId>/<fromPeerId>/<seq>
// addressed mailbox-style so each recipient reads only messages FOR them. Every
// message is a Signed<SignalEnvelope>; subscribers verify before handing it up,
// so a relay (or a peer) cannot inject a forged candidate for someone else.
//
// Public relays only (zero project servers): gun-manhattan + community mirrors.
// =============================================================================

import Gun from 'gun';
import type {
  SignallingBus,
  Signed,
  PresenceInfo,
  PubKeyHex,
} from '../shared/types.js';
import { PROTOCOL } from '../shared/types.js';

/** Public, free Gun relay peers. */
export const GUN_RELAYS = [
  'https://gun-manhattan.herokuapp.com/gun',
  'https://gun-us.herokuapp.com/gun',
  'https://peer.wallie.io/gun',
];

/** Verification injected from identity layer so the bus stays crypto-agnostic. */
export interface BusCrypto {
  verify: <T>(msg: Signed<T>) => Promise<boolean>;
}

export function createGunBus(crypto: BusCrypto, relays = GUN_RELAYS): {
  bus: SignallingBus;
  gun: ReturnType<typeof Gun>;
} {
  const gun = Gun({ peers: relays, localStorage: false, radisk: false });

  const verifyAndPass = async <T>(
    raw: Signed<T> | null,
    handler: (m: Signed<T>) => void,
  ) => {
    if (!raw || !raw.sig || !raw.payload) return;
    if (Math.abs(Date.now() - raw.ts) > PROTOCOL.SIG_REPLAY_WINDOW_MS) return;
    if (await crypto.verify(raw)) handler(raw);
  };

  const bus: SignallingBus = {
    async publish<T>(topic: string, msg: Signed<T>): Promise<void> {
      return new Promise((resolve, reject) => {
        // Unique leaf key per message; Gun ack callback resolves on relay accept.
        const key = `${msg.ts}-${msg.signer}-${Math.random().toString(36).slice(2, 8)}`;
        gun
          .get(topic)
          .get(key)
          .put(msg as any, (ack: any) =>
            ack?.err ? reject(new Error(ack.err)) : resolve(),
          );
      });
    },

    subscribe<T>(topic: string, handler: (m: Signed<T>) => void): () => void {
      const ref = gun.get(topic).map();
      const off = ref.on((raw: Signed<T> | null) => verifyAndPass(raw, handler));
      return () => {
        if (typeof off === 'function') (off as () => void)();
      };
    },

    async announce(presence: Signed<PresenceInfo>): Promise<void> {
      const region = presence.payload.lobbyId ?? 'global';
      const topic = `nova/presence/${region}`;
      gun.get(topic).get(presence.signer).put(presence as any);
    },

    async presence(topic: string): Promise<PresenceInfo[]> {
      return new Promise((resolve) => {
        const out = new Map<string, PresenceInfo>();
        const ref = gun.get(topic).map();
        const off = ref.on(async (raw: Signed<PresenceInfo> | null) => {
          if (!raw || !raw.payload) return;
          if (!(await crypto.verify(raw))) return;
          const p = raw.payload;
          if (Date.now() - p.lastSeen <= PROTOCOL.PRESENCE_TTL_MS) {
            out.set(p.peerId, p);
          }
        });
        setTimeout(() => {
          if (typeof off === 'function') (off as () => void)();
          resolve([...out.values()]);
        }, 700);
      });
    },
  };

  return { bus, gun };
}
