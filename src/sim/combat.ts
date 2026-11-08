import { mulberry32 } from '@driftengine/core';
import type {
  CharacterData,
  DummyBehavior,
  LimbButton,
  MoveData,
  StageDefinition,
} from '../data/types';
import {
  CommandInputBuffer,
  buttonsToMask,
  toRelativeDir,
  type RawInputFrame,
} from './inputs';
import {
  getCombatWasm,
  heightToCode,
  wasmResolveCapsules,
  wasmStepJuggle,
} from '../wasm/wasmBridge';

export const BODY_SEPARATION = 0.82;
export const BASE_HIT_DEPTH = 0.72;
export const GRAVITY = 0.008;
export const JUMP_VELOCITY = 0.165;
export const DEFAULT_LAUNCH_VY = 0.184;
export const BOUND_VY = 0.132;
export const MAX_JUGGLE_HITS = 8;
export const KNOCKDOWN_FRAMES = 46;
export const SIDESTEP_TOTAL_FRAMES = 18;
export const CROUCH_THRESHOLD_FRAMES = 6;
export const JUMP_THRESHOLD_FRAMES = 6;
export const THROW_CONNECT_FRAMES = 28;
export const THROW_BREAK_WINDOW = 15;
export const STRING_CANCEL_WINDOW = 13;
export const RAGE_HP_FRACTION = 0.25;
export const KI_HEAT_FRAMES = 60 * 9;
export const WALL_SPLAT_DAMAGE = 10;
export const WALL_SPLAT_STUN = 26;
export const ROUND_DURATION_FRAMES = 60 * 60;
export const INTRO_DURATION_FRAMES = 95;
export const OUTRO_DURATION_FRAMES = 150;

export type FighterState =
  | 'idle'
  | 'walk'
  | 'sidestep'
  | 'jump'
  | 'attack'
  | 'hitstun'
  | 'blockstun'
  | 'juggle'
  | 'thrown'
  | 'knockdown'
  | 'ko';

export interface PendingThrowState {
  damage: number;
  breakMask: number; // 1 = break w/ LP (1), 2 = break w/ RP (2)
  attackerIdx: 0 | 1;
}

export interface FighterSim {
  index: 0 | 1;
  char: CharacterData;
  costumeIdx: 0 | 1;
  x: number;
  y: number;
  z: number;
  prevX: number;
  prevY: number;
  prevZ: number;
  vx: number;
  vy: number;
  vz: number;
  hp: number;
  recoverableHp: number;
  facing: 1 | -1;
  state: FighterState;
  stateFrame: number;
  activeMove: MoveData | null;
  crouching: boolean;
  holdDownFrames: number;
  holdUpFrames: number;
  sidestepDir: -1 | 0 | 1;
  sidestepFrames: number;
  buffer: CommandInputBuffer;
  prevMask: number;
  hitRegistered: boolean;
  stunFrames: number;
  juggleHits: number;
  boundUsed: boolean;
  wallSplatUsed: boolean;
  rageActive: boolean;
  rageArtUsed: boolean;
  kiFrames: number;
  kiUsed: boolean;
  pendingThrow: PendingThrowState | null;
  comboCounter: number;
  comboDamage: number;
  lastFrameAdvantage: number;
  armorFlashFrames: number;
  queuedStringMask: number;
  dashFrames: number;
  dashDir: -1 | 0 | 1;
}

export type RoundPhase = 'intro' | 'fight' | 'round_over' | 'match_over';

export type CombatEventKind =
  | 'hit'
  | 'counter_hit'
  | 'whiff_punish'
  | 'sidestep_evade'
  | 'block'
  | 'whiff'
  | 'launch'
  | 'bound'
  | 'wall_splat'
  | 'throw_grab'
  | 'throw_slam'
  | 'throw_break'
  | 'electric'
  | 'armor_absorb'
  | 'rage_activate'
  | 'rage_art_start'
  | 'ko'
  | 'round_start'
  | 'round_win';

export interface CombatEvent {
  kind: CombatEventKind;
  by: 0 | 1;
  x: number;
  y: number;
  z: number;
  power: number;
  text?: string;
}

export interface MatchConfig {
  p1: CharacterData;
  p2: CharacterData;
  p1Costume: 0 | 1;
  p2Costume: 0 | 1;
  stage: StageDefinition;
  roundsToWin: number;
  infiniteTime?: boolean;
  practiceMode?: boolean;
  dummyBehavior?: DummyBehavior;
  seed?: number;
}

export interface MatchState {
  config: MatchConfig;
  fighters: [FighterSim, FighterSim];
  phase: RoundPhase;
  phaseFrame: number;
  timerFrames: number;
  tick: number;
  hitstopFrames: number;
  rageFreezeFrames: number;
  rageFreezeBy: 0 | 1 | null;
  slowMoFrames: number;
  wins: [number, number];
  roundNumber: number;
  roundWinner: 0 | 1 | 'draw' | null;
  perfectRound: boolean;
  events: CombatEvent[];
  rng: () => number;
}

function createFighter(
  index: 0 | 1,
  char: CharacterData,
  costumeIdx: 0 | 1,
): FighterSim {
  const startX = index === 0 ? -2.05 : 2.05;
  return {
    index,
    char,
    costumeIdx,
    x: startX,
    y: 0,
    z: 0,
    prevX: startX,
    prevY: 0,
    prevZ: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    hp: char.maxHp,
    recoverableHp: char.maxHp,
    facing: index === 0 ? 1 : -1,
    state: 'idle',
    stateFrame: 0,
    activeMove: null,
    crouching: false,
    holdDownFrames: 0,
    holdUpFrames: 0,
    sidestepDir: 0,
    sidestepFrames: 0,
    buffer: new CommandInputBuffer(),
    prevMask: 0,
    hitRegistered: false,
    stunFrames: 0,
    juggleHits: 0,
    boundUsed: false,
    wallSplatUsed: false,
    rageActive: false,
    rageArtUsed: false,
    kiFrames: 0,
    kiUsed: false,
    pendingThrow: null,
    comboCounter: 0,
    comboDamage: 0,
    lastFrameAdvantage: 0,
    armorFlashFrames: 0,
    queuedStringMask: 0,
    dashFrames: 0,
    dashDir: 0,
  };
}

