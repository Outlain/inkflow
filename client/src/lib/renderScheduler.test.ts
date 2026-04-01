import { afterEach, describe, expect, it } from 'vitest';
import { clearScheduler, scheduleRender, waitForIdle } from './renderScheduler';

describe('renderScheduler', () => {
  afterEach(() => {
    clearScheduler();
  });

  it('renders the most-visible page first even if it enqueues second', async () => {
    const order: string[] = [];

    scheduleRender(
      'top-page',
      {
        pageIndex: 0,
        activeIndex: 0,
        visibleRatio: 0.2,
        visiblePixels: 180
      },
      async () => {
        order.push('top-page');
      },
      () => undefined
    );

    scheduleRender(
      'bottom-page',
      {
        pageIndex: 1,
        activeIndex: 0,
        visibleRatio: 0.8,
        visiblePixels: 720
      },
      async () => {
        order.push('bottom-page');
      },
      () => undefined
    );

    await waitForIdle();

    expect(order).toEqual(['bottom-page', 'top-page']);
  });

  it('falls back to active-page distance when visible coverage is tied', async () => {
    const order: string[] = [];

    scheduleRender(
      'nearby-page',
      {
        pageIndex: 4,
        activeIndex: 5,
        visibleRatio: 0.5,
        visiblePixels: 400
      },
      async () => {
        order.push('nearby-page');
      },
      () => undefined
    );

    scheduleRender(
      'far-page',
      {
        pageIndex: 9,
        activeIndex: 5,
        visibleRatio: 0.5,
        visiblePixels: 400
      },
      async () => {
        order.push('far-page');
      },
      () => undefined
    );

    await waitForIdle();

    expect(order).toEqual(['nearby-page', 'far-page']);
  });
});
