#!/usr/bin/env node
/**
 * Does this tour's photography know which way it was facing?
 *
 * Anchoring a node by hand exists because a panorama, on its own, has no
 * relationship to a floor plan — nothing in the pixels says which way the
 * camera was pointing. But some cameras do record it: a compass reading written
 * into the XMP as GPano:PoseHeadingDegrees.
 *
 * If these photographs carry it, every node could be anchored from the file and
 * nobody would need to sight anything. This says whether they do. It reads and
 * reports; it changes nothing.
 *
 * Usage:
 *   npm run heading -- --tour=hammam
 *   npm run heading -- --tour=hammam --all    every file, not just a sample
 */

import path from 'node:path';
import process from 'node:process';

import { ROOT, resolveTour } from './tours.js';
import { listRaw } from './raw.js';

const SAMPLE = 8;

main().catch((err) => {
  console.error(`\n${red('Failed:')} ${err.message}`);
  process.exitCode = 1;
});

async function main() {
  const argv = process.argv.slice(2);
  const tour = await resolveTour(argv);
  const every = argv.includes('--all');

  const { default: sharp } = await import('sharp');
  const files = await listRaw(tour.raw);

  if (!files.length) {
    console.error(`\n${red('No photographs')} in ${path.relative(ROOT, tour.raw) || tour.raw}\n`);
    process.exitCode = 1;
    return;
  }

  const looking = every ? files : files.slice(0, SAMPLE);
  console.log(`\n${bold('Camera headings')}  ${tour.slug}`);
  console.log(`  ${looking.length} of ${files.length} file(s) in ${tour.raw}\n`);

  let found = 0;

  for (const file of looking) {
    const { xmp } = await sharp(path.join(tour.raw, file)).metadata();
    const text = xmp?.toString('latin1') ?? '';
    const heading = read(text, 'PoseHeadingDegrees');
    const projection = read(text, 'ProjectionType');

    if (heading !== null) found++;

    console.log(
      `  ${file.padEnd(12)} ${
        heading === null ? dim('no heading') : green(`${Number(heading).toFixed(1)}deg`)
      }   ${dim(projection ? `${projection}` : xmp ? 'xmp, no projection' : 'no xmp')}`,
    );
  }

  console.log('');

  if (!found) {
    console.log(
      `${yellow('No headings recorded.')} Anchor each node by sighting a neighbour in\n` +
        'tools/design.html — one sighting per node.\n',
    );
    return;
  }

  if (found < looking.length) {
    console.log(
      `${yellow(`Only ${found} of ${looking.length} carry a heading.`)} A partial set cannot be\n` +
        'trusted as a whole — sight those nodes by hand and tell me about the rest.\n',
    );
    return;
  }

  console.log(
    `${green('Every file carries a heading.')} These are compass bearings, not plan\n` +
      'bearings, so they still need one node sighted to find the offset between\n' +
      'magnetic north and the top of the drawing — after that every other node\n' +
      'can be anchored from its file. Say the word and I will wire that up.\n',
  );
}

/** XMP is written both as an attribute and as an element, depending on the tool. */
function read(text, tag) {
  const attribute = text.match(new RegExp(`${tag}="([^"]+)"`))?.[1];
  const element = text.match(new RegExp(`<GPano:${tag}>([^<]+)<`))?.[1];
  return attribute ?? element ?? null;
}

const tty = process.stdout.isTTY;
const ESC = String.fromCharCode(27);
const wrap = (code) => (s) => (tty ? `${ESC}[${code}m${s}${ESC}[0m` : s);
const bold = wrap(1);
const dim = wrap(2);
const red = wrap(31);
const green = wrap(32);
const yellow = wrap(33);
