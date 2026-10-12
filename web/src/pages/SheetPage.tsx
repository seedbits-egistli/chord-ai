import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  suggestCapo,
  transposeEvents,
  transposeKey,
  type ChordEvent,
} from '@chord-ai/engine';
import { getSheet, reportSheet, updateSheet } from '../lib/api';
import { ChordDiagram } from '../components/ChordDiagram';
import { StaffView } from '../components/StaffView';

export function SheetPage({ edit = false }: { edit?: boolean }) {
  const { id = '' } = useParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [key, setKey] = useState('C');
  const [bpm, setBpm] = useState(120);
  const [chords, setChords] = useState<ChordEvent[]>([]);
  const [lyrics, setLyrics] = useState<Array<{ lineIdx: number; text: string }>>([]);
  const [lyricsRemoved, setLyricsRemoved] = useState(false);
  const [transpose, setTranspose] = useState(0);
  const [instrument, setInstrument] = useState<'guitar' | 'ukulele'>('guitar');
  const [token, setToken] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (edit && typeof window !== 'undefined') {
      setToken(window.location.hash.replace(/^#/, ''));
    }
  }, [edit]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await getSheet(id);
        if (cancelled) return;
        setTitle(String(data.sheet.title || ''));
        setArtist(String(data.sheet.artist || ''));
        setKey(String(data.sheet.key_sig || data.sheet.key || 'C'));
        setBpm(Number(data.sheet.bpm || 120));
        setTranspose(Number(data.sheet.default_transpose || 0));
        setInstrument((data.sheet.instrument as 'guitar' | 'ukulele') || 'guitar');
        setChords(
          (data.chords || []).map((c) => ({
            tMs: Number(c.tMs),
            endMs: Number(c.tMs) + 500,
            chord: String(c.chord),
            beat: c.beat != null ? Number(c.beat) : undefined,
            lineIdx: c.lineIdx != null ? Number(c.lineIdx) : undefined,
            charOffset: c.charOffset != null ? Number(c.charOffset) : undefined,
            strum: c.strum ? String(c.strum) : undefined,
          })),
        );
        // fix endMs from next
        setChords((prev) =>
          prev.map((c, i) => ({
            ...c,
            endMs: prev[i + 1]?.tMs ?? c.tMs + 1000,
          })),
        );
        setLyrics(
          (data.lyrics || []).map((l) => ({
            lineIdx: Number(l.lineIdx),
            text: String(l.text),
          })),
        );
        setLyricsRemoved(!!data.lyricsRemoved);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const viewKey = transposeKey(key, transpose);
  const viewChords = useMemo(
    () => transposeEvents(chords, transpose, viewKey),
    [chords, transpose, viewKey],
  );
  const capo = useMemo(
    () => suggestCapo(viewChords.map((c) => c.chord), instrument),
    [viewChords, instrument],
  );
  const unique = [...new Set(viewChords.map((c) => c.chord))].slice(0, 12);

  async function onSave() {
    if (!token) {
      setError('缺少編輯 token（網址 # 後面）');
      return;
    }
    try {
      await updateSheet(id, token, {
        title,
        artist,
        key: viewKey,
        transpose,
        bpm,
        instrument,
        chords: viewChords.map((c) => ({
          tMs: c.tMs,
          endMs: c.endMs,
          chord: c.chord,
          lineIdx: c.lineIdx,
          charOffset: c.charOffset,
          strum: c.strum,
        })),
        lyrics: lyrics.map((l) => ({ lineIdx: l.lineIdx, text: l.text })),
      });
      setMsg('已儲存');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onReport(action: 'remove_lyrics' | 'remove_sheet') {
    try {
      await reportSheet(id, {
        reason: action === 'remove_lyrics' ? 'copyright_lyrics' : 'copyright',
        action,
      });
      setMsg(action === 'remove_lyrics' ? '已下架歌詞' : '已送出下架檢舉');
      if (action === 'remove_lyrics') {
        setLyricsRemoved(true);
        setLyrics([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (loading) return <p className="status">載入中…</p>;
  if (error && !title) return <p className="error">{error}</p>;

  return (
    <section className="panel">
      <p className="status">
        <Link to="/search">← 搜尋</Link>
        {edit ? ' · 編輯模式' : ''}
      </p>
      <h2 style={{ fontFamily: 'var(--font-display)', fontSize: '2rem' }}>{title}</h2>
      <p className="lead">
        {artist || '未知歌手'} · 調 {viewKey} · {bpm} BPM
      </p>

      <div className="controls">
        <label>
          移調
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn btn-secondary" type="button" onClick={() => setTranspose((t) => Math.max(-11, t - 1))}>
              −
            </button>
            <strong>{transpose >= 0 ? `+${transpose}` : transpose}</strong>
            <button className="btn btn-secondary" type="button" onClick={() => setTranspose((t) => Math.min(11, t + 1))}>
              ＋
            </button>
          </div>
        </label>
        <label>
          樂器
          <select value={instrument} onChange={(e) => setInstrument(e.target.value as 'guitar' | 'ukulele')}>
            <option value="guitar">吉他</option>
            <option value="ukulele">烏克麗麗</option>
          </select>
        </label>
      </div>
      {capo && <p className="status">Capo 建議：{capo.summary}</p>}

      <div className="chord-timeline">
        {viewChords.map((c, i) => (
          <div className="chord-chip" key={i}>
            {c.chord}
            <span className="t">{(c.tMs / 1000).toFixed(1)}s</span>
          </div>
        ))}
      </div>

      {!lyricsRemoved && lyrics.length > 0 && (
        <div className="lyrics" style={{ marginTop: '1rem' }}>
          {lyrics.map((l) => (
            <div className="lyric-line" key={l.lineIdx}>
              <div className="lyric-chords">
                {viewChords
                  .filter((c) => c.lineIdx === l.lineIdx)
                  .map((c, i) => (
                    <span key={i}>{c.chord}</span>
                  ))}
              </div>
              <div>{l.text}</div>
            </div>
          ))}
        </div>
      )}
      {lyricsRemoved && <p className="status">歌詞已因檢舉下架；和弦時間軸仍保留。</p>}

      <div className="fingerings" style={{ marginTop: '1rem' }}>
        {unique.map((ch) => (
          <ChordDiagram key={ch} chord={ch} instrument={instrument} />
        ))}
      </div>

      <div style={{ marginTop: '1rem' }}>
        <StaffView chords={viewChords} keySig={viewKey} bpm={bpm} />
      </div>

      {edit && (
        <div style={{ marginTop: '1rem' }}>
          <div className="field">
            <label>歌名</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="field">
            <label>歌手</label>
            <input value={artist} onChange={(e) => setArtist(e.target.value)} />
          </div>
          <button className="btn btn-primary" type="button" onClick={onSave}>
            儲存變更
          </button>
        </div>
      )}

      <div className="controls" style={{ marginTop: '1.25rem' }}>
        <button className="btn btn-secondary" type="button" onClick={() => onReport('remove_lyrics')}>
          檢舉：只下架歌詞
        </button>
        <button className="btn btn-secondary" type="button" onClick={() => onReport('remove_sheet')}>
          檢舉整份樂譜
        </button>
      </div>
      {msg && <p className="status">{msg}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
