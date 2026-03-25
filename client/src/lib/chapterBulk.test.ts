import { describe, expect, it } from 'vitest';
import { parseBulkChapterText, resolveBulkChapterEndPages } from './chapterBulk';

describe('chapter bulk parsing', () => {
  it('parses chapter-number title lines with a trailing page number', () => {
    const parsed = parseBulkChapterText(
      `1 Functions and Models, 42
2 Limits and Derivatives, 112
Appendices, 1159`,
      1301
    );

    expect(parsed).toEqual([
      { title: '1 Functions and Models', start: 42, end: null },
      { title: '2 Limits and Derivatives', start: 112, end: null },
      { title: 'Appendices', start: 1159, end: null }
    ]);
  });

  it('resolves implied end pages from the next chapter start', () => {
    const resolved = resolveBulkChapterEndPages(
      [
        { title: '1 Functions and Models', start: 42, end: null },
        { title: '2 Limits and Derivatives', start: 112, end: null },
        { title: 'Appendices', start: 1159, end: null }
      ],
      1301
    );

    expect(resolved).toEqual([
      { title: '1 Functions and Models', start: 42, end: 111 },
      { title: '2 Limits and Derivatives', start: 112, end: 1158 },
      { title: 'Appendices', start: 1159, end: 1301 }
    ]);
  });

  it('parses comma-containing titles by using the final trailing page number', () => {
    const parsed = parseBulkChapterText(
      `Preface, 44
1 Functions and Models, 41
2 Limits and Derivatives, 111
3 Differentiation Rules, 207
4 Applications of Differentiation, 313
5 Integrals, 405
6 Applications of Integration, 469
7 Techniques of Integration, 519
8 Further Applications of Integration, 593
9 Differential Equations, 639
10 Parametric Equations and Polar Coordinates, 695
11 Sequences, Series, and Power Series, 757
12 Vectors and the Geometry of Space, 863
13 Vector Functions, 923
14 Partial Derivatives, 967
15 Multiple Integrals, 1071
16 Vector Calculus, 1157
Appendices, 1158
Index, 1300`,
      1300
    );

    expect(parsed[0]).toEqual({ title: 'Preface', start: 44, end: null });
    expect(parsed[11]).toEqual({ title: '11 Sequences, Series, and Power Series', start: 757, end: null });
    expect(parsed.at(-1)).toEqual({ title: 'Index', start: 1300, end: null });
  });
});
