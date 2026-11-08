/**
 * IRON FIST V — CC0 3D Fighter, Female Exact Skin & Sculpted Hair/Gear Baker
 *
 * Produces:
 *   1. public/models/fighters/martial_fighters.glb
 *      - Quaternius Universal Base Male (3 primitives) + exact Male 65-bone inverseBind skin
 *      - All 34 Martial-Arts Mocap Clips with finger phalanges (joints 11..30, 35..54)
 *        locked to Punch_Jab's clean clenched martial-arts fist so no clip ever splays fingers.
 *   2. public/models/fighters/female_and_parts.glb
 *      - Quaternius Universal Base Female (3 primitives) + exact Female 65-bone inverseBind skin
 *        (fixes Nina & Lin Xiao finger pivot mismatch!)
 *      - 10 CC0 3D Sculpted Hair, Beard & Headgear meshes (NoLimitNexus CC0 Modular Character Kit)
 *        aligned & rigged to the 65-bone humanoid skeleton!
 */
import fs from 'node:fs';
import path from 'node:path';
import { readGlb, gltfToMeshes, readGltfSkins, readModel, drftToGlb } from '@driftengine/assets';
import { writeDrft, readDrft } from '@driftengine/drft';

const OUT_DIR = path.resolve('public/models/fighters');
fs.mkdirSync(OUT_DIR, { recursive: true });

const PART_NAMES = [
  'hair_short',
  'hair_tousled',
  'hair_long',
  'hair_ponytail',
  'hair_bun',
  'hair_balding',
  'beard_short',
  'beard_long',
  'hat_straw',
  'hat_beanie',
];

function rigStaticHeadMeshToSkeleton(mesh, partName) {
  const vCount = mesh.positions.length / 3;
  const positions = new Float32Array(mesh.positions.length);
  const normals = new Float32Array(mesh.normals.length);
  const uvs = mesh.uvs ? new Float32Array(mesh.uvs) : new Float32Array(vCount * 2);
  const colors = new Float32Array(vCount * 3).fill(1.0);
  const emissive = new Float32Array(vCount);
  const joints = new Float32Array(vCount * 4);
  const weights = new Float32Array(vCount * 4);

  // KayKit/NoLimitNexus head center is (0, 1.88, 0) with cranium half-width 0.58m.
  // Quaternius Male T-pose Head (joint 6) has X[-0.091, 0.091], Y[1.577, 1.810], eyes Y=1.698 Z=0.070.
  const isStrawHat = partName === 'hat_straw';
  const sx = isStrawHat ? 0.245 : 0.196;
  const sy = isStrawHat ? 0.215 : 0.196;
  const sz = isStrawHat ? 0.245 : 0.215;
  const anchorY = isStrawHat ? 1.735 : 1.725;
  const anchorZ = isStrawHat ? 0.0 : 0.008;

  for (let v = 0; v < vCount; v++) {
    const x = mesh.positions[v * 3];
    const y = mesh.positions[v * 3 + 1];
    const z = mesh.positions[v * 3 + 2];

    const px = x * sx;
    const py = anchorY + (y - 1.88) * sy;
    const pz = anchorZ + z * sz;

    positions[v * 3] = px;
    positions[v * 3 + 1] = py;
    positions[v * 3 + 2] = pz;

    normals[v * 3] = mesh.normals[v * 3];
    normals[v * 3 + 1] = mesh.normals[v * 3 + 1];
    normals[v * 3 + 2] = mesh.normals[v * 3 + 2];

    // Blend long hair & long beard tips smoothly with spine_03 (joint 4) so torso twists look natural
    if ((partName === 'hair_long' || partName === 'beard_long') && py < 1.56) {
      const t = Math.min(0.65, Math.max(0, (1.56 - py) / 0.16));
      joints[v * 4] = 6; // Head
      joints[v * 4 + 1] = 4; // spine_03
      weights[v * 4] = 1 - t;
      weights[v * 4 + 1] = t;
    } else {
      joints[v * 4] = 6; // Head
      weights[v * 4] = 1.0;
    }
  }

  return {
    name: partName,
    positions,
    normals,
    uvs,
    colors,
    emissive,
    joints,
    weights,
    indices: new Uint32Array(mesh.indices),
    material: {
      baseColor: new Float32Array([1, 1, 1, 1]),
      metallic: 0.06,
      roughness: 0.65,
    },
  };
}

