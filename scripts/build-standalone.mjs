import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const distDir = path.resolve('dist');
const builtHtmlPath = fs.existsSync(path.join(distDir, 'app.html'))
  ? path.join(distDir, 'app.html')
  : path.join(distDir, 'index.html');

let html = fs.readFileSync(builtHtmlPath, 'utf8');
const assetsDir = path.join(distDir, 'assets');
const files = fs.readdirSync(assetsDir);

const cssFile = files.find((f) => f.endsWith('.css'));
const jsFile = files.find((f) => f.endsWith('.js'));

if (!cssFile || !jsFile) {
  throw new Error('Expected built CSS and JS in dist/assets');
}

// Write normal dist/index.html for Vite preview server on port 5173
fs.writeFileSync(path.join(distDir, 'index.html'), html, 'utf8');

const css = fs.readFileSync(path.join(assetsDir, cssFile), 'utf8');

// Convert ESM bundle to pure classic IIFE (no import.meta, no module CORS/CSP quirks in srcdoc iframes!)
const esbuildBin = path.resolve('node_modules/.bin/esbuild');
const iifeJs = execFileSync(
  esbuildBin,
  [
    path.join(assetsDir, jsFile),
    '--bundle',
    '--format=iife',
    '--target=es2020',
    '--minify-syntax',
  ],
  { maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
).replace(/<\/script/gi, '<\\/script');

// Strip external manifest/icon links so offline sandboxed iframe makes zero network requests
html = html.replace(/<link[^>]*rel="manifest"[^>]*>\s*/gi, '');
html = html.replace(/<link[^>]*rel="icon"[^>]*>\s*/gi, '');

// Inline CSS and classic <script> IIFE right before </body> so DOM is already parsed!
html = html.replace(
  /<link[^>]*rel="stylesheet"[^>]*>/i,
  () => `<style>\n${css}\n</style>`,
);
html = html.replace(
  /<script[^>]*type="module"[^>]*src="[^"]+"[^>]*><\/script>/i,
  () => '',
);
html = html.replace(
  /<\/body>/i,
  () => `<script>\n${iifeJs}\n</script>\n</body>`,
);

for (const target of ['index.html', 'play-iron-fist-v.html']) {
  const outPath = path.resolve(target);
  fs.writeFileSync(outPath, html, 'utf8');
  console.log(`Built standalone classic-IIFE ${outPath} (${(html.length / 1024 / 1024).toFixed(2)} MB)`);
}
