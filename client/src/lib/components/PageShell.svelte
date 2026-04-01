<script lang="ts">
  // Single page shell — manages the skeleton -> preview -> canvas render pipeline,
  // SVG annotation overlay, and all pointer/stylus input for drawing, erasing,
  // shapes, lasso selection, text, sticky notes, and laser pointer tools.
  import { onDestroy, onMount } from 'svelte';
  import type {
    Annotation,
    EditorTool,
    FileRecord,
    LineStyle,
    PagePoint,
    PageRecord,
    PageAnnotation,
    ShapeAnnotation,
    ShapeKind,
    StickyNoteAnnotation,
    StrokeAnnotation,
    TapeAnnotation,
    TapePattern,
    TextAnnotation
  } from '@shared/contracts';
  import { debugTimeline } from '../debug';
  import { createClientId } from '../id';
  import { cancelCanvasRender, getPdfSegmentCssBounds, renderPdfPage, measurePreviewLoad, type PdfRenderSegment } from '../pdf';
  import { scheduleRender } from '../renderScheduler';
  import type { ConnectionQuality, NetworkConfig } from '../networkMonitor';
  import type { PageShellLayout } from '../reader/layout';
  import {
    createStroke,
    eraseAnnotations,
    shapePath,
    stabilizePencilStrokePoints,
    stabilizeStrokePoints,
    strokePath
  } from '../annotations';
  import {
    DEFAULT_STROKE_PRESET_SETTINGS,
    resolvePresetValue,
    type EraserStrokeMode,
    type StrokePresetValues
  } from '../strokeSettings';

  // ── Props ──

  export let layout: PageShellLayout;
  export let file: FileRecord | null = null;
  export let annotations: PageAnnotation[] = [];
  export let tool: EditorTool = 'hand';
  export let color = '#123f63';
  export let sizePreset = 2;
  export let stylusOnly = true;
  export let isActive = false;
  export let shapeKind: ShapeKind = 'rectangle';
  export let shapeFill = false;
  export let shapeLineStyle: LineStyle = 'solid';
  export let allowRender = true;
  export let activePageIndex = 0;
  export let viewportTop = 0;
  export let viewportHeight = 0;
  export let connectionQuality: ConnectionQuality = 'fast';
  export let networkConfig: NetworkConfig = {
    rangeChunkSize: 1024 * 1024,
    maxPreviewWidth: 960,
    maxThumbnailWidth: 240,
    prefetchRadius: 4,
    previewRadius: Infinity
  };
  export let penStrokeWidths: StrokePresetValues = [...DEFAULT_STROKE_PRESET_SETTINGS.pen] as StrokePresetValues;
  export let pencilStrokeWidths: StrokePresetValues = [...DEFAULT_STROKE_PRESET_SETTINGS.pencil] as StrokePresetValues;
  export let highlighterStrokeWidths: StrokePresetValues = [...DEFAULT_STROKE_PRESET_SETTINGS.highlighter] as StrokePresetValues;
  export let eraserStrokeWidths: StrokePresetValues = [...DEFAULT_STROKE_PRESET_SETTINGS.eraser] as StrokePresetValues;
  export let eraserStrokeMode: EraserStrokeMode = 'whole';
  export let strokeStabilization = 30;
  export let pencilStrokeStabilization = 18;
  export let textFontSize = 24;
  export let stickyNoteColor = '#f5ef83';
  export let lassoMode: 'rectangle' | 'freehand' = 'rectangle';
  export let laserPointerMode: 'dot' | 'line' = 'dot';
  export let tapeColor = '#e8b4b8';
  export let tapePattern: TapePattern = 'solid';
  export let tapeWidth = 30;
  export let tapeStraightMode = true;
  export let tapeOpacity = 1.0;
  export let selectedAnnotationIds: string[] = [];
  /** Set of tape annotation IDs currently revealed (transparent) for study peek */
  export let revealedTapeIds: Set<string> = new Set();
  export let onPenSessionChange: (active: boolean) => void = () => undefined;
  export let onAppend: (pageId: string, annotations: Annotation[]) => void = () => undefined;
  export let onReplace: (pageId: string, annotations: Annotation[]) => void = () => undefined;
  export let onSelectionChange: (pageId: string, annotationIds: string[]) => void = () => undefined;
  export let onPreviewAnnotationsChange: (pageId: string, annotations: PageAnnotation[] | null) => void = () => undefined;
  export let onToolGestureStart: () => void = () => undefined;
  /** Called when the user taps or holds a tape strip to peek at content underneath */
  export let onTapePeek: (tapeId: string, action: 'toggle' | 'peek-start' | 'peek-end') => void = () => undefined;

  // ── Internal state ──

  let fullCanvas: HTMLCanvasElement | null = null;
  let topSegmentCanvas: HTMLCanvasElement | null = null;
  let middleSegmentCanvas: HTMLCanvasElement | null = null;
  let bottomSegmentCanvas: HTMLCanvasElement | null = null;
  let interactionLayer: HTMLDivElement | null = null;
  let renderToken = 0;
  let renderedScaleKey = '';
  let renderedSegments = new Set<string>();
  let isReady = layout.page.kind !== 'pdf';
  let fullQualityReady = layout.page.kind !== 'pdf';
  let previewLoaded = layout.page.kind !== 'pdf';
  let previewLoadedPageId = layout.page.kind === 'pdf' ? '' : layout.page.id;
  let previewLoadStart = 0;
  let activePointerId: number | null = null;
  let activePoints: PagePoint[] = [];
  let previewAnnotations: PageAnnotation[] | null = null;
  let selectedShapeId = '';
  let selectedShape: ShapeAnnotation | null = null;
  let renderSuspended = false;
  let pendingScaleChange = false;
  let inkSessionActive = false;
  let previewWidth = 0;
  let previewDeferred = false;
  let previewDeferTimer: ReturnType<typeof setTimeout> | null = null;
  let renderIntentKey = '';
  let layoutGeometryKey = '';
  let previousLayoutGeometryKey = '';
  let renderStrategyKey = '';
  let previousRenderStrategyKey = '';
  let eraserIndicatorPoint: PagePoint | null = null;
  let eraserIndicatorVisible = false;
  let eraserIndicatorStyle = '';
  let laserPointerVisible = false;
  let laserPointerStyle = '';
  let laserPointerPath = '';
  let localSelectedAnnotationIds: string[] = [];
  // Stores the last lasso selection area so clicks inside it can start a move gesture
  let lassoSelectionRegion: { mode: 'rectangle'; left: number; top: number; right: number; bottom: number } | { mode: 'freehand'; polygon: PagePoint[] } | null = null;
  // Tape peek/reveal state — tracks hold-to-peek gesture
  let tapePeekPointerId: number | null = null;
  let tapePeekTapeId: string | null = null;
  let tapePeekStartTime = 0;
  const TAPE_PEEK_HOLD_THRESHOLD = 200; // ms — longer than this = hold-to-peek, shorter = toggle
  let moveGesture:
    | null
    | {
        annotationIds: string[];
        origin: PagePoint;
        startAnnotations: PageAnnotation[];
      } = null;
  let shapeGesture:
    | null
    | {
        mode: 'create' | 'move' | 'resize';
        shapeId: string;
        handle: 'nw' | 'ne' | 'sw' | 'se' | null;
        origin: PagePoint;
        startShape: ShapeAnnotation;
      } = null;

  // ── Layout and sizing helpers ──

  function templateClass(page: PageRecord): string {
    if (page.kind === 'pdf') return 'blank';
    return page.template ?? page.kind;
  }

  function scaledWidth(width: number): number {
    return width * layout.scale;
  }

  // ── Stroke and tool settings ──

  function currentStrokeWidth(): number {
    if (tool === 'highlighter') {
      return resolvePresetValue(highlighterStrokeWidths, sizePreset);
    }

    if (tool === 'pencil') {
      return resolvePresetValue(pencilStrokeWidths, sizePreset);
    }

    return resolvePresetValue(penStrokeWidths, sizePreset);
  }

  function currentEraserRadius(): number {
    return resolvePresetValue(eraserStrokeWidths, sizePreset);
  }

  function currentStrokePoints(): PagePoint[] {
    if (tool !== 'pen' && tool !== 'pencil' && tool !== 'highlighter') {
      return activePoints;
    }

    if (tool === 'pencil') {
      return stabilizePencilStrokePoints(activePoints, pencilStrokeStabilization);
    }

    return stabilizeStrokePoints(activePoints, strokeStabilization);
  }

  function averagePressure(points: PagePoint[]): number {
    if (points.length === 0) {
      return 0.5;
    }

    const total = points.reduce((sum, point) => sum + point.pressure, 0);
    return Math.max(0.15, Math.min(1, total / points.length));
  }

  function pencilStrokeLayers(annotation: StrokeAnnotation): Array<{ multiplier: number; opacity: number }> {
    const pressure = averagePressure(annotation.points);
    const baseOpacity = 0.18 + pressure * 0.22;
    return [
      { multiplier: 1.22, opacity: baseOpacity * 0.28 },
      { multiplier: 1.05, opacity: baseOpacity * 0.6 },
      { multiplier: 0.88, opacity: baseOpacity }
    ];
  }

  function lineStyle(annotation: ShapeAnnotation): string {
    if (annotation.lineStyle === 'dashed') {
      return '10 8';
    }

    if (annotation.lineStyle === 'dotted') {
      return '3 7';
    }

    return '';
  }

  // ── Pointer coordinate mapping ──

  function pageCoordinates(event: PointerEvent): PagePoint[] {
    if (!interactionLayer) {
      return [];
    }

    const rect = interactionLayer.getBoundingClientRect();
    const sourceEvents = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [event];
    return sourceEvents.map((entry) => ({
      x: (entry.clientX - rect.left) / layout.scale,
      y: (entry.clientY - rect.top) / layout.scale,
      pressure: entry.pressure || (entry.pointerType === 'pen' ? 0.5 : 0.35),
      time: event.timeStamp
    }));
  }

  // ── Stroke input pipeline (begin -> continue -> finish) ──

  function appendPoints(points: PagePoint[]): void {
    if (points.length === 0) {
      return;
    }

    const next = [...activePoints];
    for (const point of points) {
      const previous = next[next.length - 1];
      if (previous && previous.x === point.x && previous.y === point.y && previous.time === point.time) {
        continue;
      }
      next.push(point);
    }
    activePoints = next;
  }

  function pointerCanDraw(event: PointerEvent): boolean {
    if (tool === 'hand') {
      return false;
    }

    if (stylusOnly) {
      return event.pointerType === 'pen' || event.pointerType === 'mouse';
    }

    return event.pointerType === 'pen' || event.pointerType === 'touch' || event.pointerType === 'mouse';
  }

  function beginStroke(event: PointerEvent): void {
    activePointerId = event.pointerId;
    activePoints = [];
    appendPoints(pageCoordinates(event));
  }

  function continueStroke(event: PointerEvent): void {
    appendPoints(pageCoordinates(event));
  }

  function finishStroke(): void {
    if (moveGesture) {
      if (previewAnnotations) {
        onReplace(layout.page.id, previewAnnotations);
      }

      activePointerId = null;
      activePoints = [];
      previewAnnotations = null;
      moveGesture = null;
      clearEraserIndicator();
      setInkSession(false);
      return;
    }

    if (activePoints.length === 0) {
      activePointerId = null;
      previewAnnotations = null;
      clearEraserIndicator();
      setInkSession(false);
      return;
    }

    if (tool === 'pen' || tool === 'pencil' || tool === 'highlighter') {
      const strokePoints = currentStrokePoints();
      const stroke = createStroke({
        id: createClientId(),
        tool,
        color,
        width: currentStrokeWidth(),
        points: strokePoints
      });
      onAppend(layout.page.id, [stroke]);
    }

    if (tool === 'eraser') {
      const nextAnnotations = eraseAnnotations(annotations, activePoints, currentEraserRadius(), { strokeMode: eraserStrokeMode });
      onReplace(layout.page.id, nextAnnotations as Annotation[]);
    }

    if (tool === 'shape' && shapeGesture) {
      if (previewAnnotations) {
        onReplace(layout.page.id, previewAnnotations);
      }
      selectedShapeId = shapeGesture.shapeId;
    }

    if (tool === 'tape' && activePoints.length >= 2) {
      const start = activePoints[0];
      const end = activePoints[activePoints.length - 1];
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const length = Math.sqrt(dx * dx + dy * dy);
      // Only commit tape if drag was long enough to be intentional
      if (length > 8) {
        const tape = createTapeFromPoints(start, end);
        onAppend(layout.page.id, [tape as Annotation]);
      }
    }

    if (tool === 'lasso') {
      const nextSelection = selectAnnotationsFromPath(activePoints);
      localSelectedAnnotationIds = nextSelection;
      onSelectionChange(layout.page.id, nextSelection);

      // Store the selection region so the user can click anywhere inside it to move
      if (nextSelection.length > 0 && activePoints.length > 1) {
        if (lassoMode === 'freehand' && activePoints.length > 2) {
          lassoSelectionRegion = { mode: 'freehand', polygon: closePolygon(activePoints) };
        } else {
          const first = activePoints[0];
          const last = activePoints[activePoints.length - 1];
          lassoSelectionRegion = {
            mode: 'rectangle',
            left: Math.min(first.x, last.x),
            top: Math.min(first.y, last.y),
            right: Math.max(first.x, last.x),
            bottom: Math.max(first.y, last.y)
          };
        }
      } else {
        lassoSelectionRegion = null;
      }
    }

    if (tool === 'laser') {
      clearLaserPointer();
    }

    activePointerId = null;
    activePoints = [];
    previewAnnotations = null;
    shapeGesture = null;
    clearEraserIndicator();
    setInkSession(false);
  }

  function clearPointerState(): void {
    activePointerId = null;
    activePoints = [];
    previewAnnotations = null;
    moveGesture = null;
    shapeGesture = null;
    lassoSelectionRegion = null;
    clearEraserIndicator();
    clearLaserPointer();
    setInkSession(false);
  }

  function releaseCapturedPointer(pointerId: number): void {
    if (!interactionLayer?.hasPointerCapture(pointerId)) {
      return;
    }

    interactionLayer.releasePointerCapture(pointerId);
  }

  function setInkSession(active: boolean, pointerType?: string): void {
    const nextActive = active && pointerType === 'pen' && tool !== 'hand';
    if (inkSessionActive === nextActive) {
      return;
    }

    inkSessionActive = nextActive;
    onPenSessionChange(nextActive);
  }

  function updateEraserIndicator(event: PointerEvent): void {
    if (tool !== 'eraser') {
      return;
    }

    const nextPoint = pageCoordinates(event).at(-1);
    if (!nextPoint) {
      return;
    }

    eraserIndicatorPoint = nextPoint;
    eraserIndicatorVisible = true;
  }

  function clearEraserIndicator(): void {
    eraserIndicatorPoint = null;
    eraserIndicatorVisible = false;
  }

  function clearLaserPointer(): void {
    laserPointerVisible = false;
    laserPointerStyle = '';
    laserPointerPath = '';
  }

  function handlePointerLeave(): void {
    if (activePointerId === null) {
      clearEraserIndicator();
    }
  }

  // ── PDF segment rendering — pages render in thirds (top/middle/bottom) ──

  function visibleRenderSegments(): PdfRenderSegment[] {
    const pageTop = layout.top;
    const pageBottom = layout.top + layout.height;
    const visibleTop = Math.max(viewportTop, pageTop) - pageTop;
    const visibleBottom = Math.min(viewportTop + viewportHeight, pageBottom) - pageTop;

    if (visibleBottom <= 0 || visibleTop >= layout.height) {
      return ['top'];
    }

    const third = layout.height / 3;
    const segments: PdfRenderSegment[] = [];
    if (visibleTop < third) segments.push('top');
    if (visibleTop < third * 2 && visibleBottom > third) segments.push('middle');
    if (visibleBottom > third * 2) segments.push('bottom');
    return segments.length > 0 ? segments : ['top'];
  }

  function fullRenderSegments(): PdfRenderSegment[] {
    if (!useSegmentedPdfRender()) {
      return ['full'];
    }

    return ['top', 'middle', 'bottom'];
  }

  function targetRenderSegments(): PdfRenderSegment[] {
    if (!useSegmentedPdfRender()) {
      return ['full'];
    }

    // Only render the segments actually in the viewport, even for the active page.
    // The active page gets ALL segments eventually via eager follow-up below, but
    // the initial render only covers what's visible so isReady fires faster.
    return visibleRenderSegments();
  }

  function useSegmentedPdfRender(): boolean {
    return connectionQuality !== 'slow';
  }

  function segmentKey(scaleKey: string, segment: PdfRenderSegment): string {
    return `${scaleKey}:${segment}`;
  }

  function hasSegment(scaleKey: string, segment: PdfRenderSegment): boolean {
    return renderedSegments.has(segmentKey(scaleKey, segment));
  }

  function canvasForSegment(segment: PdfRenderSegment): HTMLCanvasElement | null {
    if (segment === 'full') {
      return fullCanvas;
    }

    if (segment === 'top') {
      return topSegmentCanvas;
    }

    if (segment === 'middle') {
      return middleSegmentCanvas;
    }

    return bottomSegmentCanvas;
  }

  function cancelSegmentRenders(): void {
    if (fullCanvas) {
      cancelCanvasRender(fullCanvas);
    }

    if (topSegmentCanvas) {
      cancelCanvasRender(topSegmentCanvas);
    }

    if (middleSegmentCanvas) {
      cancelCanvasRender(middleSegmentCanvas);
    }

    if (bottomSegmentCanvas) {
      cancelCanvasRender(bottomSegmentCanvas);
    }
  }

  function segmentCanvasStyle(segment: Exclude<PdfRenderSegment, 'full'>): string {
    const devicePixelRatio = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const coarsePointer = typeof window !== 'undefined' ? (window.matchMedia?.('(pointer: coarse)')?.matches ?? false) : false;
    const viewportWidth = typeof window !== 'undefined' ? window.innerWidth || 1440 : 1440;
    const bounds = getPdfSegmentCssBounds({
      pageHeight: layout.page.height,
      pageScale: layout.scale,
      devicePixelRatio,
      coarsePointer,
      viewportWidth,
      segment
    });

    return `top:${bounds.top}px; height:${bounds.height}px;`;
  }

  function fullCanvasStyle(): string {
    return 'top:0; height:100%;';
  }

  function segmentReady(segment: PdfRenderSegment): boolean {
    if (layout.page.kind !== 'pdf' || !renderedScaleKey) {
      return false;
    }

    return hasSegment(renderedScaleKey, segment);
  }

  function recomputeRenderReadiness(scaleKey: string): void {
    const targetSegments = targetRenderSegments();
    isReady = targetSegments.every((segment) => hasSegment(scaleKey, segment));
    fullQualityReady = fullRenderSegments().every((segment) => hasSegment(scaleKey, segment));
    if (isReady) {
      pendingScaleChange = false;
    }
  }

  function previewDidLoad(event: Event): void {
    previewLoaded = true;
    previewLoadedPageId = layout.page.id;
    // Measure throughput from preview image load for network quality detection
    if (previewLoadStart > 0) {
      const img = event.target as HTMLImageElement;
      // Estimate transfer size from image dimensions (~0.5 bytes per pixel for JPEG)
      const estimatedBytes = img.naturalWidth * img.naturalHeight * 0.5;
      measurePreviewLoad(previewLoadStart, estimatedBytes);
      previewLoadStart = 0;
    }
  }

  function hasStylusTouch(event: TouchEvent): boolean {
    return Array.from(event.changedTouches).some((touch) => ((touch as Touch & { touchType?: string }).touchType ?? '') === 'stylus');
  }

  function handleStylusTouch(event: TouchEvent): void {
    if (!hasStylusTouch(event)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (event.type === 'touchstart') {
      setInkSession(true, 'pen');
      return;
    }

    if (event.type === 'touchend' || event.type === 'touchcancel') {
      setInkSession(false);
    }
  }

  async function renderPdfIfNeeded(): Promise<void> {
    if (!file || layout.page.kind !== 'pdf') {
      return;
    }

    if (useSegmentedPdfRender()) {
      if (!topSegmentCanvas || !middleSegmentCanvas || !bottomSegmentCanvas) {
        return;
      }
    } else if (!fullCanvas) {
      return;
    }

    const nextScaleKey = `${Number(layout.scale.toFixed(4)).toFixed(4)}:${connectionQuality}`;
    if (renderedScaleKey !== nextScaleKey) {
      renderedScaleKey = nextScaleKey;
      renderedSegments = new Set<string>();
      // Keep isReady true until the first new segment actually starts rendering.
      // This keeps the old canvas visible (at old resolution) instead of flashing
      // to the JPEG preview. The canvas will be cleared by ensureCanvasSize when
      // the first segment render begins.
      pendingScaleChange = true;
      fullQualityReady = false;
    }

    if (!allowRender) {
      return;
    }

    const visibleSegments = targetRenderSegments();
    const missingVisibleSegments = visibleSegments.filter((segment) => !hasSegment(nextScaleKey, segment));
    const missingFullSegments = fullRenderSegments().filter((segment) => !hasSegment(nextScaleKey, segment));
    if (missingFullSegments.length === 0) {
      recomputeRenderReadiness(nextScaleKey);
      return;
    }

    const token = ++renderToken;
    isReady = false;
    fullQualityReady = false;
    debugTimeline.log(
      'render-start',
      `Render page ${layout.pageIndex + 1} visible=${missingVisibleSegments.join(', ') || 'none'} remaining=${missingFullSegments.join(', ')} at scale ${nextScaleKey}`
    );

    try {
      for (const segment of missingVisibleSegments) {
        const targetCanvas = canvasForSegment(segment);
        if (!targetCanvas) {
          break;
        }

        await renderPdfPage({
          canvas: targetCanvas,
          page: layout.page,
          file,
          scale: layout.scale,
          segment,
          segmentCanvas: segment !== 'full'
        });

        if (token !== renderToken) {
          return;
        }

        renderedSegments = new Set(renderedSegments).add(segmentKey(nextScaleKey, segment));
        recomputeRenderReadiness(nextScaleKey);
      }

      if (token === renderToken) {
        recomputeRenderReadiness(nextScaleKey);
        debugTimeline.log('render-end', `Rendered visible segments for page ${layout.pageIndex + 1}`);

        // Eagerly render remaining off-screen segments, ordered by proximity
        // to the visible area so the next-to-scroll-into segment finishes first.
        const segmentOrder: PdfRenderSegment[] = ['top', 'middle', 'bottom'];
        const visibleSegs = visibleRenderSegments();
        const hasTop = visibleSegs.includes('top');
        const hasBottom = visibleSegs.includes('bottom');
        // If bottom is visible but top isn't, reverse so middle renders before top
        if (hasBottom && !hasTop) segmentOrder.reverse();
        const remaining = segmentOrder.filter((segment) => !hasSegment(nextScaleKey, segment));
        for (const segment of remaining) {
          const targetCanvas = canvasForSegment(segment);
          if (token !== renderToken || !targetCanvas || !file) break;
          try {
            await renderPdfPage({
              canvas: targetCanvas,
              page: layout.page,
              file,
              scale: layout.scale,
              segment,
              segmentCanvas: segment !== 'full'
            });
            if (token !== renderToken) break;
            renderedSegments = new Set(renderedSegments).add(segmentKey(nextScaleKey, segment));
            recomputeRenderReadiness(nextScaleKey);
          } catch { break; }
        }

        if (token === renderToken) {
          recomputeRenderReadiness(nextScaleKey);
          debugTimeline.log('render-end', `Rendered full page ${layout.pageIndex + 1}`);
        }
      }
    } catch (error) {
      if (token === renderToken && error instanceof Error && error.name !== 'RenderingCancelledException') {
        debugTimeline.log('render-end', `Render failed on page ${layout.pageIndex + 1}: ${error.message}`);
      }
    }
  }

  // ── Pointer event handlers ──

  function handlePointerDown(event: PointerEvent): void {
    // ── Tape peek/reveal: intercept finger taps on tape before normal tool handling ──
    // Works with any tool when using touch, or with hand tool for any pointer type.
    // This lets users tap tape to peek at hidden content during study sessions.
    const isTouchInput = event.pointerType === 'touch';
    const canPeekTape = isTouchInput || tool === 'hand';
    if (canPeekTape && activePointerId === null) {
      const coords = pageCoordinates(event);
      const peekPoint = coords[0];
      if (peekPoint) {
        const tape = findTapeAtPoint(peekPoint);
        if (tape) {
          event.preventDefault();
          event.stopPropagation();
          interactionLayer?.setPointerCapture(event.pointerId);
          tapePeekPointerId = event.pointerId;
          tapePeekTapeId = tape.id;
          tapePeekStartTime = Date.now();
          // Start hold-to-peek immediately — if released quickly, we'll toggle instead
          onTapePeek(tape.id, 'peek-start');
          return;
        }
      }
    }

    if (!pointerCanDraw(event)) {
      return;
    }

    window.getSelection?.()?.removeAllRanges();
    (document.activeElement as HTMLElement | null)?.blur?.();
    event.preventDefault();
    event.stopPropagation();
    interactionLayer?.setPointerCapture(event.pointerId);
    setInkSession(true, event.pointerType);
    updateEraserIndicator(event);

    if (tool === 'lasso') {
      const point = pageCoordinates(event).at(-1);
      if (!point) {
        return;
      }

      // Allow drag-to-move if clicking inside the existing selection region.
      // This lets the user click anywhere in the lasso area, not just on a specific annotation.
      if (localSelectedAnnotationIds.length > 0 && lassoSelectionRegion) {
        let insideRegion = false;
        if (lassoSelectionRegion.mode === 'rectangle') {
          const r = lassoSelectionRegion;
          insideRegion = point.x >= r.left && point.x <= r.right && point.y >= r.top && point.y <= r.bottom;
        } else {
          insideRegion = pointInPolygon(point, lassoSelectionRegion.polygon);
        }

        if (insideRegion) {
          beginMoveGesture(event, localSelectedAnnotationIds, point);
          return;
        }
      }

      // Start a new lasso selection gesture and dismiss the tool flyout
      lassoSelectionRegion = null;
      onToolGestureStart();
      beginStroke(event);
      return;
    }

    if (tool === 'shape') {
      const [point] = pageCoordinates(event);
      if (!point) {
        return;
      }

      const existingShape = findShapeAtPoint(point);
      if (existingShape) {
        const resizeHandle = findResizeHandle(existingShape, point);
        selectedShapeId = existingShape.id;
        shapeGesture = {
          mode: resizeHandle ? 'resize' : 'move',
          shapeId: existingShape.id,
          handle: resizeHandle,
          origin: point,
          startShape: { ...existingShape }
        };
        activePointerId = event.pointerId;
        activePoints = [point];
        previewAnnotations = annotations;
        return;
      }

      const draft = createShapeFromPoints(point, point, createClientId());
      selectedShapeId = draft.id;
      shapeGesture = {
        mode: 'create',
        shapeId: draft.id,
        handle: null,
        origin: point,
        startShape: draft
      };
      activePointerId = event.pointerId;
      activePoints = [point];
      previewAnnotations = [...annotations, draft];
      return;
    }

    if (tool === 'sticky') {
      const [point] = pageCoordinates(event);
      if (!point) {
        return;
      }

      const existingNote = findStickyNoteAtPoint(point);
      if (existingNote) {
        setSelectedAnnotationIds([existingNote.id]);
        beginMoveGesture(event, [existingNote.id], point);
        return;
      }

      const note: StickyNoteAnnotation = {
        id: createClientId(),
        type: 'sticky',
        text: 'New note',
        color: '#2a2a2a',
        noteColor: stickyNoteColor,
        x: Math.max(16, point.x - 98),
        y: Math.max(16, point.y - 72),
        width: 196,
        height: 144,
        fontSize: Math.max(16, textFontSize - 4)
      };
      setSelectedAnnotationIds([note.id]);
      onReplace(layout.page.id, [...annotations, note] as Annotation[]);
      clearPointerState();
      return;
    }

    if (tool === 'tape') {
      const [point] = pageCoordinates(event);
      if (!point) {
        return;
      }

      onToolGestureStart();
      activePointerId = event.pointerId;
      activePoints = [point];
      // Create initial zero-length tape preview
      const tape = createTapeFromPoints(point, point);
      previewAnnotations = [...annotations, tape];
      return;
    }

    beginStroke(event);
  }

  function handlePointerMove(event: PointerEvent): void {
    updateEraserIndicator(event);

    if (activePointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    continueStroke(event);

    if (moveGesture) {
      const point = activePoints.at(-1);
      if (!point) {
        return;
      }

      previewAnnotations = moveAnnotations(moveGesture.annotationIds, moveGesture.startAnnotations, moveGesture.origin, point);
      return;
    }

    if (tool === 'shape' && shapeGesture) {
      const point = activePoints[activePoints.length - 1];
      if (!point) {
        return;
      }

      previewAnnotations = updateShapePreview(point);
      return;
    }

    if (tool === 'tape' && activePoints.length >= 1) {
      const start = activePoints[0];
      const end = activePoints[activePoints.length - 1];
      const tape = createTapeFromPoints(start, end);
      previewAnnotations = [...annotations, tape];
      return;
    }

    if (tool === 'eraser') {
      previewAnnotations = eraseAnnotations(annotations, activePoints, currentEraserRadius(), { strokeMode: eraserStrokeMode });
      return;
    }

    if (tool === 'laser') {
      updateLaserPointer();
      return;
    }

    if (tool === 'pen' || tool === 'pencil' || tool === 'highlighter') {
      const strokePoints = currentStrokePoints();
      previewAnnotations = [
        ...annotations,
        createStroke({
          id: 'preview-stroke',
          tool,
          color,
          width: currentStrokeWidth(),
          points: strokePoints
        })
      ];
    }
  }

  // Low-latency stylus path — fires more often than pointermove on pen input
  function handlePointerRawUpdate(event: PointerEvent): void {
    if (activePointerId !== event.pointerId || event.pointerType !== 'pen') {
      return;
    }

    event.preventDefault();
    continueStroke(event);

    if (moveGesture) {
      const point = activePoints.at(-1);
      if (!point) {
        return;
      }

      previewAnnotations = moveAnnotations(moveGesture.annotationIds, moveGesture.startAnnotations, moveGesture.origin, point);
      return;
    }

    if (tool === 'pen' || tool === 'pencil' || tool === 'highlighter') {
      const strokePoints = currentStrokePoints();
      previewAnnotations = [
        ...annotations,
        createStroke({
          id: 'preview-stroke',
          tool,
          color,
          width: currentStrokeWidth(),
          points: strokePoints
        })
      ];
    }

    if (tool === 'laser') {
      updateLaserPointer();
    }
  }

  function handlePointerUp(event: PointerEvent): void {
    // ── Tape peek: finish the peek/toggle gesture ──
    if (tapePeekPointerId === event.pointerId && tapePeekTapeId) {
      const holdDuration = Date.now() - tapePeekStartTime;
      const tapeId = tapePeekTapeId;
      releaseCapturedPointer(event.pointerId);
      tapePeekPointerId = null;
      tapePeekTapeId = null;
      if (holdDuration < TAPE_PEEK_HOLD_THRESHOLD) {
        // Quick tap — toggle the tape's revealed state (undo the peek-start first)
        onTapePeek(tapeId, 'peek-end');
        onTapePeek(tapeId, 'toggle');
      } else {
        // Long hold — end the temporary peek, tape goes back to its persistent state
        onTapePeek(tapeId, 'peek-end');
      }
      return;
    }

    if (activePointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    continueStroke(event);
    finishStroke();
    releaseCapturedPointer(event.pointerId);
  }

  function handlePointerCancel(event?: PointerEvent): void {
    // Clean up tape peek on cancel
    if (event && tapePeekPointerId === event.pointerId && tapePeekTapeId) {
      onTapePeek(tapePeekTapeId, 'peek-end');
      releaseCapturedPointer(event.pointerId);
      tapePeekPointerId = null;
      tapePeekTapeId = null;
      return;
    }

    if (event && activePointerId !== event.pointerId) {
      return;
    }

    if (activePoints.length > 0) {
      finishStroke();
      if (event) {
        releaseCapturedPointer(event.pointerId);
      }
      return;
    }

    clearPointerState();
  }

  function handleLostPointerCapture(event: PointerEvent): void {
    // Clean up tape peek if pointer capture was lost
    if (tapePeekPointerId === event.pointerId && tapePeekTapeId) {
      onTapePeek(tapePeekTapeId, 'peek-end');
      tapePeekPointerId = null;
      tapePeekTapeId = null;
      return;
    }

    if (activePointerId !== event.pointerId) {
      return;
    }

    if (activePoints.length > 0) {
      finishStroke();
      return;
    }

    clearPointerState();
  }

  // ── Text and sticky note editing ──

  function addText(): void {
    if (tool !== 'text') {
      return;
    }

    const text = window.prompt('Add text');
    if (!text?.trim()) {
      return;
    }

    const annotation: TextAnnotation = {
      id: createClientId(),
      type: 'text',
      text: text.trim(),
      color,
      x: 72,
      y: 92,
      width: 220,
      height: 44,
      fontSize: textFontSize
    };

    onReplace(layout.page.id, [...annotations, annotation]);
  }

  function editTextAnnotation(annotation: TextAnnotation | StickyNoteAnnotation): void {
    const promptLabel = annotation.type === 'sticky' ? 'Sticky note text' : 'Edit text';
    const nextText = window.prompt(promptLabel, annotation.text);
    if (nextText === null) {
      return;
    }

    const trimmed = nextText.trim();
    if (!trimmed) {
      return;
    }

    onReplace(
      layout.page.id,
      annotations.map((entry) => {
        if (entry.id !== annotation.id) {
          return entry;
        }

        return {
          ...entry,
          text: trimmed
        };
      }) as Annotation[]
    );
  }

  function handleDoubleClick(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();

    const point = mousePagePoint(event);
    if (!point) {
      return;
    }

    const hitAnnotation = findAnnotationAtPoint(point);
    if (hitAnnotation && (hitAnnotation.type === 'sticky' || hitAnnotation.type === 'text')) {
      editTextAnnotation(hitAnnotation);
      return;
    }

    if (tool === 'text') {
      addText();
    }
  }

  function updateLaserPointer(): void {
    const latestPoint = activePoints[activePoints.length - 1];
    const originPoint = activePoints[0];
    if (!latestPoint) {
      clearLaserPointer();
      return;
    }

    laserPointerVisible = true;

    if (laserPointerMode === 'line' && originPoint) {
      laserPointerPath = `M ${originPoint.x * layout.scale} ${originPoint.y * layout.scale} L ${latestPoint.x * layout.scale} ${latestPoint.y * layout.scale}`;
      laserPointerStyle = '';
      return;
    }

    laserPointerPath = '';
    laserPointerStyle = `width:${18}px; height:${18}px; left:${latestPoint.x * layout.scale - 9}px; top:${latestPoint.y * layout.scale - 9}px;`;
  }

  function setSelectedAnnotationIds(nextIds: string[]): void {
    localSelectedAnnotationIds = nextIds;
    onSelectionChange(layout.page.id, nextIds);
  }

  // ── Geometry utilities — hit testing, bounds, distance calculations ──

  function distanceSquared(a: PagePoint, b: PagePoint): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
  }

  function pointDistanceSquaredToSegment(point: PagePoint, start: PagePoint, end: PagePoint): number {
    const dx = end.x - start.x;
    const dy = end.y - start.y;

    if (dx === 0 && dy === 0) {
      return distanceSquared(point, start);
    }

    const t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy);
    const clampedT = Math.max(0, Math.min(1, t));
    const projection = {
      x: start.x + clampedT * dx,
      y: start.y + clampedT * dy,
      pressure: 0,
      time: 0
    };

    return distanceSquared(point, projection);
  }

  function annotationBounds(annotation: PageAnnotation): { left: number; top: number; right: number; bottom: number } {
    if (annotation.type === 'stroke') {
      const xs = annotation.points.map((point) => point.x);
      const ys = annotation.points.map((point) => point.y);
      const padding = Math.max(6, annotation.width);
      return {
        left: Math.min(...xs) - padding,
        top: Math.min(...ys) - padding,
        right: Math.max(...xs) + padding,
        bottom: Math.max(...ys) + padding
      };
    }

    if (annotation.type === 'tape') {
      const corners = tapeCorners(annotation);
      if (corners.length === 0) {
        return { left: annotation.x1, top: annotation.y1, right: annotation.x1, bottom: annotation.y1 };
      }
      const xs = corners.map((c) => c.x);
      const ys = corners.map((c) => c.y);
      return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
    }

    return {
      left: annotation.x,
      top: annotation.y,
      right: annotation.x + annotation.width,
      bottom: annotation.y + annotation.height
    };
  }

  function cloneAnnotation(annotation: PageAnnotation): PageAnnotation {
    if (annotation.type === 'stroke') {
      return {
        ...annotation,
        points: annotation.points.map((point) => ({ ...point }))
      };
    }

    return { ...annotation };
  }

  function pointInEllipse(point: PagePoint, annotation: ShapeAnnotation): boolean {
    const radiusX = Math.max(1, annotation.width / 2);
    const radiusY = Math.max(1, annotation.height / 2);
    const centerX = annotation.x + radiusX;
    const centerY = annotation.y + radiusY;
    const normalizedX = (point.x - centerX) / radiusX;
    const normalizedY = (point.y - centerY) / radiusY;
    return normalizedX * normalizedX + normalizedY * normalizedY <= 1;
  }

  function annotationHitTest(annotation: PageAnnotation, point: PagePoint): boolean {
    if (annotation.type === 'stroke') {
      const threshold = Math.max(8 / Math.max(layout.scale, 0.001), annotation.width * 1.25 + 2);
      const thresholdSquared = threshold * threshold;

      if (annotation.points.length === 1) {
        return distanceSquared(annotation.points[0], point) <= thresholdSquared;
      }

      for (let index = 0; index < annotation.points.length - 1; index += 1) {
        if (pointDistanceSquaredToSegment(point, annotation.points[index], annotation.points[index + 1]) <= thresholdSquared) {
          return true;
        }
      }

      return false;
    }

    if (annotation.type === 'tape') {
      const corners = tapeCorners(annotation);
      if (corners.length < 3) return false;
      return polygonContainsPoint(point, [...corners, corners[0]]);
    }

    if (annotation.type === 'text' || annotation.type === 'sticky') {
      return point.x >= annotation.x && point.x <= annotation.x + annotation.width && point.y >= annotation.y && point.y <= annotation.y + annotation.height;
    }

    if (annotation.shape === 'ellipse') {
      return pointInEllipse(point, annotation);
    }

    return point.x >= annotation.x && point.x <= annotation.x + annotation.width && point.y >= annotation.y && point.y <= annotation.y + annotation.height;
  }

  function findAnnotationAtPoint(point: PagePoint): PageAnnotation | null {
    for (let index = annotations.length - 1; index >= 0; index -= 1) {
      const annotation = annotations[index];
      if (annotationHitTest(annotation, point)) {
        return annotation;
      }
    }

    return null;
  }

  function findStickyNoteAtPoint(point: PagePoint): StickyNoteAnnotation | null {
    for (let index = annotations.length - 1; index >= 0; index -= 1) {
      const annotation = annotations[index];
      if (annotation.type === 'sticky' && annotationHitTest(annotation, point)) {
        return annotation;
      }
    }

    return null;
  }

  /** Find the topmost solid (non-revealed) tape annotation at a point for peek interaction */
  function findTapeAtPoint(point: PagePoint): TapeAnnotation | null {
    for (let index = annotations.length - 1; index >= 0; index -= 1) {
      const annotation = annotations[index];
      if (annotation.type === 'tape' && annotationHitTest(annotation, point)) {
        return annotation;
      }
    }
    return null;
  }

  function mousePagePoint(event: MouseEvent): PagePoint | null {
    if (!interactionLayer) {
      return null;
    }

    const rect = interactionLayer.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / layout.scale,
      y: (event.clientY - rect.top) / layout.scale,
      pressure: 0.5,
      time: event.timeStamp
    };
  }

  // Uses a throwaway canvas + isPointInPath for accurate polygon containment testing
  function polygonContainsPoint(point: PagePoint, polygon: PagePoint[]): boolean {
    if (polygon.length < 3 || typeof document === 'undefined') {
      return false;
    }

    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d');
    if (!context) {
      return false;
    }

    context.beginPath();
    context.moveTo(polygon[0].x, polygon[0].y);
    for (let index = 1; index < polygon.length; index += 1) {
      context.lineTo(polygon[index].x, polygon[index].y);
    }
    context.closePath();
    return context.isPointInPath(point.x, point.y);
  }

  function pointInPolygon(point: PagePoint, polygon: PagePoint[]): boolean {
    if (polygon.length < 3) {
      return false;
    }

    return polygonContainsPoint(point, polygon);
  }

  // Checks if two line segments (a1→a2) and (b1→b2) intersect
  function segmentsIntersect(a1: PagePoint, a2: PagePoint, b1: PagePoint, b2: PagePoint): boolean {
    const d1x = a2.x - a1.x;
    const d1y = a2.y - a1.y;
    const d2x = b2.x - b1.x;
    const d2y = b2.y - b1.y;
    const cross = d1x * d2y - d1y * d2x;
    if (Math.abs(cross) < 1e-10) return false;
    const t = ((b1.x - a1.x) * d2y - (b1.y - a1.y) * d2x) / cross;
    const u = ((b1.x - a1.x) * d1y - (b1.y - a1.y) * d1x) / cross;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
  }

  // Checks if any segment of a stroke crosses any edge of the lasso polygon
  function strokeCrossesPolygon(points: PagePoint[], polygon: PagePoint[]): boolean {
    for (let si = 0; si < points.length - 1; si += 1) {
      for (let pi = 0; pi < polygon.length - 1; pi += 1) {
        if (segmentsIntersect(points[si], points[si + 1], polygon[pi], polygon[pi + 1])) {
          return true;
        }
      }
    }
    return false;
  }

  // Select annotation if ANY part overlaps the lasso polygon.
  // For strokes: any point inside OR any segment crossing the lasso boundary.
  // For shapes/text/sticky: any corner or center inside, or any polygon edge crossing the bounds.
  function annotationOverlapsPolygon(annotation: PageAnnotation, polygon: PagePoint[]): boolean {
    if (annotation.type === 'stroke') {
      if (annotation.points.length === 0) return false;

      // Check if any stroke point is inside the polygon (sample for performance)
      const step = Math.max(1, Math.floor(annotation.points.length / 48));
      for (let index = 0; index < annotation.points.length; index += step) {
        if (pointInPolygon(annotation.points[index], polygon)) return true;
      }
      // Always check the last point
      if (pointInPolygon(annotation.points[annotation.points.length - 1], polygon)) return true;

      // Check if any stroke segment crosses the lasso boundary
      return strokeCrossesPolygon(annotation.points, polygon);
    }

    // For shapes, text, stickies — check if any corner or center is inside
    const bounds = annotationBounds(annotation);
    const testPoints: PagePoint[] = [
      { x: bounds.left, y: bounds.top, pressure: 0, time: 0 },
      { x: bounds.right, y: bounds.top, pressure: 0, time: 0 },
      { x: bounds.right, y: bounds.bottom, pressure: 0, time: 0 },
      { x: bounds.left, y: bounds.bottom, pressure: 0, time: 0 },
      { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2, pressure: 0, time: 0 }
    ];
    if (testPoints.some((p) => pointInPolygon(p, polygon))) return true;

    // Check if any polygon edge crosses the annotation bounding box edges
    const boxEdges: [PagePoint, PagePoint][] = [
      [testPoints[0], testPoints[1]],
      [testPoints[1], testPoints[2]],
      [testPoints[2], testPoints[3]],
      [testPoints[3], testPoints[0]]
    ];
    for (let pi = 0; pi < polygon.length - 1; pi += 1) {
      for (const [a, b] of boxEdges) {
        if (segmentsIntersect(polygon[pi], polygon[pi + 1], a, b)) return true;
      }
    }

    return false;
  }

  // ── Tape tool — create semi-transparent decorative strips ──

  /** Snaps an angle (radians) to the nearest 0°/90°/180°/270° if within 8° */
  function snapAngle(angle: number): number {
    const snapTargets = [0, Math.PI / 2, Math.PI, -Math.PI / 2, -Math.PI];
    const threshold = (8 * Math.PI) / 180;
    for (const target of snapTargets) {
      if (Math.abs(angle - target) < threshold) return target;
    }
    return angle;
  }

  function createTapeFromPoints(start: PagePoint, end: PagePoint): TapeAnnotation {
    let dx = end.x - start.x;
    let dy = end.y - start.y;

    if (tapeStraightMode) {
      const angle = snapAngle(Math.atan2(dy, dx));
      const length = Math.sqrt(dx * dx + dy * dy);
      dx = Math.cos(angle) * length;
      dy = Math.sin(angle) * length;
    }

    return {
      id: createClientId(),
      type: 'tape',
      x1: start.x,
      y1: start.y,
      x2: start.x + dx,
      y2: start.y + dy,
      tapeWidth,
      color: tapeColor,
      pattern: tapePattern,
      opacity: tapeOpacity
    };
  }

  /** Compute the 4 corners of a tape strip as a polygon */
  function tapeCorners(tape: TapeAnnotation): PagePoint[] {
    const dx = tape.x2 - tape.x1;
    const dy = tape.y2 - tape.y1;
    const length = Math.sqrt(dx * dx + dy * dy);
    if (length < 0.001) return [];
    // Unit normal perpendicular to the tape direction
    const nx = (-dy / length) * (tape.tapeWidth / 2);
    const ny = (dx / length) * (tape.tapeWidth / 2);
    return [
      { x: tape.x1 + nx, y: tape.y1 + ny, pressure: 0, time: 0 },
      { x: tape.x2 + nx, y: tape.y2 + ny, pressure: 0, time: 0 },
      { x: tape.x2 - nx, y: tape.y2 - ny, pressure: 0, time: 0 },
      { x: tape.x1 - nx, y: tape.y1 - ny, pressure: 0, time: 0 }
    ];
  }

  /** SVG polygon points attribute for a tape strip */
  function tapePolygonPoints(tape: TapeAnnotation, scale: number): string {
    return tapeCorners(tape)
      .map((p) => `${p.x * scale},${p.y * scale}`)
      .join(' ');
  }

  /** SVG pattern ID for tape patterns — returns null for solid */
  function tapePatternId(tape: TapeAnnotation): string | null {
    if (tape.pattern === 'solid') return null;
    return `tape-pattern-${tape.pattern}-${tape.id}`;
  }

  // ── Annotation move/selection gestures ──

  function moveAnnotation(annotation: PageAnnotation, dx: number, dy: number): PageAnnotation {
    if (annotation.type === 'stroke') {
      return {
        ...annotation,
        points: annotation.points.map((point) => ({
          ...point,
          x: point.x + dx,
          y: point.y + dy
        }))
      };
    }

    if (annotation.type === 'tape') {
      return {
        ...annotation,
        x1: annotation.x1 + dx,
        y1: annotation.y1 + dy,
        x2: annotation.x2 + dx,
        y2: annotation.y2 + dy
      };
    }

    return {
      ...annotation,
      x: annotation.x + dx,
      y: annotation.y + dy
    };
  }

  function moveAnnotations(annotationIds: string[], startAnnotations: PageAnnotation[], origin: PagePoint, point: PagePoint): PageAnnotation[] {
    const selectionBounds = startAnnotations.reduce(
      (bounds, annotation) => {
        const nextBounds = annotationBounds(annotation);
        return {
          left: Math.min(bounds.left, nextBounds.left),
          top: Math.min(bounds.top, nextBounds.top)
        };
      },
      { left: Number.POSITIVE_INFINITY, top: Number.POSITIVE_INFINITY }
    );
    const dx = Math.max(point.x - origin.x, -selectionBounds.left);
    const dy = Math.max(point.y - origin.y, -selectionBounds.top);
    const selectedIds = new Set(annotationIds);
    const moved = new Map(startAnnotations.map((annotation) => [annotation.id, moveAnnotation(annotation, dx, dy)]));

    return annotations.map((annotation) => (selectedIds.has(annotation.id) ? moved.get(annotation.id) ?? annotation : annotation));
  }

  function beginMoveGesture(event: PointerEvent, annotationIds: string[], origin: PagePoint): void {
    activePointerId = event.pointerId;
    activePoints = [origin];
    moveGesture = {
      annotationIds: [...annotationIds],
      origin,
      startAnnotations: annotations.filter((annotation) => annotationIds.includes(annotation.id)).map(cloneAnnotation)
    };
    previewAnnotations = moveAnnotations(annotationIds, moveGesture.startAnnotations, origin, origin);
  }

  function selectAnnotationsFromPath(points: PagePoint[]): string[] {
    if (points.length === 0) {
      return [];
    }

    const last = points[points.length - 1];
    const first = points[0];
    const left = Math.min(first.x, last.x);
    const right = Math.max(first.x, last.x);
    const top = Math.min(first.y, last.y);
    const bottom = Math.max(first.y, last.y);
    const polygon = lassoMode === 'freehand' && points.length > 2 ? closePolygon(points) : null;

    return annotations
      .filter((annotation) => {
        if (polygon) {
          return annotationOverlapsPolygon(annotation, polygon);
        }

        const bounds = annotationBounds(annotation);
        return !(bounds.right < left || bounds.left > right || bounds.bottom < top || bounds.top > bottom);
      })
      .map((annotation) => annotation.id);
  }

  function closePolygon(points: PagePoint[]): PagePoint[] {
    if (points.length < 2) {
      return points;
    }

    const first = points[0];
    const last = points[points.length - 1];
    if (first.x === last.x && first.y === last.y) {
      return points;
    }

    return [...points, { ...first }];
  }

  // ── Shape tool — create, move, resize ──

  function createShapeFromPoints(start: PagePoint, end: PagePoint, id: string): ShapeAnnotation {
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const width = Math.max(16, Math.abs(end.x - start.x));
    const height = Math.max(16, Math.abs(end.y - start.y));

    return {
      id,
      type: 'shape',
      shape: shapeKind,
      color,
      x,
      y,
      width,
      height,
      strokeWidth: sizePreset + 1,
      fill: shapeFill,
      lineStyle: shapeLineStyle
    };
  }

  function findShapeAtPoint(point: PagePoint): ShapeAnnotation | null {
    const shapes = annotations.filter((annotation): annotation is ShapeAnnotation => annotation.type === 'shape');
    for (let index = shapes.length - 1; index >= 0; index -= 1) {
      const shape = shapes[index];
      if (point.x >= shape.x && point.x <= shape.x + shape.width && point.y >= shape.y && point.y <= shape.y + shape.height) {
        return shape;
      }
    }
    return null;
  }

  function findResizeHandle(shape: ShapeAnnotation, point: PagePoint): 'nw' | 'ne' | 'sw' | 'se' | null {
    const radius = 12 / layout.scale;
    const handles: Array<{ kind: 'nw' | 'ne' | 'sw' | 'se'; x: number; y: number }> = [
      { kind: 'nw', x: shape.x, y: shape.y },
      { kind: 'ne', x: shape.x + shape.width, y: shape.y },
      { kind: 'sw', x: shape.x, y: shape.y + shape.height },
      { kind: 'se', x: shape.x + shape.width, y: shape.y + shape.height }
    ];

    for (const handle of handles) {
      const dx = point.x - handle.x;
      const dy = point.y - handle.y;
      if (dx * dx + dy * dy <= radius * radius) {
        return handle.kind;
      }
    }

    return null;
  }

  function updateShapePreview(point: PagePoint): PageAnnotation[] {
    if (!shapeGesture) {
      return annotations;
    }

    const draft =
      shapeGesture.mode === 'create'
        ? createShapeFromPoints(shapeGesture.origin, point, shapeGesture.shapeId)
        : transformShape(shapeGesture.startShape, shapeGesture, point);

    return annotations
      .filter((annotation) => annotation.id !== shapeGesture.shapeId)
      .concat(draft);
  }

  function transformShape(
    shape: ShapeAnnotation,
    gesture: NonNullable<typeof shapeGesture>,
    point: PagePoint
  ): ShapeAnnotation {
    if (gesture.mode === 'move') {
      return {
        ...shape,
        x: Math.max(0, shape.x + (point.x - gesture.origin.x)),
        y: Math.max(0, shape.y + (point.y - gesture.origin.y))
      };
    }

    const left = shape.x;
    const top = shape.y;
    const right = shape.x + shape.width;
    const bottom = shape.y + shape.height;

    const nextLeft = gesture.handle === 'nw' || gesture.handle === 'sw' ? point.x : left;
    const nextTop = gesture.handle === 'nw' || gesture.handle === 'ne' ? point.y : top;
    const nextRight = gesture.handle === 'ne' || gesture.handle === 'se' ? point.x : right;
    const nextBottom = gesture.handle === 'sw' || gesture.handle === 'se' ? point.y : bottom;

    return {
      ...shape,
      x: Math.min(nextLeft, nextRight),
      y: Math.min(nextTop, nextBottom),
      width: Math.max(16, Math.abs(nextRight - nextLeft)),
      height: Math.max(16, Math.abs(nextBottom - nextTop))
    };
  }

  // ── Lifecycle ──

  onMount(() => {
    debugTimeline.log('shell-mounted', `Shell mounted for page ${layout.pageIndex + 1}`);
    interactionLayer?.addEventListener('pointerrawupdate', handlePointerRawUpdate, { passive: false });
    interactionLayer?.addEventListener('touchstart', handleStylusTouch, { passive: false });
    interactionLayer?.addEventListener('touchmove', handleStylusTouch, { passive: false });
    interactionLayer?.addEventListener('touchend', handleStylusTouch, { passive: false });
    interactionLayer?.addEventListener('touchcancel', handleStylusTouch, { passive: false });
  });

  onDestroy(() => {
    interactionLayer?.removeEventListener('pointerrawupdate', handlePointerRawUpdate);
    interactionLayer?.removeEventListener('touchstart', handleStylusTouch);
    interactionLayer?.removeEventListener('touchmove', handleStylusTouch);
    interactionLayer?.removeEventListener('touchend', handleStylusTouch);
    interactionLayer?.removeEventListener('touchcancel', handleStylusTouch);
    cancelSegmentRenders();
    setInkSession(false);
    renderToken += 1;
    if (previewDeferTimer) { clearTimeout(previewDeferTimer); previewDeferTimer = null; }
    debugTimeline.log('shell-unmounted', `Shell unmounted for page ${layout.pageIndex + 1}`);
  });

  // ── Reactive declarations ──

  $: displayAnnotations = previewAnnotations ?? annotations;
  $: onPreviewAnnotationsChange(layout.page.id, previewAnnotations);
  $: selectedShape =
    displayAnnotations.find(
      (annotation): annotation is ShapeAnnotation => annotation.type === 'shape' && annotation.id === selectedShapeId
    ) ?? null;

  $: if (layout.page.kind !== 'pdf') {
    isReady = true;
    fullQualityReady = true;
    renderedScaleKey = '';
    renderedSegments = new Set<string>();
    previewLoaded = true;
    previewLoadedPageId = layout.page.id;
  }

  $: if (layout.page.kind === 'pdf') {
    if (!allowRender && !renderSuspended) {
      renderSuspended = true;
      if (fullCanvas || topSegmentCanvas || middleSegmentCanvas || bottomSegmentCanvas) {
        renderToken += 1;
        cancelSegmentRenders();
      }
    } else if (allowRender && renderSuspended) {
      renderSuspended = false;
    }
  }

  $: layoutGeometryKey =
    layout.page.kind === 'pdf'
      ? `${Number(layout.scale.toFixed(4)).toFixed(4)}:${Math.round(layout.width)}:${Math.round(layout.height)}`
      : '';

  $: if (layout.page.kind === 'pdf' && layoutGeometryKey && layoutGeometryKey !== previousLayoutGeometryKey) {
    previousLayoutGeometryKey = layoutGeometryKey;
    renderToken += 1;
    cancelSegmentRenders();
    renderedScaleKey = '';
    renderedSegments = new Set<string>();
    isReady = false;
    fullQualityReady = false;
  }

  $: renderStrategyKey =
    layout.page.kind === 'pdf'
      ? `${connectionQuality}:${useSegmentedPdfRender() ? 'segmented' : 'full'}`
      : '';

  $: if (layout.page.kind === 'pdf' && renderStrategyKey && renderStrategyKey !== previousRenderStrategyKey) {
    previousRenderStrategyKey = renderStrategyKey;
    renderToken += 1;
    cancelSegmentRenders();
    renderedScaleKey = '';
    renderedSegments = new Set<string>();
    isReady = false;
    fullQualityReady = false;
  }

  $: renderIntentKey =
    layout.page.kind === 'pdf'
      ? `${Number(layout.scale.toFixed(4)).toFixed(4)}:${renderStrategyKey}:${viewportTop}:${viewportHeight}:${isActive ? 'active' : 'passive'}:${allowRender ? 'go' : 'wait'}`
      : '';

  // All connection speeds get full-res PDF.js rendering. On slow/medium,
  // the per-page PDF endpoint provides a self-contained ~100-500KB file
  // that downloads in one request. No dwell delay needed.
  $: if (((useSegmentedPdfRender() && topSegmentCanvas && middleSegmentCanvas && bottomSegmentCanvas) || (!useSegmentedPdfRender() && fullCanvas)) && file && layout.page.kind === 'pdf' && renderIntentKey && allowRender) {
    scheduleRender(
      layout.page.id,
      layout.pageIndex,
      activePageIndex,
      () => renderPdfIfNeeded(),
      () => {
        renderToken++;
        cancelSegmentRenders();
      }
    );
  }

  $: if (tool === 'hand' && inkSessionActive) {
    setInkSession(false);
  }

  $: if (tool !== 'laser' && laserPointerVisible) {
    clearLaserPointer();
  }

  $: if (tool !== 'lasso' && localSelectedAnnotationIds.length > 0) {
    localSelectedAnnotationIds = [];
    lassoSelectionRegion = null;
    onSelectionChange(layout.page.id, []);
  }

  $: if (tool !== 'eraser' && eraserIndicatorVisible) {
    clearEraserIndicator();
  }

  $: previewWidth = Math.max(120, Math.min(Math.ceil(layout.width), networkConfig.maxPreviewWidth));

  // On slow connections, skip preview images for pages far from the active page.
  // This prevents preview HTTP requests from consuming connection slots that the
  // active page's PDF.js range requests need.
  // slow = no previews (skeleton → canvas only), medium = active ± 2, fast = all
  $: showPreview = (() => {
    if (networkConfig.previewRadius === Infinity) return true;
    return Math.abs(layout.pageIndex - activePageIndex) <= networkConfig.previewRadius;
  })();

  // On slow/medium connections, defer preview src for non-active pages.
  // This gives the active page's preview and PDF first access to connection slots.
  // Active page gets src immediately; neighbors get it after 200ms.
  $: {
    const slow = connectionQuality !== 'fast';
    if (!slow || isActive) {
      // Fast connection or active page: load immediately
      previewDeferred = false;
      if (previewDeferTimer) { clearTimeout(previewDeferTimer); previewDeferTimer = null; }
    } else if (showPreview && slow) {
      // Non-active page on slow/medium: defer to let active page go first
      previewDeferred = true;
      if (previewDeferTimer) clearTimeout(previewDeferTimer);
      previewDeferTimer = setTimeout(() => { previewDeferred = false; previewDeferTimer = null; }, 200);
    }
  }

  $: if (layout.page.kind === 'pdf' && previewLoadedPageId !== layout.page.id) {
    previewLoaded = false;
    previewLoadStart = performance.now();
  }

  $: eraserIndicatorStyle =
    eraserIndicatorPoint && eraserIndicatorVisible
      ? `width:${currentEraserRadius() * 2 * layout.scale}px; height:${currentEraserRadius() * 2 * layout.scale}px; left:${eraserIndicatorPoint.x * layout.scale - currentEraserRadius() * layout.scale}px; top:${eraserIndicatorPoint.y * layout.scale - currentEraserRadius() * layout.scale}px;`
      : '';
  $: localSelectedAnnotationIds = selectedAnnotationIds;
