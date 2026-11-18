/**
 * Gets one regional extract (+ its boundary) for a build, politely (owner 2026-11-18).
 *
 * Order for a region:
 *  1. our own copy, with no request at all, when it is younger than `cacheDays` (builds after a code change: 14) or
 *     when Geofabrik was already asked about this file today (a file at most once a day);
 *  2. Geofabrik: tiny MD5 check first; the file is downloaded only when it changed;
 *  3. when Geofabrik refuses, is paused or over budget: our copy if younger than 30 days;
 *  4. otherwise the same region from Movisda, geo2day, openstreetmap.fr — strictly one after another, the next only
 *     after a refusal or "not here"; never a bigger file (no continents);
 *  5. last resort: our copy of any age (warned), else the build fails for this region (the site keeps the old one).
 * The extract and its boundary always come from the same source; every file is verified (MD5, or size + full read).
 */
import {createReadStream, createWriteStream, existsSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {politeFetch, politeText, SourceUnavailable, SOURCE_PATHS, FALLBACK_ORDER, allowedRegionPath, LIMITS} from './politeSources.js';
import {scanPbf, readPbfBlobs, decodeHeader} from '../providers/pbfReader.js';

const DAY = 86400000;
export const FALLBACK_CACHE_DAYS = 30;
const lastPart = p => p.split('/').pop();
const md5Of = async path => { const h = createHash('md5'); await pipeline(createReadStream(path), h); return h.digest('hex'); };
const md5From = text => { const m = String(text).trim().split(/\s+/)[0]?.toLowerCase(); return /^[0-9a-f]{32}$/.test(m ?? '') ? m : null; };

/** Aborts a transfer that delivers no data for idleMs. */
export function idleAbort(idleMs = 120000) {
  const controller = new AbortController();
  let timer;
  const touch = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(new Error(`no data for ${idleMs / 1000} s`)), idleMs); };
  touch();
  return {signal: controller.signal, touch, done: () => clearTimeout(timer)};
}

/** Streams a source file into `target` (via .part), counting bytes in the journal; returns the byte count. */
async function download(ledger, id, url, target, {fetchImpl, log, idleMs, sleep}) {
  const part = target + '.part', idle = idleAbort(idleMs);
  log(`Downloading ${url} (${LIMITS[id].label})`);
  let got = 0;
  try {
    const res = await politeFetch(ledger, id, url, {fetchImpl, signal: idle.signal, ...(sleep ? {sleep} : {})});
    if (res.status === 404) { await res.body?.cancel?.().catch(() => {}); throw Object.assign(new Error('HTTP 404'), {missing: true}); }
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    let shown = 0;
    const counter = new TransformStream({transform(chunk, ctl) {
      got += chunk.byteLength; idle.touch();
      if (got - shown > 100 * 1048576) { shown = got; log(`  ${(got / 1048576).toFixed(0)} MB${total ? ` / ${(total / 1048576).toFixed(0)} MB` : ''}`); }
      ctl.enqueue(chunk);
    }});
    await pipeline(Readable.fromWeb(res.body.pipeThrough(counter)), createWriteStream(part), {signal: idle.signal});
    if (total && got !== total) throw new Error(`incomplete download (${got} of ${total} bytes)`);
  } catch (e) {
    rmSync(part, {force: true});
    if (idle.signal.aborted) {   // a stalled transfer looks like throttling: let the source rest
      ledger.pause(id, 6, 'download stalled');
      throw new SourceUnavailable(`${LIMITS[id].label}: download stalled — paused 6 h`, {reason: 'REFUSED', source: id});
    }
    throw e;
  } finally { idle.done(); ledger.count(id, {bytes: got}); }
  return {part, bytes: got};
}

/** Date of the OSM data in a PBF (its header), read from the first block only; null when unknown. */
export function pbfDataTime(path) {
  try {
    for (const {type, data} of readPbfBlobs(path)) {
      if (type !== 'OSMHeader') return null;
      const ts = decodeHeader(data).replicationTimestamp;
      return Number.isSafeInteger(ts) && ts > 0 ? new Date(ts * 1000) : null;
    }
  } catch { return null; }
  return null;
}

