/** Pure bounding-box helpers shared by importers and exporters (no I/O). Boxes: {south, west, north, east}. */
export const inBox = (b, lat, lon) => lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;

/** True if segment (a,b) touches the box. Points are [lat, lon]. Liang-Barsky clipping in (lon=x, lat=y). */
export function segmentIntersectsBox(a, b, box) {
  if (inBox(box, a[0], a[1]) || inBox(box, b[0], b[1])) return true;
  if (Math.max(a[0], b[0]) < box.south || Math.min(a[0], b[0]) > box.north ||
      Math.max(a[1], b[1]) < box.west || Math.min(a[1], b[1]) > box.east) return false;
  let t0 = 0, t1 = 1;
  const dx = b[1] - a[1], dy = b[0] - a[0];
  for (const [p, q] of [[-dx, a[1] - box.west], [dx, box.east - a[1]], [-dy, a[0] - box.south], [dy, box.north - a[0]]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return true;
}
