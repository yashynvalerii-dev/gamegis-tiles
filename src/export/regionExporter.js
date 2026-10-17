/**
 * Whole-region export of a local OSM extract into static tile bundles for free static hosting.
 *
 * Same data contract as the HTTP API (`/query` data groups) and the same fail-closed rules as the
 * cache path: each z15 tile is normalized from an Overpass-shaped payload for its buffered scope with
 * normalizeOsmMvpBase; a tile is READY only if normalization is complete AND its buffered scope lies
 * fully inside the extract boundary. Features are published only for READY tiles.
 *
 * Output: <outDir>/bundles/<z>/<x>/<y>.json.gz (gzip; one file per z13 bundle = 4x4 z15 tiles) + manifest.json.
 * Clients decompress with DecompressionStream('gzip'); the manifest sha256 covers the stored .gz bytes.
 *
 * Memory: passes over the PBF keep only relevant ways (+ multipolygon member ways), their node refs
 * and coordinates in typed arrays; bundles are built one at a time.
 */
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {scanPbf} from '../providers/pbfReader.js';
import {buildOverpassQuery} from '../providers/overpassProvider.js';
import {segmentIntersectsBox} from '../gis/bbox.js';
import {classifyWayTags, isPointFeatureTags, requiresRelationSupport} from '../gis/classifier.js';
import {normalizeOsmMvpBase, DATASET_ID, NORMALIZATION_VERSION} from '../gis/normalizer.js';
import {tileForPoint, boundsForTile, tileId, bboxContainsBbox} from '../core/tileGrid.js';
import {makeRegion} from '../providers/polyFile.js';

export const BUNDLE_FORMAT = 'GAMEGIS_TILE_BUNDLE_V2'; // V2: power group, published tag allowlist
export const MANIFEST_FORMAT = 'GAMEGIS_TILE_MANIFEST_V2'; // V2: gzip-stored bundles
export const BUNDLE_PATH_TEMPLATE = 'bundles/{z}/{x}/{y}.json.gz';
export const TILE_ZOOM = 15;
const GROUPS = {walkable: 'walkableWays', building: 'buildings', entrance: 'entrances', water: 'water',
  railway: 'railways', power: 'power', restricted_area: 'restrictedAreas', restricted_way: 'restrictedWays'};
const emptyGroups = () => ({walkableWays: [], buildings: [], entrances: [], water: [], railways: [], power: [], restrictedAreas: [], restrictedWays: []});

const isRelevantWay = tags => classifyWayTags(tags).length > 0;
const isRelevantRelation = tags => requiresRelationSupport(tags) || classifyWayTags(tags).length > 0;
const inBox = (b, lat, lon) => lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;
const intersects = (a, b) => a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south;

/** Growable Float64 buffer. */
class F64 {
  constructor(n = 1 << 20) { this.a = new Float64Array(n); this.n = 0; }
  push(v) { if (this.n === this.a.length) { const b = new Float64Array(this.a.length * 2); b.set(this.a); this.a = b; } this.a[this.n++] = v; }
  view() { return this.a.subarray(0, this.n); }
}

function lowerBound(sorted, v) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
  return lo;
}

/**
 * Reads the extract into a compact in-memory model:
 *   ways: ids, tags, ref offsets, coords (lat/lon per ref, NaN if node missing), bbox, relevant flag
 *   relations: relevant multipolygon-ish relations with member way indexes
 *   entrances: tagged entrance nodes
 */
export function loadRegionModel(pbfPath, {onProgress = () => {}, aoi = null} = {}) {
  return aoi ? loadAreaModel(pbfPath, aoi, onProgress) : loadWholeModel(pbfPath, onProgress);
}

