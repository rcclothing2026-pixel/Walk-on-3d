/**
 * The naming convention for generated panorama files, shared by the build-time
 * image pipeline and the runtime viewer.
 *
 * Keeping both sides on this module is what stops the pipeline and the viewer
 * from silently drifting apart on a filename.
 *
 * Plain ESM with no browser or Node APIs, so it imports cleanly into both.
 */

import { DATA_BASE_URL, FLOORPLAN_URL, PANO_BASE_URL } from '../config.js';

/**
 * The catalogue of renditions.
 *
 * Every panorama is equirectangular, so width is always exactly 2 × height.
 * `quality` is the JPEG quality passed to sharp.
 */
export const RENDITIONS = {
  thumb: { width: 1024, height: 512, quality: 70 },
  mid: { width: 4096, height: 2048, quality: 80 },
  full: { width: 8192, height: 4096, quality: 82 },
};

/**
 * Which renditions the pipeline emits and the viewer may request, smallest
 * first.
 *
 * `full` is deliberately excluded. 4096×2048 already exceeds the resolution of
 * the screens this runs on, and the 8192px copy roughly triples both the disk
 * footprint and the upload for a difference only visible under heavy zoom.
 * Re-enabling it is adding 'full' back to this array — the pipeline, the
 * manifest, the quality manager and the build report all read from here.
 */
export const RENDITION_ORDER = ['thumb', 'mid'];

/** Node ids are always two digits: 1 → '01', 43 → '43'. */
export function nodeId(node) {
  return String(node).padStart(2, '0');
}

/** e.g. panoFilename(17, 'mid') → '17-mid.jpg' */
export function panoFilename(node, rendition) {
  assertRendition(rendition);
  return `${nodeId(node)}-${rendition}.jpg`;
}

/** The URL the viewer fetches a panorama from. */
export function panoUrl(node, rendition) {
  return `${PANO_BASE_URL}${panoFilename(node, rendition)}`;
}

/** e.g. dataUrl('nodes') → '<base>data/nodes.json' */
export function dataUrl(name) {
  return `${DATA_BASE_URL}${name}.json`;
}

/** The floor plan the mini-map draws. */
export function floorplanUrl() {
  return FLOORPLAN_URL;
}

/** A tour-owned asset such as a brand logo, resolved against the tour's data. */
export function assetUrl(relativePath) {
  return `${DATA_BASE_URL}${String(relativePath).replace(/^\/+/, '')}`;
}

function assertRendition(rendition) {
  if (!(rendition in RENDITIONS)) {
    throw new Error(
      `Unknown rendition "${rendition}". Expected one of: ${RENDITION_ORDER.join(', ')}`,
    );
  }
}
