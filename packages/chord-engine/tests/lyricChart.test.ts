import { describe, expect, it } from 'vitest';
import { buildLyricChart, renderChordPro, renderUgText } from '../src/v2/lyricChart.js';

const lines = [{ text: 'Hey Jude, don\'t make it bad', section: 0 }, { text: 'Take a sad song', section: 0 }];
const w = (word: string, line: number, start: number) => ({ word, line, start, end: start + 0.3 });
const words = [w('Hey', 0, 0.1), w('Jude,', 0, 0.9), w("don't", 0, 2.9), w('make', 0, 3.4), w('it', 0, 3.9), w('bad', 0, 4.2),
  w('Take', 1, 6.6), w('a', 1, 7.2), w('sad', 1, 7.4), w('song', 1, 8.2)];

describe('lyric chart', () => {
  it('attaches a change to the word sung at/after it, not the nearest earlier word', () => {
    const rows = buildLyricChart(lines, words, [
      { chord: 'F', tMs: 800, endMs: 4150 }, { chord: 'C', tMs: 4150, endMs: 8000 }, { chord: 'F', tMs: 8000, endMs: 9000 },
    ], { beatSec: 0.8 });
    const r0 = rows[0]!;
    if (r0.kind !== 'lyric') throw new Error();
    expect(r0.tokens[1]!.chords).toEqual(['F']); // Jude
    expect(r0.tokens[5]!.chords).toEqual(['C']); // bad (4.2 >= 4.15), not "it"
    const r1 = rows[1]!;
    if (r1.kind !== 'lyric') throw new Error();
    expect(r1.tokens[0]!.chords).toEqual([]); // C not repeated at line start
    expect(r1.tokens[3]!.chords).toEqual(['F']); // song
  });
  it('keeps several chords on one word separated by spaces', () => {
    const rows = buildLyricChart([lines[0]!], words.slice(0, 6), [
      { chord: 'F#m7', tMs: 0, endMs: 2950 }, { chord: 'B', tMs: 2950, endMs: 3000 }, { chord: 'A', tMs: 3000, endMs: 5000 },
    ], { beatSec: 0.7 });
    const txt = renderUgText(rows);
    expect(txt).not.toMatch(/F#m7B/);
    expect(renderChordPro(rows)).toContain("[B][A]don't");
  });
});
