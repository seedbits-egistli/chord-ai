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
  // Separation always uses ORT wasm EP from same-origin /ort/ (jsep/WebGPU
  // omitted — exceeds Workers asset limit and breaks blob: import in workers).
  if (mobile) {
    return {
      enabled: false,
      webgpu,
      mobile,
      reason: '進階模式預設關閉；行動裝置上 WASM 分離會較慢（模型約 34MB）',
    };
  }
  return {
    enabled: false,
    webgpu,
    mobile,
    reason: '進階模式預設關閉；啟用後以同源 ORT WASM 執行 UMX-HQ（約 34MB，可快取）',
  };
}
