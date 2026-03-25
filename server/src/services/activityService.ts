/**
 * Activity and session tracking service — manages users, study/app sessions,
 * page visits, activity events, streaks, aggregation queries, webhook delivery,
 * and document chapter management. All state is persisted in SQLite.
 */

import { nanoid } from 'nanoid';
import type {
  ActivityConfigPayload,
  ActivityDaySummary,
  ActivityEventRecord,
  ActivityEventType,
  ActivityExportPayload,
  ActivitySessionRecord,
  ActivitySessionType,
  ActivitySummary,
  DocumentActivitySummary,
  DocumentChapter,
  PageVisitRecord,
  UserRecord
} from '../../../shared/src/contracts.js';
import { getDb } from '../db/database.js';
import { config } from '../config.js';

// ── Date helpers ──

function now(): string {
  return new Date().toISOString();
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// ── Row types ──

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  avatar_color: string;
  created_at: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  session_type: string;
  document_id: string | null;
  device_id: string;
  device_label: string | null;
  started_at: string;
  last_heartbeat_at: string;
  ended_at: string | null;
  idle_timeout_secs: number;
  active_secs: number;
  heartbeat_count: number;
  first_page_index: number | null;
  last_page_index: number | null;
  page_range_low: number | null;
  page_range_high: number | null;
}

interface EventRow {
  id: string;
  user_id: string;
  session_id: string | null;
  document_id: string | null;
  page_id: string | null;
  event_type: string;
  metadata_json: string | null;
  created_at: string;
}

interface PageVisitRow {
  id: string;
  session_id: string;
  document_id: string;
  page_id: string | null;
  page_index: number;
  entered_at: string;
  exited_at: string | null;
  dwell_secs: number;
}

interface ChapterRow {
  id: string;
  document_id: string;
  title: string;
  start_page_index: number;
  end_page_index: number;
  position: number;
  color: string | null;
  created_at: string;
}

interface ConfigRow {
  key: string;
  value: string;
}

// ── Mappers ──

function mapUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    avatarColor: row.avatar_color,
    createdAt: row.created_at
  };
}

function mapSession(row: SessionRow): ActivitySessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    sessionType: row.session_type as ActivitySessionType,
    documentId: row.document_id,
    deviceId: row.device_id,
    deviceLabel: row.device_label,
    startedAt: row.started_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    endedAt: row.ended_at,
    idleTimeoutSecs: row.idle_timeout_secs,
    activeSecs: row.active_secs,
    heartbeatCount: row.heartbeat_count,
    firstPageIndex: row.first_page_index,
    lastPageIndex: row.last_page_index,
    pageRangeLow: row.page_range_low,
    pageRangeHigh: row.page_range_high
  };
}

function mapEvent(row: EventRow): ActivityEventRecord {
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id,
    documentId: row.document_id,
    pageId: row.page_id,
    eventType: row.event_type as ActivityEventType,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
    createdAt: row.created_at
  };
}

function mapPageVisit(row: PageVisitRow): PageVisitRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    documentId: row.document_id,
    pageId: row.page_id,
    pageIndex: row.page_index,
    enteredAt: row.entered_at,
    exitedAt: row.exited_at,
    dwellSecs: row.dwell_secs
  };
}

function mapChapter(row: ChapterRow): DocumentChapter {
  return {
    id: row.id,
    documentId: row.document_id,
    title: row.title,
    startPageIndex: row.start_page_index,
    endPageIndex: row.end_page_index,
    position: row.position,
    color: row.color,
    createdAt: row.created_at
  };
}

// ── User management ──

export function getDefaultUser(): UserRecord | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM users LIMIT 1').get() as UserRow | undefined;
  return row ? mapUser(row) : null;
}

export function getUserById(userId: string): UserRecord | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;
  return row ? mapUser(row) : null;
}

export function setupUser(displayName: string): UserRecord {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM users LIMIT 1').get() as UserRow | undefined;
  if (existing) {
    return mapUser(existing);
  }

  const username = displayName.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) || 'user';
  const id = nanoid();
  const timestamp = now();
  db.prepare(`
    INSERT INTO users (id, username, display_name, avatar_color, created_at)
    VALUES (?, ?, ?, '#2d6e96', ?)
  `).run(id, username, displayName.trim(), timestamp);

  return getUserById(id)!;
}

