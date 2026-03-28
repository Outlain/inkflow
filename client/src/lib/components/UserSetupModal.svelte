<script lang="ts">
  // First-run modal that creates the user profile (display name).
  // Shown once when the library detects no user has been set up yet.
  import { createEventDispatcher } from 'svelte';
  import type { UserRecord } from '@shared/contracts';
  import { setupUser } from '../activity';

  const dispatch = createEventDispatcher<{ complete: { user: UserRecord } }>();

  let displayName = '';
  let busy = false;
  let error = '';

  async function submit(): Promise<void> {
    const name = displayName.trim();
    if (!name) {
      error = 'Please enter your name.';
      return;
    }

    busy = true;
    error = '';

    try {
      const user = await setupUser(name);
      dispatch('complete', { user });
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not create user.';
    } finally {
      busy = false;
    }
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !busy) {
      submit();
    }
  }
</script>

<div class="setup-backdrop">
  <div class="setup-modal" role="dialog" aria-modal="true">
    <div class="setup-brand">I</div>
    <h2>Welcome to Inkflow</h2>
    <p>What should we call you?</p>

    <div class="setup-field">
      <input
        bind:value={displayName}
        on:keydown={handleKeydown}
        maxlength="80"
        placeholder="Your name"
        autofocus
      />
    </div>

    {#if error}
      <p class="setup-error">{error}</p>
    {/if}

    <button class="button primary setup-submit" type="button" disabled={busy || !displayName.trim()} on:click={submit}>
      {busy ? 'Setting up...' : 'Get Started'}
    </button>
  </div>
</div>

<style>
  .setup-backdrop {
    position: fixed;
    inset: 0;
    background: var(--ink-backdrop);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 200;
    padding: 20px;
  }

  .setup-modal {
    background: var(--ink-bg-popup);
    border-radius: 28px;
    padding: 36px 32px;
    max-width: 380px;
    width: 100%;
    text-align: center;
    box-shadow: var(--ink-shadow-modal);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
  }

  .setup-brand {
    width: 56px;
    height: 56px;
    border-radius: 16px;
    background: linear-gradient(135deg, var(--ink-blue), var(--ink-navy));
    color: white;
    font-size: 1.8rem;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 4px;
  }

  h2 {
    margin: 0;
    font-size: 1.4rem;
    color: var(--ink-navy);
  }

  p {
    margin: 0;
    color: var(--ink-soft);
    font-size: 0.92rem;
  }

  .setup-field {
    width: 100%;
    margin-top: 4px;
  }

  .setup-field input {
    width: 100%;
    padding: 12px 16px;
    border: 1px solid var(--ink-border);
    border-radius: 12px;
    background: var(--ink-paper);
    font-size: 1rem;
    color: var(--ink-text);
    outline: none;
    text-align: center;
  }

  .setup-field input:focus {
    border-color: var(--ink-blue);
    box-shadow: 0 0 0 3px rgba(45, 110, 150, 0.15);
  }

  .setup-error {
    color: var(--ink-danger);
    font-size: 0.85rem;
  }

  .setup-submit {
    width: 100%;
    margin-top: 4px;
  }
</style>
