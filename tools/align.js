/**
 * Phase 2 — alignment tool.
 *
 * Every panorama was shot with the camera facing a different direction, so
 * yaw 0° means something different in each file. This tool records, per node,
 * the `sphereCorrection.pan` that rotates the sphere onto a common reference
 * direction. Hotspots placed before this is done would all be wrong.
 *
 * Workflow per node:
 *   1. Press Home (or "Center view") to park the camera at yaw 0.
 *   2. Drag the slider — or hold ←/→ — until the reference direction sits
 *      under the crosshair.
 *   3. Press Enter to record it and advance.
 *
 * The reference direction is whatever you choose, as long as it is the SAME
 * real-world direction in every node. Building north is the usual pick; the
 * courtyard's main axis works just as well. Consistency is all that matters —
 * the tour never displays an absolute bearing.
 *
 * There is no localStorage by project rule, so values live in memory only.
 * Saving writes the tour's own alignment.json; the
 * page warns on unload while anything is unsaved.
 */

import { Viewer } from '@photo-sphere-viewer/core';
import '@photo-sphere-viewer/core/index.css';

import { panoUrl, dataUrl, nodeId as pad } from '../src/lib/paths.js';
import { loadTourData } from '../src/lib/tour-data.js';
import { downloadJson, saveData } from './save.js';
import {
  hideStatus,
  initialNode,
  nodeOptions,
  showStatus,
  toast,
  wireUnloadGuard,
} from './lib.js';
import { mountNav } from './nav.js';
import { announceNode, connectFrame } from './frame.js';

/** Filled once the tour's roster has loaded. */
let NODES = [];
let tourData = null;

/** Which rendition to align against. `mid` shows enough detail to pick a
 *  landmark without pulling 8192px files for all 43 nodes. */
const RENDITION = 'mid';

const el = {
  viewer: document.getElementById('viewer'),
  node: document.getElementById('node'),
  prev: document.getElementById('prev'),
  next: document.getElementById('next'),
  name: document.getElementById('node-name'),
  type: document.getElementById('node-type'),
  warn: document.getElementById('node-warn'),
  progress: document.getElementById('progress'),
  copy: document.getElementById('copy'),
  download: document.getElementById('download'),
  pan: document.getElementById('pan'),
  panValue: document.getElementById('pan-value'),
  nudgeUp: document.getElementById('nudge-up'),
  nudgeDown: document.getElementById('nudge-down'),
  resetView: document.getElementById('reset-view'),
  clear: document.getElementById('clear'),
  save: document.getElementById('save'),
  status: document.getElementById('status'),
  bearing: document.getElementById('bearing'),
  compassRing: document.getElementById('compass-ring'),
};

/** node number → pan in degrees. Committed values only. */
const saved = new Map();

let current = 1;

/**
 * Plan anchors, by node, read from alignment.json and written back unchanged.
 *
 * This tool does not set them — the design tool does — but it owns the file,
 * so it has to hand them back.
 */
const anchors = new Map();
let pan = 0;
let dirty = false;

/**
 * The alignment file as it stands on disk, serialised.
 *
 * The unload guard compares this against what is in memory: equal means every
 * value was loaded, not edited, and closing the page loses nothing. A session
 * that only ever loaded existing work never sees the warning.
 */
let savedToDisk = null;
let viewer = null;

start();

async function start() {
  mountNav({ tool: 'align', node: () => current });
  tourData = await loadTourData();
  NODES = tourData.numbers();
  current = initialNode();

  buildCompassRing();
  buildNodeOptions();
  await loadExistingAlignment();
  wireControls();
  wireKeyboard();
  savedToDisk = snapshot();
  // Warns only when memory has drifted from the file on disk — edits, clears,
  // or values recorded this session that persist() has not written yet.
  wireUnloadGuard(() => dirty || snapshot() !== savedToDisk);
  await openNode(current);

  // Last: a pane must know its roster before the split view can move it.
  connectFrame({ current: () => current, goto: openNode });
}

/* ------------------------------------------------------------------ *
 * Viewer
 * ------------------------------------------------------------------ */

