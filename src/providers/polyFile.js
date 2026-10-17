/**
 * Osmosis .poly region boundary (as published by Geofabrik next to each extract).
 * Format: name line, then sections (name line, "lon lat" lines, END); sections whose name starts with
 * '!' are holes; the file ends with END. Used to decide whether a tile lies fully inside the extract,
 * so border tiles are never certified with neighbouring data silently missing.
 */
import {readFileSync} from 'node:fs';
import {segmentIntersectsBox} from '../gis/bbox.js';

export function parsePoly(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length);
  if (lines.length < 2) throw new Error('POLY_EMPTY');
  const rings = [];
  let i = 1, current = null;
  while (i < lines.length) {
    const line = lines[i++];
    if (current === null) {
      if (line === 'END') break; // end of file
      current = {hole: line.startsWith('!'), points: []};
      continue;
    }
    if (line === 'END') {
      if (current.points.length < 3) throw new Error('POLY_RING_TOO_SHORT');
      const [f, l] = [current.points[0], current.points[current.points.length - 1]];
      if (f[0] !== l[0] || f[1] !== l[1]) current.points.push([...f]);
      rings.push(current); current = null; continue;
    }
    const [lon, lat] = line.split(/\s+/).map(Number);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) throw new Error(`POLY_BAD_COORDINATE: ${line}`);
    current.points.push([lon, lat]);
  }
  if (current !== null) throw new Error('POLY_UNTERMINATED_SECTION');
  if (!rings.some(r => !r.hole)) throw new Error('POLY_NO_OUTER_RING');
  return makeRegion(rings);
}

export function readPoly(path) { return parsePoly(readFileSync(path, 'utf8')); }

/** Builds a region from rings: [{hole, points:[[lon,lat],...closed]}]. */
export function makeRegion(rings) {
  const all = rings.flatMap(r => r.points);
  const bbox = {west: Math.min(...all.map(p => p[0])), east: Math.max(...all.map(p => p[0])),
    south: Math.min(...all.map(p => p[1])), north: Math.max(...all.map(p => p[1]))};
  /** Even-odd rule over all rings handles holes. */
  function containsPoint(lon, lat) {
    let inside = false;
    for (const {points} of rings) {
      for (let k = 1; k < points.length; k++) {
        const [x1, y1] = points[k - 1], [x2, y2] = points[k];
        if ((y1 > lat) !== (y2 > lat) && lon < x1 + (lat - y1) * (x2 - x1) / (y2 - y1)) inside = !inside;
      }
    }
    return inside;
  }
  /** 'INSIDE' | 'PARTIAL' | 'OUTSIDE' for a {south,west,north,east} box. */
  function classifyBox(box) {
    if (box.east < bbox.west || box.west > bbox.east || box.north < bbox.south || box.south > bbox.north) return 'OUTSIDE';
    for (const {points} of rings) {
      for (let k = 1; k < points.length; k++) {
        // segmentIntersectsBox takes [lat, lon] points
        if (segmentIntersectsBox([points[k - 1][1], points[k - 1][0]], [points[k][1], points[k][0]], box)) return 'PARTIAL';
      }
    }
    return containsPoint((box.west + box.east) / 2, (box.south + box.north) / 2) ? 'INSIDE' : 'OUTSIDE';
  }
  return {rings, bbox, containsPoint, classifyBox};
}
