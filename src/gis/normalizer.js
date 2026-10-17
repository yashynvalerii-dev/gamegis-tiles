/**
 * GameGIS Broker MVP-1 Stage 3: pure OSM JSON -> GeoJSON feature normalizer.
 * Source: an earlier in-house prototype, adapted.
 *
 * Consumes cached/synthetic OSM Map API JSON (nodes+ways) OR Overpass `out geom`
 * ways with standalone entrance nodes. No fetch, DB, filesystem or game logic.
 * Missing relevant geometry and unsupported relevant relations fail CLOSED:
 * result.diagnostics.complete=false; future coverage MUST NOT mark such tiles READY.
 */
import { assertPosition, pointInPolygon } from './geometry.js';
import { classifyWayTags, isEntranceTags, isPowerPointTags, requiresRelationSupport } from './classifier.js';

export const DATASET_ID = 'OSM_MVP_BASE_V1'; // layer set is identified by NORMALIZATION_VERSION (V3 adds POWER)
export const NORMALIZATION_VERSION = 'OSM_NORMALIZER_V4'; // V2: multipolygons; V3: power + tag allowlist; V4: site perimeters, linear military, building-on-road fix
export const PROCESSED_LAYERS = Object.freeze([
  'WALKABLE', 'BUILDINGS', 'ENTRANCES', 'WATER', 'RAILWAYS', 'POWER',
]);

/**
 * Only geography/accessibility tags are published; metadata (addresses, sources, notes, contacts,
 * wiki links, translations) is dropped to keep tiles small. Classification always uses the full tags.
 */
export const PUBLISHED_TAG_KEYS = Object.freeze(new Set([
  'name', 'ref', 'type', 'area', 'layer', 'level', 'tunnel', 'bridge', 'covered', 'indoor', 'location',
  'highway', 'footway', 'sidewalk', 'surface', 'smoothness', 'tracktype', 'lit', 'wheelchair', 'service',
  'access', 'foot', 'bicycle', 'motor_vehicle', 'barrier',
  'entrance', 'door', 'building', 'building:levels',
  'natural', 'water', 'waterway', 'intermittent', 'landuse', 'military',
  'railway', 'usage', 'electrified', 'power', 'voltage', 'line', 'cables',
]));
function publishedTags(tags) {
  const out = {};
  for (const [k, v] of Object.entries(tags)) if (PUBLISHED_TAG_KEYS.has(k)) out[k] = v;
  return out;
}

const LAYER_FOR_CLASS = Object.freeze({
  walkable: 'walkableWays',
  building: 'buildings',
  entrance: 'entrances',
  water: 'water',
  railway: 'railways',
  power: 'power',
  restricted_area: 'restrictedAreas',
  restricted_way: 'restrictedWays',
});
const POLYGON_CLASSES = new Set(['building', 'water', 'restricted_area']);

function positionFromNode(element) {
  const p = [element.lon, element.lat];
  assertPosition(p, 'OSM node position');
  return p;
}

function positionFromGeometry(element, index) {
  const p = [element?.lon, element?.lat];
  assertPosition(p, `OSM way geometry[${index}]`);
  return p;
}

function assertSourceElement(element) {
  if (!element || typeof element !== 'object' || Array.isArray(element) ||
      !['node', 'way', 'relation'].includes(element.type) ||
      !Number.isSafeInteger(element.id) || element.id <= 0 ||
      (element.tags != null && (typeof element.tags !== 'object' || Array.isArray(element.tags)))) {
    throw new TypeError('Invalid OSM element: expected node/way/relation with positive safe-integer id and object tags');
  }
  safeTags(element.tags);
}

function safeTags(tags) {
  const clean = {};
  for (const [key, tagValue] of Object.entries(tags || {})) {
    if (typeof tagValue !== 'string') {
      throw new TypeError(`OSM tag ${key} must be a string`);
    }
    Object.defineProperty(clean, key, { value: tagValue, enumerable: true, configurable: true, writable: true });
  }
  return clean;
}

function collectPositions(geometry) {
  if (geometry.type === 'Point') return [geometry.coordinates];
  if (geometry.type === 'LineString') return geometry.coordinates;
  if (geometry.type === 'Polygon' || geometry.type === 'MultiLineString') return geometry.coordinates.flat();
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat(2);
  throw new TypeError('Unsupported normalized geometry');
}

