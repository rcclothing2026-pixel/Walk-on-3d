#!/usr/bin/env node
/**
 * Phase 1 — image pipeline.
 *
 * Reads the numbered source photos (equirectangular, out of Insta360 Studio) and
 * emits three renditions per node into public/tour/panos/:
 *
 *   NN-full.jpg   8192×4096  q82   fetched only when the user zooms in
 *   NN-mid.jpg    4096×2048  q80   the default panorama
 *   NN-thumb.jpg  1024×512   q70   instant placeholder
 *
 * All EXIF is stripped. The XMP block is kept when present, because that is
 * where the GPano projection metadata lives — some viewers and most social
 * previews rely on it to recognise the file as a 360° photo.
 *
 * Usage:
 *   npm run process
 *   npm run process -- --only=1,5,17-20     process a subset
 *   npm run process -- --force              rebuild even if outputs are current
 *   npm run process -- --concurrency=4      default 2 (these are large decodes)
 *   npm run process -- --no-mozjpeg         plain libjpeg instead of mozjpeg
 *   npm run process -- --raw=raw --out=panos
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import sharp from 'sharp';

import {
  RENDITIONS,
  RENDITION_ORDER,
  nodeId,
  panoFilename,
} from '../src/lib/paths.js';
import { nodeNumbers, nodeRange } from '../src/lib/nodes.js';
import { findRaw, hasRawFiles } from './raw.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Which nodes exist comes from src/data/names.json, not a constant here — the
 * shooting plan and the brief's node table currently disagree on the count, so
 * renumbering must stay a one-file change.
 */
const ALL_NODES = nodeNumbers();
const { first: FIRST_NODE, last: LAST_NODE } = nodeRange();

/** Source panoramas must be equirectangular, i.e. exactly 2:1. */
const EXPECTED_ASPECT = 2;
const ASPECT_TOLERANCE = 0.01;

/** Acceptance criterion 8: a 10-node walk must transfer under this. */
const WALK_NODES = 10;
const WALK_BUDGET_BYTES = 15 * 1024 * 1024;

main().catch((err) => {
  console.error(`\n${red('Pipeline failed:')} ${err.stack || err.message}`);
  process.exitCode = 1;
});

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rawDir = path.resolve(ROOT, opts.raw);
  const outDir = path.resolve(ROOT, opts.out);

  await assertRawDir(rawDir);
  await mkdir(outDir, { recursive: true });

  const nodes = opts.only ?? ALL_NODES;

  console.log(`\n${bold('Panorama pipeline')}`);
  console.log(`  in   ${path.relative(ROOT, rawDir)}/`);
  console.log(`  out  ${path.relative(ROOT, outDir)}/`);
  console.log(
    `  ${nodes.length} node(s) × ${RENDITION_ORDER.length} renditions` +
      `${opts.mozjpeg ? ', mozjpeg' : ''}${opts.force ? ', forced rebuild' : ''}\n`,
  );

  const results = [];
  const missing = [];
  const warnings = [];

  await mapWithConcurrency(nodes, opts.concurrency, async (node) => {
    // Accepts 07.jpg, 7.jpg, 7.JPEG and so on — the number is what matters.
    const source = await findRaw(rawDir, node);
    const sourceStat = source ? await statOrNull(source) : null;

    if (!sourceStat) {
      missing.push(node);
      console.log(`  ${nodeId(node)}  ${dim(`— no ${nodeId(node)}.jpg in ${path.basename(rawDir)}/`)}`);
      return;
    }

    const result = await processNode({ node, source, sourceStat, outDir, opts });
    results.push(result);
    warnings.push(...result.warnings.map((w) => `${nodeId(node)}: ${w}`));

    const label = result.skipped ? dim('up to date') : formatBytes(result.total);
    console.log(`  ${nodeId(node)}  ${label}`);
  });

  // Bounded concurrency completes out of order; reports read better sorted.
  results.sort((a, b) => a.node - b.node);
  missing.sort((a, b) => a - b);

  printTable(results);
  printWarnings(warnings);
  printMissing(missing, nodes.length);

  await writeManifest(outDir, results);

  if (missing.length) process.exitCode = 1;
}

