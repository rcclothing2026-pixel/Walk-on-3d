/**
 * Generating a tour's node graph, and knowing when it is out of date.
 *
 * Everything here is pure: it reads only the objects passed in and touches no
 * files, so the CLI (scripts/build-nodes.js), the studio API
 * (scripts/dev-api.js) and the tests can all drive the same generation.
 *
 * The staleness question is answered by regenerating rather than by hashing
 * inputs: "what `npm run nodes` would write now" is compared against what is
 * actually on disk. Input hashes go stale whenever the rules change; an output
 * diff can never lie about whether a rebuild would change anything a visitor
 * sees.
 *
 * Node-only in spirit but side-effect free, so it imports cleanly anywhere.
 */

import { adjacency } from './graph.js';
import { arrowYaw, planBearing, planNorthFromSighting } from '../src/lib/geometry.js';

/** Where auto-placed floor arrows sit, in degrees. Mid-range of the brief's -15..-30. */
export const AUTO_PITCH = -20;

/**
 * Builds the nodes map a tour's current data implies.
 *
 * Merge rules, strongest first:
 *
 *   picked    a human aimed this arrow in tools/hotspots.html — never touched
 *   derived   worked out from the floor plan: both endpoints placed, the node
 *             anchored by a sighting. Recomputed every run so moving a dot or
 *             re-anchoring moves the arrows with it
 *   auto      spread evenly round the horizon — walkable, meaningless, honest
 *
 * @param {object}  inputs
 * @param {object}  inputs.rosterData  loadRoster() result for this tour
 * @param {object}  inputs.links       links.json contents ({ edges, ... })
 * @param {object?} inputs.alignment   alignment.json contents
 * @param {object?} inputs.previous    the nodes.json currently on disk
 * @param {object?} inputs.config      tour.json contents
 * @returns {{ nodes: object, stats: { picked: number, derived: number, auto: number } }}
 */
export function generateNodes({ rosterData, links, alignment, previous, config }) {
  const roster = rosterData.numbers;
  const adj = adjacency(links.edges ?? [], roster);
  const mirrored = Boolean(config?.mirrored);
  const nodes = {};
  const stats = { picked: 0, derived: 0, auto: 0 };

  for (const n of roster) {
    const id = pad(n);
    const { name, type, unconfirmed } = rosterData.info(n);
    const neighbours = adj.get(n) ?? [];
    const previousLinks = indexLinks(previous?.nodes?.[id]?.links);

    const nodeLinks = neighbours.map((other, index) => {
      const existing = previousLinks.get(pad(other));

      // Hand-picked wins over everything. Someone looked at the picture and
      // decided; geometry does not get to overrule that.
      if (existing && !existing.auto && !existing.derived) {
        stats.picked++;
        return { node: pad(other), yaw: existing.yaw, pitch: existing.pitch };
      }

      const geometric = deriveArrow(n, other, { alignment, previous, mirrored });

      if (geometric !== null) {
        stats.derived++;
        return {
          node: pad(other),
          yaw: round(geometric),
          // Pitch cannot come from the plan without a scale, so it stays at the
          // default and stays editable. Better an honest constant than a
          // number that looks measured and is not.
          pitch: existing?.derived ? existing.pitch : AUTO_PITCH,
          derived: true,
        };
      }

      stats.auto++;
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
      ...(isPoint(mapPoint) ? { map: { x: mapPoint.x, y: mapPoint.y } } : {}),
      links: nodeLinks,
    };
  }

  return { nodes, stats };
}

/**
 * Whether regenerating now would produce something different from `previous`.
 *
 * Returns which nodes differ, so the report can point at the work rather than
 * just shouting. An absent previous graph counts as stale — there is nothing
 * on disk to walk.
 */
export function staleness(previous, generated) {
  if (!previous?.nodes) {
    return { stale: true, changedNodes: [], reason: 'no generated graph on disk' };
  }

  const changedNodes = Object.keys(generated.nodes)
    .filter((id) => stableStringify(generated.nodes[id]) !== stableStringify(previous.nodes[id]));

  return {
    stale: changedNodes.length > 0,
    changedNodes,
    reason: changedNodes.length ? 'links, alignment or names have moved since the last rebuild' : null,
  };
}

/** Deterministic JSON: key order can never make two equal graphs differ. */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const body = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/* ------------------------------------------------------------------ *
 * Arrow geometry — one copy, shared with nothing else
 * ------------------------------------------------------------------ */

/**
 * An arrow angle taken from the floor plan.
 *
 * Needs three things: both nodes placed on the plan, and the node being looked
 * *from* anchored to it — which is what one sighting in the design tool
 * records. Returns null when any of them is missing, so a tour that has not
 * been through that step falls back to the arbitrary spread exactly as before.
 */
function deriveArrow(from, to, { alignment, previous, mirrored }) {
  const a = previous?.nodes?.[pad(from)]?.map;
  const b = previous?.nodes?.[pad(to)]?.map;
  if (!isPoint(a) || !isPoint(b)) return null;

  const planNorth = anchorOf(from, { alignment, previous, mirrored });
  if (!Number.isFinite(planNorth)) return null;

  // Two nodes on the same spot have no bearing between them. That is a bad map
  // point rather than a legitimate arrow, so it falls through to auto and shows
  // up as one.
  if (a.x === b.x && a.y === b.y) return null;

  return arrowYaw({
    planNorth,
    pan: readPan(alignment, pad(from)),
    bearing: planBearing(a, b),
    mirrored,
  });
}

/**
 * A node's anchor against the plan.
 *
 * Recomputed from the sighting that produced it whenever one was recorded, so
 * that moving a dot — or discovering the panoramas are mirrored — moves the
 * arrows too, without anyone standing in the node again. The stored value is
 * the fallback for anchors made before sightings were kept.
 */
function anchorOf(node, { alignment, previous, mirrored }) {
  const entry = alignment?.[pad(node)];
  if (!entry) return null;

  const sight = entry.sight;
  const here = previous?.nodes?.[pad(node)]?.map;
  const there = sight ? previous?.nodes?.[pad(Number(sight.target))]?.map : null;

  if (Number.isFinite(sight?.raw) && isPoint(here) && isPoint(there)) {
    return planNorthFromSighting({
      observedYaw: sight.raw,
      pan: 0,
      bearing: planBearing(here, there),
      mirrored,
    });
  }

  return Number.isFinite(entry.planNorth) ? entry.planNorth : null;
}

function isPoint(p) {
  return Number.isFinite(p?.x) && Number.isFinite(p?.y);
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

function round(value) {
  return Math.round(value * 10) / 10;
}

function pad(n) {
  return String(n).padStart(2, '0');
}
