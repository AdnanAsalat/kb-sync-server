// ============ SERVER-BACKED STORAGE SHIM ============
// Ye extension ke "chrome.storage.local" / "chrome.runtime" APIs ko replicate karta
// hai, lekin asal data Railway server (/kb) se aata/jaata hai. Isse hum extension ka
// pura dashboard logic (neeche) BINA CHANGE kiye yahan bhi chala sakte hain.

const SECRET_KEY = 'kb_dashboard_secret';
let STORE = {};              // local_kb, unsolved_queue, task_numbers, task_counter, phash_index, snap:<hash>...
let _onChangedListeners = [];
let _pushTimer = null;
let _ready = false;

function getStoredSecret() { return localStorage.getItem(SECRET_KEY) || ''; }
function setStoredSecret(s) { localStorage.setItem(SECRET_KEY, s); }

async function serverGet() {
  const secret = getStoredSecret();
  if (!secret) return null;
  try {
    const r = await fetch('/kb', { headers: { 'X-Sync-Secret': secret } });
    if (!r.ok) return { _status: r.status };
    return await r.json();
  } catch (e) { return { _status: 0 }; }
}

async function serverPost(payload) {
  const secret = getStoredSecret();
  if (!secret) return false;
  try {
    const r = await fetch('/kb', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sync-Secret': secret },
      body: JSON.stringify(payload)
    });
    return r.ok;
  } catch (e) { return false; }
}

// Server payload -> STORE ke flat keys me unpack karo
function applyServerPayload(p) {
  STORE.local_kb = p.kb || {};
  STORE.unsolved_queue = (p.unsolved || []).filter(it => !STORE.local_kb[it.hash]);
  STORE.task_numbers = p.task_numbers || {};
  STORE.task_counter = p.task_counter || 0;
  STORE.phash_index = p.phash_index || {};
  // Purani snap:<hash> keys saaf karke nayi daalo
  Object.keys(STORE).forEach(k => { if (k.indexOf('snap:') === 0) delete STORE[k]; });
  const snaps = p.snaps || {};
  for (const h in snaps) STORE['snap:' + h] = snaps[h];
}

// STORE se server payload shape banao (push ke liye)
function buildPayloadFromStore() {
  const snaps = {};
  for (const k in STORE) if (k.indexOf('snap:') === 0) snaps[k.slice(5)] = STORE[k];
  return {
    kb: STORE.local_kb || {},
    snaps,
    unsolved: STORE.unsolved_queue || [],
    task_numbers: STORE.task_numbers || {},
    task_counter: STORE.task_counter || 0,
    phash_index: STORE.phash_index || {}
  };
}

async function pullFromServer() {
  const p = await serverGet();
  if (!p || p._status) return p ? p._status : -1; // -1 = network fail, else HTTP status
  applyServerPayload(p);
  _ready = true;
  _onChangedListeners.forEach(fn => fn({ unsolved_queue: {}, local_kb: {} }, 'local'));
  return 200;
}

function schedulePush() {
  clearTimeout(_pushTimer);
  _pushTimer = setTimeout(pushToServer, 600); // chhota debounce, kai set() calls = ek push
}

async function pushToServer() {
  // Pehle fresh server data lao, merge karo (kahin doosra PC bhi ne update na kar diya ho)
  const fresh = await serverGet();
  if (fresh && !fresh._status) {
    const remoteKb = fresh.kb || {};
    const remoteUnsolved = fresh.unsolved || [];
    const remoteSnaps = fresh.snaps || {};
    // Local (jo abhi edit hua) jeetta hai conflict pe
    STORE.local_kb = Object.assign({}, remoteKb, STORE.local_kb || {});
    STORE.task_numbers = Object.assign({}, fresh.task_numbers || {}, STORE.task_numbers || {});
    STORE.phash_index = Object.assign({}, fresh.phash_index || {}, STORE.phash_index || {});
    STORE.task_counter = Math.max(fresh.task_counter || 0, STORE.task_counter || 0);
    for (const h in remoteSnaps) if (!STORE['snap:' + h]) STORE['snap:' + h] = remoteSnaps[h];
    const umap = {};
    remoteUnsolved.forEach(it => { umap[it.hash] = it; });
    (STORE.unsolved_queue || []).forEach(it => { umap[it.hash] = it; });
    STORE.unsolved_queue = Object.values(umap).filter(it => !STORE.local_kb[it.hash]);
  }
  await serverPost(buildPayloadFromStore());
}

