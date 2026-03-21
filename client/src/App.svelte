<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import DebugOverlay from './lib/components/DebugOverlay.svelte';
  import LibraryView from './lib/components/LibraryView.svelte';
  import ReaderView from './lib/components/ReaderView.svelte';
  import { navigate, readCurrentRoute, type AppRoute } from './lib/router';

  let route: AppRoute = { name: 'library' };

  function syncRoute(): void {
    route = readCurrentRoute();
  }

  function openDocument(documentId: string): void {
    route = navigate({
      name: 'document',
      documentId
    });
  }

  function closeDocument(): void {
    route = navigate({ name: 'library' });
  }

  function syncReaderRouteClass(active: boolean): void {
    if (typeof document === 'undefined') {
      return;
    }

    document.documentElement.classList.toggle('reader-route-active', active);
    document.body.classList.toggle('reader-route-active', active);
  }

  onMount(() => {
    syncRoute();
    window.addEventListener('popstate', syncRoute);
    return () => window.removeEventListener('popstate', syncRoute);
  });

  onDestroy(() => {
    syncReaderRouteClass(false);
  });

  $: syncReaderRouteClass(route.name === 'document');
</script>

{#if route.name === 'document'}
  <ReaderView documentId={route.documentId} on:close={closeDocument} />
{:else}
  <LibraryView on:openDocument={(event) => openDocument(event.detail.documentId)} />
{/if}

<DebugOverlay />