/** Universal Tekken Directional Normals (active across all 12 fighters!) */
const UNIVERSAL_CROUCH_JAB: MoveData = {
  id: 'uni_d1',
  name: 'Crouching Jab',
  startup: 10,
  active: 3,
  recovery: 13,
  damage: 7,
  hitstun: 16,
  blockstun: 6,
  reach: 1.48,
  pushback: 0.16,
  height: 'low',
  limb: 'lp',
  anim: 'jab_l',
};

const UNIVERSAL_LOW_KICK: MoveData = {
  id: 'uni_d4',
  name: 'Shin Slicer',
  startup: 14,
  active: 4,
  recovery: 18,
  damage: 13,
  hitstun: 18,
  blockstun: 5,
  reach: 1.78,
  pushback: 0.24,
  height: 'low',
  limb: 'rk',
  anim: 'low_sweep',
};

const UNIVERSAL_DF1_MID: MoveData = {
  id: 'uni_df1',
  name: 'Mid Gut Check',
  startup: 13,
  active: 3,
  recovery: 15,
  damage: 13,
  hitstun: 19,
  blockstun: 10,
  reach: 1.62,
  pushback: 0.24,
  height: 'mid',
  limb: 'lp',
  anim: 'jab_l',
  homing: true,
};

const UNIVERSAL_DF2_UPPER: MoveData = {
  id: 'uni_df2',
  name: 'Rising Uppercut',
  startup: 15,
  active: 4,
  recovery: 22,
  damage: 16,
  hitstun: 28,
  blockstun: 10,
  reach: 1.68,
  pushback: 0.3,
  height: 'mid',
  limb: 'rp',
  anim: 'uppercut_r',
  launch: true,
  launchVy: 0.184,
};

const UNIVERSAL_UF4_HOPKICK: MoveData = {
  id: 'uni_uf4',
  name: 'Rising Hopkick',
  startup: 15,
  active: 4,
  recovery: 23,
  damage: 18,
  hitstun: 28,
  blockstun: 10,
  reach: 1.76,
  pushback: 0.32,
  height: 'mid',
  limb: 'rk',
  anim: 'hopkick',
  launch: true,
  launchVy: 0.186,
  advance: 0.32,
};

function getAxisToOpponent(f: FighterSim, opp: FighterSim): [number, number] {
  const dx = opp.x - f.x;
  const dz = opp.z - f.z;
  const d = Math.hypot(dx, dz);
  if (d > 0.001) return [dx / d, dz / d];
  return [f.facing, 0];
}

function moveAlongCombatAxis(f: FighterSim, opp: FighterSim, signedDist: number): void {
  const [ux, uz] = getAxisToOpponent(f, opp);
  f.x += ux * signedDist;
  f.z += uz * signedDist;
  // Also gently pull Z toward center arena line when backing away so corners never drift deep
  if (signedDist < 0 && Math.abs(f.z) > 0.25) {
    f.z -= Math.sign(f.z) * Math.min(Math.abs(f.z), 0.015);
  }
}

export function createMatch(config: MatchConfig): MatchState {
  // Ensure WASM combat kernel is warm synchronously
  getCombatWasm();
  const state: MatchState = {
    config,
    fighters: [
      createFighter(0, config.p1, config.p1Costume),
      createFighter(1, config.p2, config.p2Costume),
    ],
    phase: config.practiceMode ? 'fight' : 'intro',
    phaseFrame: 0,
    timerFrames: ROUND_DURATION_FRAMES,
    tick: 0,
    hitstopFrames: 0,
    rageFreezeFrames: 0,
    rageFreezeBy: null,
    slowMoFrames: 0,
    wins: [0, 0],
    roundNumber: 1,
    roundWinner: null,
    perfectRound: false,
    events: [],
    rng: mulberry32(config.seed ?? 20261107),
  };
  if (config.practiceMode) {
    state.events.push({
      kind: 'round_start',
      by: 0,
      x: 0,
      y: 1,
      z: 0,
      power: 0.5,
      text: 'PRACTICE MODE',
    });
  }
  return state;
}

export function resetRound(state: MatchState, nextRoundNumber: number): void {
  const [f0, f1] = state.fighters;
  const fresh0 = createFighter(0, state.config.p1, state.config.p1Costume);
  const fresh1 = createFighter(1, state.config.p2, state.config.p2Costume);
  Object.assign(f0, fresh0);
  Object.assign(f1, fresh1);
  state.phase = state.config.practiceMode ? 'fight' : 'intro';
  state.phaseFrame = 0;
  state.timerFrames = ROUND_DURATION_FRAMES;
  state.hitstopFrames = 0;
  state.rageFreezeFrames = 0;
  state.rageFreezeBy = null;
  state.slowMoFrames = 0;
  state.roundNumber = nextRoundNumber;
  state.roundWinner = null;
  state.perfectRound = false;
}

export function totalMoveFrames(m: MoveData): number {
  return m.startup + m.active + m.recovery;
}

export function isMoveStartup(f: FighterSim): boolean {
  return f.state === 'attack' && f.activeMove !== null && f.stateFrame < f.activeMove.startup;
}

export function isMoveActive(f: FighterSim): boolean {
  return (
    f.state === 'attack' &&
    f.activeMove !== null &&
    f.stateFrame >= f.activeMove.startup &&
    f.stateFrame < f.activeMove.startup + f.activeMove.active
  );
}

export function isMoveRecovery(f: FighterSim): boolean {
  return (
    f.state === 'attack' &&
    f.activeMove !== null &&
    f.stateFrame >= f.activeMove.startup + f.activeMove.active
  );
}

