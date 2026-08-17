#!/usr/bin/env node
/**
 * Phase 3 — generates src/data/nodes.json, the tour's node graph.
 *
 * Combines three sources:
 *
 *   src/data/graph.js       which nodes link to which (the brief's link graph)
 *   src/data/names.json     the roster: which nodes exist, and their names
 *   src/data/alignment.json each node's sphereCorrection.pan, from tools/align.html
 *
 * Arrow angles come from tools/hotspots.html. Any that have not been picked yet
 * are auto-placed — neighbours spread evenly around the horizon at -20° pitch —
 * and flagged `"auto": true`. That is what lets the viewer run before a single
 * hotspot has been placed; it just means the arrows point in arbitrary
 * directions until someone picks them properly.
 *
 * Re-running MERGES: hand-picked angles already in nodes.json are preserved.
 * Only the graph structure is rebuilt. Use --reset to discard picked angles.
 *
 * Usage:
 *   npm run nodes
 *   npm run nodes -- --reset      throw away picked angles, re-auto-place all
 *   npm run nodes -- --check      validate only, write nothing
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { adjacency, validate } from './graph.js';
import { ROOT, listTours, readJson, resolveTour, tourPaths } from './tours.js';
import { loadRoster } from './roster.js';

/** Where auto-placed floor arrows sit, in degrees. Mid-range of the brief's -15..-30. */
const AUTO_PITCH = -20;

main().catch((err) => {
  console.error(`\n${red('Build failed:')} ${err.stack || err.message}`);
  process.exitCode = 1;
});

async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);
  const named = argv.some((arg) => arg.startsWith('--tour='));

  // Checking every tour is harmless and is what a build wants; writing to one
  // picked for you is not, so generating still demands an explicit choice.
  if (opts.check && !named) {
    const slugs = await listTours();
    for (const slug of slugs) await run(await tourPaths(slug), opts);
    return;
  }

  await run(await resolveTour(argv), opts);
}

async function run(tour, opts) {

  const rosterData = await loadRoster(tour);
  const roster = rosterData.numbers;
  const links = (await readJson(tour.file('links'))) ?? { edges: [] };
  const alignment = await readJson(tour.file('alignment'));
  const previous = opts.reset ? null : await readJson(tour.file('nodes'));
  const START_NODE = Number(tour.config.startNode) || roster[0] || 1;

  // --check audits what is actually on disk, which is the only thing a hand
  // edit or a bad picker export can corrupt. Without it, the build would only
  // ever validate its own freshly-generated output.
  if (opts.check) {
    return checkOnDisk(previous, roster, { start: START_NODE, links, slug: tour.slug });
  }

  const adj = adjacency(links.edges, roster);
  const nodes = {};
  let picked = 0;
  let auto = 0;

  for (const n of roster) {
    const id = pad(n);
    const { name, type, unconfirmed } = rosterData.info(n);
    const neighbours = adj.get(n) ?? [];
    const previousLinks = indexLinks(previous?.nodes?.[id]?.links);

    const links = neighbours.map((other, index) => {
      const existing = previousLinks.get(pad(other));

      if (existing && !existing.auto) {
        picked++;
        return { node: pad(other), yaw: existing.yaw, pitch: existing.pitch };
      }

      auto++;
      return {
        node: pad(other),
        yaw: round(autoYaw(index, neighbours.length)),
        pitch: AUTO_PITCH,
        auto: true,
      };
    });

    // Placed with tools/map.html and preserved across rebuilds, exactly like
    // hand-picked arrow angles.
    const mapPoint = previous?.nodes?.[id]?.map;

    nodes[id] = {
      id,
      name,
      type,
      ...(unconfirmed ? { unconfirmed: true } : {}),
      pan: readPan(alignment, id),
      ...(Number.isFinite(mapPoint?.x) && Number.isFinite(mapPoint?.y)
        ? { map: { x: mapPoint.x, y: mapPoint.y } }
        : {}),
      links,
    };
  }

  // Validate what is about to be written, not the graph it came from — this is
  // the structure the viewer will actually walk.
  const emitted = adjacencyOf(nodes);
  const { errors, warnings } = validate(emitted, roster, {
    start: START_NODE,
    deadEnds: links.deadEnds,
    expectedSingleLink: links.expectedSingleLink,
  });

  report({ roster, adj: emitted, errors, warnings, picked, auto, alignment });

  if (errors.length) {
    console.error(red(`\n${errors.length} structural error(s) — nodes.json not written.\n`));
    process.exitCode = 1;
    return;
  }

  const payload = { start: pad(START_NODE), autoPitch: AUTO_PITCH, nodes };
  await writeFile(tour.file('nodes'), `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`${green('✓')} ${path.relative(ROOT, tour.file('nodes'))}\n`);
}

/** Derives the adjacency a nodes map actually describes, via its links. */
function adjacencyOf(nodes) {
  const adj = new Map();

  for (const [id, node] of Object.entries(nodes)) {
    const from = Number(id);
    if (!adj.has(from)) adj.set(from, []);
    for (const link of node.links ?? []) {
      const to = Number(link.node);
      if (!adj.get(from).includes(to)) adj.get(from).push(to);
    }
  }

  return adj;
}

/** Audits an existing nodes.json rather than generating a new one. */
function checkOnDisk(nodes, roster, { start, links, slug }) {
  if (!nodes?.nodes) {
    console.error(red(`\nTour "${slug}" has no nodes.json — run \`npm run nodes -- --tour=${slug}\` first.\n`));
    process.exitCode = 1;
    return;
  }

  const adj = adjacencyOf(nodes.nodes);
  const { errors, warnings } = validate(adj, roster, {
    start,
    deadEnds: links.deadEnds,
    expectedSingleLink: links.expectedSingleLink,
  });
  const allLinks = Object.values(nodes.nodes).flatMap((n) => n.links ?? []);

  report({
    roster,
    adj,
    errors,
    warnings,
    picked: allLinks.filter((l) => !l.auto).length,
    auto: allLinks.filter((l) => l.auto).length,
    alignment: Object.fromEntries(
      Object.entries(nodes.nodes).map(([id, n]) => [id, { pan: n.pan, todo: n.pan === 0 }]),
    ),
  });

  const missing = roster.filter((n) => !nodes.nodes[pad(n)]);
  if (missing.length) {
    console.error(red(`Missing from nodes.json: ${missing.map(pad).join(', ')}\n`));
    process.exitCode = 1;
    return;
  }

  if (errors.length) process.exitCode = 1;
  else console.log(dim('--check: nothing written.\n'));
}

