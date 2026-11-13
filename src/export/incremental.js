/**
 * Incremental site builds (owner 2026-11-07, "really smart demand"): a build triggered by a game's request rebuilds
 * only the regions whose definition changed (a new or resized requested area) and copies every other region's bundles
 * from the currently published site, checking each against the published SHA-256. The weekly build and builds after a
 * code change stay full, so OSM data and the pipeline are still refreshed everywhere.
 *
 * A region is reused only when the published export report knows it with the SAME fingerprint (definition, extract,
 * normalizer, bundle format, zoom, buffer, precision) and lists its bundles, and the published manifest still has all
 * of them. Anything doubtful falls back to rebuilding that region (fail safe = slower, never wrong).
 */
import {createHash} from 'node:crypto';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {NORMALIZATION_VERSION} from '../gis/normalizer.js';
import {BUNDLE_FORMAT} from './regionExporter.js';

const sha256 = b => createHash('sha256').update(b).digest('hex');

/** Stable identity of what a region's bundles were built from. */
export function regionFingerprint(def, {kind = 'base', bundleZoom = 13, bufferM = 40} = {}) {
  const what = {kind, id: def.id, extract: def.extract, publish: def.publish ?? null, precision: def.precision ?? 5,
    normalizationVersion: NORMALIZATION_VERSION, bundleFormat: BUNDLE_FORMAT, bundleZoom, bufferM};
  return sha256(JSON.stringify(what)).slice(0, 16);
}

/** Bundles of a region in the published manifest: base bundles, or the bundles of its precise layer. */
function publishedBundles(manifest, entry) {
  if (entry.kind === 'precise') return manifest?.precise?.[entry.precision]?.bundles ?? null;
  return manifest?.bundles ?? null;
}

/**
 * Decides per region: reuse from the published site or rebuild.
 * defs: [{def, kind: 'base' | 'precise'}]. Returns {reuse: [{def, kind, entry}], rebuild: [{def, kind, reason}]}.
 */
export function planIncremental(defs, prevReport, prevManifest, {bundleZoom = 13, bufferM = 40} = {}) {
  const reuse = [], rebuild = [];
  const prev = new Map((prevReport?.regions ?? []).map(r => [`${r.kind === 'precise' ? 'precise' : 'base'}:${r.id}`, r]));
  const sameNormalizer = prevManifest?.normalizationVersion === NORMALIZATION_VERSION;
  for (const {def, kind} of defs) {
    const entry = prev.get(`${kind}:${def.id}`);
    const fp = regionFingerprint(def, {kind, bundleZoom, bufferM});
    let reason = null;
    if (!prevManifest || !prevReport) reason = 'NO_PUBLISHED_SITE';
    else if (!sameNormalizer) reason = 'NORMALIZER_CHANGED';
    else if (!entry) reason = 'NEW_REGION';
    else if (entry.fingerprint !== fp) reason = entry.fingerprint ? 'DEFINITION_CHANGED' : 'NO_FINGERPRINT';
    else if (!Array.isArray(entry.bundleKeys)) reason = 'NO_BUNDLE_LIST';
    else {
      const bundles = publishedBundles(prevManifest, entry);
      if (!bundles || !entry.bundleKeys.every(k => bundles[k])) reason = 'BUNDLES_MISSING';
    }
    if (reason) rebuild.push({def, kind, reason}); else reuse.push({def, kind, entry});
  }
  return {reuse, rebuild};
}

/**
 * Copies the bundles of reused regions from the published site into outDir, verifying each SHA-256.
 * Returns parts in the shape the exporter produces: {def, kind, manifest: {bundles, dataTimestamp, bundlePath}, entry}.
 * Throws on any mismatch or download error (the caller then rebuilds fully).
 */
export async function copyReusedRegions(reuse, prevManifest, {baseUrl, outDir, fetchImpl = fetch, concurrency = 8, log = () => {}, retries = 4, retryDelayMs = 2000} = {}) {
  const jobs = [];
  const parts = reuse.map(({def, kind, entry}) => {
    const layer = kind === 'precise' ? prevManifest.precise[entry.precision] : prevManifest;
    const bundles = Object.fromEntries(entry.bundleKeys.map(k => [k, layer.bundles[k]]));
    for (const [key, meta] of Object.entries(bundles)) {
      const [z, x, y] = key.split('/');
      const rel = layer.bundlePath.replace('{z}', z).replace('{x}', x).replace('{y}', y);
      jobs.push({rel, meta});
    }
    const dataTimestamp = kind === 'precise' ? prevManifest.dataTimestamp
      : (prevManifest.regions ?? []).find(r => r.id === def.id)?.dataTimestamp ?? prevManifest.dataTimestamp;
    return {def, kind, entry, manifest: {...pickBase(prevManifest), bundlePath: layer.bundlePath, bundles, dataTimestamp}};
  });
  const seen = new Set(), unique = jobs.filter(j => !seen.has(j.rel) && seen.add(j.rel));
  let i = 0, done = 0;
  const worker = async () => {
    while (i < unique.length) {
      const {rel, meta} = unique[i++];
      // Pages answers 503 now and then (2026-11-12): retry a few times before giving up.
      let res;
      for (let attempt = 1; ; attempt++) {
        try { res = await fetchImpl(new URL(rel, baseUrl).href, {cache: 'no-store'}); } catch (e) { res = {ok: false, status: e.message}; }
        if (res.ok || attempt >= retries || (typeof res.status === 'number' && res.status < 500 && res.status !== 429)) break;
        await new Promise(r => setTimeout(r, retryDelayMs * attempt));
      }
      if (!res.ok) throw new Error(`REUSE_DOWNLOAD_FAILED ${rel}: HTTP ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (sha256(bytes) !== meta.sha256) throw new Error(`REUSE_CHECKSUM_MISMATCH ${rel}`);
      const path = join(outDir, rel);
      mkdirSync(dirname(path), {recursive: true});
      writeFileSync(path, bytes);
      if (++done % 200 === 0) log(`  reused ${done}/${unique.length} bundles`);
    }
  };
  await Promise.all(Array.from({length: Math.min(concurrency, unique.length)}, worker));
  log(`  reused ${unique.length} bundles from the published site (SHA-256 verified)`);
  return parts;
}

/** Fields every per-region manifest shares (the exporter's manifest without its bundles). */
function pickBase(m) {
  const {format, datasetId, normalizationVersion, provider, tileZoom, bundleZoom, bufferM, bundleEncoding, license, poiLayer} = m;
  return {format, datasetId, normalizationVersion, provider, tileZoom, bundleZoom, bufferM, bundleEncoding, license,
    ...(poiLayer ? {poiLayer} : {})};
}
