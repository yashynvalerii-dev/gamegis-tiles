#!/usr/bin/env node
/**
 * Exports static tile bundles + manifest (no network).
 *
 *   npm.cmd run export-tiles -- --config regions.json [--out data\tiles]        several regions into one site
 *   npm.cmd run export-tiles [-- --pbf <file> --poly <file> --out <dir>]        one whole extract (legacy)
 *
 * Extracts and .poly files are expected in data/extracts (see npm run download-extract).
 */
import {existsSync, rmSync, mkdirSync, writeFileSync, readFileSync} from 'node:fs';
import {join, resolve, dirname, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {loadRegionModel, exportRegion, circleRegion, mergeManifests} from '../src/export/regionExporter.js';
import {readPoly} from '../src/providers/polyFile.js';

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

export function runConfig(o, {log = console.log} = {}) {
  // Several configs (e.g. regions.json + requested-regions.json) are merged; settings come from the first.
  const configs = (o.configPaths ?? [o.configPath]).filter(p => existsSync(p)).map(p => JSON.parse(readFileSync(p, 'utf8')));
  const config = {...configs[0], regions: configs.flatMap(c => c.regions ?? [])};
  rmSync(o.outDir, {recursive: true, force: true}); mkdirSync(o.outDir, {recursive: true});
  const t0 = Date.now(), parts = [], regionStats = [];
  for (const r of config.regions) {
    const name = lastPart(r.extract);
    const pbf = join(o.extractsDir, `${name}-latest.osm.pbf`);
    if (!existsSync(pbf)) throw new Error(`Extract for ${r.id} not found: ${pbf}`);
    const extractPoly = join(o.extractsDir, `${name}.poly`);
    const boundary = existsSync(extractPoly) ? readPoly(extractPoly) : null;
    if (!boundary) log(`WARNING ${r.id}: no ${name}.poly; completeness relies on the extract bbox`);
    const publish = r.publish?.circle ? circleRegion(r.publish.circle)
      : r.publish?.poly ? readPoly(join(o.extractsDir, `${lastPart(r.publish.poly)}.poly`)) : null;
    // Only part of the extract is published: read just that area plus a margin for edge features.
    const aoi = publish ? grow(publish.bbox, 3) : null;
    log(`== ${r.id} (${r.name}) from ${name}${aoi ? ', area of interest only' : ''}`);
    const t = Date.now();
    const model = loadRegionModel(pbf, {aoi, onProgress: m => log('  ' + m)});
    const {manifest, stats} = exportRegion({model, outDir: o.outDir, boundary, publish, bundleZoom: o.bundleZoom,
      writeManifest: false, onProgress: m => log('  ' + m)});
    parts.push({id: r.id, name: r.name, manifest});
    regionStats.push({id: r.id, seconds: (Date.now() - t) / 1000, ...stats, loadStats: model.stats});
    log(`  ${r.id}: bundles ${stats.bundles}, stored ${mb(stats.storedBytes ?? 0)}, READY ${stats.tiles.READY}, ` +
      `INCOMPLETE ${stats.tiles.INCOMPLETE} ${JSON.stringify(stats.incompleteReasons)} (${((Date.now() - t) / 1000).toFixed(0)} s)`);
  }
  const manifest = mergeManifests(parts);
  if (config.regionRequests?.formUrl && Object.values(config.regionRequests.fields ?? {}).every(Boolean)) {
    const {formUrl, fields} = config.regionRequests;
    manifest.regionRequests = {type: 'google-form', url: formUrl, fields};  // public: lets clients ask for new regions
  }
  const bytes = Buffer.from(JSON.stringify(manifest), 'utf8');
  writeFileSync(join(o.outDir, 'manifest.json'), bytes);
  const report = {regions: regionStats, bundles: Object.keys(manifest.bundles).length,
    storedBytes: regionStats.reduce((a, r) => a + (r.storedBytes ?? 0), 0) + bytes.length, manifestBytes: bytes.length,
    manifestGzipBytes: gzipSync(bytes).length, totalSeconds: (Date.now() - t0) / 1000,
    maxRssMB: Math.round(process.resourceUsage().maxRSS / 1024)};
  writeFileSync(join(o.outDir, 'export-report.json'), JSON.stringify(report, null, 2));
  log(`Done: ${report.bundles} bundles, stored ${mb(report.storedBytes)}, ${report.totalSeconds.toFixed(0)} s, peak ${report.maxRssMB} MB`);
  return report;
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
  try { runExport(o); } catch (e) { console.error('FAILED:', e.message); process.exitCode = 1; }
}
