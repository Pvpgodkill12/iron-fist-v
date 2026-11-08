import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import wabtFactory from 'wabt';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const watPath = path.join(root, 'src', 'wasm', 'combat_kernel.wat');
const outPath = path.join(root, 'public', 'combat_kernel.wasm');

const wabt = await wabtFactory();
const watSource = fs.readFileSync(watPath, 'utf8');
const parsed = wabt.parseWat('combat_kernel.wat', watSource, {
  mutable_globals: true,
  sat_float_to_int: true,
  sign_extension: true,
});
parsed.validate();
const { buffer } = parsed.toBinary({ log: false, write_debug_names: true });

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, Buffer.from(buffer));

// Also emit an embedded base64/Uint8Array module so synchronous tests & offline single-file contexts work instantly!
const embeddedTsPath = path.join(root, 'src', 'wasm', 'embeddedWasm.ts');
const bytesList = Array.from(buffer).join(',');
fs.writeFileSync(
  embeddedTsPath,
  `// Auto-generated from src/wasm/combat_kernel.wat by scripts/build-wasm.mjs\nexport const COMBAT_KERNEL_WASM_BYTES = new Uint8Array([${bytesList}]);\n`,
  'utf8',
);

console.log(`Compiled combat_kernel.wasm (${buffer.byteLength} bytes) + embeddedWasm.ts successfully.`);
