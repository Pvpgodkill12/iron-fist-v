import './style.css';
import { startLoop } from '@driftengine/core';
import { ROSTER, getCharacterById } from './data/roster';
import { STAGES, getStageById } from './data/stages';
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
import {
  OnlineCoordinator,
  type OnlineCharSelectState,
  type OnlineVoteState,
} from './net/onlineCoordinator';
import { RollbackNetSession } from './net/rollbackSession';

type ScreenState =
  | 'home'
  | 'play'
  | 'arena'
  | 'fighter'
  | 'mp_vote'
  | 'mp_fighter'
  | 'settings'
  | 'standby'
  | 'match';
type ActivePlayMode = '1v1' | 'training' | 'online';
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
  const online = new OnlineCoordinator();

  // Screens & Modals
  const screens: Record<ScreenState, HTMLElement> = {
    home: document.getElementById('screen-home')!,
    play: document.getElementById('screen-play')!,
    arena: document.getElementById('screen-arena')!,
    fighter: document.getElementById('screen-fighter')!,
    mp_vote: document.getElementById('screen-mp-vote')!,
    mp_fighter: document.getElementById('screen-mp-fighter')!,
    settings: document.getElementById('screen-settings')!,
    standby: document.getElementById('screen-standby')!,
    match: document.getElementById('screen-hud')!,
  };

  const mobileTouchLayer = document.getElementById('mobile-touch-layer')!;
  const desktopControlBar = document.getElementById('desktop-control-bar')!;
  const modalExit = document.getElementById('modal-exit')!;
  const modalPost = document.getElementById('modal-postmatch')!;
  const modalPause = document.getElementById('modal-pause')!;
  const hudNetPill = document.getElementById('hud-net-pill')!;

  const homeOnlinePill = document.getElementById('home-online-pill')!;
  const btnModeMulti = document.getElementById('btn-mode-multi') as HTMLButtonElement;
  const multiLockTag = document.getElementById('multi-lock-tag')!;
  const multiSeekingBar = document.getElementById('multi-seeking-bar')!;
  const challengeToast = document.getElementById('online-challenge-toast')!;
  const challengeDesc = document.getElementById('challenge-toast-desc')!;

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
  let p1Char: CharacterData = ROSTER[0];
  let cpuChar: CharacterData = ROSTER[1];
  let p1Costume: 0 | 1 = 0;
  let cpuCostume: 0 | 1 = 0;
  let selectedStage: StageDefinition = STAGES[0];
  let difficulty: AiDifficulty = 2;
  let dummyBehavior: DummyBehavior = 'stand';
  let touchMode: TouchSettingMode = 'auto';

  let match: MatchState | null = null;
  let rollback: RollbackNetSession | null = null;
  let onlineSlot: 0 | 1 = 0;
  let paused = false;
  let postMatchShown = false;

  // Online character select local working state
  let mpMyCharId = 'jinrai';
  let mpMyCostume: 0 | 1 = 0;
  let mpMyLocked = false;

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
    hudNetPill.classList.toggle('hidden', !(currentScreen === 'match' && activeMode === 'online'));
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

  // ==================== ONLINE STATUS & CHALLENGE TOAST WIRING ====================
  function syncOnlineStatusUi(): void {
    const ready = online.isMultiplayerReady();
    const count = online.getActivePlayerCount();
    const ping = online.getBestOpponentPingMs();
    const room = online.currentRoom;

    btnModeMulti.disabled = !ready;
    btnModeMulti.setAttribute('aria-disabled', String(!ready));
    btnModeMulti.classList.toggle('is-disabled', !ready);
    btnModeMulti.classList.toggle('online-ready', ready);

    if (ready) {
      multiLockTag.textContent = ping > 0 ? `ACTIVE · ${ping}ms` : `${count} ACTIVE · READY`;
      homeOnlinePill.textContent =
        ping > 0
          ? `ONLINE (${room}): ${count} ACTIVE · P2P ${ping}ms READY`
          : `ONLINE (${room}): ${count} PLAYERS ACTIVE · MULTIPLAYER UNLOCKED`;
      homeOnlinePill.classList.add('ready');
    } else {
      multiLockTag.textContent = `${count} ACTIVE · WAITING`;
      homeOnlinePill.textContent = online.isRelayConnected()
        ? `ONLINE (${room}): ${count} ACTIVE · OPEN ON 2ND DEVICE TO UNLOCK`
        : `ONLINE (${room}): CONNECTING P2P RELAY...`;
      homeOnlinePill.classList.remove('ready');
    }

    multiSeekingBar.classList.toggle('hidden', online.lobbyPhase !== 'seeking');
  }

  online.onStatusChange = syncOnlineStatusUi;
  syncOnlineStatusUi();

  online.onIncomingInvite = (_fromPeerId, pingMs) => {
    if (currentScreen === 'match' && activeMode === 'online') return;
    challengeDesc.textContent =
      pingMs > 0
        ? `Active player wants to fight! (Ping ~${pingMs}ms)`
        : 'Active player wants to fight!';
    challengeToast.classList.remove('hidden');
    sound.playUiTick(true);
  };

  online.onInviteCleared = () => {
    challengeToast.classList.add('hidden');
  };

  onTap(document.getElementById('btn-challenge-accept'), () => {
    challengeToast.classList.add('hidden');
    sound.playUiTick(true);
    online.acceptIncomingInvite();
  });

  onTap(document.getElementById('btn-challenge-decline'), () => {
    challengeToast.classList.add('hidden');
    sound.playUiTick();
    online.declineIncomingInvite();
  });

  onTap(btnModeMulti, () => {
    if (!online.isMultiplayerReady()) return;
    sound.playUiTick(true);
    online.clickMultiplayer();
    syncOnlineStatusUi();
  });

  onTap(document.getElementById('btn-multi-cancel-seek'), () => {
    sound.playUiTick();
    online.cancelSeekingOrSession();
    syncOnlineStatusUi();
  });

  const roomInput = document.getElementById('input-room-code') as HTMLInputElement;
  onTap(document.getElementById('btn-room-apply'), () => {
    sound.playUiTick();
    online.setRoomCode(roomInput.value);
    roomInput.value = online.currentRoom;
    syncOnlineStatusUi();
  });
  roomInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      online.setRoomCode(roomInput.value);
      roomInput.value = online.currentRoom;
      roomInput.blur();
      syncOnlineStatusUi();
    }
  });

  // ==================== ONLINE STEP 1: RANDOM 2-MAP VOTE UI ====================
  const mpVoteCards = document.getElementById('mp-vote-cards')!;
  const mpVoteTimer = document.getElementById('mp-vote-timer')!;
  const mpVoteBanner = document.getElementById('mp-vote-banner')!;

  function renderOnlineVoteUi(vs: OnlineVoteState): void {
    if (currentScreen !== 'mp_vote') {
      sound.stopBgm();
      showScreen('mp_vote');
    }

    mpVoteTimer.textContent = `${vs.secondsLeft}s`;
    const myVote = vs.votes[vs.localSlot];
    const oppSlot: 0 | 1 = vs.localSlot === 0 ? 1 : 0;
    const oppVote = vs.votes[oppSlot];

    // Preview whichever map we voted for (or winning map, or Option A) in live 3D!
    const previewIdx = vs.winningMapIdx ?? myVote ?? 0;
    selectedStage = getStageById(vs.mapOptions[previewIdx]);

    if (vs.winningMapIdx !== null) {
      const wonStage = getStageById(vs.mapOptions[vs.winningMapIdx]);
      mpVoteBanner.textContent = vs.wasTiebreaker
        ? `1 - 1 TIEBREAKER WINNER: ${wonStage.name}!`
        : `UNANIMOUS ARENA SELECTED: ${wonStage.name}!`;
    } else if (myVote !== null && oppVote === null) {
      mpVoteBanner.textContent = 'VOTE LOCKED — WAITING FOR OPPONENT TO VOTE...';
    } else if (myVote === null && oppVote !== null) {
      mpVoteBanner.textContent = 'OPPONENT HAS VOTED — PICK YOUR ARENA!';
    } else {
      mpVoteBanner.textContent = 'CLICK ONE OF THE 2 RANDOM ARENAS TO CAST YOUR VOTE';
    }

    mpVoteCards.innerHTML = ([0, 1] as const)
      .map((optIdx) => {
        const st = getStageById(vs.mapOptions[optIdx]);
        const isMy = myVote === optIdx;
        const isOpp = oppVote === optIdx;
        const isWin = vs.winningMapIdx === optIdx;
        return `
          <button class="mp-vote-card ${isMy ? 'my-vote' : ''} ${isWin ? 'winner-card' : ''}" data-vote-opt="${optIdx}">
            <div class="mp-vote-opt">RANDOM OPTION 0${optIdx + 1}</div>
            <div class="mp-vote-name">${st.name}</div>
            <div class="mp-vote-sub">${st.subtitle}</div>
            <div class="mp-vote-pills">
              ${isMy ? `<span class="vote-chip">YOU (P${vs.localSlot + 1})</span>` : ''}
              ${isOpp ? `<span class="vote-chip opp">OPPONENT (P${oppSlot + 1})</span>` : ''}
            </div>
          </button>`;
      })
      .join('');

    mpVoteCards.querySelectorAll<HTMLButtonElement>('[data-vote-opt]').forEach((card) => {
      onTap(card, () => {
        if (vs.winningMapIdx !== null) return;
        const choice = Number(card.dataset.voteOpt) as 0 | 1;
        sound.playUiTick(true);
        online.submitMapVote(choice);
      });
    });
  }

  online.onVoteStateUpdate = renderOnlineVoteUi;

  onTap(document.getElementById('btn-mp-vote-leave'), () => {
    sound.playUiTick();
    online.cancelSeekingOrSession();
    showScreen('play');
  });

  // ==================== ONLINE STEP 2: SYNCED CHARACTER SELECT UI ====================
  const mpRosterGrid = document.getElementById('mp-roster-grid')!;
  const btnMpLock = document.getElementById('btn-mp-lock-fighter') as HTMLButtonElement;
  const btnMpCostume = document.getElementById('btn-mp-costume') as HTMLButtonElement;

  function renderOnlineCharSelectUi(cs: OnlineCharSelectState): void {
    if (currentScreen !== 'mp_fighter') {
      mpMyCharId = cs.picks[cs.localSlot].charId;
      mpMyCostume = cs.picks[cs.localSlot].costume;
      mpMyLocked = cs.picks[cs.localSlot].locked;
      showScreen('mp_fighter');
    }

    selectedStage = getStageById(cs.stageId);
    const ch0 = getCharacterById(cs.picks[0].charId);
    const ch1 = getCharacterById(cs.picks[1].charId);

    // Sync live 3D Showcase fighters so both P1 & P2 models face off inside the voted 3D Arena!
    p1Char = ch0;
    p1Costume = cs.picks[0].costume;
    cpuChar = ch1;
    cpuCostume =
      ch0.id === ch1.id && cs.picks[0].costume === cs.picks[1].costume
        ? cs.picks[0].costume === 0
          ? 1
          : 0
        : cs.picks[1].costume;

    document.getElementById('mp-fighter-arena-tag')!.textContent = `VOTED ARENA: ${selectedStage.name}`;
    document.getElementById('mp-p1-role')!.textContent =
      cs.localSlot === 0 ? 'PLAYER 1 (YOU)' : 'PLAYER 1 (OPPONENT)';
    document.getElementById('mp-p2-role')!.textContent =
      cs.localSlot === 1 ? 'PLAYER 2 (YOU)' : 'PLAYER 2 (OPPONENT)';

    document.getElementById('mp-p1-name')!.textContent = ch0.name;
    document.getElementById('mp-p1-style')!.textContent = `${ch0.martialArt} // ${ch0.country}`;
    const p1ReadyEl = document.getElementById('mp-p1-ready')!;
    p1ReadyEl.textContent = cs.picks[0].locked ? 'LOCKED IN' : 'SELECTING...';
    p1ReadyEl.classList.toggle('locked', cs.picks[0].locked);

    document.getElementById('mp-p2-name')!.textContent = ch1.name;
    document.getElementById('mp-p2-style')!.textContent = `${ch1.martialArt} // ${ch1.country}`;
    const p2ReadyEl = document.getElementById('mp-p2-ready')!;
    p2ReadyEl.textContent = cs.picks[1].locked ? 'LOCKED IN' : 'SELECTING...';
    p2ReadyEl.classList.toggle('locked', cs.picks[1].locked);

    const ping = online.getBestOpponentPingMs();
    document.getElementById('mp-ping-badge')!.textContent =
      ping > 0 ? `P2P ${ping}ms` : 'P2P LINKED';

    const myPick = cs.picks[cs.localSlot];
    btnMpCostume.textContent = myPick.costume === 0 ? 'MY OUTFIT 1' : 'MY OUTFIT 2';
    btnMpLock.textContent = myPick.locked ? 'READY (UNLOCK)' : 'LOCK IN FIGHTER';

    mpRosterGrid.innerHTML = ROSTER.map((ch) => {
      const isP1 = cs.picks[0].charId === ch.id;
      const isP2 = cs.picks[1].charId === ch.id;
      const cls = `${isP1 ? 'selected' : ''} ${isP2 ? 'p2-selected' : ''}`;
      return `
        <button class="roster-tile ${cls}" data-mp-char="${ch.id}">
          <div class="cursor-badges">
            ${isP1 ? '<span class="cursor-tag">P1</span>' : ''}
            ${isP2 ? '<span class="cursor-tag p2">P2</span>' : ''}
          </div>
          <div class="tile-name">${ch.name}</div>
          <div class="tile-art">${ch.martialArt}</div>
        </button>`;
    }).join('');

    mpRosterGrid.querySelectorAll<HTMLButtonElement>('[data-mp-char]').forEach((tile) => {
      onTap(tile, () => {
        if (mpMyLocked) return;
        mpMyCharId = tile.dataset.mpChar!;
        sound.playUiTick();
        online.updateMyCharacterSelection(mpMyCharId, mpMyCostume, false);
      });
    });
  }

  online.onCharSelectUpdate = renderOnlineCharSelectUi;

  onTap(btnMpCostume, () => {
    if (mpMyLocked) return;
    mpMyCostume = mpMyCostume === 0 ? 1 : 0;
    sound.playUiTick();
    online.updateMyCharacterSelection(mpMyCharId, mpMyCostume, false);
  });

  onTap(btnMpLock, () => {
    mpMyLocked = !mpMyLocked;
    sound.playUiTick(true);
    online.updateMyCharacterSelection(mpMyCharId, mpMyCostume, mpMyLocked);
  });

  onTap(document.getElementById('btn-mp-fighter-leave'), () => {
    sound.playUiTick();
    online.cancelSeekingOrSession();
    showScreen('play');
  });

  // ==================== LAUNCH SYNCED ONLINE ROLLBACK MATCH ====================
  online.onMatchLaunch = (params) => {
    activeMode = 'online';
    onlineSlot = params.localSlot;
    sound.unlock();
    input.resetTouch();

    const p1 = getCharacterById(params.p1CharId);
    const p2 = getCharacterById(params.p2CharId);
    const stage = getStageById(params.stageId);

    p1Char = p1;
    p1Costume = params.p1Costume;
    cpuChar = p2;
    cpuCostume = params.p2Costume;
    selectedStage = stage;

    const myChar = onlineSlot === 0 ? p1 : p2;
    input.setP1SignatureNotation(myChar.specials[0]?.notation ?? 'f,f+2');

    if (scene) {
      scene.loadStage(stage);
      scene.ensureFightersLoaded(p1, params.p1Costume, p2, params.p2Costume);
    }

    match = createMatch({
      p1,
      p2,
      p1Costume: params.p1Costume,
      p2Costume: params.p2Costume,
      stage,
      roundsToWin: 2,
      seed: params.seed,
    });

    rollback = new RollbackNetSession(match, onlineSlot, 1);
    online.onUdpFrame = (bytes) => rollback?.receivePacket(bytes);

    document.getElementById('btn-post-rematch')!.querySelector('.blade-label')!.textContent =
      'REMATCH';
    hud.bindMatchHeader(match, `ONLINE P${onlineSlot + 1}`);
    refreshMoveList(myChar.id);
    showScreen('match');
    sound.playUiTick(true);
    sound.startStageBgm(stage.bgmStyle);
  };

  online.onRematchStatus = (myReady, oppReady) => {
    const lbl = document.getElementById('btn-post-rematch')?.querySelector('.blade-label');
    if (lbl) {
      const count = (myReady ? 1 : 0) + (oppReady ? 1 : 0);
      lbl.textContent = myReady
        ? `REMATCH (${count}/2 READY...)`
        : oppReady
          ? 'ACCEPT REMATCH (1/2)'
          : 'REMATCH';
    }
  };

  online.onReturnToCharSelect = () => {
    sound.stopBgm();
    rollback = null;
  };

  online.onOpponentLeft = () => {
    if (activeMode === 'online') {
      sound.stopBgm();
      rollback = null;
      match = null;
      showScreen('play');
      syncOnlineStatusUi();
    }
  };

  // ==================== POPULATE OFFLINE ARENA SELECT & FIGHTER ROSTER ====================
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

  function startMatch(mode: '1v1' | 'training'): void {
    activeMode = mode;
    rollback = null;
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
      player = ROSTER[0];
      playerCostume = 0;
      opp = ROSTER[1];
      oppCostume = 0;
      stage = STAGES[1];
      modeLabel = 'TRAINING';
    } else {
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

    document.getElementById('btn-post-rematch')!.querySelector('.blade-label')!.textContent =
      'REMATCH';
    hud.bindMatchHeader(match, modeLabel);
    refreshMoveList(player.id);
    showScreen('match');
    sound.playUiTick(true);
    sound.startStageBgm(stage.bgmStyle);
  }

  // ==================== 1. HOME SCREEN WIRING (PLAY / SETTINGS / EXIT) ====================
  onTap(document.getElementById('btn-home-play'), () => {
    sound.playUiTick(true);
    syncOnlineStatusUi();
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

  // ==================== 2. PLAY SUB-MENU ====================
  onTap(document.getElementById('btn-play-back'), () => {
    sound.playUiTick();
    online.cancelSeekingOrSession();
    showScreen('home');
  });

  onTap(document.getElementById('btn-mode-1v1'), () => {
    sound.playUiTick(true);
    online.cancelSeekingOrSession();
    renderArenaSelectUi();
    showScreen('arena');
  });

  onTap(document.getElementById('btn-mode-training'), () => {
    online.cancelSeekingOrSession();
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
    if (!match || activeMode === 'online') return;
    const f0 = match.fighters[0];
    f0.rageActive = !f0.rageActive;
    f0.rageArtUsed = false;
    f0.hp = f0.rageActive ? Math.floor(f0.char.maxHp * 0.22) : f0.char.maxHp;
    focusStage();
  });
  onTap(document.getElementById('btn-practice-reset'), () => {
    if (!match || activeMode === 'online') return;
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
    document.getElementById('pause-modal-title')!.textContent =
      inMatch && activeMode === 'online' ? 'ONLINE MENU (LIVE)' : inMatch ? 'PAUSED' : 'GUIDE';
    document.getElementById('btn-close-modal')!.textContent = inMatch ? 'RESUME' : 'CLOSE';
    pauseFooter.classList.toggle('hidden', !inMatch);
    document
      .getElementById('btn-pause-rematch')!
      .classList.toggle('hidden', activeMode === 'online');
    const myIdx = activeMode === 'online' ? onlineSlot : 0;
    refreshMoveList(match ? match.fighters[myIdx].char.id : p1Char.id);
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
    if (activeMode === 'online') return;
    closePauseModal();
    startMatch(activeMode);
  });
  onTap(document.getElementById('btn-pause-charselect'), () => {
    closePauseModal();
    sound.stopBgm();
    if (activeMode === 'online') {
      online.requestReturnToOnlineCharSelect();
    } else {
      renderFighterSelectUi();
      showScreen('fighter');
    }
  });
  onTap(document.getElementById('btn-pause-quit'), () => {
    closePauseModal();
    sound.stopBgm();
    if (activeMode === 'online') {
      online.cancelSeekingOrSession();
      rollback = null;
    }
    showScreen('home');
  });

  // Post-Match Actions
  onTap(document.getElementById('btn-post-rematch'), () => {
    if (activeMode === 'online') {
      sound.playUiTick(true);
      online.requestOnlineRematch();
      return;
    }
    modalPost.classList.add('hidden');
    postMatchShown = false;
    startMatch(activeMode);
  });
  onTap(document.getElementById('btn-post-fighter'), () => {
    sound.stopBgm();
    if (activeMode === 'online') {
      online.requestReturnToOnlineCharSelect();
      return;
    }
    renderFighterSelectUi();
    showScreen('fighter');
  });
  onTap(document.getElementById('btn-post-home'), () => {
    sound.stopBgm();
    if (activeMode === 'online') {
      online.cancelSeekingOrSession();
      rollback = null;
    }
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

    const myIdx = activeMode === 'online' ? onlineSlot : 0;
    const oppIdx = myIdx === 0 ? 1 : 0;
    const iWon = state.wins[myIdx] > state.wins[oppIdx];
    const p1Won = state.wins[0] > state.wins[1];

    document.getElementById('post-kicker')!.textContent =
      state.wins[0] === state.wins[1] ? 'DRAW' : iWon ? 'VICTORY' : 'DEFEAT';
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

      if (activeMode === 'online' && rollback !== null) {
        // Live Online Rollback Netcode NEVER freezes on local modal open!
        const myFacing = match.fighters[onlineSlot].facing;
        const localIn = paused
          ? { x: 0 as const, z: 0 as const, buttons: { lp: false, rp: false, lk: false, rk: false } }
          : input.sampleP1(false, myFacing);

        const netEvents = rollback.step(match, localIn, (pkt) => online.sendUdpInputPacket(pkt));
        if (netEvents.length > 0) {
          scene?.consumeCombatEvents(match, netEvents);
          sound.playCombatEvents(netEvents);
          hud.pushEvents(netEvents);
        }

        if (match.tick % 10 === 0) {
          const ping = online.getBestOpponentPingMs();
          const linkTag = online.isDirectP2PActive() ? 'P2P UDP' : 'P2P RELAY';
          const pingStr = ping > 0 ? `${ping}ms` : 'SYNC';
          hudNetPill.textContent = `${linkTag} · ${pingStr} · RB ${rollback.lastRollbackDepth}F`;
        }

        scene?.stepEffects(dt, match);
        hud.update(match);
        checkMatchCompletion(match);
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
          currentScreen === 'arena' || currentScreen === 'mp_vote'
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
      scene.renderMatch(match, paused && activeMode !== 'online' ? 1 : alpha);
    },
  });
}

bootGame();
