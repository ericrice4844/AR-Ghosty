// Evidence (photos) in IndexedDB; settings and progress in localStorage.

const DB_NAME = 'ar-ghosty';
let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction('photos', mode);
    const store = t.objectStore('photos');
    const r = fn(store);
    t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

export const photos = {
  add: (p) => tx('readwrite', (s) => s.put(p)).catch((e) => console.warn('photo save failed', e)),
  all: async () => {
    try {
      const list = await tx('readonly', (s) => s.getAll());
      return (list || []).sort((a, b) => b.time - a.time);
    } catch { return []; }
  },
  remove: (id) => tx('readwrite', (s) => s.delete(id)),
  clear: () => tx('readwrite', (s) => s.clear()),
};

function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? { ...fallback, ...JSON.parse(v) } : { ...fallback };
  } catch { return { ...fallback }; }
}
function save(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* storage full or blocked */ }
}

export const settings = load('ghosty.settings', {
  sound: true,
  jumpscares: true,
  intensity: 1, // 0.5 unsettling, 1 terrifying
  subtitles: true,
  headphones: false, // verified by the knock test
  film: 6,
  lightCal: null, // { bright, dark }
  seenWarning: false,
});
export const saveSettings = () => save('ghosty.settings', settings);

export const progress = load('ghosty.progress', {
  seen: {}, // ghost id -> times encountered
  photographed: {}, // ghost id -> best score
  outcomes: {}, // ghost id -> [outcome keys]
  learned: {}, // ghost id -> true once you understand what it wants
  hunts: 0,
  bestHunt: 0,
  total: 0,
});
export const saveProgress = () => save('ghosty.progress', progress);

export function resetAll() {
  try {
    localStorage.removeItem('ghosty.progress');
    localStorage.removeItem('ghosty.settings');
  } catch { /* ignore */ }
  return photos.clear();
}
