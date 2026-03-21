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

interface StoredPageDraftRecord extends Omit<PageDraftRecord, 'pageId'> {
  pageId?: string;
  id?: string;
}

const DB_NAME = 'inkflow-drafts';
const STORE_NAME = 'pageDrafts';
const DB_VERSION = 2;

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) {
    return databasePromise;
  }

  databasePromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available.'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      const transaction = request.transaction;

      if (!database.objectStoreNames.contains(STORE_NAME)) {
        createDraftStore(database);
        return;
      }

      if (!transaction) {
        return;
      }

      const store = transaction.objectStore(STORE_NAME);
      const hasPageIdKeyPath = store.keyPath === 'pageId';
      if (!hasPageIdKeyPath) {
        // Older browsers may still have a legacy store schema; recreate it so writes are keyed by pageId.
        database.deleteObjectStore(STORE_NAME);
        createDraftStore(database);
        return;
      }

      if (!store.indexNames.contains('documentId')) {
        store.createIndex('documentId', 'documentId', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onblocked = () => reject(new Error('Draft database upgrade is blocked.'));
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
    transaction.onabort = () => reject(transaction.error ?? new Error('Draft transaction aborted.'));
    transaction.onerror = () => reject(transaction.error ?? new Error('Draft transaction failed.'));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Draft transaction failed.'));
  });
}

export async function readDraft(pageId: string): Promise<PageDraftRecord | null> {
  const record = await transact<StoredPageDraftRecord | undefined>('readonly', (store) => store.get(pageId));
  return normalizeDraftRecord(record);
}

export async function writeDraft(record: PageDraftRecord): Promise<void> {
  if (!record.pageId) {
    throw new Error('Cannot write draft without a page id.');
  }

  const storedRecord: StoredPageDraftRecord = {
    ...record,
    id: record.pageId
  };

  await transact('readwrite', (store) => store.put(storedRecord));
}

export async function deleteDraft(pageId: string): Promise<void> {
  await transact('readwrite', (store) => store.delete(pageId));
}

function createDraftStore(database: IDBDatabase): IDBObjectStore {
  const store = database.createObjectStore(STORE_NAME, { keyPath: 'pageId' });
  store.createIndex('documentId', 'documentId', { unique: false });
  return store;
}

function normalizeDraftRecord(record?: StoredPageDraftRecord): PageDraftRecord | null {
  if (!record) {
    return null;
  }

  const pageId = record.pageId ?? record.id;
  if (!pageId) {
    return null;
  }

  return {
    pageId,
    documentId: record.documentId,
    annotations: record.annotations,
    annotationText: record.annotationText,
    annotationRevision: record.annotationRevision,
    updatedAt: record.updatedAt,
    dirty: record.dirty
  };
}
