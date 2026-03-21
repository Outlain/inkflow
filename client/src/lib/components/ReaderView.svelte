<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
  import type {
    Annotation,
    DocumentBundle,
    EditorTool,
    FileRecord,
    LineStyle,
    NotebookTemplate,
    SaveMode,
    SearchResponse,
    ShapeKind,
    SyncEvent
  } from '@shared/contracts';
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
  import { debugTimeline } from '../debug';
  import { shouldUseDraft } from '../draftConflict';
  import { deleteDraft, readDraft, writeDraft } from '../drafts';
  import { createClientId } from '../id';
  import PageShell from './PageShell.svelte';
  import { ReaderLayoutEngine, type PageShellLayout, type ReaderLayoutResult, type VisibleWindow } from '../reader/layout';
  import {
    DEFAULT_STROKE_PRESET_SETTINGS,
    STROKE_BOUNDS,
    cloneStrokePresetSettings,
    formatStrokeWidth,
    loadEraserStrokeMode,
    loadStrokePresetSettings,
    resetStrokePresetWidth,
    saveEraserStrokeMode,
    saveStrokePresetSettings,
    strokePresetIndicatorSize,
    toolStrokeWidthFromSettings,
    updateStrokePresetWidth,
    type AdjustableStrokeTool,
    type EraserStrokeMode,
    type StrokePresetSettings
  } from '../strokeSettings';

  export let documentId: string;

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
    tool: AdjustableStrokeTool;
    preset: number;
    left: number;
    top: number;
    arrowLeft: number;
  }

  const dispatch = createEventDispatcher<{ close: void }>();
  const layoutEngine = new ReaderLayoutEngine();
  const zoomLevels = [0.6, 0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2];
  const ZOOM_EPSILON = 0.001;
  const MAX_PAGE_HISTORY = 50;
  const toolOrder: EditorTool[] = ['pen', 'highlighter', 'eraser', 'text', 'shape', 'hand'];
  const colorChips = ['#123f63', '#c74b35', '#2f8a78', '#8e5fa4', '#d48a2c', '#121212'];
  const pageTemplates: NotebookTemplate[] = ['blank', 'ruled', 'grid', 'dot'];
  const clientId = createClientId();
  const toolGlyphs: Record<EditorTool, string> = {
    pen: '✐',
    highlighter: '',
    eraser: '⌫',
    text: 'T',
    shape: '▭',
    hand: '✋'
  };

  let bundle: DocumentBundle | null = null;
  let loading = true;
  let busy = false;
  let errorMessage = '';
  let statusMessage = 'Preparing the stable reader shell…';
  let selectedTool: EditorTool = 'hand';
  let selectedColor = colorChips[0];
  let selectedSize = 2;
  let strokePresetSettings: StrokePresetSettings = cloneStrokePresetSettings();
  let strokePresetSettingsLoaded = false;
  let eraserStrokeMode: EraserStrokeMode = 'whole';
  let eraserStrokeModeLoaded = false;
  let selectedShapeKind: ShapeKind = 'rectangle';
  let selectedShapeFill = false;
  let selectedShapeLineStyle: LineStyle = 'solid';
  let stylusOnly = true;
  let zoom = 1;
  let zoomLabel = '100%';
  let compactMode = typeof window !== 'undefined' ? window.innerWidth <= 1080 : false;
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
  let compactPagesOpen = false;
  let compactInspectorOpen = false;
  let pageStates: Record<string, PageRuntimeState> = {};
  let lastEditedPageId: string | null = null;

  const pendingSaves = new Map<string, SaveItem[]>();
  const drainingPages = new Set<string>();

  let scrollFrame = 0;
  let scrollEndTimer = 0;
  let scrolling = false;
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
  let longPressTimer = 0;
  let suppressedClickKey = '';
  let compactHeaderShown = false;
  let compactHeaderVisibleState = false;
  let readerScreen: HTMLDivElement | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let syncSocket: WebSocket | null = null;
  let currentPageRecord: DocumentBundle['pages'][number] | null = null;
  let historyTargetPageRecord: DocumentBundle['pages'][number] | null = null;
  let currentUndoCount = 0;
  let currentRedoCount = 0;
  let historyUndoCount = 0;
  let historyRedoCount = 0;
  let canUndoAvailable = false;
  let canRedoAvailable = false;

  $: zoomLabel = `${Math.round(zoom * 100)}%`;
  $: strokePopoverWidth = strokePopover ? currentStrokePresetValue(strokePopover.tool, strokePopover.preset) : 0;
  $: strokePopoverWidthLabel = formatStrokeWidth(strokePopoverWidth);
  $: strokePopoverSampleStyle = strokePopover
    ? `height:${Math.min(18, Math.max(3, strokePopoverWidth))}px; background:${strokePopover.tool === 'eraser' ? 'rgba(255,255,255,0.94)' : selectedColor}; opacity:${strokePopover.tool === 'highlighter' ? 0.34 : 1}; box-shadow:${strokePopover.tool === 'eraser' ? '0 0 0 1px rgba(42,34,29,0.12) inset' : 'none'};`
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

  function currentZoomLabel(): string {
    return zoomLabel;
  }

  function compactSaveLabel(): string {
    const label = globalSaveLabel();
    if (label === 'Unsaved edits') {
      return 'Unsaved';
    }

    if (label === 'Save issue') {
      return 'Issue';
    }

    return label;
  }

  function toolLabel(tool: EditorTool): string {
    return tool === 'shape' ? 'Shapes' : tool[0].toUpperCase() + tool.slice(1);
  }

  function toolGlyph(tool: EditorTool): string {
    return toolGlyphs[tool];
  }

  function adjustableStrokeTool(tool: EditorTool): AdjustableStrokeTool | null {
    return tool === 'pen' || tool === 'highlighter' || tool === 'eraser' ? tool : null;
  }

  function strokeToolLabel(tool: AdjustableStrokeTool): string {
    if (tool === 'highlighter') {
      return 'Highlighter';
    }

    if (tool === 'eraser') {
      return 'Eraser';
    }

    return 'Pen';
  }

  function strokePopoverTitle(tool: AdjustableStrokeTool): string {
    return tool === 'eraser' ? 'Eraser size' : `${strokeToolLabel(tool)} thickness`;
  }

  function strokeSettingsButtonLabel(tool: EditorTool | AdjustableStrokeTool): string {
    if (tool !== 'pen' && tool !== 'highlighter' && tool !== 'eraser') {
      return 'Open stroke settings';
    }

    return tool === 'eraser' ? 'Open eraser size settings' : `Open ${tool} thickness settings`;
  }

  function sizeButtonKey(tool: AdjustableStrokeTool, preset: number): string {
    return `${tool}:preset:${preset}`;
  }

  function toolButtonKey(tool: AdjustableStrokeTool): string {
    return `${tool}:tool`;
  }

  function currentAdjustableStrokeTool(): AdjustableStrokeTool | null {
    return adjustableStrokeTool(selectedTool);
  }

  function currentStrokePresetValue(tool: AdjustableStrokeTool, preset: number): number {
    return toolStrokeWidthFromSettings(strokePresetSettings, tool, preset);
  }

  function currentPopoverStrokeWidth(): number {
    return strokePopoverWidth;
  }

  function strokePresetDotStyle(preset: number): string {
    const tool = currentAdjustableStrokeTool();
    const size = strokePresetIndicatorSize(strokePresetSettings, tool, preset);
    return `width:${size}px; height:${size}px;`;
  }

  function strokeSampleStyle(): string {
    return strokePopoverSampleStyle;
  }

  function openStrokePopover(tool: AdjustableStrokeTool, preset: number, target: HTMLElement | null): void {
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
    strokePopoverWidth = currentStrokePresetValue(tool, preset);
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

  function handleToolButtonClick(event: MouseEvent, tool: EditorTool): void {
    const adjustableTool = adjustableStrokeTool(tool);
    if (adjustableTool && shouldSuppressClick(toolButtonKey(adjustableTool))) {
      return;
    }

    const target = event.currentTarget as HTMLElement | null;
    if (adjustableTool && selectedTool === tool && !usesExplicitStrokeSettingsTrigger()) {
      if (strokePopover && strokePopover.tool === adjustableTool && strokePopover.preset === selectedSize) {
        closeStrokePopover();
      } else {
        openStrokePopover(adjustableTool, selectedSize, target);
      }
      return;
    }

    selectedTool = tool;
    if (!adjustableTool || (strokePopover && strokePopover.tool !== adjustableTool)) {
      closeStrokePopover();
    }
  }

  function handleToolButtonPointerDown(event: PointerEvent, tool: EditorTool): void {
    const adjustableTool = adjustableStrokeTool(tool);
    if (!adjustableTool) {
      return;
    }

    if (usesExplicitStrokeSettingsTrigger()) {
      return;
    }

    scheduleStrokePopoverLongPress(event, adjustableTool, selectedSize, toolButtonKey(adjustableTool));
  }

  function openStrokePopoverFromContextMenu(event: MouseEvent, tool: AdjustableStrokeTool, preset: number): void {
    event.preventDefault();
    openStrokePopover(tool, preset, event.currentTarget as HTMLElement | null);
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
    const tool = currentAdjustableStrokeTool();
    if (!tool) {
      return;
    }

    const target = event.currentTarget as HTMLElement | null;
    if (strokePopover && strokePopover.tool === tool && strokePopover.preset === selectedSize) {
      closeStrokePopover();
      return;
    }

    openStrokePopover(tool, selectedSize, target);
  }

  function setEraserStrokeMode(mode: EraserStrokeMode): void {
    eraserStrokeMode = mode;
  }

  function updateStrokePopoverWidth(rawValue: string): void {
    if (!strokePopover) {
      return;
    }

    const nextValue = Number.parseFloat(rawValue);
    if (!Number.isFinite(nextValue)) {
      return;
    }

    const nextSettings = updateStrokePresetWidth(strokePresetSettings, strokePopover.tool, strokePopover.preset, nextValue);
    strokePresetSettings = nextSettings;
    strokePopoverWidth = toolStrokeWidthFromSettings(nextSettings, strokePopover.tool, strokePopover.preset);
  }

  function restoreStrokePopoverPreset(): void {
    if (!strokePopover) {
      return;
    }

    const nextSettings = resetStrokePresetWidth(strokePresetSettings, strokePopover.tool, strokePopover.preset);
    strokePresetSettings = nextSettings;
    strokePopoverWidth = toolStrokeWidthFromSettings(nextSettings, strokePopover.tool, strokePopover.preset);
  }

  function nextHistoryStack(stack: Annotation[][], snapshot: Annotation[]): Annotation[][] {
    const next = [...stack, snapshot];
    return next.length > MAX_PAGE_HISTORY ? next.slice(next.length - MAX_PAGE_HISTORY) : next;
  }

  function canUndoCurrentPage(): boolean {
    return canUndoAvailable;
  }

  function canRedoCurrentPage(): boolean {
    return canRedoAvailable;
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

  function compactPalette(): string[] {
    const ordered = [selectedColor, ...colorChips.filter((color) => color !== selectedColor)];
    return ordered.slice(0, 4);
  }

  const sizePresets = [
    { value: 1, label: 'Small size', className: 'small' },
    { value: 2, label: 'Medium size', className: 'medium' },
    { value: 3, label: 'Large size', className: 'large' }
  ] as const;

  function thumbnailPreviewWidth(): number {
    return compactMode ? 120 : 240;
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

    pinchFrame = requestAnimationFrame(async () => {
      pinchFrame = 0;
      const update = pendingZoomUpdate;
      pendingZoomUpdate = null;

      if (!update) {
        return;
      }

      if (Math.abs(update.zoom - zoom) > ZOOM_EPSILON) {
        zoom = update.zoom;
        recalcLayout(update.reason);
      }

      await tick();
      if (update.token !== zoomUpdateToken) {
        return;
      }

      applyZoomAnchor(update.anchor);
    });
  }

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

  async function persistDraft(pageId: string): Promise<void> {
    const state = ensurePageState(pageId);
    debugTimeline.log('draft-start', `Draft write started for ${pageId}`);

    if (!bundle) {
      return;
    }

    try {
      if (state.dirty || state.annotations.length > 0) {
        await writeDraft({
          pageId,
          documentId: bundle.document.id,
          annotations: state.annotations,
          annotationText: state.annotationText,
          annotationRevision: state.annotationRevision,
          updatedAt: state.updatedAt,
          dirty: state.dirty
        });
      } else {
        await deleteDraft(pageId);
      }
    } finally {
      debugTimeline.log('draft-end', `Draft write finished for ${pageId}`);
    }
  }

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
      const [remote, draft] = await Promise.all([fetchPageAnnotations(pageId), readDraft(pageId)]);
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
        await deleteDraft(pageId);
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
          await persistDraft(pageId);
          debugTimeline.log('save-end', `${item.mode} save finished for ${pageId}`);
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
          await persistDraft(pageId);
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

    await persistDraft(pageId);
    void drainSaves(pageId);
  }

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

  function updateVisibleState(reason: string): void {
    if (!bundle || !scrollPane) {
      return;
    }

    const nextVisible = layoutEngine.getVisibleWindow(layout, scrollPane.scrollTop, scrollPane.clientHeight, scrolling ? 0 : 1);
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
    if (!bundle || !centerPane || centerPane.clientWidth === 0) {
      return;
    }

    syncViewportMode();
    layout = layoutEngine.build(bundle.pages, centerPane.clientWidth, zoom);
    debugTimeline.log('layout-recalc', `${reason}: ${bundle.pages.length} pages at ${currentZoomLabel()}`);
    scheduleVisibleState(reason);
  }

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
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Could not open the document.';
    } finally {
      loading = false;
    }
  }

  async function replaceBundle(nextBundle: DocumentBundle, focusPageId?: string): Promise<void> {
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
  }

  function scrollToPage(pageIndex: number, behavior: ScrollBehavior = 'smooth'): void {
    if (!scrollPane || !layout.pages[pageIndex]) {
      return;
    }

    const page = layout.pages[pageIndex];
    scrollPane.scrollTo({
      top: Math.max(page.top - 16, 0),
      behavior
    });
    activePageIndex = pageIndex;
    scheduleVisibleState('scroll-to-page');
  }

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

    if (!scrolling) {
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
  }

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

  onMount(() => {
    syncViewportMode();
    strokePresetSettings = loadStrokePresetSettings();
    strokePresetSettingsLoaded = true;
    eraserStrokeMode = loadEraserStrokeMode();
    eraserStrokeModeLoaded = true;
    void loadDocument();

    resizeObserver = new ResizeObserver(() => {
      recalcLayout('resize');
    });

    if (centerPane) {
      resizeObserver.observe(centerPane);
    }
  });

  onDestroy(() => {
    resizeObserver?.disconnect();
    cancelAnimationFrame(scrollFrame);
    cancelAnimationFrame(pinchFrame);
    window.clearTimeout(scrollEndTimer);
    cancelLongPress();
    syncSocket?.close();
  });

  $: if (documentId && documentId !== pendingLoadDocumentId) {
    void loadDocument();
  }

  $: visibleLayouts =
    visibleWindow.end >= visibleWindow.start ? layout.pages.slice(visibleWindow.start, visibleWindow.end + 1) : [];

  $: annotationLoadLayouts = scrolling || inkScrollLocked
    ? visibleLayouts.filter((pageLayout) => {
        const state = pageStates[pageLayout.page.id];
        return Boolean(state?.loaded || state?.dirty);
      })
    : visibleLayouts;

  $: if (annotationLoadLayouts.length > 0) {
    annotationLoadLayouts.forEach((pageLayout) => {
      void loadPageState(pageLayout.page.id);
    });
  }

  $: if (strokePresetSettingsLoaded) {
    saveStrokePresetSettings(strokePresetSettings);
  }

  $: if (eraserStrokeModeLoaded) {
    saveEraserStrokeMode(eraserStrokeMode);
  }

  $: if (strokePopover && selectedTool !== strokePopover.tool) {
    closeStrokePopover();
  }

  $: compactHeaderVisibleState = !compactMode || compactHeaderShown || compactPagesOpen || compactInspectorOpen;
