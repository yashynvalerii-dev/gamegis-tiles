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

export function isRestrictedAreaTags(tags = {}) {
  return ['industrial', 'military'].includes(value(tags, 'landuse')) ||
    active(tags, 'military') ||
    ((value(tags, 'area') === 'yes' || isBuildingTags(tags) || isWaterTags(tags)) &&
      ['private', 'no'].includes(value(tags, 'access')));
}

export function isEntranceTags(tags = {}) {
  return active(tags, 'entrance');
}

/** OSM way roles, no game placement decisions or implicit distance buffers. */
export function classifyWayTags(tags = {}) {
  const classes = [];
  if (isWalkableTags(tags)) classes.push('walkable');
  if (isBuildingTags(tags)) classes.push('building');
  if (isWaterTags(tags)) classes.push('water');
  if (isRailwayTags(tags)) classes.push('railway');
  if (isRestrictedAreaTags(tags)) classes.push('restricted_area');
  else if (isRestrictedAccess(tags)) classes.push('restricted_way');
  return classes;
}

/** In Stage 3 these relation classes require future multipolygon reconstruction. */
export function requiresRelationSupport(tags = {}) {
  return isBuildingTags(tags) || isWaterTags(tags) || isRestrictedAreaTags(tags) ||
    (value(tags, 'type') === 'multipolygon' && ['private', 'no'].includes(value(tags, 'access')));
}
