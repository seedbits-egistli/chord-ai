/**
 * Playable guitar accompaniment chart from a detection result.
 * The goal is a chart a guitarist can play along with — not an exact
 * transcription: chords are snapped to the bar grid, simplified, and mapped to
 * easy capo shapes; one strum pattern is chosen from tempo/meter.
 */
import { formatChord, parseChord } from './chordParse.js';
import { transposeChord, transposeKey } from './transpose.js';
import { getGuitarVoicing, shapeDifficulty, voicingMidi, type GuitarVoicing } from './guitarShapes.js';
import type { ChordEvent, ChordQuality, DetectionResult } from './types.js';

export type AccompLevel = 'simple' | 'standard' | 'raw';

export const ACCOMP_LEVEL_LABEL: Record<AccompLevel, string> = {
  simple: '簡單',
  standard: '標準',
  raw: '原始',
};

const SIMPLE_MAP: Record<ChordQuality, 'maj' | 'min'> = {
  maj: 'maj', '7': 'maj', maj7: 'maj', '6': 'maj', '9': 'maj', maj9: 'maj', add9: 'maj',
  '11': 'maj', '13': 'maj', sus2: 'maj', sus4: 'maj', '7sus4': 'maj', aug: 'maj',
  min: 'min', min7: 'min', min6: 'min', min9: 'min', dim: 'min', dim7: 'min', m7b5: 'min',
};

const STANDARD_MAP: Record<ChordQuality, ChordQuality> = {
  maj: 'maj', min: 'min', '7': '7', maj7: 'maj7', min7: 'min7', sus2: 'sus2', sus4: 'sus4',
  '7sus4': '7sus4', '6': 'maj', min6: 'min', '9': '7', maj9: 'maj7', min9: 'min7', add9: 'maj',
  '11': '7', '13': '7', aug: 'maj', dim: 'min', dim7: 'min', m7b5: 'min7',
};

/** Simplify one chord label for the given level ('N' stays 'N'). */
export function simplifyChordForLevel(chord: string, level: AccompLevel, key = 'C'): string {
  if (level === 'raw') return chord;
  const p = parseChord(chord);
  if (!p) return 'N';
  const quality = level === 'simple' ? SIMPLE_MAP[p.quality] : STANDARD_MAP[p.quality];
  return formatChord({ root: p.root, quality }, key);
}

export interface ChartChord {
  /** Sounding chord (concert pitch) */
  chord: string;
  /** Shape to play with the capo */
  shape: string;
  startBeat: number;
  beats: number;
}

export interface ChartBar {
  index: number;
  startMs: number;
  endMs: number;
  /** Beat onset times (ms) inside this bar */
  beatMs: number[];
  chords: ChartChord[];
}

export interface CapoPlan {
  capo: number;
  /** Key of the shapes (as fingered), e.g. "G" for A with capo 2 */
  shapeKey: string;
  difficulty: number;
  /** Sounding chord → shape name */
  shapes: Record<string, string>;
  /** "Capo 2，用 G 調指法" */
  summary: string;
  auto: boolean;
}

export interface StrumStroke {
  /** Position within the bar, in beats (0-based, 0.5 = "and") */
  at: number;
  dir: 'D' | 'U';
  accent?: boolean;
}

export interface StrumPattern {
  id: 'ballad' | 'pop' | 'drive' | 'waltz';
  name: string;
  beatsPerBar: number;
  /** Display string, e.g. "D - D U - U D U" */
  label: string;
  strokes: StrumStroke[];
}

export interface AccompChart {
  key: string;
  bpm: number;
  beatsPerBar: number;
  level: AccompLevel;
  capo: CapoPlan;
  strum: StrumPattern;
  bars: ChartBar[];
  /** Shapes used, in order of first appearance, with voicings */
  voicings: GuitarVoicing[];
}

/** Parse an 8th-note grid string like "D.DU.UDU" into strokes. */
function grid(s: string): StrumStroke[] {
  const out: StrumStroke[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === 'D' || c === 'U') out.push({ at: i / 2, dir: c, accent: i === 0 });
  }
  return out;
}