/* ------------------------------------------------------------------ *
 * Per-node work
 * ------------------------------------------------------------------ */

async function processNode({ node, source, sourceStat, outDir, opts }) {
  const meta = await sharp(source).metadata();
  const warnings = checkSource(meta);

  // sharp strips all metadata by default, so the only thing we put back is the
  // XMP block — that is where GPano lives. EXIF (including GPS) stays stripped.
  const sourceXmp = meta.xmp ? meta.xmp.toString('utf8') : null;
  if (!sourceXmp) warnings.push('no XMP block in source, GPano metadata not carried through');

  const sizes = {};
  let skipped = true;

  for (const rendition of RENDITION_ORDER) {
    const spec = RENDITIONS[rendition];
    const target = path.join(outDir, panoFilename(node, rendition));

    if (meta.width && meta.width < spec.width) {
      warnings.push(
        `source is ${meta.width}px wide, upscaling to ${spec.width}px for "${rendition}"`,
      );
    }

    if (!opts.force && (await isCurrent(target, sourceStat.mtimeMs))) {
      sizes[rendition] = (await stat(target)).size;
      continue;
    }

    skipped = false;

    // Resized from the original every time rather than cascading full → mid →
    // thumb: one extra decode per rendition, but no compounding of resampling
    // error. `fit: 'fill'` guarantees the exact 2:1 output dimensions that an
    // equirectangular projection requires, even if a source is a pixel off.
    let pipeline = sharp(source, { limitInputPixels: 512 * 1024 * 1024 })
      .resize(spec.width, spec.height, { fit: 'fill', kernel: 'lanczos3' })
      .jpeg({
        quality: spec.quality,
        mozjpeg: opts.mozjpeg,
        chromaSubsampling: '4:2:0',
      });

    // The GPano block states pixel dimensions. Carrying the source's numbers
    // onto a downscaled rendition would advertise an 11904px pano inside a
    // 4096px file, so the dimensions are rescaled to match what we just wrote.
    if (sourceXmp) {
      pipeline = pipeline.withXmp(rescaleGPano(sourceXmp, spec.width / (meta.width || spec.width)));
    }

    const { size } = await pipeline.toFile(target);
    sizes[rendition] = size;
  }

  return {
    node,
    sizes,
    total: RENDITION_ORDER.reduce((sum, r) => sum + sizes[r], 0),
    source: { width: meta.width, height: meta.height, bytes: sourceStat.size },
    skipped,
    warnings,
  };
}

/**
 * GPano attributes measured in pixels. Scaling all of them by the same factor
 * preserves the crop proportions of a partial panorama and collapses to the
 * exact output dimensions for a full 360×180 one.
 */
const GPANO_PIXEL_FIELDS = [
  'FullPanoWidthPixels',
  'FullPanoHeightPixels',
  'CroppedAreaImageWidthPixels',
  'CroppedAreaImageHeightPixels',
  'CroppedAreaLeftPixels',
  'CroppedAreaTopPixels',
];

/** Rescale the pixel dimensions inside an XMP/GPano block by `scale`. */
function rescaleGPano(xmp, scale) {
  if (!Number.isFinite(scale) || scale === 1) return xmp;

  let out = xmp;
  for (const field of GPANO_PIXEL_FIELDS) {
    // Attribute form: GPano:FullPanoWidthPixels="11904"
    out = out.replace(
      new RegExp(`(GPano:${field}=")(\\d+)(")`, 'g'),
      (_, head, value, tail) => head + Math.round(Number(value) * scale) + tail,
    );
    // Element form: <GPano:FullPanoWidthPixels>11904</GPano:FullPanoWidthPixels>
    out = out.replace(
      new RegExp(`(<GPano:${field}>)(\\d+)(</GPano:${field}>)`, 'g'),
      (_, head, value, tail) => head + Math.round(Number(value) * scale) + tail,
    );
  }
  return out;
}

