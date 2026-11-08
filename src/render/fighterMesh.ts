import { Skeleton, blendPoses, createPose, type Joint, type Pose } from '@driftengine/animation';
import { MeshBuilder, clamp, lerp, srgbColor, type MeshData, type Vec3 } from '@driftengine/core';
import { mat4, quat } from 'gl-matrix';
import type { CharacterData, CostumePalette, MoveAnimKind, StanceStyle } from '../data/types';
import type { FighterSim } from '../sim/combat';
import { totalMoveFrames } from '../sim/combat';

export const JOINT_PELVIS = 0;
export const JOINT_SPINE = 1;
export const JOINT_CHEST = 2;
export const JOINT_NECK = 3;
export const JOINT_HEAD = 4;
export const JOINT_SHOULDER_L = 5;
export const JOINT_ELBOW_L = 6;
export const JOINT_WRIST_L = 7;
export const JOINT_SHOULDER_R = 8;
export const JOINT_ELBOW_R = 9;
export const JOINT_WRIST_R = 10;
export const JOINT_HIP_L = 11;
export const JOINT_KNEE_L = 12;
export const JOINT_ANKLE_L = 13;
export const JOINT_HIP_R = 14;
export const JOINT_KNEE_R = 15;
export const JOINT_ANKLE_R = 16;
export const JOINT_WEAPON_R = 17;
export const JOINT_WING_L = 18;
export const JOINT_WING_R = 19;
export const FIGHTER_JOINT_COUNT = 20;

interface JointSpec {
  name: string;
  parent: number;
  bindLocal: [number, number, number];
}

const JOINT_SPECS: readonly JointSpec[] = [
  { name: 'pelvis', parent: -1, bindLocal: [0, 0.94, 0] },
  { name: 'spine', parent: 0, bindLocal: [0, 0.14, 0] },
  { name: 'chest', parent: 1, bindLocal: [0, 0.22, 0] },
  { name: 'neck', parent: 2, bindLocal: [0, 0.22, 0] },
  { name: 'head', parent: 3, bindLocal: [0, 0.1, 0] },
  { name: 'shoulderL', parent: 2, bindLocal: [0.22, 0.16, 0] },
  { name: 'elbowL', parent: 5, bindLocal: [0.02, -0.27, 0] },
  { name: 'wristL', parent: 6, bindLocal: [0, -0.25, 0] },
  { name: 'shoulderR', parent: 2, bindLocal: [-0.22, 0.16, 0] },
  { name: 'elbowR', parent: 8, bindLocal: [-0.02, -0.27, 0] },
  { name: 'wristR', parent: 9, bindLocal: [0, -0.25, 0] },
  { name: 'hipL', parent: 0, bindLocal: [0.11, -0.04, 0] },
  { name: 'kneeL', parent: 11, bindLocal: [0, -0.43, 0] },
  { name: 'ankleL', parent: 12, bindLocal: [0, -0.41, 0] },
  { name: 'hipR', parent: 0, bindLocal: [-0.11, -0.04, 0] },
  { name: 'kneeR', parent: 14, bindLocal: [0, -0.43, 0] },
  { name: 'ankleR', parent: 15, bindLocal: [0, -0.41, 0] },
  { name: 'weaponR', parent: 10, bindLocal: [0, -0.04, 0.04] },
  { name: 'wingL', parent: 2, bindLocal: [0.13, 0.14, -0.13] },
  { name: 'wingR', parent: 2, bindLocal: [-0.13, 0.14, -0.13] },
];

const BIND_MODEL_POS: [number, number, number][] = [];
const FIGHTER_JOINTS: Joint[] = [];
const FIGHTER_INVERSE_BIND = new Float32Array(FIGHTER_JOINT_COUNT * 16);

(function initRigBindTables() {
  const tmpMat = mat4.create();
  for (let i = 0; i < FIGHTER_JOINT_COUNT; i += 1) {
    const spec = JOINT_SPECS[i];
    FIGHTER_JOINTS.push({ parent: spec.parent, name: spec.name });
    const [lx, ly, lz] = spec.bindLocal;
    if (spec.parent < 0) {
      BIND_MODEL_POS.push([lx, ly, lz]);
    } else {
      const [px, py, pz] = BIND_MODEL_POS[spec.parent];
      BIND_MODEL_POS.push([px + lx, py + ly, pz + lz]);
    }
    const [mx, my, mz] = BIND_MODEL_POS[i];
    mat4.fromTranslation(tmpMat, [-mx, -my, -mz]);
    FIGHTER_INVERSE_BIND.set(tmpMat, i * 16);
  }
})();

export function hexToVec3(hex: string): Vec3 {
  const clean = hex.replace('#', '');
  const num = parseInt(clean, 16);
  const r = ((num >> 16) & 255) / 255;
  const g = ((num >> 8) & 255) / 255;
  const b = (num & 255) / 255;
  return [r, g, b];
}

export function hexToLinear(hex: string): Vec3 {
  const [r, g, b] = hexToVec3(hex);
  return srgbColor(r, g, b);
}

function tintVec3(c: Vec3, factor: number): Vec3 {
  return [
    clamp(c[0] * factor, 0, 1),
    clamp(c[1] * factor, 0, 1),
    clamp(c[2] * factor, 0, 1),
  ];
}

/**
 * Builds a complete, single-draw-call GPU-skinned 3D martial artist MeshData
 * customized to the character's proportions, outfit, headgear, wings/cape & weapon!
 */
