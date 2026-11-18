/**
 * Minimal OSM PBF writer (dense nodes, ways, relations; zlib blobs, ≤ 8000 entities per block).
 * Used to store a small area fetched from Overpass in the same format as regional extracts, so the
 * rest of the pipeline (reader, normalizer, exporter) stays the same.
 */
import {deflateSync} from 'node:zlib';
import {writeFileSync, readFileSync} from 'node:fs';
import {readPbfBlobs, decodeHeader} from './pbfReader.js';

class W {
  constructor() { this.parts = []; }
  varint(n) {
    const out = [];
    while (n >= 128) { out.push((n % 128) | 128); n = Math.floor(n / 128); }
    out.push(n); this.parts.push(Buffer.from(out)); return this;
  }
  key(f, wire) { return this.varint(f * 8 + wire); }
  uint(f, n) { return this.key(f, 0).varint(n); }
  sint(f, n) { return this.uint(f, n >= 0 ? n * 2 : -n * 2 - 1); }
  bytes(f, buf) { buf = Buffer.from(buf); return this.key(f, 2).varint(buf.length).raw(buf); }
  str(f, s) { return this.bytes(f, Buffer.from(s, 'utf8')); }
  raw(buf) { this.parts.push(buf); return this; }
  packed(f, values, {signed = false, delta = false} = {}) {
    const p = new W(); let prev = 0;
    for (const v of values) {
      let x = delta ? v - prev : v; prev = v;
      if (signed) x = x >= 0 ? x * 2 : -x * 2 - 1;
      p.varint(x);
    }
    return this.bytes(f, p.done());
  }
  done() { return Buffer.concat(this.parts); }
}

function block(type, payload) {
  const z = deflateSync(payload);
  const blob = new W().uint(2, payload.length).bytes(3, z).done();
  const header = new W().str(1, type).uint(3, blob.length).done();
  const len = Buffer.alloc(4); len.writeUInt32BE(header.length);
  return Buffer.concat([len, header, blob]);
}

const CHUNK = 8000;
const chunks = (list) => { const out = []; for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK)); return out; };

/** One data block: its own string table (Map, linear time). */
function dataBlock(fill) {
  const strings = [''], index = new Map([['', 0]]);
  const sid = s => { let i = index.get(s); if (i === undefined) { i = strings.length; strings.push(s); index.set(s, i); } return i; };
  const group = fill(sid);
  const st = new W(); for (const s of strings) st.bytes(1, Buffer.from(s, 'utf8'));
  return block('OSMData', new W().bytes(1, st.done()).bytes(2, group).uint(17, 100).done());
}

/**
 * nodes: [{id, lat, lon, tags?}], ways: [{id, refs, tags}], relations: [{id, members: [{type, ref, role}], tags}];
 * timestamp: seconds (the OSM data time); bbox: {west, east, south, north}; program: writing program name.
 */
