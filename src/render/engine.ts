import {
  BoltPool,
  Camera,
  ParticlePool,
  SceneNode,
  clamp,
  computeLightMatrix,
  createEnvironment,
  createLineSegments,
  createRenderer,
  damp,
  lerp,
  scaleColor,
  srgbColor,
  type CreatedRenderer,
  type Environment,
  type LineSegments,
  type RenderBackend,
  type SceneCasterMaterial,
  type ShadowCasters,
  type SurfaceTextureHandle,
  type Vec3,
} from '@driftengine/core';
import type { BoltHandle, LineHandle, MeshHandle, ParticleHandle } from '@driftengine/core';
import { gltfToMeshes, readGlb } from '@driftengine/assets';
import { mat4 } from 'gl-matrix';
import type { CharacterData, StageDefinition } from '../data/types';
import {
  BASE_HIT_DEPTH,
  isMoveActive,
  type CombatEvent,
  type FighterSim,
  type MatchState,
} from '../sim/combat';
import {
  FighterRigAnimator,
  JOINT_CHEST,
  JOINT_WRIST_R,
  buildFighterMeshData,
  hexToLinear,
} from './fighterMesh';
import { buildStageGeometry } from './stageBuilder';
import { buildStageFloorCanvas } from './stageTextures';

export type QualityPreset = 'ultra' | 'high' | 'mobile';
export type MenuShowcaseMode = 'home' | 'arena_preview' | 'fighter_preview';

export interface SceneEngineLike {
  readonly canvas: HTMLCanvasElement;
  readonly backend: RenderBackend | 'canvas2d';
  readonly backendReason: string;
  readonly quality: QualityPreset;
  showHitboxes: boolean;
  resize(): void;
  dispose(): void;
  loadStage(stage: StageDefinition): void;
  ensureFightersLoaded(
    p1: CharacterData,
    p1Costume: 0 | 1,
    p2: CharacterData,
    p2Costume: 0 | 1,
  ): void;
  consumeCombatEvents(state: MatchState, events: readonly CombatEvent[]): void;
  stepEffects(dt: number, state: MatchState | null): void;
  renderMatch(state: MatchState, alpha: number): void;
  renderMenuShowcase(
    p1: CharacterData,
    p1Costume: 0 | 1,
    p2: CharacterData,
    p2Costume: 0 | 1,
    stage: StageDefinition,
    mode?: MenuShowcaseMode,
  ): void;
}

const IDENTITY_MAT = mat4.create();

function replaceWithFreshCanvas(oldCanvas: HTMLCanvasElement): HTMLCanvasElement {
  const fresh = oldCanvas.cloneNode(false) as HTMLCanvasElement;
  oldCanvas.replaceWith(fresh);
  return fresh;
}

export class FightSceneEngine implements SceneEngineLike {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: CreatedRenderer['renderer'];
  readonly backend: RenderBackend;
  readonly backendReason: string;
  readonly quality: QualityPreset;

  private readonly camera = new Camera();
  private readonly lightMatrix = mat4.create();
  private readonly fighterNodes: [SceneNode, SceneNode] = [new SceneNode(), new SceneNode()];
  private readonly animators: [FighterRigAnimator, FighterRigAnimator] = [
    new FighterRigAnimator(),
    new FighterRigAnimator(),
  ];

  private fighterMeshes: [MeshHandle | null, MeshHandle | null] = [null, null];
  private fighterMeshKeys: [string, string] = ['', ''];
  private visibleFighterCount: 0 | 1 | 2 = 2;

  private stageFloorMesh: MeshHandle | null = null;
  private stageArchMesh: MeshHandle | null = null;
  private stageFloorTexture: SurfaceTextureHandle | null = null;
  private stageFloorMaterial: SceneCasterMaterial = null;
  private currentStage: StageDefinition | null = null;
  private stageLoadToken = 0;
  private env!: Environment;
  private skyLinear: Vec3 = [0.05, 0.08, 0.15];

  // GPU Particle Pools & Electric Lightning Bolt Pool
  private readonly sparkPool: ParticlePool;
  private readonly sparkBatch: ParticleHandle;
  private readonly dustPool: ParticlePool;
  private readonly dustBatch: ParticleHandle;
  private readonly ambientPool: ParticlePool;
  private readonly ambientBatch: ParticleHandle;
  private readonly boltPool: BoltPool;
  private readonly boltBatch: BoltHandle;

  // 3D Debug Hitbox / Hurtbox Wireframe Renderer
  private readonly debugLines: LineSegments;
  private readonly debugLineBatch: LineHandle;
  showHitboxes = false;

  // Dynamic Tekken Camera State
  private camX = 0;
  private camY = 1.75;
  private camZ = 4.95;
  private lookX = 0;
  private lookY = 1.08;
  private lookZ = 0;
  private shakeStrength = 0;
  private clockSec = 0;
  private seedCounter = 1;

  private readonly scratchA: Vec3 = [0, 0, 0];
  private readonly scratchB: Vec3 = [0, 0, 0];
  private readonly shadowCasters: ShadowCasters;
  private readonly sceneCasters: ShadowCasters;

