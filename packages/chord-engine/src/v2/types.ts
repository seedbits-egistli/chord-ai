/** Minimal ONNX session abstraction so the same code runs on onnxruntime-web and onnxruntime-node. */
export interface TensorLike { data: Float32Array; dims: readonly number[] }
export type OnnxRun = (feeds: Record<string, TensorLike>) => Promise<Record<string, TensorLike>>;
export type Progress = (p: number) => void;
