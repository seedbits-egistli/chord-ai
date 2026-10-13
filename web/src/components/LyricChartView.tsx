import { useMemo } from 'react';
import { buildLyricChart, type ChartRow, type ChordSpan } from '@chord-ai/engine';
import type { AlignedLyrics } from '../lib/v2';

/**
 * Lyrics with chords: desktop = Ultimate-Guitar style (chord above the word it lands on),
 * mobile (≤ 640px) = inline ChordPro ([F]Jude). Karaoke highlight follows `time` (s) of the local audio.
 */
export function LyricChartView({
  aligned,
  chords,
  beatSec,
  time,
  onSeek,
}: {
  aligned: AlignedLyrics;
  chords: ChordSpan[];
  beatSec: number;
  time: number | null;
  onSeek?: (t: number) => void;
}) {
  const rows: ChartRow[] = useMemo(
    () => buildLyricChart(aligned.lines, aligned.words, chords, { beatSec }),
    [aligned, chords, beatSec],
  );
  const activeChord = useMemo(() => {
    if (time == null) return null;
    let c: string | null = null;
    for (const s of chords) if (s.tMs / 1000 <= time) c = s.chord;
    return c;
  }, [chords, time]);
  const state = (start: number, end: number) =>
    time == null ? '' : time >= start && time < end + 0.15 ? 'on' : time >= end ? 'done' : '';
  let lastSection = -1;
  return (
    <div className="lyric-chart" data-testid="lyric-chart">
      {activeChord && <div className="now-chord" aria-live="polite">{activeChord}</div>}
      {rows.map((r, i) => {
        const brk = r.section !== lastSection && lastSection !== -1;
        lastSection = r.section;
        if (r.kind === 'instrumental') {
          const on = state(r.start, r.end) === 'on';
          return (
            <div key={i} className={`lc-row lc-inst ${brk ? 'lc-break' : ''} ${on ? 'on' : ''}`}>
              {r.chords.map((c, j) => <b key={j}>{c}</b>)}
            </div>
          );
        }
        return (
          <div key={i} className={`lc-row ${brk ? 'lc-break' : ''}`}>
            <div className="lc-ug">
              {r.tokens.map((t, j) => (
                <span
                  key={j}
                  className={`lc-tok ${state(t.start, t.end)}`}
                  onClick={() => onSeek?.(t.start)}
                >
                  <b className="lc-ch">{t.chords.join(' ') || '\u00a0'}</b>
                  <span className="lc-w">{t.text}</span>
                </span>
              ))}
              {r.trailing.length > 0 && (
                <span className="lc-tok"><b className="lc-ch">{r.trailing.join(' ')}</b><span className="lc-w">{'\u00a0'}</span></span>
              )}
            </div>
            <div className="lc-cp">
              {r.tokens.map((t, j) => (
                <span key={j} className={`lc-tok ${state(t.start, t.end)}`} onClick={() => onSeek?.(t.start)}>
                  {t.chords.map((c, k) => <b key={k} className="lc-ch">[{c}]</b>)}
                  {t.text}{' '}
                </span>
              ))}
              {r.trailing.map((c, k) => <b key={k} className="lc-ch">[{c}]</b>)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
