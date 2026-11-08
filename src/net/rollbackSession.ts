import { createEmptyInput, type RawInputFrame } from '../sim/inputs';
import {
  cloneMatchState,
  computeMatchChecksum,
  copyMatchState,
  stepMatch,
  type CombatEvent,
  type MatchState,
} from '../sim/combat';

/** Neutral packed input byte: x = 0 (+1 -> 1), z = 0 (+1 -> 1), buttons = 0 -> (1 | (1 << 2)) = 5 */
export const NEUTRAL_INPUT_BYTE = 5;

export const ROLLBACK_RING_SIZE = 64;
export const DEFAULT_INPUT_DELAY = 1;
export const MAX_PREDICTION_FRAMES = 14;
export const REDUNDANT_INPUT_COUNT = 8;

/**
 * Packs a 60Hz `RawInputFrame` into a single compact byte:
 * - bits 0..1: `x + 1` (0 = -1, 1 = 0, 2 = +1)
 * - bits 2..3: `z + 1` (0 = -1, 1 = 0, 2 = +1)
 * - bit 4: `lp`, bit 5: `rp`, bit 6: `lk`, bit 7: `rk`
 */
export function packInputByte(inp: RawInputFrame): number {
  const xb = (inp.x + 1) & 0x03;
  const zb = (inp.z + 1) & 0x03;
  const btns =
    (inp.buttons.lp ? 16 : 0) |
    (inp.buttons.rp ? 32 : 0) |
    (inp.buttons.lk ? 64 : 0) |
    (inp.buttons.rk ? 128 : 0);
  return xb | (zb << 2) | btns;
}

export function unpackInputByte(
  byte: number,
  out: RawInputFrame = createEmptyInput(),
): RawInputFrame {
  const xb = byte & 0x03;
  const zb = (byte >> 2) & 0x03;
  out.x = xb === 0 ? -1 : xb === 2 ? 1 : 0;
  out.z = zb === 0 ? -1 : zb === 2 ? 1 : 0;
  out.buttons.lp = (byte & 16) !== 0;
  out.buttons.rp = (byte & 32) !== 0;
  out.buttons.lk = (byte & 64) !== 0;
  out.buttons.rk = (byte & 128) !== 0;
  return out;
}

export interface DecodedInputPacket {
  headFrame: number;
  ackRemoteFrame: number;
  checksumFrame: number;
  checksum: number;
  count: number;
  inputs: Uint8Array; // [input(headFrame), input(headFrame - 1), ...]
}

/**
 * Encodes a 24-byte UDP-style Rollback Input Packet:
 * - [0]: magic 0x49 ('I')
 * - [1]: count of redundant frames (1..8)
 * - [2..3]: reserved / flags
 * - [4..7]: Uint32 headFrame
 * - [8..11]: Int32 ackRemoteFrame
 * - [12..15]: Int32 checksumFrame (-1 if none)
 * - [16..19]: Uint32 FNV-1a checksum of confirmed frame
 * - [20..27]: up to 8 redundant input bytes [headFrame, headFrame-1, ...]
 */
export function encodeInputPacket(
  headFrame: number,
  ackRemoteFrame: number,
  checksumFrame: number,
  checksum: number,
  inputsNewestFirst: Uint8Array,
  count: number,
): Uint8Array {
  const buf = new ArrayBuffer(28);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  view.setUint8(0, 0x49);
  view.setUint8(1, count);
  view.setUint32(4, headFrame >>> 0, true);
  view.setInt32(8, ackRemoteFrame | 0, true);
  view.setInt32(12, checksumFrame | 0, true);
  view.setUint32(16, checksum >>> 0, true);
  for (let i = 0; i < count && i < REDUNDANT_INPUT_COUNT; i += 1) {
    bytes[20 + i] = inputsNewestFirst[i];
  }
  return bytes;
}

export function decodeInputPacket(bytes: Uint8Array): DecodedInputPacket | null {
  if (bytes.byteLength < 21 || bytes[0] !== 0x49) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = Math.min(REDUNDANT_INPUT_COUNT, view.getUint8(1));
  const headFrame = view.getUint32(4, true);
  const ackRemoteFrame = view.getInt32(8, true);
  const checksumFrame = view.getInt32(12, true);
  const checksum = view.getUint32(16, true);
  const inputs = bytes.subarray(20, 20 + count);
  return { headFrame, ackRemoteFrame, checksumFrame, checksum, count, inputs };
}

/**
 * Deterministic 60Hz GGPO-Style Rollback Session for IRON FIST V.
 */
export class RollbackNetSession {
  readonly localSlot: 0 | 1;
  readonly inputDelay: number;

  private readonly snapshots: MatchState[] = [];
  private readonly snapshotTicks = new Int32Array(ROLLBACK_RING_SIZE).fill(-1);
  private readonly checksums = new Uint32Array(ROLLBACK_RING_SIZE);

  private readonly localInputs = new Uint8Array(4096).fill(NEUTRAL_INPUT_BYTE);
  private readonly localFrameTag = new Int32Array(4096).fill(-1);

