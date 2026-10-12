import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env, PublishBody, ReportBody } from './types';
import { hashIp, newId, randomToken, sha256Hex } from './crypto';
import { verifyTurnstile } from './turnstile';
import { checkRateLimit } from './rateLimit';

const app = new Hono<{ Bindings: Env }>();

app.use('/api/*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));

app.get('/api/health', (c) =>
  c.json({ ok: true, name: 'chord-ai', turnstileSiteKey: c.env.TURNSTILE_SITE_KEY }),
);

app.get('/api/config', (c) =>
  c.json({
    turnstileSiteKey: c.env.TURNSTILE_SITE_KEY,
    skipTurnstile: c.env.SKIP_TURNSTILE === '1' || c.env.SKIP_TURNSTILE === 'true',
  }),
);

function clientIp(c: { req: { header: (n: string) => string | undefined } }): string {
  return (
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    '127.0.0.1'
  );
}

app.post('/api/sheets', async (c) => {
  const ip = clientIp(c);
  const body = (await c.req.json()) as PublishBody;
  if (!body.title?.trim() || !Array.isArray(body.chords) || body.chords.length === 0) {
    return c.json({ error: '需要標題與和弦時間軸' }, 400);
  }

  const okTs = await verifyTurnstile(c.env, body.turnstileToken, ip);
  if (!okTs) return c.json({ error: 'Turnstile 驗證失敗' }, 403);

  const ipHash = await hashIp(ip, c.env.IP_HASH_SALT);
  const rl = await checkRateLimit(c.env, `publish:${ipHash}`);
  if (!rl.ok) return c.json({ error: '發布次數過多，請稍後再試', remaining: 0 }, 429);

  const now = Date.now();
  const songId = newId();
  const sheetId = newId();
  const editToken = randomToken(24);
  const editTokenHash = await sha256Hex(editToken);
  const title = body.title.trim().slice(0, 200);
  const artist = (body.artist || '').trim().slice(0, 200);
  const chordsText = body.chords.map((x) => x.chord).join(' ');
  const lyricsText = (body.lyrics || []).map((l) => l.text).join('\n');

  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO songs (id, title, artist, created_at) VALUES (?, ?, ?, ?)',
    ).bind(songId, title, artist, now),
    c.env.DB.prepare(
      `INSERT INTO sheets (
        id, song_id, edit_token_hash, ip_hash, key_sig, default_transpose, bpm, time_sig,
        capo, instrument, mode, chords_json, notation, lyrics_removed, status, report_count,
        version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'public', 0, 1, ?, ?)`,
    ).bind(
      sheetId,
      songId,
      editTokenHash,
      ipHash,
      body.key || null,
      body.transpose ?? 0,
      body.bpm ?? null,
      body.timeSig || '4/4',
      body.capo ?? 0,
      body.instrument || 'guitar',
      body.mode || 'detect',
      JSON.stringify(body.chords),
      body.notation || null,
      now,
      now,
    ),
  ]);

  if (body.lyrics?.length) {
    const stmts = body.lyrics.map((l) =>
      c.env.DB.prepare(
        'INSERT INTO lyric_lines (sheet_id, line_idx, text, start_ms, end_ms, words_json) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(
        sheetId,
        l.lineIdx,
        l.text,
        l.startMs ?? null,
        l.endMs ?? null,
        l.wordsJson ?? null,
      ),
    );
    await c.env.DB.batch(stmts);
  }

  {
    const stmts = body.chords.map((ch, seq) =>
      c.env.DB.prepare(
        'INSERT INTO chord_events (sheet_id, seq, t_ms, beat, chord, line_idx, char_offset, strum) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(
        sheetId,
        seq,
        ch.tMs,
        ch.beat ?? null,
        ch.chord,
        ch.lineIdx ?? null,
        ch.charOffset ?? null,
        ch.strum ?? null,
      ),
    );
    // D1 batch limit — chunk
    for (let i = 0; i < stmts.length; i += 50) {
      await c.env.DB.batch(stmts.slice(i, i + 50));
    }
  }

  await upsertFts(c.env.DB, sheetId, title, artist, lyricsText, chordsText);

  return c.json({
    id: sheetId,
    songId,
    editToken,
    editUrl: `/s/${sheetId}/edit#${editToken}`,
    viewUrl: `/s/${sheetId}`,
    remaining: rl.remaining,
  });
});

