#!/usr/bin/env node
/**
 * Exports static tile bundles + manifest (no network).
 *
 *   npm.cmd run export-tiles -- --config regions.json [--out data\tiles]        several regions into one site
 *   npm.cmd run export-tiles [-- --pbf <file> --poly <file> --out <dir>]        one whole extract (legacy)
 *   ... --config ... --incremental <site URL> [--plan-out rebuild.json]        reuse unchanged regions from the site
 *
 * Extracts and .poly files are expected in data/extracts (see npm run download-extract).
 */
import {existsSync, rmSync, mkdirSync, writeFileSync, readFileSync, appendFileSync} from 'node:fs';
import {join, resolve, dirname, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {loadRegionModel, exportRegion, circleRegion, mergeManifests, bundleAlignedRegion, mergePreciseLayers} from '../src/export/regionExporter.js';
import {readPoly} from '../src/providers/polyFile.js';
import {planIncremental, copyReusedRegions, regionFingerprint} from '../src/export/incremental.js';

const projectDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EXTRACTS = join(projectDir, 'data', 'extracts');
const lastPart = p => p.split('/').pop();

export function parseArgs(argv) {
  const o = {pbfPath: join(EXTRACTS, 'thueringen-latest.osm.pbf'), outDir: join(projectDir, 'data', 'tiles'), bundleZoom: 13};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const v = () => { const x = argv[++i]; if (x === undefined) throw new Error(`Missing value for ${a}`); return x; };
    if (a === '--pbf') o.pbfPath = resolve(v());
    else if (a === '--poly') o.polyPath = resolve(v());
    else if (a === '--out') o.outDir = resolve(v());
    else if (a === '--config') (o.configPaths ??= []).push(resolve(v()));
    else if (a === '--extracts') o.extractsDir = resolve(v());
    else if (a === '--bundle-zoom') o.bundleZoom = Number(v());
    else if (a === '--incremental') o.incremental = v();   // published site URL: reuse unchanged regions from it
    else if (a === '--plan-out') o.planOut = resolve(v()); // incremental: only write the config of regions to rebuild
    else throw new Error(`Unknown argument ${a}`);
  }
  o.polyPath ??= join(dirname(o.pbfPath), basename(o.pbfPath).replace(/-latest\.osm\.pbf$/, '') + '.poly');
  o.extractsDir ??= EXTRACTS;
  return o;
}

const mb = b => (b / 1048576).toFixed(1) + ' MB';

/** Expands a bbox by km on every side. */
function grow(b, km) {
  const dLat = km / 111.32, dLon = km / (111.32 * Math.cos((b.south + b.north) / 2 * Math.PI / 180));
  return {south: b.south - dLat, north: b.north + dLat, west: b.west - dLon, east: b.east + dLon};
}

function loadConfig(o) {
  // Several configs (e.g. regions.json + requested-regions.json) are merged; settings come from the first.
  const configs = (o.configPaths ?? [o.configPath]).filter(p => existsSync(p)).map(p => JSON.parse(readFileSync(p, 'utf8')));
  return {...configs[0], regions: configs.flatMap(c => c.regions ?? []), precise: configs.flatMap(c => c.precise ?? [])};
}
const defsOf = config => [...config.regions.map(def => ({def, kind: 'base'})), ...config.precise.map(def => ({def, kind: 'precise'}))];
const fpOf = ({def, kind}, o) => regionFingerprint(def, {kind, bundleZoom: o.bundleZoom, bufferM: 40});

