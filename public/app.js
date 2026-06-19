// ============ SERVER-BACKED STORAGE SHIM ============
// Ye extension ke "chrome.storage.local" / "chrome.runtime" APIs ko replicate karta
// hai, lekin asal data Railway server se aata/jaata hai. Isse hum extension ka
// pura dashboard logic (neeche) BINA CHANGE kiye yahan bhi chala sakte hain.
//
// IMPORTANT: har action (Train/Delete/Clear/Reset) ko alag, AUTHORITATIVE
// endpoint pe bhejte hain (koi "purana data wapas merge ho jaye" wala bug nahi)
// — bulk/additive actions (Import/Restore) ke liye purana safe merge-push hai.

const SECRET_KEY = 'kb_dashboard_secret';
let STORE = {};              // local_kb, unsolved_queue, task_numbers, task_counter, phash_index, snap:<hash>...
window.STORE = STORE;
let _onChangedListeners = [];
let _ready = false;

function getStoredSecret() { return localStorage.getItem(SECRET_KEY) || ''; }
function setStoredSecret(s) { localStorage.setItem(SECRET_KEY, s); }
function authHeaders() { return { 'Content-Type': 'application/json', 'X-Sync-Secret': getStoredSecret() }; }

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
    const r = await fetch('/kb', { method: 'POST', headers: authHeaders(), body: JSON.stringify(payload) });
    return r.ok;
  } catch (e) { return false; }
}

async function callEndpoint(path, body) {
  try {
    const r = await fetch(path, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body || {}) });
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
  Object.keys(STORE).forEach(k => { if (k.indexOf('snap:') === 0) delete STORE[k]; });
  const snaps = p.snaps || {};
  for (const h in snaps) STORE['snap:' + h] = snaps[h];
}

function buildPayloadFromStore() {
  const snaps = {};
  for (const k in STORE) if (k.indexOf('snap:') === 0) snaps[k.slice(5)] = STORE[k];
  return {
    kb: STORE.local_kb || {}, snaps,
    unsolved: STORE.unsolved_queue || [],
    task_numbers: STORE.task_numbers || {},
    task_counter: STORE.task_counter || 0,
    phash_index: STORE.phash_index || {}
  };
}

// LIGHTWEIGHT list endpoint se sirf meta lao (KOI images nahi) — slow internet
// pe bhi foran. Images sirf tab aati hain jab user kisi ek task ko kholta hai
// (ensureSnap se on-demand).
async function serverList() {
  const secret = getStoredSecret();
  if (!secret) return null;
  try {
    const r = await fetch('/list', { headers: { 'X-Sync-Secret': secret } });
    if (!r.ok) return { _status: r.status };
    return await r.json();
  } catch (e) { return { _status: 0 }; }
}

// Ek task ki images (snap) on-demand lao aur STORE me daal do
async function ensureSnap(hash) {
  if (STORE['snap:' + hash] && (STORE['snap:' + hash].mainImage || STORE['snap:' + hash].exampleImage || (STORE['snap:' + hash].tileImages && STORE['snap:' + hash].tileImages.length))) {
    return STORE['snap:' + hash];
  }
  const secret = getStoredSecret();
  if (!secret) return null;
  try {
    const r = await fetch('/snap?hash=' + encodeURIComponent(hash), { headers: { 'X-Sync-Secret': secret } });
    if (!r.ok) return null;
    const d = await r.json();
    if (d.found && d.snap) {
      STORE['snap:' + hash] = d.snap;
      // unsolved_queue me bhi us item ko images ke saath update kar do (editor ke liye)
      const idx = (STORE.unsolved_queue || []).findIndex(it => it.hash === hash);
      if (idx >= 0) STORE.unsolved_queue[idx] = Object.assign({}, STORE.unsolved_queue[idx], d.snap);
      return d.snap;
    }
  } catch (e) {}
  return null;
}
window.ensureSnap = ensureSnap;

async function pullFromServer() {
  const list = await serverList();
  if (!list || list._status) return list ? list._status : -1;

  // Meta se STORE ka dhaancha banao (images abhi nahi — wo on-demand aayengi)
  const kb = {}, tn = {};
  STORE.unsolved_queue = (list.unsolved || []).map(u => {
    if (u.number) tn[u.hash] = u.number;
    return { hash: u.hash, text: u.text, type: u.type, taskNumber: u.number, timestamp: u.timestamp, _metaOnly: !u.hasImg ? false : true };
  });
  (list.trained || []).forEach(t => {
    kb[t.hash] = { actionType: t.type, savedText: t.text, _metaOnly: true };
    if (t.number) tn[t.hash] = t.number;
  });
  STORE.local_kb = kb;
  STORE.task_numbers = tn;
  // Purani snap:<hash> meta-only entries hata do, real ondemand aayengi
  STORE._trainedMeta = {};
  (list.trained || []).forEach(t => { STORE._trainedMeta[t.hash] = t; });

  _ready = true;
  _onChangedListeners.forEach(fn => fn({ unsolved_queue: {}, local_kb: {} }, 'local'));
  return 200;
}

