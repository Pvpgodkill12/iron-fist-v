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
export const HUMANOID_JOINT_CHEST = 4; // spine_03
export const HUMANOID_JOINT_NECK = 5;
export const HUMANOID_JOINT_HEAD = 6;
export const HUMANOID_JOINT_LOWERARM_L = 9;
export const HUMANOID_JOINT_HAND_L = 10;
export const HUMANOID_JOINT_LOWERARM_R = 33;
export const HUMANOID_JOINT_HAND_R = 34;
export const HUMANOID_JOINT_FOOT_L = 57;
export const HUMANOID_JOINT_FOOT_R = 62;

const FEMALE_IDS = new Set(['nina', 'linxiao']);
const SHIRTLESS_P1_IDS = new Set([
  'jinrai',
  'kazuma',
  'marcus',
  'jaguar',
  'edgar',
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
  taehwan: '#6b2016',
  marcus: '#16161c',
  paul: '#d9b44a',
  jaguar: '#d89b24',
  nina: '#e0c164',
  linxiao: '#181820',
  yoshimaru: '#8c1824',
  edgar: '#221814',
  steven: '#d8b24c',
  jinpachi: '#d8dce8',
};

interface LoadedHumanoidPack {
  readonly joints: readonly Joint[];
  readonly inverseBind: Float32Array;
  readonly malePrims: readonly [MeshData, MeshData, MeshData];
  readonly femalePrims: readonly [MeshData, MeshData, MeshData];
  readonly clips: ReadonlyMap<string, AnimationClip>;
  readonly bindPose: Pose;
}

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

export function parseHumanoidPackGlb(buffer: ArrayBuffer): LoadedHumanoidPack | null {
  const { json, binary } = readGlb(buffer);
  const blobs = binary ? [binary] : [];
  const { meshes } = gltfToMeshes(json, blobs);
  const { skins, clips } = readGltfSkins(json, blobs);
  if (meshes.length < 6 || skins.length < 1 || clips.length < 1) return null;

  const skin = skins[0];
  const clipMap = new Map<string, AnimationClip>();
  for (const c of clips) {
    clipMap.set(c.name, c);
  }

  const skel = new Skeleton(skin.joints, skin.inverseBind);
  const bindPose = createPose(skel.jointCount);
  const tpose = clipMap.get('A_TPose');
  if (tpose) {
    sampleClip(tpose, 0, bindPose);
  }

  return {
    joints: skin.joints,
    inverseBind: skin.inverseBind,
    malePrims: [meshes[0], meshes[1], meshes[2]],
    femalePrims: [meshes[3], meshes[4], meshes[5]],
    clips: clipMap,
    bindPose,
  };
}

export function loadHumanoidPack(): Promise<LoadedHumanoidPack | null> {
  if (cachedPack) return Promise.resolve(cachedPack);
  if (loadPromise) return loadPromise;

  if (typeof fetch !== 'function' || typeof window === 'undefined' || !window.location.protocol.startsWith('http')) {
    return Promise.resolve(null);
  }

  loadPromise = fetch('./models/fighters/martial_fighters.glb')
    .then((res) => (res.ok ? res.arrayBuffer() : null))
    .then((buf) => {
      if (!buf) return null;
      cachedPack = parseHumanoidPackGlb(buf);
      if (cachedPack) {
        for (const fn of readyListeners) fn();
        readyListeners.length = 0;
      }
      return cachedPack;
    })
    .catch(() => null);

  return loadPromise;
}

/** Merge multiple skinned MeshData chunks into one single draw-call MeshData */
function mergeSkinnedParts(parts: readonly MeshData[], uniformScale = 1): MeshData {
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
  const roughness = new Float32Array(totalVerts);
  const specular = new Float32Array(totalVerts);
  const joints = new Float32Array(totalVerts * 4);
  const weights = new Float32Array(totalVerts * 4);
  const indices = new Uint32Array(totalIndices);

  let vOffset = 0;
  let iOffset = 0;

  for (const p of parts) {
    const vCount = p.positions.length / 3;
    if (uniformScale === 1) {
      positions.set(p.positions, vOffset * 3);
    } else {
      for (let i = 0; i < p.positions.length; i += 1) {
        positions[vOffset * 3 + i] = p.positions[i] * uniformScale;
      }
    }
    normals.set(p.normals, vOffset * 3);
    colors.set(p.colors, vOffset * 3);
    emissive.set(p.emissive, vOffset);

    if (p.roughness) roughness.set(p.roughness, vOffset);
    else roughness.fill(0.48, vOffset, vOffset + vCount);

    if (p.specular) specular.set(p.specular, vOffset);
    else specular.fill(0.28, vOffset, vOffset + vCount);

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
    roughness,
    specular,
    joints,
    weights,
    indices,
  };
}

function paintPrimSolid(
  src: MeshData,
  linearColor: Vec3,
  emissiveVal = 0,
  roughVal = 0.35,
  specVal = 0.5,
): MeshData {
  const vCount = src.positions.length / 3;
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

/**
 * Customizes the sculpted 8,500+ vertex CC0 Humanoid 3D Mesh into each Fighter's
 * martial-arts outfit, gloves, boots, belt, hair, mask, or glowing katana!
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

  // 1. Brows / Lashes & Eyes
  const browsMesh = paintPrimSolid(rawBrows, hairCol, 0, 0.55, 0.2);
  const eyesMesh = isBoss
    ? paintPrimSolid(rawEyes, srgbColor(1.0, 0.22, 0.26), 2.4, 0.15, 0.9)
    : paintPrimSolid(rawEyes, srgbColor(0.95, 0.96, 0.99), 0.05, 0.12, 0.92);

  // 2. Anatomically Zone-Paint the 7,300+ Vertex Sculpted Humanoid Body
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

    // Dominant bone index (0..64)
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
    let spec = 0.28;
    let em = 0;

    if (domJ === 6) {
      // Head: Scalp/Hair vs Face Skin (or Jaguar Mask / Cyber Helmet!)
      if (char.id === 'jaguar') {
        col = py > 1.61 ? srgbColor(0.86, 0.62, 0.16) : skinCol;
        rough = 0.36;
      } else if (char.id === 'yoshimaru') {
        col = pz > 0.04 ? srgbColor(0.75, 0.14, 0.2) : topCol;
        em = pz > 0.06 && py > 1.65 && py < 1.71 ? 1.2 : 0;
        rough = 0.26;
        spec = 0.78;
      } else if (py > headCrownY || (py > headCrownY - 0.08 && (pz < -0.02 || Math.abs(px) > 0.068))) {
        col = hairCol;
        rough = 0.44;
      } else {
        col = skinCol;
      }
    } else if (domJ === 5) {
      // Neck
      col = char.id === 'yoshimaru' ? topCol : skinCol;
    } else if (domJ >= 2 && domJ <= 4) {
      // Torso (spine_01..03)
      if (shirtless) {
        col = skinCol;
        rough = 0.46;
        spec = 0.36;
        if (isBoss && py > 1.25 && Math.abs(px) < 0.08) {
          em = 0.45;
        }
      } else if (!isFemale && Math.abs(px) < 0.045 && pz > 0.05 && py > 1.35) {
        // Martial-arts Gi V-collar chest opening
        col = skinCol;
      } else if (Math.abs(px) < 0.062 && pz > 0.055 && py > 1.22) {
        // Gi lapel trim
        col = trimCol;
        rough = 0.4;
      } else {
        col = topCol;
        rough = char.id === 'nina' || char.id === 'yoshimaru' ? 0.26 : 0.56;
        spec = char.id === 'nina' || char.id === 'yoshimaru' ? 0.72 : 0.24;
      }
    } else if (domJ === 7 || domJ === 31) {
      // Clavicles / Shoulders
      col = shirtless ? skinCol : topCol;
    } else if (domJ === 8 || domJ === 32) {
      // Upper Arms
      col = sleeveless ? skinCol : topCol;
    } else if (domJ === 9 || domJ === 33) {
      // Forearms -> Martial-Arts Bracers / Wraps near wrists!
      const wristDist = Math.abs(px);
      if (wristDist > (isFemale ? 0.5 : 0.55)) {
        col = glovesCol;
        rough = 0.34;
        spec = 0.55;
      } else {
        col = sleeveless ? skinCol : topCol;
      }
    } else if ((domJ >= 10 && domJ <= 30) || (domJ >= 34 && domJ <= 54)) {
      // Hands & All 30 Articulated Finger Bones -> Fighting Gloves!
      col = Math.abs(px) > (isFemale ? 0.67 : 0.75) ? glovesCol : trimCol;
      rough = 0.32;
      spec = 0.62;
    } else if (domJ === 1) {
      // Pelvis -> Martial-Arts Obi Belt (upper) + Gi Pants / Trunks (lower)
      if (py > (isFemale ? 0.98 : 1.0)) {
        col = trimCol;
        rough = 0.38;
        spec = 0.5;
      } else {
        col = pantsCol;
        rough = 0.55;
      }
    } else if (domJ === 55 || domJ === 56 || domJ === 60 || domJ === 61) {
      // Thighs & Calves -> Gi Pants / Tights + Side Trim Stripe!
      if (char.id === 'jaguar' && py < 0.78 && py > 0.36) {
        col = skinCol; // Pro-wrestling trunks + knee boots!
      } else if (Math.abs(px) > 0.168) {
        col = trimCol;
        rough = 0.38;
      } else {
        col = pantsCol;
        rough = char.id === 'nina' ? 0.28 : 0.58;
        spec = char.id === 'nina' ? 0.68 : 0.22;
      }
    } else {
      // Feet & Toes -> Boots / Foot Wraps
      col = bootsCol;
      rough = 0.38;
      spec = 0.48;
    }

    colors[v * 3] = col[0];
    colors[v * 3 + 1] = col[1];
    colors[v * 3 + 2] = col[2];
    emissive[v] = em;
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

  // 3. Signature 3D Sculpted Hair, Masks, Headbands & Weapons Bound Directly to 65-Bone Skeleton!
  const acc = new MeshBuilder();
  const headTopY = isFemale ? 1.75 : 1.79;

  // Bind accessories to Head (Joint 6) in T-pose model space
  acc.setJoint(HUMANOID_JOINT_HEAD);
  acc.setRoughness(0.38);

  if (char.id === 'paul') {
    // Iconic Tall Blonde Flat-Top
    acc.addBox([0, headTopY + 0.055, -0.005], [0.072, 0.075, 0.078], hairCol, 0, 0.35);
  } else if (char.id === 'jinrai' || char.id === 'kazuma' || char.id === 'taehwan') {
    // Spiky Mishima / Karate 3D Hair Tufts + Headband
    acc.addOrientedBox([0, headTopY + 0.02, -0.02], [0.068, 0.042, 0.08], [0, 0.35, -0.94], hairCol, 0, 0.3);
    acc.addOrientedBox([-0.048, headTopY + 0.015, -0.03], [0.03, 0.038, 0.07], [-0.25, 0.4, -0.88], hairCol, 0, 0.3);
    acc.addOrientedBox([0.048, headTopY + 0.015, -0.03], [0.03, 0.038, 0.07], [0.25, 0.4, -0.88], hairCol, 0, 0.3);
    if (char.id === 'jinrai' || char.id === 'taehwan') {
      acc.addCylinder([0, headTopY - 0.055, 0], 0.092, 0.016, 'y', trimCol, 0, 14, 0.5);
      acc.addOrientedBox([0.025, headTopY - 0.08, -0.13], [0.018, 0.055, 0.02], [0.1, -0.5, -0.86], trimCol, 0, 0.4);
    }
  } else if (char.id === 'jaguar') {
    // 3D Sculpted Golden Jaguar Mask Ears & Snout
    const goldMask = srgbColor(0.9, 0.66, 0.16);
    acc.addBox([-0.062, headTopY + 0.02, -0.01], [0.024, 0.036, 0.024], goldMask, 0, 0.5);
    acc.addBox([0.062, headTopY + 0.02, -0.01], [0.024, 0.036, 0.024], goldMask, 0, 0.5);
    acc.addBox([0, headTopY - 0.13, 0.105], [0.048, 0.036, 0.038], goldMask, 0, 0.5);
  } else if (char.id === 'nina') {
    // Sleek High Assassin Ponytail
    acc.addCapsule([0, headTopY - 0.06, -0.135], 0.034, 0.085, hairCol, 0, 10, 6, 0.4);
  } else if (char.id === 'linxiao') {
    // Twin Kung-Fu Hair Buns + Trim Ribbons
    acc.addSphere([-0.078, headTopY - 0.01, -0.02], 0.042, hairCol, 0, 10, 8, 0.35);
    acc.addSphere([0.078, headTopY - 0.01, -0.02], 0.042, hairCol, 0, 10, 8, 0.35);
    acc.addCylinder([-0.078, headTopY - 0.01, -0.02], 0.046, 0.01, 'x', trimCol, 0, 10, 0.5);
    acc.addCylinder([0.078, headTopY - 0.01, -0.02], 0.046, 0.01, 'x', trimCol, 0, 10, 0.5);
  } else if (char.id === 'yoshimaru') {
    // Cyber-Samurai Kabuto Crescent Horns!
    acc.setEmissiveColor(hexToLinear(c.aura));
    acc.addOrientedBox([-0.065, headTopY + 0.045, 0.04], [0.014, 0.075, 0.02], [-0.45, 0.88, 0.15], trimCol, 1.4, 0.85);
    acc.addOrientedBox([0.065, headTopY + 0.045, 0.04], [0.014, 0.075, 0.02], [0.45, 0.88, 0.15], trimCol, 1.4, 0.85);
    acc.setEmissiveColor(null);
  } else if (char.id === 'jinpachi') {
    // Demonic Horns & Twin Mishima Hair Wings
    acc.setEmissiveColor(hexToLinear(c.aura));
    acc.addOrientedBox([-0.085, headTopY + 0.03, 0.01], [0.028, 0.075, 0.03], [-0.55, 0.82, 0.1], hairCol, 0.8, 0.5);
    acc.addOrientedBox([0.085, headTopY + 0.03, 0.01], [0.028, 0.075, 0.03], [0.55, 0.82, 0.1], hairCol, 0.8, 0.5);
    acc.setEmissiveColor(null);
  }

  // Yoshimaru's Glowing 3D Katana Bound Directly to Right Hand (`hand_r` = Joint 34)!
  if (char.id === 'yoshimaru') {
    acc.setJoint(HUMANOID_JOINT_HAND_R);
    // In T-pose, hand_r sits at X = -0.76, Y = 1.445, Z = -0.05; blade extends forward along +Z!
    acc.addBox([-0.76, 1.445, -0.06], [0.016, 0.016, 0.11], srgbColor(0.15, 0.15, 0.2), 0, 0.7);
    acc.addBox([-0.76, 1.445, 0.055], [0.046, 0.046, 0.01], trimCol, 0.2, 0.9);
    acc.setEmissiveColor(hexToLinear(c.aura));
    acc.addBox([-0.76, 1.445, 0.52], [0.007, 0.02, 0.45], srgbColor(0.85, 0.96, 1.0), 2.1, 0.95);
    acc.setEmissiveColor(null);
  }

  const accMesh = acc.build({ colorSpace: 'linear' });
  const parts =
    accMesh.positions.length > 0
      ? [browsMesh, eyesMesh, dressedBody, accMesh]
      : [browsMesh, eyesMesh, dressedBody];

  return mergeSkinnedParts(parts, isBoss ? 1.07 : 1.0);
}

/**
 * 65-Bone Motion-Captured Fighter Animator powered by `@driftengine/animation`.
 * Smoothly cross-fades real martial-arts clips at 60Hz with zero heap allocations!
 */
export class MocapFighterAnimator {
  readonly skeleton: Skeleton;
  private readonly pack: LoadedHumanoidPack;
  private readonly targetPose: Pose;
  private readonly prevPose: Pose;
  private readonly finalPose: Pose;

  private activeClipName = '';
  private blendTimer = 0;
  private blendDuration = 0.09;

  constructor(pack: LoadedHumanoidPack) {
    this.pack = pack;
    this.skeleton = new Skeleton(pack.joints, pack.inverseBind);
    this.targetPose = createPose(this.skeleton.jointCount);
    this.prevPose = createPose(this.skeleton.jointCount);
    this.finalPose = createPose(this.skeleton.jointCount);

    this.copyPose(pack.bindPose, this.finalPose);
    this.skeleton.applyPose(this.finalPose);
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
      const name = isSword ? 'Sword_Idle' : 'Idle_FoldArms_Loop';
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
        if (isSword && (m.id.includes('slash') || m.launch || m.damage >= 22)) {
          name = m.launch ? 'Sword_UpperCut' : m.damage >= 25 ? 'Sword_Heavy_A' : 'Sword_Light_A';
        } else if (m.id.includes('rage')) {
          name = 'Melee_Combo';
        } else if (m.isThrow) {
          name = 'OverhandThrow';
        } else if (m.armor) {
          name = 'Shield_Dash';
        } else if (m.launch) {
          name = 'Melee_Uppercut';
        } else if (m.height === 'low') {
          name = 'Slide_Start';
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
        const forward = f.vx * f.facing >= -0.001;
        const name = f.crouching
          ? 'Crouch_Fwd_Loop'
          : forward
            ? 'Walk_Fwd_Loop'
            : 'Walk_Bwd_Loop';
        const clip = this.pack.clips.get(name);
        return { name, timeSec: clip ? (clockSec * 1.2) % clip.durationSec : 0 };
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

    this.skeleton.applyPose(this.finalPose);
  }

  /** Reads a 65-bone joint's world arena position for electric lightning / particle emission */
  readJointArenaPos(
    jointIdx: number,
    fx: number,
    fy: number,
    fz: number,
    facing: 1 | -1,
    out: Vec3,
  ): void {
    const o = jointIdx * 16;
    const lx = this.skeleton.world[o + 12];
    const ly = this.skeleton.world[o + 13];
    const lz = this.skeleton.world[o + 14];
    out[0] = fx + lz * facing;
    out[1] = fy + ly;
    out[2] = fz - lx * facing;
  }
}
