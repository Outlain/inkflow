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

const TOP_PADDING = 24;
const BOTTOM_PADDING = 48;
const PAGE_GAP = 28;
const HORIZONTAL_PADDING = 20;

export class ReaderLayoutEngine {
  build(pages: PageRecord[], viewportWidth: number, zoom: number): ReaderLayoutResult {
    const usableWidth = Math.max(320, viewportWidth - HORIZONTAL_PADDING * 2);
    let top = TOP_PADDING;
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
      top += height + PAGE_GAP;
      return layout;
    });

    return {
      containerHeight: top - PAGE_GAP + BOTTOM_PADDING,
      containerWidth: Math.ceil(maxRight),
      pages: layouts
    };
  }

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
