'use strict';
// Putback phone app: scan a go-back cart, tag unknown items once, walk the sorted route.

const KEYS = { db: 'putback.db', pending: 'putback.pending', cart: 'putback.cart' };
const SIDES = ['L', 'R', 'EF', 'EB', ''];
const SIDE_LABEL = { L: 'Left', R: 'Right', EF: 'Endcap front', EB: 'Endcap back', '': 'None' };
const SIDE_SHORT = { L: 'L', R: 'R', EF: 'endcap F', EB: 'endcap B', '': '' };
const BAYS = 12;
const CODE_RE = /^[A-Za-z0-9-]{4,32}$/;
// A code has to leave the camera this long before it counts as a second unit.
const RESCAN_GAP_MS = 1500;
const CHEERS = ['Nice', 'Ok go off', 'Easy', 'Smooth', 'On a roll', 'Keep it moving', 'Clean'];

const $ = (id) => document.getElementById(id);

function read(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or full storage: the app still works for this visit.
  }
}

let db = read(KEYS.db, { items: {}, settings: { zones: [] } });
let pending = read(KEYS.pending, []);
let cart = read(KEYS.cart, { lines: [], done: [], skipped: [] });
let view = 'scan';

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

let toastTimer;
function toast(msg, warn) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('warn', !!warn);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), warn ? 4000 : 2200);
}

/* ---------- Barcodes ---------- */

function upcEtoA(e) {
  const ns = e[0], d = e.slice(1, 7), check = e[7];
  let body;
  if ('012'.includes(d[5])) body = d[0] + d[1] + d[5] + '0000' + d[2] + d[3] + d[4];
  else if (d[5] === '3') body = d[0] + d[1] + d[2] + '00000' + d[3] + d[4];
  else if (d[5] === '4') body = d[0] + d[1] + d[2] + d[3] + '00000' + d[4];
  else body = d.slice(0, 5) + '0000' + d[5];
  return ns + body + check;
}

// The same product can come back as UPC-A, EAN-13 or UPC-E; store it one way.
function normalize(raw, format) {
  let code = String(raw).trim().replace(/\s+/g, '');
  if (/^\d{13}$/.test(code) && code[0] === '0') code = code.slice(1);
  if (format === 'UPC_E' && /^\d{8}$/.test(code)) code = upcEtoA(code);
  return code;
}

/* ---------- Locations ---------- */

function fmtLoc(item) {
  if (!item.zone) {
    // Note-only items (no real aisle): show the start of the note.
    const note = item.note || '';
    return note.length > 24 ? note.slice(0, 23) + '…' : note;
  }
  return [item.zone, SIDE_SHORT[item.side || ''], item.bay ? 'bay ' + item.bay : '']
    .filter(Boolean)
    .join(' · ');
}

function locKey(item) {
  if (!item.zone) return 'note|' + (item.note || '');
  return [item.zone, item.side || '', item.bay || ''].join('|');
}

const isNum = (z) => z !== '' && Number.isFinite(Number(z));

// Where a zone falls in the walking order. Numbered aisles that aren't listed
// (Kroger may know aisles the user never added) sit between the numbers around them.
function zoneRank(zone) {
  const zones = db.settings.zones;
  const i = zones.indexOf(zone);
  if (i !== -1) return i;
  if (isNum(zone)) {
    const n = Number(zone);
    const bigger = zones.findIndex((z) => isNum(z) && Number(z) > n);
    if (bigger !== -1) return bigger - 0.5;
    const lastNum = zones.reduce((idx, z, j) => (isNum(z) ? j : idx), -1);
    if (lastNum !== -1) return lastNum + 0.5;
  }
  return zones.length;
}

function sortKey(item) {
  const side = item.side || '';
  // Walk an aisle front endcap first, then down both sides by bay, then the back endcap.
  const sideRank = side === 'EF' ? 0 : side === 'EB' ? 2 : 1;
  return [zoneRank(item.zone), isNum(item.zone) ? Number(item.zone) : 0, sideRank, item.bay || 0, side === 'R' ? 1 : 0];
}

// The user's department: numbered aisles in the set range, plus named spots on the list (walls, areas).
function isHome(zone) {
  if (!zone) return false;
  const h = db.settings.home;
  if (isNum(zone)) return !h || (Number(zone) >= h.from && Number(zone) <= h.to);
  return db.settings.zones.includes(zone);
}

function krogerSpots(code) {
  const looked = (db.lookups || {})[code];
  return ((looked && looked.aisles) || []).filter((a) => a.zone);
}

// A user's tag wins; otherwise the first Kroger aisle that's in the department.
function locationFor(code) {
  const it = db.items[code];
  if (it) return it.notMine ? null : { ...it, from: 'you' };
  const a = krogerSpots(code).find((x) => isHome(x.zone));
  return a ? { zone: a.zone, side: a.side, bay: a.bay, from: 'kroger' } : null;
}

// Out of bounds: marked "not my department", or every aisle Kroger lists is outside the range.
// Returns where it goes instead, or null when it's in the department (or nobody knows yet).
function outOfBounds(code) {
  const it = db.items[code];
  if (it) return it.notMine ? { where: it.note || 'Another department' } : null;
  const spots = krogerSpots(code);
  if (!spots.length || spots.some((s) => isHome(s.zone))) return null;
  return { where: 'Kroger: ' + (spots[0].label || 'aisle ' + spots[0].zone) };
}

