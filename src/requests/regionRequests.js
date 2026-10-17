/**
 * Region requests: turns rows submitted by game clients (via a web form, stored as CSV) into new
 * published regions. Pure logic, no network. Rules:
 * - only well-formed rows from known apps are accepted; coordinates are already coarse (rounded by the client);
 * - a request inside an already published region is ignored;
 * - nearby requests collapse into one region (circle radiusKm around the first request);
 * - the source extract is the SMALLEST Geofabrik extract that contains the whole circle (fewer bytes, faster);
 * - caps: maxNewPerRun per processing run and maxTotalRegions overall (free hosting is limited).
 */
const EARTH_KM = 6371;
const toRad = d => d * Math.PI / 180;
export function distanceKm(a, b) {
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Minimal CSV parser (quoted fields, commas, newlines inside quotes). */
export function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ''));
}

/**
 * Rows → requests. columns: header names for {lat, lon, app}; first CSV row is the header.
 * Returns {requests: [{lat, lon, app, at}], rejected}.
 */
export function readRequests(csvText, {columns = {lat: 'lat', lon: 'lon', app: 'app'}, apps = []} = {}) {
  const rows = parseCsv(csvText);
  if (!rows.length) return {requests: [], rejected: 0};
  const head = rows[0].map(h => h.trim().toLowerCase());
  const idx = k => head.indexOf(String(columns[k]).toLowerCase());
  const [iLat, iLon, iApp, iAt] = [idx('lat'), idx('lon'), idx('app'), head.findIndex(h => /timestamp|zeitstempel|отметка/.test(h))];
  if (iLat < 0 || iLon < 0 || iApp < 0) throw new Error(`REQUESTS_CSV_COLUMNS_MISSING (have: ${head.join(', ')})`);
  const requests = []; let rejected = 0;
  for (const r of rows.slice(1)) {
    const lat = Number(String(r[iLat]).replace(',', '.')), lon = Number(String(r[iLon]).replace(',', '.'));
    const app = String(r[iApp] ?? '').trim().toLowerCase();
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 80 || Math.abs(lon) > 180 ||
        (apps.length && !apps.includes(app))) { rejected++; continue; }
    // Never trust client precision: keep requests coarse (~5 km) regardless of what was submitted.
    requests.push({lat: Math.round(lat * 20) / 20, lon: Math.round(lon * 20) / 20, app, at: iAt >= 0 ? String(r[iAt]).trim() : ''});
  }
  return {requests, rejected};
}

function ringContains(ring, lon, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < xi + (lat - yi) * (xj - xi) / (yj - yi)) inside = !inside;
  }
  return inside;
}
/** GeoJSON Polygon / MultiPolygon point test (holes respected). */
export function geometryContains(geometry, lon, lat) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polys.some(rings => ringContains(rings[0], lon, lat) && !rings.slice(1).some(h => ringContains(h, lon, lat)));
}
const circlePoints = ({lat, lon, radiusKm}, n = 16) => Array.from({length: n}, (_, i) => {
  const a = i / n * 2 * Math.PI;
  return {lat: lat + radiusKm / 111.32 * Math.cos(a), lon: lon + radiusKm / (111.32 * Math.cos(toRad(lat))) * Math.sin(a)};
});
function bboxArea(geometry) {
  const pts = (geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates).flatMap(p => p[0]);
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
}

/**
 * Smallest Geofabrik extract (index-v1.json feature collection) containing the whole circle.
 * Returns the extract path such as "europe/ukraine" or null.
 */
export function chooseExtract(index, circle) {
  const pts = [{lat: circle.lat, lon: circle.lon}, ...circlePoints(circle)];
  let best = null;
  for (const f of index.features ?? []) {
    const pbf = f.properties?.urls?.pbf;
    if (!pbf || !f.geometry) continue;
    const m = pbf.match(/^https:\/\/download\.geofabrik\.de\/(.+)-latest\.osm\.pbf$/);
    if (!m) continue;
    if (!pts.every(p => geometryContains(f.geometry, p.lon, p.lat))) continue;
    const area = bboxArea(f.geometry);
    if (!best || area < best.area) best = {extract: m[1], area, name: f.properties.name};
  }
  return best && {extract: best.extract, name: best.name};
}

/** Covered = already published on the site (isPublished) or inside a circle region planned/built earlier. */
function covered(point, regions, isPublished) {
  return Boolean(isPublished?.(point)) ||
    regions.some(r => r.publish?.circle && distanceKm(point, r.publish.circle) <= r.publish.circle.radiusKm);
}

export const regionId = ({lat, lon}) => `req-${lat.toFixed(2)}_${lon.toFixed(2)}`.replace(/-(?=\d)/g, 'm').replace('reqm', 'req-').replaceAll('.', 'p');

/**
 * Plans new regions. existing: all current regions (configured + previously requested).
 * Returns {added: [region], skipped: [{request, reason}]}.
 */
export function planRegions(requests, existing, index, {radiusKm = 15, maxNewPerRun = 2, maxTotalRegions = 15,
  isPublished = null, now = new Date()} = {}) {
  const added = [], skipped = [];
  const all = [...existing];
  for (const req of requests) {
    if (covered(req, all, isPublished)) { skipped.push({request: req, reason: 'ALREADY_COVERED'}); continue; }
    if (added.length >= maxNewPerRun) { skipped.push({request: req, reason: 'RUN_LIMIT'}); continue; }
    if (all.length >= maxTotalRegions) { skipped.push({request: req, reason: 'TOTAL_LIMIT'}); continue; }
    const circle = {lat: req.lat, lon: req.lon, radiusKm};
    const ex = chooseExtract(index, circle);
    if (!ex) { skipped.push({request: req, reason: 'NO_EXTRACT'}); continue; }
    // Public record: area only. No request time and no app id (they would reveal when/where someone played).
    const region = {id: regionId(req), name: `${ex.name} ${req.lat.toFixed(2)},${req.lon.toFixed(2)}`, extract: ex.extract,
      publish: {circle}, addedOn: now.toISOString().slice(0, 10)};
    added.push(region); all.push(region);
  }
  return {added, skipped};
}
