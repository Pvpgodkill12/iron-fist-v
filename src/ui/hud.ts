import type { CharacterData, MoveData } from '../data/types';
import type { CombatEvent, FighterSim, MatchState } from '../sim/combat';
import type { NumpadDir } from '../sim/inputs';

const DIR_ARROW: Record<NumpadDir, string> = {
  1: '↙',
  2: '↓',
  3: '↘',
  4: '←',
  5: '•',
  6: '→',
  7: '↖',
  8: '↑',
  9: '↗',
};

export class FightHudController {
  private readonly p1Fill: HTMLElement;
  private readonly p1Red: HTMLElement;
  private readonly p2Fill: HTMLElement;
  private readonly p2Red: HTMLElement;
  private readonly p1Name: HTMLElement;
  private readonly p2Name: HTMLElement;
  private readonly p1Style: HTMLElement;
  private readonly p2Style: HTMLElement;
  private readonly p1WinsEl: HTMLElement;
  private readonly p2WinsEl: HTMLElement;
  private readonly timerEl: HTMLElement;
  private readonly stageBadgeEl: HTMLElement;
  private readonly bannerEl: HTMLElement;
  private readonly p1CalloutEl: HTMLElement;
  private readonly p2CalloutEl: HTMLElement;
  private readonly p1ComboEl: HTMLElement;
  private readonly p2ComboEl: HTMLElement;
  private readonly p1BarWrap: HTMLElement;
  private readonly p2BarWrap: HTMLElement;
  private readonly practicePanel: HTMLElement;
  private readonly frameReadoutEl: HTMLElement;
  private readonly inputTapeEl: HTMLElement;
  private readonly touchRageBtn: HTMLElement | null;

  private bannerExpireMs = 0;
  private p1CalloutExpireMs = 0;
  private p2CalloutExpireMs = 0;

  // Cached values to avoid redundant DOM writes at 60fps
  private lastTimerSec = -1;
  private lastP1Hp = -1;
  private lastP2Hp = -1;
  private lastWinsKey = '';

  constructor() {
    const q = (id: string) => {
      const el = document.getElementById(id);
      if (!el) throw new Error(`Missing HUD element #${id}`);
      return el;
    };
    this.p1Fill = q('hud-p1-fill');
    this.p1Red = q('hud-p1-red');
    this.p2Fill = q('hud-p2-fill');
    this.p2Red = q('hud-p2-red');
    this.p1Name = q('hud-p1-name');
    this.p2Name = q('hud-p2-name');
    this.p1Style = q('hud-p1-style');
    this.p2Style = q('hud-p2-style');
    this.p1WinsEl = q('hud-p1-wins');
    this.p2WinsEl = q('hud-p2-wins');
    this.timerEl = q('hud-timer');
    this.stageBadgeEl = q('hud-stage-badge');
    this.bannerEl = q('hud-center-banner');
    this.p1CalloutEl = q('hud-p1-callout');
    this.p2CalloutEl = q('hud-p2-callout');
    this.p1ComboEl = q('hud-p1-combo');
    this.p2ComboEl = q('hud-p2-combo');
    this.p1BarWrap = q('hud-p1-bar');
    this.p2BarWrap = q('hud-p2-bar');
    this.practicePanel = q('practice-panel');
    this.frameReadoutEl = q('practice-frame-data');
    this.inputTapeEl = q('practice-input-tape');
    this.touchRageBtn = document.querySelector('[data-touch-btn="1+2"]');
  }

  bindMatchHeader(state: MatchState, modeLabel: string): void {
    const [f0, f1] = state.fighters;
    this.p1Name.textContent = f0.char.name;
    this.p2Name.textContent = f1.char.name;
    this.p1Style.textContent = f0.char.martialArt;
    this.p2Style.textContent = f1.char.martialArt;
    this.stageBadgeEl.textContent = `${modeLabel} · ${state.config.stage.name}`;
    this.practicePanel.classList.toggle('hidden', !state.config.practiceMode);
    this.lastTimerSec = -1;
    this.lastP1Hp = -1;
    this.lastP2Hp = -1;
    this.lastWinsKey = '';
  }