export function buildFighterMeshData(char: CharacterData, costumeIdx: 0 | 1): MeshData {
  const pal: CostumePalette = char.costumes[costumeIdx];
  const [sx, sy, sz] = char.bodyScale;

  const skin = hexToVec3(pal.skin);
  const skinShadow = tintVec3(skin, 0.84);
  const top = hexToVec3(pal.top);
  const topDark = tintVec3(top, 0.74);
  const pants = hexToVec3(pal.pants);
  const pantsDark = tintVec3(pants, 0.76);
  const trim = hexToVec3(pal.trim);
  const gloves = hexToVec3(pal.gloves);
  const boots = hexToVec3(pal.boots);
  const hair = hexToVec3(pal.hair);
  const aura = hexToVec3(pal.aura);
  const eyeWhite: Vec3 = [0.96, 0.97, 0.99];
  const darkMetal: Vec3 = [0.14, 0.15, 0.19];

  const b = new MeshBuilder();
  const jp = (idx: number, dx: number, dy: number, dz: number): Vec3 => {
    const [bx, by, bz] = BIND_MODEL_POS[idx];
    return [bx + dx * sx, by + dy * sy, bz + dz * sz];
  };

  // 0. PELVIS & MARTIAL ARTS BELT / SASH
  b.setJoint(JOINT_PELVIS);
  b.setRoughness(0.65);
  b.addCapsule(jp(JOINT_PELVIS, 0, 0.01, 0), 0.135 * sx, 0.05 * sy, pants, 0, 12, 6, 0.18);
  b.addBox(jp(JOINT_PELVIS, 0, 0.075, 0), [0.162 * sx, 0.036 * sy, 0.122 * sz], trim, 0.08, 0.45);
  // Belt knot & hanging tails in front (+Z)
  b.addBox(jp(JOINT_PELVIS, 0, 0.065, 0.128), [0.04 * sx, 0.04 * sy, 0.028 * sz], trim, 0.1, 0.5);
  b.addOrientedBox(jp(JOINT_PELVIS, 0.035, -0.04, 0.135), [0.022 * sx, 0.095 * sy, 0.012 * sz], [0.15, 0, 0.98], trim, 0.05, 0.35);
  b.addOrientedBox(jp(JOINT_PELVIS, -0.035, -0.04, 0.135), [0.022 * sx, 0.095 * sy, 0.012 * sz], [-0.15, 0, 0.98], trim, 0.05, 0.35);

  // 1. SPINE / ABDOMEN
  b.setJoint(JOINT_SPINE);
  const torsoMat = pal.bareChest ? skin : top;
  b.setRoughness(pal.bareChest ? 0.48 : 0.6);
  b.addCapsule(jp(JOINT_SPINE, 0, 0.06, 0), 0.138 * sx, 0.075 * sy, torsoMat, 0, 14, 6, 0.25);
  if (pal.bareChest) {
    // Sculpted abs
    for (const row of [0.02, 0.075, 0.13]) {
      b.addBox(jp(JOINT_SPINE, 0.038, row, 0.118), [0.032 * sx, 0.021 * sy, 0.022 * sz], skinShadow, 0, 0.3);
      b.addBox(jp(JOINT_SPINE, -0.038, row, 0.118), [0.032 * sx, 0.021 * sy, 0.022 * sz], skinShadow, 0, 0.3);
    }
    if (char.id === 'jinpachi') {
      // Jinpachi glowing demonic stomach fissure!
      b.setEmissiveColor(hexToLinear(pal.aura));
      b.addSphere(jp(JOINT_SPINE, 0, 0.08, 0.115), 0.068 * sx, trim, 1.4, 10, 6, 0.8);
      b.setEmissiveColor(null);
    }
  } else {
    // Gi / Jacket lapels
    b.addBox(jp(JOINT_SPINE, 0, 0.07, 0.125), [0.032 * sx, 0.085 * sy, 0.015 * sz], trim, 0.08, 0.4);
  }

  // 2. CHEST / PECTORALS / PAULDRONS
  b.setJoint(JOINT_CHEST);
  b.setRoughness(pal.bareChest ? 0.45 : 0.55);
  b.addCapsule(jp(JOINT_CHEST, 0, 0.09, 0), 0.168 * sx, 0.085 * sy, torsoMat, 0, 16, 8, 0.28);
  // Broad lats / upper chest taper
  b.addBox(jp(JOINT_CHEST, 0.07, 0.11, 0.095), [0.065 * sx, 0.052 * sy, 0.058 * sz], torsoMat, 0, 0.32);
  b.addBox(jp(JOINT_CHEST, -0.07, 0.11, 0.095), [0.065 * sx, 0.052 * sy, 0.058 * sz], torsoMat, 0, 0.32);
  if (!pal.bareChest) {
    // Martial arts collar / armor trim
    b.addOrientedBox(jp(JOINT_CHEST, 0.065, 0.13, 0.135), [0.025 * sx, 0.09 * sy, 0.016 * sz], [0.22, 0, 0.97], trim, 0.12, 0.5);
    b.addOrientedBox(jp(JOINT_CHEST, -0.065, 0.13, 0.135), [0.025 * sx, 0.09 * sy, 0.016 * sz], [-0.22, 0, 0.97], trim, 0.12, 0.5);
  } else if (char.id === 'kazuma') {
    // Kazuya iconic chest scar
    b.addOrientedBox(jp(JOINT_CHEST, -0.02, 0.09, 0.148), [0.012 * sx, 0.075 * sy, 0.01 * sz], [0.35, 0, 0.93], [0.55, 0.2, 0.2], 0, 0.2);
  }

  if (char.id === 'yoshimaru') {
    // Cyber-Shogun shoulder armor plates & glowing chest core
    b.setRoughness(0.22);
    b.addBox(jp(JOINT_CHEST, 0, 0.11, 0.14), [0.11 * sx, 0.08 * sy, 0.03 * sz], darkMetal, 0, 0.85);
    b.setEmissiveColor(hexToLinear(pal.aura));
    b.addSphere(jp(JOINT_CHEST, 0, 0.11, 0.165), 0.036 * sx, aura, 1.8, 10, 6, 0.9);
    b.setEmissiveColor(null);
  }

  // 3. NECK
  b.setJoint(JOINT_NECK);
  b.setRoughness(0.5);
  b.addCylinder(jp(JOINT_NECK, 0, 0.05, 0), 0.058 * sx, 0.06 * sy, 'y', skin, 0, 10, 0.2);

  // 4. HEAD, FACE & ICONIC TEKKEN 5 HEADGEAR / HAIR!
  b.setJoint(JOINT_HEAD);
  if (char.headGear === 'jaguar_mask') {
    // EL JAGUAR (King) sculpted golden jaguar head, ears, muzzle & fierce eyes!
    const goldFur: Vec3 = [0.85, 0.62, 0.15];
    const muzzle: Vec3 = [0.94, 0.86, 0.7];
    b.setRoughness(0.52);
    b.addSphere(jp(JOINT_HEAD, 0, 0.11, 0), 0.125 * sx, goldFur, 0, 14, 10, 0.25);
    b.addBox(jp(JOINT_HEAD, 0, 0.075, 0.105), [0.065 * sx, 0.042 * sy, 0.055 * sz], muzzle, 0, 0.2);
    b.addBox(jp(JOINT_HEAD, 0, 0.095, 0.155), [0.024 * sx, 0.016 * sy, 0.018 * sz], darkMetal, 0, 0.4);
    // Jaguar ears
    b.addBox(jp(JOINT_HEAD, 0.088, 0.215, -0.01), [0.028 * sx, 0.038 * sy, 0.022 * sz], goldFur, 0, 0.2);
    b.addBox(jp(JOINT_HEAD, -0.088, 0.215, -0.01), [0.028 * sx, 0.038 * sy, 0.022 * sz], goldFur, 0, 0.2);
    // Glowing fierce eyes & jaguar stripes
    b.setEmissiveColor(srgbColor(0.2, 1.0, 0.45));
    b.addBox(jp(JOINT_HEAD, 0.044, 0.125, 0.112), [0.018 * sx, 0.01 * sy, 0.012 * sz], [0.3, 1, 0.5], 1.3, 0.8);
    b.addBox(jp(JOINT_HEAD, -0.044, 0.125, 0.112), [0.018 * sx, 0.01 * sy, 0.012 * sz], [0.3, 1, 0.5], 1.3, 0.8);
    b.setEmissiveColor(null);
  } else if (char.headGear === 'oni_cyber_helm') {
    // YOSHIMARU biomechanical Oni Cyber Helmet + glowing visor!
    b.setRoughness(0.2);
    b.addSphere(jp(JOINT_HEAD, 0, 0.11, 0), 0.122 * sx, darkMetal, 0, 14, 10, 0.88);
    // Samurai crest horns
    b.addOrientedBox(jp(JOINT_HEAD, 0.06, 0.22, 0.06), [0.016 * sx, 0.065 * sy, 0.016 * sz], [0.4, 0.9, 0.2], trim, 0.5, 0.9);
    b.addOrientedBox(jp(JOINT_HEAD, -0.06, 0.22, 0.06), [0.016 * sx, 0.065 * sy, 0.016 * sz], [-0.4, 0.9, 0.2], trim, 0.5, 0.9);
    b.setEmissiveColor(hexToLinear(pal.aura));
    b.addBox(jp(JOINT_HEAD, 0, 0.115, 0.112), [0.075 * sx, 0.02 * sy, 0.02 * sz], aura, 2.0, 0.9);
    b.setEmissiveColor(null);
    // Flowing crimson kabuki mane behind helmet
    b.addBox(jp(JOINT_HEAD, 0, 0.11, -0.11), [0.085 * sx, 0.11 * sy, 0.045 * sz], hair, 0, 0.3);
  } else {
    // Human sculpted cranium, jawline, brows & eyes
    b.setRoughness(0.46);
    b.addSphere(jp(JOINT_HEAD, 0, 0.115, 0), 0.108 * sx, skin, 0, 14, 10, 0.22);
    b.addBox(jp(JOINT_HEAD, 0, 0.065, 0.032), [0.076 * sx, 0.048 * sy, 0.072 * sz], skin, 0, 0.22);
    // Eyes & brows
    b.addBox(jp(JOINT_HEAD, 0.038, 0.12, 0.098), [0.016 * sx, 0.009 * sy, 0.012 * sz], eyeWhite, 0.1, 0.5);
    b.addBox(jp(JOINT_HEAD, -0.038, 0.12, 0.098), [0.016 * sx, 0.009 * sy, 0.012 * sz], eyeWhite, 0.1, 0.5);
    b.addBox(jp(JOINT_HEAD, 0.038, 0.12, 0.104), [0.008 * sx, 0.008 * sy, 0.01 * sz], darkMetal, 0, 0.8);
    b.addBox(jp(JOINT_HEAD, -0.038, 0.12, 0.104), [0.008 * sx, 0.008 * sy, 0.01 * sz], darkMetal, 0, 0.8);
    b.addBox(jp(JOINT_HEAD, 0.04, 0.138, 0.102), [0.024 * sx, 0.006 * sy, 0.012 * sz], hair, 0, 0.3);
    b.addBox(jp(JOINT_HEAD, -0.04, 0.138, 0.102), [0.024 * sx, 0.006 * sy, 0.012 * sz], hair, 0, 0.3);

    // Distinct Tekken 5 Hairstyles!
    b.setRoughness(0.38);
    switch (char.headGear) {
      case 'spiky_black': {
        // Jin Kazama forward-swept bangs + spiky crown
        b.addSphere(jp(JOINT_HEAD, 0, 0.145, -0.015), 0.112 * sx, hair, 0, 12, 8, 0.35);
        for (const ox of [-0.06, -0.02, 0.02, 0.06]) {
          b.addOrientedBox(jp(JOINT_HEAD, ox, 0.21, -0.02), [0.024 * sx, 0.055 * sy, 0.035 * sz], [ox * 2, 0.4, -0.8], hair, 0, 0.4);
        }
        b.addBox(jp(JOINT_HEAD, 0.055, 0.15, 0.088), [0.018 * sx, 0.045 * sy, 0.018 * sz], hair, 0, 0.35);
        b.addBox(jp(JOINT_HEAD, -0.055, 0.15, 0.088), [0.018 * sx, 0.045 * sy, 0.018 * sz], hair, 0, 0.35);
        break;
      }
      case 'swept_widow': {
        // Kazuya iconic swept-back spike!
        b.addSphere(jp(JOINT_HEAD, 0, 0.145, -0.02), 0.11 * sx, hair, 0, 12, 8, 0.45);
        b.addOrientedBox(jp(JOINT_HEAD, 0, 0.215, -0.075), [0.068 * sx, 0.065 * sy, 0.085 * sz], [0, 0.45, -0.88], hair, 0, 0.45);
        break;
      }
      case 'headband_spiky': {
        // Hwoarang spiky orange hair + headband
        b.addBox(jp(JOINT_HEAD, 0, 0.16, 0.0), [0.112 * sx, 0.022 * sy, 0.114 * sz], trim, 0.1, 0.5);
        b.addSphere(jp(JOINT_HEAD, 0, 0.165, -0.01), 0.108 * sx, hair, 0, 12, 8, 0.35);
        b.addBox(jp(JOINT_HEAD, 0, 0.24, -0.01), [0.065 * sx, 0.048 * sy, 0.065 * sz], hair, 0, 0.35);
        break;
      }
      case 'tall_flattop': {
        // Paul Phoenix legendary tall blonde flattop cylinder!
        b.addCylinder(jp(JOINT_HEAD, 0, 0.245, -0.005), 0.098 * sx, 0.105 * sy, 'y', hair, 0.05, 14, 0.45);
        break;
      }
      case 'blonde_ponytail': {
        // Nina sleek hair + long ponytail behind head
        b.addSphere(jp(JOINT_HEAD, 0, 0.145, -0.015), 0.11 * sx, hair, 0, 12, 8, 0.5);
        b.addCapsule(jp(JOINT_HEAD, 0, 0.05, -0.145), 0.038 * sx, 0.11 * sy, hair, 0, 10, 6, 0.45);
        break;
      }
      case 'twin_buns': {
        // Xiaoyu twin side buns with ribbons
        b.addSphere(jp(JOINT_HEAD, 0, 0.14, -0.01), 0.108 * sx, hair, 0, 12, 8, 0.4);
        b.addSphere(jp(JOINT_HEAD, 0.115, 0.175, -0.02), 0.048 * sx, hair, 0, 10, 6, 0.4);
        b.addSphere(jp(JOINT_HEAD, -0.115, 0.175, -0.02), 0.048 * sx, hair, 0, 10, 6, 0.4);
        b.addBox(jp(JOINT_HEAD, 0.115, 0.13, -0.02), [0.02 * sx, 0.035 * sy, 0.02 * sz], trim, 0.1, 0.5);
        b.addBox(jp(JOINT_HEAD, -0.115, 0.13, -0.02), [0.02 * sx, 0.035 * sy, 0.02 * sz], trim, 0.1, 0.5);
        break;
      }
      case 'dreadlocks': {
        // Eddy capoeira locks
        b.addSphere(jp(JOINT_HEAD, 0, 0.15, -0.01), 0.11 * sx, hair, 0, 12, 8, 0.3);
        for (const ox of [-0.075, -0.035, 0.0, 0.035, 0.075]) {
          b.addCapsule(jp(JOINT_HEAD, ox, 0.06, -0.12), 0.02 * sx, 0.08 * sy, hair, 0, 8, 4, 0.25);
        }
        break;
      }
      case 'demon_crown': {
        // Jinpachi swept white beard/brows (matte, zero head glare!)
        b.addBox(jp(JOINT_HEAD, 0.065, 0.165, 0.085), [0.055 * sx, 0.018 * sy, 0.03 * sz], hair, 0, 0.25);
        b.addBox(jp(JOINT_HEAD, -0.065, 0.165, 0.085), [0.055 * sx, 0.018 * sy, 0.03 * sz], hair, 0, 0.25);
        b.addBox(jp(JOINT_HEAD, 0.065, 0.045, 0.095), [0.058 * sx, 0.025 * sy, 0.035 * sz], hair, 0, 0.25);
        b.addBox(jp(JOINT_HEAD, -0.065, 0.045, 0.095), [0.058 * sx, 0.025 * sy, 0.035 * sz], hair, 0, 0.25);
        break;
      }
      default: {
        // Bruce crop / Slick blonde
        b.addSphere(jp(JOINT_HEAD, 0, 0.148, -0.012), 0.111 * sx, hair, 0, 12, 8, 0.42);
        break;
      }
    }
  }

  // 5..10. ARMS (Shoulders, Biceps, Forearms, Gauntlets & Taped Fists)
  const buildArm = (
    shIdx: number,
    elIdx: number,
    wrIdx: number,
    sideSign: 1 | -1,
  ) => {
    const sleeveMat = pal.bareChest ? skin : top;
    // Shoulder deltoid + Upper arm
    b.setJoint(shIdx);
    b.setRoughness(0.46);
    b.addSphere(jp(shIdx, 0, 0, 0), 0.078 * sx, sleeveMat, 0, 10, 8, 0.25);
    b.addCapsule(jp(shIdx, sideSign * 0.01, -0.135, 0), 0.062 * sx, 0.105 * sy, skin, 0, 10, 6, 0.25);

    // Forearm + Martial Arts Bracer/Gauntlet
    b.setJoint(elIdx);
    b.addSphere(jp(elIdx, 0, 0, 0), 0.056 * sx, skin, 0, 10, 6, 0.22);
    b.addCapsule(jp(elIdx, 0, -0.115, 0), 0.052 * sx, 0.09 * sy, skin, 0, 10, 6, 0.22);
    b.setRoughness(0.32);
    b.addCylinder(jp(elIdx, 0, -0.185, 0), 0.058 * sx, 0.052 * sy, 'y', gloves, 0.06, 10, 0.55);
    b.addBox(jp(elIdx, sideSign * 0.035, -0.185, 0.02), [0.022 * sx, 0.055 * sy, 0.045 * sz], trim, 0.12, 0.65);

    // Fist / Boxing Glove
    b.setJoint(wrIdx);
    const fistRadius = char.stance === 'boxer' ? 0.082 : 0.064;
    b.setRoughness(0.28);
    b.addSphere(jp(wrIdx, 0, -0.03, 0.015), fistRadius * sx, gloves, 0.08, 12, 8, 0.65);
    // Studded knuckle plate
    b.addBox(jp(wrIdx, 0, -0.035, 0.062), [0.045 * sx, 0.028 * sy, 0.018 * sz], trim, 0.18, 0.8);
  };
  buildArm(JOINT_SHOULDER_L, JOINT_ELBOW_L, JOINT_WRIST_L, 1);
  buildArm(JOINT_SHOULDER_R, JOINT_ELBOW_R, JOINT_WRIST_R, -1);

  // 11..16. LEGS (Thighs, Gi/Hakama Trousers, Shins, Guards & Boots)
  const buildLeg = (
    hipIdx: number,
    kneeIdx: number,
    ankleIdx: number,
    sideSign: 1 | -1,
  ) => {
    b.setJoint(hipIdx);
    b.setRoughness(0.62);
    const thighRadius = char.id === 'jinrai' || char.id === 'kazuma' || char.id === 'paul' ? 0.102 : 0.088;
    b.addSphere(jp(hipIdx, 0, 0, 0), thighRadius * sx, pants, 0, 10, 8, 0.2);
    b.addCapsule(jp(hipIdx, 0, -0.21, 0), thighRadius * sx, 0.165 * sy, pants, 0, 12, 6, 0.2);
    // Side stripe / flame trim on pants!
    b.addBox(jp(hipIdx, sideSign * (thighRadius * 0.92), -0.21, 0.01), [0.018 * sx, 0.16 * sy, 0.038 * sz], trim, 0.12, 0.45);

    b.setJoint(kneeIdx);
    b.addSphere(jp(kneeIdx, 0, 0, 0), 0.078 * sx, pantsDark, 0, 10, 6, 0.22);
    b.addCapsule(jp(kneeIdx, 0, -0.2, 0), 0.075 * sx, 0.155 * sy, pants, 0, 12, 6, 0.22);
    // Shin flame / guard accent
    b.setRoughness(0.35);
    b.addBox(jp(kneeIdx, 0, -0.22, 0.068), [0.048 * sx, 0.12 * sy, 0.022 * sz], trim, 0.15, 0.55);

    b.setJoint(ankleIdx);
    b.setRoughness(0.3);
    b.addBox(jp(ankleIdx, 0, -0.025, 0.055), [0.062 * sx, 0.038 * sy, 0.128 * sz], boots, 0, 0.55);
    b.addBox(jp(ankleIdx, 0, -0.048, 0.055), [0.065 * sx, 0.014 * sy, 0.132 * sz], trim, 0.05, 0.4);
  };
  buildLeg(JOINT_HIP_L, JOINT_KNEE_L, JOINT_ANKLE_L, 1);
  buildLeg(JOINT_HIP_R, JOINT_KNEE_R, JOINT_ANKLE_R, -1);

  // 17. WEAPON JOINT (Yoshimaru's Glowing Plasma Katana!)
  b.setJoint(JOINT_WEAPON_R);
  if (pal.katana) {
    b.setRoughness(0.18);
    // Katana hilt & tsuba guard
    b.addCylinder(jp(JOINT_WEAPON_R, 0, 0, -0.06), 0.02, 0.11, 'z', darkMetal, 0, 8, 0.8);
    b.addBox(jp(JOINT_WEAPON_R, 0, 0, 0.05), [0.05, 0.05, 0.012], trim, 0.2, 0.9);
    // Glowing plasma katana blade extending forward & up!
    b.setEmissiveColor(hexToLinear(pal.aura));
    b.addBox(jp(JOINT_WEAPON_R, 0, 0.02, 0.48), [0.009, 0.024, 0.42], aura, 2.4, 0.95);
    b.setEmissiveColor(null);
  }

  // 18..19. CAPE / DEVIL WINGS (El Jaguar Cape or Jinpachi / Devil Spikes!)
  if (pal.cape) {
    b.setJoint(JOINT_WING_L);
    b.setRoughness(0.55);
    b.addOrientedBox(jp(JOINT_WING_L, 0.04, -0.28, -0.06), [0.13 * sx, 0.34 * sy, 0.016 * sz], [0.08, -0.12, -0.98], trim, 0.06, 0.35);
    b.setJoint(JOINT_WING_R);
    b.addOrientedBox(jp(JOINT_WING_R, -0.04, -0.28, -0.06), [0.13 * sx, 0.34 * sy, 0.016 * sz], [-0.08, -0.12, -0.98], trim, 0.06, 0.35);
  } else if (pal.demonWings) {
    b.setEmissiveColor(hexToLinear(pal.aura));
    b.setJoint(JOINT_WING_L);
    b.addOrientedBox(jp(JOINT_WING_L, 0.18, 0.16, -0.12), [0.045 * sx, 0.32 * sy, 0.035 * sz], [0.55, 0.65, -0.5], aura, 1.4, 0.85);
    b.addOrientedBox(jp(JOINT_WING_L, 0.28, 0.02, -0.15), [0.035 * sx, 0.24 * sy, 0.03 * sz], [0.75, 0.35, -0.55], trim, 1.1, 0.85);
    b.setJoint(JOINT_WING_R);
    b.addOrientedBox(jp(JOINT_WING_R, -0.18, 0.16, -0.12), [0.045 * sx, 0.32 * sy, 0.035 * sz], [-0.55, 0.65, -0.5], aura, 1.4, 0.85);
    b.addOrientedBox(jp(JOINT_WING_R, -0.28, 0.02, -0.15), [0.035 * sx, 0.24 * sy, 0.03 * sz], [-0.75, 0.35, -0.55], trim, 1.1, 0.85);
    b.setEmissiveColor(null);
  }

  return b.build({ colorSpace: 'srgb' });
}

