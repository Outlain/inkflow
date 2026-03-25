<script lang="ts">
  // Root application shell — routes between LibraryView and ReaderView,
  // manages activity tracking sessions and network monitor initialization.
  import { onDestroy, onMount } from 'svelte';
  import DebugOverlay from './lib/components/DebugOverlay.svelte';
  import LibraryView from './lib/components/LibraryView.svelte';
  import ReaderView from './lib/components/ReaderView.svelte';
  import { navigate, readCurrentRoute, type AppRoute } from './lib/router';
  import { getAppSession, getStudySession, initTabCoordination } from './lib/activity';
  import { initNetworkMonitor } from './lib/networkMonitor';
  import NetworkToast from './lib/components/NetworkToast.svelte';
  import { loadReaderBrowserSafeTopbar, saveReaderBrowserSafeTopbar } from './lib/readerChromeMode';

  let route: AppRoute = { name: 'library' };
  let readerBrowserSafeTopbar = true;
  const appSessionManager = getAppSession();
  const studySessionManager = getStudySession();

  function syncRoute(): void {
    route = readCurrentRoute();
  }

  function openDocument(documentId: string): void {
    route = navigate({
      name: 'document',
      documentId
    });
    studySessionManager.openDocument(documentId);
  }

  function closeDocument(): void {
    studySessionManager.closeDocument();
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
    readerBrowserSafeTopbar = loadReaderBrowserSafeTopbar();
    syncRoute();
    window.addEventListener('popstate', syncRoute);

    // Initialize network quality monitor
    initNetworkMonitor();

    // Initialize multi-tab coordination
    initTabCoordination();

    // Start app-level activity tracking
    appSessionManager.start();

    // If app loaded directly on a document route, start study session
    if (route.name === 'document') {
      studySessionManager.openDocument(route.documentId);
    }

    return () => window.removeEventListener('popstate', syncRoute);
  });

  onDestroy(() => {
    syncReaderRouteClass(false);
    appSessionManager.stop();
    studySessionManager.closeDocument();
  });

  $: syncReaderRouteClass(route.name === 'document');
</script>

{#if route.name === 'document'}
  <ReaderView browserSafeTopbar={readerBrowserSafeTopbar} documentId={route.documentId} on:close={closeDocument} />
{:else}
  <LibraryView
    browserSafeTopbar={readerBrowserSafeTopbar}
    on:openDocument={(event) => openDocument(event.detail.documentId)}
    on:toggleBrowserSafeTopbar={(event) => {
      readerBrowserSafeTopbar = event.detail.enabled;
      saveReaderBrowserSafeTopbar(readerBrowserSafeTopbar);
    }}
  />
{/if}

<NetworkToast />
<DebugOverlay />
