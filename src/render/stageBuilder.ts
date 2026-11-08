import {
  MeshBuilder,
  buildTree,
  mulberry32,
  srgbColor,
  type MeshData,
  type Vec3,
} from '@driftengine/core';
import type { StageDefinition } from '../data/types';
import { hexToLinear } from './fighterMesh';

export interface BuiltStageGeometry {
  /** Single unified combat floor slab (top strictly at y = 0.000 — zero coplanar overlap). */
  floorMesh: MeshData;
  /** Surrounding 3D architecture, cliffs, pillars, arches, trees & recessed vista (strictly outside ring or y <= -0.28 / y >= +0.02). */
  archMesh: MeshData;
}

/** Build a smooth pointed Gothic arch tube from (x0, yBase, z) to (x1, yBase, z) peaking at yApex. */
function addGothicArchTube(
  b: MeshBuilder,
  x0: number,
  x1: number,
  yBase: number,
  yApex: number,
  z: number,
  radiusBase: number,
  color: Vec3,
): void {
  const midX = (x0 + x1) * 0.5;
  const steps = 8;
  for (const side of [-1, 1] as const) {
    const startX = side < 0 ? x0 : x1;
    const pts: number[] = [];
    const radii: number[] = [];
    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps;
      const easeX = 1 - Math.pow(1 - t, 1.55);
      const easeY = Math.sin(t * Math.PI * 0.5);
      pts.push(startX + (midX - startX) * easeX, yBase + (yApex - yBase) * easeY, z);
      radii.push(radiusBase * (1 - t * 0.24));
    }
    b.addTube(pts, radii, color, 0, 8);
  }
}

/** Build an East-Asian upward-curved temple eave beam along X. */
function addCurvedPagodaEave(
  b: MeshBuilder,
  cx: number,
  halfSpanX: number,
  yCenter: number,
  upturnY: number,
  z: number,
  radius: number,
  color: Vec3,
): void {
  const pts: number[] = [];
  const radii: number[] = [];
  const segs = 12;
  for (let i = 0; i <= segs; i += 1) {
    const u = (i / segs) * 2 - 1; // -1 .. +1
    const x = cx + u * halfSpanX;
    const y = yCenter + Math.pow(Math.abs(u), 2.4) * upturnY;
    pts.push(x, y, z);
    radii.push(radius * (1 - Math.abs(u) * 0.22));
  }
  b.addTube(pts, radii, color, 0, 8);
}

/** Add an organic sculpted rock boulder using DriftEngine's parametric `addBlob`. */
function addSculptedBoulder(
  b: MeshBuilder,
  center: Vec3,
  baseRadius: number,
  seed: number,
  baseColor: Vec3,
  mossColor: Vec3,
): void {
  const phaseA = (seed % 17) * 0.37;
  const phaseB = (seed % 23) * 0.51;
  b.addBlob(
    center,
    (u, v) => {
      const theta = u * Math.PI * 2;
      const phi = v * Math.PI;
      const crag =
        Math.sin(theta * 3 + phaseA) * 0.14 +
        Math.cos(phi * 4 + phaseB) * 0.11 +
        Math.sin((theta + phi) * 5) * 0.06;
      // Flatten bottom slightly so boulders sit naturally in terrain
      const flatBottom = v > 0.72 ? 1 - (v - 0.72) * 0.55 : 1;
      return baseRadius * (0.88 + crag) * flatBottom;
    },
    (_u, v) => {
      const topMix = v < 0.38 ? (0.38 - v) * 1.4 : 0;
      return [
        baseColor[0] * (1 - topMix) + mossColor[0] * topMix,
        baseColor[1] * (1 - topMix) + mossColor[1] * topMix,
        baseColor[2] * (1 - topMix) + mossColor[2] * topMix,
      ];
    },
    0,
    14,
    10,
    0.18,
  );
}