const SCRATCH_Q = quat.create();
const DEG = Math.PI / 180;

function writePoseJoint(
  pose: Pose,
  j: number,
  rxDeg: number,
  ryDeg: number,
  rzDeg: number,
  dx = 0,
  dy = 0,
  dz = 0,
): void {
  const [bx, by, bz] = JOINT_SPECS[j].bindLocal;
  const t3 = j * 3;
  pose.translation[t3] = bx + dx;
  pose.translation[t3 + 1] = by + dy;
  pose.translation[t3 + 2] = bz + dz;

  quat.fromEuler(SCRATCH_Q, rxDeg, ryDeg, rzDeg);
  const r4 = j * 4;
  pose.rotation[r4] = SCRATCH_Q[0];
  pose.rotation[r4 + 1] = SCRATCH_Q[1];
  pose.rotation[r4 + 2] = SCRATCH_Q[2];
  pose.rotation[r4 + 3] = SCRATCH_Q[3];

  pose.scale[t3] = 1;
  pose.scale[t3 + 1] = 1;
  pose.scale[t3 + 2] = 1;
}

function resetPoseToBind(pose: Pose): void {
  for (let j = 0; j < FIGHTER_JOINT_COUNT; j += 1) {
    writePoseJoint(pose, j, 0, 0, 0);
  }
}

