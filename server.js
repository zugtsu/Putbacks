// Putback home server: serves the phone app and keeps the learned item locations in data/db.json.
const http = require('http');
const fs = require('fs');
const path = require('path');
const kroger = require('./kroger');

const PORT = Number(process.env.PORT) || 3000;
// Localhost only by default; put an HTTPS proxy in front (e.g. Tailscale Serve) to reach it from a phone.
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
// PUTBACK_DATA lets a second copy (like a demo) keep its own tags.
const DATA_DIR = process.env.PUTBACK_DATA || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const ZXING_DIR = path.join(__dirname, 'node_modules', 'zxing-wasm');
const VENDOR = {
  '/vendor/zxing-reader.js': path.join(ZXING_DIR, 'dist', 'iife', 'reader', 'index.js'),
  '/vendor/zxing_reader.wasm': path.join(ZXING_DIR, 'dist', 'reader', 'zxing_reader.wasm'),
};

const SIDES = ['', 'L', 'R', 'EF', 'EB'];
const CODE_RE = /^[A-Za-z0-9-]{4,32}$/;
const MAX_BODY = 64 * 1024;

// Backup name lookup for things Kroger doesn't carry (about 100 a day, no key). Cached in db.json.
const LOOKUP_URL = 'https://api.upcitemdb.com/prod/trial/lookup?upc=';
const LOOKUP_MISS_RETRY_MS = 24 * 60 * 60 * 1000;

// settings.home = { from, to }: numbered aisles in that range belong to the user's department; anything
// Kroger puts elsewhere is out of bounds. Named spots count when they're in the zones list. Null until set.

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
};

function loadDb() {
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    db.items = db.items || {};
    db.lookups = db.lookups || {};
    db.settings = db.settings || {};
    if (!Array.isArray(db.settings.zones)) db.settings.zones = [];
    if (!db.settings.home) db.settings.home = null;
    return db;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // Keep the broken file around instead of silently overwriting it.
      const backup = DB_FILE + '.broken-' + Date.now();
      fs.copyFileSync(DB_FILE, backup);
      console.error(`Could not read ${DB_FILE}, copied it to ${backup} and started fresh.`);
    }
    return { items: {}, lookups: {}, settings: { zones: [], home: null } };
  }
}

const db = loadDb();

// Writes are queued so two quick saves from the phone never interleave.
let writing = Promise.resolve();
function saveDb() {
  writing = writing.then(async () => {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(db, null, 2));
    await fs.promises.rename(tmp, DB_FILE);
  });
  return writing;
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function cleanItem(code, body) {
  const zone = String(body.zone || '').trim().slice(0, 40);
  // A note alone is enough for items with no real aisle (e.g. "deli cooler").
  const note = String(body.note || '').trim().slice(0, 200);
  const found = String(body.found || '').trim().slice(0, 120);
  // "Not my department" items need no spot at all.
  const notMine = body.notMine === true;
  if (!zone && !note && !notMine) throw Object.assign(new Error('Pick an aisle or write a note.'), { status: 400 });
  const side = zone && SIDES.includes(body.side) ? body.side : '';
  const bay = zone && Number.isInteger(body.bay) && body.bay > 0 && body.bay < 100 ? body.bay : null;
  return {
    code,
    name: String(body.name || '').trim().slice(0, 200),
    zone,
    side,
    bay,
    note,
    found,
    notMine,
    updatedAt: new Date().toISOString(),
  };
}

