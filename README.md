# IRON FIST V — WebGPU Championship

A complete, Tekken 5-inspired 3D martial-arts fighting game built with **WebGPU** (via **DriftEngine v4.14** with automatic **WebGL2** fallback), a custom **WebAssembly (`combat_kernel.wasm`)** 3D combat & AI kernel, procedural 20-joint GPU skeletal skinning, and unified **PC Keyboard + Dual Gamepads + Mobile Multi-Touch** controls.

---

## Key Features

- **WebGPU + WebAssembly + DriftEngine Architecture**
  - **DriftEngine (`@driftengine/core`, `@driftengine/animation`)**: Real-time PBR lighting, directional skinned shadow maps, planar mirror floor reflections (`beginPlanarReflection` + `drawFilm`), HDR ACES tonemapping + bloom, GPU particle systems (impact sparks, footstep dust, ambient stage motes), and procedural Mishima electric lightning bolts (`BoltPool` / `BoltBatch`).
  - **WebAssembly Combat Kernel (`src/wasm/combat_kernel.wat` → `public/combat_kernel.wasm`)**: Hand-written, zero-allocation WASM module handling 3D fighter capsule separation & arena wall detection, 3D hitbox vs. sidestep/ducking/homing collision, Tekken 5 combo scaling + Counter-Hit + Rage math, airborne juggle ballistics, and 60Hz tactical CPU move evaluation.
  - **Seamless PC & Mobile Support**: Automatically scales render quality (`ULTRA` / `HIGH` / `MOBILE`), adapts camera framing for landscape and portrait mobile viewports, and provides a full multi-touch virtual 8-way arcade stick + tilted Tekken 4-limb diamond (`1, 2, 3, 4`) + macro buttons (`1+2 RAGE`, `1+3 GRAB`, `3+4 KI`).

- **Full 12-Character Roster (Each with P1 & P2 Costumes + Full Command List)**
  1. **Jinrai Kazama** — Traditional Kazama-Style Karate (Versatile All-Rounder)
  2. **Kazuma Mishima** — Mishima-Style Fighting Karate (`f,d,d/f+2` Electric Wind God Fist, Hell Sweep vortex)
  3. **Tae-Hwan Baek** — ITF Taekwondo (Relentless Kick Flurry Rushdown)
  4. **Marcus Fury** — Kickboxing & Cyber-Brawl (Brutal Counter-Hit Bruiser)
  5. **Paul Steele** — American Judo & Bajiquan (`d,d/f,f+2` Phoenix Smasher / Deathfist)
  6. **El Jaguar** — Mexican Lucha Libre Wrestling (Grappler Titan & Heavy Throws)
  7. **Nina Vane** — Koppojutsu & Aikido Assassination (High-Speed Rushdown)
  8. **Lin Xiao** — Baguazhang & Piguaquan (Evasive Low-Profile Trickster)
  9. **Yoshimaru** — Manji Ninjutsu Swordsmanship (Glowing Katana Specialist + Unblockable Slash)
  10. **Edgar Silva** — Brazilian Capoeira (Acrobatic Rhythm Mixup)
  11. **Steven Sterling** — Championship Boxing (Peekaboo Sway & Counter-Puncher)
  12. **Jinpachi Overlord** — Ancient Mishima Demon Arts (Towering Tournament Final Boss)

- **5 Iconic 3D Tekken 5-Inspired Stages**
  - **Moonlit Wilderness** — Ruined Gothic abbey arches, swaying silver lilies, full moon & reflective wet stone
  - **Hon-Maru Burning Dojo** — Blazing Mishima compound pillars, tatami arena & rising embers
  - **Cathedral of Retribution** — Grand Gothic pillars, stained-glass rose window & demonic purple aura
  - **Dragon's Nest** — High-altitude mountain shrine, crimson torii gates & golden dragon statues
  - **Neo-Tokyo Rooftop Helipad** — Rain-slicked skyscraper helipad, neon towers & mirror reflections

- **4 Game Modes**
  - **Arcade Championship**: 8-Stage King of Iron Fist Tournament V ladder culminating against **Jinpachi Overlord**
  - **Versus CPU**: Free battle across 4 AI ranks (*1st Dan*, *Warrior*, *Raijin*, *Tekken God*)
  - **Local 2-Player Versus**: Shared PC keyboard or dual PS5 / Xbox controllers
  - **Dojo Practice Lab**: Live frame-data inspector, 3D hitbox/hurtbox wireframes (`B`), command input history tape, and configurable training dummy (*Stand*, *Guard All*, *Crouch*, *3D Sidestep*, *Sparring CPU*)

---

## Controls

| Action | Player 1 Keyboard | Player 2 Keyboard | Gamepad (PS / Xbox) | Mobile Touch |
| :--- | :--- | :--- | :--- | :--- |
| **Move / Guard** | `A` / `D` (or `←` / `→` in 1P) | `←` / `→` | D-Pad / Left Stick | Virtual Stick Left / Right |
| **3D Sidestep** | Quick Tap `W` or `S` | Quick Tap `↑` or `↓` | Quick Tap Up / Down | Quick Tap Stick Up / Down |
| **Crouch / Jump** | Hold `S` / Hold `W` | Hold `↓` / Hold `↑` | Hold Down / Up | Hold Stick Down / Up |
| **1 (Left Punch)** | `U` or `Z` | `Numpad 4` or `7` | `□` / `X` | Blue `1 LP` |
| **2 (Right Punch)** | `I` or `X` | `Numpad 8` or `8` | `△` / `Y` | Gold `2 RP` |
| **3 (Left Kick)** | `J` or `C` | `Numpad 1` or `9` | `✕` / `A` | Green `3 LK` |
| **4 (Right Kick)** | `K` or `V` | `Numpad 2` or `0` | `○` / `B` | Red `4 RK` |
| **1+2 (Rage Art / Power Crush)** | `O` or `Space` | `Numpad 6` or `-` | `R1` / `RB` | `1+2 RAGE` |
| **3+4 (Ki Burst)** | `L` | `Numpad 3` or `=` | `R2` / `RT` | `3+4 KI` |
| **1+3 (Throw / Break)** | `Y` | `Numpad 7` | `L1` / `LB` | `1+3 GRAB` |
| **Move List / Pause / Hitboxes** | `M` / `Esc` / `B` | — | `Start` / `Options` | Top-Right HUD Buttons |

---

## Development & Build

```bash
npm install
npm run build:wasm   # Compile src/wasm/combat_kernel.wat -> public/combat_kernel.wasm
npm run dev          # Launch Vite dev server on 0.0.0.0:5173
npm test             # Run Vitest WASM + 3D combat engine suite
npm run build        # Production build to dist/
```
