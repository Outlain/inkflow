/**
 * Network quality monitor — detects connection speed and adapts app behavior.
 * Uses three signal layers (strongest first):
 *   1. PerformanceObserver — measures real transferSize + duration of HTTP requests
 *   2. Navigator.connection API — effectiveType, downlink, rtt (Chrome/Edge/Android)
 *   3. Manual "Low Data Mode" override persisted in localStorage
 *
 * Downgrades apply immediately; upgrades require sustained improvement (hysteresis).
 */

import { getPublicRuntimeConfig } from './runtimeConfig';

export type ConnectionQuality = 'fast' | 'medium' | 'slow';

export interface NetworkConfig {
  /** PDF.js range request chunk size in bytes */
  rangeChunkSize: number;
  /** Max preview image width to request */
  maxPreviewWidth: number;
  /** Max thumbnail preview width */
  maxThumbnailWidth: number;
  /** How many pages to prefetch ahead/behind */
  prefetchRadius: number;
  /** How many pages from active page should still load previews (0 = active only) */
  previewRadius: number;
}

export interface QualityChangeEvent {
  previous: ConnectionQuality;
  current: ConnectionQuality;
  reason: string;
}

function coerceRadius(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function coercePreviewRadius(value: unknown, fallback: number | typeof Infinity): number {
  if (value === 'all') {
    return Infinity;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function buildQualityConfigs(): Record<ConnectionQuality, NetworkConfig> {
  const runtime = getPublicRuntimeConfig();

  return {
    fast: {
      rangeChunkSize: 1024 * 1024,     // 1 MB
      maxPreviewWidth: 960,
      maxThumbnailWidth: 240,
      prefetchRadius: coerceRadius(runtime.prefetchRadiusFast, 4),
      previewRadius: coercePreviewRadius(runtime.previewRadiusFast, Infinity)
    },
    medium: {
      rangeChunkSize: 256 * 1024,      // 256 KB
      maxPreviewWidth: 480,
      maxThumbnailWidth: 180,
      prefetchRadius: coerceRadius(runtime.prefetchRadiusMedium, 1),
      previewRadius: coercePreviewRadius(runtime.previewRadiusMedium, 2)
    },
    slow: {
      rangeChunkSize: 128 * 1024,      // 128 KB (fewer round trips than 64K)
      maxPreviewWidth: 480,            // preview IS the display, so keep it readable
      maxThumbnailWidth: 120,
      prefetchRadius: coerceRadius(runtime.prefetchRadiusSlow, 0),
      previewRadius: coercePreviewRadius(runtime.previewRadiusSlow, 1)
    }
  };
}

const LOW_DATA_MODE_KEY = 'inkflow-low-data-mode';

type QualityListener = (quality: ConnectionQuality, config: NetworkConfig) => void;
type ToastListener = (event: QualityChangeEvent) => void;

let currentQuality: ConnectionQuality = 'fast';
let manualOverride: ConnectionQuality | null = null;
let qualityListeners: QualityListener[] = [];
let toastListeners: ToastListener[] = [];
let initialized = false;
let perfObserver: PerformanceObserver | null = null;

// Measured throughput samples (bytes per second)
const throughputSamples: number[] = [];
const MAX_SAMPLES = 12;

// Track failed/timed-out requests as a slow signal
let recentFailures = 0;

// Hysteresis: require sustained improvement before upgrading quality.
// Downgrades happen instantly (protect the user), upgrades require confirmation.
const UPGRADE_HOLD_MS = 10_000;    // 10 seconds of sustained improvement
let pendingUpgrade: ConnectionQuality | null = null;
let upgradeTimer: ReturnType<typeof setTimeout> | null = null;
const FAILURE_DECAY_MS = 30_000;

function loadManualOverride(): void {
  try {
    const stored = localStorage.getItem(LOW_DATA_MODE_KEY);
    if (stored === 'slow' || stored === 'medium') {
      manualOverride = stored;
    } else if (stored === 'auto' || stored === null) {
      manualOverride = null;
    }
  } catch {
    // localStorage unavailable
  }
}

function saveManualOverride(value: ConnectionQuality | null): void {
  try {
    localStorage.setItem(LOW_DATA_MODE_KEY, value ?? 'auto');
  } catch {
    // localStorage unavailable
  }
}

// ---------------------------------------------------------------------------
// Signal 1: PerformanceObserver — real measured throughput
// ---------------------------------------------------------------------------

// Minimum transfer size to consider for throughput measurement.
// Small JSON API responses (2-10KB) give misleading throughput numbers
// because their transfer time is dominated by latency, not bandwidth.
// Only measure substantial transfers like PDF chunks and preview images.
const MIN_THROUGHPUT_TRANSFER_BYTES = 50_000;

function startPerformanceObserver(): void {
  if (typeof PerformanceObserver === 'undefined') return;

  try {
    perfObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const resource = entry as PerformanceResourceTiming;

        // Only measure our own API requests (PDF content and preview images)
        if (!resource.name.includes('/api/')) continue;

        const transferSize = resource.transferSize;
        const duration = resource.responseEnd - resource.requestStart;

        // Only measure substantial transfers (>50KB) to avoid false slow
        // detection from small JSON API calls. transferSize=0 means cache hit.
        if (transferSize >= MIN_THROUGHPUT_TRANSFER_BYTES && duration > 50) {
          const bytesPerSec = (transferSize / duration) * 1000;
          throughputSamples.push(bytesPerSec);
          if (throughputSamples.length > MAX_SAMPLES) {
            throughputSamples.shift();
          }
          updateQuality();
        }

        // Detect timed-out or failed requests (duration > 15s with tiny transfer)
        if (duration > 15_000 && transferSize < 1000) {
          recordFailure();
        }
      }
    });
    perfObserver.observe({ type: 'resource', buffered: false });
  } catch {
    // PerformanceObserver not supported for 'resource' type
  }
}