  private constructor(
    canvas: HTMLCanvasElement,
    created: CreatedRenderer,
    quality: QualityPreset,
  ) {
    this.canvas = canvas;
    this.renderer = created.renderer;
    this.backend = created.backend;
    this.backendReason = created.reason;
    this.quality = quality;

    // Tight depth frustum prevents mobile 16/24-bit depth buffer Z-fighting!
    this.camera.fovYDeg = 44;
    this.camera.near = 0.4;
    this.camera.far = 80;

    // 1. Impact Hit Sparks (Crimson/Gold HDR streaks)
    this.sparkPool = new ParticlePool({
      capacity: 220,
      lifeSec: 0.34,
      sizeStart: 0.085,
      sizeEnd: 0.01,
      colorStart: scaleColor(srgbColor(1.0, 0.78, 0.32), 2.6),
      colorEnd: srgbColor(0.95, 0.14, 0.12),
      gravity: 9.5,
      drag: 2.8,
      rise: 0,
      alphaStart: 1.0,
      alphaEnd: 0.0,
    });
    this.sparkBatch = this.renderer.createParticles(220, {
      material: 'spark',
      blend: 'additive',
      facing: 'velocity',
      stretchSec: 0.055,
      coreGain: 2.2,
    });

    // 2. Footwork / Knockdown / Wall-Splat Dust Puffs
    this.dustPool = new ParticlePool({
      capacity: 140,
      lifeSec: 0.58,
      sizeStart: 0.14,
      sizeEnd: 0.42,
      colorStart: srgbColor(0.68, 0.66, 0.72),
      colorEnd: srgbColor(0.28, 0.28, 0.34),
      gravity: 0.4,
      drag: 3.2,
      rise: 0.65,
      alphaStart: 0.48,
      alphaEnd: 0.0,
    });
    this.dustBatch = this.renderer.createParticles(140, {
      material: 'smoke',
      blend: 'alpha',
      facing: 'camera',
      erosion: 0.45,
    });

    // 3. Stage Atmospheric Motes / Embers
    this.ambientPool = new ParticlePool({
      capacity: 100,
      lifeSec: 3.6,
      sizeStart: 0.04,
      sizeEnd: 0.018,
      colorStart: scaleColor(srgbColor(0.95, 0.52, 0.36), 1.6),
      colorEnd: srgbColor(0.85, 0.16, 0.22),
      gravity: -0.05,
      drag: 0.35,
      rise: 0.32,
      alphaStart: 0.75,
      alphaEnd: 0.0,
    });
    this.ambientBatch = this.renderer.createParticles(100, {
      material: 'mote',
      blend: 'additive',
      facing: 'camera',
    });

    // 4. Electric Lightning Arcs & Rage Bolts
    this.boltPool = new BoltPool({
      capacity: 28,
      nodes: 9,
      lifeSec: 0.22,
      jitter: 0.28,
      restrikeHz: 32,
    });
    this.boltBatch = this.renderer.createBolts(28 * 8, 'mishima-lightning');

    // 5. Practice Mode 3D Hitbox / Hurtbox Wireframe Lines
    this.debugLines = createLineSegments(96);
    this.debugLineBatch = this.renderer.createLines(96, 'debug-hitboxes');

    // Shadow pass: ONLY 3D architecture + active fighters cast shadows (prevents floor self-shadow acne!)
    this.shadowCasters = (sink) => {
      if (this.stageArchMesh !== null) {
        sink.mesh(this.stageArchMesh, IDENTITY_MAT);
      }
      for (let i = 0; i < this.visibleFighterCount; i += 1) {
        const m = this.fighterMeshes[i];
        if (m !== null) {
          sink.skinnedMesh(
            m,
            this.fighterNodes[i].worldMatrix,
            this.animators[i].skeleton.palette,
          );
        }
      }
    };

    // Main Lit HDR pass: Textured Floor + Sculpted 3D Architecture + Active Skinned Fighters
    this.sceneCasters = (sink) => {
      if (this.stageFloorMesh !== null) {
        sink.mesh(this.stageFloorMesh, IDENTITY_MAT, this.stageFloorMaterial);
      }
      if (this.stageArchMesh !== null) {
        sink.mesh(this.stageArchMesh, IDENTITY_MAT, null);
      }
      for (let i = 0; i < this.visibleFighterCount; i += 1) {
        const m = this.fighterMeshes[i];
        if (m !== null) {
          sink.skinnedMesh(
            m,
            this.fighterNodes[i].worldMatrix,
            this.animators[i].skeleton.palette,
          );
        }
      }
    };

    this.renderer.resize();
  }

  static async create(
    canvas: HTMLCanvasElement,
    preset: QualityPreset = 'high',
  ): Promise<SceneEngineLike> {
    const isMobilePreset = preset === 'mobile';
    const isUltra = preset === 'ultra';
    const qualityOpts = {
      maxDevicePixelRatio: isMobilePreset ? 1.35 : isUltra ? 2.0 : 1.7,
      directionalShadows: true,
      directionalShadowMapSize: isMobilePreset ? 1024 : 2048,
      hdrScene: true,
      screenEffects: true,
      outputTransform: 'shoulder' as const,
      bloom: isMobilePreset ? 0.28 : 0.45,
      bloomThreshold: 1.1,
      ambientOcclusion: isMobilePreset ? 0 : 0.4,
      planarReflections: false,
    };

    try {
      const created = await createRenderer(canvas, qualityOpts, {
        splash: false,
        backendTimeoutMs: 3500,
      });
      return new FightSceneEngine(canvas, created, preset);
    } catch {
      const freshCanvas = replaceWithFreshCanvas(canvas);
      try {
        const createdGl = await createRenderer(freshCanvas, qualityOpts, {
          preferWebGpu: false,
          splash: false,
          backendTimeoutMs: 2500,
        });
        return new FightSceneEngine(freshCanvas, createdGl, preset);
      } catch (err) {
        const fallbackCanvas = replaceWithFreshCanvas(freshCanvas);
        const msg = err instanceof Error ? err.message : String(err);
        return new Canvas2dFallbackEngine(fallbackCanvas, preset, msg);
      }
    }
  }

