import { formatChord, parseChord } from './chordParse.js';
import { pcToName, preferFlatsForKey } from './notes.js';
import type { ChordEvent } from './types.js';

/** Transpose a chord name by semitones with key-aware spelling. */
export function transposeChord(chord: string, semitones: number, targetKey: string): string {
  const p = parseChord(chord);
  if (!p) return chord;
  const root = (p.root + semitones + 120) % 12;
  const bass = p.bass !== undefined ? (p.bass + semitones + 120) % 12 : undefined;
  return formatChord({ root, quality: p.quality, bass }, targetKey);
}

export function transposeKey(key: string, semitones: number): string {
  const isMinor = key.endsWith('m');
  const rootName = isMinor ? key.slice(0, -1) : key;
  const { nameToPc } = noteHelpers();
  const pc = nameToPc(rootName);
  if (pc === null) return key;
  const npc = (pc + semitones + 120) % 12;
  const useFlats = preferFlatsForKey(pcToName(npc, true) + (isMinor ? 'm' : ''));
  const name = pcToName(npc, useFlats) + (isMinor ? 'm' : '');
  // Prefer flat spelling if that key is a flat key
  if (preferFlatsForKey(name) || preferFlatsForKey(pcToName(npc, true) + (isMinor ? 'm' : ''))) {
    return pcToName(npc, true) + (isMinor ? 'm' : '');
  }
  return pcToName(npc, false) + (isMinor ? 'm' : '');
}

function noteHelpers() {
  const map: Record<string, number> = {
    C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5,
    'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
  };
  return { nameToPc: (n: string) => map[n] ?? null };
}

export function transposeEvents(
  events: ChordEvent[],
  semitones: number,
  targetKey: string,
): ChordEvent[] {
  return events.map((e) => ({
    ...e,
    chord: transposeChord(e.chord, semitones, targetKey),
  }));
}

/** Open-shape friendly chords for capo suggestion */
const OPEN_SHAPES = new Set([
  'C', 'G', 'D', 'A', 'E', 'Am', 'Em', 'Dm', 'F', 'Bm', 'B7', 'E7', 'A7', 'D7', 'G7', 'C7',
]);

export interface CapoSuggestion {
  capo: number;
  /** Chords as played shapes with capo */
  shapes: string[];
  hardCount: number;
  summary: string;
}

/**
 * Suggest capo 0–7 minimizing non-open chord shapes for guitar.
 * Ukulele uses a similar open-set heuristic.
 */
export function suggestCapo(
  chords: string[],
  instrument: 'guitar' | 'ukulele' = 'guitar',
): CapoSuggestion {
  const open =
    instrument === 'ukulele'
      ? new Set(['C', 'F', 'G', 'Am', 'Em', 'Dm', 'A', 'E7', 'G7', 'C7', 'D', 'Bm'])
      : OPEN_SHAPES;

  let best: CapoSuggestion = {
    capo: 0,
    shapes: chords.slice(),
    hardCount: Infinity,
    summary: '',
  };

  for (let capo = 0; capo <= 7; capo++) {
    const shapes = chords.map((c) => transposeChord(c, -capo, 'C'));
    let hard = 0;
    for (const s of shapes) {
      const base = s.split('/')[0]!;
      if (!open.has(base)) hard++;
    }
    if (hard < best.hardCount || (hard === best.hardCount && capo < best.capo)) {
      best = {
        capo,
        shapes,
        hardCount: hard,
        summary:
          capo === 0
            ? '不用 Capo'
            : `Capo ${capo}，彈 ${mostCommonShape(shapes)} 型`,
      };
    }
  }
  return best;
}

function mostCommonShape(shapes: string[]): string {
  const counts = new Map<string, number>();
  for (const s of shapes) {
    const b = s.split('/')[0]!;
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  let best = 'C';
  let n = 0;
  for (const [k, v] of counts) {
    if (v > n) {
      n = v;
      best = k;
    }
  }
  return best;
}
