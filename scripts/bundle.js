#!/usr/bin/env node
/**
 * Phase 6 — post-build assembly and weight report.
 *
 * dist/ is already exactly the payload that goes into Laravel's public/tour/:
 * publicDir maps 1:1 onto the deploy root and panoramas live outside it. This
 * only reports the weights the brief asks for.
 *
 * Panoramas are deliberately NOT part of the bundle. They are hundreds of MB,
 * they change independently of the code, and they are destined for object
 * storage. Upload them to public/tour/panos/ (or to Arvan, and point
 * VITE_IMAGE_BASE_URL at it) separately.
 */

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { RENDITION_ORDER } from '../src/lib/paths.js';
import { nodeCount } from '../src/lib/nodes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

/** Acceptance criterion 8. */
const WALK_NODES = 10;
const WALK_BUDGET_BYTES = 15 * 1024 * 1024;

main().catch((err) => {
  console.error(`\n${red('Bundle failed:')} ${err.stack || err.message}`);
  process.exitCode = 1;
});

async function main() {
  await assertBuilt();

  const files = await walk(DIST);
  report(files);
  await reportPanoramas();
}

async function assertBuilt() {
  try {
    await stat(path.join(DIST, 'index.html'));
  } catch {
    throw new Error('dist/index.html not found — run `vite build` first (npm run build).');
  }
}

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

function report(files) {
  const total = files.reduce((sum, f) => sum + f.size, 0);
  const groups = new Map();

  for (const file of files) {
    const key = groupOf(file.rel);
    groups.set(key, (groups.get(key) ?? 0) + file.size);
  }

  const rows = [...groups.entries()].sort((a, b) => b[1] - a[1]);
  const width = Math.max(...rows.map(([k]) => k.length), 'total'.length);

  console.log(`\n${bold('Bundle')}  ${path.relative(ROOT, DIST)}/`);
  console.log(dim('  (panoramas excluded — they are uploaded separately)\n'));

  for (const [group, size] of rows) {
    console.log(`  ${group.padEnd(width)}  ${formatBytes(size).padStart(9)}`);
  }
  console.log(dim(`  ${'─'.repeat(width)}  ${'─'.repeat(9)}`));
  console.log(bold(`  ${'total'.padEnd(width)}  ${formatBytes(total).padStart(9)}`));

  const biggest = files.sort((a, b) => b.size - a.size).slice(0, 5);
  console.log(`\n${dim('  largest files')}`);
  for (const file of biggest) {
    console.log(`    ${formatBytes(file.size).padStart(9)}  ${file.rel}`);
  }
}

/** Per-node panorama weight, read from the pipeline's manifest if present. */
async function reportPanoramas() {
  const manifest = await readJson(path.join(ROOT, 'panos/manifest.json'));

  console.log(`\n${bold('Panoramas')}`);

  if (!manifest?.panos || !Object.keys(manifest.panos).length) {
    console.log(dim('  No manifest yet — run `npm run process` once the raw images exist.\n'));
    return;
  }

  const entries = Object.entries(manifest.panos);
  const totals = Object.fromEntries(
    RENDITION_ORDER.map((q) => [q, entries.reduce((sum, [, v]) => sum + (v.bytes?.[q] ?? 0), 0)]),
  );

  const perNode = Object.fromEntries(
    RENDITION_ORDER.map((q) => [q, totals[q] / entries.length]),
  );

  console.log(`  ${entries.length}/${nodeCount()} nodes processed`);
  for (const q of RENDITION_ORDER) {
    console.log(
      `  ${q.padEnd(6)} ${formatBytes(perNode[q]).padStart(9)} per node` +
        `   ${formatBytes(totals[q]).padStart(9)} total`,
    );
  }

  const walk = perNode.mid * WALK_NODES;
  const verdict =
    walk <= WALK_BUDGET_BYTES
      ? green(`under the ${formatBytes(WALK_BUDGET_BYTES)} budget`)
      : red(`OVER the ${formatBytes(WALK_BUDGET_BYTES)} budget`);

  console.log(`\n  ${WALK_NODES}-node walk (mid only)  ${formatBytes(walk)} — ${verdict}\n`);
}

/** Groups files for the summary: assets by extension, everything else by dir. */
function groupOf(rel) {
  const ext = path.extname(rel).toLowerCase();

  if (rel.startsWith('fonts/')) return 'fonts';
  if (['.js', '.mjs'].includes(ext)) return 'javascript';
  if (ext === '.css') return 'css';
  if (['.png', '.jpg', '.jpeg', '.svg', '.webp'].includes(ext)) return 'images';
  if (ext === '.html') return 'html';
  if (ext === '.json') return 'data';
  return 'other';
}

/* ------------------------------------------------------------------ *
 * Plumbing
 * ------------------------------------------------------------------ */

async function walk(dir, base = dir) {
  const out = [];

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full, base)));
    } else {
      out.push({ rel: path.relative(base, full), size: (await stat(full)).size });
    }
  }

  return out;
}

async function readJson(file) {
  try {
    const { readFile } = await import('node:fs/promises');
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
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
