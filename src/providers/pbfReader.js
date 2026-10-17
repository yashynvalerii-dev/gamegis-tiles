/**
 * Minimal, dependency-free OpenStreetMap PBF (.osm.pbf) reader.
 * Format: https://wiki.openstreetmap.org/wiki/PBF_Format
 *
 * Reads the file blob by blob (constant memory per blob), inflates zlib blobs with node:zlib,
 * and decodes only the protobuf fields GameGIS needs: header, nodes (plain + dense), ways, relations.
 * No network access. All ids/coordinates stay within Number's safe integer range for real OSM data.
 */
import {openSync, readSync, closeSync, fstatSync} from 'node:fs';
import {inflateSync} from 'node:zlib';

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_BLOB_BYTES = 32 * 1024 * 1024;

export class PbfFormatError extends Error {}
function bad(msg) { throw new PbfFormatError(msg); }

/** Protobuf cursor over a Uint8Array. */
class Pb {
  constructor(buf, start = 0, end = buf.length) { this.buf = buf; this.pos = start; this.end = end; }
  more() { return this.pos < this.end; }
  varint() {
    const b = this.buf; let result = 0, mul = 1, byte;
    do {
      if (this.pos >= this.end) bad('Truncated varint');
      byte = b[this.pos++];
      result += (byte & 0x7f) * mul;
      mul *= 128;
      if (mul > 2 ** 70) bad('Varint too long');
    } while (byte & 0x80);
    return result;
  }
  svarint() { const n = this.varint(); return n % 2 === 0 ? n / 2 : -(n + 1) / 2; }
  /** Reads a field key, returning [fieldNumber, wireType]. */
  key() { const k = this.varint(); return [Math.floor(k / 8), k % 8]; }
  bytes() {
    const len = this.varint(); const s = this.pos; const e = s + len;
    if (e > this.end) bad('Truncated length-delimited field');
    this.pos = e; return [s, e];
  }
  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.bytes();
    else if (wire === 5) this.pos += 4;
    else bad(`Unsupported wire type ${wire}`);
    if (this.pos > this.end) bad('Truncated field');
  }
  sub([s, e]) { return new Pb(this.buf, s, e); }
  /** Decodes packed varints from a byte range into a plain array. */
  packed([s, e], signed = false, delta = false) {
    const p = new Pb(this.buf, s, e); const out = []; let acc = 0;
    while (p.more()) {
      const v = signed ? p.svarint() : p.varint();
      if (delta) { acc += v; out.push(acc); } else out.push(v);
    }
    return out;
  }
}

const utf8 = new TextDecoder('utf-8');

function readExact(fd, length, position) {
  const buf = Buffer.allocUnsafe(length);
  let off = 0;
  while (off < length) {
    const n = readSync(fd, buf, off, length - off, position + off);
    if (n === 0) bad('Unexpected end of file');
    off += n;
  }
  return buf;
}

function decodeBlob(buf) {
  const p = new Pb(buf); let raw = null, zlib = null, rawSize = null;
  while (p.more()) {
    const [f, w] = p.key();
    if (f === 1 && w === 2) raw = p.bytes();
    else if (f === 2 && w === 0) rawSize = p.varint();
    else if (f === 3 && w === 2) zlib = p.bytes();
    else if ((f === 4 || f === 6 || f === 7) && w === 2) bad('Unsupported PBF compression (only raw/zlib)');
    else p.skip(w);
  }
  if (raw) return buf.subarray(raw[0], raw[1]);
  if (zlib) {
    if (rawSize === null || rawSize > MAX_BLOB_BYTES) bad('Invalid blob raw_size');
    const out = inflateSync(buf.subarray(zlib[0], zlib[1]), {maxOutputLength: MAX_BLOB_BYTES});
    if (out.length !== rawSize) bad('Blob size mismatch');
    return out;
  }
  bad('Empty blob');
}

