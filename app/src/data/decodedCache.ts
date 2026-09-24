/**
 * Decoded artefacts kept in IndexedDB (plan Phase 7 §1), so opening the splitter a second time skips
 * fetching, gunzipping, parsing and decoding the mesh and attributes. Entries are keyed by the
 * artefacts' fingerprinted URLs, which change whenever a file's bytes do (a new meshVersion, a new
 * census), so a stale entry can never be read; writing a new key drops the others.
 *
 * A separate database from the pack library (src/import/library.ts), so neither schema moves the
 * other's version. Like the library, every call is wrapped: without storage the cache is a no-op and
 * the page loads from the network.
 */

const DB_NAME = 'meridian-decoded';
const STORE = 'decoded';

export interface DecodedCache<T> {
  get(key: string): Promise<T | null>;
  /** Stores `value` under `key` and deletes every other entry. Resolves false if storage refused. */
  put(key: string, value: T): Promise<boolean>;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function open(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB could not be opened'));
    req.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  });
}

export function indexedDbCache<T>(): DecodedCache<T> {
  let db: Promise<IDBDatabase> | null = null;
  const database = () => (db ??= open().catch((err: unknown) => ((db = null), Promise.reject(err))));
  return {
    async get(key) {
      try {
        const store = (await database()).transaction(STORE, 'readonly').objectStore(STORE);
        return ((await request(store.get(key))) as T | undefined) ?? null;
      } catch {
        return null;
      }
    },
    async put(key, value) {
      try {
        const tx = (await database()).transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const done = new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
          tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
        });
        for (const other of await request(store.getAllKeys())) if (other !== key) store.delete(other);
        store.put(value, key);
        await done;
        return true;
      } catch {
        return false;
      }
    },
  };
}
