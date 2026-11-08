/**
 * IRON FIST V — CC0 3D Environment Arena Baker
 *
 * Replaces the 4 non-Dragon's-Nest arenas using genuine CC0 3D environment models
 * (Quaternius / KayKit / Kenney CC0 1.0 Public Domain `.glb` meshes), while keeping
 * `public/models/stages/dragons_nest.glb` 100% untouched!
 */
import fs from 'node:fs';
import path from 'node:path';
import { MeshBuilder, srgbColor } from '@driftengine/core';
import { readGlb, gltfToMeshes, drftToGlb, simplifyMesh, weldMesh } from '@driftengine/assets';
import { writeDrft, readDrft } from '@driftengine/drft';

const ENV_DIR = '/tmp/cc0_phase3b/env';
const OUT_DIR = path.resolve('public/models/stages');
fs.mkdirSync(OUT_DIR, { recursive: true });

if (!fs.existsSync(ENV_DIR)) {
  console.log('Pre-baked CC0 3D stage GLBs already present in public/models/stages/ (dragons_nest.glb preserved).');
  process.exit(0);
}

function loadEnvGlb(fileName, maxError = 0) {
  const buf = fs.readFileSync(path.join(ENV_DIR, fileName));
  const parsed = readGlb(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  let meshes = gltfToMeshes(parsed.json, parsed.binary ? [parsed.binary] : []).meshes;
  if (maxError > 0) {
    meshes = meshes.map((m) => simplifyMesh(weldMesh(m), { maxError, maxUvError: 100.0, minRatio: 0.16 }));
  } else {
    meshes = meshes.map((m) => weldMesh(m));
  }
  return meshes;
}

/**
 * Stamp a list of CC0 MeshData primitives into an arena accumulator with Y-axis rotation,
 * scale, translation, optional per-primitive linear RGB tint override, and optional emissive boost.
 */
function stampModel(acc, meshes, { x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, rotY = 0, primTints = null, primEmissive = null }) {
  const cosY = Math.cos(rotY);
  const sinY = Math.sin(rotY);

  meshes.forEach((m, pIdx) => {
    const baseOffset = acc.positions.length / 3;
    const vCount = m.positions.length / 3;
    const tint = primTints && primTints[pIdx] ? primTints[pIdx] : null;
    const em = primEmissive && primEmissive[pIdx] !== undefined ? primEmissive[pIdx] : null;

    for (let v = 0; v < vCount; v++) {
      const lx = m.positions[v * 3] * sx;
      const ly = m.positions[v * 3 + 1] * sy;
      const lz = m.positions[v * 3 + 2] * sz;

      const rx = lx * cosY + lz * sinY + x;
      const ry = ly + y;
      const rz = -lx * sinY + lz * cosY + z;
      acc.positions.push(rx, ry, rz);

      const nx = m.normals[v * 3];
      const ny = m.normals[v * 3 + 1];
      const nz = m.normals[v * 3 + 2];
      acc.normals.push(nx * cosY + nz * sinY, ny, -nx * sinY + nz * cosY);

      acc.uvs.push(m.uvs ? m.uvs[v * 2] : rx * 0.25, m.uvs ? m.uvs[v * 2 + 1] : rz * 0.25);

      if (tint) {
        acc.colors.push(tint[0], tint[1], tint[2]);
      } else {
        acc.colors.push(m.colors[v * 3], m.colors[v * 3 + 1], m.colors[v * 3 + 2]);
      }

      acc.emissive.push(em !== null ? em : m.emissive ? m.emissive[v] : 0);
    }

    for (let i = 0; i < m.indices.length; i++) {
      acc.indices.push(baseOffset + m.indices[i]);
    }
  });
}

function appendMeshData(acc, m) {
  stampModel(acc, [m], {});
}

function createAcc() {
  return { positions: [], normals: [], uvs: [], colors: [], emissive: [], indices: [] };
}

function finalizeAcc(acc) {
  return {
    positions: new Float32Array(acc.positions),
    normals: new Float32Array(acc.normals),
    uvs: new Float32Array(acc.uvs),
    colors: new Float32Array(acc.colors),
    emissive: new Float32Array(acc.emissive),
    indices: new Uint32Array(acc.indices),
    material: {
      baseColor: new Float32Array([1, 1, 1, 1]),
      metallic: 0.14,
      roughness: 0.62,
    },
  };
}

function bakeStage(stageId, floorMesh, archAcc) {
  if (stageId === 'dragons_nest') {
    throw new Error('Refusing to overwrite dragons_nest.glb — user favorite map is protected!');
  }
  const archMesh = finalizeAcc(archAcc);
  const drftBytes = writeDrft({ meshes: [floorMesh, archMesh] });
  const { glb } = drftToGlb(readDrft(drftBytes));

  const parsed = readGlb(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength));
  const verified = gltfToMeshes(parsed.json, parsed.binary ? [parsed.binary] : []);
  const outPath = path.join(OUT_DIR, `${stageId}.glb`);
  fs.writeFileSync(outPath, glb);
  const totalVerts = (verified.meshes[0].positions.length + verified.meshes[1].positions.length) / 3;
  console.log(`Baked CC0 3D Arena ${stageId}.glb (${(glb.byteLength / 1024).toFixed(1)} KB, ${totalVerts} vertices)`);
}

