/**
 * Polite access to OSM data sources (owner 2026-11-18: "never get banned again, never land on suspicious lists").
 *
 * Every request to an outside data server goes through politeFetch(), which enforces in code:
 * - one request at a time (callers await each request; nothing here runs in parallel);
 * - an identifying User-Agent with a link to the public project page (no e-mail, no personal name);
 * - a per-source journal (source-usage.json, committed openly): requests per day and bytes per day / week;
 * - limits per source (LIMITS) checked BEFORE a request and before a download body is read (Content-Length);
 * - a pause after a refusal: 24 h after 403/406/429, 6 h after 5xx or a network refusal; paused sources are not asked;
 * - remembered "not available here" answers (404) for 30 days, so a source without our region is not asked again.
 * Failover to the next source happens only after a refusal or a missing file, never to spread load.
 */
import {readFileSync, writeFileSync, existsSync} from 'node:fs';

export const USER_AGENT = 'GameGIS-Broker/0.2 (+https://gamegis-tiles.pages.dev/)';   // project page; no personal names
const GB = 1024 ** 3, MB = 1024 ** 2;

/** Limits far below what each service allows (owner 2026-11-18). */
export const LIMITS = Object.freeze({
  geofabrik: {host: 'download.geofabrik.de', weekBytes: 3 * GB, dayRequests: 60, label: 'Geofabrik'},
  movisda: {host: 'osm.download.movisda.io', weekBytes: 1 * GB, dayRequests: 30, label: 'Movisda'},
  geo2day: {host: 'geo2day.com', weekBytes: 1 * GB, dayRequests: 30, label: 'geo2day'},
  osmfr: {host: 'download.openstreetmap.fr', weekBytes: 0.5 * GB, dayRequests: 30, label: 'openstreetmap.fr'},
  'overpass-eu': {host: 'ovp.dresel.systems', dayBytes: 50 * MB, dayRequests: 20, label: 'Overpass Europe (dresel.systems)'},
});
const PAUSE_LONG_H = 24, PAUSE_SHORT_H = 6, MISSING_DAYS = 30, KEEP_DAYS = 14;

const day = d => d.toISOString().slice(0, 10);
export class SourceUnavailable extends Error {
  constructor(message, {reason, source, status} = {}) { super(message); this.reason = reason; this.source = source; this.status = status; }
}

/** The journal: loaded from / saved to a JSON file (or kept in memory when path is null). */
export function openLedger(path = null, {now = () => new Date()} = {}) {
  const data = path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  data.note ??= 'Requests and bytes GameGIS Broker took from each OSM data source (polite-use journal, owner 2026-11-18).';
  data.sources ??= {}; data.files ??= {}; data.missing ??= {};
  const src = id => (data.sources[id] ??= {days: {}, pausedUntil: null, pauseReason: null});
  const today = () => day(now());
  const sumDays = (id, n, key) => {
    const since = day(new Date(now().getTime() - (n - 1) * 86400000));
    return Object.entries(src(id).days).filter(([d]) => d >= since).reduce((a, [, v]) => a + (v[key] ?? 0), 0);
  };
  return {
    data,
    usage(id) {
      const s = src(id), t = s.days[today()] ?? {};
      return {dayRequests: t.requests ?? 0, dayBytes: t.bytes ?? 0, weekBytes: sumDays(id, 7, 'bytes'), pausedUntil: s.pausedUntil};
    },
    count(id, {requests = 0, bytes = 0} = {}) {
      const d = (src(id).days[today()] ??= {requests: 0, bytes: 0});
      d.requests += requests; d.bytes += bytes;
    },
    pause(id, hours, reason) {
      const s = src(id), until = new Date(now().getTime() + hours * 3600000).toISOString();
      if (!s.pausedUntil || s.pausedUntil < until) { s.pausedUntil = until; s.pauseReason = reason; }
    },
    isPaused(id) { const p = src(id).pausedUntil; return Boolean(p && p > now().toISOString()); },
    markMissing(key) { data.missing[key] = new Date(now().getTime() + MISSING_DAYS * 86400000).toISOString(); },
    isMissing(key) { const m = data.missing[key]; return Boolean(m && m > now().toISOString()); },
    file(key) { return data.files[key] ?? null; },
    setFile(key, info) { data.files[key] = {...(data.files[key] ?? {}), ...info}; },
    save() {
      const keepSince = day(new Date(now().getTime() - KEEP_DAYS * 86400000));
      for (const s of Object.values(data.sources)) for (const d of Object.keys(s.days)) if (d < keepSince) delete s.days[d];
      for (const [k, v] of Object.entries(data.missing)) if (v <= now().toISOString()) delete data.missing[k];
      data.limits = Object.fromEntries(Object.entries(LIMITS).map(([k, v]) => [k, {...v}]));
      if (path) writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
    },
  };
}

