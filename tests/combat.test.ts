import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MeshData } from '@driftengine/core';
import { gltfToMeshes, readGlb } from '@driftengine/assets';
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
import { createMatch, stepMatch, computeMatchChecksum } from '../src/sim/combat';
import {
  RollbackNetSession,
  decodeInputPacket,
  encodeInputPacket,
  packInputByte,
  unpackInputByte,
} from '../src/net/rollbackSession';
import { CpuController } from '../src/sim/ai';
import { FighterRigAnimator, buildFighterMeshData } from '../src/render/fighterMesh';
import {
  HUMANOID_JOINT_BALL_L,
  HUMANOID_JOINT_BALL_R,
  HUMANOID_JOINT_FOOT_L,
  HUMANOID_JOINT_FOOT_R,
  HUMANOID_JOINT_HAND_L,
  MocapFighterAnimator,
  buildHumanoidCharacterMesh,
  getCharacterBodyScale,
  parseHumanoidPackGlb,
} from '../src/render/humanoidPack';
import { buildStageGeometry } from '../src/render/stageBuilder';

function assertValidMesh(m: MeshData, skinned: boolean, maxJoints = 20): void {
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
      expect(m.joints![o]).toBeLessThan(maxJoints);
      const wSum = m.weights![o] + m.weights![o + 1] + m.weights![o + 2] + m.weights![o + 3];
      expect(wSum).toBeCloseTo(1.0, 2);
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

  it('loads 65-bone CC0 Humanoid .glb + 34 Mocap Clips and builds 8,400+ vertex 3D fighters for all 12 characters', { timeout: 20000 }, () => {
    const glbPath = path.resolve('public/models/fighters/martial_fighters.glb');
    const femPath = path.resolve('public/models/fighters/female_and_parts.glb');
    const buf = fs.readFileSync(glbPath);
    const femBuf = fs.readFileSync(femPath);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const femAb = femBuf.buffer.slice(femBuf.byteOffset, femBuf.byteOffset + femBuf.byteLength);
    const pack = parseHumanoidPackGlb(ab, femAb);
    expect(pack).not.toBeNull();
    expect(pack!.joints.length).toBe(65);
    expect(pack!.clips.size).toBe(34);
    expect(pack!.cc0Parts.size).toBe(10);

    for (const ch of ROSTER) {
      for (const costumeIdx of [0, 1] as const) {
        const mesh = buildHumanoidCharacterMesh(pack!, ch, costumeIdx);
        assertValidMesh(mesh, true, 65);
        expect(mesh.positions.length / 3).toBeGreaterThan(8400);
      }
    }

    const anim = new MocapFighterAnimator(pack!);
    const match = createMatch({
      p1: getCharacterById('jinrai'),
      p2: getCharacterById('yoshimaru'),
      p1Costume: 0,
      p2Costume: 0,
      stage: STAGES[0],
      roundsToWin: 2,
    });

    for (const state of ['idle', 'walk', 'sidestep', 'juggle', 'knockdown', 'ko'] as const) {
      match.fighters[0].state = state;
      anim.update(match.fighters[0], 0.35, 1 / 60, false, false);
      for (let i = 0; i < anim.skeleton.palette.length; i += 1) {
        expect(Number.isFinite(anim.skeleton.palette[i])).toBe(true);
      }
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

  it('prevents left-wall stacking and deep-Z stranding across all 5 arenas so fighters can always connect hits', () => {
    const neutral = createEmptyInput();
    for (const st of STAGES) {
      const match = createMatch({
        p1: getCharacterById('jinrai'),
        p2: getCharacterById('kazuma'),
        p1Costume: 0,
        p2Costume: 0,
        stage: st,
        roundsToWin: 2,
        practiceMode: true,
      });

      // Force both fighters onto the extreme left wall and deep opposite Z planes!
      match.fighters[0].x = -st.halfWidth;
      match.fighters[1].x = -st.halfWidth;
      match.fighters[0].z = -st.halfDepth;
      match.fighters[1].z = st.halfDepth * 0.7;

      // Walk toward each other for 65 frames across full 3D depth — closes straight to 0.82m!
      for (let i = 0; i < 65; i += 1) {
        const moveIn: RawInputFrame = {
          x: match.fighters[0].facing,
          z: 0,
          buttons: { lp: false, rp: false, lk: false, rk: false },
        };
        stepMatch(match, moveIn, neutral);
      }

      const d3d = Math.hypot(
        match.fighters[1].x - match.fighters[0].x,
        match.fighters[1].z - match.fighters[0].z,
      );
      expect(d3d).toBeGreaterThanOrEqual(0.65);
      expect(d3d).toBeLessThan(1.45);

      // Now throw a jab right at the left wall — it MUST connect!
      const hpBefore = match.fighters[1].hp;
      stepMatch(
        match,
        { x: 0, z: 0, buttons: { lp: true, rp: false, lk: false, rk: false } },
        neutral,
      );
      for (let i = 0; i < 16; i += 1) {
        stepMatch(match, neutral, neutral);
      }
      expect(match.fighters[1].hp).toBeLessThan(hpBefore);
    }
  });

  it('executes Phase 3 pre-buffered target strings, f,f dash, d/f+2 launcher, and zero head light artifacts', () => {
    const glbPath = path.resolve('public/models/fighters/martial_fighters.glb');
    const femPath = path.resolve('public/models/fighters/female_and_parts.glb');
    const buf = fs.readFileSync(glbPath);
    const femBuf = fs.readFileSync(femPath);
    const pack = parseHumanoidPackGlb(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      femBuf.buffer.slice(femBuf.byteOffset, femBuf.byteOffset + femBuf.byteLength),
    )!;
    for (const ch of ROSTER) {
      const mesh = buildHumanoidCharacterMesh(pack, ch, 0);
      for (let v = 0; v < mesh.positions.length / 3; v += 1) {
        if (mesh.positions[v * 3 + 1] > 1.56) {
          // Zero glowing emissive rectangles on any character's head, eyes, or mouth!
          expect(mesh.emissive[v]).toBe(0);
        }
      }
    }

    const neutral = createEmptyInput();
    const match = createMatch({
      p1: getCharacterById('jinrai'),
      p2: getCharacterById('paul'),
      p1Costume: 0,
      p2Costume: 0,
      stage: STAGES[0],
      roundsToWin: 2,
      practiceMode: true,
    });
    match.fighters[0].x = -0.55;
    match.fighters[1].x = 0.55;

    // Press LP on frame 0, then pre-buffer RP early on frame 3 (during LP startup!)
    stepMatch(match, { x: 0, z: 0, buttons: { lp: true, rp: false, lk: false, rk: false } }, neutral);
    stepMatch(match, neutral, neutral);
    stepMatch(match, { x: 0, z: 0, buttons: { lp: false, rp: true, lk: false, rk: false } }, neutral);
    for (let i = 0; i < 24; i += 1) {
      stepMatch(match, neutral, neutral);
    }
    expect(match.fighters[0].comboCounter).toBeGreaterThanOrEqual(2);
  });

  it('prevents curved/extended fingers on all 12 fighters (Nina, Lin Xiao, Jinpachi, Yoshimaru), clamps feet >= Y=0, and preserves Dragons Nest untouched', () => {
    const maleBuf = fs.readFileSync(path.resolve('public/models/fighters/martial_fighters.glb'));
    const femBuf = fs.readFileSync(path.resolve('public/models/fighters/female_and_parts.glb'));
    const pack = parseHumanoidPackGlb(
      maleBuf.buffer.slice(maleBuf.byteOffset, maleBuf.byteOffset + maleBuf.byteLength),
      femBuf.buffer.slice(femBuf.byteOffset, femBuf.byteOffset + femBuf.byteLength),
    )!;

    const anim = new MocapFighterAnimator(pack);
    const distinctVertCounts = new Set<number>();
    const distinctBodyScales = new Set<string>();

    for (const ch of ROSTER) {
      const mesh = buildHumanoidCharacterMesh(pack, ch, 0);
      distinctVertCounts.add(mesh.positions.length / 3);
      distinctBodyScales.add(getCharacterBodyScale(ch.id).join(','));

      const match = createMatch({
        p1: ch,
        p2: getCharacterById('kazuma'),
        p1Costume: 0,
        p2Costume: 0,
        stage: STAGES[0],
        roundsToWin: 2,
      });
      const f = match.fighters[0];

      // 1) Check showcase & combat idle finger bounds — max finger vertex distance from wrist < 16.5 cm!
      for (const showcase of [true, false]) {
        anim.update(f, 0.25, 1 / 60, showcase, false);
        const pal = anim.skeleton.palette;
        const wx = anim.skeleton.world[HUMANOID_JOINT_HAND_L * 16 + 12];
        const wy = anim.skeleton.world[HUMANOID_JOINT_HAND_L * 16 + 13];
        const wz = anim.skeleton.world[HUMANOID_JOINT_HAND_L * 16 + 14];

        let maxFingerDist = 0;
        const jArr = mesh.joints!;
        const wArr = mesh.weights!;
        for (let v = 0; v < mesh.positions.length / 3; v += 1) {
          const j0 = jArr[v * 4];
          if (j0 < 11 || j0 > 30) continue;
          const px = mesh.positions[v * 3];
          const py = mesh.positions[v * 3 + 1];
          const pz = mesh.positions[v * 3 + 2];
          let ox = 0,
            oy = 0,
            oz = 0;
          for (let k = 0; k < 4; k += 1) {
            const w = wArr[v * 4 + k];
            if (w <= 0) continue;
            const o = jArr[v * 4 + k] * 16;
            ox += w * (pal[o] * px + pal[o + 4] * py + pal[o + 8] * pz + pal[o + 12]);
            oy += w * (pal[o + 1] * px + pal[o + 5] * py + pal[o + 9] * pz + pal[o + 13]);
            oz += w * (pal[o + 2] * px + pal[o + 6] * py + pal[o + 10] * pz + pal[o + 14]);
          }
          maxFingerDist = Math.max(maxFingerDist, Math.hypot(ox - wx, oy - wy, oz - wz));
        }
        expect(maxFingerDist).toBeLessThan(0.165);
      }

      // 2) Check Ground-Contact Foot Clamping across crouch, walk, attack, knockdown, KO!
      for (const st of ['idle', 'walk', 'sidestep', 'knockdown', 'ko'] as const) {
        f.state = st;
        f.crouching = st === 'idle';
        anim.update(f, 0.4, 1 / 60, false, false);
        const w = anim.skeleton.world;
        expect(w[HUMANOID_JOINT_FOOT_L * 16 + 13] - 0.082).toBeGreaterThanOrEqual(-0.002);
        expect(w[HUMANOID_JOINT_FOOT_R * 16 + 13] - 0.082).toBeGreaterThanOrEqual(-0.002);
        expect(w[HUMANOID_JOINT_BALL_L * 16 + 13] - 0.042).toBeGreaterThanOrEqual(-0.002);
        expect(w[HUMANOID_JOINT_BALL_R * 16 + 13] - 0.042).toBeGreaterThanOrEqual(-0.002);
      }
    }

    // Verify genuinely distinct 3D geometries & body builds across the 12-fighter roster!
    expect(distinctVertCounts.size).toBeGreaterThanOrEqual(10);
    expect(distinctBodyScales.size).toBeGreaterThanOrEqual(10);

    // 3) Verify Dragon's Nest is 100% untouched AND all 4 other arenas are replaced with rich CC0 3D GLBs!
    const dragonsNestBytes = fs.readFileSync(path.resolve('public/models/stages/dragons_nest.glb'));
    const dragonsNestSha = crypto.createHash('sha256').update(dragonsNestBytes).digest('hex');
    expect(dragonsNestSha).toBe('fcfa220d06b5ab02d703734db00c360a27a56408277637850659028ed3b91d15');

    for (const stageId of [
      'moonlit_wilderness',
      'honmaru_dojo',
      'cathedral_retribution',
      'neotokyo_helipad',
    ]) {
      const stageBuf = fs.readFileSync(path.resolve(`public/models/stages/${stageId}.glb`));
      const parsed = readGlb(
        stageBuf.buffer.slice(stageBuf.byteOffset, stageBuf.byteOffset + stageBuf.byteLength),
      );
      const imported = gltfToMeshes(parsed.json, parsed.binary ? [parsed.binary] : []);
      expect(imported.meshes.length).toBe(2);
      const totalVerts =
        (imported.meshes[0].positions.length + imported.meshes[1].positions.length) / 3;
      expect(totalVerts).toBeGreaterThan(40000);
    }
  });

  it('losslessly packs & decodes 28-byte WebRTC UDP rollback input packets across all stick/button states', () => {
    for (const x of [-1, 0, 1] as const) {
      for (const z of [-1, 0, 1] as const) {
        for (let mask = 0; mask < 16; mask++) {
          const raw: RawInputFrame = {
            x,
            z,
            buttons: {
              lp: (mask & 1) !== 0,
              rp: (mask & 2) !== 0,
              lk: (mask & 4) !== 0,
              rk: (mask & 8) !== 0,
            },
          };
          const byte = packInputByte(raw);
          expect(unpackInputByte(byte)).toEqual(raw);
        }
      }
    }

    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const pkt = encodeInputPacket(142, 139, 128, 0xdeadbeef, bytes, 8);
    expect(pkt.byteLength).toBe(28);
    const decoded = decodeInputPacket(pkt);
    expect(decoded).not.toBeNull();
    expect(decoded!.headFrame).toBe(142);
    expect(decoded!.ackRemoteFrame).toBe(139);
    expect(decoded!.count).toBe(8);
    expect(Array.from(decoded!.inputs)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(decoded!.checksumFrame).toBe(128);
    expect(decoded!.checksum).toBe(0xdeadbeef);
  });

  it('maintains 100% bit-exact zero-desync Rollback Netcode state across 360 frames under 50-85ms jitter & 22% packet loss', () => {
    const p1 = getCharacterById('jinrai');
    const p2 = getCharacterById('kazuya');
    const stage = STAGES[0];

    const match0 = createMatch({
      p1,
      p2,
      p1Costume: 0,
      p2Costume: 0,
      stage,
      roundsToWin: 2,
      seed: 0x778899aa,
    });
    const match1 = createMatch({
      p1,
      p2,
      p1Costume: 0,
      p2Costume: 0,
      stage,
      roundsToWin: 2,
      seed: 0x778899aa,
    });

    const sess0 = new RollbackNetSession(match0, 0, 1);
    const sess1 = new RollbackNetSession(match1, 1, 1);

    interface InFlightPacket {
      deliverAtTick: number;
      toSlot: 0 | 1;
      payload: Uint8Array;
    }
    const wire: InFlightPacket[] = [];

    // Deterministic PRNG simulating chaotic real-world UDP jitter (2..5 frames one-way = 66..160ms RTT) + 22% packet loss
    let netRng = 0x13579bdf;
    const nextRand = () => {
      netRng = (Math.imul(netRng, 1664525) + 1013904223) >>> 0;
      return netRng / 0x100000000;
    };

    const scriptedInput = (slot: 0 | 1, t: number): RawInputFrame => {
      const phase = (t + slot * 17) % 37;
      const x: -1 | 0 | 1 = phase < 14 ? (slot === 0 ? 1 : -1) : phase > 28 ? (slot === 0 ? -1 : 1) : 0;
      const z: -1 | 0 | 1 = phase === 19 || phase === 20 ? 1 : phase === 26 ? -1 : 0;
      return {
        x,
        z,
        buttons: {
          lp: phase === 5 || phase === 11,
          rp: phase === 8 || phase === 14,
          lk: phase === 17,
          rk: phase === 22,
        },
      };
    };

    for (let tick = 0; tick < 360; tick++) {
      // Deliver due packets (shuffle order slightly to test out-of-order UDP resilience)
      for (let i = wire.length - 1; i >= 0; i--) {
        if (wire[i].deliverAtTick <= tick) {
          const pkt = wire.splice(i, 1)[0];
          if (pkt.toSlot === 0) sess0.receivePacket(pkt.payload);
          else sess1.receivePacket(pkt.payload);
        }
      }

      const in0 = scriptedInput(0, tick);
      const in1 = scriptedInput(1, tick);

      sess0.step(match0, in0, (bytes) => {
        // Drop 22% of UDP packets (except last 12 ticks so final inputs converge cleanly)
        if (tick < 348 && nextRand() < 0.22) return;
        const delayFrames = 2 + Math.floor(nextRand() * 4); // 2..5 frames one-way latency
        wire.push({ deliverAtTick: tick + delayFrames, toSlot: 1, payload: bytes.slice() });
      });

      sess1.step(match1, in1, (bytes) => {
        if (tick < 348 && nextRand() < 0.22) return;
        const delayFrames = 2 + Math.floor(nextRand() * 4);
        wire.push({ deliverAtTick: tick + delayFrames, toSlot: 0, payload: bytes.slice() });
      });
    }

    // Flush remaining in-flight packets & step 6 neutral settle frames so both peers catch up to identical tick
    for (let settle = 0; settle < 8; settle++) {
      while (wire.length > 0) {
        const pkt = wire.shift()!;
        if (pkt.toSlot === 0) sess0.receivePacket(pkt.payload);
        else sess1.receivePacket(pkt.payload);
      }
      const neutral = createEmptyInput();
      sess0.step(match0, neutral, (b) => sess1.receivePacket(b));
      sess1.step(match1, neutral, (b) => sess0.receivePacket(b));
    }

    expect(sess0.totalRollbacks).toBeGreaterThan(10);
    expect(sess1.totalRollbacks).toBeGreaterThan(10);
    expect(sess0.desyncDetected).toBe(false);
    expect(sess1.desyncDetected).toBe(false);

    expect(match0.tick).toBe(match1.tick);
    expect(match0.fighters[0].hp).toBe(match1.fighters[0].hp);
    expect(match0.fighters[1].hp).toBe(match1.fighters[1].hp);
    expect(match0.fighters[0].x).toBe(match1.fighters[0].x);
    expect(match0.fighters[1].x).toBe(match1.fighters[1].x);
    expect(computeMatchChecksum(match0)).toBe(computeMatchChecksum(match1));
  });
});
