/**
 * Runtime configuration.
 *
 * IMAGE_BASE_URL is the ONE place that decides where panorama images, the floor
 * plan and brand logos are fetched from. Nothing else in the codebase may build
 * an image path by hand — everything goes through src/lib/paths.js, which reads
 * this constant.
 *
 * To move the images to Arvan Cloud object storage, change this value (or set
 * VITE_IMAGE_BASE_URL at build time) and rebuild. No other file changes.
 *
 * Must end with a trailing slash.
 *
 *   same-origin (default, Laravel public/tour/):  '/tour/'
 *   Arvan Cloud bucket:                           'https://<bucket>.s3.ir-thr-at1.arvanstorage.ir/tour/'
 */

const fromEnv =
  typeof import.meta !== 'undefined' && import.meta.env
    ? import.meta.env.VITE_IMAGE_BASE_URL
    : undefined;

export const IMAGE_BASE_URL = withTrailingSlash(fromEnv || '/tour/');

function withTrailingSlash(url) {
  return url.endsWith('/') ? url : `${url}/`;
}
