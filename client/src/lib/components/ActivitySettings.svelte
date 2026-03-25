<script lang="ts">
  // Modal dialog for configuring activity tracking: idle timeout, daily goal, and webhook.
  import { createEventDispatcher, onMount } from 'svelte';
  import type { ActivityConfigPayload } from '@shared/contracts';
  import { fetchActivityConfig, updateActivityConfig } from '../activity';

  const dispatch = createEventDispatcher<{ close: void }>();

  let config: ActivityConfigPayload | null = null;
  let loading = true;
  let saving = false;
  let idleTimeoutMins = 5;
  let dailyGoalMins = 60;
  let webhookUrl = '';
  let webhookEnabled = false;

  onMount(async () => {
    try {
      config = await fetchActivityConfig();
      idleTimeoutMins = Math.round(config.idleTimeoutSecs / 60);
      dailyGoalMins = config.dailyGoalMins;
      webhookUrl = config.webhookUrl ?? '';
      webhookEnabled = config.webhookEnabled;
    } catch {
      // No config yet
    } finally {
      loading = false;
    }
  });

  async function save(): Promise<void> {
    saving = true;
    try {
      config = await updateActivityConfig({
        idleTimeoutSecs: Math.max(60, idleTimeoutMins * 60),
        dailyGoalMins,
        webhookUrl: webhookUrl.trim() || null,
        webhookEnabled
      });
    } catch {
      // Best effort
    } finally {
      saving = false;
    }
  }
</script>

<div class="settings-backdrop" role="presentation" on:click|self={() => dispatch('close')}>
  <div class="settings-popup" role="dialog" aria-modal="true">
    <div class="settings-header">
      <h3>Activity Settings</h3>
      <button class="settings-close" type="button" on:click={() => dispatch('close')}>X</button>
    </div>

    {#if loading}
      <div class="settings-loading">Loading...</div>
    {:else}
      <div class="settings-field">
        <label for="idle-timeout">Idle Timeout (minutes)</label>
        <p class="settings-hint">How long without interaction before a session is paused.</p>
        <input id="idle-timeout" type="range" min="1" max="30" bind:value={idleTimeoutMins} />
        <span class="settings-range-value">{idleTimeoutMins} min</span>
      </div>

      <div class="settings-field">
        <label for="daily-goal">Daily Study Goal (minutes)</label>
        <p class="settings-hint">Set a target for daily study time.</p>
        <input id="daily-goal" type="number" min="0" max="1440" bind:value={dailyGoalMins} />
      </div>

      <div class="settings-divider"></div>

      <div class="settings-field">
        <label for="webhook-url">Webhook URL (external tracker)</label>
        <p class="settings-hint">When a study session ends, POST session data to this URL. Leave empty to disable.</p>
        <input id="webhook-url" type="url" placeholder="https://..." bind:value={webhookUrl} />
      </div>

      <div class="settings-field settings-checkbox">
        <input id="webhook-enabled" type="checkbox" bind:checked={webhookEnabled} />
        <label for="webhook-enabled">Enable webhook push</label>
      </div>

      <div class="settings-actions">
        <button class="button" type="button" on:click={() => dispatch('close')}>Cancel</button>
        <button class="button primary" type="button" disabled={saving} on:click={save}>
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>
    {/if}
  </div>
</div>

<style>
  .settings-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    padding: 20px;
  }

  .settings-popup {
    background: #f7f2e8;
    border-radius: 24px;
    padding: 24px;
    max-width: 420px;
    width: 100%;
    max-height: 80vh;
    overflow-y: auto;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.2);
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .settings-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .settings-header h3 {
    margin: 0;
    font-size: 1.15rem;
    color: var(--ink-navy);
  }

  .settings-close {
    background: none;
    border: none;
    font-size: 1rem;
    cursor: pointer;
    color: var(--ink-soft);
    padding: 4px 8px;
    border-radius: 8px;
  }

  .settings-close:hover {
    background: var(--ink-border);
  }

  .settings-loading {
    padding: 30px;
    text-align: center;
    color: var(--ink-soft);
  }

  .settings-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .settings-field label {
    font-size: 0.88rem;
    font-weight: 600;
    color: #1e2832;
  }

  .settings-hint {
    font-size: 0.78rem;
    color: var(--ink-soft);
    margin: 0;
  }

  .settings-field input[type="range"] {
    width: 100%;
  }

  .settings-field input[type="number"],
  .settings-field input[type="url"] {
    padding: 8px 12px;
    border: 1px solid var(--ink-border);
    border-radius: 10px;
    background: var(--ink-paper);
    font-size: 0.9rem;
  }

  .settings-range-value {
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--ink-blue);
    text-align: center;
  }

  .settings-checkbox {
    flex-direction: row;
    align-items: center;
    gap: 8px;
  }

  .settings-checkbox input {
    width: 18px;
    height: 18px;
  }

  .settings-divider {
    height: 1px;
    background: var(--ink-border);
    margin: 4px 0;
  }

  .settings-actions {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
    margin-top: 4px;
  }
</style>
