#!/usr/bin/env node
/**
 * Exports a whole region from a local extract into static tile bundles + manifest (no network).
 *
 * Usage: npm.cmd run export-tiles [-- --pbf <file> --poly <file> --out <dir> --bundle-zoom 13]
 * Defaults: data\extracts\thueringen-latest.osm.pbf, its .poly next to it, output data\tiles
 */
import {existsSync, rmSync, mkdirSync, writeFileSync} from 'node:fs';
import {join, resolve, dirname, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadRegionModel, exportRegion} from '../src/export/regionExporter.js';
import {readPoly} from '../src/providers/polyFile.js';

const projectDir = resolve(fileURLToPath(new URL('..', import.meta.url)));

export function parseArgs(argv) {
  const o = {pbfPath: join(projectDir, 'data', 'extracts', 'thueringen-latest.osm.pbf'),
    outDir: join(projectDir, 'data', 'tiles'), bundleZoom: 13};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const v = () => { const x = argv[++i]; if (x === undefined) throw new Error(`Missing value for ${a}`); return x; };
    if (a === '--pbf') o.pbfPath = resolve(v());
    else if (a === '--poly') o.polyPath = resolve(v());
    else if (a === '--out') o.outDir = resolve(v());
    else if (a === '--bundle-zoom') o.bundleZoom = Number(v());
    else throw new Error(`Unknown argument ${a}`);
  }
  o.polyPath ??= join(dirname(o.pbfPath), basename(o.pbfPath).replace(/-latest\.osm\.pbf$/, '') + '.poly');
  return o;
}

export function runExport(o, {log = console.log} = {}) {
  if (!existsSync(o.pbfPath)) throw new Error(`Extract not found: ${o.pbfPath} (run: npm.cmd run download-extract)`);
  const boundary = existsSync(o.polyPath) ? readPoly(o.polyPath) : null;
  log(boundary ? `Region boundary: ${o.polyPath}` : 'WARNING: no .poly boundary file; using extract bbox (border tiles may be wrongly certified)');
  rmSync(o.outDir, {recursive: true, force: true}); mkdirSync(o.outDir, {recursive: true});
  const t0 = Date.now();
  const model = loadRegionModel(o.pbfPath, {onProgress: m => log('  ' + m)});
  log(`Loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${JSON.stringify(model.stats)}`);
  const {stats} = exportRegion({model, outDir: o.outDir, boundary, bundleZoom: o.bundleZoom, onProgress: m => log('  ' + m)});
  const mb = b => (b / 1048576).toFixed(1) + ' MB';
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
