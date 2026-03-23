import type {
  ActivityConfigPayload,
  ActivitySessionRecord,
  ActivitySessionType,
  ActivitySummary,
  DocumentActivitySummary,
  ActivityExportPayload,
  UserRecord,
  SetupUserRequest,
  LogActivityEventsRequest,
  ActivityEventType,
  DocumentChapter,
  CreateChapterRequest,
  UpdateChapterRequest
} from '@shared/contracts';

// ── Device ID ──

const DEVICE_ID_KEY = 'inkflow_device_id';
const USER_ID_KEY = 'inkflow_user_id';

function generateId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const values = crypto.getRandomValues(new Uint8Array(21));
  for (const v of values) result += chars[v % chars.length];
  return result;
}

export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = generateId();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

export function getStoredUserId(): string | null {
  return localStorage.getItem(USER_ID_KEY);
}

export function setStoredUserId(userId: string): void {
  localStorage.setItem(USER_ID_KEY, userId);
}

function detectDeviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua))) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android.*Mobile/.test(ua)) return 'Android Phone';
  if (/Android/.test(ua)) return 'Android Tablet';
  if (/Macintosh/.test(ua)) return 'Mac Desktop';
  if (/Windows/.test(ua)) return 'Windows Desktop';
  if (/Linux/.test(ua)) return 'Linux Desktop';
  return 'Unknown Device';
}

// ── API helpers ──

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`${url} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

async function putJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`${url} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

async function deleteReq<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) throw new Error(`${url} failed: ${res.status}`);
  return res.json() as Promise<T>;
}

// ── User API ──

export async function fetchCurrentUser(): Promise<UserRecord | null> {
  try {
    return await getJson<UserRecord>('/api/users/me');
  } catch {
    return null;
  }
}

export async function setupUser(displayName: string): Promise<UserRecord> {
  const user = await postJson<UserRecord>('/api/users/setup', { displayName } satisfies SetupUserRequest);
  setStoredUserId(user.id);
  return user;
}

// ── Session API ──

export async function apiStartSession(sessionType: ActivitySessionType, documentId?: string, pageIndex?: number): Promise<ActivitySessionRecord> {
  return postJson<ActivitySessionRecord>('/api/activity/sessions/start', {
    sessionType,
    documentId,
    deviceId: getDeviceId(),
    deviceLabel: detectDeviceLabel(),
    pageIndex
  });
}

export async function apiHeartbeat(sessionId: string, pageIndex?: number): Promise<ActivitySessionRecord | null> {
  try {
    return await postJson<ActivitySessionRecord>('/api/activity/heartbeat', { sessionId, pageIndex });
  } catch {
    return null;
  }
}

export async function apiEndSession(sessionId: string, pageIndex?: number): Promise<void> {
  // Use sendBeacon for reliability on page close
  if (navigator.sendBeacon) {
    const blob = new Blob([JSON.stringify({ sessionId, pageIndex })], { type: 'application/json' });
    navigator.sendBeacon('/api/activity/sessions/end', blob);
  } else {
    try {
      await postJson('/api/activity/sessions/end', { sessionId, pageIndex });
    } catch {
      // Best effort
    }
  }
}

// ── Event API ──

export async function logEvents(events: LogActivityEventsRequest['events']): Promise<void> {
  try {
    await postJson('/api/activity/events', { events });
  } catch {
    // Best effort
  }
}

// ── Summary API ──

export async function fetchActivitySummary(): Promise<ActivitySummary> {
  return getJson<ActivitySummary>('/api/activity/summary');
}

export async function fetchDocumentActivity(documentId: string): Promise<DocumentActivitySummary> {
  return getJson<DocumentActivitySummary>(`/api/activity/documents/${documentId}`);
}

// ── Config API ──

export async function fetchActivityConfig(): Promise<ActivityConfigPayload> {
  return getJson<ActivityConfigPayload>('/api/activity/config');
}

export async function updateActivityConfig(updates: Partial<ActivityConfigPayload>): Promise<ActivityConfigPayload> {
  return putJson<ActivityConfigPayload>('/api/activity/config', updates);
}

// ── Export API ──

export async function fetchActivityExport(from: string, to: string): Promise<ActivityExportPayload> {
  return getJson<ActivityExportPayload>(`/api/activity/export?from=${from}&to=${to}`);
}

// ── Chapter API ──

export async function fetchChapters(documentId: string): Promise<DocumentChapter[]> {
  const res = await getJson<{ chapters: DocumentChapter[] }>(`/api/documents/${documentId}/chapters`);
  return res.chapters;
}

export async function createChapter(documentId: string, input: CreateChapterRequest): Promise<DocumentChapter> {
  return postJson<DocumentChapter>(`/api/documents/${documentId}/chapters`, input);
}

