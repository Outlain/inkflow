export type AppRoute =
  | { name: 'library' }
  | {
      name: 'document';
      documentId: string;
    };

function routeFromUrl(url: URL): AppRoute {
  const match = url.pathname.match(/^\/documents\/([^/]+)$/);
  if (match) {
    return {
      name: 'document',
      documentId: decodeURIComponent(match[1])
    };
  }

  return { name: 'library' };
}

export function readCurrentRoute(): AppRoute {
  return routeFromUrl(new URL(window.location.href));
}

export function routeHref(route: AppRoute): string {
  if (route.name === 'document') {
    return `/documents/${encodeURIComponent(route.documentId)}`;
  }

  return '/';
}

export function navigate(route: AppRoute, replace = false): AppRoute {
  const nextUrl = routeHref(route);
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (replace) {
    window.history.replaceState({}, '', nextUrl);
  } else if (current !== nextUrl) {
    window.history.pushState({}, '', nextUrl);
  }

  return route;
}