function cmpKeys(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

function itemName(code) {
  const it = db.items[code];
  const looked = (db.lookups || {})[code];
  if (it && it.name) return it.name;
  if (looked && looked.name) return looked.name;
  return it ? 'Unnamed item' : 'New item';
}

const NO_PHOTO_SVG =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8 12 3 3 8v8l9 5 9-5z"/>' +
  '<path d="m3 8 9 5 9-5M12 13v8"/></svg>';

function noPhoto(big) {
  const tile = el('div', 'thumb none' + (big ? ' big' : ''));
  tile.innerHTML = NO_PHOTO_SVG;
  return tile;
}

// Product photo from Kroger, or a box icon so rows still line up.
function thumb(code, big) {
  const looked = (db.lookups || {})[code];
  const src = looked && looked.image;
  if (!src) return noPhoto(big);
  const img = el('img', 'thumb' + (big ? ' big' : ''));
  img.alt = '';
  img.loading = 'lazy';
  img.src = src;
  img.onerror = () => img.replaceWith(noPhoto(big));
  return img;
}

// Kroger sometimes files an item under a department instead of an aisle ("DELI", "DRUG/GM").
function krogerHint(code) {
  const looked = (db.lookups || {})[code];
  const a = looked && looked.aisles && looked.aisles.find((x) => !x.zone && x.label);
  return a ? a.label : '';
}

// Kroger's other spots for an item, besides the one the route uses.
function otherSpots(code) {
  const looked = (db.lookups || {})[code];
  const loc = locationFor(code);
  if (!loc) return [];
  const key = locKey(loc);
  // Only spots inside the department are worth mentioning.
  return ((looked && looked.aisles) || []).filter((a) => a.zone && isHome(a.zone) && locKey(a) !== key);
}

function alsoLine(code) {
  const spots = otherSpots(code);
  return spots.length ? el('div', 'also', 'Also at ' + spots.map(fmtLoc).join(', ')) : null;
}

// Kroger aisles change with resets, so look again after a while.
const LOOKUP_FRESH_MS = 6 * 60 * 60 * 1000;
const lookingUp = new Set();

// Resolves false only when the lookup couldn't reach the server, so "no spot" isn't claimed while offline.
async function fetchName(code, announce) {
  const known = (db.lookups || {})[code];
  // Older Kroger answers were saved before photos existed; those count as stale.
  const complete = known && known.name && (known.image || known.source !== 'kroger');
  const fresh = complete && Date.now() - Date.parse(known.at || 0) < LOOKUP_FRESH_MS;
  if (fresh || lookingUp.has(code)) return true;
  lookingUp.add(code);
  try {
    const res = await api('GET', '/api/lookup/' + encodeURIComponent(code));
    if (res.name) {
      db.lookups = db.lookups || {};
      db.lookups[code] = res;
      write(KEYS.db, db);
      render();
      if (sheet && sheet.code === code) fillFromKroger();
      const loc = locationFor(code);
      if (announce && loc && loc.from === 'kroger') toast(`${itemName(code)} → ${fmtLoc(loc)}`);
    }
    return true;
  } catch {
    // No name is fine; the item still works by barcode.
    return false;
  } finally {
    lookingUp.delete(code);
  }
}

/* ---------- Sync with the home server ---------- */

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status });
  return data;
}

function applyOp(op) {
  if (op.type === 'put') db.items[op.code] = { ...op.item, code: op.code };
  else if (op.type === 'del') delete db.items[op.code];
  else if (op.type === 'zones') db.settings.zones = op.zones;
  else if (op.type === 'settings') Object.assign(db.settings, op.settings);
}

function setOnline(online) {
  $('status').hidden = online;
}

function queue(op) {
  applyOp(op);
  pending.push(op);
  write(KEYS.db, db);
  write(KEYS.pending, pending);
  flush();
}

let flushing = false;
async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    while (pending.length) {
      const op = pending[0];
      try {
        if (op.type === 'put') await api('PUT', '/api/items/' + encodeURIComponent(op.code), op.item);
        else if (op.type === 'del') await api('DELETE', '/api/items/' + encodeURIComponent(op.code));
        else if (op.type === 'zones') await api('PUT', '/api/settings', { zones: op.zones });
        else if (op.type === 'settings') await api('PUT', '/api/settings', op.settings);
      } catch (err) {
        if (!err.status) {
          setOnline(false);
          return;
        }
        // The server refused it, so retrying won't help.
        toast(err.message);
      }
      pending.shift();
      write(KEYS.pending, pending);
    }
    setOnline(true);
  } finally {
    flushing = false;
  }
}

async function load() {
  try {
    const prevLookups = db.lookups || {};
    db = await api('GET', '/api/state');
    // Kroger answers only live on this phone, so keep them across reloads.
    db.lookups = { ...(db.lookups || {}), ...prevLookups };
    // Re-apply anything saved while offline so it doesn't flicker away before it syncs.
    pending.forEach(applyOp);
    write(KEYS.db, db);
    setOnline(true);
    flush();
    cart.lines.forEach((l) => fetchName(l.code));
    loadStore();
  } catch {
    setOnline(false);
  }
  render();
}

/* ---------- Kroger setup ---------- */

let krogerState = { configured: true };

async function loadStore() {
  try {
    renderKroger(await api('GET', '/api/kroger'));
  } catch {
    $('kroger-status').textContent = '';
  }
}

function renderKroger(s) {
  krogerState = s;
  $('kroger-status').textContent = s.error
    ? `Kroger is set up but not answering: ${s.error}`
    : s.configured
      ? `Connected to ${s.name}, ${s.address}`
      : s.hasKeys
        ? 'Keys saved. Now pick your store.'
        : 'Not connected yet. Items only get names and spots you tag.';
  $('keys-saved').hidden = !s.hasKeys;
  $('keys-form').hidden = !!s.hasKeys;
  $('setup-nudge').hidden = !!s.configured;
  // Open the setup section until it's done.
  if (!s.configured) $('kroger-setup').open = true;
}