/**
 * Per-fighter zero-allocation Skeleton & procedural martial-arts Pose controller.
 */
export class FighterRigAnimator {
  readonly skeleton: Skeleton;
  private readonly basePose: Pose;
  private readonly targetPose: Pose;
  private readonly blendedPose: Pose;

  constructor() {
    this.skeleton = new Skeleton(FIGHTER_JOINTS, FIGHTER_INVERSE_BIND);
    this.basePose = createPose(FIGHTER_JOINT_COUNT);
    this.targetPose = createPose(FIGHTER_JOINT_COUNT);
    this.blendedPose = createPose(FIGHTER_JOINT_COUNT);
    resetPoseToBind(this.basePose);
    resetPoseToBind(this.targetPose);
    resetPoseToBind(this.blendedPose);
  }

  /**
   * Resolves the fighter's 20-joint skeleton for the current interpolated frame.
   * Note: In fighter local space:
   *   +Y = Up, +Z = Forward (toward opponent), +X = Fighter's Left, -X = Fighter's Right.
   *   Euler X negative swings a hanging limb FORWARD (+Z); positive swings BACKWARD (-Z).
   */
  update(f: FighterSim, timeSec: number): void {
    this.writeStancePose(this.basePose, f.char.stance, timeSec, f.rageActive);

    if (f.state === 'walk') {
      this.writeWalkPose(this.targetPose, f, timeSec);
      blendPoses(this.basePose, this.targetPose, 0.85, this.blendedPose);
    } else if (f.state === 'sidestep') {
      this.writeSidestepPose(this.targetPose, f);
      blendPoses(this.basePose, this.targetPose, 0.9, this.blendedPose);
    } else if (f.crouching && f.state === 'idle') {
      this.writeCrouchPose(this.targetPose);
      blendPoses(this.basePose, this.targetPose, 0.92, this.blendedPose);
    } else if (f.state === 'jump') {
      this.writeJumpPose(this.targetPose, f);
      blendPoses(this.basePose, this.targetPose, 0.9, this.blendedPose);
    } else if (f.state === 'blockstun') {
      this.writeBlockPose(this.targetPose, f.crouching);
      blendPoses(this.basePose, this.targetPose, 0.95, this.blendedPose);
    } else if (f.state === 'hitstun' || f.state === 'thrown') {
      this.writeHitstunPose(this.targetPose, f);
      blendPoses(this.basePose, this.targetPose, 0.95, this.blendedPose);
    } else if (f.state === 'juggle') {
      this.writeJugglePose(this.targetPose, f);
      blendPoses(this.basePose, this.targetPose, 1.0, this.blendedPose);
    } else if (f.state === 'knockdown' || f.state === 'ko') {
      this.writeKnockdownPose(this.targetPose, f);
      blendPoses(this.basePose, this.targetPose, 1.0, this.blendedPose);
    } else if (f.state === 'attack' && f.activeMove !== null) {
      const w = this.writeAttackPose(this.targetPose, f);
      blendPoses(this.basePose, this.targetPose, w, this.blendedPose);
    } else {
      blendPoses(this.basePose, this.basePose, 0, this.blendedPose);
    }

    // Subtle cape / wing breathing flutter
    const wingFlutter = Math.sin(timeSec * (f.rageActive ? 9.0 : 3.2)) * 8;
    writePoseJoint(this.blendedPose, JOINT_WING_L, 6 + wingFlutter * 0.4, -wingFlutter, 0);
    writePoseJoint(this.blendedPose, JOINT_WING_R, 6 + wingFlutter * 0.4, wingFlutter, 0);

    this.skeleton.applyPose(this.blendedPose);

    // Clamp 20-bone fallback rig feet/soles >= Y=0 so feet never sink below arena floor!
    const w = this.skeleton.world;
    const minSoleY = Math.min(
      w[JOINT_ANKLE_L * 16 + 13] - 0.085,
      w[JOINT_ANKLE_R * 16 + 13] - 0.085,
      w[JOINT_KNEE_L * 16 + 13] - 0.055,
      w[JOINT_KNEE_R * 16 + 13] - 0.055,
      w[JOINT_PELVIS * 16 + 13] - 0.085,
    );
    if (minSoleY < 0) {
      this.blendedPose.translation[JOINT_PELVIS * 3 + 1] += -minSoleY;
      this.skeleton.applyPose(this.blendedPose);
    }
  }

