/**
 * Melody playback with sampled acoustic grand piano (FluidR3_GM via gleitz/midi-js-soundfonts, CC-BY 3.0).
 * Glides use playbackRate ramps (continuous pitch), not a staircase of short notes.
 */
export interface SynthNote { start: number; end: number; midi: number; glideTo?: number }
const NAMES = ['C', 'Eb', 'Gb', 'A'];
const SAMPLE_MIDI: { midi: number; file: string }[] = [];
for (let o = 2; o <= 6; o++) NAMES.forEach((n, i) => SAMPLE_MIDI.push({ midi: 12 * (o + 1) + i * 3, file: `${n}${o}.mp3` }));
SAMPLE_MIDI.push({ midi: 96, file: 'C7.mp3' });

export class MelodySynth {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private buffers = new Map<number, AudioBuffer>();
  private loading: Promise<void> | null = null;
  private timer = 0;
  private scheduled = new Set<number>();
  private live: AudioBufferSourceNode[] = [];
  volume = 0.8;
  constructor(private audio: HTMLAudioElement, private getNotes: () => SynthNote[]) {}
  load(): Promise<void> {
    this.ctx ??= new AudioContext();
    this.gain ??= this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
    this.loading ??= Promise.all(SAMPLE_MIDI.map(async (s) => {
      const r = await fetch(`/samples/piano/${s.file}`);
      this.buffers.set(s.midi, await this.ctx!.decodeAudioData(await r.arrayBuffer()));
    })).then(() => undefined);
    return this.loading;
  }
  setVolume(v: number) { this.volume = v; if (this.gain) this.gain.gain.value = v; }
  async start() {
    await this.load();
    void this.ctx!.resume();
    this.stop();
    this.gain!.gain.value = this.volume;
    this.timer = window.setInterval(() => this.tick(), 50);
    this.tick();
  }
  stop() {
    clearInterval(this.timer);
    this.scheduled.clear();
    for (const o of this.live) { try { o.stop(); } catch { /* already stopped */ } }
    this.live = [];
  }
  private nearestSample(midi: number) {
    let best = SAMPLE_MIDI[0]!;
    for (const s of SAMPLE_MIDI) if (Math.abs(s.midi - midi) < Math.abs(best.midi - midi)) best = s;
    return best;
  }
  private tick() {
    const ctx = this.ctx!;
    if (this.audio.paused) return;
    const t = this.audio.currentTime, rate = this.audio.playbackRate || 1;
    const notes = this.getNotes();
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i]!;
      if (this.scheduled.has(i) || n.end <= t || n.start > t + 0.25) continue;
      this.scheduled.add(i);
      const mid = n.glideTo != null ? (n.midi + n.glideTo) / 2 : n.midi;
      const best = this.nearestSample(mid);
      const buf = this.buffers.get(best.midi);
      if (!buf) continue;
      const at = ctx.currentTime + Math.max(0, (n.start - t) / rate);
      const dur = Math.max(0.12, (n.end - Math.max(n.start, t)) / rate);
      const src = ctx.createBufferSource(), g = ctx.createGain();
      src.buffer = buf;
      const r0 = 2 ** ((n.midi - best.midi) / 12);
      if (n.glideTo != null && n.glideTo !== n.midi) {
        const r1 = 2 ** ((n.glideTo - best.midi) / 12);
        src.playbackRate.setValueAtTime(r0, at);
        src.playbackRate.linearRampToValueAtTime(r1, at + dur);
      } else {
        src.playbackRate.value = r0;
      }
      g.gain.setValueAtTime(0.9, at);
      g.gain.setTargetAtTime(0, at + dur, 0.08);
      src.connect(g).connect(this.gain!);
      src.start(at); src.stop(at + dur + 0.5);
      this.live.push(src);
      src.onended = () => { this.live = this.live.filter((x) => x !== src); };
    }
  }
}

/** Type-0 SMF of the melody (piano, PPQ 480). Glides become a pitch-bend sweep (range ±2 semitones → scale if needed). */
export function melodyMidi(notes: SynthNote[], beats: number[]): Uint8Array {
  const per = beats.length > 2 ? [...beats.slice(1).map((b, i) => b - beats[i]!)].sort((a, b) => a - b)[(beats.length - 1) >> 1]! : 0.5;
  const PPQ = 480, tpS = PPQ / per;
  const ev: { t: number; d: number[] }[] = [];
  // RPN 0 = pitch bend sensitivity 12 semitones
  ev.push({ t: 0, d: [0xb0, 101, 0] });
  ev.push({ t: 0, d: [0xb0, 100, 0] });
  ev.push({ t: 0, d: [0xb0, 6, 12] });
  ev.push({ t: 0, d: [0xb0, 38, 0] });
  for (const n of notes) {
    const t0 = Math.round(n.start * tpS), t1 = Math.round(n.end * tpS);
    ev.push({ t: t0, d: [0x90, n.midi, 90] });
    if (n.glideTo != null && n.glideTo !== n.midi) {
      const steps = Math.max(4, Math.min(32, t1 - t0));
      for (let s = 0; s <= steps; s++) {
        const frac = s / steps;
        const semi = (n.glideTo - n.midi) * frac;
        const pb = Math.max(0, Math.min(16383, Math.round(8192 + (semi / 12) * 8192)));
        ev.push({ t: t0 + Math.round((t1 - t0) * frac), d: [0xe0, pb & 0x7f, (pb >> 7) & 0x7f] });
      }
      ev.push({ t: t1, d: [0x80, n.midi, 0] });
      ev.push({ t: t1, d: [0xe0, 0x00, 0x40] }); // reset bend
    } else {
      ev.push({ t: t1, d: [0x80, n.midi, 0] });
    }
  }
  ev.sort((a, b) => a.t - b.t || a.d[0]! - b.d[0]!);
  const vlq = (v: number) => { const o = [v & 0x7f]; while ((v >>= 7)) o.unshift((v & 0x7f) | 0x80); return o; };
  const us = Math.round(per * 1e6);
  const tr: number[] = [0, 0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255, 0, 0xc0, 0];
  let last = 0;
  for (const e of ev) { tr.push(...vlq(e.t - last), ...e.d); last = e.t; }
  tr.push(0, 0xff, 0x2f, 0);
  const u32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  return new Uint8Array([0x4d, 0x54, 0x68, 0x64, ...u32(6), 0, 0, 0, 1, (PPQ >> 8) & 255, PPQ & 255, 0x4d, 0x54, 0x72, 0x6b, ...u32(tr.length), ...tr]);
}
