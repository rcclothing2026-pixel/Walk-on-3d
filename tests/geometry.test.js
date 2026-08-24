import { describe, it, expect } from 'vitest';

import {
  planBearing,
  rawAngle,
  planNorthFromSighting,
  arrowYaw,
  detectMirrored,
  difference,
  norm360,
} from '../src/lib/geometry.js';

/**
 * The conventions under test were measured against Photo Sphere Viewer:
 * yaw grows clockwise seen from above, and yaw + pan is invariant.
 * Every expectation below is worked out by hand on paper coordinates.
 */

describe('norm360', () => {
  it('wraps into [0, 360)', () => {
    expect(norm360(-90)).toBe(270);
    expect(norm360(0)).toBe(0);
    expect(norm360(359)).toBe(359);
    expect(norm360(720)).toBe(0);
  });
});

describe('difference', () => {
  it('gives the signed shortest way round', () => {
    expect(difference(10, 30)).toBeCloseTo(-20);
    expect(difference(30, 10)).toBeCloseTo(20);
    expect(difference(350, 10)).toBeCloseTo(-20);
    expect(difference(180, -180)).toBeLessThanOrEqual(180);
  });
});

describe('planBearing', () => {
  const A = { x: 100, y: 100 };

  it('reads the drawing: 0° is up, degrees increase clockwise', () => {
    expect(planBearing(A, { x: 100, y: 0 })).toBe(0); // straight up
    expect(planBearing(A, { x: 200, y: 100 })).toBe(90); // right
    expect(planBearing(A, { x: 100, y: 200 })).toBe(180); // down
    expect(planBearing(A, { x: 0, y: 100 })).toBe(270); // left
  });

  it('is scale-free — direction needs no calibration', () => {
    // Same direction, different distances: the bearing cannot care.
    expect(planBearing(A, { x: 300, y: 500 })).toBe(planBearing(A, { x: 200, y: 300 }));
  });
});

describe('rawAngle', () => {
  it('is invariant under sphere correction', () => {
    // Whatever pan does to what is on screen, observed + pan stays put.
    expect(rawAngle(30, 10)).toBe(rawAngle(40, 0));
    expect(rawAngle(350, 20)).toBe(rawAngle(10, 0));
  });
});

describe('planNorthFromSighting', () => {
  it('anchors so that sighting a bearing lands the camera on it', () => {
    // Stand at yaw 90 (with pan 15), look at something the plan puts at 45°.
    const planNorth = planNorthFromSighting({ observedYaw: 90, pan: 15, bearing: 45 });
    expect(planNorth).toBeCloseTo(norm360(105 - 45));
  });

  it('mirrors the sign of the bearing for mirrored frames', () => {
    const straight = planNorthFromSighting({ observedYaw: 90, bearing: 45 });
    const mirrored = planNorthFromSighting({ observedYaw: 90, bearing: 45, mirrored: true });
    expect(mirrored).toBeCloseTo(norm360(straight + 2 * 45));
  });
});

describe('arrowYaw', () => {
  it('round trip: an anchored node aims its neighbour where the plan says', () => {
    const planNorth = 200;
    const bearing = 60;
    const pan = 12;
    const yaw = arrowYaw({ planNorth, pan, bearing });

    // The anchor came from sighting this same bearing; the arrow must land
    // the camera on it again once alignment is applied.
    expect(norm360(yaw + pan)).toBeCloseTo(norm360(planNorth + bearing));
  });

  it('mirrors for mirrored tours without moving the anchor', () => {
    const yawStraight = arrowYaw({ planNorth: 0, bearing: 90 });
    const yawMirrored = arrowYaw({ planNorth: 0, bearing: 90, mirrored: true });
    expect(yawStraight).toBe(90);
    expect(yawMirrored).toBe(270);
  });
});

describe('detectMirrored', () => {
  it('recognises agreeing handedness with a small residual', () => {
    // Building says the second doorway is 70° clockwise of the first,
    // and the panorama agrees.
    const v = detectMirrored(
      { observedYaw: 10, bearing: 0 },
      { observedYaw: 80, bearing: 70 },
    );
    expect(v.mirrored).toBe(false);
    expect(v.residual).toBe(0);
    expect(v.separation).toBe(70);
  });

  it('flags mirrored when the picture disagrees about the sign', () => {
    const v = detectMirrored(
      { observedYaw: 10, bearing: 0 },
      { observedYaw: 340, bearing: 70 }, // went anticlockwise instead
    );
    expect(v.mirrored).toBe(true);
  });

  it('reports a tiny separation as untrustworthy rather than averaged away', () => {
    const v = detectMirrored(
      { observedYaw: 10, bearing: 0 },
      { observedYaw: 12, bearing: 3 },
    );
    expect(v.separation).toBeLessThan(25);
  });
});