/** Whole extract (small regions such as one German state). */
function loadWholeModel(pbfPath, onProgress) {
  onProgress('pass 1/3: relations');
  const relations = [];
  const memberWayIds = new Set();
  const header = scanPbf(pbfPath, {
    relation(id, members, tags) {
      if (!isRelevantRelation(tags)) return;
      relations.push({id, members, tags});
      for (const m of members) if (m.type === 'way') memberWayIds.add(m.ref);
    },
  });

  onProgress(`pass 2/3: ways (${relations.length} relevant relations, ${memberWayIds.size} member ways)`);
  const acc = newWayAccumulator();
  scanPbf(pbfPath, {
    way(id, wayRefs, tags) {
      const relevant = isRelevantWay(tags);
      if (!relevant && !memberWayIds.has(id)) return;
      acc.add(id, wayRefs, tags, relevant);
    },
  });
  onProgress(`pass 3/3: nodes (${acc.count()} ways, ${acc.refs.n} node references)`);
  const entrances = [];
  const coords = resolveNodes(pbfPath, acc, (id, la, lo, tags) => { if (isPointFeatureTags(tags)) entrances.push({id, lat: la, lon: lo, tags}); });
  return finishModel(header, acc, coords, relations, entrances);
}

/**
 * Only the area of interest {south, west, north, east} of a large extract (e.g. Germany around Thuringia,
 * Ukraine around a city). Keeps ways touching the area plus complete member ways of touching relations,
 * so features crossing the area edge keep their full geometry.
 */
function loadAreaModel(pbfPath, aoi, onProgress) {
  onProgress('pass 1/4: nodes inside the area, point features, relations');
  const inArea = new F64();
  const entrances = [];
  const allRelations = [];
  const memberWayIds = new Set();
  const header = scanPbf(pbfPath, {
    node(id, la, lo, tags) {
      if (la < aoi.south || la > aoi.north || lo < aoi.west || lo > aoi.east) return;
      inArea.push(id);
      if (isPointFeatureTags(tags)) entrances.push({id, lat: la, lon: lo, tags});
    },
    relation(id, members, tags) {
      if (!isRelevantRelation(tags)) return;
      allRelations.push({id, members, tags});
      for (const m of members) if (m.type === 'way') memberWayIds.add(m.ref);
    },
  });
  const areaIds = inArea.view().sort();
  const isInArea = id => { const i = lowerBound(areaIds, id); return i < areaIds.length && areaIds[i] === id; };

  onProgress(`pass 2/4: ways touching the area (${areaIds.length} nodes inside)`);
  const acc = newWayAccumulator();
  const kept = new Set();
  scanPbf(pbfPath, {
    way(id, wayRefs, tags) {
      const relevant = isRelevantWay(tags);
      if (!relevant && !memberWayIds.has(id)) return;
      if (!wayRefs.some(isInArea)) return;
      acc.add(id, wayRefs, tags, relevant); kept.add(id);
    },
  });
  const relations = allRelations.filter(r => r.members.some(m => m.type === 'way' && kept.has(m.ref)));
  const missing = new Set();
  for (const r of relations) for (const m of r.members) if (m.type === 'way' && !kept.has(m.ref)) missing.add(m.ref);
  if (missing.size) {
    onProgress(`pass 3/4: ${missing.size} member ways of ${relations.length} relations reaching outside the area`);
    scanPbf(pbfPath, {way(id, wayRefs, tags) { if (missing.has(id)) acc.add(id, wayRefs, tags, isRelevantWay(tags)); }});
  }
  onProgress(`pass 4/4: node coordinates (${acc.count()} ways, ${acc.refs.n} node references)`);
  const coords = resolveNodes(pbfPath, acc, null);
  return finishModel(header, acc, coords, relations, entrances);
}

function newWayAccumulator() {
  const ids = new F64(), refStart = new F64(), refs = new F64();
  const tags = [], relevant = [];
  return {ids, refStart, refs, tags, relevant,
    add(id, wayRefs, t, rel) { ids.push(id); refStart.push(refs.n); tags.push(t); relevant.push(rel); for (const r of wayRefs) refs.push(r); },
    count() { return tags.length; }};
}

