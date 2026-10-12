/**
 * Persistent ML asset cache (Cache Storage) for ONNX model weights only.
 * ORT wasm/mjs are loaded from same-origin `/ort/` (see sync-ort-runtime.mjs)
 * — do not Cache-Storage those files; blob: dynamic import breaks under COOP/COEP.
 *
 * Bump CACHE_VERSION when model URLs change incompatibly.
 */

export const CACHE_VERSION = 'v2';
export const CACHE_NAME = `chord-ai-ml-${CACHE_VERSION}`;

export type CacheSource = 'memory' | 'cache' | 'network';

export interface CachedAssetInfo {
  url: string;
  label: string;
  cached: boolean;
  bytes: number | null;
}

function absUrl(url: string): string {
  try {
    return new URL(url, self.location?.href ?? 'http://localhost/').href;
  } catch {
    return url;
  }
}

export async function openAssetCache(): Promise<Cache> {
  return caches.open(CACHE_NAME);
}

export async function getCachedResponse(url: string): Promise<Response | undefined> {
  const cache = await openAssetCache();
  return cache.match(absUrl(url));
}

export async function getCachedArrayBuffer(url: string): Promise<ArrayBuffer | null> {
  const hit = await getCachedResponse(url);
  if (!hit) return null;
  return hit.arrayBuffer();
}

export async function putArrayBuffer(
  url: string,
  buf: ArrayBuffer,
  contentType = 'application/octet-stream',
): Promise<void> {
  const cache = await openAssetCache();
  const key = absUrl(url);
  const res = new Response(buf.slice(0), {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(buf.byteLength),
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
  await cache.put(key, res);
}

export async function assetStatus(
  entries: { url: string; label: string }[],
): Promise<CachedAssetInfo[]> {
  const cache = await openAssetCache();
  const out: CachedAssetInfo[] = [];
  for (const e of entries) {
    const hit = await cache.match(absUrl(e.url));
    let bytes: number | null = null;
    if (hit) {
      const cl = hit.headers.get('content-length');
      if (cl) bytes = Number(cl);
      else {
        const ab = await hit.clone().arrayBuffer();
        bytes = ab.byteLength;
      }
    }
    out.push({ url: e.url, label: e.label, cached: !!hit, bytes });
  }
  return out;
}

export async function clearAssetCache(): Promise<void> {
  const names = await caches.keys();
  await Promise.all(
    names.filter((n) => n.startsWith('chord-ai-ml-')).map((n) => caches.delete(n)),
  );
}

/**
 * Fetch interceptor for ONNX model URLs only (not ORT runtime).
 */
export function installFetchCacheInterceptor(shouldCache: (url: string) => boolean): void {
  const g = self as typeof self & { __chordFetchPatched?: boolean };
  if (g.__chordFetchPatched) return;
  g.__chordFetchPatched = true;

  const original = self.fetch.bind(self);
  self.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? absUrl(input)
        : input instanceof URL
          ? input.href
          : input instanceof Request
            ? absUrl(input.url)
            : absUrl(String(input));

    if (!shouldCache(url)) {
      return original(input as RequestInfo, init);
    }

    const cache = await openAssetCache();
    const hit = await cache.match(url);
    if (hit) return hit;

    const res = await original(input as RequestInfo, init);
    if (res.ok && res.type !== 'opaque') {
      try {
        await cache.put(url, res.clone());
      } catch {
        /* quota — ignore */
      }
    }
    return res;
  };
}

export function isOnnxModelUrl(url: string): boolean {
  return /\.onnx(\?|$)/i.test(url) || /huggingface\.co\/.*\.onnx/i.test(url);
}
