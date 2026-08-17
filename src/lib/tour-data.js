/**
 * Loading a tour's data in the browser.
 *
 * Every tour owns its own roster, link graph and brands, so none of this can be
 * a static import any more — which file to read is not known until the page
 * knows which tour it is showing. It is fetched once at startup and handed
 * round as a plain object, so callers stay synchronous after that.
 */

import { dataUrl } from './paths.js';
import { TOUR_SLUG } from '../config.js';

/**
 * @typedef {object} TourData
 * @property {object} config   tour.json — title, start node, map cutoff
 * @property {object} names    node number → { name, type, unconfirmed }
 * @property {object} nodes    the generated graph, keyed by padded id
 * @property {object} brands   brand pins, keyed by padded id
 */

/**
 * Fetches everything a tour needs.
 *
 * `nodes` and `brands` are optional: a tour that has not been generated yet, or
 * has no brands, is a normal state rather than an error. `tour.json` and
 * `names.json` are not — without them there is no tour.
 */
export async function loadTourData() {
  const [config, names, nodes, brands] = await Promise.all([
    fetchJson('tour', { required: true }),
    fetchJson('names', { required: true }),
    fetchJson('nodes'),
    fetchJson('brands'),
  ]);

  return {
    slug: TOUR_SLUG,
    config: config ?? {},
    names: names?.nodes ?? {},
    nodes: nodes?.nodes ?? null,
    brands: brands?.brands ?? {},

    /** Node numbers in tour order. */
    numbers() {
      return Object.keys(this.names)
        .map(Number)
        .filter(Number.isInteger)
        .sort((a, b) => a - b);
    },

    /** Name and type for a node, or a placeholder if it is not in the roster. */
    info(n) {
      const entry = this.names[pad(n)];
      if (!entry) return { name: `؟ (${pad(n)})`, type: 'unknown', unconfirmed: true };
      return {
        name: entry.name,
        type: entry.type,
        unconfirmed: Boolean(entry.unconfirmed),
      };
    },

    /** The generated entry for a node, if the graph has been built. */
    node(n) {
      return this.nodes?.[pad(n)] ?? null;
    },
  };
}

async function fetchJson(name, { required = false } = {}) {
  try {
    const response = await fetch(dataUrl(name));
    if (!response.ok) throw new Error(String(response.status));
    return await response.json();
  } catch (err) {
    if (required) {
      throw new Error(
        `Could not load ${name}.json for tour "${TOUR_SLUG || '(none selected)'}" — ${err.message}`,
      );
    }
    return null;
  }
}

function pad(n) {
  return String(n).padStart(2, '0');
}