  dispose(): void {
    if (this.stageFloorMesh !== null) this.renderer.disposeMesh(this.stageFloorMesh);
    if (this.stageArchMesh !== null) this.renderer.disposeMesh(this.stageArchMesh);
    if (this.stageFloorTexture !== null) {
      this.renderer.disposeSurfaceTexture(this.stageFloorTexture);
    }
    this.renderer.dispose();
  }

  resize(): void {
    this.renderer.resize();
  }

  loadStage(stage: StageDefinition): void {
    if (this.currentStage?.id === stage.id && this.stageFloorMesh !== null) return;

    const token = (this.stageLoadToken += 1);
    if (this.stageFloorMesh !== null) {
      this.renderer.disposeMesh(this.stageFloorMesh);
      this.stageFloorMesh = null;
    }
    if (this.stageArchMesh !== null) {
      this.renderer.disposeMesh(this.stageArchMesh);
      this.stageArchMesh = null;
    }
    if (this.stageFloorTexture !== null) {
      this.renderer.disposeSurfaceTexture(this.stageFloorTexture);
      this.stageFloorTexture = null;
      this.stageFloorMaterial = null;
    }

    // 1. Upload crisp 512x512 procedural PBR floor tile texture (zero coplanar seams!)
    const texCanvas = buildStageFloorCanvas(stage.id);
    if (texCanvas) {
      this.stageFloorTexture = this.renderer.createSurfaceTexture(texCanvas);
      this.stageFloorMaterial = {
        albedo: this.stageFloorTexture,
        uScale: 0.34,
        vScale: 0.34,
      };
    }

    // 2. Upload immediate clean geometry so there is 0ms blank frame, then stream `.glb` 3D model!
    const immediate = buildStageGeometry(stage);
    this.stageFloorMesh = this.renderer.createMesh(immediate.floorMesh);
    this.stageArchMesh = this.renderer.createMesh(immediate.archMesh);
    this.currentStage = stage;

    // 3. Stream baked Khronos glTF 2.0 `.glb` 3D Arena from `./models/stages/${stage.id}.glb` when hosted over HTTP(S)
    if (typeof fetch === 'function' && window.location.protocol.startsWith('http')) {
      void fetch(`./models/stages/${stage.id}.glb`)
        .then((res) => (res.ok ? res.arrayBuffer() : null))
        .then((buf) => {
          if (!buf || token !== this.stageLoadToken) return;
          const parsed = readGlb(buf);
          const imported = gltfToMeshes(parsed.json, parsed.binary ? [parsed.binary] : []);
          if (imported.meshes.length >= 2) {
            if (this.stageFloorMesh !== null) this.renderer.disposeMesh(this.stageFloorMesh);
            if (this.stageArchMesh !== null) this.renderer.disposeMesh(this.stageArchMesh);
            this.stageFloorMesh = this.renderer.createMesh(imported.meshes[0]);
            this.stageArchMesh = this.renderer.createMesh(imported.meshes[1]);
          }
        })
        .catch(() => {
          // Offline / sandboxed iframe keeps immediate verified geometry seamlessly
        });
    }

    this.skyLinear = hexToLinear(stage.skyHex);
    const sunLin = scaleColor(hexToLinear(stage.sunHex), stage.sunIntensity);
    this.env = createEnvironment({
      directionalDir: stage.sunDir,
      directionalColor: sunLin,
      ambient: hexToLinear(stage.ambientHex),
      ambientGround: hexToLinear(stage.groundAmbientHex),
      nightFactor: 1,
      emissiveGain: 1.45,
      wetness: stage.wetness * 0.45,
      fogColor: hexToLinear(stage.fogHex),
      fogDensity: stage.fogDensity,
      fogHeightFalloff: 0.08,
      fogBaseY: 0,
    });

    this.sparkPool.clear();
    this.dustPool.clear();
    this.ambientPool.clear();
    this.boltPool.clear();
  }

  ensureFightersLoaded(
    p1: CharacterData,
    p1Costume: 0 | 1,
    p2: CharacterData,
    p2Costume: 0 | 1,
  ): void {
    const k0 = `${p1.id}:${p1Costume}`;
    if (this.fighterMeshKeys[0] !== k0) {
      if (this.fighterMeshes[0] !== null) this.renderer.disposeMesh(this.fighterMeshes[0]);
      this.fighterMeshes[0] = this.renderer.createMesh(buildFighterMeshData(p1, p1Costume));
      this.fighterMeshKeys[0] = k0;
    }

    const actualP2Costume: 0 | 1 =
      p1.id === p2.id && p1Costume === p2Costume ? (p1Costume === 0 ? 1 : 0) : p2Costume;
    const k1 = `${p2.id}:${actualP2Costume}`;
    if (this.fighterMeshKeys[1] !== k1) {
      if (this.fighterMeshes[1] !== null) this.renderer.disposeMesh(this.fighterMeshes[1]);
      this.fighterMeshes[1] = this.renderer.createMesh(buildFighterMeshData(p2, actualP2Costume));
      this.fighterMeshKeys[1] = k1;
    }
  }

