import type { Env } from './types';

export async function verifyTurnstile(
  env: Env,
  token: string | undefined,
  ip: string,
): Promise<boolean> {
  if (env.SKIP_TURNSTILE === '1' || env.SKIP_TURNSTILE === 'true') return true;
  if (!token) return false;
  const body = new URLSearchParams();
  body.set('secret', env.TURNSTILE_SECRET_KEY);
  body.set('response', token);
  if (ip) body.set('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body,
  });
  if (!res.ok) return false;
  const data = (await res.json()) as { success?: boolean };
  return !!data.success;
}
