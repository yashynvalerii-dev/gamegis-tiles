#!/usr/bin/env node
/**
 * Downloads Geofabrik extracts (.osm.pbf, MD5 verified) and region boundaries (.poly).
 * Only download.geofabrik.de is used. Geofabrik updates extracts about once a day.
 *
 *   npm.cmd run download-extract                               Thuringia (default)
 *   npm.cmd run download-extract -- --region europe/ukraine    one extract + its .poly
 *   npm.cmd run download-extract -- --config regions.json      every extract and publish boundary in the config
 */
import {createWriteStream, mkdirSync, renameSync, rmSync, statSync, createReadStream, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

const projectDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dir = join(projectDir, 'data', 'extracts');
const UA = {'user-agent': 'GameGIS-Broker/0.1 extract-download'};
const BASE = 'https://download.geofabrik.de/';
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
      const why = e?.cause?.message ? `${e.message} (${e.cause.message})` : String(e?.message ?? e);
      if (e?.permanent || attempt >= delaysS.length) throw new Error(`${label}: ${why}`);
      log(`  ${label}: ${why} — retry ${attempt + 1}/${delaysS.length} in ${delaysS[attempt]} s`);
      await sleep(delaysS[attempt]);
    }
  }
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
  const target = join(dir, `${name}-latest.osm.pbf`), part = target + '.part';
  const {url, expected} = await pickSource(region);
  console.log(`Downloading ${url}`);
  const res = await fetch(url, {headers: UA});
  if (!res.ok || !res.body) throw httpError('Download failed', res.status);
  const total = Number(res.headers.get('content-length')) || 0;
  let got = 0, shown = 0;
  const counter = new TransformStream({transform(chunk, ctl) {
    got += chunk.byteLength;
    if (got - shown > 100 * 1024 * 1024) {
      shown = got;
      console.log(`  ${(got / 1048576).toFixed(0)} MB${total ? ` / ${(total / 1048576).toFixed(0)} MB` : ''}`);
    }
    ctl.enqueue(chunk);
  }});
  await pipeline(Readable.fromWeb(res.body.pipeThrough(counter)), createWriteStream(part));
  const actual = await md5Of(part);
  if (actual !== expected) { rmSync(part, {force: true}); throw new Error(`MD5 mismatch for ${name} (expected ${expected}, got ${actual}); file deleted`); }
  renameSync(part, target);
  console.log(`OK: ${target} (${(statSync(target).size / 1048576).toFixed(1)} MB, MD5 verified)`);
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
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--region') { extracts.add(args[++i]); polys.add(args[i]); }
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
  return {extracts: [...extracts], polys: [...polys]};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const {extracts, polys} = plan(process.argv.slice(2));
    mkdirSync(dir, {recursive: true});
    for (const r of extracts) await withRetry(() => downloadExtract(r), {label: r});
    for (const p of polys) await withRetry(() => downloadPoly(p), {label: `${p}.poly`});
  } catch (e) { console.error('FAILED:', e.message); process.exitCode = 1; }
}