  private readonly remoteInputs = new Uint8Array(4096).fill(NEUTRAL_INPUT_BYTE);
  private readonly remoteFrameTag = new Int32Array(4096).fill(-1);

  private readonly predictedRemote = new Uint8Array(4096).fill(NEUTRAL_INPUT_BYTE);

  private readonly scratchP1 = createEmptyInput();
  private readonly scratchP2 = createEmptyInput();
  private readonly scratchOutInputs = new Uint8Array(REDUNDANT_INPUT_COUNT);
  private readonly incomingQueue: DecodedInputPacket[] = [];

  private highestRemoteFrame = -1;
  private peerAckedOurFrame = -1;
  private lastKnownRemoteByte = NEUTRAL_INPUT_BYTE;
  private riftCooldown = 0;

  lastRollbackDepth = 0;
  totalRollbacks = 0;
  stalledForPeer = false;
  desyncDetected = false;

  constructor(initialMatch: MatchState, localSlot: 0 | 1, inputDelay = DEFAULT_INPUT_DELAY) {
    this.localSlot = localSlot;
    this.inputDelay = Math.max(0, Math.min(4, inputDelay));

    for (let i = 0; i < ROLLBACK_RING_SIZE; i += 1) {
      this.snapshots.push(cloneMatchState(initialMatch));
    }
    this.saveSnapshot(initialMatch);

    // Pre-seed neutral delayed inputs for frames 0..inputDelay-1 so frame 0 runs immediately
    for (let f = 0; f < this.inputDelay; f += 1) {
      this.setLocalInput(f, NEUTRAL_INPUT_BYTE);
    }
  }

  private saveSnapshot(state: MatchState): void {
    const slot = state.tick % ROLLBACK_RING_SIZE;
    copyMatchState(state, this.snapshots[slot]);
    this.snapshotTicks[slot] = state.tick;
    this.checksums[slot] = computeMatchChecksum(state);
  }

  private setLocalInput(frame: number, byte: number): void {
    const idx = frame & 4095;
    this.localInputs[idx] = byte;
    this.localFrameTag[idx] = frame;
  }

  private getLocalInput(frame: number): number {
    const idx = frame & 4095;
    return this.localFrameTag[idx] === frame ? this.localInputs[idx] : NEUTRAL_INPUT_BYTE;
  }

  private hasRemoteInput(frame: number): boolean {
    if (frame < 0) return true;
    const idx = frame & 4095;
    return this.remoteFrameTag[idx] === frame;
  }

  private getRemoteInput(frame: number): number {
    const idx = frame & 4095;
    return this.remoteFrameTag[idx] === frame ? this.remoteInputs[idx] : this.lastKnownRemoteByte;
  }

  receivePacket(rawBytes: Uint8Array): void {
    const decoded = decodeInputPacket(rawBytes);
    if (decoded) {
      this.incomingQueue.push(decoded);
    }
  }

  get highestConfirmedRemoteFrame(): number {
    return this.highestRemoteFrame;
  }

