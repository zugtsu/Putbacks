// Kroger Products API: real product names and aisle spots for one store.
// API keys and the chosen store live in data/kroger.json (set from the setup screen; not committed).
const fs = require('fs');
const path = require('path');

const API = 'https://api.kroger.com/v1';
const CONFIG_FILE = process.env.KROGER_CONFIG
  || path.join(process.env.PUTBACK_DATA || path.join(__dirname, 'data'), 'kroger.json');
// Kroger's terms forbid building a database out of their data, so answers only live in memory for a while.
const CACHE_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 8000;

let token = null;
const cache = new Map();
let store = null;

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(patch) {
  const next = { ...readConfig(), ...patch };
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  // Owner-only where the OS supports it; the file holds the client secret.
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  // New keys or a new store make every cached answer stale.
  token = null;
  store = null;
  cache.clear();
  return next;
}

// Usable only once both keys and a store are set.
function loadConfig() {
  const c = readConfig();
  return c.client_id && c.client_secret && /^\d{8}$/.test(String(c.location_id || '')) ? c : null;
}

function keysOnly() {
  const c = readConfig();
  return c.client_id && c.client_secret ? c : null;
}

// Kroger product IDs are the barcode without its check digit, padded to 13 digits.
function toProductId(code) {
  if (/^\d{12}$/.test(code)) return code.slice(0, 11).padStart(13, '0');
  if (/^\d{13}$/.test(code)) return code.slice(0, 12).padStart(13, '0');
  return null;
}

// The other way: Kroger product ID back to the barcode a scanner reads (UPC-A, or EAN-13 for imports).
function fromProductId(productId) {
  const payload = productId.startsWith('00') ? productId.slice(-11) : productId.slice(-12);
  let sum = 0;
  for (let i = 0; i < payload.length; i++) {
    sum += Number(payload[payload.length - 1 - i]) * (i % 2 === 0 ? 3 : 1);
  }
  return payload + ((10 - (sum % 10)) % 10);
}

function pickImage(images) {
  const front = (images || []).find((i) => i.featured) || (images || [])[0];
  const sizes = (front && front.sizes) || [];
  // "thumbnail" is 50px and blurry on a phone screen, so prefer medium.
  const s = ['medium', 'small', 'thumbnail'].map((n) => sizes.find((x) => x.size === n)).find(Boolean) || sizes[0];
  return (s && s.url) || '';
}

// "AISLE 57" -> 57, "GM Aisle 110" -> 110, "SSNL AISLE 01" -> Seasonal 1. "DRUG/GM" has no aisle.
function parseAisle(a) {
  const label = String(a.description || '').trim();
  const m = label.match(/aisle\s*0*(\d+)/i);
  let zone = null;
  if (m) zone = /^ssnl/i.test(label) ? `Seasonal ${m[1]}` : m[1];
  const bay = parseInt(a.bayNumber, 10);
  return {
    zone,
    side: a.side === 'L' || a.side === 'R' ? a.side : '',
    bay: bay > 0 && bay < 100 ? bay : null,
    shelf: a.shelfNumber ? String(a.shelfNumber) : '',
    label,
  };
}

async function getToken(c) {
  if (token && token.exp > Date.now() + 60_000) return token.value;
  const auth = Buffer.from(`${c.client_id}:${c.client_secret}`).toString('base64');
  const res = await fetch(`${API}/connect/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=product.compact',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`Kroger sign-in failed (${res.status})`);
  token = { value: data.access_token, exp: Date.now() + (data.expires_in || 1800) * 1000 };
  return token.value;
}

async function get(c, url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(API + url, {
      headers: { Authorization: 'Bearer ' + (await getToken(c)), Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401 && attempt === 0) {
      token = null;
      continue;
    }
    if (!res.ok) throw new Error(`Kroger request failed (${res.status})`);
    return res.json();
  }
}

// Returns { name, aisles } for a barcode at the configured store, or null when Kroger doesn't carry it.
async function lookup(code) {
  const c = loadConfig();
  const productId = toProductId(code);
  if (!c || !productId) return null;

  const hit = cache.get(code);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const data = await get(c, `/products?filter.productId=${productId}&filter.locationId=${c.location_id}`);
  const p = data.data && data.data[0];
  const value = p ? toItem(p) : null;
  cache.set(code, { at: Date.now(), value });
  return value;
}

function toItem(p) {
  const seen = new Set();
  const aisles = (p.aisleLocations || [])
    .map(parseAisle)
    .filter((a) => {
      const key = [a.zone, a.side, a.bay].join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (a.zone ? 0 : 1) - (b.zone ? 0 : 1));
  return { name: p.description || '', image: pickImage(p.images), aisles };
}

// Word search at the configured store, e.g. "throw pillow". Results are also remembered for lookup().
async function search(term, limit = 20) {
  const c = loadConfig();
  if (!c) return null;
  const q = encodeURIComponent(term);
  const data = await get(c, `/products?filter.term=${q}&filter.locationId=${c.location_id}&filter.limit=${limit}`);
  return (data.data || []).map((p) => {
    const item = toItem(p);
    const code = fromProductId(p.productId || p.upc || '');
    cache.set(code, { at: Date.now(), value: item });
    return { code, ...item };
  });
}

function toStore(l) {
  const a = l.address || {};
  return {
    id: l.locationId,
    chain: l.chain || '',
    name: l.name || '',
    address: [a.addressLine1, a.city, a.state].filter(Boolean).join(', '),
  };
}

// What the setup screen shows. Never includes the keys themselves.
async function storeInfo() {
  const c = loadConfig();
  if (!c) return { configured: false, hasKeys: !!keysOnly() };
  if (!store || store.id !== c.location_id) store = toStore((await get(c, `/locations/${c.location_id}`)).data || {});
  return { configured: true, hasKeys: true, ...store };
}

// Try the keys against Kroger before saving them, so a typo fails right away.
async function setKeys(clientId, clientSecret) {
  token = null;
  await getToken({ client_id: clientId, client_secret: clientSecret });
  saveConfig({ client_id: clientId, client_secret: clientSecret });
}

async function findStores(zip) {
  const c = keysOnly();
  if (!c) return null;
  const data = await get(c, `/locations?filter.zipCode.near=${encodeURIComponent(zip)}&filter.limit=15`);
  return (data.data || []).map(toStore);
}

async function setStore(locationId) {
  const c = keysOnly();
  if (!c) return null;
  const s = toStore((await get(c, `/locations/${locationId}`)).data || {});
  if (!s.id) return null;
  saveConfig({ location_id: s.id });
  store = s;
  return s;
}

module.exports = { lookup, search, storeInfo, setKeys, findStores, setStore, toProductId, fromProductId, parseAisle };
