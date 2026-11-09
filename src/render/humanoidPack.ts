import { MeshBuilder, srgbColor, type MeshData, type Vec3 } from '@driftengine/core';
import {
  Skeleton,
  blendPoses,
  createPose,
  sampleClip,
  type AnimationClip,
  type Joint,
  type Pose,
} from '@driftengine/animation';
import { gltfToMeshes, readGlb, readGltfSkins } from '@driftengine/assets';
import type { CharacterData } from '../data/types';
import type { FighterSim } from '../sim/combat';
import { hexToLinear } from './fighterMesh';

/** Key joint indices on the 65-bone Quaternius CC0 Humanoid Skeleton */
export const HUMANOID_JOINT_PELVIS = 1;
export const HUMANOID_JOINT_SPINE1 = 2;
export const HUMANOID_JOINT_SPINE2 = 3;
export const HUMANOID_JOINT_CHEST = 4; // spine_03
export const HUMANOID_JOINT_NECK = 5;
export const HUMANOID_JOINT_HEAD = 6;
export const HUMANOID_JOINT_CLAVICLE_L = 7;
export const HUMANOID_JOINT_UPPERARM_L = 8;
export const HUMANOID_JOINT_LOWERARM_L = 9;
export const HUMANOID_JOINT_HAND_L = 10;
export const HUMANOID_JOINT_CLAVICLE_R = 31;
export const HUMANOID_JOINT_UPPERARM_R = 32;
export const HUMANOID_JOINT_LOWERARM_R = 33;
export const HUMANOID_JOINT_HAND_R = 34;
export const HUMANOID_JOINT_THIGH_L = 55;
export const HUMANOID_JOINT_CALF_L = 56;
export const HUMANOID_JOINT_FOOT_L = 57;
export const HUMANOID_JOINT_BALL_L = 58;
export const HUMANOID_JOINT_THIGH_R = 60;
export const HUMANOID_JOINT_CALF_R = 61;
export const HUMANOID_JOINT_FOOT_R = 62;
export const HUMANOID_JOINT_BALL_R = 63;

const FEMALE_IDS = new Set(['nina', 'linxiao']);

const SHIRTLESS_P1_IDS = new Set([
  'jinrai',
  'kazuma',
  'marcus',
  'jaguar',
  'steven',
  'jinpachi',
]);

const SLEEVELESS_IDS = new Set([
  'jinrai',
  'kazuma',
  'marcus',
  'paul',
  'jaguar',
  'edgar',
  'steven',
  'linxiao',
  'jinpachi',
]);

const HAIR_HEX_BY_ID: Record<string, string> = {
  jinrai: '#14151c',
  kazuma: '#121318',
  taehwan: '#7c2418',
  marcus: '#14141a',
  paul: '#dfb848',
  jaguar: '#d89b24',
  nina: '#e6c86e',
  linxiao: '#171720',
  yoshimaru: '#9a7b4f',
  edgar: '#241812',
  steven: '#deb64c',
  jinpachi: '#e2e6f0',
};

/**
 * Distinct 3D body physique proportions `[scaleX, scaleY, scaleZ]` applied on the Scene Node
 * AFTER GPU/CPU skeletal skinning — gives every fighter a distinct silhouette without ever
 * distorting finger/joint inverseBind pivots!
 */
export function getCharacterBodyScale(charId: string): Vec3 {
  switch (charId) {
    case 'jinrai':
      return [1.0, 1.0, 1.0];
    case 'kazuma':
      return [1.05, 1.01, 1.04];
    case 'taehwan':
      return [0.96, 1.04, 0.96];
    case 'marcus':
      return [0.93, 0.97, 0.93];
    case 'paul':
      return [1.09, 1.02, 1.08];
    case 'jaguar':
      return [1.14, 1.05, 1.12];
    case 'nina':
      return [0.98, 1.02, 0.98];
    case 'linxiao':
      return [0.92, 0.94, 0.92];
    case 'yoshimaru':
      return [1.02, 1.03, 1.02];
    case 'edgar':
      return [0.97, 1.01, 0.97];
    case 'steven':
      return [1.03, 0.99, 1.03];
    case 'jinpachi':
      return [1.16, 1.12, 1.15];
    default:
      return [1.0, 1.0, 1.0];
  }
}

const CC0_PART_ORDER = [
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
] as const;

export interface LoadedHumanoidPack {
  readonly joints: readonly Joint[];
  readonly inverseBind: Float32Array;
  readonly femaleInverseBind: Float32Array;
  readonly malePrims: readonly [MeshData, MeshData, MeshData];
  readonly femalePrims: readonly [MeshData, MeshData, MeshData];
  readonly cc0Parts: ReadonlyMap<string, MeshData>;
  readonly clips: ReadonlyMap<string, AnimationClip>;
  readonly bindPose: Pose;
}

const MODEL_ASSET_REVISION = '20261109-hotfix1';

let cachedPack: LoadedHumanoidPack | null = null;
let loadPromise: Promise<LoadedHumanoidPack | null> | null = null;
const readyListeners: Array<() => void> = [];

export function getHumanoidPack(): LoadedHumanoidPack | null {
  return cachedPack;
}

export function onHumanoidPackReady(cb: () => void): void {
  if (cachedPack) {
    cb();
  } else {
    readyListeners.push(cb);
  }
}

export function parseHumanoidPackGlb(
  maleBuffer: ArrayBuffer,
  femaleAndPartsBuffer?: ArrayBuffer | null,
): LoadedHumanoidPack | null {
  const mGlb = readGlb(maleBuffer);
  const mBlobs = mGlb.binary ? [mGlb.binary] : [];
  const { meshes: mMeshes } = gltfToMeshes(mGlb.json, mBlobs);
  const { skins: mSkins, clips } = readGltfSkins(mGlb.json, mBlobs);
  if (mMeshes.length < 3 || mSkins.length < 1 || clips.length < 1) return null;

  const maleSkin = mSkins[0];
  let femalePrims: [MeshData, MeshData, MeshData] =
    mMeshes.length >= 6
      ? [mMeshes[3], mMeshes[4], mMeshes[5]]
      : [mMeshes[0], mMeshes[1], mMeshes[2]];
  let femaleInverseBind = maleSkin.inverseBind;
  const cc0Parts = new Map<string, MeshData>();

  if (femaleAndPartsBuffer) {
    const fGlb = readGlb(femaleAndPartsBuffer);
    const fBlobs = fGlb.binary ? [fGlb.binary] : [];
    const { meshes: fMeshes } = gltfToMeshes(fGlb.json, fBlobs);
    const { skins: fSkins } = readGltfSkins(fGlb.json, fBlobs);
    if (fMeshes.length >= 3 && fSkins.length >= 1) {
      femalePrims = [fMeshes[0], fMeshes[1], fMeshes[2]];
      femaleInverseBind = fSkins[0].inverseBind;
    }
    for (let i = 0; i < CC0_PART_ORDER.length; i += 1) {
      const partMesh = fMeshes[3 + i];
      if (partMesh) {
        cc0Parts.set(CC0_PART_ORDER[i], partMesh);
      }
    }
  }

  const clipMap = new Map<string, AnimationClip>();
  for (const c of clips) {
    clipMap.set(c.name, c);
  }

  const skel = new Skeleton(maleSkin.joints, maleSkin.inverseBind);
  const bindPose = createPose(skel.jointCount);
  const tpose = clipMap.get('A_TPose');
  if (tpose) {
    sampleClip(tpose, 0, bindPose);
  }

  return {
    joints: maleSkin.joints,
    inverseBind: maleSkin.inverseBind,
    femaleInverseBind,
    malePrims: [mMeshes[0], mMeshes[1], mMeshes[2]],
    femalePrims,
    cc0Parts,
    clips: clipMap,
    bindPose,
  };
}

