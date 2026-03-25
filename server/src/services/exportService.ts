/**
 * Annotated PDF export — rebuilds a complete PDF with annotations rendered
 * directly onto each page using pdf-lib. Supports strokes, text, shapes,
 * and notebook templates (ruled, grid, dot).
 */

import { readFile } from 'node:fs/promises';
import { PDFDocument, degrees, rgb, StandardFonts } from 'pdf-lib';
import type { Annotation, ShapeAnnotation, StrokeAnnotation, TapeAnnotation, TextAnnotation } from '../../../shared/src/contracts.js';
import { config } from '../config.js';
import { getUploadPath } from '../lib/fs.js';
import { getDocumentBundle, getPageAnnotations } from './libraryService.js';

// ── Helpers ──

function sanitizeFilename(value: string): string {
  return value.replace(/[^\w.-]+/g, ' ').trim() || 'inkflow-export';
}

function hexToRgb(value: string): ReturnType<typeof rgb> {
  const normalized = value.replace('#', '');
  const hex = normalized.length === 3 ? normalized.split('').map((char) => `${char}${char}`).join('') : normalized;
  const red = Number.parseInt(hex.slice(0, 2), 16) / 255;
  const green = Number.parseInt(hex.slice(2, 4), 16) / 255;
  const blue = Number.parseInt(hex.slice(4, 6), 16) / 255;
  return rgb(red || 0, green || 0, blue || 0);
}

function lineDash(shape: ShapeAnnotation): number[] | undefined {
  if (shape.lineStyle === 'dashed') {
    return [8, 6];
  }

  if (shape.lineStyle === 'dotted') {
    return [2, 4];
  }

  return undefined;
}

// ── Template rendering (blank notebook backgrounds) ──

/** Draws ruled/grid/dot template lines onto a blank notebook page. */
function drawTemplate(page: import('pdf-lib').PDFPage, template: string | null): void {
  const width = page.getWidth();
  const height = page.getHeight();

  if (template === 'ruled') {
    for (let y = 32; y < height; y += 32) {
      page.drawLine({
        start: { x: 28, y: height - y },
        end: { x: width - 28, y: height - y },
        thickness: 0.8,
        color: rgb(0.73, 0.82, 0.91),
        opacity: 0.7
      });
    }
    return;
  }

  if (template === 'grid') {
    for (let x = 28; x < width; x += 28) {
      page.drawLine({
        start: { x, y: 24 },
        end: { x, y: height - 24 },
        thickness: 0.4,
        color: rgb(0.76, 0.84, 0.92),
        opacity: 0.55
      });
    }
    for (let y = 28; y < height; y += 28) {
      page.drawLine({
        start: { x: 24, y: height - y },
        end: { x: width - 24, y: height - y },
        thickness: 0.4,
        color: rgb(0.76, 0.84, 0.92),
        opacity: 0.55
      });
    }
    return;
  }

  if (template === 'dot') {
    for (let x = 24; x < width; x += 22) {
      for (let y = 24; y < height; y += 22) {
        page.drawCircle({
          x,
          y: height - y,
          size: 0.8,
          color: rgb(0.76, 0.84, 0.92),
          opacity: 0.65
        });
      }
    }
  }
}

// ── Annotation rendering ──

function drawStroke(page: import('pdf-lib').PDFPage, annotation: StrokeAnnotation): void {
  const color = hexToRgb(annotation.color);
  const opacity = annotation.tool === 'highlighter' ? 0.24 : 1;

  if (annotation.points.length === 1) {
    const point = annotation.points[0];
    page.drawCircle({
      x: point.x,
      y: page.getHeight() - point.y,
      size: annotation.width / 2,
      color,
      opacity
    });
    return;
  }

  for (let index = 1; index < annotation.points.length; index += 1) {
    const previous = annotation.points[index - 1];
    const current = annotation.points[index];
    page.drawLine({
      start: { x: previous.x, y: page.getHeight() - previous.y },
      end: { x: current.x, y: page.getHeight() - current.y },
      thickness: annotation.width,
      color,
      opacity
    });
  }
}

function drawTextAnnotation(page: import('pdf-lib').PDFPage, annotation: TextAnnotation, font: import('pdf-lib').PDFFont): void {
  page.drawText(annotation.text, {
    x: annotation.x,
    y: page.getHeight() - annotation.y - annotation.fontSize,
    size: annotation.fontSize,
    font,
    color: hexToRgb(annotation.color)
  });
}

