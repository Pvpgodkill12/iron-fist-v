import { STAGES } from '../data/stages';
import type { StageId } from '../data/types';

const MQTT_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
] as const;

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

const PRESENCE_INTERVAL_MS = 1300;
const PEER_TTL_MS = 4500;
const PING_INTERVAL_MS = 1000;

export type OnlineLobbyPhase =
  | 'idle'
  | 'seeking'
  | 'map_vote'
  | 'char_select'
  | 'in_match';

export interface PeerSummary {
  id: string;
  lastSeenMs: number;
  active: boolean;
  seeking: boolean;
  inMatch: boolean;
  rtcConnected: boolean;
  pingMs: number;
}

export interface OnlineVoteState {
  sessionId: string;
  localSlot: 0 | 1;
  opponentId: string;
  mapOptions: [StageId, StageId];
  votes: [0 | 1 | null, 0 | 1 | null];
  tieSeed: number;
  winningMapIdx: 0 | 1 | null;
  wasTiebreaker: boolean;
  secondsLeft: number;
}

export interface OnlineCharSelectState {
  sessionId: string;
  localSlot: 0 | 1;
  opponentId: string;
  stageId: StageId;
  matchSeed: number;
  picks: [
    { charId: string; costume: 0 | 1; locked: boolean },
    { charId: string; costume: 0 | 1; locked: boolean },
  ];
}

export interface OnlineMatchLaunchParams {
  sessionId: string;
  localSlot: 0 | 1;
  opponentId: string;
  stageId: StageId;
  p1CharId: string;
  p1Costume: 0 | 1;
  p2CharId: string;
  p2Costume: 0 | 1;
  seed: number;
}

interface SignalEnvelope {
  mid: string;
  from: string;
  to?: string;
  room: string;
  kind: string;
  payload?: unknown;
}

/** Minimal zero-dependency MQTT 3.1.1 over WebSocket client (supports 1..4 byte varint lengths for WebRTC SDP) */
class MqttWsTransport {
  private ws: WebSocket | null = null;
  private connected = false;
  private disposed = false;
  private keepAliveTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private readonly url: string;
  private topic: string;
  private readonly clientId: string;
  private readonly onMessage: (jsonText: string) => void;

  constructor(url: string, topic: string, onMessage: (jsonText: string) => void) {
    this.url = url;
    this.topic = topic;
    this.clientId = `ifv_${Math.random().toString(36).slice(2, 10)}`;
    this.onMessage = onMessage;
    this.connect();
  }

  private encodeUtf8Field(str: string): Uint8Array {
    const bytes = new TextEncoder().encode(str);
    const out = new Uint8Array(2 + bytes.length);
    out[0] = (bytes.length >> 8) & 0xff;
    out[1] = bytes.length & 0xff;
    out.set(bytes, 2);
    return out;
  }

  private encodeRemainingLength(len: number): number[] {
    const out: number[] = [];
    let x = len;
    do {
      let digit = x % 128;
      x = Math.floor(x / 128);
      if (x > 0) digit |= 0x80;
      out.push(digit);
    } while (x > 0);
    return out;
  }