function gridLabel(s: string): string {
  // pairs per beat: "D." -> "D -" ; "DU" -> "D U"
  const parts: string[] = [];
  for (let i = 0; i < s.length; i++) parts.push(s[i] === '.' ? '-' : s[i]!);
  return parts.join(' ');
}

/** Pick one basic strum pattern from tempo and meter. */
export function chooseStrumPattern(bpm: number, beatsPerBar = 4): StrumPattern {
  if (beatsPerBar === 3) {
    const g = 'D.D.D.';
    return { id: 'waltz', name: '三拍（華爾滋）', beatsPerBar: 3, label: 'D - D - D -', strokes: grid(g) };
  }
  if (bpm < 80) {
    const g = 'D.D.D.DU';
    return { id: 'ballad', name: '慢歌', beatsPerBar: 4, label: gridLabel(g), strokes: grid(g) };
  }
  if (bpm > 140) {
    const g = 'D.D.D.D.';
    return { id: 'drive', name: '快歌（四分下刷）', beatsPerBar: 4, label: gridLabel(g), strokes: grid(g) };
  }
  const g = 'D.DU.UDU';
  return { id: 'pop', name: '流行基本刷法', beatsPerBar: 4, label: gridLabel(g), strokes: grid(g) };
}

/** Weighted difficulty of a set of shapes. */
function planCost(counts: Map<string, number>, capo: number): { cost: number; shapes: Record<string, string> } {
  let tot = 0;
  let cost = 0;
  const shapes: Record<string, string> = {};
  for (const [ch, n] of counts) {
    const shape = transposeChord(ch, -capo, 'C');
    shapes[ch] = shape;
    cost += n * shapeDifficulty(shape);
    tot += n;
  }
  const avg = tot ? cost / tot : 0;
  // small preference for low capo; capo above 5 sounds thin / is awkward
  return { cost: avg + 0.1 * capo + (capo > 5 ? 0.25 : 0), shapes };
}

/**
 * Choose capo 0–7 minimising shape difficulty (open C A G E D Am Em Dm preferred,
 * barre penalised). `override` forces a capo.
 */