export function ensureDefaultUserFromEnv(): UserRecord | null {
  if (!config.defaultUser) {
    return null;
  }
  const existing = getDefaultUser();
  if (existing) {
    return existing;
  }
  return setupUser(config.defaultUser);
}

// ── Session management ──

/** Seconds of active time added per heartbeat. Must match the client's heartbeat interval. */
const HEARTBEAT_INTERVAL_SECS = 30;

export function startSession(params: {
  userId: string;
  sessionType: ActivitySessionType;
  documentId?: string;
  deviceId: string;
  deviceLabel?: string;
  pageIndex?: number;
}): ActivitySessionRecord {
  const db = getDb();
  const idleTimeout = getConfigValue('idle_timeout_secs', '300');
  const id = nanoid();
  const timestamp = now();

  // Check for resumable session (same device, same type, same document, ended within 2 minutes)
  if (params.sessionType === 'study' && params.documentId) {
    const recent = db.prepare(`
      SELECT * FROM activity_sessions
      WHERE device_id = ? AND session_type = 'study' AND document_id = ?
        AND ended_at IS NOT NULL
        AND datetime(ended_at) > datetime(?, '-2 minutes')
      ORDER BY ended_at DESC LIMIT 1
    `).get(params.deviceId, params.documentId, timestamp) as SessionRow | undefined;

    if (recent) {
      // Resume: reopen the session
      db.prepare(`
        UPDATE activity_sessions
        SET ended_at = NULL, last_heartbeat_at = ?
        WHERE id = ?
      `).run(timestamp, recent.id);
      return mapSession({ ...recent, ended_at: null, last_heartbeat_at: timestamp });
    }
  }

  db.prepare(`
    INSERT INTO activity_sessions (
      id, user_id, session_type, document_id, device_id, device_label,
      started_at, last_heartbeat_at, ended_at, idle_timeout_secs,
      active_secs, heartbeat_count, first_page_index, last_page_index,
      page_range_low, page_range_high
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, 0, ?, ?, ?, ?)
  `).run(
    id, params.userId, params.sessionType, params.documentId ?? null,
    params.deviceId, params.deviceLabel ?? null,
    timestamp, timestamp, parseInt(idleTimeout, 10),
    params.pageIndex ?? null, params.pageIndex ?? null,
    params.pageIndex ?? null, params.pageIndex ?? null
  );

  // Open first page visit if page index provided
  if (params.pageIndex != null && params.sessionType === 'study') {
    openPageVisit(id, params.documentId!, null, params.pageIndex);
  }

  return getSessionById(id)!;
}

export function heartbeat(sessionId: string, pageIndex?: number): ActivitySessionRecord | null {
  const db = getDb();
  const session = db.prepare('SELECT * FROM activity_sessions WHERE id = ?').get(sessionId) as SessionRow | undefined;
  if (!session || session.ended_at) {
    return null;
  }

  const timestamp = now();
  const addedSecs = HEARTBEAT_INTERVAL_SECS;

  let pageLow = session.page_range_low;
  let pageHigh = session.page_range_high;
  let lastPage = session.last_page_index;
  if (pageIndex != null) {
    lastPage = pageIndex;
    if (pageLow == null || pageIndex < pageLow) pageLow = pageIndex;
    if (pageHigh == null || pageIndex > pageHigh) pageHigh = pageIndex;

    // Handle page transition
    if (session.last_page_index != null && pageIndex !== session.last_page_index) {
      closeCurrentPageVisit(sessionId);
      openPageVisit(sessionId, session.document_id!, null, pageIndex);
    } else {
      // Extend current page visit dwell time
      extendCurrentPageVisit(sessionId, addedSecs);
    }
  }

  db.prepare(`
    UPDATE activity_sessions SET
      last_heartbeat_at = ?,
      active_secs = active_secs + ?,
      heartbeat_count = heartbeat_count + 1,
      last_page_index = ?,
      page_range_low = ?,
      page_range_high = ?
    WHERE id = ?
  `).run(timestamp, addedSecs, lastPage, pageLow, pageHigh, sessionId);

  return getSessionById(sessionId);
}

export function endSession(sessionId: string, pageIndex?: number): ActivitySessionRecord | null {
  const db = getDb();
  const session = db.prepare('SELECT * FROM activity_sessions WHERE id = ?').get(sessionId) as SessionRow | undefined;
  if (!session || session.ended_at) {
    return session ? mapSession(session) : null;
  }

  const timestamp = now();
  closeCurrentPageVisit(sessionId);

  db.prepare(`
    UPDATE activity_sessions SET
      ended_at = ?,
      last_page_index = COALESCE(?, last_page_index)
    WHERE id = ?
  `).run(timestamp, pageIndex ?? null, sessionId);

  return getSessionById(sessionId);
}

