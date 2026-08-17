/**
 * Finding a node's source photo.
 *
 * Cameras and export tools disagree about zero-padding and extension case, and
 * the numbering is the only part that actually matters. Rather than making
 * people rename 43 files — or worse, rename them wrongly — this accepts any of:
 *
 *   07.jpg   7.jpg   07.JPG   7.jpeg   007.jpg
 *
 * Node 7 is node 7 however it is spelled. The first match in this order wins,
 * so a padded name is preferred when both happen to exist.
 *
 * Node-only: this touches the filesystem, so it must not be imported by the
 * browser bundle.
 */

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const EXTENSIONS = ['jpg', 'jpeg', 'JPG', 'JPEG'];

/**
 * Explicit node → filename assignments, made in the studio.
 *
 * Photographs do not necessarily arrive numbered in tour order — for the first
 * venue there were 42 files against 43 nodes against 44 shooting points, and no
 * single offset reconciled them. Rather than guessing, the assignment is
 * recorded by looking at the pictures.
 *
 * A node with no entry falls back to matching the number in the filename, so an
 * untouched tour still works.
 */

/** Candidate filenames for a node, most conventional first. */
export function rawCandidates(node) {
  const n = Number(node);
  const spellings = [String(n).padStart(2, '0'), String(n)];
  const names = [];

  for (const spelling of spellings) {
    for (const ext of EXTENSIONS) names.push(`${spelling}.${ext}`);
  }

  return [...new Set(names)];
}

/**
 * The source file for a node, or null when there is none.
 *
 * @param {string} rawDir
 * @param {number} node
 * @returns {Promise<string|null>} absolute path
 */
export async function findRaw(rawDir, node, sources = {}) {
  const assigned = sources[String(node).padStart(2, '0')];

  // An explicit assignment wins outright. If it names a file that has since
  // been moved or renamed, that is a mistake worth surfacing rather than
  // silently papering over with a numeric guess.
  if (assigned) {
    const target = path.join(rawDir, path.basename(assigned));
    try {
      return (await stat(target)).isFile() ? target : null;
    } catch {
      return null;
    }
  }

  // Files another node has explicitly claimed are off limits to the numeric
  // fallback. Without this, assigning 1.jpg to node 12 would leave node 01
  // still matching it by name, and the same panorama would be built and shown
  // in two places.
  const taken = new Set(
    Object.entries(sources ?? {})
      .filter(([id]) => id !== String(node).padStart(2, '0'))
      .map(([, file]) => path.basename(file)),
  );

  for (const name of rawCandidates(node)) {
    if (taken.has(name)) continue;

    const candidate = path.join(rawDir, name);
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // next candidate
    }
  }

  return null;
}

/** Every numbered photo in the directory, sorted naturally. */
export async function listRaw(rawDir) {
  try {
    const entries = await readdir(rawDir);
    return entries
      .filter((entry) => /\.(jpe?g)$/i.test(entry) && !entry.startsWith('.'))
      .sort((a, b) => {
        const na = Number(a.match(/\d+/)?.[0] ?? Infinity);
        const nb = Number(b.match(/\d+/)?.[0] ?? Infinity);
        return na === nb ? a.localeCompare(b) : na - nb;
      });
  } catch {
    return [];
  }
}

/**
 * True when a directory holds anything that looks like a numbered panorama.
 *
 * Used to tell "you pointed at the wrong folder" apart from "the folder is
 * there but empty", which are very different mistakes.
 */
export async function hasRawFiles(rawDir) {
  try {
    const entries = await readdir(rawDir);
    return entries.some((entry) => /^\d{1,3}\.(jpe?g)$/i.test(entry));
  } catch {
    return false;
  }
}