/** One pass over nodes: coordinates for every referenced node (sorted unique ids + parallel lat/lon). */
function resolveNodes(pbfPath, acc, onNode) {
  const sortedRefs = Float64Array.from(acc.refs.view()).sort();
  let u = 0;
  for (let k = 0; k < sortedRefs.length; k++) if (k === 0 || sortedRefs[k] !== sortedRefs[k - 1]) sortedRefs[u++] = sortedRefs[k];
  const needed = sortedRefs.subarray(0, u);
  const lat = new Float64Array(needed.length).fill(NaN), lon = new Float64Array(needed.length).fill(NaN);
  scanPbf(pbfPath, {
    node(id, la, lo, tags) {
      const i = lowerBound(needed, id);
      if (i < needed.length && needed[i] === id) { lat[i] = la; lon[i] = lo; }
      if (onNode) onNode(id, la, lo, tags);
    },
  });
  return {needed, lat, lon};
}

function finishModel(header, acc, {needed, lat, lon}, relations, entrances) {
  acc.refStart.push(acc.refs.n);
  const wayTags = acc.tags, wayRelevant = acc.relevant, refStart = acc.refStart, refs = acc.refs, wayIds = acc.ids;
  // Resolve every way's coordinates and bbox once.
  const R = refs.view(), S = refStart.view();
  const wayCount = wayTags.length;
  const coordLat = new Float64Array(R.length), coordLon = new Float64Array(R.length);
  const bbox = new Float64Array(wayCount * 4); // south, west, north, east
  for (let w = 0; w < wayCount; w++) {
    let s = Infinity, wst = Infinity, n = -Infinity, e = -Infinity;
    for (let k = S[w]; k < S[w + 1]; k++) {
      const i = lowerBound(needed, R[k]);
      const la = lat[i], lo = lon[i];
      coordLat[k] = la; coordLon[k] = lo;
      if (Number.isFinite(la)) { if (la < s) s = la; if (la > n) n = la; if (lo < wst) wst = lo; if (lo > e) e = lo; }
    }
    bbox.set([s, wst, n, e], w * 4);
  }
  const wayIndex = new Map();
  const ids = wayIds.view();
  for (let w = 0; w < wayCount; w++) wayIndex.set(ids[w], w);
  for (const rel of relations) {
    rel.memberIdx = rel.members.map(m => (m.type === 'way' ? wayIndex.get(m.ref) : undefined));
    let s = Infinity, wst = Infinity, n = -Infinity, e = -Infinity;
    for (const w of rel.memberIdx) {
      if (w === undefined || !Number.isFinite(bbox[w * 4])) continue;
      s = Math.min(s, bbox[w * 4]); wst = Math.min(wst, bbox[w * 4 + 1]); n = Math.max(n, bbox[w * 4 + 2]); e = Math.max(e, bbox[w * 4 + 3]);
    }
    rel.bbox = {south: s, west: wst, north: n, east: e};
  }
  return {header, ids, tags: wayTags, relevant: wayRelevant, refStart: S, refs: R, coordLat, coordLon, bbox,
    relations, entrances, stats: {ways: wayCount, nodeRefs: R.length, uniqueNodes: needed.length,
      relations: relations.length, entrances: entrances.length}};
}

function wayBox(m, w) { return {south: m.bbox[w * 4], west: m.bbox[w * 4 + 1], north: m.bbox[w * 4 + 2], east: m.bbox[w * 4 + 3]}; }
function wayTouches(m, w, box) {
  const b = wayBox(m, w);
  if (!Number.isFinite(b.south) || !intersects(b, box)) return false;
  const s = m.refStart[w], e = m.refStart[w + 1];
  let prev = null;
  for (let k = s; k < e; k++) {
    const p = [m.coordLat[k], m.coordLon[k]];
    if (!Number.isFinite(p[0])) { prev = null; continue; }
    if (prev ? segmentIntersectsBox(prev, p, box) : inBox(box, p[0], p[1])) return true;
    prev = p;
  }
  return false;
}
function wayGeometry(m, w) {
  const out = [];
  for (let k = m.refStart[w]; k < m.refStart[w + 1]; k++) if (Number.isFinite(m.coordLat[k])) out.push({lat: m.coordLat[k], lon: m.coordLon[k]});
  return out;
}
function wayRefs(m, w) { return Array.from(m.refs.subarray(m.refStart[w], m.refStart[w + 1])); }

