/**
 * Full-map areas (owner 2026-11-19): for an ordered area, EVERY OSM object of the extract that touches the area — all
 * tags, full geometry, OSM type/id — with no selection by groups. A separate product next to the tile bundles; only for
 * areas on the approved list (full-areas.json), never for whole regions.
 *
 * Output: full/<areaId>.json.gz = {format: 'GAMEGIS_FULL_AREA_V1', id, bbox, dataTimestamp, license, elements}
 * where elements follow the Overpass "out body geom" shape:
 *   node {type, id, lat, lon, tags?}
 *   way {type, id, nodes:[ids], geometry:[{lat, lon}], tags?}
 *   relation {type, id, members:[{type, ref, role, geometry?|lat/lon?}], tags?}
 * Ways and relations touching the area keep their WHOLE geometry (also outside the box). Nodes inside the box are
 * listed with their tags; untagged nodes outside the box appear only as way geometry. No editing metadata (users,
 * changesets) is read from the extract at all.
 */
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {scanPbf} from '../providers/pbfReader.js';

export const FULL_FORMAT = 'GAMEGIS_FULL_AREA_V1';
export const FULL_VERSION = 1;
export const MAX_FULL_AREA_KM2 = 9;   // ~3 x 3 km: full data is heavy; bigger areas are split by the orderer
const LICENSE = 'ODbL 1.0 — © OpenStreetMap contributors';

const inBox = (b, lat, lon) => lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;
export function boxAreaKm2(b) {
  const h = (b.north - b.south) * 111.32, w = (b.east - b.west) * 111.32 * Math.cos((b.north + b.south) / 2 * Math.PI / 180);
  return h * w;
}

/** Reads everything touching bbox from a PBF (four sequential passes at most). */
export function collectFull(pbfPath, bbox, {onProgress = () => {}} = {}) {
  const coords = new Map(), tagged = new Map(), ways = new Map(), relations = new Map();
  onProgress('full pass 1: nodes in the area');
  const header = scanPbf(pbfPath, {
    node(id, lat, lon, tags) {
      if (!inBox(bbox, lat, lon)) return;
      coords.set(id, [lat, lon]);
      if (Object.keys(tags).length) tagged.set(id, tags);
    },
  });
  onProgress('full pass 2: ways touching the area, relations');
  const allRelations = [];
  scanPbf(pbfPath, {
    way(id, refs, tags) { if (refs.some(r => coords.has(r))) ways.set(id, {refs, tags}); },
    relation(id, members, tags) { allRelations.push({id, members, tags}); },
  });
  // relations with a member in the area (node inside, or a way touching it); nested relations one level deep
  const relIds = new Set();
  for (const r of allRelations) if (r.members.some(m => (m.type === 'node' && coords.has(m.ref)) || (m.type === 'way' && ways.has(m.ref)))) relIds.add(r.id);
  for (const r of allRelations) if (!relIds.has(r.id) && r.members.some(m => m.type === 'relation' && relIds.has(m.ref))) relIds.add(r.id);
  for (const r of allRelations) if (relIds.has(r.id)) relations.set(r.id, {members: r.members, tags: r.tags});
  const missingWays = new Set();
  for (const r of relations.values()) for (const m of r.members) if (m.type === 'way' && !ways.has(m.ref)) missingWays.add(m.ref);
  if (missingWays.size) {
    onProgress(`full pass 3: ${missingWays.size} member ways outside the area`);
    scanPbf(pbfPath, {way(id, refs, tags) { if (missingWays.has(id)) ways.set(id, {refs, tags, outside: true}); }});
  }
  const missingNodes = new Set();
  for (const w of ways.values()) for (const r of w.refs) if (!coords.has(r)) missingNodes.add(r);
  for (const r of relations.values()) for (const m of r.members) if (m.type === 'node' && !coords.has(m.ref)) missingNodes.add(m.ref);
  if (missingNodes.size) {
    onProgress(`full pass 4: ${missingNodes.size} nodes outside the area`);
    scanPbf(pbfPath, {node(id, lat, lon) { if (missingNodes.has(id)) coords.set(id, [lat, lon]); }});
  }
  return {header, coords, tagged, ways, relations};
}