/** Throws SourceUnavailable when the source is paused or its budget would be exceeded. */
export function checkBudget(ledger, id, {expectBytes = 0} = {}) {
  const lim = LIMITS[id], u = ledger.usage(id);
  if (!lim) throw new Error(`Unknown source ${id}`);
  if (ledger.isPaused(id)) throw new SourceUnavailable(`${lim.label} paused until ${u.pausedUntil}`, {reason: 'PAUSED', source: id});
  if (u.dayRequests >= lim.dayRequests) throw new SourceUnavailable(`${lim.label}: daily request limit ${lim.dayRequests} reached`, {reason: 'BUDGET', source: id});
  if (lim.weekBytes && u.weekBytes + expectBytes > lim.weekBytes) throw new SourceUnavailable(`${lim.label}: weekly limit ${(lim.weekBytes / GB).toFixed(1)} GB would be exceeded`, {reason: 'BUDGET', source: id});
  if (lim.dayBytes && u.dayBytes + expectBytes > lim.dayBytes) throw new SourceUnavailable(`${lim.label}: daily limit ${(lim.dayBytes / MB).toFixed(0)} MB would be exceeded`, {reason: 'BUDGET', source: id});
}

/**
 * One request to a source, after checking its pause and budget. Counts the request. On a refusal pauses the source.
 * The response body is NOT read here: callers stream it and report the bytes with ledger.count(id, {bytes}).
 * A body larger than the remaining budget (by Content-Length) is cancelled before reading.
 */
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);
export async function politeFetch(ledger, id, url, {fetchImpl = fetch, method = 'GET', headers = {}, signal, body,
  sleep = s => new Promise(r => setTimeout(r, s * 1000)), retryDelayS = 15} = {}) {
  const host = new URL(url).host;
  if (host !== LIMITS[id].host) throw new Error(`URL host ${host} is not the host of source ${id}`);
  let res;
  for (let attempt = 0; ; attempt++) {
    checkBudget(ledger, id);
    ledger.count(id, {requests: 1});
    try {
      res = await fetchImpl(url, {method, headers: {'user-agent': USER_AGENT, ...headers}, signal, body, redirect: 'follow'});
      break;
    } catch (e) {
      const code = e?.cause?.code ?? e?.code;
      if (!NETWORK_CODES.has(code) && !/fetch failed/.test(String(e?.message))) throw e;
      if (attempt === 0) { await sleep(retryDelayS); continue; }   // one short retry, then the source rests
      ledger.pause(id, PAUSE_SHORT_H, `network ${code ?? 'error'}`);
      throw new SourceUnavailable(`${LIMITS[id].label}: connection failed (${code ?? e.message}) — paused ${PAUSE_SHORT_H} h`, {reason: 'REFUSED', source: id});
    }
  }
  if ([403, 406, 429].includes(res.status)) {
    ledger.pause(id, PAUSE_LONG_H, `HTTP ${res.status}`);
    await res.body?.cancel?.().catch(() => {});
    throw new SourceUnavailable(`${LIMITS[id].label}: HTTP ${res.status} — paused ${PAUSE_LONG_H} h`, {reason: 'REFUSED', source: id, status: res.status});
  }
  if (res.status >= 500) {
    ledger.pause(id, PAUSE_SHORT_H, `HTTP ${res.status}`);
    await res.body?.cancel?.().catch(() => {});
    throw new SourceUnavailable(`${LIMITS[id].label}: HTTP ${res.status} — paused ${PAUSE_SHORT_H} h`, {reason: 'REFUSED', source: id, status: res.status});
  }
  if (method === 'GET' && res.ok && res.body) {
    const len = Number(res.headers.get('content-length')) || 0;
    try { checkBudget(ledger, id, {expectBytes: len}); }
    catch (e) { await res.body.cancel().catch(() => {}); throw e; }
  }
  return res;
}

/** Reads a small text body through politeFetch, counting its bytes. */
export async function politeText(ledger, id, url, opts = {}) {
  const res = await politeFetch(ledger, id, url, opts);
  const text = res.ok ? await res.text() : (await res.body?.cancel?.().catch(() => {}), '');
  ledger.count(id, {bytes: Buffer.byteLength(text)});
  return {res, text};
}

/** Where each source keeps a region (Geofabrik path such as "europe/germany/thueringen"). */
export const SOURCE_PATHS = Object.freeze({
  geofabrik: r => ({pbf: `https://download.geofabrik.de/${r}-latest.osm.pbf`, md5: `https://download.geofabrik.de/${r}-latest.osm.pbf.md5`,
    poly: `https://download.geofabrik.de/${r}.poly`}),
  // Movisda accepts Geofabrik-style names and redirects to its own (/admin/DE-TH-...); no MD5: size + full PBF check.
  movisda: r => ({pbf: `https://osm.download.movisda.io/${r}-latest.osm.pbf`, md5: null, poly: `https://osm.download.movisda.io/${r}.poly`}),
  geo2day: r => { const p = r.replaceAll('-', '_');
    return {pbf: `https://geo2day.com/${p}.pbf`, md5: `https://geo2day.com/${p}.pbf.md5`, poly: `https://geo2day.com/${p}.poly`}; },
  osmfr: r => { const p = r.replaceAll('-', '_');
    return {pbf: `https://download.openstreetmap.fr/extracts/${p}.osm.pbf`, md5: `https://download.openstreetmap.fr/extracts/${p}.osm.pbf.md5`,
      poly: `https://download.openstreetmap.fr/polygons/${p}.poly`}; },
});
/** Order of extract sources after Geofabrik (owner 2026-11-18). */
export const FALLBACK_ORDER = Object.freeze(['movisda', 'geo2day', 'osmfr']);

/** Never a continent or a whole big country instead of the region asked for. */
export function allowedRegionPath(r) {
  return /^[a-z_-]+(\/[a-z_-]+){1,3}$/.test(r ?? '');
}