export function chooseCapo(
  chords: string[],
  key: string,
  override?: number | null,
): CapoPlan {
  const counts = new Map<string, number>();
  for (const c of chords) {
    if (!parseChord(c)) continue;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  let best = { capo: 0, cost: Infinity, shapes: {} as Record<string, string> };
  const range = override != null ? [override] : [0, 1, 2, 3, 4, 5, 6, 7];
  for (const capo of range) {
    const r = planCost(counts, capo);
    if (r.cost < best.cost - 1e-9) best = { capo, cost: r.cost, shapes: r.shapes };
  }
  const shapeKey = sharpKey(transposeKey(key, -best.capo));
  return {
    capo: best.capo,
    shapeKey,
    difficulty: Math.round(best.cost * 100) / 100,
    shapes: best.shapes,
    summary: best.capo === 0 ? `不用 Capo，用 ${shapeKey} 調指法` : `Capo ${best.capo}，用 ${shapeKey} 調指法`,
    auto: override == null,
  };
}

function sharpKey(k: string): string {
  const m = k.endsWith('m');
  const p = parseChord(m ? k.slice(0, -1) : k);
  if (!p) return k;
  return formatChord({ root: p.root, quality: m ? 'min' : 'maj' }, false);
}

function chordAt(events: ChordEvent[], tMs: number): string {
  // binary search would be faster; charts are small
  for (const e of events) if (tMs >= e.tMs && tMs < e.endMs) return e.chord;
  return 'N';
}

export interface ChartOptions {
  level?: AccompLevel;
  capoOverride?: number | null;
  /** Override meter (default from timeSig) */
  beatsPerBar?: number;
}

/**
 * Build the accompaniment chart: per-beat chords on the detected beat grid,
 * grouped into bars (downbeat from precise mode), simplified per level.
 */
export function buildAccompanimentChart(result: DetectionResult, options: ChartOptions = {}): AccompChart {
  const level = options.level ?? 'simple';
  const beatsPerBar = options.beatsPerBar ?? (result.timeSig?.startsWith('3') ? 3 : 4);
  const key = result.key;
  let beats = result.beats.slice();
  const lastEnd = result.chords.length ? result.chords[result.chords.length - 1]!.endMs : 0;
  if (beats.length < 2) {
    const step = 60000 / (result.bpm || 120);
    beats = [];
    for (let t = 0; t < lastEnd; t += step) beats.push(t);
  }
  const beatDur = beats.length > 1 ? (beats[beats.length - 1]! - beats[0]!) / (beats.length - 1) : 500;
  const inBar = (i: number): number => {
    if (result.beatInBar && result.beatInBar[i] != null) return result.beatInBar[i]! % beatsPerBar;
    const ph = result.downbeatPhase ?? 0;
    return (((i - ph) % beatsPerBar) + beatsPerBar) % beatsPerBar;
  };

  // per-beat chord at beat centre (≥ 1 beat minimum length by construction)
  const perBeat: string[] = beats.map((b, i) => {
    const end = beats[i + 1] ?? b + beatDur;
    return simplifyChordForLevel(chordAt(result.chords, (b + end) / 2), level, key);
  });

  // fill N gaps inside music with the previous chord (charts never show silence mid-song)
  let firstChord = perBeat.findIndex((c) => c !== 'N');
  if (firstChord < 0) firstChord = 0;
  for (let i = firstChord + 1; i < perBeat.length; i++) if (perBeat[i] === 'N') perBeat[i] = perBeat[i - 1]!;

  // group into bars
  type RawBar = { beatIdx: number[] };
  const rawBars: RawBar[] = [];
  let cur: RawBar | null = null;
  for (let i = 0; i < beats.length; i++) {
    if (inBar(i) === 0 || !cur) {
      cur = { beatIdx: [] };
      rawBars.push(cur);
    }
    cur.beatIdx.push(i);
  }

  const bars: ChartBar[] = rawBars.map((rb, bi) => {
    let slots = rb.beatIdx.map((i) => perBeat[i]!);
    if (level === 'simple') slots = simplifyBarSlots(slots, beatsPerBar);
    else if (level === 'standard') slots = removeSingleBeatBlips(slots);
    const chords: ChartChord[] = [];
    slots.forEach((c, k) => {
      const last = chords[chords.length - 1];
      if (last && last.chord === c) last.beats++;
      else chords.push({ chord: c, shape: c, startBeat: k, beats: 1 });
    });
    const startMs = beats[rb.beatIdx[0]!]!;
    const lastIdx = rb.beatIdx[rb.beatIdx.length - 1]!;
    const endMs = beats[lastIdx + 1] ?? beats[lastIdx]! + beatDur;
    return { index: bi, startMs, endMs, beatMs: rb.beatIdx.map((i) => beats[i]!), chords };
  });

  const used = bars.flatMap((b) => b.chords.flatMap((c) => Array<string>(c.beats).fill(c.chord)));
  const capo = chooseCapo(used, key, options.capoOverride);
  const voicings: GuitarVoicing[] = [];
  const seen = new Set<string>();
  for (const b of bars) {
    for (const c of b.chords) {
      if (c.chord === 'N') {
        c.shape = 'N';
        continue;
      }
      c.shape = capo.shapes[c.chord] ?? transposeChord(c.chord, -capo.capo, 'C');
      if (!seen.has(c.shape)) {
        seen.add(c.shape);
        const v = getGuitarVoicing(c.shape);
        if (v) voicings.push({ ...v, name: c.shape });
      }
    }
  }
  return {
    key,
    bpm: result.bpm,
    beatsPerBar,
    level,
    capo,
    strum: chooseStrumPattern(result.bpm, beatsPerBar),
    bars,
    voicings,
  };
}

/** Replace isolated 1-beat chords with the previous (or next) chord. */
function removeSingleBeatBlips(slots: string[]): string[] {
  const src = slots;
  const out = slots.slice();
  // beat 0 (downbeat) is kept: a chord landing on the bar line is meaningful
  for (let i = 1; i < src.length; i++) {
    const prev = src[i - 1];
    const next = src[i + 1];
    if (src[i] !== prev && src[i] !== next) out[i] = prev!;
  }
  return out;
}

/**
 * Simple level: at most one chord per half bar (4/4) or per bar (3/4);
 * each half takes its majority chord (ties → the later chord, which is the one
 * the harmony is moving to).
 */
function simplifyBarSlots(slots: string[], beatsPerBar: number): string[] {
  const s = removeSingleBeatBlips(slots);
  const half = beatsPerBar === 4 ? 2 : beatsPerBar;
  const out: string[] = [];
  for (let a = 0; a < s.length; a += half) {
    const seg = s.slice(a, a + half);
    const cnt = new Map<string, number>();
    for (const c of seg) cnt.set(c, (cnt.get(c) ?? 0) + 1);
    let best = seg[seg.length - 1]!;
    let bn = 0;
    for (let k = seg.length - 1; k >= 0; k--) {
      const n = cnt.get(seg[k]!)!;
      if (n > bn) {
        bn = n;
        best = seg[k]!;
      }
    }
    for (let k = 0; k < seg.length; k++) out.push(best);
  }
  return out;
}

export interface StrumEvent {
  tMs: number;
  durMs: number;
  dir: 'D' | 'U';
  accent: boolean;
  /** shape to fret (with capo) */
  shape: string;
  /** MIDI notes low→high including capo (empty if no voicing) */
  midi: number[];
  barIndex: number;
}

/** Expand a chart into timed strum strokes using the real beat times. */
export function chartToStrumEvents(chart: AccompChart): StrumEvent[] {
  const out: StrumEvent[] = [];
  for (const bar of chart.bars) {
    const beatLen = bar.beatMs.length > 1 ? (bar.endMs - bar.startMs) / bar.beatMs.length : bar.endMs - bar.startMs;
    for (const st of chart.strum.strokes) {
      if (st.at >= bar.beatMs.length) continue;
      const b = Math.floor(st.at);
      const t0 = bar.beatMs[b]!;
      const t1 = bar.beatMs[b + 1] ?? bar.endMs;
      const tMs = t0 + (st.at - b) * (t1 - t0);
      const cc = bar.chords.find((c) => st.at >= c.startBeat && st.at < c.startBeat + c.beats);
      if (!cc || cc.shape === 'N') continue;
      const v = getGuitarVoicing(cc.shape);
      out.push({
        tMs,
        durMs: beatLen * 0.5,
        dir: st.dir,
        accent: !!st.accent,
        shape: cc.shape,
        midi: v ? voicingMidi(v, chart.capo.capo) : [],
        barIndex: bar.index,
      });
    }
  }
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1];
    if (next) out[i]!.durMs = Math.max(80, next.tMs - out[i]!.tMs);
  }
  return out;
}

