import { COMBAT_KERNEL_WASM_BYTES } from './embeddedWasm';

export interface CombatWasmExports {
  memory: { readonly buffer: ArrayBufferLike };
  resolve_capsules(
    x1: number,
    z1: number,
    x2: number,
    z2: number,
    minDist: number,
    halfW: number,
    halfD: number,
  ): number;
  check_3d_hit(
    ax: number,
    ay: number,
    az: number,
    facing: number,
    reach: number,
    hitDepth: number,
    heightCode: number,
    tracking: number,
    dx: number,
    dy: number,
    dz: number,
    crouching: number,
    sidestepFrames: number,
  ): number;
  compute_combo_damage(
    raw: number,
    juggleHits: number,
    inRage: number,
    isCounter: number,
    inHeat: number,
  ): number;
  step_juggle_physics(
    y: number,
    vy: number,
    gravity: number,
    juggleHits: number,
  ): number;
  score_ai_move(
    distX: number,
    distZ: number,
    oppState: number,
    oppCrouching: number,
    oppAirborne: number,
    moveReach: number,
    moveStartup: number,
    moveDamage: number,
    moveHeight: number,
    isLauncher: number,
    isHoming: number,
    difficulty: number,
    rngU32: number,
  ): number;
}

export interface CapsuleResolution {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  wallMask: number;
}

export interface JuggleStepResult {
  y: number;
  vy: number;
  landed: boolean;
}

let wasmExports: CombatWasmExports | null = null;
let f32View: Float32Array | null = null;
export let combatKernelMode: 'wasm' | 'simd-js' = 'wasm';

function bindInstance(exports: CombatWasmExports, mode: 'wasm' | 'simd-js'): CombatWasmExports {
  wasmExports = exports;
  f32View = new Float32Array(exports.memory.buffer);
  combatKernelMode = mode;
  return exports;
}

/**
 * Exact mirror of `combat_kernel.wat` for CSP-restricted `sandbox="allow-scripts"` iframes
 * that omit `'wasm-unsafe-eval'`. Uses preallocated `ArrayBuffer` with zero GC allocations.
 */
function createCspSafeKernelFallback(): CombatWasmExports {
  const buf = new ArrayBuffer(256);
  const f32 = new Float32Array(buf);
  const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

  return {
    memory: { buffer: buf },
    resolve_capsules(x1, z1, x2, z2, minDist, halfW, halfD) {
      x1 = clamp(x1, -halfW, halfW);
      x2 = clamp(x2, -halfW, halfW);
      z1 = clamp(z1, -halfD, halfD);
      z2 = clamp(z2, -halfD, halfD);

      const dx = x2 - x1;
      const dz = z2 - z1;
      const distSq = dx * dx + dz * dz;
      const minSq = minDist * minDist;
      if (distSq < minSq) {
        const dist = Math.sqrt(distSq);
        let nx = 1;
        let nz = 0;
        let overlap = minDist * 0.5;
        if (Math.abs(dx) < 0.08) {
          nx = x1 <= x2 ? 1 : -1;
          nz = 0;
          overlap = (minDist - Math.abs(dx)) * 0.5;
        } else {
          nx = dx / dist;
          nz = (dz / dist) * 0.35;
          overlap = (minDist - dist) * 0.5;
        }
        x1 -= nx * overlap;
        z1 -= nz * overlap;
        x2 += nx * overlap;
        z2 += nz * overlap;
      }

      x1 = clamp(x1, -halfW, halfW);
      x2 = clamp(x2, -halfW, halfW);
      z1 = clamp(z1, -halfD, halfD);
      z2 = clamp(z2, -halfD, halfD);

      if (Math.abs(x2 - x1) < minDist * 0.78) {
        if (x1 <= -halfW + 0.08) {
          if (x1 <= x2) x2 = x1 + minDist * 0.82;
          else x1 = x2 + minDist * 0.82;
        }
        if (x1 >= halfW - 0.08) {
          if (x1 >= x2) x2 = x1 - minDist * 0.82;
          else x1 = x2 - minDist * 0.82;
        }
      }

      let wallMask = 0;
      if (Math.abs(x1) >= halfW - 0.06) wallMask |= 1;
      if (Math.abs(x2) >= halfW - 0.06) wallMask |= 2;

      f32[0] = x1;
      f32[1] = z1;
      f32[2] = x2;
      f32[3] = z2;
      return wallMask;
    },

    check_3d_hit(
      ax,
      _ay,
      az,
      _facing,
      reach,
      hitDepth,
      heightCode,
      tracking,
      dx,
      dy,
      dz,
      crouching,
      sidestepFrames,
    ) {
      const zDiff = Math.abs(dz - az);
      const dist3d = Math.hypot(dx - ax, zDiff);
      if (dist3d > reach + 0.12) return 0;

      if (tracking === 0 && sidestepFrames > 0 && zDiff > hitDepth * 0.56) {
        return 0;
      }

      if (dy > 0.12) {
        if (dy > 1.95) return 0;
        if (heightCode === 0 && dy > 0.36) return 0;
        return 1;
      }

      if (heightCode === 2 && crouching === 1) return 0;
      return 1;
    },

    compute_combo_damage(raw, juggleHits, inRage, isCounter, inHeat) {
      let scale = 1.0;
      if (juggleHits === 1) scale = 0.7;
      else if (juggleHits === 2) scale = 0.55;
      else if (juggleHits === 3) scale = 0.45;
      else if (juggleHits === 4) scale = 0.35;
      else if (juggleHits >= 5) scale = 0.3;

      let dmg = raw * scale;
      if (inRage === 1) dmg *= 1.18;
      if (isCounter === 1 && juggleHits === 0) dmg *= 1.2;
      if (inHeat === 1) dmg *= 1.12;
      return Math.max(1, Math.round(dmg));
    },

    step_juggle_physics(y, vy, gravity, juggleHits) {
      const gravScale = 1 + Math.min(6, juggleHits) * 0.055;
      let nextVy = vy - gravity * gravScale;
      let nextY = y + nextVy;
      let landed = 0;
      if (nextY <= 0) {
        nextY = 0;
        nextVy = 0;
        landed = 1;
      }
      f32[4] = nextY;
      f32[5] = nextVy;
      return landed;
    },

    score_ai_move(
      distX,
      distZ,
      oppState,
      oppCrouching,
      oppAirborne,
      moveReach,
      moveStartup,
      moveDamage,
      moveHeight,
      isLauncher,
      isHoming,
      difficulty,
      rngU32,
    ) {
      if (distX > moveReach + 0.12) return -50 - (distX - moveReach) * 20;
      let score = moveDamage * 1.15 - moveStartup * 0.65;
      const idealGap = Math.abs(moveReach - distX - 0.18);
      score += Math.max(0, 14 - idealGap * 16);

      if (oppCrouching === 1) {
        if (moveHeight === 2) score -= 80;
        if (moveHeight === 1) score += 22;
      }
      if (oppAirborne === 1) {
        if (moveHeight === 0) score -= 70;
        if (moveStartup <= 15) score += 20;
      }
      if (distZ > 0.32) {
        if (isHoming === 1) score += 28;
        else score -= 18;
      }
      if ((oppState === 2 || oppState === 1) && isLauncher === 1 && difficulty >= 2) {
        score += 26;
      }
      const jitter = ((rngU32 & 1023) / 1023) * (18 - difficulty * 3);
      return score + jitter;
    },
  };
}