export async function updateChapter(chapterId: string, updates: UpdateChapterRequest): Promise<DocumentChapter> {
  return putJson<DocumentChapter>(`/api/chapters/${chapterId}`, updates);
}

export async function deleteChapter(chapterId: string): Promise<void> {
  await deleteReq(`/api/chapters/${chapterId}`);
}

// ── Platform Signal Detection ──

interface PlatformSignals {
  pointer: boolean;
  scroll: boolean;
  visibility: boolean;
  beacon: boolean;
  touch: boolean;
  pencil: boolean;
  deviceMotion: boolean;
  idleDetector: boolean;
}

function detectPlatformSignals(): PlatformSignals {
  return {
    pointer: true,
    scroll: true,
    visibility: typeof document !== 'undefined' && 'visibilityState' in document,
    beacon: typeof navigator !== 'undefined' && 'sendBeacon' in navigator,
    touch: typeof window !== 'undefined' && 'ontouchstart' in window,
    pencil: typeof window !== 'undefined' && !!window.PointerEvent,
    deviceMotion: typeof window !== 'undefined' && 'DeviceMotionEvent' in window,
    idleDetector: typeof window !== 'undefined' && 'IdleDetector' in window
  };
}

// ── Activity Detector ──
// Tracks user interaction signals and manages idle state

export type ActivityState = 'active' | 'idle' | 'inactive';

export class ActivityDetector {
  private state: ActivityState = 'idle';
  private idleTimeoutMs: number;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners: Array<(state: ActivityState) => void> = [];
  private cleanups: Array<() => void> = [];
  private signals: PlatformSignals;

  constructor(idleTimeoutSecs = 300) {
    this.idleTimeoutMs = idleTimeoutSecs * 1000;
    this.signals = detectPlatformSignals();
  }

  start(): void {
    const onInteraction = () => this.markActive();

    // Universal signals
    const events: Array<[EventTarget, string, EventListener]> = [
      [document, 'pointerdown', onInteraction],
      [document, 'pointermove', onInteraction],
      [document, 'scroll', onInteraction],
      [document, 'keydown', onInteraction],
      [document, 'wheel', onInteraction]
    ];

    if (this.signals.touch) {
      events.push([document, 'touchstart', onInteraction]);
    }

    for (const [target, event, handler] of events) {
      target.addEventListener(event, handler, { passive: true });
      this.cleanups.push(() => target.removeEventListener(event, handler));
    }

    // Visibility API
    if (this.signals.visibility) {
      const onVisibility = () => {
        if (document.visibilityState === 'hidden') {
          this.setState('inactive');
        } else if (document.visibilityState === 'visible') {
          // Resume to idle — needs interaction to become active
          if (this.state === 'inactive') {
            this.setState('idle');
          }
        }
      };
      document.addEventListener('visibilitychange', onVisibility);
      this.cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));
    }
  }

  stop(): void {
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups = [];
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  onStateChange(fn: (state: ActivityState) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter(l => l !== fn);
    };
  }

  getState(): ActivityState {
    return this.state;
  }

  setIdleTimeout(secs: number): void {
    this.idleTimeoutMs = secs * 1000;
  }

  private markActive(): void {
    if (this.state === 'inactive') return; // Must become visible first

    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.setState('idle'), this.idleTimeoutMs);

    if (this.state !== 'active') {
      this.setState('active');
    }
  }

  private setState(next: ActivityState): void {
    if (next === this.state) return;
    this.state = next;
    if (next !== 'active' && this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    for (const fn of this.listeners) fn(next);
  }
}

// ── Session Managers ──

const HEARTBEAT_INTERVAL_MS = 30_000;

export class AppSessionManager {
  private sessionId: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private detector: ActivityDetector;
  private detectorCleanup: (() => void) | null = null;

  constructor(private idleTimeoutSecs = 300) {
    this.detector = new ActivityDetector(idleTimeoutSecs);
  }

  async start(): Promise<void> {
    this.detector.start();

    // Start app session
    try {
      const session = await apiStartSession('app');
      this.sessionId = session.id;
    } catch {
      return;
    }

    // Heartbeat while active
    this.heartbeatTimer = setInterval(() => {
      if (this.detector.getState() === 'active' && this.sessionId) {
        apiHeartbeat(this.sessionId).catch(() => {});
      }
    }, HEARTBEAT_INTERVAL_MS);

    // Listen for state changes
    this.detectorCleanup = this.detector.onStateChange((state) => {
      if (state === 'inactive' && this.sessionId) {
        // Page hidden — end session via beacon
        apiEndSession(this.sessionId);
        this.sessionId = null;
        this.stopHeartbeat();
      }
    });

    // Page close handler
    const onClose = () => {
      if (this.sessionId) {
        apiEndSession(this.sessionId);
        this.sessionId = null;
      }
    };
    window.addEventListener('pagehide', onClose);
    window.addEventListener('beforeunload', onClose);
  }

