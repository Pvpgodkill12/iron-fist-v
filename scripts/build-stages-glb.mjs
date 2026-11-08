import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';

/**
 * Compiles all 5 3D Arenas into genuine Khronos glTF 2.0 binary `.glb` files
 * in `public/models/stages/*.glb` using DriftEngine's `@driftengine/drft` + `@driftengine/assets`,
 * and verifies every `.glb` round-trips cleanly via `readGlb` + `gltfToMeshes`.
 */
const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});

try {
  const { STAGES } = await vite.ssrLoadModule('/src/data/stages.ts');
  const { buildStageGeometry } = await vite.ssrLoadModule('/src/render/stageBuilder.ts');
  const { writeDrft, readDrft } = await import('@driftengine/drft');
  const { drftToGlb, readGlb, gltfToMeshes } = await import('@driftengine/assets');

  const outDir = path.resolve('public/models/stages');
  fs.mkdirSync(outDir, { recursive: true });

  for (const stage of STAGES) {
    const { floorMesh, archMesh } = buildStageGeometry(stage);
    const drftBytes = writeDrft({ meshes: [floorMesh, archMesh] });
    const drftAsset = readDrft(drftBytes);
    const { glb } = drftToGlb(drftAsset);

    // Verify clean glTF 2.0 round-trip
    const parsed = readGlb(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength));
    const verified = gltfToMeshes(parsed.json, parsed.binary ? [parsed.binary] : []);
    if (verified.meshes.length !== 2) {
      throw new Error(`Stage ${stage.id} GLB expected 2 primitives, got ${verified.meshes.length}`);
    }

    const outPath = path.join(outDir, `${stage.id}.glb`);
    fs.writeFileSync(outPath, glb);
    console.log(
      `Baked 3D Arena ${stage.id}.glb (${(glb.byteLength / 1024).toFixed(1)} kB, ${
        (verified.meshes[0].positions.length + verified.meshes[1].positions.length) / 3
      } vertices)`,
    );
  }
} finally {
  await vite.close();
}
