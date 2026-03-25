<script context="module" lang="ts">
  // Shared across all ThumbnailPreview instances so remounts don't cause re-fetches
  const imageCache = new Map<string, Promise<HTMLImageElement>>();
</script>

<script lang="ts">
  // Renders a single-page thumbnail — either a server-side JPEG or a client-drawn
  // canvas with template background and annotations. Used in the sidebar nav strip.
  import { onMount } from 'svelte';
  import type { DocumentBundle, PageAnnotation, ShapeAnnotation, StrokeAnnotation } from '@shared/contracts';
  import { shapePath, strokePath } from '../annotations';

  export let page: DocumentBundle['pages'][number];
  export let annotations: PageAnnotation[] = [];
  export let useClient = false;
  export let previewSrc = '';
  export let serverSrc = '';
  export let alt = '';

  let canvas: HTMLCanvasElement | null = null;
  let renderToken = 0;

  function loadImage(src: string): Promise<HTMLImageElement> {
    const cached = imageCache.get(src);
    if (cached) {
      return cached;
    }

    const promise = new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`Failed to load image: ${src}`));
      image.src = src;
    });

    imageCache.set(src, promise);
    return promise;
  }

  function strokeOpacity(annotation: StrokeAnnotation): number {
    if (annotation.tool === 'highlighter') {
      return 0.3;
    }

    if (annotation.tool === 'pencil') {
      return 0.72;
    }

    return 1;
  }

  function averagePressure(points: StrokeAnnotation['points']): number {
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

  function lineDash(annotation: ShapeAnnotation): number[] {
    if (annotation.lineStyle === 'dashed') {
      return [8, 6];
    }

    if (annotation.lineStyle === 'dotted') {
      return [2, 4];
    }

    return [];
  }

  function drawTemplate(context: CanvasRenderingContext2D): void {
    context.fillStyle = '#fffdfa';
    context.fillRect(0, 0, page.width, page.height);

    if (page.template === 'ruled' || page.kind === 'ruled') {
      context.strokeStyle = 'rgba(186,209,232,0.9)';
      context.lineWidth = 0.8;
      for (let y = 32; y < page.height; y += 32) {
        context.beginPath();
        context.moveTo(28, y);
        context.lineTo(page.width - 28, y);
        context.stroke();
      }
      return;
    }

    if (page.template === 'grid' || page.kind === 'grid') {
      context.strokeStyle = 'rgba(194,214,235,0.75)';
      context.lineWidth = 0.4;
      for (let x = 28; x < page.width; x += 28) {
        context.beginPath();
        context.moveTo(x, 24);
        context.lineTo(x, page.height - 24);
        context.stroke();
      }
      for (let y = 28; y < page.height; y += 28) {
        context.beginPath();
        context.moveTo(24, y);
        context.lineTo(page.width - 24, y);
        context.stroke();
      }
      return;
    }

    if (page.template === 'dot' || page.kind === 'dot') {
      context.fillStyle = 'rgba(194,214,235,0.9)';
      for (let x = 24; x < page.width; x += 22) {
        for (let y = 24; y < page.height; y += 22) {
          context.beginPath();
          context.arc(x, y, 0.8, 0, Math.PI * 2);
          context.fill();
        }
      }
    }
  }

  function drawShapePath(context: CanvasRenderingContext2D, annotation: ShapeAnnotation): void {
    if (annotation.shape === 'ellipse') {
      context.beginPath();
      context.ellipse(
        annotation.x + annotation.width / 2,
        annotation.y + annotation.height / 2,
        Math.abs(annotation.width / 2),
        Math.abs(annotation.height / 2),
        0,
        0,
        Math.PI * 2
      );
      return;
    }

    if (annotation.shape === 'rectangle') {
      context.beginPath();
      context.rect(annotation.x, annotation.y, annotation.width, annotation.height);
      return;
    }

    const path = new Path2D(shapePath(annotation, 1));
    context.beginPath();
    context.stroke(path);
    if (annotation.fill) {
      context.globalAlpha = 0.16;
      context.fill(path);
      context.globalAlpha = 1;
    }
  }

  function drawAnnotations(context: CanvasRenderingContext2D): void {
    context.textBaseline = 'alphabetic';
    context.lineCap = 'round';
    context.lineJoin = 'round';

    for (const annotation of annotations) {
      if (annotation.type === 'stroke') {
        const path = new Path2D(strokePath(annotation.points, 1));

        if (annotation.tool === 'pencil') {
          for (const layer of pencilStrokeLayers(annotation)) {
            context.save();
            context.strokeStyle = annotation.color;
            context.globalAlpha = layer.opacity;
            context.lineWidth = annotation.width * layer.multiplier;
            context.stroke(path);
            context.restore();
          }
          continue;
        }

        context.save();
        context.strokeStyle = annotation.color;
        context.globalAlpha = strokeOpacity(annotation);
        context.lineWidth = annotation.width;
        context.stroke(path);
        context.restore();
        continue;
      }

      if (annotation.type === 'text') {
        context.save();
        context.fillStyle = annotation.color;
        context.font = `${annotation.fontSize}px Georgia, "Times New Roman", serif`;
        context.fillText(annotation.text, annotation.x, annotation.y + annotation.fontSize);
        context.restore();
        continue;
      }

      if (annotation.type === 'sticky') {
        context.save();
        context.fillStyle = annotation.noteColor;
        context.strokeStyle = 'rgba(42,42,42,0.18)';
        context.lineWidth = 1;
        context.beginPath();
        context.roundRect(annotation.x, annotation.y, annotation.width, annotation.height, 14);
        context.fill();
        context.stroke();
        context.fillStyle = annotation.color;
        context.font = `${annotation.fontSize}px Georgia, "Times New Roman", serif`;
        context.fillText(annotation.text, annotation.x + 12, annotation.y + annotation.fontSize + 10);
        context.restore();
        continue;
      }

      context.save();
      context.strokeStyle = annotation.color;
      context.fillStyle = annotation.color;
      context.lineWidth = Math.max(annotation.strokeWidth, 1);
      context.setLineDash(lineDash(annotation));
      if (annotation.shape === 'ellipse') {
        context.beginPath();
        context.ellipse(
          annotation.x + annotation.width / 2,
          annotation.y + annotation.height / 2,
          Math.abs(annotation.width / 2),
          Math.abs(annotation.height / 2),
          0,
          0,
          Math.PI * 2
        );
        if (annotation.fill) {
          context.globalAlpha = 0.16;
          context.fill();
          context.globalAlpha = 1;
        }
        context.stroke();
      } else if (annotation.shape === 'rectangle') {
        context.beginPath();
        context.rect(annotation.x, annotation.y, annotation.width, annotation.height);
        if (annotation.fill) {
          context.globalAlpha = 0.16;
          context.fill();
          context.globalAlpha = 1;
        }
        context.stroke();
      } else {
        const path = new Path2D(shapePath(annotation, 1));
        if (annotation.fill) {
          context.globalAlpha = 0.16;
          context.fill(path);
          context.globalAlpha = 1;
        }
        context.stroke(path);
      }
      context.restore();
    }
  }

  async function redrawClientThumbnail(): Promise<void> {
    if (!canvas || !useClient) {
      return;
    }

    const token = ++renderToken;
    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }

    canvas.width = Math.max(1, Math.round(page.width));
    canvas.height = Math.max(1, Math.round(page.height));

    context.clearRect(0, 0, canvas.width, canvas.height);

    if (page.kind === 'pdf') {
      try {
        const image = await loadImage(previewSrc);
        if (token !== renderToken || !canvas) {
          return;
        }
        context.drawImage(image, 0, 0, page.width, page.height);
      } catch {
        context.fillStyle = '#fffdfa';
        context.fillRect(0, 0, page.width, page.height);
      }
    } else {
      drawTemplate(context);
    }

    drawAnnotations(context);
  }

  onMount(() => {
    void redrawClientThumbnail();
  });

  // Redraw whenever annotations, previewSrc, useClient, or canvas changes.
  // Explicitly referencing `annotations` and `previewSrc` makes Svelte track them as
  // reactive dependencies — without this, Svelte only sees `useClient` and `canvas`
  // and never redraws when new annotation data is passed in.
  $: if (useClient && canvas) {
    void (annotations, previewSrc, redrawClientThumbnail());
  }
</script>

{#if useClient}
  <canvas bind:this={canvas} aria-label={alt} class="thumbnail-preview-canvas"></canvas>
{:else}
  <img class="thumbnail-preview-image" alt={alt} loading="lazy" src={serverSrc} />
{/if}
