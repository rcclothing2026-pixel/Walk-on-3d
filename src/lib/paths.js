/**
 * The naming convention for generated panorama files, shared by the build-time
 * image pipeline (scripts/process.js) and the runtime viewer.
 *
 * Keeping both sides on this module is what stops the pipeline and the viewer
 * from silently drifting apart on a filename.
 *
 * This file is plain ESM with no browser or Node APIs, so it imports cleanly
 * into both.
 */

import { IMAGE_BASE_URL } from '../config.js';

/**
 * The three renditions emitted per node, smallest first.
 *
 * Every panorama is equirectangular, so width is always exactly 2 × height.
 * `quality` is the JPEG quality passed to sharp.
 */
export const RENDITIONS = {
  thumb: { width: 1024, height: 512, quality: 70 },
  mid: { width: 4096, height: 2048, quality: 80 },
  full: { width: 8192, height: 4096, quality: 82 },
};

/** Rendition keys ordered smallest → largest. */
export const RENDITION_ORDER = ['thumb', 'mid', 'full'];

/** Directory (relative to IMAGE_BASE_URL) holding the panorama renditions. */
export const PANO_DIR = 'panos';

/**
 * The mini-map's floor plan, generated from the architect's PDF by
 * `npm run floorplan`. Swapping in a revised plan is a change to this name
 * (or just a re-run of that script), nothing else.
 */
export const FLOORPLAN_FILE = 'floorplan.png';

/** Node ids are always two digits: 1 → '01', 43 → '43'. */
export function nodeId(node) {
  return String(node).padStart(2, '0');
}

/** e.g. panoFilename(17, 'mid') → '17-mid.jpg' */
export function panoFilename(node, rendition) {
  assertRendition(rendition);
  return `${nodeId(node)}-${rendition}.jpg`;
}

/** e.g. panoUrl(17, 'mid') → '/tour/panos/17-mid.jpg' */
export function panoUrl(node, rendition) {
  return `${IMAGE_BASE_URL}${PANO_DIR}/${panoFilename(node, rendition)}`;
}

/** e.g. assetUrl('floorplan.png') → '/tour/floorplan.png' */
export function assetUrl(relativePath) {
  return `${IMAGE_BASE_URL}${relativePath.replace(/^\/+/, '')}`;
}

/** The floor plan the mini-map draws, e.g. '/tour/floorplan.png' */
export function floorplanUrl() {
  return assetUrl(FLOORPLAN_FILE);
}

function assertRendition(rendition) {
  if (!(rendition in RENDITIONS)) {
    throw new Error(
      `Unknown rendition "${rendition}". Expected one of: ${RENDITION_ORDER.join(', ')}`,
    );
  }
}
