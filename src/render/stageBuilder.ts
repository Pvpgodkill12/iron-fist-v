import { MeshBuilder, mulberry32, srgbColor, type MeshData, type Vec3 } from '@driftengine/core';
import type { StageDefinition } from '../data/types';
import { hexToLinear, hexToVec3 } from './fighterMesh';

export interface BuiltStageGeometry {
  worldMesh: MeshData;
  filmMesh: MeshData;
}

export function buildStageGeometry(stage: StageDefinition): BuiltStageGeometry {
  const b = new MeshBuilder();
  const hw = stage.halfWidth;
  const hd = stage.halfDepth;
  const rng = mulberry32(stage.id.length * 9973 + 1337);

  // Film mesh lifted 4mm above y=0 for planar mirror reflection on wet/marble stages!
  const film = new MeshBuilder();
  film.addGroundQuad(
    [-hw - 1.2, 0.004, hd + 1.2],
    [hw + 1.2, 0.004, hd + 1.2],
    [hw + 1.2, 0.004, -hd - 1.2],
    [-hw - 1.2, 0.004, -hd - 1.2],
    [0.08, 0.1, 0.14],
  );

  switch (stage.id) {
    case 'moonlit_wilderness': {
      const stone: Vec3 = [0.22, 0.25, 0.32];
      const darkStone: Vec3 = [0.13, 0.15, 0.21];
      const lilyStem: Vec3 = [0.16, 0.32, 0.24];
      const lilyPetal: Vec3 = [0.88, 0.94, 1.0];

      // Main stone combat slab + outer wilderness ground
      b.setRoughness(0.5);
      b.addBox([0, -0.3, 0], [18, 0.3, 16], darkStone, 0, 0.2);
      b.setRoughness(0.32);
      b.addBox([0, -0.04, 0], [hw + 0.5, 0.04, hd + 0.5], stone, 0, 0.55);

      // Arena perimeter stone curbs & ruined corner pillars (marks X wall boundaries!)
      for (const sx of [-1, 1]) {
        b.addBox([sx * (hw + 0.35), 0.38, 0], [0.28, 0.38, hd + 0.6], stone, 0, 0.3);
        b.addCylinder([sx * (hw + 0.45), 1.45, -hd - 0.3], 0.36, 1.45, 'y', stone, 0, 12, 0.3);
        b.addCylinder([sx * (hw + 0.45), 0.95, hd + 0.3], 0.34, 0.95, 'y', stone, 0, 12, 0.3);
      }

      // Iconic Gothic Ruined Abbey Arches in background
      for (let i = -3; i <= 3; i += 1) {
        const px = i * 2.6;
        const pz = -4.6 - Math.abs(i) * 0.35;
        const h = i === 0 ? 4.4 : 3.5 - (Math.abs(i) % 2) * 0.4;
        b.addBox([px - 0.75, h * 0.5, pz], [0.28, h * 0.5, 0.32], stone, 0, 0.25);
        b.addBox([px + 0.75, h * 0.5, pz], [0.28, h * 0.5, 0.32], stone, 0, 0.25);
        b.addOrientedBox([px - 0.38, h + 0.32, pz], [0.48, 0.18, 0.3], [0.7, 0.7, 0], stone, 0, 0.25);
        b.addOrientedBox([px + 0.38, h + 0.32, pz], [0.48, 0.18, 0.3], [-0.7, 0.7, 0], stone, 0, 0.25);
      }

      // Glowing Giant Full Moon in distant night sky!
      b.setEmissiveColor(srgbColor(0.78, 0.88, 1.0));
      b.addSphere([-4.5, 8.8, -14.5], 2.1, [0.92, 0.96, 1.0], 2.2, 18, 12, 0.1);

      // Hundreds of glowing silver-white lilies surrounding the combat ring!
      b.setEmissiveColor(srgbColor(0.65, 0.82, 1.0));
      for (let i = 0; i < 110; i += 1) {
        const lx = (rng() * 2 - 1) * 10.5;
        const lz = -hd - 0.45 - rng() * 5.2;
        const lh = 0.16 + rng() * 0.14;
        b.addBox([lx, lh * 0.5, lz], [0.018, lh * 0.5, 0.018], lilyStem, 0, 0.1);
        b.addSphere([lx, lh + 0.03, lz], 0.048, lilyPetal, 0.95, 6, 4, 0.4);
      }
      // Foreground edge lilies
      for (let i = 0; i < 32; i += 1) {
        const lx = (rng() * 2 - 1) * 8.5;
        const lz = hd + 0.55 + rng() * 0.9;
        b.addSphere([lx, 0.16, lz], 0.044, lilyPetal, 0.85, 6, 4, 0.4);
      }
      b.setEmissiveColor(null);
      break;
    }

    case 'honmaru_dojo': {
      const woodFloor: Vec3 = [0.28, 0.16, 0.09];
      const darkBeam: Vec3 = [0.16, 0.09, 0.06];
      const crimsonPillar: Vec3 = [0.52, 0.11, 0.08];
      const shojiPaper: Vec3 = [0.85, 0.62, 0.42];

      b.setRoughness(0.55);
      b.addBox([0, -0.25, 0], [14, 0.25, 10], darkBeam, 0, 0.2);
      // Planked dojo tatami/timber ring
      for (let i = -6; i <= 6; i += 1) {
        const shade = i % 2 === 0 ? woodFloor : ([0.24, 0.13, 0.08] as Vec3);
        b.addBox([i * 1.0, -0.02, 0], [0.49, 0.025, hd + 0.8], shade, 0, 0.4);
      }

      // Side boundary temple walls & heavy crimson pillars
      for (const sx of [-1, 1]) {
        b.addBox([sx * (hw + 0.35), 1.35, 0], [0.26, 1.35, hd + 1.2], darkBeam, 0, 0.3);
        for (const pz of [-1.8, 0, 1.8]) {
          b.addCylinder([sx * (hw + 0.22), 1.8, pz], 0.18, 1.8, 'y', crimsonPillar, 0, 10, 0.45);
        }
      }

      // Back Hon-Maru burning shoji wall + rafters + glowing braziers!
      b.addBox([0, 2.2, -3.9], [9.5, 2.2, 0.25], darkBeam, 0, 0.25);
      b.addBox([0, 3.9, -3.5], [10.2, 0.22, 0.8], crimsonPillar, 0, 0.35);

      b.setEmissiveColor(srgbColor(1.0, 0.42, 0.08));
      for (let i = -3; i <= 3; i += 1) {
        const px = i * 2.2;
        b.addCylinder([px, 2.1, -3.65], 0.18, 2.1, 'y', crimsonPillar, 0, 10, 0.4);
        if (i !== 0) {
          b.addBox([px - 1.1, 1.6, -3.72], [0.78, 1.2, 0.05], shojiPaper, 0.85, 0.2);
        }
      }
      // Flaming iron braziers around the dojo!
      for (const bx of [-4.8, -2.2, 2.2, 4.8]) {
        b.addCylinder([bx, 0.45, -2.55], 0.32, 0.45, 'y', darkBeam, 0, 10, 0.6);
        b.addSphere([bx, 1.02, -2.55], 0.28, [1.0, 0.55, 0.12], 2.5, 10, 8, 0.8);
      }
      b.setEmissiveColor(null);
      break;
    }

    case 'cathedral_retribution': {
      const obsidian: Vec3 = [0.09, 0.08, 0.13];
      const marbleTrim: Vec3 = [0.42, 0.36, 0.52];
      const goldTrim: Vec3 = [0.82, 0.66, 0.24];

      b.setRoughness(0.18);
      b.addBox([0, -0.3, 0], [16, 0.3, 14], obsidian, 0, 0.85);
      // Gold inlaid octagon/altar borders
      b.addBox([0, -0.015, -hd - 0.18], [hw + 0.4, 0.025, 0.12], goldTrim, 0.1, 0.9);
      b.addBox([0, -0.015, hd + 0.18], [hw + 0.4, 0.025, 0.12], goldTrim, 0.1, 0.9);

      // Boundary obsidian pillars & glowing violet obelisks
      b.setEmissiveColor(hexToLinear(stage.accentHex));
      for (const sx of [-1, 1]) {
        b.addBox([sx * (hw + 0.35), 0.55, 0], [0.28, 0.55, hd + 0.5], obsidian, 0, 0.7);
        b.addBox([sx * (hw + 0.35), 2.4, -hd - 0.4], [0.42, 2.4, 0.42], obsidian, 0, 0.7);
        b.addSphere([sx * (hw + 0.35), 1.25, 0], 0.22, [0.75, 0.45, 1.0], 2.2, 10, 8, 0.9);
      }

      // Towering Cathedral back nave & Glowing Stained-Glass Rose Window!
      b.addBox([0, 4.2, -5.8], [11.5, 4.2, 0.4], obsidian, 0, 0.5);
      for (let i = -4; i <= 4; i += 2) {
        b.addBox([i * 2.1, 4.2, -5.35], [0.35, 4.2, 0.45], marbleTrim, 0, 0.45);
        if (i !== 0) {
          b.addBox([i * 2.1, 2.8, -5.55], [0.48, 1.85, 0.08], [0.68, 0.32, 0.96], 1.7, 0.8);
        }
      }
      // Center giant stained-glass rose window!
      b.addCylinder([0, 4.6, -5.5], 1.85, 0.1, 'z', [0.85, 0.4, 1.0], 2.4, 20, 0.9);
      b.addCylinder([0, 4.6, -5.42], 0.95, 0.1, 'z', goldTrim, 1.8, 16, 0.95);
      b.setEmissiveColor(null);
      break;
    }

    case 'dragons_nest': {
      const cliffStone: Vec3 = [0.34, 0.3, 0.28];
      const toriiRed: Vec3 = [0.76, 0.16, 0.12];
      const darkRoof: Vec3 = [0.14, 0.13, 0.15];
      const goldLantern: Vec3 = [1.0, 0.78, 0.32];

      b.setRoughness(0.68);
      b.addBox([0, -0.4, 0], [13.5, 0.4, 9.5], cliffStone, 0, 0.2);

      // Wooden shrine boundary railings & lantern posts
      b.setEmissiveColor(srgbColor(1.0, 0.72, 0.28));
      for (const sx of [-1, 1]) {
        b.addBox([sx * (hw + 0.3), 0.48, 0], [0.16, 0.48, hd + 0.5], toriiRed, 0, 0.4);
        for (const pz of [-hd, 0, hd]) {
          b.addCylinder([sx * (hw + 0.3), 0.85, pz], 0.16, 0.85, 'y', toriiRed, 0, 10, 0.4);
          b.addBox([sx * (hw + 0.3), 1.82, pz], [0.22, 0.22, 0.22], goldLantern, 1.9, 0.6);
        }
      }

      // Giant Vermilion Torii Gate framing the sunset mountain peaks!
      b.setEmissiveColor(null);
      b.addCylinder([-2.6, 2.6, -4.5], 0.28, 2.6, 'y', toriiRed, 0, 12, 0.45);
      b.addCylinder([2.6, 2.6, -4.5], 0.28, 2.6, 'y', toriiRed, 0, 12, 0.45);
      b.addBox([0, 4.35, -4.5], [3.6, 0.22, 0.3], toriiRed, 0, 0.45);
      b.addBox([0, 5.15, -4.5], [4.15, 0.26, 0.42], darkRoof, 0, 0.5);

      // Distant mountain peaks in mist
      for (const [mx, mh, mz] of [
        [-8.5, 5.5, -13],
        [-2.5, 7.2, -15],
        [4.5, 6.4, -14],
        [9.5, 5.0, -12.5],
      ]) {
        b.addBox([mx, mh * 0.4, mz], [2.8, mh * 0.6, 2.2], [0.24, 0.18, 0.2], 0, 0.1);
      }
      break;
    }

    case 'neotokyo_helipad': {
      const asphalt: Vec3 = [0.11, 0.13, 0.17];
      const steel: Vec3 = [0.26, 0.3, 0.36];
      const neonCyan: Vec3 = [0.15, 0.88, 0.98];
      const neonRed: Vec3 = [0.98, 0.22, 0.32];

      b.setRoughness(0.24);
      b.addBox([0, -0.35, 0], [hw + 1.4, 0.35, hd + 1.8], asphalt, 0, 0.75);

      // Glowing Helipad Circle & "H" / Mishima Zaibatsu Ring!
      b.setEmissiveColor(srgbColor(0.15, 0.85, 1.0));
      for (let a = 0; a < 16; a += 1) {
        const rad = (a / 16) * Math.PI * 2;
        const rx = Math.cos(rad) * 2.25;
        const rz = Math.sin(rad) * 1.35;
        b.addBox([rx, 0.008, rz], [0.24, 0.008, 0.08], neonCyan, 1.6, 0.9);
      }
      b.addBox([-0.65, 0.009, 0], [0.09, 0.008, 0.65], neonCyan, 1.5, 0.9);
      b.addBox([0.65, 0.009, 0], [0.09, 0.008, 0.65], neonCyan, 1.5, 0.9);
      b.addBox([0, 0.009, 0], [0.65, 0.008, 0.09], neonCyan, 1.5, 0.9);

      // Steel perimeter barriers & aviation warning beacons!
      b.setEmissiveColor(srgbColor(1.0, 0.22, 0.3));
      for (const sx of [-1, 1]) {
        b.addBox([sx * (hw + 0.28), 0.46, 0], [0.15, 0.46, hd + 0.6], steel, 0, 0.8);
        b.addSphere([sx * (hw + 0.28), 1.02, -hd], 0.14, neonRed, 2.4, 8, 6, 0.9);
        b.addSphere([sx * (hw + 0.28), 1.02, hd], 0.14, neonRed, 2.4, 8, 6, 0.9);
      }

      // Distant Cyberpunk Neo-Tokyo Skyscraper Skyline!
      for (let i = -5; i <= 5; i += 1) {
        const bx = i * 2.7;
        const bz = -6.8 - (Math.abs(i) % 3) * 1.8;
        const bh = 4.2 + ((i * 7 + 13) % 5) * 1.35;
        b.setEmissiveColor(null);
        b.addBox([bx, bh * 0.5 - 2.0, bz], [0.95, bh * 0.5, 0.95], [0.07, 0.09, 0.14], 0, 0.6);
        b.setEmissiveColor(i % 2 === 0 ? srgbColor(0.15, 0.85, 1.0) : srgbColor(0.98, 0.22, 0.55));
        b.addBox([bx, bh - 2.4, bz + 0.96], [0.65, 0.32, 0.04], i % 2 === 0 ? neonCyan : neonRed, 2.0, 0.9);
      }
      b.setEmissiveColor(null);
      break;
    }
  }

  void hexToVec3;
  return {
    worldMesh: b.build({ colorSpace: 'srgb' }),
    filmMesh: film.build({ colorSpace: 'srgb' }),
  };
}