function drawShape(page: import('pdf-lib').PDFPage, annotation: ShapeAnnotation): void {
  const color = hexToRgb(annotation.color);
  // pdf-lib uses bottom-left origin; convert from top-left
  const y = page.getHeight() - annotation.y - annotation.height;
  const fillColor = annotation.fill ? color : undefined;
  const borderDash = lineDash(annotation);

  if (annotation.shape === 'rectangle') {
    page.drawRectangle({
      x: annotation.x,
      y,
      width: annotation.width,
      height: annotation.height,
      borderColor: color,
      borderWidth: annotation.strokeWidth,
      color: fillColor,
      opacity: annotation.fill ? 0.15 : 1,
      borderDashArray: borderDash
    });
    return;
  }

  if (annotation.shape === 'ellipse') {
    page.drawEllipse({
      x: annotation.x + annotation.width / 2,
      y: y + annotation.height / 2,
      xScale: annotation.width / 2,
      yScale: annotation.height / 2,
      borderColor: color,
      borderWidth: annotation.strokeWidth,
      color: fillColor,
      opacity: annotation.fill ? 0.15 : 1,
      borderDashArray: borderDash
    });
    return;
  }

  // Triangle and diamond are rendered as SVG paths
  const path =
    annotation.shape === 'triangle'
      ? `M ${annotation.x + annotation.width / 2} ${page.getHeight() - annotation.y}
         L ${annotation.x + annotation.width} ${page.getHeight() - annotation.y - annotation.height}
         L ${annotation.x} ${page.getHeight() - annotation.y - annotation.height} Z`
      : `M ${annotation.x + annotation.width / 2} ${page.getHeight() - annotation.y}
         L ${annotation.x + annotation.width} ${page.getHeight() - annotation.y - annotation.height / 2}
         L ${annotation.x + annotation.width / 2} ${page.getHeight() - annotation.y - annotation.height}
         L ${annotation.x} ${page.getHeight() - annotation.y - annotation.height / 2} Z`;

  page.drawSvgPath(path.replace(/\s+/g, ' '), {
    borderColor: color,
    borderWidth: annotation.strokeWidth,
    color: fillColor,
    opacity: annotation.fill ? 0.15 : 1,
    borderDashArray: borderDash
  });
}

/** Draws a tape strip as a semi-transparent rotated rectangle on the PDF page */
function drawTape(page: import('pdf-lib').PDFPage, annotation: TapeAnnotation): void {
  const pageHeight = page.getHeight();
  const dx = annotation.x2 - annotation.x1;
  const dy = annotation.y2 - annotation.y1;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length < 0.5) return;

  const hex = annotation.color.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16) / 255;
  const g = parseInt(hex.substring(2, 4), 16) / 255;
  const b = parseInt(hex.substring(4, 6), 16) / 255;

  // Center of the tape strip, with Y flipped for PDF coordinate system
  const cx = (annotation.x1 + annotation.x2) / 2;
  const cy = (annotation.y1 + annotation.y2) / 2;
  const angle = Math.atan2(dy, dx);

  page.drawRectangle({
    x: cx,
    y: pageHeight - cy,
    width: length,
    height: annotation.tapeWidth,
    color: rgb(r, g, b),
    opacity: annotation.opacity,
    rotate: degrees((-angle * 180) / Math.PI),
    borderWidth: 0
  });
}

function drawAnnotations(page: import('pdf-lib').PDFPage, annotations: Annotation[], font: import('pdf-lib').PDFFont): void {
  for (const annotation of annotations) {
    if (annotation.type === 'stroke') {
      drawStroke(page, annotation);
      continue;
    }

    if (annotation.type === 'text') {
      drawTextAnnotation(page, annotation, font);
      continue;
    }

    if (annotation.type === 'tape') {
      drawTape(page, annotation);
      continue;
    }

    drawShape(page, annotation);
  }
}

// ── Export entry point ──

export async function exportDocumentPdf(documentId: string): Promise<{ bytes: Uint8Array; filename: string }> {
  const bundle = getDocumentBundle(documentId);
  const output = await PDFDocument.create();
  const font = await output.embedFont(StandardFonts.Helvetica);
  const sourceCache = new Map<string, PDFDocument>();

  for (const page of bundle.pages) {
    let targetPage: import('pdf-lib').PDFPage;

    if (page.kind === 'pdf' && page.sourceFileId) {
      let sourceDocument = sourceCache.get(page.sourceFileId);
      if (!sourceDocument) {
        const file = bundle.files.find((entry) => entry.id === page.sourceFileId);
        if (!file) {
          throw new Error('Source PDF file is missing for export.');
        }

        const bytes = await readFile(getUploadPath(config.dataDir, file.storageKey));
        sourceDocument = await PDFDocument.load(bytes);
        sourceCache.set(page.sourceFileId, sourceDocument);
      }

      const [copiedPage] = await output.copyPages(sourceDocument, [page.sourcePageIndex ?? 0]);
      output.addPage(copiedPage);
      targetPage = output.getPage(output.getPageCount() - 1);
    } else {
      targetPage = output.addPage([page.width, page.height]);
      drawTemplate(targetPage, page.template ?? page.kind);
    }

    const pageAnnotations = getPageAnnotations(page.id);
    drawAnnotations(targetPage, pageAnnotations.annotations, font);
  }

  return {
    bytes: await output.save(),
    filename: `${sanitizeFilename(bundle.document.title)}.pdf`
  };
}
