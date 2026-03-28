// Theme management — persists to localStorage, respects system preference on first visit.

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'inkflow-theme';

/** Read the saved theme or fall back to system preference. */
function resolveTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Apply the theme to the document root. */
function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
}

let current: Theme = 'light';

/** Initialize theme on app start. Call once from onMount. */
export function initTheme(): void {
  current = resolveTheme();
  applyTheme(current);

  // Listen for OS theme changes (only matters when user hasn't explicitly chosen)
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!localStorage.getItem(STORAGE_KEY)) {
      current = e.matches ? 'dark' : 'light';
      applyTheme(current);
    }
  });
}

/** Toggle between light and dark. Returns the new theme. */
export function toggleTheme(): Theme {
  current = current === 'light' ? 'dark' : 'light';
  localStorage.setItem(STORAGE_KEY, current);
  applyTheme(current);
  return current;
}

/** Get the current active theme. */
export function getTheme(): Theme {
  return current;
}