  /** Reads joint world position inside local character space and transforms to arena space */
  readJointArenaPos(
    jointIdx: number,
    arenaX: number,
    arenaY: number,
    arenaZ: number,
    facing: 1 | -1,
    out: Vec3,
  ): void {
    const o = jointIdx * 16;
    const lx = this.skeleton.world[o + 12];
    const ly = this.skeleton.world[o + 13];
    const lz = this.skeleton.world[o + 14];
    // Fighter node rotates +90deg around Y when facing=+1, -90deg when facing=-1:
    // facing=+1: local +Z -> world +X, local +X -> world -Z
    // facing=-1: local +Z -> world -X, local +X -> world +Z
    out[0] = arenaX + lz * facing;
    out[1] = arenaY + ly;
    out[2] = arenaZ - lx * facing;
  }

  private writeStancePose(pose: Pose, stance: StanceStyle, t: number, rage: boolean): void {
    resetPoseToBind(pose);
    const freq = stance === 'capoeira' ? 4.8 : stance === 'taekwondo' || stance === 'boxer' ? 4.2 : 2.8;
    const bob = Math.sin(t * freq) * 0.022;
    const sway = Math.cos(t * freq * 0.5) * 4;

    switch (stance) {
      case 'capoeira': {
        // Rhythmic Capoeira Ginga sway!
        const ginga = Math.sin(t * 4.5);
        writePoseJoint(pose, JOINT_PELVIS, 8, ginga * 22, 0, ginga * 0.06, -0.08 + Math.abs(ginga) * 0.03, 0);
        writePoseJoint(pose, JOINT_SPINE, 12, -ginga * 10, ginga * 6);
        writePoseJoint(pose, JOINT_SHOULDER_L, -45 - ginga * 25, 18, 22);
        writePoseJoint(pose, JOINT_ELBOW_L, -65, 0, 0);
        writePoseJoint(pose, JOINT_SHOULDER_R, -45 + ginga * 25, -18, -22);
        writePoseJoint(pose, JOINT_ELBOW_R, -65, 0, 0);
        writePoseJoint(pose, JOINT_HIP_L, -24 + ginga * 18, 0, 8);
        writePoseJoint(pose, JOINT_KNEE_L, 38, 0, 0);
        writePoseJoint(pose, JOINT_HIP_R, 14 - ginga * 18, 0, -8);
        writePoseJoint(pose, JOINT_KNEE_R, 34, 0, 0);
        break;
      }
      case 'taekwondo': {
        // Upright bouncing Taekwondo guard, hands relaxed, legs spring-loaded
        const hop = Math.abs(Math.sin(t * 5.2)) * 0.035;
        writePoseJoint(pose, JOINT_PELVIS, 2, -28, 0, 0, -0.04 + hop, 0);
        writePoseJoint(pose, JOINT_CHEST, 4, 18, 0);
        writePoseJoint(pose, JOINT_HEAD, 0, 10, 0);
        writePoseJoint(pose, JOINT_SHOULDER_L, -42, 15, 16);
        writePoseJoint(pose, JOINT_ELBOW_L, -78, 0, 0);
        writePoseJoint(pose, JOINT_SHOULDER_R, -32, -15, -18);
        writePoseJoint(pose, JOINT_ELBOW_R, -70, 0, 0);
        writePoseJoint(pose, JOINT_HIP_L, -22, 0, 7);
        writePoseJoint(pose, JOINT_KNEE_L, 32, 0, 0);
        writePoseJoint(pose, JOINT_HIP_R, 18, 0, -7);
        writePoseJoint(pose, JOINT_KNEE_R, 28, 0, 0);
        break;
      }
      case 'boxer': {
        // Peek-a-Boo high tight boxing guard + head weave!
        const weave = Math.sin(t * 4.4);
        writePoseJoint(pose, JOINT_PELVIS, 6, -18, 0, weave * 0.03, -0.05 + bob, 0);
        writePoseJoint(pose, JOINT_SPINE, 12, 8, weave * 7);
        writePoseJoint(pose, JOINT_HEAD, -8, 10, -weave * 5);
        writePoseJoint(pose, JOINT_SHOULDER_L, -68, 22, 12);
        writePoseJoint(pose, JOINT_ELBOW_L, -108, 0, -14);
        writePoseJoint(pose, JOINT_SHOULDER_R, -62, -22, -12);
        writePoseJoint(pose, JOINT_ELBOW_R, -112, 0, 14);
        writePoseJoint(pose, JOINT_HIP_L, -20, 0, 6);
        writePoseJoint(pose, JOINT_KNEE_L, 30, 0, 0);
        writePoseJoint(pose, JOINT_HIP_R, 16, 0, -6);
        writePoseJoint(pose, JOINT_KNEE_R, 28, 0, 0);
        break;
      }
      case 'kungfu': {
        // Low graceful Bagua / Phoenix open-palm guard
        writePoseJoint(pose, JOINT_PELVIS, 6, -24, 0, 0, -0.09 + bob, 0);
        writePoseJoint(pose, JOINT_SPINE, 10, 14, 0);
        writePoseJoint(pose, JOINT_SHOULDER_L, -62, 10, 26);
        writePoseJoint(pose, JOINT_ELBOW_L, -42, 0, 0);
        writePoseJoint(pose, JOINT_SHOULDER_R, -20, -20, -32);
        writePoseJoint(pose, JOINT_ELBOW_R, -82, 0, 0);
        writePoseJoint(pose, JOINT_HIP_L, -28, 0, 10);
        writePoseJoint(pose, JOINT_KNEE_L, 45, 0, 0);
        writePoseJoint(pose, JOINT_HIP_R, 20, 0, -10);
        writePoseJoint(pose, JOINT_KNEE_R, 40, 0, 0);
        break;
      }
      case 'cyberninja': {
        // Yoshimitsu sword-poised Manji stance
        writePoseJoint(pose, JOINT_PELVIS, 5, -20, 0, 0, -0.06 + bob, 0);
        writePoseJoint(pose, JOINT_CHEST, 6, 15, 0);
        writePoseJoint(pose, JOINT_SHOULDER_L, -52, 20, 20);
        writePoseJoint(pose, JOINT_ELBOW_L, -75, 0, 0);
        writePoseJoint(pose, JOINT_SHOULDER_R, -38, -28, -24);
        writePoseJoint(pose, JOINT_ELBOW_R, -55, 0, 0);
        writePoseJoint(pose, JOINT_HIP_L, -22, 0, 8);
        writePoseJoint(pose, JOINT_KNEE_L, 34, 0, 0);
        writePoseJoint(pose, JOINT_HIP_R, 18, 0, -8);
        writePoseJoint(pose, JOINT_KNEE_R, 30, 0, 0);
        break;
      }
      case 'wrestler':
      case 'demon_boss': {
        // Wide, imposing grappler / demon patriarch stance
        writePoseJoint(pose, JOINT_PELVIS, 8, -12 + sway * 0.4, 0, 0, -0.06 + bob, 0);
        writePoseJoint(pose, JOINT_SPINE, 10, 8, 0);
        writePoseJoint(pose, JOINT_SHOULDER_L, -40, 12, 28);
        writePoseJoint(pose, JOINT_ELBOW_L, -68, 0, -12);
        writePoseJoint(pose, JOINT_SHOULDER_R, -38, -12, -28);
        writePoseJoint(pose, JOINT_ELBOW_R, -68, 0, 12);
        writePoseJoint(pose, JOINT_HIP_L, -22, 0, 11);
        writePoseJoint(pose, JOINT_KNEE_L, 34, 0, 0);
        writePoseJoint(pose, JOINT_HIP_R, 14, 0, -11);
        writePoseJoint(pose, JOINT_KNEE_R, 32, 0, 0);
        break;
      }
      default: {
        // Classic Mishima / Kazama / Brawler Karate Guard!
        const rPulse = rage ? 1.35 : 1.0;
        writePoseJoint(pose, JOINT_PELVIS, 5, -22, 0, 0, -0.055 + bob * rPulse, 0);
        writePoseJoint(pose, JOINT_SPINE, 7, 12, 0);
        writePoseJoint(pose, JOINT_CHEST, 5, 10, 0);
        writePoseJoint(pose, JOINT_HEAD, -4, 0, 0);
        writePoseJoint(pose, JOINT_SHOULDER_L, -56, 16, 18);
        writePoseJoint(pose, JOINT_ELBOW_L, -86, 0, -10);
        writePoseJoint(pose, JOINT_SHOULDER_R, -36, -16, -20);
        writePoseJoint(pose, JOINT_ELBOW_R, -92, 0, 12);
        writePoseJoint(pose, JOINT_HIP_L, -22, 0, 8);
        writePoseJoint(pose, JOINT_KNEE_L, 34, 0, 0);
        writePoseJoint(pose, JOINT_ANKLE_L, -10, 0, 0);
        writePoseJoint(pose, JOINT_HIP_R, 18, 0, -8);
        writePoseJoint(pose, JOINT_KNEE_R, 30, 0, 0);
        writePoseJoint(pose, JOINT_ANKLE_R, -12, 0, 0);
        break;
      }
    }
  }