async function saveKeys() {
  const err = $('kroger-error');
  const client_id = $('k-id').value.trim();
  const client_secret = $('k-secret').value.trim();
  if (!client_id || !client_secret) {
    err.textContent = 'Paste both the Client ID and the Client Secret.';
    return;
  }
  err.textContent = '';
  $('keys-save').textContent = 'Checking…';
  try {
    await api('PUT', '/api/kroger/keys', { client_id, client_secret });
    $('k-id').value = '';
    $('k-secret').value = '';
    toast('Keys work. Saved');
    await loadStore();
    $('k-zip').focus();
  } catch (e) {
    err.textContent = e.status ? e.message : "Can't reach your PC right now.";
  } finally {
    $('keys-save').textContent = 'Save keys';
  }
}

async function findStores() {
  const err = $('kroger-error');
  const zip = $('k-zip').value.trim();
  const list = $('k-stores');
  if (!/^\d{5}$/.test(zip)) {
    err.textContent = 'Enter a 5-digit ZIP code.';
    return;
  }
  err.textContent = '';
  list.replaceChildren(el('li', 'empty', 'Looking…'));
  let res;
  try {
    res = await api('GET', '/api/kroger/stores?zip=' + zip);
  } catch (e) {
    list.replaceChildren();
    err.textContent = e.status ? e.message : "Can't reach your PC right now.";
    return;
  }
  list.replaceChildren();
  if (!res.stores.length) list.appendChild(el('li', 'empty', 'No stores near that ZIP.'));
  for (const s of res.stores) {
    const row = el('button', 'row' + (s.id === krogerState.id ? ' on' : ''));
    row.type = 'button';
    const txt = el('div', 'txt');
    txt.append(el('div', 'nm wrap', s.name), el('div', 'cd', s.address));
    row.appendChild(txt);
    row.addEventListener('click', () => pickStore(s.id));
    const li = el('li');
    li.appendChild(row);
    list.appendChild(li);
  }
}

async function pickStore(id) {
  const err = $('kroger-error');
  err.textContent = '';
  try {
    renderKroger(await api('PUT', '/api/kroger/store', { location_id: id }));
    $('k-stores').replaceChildren();
    // Spots from the old store are wrong for the new one.
    db.lookups = {};
    write(KEYS.db, db);
    cart.lines.forEach((l) => fetchName(l.code));
    toast(`Store set: ${krogerState.name}`);
    render();
  } catch (e) {
    err.textContent = e.status ? e.message : "Can't reach your PC right now.";
  }
}

/* ---------- Cart ---------- */

function saveCart() {
  write(KEYS.cart, cart);
}

function addToCart(code) {
  const line = cart.lines.find((l) => l.code === code);
  if (line) {
    line.qty++;
    cart.done = cart.done.filter((c) => c !== code);
  } else {
    cart.lines.unshift({ code, qty: 1 });
  }
  saveCart();
  renderCart();
  const loc = locationFor(code);
  let noped = false;
  if (outOfBounds(code)) {
    showNope(code);
    noped = true;
  } else {
    toast(loc ? `${itemName(code)} → ${fmtLoc(loc)}` : 'Looking it up…');
  }
  fetchName(code, true).then((reached) => {
    // Redraw now that the lookup is finished, so a no-spot item gets flagged in the list.
    renderCart();
    if (outOfBounds(code)) {
      if (!noped) showNope(code);
      return;
    }
    if (locationFor(code)) return;
    if (!reached) {
      toast("Couldn't look this one up right now", true);
      return;
    }
    // Neither the user nor Kroger has a spot for it: say so loudly so it gets set aside.
    beep(440);
    beep(440, 0.18);
    if (navigator.vibrate) navigator.vibrate([80, 60, 80]);
    const hint = krogerHint(code);
    toast(`No spot for ${itemName(code)}${hint ? ` (Kroger: ${hint})` : ''}. Set it aside or add a note`, true);
  });
}

let nopeTimer;

// Full-screen warning for an item from another department.
function showNope(code) {
  const oob = outOfBounds(code);
  $('nope-item').textContent = itemName(code);
  $('nope-where').textContent = oob ? oob.where : '';
  const sign = $('nope');
  sign.hidden = false;
  // Restart the slam-in animation even if the sign is already up.
  sign.classList.remove('slam');
  void sign.offsetWidth;
  sign.classList.add('slam');
  beep(220, 0, 'sawtooth', 0.22);
  beep(150, 0.24, 'sawtooth', 0.4);
  if (navigator.vibrate) navigator.vibrate([200, 80, 200]);
  clearTimeout(nopeTimer);
  nopeTimer = setTimeout(hideNope, 2600);
}

function hideNope() {
  clearTimeout(nopeTimer);
  $('nope').hidden = true;
}

function removeLine(code) {
  cart.lines = cart.lines.filter((l) => l.code !== code);
  cart.done = cart.done.filter((c) => c !== code);
  cart.skipped = cart.skipped.filter((c) => c !== code);
  saveCart();
  render();
}

function clearCart() {
  cart = { lines: [], done: [], skipped: [] };
  saveCart();
  render();
}

function addTyped(e) {
  e.preventDefault();
  const input = $('manual-code');
  const code = normalize(input.value);
  if (!CODE_RE.test(code)) {
    toast('That barcode looks wrong');
    return;
  }
  input.value = '';
  addToCart(code);
}

