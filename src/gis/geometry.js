/**
 * GameGIS Broker / MVP-1 Stage 2 — pure geographical geometry.
 *
 * Public position format is GeoJSON 2D [longitude, latitude] in WGS84.
 * This module contains NO application-specific placement or exclusion limits.
 *
 * Adapted from an earlier in-house prototype.
 * Important deliberate differences:
 * - strict GeoJSON position/geometry validation;
 * - Polygon rings MUST be closed in the input (never silently closed);
 * - points on boundaries count as intersecting a Polygon;
 * - GeoJSON inner rings and MultiPolygon are supported geometrically;
 * - distances use local tangent-plane approximation for segments, as b0010 did.
 */

const DEG = Math.PI / 180;
const EARTH_HAVERSINE_M = 6371000; // value kept from the earlier prototype
const EARTH_LOCAL_M = 6378137; // value kept from the earlier prototype
const BOUNDARY_EPSILON_M = 0.00001; // numeric tolerance for exact boundary checks

export function assertPosition(position, label = 'position') {
  if (!Array.isArray(position) || position.length !== 2 ||
      !position.every(Number.isFinite) ||
      position[0] < -180 || position[0] > 180 ||
      position[1] < -90 || position[1] > 90) {
    throw new TypeError(`${label} must be a valid 2D GeoJSON [lon, lat] position`);
  }
  return position;
}

function longitudeDeltaDeg(aLon, bLon) {
  let delta = bLon - aLon;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}

function normalizeLongitude(lon) {
  const normalized = ((lon + 180) % 360 + 360) % 360 - 180;
  return normalized === -180 && lon > 0 ? 180 : normalized;
}

