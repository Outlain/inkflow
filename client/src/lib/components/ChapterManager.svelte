<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import type { DocumentChapter } from '@shared/contracts';
  import { fetchChapters, createChapter, updateChapter, deleteChapter } from '../activity';

  export let documentId: string;
  export let pageCount: number;
  export let activePageIndex: number = 0;

  const dispatch = createEventDispatcher<{ changed: { chapters: DocumentChapter[] } }>();

  let chapters: DocumentChapter[] = [];
  let loading = true;
  let busy = false;

  // Add form
  let showAddForm = false;
  let addTitle = '';
  let addStartPage = 1;
  let addEndPage = 1;
  let addError = '';

  // Bulk import
  let showBulkForm = false;
  let bulkText = '';
  let bulkError = '';
  let bulkPreview: Array<{ title: string; start: number; end: number }> = [];

  // Edit state
  let editingId: string | null = null;
  let editTitle = '';
  let editStartPage = 1;
  let editEndPage = 1;

  onMount(async () => {
    try {
      chapters = await fetchChapters(documentId);
      dispatch('changed', { chapters });
    } catch {
      // No chapters or API error
    } finally {
      loading = false;
    }
  });

  // Reactive: current chapter based on active page
  // Reference both `chapters` and `activePageIndex` directly so Svelte tracks them
  $: activeChapter = chapters.find(c => activePageIndex >= c.startPageIndex && activePageIndex <= c.endPageIndex) ?? null;

  // ── Single add ──

  function openAddForm(): void {
    addTitle = '';
    addStartPage = activePageIndex + 1;
    addEndPage = Math.min(activePageIndex + 10, pageCount);
    addError = '';
    showAddForm = true;
    showBulkForm = false;
  }

  async function submitAdd(): Promise<void> {
    const title = addTitle.trim();
    if (!title) {
      addError = 'Title is required.';
      return;
    }
    if (addStartPage < 1 || addEndPage < addStartPage || addEndPage > pageCount) {
      addError = 'Invalid page range.';
      return;
    }

    busy = true;
    addError = '';
    try {
      const chapter = await createChapter(documentId, {
        title,
        startPageIndex: addStartPage - 1,
        endPageIndex: addEndPage - 1
      });
      chapters = [...chapters, chapter].sort((a, b) => a.startPageIndex - b.startPageIndex);
      showAddForm = false;
      dispatch('changed', { chapters });
    } catch (err) {
      addError = err instanceof Error ? err.message : 'Could not create chapter.';
    } finally {
      busy = false;
    }
  }

  // ── Bulk import ──

  function openBulkForm(): void {
    bulkText = '';
    bulkError = '';
    bulkPreview = [];
    showBulkForm = true;
    showAddForm = false;
  }

  /**
   * Parses bulk chapter text. Supported formats:
   *
   * Format A — page number then title:
   *   1 Introduction
   *   16 Literature Review
   *   45 Methodology
   *
   * Format B — explicit range then title:
   *   1-15 Introduction
   *   16-44 Literature Review
   *
   * Format C — title then page (with separator):
   *   Introduction, 1
   *   Literature Review, 16
   *   Methodology, 45-78
   *
   * When no end page is given, each chapter runs until the next chapter starts.
   * The last chapter extends to the end of the document.
   */
  function parseBulkText(text: string): Array<{ title: string; start: number; end: number | null }> {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) return [];

    const results: Array<{ title: string; start: number; end: number | null }> = [];

    for (const line of lines) {
      let parsed = false;

      // Format A/B: leading page or range, then title
      // "1 Introduction" or "1-15 Introduction" or "1. Introduction"
      const leadingMatch = line.match(/^(\d+)(?:\s*[-–]\s*(\d+))?\s*[.:\-–)]\s*(.+)$/);
      if (leadingMatch) {
        const start = parseInt(leadingMatch[1], 10);
        const end = leadingMatch[2] ? parseInt(leadingMatch[2], 10) : null;
        const title = leadingMatch[3].trim();
        if (title && start >= 1 && start <= pageCount) {
          results.push({ title, start, end: end && end >= start && end <= pageCount ? end : null });
          parsed = true;
        }
      }

      if (!parsed) {
        // Also try without separator: "1 Introduction" (just number space text)
        const simpleMatch = line.match(/^(\d+)\s+(.+)$/);
        if (simpleMatch) {
          const start = parseInt(simpleMatch[1], 10);
          const title = simpleMatch[2].trim();
          if (title && start >= 1 && start <= pageCount) {
            results.push({ title, start, end: null });
            parsed = true;
          }
        }
      }

      if (!parsed) {
        // Format C: title then page — "Introduction, 1" or "Introduction, 1-15"
        const trailingMatch = line.match(/^(.+?)[,;:\t]\s*(\d+)(?:\s*[-–]\s*(\d+))?\s*$/);
        if (trailingMatch) {
          const title = trailingMatch[1].trim();
          const start = parseInt(trailingMatch[2], 10);
          const end = trailingMatch[3] ? parseInt(trailingMatch[3], 10) : null;
          if (title && start >= 1 && start <= pageCount) {
            results.push({ title, start, end: end && end >= start && end <= pageCount ? end : null });
            parsed = true;
          }
        }
      }

      if (!parsed) {
        // Skip unparseable lines silently
      }
    }

    return results;
  }

  function resolveBulkEndPages(entries: Array<{ title: string; start: number; end: number | null }>): Array<{ title: string; start: number; end: number }> {
    const sorted = [...entries].sort((a, b) => a.start - b.start);
    return sorted.map((entry, i) => {
      if (entry.end != null) return { title: entry.title, start: entry.start, end: entry.end };
      const nextStart = sorted[i + 1]?.start;
      const end = nextStart ? nextStart - 1 : pageCount;
      return { title: entry.title, start: entry.start, end: Math.max(entry.start, end) };
    });
  }

  function updateBulkPreview(): void {
    const parsed = parseBulkText(bulkText);
    if (parsed.length === 0 && bulkText.trim().length > 0) {
      bulkError = 'Could not parse any chapters. Check the format.';
      bulkPreview = [];
      return;
    }
    bulkError = '';
    bulkPreview = resolveBulkEndPages(parsed);
  }

  $: if (showBulkForm) updateBulkPreview();
  // also react to text changes
  $: bulkText, showBulkForm && updateBulkPreview();

  async function submitBulk(): Promise<void> {
    if (bulkPreview.length === 0) {
      bulkError = 'Nothing to import.';
      return;
    }

    busy = true;
    bulkError = '';
    try {
      const created: DocumentChapter[] = [];
      for (const entry of bulkPreview) {
        const chapter = await createChapter(documentId, {
          title: entry.title,
          startPageIndex: entry.start - 1,
          endPageIndex: entry.end - 1
        });
        created.push(chapter);
      }
      chapters = [...chapters, ...created].sort((a, b) => a.startPageIndex - b.startPageIndex);
      showBulkForm = false;
      bulkText = '';
      bulkPreview = [];
      dispatch('changed', { chapters });
    } catch (err) {
      bulkError = err instanceof Error ? err.message : 'Could not import chapters.';
    } finally {
      busy = false;
    }
  }

  // ── Edit ──

  function startEdit(chapter: DocumentChapter): void {
    editingId = chapter.id;
    editTitle = chapter.title;
    editStartPage = chapter.startPageIndex + 1;
    editEndPage = chapter.endPageIndex + 1;
  }

  function cancelEdit(): void {
    editingId = null;
  }

  async function submitEdit(): Promise<void> {
    if (!editingId) return;
    const title = editTitle.trim();
    if (!title) return;
    if (editStartPage < 1 || editEndPage < editStartPage || editEndPage > pageCount) return;

    busy = true;
    try {
      const updated = await updateChapter(editingId, {
        title,
        startPageIndex: editStartPage - 1,
        endPageIndex: editEndPage - 1
      });
      chapters = chapters.map(c => c.id === updated.id ? updated : c).sort((a, b) => a.startPageIndex - b.startPageIndex);
      editingId = null;
      dispatch('changed', { chapters });
    } catch {
      // Keep editing state
    } finally {
      busy = false;
    }
  }

  // ── Delete ──

  async function removeChapter(chapterId: string): Promise<void> {
    if (!window.confirm('Delete this chapter?')) return;

    busy = true;
    try {
      await deleteChapter(chapterId);
      chapters = chapters.filter(c => c.id !== chapterId);
      dispatch('changed', { chapters });
    } catch {
      // Best effort
    } finally {
      busy = false;
    }
  }
