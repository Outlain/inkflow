import { readFile } from 'node:fs/promises';
import type {
  Annotation,
  PageAnnotation,
  PageRecord,
  ShapeAnnotation,
  StickyNoteAnnotation,
  StrokeAnnotation,
  TextAnnotation
} from '../../../shared/src/contracts.js';
import { config } from '../config.js';
import { getUploadPath } from '../lib/fs.js';
import { ensurePdfPreviewImage } from './pdfTools.js';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function lineDash(shape: ShapeAnnotation): string {
  if (shape.lineStyle === 'dashed') {
    return ' stroke-dasharray="8 6"';
  }

  if (shape.lineStyle === 'dotted') {
    return ' stroke-dasharray="2 4"';
  }

  return '';
}

function strokePath(points: StrokeAnnotation['points']): string {
  if (points.length === 0) {
    return '';
  }

  const [first, ...rest] = points;
  return [`M ${first.x} ${first.y}`, ...rest.map((point) => `L ${point.x} ${point.y}`)].join(' ');
}

function shapePath(shape: ShapeAnnotation): string {
  if (shape.shape === 'triangle') {
    return `M ${shape.x + shape.width / 2} ${shape.y} L ${shape.x + shape.width} ${shape.y + shape.height} L ${shape.x} ${shape.y + shape.height} Z`;
  }

  return `M ${shape.x + shape.width / 2} ${shape.y} L ${shape.x + shape.width} ${shape.y + shape.height / 2} L ${shape.x + shape.width / 2} ${shape.y + shape.height} L ${shape.x} ${shape.y + shape.height / 2} Z`;
}

function templateMarkup(page: PageRecord): string {
  if (page.kind === 'pdf') {
    return '';
  }

  if (page.template === 'ruled' || page.kind === 'ruled') {
    const lines: string[] = [];
    for (let y = 32; y < page.height; y += 32) {
      lines.push(`<line x1="28" y1="${y}" x2="${page.width - 28}" y2="${y}" stroke="rgba(186,209,232,0.9)" stroke-width="0.8" />`);
    }
    return `<rect width="${page.width}" height="${page.height}" fill="#fffdfa" />${lines.join('')}`;
  }

  if (page.template === 'grid' || page.kind === 'grid') {
    const lines: string[] = ['<rect width="100%" height="100%" fill="#fffdfa" />'];
    for (let x = 28; x < page.width; x += 28) {
      lines.push(`<line x1="${x}" y1="24" x2="${x}" y2="${page.height - 24}" stroke="rgba(194,214,235,0.75)" stroke-width="0.4" />`);
    }
    for (let y = 28; y < page.height; y += 28) {
      lines.push(`<line x1="24" y1="${y}" x2="${page.width - 24}" y2="${y}" stroke="rgba(194,214,235,0.75)" stroke-width="0.4" />`);
    }
    return lines.join('');
  }

  if (page.template === 'dot' || page.kind === 'dot') {
    const dots: string[] = ['<rect width="100%" height="100%" fill="#fffdfa" />'];
    for (let x = 24; x < page.width; x += 22) {
      for (let y = 24; y < page.height; y += 22) {
        dots.push(`<circle cx="${x}" cy="${y}" r="0.8" fill="rgba(194,214,235,0.9)" />`);
      }
    }
    return dots.join('');
  }

  return `<rect width="${page.width}" height="${page.height}" fill="#fffdfa" />`;
}

function renderStroke(annotation: StrokeAnnotation): string {
  const opacity = annotation.tool === 'highlighter' ? 0.3 : annotation.tool === 'pencil' ? 0.72 : 1;
  return `<path d="${strokePath(annotation.points)}" fill="none" stroke="${annotation.color}" stroke-linecap="round" stroke-linejoin="round" stroke-opacity="${opacity}" stroke-width="${Math.max(annotation.width, annotation.tool === 'highlighter' ? 1.5 : 1)}" />`;
}

function renderText(annotation: TextAnnotation): string {
  return `<text x="${annotation.x}" y="${annotation.y + annotation.fontSize}" fill="${annotation.color}" font-size="${annotation.fontSize}" font-family="Georgia, 'Times New Roman', serif">${escapeXml(annotation.text)}</text>`;
}

function renderSticky(annotation: StickyNoteAnnotation): string {
  return [
    `<rect x="${annotation.x}" y="${annotation.y}" width="${annotation.width}" height="${annotation.height}" rx="14" ry="14" fill="${annotation.noteColor}" fill-opacity="0.92" stroke="rgba(42,42,42,0.18)" stroke-width="1" />`,
    `<text x="${annotation.x + 12}" y="${annotation.y + annotation.fontSize + 10}" fill="${annotation.color}" font-size="${annotation.fontSize}" font-family="Georgia, 'Times New Roman', serif">${escapeXml(annotation.text)}</text>`
  ].join('');
}

function renderShape(annotation: ShapeAnnotation): string {
  const fill = annotation.fill ? ` fill="${annotation.color}" fill-opacity="0.16"` : ' fill="transparent"';
  const stroke = ` stroke="${annotation.color}" stroke-width="${Math.max(annotation.strokeWidth, 1)}"${lineDash(annotation)}`;

  if (annotation.shape === 'ellipse') {
    return `<ellipse cx="${annotation.x + annotation.width / 2}" cy="${annotation.y + annotation.height / 2}" rx="${annotation.width / 2}" ry="${annotation.height / 2}"${fill}${stroke} />`;
  }

  if (annotation.shape === 'rectangle') {
    return `<rect x="${annotation.x}" y="${annotation.y}" width="${annotation.width}" height="${annotation.height}"${fill}${stroke} />`;
  }

  return `<path d="${shapePath(annotation)}"${fill}${stroke} />`;
}

function annotationMarkup(annotations: PageAnnotation[]): string {
  return annotations
    .map((annotation) => {
      if (annotation.type === 'stroke') {
        return renderStroke(annotation);
      }

      if (annotation.type === 'text') {
        return renderText(annotation);
      }

      if (annotation.type === 'sticky') {
        return renderSticky(annotation);
      }

      return renderShape(annotation);
    })
    .join('');
}

export async function renderAnnotatedThumbnailSvg(params: {
  page: PageRecord;
  annotations: PageAnnotation[];
  previewWidth: number;
  pdfSource?: { storageKey: string; sourcePageIndex: number } | null;
}): Promise<string> {
  const { page, annotations, previewWidth, pdfSource } = params;
  let backgroundMarkup = templateMarkup(page);

  if (page.kind === 'pdf' && pdfSource) {
    const filePath = getUploadPath(config.dataDir, pdfSource.storageKey);
    const previewPath = await ensurePdfPreviewImage(pdfSource.storageKey, filePath, pdfSource.sourcePageIndex + 1, previewWidth);
    const bytes = await readFile(previewPath);
    const dataUrl = `data:image/jpeg;base64,${bytes.toString('base64')}`;
    backgroundMarkup = `<image href="${dataUrl}" x="0" y="0" width="${page.width}" height="${page.height}" preserveAspectRatio="none" />`;
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${page.width}" height="${page.height}" viewBox="0 0 ${page.width} ${page.height}">`,
    backgroundMarkup,
    annotationMarkup(annotations),
    '</svg>'
  ].join('');
}
