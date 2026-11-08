import { LIMB_BUTTONS, type LimbButton } from '../data/types';

/** Tekken numpad directions relative to facing: 6 = forward, 4 = back, 2 = down, 8 = up, 5 = neutral */
export type NumpadDir = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export interface RawInputFrame {
  /** World X input: -1 left, 0 neutral, +1 right */
  x: -1 | 0 | 1;
  /** World Z / vertical input: +1 up/inward, 0 neutral, -1 down/outward */
  z: -1 | 0 | 1;
  buttons: Record<LimbButton, boolean>;
}

export function createEmptyInput(): RawInputFrame {
  return {
    x: 0,
    z: 0,
    buttons: { lp: false, rp: false, lk: false, rk: false },
  };
}

export interface BufferEntry {
  dir: NumpadDir;
  pressedMask: number; // bit0=lp, bit1=rp, bit2=lk, bit3=rk
  heldMask: number;
}

export interface NotationStep {
  dir: NumpadDir | null;
  altDir?: NumpadDir | null;
  buttonMask: number;
}

export interface TapeEntry {
  dir: NumpadDir;
  buttonMask: number;
  framesHeld: number;
}

export const BUFFER_CAPACITY = 36;
export const FINAL_PRESS_WINDOW = 5;
export const STEP_GAP_WINDOW = 16;

const DIR_TOKENS: Record<string, NumpadDir> = {
  'd/b': 1,
  db: 1,
  d: 2,
  'd/f': 3,
  df: 3,
  b: 4,
  n: 5,
  f: 6,
  'u/b': 7,
  ub: 7,
  u: 8,
  'u/f': 9,
  uf: 9,
};

export function buttonToBit(b: LimbButton): number {
  switch (b) {
    case 'lp':
      return 1;
    case 'rp':
      return 2;
    case 'lk':
      return 4;
    case 'rk':
      return 8;
  }
}

export function buttonsToMask(buttons: Record<LimbButton, boolean>): number {
  return (
    (buttons.lp ? 1 : 0) |
    (buttons.rp ? 2 : 0) |
    (buttons.lk ? 4 : 0) |
    (buttons.rk ? 8 : 0)
  );
}

export function toRelativeDir(fwd: -1 | 0 | 1, vert: -1 | 0 | 1): NumpadDir {
  return (5 + fwd + vert * 3) as NumpadDir;
}

const NOTATION_CACHE = new Map<string, NotationStep[]>();

export function parseNotation(notation: string): NotationStep[] {
  const cached = NOTATION_CACHE.get(notation);
  if (cached !== undefined) return cached;

  const cleaned = notation.toLowerCase().replace(/\s+/g, '');
  const parts = cleaned.split(',');
  const steps: NotationStep[] = [];

  for (const part of parts) {
    let dir: NumpadDir | null = null;
    let buttonMask = 0;
    for (const tok of part.split('+')) {
      if (tok in DIR_TOKENS) {
        dir = DIR_TOKENS[tok];
      } else if (/^[1-4]$/.test(tok)) {
        const idx = Number(tok) - 1;
        buttonMask |= buttonToBit(LIMB_BUTTONS[idx]);
      } else {
        throw new Error(`Invalid notation token "${tok}" in "${notation}"`);
      }
    }
    steps.push({ dir, buttonMask });
  }

  NOTATION_CACHE.set(notation, steps);
  return steps;
}

/**
 * Fixed-capacity, allocation-free ring/window input buffer for deterministic 60Hz play.
 */
export class CommandInputBuffer {
  private readonly dirs = new Uint8Array(BUFFER_CAPACITY);
  private readonly pressed = new Uint8Array(BUFFER_CAPACITY);
  private readonly held = new Uint8Array(BUFFER_CAPACITY);
  private length = 0;

  readonly tape: TapeEntry[] = [];

  clear(): void {
    this.length = 0;
  }

  cloneFrom(other: CommandInputBuffer): void {
    this.dirs.set(other.dirs);
    this.pressed.set(other.pressed);
    this.held.set(other.held);
    this.length = other.length;
  }

  push(dir: NumpadDir, pressedMask: number, heldMask: number): void {
    if (this.length < BUFFER_CAPACITY) {
      this.dirs[this.length] = dir;
      this.pressed[this.length] = pressedMask;
      this.held[this.length] = heldMask;
      this.length += 1;
    } else {
      this.dirs.copyWithin(0, 1);
      this.pressed.copyWithin(0, 1);
      this.held.copyWithin(0, 1);
      const last = BUFFER_CAPACITY - 1;
      this.dirs[last] = dir;
      this.pressed[last] = pressedMask;
      this.held[last] = heldMask;
    }

    // Update human-readable command history tape when input changes
    if (dir !== 5 || pressedMask !== 0) {
      const top = this.tape[this.tape.length - 1];
      if (top && top.dir === dir && top.buttonMask === pressedMask && pressedMask === 0) {
        top.framesHeld = Math.min(99, top.framesHeld + 1);
      } else {
        this.tape.push({ dir, buttonMask: pressedMask, framesHeld: 1 });
        if (this.tape.length > 12) this.tape.shift();
      }
    }
  }

  private stepSatisfied(idx: number, step: NotationStep): boolean {
    if (step.dir !== null && this.dirs[idx] !== step.dir) {
      return false;
    }
    if (step.buttonMask !== 0) {
      // Every required button must be held, and at least one must have been freshly pressed within 2 frames
      const heldNow = this.held[idx];
      if ((heldNow & step.buttonMask) !== step.buttonMask) return false;
      const freshNow =
        this.pressed[idx] |
        (idx > 0 ? this.pressed[idx - 1] : 0);
      if ((freshNow & step.buttonMask) === 0) return false;
    }
    return true;
  }

  matches(notation: string): boolean {
    const steps = parseNotation(notation);
    if (steps.length === 0 || this.length === 0) return false;

    if (this.matchesExact(steps)) return true;

    // Touch / Gamepad friendly crouch-dash shortcut: `f,d,d/f+X` also accepts `f,d/f+X` if clean
    if (
      steps.length === 3 &&
      steps[0].dir === 6 &&
      steps[1].dir === 2 &&
      steps[2].dir === 3
    ) {
      return this.matchesExact([steps[0], steps[2]]);
    }
    return false;
  }

  private matchesExact(steps: readonly NotationStep[]): boolean {
    const lastStep = steps[steps.length - 1];
    let idx = -1;
    const minLast = Math.max(0, this.length - FINAL_PRESS_WINDOW);
    for (let i = this.length - 1; i >= minLast; i -= 1) {
      if (this.stepSatisfied(i, lastStep)) {
        idx = i;
        break;
      }
    }
    if (idx < 0) return false;

    for (let s = steps.length - 2; s >= 0; s -= 1) {
      const step = steps[s];
      const nextStep = steps[s + 1];
      const needsNeutralGap =
        step.dir !== null && step.buttonMask === 0 && step.dir === nextStep.dir;

      let found = -1;
      const stop = Math.max(0, idx - STEP_GAP_WINDOW);
      for (let i = idx - 1; i >= stop; i -= 1) {
        if (!this.stepSatisfied(i, step)) continue;
        if (needsNeutralGap) {
          let hasGap = false;
          for (let g = i + 1; g < idx; g += 1) {
            if (this.dirs[g] !== step.dir) {
              hasGap = true;
              break;
            }
          }
          if (!hasGap) continue;
        }
        found = i;
        break;
      }
      if (found < 0) return false;
      idx = found;
    }
    return true;
  }
}
