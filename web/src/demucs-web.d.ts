declare module 'demucs-web' {
  export const CONSTANTS: {
    SAMPLE_RATE: number;
    FFT_SIZE: number;
    HOP_SIZE: number;
    TRAINING_SAMPLES: number;
    TRACKS: string[];
    DEFAULT_MODEL_URL: string;
  };

  export class DemucsProcessor {
    constructor(options: {
      ort: unknown;
      modelPath?: string;
      sessionOptions?: Record<string, unknown>;
      onProgress?: (info: {
        progress: number;
        currentSegment: number;
        totalSegments: number;
      }) => void;
      onLog?: (phase: string, message: string) => void;
      onDownloadProgress?: (loaded: number, total: number) => void;
    });
    loadModel(pathOrBuffer?: string | ArrayBuffer): Promise<unknown>;
    separate(
      left: Float32Array,
      right: Float32Array,
    ): Promise<{
      drums: { left: Float32Array; right: Float32Array };
      bass: { left: Float32Array; right: Float32Array };
      other: { left: Float32Array; right: Float32Array };
      vocals: { left: Float32Array; right: Float32Array };
    }>;
  }
}
