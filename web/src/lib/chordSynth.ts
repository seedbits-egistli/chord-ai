/**
 * Lightweight Web Audio chord synth (no sample download).
 * Piano = additive harmonics; guitar/uke = plucked-string style decay.
 * Call ensureContext() from a user gesture (click) before playback on mobile.
 */

import { midiToFreq, type PlayInstrument } from './chordVoicing';

export type StrumMode = 'block' | 'strum';

export interface PlayChordOptions {
  instrument: PlayInstrument;
  /** block = all notes together; strum = low→high arpeggio */
  strum: StrumMode;
  volume: number; // 0–1
  durationSec?: number;
  /** AudioContext time; default = now */
  when?: number;
}

type Voice = { stop: (t?: number) => void };

let shared: ChordSynth | null = null;

export function getChordSynth(): ChordSynth {
  if (!shared) shared = new ChordSynth();
  return shared;
}

export class ChordSynth {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private voices: Voice[] = [];
  private volume = 0.65;

  async ensureContext(): Promise<AudioContext> {
    if (!this.ctx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    return this.ctx;
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  setVolume(v: number) {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
    }
  }

  stopAll() {
    const t = this.ctx?.currentTime ?? 0;
    for (const v of this.voices) {
      try {
        v.stop(t);
      } catch {
        /* already stopped */
      }
    }
    this.voices = [];
  }

  /**
   * Play a chord immediately (or at `when`). Returns the scheduled start time
   * in AudioContext seconds.
   */
  async playChord(midiNotes: number[], options: PlayChordOptions): Promise<number> {
    const ctx = await this.ensureContext();
    this.setVolume(options.volume);
    const when = options.when ?? ctx.currentTime + 0.02;
    const dur = options.durationSec ?? 1.2;
    const notes = midiNotes.filter((n) => Number.isFinite(n));
    if (!notes.length) return when;

    const strumGap =
      options.strum === 'strum' && options.instrument !== 'piano' ? 0.035 : 0;

    for (let i = 0; i < notes.length; i++) {
      const t0 = when + i * strumGap;
      const noteDur = Math.max(0.15, dur - i * strumGap * 0.5);
      const voice =
        options.instrument === 'piano'
          ? this.schedulePiano(ctx, notes[i]!, t0, noteDur)
          : this.schedulePluck(ctx, notes[i]!, t0, noteDur, options.instrument);
      this.voices.push(voice);
    }
    return when;
  }

  private schedulePiano(
    ctx: AudioContext,
    midi: number,
    when: number,
    dur: number,
  ): Voice {
    const freq = midiToFreq(midi);
    const gain = ctx.createGain();
    gain.connect(this.master!);
    const partials = [
      { mul: 1, amp: 0.35 },
      { mul: 2, amp: 0.18 },
      { mul: 3, amp: 0.08 },
      { mul: 4, amp: 0.04 },
    ];
    const oscs: OscillatorNode[] = [];
    for (const p of partials) {
      const osc = ctx.createOscillator();
      osc.type = p.mul === 1 ? 'triangle' : 'sine';
      osc.frequency.value = freq * p.mul;
      const g = ctx.createGain();
      g.gain.value = p.amp;
      osc.connect(g);
      g.connect(gain);
      osc.start(when);
      osc.stop(when + dur + 0.05);
      oscs.push(osc);
    }
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(0.9, when + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.35, when + Math.min(0.35, dur * 0.3));
    gain.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    return {
      stop: (t) => {
        const stopAt = t ?? ctx.currentTime;
        try {
          gain.gain.cancelScheduledValues(stopAt);
          gain.gain.setTargetAtTime(0.0001, stopAt, 0.02);
          for (const o of oscs) o.stop(stopAt + 0.05);
        } catch {
          /* ignore */
        }
      },
    };
  }

  /** Plucked string: short noise burst + decaying harmonics (guitar/uke). */
  private schedulePluck(
    ctx: AudioContext,
    midi: number,
    when: number,
    dur: number,
    instrument: 'guitar' | 'ukulele',
  ): Voice {
    const freq = midiToFreq(midi);
    const bright = instrument === 'ukulele' ? 1.15 : 1;
    const out = ctx.createGain();
    out.connect(this.master!);

    const harmonics = instrument === 'ukulele' ? [1, 2, 3, 4] : [1, 2, 3, 4, 5];
    const oscs: OscillatorNode[] = [];
    for (let h = 0; h < harmonics.length; h++) {
      const mul = harmonics[h]!;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq * mul;
      const g = ctx.createGain();
      const amp = (0.28 / mul) * (h === 0 ? 1 : 0.7) * bright;
      g.gain.value = amp;
      // Mild lowpass feel via gain envelope only
      osc.connect(g);
      g.connect(out);
      osc.start(when);
      osc.stop(when + dur + 0.08);
      oscs.push(osc);
    }

    // Attack click (noise)
    const noiseDur = 0.012;
    const noiseBuf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * noiseDur), ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.4;
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.25 * bright, when);
    ng.gain.exponentialRampToValueAtTime(0.0001, when + noiseDur);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = freq * 2;
    bp.Q.value = 2;
    noise.connect(bp);
    bp.connect(ng);
    ng.connect(out);
    noise.start(when);
    noise.stop(when + noiseDur + 0.01);

    out.gain.setValueAtTime(0.0001, when);
    out.gain.exponentialRampToValueAtTime(0.85, when + 0.008);
    out.gain.exponentialRampToValueAtTime(0.25, when + Math.min(0.4, dur * 0.35));
    out.gain.exponentialRampToValueAtTime(0.0001, when + dur);

    return {
      stop: (t) => {
        const stopAt = t ?? ctx.currentTime;
        try {
          out.gain.cancelScheduledValues(stopAt);
          out.gain.setTargetAtTime(0.0001, stopAt, 0.02);
          for (const o of oscs) o.stop(stopAt + 0.05);
          noise.stop(stopAt + 0.01);
        } catch {
          /* ignore */
        }
      },
    };
  }
}
