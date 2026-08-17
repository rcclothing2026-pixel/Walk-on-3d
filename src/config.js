/**
 * Where this page's tour data and images come from.
 *
 * A built tour is self-contained: index.html, its data, its floor plan and its
 * panoramas all sit together, so the whole directory can be handed to a tenant
 * and dropped anywhere. Everything is therefore resolved *relative to the page*
 * rather than to a site root.
 *
 *   <bundle>/index.html
 *   <bundle>/data/nodes.json
 *   <bundle>/floorplan.png
 *   <bundle>/panos/04-mid.jpg
 *
 * In development there is no bundle — one dev server hosts every tour at once —
 * so the same layout is synthesised under /tour/t/<slug>/ by a middleware in
 * vite.config.js. Both modes see identical relative paths, which is the point:
 * a path that works locally works deployed.
 *
 * Panoramas can be moved off to object storage independently of everything
 * else, since they are the only part measured in hundreds of megabytes. Set
 * VITE_PANO_BASE_URL at build time to an absolute URL and nothing else changes.
 */

const env = typeof import.meta !== 'undefined' ? import.meta.env : undefined;

/**
 * Which tour this page shows.
 *
 * In development one server hosts every tour, so it comes from ?tour=. In a
 * built bundle there is only ever one tour in the directory, so the value is
 * cosmetic — the data sits beside index.html either way.
 */
export const TOUR_SLUG = typeof location !== 'undefined' ? slugFromQuery() : '';

/**
 * The root everything else hangs off.
 *
 * Production: './' — the directory index.html is in.
 * Development: the per-tour path the dev middleware serves.
 */
export const BASE_URL = env?.PROD ? './' : `/tour/t/${TOUR_SLUG}/`;

/** Tour data — nodes, names, brands. */
export const DATA_BASE_URL = `${BASE_URL}data/`;

/** Panoramas. Overridable so they can live on object storage. */
export const PANO_BASE_URL = withTrailingSlash(env?.VITE_PANO_BASE_URL || `${BASE_URL}panos/`);

/** The floor plan the mini-map draws. */
export const FLOORPLAN_URL = `${BASE_URL}floorplan.png`;

function slugFromQuery() {
  return new URLSearchParams(location.search).get('tour') ?? '';
}

function withTrailingSlash(url) {
  return url.endsWith('/') ? url : `${url}/`;
}