function startAttack(state: MatchState, f: FighterSim, opp: FighterSim, move: MoveData): void {
  f.state = 'attack';
  f.stateFrame = 0;
  f.activeMove = move;
  f.hitRegistered = false;
  f.queuedStringMask = 0;
  f.crouching = move.height === 'low';
  f.sidestepFrames = 0;
  f.dashFrames = 0;
  f.dashDir = 0;
  f.vx = 0;
  f.vz = 0;

  // Tekken 3D tracking alignment on attack startup (unless opponent is actively sidestepping!)
  if (opp.sidestepFrames <= 0) {
    const dz = opp.z - f.z;
    const cap = move.homing ? 0.55 : 0.28;
    f.z += Math.sign(dz) * Math.min(Math.abs(dz), cap);
  }
  if (Math.abs(opp.x - f.x) > 0.04) {
    f.facing = opp.x >= f.x ? 1 : -1;
  }
  if (move.id === 'uni_uf4') {
    f.vy = 0.095;
  }

  if (move.electric) {
    state.events.push({
      kind: 'electric',
      by: f.index,
      x: f.x + f.facing * 0.45,
      y: 1.15,
      z: f.z,
      power: 0.75,
    });
  }
}

function tryPickAttack(
  state: MatchState,
  f: FighterSim,
  opp: FighterSim,
  relDir: number,
  pressedMask: number,
  heldMask: number,
): boolean {
  const char = f.char;
  const bothPunches = (heldMask & 3) === 3 && (pressedMask & 3) !== 0;
  const bothKicks = (heldMask & 12) === 12 && (pressedMask & 12) !== 0;
  const lightThrow = (heldMask & 5) === 5 && (pressedMask & 5) !== 0; // 1+3
  const heavyThrow = (heldMask & 10) === 10 && (pressedMask & 10) !== 0; // 2+4

  // 1+2: Rage Art in Rage, or Power Crush otherwise
  if (bothPunches) {
    if (f.rageActive && !f.rageArtUsed) {
      f.rageArtUsed = true;
      startAttack(state, f, opp, char.rageArt);
      state.rageFreezeFrames = 26;
      state.rageFreezeBy = f.index;
      state.events.push({
        kind: 'rage_art_start',
        by: f.index,
        x: f.x,
        y: 1.2,
        z: f.z,
        power: 1.0,
        text: char.rageArt.name,
      });
      return true;
    }
    startAttack(state, f, opp, char.powerCrush);
    return true;
  }

  // 3+4: Ki / Heat Special Burst
  if (bothKicks) {
    if (!f.kiUsed) {
      f.kiUsed = true;
      f.kiFrames = KI_HEAT_FRAMES;
    }
    startAttack(state, f, opp, char.kiSpecial);
    return true;
  }

  // 1+3 / 2+4 Grounded Throws
  if (lightThrow) {
    startAttack(state, f, opp, char.throws[0]);
    return true;
  }
  if (heavyThrow) {
    startAttack(state, f, opp, char.throws[1]);
    return true;
  }

  // Command Specials (checked longest/strictest notation first)
  for (let i = 0; i < char.specials.length; i += 1) {
    const spec = char.specials[i];
    if (f.buffer.matches(spec.notation)) {
      startAttack(state, f, opp, spec.move);
      return true;
    }
  }

  // Universal Tekken Directional Normals (d/f+2 Launcher, u/f+4 Hopkick, d/f+1 Mid, d+1/d+2 Low Jab, d+3/d+4 Low Sweep!)
  if (relDir === 3) {
    if (pressedMask & 2) {
      startAttack(state, f, opp, UNIVERSAL_DF2_UPPER);
      return true;
    }
    if (pressedMask & 1) {
      startAttack(state, f, opp, UNIVERSAL_DF1_MID);
      return true;
    }
  }
  if ((relDir === 9 || relDir === 8) && (pressedMask & 8)) {
    startAttack(state, f, opp, UNIVERSAL_UF4_HOPKICK);
    return true;
  }
  if (relDir === 1 || relDir === 2 || f.crouching) {
    if (pressedMask & 12) {
      startAttack(state, f, opp, UNIVERSAL_LOW_KICK);
      return true;
    }
    if (pressedMask & 3) {
      startAttack(state, f, opp, UNIVERSAL_CROUCH_JAB);
      return true;
    }
  }

  // 4-Limb Standing Normals
  if (pressedMask & 1) {
    startAttack(state, f, opp, char.normals.lp);
    return true;
  }
  if (pressedMask & 2) {
    startAttack(state, f, opp, char.normals.rp);
    return true;
  }
  if (pressedMask & 4) {
    startAttack(state, f, opp, char.normals.lk);
    return true;
  }
  if (pressedMask & 8) {
    startAttack(state, f, opp, char.normals.rk);
    return true;
  }
  return false;
}

function tryStringCancel(state: MatchState, f: FighterSim, opp: FighterSim, pressedMask: number): boolean {
  const cur = f.activeMove;
  if (!cur || !cur.next || cur.next.length === 0) return false;
  if (pressedMask !== 0) {
    f.queuedStringMask |= pressedMask;
  }
  if (f.queuedStringMask === 0) return false;

  const cancelStart = cur.startup + cur.active - 1;
  const cancelEnd = cur.startup + cur.active + STRING_CANCEL_WINDOW;
  if (f.stateFrame < cancelStart || f.stateFrame > cancelEnd) return false;

  const mask = f.queuedStringMask;
  for (let i = 0; i < cur.next.length; i += 1) {
    const branch = cur.next[i];
    const bit =
      branch.button === 'lp'
        ? 1
        : branch.button === 'rp'
          ? 2
          : branch.button === 'lk'
            ? 4
            : 8;
    if ((mask & bit) !== 0) {
      startAttack(state, f, opp, branch.move);
      return true;
    }
  }
  return false;
}