async function openNode(node) {
  current = node;
  pan = saved.get(node) ?? 0;
  // The displayed value now matches this node's stored state, so nothing is
  // pending. Anything unsaved was already confirmed away by confirmDiscard().
  dirty = false;

  syncNodeChrome();
  syncPanInputs();
  // Ahead of the fetch too, so the compass does not sit on the previous node's
  // bearing for the second or two the panorama takes to arrive.
  syncCompass();

  const url = panoUrl(node, RENDITION);

  try {
    if (!viewer) {
      viewer = new Viewer({
        container: el.viewer,
        panorama: url,
        sphereCorrection: { pan: deg(pan) },
        defaultYaw: 0,
        defaultPitch: 0,
        navbar: false,
        mousewheelCtrlKey: false,
        // The tool is about horizontal alignment; leaving the camera free to
        // roll would make the crosshair reading ambiguous.
        moveInertia: false,
      });
      window.__viewer = viewer; // dev handle for console inspection
      viewer.addEventListener('position-updated', syncCompass);
      viewer.addEventListener('ready', syncCompass, { once: true });
      // The constructor resolves before the image does and never throws, so a
      // first-load failure only surfaces here. setPanorama() rejects on its
      // own, which the catch below handles.
      viewer.addEventListener('panorama-error', (event) =>
        showMissingPanorama(current, event.error),
      );
      viewer.addEventListener('panorama-loaded', () => {
        hideStatus(el.status);
        setControlsEnabled(true);
      });
    } else {
      await viewer.setPanorama(url, {
        sphereCorrection: { pan: deg(pan) },
        position: { yaw: 0, pitch: 0 },
        showLoader: true,
      });
    }
    hideStatus(el.status);
    setControlsEnabled(true);
  } catch (err) {
    showMissingPanorama(node, err);
    return;
  }

  syncCompass();
}

/**
 * Locks the controls while the current node has no panorama.
 *
 * Photo Sphere Viewer leaves the previous sphere on screen when a load fails,
 * so without this you can sit on node 07, be looking at node 06's image, and
 * save an alignment that means nothing.
 */
function setControlsEnabled(enabled) {
  for (const control of [
    el.pan, el.panValue, el.nudgeUp, el.nudgeDown,
    el.save, el.clear, el.resetView,
  ]) {
    control.disabled = !enabled;
  }
  document.body.classList.toggle('is-blocked', !enabled);
}

function showMissingPanorama(node, err) {
  const file = panoUrl(node, RENDITION);
  setControlsEnabled(false);
  showStatus(
    el.status,
    `<strong>Node ${pad(node)} has no panorama yet.</strong><br />` +
      `Expected <code>${file}</code><br /><br />` +
      'Assign it a photo in the studio, then press ' +
      '<strong>Rebuild this photo</strong> in the &#9776; menu.',
    'error',
  );
  console.warn(`[align] could not load ${file}`, err);
}

/** Re-applies `pan` without re-fetching the image. */
function applyPan() {
  if (!viewer) return;
  viewer.setOption('sphereCorrection', { pan: deg(pan) });
  syncCompass();
}

/* ------------------------------------------------------------------ *
 * Compass
 * ------------------------------------------------------------------ */

function buildCompassRing() {
  const cardinals = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
  const parts = [];

  for (let a = 0; a < 360; a += 15) {
    const isCardinal = a in cardinals;
    const outer = 52;
    const inner = isCardinal ? 42 : 47;
    const [x1, y1] = polar(a, outer);
    const [x2, y2] = polar(a, inner);
    parts.push(`<line class="compass__tick" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`);

    if (isCardinal || a % 45 === 0) {
      const [lx, ly] = polar(a, 33);
      const cls = isCardinal ? 'compass__label compass__label--cardinal' : 'compass__label';
      parts.push(`<text class="${cls}" x="${lx}" y="${ly}">${cardinals[a] ?? a}</text>`);
    }
  }

  el.compassRing.innerHTML = parts.join('');
}

/**
 * The needle points at the camera's corrected bearing: where the crosshair is
 * looking once `pan` has been applied. That is the number that has to mean the
 * same thing in every node.
 */