console.log('Loading real CC0 3D environment models...');
const archGothic = loadEnvGlb('Arch_Gothic.glb', 0.03);
const archRound = loadEnvGlb('Arch_Gothic_RoundColumn.glb', 0.03);
const gateIron = loadEnvGlb('gate_iron.glb', 0);
const wallStone = loadEnvGlb('wall_stone.glb', 0);
const ruinArch = loadEnvGlb('ruin_arch.glb', 0);
const ruinPillarBroken = loadEnvGlb('ruin_pillar_broken.glb', 0);
const stonePedestal = loadEnvGlb('stone_pedestal.glb', 0);
const ancientPillar = loadEnvGlb('AncientPillar_Glyphs.glb', 0);
const brazier = loadEnvGlb('Brazier.glb', 0.02);
const rockCluster = loadEnvGlb('Rock_Cluster.glb', 0);
const treePine = loadEnvGlb('Tree_Pine.glb', 0);
const house1 = loadEnvGlb('House_1.glb', 0.06);
const fence = loadEnvGlb('Fence.glb', 0);
const wallTorch = loadEnvGlb('WallTorch.glb', 0);
const waypointPedestal = loadEnvGlb('WaypointPedestal.glb', 0);
const shrineStructure = loadEnvGlb('structure_detailed.glb', 0);
const birchTree = loadEnvGlb('Birch_4GLB.glb', 0.14);
const cherryBlossom = loadEnvGlb('CherryBlossom_2.glb', 0.18);
const bushFlowers = loadEnvGlb('Bush_Common_Flowers.glb', 0.06);
const buildingSmall = loadEnvGlb('Building_Small_1.glb', 0.22);
const buildingMed = loadEnvGlb('Building_Medium_2.glb', 0.25);
const geodesicDome = loadEnvGlb('GeodesicDome.glb', 0.05);
const spaceship = loadEnvGlb('Spaceship.glb', 0.04);
const pickupCrate = loadEnvGlb('Pickup_Crate.glb', 0.04);