</script>

<div class="chapter-manager">
  <div class="chapter-header">
    <h3>Chapters</h3>
    <div class="chapter-header-actions">
      <button class="button subtle" type="button" disabled={busy} on:click={openBulkForm}>Bulk</button>
      <button class="button subtle" type="button" disabled={busy} on:click={openAddForm}>Add</button>
    </div>
  </div>

  {#if loading}
    <p class="chapter-hint">Loading...</p>
  {:else if chapters.length === 0 && !showAddForm && !showBulkForm}
    <p class="chapter-hint">No chapters defined. Add chapters individually or use Bulk to paste a list.</p>
  {:else}
    {#if activeChapter}
      <div class="chapter-current">
        Currently in: <strong>{activeChapter.title}</strong>
      </div>
    {/if}

    <div class="chapter-list">
      {#each chapters as chapter (chapter.id)}
        {#if editingId === chapter.id}
          <div class="chapter-edit-form">
            <input class="chapter-input" bind:value={editTitle} placeholder="Chapter title" maxlength="200" />
            <div class="chapter-range-row">
              <label>
                <span>Start</span>
                <input class="chapter-range-input" type="number" min="1" max={pageCount} bind:value={editStartPage} />
              </label>
              <span class="chapter-range-sep">to</span>
              <label>
                <span>End</span>
                <input class="chapter-range-input" type="number" min="1" max={pageCount} bind:value={editEndPage} />
              </label>
            </div>
            <div class="chapter-form-actions">
              <button class="button subtle" type="button" on:click={cancelEdit}>Cancel</button>
              <button class="button primary" type="button" disabled={busy} on:click={submitEdit}>Save</button>
            </div>
          </div>
        {:else}
          <div class="chapter-item" class:active={activeChapter?.id === chapter.id}>
            <div class="chapter-item-info">
              <span class="chapter-item-title">{chapter.title}</span>
              <span class="chapter-item-range">pp. {chapter.startPageIndex + 1}–{chapter.endPageIndex + 1}</span>
            </div>
            <div class="chapter-item-actions">
              <button class="chapter-action-btn" type="button" title="Edit" on:click={() => startEdit(chapter)}>E</button>
              <button class="chapter-action-btn danger" type="button" title="Delete" on:click={() => removeChapter(chapter.id)}>X</button>
            </div>
          </div>
        {/if}
      {/each}
    </div>
  {/if}

  {#if showAddForm}
    <div class="chapter-add-form">
      <input class="chapter-input" bind:value={addTitle} placeholder="Chapter title" maxlength="200" />
      <div class="chapter-range-row">
        <label>
          <span>Start page</span>
          <input class="chapter-range-input" type="number" min="1" max={pageCount} bind:value={addStartPage} />
        </label>
        <span class="chapter-range-sep">to</span>
        <label>
          <span>End page</span>
          <input class="chapter-range-input" type="number" min="1" max={pageCount} bind:value={addEndPage} />
        </label>
      </div>
      {#if addError}
        <p class="chapter-error">{addError}</p>
      {/if}
      <div class="chapter-form-actions">
        <button class="button subtle" type="button" on:click={() => showAddForm = false}>Cancel</button>
        <button class="button primary" type="button" disabled={busy || !addTitle.trim()} on:click={submitAdd}>Add Chapter</button>
      </div>
    </div>
  {/if}

  {#if showBulkForm}
    <div class="chapter-bulk-form">
      <p class="chapter-bulk-hint">
        Paste a chapter list. Accepted formats:
      </p>
      <div class="chapter-bulk-formats">
        <code>1 Introduction</code>
        <code>1-15 Introduction</code>
        <code>Introduction, 1</code>
      </div>
      <p class="chapter-bulk-hint">
        One chapter per line. If no end page is given, each chapter runs until the next.
      </p>
      <textarea
        class="chapter-bulk-textarea"
        bind:value={bulkText}
        placeholder={"1 Introduction\n16 Literature Review\n45 Methodology\n78 Results\n112 Discussion\n130 Conclusion"}
        rows="8"
      ></textarea>

      {#if bulkPreview.length > 0}
        <div class="chapter-bulk-preview">
          <span class="chapter-bulk-preview-label">{bulkPreview.length} chapter{bulkPreview.length === 1 ? '' : 's'} detected:</span>
          {#each bulkPreview as entry}
            <div class="chapter-bulk-preview-row">
              <span class="chapter-bulk-preview-title">{entry.title}</span>
              <span class="chapter-bulk-preview-range">pp. {entry.start}–{entry.end}</span>
            </div>
          {/each}
        </div>
      {/if}

      {#if bulkError}
        <p class="chapter-error">{bulkError}</p>
      {/if}
      <div class="chapter-form-actions">
        <button class="button subtle" type="button" on:click={() => { showBulkForm = false; bulkText = ''; bulkPreview = []; }}>Cancel</button>
        <button class="button primary" type="button" disabled={busy || bulkPreview.length === 0} on:click={submitBulk}>
          {busy ? 'Importing...' : `Import ${bulkPreview.length} Chapter${bulkPreview.length === 1 ? '' : 's'}`}
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .chapter-manager {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .chapter-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .chapter-header h3 {
    margin: 0;
    font-size: 0.95rem;
  }

  .chapter-header-actions {
    display: flex;
    gap: 4px;
  }

  .chapter-hint {
    margin: 0;
    font-size: 0.82rem;
    color: var(--ink-soft);
    line-height: 1.4;
  }

  .chapter-current {
    font-size: 0.82rem;
    color: var(--ink-soft);
    padding: 6px 10px;
    background: rgba(45, 110, 150, 0.08);
    border-radius: 8px;
    border: 1px solid rgba(45, 110, 150, 0.15);
  }

  .chapter-current strong {
    color: var(--ink-navy);
  }

  .chapter-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .chapter-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 10px;
    border-radius: 10px;
    border: 1px solid var(--ink-border);
    background: var(--ink-paper);
    gap: 8px;
  }

  .chapter-item.active {
    border-color: rgba(45, 110, 150, 0.3);
    background: rgba(45, 110, 150, 0.06);
  }

  .chapter-item-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }

  .chapter-item-title {
    font-size: 0.85rem;
    color: #1e2832;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chapter-item-range {
    font-size: 0.72rem;
    color: var(--ink-soft);
  }

  .chapter-item-actions {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }

  .chapter-action-btn {
    background: none;
    border: 1px solid var(--ink-border);
    border-radius: 6px;
    width: 26px;
    height: 26px;
    font-size: 0.72rem;
    cursor: pointer;
    color: var(--ink-soft);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .chapter-action-btn:hover {
    background: var(--ink-border);
  }

  .chapter-action-btn.danger:hover {
    background: rgba(165, 75, 60, 0.12);
    color: var(--ink-danger);
    border-color: rgba(165, 75, 60, 0.25);
  }

  .chapter-add-form,
  .chapter-edit-form,
  .chapter-bulk-form {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    border-radius: 10px;
    border: 1px solid var(--ink-border);
    background: var(--ink-paper);
  }

  .chapter-input {
    width: 100%;
    padding: 8px 10px;
    border: 1px solid var(--ink-border);
    border-radius: 8px;
    background: white;
    font-size: 0.88rem;
    color: #1e2832;
    outline: none;
    box-sizing: border-box;
  }

  .chapter-input:focus {
    border-color: var(--ink-blue);
  }

  .chapter-range-row {
    display: flex;
    align-items: flex-end;
    gap: 8px;
  }

  .chapter-range-row label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
  }

  .chapter-range-row label span {
    font-size: 0.72rem;
    color: var(--ink-soft);
  }

  .chapter-range-input {
    width: 100%;
    padding: 6px 8px;
    border: 1px solid var(--ink-border);
    border-radius: 6px;
    background: white;
    font-size: 0.85rem;
    color: #1e2832;
    outline: none;
    box-sizing: border-box;
  }

  .chapter-range-input:focus {
    border-color: var(--ink-blue);
  }

  .chapter-range-sep {
    font-size: 0.8rem;
    color: var(--ink-soft);
    padding-bottom: 6px;
  }

  .chapter-form-actions {
    display: flex;
    gap: 6px;
    justify-content: flex-end;
  }

  .chapter-error {
    margin: 0;
    font-size: 0.8rem;
    color: var(--ink-danger);
  }

  /* Bulk import */

  .chapter-bulk-hint {
    margin: 0;
    font-size: 0.78rem;
    color: var(--ink-soft);
    line-height: 1.4;
  }

  .chapter-bulk-formats {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .chapter-bulk-formats code {
    font-size: 0.74rem;
    background: rgba(0, 0, 0, 0.04);
    padding: 2px 6px;
    border-radius: 4px;
    color: #1e2832;
    font-family: monospace;
  }

  .chapter-bulk-textarea {
    width: 100%;
    padding: 8px 10px;
    border: 1px solid var(--ink-border);
    border-radius: 8px;
    background: white;
    font-size: 0.82rem;
    font-family: monospace;
    color: #1e2832;
    outline: none;
    resize: vertical;
    min-height: 100px;
    line-height: 1.5;
    box-sizing: border-box;
  }

  .chapter-bulk-textarea:focus {
    border-color: var(--ink-blue);
  }

  .chapter-bulk-preview {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 8px;
    background: rgba(45, 110, 150, 0.04);
    border-radius: 8px;
    border: 1px solid rgba(45, 110, 150, 0.12);
  }

  .chapter-bulk-preview-label {
    font-size: 0.74rem;
    font-weight: 600;
    color: var(--ink-blue);
    margin-bottom: 2px;
  }

  .chapter-bulk-preview-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.78rem;
    padding: 2px 0;
  }

  .chapter-bulk-preview-title {
    color: #1e2832;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .chapter-bulk-preview-range {
    color: var(--ink-soft);
    flex-shrink: 0;
    margin-left: 8px;
    font-variant-numeric: tabular-nums;
  }
</style>
