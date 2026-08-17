/**
 * Tours, and where each one's files live.
 *
 * A tour is a folder under tours/ holding everything about one venue: its
 * roster, its link graph, its floor plan, its alignment, its brand pins. There
 * is nothing global — adding a second venue is creating a second folder, and no
 * tour can see another's data.
 *
 * That shape exists so a finished tour can be handed over as a self-contained
 * bundle. `npm run build` emits one directory per tour containing its own data,
 * plan and page, deployable on its own.
 *
 * Panoramas are the exception: they stay outside the tour folder, under
 * panos/<slug>/, because they are hundreds of megabytes and must never be
 * copied into a bundle or committed.
 *
 * Node-only — this touches the filesystem.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TOURS_DIR = path.join(ROOT, 'tours');
export const PANOS_DIR = path.join(ROOT, 'panos');

/** The files a tour owns, and whether it can exist without them. */
export const TOUR_FILES = {
  tour: { file: 'tour.json', required: true },
  names: { file: 'names.json', required: true },
  nodes: { file: 'nodes.json', required: false },
  alignment: { file: 'alignment.json', required: false },
  sources: { file: 'sources.json', required: false },
  brands: { file: 'brands.json', required: false },
  links: { file: 'links.json', required: false },
};

/** Every tour slug, alphabetically. */
export async function listTours() {
  try {
    const entries = await readdir(TOURS_DIR, { withFileTypes: true });
    const slugs = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (await exists(path.join(TOURS_DIR, entry.name, 'tour.json'))) slugs.push(entry.name);
    }

    return slugs.sort();
  } catch {
    return [];
  }
}

/**
 * Resolves one tour's paths.
 *
 * Throws on an unknown slug rather than returning something empty — a typo in a
 * slug should stop the run, not quietly produce a tour with no nodes.
 */
export async function tourPaths(slug) {
  assertSlug(slug);

  const dir = path.join(TOURS_DIR, slug);
  if (!(await exists(path.join(dir, 'tour.json')))) {
    const available = (await listTours()).join(', ') || 'none';
    throw new Error(`No tour "${slug}" in tours/. Available: ${available}`);
  }

  const config = await readJson(path.join(dir, 'tour.json'));

  return {
    slug,
    dir,
    config,
    panos: path.join(PANOS_DIR, slug),
    // Relative rawDir is resolved against the project root, not the tour
    // folder, so "raw" keeps meaning the same thing it always did.
    raw: path.resolve(ROOT, config.rawDir || 'raw'),
    file: (key) => path.join(dir, TOUR_FILES[key]?.file ?? key),
    floorplan: path.join(dir, 'floorplan.png'),
  };
}

/**
 * The tour to act on when none is named.
 *
 * One tour means there is nothing to choose; several means the choice has to be
 * explicit, because silently picking the alphabetically-first one would write
 * to the wrong venue.
 */
export async function defaultTour() {
  const slugs = await listTours();

  if (!slugs.length) throw new Error('No tours yet. Create one in tours/<slug>/ with a tour.json.');
  if (slugs.length > 1) {
    throw new Error(`Several tours exist (${slugs.join(', ')}). Pass --tour=<slug>.`);
  }

  return slugs[0];
}

/** Reads --tour=slug from argv, falling back to the only tour there is. */
export async function resolveTour(argv = []) {
  const flag = argv.find((arg) => arg.startsWith('--tour='));
  return tourPaths(flag ? flag.slice('--tour='.length) : await defaultTour());
}

/**
 * Slugs become directory names and URL segments, so they are kept boring on
 * purpose: no dots, no slashes, nothing that could climb out of tours/.
 */
export function assertSlug(slug) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(slug ?? ''))) {
    throw new Error(
      `"${slug}" is not a valid tour slug — lower-case letters, digits and hyphens only.`,
    );
  }
  return slug;
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
