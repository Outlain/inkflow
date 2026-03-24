<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { onQualityToast, type QualityChangeEvent } from '../networkMonitor';

  let visible = false;
  let toast: QualityChangeEvent | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;

  function showToast(event: QualityChangeEvent): void {
    toast = event;
    visible = true;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      visible = false;
    }, 5000);
  }

  onMount(() => {
    unsubscribe = onQualityToast(showToast);
  });

  onDestroy(() => {
    unsubscribe?.();
    if (hideTimer) clearTimeout(hideTimer);
  });

  function dismiss(): void {
    visible = false;
    if (hideTimer) clearTimeout(hideTimer);
  }

  function qualityIcon(quality: string): string {
    if (quality === 'slow') return '\u26A0';
    if (quality === 'medium') return '\u25CF';
    return '\u2713';
  }

  function qualityLabel(quality: string): string {
    if (quality === 'slow') return 'Low Data Mode';
    if (quality === 'medium') return 'Moderate Data Mode';
    return 'Full Speed Mode';
  }
</script>

{#if visible && toast}
  <div class="network-toast" class:slow={toast.current === 'slow'} class:medium={toast.current === 'medium'} class:fast={toast.current === 'fast'}>
    <div class="network-toast-icon">{qualityIcon(toast.current)}</div>
    <div class="network-toast-content">
      <div class="network-toast-title">
        {toast.current === 'fast' ? 'Switching to Full Speed Mode' : `Switching to ${qualityLabel(toast.current)}`}
      </div>
      <div class="network-toast-reason">{toast.reason}</div>
    </div>
    <button class="network-toast-close" on:click={dismiss}>&times;</button>
  </div>
{/if}

<style>
  .network-toast {
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 18px;
    border-radius: 12px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px;
    z-index: 10000;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.25);
    animation: toast-in 0.3s ease-out;
    max-width: 420px;
    min-width: 280px;
  }

  .network-toast.slow {
    background: #3a2015;
    color: #f5d6b8;
    border: 1px solid rgba(245, 166, 90, 0.3);
  }

  .network-toast.medium {
    background: #2a2a15;
    color: #e8ddb5;
    border: 1px solid rgba(210, 190, 100, 0.3);
  }

  .network-toast.fast {
    background: #152a1a;
    color: #b8e8c8;
    border: 1px solid rgba(100, 200, 130, 0.3);
  }

  .network-toast-icon {
    font-size: 20px;
    flex-shrink: 0;
  }

  .network-toast-content {
    flex: 1;
    min-width: 0;
  }

  .network-toast-title {
    font-weight: 600;
    font-size: 14px;
    line-height: 1.3;
  }

  .network-toast-reason {
    font-size: 12px;
    opacity: 0.75;
    margin-top: 2px;
    line-height: 1.3;
  }

  .network-toast-close {
    background: none;
    border: none;
    color: inherit;
    font-size: 20px;
    cursor: pointer;
    padding: 0 4px;
    opacity: 0.6;
    flex-shrink: 0;
    line-height: 1;
  }

  .network-toast-close:hover {
    opacity: 1;
  }

  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translateX(-50%) translateY(16px);
    }
    to {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
  }

  @media (max-width: 720px) {
    .network-toast {
      bottom: 16px;
      left: 16px;
      right: 16px;
      transform: none;
      min-width: 0;
      max-width: none;
    }

    @keyframes toast-in {
      from {
        opacity: 0;
        transform: translateY(16px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
  }
</style>
