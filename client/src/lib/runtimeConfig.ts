export type PublicRuntimeConfig = {
  renderCacheDesktopPixels?: number;
  renderCacheTouchPixels?: number;
  prefetchRadiusFast?: number;
  prefetchRadiusMedium?: number;
  prefetchRadiusSlow?: number;
  previewRadiusFast?: number | 'all';
  previewRadiusMedium?: number;
  previewRadiusSlow?: number;
};
let runtimeConfig: PublicRuntimeConfig = {};

export function getPublicRuntimeConfig(): PublicRuntimeConfig {
  return runtimeConfig;
}

export async function initPublicRuntimeConfig(): Promise<void> {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const response = await fetch('/api/client-config', { cache: 'no-store' });
    if (!response.ok) {
      return;
    }

    const data = (await response.json()) as PublicRuntimeConfig;
    runtimeConfig = data ?? {};
  } catch {
    runtimeConfig = {};
  }
}
