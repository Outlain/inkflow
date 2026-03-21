export type DocumentKind = 'notebook' | 'pdf';
export type PageKind = 'blank' | 'ruled' | 'grid' | 'dot' | 'pdf';
export type NotebookTemplate = Extract<PageKind, 'blank' | 'ruled' | 'grid' | 'dot'>;
export type EditorTool = 'pen' | 'highlighter' | 'eraser' | 'text' | 'shape' | 'hand';
export type ShapeKind = 'rectangle' | 'ellipse' | 'triangle' | 'diamond';
export type LineStyle = 'solid' | 'dashed' | 'dotted';
export type SaveMode = 'append' | 'replace';

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

export interface DocumentBundle {
  document: DocumentSummary;
  files: FileRecord[];
  pages: PageRecord[];
}

export type ImportPdfResult = DocumentBundle;

export interface LibraryPayload {
  folders: FolderRecord[];
  documents: DocumentSummary[];
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

export interface PagePoint {
  x: number;
  y: number;
  pressure: number;
  time: number;
}

export interface StrokeAnnotation {
  id: string;
  type: 'stroke';
  tool: 'pen' | 'highlighter';
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
