import { useEffect, useMemo, useRef, useState } from 'react';
import { midiName, SECTION_LABEL, type MelodyNote, type Section, type SectionKind } from '@chord-ai/engine';
import { decodeFile } from '../lib/audio';
import { StagedProgress } from '../components/StagedProgress';
import { CancelledError, type StageState, type V2Stage } from '../lib/v2';
import { analyzeSong, SONG_STAGES, type SongAnalysis } from '../lib/songAnalysis';
import { MelodySynth, melodyMidi, type SynthNote } from '../lib/melodySynth';
import { StaffMelodyView } from '../components/StaffMelodyView';

export const KIND_COLOR: Record<SectionKind, string> = {
  intro: '#94a3b8', verse: '#60a5fa', prechorus: '#a78bfa', chorus: '#f97316', bridge: '#34d399', interlude: '#cbd5e1', outro: '#64748b', section: '#e2e8f0',
};
const PX_PER_SEC = 90;
const ROW = 11;
const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

/** Absolute-time notes of the per-group representative melody, laid onto every occurrence. */
function repNotesAbs(a: SongAnalysis): SynthNote[] {
  const st = a.structure;
  if (!st) return [];
  const b = a.beats;
  const qTime = (q: number) => {
    const i = Math.floor(q / 4), f = (q % 4) / 4;
    if (i + 1 < b.length) return b[i]! + (b[i + 1]! - b[i]!) * f;
    const bl = b.length > 1 ? b[b.length - 1]! - b[b.length - 2]! : 0.5;
    return b[b.length - 1]! + (q / 4 - (b.length - 1)) * bl;
  };
  const qOf = (t: number) => { let i = 0; while (i + 1 < b.length && b[i + 1]! <= t) i++; return i * 4 + Math.round(((t - b[i]!) / ((b[i + 1] ?? b[i]! + 0.5) - b[i]!)) * 4); };
  const out: SynthNote[] = [];
  for (const s of st.sections) {
    const rep = st.repMelody[s.group];
    if (!rep) continue;
    const q0 = qOf(s.start);
    for (const r of rep) { const t = qTime(q0 + r.qOffset); if (t < s.end) out.push({ start: t, end: Math.min(s.end, qTime(q0 + r.qOffset + r.qLen)), midi: r.midi, glideTo: r.glideTo }); }
  }
  return out;
}

