<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type {
    Annotation,
    EditorTool,
    FileRecord,
    LineStyle,
    PagePoint,
    PageRecord,
    ShapeAnnotation,
    ShapeKind,
    TextAnnotation
  } from '@shared/contracts';
  import { debugTimeline } from '../debug';
  import { createClientId } from '../id';
  import { cancelCanvasRender, renderPdfPage, type PdfRenderSegment } from '../pdf';
  import type { PageShellLayout } from '../reader/layout';
  import { createStroke, eraseAnnotations, shapePath, strokePath } from '../annotations';
  import {
    DEFAULT_STROKE_PRESET_SETTINGS,
    resolvePresetValue,
    type EraserStrokeMode,
    type StrokePresetValues
  } from '../strokeSettings';

  export let layout: PageShellLayout;
  export let file: FileRecord | null = null;
  export let annotations: Annotation[] = [];
  export let tool: EditorTool = 'hand';
  export let color = '#123f63';
  export let sizePreset = 2;
  export let stylusOnly = true;
  export let isActive = false;
  export let shapeKind: ShapeKind = 'rectangle';
  export let shapeFill = false;
  export let shapeLineStyle: LineStyle = 'solid';
  export let allowRender = true;
  export let viewportTop = 0;
  export let viewportHeight = 0;
  export let penStrokeWidths: StrokePresetValues = [...DEFAULT_STROKE_PRESET_SETTINGS.pen] as StrokePresetValues;
  export let highlighterStrokeWidths: StrokePresetValues = [...DEFAULT_STROKE_PRESET_SETTINGS.highlighter] as StrokePresetValues;
  export let eraserStrokeWidths: StrokePresetValues = [...DEFAULT_STROKE_PRESET_SETTINGS.eraser] as StrokePresetValues;
  export let eraserStrokeMode: EraserStrokeMode = 'whole';
  export let onPenSessionChange: (active: boolean) => void = () => undefined;
  export let onAppend: (pageId: string, annotations: Annotation[]) => void = () => undefined;
  export let onReplace: (pageId: string, annotations: Annotation[]) => void = () => undefined;

  let canvas: HTMLCanvasElement | null = null;
  let interactionLayer: HTMLDivElement | null = null;
  let renderToken = 0;
  let renderedScaleKey = '';
  let renderedSegments = new Set<string>();
  let isReady = layout.page.kind !== 'pdf';
  let fullQualityReady = layout.page.kind !== 'pdf';
  let previewLoaded = layout.page.kind !== 'pdf';
  let previewLoadedPageId = layout.page.kind === 'pdf' ? '' : layout.page.id;
  let activePointerId: number | null = null;
  let activePoints: PagePoint[] = [];
  let previewAnnotations: Annotation[] | null = null;
  let selectedShapeId = '';
  let selectedShape: ShapeAnnotation | null = null;
  let renderSuspended = false;
  let inkSessionActive = false;
  let previewWidth = 0;
  let renderIntentKey = '';
  let eraserIndicatorPoint: PagePoint | null = null;
  let eraserIndicatorVisible = false;
  let eraserIndicatorStyle = '';
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
    return resolvePresetValue(tool === 'highlighter' ? highlighterStrokeWidths : penStrokeWidths, sizePreset);
  }

  function currentEraserRadius(): number {
    return resolvePresetValue(eraserStrokeWidths, sizePreset);
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
    if (activePoints.length === 0) {
      activePointerId = null;
      previewAnnotations = null;
      clearEraserIndicator();
      setInkSession(false);
      return;
    }

    if (tool === 'pen' || tool === 'highlighter') {
      const stroke = createStroke({
        id: createClientId(),
        tool,
        color,
        width: currentStrokeWidth(),
        points: activePoints
      });
      onAppend(layout.page.id, [stroke]);
    }

    if (tool === 'eraser') {
      const nextAnnotations = eraseAnnotations(annotations, activePoints, currentEraserRadius(), { strokeMode: eraserStrokeMode });
      onReplace(layout.page.id, nextAnnotations);
    }

    if (tool === 'shape' && shapeGesture) {
      if (previewAnnotations) {
        onReplace(layout.page.id, previewAnnotations);
      }
      selectedShapeId = shapeGesture.shapeId;
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
    shapeGesture = null;
    clearEraserIndicator();
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

  function handlePointerLeave(): void {
    if (activePointerId === null) {
      clearEraserIndicator();
    }
  }

  function visibleRenderSegments(): PdfRenderSegment[] {
    const midpoint = layout.height / 2;
    const pageTop = layout.top;
    const pageBottom = layout.top + layout.height;
    const visibleTop = Math.max(viewportTop, pageTop) - pageTop;
    const visibleBottom = Math.min(viewportTop + viewportHeight, pageBottom) - pageTop;
    const segments: PdfRenderSegment[] = [];

    if (visibleBottom <= 0 || visibleTop >= layout.height) {
      return ['top'];
    }

    if (visibleTop < midpoint) {
      segments.push('top');
    }

    if (visibleBottom > midpoint) {
      segments.push('bottom');
    }

    return segments.length > 0 ? segments : ['top'];
  }

  function fullRenderSegments(): PdfRenderSegment[] {
    return ['top', 'bottom'];
  }

  function targetRenderSegments(): PdfRenderSegment[] {
    return isActive ? fullRenderSegments() : visibleRenderSegments();
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
  }

  function previewDidLoad(): void {
    previewLoaded = true;
    previewLoadedPageId = layout.page.id;
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
      isReady = false;
      fullQualityReady = false;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
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

    beginStroke(event);
  }

  function handlePointerMove(event: PointerEvent): void {
    updateEraserIndicator(event);

    if (activePointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    continueStroke(event);

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

    if (tool === 'pen' || tool === 'highlighter') {
      previewAnnotations = [
        ...annotations,
        createStroke({
          id: 'preview-stroke',
          tool,
          color,
          width: currentStrokeWidth(),
          points: activePoints
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

    if (tool === 'pen' || tool === 'highlighter') {
      previewAnnotations = [
        ...annotations,
        createStroke({
          id: 'preview-stroke',
          tool,
          color,
          width: currentStrokeWidth(),
          points: activePoints
        })
      ];
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
      fontSize: 24
    };

    onReplace(layout.page.id, [...annotations, annotation]);
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

  function updateShapePreview(point: PagePoint): Annotation[] {
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
    debugTimeline.log('shell-unmounted', `Shell unmounted for page ${layout.pageIndex + 1}`);
  });

  $: displayAnnotations = previewAnnotations ?? annotations;
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

  $: if (canvas && file && layout.page.kind === 'pdf' && renderIntentKey && allowRender) {
    void renderPdfIfNeeded();
  }

  $: if (tool === 'hand' && inkSessionActive) {
    setInkSession(false);
  }

  $: if (tool !== 'eraser' && eraserIndicatorVisible) {
    clearEraserIndicator();
  }

  $: previewWidth = Math.max(320, Math.min(Math.ceil(layout.width), 960));
  $: if (layout.page.kind === 'pdf' && previewLoadedPageId !== layout.page.id) {
    previewLoaded = false;
  }

  $: eraserIndicatorStyle =
    eraserIndicatorPoint && eraserIndicatorVisible
      ? `width:${currentEraserRadius() * 2 * layout.scale}px; height:${currentEraserRadius() * 2 * layout.scale}px; left:${eraserIndicatorPoint.x * layout.scale - currentEraserRadius() * layout.scale}px; top:${eraserIndicatorPoint.y * layout.scale - currentEraserRadius() * layout.scale}px;`
      : '';
</script>

<article
  class:active={isActive}
  class="reader-page-shell"
  style={`top:${layout.top}px; left:${layout.left}px; width:${layout.width}px; height:${layout.height}px;`}
>
  <div class="reader-page-paper">
    {#if layout.page.kind === 'pdf'}
      {#if !previewLoaded && !isReady}
        <div class="reader-page-skeleton"></div>
      {/if}
      <img
        alt=""
        aria-hidden="true"
        class:ready={fullQualityReady}
        class="reader-pdf-preview"
        decoding="async"
        loading="eager"
        on:load={previewDidLoad}
        src={`/api/pages/${layout.page.id}/preview?width=${previewWidth}`}
      />
      <canvas bind:this={canvas} class:ready={isReady} class="reader-pdf-canvas"></canvas>
    {:else}
      <div class={`reader-template-layer ${templateClass(layout.page)}`}></div>
    {/if}

    <svg class="annotation-svg" viewBox={`0 0 ${layout.width} ${layout.height}`}>
      {#each displayAnnotations as annotation (annotation.id)}
        {#if annotation.type === 'stroke'}
          <path
            d={strokePath(annotation.points, layout.scale)}
            fill="none"
            stroke={annotation.color}
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-opacity={annotation.tool === 'highlighter' ? 0.33 : 1}
            stroke-width={scaledWidth(annotation.width)}
          ></path>
        {:else if annotation.type === 'text'}
          <text
            fill={annotation.color}
            font-size={annotation.fontSize * layout.scale}
            x={annotation.x * layout.scale}
            y={(annotation.y + annotation.fontSize) * layout.scale}
          >
            {annotation.text}
          </text>
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
    </svg>

    <div
      bind:this={interactionLayer}
      aria-hidden="true"
      class:ink-active={inkSessionActive}
      class="annotation-layer"
      role="presentation"
      on:contextmenu|preventDefault
      on:dblclick={tool === 'text' ? addText : undefined}
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