/** Exports one region (base or precise layer) from its local extract. Returns {part, stat}. */
function buildRegion({def: r, kind}, o, log) {
  const name = lastPart(r.extract);
  const pbf = join(o.extractsDir, `${name}-latest.osm.pbf`);
  if (!existsSync(pbf)) {
    if (kind === 'precise') { log(`WARNING precise ${r.id}: extract ${name} missing, skipped`); return null; }
    throw new Error(`Extract for ${r.id} not found: ${pbf}`);
  }
  const extractPoly = join(o.extractsDir, `${name}.poly`);
  const boundary = existsSync(extractPoly) ? readPoly(extractPoly) : null;
  const t = Date.now();
  if (kind === 'precise') {
    const publish = bundleAlignedRegion(r.publish.circle, o.bundleZoom);
    log(`== precise ${r.id} (${r.precision} decimals) from ${name}`);
    const model = loadRegionModel(pbf, {aoi: grow(publish.bbox, 3), onProgress: m => log('  ' + m)});
    const {manifest, stats} = exportRegion({model, outDir: o.outDir, boundary, publish, bundleZoom: o.bundleZoom,
      writeManifest: false, coordDecimals: r.precision, bundlesDir: `bundles-p${r.precision}`, onProgress: m => log('  ' + m)});
    log(`  ${r.id}: bundles ${stats.bundles}, stored ${mb(stats.storedBytes ?? 0)} (${((Date.now() - t) / 1000).toFixed(0)} s)`);
    return {part: {id: r.id, precision: r.precision, manifest, circle: r.publish.circle},
      stat: {id: r.id, kind: 'precise', precision: r.precision, seconds: (Date.now() - t) / 1000, ...stats,
        fingerprint: fpOf({def: r, kind}, o), bundleKeys: Object.keys(manifest.bundles)}};
  }
  if (!boundary) log(`WARNING ${r.id}: no ${name}.poly; completeness relies on the extract bbox`);
  const publish = r.publish?.circle ? circleRegion(r.publish.circle)
    : r.publish?.poly ? readPoly(join(o.extractsDir, `${lastPart(r.publish.poly)}.poly`)) : null;
  // Only part of the extract is published: read just that area plus a margin for edge features.
  const aoi = publish ? grow(publish.bbox, 3) : null;
  log(`== ${r.id} (${r.name}) from ${name}${aoi ? ', area of interest only' : ''}`);
  const model = loadRegionModel(pbf, {aoi, onProgress: m => log('  ' + m)});
  const {manifest, stats} = exportRegion({model, outDir: o.outDir, boundary, publish, bundleZoom: o.bundleZoom,
    writeManifest: false, onProgress: m => log('  ' + m)});
  log(`  ${r.id}: bundles ${stats.bundles}, stored ${mb(stats.storedBytes ?? 0)}, READY ${stats.tiles.READY}, ` +
    `INCOMPLETE ${stats.tiles.INCOMPLETE} ${JSON.stringify(stats.incompleteReasons)} (${((Date.now() - t) / 1000).toFixed(0)} s)`);
  const kindName = r.addedOn ? 'requested' : 'pinned';
  return {part: {id: r.id, name: r.name, manifest, kind: kindName, circle: r.publish?.circle ?? null},
    stat: {id: r.id, kind: kindName, seconds: (Date.now() - t) / 1000, ...stats, loadStats: model.stats,
      fingerprint: fpOf({def: r, kind}, o), bundleKeys: Object.keys(manifest.bundles)}};
}

/** Writes manifest.json + export-report.json for the given parts (config order). */
function finish(o, config, parts, preciseParts, regionStats, t0, log, extra = {}) {
  const manifest = mergeManifests(parts);
  if (preciseParts.length) manifest.precise = mergePreciseLayers(preciseParts);
  // Public copies of this site, primary first (TILES_SITE_URL comes from the workflow, extra ones from the config).
  const mirrorList = [process.env.TILES_SITE_URL, ...(config.mirrors ?? [])].filter(u => typeof u === 'string' && /^https:\/\/\S+\/$/.test(u));
  if (mirrorList.length) manifest.mirrors = [...new Set(mirrorList)];
  if (config.regionRequests?.endpoint) {
    // public: where clients send region requests and activity (contract v1, see gamegis-client.js)
    manifest.regionRequests = {type: 'endpoint', version: 1, url: config.regionRequests.endpoint};
  }
  const bytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  writeFileSync(join(o.outDir, 'manifest.json'), bytes);
  const report = {regions: regionStats, bundles: Object.keys(manifest.bundles).length,
    storedBytes: regionStats.reduce((a, r) => a + (r.storedBytes ?? 0), 0) + bytes.length, manifestBytes: bytes.length,
    manifestGzipBytes: gzipSync(bytes).length, totalSeconds: (Date.now() - t0) / 1000,
    maxRssMB: Math.round(process.resourceUsage().maxRSS / 1024), ...extra};
  writeFileSync(join(o.outDir, 'export-report.json'), JSON.stringify(report, null, 2));
  log(`Done: ${report.bundles} bundles, stored ${mb(report.storedBytes)}, ${report.totalSeconds.toFixed(0)} s, peak ${report.maxRssMB} MB`);
  return report;
}

/** Full build: every region from its local extract. */
export function runConfig(o, {log = console.log} = {}) {
  const config = loadConfig(o);
  rmSync(o.outDir, {recursive: true, force: true}); mkdirSync(o.outDir, {recursive: true});
  const t0 = Date.now(), parts = [], preciseParts = [], regionStats = [];
  for (const d of defsOf(config)) {
    const built = buildRegion(d, o, log);
    if (!built) continue;
    (d.kind === 'precise' ? preciseParts : parts).push(built.part);
    regionStats.push(built.stat);
  }
  return finish(o, config, parts, preciseParts, regionStats, t0, log, {mode: 'full'});
}

