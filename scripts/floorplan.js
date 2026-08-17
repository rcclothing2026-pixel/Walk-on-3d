#!/usr/bin/env node
/**
 * Turns the architect's AutoCAD PDF into the flat floor plan the mini-map uses.
 *
 * The supplied sheet is A3 with the drawing sitting in the middle of a lot of
 * white, under a title block. Rather than hardcoding a crop box that would go
 * stale the moment a revised sheet arrives, this finds the drawing by ink:
 * it renders the page, measures how much ink each row carries, takes the
 * tallest contiguous band as the plan, and crops to that band's extent.
 *
 * Requires `pdftoppm` (poppler-utils) on PATH — a system tool, not an npm
 * dependency:
 *
 *   apt-get install poppler-utils      # Debian/Ubuntu
 *   brew install poppler               # macOS
 *
 * Usage:
 *   npm run floorplan
 *   npm run floorplan -- --pdf=docs/blueprint-basement-r3.pdf
 *   npm run floorplan -- --width=2400 --dpi=600
 *   npm run floorplan -- --keep-render      leave the full-page PNG for inspection
 */

import { execFile } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import sharp from 'sharp';

import { ROOT, resolveTour } from './tours.js';

const execFileAsync = promisify(execFile);

/** Greyscale value below which a pixel counts as ink. */
const INK_THRESHOLD = 200;

/** Ignore ink bands shorter than this (at render dpi) — stray callouts. */
const MIN_BAND_PX = 200;

/** White space kept around the drawing, in render pixels. */
const MARGIN_PX = 40;

main().catch((err) => {
  console.error(`\n${red('Floor plan failed:')} ${err.message}`);
  process.exitCode = 1;
});

async function main() {
  const argv = process.argv.slice(2);
  const tour = await resolveTour(argv);
  const opts = parseArgs(argv);

  const pdf = path.resolve(tour.dir, opts.pdf ?? tour.config.blueprint ?? 'blueprint.pdf');
  const out = opts.out ? path.resolve(ROOT, opts.out) : tour.floorplan;

  await assertFile(pdf, 'source PDF');
  await assertPdftoppm();
  await mkdir(path.dirname(out), { recursive: true });

  const renderBase = path.join(path.dirname(out), '.floorplan-render');
  const render = `${renderBase}.png`;

  console.log(`\n${bold('Floor plan')}`);
  console.log(`  pdf  ${path.relative(ROOT, pdf)}`);
  console.log(`  out  ${path.relative(ROOT, out)}\n`);

  try {
    console.log(`  rendering at ${opts.dpi} dpi…`);
    await execFileAsync('pdftoppm', ['-r', String(opts.dpi), '-png', '-singlefile', pdf, renderBase]);

    const box = await findDrawing(render);
    console.log(
      `  drawing found at ${box.width}×${box.height} ` +
        `(x ${box.left}, y ${box.top})${dim(` of ${box.pageWidth}×${box.pageHeight}`)}`,
    );

    // A 16-colour palette is plenty for a line drawing and cuts the file by
    // roughly 4× against greyscale, which matters for first paint.
    const info = await sharp(render)
      .extract(cropWithMargin(box))
      .resize(opts.width, null, { kernel: 'lanczos3' })
      .png({ compressionLevel: 9, palette: true, colours: 16 })
      .toFile(out);

    console.log(
      `\n  ${green('✓')} ${path.relative(ROOT, out)}  ` +
        `${info.width}×${info.height}  ${formatBytes(info.size)}\n`,
    );
  } finally {
    if (!opts.keepRender) await rm(render, { force: true });
  }
}

/**
 * Locates the plan on the page by ink profile.
 *
 * The sheet border is a thin rectangle spanning the full page, so it is
 * stripped first; what remains is the drawing plus the title block, separated
 * by a clear horizontal gap. The tallest band is the drawing.
 */
async function findDrawing(render) {
  const { data, info } = await sharp(render).greyscale().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const isInk = (x, y) => data[y * width + x] < INK_THRESHOLD;

  // Rows/columns spanning most of the page are the sheet border, not content.
  const rowInk = tally(height, (y) => countRow(isInk, width, y));
  const colInk = tally(width, (x) => countCol(isInk, height, x));

  const bounds = {
    top: innerBound(rowInk, width * 0.5, 'start'),
    bottom: innerBound(rowInk, width * 0.5, 'end'),
    left: innerBound(colInk, height * 0.5, 'start'),
    right: innerBound(colInk, height * 0.5, 'end'),
  };

  const bands = inkBands(isInk, bounds, height);
  if (!bands.length) throw new Error('no drawing found on the page — is this the right PDF?');

  const plan = bands.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));

  let left = bounds.right;
  let right = bounds.left;
  for (let y = plan.start; y <= plan.end; y++) {
    for (let x = bounds.left; x <= bounds.right; x++) {
      if (!isInk(x, y)) continue;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }

  return {
    left,
    top: plan.start,
    width: right - left + 1,
    height: plan.end - plan.start + 1,
    pageWidth: width,
    pageHeight: height,
  };
}

