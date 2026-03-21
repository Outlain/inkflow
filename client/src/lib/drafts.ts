import type { Annotation } from '@shared/contracts';

export interface PageDraftRecord {
  pageId: string;
  documentId: string;
  annotations: Annotation[];
  annotationText: string;
  annotationRevision: number;
  updatedAt: string;
  dirty: boolean;
}

const DB_NAME = 'inkflow-drafts';
const STORE_NAME = 'pageDrafts';
const DB_VERSION = 1;

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) {
    return databasePromise;
  }

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'pageId' });
        store.createIndex('documentId', 'documentId', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open drafts database.'));
  });

  return databasePromise;
}

async function transact<T>(mode: IDBTransactionMode, execute: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase();

  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    const request = execute(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Draft transaction failed.'));
  });
}

export async function readDraft(pageId: string): Promise<PageDraftRecord | null> {
  const record = await transact<PageDraftRecord | undefined>('readonly', (store) => store.get(pageId));
  return record ?? null;
}

export async function writeDraft(record: PageDraftRecord): Promise<void> {
  await transact('readwrite', (store) => store.put(record));
}

export async function deleteDraft(pageId: string): Promise<void> {
  await transact('readwrite', (store) => store.delete(pageId));
}