// ===== chrome.* shim (dashboard ka purana code yehi calls karta hai) =====
window.chrome = {
  storage: {
    local: {
      get(keys, cb) {
        if (typeof keys === 'function') { cb = keys; keys = null; }
        if (keys === null || keys === undefined) { cb(Object.assign({}, STORE)); return; }
        if (Array.isArray(keys)) {
          const out = {}; keys.forEach(k => { if (STORE[k] !== undefined) out[k] = STORE[k]; });
          cb(out); return;
        }
        cb(Object.assign({}, STORE));
      },
      set(obj, cb) {
        Object.assign(STORE, obj);
        schedulePush();
        if (cb) cb();
      },
      remove(keys, cb) {
        (Array.isArray(keys) ? keys : [keys]).forEach(k => delete STORE[k]);
        schedulePush();
        if (cb) cb();
      }
    },
    onChanged: {
      addListener(fn) { _onChangedListeners.push(fn); }
    }
  },
  runtime: {
    lastError: undefined,
    sendMessage(msg, cb) {
      if (msg && msg.type === 'CLOUD_SYNC_NOW') {
        pullFromServer().then(status => { if (cb) cb({ ok: status === 200 }); });
      } else {
        if (cb) cb({ ok: false });
      }
    }
  }
};
// dashboard.js — SquareNet-style card grid trainer
let queue = [];        // unsolved
let kb = {};           // solved solutions
let solvedSnaps = {};  // solved_tasks snapshots
let taskNumbers = {};  // hash -> unique number
let activeTab = 'unsolved';
let catFilter = 'all';
let searchTerm = '';
let currentKey = null; // hash of selected task
let currentTask = null;

let selectedTiles = new Set();
let clickPoint = null;
let multiPoints = [];
let dragPairs = [];     // [{from:{x,y}, to:{x,y}}]
let pendingSource = null;

const $ = (id) => document.getElementById(id);

// ============ CATEGORY HELPERS ============

// Trained task ki category uske actionType se, unsolved ki uske detected type se
function categoryOf(hash, item, isSolved) {
  if (isSolved && kb[hash]) {
    const a = kb[hash].actionType;
    if (a === 'replay') return kb[hash].kind === 'drag' ? 'drag' : 'click';
    if (a === 'click_indexes') return 'grid';
    if (a === 'drag_pairs') return 'drag';
    if (a === 'slider') return 'slider';
    return 'click'; // click_point / multi_click
  }
  const t = (item && item.type) || 'click';
  if (t.includes('grid')) return 'grid';
  if (t.includes('slider')) return 'slider';
  if (t.includes('drag')) return 'drag';
  return 'click';
}

function numOf(hash) { return taskNumbers[hash] || '?'; }

// ============ LOAD DATA ============

function refresh() {
  // get(null) — sab keys, taake per-key snap:<hash> bhi mil jayein
  chrome.storage.local.get(null, (data) => {
    kb = data.local_kb || {};
    queue = data.unsolved_queue || [];
    taskNumbers = data.task_numbers || {};
    // Snapshots: legacy solved_tasks + naye per-key snap:<hash>
    solvedSnaps = Object.assign({}, data.solved_tasks || {});
    for (const k in data) {
      if (k.indexOf('snap:') === 0) solvedSnaps[k.slice(5)] = data[k];
    }

    const trainedKeys = Object.keys(kb);
    // Counters
    $('cUnsolved').textContent = queue.length;
    $('cTrained').textContent = trainedKeys.length;
    // Today = aaj train kiye gaye
    const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
    const todayCount = trainedKeys.filter(h => {
      const s = solvedSnaps[h];
      return s && s.solvedAt && s.solvedAt >= startOfDay.getTime();
    }).length;
    $('cToday').textContent = todayCount;

    updateCatCounts();
    renderCards();
  });
}

function updateCatCounts() {
  // Active tab ke hisaab se har category ka count
  const counts = { all: 0, grid: 0, click: 0, drag: 0, slider: 0 };
  if (activeTab === 'unsolved') {
    queue.forEach(it => { counts.all++; counts[categoryOf(it.hash, it, false)]++; });
  } else {
    Object.keys(kb).forEach(h => {
      const snap = solvedSnaps[h] || { type: kb[h].actionType };
      counts.all++; counts[categoryOf(h, snap, true)]++;
    });
  }
  document.querySelectorAll('.cat').forEach(btn => {
    const c = btn.dataset.cat;
    let label = btn.dataset.label || btn.textContent.replace(/\s*\d+$/, '').trim();
    btn.dataset.label = label;
    btn.innerHTML = label + ' <span class="c-count">' + (counts[c] || 0) + '</span>';
  });
}

