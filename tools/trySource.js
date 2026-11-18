#!/usr/bin/env node
/**
 * Manual check that a fallback source really delivers a usable extract (owner 2026-11-18: try before relying on it).
 * One small region, through the polite journal, into a scratch folder; then the extract is read fully.
 *   node tools/trySource.js <source> <region> --ledger source-usage.json      e.g. movisda europe/germany/bremen
 */
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openLedger} from '../src/sources/politeSources.js';
import {trySource} from '../src/sources/extractFetcher.js';
import {scanPbf} from '../src/providers/pbfReader.js';
import {readPoly} from '../src/providers/polyFile.js';

const [id, region] = process.argv.slice(2);
const i = process.argv.indexOf('--ledger'), ledger = openLedger(i > 0 ? process.argv[i + 1] : null);
const dir = mkdtempSync(join(tmpdir(), 'try-'));
try {
  const r = await trySource(id, region, {ledger, dir});
  const name = region.split('/').pop();
  let nodes = 0, ways = 0, relations = 0;
  const h = scanPbf(join(dir, `${name}-latest.osm.pbf`), {node() { nodes++; }, way() { ways++; }, relation() { relations++; }});
  const poly = readPoly(join(dir, `${name}.poly`));
  console.log(`::notice::${id} ${region}: ${(r.bytes / 1048576).toFixed(1)} MB, data ${new Date(h.replicationTimestamp * 1000).toISOString()}, ` +
    `${nodes} nodes, ${ways} ways, ${relations} relations, boundary ${JSON.stringify(poly.bbox)}`);
} catch (e) { console.log(`::error::${id} ${region}: ${e.message}`); process.exitCode = 1; }
finally { ledger.save(); rmSync(dir, {recursive: true, force: true}); }