function tidyTitle(title) {
  return String(title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

async function lookupName(code) {
  const cached = db.lookups[code];
  if (cached && (cached.name || Date.now() - Date.parse(cached.at) < LOOKUP_MISS_RETRY_MS)) return cached;
  // UPCs and EANs only; the service rejects anything else.
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return { name: '' };

  let name = '';
  try {
    const res = await fetch(LOOKUP_URL + code, { signal: AbortSignal.timeout(6000) });
    if (res.status === 429) return { name: '', limited: true };
    const data = await res.json();
    name = tidyTitle(data.items && data.items[0] && data.items[0].title);
  } catch {
    // Offline or slow: don't cache, try again next scan.
    return { name: '' };
  }
  db.lookups[code] = { name, at: new Date().toISOString() };
  await saveDb();
  return db.lookups[code];
}

// Kroger first (store's own name and aisle), then the free name lookup.
async function lookupItem(code) {
  try {
    const k = await kroger.lookup(code);
    if (k && k.name) return { ...k, source: 'kroger', at: new Date().toISOString() };
  } catch (err) {
    console.error(err.message);
  }
  return lookupName(code);
}

async function handleApi(req, res, url) {
  const look = url.pathname.match(/^\/api\/lookup\/([^/]+)$/);
  if (look && req.method === 'GET') {
    const code = decodeURIComponent(look[1]);
    if (!CODE_RE.test(code)) return send(res, 400, { error: 'That barcode looks wrong.' });
    return send(res, 200, await lookupItem(code));
  }

  if (url.pathname === '/api/search' && req.method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim();
    if (q.length < 2 || q.length > 80) return send(res, 400, { error: 'Type at least 2 letters.' });
    try {
      // Kroger returns nothing if any one word misses, so retry leaving one word out at a time.
      const words = q.split(/\s+/);
      const tries = [q];
      for (let i = 0; i < words.length && words.length > 1; i++) {
        tries.push(words.filter((_, j) => j !== i).join(' '));
      }
      for (const term of tries.slice(0, 5)) {
        const results = await kroger.search(term);
        if (!results) return send(res, 503, { error: "Kroger isn't connected, so search is off." });
        if (results.length || term === tries[tries.length - 1]) return send(res, 200, { results, term });
      }
      return send(res, 200, { results: [], term: q });
    } catch (err) {
      console.error(err.message);
      return send(res, 502, { error: "Kroger didn't answer. Try again." });
    }
  }

  if (url.pathname === '/api/kroger' && req.method === 'GET') {
    try {
      return send(res, 200, await kroger.storeInfo());
    } catch (err) {
      return send(res, 200, { configured: true, hasKeys: true, error: err.message });
    }
  }

  // Setup: keys go in once and are never sent back out.
  if (url.pathname === '/api/kroger/keys' && req.method === 'PUT') {
    const body = await readBody(req);
    const id = String(body.client_id || '').trim();
    const secret = String(body.client_secret || '').trim();
    if (!id || !secret || id.length > 200 || secret.length > 200) {
      return send(res, 400, { error: 'Paste both the Client ID and the Client Secret.' });
    }
    try {
      await kroger.setKeys(id, secret);
      return send(res, 200, { ok: true });
    } catch {
      return send(res, 400, { error: "Kroger didn't accept those keys. Check for typos or extra spaces." });
    }
  }

  if (url.pathname === '/api/kroger/stores' && req.method === 'GET') {
    const zip = (url.searchParams.get('zip') || '').trim();
    if (!/^\d{5}$/.test(zip)) return send(res, 400, { error: 'Enter a 5-digit ZIP code.' });
    try {
      const stores = await kroger.findStores(zip);
      if (!stores) return send(res, 400, { error: 'Add your Kroger keys first.' });
      return send(res, 200, { stores });
    } catch (err) {
      console.error(err.message);
      return send(res, 502, { error: "Kroger didn't answer. Try again." });
    }
  }

  if (url.pathname === '/api/kroger/store' && req.method === 'PUT') {
    const body = await readBody(req);
    const id = String(body.location_id || '');
    if (!/^\d{8}$/.test(id)) return send(res, 400, { error: 'That store ID looks wrong.' });
    try {
      const s = await kroger.setStore(id);
      if (!s) return send(res, 400, { error: "Couldn't find that store." });
      return send(res, 200, { configured: true, hasKeys: true, ...s });
    } catch (err) {
      console.error(err.message);
      return send(res, 502, { error: "Kroger didn't answer. Try again." });
    }
  }

  if (url.pathname === '/api/state' && req.method === 'GET') {
    return send(res, 200, db);
  }

  if (url.pathname === '/api/settings' && req.method === 'PUT') {
    const body = await readBody(req);
    if (Array.isArray(body.zones)) {
      db.settings.zones = [...new Set(body.zones.map((z) => String(z).trim().slice(0, 40)).filter(Boolean))].slice(0, 200);
    }
    if (body.home === null) db.settings.home = null;
    if (body.home) {
      const from = parseInt(body.home.from, 10);
      const to = parseInt(body.home.to, 10);
      if (!(from > 0 && to >= from && to < 10000)) return send(res, 400, { error: 'Aisle range looks wrong.' });
      db.settings.home = { from, to };
    }
    await saveDb();
    return send(res, 200, db.settings);
  }

  const m = url.pathname.match(/^\/api\/items\/([^/]+)$/);
  if (m) {
    const code = decodeURIComponent(m[1]);
    if (!CODE_RE.test(code)) return send(res, 400, { error: 'That barcode looks wrong.' });
    if (req.method === 'PUT') {
      db.items[code] = cleanItem(code, await readBody(req));
      await saveDb();
      return send(res, 200, db.items[code]);
    }
    if (req.method === 'DELETE') {
      delete db.items[code];
      await saveDb();
      return send(res, 200, { ok: true });
    }
  }

  send(res, 404, { error: 'Not found' });
}

function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (VENDOR[url.pathname]) return serveFile(res, VENDOR[url.pathname]);

    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403);
      return res.end();
    }
    serveFile(res, file);
  } catch (err) {
    if (!err.status) console.error(err);
    if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : 'Server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Putback running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Saving locations to ${DB_FILE}`);
});
