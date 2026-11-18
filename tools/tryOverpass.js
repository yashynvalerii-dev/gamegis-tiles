#!/usr/bin/env node
/**
 * Manual check of the last-resort path for a new area: ONE Overpass Europe query for the core of an area, then a local
 * export of that area (nothing is published). Counted in the polite journal.
 *   node tools/tryOverpass.js <lat> <lon> <radiusKm> --ledger source-usage.json
 */
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openLedger} from '../src/sources/politeSources.js';
import {fetchOverpassArea} from '../src/sources/overpassArea.js';
import {runConfig} from './exportTiles.js';

const [lat, lon, radiusKm] = process.argv.slice(2, 5).map(Number);
const i = process.argv.indexOf('--ledger'), ledger = openLedger(i > 0 ? process.argv[i + 1] : null);
const dir = mkdtempSync(join(tmpdir(), 'ovp-try-'));
try {
  const def = {id: 'req-trial', name: 'Overpass trial', extract: 'europe/none', addedOn: new Date().toISOString().slice(0, 10),
    publish: {circle: {lat, lon, radiusKm}}};
  const t = Date.now();
  const r = await fetchOverpassArea(def, {ledger, dir: join(dir, 'ex')});
  const seconds = (Date.now() - t) / 1000;
  writeFileSync(join(dir, 'empty.json'), JSON.stringify({regions: []}));
  writeFileSync(join(dir, 'req.json'), JSON.stringify({regions: [def]}));
  const rep = runConfig({configPaths: [join(dir, 'empty.json'), join(dir, 'req.json')], outDir: join(dir, 'site'), extractsDir: join(dir, 'ex'), bundleZoom: 13}, {log: () => {}});
  const st = rep.regions[0];
  console.log(`::notice::Overpass Europe trial: ${seconds.toFixed(1)} s, ${(r.bytes / 1048576).toFixed(1)} MB, ${r.elements} elements; ` +
    `tiles READY ${st.tiles.READY}, INCOMPLETE ${st.tiles.INCOMPLETE} ${JSON.stringify(st.incompleteReasons)}, stored ${((st.storedBytes ?? 0) / 1048576).toFixed(1)} MB`);
} catch (e) { console.log(`::error::Overpass Europe trial: ${e.message}`); process.exitCode = 1; }
finally { ledger.save(); rmSync(dir, {recursive: true, force: true}); }
