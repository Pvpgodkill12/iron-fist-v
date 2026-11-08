import {
  createEmptyInput,
  parseNotation,
  type NotationStep,
  type RawInputFrame,
} from '../sim/inputs';

interface MacroPlayback {
  steps: NotationStep[];
  stepIdx: number;
  frameInStep: number;
}

export class UnifiedInputManager {
  private readonly keysDown = new Set<string>();
  private readonly prevKeys = new Set<string>();
  private readonly p1Out: RawInputFrame = createEmptyInput();
  private readonly p2Out: RawInputFrame = createEmptyInput();

  // Mobile Touch Virtual Stick & Buttons State
  private stickPointerId: number | null = null;
  private stickOriginX = 0;
  private stickOriginY = 0;
  private touchDirX: -1 | 0 | 1 = 0;
  private touchDirZ: -1 | 0 | 1 = 0;
  private readonly activeTouchActions = new Map<number, string>();

  // Mouse Canvas Attack Pulse (helps desktop users who click the 3D arena)
  private mousePulseFrames = 0;
  private mousePulseAction: 'lp' | 'rp' | 'lk' | 'rk' = 'lp';
  private mouseComboToggle = 0;

  // One-Button Signature Special / Launcher Macro Playback
  private activeMacro: MacroPlayback | null = null;
  private p1SignatureNotation = 'f,f+2';

  touchOverlayForced: boolean | null = null;
  readonly isTouchCapable: boolean;

  constructor() {
    this.isTouchCapable =
      typeof window !== 'undefined' &&
      ('ontouchstart' in window || navigator.maxTouchPoints > 0);

    if (typeof window !== 'undefined') {
      const GAME_KEYS = new Set([
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'Space',
        'KeyW',
        'KeyA',
        'KeyS',
        'KeyD',
        'KeyU',
        'KeyI',
        'KeyJ',
        'KeyK',
        'KeyZ',
        'KeyX',
        'KeyC',
        'KeyV',
        'KeyQ',
        'KeyE',
        'KeyR',
        'KeyF',
        'KeyG',
        'KeyO',
        'KeyL',
        'KeyY',
        'KeyH',
        'Digit1',
        'Digit2',
        'Digit3',
        'Digit4',
      ]);

      window.addEventListener(
        'keydown',
        (e) => {
          if (
            e.target instanceof HTMLInputElement ||
            e.target instanceof HTMLSelectElement ||
            e.target instanceof HTMLTextAreaElement
          ) {
            return;
          }
          // Prevent Space / Enter / Arrows from scrolling or re-clicking focused HUD buttons!
          if (GAME_KEYS.has(e.code)) {
            if (document.activeElement instanceof HTMLButtonElement) {
              document.activeElement.blur();
            }
            e.preventDefault();
          }
          this.keysDown.add(e.code);
        },
        { passive: false },
      );

      window.addEventListener('keyup', (e) => {
        this.keysDown.delete(e.code);
      });

      window.addEventListener('blur', () => {
        this.keysDown.clear();
        this.prevKeys.clear();
        this.resetTouch();
      });
    }
  }

  setP1SignatureNotation(notation: string): void {
    this.p1SignatureNotation = notation || 'f,f+2';
  }

  triggerSpecialMacro(notation?: string): void {
    const raw = parseNotation(notation ?? this.p1SignatureNotation);
    const expanded: NotationStep[] = [];
    for (let i = 0; i < raw.length; i += 1) {
      if (
        i > 0 &&
        raw[i - 1].dir !== null &&
        raw[i - 1].buttonMask === 0 &&
        raw[i - 1].dir === raw[i].dir
      ) {
        expanded.push({ dir: 5, buttonMask: 0 });
      }
      expanded.push(raw[i]);
    }
    this.activeMacro = { steps: expanded, stepIdx: 0, frameInStep: 0 };
  }

  triggerLauncherMacro(): void {
    // Tekken universal d/f+2 uppercut launcher!
    this.activeMacro = {
      steps: [{ dir: 3, buttonMask: 2 }],
      stepIdx: 0,
      frameInStep: 0,
    };
  }

  shouldShowTouchControls(): boolean {
    if (this.touchOverlayForced !== null) return this.touchOverlayForced;
    return this.isTouchCapable || (typeof window !== 'undefined' && window.innerWidth <= 1024);
  }