// Purana full /kb (sirf Export ke liye — wahan poora data chahiye hota hai)
async function serverGetFull() {
  const secret = getStoredSecret();
  if (!secret) return null;
  try {
    const r = await fetch('/kb', { headers: { 'X-Sync-Secret': secret } });
    if (!r.ok) return { _status: r.status };
    return await r.json();
  } catch (e) { return { _status: 0 }; }
}
window.serverGetFull = serverGetFull;

// Generic additive merge-push — SIRF bulk/additive actions (Import KB, Restore
// Backup) ke liye. Ye kabhi kuch DELETE nahi karta, isliye safe hai.
async function additiveMergePush() {
  const fresh = await serverGet();
  if (fresh && !fresh._status) {
    const remoteKb = fresh.kb || {};
    STORE.local_kb = Object.assign({}, remoteKb, STORE.local_kb || {});
    STORE.task_numbers = Object.assign({}, fresh.task_numbers || {}, STORE.task_numbers || {});
    STORE.phash_index = Object.assign({}, fresh.phash_index || {}, STORE.phash_index || {});
    STORE.task_counter = Math.max(fresh.task_counter || 0, STORE.task_counter || 0);
    const remoteSnaps = fresh.snaps || {};
    for (const h in remoteSnaps) if (!STORE['snap:' + h]) STORE['snap:' + h] = remoteSnaps[h];
    const umap = {};
    (fresh.unsolved || []).forEach(it => { umap[it.hash] = it; });
    (STORE.unsolved_queue || []).forEach(it => { umap[it.hash] = it; });
    STORE.unsolved_queue = Object.values(umap).filter(it => !STORE.local_kb[it.hash]);
  }
  await serverPost(buildPayloadFromStore());
}