/** Iterates raw file blocks: {type:'OSMHeader'|'OSMData', data:Uint8Array}. */
export function* readPbfBlobs(path) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size; let pos = 0;
    while (pos < size) {
      const headerLen = readExact(fd, 4, pos).readUInt32BE(0); pos += 4;
      if (headerLen === 0 || headerLen > MAX_HEADER_BYTES) bad('Invalid BlobHeader length');
      const hb = readExact(fd, headerLen, pos); pos += headerLen;
      const hp = new Pb(hb); let type = null, dataSize = null;
      while (hp.more()) {
        const [f, w] = hp.key();
        if (f === 1 && w === 2) { const r = hp.bytes(); type = utf8.decode(hb.subarray(r[0], r[1])); }
        else if (f === 3 && w === 0) dataSize = hp.varint();
        else hp.skip(w);
      }
      if (!type || dataSize === null || dataSize > MAX_BLOB_BYTES) bad('Invalid BlobHeader');
      const blob = readExact(fd, dataSize, pos); pos += dataSize;
      yield {type, data: decodeBlob(blob)};
    }
  } finally { closeSync(fd); }
}

/** Decodes OSMHeader block fields used for provenance and safety checks. */
export function decodeHeader(data) {
  const p = new Pb(data);
  const header = {requiredFeatures: [], optionalFeatures: [], bbox: null, replicationTimestamp: null,
    writingProgram: null, source: null, replicationBaseUrl: null};
  const str = r => utf8.decode(data.subarray(r[0], r[1]));
  while (p.more()) {
    const [f, w] = p.key();
    if (f === 1 && w === 2) {
      const b = p.sub(p.bytes()); const v = {};
      while (b.more()) {
        const [bf, bw] = b.key();
        if (bw === 0 && bf >= 1 && bf <= 4) v[['', 'left', 'right', 'top', 'bottom'][bf]] = b.svarint() * 1e-9;
        else b.skip(bw);
      }
      header.bbox = {west: v.left, east: v.right, north: v.top, south: v.bottom};
    } else if (f === 4 && w === 2) header.requiredFeatures.push(str(p.bytes()));
    else if (f === 5 && w === 2) header.optionalFeatures.push(str(p.bytes()));
    else if (f === 16 && w === 2) header.writingProgram = str(p.bytes());
    else if (f === 17 && w === 2) header.source = str(p.bytes());
    else if (f === 32 && w === 0) header.replicationTimestamp = p.varint();
    else if (f === 34 && w === 2) header.replicationBaseUrl = str(p.bytes());
    else p.skip(w);
  }
  const unsupported = header.requiredFeatures.filter(x => !['OsmSchema-V0.6', 'DenseNodes'].includes(x));
  if (unsupported.length) bad(`Unsupported required PBF features: ${unsupported.join(', ')}`);
  return header;
}

function tagsFrom(strings, keys, vals) {
  const tags = {};
  for (let i = 0; i < keys.length; i++) {
    Object.defineProperty(tags, strings[keys[i]], {value: strings[vals[i]], enumerable: true, configurable: true, writable: true});
  }
  return tags;
}

/**
 * Decodes one OSMData block and calls the visitor:
 *   node(id, lat, lon, tags)            tags is {} when the node has none
 *   way(id, refs, tags)
 *   relation(id, members, tags)         members: [{type:'node'|'way'|'relation', ref, role}]
 * Omit a visitor function to skip decoding that element kind cheaply.
 */
