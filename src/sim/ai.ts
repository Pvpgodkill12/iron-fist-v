import type { AiDifficulty, DummyBehavior, LimbButton, MoveData } from '../data/types';
import { parseNotation, type NotationStep, type RawInputFrame, createEmptyInput } from './inputs';
import {
  isMoveRecovery,
  isMoveStartup,
  type FighterSim,
  type MatchState,
} from './combat';
import { getCombatWasm, heightToCode } from '../wasm/wasmBridge';

interface QueuedCommand {
  steps: readonly NotationStep[];
  stepIndex: number;
  framesInStep: number;
}

/**
 * WASM-powered CPU Tactician & Practice Dummy Driver.
 * Evaluates all normals, specials, throws, strings, sidesteps, blocks & Rage Arts at 60Hz.
 */
export class CpuController {
  private readonly out: RawInputFrame = createEmptyInput();
  private queue: QueuedCommand | null = null;
  private decisionCooldown = 0;
  private holdBlockFrames = 0;
  private holdCrouchFrames = 0;
  private sidestepTapFrames = 0;
  private sidestepDir: -1 | 1 = 1;
  private lastReactedMove: MoveData | null = null;
  private reactedShouldGuard = false;

  reset(): void {
    this.queue = null;
    this.decisionCooldown = 0;
    this.holdBlockFrames = 0;
    this.holdCrouchFrames = 0;
    this.sidestepTapFrames = 0;
    this.lastReactedMove = null;
    this.reactedShouldGuard = false;
  }

  samplePracticeDummy(
    state: MatchState,
    selfIdx: 0 | 1,
    behavior: DummyBehavior,
    difficulty: AiDifficulty,
  ): RawInputFrame {
    const me = state.fighters[selfIdx];
    const opp = state.fighters[selfIdx === 0 ? 1 : 0];
    this.clearOut();

    if (behavior === 'stand') return this.out;
    if (behavior === 'crouch') {
      this.out.z = -1;
      return this.out;
    }
    if (behavior === 'guard_all') {
      this.out.x = (-me.facing) as -1 | 1;
      if (opp.state === 'attack' && opp.activeMove?.height === 'low') {
        this.out.z = -1;
      }
      return this.out;
    }
    if (behavior === 'sidestep') {
      if (state.tick % 50 === 0) {
        this.sidestepDir = this.sidestepDir === 1 ? -1 : 1;
        this.sidestepTapFrames = 3;
      }
      if (this.sidestepTapFrames > 0) {
        this.sidestepTapFrames -= 1;
        this.out.z = this.sidestepDir;
      }
      return this.out;
    }
    return this.sampleCpu(state, selfIdx, difficulty);
  }