  private writeWalkPose(pose: Pose, f: FighterSim, t: number): void {
    resetPoseToBind(pose);
    const cyc = Math.sin(t * 10.5);
    const oppCyc = Math.cos(t * 10.5);
    writePoseJoint(pose, JOINT_PELVIS, 6, -14 + cyc * 6, 0, 0, -0.045 + Math.abs(oppCyc) * 0.025, 0);
    writePoseJoint(pose, JOINT_CHEST, 6, 12 - cyc * 6, 0);
    writePoseJoint(pose, JOINT_SHOULDER_L, -52 + cyc * 14, 15, 16);
    writePoseJoint(pose, JOINT_ELBOW_L, -85, 0, -10);
    writePoseJoint(pose, JOINT_SHOULDER_R, -42 - cyc * 14, -15, -18);
    writePoseJoint(pose, JOINT_ELBOW_R, -88, 0, 10);
    writePoseJoint(pose, JOINT_HIP_L, -10 + cyc * 28, 0, 6);
    writePoseJoint(pose, JOINT_KNEE_L, 26 + Math.max(0, -cyc) * 26, 0, 0);
    writePoseJoint(pose, JOINT_HIP_R, -10 - cyc * 28, 0, -6);
    writePoseJoint(pose, JOINT_KNEE_R, 26 + Math.max(0, cyc) * 26, 0, 0);
    void f;
  }

  private writeSidestepPose(pose: Pose, f: FighterSim): void {
    resetPoseToBind(pose);
    const lean = f.sidestepDir * 16;
    writePoseJoint(pose, JOINT_PELVIS, 10, -16, lean, 0, -0.09, 0);
    writePoseJoint(pose, JOINT_SPINE, 12, 12, lean * 0.6);
    writePoseJoint(pose, JOINT_SHOULDER_L, -55, 18, 22);
    writePoseJoint(pose, JOINT_ELBOW_L, -85, 0, 0);
    writePoseJoint(pose, JOINT_SHOULDER_R, -55, -18, -22);
    writePoseJoint(pose, JOINT_ELBOW_R, -85, 0, 0);
    writePoseJoint(pose, JOINT_HIP_L, -28, 0, 12);
    writePoseJoint(pose, JOINT_KNEE_L, 48, 0, 0);
    writePoseJoint(pose, JOINT_HIP_R, -18, 0, -12);
    writePoseJoint(pose, JOINT_KNEE_R, 44, 0, 0);
  }

  private writeCrouchPose(pose: Pose): void {
    resetPoseToBind(pose);
    writePoseJoint(pose, JOINT_PELVIS, 18, -16, 0, 0, -0.34, 0);
    writePoseJoint(pose, JOINT_SPINE, 16, 12, 0);
    writePoseJoint(pose, JOINT_HEAD, -16, 0, 0);
    writePoseJoint(pose, JOINT_SHOULDER_L, -62, 20, 16);
    writePoseJoint(pose, JOINT_ELBOW_L, -96, 0, -10);
    writePoseJoint(pose, JOINT_SHOULDER_R, -58, -20, -16);
    writePoseJoint(pose, JOINT_ELBOW_R, -96, 0, 10);
    writePoseJoint(pose, JOINT_HIP_L, -68, 0, 10);
    writePoseJoint(pose, JOINT_KNEE_L, 108, 0, 0);
    writePoseJoint(pose, JOINT_ANKLE_L, -32, 0, 0);
    writePoseJoint(pose, JOINT_HIP_R, -58, 0, -10);
    writePoseJoint(pose, JOINT_KNEE_R, 104, 0, 0);
    writePoseJoint(pose, JOINT_ANKLE_R, -30, 0, 0);
  }

  private writeJumpPose(pose: Pose, f: FighterSim): void {
    resetPoseToBind(pose);
    writePoseJoint(pose, JOINT_PELVIS, -6, -12, 0, 0, 0, 0);
    writePoseJoint(pose, JOINT_SHOULDER_L, -65, 15, 24);
    writePoseJoint(pose, JOINT_ELBOW_L, -75, 0, 0);
    writePoseJoint(pose, JOINT_SHOULDER_R, -55, -15, -24);
    writePoseJoint(pose, JOINT_ELBOW_R, -80, 0, 0);
    writePoseJoint(pose, JOINT_HIP_L, -52, 0, 8);
    writePoseJoint(pose, JOINT_KNEE_L, 82, 0, 0);
    writePoseJoint(pose, JOINT_HIP_R, -35, 0, -8);
    writePoseJoint(pose, JOINT_KNEE_R, 68, 0, 0);
    void f;
  }

  private writeBlockPose(pose: Pose, crouching: boolean): void {
    resetPoseToBind(pose);
    const drop = crouching ? -0.32 : -0.07;
    writePoseJoint(pose, JOINT_PELVIS, 8, -12, 0, 0, drop, -0.04);
    writePoseJoint(pose, JOINT_SPINE, 12, 6, 0);
    writePoseJoint(pose, JOINT_HEAD, 10, 0, 0);
    // Crossed high forearm guard!
    writePoseJoint(pose, JOINT_SHOULDER_L, -78, 32, 8);
    writePoseJoint(pose, JOINT_ELBOW_L, -108, 0, -22);
    writePoseJoint(pose, JOINT_SHOULDER_R, -78, -32, -8);
    writePoseJoint(pose, JOINT_ELBOW_R, -108, 0, 22);
    writePoseJoint(pose, JOINT_HIP_L, crouching ? -65 : -24, 0, 8);
    writePoseJoint(pose, JOINT_KNEE_L, crouching ? 105 : 38, 0, 0);
    writePoseJoint(pose, JOINT_HIP_R, crouching ? -55 : 22, 0, -8);
    writePoseJoint(pose, JOINT_KNEE_R, crouching ? 100 : 34, 0, 0);
  }

  private writeHitstunPose(pose: Pose, f: FighterSim): void {
    resetPoseToBind(pose);
    const snap = clamp(1 - f.stateFrame / 16, 0.25, 1);
    writePoseJoint(pose, JOINT_PELVIS, -12 * snap, 0, 0, 0, -0.05, -0.08 * snap);
    writePoseJoint(pose, JOINT_SPINE, -22 * snap, 8 * snap, 0);
    writePoseJoint(pose, JOINT_HEAD, -26 * snap, 12 * snap, 0);
    writePoseJoint(pose, JOINT_SHOULDER_L, -25, 0, 38 * snap);
    writePoseJoint(pose, JOINT_ELBOW_L, -45, 0, 0);
    writePoseJoint(pose, JOINT_SHOULDER_R, -25, 0, -38 * snap);
    writePoseJoint(pose, JOINT_ELBOW_R, -45, 0, 0);
    writePoseJoint(pose, JOINT_HIP_L, -18, 0, 8);
    writePoseJoint(pose, JOINT_KNEE_L, 32, 0, 0);
    writePoseJoint(pose, JOINT_HIP_R, 18, 0, -8);
    writePoseJoint(pose, JOINT_KNEE_R, 28, 0, 0);
  }

