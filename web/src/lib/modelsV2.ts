/**
 * v2 model registry. Base URL is configurable:
 *   VITE_MODEL_BASE_URL=https://models.example.com/chord-ai/v2   (Cloudflare R2 custom domain)
 * Default '/models' is served from <repo>/models-v2 by the Vite dev server.
 */
export const MODEL_BASE_URL: string = (
  (import.meta.env.VITE_MODEL_BASE_URL as string | undefined) || '/models'
).replace(/\/$/, '');

export interface ModelSpec { key: string; file: string; label: string; approxMB: number; noGraphOpt?: boolean }
export const V2_MODELS = {
  beat: { key: 'beat', file: 'beat-this-small.onnx', label: 'Beat This! small', approxMB: 10.5 },
  btcMajmin: { key: 'btcMajmin', file: 'btc-majmin.onnx', label: 'BTC 大小調', approxMB: 13.0 },
  btcLarge: { key: 'btcLarge', file: 'btc-large.onnx', label: 'BTC 大詞彙', approxMB: 13.1 },
  w2v: { key: 'w2v', file: 'wav2vec2-base-960h-int8.onnx', label: 'wav2vec2（歌詞對齊）', approxMB: 95.2 },
  // HT-Demucs (MIT; ONNX export StemSplitio/htdemucs-onnx, MIT). Graph optimisation must stay off: constant folding inflates memory to GBs.
  htdemucs: { key: 'htdemucs', file: 'htdemucs_fp16weights.onnx', label: 'HT-Demucs（高品質分離）', approxMB: 165.6, noGraphOpt: true },
  w2vLabels: { key: 'w2vLabels', file: 'wav2vec2-labels.json', label: 'labels', approxMB: 0 },
} as const satisfies Record<string, ModelSpec>;

export const modelUrl = (m: ModelSpec) => `${MODEL_BASE_URL}/${m.file}`;
