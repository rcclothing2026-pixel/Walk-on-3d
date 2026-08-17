/**
 * The node roster — the single source of truth for *which* nodes exist.
 *
 * Everything (the image pipeline, the alignment tool, the hotspot picker, the
 * viewer) derives its node list from here rather than hardcoding a count, so
 * adding or renumbering a shooting point is a change to names.json alone.
 *
 * Note that `Object.keys()` on the raw JSON does NOT come back in tour order:
 * JS hoists canonical integer-like keys, so "10"…"43" sort ahead of "01"…"09".
 * `nodeNumbers()` sorts numerically and is what callers should use.
 */

import names from '../data/names.json' with { type: 'json' };

/** Node numbers in tour order, e.g. [1, 2, 3, …, 43]. */
export function nodeNumbers() {
  return Object.keys(names.nodes)
    .map(Number)
    .filter(Number.isInteger)
    .sort((a, b) => a - b);
}

/** How many nodes the tour has. */
export function nodeCount() {
  return nodeNumbers().length;
}

/** The lowest and highest node numbers. */
export function nodeRange() {
  const numbers = nodeNumbers();
  return { first: numbers[0], last: numbers[numbers.length - 1] };
}

/** True when `n` is a node in the roster. */
export function isNode(n) {
  return String(n).padStart(2, '0') in names.nodes;
}

/**
 * Name and type for a node, or a placeholder if it is not in the roster.
 * `unconfirmed` marks a name that still needs verifying on site.
 */
export function nodeInfo(n) {
  const key = String(n).padStart(2, '0');
  const entry = names.nodes[key];
  if (!entry) return { name: `؟ (${key})`, type: 'unknown', unconfirmed: true };
  return { name: entry.name, type: entry.type, unconfirmed: Boolean(entry.unconfirmed) };
}