  consumeCombatEvents(state: MatchState, events: readonly CombatEvent[]): void {
    for (let i = 0; i < events.length; i += 1) {
      const ev = events[i];
      switch (ev.kind) {
        case 'hit':
        case 'counter_hit':
        case 'launch':
        case 'bound': {
          const count = ev.kind === 'counter_hit' || ev.kind === 'launch' ? 28 : 16;
          for (let p = 0; p < count; p += 1) {
            const s = (this.seedCounter += 1);
            const ang = (p / count) * Math.PI * 2 + (s % 7) * 0.2;
            const spd = 2.4 + (s % 5) * 1.15 * (0.6 + ev.power);
            this.sparkPool.emit(
              ev.x,
              ev.y,
              ev.z,
              Math.cos(ang) * spd,
              1.6 + (s % 4) * 0.9,
              Math.sin(ang) * spd * 0.7,
              s,
              ev.kind === 'counter_hit' ? 1.45 : 1.0,
              1.0,
            );
          }
          this.shakeStrength = Math.max(this.shakeStrength, 0.08 + ev.power * 0.16);
          const atk = state.fighters[ev.by];
          if (atk.activeMove?.electric || ev.kind === 'counter_hit' || ev.kind === 'launch') {
            for (let b = 0; b < 5; b += 1) {
              const s = (this.seedCounter += 1);
              this.boltPool.strike(
                ev.x,
                ev.y,
                ev.z,
                ev.x + (((s * 13) % 11) - 5) * 0.16,
                ev.y + (((s * 7) % 11) - 4) * 0.16,
                ev.z + (((s * 19) % 11) - 5) * 0.14,
                s,
                1.8,
                1.1,
              );
            }
          }
          break;
        }
        case 'block': {
          for (let p = 0; p < 10; p += 1) {
            const s = (this.seedCounter += 1);
            const ang = (p / 10) * Math.PI * 2;
            this.sparkPool.emit(
              ev.x,
              ev.y,
              ev.z,
              Math.cos(ang) * 2.2,
              0.8 + (s % 3) * 0.5,
              Math.sin(ang) * 1.6,
              s,
              0.65,
              0.65,
            );
          }
          this.shakeStrength = Math.max(this.shakeStrength, 0.04);
          break;
        }
        case 'electric': {
          for (let b = 0; b < 4; b += 1) {
            const s = (this.seedCounter += 1);
            this.boltPool.strike(
              ev.x,
              0.2,
              ev.z,
              ev.x + (((s * 11) % 9) - 4) * 0.12,
              ev.y + 0.35,
              ev.z + (((s * 17) % 9) - 4) * 0.12,
              s,
              1.6,
              1.0,
            );
          }
          break;
        }
        case 'wall_splat':
        case 'throw_slam': {
          for (let d = 0; d < 18; d += 1) {
            const s = (this.seedCounter += 1);
            const ang = (d / 18) * Math.PI * 2;
            this.dustPool.emit(
              ev.x,
              ev.y,
              ev.z,
              Math.cos(ang) * 1.8,
              0.9 + (s % 4) * 0.4,
              Math.sin(ang) * 1.8,
              s,
              1.35,
              1.1,
            );
          }
          this.shakeStrength = Math.max(this.shakeStrength, 0.24);
          break;
        }
        case 'rage_activate':
        case 'rage_art_start':
        case 'ko': {
          for (let b = 0; b < 8; b += 1) {
            const s = (this.seedCounter += 1);
            const ang = (b / 8) * Math.PI * 2;
            this.boltPool.strike(
              ev.x,
              0.05,
              ev.z,
              ev.x + Math.cos(ang) * 0.9,
              1.95,
              ev.z + Math.sin(ang) * 0.9,
              s,
              2.2,
              1.4,
            );
          }
          this.shakeStrength = Math.max(this.shakeStrength, ev.kind === 'ko' ? 0.32 : 0.2);
          break;
        }
        default:
          break;
      }
    }
  }

  stepEffects(dt: number, state: MatchState | null): void {
    this.clockSec += dt;
    this.shakeStrength = damp(this.shakeStrength, 0, 12, dt);

    if (this.currentStage !== null && (this.seedCounter += 1) % 4 === 0) {
      const s = this.seedCounter;
      const rx = (((s * 73) % 200) / 100 - 1) * 6.5;
      const rz = (((s * 37) % 200) / 100 - 1) * 3.5 - 0.8;
      const theme = this.currentStage.particleTheme;
      const vy = theme === 'neon_rain' ? -3.2 : theme === 'embers' ? 1.35 : 0.32;
      this.ambientPool.emit(rx, theme === 'neon_rain' ? 4.5 : 0.2, rz, 0.1, vy, 0, s, 1.0, 1.0);
    }

    if (state !== null) {
      for (let i = 0; i < 2; i += 1) {
        const f = state.fighters[i];
        if (f.rageActive && state.tick % 6 === i * 3) {
          this.animators[i].readJointArenaPos(JOINT_WRIST_R, f.x, f.y, f.z, f.facing, this.scratchA);
          this.animators[i].readJointArenaPos(JOINT_CHEST, f.x, f.y, f.z, f.facing, this.scratchB);
          const s = (this.seedCounter += 1);
          this.boltPool.strike(
            this.scratchB[0],
            this.scratchB[1],
            this.scratchB[2],
            this.scratchA[0],
            this.scratchA[1],
            this.scratchA[2],
            s,
            1.35,
            0.85,
          );
        }
      }
    }

    this.sparkPool.update(dt);
    this.dustPool.update(dt);
    this.ambientPool.update(dt);
    this.boltPool.update(dt);
  }

  private applyStageSurfaceParams(): void {
    if (!this.currentStage) return;
    this.renderer.setSurfaceGrain(0.5);
    this.renderer.setSurfaceRelief(0.32, 6.5);
    this.renderer.setSurfaceTextureRelief(0.28);
    this.renderer.setSurfaceReflectivity(this.currentStage.reflectiveFloor ? 0.28 : 0.08);
  }

