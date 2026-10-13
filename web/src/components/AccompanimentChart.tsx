import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ACCOMP_LEVEL_LABEL,
  buildAccompanimentChart,
  chartToStrumEvents,
  type AccompLevel,
  type DetectionResult,
} from '@chord-ai/engine';
import { getChordSynth } from '../lib/chordSynth';
import { ShapeDiagram } from './ShapeDiagram';

const LEVELS: AccompLevel[] = ['simple', 'standard', 'raw'];
const LEVEL_HINT: Record<AccompLevel, string> = {
  simple: '只用大三／小三和弦，每半小節最多一個',
  standard: '加入 7 和 sus 和弦',
  raw: '照偵測結果（含轉位、延伸音）',
};

/**
 * 吉他伴奏譜：capo + 指法 + 刷法 + 小節格（或歌詞上方和弦），可用刷法播放。
 */
export function AccompanimentChart({
  result,
  lyricLines = [],
  volume = 0.7,
}: {
  result: DetectionResult;
  lyricLines?: string[];
  volume?: number;
}) {
  const [level, setLevel] = useState<AccompLevel>('simple');
  const [capoSel, setCapoSel] = useState<'auto' | number>('auto');
  const [playingBar, setPlayingBar] = useState<number | null>(null);
  const timers = useRef<number[]>([]);

  const chart = useMemo(
    () =>
      buildAccompanimentChart(result, {
        level,
        capoOverride: capoSel === 'auto' ? null : capoSel,
      }),
    [result, level, capoSel],
  );

  const stop = () => {
    for (const t of timers.current) window.clearTimeout(t);
    timers.current = [];
    getChordSynth().stopAll();
    setPlayingBar(null);
  };
  useEffect(() => stop, []);

  async function play(fromBar = 0) {
    stop();
    const synth = getChordSynth();
    const ctx = await synth.ensureContext();
    const events = chartToStrumEvents(chart).filter((e) => e.barIndex >= fromBar);
    if (!events.length) return;
    const t0 = events[0]!.tMs;
    const start = ctx.currentTime + 0.08;
    let lastBar = -1;
    for (const e of events) {
      const when = start + (e.tMs - t0) / 1000;
      // down: low→high on all strings; up: high→low on the top 4 strings
      const notes = e.dir === 'D' ? e.midi : e.midi.slice(-4).reverse();
      void synth.playChord(notes, {
        instrument: 'guitar',
        strum: 'strum',
        volume,
        durationSec: Math.max(0.2, e.durMs / 1000 + 0.15),
        when,
      });
      if (e.barIndex !== lastBar) {
        lastBar = e.barIndex;
        const bar = e.barIndex;
        timers.current.push(window.setTimeout(() => setPlayingBar(bar), (e.tMs - t0) + 80));
      }
    }
    const endMs = events[events.length - 1]!.tMs - t0 + events[events.length - 1]!.durMs + 300;
    timers.current.push(window.setTimeout(() => setPlayingBar(null), endMs));
  }

  const firstMusicBar = Math.max(0, chart.bars.findIndex((b) => b.chords.some((c) => c.shape !== 'N')));
  const bars = chart.bars.slice(firstMusicBar);
  const soundingOf = (shape: string) =>
    Object.entries(chart.capo.shapes).find(([, sh]) => sh === shape)?.[0];

  const barCell = (b: (typeof bars)[number]) => (
    <button
      type="button"
      key={b.index}
      className={`accomp-bar ${playingBar === b.index ? 'playing' : ''}`}
      onClick={() => void play(b.index)}
      title="從這小節開始播放"
    >
      {b.chords.map((c, i) => (
        <span key={i} className="accomp-chord" style={{ flex: c.beats }}>
          {c.shape === 'N' ? 'N.C.' : c.shape}
        </span>
      ))}
    </button>
  );

  // lyrics mode: spread bars evenly over lyric lines (time-proportional)
  const lyricRows = lyricLines.length
    ? lyricLines.map((text, i) => ({
        text,
        bars: bars.slice(
          Math.floor((i * bars.length) / lyricLines.length),
          Math.floor(((i + 1) * bars.length) / lyricLines.length),
        ),
      }))
    : [];

  return (
    <section className="panel accomp" style={{ marginTop: '1rem' }}>
      <h2>吉他伴奏譜</h2>
      <p className="lead">
        {chart.capo.summary} · 原調 {chart.key} · {Math.round(chart.bpm)} BPM · {chart.beatsPerBar}/4
      </p>

      <div className="controls">
        <label>
          難度
          <div className="seg">
            {LEVELS.map((l) => (
              <button
                key={l}
                type="button"
                className={`btn ${level === l ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setLevel(l)}
                title={LEVEL_HINT[l]}
              >
                {ACCOMP_LEVEL_LABEL[l]}
              </button>
            ))}
          </div>
        </label>
        <label>
          Capo
          <select
            value={capoSel === 'auto' ? 'auto' : String(capoSel)}
            onChange={(e) => setCapoSel(e.target.value === 'auto' ? 'auto' : Number(e.target.value))}
          >
            <option value="auto">自動（最好彈）</option>
            {[0, 1, 2, 3, 4, 5, 6, 7].map((n) => (
              <option key={n} value={n}>
                {n === 0 ? '不夾' : `第 ${n} 格`}
              </option>
            ))}
          </select>
        </label>
        <div>
          <div className="status">刷法：{chart.strum.name}</div>
          <code className="strum">{chart.strum.label}</code>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'end' }}>
          <button className="btn btn-primary" type="button" onClick={() => void play(firstMusicBar)}>
            ▶ 用刷法播放
          </button>
          <button className="btn btn-secondary" type="button" onClick={stop}>
            ■ 停止
          </button>
        </div>
      </div>
      <p className="status">{LEVEL_HINT[level]}。和弦名稱是夾 Capo 後要按的指法。</p>

      <div className="fingerings">
        {chart.voicings.map((v) => (
          <ShapeDiagram key={v.name} voicing={v} sounding={soundingOf(v.name)} />
        ))}
      </div>

      {lyricRows.length > 0 ? (
        <div className="accomp-lyrics">
          {lyricRows.map((row, i) => (
            <div key={i} className="accomp-lyric-line">
              <div className="accomp-grid">{row.bars.map(barCell)}</div>
              <div className="accomp-lyric-text">{row.text}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="accomp-lines">
          {Array.from({ length: Math.ceil(bars.length / 4) }, (_, r) => (
            <div key={r} className="accomp-grid">
              <span className="accomp-barno">{r * 4 + 1}</span>
              {bars.slice(r * 4, r * 4 + 4).map(barCell)}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
