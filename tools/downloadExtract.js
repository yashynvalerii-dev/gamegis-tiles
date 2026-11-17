#!/usr/bin/env node
/**
 * Downloads Geofabrik extracts (.osm.pbf, MD5 verified) and region boundaries (.poly).
 * Source: download.geofabrik.de (updates about once a day). When Geofabrik refuses or fails (2026-11-16: it refused
 * some GitHub build machines), the build uses the copy already in the build cache (a few days older, no request at all);
 * only a region with no cached copy is fetched once from download.openstreetmap.fr, and only when that server has
 * exactly the same region (never a bigger file). The extract and its boundary always come from the same source.
 *
 *   npm.cmd run download-extract                               Thuringia (default)
 *   npm.cmd run download-extract -- --region europe/ukraine    one extract + its .poly
 *   npm.cmd run download-extract -- --config regions.json      every extract and publish boundary in the config
 */
import {readdirSync, createWriteStream, mkdirSync, renameSync, rmSync, statSync, createReadStream, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

const projectDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dir = join(projectDir, 'data', 'extracts');
const UA = {'user-agent': 'GameGIS-Broker/0.1 extract-download'};
const BASE = 'https://download.geofabrik.de/';
export const OSMFR = 'https://download.openstreetmap.fr/';
/** openstreetmap.fr names use underscores: europe/germany/nordrhein-westfalen -> europe/germany/nordrhein_westfalen. */
export const osmfrPath = region => region.replaceAll('-', '_');
const valid = r => /^[a-z-]+(\/[a-z-]+){0,3}$/.test(r ?? '');
const lastPart = p => p.split('/').pop();

async function md5Of(path) {
  const h = createHash('md5');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}

/**
 * Runs fn() again after a pause when it fails for a transient reason (network error, HTTP 429/5xx, an incomplete
 * or corrupted download). Every successful attempt is still verified by its MD5; after the last attempt it fails
 * closed (the site is not rebuilt, the published one stays).
 */
export async function withRetry(fn, {label = 'download', delaysS = [15, 60, 180], sleep = s => new Promise(r => setTimeout(r, s * 1000)), log = console.log} = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); } catch (e) {
      const cause = [e?.cause?.code, e?.cause?.message].filter(Boolean).join(' ');   // 2026-11-16: bare "fetch failed"
      const why = cause ? `${e.message} (${cause})` : String(e?.message ?? e);
      // a refused connection will not change on this machine: one short retry, then give up quickly
      const refused = e?.cause?.code === 'ECONNREFUSED' && attempt >= 1;
      if (e?.permanent || refused || attempt >= delaysS.length) throw Object.assign(new Error(`${label}: ${why}`), {cause: e?.cause});
      log(`  ${label}: ${why} — retry ${attempt + 1}/${delaysS.length} in ${delaysS[attempt]} s`);
      await sleep(delaysS[attempt]);
    }
  }
}
/**
 * Aborts a transfer that stops delivering data for idleMs (a stalled connection would otherwise hang the build until
 * the job timeout). touch() on every chunk; done() when finished. The abort is transient, so withRetry tries again.
 */
export function idleAbort(idleMs = 120000) {
  const controller = new AbortController();
  let timer;
  const touch = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(new Error(`no data for ${idleMs / 1000} s`)), idleMs); };
  touch();
  return {signal: controller.signal, touch, done: () => clearTimeout(timer)};
}
const httpError = (what, status) => Object.assign(new Error(`${what}: HTTP ${status}`), {permanent: status === 404 || status === 403 || status === 410});

/** YYMMDD for a date (Geofabrik dated snapshot names). */
export const yymmdd = d => d.toISOString().slice(2, 10).replaceAll('-', '');

/**
 * Picks the file to download: "<name>-latest.osm.pbf" when its .md5 is published, otherwise the newest dated
 * snapshot "<name>-YYMMDD.osm.pbf" of the last 10 days (large extracts such as Germany publish MD5 only for
 * dated snapshots). Returns {url, expected} or throws.
 */