function checkSource(meta) {
  const warnings = [];

  if (!meta.width || !meta.height) {
    warnings.push('could not read source dimensions');
    return warnings;
  }

  const aspect = meta.width / meta.height;
  if (Math.abs(aspect - EXPECTED_ASPECT) > ASPECT_TOLERANCE) {
    warnings.push(
      `aspect ratio is ${aspect.toFixed(3)}:1, expected 2:1 — is this a reframed export ` +
        `rather than "Export 360 Photo (not reframed)"?`,
    );
  }

  return warnings;
}

/** An output is current when it exists and is not older than the source. */
async function isCurrent(target, sourceMtimeMs) {
  const s = await statOrNull(target);
  return Boolean(s) && s.mtimeMs >= sourceMtimeMs;
}

/**
 * A manifest of what was emitted. The viewer's quality manager reads byte sizes
 * from this to decide whether fetching `full` is worth it on the current
 * connection.
 *
 * Merged into whatever is already on disk rather than overwritten, so that a
 * partial run (`--only=17`) refreshes one node instead of erasing the other 42.
 */
async function writeManifest(outDir, results) {
  if (!results.length) return;

  const target = path.join(outDir, 'manifest.json');
  const panos = { ...(await readManifestPanos(target)) };

  for (const r of results) {
    panos[nodeId(r.node)] = {
      bytes: Object.fromEntries(RENDITION_ORDER.map((q) => [q, r.sizes[q]])),
    };
  }

  const ordered = Object.fromEntries(Object.keys(panos).sort().map((k) => [k, panos[k]]));

  await writeFile(
    target,
    `${JSON.stringify({ renditions: RENDITIONS, panos: ordered }, null, 2)}\n`,
  );
  const count = Object.keys(ordered).length;
  console.log(`${dim('manifest')}  ${path.relative(ROOT, target)} (${count} node${count === 1 ? '' : 's'})\n`);
}

async function readManifestPanos(target) {
  try {
    const parsed = JSON.parse(await readFile(target, 'utf8'));
    return parsed?.panos ?? {};
  } catch {
    // Absent or unreadable: start fresh rather than failing the run.
    return {};
  }
}

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

function printTable(results) {
  if (!results.length) {
    console.log(`\n${yellow('Nothing was processed.')}\n`);
    return;
  }

  // Columns follow RENDITION_ORDER, so dropping or adding a rendition does not
  // leave a stale column behind.
  const rows = results.map((r) => [
    nodeId(r.node),
    ...RENDITION_ORDER.map((q) => formatBytes(r.sizes[q])),
    formatBytes(r.total),
  ]);

  const totals = RENDITION_ORDER.reduce(
    (acc, q) => ({ ...acc, [q]: sum(results.map((r) => r.sizes[q])) }),
    {},
  );
  const grandTotal = sum(results.map((r) => r.total));

  const header = ['node', ...RENDITION_ORDER, 'total'];
  const footer = [
    'ALL',
    ...RENDITION_ORDER.map((q) => formatBytes(totals[q])),
    formatBytes(grandTotal),
  ];

  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i].length), footer[i].length),
  );
  const line = (cells, pad = ' ') =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i], pad) : c.padStart(widths[i], pad))).join('  ');

  console.log(`\n${bold(line(header))}`);
  console.log(dim(widths.map((w) => '─'.repeat(w)).join('  ')));
  for (const row of rows) console.log(line(row));
  console.log(dim(widths.map((w) => '─'.repeat(w)).join('  ')));
  console.log(bold(line(footer)));

  const avgMid = totals.mid / results.length;
  const walk = avgMid * WALK_NODES;
  const verdict =
    walk <= WALK_BUDGET_BYTES
      ? green(`under the ${formatBytes(WALK_BUDGET_BYTES)} budget`)
      : red(`OVER the ${formatBytes(WALK_BUDGET_BYTES)} budget`);

  console.log(
    `\n  average per node   ${formatBytes(grandTotal / results.length)}` +
      ` (${RENDITION_ORDER.join(' + ')})`,
  );
  console.log(`  average mid        ${formatBytes(avgMid)}`);
  console.log(`  ${WALK_NODES}-node walk (mid) ${formatBytes(walk)} — ${verdict}\n`);
}