async function upsertFts(
  db: D1Database,
  sheetId: string,
  title: string,
  artist: string,
  lyrics: string,
  chordsText: string,
) {
  await db.prepare('DELETE FROM sheets_fts WHERE sheet_id = ?').bind(sheetId).run();
  await db
    .prepare(
      'INSERT INTO sheets_fts(sheet_id, title, artist, lyrics, chords_text) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(sheetId, title, artist, lyrics, chordsText)
    .run();
}

app.get('/api/sheets/search', async (c) => {
  const q = (c.req.query('q') || '').trim();
  const limit = Math.min(50, Number(c.req.query('limit') || 20));
  if (!q) {
    const rows = await c.env.DB.prepare(
      `SELECT sh.id, s.title, s.artist, sh.key_sig AS key, sh.bpm, sh.created_at, sh.lyrics_removed
       FROM sheets sh JOIN songs s ON s.id = sh.song_id
       WHERE sh.status = 'public'
       ORDER BY sh.created_at DESC LIMIT ?`,
    )
      .bind(limit)
      .all();
    return c.json({ results: rows.results });
  }

  // FTS5 trigram — quote tokens lightly
  const ftsQuery = q.replace(/"/g, '').split(/\s+/).filter(Boolean).join(' ');
  try {
    const rows = await c.env.DB.prepare(
      `SELECT sh.id, s.title, s.artist, sh.key_sig AS key, sh.bpm, sh.created_at, sh.lyrics_removed,
              snippet(sheets_fts, 3, '<b>', '</b>', '…', 12) AS snippet
       FROM sheets_fts
       JOIN sheets sh ON sh.id = sheets_fts.sheet_id
       JOIN songs s ON s.id = sh.song_id
       WHERE sheets_fts MATCH ? AND sh.status = 'public'
       LIMIT ?`,
    )
      .bind(ftsQuery, limit)
      .all();
    if ((rows.results?.length || 0) > 0) return c.json({ results: rows.results, q });
  } catch {
    // fall through to LIKE
  }
  const like = `%${q}%`;
  const rows = await c.env.DB.prepare(
    `SELECT sh.id, s.title, s.artist, sh.key_sig AS key, sh.bpm, sh.created_at, sh.lyrics_removed
     FROM sheets sh JOIN songs s ON s.id = sh.song_id
     WHERE sh.status = 'public' AND (s.title LIKE ? OR s.artist LIKE ? OR sh.chords_json LIKE ?)
     ORDER BY sh.created_at DESC LIMIT ?`,
  )
    .bind(like, like, like, limit)
    .all();
  return c.json({ results: rows.results, q, fallback: true });
});

app.get('/api/sheets/:id', async (c) => {
  const id = c.req.param('id');
  const sheet = await c.env.DB.prepare(
    `SELECT sh.*, s.title, s.artist
     FROM sheets sh JOIN songs s ON s.id = sh.song_id
     WHERE sh.id = ?`,
  )
    .bind(id)
    .first();
  if (!sheet) return c.json({ error: '找不到樂譜' }, 404);
  if (sheet.status !== 'public' && sheet.status !== 'hidden') {
    return c.json({ error: '此樂譜已下架' }, 410);
  }

  const chords = await c.env.DB.prepare(
    'SELECT seq, t_ms AS tMs, beat, chord, line_idx AS lineIdx, char_offset AS charOffset, strum FROM chord_events WHERE sheet_id = ? ORDER BY seq',
  )
    .bind(id)
    .all();

  let lyrics: D1Result<Record<string, unknown>>['results'] = [];
  if (!sheet.lyrics_removed) {
    const ly = await c.env.DB.prepare(
      'SELECT line_idx AS lineIdx, text, start_ms AS startMs, end_ms AS endMs, words_json AS wordsJson FROM lyric_lines WHERE sheet_id = ? ORDER BY line_idx',
    )
      .bind(id)
      .all();
    lyrics = ly.results;
  }

  const { edit_token_hash: _h, ip_hash: _ip, ...safe } = sheet as Record<string, unknown>;
  return c.json({
    sheet: safe,
    chords: chords.results,
    lyrics,
    lyricsRemoved: !!sheet.lyrics_removed,
  });
});

app.put('/api/sheets/:id', async (c) => {
  const id = c.req.param('id');
  const token = c.req.header('x-edit-token') || c.req.query('token') || '';
  if (!token) return c.json({ error: '缺少編輯 token' }, 401);
  const tokenHash = await sha256Hex(token);
  const sheet = await c.env.DB.prepare('SELECT * FROM sheets WHERE id = ?').bind(id).first();
  if (!sheet) return c.json({ error: '找不到樂譜' }, 404);
  if (sheet.edit_token_hash !== tokenHash) return c.json({ error: '編輯 token 無效' }, 403);

  const body = (await c.req.json()) as PublishBody;
  const now = Date.now();
  const title = (body.title || '').trim().slice(0, 200);
  const artist = (body.artist || '').trim().slice(0, 200);

  if (title) {
    await c.env.DB.prepare('UPDATE songs SET title = ?, artist = ? WHERE id = ?')
      .bind(title, artist, sheet.song_id)
      .run();
  }

  await c.env.DB.prepare(
    `UPDATE sheets SET key_sig = ?, default_transpose = ?, bpm = ?, time_sig = ?, capo = ?,
     instrument = ?, mode = ?, chords_json = ?, notation = ?, version = version + 1, updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      body.key ?? sheet.key_sig,
      body.transpose ?? sheet.default_transpose,
      body.bpm ?? sheet.bpm,
      body.timeSig ?? sheet.time_sig,
      body.capo ?? sheet.capo,
      body.instrument ?? sheet.instrument,
      body.mode ?? sheet.mode,
      body.chords ? JSON.stringify(body.chords) : sheet.chords_json,
      body.notation ?? sheet.notation,
      now,
      id,
    )
    .run();

  if (body.chords) {
    await c.env.DB.prepare('DELETE FROM chord_events WHERE sheet_id = ?').bind(id).run();
    const stmts = body.chords.map((ch, seq) =>
      c.env.DB.prepare(
        'INSERT INTO chord_events (sheet_id, seq, t_ms, beat, chord, line_idx, char_offset, strum) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(
        id,
        seq,
        ch.tMs,
        ch.beat ?? null,
        ch.chord,
        ch.lineIdx ?? null,
        ch.charOffset ?? null,
        ch.strum ?? null,
      ),
    );
    for (let i = 0; i < stmts.length; i += 50) {
      await c.env.DB.batch(stmts.slice(i, i + 50));
    }
  }

  if (body.lyrics && !sheet.lyrics_removed) {
    await c.env.DB.prepare('DELETE FROM lyric_lines WHERE sheet_id = ?').bind(id).run();
    const stmts = body.lyrics.map((l) =>
      c.env.DB.prepare(
        'INSERT INTO lyric_lines (sheet_id, line_idx, text, start_ms, end_ms, words_json) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(id, l.lineIdx, l.text, l.startMs ?? null, l.endMs ?? null, l.wordsJson ?? null),
    );
    if (stmts.length) await c.env.DB.batch(stmts);
  }

  const song = await c.env.DB.prepare('SELECT title, artist FROM songs WHERE id = ?')
    .bind(sheet.song_id)
    .first<{ title: string; artist: string }>();
  const chordsText = (body.chords || []).map((x) => x.chord).join(' ');
  const lyricsText = sheet.lyrics_removed
    ? ''
    : (body.lyrics || []).map((l) => l.text).join('\n');
  await upsertFts(
    c.env.DB,
    id,
    song?.title || title,
    song?.artist || artist,
    lyricsText,
    chordsText || String(sheet.chords_json || ''),
  );

  return c.json({ ok: true, id });
});

app.post('/api/sheets/:id/report', async (c) => {
  const id = c.req.param('id');
  const ip = clientIp(c);
  const body = (await c.req.json()) as ReportBody;
  const okTs = await verifyTurnstile(c.env, body.turnstileToken, ip);
  if (!okTs) return c.json({ error: 'Turnstile 驗證失敗' }, 403);

  const sheet = await c.env.DB.prepare('SELECT * FROM sheets WHERE id = ?').bind(id).first();
  if (!sheet) return c.json({ error: '找不到樂譜' }, 404);

  const allowedActions = new Set(['remove_lyrics', 'remove_sheet']);
  const allowedReasons = new Set(['copyright_lyrics', 'copyright', 'spam', 'abuse']);
  if (!allowedActions.has(body.action) || !allowedReasons.has(body.reason)) {
    return c.json({ error: '無效的檢舉參數' }, 400);
  }

  const ipHash = await hashIp(ip, c.env.IP_HASH_SALT);
  const reportId = newId();
  const now = Date.now();
  await c.env.DB.prepare(
    'INSERT INTO reports (id, sheet_id, reason, action, detail, ip_hash, created_at, resolved) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
  )
    .bind(reportId, id, body.reason, body.action, body.detail || null, ipHash, now)
    .run();

  if (body.action === 'remove_lyrics' || body.reason === 'copyright_lyrics') {
    await c.env.DB.prepare('DELETE FROM lyric_lines WHERE sheet_id = ?').bind(id).run();
    await c.env.DB.prepare(
      'UPDATE sheets SET lyrics_removed = 1, report_count = report_count + 1, updated_at = ? WHERE id = ?',
    )
      .bind(now, id)
      .run();
    const song = await c.env.DB.prepare(
      'SELECT s.title, s.artist, sh.chords_json FROM sheets sh JOIN songs s ON s.id = sh.song_id WHERE sh.id = ?',
    )
      .bind(id)
      .first<{ title: string; artist: string; chords_json: string }>();
    if (song) {
      const chordsText = (() => {
        try {
          return (JSON.parse(song.chords_json || '[]') as { chord: string }[])
            .map((x) => x.chord)
            .join(' ');
        } catch {
          return '';
        }
      })();
      await upsertFts(c.env.DB, id, song.title, song.artist, '', chordsText);
    }
  } else if (body.action === 'remove_sheet') {
    await c.env.DB.prepare(
      'UPDATE sheets SET report_count = report_count + 1, updated_at = ? WHERE id = ?',
    )
      .bind(now, id)
      .run();
  }

  const threshold = Number(c.env.AUTO_HIDE_REPORT_THRESHOLD || 5);
  const updated = await c.env.DB.prepare('SELECT report_count FROM sheets WHERE id = ?')
    .bind(id)
    .first<{ report_count: number }>();
  if (updated && updated.report_count >= threshold) {
    await c.env.DB.prepare('UPDATE sheets SET status = ? WHERE id = ?')
      .bind('hidden', id)
      .run();
  }

  return c.json({
    ok: true,
    reportId,
    lyricsRemoved: body.action === 'remove_lyrics' || body.reason === 'copyright_lyrics',
  });
});

app.notFound(async (c) => {
  // SPA fallback via assets binding when present
  if (c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.json({ error: 'not found' }, 404);
});

export default app;
