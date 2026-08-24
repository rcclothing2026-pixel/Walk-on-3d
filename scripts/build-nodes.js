#!/usr/bin/env node
/**
 * Generates tours/<slug>/nodes.json — the graph the viewer walks.
 *
 * Combines three sources, all per tour:

 *   tours/<slug>/links.json      which nodes link to which
 *   tours/<slug>/names.json      the roster: which nodes exist, and their names
 *   tours/<slug>/alignment.json  each node's pan, and its plan anchor
 *
 * The arrow angles come from scripts/generate-graph.js, which shares the rules
 * with the studio's staleness check. Any link nobody has aimed is auto-placed —
 * neighbours spread evenly around the horizon at -20° pitch, flagged
 * `"auto": true`. That is what lets the viewer run before a single hotspot has
 * been placed; it just means those arrows point in arbitrary directions until
 * someone picks them properly.
 *
 * Re-running MERGES: hand-picked angles already in nodes.json are preserved.
 * Only the structure is rebuilt. Use --reset to discard picked angles.
 *
 * Usage:
 *   npm run nodes -- --tour=<slug>
 *   npm run nodes -- --tour=<slug> --reset   throw away picked angles, re-auto-place all
 *   npm run nodes -- --check                 audit every tour on disk, write nothing
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { adjacencyOf, validate } from './graph.js';
import { generateNodes, staleness } from './generate-graph.js';
import { ROOT, listTours, readJson, resolveTour, tourPaths } from './tours.js';
import { loadRoster } from './roster.js';

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
  const inputs = await readInputs(tour);

  // --check audits what is actually on disk, which is the only thing a hand
  // edit or a bad picker export can corrupt. Without it, the build would only
  // ever validate its own freshly-generated output.
  if (opts.check) {
    return checkOnDisk(tour, inputs);
  }

  const previous = opts.reset ? null : await readJson(tour.file('nodes'));
  const { nodes, stats } = generateNodes({ ...inputs, previous, config: tour.config });

  // Validate what is about to be written, not the graph it came from — this is
  // the structure the viewer will actually walk.
  const emitted = adjacencyOf(nodes);
  const START_NODE = startNode(tour, inputs.rosterData.numbers);
  const { errors, warnings } = validate(emitted, inputs.rosterData.numbers, {
    start: START_NODE,
    deadEnds: inputs.links.deadEnds,
    expectedSingleLink: inputs.links.expectedSingleLink,
  });

  report({
    roster: inputs.rosterData.numbers,
    adj: emitted,
    errors,
    warnings,
    ...stats,
    alignment: inputs.alignment,
    stale: null,
  });

  if (errors.length) {
    console.error(red(`\n${errors.length} structural error(s) — nodes.json not written.\n`));
    process.exitCode = 1;
    return;
  }

  const payload = {
    start: pad(START_NODE),
    autoPitch: -20,
    nodes,
  };
  await writeFile(tour.file('nodes'), `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`${green('✓')} ${path.relative(ROOT, tour.file('nodes'))}\n`);
}

/** Reads everything generation needs off disk, once, in one shape. */
async function readInputs(tour) {
  const rosterData = await loadRoster(tour);
  const links = (await readJson(tour.file('links'))) ?? { edges: [] };
  const alignment = await readJson(tour.file('alignment'));
  return { rosterData, links, alignment };
}

function startNode(tour, roster) {
  return Number(tour.config.startNode) || roster[0] || 1;
}

/**
 * Audits an existing nodes.json rather than generating a new one.
 *
 * Two separate questions are asked. Is the graph on disk structurally sound?
 * And does it still match what would be generated now? The second is what
 * catches the quiet failure mode: anchors recorded in the design tool after
 * the last rebuild, leaving every derived arrow still pointing wherever the
 * auto-spread put it. A stale graph passes structural validation while being
 * wrong, so drift fails the check exactly as an error would.
 */
async function checkOnDisk(tour, { rosterData, links, alignment }) {
  const previous = await readJson(tour.file('nodes'));

  if (!previous?.nodes) {
    console.error(
      red(`\nTour "${tour.slug}" has no nodes.json — run \`npm run nodes -- --tour=${tour.slug}\` first.\n`),
    );
    process.exitCode = 1;
    return;
  }

  const roster = rosterData.numbers;
  const adj = adjacencyOf(previous.nodes);
  const START_NODE = startNode(tour, roster);
  const { errors, warnings } = validate(adj, roster, {
    start: START_NODE,
    deadEnds: links.deadEnds,
    expectedSingleLink: links.expectedSingleLink,
  });

  const generated = generateNodes({ rosterData, links, alignment, previous, config: tour.config });
  const stale = { ...staleness(previous, generated), slug: tour.slug };
  const allLinks = Object.values(previous.nodes).flatMap((n) => n.links ?? []);

  report({
    roster,
    adj,
    errors,
    warnings,
    picked: allLinks.filter((l) => !l.auto && !l.derived).length,
    derived: allLinks.filter((l) => l.derived).length,
    auto: allLinks.filter((l) => l.auto).length,
    alignment,
    stale,
  });

  const missing = roster.filter((n) => !previous.nodes[pad(n)]);
  if (missing.length) {
    console.error(red(`Missing from nodes.json: ${missing.map(pad).join(', ')}\n`));
    process.exitCode = 1;
    return;
  }

  if (errors.length || stale.stale) process.exitCode = 1;
  else console.log(dim('--check: nothing written.\n'));
}

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

function report({
  roster,
  adj,
  errors,
  warnings,
  picked,
  auto,
  derived = 0,
  alignment,
  stale = null,
}) {
  const edges = [...adj.values()].reduce((sum, list) => sum + list.length, 0) / 2;
  const aligned = roster.filter((n) => {
    const entry = alignment?.[pad(n)];
    return entry && !entry.todo && Number.isFinite(entry.pan);
  }).length;

  console.log(`\n${bold('Node graph')}`);
  console.log(`  ${roster.length} nodes, ${edges} edges`);
  console.log(`  arrows    ${picked} picked, ${derived} from the plan, ${auto} auto-placed`);
  console.log(
    `  alignment ${aligned}/${roster.length}` +
      (aligned === 0 ? dim('  (run tools/align.html — every pan is 0° until then)') : ''),
  );

  if (stale?.stale) {
    console.log(
      yellow(
        `\n! out of date — ${stale.reason}` +
          (stale.changedNodes.length
            ? ` (${stale.changedNodes.length} node(s): ${stale.changedNodes.join(', ')})`
            : ''),
      ),
    );
    console.log(`  ${yellow('Run:')} npm run nodes -- --tour=${stale.slug ?? '<slug>'}`);
  }

  if (errors.length) {
    console.log(`\n${red(`${errors.length} error(s):`)}`);
    for (const e of errors) console.log(`  ${red('✗')} ${e}`);
  }

  if (warnings.length) {
    console.log(`\n${yellow(`${warnings.length} warning(s):`)}`);
    for (const w of warnings) console.log(`  ${yellow('!')} ${w}`);
  }

  if (!errors.length && !warnings.length && !stale?.stale) {
    console.log(`\n${green('Graph is clean.')}`);
  }
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

function pad(n) {
  return String(n).padStart(2, '0');
}

const tty = process.stdout.isTTY;
const wrap = (code) => (s) => (tty ? `[${code}m${s}[0m` : s);
const bold = wrap(1);
const dim = wrap(2);
const red = wrap(31);
const green = wrap(32);
const yellow = wrap(33);
