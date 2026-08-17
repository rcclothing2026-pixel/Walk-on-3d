/**
 * Phase 4 — the tour.
 *
 * Builds the Photo Sphere Viewer instance from src/data/nodes.json and wires
 * up the virtual tour, the mini-map, brand markers and the side panel.
 *
 * The pieces that carry the experience:
 *
 *   - Virtual tour in `3d` mode, so arrows are rendered into the scene rather
 *     than shown as a 2D gallery.
 *   - Neighbours of the current node are preloaded. This is the single biggest
 *     factor in whether moving feels instant, so it is not optional.
 *   - A thumbnail is shown blurred behind the loader; the sphere is never blank.
 *   - The URL tracks the current node via replaceState, and ?node=NN opens there.
 */

import { Viewer } from '@photo-sphere-viewer/core';
import { VirtualTourPlugin } from '@photo-sphere-viewer/virtual-tour-plugin';
import { MarkersPlugin } from '@photo-sphere-viewer/markers-plugin';
import { MapPlugin } from '@photo-sphere-viewer/map-plugin';

import '@photo-sphere-viewer/core/index.css';
import '@photo-sphere-viewer/virtual-tour-plugin/index.css';
import '@photo-sphere-viewer/markers-plugin/index.css';
import '@photo-sphere-viewer/map-plugin/index.css';

import './styles.css';

import { assetUrl, floorplanUrl, panoUrl } from './lib/paths.js';
import { QualityManager, loadManifest } from './lib/quality.js';
import { BrandPanel } from './lib/panel.js';
import { Gyroscope, registerControls } from './lib/controls.js';

/** Nodes 1–3 are the staircase descent; the map reads badly at the plan's edge. */
const MAP_HIDDEN_UNTIL_NODE = 4;

/**
 * Whether any node has been placed on the floor plan.
 *
 * The map plugin cannot draw at all without a centre point — its render() bails
 * out when the current node has no `map: { x, y }`. Rather than show an empty
 * circle, the map is suppressed entirely until the coordinates exist. Place
 * them with tools/map.html.
 */
let mapUsable = false;

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const el = {
  viewer: document.getElementById('viewer'),
  loader: document.getElementById('loader'),
  loaderBar: document.getElementById('loader-bar'),
  loaderThumb: document.getElementById('loader-thumb'),
  caption: document.getElementById('caption'),
  error: document.getElementById('error'),
};

boot().catch(showFatal);

async function boot() {
  const [tour, brands, manifest] = await Promise.all([
    fetchJson('tour data', new URL('./data/nodes.json', import.meta.url)),
    fetchJson('brands', new URL('./data/brands.json', import.meta.url)).catch(() => null),
    loadManifest(),
  ]);

  const startNode = resolveStartNode(tour);
  showPlaceholder(startNode);

  mapUsable = Object.values(tour.nodes).some(hasMapPoint);
  if (!mapUsable) {
    console.info(
      '[tour] No node has map coordinates yet, so the mini-map stays hidden. ' +
        'Place the nodes on the plan with tools/map.html.',
    );
  }

  // Buttons must exist before construction: the navbar is built from this
  // array while the viewer is being created.
  const controls = registerControls();

  const viewer = new Viewer({
    container: el.viewer,
    // The virtual tour plugin owns the panorama; giving one here would make
    // the first node load twice.
    adapter: undefined,
    caption: '',
    navbar: buildNavbar(controls),
    defaultZoomLvl: 40,
    minFov: 25,
    maxFov: 100,
    moveSpeed: 1.1,
    touchmoveTwoFingers: false,
    mousewheelCtrlKey: false,
    loadingTxt: 'در حال بارگذاری…',
    keyboard: 'always',
    plugins: buildPlugins(),
  });

  const tourPlugin = viewer.getPlugin(VirtualTourPlugin);
  const markersPlugin = viewer.getPlugin(MarkersPlugin);
  const mapPlugin = viewer.getPlugin(MapPlugin);
  const panel = new BrandPanel();
  const quality = new QualityManager({ viewer, manifest });

  // Off by default: following the phone unannounced disorients people.
  const gyroscope = new Gyroscope(viewer, {
    onChange: (on) => document.body.classList.toggle('gyro-on', on),
  });

  wireLoader(viewer);
  wireQuality(viewer, quality);

  tourPlugin.setNodes(buildNodes(tour, brands), String(startNode).padStart(2, '0'));

  tourPlugin.addEventListener('node-changed', ({ node }) => {
    const number = Number(node.id);

    quality.setNode(number);
    panel.close();
    setCaption(tour.nodes[node.id]);
    syncMapVisibility(mapPlugin, number);
    syncUrl(number);
  });

  markersPlugin.addEventListener('select-marker', ({ marker }) => {
    const brand = marker.data?.brand;
    if (brand) panel.open(brand);
  });

  // Expose for debugging from the console; harmless in production and
  // invaluable when something looks wrong on a real device.
  window.__tour = { viewer, tourPlugin, mapPlugin, quality, gyroscope, data: tour };
}

