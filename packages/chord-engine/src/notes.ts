/** Note naming and enharmonic spelling utilities (MIT). */

export const NOTE_NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
export const NOTE_NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

/** Keys that prefer flats in chord spelling */
const FLAT_KEYS = new Set([
  'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb',
  'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm',
]);

const NOTE_TO_PC: Record<string, number> = {
  C: 0, 'B#': 0,
  'C#': 1, Db: 1,
  D: 2,
  'D#': 3, Eb: 3,
  E: 4, Fb: 4,
  F: 5, 'E#': 5,
  'F#': 6, Gb: 6,
  G: 7,
  'G#': 8, Ab: 8,
  A: 9,
  'A#': 10, Bb: 10,
  B: 11, Cb: 11,
};

export function preferFlatsForKey(key: string): boolean {
  return FLAT_KEYS.has(key);
}

export function pcToName(pc: number, useFlats: boolean): string {
  const i = ((pc % 12) + 12) % 12;
  return useFlats ? NOTE_NAMES_FLAT[i]! : NOTE_NAMES_SHARP[i]!;
}

export function nameToPc(name: string): number | null {
  const n = name.trim();
  if (n in NOTE_TO_PC) return NOTE_TO_PC[n]!;
  // Try two-char then one-char
  if (n.length >= 2) {
    const two = n.slice(0, 2);
    if (two in NOTE_TO_PC) return NOTE_TO_PC[two]!;
  }
  const one = n.slice(0, 1);
  if (one in NOTE_TO_PC) return NOTE_TO_PC[one]!;
  return null;
}

/** Parse chord root length: "C#m7" -> 2, "Bbmaj7" -> 2, "Am" -> 1 */
export function rootTokenLength(chord: string): number {
  if (chord.length >= 2 && (chord[1] === '#' || chord[1] === 'b')) return 2;
  return 1;
}