export async function pickSource(region, {fetchImpl = fetch, now = new Date()} = {}) {
  const candidates = [`${BASE}${region}-latest.osm.pbf`];
  for (let back = 0; back < 10; back++) candidates.push(`${BASE}${region}-${yymmdd(new Date(now - back * 86400000))}.osm.pbf`);
  for (const url of candidates) {
    const res = await fetchImpl(url + '.md5', {headers: UA});
    if (!res.ok) continue;
    const expected = (await res.text()).trim().split(/\s+/)[0].toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(expected)) throw new Error(`Unexpected MD5 file format at ${url}.md5`);
    return {url, expected};
  }
  throw new Error(`No MD5-verified file found for ${region} (latest or last 10 days)`);
}

/** Downloads the extract (saved as <name>-latest.osm.pbf), verifying the published MD5. */
async function downloadExtract(region) {
  const name = lastPart(region);
  const target = join(dir, `${name}-latest.osm.pbf`);
  const {url, expected} = await pickSource(region);
  // Restored from the build cache with the same published MD5: nothing to download (spares Geofabrik and time).
  if (existsSync(target) && await md5Of(target) === expected) {
    console.log(`OK: ${target} (${(statSync(target).size / 1048576).toFixed(1)} MB, cached, MD5 verified)`);
    return 'cached';
  }
  await fetchTo(url, expected, name);
  return 'downloaded';
}

/** Streams url into <name>-latest.osm.pbf (via .part), aborting a stalled transfer, and checks the MD5. */
async function fetchTo(url, expected, name) {
  const target = join(dir, `${name}-latest.osm.pbf`), part = target + '.part';
  console.log(`Downloading ${url}`);
  const idle = idleAbort();
  try {
    const res = await fetch(url, {headers: UA, signal: idle.signal});
    if (!res.ok || !res.body) throw httpError('Download failed', res.status);
    const total = Number(res.headers.get('content-length')) || 0;
    let got = 0, shown = 0;
    const counter = new TransformStream({transform(chunk, ctl) {
      got += chunk.byteLength;
      idle.touch();
      if (got - shown > 100 * 1024 * 1024) {
        shown = got;
        console.log(`  ${(got / 1048576).toFixed(0)} MB${total ? ` / ${(total / 1048576).toFixed(0)} MB` : ''}`);
      }
      ctl.enqueue(chunk);
    }});
    await pipeline(Readable.fromWeb(res.body.pipeThrough(counter)), createWriteStream(part), {signal: idle.signal});
  } catch (e) {
    if (idle.signal.aborted) throw new Error(`Download stalled: ${idle.signal.reason?.message ?? 'aborted'}`);
    throw e;
  } finally { idle.done(); }
  const actual = await md5Of(part);
  if (actual !== expected) { rmSync(part, {force: true}); throw new Error(`MD5 mismatch for ${name} (expected ${expected}, got ${actual}); file deleted`); }
  renameSync(part, target);
  console.log(`OK: ${target} (${(statSync(target).size / 1048576).toFixed(1)} MB, MD5 verified)`);
}

/** Fallback: the same region from download.openstreetmap.fr, with its own boundary (saved as <name>.poly). */
async function downloadFromOsmfr(region) {
  const name = lastPart(region), url = `${OSMFR}extracts/${osmfrPath(region)}.osm.pbf`;
  const res = await fetch(url + '.md5', {headers: UA});
  if (!res.ok) throw httpError(`openstreetmap.fr has no ${osmfrPath(region)}`, res.status);
  const expected = (await res.text()).trim().split(/\s+/)[0].toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(expected)) throw Object.assign(new Error(`Unexpected MD5 file format at ${url}.md5`), {permanent: true});
  const poly = await fetch(`${OSMFR}polygons/${osmfrPath(region)}.poly`, {headers: UA});
  if (!poly.ok) throw httpError(`openstreetmap.fr boundary ${osmfrPath(region)}.poly`, poly.status);
  const polyText = await poly.text();
  await fetchTo(url, expected, name);
  writeFileSync(join(dir, `${name}.poly`), polyText);   // boundary of THIS extract (never Geofabrik's)
  console.log(`OK: ${name}.poly (openstreetmap.fr boundary)`);
}

