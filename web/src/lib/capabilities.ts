/** Device / backend hints for optional Demucs separation. */

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

/**
 * Default: ON for desktop with WebGPU; OFF on mobile / no WebGPU.
 * User can still toggle in the UI.
 */
export async function defaultSeparationEnabled(): Promise<{
  enabled: boolean;
  webgpu: boolean;
  mobile: boolean;
  reason: string;
}> {
  const mobile = isMobileUa();
  const webgpu = await hasWebGpu();
  if (mobile) {
    return {
      enabled: false,
      webgpu,
      mobile,
      reason: '行動裝置預設關閉（模型約 172MB，建議桌面 WebGPU）',
    };
  }
  if (webgpu) {
    return {
      enabled: true,
      webgpu,
      mobile,
      reason: '偵測到 WebGPU，預設啟用 HTDemucs 分離',
    };
  }
  return {
    enabled: false,
    webgpu,
    mobile,
    reason: '無 WebGPU：預設關閉（仍可手動開啟，將使用較慢的 WASM）',
  };
}