function stepFighterIntent(
  state: MatchState,
  f: FighterSim,
  opp: FighterSim,
  inp: RawInputFrame,
): void {
  const heldMask = buttonsToMask(inp.buttons);
  const pressedMask = heldMask & ~f.prevMask;
  f.prevMask = heldMask;

  // Update facing when grounded and neutral (always valid even near stage walls!)
  if (f.state === 'idle' || f.state === 'walk' || f.state === 'sidestep') {
    if (Math.abs(opp.x - f.x) > 0.02) {
      f.facing = opp.x >= f.x ? 1 : -1;
    } else {
      f.facing = f.index === 0 ? 1 : -1;
    }
  }

  const fwd = (inp.x * f.facing) as -1 | 0 | 1;
  const relDir = toRelativeDir(fwd, inp.z);
  f.buffer.push(relDir, pressedMask, heldMask);

  if (f.kiFrames > 0) f.kiFrames -= 1;
  if (f.armorFlashFrames > 0) f.armorFlashFrames -= 1;

  // Check Throw Break while being grabbed!
  if (f.state === 'thrown' && f.pendingThrow !== null) {
    if (
      f.stateFrame <= THROW_BREAK_WINDOW &&
      (pressedMask & f.pendingThrow.breakMask) !== 0
    ) {
      const atk = state.fighters[f.pendingThrow.attackerIdx];
      f.pendingThrow = null;
      f.state = 'idle';
      f.stateFrame = 0;
      f.vx = -f.facing * 0.12;
      atk.state = 'idle';
      atk.stateFrame = 0;
      atk.activeMove = null;
      atk.vx = -atk.facing * 0.12;
      state.hitstopFrames = 6;
      state.events.push({
        kind: 'throw_break',
        by: f.index,
        x: (f.x + atk.x) * 0.5,
        y: 1.15,
        z: (f.z + atk.z) * 0.5,
        power: 0.65,
        text: 'THROW BREAK!',
      });
      return;
    }

    f.stateFrame += 1;
    if (f.stateFrame >= THROW_CONNECT_FRAMES) {
      const dmg = f.pendingThrow.damage;
      const atk = state.fighters[f.pendingThrow.attackerIdx];
      f.pendingThrow = null;
      applyDamage(state, atk, f, dmg, false);
      if (f.hp > 0) {
        f.state = 'knockdown';
        f.stateFrame = 0;
      }
      f.vx = -f.facing * 0.16;
      state.hitstopFrames = 9;
      state.events.push({
        kind: 'throw_slam',
        by: atk.index,
        x: f.x,
        y: 0.4,
        z: f.z,
        power: 0.9,
        text: 'SLAM!',
      });
    }
    return;
  }

  // KO state
  if (f.state === 'ko') {
    if (f.y > 0 || f.vy !== 0) {
      const jug = wasmStepJuggle(f.y, f.vy, GRAVITY, 2);
      f.y = jug.y;
      f.vy = jug.vy;
    }
    f.x += f.vx;
    f.vx *= 0.86;
    f.stateFrame += 1;
    return;
  }

  // Airborne Juggle state (driven by WebAssembly ballistics!)
  if (f.state === 'juggle') {
    f.x += f.vx;
    f.vx *= 0.92;
    const jug = wasmStepJuggle(f.y, f.vy, GRAVITY, f.juggleHits);
    f.y = jug.y;
    f.vy = jug.vy;
    f.stateFrame += 1;
    if (jug.landed) {
      f.juggleHits = 0;
      f.boundUsed = false;
      f.wallSplatUsed = false;
      f.vx = 0;
      f.state = 'knockdown';
      f.stateFrame = 0;
      opp.comboCounter = 0;
      opp.comboDamage = 0;
    }
    return;
  }

  // Knockdown / Wake-up
  if (f.state === 'knockdown') {
    f.x += f.vx;
    f.vx *= 0.84;
    f.stateFrame += 1;
    // Quick tech-roll on button press after frame 26
    const wakeTarget = pressedMask !== 0 && f.stateFrame > 26 ? 28 : KNOCKDOWN_FRAMES;
    if (f.stateFrame >= wakeTarget) {
      f.state = 'idle';
      f.stateFrame = 0;
      if (pressedMask !== 0) {
        // Slight Z tech roll
        f.z += f.z >= 0 ? -0.35 : 0.35;
      }
      opp.comboCounter = 0;
      opp.comboDamage = 0;
    }
    return;
  }

  // Hitstun / Blockstun
  if (f.state === 'hitstun' || f.state === 'blockstun') {
    f.x += f.vx;
    f.vx *= 0.82;
    f.stunFrames -= 1;
    f.stateFrame += 1;
    if (f.stunFrames <= 0) {
      const wasHit = f.state === 'hitstun';
      f.state = 'idle';
      f.stateFrame = 0;
      if (wasHit) {
        opp.comboCounter = 0;
        opp.comboDamage = 0;
      }
    }
    return;
  }

  // Jumping state
  if (f.state === 'jump') {
    f.x += f.vx;
    const jug = wasmStepJuggle(f.y, f.vy, GRAVITY, 0);
    f.y = jug.y;
    f.vy = jug.vy;
    f.stateFrame += 1;

    // Allow jumping Hopkick / Flying Attack in air!
    if (pressedMask !== 0 && f.y > 0.25) {
      if (pressedMask & 8) startAttack(state, f, opp, UNIVERSAL_UF4_HOPKICK);
      else if (pressedMask & 4) startAttack(state, f, opp, f.char.normals.lk);
      else if (pressedMask & 2) startAttack(state, f, opp, f.char.normals.rp);
      else startAttack(state, f, opp, f.char.normals.lp);
      return;
    }

    if (jug.landed) {
      f.vx = 0;
      f.state = 'idle';
      f.stateFrame = 0;
    }
    return;
  }

  // Active Attack state
  if (f.state === 'attack' && f.activeMove !== null) {
    // Keep airborne momentum if attack started mid-jump
    if (f.y > 0 || f.vy !== 0) {
      const jug = wasmStepJuggle(f.y, f.vy, GRAVITY, 0);
      f.y = jug.y;
      f.vy = jug.vy;
    }
    // Forward dash momentum along true 3D Fighter-to-Fighter Axis during startup
    if (f.activeMove.advance && f.stateFrame < f.activeMove.startup) {
      moveAlongCombatAxis(f, opp, f.activeMove.advance / f.activeMove.startup);
    }

    if (tryStringCancel(state, f, opp, pressedMask)) {
      return;
    }

    f.stateFrame += 1;
    if (f.stateFrame >= totalMoveFrames(f.activeMove)) {
      if (!f.hitRegistered) {
        state.events.push({
          kind: 'whiff',
          by: f.index,
          x: f.x + f.facing * 0.6,
          y: 1.1,
          z: f.z,
          power: 0.2,
        });
      }
      f.activeMove = null;
      f.crouching = false;
      f.state = 'idle';
      f.stateFrame = 0;
    }
    return;
  }

  // Active 3D Sidestep state
  if (f.state === 'sidestep') {
    f.z += f.sidestepDir * f.char.sidestepSpeed * 1.35;
    f.sidestepFrames -= 1;
    f.stateFrame += 1;
    // Allow sidestep cancel into attack!
    if (pressedMask !== 0 && tryPickAttack(state, f, opp, relDir, pressedMask, heldMask)) {
      return;
    }
    if (f.sidestepFrames <= 0) {
      f.sidestepDir = 0;
      f.state = 'idle';
      f.stateFrame = 0;
    }
    return;
  }

  // Neutral Grounded (Idle / Walk / Dash): Check attacks first!
  if (pressedMask !== 0 && tryPickAttack(state, f, opp, relDir, pressedMask, heldMask)) {
    return;
  }

  // Active Forward Dash (f,f) or Korean Backdash (b,b) burst along 3D lock-on axis!
  if (f.dashFrames > 0) {
    f.dashFrames -= 1;
    const burstSpeed =
      f.dashDir > 0 ? f.char.walkSpeed * 2.05 : f.char.backSpeed * 2.15;
    moveAlongCombatAxis(f, opp, f.dashDir * burstSpeed);
    f.state = 'walk';
    f.stateFrame += 1;
    if (f.dashFrames <= 0) {
      f.dashDir = 0;
    }
    return;
  }

  // Detect Double-Tap Forward Dash (f,f) or Backdash (b,b)
  if (!f.crouching && inp.z === 0 && inp.x !== 0) {
    if (fwd > 0 && f.buffer.matches('f,f')) {
      f.dashFrames = 11;
      f.dashDir = 1;
      f.state = 'walk';
      f.stateFrame = 0;
      moveAlongCombatAxis(f, opp, f.char.walkSpeed * 2.05);
      return;
    }
    if (fwd < 0 && f.buffer.matches('b,b')) {
      f.dashFrames = 10;
      f.dashDir = -1;
      f.state = 'walk';
      f.stateFrame = 0;
      moveAlongCombatAxis(f, opp, -f.char.backSpeed * 2.15);
      return;
    }
  }

  // Track vertical hold vs tap for 3D Sidestep vs Crouch / Jump!
  if (inp.z < 0) {
    f.holdDownFrames += 1;
    if (f.holdDownFrames >= CROUCH_THRESHOLD_FRAMES) {
      f.crouching = true;
    }
  } else {
    if (f.holdDownFrames > 0 && f.holdDownFrames < CROUCH_THRESHOLD_FRAMES) {
      // Quick down tap => 3D Sidestep Foreground (-Z)!
      f.state = 'sidestep';
      f.stateFrame = 0;
      f.sidestepDir = -1;
      f.sidestepFrames = SIDESTEP_TOTAL_FRAMES;
      f.holdDownFrames = 0;
      f.crouching = false;
      return;
    }
    f.holdDownFrames = 0;
    f.crouching = false;
  }

  if (inp.z > 0) {
    f.holdUpFrames += 1;
    if (f.holdUpFrames >= JUMP_THRESHOLD_FRAMES) {
      f.holdUpFrames = 0;
      f.crouching = false;
      f.state = 'jump';
      f.stateFrame = 0;
      f.vy = JUMP_VELOCITY;
      f.vx = inp.x * f.char.walkSpeed * 1.15;
      return;
    }
  } else {
    if (f.holdUpFrames > 0 && f.holdUpFrames < JUMP_THRESHOLD_FRAMES) {
      // Quick up tap => 3D Sidestep Background (+Z)!
      f.state = 'sidestep';
      f.stateFrame = 0;
      f.sidestepDir = 1;
      f.sidestepFrames = SIDESTEP_TOTAL_FRAMES;
      f.holdUpFrames = 0;
      return;
    }
    f.holdUpFrames = 0;
  }

  // True Tekken 3D Lock-On Walk (fwd > 0 steps straight toward opponent in 3D; fwd < 0 steps away!)
  if (!f.crouching && inp.x !== 0) {
    const speed = fwd > 0 ? f.char.walkSpeed : f.char.backSpeed;
    moveAlongCombatAxis(f, opp, fwd * speed);
    if (f.state !== 'walk') {
      f.state = 'walk';
      f.stateFrame = 0;
    } else {
      f.stateFrame += 1;
    }
  } else {
    if (f.state !== 'idle') {
      f.state = 'idle';
      f.stateFrame = 0;
    } else {
      f.stateFrame += 1;
    }
  }
}

