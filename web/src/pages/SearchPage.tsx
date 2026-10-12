import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { searchSheets } from '../lib/api';

export function SearchPage() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Array<Record<string, unknown>>>([]);
  const [error, setError] = useState<string | null>(null);

  async function run(query = q) {
    setError(null);
    try {
      const res = await searchSheets(query);
      setResults(res.results || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void run('');
  }, []);

  return (
    <section className="panel">
      <h2>搜尋樂譜</h2>
      <p className="lead">搜尋歌名、歌手、歌詞或和弦進行（FTS）。</p>
      <form
        className="controls"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <input
          style={{ flex: 1, minWidth: 200, padding: '0.65rem 0.8rem', borderRadius: 10, border: '1px solid var(--line)' }}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="例如：Hey Jude 或 C G Am F"
        />
        <button className="btn btn-primary" type="submit">
          搜尋
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      <ul className="search-results">
        {results.map((r) => (
          <li key={String(r.id)}>
            <Link to={`/s/${r.id}`}>
              <strong>{String(r.title)}</strong>
              {r.artist ? ` — ${String(r.artist)}` : ''}
            </Link>
            <div className="status">
              {r.key ? `調 ${String(r.key)} · ` : ''}
              {r.bpm ? `${String(r.bpm)} BPM · ` : ''}
              {r.lyrics_removed ? '歌詞已下架' : ''}
            </div>
          </li>
        ))}
        {!results.length && <li className="status">尚無結果</li>}
      </ul>
    </section>
  );
}
