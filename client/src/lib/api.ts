/** REST API client — typed wrappers around every backend endpoint. */

import type {
  BookmarkPayload,
  CreateFolderInput,
  CreateNotebookInput,
  DocumentBundle,
  InsertBlankPageRequest,
  LibraryPayload,
  PageAnnotationsPayload,
  SavePageRequest,
  SavePageResponse,
  SearchResponse
} from '@shared/contracts';

async function readError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error ?? `Request failed with ${response.status}`;
  } catch {
    return `Request failed with ${response.status}`;
  }
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(await readError(response));
  }

  return (await response.json()) as T;
}

export async function fetchLibrary(): Promise<LibraryPayload> {
  return readJson<LibraryPayload>(await fetch('/api/library'));
}

export async function createFolder(input: CreateFolderInput): Promise<LibraryPayload> {
  return readJson<LibraryPayload>(
    await fetch('/api/folders', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(input)
    })
  );
}

export async function deleteFolder(folderId: string): Promise<LibraryPayload> {
  return readJson<LibraryPayload>(await fetch(`/api/folders/${folderId}`, { method: 'DELETE' }));
}

export async function createNotebook(input: CreateNotebookInput): Promise<DocumentBundle> {
  return readJson<DocumentBundle>(
    await fetch('/api/documents/notebook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(input)
    })
  );
}

export async function importPdf(file: File, folderId: string | null): Promise<DocumentBundle> {
  const formData = new FormData();
  formData.set('file', file);
  if (folderId) {
    formData.set('folderId', folderId);
  }

  return readJson<DocumentBundle>(
    await fetch('/api/documents/import-pdf', {
      method: 'POST',
      body: formData
    })
  );
}

export async function fetchDocument(documentId: string): Promise<DocumentBundle> {
  return readJson<DocumentBundle>(await fetch(`/api/documents/${documentId}`));
}

export async function deleteDocument(documentId: string): Promise<LibraryPayload> {
  return readJson<LibraryPayload>(await fetch(`/api/documents/${documentId}`, { method: 'DELETE' }));
}

export async function fetchPageAnnotations(pageId: string): Promise<PageAnnotationsPayload> {
  return readJson<PageAnnotationsPayload>(await fetch(`/api/pages/${pageId}/annotations`));
}

export async function savePage(pageId: string, input: Omit<SavePageRequest, 'pageId'>): Promise<SavePageResponse> {
  return readJson<SavePageResponse>(
    await fetch(`/api/pages/${pageId}/annotations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(input)
    })
  );
}

export async function searchDocument(documentId: string, query: string): Promise<SearchResponse> {
  const url = new URL(`/api/documents/${documentId}/search`, window.location.origin);
  url.searchParams.set('query', query);
  return readJson<SearchResponse>(await fetch(url));
}

export async function updateBookmark(documentId: string, payload: BookmarkPayload): Promise<DocumentBundle> {
  return readJson<DocumentBundle>(
    await fetch(`/api/documents/${documentId}/bookmark`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload)
    })
  );
}

export async function insertBlankPage(documentId: string, payload: InsertBlankPageRequest): Promise<DocumentBundle> {
  return readJson<DocumentBundle>(
    await fetch(`/api/documents/${documentId}/pages/blank`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload)
    })
  );
}

export async function insertPdfPages(params: {
  documentId: string;
  file: File;
  anchorPageId: string;
  placement: 'before' | 'after';
  pageRange: string;
}): Promise<DocumentBundle> {
  const formData = new FormData();
  formData.set('file', params.file);
  formData.set('anchorPageId', params.anchorPageId);
  formData.set('placement', params.placement);
  formData.set('pageRange', params.pageRange);

  return readJson<DocumentBundle>(
    await fetch(`/api/documents/${params.documentId}/pages/import-pdf`, {
      method: 'POST',
      body: formData
    })
  );
}

export async function deletePage(pageId: string): Promise<DocumentBundle> {
  return readJson<DocumentBundle>(await fetch(`/api/pages/${pageId}`, { method: 'DELETE' }));
}