function getSessionById(id: string): ActivitySessionRecord | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM activity_sessions WHERE id = ?').get(id) as SessionRow | undefined;
  return row ? mapSession(row) : null;
}

// ── Page visits ──

function openPageVisit(sessionId: string, documentId: string, pageId: string | null, pageIndex: number): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO page_visits (id, session_id, document_id, page_id, page_index, entered_at, exited_at, dwell_secs)
    VALUES (?, ?, ?, ?, ?, ?, NULL, 0)
  `).run(nanoid(), sessionId, documentId, pageId, pageIndex, now());
}

function closeCurrentPageVisit(sessionId: string): void {
  const db = getDb();
  const timestamp = now();
  db.prepare(`
    UPDATE page_visits SET exited_at = ?
    WHERE session_id = ? AND exited_at IS NULL
  `).run(timestamp, sessionId);
}

function extendCurrentPageVisit(sessionId: string, addSecs: number): void {
  const db = getDb();
  db.prepare(`
    UPDATE page_visits SET dwell_secs = dwell_secs + ?
    WHERE session_id = ? AND exited_at IS NULL
  `).run(addSecs, sessionId);
}

// ── Session reaper ──

/**
 * Closes sessions that haven't received a heartbeat within their idle timeout + 60s grace.
 * Runs periodically via startReaper(). Sets ended_at to last_heartbeat_at (not current time).
 */
export function reapStaleSessions(): number {
  const db = getDb();
  const stale = db.prepare(`
    SELECT * FROM activity_sessions
    WHERE ended_at IS NULL
      AND datetime(last_heartbeat_at, '+' || (idle_timeout_secs + 60) || ' seconds') < datetime('now')
  `).all() as SessionRow[];

  for (const session of stale) {
    closeCurrentPageVisit(session.id);
    db.prepare(`
      UPDATE activity_sessions SET ended_at = last_heartbeat_at
      WHERE id = ?
    `).run(session.id);
  }

  return stale.length;
}

let reaperInterval: ReturnType<typeof setInterval> | null = null;

export function startReaper(): void {
  if (reaperInterval) return;
  reaperInterval = setInterval(() => {
    try {
      reapStaleSessions();
    } catch {
      // Best-effort cleanup
    }
  }, 60_000);
}

export function stopReaper(): void {
  if (reaperInterval) {
    clearInterval(reaperInterval);
    reaperInterval = null;
  }
}

// ── Event logging ──

export function logActivityEvents(userId: string, events: Array<{
  sessionId?: string;
  documentId?: string;
  pageId?: string;
  eventType: ActivityEventType;
  metadata?: Record<string, unknown>;
}>): ActivityEventRecord[] {
  const db = getDb();
  const timestamp = now();
  const results: ActivityEventRecord[] = [];

  const insert = db.prepare(`
    INSERT INTO activity_events (id, user_id, session_id, document_id, page_id, event_type, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const event of events) {
      const id = nanoid();
      insert.run(
        id, userId, event.sessionId ?? null, event.documentId ?? null,
        event.pageId ?? null, event.eventType,
        event.metadata ? JSON.stringify(event.metadata) : null,
        timestamp
      );
      results.push({
        id,
        userId,
        sessionId: event.sessionId ?? null,
        documentId: event.documentId ?? null,
        pageId: event.pageId ?? null,
        eventType: event.eventType,
        metadata: event.metadata ?? null,
        createdAt: timestamp
      });
    }
  });

  tx();
  return results;
}

// ── Config ──

function getConfigValue(key: string, defaultValue: string): string {
  const db = getDb();
  const row = db.prepare('SELECT value FROM activity_config WHERE key = ?').get(key) as ConfigRow | undefined;
  return row?.value ?? defaultValue;
}

