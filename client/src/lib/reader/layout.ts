/**
 * Page layout engine — computes absolute positions for every page shell based
 * on stored page dimensions, viewport width, and zoom level. Also provides
 * binary-search-based visible window calculation and active page detection.
 */

import type { PageRecord } from '@shared/contracts';

export interface PageShellLayout {
  page: PageRecord;
  pageIndex: number;
  top: number;
  left: number;
  width: number;
  height: number;
  scale: number;
}

export interface ReaderLayoutResult {
  containerHeight: number;
  containerWidth: number;
  pages: PageShellLayout[];
}

export interface VisibleWindow {
  start: number;
  end: number;
}

export interface PageVisibilityMetrics {
  visiblePixels: number;
  visibleRatio: number;
}

export function getPageVisibilityMetrics(
  page: Pick<PageShellLayout, 'top' | 'height'>,
  scrollTop: number,
  viewportHeight: number
): PageVisibilityMetrics {
  if (viewportHeight <= 0 || page.height <= 0) {
    return { visiblePixels: 0, visibleRatio: 0 };
  }

  const viewportBottom = scrollTop + viewportHeight;
  const pageBottom = page.top + page.height;
  const visiblePixels = Math.max(0, Math.min(pageBottom, viewportBottom) - Math.max(page.top, scrollTop));
  return {
    visiblePixels,
    visibleRatio: Math.min(1, visiblePixels / page.height)
  };
}

/** Responsive padding tiers: compact (phones), medium (tablets), desktop. */
function resolveLayoutPadding(viewportWidth: number): {
  topPadding: number;
  bottomPadding: number;
  pageGap: number;
  horizontalPadding: number;
} {
  if (viewportWidth <= 720) {
    return { topPadding: 4, bottomPadding: 8, pageGap: 6, horizontalPadding: 0 };
  }
  if (viewportWidth <= 1080) {
    return { topPadding: 16, bottomPadding: 32, pageGap: 20, horizontalPadding: 10 };
  }
  return { topPadding: 24, bottomPadding: 48, pageGap: 28, horizontalPadding: 20 };
}

export class ReaderLayoutEngine {
  /** Compute absolute top/left/width/height and scale for every page. */
  build(pages: PageRecord[], viewportWidth: number, zoom: number): ReaderLayoutResult {
    const pad = resolveLayoutPadding(viewportWidth);
    const usableWidth = Math.max(320, viewportWidth - pad.horizontalPadding * 2);
    let top = pad.topPadding;
    let maxRight = viewportWidth;

    const layouts = pages.map((page, pageIndex) => {
      const scale = (usableWidth / Math.max(page.width, 1)) * zoom;
      const width = Math.max(1, page.width * scale);
      const height = Math.max(1, page.height * scale);
      const left = Math.max((viewportWidth - width) / 2, 0);
      maxRight = Math.max(maxRight, left + width);
      const layout: PageShellLayout = {
        page,
        pageIndex,
        top,
        left,
        width,
        height,
        scale
      };
      top += height + pad.pageGap;
      return layout;
    });

    return {
      containerHeight: top - pad.pageGap + pad.bottomPadding,
      containerWidth: Math.ceil(maxRight),
      pages: layouts
    };
  }

  /** Return the index range of pages that overlap the visible scroll area (plus overscan). */
  getVisibleWindow(layout: ReaderLayoutResult, scrollTop: number, viewportHeight: number, overscan = 1): VisibleWindow {
    if (layout.pages.length === 0) {
      return { start: 0, end: -1 };
    }

    const topEdge = Math.max(0, scrollTop);
    const bottomEdge = scrollTop + viewportHeight;
    let start = this.findFirstPage(layout.pages, topEdge);
    let end = this.findLastPage(layout.pages, bottomEdge);
    start = Math.max(0, start - overscan);
    end = Math.min(layout.pages.length - 1, end + overscan);
    return { start, end };
  }

  /** The page whose center is closest to the viewport center. */
  getActivePage(layout: ReaderLayoutResult, scrollTop: number, viewportHeight: number): number {
    if (layout.pages.length === 0) {
      return 0;
    }

    const center = scrollTop + viewportHeight / 2;
    const visible = this.getVisibleWindow(layout, scrollTop, viewportHeight, 1);
    const start = Math.max(0, visible.start);
    const end = Math.min(layout.pages.length - 1, Math.max(visible.end, start));
    let bestIndex = start;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let index = start; index <= end; index += 1) {
      const page = layout.pages[index];
      const pageCenter = page.top + page.height / 2;
      const distance = Math.abs(pageCenter - center);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }

    return bestIndex;
  }

  /** Binary search: first page whose bottom edge is at or past the given y coordinate. */
  private findFirstPage(pages: PageShellLayout[], edge: number): number {
    let low = 0;
    let high = pages.length - 1;
    let answer = 0;

    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const page = pages[middle];
      if (page.top + page.height >= edge) {
        answer = middle;
        high = middle - 1;
      } else {
        low = middle + 1;
      }
    }

    return answer;
  }

  /** Binary search: last page whose top edge is at or before the given y coordinate. */
  private findLastPage(pages: PageShellLayout[], edge: number): number {
    let low = 0;
    let high = pages.length - 1;
    let answer = pages.length - 1;

    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const page = pages[middle];
      if (page.top <= edge) {
        answer = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    return answer;
  }
}
