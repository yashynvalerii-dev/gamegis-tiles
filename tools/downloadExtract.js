#!/usr/bin/env node
/**
 * Downloads Geofabrik extracts (.osm.pbf, MD5 verified) and region boundaries (.poly).
 * Only download.geofabrik.de is used. Geofabrik updates extracts about once a day.
 *
 *   npm.cmd run download-extract                               Thuringia (default)
 *   npm.cmd run download-extract -- --region europe/ukraine    one extract + its .poly
 *   npm.cmd run download-extract -- --config regions.json      every extract and publish boundary in the config
 */
import {createWriteStream, mkdirSync, renameSync, rmSync, statSync, createReadStream, writeFileSync, readFileSync} from 'node:fs';
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

/** Downloads <region>-latest.osm.pbf, verifying the published MD5. */
async function downloadExtract(region) {
  const name = lastPart(region);
  const url = `${BASE}${region}-latest.osm.pbf`;
  const target = join(dir, `${name}-latest.osm.pbf`), part = target + '.part';
  console.log(`Downloading ${url}`);
  const md5Res = await fetch(url + '.md5', {headers: UA});
  if (!md5Res.ok) throw new Error(`MD5 file not available: HTTP ${md5Res.status}`);
  const expected = (await md5Res.text()).trim().split(/\s+/)[0].toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(expected)) throw new Error('Unexpected MD5 file format');
  const res = await fetch(url, {headers: UA});
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
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
  if (!res.ok) { console.warn(`WARNING: ${region}.poly not available (HTTP ${res.status})`); return false; }
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
      const config = JSON.parse(readFileSync(resolve(args[++i]), 'utf8'));
      for (const r of config.regions) {
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
    for (const r of extracts) await downloadExtract(r);
    for (const p of polys) await downloadPoly(p);
  } catch (e) { console.error('FAILED:', e.message); process.exitCode = 1; }
}
