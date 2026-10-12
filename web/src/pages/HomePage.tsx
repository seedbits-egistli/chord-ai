import { useEffect, useMemo, useState } from 'react';
import {
  applySimplify,
  suggestCapo,
  transposeEvents,
  transposeKey,
  type ChordEvent,
  type DetectionResult,
} from '@chord-ai/engine';
import { analyzeAudio, decodeFile, recordMicrophone } from '../lib/audio';
import { defaultSeparationEnabled } from '../lib/capabilities';
import { publishSheet } from '../lib/api';
import { ChordDiagram } from '../components/ChordDiagram';
import { StaffView } from '../components/StaffView';

const COMMON = [
  'C', 'Cm', 'C7', 'Cmaj7', 'D', 'Dm', 'D7', 'E', 'Em', 'E7',
  'F', 'Fm', 'Fmaj7', 'G', 'Gm', 'G7', 'A', 'Am', 'A7', 'Am7',
  'B', 'Bm', 'B7', 'Bb', 'Eb', 'F#m', 'Asus4', 'A7sus4', 'Dsus4', 'N.C.',
];

export function HomePage() {
  const [status, setStatus] = useState('選擇麥克風或上傳音檔開始（音訊不會上傳）。');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [recording, setRecording] = useState(false);
  const [recorder, setRecorder] = useState<Awaited<ReturnType<typeof recordMicrophone>> | null>(
    null,
  );
  const [raw, setRaw] = useState<DetectionResult | null>(null);
  const [simplify, setSimplify] = useState(0.45);
  const [transpose, setTranspose] = useState(0);
  const [instrument, setInstrument] = useState<'guitar' | 'ukulele'>('guitar');
  const [selected, setSelected] = useState(0);
  const [lyricsText, setLyricsText] = useState('');
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [editLink, setEditLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [separate, setSeparate] = useState(false);
  const [sepHint, setSepHint] = useState('偵測裝置能力中…');
  const [webgpu, setWebgpu] = useState(false);

  useEffect(() => {
    void defaultSeparationEnabled().then((c) => {
      setSeparate(c.enabled);
      setWebgpu(c.webgpu);
      setSepHint(c.reason);
    });
  }, []);

  const view = useMemo(() => {
    if (!raw) return null;
    const simplified = applySimplify(raw, simplify);
    const key = transposeKey(simplified.key, transpose);
    const chords = transposeEvents(simplified.chords, transpose, key);
    return { ...simplified, key, chords, transpose };
  }, [raw, simplify, transpose]);

  const capo = useMemo(() => {
    if (!view) return null;
    return suggestCapo(
      view.chords.map((c) => c.chord),
      instrument,
    );
  }, [view, instrument]);

  const uniqueChords = useMemo(() => {
    if (!view) return [] as string[];
    return [...new Set(view.chords.map((c) => c.chord))].slice(0, 12);
  }, [view]);

  async function runDetect(samples: Float32Array, sampleRate: number) {
    setBusy(true);
    setError(null);
    setProgress(5);
    setStatus(
      separate
        ? '音源分離（HTDemucs，音訊不離開此裝置）…'
        : '正在分析和弦（瀏覽器內處理）…',
    );
    try {
      const result = await analyzeAudio(samples, sampleRate, {
        separate,
        preferWebGpu: webgpu,
        detect: {
          simplifyLevel: simplify,
          suppressDrone: !separate,
        },
        onProgress: (p, detail) => {
          setProgress(Math.round(p * 100));
          if (detail) setStatus(detail);
        },
      });
      setProgress(100);
      setRaw(result);
      setTranspose(0);
      setSelected(0);
      setStatus(
        `完成：調性 ${result.key}、約 ${result.bpm} BPM、${result.chords.length} 個和弦區塊` +
          (result.usedSeparation ? '（已做人聲／鼓分離）' : '。'),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('分析失敗');
    } finally {
      setBusy(false);
    }
  }

  async function onUpload(file: File | null) {
    if (!file) return;
    setBusy(true);
    setStatus(`解碼 ${file.name}…`);
    setProgress(5);
    try {
      const { samples, sampleRate } = await decodeFile(file);
      setProgress(15);
      await runDetect(samples, sampleRate);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  async function startMic() {
    setError(null);
    try {
      const rec = await recordMicrophone();
      setRecorder(rec);
      setRecording(true);
      setStatus('錄音中…再按一次停止並分析。');
    } catch {
      setError('無法開啟麥克風（需要 HTTPS 或 localhost，並允許權限）。');
    }
  }

  async function stopMic() {
    if (!recorder) return;
    setRecording(false);
    setBusy(true);
    setStatus('整理錄音…');
    const { samples, sampleRate } = await recorder.stop();
    setRecorder(null);
    await runDetect(samples, sampleRate);
  }

  function updateChord(idx: number, next: string) {
    if (!raw) return;
    const chords = raw.chords.map((c, i) => (i === idx ? { ...c, chord: next } : c));
    // merge neighbours
    const merged: ChordEvent[] = [];
    for (const c of chords) {
      const last = merged[merged.length - 1];
      if (last && last.chord === c.chord) last.endMs = c.endMs;
      else merged.push({ ...c });
    }
    setRaw({ ...raw, chords: merged });
  }

  function alignLyrics(chords: ChordEvent[], text: string) {
    const lines = text.split(/\n/).map((t) => t.trim()).filter(Boolean);
    if (!lines.length) return [] as Array<{ lineIdx: number; text: string; startMs: number; endMs: number }>;
    const total = chords[chords.length - 1]?.endMs || 1;
    return lines.map((line, i) => {
      const startMs = Math.round((i / lines.length) * total);
      const endMs = Math.round(((i + 1) / lines.length) * total);
      return { lineIdx: i, text: line, startMs, endMs };
    });
  }

  function chordsForLine(
    chords: ChordEvent[],
    lineIdx: number,
    lineCount: number,
  ): ChordEvent[] {
    if (!chords.length || !lineCount) return [];
    const total = chords[chords.length - 1]!.endMs;
    const a = (lineIdx / lineCount) * total;
    const b = ((lineIdx + 1) / lineCount) * total;
    return chords.filter((c) => c.tMs < b && c.endMs > a);
  }

  async function onPublish() {
    if (!view) return;
    if (!title.trim()) {
      setError('請填寫歌曲標題');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const lyrics = alignLyrics(view.chords, lyricsText);
      const res = await publishSheet({
        title: title.trim(),
        artist: artist.trim(),
        key: view.key,
        transpose,
        bpm: view.bpm,
        timeSig: view.timeSig,
        capo: capo?.capo ?? 0,
        instrument,
        mode: 'detect',
        chords: view.chords.map((c, i) => ({
          tMs: c.tMs,
          endMs: c.endMs,
          beat: c.beat,
          chord: c.chord,
          lineIdx: lyrics.length
            ? Math.min(
                lyrics.length - 1,
                Math.floor((c.tMs / (view.chords[view.chords.length - 1]!.endMs || 1)) * lyrics.length),
              )
            : null,
          strum: i % 4 === 0 ? 'D DU UDU' : null,
        })),
        lyrics,
      });
      setEditLink(res.editUrl);
      setStatus(`已發布！公開連結 /s/${res.id} — 請立刻保存秘密編輯連結。`);
      window.history.replaceState({}, '', res.viewUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const lyricLines = lyricsText.split(/\n/).map((t) => t.trim()).filter(Boolean);

  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <h1 className="brand" style={{ fontSize: 'clamp(2.6rem, 8vw, 4.6rem)' }}>
            Chord AI
          </h1>
          <p>
            打開就能用：麥克風或音檔進、和弦時間軸出。音訊只在你的裝置裡分析，永遠不上傳、不存檔。
          </p>
          <div className="cta-row">
            {!recording ? (
              <button className="btn btn-primary" disabled={busy} onClick={startMic}>
                開始錄音
              </button>
            ) : (
              <button className="btn btn-primary" onClick={stopMic}>
                停止並分析
              </button>
            )}
            <label className="btn btn-secondary" style={{ cursor: 'pointer' }}>
              上傳音檔
              <input
                type="file"
                accept="audio/*,.mp3,.wav,.m4a,.ogg"
                hidden
                disabled={busy}
                onChange={(e) => onUpload(e.target.files?.[0] || null)}
              />
            </label>
          </div>
          <label
            style={{
              display: 'flex',
              gap: '0.5rem',
              alignItems: 'flex-start',
              marginTop: '1rem',
              maxWidth: '36rem',
              fontSize: '0.92rem',
              color: 'var(--ink-soft)',
            }}
          >
            <input
              type="checkbox"
              checked={separate}
              disabled={busy}
              onChange={(e) => setSeparate(e.target.checked)}
              style={{ marginTop: '0.2rem' }}
            />
            <span>
              <strong style={{ color: 'var(--ink)' }}>音源分離（HTDemucs）</strong>
              — 先去掉人聲／鼓再辨識和弦，並用貝斯軌強化根音。首次需下載約 172MB
              模型（可改託管於 R2）。{sepHint}
            </span>
          </label>
        </div>
        <div className="hero-visual" aria-hidden>
          <div className="wave" />
        </div>
      </section>

      <div className="panel" style={{ marginTop: '1rem' }}>
        <div className="progress" aria-hidden>
          <span style={{ width: `${progress}%` }} />
        </div>
        <p className="status">{status}</p>
        {error && <p className="error">{error}</p>}
      </div>

      {view && (
        <>
          <section className="panel" style={{ marginTop: '1rem' }}>
            <h2>和弦時間軸</h2>
            <p className="lead">
              調性 {view.key} · {view.bpm} BPM · 點一下即可改和弦
            </p>
            <div className="controls">
              <label>
                簡化和弦
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={simplify}
                  onChange={(e) => setSimplify(Number(e.target.value))}
                />
              </label>
              <label>
                移調（半音）
                <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                  <button
                    className="btn btn-secondary"
                    type="button"
                    onClick={() => setTranspose((t) => Math.max(-11, t - 1))}
                  >
                    −
                  </button>
                  <strong>{transpose >= 0 ? `+${transpose}` : transpose}</strong>
                  <button
                    className="btn btn-secondary"
                    type="button"
                    onClick={() => setTranspose((t) => Math.min(11, t + 1))}
                  >
                    ＋
                  </button>
                </div>
              </label>
              <label>
                樂器
                <select
                  value={instrument}
                  onChange={(e) => setInstrument(e.target.value as 'guitar' | 'ukulele')}
                >
                  <option value="guitar">吉他</option>
                  <option value="ukulele">烏克麗麗</option>
                </select>
              </label>
            </div>
            {capo && (
              <p className="status">
                Capo 建議：{capo.summary}
                {capo.capo > 0 ? `（形狀：${capo.shapes.slice(0, 6).join(' ')}…）` : ''}
              </p>
            )}
            <div className="chord-timeline">
              {view.chords.map((c, i) => (
                <button
                  key={`${c.tMs}-${i}`}
                  type="button"
                  className={`chord-chip ${selected === i ? 'active' : ''}`}
                  onClick={() => setSelected(i)}
                >
                  {c.chord}
                  <span className="t">{(c.tMs / 1000).toFixed(1)}s</span>
                </button>
              ))}
            </div>
            <div className="controls">
              <label>
                編輯選中和弦
                <select
                  value={view.chords[selected]?.chord || ''}
                  onChange={(e) => updateChord(selected, e.target.value)}
                >
                  {[view.chords[selected]?.chord, ...COMMON]
                    .filter(Boolean)
                    .filter((v, i, a) => a.indexOf(v) === i)
                    .map((ch) => (
                      <option key={ch} value={ch!}>
                        {ch}
                      </option>
                    ))}
                </select>
              </label>
            </div>
          </section>

          <section className="grid-2" style={{ marginTop: '1rem' }}>
            <div className="panel">
              <h2>{instrument === 'guitar' ? '吉他' : '烏克麗麗'}按法</h2>
              <p className="lead">隨移調同步更新（chords-db + svguitar）</p>
              <div className="fingerings">
                {uniqueChords.map((ch) => (
                  <ChordDiagram key={ch} chord={ch} instrument={instrument} />
                ))}
              </div>
            </div>
            <div className="panel">
              <h2>五線譜（草稿）</h2>
              <p className="lead">以和弦根音產生簡易 lead sheet（abcjs）</p>
              <StaffView chords={view.chords} keySig={view.key} bpm={view.bpm} />
            </div>
          </section>

          <section className="panel" style={{ marginTop: '1rem' }}>
            <h2>歌詞對齊</h2>
            <p className="lead">貼上歌詞；和弦會依時間均分到各行上方（可再手動微調後發布）。</p>
            <div className="field">
              <textarea
                rows={6}
                placeholder={'一行一句歌詞…\n例如：Hey Jude, don\'t make it bad'}
                value={lyricsText}
                onChange={(e) => setLyricsText(e.target.value)}
              />
            </div>
            {lyricLines.length > 0 && (
              <div className="lyrics">
                {lyricLines.map((line, i) => (
                  <div className="lyric-line" key={i}>
                    <div className="lyric-chords">
                      {chordsForLine(view.chords, i, lyricLines.length).map((c, j) => (
                        <span key={j}>{c.chord}</span>
                      ))}
                    </div>
                    <div>{line}</div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="panel" style={{ marginTop: '1rem' }}>
            <h2>匿名發布</h2>
            <p className="lead">
              不用登入。發布後會給你一組秘密編輯連結（只顯示一次）。音訊不會上傳。
            </p>
            <div className="field">
              <label>歌名</label>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="歌名" />
            </div>
            <div className="field">
              <label>歌手</label>
              <input value={artist} onChange={(e) => setArtist(e.target.value)} placeholder="歌手（選填）" />
            </div>
            <button className="btn btn-primary" disabled={busy} onClick={onPublish}>
              發布到公開庫
            </button>
            {editLink && (
              <p className="status" style={{ marginTop: '0.75rem' }}>
                秘密編輯連結（請保存）： <code>{editLink}</code>
              </p>
            )}
          </section>
        </>
      )}
    </>
  );
}