  pushEvents(events: readonly CombatEvent[]): void {
    const now = performance.now();
    for (let i = 0; i < events.length; i += 1) {
      const ev = events[i];
      if (
        ev.kind === 'round_start' ||
        ev.kind === 'ko' ||
        ev.kind === 'round_win' ||
        ev.kind === 'rage_art_start'
      ) {
        if (ev.text) {
          this.bannerEl.textContent = ev.text;
          this.bannerEl.classList.add('visible');
          this.bannerExpireMs = now + (ev.kind === 'round_win' ? 2400 : 1350);
        }
      } else if (ev.text) {
        const target = ev.by === 0 ? this.p1CalloutEl : this.p2CalloutEl;
        target.textContent = ev.text;
        target.classList.add('visible');
        if (ev.by === 0) this.p1CalloutExpireMs = now + 1150;
        else this.p2CalloutExpireMs = now + 1150;
      }
    }
  }

  update(state: MatchState): void {
    const now = performance.now();
    const [f0, f1] = state.fighters;

    if (this.bannerExpireMs > 0 && now > this.bannerExpireMs) {
      this.bannerEl.classList.remove('visible');
      this.bannerExpireMs = 0;
    }
    if (this.p1CalloutExpireMs > 0 && now > this.p1CalloutExpireMs) {
      this.p1CalloutEl.classList.remove('visible');
      this.p1CalloutExpireMs = 0;
    }
    if (this.p2CalloutExpireMs > 0 && now > this.p2CalloutExpireMs) {
      this.p2CalloutEl.classList.remove('visible');
      this.p2CalloutExpireMs = 0;
    }

    // Health & Red Recoverable Bars
    if (f0.hp !== this.lastP1Hp) {
      this.lastP1Hp = f0.hp;
      const pct = Math.max(0, Math.min(100, (f0.hp / f0.char.maxHp) * 100));
      const redPct = Math.max(pct, Math.min(100, (f0.recoverableHp / f0.char.maxHp) * 100));
      this.p1Fill.style.width = `${pct.toFixed(1)}%`;
      this.p1Red.style.width = `${redPct.toFixed(1)}%`;
    }
    if (f1.hp !== this.lastP2Hp) {
      this.lastP2Hp = f1.hp;
      const pct = Math.max(0, Math.min(100, (f1.hp / f1.char.maxHp) * 100));
      const redPct = Math.max(pct, Math.min(100, (f1.recoverableHp / f1.char.maxHp) * 100));
      this.p2Fill.style.width = `${pct.toFixed(1)}%`;
      this.p2Red.style.width = `${redPct.toFixed(1)}%`;
    }

    this.p1BarWrap.classList.toggle('rage', f0.rageActive);
    this.p2BarWrap.classList.toggle('rage', f1.rageActive);
    if (this.touchRageBtn) {
      this.touchRageBtn.classList.toggle('rage-ready', f0.rageActive && !f0.rageArtUsed);
    }

    // Timer
    const sec = state.config.infiniteTime ? 99 : Math.ceil(state.timerFrames / 60);
    if (sec !== this.lastTimerSec) {
      this.lastTimerSec = sec;
      this.timerEl.textContent = state.config.infiniteTime ? '∞' : String(sec).padStart(2, '0');
      this.timerEl.classList.toggle('danger', !state.config.infiniteTime && sec <= 10);
    }

    // Round Win Crystals
    const winsKey = `${state.wins[0]}:${state.wins[1]}:${state.config.roundsToWin}`;
    if (winsKey !== this.lastWinsKey) {
      this.lastWinsKey = winsKey;
      this.renderCrystals(this.p1WinsEl, state.wins[0], state.config.roundsToWin);
      this.renderCrystals(this.p2WinsEl, state.wins[1], state.config.roundsToWin);
    }

    // Combo Counters
    if (f0.comboCounter >= 2) {
      this.p1ComboEl.textContent = `${f0.comboCounter} HITS · ${f0.comboDamage} DMG`;
      this.p1ComboEl.classList.add('visible');
    } else {
      this.p1ComboEl.classList.remove('visible');
    }

    if (f1.comboCounter >= 2) {
      this.p2ComboEl.textContent = `${f1.comboCounter} HITS · ${f1.comboDamage} DMG`;
      this.p2ComboEl.classList.add('visible');
    } else {
      this.p2ComboEl.classList.remove('visible');
    }

    // Practice Mode Live Frame Data & Input History Tape!
    if (state.config.practiceMode && state.tick % 3 === 0) {
      this.updatePracticeReadout(f0, f1);
    }
  }

  private renderCrystals(container: HTMLElement, won: number, total: number): void {
    let html = '';
    for (let i = 0; i < total; i += 1) {
      html += `<span class="win-gem ${i < won ? 'lit' : ''}"></span>`;
    }
    container.innerHTML = html;
  }