function syncCompass() {
  const yaw = viewer?.getPosition?.().yaw ?? 0;
  const bearing = norm360(rad2deg(yaw) + pan);

  el.compassRing.setAttribute('transform', `rotate(${-bearing})`);
  el.bearing.textContent = `${bearing.toFixed(1)}°`;
}

function polar(angleDeg, radius) {
  const a = deg2rad(angleDeg - 90);
  return [(Math.cos(a) * radius).toFixed(2), (Math.sin(a) * radius).toFixed(2)];
}

/* ------------------------------------------------------------------ *
 * Chrome
 * ------------------------------------------------------------------ */

function buildNodeOptions() {
  el.node.innerHTML = nodeOptions(NODES, (n) => tourData.info(n));
}

function syncNodeChrome() {
  const { name, type, unconfirmed } = tourData.info(current);

  // Keeps the other pane of the split view on the same node. Inert otherwise.
  announceNode(current);

  el.node.value = String(current);
  el.name.textContent = name;
  el.type.textContent = type;
  el.warn.hidden = !unconfirmed;

  el.prev.disabled = NODES.indexOf(current) === 0;
  el.next.disabled = NODES.indexOf(current) === NODES.length - 1;

  syncProgress();
}

function syncProgress() {
  const done = saved.size;
  const total = NODES.length;
  const suffix = dirty ? ' · unsaved' : '';
  el.progress.textContent = `${done}/${total} aligned${suffix}`;
  el.progress.dataset.complete = String(done === total && !dirty);
}

function syncPanInputs() {
  el.pan.value = String(pan);
  el.panValue.value = String(pan);
}

/* ------------------------------------------------------------------ *
 * Controls
 * ------------------------------------------------------------------ */

function wireControls() {
  el.pan.addEventListener('input', () => setPan(Number(el.pan.value)));
  el.panValue.addEventListener('change', () => setPan(Number(el.panValue.value)));

  el.nudgeUp.addEventListener('click', () => nudge(1));
  el.nudgeDown.addEventListener('click', () => nudge(-1));

  el.node.addEventListener('change', () => {
    const target = Number(el.node.value);
    if (confirmDiscard()) openNode(target);
    else el.node.value = String(current); // put the select back
  });
  el.prev.addEventListener('click', () => step(-1));
  el.next.addEventListener('click', () => step(1));

  el.resetView.addEventListener('click', centerView);
  el.save.addEventListener('click', saveAndAdvance);
  el.clear.addEventListener('click', clearCurrent);

  el.copy.addEventListener('click', copyJson);
  el.download.addEventListener('click', persist);
}

function wireKeyboard() {
  window.addEventListener('keydown', (event) => {
    // Let the number field handle its own arrows and Enter.
    if (event.target === el.panValue) {
      if (event.key === 'Enter') el.panValue.blur();
      return;
    }

    const nudgeBy = event.shiftKey ? 10 : 1;

    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        nudge(-nudgeBy);
        break;
      case 'ArrowRight':
        event.preventDefault();
        nudge(nudgeBy);
        break;
      case 'Enter':
        event.preventDefault();
        saveAndAdvance();
        break;
      case 'Home':
        event.preventDefault();
        centerView();
        break;
      case 'PageUp':
        event.preventDefault();
        step(-1);
        break;
      case 'PageDown':
        event.preventDefault();
        step(1);
        break;
      default:
    }
  });
}

function setPan(value) {
  if (!Number.isFinite(value) || el.pan.disabled) return;
  pan = clampPan(round(value));
  dirty = true;
  syncPanInputs();
  syncProgress();
  applyPan();
}

function nudge(delta) {
  setPan(pan + delta);
}

function centerView() {
  viewer?.animate({ yaw: 0, pitch: 0, speed: '2rpm' });
}

function step(delta) {
  const index = NODES.indexOf(current) + delta;
  if (index < 0 || index >= NODES.length) return;
  if (!confirmDiscard()) return;
  openNode(NODES[index]);
}

/**
 * Leaving a node without pressing Enter throws its pan away. Cheap to confirm,
 * and it only ever fires when there is something to lose.
 */