/**
 * Spreads a node's neighbours evenly around the horizon.
 *
 * Deterministic, so re-running does not shuffle arrows that a human has not
 * touched. It carries no relation to the real geometry — it exists so the tour
 * is walkable before hotspots are picked.
 */
function autoYaw(index, count) {
  return (360 / Math.max(1, count)) * index;
}

function indexLinks(links) {
  const map = new Map();
  for (const link of links ?? []) {
    if (link?.node) map.set(link.node, link);
  }
  return map;
}

/** alignment.json marks never-visited nodes with `todo`; those are not real values. */
function readPan(alignment, id) {
  const entry = alignment?.[id];
  if (!entry || entry.todo || !Number.isFinite(entry.pan)) return 0;
  return entry.pan;
}

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

function report({ roster, adj, errors, warnings, picked, auto, alignment }) {
  const edges = [...adj.values()].reduce((sum, list) => sum + list.length, 0) / 2;
  const aligned = roster.filter((n) => {
    const entry = alignment?.[pad(n)];
    return entry && !entry.todo && Number.isFinite(entry.pan);
  }).length;

  console.log(`\n${bold('Node graph')}`);
  console.log(`  ${roster.length} nodes, ${edges} edges`);
  console.log(`  arrows    ${picked} picked, ${auto} auto-placed`);
  console.log(
    `  alignment ${aligned}/${roster.length}` +
      (aligned === 0 ? dim('  (run tools/align.html — every pan is 0° until then)') : ''),
  );

  if (errors.length) {
    console.log(`\n${red(`${errors.length} error(s):`)}`);
    for (const e of errors) console.log(`  ${red('✗')} ${e}`);
  }

  if (warnings.length) {
    console.log(`\n${yellow(`${warnings.length} warning(s):`)}`);
    for (const w of warnings) console.log(`  ${yellow('!')} ${w}`);
  }

  if (!errors.length && !warnings.length) console.log(`\n${green('Graph is clean.')}`);
  console.log('');
}

/* ------------------------------------------------------------------ *
 * Plumbing
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = { reset: false, check: false };

  for (const arg of argv) {
    switch (arg) {
      case '--reset':
        opts.reset = true;
        break;
      case '--check':
        opts.check = true;
        break;
      default:
        if (arg.startsWith('--tour=')) break; // consumed by resolveTour
        throw new Error(`Unknown option "${arg}". See the header of scripts/build-nodes.js.`);
    }
  }

  return opts;
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

const tty = process.stdout.isTTY;
const wrap = (code) => (s) => (tty ? `[${code}m${s}[0m` : s);
const bold = wrap(1);
const dim = wrap(2);
const red = wrap(31);
const green = wrap(32);
const yellow = wrap(33);
