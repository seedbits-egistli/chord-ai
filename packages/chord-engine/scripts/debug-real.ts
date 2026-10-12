import { join } from 'node:path';
import { loadAudioFile } from '../src/loadAudio.js';
import { detectChords } from '../src/detect.js';
import { scoreAgainstTimedReference } from '../src/accuracy.js';
import { REAL_FIXTURES } from '../src/realFixtures.js';
import { computeChromaFrames, estimateTuningCents, averageChroma } from '../src/chroma.js';
import { topKMatches } from '../src/match.js';
import { formatChord } from '../src/chordParse.js';

const audioDir = process.env.CHORD_AI_TEST_AUDIO ?? '/tmp/chord-ai-test-audio';

for (const ref of REAL_FIXTURES) {
  const path = join(audioDir, ref.filename);
  const { samples, sampleRate } = loadAudioFile(path, 22050);
  const tune = estimateTuningCents(samples, sampleRate);
  console.log('\n===', ref.title, 'tuning cents', tune);

  // Peek chroma at 60s (should be into the song)
  const frames = computeChromaFrames(samples, sampleRate, 8192, 2048, tune);
  for (const t of [5000, 30000, 60000, 90000]) {
    const { chroma, bassChroma } = averageChroma(frames, t, t + 2000);
    const top = topKMatches(chroma, bassChroma, 0.5, 3, ref.key);
    console.log(
      `  @${t / 1000}s top:`,
      top.map((c) => `${formatChord(c.label, false)}=${c.score.toFixed(2)}`).join(', '),
      'chroma',
      [...chroma].map((x) => x.toFixed(2)).join(' '),
    );
  }

  const variants = [
    { name: 'default', opts: { simplifyLevel: 0.5, bpmHint: ref.bpm, suppressDrone: true } },
    { name: 'no-drone', opts: { simplifyLevel: 0.5, bpmHint: ref.bpm, suppressDrone: false } },
    { name: 'simple', opts: { simplifyLevel: 0.85, bpmHint: ref.bpm, suppressDrone: true } },
    { name: 'rich', opts: { simplifyLevel: 0.25, bpmHint: ref.bpm, suppressDrone: true } },
  ];
  for (const v of variants) {
    const result = detectChords(samples, sampleRate, {
      ...v.opts,
      frameSize: 8192,
      hopSize: 2048,
    });
    const score = scoreAgainstTimedReference(result.chords, ref.segmentsMs, {
      bpm: ref.bpm,
      maxOffsetMs: 15000,
      durationMs: Math.min(samples.length / sampleRate * 1000, ref.segmentsMs.at(-1)!.endMs),
    });
    const head = scoreAgainstTimedReference(result.chords, ref.segmentsMs, {
      bpm: ref.bpm,
      maxOffsetMs: 15000,
      durationMs: 120000,
    });
    console.log(
      `  ${v.name}: full ${score.exactPct.toFixed(1)}/${score.majMinPct.toFixed(1)} head2m ${head.exactPct.toFixed(1)}/${head.majMinPct.toFixed(1)} key=${result.key} off=${score.offsetMs}`,
    );
  }
}
