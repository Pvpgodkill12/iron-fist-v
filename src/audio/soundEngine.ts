import type { StageDefinition } from '../data/types';
import type { CombatEvent } from '../sim/combat';

/**
 * Self-contained Web Audio combat SFX synthesizer, Arcade Announcer & 5-Stage Procedural BGM Engine!
 * Zero external audio fetches — works 100% offline & in sandboxed previews.
 */
export class TekkenSoundEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private bgmGain: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;

  private bgmTimer: number | null = null;
  private bgmStep = 0;
  private currentBgmStyle: StageDefinition['bgmStyle'] | null = null;

  muted = false;
  bgmVolume = 0.28;
  sfxVolume = 0.72;
  announcerEnabled = true;

  unlock(): void {
    if (this.ctx !== null) {
      if (this.ctx.state === 'suspended') {
        void this.ctx.resume();
      }
      return;
    }
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    this.ctx = ctx;

    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = this.muted ? 0 : 1;
    this.masterGain.connect(ctx.destination);

    this.sfxGain = ctx.createGain();
    this.sfxGain.gain.value = this.sfxVolume;
    this.sfxGain.connect(this.masterGain);

    this.bgmGain = ctx.createGain();
    this.bgmGain.gain.value = this.bgmVolume;
    this.bgmGain.connect(this.masterGain);

    // Pre-generate 0.5s white noise buffer for punches, blocks, thunder & percussion
    const len = Math.floor(ctx.sampleRate * 0.5);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let seed = 987654321;
    for (let i = 0; i < len; i += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      data[i] = (seed / 0xffffffff) * 2 - 1;
    }
    this.noiseBuf = buf;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setValueAtTime(muted ? 0 : 1, this.ctx.currentTime);
    }
  }

  playUiTick(confirm = false): void {
    this.unlock();
    if (!this.ctx || !this.sfxGain || this.muted) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = confirm ? 'sawtooth' : 'triangle';
    osc.frequency.setValueAtTime(confirm ? 520 : 420, t);
    osc.frequency.exponentialRampToValueAtTime(confirm ? 980 : 620, t + (confirm ? 0.14 : 0.05));
    g.gain.setValueAtTime(0.18, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + (confirm ? 0.16 : 0.06));
    osc.connect(g).connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + (confirm ? 0.17 : 0.07));
  }

  announce(phrase: string): void {
    this.playStinger(phrase.includes('FIGHT') || phrase.includes('K.O'));
    if (!this.announcerEnabled || this.muted) return;
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
        const utt = new SpeechSynthesisUtterance(phrase);
        utt.rate = 1.06;
        utt.pitch = 0.68;
        utt.volume = 0.85;
        window.speechSynthesis.speak(utt);
      } catch {
        // Ignore if browser blocks speechSynthesis
      }
    }
  }

  playCombatEvents(events: readonly CombatEvent[]): void {
    if (events.length === 0) return;
    this.unlock();
    for (let i = 0; i < events.length; i += 1) {
      const ev = events[i];
      switch (ev.kind) {
        case 'whiff':
        case 'sidestep_evade':
          this.playWhoosh();
          break;
        case 'hit':
          this.playImpact(ev.power, false);
          break;
        case 'counter_hit':
        case 'whiff_punish':
        case 'launch':
        case 'bound':
          this.playImpact(Math.max(0.85, ev.power), true);
          if (ev.kind === 'counter_hit') this.announce('Counter Hit!');
          else if (ev.kind === 'whiff_punish') this.announce('Punish!');
          break;
        case 'block':
          this.playBlock();
          break;
        case 'electric':
          this.playElectricCrackle();
          break;
        case 'wall_splat':
        case 'throw_slam':
          this.playImpact(1.0, true);
          this.playSubDrop(110, 32, 0.35);
          break;
        case 'throw_break':
          this.playBlock();
          this.playElectricCrackle();
          break;
        case 'rage_activate':
          this.playSubDrop(150, 38, 0.45);
          this.playElectricCrackle();
          break;
        case 'rage_art_start':
          this.playSubDrop(220, 30, 0.65);
          this.playElectricCrackle();
          this.announce('Rage Art!');
          break;
        case 'ko':
          this.playImpact(1.0, true);
          this.playSubDrop(180, 26, 0.85);
          this.announce('K.O.!');
          break;
        case 'round_start':
          if (ev.text) this.announce(ev.text);
          break;
        case 'round_win':
          if (ev.text) this.announce(ev.text);
          break;
      }
    }
  }

  startStageBgm(style: StageDefinition['bgmStyle']): void {
    if (this.currentBgmStyle === style && this.bgmTimer !== null) return;
    this.stopBgm();
    this.currentBgmStyle = style;
    this.bgmStep = 0;

    // 16th-note step sequencer (Tekken 5 arcade synth/breakbeat tempo ~142 BPM)
    const stepMs = style === 'cathedral' ? 125 : style === 'moonlit' ? 106 : 112;
    this.bgmTimer = window.setInterval(() => {
      if (!this.ctx || !this.bgmGain || this.muted || this.ctx.state !== 'running') return;
      this.tickBgmStep(style, this.bgmStep);
      this.bgmStep = (this.bgmStep + 1) % 32;
    }, stepMs);
  }

  stopBgm(): void {
    if (this.bgmTimer !== null) {
      clearInterval(this.bgmTimer);
      this.bgmTimer = null;
    }
    this.currentBgmStyle = null;
  }

  private tickBgmStep(style: StageDefinition['bgmStyle'], step: number): void {
    if (!this.ctx || !this.bgmGain) return;
    const t = this.ctx.currentTime;

    // Scales in Hz (D minor / E Phrygian / C# minor Tekken 5 vibe!)
    const bassScales: Record<StageDefinition['bgmStyle'], number[]> = {
      moonlit: [73.42, 73.42, 87.31, 82.41, 65.41, 65.41, 82.41, 73.42], // D2, F2, E2, C2
      honmaru: [82.41, 82.41, 87.31, 98.0, 82.41, 87.31, 110.0, 82.41], // E2 Phrygian Taiko
      cathedral: [69.3, 69.3, 82.41, 73.42, 65.41, 69.3, 103.83, 92.5], // C#2 Gothic Boss
      dragon: [73.42, 87.31, 98.0, 110.0, 98.0, 87.31, 82.41, 73.42],
      neotokyo: [55.0, 55.0, 65.41, 73.42, 55.0, 82.41, 73.42, 65.41], // A1 Acid D&B
    };

    const leadArp: Record<StageDefinition['bgmStyle'], number[]> = {
      moonlit: [293.66, 349.23, 440.0, 587.33, 523.25, 440.0, 349.23, 329.63],
      honmaru: [329.63, 349.23, 440.0, 493.88, 349.23, 329.63, 293.66, 329.63],
      cathedral: [277.18, 329.63, 415.3, 554.37, 493.88, 415.3, 369.99, 329.63],
      dragon: [293.66, 392.0, 440.0, 587.33, 523.25, 440.0, 392.0, 349.23],
      neotokyo: [220.0, 329.63, 440.0, 523.25, 659.25, 440.0, 392.0, 329.63],
    };

    // Kick on breakbeat pattern
    if (step % 8 === 0 || step % 16 === 10 || (style === 'neotokyo' && step % 8 === 3)) {
      const kOsc = this.ctx.createOscillator();
      const kGain = this.ctx.createGain();
      kOsc.frequency.setValueAtTime(135, t);
      kOsc.frequency.exponentialRampToValueAtTime(38, t + 0.11);
      kGain.gain.setValueAtTime(0.42, t);
      kGain.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
      kOsc.connect(kGain).connect(this.bgmGain);
      kOsc.start(t);
      kOsc.stop(t + 0.14);
    }

    // Snare / Taiko rim on 4 & 12
    if ((step % 8 === 4 || (step % 16 === 15 && style !== 'cathedral')) && this.noiseBuf) {
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      const flt = this.ctx.createBiquadFilter();
      flt.type = 'bandpass';
      flt.frequency.value = style === 'honmaru' ? 520 : 1450;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.22, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
      src.connect(flt).connect(g).connect(this.bgmGain);
      src.start(t);
      src.stop(t + 0.1);
    }

    // Driving Bassline
    if (step % 2 === 0) {
      const note = bassScales[style][Math.floor(step / 4) % 8];
      const bOsc = this.ctx.createOscillator();
      const bFlt = this.ctx.createBiquadFilter();
      const bG = this.ctx.createGain();
      bOsc.type = style === 'cathedral' ? 'sawtooth' : 'square';
      bOsc.frequency.setValueAtTime(note, t);
      bFlt.type = 'lowpass';
      bFlt.frequency.setValueAtTime(style === 'neotokyo' ? 680 : 420, t);
      bG.gain.setValueAtTime(0.18, t);
      bG.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      bOsc.connect(bFlt).connect(bG).connect(this.bgmGain);
      bOsc.start(t);
      bOsc.stop(t + 0.17);
    }

    // Gothic Choir / Synth Lead Arpeggio (signature Moonlit Wilderness & Cathedral vibe!)
    if (step % 2 === 1 || step % 4 === 0) {
      const arpNote = leadArp[style][step % 8];
      const lOsc = this.ctx.createOscillator();
      const lG = this.ctx.createGain();
      lOsc.type = style === 'moonlit' || style === 'cathedral' ? 'triangle' : 'sawtooth';
      lOsc.frequency.setValueAtTime(arpNote, t);
      lG.gain.setValueAtTime(0.09, t);
      lG.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
      lOsc.connect(lG).connect(this.bgmGain);
      lOsc.start(t);
      lOsc.stop(t + 0.24);
    }
  }

  private playWhoosh(): void {
    if (!this.ctx || !this.sfxGain || !this.noiseBuf || this.muted) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const flt = this.ctx.createBiquadFilter();
    flt.type = 'bandpass';
    flt.frequency.setValueAtTime(680, t);
    flt.frequency.exponentialRampToValueAtTime(240, t + 0.09);
    flt.Q.value = 1.8;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.14, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    src.connect(flt).connect(g).connect(this.sfxGain);
    src.start(t);
    src.stop(t + 0.1);
  }

  private playImpact(power: number, heavy: boolean): void {
    if (!this.ctx || !this.sfxGain || !this.noiseBuf || this.muted) return;
    const t = this.ctx.currentTime;

    // Punch sub-body thump
    const osc = this.ctx.createOscillator();
    const og = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(heavy ? 185 : 145, t);
    osc.frequency.exponentialRampToValueAtTime(heavy ? 36 : 48, t + (heavy ? 0.18 : 0.1));
    og.gain.setValueAtTime(0.45 + power * 0.35, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + (heavy ? 0.2 : 0.11));
    osc.connect(og).connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + (heavy ? 0.21 : 0.12));

    // Crisp martial arts skin/bone slap transient
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const flt = this.ctx.createBiquadFilter();
    flt.type = 'bandpass';
    flt.frequency.setValueAtTime(heavy ? 1850 : 1350, t);
    flt.Q.value = 1.1;
    const ng = this.ctx.createGain();
    ng.gain.setValueAtTime(0.32 + power * 0.28, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + (heavy ? 0.13 : 0.07));
    src.connect(flt).connect(ng).connect(this.sfxGain);
    src.start(t);
    src.stop(t + 0.14);
  }

  private playBlock(): void {
    if (!this.ctx || !this.sfxGain || this.muted) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(340, t);
    osc.frequency.exponentialRampToValueAtTime(120, t + 0.07);
    g.gain.setValueAtTime(0.24, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    osc.connect(g).connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + 0.09);
  }

  private playElectricCrackle(): void {
    if (!this.ctx || !this.sfxGain || !this.noiseBuf || this.muted) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const flt = this.ctx.createBiquadFilter();
    flt.type = 'highpass';
    flt.frequency.value = 2400;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.28, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    src.connect(flt).connect(g).connect(this.sfxGain);
    src.start(t);
    src.stop(t + 0.17);
  }

  private playSubDrop(fStart: number, fEnd: number, dur: number): void {
    if (!this.ctx || !this.sfxGain || this.muted) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(fStart, t);
    osc.frequency.exponentialRampToValueAtTime(fEnd, t + dur);
    g.gain.setValueAtTime(0.55, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g).connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private playStinger(dramatic: boolean): void {
    if (!this.ctx || !this.sfxGain || this.muted) return;
    const t = this.ctx.currentTime;
    const freqs = dramatic ? [220, 330, 440] : [196, 293.66];
    for (const f of freqs) {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f, t);
      g.gain.setValueAtTime(0.09, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
      osc.connect(g).connect(this.sfxGain);
      osc.start(t);
      osc.stop(t + 0.34);
    }
  }
}
