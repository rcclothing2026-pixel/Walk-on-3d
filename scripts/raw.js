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
export async function findRaw(rawDir, node) {
  for (const name of rawCandidates(node)) {
    const candidate = path.join(rawDir, name);
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // next candidate
    }
  }

  return null;
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
