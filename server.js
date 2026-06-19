// hCaptcha Trainer Pro — KB Sync Server
// Design: LIGHTWEIGHT, TARGETED calls — har task individually turant server pe
// jaata hai (poori KB dobara nahi bhejni padti), taake slow internet pe bhi
// foran sync ho aur koi naya task miss na ho.

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();

// ===== CONFIG (Railway environment variables se aati hain) =====
const PORT = process.env.PORT || 3000;
const SECRET = process.env.SYNC_SECRET || 'change-me-please';
const DATA_DIR = process.env.DATA_DIR || '/data';
const KB_FILE = path.join(DATA_DIR, 'kb.json');

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}

app.use(express.json({ limit: '60mb' }));

// Browser/proxy kabhi bhi PURANI app.js ya purana data cache na kare — isi
// se "naya fix bhi kaam nahi kar raha" jaisi confusing situations bani thi.
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// CORS — extension (chrome-extension://...) se requests allow karo
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Sync-Secret');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function auth(req, res, next) {
  const given = req.header('X-Sync-Secret') || req.query.secret || '';
  if (given !== SECRET) return res.status(401).json({ error: 'Unauthorized — galat secret' });
  next();
}

// ===== STORAGE HELPERS =====
function readStore() {
  try {
    return JSON.parse(fs.readFileSync(KB_FILE, 'utf8'));
  } catch (e) {
    return { kb: {}, snaps: {}, unsolved: [], task_numbers: {}, task_counter: 0, phash_index: {} };
  }
}
function writeStore(store) {
  store.updatedAt = Date.now();
  fs.writeFileSync(KB_FILE, JSON.stringify(store));
  return store;
}
function hammingDist(a, b) {
  if (!a || !b || a.length !== b.length) return 999;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

// ===== HEALTH =====
app.get('/health', (req, res) => {
  const s = readStore();
  res.json({
    ok: true, service: 'hCaptcha KB Sync',
    kbCount: Object.keys(s.kb || {}).length,
    unsolvedCount: (s.unsolved || []).length
  });
});

// ===== LIGHTWEIGHT: SOLVE CHECK =====
// Extension har naye/unknown challenge pe ye call karta hai. Chhota, tez —
// koi images nahi, sirf solution data. Slow internet pe bhi foran response.
app.get('/solve', auth, (req, res) => {
  const hash = req.query.hash || '';
  const phash = req.query.phash || '';
  const isGrid = req.query.grid === '1'; // grid/multi-tile tasks
  const store = readStore();
  if (hash && store.kb[hash]) {
    return res.json({ found: true, solution: store.kb[hash], number: (store.task_numbers || {})[hash] || null });
  }
  // pHash (visual) fallback SIRF single-image tasks ke liye. Grid tasks (jaise
  // "find ALL objects matching number") ke parts aapas me bohot milte-julte
  // dikhte hain — un par visual match GALAT solution laga deta tha. Grid sirf
  // exact hash se match honge (jo tile IDs se already unique banta hai).
  if (phash && !isGrid) {
    const idx = store.phash_index || {};
    let best = null, bestDist = 999;
    for (const h in idx) {
      if (!store.kb[h]) continue;
      // Sirf un trained tasks se compare karo jo khud grid nahi the
      const sn = (store.snaps || {})[h];
      if (sn && sn.type === 'grid') continue;
      const d = hammingDist(phash, idx[h]);
      if (d < bestDist) { bestDist = d; best = h; }
    }
    if (best && bestDist <= 3) { // 5 se 3 — aur sakht
      return res.json({ found: true, solution: store.kb[best], number: (store.task_numbers || {})[best] || null });
    }
  }
  res.json({ found: false });
});

// ===== LIGHTWEIGHT: REPORT NEW UNSOLVED TASK =====
// Naya challenge mile (koi PC bhi) → turant ye call hota hai (sirf is ONE task
// ka data, poori KB nahi). Foran central dashboard me dikh jaata hai.
app.post('/unsolved', auth, (req, res) => {
  const t = req.body || {};
  if (!t.hash) return res.status(400).json({ error: 'hash required' });
  const store = readStore();
  store.kb = store.kb || {};
  store.unsolved = store.unsolved || [];
  store.task_numbers = store.task_numbers || {};
  store.phash_index = store.phash_index || {};

  // Agar beech me kisi ne already train kar diya, wahi solution wapas de do
  if (store.kb[t.hash]) {
    return res.json({ ok: true, alreadyTrained: true, solution: store.kb[t.hash], number: store.task_numbers[t.hash] || null });
  }

  const entry = {
    hash: t.hash, text: t.text || '', type: t.type || 'click',
    exampleImage: t.exampleImage || '', mainImage: t.mainImage || '',
    tileImages: t.tileImages || undefined, tileCount: t.tileCount || 0,
    timestamp: t.timestamp || Date.now()
  };
  const idx = store.unsolved.findIndex(it => it.hash === t.hash);
  if (idx >= 0) store.unsolved[idx] = entry;
  else {
    store.unsolved.unshift(entry);
    if (store.unsolved.length > 300) store.unsolved.splice(300);
  }

  if (!store.task_numbers[t.hash]) {
    store.task_counter = (store.task_counter || 0) + 1;
    store.task_numbers[t.hash] = store.task_counter;
  }
  if (t.phash) store.phash_index[t.hash] = t.phash;

  writeStore(store);
  res.json({ ok: true, alreadyTrained: false, number: store.task_numbers[t.hash] });
});

// ===== LIGHTWEIGHT: REPORT TRAINED SOLUTION =====
// Kisi ne (site pe ya dashboard se) solve/train kar diya → turant ye call hota
// hai, sab PCs ke /solve checks ko FORAN naya solution mil jaata hai.
app.post('/train', auth, (req, res) => {
  const t = req.body || {};
  if (!t.hash || !t.solution) return res.status(400).json({ error: 'hash and solution required' });
  const store = readStore();
  store.kb = store.kb || {};
  store.snaps = store.snaps || {};
  store.unsolved = store.unsolved || [];
  store.task_numbers = store.task_numbers || {};
  store.phash_index = store.phash_index || {};

  store.kb[t.hash] = t.solution;

  let snap = t.snap;
  const hasImages = (s) => s && (s.mainImage || s.exampleImage || (s.tileImages && s.tileImages.length));
  if (!hasImages(snap)) {
    // Train call me images nahi aayi (kisi bhi wajah se) — purani unsolved
    // entry me agar images hain (jab pehli baar queue hua tha) to wo use karo,
    // taake "Preview nahi" na dikhe.
    const orig = store.unsolved.find(it => it.hash === t.hash);
    if (orig && hasImages(orig)) {
      snap = Object.assign({}, orig, snap || {});
    }
  }
  if (hasImages(snap)) store.snaps[t.hash] = snap;
  else if (!store.snaps[t.hash]) store.snaps[t.hash] = snap || { hash: t.hash };

  store.unsolved = store.unsolved.filter(it => it.hash !== t.hash);
  if (t.phash) store.phash_index[t.hash] = t.phash;
  if (!store.task_numbers[t.hash]) {
    store.task_counter = (store.task_counter || 0) + 1;
    store.task_numbers[t.hash] = store.task_counter;
  }

  writeStore(store);
  res.json({ ok: true, number: store.task_numbers[t.hash] });
});

// ===== SINGLE UNSOLVED ITEM (chhota — agar site-training ko purani images
// chahiye ho, local cache ke bina, seedha server se) =====
app.get('/unsolved-item', auth, (req, res) => {
  const hash = req.query.hash || '';
  const store = readStore();
  const item = (store.unsolved || []).find(it => it.hash === hash);
  res.json({ found: !!item, item: item || null });
});

// ===== DELETE SINGLE TASK (dashboard delete button) =====
app.post('/delete-task', auth, (req, res) => {
  const hash = (req.body || {}).hash;
  if (!hash) return res.status(400).json({ error: 'hash required' });
  const store = readStore();
  delete (store.kb || {})[hash];
  delete (store.snaps || {})[hash];
  store.unsolved = (store.unsolved || []).filter(it => it.hash !== hash);
  writeStore(store);
  res.json({ ok: true });
});

// ===== BULK DELETE (multiple tasks ek saath) =====
app.post('/delete-many', auth, (req, res) => {
  const hashes = (req.body || {}).hashes || [];
  const store = readStore();
  hashes.forEach(h => {
    delete (store.kb || {})[h];
    delete (store.snaps || {})[h];
    store.unsolved = (store.unsolved || []).filter(it => it.hash !== h);
  });
  writeStore(store);
  res.json({ ok: true, deleted: hashes.length });
});

// ===== CLEAR UNSOLVED QUEUE (authoritative — koi merge nahi, seedha khaali) =====
app.post('/clear-unsolved', auth, (req, res) => {
  const store = readStore();
  store.unsolved = [];
  writeStore(store);
  res.json({ ok: true });
});

// ===== RESET EVERYTHING (authoritative — koi merge nahi, sab khaali) =====
app.post('/reset-all', auth, (req, res) => {
  const fresh = { kb: {}, snaps: {}, unsolved: [], task_numbers: {}, task_counter: 0, phash_index: {} };
  writeStore(fresh);
  res.json({ ok: true });
});

// ===== LIGHTWEIGHT LIST (sirf meta — KOI images nahi, isliye bohot TEZ) =====
// Dashboard isi se list dikhata hai. Slow internet pe bhi foran load hota hai,
// kyunke 95 trained tasks ki images download NAHI hoti — sirf naam/number/type.
app.get('/list', auth, (req, res) => {
  const store = readStore();
  const kb = store.kb || {};
  const tn = store.task_numbers || {};
  const snaps = store.snaps || {};

  const unsolved = (store.unsolved || []).map(it => ({
    hash: it.hash, text: it.text || '', type: it.type || 'click',
    number: tn[it.hash] || null, timestamp: it.timestamp || 0,
    hasImg: !!(it.mainImage || it.exampleImage || (it.tileImages && it.tileImages.length))
  }));

  const trained = Object.keys(kb).map(h => {
    const s = snaps[h] || {};
    return {
      hash: h, text: s.text || (kb[h] && kb[h].savedText) || '', type: s.type || (kb[h] && kb[h].actionType) || 'click',
      number: tn[h] || null, solvedAt: s.solvedAt || 0,
      hasImg: !!(s.mainImage || s.exampleImage || (s.tileImages && s.tileImages.length))
    };
  });

  res.json({
    unsolvedCount: unsolved.length,
    trainedCount: trained.length,
    unsolved, trained
  });
});

// ===== SINGLE TASK SNAP (images) — jab user ek card/editor kholay tabhi =====
app.get('/snap', auth, (req, res) => {
  const hash = req.query.hash || '';
  const store = readStore();
  const fromUnsolved = (store.unsolved || []).find(it => it.hash === hash);
  const snap = (store.snaps || {})[hash] || fromUnsolved || null;
  const solution = (store.kb || {})[hash] || null;
  res.json({ found: !!snap, snap, solution });
});

// ===== BULK (dashboard ke Export/Import/Reset/listing ke liye) =====
app.get('/kb', auth, (req, res) => {
  res.json(readStore());
});

app.post('/kb', auth, (req, res) => {
  const body = req.body || {};
  const payload = {
    kb: body.kb || {},
    snaps: body.snaps || {},
    unsolved: body.unsolved || [],
    task_numbers: body.task_numbers || {},
    task_counter: body.task_counter || 0,
    phash_index: body.phash_index || {}
  };
  writeStore(payload);
  res.json({ ok: true, updatedAt: payload.updatedAt, kbCount: Object.keys(payload.kb).length, unsolvedCount: payload.unsolved.length });
});

app.listen(PORT, () => {
  console.log('KB Sync server running on port', PORT, '| data:', KB_FILE);
});