/** Downloads <region>.poly (the boundary of the area Geofabrik cut). */
async function downloadPoly(region) {
  const res = await fetch(`${BASE}${region}.poly`, {headers: UA});
  if (res.status === 404) { console.warn(`WARNING: ${region}.poly not available (HTTP 404)`); return false; }
  if (!res.ok) throw httpError(`${region}.poly`, res.status);
  const path = join(dir, `${lastPart(region)}.poly`);
  writeFileSync(path, await res.text());
  console.log(`OK: ${path} (boundary)`);
  return true;
}

export function plan(args) {
  const extracts = new Set(), polys = new Set();
  let prune = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--prune') prune = true;
    else if (args[i] === '--region') { extracts.add(args[++i]); polys.add(args[i]); }
    else if (args[i] === '--config') {
      const path = resolve(args[++i]);
      if (!existsSync(path)) continue;   // optional configs (requested-regions.json) may not exist yet
      const config = JSON.parse(readFileSync(path, 'utf8'));
      for (const r of [...(config.regions ?? []), ...(config.precise ?? [])]) {
        extracts.add(r.extract); polys.add(r.extract);
        if (r.publish?.poly) polys.add(r.publish.poly);
      }
    } else throw new Error(`Unknown argument ${args[i]}`);
  }
  if (!extracts.size) { extracts.add('europe/germany/thueringen'); polys.add('europe/germany/thueringen'); }
  for (const r of [...extracts, ...polys]) if (!valid(r)) throw new Error(`Invalid region path: ${r}`);
  return {extracts: [...extracts], polys: [...polys], prune};
}

/** Extract files in dir that no configured region uses (e.g. Germany after Thuringia got its own extract). */
export function staleExtracts(files, extracts) {
  const keep = new Set(extracts.map(r => `${lastPart(r)}-latest.osm.pbf`));
  return files.filter(f => /\.osm\.pbf(\.part)?$/.test(f) && !keep.has(f));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const {extracts, polys, prune} = plan(process.argv.slice(2));
    mkdirSync(dir, {recursive: true});
    // --prune (full builds): drop extracts no region uses, so the build cache does not carry them.
    if (prune) for (const f of staleExtracts(readdirSync(dir), extracts)) { rmSync(join(dir, f), {force: true}); console.log(`Removed unused extract ${f}`); }
    const keepPoly = new Set();   // extracts not from Geofabrik this run: their boundary must stay paired with them
    const fresh = new Set();      // freshly downloaded from Geofabrik: their boundary must be fresh too
    for (const r of extracts) {
      try { if (await withRetry(() => downloadExtract(r), {label: r}) === 'downloaded') fresh.add(lastPart(r)); continue; } catch (e) {
        const name = lastPart(r);
        if (existsSync(join(dir, `${name}-latest.osm.pbf`))) {
          console.log(`::warning::${e.message} — using the cached ${name} extract (verified when it was downloaded; data a few days older)`);
          keepPoly.add(name); continue;
        }
        try {
          await withRetry(() => downloadFromOsmfr(r), {label: `${r} (openstreetmap.fr)`, delaysS: [30]});
          console.log(`::warning::${e.message} — ${name} taken from openstreetmap.fr instead`);
          keepPoly.add(name);
        } catch (e2) { throw new Error(`${e.message}; fallback: ${e2.message}`); }
      }
    }
    for (const p of polys) {
      const polyPath = join(dir, `${lastPart(p)}.poly`);
      if (keepPoly.has(lastPart(p)) && existsSync(polyPath)) { console.log(`OK: ${polyPath} (kept with its extract)`); continue; }
      try { await withRetry(() => downloadPoly(p), {label: `${p}.poly`}); } catch (e) {
        if (!existsSync(polyPath) || fresh.has(lastPart(p))) throw e;
        console.log(`::warning::${e.message} — using the cached ${lastPart(p)}.poly`);
      }
    }
  } catch (e) { console.error('FAILED:', e.message); process.exitCode = 1; }
}
