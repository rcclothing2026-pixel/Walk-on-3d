/**
 * Initial design mode — anchor a panorama to the floor plan by looking at a
 * neighbour.
 *
 * The long way to build a tour is to align every panorama to some agreed
 * direction, then aim every arrow by hand: for this venue, 42 alignments and
 * 102 arrow placements. Most of that is work the geometry already knows.
 *
 * Two dots on a plan give the bearing between them. An arrow's yaw *is* that
 * bearing, once the panorama is fixed against the drawing. Fixing it takes one
 * sighting: stand at 05, turn until you can see 06, say so. Every other arrow
 * at 05 then falls out of the plan, and 144 judgements become 42.
 *
 * This tool writes nothing but `planNorth` into alignment.json. The arrows
 * themselves are derived by scripts/build-nodes.js, so moving a dot later and
 * rebuilding moves the arrows with it — the geometry is not trapped in here.
 *
 * Nothing it produces is final. Every arrow it implies stays editable in the
 * hotspot picker, and it flags them as derived so it is obvious which ones no
 * human has ever looked at.
 */

import { Viewer } from '@photo-sphere-viewer/core';
import '@photo-sphere-viewer/core/index.css';

import { floorplanUrl, dataUrl, panoUrl } from '../src/lib/paths.js';
import { loadTourData } from '../src/lib/tour-data.js';
import { detectMirrored, planBearing, planNorthFromSighting } from '../src/lib/geometry.js';
import { downloadJson, saveData } from './save.js';
import { mountNav } from './nav.js';
import { announceNode, connectFrame } from './frame.js';

const RENDITION = 'mid';

/** Two doorways closer together than this cannot settle the handedness. */
const MIN_SEPARATION = 25;

/** Above this, the two sightings disagree enough to be worth saying so. */
const MAX_RESIDUAL = 12;

const el = {
  viewer: document.getElementById('viewer'),
  crosshair: document.getElementById('crosshair'),
  sightLabel: document.getElementById('sight-label'),
  plan: document.getElementById('plan'),
  planWrap: document.getElementById('plan-wrap'),
  overlay: document.getElementById('overlay'),
  node: document.getElementById('node'),
  nodeName: document.getElementById('node-name'),
  nodeState: document.getElementById('node-state'),
  prev: document.getElementById('prev'),
  next: document.getElementById('next'),
  progress: document.getElementById('progress'),
  save: document.getElementById('save'),
  skip: document.getElementById('skip'),
  target: document.getElementById('target'),
  record: document.getElementById('record'),
  hint: document.getElementById('hint'),
  calibration: document.getElementById('calibration'),
  status: document.getElementById('status'),
};

let tourData = null;
let tour = null;
let NODES = [];
let current = 1;
let viewer = null;

/** node → { pan, planNorth } exactly as alignment.json holds it. */
const alignment = new Map();

/** Whether this tour's panoramas run the usual way round. Null until measured. */
let mirrored = null;

/** Sightings taken at the node in view, not yet committed. */
let sightings = [];

start();

async function start() {
  mountNav({ tool: 'design', node: () => current });

  tourData = await loadTourData();
  NODES = tourData.numbers();
  mirrored = typeof tourData.config.mirrored === 'boolean' ? tourData.config.mirrored : null;

  tour = await loadNodes();
  if (!tour) return;

  await loadAlignment();

  current = initialNode();
  buildNodeOptions();
  wire();
  await loadPlan();
  await openNode(current);

  connectFrame({ current: () => current, goto: openNode });
}

async function loadNodes() {
  try {
    const response = await fetch(dataUrl('nodes'));
    if (!response.ok) throw new Error(String(response.status));
    return await response.json();
  } catch {
    showStatus(
      '<strong>No node graph yet.</strong><br /><br />' +
        'This tool works from the plan, so it needs the nodes placed and linked ' +
        'first. Do that in the map tool (&#9776; &rarr; Map), press ' +
        '<strong>Rebuild</strong> there, then come back.',
      'error',
    );
    return null;
  }
}