  private connect(): void {
    if (this.disposed || typeof WebSocket === 'undefined') return;
    try {
      const ws = new WebSocket(this.url, 'mqtt');
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      ws.onopen = () => {
        if (this.disposed) {
          ws.close();
          return;
        }
        const proto = this.encodeUtf8Field('MQTT');
        const cid = this.encodeUtf8Field(this.clientId);
        const bodyLen = proto.length + 4 + cid.length;
        const rem = this.encodeRemainingLength(bodyLen);
        const pkt = new Uint8Array(1 + rem.length + bodyLen);
        let o = 0;
        pkt[o++] = 0x10; // CONNECT
        for (const b of rem) pkt[o++] = b;
        pkt.set(proto, o);
        o += proto.length;
        pkt[o++] = 4; // MQTT 3.1.1
        pkt[o++] = 0x02; // Clean session
        pkt[o++] = 0;
        pkt[o++] = 45; // Keepalive 45s
        pkt.set(cid, o);
        ws.send(pkt);
      };

      ws.onmessage = (ev) => {
        if (!(ev.data instanceof ArrayBuffer)) return;
        const buf = new Uint8Array(ev.data);
        let pos = 0;
        while (pos < buf.length) {
          const header = buf[pos++];
          let mul = 1;
          let remLen = 0;
          while (pos < buf.length) {
            const d = buf[pos++];
            remLen += (d & 0x7f) * mul;
            if ((d & 0x80) === 0) break;
            mul *= 128;
          }
          if (pos + remLen > buf.length) break;
          const type = header & 0xf0;
          if (type === 0x20) {
            // CONNACK -> Subscribe to room topic
            this.connected = true;
            this.sendSubscribe(this.topic);
            if (this.keepAliveTimer !== null) clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = window.setInterval(() => {
              if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(new Uint8Array([0xc0, 0x00])); // PINGREQ
              }
            }, 25000);
          } else if (type === 0x30) {
            // PUBLISH
            const tLen = (buf[pos] << 8) | buf[pos + 1];
            const qos = (header >> 1) & 0x03;
            const pktIdBytes = qos > 0 ? 2 : 0;
            const payloadStart = pos + 2 + tLen + pktIdBytes;
            const payloadEnd = pos + remLen;
            if (payloadStart <= payloadEnd) {
              const text = new TextDecoder().decode(buf.subarray(payloadStart, payloadEnd));
              this.onMessage(text);
            }
          }
          pos += remLen;
        }
      };

      const scheduleReconnect = () => {
        this.connected = false;
        if (this.keepAliveTimer !== null) {
          clearInterval(this.keepAliveTimer);
          this.keepAliveTimer = null;
        }
        if (!this.disposed && this.reconnectTimer === null) {
          this.reconnectTimer = window.setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
          }, 2200);
        }
      };

      ws.onclose = scheduleReconnect;
      ws.onerror = () => {
        try {
          ws.close();
        } catch {
          // ignore
        }
      };
    } catch {
      // Ignore sandboxed iframe environments without WebSocket network permission
    }
  }

  private sendSubscribe(topic: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const tf = this.encodeUtf8Field(topic);
    const bodyLen = 2 + tf.length + 1;
    const rem = this.encodeRemainingLength(bodyLen);
    const pkt = new Uint8Array(1 + rem.length + bodyLen);
    let o = 0;
    pkt[o++] = 0x82; // SUBSCRIBE
    for (const b of rem) pkt[o++] = b;
    pkt[o++] = 0x00;
    pkt[o++] = 0x01;
    pkt.set(tf, o);
    o += tf.length;
    pkt[o] = 0x00; // QoS 0
    this.ws.send(pkt);
  }

  switchTopic(nextTopic: string): void {
    if (this.topic === nextTopic) return;
    this.topic = nextTopic;
    if (this.connected) {
      this.sendSubscribe(nextTopic);
    }
  }

  publish(jsonText: string): void {
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const tf = this.encodeUtf8Field(this.topic);
    const pl = new TextEncoder().encode(jsonText);
    const bodyLen = tf.length + pl.length;
    const rem = this.encodeRemainingLength(bodyLen);
    const pkt = new Uint8Array(1 + rem.length + bodyLen);
    let o = 0;
    pkt[o++] = 0x30; // PUBLISH QoS 0
    for (const b of rem) pkt[o++] = b;
    pkt.set(tf, o);
    o += tf.length;
    pkt.set(pl, o);
    try {
      this.ws.send(pkt);
    } catch {
      // ignore transient socket error
    }
  }

  get isConnected(): boolean {
    return this.connected;
  }

  dispose(): void {
    this.disposed = true;
    if (this.keepAliveTimer !== null) clearInterval(this.keepAliveTimer);
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
  }
}

interface RtcLink {
  peerId: string;
  pc: RTCPeerConnection;
  ctrl: RTCDataChannel | null;
  udp: RTCDataChannel | null;
  pingMs: number;
  lastPingSentMs: number;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

function base64ToUint8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

/**
 * Serverless $0 WebRTC + Multi-Relay Online Coordinator for IRON FIST V.
 */
export class OnlineCoordinator {
  readonly myId: string;
  private roomCode = 'PUBLIC';
  private phase: OnlineLobbyPhase = 'idle';

  private readonly relays: MqttWsTransport[] = [];
  private bc: BroadcastChannel | null = null;
  private readonly seenMids = new Set<string>();
  private readonly seenMidQueue: string[] = [];

  private readonly peers = new Map<string, PeerSummary>();
  private readonly rtcLinks = new Map<string, RtcLink>();

  private pendingInviteFrom: string | null = null;
  private pendingInviteTo: string | null = null;

  private voteState: OnlineVoteState | null = null;
  private voteCountdownTimer: number | null = null;
  private voteAdvanceTimer: number | null = null;

  private charState: OnlineCharSelectState | null = null;
  private activeOpponentId: string | null = null;
  private rematchReady: [boolean, boolean] = [false, false];

  onStatusChange: (() => void) | null = null;
  onIncomingInvite: ((fromPeerId: string, pingMs: number) => void) | null = null;
  onInviteCleared: ((reason?: string) => void) | null = null;
  onVoteStateUpdate: ((state: OnlineVoteState) => void) | null = null;
  onCharSelectUpdate: ((state: OnlineCharSelectState) => void) | null = null;
  onMatchLaunch: ((params: OnlineMatchLaunchParams) => void) | null = null;
  onUdpFrame: ((bytes: Uint8Array) => void) | null = null;
  onRematchStatus: ((myReady: boolean, oppReady: boolean) => void) | null = null;
  onReturnToCharSelect: (() => void) | null = null;
  onOpponentLeft: (() => void) | null = null;

  private presenceTimer: number | null = null;
  private pingTimer: number | null = null;

