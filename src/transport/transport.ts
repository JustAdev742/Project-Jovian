// src/transport/transport.ts
// =============================================================================
// PROJECT NOVA — Phase 2/3: WebRTC Transport over simple-peer + SignallingBus.
//
// Drives simple-peer (a thin wrapper over RTCPeerConnection) using the
// SignallingBus for SDP/ICE exchange. This is where NAT traversal actually
// happens: simple-peer gathers ICE candidates against the STUN/TURN config
// from ice.ts, emits them via the bus, and the remote feeds them back in.
//
// Sequence to connect A -> B (caller = A, the initiator):
//   1. A builds a simple-peer Peer({ initiator:true, config: buildIceConfig() }).
//   2. simple-peer emits 'signal' events (offer SDP, then trickled ICE). A wraps
//      each as Signed<SignalEnvelope>{to:B} and publishes to nova/sig/<lobbyId>.
//   3. B is subscribed to the same topic; it filters for to===B, verifies the
//      signature, creates a non-initiator Peer, and peer.signal(data)s the offer.
//   4. B's simple-peer emits its answer + ICE -> published back addressed to A.
//   5. Both sides feed each received candidate into peer.signal(); ICE completes.
//   6. We open TWO DataChannels per peer: 'reliable' (ordered) + 'unreliable'
//      (maxRetransmits:0, unordered) per the contract Channel modes.
//
// simple-peer creates ONE default channel; for the second (unreliable) channel
// we use the underlying RTCPeerConnection directly once connected.
// =============================================================================

import SimplePeer from 'simple-peer';
import type {
  Transport,
  PeerConnection,
  Channel,
  PeerId,
  Signed,
  SignalEnvelope,
  SignallingBus,
  PubKeyHex,
} from '../shared/types.js';
import { buildIceConfig, type IceProfile } from './ice.js';

export interface TransportCrypto {
  sign: <T>(payload: T, pubkey: PubKeyHex) => Promise<Signed<T>>;
  self: { peerId: PeerId; pubkey: PubKeyHex };
}

interface PendingPeer {
  sp: SimplePeer.Instance;
  remote: PeerId;
}

