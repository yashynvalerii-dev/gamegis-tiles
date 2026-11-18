/**
 * Last resort for a NEW requested area when no regional extract can be had (owner 2026-11-18): one polite query to
 * Overpass Europe (ovp.dresel.systems) for the core of the area, stored as data/extracts/ovp-<regionId>-latest.osm.pbf
 * with its boundary ovp-<regionId>.poly (the queried box). It is never mistaken for a whole-region copy.
 * - one query per area, through the journal (20 queries / 50 MB per day), [timeout:25];
 * - only the core: radius capped at OVERPASS_MAX_RADIUS_KM (+ margin so edge tiles are complete); tiles outside stay
 *   INCOMPLETE until a regular extract is available again (the next full build rebuilds from the extract);
 * - an answer with a runtime-error remark (timeout, memory) is incomplete and never used.
 */
import {writeFileSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {politeFetch, LIMITS} from './politeSources.js';
import {overpassClauses} from '../providers/overpassProvider.js';
import {writePbf} from '../providers/pbfWriter.js';

export const OVERPASS_EU = 'https://ovp.dresel.systems/api/interpreter';
export const OVERPASS_MAX_RADIUS_KM = 1.5;
const EDGE_MARGIN_KM = 0.8;   // a z15 tile (~0.6 km) + its 40 m buffer at the edge of the circle stays inside the box

/** Box queried for an area circle {lat, lon, radiusKm}. */
export function areaBox({lat, lon, radiusKm}) {
  const r = Math.min(radiusKm, OVERPASS_MAX_RADIUS_KM) + EDGE_MARGIN_KM;
  const dLat = r / 111.32, dLon = r / (111.32 * Math.cos(lat * Math.PI / 180));
  const f = (n, up) => (up ? Math.ceil(n * 1e5) : Math.floor(n * 1e5)) / 1e5;
  return {south: f(lat - dLat), north: f(lat + dLat, true), west: f(lon - dLon), east: f(lon + dLon, true)};
}

export function areaQuery(box) {
  const b = [box.south, box.west, box.north, box.east].join(',');
  return `[out:json][timeout:25];(\n${overpassClauses().map(c => `  ${c}(${b});`).join('\n')}\n);(._;>;);out body qt;`;
}

const polyText = (name, b) => `${name}\n1\n   ${b.west} ${b.south}\n   ${b.east} ${b.south}\n   ${b.east} ${b.north}\n   ${b.west} ${b.north}\n   ${b.west} ${b.south}\nEND\nEND\n`;

/** Converts an Overpass JSON answer into PBF entities. Throws when the answer is incomplete. */
export function overpassToEntities(json) {
  if (json?.remark && /error|timeout|out of memory/i.test(json.remark)) throw new Error(`Overpass answer incomplete: ${json.remark.slice(0, 200)}`);
  const base = Date.parse(json?.osm3s?.timestamp_osm_base ?? '');
  if (!Number.isFinite(base)) throw new Error('Overpass answer without data timestamp');
  const nodes = [], ways = [], relations = [];
  for (const e of json.elements ?? []) {
    if (e.type === 'node' && Number.isFinite(e.lat) && Number.isFinite(e.lon)) nodes.push({id: e.id, lat: e.lat, lon: e.lon, ...(e.tags ? {tags: e.tags} : {})});
    else if (e.type === 'way' && Array.isArray(e.nodes)) ways.push({id: e.id, refs: e.nodes, tags: e.tags ?? {}});
    else if (e.type === 'relation' && Array.isArray(e.members)) relations.push({id: e.id, tags: e.tags ?? {},
      members: e.members.map(m => ({type: m.type, ref: m.ref, role: m.role ?? ''}))});
  }
  return {nodes, ways, relations, timestamp: Math.floor(base / 1000)};
}

/** One query for region def {id, publish: {circle}}; writes ovp-<id> files. Returns {bytes, elements}. */
export async function fetchOverpassArea(def, {ledger, dir, fetchImpl = fetch, log = console.log} = {}) {
  const circle = def.publish?.circle;
  if (!circle) throw new Error(`${def.id}: only circle areas can be fetched from Overpass`);
  const box = areaBox(circle), name = `ovp-${def.id}`;
  mkdirSync(dir, {recursive: true});   // before the query: an answer must never be lost
  log(`Overpass Europe: one query for ${def.id} (core ${Math.min(circle.radiusKm, OVERPASS_MAX_RADIUS_KM)} km)`);
  const res = await politeFetch(ledger, 'overpass-eu', OVERPASS_EU, {fetchImpl, method: 'POST',
    headers: {'content-type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({data: areaQuery(box)}).toString()});
  const text = await res.text();
  ledger.count('overpass-eu', {bytes: Buffer.byteLength(text)});
  if (!res.ok) throw new Error(`${LIMITS['overpass-eu'].label}: HTTP ${res.status}`);
  const entities = overpassToEntities(JSON.parse(text));
  writePbf(join(dir, `${name}-latest.osm.pbf`), {...entities, bbox: box, program: 'gamegis-broker overpass-eu'});
  writeFileSync(join(dir, `${name}.poly`), polyText(name, box));
  const elements = entities.nodes.length + entities.ways.length + entities.relations.length;
  log(`OK: ${name} from Overpass Europe (${(Buffer.byteLength(text) / 1048576).toFixed(1)} MB, ${elements} elements)`);
  return {bytes: Buffer.byteLength(text), elements};
}