function recordFailure(): void {
  recentFailures += 1;
  updateQuality();
  // Decay failures over time
  setTimeout(() => {
    recentFailures = Math.max(0, recentFailures - 1);
    updateQuality();
  }, FAILURE_DECAY_MS);
}

// ---------------------------------------------------------------------------
// Signal 2: Navigator.connection API
// ---------------------------------------------------------------------------

interface NavigatorConnectionInfo {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  type?: string;  // 'wifi', 'cellular', 'bluetooth', 'ethernet', etc.
}

function getNavigatorConnection(): NavigatorConnectionInfo | null {
  const conn = (navigator as any).connection;
  if (!conn) return null;
  return {
    effectiveType: conn.effectiveType,
    downlink: conn.downlink,
    rtt: conn.rtt,
    type: conn.type
  };
}

function detectFromNavigator(): ConnectionQuality | null {
  const conn = getNavigatorConnection();
  if (!conn) return null;

  const { effectiveType, downlink, rtt, type } = conn;

  // Connection type: cellular data starts at 'medium' by default,
  // can be upgraded if measured speed is actually good
  if (type === 'cellular') {
    if (effectiveType === '4g' && downlink !== undefined && downlink >= 5) return 'medium';
    if (effectiveType === 'slow-2g' || effectiveType === '2g') return 'slow';
    return 'slow';
  }

  if (effectiveType === 'slow-2g' || effectiveType === '2g') return 'slow';
  if (effectiveType === '3g') {
    if (downlink !== undefined && downlink >= 1.5) return 'medium';
    return 'slow';
  }

  if (rtt !== undefined && rtt > 500) return 'slow';
  if (rtt !== undefined && rtt > 200) return 'medium';
  if (downlink !== undefined && downlink < 1) return 'slow';
  if (downlink !== undefined && downlink < 5) return 'medium';

  return 'fast';
}