/** Reads the published manifest + export report (null when unavailable: then everything is rebuilt). */
async function published(baseUrl, fetchImpl) {
  const get = async f => { const r = await fetchImpl(new URL(`${f}?t=${Date.now()}`, baseUrl).href, {cache: 'no-store'}); if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`); return r.json(); };
  try { return await Promise.all([get('manifest.json'), get('export-report.json')]); } catch { return [null, null]; }
}

/**
 * Incremental build (o.incremental = published site URL). With o.planOut only plans: writes the config of the regions
 * to rebuild (for download-extract) and returns. Otherwise copies unchanged regions from the published site and builds
 * the rest from local extracts.
 */
export async function runIncremental(o, {log = console.log, fetchImpl = fetch} = {}) {
  const config = loadConfig(o);
  const defs = defsOf(config);
  const [prevManifest, prevReport] = await published(o.incremental, fetchImpl);
  const plan = planIncremental(defs, prevReport, prevManifest, {bundleZoom: o.bundleZoom, bufferM: 40});
  log(`Incremental plan: reuse ${plan.reuse.length} (${plan.reuse.map(x => x.def.id).join(', ') || '-'}), ` +
    `rebuild ${plan.rebuild.length} (${plan.rebuild.map(x => `${x.def.id}:${x.reason}`).join(', ') || '-'})`);
  if (o.planOut) {
    writeFileSync(o.planOut, JSON.stringify({regions: plan.rebuild.filter(x => x.kind === 'base').map(x => x.def),
      precise: plan.rebuild.filter(x => x.kind === 'precise').map(x => x.def)}, null, 2) + '\n');
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `rebuild=${plan.rebuild.length}\nreuse=${plan.reuse.length}\n`);
    return {reuse: plan.reuse.map(x => x.def.id), rebuild: plan.rebuild.map(x => ({id: x.def.id, reason: x.reason}))};
  }
  rmSync(o.outDir, {recursive: true, force: true}); mkdirSync(o.outDir, {recursive: true});
  const t0 = Date.now();
  const reused = await copyReusedRegions(plan.reuse, prevManifest, {baseUrl: o.incremental, outDir: o.outDir, fetchImpl, log});
  const byKey = new Map(reused.map(r => [`${r.kind}:${r.def.id}`, r]));
  const parts = [], preciseParts = [], regionStats = [];
  for (const d of defs) {
    const r = byKey.get(`${d.kind}:${d.def.id}`);
    if (r) {
      if (d.kind === 'precise') preciseParts.push({id: d.def.id, precision: d.def.precision, manifest: r.manifest, circle: d.def.publish.circle});
      else parts.push({id: d.def.id, name: d.def.name, manifest: r.manifest, kind: d.def.addedOn ? 'requested' : 'pinned', circle: d.def.publish?.circle ?? null});
      regionStats.push({...r.entry, seconds: 0, reused: true});
      log(`== ${d.def.id}: unchanged, reused (${r.entry.bundleKeys.length} bundles)`);
      continue;
    }
    const built = buildRegion(d, o, log);
    if (!built) continue;
    (d.kind === 'precise' ? preciseParts : parts).push(built.part);
    regionStats.push(built.stat);
  }
  return finish(o, config, parts, preciseParts, regionStats, t0, log,
    {mode: 'incremental', reused: plan.reuse.map(x => x.def.id), rebuilt: plan.rebuild.map(x => ({id: x.def.id, reason: x.reason}))});
}

export function runExport(o, {log = console.log} = {}) {
  if (o.configPath || o.configPaths) return runConfig(o, {log});
  if (!existsSync(o.pbfPath)) throw new Error(`Extract not found: ${o.pbfPath} (run: npm.cmd run download-extract)`);
  const boundary = existsSync(o.polyPath) ? readPoly(o.polyPath) : null;
  log(boundary ? `Region boundary: ${o.polyPath}` : 'WARNING: no .poly boundary file; using extract bbox (border tiles may be wrongly certified)');
  rmSync(o.outDir, {recursive: true, force: true}); mkdirSync(o.outDir, {recursive: true});
  const t0 = Date.now();
  const model = loadRegionModel(o.pbfPath, {onProgress: m => log('  ' + m)});
  log(`Loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${JSON.stringify(model.stats)}`);
  const {stats} = exportRegion({model, outDir: o.outDir, boundary, bundleZoom: o.bundleZoom, onProgress: m => log('  ' + m)});
  const report = {...stats, loadStats: model.stats, totalSeconds: (Date.now() - t0) / 1000,
    maxRssMB: Math.round(process.resourceUsage().maxRSS / 1024), outDir: o.outDir, bundleZoom: o.bundleZoom};
  log(`Export done in ${report.totalSeconds.toFixed(1)} s, peak memory ${report.maxRssMB} MB`);
  log(`Files: ${stats.files} (bundles ${stats.bundles}); stored ${mb(stats.storedBytes)}; content ${mb(stats.bytes)} raw / ${mb(stats.gzipBytes)} gzip; ` +
    `largest bundle ${mb(stats.maxBundleBytes)} raw / ${mb(stats.maxBundleGzipBytes)} gzip; manifest ${mb(stats.manifestBytes)}`);
  log(`Tiles: READY ${stats.tiles.READY}, INCOMPLETE ${stats.tiles.INCOMPLETE} ${JSON.stringify(stats.incompleteReasons)}; features ${stats.features}`);
  writeFileSync(join(o.outDir, 'export-report.json'), JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let o;
  try { o = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  const run = o.incremental ? runIncremental(o) : Promise.resolve().then(() => runExport(o));
  run.catch(e => { console.error('FAILED:', e.message); process.exitCode = 1; });
}