function setConfigValue(key: string, value: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO activity_config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

export function getActivityConfig(): ActivityConfigPayload {
  return {
    idleTimeoutSecs: parseInt(getConfigValue('idle_timeout_secs', '300'), 10),
    dailyGoalMins: parseInt(getConfigValue('daily_goal_mins', '60'), 10),
    webhookUrl: getConfigValue('webhook_url', '') || null,
    webhookEnabled: getConfigValue('webhook_enabled', 'false') === 'true'
  };
}

export function updateActivityConfig(updates: Partial<ActivityConfigPayload>): ActivityConfigPayload {
  if (updates.idleTimeoutSecs != null) setConfigValue('idle_timeout_secs', String(updates.idleTimeoutSecs));
  if (updates.dailyGoalMins != null) setConfigValue('daily_goal_mins', String(updates.dailyGoalMins));
  if (updates.webhookUrl !== undefined) setConfigValue('webhook_url', updates.webhookUrl ?? '');
  if (updates.webhookEnabled != null) setConfigValue('webhook_enabled', String(updates.webhookEnabled));
  return getActivityConfig();
}

// ── Aggregation queries ──

export function getActivitySummary(userId: string): ActivitySummary {
  const db = getDb();
  const today = todayDate();

  // Today's stats
  const todayStudy = db.prepare(`
    SELECT COALESCE(SUM(active_secs), 0) as total FROM activity_sessions
    WHERE user_id = ? AND session_type = 'study' AND date(started_at) = ?
  `).get(userId, today) as { total: number };

  const todayApp = db.prepare(`
    SELECT COALESCE(SUM(active_secs), 0) as total FROM activity_sessions
    WHERE user_id = ? AND session_type = 'app' AND date(started_at) = ?
  `).get(userId, today) as { total: number };

  const todaySessions = db.prepare(`
    SELECT COUNT(*) as count FROM activity_sessions
    WHERE user_id = ? AND session_type = 'study' AND date(started_at) = ?
  `).get(userId, today) as { count: number };

  // Weekly breakdown (last 7 days)
  const weekDays: ActivityDaySummary[] = [];
  for (let i = 6; i >= 0; i--) {
    const date = daysAgo(i);
    const daySummary = getDaySummary(userId, date);
    weekDays.push(daySummary);
  }

  // Streak calculation
  const { current: currentStreak, longest: longestStreak } = calculateStreaks(userId);

  // Top documents this week
  const weekStart = daysAgo(6);
  const topDocs = db.prepare(`
    SELECT s.document_id, d.title, COALESCE(SUM(s.active_secs), 0) as study_secs
    FROM activity_sessions s
    LEFT JOIN documents d ON d.id = s.document_id
    WHERE s.user_id = ? AND s.session_type = 'study'
      AND s.document_id IS NOT NULL
      AND date(s.started_at) >= ?
    GROUP BY s.document_id
    ORDER BY study_secs DESC
    LIMIT 5
  `).all(userId, weekStart) as Array<{ document_id: string; title: string; study_secs: number }>;

  return {
    todayStudySecs: todayStudy.total,
    todayAppSecs: todayApp.total,
    todaySessions: todaySessions.count,
    weekDays,
    currentStreak,
    longestStreak,
    topDocuments: topDocs.map(d => ({
      documentId: d.document_id,
      title: d.title ?? 'Untitled',
      studySecs: d.study_secs
    }))
  };
}

function getDaySummary(userId: string, date: string): ActivityDaySummary {
  const db = getDb();

  const study = db.prepare(`
    SELECT COALESCE(SUM(active_secs), 0) as total FROM activity_sessions
    WHERE user_id = ? AND session_type = 'study' AND date(started_at) = ?
  `).get(userId, date) as { total: number };

  const app = db.prepare(`
    SELECT COALESCE(SUM(active_secs), 0) as total FROM activity_sessions
    WHERE user_id = ? AND session_type = 'app' AND date(started_at) = ?
  `).get(userId, date) as { total: number };

  const sessions = db.prepare(`
    SELECT COUNT(*) as count FROM activity_sessions
    WHERE user_id = ? AND session_type = 'study' AND date(started_at) = ?
  `).get(userId, date) as { count: number };

  const docsEdited = db.prepare(`
    SELECT COUNT(DISTINCT document_id) as count FROM activity_sessions
    WHERE user_id = ? AND session_type = 'study' AND document_id IS NOT NULL AND date(started_at) = ?
  `).get(userId, date) as { count: number };

  return {
    date,
    studySecs: study.total,
    appSecs: app.total,
    sessions: sessions.count,
    documentsEdited: docsEdited.count
  };
}

/**
 * Calculates current and longest study streaks by walking distinct session dates
 * backwards. A streak is only "current" if it includes today or yesterday.
 */
function calculateStreaks(userId: string): { current: number; longest: number } {
  const db = getDb();
  const rows = db.prepare(`
    SELECT DISTINCT date(started_at) as d FROM activity_sessions
    WHERE user_id = ? AND session_type = 'study'
    ORDER BY d DESC
  `).all(userId) as Array<{ d: string }>;

  if (rows.length === 0) return { current: 0, longest: 0 };

  const today = todayDate();
  const yesterday = daysAgo(1);
  let current = 0;
  let longest = 0;
  let streak = 0;
  let expectedDate: string | null = null;

  for (const row of rows) {
    if (expectedDate === null) {
      // First date: must be today or yesterday to count as current streak
      if (row.d === today || row.d === yesterday) {
        streak = 1;
        expectedDate = daysAgo(today === row.d ? 1 : 2);
      } else {
        // No current streak, but still calculate longest
        streak = 1;
        expectedDate = previousDay(row.d);
        longest = Math.max(longest, streak);
        current = 0;
        // Continue counting for longest
      }
    } else if (row.d === expectedDate) {
      streak++;
      expectedDate = previousDay(row.d);
    } else {
      if (current === 0 && streak > 0 && (rows[0].d === today || rows[0].d === yesterday)) {
        current = streak;
      }
      longest = Math.max(longest, streak);
      streak = 1;
      expectedDate = previousDay(row.d);
    }
  }

  if (current === 0 && streak > 0 && (rows[0].d === today || rows[0].d === yesterday)) {
    current = streak;
  }
  longest = Math.max(longest, streak);

  return { current, longest };
}

function previousDay(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ── Document-level stats ──

export function getDocumentActivitySummary(userId: string, documentId: string): DocumentActivitySummary {
  const db = getDb();

  const totalStudy = db.prepare(`
    SELECT COALESCE(SUM(active_secs), 0) as total FROM activity_sessions
    WHERE user_id = ? AND session_type = 'study' AND document_id = ?
  `).get(userId, documentId) as { total: number };

  const totalSessions = db.prepare(`
    SELECT COUNT(*) as count FROM activity_sessions
    WHERE user_id = ? AND session_type = 'study' AND document_id = ?
  `).get(userId, documentId) as { count: number };

  const lastOpened = db.prepare(`
    SELECT started_at FROM activity_sessions
    WHERE user_id = ? AND session_type = 'study' AND document_id = ?
    ORDER BY started_at DESC LIMIT 1
  `).get(userId, documentId) as { started_at: string } | undefined;

  // Per-page time
  const pageTime = db.prepare(`
    SELECT page_index, page_id, COALESCE(SUM(dwell_secs), 0) as dwell_secs
    FROM page_visits
    WHERE document_id = ?
    GROUP BY page_index
    ORDER BY page_index
  `).all(documentId) as Array<{ page_index: number; page_id: string | null; dwell_secs: number }>;

  // Per-chapter time
  const chapters = db.prepare(`
    SELECT * FROM document_chapters WHERE document_id = ? ORDER BY position
  `).all(documentId) as ChapterRow[];

  const chapterTime = chapters.map(ch => {
    const time = db.prepare(`
      SELECT COALESCE(SUM(dwell_secs), 0) as total FROM page_visits
      WHERE document_id = ? AND page_index >= ? AND page_index <= ?
    `).get(documentId, ch.start_page_index, ch.end_page_index) as { total: number };

    return {
      chapterId: ch.id,
      title: ch.title,
      dwellSecs: time.total
    };
  });

  // Recent sessions
  const recentRows = db.prepare(`
    SELECT * FROM activity_sessions
    WHERE user_id = ? AND session_type = 'study' AND document_id = ?
    ORDER BY started_at DESC LIMIT 20
  `).all(userId, documentId) as SessionRow[];

  // Daily activity (last 30 days)
  const dailyActivity: ActivityDaySummary[] = [];
  for (let i = 29; i >= 0; i--) {
    const date = daysAgo(i);
    const dayStudy = db.prepare(`
      SELECT COALESCE(SUM(active_secs), 0) as total FROM activity_sessions
      WHERE user_id = ? AND session_type = 'study' AND document_id = ? AND date(started_at) = ?
    `).get(userId, documentId, date) as { total: number };
    const daySessions = db.prepare(`
      SELECT COUNT(*) as count FROM activity_sessions
      WHERE user_id = ? AND session_type = 'study' AND document_id = ? AND date(started_at) = ?
    `).get(userId, documentId, date) as { count: number };

    dailyActivity.push({
      date,
      studySecs: dayStudy.total,
      appSecs: 0,
      sessions: daySessions.count,
      documentsEdited: daySessions.count > 0 ? 1 : 0
    });
  }

  return {
    documentId,
    totalStudySecs: totalStudy.total,
    totalSessions: totalSessions.count,
    lastOpenedAt: lastOpened?.started_at ?? null,
    pageTime: pageTime.map(p => ({
      pageIndex: p.page_index,
      pageId: p.page_id,
      dwellSecs: p.dwell_secs
    })),
    chapterTime,
    recentSessions: recentRows.map(mapSession),
    dailyActivity
  };
}

// ── Export ──

export function exportActivity(userId: string, from: string, to: string): ActivityExportPayload {
  const db = getDb();
  const sessions = db.prepare(`
    SELECT * FROM activity_sessions
    WHERE user_id = ? AND date(started_at) >= ? AND date(started_at) <= ?
    ORDER BY started_at
  `).all(userId, from, to) as SessionRow[];

  const totalSecs = sessions.reduce((sum, s) => sum + s.active_secs, 0);
  const docIds = new Set(sessions.filter(s => s.document_id).map(s => s.document_id));

  return {
    source: 'inkflow',
    category: 'study',
    exportedAt: now(),
    range: { from, to },
    sessions: sessions.map(mapSession),
    summary: {
      totalActiveSecs: totalSecs,
      totalSessions: sessions.length,
      documentsTouched: docIds.size
    }
  };
}

// ── Webhook ──

export async function fireWebhook(session: ActivitySessionRecord): Promise<void> {
  const cfg = getActivityConfig();
  if (!cfg.webhookEnabled || !cfg.webhookUrl) return;

  try {
    await fetch(cfg.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'inkflow',
        event: 'session.ended',
        session,
        timestamp: now()
      }),
      signal: AbortSignal.timeout(10_000)
    });
  } catch {
    // Webhook is best-effort
  }
}