/** A PBF without a published MD5 (Movisda) must at least read completely (every block decompresses and parses). */
function verifyPbfReadable(path) {
  const header = scanPbf(path, {node() {}, way() {}, relation() {}});
  if (!Number.isSafeInteger(header?.replicationTimestamp) || header.replicationTimestamp <= 0) throw new Error('PBF has no replication timestamp');
  return header;
}

/** Asks one source for the region; returns {source, bytes} or throws (SourceUnavailable / missing). */
async function fromSource(id, region, {ledger, dir, fetchImpl, log, now, idleMs, cachedMd5, sleep}) {
  const o = {fetchImpl, ...(sleep ? {sleep} : {})};
  const key = `${id}:${region}`, name = lastPart(region);
  if (ledger.isMissing(key)) throw Object.assign(new Error(`${LIMITS[id].label} has no ${region} (remembered)`), {missing: true});
  const paths = SOURCE_PATHS[id](region);
  let expected = null;
  if (paths.md5) {
    const {res, text} = await politeText(ledger, id, paths.md5, o);
    if (res.status === 404) { ledger.markMissing(key); throw Object.assign(new Error(`${LIMITS[id].label} has no ${region}`), {missing: true}); }
    if (!res.ok || !(expected = md5From(text))) throw new Error(`${LIMITS[id].label}: no valid MD5 for ${region} (HTTP ${res.status})`);
    if (cachedMd5 && cachedMd5 === expected) return {source: id, bytes: 0, unchanged: true, md5: expected};
  }
  // boundary first (small): no boundary, no extract — they must come from the same source
  const {res: pres, text: polyText} = await politeText(ledger, id, paths.poly, o);
  if (pres.status === 404) { ledger.markMissing(key); throw Object.assign(new Error(`${LIMITS[id].label} has no boundary for ${region}`), {missing: true}); }
  if (!pres.ok || !/^\S/.test(polyText) || !/END\s*$/.test(polyText.trim())) throw new Error(`${LIMITS[id].label}: invalid boundary for ${region}`);
  const target = join(dir, `${name}-latest.osm.pbf`);
  let dl;
  try { dl = await download(ledger, id, paths.pbf, target, {fetchImpl, log, idleMs, sleep}); }
  catch (e) { if (e.missing) ledger.markMissing(key); throw e; }
  const actual = await md5Of(dl.part);
  if (expected && actual !== expected) { rmSync(dl.part, {force: true}); throw new Error(`MD5 mismatch for ${region} from ${LIMITS[id].label}`); }
  if (!expected) { try { verifyPbfReadable(dl.part); } catch (e) { rmSync(dl.part, {force: true}); throw new Error(`${LIMITS[id].label}: unreadable PBF for ${region}: ${e.message}`); } }
  renameSync(dl.part, target);
  writeFileSync(join(dir, `${name}.poly`), polyText);
  log(`OK: ${name} from ${LIMITS[id].label} (${(dl.bytes / 1048576).toFixed(1)} MB, ${expected ? 'MD5' : 'size + full read'} verified)`);
  return {source: id, bytes: dl.bytes, md5: actual, downloadedAt: now().toISOString()};
}

/** Trial of one source for one region (manual check that a fallback really works; counted in the journal). */
export async function trySource(id, region, {ledger, dir, fetchImpl = fetch, log = console.log, now = () => new Date()} = {}) {
  if (!allowedRegionPath(region)) throw new Error(`Refusing region path "${region}"`);
  return fromSource(id, region, {ledger, dir, fetchImpl, log, now, idleMs: 120000});
}

/**
 * Ensures data/extracts/<name>-latest.osm.pbf and <name>.poly for one region. Returns
 * {name, source: 'cache'|<source id>, ageDays, note}. Throws when no copy can be had.
 */
