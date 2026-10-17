#!/usr/bin/env node
/**
 * Downloads a Geofabrik regional extract (.osm.pbf) and verifies its published MD5.
 * Only download.geofabrik.de is allowed. Default region: europe/germany/thueringen.
 * Geofabrik updates extracts about once a day; downloading more often than that is pointless.
 *
 * Usage: npm.cmd run download-extract [-- --region europe/germany/thueringen]
 */
import {createWriteStream, mkdirSync, renameSync, rmSync, statSync, createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

const projectDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const region = args[0] === '--region' ? args[1] : 'europe/germany/thueringen';
if (!/^[a-z-]+(\/[a-z-]+){0,3}$/.test(region ?? '')) { console.error('Invalid --region'); process.exit(2); }

const name = region.split('/').pop();
const url = `https://download.geofabrik.de/${region}-latest.osm.pbf`;
const dir = join(projectDir, 'data', 'extracts');
const target = join(dir, `${name}-latest.osm.pbf`);
const part = target + '.part';
const UA = {'user-agent': 'GameGIS-Broker/0.1 extract-download'};

async function md5Of(path) {
  const h = createHash('md5');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}

mkdirSync(dir, {recursive: true});
console.log(`Downloading ${url}`);
const md5Res = await fetch(url + '.md5', {headers: UA});
if (!md5Res.ok) { console.error(`MD5 file not available: HTTP ${md5Res.status}`); process.exit(1); }
const expected = (await md5Res.text()).trim().split(/\s+/)[0].toLowerCase();
if (!/^[0-9a-f]{32}$/.test(expected)) { console.error('Unexpected MD5 file format'); process.exit(1); }

const res = await fetch(url, {headers: UA});
if (!res.ok || !res.body) { console.error(`Download failed: HTTP ${res.status}`); process.exit(1); }
const total = Number(res.headers.get('content-length')) || 0;
let got = 0, lastShown = 0;
const counter = new TransformStream({transform(chunk, ctl) {
  got += chunk.byteLength;
  if (got - lastShown > 10 * 1024 * 1024) {
    lastShown = got;
    process.stdout.write(`\r  ${(got / 1048576).toFixed(0)} MB${total ? ` / ${(total / 1048576).toFixed(0)} MB` : ''}   `);
  }
  ctl.enqueue(chunk);
}});
await pipeline(Readable.fromWeb(res.body.pipeThrough(counter)), createWriteStream(part));
process.stdout.write('\n');
const actual = await md5Of(part);
if (actual !== expected) { rmSync(part, {force: true}); console.error(`MD5 mismatch (expected ${expected}, got ${actual}); file deleted`); process.exit(1); }
renameSync(part, target);
console.log(`OK: ${target} (${(statSync(target).size / 1048576).toFixed(1)} MB, MD5 verified)`);

// Region boundary: lets the exporter refuse tiles near the border whose neighbour data is not in the extract.
const polyRes = await fetch(`https://download.geofabrik.de/${region}.poly`, {headers: UA});
if (polyRes.ok) {
  const polyPath = join(dir, `${name}.poly`);
  const text = await polyRes.text();
  const {writeFileSync} = await import('node:fs');
  writeFileSync(polyPath, text);
  console.log(`OK: ${polyPath} (region boundary)`);
} else {
  console.warn(`WARNING: boundary file not available (HTTP ${polyRes.status}); border tiles will rely on the extract bbox only`);
}