  renderMatch(state: MatchState, alpha: number): void {
    if (this.currentStage === null) return;
    this.visibleFighterCount = 2;
    const [f0, f1] = state.fighters;

    const x0 = lerp(f0.prevX, f0.x, alpha);
    const y0 = lerp(f0.prevY, f0.y, alpha);
    const z0 = lerp(f0.prevZ, f0.z, alpha);

    const x1 = lerp(f1.prevX, f1.x, alpha);
    const y1 = lerp(f1.prevY, f1.y, alpha);
    const z1 = lerp(f1.prevZ, f1.z, alpha);

    this.poseAndPlaceFighter(0, f0, x0, y0, z0);
    this.poseAndPlaceFighter(1, f1, x1, y1, z1);
    this.updateTekkenCamera(state, x0, y0, z0, x1, y1, z1);

    const aspect = this.canvas.height > 0 ? this.canvas.width / this.canvas.height : 16 / 9;
    this.camera.updateMatrices(aspect);

    const midX = (x0 + x1) * 0.5;
    const midZ = (z0 + z1) * 0.5;
    computeLightMatrix(
      this.env.directionalDir,
      midX,
      0.8,
      midZ,
      11.5,
      this.renderer.shadowMapSize,
      this.lightMatrix,
    );
    this.renderer.beginShadowPass(this.lightMatrix, 'static');
    this.renderer.drawShadowCasters(this.shadowCasters);
    this.renderer.endShadowPass();

    this.renderer.beginFrame(this.skyLinear);
    this.renderer.bindMeshPass(this.camera, this.env);
    this.applyStageSurfaceParams();
    this.renderer.drawSceneCasters(this.sceneCasters);

    if (this.dustPool.particles.count > 0) {
      this.renderer.drawParticles(
        this.dustBatch,
        this.dustPool.particles,
        this.camera,
        this.env,
        this.clockSec,
      );
    }
    if (this.ambientPool.particles.count > 0) {
      this.renderer.drawParticles(
        this.ambientBatch,
        this.ambientPool.particles,
        this.camera,
        this.env,
        this.clockSec,
      );
    }
    if (this.sparkPool.particles.count > 0) {
      this.renderer.drawParticles(
        this.sparkBatch,
        this.sparkPool.particles,
        this.camera,
        this.env,
        this.clockSec,
      );
    }
    if (this.boltPool.segments.count > 0) {
      const core = scaleColor(srgbColor(0.95, 0.96, 1.0), 2.8);
      const edge =
        state.rageFreezeBy !== null || f0.rageActive || f1.rageActive
          ? scaleColor(srgbColor(1.0, 0.14, 0.22), 2.4)
          : scaleColor(srgbColor(0.95, 0.24, 0.28), 2.0);
      this.renderer.drawBolts(
        this.boltBatch,
        this.boltPool.segments,
        this.camera,
        this.env,
        this.clockSec,
        core,
        edge,
        0.055,
        2.2,
      );
    }

    if (this.showHitboxes) {
      this.drawDebugBoxes(f0, x0, y0, z0, f1, x1, y1, z1);
    }

    this.renderer.endFrame();
  }

  /**
   * Renders 3 distinct live 3D Showcase Camera views behind menus:
   * - `'home'`: Dramatic attract view of two fighters squared off inside the 3D Arena
   * - `'arena_preview'`: Unobstructed panoramic fly-around of the selected 3D `.glb` Arena
   * - `'fighter_preview'`: Up-close 3D hero character showcase of Player 1's selected Fighter!
   */
  renderMenuShowcase(
    p1: CharacterData,
    p1Costume: 0 | 1,
    p2: CharacterData,
    p2Costume: 0 | 1,
    stage: StageDefinition,
    mode: MenuShowcaseMode = 'home',
  ): void {
    this.loadStage(stage);
    this.ensureFightersLoaded(p1, p1Costume, p2, p2Costume);

    const aspect = this.canvas.height > 0 ? this.canvas.width / this.canvas.height : 16 / 9;
    const isPortrait = aspect < 0.95;

    if (mode === 'arena_preview') {
      this.visibleFighterCount = 0;
      const pan = Math.sin(this.clockSec * 0.42) * 2.8;
      this.camera.position[0] = pan;
      this.camera.position[1] = 2.45 + Math.cos(this.clockSec * 0.35) * 0.25;
      this.camera.position[2] = isPortrait ? 6.8 : 5.4;
      this.camera.lookAt(pan * 0.25, 1.35, -2.5);
    } else if (mode === 'fighter_preview') {
      this.visibleFighterCount = 1;
      const dummy0 = {
        char: p1,
        state: 'idle',
        stateFrame: 0,
        crouching: false,
        rageActive: false,
        activeMove: null,
        sidestepDir: 0,
        vy: 0,
        juggleHits: 0,
      } as unknown as FighterSim;
      this.animators[0].update(dummy0, this.clockSec);

      // Place P1 hero character cleanly in the open viewport space!
      const heroX = isPortrait ? 0 : 0.72;
      this.fighterNodes[0].setPosition(heroX, 0, 0.4);
      this.fighterNodes[0].setRotationAxisAngle(
        0,
        1,
        0,
        Math.sin(this.clockSec * 0.55) * 0.22 - 0.18,
      );
      this.fighterNodes[0].updateWorld();

      this.camera.position[0] = isPortrait ? Math.sin(this.clockSec * 0.4) * 0.18 : 0.12;
      this.camera.position[1] = isPortrait ? 1.32 : 1.28;
      this.camera.position[2] = isPortrait ? 3.55 : 2.95;
      this.camera.lookAt(
        isPortrait ? 0 : 0.22,
        isPortrait ? 0.72 : 1.02,
        0.4,
      );
    } else {
      // 'home' attract camera: offset fighters slightly right on desktop so left menu never covers them
      this.visibleFighterCount = 2;
      const dummy0 = {
        char: p1,
        state: 'idle',
        stateFrame: 0,
        crouching: false,
        rageActive: false,
        activeMove: null,
        sidestepDir: 0,
        vy: 0,
        juggleHits: 0,
      } as unknown as FighterSim;
      const dummy1 = {
        char: p2,
        state: 'idle',
        stateFrame: 0,
        crouching: false,
        rageActive: false,
        activeMove: null,
        sidestepDir: 0,
        vy: 0,
        juggleHits: 0,
      } as unknown as FighterSim;

      this.animators[0].update(dummy0, this.clockSec);
      this.animators[1].update(dummy1, this.clockSec + 0.7);

      const centerOffset = isPortrait ? 0 : 0.65;
      this.fighterNodes[0].setPosition(centerOffset - 1.25, 0, 0.2);
      this.fighterNodes[0].setRotationAxisAngle(0, 1, 0, Math.PI * 0.36);
      this.fighterNodes[0].updateWorld();

      this.fighterNodes[1].setPosition(centerOffset + 1.25, 0, 0.2);
      this.fighterNodes[1].setRotationAxisAngle(0, 1, 0, -Math.PI * 0.36);
      this.fighterNodes[1].updateWorld();

      const orbit = Math.sin(this.clockSec * 0.3) * 0.55;
      const menuDist = isPortrait ? 4.35 / Math.max(0.48, aspect * 0.88) : 4.25;
      this.camera.position[0] = orbit;
      this.camera.position[1] = 1.55;
      this.camera.position[2] = menuDist;
      this.camera.lookAt(isPortrait ? 0 : 0.35, isPortrait ? 0.92 : 1.12, 0);
    }

    this.camera.updateMatrices(aspect);

    computeLightMatrix(
      this.env.directionalDir,
      0,
      0.8,
      0,
      10,
      this.renderer.shadowMapSize,
      this.lightMatrix,
    );
    this.renderer.beginShadowPass(this.lightMatrix, 'static');
    this.renderer.drawShadowCasters(this.shadowCasters);
    this.renderer.endShadowPass();

    this.renderer.beginFrame(this.skyLinear);
    this.renderer.bindMeshPass(this.camera, this.env);
    this.applyStageSurfaceParams();
    this.renderer.drawSceneCasters(this.sceneCasters);
    if (this.ambientPool.particles.count > 0) {
      this.renderer.drawParticles(
        this.ambientBatch,
        this.ambientPool.particles,
        this.camera,
        this.env,
        this.clockSec,
      );
    }
    this.renderer.endFrame();
  }

