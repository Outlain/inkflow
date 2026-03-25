<script lang="ts">
  // Dashboard widget showing today's study stats, weekly bar chart, and top notebooks.
  import { onMount } from 'svelte';
  import type { ActivitySummary } from '@shared/contracts';
  import { fetchActivitySummary } from '../activity';

  let summary: ActivitySummary | null = null;
  let loading = true;

  onMount(async () => {
    try {
      summary = await fetchActivitySummary();
    } catch {
      // No user set up yet or API not ready
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
    return d.toLocaleDateString('en-US', { weekday: 'short' });
  }

  function barHeight(secs: number, maxSecs: number): number {
    if (maxSecs === 0) return 0;
    return Math.max(2, (secs / maxSecs) * 100);
  }

  $: maxDaySecs = summary ? Math.max(...summary.weekDays.map(d => d.studySecs), 1) : 1;
</script>

{#if loading}
  <div class="activity-loading">Loading activity...</div>
{:else if summary}
  <div class="activity-dashboard">
    <div class="activity-header">
      <h3>Study Activity</h3>
      {#if summary.currentStreak > 0}
        <span class="streak-badge">{summary.currentStreak} day streak</span>
      {/if}
    </div>

    <div class="activity-stats-row">
      <div class="stat-card">
        <span class="stat-label">Today</span>
        <strong class="stat-value">{formatDuration(summary.todayStudySecs)}</strong>
      </div>
      <div class="stat-card">
        <span class="stat-label">Sessions</span>
        <strong class="stat-value">{summary.todaySessions}</strong>
      </div>
      <div class="stat-card">
        <span class="stat-label">App Time</span>
        <strong class="stat-value">{formatDuration(summary.todayAppSecs)}</strong>
      </div>
      {#if summary.longestStreak > 0}
        <div class="stat-card">
          <span class="stat-label">Best Streak</span>
          <strong class="stat-value">{summary.longestStreak}d</strong>
        </div>
      {/if}
    </div>

    <div class="weekly-chart">
      <h4>This Week</h4>
      <div class="chart-bars">
        {#each summary.weekDays as day}
          <div class="chart-bar-col">
            <div class="chart-bar-track">
              <div
                class="chart-bar-fill"
                style="height: {barHeight(day.studySecs, maxDaySecs)}%"
                title="{formatDuration(day.studySecs)} study"
              ></div>
            </div>
            <span class="chart-bar-label">{dayLabel(day.date)}</span>
          </div>
        {/each}
      </div>
    </div>

    {#if summary.topDocuments.length > 0}
      <div class="top-notebooks">
        <h4>Top Notebooks This Week</h4>
        {#each summary.topDocuments as doc}
          <div class="top-notebook-row">
            <span class="top-notebook-title">{doc.title}</span>
            <span class="top-notebook-time">{formatDuration(doc.studySecs)}</span>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .activity-dashboard {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .activity-loading {
    padding: 20px;
    text-align: center;
    color: var(--ink-soft);
    font-size: 0.9rem;
  }

  .activity-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .activity-header h3 {
    margin: 0;
    font-size: 1.15rem;
    color: var(--ink-navy);
  }

  .streak-badge {
    background: linear-gradient(135deg, #e8a948, #d4872e);
    color: white;
    padding: 4px 12px;
    border-radius: 20px;
    font-size: 0.8rem;
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  .activity-stats-row {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }

  .stat-card {
    flex: 1 1 80px;
    min-width: 80px;
    background: var(--ink-paper);
    border: 1px solid var(--ink-border);
    border-radius: 14px;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .stat-label {
    font-size: 0.75rem;
    color: var(--ink-soft);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .stat-value {
    font-size: 1.4rem;
    color: var(--ink-navy);
    font-weight: 700;
  }

  .weekly-chart {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .weekly-chart h4 {
    margin: 0;
    font-size: 0.9rem;
    color: var(--ink-soft);
    font-weight: 500;
  }

  .chart-bars {
    display: flex;
    gap: 6px;
    align-items: flex-end;
    height: 120px;
  }

  .chart-bar-col {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
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
    max-width: 36px;
    background: linear-gradient(180deg, var(--ink-blue), var(--ink-navy));
    border-radius: 6px 6px 2px 2px;
    min-height: 2px;
    transition: height 0.3s ease;
  }

  .chart-bar-label {
    font-size: 0.72rem;
    color: var(--ink-soft);
    text-transform: uppercase;
  }

  .top-notebooks {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .top-notebooks h4 {
    margin: 0;
    font-size: 0.9rem;
    color: var(--ink-soft);
    font-weight: 500;
  }

  .top-notebook-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
    background: var(--ink-paper);
    border-radius: 10px;
    border: 1px solid var(--ink-border);
  }

  .top-notebook-title {
    font-size: 0.88rem;
    color: #1e2832;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .top-notebook-time {
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--ink-blue);
    flex-shrink: 0;
    margin-left: 12px;
  }
</style>