  bindCanvasMouse(canvas: HTMLElement, isFighting: () => boolean): void {
    canvas.addEventListener('pointerdown', (e) => {
      window.focus();
      if (canvas instanceof HTMLElement) canvas.focus({ preventScroll: true });
      if (!isFighting()) return;
      // Only trigger mouse attacks for non-touch mouse clicks directly on the 3D stage
      if (e.pointerType === 'mouse') {
        this.mouseComboToggle = (this.mouseComboToggle + 1) % 2;
        if (e.button === 2) {
          this.mousePulseAction = this.mouseComboToggle === 0 ? 'lk' : 'rk';
        } else {
          this.mousePulseAction = this.mouseComboToggle === 0 ? 'lp' : 'rp';
        }
        this.mousePulseFrames = 3;
      }
    });
    canvas.addEventListener('contextmenu', (e) => {
      if (isFighting()) e.preventDefault();
    });
  }

  bindMobileDom(
    stickZone: HTMLElement,
    stickKnob: HTMLElement,
    ...buttonContainers: HTMLElement[]
  ): void {
    const DEADZONE_PX = 12;
    let maxRadiusPx = 44;

    const updateStick = (clientX: number, clientY: number) => {
      const dx = clientX - this.stickOriginX;
      const dy = clientY - this.stickOriginY;
      const dist = Math.hypot(dx, dy);
      const clamped = Math.min(dist, maxRadiusPx);
      const nx = dist > 0.001 ? (dx / dist) * clamped : 0;
      const ny = dist > 0.001 ? (dy / dist) * clamped : 0;
      stickKnob.style.transform = `translate(calc(-50% + ${nx.toFixed(1)}px), calc(-50% + ${ny.toFixed(1)}px))`;

      if (dist < DEADZONE_PX) {
        this.touchDirX = 0;
        this.touchDirZ = 0;
        stickZone.dataset.dirX = '0';
        stickZone.dataset.dirZ = '0';
        return;
      }
      const angle = Math.atan2(-dy, dx); // +Y up
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      this.touchDirX = cos > 0.36 ? 1 : cos < -0.36 ? -1 : 0;
      this.touchDirZ = sin > 0.36 ? 1 : sin < -0.36 ? -1 : 0;
      stickZone.dataset.dirX = String(this.touchDirX);
      stickZone.dataset.dirZ = String(this.touchDirZ);
    };

    stickZone.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      window.focus();
      try {
        stickZone.setPointerCapture(e.pointerId);
      } catch {
        // Ignore synthetic pointer capture edge cases
      }
      const rect = stickZone.getBoundingClientRect();
      maxRadiusPx = Math.max(28, rect.width * 0.34);
      this.stickPointerId = e.pointerId;
      this.stickOriginX = rect.left + rect.width * 0.5;
      this.stickOriginY = rect.top + rect.height * 0.5;
      stickZone.classList.add('active');
      updateStick(e.clientX, e.clientY);
    });

    stickZone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.stickPointerId) return;
      e.preventDefault();
      updateStick(e.clientX, e.clientY);
    });

    const releaseStick = (e: PointerEvent) => {
      if (e.pointerId !== this.stickPointerId) return;
      this.stickPointerId = null;
      this.touchDirX = 0;
      this.touchDirZ = 0;
      stickZone.dataset.dirX = '0';
      stickZone.dataset.dirZ = '0';
      stickZone.classList.remove('active');
      stickKnob.style.transform = 'translate(-50%, -50%)';
    };
    stickZone.addEventListener('pointerup', releaseStick);
    stickZone.addEventListener('pointercancel', releaseStick);

    // Bind all [data-touch-btn] elements across Mobile Overlay & Desktop Quick Bar!
    for (const container of buttonContainers) {
      const buttons = container.querySelectorAll<HTMLElement>('[data-touch-btn]');
      buttons.forEach((btn) => {
        const action = btn.dataset.touchBtn ?? '';
        btn.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          e.stopPropagation();
          window.focus();
          btn.blur();
          try {
            btn.setPointerCapture(e.pointerId);
          } catch {
            // Ignore synthetic pointer capture edge cases
          }
          if (action === 'special') {
            this.triggerSpecialMacro();
          } else if (action === 'launch') {
            this.triggerLauncherMacro();
          } else {
            this.activeTouchActions.set(e.pointerId, action);
          }
          btn.classList.add('pressed');
        });
        const releaseBtn = (e: PointerEvent) => {
          if (this.activeTouchActions.get(e.pointerId) === action) {
            this.activeTouchActions.delete(e.pointerId);
          }
          btn.classList.remove('pressed');
        };
        btn.addEventListener('pointerup', releaseBtn);
        btn.addEventListener('pointercancel', releaseBtn);
        btn.addEventListener('lostpointercapture', releaseBtn);
      });
    }
  }

  resetTouch(): void {
    this.stickPointerId = null;
    this.touchDirX = 0;
    this.touchDirZ = 0;
    this.activeTouchActions.clear();
    this.activeMacro = null;
    this.mousePulseFrames = 0;
  }

  sampleP1(twoPlayerLocal: boolean, p1Facing: 1 | -1 = 1): RawInputFrame {
    const o = this.p1Out;
    o.x = 0;
    o.z = 0;
    o.buttons.lp = false;
    o.buttons.rp = false;
    o.buttons.lk = false;
    o.buttons.rk = false;

    const k = this.keysDown;
    const justPressed = (code: string) => k.has(code) && !this.prevKeys.has(code);

    // Easy 1-Button Signature Special (Q) & Launcher (E) on Keyboard!
    if (justPressed('KeyQ')) {
      this.triggerSpecialMacro();
    } else if (justPressed('KeyE')) {
      this.triggerLauncherMacro();
    }

    // Update prevKeys snapshot
    this.prevKeys.clear();
    for (const code of k) this.prevKeys.add(code);

    // Execute queued Special / Launcher Macro if active
    if (this.activeMacro !== null) {
      const m = this.activeMacro;
      const step = m.steps[m.stepIdx];
      if (step.dir !== null && step.dir !== 5) {
        const fwd =
          step.dir === 3 || step.dir === 6 || step.dir === 9
            ? 1
            : step.dir === 1 || step.dir === 4 || step.dir === 7
              ? -1
              : 0;
        const vert = step.dir >= 7 ? 1 : step.dir <= 3 ? -1 : 0;
        o.x = (fwd * p1Facing) as -1 | 0 | 1;
        o.z = vert as -1 | 0 | 1;
      }
      if (step.buttonMask & 1) o.buttons.lp = true;
      if (step.buttonMask & 2) o.buttons.rp = true;
      if (step.buttonMask & 4) o.buttons.lk = true;
      if (step.buttonMask & 8) o.buttons.rk = true;

      m.frameInStep += 1;
      if (m.frameInStep >= 2) {
        m.stepIdx += 1;
        m.frameInStep = 0;
        if (m.stepIdx >= m.steps.length) {
          this.activeMacro = null;
        }
      }
      return o;
    }

    const left = k.has('KeyA') || (!twoPlayerLocal && k.has('ArrowLeft'));
    const right = k.has('KeyD') || (!twoPlayerLocal && k.has('ArrowRight'));
    const up = k.has('KeyW') || (!twoPlayerLocal && k.has('ArrowUp'));
    const down = k.has('KeyS') || (!twoPlayerLocal && k.has('ArrowDown'));

    if (left && !right) o.x = -1;
    else if (right && !left) o.x = 1;
    if (up && !down) o.z = 1;
    else if (down && !up) o.z = -1;

    // Support ALL natural PC fighter layouts: 1/2/3/4, Z/X/C/V, and U/I/J/K!
    if (
      k.has('KeyU') ||
      k.has('Digit1') ||
      (!twoPlayerLocal && k.has('KeyZ'))
    ) {
      o.buttons.lp = true;
    }
    if (
      k.has('KeyI') ||
      k.has('Digit2') ||
      (!twoPlayerLocal && k.has('KeyX'))
    ) {
      o.buttons.rp = true;
    }
    if (
      k.has('KeyJ') ||
      k.has('Digit3') ||
      (!twoPlayerLocal && k.has('KeyC'))
    ) {
      o.buttons.lk = true;
    }
    if (
      k.has('KeyK') ||
      k.has('Digit4') ||
      (!twoPlayerLocal && k.has('KeyV'))
    ) {
      o.buttons.rk = true;
    }

    // P1 Keyboard Macros: Rage Art / Power Crush (Space, R, O), Ki (L), Throw (F, G, Y)
    if (k.has('KeyO') || k.has('Space') || k.has('KeyR')) {
      o.buttons.lp = true;
      o.buttons.rp = true;
    }
    if (k.has('KeyL')) {
      o.buttons.lk = true;
      o.buttons.rk = true;
    }
    if (k.has('KeyY') || k.has('KeyF')) {
      o.buttons.lp = true;
      o.buttons.lk = true;
    }
    if (k.has('KeyH') || k.has('KeyG')) {
      o.buttons.rp = true;
      o.buttons.rk = true;
    }

    // Mouse Click Attack Pulse on 3D Canvas
    if (this.mousePulseFrames > 0) {
      this.mousePulseFrames -= 1;
      o.buttons[this.mousePulseAction] = true;
    }

    // Mobile Touch Stick & Buttons (and clickable Desktop Quick Bar!)
    if (this.touchDirX !== 0 || this.touchDirZ !== 0) {
      o.x = this.touchDirX;
      o.z = this.touchDirZ;
    }
    for (const act of this.activeTouchActions.values()) {
      switch (act) {
        case 'lp':
          o.buttons.lp = true;
          break;
        case 'rp':
          o.buttons.rp = true;
          break;
        case 'lk':
          o.buttons.lk = true;
          break;
        case 'rk':
          o.buttons.rk = true;
          break;
        case '1+2':
          o.buttons.lp = true;
          o.buttons.rp = true;
          break;
        case '3+4':
          o.buttons.lk = true;
          o.buttons.rk = true;
          break;
        case '1+3':
          o.buttons.lp = true;
          o.buttons.lk = true;
          break;
        case '2+4':
          o.buttons.rp = true;
          o.buttons.rk = true;
          break;
      }
    }

    // Gamepad 0
    this.mergeGamepad(0, o);
    return o;
  }

  sampleP2(): RawInputFrame {
    const o = this.p2Out;
    o.x = 0;
    o.z = 0;
    o.buttons.lp = false;
    o.buttons.rp = false;
    o.buttons.lk = false;
    o.buttons.rk = false;

    const k = this.keysDown;
    const left = k.has('ArrowLeft');
    const right = k.has('ArrowRight');
    const up = k.has('ArrowUp');
    const down = k.has('ArrowDown');

    if (left && !right) o.x = -1;
    else if (right && !left) o.x = 1;
    if (up && !down) o.z = 1;
    else if (down && !up) o.z = -1;

    if (k.has('Numpad4') || k.has('Digit7')) o.buttons.lp = true;
    if (k.has('Numpad8') || k.has('Digit8')) o.buttons.rp = true;
    if (k.has('Numpad1') || k.has('Digit9')) o.buttons.lk = true;
    if (k.has('Numpad2') || k.has('Digit0')) o.buttons.rk = true;

    if (k.has('Numpad6') || k.has('Minus')) {
      o.buttons.lp = true;
      o.buttons.rp = true;
    }
    if (k.has('Numpad3') || k.has('Equal')) {
      o.buttons.lk = true;
      o.buttons.rk = true;
    }
    if (k.has('Numpad7')) {
      o.buttons.lp = true;
      o.buttons.lk = true;
    }
    if (k.has('Numpad9')) {
      o.buttons.rp = true;
      o.buttons.rk = true;
    }

    this.mergeGamepad(1, o);
    return o;
  }

  private mergeGamepad(padIndex: number, out: RawInputFrame): void {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return;
    const pads = navigator.getGamepads();
    const pad = pads[padIndex];
    if (!pad || !pad.connected) return;

    const axX = pad.axes[0] ?? 0;
    const axY = pad.axes[1] ?? 0;
    const dLeft = pad.buttons[14]?.pressed || axX < -0.42;
    const dRight = pad.buttons[15]?.pressed || axX > 0.42;
    const dUp = pad.buttons[12]?.pressed || axY < -0.42;
    const dDown = pad.buttons[13]?.pressed || axY > 0.42;

    if (dLeft && !dRight) out.x = -1;
    else if (dRight && !dLeft) out.x = 1;
    if (dUp && !dDown) out.z = 1;
    else if (dDown && !dUp) out.z = -1;

    if (pad.buttons[2]?.pressed) out.buttons.lp = true;
    if (pad.buttons[3]?.pressed) out.buttons.rp = true;
    if (pad.buttons[0]?.pressed) out.buttons.lk = true;
    if (pad.buttons[1]?.pressed) out.buttons.rk = true;

    if (pad.buttons[5]?.pressed) {
      out.buttons.lp = true;
      out.buttons.rp = true;
    }
    if (pad.buttons[7]?.pressed) {
      out.buttons.lk = true;
      out.buttons.rk = true;
    }
    if (pad.buttons[4]?.pressed) {
      out.buttons.lp = true;
      out.buttons.lk = true;
    }
    if (pad.buttons[6]?.pressed) {
      out.buttons.rp = true;
      out.buttons.rk = true;
    }
  }
}
