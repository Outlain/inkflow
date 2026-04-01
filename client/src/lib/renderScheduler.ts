/**
 * Central render scheduler — ensures the most-visible page renders first,
 * then falls back to active-page proximity so nearby work still wins over
 * off-screen pages. Jobs are drained in a microtask so all page shells in the
 * current render pass can enqueue before priority is chosen.
 */

export type RenderPriority = {
  pageIndex: number;
  activeIndex: number;
  visibleRatio: number;
  visiblePixels: number;
};

type RenderJob = {
  pageIndex: number;
  activeDistance: number;
  visibleRatio: number;
  visiblePixels: number;
  run: () => Promise<void>;
  cancel: () => void;
};

const pendingJobs = new Map<string, RenderJob>();
let running = false;
let drainScheduled = false;
let idleResolvers: (() => void)[] = [];

export function scheduleRender(key: string, priority: RenderPriority, run: () => Promise<void>, cancel: () => void): void {
  pendingJobs.set(key, {
    pageIndex: priority.pageIndex,
    activeDistance: Math.abs(priority.pageIndex - priority.activeIndex),
    visibleRatio: priority.visibleRatio,
    visiblePixels: priority.visiblePixels,
    run,
    cancel
  });
  requestDrain();
}

export function cancelRender(key: string): void {
  const job = pendingJobs.get(key);
  if (job) {
    job.cancel();
    pendingJobs.delete(key);
  }
}

export function clearScheduler(): void {
  for (const job of pendingJobs.values()) {
    job.cancel();
  }
  pendingJobs.clear();
  drainScheduled = false;
}

/**
 * Returns a promise that resolves when the render queue is empty (all
 * priority renders have completed). Use this to defer prefetching until
 * the active page and nearby pages have finished rendering, freeing up
 * browser connection slots on slow networks.
 */
export function waitForIdle(): Promise<void> {
  if (!running && pendingJobs.size === 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    idleResolvers.push(resolve);
  });
}

/** Whether the scheduler is currently processing render jobs. */
export function isSchedulerBusy(): boolean {
  return running || drainScheduled || pendingJobs.size > 0;
}

function compareRenderJobs(left: RenderJob, right: RenderJob): number {
  if (left.visibleRatio !== right.visibleRatio) {
    return right.visibleRatio - left.visibleRatio;
  }
  if (left.visiblePixels !== right.visiblePixels) {
    return right.visiblePixels - left.visiblePixels;
  }
  if (left.activeDistance !== right.activeDistance) {
    return left.activeDistance - right.activeDistance;
  }
  return left.pageIndex - right.pageIndex;
}

function requestDrain(): void {
  if (running || drainScheduled) {
    return;
  }

  drainScheduled = true;
  queueMicrotask(() => {
    drainScheduled = false;
    if (!running && pendingJobs.size > 0) {
      void drainJobs();
    }
  });
}

async function drainJobs(): Promise<void> {
  running = true;
  while (pendingJobs.size > 0) {
    // Pick the most-visible job first, then fall back to active-page distance.
    let bestKey: string | null = null;
    let bestJob: RenderJob | null = null;
    for (const [key, job] of pendingJobs) {
      if (!bestJob || compareRenderJobs(job, bestJob) < 0) {
        bestJob = job;
        bestKey = key;
      }
    }
    if (!bestKey) break;
    const job = pendingJobs.get(bestKey)!;
    pendingJobs.delete(bestKey);
    try {
      await job.run();
    } catch {
      // Individual job failures don't stop the queue
    }
  }
  running = false;
  // Notify anyone waiting for the queue to drain
  const resolvers = idleResolvers;
  idleResolvers = [];
  for (const resolve of resolvers) {
    resolve();
  }
}
