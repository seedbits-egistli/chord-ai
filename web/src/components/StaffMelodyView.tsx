/**
 * VexFlow (MIT) staff view, laid out like printed sheet music: systems wrap downward, measure width follows content
 * (note count + measured lyric width), clef + key at each system start, section labels above section starts,
 * beams per beat, dense measures simplified to an 8th grid. Playback highlights measure + note and scrolls vertically.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Renderer, StaveNote, Voice, Formatter, Stave, Beam, Annotation, Accidental, Fraction, StaveTie } from 'vexflow';
import { midiToVex, type MelodyNote, type Section } from '@chord-ai/engine';

export interface StaffWord { word: string; start: number; end: number }
export interface StaffMelodyViewProps {
  notes: MelodyNote[];
  bars: number[];
  keySig: string;
  timeSig?: string;
  sections: Section[];
  words?: StaffWord[];
  time: number;
}

const DUR: Record<number, string> = { 1: '16', 2: '8', 3: '8d', 4: 'q', 6: 'qd', 8: 'h', 12: 'hd', 16: 'w' };
const SIZES = [16, 12, 8, 6, 4, 3, 2, 1];
const MIN_W: Record<number, number> = { 1: 20, 2: 24, 3: 28, 4: 32, 6: 36, 8: 40, 12: 44, 16: 48 };
const LYRIC_FONT = '13px Arial, sans-serif';
const STAVE_H = 150; // vertical space per system (staff + lyrics + label)

type Ev = { rest: boolean; ticks: number; midi?: number; glideTo?: number; lyric?: string; t0: number; t1: number };
interface Measure { i: number; start: number; end: number; events: Ev[]; section?: string; minW: number }

function relMajor(key: string): string {
  const m = key.replace(/m$/, '');
  const names = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const pc: Record<string, number> = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
  return names[((pc[m] ?? 0) + 3) % 12]!;
}
const majorKey = (k: string) => (k.endsWith('m') ? relMajor(k) : k);

/** Split `gap` 16th ticks starting at `pos` into rest/note values that respect beat boundaries. */
function splitTicks(pos: number, gap: number): number[] {
  const out: number[] = [];
  while (gap > 0) {
    const toBeat = 4 - (pos % 4);
    let take = SIZES.find((t) => t <= gap && (t <= toBeat || (pos % 4 === 0 && t % 4 === 0 && pos % Math.min(t, 8) === 0))) ?? 1;
    if (take === 3 && pos % 2) take = 1;
    out.push(take); gap -= take; pos += take;
  }
  return out;
}

