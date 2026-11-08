import fs from 'node:fs';
import path from 'node:path';
import { readModel, drftToGlb, readGlb, gltfToMeshes, readGltfSkins } from '@driftengine/assets';
import { writeDrft, readDrft } from '@driftengine/drft';

const srcDir = '/tmp/cc0_inspect';
const outDir = path.resolve('public/models/fighters');
fs.mkdirSync(outDir, { recursive: true });

const mImp = await readModel({
  name: 'male.glb',
  bytes: new Uint8Array(fs.readFileSync(path.join(srcDir, 'superhero_male.glb'))),
});
const fImp = await readModel({
  name: 'ubc_female.gltf',
  bytes: new Uint8Array(fs.readFileSync(path.join(srcDir, 'ubc_female.gltf'))),
  beside: async (rel) => new Uint8Array(fs.readFileSync(path.join(srcDir, rel))),
});
const u1Imp = await readModel({
  name: 'ual1.glb',
  bytes: new Uint8Array(fs.readFileSync(path.join(srcDir, 'ual1_full.glb'))),
});
const u2Imp = await readModel({
  name: 'ual2.glb',
  bytes: new Uint8Array(fs.readFileSync(path.join(srcDir, 'ual2.glb'))),
});

const skin = mImp.skins[0];
const fingerJoints = new Set();
skin.joints.forEach((j, idx) => {
  if (/index|middle|pinky|ring|thumb|ball_leaf/.test(j.name)) fingerJoints.add(idx);
});

const curatedClips = [
  ['u1', 'A_TPose'],
  ['u2', 'Idle_Shield_Loop'],
  ['u2', 'Idle_FoldArms_Loop'],
  ['u1', 'PunchKick_Enter'],
  ['u1', 'Sword_Idle'],
  ['u2', 'Walk_Fwd_Loop'],
  ['u2', 'Walk_Bwd_Loop'],
  ['u1', 'Dodge_Left'],
  ['u1', 'Dodge_Right'],
  ['u1', 'Crouch_Idle_Loop'],
  ['u1', 'Crouch_Fwd_Loop'],
  ['u1', 'Punch_Jab'],
  ['u1', 'Punch_Cross'],
  ['u2', 'Melee_Hook'],
  ['u2', 'Melee_Knee'],
  ['u1', 'Kick'],
  ['u2', 'Melee_Uppercut'],
  ['u2', 'Melee_Combo'],
  ['u2', 'Slide_Start'],
  ['u1', 'BackFlip'],
  ['u2', 'Shield_Dash'],
  ['u2', 'OverhandThrow'],
  ['u2', 'Sword_Light_A'],
  ['u2', 'Sword_Heavy_A'],
  ['u2', 'Sword_UpperCut'],
  ['u1', 'Hit_Head'],
  ['u1', 'Hit_Stomach'],
  ['u2', 'Hit_Knockback'],
  ['u2', 'LiftAir'],
  ['u2', 'LiftAir_Hit_L'],
  ['u2', 'LiftAir_Fall_Impact'],
  ['u1', 'Death01'],
  ['u2', 'KipUp'],
  ['u1', 'Celebration'],
];

function optimizeCombatClip(clip) {
  if (clip.name === 'A_TPose') return clip;
  const newTracks = [];
  for (const tr of clip.tracks) {
    if (tr.path === 'scale') continue;
    const width = tr.path === 'rotation' ? 4 : 3;
    const count = tr.times.length;

    if (fingerJoints.has(tr.joint)) {
      if (tr.path === 'translation') continue;
      const mid = Math.floor(count / 2);
      const times = new Float32Array([tr.times[0], tr.times[count - 1]]);
      const values = new Float32Array(width * 2);
      values.set(tr.values.subarray(mid * width, (mid + 1) * width), 0);
      values.set(tr.values.subarray(mid * width, (mid + 1) * width), width);
      newTracks.push({ ...tr, times, values });
      continue;
    }

    let varies = false;
    for (let k = 1; k < count && !varies; k += 1) {
      for (let c = 0; c < width; c += 1) {
        if (Math.abs(tr.values[k * width + c] - tr.values[c]) > 0.0015) {
          varies = true;
          break;
        }
      }
    }
    if (!varies && tr.joint > 1) continue;

    const idx = [];
    if (count > 8) {
      for (let k = 0; k < count - 1; k += 2) idx.push(k);
      idx.push(count - 1);
    } else {
      for (let k = 0; k < count; k += 1) idx.push(k);
    }

    const times = new Float32Array(idx.length);
    const values = new Float32Array(idx.length * width);
    idx.forEach((srcIdx, dstIdx) => {
      times[dstIdx] = tr.times[srcIdx];
      values.set(tr.values.subarray(srcIdx * width, (srcIdx + 1) * width), dstIdx * width);
    });

    // Lock horizontal X/Z root motion to 0 so visual mesh stays 100% aligned with WASM combat capsule!
    if (tr.path === 'translation' && (tr.joint === 0 || tr.joint === 1)) {
      const base0X = values[0];
      const base0Z = values[2];
      for (let d = 0; d < idx.length; d += 1) {
        values[d * 3 + 0] = tr.joint === 0 ? 0 : base0X;
        values[d * 3 + 2] = tr.joint === 0 ? 0 : base0Z;
      }
    }

    newTracks.push({ ...tr, times, values });
  }
  return { name: clip.name, durationSec: clip.durationSec, tracks: newTracks };
}

const clips = curatedClips.map(([src, name]) => {
  const pool = src === 'u1' ? u1Imp.clips : u2Imp.clips;
  const found = pool.find((c) => c.name === name);
  if (!found) throw new Error(`Missing clip ${name}`);
  return optimizeCombatClip(found);
});

const drftBytes = writeDrft({
  meshes: [...mImp.meshes, ...fImp.meshes],
  skins: [skin],
  clips,
});

const { glb, warnings } = drftToGlb(readDrft(drftBytes));
if (warnings.length > 0) {
  console.warn('GLB warnings:', warnings);
}

const outPath = path.join(outDir, 'martial_fighters.glb');
fs.writeFileSync(outPath, glb);

// Round-trip verify
const check = readGlb(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength));
const checkMeshes = gltfToMeshes(check.json, check.binary ? [check.binary] : []);
const checkSkins = readGltfSkins(check.json, check.binary ? [check.binary] : []);
console.log(
  `Baked ${outPath} (${(glb.byteLength / 1024).toFixed(1)} KB) -> ${checkMeshes.meshes.length} skinned primitives, ${checkSkins.skins[0].joints.length} joints, ${checkSkins.clips.length} mocap clips!`,
);

fs.writeFileSync(
  path.join(outDir, 'LICENSE-CC0.md'),
  `# 3D Humanoid Fighter Meshes & Martial-Arts Animation Library\n\n` +
    `- **Base Meshes**: Quaternius *Universal Base Characters* (Male & Female FullBody)\n` +
    `- **Animations**: Quaternius *Universal Animation Library 1 & 2* (34 curated martial-arts clips)\n` +
    `- **License**: Creative Commons Zero v1.0 Universal (CC0 1.0 Public Domain)\n` +
    `- **Source**: https://quaternius.com/\n`,
  'utf8',
);
