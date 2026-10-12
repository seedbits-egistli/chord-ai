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

/**
 * Separation is an opt-in advanced mode — always default OFF.
 * Hint text still reflects device capability (WebGPU vs WASM).
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
      reason: '進階模式預設關閉；行動裝置上 WASM 分離會較慢（模型約 34MB）',
    };
  }
  if (webgpu) {
    return {
      enabled: false,
      webgpu,
      mobile,
      reason: '進階模式預設關閉；此裝置有 WebGPU，可手動開啟 UMX-HQ 分離（約 34MB）',
    };
  }
  return {
    enabled: false,
    webgpu,
    mobile,
    reason: '進階模式預設關閉；無 WebGPU 時將使用較慢的 WASM（約 34MB）',
  };
}
