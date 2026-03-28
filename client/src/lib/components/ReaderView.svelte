<script lang="ts">
  // ── Imports ──────────────────────────────────────────────────────────

  import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
  import type {
    Annotation,
    DocumentBundle,
    DocumentChapter,
    EditorTool,
    FileRecord,
    LineStyle,
    NotebookTemplate,
    PageAnnotation,
    SaveMode,
    SearchResponse,
    ShapeKind,
    SyncEvent,
    TapePattern
  } from '@shared/contracts';
  import { getStudySession, logStudyEvent } from '../activity';
  import {
    deleteDocument,
    deletePage,
    fetchDocument,
    fetchPageAnnotations,
    insertBlankPage,
    insertPdfPages,
    savePage,
    searchDocument,
    updateBookmark
  } from '../api';
  import { annotationTextFromAnnotations } from '../annotations';
  import ChapterManager from './ChapterManager.svelte';
  import { debugTimeline } from '../debug';
  import { shouldUseDraft } from '../draftConflict';
  import { deleteDraft, readDraft, writeDraft } from '../drafts';
  import { createClientId } from '../id';
  import { prefetchPdfPage } from '../pdf';
  import { getNetworkConfig, getConnectionQuality, onQualityChange, type ConnectionQuality, type NetworkConfig } from '../networkMonitor';
  import { toggleTheme, getTheme, type Theme } from '../theme';
  import { waitForIdle } from '../renderScheduler';
  import {
    startBackgroundDownload,
    stopBackgroundDownload,
    updateActiveIndex,
    isBackgroundDownloadActive
  } from '../backgroundDownloader';
  import PageShell from './PageShell.svelte';
  import ThumbnailPreview from './ThumbnailPreview.svelte';
  import { ReaderLayoutEngine, type PageShellLayout, type ReaderLayoutResult, type VisibleWindow } from '../reader/layout';
  import {
    STROKE_BOUNDS,
    cloneStrokePresetSettings,
    defaultStrokeStabilization,
    formatStrokeWidth,
    loadEraserStrokeMode,
    loadStrokeStabilization,
    loadStrokePresetSettings,
    resetStrokePresetWidth,
    saveEraserStrokeMode,
    saveStrokeStabilization,
    saveStrokePresetSettings,
    strokePresetIndicatorSize,
    toolStrokeWidthFromSettings,
    updateStrokePresetWidth,
    type AdjustableStrokeTool,
    type EraserStrokeMode,
    type StrokePresetSettings
  } from '../strokeSettings';

  // ── Props ─────────────────────────────────────────────────────────────

  export let documentId: string;
  export let browserSafeTopbar = true;

  // ── Interfaces ───────────────────────────────────────────────────────

  interface PageRuntimeState {
    annotations: Annotation[];
    annotationText: string;
    annotationRevision: number;
    updatedAt: string;
    loaded: boolean;
    loading: boolean;
    dirty: boolean;
    saving: boolean;
    saveError: string;
    clientRevision: number;
    localChangeCounter: number;
    undoStack: Annotation[][];
    redoStack: Annotation[][];
  }

  interface SaveItem {
    mode: SaveMode;
    annotations: Annotation[];
    annotationText: string;
  }

  interface ZoomAnchor {
    pageId: string;
    pageIndex: number;
    pageUnitX: number;
    pageUnitY: number;
    viewportX: number;
    viewportY: number;
  }

  interface PinchGesture {
    startDistance: number;
    startZoom: number;
    anchor: ZoomAnchor | null;
  }

  interface PendingZoomUpdate {
    zoom: number;
    reason: string;
    anchor: ZoomAnchor | null;
    token: number;
  }

  interface StrokePopoverState {
    tool: EditorTool;
    preset: number;
    left: number;
    top: number;
    arrowLeft: number;
  }

  type ReaderToolPanel = 'lasso' | 'write' | 'text' | 'shape' | 'sticky' | 'tape' | 'accessories' | 'laser' | 'hand';

  // ── Constants ────────────────────────────────────────────────────────

  const dispatch = createEventDispatcher<{ close: void }>();
  const layoutEngine = new ReaderLayoutEngine();
  const zoomLevels = [0.4, 0.5, 0.6, 0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.5, 3];
  const ZOOM_EPSILON = 0.001;
  const MAX_PAGE_HISTORY = 50;
  const colorChips = ['#123f63', '#c74b35', '#2f8a78', '#8e5fa4', '#d48a2c', '#121212'];
  const GRAPHITE_COLOR = '#4a4f57';
  const DEFAULT_PEN_COLOR = colorChips[0];
  const DEFAULT_MARKER_COLOR = colorChips[4];
  const QUICK_PENCIL_STABILIZATION = 18;
  const QUICK_MARKER_STABILIZATION = 24;
  const textSizePresets = [18, 24, 32] as const;
  const middleMenuItems = [
    { id: 'lasso' as const, label: 'Lasso', glyph: '⬚', accent: '#8db5d8' },
    { id: 'pen' as const, label: 'Pen', glyph: '✍', accent: DEFAULT_PEN_COLOR },
    { id: 'pencil' as const, label: 'Pencil', glyph: '✎', accent: GRAPHITE_COLOR },
    { id: 'highlighter' as const, label: 'Marker', glyph: '▰', accent: DEFAULT_MARKER_COLOR },
    { id: 'eraser' as const, label: 'Eraser', glyph: '⌫', accent: '#c55a44' },
    { id: 'text' as const, label: 'Text', glyph: 'T', accent: '#586f8d' },
    { id: 'shape' as const, label: 'Shapes', glyph: '▭', accent: '#7c5ca8' },
    { id: 'sticky' as const, label: 'Sticky', glyph: '▣', accent: '#f0d36d' },
    { id: 'tape' as const, label: 'Tape', glyph: '▬', accent: '#e8b4b8' },
    { id: 'accessories' as const, label: 'Accessories', glyph: '◌', accent: '#69b8a6' },
    { id: 'laser' as const, label: 'Laser', glyph: '•', accent: '#f2615f' },
    { id: 'hand' as const, label: 'Hand', glyph: '✋', accent: '#3c7c66' }
  ];
  const pageTemplates: NotebookTemplate[] = ['blank', 'ruled', 'grid', 'dot'];
  const clientId = createClientId();

  // ── State ─────────────────────────────────────────────────────────────

  let bundle: DocumentBundle | null = null;
  let loading = true;
  let busy = false;
  let errorMessage = '';
  let statusMessage = 'Preparing the stable reader shell…';
  let selectedTool: EditorTool = 'hand';
  let selectedColor = colorChips[0];
  let selectedSize = 2;
  let activeToolPanel: ReaderToolPanel | null = null;
  let textFontSize = textSizePresets[1];
  let stickyNoteColor = '#f5ef83';
  let lassoMode: 'rectangle' | 'freehand' = 'rectangle';
  let lassoSelectionCount = 0;
  let laserPointerMode: 'dot' | 'line' = 'dot';
  let tapeColor = '#e8b4b8';
  let tapePattern: TapePattern = 'solid';
  let tapeWidth = 30;
  let tapeStraightMode = true;
  let tapeOpacity = 1.0;
  /** Set of tape IDs currently revealed (transparent) for study peek — client-side only, not persisted */
  let revealedTapeIds: Set<string> = new Set();
  /** Set of tape IDs being temporarily peeked via hold gesture */
  let peekingTapeIds: Set<string> = new Set();
  /** Tape IDs that were already persistently revealed before a peek started — restored on peek-end */
  let prePeekRevealedIds: Set<string> = new Set();
  let selectedAnnotationIdsByPage: Record<string, string[]> = {};
  let rulerVisible = false;
  let rulerOffsetY = 180;
  let rulerAngle = 0;
  let timeKeeperVisible = false;
  let timeKeeperRunning = false;
  let timeKeeperSeconds = 0;
  let timeKeeperTimer = 0;
  let strokePresetSettings: StrokePresetSettings = cloneStrokePresetSettings();
  let strokePresetSettingsLoaded = false;
  let eraserStrokeMode: EraserStrokeMode = 'whole';
  let eraserStrokeModeLoaded = false;
  let strokeStabilization = defaultStrokeStabilization();
  let strokeStabilizationLoaded = false;
  let selectedShapeKind: ShapeKind = 'rectangle';
  let selectedShapeFill = false;
  let selectedShapeLineStyle: LineStyle = 'solid';
  let stylusOnly = true;
  let zoom = 1;
  let zoomLabel = '100%';
  let compactMode = typeof window !== 'undefined' ? window.innerWidth <= 1080 : false;
  let currentTheme: Theme = getTheme();
  let layout: ReaderLayoutResult = { containerHeight: 0, containerWidth: 0, pages: [] };
  let visibleWindow: VisibleWindow = { start: 0, end: -1 };
  let visibleLayouts: PageShellLayout[] = [];
  let annotationLoadLayouts: PageShellLayout[] = [];
  let activePageIndex = 0;
  let centerPane: HTMLDivElement | null = null;
  let scrollPane: HTMLDivElement | null = null;
  let insertPdfInput: HTMLInputElement | null = null;
  let pendingInsertPlacement: 'before' | 'after' = 'after';
  let pendingLoadDocumentId = '';
  let searchText = '';
  let searchBusy = false;
  let searchState: SearchResponse = { indexing: false, results: [] };
  let chapters: DocumentChapter[] = [];
  let compactPagesOpen = false;
  let compactInspectorOpen = false;
  let pageStates: Record<string, PageRuntimeState> = {};
  let lastEditedPageId: string | null = null;

  // Save queue: batches pending server writes per page
  const pendingSaves = new Map<string, SaveItem[]>();
  const drainingPages = new Set<string>();

  // Scroll & gesture tracking
  let scrollFrame = 0;
  let scrollEndTimer = 0;
  let scrolling = false;
  let lastScrollY = 0;
  let lastScrollTime = 0;
  let touchGestureActive = false;
  let touchMomentumActive = false;
  let inkScrollLocked = false;
  let restoringInkScroll = false;
  let inkLockedScrollTop = 0;
  let inkLockedScrollLeft = 0;
  let pinchGesture: PinchGesture | null = null;
  let pinchFrame = 0;
  let zoomUpdateToken = 0;
  let pendingZoomUpdate: PendingZoomUpdate | null = null;
  let strokePopover: StrokePopoverState | null = null;
  let strokePopoverBackdropVisible = false;
  let strokePopoverWidth = 0;
  let strokePopoverWidthLabel = '';
  let strokePopoverSampleStyle = '';
  let strokeStabilizationLabel = `${defaultStrokeStabilization()}%`;
  let longPressTimer = 0;
  let suppressedClickKey = '';
  let compactHeaderShown = false;
  let compactHeaderVisibleState = false;
  let readerScreen: HTMLDivElement | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let resizeFrame = 0;
  let syncSocket: WebSocket | null = null;
  let rulerGesture:
    | null
    | {
        mode: 'move' | 'rotate';
        pointerId: number;
        startClientX: number;
        startClientY: number;
        startOffsetY: number;
        startAngle: number;
      } = null;
  let currentPageRecord: DocumentBundle['pages'][number] | null = null;
  let historyTargetPageRecord: DocumentBundle['pages'][number] | null = null;
  let currentUndoCount = 0;
  let currentRedoCount = 0;
  let historyUndoCount = 0;
  let historyRedoCount = 0;
  let canUndoAvailable = false;
  let canRedoAvailable = false;
  let currentPageAnnotationCount = 0;
  let draftsAvailable = true;
  let qualityUnsub: (() => void) | null = null;
  let thumbnailSidebarPages: DocumentBundle['pages'] = [];
  let previewAnnotationsByPage: Record<string, PageAnnotation[] | null> = {};
  let thumbnailRenderVersionByPage: Record<string, number> = {};
  let connectionQuality: ConnectionQuality = getConnectionQuality();
  let networkConfig: NetworkConfig = getNetworkConfig();

  // ── Reactive Derived Values ───────────────────────────────────────────

  $: zoomLabel = `${Math.round(zoom * 100)}%`;
  $: strokePopoverWidth = strokePopover && adjustableStrokeTool(strokePopover.tool) ? currentStrokePresetValue(adjustableStrokeTool(strokePopover.tool)!, strokePopover.preset) : 0;
  $: strokePopoverWidthLabel = formatStrokeWidth(strokePopoverWidth);
  $: strokeStabilizationLabel = `${strokeStabilization}%`;
  $: strokePopoverSampleStyle = strokePopover
    ? `height:${Math.min(18, Math.max(3, strokePopoverWidth))}px; background:${strokePopover.tool === 'eraser' ? 'rgba(255,255,255,0.94)' : selectedColor}; opacity:${strokePopover.tool === 'highlighter' ? 0.34 : strokePopover.tool === 'pencil' ? 0.72 : 1}; box-shadow:${strokePopover.tool === 'eraser' ? '0 0 0 1px rgba(42,34,29,0.12) inset' : 'none'};`
    : '';
  $: currentPageRecord = bundle?.pages[activePageIndex] ?? null;
  $: historyTargetPageRecord =
    currentPageRecord && (pageStates[currentPageRecord.id]?.undoStack?.length ?? 0) > 0
      ? currentPageRecord
      : pageById(lastEditedPageId) ?? currentPageRecord;
  $: currentUndoCount = currentPageRecord ? pageStates[currentPageRecord.id]?.undoStack?.length ?? 0 : 0;
  $: currentRedoCount = currentPageRecord ? pageStates[currentPageRecord.id]?.redoStack?.length ?? 0 : 0;
  $: historyUndoCount = historyTargetPageRecord ? pageStates[historyTargetPageRecord.id]?.undoStack?.length ?? 0 : 0;
  $: historyRedoCount = historyTargetPageRecord ? pageStates[historyTargetPageRecord.id]?.redoStack?.length ?? 0 : 0;
  $: canUndoAvailable = historyUndoCount > 0;
  $: canRedoAvailable = historyRedoCount > 0;
  $: currentPageAnnotationCount = currentPageRecord ? pageStates[currentPageRecord.id]?.annotations?.length ?? 0 : 0;
  $: lassoSelectionCount = currentPageRecord ? selectedAnnotationIdsByPage[currentPageRecord.id]?.length ?? 0 : 0;
  $: thumbnailSidebarPages = bundle?.pages.slice(Math.max(0, activePageIndex - 4), Math.min(bundle.pages.length, activePageIndex + 5)) ?? [];

  // ── Page State Management ─────────────────────────────────────────────

  function defaultPageState(): PageRuntimeState {
    return {
      annotations: [],
      annotationText: '',
      annotationRevision: 0,
      updatedAt: '',
      loaded: false,
      loading: false,
      dirty: false,
      saving: false,
      saveError: '',
      clientRevision: 0,
      localChangeCounter: 0,
      undoStack: [],
      redoStack: []
    };
  }

  function normalizePageState(state?: Partial<PageRuntimeState>): PageRuntimeState {
    return {
      ...defaultPageState(),
      ...state,
      undoStack: state?.undoStack ?? [],
      redoStack: state?.redoStack ?? []
    };
  }

  function ensurePageState(pageId: string): PageRuntimeState {
    if (!pageStates[pageId]) {
      pageStates = {
        ...pageStates,
        [pageId]: defaultPageState()
      };
    }

    return pageStates[pageId];
  }

  function setPageState(pageId: string, next: PageRuntimeState): void {
    pageStates = {
      ...pageStates,
      [pageId]: normalizePageState(next)
    };
  }

  function pageIndexForId(pageId: string): number {
    return bundle?.pages.findIndex((page) => page.id === pageId) ?? -1;
  }

  function focusEditedPage(pageId: string): void {
    const index = pageIndexForId(pageId);
    if (index >= 0 && index !== activePageIndex) {
      activePageIndex = index;
    }
  }

  function pageById(pageId: string | null) {
    if (!bundle || !pageId) {
      return null;
    }

    return bundle.pages.find((page) => page.id === pageId) ?? null;
  }

  function historyTargetPage() {
    return historyTargetPageRecord;
  }

  function fileLookup(page: { sourceFileId: string | null }): FileRecord | null {
    if (!bundle || !page.sourceFileId) {
      return null;
    }

    return bundle.files.find((file) => file.id === page.sourceFileId) ?? null;
  }

  function currentPage() {
    return currentPageRecord;
  }

  // ── Tool & UI Label Helpers ──────────────────────────────────────────

  function currentZoomLabel(): string {
    return zoomLabel;
  }

  function toolLabel(tool: EditorTool): string {
    if (tool === 'highlighter') {
      return 'Marker';
    }

    return tool[0].toUpperCase() + tool.slice(1);
  }

  function adjustableStrokeTool(tool: EditorTool): AdjustableStrokeTool | null {
    if (tool === 'pen' || tool === 'pencil' || tool === 'highlighter' || tool === 'eraser') {
      return tool as AdjustableStrokeTool;
    }
    return null;
  }

  function strokeToolLabel(tool: EditorTool): string {
    if (tool === 'pencil') {
      return 'Pencil';
    }

    if (tool === 'highlighter') {
      return 'Marker';
    }

    if (tool === 'eraser') {
      return 'Eraser';
    }

    if (tool === 'shape') {
      return 'Shape';
    }

    if (tool === 'text') {
      return 'Text';
    }

    if (tool === 'hand') {
      return 'Hand';
    }

    return 'Pen';
  }

  function quickPresetLabel(): string {
    if (selectedTool === 'pencil') {
      return 'Pencil';
    }

    return toolLabel(selectedTool);
  }

  function strokePopoverTitle(tool: EditorTool): string {
    if (tool === 'pen' || tool === 'pencil') {
      return `${strokeToolLabel(tool)} options`;
    }

    if (tool === 'highlighter') {
      return 'Marker options';
    }

    if (tool === 'eraser') {
      return 'Eraser options';
    }

    if (tool === 'shape') {
      return 'Shape options';
    }

    if (tool === 'text') {
      return 'Text options';
    }

    return 'Navigation options';
  }

  function sizeButtonKey(tool: AdjustableStrokeTool, preset: number): string {
    return `${tool}:preset:${preset}`;
  }

  function currentAdjustableStrokeTool(): AdjustableStrokeTool | null {
    return adjustableStrokeTool(selectedTool);
  }

  function currentToolAccent(): string {
    if (selectedTool === 'pencil') {
      return GRAPHITE_COLOR;
    }

    if (selectedTool === 'highlighter') {
      return DEFAULT_MARKER_COLOR;
    }

    if (selectedTool === 'eraser') {
      return '#c55a44';
    }

    if (selectedTool === 'shape') {
      return '#7c5ca8';
    }

    if (selectedTool === 'text') {
      return '#586f8d';
    }

    return '#3c7c66';
  }

  // ── Tool Panel Activation & Selection ──────────────────────────────────

  function panelForTool(tool: EditorTool): ReaderToolPanel {
    if (tool === 'hand') {
      return 'hand';
    }

    if (tool === 'text') {
      return 'text';
    }

    if (tool === 'shape') {
      return 'shape';
    }

    return 'write';
  }

  function applyToolSelection(tool: EditorTool, target: HTMLElement | null = null): void {
    selectedTool = tool;
    if (tool === 'text' || tool === 'shape' || tool === 'hand') {
      activeToolPanel = panelForTool(tool);
    } else {
      activeToolPanel = null;
    }

    if (tool === 'pencil' && selectedColor === DEFAULT_PEN_COLOR) {
      selectedColor = GRAPHITE_COLOR;
    }

    if (tool === 'pencil') {
      strokeStabilization = Math.min(strokeStabilization, QUICK_PENCIL_STABILIZATION);
    }

    if (tool === 'highlighter') {
      strokeStabilization = Math.min(strokeStabilization, QUICK_MARKER_STABILIZATION);
    }
  }

  function handleMiddleMenuItem(id: ReaderToolPanel | EditorTool, target: HTMLElement | null): void {
    if (id === 'lasso' || id === 'sticky' || id === 'tape' || id === 'laser') {
      selectedTool = id;
      activeToolPanel = activeToolPanel === id ? null : id;
      closeStrokePopover();
      return;
    }

    if (id === 'accessories') {
      activeToolPanel = activeToolPanel === id ? null : id;
      closeStrokePopover();
      return;
    }

    if (id === 'pen' || id === 'pencil' || id === 'highlighter' || id === 'eraser' || id === 'text' || id === 'shape' || id === 'hand') {
      applyToolSelection(id, target);
    }
  }

  function canOpenCurrentToolPanel(): boolean {
    return selectedTool === 'pen' || selectedTool === 'pencil' || selectedTool === 'highlighter' || selectedTool === 'eraser' || selectedTool === 'text' || selectedTool === 'shape' || selectedTool === 'hand';
  }

  function toggleCurrentToolPanel(): void {
    if (!canOpenCurrentToolPanel()) {
      activeToolPanel = null;
      closeStrokePopover();
      return;
    }

    const panel = panelForTool(selectedTool);
    activeToolPanel = activeToolPanel === panel ? null : panel;
    closeStrokePopover();
  }

  // ── Accessories (Timer, Ruler) ─────────────────────────────────────────

  function formatTimeKeeper(): string {
    const minutes = Math.floor(timeKeeperSeconds / 60);
    const seconds = timeKeeperSeconds % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  function setTimeKeeperRunning(next: boolean): void {
    timeKeeperRunning = next;
  }

  function resetTimeKeeper(): void {
    timeKeeperSeconds = 0;
  }

  function toggleTimeKeeper(): void {
    timeKeeperVisible = !timeKeeperVisible;
  }

  function toggleRuler(): void {
    rulerVisible = !rulerVisible;
  }

  function clampRulerOffset(offset: number): number {
    const viewportHeight = centerPane?.clientHeight ?? 0;
    if (viewportHeight <= 0) {
      return Math.max(56, offset);
    }

    return clampValue(offset, 56, Math.max(56, viewportHeight - 72));
  }

  function startRulerGesture(event: PointerEvent, mode: 'move' | 'rotate'): void {
    if (!rulerVisible) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    rulerGesture = {
      mode,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startOffsetY: rulerOffsetY,
      startAngle: rulerAngle
    };
  }

  function handleWindowPointerMove(event: PointerEvent): void {
    if (!rulerGesture || event.pointerId !== rulerGesture.pointerId) {
      return;
    }

    event.preventDefault();
    if (rulerGesture.mode === 'move') {
      rulerOffsetY = clampRulerOffset(rulerGesture.startOffsetY + (event.clientY - rulerGesture.startClientY));
      return;
    }

    rulerAngle = clampValue(rulerGesture.startAngle + (event.clientX - rulerGesture.startClientX) * 0.16, -45, 45);
  }

  function endRulerGesture(event?: PointerEvent): void {
    if (!rulerGesture) {
      return;
    }

    if (event && event.pointerId !== rulerGesture.pointerId) {
      return;
    }

    rulerGesture = null;
  }

  // ── Lasso Selection ───────────────────────────────────────────────────

  function handleSelectionChange(pageId: string, annotationIds: string[]): void {
    selectedAnnotationIdsByPage = {
      ...selectedAnnotationIdsByPage,
      [pageId]: annotationIds
    };

    const current = currentPage();
    if (current?.id === pageId) {
      lassoSelectionCount = annotationIds.length;
    }
  }

  /** Handle tape peek/reveal interactions from PageShell.
   *  - toggle: flip persistent reveal state (tap)
   *  - peek-start: temporarily reveal for hold gesture
   *  - peek-end: end hold, revert to pre-peek state
   */
  function handleTapePeek(tapeId: string, action: 'toggle' | 'peek-start' | 'peek-end'): void {
    if (action === 'toggle') {
      const next = new Set(revealedTapeIds);
      if (next.has(tapeId)) {
        next.delete(tapeId);
      } else {
        next.add(tapeId);
      }
      revealedTapeIds = next;
    } else if (action === 'peek-start') {
      // Track whether this tape was already persistently revealed before the peek
      if (revealedTapeIds.has(tapeId)) {
        prePeekRevealedIds = new Set([...prePeekRevealedIds, tapeId]);
      }
      peekingTapeIds = new Set([...peekingTapeIds, tapeId]);
      // Ensure the tape shows as revealed during the peek
      if (!revealedTapeIds.has(tapeId)) {
        revealedTapeIds = new Set([...revealedTapeIds, tapeId]);
      }
    } else if (action === 'peek-end') {
      if (peekingTapeIds.has(tapeId)) {
        const nextPeek = new Set(peekingTapeIds);
        nextPeek.delete(tapeId);
        peekingTapeIds = nextPeek;
        // Restore pre-peek state: if the tape was already revealed before peek, keep it revealed
        const wasRevealedBefore = prePeekRevealedIds.has(tapeId);
        const nextPrePeek = new Set(prePeekRevealedIds);
        nextPrePeek.delete(tapeId);
        prePeekRevealedIds = nextPrePeek;
        if (!wasRevealedBefore) {
          const nextRevealed = new Set(revealedTapeIds);
          nextRevealed.delete(tapeId);
          revealedTapeIds = nextRevealed;
        }
      }
    }
  }

  /** Reveal all tape strips on all pages */
  function revealAllTape(): void {
    const next = new Set(revealedTapeIds);
    for (const state of Object.values(pageState)) {
      for (const annotation of state.annotations) {
        if (annotation.type === 'tape') {
          next.add(annotation.id);
        }
      }
    }
    revealedTapeIds = next;
  }

  /** Hide all tape strips (reset all reveals) */
  function hideAllTape(): void {
    revealedTapeIds = new Set();
    peekingTapeIds = new Set();
    prePeekRevealedIds = new Set();
  }

  async function clearLassoSelection(): Promise<void> {
    const current = currentPage();
    if (!current) {
      return;
    }

    handleSelectionChange(current.id, []);
  }

  async function deleteLassoSelection(): Promise<void> {
    const current = currentPage();
    if (!current) {
      return;
    }

    const selectedIds = selectedAnnotationIdsByPage[current.id] ?? [];
    if (selectedIds.length === 0) {
      return;
    }

    const state = ensurePageState(current.id);
    await replaceAnnotations(
      current.id,
      state.annotations.filter((annotation) => !selectedIds.includes(annotation.id))
    );
    handleSelectionChange(current.id, []);
  }

  // ── Stroke Popover & Preset Management ─────────────────────────────────

  function currentStrokePresetValue(tool: AdjustableStrokeTool, preset: number): number {
    return toolStrokeWidthFromSettings(strokePresetSettings, tool, preset);
  }

  function currentStrokePopoverBounds(): { min: number; max: number; step: number } | null {
    const tool = strokePopover ? adjustableStrokeTool(strokePopover.tool) : null;
    return tool ? STROKE_BOUNDS[tool] : null;
  }

  function strokePresetDotStyle(preset: number): string {
    const tool = currentAdjustableStrokeTool();
    const size = strokePresetIndicatorSize(strokePresetSettings, tool, preset);
    return `width:${size}px; height:${size}px;`;
  }

  function openStrokePopover(tool: EditorTool, preset: number, target: HTMLElement | null): void {
    if (!readerScreen || !target) {
      return;
    }

    const rootRect = readerScreen.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const panelWidth = compactMode ? 320 : 360;
    const anchorCenter = targetRect.left - rootRect.left + targetRect.width / 2;
    const left = clampValue(anchorCenter - panelWidth / 2, 18, Math.max(18, rootRect.width - panelWidth - 18));
    const top = targetRect.bottom - rootRect.top + 14;
    const arrowLeft = clampValue(anchorCenter - left - 12, 24, panelWidth - 24);

    selectedTool = tool;
    selectedSize = preset;
    strokePopover = {
      tool,
      preset,
      left,
      top,
      arrowLeft
    };
    const adjustableTool = adjustableStrokeTool(tool);
    strokePopoverWidth = adjustableTool ? currentStrokePresetValue(adjustableTool, preset) : 0;
    strokePopoverBackdropVisible = true;
  }

  function closeStrokePopover(): void {
    strokePopover = null;
    strokePopoverWidth = 0;
    strokePopoverBackdropVisible = false;
  }

  function cancelLongPress(): void {
    if (longPressTimer) {
      window.clearTimeout(longPressTimer);
      longPressTimer = 0;
    }
  }

  function scheduleStrokePopoverLongPress(event: PointerEvent, tool: AdjustableStrokeTool, preset: number, key: string): void {
    if (usesExplicitStrokeSettingsTrigger()) {
      return;
    }

    if (event.pointerType !== 'mouse') {
      return;
    }

    if (event.button !== 0) {
      return;
    }

    cancelLongPress();
    const target = event.currentTarget as HTMLElement | null;
    longPressTimer = window.setTimeout(() => {
      longPressTimer = 0;
      suppressedClickKey = key;
      openStrokePopover(tool, preset, target);
    }, 420);
  }

  function shouldSuppressClick(key: string): boolean {
    if (suppressedClickKey !== key) {
      return false;
    }

    suppressedClickKey = '';
    return true;
  }

  function handleSizePresetSelect(event: MouseEvent, preset: number): void {
    const tool = currentAdjustableStrokeTool();
    if (tool && shouldSuppressClick(sizeButtonKey(tool, preset))) {
      return;
    }

    const target = event.currentTarget as HTMLElement | null;
    if (tool && selectedSize === preset && !usesExplicitStrokeSettingsTrigger()) {
      if (strokePopover && strokePopover.tool === tool && strokePopover.preset === preset) {
        closeStrokePopover();
      } else {
        openStrokePopover(tool, preset, target);
      }
      return;
    }

    selectedSize = preset;
    if (strokePopover && tool && strokePopover.tool === tool) {
      strokePopover = {
        ...strokePopover,
        preset
      };
    }
  }

  function handleSizePresetPointerDown(event: PointerEvent, preset: number): void {
    const tool = currentAdjustableStrokeTool();
    if (!tool) {
      return;
    }

    if (usesExplicitStrokeSettingsTrigger()) {
      return;
    }

    scheduleStrokePopoverLongPress(event, tool, preset, sizeButtonKey(tool, preset));
  }

  function usesExplicitStrokeSettingsTrigger(): boolean {
    return compactMode || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0);
  }

  function openCurrentStrokeSettings(event: MouseEvent): void {
    const target = event.currentTarget as HTMLElement | null;
    if (strokePopover && strokePopover.tool === selectedTool && strokePopover.preset === selectedSize) {
      closeStrokePopover();
      return;
    }

    openStrokePopover(selectedTool, selectedSize, target);
  }

  function setEraserStrokeMode(mode: EraserStrokeMode): void {
    eraserStrokeMode = mode;
  }

  function setStrokeStabilization(rawValue: string): void {
    const nextValue = Number.parseFloat(rawValue);
    if (!Number.isFinite(nextValue)) {
      return;
    }

    strokeStabilization = Math.max(0, Math.min(100, Math.round(nextValue)));
  }

  function restoreStrokeStabilization(): void {
    strokeStabilization = defaultStrokeStabilization();
  }

  function updateStrokePopoverWidth(rawValue: string): void {
    if (!strokePopover) {
      return;
    }

    const adjustableTool = adjustableStrokeTool(strokePopover.tool);
    if (!adjustableTool) {
      return;
    }

    const nextValue = Number.parseFloat(rawValue);
    if (!Number.isFinite(nextValue)) {
      return;
    }

    const nextSettings = updateStrokePresetWidth(strokePresetSettings, adjustableTool, strokePopover.preset, nextValue);
    strokePresetSettings = nextSettings;
    strokePopoverWidth = toolStrokeWidthFromSettings(nextSettings, adjustableTool, strokePopover.preset);
  }

  function restoreStrokePopoverPreset(): void {
    if (!strokePopover) {
      return;
    }

    const adjustableTool = adjustableStrokeTool(strokePopover.tool);
    if (!adjustableTool) {
      return;
    }

    const nextSettings = resetStrokePresetWidth(strokePresetSettings, adjustableTool, strokePopover.preset);
    strokePresetSettings = nextSettings;
    strokePopoverWidth = toolStrokeWidthFromSettings(nextSettings, adjustableTool, strokePopover.preset);
  }

  // ── Undo / Redo ──────────────────────────────────────────────────────

  /** Push a snapshot onto a history stack, capping at MAX_PAGE_HISTORY */
  function nextHistoryStack(stack: Annotation[][], snapshot: Annotation[]): Annotation[][] {
    const next = [...stack, snapshot];
    return next.length > MAX_PAGE_HISTORY ? next.slice(next.length - MAX_PAGE_HISTORY) : next;
  }

  async function undoCurrentPage(): Promise<void> {
    const page = historyTargetPage();
    if (!page) {
      return;
    }

    const state = ensurePageState(page.id);
    if (state.undoStack.length === 0) {
      return;
    }

    const previousAnnotations = state.undoStack[state.undoStack.length - 1];
    const nextState: PageRuntimeState = {
      ...state,
      annotations: previousAnnotations,
      annotationText: annotationTextFromAnnotations(previousAnnotations),
      dirty: true,
      saveError: '',
      localChangeCounter: state.localChangeCounter + 1,
      undoStack: state.undoStack.slice(0, -1),
      redoStack: nextHistoryStack(state.redoStack, state.annotations)
    };
    setPageState(page.id, nextState);
    focusEditedPage(page.id);
    lastEditedPageId = page.id;
    await queueSave(page.id, {
      mode: 'replace',
      annotations: previousAnnotations,
      annotationText: nextState.annotationText
    });
  }

  async function redoCurrentPage(): Promise<void> {
    const page = historyTargetPage();
    if (!page) {
      return;
    }

    const state = ensurePageState(page.id);
    if (state.redoStack.length === 0) {
      return;
    }

    const nextAnnotations = state.redoStack[state.redoStack.length - 1];
    const nextState: PageRuntimeState = {
      ...state,
      annotations: nextAnnotations,
      annotationText: annotationTextFromAnnotations(nextAnnotations),
      dirty: true,
      saveError: '',
      localChangeCounter: state.localChangeCounter + 1,
      undoStack: nextHistoryStack(state.undoStack, state.annotations),
      redoStack: state.redoStack.slice(0, -1)
    };
    setPageState(page.id, nextState);
    focusEditedPage(page.id);
    lastEditedPageId = page.id;
    await queueSave(page.id, {
      mode: 'replace',
      annotations: nextAnnotations,
      annotationText: nextState.annotationText
    });
  }

  async function clearCurrentPageAnnotations(): Promise<void> {
    const page = currentPage();
    if (!page) {
      return;
    }

    const state = ensurePageState(page.id);
    if (state.annotations.length === 0) {
      return;
    }

    await replaceAnnotations(page.id, []);
  }

  // ── Compact Mode / Viewport ───────────────────────────────────────────

  /** Re-evaluate compact mode breakpoint and reset panel state on change */
  function syncViewportMode(): void {
    const nextCompactMode = typeof window !== 'undefined' ? window.innerWidth <= 1080 : false;
    if (nextCompactMode === compactMode) {
      return;
    }

    compactMode = nextCompactMode;
    compactHeaderShown = false;
    compactPagesOpen = false;
    compactInspectorOpen = false;
    closeStrokePopover();
    cancelLongPress();
  }

  function setCompactHeaderShown(next: boolean): void {
    if (!compactMode) {
      return;
    }

    compactHeaderShown = next;
  }

  function clampZoom(value: number): number {
    return Math.max(zoomLevels[0], Math.min(zoomLevels[zoomLevels.length - 1], value));
  }

  function clampValue(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }

  function toggleCompactHeader(): void {
    if (!compactMode) {
      return;
    }

    if (compactHeaderVisibleState) {
      closeCompactPanels();
      compactHeaderShown = false;
      return;
    }

    compactHeaderShown = true;
  }

  const sizePresets = [
    { value: 1, label: 'Small size', className: 'small' },
    { value: 2, label: 'Medium size', className: 'medium' },
    { value: 3, label: 'Large size', className: 'large' }
  ] as const;

  // ── Thumbnail Helpers ─────────────────────────────────────────────────

  function thumbnailPreviewWidth(): number {
    const maxWidth = networkConfig.maxThumbnailWidth;
    return compactMode ? Math.min(120, maxWidth) : Math.min(240, maxWidth);
  }

  function thumbnailAnnotations(pageId: string): PageAnnotation[] {
    return (previewAnnotationsByPage[pageId] ?? pageStates[pageId]?.annotations ?? []) as PageAnnotation[];
  }

  function useClientThumbnail(pageId: string): boolean {
    const state = pageStates[pageId];
    return Boolean(previewAnnotationsByPage[pageId] || state?.dirty || state?.loaded);
  }

  function thumbnailServerSrc(pageId: string): string {
    const state = pageStates[pageId];
    const version = `${state?.annotationRevision ?? 0}-${state?.updatedAt ?? 'base'}`;
    return `/api/pages/${pageId}/thumbnail?width=${thumbnailPreviewWidth()}&v=${encodeURIComponent(version)}`;
  }

  function thumbnailBaseSrc(pageId: string): string {
    return `/api/pages/${pageId}/preview?width=${thumbnailPreviewWidth()}`;
  }

  function handlePreviewAnnotationsChange(pageId: string, annotations: PageAnnotation[] | null): void {
    previewAnnotationsByPage = {
      ...previewAnnotationsByPage,
      [pageId]: annotations
    };
    thumbnailRenderVersionByPage = {
      ...thumbnailRenderVersionByPage,
      [pageId]: (thumbnailRenderVersionByPage[pageId] ?? 0) + 1
    };
  }

  function thumbnailRenderKey(pageId: string): string {
    const state = pageStates[pageId];
    const previewVersion = thumbnailRenderVersionByPage[pageId] ?? 0;
    return `${pageId}:${state?.localChangeCounter ?? 0}:${state?.annotationRevision ?? 0}:${previewVersion}`;
  }

  function thumbnailKindLabel(page: DocumentBundle['pages'][number]): string {
    if (page.kind === 'pdf') {
      return 'PDF';
    }

    if (page.kind === 'blank') {
      return 'Blank';
    }

    if (page.kind === 'ruled') {
      return 'Ruled';
    }

    if (page.kind === 'grid') {
      return 'Grid';
    }

    if (page.kind === 'dot') {
      return 'Dot';
    }

    return page.template ?? page.kind;
  }

  function toggleCompactPages(): void {
    closeStrokePopover();
    compactPagesOpen = !compactPagesOpen;
    if (compactPagesOpen) {
      compactInspectorOpen = false;
      setCompactHeaderShown(true);
      return;
    }
  }

  function toggleCompactInspector(): void {
    closeStrokePopover();
    compactInspectorOpen = !compactInspectorOpen;
    if (compactInspectorOpen) {
      compactPagesOpen = false;
      setCompactHeaderShown(true);
      return;
    }
  }

  function closeCompactPanels(): void {
    compactPagesOpen = false;
    compactInspectorOpen = false;
    closeStrokePopover();
  }

  // ── Zoom & Pinch Gestures ─────────────────────────────────────────────

  function touchDistance(first: Touch, second: Touch): number {
    const dx = second.clientX - first.clientX;
    const dy = second.clientY - first.clientY;
    return Math.hypot(dx, dy);
  }

  function touchCenterInScrollPane(first: Touch, second: Touch): { x: number; y: number } | null {
    if (!scrollPane) {
      return null;
    }

    const rect = scrollPane.getBoundingClientRect();
    return {
      x: (first.clientX + second.clientX) / 2 - rect.left,
      y: (first.clientY + second.clientY) / 2 - rect.top
    };
  }

  function captureZoomAnchor(viewportX: number, viewportY: number): ZoomAnchor | null {
    if (!scrollPane || layout.pages.length === 0) {
      return null;
    }

    const contentX = scrollPane.scrollLeft + viewportX;
    const contentY = scrollPane.scrollTop + viewportY;
    const focusedPage =
      layout.pages.find((pageLayout) => contentY >= pageLayout.top && contentY <= pageLayout.top + pageLayout.height) ??
      layout.pages[Math.max(0, Math.min(layout.pages.length - 1, activePageIndex))] ??
      null;

    if (!focusedPage) {
      return null;
    }

    return {
      pageId: focusedPage.page.id,
      pageIndex: focusedPage.pageIndex,
      pageUnitX: clampValue((contentX - focusedPage.left) / focusedPage.scale, 0, focusedPage.page.width),
      pageUnitY: clampValue((contentY - focusedPage.top) / focusedPage.scale, 0, focusedPage.page.height),
      viewportX,
      viewportY
    };
  }

  function captureViewportCenterAnchor(): ZoomAnchor | null {
    if (!scrollPane) {
      return null;
    }

    return captureZoomAnchor(scrollPane.clientWidth / 2, scrollPane.clientHeight / 2);
  }

  function applyZoomAnchor(anchor: ZoomAnchor | null): void {
    if (!anchor || !scrollPane || layout.pages.length === 0) {
      return;
    }

    const pageLayout = layout.pages[anchor.pageIndex] ?? layout.pages.find((page) => page.page.id === anchor.pageId);
    if (!pageLayout) {
      return;
    }

    const contentX = pageLayout.left + anchor.pageUnitX * pageLayout.scale;
    const contentY = pageLayout.top + anchor.pageUnitY * pageLayout.scale;
    scrollPane.scrollLeft = Math.max(0, contentX - anchor.viewportX);
    scrollPane.scrollTop = Math.max(0, contentY - anchor.viewportY);
    scheduleVisibleState('zoom-anchor');
  }

  function scheduleZoomUpdate(nextZoom: number, reason: string, anchor: ZoomAnchor | null): void {
    const clampedZoom = clampZoom(nextZoom);
    const token = ++zoomUpdateToken;
    pendingZoomUpdate = {
      zoom: clampedZoom,
      reason,
      anchor,
      token
    };

    if (pinchFrame) {
      return;
    }

    pinchFrame = requestAnimationFrame(() => {
      pinchFrame = 0;
      const update = pendingZoomUpdate;
      pendingZoomUpdate = null;

      if (!update) {
        return;
      }

      if (Math.abs(update.zoom - zoom) > ZOOM_EPSILON) {
        zoom = update.zoom;
        recalcLayout(update.reason);
        // Apply anchor synchronously after layout recalc to avoid
        // the 1-frame jump on mobile where content shifts then snaps.
        applyZoomAnchor(update.anchor);
      }
    });
  }

  // ── Save & Sync ──────────────────────────────────────────────────────

  function globalSaveLabel(): string {
    const states = Object.values(pageStates);
    if (states.some((state) => state.saveError)) {
      return 'Save issue';
    }

    if (states.some((state) => state.saving)) {
      return 'Saving…';
    }

    if (states.some((state) => state.dirty)) {
      return 'Unsaved edits';
    }

    return 'Saved';
  }

  /** Write current page state to IndexedDB for local-first durability */
  async function persistDraft(pageId: string): Promise<void> {
    const state = ensurePageState(pageId);

    if (!bundle || !draftsAvailable) {
      return;
    }

    debugTimeline.log('draft-start', `Draft write started for ${pageId}`);

    try {
      if (state.dirty || state.annotations.length > 0) {
        await safeWriteDraft({
          pageId,
          documentId: bundle.document.id,
          annotations: state.annotations,
          annotationText: state.annotationText,
          annotationRevision: state.annotationRevision,
          updatedAt: state.updatedAt,
          dirty: state.dirty
        });
      } else {
        await safeDeleteDraft(pageId);
      }
    } finally {
      debugTimeline.log('draft-end', `Draft write finished for ${pageId}`);
    }
  }

  /** Fetch annotations from server, merge with local draft if newer */
  async function loadPageState(pageId: string, force = false): Promise<void> {
    const state = ensurePageState(pageId);
    if ((state.loaded && !force) || state.loading || !bundle) {
      return;
    }

    const startingLocalChangeCounter = state.localChangeCounter;

    setPageState(pageId, {
      ...state,
      loading: true
    });

    try {
      const remote = await fetchPageAnnotations(pageId);
      const draft = await safeReadDraft(pageId);
      let nextState: PageRuntimeState = {
        annotations: remote.annotations,
        annotationText: remote.annotationText,
        annotationRevision: remote.annotationRevision,
        updatedAt: remote.updatedAt,
        loaded: true,
        loading: false,
        dirty: false,
        saving: false,
        saveError: '',
        clientRevision: 0,
        localChangeCounter: 0,
        undoStack: [],
        redoStack: []
      };

      if (
        draft &&
        shouldUseDraft({
          draftDirty: draft.dirty,
          draftRevision: draft.annotationRevision,
          draftUpdatedAt: draft.updatedAt,
          remoteRevision: remote.annotationRevision,
          remoteUpdatedAt: remote.updatedAt
        })
      ) {
        nextState = {
          ...nextState,
          annotations: draft.annotations,
          annotationText: draft.annotationText,
          annotationRevision: draft.annotationRevision,
          updatedAt: draft.updatedAt,
          dirty: true
        };
      } else if (draft && !draft.dirty) {
        await safeDeleteDraft(pageId);
      }

      const latestState = ensurePageState(pageId);
      if (!force && latestState.localChangeCounter !== startingLocalChangeCounter) {
        return;
      }

      setPageState(pageId, nextState);
    } catch (error) {
      setPageState(pageId, {
        ...ensurePageState(pageId),
        loaded: true,
        loading: false,
        saveError: error instanceof Error ? error.message : 'Could not load page annotations.'
      });
    }
  }

  // IndexedDB draft helpers — disable drafts for the session if any call fails
  async function safeReadDraft(pageId: string): Promise<PageDraftRecord | null> {
    if (!draftsAvailable) {
      return null;
    }

    try {
      return await readDraft(pageId);
    } catch (error) {
      draftsAvailable = false;
      debugTimeline.log(
        'draft-end',
        `Draft reads disabled for this session: ${error instanceof Error ? error.message : 'Draft read failed.'}`
      );
      return null;
    }
  }

  async function safeWriteDraft(record: PageDraftRecord): Promise<void> {
    if (!draftsAvailable) {
      return;
    }

    try {
      await writeDraft(record);
    } catch (error) {
      draftsAvailable = false;
      debugTimeline.log(
        'draft-end',
        `Draft writes disabled for this session: ${error instanceof Error ? error.message : 'Draft write failed.'}`
      );
    }
  }

  async function safeDeleteDraft(pageId: string): Promise<void> {
    if (!draftsAvailable) {
      return;
    }

    try {
      await deleteDraft(pageId);
    } catch (error) {
      draftsAvailable = false;
      debugTimeline.log(
        'draft-end',
        `Draft deletes disabled for this session: ${error instanceof Error ? error.message : 'Draft delete failed.'}`
      );
    }
  }

  /** Process queued saves for a page sequentially, stopping on error */
  async function drainSaves(pageId: string): Promise<void> {
    if (drainingPages.has(pageId) || !bundle) {
      return;
    }

    drainingPages.add(pageId);

    try {
      while ((pendingSaves.get(pageId)?.length ?? 0) > 0) {
        const queue = pendingSaves.get(pageId) ?? [];
        const item = queue.shift();
        pendingSaves.set(pageId, queue);

        if (!item) {
          continue;
        }

        const current = ensurePageState(pageId);
        setPageState(pageId, {
          ...current,
          saving: true,
          saveError: ''
        });

        debugTimeline.log('save-start', `${item.mode} save for ${pageId}`);

        try {
          const response = await savePage(pageId, {
            mode: item.mode,
            annotations: item.annotations,
            annotationText: item.annotationText,
            clientId,
            clientRevision: current.clientRevision + 1,
            baseRevision: current.annotationRevision
          });

          const latest = ensurePageState(pageId);
          const nextState: PageRuntimeState = {
            ...latest,
            annotationRevision: response.annotationRevision,
            updatedAt: response.updatedAt,
            clientRevision: latest.clientRevision + 1,
            saving: false,
            saveError: '',
            dirty: (pendingSaves.get(pageId)?.length ?? 0) > 0
          };
          setPageState(pageId, nextState);
          void persistDraft(pageId);
          debugTimeline.log('save-end', `${item.mode} save finished for ${pageId}`);
          logStudyEvent('page.edited', documentId, pageId, { mode: item.mode, strokeCount: item.annotations.length });
        } catch (error) {
          const latest = ensurePageState(pageId);
          const message = error instanceof Error ? error.message : 'Could not save page.';
          setPageState(pageId, {
            ...latest,
            saving: false,
            saveError: message,
            dirty: true
          });
          pendingSaves.set(pageId, []);
          void persistDraft(pageId);
          debugTimeline.log('save-end', `${item.mode} save failed for ${pageId}: ${message}`);
          break;
        }
      }
    } finally {
      drainingPages.delete(pageId);
    }
  }

  async function queueSave(pageId: string, item: SaveItem): Promise<void> {
    const queue = pendingSaves.get(pageId) ?? [];
    if (item.mode === 'replace') {
      pendingSaves.set(pageId, [item]);
    } else {
      queue.push(item);
      pendingSaves.set(pageId, queue);
    }

    void persistDraft(pageId);
    void drainSaves(pageId);
  }

  // ── Annotation Mutation (called by PageShell) ──────────────────────────

  /** Add new annotations to a page (optimistic update + server save) */
  async function appendAnnotations(pageId: string, appended: Annotation[]): Promise<void> {
    const state = ensurePageState(pageId);
    const nextAnnotations = [...state.annotations, ...appended];
    const nextState: PageRuntimeState = {
      ...state,
      annotations: nextAnnotations,
      annotationText: annotationTextFromAnnotations(nextAnnotations),
      dirty: true,
      saveError: '',
      localChangeCounter: state.localChangeCounter + 1,
      undoStack: nextHistoryStack(state.undoStack, state.annotations),
      redoStack: []
    };
    setPageState(pageId, nextState);
    focusEditedPage(pageId);
    lastEditedPageId = pageId;
    await queueSave(pageId, {
      mode: 'append',
      annotations: appended,
      annotationText: nextState.annotationText
    });
  }

  async function replaceAnnotations(pageId: string, annotations: Annotation[]): Promise<void> {
    const state = ensurePageState(pageId);
    const nextState: PageRuntimeState = {
      ...state,
      annotations,
      annotationText: annotationTextFromAnnotations(annotations),
      dirty: true,
      saveError: '',
      localChangeCounter: state.localChangeCounter + 1,
      undoStack: nextHistoryStack(state.undoStack, state.annotations),
      redoStack: []
    };
    setPageState(pageId, nextState);
    focusEditedPage(pageId);
    lastEditedPageId = pageId;
    await queueSave(pageId, {
      mode: 'replace',
      annotations,
      annotationText: nextState.annotationText
    });
  }

  // ── Layout & Visibility ───────────────────────────────────────────────

  /** Recompute which pages are in the viewport and which is "active" */
  function updateVisibleState(reason: string): void {
    if (!bundle || !scrollPane) {
      return;
    }

    // Keep 2 extra pages mounted outside viewport when idle, 1 during scroll
    const nextVisible = layoutEngine.getVisibleWindow(layout, scrollPane.scrollTop, scrollPane.clientHeight, scrolling ? 1 : 2);
    if (nextVisible.start !== visibleWindow.start || nextVisible.end !== visibleWindow.end) {
      visibleWindow = nextVisible;
      debugTimeline.log('visible-range', `${reason}: ${nextVisible.start + 1}-${nextVisible.end + 1}`);
    }

    const nextActive = layoutEngine.getActivePage(layout, scrollPane.scrollTop, scrollPane.clientHeight);
    if (nextActive !== activePageIndex) {
      activePageIndex = nextActive;
      debugTimeline.log('active-page', `Active page ${nextActive + 1}`);
    }
  }

  function scheduleVisibleState(reason: string): void {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      updateVisibleState(reason);
    });
  }

  function recalcLayout(reason: string): void {
    const viewportWidth = scrollPane?.clientWidth ?? centerPane?.clientWidth ?? 0;
    if (!bundle || !centerPane || viewportWidth === 0) {
      return;
    }

    syncViewportMode();
    layout = layoutEngine.build(bundle.pages, viewportWidth, zoom);
    debugTimeline.log('layout-recalc', `${reason}: ${bundle.pages.length} pages at ${currentZoomLabel()}`);
    scheduleVisibleState(reason);
  }

  // ── Document Loading ──────────────────────────────────────────────────

  async function loadDocument(): Promise<void> {
    if (!documentId) {
      return;
    }

    pendingLoadDocumentId = documentId;
    loading = true;
    errorMessage = '';

    try {
      const nextBundle = await fetchDocument(documentId);
      if (pendingLoadDocumentId !== documentId) {
        return;
      }

      bundle = nextBundle;
      connectSync(nextBundle.document.id);
      searchState = { indexing: false, results: [] };
      pageStates = Object.fromEntries(nextBundle.pages.map((page) => [page.id, normalizePageState(pageStates[page.id])]));
      if (!nextBundle.pages.some((page) => page.id === lastEditedPageId)) {
        lastEditedPageId = null;
      }
      statusMessage = `${nextBundle.document.pageCount} pages loaded with fixed shell metadata.`;
      await tick();
      recalcLayout('document-load');
      await tick();

      if (scrollPane) {
        const bookmarkIndex = nextBundle.document.bookmarkPageId
          ? nextBundle.pages.findIndex((page) => page.id === nextBundle.document.bookmarkPageId)
          : 0;
        scrollToPage(Math.max(bookmarkIndex, 0), 'auto');
      }

      // Start background pre-downloading per-page PDFs on slow/medium connections
      if (connectionQuality !== 'fast') {
        void startBackgroundDownload(nextBundle.pages, Math.max(activePageIndex, 0));
      }
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Could not open the document.';
    } finally {
      loading = false;
    }
  }

  /** Swap in a new bundle after page insert/delete, preserving dirty state */
  async function replaceBundle(nextBundle: DocumentBundle, focusPageId?: string): Promise<void> {
    stopBackgroundDownload();
    bundle = nextBundle;
    connectSync(nextBundle.document.id);
    pageStates = Object.fromEntries(
      nextBundle.pages.map((page) => {
        const current = pageStates[page.id];
        if (!current) {
          return [page.id, defaultPageState()];
        }

        return [
          page.id,
          normalizePageState({
            ...current,
            undoStack: [],
            redoStack: []
          })
        ];
      })
    );
    if (!nextBundle.pages.some((page) => page.id === lastEditedPageId)) {
      lastEditedPageId = null;
    }
    await tick();
    recalcLayout('bundle-update');
    await tick();

    if (!scrollPane) {
      return;
    }

    const targetPageId = focusPageId ?? nextBundle.document.bookmarkPageId ?? nextBundle.pages[activePageIndex]?.id ?? nextBundle.pages[0]?.id;
    const targetIndex = targetPageId ? nextBundle.pages.findIndex((page) => page.id === targetPageId) : 0;
    scrollToPage(Math.max(targetIndex, 0), 'auto');

    if (connectionQuality !== 'fast') {
      void startBackgroundDownload(nextBundle.pages, Math.max(targetIndex, 0));
    }
  }

  // ── Scroll & Page Navigation ──────────────────────────────────────────

  function scrollToPage(pageIndex: number, behavior: ScrollBehavior = 'smooth'): void {
    if (!scrollPane || !layout.pages[pageIndex]) {
      return;
    }

    // For large jumps (e.g., navbar navigation), suspend rendering during the
    // transition so intermediate pages don't waste connection slots with PDF
    // downloads. The scrollEndTimer (140ms after scroll stops) will reset this.
    const jumpDistance = Math.abs(pageIndex - activePageIndex);
    if (jumpDistance > 3 && !scrolling) {
      scrolling = true;
    }

    const page = layout.pages[pageIndex];
    scrollPane.scrollTo({
      top: Math.max(page.top - 16, 0),
      behavior
    });
    activePageIndex = pageIndex;
    scheduleVisibleState('scroll-to-page');
  }

  /** Lock/unlock scroll position while drawing to prevent drift */
  function setInkScrollLock(active: boolean): void {
    if (!scrollPane) {
      inkScrollLocked = active;
      return;
    }

    if (active) {
      inkLockedScrollTop = scrollPane.scrollTop;
      inkLockedScrollLeft = scrollPane.scrollLeft;
      inkScrollLocked = true;
      debugTimeline.log('ink-lock', `Locked scroll for page ${activePageIndex + 1}`);
      return;
    }

    if (inkScrollLocked) {
      debugTimeline.log('ink-lock', `Released scroll lock for page ${activePageIndex + 1}`);
    }
    inkScrollLocked = false;
  }

  function restoreInkScrollPosition(): void {
    if (!scrollPane || restoringInkScroll) {
      return;
    }

    restoringInkScroll = true;
    scrollPane.scrollTo({
      top: inkLockedScrollTop,
      left: inkLockedScrollLeft,
      behavior: 'auto'
    });

    requestAnimationFrame(() => {
      restoringInkScroll = false;
    });
  }

  function handleScroll(): void {
    if (inkScrollLocked) {
      restoreInkScrollPosition();
      return;
    }

    if (strokePopover) {
      closeStrokePopover();
    }

    const velocity = Math.abs((scrollPane.scrollTop - lastScrollY) / (Date.now() - lastScrollTime || 1));
    lastScrollY = scrollPane.scrollTop;
    lastScrollTime = Date.now();

    // 2.0 px/ms ≈ 2000 px/sec — only fast flicking suspends renders
    if (velocity > 2.0 && !scrolling) {
      scrolling = true;
      debugTimeline.log('scroll-start', 'Reader scroll started');
    }

    if (compactMode && (compactPagesOpen || compactInspectorOpen)) {
      compactPagesOpen = false;
      compactInspectorOpen = false;
    }

    window.clearTimeout(scrollEndTimer);
    scrollEndTimer = window.setTimeout(() => {
      scrolling = false;
      if (touchMomentumActive) {
        touchMomentumActive = false;
        debugTimeline.log('momentum-end', 'Touch momentum ended');
      }
      debugTimeline.log('scroll-end', 'Reader scroll ended');
      scheduleVisibleState('scroll-end');
    }, 140);

    scheduleVisibleState('scroll');
  }

  // ── Touch Gesture Handlers ────────────────────────────────────────────

  function handleTouchStart(event: TouchEvent): void {
    touchGestureActive = true;
    if (touchMomentumActive) {
      touchMomentumActive = false;
      debugTimeline.log('momentum-end', 'Touch momentum interrupted by a new touch gesture');
    }

    if (event.touches.length === 2) {
      const center = touchCenterInScrollPane(event.touches[0], event.touches[1]);
      pinchGesture = {
        startDistance: touchDistance(event.touches[0], event.touches[1]),
        startZoom: zoom,
        anchor: center ? captureZoomAnchor(center.x, center.y) : null
      };
      touchGestureActive = false;
      event.preventDefault();
      debugTimeline.log('zoom-pinch-start', `Pinch started at ${zoomLabel}`);
    }
  }

  function handleTouchMove(event: TouchEvent): void {
    if (!pinchGesture || event.touches.length !== 2) {
      return;
    }

    const nextDistance = touchDistance(event.touches[0], event.touches[1]);
    const center = touchCenterInScrollPane(event.touches[0], event.touches[1]);
    if (!center || nextDistance <= 0) {
      return;
    }

    const nextZoom = pinchGesture.startZoom * (nextDistance / pinchGesture.startDistance);
    scheduleZoomUpdate(nextZoom, 'pinch', pinchGesture.anchor ? { ...pinchGesture.anchor, viewportX: center.x, viewportY: center.y } : null);
    event.preventDefault();
  }

  function handleTouchEnd(): void {
    if (pinchGesture) {
      pinchGesture = null;
      touchGestureActive = false;
      debugTimeline.log('zoom-pinch-end', `Pinch ended at ${zoomLabel}`);
      return;
    }

    if (touchGestureActive && scrolling && !touchMomentumActive) {
      touchMomentumActive = true;
      debugTimeline.log('momentum-start', 'Touch momentum started');
    }
    touchGestureActive = false;
  }

  // ── Zoom Controls ─────────────────────────────────────────────────────

  /** Find the closest discrete zoom level for the current value */
  function resolveZoomLevelIndex(value: number): number {
    const exactIndex = zoomLevels.findIndex((level) => Math.abs(level - value) <= ZOOM_EPSILON);
    if (exactIndex !== -1) {
      return exactIndex;
    }

    if (value <= zoomLevels[0]) {
      return 0;
    }

    if (value >= zoomLevels[zoomLevels.length - 1]) {
      return zoomLevels.length - 1;
    }

    for (let index = 0; index < zoomLevels.length - 1; index += 1) {
      const current = zoomLevels[index];
      const next = zoomLevels[index + 1];
      if (value > current && value < next) {
        const currentDistance = Math.abs(value - current);
        const nextDistance = Math.abs(next - value);
        return currentDistance <= nextDistance ? index : index + 1;
      }
    }

    return zoomLevels.length - 1;
  }

  function changeZoom(direction: -1 | 1): void {
    const currentIndex = resolveZoomLevelIndex(zoom);
    const nextIndex = Math.max(0, Math.min(zoomLevels.length - 1, currentIndex + direction));
    if (nextIndex === currentIndex) {
      return;
    }

    scheduleZoomUpdate(zoomLevels[nextIndex], 'zoom', captureViewportCenterAnchor());
  }

  function resetZoom(): void {
    if (Math.abs(zoom - 1) <= ZOOM_EPSILON) {
      return;
    }

    scheduleZoomUpdate(1, 'zoom-reset', captureViewportCenterAnchor());
  }

  // ── Page & Document Operations ─────────────────────────────────────────

  async function bookmarkCurrentPage(): Promise<void> {
    if (!bundle || !currentPage()) {
      return;
    }

    busy = true;
    try {
      const nextBundle = await updateBookmark(bundle.document.id, { pageId: currentPage()?.id ?? null });
      statusMessage = `Bookmarked page ${activePageIndex + 1}.`;
      await replaceBundle(nextBundle, currentPage()?.id);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Could not update bookmark.';
    } finally {
      busy = false;
    }
  }

  async function addBlankPage(placement: 'before' | 'after'): Promise<void> {
    if (!bundle || !currentPage()) {
      return;
    }

    busy = true;
    try {
      const nextBundle = await insertBlankPage(bundle.document.id, {
        anchorPageId: currentPage()!.id,
        placement,
        template: 'ruled'
      });
      statusMessage = `Inserted a ${placement} blank page.`;
      logStudyEvent('page.created', documentId, undefined, { template: 'ruled', placement });
      await replaceBundle(nextBundle, currentPage()?.id);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Could not insert blank page.';
    } finally {
      busy = false;
    }
  }

  function requestPdfInsert(placement: 'before' | 'after'): void {
    pendingInsertPlacement = placement;
    insertPdfInput?.click();
  }

  async function handlePdfInsert(event: Event): Promise<void> {
    if (!bundle || !currentPage()) {
      return;
    }

    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      return;
    }

    const pageRange = window.prompt('Page range to insert (for example 12-18, 24). Leave blank for all pages.', '') ?? '';
    busy = true;

    try {
      const nextBundle = await insertPdfPages({
        documentId: bundle.document.id,
        file,
        anchorPageId: currentPage()!.id,
        placement: pendingInsertPlacement,
        pageRange
      });
      statusMessage = `Inserted PDF pages ${pendingInsertPlacement} page ${activePageIndex + 1}.`;
      await replaceBundle(nextBundle, currentPage()?.id);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Could not insert PDF pages.';
    } finally {
      busy = false;
      input.value = '';
    }
  }

  async function removeCurrentPage(): Promise<void> {
    if (!bundle || !currentPage() || !window.confirm(`Delete page ${activePageIndex + 1}?`)) {
      return;
    }

    busy = true;
    try {
      const nextBundle = await deletePage(currentPage()!.id);
      statusMessage = 'Page deleted.';
      logStudyEvent('page.deleted', documentId, currentPage()?.id);
      await replaceBundle(nextBundle);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Could not delete page.';
    } finally {
      busy = false;
    }
  }

  async function removeDocumentAndClose(): Promise<void> {
    if (!bundle || !window.confirm(`Delete "${bundle.document.title}"?`)) {
      return;
    }

    busy = true;
    try {
      await deleteDocument(bundle.document.id);
      dispatch('close');
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Could not delete document.';
    } finally {
      busy = false;
    }
  }

  // ── Search ────────────────────────────────────────────────────────────

  async function runSearch(): Promise<void> {
    if (!bundle) {
      return;
    }

    searchBusy = true;
    try {
      searchState = await searchDocument(bundle.document.id, searchText);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Search failed.';
    } finally {
      searchBusy = false;
    }
  }

  function exportPdf(): void {
    if (!bundle) {
      return;
    }

    window.open(`/api/documents/${bundle.document.id}/export`, '_blank', 'noopener');
    logStudyEvent('document.exported', bundle.document.id);
  }

  // ── WebSocket Sync ────────────────────────────────────────────────────

  /** Open a WebSocket for realtime page/document sync events */
  function connectSync(nextDocumentId: string): void {
    syncSocket?.close();
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    syncSocket = new WebSocket(`${protocol}//${window.location.host}/ws/documents/${nextDocumentId}`);
    syncSocket.onmessage = async (event) => {
      const payload = JSON.parse(event.data) as SyncEvent;
      debugTimeline.log('sync-receive', payload.type);

      if (payload.type === 'page.updated') {
        if (payload.senderClientId === clientId) {
          return;
        }

        const state = ensurePageState(payload.pageId);
        if (state.dirty) {
          return;
        }

        await loadPageState(payload.pageId, true);
        debugTimeline.log('sync-apply', `Applied remote page update for ${payload.pageId}`);
        return;
      }

      if (payload.type === 'document.changed') {
        if (!bundle || Object.values(pageStates).some((state) => state.dirty)) {
          return;
        }

        const nextBundle = await fetchDocument(bundle.document.id);
        await replaceBundle(nextBundle, currentPage()?.id);
        debugTimeline.log('sync-apply', `Applied remote document change for ${bundle.document.id}`);
      }
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  onMount(() => {
    syncViewportMode();
    window.addEventListener('pointermove', handleWindowPointerMove, { passive: false });
    window.addEventListener('pointerup', endRulerGesture);
    window.addEventListener('pointercancel', endRulerGesture);
    strokePresetSettings = loadStrokePresetSettings();
    strokePresetSettingsLoaded = true;
    eraserStrokeMode = loadEraserStrokeMode();
    eraserStrokeModeLoaded = true;
    strokeStabilization = loadStrokeStabilization();
    strokeStabilizationLoaded = true;
    void loadDocument();

    resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        recalcLayout('resize');
      });
    });

    if (centerPane) {
      resizeObserver.observe(centerPane);
    }

    // Start/stop background downloader when connection quality changes
    const unsubQuality = onQualityChange((quality, config) => {
      connectionQuality = quality;
      networkConfig = config;
      if (quality !== 'fast' && bundle && !isBackgroundDownloadActive()) {
        void startBackgroundDownload(bundle.pages, Math.max(activePageIndex, 0));
      } else if (quality === 'fast') {
        stopBackgroundDownload();
      }
    });
    qualityUnsub = unsubQuality;
  });

  onDestroy(() => {
    resizeObserver?.disconnect();
    window.removeEventListener('pointermove', handleWindowPointerMove);
    window.removeEventListener('pointerup', endRulerGesture);
    window.removeEventListener('pointercancel', endRulerGesture);
    cancelAnimationFrame(resizeFrame);
    cancelAnimationFrame(scrollFrame);
    cancelAnimationFrame(pinchFrame);
    window.clearTimeout(scrollEndTimer);
    window.clearInterval(timeKeeperTimer);
    cancelLongPress();
    syncSocket?.close();
    stopBackgroundDownload();
    qualityUnsub?.();
  });

  // ── Reactive Side-Effects ──────────────────────────────────────────────

  // Re-load document when documentId prop changes externally
  $: if (documentId && documentId !== pendingLoadDocumentId) {
    void loadDocument();
  }

  // Manage timekeeper interval lifecycle
  $: {
    window.clearInterval(timeKeeperTimer);
    if (timeKeeperVisible && timeKeeperRunning) {
      timeKeeperTimer = window.setInterval(() => {
        timeKeeperSeconds += 1;
      }, 1000);
    }
  }

  // Slice page layouts for the currently visible viewport range
  $: visibleLayouts =
    visibleWindow.end >= visibleWindow.start ? layout.pages.slice(visibleWindow.start, visibleWindow.end + 1) : [];

  // During scrolling, only load annotations for pages that already have data
  $: annotationLoadLayouts = scrolling || inkScrollLocked
    ? visibleLayouts.filter((pageLayout) => {
        const state = pageStates[pageLayout.page.id];
        return Boolean(state?.loaded || state?.dirty);
      })
    : visibleLayouts;

  // Trigger annotation fetch for pages entering the visible window
  $: if (annotationLoadLayouts.length > 0) {
    annotationLoadLayouts.forEach((pageLayout) => {
      void loadPageState(pageLayout.page.id);
    });
  }

  $: if (thumbnailSidebarPages.length > 0) {
    // On slow/medium connections, skip eager annotation loading for thumbnails.
    // Thumbnails use the server-rendered SVG preview which doesn't need annotation data.
    // This prevents 37MB+ annotation payloads from choking the connection.
    if (connectionQuality === 'fast') {
      thumbnailSidebarPages.forEach((page) => {
        void loadPageState(page.id);
      });
    }
  }

  $: if (!scrolling && bundle && activePageIndex >= 0) {
    void prefetchAdjacentPages(activePageIndex);

    // Abort in-flight background downloads to free connection slots for
    // the active page. New background downloads restart automatically
    // with `priority: 'low'` so the browser serves the active page's
    // PDF.js render and preview first.
    updateActiveIndex(activePageIndex);
  }

  /** Pre-cache per-page PDFs around the active page for fast navigation */
  async function prefetchAdjacentPages(centerIndex: number): Promise<void> {
    const quality = connectionQuality;
    // On slow/medium connections, wait for visible pages to finish rendering
    // before firing prefetch requests. This prevents prefetch from stealing
    // the browser's limited connection slots (~6 per origin) from the
    // active page's PDF.js range requests.
    if (quality !== 'fast') {
      await waitForIdle();
    }

    const pages = bundle?.pages ?? [];
    const radius = networkConfig.prefetchRadius;
    const offsets: number[] = [];
    for (let d = 1; d <= radius; d += 1) {
      offsets.push(centerIndex - d, centerIndex + d);
    }
    const targets = offsets.filter((i) => i >= 0 && i < pages.length && i !== centerIndex);
    for (const i of targets) {
      const page = pages[i];
      if (!page || page.kind !== 'pdf') continue;
      const file = fileLookup(page);
      if (!file) continue;
      void prefetchPdfPage(file, page);
    }
  }

  // Persist stroke settings to localStorage whenever they change
  $: if (strokePresetSettingsLoaded) {
    saveStrokePresetSettings(strokePresetSettings);
  }
  $: if (eraserStrokeModeLoaded) {
    saveEraserStrokeMode(eraserStrokeMode);
  }
  $: if (strokeStabilizationLoaded) {
    saveStrokeStabilization(strokeStabilization);
  }

  // Close stroke popover when the user switches to a different tool
  $: if (strokePopover && selectedTool !== strokePopover.tool) {
    closeStrokePopover();
  }

  $: compactHeaderVisibleState = !compactMode || compactHeaderShown || compactPagesOpen || compactInspectorOpen;

  // Reactive map: pageIndex → chapter title (for thumbnail dividers)
  $: chapterStartMap = new Map(chapters.map(c => [c.startPageIndex, c.title]));

  // Track active page for study session
  $: getStudySession().updatePageIndex(activePageIndex);
