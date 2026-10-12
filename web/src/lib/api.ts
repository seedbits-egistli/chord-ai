export interface PublishPayload {
  title: string;
  artist?: string;
  key?: string;
  transpose?: number;
  bpm?: number;
  timeSig?: string;
  capo?: number;
  instrument?: 'guitar' | 'ukulele';
  mode?: string;
  notation?: string;
  chords: Array<{
    tMs: number;
    endMs?: number;
    beat?: number;
    chord: string;
    lineIdx?: number | null;
    charOffset?: number | null;
    strum?: string | null;
  }>;
  lyrics?: Array<{
    lineIdx: number;
    text: string;
    startMs?: number | null;
    endMs?: number | null;
  }>;
  turnstileToken?: string;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error?: string }).error || res.statusText);
  }
  return res.json() as Promise<T>;
}

export async function getConfig() {
  return json<{ turnstileSiteKey: string; skipTurnstile: boolean }>(await fetch('/api/config'));
}

export async function searchSheets(q: string) {
  const url = q ? `/api/sheets/search?q=${encodeURIComponent(q)}` : '/api/sheets/search';
  return json<{ results: Array<Record<string, unknown>> }>(await fetch(url));
}

export async function getSheet(id: string) {
  return json<{
    sheet: Record<string, unknown>;
    chords: Array<Record<string, unknown>>;
    lyrics: Array<Record<string, unknown>>;
    lyricsRemoved: boolean;
  }>(await fetch(`/api/sheets/${id}`));
}

export async function publishSheet(body: PublishPayload) {
  return json<{
    id: string;
    editToken: string;
    editUrl: string;
    viewUrl: string;
  }>(
    await fetch('/api/sheets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export async function updateSheet(id: string, token: string, body: PublishPayload) {
  return json<{ ok: boolean }>(
    await fetch(`/api/sheets/${id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-edit-token': token,
      },
      body: JSON.stringify(body),
    }),
  );
}

export async function reportSheet(
  id: string,
  body: {
    reason: string;
    action: string;
    detail?: string;
    turnstileToken?: string;
  },
) {
  return json<{ ok: boolean; lyricsRemoved?: boolean }>(
    await fetch(`/api/sheets/${id}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}