/* ---------- Camera ---------- */

let audio = null;
const seen = new Map();

function camMsg(msg) {
  $('cam-msg').textContent = msg;
}

function beep(freq = 1320, delay = 0, type = 'sine', length = 0.12) {
  if (!audio) return;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  const t = audio.currentTime + delay;
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.15, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + length);
  osc.connect(gain).connect(audio.destination);
  osc.start(t);
  osc.stop(t + length);
}

function onDetect(text, format) {
  const code = normalize(text, format);
  if (!CODE_RE.test(code)) return;
  const now = Date.now();
  const last = seen.get(code) || 0;
  seen.set(code, now);
  if (now - last < RESCAN_GAP_MS) return;

  beep();
  if (navigator.vibrate) navigator.vibrate(40);
  const cam = $('camera');
  cam.classList.add('hit');
  setTimeout(() => cam.classList.remove('hit'), 250);
  addToCart(code);
}

// ZXing compiled to WebAssembly; reliable on retail barcodes in phone browsers.
const READ_OPTS = {
  formats: ['UPCA', 'UPCE', 'EAN13', 'EAN8', 'Code128'],
  tryHarder: true,
  tryRotate: true,
  maxNumberOfSymbols: 1,
};
// Check frames this often; each read takes ~20–60 ms on a phone.
const SCAN_EVERY_MS = 120;

let zxingReady = null;
function zxing() {
  if (!window.ZXingWASM) return Promise.reject(new Error('scanner script missing'));
  // Load the .wasm from this server instead of the library's default CDN.
  zxingReady = zxingReady || window.ZXingWASM.prepareZXingModule({
    overrides: { locateFile: (file, prefix) => (file.endsWith('.wasm') ? '/vendor/' + file : prefix + file) },
    fireImmediately: true,
  });
  return zxingReady;
}

let stream = null;
let scanTimer = null;
const frame = document.createElement('canvas');
const frameCtx = frame.getContext('2d', { willReadFrequently: true });

function unlockAudio() {
  // iOS only lets a page make sound after a tap, so set audio up on one.
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    audio.resume();
  } catch {
    audio = null;
  }
}

async function scanFrame() {
  const video = $('video');
  if (!stream) return;
  if (video.readyState >= 2 && video.videoWidth) {
    // Read the middle band of the picture (where the box is), shrunk to keep it quick.
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const bandH = Math.round(vh * 0.6);
    const scale = Math.min(1, 1280 / vw);
    frame.width = Math.round(vw * scale);
    frame.height = Math.round(bandH * scale);
    frameCtx.drawImage(video, 0, Math.round((vh - bandH) / 2), vw, bandH, 0, 0, frame.width, frame.height);
    try {
      const results = await window.ZXingWASM.readBarcodes(frameCtx.getImageData(0, 0, frame.width, frame.height), READ_OPTS);
      const hit = results.find((r) => r.isValid);
      if (hit) onDetect(hit.text, hit.format);
    } catch {
      // A bad frame; try the next one.
    }
  }
  if (stream) scanTimer = setTimeout(scanFrame, SCAN_EVERY_MS);
}

async function startCamera() {
  if (!window.isSecureContext) {
    camMsg('The camera needs the https:// link');
    return;
  }
  unlockAudio();
  camMsg('Starting camera…');
  try {
    await zxing();
  } catch {
    camMsg("Scanner didn't load. Type barcodes below");
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
  } catch (err) {
    stopCamera();
    camMsg(err && err.name === 'NotAllowedError'
      ? 'Camera blocked. Allow it in Settings › Safari › Camera'
      : "Couldn't start the camera. Type barcodes below");
    return;
  }
  const track = stream.getVideoTracks()[0];
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  if (caps.focusMode && caps.focusMode.includes('continuous')) {
    track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
  }
  const video = $('video');
  video.setAttribute('playsinline', '');
  video.muted = true;
  video.srcObject = stream;
  await video.play().catch(() => {});
  $('camera').classList.add('live');
  camMsg('Hold 6–8 inches away');
  scanFrame();
}

function stopCamera() {
  clearTimeout(scanTimer);
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  $('video').srcObject = null;
  $('camera').classList.remove('live');
  camMsg('');
}

// Backup for stubborn barcodes: the phone's native camera takes a sharper, focused photo.
async function scanPhoto(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  unlockAudio();
  toast('Reading photo…');
  try {
    await zxing();
    const results = await window.ZXingWASM.readBarcodes(file, READ_OPTS);
    const hit = results.find((r) => r.isValid);
    if (hit) {
      seen.delete(normalize(hit.text, hit.format));
      onDetect(hit.text, hit.format);
    } else {
      toast("Couldn't find a barcode in that photo. Try closer and straight on", true);
    }
  } catch {
    toast("Couldn't read that photo", true);
  }
}

/* ---------- Route ---------- */

function buildStops() {
  const groups = new Map();
  for (const line of cart.lines) {
    // Other departments' stuff never makes the route.
    if (outOfBounds(line.code)) continue;
    const it = locationFor(line.code);
    const key = it ? locKey(it) : 'new|' + line.code;
    if (!groups.has(key)) groups.set(key, { key, item: it || null, lines: [] });
    groups.get(key).lines.push(line);
  }
  const stops = [...groups.values()];
  for (const s of stops) {
    s.done = s.lines.every((l) => cart.done.includes(l.code));
    s.skipped = s.lines.some((l) => cart.skipped.includes(l.code));
    // Skipped stops go last, then items with no location yet.
    s.sort = [s.skipped ? 1 : 0, s.item ? 0 : 1, ...(s.item ? sortKey(s.item) : [])];
  }
  return stops.sort((a, b) => cmpKeys(a.sort, b.sort));
}

