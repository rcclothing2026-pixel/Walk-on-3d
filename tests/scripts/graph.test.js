import { describe, it, expect } from 'vitest';

import { adjacency, validate, adjacencyOf } from '../../scripts/graph.js';
import { generateNodes, staleness, stableStringify } from '../../scripts/generate-graph.js';

/** A tiny three-room venue: 1 — 2 — 3, with 3 also opening onto 4. */
function rosterOf(...numbers) {
  const names = Object.fromEntries(
    numbers.map((n) => [String(n).padStart(2, '0'), { name: `Node ${n}`, type: 'room' }]),
  );
  return {
    names,
    numbers: [...numbers].sort((a, b) => a - b),
    count: numbers.length,
    info(n) {
      return { name: `Node ${n}`, type: 'room', unconfirmed: false };
    },
    has(n) {
      return numbers.includes(Number(n));
    },
  };
}

describe('adjacency', () => {
  it('expands every edge both ways', () => {
    const adj = adjacency(
      [
        [1, 2],
        [2, 3],
      ],
      [1, 2, 3],
    );
    expect(adj.get(1)).toEqual([2]);
    expect(adj.get(2)).toEqual([1, 3]);
    expect(adj.get(3)).toEqual([2]);
  });

  it('drops edges naming nodes the roster lost', () => {
    const adj = adjacency([[9, 2]], [1, 2, 3]);
    expect(adj.get(2)).toEqual([]);
  });

  it('ignores a node linked to itself', () => {
    const adj = adjacency([[2, 2]], [1, 2]);
    expect(adj.get(2)).toEqual([]);
  });
});

describe('validate', () => {
  it('calls a one-way link an error', () => {
    // Built by hand-editing the generated file — the exact corruption
    // validate() exists to catch.
    const adj = new Map([
      [1, [2]],
      [2, []],
      [3, []],
    ]);
    const { errors } = validate(adj, [1, 2, 3], { start: 1 });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('reports an unreachable node as a warning, not an error', () => {
    const adj = new Map([
      [1, [2]],
      [2, [1]],
      [3, []],
    ]);
    const { errors, warnings } = validate(adj, [1, 2, 3], { start: 1 });
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes('03'))).toBe(true);
  });

  it('exempted single-link nodes stay quiet', () => {
    const adj = new Map([
      [1, [2]],
      [2, [1, 3]],
      [3, [2]],
    ]);
    const loud = validate(adj, [1, 2, 3], { start: 1 });
    expect(loud.errors).toEqual([]);
    expect(loud.warnings.some((w) => w.includes('03'))).toBe(true);

    const exempt = validate(adj, [1, 2, 3], {
      start: 1,
      deadEnds: [3],
      expectedSingleLink: [1],
    });
    expect(exempt.errors).toEqual([]);
    expect(exempt.warnings).toEqual([]);
  });
});