  sampleCpu(
    state: MatchState,
    selfIdx: 0 | 1,
    difficulty: AiDifficulty,
  ): RawInputFrame {
    this.clearOut();
    if (state.phase !== 'fight') return this.out;

    const me = state.fighters[selfIdx];
    const opp = state.fighters[selfIdx === 0 ? 1 : 0];

    // 1. Throw-break reaction based on difficulty (25% Easy -> 85% Tekken God)
    if (me.state === 'thrown' && me.pendingThrow !== null && me.stateFrame === 6) {
      const breakChance = [0, 0.22, 0.45, 0.68, 0.88][difficulty];
      if (state.rng() < breakChance) {
        if (me.pendingThrow.breakMask === 1) this.out.buttons.lp = true;
        else this.out.buttons.rp = true;
      }
      return this.out;
    }

    // 2. Wake-up tech roll on higher difficulties
    if (me.state === 'knockdown' && me.stateFrame === 28 && difficulty >= 2) {
      if (state.rng() < 0.65) {
        this.out.buttons.lp = true;
      }
      return this.out;
    }

    // 3. String follow-up execution!
    if (
      me.state === 'attack' &&
      me.activeMove?.next &&
      me.activeMove.next.length > 0 &&
      me.stateFrame === me.activeMove.startup + me.activeMove.active
    ) {
      const followProb = [0, 0.35, 0.62, 0.8, 0.92][difficulty];
      if (state.rng() < followProb) {
        const pick =
          me.activeMove.next[Math.floor(state.rng() * me.activeMove.next.length)];
        this.pressButton(pick.button);
        return this.out;
      }
    }

    // 4. Execute multi-step queued command (e.g. f,d,d/f+2 EWGF or f,f+2!)
    if (this.queue !== null) {
      const q = this.queue;
      const step = q.steps[q.stepIndex];
      this.applyStepDir(step.dir, me.facing);
      if (step.buttonMask !== 0) {
        this.applyButtonMask(step.buttonMask);
      }
      q.framesInStep += 1;
      if (q.framesInStep >= 2) {
        q.stepIndex += 1;
        q.framesInStep = 0;
        if (q.stepIndex >= q.steps.length) {
          this.queue = null;
          this.decisionCooldown = [0, 20, 12, 6, 3][difficulty];
        }
      }
      return this.out;
    }

    if (me.state !== 'idle' && me.state !== 'walk') {
      return this.out;
    }

    // 5. Ongoing defensive block / crouch / sidestep tap
    if (this.sidestepTapFrames > 0) {
      this.sidestepTapFrames -= 1;
      this.out.z = this.sidestepDir;
      return this.out;
    }

    const distX = Math.abs(opp.x - me.x);
    const distZ = Math.abs(opp.z - me.z);
    const dist3d = Math.hypot(distX, distZ);
    const nearWall = Math.abs(me.x) > state.config.stage.halfWidth - 1.15;

    if (opp.state !== 'attack') {
      this.lastReactedMove = null;
      this.reactedShouldGuard = false;
    }

    // Active Juggle Follow-Up: close gap & convert multi-hit aerial combo!
    if (opp.state === 'juggle' && difficulty >= 1) {
      if (dist3d > 1.38) {
        this.out.x = me.facing;
        return this.out;
      }
      if (opp.y > 0.18 && opp.y < 1.55) {
        if (!opp.boundUsed && opp.juggleHits >= 2 && difficulty >= 2) {
          const boundSpec = me.char.specials.find((s) => s.move.bound);
          if (boundSpec) {
            this.enqueueNotation(boundSpec.notation);
            return this.out;
          }
        }
        if (opp.juggleHits <= 1) {
          this.out.buttons.lp = true;
        } else if (opp.juggleHits === 2) {
          this.out.buttons.lk = true;
        } else {
          this.out.buttons.rk = true;
        }
        this.decisionCooldown = [0, 14, 9, 5, 3][difficulty];
        return this.out;
      }
    }

    // Defensive reaction rolled ONCE per incoming opponent move!
    if (opp.state === 'attack' && opp.activeMove !== null && dist3d < opp.activeMove.reach + 0.55) {
      if (this.holdBlockFrames > 0 && !nearWall) {
        this.holdBlockFrames -= 1;
        this.out.x = (-me.facing) as -1 | 1;
        if (this.holdCrouchFrames > 0) {
          this.holdCrouchFrames -= 1;
          this.out.z = -1;
        }
        return this.out;
      }
      if (this.lastReactedMove !== opp.activeMove) {
        this.lastReactedMove = opp.activeMove;
        const guardSkill = [0, 0.18, 0.36, 0.54, 0.68][difficulty];
        this.reactedShouldGuard = state.rng() < guardSkill;
        if (this.reactedShouldGuard) {
          if (
            difficulty >= 2 &&
            !opp.activeMove.homing &&
            opp.activeMove.startup >= 15 &&
            state.rng() < 0.34
          ) {
            this.sidestepDir = me.z >= 0 ? -1 : 1;
            this.sidestepTapFrames = 3;
            this.out.z = this.sidestepDir;
            return this.out;
          }
          if (!nearWall) {
            this.holdBlockFrames = Math.min(14, opp.activeMove.startup + opp.activeMove.active);
            this.out.x = (-me.facing) as -1 | 1;
            if (opp.activeMove.height === 'low' && state.rng() < guardSkill * 0.72) {
              this.holdCrouchFrames = this.holdBlockFrames;
              this.out.z = -1;
            } else if (opp.activeMove.height === 'high' && difficulty >= 3 && state.rng() < 0.4) {
              this.holdCrouchFrames = 10;
              this.out.z = -1;
            }
            return this.out;
          }
        }
      }
    }

    if (this.decisionCooldown > 0) {
      this.decisionCooldown -= 1;
      if (dist3d > 1.75) {
        this.out.x = me.facing;
      }
      return this.out;
    }

    // Approach if far away (or dash in!)
    if (dist3d > 2.25) {
      if (dist3d < 2.95 && state.rng() < 0.2 * difficulty) {
        for (const sp of me.char.specials) {
          if (sp.notation.startsWith('f,f+')) {
            this.enqueueNotation(sp.notation);
            return this.out;
          }
        }
        this.enqueueNotation('f,f');
        return this.out;
      }
      this.out.x = me.facing;
      return this.out;
    }

    // Rage Art finisher check!
    if (
      me.rageActive &&
      !me.rageArtUsed &&
      distX <= me.char.rageArt.reach - 0.15 &&
      (isMoveStartup(opp) || isMoveRecovery(opp) || opp.state === 'juggle') &&
      state.rng() < 0.35 + difficulty * 0.15
    ) {
      this.out.buttons.lp = true;
      this.out.buttons.rp = true;
      this.decisionCooldown = 20;
      return this.out;
    }

    // Close-range Throw mixup
    if (
      distX < 1.28 &&
      opp.y === 0 &&
      !opp.crouching &&
      (opp.state === 'idle' || opp.state === 'walk' || opp.state === 'blockstun') &&
      state.rng() < 0.08 + difficulty * 0.04
    ) {
      if (state.rng() < 0.5) {
        this.out.buttons.lp = true;
        this.out.buttons.lk = true;
      } else {
        this.out.buttons.rp = true;
        this.out.buttons.rk = true;
      }
      this.decisionCooldown = 18;
      return this.out;
    }

    // Score all candidate Normals & Specials using our WebAssembly Tactical Evaluator!
    const wasm = getCombatWasm();
    const oppStateCode =
      opp.state === 'juggle'
        ? 5
        : opp.state === 'hitstun'
          ? 4
          : opp.state === 'blockstun'
            ? 3
            : isMoveRecovery(opp)
              ? 2
              : isMoveStartup(opp)
                ? 1
                : 0;
    const oppAir = opp.y > 0.1 || opp.state === 'juggle' ? 1 : 0;

    let bestScore = -9999;
    let bestAction: { kind: 'button'; btn: LimbButton } | { kind: 'notation'; notation: string } | null = null;

    const evalCandidate = (
      m: MoveData,
      action: { kind: 'button'; btn: LimbButton } | { kind: 'notation'; notation: string },
    ) => {
      const rngU32 = (state.rng() * 0xffffffff) >>> 0;
      const sc = wasm.score_ai_move(
        dist3d,
        distZ,
        oppStateCode,
        opp.crouching ? 1 : 0,
        oppAir,
        m.reach,
        m.startup,
        m.damage,
        heightToCode(m.height),
        m.launch ? 1 : 0,
        m.homing ? 1 : 0,
        difficulty,
        rngU32,
      );
      if (sc > bestScore) {
        bestScore = sc;
        bestAction = action;
      }
    };

    evalCandidate(me.char.normals.lp, { kind: 'button', btn: 'lp' });
    evalCandidate(me.char.normals.rp, { kind: 'button', btn: 'rp' });
    evalCandidate(me.char.normals.lk, { kind: 'button', btn: 'lk' });
    evalCandidate(me.char.normals.rk, { kind: 'button', btn: 'rk' });

    for (let i = 0; i < me.char.specials.length; i += 1) {
      const sp = me.char.specials[i];
      evalCandidate(sp.move, { kind: 'notation', notation: sp.notation });
    }

    if (bestAction !== null && bestScore > 0) {
      const chosen = bestAction as
        | { kind: 'button'; btn: LimbButton }
        | { kind: 'notation'; notation: string };
      if (chosen.kind === 'button') {
        this.pressButton(chosen.btn);
        this.decisionCooldown = [0, 24, 15, 8, 4][difficulty];
      } else {
        this.enqueueNotation(chosen.notation);
      }
    } else {
      // Micro-spacing: step in toward opponent (never get stranded in Z or corner!)
      if (dist3d > 1.38 || nearWall) {
        this.out.x = me.facing;
      } else if (state.rng() < 0.22) {
        this.sidestepDir = me.z > 0.3 ? -1 : me.z < -0.3 ? 1 : state.rng() < 0.5 ? 1 : -1;
        this.sidestepTapFrames = 3;
        this.out.z = this.sidestepDir;
      }
      this.decisionCooldown = [0, 14, 9, 5, 2][difficulty];
    }

    return this.out;
  }

