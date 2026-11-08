import { describe, expect, it } from 'vitest';
import type { MeshData } from '@driftengine/core';
import {
  getCombatWasm,
  heightToCode,
  wasmResolveCapsules,
  wasmStepJuggle,
} from '../src/wasm/wasmBridge';
import { ROSTER, getCharacterById } from '../src/data/roster';
import { STAGES } from '../src/data/stages';
import {
  CommandInputBuffer,
  createEmptyInput,
  parseNotation,
  type RawInputFrame,
} from '../src/sim/inputs';
import { createMatch, stepMatch } from '../src/sim/combat';
import { CpuController } from '../src/sim/ai';
import { FighterRigAnimator, buildFighterMeshData } from '../src/render/fighterMesh';
import { buildStageGeometry } from '../src/render/stageBuilder';

function assertValidMesh(m: MeshData, skinned: boolean): void {
  const verts = m.positions.length / 3;
  expect(m.normals.length).toBe(m.positions.length);
  expect(m.colors.length).toBe(m.positions.length);
  for (let i = 0; i < m.positions.length; i += 1) {
    if (!Number.isFinite(m.positions[i]) || !Number.isFinite(m.normals[i])) {
      throw new Error(`Non-finite vertex data at ${i}`);
    }
  }
  for (let i = 0; i < m.indices.length; i += 1) {
    if (m.indices[i] >= verts) {
      throw new Error(`Index ${m.indices[i]} out of bounds (${verts})`);
    }
  }
  if (skinned) {
    expect(m.joints?.length).toBe(verts * 4);
    expect(m.weights?.length).toBe(verts * 4);
    for (let v = 0; v < verts; v += 1) {
      const o = v * 4;
      expect(m.joints![o]).toBeLessThan(20);
      const wSum = m.weights![o] + m.weights![o + 1] + m.weights![o + 2] + m.weights![o + 3];
      expect(wSum).toBeCloseTo(1.0, 3);
    }
  }
}

function inp(
  x: -1 | 0 | 1 = 0,
  z: -1 | 0 | 1 = 0,
  btns: Partial<RawInputFrame['buttons']> = {},
): RawInputFrame {
  return {
    x,
    z,
    buttons: {
      lp: Boolean(btns.lp),
      rp: Boolean(btns.rp),
      lk: Boolean(btns.lk),
      rk: Boolean(btns.rk),
    },
  };
}