function boundsFor(geometry) {
  const points = collectPositions(geometry);
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const position of points) {
    assertPosition(position);
    minLon = Math.min(minLon, position[0]);
    maxLon = Math.max(maxLon, position[0]);
    minLat = Math.min(minLat, position[1]);
    maxLat = Math.max(maxLat, position[1]);
  }
  return { minLon, minLat, maxLon, maxLat };
}

function isValidClosedRing(positions) {
  if (positions.length < 4) return false;
  const [first, last] = [positions[0], positions[positions.length - 1]];
  if (first[0] !== last[0] || first[1] !== last[1]) return false;
  return new Set(positions.slice(0, -1).map(([lon, lat]) => `${lon},${lat}`)).size >= 3;
}

function wayCoordinates(way, nodes) {
  if (Array.isArray(way.geometry)) {
    // Overpass can emit geometry clipped to an output bbox; NEVER treat
    // clipped partial ways as fully normalized when node refs reveal this.
    if (Array.isArray(way.nodes) && way.geometry.length !== way.nodes.length) {
      return { error: 'PARTIAL_WAY_GEOMETRY' };
    }
    if (way.geometry.length < 2) return { error: 'TOO_FEW_WAY_GEOMETRY_POINTS' };
    try {
      return { coordinates: way.geometry.map(positionFromGeometry) };
    } catch {
      return { error: 'INVALID_WAY_GEOMETRY_COORDINATE' };
    }
  }
  if (!Array.isArray(way.nodes) || way.nodes.length < 2) {
    return { error: 'WAY_GEOMETRY_UNAVAILABLE' };
  }
  if (!way.nodes.every((id) => Number.isSafeInteger(id) && id > 0)) {
    return { error: 'INVALID_WAY_NODE_REFERENCE' };
  }
  const missingNodeIds = way.nodes.filter((id) => !nodes.has(id));
  if (missingNodeIds.length) {
    return { error: 'MISSING_WAY_NODES', missingNodeIds: [...new Set(missingNodeIds)] };
  }
  return { coordinates: way.nodes.map((id) => [...nodes.get(id)]) };
}

const samePosition = (a, b) => a[0] === b[0] && a[1] === b[1];

/** Shoelace area in squared degrees; only used to compare ring sizes. */
function ringArea(ring) {
  let sum = 0;
  for (let i = 1; i < ring.length; i++) sum += ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1];
  return Math.abs(sum) / 2;
}

/** Joins open way pieces end-to-end into closed rings. Returns {rings} or {error}. */
export function assembleRings(pieces) {
  const open = pieces.map((p) => p.map((q) => [...q]));
  const rings = [];
  while (open.length) {
    let ring = open.shift();
    while (!samePosition(ring[0], ring[ring.length - 1])) {
      const end = ring[ring.length - 1];
      const i = open.findIndex((p) => samePosition(p[0], end) || samePosition(p[p.length - 1], end));
      if (i < 0) return { error: 'MULTIPOLYGON_RING_NOT_CLOSED' };
      const [next] = open.splice(i, 1);
      const oriented = samePosition(next[0], end) ? next : [...next].reverse();
      ring = ring.concat(oriented.slice(1));
    }
    if (!isValidClosedRing(ring)) return { error: 'MULTIPOLYGON_INVALID_RING' };
    rings.push(ring);
  }
  return { rings };
}

function memberCoordinates(member, wayById, nodes) {
  if (Array.isArray(member.geometry) && member.geometry.length) {
    if (member.geometry.some((g) => g == null)) return { error: 'MULTIPOLYGON_MEMBER_GEOMETRY_PARTIAL' };
    try {
      return { coordinates: member.geometry.map(positionFromGeometry) };
    } catch {
      return { error: 'MULTIPOLYGON_MEMBER_GEOMETRY_INVALID' };
    }
  }
  const way = wayById.get(member.ref);
  if (!way) return { error: 'MULTIPOLYGON_MEMBER_GEOMETRY_MISSING' };
  const geo = wayCoordinates(way, nodes);
  return geo.error ? { error: 'MULTIPOLYGON_MEMBER_GEOMETRY_MISSING' } : geo;
}

/**
 * Builds Polygon/MultiPolygon coordinates from an OSM multipolygon relation.
 * Fails closed on missing members, open rings, nested relations or orphan inner rings.
 */
