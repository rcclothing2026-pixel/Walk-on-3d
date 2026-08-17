/**
 * A tour's roster, read from its names.json.
 *
 * Deliberately read rather than imported: the studio edits names.json
 * constantly, and importing it would pull it into vite's config dependency
 * graph so that every rename restarted the dev server.
 *
 * Node-only.
 */

import { readJson } from './tours.js';

export async function loadRoster(paths) {
  const names = (await readJson(paths.file('names')))?.nodes ?? {};

  const numbers = Object.keys(names)
    .map(Number)
    .filter(Number.isInteger)
    .sort((a, b) => a - b);

  return {
    names,
    numbers,
    count: numbers.length,
    first: numbers[0] ?? 1,
    last: numbers[numbers.length - 1] ?? 1,

    info(n) {
      const entry = names[String(n).padStart(2, '0')];
      if (!entry) return { name: `؟ (${String(n).padStart(2, '0')})`, type: 'unknown', unconfirmed: true };
      return { name: entry.name, type: entry.type, unconfirmed: Boolean(entry.unconfirmed) };
    },

    has(n) {
      return numbers.includes(Number(n));
    },
  };
}