// ============================================================================
// 1. MOONLIT WILDERNESS -> ANCIENT RUINS SANCTUARY (CC0 Ruins + Birch Forest)
// ============================================================================
{
  const hw = 6.4, hd = 1.85;
  const floorB = new MeshBuilder();
  floorB.setRoughness(0.55).setGrain(0.65).setRelief(0.42);
  floorB.addBox([0, -0.22, 0], [hw + 0.38, 0.22, hd + 0.38], [0.24, 0.28, 0.36], 0, 0.35);
  const floorMesh = floorB.build({ planarUvs: true, colorSpace: 'srgb' });

  const baseB = new MeshBuilder();
  baseB.setRoughness(0.75).setGrain(0.5);
  baseB.addBox([0, -0.35, 0], [hw + 1.05, 0.21, hd + 1.05], [0.16, 0.2, 0.27], 0, 0.25);
  baseB.addBox([0, -0.68, 0], [26, 0.3, 24], [0.06, 0.09, 0.14], 0, 0.08);
  // Full moon high in sky
  baseB.setEmissiveColor(srgbColor(0.82, 0.9, 1.0));
  baseB.addSphere([-5.2, 10.2, -19.5], 2.4, [0.94, 0.97, 1.0], 2.0, 20, 14, 0.1);
  baseB.setEmissiveColor(null);

  const acc = createAcc();
  appendMeshData(acc, baseB.build({ planarUvs: true, colorSpace: 'srgb' }));

  // Semicircle of CC0 Ruin Arches + Glowing Ancient Glyph Pillars behind the arena
  for (let i = -2; i <= 2; i++) {
    const px = i * 3.1;
    const pz = -4.6 - Math.abs(i) * 0.45;
    stampModel(acc, ruinArch, {
      x: px, y: -0.1, z: pz, sx: 1.85, sy: 1.65, sz: 1.65,
      primTints: [[0.22, 0.26, 0.34], [0.30, 0.35, 0.44], [0.16, 0.20, 0.27], [0.26, 0.31, 0.40]],
    });
  }
  for (const [px, pz, ry] of [[-7.2, -2.4, 0.3], [7.2, -2.4, -0.3], [-4.6, -5.6, 0], [4.6, -5.6, 0]]) {
    stampModel(acc, ancientPillar, {
      x: px, y: -0.14, z: pz, sx: 1.05, sy: 1.1, sz: 1.05, rotY: ry,
      primTints: [[0.38, 0.78, 1.0], [0.22, 0.26, 0.35]],
      primEmissive: [1.6, 0],
    });
  }
  // Broken side boundary pillars & flaming iron braziers
  for (const sx of [-1, 1]) {
    const wx = sx * (hw + 0.62);
    stampModel(acc, ruinPillarBroken, { x: wx, y: 0.0, z: -hd - 0.3, sx: 1.2, sy: 1.2, sz: 1.2, rotY: sx * 0.6 });
    stampModel(acc, stonePedestal, { x: wx, y: 0.0, z: 0, sx: 1.1, sy: 0.9, sz: 1.5 });
    stampModel(acc, brazier, {
      x: wx, y: 0.02, z: hd + 0.25, sx: 1.15, sy: 1.15, sz: 1.15,
      primTints: [[0.14, 0.16, 0.22], [0.45, 0.82, 1.0]],
      primEmissive: [0, 1.8],
    });
  }
  // CC0 Moonlit Birch Trees, Pines, Rock Clusters & Glowing Flower Bushes!
  for (const [tx, tz, sc, ry] of [[-9.2, -7.4, 0.58, 0.4], [9.4, -7.2, 0.62, 2.1], [0.2, -9.8, 0.55, 1.1]]) {
    stampModel(acc, birchTree, {
      x: tx, y: -0.38, z: tz, sx: sc, sy: sc, sz: sc, rotY: ry,
      primTints: [[0.58, 0.62, 0.72], [0.14, 0.24, 0.42]],
    });
  }
  for (const [tx, tz] of [[-11.2, -3.8], [11.2, -3.8], [-6.2, -8.5], [6.2, -8.5]]) {
    stampModel(acc, treePine, { x: tx, y: -0.38, z: tz, sx: 1.35, sy: 1.35, sz: 1.35 });
  }
  for (const [rx, rz, ry] of [[-8.6, -4.2, 0.5], [8.8, -4.0, 1.9], [-3.2, -6.2, 1.1], [3.4, -6.2, 2.6]]) {
    stampModel(acc, rockCluster, { x: rx, y: -0.38, z: rz, sx: 1.3, sy: 1.2, sz: 1.3, rotY: ry });
  }
  for (let i = -4; i <= 4; i++) {
    if (i === 0) continue;
    stampModel(acc, bushFlowers, {
      x: i * 2.15, y: -0.38, z: -3.55 - (Math.abs(i) % 2) * 0.65,
      sx: 0.75, sy: 0.75, sz: 0.75, rotY: i * 0.9,
      primTints: [[0.09, 0.20, 0.18], [0.82, 0.94, 1.0]],
      primEmissive: [0, 0.85],
    });
  }
  bakeStage('moonlit_wilderness', floorMesh, acc);
}

