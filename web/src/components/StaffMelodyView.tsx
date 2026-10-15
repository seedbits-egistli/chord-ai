/**
 * VexFlow (MIT) staff view of the melody: key/time signatures, quantized notes + rests, lyrics under notes,
 * section labels above, glides as slur + ornament. Highlights the current measure/note and auto-scrolls.
 */
import { useEffect, useMemo, useRef } from 'react';
import { Renderer, StaveNote, Voice, Formatter, Stave, Beam, StaveTie, Annotation, Accidental } from 'vexflow';
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
  widthPerBar?: number;
}

const DUR: Record<number, string> = {
  1: '16', 2: '8', 3: '8d', 4: 'q', 6: 'qd', 8: 'h', 12: 'hd', 16: 'w',
};

function vexKey(key: string): string {
  // VexFlow wants "C", "Am", "Bb", "F#m"
  return key.replace('♯', '#').replace('♭', 'b');
}

function ticksOf(n: MelodyNote): number {
  if (n.ticks && n.ticks > 0) return n.ticks;
  return 2;
}

function fillMeasure(notes: MelodyNote[], barStart: number, barEnd: number, key: string): { kind: 'n' | 'r'; ticks: number; midi?: number; glideTo?: number; lyric?: string; note?: MelodyNote }[] {
  const inBar = notes.filter((n) => n.qStart < barEnd - 1e-4 && n.qEnd > barStart + 1e-4)
    .map((n) => ({ ...n, qStart: Math.max(n.qStart, barStart), qEnd: Math.min(n.qEnd, barEnd) }))
    .sort((a, b) => a.qStart - b.qStart);
  const out: { kind: 'n' | 'r'; ticks: number; midi?: number; glideTo?: number; lyric?: string; note?: MelodyNote }[] = [];
  // Convert absolute times to 16th ticks within the bar (assume 4/4 → 16 ticks)
  const barDur = barEnd - barStart;
  const toTicks = (t: number) => Math.round(((t - barStart) / barDur) * 16);
  let cursor = 0;
  for (const n of inBar) {
    let on = toTicks(n.qStart);
    let off = Math.max(on + 1, toTicks(n.qEnd));
    if (on < cursor) on = cursor;
    if (on > cursor) {
      // rest
      let gap = on - cursor;
      while (gap > 0) {
        const take = [16, 12, 8, 6, 4, 3, 2, 1].find((t) => t <= gap && (cursor % t === 0 || t === 1)) ?? 1;
        out.push({ kind: 'r', ticks: take });
        gap -= take; cursor += take;
      }
    }
    let rem = Math.min(off, 16) - cursor;
    if (rem <= 0) continue;
    // prefer the note's quantized ticks, clipped to remaining
    const pref = Math.min(rem, ticksOf(n));
    const take = [16, 12, 8, 6, 4, 3, 2, 1].find((t) => t <= pref && (t === pref || cursor % Math.min(t, 4) === 0)) ?? Math.min(rem, 1);
    out.push({ kind: 'n', ticks: take, midi: n.midi, glideTo: n.glideTo, note: n });
    cursor += take;
  }
  while (cursor < 16) {
    const gap = 16 - cursor;
    const take = [16, 12, 8, 6, 4, 3, 2, 1].find((t) => t <= gap && (cursor % t === 0 || t === 1)) ?? 1;
    out.push({ kind: 'r', ticks: take });
    cursor += take;
  }
  void key;
  return out;
}

