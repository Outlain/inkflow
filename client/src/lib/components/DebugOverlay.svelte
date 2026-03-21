<script lang="ts">
  import { onMount } from 'svelte';
  import type { DebugEvent } from '@shared/contracts';
  import { debugTimeline } from '../debug';

  let events: DebugEvent[] = [];

  onMount(() => debugTimeline.subscribe((next) => (events = next)));

  function formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }
</script>

{#if debugTimeline.enabled}
  <aside class="debug-overlay">
    <h3>Inkflow Debug</h3>
    <div class="debug-list">
      {#each events as event (event.id)}
        <article class="debug-row">
          <strong>{event.type}</strong>
          <p>{event.message}</p>
          <span>{formatTime(event.at)}</span>
        </article>
      {/each}
    </div>
  </aside>
{/if}
