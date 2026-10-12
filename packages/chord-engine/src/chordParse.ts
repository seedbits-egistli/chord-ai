import { nameToPc, pcToName, preferFlatsForKey, rootTokenLength } from './notes.js';
import type { ChordLabel, ChordQuality } from './types.js';

/** Map quality aliases → canonical quality */
const QUALITY_ALIASES: Array<[RegExp, ChordQuality]> = [
  [/^maj9$/i, 'maj9'],
  [/^M9$/, 'maj9'],
  [/^min9$/i, 'min9'],
  [/^m9$/, 'min9'],
  [/^maj7$/i, 'maj7'],
  [/^M7$/, 'maj7'],
  [/^Δ7?$/, 'maj7'],
  [/^min7$/i, 'min7'],
  [/^m7$/, 'min7'],
  [/^m7b5$/i, 'm7b5'],
  [/^ø7?$/, 'm7b5'],
  [/^dim7$/i, 'dim7'],
  [/^o7$/, 'dim7'],
  [/^dim$/i, 'dim'],
  [/^o$/, 'dim'],
  [/^aug$/i, 'aug'],
  [/^\+$/, 'aug'],
  [/^sus2$/i, 'sus2'],
  [/^sus4$/i, 'sus4'],
  [/^sus$/i, 'sus4'],
  [/^7sus4$/i, '7sus4'],
  [/^add9$/i, 'add9'],
  [/^add2$/i, 'add9'],
  [/^min6$/i, 'min6'],
  [/^m6$/, 'min6'],
  [/^6$/, '6'],
  [/^9$/, '9'],
  [/^11$/, '11'],
  [/^13$/, '13'],
  [/^7$/, '7'],
  [/^min$/i, 'min'],
  [/^m$/, 'min'],
  [/^-$/, 'min'],
  [/^maj$/i, 'maj'],
  [/^M$/, 'maj'],
  [/^$/, 'maj'],
];

const QUALITY_SYMBOL: Record<ChordQuality, string> = {
  maj: '',
  min: 'm',
  '7': '7',
  maj7: 'maj7',
  min7: 'm7',
  dim: 'dim',
  dim7: 'dim7',
  m7b5: 'm7b5',
  aug: 'aug',
  sus2: 'sus2',
  sus4: 'sus4',
  '6': '6',
  min6: 'm6',
  '9': '9',
  maj9: 'maj9',
  min9: 'm9',
  add9: 'add9',
  '11': '11',
  '13': '13',
  '7sus4': '7sus4',
};

export function parseChord(input: string): ChordLabel | null {
  let s = input.trim();
  if (!s || s === 'N' || s === 'N.C.' || s.toLowerCase() === 'nc') return null;

  let bass: number | undefined;
  const slash = s.indexOf('/');
  if (slash >= 0) {
    const bassName = s.slice(slash + 1);
    const b = nameToPc(bassName);
    if (b === null) return null;
    bass = b;
    s = s.slice(0, slash);
  }

  const rootLen = rootTokenLength(s);
  const rootName = s.slice(0, rootLen);
  const root = nameToPc(rootName);
  if (root === null) return null;

  const qualStr = s.slice(rootLen);
  let quality: ChordQuality | null = null;
  for (const [re, q] of QUALITY_ALIASES) {
    if (re.test(qualStr)) {
      quality = q;
      break;
    }
  }
  if (!quality) return null;

  const label: ChordLabel = { root, quality };
  if (bass !== undefined && bass !== root) label.bass = bass;
  return label;
}

export function formatChord(label: ChordLabel, keyOrFlats: string | boolean = false): string {
  const useFlats = typeof keyOrFlats === 'boolean' ? keyOrFlats : preferFlatsForKey(keyOrFlats);
  let out = pcToName(label.root, useFlats) + QUALITY_SYMBOL[label.quality];
  if (label.bass !== undefined && label.bass !== label.root) {
    out += '/' + pcToName(label.bass, useFlats);
  }
  return out;
}

/** Complexity rank used for simplify penalty (higher = more complex) */
export function qualityComplexity(q: ChordQuality): number {
  switch (q) {
    case 'maj':
    case 'min':
      return 0;
    case 'sus2':
    case 'sus4':
    case 'dim':
    case 'aug':
      return 1;
    case '7':
    case 'maj7':
    case 'min7':
    case '6':
    case 'min6':
    case '7sus4':
      return 2;
    case 'dim7':
    case 'm7b5':
    case 'add9':
    case '9':
      return 3;
    case 'maj9':
    case 'min9':
    case '11':
    case '13':
      return 4;
    default:
      return 2;
  }
}

/** Collapse to maj/min (optionally keep plain 7) based on simplify level 0..1 */
export function simplifyLabel(label: ChordLabel, level: number): ChordLabel {
  if (level <= 0) return { ...label };
  const out: ChordLabel = { root: label.root, quality: label.quality };
  if (label.bass !== undefined) out.bass = label.bass;

  if (level >= 0.85) {
    // Force triad only
    if (['min', 'min7', 'min6', 'min9', 'm7b5', 'dim', 'dim7'].includes(out.quality)) {
      out.quality = out.quality === 'dim' || out.quality === 'dim7' ? 'dim' : 'min';
    } else if (out.quality === 'aug') {
      out.quality = 'aug';
    } else if (out.quality === 'sus2' || out.quality === 'sus4' || out.quality === '7sus4') {
      out.quality = out.quality === 'sus2' ? 'sus2' : 'sus4';
      if (level >= 0.95) out.quality = 'maj';
    } else {
      out.quality = 'maj';
    }
    if (level >= 0.95) delete out.bass;
    return out;
  }

  if (level >= 0.5) {
    // Keep maj/min/7/sus/dim/aug; drop extensions
    const map: Partial<Record<ChordQuality, ChordQuality>> = {
      maj9: 'maj7',
      min9: 'min7',
      '9': '7',
      '11': '7',
      '13': '7',
      add9: 'maj',
      '6': 'maj',
      min6: 'min',
      maj7: level >= 0.7 ? 'maj' : 'maj7',
      min7: level >= 0.7 ? 'min' : 'min7',
      '7': level >= 0.7 ? 'maj' : '7',
      dim7: 'dim',
      m7b5: 'dim',
      '7sus4': 'sus4',
    };
    out.quality = map[out.quality] ?? out.quality;
    if (level >= 0.7) delete out.bass;
  }
  return out;
}

/** maj/min equivalence class for simplified accuracy scoring */
export function toMajorMinorClass(chord: string): string | null {
  const p = parseChord(chord);
  if (!p) return null;
  const isMin = ['min', 'min7', 'min6', 'min9', 'm7b5', 'dim', 'dim7'].includes(p.quality);
  return formatChord({ root: p.root, quality: isMin ? 'min' : 'maj' }, false);
}
