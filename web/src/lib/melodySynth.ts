/** Tiny WebAudio melody synth that follows an <audio> element's clock (lookahead scheduler). */
export interface SynthNote { start: number; end: number; midi: number }
export class MelodySynth {
  private ctx: AudioContext | null = null;
  private timer = 0;
  private scheduled = new Set<number>();
  private live: OscillatorNode[] = [];
  constructor(private audio: HTMLAudioElement, private getNotes: () => SynthNote[]) {}
  start() {
    this.ctx ??= new AudioContext();
    void this.ctx.resume();
    this.stop();
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
      const at = ctx.currentTime + Math.max(0, (n.start - t) / rate);
      const dur = (n.end - Math.max(n.start, t)) / rate;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.value = 440 * 2 ** ((n.midi - 69) / 12);
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(0.18, at + 0.015);
      g.gain.setTargetAtTime(0.1, at + 0.05, 0.1);
      g.gain.setTargetAtTime(0, at + Math.max(0.03, dur - 0.03), 0.02);
      o.connect(g).connect(ctx.destination);
      o.start(at); o.stop(at + dur + 0.1);
      this.live.push(o);
      o.onended = () => { this.live = this.live.filter((x) => x !== o); };
    }
  }
}