function buildMeasures(notes: MelodyNote[], bars: number[], sections: Section[], words: StaffWord[], measureText: (s: string) => number): Measure[] {
  const ms: Measure[] = [];
  for (let i = 0; i + 1 < bars.length; i++) {
    const start = bars[i]!, end = bars[i + 1]!, dur = end - start;
    const toT = (t: number) => Math.max(0, Math.min(16, Math.round(((t - start) / dur) * 16)));
    let inBar = notes.filter((n) => n.start < end - 1e-3 && n.end > start + 1e-3 && n.start >= start - dur / 32)
      .map((n) => ({ on: toT(n.start), off: toT(n.end), n }))
      .sort((a, b) => a.on - b.on);
    // simplify dense measures: > 8 notes → 8th grid, drop collisions
    // readability: 8th-note grid (16ths only in sparse bars)
    const grid = inBar.length > 4 ? 2 : 1;
    inBar = inBar.map((x) => ({ ...x, on: Math.round(x.on / grid) * grid, off: Math.max(Math.round(x.off / grid) * grid, Math.round(x.on / grid) * grid + grid) }));
    const dedup: typeof inBar = [];
    for (const x of inBar) { if (x.on >= 16) continue; const p = dedup[dedup.length - 1]; if (p && p.on === x.on) continue; dedup.push(x); }
    for (let k = 0; k + 1 < dedup.length; k++) dedup[k]!.off = Math.min(dedup[k]!.off, dedup[k + 1]!.on);
    const events: Ev[] = [];
    let pos = 0;
    const tAt = (p: number) => start + (p / 16) * dur;
    for (const x of dedup) {
      if (x.on > pos) for (const r of splitTicks(pos, x.on - pos)) { events.push({ rest: true, ticks: r, t0: tAt(pos), t1: tAt(pos + r) }); pos += r; }
      const off = Math.min(16, Math.max(x.off, pos + grid));
      const parts = splitTicks(pos, off - pos);
      // keep it one symbol: use the first beat-safe value, rest of span becomes rest (cleaner than ties)
      const take = parts[0]!;
      events.push({ rest: false, ticks: take, midi: x.n.midi, glideTo: x.n.glideTo, t0: tAt(pos), t1: tAt(pos + take) });
      pos += take;
      for (const r of parts.slice(1)) { events.push({ rest: true, ticks: r, t0: tAt(pos), t1: tAt(pos + r) }); pos += r; }
    }
    if (pos < 16) for (const r of splitTicks(pos, 16 - pos)) { events.push({ rest: true, ticks: r, t0: tAt(pos), t1: tAt(pos + r) }); pos += r; }
    // merge consecutive rests within a beat-safe span is handled by splitTicks; collapse an all-rest bar
    if (events.every((e) => e.rest)) events.splice(0, events.length, { rest: true, ticks: 16, t0: start, t1: end });
    const sec = sections.find((s) => Math.abs(s.start - start) < dur * 0.5);
    ms.push({ i, start, end, events, section: sec?.label, minW: 0 });
  }
  // lyrics: each word → the single note with nearest onset (≤ 0.4 s); a note keeps all words it receives
  const allNotes = ms.flatMap((m) => m.events.filter((e) => !e.rest));
  // 整理後 notes carry their own syllable: use it directly instead of nearest-onset matching
  const own = notes.some((n) => (n as MelodyNote & { lyric?: string }).lyric);
  if (own) {
    for (const n of notes) {
      const ly = (n as MelodyNote & { lyric?: string }).lyric;
      if (!ly) continue;
      let best: Ev | null = null, bd = 0.2;
      for (const e of allNotes) { const d = Math.abs(e.t0 - n.start); if (d < bd) { bd = d; best = e; } }
      if (best) best.lyric = best.lyric ? `${best.lyric} ${ly}` : ly;
    }
    words = [];
  }
  for (const w of words) {
    let best: Ev | null = null, bd = 0.4;
    for (const e of allNotes) { const d = Math.abs(e.t0 - w.start); if (d < bd) { bd = d; best = e; } }
    if (best) best.lyric = best.lyric ? `${best.lyric} ${w.word}` : w.word;
  }
  for (const m of ms) {
    let w = 24;
    for (const e of m.events) w += Math.max(MIN_W[e.ticks] ?? 28, e.lyric ? measureText(e.lyric) + 10 : 0);
    m.minW = Math.max(110, w);
  }
  return ms;
}

