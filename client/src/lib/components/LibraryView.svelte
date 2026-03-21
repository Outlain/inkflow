<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { createFolder, createNotebook, deleteDocument, deleteFolder, fetchLibrary, importPdf } from '../api';
  import type { DocumentSummary, LibraryPayload, NotebookTemplate } from '@shared/contracts';

  const dispatch = createEventDispatcher<{ openDocument: { documentId: string } }>();

  type ModalKind = 'folder' | 'notebook' | null;

  const folderColors = ['#587fa1', '#2d8a6d', '#c87535', '#9a5b8b', '#8b6f46'];
  const coverColors = ['#315f85', '#2f7b7f', '#b85d3a', '#8062a8', '#6d8a42'];

  let library: LibraryPayload = { folders: [], documents: [] };
  let loading = true;
  let busy = false;
  let uploading = false;
  let errorMessage = '';
  let statusMessage = 'The library is ready for fresh notebooks and real PDF imports.';
  let modal: ModalKind = null;
  let filePicker: HTMLInputElement | null = null;
  let selectedImportFolderId: string | null = null;

  let folderForm = {
    title: '',
    color: folderColors[0]
  };

  let notebookForm = {
    title: '',
    template: 'ruled' as NotebookTemplate,
    pageCount: 24,
    folderId: '',
    coverColor: coverColors[0]
  };

  const templateLabels: Record<NotebookTemplate, string> = {
    blank: 'Blank paper',
    ruled: 'Ruled paper',
    grid: 'Grid paper',
    dot: 'Dot paper'
  };

  async function loadLibrary(): Promise<void> {
    loading = true;
    errorMessage = '';

    try {
      library = await fetchLibrary();
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Could not load the library.';
    } finally {
      loading = false;
    }
  }

  onMount(loadLibrary);

  function openFolderModal(): void {
    folderForm = {
      title: '',
      color: folderColors[0]
    };
    modal = 'folder';
  }

  function openNotebookModal(): void {
    notebookForm = {
      title: '',
      template: 'ruled',
      pageCount: 24,
      folderId: library.folders[0]?.id ?? '',
      coverColor: coverColors[0]
    };
    modal = 'notebook';
  }

  function folderName(folderId: string | null): string {
    if (!folderId) return 'Library Root';
    return library.folders.find((folder) => folder.id === folderId)?.title ?? 'Unknown folder';
  }

  function formatRelativeDate(timestamp: string): string {
    const value = new Date(timestamp);
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }).format(value);
  }

  async function submitFolder(): Promise<void> {
    if (!folderForm.title.trim()) {
      errorMessage = 'Folder title is required.';
      return;
    }

    busy = true;
    errorMessage = '';

    try {
      library = await createFolder({
        title: folderForm.title.trim(),
        color: folderForm.color
      });
      statusMessage = `Created folder "${folderForm.title.trim()}".`;
      modal = null;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Could not create folder.';
    } finally {
      busy = false;
    }
  }

  async function submitNotebook(): Promise<void> {
    if (!notebookForm.title.trim()) {
      errorMessage = 'Notebook title is required.';
      return;
    }

    busy = true;
    errorMessage = '';

    try {
      const bundle = await createNotebook({
        title: notebookForm.title.trim(),
        template: notebookForm.template,
        pageCount: Math.max(1, Math.min(400, Number(notebookForm.pageCount) || 1)),
        folderId: notebookForm.folderId || null,
        coverColor: notebookForm.coverColor
      });
      modal = null;
      dispatch('openDocument', { documentId: bundle.document.id });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Could not create notebook.';
    } finally {
      busy = false;
    }
  }

  async function triggerImport(event: Event): Promise<void> {
    const target = event.currentTarget as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) return;

    uploading = true;
    errorMessage = '';
    statusMessage = `Importing ${file.name}...`;

    try {
      const bundle = await importPdf(file, selectedImportFolderId);
      dispatch('openDocument', { documentId: bundle.document.id });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Could not import PDF.';
    } finally {
      uploading = false;
      if (filePicker) {
        filePicker.value = '';
      }
    }
  }

  function chooseImportFolder(folderId: string | null): void {
    selectedImportFolderId = folderId;
    filePicker?.click();
  }

  async function removeFolder(folderId: string): Promise<void> {
    if (!window.confirm('Delete this folder and every document inside it?')) {
      return;
    }

    busy = true;
    errorMessage = '';

    try {
      library = await deleteFolder(folderId);
      statusMessage = 'Folder deleted.';
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Could not delete folder.';
    } finally {
      busy = false;
    }
  }

  async function removeDocument(document: DocumentSummary): Promise<void> {
    if (!window.confirm(`Delete "${document.title}"?`)) {
      return;
    }

    busy = true;
    errorMessage = '';

    try {
      library = await deleteDocument(document.id);
      statusMessage = `Deleted "${document.title}".`;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Could not delete document.';
    } finally {
      busy = false;
    }
  }

  function closeModal(): void {
    modal = null;
  }

  function handleBackdropClick(event: MouseEvent): void {
    if (event.currentTarget === event.target) {
      closeModal();
    }
  }

  $: documentCount = library.documents.length;
  $: notebookCount = library.documents.filter((document) => document.kind === 'notebook').length;
  $: pdfCount = library.documents.filter((document) => document.kind === 'pdf').length;
  $: sortedDocuments = [...library.documents].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
