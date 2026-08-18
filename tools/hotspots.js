/**
 * Phase 3 — hotspot picker.
 *
 * Places the floor arrow for every link in the tour. Loads a node with its
 * alignment already applied, so the yaw a click reports is the same yaw the
 * viewer will use — which is why alignment has to be finished first.
 *
 * Workflow per node:
 *   1. Pick a target from the list (Tab cycles).
 *   2. Click the floor where that arrow belongs. The marker moves there live.
 *   3. Move to the next target; PgDn moves to the next node.
 *
 * Targets are not free-form: the list is exactly this node's neighbours in the
 * link graph, so an arrow cannot be pointed at somewhere the graph does not
 * connect to.
 *
 * Floor arrows belong between -15° and -30° pitch; anything outside that is
 * flagged on the row rather than silently accepted.
 *
 * No localStorage by project rule — "Download all" writes the merged
 * nodes.json, which is written back to the tour's own folder.
 */

import { Viewer } from '@photo-sphere-viewer/core';
import { MarkersPlugin } from '@photo-sphere-viewer/markers-plugin';
import '@photo-sphere-viewer/core/index.css';
import '@photo-sphere-viewer/markers-plugin/index.css';

import { panoUrl, dataUrl } from '../src/lib/paths.js';
import { loadTourData } from '../src/lib/tour-data.js';
import { downloadJson, saveData } from './save.js';
import { mountNav } from './nav.js';
import { announceNode, connectFrame } from './frame.js';

let NODES = [];
let tourData = null;
const RENDITION = 'mid';

/** The brief's acceptable band for a floor arrow. */
const PITCH_MIN = -30;
const PITCH_MAX = -15;

const el = {
  viewer: document.getElementById('viewer'),
  node: document.getElementById('node'),
  prev: document.getElementById('prev'),
  next: document.getElementById('next'),
  name: document.getElementById('node-name'),
  type: document.getElementById('node-type'),
  pan: document.getElementById('node-pan'),
  alignWarn: document.getElementById('align-warn'),
  progress: document.getElementById('progress'),
  linkCount: document.getElementById('link-count'),
  links: document.getElementById('links'),
  copy: document.getElementById('copy'),
  download: document.getElementById('download'),
  pitch: document.getElementById('pitch'),
  pitchValue: document.getElementById('pitch-value'),
  yawValue: document.getElementById('yaw-value'),
  resetLink: document.getElementById('reset-link'),
  resetNode: document.getElementById('reset-node'),
  status: document.getElementById('status'),
};

/** The whole nodes.json, mutated in place as arrows are picked. */
let tour = null;
let current = null;
let activeIndex = 0;
let viewer = null;
let markers = null;
let placementEnabled = true;

start();

async function start() {
  mountNav({ tool: 'hotspots', node: () => current });
  tourData = await loadTourData();
  NODES = tourData.numbers();

  tour = await loadTour();
  if (!tour) return;

  current = initialNode();
  buildNodeOptions();
  wireControls();
  wireKeyboard();
  wireUnloadGuard();
  await openNode(current);

  // Last: a pane must know its roster before the split view can move it.
  connectFrame({ current: () => current, goto: openNode });
}

