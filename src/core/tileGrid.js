/** Web Mercator (XYZ) tile planning. Pure logic: no provider, DB, or network. */
export const TILE_ZOOM = 15;
export const MAX_MERCATOR_LAT = 85.0511287798066;
const EARTH_RADIUS_M = 6371008.8;
const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const N = 2 ** TILE_ZOOM;

function finite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${name} must be finite number`);
  return value;
}
function latitude(value) {
  finite(value, 'latitude');
  if (Math.abs(value) >= MAX_MERCATOR_LAT) throw new RangeError('latitude outside Web Mercator tiles');
  return value;
}
function longitude(value) {
  finite(value, 'longitude');
  if (value < -180 || value > 180) throw new RangeError('longitude outside [-180,180]');
  return value;
}
export function validateTile(tile) {
  if (!tile || !Number.isInteger(tile.z) || tile.z !== TILE_ZOOM ||
      !Number.isInteger(tile.x) || tile.x < 0 || tile.x >= N ||
      !Number.isInteger(tile.y) || tile.y < 0 || tile.y >= N) {
    throw new TypeError('Invalid MVP tile z/x/y');
  }
  return { z: TILE_ZOOM, x: tile.x, y: tile.y };
}
export const tileId = tile => { const t = validateTile(tile); return `${t.z}/${t.x}/${t.y}`; };
const yCoord = lat => N * (1 - Math.asinh(Math.tan(lat * RAD)) / Math.PI) / 2;
const xCoord = lon => N * (lon + 180) / 360;
export function tileForPoint(lat, lon) {
  lat = latitude(lat); lon = longitude(lon);
  return { z: TILE_ZOOM, x: Math.max(0, Math.min(N - 1, Math.floor(xCoord(lon)))),
    y: Math.max(0, Math.min(N - 1, Math.floor(yCoord(lat)))) };
}
function latForY(y) { return Math.atan(Math.sinh(Math.PI * (1 - 2 * y / N))) * DEG; }
export function boundsForTile(tile) {
  const {x,y} = validateTile(tile);
  return { west: x / N * 360 - 180, east: (x + 1) / N * 360 - 180,
    north: latForY(y), south: latForY(y + 1) };
}
export function validateBbox(bbox) {
  if (!bbox || typeof bbox !== 'object' || Array.isArray(bbox)) throw new TypeError('bbox object required');
  const north = latitude(bbox.north), south = latitude(bbox.south);
  const west = longitude(bbox.west), east = longitude(bbox.east);
  if (north <= south) throw new RangeError('bbox north must exceed south');
  if (west === east) throw new RangeError('bbox has zero longitude width');
  return { north, south, west, east }; // west > east means crosses anti-meridian
}
function intervalTiles(west, east) {
  const left = Math.max(0, Math.min(N - 1, Math.floor(xCoord(west))));
  const right = Math.max(0, Math.min(N - 1, Math.ceil(xCoord(east)) - 1));
  const xs=[]; for(let x=left; x<=right; x++) xs.push(x);
  return xs;
}
function maxTilesLimit(maxTiles) {
  if (!Number.isInteger(maxTiles) || maxTiles < 1 || maxTiles > 4096) throw new RangeError('maxTiles must be integer 1..4096');
  return maxTiles;
}
export function tilesForBbox(bbox, { maxTiles=16 } = {}) {
  const b = validateBbox(bbox); maxTilesLimit(maxTiles);
  const first = Math.max(0, Math.min(N-1, Math.floor(yCoord(b.north))));
  const last = Math.max(0, Math.min(N-1, Math.ceil(yCoord(b.south)) - 1));
  const xs = b.west < b.east ? intervalTiles(b.west,b.east) :
    [...intervalTiles(b.west,180), ...intervalTiles(-180,b.east)];
  if ((last-first+1)*xs.length > maxTiles) throw new RangeError('AREA_EXCEEDS_TILE_LIMIT');
  const results=[];
  for (let y=first; y<=last; y++) for (const x of xs) results.push({z:TILE_ZOOM,x,y});
  return results.sort((a,b)=>a.y-b.y || a.x-b.x);
}
function shortestLonDelta(a,b) { return ((a-b+540)%360)-180; }
function haversine(lat1, lon1, lat2, lon2) {
  const a=((lat2-lat1)*RAD)/2, b=(shortestLonDelta(lon2,lon1)*RAD)/2;
  const h=Math.sin(a)**2+Math.cos(lat1*RAD)*Math.cos(lat2*RAD)*Math.sin(b)**2;
  return 2*EARTH_RADIUS_M*Math.asin(Math.min(1,Math.sqrt(h)));
}
function nearestLon(lon,west,east) {
  if (lon>=west && lon<=east) return lon;
  return Math.abs(shortestLonDelta(lon,west))<Math.abs(shortestLonDelta(lon,east))?west:east;
}
export function tilesForCircle({center,radiusM}, {maxTiles=16} = {}) {
  if (!center || typeof center !== 'object') throw new TypeError('center required');
  const lat=latitude(center.lat), lon=longitude(center.lon);
  finite(radiusM,'radiusM'); if (radiusM<=0 || radiusM>20000) throw new RangeError('radiusM out of bounds');
  const latDelta=radiusM/EARTH_RADIUS_M*DEG*1.00001;
  const north=lat+latDelta, south=lat-latDelta;
  if (Math.abs(north)>=MAX_MERCATOR_LAT || Math.abs(south)>=MAX_MERCATOR_LAT) throw new RangeError('circle outside Web Mercator tiles');
  const lonDelta=radiusM/(EARTH_RADIUS_M*Math.cos(Math.max(Math.abs(north),Math.abs(south))*RAD))*DEG*1.00001;
  if(lonDelta>=180) throw new RangeError('circle is too large');
  let west=lon-lonDelta, east=lon+lonDelta;
  if(west < -180) west+=360;
  if(east > 180) east-=360;
  // Find candidates first, then keep tiles whose geodesic distance to their
  // rectangular region can be <= radius. Edges count as intersection.
  const candidates=tilesForBbox({north,south,west,east},{maxTiles:4096});
  const keep=candidates.filter(t=>{
    const b=boundsForTile(t);
    const nlat=Math.max(b.south,Math.min(lat,b.north));
    const nlon=nearestLon(lon,b.west,b.east);
    return haversine(lat,lon,nlat,nlon)<=radiusM+0.02;
  });
  if (keep.length>maxTiles) throw new RangeError('AREA_EXCEEDS_TILE_LIMIT');
  return keep;
}
/** Conservative ~meters margin in both axis directions for bbox completeness. */
export function expandedTileBounds(tile, bufferM=30) {
  finite(bufferM,'bufferM'); if(bufferM<0 || bufferM>1000) throw new RangeError('invalid tile buffer');
  const b=boundsForTile(tile);
  const dlat=bufferM/EARTH_RADIUS_M*DEG;
  const dlon=bufferM/(EARTH_RADIUS_M*Math.cos(Math.max(Math.abs(b.north),Math.abs(b.south))*RAD))*DEG;
  if(b.north+dlat>=MAX_MERCATOR_LAT || b.south-dlat<=-MAX_MERCATOR_LAT ||
    b.west-dlon < -180 || b.east+dlon > 180) {
    // We do not certify edge/polar buffered tiles without proper wrapped scopes.
    throw new RangeError('BUFFERED_TILE_OUTSIDE_SUPPORTED_BOUNDS');
  }
  return {north:b.north+dlat,south:b.south-dlat,west:b.west-dlon,east:b.east+dlon};
}
export function bboxContainsBbox(outer,inner) {
  const a=validateBbox(outer), b=validateBbox(inner);
  return a.west<=a.east && b.west<=b.east &&
    a.north>=b.north && a.south<=b.south && a.west<=b.west && a.east>=b.east;
}
