import type { ReferenceSegment } from './types.js';

export interface RealSongReference {
  id: string;
  title: string;
  artist: string;
  filename: string;
  key: string;
  bpm: number;
  source: string;
  /**
   * Looping UG progression(s) used to build a phase-aligned reference
   * against the recording (avoids brittle hand-timed section maps).
   */
  loops: Array<{
    /** Chord per bar (4 beats) in SOUNDING key */
    bars: string[];
    /** Approximate start of this material in the song (ms) */
    fromMs: number;
    /** Approximate end (ms); clipped to audio duration at score time */
    toMs: number;
  }>;
  segmentsMs: Array<{ chord: string; startMs: number; endMs: number }>;
}

function expandLoop(
  bpm: number,
  fromMs: number,
  toMs: number,
  bars: string[],
  phaseBars = 0,
): Array<{ chord: string; startMs: number; endMs: number }> {
  const barMs = (4 * 60000) / bpm;
  const out: Array<{ chord: string; startMs: number; endMs: number }> = [];
  let t = fromMs + phaseBars * barMs;
  // rewind to cover fromMs
  while (t > fromMs) t -= bars.length * barMs;
  let i = 0;
  while (t < toMs) {
    const chord = bars[i % bars.length]!;
    const startMs = Math.max(fromMs, t);
    const endMs = Math.min(toMs, t + barMs);
    if (endMs > startMs) out.push({ chord, startMs, endMs });
    t += barMs;
    i++;
  }
  return out;
}

/**
 * Build default segments (phase 0); scoring may re-phase each loop.
 */
function buildSegments(
  bpm: number,
  loops: RealSongReference['loops'],
): Array<{ chord: string; startMs: number; endMs: number }> {
  const segs: Array<{ chord: string; startMs: number; endMs: number }> = [];
  for (const loop of loops) {
    segs.push(...expandLoop(bpm, loop.fromMs, loop.toMs, loop.bars, 0));
  }
  return segs;
}

/**
 * Hey Jude — UG/Drew Bentley in F.
 * Song body: verse loop; late song: coda F–Eb–Bb–F.
 */
function heyJudeRef(): RealSongReference {
  const bpm = 74.5;
  // Verse: |F|C|C|F|Bb|F|C|F|
  const verse = ['F', 'C', 'C', 'F', 'Bb', 'F', 'C', 'F'];
  const coda = ['F', 'Eb', 'Bb', 'F'];
  // Approx: verses/bridges until ~3:05, then long coda (song ~7:05)
  const loops: RealSongReference['loops'] = [
    { bars: verse, fromMs: 0, toMs: 185000 },
    { bars: coda, fromMs: 185000, toMs: 430000 },
  ];
  return {
    id: 'hey-jude-real',
    title: 'Hey Jude',
    artist: 'The Beatles',
    filename: 'hey_jude.mp3',
    key: 'F',
    bpm,
    source:
      'Ultimate Guitar–style / Drew Bentley (F): verse F–C–C–F–Bb–F–C–F; coda F–Eb–Bb–F. Phase-aligned loops. Local audio only.',
    loops,
    segmentsMs: buildSegments(bpm, loops),
  };
}

/**
 * Wonderwall — UG capo 2 → sounding F#m7 A Esus4 B7sus4 (1 bar each).
 * Chorus material often centers on D / F#m / A (Cadd9 Em7 G shapes +2).
 */
function wonderwallRef(): RealSongReference {
  const bpm = 87;
  const verse = ['F#m7', 'A', 'Esus4', 'B7sus4'];
  const chorus = ['D', 'F#m7', 'A', 'F#m7'];
  const loops: RealSongReference['loops'] = [
    { bars: verse, fromMs: 0, toMs: 150000 },
    { bars: chorus, fromMs: 150000, toMs: 210000 },
    { bars: verse, fromMs: 210000, toMs: 250000 },
    { bars: chorus, fromMs: 250000, toMs: 290000 },
  ];
  return {
    id: 'wonderwall-real',
    title: 'Wonderwall',
    artist: 'Oasis',
    filename: 'wonderwall.mp3',
    key: 'F#m',
    bpm,
    source:
      'Ultimate Guitar Wonderwall capo 2; sounding F#m7–A–Esus4–B7sus4 (verse) / D–F#m7–A (chorus). Phase-aligned. Local audio only.',
    loops,
    segmentsMs: buildSegments(bpm, loops),
  };
}

export const REAL_FIXTURES: RealSongReference[] = [heyJudeRef(), wonderwallRef()];

/** Try all bar phases for each loop; return best-scoring segment map. */
export function phaseAlignedSegments(
  ref: RealSongReference,
  scoreFn: (segments: Array<{ chord: string; startMs: number; endMs: number }>) => number,
): Array<{ chord: string; startMs: number; endMs: number }> {
  let bestSegs = ref.segmentsMs;
  let best = -Infinity;
  // Search phase per loop independently is expensive; search global phase 0..bars-1
  // using the first loop's bar count as step, applied to all loops.
  const maxBars = Math.max(...ref.loops.map((l) => l.bars.length), 1);
  for (let phase = 0; phase < maxBars; phase++) {
    const segs: Array<{ chord: string; startMs: number; endMs: number }> = [];
    for (const loop of ref.loops) {
      segs.push(...expandLoop(ref.bpm, loop.fromMs, loop.toMs, loop.bars, phase % loop.bars.length));
    }
    const s = scoreFn(segs);
    if (s > best) {
      best = s;
      bestSegs = segs;
    }
  }
  return bestSegs;
}

export function realSegmentsAsBeats(
  ref: RealSongReference,
): { segments: ReferenceSegment[]; bpm: number } {
  const beatMs = 60000 / ref.bpm;
  const segments: ReferenceSegment[] = ref.segmentsMs.map((s) => ({
    chord: s.chord,
    startBeat: s.startMs / beatMs,
    endBeat: s.endMs / beatMs,
  }));
  return { segments, bpm: ref.bpm };
}