</script>

<article
  class:active={isActive}
  class="reader-page-shell"
  style={`top:${layout.top}px; left:${layout.left}px; width:${layout.width}px; height:${layout.height}px;`}
>
  <div class="reader-page-paper">
    {#if layout.page.kind === 'pdf'}
      {#if (!previewLoaded || !showPreview) && !isReady}
        <div class="reader-page-skeleton"></div>
      {/if}
      {#if showPreview && !previewDeferred && (allowRender || previewLoaded || connectionQuality === 'fast')}
        <img
          alt=""
          aria-hidden="true"
          class:ready={fullQualityReady}
          class="reader-pdf-preview"
          decoding="async"
          fetchpriority={isActive ? 'high' : 'low'}
          loading={connectionQuality === 'fast' ? 'eager' : 'lazy'}
          on:load={previewDidLoad}
          src={`/api/pages/${layout.page.id}/preview?width=${previewWidth}`}
        />
      {/if}
      {#if useSegmentedPdfRender()}
        <canvas
          bind:this={topSegmentCanvas}
          class:ready={segmentReady('top')}
          class="reader-pdf-canvas reader-pdf-canvas-top"
          style={segmentCanvasStyle('top')}
        ></canvas>
        <canvas
          bind:this={middleSegmentCanvas}
          class:ready={segmentReady('middle')}
          class="reader-pdf-canvas reader-pdf-canvas-middle"
          style={segmentCanvasStyle('middle')}
        ></canvas>
        <canvas
          bind:this={bottomSegmentCanvas}
          class:ready={segmentReady('bottom')}
          class="reader-pdf-canvas reader-pdf-canvas-bottom"
          style={segmentCanvasStyle('bottom')}
        ></canvas>
      {:else}
        <canvas
          bind:this={fullCanvas}
          class:ready={segmentReady('full')}
          class="reader-pdf-canvas reader-pdf-canvas-full"
          style={fullCanvasStyle()}
        ></canvas>
      {/if}
    {:else}
      <div class={`reader-template-layer ${templateClass(layout.page)}`}></div>
    {/if}

    <svg class="annotation-svg" viewBox={`0 0 ${layout.width} ${layout.height}`}>
      {#each displayAnnotations as annotation (annotation.id)}
        {#if annotation.type === 'stroke'}
          {#if annotation.tool === 'pencil'}
            {#each pencilStrokeLayers(annotation) as layer}
              <path
                d={strokePath(annotation.points, layout.scale)}
                fill="none"
                stroke={annotation.color}
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-opacity={layer.opacity}
                stroke-width={scaledWidth(annotation.width * layer.multiplier)}
              ></path>
            {/each}
          {:else}
            <path
              d={strokePath(annotation.points, layout.scale)}
              fill="none"
              stroke={annotation.color}
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-opacity={annotation.tool === 'highlighter' ? 0.33 : 1}
              stroke-width={scaledWidth(annotation.width)}
            ></path>
          {/if}
        {:else if annotation.type === 'text'}
          <text
            fill={annotation.color}
            font-size={annotation.fontSize * layout.scale}
            x={annotation.x * layout.scale}
            y={(annotation.y + annotation.fontSize) * layout.scale}
          >
            {annotation.text}
          </text>
        {:else if annotation.type === 'sticky'}
          <g>
            <rect
              fill={annotation.noteColor}
              fill-opacity="0.92"
              height={annotation.height * layout.scale}
              rx="14"
              ry="14"
              stroke="rgba(42,42,42,0.22)"
              stroke-width="1.2"
              width={annotation.width * layout.scale}
              x={annotation.x * layout.scale}
              y={annotation.y * layout.scale}
            ></rect>
            <text
              fill={annotation.color}
              font-size={annotation.fontSize * layout.scale}
              x={(annotation.x + 14) * layout.scale}
              y={(annotation.y + annotation.fontSize + 12) * layout.scale}
            >
              {annotation.text}
            </text>
          </g>
        {:else if annotation.shape === 'ellipse'}
          <ellipse
            cx={(annotation.x + annotation.width / 2) * layout.scale}
            cy={(annotation.y + annotation.height / 2) * layout.scale}
            fill={annotation.fill ? annotation.color : 'transparent'}
            fill-opacity={annotation.fill ? 0.16 : 0}
            rx={(annotation.width / 2) * layout.scale}
            ry={(annotation.height / 2) * layout.scale}
            stroke={annotation.color}
            stroke-dasharray={lineStyle(annotation)}
            stroke-width={scaledWidth(annotation.strokeWidth)}
          ></ellipse>
        {:else if annotation.shape === 'rectangle'}
          <rect
            fill={annotation.fill ? annotation.color : 'transparent'}
            fill-opacity={annotation.fill ? 0.16 : 0}
            height={annotation.height * layout.scale}
            stroke={annotation.color}
            stroke-dasharray={lineStyle(annotation)}
            stroke-width={scaledWidth(annotation.strokeWidth)}
            width={annotation.width * layout.scale}
            x={annotation.x * layout.scale}
            y={annotation.y * layout.scale}
          ></rect>
        {:else if annotation.type === 'tape'}
          {@const isRevealed = revealedTapeIds.has(annotation.id)}
          <g style="transition: opacity 150ms ease-in-out;" opacity={isRevealed ? 0.08 : 1}>
            {#if tapePatternId(annotation)}
              <defs>
                {#if annotation.pattern === 'stripe'}
                  <pattern id={tapePatternId(annotation)} width="8" height="8" patternUnits="userSpaceOnUse">
                    <rect width="8" height="8" fill={annotation.color}></rect>
                    <line x1="0" y1="0" x2="0" y2="8" stroke="rgba(255,255,255,0.35)" stroke-width="3"></line>
                  </pattern>
                {:else if annotation.pattern === 'dots'}
                  <pattern id={tapePatternId(annotation)} width="10" height="10" patternUnits="userSpaceOnUse">
                    <rect width="10" height="10" fill={annotation.color}></rect>
                    <circle cx="5" cy="5" r="1.5" fill="rgba(255,255,255,0.4)"></circle>
                  </pattern>
                {:else if annotation.pattern === 'grid'}
                  <pattern id={tapePatternId(annotation)} width="10" height="10" patternUnits="userSpaceOnUse">
                    <rect width="10" height="10" fill={annotation.color}></rect>
                    <path d="M 10 0 L 0 0 0 10" fill="none" stroke="rgba(255,255,255,0.25)" stroke-width="1"></path>
                  </pattern>
                {/if}
              </defs>
            {/if}
            <polygon
              points={tapePolygonPoints(annotation, layout.scale)}
              fill={tapePatternId(annotation) ? `url(#${tapePatternId(annotation)})` : annotation.color}
              fill-opacity={annotation.opacity}
              stroke="none"
            ></polygon>
            <!-- Subtle torn-edge effect along the short sides -->
            <polygon
              points={tapePolygonPoints(annotation, layout.scale)}
              fill="none"
              stroke="rgba(255,255,255,0.18)"
              stroke-width="0.8"
            ></polygon>
          </g>
        {:else}
          <path
            d={shapePath(annotation, layout.scale)}
            fill={annotation.fill ? annotation.color : 'transparent'}
            fill-opacity={annotation.fill ? 0.16 : 0}
            stroke={annotation.color}
            stroke-dasharray={lineStyle(annotation)}
            stroke-width={scaledWidth(annotation.strokeWidth)}
          ></path>
        {/if}
      {/each}

      {#each displayAnnotations.filter((annotation) => localSelectedAnnotationIds.includes(annotation.id)) as annotation (annotation.id)}
        {#key `${annotation.id}:selection`}
          {@const bounds = annotationBounds(annotation)}
          <rect
            fill="none"
            height={(bounds.bottom - bounds.top) * layout.scale}
            rx="12"
            ry="12"
            stroke="#7b4bb3"
            stroke-dasharray="10 8"
            stroke-width="2.4"
            width={(bounds.right - bounds.left) * layout.scale}
            x={bounds.left * layout.scale}
            y={bounds.top * layout.scale}
          ></rect>
        {/key}
      {/each}

      {#if tool === 'lasso' && activePoints.length > 1}
        {#if lassoMode === 'freehand'}
          <path d={strokePath(activePoints, layout.scale)} fill="none" stroke="#9a63d6" stroke-dasharray="8 6" stroke-width="2.2"></path>
        {:else}
          <rect
            fill="rgba(154,99,214,0.08)"
            height={Math.abs(activePoints[activePoints.length - 1].y - activePoints[0].y) * layout.scale}
            stroke="#9a63d6"
            stroke-dasharray="8 6"
            stroke-width="2.2"
            width={Math.abs(activePoints[activePoints.length - 1].x - activePoints[0].x) * layout.scale}
            x={Math.min(activePoints[0].x, activePoints[activePoints.length - 1].x) * layout.scale}
            y={Math.min(activePoints[0].y, activePoints[activePoints.length - 1].y) * layout.scale}
          ></rect>
        {/if}
      {/if}

      {#if tool === 'laser' && laserPointerVisible && laserPointerMode === 'line' && laserPointerPath}
        <path d={laserPointerPath} fill="none" stroke="#ff5b5b" stroke-linecap="round" stroke-opacity="0.9" stroke-width="5"></path>
      {/if}
    </svg>

    <div
      bind:this={interactionLayer}
      aria-hidden="true"
      class:ink-active={inkSessionActive}
      class="annotation-layer"
      role="presentation"
      on:contextmenu|preventDefault
      on:dblclick={handleDoubleClick}
      on:pointercancel={handlePointerCancel}
      on:pointerdown={handlePointerDown}
      on:pointerleave={handlePointerLeave}
      on:lostpointercapture={handleLostPointerCapture}
      on:pointermove={handlePointerMove}
      on:pointerup={handlePointerUp}
    ></div>

    {#if tool === 'eraser' && eraserIndicatorPoint && eraserIndicatorVisible}
      <div class="eraser-indicator" style={eraserIndicatorStyle}></div>
    {/if}

    {#if tool === 'laser' && laserPointerVisible && laserPointerMode === 'dot'}
      <div class="eraser-indicator laser-pointer-dot" style={laserPointerStyle}></div>
    {/if}

    {#if tool === 'shape' && selectedShape}
      <div class="shape-handle" style={`left:${selectedShape.x * layout.scale - 7}px; top:${selectedShape.y * layout.scale - 7}px;`}></div>
      <div
        class="shape-handle"
        style={`left:${(selectedShape.x + selectedShape.width) * layout.scale - 7}px; top:${selectedShape.y * layout.scale - 7}px;`}
      ></div>
      <div
        class="shape-handle"
        style={`left:${selectedShape.x * layout.scale - 7}px; top:${(selectedShape.y + selectedShape.height) * layout.scale - 7}px;`}
      ></div>
      <div
        class="shape-handle"
        style={`left:${(selectedShape.x + selectedShape.width) * layout.scale - 7}px; top:${(selectedShape.y + selectedShape.height) * layout.scale - 7}px;`}
      ></div>
    {/if}
  </div>
</article>