</script>

<svelte:head>
  <title>Inkflow Library</title>
</svelte:head>

<div class="screen-shell">
  <div class="layout">
    <section class="topbar">
      <div class="brand-block">
        <div class="brand-mark">I</div>
        <div>
          <p class="eyebrow">Inkflow Library</p>
          <h1 class="title">Inkflow</h1>
          <p class="subtitle">
            Self-hosted notes and textbook reading rebuilt around fixed page metadata, large-PDF imports, and a reader engine that stays stable under load.
          </p>
        </div>
      </div>

      <div class="action-row">
        <button class="button" type="button" on:click={openFolderModal}>New Folder</button>
        <button class="button" type="button" on:click={openNotebookModal}>New Notebook</button>
        <button class="button primary" type="button" on:click={() => chooseImportFolder(null)}>
          {uploading ? 'Importing…' : 'Import PDF'}
        </button>
      </div>
    </section>

    <section class="hero-grid">
      <article class="panel">
        <h2>Single container, real PDFs, clean storage, reader-first rebuild.</h2>
        <p>
          SQLite runs in WAL mode, uploads stream directly into `/app/data`, and the document model already carries the page dimensions the reader needs to avoid shell resizing later.
        </p>

        <div class="metric-row">
          <div class="metric">
            <span>Documents</span>
            <strong>{documentCount}</strong>
          </div>
          <div class="metric">
            <span>Notebooks</span>
            <strong>{notebookCount}</strong>
          </div>
          <div class="metric">
            <span>Imported PDFs</span>
            <strong>{pdfCount}</strong>
          </div>
        </div>
      </article>

      <aside class="panel">
        <div class="panel-row">
          <div>
            <h3>Folders</h3>
            <p>Organize documents now so bookmarks, inserts, and exports stay predictable later.</p>
          </div>
          <button class="button subtle" type="button" on:click={openFolderModal}>Add</button>
        </div>

        <div class="folder-list">
          <button class="folder-pill root" type="button" on:click={() => chooseImportFolder(null)}>
            <span class="folder-dot" style="background:#c5b394"></span>
            <span>Library Root</span>
            <small>Import here</small>
          </button>

          {#each library.folders as folder}
            <div class="folder-item">
              <button class="folder-pill" type="button" on:click={() => chooseImportFolder(folder.id)}>
                <span class="folder-dot" style={`background:${folder.color}`}></span>
                <span>{folder.title}</span>
                <small>Import here</small>
              </button>
              <button class="icon-button danger" type="button" disabled={busy} on:click={() => removeFolder(folder.id)}>Delete</button>
            </div>
          {/each}
        </div>
      </aside>
    </section>

    {#if errorMessage}
      <div class="status-banner error">{errorMessage}</div>
    {:else}
      <div class="status-banner">{statusMessage}</div>
    {/if}

    <section class="panel">
      <div class="panel-row">
        <div>
          <h2>Library</h2>
          <p>Open a notebook or textbook to drop directly into the continuous reader.</p>
        </div>
      </div>

      {#if loading}
        <div class="empty-state">Loading the library…</div>
      {:else if sortedDocuments.length === 0}
        <div class="empty-state">
          Start with a notebook or import one of the real textbook PDFs. Later gates rely on using those large artifacts in the actual reader, not just in the import pipeline.
        </div>
      {:else}
        <div class="library-grid">
          {#each sortedDocuments as document (document.id)}
            <article class="document-card">
              <button class="document-open" type="button" on:click={() => dispatch('openDocument', { documentId: document.id })}>
                <div class="document-cover" style={`background: linear-gradient(160deg, ${document.coverColor} 0%, rgba(17, 30, 44, 0.88) 100%)`}>
                  <span class="document-kind">{document.kind === 'pdf' ? 'PDF' : 'Notebook'}</span>
                </div>

                <div>
                  <h3>{document.title}</h3>
                  <p class="document-folder">{folderName(document.folderId)}</p>
                </div>

                <div class="document-meta">
                  <span>{document.pageCount} pages</span>
                  <span>{formatRelativeDate(document.updatedAt)}</span>
                </div>
              </button>

              <div class="document-actions">
                <button class="button subtle" type="button" on:click={() => dispatch('openDocument', { documentId: document.id })}>Open</button>
                <button class="button subtle danger" type="button" disabled={busy} on:click={() => removeDocument(document)}>Delete</button>
              </div>
            </article>
          {/each}
        </div>
      {/if}
    </section>
  </div>

  <input
    bind:this={filePicker}
    class="hidden-input"
    type="file"
    accept="application/pdf,.pdf"
    on:change={triggerImport}
  />

  {#if modal === 'folder'}
    <div class="modal-backdrop" role="presentation" on:click={handleBackdropClick}>
      <div class="modal" role="dialog" aria-modal="true" tabindex="-1">
        <header>
          <h3>Create folder</h3>
          <p>Keep the library tidy before the reader keeps reopen state, inserts, and exports.</p>
        </header>

        <div class="field">
          <label for="folder-title">Title</label>
          <input id="folder-title" bind:value={folderForm.title} maxlength="80" placeholder="Semester notes" />
        </div>

        <div class="field">
          <span>Color</span>
          <div class="palette">
            {#each folderColors as color}
              <button
                class:active={folderForm.color === color}
                class="swatch"
                aria-label={`Choose folder color ${color}`}
                style={`background:${color}`}
                type="button"
                on:click={() => (folderForm.color = color)}
              ></button>
            {/each}
          </div>
        </div>

        <div class="modal-actions">
          <button class="button" type="button" on:click={closeModal}>Cancel</button>
          <button class="button primary" type="button" disabled={busy} on:click={submitFolder}>Create folder</button>
        </div>
      </div>
    </div>
  {/if}

  {#if modal === 'notebook'}
    <div class="modal-backdrop" role="presentation" on:click={handleBackdropClick}>
      <div class="modal" role="dialog" aria-modal="true" tabindex="-1">
        <header>
          <h3>Create notebook</h3>
          <p>New notebooks already use the fixed-size page metadata the stable reader depends on.</p>
        </header>

        <div class="field">
          <label for="notebook-title">Title</label>
          <input id="notebook-title" bind:value={notebookForm.title} maxlength="120" placeholder="Calculus working notebook" />
        </div>

        <div class="field">
          <label for="notebook-template">Paper template</label>
          <select id="notebook-template" bind:value={notebookForm.template}>
            {#each Object.entries(templateLabels) as [value, label]}
              <option value={value}>{label}</option>
            {/each}
          </select>
        </div>

        <div class="field">
          <label for="notebook-pages">Initial page count</label>
          <input id="notebook-pages" bind:value={notebookForm.pageCount} min="1" max="400" type="number" />
        </div>

        <div class="field">
          <label for="notebook-folder">Folder</label>
          <select id="notebook-folder" bind:value={notebookForm.folderId}>
            <option value="">Library Root</option>
            {#each library.folders as folder}
              <option value={folder.id}>{folder.title}</option>
            {/each}
          </select>
        </div>

        <div class="field">
          <span>Cover color</span>
          <div class="palette">
            {#each coverColors as color}
              <button
                class:active={notebookForm.coverColor === color}
                class="swatch"
                aria-label={`Choose notebook cover color ${color}`}
                style={`background:${color}`}
                type="button"
                on:click={() => (notebookForm.coverColor = color)}
              ></button>
            {/each}
          </div>
        </div>

        <div class="modal-actions">
          <button class="button" type="button" on:click={closeModal}>Cancel</button>
          <button class="button primary" type="button" disabled={busy} on:click={submitNotebook}>Create notebook</button>
        </div>
      </div>
    </div>
  {/if}
</div>