  private updatePracticeReadout(p1: FighterSim, p2: FighterSim): void {
    const m = p1.activeMove;
    const adv =
      p1.lastFrameAdvantage > 0
        ? `+${p1.lastFrameAdvantage}f`
        : `${p1.lastFrameAdvantage}f`;
    const moveInfo = m
      ? `${m.name} (${m.height.toUpperCase()}) · Startup i${m.startup} · Active ${m.active}f · Rec ${m.recovery}f`
      : `State: ${p1.state.toUpperCase()}${p1.crouching ? ' (CROUCH)' : ''}`;
    const dist = Math.hypot(p2.x - p1.x, p2.z - p1.z).toFixed(2);
    this.frameReadoutEl.textContent = `${moveInfo}  |  Frame Adv: ${adv}  |  3D Range: ${dist}m  |  Z-Offset: ${(p1.z - p2.z).toFixed(2)}m`;

    const tape = p1.buffer.tape;
    let tapeHtml = '';
    for (let i = Math.max(0, tape.length - 9); i < tape.length; i += 1) {
      const t = tape[i];
      const btns: string[] = [];
      if (t.buttonMask & 1) btns.push('<b class="b1">1</b>');
      if (t.buttonMask & 2) btns.push('<b class="b2">2</b>');
      if (t.buttonMask & 4) btns.push('<b class="b3">3</b>');
      if (t.buttonMask & 8) btns.push('<b class="b4">4</b>');
      tapeHtml += `<span class="tape-chip">${DIR_ARROW[t.dir]}${btns.join('+')}</span>`;
    }
    this.inputTapeEl.innerHTML = tapeHtml;
  }
}

export function renderCharacterMoveListHtml(char: CharacterData): string {
  const rows: { cmd: string; name: string; height: string; startup: number; dmg: number; tag: string }[] = [];

  const pushMoveChain = (prefixCmd: string, m: MoveData, tag = '') => {
    rows.push({
      cmd: prefixCmd,
      name: m.name,
      height: m.height.toUpperCase(),
      startup: m.startup,
      dmg: m.damage,
      tag:
        tag ||
        [
          m.electric ? '⚡ ELECTRIC' : '',
          m.launch ? '🚀 LAUNCHER' : '',
          m.bound ? '🌪️ TORNADO BOUND' : '',
          m.homing ? '🎯 HOMING' : '',
          m.armor ? '🛡️ POWER CRUSH' : '',
          m.unblockable ? '🔥 UNBLOCKABLE' : '',
          m.knockdown ? '💥 KNOCKDOWN' : '',
        ]
          .filter(Boolean)
          .join(' · '),
    });
    if (m.next) {
      for (const nx of m.next) {
        const bNum = nx.button === 'lp' ? '1' : nx.button === 'rp' ? '2' : nx.button === 'lk' ? '3' : '4';
        pushMoveChain(`${prefixCmd}, ${bNum}`, nx.move);
      }
    }
  };

  pushMoveChain('1 (LP)', char.normals.lp, 'Basic High Jab');
  pushMoveChain('2 (RP)', char.normals.rp, 'Basic Right Strike');
  pushMoveChain('3 (LK)', char.normals.lk, 'Basic Left Kick');
  pushMoveChain('4 (RK)', char.normals.rk, 'Basic Right Kick');

  for (const sp of char.specials) {
    pushMoveChain(sp.move.notation ?? sp.notation, sp.move);
  }

  pushMoveChain('1+3', char.throws[0], '🤼 THROW (Break w/ 1)');
  pushMoveChain('2+4', char.throws[1], '🤼 HEAVY THROW (Break w/ 2)');
  pushMoveChain('1+2', char.powerCrush, '🛡️ ARMORED POWER CRUSH');
  pushMoveChain('3+4', char.kiSpecial, '⚡ KI / HEAT SPECIAL');
  pushMoveChain('1+2 (HP ≤ 25%)', char.rageArt, '🔥 RAGE ART SUPER');

  return rows
    .map(
      (r) => `
      <div class="movelist-row">
        <div class="mv-cmd">${r.cmd}</div>
        <div class="mv-info">
          <div class="mv-name">${r.name} ${r.tag ? `<span class="mv-tag">${r.tag}</span>` : ''}</div>
          <div class="mv-meta">Height: <b>${r.height}</b> · Startup: <b>i${r.startup}</b> · Damage: <b>${r.dmg}</b></div>
        </div>
      </div>`,
    )
    .join('');
}
