import guitar from '@tombatossals/chords-db/lib/guitar.json';
import ukulele from '@tombatossals/chords-db/lib/ukulele.json';

type InstrumentDb = {
  keys: string[];
  suffixes: string[];
  chords: Record<string, Array<{ key: string; suffix: string; positions: Position[] }>>;
};

type Position = {
  frets: number[];
  fingers: number[];
  barres?: number | number[];
  baseFret: number;
  midi?: number[];
};

const guitarDb = guitar as unknown as InstrumentDb;
const ukeDb = ukulele as unknown as InstrumentDb;

const SUFFIX_MAP: Record<string, string> = {
  '': 'major',
  maj: 'major',
  m: 'minor',
  min: 'minor',
  '7': '7',
  maj7: 'maj7',
  m7: 'm7',
  min7: 'm7',
  dim: 'dim',
  dim7: 'dim7',
  aug: 'aug',
  sus2: 'sus2',
  sus4: 'sus4',
  '7sus4': '7sus4',
  '6': '6',
  m6: 'm6',
  '9': '9',
  maj9: 'maj9',
  m9: 'm9',
  add9: 'add9',
  m7b5: 'm7b5',
};

function splitChord(name: string): { key: string; suffix: string } | null {
  const base = name.split('/')[0]!;
  const m = base.match(/^([A-G][#b]?)(.*)$/);
  if (!m) return null;
  let key = m[1]!;
  // chords-db uses sharp keys mostly; map flats
  const flatToSharp: Record<string, string> = {
    Db: 'C#',
    Eb: 'D#',
    Gb: 'F#',
    Ab: 'G#',
    Bb: 'A#',
  };
  key = flatToSharp[key] || key;
  const raw = m[2] || '';
  const suffix = SUFFIX_MAP[raw] || SUFFIX_MAP[raw.toLowerCase()] || (raw === '' ? 'major' : raw);
  return { key, suffix };
}

export interface FingeringShape {
  chord: string;
  strings: number;
  frets: number[];
  fingers: number[];
  barres: Array<{ fromString: number; toString: number; fret: number }>;
  baseFret: number;
}

export function lookupFingering(
  chord: string,
  instrument: 'guitar' | 'ukulele' = 'guitar',
): FingeringShape | null {
  const db = instrument === 'ukulele' ? ukeDb : guitarDb;
  const parts = splitChord(chord);
  if (!parts) return null;
  const entries = db.chords[parts.key];
  if (!entries) return null;
  const entry =
    entries.find((e) => e.suffix === parts.suffix) ||
    entries.find((e) => e.suffix === 'major' || e.suffix === 'minor');
  if (!entry?.positions?.length) return null;
  const pos = entry.positions[0]!;
  const strings = pos.frets.length;
  const barres: FingeringShape['barres'] = [];
  const barreFrets = pos.barres
    ? Array.isArray(pos.barres)
      ? pos.barres
      : [pos.barres]
    : [];
  for (const bf of barreFrets) {
    barres.push({ fromString: strings, toString: 1, fret: bf });
  }
  return {
    chord,
    strings,
    frets: pos.frets,
    fingers: pos.fingers,
    barres,
    baseFret: pos.baseFret || 1,
  };
}
