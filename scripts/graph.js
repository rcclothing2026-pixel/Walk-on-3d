/**
 * The link graph, as data.
 *
 * Which nodes connect to which is a property of a venue, not of this codebase,
 * so it lives in tours/<slug>/links.json as a list of pairs. Nothing here knows
 * anything about any particular building — that was the last thing standing
 * between one hardcoded tour and a system that takes any of them.
 *
 * Every edge is undirected. `adjacency()` expands each pair both ways, so a
 * one-way link cannot be introduced from the data file at all — only by
 * hand-editing the generated nodes.json, which is what `validate()` checks.
 */

/**
 * Expands an edge list into an adjacency map, restricted to the roster.
 *
 * Edges naming a node the roster no longer has are dropped rather than fatal:
 * nodes can be removed in the studio, and a stale edge should leave a reported
 * gap, not block the build.
 */
export function adjacency(edges = [], roster = []) {
  const known = new Set(roster);
  const adj = new Map(roster.map((n) => [n, new Set()]));

  for (const edge of edges) {
    const [a, b] = Array.isArray(edge) ? edge : [edge?.from, edge?.to];
    if (a === b || !known.has(Number(a)) || !known.has(Number(b))) continue;

    adj.get(Number(a)).add(Number(b));
    adj.get(Number(b)).add(Number(a));
  }

  return new Map(
    [...adj.entries()]
      .sort(([a], [b]) => a - b)
      .map(([node, set]) => [node, [...set].sort((a, b) => a - b)]),
  );
}

/**
 * Checks a graph and reports what is wrong with it.
 *
 * Splits findings on purpose:
 *
 *   errors   — structurally broken: a link to a node that does not exist, or a
 *              link that only goes one way. These make the tour incoherent and
 *              fail the build.
 *   warnings — suspicious but survivable: an unreachable node, or one with
 *              fewer links than expected. Printed on every run and left for a
 *              human to confirm.
 *
 * A brand-new tour has no edges at all, which is a normal starting state, so an
 * empty graph reports nothing.
 */
export function validate(adj, roster, { start, deadEnds = [], expectedSingleLink = [] } = {}) {
  const errors = [];
  const warnings = [];
  const known = new Set(roster);
  const allowed = new Set([...deadEnds, ...expectedSingleLink].map(Number));
  const hasEdges = [...adj.values()].some((list) => list.length);

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

  if (!hasEdges) return { errors, warnings };

  for (const node of roster) {
    const degree = adj.get(node)?.length ?? 0;

    if (degree === 0) {
      warnings.push(
        `node ${pad(node)} has no links at all — unreachable by arrow, only by deep link`,
      );
    } else if (degree < 2 && !allowed.has(node)) {
      warnings.push(`node ${pad(node)} has only one link and is not listed as a dead end`);
    }
  }

  const from = Number(start) || roster[0];
  for (const node of unreachable(adj, roster, from)) {
    if ((adj.get(node)?.length ?? 0) > 0) {
      warnings.push(`node ${pad(node)} cannot be walked to from node ${pad(from)}`);
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
