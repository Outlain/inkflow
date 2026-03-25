/**
 * Shared TypeScript contracts between client and server.
 * All API request/response shapes, database record types, and annotation models.
 */

// ── Core enums and type aliases ──

export type DocumentKind = 'notebook' | 'pdf';
export type PageKind = 'blank' | 'ruled' | 'grid' | 'dot' | 'pdf';
export type NotebookTemplate = Extract<PageKind, 'blank' | 'ruled' | 'grid' | 'dot'>;
type KnownEditorTool = 'lasso' | 'pen' | 'pencil' | 'highlighter' | 'eraser' | 'text' | 'shape' | 'sticky' | 'laser' | 'hand';
export type EditorTool = KnownEditorTool | (string & {});
export type ShapeKind = 'rectangle' | 'ellipse' | 'triangle' | 'diamond';
export type LineStyle = 'solid' | 'dashed' | 'dotted';
export type LassoMode = 'rectangle' | 'freehand';
export type LaserPointerMode = 'dot' | 'line';
/** Whether annotation saves merge with existing data ('append') or overwrite ('replace'). */
export type SaveMode = 'append' | 'replace';

// ── Library records ──

export interface FolderRecord {
  id: string;
  title: string;
  color: string;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentSummary {
  id: string;
  folderId: string | null;
  title: string;
  kind: DocumentKind;
  coverColor: string;
  pageCount: number;
  bookmarkPageId: string | null;
  bookmarkUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FileRecord {
  id: string;
  documentId: string;
  storageKey: string;
  originalName: string;
  mimeType: string;
  size: number;
  pageCount: number;
  createdAt: string;
  url: string;
}

export interface PageRecord {
  id: string;
  documentId: string;
  position: number;
  kind: PageKind;
  sourceFileId: string | null;
  sourcePageIndex: number | null;
  template: NotebookTemplate | null;
  width: number;
  height: number;
  annotationRevision: number;
  updatedAt: string;
  annotationText: string;
}

/** Full document payload returned when opening a document in the reader. */
export interface DocumentBundle {
  document: DocumentSummary;
  files: FileRecord[];
  pages: PageRecord[];
}

export type ImportPdfResult = DocumentBundle;

/** Top-level library listing returned on initial load. */
export interface LibraryPayload {
  folders: FolderRecord[];
  documents: DocumentSummary[];
  setupRequired?: boolean;
  currentUser?: UserRecord;
}

export interface CreateFolderInput {
  title: string;
  color: string;
}

export interface CreateNotebookInput {
  title: string;
  template: NotebookTemplate;
  pageCount: number;
  folderId: string | null;
  coverColor: string;
}

// ── Annotation types ──

export interface PagePoint {
  x: number;
  y: number;
  pressure: number;
  time: number;
}

export interface StrokeAnnotation {
  id: string;
  type: 'stroke';
  tool: 'pen' | 'pencil' | 'highlighter';
  color: string;
  width: number;
  points: PagePoint[];
}

export interface TextAnnotation {
  id: string;
  type: 'text';
  text: string;
  color: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
}

export interface StickyNoteAnnotation {
  id: string;
  type: 'sticky';
  text: string;
  color: string;
  noteColor: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
}

export interface ShapeAnnotation {
  id: string;
  type: 'shape';
  shape: ShapeKind;
  color: string;
  x: number;
  y: number;
  width: number;
  height: number;
  strokeWidth: number;
  fill: boolean;
  lineStyle: LineStyle;
}

export type Annotation = StrokeAnnotation | TextAnnotation | ShapeAnnotation;
/** Superset of Annotation that also includes sticky notes (only used in thumbnails). */
export type PageAnnotation = Annotation | StickyNoteAnnotation;

// ── Annotation save/load payloads ──

export interface PageAnnotationsPayload {
  pageId: string;
  annotations: Annotation[];
  annotationText: string;
  annotationRevision: number;
  updatedAt: string;
}

export interface SavePageRequest {
  mode: SaveMode;
  pageId: string;
  annotations: Annotation[];
  annotationText: string;
  clientId: string;
  clientRevision: number;
  baseRevision: number;
}

export interface SavePageResponse {
  pageId: string;
  mode: SaveMode;
  annotationRevision: number;
  updatedAt: string;
}

export interface BookmarkPayload {
  pageId: string | null;
}

export interface SearchResult {
  pageId: string;
  position: number;
  pageIndex: number;
  snippet: string;
}

export interface SearchResponse {
  indexing: boolean;
  results: SearchResult[];
}

// ── Page manipulation requests ──

export interface InsertBlankPageRequest {
  anchorPageId: string;
  placement: 'before' | 'after';
  template: NotebookTemplate;
}

export interface InsertPdfPagesRequest {
  anchorPageId: string;
  placement: 'before' | 'after';
  pageRange: string;
}

// ── WebSocket sync events ──

export type SyncEvent =
  | {
      type: 'page.updated';
      documentId: string;
      pageId: string;
      annotationRevision: number;
      updatedAt: string;
      senderClientId: string;
    }
  | {
      type: 'document.changed';
      documentId: string;
      senderClientId: string;
    };

// ── Activity tracking ──

export interface UserRecord {
  id: string;
  username: string;
  displayName: string;
  avatarColor: string;
  createdAt: string;
}

export interface SetupUserRequest {
  displayName: string;
}

export type ActivitySessionType = 'app' | 'study';

export type ActivityEventType =
  | 'session.start'
  | 'session.end'
  | 'page.edited'
  | 'document.created'
  | 'document.imported'
  | 'document.exported'
  | 'page.created'
  | 'page.deleted'
  | 'folder.created';

export interface ActivitySessionRecord {
  id: string;
  userId: string;
  sessionType: ActivitySessionType;
  documentId: string | null;
  deviceId: string;
  deviceLabel: string | null;
  startedAt: string;
  lastHeartbeatAt: string;
  endedAt: string | null;
  idleTimeoutSecs: number;
  activeSecs: number;
  heartbeatCount: number;
  firstPageIndex: number | null;
  lastPageIndex: number | null;
  pageRangeLow: number | null;
  pageRangeHigh: number | null;
}

export interface ActivityEventRecord {
  id: string;
  userId: string;
  sessionId: string | null;
  documentId: string | null;
  pageId: string | null;
  eventType: ActivityEventType;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface PageVisitRecord {
  id: string;
  sessionId: string;
  documentId: string;
  pageId: string | null;
  pageIndex: number;
  enteredAt: string;
  exitedAt: string | null;
  dwellSecs: number;
}

export interface DocumentChapter {
  id: string;
  documentId: string;
  title: string;
  startPageIndex: number;
  endPageIndex: number;
  position: number;
  color: string | null;
  createdAt: string;
}

export interface StartSessionRequest {
  sessionType: ActivitySessionType;
  documentId?: string;
  deviceId: string;
  deviceLabel?: string;
  pageIndex?: number;
}

export interface HeartbeatRequest {
  sessionId: string;
  pageIndex?: number;
}

export interface EndSessionRequest {
  sessionId: string;
  pageIndex?: number;
}

// ── Activity aggregation and reporting ──

export interface LogActivityEventsRequest {
  events: Array<{
    sessionId?: string;
    documentId?: string;
    pageId?: string;
    eventType: ActivityEventType;
    metadata?: Record<string, unknown>;
  }>;
}

export interface ActivityDaySummary {
  date: string;
  studySecs: number;
  appSecs: number;
  sessions: number;
  documentsEdited: number;
}

export interface ActivitySummary {
  todayStudySecs: number;
  todayAppSecs: number;
  todaySessions: number;
  weekDays: ActivityDaySummary[];
  currentStreak: number;
  longestStreak: number;
  topDocuments: Array<{ documentId: string; title: string; studySecs: number }>;
}

export interface DocumentActivitySummary {
  documentId: string;
  totalStudySecs: number;
  totalSessions: number;
  lastOpenedAt: string | null;
  pageTime: Array<{ pageIndex: number; pageId: string | null; dwellSecs: number }>;
  chapterTime: Array<{ chapterId: string; title: string; dwellSecs: number }>;
  recentSessions: ActivitySessionRecord[];
  dailyActivity: ActivityDaySummary[];
}

export interface ActivityExportPayload {
  source: 'inkflow';
  category: 'study';
  exportedAt: string;
  range: { from: string; to: string };
  sessions: ActivitySessionRecord[];
  summary: {
    totalActiveSecs: number;
    totalSessions: number;
    documentsTouched: number;
  };
}

export interface ActivityConfigPayload {
  idleTimeoutSecs: number;
  dailyGoalMins: number;
  webhookUrl: string | null;
  webhookEnabled: boolean;
}

// ── Chapter management ──

export interface CreateChapterRequest {
  title: string;
  startPageIndex: number;
  endPageIndex: number;
  color?: string;
}

export interface UpdateChapterRequest {
  title?: string;
  startPageIndex?: number;
  endPageIndex?: number;
  color?: string;
}

// ── Client-side debug overlay ──

export interface DebugEvent {
  id: string;
  type:
    | 'scroll-start'
    | 'scroll-end'
    | 'momentum-start'
    | 'momentum-end'
    | 'active-page'
    | 'visible-range'
    | 'shell-mounted'
    | 'shell-unmounted'
    | 'render-start'
    | 'render-end'
    | 'save-start'
    | 'save-end'
    | 'draft-start'
    | 'draft-end'
    | 'sync-receive'
    | 'sync-apply'
    | 'layout-recalc';
  message: string;
  at: number;
}
