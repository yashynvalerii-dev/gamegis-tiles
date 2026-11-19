#!/usr/bin/env node
/**
 * Gets the regional extracts (.osm.pbf) and boundaries (.poly) a build needs — politely (owner 2026-11-18).
 * Main source: download.geofabrik.de. Fallbacks, strictly one after another and only after a refusal: our own copy
 * (≤ 30 days), Movisda, geo2day, openstreetmap.fr. Every request is counted in a journal with limits and pauses
 * (src/sources/politeSources.js); the order and the cache rules are in src/sources/extractFetcher.js.
 *
 *   npm.cmd run download-extract                                          Thuringia (default)
 *   npm.cmd run download-extract -- --region europe/ukraine               one extract + its .poly
 *   npm.cmd run download-extract -- --config regions.json                 every extract and publish boundary in the config
 *   options: --ledger source-usage.json   the journal (kept in memory without it)
 *            --cache-days N               use our copy without any request when it is younger than N days
 *            --prune                      drop extracts no region uses (full builds)
 */
import {readdirSync, mkdirSync, rmSync, readFileSync, existsSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openLedger} from '../src/sources/politeSources.js';
import {fetchExtract, fetchPublishPoly} from '../src/sources/extractFetcher.js';
import {fetchOverpassArea} from '../src/sources/overpassArea.js';
export {idleAbort} from '../src/sources/extractFetcher.js';

const projectDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dir = join(projectDir, 'data', 'extracts');
const valid = r => /^[a-z-]+(\/[a-z-]+){0,3}$/.test(r ?? '');
const lastPart = p => p.split('/').pop();
/** openstreetmap.fr names use underscores: europe/germany/nordrhein-westfalen -> europe/germany/nordrhein_westfalen. */
export const osmfrPath = region => region.replaceAll('-', '_');

export function plan(args) {
  const extracts = new Set(), polys = new Set(), areas = [];
  let prune = false, ledger = null, cacheDays = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--prune') prune = true;
    else if (args[i] === '--ledger') ledger = args[++i];
    else if (args[i] === '--cache-days') cacheDays = Number(args[++i]);
    else if (args[i] === '--region') { extracts.add(args[++i]); polys.add(args[i]); }
    else if (args[i] === '--config') {
      const path = resolve(args[++i]);
      if (!existsSync(path)) continue;   // optional configs (requested-regions.json) may not exist yet
      const config = JSON.parse(readFileSync(path, 'utf8'));
      for (const r of [...(config.regions ?? []), ...(config.precise ?? [])]) {
        extracts.add(r.extract); polys.add(r.extract);
        areas.push({id: r.id, extract: r.extract, requested: Boolean(r.addedOn), publish: r.publish});
        if (r.publish?.poly) polys.add(r.publish.poly);
      }
      for (const f of config.full ?? []) { extracts.add(f.extract); polys.add(f.extract); }   // full-map areas: their region's extract
    } else throw new Error(`Unknown argument ${args[i]}`);
  }
  if (!extracts.size) { extracts.add('europe/germany/thueringen'); polys.add('europe/germany/thueringen'); }
  for (const r of [...extracts, ...polys]) if (!valid(r)) throw new Error(`Invalid region path: ${r}`);
  if (!Number.isFinite(cacheDays) || cacheDays < 0) throw new Error('--cache-days must be a number >= 0');
  return {extracts: [...extracts], polys: [...polys], prune, ledger, cacheDays, areas};
}

/** Extract files in dir that no configured region uses (e.g. Germany after Thuringia got its own extract). */
export function staleExtracts(files, extracts, areaIds = null) {
  const keep = new Set([...extracts.map(r => `${lastPart(r)}-latest.osm.pbf`), ...(areaIds ?? []).map(id => `ovp-${id}-latest.osm.pbf`)]);
  return files.filter(f => /\.osm\.pbf(\.part)?$/.test(f) && !keep.has(f) && !(areaIds === null && /^ovp-/.test(f)));
}

/** Gets everything in the plan; returns a summary per region. Always saves the journal. */
export async function run({extracts, polys, prune, ledger: ledgerPath, cacheDays, areas = []}, {fetchImpl = fetch, extractsDir = dir, log = console.log,
  warn = m => console.log(`::warning::${m}`), sleep = undefined} = {}) {
  mkdirSync(extractsDir, {recursive: true});
  const ledger = openLedger(ledgerPath);
  const results = [];
  try {
    if (prune) for (const f of staleExtracts(readdirSync(extractsDir), extracts, areas.map(a => a.id))) { rmSync(join(extractsDir, f), {force: true}); log(`Removed unused extract ${f}`); }
    for (const r of extracts) {
      try { results.push(await fetchExtract(r, {ledger, dir: extractsDir, fetchImpl, cacheDays, log, warn, sleep})); continue; } catch (e) {
        // Only NEW requested areas (circles) may fall back to one Overpass query each; permanent regions fail loudly.
        const users = areas.filter(a => a.extract === r);
        if (!users.length || !users.every(a => a.requested && a.publish?.circle)) throw e;
        warn(e.message);
        for (const a of users) {
          if (existsSync(join(extractsDir, `ovp-${a.id}-latest.osm.pbf`))) { log(`OK: ovp-${a.id} from our copy (no request)`); results.push({name: `ovp-${a.id}`, source: 'cache'}); continue; }
          try { await fetchOverpassArea(a, {ledger, dir: extractsDir, fetchImpl, log}); results.push({name: `ovp-${a.id}`, source: 'overpass-eu'}); }
          catch (e2) { warn(`${a.id}: Overpass Europe unavailable too (${e2.message}) — area skipped this time`); results.push({name: a.id, source: 'none'}); }
        }
      }
    }
    const own = new Set(extracts.map(lastPart));
    for (const p of polys) if (!own.has(lastPart(p))) await fetchPublishPoly(p, {ledger, dir: extractsDir, fetchImpl, log});
  } finally { ledger.save(); }
  const used = Object.entries(ledger.data.sources).map(([id, s]) => {
    const t = s.days[new Date().toISOString().slice(0, 10)] ?? {};
    return `${id}: ${t.requests ?? 0} requests, ${((t.bytes ?? 0) / 1048576).toFixed(1)} MB today${s.pausedUntil && s.pausedUntil > new Date().toISOString() ? `, paused until ${s.pausedUntil}` : ''}`;
  });
  log(`Sources: ${used.join('; ') || 'no requests'}`);
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(plan(process.argv.slice(2))).then(
    results => { for (const r of results) console.log(`  ${r.name}: ${r.source}${r.note ? ` (${r.note})` : ''}`); },
    e => { console.error('FAILED:', e.message); process.exitCode = 1; });
}