async function main() {
  console.log('1. Reading existing martial_fighters.glb...');
  const curBuf = fs.readFileSync(path.join(OUT_DIR, 'martial_fighters.glb'));
  const curGlb = readGlb(curBuf.buffer.slice(curBuf.byteOffset, curBuf.byteOffset + curBuf.byteLength));
  const curMeshes = gltfToMeshes(curGlb.json, [curGlb.binary]).meshes;
  const curSkins = readGltfSkins(curGlb.json, [curGlb.binary]);

  const maleMeshes = curMeshes.slice(0, 3);
  const maleSkin = curSkins.skins[0];

  // Extract clean clenched fist finger rotations from Punch_Jab (14.6cm tight fist!)
  const jabClip = curSkins.clips.find((c) => c.name === 'Punch_Jab');
  if (!jabClip) throw new Error('Punch_Jab clip missing!');
  const isFingerJoint = (j) => (j >= 11 && j <= 30) || (j >= 35 && j <= 54);
  const cleanFistTracks = jabClip.tracks.filter((tr) => isFingerJoint(tr.joint) && tr.path === 'rotation');

  console.log(`   Extracted ${cleanFistTracks.length} clean martial-arts fist finger tracks from Punch_Jab.`);

  // Normalize all combat clips (except A_TPose) to use clean clenched martial-arts fists
  const normalizedClips = curSkins.clips.map((clip) => {
    if (clip.name === 'A_TPose') return clip;
    const nonFingerTracks = clip.tracks.filter((tr) => !isFingerJoint(tr.joint));
    const fistCopies = cleanFistTracks.map((ft) => ({
      joint: ft.joint,
      path: 'rotation',
      interpolation: 'STEP',
      times: new Float32Array([0]),
      values: new Float32Array(ft.values.slice(0, 4)),
    }));
    return {
      name: clip.name,
      durationSec: clip.durationSec,
      tracks: [...nonFingerTracks, ...fistCopies],
    };
  });

  // Write updated martial_fighters.glb (Male + maleSkin + 34 fist-calibrated clips)
  const maleDrft = writeDrft({
    meshes: maleMeshes,
    skins: [maleSkin],
    clips: normalizedClips,
  });
  const { glb: maleGlbBytes } = drftToGlb(readDrft(maleDrft));
  const maleOutPath = path.join(OUT_DIR, 'martial_fighters.glb');
  fs.writeFileSync(maleOutPath, maleGlbBytes);
  console.log(`   Wrote ${maleOutPath}: ${(maleGlbBytes.byteLength / 1024).toFixed(1)} KB`);

  // 2. Build female_and_parts.glb (Female exact meshes + exact femaleSkin + 10 CC0 sculpted head/hair parts!)
  console.log('2. Reading exact Female rig & 10 CC0 3D Hair/Beard/Hat parts...');
  const femBuf = fs.readFileSync('/tmp/cc0_phase3b/ubc_female_full.glb');
  const femGlb = readGlb(femBuf.buffer.slice(femBuf.byteOffset, femBuf.byteOffset + femBuf.byteLength));
  const femMeshes = gltfToMeshes(femGlb.json, [femGlb.binary]).meshes;
  const femSkin = readGltfSkins(femGlb.json, [femGlb.binary]).skins[0];

  const riggedParts = [];
  for (const partName of PART_NAMES) {
    const pBuf = new Uint8Array(fs.readFileSync(`/tmp/cc0_phase3b/hairs/${partName}.glb`));
    const pImp = await readModel({ name: `${partName}.glb`, bytes: pBuf });
    // Merge primitives if >1
    const m0 = pImp.meshes[0];
    riggedParts.push(rigStaticHeadMeshToSkeleton(m0, partName));
  }

  const femDrft = writeDrft({
    meshes: [...femMeshes, ...riggedParts],
    skins: [femSkin],
    clips: [],
  });
  const { glb: femGlbBytes } = drftToGlb(readDrft(femDrft));
  const femOutPath = path.join(OUT_DIR, 'female_and_parts.glb');
  fs.writeFileSync(femOutPath, femGlbBytes);
  console.log(`   Wrote ${femOutPath}: ${(femGlbBytes.byteLength / 1024).toFixed(1)} KB (${3 + riggedParts.length} meshes, exact Female inverseBind!)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