export function getCombatWasm(): CombatWasmExports {
  if (wasmExports !== null) return wasmExports;
  try {
    const mod = new WebAssembly.Module(COMBAT_KERNEL_WASM_BYTES);
    const inst = new WebAssembly.Instance(mod);
    return bindInstance(inst.exports as unknown as CombatWasmExports, 'wasm');
  } catch {
    return bindInstance(createCspSafeKernelFallback(), 'simd-js');
  }
}

export async function initCombatWasmAsync(): Promise<CombatWasmExports> {
  if (wasmExports !== null) return wasmExports;
  try {
    const { instance } = await WebAssembly.instantiate(COMBAT_KERNEL_WASM_BYTES);
    return bindInstance(instance.exports as unknown as CombatWasmExports, 'wasm');
  } catch {
    return getCombatWasm();
  }
}

const CAPSULE_OUT: CapsuleResolution = { x1: 0, z1: 0, x2: 0, z2: 0, wallMask: 0 };
const JUGGLE_OUT: JuggleStepResult = { y: 0, vy: 0, landed: false };

export function wasmResolveCapsules(
  x1: number,
  z1: number,
  x2: number,
  z2: number,
  minDist: number,
  halfW: number,
  halfD: number,
): CapsuleResolution {
  const wasm = getCombatWasm();
  const mask = wasm.resolve_capsules(x1, z1, x2, z2, minDist, halfW, halfD);
  const view = f32View!;
  CAPSULE_OUT.x1 = view[0];
  CAPSULE_OUT.z1 = view[1];
  CAPSULE_OUT.x2 = view[2];
  CAPSULE_OUT.z2 = view[3];
  CAPSULE_OUT.wallMask = mask;
  return CAPSULE_OUT;
}

export function wasmStepJuggle(
  y: number,
  vy: number,
  gravity: number,
  juggleHits: number,
): JuggleStepResult {
  const wasm = getCombatWasm();
  const landed = wasm.step_juggle_physics(y, vy, gravity, juggleHits);
  const view = f32View!;
  JUGGLE_OUT.y = view[4];
  JUGGLE_OUT.vy = view[5];
  JUGGLE_OUT.landed = landed === 1;
  return JUGGLE_OUT;
}

export function heightToCode(height: 'low' | 'mid' | 'high'): number {
  if (height === 'low') return 0;
  if (height === 'mid') return 1;
  return 2;
}