</script>

<svelte:head>
  <title>{bundle ? `${bundle.document.title} · Inkflow` : 'Inkflow Reader'}</title>
</svelte:head>

<input bind:this={insertPdfInput} class="hidden-input" type="file" accept="application/pdf,.pdf" on:change={handlePdfInsert} />

<div
  bind:this={readerScreen}
  class:compact-header-open={compactMode && compactHeaderVisibleState}
  class:compact-mode={compactMode}
  class="reader-screen"
  data-compact-header={compactMode && compactHeaderVisibleState ? 'shown' : 'hidden'}
>
  <header
    class:compact-header={compactMode}
    class="reader-header"
  >
    <div class:compact-row={compactMode} class="reader-header-row">
      <div class:compact-left={compactMode} class="reader-left-actions">
        <button
          class:compact-top-button={compactMode}
          class={compactMode ? 'icon-button' : 'button'}
          type="button"
          aria-label={compactMode ? 'Back to library' : undefined}
          on:click={() => dispatch('close')}
        >
          {compactMode ? '‹' : 'Library'}
        </button>
        <div class:compact-title={compactMode} class="reader-title-pill">
          <strong>{bundle?.document.title ?? 'Loading document…'}</strong>
        </div>
      </div>

      <div class:compact-actions={compactMode} class="reader-right-actions">
        {#if compactMode}
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
        {:else}
          <button class="icon-button" type="button" aria-label="Undo" disabled={!canUndoAvailable} on:click={undoCurrentPage}>Undo</button>
          <button class="icon-button" type="button" aria-label="Redo" disabled={!canRedoAvailable} on:click={redoCurrentPage}>Redo</button>
          <button class="icon-button" type="button" on:click={() => changeZoom(-1)}>-</button>
          <button class="zoom-pill" type="button" aria-label="Reset zoom to 100%" on:click={resetZoom}>{zoomLabel}</button>
          <button class="icon-button" type="button" on:click={() => changeZoom(1)}>+</button>
          <button class="button primary" type="button" on:click={exportPdf}>Export PDF</button>
          <button class="button" type="button" on:click={() => dispatch('close')}>Close</button>
        {/if}
      </div>
    </div>

    {#if !compactMode}
      <div class="reader-toolbar-row">
        <div class="tool-cluster">
          {#each toolOrder as tool}
            <button
              class:active={selectedTool === tool}
              class="tool-pill"
              type="button"
              on:click={(event) => handleToolButtonClick(event, tool)}
              on:contextmenu|preventDefault={(event) => {
                const adjustableTool = adjustableStrokeTool(tool);
                if (adjustableTool) {
                  openStrokePopoverFromContextMenu(event, adjustableTool, selectedSize);
                }
              }}
              on:pointercancel={cancelLongPress}
              on:pointerdown={(event) => handleToolButtonPointerDown(event, tool)}
              on:pointerleave={cancelLongPress}
              on:pointerup={cancelLongPress}
            >
              {toolLabel(tool)}
            </button>
          {/each}
        </div>

        <div class="tool-cluster compact">
          {#if selectedTool === 'shape'}
            <div class="shape-options">
              <button class:active={selectedShapeKind === 'rectangle'} class="shape-button" type="button" on:click={() => (selectedShapeKind = 'rectangle')}>▭</button>
              <button class:active={selectedShapeKind === 'ellipse'} class="shape-button" type="button" on:click={() => (selectedShapeKind = 'ellipse')}>◯</button>
              <button class:active={selectedShapeKind === 'triangle'} class="shape-button" type="button" on:click={() => (selectedShapeKind = 'triangle')}>△</button>
              <button class:active={selectedShapeKind === 'diamond'} class="shape-button" type="button" on:click={() => (selectedShapeKind = 'diamond')}>◆</button>
              <button class:active={selectedShapeFill} class="shape-button" type="button" on:click={() => (selectedShapeFill = !selectedShapeFill)}>Fill</button>
              <button
                class:active={selectedShapeLineStyle === 'solid'}
                class="shape-button"
                type="button"
                on:click={() => (selectedShapeLineStyle = 'solid')}
              >
                Solid
              </button>
              <button
                class:active={selectedShapeLineStyle === 'dashed'}
                class="shape-button"
                type="button"
                on:click={() => (selectedShapeLineStyle = 'dashed')}
              >
                Dash
              </button>
              <button
                class:active={selectedShapeLineStyle === 'dotted'}
                class="shape-button"
                type="button"
                on:click={() => (selectedShapeLineStyle = 'dotted')}
              >
                Dot
              </button>
            </div>
          {/if}

          <div class="palette-group">
            {#each colorChips as color}
              <button
                class:active={selectedColor === color}
                class="color-chip"
                type="button"
                aria-label={`Choose ${color}`}
                style={`background:${color}`}
                on:click={() => (selectedColor = color)}
              ></button>
            {/each}
          </div>

          <div class="size-group">
            {#each sizePresets as preset}
              <button
                class:active={selectedSize === preset.value}
                class="size-button"
                type="button"
                aria-label={preset.label}
                on:click={(event) => handleSizePresetSelect(event, preset.value)}
                on:contextmenu|preventDefault={(event) => {
                  const tool = currentAdjustableStrokeTool();
                  if (tool) {
                    openStrokePopoverFromContextMenu(event, tool, preset.value);
                  }
                }}
                on:pointercancel={cancelLongPress}
                on:pointerdown={(event) => handleSizePresetPointerDown(event, preset.value)}
                on:pointerleave={cancelLongPress}
                on:pointerup={cancelLongPress}
              >
                <span class={`size-dot ${preset.className}`} style={strokePresetDotStyle(preset.value)}></span>
              </button>
            {/each}
          </div>

          {#if selectedTool === 'pen' || selectedTool === 'highlighter' || selectedTool === 'eraser'}
            <button
              class:active={strokePopover && strokePopover.tool === selectedTool}
              class="size-button stroke-settings-trigger"
              type="button"
              aria-label={strokeSettingsButtonLabel(selectedTool)}
              on:click={openCurrentStrokeSettings}
            >
              <svg aria-hidden="true" class="compact-line-style-svg" viewBox="0 0 24 24">
                <path d="M4 7h10M4 17h16M14 7a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM8 17a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.8" />
              </svg>
            </button>
          {/if}
        </div>

        <div class="save-pill">{globalSaveLabel()}</div>
      </div>
    {/if}
  </header>

  {#if strokePopoverBackdropVisible && strokePopover}
    <button aria-label="Close stroke settings" class="stroke-popover-backdrop" type="button" on:click={closeStrokePopover}></button>
  {/if}

  {#if strokePopover}
    <div
      aria-label={`${strokeToolLabel(strokePopover.tool)} settings`}
      class="stroke-popover"
      role="dialog"
      style={`left:${strokePopover.left}px; top:${strokePopover.top}px;`}
    >
      <div class="stroke-popover-arrow" style={`left:${strokePopover.arrowLeft}px;`}></div>
      <div class="stroke-popover-header">
        <svg aria-hidden="true" class="stroke-popover-icon" viewBox="0 0 24 24">
          <path d="M4 7h10M4 17h16M14 7a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM8 17a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.8" />
        </svg>
        <div class="stroke-popover-header-copy">
          <strong>{strokePopoverTitle(strokePopover.tool)}</strong>
          <span>Preset {strokePopover.preset}</span>
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
      {/if}

      <div class="stroke-popover-preview">
        <span class="stroke-popover-value">{strokePopoverWidthLabel}</span>
        <div class="stroke-popover-preview-rail">
          <div class="stroke-popover-preview-line" style={strokePopoverSampleStyle}></div>
        </div>
      </div>

      <input
        class="stroke-popover-slider"
        max={STROKE_BOUNDS[strokePopover.tool].max}
        min={STROKE_BOUNDS[strokePopover.tool].min}
        step={STROKE_BOUNDS[strokePopover.tool].step}
        type="range"
        value={strokePopoverWidth}
        on:input={(event) => updateStrokePopoverWidth((event.currentTarget as HTMLInputElement).value)}
      />

      <div class="stroke-popover-actions">
        <button class="button subtle full stroke-popover-reset" type="button" on:click={restoreStrokePopoverPreset}>Reset preset</button>
      </div>
    </div>
  {/if}

  {#if errorMessage}
    <div class="status-banner error reader-status">{errorMessage}</div>
  {/if}

  <div class="reader-body">
    {#if compactMode && (compactPagesOpen || compactInspectorOpen)}
      <button aria-label="Close panel" class="compact-panel-backdrop" type="button" on:click={closeCompactPanels}></button>
    {/if}

    <aside class:compact-panel={compactMode && compactPagesOpen} class="thumbnail-rail">
      <div class="rail-header">
        <strong>Pages</strong>
        <span>{bundle?.document.pageCount ?? 0}</span>
      </div>

      {#if bundle}
        <div class="thumbnail-list">
          {#each bundle.pages as page, pageIndex (page.id)}
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
              <div class:compact-frame={compactMode} class="thumbnail-frame" style={`aspect-ratio:${page.width} / ${page.height};`}>
                {#if page.kind === 'pdf'}
                  <img alt={`Page ${pageIndex + 1}`} loading="lazy" src={`/api/pages/${page.id}/preview?width=${thumbnailPreviewWidth()}`} />
                {:else}
                  <div class={`thumbnail-template ${page.template ?? page.kind}`}></div>
                {/if}
              </div>
              <div class="thumbnail-meta">
                <strong>Page {pageIndex + 1}</strong>
                <span>{page.kind === 'pdf' ? 'PDF page' : `${page.template ?? 'blank'} paper`}</span>
              </div>
            </button>
          {/each}
        </div>
      {/if}
    </aside>

    <section bind:this={centerPane} class="reader-center">
      {#if compactMode && bundle}
        <div class="reader-toolbar-floating">
          <div class="reader-toolbar-row compact-toolbar compact-toolbar-strip">
            <button class="tool-pill icon-only compact-tool-button compact-tool-button-undo" type="button" aria-label="Undo" disabled={!canUndoAvailable} on:click={undoCurrentPage}>
              <span class="compact-tool-icon compact-tool-icon-undo">↺</span>
            </button>
            <button class="tool-pill icon-only compact-tool-button compact-tool-button-redo" type="button" aria-label="Redo" disabled={!canRedoAvailable} on:click={redoCurrentPage}>
              <span class="compact-tool-icon compact-tool-icon-redo">↻</span>
            </button>

            {#each toolOrder as tool}
              <button
                class:active={selectedTool === tool}
                class={`tool-pill icon-only compact-tool-button compact-tool-button-${tool}`}
                type="button"
                aria-label={toolLabel(tool)}
                on:click={(event) => handleToolButtonClick(event, tool)}
                on:contextmenu|preventDefault={(event) => {
                  const adjustableTool = adjustableStrokeTool(tool);
                  if (adjustableTool) {
                    openStrokePopoverFromContextMenu(event, adjustableTool, selectedSize);
                  }
                }}
                on:pointercancel={cancelLongPress}
                on:pointerdown={(event) => handleToolButtonPointerDown(event, tool)}
                on:pointerleave={cancelLongPress}
                on:pointerup={cancelLongPress}
              >
                {#if tool === 'highlighter'}
                  <span class={`compact-tool-icon compact-tool-icon-${tool}`}>
                    <svg aria-hidden="true" class="compact-tool-svg compact-tool-svg-highlighter" viewBox="0 0 24 24">
                      <path
                        d="M7 15.5 15.9 6.6a2 2 0 0 1 2.8 0l1.7 1.7a2 2 0 0 1 0 2.8l-8.9 8.9H7z"
                        fill="none"
                        stroke="currentColor"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="1.7"
                      />
                      <path
                        d="m14.7 7.8 3.5 3.5"
                        fill="none"
                        stroke="currentColor"
                        stroke-linecap="round"
                        stroke-width="1.7"
                      />
                      <path
                        d="M5 19.5h8.5"
                        fill="none"
                        stroke="currentColor"
                        stroke-linecap="round"
                        stroke-width="1.7"
                      />
                    </svg>
                  </span>
                {:else}
                  <span class={`compact-tool-icon compact-tool-icon-${tool}`}>{toolGlyph(tool)}</span>
                {/if}
              </button>
            {/each}

            {#if selectedTool === 'shape'}
              <div class="shape-options compact-shape-options">
                <button class:active={selectedShapeKind === 'rectangle'} class="shape-button compact-shape-button" type="button" aria-label="Rectangle" on:click={() => (selectedShapeKind = 'rectangle')}>▭</button>
                <button class:active={selectedShapeKind === 'ellipse'} class="shape-button compact-shape-button" type="button" aria-label="Ellipse" on:click={() => (selectedShapeKind = 'ellipse')}>◯</button>
                <button class:active={selectedShapeKind === 'triangle'} class="shape-button compact-shape-button" type="button" aria-label="Triangle" on:click={() => (selectedShapeKind = 'triangle')}>△</button>
                <button class:active={selectedShapeKind === 'diamond'} class="shape-button compact-shape-button" type="button" aria-label="Diamond" on:click={() => (selectedShapeKind = 'diamond')}>◆</button>
                <button class:active={selectedShapeFill} class="shape-button compact-shape-fill" type="button" aria-label="Toggle fill" on:click={() => (selectedShapeFill = !selectedShapeFill)}>
                  <svg aria-hidden="true" class="compact-line-style-svg" viewBox="0 0 24 24">
                    <rect x="5.5" y="5.5" width="13" height="13" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8" />
                    <path d="M7 17.5h10V11H7z" fill="currentColor" />
                  </svg>
                </button>
                <button class:active={selectedShapeLineStyle === 'solid'} class="shape-button compact-line-style-button" type="button" aria-label="Solid border" on:click={() => (selectedShapeLineStyle = 'solid')}>
                  <svg aria-hidden="true" class="compact-line-style-svg" viewBox="0 0 24 24">
                    <path d="M4.5 12h15" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2.3" />
                  </svg>
                </button>
                <button class:active={selectedShapeLineStyle === 'dashed'} class="shape-button compact-line-style-button" type="button" aria-label="Dashed border" on:click={() => (selectedShapeLineStyle = 'dashed')}>
                  <svg aria-hidden="true" class="compact-line-style-svg" viewBox="0 0 24 24">
                    <path d="M4.5 12h5.5M14 12h5.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2.3" />
                  </svg>
                </button>
                <button class:active={selectedShapeLineStyle === 'dotted'} class="shape-button compact-line-style-button" type="button" aria-label="Dotted border" on:click={() => (selectedShapeLineStyle = 'dotted')}>
                  <svg aria-hidden="true" class="compact-line-style-svg" viewBox="0 0 24 24">
                    <circle cx="6" cy="12" r="1.6" fill="currentColor" />
                    <circle cx="12" cy="12" r="1.6" fill="currentColor" />
                    <circle cx="18" cy="12" r="1.6" fill="currentColor" />
                  </svg>
                </button>
              </div>
            {/if}

            <div class="palette-group compact-palette-group">
              {#each compactPalette() as color}
                <button
                  class:active={selectedColor === color}
                  class="color-chip compact-chip"
                  type="button"
                  aria-label={`Choose ${color}`}
                  style={`background:${color}`}
                  on:click={() => (selectedColor = color)}
                ></button>
              {/each}
            </div>

            {#if selectedTool === 'pen' || selectedTool === 'highlighter' || selectedTool === 'eraser' || selectedTool === 'shape'}
              <div class="size-group compact-size-group">
                {#each sizePresets as preset}
                  <button
                    class:active={selectedSize === preset.value}
                    class="size-button"
                    type="button"
                    aria-label={preset.label}
                    on:click={(event) => handleSizePresetSelect(event, preset.value)}
                    on:contextmenu|preventDefault={(event) => {
                      const tool = currentAdjustableStrokeTool();
                      if (tool) {
                        openStrokePopoverFromContextMenu(event, tool, preset.value);
                      }
                    }}
                    on:pointercancel={cancelLongPress}
                    on:pointerdown={(event) => handleSizePresetPointerDown(event, preset.value)}
                    on:pointerleave={cancelLongPress}
                    on:pointerup={cancelLongPress}
                  >
                    <span class={`size-dot ${preset.className}`} style={strokePresetDotStyle(preset.value)}></span>
                  </button>
                {/each}
              </div>
            {/if}

            {#if selectedTool === 'pen' || selectedTool === 'highlighter' || selectedTool === 'eraser'}
              <button
                class:active={strokePopover && strokePopover.tool === selectedTool}
                class="tool-pill icon-only compact-tool-button stroke-settings-trigger"
                type="button"
                aria-label={strokeSettingsButtonLabel(selectedTool)}
                on:click={openCurrentStrokeSettings}
              >
                <svg aria-hidden="true" class="compact-line-style-svg" viewBox="0 0 24 24">
                  <path d="M4 7h10M4 17h16M14 7a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM8 17a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.8" />
                </svg>
              </button>
            {/if}

            <button
              class:active={compactHeaderVisibleState}
              class="tool-pill icon-only compact-tool-button compact-tool-button-menu-toggle"
              type="button"
              aria-label={compactHeaderVisibleState ? 'Hide top menu' : 'Show top menu'}
              on:click={toggleCompactHeader}
            >
              <span class="compact-tool-icon compact-tool-icon-menu-toggle">{compactHeaderVisibleState ? '▴' : '▾'}</span>
            </button>
            <button class="tool-pill icon-only" type="button" aria-label="Zoom out" on:click={() => changeZoom(-1)}>-</button>
            <button class="zoom-pill compact-zoom-pill" type="button" aria-label="Reset zoom to 100%" on:click={resetZoom}>{zoomLabel}</button>
            <button class="tool-pill icon-only" type="button" aria-label="Zoom in" on:click={() => changeZoom(1)}>+</button>
            <div class="save-pill compact-save-pill">{compactSaveLabel()}</div>
          </div>
        </div>
      {/if}

      {#if loading}
        <div class="reader-loading">Loading reader…</div>
      {:else if !bundle}
        <div class="reader-loading">Document unavailable.</div>
      {:else}
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
                isActive={pageLayout.pageIndex === activePageIndex}
                layout={pageLayout}
                penStrokeWidths={strokePresetSettings.pen}
                sizePreset={selectedSize}
                stylusOnly={stylusOnly}
                tool={selectedTool}
                color={selectedColor}
                highlighterStrokeWidths={strokePresetSettings.highlighter}
                eraserStrokeWidths={strokePresetSettings.eraser}
                eraserStrokeMode={eraserStrokeMode}
                shapeKind={selectedShapeKind}
                shapeFill={selectedShapeFill}
                shapeLineStyle={selectedShapeLineStyle}
                onPenSessionChange={setInkScrollLock}
                onAppend={appendAnnotations}
                onReplace={replaceAnnotations}
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

    <aside class:compact-panel={compactMode && compactInspectorOpen} class="inspector-rail">
      {#if bundle}
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
          <button class="button subtle full" type="button" on:click={exportPdf}>Export PDF</button>
          <button class="button subtle danger full" type="button" disabled={busy} on:click={removeCurrentPage}>Delete current page</button>
          <button class="button subtle danger full" type="button" disabled={busy} on:click={removeDocumentAndClose}>Delete document</button>
        </section>
      {/if}
    </aside>
  </div>
</div>
