// Tiny IndexedDB wrapper with an in-memory fallback (used if the browser blocks storage).
const DB_NAME = 'brick-sorter';
const DB_VERSION = 1;

const SCHEMA = {
  kv: { keyPath: 'key', indexes: [] },
  sets: { keyPath: 'set_num', indexes: [] },
  setParts: { keyPath: 'id', indexes: [['set_num', 'set_num']] },
  categories: { keyPath: 'id', indexes: [] },
};

export let persistent = true;

const mem = {};
for (const name of Object.keys(SCHEMA)) mem[name] = new Map();

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (!('indexedDB' in window)) throw new Error('IndexedDB unavailable');
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        for (const [name, def] of Object.entries(SCHEMA)) {
          if (d.objectStoreNames.contains(name)) continue;
          const store = d.createObjectStore(name, { keyPath: def.keyPath });
          for (const [indexName, path] of def.indexes) store.createIndex(indexName, path);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { persistent = false; resolve(null); };
    } catch {
      persistent = false;
      resolve(null);
    }
  });
  return dbPromise;
}

// Runs fn(store) inside one transaction; resolves with fn's request result (if it returns one).
async function run(storeName, mode, fn) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const t = d.transaction(storeName, mode);
    let out;
    try { out = fn(t.objectStore(storeName)); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function get(store, key) {
  if (!(await open())) return mem[store].get(key);
  return run(store, 'readonly', (s) => s.get(key));
}

export async function put(store, obj) {
  if (!(await open())) { mem[store].set(obj[SCHEMA[store].keyPath], obj); return; }
  await run(store, 'readwrite', (s) => { s.put(obj); });
}

export async function putMany(store, objs) {
  if (!(await open())) {
    for (const o of objs) mem[store].set(o[SCHEMA[store].keyPath], o);
    return;
  }
  await run(store, 'readwrite', (s) => { for (const o of objs) s.put(o); });
}

export async function del(store, key) {
  if (!(await open())) { mem[store].delete(key); return; }
  await run(store, 'readwrite', (s) => { s.delete(key); });
}

export async function all(store) {
  if (!(await open())) return [...mem[store].values()];
  return run(store, 'readonly', (s) => s.getAll());
}

export async function byIndex(store, index, value) {
  if (!(await open())) return [...mem[store].values()].filter((o) => o[index] === value);
  return run(store, 'readonly', (s) => s.index(index).getAll(value));
}

export async function delByIndex(store, index, value) {
  if (!(await open())) {
    for (const [k, o] of mem[store]) if (o[index] === value) mem[store].delete(k);
    return;
  }
  await run(store, 'readwrite', (s) => {
    const req = s.index(index).openKeyCursor(IDBKeyRange.only(value));
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) { s.delete(cur.primaryKey); cur.continue(); }
    };
  });
}

export async function clear(store) {
  if (!(await open())) { mem[store].clear(); return; }
  await run(store, 'readwrite', (s) => { s.clear(); });
}

export async function getSetting(key) {
  const row = await get('kv', key);
  return row ? row.value : undefined;
}

export async function setSetting(key, value) {
  await put('kv', { key, value });
}

export async function isPersistent() {
  await open();
  return persistent;
}
