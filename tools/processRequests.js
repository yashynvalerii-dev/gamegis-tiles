#!/usr/bin/env node
/**
 * Reads region requests submitted by games (published form-responses CSV), plans new regions and writes
 * requested-regions.json. Runs in GitHub Actions of the tiles repository (network: the CSV URL,
 * the tiles site manifest and download.geofabrik.de/index-v1.json).
 *
 *   node tools/processRequests.js [--config regions.json] [--out requested-regions.json]
 * Prints a JSON summary; writes "changed=true|false" to $GITHUB_OUTPUT when available.
 */
import {readFileSync, writeFileSync, existsSync, appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readRequests, planDemand, planPrecise} from '../src/requests/regionRequests.js';
import {tileFor} from '../src/client/gamegis-client.js';

const pick = (o, keys) => Object.fromEntries(keys.filter(k => Number.isFinite(o[k])).map(k => [k, o[k]]));
const UA = {'user-agent': 'GameGIS-Broker/0.1 region-requests'};

/**
 * The responses CSV link is private (it reveals coarse player locations and times): it comes from the
 * REQUESTS_CSV_URL secret of the tiles repository, never from the public regions.json.
 */
export async function processRequests({configPath = 'regions.json', outPath = 'requested-regions.json', fetchImpl = fetch,
  now = new Date(), csvUrl = process.env.REQUESTS_CSV_URL, siteUrl = process.env.TILES_SITE_URL,
  apps = (process.env.REQUESTS_APPS ?? '').split(',').map(x => x.trim()).filter(Boolean)} = {}) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const s = config.regionRequests ?? {};
  if (!csvUrl) return {configured: false, changed: false, note: 'REQUESTS_CSV_URL secret is not set'};
  const requested = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : {regions: []};
  requested.precise ??= [];

  const get = async (url, kind) => {
    const res = await fetchImpl(url, {headers: UA, cache: 'no-store'});
    if (!res.ok) throw new Error(`${kind} unavailable: HTTP ${res.status}`);
    return res;
  };
  const csv = await (await get(csvUrl, 'requests CSV')).text();
  const {requests, rejected} = readRequests(csv, {columns: s.columns, apps});

  let bundles = {}, report = null;
  const site = siteUrl ?? s.siteUrl;
  if (site) {
    bundles = (await (await get(new URL('manifest.json', site).href, 'manifest')).json()).bundles ?? {};
    try { report = await (await get(new URL('export-report.json', site).href, 'export report')).json(); } catch { report = null; }
  }
  const isPublished = p => { const t = tileFor(p.lat, p.lon, 13); return Boolean(bundles[`13/${t.x}/${t.y}`]); };
  const sizesMB = Object.fromEntries((report?.regions ?? []).map(r => [r.id, (r.storedBytes ?? 0) / 1048576]));
  const pinnedMB = config.regions.reduce((a, r) => a + (sizesMB[r.id] ?? 0), 0);

  const index = await (await get('https://download.geofabrik.de/index-v1.json', 'Geofabrik index')).json();
  const {regions, changes} = planDemand(requests, config.regions, requested.regions, index, {
    maxNewPerRun: s.maxNewPerRun ?? 2, maxTotalRegions: s.maxTotalRegions ?? 15, budgetMB: s.budgetMB ?? 700,
    sizesMB, pinnedMB, isPublished, now, ...pick(s, ['windowDays', 'activityDays', 'minRadiusKm', 'maxRadiusKm', 'marginKm', 'reachKm'])});
  // Base areas first; precise copies get only the space left (they are evicted first).
  const est = r => sizesMB[r.id] ?? 0.02 * r.publish.circle.radiusKm ** 2;
  const baseMB = pinnedMB + regions.reduce((a, r) => a + est(r), 0);
  const {precise, changes: preciseChanges} = planPrecise(requests, requested.precise, index, {baseMB, budgetMB: s.budgetMB ?? 700, sizesMB, now});
  const changed = JSON.stringify(regions) !== JSON.stringify(requested.regions) || JSON.stringify(precise) !== JSON.stringify(requested.precise);
  if (changed) writeFileSync(outPath, JSON.stringify({regions, precise, updatedAt: now.toISOString()}, null, 2) + '\n');
  return {configured: true, changed, requests: requests.length, rejected, ...changes,
    regions: regions.map(r => ({id: r.id, radiusKm: r.publish.circle.radiusKm, rating: r.rating, extract: r.extract})),
    precise: precise.map(r => ({id: r.id, radiusKm: r.publish.circle.radiusKm, precision: r.precision})), preciseChanges};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), opt = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  processRequests({configPath: opt('--config') ?? 'regions.json', outPath: opt('--out') ?? 'requested-regions.json'}).then(r => {
    console.log(JSON.stringify(r, null, 2));
    console.log(`::notice::requests ${r.requests ?? 0}, rejected ${r.rejected ?? 0}, added ${(r.added ?? []).length}, resized ${(r.resized ?? []).length}, changed ${r.changed}${r.configured === false ? ' (not configured)' : ''}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${r.changed}\n`);
  }, e => {
    // GitHub shows "::error::" lines as annotations, readable without the full log; never print the CSV URL.
    const msg = String(e?.message ?? e).replace(/https?:\/\/\S+/g, '<url>');
    console.error(`::error::processRequests failed: ${msg}${e?.cause ? ` (cause: ${String(e.cause.message ?? e.cause).replace(/https?:\/\/\S+/g, '<url>')})` : ''}`);
    process.exitCode = 1;
  });
}