export function SongAnalysisPage() {
  const [file, setFile] = useState<File | null>(null);
  const [lyrics, setLyrics] = useState('');
  const [stages, setStages] = useState<Partial<Record<V2Stage, StageState>>>({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [res, setRes] = useState<SongAnalysis | null>(null);
  const [audioUrl, setAudioUrl] = useState('');
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [mode, setMode] = useState<'original' | 'both' | 'melody'>('original');
  const synthOn = mode !== 'original';
  const [origVol, setOrigVol] = useState(0.5);
  const [melVol, setMelVol] = useState(0.8);
  const [showRep, setShowRep] = useState(false);
  const [view, setView] = useState<'roll' | 'staff'>('roll');
  const [melMode, setMelMode] = useState<'clean' | 'raw'>('clean');
  const useClean = melMode === 'clean' && !!res?.cleanNotes?.length;
  const shownNotes = useMemo(() => (useClean ? res!.cleanNotes : res?.notes ?? []), [useClean, res]);
  const shownKey = (useClean ? res?.cleanKey : res?.key) ?? 'C';
  const abortRef = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const synthRef = useRef<MelodySynth | null>(null);

  const rep = useMemo(() => (res ? repNotesAbs(res) : []), [res]);
  const synthNotes = useRef<SynthNote[]>([]);
  synthNotes.current = showRep ? rep : shownNotes;
  (window as unknown as { __saDump?: () => unknown }).__saDump = () => (res ? { ...res, track: undefined } : res);
  (window as unknown as { __saTrack?: () => unknown }).__saTrack = () => (res?.track ? { hop: res.track.hop, f0: Array.from(res.track.f0), conf: Array.from(res.track.conf) } : null);
  (window as unknown as { __saLoad?: (a: SongAnalysis) => void }).__saLoad = (a) => setRes(a); // test hook: render a saved analysis

  async function run() {
    if (!file) return;
    setError(''); setRes(null); setStages({}); setRunning(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const { samples, sampleRate } = await decodeFile(file);
      await analyzeSong(samples, sampleRate, lyrics, {
        onStage: (s) => setStages((p) => ({ ...p, [s.stage]: s })),
        onPartial: (a) => setRes(a),
      }, ac.signal);
    } catch (e) {
      setError(e instanceof CancelledError ? '已取消' : `分析失敗：${e instanceof Error ? e.message : String(e)}`);
    } finally { setRunning(false); }
  }

  useEffect(() => {
    if (!file) return;
    const u = URL.createObjectURL(file);
    setAudioUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  // playback clock
  useEffect(() => {
    let raf = 0;
    const loop = () => { const a = audioRef.current; if (a) setTime(a.currentTime); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // synth follows play/pause/seek
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    synthRef.current ??= new MelodySynth(a, () => synthNotes.current);
    const s = synthRef.current;
    const restart = () => { if (synthOn && !a.paused) s.start(); else s.stop(); };
    const onPlay = () => { setPlaying(true); restart(); };
    const onPause = () => { setPlaying(false); s.stop(); };
    a.addEventListener('play', onPlay); a.addEventListener('pause', onPause); a.addEventListener('seeked', restart);
    restart();
    return () => { a.removeEventListener('play', onPlay); a.removeEventListener('pause', onPause); a.removeEventListener('seeked', restart); };
  }, [synthOn, showRep, audioUrl, res]);
  useEffect(() => { const a = audioRef.current; if (a) a.volume = mode === 'melody' ? 0 : mode === 'both' ? origVol : 1; }, [mode, origVol, audioUrl]);
  useEffect(() => { synthRef.current?.setVolume(melVol); }, [melVol]);
  const exportMidi = () => {
    if (!res) return;
    const bytes = melodyMidi(showRep ? rep : shownNotes, res.beats);
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'audio/midi' }));
    const el = document.createElement('a');
    el.href = url; el.download = `${(file?.name ?? 'melody').replace(/\.[^.]+$/, '')}-melody.mid`; el.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  // current lyric line + word (karaoke)
  const words = res?.lyrics?.words ?? [];
  let wi = -1;
  for (let i = 0; i < words.length; i++) if (words[i]!.start <= time + 0.05) wi = i; else break;
  const curLine = wi >= 0 && time < words[wi]!.end + 4 ? words[wi]!.line : -1;
  const lineWords = curLine >= 0 ? words.map((w, i) => ({ ...w, i })).filter((w) => w.line === curLine) : [];

  const notes = shownNotes;
  const range = useMemo(() => {
    if (!notes.length) return { lo: 48, hi: 72 };
    const ms = notes.map((n) => n.midi).sort((a, b) => a - b);
    return { lo: ms[Math.floor(ms.length * 0.01)]! - 2, hi: ms[Math.ceil(ms.length * 0.99) - 1]! + 2 };
  }, [notes]);
  const H = (range.hi - range.lo + 1) * ROW + 40;
  const W = Math.ceil((res?.duration ?? 0) * PX_PER_SEC) + 60;
  const yOf = (m: number) => (range.hi - m) * ROW + 4;

  // static piano roll
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !res) return;
    c.width = W; c.height = H;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, W, H);
    const X0 = 40;
    for (const s of res.structure?.sections ?? []) {
      g.fillStyle = KIND_COLOR[s.kind] + '22';
      g.fillRect(X0 + s.start * PX_PER_SEC, 0, (s.end - s.start) * PX_PER_SEC, H - 30);
    }
    for (let m = range.lo; m <= range.hi; m++) {
      if ([1, 3, 6, 8, 10].includes(m % 12)) { g.fillStyle = '#0000000a'; g.fillRect(X0, yOf(m), W, ROW); }
    }
    const bars = res.structure?.bars ?? res.downbeats;
    g.strokeStyle = '#94a3b866';
    for (const b of bars) { g.beginPath(); g.moveTo(X0 + b * PX_PER_SEC, 0); g.lineTo(X0 + b * PX_PER_SEC, H - 30); g.stroke(); }
    if (showRep) {
      g.strokeStyle = '#ea580c'; g.lineWidth = 1.5;
      for (const n of rep) g.strokeRect(X0 + n.start * PX_PER_SEC, yOf(n.midi) + 0.5, Math.max(2, (n.end - n.start) * PX_PER_SEC), ROW - 1);
      g.lineWidth = 1;
    }
    g.font = '9px system-ui';
    for (const n of notes) {
      const x = X0 + n.start * PX_PER_SEC, w = Math.max(2, (n.end - n.start) * PX_PER_SEC);
      g.fillStyle = `rgba(37,99,235,${0.35 + 0.6 * n.conf})`;
      if (n.glideTo != null && n.glideTo !== n.midi) {
        // glide: sloped band from start pitch to end pitch
        const y0 = yOf(n.midi) + ROW / 2, y1 = yOf(n.glideTo) + ROW / 2;
        g.beginPath();
        g.moveTo(x, y0 - ROW / 2 + 1); g.lineTo(x + w, y1 - ROW / 2 + 1);
        g.lineTo(x + w, y1 + ROW / 2 - 1); g.lineTo(x, y0 + ROW / 2 - 1); g.closePath();
        g.fillStyle = 'rgba(124,58,237,0.75)';
        g.fill();
      } else {
        g.fillRect(x, yOf(n.midi) + 1, w, ROW - 2);
      }
      if (w > 22) { g.fillStyle = '#fff'; g.fillText(n.glideTo != null && n.glideTo !== n.midi ? `${midiName(n.midi)}→${midiName(n.glideTo)}` : midiName(n.midi), x + 2, yOf(n.midi) + ROW - 3); }
    }
    // left key labels
    g.fillStyle = '#fff'; g.fillRect(0, 0, X0, H);
    g.fillStyle = '#334155';
    for (let m = range.lo; m <= range.hi; m++) if (m % 12 === 0 || m % 12 === 7 || m === range.lo) g.fillText(midiName(m), 4, yOf(m) + ROW - 2);
    // lyrics words
    if (res.lyrics) {
      g.font = '11px system-ui'; g.fillStyle = '#0f172a';
      let lastX = -1e9;
      for (const w of res.lyrics.words) {
        const x = X0 + w.start * PX_PER_SEC;
        const tw = g.measureText(w.word).width;
        const y = x < lastX ? H - 6 : H - 18;
        g.fillText(w.word, x, y);
        lastX = Math.max(lastX, x + tw + 3);
      }
    }
  }, [res, W, H, range, showRep, rep, notes]);

  // auto-scroll the roll to follow the playhead
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !playing) return;
    const x = 40 + time * PX_PER_SEC;
    if (x < el.scrollLeft + 60 || x > el.scrollLeft + el.clientWidth - 120) el.scrollLeft = x - 120;
  }, [time, playing]);

  const sections = res?.structure?.sections ?? [];
  const cur = sections.find((s) => time >= s.start && time < s.end);
  const curNote = notes.find((n) => time >= n.start && time < n.end);
  const dur = res?.duration ?? 1;
  const seek = (t: number) => { const a = audioRef.current; if (a) { a.currentTime = t; } };

  return (
    <main className="container song-analysis" data-testid="song-analysis">
      <h1>歌曲分析</h1>
      <p className="muted">上傳音檔（可貼上歌詞），在瀏覽器裡分析段落與主旋律；音訊不會離開這台裝置。</p>
      <div className="card">
        <input type="file" accept="audio/*" data-testid="audio-file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <textarea data-testid="lyrics-input" rows={5} placeholder="（可選）貼上歌詞，空一行代表新的段落" value={lyrics} onChange={(e) => setLyrics(e.target.value)} style={{ width: '100%', marginTop: 8 }} />
        <button type="button" className="btn" disabled={!file || running} onClick={run} data-testid="analyze">開始分析</button>
        {error && <p className="error">{error}</p>}
      </div>
      {Object.keys(stages).length > 0 && (
        <StagedProgress stages={stages} running={running} order={SONG_STAGES} onCancel={() => abortRef.current?.abort()} />
      )}
      {res && (
        <section className="card">
          <div className="sa-controls">
            <button type="button" className="btn" data-testid="play" onClick={() => { const a = audioRef.current!; if (a.paused) void a.play(); else a.pause(); }}>
              {playing ? '⏸ 暫停' : '▶ 播放'}
            </button>
            <span data-testid="clock">{fmt(time)} / {fmt(dur)}</span>
            <label>播放：<select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)} data-testid="play-mode">
              <option value="original">原曲</option>
              <option value="both">原曲＋旋律（鋼琴）</option>
              <option value="melody">只有旋律（鋼琴）</option>
            </select></label>
            {mode === 'both' && <label>原曲音量 <input type="range" min={0} max={1} step={0.05} value={origVol} onChange={(e) => setOrigVol(+e.target.value)} data-testid="orig-vol" /></label>}
            {synthOn && <label>旋律音量 <input type="range" min={0} max={1.5} step={0.05} value={melVol} onChange={(e) => setMelVol(+e.target.value)} data-testid="mel-vol" /></label>}
            <button type="button" className="btn btn-secondary" onClick={exportMidi} data-testid="export-midi">匯出旋律 .mid</button>
            <label><input type="checkbox" checked={showRep} onChange={(e) => setShowRep(e.target.checked)} data-testid="rep-toggle" /> 段落代表旋律（重複投票）</label>
            <label>旋律：<select value={melMode} onChange={(e) => setMelMode(e.target.value as 'clean' | 'raw')} data-testid="melody-mode">
              <option value="clean">整理後</option>
              <option value="raw">原始偵測</option>
            </select></label>
            <span className="sa-view-toggle" role="group" aria-label="顯示方式">
              <button type="button" className={`btn ${view === 'roll' ? '' : 'btn-secondary'}`} onClick={() => setView('roll')} data-testid="view-roll">鋼琴捲簾</button>
              <button type="button" className={`btn ${view === 'staff' ? '' : 'btn-secondary'}`} onClick={() => setView('staff')} data-testid="view-staff">五線譜</button>
            </span>
            <span className="muted" data-testid="key-sig">調性：{shownKey}</span>
            <span className="muted" data-testid="now">
              {cur ? `目前：${cur.label}` : ''}{curNote ? ` · ${midiName(curNote.midi)}${curNote.glideTo != null && curNote.glideTo !== curNote.midi ? `→${midiName(curNote.glideTo)}（滑音）` : ''}` : ''}
            </span>
          </div>
          <audio ref={audioRef} src={audioUrl} preload="auto" data-testid="song-audio" />
          <div className="sa-sections" data-testid="section-bar">
            {sections.map((s: Section, i) => (
              <button type="button" key={i} title={`${s.label}（${s.group}）${fmt(s.start)}–${fmt(s.end)}`}
                className={`sa-sec ${cur === s ? 'active' : ''}`} onClick={() => seek(s.start)}
                style={{ width: `${((s.end - s.start) / dur) * 100}%`, background: KIND_COLOR[s.kind] }}>
                <span>{s.label}</span>
              </button>
            ))}
            <div className="sa-sec-head" style={{ left: `${(time / dur) * 100}%` }} />
          </div>
          {!res.structure && <p className="muted">段落分析中…</p>}
          {res.lyrics && (
            <div className="sa-lyric-line" data-testid="lyric-line">
              {lineWords.length ? lineWords.map((w) => (
                <span key={w.i} className={w.i === wi ? 'cur' : w.i < wi ? 'past' : ''}>{w.word} </span>
              )) : <span className="muted">♪</span>}
            </div>
          )}
          <div className="sa-legend">
            {(Object.keys(SECTION_LABEL) as SectionKind[]).filter((k) => sections.some((s) => s.kind === k)).map((k) => (
              <span key={k}><i style={{ background: KIND_COLOR[k] }} />{SECTION_LABEL[k]}</span>
            ))}
          </div>
          {view === 'staff' && (
            <StaffMelodyView
              notes={(showRep ? rep : shownNotes).map((n) => ({ ...n, conf: 1, qStart: n.start, qEnd: n.end, ticks: 'ticks' in n ? (n as { ticks: number }).ticks : 0 }))}
              bars={res.structure?.bars ?? res.downbeats}
              keySig={shownKey}
              sections={sections}
              words={res.lyrics?.words ?? []}
              time={time}
            />
          )}
          <div className="sa-roll" ref={scrollRef} data-testid="piano-roll" style={{ display: view === 'roll' ? undefined : 'none' }}>
            <div style={{ position: 'relative', width: W, height: H }}>
              <canvas ref={canvasRef} style={{ width: W, height: H }} />
              {curNote && (
                <div className="sa-note-hl" style={{ left: 40 + curNote.start * PX_PER_SEC, top: yOf(curNote.midi), width: Math.max(4, (curNote.end - curNote.start) * PX_PER_SEC), height: ROW }}>
                  <b>{midiName(curNote.midi)}</b>
                </div>
              )}
              <div className="sa-playhead" style={{ left: 40 + time * PX_PER_SEC, height: H }} />
            </div>
          </div>
          <p className="muted">共 {notes.length} 個旋律音（滑音 {notes.filter((n) => n.glideTo != null).length}） · {sections.length} 個段落 · 拍點 {res.beats.length}
            {Object.keys(res.timings).length > 0 && <> · 耗時 {Object.entries(res.timings).map(([k, v]) => `${k} ${v}s`).join('、')}</>}
          </p>
        </section>
      )}
    </main>
  );
}