/**
 * The plugin set.
 *
 * The map plugin is left out entirely when no node has been placed on the
 * floor plan, rather than loaded and hidden. Hiding does not hold: the plugin
 * calls show() on itself once its image finishes loading, which lands after
 * our own hide() and puts an undrawable map back on screen. Skipping it also
 * saves fetching the floor plan for nothing.
 */
function buildPlugins() {
  const tourConfig = {
    positionMode: 'manual',
    renderMode: '3d',
    transitionOptions: reducedMotion
      ? { showLoader: true, speed: 0, fadeIn: false, rotation: false }
      : { showLoader: true, speed: '12rpm', fadeIn: true, rotation: true },
    preload: true,
    // Valid keys are image / element / className / size / style — the
    // colour-ish names other PSV plugins use are silently ignored here.
    arrowStyle: {
      size: { width: 88, height: 88 },
      className: 'tour-arrow',
    },
  };

  // No `markers` config: the virtual tour plugin owns markers per node and
  // warns (then discards) if the markers plugin carries defaults.
  const plugins = [MarkersPlugin];

  if (mapUsable) {
    // The map belongs to the virtual tour plugin, not the map plugin: it is
    // what sets the image and maintains a hotspot per node. The map plugin
    // only gets presentation options.
    tourConfig.map = { imageUrl: floorplanUrl(), recenter: true };
    plugins.push([MapPlugin, mapConfig()]);
  }

  plugins.push([VirtualTourPlugin, tourConfig]);
  return plugins;
}

/**
 * The navbar, which differs by input type.
 *
 * Only built-in names are valid as strings; reset and gyroscope are custom
 * button objects. `caption` is left out deliberately — the node name is already
 * in our own pill and the navbar version would duplicate it.
 *
 * On touch the four `move` arrows are dropped: you drag to look, so they earn
 * nothing, and at 375px eleven buttons overflow into a collapsed menu that
 * buries the controls that do matter.
 *
 * The gyroscope button is gated on a coarse pointer rather than on
 * DeviceOrientationEvent alone — desktop Chrome defines that API but has no
 * sensor behind it, which would leave a dead button on the bar.
 */
function buildNavbar(controls) {
  const touch = matchMedia('(pointer: coarse)').matches;

  return [
    'zoom',
    ...(touch ? [] : ['move']),
    controls.reset,
    ...(touch && Gyroscope.supported ? [controls.gyroscope] : []),
    'fullscreen',
  ];
}

/* ------------------------------------------------------------------ *
 * Nodes
 * ------------------------------------------------------------------ */

/**
 * Converts our nodes.json into the shape the virtual tour plugin wants.
 *
 * Ours is deliberately not the plugin's format: it is the one the tools write
 * and a human reads. This is the only place the two meet.
 */
function buildNodes(tour, brands) {
  return Object.values(tour.nodes).map((node) => ({
    id: node.id,
    panorama: panoUrl(Number(node.id), 'mid'),
    thumbnail: panoUrl(Number(node.id), 'thumb'),
    name: node.name,
    caption: node.name,
    sphereCorrection: { pan: `${node.pan ?? 0}deg` },
    links: node.links.map((link) => ({
      nodeId: link.node,
      position: { yaw: `${link.yaw}deg`, pitch: `${link.pitch}deg` },
    })),
    // Omitted entirely until the node has been placed on the plan — passing a
    // half-filled point would put every dot at the map's origin.
    ...(hasMapPoint(node) ? { map: { x: node.map.x, y: node.map.y } } : {}),
    markers: brandMarkers(node.id, brands),
  }));
}

function hasMapPoint(node) {
  return Number.isFinite(node.map?.x) && Number.isFinite(node.map?.y);
}

/**
 * Brand pins for a node.
 *
 * brands.json may be absent or empty — the marker layer simply contributes
 * nothing in that case rather than breaking the tour.
 */
