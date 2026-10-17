/**
 * GameGIS tile client — a small, dependency-free browser/Node module for reading GameGIS static tiles.
 *
 * What it does (delivery only, no game logic):
 *  - reads manifest.json from the first working mirror;
 *  - finds the z13 bundles covering an area, downloads each from the mirrors in priority order
 *    (falls over to the next mirror on network error, HTTP error or checksum mismatch);
 *  - verifies the SHA-256 from the manifest, decompresses gzip, and returns GeoJSON feature groups
 *    together with the status of every z15 tile (READY / INCOMPLETE / MISSING).
 * What the game decides: what to do with INCOMPLETE/MISSING tiles, placement rules, distances, etc.
 *
 * Requirements: fetch, crypto.subtle, DecompressionStream (all modern browsers, Node >= 18).
 *
 *   import {createTileClient} from './gamegis-client.js';
 *   const tiles = createTileClient({mirrors: ['https://<owner>.github.io/gamegis-tiles/']});
 *   const area = await tiles.getArea({lat: 51.0102, lon: 11.0036, radiusM: 500});
 *   if (area.status === 'READY') use(area.data.walkableWays, area.data.buildings, ...);
 *
 * Map data © OpenStreetMap contributors (ODbL). Applications must show this attribution.
 */
export const CLIENT_VERSION = '1.0.0';
export const SUPPORTED_MANIFESTS = ['GAMEGIS_TILE_MANIFEST_V2'];
export const ATTRIBUTION = '© OpenStreetMap contributors (ODbL)';
const GROUP_NAMES = ['walkableWays', 'buildings', 'entrances', 'water', 'railways', 'power', 'restrictedAreas', 'restrictedWays'];

/** Web Mercator tile of a position. */
export function tileFor(lat, lon, z) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new TypeError('lat/lon must be numbers');
  const n = 2 ** z;
  const la = Math.max(-85.0511287798066, Math.min(85.0511287798066, lat)) * Math.PI / 180;
  const x = Math.floor((lon + 180) / 360 * n);
  const y = Math.floor((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * n);
  return {z, x: Math.min(n - 1, Math.max(0, x)), y: Math.min(n - 1, Math.max(0, y))};
}

/** All tiles at zoom z whose square intersects the circle's bounding box (a safe superset). */
export function tilesForCircle({lat, lon, radiusM}, z) {
  if (!(radiusM > 0) || radiusM > 20000) throw new RangeError('radiusM must be 1..20000');
  const dLat = radiusM / 111320, dLon = radiusM / (111320 * Math.max(0.01, Math.cos(lat * Math.PI / 180)));
  const nw = tileFor(lat + dLat, lon - dLon, z), se = tileFor(lat - dLat, lon + dLon, z);
  const out = [];
  for (let x = nw.x; x <= se.x; x++) for (let y = nw.y; y <= se.y; y++) out.push({z, x, y});
  return out;
}