function currentStop(stops) {
  return stops.find((s) => !s.done) || null;
}

function markDone(stop) {
  for (const l of stop.lines) {
    if (!cart.done.includes(l.code)) cart.done.push(l.code);
  }
  cart.skipped = cart.skipped.filter((c) => !stop.lines.some((l) => l.code === c));
  saveCart();
  const left = buildStops().filter((s) => !s.done).length;
  if (left) toast(CHEERS[Math.floor(Math.random() * CHEERS.length)]);
  render();
}

function onShelved() {
  const stop = currentStop(buildStops());
  if (!stop) {
    clearCart();
    showView('scan');
    return;
  }
  if (!stop.item) {
    const code = stop.lines[0].code;
    openSheet(code, () => markDone({ lines: stop.lines }));
    return;
  }
  markDone(stop);
}

function onSkip() {
  const stop = currentStop(buildStops());
  if (!stop) return;
  for (const l of stop.lines) {
    cart.skipped = cart.skipped.filter((c) => c !== l.code);
    cart.skipped.push(l.code);
  }
  saveCart();
  render();
}

/* ---------- Location sheet ---------- */

let sheet = null;

function pillGroup(container, options, selected, onPick) {
  container.replaceChildren();
  for (const [value, label] of options) {
    const b = el('button', value === selected ? 'on' : '', label);
    b.type = 'button';
    b.addEventListener('click', () => {
      onPick(value);
      container.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      updateSaveLabel();
    });
    container.appendChild(b);
  }
}

function updateSaveLabel() {
  const note = $('sheet-note').value.trim();
  $('sheet-save').textContent = sheet.notMine
    ? 'Save as not my problem'
    : sheet.zone ? 'Save ' + fmtLoc(sheet) : note ? 'Save note' : 'Save it';
  $('sheet-error').textContent = '';
}

function setNotMine(on) {
  sheet.notMine = on;
  const b = $('sheet-notmine');
  b.classList.toggle('on', on);
  b.setAttribute('aria-pressed', String(on));
  b.textContent = on ? 'Not my department ✓' : 'Not my department';
  updateSaveLabel();
}

function openSheet(code, afterSave) {
  const it = db.items[code];
  sheet = { code, afterSave, zone: it ? it.zone : '', side: it ? it.side || '' : '', bay: it ? it.bay : null };

  $('sheet-title').textContent = it ? 'Edit location' : "Where's this live?";
  $('sheet-code').textContent = code;
  $('sheet-name').value = (it && it.name) || '';
  $('sheet-note').value = (it && it.note) || '';
  $('sheet-found').value = (it && it.found) || '';
  $('sheet-delete').hidden = !it;

  renderPicks();
  setNotMine(!!(it && it.notMine));
  fillFromKroger();
  $('scrim').hidden = false;
  if (!it) fetchName(code);
}

function renderPicks() {
  renderZonePills();
  pillGroup($('pick-side'), SIDES.map((s) => [s, SIDE_LABEL[s]]), sheet.side, (v) => { sheet.side = v; });
  const bays = [[null, 'None']];
  for (let i = 1; i <= Math.max(BAYS, sheet.bay || 0); i++) bays.push([i, String(i)]);
  pillGroup($('pick-bay'), bays, sheet.bay, (v) => { sheet.bay = v; });
  updateSaveLabel();
}

// Show Kroger's spots as one-tap picks, and start a new item on the first one.
function fillFromKroger() {
  const looked = (db.lookups || {})[sheet.code];
  if (!$('sheet-name').value && looked && looked.name) $('sheet-name').value = looked.name;

  const spots = ((looked && looked.aisles) || []).filter((a) => a.zone);
  const box = $('kroger-spots');
  box.replaceChildren();
  $('kroger-wrap').hidden = !spots.length;
  for (const a of spots) {
    const b = el('button', null, fmtLoc(a));
    b.type = 'button';
    b.addEventListener('click', () => {
      Object.assign(sheet, { zone: a.zone, side: a.side, bay: a.bay });
      renderPicks();
    });
    box.appendChild(b);
  }
  if (spots.length && !db.items[sheet.code] && !sheet.zone) {
    const first = spots.find((s) => isHome(s.zone)) || spots[0];
    Object.assign(sheet, { zone: first.zone, side: first.side, bay: first.bay });
    renderPicks();
  }
}

function renderZonePills() {
  const box = $('pick-zone');
  // Named spots plus aisles already used in tags, so common ones are one tap.
  const used = Object.values(db.items).map((i) => i.zone).filter(Boolean);
  const zones = [...new Set([...db.settings.zones, ...used, sheet.zone].filter(Boolean))]
    .sort((a, b) => cmpKeys([zoneRank(a), isNum(a) ? Number(a) : 0], [zoneRank(b), isNum(b) ? Number(b) : 0]));
  pillGroup(box, zones.map((z) => [z, z]), sheet.zone, (v) => { sheet.zone = v; });

  const add = el('button', 'add', '+ New');
  add.type = 'button';
  add.addEventListener('click', () => showZoneInput(add));
  box.appendChild(add);
}

