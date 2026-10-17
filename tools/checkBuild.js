#!/usr/bin/env node
/**
 * Build watchdog: compares a fresh export-report.json with the one currently published, so a broken
 * weekly build never silently replaces good tiles.
 *   BLOCK (exit 1, the site is NOT updated, GitHub e-mails the repository owner):
 *     a permanent region disappeared, lost more than blockDropShare of its READY tiles, the site is empty,
 *     or the site is above hardLimitMB (GitHub Pages allows ~1 GB).
 *   WARN (published, listed in build-check.json): smaller READY drops, many new INCOMPLETE tiles,
 *     fast size growth, storage close to the region-requests budget.
 * Requested regions may legitimately grow, shrink or disappear; they are reported for information only.
 *
 *   node tools/checkBuild.js --next site/export-report.json [--prev prev-report.json] [--config regions.json]
 *        [--out site/build-check.json] [--accept]   (--accept: publish even when blocked, after a human check)
 */
import {readFileSync, writeFileSync, existsSync, appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const CHECK_DEFAULTS = Object.freeze({blockDropShare: 0.10, warnDropShare: 0.01, warnNewIncomplete: 10,
  warnGrowthShare: 0.25, warnBudgetShare: 0.9, hardLimitMB: 950});

const MB = 1048576;
const byId = report => new Map((report?.regions ?? []).map(r => [r.id, r]));

export function compareReports(prev, next, {pinnedIds = null, budgetMB = null, ...o} = {}) {
  const t = {...CHECK_DEFAULTS, ...o};
  const findings = [];
  const add = (level, code, message, region) => findings.push({level, code, ...(region ? {region} : {}), message});
  const isPinned = r => (pinnedIds ? pinnedIds.includes(r.id) : (r.kind ?? 'pinned') === 'pinned');
  const nextById = byId(next);

  if (!next?.bundles) add('BLOCK', 'EMPTY_SITE', 'the new build has no bundles');
  const sizeMB = (next?.storedBytes ?? 0) / MB;
  if (sizeMB > t.hardLimitMB) add('BLOCK', 'SITE_TOO_LARGE', `${sizeMB.toFixed(0)} MB > ${t.hardLimitMB} MB`);
  else if (budgetMB && sizeMB > budgetMB * t.warnBudgetShare) add('WARN', 'STORAGE_NEARLY_FULL', `${sizeMB.toFixed(0)} of ${budgetMB} MB`);

  for (const p of prev?.regions ?? []) {
    const n = nextById.get(p.id);
    if (!isPinned(p)) { if (!n) add('INFO', 'REQUESTED_REGION_REMOVED', 'requested area no longer built', p.id); continue; }
    if (!n) { add('BLOCK', 'REGION_MISSING', 'permanent region missing from the new build', p.id); continue; }
    const before = p.tiles?.READY ?? 0, after = n.tiles?.READY ?? 0;
    const drop = before ? (before - after) / before : 0;
    if (drop > t.blockDropShare) add('BLOCK', 'READY_DROP', `READY ${before} -> ${after} (-${(drop * 100).toFixed(1)}%)`, p.id);
    else if (drop > t.warnDropShare) add('WARN', 'READY_DROP', `READY ${before} -> ${after} (-${(drop * 100).toFixed(1)}%)`, p.id);
    const inc = (n.tiles?.INCOMPLETE ?? 0) - (p.tiles?.INCOMPLETE ?? 0);
    if (inc > Math.max(t.warnNewIncomplete, (p.tiles?.INCOMPLETE ?? 0) * 0.5))
      add('WARN', 'INCOMPLETE_GROWTH', `INCOMPLETE +${inc} (${JSON.stringify(n.incompleteReasons ?? {})})`, p.id);
  }
  for (const n of next?.regions ?? []) if (!byId(prev).has(n.id)) add('INFO', 'REGION_ADDED', 'new region', n.id);
  if (prev?.storedBytes && next?.storedBytes) {
    const g = next.storedBytes / prev.storedBytes - 1;
    if (g > t.warnGrowthShare) add('WARN', 'SIZE_GROWTH', `${(prev.storedBytes / MB).toFixed(0)} -> ${sizeMB.toFixed(0)} MB (+${(g * 100).toFixed(0)}%)`);
  }
  const status = findings.some(f => f.level === 'BLOCK') ? 'BLOCK' : findings.some(f => f.level === 'WARN') ? 'WARN' : 'OK';
  const totals = r => ({bundles: r?.bundles ?? 0, storedMB: Math.round((r?.storedBytes ?? 0) / MB),
    regions: Object.fromEntries((r?.regions ?? []).map(x => [x.id, {READY: x.tiles?.READY ?? 0, INCOMPLETE: x.tiles?.INCOMPLETE ?? 0}]))});
  return {status, findings, previous: prev ? totals(prev) : null, current: totals(next)};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), opt = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const read = p => (p && existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
  const config = read(opt('--config'));
  let prev = null;
  try { prev = read(opt('--prev')); } catch { prev = null; }        // first build or unreadable: nothing to compare
  const result = {checkedAt: new Date().toISOString(), ...compareReports(prev, read(opt('--next')), {
    pinnedIds: config ? config.regions.map(r => r.id) : null, budgetMB: config?.regionRequests?.budgetMB ?? null})};
  const accepted = a.includes('--accept') && result.status === 'BLOCK';
  if (accepted) result.acceptedByHuman = true;
  if (opt('--out')) writeFileSync(opt('--out'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, ['', `## Build check: ${result.status}${accepted ? ' (accepted by a human)' : ''}`, '',
    ...result.findings.map(f => `- **${f.level}** ${f.code}${f.region ? ` (${f.region})` : ''}: ${f.message}`), ''].join('\n'));
  if (result.status === 'BLOCK' && !accepted) process.exitCode = 1;
}