export function StaffMelodyView({ notes, bars, keySig, timeSig = '4/4', sections, words = [], time }: StaffMelodyViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const layoutRef = useRef<{ measures: { x: number; y: number; w: number; start: number; end: number }[]; noteEls: { el: SVGElement | null; t0: number; t1: number }[]; rects: SVGRectElement[] }>({ measures: [], noteEls: [], rects: [] });

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(320, el.clientWidth - 8)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const measures = useMemo(() => {
    const c = document.createElement('canvas').getContext('2d')!;
    c.font = LYRIC_FONT;
    return buildMeasures(notes, bars, sections, words, (s) => c.measureText(s).width);
  }, [notes, bars, sections, words]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !measures.length) return;
    host.innerHTML = '';
    const key = majorKey(keySig);
    const ms = notes.map((n) => n.midi).sort((a, b) => a - b);
    const low = ms.length > 0 && ms[ms.length >> 1]! < 60; // male range → treble 8vb (sounds an octave lower)
    const shift = low ? 12 : 0;
    const left = 6, usable = width - left * 2;
    const maxPerLine = width < 500 ? 2 : width < 900 ? 3 : 4;
    // probe clef+key+time width
    const probe = new Stave(0, 0, 400).addClef('treble').addKeySignature(key);
    const headW = probe.getNoteStartX() + 6;
    // greedy line packing
    const lines: Measure[][] = [];
    let cur: Measure[] = [], curW = headW;
    for (const m of measures) {
      if (cur.length && (cur.length >= maxPerLine || curW + m.minW > usable)) { lines.push(cur); cur = []; curW = headW; }
      cur.push(m); curW += m.minW;
    }
    if (cur.length) lines.push(cur);
    const renderer = new Renderer(host, Renderer.Backends.SVG);
    renderer.resize(width, lines.length * STAVE_H + 30);
    const ctx = renderer.getContext();
    const lay = { measures: [] as { x: number; y: number; w: number; start: number; end: number }[], noteEls: [] as { el: SVGElement | null; t0: number; t1: number }[], rects: [] as SVGRectElement[] };
    lines.forEach((line, li) => {
      const y = 22 + li * STAVE_H;
      const natural = headW + line.reduce((s, m) => s + m.minW, 0);
      const isLast = li === lines.length - 1;
      const scale = isLast && natural < usable * 0.7 ? 1 : usable / natural;
      let x = left;
      line.forEach((m, k) => {
        const w = m.minW * scale + (k === 0 ? headW * scale : 0);
        const stave = new Stave(x, y, w);
        if (k === 0) { stave.addClef('treble', 'default', low ? '8vb' : undefined).addKeySignature(key); if (li === 0) stave.addTimeSignature(timeSig); }
        stave.setContext(ctx).draw();
        if (m.section) {
          ctx.save(); ctx.setFont('Arial', 13, 'bold'); ctx.setFillStyle('#c2410c');
          ctx.fillText(m.section, x + 4, y + 24); ctx.restore();
        }
        const sns: StaveNote[] = [];
        const glideFrom: StaveNote[] = [];
        for (const e of m.events) {
          const sn = e.rest
            ? new StaveNote({ keys: ['b/4'], duration: (DUR[e.ticks] ?? 'q') + 'r', clef: 'treble' })
            : new StaveNote({ keys: [midiToVex(e.midi! + shift, keySig)], duration: DUR[e.ticks] ?? 'q', clef: 'treble', auto_stem: true });
          if (!e.rest && e.lyric) sn.addModifier(new Annotation(e.lyric).setFont('Arial', 13).setVerticalJustification(Annotation.VerticalJustify.BOTTOM), 0);
          if (!e.rest && e.glideTo != null && e.glideTo !== e.midi) { sn.addModifier(new Annotation('⌒').setFont('Arial', 12).setVerticalJustification(Annotation.VerticalJustify.TOP), 0); glideFrom.push(sn); }
          (sn as StaveNote & { _t?: [number, number] })._t = e.rest ? undefined : [e.t0, e.t1];
          sns.push(sn);
        }
        try {
          const voice = new Voice({ num_beats: 4, beat_value: 4 }).setStrict(false);
          voice.addTickables(sns);
          Accidental.applyAccidentals([voice], key);
          const beams = Beam.generateBeams(sns, { groups: [new Fraction(1, 4)], beam_rests: false, maintain_stem_directions: false });
          new Formatter().joinVoices([voice]).formatToStave([voice], stave);
          voice.draw(ctx, stave);
          beams.forEach((b) => b.setContext(ctx).draw());
          for (const g of glideFrom) {
            const idx = sns.indexOf(g), nx = sns.slice(idx + 1).find((n) => !n.isRest());
            if (nx) new StaveTie({ first_note: g, last_note: nx, first_indices: [0], last_indices: [0] }).setContext(ctx).draw();
          }
        } catch (err) { console.warn('[staff]', m.i, err); }
        for (const sn of sns) {
          const t = (sn as StaveNote & { _t?: [number, number] })._t;
          if (t) lay.noteEls.push({ el: (sn.getSVGElement?.() ?? null) as SVGElement | null, t0: t[0], t1: t[1] });
        }
        lay.measures.push({ x, y, w, start: m.start, end: m.end });
        x += w;
      });
    });
    const svg = host.querySelector('svg');
    if (svg) for (const mm of lay.measures) {
      const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      r.setAttribute('x', String(mm.x)); r.setAttribute('y', String(mm.y + 8));
      r.setAttribute('width', String(mm.w)); r.setAttribute('height', String(STAVE_H - 18));
      r.setAttribute('fill', 'rgba(249,115,22,0.13)'); r.setAttribute('visibility', 'hidden');
      svg.insertBefore(r, svg.firstChild);
      lay.rects.push(r);
    }
    layoutRef.current = lay;
  }, [measures, keySig, timeSig, width, notes]);

  // playback highlight + vertical auto-scroll
  const lastLine = useRef(-1);
  useEffect(() => {
    const lay = layoutRef.current;
    const mi = lay.measures.findIndex((m) => time >= m.start && time < m.end);
    lay.rects.forEach((r, i) => r.setAttribute('visibility', i === mi ? 'visible' : 'hidden'));
    for (const n of lay.noteEls) n.el?.classList.toggle('sa-staff-cur', time >= n.t0 && time < n.t1);
    const el = scrollRef.current;
    if (el && mi >= 0) {
      const y = lay.measures[mi]!.y;
      if (y !== lastLine.current) {
        lastLine.current = y;
        if (y < el.scrollTop || y + STAVE_H > el.scrollTop + el.clientHeight) el.scrollTo({ top: Math.max(0, y - 20), behavior: 'smooth' });
      }
    }
  }, [time, measures, width]);

  return (
    <div className="sa-staff" ref={scrollRef} data-testid="staff-view">
      <div ref={hostRef} />
    </div>
  );
}