export function decodeDataBlock(data, visitor) {
  const p = new Pb(data);
  let strings = [], granularity = 100, latOffset = 0, lonOffset = 0;
  const groups = [];
  while (p.more()) {
    const [f, w] = p.key();
    if (f === 1 && w === 2) {
      const s = p.sub(p.bytes()); strings = [];
      while (s.more()) {
        const [sf, sw] = s.key();
        if (sf === 1 && sw === 2) { const r = s.bytes(); strings.push(utf8.decode(data.subarray(r[0], r[1]))); }
        else s.skip(sw);
      }
    } else if (f === 2 && w === 2) groups.push(p.bytes());
    else if (f === 17 && w === 0) granularity = p.varint();
    else if (f === 19 && w === 0) latOffset = p.varint();
    else if (f === 20 && w === 0) lonOffset = p.varint();
    else p.skip(w);
  }
  const coord = (offset, v) => Math.round((offset + granularity * v)) / 1e9;
  for (const range of groups) {
    const g = p.sub(range);
    while (g.more()) {
      const [f, w] = g.key();
      if (w !== 2) { g.skip(w); continue; }
      const r = g.bytes();
      if (f === 1 && visitor.node) decodeNode(g.sub(r));
      else if (f === 2 && visitor.node) decodeDense(g.sub(r));
      else if (f === 3 && visitor.way) decodeWay(g.sub(r));
      else if (f === 4 && visitor.relation) decodeRelation(g.sub(r));
    }
  }

  function decodeNode(n) {
    let id = 0, lat = 0, lon = 0, keys = [], vals = [];
    while (n.more()) {
      const [f, w] = n.key();
      if (f === 1 && w === 0) id = n.svarint();
      else if (f === 2 && w === 2) keys = n.packed(n.bytes());
      else if (f === 3 && w === 2) vals = n.packed(n.bytes());
      else if (f === 8 && w === 0) lat = n.svarint();
      else if (f === 9 && w === 0) lon = n.svarint();
      else n.skip(w);
    }
    visitor.node(id, coord(latOffset, lat), coord(lonOffset, lon), tagsFrom(strings, keys, vals));
  }
  function decodeDense(d) {
    let ids = [], lats = [], lons = [], kv = null;
    while (d.more()) {
      const [f, w] = d.key();
      if (f === 1 && w === 2) ids = d.packed(d.bytes(), true, true);
      else if (f === 8 && w === 2) lats = d.packed(d.bytes(), true, true);
      else if (f === 9 && w === 2) lons = d.packed(d.bytes(), true, true);
      else if (f === 10 && w === 2) kv = d.packed(d.bytes());
      else d.skip(w);
    }
    if (ids.length !== lats.length || ids.length !== lons.length) bad('DenseNodes array length mismatch');
    let k = 0;
    for (let i = 0; i < ids.length; i++) {
      let tags = {};
      if (kv) {
        const keys = [], vals = [];
        while (k < kv.length && kv[k] !== 0) { keys.push(kv[k]); vals.push(kv[k + 1]); k += 2; }
        k++;
        if (keys.length) tags = tagsFrom(strings, keys, vals);
      }
      visitor.node(ids[i], coord(latOffset, lats[i]), coord(lonOffset, lons[i]), tags);
    }
  }
  function decodeWay(wp) {
    let id = 0, keys = [], vals = [], refs = [];
    while (wp.more()) {
      const [f, w] = wp.key();
      if (f === 1 && w === 0) id = wp.varint();
      else if (f === 2 && w === 2) keys = wp.packed(wp.bytes());
      else if (f === 3 && w === 2) vals = wp.packed(wp.bytes());
      else if (f === 8 && w === 2) refs = wp.packed(wp.bytes(), true, true);
      else wp.skip(w);
    }
    visitor.way(id, refs, tagsFrom(strings, keys, vals));
  }
  function decodeRelation(rp) {
    let id = 0, keys = [], vals = [], roles = [], memids = [], types = [];
    while (rp.more()) {
      const [f, w] = rp.key();
      if (f === 1 && w === 0) id = rp.varint();
      else if (f === 2 && w === 2) keys = rp.packed(rp.bytes());
      else if (f === 3 && w === 2) vals = rp.packed(rp.bytes());
      else if (f === 8 && w === 2) roles = rp.packed(rp.bytes());
      else if (f === 9 && w === 2) memids = rp.packed(rp.bytes(), true, true);
      else if (f === 10 && w === 2) types = rp.packed(rp.bytes());
      else rp.skip(w);
    }
    if (memids.length !== types.length || memids.length !== roles.length) bad('Relation member array length mismatch');
    const members = memids.map((ref, i) => ({type: ['node', 'way', 'relation'][types[i]] ?? bad('Bad member type'),
      ref, role: strings[roles[i]] ?? ''}));
    visitor.relation(id, members, tagsFrom(strings, keys, vals));
  }
}

/** Convenience: one full pass over a file. Returns the decoded header. */
export function scanPbf(path, visitor) {
  let header = null;
  for (const {type, data} of readPbfBlobs(path)) {
    if (type === 'OSMHeader') header = decodeHeader(data);
    else if (type === 'OSMData') { if (!header) bad('OSMData before OSMHeader'); decodeDataBlock(data, visitor); }
  }
  if (!header) bad('Missing OSMHeader');
  return header;
}