  constructor() {
    this.myId = `p_${Math.random().toString(36).slice(2, 10)}`;
    if (typeof window === 'undefined') return;

    const topic = this.topicForRoom(this.roomCode);
    for (const url of MQTT_BROKERS) {
      this.relays.push(new MqttWsTransport(url, topic, (txt) => this.handleRawSignal(txt)));
    }

    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.bc = new BroadcastChannel('ironfist-v-lobby-v1');
        this.bc.onmessage = (ev) => {
          if (typeof ev.data === 'string') this.handleRawSignal(ev.data);
        };
      } catch {
        this.bc = null;
      }
    }

    window.addEventListener('visibilitychange', () => {
      this.broadcastPresence();
      this.notifyStatus();
    });
    window.addEventListener('pagehide', () => this.broadcastLeave());
    window.addEventListener('beforeunload', () => this.broadcastLeave());

    this.presenceTimer = window.setInterval(() => {
      this.pruneStalePeers();
      this.broadcastPresence();
    }, PRESENCE_INTERVAL_MS);

    this.pingTimer = window.setInterval(() => {
      this.sendPings();
    }, PING_INTERVAL_MS);

    window.setTimeout(() => this.broadcastPresence(), 120);
  }

  private topicForRoom(room: string): string {
    return `ironfistv/v1/room/${room.toUpperCase()}`;
  }

  get currentRoom(): string {
    return this.roomCode;
  }

  get lobbyPhase(): OnlineLobbyPhase {
    return this.phase;
  }

  setRoomCode(code: string): void {
    const clean = (code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || 'PUBLIC').slice(0, 8);
    if (clean === this.roomCode) return;
    this.broadcastLeave();
    this.cancelSessionToIdle();
    for (const [, link] of this.rtcLinks) {
      try {
        link.pc.close();
      } catch {
        // ignore
      }
    }
    this.rtcLinks.clear();
    this.peers.clear();
    this.roomCode = clean;
    const topic = this.topicForRoom(clean);
    for (const r of this.relays) r.switchTopic(topic);
    this.broadcastPresence();
    this.notifyStatus();
  }

  isLocalTabActive(): boolean {
    if (typeof document === 'undefined') return true;
    return document.visibilityState !== 'hidden';
  }

  /** Returns active available remote players in the current room (excluding ourselves) */
  getAvailablePeers(): PeerSummary[] {
    const now = Date.now();
    const out: PeerSummary[] = [];
    for (const [, p] of this.peers) {
      if (p.active && !p.inMatch && now - p.lastSeenMs <= PEER_TTL_MS) {
        out.push(p);
      }
    }
    out.sort((a, b) => Number(b.rtcConnected) - Number(a.rtcConnected) || a.id.localeCompare(b.id));
    return out;
  }

  /** Total active players in room including ourselves (must be >= 2 to unlock Multiplayer!) */
  getActivePlayerCount(): number {
    const selfCount = this.isLocalTabActive() ? 1 : 0;
    return selfCount + this.getAvailablePeers().length;
  }

  isMultiplayerReady(): boolean {
    return this.isLocalTabActive() && this.getAvailablePeers().length >= 1;
  }

  getBestOpponentPingMs(): number {
    if (this.activeOpponentId) {
      const link = this.rtcLinks.get(this.activeOpponentId);
      if (link && link.pingMs > 0) return Math.round(link.pingMs);
    }
    const avail = this.getAvailablePeers();
    for (const p of avail) {
      const link = this.rtcLinks.get(p.id);
      if (link && link.pingMs > 0) return Math.round(link.pingMs);
      if (p.pingMs > 0) return Math.round(p.pingMs);
    }
    return 0;
  }

  isDirectP2PActive(): boolean {
    if (!this.activeOpponentId) {
      return this.getAvailablePeers().some((p) => p.rtcConnected);
    }
    const link = this.rtcLinks.get(this.activeOpponentId);
    return link?.udp?.readyState === 'open' || link?.ctrl?.readyState === 'open';
  }

  isRelayConnected(): boolean {
    return this.bc !== null || this.relays.some((r) => r.isConnected);
  }

  /**
   * Called when user clicks the unlocked MULTIPLAYER button:
   * - If an opponent already invited us OR is already seeking (`seeking === true`), pairs IMMEDIATELY!
   * - Otherwise sends a live `challenge_invite` popup to the active opponent AND enters `seeking` queue!
   */
  clickMultiplayer(): 'matched' | 'invited' | 'unavailable' {
    const avail = this.getAvailablePeers();
    if (avail.length === 0) return 'unavailable';

    // 1. If we already have a pending invite from an available peer, accept immediately!
    if (this.pendingInviteFrom && avail.some((p) => p.id === this.pendingInviteFrom)) {
      const challenger = this.pendingInviteFrom;
      this.pendingInviteFrom = null;
      this.acceptChallengeFrom(challenger);
      return 'matched';
    }

    // 2. If another active peer is ALREADY clicking/seeking Multiplayer, pair immediately!
    const seeker = avail.find((p) => p.seeking);
    if (seeker) {
      this.startSyncedSessionAsHost(seeker.id);
      return 'matched';
    }

    // 3. Otherwise send live Challenge Toast to the best active opponent & wait!
    const target = avail[0];
    this.phase = 'seeking';
    this.pendingInviteTo = target.id;
    this.sendControlOrSignal(target.id, 'challenge_invite', { pingMs: this.getBestOpponentPingMs() });
    this.broadcastPresence();
    this.notifyStatus();
    return 'invited';
  }

  acceptIncomingInvite(): void {
    if (!this.pendingInviteFrom) return;
    const challenger = this.pendingInviteFrom;
    this.pendingInviteFrom = null;
    this.acceptChallengeFrom(challenger);
  }

  declineIncomingInvite(): void {
    if (!this.pendingInviteFrom) return;
    const challenger = this.pendingInviteFrom;
    this.pendingInviteFrom = null;
    this.sendControlOrSignal(challenger, 'challenge_decline', {});
    this.onInviteCleared?.('declined');
    this.notifyStatus();
  }

  cancelSeekingOrSession(): void {
    if (this.pendingInviteTo) {
      this.sendControlOrSignal(this.pendingInviteTo, 'challenge_cancel', {});
      this.pendingInviteTo = null;
    }
    if (this.activeOpponentId) {
      this.sendControlOrSignal(this.activeOpponentId, 'session_leave', {});
    }
    this.cancelSessionToIdle();
    this.broadcastPresence();
    this.notifyStatus();
  }

  private acceptChallengeFrom(challengerId: string): void {
    this.onInviteCleared?.();
    // Challenger becomes Slot 0 (P1) and Acceptor becomes Slot 1 (P2), Challenger hosts session seed
    this.activeOpponentId = challengerId;
    this.sendControlOrSignal(challengerId, 'challenge_accept', {});
  }

  private startSyncedSessionAsHost(guestId: string): void {
    this.pendingInviteTo = null;
    this.pendingInviteFrom = null;
    this.onInviteCleared?.();
    this.activeOpponentId = guestId;

    // Pick 2 distinct random maps out of STAGES (guaranteed 2 random options!)
    const indices = STAGES.map((_, i) => i);
    const i0 = Math.floor(Math.random() * indices.length);
    const firstIdx = indices.splice(i0, 1)[0];
    const secondIdx = indices[Math.floor(Math.random() * indices.length)];
    const mapOptions: [StageId, StageId] = [STAGES[firstIdx].id, STAGES[secondIdx].id];
    const tieSeed = ((Math.random() * 0x7fffffff) | 0) >>> 0;
    const sessionId = `ses_${Math.random().toString(36).slice(2, 9)}`;

    this.enterMapVote({
      sessionId,
      localSlot: 0,
      opponentId: guestId,
      mapOptions,
      tieSeed,
    });

    this.sendControlOrSignal(guestId, 'session_start', {
      sessionId,
      hostId: this.myId,
      mapOptions,
      tieSeed,
    });
  }

  private enterMapVote(init: {
    sessionId: string;
    localSlot: 0 | 1;
    opponentId: string;
    mapOptions: [StageId, StageId];
    tieSeed: number;
  }): void {
    this.clearVoteTimers();
    this.phase = 'map_vote';
    this.activeOpponentId = init.opponentId;
    this.voteState = {
      sessionId: init.sessionId,
      localSlot: init.localSlot,
      opponentId: init.opponentId,
      mapOptions: init.mapOptions,
      votes: [null, null],
      tieSeed: init.tieSeed,
      winningMapIdx: null,
      wasTiebreaker: false,
      secondsLeft: 15,
    };
    this.broadcastPresence();
    this.notifyStatus();
    this.onVoteStateUpdate?.(this.voteState);

    this.voteCountdownTimer = window.setInterval(() => {
      if (!this.voteState || this.voteState.winningMapIdx !== null) return;
      this.voteState.secondsLeft = Math.max(0, this.voteState.secondsLeft - 1);
      if (this.voteState.secondsLeft <= 0) {
        // Auto-cast local vote if timer expires so match never hangs
        if (this.voteState.votes[this.voteState.localSlot] === null) {
          this.submitMapVote((this.voteState.tieSeed & 1) as 0 | 1);
        }
        // Also fill remote default if packet delayed at 0s
        const remSlot: 0 | 1 = this.voteState.localSlot === 0 ? 1 : 0;
        if (this.voteState.votes[remSlot] === null) {
          this.voteState.votes[remSlot] = ((this.voteState.tieSeed >> 1) & 1) as 0 | 1;
          this.checkResolveMapVote();
        }
      } else {
        this.onVoteStateUpdate?.(this.voteState);
      }
    }, 1000);
  }

  submitMapVote(choiceIdx: 0 | 1): void {
    if (!this.voteState || this.voteState.winningMapIdx !== null) return;
    const slot = this.voteState.localSlot;
    this.voteState.votes[slot] = choiceIdx;
    this.sendControlOrSignal(this.voteState.opponentId, 'map_vote', {
      sessionId: this.voteState.sessionId,
      slot,
      choiceIdx,
    });
    this.onVoteStateUpdate?.(this.voteState);
    this.checkResolveMapVote();
  }

  private checkResolveMapVote(): void {
    const v = this.voteState;
    if (!v || v.winningMapIdx !== null) return;
    const v0 = v.votes[0];
    const v1 = v.votes[1];
    if (v0 === null || v1 === null) return;

    if (v0 === v1) {
      v.winningMapIdx = v0;
      v.wasTiebreaker = false;
    } else {
      v.winningMapIdx = (v.tieSeed & 1) as 0 | 1;
      v.wasTiebreaker = true;
    }

    if (this.voteCountdownTimer !== null) {
      clearInterval(this.voteCountdownTimer);
      this.voteCountdownTimer = null;
    }
    this.onVoteStateUpdate?.(v);

    const wonStageId = v.mapOptions[v.winningMapIdx];
    this.voteAdvanceTimer = window.setTimeout(() => {
      this.enterCharSelect(v.sessionId, v.localSlot, v.opponentId, wonStageId, v.tieSeed ^ 0x5a5a5a5a);
    }, 1250);
  }

  private enterCharSelect(
    sessionId: string,
    localSlot: 0 | 1,
    opponentId: string,
    stageId: StageId,
    matchSeed: number,
  ): void {
    this.clearVoteTimers();
    this.phase = 'char_select';
    this.rematchReady = [false, false];
    this.charState = {
      sessionId,
      localSlot,
      opponentId,
      stageId,
      matchSeed: matchSeed >>> 0,
      picks: [
        { charId: 'jinrai', costume: 0, locked: false },
        { charId: 'kazuma', costume: 0, locked: false },
      ],
    };
    this.notifyStatus();
    this.onCharSelectUpdate?.(this.charState);
  }

  updateMyCharacterSelection(charId: string, costume: 0 | 1, locked: boolean): void {
    if (!this.charState) return;
    const slot = this.charState.localSlot;
    this.charState.picks[slot] = { charId, costume, locked };
    this.sendControlOrSignal(this.charState.opponentId, 'char_pick', {
      sessionId: this.charState.sessionId,
      slot,
      charId,
      costume,
      locked,
    });
    this.onCharSelectUpdate?.(this.charState);
    this.checkLaunchFromCharSelect();
  }

  private checkLaunchFromCharSelect(): void {
    const cs = this.charState;
    if (!cs) return;
    const [p1, p2] = cs.picks;
    if (!p1.locked || !p2.locked) return;

    const finalP2Costume: 0 | 1 =
      p1.charId === p2.charId && p1.costume === p2.costume
        ? p1.costume === 0
          ? 1
          : 0
        : p2.costume;

    this.phase = 'in_match';
    this.rematchReady = [false, false];
    this.broadcastPresence();
    this.notifyStatus();

    this.onMatchLaunch?.({
      sessionId: cs.sessionId,
      localSlot: cs.localSlot,
      opponentId: cs.opponentId,
      stageId: cs.stageId,
      p1CharId: p1.charId,
      p1Costume: p1.costume,
      p2CharId: p2.charId,
      p2Costume: finalP2Costume,
      seed: cs.matchSeed,
    });
  }

  requestOnlineRematch(): void {
    if (!this.charState || !this.activeOpponentId) return;
    const slot = this.charState.localSlot;
    this.rematchReady[slot] = true;
    this.sendControlOrSignal(this.activeOpponentId, 'rematch_vote', {
      sessionId: this.charState.sessionId,
      slot,
    });
    this.onRematchStatus?.(this.rematchReady[slot], this.rematchReady[slot === 0 ? 1 : 0]);
    this.checkStartRematch();
  }

  requestReturnToOnlineCharSelect(): void {
    if (!this.charState || !this.activeOpponentId) return;
    this.sendControlOrSignal(this.activeOpponentId, 'back_to_char_select', {
      sessionId: this.charState.sessionId,
    });
    this.enterCharSelect(
      this.charState.sessionId,
      this.charState.localSlot,
      this.charState.opponentId,
      this.charState.stageId,
      (this.charState.matchSeed + 1013904223) >>> 0,
    );
    this.onReturnToCharSelect?.();
  }

  private checkStartRematch(): void {
    if (!this.charState || !this.rematchReady[0] || !this.rematchReady[1]) return;
    this.charState.matchSeed = (this.charState.matchSeed + 1664525) >>> 0;
    this.rematchReady = [false, false];
    this.checkLaunchFromCharSelect();
  }

  /** Sends a 28-byte binary Rollback Input Packet over Unreliable WebRTC UDP DataChannel (with zero-drop fallback) */
  sendUdpInputPacket(packet: Uint8Array): void {
    if (!this.activeOpponentId) return;
    const link = this.rtcLinks.get(this.activeOpponentId);
    if (link?.udp && link.udp.readyState === 'open') {
      try {
        link.udp.send(packet as Uint8Array<ArrayBuffer>);
        return;
      } catch {
        // Fall through to relay backup
      }
    }
    this.publishEnvelope({
      mid: this.nextMid(),
      from: this.myId,
      to: this.activeOpponentId,
      room: this.roomCode,
      kind: 'udp_b64',
      payload: uint8ToBase64(packet),
    });
  }

  // ==================== INTERNAL SIGNALING & WEBRTC P2P ====================

  private nextMid(): string {
    return `${this.myId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }

  private publishEnvelope(env: SignalEnvelope): void {
    const txt = JSON.stringify(env);
    this.bc?.postMessage(txt);
    for (const r of this.relays) r.publish(txt);
  }

  private sendControlOrSignal(toPeerId: string, kind: string, payload: unknown): void {
    const mid = this.nextMid();
    const link = this.rtcLinks.get(toPeerId);
    if (link?.ctrl && link.ctrl.readyState === 'open') {
      try {
        link.ctrl.send(JSON.stringify({ mid, from: this.myId, to: toPeerId, room: this.roomCode, kind, payload }));
        return;
      } catch {
        // Fall back to signaling relay
      }
    }
    this.publishEnvelope({ mid, from: this.myId, to: toPeerId, room: this.roomCode, kind, payload });
  }

  private broadcastPresence(): void {
    this.publishEnvelope({
      mid: this.nextMid(),
      from: this.myId,
      room: this.roomCode,
      kind: 'presence',
      payload: {
        active: this.isLocalTabActive(),
        seeking: this.phase === 'seeking',
        inMatch: this.phase === 'map_vote' || this.phase === 'char_select' || this.phase === 'in_match',
      },
    });
  }

  private broadcastLeave(): void {
    this.publishEnvelope({
      mid: this.nextMid(),
      from: this.myId,
      room: this.roomCode,
      kind: 'presence',
      payload: { active: false, seeking: false, inMatch: false },
    });
  }

  private pruneStalePeers(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, p] of this.peers) {
      if (now - p.lastSeenMs > PEER_TTL_MS) {
        this.peers.delete(id);
        changed = true;
        if (this.pendingInviteFrom === id) {
          this.pendingInviteFrom = null;
          this.onInviteCleared?.('expired');
        }
        if (this.activeOpponentId === id && this.phase !== 'idle') {
          this.cancelSessionToIdle();
          this.onOpponentLeft?.();
        }
      }
    }
    if (changed) this.notifyStatus();
  }

  private sendPings(): void {
    const now = Date.now();
    for (const [peerId, link] of this.rtcLinks) {
      if (link.ctrl?.readyState === 'open') {
        link.lastPingSentMs = now;
        try {
          link.ctrl.send(
            JSON.stringify({
              mid: this.nextMid(),
              from: this.myId,
              to: peerId,
              room: this.roomCode,
              kind: 'ping',
              payload: now,
            }),
          );
        } catch {
          // ignore
        }
      }
    }
  }

  private handleRawSignal(rawText: string): void {
    let env: SignalEnvelope;
    try {
      env = JSON.parse(rawText) as SignalEnvelope;
    } catch {
      return;
    }
    if (!env || !env.mid || !env.from || env.from === this.myId) return;
    if (env.room !== this.roomCode) return;
    if (env.to && env.to !== this.myId) return;

    if (this.seenMids.has(env.mid)) return;
    this.seenMids.add(env.mid);
    this.seenMidQueue.push(env.mid);
    if (this.seenMidQueue.length > 512) {
      const oldest = this.seenMidQueue.shift()!;
      this.seenMids.delete(oldest);
    }

    this.dispatchMessage(env);
  }

  private dispatchMessage(env: SignalEnvelope): void {
    const from = env.from;
    const now = Date.now();

    if (env.kind === 'presence') {
      const pl = env.payload as { active: boolean; seeking: boolean; inMatch: boolean };
      const prev = this.peers.get(from);
      const link = this.rtcLinks.get(from);
      const rtcUp = Boolean(link && (link.ctrl?.readyState === 'open' || link.udp?.readyState === 'open'));

      if (!pl.active) {
        if (this.peers.delete(from)) {
          if (this.pendingInviteFrom === from) {
            this.pendingInviteFrom = null;
            this.onInviteCleared?.('offline');
          }
          this.notifyStatus();
        }
        return;
      }

      this.peers.set(from, {
        id: from,
        lastSeenMs: now,
        active: pl.active,
        seeking: pl.seeking,
        inMatch: pl.inMatch,
        rtcConnected: rtcUp,
        pingMs: link?.pingMs ?? prev?.pingMs ?? 0,
      });

      // Deterministic WebRTC initiator (`myId < from`) establishes direct P2P channels immediately!
      if (!link && this.isLocalTabActive() && !pl.inMatch && this.myId < from) {
        void this.initiateWebRtc(from);
      }

      // If BOTH players are currently in `seeking` mode, lower ID immediately hosts the synced match!
      if (this.phase === 'seeking' && pl.seeking && !pl.inMatch && this.myId < from) {
        this.startSyncedSessionAsHost(from);
      }

      this.notifyStatus();
      return;
    }

    // Touch peer timestamp on any valid direct packet
    const existingPeer = this.peers.get(from);
    if (existingPeer) existingPeer.lastSeenMs = now;

    switch (env.kind) {
      case 'rtc_offer':
        void this.handleRtcOffer(from, env.payload as RTCSessionDescriptionInit);
        break;
      case 'rtc_answer':
        void this.handleRtcAnswer(from, env.payload as RTCSessionDescriptionInit);
        break;
      case 'rtc_ice':
        void this.handleRtcIce(from, env.payload as RTCIceCandidateInit);
        break;
      case 'ping':
        this.sendControlOrSignal(from, 'pong', env.payload);
        break;
      case 'pong': {
        const sentAt = Number(env.payload);
        if (Number.isFinite(sentAt) && sentAt > 0) {
          const rtt = Math.max(1, Date.now() - sentAt);
          const link = this.rtcLinks.get(from);
          if (link) link.pingMs = link.pingMs > 0 ? link.pingMs * 0.65 + rtt * 0.35 : rtt;
          const p = this.peers.get(from);
          if (p) p.pingMs = link?.pingMs ?? rtt;
          this.notifyStatus();
        }
        break;
      }
      case 'challenge_invite': {
        if (this.phase === 'seeking') {
          // Both players clicked MULTIPLAYER -> Instant match!
          if (this.myId < from) {
            this.startSyncedSessionAsHost(from);
          } else {
            this.acceptChallengeFrom(from);
          }
          return;
        }
        if (this.phase !== 'idle' || !this.isLocalTabActive()) return;
        this.pendingInviteFrom = from;
        const ping = this.rtcLinks.get(from)?.pingMs ?? 0;
        this.onIncomingInvite?.(from, Math.round(ping));
        break;
      }
      case 'challenge_accept': {
        if (this.phase === 'seeking' || this.pendingInviteTo === from) {
          this.startSyncedSessionAsHost(from);
        }
        break;
      }
      case 'challenge_decline':
      case 'challenge_cancel': {
        if (this.pendingInviteFrom === from) {
          this.pendingInviteFrom = null;
          this.onInviteCleared?.('cancelled');
        }
        if (this.pendingInviteTo === from) {
          this.pendingInviteTo = null;
          this.phase = 'idle';
          this.broadcastPresence();
          this.notifyStatus();
        }
        break;
      }
      case 'session_start': {
        const pl = env.payload as {
          sessionId: string;
          mapOptions: [StageId, StageId];
          tieSeed: number;
        };
        this.pendingInviteTo = null;
        this.pendingInviteFrom = null;
        this.onInviteCleared?.();
        this.enterMapVote({
          sessionId: pl.sessionId,
          localSlot: 1,
          opponentId: from,
          mapOptions: pl.mapOptions,
          tieSeed: pl.tieSeed,
        });
        break;
      }
      case 'map_vote': {
        const pl = env.payload as { sessionId: string; slot: 0 | 1; choiceIdx: 0 | 1 };
        if (!this.voteState || this.voteState.sessionId !== pl.sessionId) return;
        this.voteState.votes[pl.slot] = pl.choiceIdx;
        this.onVoteStateUpdate?.(this.voteState);
        this.checkResolveMapVote();
        break;
      }
      case 'char_pick': {
        const pl = env.payload as {
          sessionId: string;
          slot: 0 | 1;
          charId: string;
          costume: 0 | 1;
          locked: boolean;
        };
        if (!this.charState || this.charState.sessionId !== pl.sessionId) return;
        this.charState.picks[pl.slot] = {
          charId: pl.charId,
          costume: pl.costume,
          locked: pl.locked,
        };
        this.onCharSelectUpdate?.(this.charState);
        this.checkLaunchFromCharSelect();
        break;
      }
      case 'rematch_vote': {
        const pl = env.payload as { sessionId: string; slot: 0 | 1 };
        if (!this.charState || this.charState.sessionId !== pl.sessionId) return;
        this.rematchReady[pl.slot] = true;
        const mySlot = this.charState.localSlot;
        this.onRematchStatus?.(this.rematchReady[mySlot], this.rematchReady[mySlot === 0 ? 1 : 0]);
        this.checkStartRematch();
        break;
      }
      case 'back_to_char_select': {
        const pl = env.payload as { sessionId: string };
        if (!this.charState || this.charState.sessionId !== pl.sessionId) return;
        this.enterCharSelect(
          this.charState.sessionId,
          this.charState.localSlot,
          this.charState.opponentId,
          this.charState.stageId,
          (this.charState.matchSeed + 1013904223) >>> 0,
        );
        this.onReturnToCharSelect?.();
        break;
      }
      case 'session_leave': {
        if (this.activeOpponentId === from) {
          this.cancelSessionToIdle();
          this.broadcastPresence();
          this.notifyStatus();
          this.onOpponentLeft?.();
        }
        break;
      }
      case 'udp_b64': {
        if (from === this.activeOpponentId && typeof env.payload === 'string') {
          this.onUdpFrame?.(base64ToUint8(env.payload));
        }
        break;
      }
    }
  }

  private createPeerConnection(peerId: string): RtcLink | null {
    if (typeof RTCPeerConnection === 'undefined') return null;
    const existing = this.rtcLinks.get(peerId);
    if (existing) {
      try {
        existing.pc.close();
      } catch {
        // ignore
      }
    }

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const link: RtcLink = {
      peerId,
      pc,
      ctrl: null,
      udp: null,
      pingMs: 0,
      lastPingSentMs: 0,
    };
    this.rtcLinks.set(peerId, link);

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this.publishEnvelope({
          mid: this.nextMid(),
          from: this.myId,
          to: peerId,
          room: this.roomCode,
          kind: 'rtc_ice',
          payload: ev.candidate.toJSON(),
        });
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      const p = this.peers.get(peerId);
      if (p) {
        p.rtcConnected = state === 'connected';
      }
      if (state === 'failed' || state === 'closed') {
        this.rtcLinks.delete(peerId);
      }
      this.notifyStatus();
    };

    return link;
  }

  private bindCtrlChannel(link: RtcLink, ch: RTCDataChannel): void {
    link.ctrl = ch;
    ch.onopen = () => {
      const p = this.peers.get(link.peerId);
      if (p) p.rtcConnected = true;
      this.sendPings();
      this.notifyStatus();
    };
    ch.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        this.handleRawSignal(ev.data);
      }
    };
  }

  private bindUdpChannel(link: RtcLink, ch: RTCDataChannel): void {
    ch.binaryType = 'arraybuffer';
    link.udp = ch;
    ch.onopen = () => {
      const p = this.peers.get(link.peerId);
      if (p) p.rtcConnected = true;
      this.notifyStatus();
    };
    ch.onmessage = (ev) => {
      if (link.peerId !== this.activeOpponentId) return;
      if (ev.data instanceof ArrayBuffer) {
        this.onUdpFrame?.(new Uint8Array(ev.data));
      }
    };
  }

  private async initiateWebRtc(peerId: string): Promise<void> {
    const link = this.createPeerConnection(peerId);
    if (!link) return;
    try {
      const ctrl = link.pc.createDataChannel('ironfist-ctrl', { ordered: true });
      const udp = link.pc.createDataChannel('ironfist-udp', {
        ordered: false,
        maxRetransmits: 0,
      });
      this.bindCtrlChannel(link, ctrl);
      this.bindUdpChannel(link, udp);

      const offer = await link.pc.createOffer();
      await link.pc.setLocalDescription(offer);
      this.publishEnvelope({
        mid: this.nextMid(),
        from: this.myId,
        to: peerId,
        room: this.roomCode,
        kind: 'rtc_offer',
        payload: offer,
      });
    } catch {
      this.rtcLinks.delete(peerId);
    }
  }

  private async handleRtcOffer(peerId: string, offer: RTCSessionDescriptionInit): Promise<void> {
    const link = this.createPeerConnection(peerId);
    if (!link) return;
    link.pc.ondatachannel = (ev) => {
      if (ev.channel.label === 'ironfist-udp') {
        this.bindUdpChannel(link, ev.channel);
      } else {
        this.bindCtrlChannel(link, ev.channel);
      }
    };
    try {
      await link.pc.setRemoteDescription(offer);
      const answer = await link.pc.createAnswer();
      await link.pc.setLocalDescription(answer);
      this.publishEnvelope({
        mid: this.nextMid(),
        from: this.myId,
        to: peerId,
        room: this.roomCode,
        kind: 'rtc_answer',
        payload: answer,
      });
    } catch {
      this.rtcLinks.delete(peerId);
    }
  }

  private async handleRtcAnswer(peerId: string, answer: RTCSessionDescriptionInit): Promise<void> {
    const link = this.rtcLinks.get(peerId);
    if (!link) return;
    try {
      if (link.pc.signalingState === 'have-local-offer') {
        await link.pc.setRemoteDescription(answer);
      }
    } catch {
      // ignore duplicate answer
    }
  }

  private async handleRtcIce(peerId: string, cand: RTCIceCandidateInit): Promise<void> {
    const link = this.rtcLinks.get(peerId);
    if (!link) return;
    try {
      await link.pc.addIceCandidate(cand);
    } catch {
      // ignore early candidate race
    }
  }

  private clearVoteTimers(): void {
    if (this.voteCountdownTimer !== null) {
      clearInterval(this.voteCountdownTimer);
      this.voteCountdownTimer = null;
    }
    if (this.voteAdvanceTimer !== null) {
      clearTimeout(this.voteAdvanceTimer);
      this.voteAdvanceTimer = null;
    }
  }

  private cancelSessionToIdle(): void {
    this.clearVoteTimers();
    this.phase = 'idle';
    this.pendingInviteTo = null;
    this.voteState = null;
    this.charState = null;
    this.activeOpponentId = null;
    this.rematchReady = [false, false];
  }

  private notifyStatus(): void {
    this.onStatusChange?.();
  }

  dispose(): void {
    this.clearVoteTimers();
    if (this.presenceTimer !== null) clearInterval(this.presenceTimer);
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.broadcastLeave();
    for (const r of this.relays) r.dispose();
    this.bc?.close();
    for (const [, link] of this.rtcLinks) {
      try {
        link.pc.close();
      } catch {
        // ignore
      }
    }
  }
}
