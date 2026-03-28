<script lang="ts">
  // Per-document activity stats popup — total time, sessions, daily chart,
  // chapter dwell time, page-level time, and recent session history.
  import { createEventDispatcher, onMount } from 'svelte';
  import type { DocumentActivitySummary } from '@shared/contracts';
  import { fetchDocumentActivity } from '../activity';

  export let documentId: string;
  export let documentTitle: string;

  const dispatch = createEventDispatcher<{ close: void }>();

  let summary: DocumentActivitySummary | null = null;
  let loading = true;
  let activeTab: 'day' | 'week' | 'month' = 'week';

  onMount(async () => {
    try {
      summary = await fetchDocumentActivity(documentId);
    } catch {
      // fallback
    } finally {
      loading = false;
    }
  });

  function formatDuration(secs: number): string {
    if (secs < 60) return `${secs}s`;
    const minutes = Math.floor(secs / 60);
    const hours = Math.floor(minutes / 60);
    if (hours === 0) return `${minutes}m`;
    const remainingMins = minutes % 60;
    return remainingMins > 0 ? `${hours}h ${remainingMins}m` : `${hours}h`;
  }

  function dayLabel(dateStr: string): string {
    const d = new Date(dateStr + 'T12:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  }

  function barHeight(secs: number, maxSecs: number): number {
    if (maxSecs === 0) return 0;
    return Math.max(2, (secs / maxSecs) * 100);
  }

  $: filteredDaily = summary ? filterByTab(summary.dailyActivity, activeTab) : [];
  $: maxSecs = Math.max(...filteredDaily.map(d => d.studySecs), 1);

  function filterByTab(days: DocumentActivitySummary['dailyActivity'], tab: 'day' | 'week' | 'month') {
    if (tab === 'day') return days.slice(-1);
    if (tab === 'week') return days.slice(-7);
    return days;
  }
</script>

<div class="stats-backdrop" role="presentation" on:click|self={() => dispatch('close')}>
  <div class="stats-popup" role="dialog" aria-modal="true">
    <div class="stats-header">
      <div>
        <h3>{documentTitle}</h3>
        <p class="stats-subtitle">Activity Stats</p>
      </div>
      <button class="stats-close" type="button" on:click={() => dispatch('close')}>X</button>
    </div>

    {#if loading}
      <div class="stats-loading">Loading stats...</div>
    {:else if summary}
      <div class="stats-overview">
        <div class="stat-card">
          <span class="stat-label">Total Time</span>
          <strong class="stat-value">{formatDuration(summary.totalStudySecs)}</strong>
        </div>
        <div class="stat-card">
          <span class="stat-label">Sessions</span>
          <strong class="stat-value">{summary.totalSessions}</strong>
        </div>
        <div class="stat-card">
          <span class="stat-label">Last Opened</span>
          <strong class="stat-value stat-value-sm">{summary.lastOpenedAt ? formatDate(summary.lastOpenedAt) : 'Never'}</strong>
        </div>
      </div>

      <div class="stats-tabs">
        <button class:active={activeTab === 'day'} type="button" on:click={() => activeTab = 'day'}>Day</button>
        <button class:active={activeTab === 'week'} type="button" on:click={() => activeTab = 'week'}>Week</button>
        <button class:active={activeTab === 'month'} type="button" on:click={() => activeTab = 'month'}>Month</button>
      </div>

      {#if filteredDaily.length > 1}
        <div class="mini-chart">
          <div class="chart-bars">
            {#each filteredDaily as day}
              <div class="chart-bar-col">
                <div class="chart-bar-track">
                  <div
                    class="chart-bar-fill"
                    style="height: {barHeight(day.studySecs, maxSecs)}%"
                    title="{dayLabel(day.date)}: {formatDuration(day.studySecs)}"
                  ></div>
                </div>
                {#if filteredDaily.length <= 7}
                  <span class="chart-bar-label">{dayLabel(day.date)}</span>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {:else if filteredDaily.length === 1}
        <div class="single-day-stat">
          <span>Today: <strong>{formatDuration(filteredDaily[0].studySecs)}</strong></span>
        </div>
      {/if}

      {#if summary.chapterTime.length > 0}
        <div class="stats-section">
          <h4>Chapter Time</h4>
          {#each summary.chapterTime as chapter}
            <div class="stats-row">
              <span class="stats-row-label">{chapter.title}</span>
              <span class="stats-row-value">{formatDuration(chapter.dwellSecs)}</span>
            </div>
          {/each}
        </div>
      {/if}

      {#if summary.pageTime.length > 0}
        <div class="stats-section">
          <h4>Time Per Page (top pages)</h4>
          {#each summary.pageTime.sort((a, b) => b.dwellSecs - a.dwellSecs).slice(0, 10) as pt}
            <div class="stats-row">
              <span class="stats-row-label">Page {pt.pageIndex + 1}</span>
              <span class="stats-row-value">{formatDuration(pt.dwellSecs)}</span>
            </div>
          {/each}
        </div>
      {/if}

      {#if summary.recentSessions.length > 0}
        <div class="stats-section">
          <h4>Recent Sessions</h4>
          {#each summary.recentSessions.slice(0, 8) as session}
            <div class="stats-row">
              <span class="stats-row-label">{formatDate(session.startedAt)}</span>
              <span class="stats-row-value">{formatDuration(session.activeSecs)}</span>
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .stats-backdrop {
    position: fixed;
    inset: 0;
    background: var(--ink-backdrop);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    padding: 20px;
  }

  .stats-popup {
    background: var(--ink-bg-popup);
    border-radius: 24px;
    padding: 24px;
    max-width: 480px;
    width: 100%;
    max-height: 80vh;
    overflow-y: auto;
    box-shadow: var(--ink-shadow-modal);
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .stats-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
  }

  .stats-header h3 {
    margin: 0;
    font-size: 1.2rem;
    color: var(--ink-navy);
  }

  .stats-subtitle {
    margin: 2px 0 0;
    font-size: 0.82rem;
    color: var(--ink-soft);
  }

  .stats-close {
    background: none;
    border: none;
    font-size: 1rem;
    cursor: pointer;
    color: var(--ink-soft);
    padding: 4px 8px;
    border-radius: 8px;
  }

  .stats-close:hover {
    background: var(--ink-border);
  }

  .stats-loading {
    padding: 30px;
    text-align: center;
    color: var(--ink-soft);
  }

  .stats-overview {
    display: flex;
    gap: 10px;
  }

  .stat-card {
    flex: 1;
    background: var(--ink-paper);
    border: 1px solid var(--ink-border);
    border-radius: 14px;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .stat-label {
    font-size: 0.7rem;
    color: var(--ink-soft);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .stat-value {
    font-size: 1.3rem;
    color: var(--ink-navy);
    font-weight: 700;
  }

  .stat-value-sm {
    font-size: 0.85rem;
  }

  .stats-tabs {
    display: flex;
    gap: 4px;
    background: var(--ink-border);
    border-radius: 10px;
    padding: 3px;
  }

  .stats-tabs button {
    flex: 1;
    background: none;
    border: none;
    padding: 6px 12px;
    border-radius: 8px;
    font-size: 0.82rem;
    cursor: pointer;
    color: var(--ink-soft);
    font-weight: 500;
  }

  .stats-tabs button.active {
    background: var(--ink-paper);
    color: var(--ink-navy);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  }

  .mini-chart {
    height: 100px;
  }

  .chart-bars {
    display: flex;
    gap: 4px;
    align-items: flex-end;
    height: 100%;
  }

  .chart-bar-col {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    height: 100%;
  }

  .chart-bar-track {
    flex: 1;
    width: 100%;
    display: flex;
    align-items: flex-end;
    justify-content: center;
  }

  .chart-bar-fill {
    width: 100%;
    max-width: 28px;
    background: linear-gradient(180deg, var(--ink-blue), var(--ink-navy));
    border-radius: 4px 4px 1px 1px;
    min-height: 2px;
  }

  .chart-bar-label {
    font-size: 0.65rem;
    color: var(--ink-soft);
  }

  .single-day-stat {
    text-align: center;
    padding: 12px;
    color: var(--ink-soft);
    font-size: 0.9rem;
  }

  .single-day-stat strong {
    color: var(--ink-navy);
  }

  .stats-section {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .stats-section h4 {
    margin: 0 0 4px;
    font-size: 0.85rem;
    color: var(--ink-soft);
    font-weight: 500;
  }

  .stats-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 10px;
    background: var(--ink-paper);
    border-radius: 8px;
    border: 1px solid var(--ink-border);
  }

  .stats-row-label {
    font-size: 0.82rem;
    color: var(--ink-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .stats-row-value {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--ink-blue);
    flex-shrink: 0;
    margin-left: 10px;
  }
</style>