export async function fetchExtract(region, {ledger, dir, fetchImpl = fetch, cacheDays = 0, log = console.log, warn = m => console.log(`::warning::${m}`),
  now = () => new Date(), idleMs = 120000, sleep = undefined} = {}) {
  if (!allowedRegionPath(region)) throw new Error(`Refusing region path "${region}" (never a continent or an invalid path)`);
  const name = lastPart(region), target = join(dir, `${name}-latest.osm.pbf`), polyPath = join(dir, `${name}.poly`);
  const fileKey = `extract:${region}`, entry = ledger.file(fileKey) ?? {};
  const have = existsSync(target) && existsSync(polyPath);
  // Age of OUR COPY = age of its OSM data (file dates change when the build cache is restored).
  const ageDays = have ? (now() - (pbfDataTime(target) ?? new Date(entry.downloadedAt ?? statSync(target).mtime))) / DAY : Infinity;
  const today = now().toISOString().slice(0, 10);
  const useCache = (note) => { log(`OK: ${name} from our copy (${ageDays.toFixed(1)} days old; ${note}; no request)`); return {name, source: 'cache', ageDays, note}; };

  if (have && cacheDays > 0 && ageDays <= cacheDays) return useCache(`younger than ${cacheDays} days`);
  if (have && entry.checkedOn === today) return useCache('already checked today');

  const errors = [];
  try {
    const cachedMd5 = have ? (entry.md5 ?? await md5Of(target)) : null;
    const r = await fromSource('geofabrik', region, {ledger, dir, fetchImpl, log, now, idleMs, sleep, cachedMd5: entry.source && entry.source !== 'geofabrik' ? null : cachedMd5});
    ledger.setFile(fileKey, {checkedOn: today, source: 'geofabrik', md5: r.md5,
      ...(r.unchanged ? {downloadedAt: entry.downloadedAt ?? new Date(statSync(target).mtime).toISOString()} : {downloadedAt: r.downloadedAt})});
    if (r.unchanged) { log(`OK: ${name} unchanged at Geofabrik (MD5 check only)`); return {name, source: 'cache', ageDays, note: 'unchanged'}; }
    return {name, source: 'geofabrik', ageDays: 0};
  } catch (e) { errors.push(e.message); warn(`${name}: ${e.message}`); }

  if (have && ageDays <= FALLBACK_CACHE_DAYS) return useCache('Geofabrik unavailable');
  for (const id of FALLBACK_ORDER) {
    try {
      const r = await fromSource(id, region, {ledger, dir, fetchImpl, log, now, idleMs, sleep});
      ledger.setFile(fileKey, {checkedOn: today, source: id, md5: r.md5, downloadedAt: r.downloadedAt});
      warn(`${name} taken from ${LIMITS[id].label} (Geofabrik unavailable)`);
      return {name, source: id, ageDays: 0};
    } catch (e) { errors.push(e.message); if (!e.missing) warn(`${name}: ${e.message}`); }
  }
  if (have) { warn(`${name}: every source unavailable — using our ${ageDays.toFixed(0)}-day-old copy`); return useCache('every source unavailable'); }
  throw new Error(`${region}: no source available (${errors.join('; ')})`);
}

/** A publish boundary that is not an extract's own (Geofabrik), politely, falling back to our copy. */
export async function fetchPublishPoly(region, {ledger, dir, fetchImpl = fetch, log = console.log, warn = m => console.log(`::warning::${m}`)} = {}) {
  const path = join(dir, `${lastPart(region)}.poly`);
  try {
    const {res, text} = await politeText(ledger, 'geofabrik', SOURCE_PATHS.geofabrik(region).poly, {fetchImpl});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(path, text); log(`OK: ${path} (boundary)`); return true;
  } catch (e) {
    if (!existsSync(path)) throw new Error(`${region}.poly: ${e.message}`);
    warn(`${region}.poly: ${e.message} — using our copy`); return false;
  }
}