export function buildPbf({nodes = [], ways = [], relations = [], timestamp, bbox, program = 'gamegis-broker'} = {}) {
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new Error('buildPbf: timestamp (seconds) required');
  const head = new W();
  if (bbox) head.bytes(1, new W().sint(1, Math.round(bbox.west * 1e9)).sint(2, Math.round(bbox.east * 1e9))
    .sint(3, Math.round(bbox.north * 1e9)).sint(4, Math.round(bbox.south * 1e9)).done());
  head.str(4, 'OsmSchema-V0.6').str(4, 'DenseNodes').str(16, program).uint(32, timestamp);
  const out = [block('OSMHeader', head.done())];
  const byId = (a, b) => a.id - b.id;
  for (const part of chunks([...nodes].sort(byId))) out.push(dataBlock(sid => {
    const kv = [];
    for (const n of part) { for (const [k, v] of Object.entries(n.tags ?? {})) kv.push(sid(k), sid(v)); kv.push(0); }
    const dense = new W().packed(1, part.map(n => n.id), {signed: true, delta: true})
      .packed(8, part.map(n => Math.round(n.lat * 1e7)), {signed: true, delta: true})
      .packed(9, part.map(n => Math.round(n.lon * 1e7)), {signed: true, delta: true})
      .packed(10, kv).done();
    return new W().bytes(2, dense).done();
  }));
  for (const part of chunks([...ways].sort(byId))) out.push(dataBlock(sid => {
    const g = new W();
    for (const w of part) {
      const e = Object.entries(w.tags ?? {});
      g.bytes(3, new W().uint(1, w.id).packed(2, e.map(([k]) => sid(k))).packed(3, e.map(([, v]) => sid(v)))
        .packed(8, w.refs, {signed: true, delta: true}).done());
    }
    return g.done();
  }));
  for (const part of chunks([...relations].sort(byId))) out.push(dataBlock(sid => {
    const g = new W();
    for (const r of part) {
      const e = Object.entries(r.tags ?? {});
      g.bytes(4, new W().uint(1, r.id).packed(2, e.map(([k]) => sid(k))).packed(3, e.map(([, v]) => sid(v)))
        .packed(8, r.members.map(m => sid(m.role ?? ''))).packed(9, r.members.map(m => m.ref), {signed: true, delta: true})
        .packed(10, r.members.map(m => ({node: 0, way: 1, relation: 2})[m.type])).done());
    }
    return g.done();
  }));
  return Buffer.concat(out);
}

export function writePbf(path, data) { writeFileSync(path, buildPbf(data)); }

/** Byte length of the first block (4-byte length + BlobHeader + Blob) of a PBF buffer. */
function firstBlockLength(buf) {
  const hl = buf.readUInt32BE(0), hb = buf.subarray(4, 4 + hl);
  let pos = 0, dataSize = null;
  const varint = () => { let v = 0, m = 1, b; do { b = hb[pos++]; v += (b & 127) * m; m *= 128; } while (b & 128); return v; };
  while (pos < hb.length) {
    const key = varint(), f = Math.floor(key / 8), w = key % 8;
    if (f === 3 && w === 0) dataSize = varint();
    else if (w === 0) varint();
    else if (w === 2) { const n = varint(); pos += n; }
    else throw new Error('Unexpected BlobHeader field');
  }
  if (dataSize === null) throw new Error('BlobHeader without datasize');
  return 4 + hl + dataSize;
}

/**
 * Writes the OSM data time into a PBF header that has none (some extract servers omit it). Everything after the header
 * block is kept byte for byte. seconds: the data time (e.g. the server's Last-Modified).
 */
export function stampPbfTimestamp(path, seconds) {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error('stampPbfTimestamp: seconds required');
  const buf = readFileSync(path);
  const first = readPbfBlobs(path).next().value;
  if (first?.type !== 'OSMHeader') throw new Error('PBF does not start with OSMHeader');
  const h = decodeHeader(first.data);
  const head = new W();
  if (h.bbox && [h.bbox.west, h.bbox.east, h.bbox.north, h.bbox.south].every(Number.isFinite)) head.bytes(1, new W()
    .sint(1, Math.round(h.bbox.west * 1e9)).sint(2, Math.round(h.bbox.east * 1e9)).sint(3, Math.round(h.bbox.north * 1e9)).sint(4, Math.round(h.bbox.south * 1e9)).done());
  for (const f of h.requiredFeatures) head.str(4, f);
  for (const f of h.optionalFeatures) head.str(5, f);
  head.str(16, `${h.writingProgram ?? 'unknown'} (+data time stamped by gamegis-broker)`);
  if (h.source) head.str(17, h.source);
  head.uint(32, seconds);
  if (h.replicationBaseUrl) head.str(34, h.replicationBaseUrl);
  writeFileSync(path, Buffer.concat([block('OSMHeader', head.done()), buf.subarray(firstBlockLength(buf))]));
}