</script>

<svelte:head>
  <title>{bundle ? `${bundle.document.title} · Inkflow` : 'Inkflow Reader'}</title>
</svelte:head>

<!-- ═══ Hidden PDF File Input ═══ -->
<input bind:this={insertPdfInput} class="hidden-input" type="file" accept="application/pdf,.pdf" on:change={handlePdfInsert} />

<!-- ═══ Reader Screen Root ═══ -->
<div
  bind:this={readerScreen}
  class:browser-safe-topbar={browserSafeTopbar}
  class:compact-header-open={compactMode && compactHeaderVisibleState}
  class:compact-mode={compactMode}
  class="reader-screen"
  data-compact-header={compactMode && compactHeaderVisibleState ? 'shown' : 'hidden'}
>
  <!-- ═══ Header (compact mode only) ═══ -->
  {#if compactMode}
    <header class="reader-header compact-header">
      <div class="reader-header-row compact-row">
        <div class="reader-left-actions compact-left">
          <button
            class="icon-button compact-top-button"
            type="button"
            aria-label="Back to library"
            on:click={() => dispatch('close')}
          >
            ‹
          </button>
          <div class="reader-title-pill compact-title">
            <strong>{bundle?.document.title ?? 'Loading document…'}</strong>
          </div>
        </div>

        <div class="reader-right-actions compact-actions">
          <button
            class="icon-button compact-top-button"
            type="button"
            aria-label="Open page tray"
            on:click={toggleCompactPages}
          >
            ☰
          </button>
          <button
            class="icon-button compact-top-button"
            type="button"
            aria-label="Open document actions"
            on:click={toggleCompactInspector}
          >
            ⋯
          </button>
        </div>
      </div>
    </header>
  {/if}

  <!-- ═══ Stroke Popover ═══ -->
  {#if strokePopoverBackdropVisible && strokePopover}
    <button aria-label="Close stroke settings" class="stroke-popover-backdrop" type="button" on:click={closeStrokePopover}></button>
  {/if}

  {#if strokePopover}
    <div
      aria-label={strokePopoverTitle(strokePopover.tool)}
      class="stroke-popover"
      role="dialog"
      style={`left:${strokePopover.left}px; top:${strokePopover.top}px; --tool-accent:${currentToolAccent()};`}
    >
      <div class="stroke-popover-arrow" style={`left:${strokePopover.arrowLeft}px;`}></div>
      <div class="stroke-popover-header">
        <svg aria-hidden="true" class="stroke-popover-icon" viewBox="0 0 24 24">
          <path d="M4 7h10M4 17h16M14 7a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM8 17a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.8" />
        </svg>
        <div class="stroke-popover-header-copy">
          <strong>{strokePopoverTitle(strokePopover.tool)}</strong>
          <span>{quickPresetLabel()} preset · {strokePopover.preset}</span>
        </div>
      </div>

      {#if strokePopover.tool === 'eraser'}
        <div class="stroke-popover-mode-group" role="group" aria-label="Eraser mode">
          <button
            class:active={eraserStrokeMode === 'whole'}
            class="stroke-mode-button"
            type="button"
            on:click={() => setEraserStrokeMode('whole')}
          >
            Whole stroke
          </button>
          <button
            class:active={eraserStrokeMode === 'partial'}
            class="stroke-mode-button"
            type="button"
            on:click={() => setEraserStrokeMode('partial')}
          >
            Partial
          </button>
        </div>
      {:else if strokePopover.tool === 'shape'}
        <div class="stroke-popover-secondary-group">
          <div class="stroke-popover-secondary-header">
            <strong>Shape kind</strong>
            <span>{selectedShapeKind}</span>
          </div>
          <div class="shape-options popover-shape-options">
            <button class:active={selectedShapeKind === 'rectangle'} class="shape-button popover-shape-button" type="button" on:click={() => (selectedShapeKind = 'rectangle')}>▭</button>
            <button class:active={selectedShapeKind === 'ellipse'} class="shape-button popover-shape-button" type="button" on:click={() => (selectedShapeKind = 'ellipse')}>◯</button>
            <button class:active={selectedShapeKind === 'triangle'} class="shape-button popover-shape-button" type="button" on:click={() => (selectedShapeKind = 'triangle')}>△</button>
            <button class:active={selectedShapeKind === 'diamond'} class="shape-button popover-shape-button" type="button" on:click={() => (selectedShapeKind = 'diamond')}>◆</button>
          </div>
        </div>

        <div class="stroke-popover-mode-group" role="group" aria-label="Shape fill and border">
          <button class:active={selectedShapeFill} class="stroke-mode-button" type="button" on:click={() => (selectedShapeFill = !selectedShapeFill)}>
            {selectedShapeFill ? 'Filled' : 'Outline'}
          </button>
          <button class:active={selectedShapeLineStyle === 'solid'} class="stroke-mode-button" type="button" on:click={() => (selectedShapeLineStyle = 'solid')}>
            Solid
          </button>
          <button class:active={selectedShapeLineStyle === 'dashed'} class="stroke-mode-button" type="button" on:click={() => (selectedShapeLineStyle = 'dashed')}>
            Dashed
          </button>
          <button class:active={selectedShapeLineStyle === 'dotted'} class="stroke-mode-button" type="button" on:click={() => (selectedShapeLineStyle = 'dotted')}>
            Dotted
          </button>
        </div>

        <div class="stroke-popover-secondary-group">
          <div class="stroke-popover-secondary-header">
            <strong>Color</strong>
            <span>{selectedColor}</span>
          </div>
          <div class="palette-group popover-palette-group">
            {#each colorChips as color}
              <button
                class:active={selectedColor === color}
                class="color-chip popover-chip"
                type="button"
                aria-label={`Choose ${color}`}
                style={`background:${color}`}
                on:click={() => (selectedColor = color)}
              ></button>
            {/each}
          </div>
        </div>
      {:else if strokePopover.tool === 'text'}
        <div class="stroke-popover-info-card">
          <strong>Tap the page to place a note.</strong>
          <p>Text notes use the current ink color and can be erased or moved like the other annotations.</p>
        </div>
        <div class="stroke-popover-secondary-group">
          <div class="stroke-popover-secondary-header">
            <strong>Text size</strong>
            <span>{textFontSize}px</span>
          </div>
          <div class="text-size-group">
            {#each textSizePresets as size}
              <button class:active={textFontSize === size} class="shape-button popover-shape-button" type="button" on:click={() => (textFontSize = size)}>
                {size}
              </button>
            {/each}
          </div>
        </div>
        <div class="stroke-popover-secondary-group">
          <div class="stroke-popover-secondary-header">
            <strong>Color</strong>
            <span>{selectedColor}</span>
          </div>
          <div class="palette-group popover-palette-group">
            {#each colorChips as color}
              <button
                class:active={selectedColor === color}
                class="color-chip popover-chip"
                type="button"
                aria-label={`Choose ${color}`}
                style={`background:${color}`}
                on:click={() => (selectedColor = color)}
              ></button>
            {/each}
          </div>
        </div>
      {:else if strokePopover.tool === 'hand'}
        <div class="stroke-popover-info-card">
          <strong>Pan and zoom the reader.</strong>
          <p>Use the utility strip below for undo, redo, zoom, and the stylus-only toggle.</p>
        </div>
      {:else}
        <div class="stroke-popover-secondary-group">
          <div class="stroke-popover-secondary-header">
            <strong>Stabilization</strong>
            <span>{strokeStabilizationLabel}</span>
          </div>
          <input
            class="stroke-popover-slider secondary"
            type="range"
            min="0"
            max="100"
            step="1"
            value={strokeStabilization}
            on:input={(event) => setStrokeStabilization((event.currentTarget as HTMLInputElement).value)}
          />
        </div>
      {/if}

      {#if adjustableStrokeTool(strokePopover.tool)}
        <div class="stroke-popover-preview">
          <span class="stroke-popover-value">{strokePopoverWidthLabel}</span>
          <div class="stroke-popover-preview-rail">
            <div class="stroke-popover-preview-line" style={strokePopoverSampleStyle}></div>
          </div>
        </div>

        <input
          class="stroke-popover-slider"
          max={currentStrokePopoverBounds()?.max ?? 100}
          min={currentStrokePopoverBounds()?.min ?? 0}
          step={currentStrokePopoverBounds()?.step ?? 1}
          type="range"
          value={strokePopoverWidth}
          on:input={(event) => updateStrokePopoverWidth((event.currentTarget as HTMLInputElement).value)}
        />
      {/if}

      <div class="stroke-popover-actions">
        {#if adjustableStrokeTool(strokePopover.tool)}
          <button class="button subtle full stroke-popover-reset" type="button" on:click={restoreStrokePopoverPreset}>Reset preset</button>
        {/if}
        {#if strokePopover.tool === 'eraser'}
          <button
            class="button subtle full stroke-popover-danger"
            type="button"
            disabled={currentPageAnnotationCount === 0}
            on:click={clearCurrentPageAnnotations}
          >
            Clear page annotations
          </button>
        {:else if strokePopover.tool === 'hand'}
          <button class="button subtle full stroke-popover-reset" type="button" on:click={resetZoom}>Reset zoom</button>
          <button class="button subtle full stroke-popover-reset" type="button" on:click={toggleCompactHeader}>{compactHeaderVisibleState ? 'Hide top menu' : 'Show top menu'}</button>
        {:else if strokePopover.tool === 'shape'}
          <button class="button subtle full stroke-popover-reset" type="button" on:click={() => (selectedShapeFill = !selectedShapeFill)}>
            {selectedShapeFill ? 'Use outline' : 'Use fill'}
          </button>
        {:else}
          <button class="button subtle full stroke-popover-reset" type="button" on:click={restoreStrokeStabilization}>Reset stabilization</button>
        {/if}
      </div>
    </div>
  {/if}

  <!-- ═══ Error Banner ═══ -->
  {#if errorMessage}
    <div class="status-banner error reader-status">{errorMessage}</div>
  {/if}

  <!-- ═══ Reader Body (sidebar + center + inspector) ═══ -->
  <div class="reader-body">
    {#if compactMode && (compactPagesOpen || compactInspectorOpen)}
      <button aria-label="Close panel" class="compact-panel-backdrop" type="button" on:click={closeCompactPanels}></button>
    {/if}

    <!-- ═══ Thumbnail Sidebar ═══ -->
    <aside class:compact-panel={compactMode && compactPagesOpen} class="thumbnail-rail">
      <div class="rail-header">
        <strong>Pages</strong>
        <span>{bundle?.document.pageCount ?? 0}</span>
      </div>

      {#if bundle}
        <div class="thumbnail-list">
          {#each bundle.pages as page, pageIndex (page.id)}
            {#if chapterStartMap.has(pageIndex)}
              <div class="thumbnail-chapter-divider">
                <span class="thumbnail-chapter-label">{chapterStartMap.get(pageIndex)}</span>
              </div>
            {/if}
            <button
              class:compact-card={compactMode}
              class:active={pageIndex === activePageIndex}
              class="thumbnail-card"
              type="button"
              on:click={() => {
                compactPagesOpen = false;
                scrollToPage(pageIndex);
              }}
            >
              <div class:compact-frame={compactMode} class="thumbnail-frame" style={compactMode ? `aspect-ratio:${page.width} / ${page.height};` : undefined}>
                <!-- {#key} only on annotationRevision so remount happens on confirmed save,
                     not on every pointer-move. Live drawing updates flow through prop changes. -->
                {#key `${page.id}:${pageStates[page.id]?.annotationRevision ?? 0}`}
                  <div class="thumbnail-preview-stage" style={!compactMode ? `aspect-ratio:${page.width} / ${page.height};` : undefined}>
                    <ThumbnailPreview
                      alt={`Page ${pageIndex + 1}`}
                      annotations={previewAnnotationsByPage[page.id] ?? pageStates[page.id]?.annotations ?? []}
                      page={page}
                      previewSrc={thumbnailBaseSrc(page.id)}
                      serverSrc={thumbnailServerSrc(page.id)}
                      useClient={!!(previewAnnotationsByPage[page.id] || pageStates[page.id]?.dirty || pageStates[page.id]?.loaded)}
                    />
                  </div>
                {/key}
              </div>
              <div class="thumbnail-meta">
                <strong>Page {pageIndex + 1} <span>{thumbnailKindLabel(page)}</span></strong>
              </div>
            </button>
          {/each}
        </div>
      {/if}
    </aside>

    <!-- ═══ Center Pane (toolbar + canvas + page indicator) ═══ -->
    <section bind:this={centerPane} class="reader-center">
      {#if loading}
        <div class="reader-loading">Loading reader…</div>
      {:else if !bundle}
        <div class="reader-loading">Document unavailable.</div>
      {:else}
        <!-- ═══ Drawing Toolbar ═══ -->
        <div class="reader-middle-bar" style={`--tool-accent:${currentToolAccent()};`}>
          <div class="middle-menu-strip" role="toolbar" aria-label="Drawing tools">
            {#each middleMenuItems as item}
              <button
                class:active={selectedTool === item.id || activeToolPanel === item.id}
                class="middle-menu-button"
                type="button"
                title={item.label}
                aria-label={item.label}
                style={`--tool-accent:${item.accent};`}
                on:click={(event) => handleMiddleMenuItem(item.id, event.currentTarget as HTMLElement | null)}
              >
                <span class="middle-menu-glyph">{item.glyph}</span>
              </button>
            {/each}

            <button
              class:active={activeToolPanel === panelForTool(selectedTool)}
              class="middle-menu-utility"
              type="button"
              aria-label="Tool options"
              disabled={!canOpenCurrentToolPanel()}
              on:click={toggleCurrentToolPanel}
            >
              ⋯
            </button>
            <div class="middle-menu-divider"></div>
            <button class="middle-menu-utility" type="button" aria-label="Undo" disabled={!canUndoAvailable} on:click={undoCurrentPage}>↺</button>
            <button class="middle-menu-utility" type="button" aria-label="Redo" disabled={!canRedoAvailable} on:click={redoCurrentPage}>↻</button>
            {#if compactMode}
              <button class:active={compactHeaderVisibleState} class="middle-menu-utility" type="button" aria-label={compactHeaderVisibleState ? 'Hide top menu' : 'Show top menu'} on:click={toggleCompactHeader}>{compactHeaderVisibleState ? '▴' : '▾'}</button>
            {/if}
            <button class="middle-menu-utility" type="button" aria-label="Zoom out" on:click={() => changeZoom(-1)}>-</button>
            <button class="middle-menu-percent" type="button" aria-label="Reset zoom to 100%" on:click={resetZoom}>{zoomLabel}</button>
            <button class="middle-menu-utility" type="button" aria-label="Zoom in" on:click={() => changeZoom(1)}>+</button>
            <div class="middle-menu-save">{globalSaveLabel()}</div>
          </div>

          {#if activeToolPanel}
            <section class="middle-menu-flyout" aria-label={`${activeToolPanel} options`} style={`--tool-accent:${currentToolAccent()};`}>
              {#if activeToolPanel === 'lasso'}
                <div class="tool-panel-header-copy">
                  <strong>Lasso Tool</strong>
                  <span>Select annotations with a rectangle or freehand pass.</span>
                </div>
                <div class="stroke-popover-mode-group panel-mode-group">
                  <button class:active={lassoMode === 'rectangle'} class="stroke-mode-button" type="button" on:click={() => (lassoMode = 'rectangle')}>Rectangle</button>
                  <button class:active={lassoMode === 'freehand'} class="stroke-mode-button" type="button" on:click={() => (lassoMode = 'freehand')}>Freehand</button>
                </div>
                <div class="tool-panel-group">
                  <div class="tool-panel-group-header">
                    <strong>Included in selection</strong>
                    <span>Writing, text, and shapes</span>
                  </div>
                  <div class="panel-action-grid">
                    <button class="button subtle" type="button">Handwriting</button>
                    <button class="button subtle" type="button">Images</button>
                    <button class="button subtle" type="button">Shapes</button>
                    <button class="button subtle" type="button">Text Boxes</button>
                  </div>
                </div>
                <div class="stroke-popover-info-card">
                  <strong>{lassoSelectionCount} item{lassoSelectionCount === 1 ? '' : 's'} selected</strong>
                  <p>Drag on the page with the lasso tool to select annotations.</p>
                </div>
                <div class="panel-action-grid">
                  <button class="button subtle" type="button" disabled={lassoSelectionCount === 0} on:click={clearLassoSelection}>Clear selection</button>
                  <button class="button subtle danger" type="button" disabled={lassoSelectionCount === 0} on:click={deleteLassoSelection}>Delete selected</button>
                </div>
              {:else if activeToolPanel === 'write'}
                <div class="tool-panel-header-copy">
                  <strong>{quickPresetLabel()}</strong>
                  <span>Writing options</span>
                </div>
                <div class="size-group panel-size-group">
                  {#each sizePresets as preset}
                    <button class:active={selectedSize === preset.value} class="size-button" type="button" aria-label={preset.label} on:click={(event) => handleSizePresetSelect(event, preset.value)}>
                      <span class={`size-dot ${preset.className}`} style={strokePresetDotStyle(preset.value)}></span>
                    </button>
                  {/each}
                </div>
                {#if selectedTool === 'eraser'}
                  <div class="stroke-popover-mode-group panel-mode-group">
                    <button class:active={eraserStrokeMode === 'whole'} class="stroke-mode-button" type="button" on:click={() => (eraserStrokeMode = 'whole')}>Erase whole strokes</button>
                    <button class:active={eraserStrokeMode === 'partial'} class="stroke-mode-button" type="button" on:click={() => (eraserStrokeMode = 'partial')}>Erase touched parts</button>
                  </div>
                  <div class="stroke-popover-info-card">
                    <strong>Transparent eraser</strong>
                    <p>The eraser circle shows the exact area being affected while you drag.</p>
                  </div>
                  <button class="button subtle" type="button" on:click={openCurrentStrokeSettings}>More eraser options</button>
                {:else}
                  <div class="palette-group popover-palette-group">
                    {#each colorChips as color}
                      <button class:active={selectedColor === color} class="color-chip popover-chip" type="button" aria-label={`Choose ${color}`} style={`background:${color}`} on:click={() => (selectedColor = color)}></button>
                    {/each}
                  </div>
                  <button class="button subtle" type="button" on:click={openCurrentStrokeSettings}>More writing options</button>
                {/if}
              {:else if activeToolPanel === 'text'}
                <div class="tool-panel-header-copy">
                  <strong>Text</strong>
                  <span>Tap the page to place a note.</span>
                </div>
                <div class="text-size-group">
                  {#each textSizePresets as size}
                    <button class:active={textFontSize === size} class="shape-button popover-shape-button" type="button" on:click={() => (textFontSize = size)}>{size}px</button>
                  {/each}
                </div>
                <div class="palette-group popover-palette-group">
                  {#each colorChips as color}
                    <button class:active={selectedColor === color} class="color-chip popover-chip" type="button" aria-label={`Choose ${color}`} style={`background:${color}`} on:click={() => (selectedColor = color)}></button>
                  {/each}
                </div>
              {:else if activeToolPanel === 'shape'}
                <div class="tool-panel-header-copy">
                  <strong>Shapes</strong>
                  <span>Create, move, resize, and style shapes.</span>
                </div>
                <div class="shape-options popover-shape-options">
                  <button class:active={selectedShapeKind === 'rectangle'} class="shape-button popover-shape-button" type="button" on:click={() => (selectedShapeKind = 'rectangle')}>▭</button>
                  <button class:active={selectedShapeKind === 'ellipse'} class="shape-button popover-shape-button" type="button" on:click={() => (selectedShapeKind = 'ellipse')}>◯</button>
                  <button class:active={selectedShapeKind === 'triangle'} class="shape-button popover-shape-button" type="button" on:click={() => (selectedShapeKind = 'triangle')}>△</button>
                  <button class:active={selectedShapeKind === 'diamond'} class="shape-button popover-shape-button" type="button" on:click={() => (selectedShapeKind = 'diamond')}>◆</button>
                </div>
                <div class="stroke-popover-mode-group panel-mode-group">
                  <button class:active={selectedShapeFill} class="stroke-mode-button" type="button" on:click={() => (selectedShapeFill = !selectedShapeFill)}>{selectedShapeFill ? 'Filled' : 'Outline'}</button>
                  <button class:active={selectedShapeLineStyle === 'solid'} class="stroke-mode-button" type="button" on:click={() => (selectedShapeLineStyle = 'solid')}>Solid</button>
                  <button class:active={selectedShapeLineStyle === 'dashed'} class="stroke-mode-button" type="button" on:click={() => (selectedShapeLineStyle = 'dashed')}>Dashed</button>
                  <button class:active={selectedShapeLineStyle === 'dotted'} class="stroke-mode-button" type="button" on:click={() => (selectedShapeLineStyle = 'dotted')}>Dotted</button>
                </div>
              {:else if activeToolPanel === 'sticky'}
                <div class="tool-panel-header-copy">
                  <strong>Sticky Notes</strong>
                  <span>Color-ready quick callouts.</span>
                </div>
                <div class="palette-group popover-palette-group">
                  <button class:active={stickyNoteColor === '#f6a6a6'} class="color-chip popover-chip" type="button" aria-label="Pink sticky note" style="background:#f6a6a6" on:click={() => (stickyNoteColor = '#f6a6a6')}></button>
                  <button class:active={stickyNoteColor === '#ffd587'} class="color-chip popover-chip" type="button" aria-label="Amber sticky note" style="background:#ffd587" on:click={() => (stickyNoteColor = '#ffd587')}></button>
                  <button class:active={stickyNoteColor === '#f5ef83'} class="color-chip popover-chip" type="button" aria-label="Yellow sticky note" style="background:#f5ef83" on:click={() => (stickyNoteColor = '#f5ef83')}></button>
                  <button class:active={stickyNoteColor === '#a8efb7'} class="color-chip popover-chip" type="button" aria-label="Green sticky note" style="background:#a8efb7" on:click={() => (stickyNoteColor = '#a8efb7')}></button>
                  <button class:active={stickyNoteColor === '#b6d8ff'} class="color-chip popover-chip" type="button" aria-label="Blue sticky note" style="background:#b6d8ff" on:click={() => (stickyNoteColor = '#b6d8ff')}></button>
                </div>
                <div class="stroke-popover-info-card">
                  <strong>Tap the page to drop a sticky note</strong>
                  <p>The selected color is used for the new note.</p>
                </div>
              {:else if activeToolPanel === 'tape'}
                <div class="tool-panel-header-copy">
                  <strong>Tape</strong>
                  <span>Place decorative semi-transparent strips.</span>
                </div>
                <div class="stroke-popover-mode-group panel-mode-group">
                  <button class:active={tapeStraightMode} class="stroke-mode-button" type="button" on:click={() => (tapeStraightMode = true)}>Straight</button>
                  <button class:active={!tapeStraightMode} class="stroke-mode-button" type="button" on:click={() => (tapeStraightMode = false)}>Free</button>
                </div>
                <div class="tool-panel-group">
                  <div class="tool-panel-group-header">
                    <strong>Width</strong>
                  </div>
                  <div class="stroke-popover-mode-group panel-mode-group">
                    <button class:active={tapeWidth === 18} class="stroke-mode-button" type="button" on:click={() => (tapeWidth = 18)}>Thin</button>
                    <button class:active={tapeWidth === 30} class="stroke-mode-button" type="button" on:click={() => (tapeWidth = 30)}>Medium</button>
                    <button class:active={tapeWidth === 48} class="stroke-mode-button" type="button" on:click={() => (tapeWidth = 48)}>Wide</button>
                  </div>
                </div>
                <div class="tool-panel-group">
                  <div class="tool-panel-group-header">
                    <strong>Pattern</strong>
                  </div>
                  <div class="stroke-popover-mode-group panel-mode-group">
                    <button class:active={tapePattern === 'solid'} class="stroke-mode-button" type="button" on:click={() => (tapePattern = 'solid')}>Solid</button>
                    <button class:active={tapePattern === 'stripe'} class="stroke-mode-button" type="button" on:click={() => (tapePattern = 'stripe')}>Stripe</button>
                    <button class:active={tapePattern === 'dots'} class="stroke-mode-button" type="button" on:click={() => (tapePattern = 'dots')}>Dots</button>
                    <button class:active={tapePattern === 'grid'} class="stroke-mode-button" type="button" on:click={() => (tapePattern = 'grid')}>Grid</button>
                  </div>
                </div>
                <div class="tool-panel-group">
                  <div class="tool-panel-group-header">
                    <strong>Color</strong>
                  </div>
                  <div class="palette-group popover-palette-group">
                    <button class:active={tapeColor === '#e8b4b8'} class="color-chip popover-chip" type="button" aria-label="Pink tape" style="background:#e8b4b8" on:click={() => (tapeColor = '#e8b4b8')}></button>
                    <button class:active={tapeColor === '#b8d4e8'} class="color-chip popover-chip" type="button" aria-label="Blue tape" style="background:#b8d4e8" on:click={() => (tapeColor = '#b8d4e8')}></button>
                    <button class:active={tapeColor === '#d4e8b8'} class="color-chip popover-chip" type="button" aria-label="Green tape" style="background:#d4e8b8" on:click={() => (tapeColor = '#d4e8b8')}></button>
                    <button class:active={tapeColor === '#f5e6a3'} class="color-chip popover-chip" type="button" aria-label="Yellow tape" style="background:#f5e6a3" on:click={() => (tapeColor = '#f5e6a3')}></button>
                    <button class:active={tapeColor === '#d8c4e8'} class="color-chip popover-chip" type="button" aria-label="Purple tape" style="background:#d8c4e8" on:click={() => (tapeColor = '#d8c4e8')}></button>
                    <button class:active={tapeColor === '#f0c8a0'} class="color-chip popover-chip" type="button" aria-label="Peach tape" style="background:#f0c8a0" on:click={() => (tapeColor = '#f0c8a0')}></button>
                  </div>
                </div>
                <div class="tool-panel-group">
                  <div class="tool-panel-group-header">
                    <strong>Opacity</strong>
                  </div>
                  <div class="stroke-popover-mode-group panel-mode-group">
                    <button class:active={tapeOpacity === 1.0} class="stroke-mode-button" type="button" on:click={() => (tapeOpacity = 1.0)}>Solid</button>
                    <button class:active={tapeOpacity === 0.55} class="stroke-mode-button" type="button" on:click={() => (tapeOpacity = 0.55)}>Transparent</button>
                  </div>
                </div>
                <div class="tool-panel-group">
                  <div class="tool-panel-group-header">
                    <strong>Study Mode</strong>
                  </div>
                  <div class="panel-action-grid">
                    <button class="button subtle" type="button" on:click={revealAllTape}>Reveal All</button>
                    <button class="button subtle" type="button" on:click={hideAllTape}>Hide All</button>
                  </div>
                </div>
                <div class="stroke-popover-info-card">
                  <strong>Drag to place tape, tap to peek</strong>
                  <p>Tap tape to reveal what's underneath. Hold to peek temporarily. Use Reveal All / Hide All for bulk study.</p>
                </div>
              {:else if activeToolPanel === 'accessories'}
                <div class="tool-panel-header-copy">
                  <strong>Accessories</strong>
                  <span>Reader helpers and document utilities.</span>
                </div>
                <div class="panel-action-grid">
                  <button class="button subtle" type="button" disabled={busy} on:click={bookmarkCurrentPage}>Bookmark</button>
                  <button class="button subtle" type="button" on:click={exportPdf}>Export PDF</button>
                  <button class:active={rulerVisible} class="button subtle" type="button" on:click={toggleRuler}>{rulerVisible ? 'Hide Ruler' : 'Show Ruler'}</button>
                  <button class:active={timeKeeperVisible} class="button subtle" type="button" on:click={toggleTimeKeeper}>{timeKeeperVisible ? 'Hide Timer' : 'Show Timer'}</button>
                </div>
              {:else if activeToolPanel === 'laser'}
                <div class="tool-panel-header-copy">
                  <strong>Laser Pointer</strong>
                  <span>Transient teaching pointer modes.</span>
                </div>
                <div class="stroke-popover-mode-group panel-mode-group">
                  <button class:active={laserPointerMode === 'dot'} class="stroke-mode-button" type="button" on:click={() => (laserPointerMode = 'dot')}>Dot</button>
                  <button class:active={laserPointerMode === 'line'} class="stroke-mode-button" type="button" on:click={() => (laserPointerMode = 'line')}>Line</button>
                </div>
                <div class="stroke-popover-info-card">
                  <strong>Drag across the page to point</strong>
                  <p>The laser pointer is transient and is not saved to the document.</p>
                </div>
              {:else}
                <div class="tool-panel-header-copy">
                  <strong>Hand Tool</strong>
                  <span>Scroll and pan the reader.</span>
                </div>
                <label class="utility-toggle">
                  <input bind:checked={stylusOnly} type="checkbox" />
                  <span>Stylus-only writing</span>
                </label>
              {/if}
            </section>
          {/if}
        </div>

        <!-- ═══ Accessory Overlays (Timer, Ruler) ═══ -->
        {#if timeKeeperVisible}
          <div class="timekeeper-overlay">
            <strong>{formatTimeKeeper()}</strong>
            <div class="stroke-popover-mode-group panel-mode-group">
              <button class:active={timeKeeperRunning} class="stroke-mode-button" type="button" on:click={() => setTimeKeeperRunning(!timeKeeperRunning)}>
                {timeKeeperRunning ? 'Pause' : 'Start'}
              </button>
              <button class="stroke-mode-button" type="button" on:click={resetTimeKeeper}>Reset</button>
            </div>
          </div>
        {/if}

        {#if rulerVisible}
          <div class="ruler-overlay" style={`top:${rulerOffsetY}px; transform:translateX(-50%) rotate(${rulerAngle}deg);`}>
            <button class="ruler-overlay-handle" type="button" aria-label="Move ruler" on:pointerdown={(event) => startRulerGesture(event, 'move')}></button>
            <div class="ruler-overlay-scale"></div>
            <button class="ruler-overlay-rotate" type="button" aria-label="Rotate ruler" on:pointerdown={(event) => startRulerGesture(event, 'rotate')}></button>
          </div>
        {/if}

        <!-- ═══ Canvas / Page Area ═══ -->
        <div
          bind:this={scrollPane}
          class:ink-scroll-locked={inkScrollLocked}
          aria-label="Document reader"
          class:compact-scroll={compactMode}
          class="reader-scroll"
          role="region"
          on:scroll={handleScroll}
          on:touchcancel={handleTouchEnd}
          on:touchend={handleTouchEnd}
          on:touchmove={handleTouchMove}
          on:touchstart={handleTouchStart}
        >
          <div class="reader-stack" style={`height:${layout.containerHeight}px; width:${layout.containerWidth}px;`}>
            {#each visibleLayouts as pageLayout (pageLayout.page.id)}
              <PageShell
                allowRender={!scrolling && !inkScrollLocked}
                annotations={pageStates[pageLayout.page.id]?.annotations ?? []}
                file={fileLookup(pageLayout.page)}
                activePageIndex={activePageIndex}
                isActive={pageLayout.pageIndex === activePageIndex}
                layout={pageLayout}
                connectionQuality={connectionQuality}
                networkConfig={networkConfig}
                penStrokeWidths={strokePresetSettings.pen}
                pencilStrokeWidths={strokePresetSettings.pencil}
                sizePreset={selectedSize}
                stylusOnly={stylusOnly}
                tool={selectedTool}
                color={selectedColor}
                highlighterStrokeWidths={strokePresetSettings.highlighter}
                eraserStrokeWidths={strokePresetSettings.eraser}
                eraserStrokeMode={eraserStrokeMode}
                strokeStabilization={strokeStabilization}
                pencilStrokeStabilization={QUICK_PENCIL_STABILIZATION}
                textFontSize={textFontSize}
                stickyNoteColor={stickyNoteColor}
                lassoMode={lassoMode}
                laserPointerMode={laserPointerMode}
                tapeColor={tapeColor}
                tapePattern={tapePattern}
                tapeWidth={tapeWidth}
                tapeStraightMode={tapeStraightMode}
                tapeOpacity={tapeOpacity}
                revealedTapeIds={revealedTapeIds}
                selectedAnnotationIds={selectedAnnotationIdsByPage[pageLayout.page.id] ?? []}
                shapeKind={selectedShapeKind}
                shapeFill={selectedShapeFill}
                shapeLineStyle={selectedShapeLineStyle}
                onPenSessionChange={setInkScrollLock}
                onAppend={appendAnnotations}
                onReplace={replaceAnnotations}
                onSelectionChange={handleSelectionChange}
                onTapePeek={handleTapePeek}
                onPreviewAnnotationsChange={handlePreviewAnnotationsChange}
                onToolGestureStart={() => { activeToolPanel = null; }}
                viewportTop={scrollPane?.scrollTop ?? 0}
                viewportHeight={scrollPane?.clientHeight ?? 0}
              />
            {/each}
          </div>
        </div>
      {/if}

      {#if bundle}
        <div class="page-indicator">{activePageIndex + 1} of {bundle.document.pageCount}</div>
      {/if}
    </section>

    <!-- ═══ Inspector Panel ═══ -->
    <aside class:compact-panel={compactMode && compactInspectorOpen} class="inspector-rail">
      {#if bundle}
        {#if !compactMode}
          <section class="inspector-card inspector-doc-header">
            <strong class="inspector-doc-title">{bundle.document.title}</strong>
            <div class="inspector-doc-actions">
              <button class="button primary full" type="button" on:click={exportPdf}>Export PDF</button>
              <button class="button full" type="button" on:click={() => dispatch('close')}>Library</button>
            </div>
          </section>
        {/if}
        <section class="inspector-card">
          <h3>Page Actions</h3>
          <label class="field">
            <span>Paper</span>
            <select disabled>
              {#each pageTemplates as template}
                <option selected={template === 'ruled'} value={template}>{template}</option>
              {/each}
            </select>
          </label>
          <button class="button subtle full" type="button" disabled={busy} on:click={() => addBlankPage('before')}>Insert blank page before</button>
          <button class="button subtle full" type="button" disabled={busy} on:click={() => addBlankPage('after')}>Insert blank page after</button>
        </section>

        <section class="inspector-card">
          <h3>Insert From PDF</h3>
          <button class="button subtle full" type="button" disabled={busy} on:click={() => requestPdfInsert('before')}>Insert PDF pages before</button>
          <button class="button subtle full" type="button" disabled={busy} on:click={() => requestPdfInsert('after')}>Insert PDF pages after</button>
        </section>

        <section class="inspector-card">
          <h3>Bookmark</h3>
          <p>{bundle.document.bookmarkPageId ? `Saved on page ${bundle.pages.findIndex((page) => page.id === bundle.document.bookmarkPageId) + 1}.` : 'No bookmark set yet.'}</p>
          <button class="button subtle full" type="button" disabled={busy} on:click={bookmarkCurrentPage}>Bookmark this page</button>
        </section>

        <section class="inspector-card">
          <ChapterManager
            documentId={documentId}
            pageCount={bundle.document.pageCount}
            activePageIndex={activePageIndex}
            on:changed={(e) => chapters = e.detail.chapters}
          />
        </section>

        <section class="inspector-card">
          <h3>Appearance</h3>
          <button class="button subtle full" type="button" on:click={() => { currentTheme = toggleTheme(); }}>
            {currentTheme === 'light' ? '\u263E Dark Mode' : '\u2600 Light Mode'}
          </button>
        </section>

        <section class="inspector-card">
          <h3>Palm Rejection</h3>
          <label class="checkbox-row">
            <input bind:checked={stylusOnly} type="checkbox" />
            <span>Stylus-only writing</span>
          </label>
          <p>Finger touch remains reserved for scrolling and panning.</p>
        </section>

        <section class="inspector-card">
          <h3>Search</h3>
          <div class="search-row">
            <input bind:value={searchText} placeholder="Search PDF text and typed notes" />
            <button class="button subtle" type="button" disabled={searchBusy} on:click={runSearch}>Go</button>
          </div>

          {#if searchState.indexing}
            <p>Search index is still filling in for this PDF.</p>
          {/if}

          <div class="search-results">
            {#if searchState.results.length === 0 && searchText}
              <p>No results yet.</p>
            {:else}
              {#each searchState.results as result}
                <button class="search-hit" type="button" on:click={() => scrollToPage(result.pageIndex)}>
                  <strong>Page {result.pageIndex + 1}</strong>
                  <span>{result.snippet}</span>
                </button>
              {/each}
            {/if}
          </div>
        </section>

        <section class="inspector-card">
          <h3>Document Info</h3>
          <p>{bundle.document.kind === 'pdf' ? 'Imported PDF document' : 'Notebook document'}</p>
          <p>{bundle.document.pageCount} pages</p>
          {#if compactMode}
            <button class="button subtle full" type="button" on:click={exportPdf}>Export PDF</button>
          {/if}
          <button class="button subtle danger full" type="button" disabled={busy} on:click={removeCurrentPage}>Delete current page</button>
          <button class="button subtle danger full" type="button" disabled={busy} on:click={removeDocumentAndClose}>Delete document</button>
        </section>
      {/if}
    </aside>
  </div>
</div>
