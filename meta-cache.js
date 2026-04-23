// Two-tier cache for track mood metadata (Spotify audio-features). Memory
// Map on top, IndexedDB underneath. No TTL — audio-features are a fixed
// analysis of the audio and never change for a given track.
//
// Exposed as window.MetaCache with async get(key) / set(key, val).
//
// Why IndexedDB over localStorage: audio-features objects are small but we
// want to cache across sessions and across many thousands of tracks; IDB's
// key/value store doesn't parse/serialize on every access the way
// localStorage would.

(() => {
  const DB_NAME    = 'studiojoe-meta';
  const DB_VERSION = 1;
  const STORE      = 'tracks';

  const memory = new Map();
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error('IndexedDB not available'));
        return;
      }
      const req = window.indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
    return dbPromise;
  }

  async function get(key) {
    if (memory.has(key)) return memory.get(key);
    try {
      const db  = await openDB();
      const tx  = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      const row = await new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
      });
      if (row) {
        memory.set(key, row.value);
        return row.value;
      }
    } catch (err) {
      // IDB unavailable (private mode, quota errors, etc.) — fall back to
      // memory-only operation. Not fatal; next session just refetches.
      console.warn('[meta-cache] get failed', err);
    }
    return null;
  }

  async function set(key, value) {
    memory.set(key, value);
    try {
      const db = await openDB();
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ key, value });
      await new Promise((resolve) => {
        tx.oncomplete = () => resolve();
        tx.onerror    = () => resolve();   // swallow — memory cache still holds it
      });
    } catch (err) {
      console.warn('[meta-cache] set failed', err);
    }
  }

  window.MetaCache = { get, set };
})();