/** Build a human-readable reason string for the quality change. */
function buildChangeReason(quality: ConnectionQuality): string {
  if (manualOverride) {
    return 'Low Data Mode enabled';
  }

  const conn = getNavigatorConnection();

  // Check if measured throughput drove the decision
  const measured = qualityFromThroughput();
  if (measured) {
    const sorted = [...throughputSamples].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const speedKBs = Math.round(median / 1024);

    if (recentFailures >= 2) {
      return `Requests timing out (${speedKBs} KB/s measured)`;
    }

    const networkType = conn?.type;
    if (networkType === 'cellular') {
      return `Cellular data detected (${speedKBs} KB/s)`;
    }

    if (quality === 'slow') return `Slow connection (${speedKBs} KB/s)`;
    if (quality === 'medium') return `Moderate connection (${speedKBs} KB/s)`;
    return `Fast connection (${speedKBs} KB/s)`;
  }

  // Navigator API drove the decision
  if (conn) {
    const networkType = conn.type;
    if (networkType === 'cellular') return 'Cellular data detected';
    if (conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g') return 'Very slow network (2G)';
    if (conn.effectiveType === '3g') return 'Slow network (3G)';
    if (conn.rtt !== undefined && conn.rtt > 500) return `High latency (${conn.rtt}ms RTT)`;
    if (conn.downlink !== undefined && conn.downlink < 1) return `Low bandwidth (${conn.downlink} Mbps)`;
    if (quality === 'fast') return 'Fast connection detected';
  }

  return quality === 'fast' ? 'Connection improved' : 'Slow connection detected';
}

// ---------------------------------------------------------------------------
// Quality resolution
// ---------------------------------------------------------------------------

function qualityFromThroughput(): ConnectionQuality | null {
  // Require enough substantial-transfer samples before making a judgment.
  // This prevents false detection from the first couple of PDF range requests
  // which may be slow due to cold TCP connections.
  if (throughputSamples.length < 4) return null;

  // Use median of recent samples
  const sorted = [...throughputSamples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  // Boost toward slow if requests are timing out
  if (recentFailures >= 2) return 'slow';

  // Thresholds in bytes/sec
  if (median < 100_000) return 'slow';        // < 100 KB/s
  if (median < 500_000) return 'medium';       // < 500 KB/s
  return 'fast';
}

function resolveQuality(): ConnectionQuality {
  if (manualOverride) return manualOverride;

  // Prefer measured throughput — it's the most accurate signal
  const measured = qualityFromThroughput();
  if (measured) return measured;

  // Fall back to Navigator API
  const navigatorQuality = detectFromNavigator();
  if (navigatorQuality) return navigatorQuality;

  return 'fast';
}

const QUALITY_ORDER: ConnectionQuality[] = ['slow', 'medium', 'fast'];

function qualityRank(q: ConnectionQuality): number {
  return QUALITY_ORDER.indexOf(q);
}

function applyQualityChange(newQuality: ConnectionQuality): void {
  const previous = currentQuality;
  currentQuality = newQuality;
  const config = QUALITY_CONFIGS[currentQuality];
  const reason = buildChangeReason(currentQuality);

  for (const listener of qualityListeners) {
    try { listener(currentQuality, config); } catch { /* */ }
  }

  const event: QualityChangeEvent = { previous, current: currentQuality, reason };
  for (const listener of toastListeners) {
    try { listener(event); } catch { /* */ }
  }
}

function updateQuality(): void {
  const newQuality = resolveQuality();
  if (newQuality === currentQuality) {
    // No change — cancel any pending upgrade
    if (pendingUpgrade && pendingUpgrade !== newQuality) {
      pendingUpgrade = null;
      if (upgradeTimer) { clearTimeout(upgradeTimer); upgradeTimer = null; }
    }
    return;
  }

  const isUpgrade = qualityRank(newQuality) > qualityRank(currentQuality);

  if (!isUpgrade) {
    // Downgrade: apply immediately to protect the user
    pendingUpgrade = null;
    if (upgradeTimer) { clearTimeout(upgradeTimer); upgradeTimer = null; }
    applyQualityChange(newQuality);
    return;
  }

  // Upgrade: require sustained improvement for UPGRADE_HOLD_MS
  if (pendingUpgrade === newQuality) {
    // Timer already running for this upgrade level — let it fire
    return;
  }

  // Start new upgrade timer
  pendingUpgrade = newQuality;
  if (upgradeTimer) { clearTimeout(upgradeTimer); }
  upgradeTimer = setTimeout(() => {
    upgradeTimer = null;
    // Re-check quality is still the upgrade level
    const confirmed = resolveQuality();
    if (qualityRank(confirmed) > qualityRank(currentQuality)) {
      pendingUpgrade = null;
      applyQualityChange(confirmed);
    } else {
      pendingUpgrade = null;
    }
  }, UPGRADE_HOLD_MS);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Initialize the network monitor. Call once at app startup. */
export function initNetworkMonitor(): void {
  if (initialized) return;
  initialized = true;

  loadManualOverride();
  currentQuality = resolveQuality();

  // Start PerformanceObserver for real throughput measurement
  startPerformanceObserver();

  // Listen for connection changes (Chrome/Edge/Android)
  const conn = (navigator as any).connection;
  if (conn && typeof conn.addEventListener === 'function') {
    conn.addEventListener('change', () => updateQuality());
  }
}

/** Record a measured download: bytes transferred in durationMs. */
export function recordThroughput(bytes: number, durationMs: number): void {
  // Only record substantial transfers to avoid misleading measurements
  if (durationMs <= 50 || bytes < MIN_THROUGHPUT_TRANSFER_BYTES) return;
  const bytesPerSec = (bytes / durationMs) * 1000;
  throughputSamples.push(bytesPerSec);
  if (throughputSamples.length > MAX_SAMPLES) {
    throughputSamples.shift();
  }
  updateQuality();
}

/** Get the current connection quality. */
export function getConnectionQuality(): ConnectionQuality {
  return currentQuality;
}

/** Get the current network config based on quality. */
export function getNetworkConfig(): NetworkConfig {
  return buildQualityConfigs()[currentQuality];
}

/** Check if low data mode is manually enabled. */
export function isLowDataMode(): boolean {
  return manualOverride !== null;
}

/** Get the current manual override value (null = auto). */
export function getManualOverride(): ConnectionQuality | null {
  return manualOverride;
}

/** Set manual override: 'slow', 'medium', or null for auto. */
export function setLowDataMode(mode: ConnectionQuality | null): void {
  const previous = currentQuality;
  manualOverride = mode;
  saveManualOverride(mode);
  // Force an update with toast
  const newQuality = resolveQuality();
  if (newQuality !== previous) {
    currentQuality = newQuality;
    const config = buildQualityConfigs()[currentQuality];
    const reason = mode ? 'Low Data Mode enabled' : 'Low Data Mode disabled';

    for (const listener of qualityListeners) {
      try { listener(currentQuality, config); } catch { /* */ }
    }
    const event: QualityChangeEvent = { previous, current: currentQuality, reason };
    for (const listener of toastListeners) {
      try { listener(event); } catch { /* */ }
    }
  } else {
    currentQuality = newQuality;
  }
}

/** Subscribe to quality changes. Returns unsubscribe function. */
export function onQualityChange(listener: QualityListener): () => void {
  qualityListeners.push(listener);
  return () => {
    qualityListeners = qualityListeners.filter((l) => l !== listener);
  };
}

/** Subscribe to toast events (quality change notifications). Returns unsubscribe. */
export function onQualityToast(listener: ToastListener): () => void {
  toastListeners.push(listener);
  return () => {
    toastListeners = toastListeners.filter((l) => l !== listener);
  };
}

/** Get config for a specific quality level. */
export function getConfigForQuality(quality: ConnectionQuality): NetworkConfig {
  return buildQualityConfigs()[quality];
}