// ============================================================================
// 2. HONMARU DOJO -> SAKURA SHRINE COURTYARD (CC0 Cherry Blossoms + Pavilion)
// ============================================================================
{
  const hw = 5.8, hd = 1.65;
  const floorB = new MeshBuilder();
  floorB.setRoughness(0.45).setGrain(0.55).setRelief(0.28);
  floorB.addBox([0, -0.22, 0], [hw + 0.36, 0.22, hd + 0.45], [0.33, 0.19, 0.11], 0, 0.38);
  const floorMesh = floorB.build({ planarUvs: true, colorSpace: 'srgb' });

  const baseB = new MeshBuilder();
  baseB.setRoughness(0.65).setGrain(0.45);
  baseB.addBox([0, -0.33, 0], [hw + 1.25, 0.18, hd + 1.35], [0.16, 0.09, 0.06], 0, 0.25);
  baseB.addBox([0, -0.64, 0], [24, 0.28, 20], [0.13, 0.10, 0.12], 0, 0.1);

  const acc = createAcc();
  appendMeshData(acc, baseB.build({ planarUvs: true, colorSpace: 'srgb' }));

  // Central Timber Dojo Pavilions (CC0 House_1) + Detailed Shrine Lantern Pedestals
  stampModel(acc, house1, { x: 0, y: -0.28, z: -6.1, sx: 2.35, sy: 1.55, sz: 1.65, rotY: 0 });
  stampModel(acc, house1, { x: -7.4, y: -0.32, z: -5.2, sx: 1.45, sy: 1.25, sz: 1.45, rotY: 0.38 });
  stampModel(acc, house1, { x: 7.4, y: -0.32, z: -5.2, sx: 1.45, sy: 1.25, sz: 1.45, rotY: -0.38 });

  // Giant Blooming Pink CC0 Japanese Cherry Blossom Trees overhanging the courtyard!
  for (const [cx, cz, sc, ry] of [
    [-5.8, -3.8, 0.56, 0.35],
    [4.4, -3.9, 0.58, 2.35],
    [-2.4, -8.4, 0.52, 1.15],
  ]) {
    stampModel(acc, cherryBlossom, {
      x: cx, y: -0.34, z: cz, sx: sc, sy: sc, sz: sc, rotY: ry,
      primTints: [[0.18, 0.09, 0.07], [0.95, 0.44, 0.62]],
      primEmissive: [0, 0.28],
    });
  }

  // Courtyard Perimeter Timber Fences, Shrine Lanterns & Warm Amber Braziers
  for (const sx of [-1, 1]) {
    const wx = sx * (hw + 0.52);
    for (const fz of [-1.2, 1.2]) {
      stampModel(acc, fence, { x: wx, y: 0.0, z: fz, sx: 1.15, sy: 1.15, sz: 1.25, rotY: Math.PI * 0.5 });
    }
    stampModel(acc, waypointPedestal, { x: wx - 2.0, y: 0.0, z: -hd - 2.0, sx: 1.0, sy: 1.0, sz: 1.0 });
    stampModel(acc, shrineStructure, { x: wx - 2.0, y: 0.15, z: -hd - 2.0, sx: 1.0, sy: 1.25, sz: 1.0 });
    stampModel(acc, brazier, {
      x: sx * 3.8, y: -0.14, z: -3.25, sx: 1.15, sy: 1.15, sz: 1.15,
      primTints: [[0.14, 0.11, 0.10], [1.0, 0.48, 0.12]],
      primEmissive: [0, 2.1],
    });
  }
  bakeStage('honmaru_dojo', floorMesh, acc);
}