export function assembleMultipolygon(relation, wayById, nodes, { outerRoles = ['outer', ''] } = {}) {
  const members = Array.isArray(relation.members) ? relation.members : [];
  const outerPieces = [], innerPieces = [];
  for (const m of members) {
    if (m?.type === 'relation') return { error: 'MULTIPOLYGON_NESTED_RELATION_NOT_SUPPORTED' };
    if (m?.type !== 'way') continue;
    const role = typeof m.role === 'string' ? m.role : '';
    const isOuter = outerRoles.includes(role);
    if (!isOuter && role !== 'inner') continue;
    const geo = memberCoordinates(m, wayById, nodes);
    if (geo.error) return geo;
    (isOuter ? outerPieces : innerPieces).push(geo.coordinates);
  }
  if (!outerPieces.length) return { error: 'MULTIPOLYGON_MEMBER_GEOMETRY_MISSING' };
  const outer = assembleRings(outerPieces);
  if (outer.error) return outer;
  const inner = assembleRings(innerPieces);
  if (inner.error) return inner;
  const polygons = outer.rings.map((ring) => ({ ring, area: ringArea(ring), holes: [] }));
  for (const hole of inner.rings) {
    const probe = hole.find((p) => !polygons.some((pg) => pg.ring.some((q) => samePosition(p, q)))) ?? hole[0];
    const owners = polygons.filter((pg) => pointInPolygon(probe, { type: 'Polygon', coordinates: [pg.ring] }));
    if (!owners.length) return { error: 'MULTIPOLYGON_INNER_RING_OUTSIDE_OUTER' };
    owners.sort((a, b) => a.area - b.area)[0].holes.push(hole);
  }
  const parts = polygons.map((pg) => [pg.ring, ...pg.holes]);
  return { polygons: parts };
}

/**
 * Each output feature is a storage-ready record with GeoJSON geometry:
 * {provider,sourceType,sourceId,featureClass,geometry,bbox,tags,normalizationVersion}.
 * layers contain the same feature record references, grouped by category.
 */