  /**
   * Executes one 60Hz Rollback Simulation Tick:
   * 1. Processes incoming UDP input packets & triggers instant rollback if any predicted frame differed.
   * 2. Applies Rift Advantage pacing & max prediction stall guard.
   * 3. Records local input for `tick + inputDelay`, sends redundant 8-frame UDP packet, and steps `match`.
   */
  step(
    match: MatchState,
    rawLocal: RawInputFrame,
    sendUdpPacket: (packet: Uint8Array) => void,
  ): CombatEvent[] {
    const currentTick = match.tick;
    let earliestMispredict = Infinity;

    // 1. Drain incoming remote input packets
    while (this.incomingQueue.length > 0) {
      const pkt = this.incomingQueue.shift()!;
      if (pkt.ackRemoteFrame > this.peerAckedOurFrame) {
        this.peerAckedOurFrame = pkt.ackRemoteFrame;
      }

      for (let i = pkt.count - 1; i >= 0; i -= 1) {
        const rf = pkt.headFrame - i;
        if (rf < 0) continue;
        const byte = pkt.inputs[i];
        if (!this.hasRemoteInput(rf)) {
          const idx = rf & 4095;
          this.remoteInputs[idx] = byte;
          this.remoteFrameTag[idx] = rf;

          if (rf > this.highestRemoteFrame) {
            this.highestRemoteFrame = rf;
            this.lastKnownRemoteByte = byte;
          }

          if (rf < currentTick && this.predictedRemote[idx] !== byte) {
            if (rf < earliestMispredict) earliestMispredict = rf;
          }
        }
      }

      // Optional checksum verification on confirmed frames
      if (pkt.checksumFrame >= 0 && pkt.checksumFrame < currentTick) {
        const cSlot = pkt.checksumFrame % ROLLBACK_RING_SIZE;
        if (
          this.snapshotTicks[cSlot] === pkt.checksumFrame &&
          this.hasRemoteInput(pkt.checksumFrame) &&
          earliestMispredict > pkt.checksumFrame
        ) {
          if (this.checksums[cSlot] !== pkt.checksum) {
            this.desyncDetected = true;
          }
        }
      }
    }

    const freshEvents: CombatEvent[] = [];

    // 2. Instant Rollback & Fast Re-Simulation if remote input differed from prediction!
    if (earliestMispredict < currentTick) {
      const minAvailable = Math.max(0, currentTick - ROLLBACK_RING_SIZE + 2);
      const rbStart = Math.max(minAvailable, earliestMispredict);
      const slot = rbStart % ROLLBACK_RING_SIZE;

      if (this.snapshotTicks[slot] === rbStart) {
        this.lastRollbackDepth = currentTick - rbStart;
        this.totalRollbacks += 1;

        copyMatchState(this.snapshots[slot], match);

        for (let f = rbStart; f < currentTick; f += 1) {
          const locByte = this.getLocalInput(f);
          const remByte = this.hasRemoteInput(f)
            ? this.getRemoteInput(f)
            : this.lastKnownRemoteByte;
          this.predictedRemote[f & 4095] = remByte;

          const p1Byte = this.localSlot === 0 ? locByte : remByte;
          const p2Byte = this.localSlot === 1 ? locByte : remByte;
          unpackInputByte(p1Byte, this.scratchP1);
          unpackInputByte(p2Byte, this.scratchP2);

          stepMatch(match, this.scratchP1, this.scratchP2);
          if (f === currentTick - 1 && match.events.length > 0) {
            for (let e = 0; e < match.events.length; e += 1) {
              freshEvents.push(match.events[e]);
            }
          }
          match.events.length = 0;
          this.saveSnapshot(match);
        }
      }
    } else {
      this.lastRollbackDepth = 0;
    }

    // 3. Guard against exceeding prediction horizon if remote peer temporarily stalls
    const unconfirmedLead = currentTick - this.highestRemoteFrame;
    if (currentTick > 6 && unconfirmedLead > MAX_PREDICTION_FRAMES) {
      this.stalledForPeer = true;
      this.transmitLatestInputs(Math.max(0, currentTick + this.inputDelay - 1), sendUdpPacket);
      return freshEvents;
    }
    this.stalledForPeer = false;

    // Gentle symmetric time-rift sync (keeps both peers within ~1 frame of each other)
    if (this.riftCooldown > 0) {
      this.riftCooldown -= 1;
    } else if (currentTick > 20 && this.highestRemoteFrame >= 0 && this.peerAckedOurFrame >= 0) {
      const ourLead = currentTick - this.highestRemoteFrame;
      const theirLead = this.highestRemoteFrame - this.peerAckedOurFrame;
      if (ourLead - theirLead >= 4) {
        this.riftCooldown = 10;
        this.transmitLatestInputs(Math.max(0, currentTick + this.inputDelay - 1), sendUdpPacket);
        return freshEvents;
      }
    }

    // 4. Record local input at `currentTick + inputDelay` & broadcast redundant 8-frame UDP packet
    const targetFrame = currentTick + this.inputDelay;
    this.setLocalInput(targetFrame, packInputByte(rawLocal));
    this.transmitLatestInputs(targetFrame, sendUdpPacket);

    // 5. Ensure currentTick snapshot is stored, then advance simulation by 1 tick
    if (this.snapshotTicks[currentTick % ROLLBACK_RING_SIZE] !== currentTick) {
      this.saveSnapshot(match);
    }

    const locNow = this.getLocalInput(currentTick);
    const remNow = this.hasRemoteInput(currentTick)
      ? this.getRemoteInput(currentTick)
      : this.lastKnownRemoteByte;
    this.predictedRemote[currentTick & 4095] = remNow;

    const p1Now = this.localSlot === 0 ? locNow : remNow;
    const p2Now = this.localSlot === 1 ? locNow : remNow;
    unpackInputByte(p1Now, this.scratchP1);
    unpackInputByte(p2Now, this.scratchP2);

    stepMatch(match, this.scratchP1, this.scratchP2);
    for (let e = 0; e < match.events.length; e += 1) {
      freshEvents.push(match.events[e]);
    }
    match.events.length = 0;
    this.saveSnapshot(match);

    return freshEvents;
  }

  private transmitLatestInputs(
    headFrame: number,
    sendUdpPacket: (packet: Uint8Array) => void,
  ): void {
    const count = Math.min(REDUNDANT_INPUT_COUNT, headFrame + 1);
    for (let i = 0; i < count; i += 1) {
      this.scratchOutInputs[i] = this.getLocalInput(headFrame - i);
    }

    let confirmedFrame = -1;
    let confirmedSum = 0;
    const cand = Math.min(this.highestRemoteFrame, headFrame - this.inputDelay);
    if (cand >= 0) {
      const cSlot = cand % ROLLBACK_RING_SIZE;
      if (this.snapshotTicks[cSlot] === cand) {
        confirmedFrame = cand;
        confirmedSum = this.checksums[cSlot];
      }
    }

    const pkt = encodeInputPacket(
      headFrame,
      this.highestRemoteFrame,
      confirmedFrame,
      confirmedSum,
      this.scratchOutInputs,
      count,
    );
    sendUdpPacket(pkt);
  }
}