  private enqueueNotation(notation: string): void {
    const steps = parseNotation(notation);
    // Insert neutral frame between repeated directions like `f,f+2`
    const expanded: NotationStep[] = [];
    for (let i = 0; i < steps.length; i += 1) {
      if (
        i > 0 &&
        steps[i - 1].dir !== null &&
        steps[i - 1].buttonMask === 0 &&
        steps[i - 1].dir === steps[i].dir
      ) {
        expanded.push({ dir: 5, buttonMask: 0 });
      }
      expanded.push(steps[i]);
    }
    this.queue = { steps: expanded, stepIndex: 0, framesInStep: 0 };
  }

  private applyStepDir(dir: number | null, facing: 1 | -1): void {
    if (dir === null || dir === 5) return;
    const fwd = dir === 3 || dir === 6 || dir === 9 ? 1 : dir === 1 || dir === 4 || dir === 7 ? -1 : 0;
    const vert = dir >= 7 ? 1 : dir <= 3 ? -1 : 0;
    this.out.x = (fwd * facing) as -1 | 0 | 1;
    this.out.z = vert as -1 | 0 | 1;
  }

  private pressButton(b: LimbButton): void {
    this.out.buttons[b] = true;
  }

  private applyButtonMask(mask: number): void {
    if (mask & 1) this.out.buttons.lp = true;
    if (mask & 2) this.out.buttons.rp = true;
    if (mask & 4) this.out.buttons.lk = true;
    if (mask & 8) this.out.buttons.rk = true;
  }

  private clearOut(): void {
    this.out.x = 0;
    this.out.z = 0;
    this.out.buttons.lp = false;
    this.out.buttons.rp = false;
    this.out.buttons.lk = false;
    this.out.buttons.rk = false;
  }
}
