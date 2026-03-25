/** Timestamped event log for the debug overlay. Enabled via ?inkflowDebug=1 or localStorage. */

import type { DebugEvent } from '@shared/contracts';

type Listener = (events: DebugEvent[]) => void;

function safeStorageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures so debug mode detection never blocks app bootstrap.
  }
}

function detectEnabled(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const params = new URLSearchParams(window.location.search);
  if (params.get('inkflowDebug') === '1') {
    safeStorageSet('inkflowDebug', '1');
    return true;
  }

  return safeStorageGet('inkflowDebug') === '1';
}

export class DebugTimeline {
  readonly enabled: boolean;
  private readonly entries: DebugEvent[] = [];
  private readonly listeners = new Set<Listener>();

  constructor(enabled = detectEnabled()) {
    this.enabled = enabled;
  }

  log(type: DebugEvent['type'], message: string): void {
    if (!this.enabled) {
      return;
    }

    this.entries.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      message,
      at: Date.now()
    });

    if (this.entries.length > 80) {
      this.entries.length = 80;
    }

    const snapshot = [...this.entries];
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  subscribe(listener: Listener): () => void {
    listener([...this.entries]);
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const debugTimeline = new DebugTimeline();
