/**
 * Turning floor-plan positions into arrow directions.
 *
 * Two nodes on a plan give the compass bearing between them for nothing —
 * direction needs no scale and no calibration. An arrow's yaw *is* that
 * bearing, once the panorama is anchored to the plan. So every arrow in a tour
 * is already implied by the dots someone placed, and aiming a hundred of them
 * by hand is work the geometry can do.
 *
 * Anchoring is one sighting per node: stand at A, turn until you can see B,
 * and the offset between what you are looking at and where the plan says B is
 * fixes that panorama against the drawing for good.
 *
 * Imported by both the tools and the build, so the browser and the pipeline
 * cannot drift apart on what an arrow angle means.
 *
 * The conventions here were measured against Photo Sphere Viewer, not assumed:
 *
 *   - yaw increases with the panorama's image x, so clockwise seen from above
 *   - a fixed feature sits at a constant `yaw + pan`, whatever the correction
 *
 * The one thing that cannot be measured here is whether the camera writes its
 * equirectangular frames in the usual handedness. `mirrored` exists for that,
 * and is decided per tour from two real sightings rather than guessed.
 */

/**
 * Compass bearing from one plan point to another.
 *
 * Degrees, 0° at the top of the drawing, increasing clockwise — the same sense
 * as a viewer's yaw, since a floor plan is drawn looking down.
 */
export function planBearing(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return norm360((Math.atan2(dx, -dy) * 180) / Math.PI);
}

/**
 * The panorama's own angle for whatever is on screen.
 *
 * Invariant under `sphereCorrection.pan`: correcting the sphere moves the
 * observed yaw and this sum stays put, which is what makes it usable as a
 * fixed reference for the image itself.
 */
export function rawAngle(observedYaw, pan) {
  return norm360(observedYaw + pan);
}

/**
 * Anchors a panorama to the plan from one sighting.
 *
 * Returns `planNorth`: the panorama's own angle that points at the top of the
 * floor plan. Everything else about that node's arrows follows from it.
 */
export function planNorthFromSighting({ observedYaw, pan = 0, bearing, mirrored = false }) {
  return norm360(rawAngle(observedYaw, pan) - signed(bearing, mirrored));
}

/**
 * Where a neighbour's arrow belongs, as a yaw the viewer can use.
 *
 * Depends on the node's current `pan` as well as its anchor, so nudging an
 * alignment afterwards moves the arrows with it rather than leaving them
 * behind.
 */
export function arrowYaw({ planNorth, pan = 0, bearing, mirrored = false }) {
  return norm360(planNorth + signed(bearing, mirrored) - pan);
}

/**
 * Decides a tour's handedness from two sightings at one node.
 *
 * The angle between two doorways is a fact about the building. If the panorama
 * disagrees with the plan about its sign, the frames are mirrored. Measured
 * from two real photographs rather than assumed from a file format.
 *
 * `residual` is how far the two disagree in size once the sign is settled — a
 * few degrees is sighting error, a large number means a map point is wrong or
 * one of the sightings was taken on the wrong doorway. It is reported rather
 * than swallowed.
 */
export function detectMirrored(first, second) {
  const observed = difference(rawAngle(first.observedYaw, first.pan ?? 0),
                              rawAngle(second.observedYaw, second.pan ?? 0));
  const planned = difference(first.bearing, second.bearing);

  const straight = Math.abs(difference(observed, planned));
  const flipped = Math.abs(difference(observed, -planned));

  return {
    mirrored: flipped < straight,
    residual: Math.round(Math.min(straight, flipped) * 10) / 10,
    // Two doorways that are nearly the same direction cannot separate the two
    // cases; the caller should ask for a wider pair rather than trust this.
    separation: Math.round(Math.abs(planned) * 10) / 10,
  };
}

/** Signed difference between two bearings, in (-180, 180]. */
export function difference(a, b) {
  return ((((a - b) % 360) + 540) % 360) - 180;
}

export function norm360(deg) {
  return ((deg % 360) + 360) % 360;
}

function signed(bearing, mirrored) {
  return mirrored ? -bearing : bearing;
}
