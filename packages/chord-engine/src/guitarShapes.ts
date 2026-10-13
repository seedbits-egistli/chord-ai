/**
 * Hand-written guitar voicing data (standard tuning, low E → high e).
 * Written for this project (MIT); not derived from GPL/NC chord databases.
 * -1 = muted string, 0 = open string, n = absolute fret.
 */
import { parseChord } from './chordParse.js';
import type { ChordQuality } from './types.js';

export interface GuitarVoicing {
  /** Shape name as played (relative to capo), e.g. "G", "Bm" */
  name: string;
  /** 6 entries, low E → high e. -1 mute, 0 open, else absolute fret (relative to capo). */
  frets: number[];
  /** Barre fret (absolute), if a barre is used */
  barreFret?: number;
  /** Open-position chord (no barre, within first 3 frets) */
  open: boolean;
  /** Playing difficulty, 1 = easy open chord … 4 = hard */
  difficulty: number;
}

/** Standard tuning, MIDI (E2 A2 D3 G3 B3 E4). */
export const GUITAR_TUNING_MIDI = [40, 45, 50, 55, 59, 64];

type OpenEntry = [frets: number[], difficulty: number, barreFret?: number];

/** Common first-position shapes. Difficulty: 1 easy, 1.5 slightly harder, 2.5 small barre. */
const OPEN: Record<string, OpenEntry> = {
  C: [[-1, 3, 2, 0, 1, 0], 1],
  A: [[-1, 0, 2, 2, 2, 0], 1],
  G: [[3, 2, 0, 0, 0, 3], 1],
  E: [[0, 2, 2, 1, 0, 0], 1],
  D: [[-1, -1, 0, 2, 3, 2], 1],
  Am: [[-1, 0, 2, 2, 1, 0], 1],
  Em: [[0, 2, 2, 0, 0, 0], 1],
  Dm: [[-1, -1, 0, 2, 3, 1], 1],
  E7: [[0, 2, 0, 1, 0, 0], 1],
  A7: [[-1, 0, 2, 0, 2, 0], 1],
  D7: [[-1, -1, 0, 2, 1, 2], 1.2],
  G7: [[3, 2, 0, 0, 0, 1], 1.2],
  C7: [[-1, 3, 2, 3, 1, 0], 1.5],
  B7: [[-1, 2, 1, 2, 0, 2], 1.5],
  Am7: [[-1, 0, 2, 0, 1, 0], 1],
  Em7: [[0, 2, 2, 0, 3, 0], 1],
  Dm7: [[-1, -1, 0, 2, 1, 1], 1.2],
  Cmaj7: [[-1, 3, 2, 0, 0, 0], 1],
  Fmaj7: [[-1, -1, 3, 2, 1, 0], 1.3],
  Gmaj7: [[3, 2, 0, 0, 0, 2], 1.3],
  Amaj7: [[-1, 0, 2, 1, 2, 0], 1.2],
  Dmaj7: [[-1, -1, 0, 2, 2, 2], 1.2],
  Asus4: [[-1, 0, 2, 2, 3, 0], 1],
  Dsus4: [[-1, -1, 0, 2, 3, 3], 1],
  Esus4: [[0, 2, 2, 2, 0, 0], 1],
  Asus2: [[-1, 0, 2, 2, 0, 0], 1],
  Dsus2: [[-1, -1, 0, 2, 3, 0], 1],
  A7sus4: [[-1, 0, 2, 0, 3, 0], 1],
  E7sus4: [[0, 2, 0, 2, 0, 0], 1],
  D7sus4: [[-1, -1, 0, 2, 1, 3], 1.3],
  F: [[1, 3, 3, 2, 1, 1], 2.5, 1],
  Bm: [[-1, 2, 4, 4, 3, 2], 2.5, 2],
};

/** Movable barre forms, offsets from the root fret. */
const E_FORM: Partial<Record<ChordQuality, number[]>> = {
  maj: [0, 2, 2, 1, 0, 0],
  min: [0, 2, 2, 0, 0, 0],
  '7': [0, 2, 0, 1, 0, 0],
  min7: [0, 2, 0, 0, 0, 0],
  sus4: [0, 2, 2, 2, 0, 0],
  '7sus4': [0, 2, 0, 2, 0, 0],
};
const A_FORM: Partial<Record<ChordQuality, number[]>> = {
  maj: [-1, 0, 2, 2, 2, 0],
  min: [-1, 0, 2, 2, 1, 0],
  '7': [-1, 0, 2, 0, 2, 0],
  min7: [-1, 0, 2, 0, 1, 0],
  maj7: [-1, 0, 2, 1, 2, 0],
  sus4: [-1, 0, 2, 2, 3, 0],
  sus2: [-1, 0, 2, 2, 0, 0],
  '7sus4': [-1, 0, 2, 0, 3, 0],
};

const QUALITY_SUFFIX: Partial<Record<ChordQuality, string>> = {
  maj: '', min: 'm', '7': '7', maj7: 'maj7', min7: 'm7', sus2: 'sus2', sus4: 'sus4', '7sus4': '7sus4',
};

const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function normName(name: string): string | null {
  const p = parseChord(name);
  if (!p) return null;
  const suf = QUALITY_SUFFIX[p.quality];
  if (suf === undefined) return null;
  return SHARP[p.root]! + suf;
}

/**
 * Voicing for a shape name (slash bass ignored). Open shape when known,
 * otherwise the lower of the E-form (root on 6th string) / A-form barre.
 */
export function getGuitarVoicing(name: string): GuitarVoicing | null {
  const p = parseChord(name);
  if (!p) return null;
  const key = normName(name);
  const flatAlias = name.split('/')[0]!;
  const open = OPEN[flatAlias] ?? (key ? OPEN[key] : undefined);
  if (open) {
    return {
      name: flatAlias,
      frets: open[0].slice(),
      barreFret: open[2],
      open: open[2] === undefined,
      difficulty: open[1],
    };
  }
  const opts: GuitarVoicing[] = [];
  const eForm = E_FORM[p.quality];
  if (eForm) {
    const r = (p.root - 4 + 12) % 12 || 12; // E string root fret 1..12
    opts.push(barre(flatAlias, eForm, r));
  }
  const aForm = A_FORM[p.quality];
  if (aForm) {
    const r = (p.root - 9 + 12) % 12 || 12;
    opts.push(barre(flatAlias, aForm, r));
  }
  if (!opts.length) return null;
  opts.sort((a, b) => a.difficulty - b.difficulty);
  return opts[0]!;
}

function barre(name: string, form: number[], rootFret: number): GuitarVoicing {
  const frets = form.map((o) => (o < 0 ? -1 : o + rootFret));
  // Higher up the neck is a bit harder to reach/read for beginners
  const difficulty = 3 + (rootFret > 7 ? 0.5 : 0) + (form[0]! < 0 ? 0.1 : 0);
  return { name, frets, barreFret: rootFret, open: false, difficulty };
}

/** Difficulty of playing a shape (unknown qualities → 4). */
export function shapeDifficulty(name: string): number {
  return getGuitarVoicing(name)?.difficulty ?? 4;
}

/** MIDI notes (low → high) for a voicing with a capo. */
export function voicingMidi(v: GuitarVoicing, capo = 0): number[] {
  const out: number[] = [];
  for (let i = 0; i < 6; i++) {
    const f = v.frets[i]!;
    if (f < 0) continue;
    out.push(GUITAR_TUNING_MIDI[i]! + f + capo);
  }
  return out;
}
