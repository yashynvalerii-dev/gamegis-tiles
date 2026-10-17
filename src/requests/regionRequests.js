/**
 * Region requests: turns rows submitted by game clients (via a web form, stored as CSV) into published
 * regions. Pure logic, no network. Two modes: planRegions (fixed circles) and planDemand (rating system,
 * used in production — see below). Rules:
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

// ---------------------------------------------------------------------------------------------
// Rating system (planDemand). A requested region starts small and grows with demand; storage is spent
// where people actually play.
//  - rating = number of DISTINCT UTC days with requests/activity signals near the region in the last
//    windowDays (several taps on one evening count once);
//  - radius by rating: LEVELS (1 day -> 3 km ... 8+ days -> 20 km);
//  - a signal counts for a region when it lies within radius + edgeKm (players at the edge make it grow);
//  - signals far from every region create a new 3 km region (within maxNewPerRun / maxTotalRegions);
//  - storage budget: when the site would exceed budgetMB, requested regions with the lowest priority
//    (rating decayed by inactivity) are evicted; regions inactive for expireDays are evicted anyway;
//  - pinned regions (regions.json) are never changed or evicted.

export const LEVELS = Object.freeze([{minDays: 1, radiusKm: 3}, {minDays: 2, radiusKm: 7}, {minDays: 4, radiusKm: 12}, {minDays: 8, radiusKm: 20}]);
export const radiusForRating = r => [...LEVELS].reverse().find(l => r >= l.minDays)?.radiusKm ?? LEVELS[0].radiusKm;

const dayOf = (at, now) => {
  const t = Date.parse(at);
  return (Number.isFinite(t) ? new Date(t) : now).toISOString().slice(0, 10);
};
const isoWeek = d => {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear(), w = Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
};

/** Monday of an ISO week "YYYY-Www" as YYYY-MM-DD. */
export function weekStart(week) {
  const m = /^(\d{4})-W(\d{2})$/.exec(week ?? '');
  if (!m) return null;
  const jan4 = new Date(Date.UTC(Number(m[1]), 0, 4));
  const monday = new Date(jan4 - ((jan4.getUTCDay() || 7) - 1) * 86400000 + (Number(m[2]) - 1) * 7 * 86400000);
  return monday.toISOString().slice(0, 10);
}
const lastActive = r => r._lastDay ?? weekStart(r.lastActiveWeek) ?? r.addedOn;

/** Priority for keeping a region: rating halved for every 30 days without activity. */
export function priority(region, now = new Date()) {
  const last = Date.parse(lastActive(region) ?? now.toISOString());
  const idleDays = Math.max(0, (now - last) / 86400000);
  return (region.rating ?? 1) * 0.5 ** (idleDays / 30);
}

/**
 * pinned: regions.json regions (never touched). requested: current requested-regions (mutable copy is returned).
 * sizesMB: {regionId: storedMB} from the last build (for the budget). Returns {regions, changes}.
 * Public records keep only the area, rating, level and the ISO week of last activity (no exact days, no app ids).
 */
export function planDemand(requests, pinned, requested, index, {windowDays = 60, edgeKm = 5, maxNewPerRun = 2,
  maxTotalRegions = 15, budgetMB = 700, sizesMB = {}, pinnedMB = 0, expireDays = 120, isPublished = null,
  now = new Date()} = {}) {
  const changes = {added: [], grown: [], evicted: [], skipped: {}};
  const skip = r => { changes.skipped[r] = (changes.skipped[r] ?? 0) + 1; };
  const since = new Date(now - windowDays * 86400000).toISOString().slice(0, 10);
  // Internal day sets are rebuilt from the CSV every run (the CSV is the private source of truth).
  const regions = requested.map(r => ({...r, publish: {circle: {...r.publish.circle}}, _days: new Set(), _prevRadius: r.publish.circle.radiusKm}));
  const inPinned = p => pinned.some(r => r.publish?.circle && distanceKm(p, r.publish.circle) <= r.publish.circle.radiusKm) || Boolean(isPublished?.(p) && !regions.some(r => distanceKm(p, r.publish.circle) <= r.publish.circle.radiusKm + edgeKm));

  for (const req of requests) {
    const day = dayOf(req.at, now);
    if (day < since) { skip('OUTSIDE_WINDOW'); continue; }
    const near = regions
      .map(r => ({r, d: distanceKm(req, r.publish.circle)}))
      .filter(x => x.d <= x.r.publish.circle.radiusKm + edgeKm)
      .sort((a, b) => a.d - b.d)[0];
    if (near) { near.r._days.add(day); continue; }
    if (inPinned(req)) { skip('PINNED_REGION'); continue; }
    if (changes.added.length >= maxNewPerRun) { skip('RUN_LIMIT'); continue; }
    if (pinned.length + regions.length >= maxTotalRegions) { skip('TOTAL_LIMIT'); continue; }
    const circle = {lat: req.lat, lon: req.lon, radiusKm: LEVELS[0].radiusKm};
    const ex = chooseExtract(index, circle);
    if (!ex) { skip('NO_EXTRACT'); continue; }
    const region = {id: regionId(req), name: `${ex.name} ${req.lat.toFixed(2)},${req.lon.toFixed(2)}`, extract: ex.extract,
      publish: {circle}, addedOn: now.toISOString().slice(0, 10), _days: new Set([day]), _new: true};
    regions.push(region); changes.added.push(region.id);
  }

  for (const r of regions) {
    if (r._days.size) {
      r.rating = Math.max(r._days.size, r._new ? 1 : 0);
      r._lastDay = [...r._days].sort().at(-1);
    } else r.rating = r.rating ?? 1;
    const want = radiusForRating(r.rating);
    if (want > r.publish.circle.radiusKm) {
      const ex = chooseExtract(index, {...r.publish.circle, radiusKm: want});
      if (ex) {
        r.publish.circle.radiusKm = want; r.extract = ex.extract;
        if (!r._new) changes.grown.push(`${r.id}:${want}km`);
      }
    }
  }

  // Expiry and storage budget. Size grows with area (radius^2); unknown sizes use a generous density.
  const est = r => sizesMB[r.id] && r._prevRadius
    ? sizesMB[r.id] * (r.publish.circle.radiusKm / r._prevRadius) ** 2
    : 0.02 * r.publish.circle.radiusKm ** 2;
  const kept = regions.filter(r => {
    if ((now - Date.parse(lastActive(r))) / 86400000 > expireDays) { changes.evicted.push(`${r.id}:inactive`); return false; }
    return true;
  });
  kept.sort((a, b) => priority(b, now) - priority(a, now));
  let total = pinnedMB + kept.reduce((a, r) => a + est(r), 0);
  while (total > budgetMB && kept.length) {
    const victim = kept.pop();
    total -= est(victim);
    changes.evicted.push(`${victim.id}:budget`);
    changes.added = changes.added.filter(id => id !== victim.id);
  }
  const out = kept.map(r => {
    const {_days, _new, _prevRadius, _lastDay, ...pub} = r;
    return {...pub, level: LEVELS.findIndex(l => l.radiusKm === r.publish.circle.radiusKm) + 1,
      lastActiveWeek: isoWeek(new Date(lastActive(r)))};
  });
  return {regions: out, changes};
}
