import './style.css';
import { startLoop } from '@driftengine/core';
import { ROSTER, getCharacterById } from './data/roster';
import { STAGES } from './data/stages';
import type {
  AiDifficulty,
  CharacterData,
  DummyBehavior,
  StageDefinition,
} from './data/types';
import {
  combatKernelMode,
  getCombatWasm,
  initCombatWasmAsync,
} from './wasm/wasmBridge';
import { createMatch, resetRound, stepMatch, type MatchState } from './sim/combat';
import { CpuController } from './sim/ai';
import {
  FightSceneEngine,
  type MenuShowcaseMode,
  type QualityPreset,
  type SceneEngineLike,
} from './render/engine';
import { UnifiedInputManager } from './input/controls';
import { TekkenSoundEngine } from './audio/soundEngine';
import { FightHudController, renderCharacterMoveListHtml } from './ui/hud';

type ScreenState = 'home' | 'play' | 'arena' | 'fighter' | 'settings' | 'standby' | 'match';
type ActivePlayMode = '1v1' | 'training';
type TouchSettingMode = 'auto' | 'on' | 'off';

function onTap(el: HTMLElement | null, handler: () => void): void {
  if (!el) return;
  let lastFireMs = -1000;
  let downX = 0;
  let downY = 0;

  el.addEventListener(
    'pointerdown',
    (e) => {
      downX = e.clientX;
      downY = e.clientY;
    },
    { passive: true },
  );

  el.addEventListener('pointerup', (e) => {
    if ((el as HTMLButtonElement).disabled) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 22) return;
    const now = performance.now();
    if (now - lastFireMs < 300) return;
    lastFireMs = now;
    handler();
  });

  el.addEventListener('click', () => {
    if ((el as HTMLButtonElement).disabled) return;
    const now = performance.now();
    if (now - lastFireMs < 300) return;
    lastFireMs = now;
    handler();
  });
}