function applyDamage(
  state: MatchState,
  atk: FighterSim,
  def: FighterSim,
  dmg: number,
  recoverable: boolean,
): void {
  if (state.config.practiceMode) {
    def.hp = Math.max(1, def.hp - dmg);
  } else {
    def.hp = Math.max(0, def.hp - dmg);
  }
  if (!recoverable) {
    def.recoverableHp = Math.max(def.hp, def.recoverableHp - Math.ceil(dmg * 0.65));
  }

  // Activate Tekken Rage when dropping to <= 25% HP!
  if (!def.rageActive && def.hp > 0 && def.hp <= def.char.maxHp * RAGE_HP_FRACTION) {
    def.rageActive = true;
    state.events.push({
      kind: 'rage_activate',
      by: def.index,
      x: def.x,
      y: 1.1,
      z: def.z,
      power: 0.85,
      text: 'RAGE!',
    });
  }

  if (def.hp <= 0) {
    def.state = 'ko';
    def.stateFrame = 0;
    def.activeMove = null;
    def.vy = 0.11;
    def.vx = atk.facing * 0.14;
    state.hitstopFrames = 14;
    state.slowMoFrames = 42;
    state.events.push({
      kind: 'ko',
      by: atk.index,
      x: def.x,
      y: 1.0,
      z: def.z,
      power: 1.0,
      text: 'K.O.!',
    });
  }
}

