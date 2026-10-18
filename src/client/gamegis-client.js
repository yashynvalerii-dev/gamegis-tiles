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
/** Activity reports are accepted this far outside a requested area so the area can follow the players. */
export const ACTIVITY_REACH_KM = 8;
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

/** All tiles at zoom z intersecting a {south, west, north, east} box (e.g. a Geohash cell). */
export function tilesForBbox({south, west, north, east}, z) {
  if (![south, west, north, east].every(Number.isFinite) || south >= north || west >= east) throw new RangeError('bbox must be {south<north, west<east}');
  if ((north - south) > 0.5 || (east - west) > 0.8) throw new RangeError('bbox too large (max ~50 km)');
  const nw = tileFor(north, west, z), se = tileFor(south, east, z);
  const out = [];
  for (let x = nw.x; x <= se.x; x++) for (let y = nw.y; y <= se.y; y++) out.push({z, x, y});
  return out;
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
 * Converts tile feature groups to classic OSM JSON elements (Map API style): nodes with lat/lon and
 * ways that reference node ids — for applications whose algorithms already consume that format.
 * - Real OSM ids are kept for nodes and ways; relation parts and generated vertices get negative ids.
 * - Polygon: the outer ring becomes a closed way; holes are emitted only with holes: 'separate'
 *   (as ways tagged {"gamegis:hole_of": "<sourceType>/<sourceId>"}), otherwise dropped (conservative).
 * - MultiPolygon / MultiLineString: one way per part with the same tags.
 * - bbox {south, west, north, east}: keep only features whose bounds intersect it.
 * Each OSM element appears once even if it belongs to several groups.
 */
export function toOsmElements(data, {bbox = null, holes = 'drop'} = {}) {
  let nextId = -1;
  const elements = [];
  const emitted = new Set();
  const nodeFor = ([lon, lat]) => { const id = nextId--; elements.push({type: 'node', id, lat, lon}); return id; };
  const wayFrom = (id, coords, tags) => {
    const closed = coords.length > 3 && coords[0][0] === coords.at(-1)[0] && coords[0][1] === coords.at(-1)[1];
    const refs = (closed ? coords.slice(0, -1) : coords).map(nodeFor);
    if (closed) refs.push(refs[0]); // closed ring references its first node again, as in OSM
    elements.push({type: 'way', id, nodes: refs, tags: {...tags}});
  };
  const bounds = g => {
    const pts = g.type === 'Point' ? [g.coordinates] : g.type === 'LineString' ? g.coordinates
      : g.type === 'MultiPolygon' ? g.coordinates.flat(2) : g.coordinates.flat();
    let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity;
    for (const [lon, lat] of pts) { if (lon < w) w = lon; if (lon > e) e = lon; if (lat < s) s = lat; if (lat > n) n = lat; }
    return {west: w, east: e, south: s, north: n};
  };
  for (const g of GROUP_NAMES) for (const f of data?.[g] ?? []) {
    const {sourceType, sourceId, tags} = f.properties;
    const key = `${sourceType}/${sourceId}`;
    if (emitted.has(key)) continue;
    const geom = f.geometry;
    if (bbox) {
      const b = bounds(geom);
      if (b.west > bbox.east || b.east < bbox.west || b.south > bbox.north || b.north < bbox.south) continue;
    }
    emitted.add(key);
    if (geom.type === 'Point') {
      elements.push({type: 'node', id: sourceType === 'node' ? sourceId : nextId--, lat: geom.coordinates[1], lon: geom.coordinates[0], tags: {...tags}});
    } else if (geom.type === 'LineString') {
      wayFrom(sourceType === 'way' ? sourceId : nextId--, geom.coordinates, tags);
    } else if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
      const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
      polys.forEach((rings, i) => {
        wayFrom(sourceType === 'way' && polys.length === 1 ? sourceId : nextId--, rings[0], tags);
        if (holes === 'separate') for (const hole of rings.slice(1)) wayFrom(nextId--, hole, {'gamegis:hole_of': key});
      });
    } else if (geom.type === 'MultiLineString') {
      for (const line of geom.coordinates) wayFrom(nextId--, line, tags);
    }
  }
  return elements;
}

/**
 * options:
 *   mirrors: base URLs in priority order (required, at least one)
 *   fetchImpl: custom fetch (tests); timeoutMs: per request (default 15000)
 *   cacheName: Cache Storage name for offline reuse (default 'gamegis-tiles'; null disables)
 */