  private poseAndPlaceFighter(
    idx: 0 | 1,
    f: FighterSim,
    x: number,
    y: number,
    z: number,
  ): void {
    this.animators[idx].update(f, this.clockSec);
    const node = this.fighterNodes[idx];
    node.setPosition(x, y, z);
    const yaw = f.facing === 1 ? Math.PI * 0.5 : -Math.PI * 0.5;
    node.setRotationAxisAngle(0, 1, 0, yaw);
    node.updateWorld();
  }

  private updateTekkenCamera(
    state: MatchState,
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
  ): void {
    const midX = (x0 + x1) * 0.5;
    const midY = Math.max(y0, y1) * 0.42 + 1.06;
    const midZ = (z0 + z1) * 0.5;
    const sep = Math.hypot(x1 - x0, z1 - z0);

    const aspect = this.canvas.height > 0 ? this.canvas.width / this.canvas.height : 1.77;
    const isPortrait = aspect < 0.95;
    const tanHalfV = Math.tan((this.camera.fovYDeg * 0.5 * Math.PI) / 180);
    const tanHalfH = tanHalfV * Math.max(0.42, aspect);
    const neededHorizZ = (sep * 0.5 + 1.05) / tanHalfH;

    let wantX = midX;
    let wantY = (isPortrait ? 1.85 : 1.62) + clamp((sep - 2.5) * 0.08, 0, 0.45);
    let wantZ = midZ + clamp(Math.max(3.65 + sep * 0.48, neededHorizZ), 3.85, 13.5);
    let targetX = midX;
    let targetY = isPortrait ? midY - 0.55 : midY;
    let targetZ = midZ;

    if (state.phase === 'intro') {
      const t = state.phaseFrame / 95;
      if (t < 0.45) {
        wantX = x0 + 0.9;
        wantY = 1.48;
        wantZ = z0 + 2.05;
        targetX = x0;
        targetY = 1.32;
        targetZ = z0;
      } else if (t < 0.85) {
        wantX = x1 - 0.9;
        wantY = 1.48;
        wantZ = z1 + 2.05;
        targetX = x1;
        targetY = 1.32;
        targetZ = z1;
      }
    }

    if (state.rageFreezeFrames > 0 && state.rageFreezeBy !== null) {
      const rf = state.fighters[state.rageFreezeBy];
      wantX = rf.x + rf.facing * 0.85;
      wantY = 1.38;
      wantZ = rf.z + 1.95;
      targetX = rf.x;
      targetY = 1.28;
      targetZ = rf.z;
    }

    this.camX = damp(this.camX, wantX, 9.5, 1 / 60);
    this.camY = damp(this.camY, wantY, 8.5, 1 / 60);
    this.camZ = damp(this.camZ, wantZ, 9.5, 1 / 60);
    this.lookX = damp(this.lookX, targetX, 12, 1 / 60);
    this.lookY = damp(this.lookY, targetY, 10, 1 / 60);
    this.lookZ = damp(this.lookZ, targetZ, 12, 1 / 60);

    const shakeX =
      this.shakeStrength > 0.002
        ? Math.sin(this.clockSec * 57) * this.shakeStrength
        : 0;
    const shakeY =
      this.shakeStrength > 0.002
        ? Math.cos(this.clockSec * 63) * this.shakeStrength * 0.75
        : 0;

    this.camera.position[0] = this.camX + shakeX;
    this.camera.position[1] = this.camY + shakeY;
    this.camera.position[2] = this.camZ;
    this.camera.lookAt(this.lookX, this.lookY, this.lookZ);
  }