export function createTransport(
  bus: SignallingBus,
  crypto: TransportCrypto,
  iceProfile: IceProfile = { forceRelay: false },
): Transport {
  const self = crypto.self.peerId;
  const peers = new Map<PeerId, PendingPeer>();
  const onPeerCbs = new Set<(c: PeerConnection) => void>();
  const subs: Array<() => void> = [];

  const sigTopic = (lobbyId: string) => `nova/sig/${lobbyId}`;

  /** Wrap + publish a single simple-peer signal blob, addressed to `to`. */
  async function emitSignal(lobbyId: string, to: PeerId, data: any) {
    const env: SignalEnvelope = {
      kind: data.type === 'offer' ? 'offer' : data.type === 'answer' ? 'answer' : 'ice',
      from: self,
      to,
      lobbyId,
      data,
    };
    const signed = await crypto.sign(env, crypto.self.pubkey);
    await bus.publish(sigTopic(lobbyId), signed);
  }

  /** Build a PeerConnection facade once simple-peer is connected. */
  function wrap(sp: SimplePeer.Instance, remote: PeerId): PeerConnection {
    // simple-peer's default channel is reliable+ordered. Open a second,
    // unreliable channel on the raw RTCPeerConnection for hot-path packets.
    const rawPc: RTCPeerConnection = (sp as any)._pc;
    const reliableDc: RTCDataChannel = (sp as any)._channel;
    const unreliableDc = rawPc.createDataChannel('unreliable', {
      ordered: false,
      maxRetransmits: 0,
    });

    const mkChannel = (dc: RTCDataChannel, mode: 'reliable' | 'unreliable'): Channel => {
      const handlers = new Set<(d: ArrayBuffer, from: PeerId) => void>();
      dc.binaryType = 'arraybuffer';
      dc.onmessage = (e) => {
        const buf = e.data instanceof ArrayBuffer ? e.data : new Uint8Array(e.data).buffer;
        for (const h of handlers) h(buf, remote);
      };
      return {
        mode,
        remote,
        send: (data) => {
          if (dc.readyState === 'open') dc.send(data);
        },
        onMessage: (h) => {
          handlers.add(h);
          return () => handlers.delete(h);
        },
        get bufferedAmount() {
          return dc.bufferedAmount;
        },
        close: () => dc.close(),
      };
    };

    const reliable = mkChannel(reliableDc, 'reliable');
    const unreliable = mkChannel(unreliableDc, 'unreliable');
    const closeCbs = new Set<(r: string) => void>();
    let rttMs = 0;

    // Sample smoothed RTT from RTCStats every second (feeds election + lag-comp).
    const statsTimer = setInterval(async () => {
      try {
        const stats = await rawPc.getStats();
        stats.forEach((r) => {
          if (r.type === 'candidate-pair' && (r as any).nominated && (r as any).currentRoundTripTime != null) {
            const sample = (r as any).currentRoundTripTime * 1000;
            rttMs = rttMs === 0 ? sample : rttMs * 0.8 + sample * 0.2; // EWMA
          }
        });
      } catch {
        /* stats unavailable */
      }
    }, 1000);

    sp.on('close', () => {
      clearInterval(statsTimer);
      for (const cb of closeCbs) cb('peer closed');
    });
    sp.on('error', (err) => {
      for (const cb of closeCbs) cb(`peer error: ${err.message}`);
    });

    return {
      remote,
      reliable,
      unreliable,
      get rttMs() {
        return rttMs;
      },
      onClose: (h) => {
        closeCbs.add(h);
        return () => closeCbs.delete(h);
      },
      close: () => {
        clearInterval(statsTimer);
        sp.destroy();
      },
    };
  }

  /** Common simple-peer wiring for both initiator and responder. */
  function bind(sp: SimplePeer.Instance, remote: PeerId, lobbyId: string): Promise<PeerConnection> {
    peers.set(remote, { sp, remote });
    sp.on('signal', (data: any) => void emitSignal(lobbyId, remote, data));
    return new Promise((resolve, reject) => {
      sp.on('connect', () => resolve(wrap(sp, remote)));
      sp.on('error', reject);
    });
  }

  // Single subscription per lobby would be ideal; we subscribe lazily on connect
  // and on onPeer registration. For brevity we subscribe per-connect lobby here.
  function ensureInboundSub(lobbyId: string) {
    const off = bus.subscribe<SignalEnvelope>(sigTopic(lobbyId), (msg) => {
      const env = msg.payload;
      if (env.to !== self) return;             // not addressed to us
      if (env.from === self) return;           // ignore our own echoes
      // Bind the signed author to the claimed `from` to stop spoofed candidates.
      if (msg.signer !== env.from) return;

      let pending = peers.get(env.from);
      if (!pending) {
        // Inbound dial: create a NON-initiator peer to answer.
        const sp = new SimplePeer({
          initiator: false,
          trickle: true,
          config: buildIceConfig(iceProfile),
        });
        pending = { sp, remote: env.from };
        peers.set(env.from, pending);
        sp.on('signal', (data: any) => void emitSignal(lobbyId, env.from, data));
        sp.on('connect', () => {
          const conn = wrap(sp, env.from);
          for (const cb of onPeerCbs) cb(conn);
        });
      }
      // Feed the SDP/ICE blob into simple-peer.
      try {
        pending.sp.signal(env.data as any);
      } catch {
        /* malformed signal */
      }
    });
    subs.push(off);
  }

  return {
    self,

    async connect(remote: PeerId, lobbyId: string): Promise<PeerConnection> {
      ensureInboundSub(lobbyId);
      const sp = new SimplePeer({
        initiator: true,
        trickle: true,                          // trickle ICE = faster connects
        config: buildIceConfig(iceProfile),
      });
      return bind(sp, remote, lobbyId);
    },

    onPeer(handler) {
      onPeerCbs.add(handler);
      return () => onPeerCbs.delete(handler);
    },

    close() {
      for (const off of subs) off();
      for (const { sp } of peers.values()) sp.destroy();
      peers.clear();
      onPeerCbs.clear();
    },
  };
}
