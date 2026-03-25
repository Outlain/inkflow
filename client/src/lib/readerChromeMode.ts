const STORAGE_KEY = 'inkflow-reader-browser-safe-topbar.v1';

export function loadReaderBrowserSafeTopbar(): boolean {
  if (typeof window === 'undefined') {
    return true;
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw == null) {
      return true;
    }

    return raw === 'true';
  } catch {
    return true;
  }
}

export function saveReaderBrowserSafeTopbar(enabled: boolean): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
  } catch {
    // ignore storage failures
  }
}
