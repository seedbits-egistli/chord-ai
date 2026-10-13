/**
 * Attach chords to aligned lyric words (Ultimate-Guitar style) and render as text / ChordPro.
 * Rules:
 *  - A chord change attaches to the first word sung at/after the change (tolerance ~⅙ beat for early
 *    consonants), never to an earlier word; changes after the last word of a line go to a trailing slot.
 *  - An unchanged chord is not repeated at the start of the next line (but is shown at each new section).
 *  - Several changes on one word are kept in order (rendered with spaces, never glued together).
 *  - Gaps longer than 2 bars between lines become chord-only "instrumental" rows.
 */
export interface ChordSpan { chord: string; tMs: number; endMs: number }
export interface WordTiming { word: string; line: number; start: number; end: number }
export interface LineInfo { text: string; section: number }

export interface ChartToken { text: string; start: number; end: number; chords: string[]; wordIndex: number }
export type ChartRow =
  | { kind: 'lyric'; section: number; line: number; tokens: ChartToken[]; trailing: string[]; start: number; end: number }
  | { kind: 'instrumental'; section: number; chords: string[]; start: number; end: number };

export function buildLyricChart(
  lines: LineInfo[],
  words: WordTiming[],
  chords: ChordSpan[],
  opts: { beatSec: number; beatsPerBar?: number },
): ChartRow[] {
  const beat = opts.beatSec;
  const bar = beat * (opts.beatsPerBar ?? 4);
  const tol = beat / 6;
  const changes = chords.filter((c) => c.chord && c.chord !== 'N').map((c) => ({ t: c.tMs / 1000, chord: c.chord }));
  const chordAt = (t: number) => {
    let r: string | null = null;
    for (const c of changes) if (c.t <= t + 1e-3) r = c.chord;
    return r;
  };
  const byLine: WordTiming[][] = lines.map(() => []);
  words.forEach((w) => { if (w.start >= 0 && byLine[w.line]) byLine[w.line]!.push(w); });
  const rows: ChartRow[] = [];
  let shown: string | null = null;
  let lastSection = -1;
  let prevEnd = -Infinity;
  const valid = lines.map((_, i) => i).filter((i) => byLine[i]!.length);
  valid.forEach((li, vi) => {
    const ws = byLine[li]!;
    const section = lines[li]!.section;
    const first = ws[0]!.start;
    const nextFirst = vi + 1 < valid.length ? byLine[valid[vi + 1]!]![0]!.start : Infinity;
    const lineEnd = Math.min(nextFirst - tol, ws[ws.length - 1]!.end + 2 * beat);
    // instrumental gap before this line
    const gapStart = Number.isFinite(prevEnd) ? prevEnd : 0;
    if (first - gapStart > 2 * bar) {
      const inGap = changes.filter((c) => c.t >= gapStart && c.t < first - tol).map((c) => c.chord);
      const startChord = chordAt(gapStart);
      const seq = [...(startChord && startChord !== shown ? [startChord] : []), ...inGap].filter((c, i, a) => i === 0 || a[i - 1] !== c);
      if (seq.length) {
        rows.push({ kind: 'instrumental', section, chords: seq, start: gapStart, end: first });
        shown = seq[seq.length - 1]!;
      }
    }
    const tokens: ChartToken[] = ws.map((w) => ({ text: w.word, start: w.start, end: w.end, chords: [], wordIndex: words.indexOf(w) }));
    const trailing: string[] = [];
    const push = (arr: string[], c: string) => {
      if (c === shown) return;
      arr.push(c);
      shown = c;
    };
    if (section !== lastSection) shown = null;
    lastSection = section;
    const atStart = chordAt(first + tol);
    // chord in effect when the line starts (unless a change happens right at the first word, handled below)
    const startChange = changes.filter((c) => c.t > first - tol && c.t <= first + tol);
    if (!startChange.length && atStart) push(tokens[0]!.chords, atStart);
    for (const c of changes) {
      if (c.t <= first - tol || c.t >= lineEnd) continue;
      const idx = tokens.findIndex((tk) => tk.start >= c.t - tol);
      if (idx < 0) push(trailing, c.chord);
      else push(tokens[idx]!.chords, c.chord);
    }
    rows.push({ kind: 'lyric', section, line: li, tokens, trailing, start: first, end: ws[ws.length - 1]!.end });
    prevEnd = ws[ws.length - 1]!.end;
  });
  return rows;
}

/** Plain-text UG layout: chord line above lyric line; chords start at their word, at least one space apart. */
export function renderUgText(rows: ChartRow[]): string {
  const out: string[] = [];
  let sec = -1;
  for (const r of rows) {
    if (r.section !== sec && sec !== -1) out.push('');
    sec = r.section;
    if (r.kind === 'instrumental') { out.push(r.chords.join('  ')); continue; }
    let top = '';
    let bot = '';
    const place = (col: number, chords: string[]) => {
      const text = chords.join(' ');
      const at = top.length ? Math.max(col, top.length + 1) : col;
      top = top.padEnd(at) + text;
      return at;
    };
    r.tokens.forEach((t, i) => {
      if (i) bot += ' ';
      let col = bot.length;
      if (t.chords.length) {
        const at = place(col, t.chords);
        if (at > col) { bot = bot.padEnd(at); col = at; }
      }
      bot += t.text;
    });
    if (r.trailing.length) place(bot.length + 1, r.trailing);
    out.push(top.trimEnd(), bot);
  }
  return out.join('\n');
}

/** Inline ChordPro: "[F]Hey Jude". */
export function renderChordPro(rows: ChartRow[]): string {
  const out: string[] = [];
  let sec = -1;
  for (const r of rows) {
    if (r.section !== sec && sec !== -1) out.push('');
    sec = r.section;
    if (r.kind === 'instrumental') { out.push(r.chords.map((c) => `[${c}]`).join(' ')); continue; }
    out.push(
      r.tokens.map((t) => t.chords.map((c) => `[${c}]`).join('') + t.text).join(' ') +
        (r.trailing.length ? ' ' + r.trailing.map((c) => `[${c}]`).join('') : ''),
    );
  }
  return out.join('\n');
}

/** Map every chord name through fn (e.g. simplify + capo shape) and merge equal neighbours. */
export function mapChordSpans(chords: ChordSpan[], fn: (c: string) => string): ChordSpan[] {
  const out: ChordSpan[] = [];
  for (const c of chords) {
    const name = c.chord === 'N' ? 'N' : fn(c.chord);
    const last = out[out.length - 1];
    if (last && last.chord === name) last.endMs = c.endMs;
    else out.push({ ...c, chord: name });
  }
  return out;
}