function showZoneInput(addBtn) {
  const input = el('input', 'pill-input');
  input.placeholder = '101';
  input.maxLength = 40;
  input.setAttribute('aria-label', 'New aisle or wall');
  input.setAttribute('enterkeyhint', 'done');
  const ok = el('button', 'on', 'Add');
  ok.type = 'button';
  const submit = () => {
    const name = input.value.trim();
    if (!name) {
      renderZonePills();
      return;
    }
    addZone(name);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      renderZonePills();
    }
  });
  ok.addEventListener('click', submit);
  addBtn.replaceWith(input, ok);
  input.focus();
}

// Numbered aisles slot in next to their neighbours; walls and other names go at the end.
// Either way the order can be fixed under Items › Aisles and walls.
function addZone(name) {
  const zones = [...db.settings.zones];
  if (!zones.includes(name)) {
    const n = Number(name);
    let at = zones.length;
    if (Number.isFinite(n)) {
      const bigger = zones.findIndex((z) => Number.isFinite(Number(z)) && Number(z) > n);
      const lastNum = zones.reduce((idx, z, i) => (Number.isFinite(Number(z)) ? i : idx), -1);
      at = bigger !== -1 ? bigger : lastNum + 1 || zones.length;
    }
    zones.splice(at, 0, name);
    queue({ type: 'zones', zones });
    toast(`Added ${name}`);
  }
  sheet.zone = name;
  renderZonePills();
  updateSaveLabel();
}

function closeSheet() {
  $('scrim').hidden = true;
  sheet = null;
}

function saveSheet() {
  const note = $('sheet-note').value.trim();
  if (!sheet.zone && !note && !sheet.notMine) {
    $('sheet-error').textContent = 'Pick an aisle, or write where it goes in the note.';
    return;
  }
  const { code, afterSave } = sheet;
  const isNew = !db.items[code];
  queue({
    type: 'put',
    code,
    item: {
      name: $('sheet-name').value.trim(),
      zone: sheet.zone,
      side: sheet.side,
      bay: sheet.bay,
      note,
      found: $('sheet-found').value.trim(),
      notMine: !!sheet.notMine,
    },
  });
  closeSheet();
  toast(isNew ? "Saved. You'll never tag this one again" : 'Updated');
  if (afterSave) afterSave();
  else render();
}

function deleteFromSheet() {
  const code = sheet.code;
  if (!confirm(`Forget ${itemName(code)}? You'll have to tag it again next time.`)) return;
  queue({ type: 'del', code });
  closeSheet();
  toast('Forgotten');
  render();
}

/* ---------- Find ---------- */

let findTimer;
let findSeq = 0;

async function runFind() {
  const q = $('find-q').value.trim();
  const list = $('find-list');
  const sub = $('find-sub');
  if (q.length < 2) {
    list.replaceChildren();
    sub.textContent = 'Search your store by name';
    return;
  }
  const seq = ++findSeq;
  sub.textContent = 'Searching…';
  let res;
  try {
    res = await api('GET', '/api/search?q=' + encodeURIComponent(q));
  } catch (err) {
    if (seq !== findSeq) return;
    sub.textContent = err.status ? err.message : "Can't reach your PC right now";
    return;
  }
  // A newer search started while this one was out.
  if (seq !== findSeq) return;

  db.lookups = db.lookups || {};
  const at = new Date().toISOString();
  for (const r of res.results) {
    db.lookups[r.code] = { name: r.name, image: r.image, aisles: r.aisles, source: 'kroger', at };
  }
  write(KEYS.db, db);

  const n = res.results.length;
  sub.textContent = !n
    ? 'No matches. Try fewer or different words'
    : res.term !== q
      ? `Nothing for all of that, so showing "${res.term}"`
      : `${n} result${n === 1 ? '' : 's'} at your store`;
  renderFind(res.results);
}

function renderFind(results) {
  const list = $('find-list');
  list.replaceChildren();
  for (const r of results) {
    const row = el('div', 'row');
    row.appendChild(thumb(r.code));
    // Full name on up to a few lines, spot underneath, so nothing gets cut off.
    const txt = el('div', 'txt');
    txt.appendChild(el('div', 'nm wrap', r.name));
    const pill = locPill(r.code);
    if (pill.classList.contains('new')) pill.textContent = 'No aisle';
    pill.addEventListener('click', () => openSheet(r.code));
    const meta = el('div', 'meta');
    meta.appendChild(pill);
    txt.appendChild(meta);
    const also = alsoLine(r.code);
    if (also) txt.appendChild(also);
    row.appendChild(txt);

    const add = el('button', 'add-btn', '+');
    add.type = 'button';
    add.setAttribute('aria-label', 'Add to cart');
    add.addEventListener('click', () => {
      addToCart(r.code);
      add.textContent = '✓';
      add.classList.add('added');
    });
    row.appendChild(add);

    const li = el('li');
    li.appendChild(row);
    list.appendChild(li);
  }
}

/* ---------- Rendering ---------- */

// Spots from Kroger get an outlined pill to tell them apart from user-tagged ones.
function locClass(loc) {
  if (!loc.zone) return 'loc note';
  return loc.from === 'kroger' ? 'loc k' : 'loc';
}

function locPill(code) {
  const loc = locationFor(code);
  if (loc) return el('span', locClass(loc), fmtLoc(loc));
  const oob = outOfBounds(code);
  if (oob) return el('span', 'loc oob', oob.where.replace(/^Kroger: /, ''));
  return el('span', 'loc new', 'Tag it');
}