function bootGame(): void {
  const pill = document.getElementById('engine-pill');
  if (pill) pill.textContent = 'RENDERER INITIALIZING';

  window.addEventListener('error', (ev) => {
    if (pill) pill.textContent = `ERROR: ${ev.message}`;
  });

  getCombatWasm();
  void initCombatWasmAsync();

  const initialCanvas = document.querySelector<HTMLCanvasElement>('#stage');
  if (!initialCanvas) throw new Error('Missing #stage canvas');

  const isCompactTouch =
    window.innerWidth <= 900 && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
  const initialQuality: QualityPreset = isCompactTouch ? 'mobile' : 'high';

  let scene: SceneEngineLike | null = null;

  const updateEnginePill = () => {
    if (!scene || !pill) return;
    const gpuTag =
      scene.backend === 'webgpu'
        ? 'WEBGPU'
        : scene.backend === 'webgl2'
          ? 'WEBGL2'
          : 'CANVAS 3D';
    const kernTag = combatKernelMode === 'wasm' ? 'WASM' : 'JS KERNEL';
    pill.textContent = `${gpuTag} // ${kernTag} // ${scene.quality.toUpperCase()}`;
  };

  const input = new UnifiedInputManager();
  const sound = new TekkenSoundEngine();
  const hud = new FightHudController();
  const cpu = new CpuController();

  // Screens & Modals
  const screens: Record<ScreenState, HTMLElement> = {
    home: document.getElementById('screen-home')!,
    play: document.getElementById('screen-play')!,
    arena: document.getElementById('screen-arena')!,
    fighter: document.getElementById('screen-fighter')!,
    settings: document.getElementById('screen-settings')!,
    standby: document.getElementById('screen-standby')!,
    match: document.getElementById('screen-hud')!,
  };

  const mobileTouchLayer = document.getElementById('mobile-touch-layer')!;
  const desktopControlBar = document.getElementById('desktop-control-bar')!;
  const modalExit = document.getElementById('modal-exit')!;
  const modalPost = document.getElementById('modal-postmatch')!;
  const modalPause = document.getElementById('modal-pause')!;

  input.bindMobileDom(
    document.getElementById('touch-stick-zone')!,
    document.getElementById('touch-stick-knob')!,
    document.getElementById('touch-buttons-zone')!,
    desktopControlBar,
  );

  const unlockOnce = () => sound.unlock();
  window.addEventListener('pointerdown', unlockOnce, { passive: true });
  window.addEventListener('keydown', unlockOnce, { passive: true });

  // Game State
  let currentScreen: ScreenState = 'home';
  let activeMode: ActivePlayMode = '1v1';
  let p1Char: CharacterData = ROSTER[0]; // Jinrai Kazama
  let cpuChar: CharacterData = ROSTER[1]; // Kazuma Mishima
  let p1Costume: 0 | 1 = 0;
  let cpuCostume: 0 | 1 = 0;
  let selectedStage: StageDefinition = STAGES[0];
  let difficulty: AiDifficulty = 2;
  let dummyBehavior: DummyBehavior = 'stand';
  let touchMode: TouchSettingMode = 'auto';

  let match: MatchState | null = null;
  let paused = false;
  let postMatchShown = false;

  function focusStage(): void {
    if (document.activeElement instanceof HTMLElement && document.activeElement !== scene?.canvas) {
      document.activeElement.blur();
    }
    try {
      window.focus();
      const c = scene?.canvas ?? document.querySelector<HTMLElement>('#stage');
      c?.focus({ preventScroll: true });
    } catch {
      // Ignore iframe focus restrictions
    }
  }

  function bindCanvasInteractions(canvasEl: HTMLCanvasElement): void {
    canvasEl.tabIndex = 0;
    input.bindCanvasMouse(
      canvasEl,
      () => currentScreen === 'match' && !paused && !postMatchShown,
    );
  }
  bindCanvasInteractions(initialCanvas);

  function syncSettingsQualityUi(q: QualityPreset): void {
    document.querySelectorAll<HTMLButtonElement>('[data-quality]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.quality === q);
    });
  }
  syncSettingsQualityUi(initialQuality);

  void FightSceneEngine.create(initialCanvas, initialQuality).then((createdScene) => {
    scene = createdScene;
    if (scene.canvas !== initialCanvas) {
      bindCanvasInteractions(scene.canvas);
    }
    if (match) {
      scene.loadStage(match.config.stage);
      scene.ensureFightersLoaded(
        match.config.p1,
        match.config.p1Costume,
        match.config.p2,
        match.config.p2Costume,
      );
    }
    syncSettingsQualityUi(scene.quality);
    updateEnginePill();
    if (currentScreen === 'match') focusStage();
  });

  function shouldShowMobileTouch(): boolean {
    if (touchMode === 'on') return true;
    if (touchMode === 'off') return false;
    return input.shouldShowTouchControls();
  }

  function syncHudControlOverlays(): void {
    const inActiveFight = currentScreen === 'match' && !paused && !postMatchShown;
    const showTouch = inActiveFight && shouldShowMobileTouch();
    mobileTouchLayer.classList.toggle('hidden', !showTouch);
    desktopControlBar.classList.toggle('hidden', !inActiveFight || showTouch);
  }

  window.addEventListener('resize', () => {
    scene?.resize();
    syncHudControlOverlays();
  });

  function showScreen(next: ScreenState): void {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    currentScreen = next;
    (Object.keys(screens) as ScreenState[]).forEach((key) => {
      screens[key].classList.toggle('hidden', key !== next);
    });
    modalExit.classList.add('hidden');
    modalPost.classList.add('hidden');
    modalPause.classList.add('hidden');
    paused = false;
    postMatchShown = false;
    syncHudControlOverlays();
    if (next === 'match') {
      requestAnimationFrame(() => focusStage());
    }
  }

  // ==================== POPULATE ARENA SELECT & FIGHTER ROSTER ====================
  const arenaGrid = document.getElementById('arena-grid')!;
  const rosterGrid = document.getElementById('roster-grid')!;
  const moveListSelect = document.getElementById('movelist-char-select') as HTMLSelectElement;
  const moveListContainer = document.getElementById('movelist-container')!;

  ROSTER.forEach((ch) => {
    const opt = document.createElement('option');
    opt.value = ch.id;
    opt.textContent = `${ch.name} (${ch.martialArt})`;
    moveListSelect.appendChild(opt);
  });

  function refreshMoveList(charId: string): void {
    const ch = getCharacterById(charId);
    moveListSelect.value = ch.id;
    moveListContainer.innerHTML = renderCharacterMoveListHtml(ch);
  }
  moveListSelect.addEventListener('change', () => refreshMoveList(moveListSelect.value));
  refreshMoveList(p1Char.id);

  function renderArenaSelectUi(): void {
    document.getElementById('arena-preview-title')!.textContent = selectedStage.name;
    document.getElementById('arena-preview-sub')!.textContent = selectedStage.subtitle;

    arenaGrid.innerHTML = STAGES.map((st, idx) => {
      const sel = st.id === selectedStage.id ? 'selected' : '';
      return `
        <button class="arena-card ${sel}" data-stage-idx="${idx}">
          <div class="arena-card-num">ARENA 0${idx + 1}</div>
          <div class="arena-card-name">${st.name}</div>
        </button>`;
    }).join('');

    arenaGrid.querySelectorAll<HTMLButtonElement>('[data-stage-idx]').forEach((card) => {
      onTap(card, () => {
        const idx = Number(card.dataset.stageIdx);
        selectedStage = STAGES[idx] ?? STAGES[0];
        sound.playUiTick();
        renderArenaSelectUi();
      });
    });
  }

  function renderFighterSelectUi(): void {
    document.getElementById('fighter-arena-tag')!.textContent = `ARENA: ${selectedStage.name}`;
    document.getElementById('sel-p1-name')!.textContent = p1Char.name;
    document.getElementById('sel-p1-style')!.textContent = `${p1Char.martialArt} // ${p1Char.country}`;
    document.getElementById('sel-p1-stats')!.textContent = `HP ${p1Char.maxHp} // ${p1Char.archetype}`;
    document.getElementById('btn-p1-costume')!.textContent =
      p1Costume === 0 ? 'OUTFIT 1' : 'OUTFIT 2';

    rosterGrid.innerHTML = ROSTER.map((ch) => {
      const sel = ch.id === p1Char.id ? 'selected' : '';
      return `
        <button class="roster-tile ${sel}" data-char-id="${ch.id}">
          <div class="tile-name">${ch.name}</div>
          <div class="tile-art">${ch.martialArt}</div>
        </button>`;
    }).join('');

    rosterGrid.querySelectorAll<HTMLButtonElement>('[data-char-id]').forEach((tile) => {
      onTap(tile, () => {
        p1Char = getCharacterById(tile.dataset.charId!);
        sound.playUiTick();
        renderFighterSelectUi();
      });
    });
  }

  function pickRandomCpuOpponent(excludeId: string): { char: CharacterData; costume: 0 | 1 } {
    const pool = ROSTER.filter((c) => c.id !== excludeId);
    const chosen = pool[Math.floor(Math.random() * pool.length)] ?? ROSTER[1];
    const costume: 0 | 1 = Math.random() < 0.5 ? 0 : 1;
    return { char: chosen, costume };
  }

  function startMatch(mode: ActivePlayMode): void {
    activeMode = mode;
    sound.unlock();
    cpu.reset();
    input.resetTouch();

    let player = p1Char;
    let playerCostume: 0 | 1 = p1Costume;
    let opp = cpuChar;
    let oppCostume: 0 | 1 = cpuCostume;
    let stage = selectedStage;
    let modeLabel = '1V1 BATTLE';

    if (mode === 'training') {
      // Default Training Mode setup (Jinrai vs Kazuma Dummy in Hon-Maru Sanctuary)
      player = ROSTER[0];
      playerCostume = 0;
      opp = ROSTER[1];
      oppCostume = 0;
      stage = STAGES[1]; // Hon-Maru Sanctuary
      modeLabel = 'TRAINING';
    } else {
      // 1v1: Player's chosen Arena & Fighter vs Random CPU Fighter!
      const rnd = pickRandomCpuOpponent(player.id);
      opp = rnd.char;
      oppCostume = rnd.costume;
      cpuChar = opp;
      cpuCostume = oppCostume;
      modeLabel = '1V1 VS CPU';
    }

    input.setP1SignatureNotation(player.specials[0]?.notation ?? 'f,f+2');

    if (scene) {
      scene.loadStage(stage);
      scene.ensureFightersLoaded(player, playerCostume, opp, oppCostume);
    }

    match = createMatch({
      p1: player,
      p2: opp,
      p1Costume: playerCostume,
      p2Costume: oppCostume,
      stage,
      roundsToWin: 2,
      infiniteTime: mode === 'training',
      practiceMode: mode === 'training',
      dummyBehavior,
      seed: (Date.now() & 0xfffffff) >>> 0,
    });

    hud.bindMatchHeader(match, modeLabel);
    refreshMoveList(player.id);
    showScreen('match');
    sound.playUiTick(true);
    sound.startStageBgm(stage.bgmStyle);
  }

  // ==================== 1. HOME SCREEN WIRING (PLAY / SETTINGS / EXIT) ====================
  onTap(document.getElementById('btn-home-play'), () => {
    sound.playUiTick(true);
    showScreen('play');
  });

  onTap(document.getElementById('btn-home-settings'), () => {
    sound.playUiTick();
    showScreen('settings');
  });

  onTap(document.getElementById('btn-home-exit'), () => {
    sound.playUiTick();
    modalExit.classList.remove('hidden');
  });

  onTap(document.getElementById('btn-exit-cancel'), () => {
    sound.playUiTick();
    modalExit.classList.add('hidden');
  });

  onTap(document.getElementById('btn-exit-confirm'), () => {
    sound.stopBgm();
    modalExit.classList.add('hidden');
    try {
      window.close();
    } catch {
      // Standard browser tabs disallow window.close(); enter clean attract standby
    }
    showScreen('standby');
  });

  onTap(screens.standby, () => {
    sound.playUiTick(true);
    showScreen('home');
  });

  // ==================== 2. PLAY SUB-MENU (1V1 / MULTIPLAYER [GREYED] / TRAINING) ====================
  onTap(document.getElementById('btn-play-back'), () => {
    sound.playUiTick();
    showScreen('home');
  });

  onTap(document.getElementById('btn-mode-1v1'), () => {
    sound.playUiTick(true);
    renderArenaSelectUi();
    showScreen('arena');
  });

  onTap(document.getElementById('btn-mode-training'), () => {
    startMatch('training');
  });

  // ==================== 3. ARENA SELECT (STEP 1 OF 1V1) ====================
  onTap(document.getElementById('btn-arena-back'), () => {
    sound.playUiTick();
    showScreen('play');
  });

  onTap(document.getElementById('btn-arena-confirm'), () => {
    sound.playUiTick(true);
    renderFighterSelectUi();
    showScreen('fighter');
  });

  // ==================== 4. FIGHTER SELECT (STEP 2 OF 1V1 + 3D PREVIEW) ====================
  onTap(document.getElementById('btn-fighter-back'), () => {
    sound.playUiTick();
    renderArenaSelectUi();
    showScreen('arena');
  });

  onTap(document.getElementById('btn-p1-costume'), () => {
    p1Costume = p1Costume === 0 ? 1 : 0;
    sound.playUiTick();
    renderFighterSelectUi();
  });

  onTap(document.getElementById('btn-start-1v1'), () => {
    startMatch('1v1');
  });

  // ==================== 5. SETTINGS SCREEN WIRING ====================
  onTap(document.getElementById('btn-settings-back'), () => {
    sound.playUiTick();
    showScreen('home');
  });

  document.querySelectorAll<HTMLButtonElement>('[data-quality]').forEach((btn) => {
    onTap(btn, () => {
      const targetQ = btn.dataset.quality as QualityPreset;
      if (!scene || scene.quality === targetQ) return;
      sound.playUiTick();
      const activeCanvas = scene.canvas;
      scene.dispose();
      void FightSceneEngine.create(activeCanvas, targetQ).then((nextScene) => {
        scene = nextScene;
        bindCanvasInteractions(scene.canvas);
        syncSettingsQualityUi(scene.quality);
        updateEnginePill();
      });
    });
  });

  const btnAudioOn = document.getElementById('btn-audio-on')!;
  const btnAudioOff = document.getElementById('btn-audio-off')!;
  onTap(btnAudioOn, () => {
    sound.setMuted(false);
    btnAudioOn.classList.add('active');
    btnAudioOff.classList.remove('active');
    sound.playUiTick();
  });
  onTap(btnAudioOff, () => {
    sound.setMuted(true);
    btnAudioOff.classList.add('active');
    btnAudioOn.classList.remove('active');
  });

  document.querySelectorAll<HTMLButtonElement>('[data-diff]').forEach((btn) => {
    onTap(btn, () => {
      difficulty = Number(btn.dataset.diff) as AiDifficulty;
      document.querySelectorAll<HTMLButtonElement>('[data-diff]').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
      sound.playUiTick();
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-touchmode]').forEach((btn) => {
    onTap(btn, () => {
      touchMode = btn.dataset.touchmode as TouchSettingMode;
      document.querySelectorAll<HTMLButtonElement>('[data-touchmode]').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
      sound.playUiTick();
      syncHudControlOverlays();
    });
  });

  onTap(document.getElementById('btn-settings-commands'), () => {
    openPauseModal('controls', false);
  });

  // ==================== IN-MATCH HUD, PAUSE & POST-MATCH ====================
  onTap(document.getElementById('btn-hud-moves'), () => {
    openPauseModal('moves', true);
  });
  onTap(document.getElementById('btn-hud-pause'), () => {
    openPauseModal('moves', true);
  });
  onTap(document.getElementById('btn-hud-hitboxes'), () => {
    if (scene) scene.showHitboxes = !scene.showHitboxes;
    focusStage();
  });

  const dummySelect = document.getElementById('select-dummy') as HTMLSelectElement;
  dummySelect.addEventListener('change', () => {
    dummyBehavior = dummySelect.value as DummyBehavior;
    if (match) match.config.dummyBehavior = dummyBehavior;
    focusStage();
  });
  onTap(document.getElementById('btn-practice-rage'), () => {
    if (!match) return;
    const f0 = match.fighters[0];
    f0.rageActive = !f0.rageActive;
    f0.rageArtUsed = false;
    f0.hp = f0.rageActive ? Math.floor(f0.char.maxHp * 0.22) : f0.char.maxHp;
    focusStage();
  });
  onTap(document.getElementById('btn-practice-reset'), () => {
    if (!match) return;
    resetRound(match, 1);
    focusStage();
  });

  const tabBtnMoves = document.getElementById('tab-btn-moves')!;
  const tabBtnControls = document.getElementById('tab-btn-controls')!;
  const tabMoves = document.getElementById('tab-content-moves')!;
  const tabControls = document.getElementById('tab-content-controls')!;
  const pauseFooter = document.getElementById('pause-match-actions')!;

  function switchModalTab(tab: 'moves' | 'controls'): void {
    tabBtnMoves.classList.toggle('active', tab === 'moves');
    tabBtnControls.classList.toggle('active', tab === 'controls');
    tabMoves.classList.toggle('hidden', tab !== 'moves');
    tabControls.classList.toggle('hidden', tab !== 'controls');
  }
  onTap(tabBtnMoves, () => switchModalTab('moves'));
  onTap(tabBtnControls, () => switchModalTab('controls'));

  function openPauseModal(tab: 'moves' | 'controls', inMatch: boolean): void {
    paused = inMatch;
    document.getElementById('pause-modal-title')!.textContent = inMatch ? 'PAUSED' : 'GUIDE';
    document.getElementById('btn-close-modal')!.textContent = inMatch ? 'RESUME' : 'CLOSE';
    pauseFooter.classList.toggle('hidden', !inMatch);
    refreshMoveList(match ? match.fighters[0].char.id : p1Char.id);
    switchModalTab(tab);
    modalPause.classList.remove('hidden');
    syncHudControlOverlays();
  }

  function closePauseModal(): void {
    paused = false;
    modalPause.classList.add('hidden');
    syncHudControlOverlays();
    if (currentScreen === 'match') focusStage();
  }
  onTap(document.getElementById('btn-close-modal'), closePauseModal);

  onTap(document.getElementById('btn-pause-rematch'), () => {
    closePauseModal();
    startMatch(activeMode);
  });
  onTap(document.getElementById('btn-pause-charselect'), () => {
    closePauseModal();
    sound.stopBgm();
    renderFighterSelectUi();
    showScreen('fighter');
  });
  onTap(document.getElementById('btn-pause-quit'), () => {
    closePauseModal();
    sound.stopBgm();
    showScreen('home');
  });

  // Post-Match Actions
  onTap(document.getElementById('btn-post-rematch'), () => {
    modalPost.classList.add('hidden');
    postMatchShown = false;
    startMatch(activeMode);
  });
  onTap(document.getElementById('btn-post-fighter'), () => {
    sound.stopBgm();
    renderFighterSelectUi();
    showScreen('fighter');
  });
  onTap(document.getElementById('btn-post-home'), () => {
    sound.stopBgm();
    showScreen('home');
  });

  window.addEventListener('keydown', (e) => {
    if (currentScreen === 'standby') {
      showScreen('home');
      return;
    }
    if (currentScreen !== 'match') return;
    if (e.code === 'Escape' || e.code === 'KeyP') {
      if (modalPause.classList.contains('hidden')) openPauseModal('moves', true);
      else closePauseModal();
    } else if (e.code === 'KeyM' && modalPause.classList.contains('hidden')) {
      openPauseModal('moves', true);
    } else if (e.code === 'KeyB' && scene) {
      scene.showHitboxes = !scene.showHitboxes;
    }
  });

  function checkMatchCompletion(state: MatchState): void {
    if (state.phase !== 'match_over' || postMatchShown || state.phaseFrame < 95) return;
    postMatchShown = true;
    syncHudControlOverlays();

    const p1Won = state.wins[0] > state.wins[1];
    document.getElementById('post-kicker')!.textContent = p1Won ? 'VICTORY' : 'DEFEAT';
    document.getElementById('post-title')!.textContent =
      state.wins[0] === state.wins[1]
        ? 'DRAW GAME'
        : p1Won
          ? `${state.fighters[0].char.name} WINS`
          : `${state.fighters[1].char.name} WINS`;
    document.getElementById('post-subtitle')!.textContent =
      `ROUND SCORE  ${state.wins[0]} - ${state.wins[1]}`;

    modalPost.classList.remove('hidden');
  }

  // ==================== FIXED-STEP 60HZ GAME LOOP ====================
  startLoop({
    simulate(dt) {
      if (currentScreen !== 'match' || match === null) {
        scene?.stepEffects(dt, null);
        return;
      }
      if (paused) return;

      const p1In = input.sampleP1(false, match.fighters[0].facing);
      const p2In =
        activeMode === 'training'
          ? cpu.samplePracticeDummy(match, 1, dummyBehavior, difficulty)
          : cpu.sampleCpu(match, 1, difficulty);

      stepMatch(match, p1In, p2In);

      if (match.events.length > 0) {
        scene?.consumeCombatEvents(match, match.events);
        sound.playCombatEvents(match.events);
        hud.pushEvents(match.events);
        match.events.length = 0;
      }

      scene?.stepEffects(dt, match);
      hud.update(match);
      checkMatchCompletion(match);
    },

    render(alpha) {
      if (!scene) return;
      if (currentScreen !== 'match' || match === null) {
        const showcaseMode: MenuShowcaseMode =
          currentScreen === 'arena'
            ? 'arena_preview'
            : currentScreen === 'fighter'
              ? 'fighter_preview'
              : 'home';
        scene.renderMenuShowcase(
          p1Char,
          p1Costume,
          cpuChar,
          cpuCostume,
          selectedStage,
          showcaseMode,
        );
        return;
      }
      scene.renderMatch(match, paused ? 1 : alpha);
    },
  });
}

bootGame();
