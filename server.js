// hCaptcha Trainer Pro — KB Sync Server
// Lightweight: bas KB (JSON) store karta hai aur 2 PCs ke beech sync karta hai.
// Koi background processing nahi — sirf pull (GET) aur push (POST).

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();

// ===== CONFIG (Railway environment variables se aati hain) =====
const PORT = process.env.PORT || 3000;
// SECRET: sirf aap jaante ho. Dono PCs me yahi daalna hoga. Railway Variables me set karein.
const SECRET = process.env.SYNC_SECRET || 'change-me-please';
// DATA_DIR: Railway Volume ka mount path (permanent storage). Default /data
const DATA_DIR = process.env.DATA_DIR || '/data';
const KB_FILE = path.join(DATA_DIR, 'kb.json');

// Data folder bana lo agar na ho
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}

// Bade JSON allow karo (KB me compressed base64 images hoti hain)
app.use(express.json({ limit: '60mb' }));

// CORS — extension (chrome-extension://...) se requests allow karo
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-Sync-Secret');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Secret check middleware — galat secret = reject
function auth(req, res, next) {
  const given = req.header('X-Sync-Secret') || req.query.secret || '';
  if (given !== SECRET) return res.status(401).json({ error: 'Unauthorized — galat secret' });
  next();
}

// Health check (browser me khol kar dekh sakte ho server zinda hai)
app.get('/', (req, res) => {
  let info = { ok: true, service: 'hCaptcha KB Sync', exists: false };
  try {
    const st = fs.statSync(KB_FILE);
    info.exists = true;
    info.sizeKB = Math.round(st.size / 1024);
    info.updatedAt = st.mtime;
  } catch (e) {}
  res.json(info);
});

// KB PULL — cloud se latest KB lao
app.get('/kb', auth, (req, res) => {
  try {
    if (!fs.existsSync(KB_FILE)) {
      return res.json({ kb: {}, snaps: {}, unsolved: [], task_numbers: {}, task_counter: 0, phash_index: {}, updatedAt: 0 });
    }
    const raw = fs.readFileSync(KB_FILE, 'utf8');
    res.type('application/json').send(raw);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// KB PUSH — is PC ka KB + unsolved cloud pe save karo
app.post('/kb', auth, (req, res) => {
  try {
    const body = req.body || {};
    const payload = {
      kb: body.kb || {},
      snaps: body.snaps || {},
      unsolved: body.unsolved || [],
      task_numbers: body.task_numbers || {},
      task_counter: body.task_counter || 0,
      phash_index: body.phash_index || {},
      updatedAt: Date.now()
    };
    fs.writeFileSync(KB_FILE, JSON.stringify(payload));
    res.json({ ok: true, updatedAt: payload.updatedAt, kbCount: Object.keys(payload.kb).length, unsolvedCount: payload.unsolved.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log('KB Sync server running on port', PORT, '| data:', KB_FILE);
});