export function StaffMelodyView({ notes, bars, keySig, timeSig = '4/4', sections, words = [], time, widthPerBar = 220 }: StaffMelodyViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const noteEls = useRef<{ el: SVGElement | null; start: number; end: number }[]>([]);
  const measureEls = useRef<SVGRectElement[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const measureStarts = useMemo(() => bars.slice(0, -1).map((b, i) => ({ start: b, end: bars[i + 1]!, i })), [bars]);
  const curMeasure = measureStarts.findIndex((m) => time >= m.start && time < m.end);

  // attach lyrics to notes by nearest start
  const notesWithLyric = useMemo(() => {
    if (!words.length) return notes;
    return notes.map((n) => {
      let best: StaffWord | null = null, bd = 0.35;
      for (const w of words) {
        const d = Math.abs(w.start - n.start);
        if (d < bd) { bd = d; best = w; }
      }
      return best ? { ...n, _lyric: best.word } : n;
    });
  }, [notes, words]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || measureStarts.length === 0) return;
    host.innerHTML = '';
    const totalW = measureStarts.length * widthPerBar + 40;
    const height = 180;
    const renderer = new Renderer(host, Renderer.Backends.SVG);
    renderer.resize(totalW, height);
    const ctx = renderer.getContext();
    const key = vexKey(keySig);
    const vfNotes: StaveNote[] = [];
    const ties: { from: StaveNote; to: StaveNote }[] = [];
    let x = 10;
    measureStarts.forEach((m, mi) => {
      const stave = new Stave(x, 30, widthPerBar);
      if (mi === 0) {
        stave.addClef('treble');
        stave.addKeySignature(key.endsWith('m') ? relMajor(key) : key);
        stave.addTimeSignature(timeSig);
      }
      const sec = sections.find((s) => s.start <= m.start + 0.05 && s.end > m.start + 0.05);
      if (sec && Math.abs(sec.start - m.start) < (m.end - m.start) * 0.6) {
        stave.setText(sec.label, StaveModifierPositionTop());
      }
      stave.setContext(ctx).draw();
      const events = fillMeasure(notesWithLyric as MelodyNote[], m.start, m.end, key);
      const staveNotes: StaveNote[] = [];
      for (const e of events) {
        if (e.kind === 'r') {
          const sn = new StaveNote({ keys: ['b/4'], duration: (DUR[e.ticks] ?? 'q') + 'r', clef: 'treble' });
          staveNotes.push(sn);
        } else {
          const keys = [midiToVex(e.midi!, key)];
          const sn = new StaveNote({ keys, duration: DUR[e.ticks] ?? 'q', clef: 'treble' });
          // accidentals already in key name (c#, bb) — VexFlow parses them from the key string
          const lyric = (e.note as MelodyNote & { _lyric?: string })?._lyric;
          if (lyric) {
            sn.addModifier(new Annotation(lyric).setVerticalJustification(Annotation.VerticalJustify.BOTTOM), 0);
          }
          if (e.glideTo != null && e.glideTo !== e.midi) {
            sn.addModifier(new Annotation('⤵').setVerticalJustification(Annotation.VerticalJustify.TOP), 0);
          }
          staveNotes.push(sn);
          (sn as StaveNote & { _t?: [number, number] })._t = [e.note!.qStart, e.note!.qEnd];
          if (e.glideTo != null) {
            // slur will be added if we have a next note; mark for pairing
            (sn as StaveNote & { _glide?: boolean })._glide = true;
          }
        }
      }
      // pair glides: slur from a glide-marked note to the next note
      for (let i = 0; i < staveNotes.length - 1; i++) {
        const a = staveNotes[i] as StaveNote & { _glide?: boolean };
        if (a._glide) ties.push({ from: a, to: staveNotes[i + 1]! });
      }
      try {
        const voice = new Voice({ num_beats: 4, beat_value: 4 }).setStrict(false);
        voice.addTickables(staveNotes);
        Accidental.applyAccidentals([voice], key.replace(/m$/, '') === key ? key : relMajor(key));
        new Formatter().joinVoices([voice]).formatToStave([voice], stave);
        voice.draw(ctx, stave);
        // beams for consecutive 8ths/16ths
        const beamable: StaveNote[] = [];
        const flush = () => {
          if (beamable.length >= 2) {
            try { new Beam(beamable.slice()).setContext(ctx).draw(); } catch { /* ignore */ }
          }
          beamable.length = 0;
        };
        for (const sn of staveNotes) {
          const d = (sn as StaveNote & { getDuration(): string }).getDuration?.() ?? '';
          if (/^[81]6?$|^8$|^16$/.test(d) && !sn.isRest()) beamable.push(sn);
          else flush();
        }
        flush();
      } catch (err) {
        console.warn('[staff]', mi, err);
      }
      vfNotes.push(...staveNotes);
      x += widthPerBar;
    });
    for (const t of ties) {
      try { new StaveTie({ first_note: t.from, last_note: t.to, first_indices: [0], last_indices: [0] }).setContext(ctx).draw(); } catch { /* ignore */ }
    }
    // measure highlight rects (behind notes) + note element index for playback highlight
    const svg = host.querySelector('svg');
    measureEls.current = [];
    if (svg) {
      measureStarts.forEach((_, mi) => {
        const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        r.setAttribute('x', String(10 + mi * widthPerBar)); r.setAttribute('y', '20');
        r.setAttribute('width', String(widthPerBar)); r.setAttribute('height', '140');
        r.setAttribute('fill', 'rgba(249,115,22,0.14)'); r.setAttribute('visibility', 'hidden');
        svg.insertBefore(r, svg.firstChild);
        measureEls.current.push(r);
      });
    }
    noteEls.current = vfNotes
      .filter((n) => (n as StaveNote & { _t?: [number, number] })._t)
      .map((n) => { const t = (n as StaveNote & { _t: [number, number] })._t; return { el: (n.getSVGElement?.() ?? null) as SVGElement | null, start: t[0], end: t[1] }; });
  }, [notesWithLyric, measureStarts, keySig, timeSig, sections, widthPerBar]);

  // playback highlight: current measure + sounding note
  useEffect(() => {
    measureEls.current.forEach((r, i) => r.setAttribute('visibility', i === curMeasure ? 'visible' : 'hidden'));
    for (const n of noteEls.current) {
      if (!n.el) continue;
      const on = time >= n.start && time < n.end;
      n.el.classList.toggle('sa-staff-cur', on);
    }
  }, [time, curMeasure]);

  // auto-scroll to current measure
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || curMeasure < 0) return;
    const x = curMeasure * widthPerBar;
    if (x < el.scrollLeft + 40 || x > el.scrollLeft + el.clientWidth - widthPerBar - 40) {
      el.scrollLeft = Math.max(0, x - 80);
    }
  }, [curMeasure, widthPerBar]);

  return (
    <div className="sa-staff" ref={scrollRef} data-testid="staff-view">
      <div ref={hostRef} style={{ minHeight: 180 }} />
    </div>
  );
}

/** Relative major for a minor key name (Am → C), for VexFlow key signatures. */
function relMajor(key: string): string {
  const m = key.replace(/m$/, '');
  const names = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const pc: Record<string, number> = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
  return names[((pc[m] ?? 0) + 3) % 12]!;
}

/** VexFlow Stave text position helper (top). */
function StaveModifierPositionTop(): number {
  // Stave.setText(str, position) — position 1 = TOP in VexFlow 4
  return 1;
}