function isDefenderBlocking(
  state: MatchState,
  def: FighterSim,
  inp: RawInputFrame,
  move: MoveData,
): boolean {
  if (move.unblockable || move.isThrow) return false;
  if (
    def.state !== 'idle' &&
    def.state !== 'walk' &&
    def.state !== 'blockstun'
  ) {
    return false;
  }

  // Practice mode Guard All dummy
  if (
    state.config.practiceMode &&
    def.index === 1 &&
    state.config.dummyBehavior === 'guard_all'
  ) {
    return true;
  }

  const holdingBack = inp.x * def.facing === -1 || def.dashDir === -1;
  if (!holdingBack) return false;

  if (move.height === 'low') {
    return def.crouching || inp.z < 0;
  }
  if (move.height === 'mid') {
    return !def.crouching;
  }
  // High attacks: blocked standing, ducked crouching
  return !def.crouching;
}

function resolveAttackHit(
  state: MatchState,
  atk: FighterSim,
  def: FighterSim,
  defInput: RawInputFrame,
  wallMask: number,
): void {
  const move = atk.activeMove;
  if (move === null || atk.hitRegistered || !isMoveActive(atk)) return;
  if (def.state === 'ko' || def.state === 'knockdown' || def.state === 'thrown') return;

  // High-Crush: Low crouching attacks automatically duck under High attacks!
  const defHighCrushing =
    def.crouching || (def.state === 'attack' && def.activeMove?.height === 'low');

  const wasm = getCombatWasm();
  const connects = wasm.check_3d_hit(
    atk.x,
    atk.y,
    atk.z,
    atk.facing,
    move.reach,
    BASE_HIT_DEPTH,
    heightToCode(move.height),
    move.homing ? 1 : 0,
    def.x,
    def.y,
    def.z,
    defHighCrushing ? 1 : 0,
    def.sidestepFrames,
  );

  if (connects === 0) {
    // Emit crisp SIDESTEP EVADE! callout if defender actively dodged an in-range linear strike
    if (
      def.sidestepFrames > 0 &&
      !move.homing &&
      atk.stateFrame === move.startup &&
      Math.hypot(def.x - atk.x, def.z - atk.z) <= move.reach + 0.35
    ) {
      state.events.push({
        kind: 'sidestep_evade',
        by: def.index,
        x: def.x,
        y: 1.15,
        z: def.z,
        power: 0.55,
        text: 'SIDESTEP EVADE!',
      });
    }
    return;
  }

  atk.hitRegistered = true;
  const hitX = (atk.x + def.x) * 0.5;
  const hitY = move.height === 'low' ? 0.35 : move.height === 'mid' ? 1.05 : 1.45;
  const hitZ = (atk.z + def.z) * 0.5;

  // Grounded Throw Connection
  if (move.isThrow) {
    if (def.y > 0.08 || def.crouching) return;
    const isHeavy = move === atk.char.throws[1];
    def.state = 'thrown';
    def.stateFrame = 0;
    def.activeMove = null;
    def.pendingThrow = {
      damage: move.damage,
      breakMask: isHeavy ? 2 : 1,
      attackerIdx: atk.index,
    };
    state.events.push({
      kind: 'throw_grab',
      by: atk.index,
      x: hitX,
      y: 1.2,
      z: hitZ,
      power: 0.5,
      text: isHeavy ? 'THROW! (BREAK: 2)' : 'THROW! (BREAK: 1)',
    });
    return;
  }

  // Check Blocking
  if (isDefenderBlocking(state, def, defInput, move)) {
    def.state = 'blockstun';
    def.stateFrame = 0;
    def.stunFrames = move.blockstun;
    def.vx = atk.facing * move.pushback * 0.095;

    // Frame advantage = defender blockstun - attacker remaining frames
    const remAtk = totalMoveFrames(move) - atk.stateFrame - 1;
    atk.lastFrameAdvantage = move.blockstun - remAtk;
    def.lastFrameAdvantage = -atk.lastFrameAdvantage;

    // Chip damage in Ki/Heat or Rage Art
    if (atk.kiFrames > 0 || move === atk.char.rageArt) {
      const chip = Math.max(1, Math.round(move.damage * 0.16));
      def.hp = Math.max(1, def.hp - chip);
    }

    state.hitstopFrames = Math.min(8, 3 + Math.floor(move.damage / 10));
    state.events.push({
      kind: 'block',
      by: atk.index,
      x: hitX,
      y: hitY,
      z: hitZ,
      power: Math.min(1, move.damage / 35),
    });
    return;
  }

  // Check Defender Power Crush / Rage Art Armor (absorbs High & Mid hits after frame 5!)
  if (
    def.state === 'attack' &&
    def.activeMove?.armor &&
    def.stateFrame >= 5 &&
    move.height !== 'low' &&
    !move.isThrow
  ) {
    const reduced = Math.max(1, Math.round(move.damage * 0.45));
    applyDamage(state, atk, def, reduced, true);
    def.armorFlashFrames = 10;
    state.hitstopFrames = 6;
    state.events.push({
      kind: 'armor_absorb',
      by: def.index,
      x: def.x,
      y: 1.15,
      z: def.z,
      power: 0.7,
      text: 'POWER CRUSH!',
    });
    return;
  }

  // Counter-Hit & Whiff-Punish checks!
  const isCounter = isMoveStartup(def);
  const isWhiffPunish = !isCounter && isMoveRecovery(def) && def.juggleHits === 0;
  const wasAirborne = def.state === 'juggle' || def.y > 0.1;

  const baseComputed = wasm.compute_combo_damage(
    move.damage,
    wasAirborne ? def.juggleHits : atk.comboCounter,
    atk.rageActive ? 1 : 0,
    isCounter ? 1 : 0,
    atk.kiFrames > 0 ? 1 : 0,
  );
  const finalDamage = isWhiffPunish ? Math.round(baseComputed * 1.15) : baseComputed;

  atk.comboCounter += 1;
  atk.comboDamage += finalDamage;

  const remAtk = totalMoveFrames(move) - atk.stateFrame - 1;
  const effectiveHitstun = move.hitstun + (isCounter ? 6 : 0);
  atk.lastFrameAdvantage = effectiveHitstun - remAtk;
  def.lastFrameAdvantage = -atk.lastFrameAdvantage;

  applyDamage(state, atk, def, finalDamage, false);
  if (def.hp <= 0) return;

  def.activeMove = null;
  state.hitstopFrames = Math.min(11, 4 + Math.floor(move.damage / 7) + (isCounter ? 3 : 0));

  // Wall Splat Check (if defender is against arena X boundary & hit by heavy pushback!)
  const defBit = def.index === 0 ? 1 : 2;
  const atWall = state.config.stage.hasWalls && (wallMask & defBit) !== 0;

  if (atWall && !def.wallSplatUsed && (move.pushback >= 0.55 || move.knockdown || wasAirborne)) {
    def.wallSplatUsed = true;
    applyDamage(state, atk, def, WALL_SPLAT_DAMAGE, false);
    atk.comboDamage += WALL_SPLAT_DAMAGE;
    if (def.hp > 0) {
      def.state = 'hitstun';
      def.stateFrame = 0;
      def.stunFrames = WALL_SPLAT_STUN;
      def.y = 0;
      def.vy = 0;
      def.vx = 0;
    }
    state.hitstopFrames = 10;
    state.events.push({
      kind: 'wall_splat',
      by: atk.index,
      x: def.x,
      y: 1.15,
      z: def.z,
      power: 0.95,
      text: 'WALL SPLAT!',
    });
    return;
  }

  // Bound / Tornado Smash on Airborne Opponent!
  if (wasAirborne && move.bound && !def.boundUsed && def.juggleHits < MAX_JUGGLE_HITS) {
    def.boundUsed = true;
    def.juggleHits += 1;
    def.state = 'juggle';
    def.stateFrame = 0;
    def.vy = BOUND_VY;
    def.vx = atk.facing * 0.055;
    state.events.push({
      kind: 'bound',
      by: atk.index,
      x: def.x,
      y: 0.5,
      z: def.z,
      power: 0.85,
      text: 'TORNADO BOUND!',
    });
    return;
  }

  // Launcher or Continuing Aerial Juggle!
  if (move.launch || (wasAirborne && def.juggleHits < MAX_JUGGLE_HITS)) {
    def.state = 'juggle';
    def.stateFrame = 0;
    if (wasAirborne) {
      def.juggleHits += 1;
      def.vy = Math.max(0.085, 0.135 - def.juggleHits * 0.012);
      def.vx = atk.facing * (0.04 + move.pushback * 0.05);
    } else {
      def.juggleHits = 1;
      def.vy = move.launchVy ?? DEFAULT_LAUNCH_VY;
      def.vx = atk.facing * 0.045;
      state.events.push({
        kind: 'launch',
        by: atk.index,
        x: hitX,
        y: hitY,
        z: hitZ,
        power: 0.85,
        text: move.electric ? 'ELECTRIC LAUNCH!' : 'LAUNCH!',
      });
    }
  } else if (move.knockdown) {
    def.state = 'knockdown';
    def.stateFrame = 0;
    def.vx = atk.facing * move.pushback * 0.14;
  } else {
    def.state = 'hitstun';
    def.stateFrame = 0;
    def.stunFrames = effectiveHitstun;
    def.vx = atk.facing * move.pushback * 0.1;
  }

  state.events.push({
    kind: isCounter ? 'counter_hit' : isWhiffPunish ? 'whiff_punish' : 'hit',
    by: atk.index,
    x: hitX,
    y: hitY,
    z: hitZ,
    power: Math.min(1, finalDamage / 32),
    text: isCounter
      ? 'COUNTER HIT!'
      : isWhiffPunish
        ? 'WHIFF PUNISH!'
        : move.electric
          ? 'ELECTRIC!'
          : undefined,
  });
}

