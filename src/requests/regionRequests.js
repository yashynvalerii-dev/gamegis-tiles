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
// Demand system (planDemand). An area follows WHERE people actually play, not how often they tap:
//  - every signal (a region request or a periodic "people play here" report) is a coarse point;
//  - a signal inside an area only CONFIRMS it (keeps it alive, raises its rating) — the area does not grow;
//  - an area covers the points played in the last windowDays: the smallest circle around them + marginKm
//    (never below minRadiusKm, never above maxRadiusKm). Players who move past the edge make it grow in
//    that direction; directions not played for windowDays are given back (the circle shrinks or moves);
//  - a point outside the current circle counts only after growAfterDays distinct days there
//    (one trip does not buy storage; a habit does);
//  - signals farther than reachKm from every area start a new small area (maxNewPerRun / maxTotalRegions);
//  - rating = distinct UTC days with signals in the window: it sets the priority for keeping an area;
//  - storage budget: above budgetMB the lowest-priority areas are evicted; areas without any signal for
//    expireDays are evicted anyway; pinned regions (regions.json) are never changed or evicted.

export const DEMAND_DEFAULTS = Object.freeze({windowDays: 60, minRadiusKm: 3, maxRadiusKm: 20, marginKm: 3,
  reachKm: 8, growAfterDays: 2});

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

/** Smallest circle containing all points ({lat, lon}); returns {lat, lon, radiusKm}. Local flat projection. */
export function enclosingCircle(points) {
  if (!points.length) return null;
  const lat0 = points[0].lat, kx = 111.32 * Math.cos(toRad(lat0)), ky = 111.32;
  const P = points.map(p => ({x: (p.lon - points[0].lon) * kx, y: (p.lat - lat0) * ky}));
  const inC = (c, p) => Math.hypot(p.x - c.x, p.y - c.y) <= c.r + 1e-9;
  const two = (a, b) => ({x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, r: Math.hypot(a.x - b.x, a.y - b.y) / 2});
  const three = (a, b, c) => {
    const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if (Math.abs(d) < 1e-12) return [two(a, b), two(a, c), two(b, c)].sort((u, v) => v.r - u.r)[0];
    const sq = q => q.x * q.x + q.y * q.y;
    const x = (sq(a) * (b.y - c.y) + sq(b) * (c.y - a.y) + sq(c) * (a.y - b.y)) / d;
    const y = (sq(a) * (c.x - b.x) + sq(b) * (a.x - c.x) + sq(c) * (b.x - a.x)) / d;
    return {x, y, r: Math.hypot(a.x - x, a.y - y)};
  };
  let c = {x: P[0].x, y: P[0].y, r: 0};
  for (let i = 1; i < P.length; i++) if (!inC(c, P[i])) {
    c = {x: P[i].x, y: P[i].y, r: 0};
    for (let j = 0; j < i; j++) if (!inC(c, P[j])) {
      c = two(P[i], P[j]);
      for (let k = 0; k < j; k++) if (!inC(c, P[k])) c = three(P[i], P[j], P[k]);
    }
  }
  return {lat: lat0 + c.y / ky, lon: points[0].lon + c.x / kx, radiusKm: c.r};
}

/** Area for a set of played points: enclosing circle + margin, centre rounded (~0.5 km), radius in 0.5 km steps. */
export function areaFor(points, {minRadiusKm, marginKm}) {
  const c = enclosingCircle(points);
  const lat = Math.round(c.lat * 200) / 200, lon = Math.round(c.lon * 200) / 200;
  const shift = distanceKm(c, {lat, lon});
  const radiusKm = Math.max(minRadiusKm, Math.ceil((c.radiusKm + marginKm + shift) * 2 - 1e-9) / 2);
  return {lat: Number(lat.toFixed(3)), lon: Number(lon.toFixed(3)), radiusKm};
}

/**
 * pinned: regions.json regions (never touched). requested: current requested-regions (a new list is returned).
 * sizesMB: {regionId: storedMB} from the last build (for the budget). Returns {regions, changes}.
 * Public records keep only the area, rating and the ISO week of last activity (no exact days, no app ids).
 */
