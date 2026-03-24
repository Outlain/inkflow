<script lang="ts">
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
    TextAnnotation
  } from '@shared/contracts';
  import { debugTimeline } from '../debug';
  import { createClientId } from '../id';
  import { cancelCanvasRender, renderPdfPage, measurePreviewLoad, type PdfRenderSegment } from '../pdf';
  import { getNetworkConfig, getConnectionQuality } from '../networkMonitor';
  import { scheduleRender, cancelRender } from '../renderScheduler';
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
  export let selectedAnnotationIds: string[] = [];
  export let onPenSessionChange: (active: boolean) => void = () => undefined;
  export let onAppend: (pageId: string, annotations: Annotation[]) => void = () => undefined;
  export let onReplace: (pageId: string, annotations: Annotation[]) => void = () => undefined;
  export let onSelectionChange: (pageId: string, annotationIds: string[]) => void = () => undefined;
  export let onPreviewAnnotationsChange: (pageId: string, annotations: PageAnnotation[] | null) => void = () => undefined;

  let canvas: HTMLCanvasElement | null = null;
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
  let eraserIndicatorPoint: PagePoint | null = null;
  let eraserIndicatorVisible = false;
  let eraserIndicatorStyle = '';
  let laserPointerVisible = false;
  let laserPointerStyle = '';
  let laserPointerPath = '';
  let localSelectedAnnotationIds: string[] = [];
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

  function templateClass(page: PageRecord): string {
    if (page.kind === 'pdf') return 'blank';
    return page.template ?? page.kind;
  }

  function scaledWidth(width: number): number {
    return width * layout.scale;
  }

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

    if (tool === 'lasso') {
      const nextSelection = selectAnnotationsFromPath(activePoints);
      localSelectedAnnotationIds = nextSelection;
      onSelectionChange(layout.page.id, nextSelection);
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
    return ['top', 'middle', 'bottom'];
  }

  function targetRenderSegments(): PdfRenderSegment[] {
    // Only render the segments actually in the viewport, even for the active page.
    // The active page gets ALL segments eventually via eager follow-up below, but
    // the initial render only covers what's visible so isReady fires faster.
    return visibleRenderSegments();
  }

  function segmentKey(scaleKey: string, segment: PdfRenderSegment): string {
    return `${scaleKey}:${segment}`;
  }

  function hasSegment(scaleKey: string, segment: PdfRenderSegment): boolean {
    return renderedSegments.has(segmentKey(scaleKey, segment));
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
    if (!canvas || !file || layout.page.kind !== 'pdf') {
      return;
    }

    const nextScaleKey = Number(layout.scale.toFixed(4)).toFixed(4);
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

    const segments = targetRenderSegments();
    const missingSegments = segments.filter((segment) => !hasSegment(nextScaleKey, segment));
    if (missingSegments.length === 0) {
      recomputeRenderReadiness(nextScaleKey);
      return;
    }

    if (!allowRender) {
      return;
    }

    const token = ++renderToken;
    isReady = false;
    fullQualityReady = false;
    debugTimeline.log('render-start', `Render page ${layout.pageIndex + 1} segments ${missingSegments.join(', ')} at scale ${nextScaleKey}`);

    try {
      for (const segment of missingSegments) {
        await renderPdfPage({
          canvas,
          page: layout.page,
          file,
          scale: layout.scale,
          segment
        });

        if (token !== renderToken) {
          return;
        }

        renderedSegments = new Set(renderedSegments).add(segmentKey(nextScaleKey, segment));
        recomputeRenderReadiness(nextScaleKey);
      }

      if (token === renderToken) {
        recomputeRenderReadiness(nextScaleKey);
        debugTimeline.log('render-end', `Rendered page ${layout.pageIndex + 1}`);

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
          if (token !== renderToken || !canvas || !file) break;
          try {
            await renderPdfPage({ canvas, page: layout.page, file, scale: layout.scale, segment });
            if (token !== renderToken) break;
            renderedSegments = new Set(renderedSegments).add(segmentKey(nextScaleKey, segment));
            recomputeRenderReadiness(nextScaleKey);
          } catch { break; }
        }
      }
    } catch (error) {
      if (token === renderToken && error instanceof Error && error.name !== 'RenderingCancelledException') {
        debugTimeline.log('render-end', `Render failed on page ${layout.pageIndex + 1}: ${error.message}`);
      }
    }
  }

  function handlePointerDown(event: PointerEvent): void {
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

      const hitAnnotation = findAnnotationAtPoint(point);
      if (hitAnnotation) {
        const nextSelection = localSelectedAnnotationIds.includes(hitAnnotation.id) ? [...localSelectedAnnotationIds] : [hitAnnotation.id];
        setSelectedAnnotationIds(nextSelection);
        beginMoveGesture(event, nextSelection, point);
        return;
      }

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
    if (activePointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    continueStroke(event);
    finishStroke();
    releaseCapturedPointer(event.pointerId);
  }

  function handlePointerCancel(event?: PointerEvent): void {
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
    if (activePointerId !== event.pointerId) {
      return;
    }

    if (activePoints.length > 0) {
      finishStroke();
      return;
    }

    clearPointerState();
  }

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

  function annotationFullyInsidePolygon(annotation: PageAnnotation, polygon: PagePoint[]): boolean {
    const polygonBounds = polygon.reduce(
      (bounds, point) => ({
        left: Math.min(bounds.left, point.x),
        right: Math.max(bounds.right, point.x),
        top: Math.min(bounds.top, point.y),
        bottom: Math.max(bounds.bottom, point.y)
      }),
      {
        left: Number.POSITIVE_INFINITY,
        right: Number.NEGATIVE_INFINITY,
        top: Number.POSITIVE_INFINITY,
        bottom: Number.NEGATIVE_INFINITY
      }
    );

    if (annotation.type === 'stroke') {
      if (annotation.points.length === 0) {
        return false;
      }

      const step = Math.max(1, Math.floor(annotation.points.length / 24));
      for (let index = 0; index < annotation.points.length; index += step) {
        const point = annotation.points[index];
        if (
          point.x < polygonBounds.left ||
          point.x > polygonBounds.right ||
          point.y < polygonBounds.top ||
          point.y > polygonBounds.bottom ||
          !pointInPolygon(point, polygon)
        ) {
          return false;
        }
      }

      const lastPoint = annotation.points[annotation.points.length - 1];
      return (
        lastPoint.x >= polygonBounds.left &&
        lastPoint.x <= polygonBounds.right &&
        lastPoint.y >= polygonBounds.top &&
        lastPoint.y <= polygonBounds.bottom &&
        pointInPolygon(lastPoint, polygon)
      );
    }

    const bounds = annotationBounds(annotation);
    const corners: PagePoint[] = [
      { x: bounds.left, y: bounds.top, pressure: 0, time: 0 },
      { x: bounds.right, y: bounds.top, pressure: 0, time: 0 },
      { x: bounds.right, y: bounds.bottom, pressure: 0, time: 0 },
      { x: bounds.left, y: bounds.bottom, pressure: 0, time: 0 },
      { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2, pressure: 0, time: 0 }
    ];

    return corners.every(
      (corner) =>
        corner.x >= polygonBounds.left &&
        corner.x <= polygonBounds.right &&
        corner.y >= polygonBounds.top &&
        corner.y <= polygonBounds.bottom &&
        pointInPolygon(corner, polygon)
    );
  }

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
          return annotationFullyInsidePolygon(annotation, polygon);
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
    if (canvas) {
      cancelCanvasRender(canvas);
    }
    setInkSession(false);
    renderToken += 1;
    if (previewDeferTimer) { clearTimeout(previewDeferTimer); previewDeferTimer = null; }
    debugTimeline.log('shell-unmounted', `Shell unmounted for page ${layout.pageIndex + 1}`);
  });

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
      if (canvas) {
        renderToken += 1;
        cancelCanvasRender(canvas);
      }
    } else if (allowRender && renderSuspended) {
      renderSuspended = false;
    }
  }

  $: renderIntentKey =
    layout.page.kind === 'pdf'
      ? `${Number(layout.scale.toFixed(4)).toFixed(4)}:${viewportTop}:${viewportHeight}:${isActive ? 'active' : 'passive'}:${allowRender ? 'go' : 'wait'}`
      : '';

  // All connection speeds get full-res PDF.js rendering. On slow/medium,
  // the per-page PDF endpoint provides a self-contained ~100-500KB file
  // that downloads in one request. No dwell delay needed.
  $: if (canvas && file && layout.page.kind === 'pdf' && renderIntentKey && allowRender) {
    scheduleRender(
      layout.page.id,
      layout.pageIndex,
      activePageIndex,
      () => renderPdfIfNeeded(),
      () => { renderToken++; }
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
    onSelectionChange(layout.page.id, []);
  }

  $: if (tool !== 'eraser' && eraserIndicatorVisible) {
    clearEraserIndicator();
  }

  $: previewWidth = Math.max(120, Math.min(Math.ceil(layout.width), getNetworkConfig().maxPreviewWidth));

  // On slow connections, skip preview images for pages far from the active page.
  // This prevents preview HTTP requests from consuming connection slots that the
  // active page's PDF.js range requests need.
  // slow = no previews (skeleton → canvas only), medium = active ± 2, fast = all
  $: showPreview = (() => {
    const config = getNetworkConfig();
    if (config.previewRadius === Infinity) return true;
    return Math.abs(layout.pageIndex - activePageIndex) <= config.previewRadius;
  })();

  // On slow/medium connections, defer preview src for non-active pages.
  // This gives the active page's preview and PDF first access to connection slots.
  // Active page gets src immediately; neighbors get it after 200ms.
  $: {
    const slow = getConnectionQuality() !== 'fast';
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
      {#if showPreview && !previewDeferred}
        <img
          alt=""
          aria-hidden="true"
          class:ready={fullQualityReady}
          class="reader-pdf-preview"
          decoding="async"
          fetchpriority={isActive ? 'high' : 'low'}
          loading={getConnectionQuality() === 'fast' ? 'eager' : 'lazy'}
          on:load={previewDidLoad}
          src={`/api/pages/${layout.page.id}/preview?width=${previewWidth}`}
        />
      {/if}
      <canvas bind:this={canvas} class:ready={isReady} class="reader-pdf-canvas"></canvas>
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
