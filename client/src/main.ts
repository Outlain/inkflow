/**
 * Application entry point — registers the service worker, sets up global
 * error handlers (with a startup-phase crash screen), and mounts the Svelte app.
 */

import './styles.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { initPublicRuntimeConfig } from './lib/runtimeConfig';

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}

const BENIGN_RUNTIME_ERRORS = [
  'ResizeObserver loop completed with undelivered notifications.',
  'ResizeObserver loop limit exceeded'
];

function renderStartupError(error: unknown): void {
  const target = document.getElementById('app');
  if (!target) {
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  target.innerHTML = `
    <div style="min-height:100vh;display:grid;place-items:center;padding:24px;">
      <div style="max-width:720px;padding:24px 28px;border-radius:24px;background:rgba(255,252,247,.92);border:1px solid rgba(88,89,86,.14);box-shadow:0 18px 46px rgba(82,70,42,.12);font-family:Iowan Old Style,Palatino Linotype,Book Antiqua,Georgia,serif;color:#1e2832;">
        <h1 style="margin:0 0 12px;font-size:2rem;color:#1f3140;">Inkflow failed to start</h1>
        <p style="margin:0 0 10px;color:#4f5b66;">The frontend hit a startup error before the library could render.</p>
        <pre style="margin:0;white-space:pre-wrap;word-break:break-word;font:0.95rem/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#7d2f22;">${message}</pre>
      </div>
    </div>
  `;
}

function normalizeWindowError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error ?? '');
}

function isBenignRuntimeError(error: unknown): boolean {
  const message = normalizeWindowError(error);
  return BENIGN_RUNTIME_ERRORS.some((knownMessage) => message.includes(knownMessage));
}

let startupPhase = true;

window.addEventListener('error', (event) => {
  const error = event.error ?? event.message;
  if (isBenignRuntimeError(error)) {
    console.warn('[Inkflow] Ignored benign runtime error:', normalizeWindowError(error));
    return;
  }

  if (!startupPhase) {
    console.error('[Inkflow] Runtime error:', error);
    return;
  }

  renderStartupError(error);
});

window.addEventListener('unhandledrejection', (event) => {
  if (isBenignRuntimeError(event.reason)) {
    console.warn('[Inkflow] Ignored benign runtime rejection:', normalizeWindowError(event.reason));
    return;
  }

  if (!startupPhase) {
    console.error('[Inkflow] Runtime rejection:', event.reason);
    return;
  }

  renderStartupError(event.reason);
});

const target = document.getElementById('app');

let app: ReturnType<typeof mount> | null = null;

async function bootstrap(): Promise<void> {
  if (!target) {
    return;
  }

  try {
    await initPublicRuntimeConfig();
    app = mount(App, { target });
    queueMicrotask(() => {
      startupPhase = false;
    });
  } catch (error) {
    renderStartupError(error);
  }
}

void bootstrap();

export default app;