/** Contiguous runs of inked rows inside the sheet border. */
function inkBands(isInk, bounds, height) {
  const bands = [];
  let current = null;

  for (let y = bounds.top; y <= bounds.bottom; y++) {
    let inked = false;
    for (let x = bounds.left; x <= bounds.right; x++) {
      if (isInk(x, y)) {
        inked = true;
        break;
      }
    }

    if (inked) {
      current = current ? { ...current, end: y } : { start: y, end: y };
    } else if (current) {
      if (current.end - current.start >= MIN_BAND_PX) bands.push(current);
      current = null;
    }
  }

  if (current && current.end - current.start >= MIN_BAND_PX) bands.push(current);
  void height;
  return bands;
}

/** First/last index whose ink count stays under `heavy`, i.e. inside the border. */
function innerBound(counts, heavy, which) {
  const indices = counts.map((v, i) => [i, v]).filter(([, v]) => v > heavy).map(([i]) => i);
  if (!indices.length) return which === 'start' ? 0 : counts.length - 1;

  const mid = counts.length / 2;
  return which === 'start'
    ? Math.max(0, Math.max(...indices.filter((i) => i < mid), 0) + 6)
    : Math.min(counts.length - 1, Math.min(...indices.filter((i) => i > mid), counts.length - 1) - 6);
}

function cropWithMargin(box) {
  const left = Math.max(0, box.left - MARGIN_PX);
  const top = Math.max(0, box.top - MARGIN_PX);
  return {
    left,
    top,
    width: Math.min(box.pageWidth - left, box.width + 2 * MARGIN_PX),
    height: Math.min(box.pageHeight - top, box.height + 2 * MARGIN_PX),
  };
}

/* ------------------------------------------------------------------ *
 * Plumbing
 * ------------------------------------------------------------------ */

function countRow(isInk, width, y) {
  let n = 0;
  for (let x = 0; x < width; x++) if (isInk(x, y)) n++;
  return n;
}

function countCol(isInk, height, x) {
  let n = 0;
  for (let y = 0; y < height; y++) if (isInk(x, y)) n++;
  return n;
}

function tally(length, fn) {
  return Array.from({ length }, (_, i) => fn(i));
}

function parseArgs(argv) {
  const opts = {
    pdf: null,
    out: null,
    dpi: 400,
    width: 2000,
    keepRender: false,
  };

  for (const arg of argv) {
    const eq = arg.indexOf('=');
    const [flag, value] = eq === -1 ? [arg, undefined] : [arg.slice(0, eq), arg.slice(eq + 1)];

    switch (flag) {
      case '--pdf':
      case '--out':
        if (!value) throw new Error(`${flag} needs a value`);
        opts[flag.slice(2)] = value;
        break;
      case '--dpi':
      case '--width':
        opts[flag.slice(2)] = Math.max(1, Number.parseInt(value, 10) || 0);
        if (!opts[flag.slice(2)]) throw new Error(`${flag} needs a positive number`);
        break;
      case '--keep-render':
        opts.keepRender = true;
        break;
      default:
        if (flag === '--tour') break; // consumed by resolveTour
        throw new Error(`Unknown option "${arg}". See the header of scripts/floorplan.js.`);
    }
  }

  return opts;
}

async function assertFile(file, label) {
  try {
    await stat(file);
  } catch {
    throw new Error(`${label} not found: ${file}`);
  }
}

async function assertPdftoppm() {
  try {
    await execFileAsync('pdftoppm', ['-v']);
  } catch {
    throw new Error(
      'pdftoppm not found on PATH.\n' +
        '  It ships with poppler-utils:\n' +
        '    apt-get install poppler-utils   # Debian/Ubuntu\n' +
        '    brew install poppler            # macOS',
    );
  }
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

const tty = process.stdout.isTTY;
const wrap = (code) => (s) => (tty ? `[${code}m${s}[0m` : s);
const bold = wrap(1);
const dim = wrap(2);
const red = wrap(31);
const green = wrap(32);
