import type { RegionPackWire } from '../schema/regionPack';

/**
 * The pack library (plan Phase 5 §3): packs saved in this browser's IndexedDB. Storage can be missing
 * or refused (private windows, blocked site data, some embedded views), so every call is wrapped and
 * reports failure as a value; the page works without it and says so.
 */

const DB_NAME = 'meridian';
const STORE = 'packs';

export interface SavedPackSummary {
  id: string;
  name: string;
  savedAt: string;
  regions: number;
  meshVersion: string;
  edited: boolean;
}

interface SavedPack extends SavedPackSummary {
  pack: RegionPackWire;
}

export type Stored<T> = { ok: true; value: T } | { ok: false; reason: string };

const reasonOf = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)) || 'storage unavailable';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE))
        req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB could not be opened'));
    req.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  }).catch((err: unknown) => {
    opening = null;
    throw err;
  });
  return opening;
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => Promise<T>,
): Promise<Stored<T>> {
  try {
    const db = await open();
    const tx = db.transaction(STORE, mode);
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
    const [value] = await Promise.all([run(tx.objectStore(STORE)), done]);
    return { ok: true, value };
  } catch (err) {
    return { ok: false, reason: reasonOf(err) };
  }
}

export async function listSaved(): Promise<Stored<SavedPackSummary[]>> {
  const result = await withStore('readonly', (store) => request(store.getAll() as IDBRequest<SavedPack[]>));
  if (!result.ok) return result;
  try {
    const summaries = result.value
      .map(({ id, name, savedAt, regions, meshVersion, edited }) => ({
        id,
        name,
        savedAt,
        regions,
        meshVersion,
        edited,
      }))
      .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
    return { ok: true, value: summaries };
  } catch (err) {
    return { ok: false, reason: reasonOf(err) };
  }
}

export async function savePack(name: string, pack: RegionPackWire): Promise<Stored<string>> {
  try {
    const id = crypto.randomUUID();
    const record: SavedPack = {
      id,
      name,
      savedAt: new Date().toISOString(),
      regions: pack.regions.length,
      meshVersion: pack.meta.meshVersion,
      edited: !!pack.meta.edited,
      pack,
    };
    const result = await withStore('readwrite', (store) => request(store.put(record)));
    return result.ok ? { ok: true, value: id } : result;
  } catch (err) {
    return { ok: false, reason: reasonOf(err) };
  }
}

export async function getSaved(id: string): Promise<Stored<RegionPackWire>> {
  const result = await withStore('readonly', (store) =>
    request(store.get(id) as IDBRequest<SavedPack | undefined>),
  );
  if (!result.ok) return result;
  return result.value ? { ok: true, value: result.value.pack } : { ok: false, reason: `no saved pack ${id}` };
}

export async function deleteSaved(id: string): Promise<Stored<void>> {
  return withStore('readwrite', async (store) => {
    await request(store.delete(id));
  });
}
