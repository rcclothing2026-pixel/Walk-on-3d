#!/usr/bin/env node
/**
 * Builds a deployable bundle per tour.
 *
 * Vite produces one page and one set of assets. This copies that page once per
 * tour, alongside that tour's data and floor plan, so each ends up as a
 * self-contained directory:
 *
 *   dist/<slug>/index.html
 *   dist/<slug>/assets/…
 *   dist/<slug>/data/*.json
 *   dist/<slug>/floorplan.png
 *   dist/<slug>/panos/…        ← uploaded separately, see below
 *
 * That shape is the point of the whole layout: a finished tour is one directory
 * a customer can be given, with nothing shared and nothing else able to see it.
 *
 * Panoramas are deliberately NOT copied. They are hundreds of megabytes per
 * venue, they change independently of the code, and they are destined for
 * object storage. Upload panos/<slug>/ into <bundle>/panos/ separately, or
 * point VITE_PANO_BASE_URL at a bucket.
 */

import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { RENDITION_ORDER } from '../src/lib/paths.js';
import { ROOT, TOUR_FILES, listTours, readJson, tourPaths } from './tours.js';
import { loadRoster } from './roster.js';

const DIST = path.join(ROOT, 'dist');

/** Acceptance criterion from the original brief. */
const WALK_NODES = 10;
const WALK_BUDGET_BYTES = 15 * 1024 * 1024;

main().catch((err) => {
  console.error(`\n${red('Bundle failed:')} ${err.stack || err.message}`);
  process.exitCode = 1;
});

async function main() {
  await assertBuilt();

  const only = process.argv.find((arg) => arg.startsWith('--tour='))?.slice('--tour='.length);
  const slugs = only ? [only] : await listTours();

  if (!slugs.length) throw new Error('No tours to bundle.');

  // Vite's own output is the shared shell every tour copies.
  const shell = await collectShell();

  for (const slug of slugs) await bundleTour(slug, shell);

  await cleanShell(shell);
  console.log('');
}

/** The page and assets Vite emitted, before they are copied per tour. */
async function collectShell() {
  const entries = await readdir(DIST, { withFileTypes: true });
  return entries.filter((e) => e.name !== 'panos').map((e) => e.name);
}

async function bundleTour(slug, shell) {
  const paths = await tourPaths(slug);
  const target = path.join(DIST, slug);

  await rm(target, { recursive: true, force: true });
  await mkdir(path.join(target, 'data'), { recursive: true });

  for (const name of shell) {
    await cp(path.join(DIST, name), path.join(target, name), { recursive: true });
  }

  // Only the files a viewer needs. sources.json maps nodes to the
  // photographer's originals and is nobody else's business.
  for (const key of ['tour', 'names', 'nodes', 'brands']) {
    const from = paths.file(key);
    if (!(await exists(from))) continue;
    await cp(from, path.join(target, 'data', TOUR_FILES[key].file));
  }

  if (await exists(paths.floorplan)) {
    await cp(paths.floorplan, path.join(target, 'floorplan.png'));
  }

  // The slug has to survive into the built page: production resolves data
  // relative to index.html, but the viewer still reports which tour it is.
  await writeFile(
    path.join(target, 'data', 'bundle.json'),
    `${JSON.stringify({ slug, builtFrom: 'tours/' + slug }, null, 2)}\n`,
  );

  await report(slug, paths, target);
}

/** Removes Vite's loose output once every tour has its own copy. */
async function cleanShell(shell) {
  for (const name of shell) await rm(path.join(DIST, name), { recursive: true, force: true });
}

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

async function report(slug, paths, target) {
  const files = await walk(target);
  const total = files.reduce((sum, f) => sum + f.size, 0);
  const roster = await loadRoster(paths);
  const manifest = await readJson(path.join(paths.panos, 'manifest.json'));

  console.log(`\n${bold(slug)}  ${dim(path.relative(ROOT, target) + '/')}`);
  console.log(`  bundle      ${formatBytes(total).padStart(9)}   ${files.length} files`);

  if (!manifest?.panos || !Object.keys(manifest.panos).length) {
    console.log(dim(`  panoramas   none built yet — npm run process -- --tour=${slug}`));
    return;
  }

  const entries = Object.entries(manifest.panos);
  const per = Object.fromEntries(
    RENDITION_ORDER.map((q) => [
      q,
      entries.reduce((sum, [, v]) => sum + (v.bytes?.[q] ?? 0), 0) / entries.length,
    ]),
  );

  console.log(`  panoramas   ${entries.length}/${roster.count} nodes built`);
  for (const q of RENDITION_ORDER) {
    console.log(`    ${q.padEnd(6)} ${formatBytes(per[q]).padStart(9)} per node`);
  }

  const walkBytes = per.mid * WALK_NODES;
  const verdict =
    walkBytes <= WALK_BUDGET_BYTES
      ? green(`under the ${formatBytes(WALK_BUDGET_BYTES)} budget`)
      : red(`OVER the ${formatBytes(WALK_BUDGET_BYTES)} budget`);

  console.log(`  ${WALK_NODES}-node walk ${formatBytes(walkBytes).padStart(9)}   ${verdict}`);
}

/* ------------------------------------------------------------------ *
 * Plumbing
 * ------------------------------------------------------------------ */

async function assertBuilt() {
  if (!(await exists(path.join(DIST, 'index.html')))) {
    throw new Error('dist/index.html not found — run `vite build` first (npm run build).');
  }
}

async function walk(dir, base = dir) {
  const out = [];

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, base)));
    else out.push({ rel: path.relative(base, full), size: (await stat(full)).size });
  }

  return out;
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

const tty = process.stdout.isTTY;
const wrap = (code) => (s) => (tty ? `[${code}m${s}[0m` : s);
const bold = wrap(1);
const dim = wrap(2);
const red = wrap(31);
const green = wrap(32);
