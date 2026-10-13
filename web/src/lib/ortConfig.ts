/** ORT worker config passed through the Worker `name`: thread count (?ort_threads=N) and EP (?ort_ep=wasm|webgpu|auto). */
export function ortWorkerConfig(maxThreads = 4): string {
  const q = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
  const iso = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
  const threads = Number(q.get('ort_threads') ?? (iso ? Math.min(maxThreads, navigator.hardwareConcurrency || 1) : 1));
  const ep = q.get('ort_ep') ?? 'auto';
  return JSON.stringify({ threads, ep });
}

export function readOrtWorkerConfig(name: string): { threads: number; ep: string } {
  try {
    const c = JSON.parse(name || '{}') as { threads?: number; ep?: string };
    return { threads: Math.max(1, c.threads ?? 1), ep: c.ep ?? 'auto' };
  } catch {
    return { threads: 1, ep: 'auto' };
  }
}