async function loadAlignment() {
  try {
    const response = await fetch(dataUrl('alignment'));
    if (!response.ok) return;

    const data = await response.json();
    for (const [id, value] of Object.entries(data)) {
      alignment.set(Number(id), {
        pan: Number.isFinite(value?.pan) && !value.todo ? value.pan : 0,
        planNorth: Number.isFinite(value?.planNorth) ? value.planNorth : null,
      });
    }
  } catch {
    // A tour nobody has aligned yet. Normal.
  }
}

function loadPlan() {
  return new Promise((resolve) => {
    el.plan.addEventListener('load', () => { fitPlan(); resolve(); }, { once: true });
    el.plan.addEventListener('error', () => {
      showStatus(
        '<strong>No floor plan.</strong><br /><br />' +
          'Every angle here is measured off the plan, so there is nothing to do ' +
          'without one. Upload it in the map tool (&#9776; &rarr; Map).',
        'error',
      );
      resolve();
    }, { once: true });
    el.plan.src = floorplanUrl();
  });
}

/* ------------------------------------------------------------------ *
 * The node in view
 * ------------------------------------------------------------------ */

async function openNode(node) {
  current = node;
  sightings = [];

  syncChrome();
  buildTargetOptions();
  drawPlan();

  const url = panoUrl(node, RENDITION);
  const pan = alignment.get(node)?.pan ?? 0;

  try {
    if (!viewer) {
      viewer = new Viewer({
        container: el.viewer,
        panorama: url,
        sphereCorrection: { pan: `${pan}deg` },
        defaultYaw: 0,
        defaultPitch: 0,
        navbar: false,
        moveInertia: false,
      });
      window.__viewer = viewer; // dev handle, same as the other tools
      viewer.addEventListener('position-updated', syncSightLabel);
      viewer.addEventListener('panorama-error', () => showMissingPanorama(node));
      viewer.addEventListener('panorama-loaded', () => {
        hideStatus();
        setEnabled(true);
      });
    } else {
      await viewer.setPanorama(url, {
        sphereCorrection: { pan: `${pan}deg` },
        position: { yaw: 0, pitch: 0 },
        showLoader: true,
      });
      hideStatus();
      setEnabled(true);
    }
  } catch {
    showMissingPanorama(node);
    return;
  }

  syncSightLabel();
}

/**
 * Locks the tool while there is nothing valid to sight.
 *
 * Photo Sphere Viewer leaves the previous sphere on screen when a load fails,
 * so without this you could sight node 07 while looking at node 06's picture
 * and record an anchor that means nothing.
 */
function setEnabled(enabled) {
  const usable = enabled && targets().length > 0 && hasPoint(current);
  for (const control of [el.record, el.save, el.target]) control.disabled = !usable;
  el.crosshair.hidden = !usable;
  document.body.classList.toggle('is-blocked', !usable);
  syncHint();
}

function showMissingPanorama(node) {
  setEnabled(false);
  showStatus(
    `<strong>Node ${pad(node)} has no panorama yet.</strong><br /><br />` +
      'Assign it a photo in the studio, then press <strong>Rebuild this photo</strong> ' +
      'in the &#9776; menu.',
    'error',
  );
}

/* ------------------------------------------------------------------ *
 * Sighting
 * ------------------------------------------------------------------ */

/** Neighbours of a node that are on the plan, so have a bearing to them. */
function targets(node = current) {
  if (!hasPoint(node)) return [];

  return (tour.nodes[pad(node)]?.links ?? [])
    .map((link) => Number(link.node))
    .filter((n) => NODES.includes(n) && hasPoint(n));
}

/** A node that can be worked on at all: it is placed and has somewhere to sight. */
function workable(node) {
  return targets(node).length > 0;
}

function target() {
  return Number(el.target.value);
}

function bearingTo(node) {
  return planBearing(tour.nodes[pad(current)].map, tour.nodes[pad(node)].map);
}

/** Takes down where the operator says a neighbour is. */
function record() {
  const to = target();
  if (!Number.isFinite(to)) return;

  const observedYaw = degrees(viewer.getPosition().yaw);
  const pan = alignment.get(current)?.pan ?? 0;

  sightings = sightings.filter((s) => s.target !== to);
  sightings.push({ target: to, observedYaw, pan, bearing: bearingTo(to) });

  toast(`Sighted ${pad(to)}`);
  nextTarget();
  syncChrome();
  drawPlan();

  if (needsCalibration() && sightings.length >= 2) settleHandedness();
}