  stop(): void {
    if (this.sessionId) {
      apiEndSession(this.sessionId);
      this.sessionId = null;
    }
    this.stopHeartbeat();
    this.detectorCleanup?.();
    this.detector.stop();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  getSessionId(): string | null {
    return this.sessionId;
  }
}

export class StudySessionManager {
  private sessionId: string | null = null;
  private documentId: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private currentPageIndex: number = 0;
  private detector: ActivityDetector;
  private detectorCleanup: (() => void) | null = null;
  private closeHandlers: Array<() => void> = [];

  constructor(private idleTimeoutSecs = 300) {
    this.detector = new ActivityDetector(idleTimeoutSecs);
  }

  async openDocument(documentId: string, pageIndex = 0): Promise<void> {
    // If same document, don't restart (handles resume grace period server-side)
    if (this.documentId === documentId && this.sessionId) {
      return;
    }

    // Close previous if different document
    if (this.sessionId && this.documentId !== documentId) {
      await this.closeDocument();
    }

    this.documentId = documentId;
    this.currentPageIndex = pageIndex;
    this.detector.start();

    try {
      const session = await apiStartSession('study', documentId, pageIndex);
      this.sessionId = session.id;
    } catch {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      if (this.detector.getState() === 'active' && this.sessionId) {
        apiHeartbeat(this.sessionId, this.currentPageIndex).catch(() => {});
      }
    }, HEARTBEAT_INTERVAL_MS);

    this.detectorCleanup = this.detector.onStateChange((state) => {
      if (state === 'inactive' && this.sessionId) {
        apiEndSession(this.sessionId, this.currentPageIndex);
        this.sessionId = null;
        this.stopHeartbeat();
      }
    });

    const onClose = () => {
      if (this.sessionId) {
        apiEndSession(this.sessionId, this.currentPageIndex);
        this.sessionId = null;
      }
    };
    window.addEventListener('pagehide', onClose);
    window.addEventListener('beforeunload', onClose);
    this.closeHandlers.push(
      () => window.removeEventListener('pagehide', onClose),
      () => window.removeEventListener('beforeunload', onClose)
    );
  }

  async closeDocument(): Promise<void> {
    if (this.sessionId) {
      await apiEndSession(this.sessionId, this.currentPageIndex);
      this.sessionId = null;
    }
    this.documentId = null;
    this.stopHeartbeat();
    this.detectorCleanup?.();
    this.detectorCleanup = null;
    this.detector.stop();
    for (const cleanup of this.closeHandlers) cleanup();
    this.closeHandlers = [];
  }

  updatePageIndex(pageIndex: number): void {
    this.currentPageIndex = pageIndex;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getDocumentId(): string | null {
    return this.documentId;
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

// ── Singleton instances ──

let appSession: AppSessionManager | null = null;
let studySession: StudySessionManager | null = null;

export function getAppSession(): AppSessionManager {
  if (!appSession) {
    appSession = new AppSessionManager();
  }
  return appSession;
}

export function getStudySession(): StudySessionManager {
  if (!studySession) {
    studySession = new StudySessionManager();
  }
  return studySession;
}

// ── Event logging helpers ──

export function logStudyEvent(eventType: ActivityEventType, documentId?: string, pageId?: string, metadata?: Record<string, unknown>): void {
  const sessionId = getStudySession().getSessionId() ?? getAppSession().getSessionId() ?? undefined;
  logEvents([{ sessionId, documentId, pageId, eventType, metadata }]);
}

// ── Multi-tab coordination via BroadcastChannel ──
// Ensures only one tab per device sends app-level heartbeats.
// Study sessions are scoped to documents so they don't conflict.

let tabChannel: BroadcastChannel | null = null;
let isLeaderTab = false;

export function initTabCoordination(): void {
  if (typeof BroadcastChannel === 'undefined') {
    isLeaderTab = true;
    return;
  }

  tabChannel = new BroadcastChannel('inkflow_activity');
  isLeaderTab = true;

  // When a new tab opens, it announces itself
  tabChannel.postMessage({ type: 'tab-open', deviceId: getDeviceId() });

  tabChannel.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === 'tab-open' && msg.deviceId === getDeviceId()) {
      // Another tab on same device opened — existing tabs yield app session leadership
      // The newest tab becomes leader (it sent the message)
      isLeaderTab = false;
    }
    if (msg.type === 'tab-close' && msg.deviceId === getDeviceId()) {
      // A tab closed — try to become leader
      isLeaderTab = true;
    }
  };

  window.addEventListener('pagehide', () => {
    tabChannel?.postMessage({ type: 'tab-close', deviceId: getDeviceId() });
  });
}

export function isAppSessionLeader(): boolean {
  return isLeaderTab;
}
