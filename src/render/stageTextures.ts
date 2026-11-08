import type { StageId } from '../data/types';

/**
 * Generates crisp, seamless 512x512 tiling surface albedo textures per arena.
 * Because markings (mortar seams, dojo cedar planks, marble veins, helipad markings)
 * live inside the GPU texture rather than coplanar 4mm boxes, Z-fighting is 0.0%.
 */
export function buildStageFloorCanvas(stageId: StageId): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  let seed = stageId.length * 4999 + 17;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };

  switch (stageId) {
    case 'moonlit_wilderness': {
      // Weathered Gothic sanctuary flagstone Ashlar blocks with dark mortar seams
      ctx.fillStyle = '#adb6c8';
      ctx.fillRect(0, 0, 512, 512);
      const rows = 8;
      const cols = 4;
      const rh = 512 / rows;
      const cw = 512 / cols;
      for (let r = 0; r < rows; r += 1) {
        const offset = (r % 2) * (cw * 0.5);
        for (let c = -1; c <= cols; c += 1) {
          const x = c * cw + offset;
          const y = r * rh;
          const v = Math.floor(158 + rand() * 36);
          ctx.fillStyle = `rgb(${v - 8}, ${v - 2}, ${v + 12})`;
          ctx.fillRect(x + 3, y + 3, cw - 6, rh - 6);
          // Subtle bevel highlight
          ctx.strokeStyle = 'rgba(235, 244, 255, 0.25)';
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 4, y + 4, cw - 8, rh - 8);
        }
      }
      // Fine stone speckles & cracks
      for (let i = 0; i < 1400; i += 1) {
        const x = rand() * 512;
        const y = rand() * 512;
        ctx.fillStyle = rand() > 0.5 ? 'rgba(30,36,48,0.16)' : 'rgba(240,248,255,0.14)';
        ctx.fillRect(x, y, 2, 2);
      }
      break;
    }

    case 'honmaru_dojo': {
      // Traditional Japanese Hon-Maru aged cedar floorboards with wood grain & joinery seams
      ctx.fillStyle = '#c89e78';
      ctx.fillRect(0, 0, 512, 512);
      const planks = 8;
      const pw = 512 / planks;
      for (let p = 0; p < planks; p += 1) {
        const x = p * pw;
        const base = 175 + Math.floor(rand() * 32);
        ctx.fillStyle = `rgb(${base + 22}, ${base - 8}, ${base - 36})`;
        ctx.fillRect(x + 2, 0, pw - 4, 512);

        // Wood grain streaks
        for (let g = 0; g < 26; g += 1) {
          const gx = x + 4 + rand() * (pw - 8);
          ctx.fillStyle = 'rgba(72, 38, 16, 0.14)';
          ctx.fillRect(gx, 0, 1.5, 512);
        }
        // Horizontal plank butt-joint
        const jointY = ((p * 173 + 80) % 440) + 36;
        ctx.fillStyle = 'rgba(42, 20, 8, 0.68)';
        ctx.fillRect(x, jointY, pw, 3);
        // Dark seam between planks
        ctx.fillStyle = 'rgba(38, 18, 8, 0.78)';
        ctx.fillRect(x, 0, 2.5, 512);
      }
      break;
    }

    case 'cathedral_retribution': {
      // Polished dark obsidian & royal marble tilework with subtle gold inlay grid
      ctx.fillStyle = '#9a96ab';
      ctx.fillRect(0, 0, 512, 512);
      const tiles = 4;
      const ts = 512 / tiles;
      for (let r = 0; r < tiles; r += 1) {
        for (let c = 0; c < tiles; c += 1) {
          const v = (r + c) % 2 === 0 ? 156 : 132;
          ctx.fillStyle = `rgb(${v}, ${v - 4}, ${v + 14})`;
          ctx.fillRect(c * ts + 2, r * ts + 2, ts - 4, ts - 4);
        }
      }
      // Diagonal marble veins
      ctx.strokeStyle = 'rgba(235, 225, 250, 0.24)';
      ctx.lineWidth = 2.2;
      for (let v = 0; v < 18; v += 1) {
        ctx.beginPath();
        let vx = rand() * 512;
        let vy = rand() * 512;
        ctx.moveTo(vx, vy);
        for (let s = 0; s < 5; s += 1) {
          vx += (rand() - 0.35) * 75;
          vy += (rand() - 0.35) * 75;
          ctx.lineTo(vx, vy);
        }
        ctx.stroke();
      }
      // Fine gold border inlay lines
      ctx.strokeStyle = 'rgba(225, 190, 110, 0.42)';
      ctx.lineWidth = 2;
      for (let i = 0; i <= tiles; i += 1) {
        ctx.beginPath();
        ctx.moveTo(i * ts, 0);
        ctx.lineTo(i * ts, 512);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, i * ts);
        ctx.lineTo(512, i * ts);
        ctx.stroke();
      }
      break;
    }

    case 'dragons_nest': {
      // Carved mountain granite shrine flagstones with weathered stone relief
      ctx.fillStyle = '#b4aba4';
      ctx.fillRect(0, 0, 512, 512);
      const grid = 6;
      const gs = 512 / grid;
      for (let r = 0; r < grid; r += 1) {
        for (let c = 0; c < grid; c += 1) {
          const v = 152 + Math.floor(rand() * 34);
          ctx.fillStyle = `rgb(${v + 6}, ${v}, ${v - 6})`;
          ctx.fillRect(c * gs + 3, r * gs + 3, gs - 6, gs - 6);
        }
      }
      for (let i = 0; i < 1800; i += 1) {
        ctx.fillStyle = rand() > 0.5 ? 'rgba(45,38,34,0.18)' : 'rgba(245,238,230,0.15)';
        ctx.fillRect(rand() * 512, rand() * 512, 2.5, 2.5);
      }
      break;
    }

    case 'neotokyo_helipad': {
      // Heavy-duty brushed rooftop ferro-concrete slabs with expansion joints & crimson tactical grid
      ctx.fillStyle = '#a4acb8';
      ctx.fillRect(0, 0, 512, 512);
      const slabs = 4;
      const ss = 512 / slabs;
      for (let r = 0; r < slabs; r += 1) {
        for (let c = 0; c < slabs; c += 1) {
          const v = 150 + Math.floor(rand() * 22);
          ctx.fillStyle = `rgb(${v - 4}, ${v}, ${v + 8})`;
          ctx.fillRect(c * ss + 3, r * ss + 3, ss - 6, ss - 6);
        }
      }
      // Crimson tactical warning stripe accent along slab edges
      ctx.strokeStyle = 'rgba(220, 45, 58, 0.48)';
      ctx.lineWidth = 3;
      ctx.strokeRect(8, 8, 496, 496);
      for (let i = 0; i < 1600; i += 1) {
        ctx.fillStyle = 'rgba(28, 32, 40, 0.16)';
        ctx.fillRect(rand() * 512, rand() * 512, 2, 2);
      }
      break;
    }
  }

  return canvas;
}