/** A tour's handedness is unknown until two real sightings decide it. */
function needsCalibration() {
  return mirrored === null;
}

/**
 * Works out whether this camera's frames run the usual way round.
 *
 * The angle between two doorways is a fact about the building. If the picture
 * disagrees with the plan about its *sign*, the frames are mirrored. Measured,
 * not assumed — and reported rather than quietly applied, because a mirrored
 * panorama is a problem with the source material, not a setting.
 */
function settleHandedness() {
  const [a, b] = sightings.slice(-2);
  const verdict = detectMirrored(a, b);

  if (verdict.separation < MIN_SEPARATION) {
    el.calibration.hidden = false;
    el.calibration.dataset.kind = 'warn';
    el.calibration.textContent =
      `${pad(a.target)} and ${pad(b.target)} are only ${verdict.separation}° apart — sight two further apart`;
    return;
  }

  mirrored = verdict.mirrored;
  el.calibration.hidden = false;
  el.calibration.dataset.kind = verdict.residual > MAX_RESIDUAL ? 'warn' : 'ok';
  el.calibration.textContent = verdict.mirrored
    ? `mirrored panoramas — residual ${verdict.residual}°`
    : `normal panoramas — residual ${verdict.residual}°`;

  if (verdict.residual > MAX_RESIDUAL) {
    showStatus(
      `<strong>The two sightings disagree by ${verdict.residual}°.</strong><br /><br />` +
        'One of them is on the wrong doorway, or one of these nodes is in the wrong ' +
        'place on the plan. Anchoring on this will put every arrow at this node out ' +
        `by about that much.<br /><br />Sight ${pad(a.target)} and ${pad(b.target)} ` +
        'again, or fix the map points first.',
      'warn',
    );
  }
}

/**
 * Commits the node's anchor and moves on.
 *
 * Only `planNorth` and `pan` are written. Arrow angles are the build's job, so
 * that moving a dot and rebuilding moves the arrows too.
 */
async function saveAndNext() {
  if (!sightings.length) {
    toast('Turn to a neighbour and press Record sighting first', 'error');
    return;
  }

  if (needsCalibration()) {
    toast('Sight a second doorway — that is what settles the handedness', 'error');
    return;
  }

  const planNorth = planNorthFromSighting({ ...sightings[0], mirrored });

  // pan is set to the anchor so the sphere opens plan-aligned: yaw 0 looks at
  // the top of the drawing. That also puts the mini-map's facing cone the right
  // way round, which "any consistent direction" never guaranteed.
  alignment.set(current, { pan: round(planNorth), planNorth: round(planNorth) });

  if (!(await persist())) return;

  const next =
    NODES.find((n) => n > current && workable(n) && !isAnchored(n)) ??
    NODES.find((n) => workable(n) && !isAnchored(n));
  if (next === undefined) {
    toast('Nothing left to anchor — press Rebuild in the ☰ menu');
    syncChrome();
    return;
  }

  await openNode(next);
}

async function persist() {
  const payload = {};
  for (const n of NODES) {
    const entry = alignment.get(n);
    payload[pad(n)] = entry
      ? { pan: entry.pan, ...(entry.planNorth === null ? {} : { planNorth: entry.planNorth }) }
      : { pan: 0, todo: true };
  }

  const result = await saveData('alignment', payload);
  if (!result.ok) {
    downloadJson('alignment.json', payload);
    toast('API unreachable — downloaded instead', 'error');
    return false;
  }

  // The handedness belongs to the tour, not to a node, and it is only measured
  // once. Written on the first save so a later session does not re-ask.
  if (tourData.config.mirrored !== mirrored) {
    tourData.config.mirrored = mirrored;
    await saveData('tour', tourData.config);
  }

  toast(`Anchored ${pad(current)}`);
  return true;
}

/* ------------------------------------------------------------------ *
 * Drawing
 * ------------------------------------------------------------------ */

