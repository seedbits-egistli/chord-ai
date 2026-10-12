import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Decode an audio file to mono Float32 PCM via ffmpeg.
 * Used only in the Node validation harness — never commits audio.
 */
export function loadAudioFile(
  path: string,
  sampleRate = 22050,
): { samples: Float32Array; sampleRate: number; durationSec: number } {
  const dir = mkdtempSync(join(tmpdir(), 'chord-ai-'));
  const out = join(dir, 'audio.f32');
  try {
    const r = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-i',
        path,
        '-ac',
        '1',
        '-ar',
        String(sampleRate),
        '-f',
        'f32le',
        '-acodec',
        'pcm_f32le',
        out,
      ],
      { encoding: 'utf8' },
    );
    if (r.status !== 0) {
      throw new Error(`ffmpeg failed: ${r.stderr?.slice(-500)}`);
    }
    const buf = readFileSync(out);
    const samples = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    return {
      samples,
      sampleRate,
      durationSec: samples.length / sampleRate,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