/** Plain-text / Markdown chart (shapes as played; sounding chords listed in header). */
export function formatChartText(
  chart: AccompChart,
  opts: { maxBars?: number; barsPerLine?: number; startBar?: number } = {},
): string {
  const per = opts.barsPerLine ?? 4;
  const start = opts.startBar ?? 0;
  const bars = chart.bars.slice(start, start + (opts.maxBars ?? chart.bars.length));
  const lines: string[] = [];
  lines.push(`${chart.capo.summary}（原調 ${chart.key}，${Math.round(chart.bpm)} BPM，${chart.beatsPerBar}/4）`);
  lines.push(`刷法：${chart.strum.name}  ${chart.strum.label}`);
  const map = Object.entries(chart.capo.shapes)
    .filter(([s]) => bars.some((b) => b.chords.some((c) => c.chord === s)))
    .map(([s, sh]) => (s === sh ? sh : `${sh}（實際 ${s}）`));
  lines.push(`用到的指法：${map.join('、')}`);
  lines.push('');
  for (let i = 0; i < bars.length; i += per) {
    const row = bars.slice(i, i + per).map((b) => {
      const cells = b.chords.map((c) => (c.shape === 'N' ? 'N.C.' : c.shape));
      return ' ' + cells.join(' ').padEnd(12) + ' ';
    });
    lines.push(`${String(start + i + 1).padStart(3)} |${row.join('|')}|`);
  }
  return lines.join('\n');
}