function drawPlan() {
  const { naturalWidth: w, naturalHeight: h } = el.plan;
  if (!w) return;

  el.overlay.setAttribute('viewBox', `0 0 ${w} ${h}`);

  const r = Math.max(6, w / 180);
  const here = tour.nodes[pad(current)]?.map;
  const to = Number.isFinite(target()) ? tour.nodes[pad(target())]?.map : null;

  const sightLines = sightings
    .map((s) => {
      const p = tour.nodes[pad(s.target)]?.map;
      return p && here
        ? `<line class="plan-edge is-done" x1="${here.x}" y1="${here.y}" x2="${p.x}" y2="${p.y}"
                 stroke-width="${r / 2}" />`
        : '';
    })
    .join('');

  const aim = here && to
    ? `<line class="plan-edge is-live" x1="${here.x}" y1="${here.y}" x2="${to.x}" y2="${to.y}"
             stroke-width="${r / 2}" />`
    : '';

  const dots = NODES.filter(hasPoint)
    .map((n) => {
      const { x, y } = tour.nodes[pad(n)].map;
      const role = n === current ? 'is-active' : n === target() ? 'is-target' : '';
      const done = isAnchored(n) ? 'is-anchored' : '';
      return `
        <g class="plan-dot ${role} ${done}">
          <circle cx="${x}" cy="${y}" r="${n === current ? r * 1.5 : r}" />
          <text x="${x}" y="${y - r * 2}" font-size="${r * 2.2}">${pad(n)}</text>
        </g>`;
    })
    .join('');

  el.overlay.innerHTML = sightLines + aim + dots;
}

function fitPlan() {
  const box = el.planWrap.parentElement.getBoundingClientRect();
  const fit = Math.min(
    (box.width - 24) / el.plan.naturalWidth,
    (box.height - 24) / el.plan.naturalHeight,
  );
  el.planWrap.style.width = `${el.plan.naturalWidth * Math.max(0.05, fit)}px`;
  drawPlan();
}

/**
 * What the crosshair is currently pointing at, in the plan's own terms.
 *
 * Only meaningful once the node is anchored — before that the panorama has no
 * relationship to the drawing, which is exactly what a sighting establishes.
 */
function syncSightLabel() {
  if (!viewer) return;

  const anchor = alignment.get(current)?.planNorth;
  const observed = degrees(viewer.getPosition().yaw);

  if (!Number.isFinite(anchor) || mirrored === null) {
    el.sightLabel.textContent = 'not anchored yet';
    el.sightLabel.dataset.kind = 'muted';
    return;
  }

  const pan = alignment.get(current)?.pan ?? 0;
  const bearing = round(
    // The inverse of arrowYaw: what plan bearing is the crosshair on?
    mirrored ? -(observed + pan - anchor) : observed + pan - anchor,
  );

  el.sightLabel.textContent = `looking ${((bearing % 360) + 360) % 360}° on the plan`;
  el.sightLabel.dataset.kind = 'ok';
}

/* ------------------------------------------------------------------ *
 * Chrome
 * ------------------------------------------------------------------ */

function syncChrome() {
  const { name } = tourData.info(current);
  const anchored = NODES.filter(isAnchored).length;

  announceNode(current);

  el.node.value = String(current);
  el.nodeName.textContent = name;
  el.nodeState.textContent = isAnchored(current) ? 'anchored' : 'not anchored';
  el.nodeState.dataset.kind = isAnchored(current) ? 'ok' : '';

  el.prev.disabled = NODES.indexOf(current) === 0;
  el.next.disabled = NODES.indexOf(current) === NODES.length - 1;
  el.progress.textContent = `${anchored}/${NODES.length} anchored`;
  el.progress.dataset.complete = String(anchored === NODES.length);

  syncHint();
}

