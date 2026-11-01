/**
 * OSM tag classification for GameGIS Broker Stage 3.
 * Adapted from an earlier in-house prototype.
 * These predicates ONLY classify source data; they never reject game positions.
 */
const WALKABLE_TYPES = new Set([
  'footway', 'path', 'pedestrian', 'living_street', 'track', 'steps',
]);
const PRIVATE_ACCESS = new Set(['private', 'no', 'customers', 'permit']);

const value = (tags, key) => String(tags?.[key] ?? '').trim().toLowerCase();
const active = (tags, key) => Boolean(value(tags, key)) && value(tags, key) !== 'no';

export function isRestrictedAccess(tags = {}) {
  return PRIVATE_ACCESS.has(value(tags, 'access')) ||
    ['private', 'no'].includes(value(tags, 'foot'));
}

export function isWalkableTags(tags = {}) {
  const highway = value(tags, 'highway');
  if (!WALKABLE_TYPES.has(highway) || isRestrictedAccess(tags)) return false;
  return !(highway === 'track' && value(tags, 'access') === 'agricultural');
}

export function isBuildingTags(tags = {}) {
  return active(tags, 'building');
}

export function isWaterTags(tags = {}) {
  return value(tags, 'natural') === 'water' || active(tags, 'water') ||
    value(tags, 'waterway') === 'riverbank' || value(tags, 'landuse') === 'reservoir';
}

export function isRailwayTags(tags = {}) {
  return active(tags, 'railway');
}

// military=* values that map LINES (obstacles), not territories.
const LINEAR_MILITARY = new Set(['trench']);
export const isLinearMilitary = (tags = {}) => LINEAR_MILITARY.has(value(tags, 'military'));

export function isRestrictedAreaTags(tags = {}) {
  return ['industrial', 'military'].includes(value(tags, 'landuse')) ||
    (active(tags, 'military') && !isLinearMilitary(tags)) ||
    ((value(tags, 'area') === 'yes' || isBuildingTags(tags) || isWaterTags(tags)) &&
      ['private', 'no'].includes(value(tags, 'access')));
}

export function isEntranceTags(tags = {}) {
  return active(tags, 'entrance');
}

const POWER_WAYS = new Set(['line', 'minor_line', 'substation']);
const POWER_POINTS = new Set(['tower', 'pole', 'substation']);

/** Overhead power lines and substation outlines (location tags are kept for clients to interpret). */
export function isPowerWayTags(tags = {}) {
  return POWER_WAYS.has(value(tags, 'power'));
}

export function isPowerPointTags(tags = {}) {
  return POWER_POINTS.has(value(tags, 'power'));
}

/**
 * Points of interest (POI layer, contract poiLayer v1, owner 2026-10-31). The order is the priority used when a tile
 * holds more POIs than the per-tile cap. poiKind strings are a STABLE vocabulary: only additions, never renames.
 */
export const POI_KINDS = Object.freeze([
  'tourism=artwork', 'tourism=viewpoint', 'tourism=attraction',
  'historic=memorial', 'historic=monument', 'historic=wayside_cross', 'historic=wayside_shrine',
  'historic=boundary_stone', 'historic=ruins',
  'amenity=fountain', 'amenity=drinking_water', 'amenity=place_of_worship',
  'man_made=tower', 'man_made=water_tower', 'man_made=obelisk',
  'natural=peak', 'natural=tree',
]);
const POI_KIND_SET = new Set(POI_KINDS);
const POI_KEYS = ['tourism', 'historic', 'amenity', 'man_made', 'natural'];

/**
 * The poiKind of an OSM object, or null. Excluded on purpose: benches, playgrounds, parks, cemeteries, schools and
 * kindergartens (not in the list), Stolpersteine (memorial plaques in front of homes), unnamed attractions, ordinary
 * trees (only natural monuments), private or closed objects and anything on railway land.
 */
export function poiKindFor(tags = {}) {
  if (['private', 'no'].includes(value(tags, 'access')) || active(tags, 'railway')) return null;
  for (const key of POI_KEYS) {
    const kind = `${key}=${value(tags, key)}`;
    if (!POI_KIND_SET.has(kind)) continue;
    if (kind === 'historic=memorial' && value(tags, 'memorial') === 'stolperstein') return null;
    if (kind === 'tourism=attraction' && !String(tags.name ?? '').trim()) continue;
    if (kind === 'natural=tree' && value(tags, 'denotation') !== 'natural_monument') continue;
    return kind;
  }
  return null;
}
export const isPoiTags = (tags = {}) => poiKindFor(tags) !== null;

/** Areas where no POI is published even if a POI lies inside (in addition to restricted areas). */
export function isPoiExclusionAreaTags(tags = {}) {
  return ['cemetery', 'railway'].includes(value(tags, 'landuse')) ||
    ['grave_yard', 'school', 'kindergarten', 'childcare'].includes(value(tags, 'amenity'));
}

/** Nodes published as standalone point features. */
export function isPointFeatureTags(tags = {}) {
  return isEntranceTags(tags) || isPowerPointTags(tags) || isPoiTags(tags);
}

/** Supplementary lines (owner 2026-11-01, gameplay safety/reachability): busy roads and big waterways. */
const MAJOR_ROADS = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);
const MAJOR_WATERWAYS = new Set(['river', 'canal']);
export const isMajorRoadTags = (tags = {}) => MAJOR_ROADS.has(value(tags, 'highway'));
export const isMajorWaterwayTags = (tags = {}) => MAJOR_WATERWAYS.has(value(tags, 'waterway'));

/** Ways / relations to keep when reading an extract beyond the base classes: POIs, their exclusion areas, extra lines. */
export function isPoiRelatedTags(tags = {}) {
  return isPoiTags(tags) || isPoiExclusionAreaTags(tags) || isMajorRoadTags(tags) || isMajorWaterwayTags(tags);
}

/** OSM way roles, no game placement decisions or implicit distance buffers. */
export function classifyWayTags(tags = {}) {
  const classes = [];
  if (isWalkableTags(tags)) classes.push('walkable');
  if (isBuildingTags(tags)) classes.push('building');
  if (isWaterTags(tags)) classes.push('water');
  if (isRailwayTags(tags)) classes.push('railway');
  if (isPowerWayTags(tags)) classes.push('power');
  if (isRestrictedAreaTags(tags)) classes.push('restricted_area');
  else if (isRestrictedAccess(tags) || isLinearMilitary(tags)) classes.push('restricted_way');
  return classes;
}

/** In Stage 3 these relation classes require future multipolygon reconstruction. */
export function requiresRelationSupport(tags = {}) {
  return isBuildingTags(tags) || isWaterTags(tags) || isRestrictedAreaTags(tags) ||
    (value(tags, 'type') === 'multipolygon' && ['private', 'no'].includes(value(tags, 'access')));
}
