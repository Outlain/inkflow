export interface ParsedBulkChapter {
  title: string;
  start: number;
  end: number | null;
}

export interface ResolvedBulkChapter {
  title: string;
  start: number;
  end: number;
}

export function parseBulkChapterText(text: string, pageCount: number): ParsedBulkChapter[] {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    return [];
  }

  const results: ParsedBulkChapter[] = [];

  for (const line of lines) {
    let parsed: ParsedBulkChapter | null = null;

    const titledTrailingMatch = line.match(/^(.+)[,;:\t]\s*(\d+)(?:\s*[-–]\s*(\d+))?\s*$/);
    if (titledTrailingMatch) {
      const title = titledTrailingMatch[1].trim();
      const start = Number.parseInt(titledTrailingMatch[2], 10);
      const end = titledTrailingMatch[3] ? Number.parseInt(titledTrailingMatch[3], 10) : null;
      if (title && start >= 1 && start <= pageCount) {
        parsed = {
          title,
          start,
          end: end && end >= start && end <= pageCount ? end : null
        };
      }
    }

    if (!parsed) {
      const leadingRangeMatch = line.match(/^(\d+)(?:\s*[-–]\s*(\d+))?\s*[.:\-–)]\s*(.+)$/);
      if (leadingRangeMatch) {
        const start = Number.parseInt(leadingRangeMatch[1], 10);
        const end = leadingRangeMatch[2] ? Number.parseInt(leadingRangeMatch[2], 10) : null;
        const title = leadingRangeMatch[3].trim();
        if (title && start >= 1 && start <= pageCount) {
          parsed = {
            title,
            start,
            end: end && end >= start && end <= pageCount ? end : null
          };
        }
      }
    }

    if (!parsed) {
      const simpleLeadingMatch = line.match(/^(\d+)\s+(.+)$/);
      if (simpleLeadingMatch) {
        const start = Number.parseInt(simpleLeadingMatch[1], 10);
        const title = simpleLeadingMatch[2].trim();
        if (title && start >= 1 && start <= pageCount) {
          parsed = { title, start, end: null };
        }
      }
    }

    if (parsed) {
      results.push(parsed);
    }
  }

  return results;
}

export function resolveBulkChapterEndPages(entries: ParsedBulkChapter[], pageCount: number): ResolvedBulkChapter[] {
  const sorted = [...entries].sort((left, right) => left.start - right.start);
  return sorted.map((entry, index) => {
    if (entry.end != null) {
      return { title: entry.title, start: entry.start, end: entry.end };
    }

    const nextStart = sorted[index + 1]?.start;
    const end = nextStart ? nextStart - 1 : pageCount;
    return {
      title: entry.title,
      start: entry.start,
      end: Math.max(entry.start, end)
    };
  });
}