function syncHint() {
  if (!hasPoint(current)) {
    el.hint.innerHTML =
      '<strong>Not on the plan.</strong> Place it in the map tool first — ' +
      'there is no bearing without a position.';
    return;
  }

  if (!targets().length) {
    const links = (tour.nodes[pad(current)]?.links ?? []).length;
    el.hint.innerHTML =
      `<strong>Nothing to sight from here.</strong> This node ${
        links ? 'links only to nodes that are not on the plan yet' : 'has no links at all'
      }. Draw one to a placed node in the map tool (&#9776; &rarr; Map, press 3), ` +
      'then <strong>Rebuild</strong>.';
    return;
  }

  if (needsCalibration() && targets().length < 2) {
    const elsewhere = NODES.find((n) => targets(n).length >= 2);
    el.hint.innerHTML =
      '<strong>Only one placed neighbour here.</strong> Calibration needs two, ' +
      'because it works from the angle between them. ' +
      (elsewhere === undefined
        ? 'Place and link more nodes first.'
        : `Start at <strong>${pad(elsewhere)}</strong> instead.`);
    return;
  }

  if (needsCalibration()) {
    el.hint.innerHTML =
      `<strong>Calibrating (${sightings.length}/2).</strong> Sight two doorways at ` +
      'this node — that is what tells the tour whether its panoramas run the ' +
      'usual way round. Only needed once.';
    return;
  }

  el.hint.innerHTML = sightings.length
    ? 'Sighted. <strong>Save &amp; next</strong> anchors this node and moves on.'
    : `Turn until <strong>${pad(target())}</strong> is on the crosshair, then ` +
      '<strong>Record sighting</strong>.';
}

function buildNodeOptions() {
  el.node.innerHTML = NODES.map((n) => {
    const { name } = tourData.info(n);
    return `<option value="${n}">${pad(n)} — ${escapeHtml(name)}</option>`;
  }).join('');
}

function buildTargetOptions() {
  const list = targets();
  el.target.innerHTML = list
    .map((n) => `<option value="${n}">${pad(n)} — ${escapeHtml(tourData.info(n).name)}</option>`)
    .join('');
}

/** Moves the aim to a neighbour that has not been sighted yet. */
function nextTarget() {
  const remaining = targets().filter((n) => !sightings.some((s) => s.target === n));
  if (remaining.length) el.target.value = String(remaining[0]);
}

/* ------------------------------------------------------------------ *
 * Controls
 * ------------------------------------------------------------------ */

function wire() {
  el.node.addEventListener('change', () => openNode(Number(el.node.value)));
  el.prev.addEventListener('click', () => step(-1));
  el.next.addEventListener('click', () => step(1));
  el.target.addEventListener('change', () => { drawPlan(); syncHint(); });
  el.record.addEventListener('click', record);
  el.save.addEventListener('click', saveAndNext);
  el.skip.addEventListener('click', () => step(1));

  window.addEventListener('resize', fitPlan);

  window.addEventListener('keydown', (event) => {
    if (event.target.matches('input, select')) return;

    if (event.key === 'PageUp') { event.preventDefault(); step(-1); }
    if (event.key === 'PageDown') { event.preventDefault(); step(1); }
    if (event.key === 'Enter') { event.preventDefault(); saveAndNext(); }
    if (event.key === ' ') { event.preventDefault(); record(); }
    if (event.key === 'Tab') {
      event.preventDefault();
      const list = targets();
      const at = list.indexOf(target());
      if (list.length) el.target.value = String(list[(at + 1) % list.length]);
      drawPlan();
      syncHint();
    }
  });
}

function step(delta) {
  const index = NODES.indexOf(current) + delta;
  if (index < 0 || index >= NODES.length) return;
  openNode(NODES[index]);
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function hasPoint(node) {
  const p = tour?.nodes?.[pad(node)]?.map;
  return Number.isFinite(p?.x) && Number.isFinite(p?.y);
}

function isAnchored(node) {
  return Number.isFinite(alignment.get(node)?.planNorth);
}

/**
 * Where to start.
 *
 * Not simply the first unanchored node: calibration needs two placed
 * neighbours to sight, and landing on a node that has one — or none — reads as
 * the tool being broken rather than as that node not being ready. So when the
 * handedness is still unknown, it opens somewhere that can settle it.
 */
function initialNode() {
  const requested = Number(new URLSearchParams(location.search).get('node'));
  if (NODES.includes(requested)) return requested;

  if (needsCalibration()) {
    const calibratable = NODES.find((n) => targets(n).length >= 2);
    if (calibratable !== undefined) return calibratable;
  }

  return (
    NODES.find((n) => workable(n) && !isAnchored(n)) ??
    NODES.find((n) => workable(n)) ??
    NODES[0] ??
    1
  );
}

function degrees(radians) {
  return ((((radians * 180) / Math.PI) % 360) + 360) % 360;
}

function round(value) {
  return Math.round(value * 10) / 10;
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
  setTimeout(() => node.remove(), 2200);
}