describe('generateNodes', () => {
  const rosterData = rosterOf(1, 2, 3);
  const links = { edges: [[1, 2], [2, 3]] };

  it('auto-places everything when nothing has been measured', () => {
    const { nodes, stats } = generateNodes({
      rosterData,
      links,
      alignment: {},
      previous: null,
      config: {},
    });

    expect(stats.auto).toBe(4); // two arrows per edge
    expect(stats.derived).toBe(0);
    expect(nodes['01'].links.every((l) => l.auto)).toBe(true);
    // Deterministic spread: first neighbour at yaw 0.
    expect(nodes['01'].links[0].yaw).toBe(0);
  });

  it('derives arrows once both endpoints are placed and anchored', () => {
    const previous = {
      nodes: {
        '01': { id: '01', links: [], map: { x: 100, y: 100 } },
        '02': { id: '02', links: [], map: { x: 200, y: 100 } }, // due "east"
        '03': { id: '03', links: [] },
      },
    };
    const alignment = { '01': { pan: 0, planNorth: 0 } }; // plan top = yaw 0

    const { nodes, stats } = generateNodes({
      rosterData,
      links,
      alignment,
      previous,
      config: {},
    });

    // From 01 to 02 the bearing is 90°; with planNorth 0 and pan 0 the arrow's
    // yaw *is* that bearing.
    const arrow = nodes['01'].links.find((l) => l.node === '02');
    expect(stats.derived).toBeGreaterThanOrEqual(1);
    expect(arrow.derived).toBe(true);
    expect(arrow.yaw).toBeCloseTo(90);
    // Node 02 is not anchored, so its arrow back stays auto.
    const back = nodes['02'].links.find((l) => l.node === '01');
    expect(back.auto).toBe(true);
  });

  it('never lets geometry overrule a hand-picked angle', () => {
    const previous = {
      nodes: {
        '01': {
          id: '01',
          map: { x: 100, y: 100 },
          links: [{ node: '02', yaw: 123, pitch: -20 }],
        },
        '02': { id: '02', map: { x: 200, y: 100 }, links: [] },
        '03': { id: '03', links: [] },
      },
    };
    const alignment = {
      '01': { pan: 0, planNorth: 0 },
      '02': { pan: 0, planNorth: 0 },
    };

    const { nodes, stats } = generateNodes({
      rosterData,
      links,
      alignment,
      previous,
      config: {},
    });

    const arrow = nodes['01'].links.find((l) => l.node === '02');
    expect(arrow.yaw).toBe(123);
    expect(arrow.auto).toBeUndefined();
    expect(arrow.derived).toBeUndefined();
    expect(stats.picked).toBe(1);
  });

  it('carries names, types and unconfirmed flags from the roster', () => {
    const { nodes } = generateNodes({ rosterData, links: { edges: [] }, alignment: {}, previous: null, config: {} });
    expect(nodes['01'].name).toBe('Node 1');
    expect(nodes['01'].map).toBeUndefined();
  });
});

describe('staleness', () => {
  const base = () =>
    generateNodes({
      rosterData: rosterOf(1, 2),
      links: { edges: [[1, 2]] },
      alignment: { '01': { pan: 0, planNorth: 0 } },
      previous: {
        nodes: {
          '01': { id: '01', links: [], map: { x: 0, y: 0 } },
          '02': { id: '02', links: [], map: { x: 100, y: 0 } },
        },
      },
      config: {},
    });

  it('is silent right after a rebuild', () => {
    const { nodes } = base();
    const again = generateNodes({
      rosterData: rosterOf(1, 2),
      links: { edges: [[1, 2]] },
      alignment: { '01': { pan: 0, planNorth: 0 } },
      previous: { nodes },
      config: {},
    });
    expect(staleness({ nodes }, again).stale).toBe(false);
  });

  it('catches an anchor recorded after the rebuild', () => {
    const before = base();
    // The operator sights a doorway in the design tool but nobody rebuilds:
    const drifted = generateNodes({
      rosterData: rosterOf(1, 2),
      links: { edges: [[1, 2]] },
      alignment: { '01': { pan: 0, planNorth: 47 } },
      previous: before.nodes && { nodes: before.nodes },
      config: {},
    });
    const verdict = staleness({ nodes: before.nodes }, drifted);
    expect(verdict.stale).toBe(true);
    expect(verdict.changedNodes).toContain('01');
  });

  it('treats a missing graph as stale', () => {
    const { nodes } = base();
    expect(staleness(null, { nodes }).stale).toBe(true);
  });
});

describe('stableStringify', () => {
  it('is immune to key order', () => {
    expect(stableStringify({ b: 1, a: [2, { z: 3, y: 4 }] })).toBe(
      stableStringify({ a: [2, { y: 4, z: 3 }], b: 1 }),
    );
  });
});

describe('adjacencyOf', () => {
  it('reads back what a generated graph describes', () => {
    const adj = adjacencyOf({
      '01': { links: [{ node: '02' }] },
      '02': { links: [{ node: '01' }, { node: '03' }] },
    });
    expect(adj.get(1)).toEqual([2]);
    expect(adj.get(2)).toEqual([1, 3]);
  });
});