function renderCart() {
  const list = $('cart-list');
  list.replaceChildren();
  const units = cart.lines.reduce((n, l) => n + l.qty, 0);
  const oob = (l) => !!outOfBounds(l.code);
  // Still being looked up doesn't count as "no spot" yet.
  const noSpot = (l) => !locationFor(l.code) && !oob(l) && !lookingUp.has(l.code);
  const unknown = cart.lines.filter(noSpot).length;
  const notMine = cart.lines.filter(oob);
  $('cart-sub').textContent = units
    ? `${units} item${units === 1 ? '' : 's'}${notMine.length ? `, ${notMine.length} not your problem` : ''}`
    : 'Scan your go-backs';
  $('cart-actions').hidden = !units;
  const banner = $('no-spot');
  banner.hidden = !unknown;
  banner.textContent = `${unknown} item${unknown === 1 ? ' has' : 's have'} no spot. Set ${unknown === 1 ? 'it' : 'them'} aside, or tap Tag it to add a spot or note`;

  if (!units) {
    list.appendChild(el('li', 'empty', 'Start the camera and scan everything in the cart. Order doesn\'t matter.'));
    return;
  }
  // No-spot items first (they need attention), then the rest, then a separate pile for other departments.
  const yours = cart.lines.filter((l) => !oob(l));
  const ordered = [...yours.filter(noSpot), ...yours.filter((l) => !noSpot(l)), ...notMine];
  for (const line of ordered) {
    if (line === notMine[0]) list.appendChild(el('li', 'pile-head', `Not your problem (${notMine.length})`));
    const li = el('li');
    const row = el('div', 'row' + (noSpot(line) ? ' nospot' : oob(line) ? ' oob' : ''));
    row.appendChild(thumb(line.code));
    const txt = el('div', 'txt');
    txt.appendChild(el('div', 'nm', itemName(line.code)));
    const also = alsoLine(line.code);
    if (also) txt.appendChild(also);
    const hint = !locationFor(line.code) && krogerHint(line.code);
    if (hint) txt.appendChild(el('div', 'also hint', `Kroger files it under ${hint}`));
    txt.appendChild(el('div', 'cd', line.code));
    row.appendChild(txt);
    if (line.qty > 1) row.appendChild(el('span', 'qty', '×' + line.qty));
    const pill = locPill(line.code);
    pill.style.cursor = 'pointer';
    pill.addEventListener('click', () => openSheet(line.code));
    row.appendChild(pill);
    const x = el('button', 'x', '×');
    x.setAttribute('aria-label', 'Remove from cart');
    x.addEventListener('click', () => removeLine(line.code));
    row.appendChild(x);
    li.appendChild(row);
    list.appendChild(li);
  }
}

function renderRoute() {
  const stops = buildStops();
  const left = stops.filter((s) => !s.done).length;
  const cur = currentStop(stops);

  $('segs').replaceChildren(...stops.map((s) => el('div', s.done ? 'on' : '')));

  if (!stops.length) {
    $('route-big').textContent = 'Nothing to put back';
    $('route-sub').textContent = 'Scan a cart first';
  } else if (!left) {
    $('route-big').textContent = 'All done';
    $('route-sub').textContent = "Cart's empty. Break time";
  } else {
    $('route-big').textContent = `${left} to go`;
    const units = cart.lines.reduce((n, l) => n + l.qty, 0);
    const skippedOut = cart.lines.filter((l) => outOfBounds(l.code)).length;
    $('route-sub').textContent = `${units} item${units === 1 ? '' : 's'} across ${stops.length} stop${stops.length === 1 ? '' : 's'}` +
      (skippedOut ? `, ${skippedOut} not your problem` : '');
  }

  const next = $('next');
  next.hidden = !stops.length;
  const nextItems = $('next-items');
  nextItems.replaceChildren();
  const nextLoc = $('next-loc');
  nextLoc.onclick = null;
  const photo = $('next-photo');
  photo.hidden = true;
  if (cur) {
    nextLoc.className = cur.item ? locClass(cur.item) : 'loc new';
    nextLoc.textContent = cur.item ? fmtLoc(cur.item) : 'Needs a spot';
    nextLoc.onclick = () => openSheet(cur.lines[0].code);
    const pic = thumb(cur.lines[0].code, true);
    if (!pic.classList.contains('none')) {
      photo.src = pic.src;
      photo.hidden = false;
    }
    for (const l of cur.lines) {
      const li = el('li', null, itemName(l.code) + (l.qty > 1 ? ` ×${l.qty}` : ''));
      li.appendChild(el('span', 'cd', l.code));
      const also = alsoLine(l.code);
      if (also) li.appendChild(also);
      const mine = db.items[l.code];
      if (mine && mine.note) li.appendChild(el('div', 'note-line', 'Goes: ' + mine.note));
      if (mine && mine.found) li.appendChild(el('div', 'note-line', 'Found it: ' + mine.found));
      nextItems.appendChild(li);
    }
    if (cur.item && cur.item.from === 'kroger') {
      nextItems.appendChild(el('li', 'src', "Spot from Kroger. Wrong? Tap it to fix"));
    }
    $('shelved').textContent = cur.item ? 'Shelved it' : 'Tag and shelve';
    $('skip').hidden = left < 2;
  } else if (stops.length) {
    nextLoc.className = 'loc';
    nextLoc.textContent = 'Done';
    nextItems.appendChild(el('li', null, 'Every item is home'));
    $('shelved').textContent = 'Start a new cart';
    $('skip').hidden = true;
  }

  const list = $('stops');
  list.replaceChildren();
  stops.forEach((s, i) => {
    const row = el('div', 'row' + (s.done ? ' done' : '') + (s === cur ? ' cur' : ''));
    row.appendChild(el('span', 'dot', s.done ? '✓' : String(i + 1)));
    const txt = el('div', 'txt');
    txt.appendChild(el('div', 'nm', s.lines.map((l) => itemName(l.code)).join(', ')));
    if (s.skipped && !s.done) txt.appendChild(el('div', 'cd', 'Skipped'));
    row.appendChild(txt);
    row.appendChild(s.item ? el('span', locClass(s.item), fmtLoc(s.item)) : el('span', 'loc new', 'No spot'));
    const li = el('li');
    li.appendChild(row);
    list.appendChild(li);
  });
}