  private drawDebugBoxes(
    f0: FighterSim,
    x0: number,
    y0: number,
    z0: number,
    f1: FighterSim,
    x1: number,
    y1: number,
    z1: number,
  ): void {
    let seg = 0;
    const addSeg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
      if (seg >= 96) return;
      const o = seg * 3;
      this.debugLines.from[o] = ax;
      this.debugLines.from[o + 1] = ay;
      this.debugLines.from[o + 2] = az;
      this.debugLines.to[o] = bx;
      this.debugLines.to[o + 1] = by;
      this.debugLines.to[o + 2] = bz;
      seg += 1;
    };
    const addWireBox = (
      minX: number,
      minY: number,
      minZ: number,
      maxX: number,
      maxY: number,
      maxZ: number,
    ) => {
      addSeg(minX, minY, minZ, maxX, minY, minZ);
      addSeg(maxX, minY, minZ, maxX, minY, maxZ);
      addSeg(maxX, minY, maxZ, minX, minY, maxZ);
      addSeg(minX, minY, maxZ, minX, minY, minZ);
      addSeg(minX, maxY, minZ, maxX, maxY, minZ);
      addSeg(maxX, maxY, minZ, maxX, maxY, maxZ);
      addSeg(maxX, maxY, maxZ, minX, maxY, maxZ);
      addSeg(minX, maxY, maxZ, minX, maxY, minZ);
      addSeg(minX, minY, minZ, minX, maxY, minZ);
      addSeg(maxX, minY, minZ, maxX, maxY, minZ);
      addSeg(maxX, minY, maxZ, maxX, maxY, maxZ);
      addSeg(minX, minY, maxZ, minX, maxY, maxZ);
    };

    const h0 = f0.crouching ? 1.15 : 1.78;
    const h1 = f1.crouching ? 1.15 : 1.78;
    addWireBox(x0 - 0.32, y0, z0 - 0.32, x0 + 0.32, y0 + h0, z0 + 0.32);
    addWireBox(x1 - 0.32, y1, z1 - 0.32, x1 + 0.32, y1 + h1, z1 + 0.32);

    this.debugLines.count = seg;
    this.renderer.drawLines(
      this.debugLineBatch,
      this.debugLines,
      IDENTITY_MAT,
      this.camera,
      this.env,
      srgbColor(0.2, 1.0, 0.55),
      0.018,
      0.85,
      0.2,
      1,
      true,
    );

    seg = 0;
    for (const [f, fx, fy, fz] of [
      [f0, x0, y0, z0],
      [f1, x1, y1, z1],
    ] as const) {
      if (isMoveActive(f) && f.activeMove !== null) {
        const minX = f.facing === 1 ? fx : fx - f.activeMove.reach;
        const maxX = f.facing === 1 ? fx + f.activeMove.reach : fx;
        const hy =
          f.activeMove.height === 'low'
            ? [0.05, 0.55]
            : f.activeMove.height === 'mid'
              ? [0.55, 1.35]
              : [1.15, 1.78];
        addWireBox(
          minX,
          fy + hy[0],
          fz - BASE_HIT_DEPTH,
          maxX,
          fy + hy[1],
          fz + BASE_HIT_DEPTH,
        );
      }
    }
    if (seg > 0) {
      this.debugLines.count = seg;
      this.renderer.drawLines(
        this.debugLineBatch,
        this.debugLines,
        IDENTITY_MAT,
        this.camera,
        this.env,
        srgbColor(1.0, 0.2, 0.25),
        0.025,
        0.95,
        0.2,
        1,
        true,
      );
    }
  }
}

const BONE_PAIRS: readonly [number, number, number][] = [
  [0, 1, 14],
  [1, 2, 16],
  [2, 3, 10],
  [3, 4, 15],
  [2, 5, 11],
  [5, 6, 10],
  [6, 7, 9],
  [2, 8, 11],
  [8, 9, 10],
  [9, 10, 9],
  [0, 11, 13],
  [11, 12, 12],
  [12, 13, 10],
  [0, 14, 13],
  [14, 15, 12],
  [15, 16, 10],
];

class Canvas2dFallbackEngine implements SceneEngineLike {
  readonly canvas: HTMLCanvasElement;
  readonly backend = 'canvas2d' as const;
  readonly backendReason: string;
  readonly quality: QualityPreset;
  showHitboxes = false;

  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly animators: [FighterRigAnimator, FighterRigAnimator] = [
    new FighterRigAnimator(),
    new FighterRigAnimator(),
  ];
  private stage: StageDefinition | null = null;
  private clockSec = 0;
  private flash = 0;
  private readonly pA: Vec3 = [0, 0, 0];
  private readonly pB: Vec3 = [0, 0, 0];

  constructor(canvas: HTMLCanvasElement, quality: QualityPreset, reason: string) {
    this.canvas = canvas;
    this.quality = quality;
    this.backendReason = reason;
    this.ctx = canvas.getContext('2d');
    this.resize();
  }

  resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.floor(window.innerWidth * dpr));
    this.canvas.height = Math.max(1, Math.floor(window.innerHeight * dpr));
  }

  dispose(): void {}

  loadStage(stage: StageDefinition): void {
    this.stage = stage;
  }

  ensureFightersLoaded(): void {}

  consumeCombatEvents(_state: MatchState, events: readonly CombatEvent[]): void {
    for (const ev of events) {
      if (ev.kind === 'hit' || ev.kind === 'counter_hit' || ev.kind === 'launch' || ev.kind === 'ko') {
        this.flash = 1;
      }
    }
  }

  stepEffects(dt: number): void {
    this.clockSec += dt;
    this.flash = Math.max(0, this.flash - dt * 6);
  }

  renderMenuShowcase(
    p1: CharacterData,
    p1Costume: 0 | 1,
    p2: CharacterData,
    p2Costume: 0 | 1,
    stage: StageDefinition,
    mode: MenuShowcaseMode = 'home',
  ): void {
    this.stage = stage;
    const d0 = {
      char: p1,
      costumeIdx: p1Costume,
      x: mode === 'fighter_preview' ? 0 : -1.35,
      y: 0,
      z: 0,
      facing: 1,
      state: 'idle',
      stateFrame: 0,
      crouching: false,
      rageActive: false,
      activeMove: null,
      sidestepDir: 0,
      vy: 0,
      juggleHits: 0,
    } as unknown as FighterSim;
    const d1 = {
      char: p2,
      costumeIdx: p2Costume,
      x: 1.35,
      y: 0,
      z: 0,
      facing: -1,
      state: 'idle',
      stateFrame: 0,
      crouching: false,
      rageActive: false,
      activeMove: null,
      sidestepDir: 0,
      vy: 0,
      juggleHits: 0,
    } as unknown as FighterSim;
    this.drawFrame(d0, mode === 'fighter_preview' ? null : mode === 'arena_preview' ? null : d1, mode !== 'arena_preview');
  }

  renderMatch(state: MatchState): void {
    this.drawFrame(state.fighters[0], state.fighters[1], true);
  }

  private drawFrame(f0: FighterSim, f1: FighterSim | null, showP1: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const w = this.canvas.width;
    const h = this.canvas.height;

    const sky = this.stage?.skyHex ?? '#09090d';
    const fog = this.stage?.fogHex ?? '#160d12';
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, sky);
    grad.addColorStop(0.62, fog);
    grad.addColorStop(1, '#070709');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    const aspect = h > 0 ? w / h : 1.77;
    const camX = f1 ? (f0.x + f1.x) * 0.5 : f0.x;
    const camY = aspect < 0.95 ? 0.95 : 1.35;
    const baseZ = f1 ? 4.6 + Math.abs(f1.x - f0.x) * 0.38 : 3.4;
    const camZ = aspect < 0.95 ? baseZ / Math.max(0.45, aspect * 0.85) : baseZ;
    const fovScale = h * 0.85;

    const project = (wx: number, wy: number, wz: number): [number, number, number] => {
      const dz = Math.max(0.4, camZ - wz);
      const sx = w * 0.5 + ((wx - camX) / dz) * fovScale;
      const sy = h * 0.56 - ((wy - camY) / dz) * fovScale;
      return [sx, sy, fovScale / dz];
    };

    ctx.strokeStyle = 'rgba(220, 20, 40, 0.22)';
    ctx.lineWidth = 1.5;
    for (let gx = -8; gx <= 8; gx += 1) {
      const [x1, y1] = project(gx, 0, -4);
      const [x2, y2] = project(gx, 0, 3);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    for (let gz = -4; gz <= 3; gz += 1) {
      const [x1, y1] = project(-8, 0, gz);
      const [x2, y2] = project(8, 0, gz);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    const drawFighter = (idx: 0 | 1, f: FighterSim) => {
      this.animators[idx].update(f, this.clockSec);
      const c = f.char.costumes[f.costumeIdx ?? 0];
      const [shX, shY, shS] = project(f.x, 0, f.z);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath();
      ctx.ellipse(shX, shY, shS * 0.36, shS * 0.11, 0, 0, Math.PI * 2);
      ctx.fill();

      for (const [jA, jB, thick] of BONE_PAIRS) {
        this.animators[idx].readJointArenaPos(jA, f.x, f.y, f.z, f.facing, this.pA);
        this.animators[idx].readJointArenaPos(jB, f.x, f.y, f.z, f.facing, this.pB);
        const [ax, ay, as] = project(this.pA[0], this.pA[1], this.pA[2]);
        const [bx, by] = project(this.pB[0], this.pB[1], this.pB[2]);
        ctx.strokeStyle = jB === 4 ? c.skin : jA >= 11 ? c.pants : c.top;
        ctx.lineCap = 'round';
        ctx.lineWidth = Math.max(3, (thick / 130) * as);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
      }

      this.animators[idx].readJointArenaPos(4, f.x, f.y, f.z, f.facing, this.pA);
      const [hx, hy, hs] = project(this.pA[0], this.pA[1] + 0.08, this.pA[2]);
      ctx.fillStyle = c.skin;
      ctx.beginPath();
      ctx.arc(hx, hy, Math.max(5, hs * 0.12), 0, Math.PI * 2);
      ctx.fill();
    };

    if (showP1 && f1) {
      if (f0.z <= f1.z) {
        drawFighter(0, f0);
        drawFighter(1, f1);
      } else {
        drawFighter(1, f1);
        drawFighter(0, f0);
      }
    } else if (showP1) {
      drawFighter(0, f0);
    }

    if (this.flash > 0.05) {
      ctx.fillStyle = `rgba(220, 20, 40, ${(this.flash * 0.24).toFixed(2)})`;
      ctx.fillRect(0, 0, w, h);
    }
  }
}