/** Spatial bucketing of relevant ways / relations / entrances by bundle key. */
function bucketize(m, bundleZoom, bufferM) {
  const shift = TILE_ZOOM - bundleZoom;
  const pad = bufferM / 111000 * 2; // generous degrees margin for the tile buffer
  const buckets = new Map();
  const add = (key, kind, v) => { let b = buckets.get(key); if (!b) buckets.set(key, b = {ways: [], relations: [], entrances: []}); b[kind].push(v); };
  const keysFor = box => {
    const nw = tileForPoint(Math.min(85, box.north + pad), Math.max(-180, box.west - pad * 2));
    const se = tileForPoint(Math.max(-85, box.south - pad), Math.min(180, box.east + pad * 2));
    const keys = [];
    for (let x = nw.x >> shift; x <= se.x >> shift; x++) for (let y = nw.y >> shift; y <= se.y >> shift; y++) keys.push(`${x}/${y}`);
    return keys;
  };
  for (let w = 0; w < m.tags.length; w++) {
    if (!m.relevant[w]) continue;
    const b = wayBox(m, w); if (!Number.isFinite(b.south)) continue;
    for (const k of keysFor(b)) add(k, 'ways', w);
  }
  m.relations.forEach((rel, r) => { if (Number.isFinite(rel.bbox.south)) for (const k of keysFor(rel.bbox)) add(k, 'relations', r); });
  m.entrances.forEach((n, i) => { for (const k of keysFor({south: n.lat, north: n.lat, west: n.lon, east: n.lon})) add(k, 'entrances', i); });
  return buckets;
}

/** Overpass-shaped payload for one tile scope from bundle candidates. */
function payloadFor(m, cand, scope) {
  const elements = [];
  for (const i of cand.entrances) { const n = m.entrances[i]; if (inBox(scope, n.lat, n.lon)) elements.push({type: 'node', id: n.id, lat: n.lat, lon: n.lon, tags: n.tags}); }
  for (const w of cand.ways) if (wayTouches(m, w, scope)) elements.push({type: 'way', id: m.ids[w], nodes: wayRefs(m, w), geometry: wayGeometry(m, w), tags: m.tags[w]});
  for (const r of cand.relations) {
    const rel = m.relations[r];
    if (!rel.memberIdx.some(w => w !== undefined && wayTouches(m, w, scope))) continue;
    elements.push({type: 'relation', id: rel.id, tags: rel.tags, members: rel.members.map((mem, k) => {
      const w = rel.memberIdx[k];
      const out = {type: mem.type, ref: mem.ref, role: mem.role};
      if (mem.type === 'way') out.geometry = w === undefined ? [] : wayGeometry(m, w);
      return out;
    })});
  }
  return {elements};
}

const featureBoxIntersects = (f, b) => f.bbox.minLon <= b.east && f.bbox.maxLon >= b.west && f.bbox.minLat <= b.north && f.bbox.maxLat >= b.south;

/**
 * Exports every bundle that intersects the region boundary.
 * boundary: object from polyFile.makeRegion/parsePoly; when absent the extract header bbox is used.
 */
