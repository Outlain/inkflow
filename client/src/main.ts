import './styles.css';
import { mount } from 'svelte';
import App from './App.svelte';

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

window.addEventListener('error', (event) => {
  renderStartupError(event.error ?? event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  renderStartupError(event.reason);
});

const target = document.getElementById('app');

let app: ReturnType<typeof mount> | null = null;

if (target) {
  try {
    app = mount(App, { target });
  } catch (error) {
    renderStartupError(error);
  }
}

export default app;