export function buildStageGeometry(stage: StageDefinition): BuiltStageGeometry {
  const floor = new MeshBuilder();
  const arch = new MeshBuilder();
  const hw = stage.halfWidth;
  const hd = stage.halfDepth;
  const rng = mulberry32(stage.id.length * 9973 + 1337);

  switch (stage.id) {
    case 'moonlit_wilderness': {
      const flagstone: Vec3 = [0.27, 0.31, 0.39];
      const bevelTrim: Vec3 = [0.36, 0.4, 0.5];
      const meadowSoil: Vec3 = [0.1, 0.13, 0.18];
      const ruinStone: Vec3 = [0.24, 0.27, 0.35];
      const moss: Vec3 = [0.16, 0.26, 0.24];
      const lilyPetal: Vec3 = [0.9, 0.95, 1.0];

      // 1. Unified elevated stone combat sanctuary (top face strictly at y = 0.000)
      floor.setRoughness(0.32).setGrain(0.65).setRelief(0.42);
      floor.addBox([0, -0.22, 0], [hw + 0.38, 0.22, hd + 0.38], flagstone, 0, 0.55);

      // Stepped outer stone plinth (strictly BELOW y = 0, top at y = -0.14)
      arch.setRoughness(0.55).setGrain(0.7).setRelief(0.5);
      arch.addBox([0, -0.34, 0], [hw + 0.95, 0.2, hd + 0.95], bevelTrim, 0, 0.3);
      // Recessed moonlit meadow (top at y = -0.36 — NEVER coplanar with y = 0!)
      arch.setRoughness(0.85).setGrain(0.35).setRelief(0.3);
      arch.addBox([0, -0.66, 0], [24, 0.3, 22], meadowSoil, 0, 0.08);

      // Perimeter carved stone balustrades & corner weathered columns (outside combat ring)
      arch.setRoughness(0.48).setGrain(0.75).setRelief(0.55);
      for (const sx of [-1, 1] as const) {
        const wallX = sx * (hw + 0.52);
        arch.addBox([wallX, 0.36, 0], [0.22, 0.36, hd + 0.42], ruinStone, 0, 0.3);
        arch.addBox([wallX, 0.76, 0], [0.28, 0.06, hd + 0.48], bevelTrim, 0, 0.35);
        // Fluted corner ruin columns + broken capitals
        arch.addCylinder([wallX, 1.65, -hd - 0.36], 0.34, 1.65, 'y', ruinStone, 0, 14, 0.3);
        arch.addBox([wallX, 3.38, -hd - 0.36], [0.46, 0.14, 0.46], bevelTrim, 0, 0.35);
        arch.addCylinder([wallX, 1.05, hd + 0.36], 0.32, 1.05, 'y', ruinStone, 0, 14, 0.3);
      }

      // Towering Curved Gothic Abbey Arcade in background!
      for (let i = -3; i <= 3; i += 1) {
        const px = i * 2.75;
        const pz = -5.2 - Math.abs(i) * 0.42;
        const colH = i === 0 ? 4.2 : 3.4 - (Math.abs(i) % 2) * 0.35;
        arch.addCylinder([px - 0.88, colH * 0.5 - 0.3, pz], 0.26, colH * 0.5 + 0.15, 'y', ruinStone, 0, 12, 0.28);
        arch.addCylinder([px + 0.88, colH * 0.5 - 0.3, pz], 0.26, colH * 0.5 + 0.15, 'y', ruinStone, 0, 12, 0.28);
        addGothicArchTube(arch, px - 0.88, px + 0.88, colH - 0.2, colH + 1.15, pz, 0.22, bevelTrim);
      }

      // Sculpted moonlit boulders & gnarled ancient trees flanking the abbey
      for (const [bx, bz, br, s] of [
        [-8.8, -6.5, 1.45, 11],
        [9.2, -6.2, 1.6, 29],
        [-10.5, -2.2, 1.2, 43],
        [10.4, -1.8, 1.3, 61],
      ] as const) {
        addSculptedBoulder(arch, [bx, -0.15, bz], br, s, ruinStone, moss);
      }
      for (const [tx, tz] of [
        [-7.6, -7.2],
        [7.8, -7.4],
      ] as const) {
        const tree = buildTree(
          {
            height: 4.8,
            trunkRadius: 0.28,
            taper: 0.65,
            canopyRadius: 1.85,
            canopyClusters: 9,
            trunkColor: [0.16, 0.15, 0.2],
            canopyColor: [0.22, 0.28, 0.38],
          },
          rng,
        );
        arch.addMesh(tree.solid, tx, -0.36, tz, 1);
        arch.addMesh(tree.flexible, tx, -0.36, tz, 1);
      }

      // Luminous Full Moon high in the night sky
      arch.setEmissiveColor(srgbColor(0.82, 0.9, 1.0));
      arch.addSphere([-4.8, 9.6, -18.5], 2.35, [0.94, 0.97, 1.0], 2.2, 20, 14, 0.1);

      // Field of glowing white lilies planted cleanly on the recessed meadow (y = -0.36)
      arch.setEmissiveColor(srgbColor(0.7, 0.86, 1.0));
      for (let i = 0; i < 120; i += 1) {
        const angle = rng() * Math.PI * 2;
        const distX = hw + 1.35 + rng() * 6.5;
        const distZ = hd + 1.2 + rng() * 5.8;
        const lx = Math.cos(angle) * distX;
        const lz = Math.sin(angle) * distZ - 1.2;
        if (lz > hd + 1.8) continue;
        const stemH = 0.22 + rng() * 0.14;
        arch.addSphere([lx, -0.36 + stemH, lz], 0.052, lilyPetal, 0.95, 6, 5, 0.35);
      }
      arch.setEmissiveColor(null);
      break;
    }

    case 'honmaru_dojo': {
      const cedarFloor: Vec3 = [0.34, 0.2, 0.11];
      const darkTimber: Vec3 = [0.15, 0.09, 0.06];
      const lacquerRed: Vec3 = [0.58, 0.11, 0.09];
      const shojiWarm: Vec3 = [0.92, 0.68, 0.42];
      const roofTile: Vec3 = [0.13, 0.13, 0.16];

      // 1. Single unified Japanese cedar combat floor (top strictly at y = 0.000 — plank lines come from SurfaceTexture!)
      floor.setRoughness(0.38).setGrain(0.55).setRelief(0.28);
      floor.addBox([0, -0.22, 0], [hw + 0.36, 0.22, hd + 0.45], cedarFloor, 0, 0.48);

      // Stepped outer veranda & gravel courtyard (strictly below y = 0)
      arch.setRoughness(0.6).setGrain(0.45).setRelief(0.35);
      arch.addBox([0, -0.32, 0], [hw + 1.25, 0.18, hd + 1.35], darkTimber, 0, 0.25);
      arch.addBox([0, -0.62, 0], [20, 0.28, 16], [0.14, 0.12, 0.11], 0, 0.1);

      // Side temple walls, heavy vermilion pillars & timber tie-beams
      for (const sx of [-1, 1] as const) {
        const wx = sx * (hw + 0.56);
        arch.addBox([wx, 1.55, 0], [0.18, 1.55, hd + 1.1], darkTimber, 0, 0.28);
        arch.addBox([wx, 3.18, 0], [0.28, 0.14, hd + 1.25], lacquerRed, 0, 0.4);
        for (const pz of [-2.2, 0, 2.2]) {
          arch.addCylinder([sx * (hw + 0.38), 1.65, pz], 0.19, 1.65, 'y', lacquerRed, 0, 12, 0.45);
        }
      }

      // Grand Back Hon-Maru Sanctuary Wall + Two-Tier Curved Temple Roof!
      arch.addBox([0, 2.15, -4.35], [hw + 1.8, 2.15, 0.22], darkTimber, 0, 0.25);
      addCurvedPagodaEave(arch, 0, hw + 2.4, 3.85, 0.55, -4.05, 0.24, roofTile);
      addCurvedPagodaEave(arch, 0, hw + 1.5, 5.05, 0.48, -4.25, 0.2, roofTile);

      // Glowing shoji lattice screens & flaming iron braziers
      arch.setEmissiveColor(srgbColor(1.0, 0.48, 0.12));
      for (let i = -3; i <= 3; i += 1) {
        const px = i * 2.15;
        arch.addCylinder([px, 2.0, -4.1], 0.17, 2.0, 'y', lacquerRed, 0, 12, 0.42);
        if (i !== 0) {
          const sx = px > 0 ? px - 1.07 : px + 1.07;
          if (Math.abs(i) <= 2) {
            arch.addBox([sx, 1.65, -4.18], [0.78, 1.18, 0.04], shojiWarm, 0.85, 0.2);
          }
        }
      }
      for (const bx of [-4.6, -2.1, 2.1, 4.6]) {
        arch.setEmissiveColor(null);
        arch.addCylinder([bx, 0.42, -3.25], 0.3, 0.42, 'y', darkTimber, 0, 12, 0.55);
        arch.setEmissiveColor(srgbColor(1.0, 0.46, 0.1));
        arch.addSphere([bx, 0.96, -3.25], 0.25, [1.0, 0.58, 0.14], 2.4, 12, 8, 0.8);
      }
      arch.setEmissiveColor(null);
      break;
    }

    case 'cathedral_retribution': {
      const obsidian: Vec3 = [0.11, 0.1, 0.15];
      const gothicStone: Vec3 = [0.26, 0.23, 0.33];
      const antiqueGold: Vec3 = [0.82, 0.65, 0.24];

      // 1. Single unified polished dark marble sanctuary floor (top strictly at y = 0.000)
      floor.setRoughness(0.18).setGrain(0.75).setRelief(0.18);
      floor.addBox([0, -0.25, 0], [hw + 0.42, 0.25, hd + 0.42], obsidian, 0, 0.85);

      // Raised perimeter altar curbs (strictly outside ring, top at y = +0.26) & deep chasm below (y = -0.65)
      arch.setRoughness(0.32).setGrain(0.6).setRelief(0.35);
      arch.addBox([0, -0.45, 0], [hw + 1.15, 0.28, hd + 1.15], gothicStone, 0, 0.5);
      arch.addBox([0, -0.95, 0], [22, 0.3, 20], [0.05, 0.04, 0.08], 0, 0.2);

      // Gold-trimmed side nave walls & soaring gothic vaulted ribs!
      for (const sx of [-1, 1] as const) {
        const wx = sx * (hw + 0.58);
        arch.addBox([wx, 0.52, 0], [0.24, 0.52, hd + 0.55], obsidian, 0, 0.72);
        arch.addBox([wx, 1.08, 0], [0.28, 0.05, hd + 0.58], antiqueGold, 0, 0.92);
        for (const pz of [-2.8, 0, 2.8]) {
          arch.addCylinder([sx * (hw + 0.72), 2.8, pz], 0.32, 2.8, 'y', gothicStone, 0, 12, 0.5);
        }
      }

      // Grand Cathedral Choir Apse, Pipe Organ Towers & Curved Ribbed Vaults
      arch.addBox([0, 4.6, -6.2], [11.8, 4.6, 0.38], obsidian, 0, 0.48);
      for (let i = -2; i <= 2; i += 1) {
        addGothicArchTube(arch, -6.2, 6.2, 2.4, 6.8, -5.6 + i * 1.4, 0.16, gothicStone);
      }

      // Crimson & Violet Stained-Glass Rose Window + Lancet Windows
      arch.setEmissiveColor(hexToLinear(stage.accentHex));
      for (const lx of [-4.6, -2.6, 2.6, 4.6]) {
        arch.addBox([lx, 3.0, -5.92], [0.48, 1.95, 0.06], [0.78, 0.24, 0.52], 1.85, 0.85);
      }
      arch.addCylinder([0, 4.75, -5.88], 1.9, 0.08, 'z', [0.88, 0.28, 0.48], 2.2, 24, 0.9);
      arch.addCylinder([0, 4.75, -5.8], 0.95, 0.09, 'z', antiqueGold, 1.6, 18, 0.95);
      arch.setEmissiveColor(null);
      break;
    }

    case 'dragons_nest': {
      const mountainSlate: Vec3 = [0.35, 0.31, 0.29];
      const darkRock: Vec3 = [0.21, 0.18, 0.18];
      const vermilion: Vec3 = [0.76, 0.14, 0.11];
      const moss: Vec3 = [0.22, 0.3, 0.19];

      // 1. Unified mountain shrine stone terrace (top strictly at y = 0.000)
      floor.setRoughness(0.58).setGrain(0.82).setRelief(0.58);
      floor.addBox([0, -0.35, 0], [hw + 0.38, 0.35, hd + 0.42], mountainSlate, 0, 0.28);

      // Jagged cliff foundation & misty abyss below (top strictly <= -0.32)
      arch.setRoughness(0.75).setGrain(0.8).setRelief(0.65);
      arch.addBox([0, -0.78, 0], [hw + 1.5, 0.46, hd + 1.5], darkRock, 0, 0.18);

      // Sculpted craggy cliff boulders surrounding the summit terrace
      for (const [bx, by, bz, br, s] of [
        [-7.6, -0.4, -3.5, 1.8, 7],
        [7.8, -0.35, -3.2, 1.95, 19],
        [-9.5, 1.8, -11.5, 3.8, 31],
        [0.4, 2.6, -14.2, 4.6, 47],
        [9.8, 2.0, -12.0, 4.0, 59],
      ] as const) {
        addSculptedBoulder(arch, [bx, by, bz], br, s, darkRock, moss);
      }

      // Vermilion Shrine Balustrades & Glowing Stone Lanterns
      arch.setEmissiveColor(srgbColor(1.0, 0.68, 0.25));
      for (const sx of [-1, 1] as const) {
        const rx = sx * (hw + 0.45);
        arch.addBox([rx, 0.46, 0], [0.14, 0.46, hd + 0.45], vermilion, 0, 0.42);
        for (const pz of [-hd, 0, hd]) {
          arch.addCylinder([rx, 0.88, pz], 0.16, 0.88, 'y', vermilion, 0, 12, 0.45);
          arch.addBox([rx, 1.88, pz], [0.22, 0.22, 0.22], [1.0, 0.78, 0.34], 1.9, 0.65);
          arch.addBox([rx, 2.18, pz], [0.32, 0.08, 0.32], darkRock, 0, 0.3);
        }
      }
      arch.setEmissiveColor(null);

      // Iconic Curved Vermilion Torii Gate + Gnarled Summit Pines!
      arch.addCylinder([-2.65, 2.65, -4.8], 0.28, 2.65, 'y', vermilion, 0, 14, 0.45);
      arch.addCylinder([2.65, 2.65, -4.8], 0.28, 2.65, 'y', vermilion, 0, 14, 0.45);
      arch.addBox([0, 4.35, -4.8], [3.45, 0.2, 0.26], vermilion, 0, 0.45);
      addCurvedPagodaEave(arch, 0, 4.25, 5.15, 0.46, -4.8, 0.26, [0.14, 0.13, 0.16]);

      for (const [tx, tz] of [
        [-5.8, -5.2],
        [5.9, -5.0],
      ] as const) {
        const pine = buildTree(
          {
            height: 3.9,
            trunkRadius: 0.24,
            taper: 0.6,
            canopyRadius: 1.65,
            canopyClusters: 8,
            trunkColor: [0.24, 0.16, 0.12],
            canopyColor: [0.16, 0.32, 0.2],
          },
          rng,
        );
        arch.addMesh(pine.solid, tx, -0.35, tz, 1);
        arch.addMesh(pine.flexible, tx, -0.35, tz, 1);
      }
      break;
    }

    case 'neotokyo_helipad': {
      const concrete: Vec3 = [0.15, 0.17, 0.21];
      const darkSteel: Vec3 = [0.24, 0.27, 0.33];
      const crimsonBeacon: Vec3 = [0.96, 0.16, 0.24];
      const amberStripe: Vec3 = [0.92, 0.68, 0.16];

      // 1. Unified rooftop helipad deck (top strictly at y = 0.000)
      floor.setRoughness(0.34).setGrain(0.55).setRelief(0.48);
      floor.addBox([0, -0.28, 0], [hw + 0.55, 0.28, hd + 0.65], concrete, 0, 0.65);

      // Structural steel sub-deck & truss superstructure below y = -0.28
      arch.setRoughness(0.36).setGrain(0.3).setRelief(0.25);
      arch.addBox([0, -0.78, 0], [hw + 1.35, 0.22, hd + 1.45], darkSteel, 0, 0.78);
      arch.addBox([0, -3.2, 0], [hw + 0.85, 2.2, hd + 0.95], [0.09, 0.1, 0.13], 0, 0.55);

      // Heavy steel perimeter safety barriers, hazard curbs & crimson aviation beacons
      arch.setEmissiveColor(srgbColor(1.0, 0.16, 0.24));
      for (const sx of [-1, 1] as const) {
        const bx = sx * (hw + 0.42);
        arch.addBox([bx, 0.46, 0], [0.16, 0.46, hd + 0.55], darkSteel, 0, 0.82);
        arch.addBox([bx, 0.96, 0], [0.2, 0.05, hd + 0.58], amberStripe, 0, 0.75);
        for (const bz of [-hd - 0.35, hd + 0.35]) {
          arch.addCylinder([bx, 0.72, bz], 0.18, 0.72, 'y', darkSteel, 0, 12, 0.8);
          arch.addSphere([bx, 1.54, bz], 0.15, crimsonBeacon, 2.4, 10, 8, 0.9);
        }
      }

      // Rooftop comms tower & Neo-Tokyo skyscraper skyline
      arch.setEmissiveColor(null);
      arch.addCylinder([5.4, 2.8, -5.2], 0.22, 2.8, 'y', darkSteel, 0, 12, 0.8);
      arch.addTube([5.4, 5.6, -5.2, 5.4, 7.6, -5.2], [0.12, 0.03], darkSteel, 0, 8);
      arch.setEmissiveColor(srgbColor(1.0, 0.16, 0.24));
      arch.addSphere([5.4, 7.7, -5.2], 0.14, crimsonBeacon, 2.6, 8, 6, 0.9);

      for (let i = -5; i <= 5; i += 1) {
        const sx = i * 2.85;
        const sz = -7.8 - (Math.abs(i) % 3) * 2.1;
        const sh = 5.0 + ((i * 7 + 13) % 5) * 1.55;
        arch.setEmissiveColor(null);
        arch.addBox([sx, sh * 0.5 - 3.2, sz], [1.05, sh * 0.5, 1.05], [0.08, 0.09, 0.13], 0, 0.62);
        arch.setEmissiveColor(i % 2 === 0 ? srgbColor(0.96, 0.16, 0.24) : srgbColor(0.95, 0.72, 0.24));
        arch.addBox(
          [sx, sh - 3.65, sz + 1.06],
          [0.72, 0.26, 0.04],
          i % 2 === 0 ? crimsonBeacon : amberStripe,
          2.0,
          0.9,
        );
      }
      arch.setEmissiveColor(null);
      break;
    }
  }

  return {
    floorMesh: floor.build({ planarUvs: true, colorSpace: 'srgb' }),
    archMesh: arch.build({ planarUvs: true, colorSpace: 'srgb' }),
  };
}
