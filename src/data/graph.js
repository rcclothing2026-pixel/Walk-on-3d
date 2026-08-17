/**
 * The link graph — which nodes connect to which.
 *
 * This is the shape of the tour, transcribed from the project brief. It is
 * deliberately written the way the brief expresses it (a spine, a descent,
 * leaves hanging off anchors, chains inside clusters) rather than as a flat
 * edge list, so that correcting it against the real venue stays legible.
 *
 * Every edge here is undirected. `adjacency()` expands them symmetrically, so
 * a one-way link cannot be introduced by accident from this file — only by
 * hand-editing the generated nodes.json, which is exactly what `validate()`
 * checks for.
 */

/** The main circulation loop. The trailing 4 closes it back on itself. */
export const SPINE = [3, 4, 6, 9, 14, 16, 21, 24, 27, 35, 37, 4];

/** The staircase down from the entrance. */
export const DESCENT = [1, 2, 3];

/** Rooms and booths hanging off each spine anchor. */
export const LEAVES = {
  4: [5],
  6: [5, 7, 8],
  9: [8, 10, 11, 12],
  14: [13, 15],
  16: [17, 18, 19],
  21: [19, 20, 22],
  24: [22, 23, 25, 26],
  27: [26, 28, 29],
  35: [29, 31, 32, 34, 36],
  37: [36, 38, 40],
  38: [39],
  40: [41],
  41: [42],
  42: [43],
};

/** Runs of adjacent nodes inside a cluster. */
export const CHAINS = [
  [11, 12],
  [29, 31],
  [32, 33, 35],
  [38, 39],
  [40, 41, 42, 43],
];

/**
 * Nodes the brief names as genuine dead ends — one link is correct for them.
 */
export const DEAD_ENDS = new Set([23, 43]);

/**
 * Nodes that also end up with a single link, but which the brief does not list
 * as dead ends.
 *
 * Almost all are booths hanging off a corridor, which is a perfectly normal
 * shape for this plan, so they are treated as expected rather than failing the
 * build. They are listed explicitly — not inferred — so that the day someone
 * confirms the real layout, the diff shows exactly which assumptions were made.
 *
 * Node 1 is the top of the entrance staircase: a terminus by definition.
 */
export const SINGLE_LINK_PENDING = new Set([1, 7, 10, 13, 15, 17, 18, 20, 25, 28, 34, 39]);

/**
 * Builds the undirected adjacency map: node number → sorted array of neighbours.
 *
 * Pass the roster to drop edges that point at nodes which no longer exist. The
 * roster in names.json is editable from the studio, so the graph transcribed
 * here can legitimately fall out of date with it; a removed node should leave a
 * reported gap rather than failing the build with a dangling link.
 */
export function adjacency(roster = null) {
  const adj = new Map();
  const link = (a, b) => {
    if (a === b) return;
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b);
    adj.get(b).add(a);
  };
  const chain = (nodes) => {
    for (let i = 0; i < nodes.length - 1; i++) link(nodes[i], nodes[i + 1]);
  };

  chain(SPINE);
  chain(DESCENT);
  for (const [anchor, leaves] of Object.entries(LEAVES)) {
    for (const leaf of leaves) link(Number(anchor), leaf);
  }
  for (const run of CHAINS) chain(run);

  const known = roster ? new Set(roster) : null;
  const entries = [...adj.entries()]
    .filter(([node]) => !known || known.has(node))
    .sort(([a], [b]) => a - b)
    .map(([node, set]) => [
      node,
      [...set].filter((n) => !known || known.has(n)).sort((a, b) => a - b),
    ]);

  // Nodes added to the roster but not yet wired into the graph above.
  if (known) {
    for (const node of known) if (!adj.has(node)) entries.push([node, []]);
    entries.sort(([a], [b]) => a - b);
  }

  return new Map(entries);
}

/**
 * Checks the graph and reports what is wrong with it.
 *
 * Splits findings into two buckets on purpose:
 *
 *   errors   — structurally broken. A link pointing at a node that does not
 *              exist, or a link that only goes one way. These make the tour
 *              incoherent and fail the build.
 *   warnings — suspicious but survivable. An unreachable node, or a node with
 *              fewer than two links that has not been accounted for. These are
 *              printed loudly on every build and left for a human to confirm.
 *
 * @param {Map<number, number[]>} adj  adjacency to check
 * @param {number[]} roster            every node that is supposed to exist
 * @param {number} start               node the tour opens at
 */
export function validate(adj, roster, start = roster[0]) {
  const errors = [];
  const warnings = [];
  const known = new Set(roster);

  for (const [node, neighbours] of adj) {
    if (!known.has(node)) {
      errors.push(`node ${pad(node)} has links but is not in the roster`);
      continue;
    }

    for (const other of neighbours) {
      if (!known.has(other)) {
        errors.push(`node ${pad(node)} links to ${pad(other)}, which is not in the roster`);
        continue;
      }
      if (!adj.get(other)?.includes(node)) {
        errors.push(`link ${pad(node)} → ${pad(other)} is one-way; every link must be mutual`);
      }
    }
  }

  for (const node of roster) {
    const degree = adj.get(node)?.length ?? 0;

    if (degree === 0) {
      warnings.push(
        `node ${pad(node)} has no links at all — unreachable by arrow, ` +
          `only by deep link. It needs an anchor.`,
      );
    } else if (degree < 2 && !DEAD_ENDS.has(node) && !SINGLE_LINK_PENDING.has(node)) {
      warnings.push(`node ${pad(node)} has only one link and is not listed as a dead end`);
    }
  }

  for (const node of unreachable(adj, roster, start)) {
    if ((adj.get(node)?.length ?? 0) > 0) {
      warnings.push(`node ${pad(node)} cannot be walked to from node ${pad(start)}`);
    }
  }

  return { errors, warnings };
}

/** Nodes not reachable from `start` by following links. */
function unreachable(adj, roster, start) {
  const seen = new Set([start]);
  const queue = [start];

  while (queue.length) {
    for (const next of adj.get(queue.pop()) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }

  return roster.filter((n) => !seen.has(n));
}

function pad(n) {
  return String(n).padStart(2, '0');
}