  private writeJugglePose(pose: Pose, f: FighterSim): void {
    resetPoseToBind(pose);
    const arch = clamp(f.vy * 180, -35, 35);
    writePoseJoint(pose, JOINT_PELVIS, -68 + arch * 0.4, f.juggleHits * 14, 0, 0, -0.1, 0);
    writePoseJoint(pose, JOINT_SPINE, -18, 0, 0);
    writePoseJoint(pose, JOINT_HEAD, -22, 0, 0);
    writePoseJoint(pose, JOINT_SHOULDER_L, -45, 0, 48);
    writePoseJoint(pose, JOINT_ELBOW_L, -35, 0, 0);
    writePoseJoint(pose, JOINT_SHOULDER_R, -45, 0, -48);
    writePoseJoint(pose, JOINT_ELBOW_R, -35, 0, 0);
    writePoseJoint(pose, JOINT_HIP_L, -32, 0, 14);
    writePoseJoint(pose, JOINT_KNEE_L, 48, 0, 0);
    writePoseJoint(pose, JOINT_HIP_R, -22, 0, -14);
    writePoseJoint(pose, JOINT_KNEE_R, 42, 0, 0);
  }

  private writeKnockdownPose(pose: Pose, f: FighterSim): void {
    resetPoseToBind(pose);
    const getUpT =
      f.state === 'knockdown' && f.stateFrame > 32
        ? clamp((f.stateFrame - 32) / 14, 0, 1)
        : 0;
    const pitch = lerp(-86, -12, getUpT);
    const dropY = lerp(-0.78, -0.08, getUpT);
    writePoseJoint(pose, JOINT_PELVIS, pitch, 0, 0, 0, dropY, 0);
    writePoseJoint(pose, JOINT_SPINE, lerp(-8, 12, getUpT), 0, 0);
    writePoseJoint(pose, JOINT_SHOULDER_L, -20, 0, 35);
    writePoseJoint(pose, JOINT_ELBOW_L, -35, 0, 0);
    writePoseJoint(pose, JOINT_SHOULDER_R, -20, 0, -35);
    writePoseJoint(pose, JOINT_ELBOW_R, -35, 0, 0);
    writePoseJoint(pose, JOINT_HIP_L, lerp(-12, -25, getUpT), 0, 10);
    writePoseJoint(pose, JOINT_KNEE_L, lerp(20, 40, getUpT), 0, 0);
    writePoseJoint(pose, JOINT_HIP_R, lerp(-8, 15, getUpT), 0, -10);
    writePoseJoint(pose, JOINT_KNEE_R, lerp(16, 35, getUpT), 0, 0);
  }