describe('IRON FIST V — WebAssembly Combat Kernel', () => {
  it('instantiates synchronously and resolves 3D fighter capsule overlap', () => {
    const wasm = getCombatWasm();
    expect(wasm).toBeDefined();

    const sep = wasmResolveCapsules(0.0, 0.0, 0.2, 0.0, 0.82, 7.5, 9.0);
    expect(sep.x1).toBeLessThan(0.0);
    expect(sep.x2).toBeGreaterThan(0.2);
    expect(sep.x2 - sep.x1).toBeCloseTo(0.82, 2);
  });

  it('evaluates 3D hit checks: ducking highs, sidestepping linear moves, and homing tracking', () => {
    const wasm = getCombatWasm();
    const highCode = heightToCode('high'); // 2
    const midCode = heightToCode('mid'); // 1

    // Standing defender in range gets hit by high attack
    expect(
      wasm.check_3d_hit(0, 0, 0, 1, 1.85, 0.55, highCode, 0, 1.4, 0, 0, 0, 0),
    ).toBe(1);
    // Crouching defender ducks under high attack!
    expect(
      wasm.check_3d_hit(0, 0, 0, 1, 1.85, 0.55, highCode, 0, 1.4, 0, 0, 1, 0),
    ).toBe(0);
    // Mid attack hits crouching defender!
    expect(
      wasm.check_3d_hit(0, 0, 0, 1, 1.85, 0.55, midCode, 0, 1.4, 0, 0, 1, 0),
    ).toBe(1);
    // Actively sidestepping defender (dz = 0.85m, sidestepFrames = 10) evades narrow linear jab
    expect(
      wasm.check_3d_hit(0, 0, 0, 1, 1.85, 0.35, midCode, 0, 1.4, 0, 0.85, 0, 10),
    ).toBe(0);
    // Homing move (tracking = 1) catches the sidestepping defender!
    expect(
      wasm.check_3d_hit(0, 0, 0, 1, 1.85, 0.55, midCode, 1, 1.4, 0, 0.85, 0, 10),
    ).toBe(1);
  });

  it('computes Tekken 5 combo scaling, Counter-Hit, Rage, and AI move scoring in WASM', () => {
    const wasm = getCombatWasm();
    expect(wasm.compute_combo_damage(25, 0, 0, 0, 0)).toBe(25);
    // Counter-hit bonus (> 25)
    expect(wasm.compute_combo_damage(25, 0, 0, 1, 0)).toBeGreaterThan(25);
    // Rage bonus (> 25)
    expect(wasm.compute_combo_damage(25, 0, 1, 0, 0)).toBeGreaterThan(25);
    // Combo scaling reduces damage on later juggle hits
    const hit2 = wasm.compute_combo_damage(24, 1, 0, 0, 0);
    const hit5 = wasm.compute_combo_damage(24, 4, 0, 0, 0);
    expect(hit2).toBeLessThan(24);
    expect(hit5).toBeLessThan(hit2);

    // Juggle gravity integration clamps cleanly to ground
    const air = wasmStepJuggle(0.005, -0.05, 0.0084, 2);
    expect(air.y).toBe(0);
    expect(air.landed).toBe(true);

    // Tactical AI scorer rewards optimal range moves over far whiffs
    const goodScore = wasm.score_ai_move(1.6, 0.05, 0, 0, 0, 1.9, 13, 24, 1, 0, 0, 3, 12345);
    const whiffScore = wasm.score_ai_move(4.8, 0.05, 0, 0, 0, 1.4, 13, 24, 2, 0, 0, 3, 12345);
    expect(goodScore).toBeGreaterThan(whiffScore);
  });
});

describe('IRON FIST V — 12-Character Roster, 20-Joint GPU Skinning & 5 Stages', () => {
  it('validates all 12 fighters, costumes, move trees, and procedural 20-joint skinned meshes', () => {
    expect(ROSTER.length).toBe(12);
    const rig = new FighterRigAnimator();
    expect(rig.skeleton.jointCount).toBe(20);

    for (const ch of ROSTER) {
      expect(ch.maxHp).toBeGreaterThanOrEqual(160);
      expect(ch.specials.length).toBeGreaterThanOrEqual(4);
      expect(ch.throws.length).toBe(2);

      for (const costumeIdx of [0, 1] as const) {
        const meshData = buildFighterMeshData(ch, costumeIdx);
        assertValidMesh(meshData, true);
        const vertCount = meshData.positions.length / 3;
        expect(vertCount).toBeGreaterThan(400);
        expect(meshData.indices.length).toBeGreaterThan(900);
        expect(meshData.joints?.length).toBe(vertCount * 4);
        expect(meshData.weights?.length).toBe(vertCount * 4);
      }
    }
  });

  it('builds glitch-free 3D floor & architecture geometry with UVs for all 5 stages', () => {
    expect(STAGES.length).toBe(5);
    for (const st of STAGES) {
      const built = buildStageGeometry(st);
      assertValidMesh(built.floorMesh, false);
      assertValidMesh(built.archMesh, false);
      expect(built.floorMesh.uvs).toBeDefined();
      expect(built.archMesh.uvs).toBeDefined();
      expect(built.floorMesh.positions.length / 3).toBe(24);
      expect(built.archMesh.positions.length / 3).toBeGreaterThan(200);
    }
  });
});