export function planDemand(requests, pinned, requested, index, {windowDays = DEMAND_DEFAULTS.windowDays,
  minRadiusKm = DEMAND_DEFAULTS.minRadiusKm, maxRadiusKm = DEMAND_DEFAULTS.maxRadiusKm, marginKm = DEMAND_DEFAULTS.marginKm,
  reachKm = DEMAND_DEFAULTS.reachKm, growAfterDays = DEMAND_DEFAULTS.growAfterDays, maxNewPerRun = 2,
  maxTotalRegions = 15, budgetMB = 700, sizesMB = {}, pinnedMB = 0, expireDays = 120, isPublished = null,
  now = new Date()} = {}) {
  const changes = {added: [], resized: [], evicted: [], skipped: {}};
  const skip = r => { changes.skipped[r] = (changes.skipped[r] ?? 0) + 1; };
  const since = new Date(now - windowDays * 86400000).toISOString().slice(0, 10);
  const opts = {minRadiusKm, marginKm};
  // Internal point sets are rebuilt from the CSV every run (the CSV is the private source of truth).
  const fresh = r => ({...r, publish: {circle: {...r.publish.circle}}, _points: new Map(), _prev: {...r.publish.circle}});
  const regions = requested.map(fresh);
  const nearest = p => regions.map(r => ({r, d: distanceKm(p, r.publish.circle)}))
    .filter(x => x.d <= x.r.publish.circle.radiusKm + reachKm).sort((a, b) => a.d - b.d)[0]?.r;
  const inPinned = p => pinned.some(r => r.publish?.circle && distanceKm(p, r.publish.circle) <= r.publish.circle.radiusKm) ||
    Boolean(isPublished?.(p) && !nearest(p));
  const addPoint = (r, req, day) => {
    const k = `${req.lat},${req.lon}`;
    const e = r._points.get(k) ?? {lat: req.lat, lon: req.lon, days: new Set()};
    e.days.add(day); r._points.set(k, e);
  };

  for (const req of requests) {
    const day = dayOf(req.at, now);
    if (day < since) { skip('OUTSIDE_WINDOW'); continue; }
    const near = nearest(req);
    if (near) { addPoint(near, req, day); continue; }
    if (inPinned(req)) { skip('PINNED_REGION'); continue; }
    if (changes.added.length >= maxNewPerRun) { skip('RUN_LIMIT'); continue; }
    if (pinned.length + regions.length >= maxTotalRegions) { skip('TOTAL_LIMIT'); continue; }
    const circle = {lat: req.lat, lon: req.lon, radiusKm: minRadiusKm};
    const ex = chooseExtract(index, circle);
    if (!ex) { skip('NO_EXTRACT'); continue; }
    const region = {...fresh({id: regionId(req), name: `${ex.name} ${req.lat.toFixed(2)},${req.lon.toFixed(2)}`, extract: ex.extract,
      publish: {circle}, addedOn: now.toISOString().slice(0, 10)}), _new: true};
    addPoint(region, req, day);
    regions.push(region); changes.added.push(region.id);
  }

  for (const r of regions) {
    const pts = [...r._points.values()];
    if (!pts.length) { r.rating = r.rating ?? 1; continue; }                     // no news: keep as is until expiry
    r.rating = new Set(pts.flatMap(p => [...p.days])).size;
    r._lastDay = pts.flatMap(p => [...p.days]).sort().at(-1);
    // Points inside the current area always count (confirmation); outside — only once they became a habit.
    const counted = pts.filter(p => distanceKm(p, r._prev) <= r._prev.radiusKm || p.days.size >= growAfterDays || r._new);
    if (!counted.length) continue;
    counted.sort((a, b) => distanceKm(a, r._prev) - distanceKm(b, r._prev));
    let area = areaFor(counted, opts);
    while (area.radiusKm > maxRadiusKm && counted.length > 1) { counted.pop(); area = areaFor(counted, opts); skip('MAX_RADIUS'); }
    area.radiusKm = Math.min(area.radiusKm, maxRadiusKm);
    const ex = chooseExtract(index, area);
    if (!ex) { skip('NO_EXTRACT'); continue; }
    const p = r._prev;
    if (r._new) { r.publish.circle = area; r.extract = ex.extract; continue; }
    if (area.lat !== p.lat || area.lon !== p.lon || area.radiusKm !== p.radiusKm) {
      r.publish.circle = area; r.extract = ex.extract;
      changes.resized.push(`${r.id}:${p.radiusKm}->${area.radiusKm}km`);
    }
  }

  // Expiry and storage budget. Size grows with area (radius^2); unknown sizes use a generous density.
  const est = r => sizesMB[r.id] && r._prev?.radiusKm
    ? sizesMB[r.id] * (r.publish.circle.radiusKm / r._prev.radiusKm) ** 2
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
    const {_points, _new, _prev, _lastDay, level, ...pub} = r;
    return {...pub, lastActiveWeek: isoWeek(new Date(lastActive(r)))};
  });
  return {regions: out, changes};
}