const photoAsked = new Set();

function renderItems() {
  const q = $('search').value.trim().toLowerCase();
  const all = Object.values(db.items);
  $('items-sub').textContent = `${all.length} item${all.length === 1 ? '' : 's'} learned`;
  const shown = all
    .filter((it) => !q || [it.name, it.code, it.zone, it.note, it.found].some((f) => String(f || '').toLowerCase().includes(q)))
    .sort((a, b) => cmpKeys(sortKey(a), sortKey(b)) || (a.name || '').localeCompare(b.name || ''));

  const list = $('items-list');
  list.replaceChildren();
  if (!shown.length) {
    list.appendChild(el('li', 'empty', all.length ? 'No matches' : 'Items you tag show up here.'));
  }
  for (const it of shown) {
    // Photos only come from Kroger, so ask once per visit for tagged items we have none for.
    const looked = (db.lookups || {})[it.code];
    if (!(looked && looked.image) && !photoAsked.has(it.code)) {
      photoAsked.add(it.code);
      fetchName(it.code);
    }
    const row = el('button', 'row');
    row.type = 'button';
    const txt = el('div', 'txt');
    txt.append(el('div', 'nm', it.name || 'Unnamed item'), el('div', 'cd', it.code));
    const pill = it.notMine
      ? el('span', 'loc oob', 'Not mine')
      : el('span', locClass({ ...it, from: 'you' }), fmtLoc(it));
    row.append(thumb(it.code), txt, pill);
    row.addEventListener('click', () => openSheet(it.code));
    const li = el('li');
    li.appendChild(row);
    list.appendChild(li);
  }

  if (document.activeElement !== $('zones')) $('zones').value = db.settings.zones.join('\n');
  const h = db.settings.home || {};
  if (document.activeElement !== $('home-from')) $('home-from').value = h.from || '';
  if (document.activeElement !== $('home-to')) $('home-to').value = h.to || '';
}

function saveZones() {
  const zones = [...new Set($('zones').value.split('\n').map((z) => z.trim()).filter(Boolean))];
  const fromText = $('home-from').value.trim();
  const toText = $('home-to').value.trim();
  const from = parseInt(fromText, 10);
  const to = parseInt(toText, 10);
  // Both blank means no department range: nothing counts as out of bounds.
  const home = !fromText && !toText ? null : { from, to };
  if (home && !(from > 0 && to >= from)) {
    $('zones-error').textContent = 'Your aisles need a first and last number, like 20 to 60, or leave both blank.';
    return;
  }
  $('zones-error').textContent = '';
  queue({ type: 'settings', settings: { zones, home } });
  $('zones').blur();
  toast('Saved');
  render();
}

function render() {
  renderCart();
  renderRoute();
  renderItems();
}

function showView(name) {
  view = name;
  for (const v of ['scan', 'find', 'route', 'items']) $('view-' + v).hidden = v !== name;
  document.querySelectorAll('.nav button').forEach((b) => b.classList.toggle('on', b.dataset.view === name));
  if (name !== 'scan') stopCamera();
  render();
  window.scrollTo(0, 0);
}

/* ---------- Wiring ---------- */

document.querySelectorAll('.nav button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
$('cam-start').addEventListener('click', startCamera);
$('nope').addEventListener('click', hideNope);
$('keys-save').addEventListener('click', saveKeys);
$('keys-replace').addEventListener('click', () => {
  $('keys-form').hidden = false;
  $('keys-saved').hidden = true;
  $('k-id').focus();
});
$('k-find').addEventListener('click', findStores);
$('k-zip').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') findStores();
});
$('setup-nudge').addEventListener('click', () => {
  showView('items');
  $('kroger-setup').open = true;
  $('kroger-setup').scrollIntoView({ behavior: 'smooth' });
});
$('sheet-notmine').addEventListener('click', () => setNotMine(!sheet.notMine));
$('snap-input').addEventListener('change', scanPhoto);
$('manual').addEventListener('submit', addTyped);
$('go-route').addEventListener('click', () => showView('route'));
$('clear-cart').addEventListener('click', () => {
  if (confirm('Clear the whole cart?')) clearCart();
});
$('shelved').addEventListener('click', onShelved);
$('skip').addEventListener('click', onSkip);
$('search').addEventListener('input', renderItems);
$('find-q').addEventListener('input', () => {
  clearTimeout(findTimer);
  findTimer = setTimeout(runFind, 450);
});
$('find-form').addEventListener('submit', (e) => {
  e.preventDefault();
  clearTimeout(findTimer);
  $('find-q').blur();
  runFind();
});
$('save-zones').addEventListener('click', saveZones);
$('sheet-save').addEventListener('click', saveSheet);
$('sheet-note').addEventListener('input', updateSaveLabel);
$('sheet-cancel').addEventListener('click', closeSheet);
$('sheet-delete').addEventListener('click', deleteFromSheet);
$('scrim').addEventListener('click', (e) => {
  if (e.target === $('scrim')) closeSheet();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopCamera();
  else flush();
});
window.addEventListener('online', flush);

render();
load();
