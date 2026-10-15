/**
 * Melody playback with sampled acoustic grand piano (FluidR3_GM via gleitz/midi-js-soundfonts, CC-BY 3.0; bundled in
 * /samples/piano). One sample every 3 semitones, pitch-shifted by playbackRate. Follows an <audio> element's clock.
 */
export interface SynthNote { start: number; end: number; midi: number }
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
  private tick() {
    const ctx = this.ctx!;
    if (this.audio.paused) return;
    const t = this.audio.currentTime, rate = this.audio.playbackRate || 1;
    const notes = this.getNotes();
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i]!;
      if (this.scheduled.has(i) || n.end <= t || n.start > t + 0.25) continue;
      this.scheduled.add(i);
      let best = SAMPLE_MIDI[0]!;
      for (const s of SAMPLE_MIDI) if (Math.abs(s.midi - n.midi) < Math.abs(best.midi - n.midi)) best = s;
      const buf = this.buffers.get(best.midi);
      if (!buf) continue;
      const at = ctx.currentTime + Math.max(0, (n.start - t) / rate);
      const dur = Math.max(0.12, (n.end - Math.max(n.start, t)) / rate);
      const src = ctx.createBufferSource(), g = ctx.createGain();
      src.buffer = buf;
      src.playbackRate.value = 2 ** ((n.midi - best.midi) / 12);
      g.gain.setValueAtTime(0.9, at);
      g.gain.setTargetAtTime(0, at + dur, 0.08);
      src.connect(g).connect(this.gain!);
      src.start(at); src.stop(at + dur + 0.5);
      this.live.push(src);
      src.onended = () => { this.live = this.live.filter((x) => x !== src); };
    }
  }
}

/** Type-0 SMF of the melody (piano, PPQ 480, tempo from the median beat period). */
export function melodyMidi(notes: SynthNote[], beats: number[]): Uint8Array {
  const per = beats.length > 2 ? [...beats.slice(1).map((b, i) => b - beats[i]!)].sort((a, b) => a - b)[(beats.length - 1) >> 1]! : 0.5;
  const PPQ = 480, tpS = PPQ / per;
  const ev: { t: number; d: number[] }[] = [];
  for (const n of notes) {
    ev.push({ t: Math.round(n.start * tpS), d: [0x90, n.midi, 90] });
    ev.push({ t: Math.round(n.end * tpS), d: [0x80, n.midi, 0] });
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
