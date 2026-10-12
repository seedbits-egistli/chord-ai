import type { Env } from './types';

export async function checkRateLimit(
  env: Env,
  key: string,
): Promise<{ ok: boolean; remaining: number }> {
  const limit = Number(env.PUBLISH_RATE_LIMIT || 10);
  const windowSec = Number(env.PUBLISH_RATE_WINDOW_SEC || 3600);
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    'SELECT count, window_start FROM rate_limits WHERE key = ?',
  )
    .bind(key)
    .first<{ count: number; window_start: number }>();

  if (!row || now - row.window_start >= windowSec) {
    await env.DB.prepare(
      'INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = 1, window_start = excluded.window_start',
    )
      .bind(key, now)
      .run();
    return { ok: true, remaining: limit - 1 };
  }

  if (row.count >= limit) {
    return { ok: false, remaining: 0 };
  }

  await env.DB.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?')
    .bind(key)
    .run();
  return { ok: true, remaining: limit - row.count - 1 };
}
