import type { SongFixture } from './types.js';

/**
 * Reference chord charts for validation.
 * Chord sequences are simplified common arrangements as published on public
 * educational / tab sites (e.g. Ultimate Guitar–style beginner charts,
 * Music Theory Alchemy analyses). Audio is ALWAYS synthesized — we do not
 * download or use commercial recordings.
 */
export const FIXTURES: SongFixture[] = [
  {
    id: 'hey-jude',
    title: 'Hey Jude',
    artist: 'The Beatles',
    key: 'F',
    bpm: 72,
    timeSig: '4/4',
    source:
      'Common public beginner chart (F–C–Bb verse; pollack/educational analyses)',
    // Verse-like loop: | F | C | C | F | Bb | F | C | F |
    segments: [
      { chord: 'F', startBeat: 0, endBeat: 4 },
      { chord: 'C', startBeat: 4, endBeat: 12 },
      { chord: 'F', startBeat: 12, endBeat: 16 },
      { chord: 'Bb', startBeat: 16, endBeat: 20 },
      { chord: 'F', startBeat: 20, endBeat: 24 },
      { chord: 'C', startBeat: 24, endBeat: 28 },
      { chord: 'F', startBeat: 28, endBeat: 32 },
    ],
  },
  {
    id: 'wonderwall',
    title: 'Wonderwall',
    artist: 'Oasis',
    key: 'Em',
    bpm: 87,
    timeSig: '4/4',
    source: 'Music Theory Alchemy / UG-style verse (1 bar each): Em G D A7sus4',
    segments: [
      { chord: 'Em', startBeat: 0, endBeat: 4 },
      { chord: 'G', startBeat: 4, endBeat: 8 },
      { chord: 'D', startBeat: 8, endBeat: 12 },
      { chord: 'A7sus4', startBeat: 12, endBeat: 16 },
      { chord: 'Em', startBeat: 16, endBeat: 20 },
      { chord: 'G', startBeat: 20, endBeat: 24 },
      { chord: 'D', startBeat: 24, endBeat: 28 },
      { chord: 'A7sus4', startBeat: 28, endBeat: 32 },
    ],
  },
  {
    id: 'let-it-be',
    title: 'Let It Be',
    artist: 'The Beatles',
    key: 'C',
    bpm: 72,
    timeSig: '4/4',
    source: 'Standard I–V–vi–IV chart (C G Am F)',
    segments: [
      { chord: 'C', startBeat: 0, endBeat: 4 },
      { chord: 'G', startBeat: 4, endBeat: 8 },
      { chord: 'Am', startBeat: 8, endBeat: 12 },
      { chord: 'F', startBeat: 12, endBeat: 16 },
      { chord: 'C', startBeat: 16, endBeat: 20 },
      { chord: 'G', startBeat: 20, endBeat: 24 },
      { chord: 'F', startBeat: 24, endBeat: 28 },
      { chord: 'C', startBeat: 28, endBeat: 32 },
    ],
  },
  {
    id: 'hotel-california',
    title: 'Hotel California',
    artist: 'Eagles',
    key: 'Bm',
    bpm: 75,
    timeSig: '4/4',
    source: 'National Guitar Academy / common verse Bm F# A E G D Em F#',
    segments: [
      { chord: 'Bm', startBeat: 0, endBeat: 4 },
      { chord: 'F#', startBeat: 4, endBeat: 8 },
      { chord: 'A', startBeat: 8, endBeat: 12 },
      { chord: 'E', startBeat: 12, endBeat: 16 },
      { chord: 'G', startBeat: 16, endBeat: 20 },
      { chord: 'D', startBeat: 20, endBeat: 24 },
      { chord: 'Em', startBeat: 24, endBeat: 28 },
      { chord: 'F#', startBeat: 28, endBeat: 32 },
    ],
  },
  {
    id: 'no-woman-no-cry',
    title: 'No Woman, No Cry',
    artist: 'Bob Marley',
    key: 'C',
    bpm: 78,
    timeSig: '4/4',
    source: 'Common public chart C G Am F (chorus loop)',
    segments: [
      { chord: 'C', startBeat: 0, endBeat: 4 },
      { chord: 'G', startBeat: 4, endBeat: 8 },
      { chord: 'Am', startBeat: 8, endBeat: 12 },
      { chord: 'F', startBeat: 12, endBeat: 16 },
      { chord: 'C', startBeat: 16, endBeat: 20 },
      { chord: 'G', startBeat: 20, endBeat: 24 },
      { chord: 'Am', startBeat: 24, endBeat: 28 },
      { chord: 'F', startBeat: 28, endBeat: 32 },
    ],
  },
  {
    id: 'stand-by-me',
    title: 'Stand By Me',
    artist: 'Ben E. King',
    key: 'A',
    bpm: 105,
    timeSig: '4/4',
    source: 'Common public chart A F#m D E',
    segments: [
      { chord: 'A', startBeat: 0, endBeat: 4 },
      { chord: 'F#m', startBeat: 4, endBeat: 8 },
      { chord: 'D', startBeat: 8, endBeat: 12 },
      { chord: 'E', startBeat: 12, endBeat: 16 },
      { chord: 'A', startBeat: 16, endBeat: 20 },
      { chord: 'F#m', startBeat: 20, endBeat: 24 },
      { chord: 'D', startBeat: 24, endBeat: 28 },
      { chord: 'E', startBeat: 28, endBeat: 32 },
    ],
  },
  {
    id: 'with-or-without-you',
    title: 'With or Without You',
    artist: 'U2',
    key: 'D',
    bpm: 110,
    timeSig: '4/4',
    source: 'Common public chart D A Bm G',
    segments: [
      { chord: 'D', startBeat: 0, endBeat: 4 },
      { chord: 'A', startBeat: 4, endBeat: 8 },
      { chord: 'Bm', startBeat: 8, endBeat: 12 },
      { chord: 'G', startBeat: 12, endBeat: 16 },
      { chord: 'D', startBeat: 16, endBeat: 20 },
      { chord: 'A', startBeat: 20, endBeat: 24 },
      { chord: 'Bm', startBeat: 24, endBeat: 28 },
      { chord: 'G', startBeat: 28, endBeat: 32 },
    ],
  },
];

export function getFixture(id: string): SongFixture | undefined {
  return FIXTURES.find((f) => f.id === id);
}