// Har .set() call ko CLASSIFY karo — Train/Delete/Clear/Reset ko seedha,
// authoritative endpoint pe bhejo (koi merge nahi, isliye "purane wapas aana"
// wala bug nahi hota). Baaki (Import/Restore — additive) purane merge se.
async function handleSet(obj) {
  const oldKb = STORE.local_kb || {};

  // RESET ALL: kb khaali, counter 0, unsolved bhi key me
  if (obj.hasOwnProperty('local_kb') && obj.hasOwnProperty('unsolved_queue') &&
      obj.hasOwnProperty('task_counter') && obj.task_counter === 0 &&
      Object.keys(obj.local_kb).length === 0) {
    await callEndpoint('/reset-all');
    return;
  }

  // TRAIN ya DELETE: dono keys ek saath aati hain (local_kb + unsolved_queue)
  if (obj.hasOwnProperty('local_kb') && obj.hasOwnProperty('unsolved_queue')) {
    const newKeys = Object.keys(obj.local_kb).length;
    const oldKeys = Object.keys(oldKb).length;
    if (newKeys > oldKeys) {
      // TRAIN — exactly ek naya/badla hua hash dhoondo
      let newHash = null;
      for (const h in obj.local_kb) {
        if (JSON.stringify(oldKb[h]) !== JSON.stringify(obj.local_kb[h])) { newHash = h; break; }
      }
      if (newHash) {
        const snap = obj['snap:' + newHash];
        const phash = obj.phash_index ? obj.phash_index[newHash] : undefined;
        await callEndpoint('/train', { hash: newHash, solution: obj.local_kb[newHash], snap, phash });
        return;
      }
    } else if (newKeys < oldKeys) {
      // DELETE — jo hash purani kb me tha, nayi me nahi
      const removedHash = Object.keys(oldKb).find(h => !(h in obj.local_kb));
      if (removedHash) {
        await callEndpoint('/delete-task', { hash: removedHash });
        return;
      }
    }
  }

  // CLEAR QUEUE: sirf unsolved_queue:[] (local_kb key bilkul nahi)
  if (!obj.hasOwnProperty('local_kb') && obj.hasOwnProperty('unsolved_queue') &&
      Array.isArray(obj.unsolved_queue) && obj.unsolved_queue.length === 0) {
    await callEndpoint('/clear-unsolved');
    return;
  }

  // Baaki sab (Import KB, Restore Backup — additive) → purana safe merge
  await additiveMergePush();
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
        handleSet(obj).then(() => {
          Object.assign(STORE, obj);
          if (cb) cb();
        });
      },
      remove(keys, cb) {
        // 'kb_backup' jaisi sirf-local cheezein — server ko batane ki zaroorat
        // nahi (asal action uske baad wale .set() call se hota hai).
        (Array.isArray(keys) ? keys : [keys]).forEach(k => delete STORE[k]);
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
    // Snapshots: legacy solved_tasks + naye per-key snap:<hash> + server meta
    solvedSnaps = Object.assign({}, data.solved_tasks || {});
    for (const k in data) {
      if (k.indexOf('snap:') === 0) solvedSnaps[k.slice(5)] = data[k];
    }
    // Server se aayi meta (text/type/solvedAt — bina images) merge karo taake
    // category counts aur "Today" sahi rahein bina images download kiye
    const tmeta = (data._trainedMeta) || (window.STORE && window.STORE._trainedMeta) || {};
    for (const h in tmeta) {
      solvedSnaps[h] = Object.assign({ type: tmeta[h].type, text: tmeta[h].text, solvedAt: tmeta[h].solvedAt }, solvedSnaps[h] || {});
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
  const text = (item.text || '(no text)');

  card.innerHTML = `
    <div class="thumb">
      <span class="num-badge">#${numOf(hash)}</span>
      <span class="cat-badge ${cat}">${cat}</span>
      ${thumbHTML(item, cat)}
      <button class="del" title="Delete">🗑️</button>
    </div>
    <div class="meta">
      <div class="title">${isSolved ? '✅ ' : ''}${escapeHtml(text)}</div>
      <div class="sub">${dateStr}</div>
    </div>`;

  card.querySelector('.del').onclick = (ev) => { ev.stopPropagation(); quickDelete(hash); };
  card.onclick = () => isSolved ? loadSolved(hash) : loadTask(item);
  return card;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}

function quickDelete(hash) {
  if (!confirm('Task #' + numOf(hash) + ' delete karein?')) return;
  (async () => {
    await callEndpoint('/delete-task', { hash });
    if (window.STORE) {
      if (window.STORE.local_kb) delete window.STORE.local_kb[hash];
      window.STORE.unsolved_queue = (window.STORE.unsolved_queue || []).filter(i => i.hash !== hash);
      delete window.STORE['snap:' + hash];
    }
    if (currentKey === hash) { resetInputs(); showPlaceholder(); }
    refresh();
  })();
}

// ============ LOAD TASK (unsolved) ============

function resetInputs() {
  selectedTiles.clear(); clickPoint = null; multiPoints = []; dragPairs = []; pendingSource = null;
}

async function loadTask(task) {
  currentKey = task.hash;
  resetInputs();
  // Images on-demand lao (list me images nahi aati thi, sirf meta)
  if (window.ensureSnap && (!task.mainImage && !task.exampleImage && !(task.tileImages && task.tileImages.length))) {
    showEditorLoading();
    const snap = await window.ensureSnap(task.hash);
    if (snap) task = Object.assign({}, task, snap);
  }
  currentTask = task;
  showEditor(task, null);
}

function loadSolved(hash) {
  (async () => {
    let task = solvedSnaps[hash] || { hash, text: (kb[hash] && kb[hash].savedText) || '', type: kb[hash] && kb[hash].actionType };
    currentKey = hash;
    resetInputs();
    if (window.ensureSnap && (!task.mainImage && !task.exampleImage && !(task.tileImages && task.tileImages.length))) {
      showEditorLoading();
      const snap = await window.ensureSnap(hash);
      if (snap) task = Object.assign({}, task, snap);
    }
    currentTask = task;
    showEditor(task, kb[hash]); // prefill existing solution
  })();
}

function showEditorLoading() {
  $('listView').style.display = 'none';
  $('editorView').style.display = 'block';
  const ex = $('exampleImg'); if (ex) ex.removeAttribute('src');
}

function showEditor(task, existingSolution) {
  // List view chhupao, editor view dikhao
  $('listView').style.display = 'none';
  $('editorView').style.display = 'block';
  $('editNum').textContent = 'Task #' + numOf(task.hash);
  window.scrollTo(0, 0);

  $('taskText').textContent = task.text || '(no text)';

  $('gridSection').style.display = 'none';
  $('clickSection').style.display = 'none';
  $('dragSection').style.display = 'none';
  $('sliderRow').style.display = 'none';
  $('exampleWrap').style.display = 'none';
  $('actionOverride').value = existingSolution ? existingSolution.actionType : '';

  if (task.exampleImage && task.exampleImage.length > 100) {
    $('exampleImg').src = task.exampleImage;
    $('exampleWrap').style.display = 'block';
  }

  // Decide which editor to show
  let mode = existingSolution ? existingSolution.actionType : null;
  if (!mode) {
    if (task.type === 'grid') mode = 'click_indexes';
    else if (task.type === 'drag') mode = 'drag_pairs';
    else mode = 'click_point';
  }

  applyMode(mode, task, existingSolution);
}

// Show the right editor for a mode
function applyMode(mode, task, sol) {
  if (mode === 'replay') {
    showReplay(task, sol);
  } else if (mode === 'click_indexes') {
    showGrid(task, sol);
  } else if (mode === 'drag_pairs') {
    showDrag(task, sol);
  } else if (mode === 'slider') {
    $('sliderRow').style.display = 'block';
    if (sol && sol.targetX) $('sliderInput').value = sol.targetX;
    // also show image for reference
    showClickImageOnly(task);
  } else { // click_point or multi_click
    showClick(task, sol, mode === 'multi_click');
  }
}

// Site-trained (replay) task — recorded clicks/drags ko dikhao
function showReplay(task, sol) {
  // Agar grid task hai aur tile indices store hain → grid montage me highlight
  if (sol && sol.gridClicks && sol.gridClicks.length && task.tileImages && task.tileImages.length) {
    $('gridSection').style.display = 'block';
    const grid = $('tileGrid');
    grid.innerHTML = '';
    const tiles = task.tileImages;
    grid.style.gridTemplateColumns = tiles.length > 9 ? 'repeat(4, 1fr)' : 'repeat(3, 1fr)';
    const sel = new Set(sol.gridClicks);
    tiles.forEach((src, i) => {
      const tile = document.createElement('div');
      tile.className = 'tile' + (sel.has(i) ? ' selected' : '');
      const badge = document.createElement('span');
      badge.className = 'idx-badge'; badge.textContent = i;
      tile.appendChild(badge);
      if (src && src.length > 100) {
        const img = document.createElement('img'); img.src = src;
        img.onerror = () => { tile.classList.add('no-img'); img.remove(); };
        tile.appendChild(img);
      } else tile.classList.add('no-img');
      grid.appendChild(tile);
    });
    $('selectedInfo').innerHTML = `✅ <b>Site se trained</b> — green tiles = jo click hue`;
    return;
  }

  // Warna image pe markers overlay
  $('clickSection').style.display = 'block';
  $('clickImg').src = imgSrcOf(task);
  const area = $('clickArea');
  area.querySelectorAll('.marker').forEach(m => m.remove());

  const actions = (sol && sol.actions) || [];
  let n = 0;
  actions.forEach((a) => {
    if (a.type === 'click') {
      n++;
      const m = document.createElement('div');
      m.className = 'marker point';
      m.style.left = a.x + '%'; m.style.top = a.y + '%';
      m.textContent = n;
      area.appendChild(m);
    } else if (a.type === 'drag') {
      const s = document.createElement('div');
      s.className = 'marker src';
      s.style.left = a.from.x + '%'; s.style.top = a.from.y + '%';
      s.textContent = 'S';
      area.appendChild(s);
      const d = document.createElement('div');
      d.className = 'marker dst';
      d.style.left = a.to.x + '%'; d.style.top = a.to.y + '%';
      d.textContent = 'D';
      area.appendChild(d);
    }
  });

  const clicks = actions.filter(a => a.type === 'click').length;
  const drags = actions.filter(a => a.type === 'drag').length;
  $('clickInfo').innerHTML = `✅ <b>Site se trained</b> — ${clicks} click(s)` +
    (drags ? `, ${drags} drag(s)` : '') +
    ` &nbsp; <span style="color:#64748b">(markers = recorded points)</span>`;
}

// When user changes override dropdown, switch editor live
$('actionOverride').onchange = function() {
  if (!currentTask) return;
  const v = this.value || (currentTask.type === 'grid' ? 'click_indexes' : currentTask.type === 'drag' ? 'drag_pairs' : 'click_point');
  resetInputs();
  $('gridSection').style.display = 'none';
  $('clickSection').style.display = 'none';
  $('dragSection').style.display = 'none';
  $('sliderRow').style.display = 'none';
  applyMode(v, currentTask, null);
};

// ============ GRID ============

function showGrid(task, sol) {
  $('gridSection').style.display = 'block';
  const grid = $('tileGrid');
  grid.innerHTML = '';
  const tiles = task.tileImages || [];
  grid.style.gridTemplateColumns = tiles.length > 9 ? 'repeat(4, 1fr)' : 'repeat(3, 1fr)';
  const preSel = (sol && sol.clicks) ? new Set(sol.clicks) : new Set();

  (tiles.length ? tiles : new Array(task.tileCount || 9).fill('')).forEach((src, i) => {
    const tile = document.createElement('div');
    tile.className = 'tile';
    if (preSel.has(i)) { tile.classList.add('selected'); selectedTiles.add(i); }
    const badge = document.createElement('span');
    badge.className = 'idx-badge'; badge.textContent = i;
    tile.appendChild(badge);
    if (src && src.length > 100) {
      const img = document.createElement('img');
      img.src = src;
      img.onerror = () => { tile.classList.add('no-img'); img.remove(); };
      tile.appendChild(img);
    } else tile.classList.add('no-img');
    tile.onclick = () => toggleTile(i, tile);
    grid.appendChild(tile);
  });
  updateSelectedInfo();
}

function toggleTile(idx, el) {
  if (selectedTiles.has(idx)) { selectedTiles.delete(idx); el.classList.remove('selected'); }
  else { selectedTiles.add(idx); el.classList.add('selected'); }
  updateSelectedInfo();
}
function updateSelectedInfo() {
  const a = [...selectedTiles].sort((x,y)=>x-y);
  $('selectedInfo').textContent = a.length ? 'Selected: ' + a.join(', ') : 'No tiles selected';
}

// ============ CLICK / MULTI ============

function imgSrcOf(task) {
  return task.mainImage || task.exampleImage || (task.tileImages && task.tileImages.find(t => t && t.length > 100)) || '';
}

function showClick(task, sol, multi) {
  $('clickSection').style.display = 'block';
  $('clickImg').src = imgSrcOf(task);
  $('multiToggle').checked = !!multi || (sol && sol.actionType === 'multi_click');
  $('clickArea').querySelectorAll('.marker').forEach(m => m.remove());
  if (sol && sol.actionType === 'multi_click' && sol.points) { multiPoints = sol.points.slice(); }
  else if (sol && sol.x !== undefined) { clickPoint = { x: sol.x, y: sol.y }; }
  redrawClick();
  $('clickInfo').textContent = 'Click to mark target';
}

function showClickImageOnly(task) {
  $('clickSection').style.display = 'block';
  $('clickImg').src = imgSrcOf(task);
  $('clickArea').querySelectorAll('.marker').forEach(m => m.remove());
  $('clickInfo').textContent = 'Slider mode — image reference sirf dekhne ke liye';
}

function redrawClick() {
  const area = $('clickArea');
  area.querySelectorAll('.marker').forEach(m => m.remove());
  const multi = $('multiToggle').checked;
  const pts = multi ? multiPoints : (clickPoint ? [clickPoint] : []);
  pts.forEach((p, i) => {
    const m = document.createElement('div');
    m.className = 'marker point';
    m.style.left = p.x + '%'; m.style.top = p.y + '%';
    if (multi) m.textContent = i + 1;
    area.appendChild(m);
  });
}

$('clickArea').onclick = function(e) {
  const img = $('clickImg');
  const rect = img.getBoundingClientRect();
  const x = parseFloat(((e.clientX - rect.left)/rect.width*100).toFixed(1));
  const y = parseFloat(((e.clientY - rect.top)/rect.height*100).toFixed(1));
  if ($('multiToggle').checked) {
    multiPoints.push({x, y});
    $('clickInfo').textContent = multiPoints.length + ' points marked';
  } else {
    clickPoint = {x, y};
    $('clickInfo').textContent = `Marked: (${x}%, ${y}%)`;
  }
  redrawClick();
};

$('multiToggle').onchange = function() {
  multiPoints = []; clickPoint = null;
  $('clickInfo').textContent = this.checked ? 'Multi-click ON' : 'Click to mark';
  redrawClick();
};

// ============ DRAG PAIRS ============

function showDrag(task, sol) {
  $('dragSection').style.display = 'block';
  $('dragImg').src = imgSrcOf(task);
  $('dragArea').querySelectorAll('.marker').forEach(m => m.remove());
  dragPairs = (sol && sol.pairs) ? sol.pairs.slice() : [];
  pendingSource = null;
  redrawDrag();
}

$('dragArea').onclick = function(e) {
  const img = $('dragImg');
  const rect = img.getBoundingClientRect();
  const x = parseFloat(((e.clientX - rect.left)/rect.width*100).toFixed(1));
  const y = parseFloat(((e.clientY - rect.top)/rect.height*100).toFixed(1));

  if (!pendingSource) {
    pendingSource = {x, y};
    $('dragInfo').textContent = `Source marked (${x}%, ${y}%) — ab DESTINATION pe click karo`;
  } else {
    dragPairs.push({ from: pendingSource, to: {x, y} });
    pendingSource = null;
    $('dragInfo').textContent = `${dragPairs.length} move(s) marked. Aur move ho to SOURCE pe click karo.`;
  }
  redrawDrag();
};

function redrawDrag() {
  const area = $('dragArea');
  area.querySelectorAll('.marker').forEach(m => m.remove());
  dragPairs.forEach((p, i) => {
    addMarker(area, 'src', p.from.x, p.from.y, 'S' + (i+1));
    addMarker(area, 'dst', p.to.x, p.to.y, 'D' + (i+1));
  });
  if (pendingSource) addMarker(area, 'src', pendingSource.x, pendingSource.y, 'S?');
  // List
  $('dragPairsList').innerHTML = dragPairs.map((p,i) =>
    `<span class="pair">Move ${i+1}: (${p.from.x},${p.from.y}) → (${p.to.x},${p.to.y})</span>`).join('');
}

function addMarker(area, cls, x, y, label) {
  const m = document.createElement('div');
  m.className = 'marker ' + cls;
  m.style.left = x + '%'; m.style.top = y + '%';
  m.textContent = label;
  area.appendChild(m);
}

// ============ UNDO ============

$('undoBtn').onclick = function() {
  const mode = $('actionOverride').value || (currentTask && currentTask.type === 'grid' ? 'click_indexes' : currentTask && currentTask.type === 'drag' ? 'drag_pairs' : 'click_point');
  if (mode === 'drag_pairs') {
    if (pendingSource) { pendingSource = null; }
    else dragPairs.pop();
    redrawDrag();
  } else if (mode === 'multi_click') {
    multiPoints.pop(); redrawClick();
  } else if (mode === 'click_point') {
    clickPoint = null; redrawClick();
  }
};

// ============ SAVE ============

$('saveBtn').onclick = function() {
  if (!currentTask) return;
  const task = currentTask;
  const override = $('actionOverride').value;
  let type = override;
  if (!type) {
    if (task.type === 'grid') type = 'click_indexes';
    else if (task.type === 'drag') type = 'drag_pairs';
    else if ($('multiToggle').checked) type = 'multi_click';
    else type = 'click_point';
  }

  let solution = { actionType: type, savedText: task.text };

  if (type === 'click_indexes') {
    const c = [...selectedTiles].sort((a,b)=>a-b);
    if (!c.length) { alert('Tiles select karein!'); return; }
    solution.clicks = c;
  } else if (type === 'click_point') {
    if (!clickPoint) { alert('Point mark karein!'); return; }
    solution.x = clickPoint.x; solution.y = clickPoint.y;
  } else if (type === 'multi_click') {
    if (!multiPoints.length) { alert('Points mark karein!'); return; }
    solution.points = multiPoints;
  } else if (type === 'drag_pairs') {
    if (!dragPairs.length) { alert('Kam se kam ek drag (source+dest) mark karein!'); return; }
    solution.pairs = dragPairs;
  } else if (type === 'slider') {
    const v = parseInt($('sliderInput').value);
    if (isNaN(v)) { alert('Pixels likhein!'); return; }
    solution.targetX = v;
  }

  const btn = $('saveBtn');
  btn.textContent = '⏳ Saving...'; btn.disabled = true;

  // Snapshot (images) — agar editor me already images hain to wahi, warna
  // server khud purani queued images use kar lega (train endpoint me fallback).
  const snap = {
    hash: task.hash, text: task.text, type: task.type,
    exampleImage: task.exampleImage, mainImage: task.mainImage,
    tileImages: task.tileImages, tileCount: task.tileCount,
    solvedAt: Date.now()
  };

  // SEEDHA /train endpoint. UI ko turant free kar do — upload background me
  // hota rahega (slow internet pe images bade hote hain, user ko rukna na pade).
  callEndpoint('/train', { hash: task.hash, solution, snap, phash: task._phash })
    .then(ok => { if (!ok) console.log('[Dash] train upload fail'); });
  // Local STORE turant update — list foran update dikhe
  if (window.STORE) {
    window.STORE.local_kb = window.STORE.local_kb || {};
    window.STORE.local_kb[task.hash] = solution;
    window.STORE.unsolved_queue = (window.STORE.unsolved_queue || []).filter(i => i.hash !== task.hash);
    window.STORE['snap:' + task.hash] = snap;
  }
  btn.textContent = '💾 Save to KB'; btn.disabled = false;
  resetInputs(); showPlaceholder(); refresh();
};

// ============ SKIP / DELETE ============

$('skipBtn').onclick = function() {
  if (!currentTask) return;
  const h = currentTask.hash;
  (async () => {
    await callEndpoint('/delete-task', { hash: h });
    if (window.STORE) {
      if (window.STORE.local_kb) delete window.STORE.local_kb[h];
      window.STORE.unsolved_queue = (window.STORE.unsolved_queue || []).filter(i => i.hash !== h);
      delete window.STORE['snap:' + h];
    }
    resetInputs(); showPlaceholder(); refresh();
  })();
};

function showPlaceholder() {
  $('editorView').style.display = 'none';
  $('listView').style.display = 'block';
  currentKey = null; currentTask = null;
  refresh();
}

$('backBtn').onclick = () => { resetInputs(); showPlaceholder(); };

// ============ EXPORT / IMPORT / CLEAR ============

$('exportBtn').onclick = async function() {
  const btn = $('exportBtn'); const old = btn.textContent;
  btn.textContent = '⏳ Export ho raha...'; btn.disabled = true;
  // Poora data (images samet) seedha server se lao — local me ab sirf meta hota hai
  const full = window.serverGetFull ? await window.serverGetFull() : null;
  btn.textContent = old; btn.disabled = false;
  if (!full || full._status) { alert('Export fail — server se data nahi mila.'); return; }
  const out = { kb: full.kb || {}, snaps: full.snaps || {}, solved: full.snaps || {}, task_numbers: full.task_numbers || {}, phash_index: full.phash_index || {} };
  const blob = new Blob([JSON.stringify(out,null,2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'hcaptcha-kb-' + new Date().toISOString().slice(0,10) + '.json';
  a.click();
};

$('importBtn').onclick = () => $('importFile').click();
$('importFile').onchange = function() {
  const file = this.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const imp = JSON.parse(e.target.result);
      const impKb = imp.kb || imp; // backward compat
      const impSolved = imp.solved || {};
      chrome.storage.local.get(['local_kb','solved_tasks'], (data) => {
        let kbn = data.local_kb||{}, solved = data.solved_tasks||{}, c=0;
        for (const k in impKb) { if(!kbn[k]){ kbn[k]=impKb[k]; c++; } }
        for (const k in impSolved) { if(!solved[k]) solved[k]=impSolved[k]; }
        chrome.storage.local.set({local_kb:kbn, solved_tasks:solved}, () => { alert(c+' imported!'); refresh(); });
      });
    } catch(err){ alert('Invalid JSON!'); }
  };
  reader.readAsText(file);
};

$('clearQueueBtn').onclick = function() {
  if (!confirm('Unsolved queue + purana backup clear karein? (KB safe rahega)')) return;
  // Queue aur purana backup dono saaf — storage free karne ke liye
  chrome.storage.local.remove(['unsolved_queue', 'kb_backup'], () => {
    chrome.storage.local.set({ unsolved_queue: [] }, () => { showPlaceholder(); refresh(); });
  });
};

$('resetAllBtn').onclick = function() {
  if (!confirm('⚠️ SAB KUCH delete ho jayega:\n• Saari Trained training (KB)\n• Unsolved queue\n• Task numbers\n• Backup\n\nYe wapas nahi aayega. Pakka?')) return;
  if (!confirm('Aakhri baar: Sach me sab kuch reset karna hai?')) return;
  chrome.storage.local.get(null, (all) => {
    const snapKeys = Object.keys(all).filter(k => k.indexOf('snap:') === 0);
    const toRemove = ['local_kb', 'unsolved_queue', 'solved_tasks', 'task_numbers', 'task_counter', 'kb_backup'].concat(snapKeys);
    chrome.storage.local.remove(toRemove, () => {
      chrome.storage.local.set({
        local_kb: {}, unsolved_queue: [], solved_tasks: {},
        task_numbers: {}, task_counter: 0
      }, () => {
        alert('✅ Sab kuch reset ho gaya. Numbers ab #1 se shuru honge.');
        kb = {}; queue = []; solvedSnaps = {}; taskNumbers = {};
        showPlaceholder(); refresh();
      });
    });
  });
};

$('restoreBtn').onclick = function() {
  chrome.storage.local.get(['kb_backup'], (data) => {
    const bk = data.kb_backup;
    if (!bk) { alert('Koi backup nahi mila.'); return; }
    const when = new Date(bk.backedUpAt).toLocaleString();
    const kbCount = Object.keys(bk.kb || {}).length;
    if (!confirm(`Backup restore karein?\n\nBackup time: ${when}\nKB entries: ${kbCount}\n\nYe current KB ke saath merge hoga.`)) return;
    chrome.storage.local.get(['local_kb', 'solved_tasks'], (cur) => {
      let kbn = cur.local_kb || {}, solved = cur.solved_tasks || {}, c = 0;
      for (const k in bk.kb) { if (!kbn[k]) { kbn[k] = bk.kb[k]; c++; } }
      for (const k in (bk.solved || {})) { if (!solved[k]) solved[k] = bk.solved[k]; }
      chrome.storage.local.set({ local_kb: kbn, solved_tasks: solved }, () => {
        alert(c + ' entries restored!'); refresh();
      });
    });
  });
};

// ============ MANUAL ADD (apni image se train) ============

function aHashFromImg(imgEl) {
  try {
    const size = 8;
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(imgEl, 0, 0, size, size);
    const d = ctx.getImageData(0, 0, size, size).data;
    const gray = [];
    for (let i = 0; i < d.length; i += 4) gray.push(d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114);
    const avg = gray.reduce((a,b)=>a+b,0) / gray.length;
    let bits = '';
    for (const g of gray) bits += (g >= avg ? '1' : '0');
    return bits;
  } catch (e) { return null; }
}

$('manualAddBtn').onclick = () => $('manualImgFile').click();

$('manualImgFile').onchange = function() {
  const file = this.files && this.files[0];
  this.value = '';
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    const text = prompt('Is task ka instruction/text likhein (jaise: "Click the boat"):', '');
    if (text === null) return;
    const img = new Image();
    img.onload = () => {
      const phash = aHashFromImg(img);
      chrome.storage.local.get(['task_numbers', 'task_counter'], (d) => {
        const map = d.task_numbers || {};
        const next = (d.task_counter || 0) + 1;
        const hash = 'm_' + Date.now().toString(36);
        map[hash] = next;
        chrome.storage.local.set({ task_numbers: map, task_counter: next }, () => {
          taskNumbers = map;
          const task = {
            hash, text: text || '(manual)', type: 'click',
            mainImage: dataUrl, _phash: phash, isManual: true
          };
          currentTask = task; currentKey = hash;
          resetInputs();
          showEditor(task, null);
          $('actionOverride').value = '';
          applyMode('click_point', task, null);
          $('clickInfo').textContent = 'Apni image — point(s) mark karein, phir Save to KB';
        });
      });
    };
    img.src = dataUrl;
  };
  reader.readAsDataURL(file);
};

// ============ WEB DASHBOARD INIT ============

$('syncUrlText').textContent = location.origin;

function setStatus(text, color) {
  $('syncStatus').textContent = text;
  $('syncStatus').style.color = color;
}

async function tryConnect(secret, silent) {
  setStoredSecret(secret);
  if (!silent) setStatus('⏳ connect ho raha...', '#94a3b8');
  const status = await pullFromServer();
  if (status === 200) {
    setStatus('✅ connected', '#4ade80');
    $('listView').style.display = '';
    refresh();
    return true;
  } else if (status === 401) {
    setStatus('❌ galat secret', '#f87171');
  } else if (status === -1) {
    setStatus('❌ connect nahi hua (internet check karein)', '#f87171');
  } else {
    setStatus('❌ server error', '#f87171');
  }
  return false;
}

$('syncSaveBtn').onclick = () => {
  const s = ($('syncSecretInput').value || '').trim();
  if (!s) { alert('Secret daalein.'); return; }
  tryConnect(s, false);
};
$('syncTestBtn').onclick = () => {
  const s = ($('syncSecretInput').value || '').trim();
  if (!s) { alert('Secret daalein.'); return; }
  tryConnect(s, false);
};
$('refreshBtn').onclick = async () => {
  const btn = $('refreshBtn');
  const old = btn.textContent; btn.disabled = true; btn.textContent = '⏳ Syncing...';
  setStatus('⏳ sync ho raha...', '#94a3b8');
  const status = await pullFromServer();
  setStatus(status === 200 ? '✅ synced' : '❌ sync error', status === 200 ? '#4ade80' : '#f87171');
  btn.disabled = false; btn.textContent = old;
  refresh();
};

// Pehli load: agar pehle se secret saved hai to seedha connect karo
(async () => {
  const saved = getStoredSecret();
  if (saved) {
    $('syncSecretInput').value = saved;
    $('listView').style.display = 'none';
    await tryConnect(saved, true);
  } else {
    $('listView').style.display = 'none';
    setStatus('⚠️ secret daal kar Save dabayein', '#fbbf24');
  }
})();

// Dashboard JAB TAK KHULA HAI tabhi tak — har 4 sec halka silent sync (ab
// /list lightweight hai, sirf meta aata hai, isliye fast). Naya task jaldi dikhe.
const _liveInterval = setInterval(async () => {
  if (!_ready) return;
  if (currentTask) return; // editor khula hai — disturb mat karo
  if ($('editorView').style.display === 'block') return;
  const status = await pullFromServer();
  if (status === 200) refresh();
}, 4000);
window.addEventListener('beforeunload', () => clearInterval(_liveInterval));

// Jab pullFromServer() data badle to render update karo (debounced)
let liveTimer = null;
chrome.storage.onChanged.addListener(() => {
  if (currentTask) return;
  if ($('editorView').style.display === 'block') return;
  clearTimeout(liveTimer);
  liveTimer = setTimeout(refresh, 200);
});