/**
 * Request endpoint contract v1 (any implementation: today a Google Apps Script web app, later our own server):
 *   POST <url>, body text/plain JSON {v: 1, kind: "request"|"activity", lat, lon, app} (coordinates already coarse)
 *   -> JSON {ok: true, status: "ACCEPTED"|"DUPLICATE"} or {ok: false, status: "INVALID"|"RATE_LIMITED"|"FULL"}.
 * Only endpoints with these prefixes are trusted from a manifest (a tampered mirror cannot redirect players' data);
 * a game can add its own server through createTileClient({requestEndpoints}).
 */
export const TRUSTED_REQUEST_ENDPOINTS = ['https://script.google.com/macros/s/'];

export function createTileClient({mirrors, fetchImpl = globalThis.fetch, timeoutMs = 15000, cacheName = 'gamegis-tiles',
  requestEndpoints = []} = {}) {
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

  /**
   * One bundle by key "z/x/y", or null when the area has not been prepared. precision 6/7 uses the precise layer
   * when that bundle exists there, otherwise the base layer (5 decimals); bundle.precision tells which one came.
   */
  async function getBundle(key, precision = 5) {
    const m = await getManifest();
    const layer = precision > 5 ? m.precise?.[precision] : null;
    const usePrecise = Boolean(layer?.bundles?.[key]);
    const memKey = usePrecise ? `p${precision}:${key}` : key;
    if (memory.has(memKey)) return memory.get(memKey);
    const entry = usePrecise ? layer.bundles[key] : m.bundles[key];
    if (!entry) return null;
    const [z, x, y] = key.split('/');
    const path = (usePrecise ? layer.bundlePath : m.bundlePath).replace('{z}', z).replace('{x}', x).replace('{y}', y);
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
    bundle.precision = usePrecise ? precision : 5;
    memory.set(memKey, bundle);
    return bundle;
  }

  /**
   * Features for a circle ({lat, lon, radiusM}) or a box ({bbox: {south, west, north, east}}). status: READY (every z15 tile READY), PARTIAL (some READY) or UNAVAILABLE.
   * tiles: { "15/x/y": {status, reason?} } — MISSING means the area has not been prepared yet.
   * data: feature groups merged from READY tiles' bundles (features may extend beyond the circle).
   * precision: 5 (default) | 6 | 7 decimal places wanted; the answer's `precision` is what was actually delivered
   * (the lowest over the bundles used): a precise layer exists only where a game asked for it (requestRegion).
   */
  async function getArea({lat, lon, radiusM, bbox, precision = 5} = {}) {
    const m = await getManifest();
    const tz = m.tileZoom, bz = m.bundleZoom, shift = tz - bz;
    const tiles = bbox ? tilesForBbox(bbox, tz) : tilesForCircle({lat, lon, radiusM}, tz);
    const keys = [...new Set(tiles.map(t => `${bz}/${t.x >> shift}/${t.y >> shift}`))];
    const bundles = new Map();
    for (const k of keys) bundles.set(k, await getBundle(k, precision)); // sequential: gentle on free hosting
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
    const delivered = [...bundles.values()].filter(Boolean).map(b => b.precision ?? 5);
    return {status: ready === values.length ? 'READY' : ready ? 'PARTIAL' : 'UNAVAILABLE',
      readyTiles: ready, totalTiles: values.length, tiles: status, data,
      precision: delivered.length ? Math.min(...delivered) : 5,
      dataTimestamp: m.dataTimestamp, attribution: ATTRIBUTION};
  }

  const requested = new Set();
  const trusted = [...TRUSTED_REQUEST_ENDPOINTS, ...requestEndpoints];
  const sendSignal = async (m, lat, lon, app, kind, precision) => {
    const cLat = Math.round(lat * 20) / 20, cLon = Math.round(lon * 20) / 20;
    // text/plain keeps it a "simple" request (no CORS preflight); the answer is readable JSON.
    const res = await timedFetch(m.regionRequests.url, {method: 'POST', redirect: 'follow',
      headers: {'content-type': 'text/plain;charset=utf-8'},
      body: JSON.stringify({v: 1, kind, lat: Number(cLat.toFixed(2)), lon: Number(cLon.toFixed(2)), app, ...(precision > 5 ? {precision} : {})})});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const answer = await res.json();
    return {lat: cLat, lon: cLon, ok: answer?.ok === true, status: String(answer?.status ?? 'UNKNOWN')};
  };
  const endpointReady = m => m.regionRequests?.type === 'endpoint' && typeof m.regionRequests.url === 'string' &&
    trusted.some(prefix => m.regionRequests.url.startsWith(prefix));
  const checkApp = app => { if (typeof app !== 'string' || !/^[a-z][a-z0-9-]{1,40}$/.test(app)) throw new TypeError('app must be a short id like "my-game"'); };

  /**
   * Asks for map data around the player when it is missing (not prepared yet, or the player is near the
   * edge of a prepared area). Sends only COARSE coordinates (~5 km) and the app id to the request endpoint
   * published in the manifest; nothing personal. Requests near an existing requested area raise its rating
   * (it grows); far ones create a new small area. Returns {sent: true, lat, lon} or {sent: false, reason:
   * ALREADY_AVAILABLE | ALREADY_REQUESTED | REQUESTS_NOT_CONFIGURED | NETWORK_ERROR | RATE_LIMITED | FULL | INVALID}.
   * precision: 5 (default, ~1 m) | 6 (~10 cm) | 7 (~1 cm) decimal places the game needs in this sector — a
   * provisional rule (2026-10-17), to be confirmed by practice. What the game shows meanwhile is the game's decision.
   */
  async function requestRegion({lat, lon, app, radiusM = 1000, precision = 5}) {
    checkApp(app);
    if (![5, 6, 7].includes(precision)) throw new TypeError('precision must be 5, 6 or 7 decimal places');
    const m = await getManifest();
    const area = await getArea({lat, lon, radiusM, precision});
    // precise layers (6/7 decimals) are built only on request: a READY base area answers only precision 5
    if (area.status === 'READY' && area.precision >= precision) return {sent: false, reason: 'ALREADY_AVAILABLE'};
    if (!endpointReady(m)) return {sent: false, reason: 'REQUESTS_NOT_CONFIGURED'};
    const key = `${Math.round(lat * 20) / 20}/${Math.round(lon * 20) / 20}/${precision}`;
    if (requested.has(key)) return {sent: false, reason: 'ALREADY_REQUESTED'};
    let c;
    try { c = await sendSignal(m, lat, lon, app, 'request', precision); } catch { return {sent: false, reason: 'NETWORK_ERROR'}; }
    if (!c.ok) return {sent: false, reason: c.status};
    requested.add(key);
    log.push({event: 'region-request', lat: c.lat, lon: c.lon, status: c.status, app});
    return {sent: true, lat: c.lat, lon: c.lon, status: c.status};
  }

  /**
   * "People play here": confirms an area prepared on request and lets it follow the players. Play inside the
   * area only confirms it; play near its edge (up to ACTIVITY_REACH_KM outside) on several days makes it grow
   * that way. Sends at most one signal
   * per area per 24 h (remembered in localStorage when available), only inside areas that were built on
   * request (manifest regions with kind "requested") or near them. Call it when a game session starts.
   * Returns {sent: true} or {sent: false, reason: NOT_IN_REQUESTED_AREA | ALREADY_TODAY | REQUESTS_NOT_CONFIGURED | NETWORK_ERROR}.
   */
  async function reportActivity({lat, lon, app, nowMs = Date.now()}) {
    checkApp(app);
    const m = await getManifest();
    const region = (m.regions ?? []).find(r => r.kind === 'requested' && r.circle &&
      Math.hypot((lat - r.circle.lat) * 111.32, (lon - r.circle.lon) * 111.32 * Math.cos(lat * Math.PI / 180)) <= r.circle.radiusKm + ACTIVITY_REACH_KM);
    if (!region) return {sent: false, reason: 'NOT_IN_REQUESTED_AREA'};
    if (!endpointReady(m)) return {sent: false, reason: 'REQUESTS_NOT_CONFIGURED'};
    // one signal per day per coarse spot (~5 km): play at home and at the edge on one day are both heard
    const key = `gamegis-activity:${region.id}:${Math.round(lat * 20) / 20}/${Math.round(lon * 20) / 20}`;
    let last = activity.get(key);
    try { last ??= Number(globalThis.localStorage?.getItem(key)) || undefined; } catch {}
    if (last && nowMs - last < 86400000) return {sent: false, reason: 'ALREADY_TODAY'};
    let c;
    try { c = await sendSignal(m, lat, lon, app, 'activity'); } catch { return {sent: false, reason: 'NETWORK_ERROR'}; }
    if (!c.ok) return {sent: false, reason: c.status};
    activity.set(key, nowMs);
    try { globalThis.localStorage?.setItem(key, String(nowMs)); } catch {}
    log.push({event: 'activity', region: region.id, app});
    return {sent: true, region: region.id};
  }
  const activity = new Map();

  return {getManifest, getBundle, getArea, requestRegion, reportActivity, log};
}