function confirmDiscard() {
  if (!dirty) return true;
  return window.confirm(
    `Node ${pad(current)} has an unsaved value of ${pan}°.\n\nDiscard it and move on?`,
  );
}

function saveAndAdvance() {
  if (el.save.disabled) {
    toast('This node has no panorama — nothing to align', 'error');
    return;
  }

  saved.set(current, pan);
  dirty = false;
  syncProgress();
  toast(`Node ${pad(current)} saved at ${pan}°`);

  const index = NODES.indexOf(current);
  if (index < NODES.length - 1) {
    openNode(NODES[index + 1]);
  } else {
    toast('Last node — remember to download the JSON');
  }
}

function clearCurrent() {
  saved.delete(current);
  pan = 0;
  dirty = false;
  syncPanInputs();
  syncProgress();
  applyPan();
}

/* ------------------------------------------------------------------ *
 * Output
 * ------------------------------------------------------------------ */

/**
 * Emits every node in tour order, so the file is diffable and it is obvious
 * which nodes are still untouched. Nodes never saved are marked so they cannot
 * be mistaken for a deliberate 0°.
 */
/**
 * The whole alignment file, rebuilt from what is in memory.
 *
 * `planNorth` is carried through untouched. It is written by the design tool
 * and says how this panorama sits against the floor plan; this tool has no
 * opinion about it, and rewriting the file without it would silently unpick
 * every arrow derived from the plan.
 *
 * It survives a Clear too. Clearing says "this node is not aligned", which is
 * a statement about `pan`; where the building is relative to the picture did
 * not change.
 */
function buildObject() {
  const out = {};

  for (const n of NODES) {
    const anchor = anchors.has(n) ? { planNorth: anchors.get(n) } : {};
    out[pad(n)] = saved.has(n) ? { pan: saved.get(n), ...anchor } : { pan: 0, todo: true, ...anchor };
  }

  return out;
}

/** Serialises what is in memory right now, for drift comparison. */
function snapshot() {
  return JSON.stringify(buildObject());
}

async function copyJson() {
  const json = `${JSON.stringify(buildObject(), null, 2)}\n`;
  try {
    await navigator.clipboard.writeText(json);
    toast(`Copied ${saved.size}/${NODES.length} nodes`);
  } catch {
    // Clipboard needs a secure context; the download always works.
    console.log(json);
    toast('Clipboard blocked — JSON logged to console', 'error');
  }
}

/** Writes straight to the tour's alignment.json via the studio API. */
async function persist() {
  const result = await saveData('alignment', buildObject());

  if (result.ok) {
    dirty = false;
    savedToDisk = snapshot();
    syncProgress();
    toast(`Saved to ${result.saved}`);
    return;
  }

  downloadJson('alignment.json', buildObject());
  toast('API unreachable — downloaded instead', 'error');
}

/** Picks up a previous session's work so alignment can be done across sittings. */
async function loadExistingAlignment() {
  try {
    const response = await fetch(dataUrl('alignment'));
    if (!response.ok) return;

    const data = await response.json();
    for (const [key, value] of Object.entries(data)) {
      const n = Number(key);
      if (!NODES.includes(n)) continue;

      if (Number.isFinite(value?.pan) && !value.todo) saved.set(n, clampPan(round(value.pan)));
      if (Number.isFinite(value?.planNorth)) anchors.set(n, value.planNorth);
    }

    if (saved.size) toast(`Loaded ${saved.size} existing alignment(s)`);
  } catch {
    // Absent or malformed: start from scratch, which is the normal first run.
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Keeps the slider's half-degree resolution and avoids float noise. */
function round(value) {
  return Math.round(value * 2) / 2;
}

/** Wraps into (-180, 180] so the slider never pins at an end. */
function clampPan(value) {
  const wrapped = ((value % 360) + 540) % 360 - 180;
  return wrapped === -180 ? 180 : round(wrapped);
}

function norm360(value) {
  return ((value % 360) + 360) % 360;
}

function deg(value) {
  return `${value}deg`;
}

function deg2rad(value) {
  return (value * Math.PI) / 180;
}

function rad2deg(value) {
  return (value * 180) / Math.PI;
}