function assertMeters(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite meters`);
}

/** Haversine distance in meters, port of b0010 geo.js `distance`. */
export function distanceM(a, b) {
  assertPosition(a, 'a');
  assertPosition(b, 'b');
  const dLat = (b[1] - a[1]) * DEG;
  const dLon = longitudeDeltaDeg(a[0], b[0]) * DEG;
  const latA = a[1] * DEG;
  const latB = b[1] * DEG;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(latA) * Math.cos(latB) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_HAVERSINE_M * Math.asin(Math.sqrt(Math.max(0, Math.min(1, h))));
}

/** Local x=east, y=north in meters from origin, suitable for SHORT distances. */
export function localMeters(origin, point) {
  assertPosition(origin, 'origin');
  assertPosition(point, 'point');
  return {
    x: longitudeDeltaDeg(origin[0], point[0]) * DEG * EARTH_LOCAL_M * Math.cos(origin[1] * DEG),
    y: (point[1] - origin[1]) * DEG * EARTH_LOCAL_M,
  };
}

/** Local east/north displacement. Approximate; not a global geodesic solver. */
export function offsetMeters(origin, eastM, northM) {
  assertPosition(origin, 'origin');
  assertMeters(eastM, 'eastM');
  assertMeters(northM, 'northM');
  const cosLat = Math.cos(origin[1] * DEG);
  if (Math.abs(cosLat) < 1e-8) throw new RangeError('offsetMeters is undefined at the poles');
  const lat = origin[1] + (northM / EARTH_LOCAL_M) / DEG;
  const lon = normalizeLongitude(origin[0] + (eastM / (EARTH_LOCAL_M * cosLat)) / DEG);
  const result = [lon, lat];
  assertPosition(result, 'offset position');
  return result;
}

/** Distance from point to finite segment (degenerate zero-length segments allowed). */
export function pointSegmentDistanceM(point, a, b) {
  assertPosition(point, 'point');
  const A = localMeters(point, a);
  const B = localMeters(point, b);
  const vx = B.x - A.x;
  const vy = B.y - A.y;
  const square = vx * vx + vy * vy;
  const t = square ? Math.max(0, Math.min(1, -(A.x * vx + A.y * vy) / square)) : 0;
  return Math.hypot(A.x + vx * t, A.y + vy * t);
}

function assertLineCoordinates(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    throw new TypeError('LineString must contain at least two positions');
  }
  coordinates.forEach((p, i) => assertPosition(p, `line[${i}]`));
  return coordinates;
}

/** Distance to a LineString coordinate array (polyline). */
export function polylineDistanceM(point, coordinates) {
  assertPosition(point, 'point');
  assertLineCoordinates(coordinates);
  let best = Infinity;
  for (let i = 1; i < coordinates.length; i++) {
    best = Math.min(best, pointSegmentDistanceM(point, coordinates[i - 1], coordinates[i]));
  }
  return best;
}

/** Distance to a GeoJSON LineString / MultiLineString geometry. */
export function lineGeometryDistanceM(point, geometry) {
  assertPosition(point, 'point');
  if (!geometry || typeof geometry !== 'object') {
    throw new TypeError('Expected GeoJSON LineString or MultiLineString geometry');
  }
  if (geometry.type === 'LineString') {
    return polylineDistanceM(point, geometry.coordinates);
  }
  if (geometry.type === 'MultiLineString') {
    if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length < 1) {
      throw new TypeError('MultiLineString must contain at least one line');
    }
    let best = Infinity;
    for (const line of geometry.coordinates) {
      best = Math.min(best, polylineDistanceM(point, line));
    }
    return best;
  }
  throw new TypeError('Expected GeoJSON LineString or MultiLineString geometry');
}

function assertRing(ring) {
  if (!Array.isArray(ring) || ring.length < 4) {
    throw new TypeError('Polygon ring must contain at least four positions');
  }
  ring.forEach((p, i) => assertPosition(p, `ring[${i}]`));
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    throw new TypeError('Polygon ring must be explicitly closed; cannot turn an open way into a polygon');
  }
  const unique = new Set(ring.slice(0, -1).map(([lon, lat]) => `${lon},${lat}`));
  if (unique.size < 3) throw new TypeError('Polygon ring must contain at least three distinct vertices');
  return ring;
}

function assertPolygonRings(rings) {
  if (!Array.isArray(rings) || rings.length === 0) {
    throw new TypeError('Polygon must contain at least one ring');
  }
  rings.forEach(assertRing);
  return rings;
}

function polygonParts(geometry) {
  if (!geometry || typeof geometry !== 'object') {
    throw new TypeError('Expected GeoJSON Polygon or MultiPolygon geometry');
  }
  if (geometry.type === 'Polygon') {
    assertPolygonRings(geometry.coordinates);
    return [geometry.coordinates];
  }
  if (geometry.type === 'MultiPolygon') {
    const polys = geometry.coordinates;
    if (!Array.isArray(polys) || polys.length === 0) {
      throw new TypeError('MultiPolygon must contain at least one Polygon');
    }
    polys.forEach(assertPolygonRings);
    return polys;
  }
  throw new TypeError('Expected GeoJSON Polygon or MultiPolygon geometry');
}

function ringBoundaryDistanceM(point, ring) {
  let best = Infinity;
  for (let i = 1; i < ring.length; i++) {
    best = Math.min(best, pointSegmentDistanceM(point, ring[i - 1], ring[i]));
  }
  return best;
}

/** Smallest distance to any polygon ring edge, including inner rings. */
export function polygonEdgeDistanceM(point, geometry) {
  assertPosition(point, 'point');
  const polys = polygonParts(geometry);
  let best = Infinity;
  for (const polygon of polys) {
    for (const ring of polygon) {
      best = Math.min(best, ringBoundaryDistanceM(point, ring));
    }
  }
  return best;
}

/** Ray crossing in local meter coordinates, on a VALIDATED GeoJSON ring. */
function ringContains(point, ring) {
  let inside = false;
  for (let i = 1; i < ring.length; i++) {
    const a = localMeters(point, ring[i - 1]);
    const b = localMeters(point, ring[i]);
    if ((a.y > 0) !== (b.y > 0)) {
      const xCross = a.x + (-a.y) * (b.x - a.x) / (b.y - a.y);
      if (xCross > 0) inside = !inside;
    }
  }
  return inside;
}

/**
 * Inclusive boundary semantics: all Polygon rings (including holes) count as
 * boundary; points strictly inside a hole do NOT count as inside the polygon.
 */
export function pointInPolygon(point, geometry) {
  assertPosition(point, 'point');
  const polygons = polygonParts(geometry);
  for (const rings of polygons) {
    if (rings.some((ring) => ringBoundaryDistanceM(point, ring) <= BOUNDARY_EPSILON_M)) {
      return true;
    }
    if (ringContains(point, rings[0]) && !rings.slice(1).some((hole) => ringContains(point, hole))) {
      return true;
    }
  }
  return false;
}