/**
 * Advances the deterministic 60Hz fight simulation by one tick.
 */
export function stepMatch(
  state: MatchState,
  input0: RawInputFrame,
  input1: RawInputFrame,
): void {
  const [f0, f1] = state.fighters;

  // Record previous positions for smooth render(alpha) interpolation!
  f0.prevX = f0.x;
  f0.prevY = f0.y;
  f0.prevZ = f0.z;
  f1.prevX = f1.x;
  f1.prevY = f1.y;
  f1.prevZ = f1.z;

  state.tick += 1;

  // Practice mode regeneration when both fighters are neutral
  if (state.config.practiceMode) {
    if (f0.state === 'idle' && f1.state === 'idle' && f1.comboCounter === 0 && f0.comboCounter === 0) {
      if (!f0.rageActive && f0.hp < f0.char.maxHp) f0.hp = Math.min(f0.char.maxHp, f0.hp + 2);
      if (f1.hp < f1.char.maxHp) f1.hp = Math.min(f1.char.maxHp, f1.hp + 2);
      f0.recoverableHp = f0.char.maxHp;
      f1.recoverableHp = f1.char.maxHp;
    }
  }

  // Round Intro Phase ("GET READY... ROUND X... FIGHT!")
  if (state.phase === 'intro') {
    state.phaseFrame += 1;
    if (state.phaseFrame === 1) {
      state.events.push({
        kind: 'round_start',
        by: 0,
        x: 0,
        y: 1.2,
        z: 0,
        power: 0.6,
        text: `ROUND ${state.roundNumber}`,
      });
    }
    if (state.phaseFrame >= INTRO_DURATION_FRAMES) {
      state.phase = 'fight';
      state.phaseFrame = 0;
      state.events.push({
        kind: 'round_start',
        by: 0,
        x: 0,
        y: 1.2,
        z: 0,
        power: 1.0,
        text: 'FIGHT!',
      });
    }
    return;
  }

  // Round Over / Match Over Phase
  if (state.phase === 'round_over' || state.phase === 'match_over') {
    // Let KO physics settle during slow-mo
    if (state.slowMoFrames > 0) {
      state.slowMoFrames -= 1;
      if (state.tick % 2 === 0) return;
    }
    for (const f of state.fighters) {
      if (f.state === 'ko') {
        const jug = wasmStepJuggle(f.y, f.vy, GRAVITY, 2);
        f.y = jug.y;
        f.vy = jug.vy;
        f.x += f.vx;
        f.vx *= 0.85;
        f.stateFrame += 1;
      } else {
        f.stateFrame += 1;
      }
    }
    const res = wasmResolveCapsules(
      f0.x,
      f0.z,
      f1.x,
      f1.z,
      BODY_SEPARATION,
      state.config.stage.halfWidth,
      state.config.stage.halfDepth,
    );
    f0.x = res.x1;
    f0.z = res.z1;
    f1.x = res.x2;
    f1.z = res.z2;

    state.phaseFrame += 1;
    if (state.phase === 'round_over' && state.phaseFrame >= OUTRO_DURATION_FRAMES) {
      resetRound(state, state.roundNumber + 1);
    }
    return;
  }

  // Super Freeze for Rage Art activation!
  if (state.rageFreezeFrames > 0) {
    state.rageFreezeFrames -= 1;
    if (state.rageFreezeFrames === 0) {
      state.rageFreezeBy = null;
    }
    return;
  }

  // Impact Hitstop Freeze (still buffer inputs so string cancels never drop!)
  if (state.hitstopFrames > 0) {
    const m0 = buttonsToMask(input0.buttons);
    const m1 = buttonsToMask(input1.buttons);
    f0.buffer.push(toRelativeDir((input0.x * f0.facing) as -1 | 0 | 1, input0.z), m0 & ~f0.prevMask, m0);
    f1.buffer.push(toRelativeDir((input1.x * f1.facing) as -1 | 0 | 1, input1.z), m1 & ~f1.prevMask, m1);
    f0.prevMask = m0;
    f1.prevMask = m1;
    state.hitstopFrames -= 1;
    return;
  }

  // Slow-mo frame skipping
  if (state.slowMoFrames > 0) {
    state.slowMoFrames -= 1;
    if (state.tick % 2 === 1) return;
  }

  // Step both fighters
  stepFighterIntent(state, f0, f1, input0);
  stepFighterIntent(state, f1, f0, input1);

  // Resolve 3D Fighter Capsule Separation & Stage Walls in WebAssembly!
  const cap = wasmResolveCapsules(
    f0.x,
    f0.z,
    f1.x,
    f1.z,
    BODY_SEPARATION,
    state.config.stage.halfWidth,
    state.config.stage.halfDepth,
  );
  f0.x = cap.x1;
  f0.z = cap.z1;
  f1.x = cap.x2;
  f1.z = cap.z2;

  // Resolve Attack Hitboxes symmetrically (simultaneous trades supported!)
  const hp0Before = f0.hp;
  const hp1Before = f1.hp;
  resolveAttackHit(state, f0, f1, input1, cap.wallMask);
  if (hp0Before > 0 && hp1Before > 0) {
    resolveAttackHit(state, f1, f0, input0, cap.wallMask);
  }

  // Practice mode never ends rounds
  if (state.config.practiceMode) return;

  // Round Timer
  if (!state.config.infiniteTime && state.timerFrames > 0) {
    state.timerFrames -= 1;
  }

  // Check KO or Time Over
  const ko0 = f0.hp <= 0;
  const ko1 = f1.hp <= 0;
  const timeUp = !state.config.infiniteTime && state.timerFrames <= 0;

  if (ko0 || ko1 || timeUp) {
    let winner: 0 | 1 | 'draw' = 'draw';
    if (ko0 && !ko1) winner = 1;
    else if (ko1 && !ko0) winner = 0;
    else if (timeUp) {
      const pct0 = f0.hp / f0.char.maxHp;
      const pct1 = f1.hp / f1.char.maxHp;
      if (pct0 > pct1 + 0.001) winner = 0;
      else if (pct1 > pct0 + 0.001) winner = 1;
    }

    state.roundWinner = winner;
    if (winner === 0) {
      state.wins[0] += 1;
      state.perfectRound = f0.hp === f0.char.maxHp;
    } else if (winner === 1) {
      state.wins[1] += 1;
      state.perfectRound = f1.hp === f1.char.maxHp;
    }

    const matchDone =
      state.wins[0] >= state.config.roundsToWin ||
      state.wins[1] >= state.config.roundsToWin;
    state.phase = matchDone ? 'match_over' : 'round_over';
    state.phaseFrame = 0;

    state.events.push({
      kind: 'round_win',
      by: winner === 1 ? 1 : 0,
      x: 0,
      y: 1.2,
      z: 0,
      power: 1.0,
      text:
        winner === 'draw'
          ? 'DOUBLE K.O. / DRAW!'
          : state.perfectRound
            ? 'PERFECT!'
            : `${state.fighters[winner].char.name} WINS!`,
    });
  }
}
