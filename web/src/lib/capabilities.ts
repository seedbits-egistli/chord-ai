/** Device hints for optional advanced-mode UMX separation (always default-off). */

export function isMobileUa(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

export async function hasWebGpu(): Promise<boolean> {
  try {
    const nav = navigator as Navigator & {
      gpu?: { requestAdapter: () => Promise<unknown> };
    };
    if (!nav.gpu) return false;
    const adapter = await nav.gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

export type UiDetectMode = 'fast' | 'precise';

/**
 * Default mode is always 快速. 精準 uses UMX + Basic Pitch (longer runtime).
 */
export async function defaultDetectMode(): Promise<{
  mode: UiDetectMode;
  webgpu: boolean;
  mobile: boolean;
  reason: string;
}> {
  const mobile = isMobileUa();
  const webgpu = await hasWebGpu();
  if (mobile) {
    return {
      mode: 'fast',
      webgpu,
      mobile,
      reason: '精準模式在行動裝置上會較慢（UMX ~34MB + Basic Pitch 轉錄）',
    };
  }
  return {
    mode: 'fast',
    webgpu,
    mobile,
    reason: '精準模式：UMX-HQ 分離 → Basic Pitch 音符 → 和弦推斷（可快取模型）',
  };
}

/** @deprecated use defaultDetectMode */
export async function defaultSeparationEnabled(): Promise<{
  enabled: boolean;
  webgpu: boolean;
  mobile: boolean;
  reason: string;
}> {
  const d = await defaultDetectMode();
  return {
    enabled: d.mode === 'precise',
    webgpu: d.webgpu,
    mobile: d.mobile,
    reason: d.reason,
  };
}
