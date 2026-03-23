// Central render scheduler — ensures the active page and nearby pages render
// before pages further away, regardless of DOM order.

type RenderJob = {
  pageIndex: number;
  priority: number; // lower = higher priority
  run: () => Promise<void>;
  cancel: () => void;
};

const pendingJobs = new Map<string, RenderJob>();
let running = false;

export function scheduleRender(key: string, pageIndex: number, activeIndex: number, run: () => Promise<void>, cancel: () => void): void {
  const priority = Math.abs(pageIndex - activeIndex);
  pendingJobs.set(key, { pageIndex, priority, run, cancel });
  if (!running) {
    void drainJobs();
  }
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
}

async function drainJobs(): Promise<void> {
  running = true;
  while (pendingJobs.size > 0) {
    // Pick highest priority job (lowest priority number)
    let bestKey: string | null = null;
    let bestPriority = Infinity;
    for (const [key, job] of pendingJobs) {
      if (job.priority < bestPriority) {
        bestPriority = job.priority;
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
}