function printWarnings(warnings) {
  if (!warnings.length) return;
  console.log(yellow(`${warnings.length} warning(s):`));
  for (const w of warnings) console.log(`  ${yellow('!')} ${w}`);
  console.log('');
}

function printMissing(missing, requested) {
  if (!missing.length) return;
  console.log(
    red(`${missing.length} of ${requested} raw file(s) missing: `) +
      missing.map(nodeId).join(', '),
  );
  console.log(dim('  add them to the raw directory, numbered, and re-run.\n'));
}

/* ------------------------------------------------------------------ *
 * Plumbing
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = {
    raw: 'raw',
    out: 'panos',
    concurrency: 2,
    force: false,
    mozjpeg: true,
    only: null,
  };

  for (const arg of argv) {
    const [flag, value] = splitFlag(arg);
    switch (flag) {
      case '--raw':
      case '--out':
        opts[flag.slice(2)] = requireValue(flag, value);
        break;
      case '--concurrency':
        opts.concurrency = Math.max(1, Number.parseInt(requireValue(flag, value), 10) || 1);
        break;
      case '--force':
        opts.force = true;
        break;
      case '--mozjpeg':
        opts.mozjpeg = true;
        break;
      case '--no-mozjpeg':
        opts.mozjpeg = false;
        break;
      case '--only':
        opts.only = parseNodeList(requireValue(flag, value));
        break;
      default:
        throw new Error(`Unknown option "${arg}". See the header of scripts/process.js.`);
    }
  }

  return opts;
}

function splitFlag(arg) {
  const eq = arg.indexOf('=');
  return eq === -1 ? [arg, undefined] : [arg.slice(0, eq), arg.slice(eq + 1)];
}

function requireValue(flag, value) {
  if (value === undefined || value === '') throw new Error(`${flag} needs a value, e.g. ${flag}=…`);
  return value;
}

/** '1,5,17-20' → [1, 5, 17, 18, 19, 20] */
function parseNodeList(spec) {
  const out = new Set();

  for (const part of spec.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const dash = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
    const [from, to] = dash
      ? [Number(dash[1]), Number(dash[2])]
      : [Number(trimmed), Number(trimmed)];

    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      throw new Error(`--only: cannot parse "${trimmed}"`);
    }
    if (from < FIRST_NODE || to > LAST_NODE || from > to) {
      throw new Error(`--only: "${trimmed}" is outside ${FIRST_NODE}–${LAST_NODE}`);
    }

    for (let n = from; n <= to; n++) out.add(n);
  }

  // A range like 20-30 may span gaps if the roster is ever non-contiguous.
  const known = new Set(ALL_NODES);
  const selected = [...out].filter((n) => known.has(n)).sort((a, b) => a - b);

  if (!selected.length) throw new Error('--only matched no nodes in src/data/names.json');
  return selected;
}

async function assertRawDir(rawDir) {
  const s = await statOrNull(rawDir);
  if (!s?.isDirectory()) {
    throw new Error(`raw directory not found: ${rawDir}`);
  }

  if (!(await hasRawFiles(rawDir))) {
    throw new Error(
      `${rawDir} contains no numbered photos.\n` +
        `  Export from Insta360 Studio as "Export 360 Photo (not reframed)" and\n` +
        `  number them 1 … ${LAST_NODE} in route order. Zero-padding is optional:\n` +
        `  7.jpg and 07.jpg are both read as node 7.`,
    );
  }
}

async function statOrNull(p) {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}

/** Bounded-concurrency map that preserves the caller's ordering of work. */
async function mapWithConcurrency(items, limit, fn) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await fn(items[index], index);
    }
  });
  await Promise.all(workers);
}

function sum(values) {
  return values.reduce((a, b) => a + b, 0);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/* Colour helpers — no-ops when stdout is not a TTY, so piped logs stay clean. */
const tty = process.stdout.isTTY;
const wrap = (code) => (s) => (tty ? `[${code}m${s}[0m` : s);
const bold = wrap(1);
const dim = wrap(2);
const red = wrap(31);
const green = wrap(32);
const yellow = wrap(33);