  private writeAttackPose(pose: Pose, f: FighterSim): number {
    resetPoseToBind(pose);
    const m = f.activeMove!;
    const total = totalMoveFrames(m);
    const hitEnd = m.startup + m.active;

    // Envelope `ext`: 0 -> 1 through startup, holds 1.0 during active frames, 1 -> 0 through recovery
    let ext = 1;
    if (f.stateFrame < m.startup) {
      ext = clamp((f.stateFrame + 1) / Math.max(1, m.startup), 0, 1);
    } else if (f.stateFrame >= hitEnd) {
      const rem = total - f.stateFrame;
      ext = clamp(rem / Math.max(1, m.recovery), 0, 1);
    }
    // Crisp martial arts snap curve
    const snap = ext * ext * (3 - 2 * ext);

    const kind: MoveAnimKind = m.anim;
    switch (kind) {
      case 'jab_l': {
        writePoseJoint(pose, JOINT_PELVIS, 6, 18 * snap, 0, 0, -0.05, 0.08 * snap);
        writePoseJoint(pose, JOINT_CHEST, 8, 26 * snap, 0);
        writePoseJoint(pose, JOINT_SHOULDER_L, -92 * snap, -12 * snap, 6);
        writePoseJoint(pose, JOINT_ELBOW_L, -10 * (1 - snap), 0, 0);
        writePoseJoint(pose, JOINT_SHOULDER_R, -45, -18, -18);
        writePoseJoint(pose, JOINT_ELBOW_R, -95, 0, 10);
        writePoseJoint(pose, JOINT_HIP_L, -24, 0, 8);
        writePoseJoint(pose, JOINT_KNEE_L, 34, 0, 0);
        writePoseJoint(pose, JOINT_HIP_R, 22, 0, -8);
        writePoseJoint(pose, JOINT_KNEE_R, 30, 0, 0);
        break;
      }
      case 'straight_r':
      case 'deathfist':
      case 'demon_paw': {
        const heavy = kind === 'deathfist' || kind === 'demon_paw' ? 1.35 : 1.0;
        writePoseJoint(pose, JOINT_PELVIS, 12 * heavy, -34 * snap, 0, 0, -0.08 * heavy, 0.16 * snap * heavy);
        writePoseJoint(pose, JOINT_SPINE, 14 * snap, -22 * snap, 0);
        writePoseJoint(pose, JOINT_CHEST, 10 * snap, -28 * snap, 0);
        writePoseJoint(pose, JOINT_SHOULDER_R, -96 * snap, 16 * snap, -6);
        writePoseJoint(pose, JOINT_ELBOW_R, -8 * (1 - snap), 0, 0);
        writePoseJoint(pose, JOINT_SHOULDER_L, 18 * snap, 15, 24);
        writePoseJoint(pose, JOINT_ELBOW_L, -75, 0, 0);
        writePoseJoint(pose, JOINT_HIP_L, -34 * snap, 0, 10);
        writePoseJoint(pose, JOINT_KNEE_L, 48 * snap, 0, 0);
        writePoseJoint(pose, JOINT_HIP_R, 32 * snap, 0, -10);
        writePoseJoint(pose, JOINT_KNEE_R, 22, 0, 0);
        break;
      }
      case 'hook_r':
      case 'hammer_fist': {
        writePoseJoint(pose, JOINT_PELVIS, 10, -40 * snap, 0, 0, -0.07, 0.12 * snap);
        writePoseJoint(pose, JOINT_CHEST, 12, -32 * snap, 0);
        writePoseJoint(pose, JOINT_SHOULDER_R, -88 * snap, 36 * snap, -28);
        writePoseJoint(pose, JOINT_ELBOW_R, -62, 0, 25 * snap);
        writePoseJoint(pose, JOINT_SHOULDER_L, -48, 20, 18);
        writePoseJoint(pose, JOINT_ELBOW_L, -90, 0, 0);
        writePoseJoint(pose, JOINT_HIP_L, -26, 0, 9);
        writePoseJoint(pose, JOINT_KNEE_L, 38, 0, 0);
        writePoseJoint(pose, JOINT_HIP_R, 24, 0, -9);
        writePoseJoint(pose, JOINT_KNEE_R, 28, 0, 0);
        break;
      }
      case 'uppercut_r':
      case 'electric_upper': {
        const isElec = kind === 'electric_upper';
        writePoseJoint(pose, JOINT_PELVIS, -8 * snap, -36 * snap, 0, 0, isElec ? 0.04 * snap : -0.04, 0.14 * snap);
        writePoseJoint(pose, JOINT_SPINE, -12 * snap, -20 * snap, 0);
        writePoseJoint(pose, JOINT_SHOULDER_R, -138 * snap, 14 * snap, -8);
        writePoseJoint(pose, JOINT_ELBOW_R, -38, 0, 0);
        writePoseJoint(pose, JOINT_SHOULDER_L, 20 * snap, 12, 26);
        writePoseJoint(pose, JOINT_ELBOW_L, -75, 0, 0);
        writePoseJoint(pose, JOINT_HIP_L, -26, 0, 8);
        writePoseJoint(pose, JOINT_KNEE_L, 34, 0, 0);
        writePoseJoint(pose, JOINT_HIP_R, 26, 0, -8);
        writePoseJoint(pose, JOINT_KNEE_R, 24, 0, 0);
        break;
      }
      case 'front_kick_l':
      case 'knee_strike': {
        const isKnee = kind === 'knee_strike';
        writePoseJoint(pose, JOINT_PELVIS, -14 * snap, -18 * snap, 0, 0, isKnee ? 0.06 * snap : -0.02, 0.08 * snap);
        writePoseJoint(pose, JOINT_SPINE, -10 * snap, 12 * snap, 0);
        writePoseJoint(pose, JOINT_SHOULDER_L, -35, 15, 22);
        writePoseJoint(pose, JOINT_ELBOW_L, -80, 0, 0);
        writePoseJoint(pose, JOINT_SHOULDER_R, -45, -15, -22);
        writePoseJoint(pose, JOINT_ELBOW_R, -85, 0, 0);
        writePoseJoint(pose, JOINT_HIP_L, -108 * snap, 0, 6);
        writePoseJoint(pose, JOINT_KNEE_L, isKnee ? 115 * snap : 12 * (1 - snap), 0, 0);
        writePoseJoint(pose, JOINT_HIP_R, 12 * snap, 0, -6);
        writePoseJoint(pose, JOINT_KNEE_R, 18, 0, 0);
        break;
      }
      case 'roundhouse_r':
      case 'axe_kick': {
        const isAxe = kind === 'axe_kick';
        writePoseJoint(pose, JOINT_PELVIS, -16 * snap, 36 * snap, isAxe ? 0 : 18 * snap, 0, 0, 0.1 * snap);
        writePoseJoint(pose, JOINT_SPINE, -12 * snap, -20 * snap, 0);
        writePoseJoint(pose, JOINT_SHOULDER_L, -48, 16, 24);
        writePoseJoint(pose, JOINT_ELBOW_L, -80, 0, 0);
        writePoseJoint(pose, JOINT_SHOULDER_R, 18 * snap, -14, -28);
        writePoseJoint(pose, JOINT_ELBOW_R, -65, 0, 0);
        writePoseJoint(pose, JOINT_HIP_R, -118 * snap, -16 * snap, isAxe ? -4 : -26 * snap);
        writePoseJoint(pose, JOINT_KNEE_R, 10 * (1 - snap), 0, 0);
        writePoseJoint(pose, JOINT_HIP_L, 14 * snap, 0, 6);
        writePoseJoint(pose, JOINT_KNEE_L, 20, 0, 0);
        break;
      }
      case 'low_sweep':
      case 'hell_sweep': {
        const spinDeg = kind === 'hell_sweep' ? (f.stateFrame / total) * 360 : 42 * snap;
        writePoseJoint(pose, JOINT_PELVIS, 24 * snap, spinDeg, 0, 0, -0.36 * snap, 0.08 * snap);
        writePoseJoint(pose, JOINT_SPINE, 18 * snap, -24 * snap, 0);
        writePoseJoint(pose, JOINT_SHOULDER_L, -40, 12, 28);
        writePoseJoint(pose, JOINT_SHOULDER_R, -35, -12, -28);
        writePoseJoint(pose, JOINT_HIP_L, -72 * snap, 0, 12);
        writePoseJoint(pose, JOINT_KNEE_L, 112 * snap, 0, 0);
        writePoseJoint(pose, JOINT_HIP_R, -68 * snap, -22 * snap, -18 * snap);
        writePoseJoint(pose, JOINT_KNEE_R, 8, 0, 0);
        break;
      }
      case 'hopkick':
      case 'flying_kick': {
        const airLift = Math.sin(clamp(f.stateFrame / total, 0, 1) * Math.PI) * 0.36;
        writePoseJoint(pose, JOINT_PELVIS, -20 * snap, 26 * snap, 14 * snap, 0, airLift, 0.14 * snap);
        writePoseJoint(pose, JOINT_SPINE, -10 * snap, -18 * snap, 0);
        writePoseJoint(pose, JOINT_SHOULDER_L, -55, 16, 26);
        writePoseJoint(pose, JOINT_SHOULDER_R, 20 * snap, -16, -28);
        writePoseJoint(pose, JOINT_HIP_R, -115 * snap, 0, -14 * snap);
        writePoseJoint(pose, JOINT_KNEE_R, 8, 0, 0);
        writePoseJoint(pose, JOINT_HIP_L, -52 * snap, 0, 10);
        writePoseJoint(pose, JOINT_KNEE_L, 88 * snap, 0, 0);
        break;
      }
      case 'somersault':
      case 'spin_back_kick': {
        const flip = kind === 'somersault';
        const prog = clamp(f.stateFrame / total, 0, 1);
        const lift = flip ? Math.sin(prog * Math.PI) * 0.48 : 0.04;
        writePoseJoint(
          pose,
          JOINT_PELVIS,
          flip ? -prog * 360 : -16 * snap,
          flip ? 0 : prog * 360,
          0,
          0,
          lift,
          0.1 * snap,
        );
        writePoseJoint(pose, JOINT_SHOULDER_L, -65, 12, 24);
        writePoseJoint(pose, JOINT_SHOULDER_R, -65, -12, -24);
        writePoseJoint(pose, JOINT_HIP_R, -105 * snap, 0, -10);
        writePoseJoint(pose, JOINT_KNEE_R, 12, 0, 0);
        writePoseJoint(pose, JOINT_HIP_L, -45 * snap, 0, 10);
        writePoseJoint(pose, JOINT_KNEE_L, 65 * snap, 0, 0);
        break;
      }
      case 'katana_slash':
      case 'katana_spin': {
        const spin = kind === 'katana_spin' ? (f.stateFrame / total) * 360 : -38 * snap;
        writePoseJoint(pose, JOINT_PELVIS, 10, spin, 0, 0, -0.06, 0.14 * snap);
        writePoseJoint(pose, JOINT_CHEST, 12 * snap, -30 * snap, 0);
        writePoseJoint(pose, JOINT_SHOULDER_R, -112 * snap, 22 * snap, -18);
        writePoseJoint(pose, JOINT_ELBOW_R, -22 * (1 - snap), 0, 0);
        writePoseJoint(pose, JOINT_WEAPON_R, 38 * snap, 0, 0);
        writePoseJoint(pose, JOINT_SHOULDER_L, -40, 18, 22);
        writePoseJoint(pose, JOINT_HIP_L, -28, 0, 9);
        writePoseJoint(pose, JOINT_KNEE_L, 40, 0, 0);
        writePoseJoint(pose, JOINT_HIP_R, 24, 0, -9);
        writePoseJoint(pose, JOINT_KNEE_R, 28, 0, 0);
        break;
      }
      case 'throw_suplex': {
        writePoseJoint(pose, JOINT_PELVIS, 14 * snap, 0, 0, 0, -0.08 * snap, 0.16 * snap);
        writePoseJoint(pose, JOINT_SHOULDER_L, -88 * snap, -18 * snap, 10);
        writePoseJoint(pose, JOINT_ELBOW_L, -25, 0, 0);
        writePoseJoint(pose, JOINT_SHOULDER_R, -88 * snap, 18 * snap, -10);
        writePoseJoint(pose, JOINT_ELBOW_R, -25, 0, 0);
        writePoseJoint(pose, JOINT_HIP_L, -30 * snap, 0, 10);
        writePoseJoint(pose, JOINT_KNEE_L, 45 * snap, 0, 0);
        writePoseJoint(pose, JOINT_HIP_R, 22 * snap, 0, -10);
        writePoseJoint(pose, JOINT_KNEE_R, 30, 0, 0);
        break;
      }
      case 'rage_art': {
        writePoseJoint(pose, JOINT_PELVIS, 14 * snap, -42 * snap, 0, 0, 0.08 * snap, 0.24 * snap);
        writePoseJoint(pose, JOINT_SPINE, 16 * snap, -24 * snap, 0);
        writePoseJoint(pose, JOINT_CHEST, 12 * snap, -28 * snap, 0);
        writePoseJoint(pose, JOINT_SHOULDER_R, -125 * snap, 22 * snap, -10);
        writePoseJoint(pose, JOINT_ELBOW_R, -10 * (1 - snap), 0, 0);
        writePoseJoint(pose, JOINT_SHOULDER_L, -95 * snap, -18 * snap, 10);
        writePoseJoint(pose, JOINT_ELBOW_L, -25 * (1 - snap), 0, 0);
        writePoseJoint(pose, JOINT_HIP_L, -38 * snap, 0, 10);
        writePoseJoint(pose, JOINT_KNEE_L, 52 * snap, 0, 0);
        writePoseJoint(pose, JOINT_HIP_R, 34 * snap, 0, -10);
        writePoseJoint(pose, JOINT_KNEE_R, 22, 0, 0);
        break;
      }
    }

    void DEG;
    return clamp(snap * 1.15, 0.15, 1);
  }
}