const geom = (refs, coords) => refs.map(r => coords.get(r)).filter(Boolean).map(([lat, lon]) => ({lat, lon}));

/** Elements in Overpass "out body geom" shape, sorted by type and id. Returns {elements, incomplete}. */
export function fullElements({coords, tagged, ways, relations}) {
  const elements = [];
  let incomplete = 0;
  for (const [id, tags] of [...tagged.entries()].sort((a, b) => a[0] - b[0])) {
    const [lat, lon] = coords.get(id);
    elements.push({type: 'node', id, lat, lon, tags});
  }
  for (const [id, w] of [...ways.entries()].sort((a, b) => a[0] - b[0])) {
    const geometry = geom(w.refs, coords);
    if (geometry.length !== w.refs.length) incomplete++;
    elements.push({type: 'way', id, nodes: w.refs, geometry, ...(Object.keys(w.tags).length ? {tags: w.tags} : {})});
  }
  for (const [id, r] of [...relations.entries()].sort((a, b) => a[0] - b[0])) {
    const members = r.members.map(m => {
      if (m.type === 'way' && ways.has(m.ref)) return {type: 'way', ref: m.ref, role: m.role, geometry: geom(ways.get(m.ref).refs, coords)};
      if (m.type === 'node' && coords.has(m.ref)) { const [lat, lon] = coords.get(m.ref); return {type: 'node', ref: m.ref, role: m.role, lat, lon}; }
      return {type: m.type, ref: m.ref, role: m.role};
    });
    elements.push({type: 'relation', id, members, ...(Object.keys(r.tags).length ? {tags: r.tags} : {})});
  }
  return {elements, incomplete};
}

/**
 * Builds one full area from a local extract into outDir/full/<id>.json.gz. boundary (from the extract's .poly) must
 * contain the whole box, otherwise the data could be cut and the area is refused. Returns the manifest entry.
 */
export function exportFullArea(def, pbfPath, {outDir, boundary = null, onProgress = () => {}} = {}) {
  const b = def.bbox;
  if (!b || !(b.south < b.north && b.west < b.east)) throw new Error(`${def.id}: bbox {south, west, north, east} required`);
  if (boxAreaKm2(b) > MAX_FULL_AREA_KM2) throw new Error(`${def.id}: area ${boxAreaKm2(b).toFixed(1)} km² is larger than ${MAX_FULL_AREA_KM2} km²`);
  if (boundary && boundary.classifyBox(b) !== 'INSIDE') throw new Error(`${def.id}: area is not completely inside the extract boundary`);
  const data = collectFull(pbfPath, b, {onProgress});
  if (!Number.isSafeInteger(data.header.replicationTimestamp)) throw new Error(`${def.id}: extract has no data timestamp`);
  const {elements, incomplete} = fullElements(data);
  const dataTimestamp = new Date(data.header.replicationTimestamp * 1000).toISOString();
  const raw = Buffer.from(JSON.stringify({format: FULL_FORMAT, version: FULL_VERSION, id: def.id, bbox: b, dataTimestamp, license: LICENSE,
    incompleteWays: incomplete, elements}), 'utf8');
  const stored = gzipSync(raw, {level: 9});
  const path = `full/${def.id}.json.gz`;
  mkdirSync(join(outDir, 'full'), {recursive: true});
  writeFileSync(join(outDir, path), stored);
  const count = t => elements.filter(e => e.type === t).length;
  return {id: def.id, bbox: b, path, sha256: createHash('sha256').update(stored).digest('hex'), bytes: stored.length, rawBytes: raw.length,
    dataTimestamp, elements: {nodes: count('node'), ways: count('way'), relations: count('relation')}, incompleteWays: incomplete};
}