export function exportRegion({model, outDir, boundary, publish = null, bundleZoom = 13, bufferM = 40, onProgress = () => {},
  generatedAt = new Date().toISOString(), writeManifest = true}) {
  if (bundleZoom > TILE_ZOOM || bundleZoom < 10) throw new RangeError('bundleZoom must be 10..15');
  const started = Date.now();
  const header = model.header;
  if (!Number.isSafeInteger(header.replicationTimestamp) || header.replicationTimestamp <= 0) throw new Error('EXTRACT_TIMESTAMP_MISSING');
  const dataTimestamp = new Date(header.replicationTimestamp * 1000).toISOString();
  // boundary: where the extract is complete; publish: which tiles to publish (defaults to the boundary).
  const area = publish?.bbox ?? boundary?.bbox ?? header.bbox;
  if (!area) throw new Error('EXTRACT_BOUNDS_UNKNOWN');
  const published = publish ? box => publish.classifyBox(box) !== 'OUTSIDE' : () => true;
  const classify = boundary ? box => boundary.classifyBox(box)
    : box => (bboxContainsBbox(header.bbox, box) ? 'INSIDE' : (intersects(header.bbox, box) ? 'PARTIAL' : 'OUTSIDE'));

  const shift = TILE_ZOOM - bundleZoom, side = 1 << shift;
  const nw = tileForPoint(area.north, area.west), se = tileForPoint(area.south, area.east);
  const buckets = bucketize(model, bundleZoom, bufferM);
  const empty = {ways: [], relations: [], entrances: []};
  const manifest = {format: MANIFEST_FORMAT, datasetId: DATASET_ID, normalizationVersion: NORMALIZATION_VERSION,
    provider: 'GEOFABRIK_EXTRACT', dataTimestamp, generatedAt, tileZoom: TILE_ZOOM, bundleZoom, bufferM,
    bundlePath: BUNDLE_PATH_TEMPLATE, bundleEncoding: 'gzip',
    license: 'ODbL 1.0 — © OpenStreetMap contributors', bundles: {}};
  const stats = {bundles: 0, files: 0, bytes: 0, gzipBytes: 0, maxBundleBytes: 0, maxBundleGzipBytes: 0,
    tiles: {READY: 0, INCOMPLETE: 0}, incompleteReasons: {}, features: 0};
  let lastLog = Date.now();
  const bundleXs = [nw.x >> shift, se.x >> shift], bundleYs = [nw.y >> shift, se.y >> shift];
  const totalBundles = (bundleXs[1] - bundleXs[0] + 1) * (bundleYs[1] - bundleYs[0] + 1);
  let visited = 0;
  for (let bx = bundleXs[0]; bx <= bundleXs[1]; bx++) {
    for (let by = bundleYs[0]; by <= bundleYs[1]; by++) {
      visited++;
      const tilesOut = {};
      const groups = emptyGroups(); const seen = new Set();
      let anyTile = false;
      const cand = buckets.get(`${bx}/${by}`) ?? empty;
      for (let dx = 0; dx < side; dx++) for (let dy = 0; dy < side; dy++) {
        const tile = {z: TILE_ZOOM, x: bx * side + dx, y: by * side + dy};
        const scope = buildOverpassQuery({tile, bufferM}).bbox;
        if (!published(boundsForTile(tile))) continue;
        const where = classify(scope);
        if (where === 'OUTSIDE') continue;
        anyTile = true;
        const id = tileId(tile);
        if (where === 'PARTIAL') { tilesOut[id] = {status: 'INCOMPLETE', reason: 'SCOPE_CROSSES_EXTRACT_BOUNDARY'}; continue; }
        const normalized = normalizeOsmMvpBase(payloadFor(model, cand, scope), {provider: 'GEOFABRIK_EXTRACT'});
        if (!normalized.diagnostics.complete) {
          const codes = [...new Set(normalized.diagnostics.errors.map(e => e.code))];
          tilesOut[id] = {status: 'INCOMPLETE', reason: 'OSM_NORMALIZATION_INCOMPLETE', codes,
            examples: normalized.diagnostics.errors.slice(0, 3).map(e => `${e.sourceType}/${e.sourceId}`)};
          continue;
        }
        tilesOut[id] = {status: 'READY'};
        const tb = boundsForTile(tile);
        for (const f of normalized.features) {
          if (!featureBoxIntersects(f, tb)) continue;
          const key = `${f.sourceType}/${f.sourceId}/${f.featureClass}`;
          if (seen.has(key)) continue;
          seen.add(key);
          groups[GROUPS[f.featureClass]].push({type: 'Feature', geometry: f.geometry,
            properties: {tags: f.tags, sourceType: f.sourceType, sourceId: f.sourceId}});
        }
      }
      if (!anyTile) continue;
      const bundleKey = `${bundleZoom}/${bx}/${by}`;
      const body = JSON.stringify({format: BUNDLE_FORMAT, bundle: bundleKey, datasetId: DATASET_ID,
        normalizationVersion: NORMALIZATION_VERSION, provider: 'GEOFABRIK_EXTRACT', dataTimestamp,
        license: manifest.license, tiles: tilesOut, data: groups});
      const bytes = Buffer.from(body, 'utf8');
      const stored = gzipSync(bytes, {level: 9});
      const gz = stored.length;
      const dir = join(outDir, 'bundles', String(bundleZoom), String(bx));
      mkdirSync(dir, {recursive: true});
      writeFileSync(join(dir, `${by}.json.gz`), stored);
      const ready = Object.values(tilesOut).filter(t => t.status === 'READY').length;
      const total = Object.keys(tilesOut).length;
      manifest.bundles[bundleKey] = {sha256: createHash('sha256').update(stored).digest('hex'), bytes: gz,
        rawBytes: bytes.length, readyTiles: ready, totalTiles: total};
      stats.bundles++; stats.files++; stats.bytes += bytes.length; stats.gzipBytes += gz; stats.storedBytes = (stats.storedBytes ?? 0) + gz;
      stats.maxBundleBytes = Math.max(stats.maxBundleBytes, bytes.length); stats.maxBundleGzipBytes = Math.max(stats.maxBundleGzipBytes, gz);
      stats.features += seen.size;
      for (const t of Object.values(tilesOut)) {
        stats.tiles[t.status]++;
        if (t.status === 'INCOMPLETE') for (const c of (t.codes ?? [t.reason])) stats.incompleteReasons[c] = (stats.incompleteReasons[c] ?? 0) + 1;
      }
      if (Date.now() - lastLog > 10000) { lastLog = Date.now(); onProgress(`bundles ${visited}/${totalBundles} scanned, ${stats.bundles} written`); }
    }
  }
  if (writeManifest) {
    const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
    writeFileSync(join(outDir, 'manifest.json'), manifestBytes);
    stats.files++; stats.bytes += manifestBytes.length; stats.gzipBytes += gzipSync(manifestBytes).length;
    stats.storedBytes = (stats.storedBytes ?? 0) + manifestBytes.length;
    stats.manifestBytes = manifestBytes.length;
  }
  stats.durationMs = Date.now() - started;
  return {manifest, stats};
}