// ============ TABS + FILTERS ============

document.querySelectorAll('.tab').forEach(t => {
  t.onclick = () => {
    activeTab = t.dataset.tab;
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
    updateCatCounts();
    renderCards();
  };
});

document.querySelectorAll('.cat').forEach(btn => {
  btn.onclick = () => {
    catFilter = btn.dataset.cat;
    document.querySelectorAll('.cat').forEach(x => x.classList.toggle('active', x === btn));
    renderCards();
  };
});

$('searchBox').oninput = function() {
  searchTerm = this.value.trim().toLowerCase();
  renderCards();
};

$('refreshBtn').onclick = () => doCloudSync(true);

// ============ CARD GRID ============

function thumbHTML(snap, cat) {
  // Multiple tiles hain (grid/cards) → montage; warna single image
  const goodTiles = (snap.tileImages || []).filter(t => t && t.length > 100);
  if (goodTiles.length >= 4) {
    const imgs = goodTiles.slice(0, 4);
    const cells = imgs.map(s => `<img loading="lazy" src="${s}">`).join('');
    return `<div class="tiles" style="grid-template-columns:repeat(2,1fr)">${cells}</div>`;
  }
  const main = snap.mainImage || snap.exampleImage || goodTiles[0] || '';
  if (main) return `<img class="single" loading="lazy" src="${main}">`;
  return `<div class="noimg" style="flex-direction:column;gap:8px;color:#64748b;">
    <div style="font-size:34px;">🧩</div>
    <div style="font-size:12px;">Preview nahi (trained ✅)</div>
  </div>`;
}

let _pageSize = 24;       // ek baar me kitne cards
let _shown = 24;          // abhi kitne dikhaye
let _lastEntries = [];    // filtered+sorted entries cache

function renderCards(keepShown) {
  const grid = $('cardGrid');
  grid.innerHTML = '';

  let entries = [];
  if (activeTab === 'unsolved') {
    entries = queue.map(it => ({ hash: it.hash, item: it, isSolved: false }));
  } else {
    entries = Object.keys(kb).map(h => ({
      hash: h,
      item: solvedSnaps[h] || { hash: h, text: kb[h].savedText || '(no preview)', type: kb[h].actionType },
      isSolved: true
    }));
  }

  if (catFilter !== 'all') {
    entries = entries.filter(e => categoryOf(e.hash, e.item, e.isSolved) === catFilter);
  }
  if (searchTerm) {
    const sNum = searchTerm.replace('#', '');
    entries = entries.filter(e => {
      const num = String(numOf(e.hash));
      const txt = (e.item.text || '').toLowerCase();
      return num === sNum || num.includes(sNum) || txt.includes(searchTerm);
    });
  }

  entries.sort((a, b) => (parseInt(numOf(b.hash)) || 0) - (parseInt(numOf(a.hash)) || 0));
  _lastEntries = entries;

  if (!keepShown) _shown = _pageSize; // naya filter/tab → reset

  if (!entries.length) {
    grid.innerHTML = `<div class="empty-msg">${activeTab === 'unsolved'
      ? 'Koi unsolved task nahi. hCaptcha solve karein…'
      : 'Is filter me koi trained task nahi.'}</div>`;
    return;
  }

  const slice = entries.slice(0, _shown);
  const frag = document.createDocumentFragment();
  slice.forEach(e => frag.appendChild(makeCard(e.hash, e.item, e.isSolved)));
  grid.appendChild(frag);

  // "Load more" button agar aur cards bache hain
  if (entries.length > _shown) {
    const more = document.createElement('div');
    more.style.cssText = 'grid-column:1/-1;text-align:center;padding:14px;';
    const btn = document.createElement('button');
    btn.textContent = `⬇️ Aur dikhayein (${entries.length - _shown} baaki)`;
    btn.style.cssText = 'background:#6d28d9;color:#fff;border:none;padding:12px 24px;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;';
    btn.onclick = () => { _shown += _pageSize; renderCards(true); };
    more.appendChild(btn);
    grid.appendChild(more);
  }
}

function makeCard(hash, item, isSolved) {
  const cat = categoryOf(hash, item, isSolved);
  const card = document.createElement('div');
  card.className = 'card';

  const dateMs = isSolved ? (item.solvedAt || item.timestamp) : item.timestamp;
  const dateStr = dateMs ? new Date(dateMs).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '';