async function loadTour() {
  try {
    const response = await fetch(dataUrl('nodes'));
    if (!response.ok) throw new Error(String(response.status));
    return await response.json();
  } catch {
    showStatus(
      '<strong>No node graph yet.</strong><br /><br />' +
        'Arrows are derived from the links between nodes, and this tour has ' +
        'none yet. Draw them in the map tool (&#9776; &rarr; Map), press ' +
        '<strong>Rebuild</strong> there, then come back.',
      'error',
    );
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Viewer
 * ------------------------------------------------------------------ */

async function openNode(node) {
  current = node;
  activeIndex = 0;

  syncNodeChrome();
  renderLinks();

  const url = panoUrl(node, RENDITION);
  const pan = `${nodeData().pan ?? 0}deg`;

  try {
    if (!viewer) {
      viewer = new Viewer({
        container: el.viewer,
        panorama: url,
        sphereCorrection: { pan },
        defaultYaw: 0,
        navbar: false,
        plugins: [[MarkersPlugin, { markers: [] }]],
      });
      markers = viewer.getPlugin(MarkersPlugin);
      viewer.addEventListener('click', onPanoramaClick);
      viewer.addEventListener('panorama-error', (event) =>
        showMissingPanorama(current, event.error),
      );
      // Markers added before the viewer has finished loading are dropped, so
      // they are drawn on every panorama-loaded rather than only after the
      // constructor returns.
      viewer.addEventListener('panorama-loaded', () => {
        hideStatus();
        setPlacementEnabled(true);
        syncMarkers();
      });
      window.__viewer = viewer; // dev handle
    } else {
      await viewer.setPanorama(url, {
        sphereCorrection: { pan },
        position: { yaw: 0, pitch: 0 },
        showLoader: true,
      });
    }
    hideStatus();
    setPlacementEnabled(true);
  } catch (err) {
    showMissingPanorama(node, err);
  }

  syncMarkers();
}

/**
 * Blocks arrow placement while the current node has no panorama.
 *
 * PSV keeps the previous sphere on screen when a load fails, so without this
 * you would be clicking arrow positions onto the wrong node's image.
 */
function setPlacementEnabled(enabled) {
  placementEnabled = enabled;
  for (const control of [el.pitch, el.pitchValue, el.yawValue, el.resetLink, el.resetNode]) {
    control.disabled = !enabled;
  }
  document.body.classList.toggle('is-blocked', !enabled);
}

function showMissingPanorama(node, err) {
  setPlacementEnabled(false);
  showStatus(
    `<strong>Node ${pad(node)} has no panorama yet.</strong><br />` +
      `Expected <code>${panoUrl(node, RENDITION)}</code><br /><br />` +
      'Assign it a photo in the studio, then press ' +
      '<strong>Rebuild this photo</strong> in the &#9776; menu.',
    'error',
  );
  console.warn(`[hotspots] could not load node ${pad(node)}`, err);
}

/** A click on the panorama places the active link's arrow. */
function onPanoramaClick({ data }) {
  const link = activeLink();
  if (!link || data.rightclick || !placementEnabled) return;

  link.yaw = round(norm360(rad2deg(data.yaw)));
  link.pitch = round(rad2deg(data.pitch));
  claim(link);

  renderLinks();
  syncMarkers();
  syncPositionInputs();
  advance();
}

/* ------------------------------------------------------------------ *
 * Markers
 * ------------------------------------------------------------------ */

/**
 * Draws every link on this node, so the whole arrangement is visible at once
 * rather than one arrow at a time. The active one is highlighted, and anything
 * outside the acceptable pitch band is drawn in the warning colour.
 */
function syncMarkers() {
  if (!markers) return;

  markers.clearMarkers();

  nodeData().links.forEach((link, index) => {
    const active = index === activeIndex;
    const bad = !pitchOk(link.pitch);
    const target = tourData.info(Number(link.node));

    markers.addMarker({
      id: `link-${link.node}`,
      position: { yaw: `${link.yaw}deg`, pitch: `${link.pitch}deg` },
      html: arrowHtml(link, target, { active, bad }),
      size: { width: 64, height: 64 },
      anchor: 'center center',
      tooltip: `${link.node} — ${target.name}<br>${link.yaw}° / ${link.pitch}°`,
    });
  });
}

function arrowHtml(link, target, { active, bad }) {
  const colour = bad ? 'var(--warn)' : active ? 'var(--accent)' : 'rgba(255,255,255,.75)';
  const scale = active ? 1 : 0.78;

  return `
    <div class="hs-marker" style="--c:${colour}; --s:${scale}">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 2 L20 20 L12 15.5 L4 20 Z" />
      </svg>
      <span>${link.node}${isPicked(link) ? '' : ' ?'}</span>
    </div>`;
}

/* ------------------------------------------------------------------ *
 * Link list
 * ------------------------------------------------------------------ */

function renderLinks() {
  const links = nodeData().links;

  el.links.innerHTML = links
    .map((link, index) => {
      const target = tourData.info(Number(link.node));
      const bad = !pitchOk(link.pitch);

      return `
        <li class="link ${index === activeIndex ? 'is-active' : ''}" data-index="${index}">
          <span class="link__id">${link.node}</span>
          <span class="link__name" dir="rtl">${escapeHtml(target.name)}</span>
          <span class="link__angles ${bad ? 'is-bad' : ''}">
            ${link.yaw}° / ${link.pitch}°
          </span>
          ${link.auto ? '<span class="tag">auto</span>' : ''}
          ${link.derived ? '<span class="tag">plan</span>' : ''}
          ${bad && isPicked(link) ? '<span class="tag tag--warn">pitch</span>' : ''}
        </li>`;
    })
    .join('');

  for (const row of el.links.children) {
    row.addEventListener('click', () => {
      activeIndex = Number(row.dataset.index);
      renderLinks();
      syncMarkers();
      syncPositionInputs();
    });
  }

  const picked = links.filter(isPicked).length;
  el.linkCount.textContent = `${picked}/${links.length}`;
  syncProgress();
  syncPositionInputs();
}

function syncProgress() {
  const all = Object.values(tour.nodes).flatMap((n) => n.links);
  const picked = all.filter(isPicked).length;
  el.progress.textContent = `${picked}/${all.length} arrows placed`;
  el.progress.dataset.complete = String(picked === all.length);
}

function syncNodeChrome() {
  const { name, type } = tourData.info(current);

  // Keeps the other pane of the split view on the same node. Inert otherwise.
  announceNode(current);
  const pan = nodeData().pan ?? 0;

  el.node.value = String(current);
  el.name.textContent = name;
  el.type.textContent = type;
  el.pan.textContent = `pan ${pan}°`;
  el.alignWarn.hidden = pan !== 0;

  el.prev.disabled = NODES.indexOf(current) === 0;
  el.next.disabled = NODES.indexOf(current) === NODES.length - 1;
}

function syncPositionInputs() {
  const link = activeLink();
  if (!link) return;
  el.pitch.value = String(link.pitch);
  el.pitchValue.value = String(link.pitch);
  el.yawValue.value = String(link.yaw);
}

/* ------------------------------------------------------------------ *
 * Controls
 * ------------------------------------------------------------------ */

function wireControls() {
  el.node.addEventListener('change', () => openNode(Number(el.node.value)));
  el.prev.addEventListener('click', () => step(-1));
  el.next.addEventListener('click', () => step(1));

  el.pitch.addEventListener('input', () => setAngle('pitch', Number(el.pitch.value)));
  el.pitchValue.addEventListener('change', () => setAngle('pitch', Number(el.pitchValue.value)));
  el.yawValue.addEventListener('change', () => setAngle('yaw', Number(el.yawValue.value)));

  el.resetLink.addEventListener('click', resetActiveLink);
  el.resetNode.addEventListener('click', resetNode);

  el.copy.addEventListener('click', copyNodeJson);
  el.download.addEventListener('click', downloadTour);
}

function wireKeyboard() {
  window.addEventListener('keydown', (event) => {
    if (event.target.matches('input, select')) return;

    switch (event.key) {
      case 'Tab':
        event.preventDefault();
        advance(event.shiftKey ? -1 : 1);
        break;
      case 'PageUp':
        event.preventDefault();
        step(-1);
        break;
      case 'PageDown':
        event.preventDefault();
        step(1);
        break;
      case 'r':
      case 'R':
        event.preventDefault();
        resetActiveLink();
        break;
      default:
    }
  });
}

function wireUnloadGuard() {
  window.addEventListener('beforeunload', (event) => {
    const picked = Object.values(tour.nodes).flatMap((n) => n.links).filter(isPicked);
    if (!picked.length) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

function setAngle(which, value) {
  const link = activeLink();
  if (!link || !Number.isFinite(value)) return;

  link[which] = which === 'yaw' ? round(norm360(value)) : round(value);
  claim(link);

  renderLinks();
  syncMarkers();
}

/**
 * Whether a human has actually aimed this arrow.
 *
 * An arrow spread evenly round the horizon and one worked out from the floor
 * plan are both guesses — good and bad ones — and neither has been looked at.
 * Counting the second as placed would report a finished tour that nobody has
 * checked.
 */
function isPicked(link) {
  return !link.auto && !link.derived;
}

/**
 * Marks an arrow as aimed by hand.
 *
 * Clearing `derived` is the important half: the build recomputes anything still
 * carrying that flag from the floor plan, so without this the next rebuild
 * would quietly undo the correction that was just made.
 */
function claim(link) {
  delete link.auto;
  delete link.derived;
}

function advance(delta = 1) {
  const count = nodeData().links.length;
  if (!count) return;
  activeIndex = (activeIndex + delta + count) % count;
  renderLinks();
  syncMarkers();
}

function step(delta) {
  const index = NODES.indexOf(current) + delta;
  if (index < 0 || index >= NODES.length) return;
  openNode(NODES[index]);
}

function resetActiveLink() {
  const link = activeLink();
  const links = nodeData().links;
  if (!link) return;

  link.yaw = round((360 / links.length) * activeIndex);
  link.pitch = tour.autoPitch ?? -20;
  link.auto = true;
  delete link.derived;

  renderLinks();
  syncMarkers();
}

function resetNode() {
  const links = nodeData().links;
  links.forEach((link, index) => {
    link.yaw = round((360 / links.length) * index);
    link.pitch = tour.autoPitch ?? -20;
    link.auto = true;
    delete link.derived;
  });
  renderLinks();
  syncMarkers();
}

/* ------------------------------------------------------------------ *
 * Output
 * ------------------------------------------------------------------ */

async function copyNodeJson() {
  const json = `${JSON.stringify(nodeData().links, null, 2)}\n`;
  try {
    await navigator.clipboard.writeText(json);
    toast(`Copied node ${pad(current)}'s links`);
  } catch {
    console.log(json);
    toast('Clipboard blocked — logged to console', 'error');
  }
}

/** Writes straight to the tour's nodes.json via the studio API. */
async function downloadTour() {
  const result = await saveData('nodes', tour);

  if (result.ok) {
    toast(`Saved to ${result.saved}`);
    return;
  }

  downloadJson('nodes.json', tour);
  toast('API unreachable — downloaded instead', 'error');
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function nodeData() {
  return tour.nodes[pad(current)] ?? { links: [], pan: 0 };
}

function activeLink() {
  return nodeData().links[activeIndex] ?? null;
}

function pitchOk(pitch) {
  return pitch >= PITCH_MIN && pitch <= PITCH_MAX;
}

function buildNodeOptions() {
  el.node.innerHTML = NODES.map((n) => {
    const { name } = tourData.info(n);
    return `<option value="${n}">${pad(n)} — ${escapeHtml(name)}</option>`;
  }).join('');
}

function initialNode() {
  const requested = Number(new URLSearchParams(location.search).get('node'));
  return NODES.includes(requested) ? requested : NODES[0];
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function norm360(value) {
  return ((value % 360) + 360) % 360;
}

function rad2deg(value) {
  return (value * 180) / Math.PI;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );
}

function showStatus(html, kind = 'info') {
  el.status.innerHTML = html;
  el.status.dataset.kind = kind;
  el.status.hidden = false;
}

function hideStatus() {
  el.status.hidden = true;
}

function toast(message, kind = 'ok') {
  const node = document.createElement('div');
  node.className = 'toast';
  node.dataset.kind = kind;
  node.textContent = message;
  document.body.append(node);
  setTimeout(() => node.remove(), 2000);
}