// ============================================================================
// 3. CATHEDRAL RETRIBUTION -> GOTHIC CRYPT CITADEL (CC0 Arch_Gothic + Iron Gates)
// ============================================================================
{
  const hw = 6.6, hd = 1.9;
  const floorB = new MeshBuilder();
  floorB.setRoughness(0.34).setGrain(0.7).setRelief(0.22);
  floorB.addBox([0, -0.25, 0], [hw + 0.42, 0.25, hd + 0.42], [0.13, 0.11, 0.18], 0, 0.52);
  const floorMesh = floorB.build({ planarUvs: true, colorSpace: 'srgb' });

  const baseB = new MeshBuilder();
  baseB.setRoughness(0.5).setGrain(0.6);
  baseB.addBox([0, -0.45, 0], [hw + 1.25, 0.28, hd + 1.25], [0.20, 0.17, 0.27], 0, 0.4);
  baseB.addBox([0, -0.95, 0], [24, 0.3, 22], [0.05, 0.04, 0.08], 0, 0.15);
  // Glowing Violet Cathedral Rose Window in deep apse
  baseB.setEmissiveColor(srgbColor(0.75, 0.38, 0.98));
  baseB.addCylinder([0, 4.85, -6.55], 1.85, 0.08, 'z', [0.82, 0.32, 0.95], 2.0, 24, 0.8);
  baseB.setEmissiveColor(null);

  const acc = createAcc();
  appendMeshData(acc, baseB.build({ planarUvs: true, colorSpace: 'srgb' }));

  // Grand Double-Tier CC0 Gothic Pointed Arch Colonnade along rear sanctuary!
  for (let i = -2; i <= 2; i++) {
    stampModel(acc, archGothic, {
      x: i * 3.05, y: -0.18, z: -4.85, sx: 1.02, sy: 1.28, sz: 1.35,
      primTints: [[0.28, 0.24, 0.36]],
    });
    if (Math.abs(i) <= 1) {
      stampModel(acc, archRound, {
        x: i * 3.05, y: 3.15, z: -5.45, sx: 1.0, sy: 0.95, sz: 1.2,
        primTints: [[0.24, 0.20, 0.32]],
      });
    }
  }
  // Wrought-Iron Sanctuary Gates & Stone Crypt Walls
  for (const gx of [-3.05, 0, 3.05]) {
    stampModel(acc, gateIron, { x: gx, y: -0.18, z: -5.35, sx: 1.45, sy: 1.55, sz: 1.2 });
  }
  // Side Nave Gothic Arches + Altar Braziers + Wall Torches
  for (const sx of [-1, 1]) {
    const wx = sx * (hw + 0.65);
    stampModel(acc, archRound, {
      x: wx, y: 0.0, z: 0, sx: 1.15, sy: 1.15, sz: 1.25, rotY: Math.PI * 0.5,
      primTints: [[0.26, 0.22, 0.34]],
    });
    stampModel(acc, wallStone, { x: wx, y: 0.0, z: -2.1, sx: 0.85, sy: 0.45, sz: 1.1, rotY: Math.PI * 0.5 });
    stampModel(acc, wallStone, { x: wx, y: 0.0, z: 2.1, sx: 0.85, sy: 0.45, sz: 1.1, rotY: Math.PI * 0.5 });
    stampModel(acc, brazier, {
      x: sx * 4.5, y: -0.16, z: -3.6, sx: 1.25, sy: 1.25, sz: 1.25,
      primTints: [[0.14, 0.12, 0.18], [0.82, 0.35, 1.0]],
      primEmissive: [0, 2.0],
    });
    stampModel(acc, wallTorch, { x: sx * 3.05, y: 2.3, z: -4.65, sx: 1.6, sy: 1.6, sz: 1.6 });
  }
  bakeStage('cathedral_retribution', floorMesh, acc);
}