async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}
const joinUrl = (base, path) => base.replace(/\/?$/, '/') + path.replace(/^\//, '');

/**
 * options:
 *   mirrors: base URLs in priority order (required, at least one)
 *   fetchImpl: custom fetch (tests); timeoutMs: per request (default 15000)
 *   cacheName: Cache Storage name for offline reuse (default 'gamegis-tiles'; null disables)
 */
export function createTileClient({mirrors, fetchImpl = globalThis.fetch, timeoutMs = 15000, cacheName = 'gamegis-tiles'} = {}) {
  if (!Array.isArray(mirrors) || !mirrors.length) throw new TypeError('mirrors: at least one base URL is required');
  let manifestPromise = null;
  const memory = new Map(); // bundle key -> parsed bundle (per session)
  const log = [];           // recent delivery events, useful for game diagnostics

  async function timedFetch(url, init = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try { return await fetchImpl(url, {...init, signal: ctrl.signal}); } finally { clearTimeout(t); }
  }
  async function openCache() {
    if (!cacheName || typeof caches === 'undefined') return null;
    try { return await caches.open(cacheName); } catch { return null; }
  }

  /** Manifest from the first mirror that answers with a supported manifest. */
  function getManifest({refresh = false} = {}) {
    if (!manifestPromise || refresh) manifestPromise = (async () => {
      const errors = [];
      for (const base of mirrors) {
        try {
          const res = await timedFetch(joinUrl(base, 'manifest.json'), {cache: 'no-cache'});
          if (!res.ok) { errors.push(`${base}: HTTP ${res.status}`); continue; }
          const m = await res.json();
          if (!SUPPORTED_MANIFESTS.includes(m.format)) { errors.push(`${base}: unsupported ${m.format}`); continue; }
          log.push({event: 'manifest', mirror: base, dataTimestamp: m.dataTimestamp});
          return m;
        } catch (e) { errors.push(`${base}: ${e.name === 'AbortError' ? 'timeout' : e.message}`); }
      }
      manifestPromise = null;
      throw new Error('MANIFEST_UNAVAILABLE: ' + errors.join('; '));
    })();
    return manifestPromise;
  }

  /** One bundle by key "z/x/y", or null when the area has not been prepared. */
  async function getBundle(key) {
    if (memory.has(key)) return memory.get(key);
    const m = await getManifest();
    const entry = m.bundles[key];
    if (!entry) return null;
    const [z, x, y] = key.split('/');
    const path = m.bundlePath.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    const cache = await openCache();
    const cacheKey = `https://gamegis.cache/${entry.sha256}`;
    let bytes = null;
    if (cache) {
      try { const hit = await cache.match(cacheKey); if (hit) bytes = new Uint8Array(await hit.arrayBuffer()); } catch {}
    }
    if (bytes && (await sha256Hex(bytes)) !== entry.sha256) bytes = null;
    const errors = [];
    if (!bytes) for (const base of mirrors) {
      try {
        const res = await timedFetch(joinUrl(base, path));
        if (!res.ok) { errors.push(`${base}: HTTP ${res.status}`); continue; }
        const got = new Uint8Array(await res.arrayBuffer());
        if ((await sha256Hex(got)) !== entry.sha256) { errors.push(`${base}: checksum mismatch`); continue; }
        bytes = got;
        log.push({event: 'bundle', key, mirror: base, bytes: got.length});
        if (cache) { try { await cache.put(cacheKey, new Response(got)); } catch {} }
        break;
      } catch (e) { errors.push(`${base}: ${e.name === 'AbortError' ? 'timeout' : e.message}`); }
    }
    if (!bytes) throw new Error(`BUNDLE_UNAVAILABLE ${key}: ${errors.join('; ')}`);
    const bundle = JSON.parse(m.bundleEncoding === 'gzip' ? await gunzip(bytes) : new TextDecoder().decode(bytes));
    memory.set(key, bundle);
    return bundle;
  }

  /**
   * Features for a circle. status: READY (every z15 tile READY), PARTIAL (some READY) or UNAVAILABLE.
   * tiles: { "15/x/y": {status, reason?} } — MISSING means the area has not been prepared yet.
   * data: feature groups merged from READY tiles' bundles (features may extend beyond the circle).
   */
  async function getArea({lat, lon, radiusM}) {
    const m = await getManifest();
    const tz = m.tileZoom, bz = m.bundleZoom, shift = tz - bz;
    const tiles = tilesForCircle({lat, lon, radiusM}, tz);
    const keys = [...new Set(tiles.map(t => `${bz}/${t.x >> shift}/${t.y >> shift}`))];
    const bundles = new Map();
    for (const k of keys) bundles.set(k, await getBundle(k)); // sequential: gentle on free hosting
    const status = {};
    for (const t of tiles) {
      const id = `${tz}/${t.x}/${t.y}`;
      const b = bundles.get(`${bz}/${t.x >> shift}/${t.y >> shift}`);
      status[id] = b?.tiles?.[id] ?? {status: 'MISSING'};
    }
    const data = Object.fromEntries(GROUP_NAMES.map(g => [g, []]));
    const seen = new Set();
    for (const b of bundles.values()) {
      if (!b) continue;
      for (const g of GROUP_NAMES) for (const f of b.data?.[g] ?? []) {
        const id = `${g}/${f.properties.sourceType}/${f.properties.sourceId}`;
        if (!seen.has(id)) { seen.add(id); data[g].push(f); }
      }
    }
    const values = Object.values(status);
    const ready = values.filter(s => s.status === 'READY').length;
    return {status: ready === values.length ? 'READY' : ready ? 'PARTIAL' : 'UNAVAILABLE',
      readyTiles: ready, totalTiles: values.length, tiles: status, data,
      dataTimestamp: m.dataTimestamp, attribution: ATTRIBUTION};
  }

  return {getManifest, getBundle, getArea, log};
}