export function normalizeOsmMvpBase(payload, { provider } = {}) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.elements)) {
    throw new TypeError('Expected OSM JSON payload with elements array');
  }
  if (typeof provider !== 'string' || !/^[A-Z0-9_\-]{2,64}$/.test(provider)) {
    throw new TypeError('An explicit provider identifier is required, e.g. OVERPASS');
  }

  const nodes = new Map();
  const ways = [];
  const relations = [];
  const nodeElements = [];
  const seen = new Map();
  const errors = [];
  const warnings = [];
  let nodeCount = 0, wayCount = 0, relationCount = 0;

  for (const el of payload.elements) {
    assertSourceElement(el);
    const key = `${el.type}:${el.id}`;
    const signature = JSON.stringify(el);
    if (seen.has(key)) {
      if (seen.get(key) !== signature) {
        throw new TypeError(`Conflicting duplicate OSM source element ${key}`);
      }
      warnings.push({ code: 'DUPLICATE_IDENTICAL_ELEMENT', sourceType: el.type, sourceId: el.id });
      continue;
    }
    seen.set(key, signature);
    if (el.type === 'node') {
      nodeCount++;
      nodeElements.push(el);
      try {
        nodes.set(el.id, positionFromNode(el));
      } catch {
        errors.push({ code: 'INVALID_NODE_COORDINATES', sourceType: 'node', sourceId: el.id });
      }
    } else if (el.type === 'way') {
      wayCount++;
      ways.push(el);
    } else {
      relationCount++;
      relations.push(el);
    }
  }

  const layers = {
    walkableWays: [], buildings: [], entrances: [], water: [], railways: [], power: [],
    restrictedAreas: [], restrictedWays: [],
  };
  const features = [];
  const makeFeature = (sourceType, sourceId, featureClass, geometry, tags) => {
    const feature = {
      provider,
      sourceType,
      sourceId,
      featureClass,
      geometry,
      bbox: boundsFor(geometry),
      tags: publishedTags(safeTags(tags)),
      normalizationVersion: NORMALIZATION_VERSION,
    };
    features.push(feature);
    layers[LAYER_FOR_CLASS[featureClass]].push(feature);
  };

  for (const el of nodeElements) {
    const pointClasses = [];
    if (isEntranceTags(el.tags)) pointClasses.push('entrance');
    if (isPowerPointTags(el.tags)) pointClasses.push('power');
    if (!pointClasses.length) continue;
    const pos = nodes.get(el.id);
    if (pos) for (const cls of pointClasses) makeFeature('node', el.id, cls, { type: 'Point', coordinates: [...pos] }, el.tags);
    // Invalid nodes were already flagged as errors, never silently considered empty.
  }

  let normalizedWayCount = 0;
  let ignoredWayCount = 0;
  let brokenRelevantWayCount = 0;
  for (const way of ways) {
    const classes = classifyWayTags(way.tags);
    if (!classes.length) { ignoredWayCount++; continue; }
    const geo = wayCoordinates(way, nodes);
    if (geo.error) {
      brokenRelevantWayCount++;
      errors.push({ code: geo.error, sourceType: 'way', sourceId: way.id,
        ...(geo.missingNodeIds ? { missingNodeIds: geo.missingNodeIds } : {}) });
      continue;
    }
    const positions = geo.coordinates;
    normalizedWayCount++;
    for (const featureClass of classes) {
      if (POLYGON_CLASSES.has(featureClass) && !isValidClosedRing(positions)) {
        // An open road cannot be a building: a building tag on it is a mapping mistake, the road itself stays.
        if (featureClass === 'building' && way.tags?.highway) {
          warnings.push({ code: 'BUILDING_TAG_ON_OPEN_ROAD_IGNORED', sourceType: 'way', sourceId: way.id });
          continue;
        }
        errors.push({ code: 'INVALID_OR_OPEN_POLYGON_WAY', sourceType: 'way', sourceId: way.id,
          featureClass });
        continue;
      }
      const geometry = POLYGON_CLASSES.has(featureClass)
        ? { type: 'Polygon', coordinates: [[...positions.map((p) => [...p])]] }
        : { type: 'LineString', coordinates: positions.map((p) => [...p]) };
      makeFeature('way', way.id, featureClass, geometry, way.tags);
    }
  }

  const wayById = new Map(ways.map((w) => [w.id, w]));
  let unsupportedRelevantRelationCount = 0;
  let assembledMultipolygonCount = 0;
  for (const relation of relations) {
    const type = String(relation.tags?.type ?? '').trim().toLowerCase();
    const classes = classifyWayTags(relation.tags);
    // type=site with "perimeter" members (e.g. a port) describes its area by that perimeter.
    const isSiteArea = type === 'site' && (relation.members ?? []).some((m) => m?.role === 'perimeter');
    if ((type === 'multipolygon' || isSiteArea) && classes.length) {
      const mp = assembleMultipolygon(relation, wayById, nodes,
        isSiteArea ? { outerRoles: ['perimeter'] } : undefined);
      if (mp.error) {
        errors.push({ code: mp.error, sourceType: 'relation', sourceId: relation.id });
        continue;
      }
      assembledMultipolygonCount++;
      for (const featureClass of classes) {
        const geometry = POLYGON_CLASSES.has(featureClass)
          ? (mp.polygons.length === 1
            ? { type: 'Polygon', coordinates: mp.polygons[0] }
            : { type: 'MultiPolygon', coordinates: mp.polygons })
          : { type: 'MultiLineString', coordinates: mp.polygons.flat() };
        makeFeature('relation', relation.id, featureClass, geometry, relation.tags);
      }
    } else if (type === 'building' && requiresRelationSupport(relation.tags)) {
      // 3D building relations group parts; the outline is a separately tagged building way.
      warnings.push({ code: 'BUILDING_RELATION_OUTLINE_FROM_WAYS', sourceType: 'relation', sourceId: relation.id });
    } else if (requiresRelationSupport(relation.tags)) {
      unsupportedRelevantRelationCount++;
      errors.push({ code: 'RELEVANT_OSM_RELATION_NOT_SUPPORTED', sourceType: 'relation',
        sourceId: relation.id });
    }
  }

  return {
    datasetId: DATASET_ID,
    normalizationVersion: NORMALIZATION_VERSION,
    provider,
    features,
    layers,
    sourceStats: {
      rawElementCount: payload.elements.length,
      nodeCount, wayCount, relationCount,
      entranceNodeCount: layers.entrances.length,
      normalizedWayCount, ignoredWayCount, brokenRelevantWayCount,
      unsupportedRelevantRelationCount, assembledMultipolygonCount,
      featureCount: features.length,
    },
    diagnostics: {
      complete: errors.length === 0,
      processedLayers: [...PROCESSED_LAYERS],
      errors,
      warnings,
      limitations: ['OSM_NESTED_RELATIONS_NOT_SUPPORTED'],
    },
  };
}