/** Approximates a circle as a closed polygon region (for publishing "N km around a point"). */
export function circleRegion({lat, lon, radiusKm}, vertices = 72) {
  const pts = [];
  for (let i = 0; i <= vertices; i++) {
    const a = (i % vertices) / vertices * 2 * Math.PI;
    const dLat = radiusKm / 111.32 * Math.cos(a), dLon = radiusKm / (111.32 * Math.cos(lat * Math.PI / 180)) * Math.sin(a);
    pts.push([lon + dLon, lat + dLat]);
  }
  return makeRegion([{hole: false, points: pts}]);
}

/** Merges per-region manifests into one site manifest. Bundle keys must not collide. */
export function mergeManifests(parts, generatedAt = new Date().toISOString()) {
  if (!parts.length) throw new Error('NO_REGIONS');
  const merged = {...parts[0].manifest, generatedAt, bundles: {}, regions: []};
  for (const {id, name, manifest} of parts) {
    for (const [k, v] of Object.entries(manifest.bundles)) {
      if (merged.bundles[k]) throw new Error(`BUNDLE_COLLISION ${k} (regions overlap: ${id})`);
      merged.bundles[k] = v;
    }
    merged.regions.push({id, name, dataTimestamp: manifest.dataTimestamp, bundles: Object.keys(manifest.bundles).length,
      readyTiles: Object.values(manifest.bundles).reduce((a, b) => a + b.readyTiles, 0)});
  }
  // The site is as fresh as its oldest region.
  merged.dataTimestamp = merged.regions.map(r => r.dataTimestamp).sort()[0];
  return merged;
}