export function loadHumanoidPack(): Promise<LoadedHumanoidPack | null> {
  if (cachedPack) return Promise.resolve(cachedPack);
  if (loadPromise) return loadPromise;

  if (
    typeof fetch !== 'function' ||
    typeof window === 'undefined' ||
    !window.location.protocol.startsWith('http')
  ) {
    return Promise.resolve(null);
  }

  loadPromise = Promise.all([
    fetch(`./models/fighters/martial_fighters.glb?v=${MODEL_ASSET_REVISION}`, { cache: 'force-cache' }).then((r) => (r.ok ? r.arrayBuffer() : null)),
    fetch(`./models/fighters/female_and_parts.glb?v=${MODEL_ASSET_REVISION}`, { cache: 'force-cache' })
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .catch(() => null),
  ])
    .then(([maleBuf, femBuf]) => {
      if (!maleBuf) return null;
      cachedPack = parseHumanoidPackGlb(maleBuf, femBuf);
      if (cachedPack) {
        for (const fn of readyListeners) fn();
        readyListeners.length = 0;
      }
      return cachedPack;
    })
    .catch(() => null);

  return loadPromise;
}

/** Merge multiple skinned MeshData chunks into one single draw-call MeshData (NEVER pre-scales bind positions!) */
function mergeSkinnedParts(parts: readonly MeshData[]): MeshData {
  let totalVerts = 0;
  let totalIndices = 0;
  for (const p of parts) {
    totalVerts += p.positions.length / 3;
    totalIndices += p.indices.length;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const colors = new Float32Array(totalVerts * 3);
  const emissive = new Float32Array(totalVerts);
  const emissiveColor = new Float32Array(totalVerts * 3);
  const roughness = new Float32Array(totalVerts);
  const specular = new Float32Array(totalVerts);
  const joints = new Float32Array(totalVerts * 4);
  const weights = new Float32Array(totalVerts * 4);
  const indices = new Uint32Array(totalIndices);

  let vOffset = 0;
  let iOffset = 0;
  let hasAnyEmissiveColor = false;

  for (const p of parts) {
    const vCount = p.positions.length / 3;
    positions.set(p.positions, vOffset * 3);
    normals.set(p.normals, vOffset * 3);
    colors.set(p.colors, vOffset * 3);
    emissive.set(p.emissive, vOffset);

    if (p.emissiveColor) {
      emissiveColor.set(p.emissiveColor, vOffset * 3);
      hasAnyEmissiveColor = true;
    } else {
      emissiveColor.set(p.colors, vOffset * 3);
    }

    if (p.roughness) roughness.set(p.roughness, vOffset);
    else roughness.fill(0.48, vOffset, vOffset + vCount);

    if (p.specular) specular.set(p.specular, vOffset);
    else specular.fill(0.24, vOffset, vOffset + vCount);

    if (p.joints && p.weights) {
      joints.set(p.joints, vOffset * 4);
      weights.set(p.weights, vOffset * 4);
    } else {
      for (let v = 0; v < vCount; v += 1) {
        weights[(vOffset + v) * 4] = 1;
      }
    }

    for (let k = 0; k < p.indices.length; k += 1) {
      indices[iOffset + k] = p.indices[k] + vOffset;
    }

    vOffset += vCount;
    iOffset += p.indices.length;
  }

  return {
    positions,
    normals,
    colors,
    emissive,
    ...(hasAnyEmissiveColor ? { emissiveColor } : {}),
    roughness,
    specular,
    joints,
    weights,
    indices,
  };
}

function paintEyesNatural(
  src: MeshData,
  isFemale: boolean,
  isBoss: boolean,
  isMasked: boolean,
): MeshData {
  const vCount = src.positions.length / 3;
  const colors = new Float32Array(vCount * 3);
  const emissive = new Float32Array(vCount);
  const roughness = new Float32Array(vCount);
  const specular = new Float32Array(vCount);
  const sclera = isMasked
    ? srgbColor(0.12, 0.12, 0.15)
    : isBoss
      ? srgbColor(0.75, 0.16, 0.2)
      : srgbColor(0.56, 0.56, 0.6);
  const pupil = isBoss ? srgbColor(0.95, 0.32, 0.25) : srgbColor(0.05, 0.05, 0.07);
  const eyeCenterY = isFemale ? 1.656 : 1.699;

  for (let v = 0; v < vCount; v += 1) {
    const px = src.positions[v * 3];
    const py = src.positions[v * 3 + 1];
    const inPupil =
      Math.abs(Math.abs(px) - 0.031) < 0.012 && Math.abs(py - eyeCenterY) < 0.011;
    const col = inPupil ? pupil : sclera;
    colors[v * 3] = col[0];
    colors[v * 3 + 1] = col[1];
    colors[v * 3 + 2] = col[2];
    emissive[v] = 0;
    roughness[v] = 0.72;
    specular[v] = 0.08;
  }
  return {
    positions: src.positions,
    normals: src.normals,
    colors,
    emissive,
    roughness,
    specular,
    joints: src.joints,
    weights: src.weights,
    indices: src.indices,
  };
}

function paintPrimSolid(
  src: MeshData,
  linearColor: Vec3,
  emissiveVal = 0,
  roughVal = 0.55,
  specVal = 0.16,
  offset: Vec3 = [0, 0, 0],
): MeshData {
  const vCount = src.positions.length / 3;
  const positions =
    offset[0] === 0 && offset[1] === 0 && offset[2] === 0
      ? src.positions
      : new Float32Array(src.positions.length);
  if (positions !== src.positions) {
    for (let v = 0; v < vCount; v += 1) {
      positions[v * 3] = src.positions[v * 3] + offset[0];
      positions[v * 3 + 1] = src.positions[v * 3 + 1] + offset[1];
      positions[v * 3 + 2] = src.positions[v * 3 + 2] + offset[2];
    }
  }
  const colors = new Float32Array(vCount * 3);
  const emissive = new Float32Array(vCount);
  const roughness = new Float32Array(vCount);
  const specular = new Float32Array(vCount);
  for (let v = 0; v < vCount; v += 1) {
    colors[v * 3] = linearColor[0];
    colors[v * 3 + 1] = linearColor[1];
    colors[v * 3 + 2] = linearColor[2];
    emissive[v] = emissiveVal;
    roughness[v] = roughVal;
    specular[v] = specVal;
  }
  return {
    positions,
    normals: src.normals,
    colors,
    emissive,
    roughness,
    specular,
    joints: src.joints,
    weights: src.weights,
    indices: src.indices,
  };
}

/**
 * Builds each of the 12 playable fighters with a genuinely distinct 3D silhouette:
 * - Real sculpted CC0 3D Hair, Beard & Headgear `.glb` meshes (`pack.cc0Parts`)
 * - Bone-weighted 3D martial-arts attire & gear (puffy boxing gloves, samurai sode & kusazuri armor,
 *   wide karate gi trousers, taekwondo dobok skirt & shin guards, kung-fu qipao tunic, assassin thigh
 *   holsters, pro-wrestling championship belt & knee pads, nunchaku, capoeira cordão & baggy abadá,
 *   sleeveless judogi lapels, Mishima spiked gauntlets, demonic boss pauldrons!)
 */
export function buildHumanoidCharacterMesh(
  pack: LoadedHumanoidPack,
  char: CharacterData,
  costumeIdx: 0 | 1,
): MeshData {
  const isFemale = FEMALE_IDS.has(char.id);
  const [rawBrows, rawEyes, rawBody] = isFemale ? pack.femalePrims : pack.malePrims;
  const c = char.costumes[costumeIdx];

  const skinCol = hexToLinear(c.skin);
  const topCol = hexToLinear(c.top);
  const pantsCol = hexToLinear(c.pants);
  const trimCol = hexToLinear(c.trim);
  const glovesCol = hexToLinear(c.gloves);
  const bootsCol = hexToLinear(c.boots);
  const hairCol = hexToLinear(HAIR_HEX_BY_ID[char.id] ?? '#16161d');

  const isBoss = char.id === 'jinpachi';
  const shirtless = costumeIdx === 0 && SHIRTLESS_P1_IDS.has(char.id);
  const sleeveless = SLEEVELESS_IDS.has(char.id);

  // 1. Brows / Lashes & Matte Natural Eyes (zero head emissive glare!)
  const browsMesh = paintPrimSolid(rawBrows, hairCol, 0, 0.65, 0.12);
  const eyesMesh = paintEyesNatural(
    rawEyes,
    isFemale,
    isBoss,
    char.id === 'yoshimaru' || char.id === 'jaguar',
  );

  // 2. Anatomically Zone-Paint the Sculpted Humanoid Body
  const vCount = rawBody.positions.length / 3;
  const colors = new Float32Array(vCount * 3);
  const emissive = new Float32Array(vCount);
  const roughness = new Float32Array(vCount);
  const specular = new Float32Array(vCount);

  const jArr = rawBody.joints!;
  const wArr = rawBody.weights!;
  const pos = rawBody.positions;
  const headCrownY = isFemale ? 1.67 : 1.71;

  for (let v = 0; v < vCount; v += 1) {
    const px = pos[v * 3];
    const py = pos[v * 3 + 1];
    const pz = pos[v * 3 + 2];

    let domJ = jArr[v * 4];
    let domW = wArr[v * 4];
    for (let k = 1; k < 4; k += 1) {
      const w = wArr[v * 4 + k];
      if (w > domW) {
        domW = w;
        domJ = jArr[v * 4 + k];
      }
    }

    let col: Vec3 = skinCol;
    let rough = 0.52;
    let spec = 0.26;

    if (domJ === 6) {
      if (char.id === 'jaguar') {
        const isMuzzle = pz > 0.062 && py < 1.66;
        const isStripe = Math.abs(Math.sin(py * 55)) > 0.78 && pz < 0.05;
        col = isMuzzle
          ? srgbColor(0.16, 0.12, 0.09)
          : isStripe
            ? srgbColor(0.22, 0.14, 0.06)
            : srgbColor(0.84, 0.58, 0.14);
        rough = 0.46;
        spec = 0.22;
      } else if (char.id === 'yoshimaru') {
        col = pz > 0.045 ? srgbColor(0.55, 0.1, 0.15) : topCol;
        rough = 0.36;
        spec = 0.44;
      } else if (
        py > headCrownY ||
        (py > headCrownY - 0.075 && (pz < -0.02 || Math.abs(px) > 0.068))
      ) {
        col = char.id === 'jinpachi' ? skinCol : hairCol;
        rough = 0.56;
        spec = 0.14;
      } else {
        col = skinCol;
      }
    } else if (domJ === 5) {
      col = char.id === 'yoshimaru' ? topCol : skinCol;
    } else if (domJ >= 2 && domJ <= 4) {
      if (shirtless) {
        // Kazuma signature diagonal chest battle scar!
        if (char.id === 'kazuma' && pz > 0.06 && Math.abs(px - (py - 1.32) * 0.55) < 0.014) {
          col = srgbColor(0.45, 0.14, 0.14);
        } else {
          col = skinCol;
        }
        rough = 0.46;
        spec = 0.34;
      } else if (char.id === 'edgar' && costumeIdx === 0 && Math.abs(px) < 0.058 && pz > 0.04) {
        // Edgar open cropped Capoeira vest showing abs!
        col = skinCol;
      } else if (!isFemale && Math.abs(px) < 0.045 && pz > 0.05 && py > 1.35) {
        col = skinCol;
      } else if (Math.abs(px) < 0.062 && pz > 0.055 && py > 1.22) {
        col = trimCol;
        rough = 0.4;
      } else {
        col = topCol;
        rough = char.id === 'nina' || char.id === 'yoshimaru' ? 0.28 : 0.56;
        spec = char.id === 'nina' || char.id === 'yoshimaru' ? 0.65 : 0.22;
      }
    } else if (domJ === 7 || domJ === 31) {
      col = shirtless ? skinCol : topCol;
    } else if (domJ === 8 || domJ === 32) {
      col = sleeveless ? skinCol : topCol;
    } else if (domJ === 9 || domJ === 33) {
      const wristDist = Math.abs(px);
      if (wristDist > (isFemale ? 0.49 : 0.54)) {
        col = glovesCol;
        rough = 0.34;
        spec = 0.52;
      } else {
        col = sleeveless ? skinCol : topCol;
      }
    } else if ((domJ >= 10 && domJ <= 30) || (domJ >= 34 && domJ <= 54)) {
      if (char.id === 'linxiao' || char.id === 'edgar') {
        // Bare-knuckle / open martial-arts hand wraps!
        col = Math.abs(px) > (isFemale ? 0.69 : 0.77) ? skinCol : glovesCol;
      } else {
        col = Math.abs(px) > (isFemale ? 0.67 : 0.75) ? glovesCol : trimCol;
      }
      rough = 0.34;
      spec = 0.52;
    } else if (domJ === 1) {
      if (py > (isFemale ? 0.98 : 1.0)) {
        col = trimCol;
        rough = 0.38;
        spec = 0.48;
      } else {
        col = pantsCol;
        rough = 0.55;
      }
    } else if (domJ === 55 || domJ === 56 || domJ === 60 || domJ === 61) {
      if (char.id === 'jaguar' && py < 0.82 && py > 0.36) {
        col = skinCol; // Bare muscular wrestler legs!
      } else if (char.id === 'steven' && costumeIdx === 0 && py < 0.62 && py > 0.32) {
        col = skinCol; // Boxing trunks + bare calves above high-top boxing shoes!
      } else if (char.id === 'linxiao' && costumeIdx === 0 && py < 0.52 && py > 0.24) {
        col = srgbColor(0.9, 0.9, 0.94); // Kung-fu stockings!
      } else if (Math.abs(px) > 0.166) {
        col = trimCol;
        rough = 0.38;
      } else {
        col = pantsCol;
        rough = char.id === 'nina' ? 0.28 : 0.58;
        spec = char.id === 'nina' ? 0.64 : 0.22;
      }
    } else {
      col = char.id === 'edgar' && costumeIdx === 0 ? skinCol : bootsCol;
      rough = 0.38;
      spec = 0.45;
    }

    colors[v * 3] = col[0];
    colors[v * 3 + 1] = col[1];
    colors[v * 3 + 2] = col[2];
    emissive[v] = 0;
    roughness[v] = rough;
    specular[v] = spec;
  }

  const dressedBody: MeshData = {
    positions: rawBody.positions,
    normals: rawBody.normals,
    colors,
    emissive,
    roughness,
    specular,
    joints: rawBody.joints,
    weights: rawBody.weights,
    indices: rawBody.indices,
  };

  // 3. Attach Real Sculpted CC0 3D Hair / Beard / Hat `.glb` Parts (`pack.cc0Parts`)
  const extraParts: MeshData[] = [];
  const femHeadOffset: Vec3 = isFemale ? [0, -0.043, -0.007] : [0, 0, 0];

  const addCc0Part = (partName: string, color: Vec3, extraOffset: Vec3 = [0, 0, 0], rough = 0.58) => {
    const raw = pack.cc0Parts.get(partName);
    if (!raw) return;
    extraParts.push(
      paintPrimSolid(raw, color, 0, rough, 0.16, [
        femHeadOffset[0] + extraOffset[0],
        femHeadOffset[1] + extraOffset[1],
        femHeadOffset[2] + extraOffset[2],
      ]),
    );
  };

  switch (char.id) {
    case 'jinrai':
      addCc0Part('hair_tousled', hairCol, [0, 0.006, 0]);
      break;
    case 'kazuma':
      addCc0Part('hair_short', hairCol, [0, 0.004, -0.006]);
      break;
    case 'taehwan':
      addCc0Part('hair_tousled', hairCol, [0, 0.005, 0]);
      break;
    case 'marcus':
      addCc0Part('hair_short', hairCol);
      break;
    case 'paul':
      addCc0Part('beard_short', srgbColor(0.55, 0.42, 0.16), [0, 0.005, 0.004], 0.68);
      break;
    case 'nina':
      addCc0Part('hair_ponytail', hairCol);
      break;
    case 'linxiao':
      addCc0Part('hair_bun', hairCol);
      break;
    case 'yoshimaru':
      // Wide Conical Ronin Kasa Battle Hat (`hat_straw.glb` painted dark armoured lacquer + crimson trim!)
      addCc0Part('hat_straw', costumeIdx === 0 ? srgbColor(0.22, 0.16, 0.12) : topCol, [0, 0.015, 0], 0.48);
      break;
    case 'edgar':
      addCc0Part('hair_long', hairCol);
      break;
    case 'steven':
      addCc0Part('hair_short', hairCol, [0, 0.002, 0.004]);
      break;
    case 'jinpachi':
      addCc0Part('hair_balding', hairCol, [0, 0.006, 0]);
      addCc0Part('beard_long', hairCol, [0, 0.008, 0.006], 0.62);
      break;
  }

  // 4. Bone-Weighted 3D Outfit & Gear Geometry — Distinct Silhouette Per Character!
  const acc = new MeshBuilder();
  const headTopY = isFemale ? 1.75 : 1.79;

  if (char.id === 'jinrai') {
    // Spiked Mishima Karate Forearm Gauntlets + Flared Karate Gi Trousers + Obi Sash!
    for (const [jArm, sx] of [
      [HUMANOID_JOINT_LOWERARM_L, 1],
      [HUMANOID_JOINT_LOWERARM_R, -1],
    ] as const) {
      acc.setJoint(jArm).setRoughness(0.32);
      acc.addCylinder([sx * 0.56, 1.445, 0], 0.052, 0.09, 'x', glovesCol, 0, 10, 0.65);
      acc.addCapsule([sx * 0.55, 1.495, -0.02], 0.012, 0.035, trimCol, 0, 6, 4, 0.75);
    }
    for (const [jCalf, sx] of [
      [HUMANOID_JOINT_CALF_L, 1],
      [HUMANOID_JOINT_CALF_R, -1],
    ] as const) {
      acc.setJoint(jCalf).setRoughness(0.58);
      acc.addCylinder([sx * 0.105, 0.30, 0], 0.082, 0.19, 'y', pantsCol, 0, 12, 0.22);
      acc.addCylinder([sx * 0.105, 0.22, 0.01], 0.085, 0.045, 'y', trimCol, 0, 12, 0.35);
    }
    acc.setJoint(HUMANOID_JOINT_PELVIS).setRoughness(0.52);
    acc.addBox([0.05, 0.88, 0.115], [0.026, 0.12, 0.014], trimCol, 0, 0.3);
  } else if (char.id === 'kazuma') {
    // Studded Heavy Mishima Gloves + Wide Gi Pants (P1) or Tailored Suit Coat Tails (P2)!
    for (const [jArm, sx] of [
      [HUMANOID_JOINT_LOWERARM_L, 1],
      [HUMANOID_JOINT_LOWERARM_R, -1],
    ] as const) {
      acc.setJoint(jArm).setRoughness(0.3);
      acc.addCylinder([sx * 0.57, 1.445, 0], 0.054, 0.095, 'x', glovesCol, 0, 10, 0.7);
    }
    if (costumeIdx === 1) {
      acc.setJoint(HUMANOID_JOINT_PELVIS).setRoughness(0.42);
      acc.addBox([0, 0.88, -0.105], [0.165, 0.16, 0.022], topCol, 0, 0.35);
    } else {
      for (const [jCalf, sx] of [
        [HUMANOID_JOINT_CALF_L, 1],
        [HUMANOID_JOINT_CALF_R, -1],
      ] as const) {
        acc.setJoint(jCalf).setRoughness(0.56);
        acc.addCylinder([sx * 0.105, 0.30, 0], 0.084, 0.20, 'y', pantsCol, 0, 12, 0.22);
      }
    }
  } else if (char.id === 'taehwan') {
    // Crimson Taekwondo Headband + Dobok Tunic Skirt + Padded Shin Guards!
    acc.setJoint(HUMANOID_JOINT_HEAD).setRoughness(0.48);
    acc.addCylinder([0, 1.735, 0.005], 0.096, 0.018, 'y', trimCol, 0, 16, 0.3);
    acc.addBox([-0.035, 1.67, -0.125], [0.018, 0.075, 0.01], trimCol, 0, 0.3);
    acc.addBox([0.035, 1.66, -0.125], [0.018, 0.085, 0.01], trimCol, 0, 0.3);

    acc.setJoint(HUMANOID_JOINT_PELVIS).setRoughness(0.55);
    acc.addCylinder([0, 0.94, 0], 0.175, 0.11, 'y', topCol, 0, 14, 0.22);
    acc.addCylinder([0, 1.01, 0], 0.168, 0.024, 'y', srgbColor(0.08, 0.08, 0.1), 0, 14, 0.35);

    for (const [jCalf, sx] of [
      [HUMANOID_JOINT_CALF_L, 1],
      [HUMANOID_JOINT_CALF_R, -1],
    ] as const) {
      acc.setJoint(jCalf).setRoughness(0.36);
      acc.addBox([sx * 0.105, 0.30, 0.052], [0.042, 0.12, 0.022], bootsCol, 0, 0.5);
    }
  } else if (char.id === 'marcus') {
    // Holstered Nunchaku on Hip + Martial-Arts Waist Sash!
    acc.setJoint(HUMANOID_JOINT_PELVIS).setRoughness(0.38);
    acc.addCylinder([0, 1.01, 0], 0.158, 0.032, 'y', trimCol, 0, 14, 0.35);
    // Twin Nunchaku handles at right hip
    const nunchakuWood = srgbColor(0.28, 0.14, 0.06);
    acc.addCylinder([-0.175, 0.95, 0.02], 0.016, 0.11, 'y', nunchakuWood, 0, 8, 0.55);
    acc.addCylinder([-0.175, 0.95, -0.025], 0.016, 0.11, 'y', nunchakuWood, 0, 8, 0.55);
  } else if (char.id === 'paul') {
    // Iconic Tall Blonde Flat-Top Tower + Thick Sleeveless Judogi Shoulder Lapels + Heavy Biker Gauntlets!
    acc.setJoint(HUMANOID_JOINT_HEAD).setRoughness(0.62);
    acc.addCylinder([0, headTopY + 0.048, -0.008], 0.074, 0.108, 'y', hairCol, 0, 16, 0.12);

    acc.setJoint(HUMANOID_JOINT_CHEST).setRoughness(0.56);
    acc.addBox([-0.145, 1.43, 0.01], [0.042, 0.085, 0.115], topCol, 0, 0.25);
    acc.addBox([0.145, 1.43, 0.01], [0.042, 0.085, 0.115], topCol, 0, 0.25);
    acc.addCylinder([0, 1.02, 0], 0.178, 0.032, 'y', trimCol, 0, 14, 0.35);

    for (const [jArm, sx] of [
      [HUMANOID_JOINT_LOWERARM_L, 1],
      [HUMANOID_JOINT_LOWERARM_R, -1],
    ] as const) {
      acc.setJoint(jArm).setRoughness(0.34);
      acc.addCylinder([sx * 0.56, 1.445, 0], 0.056, 0.095, 'x', glovesCol, 0, 10, 0.6);
    }
  } else if (char.id === 'jaguar') {
    // Golden Jaguar Ears + Heavy Gold Championship Belt + Wrestler Knee & Elbow Pads!
    const goldMask = srgbColor(0.86, 0.62, 0.14);
    acc.setJoint(HUMANOID_JOINT_HEAD).setRoughness(0.45);
    acc.addSphere([-0.068, headTopY + 0.008, -0.008], 0.03, goldMask, 0, 10, 8, 0.26);
    acc.addSphere([0.068, headTopY + 0.008, -0.008], 0.03, goldMask, 0, 10, 8, 0.26);

    // Championship Wrestling Belt on Pelvis!
    acc.setJoint(HUMANOID_JOINT_PELVIS).setRoughness(0.24);
    acc.addCylinder([0, 1.015, 0], 0.176, 0.042, 'y', srgbColor(0.14, 0.12, 0.1), 0, 16, 0.5);
    acc.addBox([0, 1.015, 0.135], [0.075, 0.052, 0.018], goldMask, 0, 0.88);

    // Knee Pads
    for (const [jCalf, sx] of [
      [HUMANOID_JOINT_CALF_L, 1],
      [HUMANOID_JOINT_CALF_R, -1],
    ] as const) {
      acc.setJoint(jCalf).setRoughness(0.42);
      acc.addCylinder([sx * 0.105, 0.49, 0.012], 0.068, 0.055, 'y', pantsCol, 0, 12, 0.4);
    }
  } else if (char.id === 'nina') {
    // Dual Tactical Assassin Thigh Holsters + Utility Belt!
    acc.setJoint(HUMANOID_JOINT_PELVIS).setRoughness(0.32);
    acc.addCylinder([0, 0.99, 0], 0.152, 0.022, 'y', srgbColor(0.1, 0.1, 0.13), 0, 14, 0.65);
    for (const [jThigh, sx] of [
      [HUMANOID_JOINT_THIGH_L, 1],
      [HUMANOID_JOINT_THIGH_R, -1],
    ] as const) {
      acc.setJoint(jThigh).setRoughness(0.3);
      acc.addBox([sx * 0.165, 0.76, 0.01], [0.022, 0.075, 0.048], srgbColor(0.1, 0.1, 0.13), 0, 0.7);
      acc.addCylinder([sx * 0.1, 0.76, 0], 0.078, 0.018, 'y', trimCol, 0, 12, 0.6);
    }
  } else if (char.id === 'linxiao') {
    // Twin Side Hair Chignons + Mandarin Kung-Fu Qipao Tunic Skirt + Silk Wrist Cuffs!
    acc.setJoint(HUMANOID_JOINT_HEAD).setRoughness(0.52);
    acc.addSphere([-0.082, headTopY - 0.015, -0.02], 0.038, hairCol, 0, 10, 8, 0.2);
    acc.addSphere([0.082, headTopY - 0.015, -0.02], 0.038, hairCol, 0, 10, 8, 0.2);
    acc.addSphere([-0.082, headTopY - 0.05, -0.02], 0.018, trimCol, 0, 8, 6, 0.4);
    acc.addSphere([0.082, headTopY - 0.05, -0.02], 0.018, trimCol, 0, 8, 6, 0.4);

    acc.setJoint(HUMANOID_JOINT_PELVIS).setRoughness(0.45);
    acc.addCylinder([0, 0.92, 0], 0.162, 0.095, 'y', topCol, 0, 14, 0.35);
    acc.addCylinder([0, 0.83, 0], 0.166, 0.016, 'y', trimCol, 0, 14, 0.5);

    for (const [jArm, sx] of [
      [HUMANOID_JOINT_LOWERARM_L, 1],
      [HUMANOID_JOINT_LOWERARM_R, -1],
    ] as const) {
      acc.setJoint(jArm).setRoughness(0.42);
      acc.addCylinder([sx * 0.52, 1.405, 0], 0.044, 0.045, 'x', glovesCol, 0, 10, 0.45);
    }
  } else if (char.id === 'yoshimaru') {
    // Layered Samurai Sode Shoulder Armor + Kusazuri Waist Tassets + Glowing 3D Katana!
    for (const [jUpper, sx] of [
      [HUMANOID_JOINT_UPPERARM_L, 1],
      [HUMANOID_JOINT_UPPERARM_R, -1],
    ] as const) {
      acc.setJoint(jUpper).setRoughness(0.28);
      acc.addBox([sx * 0.25, 1.47, 0], [0.065, 0.085, 0.105], topCol, 0, 0.72);
      acc.addBox([sx * 0.255, 1.39, 0], [0.068, 0.022, 0.108], trimCol, 0, 0.82);
    }
    acc.setJoint(HUMANOID_JOINT_PELVIS).setRoughness(0.3);
    acc.addBox([-0.165, 0.89, 0], [0.024, 0.11, 0.12], topCol, 0, 0.72);
    acc.addBox([0.165, 0.89, 0], [0.024, 0.11, 0.12], topCol, 0, 0.72);

    acc.setJoint(HUMANOID_JOINT_HAND_R).setRoughness(0.24);
    acc.addCylinder([-0.76, 1.445, -0.06], 0.015, 0.22, 'z', srgbColor(0.14, 0.14, 0.18), 0, 8, 0.5);
    acc.addCylinder([-0.76, 1.445, 0.055], 0.044, 0.015, 'z', trimCol, 0, 10, 0.78);
    acc.setEmissiveColor(hexToLinear(c.aura));
    acc.addBox([-0.76, 1.445, 0.50], [0.005, 0.016, 0.43], srgbColor(0.84, 0.9, 0.98), 0.45, 0.85);
    acc.setEmissiveColor(null);
  } else if (char.id === 'edgar') {
    // Braided Capoeira Cordão Belt + Tassels + Baggy Abadá Capoeira Trousers!
    acc.setJoint(HUMANOID_JOINT_PELVIS).setRoughness(0.5);
    acc.addCylinder([0, 1.005, 0], 0.16, 0.024, 'y', trimCol, 0, 14, 0.4);
    acc.addCapsule([0.145, 0.88, 0.04], 0.016, 0.11, trimCol, 0, 8, 6, 0.4);
    for (const [jCalf, sx] of [
      [HUMANOID_JOINT_CALF_L, 1],
      [HUMANOID_JOINT_CALF_R, -1],
    ] as const) {
      acc.setJoint(jCalf).setRoughness(0.6);
      acc.addCylinder([sx * 0.105, 0.32, 0], 0.08, 0.21, 'y', pantsCol, 0, 12, 0.18);
    }
  } else if (char.id === 'steven') {
    // Unmistakable 3D Puffy Championship Boxing Gloves (`hand_l` & `hand_r`) + Satin Boxing Trunks!
    acc.setJoint(HUMANOID_JOINT_HAND_L).setRoughness(0.28);
    acc.addSphere([0.78, 1.445, 0.015], 0.076, glovesCol, 0, 14, 10, 0.72);
    acc.addCylinder([0.69, 1.445, 0], 0.052, 0.055, 'x', trimCol, 0, 12, 0.75);

    acc.setJoint(HUMANOID_JOINT_HAND_R).setRoughness(0.28);
    acc.addSphere([-0.78, 1.445, 0.015], 0.076, glovesCol, 0, 14, 10, 0.72);
    acc.addCylinder([-0.69, 1.445, 0], 0.052, 0.055, 'x', trimCol, 0, 12, 0.75);

    acc.setJoint(HUMANOID_JOINT_PELVIS).setRoughness(0.32);
    acc.addCylinder([0, 1.01, 0], 0.168, 0.038, 'y', trimCol, 0, 16, 0.68);
    for (const [jThigh, sx] of [
      [HUMANOID_JOINT_THIGH_L, 1],
      [HUMANOID_JOINT_THIGH_R, -1],
    ] as const) {
      acc.setJoint(jThigh).setRoughness(0.34);
      acc.addCylinder([sx * 0.105, 0.77, 0], 0.095, 0.12, 'y', pantsCol, 0, 12, 0.6);
    }
  } else if (char.id === 'jinpachi') {
    // Spiked Demonic Shoulder Pauldrons + Wide Grandmaster Hakama Trousers + Prayer Rope Obi!
    for (const [jClav, sx] of [
      [HUMANOID_JOINT_CLAVICLE_L, 1],
      [HUMANOID_JOINT_CLAVICLE_R, -1],
    ] as const) {
      acc.setJoint(jClav).setRoughness(0.36);
      acc.addSphere([sx * 0.2, 1.49, 0], 0.068, trimCol, 0, 10, 8, 0.55);
      acc.addCapsule([sx * 0.23, 1.56, -0.01], 0.016, 0.055, hairCol, 0, 8, 6, 0.45);
    }
    acc.setJoint(HUMANOID_JOINT_PELVIS).setRoughness(0.45);
    acc.addCylinder([0, 1.01, 0], 0.185, 0.045, 'y', trimCol, 0, 16, 0.45);
    for (const [jCalf, sx] of [
      [HUMANOID_JOINT_CALF_L, 1],
      [HUMANOID_JOINT_CALF_R, -1],
    ] as const) {
      acc.setJoint(jCalf).setRoughness(0.58);
      acc.addCylinder([sx * 0.11, 0.33, 0], 0.096, 0.22, 'y', pantsCol, 0, 12, 0.22);
    }
  }

  const accMesh = acc.build({ colorSpace: 'linear' });
  const parts: MeshData[] = [browsMesh, eyesMesh, dressedBody, ...extraParts];
  if (accMesh.positions.length > 0) {
    parts.push(accMesh);
  }

  // Always keep bind vertices at 1.0 scale so finger/joint inverseBind pivots are 100% exact!
  return mergeSkinnedParts(parts);
}

const GROUND_CONTACT_CLEARANCES: ReadonlyArray<readonly [number, number]> = [
  [HUMANOID_JOINT_FOOT_L, 0.082],
  [HUMANOID_JOINT_FOOT_R, 0.082],
  [HUMANOID_JOINT_BALL_L, 0.042],
  [HUMANOID_JOINT_BALL_R, 0.042],
  [HUMANOID_JOINT_CALF_L, 0.052],
  [HUMANOID_JOINT_CALF_R, 0.052],
  [HUMANOID_JOINT_PELVIS, 0.092],
  [HUMANOID_JOINT_SPINE2, 0.092],
  [HUMANOID_JOINT_HEAD, 0.102],
];

/**
 * 65-Bone Motion-Captured Fighter Animator powered by `@driftengine/animation`.
 * - Uses exact Male vs Female `inverseBind` skeleton (`activeSkeleton`) so Nina & Lin Xiao
 *   have zero curved/hyper-extended fingers!
 * - Clamps real-time foot/sole/body ground contact so no body part ever sinks below `Y = 0`!
 */
export class MocapFighterAnimator {
  readonly maleSkeleton: Skeleton;
  readonly femaleSkeleton: Skeleton;
  private currentSkeleton: Skeleton;
  private readonly pack: LoadedHumanoidPack;
  private readonly targetPose: Pose;
  private readonly prevPose: Pose;
  private readonly finalPose: Pose;

  private activeClipName = '';
  private blendTimer = 0;
  private blendDuration = 0.09;

  constructor(pack: LoadedHumanoidPack) {
    this.pack = pack;
    this.maleSkeleton = new Skeleton(pack.joints, pack.inverseBind);
    this.femaleSkeleton = new Skeleton(pack.joints, pack.femaleInverseBind);
    this.currentSkeleton = this.maleSkeleton;
    this.targetPose = createPose(this.maleSkeleton.jointCount);
    this.prevPose = createPose(this.maleSkeleton.jointCount);
    this.finalPose = createPose(this.maleSkeleton.jointCount);

    this.copyPose(pack.bindPose, this.finalPose);
    this.maleSkeleton.applyPose(this.finalPose);
    this.femaleSkeleton.applyPose(this.finalPose);
  }

  get skeleton(): Skeleton {
    return this.currentSkeleton;
  }

  private copyPose(src: Pose, dst: Pose): void {
    dst.translation.set(src.translation);
    dst.rotation.set(src.rotation);
    dst.scale.set(src.scale);
  }

  private selectClipAndTime(
    f: FighterSim,
    clockSec: number,
    isShowcasePreview: boolean,
    isWinnerOutro: boolean,
  ): { name: string; timeSec: number } {
    const isSword = f.char.id === 'yoshimaru';

    if (isShowcasePreview) {
      // Use a compact guard-ready idle in menu/select; folded-arm showcase clips look non-combatant.
      const name = isSword ? 'Sword_Idle' : 'Idle_Shield_Loop';
      const clip = this.pack.clips.get(name);
      return { name, timeSec: clip ? clockSec % clip.durationSec : 0 };
    }

    if (isWinnerOutro && f.hp > 0 && f.state !== 'ko' && f.state !== 'knockdown') {
      const clip = this.pack.clips.get('Celebration');
      return { name: 'Celebration', timeSec: clip ? clockSec % clip.durationSec : 0 };
    }

    switch (f.state) {
      case 'attack': {
        const m = f.activeMove;
        if (!m) break;
        const totalFrames = Math.max(1, m.startup + m.active + m.recovery);
        const progress = Math.min(0.98, f.stateFrame / totalFrames);

        let name = 'Punch_Jab';
        if (m.anim === 'katana_slash' || m.anim === 'katana_spin' || (isSword && m.damage >= 20)) {
          name = m.launch ? 'Sword_UpperCut' : m.damage >= 25 ? 'Sword_Heavy_A' : 'Sword_Light_A';
        } else if (m.anim === 'rage_art' || m.id.includes('rage')) {
          name = 'Melee_Combo';
        } else if (m.isThrow || m.anim === 'throw_suplex') {
          name = 'OverhandThrow';
        } else if (m.armor) {
          name = 'Shield_Dash';
        } else if (m.anim === 'hopkick' || m.anim === 'somersault' || m.anim === 'flying_kick') {
          name = 'BackFlip';
        } else if (m.launch || m.anim === 'uppercut_r' || m.anim === 'electric_upper') {
          name = 'Melee_Uppercut';
        } else if (m.anim === 'low_sweep' || m.anim === 'hell_sweep') {
          name = 'Slide_Start';
        } else if (m.anim === 'knee_strike') {
          name = 'Melee_Knee';
        } else if (
          m.anim === 'hook_r' ||
          m.anim === 'deathfist' ||
          m.anim === 'demon_paw' ||
          m.anim === 'hammer_fist'
        ) {
          name = 'Melee_Hook';
        } else if (m.height === 'low') {
          name = m.limb === 'lp' || m.limb === 'rp' ? 'Punch_Jab' : 'Slide_Start';
        } else if (m.limb === 'lp') {
          name = 'Punch_Jab';
        } else if (m.limb === 'rp') {
          name = m.damage >= 22 ? 'Melee_Hook' : 'Punch_Cross';
        } else if (m.limb === 'lk') {
          name = 'Melee_Knee';
        } else if (m.limb === 'rk') {
          name = m.damage >= 26 ? 'BackFlip' : 'Kick';
        } else {
          name = 'Melee_Hook';
        }

        const clip = this.pack.clips.get(name);
        return { name, timeSec: clip ? progress * clip.durationSec : 0 };
      }

      case 'hitstun':
      case 'thrown': {
        const name =
          f.stateFrame < 6 && f.comboCounter > 1
            ? 'Hit_Knockback'
            : f.crouching
              ? 'Hit_Stomach'
              : 'Hit_Head';
        const clip = this.pack.clips.get(name);
        const t = Math.min(0.95, f.stateFrame / 22);
        return { name, timeSec: clip ? t * clip.durationSec : 0 };
      }

      case 'blockstun': {
        const name = isSword ? 'Sword_Idle' : 'Idle_Shield_Loop';
        const clip = this.pack.clips.get(name);
        return { name, timeSec: clip ? 0.15 : 0 };
      }

      case 'jump':
      case 'juggle': {
        const name = f.vy > 0.01 ? 'LiftAir' : 'LiftAir_Hit_L';
        const clip = this.pack.clips.get(name);
        const t = Math.min(0.95, f.stateFrame / 28);
        return { name, timeSec: clip ? t * clip.durationSec : 0 };
      }

      case 'ko': {
        const clip = this.pack.clips.get('Death01');
        const t = Math.min(0.98, f.stateFrame / 38);
        return { name: 'Death01', timeSec: clip ? t * clip.durationSec : 0 };
      }

      case 'knockdown': {
        if (f.hp <= 0) {
          const clip = this.pack.clips.get('Death01');
          const t = Math.min(0.98, f.stateFrame / 38);
          return { name: 'Death01', timeSec: clip ? t * clip.durationSec : 0 };
        }
        if (f.stateFrame > 24) {
          const clip = this.pack.clips.get('KipUp');
          const t = Math.min(0.98, (f.stateFrame - 24) / 22);
          return { name: 'KipUp', timeSec: clip ? t * clip.durationSec : 0 };
        }
        const clip = this.pack.clips.get('LiftAir_Fall_Impact');
        const t = Math.min(0.98, f.stateFrame / 24);
        return { name: 'LiftAir_Fall_Impact', timeSec: clip ? t * clip.durationSec : 0 };
      }

      case 'sidestep': {
        const name = f.sidestepDir > 0 ? 'Dodge_Left' : 'Dodge_Right';
        const clip = this.pack.clips.get(name);
        const t = Math.min(0.95, f.stateFrame / 18);
        return { name, timeSec: clip ? t * clip.durationSec : 0 };
      }

      case 'walk': {
        const forward = f.dashFrames > 0 ? f.dashDir >= 0 : f.vx * f.facing >= -0.001;
        const speedMul = f.dashFrames > 0 ? 1.85 : 1.2;
        const name = f.crouching
          ? 'Crouch_Fwd_Loop'
          : forward
            ? 'Walk_Fwd_Loop'
            : 'Walk_Bwd_Loop';
        const clip = this.pack.clips.get(name);
        return { name, timeSec: clip ? (clockSec * speedMul) % clip.durationSec : 0 };
      }

      default:
        break;
    }

    const idleName = f.crouching
      ? 'Crouch_Idle_Loop'
      : isSword
        ? 'Sword_Idle'
        : 'Idle_Shield_Loop';
    const idleClip = this.pack.clips.get(idleName);
    return {
      name: idleName,
      timeSec: idleClip ? (clockSec * 0.95) % idleClip.durationSec : 0,
    };
  }

  update(
    f: FighterSim,
    clockSec: number,
    dt = 1 / 60,
    isShowcasePreview = false,
    isWinnerOutro = false,
  ): void {
    const skel = FEMALE_IDS.has(f.char.id) ? this.femaleSkeleton : this.maleSkeleton;
    this.currentSkeleton = skel;

    const { name, timeSec } = this.selectClipAndTime(
      f,
      clockSec,
      isShowcasePreview,
      isWinnerOutro,
    );
    const clip = this.pack.clips.get(name);
    if (!clip) return;

    if (name !== this.activeClipName) {
      if (this.activeClipName !== '') {
        this.copyPose(this.finalPose, this.prevPose);
        this.blendTimer = 0;
        this.blendDuration = f.state === 'attack' || f.state === 'hitstun' ? 0.055 : 0.1;
      } else {
        this.blendTimer = 1;
      }
      this.activeClipName = name;
    }

    this.copyPose(this.pack.bindPose, this.targetPose);
    sampleClip(clip, timeSec, this.targetPose);

    if (this.blendTimer < this.blendDuration) {
      this.blendTimer += dt;
      const alpha = Math.min(1, this.blendTimer / this.blendDuration);
      blendPoses(this.prevPose, this.targetPose, alpha, this.finalPose);
    } else {
      this.copyPose(this.targetPose, this.finalPose);
    }

    skel.applyPose(this.finalPose);

    // Real-time Ground-Contact Clamping: prevent feet/soles/knees/hips from EVER sinking below Y = 0!
    let minGroundY = Infinity;
    for (let i = 0; i < GROUND_CONTACT_CLEARANCES.length; i += 1) {
      const [jIdx, solePad] = GROUND_CONTACT_CLEARANCES[i];
      const jy = skel.world[jIdx * 16 + 13] - solePad;
      if (jy < minGroundY) minGroundY = jy;
    }

    const isAirborneClip =
      !isShowcasePreview &&
      (f.y > 0.02 ||
        f.state === 'jump' ||
        f.state === 'juggle' ||
        (f.state === 'attack' &&
          (f.activeMove?.anim === 'hopkick' ||
            f.activeMove?.anim === 'somersault' ||
            f.activeMove?.anim === 'flying_kick')));

    if (minGroundY < 0) {
      // Lift root joint (joint 0) along +Y so lowest sole/contact sits right at Y = 0.000
      this.finalPose.translation[1] += Math.min(0.45, -minGroundY);
      skel.applyPose(this.finalPose);
    } else if (!isAirborneClip && minGroundY > 0.004 && minGroundY < 0.09) {
      // Plant stance feet cleanly on the arena floor when clip root slightly hovers
      this.finalPose.translation[1] -= minGroundY;
      skel.applyPose(this.finalPose);
    }
  }

  /** Reads a 65-bone joint's world arena position for electric lightning / particle emission */
  readJointArenaPos(
    jointIdx: number,
    fx: number,
    fy: number,
    fz: number,
    facing: 1 | -1,
    out: Vec3,
    bodyScale: Vec3 = [1, 1, 1],
  ): void {
    const o = jointIdx * 16;
    const lx = this.currentSkeleton.world[o + 12] * bodyScale[0];
    const ly = this.currentSkeleton.world[o + 13] * bodyScale[1];
    const lz = this.currentSkeleton.world[o + 14] * bodyScale[2];
    out[0] = fx + lz * facing;
    out[1] = fy + ly;
    out[2] = fz - lx * facing;
  }
}