describe('IRON FIST V — 60Hz Deterministic 3D Combat Engine', () => {
  it('parses Tekken Mishima crouch-dash notation (f,d,df+2) and matches buffered inputs', () => {
    const ewgf = parseNotation('f,d,df+2');
    expect(ewgf.map((s) => s.dir)).toEqual([6, 2, 3]);
    expect(ewgf[2].buttonMask).toBe(2);

    const buf = new CommandInputBuffer();
    buf.push(5, 0, 0);
    buf.push(6, 0, 0); // f
    buf.push(5, 0, 0); // n
    buf.push(2, 0, 0); // d
    buf.push(3, 2, 2); // d/f + 2 (RP)

    expect(buf.matches('f,d,df+2')).toBe(true);
  });

  it('executes Throw & Throw Break, Launcher -> Juggle, and Rage Art Super', () => {
    const jinrai = getCharacterById('jinrai');
    const paul = getCharacterById('paul');
    const match = createMatch({
      p1: jinrai,
      p2: paul,
      p1Costume: 0,
      p2Costume: 0,
      stage: STAGES[0],
      roundsToWin: 2,
      infiniteTime: true,
      practiceMode: true,
    });
    match.phase = 'fight';
    const neutral = createEmptyInput();

    // 1) Test Throw (1+3) & Throw Break (1)
    match.fighters[0].x = -0.65;
    match.fighters[1].x = 0.65;
    stepMatch(match, inp(0, 0, { lp: true, lk: true }), neutral);
    let grabbed = false;
    for (let i = 0; i < 18; i += 1) {
      stepMatch(match, neutral, neutral);
      if (match.fighters[1].state === 'thrown') {
        grabbed = true;
        break;
      }
    }
    expect(grabbed).toBe(true);
    // P2 breaks the 1+3 throw by pressing LP (1) inside the 15-frame break window!
    stepMatch(match, neutral, inp(0, 0, { lp: true }));
    expect(match.fighters[1].state).toBe('idle');
    expect(match.fighters[1].hp).toBe(paul.maxHp);

    // 2) Test Launcher (d/f+2) into Airborne Juggle!
    match.hitstopFrames = 0;
    match.fighters[0].state = 'idle';
    match.fighters[0].activeMove = null;
    match.fighters[0].x = -0.75;
    match.fighters[1].x = 0.75;
    stepMatch(match, inp(1, -1, { rp: true }), neutral);
    for (let i = 0; i < 24; i += 1) {
      stepMatch(match, neutral, neutral);
    }
    expect(match.fighters[1].state).toBe('juggle');
    expect(match.fighters[1].y).toBeGreaterThan(0.05);
    expect(match.fighters[0].comboCounter).toBe(1);

    // 3) Test Rage Activation + Rage Art Super (1+2)
    match.fighters[1].y = 0;
    match.fighters[1].vy = 0;
    match.fighters[1].state = 'idle';
    match.fighters[0].state = 'idle';
    match.fighters[0].activeMove = null;
    match.fighters[0].x = -0.75;
    match.fighters[1].x = 0.75;
    match.fighters[0].hp = 35;
    match.fighters[0].rageActive = true;

    const hpBefore = match.fighters[1].hp;
    stepMatch(match, inp(0, 0, { lp: true, rp: true }), neutral);
    for (let i = 0; i < 60; i += 1) {
      stepMatch(match, neutral, neutral);
    }
    expect(match.fighters[0].rageArtUsed).toBe(true);
    expect(match.fighters[1].hp).toBeLessThan(hpBefore - 30);
  });

  it('runs a 600-frame CPU vs CPU battle across WASM AI without NaNs or errors', () => {
    const match = createMatch({
      p1: getCharacterById('kazuma'),
      p2: getCharacterById('jinpachi'),
      p1Costume: 0,
      p2Costume: 0,
      stage: STAGES[2],
      roundsToWin: 2,
      seed: 42,
    });
    match.phase = 'fight';
    const ai1 = new CpuController();
    const ai2 = new CpuController();

    for (let f = 0; f < 600; f += 1) {
      const i1 = ai1.sampleCpu(match, 0, 3);
      const i2 = ai2.sampleCpu(match, 1, 4);
      stepMatch(match, i1, i2);
      match.events.length = 0;
    }

    expect(Number.isFinite(match.fighters[0].x)).toBe(true);
    expect(Number.isFinite(match.fighters[1].x)).toBe(true);
    expect(
      match.fighters[0].hp < match.fighters[0].char.maxHp ||
        match.fighters[1].hp < match.fighters[1].char.maxHp,
    ).toBe(true);
  });
});