function brandMarkers(nodeId, brands) {
  const entries = brands?.brands?.[nodeId];
  if (!entries) return [];

  return (Array.isArray(entries) ? entries : [entries])
    .filter((brand) => brand?.name)
    .map((brand, index) => ({
      id: `brand-${nodeId}-${index}`,
      position: {
        yaw: `${brand.position?.yaw ?? 0}deg`,
        pitch: `${brand.position?.pitch ?? 0}deg`,
      },
      html: brandPinHtml(brand),
      size: { width: 44, height: 44 },
      anchor: 'center center',
      tooltip: brand.name,
      data: {
        brand: {
          name: brand.name,
          description: brand.description,
          url: brand.url,
          logoUrl: brand.logo ? assetUrl(brand.logo) : null,
        },
      },
    }));
}

function brandPinHtml(brand) {
  return `
    <div class="brand-pin" title="${escapeHtml(brand.name)}">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 22s7-6.1 7-11.2A7 7 0 0 0 5 10.8C5 15.9 12 22 12 22z" />
        <circle class="brand-pin__dot" cx="12" cy="10.6" r="2.6" />
      </svg>
    </div>`;
}

/* ------------------------------------------------------------------ *
 * Map
 * ------------------------------------------------------------------ */

/**
 * Presentation only. `imageUrl` is deliberately absent — the virtual tour
 * plugin supplies it, and setting it in both places makes the map load twice.
 *
 * Node dots come from the `map: { x, y }` on each node in nodes.json. Until
 * those have been measured on the plan the map still renders and pans, it
 * simply has no dots.
 */
function mapConfig() {
  return {
    position: ['bottom', 'left'],
    size: '190px',
    maxZoom: 200,
    minZoom: 40,
    defaultZoom: 90,
    // Deliberately true. `visibleOnLoad: false` does not merely hide the map,
    // it collapses it to a 34px button that show() cannot undo — collapsing is
    // a separate state with its own open()/close() API. Start-node visibility
    // is handled by syncMapVisibility instead.
    visibleOnLoad: true,
    spotStyle: { size: 14, color: 'rgba(255,255,255,.85)', hoverColor: '#ffd54a' },
  };
}

/**
 * The staircase descent sits at the very edge of the plan, where a dot reads
 * as noise rather than orientation. The map fades in once the visitor is
 * actually inside the building.
 */
function syncMapVisibility(mapPlugin, node) {
  if (!mapPlugin) return;

  if (!mapUsable || node < MAP_HIDDEN_UNTIL_NODE) {
    mapPlugin.hide();
    return;
  }

  // show() alone is not enough: a map left collapsed comes back as a small
  // button rather than the mini-map. open() clears that state.
  mapPlugin.show();
  mapPlugin.open();
}

/* ------------------------------------------------------------------ *
 * Loading state
 * ------------------------------------------------------------------ */

/** The sphere is never blank: a blurred thumbnail sits behind the progress bar. */
function showPlaceholder(node) {
  el.loaderThumb.style.backgroundImage = `url("${panoUrl(node, 'thumb')}")`;
  el.loader.hidden = false;
}

function wireLoader(viewer) {
  viewer.addEventListener('load-progress', ({ progress }) => {
    el.loaderBar.style.width = `${Math.round(progress)}%`;
  });

  viewer.addEventListener('ready', hideLoader, { once: true });
  viewer.addEventListener('panorama-loaded', hideLoader);
  viewer.addEventListener('panorama-error', ({ error }) => {
    hideLoader();
    showFatal(error, 'پانوراما بارگذاری نشد.');
  });
}

function hideLoader() {
  el.loader.hidden = true;
  el.loaderBar.style.width = '0%';
}

function wireQuality(viewer, quality) {
  viewer.addEventListener('zoom-updated', ({ zoomLevel }) => {
    quality.considerUpgrade(zoomLevel);
  });
}

/* ------------------------------------------------------------------ *
 * Chrome
 * ------------------------------------------------------------------ */

function setCaption(node) {
  if (!node) return;
  el.caption.textContent = node.name ?? '';
  el.caption.dataset.type = node.type ?? '';
}

/** ?node=NN opens directly at that node; anything invalid falls back to the start. */
function resolveStartNode(tour) {
  const requested = new URLSearchParams(location.search).get('node');
  const id = String(Number(requested)).padStart(2, '0');
  return tour.nodes[id] ? Number(id) : Number(tour.start ?? 1);
}

/** Keeps the URL shareable without adding a history entry per step. */
function syncUrl(node) {
  const url = new URL(location.href);
  url.searchParams.set('node', String(node));
  history.replaceState(null, '', url);
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

async function fetchJson(label, url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`could not load ${label} (${response.status})`);
  return response.json();
}

function showFatal(err, message = 'بارگذاری تور ممکن نشد.') {
  console.error('[tour]', err);
  el.loader.hidden = true;
  el.error.hidden = false;
  el.error.querySelector('[data-message]').textContent = message;
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );
}
