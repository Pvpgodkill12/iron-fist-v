import './style.css';
import { startLoop } from '@driftengine/core';
import { ROSTER, getCharacterById } from './data/roster';
import { STAGES, getStageById } from './data/stages';
import type {
  AiDifficulty,
  CharacterData,
  DummyBehavior,
  GameMode,
  StageDefinition,
  StageId,
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
  type QualityPreset,
  type SceneEngineLike,
} from './render/engine';
import { UnifiedInputManager } from './input/controls';
import { TekkenSoundEngine } from './audio/soundEngine';
import { FightHudController, renderCharacterMoveListHtml } from './ui/hud';

type ScreenState = 'title' | 'select' | 'match';

const ARCADE_LADDER_LENGTH = 8;

/**
 * Reliable mobile + desktop button activator.
 * Fires immediately on clean touch `pointerup` (even inside Android bottom-sheet iframes that
 * cancel synthetic `click`) and deduplicates the trailing `click` event.
 */
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
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 22) return;
    const now = performance.now();
    if (now - lastFireMs < 320) return;
    lastFireMs = now;
    handler();
  });

  el.addEventListener('click', () => {
    const now = performance.now();
    if (now - lastFireMs < 320) return;
    lastFireMs = now;
    handler();
  });
}

function bootGame(): void {
  const pill = document.getElementById('engine-pill');
  if (pill) pill.textContent = 'ENGINE READY · TAP QUICK PLAY TO FIGHT!';

  window.addEventListener('error', (ev) => {
    if (pill) pill.textContent = `ERR: ${ev.message}`;
  });

  // Warm combat kernel synchronously (uses WASM when allowed, CSP-safe kernel in restricted iframes)
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
          : '3D CANVAS';
    const kernTag = combatKernelMode === 'wasm' ? 'WASM' : 'CSP-SAFE KERNEL';
    pill.textContent = `${gpuTag} · DRIFTENGINE 4.14 · ${kernTag} · ${scene.quality.toUpperCase()}`;
  };

  const input = new UnifiedInputManager();
  const sound = new TekkenSoundEngine();
  const hud = new FightHudController();
  const cpu = new CpuController();

  // UI Screen Elements
  const screenTitle = document.getElementById('screen-title')!;
  const screenSelect = document.getElementById('screen-select')!;
  const screenHud = document.getElementById('screen-hud')!;
  const mobileTouchLayer = document.getElementById('mobile-touch-layer')!;
  const desktopControlBar = document.getElementById('desktop-control-bar')!;
  const modalPost = document.getElementById('modal-postmatch')!;
  const modalPause = document.getElementById('modal-pause')!;

  // Bind Mobile Virtual Stick + Buttons AND Desktop Clickable Control Bar!
  input.bindMobileDom(
    document.getElementById('touch-stick-zone')!,
    document.getElementById('touch-stick-knob')!,
    document.getElementById('touch-buttons-zone')!,
    desktopControlBar,
  );

  // Unlock Web Audio on first user gesture
  const unlockOnce = () => sound.unlock();
  window.addEventListener('pointerdown', unlockOnce, { passive: true });
  window.addEventListener('keydown', unlockOnce, { passive: true });

  // Persistent Selection & Mode State
  let currentScreen: ScreenState = 'title';
  let gameMode: GameMode = 'arcade';
  let p1Char: CharacterData = ROSTER[0]; // Jinrai Kazama
  let p2Char: CharacterData = ROSTER[1]; // Kazuma Mishima
  let p1Costume: 0 | 1 = 0;
  let p2Costume: 0 | 1 = 0;
  let pickingSlot: 1 | 2 = 1;
  let selectedStage: StageDefinition = STAGES[0];
  let difficulty: AiDifficulty = 2;
  let dummyBehavior: DummyBehavior = 'stand';

  // Arcade Championship Ladder State
  let arcadeStageIdx = 0;
  let arcadeOpponents: CharacterData[] = [];

  // Active Match Simulation State
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
      // Ignore sandbox focus restrictions
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

  // Start async GPU engine creation without blocking any UI buttons!
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
    const btnQual = document.getElementById('btn-toggle-quality');
    if (btnQual) btnQual.textContent = `✨ Graphics: ${scene.quality.toUpperCase()}`;
    updateEnginePill();
    if (currentScreen === 'match') focusStage();
  });

  window.addEventListener('resize', () => {
    scene?.resize();
    syncMobileTouchVisibility();
  });

  function syncMobileTouchVisibility(): void {
    const inActiveFight = currentScreen === 'match' && !paused && !postMatchShown;
    const showTouch = inActiveFight && input.shouldShowTouchControls();
    mobileTouchLayer.classList.toggle('hidden', !showTouch);
    desktopControlBar.classList.toggle('hidden', !inActiveFight || showTouch);
  }

  function showScreen(next: ScreenState): void {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    currentScreen = next;
    screenTitle.classList.toggle('hidden', next !== 'title');
    screenSelect.classList.toggle('hidden', next !== 'select');
    screenHud.classList.toggle('hidden', next !== 'match');
    modalPost.classList.add('hidden');
    modalPause.classList.add('hidden');
    paused = false;
    postMatchShown = false;
    syncMobileTouchVisibility();
    if (next === 'match') {
      requestAnimationFrame(() => focusStage());
    }
  }

  // ==================== POPULATE ROSTER, STAGES & MOVE LIST ====================
  const rosterGrid = document.getElementById('roster-grid')!;
  const stageSelect = document.getElementById('select-stage') as HTMLSelectElement;
  const moveListSelect = document.getElementById('movelist-char-select') as HTMLSelectElement;
  const moveListContainer = document.getElementById('movelist-container')!;

  STAGES.forEach((st) => {
    const opt = document.createElement('option');
    opt.value = st.id;
    opt.textContent = `${st.name} — ${st.subtitle}`;
    stageSelect.appendChild(opt);
  });
  stageSelect.addEventListener('change', () => {
    selectedStage = getStageById(stageSelect.value as StageId);
    sound.playUiTick();
  });

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

  function renderSelectUi(): void {
    document.getElementById('sel-p1-name')!.textContent = p1Char.name;
    document.getElementById('sel-p1-style')!.textContent = `${p1Char.martialArt} · ${p1Char.country}`;
    document.getElementById('sel-p1-stats')!.textContent = `HP ${p1Char.maxHp} · ${p1Char.archetype} · ${p1Char.costumes[p1Costume].label}`;

    document.getElementById('sel-p2-name')!.textContent = p2Char.name;
    document.getElementById('sel-p2-style')!.textContent = `${p2Char.martialArt} · ${p2Char.country}`;
    document.getElementById('sel-p2-stats')!.textContent = `HP ${p2Char.maxHp} · ${p2Char.archetype} · ${p2Char.costumes[p2Costume].label}`;

    document.getElementById('btn-p1-costume')!.textContent = p1Costume === 0 ? 'P1 Outfit' : 'P2 Outfit';
    document.getElementById('btn-p2-costume')!.textContent = p2Costume === 0 ? 'P1 Outfit' : 'P2 Outfit';

    document.getElementById('slot-card-p1')!.classList.toggle('active-slot', pickingSlot === 1);
    document.getElementById('slot-card-p2')!.classList.toggle('active-slot', pickingSlot === 2);
    document.getElementById('btn-pick-slot-p1')!.classList.toggle('selected', pickingSlot === 1);
    document.getElementById('btn-pick-slot-p2')!.classList.toggle('selected', pickingSlot === 2);

    rosterGrid.innerHTML = ROSTER.map((ch) => {
      const isP1 = ch.id === p1Char.id;
      const isP2 = ch.id === p2Char.id;
      const cls = ['roster-tile', isP1 ? 'p1-picked' : '', isP2 ? 'p2-picked' : '']
        .filter(Boolean)
        .join(' ');
      const c0 = ch.costumes[0];
      return `
        <button class="${cls}" data-char-id="${ch.id}">
          <div class="tile-swatch" style="background: linear-gradient(90deg, ${c0.trim}, ${c0.aura})"></div>
          <div class="tile-name">${ch.name}</div>
          <div class="tile-art">${ch.martialArt}</div>
        </button>`;
    }).join('');

    rosterGrid.querySelectorAll<HTMLButtonElement>('[data-char-id]').forEach((tile) => {
      onTap(tile, () => {
        const picked = getCharacterById(tile.dataset.charId!);
        if (pickingSlot === 1) {
          p1Char = picked;
          if (gameMode !== 'arcade') pickingSlot = 2;
        } else {
          p2Char = picked;
        }
        sound.playUiTick();
        renderSelectUi();
      });
    });
  }

  // ==================== BUILD ARCADE CHAMPIONSHIP LADDER ====================
  function buildArcadeLadder(playerChar: CharacterData): CharacterData[] {
    const pool = ROSTER.filter((c) => c.id !== playerChar.id && c.id !== 'jinpachi');
    const shuffled = [...pool];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = shuffled[i];
      shuffled[i] = shuffled[j];
      shuffled[j] = tmp;
    }
    const ladder = shuffled.slice(0, ARCADE_LADDER_LENGTH - 1);
    ladder.push(getCharacterById('jinpachi'));
    return ladder;
  }

  function startBattle(): void {
    sound.unlock();
    cpu.reset();
    input.resetTouch();
    input.setP1SignatureNotation(p1Char.specials[0]?.notation ?? 'f,f+2');

    let opp = p2Char;
    let oppCostume: 0 | 1 = p2Costume;
    let stage = selectedStage;
    let modeLabel = 'FREE BATTLE';

    if (gameMode === 'arcade') {
      opp = arcadeOpponents[arcadeStageIdx];
      oppCostume = arcadeStageIdx % 2 === 1 ? 1 : 0;
      const isBoss = arcadeStageIdx === ARCADE_LADDER_LENGTH - 1;
      stage = isBoss
        ? getStageById('cathedral_retribution')
        : STAGES[arcadeStageIdx % STAGES.length];
      modeLabel = isBoss
        ? 'FINAL STAGE · BOSS'
        : `ARCADE STAGE ${arcadeStageIdx + 1}/${ARCADE_LADDER_LENGTH}`;
    } else if (gameMode === 'vs_cpu') {
      modeLabel = 'VS CPU';
    } else if (gameMode === 'vs_p2') {
      modeLabel = '2P VERSUS';
    } else {
      modeLabel = 'DOJO PRACTICE';
    }

    if (scene) {
      scene.loadStage(stage);
      scene.ensureFightersLoaded(p1Char, p1Costume, opp, oppCostume);
    }

    match = createMatch({
      p1: p1Char,
      p2: opp,
      p1Costume,
      p2Costume: oppCostume,
      stage,
      roundsToWin: 2,
      infiniteTime: gameMode === 'practice',
      practiceMode: gameMode === 'practice',
      dummyBehavior,
      seed: ((Date.now() & 0xfffffff) ^ (arcadeStageIdx * 7919)) >>> 0,
    });

    hud.bindMatchHeader(match, modeLabel);
    refreshMoveList(p1Char.id);
    showScreen('match');
    sound.playUiTick(true);
    sound.startStageBgm(stage.bgmStyle);
    if (gameMode === 'arcade' && arcadeStageIdx === 0) {
      sound.announce('Get ready for the next battle!');
    }
  }

  // ==================== 1-CLICK QUICK PLAY & MENU WIRING ====================
  onTap(document.getElementById('btn-quick-play'), () => {
    gameMode = 'arcade';
    p1Char = ROSTER[0]; // Jinrai Kazama
    arcadeStageIdx = 0;
    arcadeOpponents = buildArcadeLadder(p1Char);
    arcadeOpponents[0] = ROSTER[1]; // Rival battle: Kazuma Mishima!
    selectedStage = STAGES[0]; // Moonlit Wilderness
    startBattle();
  });

  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((btn) => {
    onTap(btn, () => {
      gameMode = btn.dataset.mode as GameMode;
      pickingSlot = 1;
      const modeNames: Record<GameMode, string> = {
        arcade: 'ARCADE CHAMPIONSHIP (8 STAGES)',
        vs_cpu: 'VERSUS CPU BATTLE',
        vs_p2: 'LOCAL 2-PLAYER VERSUS',
        practice: 'DOJO PRACTICE LAB',
      };
      document.getElementById('select-mode-label')!.textContent = modeNames[gameMode];
      document.getElementById('p2-slot-title')!.textContent =
        gameMode === 'vs_p2' ? 'PLAYER 2' : gameMode === 'practice' ? 'TRAINING DUMMY' : 'OPPONENT';
      document.getElementById('difficulty-group')!.classList.toggle('hidden', gameMode === 'vs_p2');

      if (gameMode === 'arcade') {
        arcadeStageIdx = 0;
        arcadeOpponents = buildArcadeLadder(p1Char);
        p2Char = arcadeOpponents[0];
      }
      sound.playUiTick(true);
      renderSelectUi();
      showScreen('select');
    });
  });

  onTap(document.getElementById('btn-select-back'), () => {
    sound.playUiTick();
    sound.stopBgm();
    showScreen('title');
  });

  onTap(document.getElementById('btn-pick-slot-p1'), () => {
    pickingSlot = 1;
    renderSelectUi();
  });
  onTap(document.getElementById('btn-pick-slot-p2'), () => {
    pickingSlot = 2;
    renderSelectUi();
  });

  onTap(document.getElementById('btn-p1-costume'), () => {
    p1Costume = p1Costume === 0 ? 1 : 0;
    sound.playUiTick();
    renderSelectUi();
  });
  onTap(document.getElementById('btn-p2-costume'), () => {
    p2Costume = p2Costume === 0 ? 1 : 0;
    sound.playUiTick();
    renderSelectUi();
  });

  onTap(document.getElementById('btn-random-select'), () => {
    const r = ROSTER[Math.floor(Math.random() * ROSTER.length)];
    if (pickingSlot === 1) p1Char = r;
    else p2Char = r;
    sound.playUiTick();
    renderSelectUi();
  });

  const diffSelect = document.getElementById('select-difficulty') as HTMLSelectElement;
  diffSelect.addEventListener('change', () => {
    difficulty = Number(diffSelect.value) as AiDifficulty;
  });

  onTap(document.getElementById('btn-start-battle'), () => {
    if (gameMode === 'arcade') {
      arcadeStageIdx = 0;
      arcadeOpponents = buildArcadeLadder(p1Char);
    }
    startBattle();
  });

  // Title Footer Buttons
  onTap(document.getElementById('btn-open-controls'), () => {
    openPauseModal('controls', false);
  });

  const btnQuality = document.getElementById('btn-toggle-quality')!;
  btnQuality.textContent = `✨ Graphics: ${initialQuality.toUpperCase()}`;
  onTap(btnQuality, () => {
    if (!scene) return;
    const order: QualityPreset[] = ['high', 'ultra', 'mobile'];
    const next = order[(order.indexOf(scene.quality) + 1) % order.length];
    const activeCanvas = scene.canvas;
    scene.dispose();
    void FightSceneEngine.create(activeCanvas, next).then((nextScene) => {
      scene = nextScene;
      bindCanvasInteractions(scene.canvas);
      btnQuality.textContent = `✨ Graphics: ${next.toUpperCase()}`;
      updateEnginePill();
    });
  });

  const btnMute = document.getElementById('btn-title-mute')!;
  onTap(btnMute, () => {
    sound.setMuted(!sound.muted);
    btnMute.textContent = sound.muted ? '🔇 Audio: MUTED' : '🔊 Audio: ON';
  });

  // HUD Quick Tool Buttons
  onTap(document.getElementById('btn-hud-moves'), () => {
    openPauseModal('moves', true);
  });
  onTap(document.getElementById('btn-hud-pause'), () => {
    openPauseModal('controls', true);
  });
  onTap(document.getElementById('btn-hud-touch'), () => {
    const currentlyShown = !mobileTouchLayer.classList.contains('hidden');
    input.touchOverlayForced = !currentlyShown;
    syncMobileTouchVisibility();
    focusStage();
  });
  onTap(document.getElementById('btn-hud-hitboxes'), () => {
    if (scene) scene.showHitboxes = !scene.showHitboxes;
    focusStage();
  });

  // Practice Panel Controls
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

  // Pause / Move List Modal
  const tabBtnMoves = document.getElementById('tab-btn-moves')!;
  const tabBtnControls = document.getElementById('tab-btn-controls')!;
  const tabMoves = document.getElementById('tab-content-moves')!;
  const tabControls = document.getElementById('tab-content-controls')!;
  const pauseFooter = document.getElementById('pause-match-actions')!;

  function switchModalTab(tab: 'moves' | 'controls'): void {
    tabBtnMoves.classList.toggle('selected', tab === 'moves');
    tabBtnControls.classList.toggle('selected', tab === 'controls');
    tabMoves.classList.toggle('hidden', tab !== 'moves');
    tabControls.classList.toggle('hidden', tab !== 'controls');
  }
  onTap(tabBtnMoves, () => switchModalTab('moves'));
  onTap(tabBtnControls, () => switchModalTab('controls'));

  function openPauseModal(tab: 'moves' | 'controls', inMatch: boolean): void {
    paused = inMatch;
    pauseFooter.classList.toggle('hidden', !inMatch);
    refreshMoveList(p1Char.id);
    switchModalTab(tab);
    modalPause.classList.remove('hidden');
    syncMobileTouchVisibility();
  }

  function closePauseModal(): void {
    paused = false;
    modalPause.classList.add('hidden');
    syncMobileTouchVisibility();
    if (currentScreen === 'match') focusStage();
  }
  onTap(document.getElementById('btn-close-modal'), closePauseModal);
  onTap(document.getElementById('btn-pause-rematch'), () => {
    closePauseModal();
    startBattle();
  });
  onTap(document.getElementById('btn-pause-charselect'), () => {
    closePauseModal();
    sound.stopBgm();
    renderSelectUi();
    showScreen('select');
  });
  onTap(document.getElementById('btn-pause-quit'), () => {
    closePauseModal();
    sound.stopBgm();
    showScreen('title');
  });

  // Post-Match Modal Actions
  const btnPostNext = document.getElementById('btn-post-next')!;
  onTap(btnPostNext, () => {
    modalPost.classList.add('hidden');
    postMatchShown = false;
    if (gameMode === 'arcade') {
      if (match?.roundWinner === 0) {
        if (arcadeStageIdx + 1 < ARCADE_LADDER_LENGTH) {
          arcadeStageIdx += 1;
          startBattle();
        } else {
          sound.stopBgm();
          showScreen('title');
        }
      } else {
        startBattle();
      }
    } else {
      startBattle();
    }
  });
  onTap(document.getElementById('btn-post-select'), () => {
    sound.stopBgm();
    renderSelectUi();
    showScreen('select');
  });
  onTap(document.getElementById('btn-post-title'), () => {
    sound.stopBgm();
    showScreen('title');
  });

  // Global Hotkeys (Escape = Pause, M = Move List, B = 3D Hitbox Debug)
  window.addEventListener('keydown', (e) => {
    if (currentScreen !== 'match') return;
    if (e.code === 'Escape' || e.code === 'KeyP') {
      if (modalPause.classList.contains('hidden')) openPauseModal('controls', true);
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
    syncMobileTouchVisibility();

    const p1Won = state.wins[0] > state.wins[1];
    const postKicker = document.getElementById('post-kicker')!;
    const postTitle = document.getElementById('post-title')!;
    const postSub = document.getElementById('post-subtitle')!;

    if (gameMode === 'arcade') {
      if (p1Won) {
        if (arcadeStageIdx + 1 >= ARCADE_LADDER_LENGTH) {
          postKicker.textContent = 'CHAMPION OF THE IRON FIST TOURNAMENT V!';
          postTitle.textContent = `${p1Char.name} IS UNDEFEATED!`;
          postSub.textContent =
            'Jinpachi Overlord has fallen in the Cathedral of Retribution. You claim the King of Iron Fist V crown!';
          btnPostNext.textContent = '🏆 RETURN IN GLORY';
          sound.announce('Congratulations! You are the King of Iron Fist Champion!');
        } else {
          const nextOpp = arcadeOpponents[arcadeStageIdx + 1];
          const isBossNext = arcadeStageIdx + 1 === ARCADE_LADDER_LENGTH - 1;
          postKicker.textContent = `STAGE ${arcadeStageIdx + 1} CLEARED`;
          postTitle.textContent = `${p1Char.name} ADVANCES!`;
          postSub.textContent = isBossNext
            ? `FINAL STAGE WARNING: ${nextOpp.name} awaits in the Cathedral of Retribution!`
            : `Next Challenger (Stage ${arcadeStageIdx + 2}/${ARCADE_LADDER_LENGTH}): ${nextOpp.name} — ${nextOpp.martialArt}`;
          btnPostNext.textContent = isBossNext ? '⚔️ CHALLENGE JINPACHI →' : 'NEXT CHALLENGER →';
        }
      } else {
        postKicker.textContent = 'DEFEATED';
        postTitle.textContent = 'CONTINUE?';
        postSub.textContent = `${state.fighters[1].char.name} took the match. Rise again and reclaim the tournament!`;
        btnPostNext.textContent = '🔥 REMATCH STAGE →';
      }
    } else {
      const winnerName =
        state.wins[0] === state.wins[1]
          ? 'DRAW MATCH'
          : p1Won
            ? `${state.fighters[0].char.name} WINS!`
            : `${state.fighters[1].char.name} WINS!`;
      postKicker.textContent = `FINAL SCORE: ${state.wins[0]} - ${state.wins[1]}`;
      postTitle.textContent = winnerName;
      postSub.textContent = 'Ready for the next battle?';
      btnPostNext.textContent = '⚔️ REMATCH →';
    }

    modalPost.classList.remove('hidden');
  }

  // ==================== DRIFTENGINE FIXED-STEP 60HZ GAME LOOP ====================
  startLoop({
    simulate(dt) {
      if (currentScreen !== 'match' || match === null) {
        scene?.stepEffects(dt, null);
        return;
      }
      if (paused) return;

      const p1In = input.sampleP1(gameMode === 'vs_p2', match.fighters[0].facing);
      let p2In;
      if (gameMode === 'vs_p2') {
        p2In = input.sampleP2();
      } else if (gameMode === 'practice') {
        p2In = cpu.samplePracticeDummy(match, 1, dummyBehavior, difficulty);
      } else {
        const effectiveDiff =
          gameMode === 'arcade'
            ? (Math.min(4, Math.max(difficulty, 1 + Math.floor(arcadeStageIdx / 2))) as AiDifficulty)
            : difficulty;
        p2In = cpu.sampleCpu(match, 1, effectiveDiff);
      }

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
        scene.renderMenuShowcase(p1Char, p1Costume, p2Char, p2Costume, selectedStage);
        return;
      }
      scene.renderMatch(match, paused ? 1 : alpha);
    },
  });
}

bootGame();