// ============================================================================
// 4. NEOTOKYO HELIPAD -> ZAIBATSU SKYPORT DECK (CC0 Skyscrapers + VTOL Ship)
// ============================================================================
{
  const hw = 6.0, hd = 1.75;
  const floorB = new MeshBuilder();
  floorB.setRoughness(0.42).setGrain(0.55).setRelief(0.42);
  floorB.addBox([0, -0.28, 0], [hw + 0.55, 0.28, hd + 0.65], [0.14, 0.16, 0.21], 0, 0.52);
  const floorMesh = floorB.build({ planarUvs: true, colorSpace: 'srgb' });

  const baseB = new MeshBuilder();
  baseB.setRoughness(0.4).setGrain(0.3);
  baseB.addBox([0, -0.78, 0], [hw + 1.45, 0.22, hd + 1.55], [0.20, 0.24, 0.30], 0, 0.68);
  baseB.addBox([0, -3.6, 0], [hw + 0.95, 2.6, hd + 1.05], [0.08, 0.10, 0.14], 0, 0.55);
  // Rear landing pad extension where the VTOL Dropship is docked!
  baseB.addBox([0, -0.45, -6.2], [6.2, 0.28, 3.6], [0.12, 0.14, 0.19], 0, 0.6);
  // Perimeter safety curbs & glowing cyan/crimson aviation beacons
  for (const sx of [-1, 1]) {
    const bx = sx * (hw + 0.44);
    baseB.setEmissiveColor(null);
    baseB.addBox([bx, 0.42, 0], [0.16, 0.42, hd + 0.55], [0.22, 0.26, 0.33], 0, 0.75);
    baseB.setEmissiveColor(srgbColor(0.96, 0.16, 0.24));
    baseB.addSphere([bx, 1.05, -hd - 0.35], 0.14, [0.98, 0.18, 0.26], 2.2, 10, 8, 0.85);
    baseB.addSphere([bx, 1.05, hd + 0.35], 0.14, [0.98, 0.18, 0.26], 2.2, 10, 8, 0.85);
  }
  baseB.setEmissiveColor(null);

  const acc = createAcc();
  appendMeshData(acc, baseB.build({ planarUvs: true, colorSpace: 'srgb' }));

  // Docked CC0 VTOL Zaibatsu Dropship (`Spaceship.glb`) on rear landing pad!
  stampModel(acc, spaceship, {
    x: -0.6, y: 0.18, z: -6.1, sx: 0.72, sy: 0.72, sz: 0.72, rotY: 0.42,
    primTints: [[0.20, 0.24, 0.32]],
  });

  // Geodesic Radar Command Dome (`GeodesicDome.glb`) & Armored Sci-Fi Cargo Crates (`Pickup_Crate.glb`)
  stampModel(acc, geodesicDome, {
    x: 6.4, y: -0.56, z: -5.8, sx: 0.52, sy: 0.52, sz: 0.52, rotY: 0.3,
    primTints: [[0.18, 0.28, 0.38]],
  });
  for (const [cx, cz, ry] of [[-5.1, -3.5, 0.25], [-4.2, -3.7, -0.4], [4.8, -3.4, 0.6]]) {
    stampModel(acc, pickupCrate, {
      x: cx, y: -0.15, z: cz, sx: 0.65, sy: 0.65, sz: 0.65, rotY: ry,
      primTints: [[0.24, 0.28, 0.36]],
    });
  }

  // Surrounding 3D Downtown Skyscrapers (`Building_Small_1.glb` & `Building_Medium_2.glb`) rising from city below!
  const bldgTints = Array.from({ length: 14 }, (_, idx) =>
    idx % 4 === 2 ? [0.35, 0.78, 0.98] : idx % 3 === 0 ? [0.08, 0.11, 0.17] : [0.13, 0.16, 0.23],
  );
  const bldgEmissive = Array.from({ length: 14 }, (_, idx) => (idx % 4 === 2 ? 1.45 : 0));

  for (const [bx, by, bz, sc, ry, useMed] of [
    [-11.5, -10.5, -13.5, 0.85, 0.15, false],
    [-3.8, -11.2, -16.8, 0.92, 0.0, true],
    [5.2, -10.8, -16.2, 0.88, Math.PI, false],
    [12.4, -11.0, -12.8, 0.85, -0.2, true],
  ]) {
    stampModel(acc, useMed ? buildingMed : buildingSmall, {
      x: bx, y: by, z: bz, sx: sc, sy: sc * 1.15, sz: sc, rotY: ry,
      primTints: bldgTints,
      primEmissive: bldgEmissive,
    });
  }
  bakeStage('neotokyo_helipad', floorMesh, acc);
}
