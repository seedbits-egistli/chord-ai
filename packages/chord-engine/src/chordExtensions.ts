import type { ChordLabel, ChordQuality } from './types.js';

/**
 * Post-decode colour-tone pass (training-free).
 *
 * The beat decoder is deliberately conservative (complexity penalty, sus
 * margin, metric priors), so it almost always lands on plain triads. This pass
 * looks at each decoded run of the same triad, averages its chroma over the
 * run, and upgrades the label to 7 / maj7 / m7 / sus2 / sus4 / 7sus4 only when
 * the extra tone carries sustained energy comparable to the triad tones. It
 * never changes the root, so root/tone scores can only move a little.
 */
export interface ExtensionOptions {
  /** Extra tone must reach this fraction of the mean triad-tone energy (above the chroma median floor). Default 0.9. */
  seventhRatio?: number;
  /** maj7 is stricter (the maj7 is the 3rd of the V chord, easy to smear; vocal leakage fakes it). Default Infinity (off): on the bench every maj7 emitted was spurious. */
  maj7Ratio?: number;
  /** sus: the 4th/2nd must reach this fraction of mean root+5th energy... Default 0.8 */
  susRatio?: number;
  /** ...and exceed the 3rd by this factor. Default 1.4. */
  susOverThird?: number;
  /** Minimum run length in beats to consider. Default 2. */
  minBeats?: number;
}

function sameLabel(a: ChordLabel, b: ChordLabel): boolean {
  return a.root === b.root && a.quality === b.quality && a.bass === b.bass;
}

export function decideExtension(
  label: ChordLabel,
  c: ArrayLike<number>,
  opts: ExtensionOptions = {},
): ChordQuality {
  const q = label.quality;
  if (q !== 'maj' && q !== 'min') return q;
  const r = label.root;
  // subtract the chroma noise floor (median bin) so flat/noisy beats add nothing
  const sorted = Array.from({ length: 12 }, (_, i) => c[i] ?? 0).sort((x, y) => x - y);
  const floor = (sorted[5]! + sorted[6]!) / 2;
  const at = (i: number) => Math.max(0, (c[(r + i) % 12] ?? 0) - floor);
  const third = q === 'maj' ? at(4) : at(3);
  const rootE = at(0);
  const fifth = at(7);
  const triadMean = (rootE + third + fifth) / 3;
  if (triadMean <= 1e-6) return q;
  const rf = (rootE + fifth) / 2;
  const sevR = opts.seventhRatio ?? 0.9;
  const majR = opts.maj7Ratio ?? Infinity;
  const susR = opts.susRatio ?? 0.8;
  const over = opts.susOverThird ?? 1.4;
  const b7 = at(10);
  const m7 = at(11);
  const four = at(5);
  const two = at(2);
  const hasB7 = b7 >= sevR * triadMean && b7 > m7;
  // sus: suspended tone strong and the 3rd clearly weaker than it
  // (a) suspended tone strong and clearly above the 3rd, or
  // (b) the 3rd is essentially absent and the suspended tone is still audible
  const noThird = third <= 0.15 * rf;
  const susOk = (t: number) => (t >= susR * rf && t >= over * third) || (noThird && t >= 0.35 * rf);
  const sus4 = susOk(four) && four >= two;
  const sus2 = susOk(two) && !sus4;
  if (sus4) return hasB7 || b7 >= sevR * rf ? '7sus4' : 'sus4';
  if (sus2) return 'sus2';
  if (q === 'min') return hasB7 ? 'min7' : 'min';
  if (hasB7) return '7';
  if (m7 >= majR * triadMean && m7 > b7 && at(0) >= 0.8 * m7) return 'maj7';
  return 'maj';
}

/** Upgrade decoded triad runs whose averaged chroma supports a colour tone. */
export function applyChordExtensions(
  labels: ChordLabel[],
  beatChroma: (ArrayLike<number> | null)[],
  opts: ExtensionOptions = {},
): ChordLabel[] {
  const out = labels.map((l) => ({ ...l }));
  const minBeats = opts.minBeats ?? 2;
  let i = 0;
  while (i < labels.length) {
    let j = i + 1;
    while (j < labels.length && sameLabel(labels[j]!, labels[i]!)) j++;
    if (j - i >= minBeats) {
      const avg = new Float32Array(12);
      let n = 0;
      for (let k = i; k < j; k++) {
        const ch = beatChroma[k];
        if (!ch) continue;
        let m = 0;
        for (let p = 0; p < 12; p++) m = Math.max(m, ch[p]!);
        if (m <= 0) continue;
        for (let p = 0; p < 12; p++) avg[p]! += ch[p]! / m;
        n++;
      }
      if (n >= minBeats) {
        const qn = decideExtension(labels[i]!, avg, opts);
        if (qn !== labels[i]!.quality) for (let k = i; k < j; k++) out[k] = { ...out[k]!, quality: qn };
      }
    }
    i = j;
  }
  return out;
}
