/**
 * Decides which panorama rendition to show, and when to upgrade.
 *
 * The strategy from the brief:
 *
 *   thumb  shown instantly as a blurred placeholder, never as the real thing
 *   mid    the default panorama — what a visitor actually looks at
 *   full   fetched only once the user zooms past a threshold
 *
 * On a connection slower than ~2 Mbps the tour stays on `mid` permanently:
 * an 8192px fetch on a slow link costs more than the sharpness is worth.
 *
 * `full` is currently not built at all (see RENDITION_ORDER in paths.js), so
 * the upgrade path is dormant. The logic is kept because re-enabling the
 * rendition is a one-line change and this is where the policy belongs.
 *
 * This lives in one module rather than as conditionals sprinkled through the
 * viewer so the policy can be read, and changed, in one place.
 */

import { RENDITIONS, RENDITION_ORDER, panoUrl } from './paths.js';
import { PANO_BASE_URL } from '../config.js';

/** Below this downlink estimate (Mbps) we never fetch `full`. */
export const SLOW_CONNECTION_MBPS = 2;

/**
 * True when this connection should not be handed extra work.
 *
 * navigator.connection is Chromium-only. Where it is missing we assume a
 * decent connection rather than crippling the tour on Safari and Firefox —
 * every caller here already gates on something else as well.
 */
export function isSlowConnection() {
  const connection = navigator.connection;
  if (!connection) return false;

  if (connection.saveData) return true;
  if (['slow-2g', '2g'].includes(connection.effectiveType)) return true;

  return Number.isFinite(connection.downlink) && connection.downlink < SLOW_CONNECTION_MBPS;
}

/**
 * Zoom level (0–100, as Photo Sphere Viewer reports it) past which `full` is
 * worth fetching. Below this, `mid` already exceeds screen resolution.
 */
export const FULL_ZOOM_THRESHOLD = 55;

/** Ignore zoom changes for this long after one upgrade, to avoid thrashing. */
const UPGRADE_COOLDOWN_MS = 1200;

export class QualityManager {
  #viewer;
  #manifest;
  #onChange;
  #upgraded = new Set();
  #lastUpgrade = 0;
  #node = null;
  #busy = false;

  /**
   * @param {object}   options
   * @param {object}   options.viewer    Photo Sphere Viewer instance
   * @param {object?}  options.manifest  panos/manifest.json, for byte sizes
   * @param {Function?} options.onChange called with ('mid'|'full', node)
   */
  constructor({ viewer, manifest = null, onChange = null }) {
    this.#viewer = viewer;
    this.#manifest = manifest;
    this.#onChange = onChange;
  }

  /**
   * The rendition a node should load at.
   *
   * Always `mid`. `full` is an upgrade applied after the fact, never the first
   * fetch — waiting on 8192px before showing anything would blow the 3s
   * first-paint budget.
   */
  initialRendition() {
    return 'mid';
  }

  /** The instant placeholder shown while the real panorama downloads. */
  placeholderUrl(node) {
    return panoUrl(node, 'thumb');
  }

  /** Called on every node change; resets the per-node upgrade state. */
  setNode(node) {
    this.#node = node;
  }

  /**
   * True when this connection should never fetch `full`.
   *
   * Kept as a method so policy reads as part of the class; the check itself
   * is the exported function, so the viewer can ask before any viewer exists.
   */
  isSlowConnection() {
    return isSlowConnection();
  }

  /** Whether `node` is already showing its full-resolution panorama. */
  isUpgraded(node) {
    return this.#upgraded.has(String(node));
  }

  /**
   * Considers upgrading the current node to `full`.
   *
   * Call on zoom changes. No-ops unless the user has zoomed past the
   * threshold, the connection can take it, and we are not already busy or
   * cooling down from the last upgrade.
   */
  async considerUpgrade(zoomLevel) {
    // `full` is not currently emitted (see RENDITION_ORDER); with nothing to
    // upgrade to, this is a no-op rather than a broken fetch.
    if (!RENDITION_ORDER.includes('full')) return false;
    if (this.#node === null || this.#busy) return false;
    if (this.isUpgraded(this.#node)) return false;
    if (zoomLevel < FULL_ZOOM_THRESHOLD) return false;
    if (this.isSlowConnection()) return false;
    if (Date.now() - this.#lastUpgrade < UPGRADE_COOLDOWN_MS) return false;

    return this.#upgrade(this.#node);
  }

  async #upgrade(node) {
    this.#busy = true;
    const position = this.#viewer.getPosition();
    const zoom = this.#viewer.getZoomLevel();

    try {
      // Keep the camera exactly where it is: an upgrade the user notices as a
      // jump is worse than the softness it fixes.
      await this.#viewer.setPanorama(panoUrl(node, 'full'), {
        transition: false,
        showLoader: false,
        position,
        zoom,
      });

      this.#upgraded.add(String(node));
      this.#lastUpgrade = Date.now();
      this.#onChange?.('full', node);
      return true;
    } catch (err) {
      // A failed upgrade is cosmetic — `mid` is still on screen. Do not retry
      // in a loop; mark it done so the tour stops trying.
      this.#upgraded.add(String(node));
      console.warn(`[quality] full-resolution upgrade failed for node ${node}`, err);
      return false;
    } finally {
      this.#busy = false;
    }
  }

  /** Bytes a node costs at a given rendition, when the manifest knows. */
  bytesFor(node, rendition) {
    const key = String(node).padStart(2, '0');
    return this.#manifest?.panos?.[key]?.bytes?.[rendition] ?? null;
  }

  /** A human-readable summary, for the debug overlay. */
  describe() {
    const slow = this.isSlowConnection();
    return {
      slow,
      effectiveType: navigator.connection?.effectiveType ?? 'unknown',
      downlink: navigator.connection?.downlink ?? null,
      upgraded: [...this.#upgraded],
      policy: !RENDITION_ORDER.includes('full')
        ? 'mid only (full-resolution rendition not built)'
        : slow
          ? 'mid only (slow connection)'
          : `full above ${FULL_ZOOM_THRESHOLD}% zoom`,
      renditions: RENDITIONS,
    };
  }
}

/** Loads panos/manifest.json if the pipeline has produced one. */
export async function loadManifest() {
  try {
    const response = await fetch(`${PANO_BASE_URL}manifest.json`);
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}