// ── Chapter management ──

export function getDocumentChapters(documentId: string): DocumentChapter[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM document_chapters WHERE document_id = ? ORDER BY position').all(documentId) as ChapterRow[];
  return rows.map(mapChapter);
}

export function createChapter(documentId: string, input: {
  title: string;
  startPageIndex: number;
  endPageIndex: number;
  color?: string;
}): DocumentChapter {
  const db = getDb();
  const id = nanoid();
  const timestamp = now();

  // Position: after the last chapter
  const last = db.prepare('SELECT MAX(position) as max_pos FROM document_chapters WHERE document_id = ?').get(documentId) as { max_pos: number | null };
  const position = (last.max_pos ?? 0) + 1024;

  db.prepare(`
    INSERT INTO document_chapters (id, document_id, title, start_page_index, end_page_index, position, color, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, documentId, input.title, input.startPageIndex, input.endPageIndex, position, input.color ?? null, timestamp);

  return getChapterById(id)!;
}

export function updateChapter(chapterId: string, updates: {
  title?: string;
  startPageIndex?: number;
  endPageIndex?: number;
  color?: string | null;
}): DocumentChapter | null {
  const db = getDb();
  const existing = getChapterById(chapterId);
  if (!existing) return null;

  if (updates.title != null) db.prepare('UPDATE document_chapters SET title = ? WHERE id = ?').run(updates.title, chapterId);
  if (updates.startPageIndex != null) db.prepare('UPDATE document_chapters SET start_page_index = ? WHERE id = ?').run(updates.startPageIndex, chapterId);
  if (updates.endPageIndex != null) db.prepare('UPDATE document_chapters SET end_page_index = ? WHERE id = ?').run(updates.endPageIndex, chapterId);
  if (updates.color !== undefined) db.prepare('UPDATE document_chapters SET color = ? WHERE id = ?').run(updates.color ?? null, chapterId);

  return getChapterById(chapterId);
}

export function deleteChapter(chapterId: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM document_chapters WHERE id = ?').run(chapterId);
  return result.changes > 0;
}

function getChapterById(id: string): DocumentChapter | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM document_chapters WHERE id = ?').get(id) as ChapterRow | undefined;
  return row ? mapChapter(row) : null;
}
