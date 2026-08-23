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
import { MarkersPlugin } from '@photo-sphere-viewer/markers-plugin';
import '@photo-sphere-viewer/markers-plugin/index.css';

import { floorplanUrl, dataUrl, panoUrl } from '../src/lib/paths.js';
import { loadTourData } from '../src/lib/tour-data.js';
import {
  arrowYaw,
  detectMirrored,
  planBearing,
  planNorthFromSighting,
  rawAngle,
} from '../src/lib/geometry.js';
import { downloadJson, saveData, withTour } from './save.js';
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
  undo: document.getElementById('undo'),
  photo: document.getElementById('photo'),
  library: document.getElementById('library'),
  libraryNode: document.getElementById('library-node'),
  libraryStrip: document.getElementById('library-strip'),
  libraryClose: document.getElementById('library-close'),
  modes: [...document.querySelectorAll('[data-mode]')],
  recalibrate: document.getElementById('recalibrate'),
  saveAll: document.getElementById('save-all'),
};

let tourData = null;
let tour = null;
let NODES = [];
let current = 1;
let viewer = null;
let markers = null;

/** node → { pan, planNorth } exactly as alignment.json holds it. */
const alignment = new Map();

/**
 * Whether this tour's panoramas run the usual way round.
 *
 * Defaults to the usual handedness rather than to "unknown". Nearly every 360
 * camera writes frames that way, and holding every anchor hostage to a
 * measurement — one that needs a node with two placed neighbours, which not
 * every node has — stops the work for the rare case instead of the common one.
 *
 * Sighting two doorways at any node still measures it, and disagreeing with
 * this is loud. Because the sighting itself is what gets stored, flipping the
 * verdict later recomputes every anchor rather than invalidating them.
 */
let mirrored = false;

/** Whether that default has actually been measured. */
let handednessMeasured = false;

/** Sightings taken at the node in view, not yet committed. */
let sightings = [];

/**
 * The tour's edge list, held here rather than read out of the generated graph.
 *
 * Neighbours have to be editable from this page — realising a node connects to
 * nowhere is something that happens while you are standing in it — and reading
 * them from nodes.json would mean a rebuild between drawing a link and being
 * able to sight along it.
 */
let links = { edges: [] };

/** What a click on the plan does: sight a neighbour, place this node, or link it. */
let mode = 'sight';

/**
 * Reversible steps, most recent last.
 *
 * Every entry knows how to put back exactly what it changed. Anchoring, linking
 * and assigning a photograph are all one press away from each other here, and
 * one press away from being wrong.
 */
const history = [];

/** Whether a map point has moved since the last save. */
let mapDirty = false;

/**
 * Whether anything at all is unwritten.
 *
 * Placing forty nodes and drawing a hundred links is an afternoon's work that
 * lives in this page until it is saved, so it gets its own button and its own
 * warning rather than riding along with anchoring a node.
 */
let dirty = false;

/**
 * Whether a panorama swap is still in flight.
 *
 * Photo Sphere Viewer's `panorama-error` is asynchronous, so a failure from the
 * load *before* this one can arrive after the current one has succeeded. Acting
 * on it would put "this node has no panorama" back over a panorama that is on
 * screen — which is what happened the first time a photograph was assigned from
 * the library.
 */
let loadingPanorama = false;

start();

async function start() {
  mountNav({ tool: 'design', node: () => current });

  tourData = await loadTourData();
  NODES = tourData.numbers();
  mirrored = tourData.config.mirrored === true;
  handednessMeasured = typeof tourData.config.mirrored === 'boolean';

  tour = await loadNodes();
  if (!tour) return;

  await loadAlignment();
  links = (await loadLinks()) ?? { edges: [] };

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
        sight: Number.isFinite(value?.sight?.raw) ? value.sight : null,
      });
    }
  } catch {
    // A tour nobody has aligned yet. Normal.
  }
}

/** The tour's edges. A tour nobody has linked yet simply has none. */
async function loadLinks() {
  try {
    const response = await fetch(dataUrl('links'));
    return response.ok ? await response.json() : { edges: [] };
  } catch {
    return { edges: [] };
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

  loadingPanorama = true;

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
        plugins: [[MarkersPlugin, { markers: [] }]],
      });
      window.__viewer = viewer; // dev handle, same as the other tools
      markers = viewer.getPlugin(MarkersPlugin);

      // Clicking an arrow is the quickest way to say "that is the one I am
      // looking at" — the list is a fallback, not the primary control.
      markers.addEventListener('select-marker', ({ marker }) => {
        const node = Number(marker.id.replace('arrow-', ''));
        if (!targets().includes(node)) return;
        el.target.value = String(node);
        drawPlan();
        syncHint();
        syncArrows();
      });
      viewer.addEventListener('position-updated', syncSightLabel);
      viewer.addEventListener('panorama-error', () => {
        if (!loadingPanorama) return;
        loadingPanorama = false;
        explainPanoramaFailure(current);
      });
      viewer.addEventListener('panorama-loaded', () => {
        loadingPanorama = false;
        hideStatus();
        setEnabled(true);
        syncArrows();
      });
    } else {
      await viewer.setPanorama(url, {
        sphereCorrection: { pan: `${pan}deg` },
        position: { yaw: 0, pitch: 0 },
        showLoader: true,
      });
      loadingPanorama = false;
      hideStatus();
      setEnabled(true);
    }
  } catch {
    loadingPanorama = false;
    showMissingPanorama(node);
    return;
  }

  syncSightLabel();
  syncArrows();
}

/**
 * Draws the arrows this node's links would produce, live.
 *
 * They are the whole point of anchoring, and until now they only appeared after
 * a rebuild in another tool — so the one thing you could not see was whether
 * the sighting you just took had worked. Computed here with the same function
 * the build uses, from the same anchor, so what is on screen is what will be
 * written.
 *
 * A node with no anchor yet has no arrows to show. That is not a failure; it is
 * the reason to take a sighting.
 */
function syncArrows() {
  if (!markers) return;
  markers.clearMarkers();

  const anchor = pendingAnchor();
  if (!Number.isFinite(anchor)) return;

  const pan = alignment.get(current)?.pan ?? 0;
  const aimed = target();

  for (const node of targets()) {
    const yaw = arrowYaw({
      planNorth: anchor,
      pan,
      bearing: planBearing(tour.nodes[pad(current)].map, tour.nodes[pad(node)].map),
      mirrored,
    });

    const link = (tour.nodes[pad(current)]?.links ?? []).find((l) => Number(l.node) === node);
    const pitch = Number.isFinite(link?.pitch) ? link.pitch : -20;
    const picked = link && !link.auto && !link.derived;

    markers.addMarker({
      id: `arrow-${node}`,
      position: { yaw: `${round(yaw)}deg`, pitch: `${pitch}deg` },
      html: arrowHtml(node, { aimed: node === aimed, picked }),
      size: { width: 64, height: 64 },
      anchor: 'center center',
      tooltip: `${pad(node)} — ${escapeHtml(tourData.info(node).name)}<br>${round(yaw)}°`,
    });
  }
}

/**
 * The anchor to draw arrows from: the one just sighted, or the saved one.
 *
 * Preferring the unsaved sighting is what makes this immediate — you turn to a
 * doorway, record it, and every other arrow at the node swings into place
 * before you have committed to anything.
 */
function pendingAnchor() {
  if (sightings.length) {
    return planNorthFromSighting({ ...sightings[0], mirrored });
  }
  return alignment.get(current)?.planNorth ?? NaN;
}

function arrowHtml(node, { aimed, picked }) {
  const colour = aimed ? 'var(--accent)' : picked ? 'var(--ok)' : 'rgba(255,255,255,.8)';

  return `
    <div class="hs-marker" style="--c:${colour}; --s:${aimed ? 1 : 0.8}">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 2 L20 20 L12 15.5 L4 20 Z" />
      </svg>
      <span>${pad(node)}</span>
    </div>`;
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
  el.modes.find((b) => b.dataset.mode === 'link').disabled = !hasPoint(current);
  el.crosshair.hidden = !usable || mode !== 'sight';
  document.body.classList.toggle('is-blocked', !usable);
  syncHint();
}

/**
 * Why the sphere did not load.
 *
 * Photo Sphere Viewer reports that an image failed, never what the server said
 * about it, so ask. The distinction is the whole point: one node without a
 * photograph is work for the studio, while a panos root that is not mounted is
 * work for the machine — and every node will say the same thing until someone
 * goes and looks. Until this asked, both were "no panorama yet".
 */
async function explainPanoramaFailure(node) {
  setEnabled(false);

  let status = 0;
  try {
    const res = await fetch(panoUrl(node, RENDITION), { method: 'HEAD', cache: 'no-store' });
    status = res.status;
  } catch {
    // Offline, or the studio went away mid-question. The missing-photo message
    // below is the honest answer when we cannot get a better one.
  }

  // The operator moved on while we were asking; whatever is on screen now
  // belongs to another node.
  if (node !== current) return;

  if (status === 503) {
    showStatus(
      '<strong>The panoramas are not mounted.</strong><br /><br />' +
        'Every node will fail until <code>panos/</code> resolves on the studio machine. ' +
        'Nothing is wrong with the roster and no photograph is missing — check the ' +
        'directory, or the symlink pointing at it.',
      'error',
    );
    return;
  }

  showMissingPanorama(node);
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

/** Everything this node is connected to, however it was numbered. */
function neighbours(node = current) {
  return links.edges
    .filter((edge) => edge.includes(node))
    .map((edge) => (edge[0] === node ? edge[1] : edge[0]))
    .filter((n) => NODES.includes(n));
}

/** Neighbours of a node that are on the plan, so have a bearing to them. */
function targets(node = current) {
  if (!hasPoint(node)) return [];
  return neighbours(node).filter(hasPoint);
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
  // The whole node's arrows swing into place here, before anything is saved.
  // Seeing them land on the right doorways is how you know the sighting worked.
  syncArrows();

  if (needsCalibration() && sightings.length >= 2) settleHandedness();
}

/** Whether a second sighting here would tell us something we have not measured. */
function needsCalibration() {
  return !handednessMeasured;
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

  handednessMeasured = true;
  const changed = verdict.mirrored !== mirrored;
  mirrored = verdict.mirrored;
  el.calibration.hidden = false;
  el.calibration.dataset.kind = verdict.mirrored || verdict.residual > MAX_RESIDUAL ? 'warn' : 'ok';
  el.calibration.textContent = verdict.mirrored
    ? `mirrored panoramas — residual ${verdict.residual}°`
    : `normal panoramas — residual ${verdict.residual}°`;
  el.recalibrate.hidden = false;

  // Mirrored is the rare answer. Consumer 360 cameras write the usual
  // handedness, so this verdict is much more often a wrong map point or a
  // sighting on the wrong doorway than a genuinely mirrored camera. Said out
  // loud rather than applied quietly, because applying it quietly would mirror
  // every arrow in the tour.
  // Every anchor already recorded was drawn from a stored sighting, so a change
  // of handedness is re-derived rather than re-walked.
  if (changed) reanchorFromSightings();
  syncArrows();

  if (verdict.mirrored) {
    showStatus(
      '<strong>This measured as mirrored.</strong><br /><br />' +
        `Two sightings ${verdict.separation}° apart, disagreeing by ${verdict.residual}°.<br /><br />` +
        'Mirrored panoramas are rare — nearly every 360 camera writes the usual ' +
        'way round. It is far more likely that one of these nodes is in the wrong ' +
        'place on the plan, or that a sighting landed on the wrong doorway.<br /><br />' +
        'Check the two dots against the drawing, then <strong>Re-calibrate</strong> ' +
        'and sight two doorways as far apart as you can find.',
      'warn',
    );
    return;
  }

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
 * Recomputes every anchor from the sighting it came from.
 *
 * Run when the handedness changes, and when a node moves on the plan: both
 * change what a sighting means without changing the sighting itself. Nodes
 * anchored before sightings were recorded are left alone — there is nothing to
 * recompute them from, and guessing would be worse than leaving them.
 */
function reanchorFromSightings() {
  let redone = 0;

  for (const [node, entry] of alignment) {
    const sight = entry.sight;
    if (!sight || !hasPoint(node)) continue;

    const to = Number(sight.target);
    if (!hasPoint(to)) continue;

    const planNorth = round(
      planNorthFromSighting({
        observedYaw: sight.raw,
        pan: 0,
        bearing: planBearing(tour.nodes[pad(node)].map, tour.nodes[pad(to)].map),
        mirrored,
      }),
    );

    alignment.set(node, { ...entry, pan: planNorth, planNorth });
    redone++;
  }

  if (redone) {
    dirty = true;
    toast(`Re-derived ${redone} anchor(s)`);
  }

  return redone;
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

  const planNorth = planNorthFromSighting({ ...sightings[0], mirrored });
  const node = current;
  const before = alignment.get(node) ?? null;

  // pan is set to the anchor so the sphere opens plan-aligned: yaw 0 looks at
  // the top of the drawing. That also puts the mini-map's facing cone the right
  // way round, which "any consistent direction" never guaranteed.
  // The sighting is kept, not just what it produced. It is the measurement; the
  // anchor is a conclusion drawn from it and from the tour's handedness, and
  // keeping the measurement means either of those can change without anyone
  // having to stand in this node again.
  alignment.set(node, {
    pan: round(planNorth),
    planNorth: round(planNorth),
    sight: { raw: round(rawAngle(sightings[0].observedYaw, sightings[0].pan)), target: pad(sightings[0].target) },
  });

  if (!(await persist())) {
    if (before) alignment.set(node, before);
    else alignment.delete(node);
    return;
  }

  remember(`anchor ${pad(node)}`, async () => {
    if (before) alignment.set(node, before);
    else alignment.delete(node);
    await persist({ quiet: true });
    if (current === node) await openNode(node);
  });

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

/**
 * Writes the anchors and the edge list.
 *
 * Both together: links drawn here change which neighbours can be sighted, so
 * saving one without the other leaves a tour whose anchors refer to
 * connections that were never recorded.
 */
async function persist({ quiet = false } = {}) {
  const payload = {};
  for (const n of NODES) {
    const entry = alignment.get(n);
    payload[pad(n)] = entry
      ? {
          pan: entry.pan,
          ...(entry.planNorth === null ? {} : { planNorth: entry.planNorth }),
          ...(entry.sight ? { sight: entry.sight } : {}),
        }
      : { pan: 0, todo: true };
  }

  const result = await saveData('alignment', payload);
  if (!result.ok) {
    downloadJson('alignment.json', payload);
    toast('API unreachable — downloaded instead', 'error');
    return false;
  }

  const edges = await saveData('links', links);
  if (!edges.ok) {
    downloadJson('links.json', links);
    toast('Links could not be saved — downloaded instead', 'error');
    return false;
  }

  if (mapDirty) {
    const points = await saveData('nodes', tour);
    if (!points.ok) {
      downloadJson('nodes.json', tour);
      toast('Map points could not be saved — downloaded instead', 'error');
      return false;
    }
    mapDirty = false;
  }

  // The handedness belongs to the tour, not to a node, and it is only measured
  // once. Written on the first save so a later session does not re-ask.
  if (handednessMeasured && tourData.config.mirrored !== mirrored) {
    tourData.config.mirrored = mirrored;
    await saveData('tour', tourData.config);
  }

  dirty = false;
  syncChrome();

  if (!quiet) toast(`Anchored ${pad(current)}`);
  return true;
}

/**
 * Writes everything without anchoring anything.
 *
 * Placing and linking are most of the work here and neither of them needs a
 * sighting, so they must not be held hostage to one — least of all during
 * calibration, which refuses to save until two doorways have been sighted.
 */
async function saveEverything() {
  el.saveAll.disabled = true;

  const ok = await persist({ quiet: true });
  el.saveAll.disabled = false;

  if (ok) toast(`Saved — ${NODES.filter(hasPoint).length} placed, ${links.edges.length} links`);
}

/* ------------------------------------------------------------------ *
 * Linking
 * ------------------------------------------------------------------ */

/**
 * Connects the current node to any other, or disconnects them.
 *
 * Any node to any node: numbering says nothing about what is walkable. Node 01
 * next to node 37 is a doorway if the building says so, and the roster having
 * gaps in it changes nothing.
 */
function toggleLink(other) {
  if (other === current) return;

  const [a, b] = [current, other].sort((x, y) => x - y);
  const at = links.edges.findIndex(([x, y]) => x === a && y === b);

  if (at === -1) {
    links.edges.push([a, b]);
    links.edges.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    remember(`link ${pad(a)}–${pad(b)}`, () => {
      const undoAt = links.edges.findIndex(([x, y]) => x === a && y === b);
      if (undoAt !== -1) links.edges.splice(undoAt, 1);
    });
    dirty = true;
    toast(`Linked ${pad(a)} ↔ ${pad(b)}`);
  } else {
    const [removed] = links.edges.splice(at, 1);
    remember(`unlink ${pad(a)}–${pad(b)}`, () => {
      links.edges.push(removed);
      links.edges.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    });
    dirty = true;
    toast(`Unlinked ${pad(a)} ↔ ${pad(b)}`);
  }

  buildTargetOptions();
  setEnabled(true);
  drawPlan();
  syncChrome();
  // The new link's arrow appears the moment it is drawn, if the node is
  // anchored. That is the answer to "did that do anything".
  syncArrows();
}

/**
 * Creates a node where the plan was clicked.
 *
 * A shooting point nobody has a node for turns up while walking the tour, not
 * while looking at a list, so it can be added from here too.
 */
async function addNodeHere(point) {
  // Adding rewrites the roster on disk and the reload below replaces what is in
  // memory, so anything unsaved goes out first rather than being lost.
  if (!(await persist({ quiet: true }))) return;

  const result = await post('/add-node-at', { x: Math.round(point.x), y: Math.round(point.y) });
  if (result.error) {
    toast(result.error, 'error');
    return;
  }

  tourData = await loadTourData();
  NODES = tourData.numbers();
  tour = await loadNodes();
  links = (await loadLinks()) ?? { edges: [] };

  buildNodeOptions();
  await openNode(Number(result.node));
  setMode('link');
  toast(`Added ${result.node} — now link it to something`);
}

/**
 * Puts the current node where the plan was clicked.
 *
 * Here as well as in the map tool, because realising a node is not on the plan
 * happens while you are standing in it looking for something to sight.
 */
function placeHere(point) {
  const node = current;
  const id = pad(node);
  const before = tour.nodes[id]?.map ? { ...tour.nodes[id].map } : null;

  tour.nodes[id] ??= { id, links: [] };
  tour.nodes[id].map = { x: Math.round(point.x), y: Math.round(point.y) };
  mapDirty = true;
  dirty = true;

  remember(`place ${id}`, () => {
    if (before) tour.nodes[id].map = before;
    else delete tour.nodes[id].map;
    mapDirty = true;
  });

  buildTargetOptions();
  setEnabled(true);
  drawPlan();
  syncChrome();
  syncArrows();
  toast(`Placed ${id}`);
}

/** The node whose dot covers a point on the plan, if any. */
function nodeAt(point) {
  const reach = Math.max(14, el.plan.naturalWidth / 90);

  for (const n of NODES) {
    const p = tour.nodes[pad(n)]?.map;
    if (!p) continue;
    if (Math.hypot(p.x - point.x, p.y - point.y) <= reach) return n;
  }

  return null;
}

function onPlanClick(event) {
  const rect = el.plan.getBoundingClientRect();
  const point = {
    x: ((event.clientX - rect.left) / rect.width) * el.plan.naturalWidth,
    y: ((event.clientY - rect.top) / rect.height) * el.plan.naturalHeight,
  };

  // Add and Place act on the point itself — an empty patch of plan is exactly
  // where a node goes, so they must not require a dot under the cursor.
  if (mode === 'add') return addNodeHere(point);
  if (mode === 'place') return placeHere(point);

  const hit = nodeAt(point);
  if (hit === null) return;

  if (mode === 'link') return toggleLink(hit);

  // In sight mode a dot is a quicker way to choose the target than the list.
  if (targets().includes(hit)) {
    el.target.value = String(hit);
    drawPlan();
    syncHint();
    syncArrows();
  }
}

function setMode(next) {
  mode = next;
  for (const button of el.modes) button.classList.toggle('is-on', button.dataset.mode === mode);
  el.target.hidden = mode !== 'sight';
  el.record.hidden = mode !== 'sight';
  drawPlan();
  syncHint();
}

/* ------------------------------------------------------------------ *
 * The photo library
 * ------------------------------------------------------------------ */

/**
 * Gives the current node a photograph without going back to the studio.
 *
 * A node with no picture cannot be sighted at all, and finding that out is
 * something that happens here — so the fix is here too.
 */
async function openLibrary() {
  el.library.hidden = false;
  el.libraryNode.textContent = pad(current);
  el.libraryStrip.innerHTML = '<p class="library__empty">Loading…</p>';

  const photos = await fetchPhotos();

  if (!photos.length) {
    el.libraryStrip.innerHTML =
      '<p class="library__empty">No photographs found. Check the tour\u2019s ' +
      '<code>rawDir</code> in its tour.json.</p>';
    return;
  }

  el.libraryStrip.innerHTML = photos
    .map(
      (photo) => `
      <figure class="chip ${photo.node === pad(current) ? 'is-current' : ''}"
              data-file="${escapeHtml(photo.file)}"
              title="${photo.node ? `currently node ${photo.node}` : 'unassigned'}">
        <img src="${withTour('/preview', { file: photo.file })}" alt="" loading="lazy" />
        <figcaption>${escapeHtml(photo.file)}${photo.node ? ` · ${photo.node}` : ''}</figcaption>
      </figure>`,
    )
    .join('');

  for (const chip of el.libraryStrip.children) {
    chip.addEventListener?.('click', () => assignPhoto(chip.dataset.file));
  }
}

async function fetchPhotos() {
  try {
    const response = await fetch(withTour('/photos'));
    const data = await response.json();
    return data.photos ?? [];
  } catch {
    return [];
  }
}

/**
 * Assigns a photograph and builds it.
 *
 * Assigning alone would leave the node pointing at a file with no renditions,
 * which reads exactly like a broken node, so the pipeline runs before the
 * panorama is reloaded.
 */
async function assignPhoto(file) {
  const node = current;
  const previous = (await fetchPhotos()).find((p) => p.node === pad(node))?.file ?? null;

  el.libraryStrip.querySelectorAll('.chip').forEach((c) => c.classList.add('is-busy'));
  toast(`Assigning ${file}…`);

  const assigned = await post('/assign', { node, file });
  if (assigned.error) {
    toast(assigned.error, 'error');
    return;
  }

  toast('Building renditions…');
  const built = await post('/process', { node });

  if (built.ok === false || built.error) {
    showStatus(
      `<strong>Could not build node ${pad(node)}.</strong><br /><br /><code>${escapeHtml(
        built.error ?? built.output ?? '',
      )}</code>`,
      'error',
    );
    return;
  }

  remember(`photo ${file} → ${pad(node)}`, async () => {
    await post('/assign', { node, file: previous });
    if (previous) await post('/process', { node });
    if (current === node) await openNode(node);
  });

  el.library.hidden = true;
  await openNode(node);
  toast(`Node ${pad(node)} now uses ${file}`);
}

/* ------------------------------------------------------------------ *
 * Undo
 * ------------------------------------------------------------------ */

function remember(label, undo) {
  history.push({ label, undo });
  syncUndo();
}

async function undoLast() {
  const step = history.pop();
  if (!step) return;

  el.undo.disabled = true;
  await step.undo();

  buildTargetOptions();
  drawPlan();
  syncChrome();
  syncUndo();
  syncArrows();
  toast(`Undid ${step.label}`);
}

function syncUndo() {
  el.undo.disabled = history.length === 0;
  el.undo.title = history.length
    ? `Undo ${history[history.length - 1].label} (Cmd/Ctrl+Z)`
    : 'Nothing to undo';
}

async function post(endpoint, payload) {
  try {
    const response = await fetch(withTour(endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await response.json();
  } catch (err) {
    return { error: err.message };
  }
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

  // Every connection, so what you are about to link to — and what is already
  // linked — is visible rather than remembered.
  const edges = links.edges
    .map(([a, b]) => {
      const p = tour.nodes[pad(a)]?.map;
      const q = tour.nodes[pad(b)]?.map;
      if (!p || !q) return '';
      const here = a === current || b === current;
      return `<line class="plan-edge ${here ? 'is-live' : ''}"
                    x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}"
                    stroke-width="${here ? r / 2 : r / 3}" />`;
    })
    .join('');

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

  el.overlay.innerHTML = edges + sightLines + aim + dots;
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
  el.saveAll.classList.toggle('btn--primary', dirty);
  el.saveAll.textContent = dirty ? 'Save •' : 'Save';
  el.recalibrate.hidden = mirrored === null;
  el.progress.textContent = `${anchored}/${NODES.length} anchored`;
  el.progress.dataset.complete = String(anchored === NODES.length);

  syncHint();
}

function syncHint() {
  if (mode === 'add') {
    el.hint.innerHTML =
      'Click the plan to create a node there. It arrives with no photograph and ' +
      'no links, and drops you into <strong>Link</strong> so it does not stay ' +
      'stranded.';
    return;
  }

  if (mode === 'place') {
    el.hint.innerHTML =
      `Click the plan where <strong>${pad(current)}</strong> was photographed. ` +
      'Everything else here is measured off that position, so it is worth being exact.';
    return;
  }

  if (mode === 'link') {
    el.hint.innerHTML =
      `Click any node on the plan to connect it to <strong>${pad(current)}</strong>, ` +
      'or click a connected one to break the link. Any node to any node — the ' +
      'numbers mean nothing here.';
    return;
  }

  if (!hasPoint(current)) {
    el.hint.innerHTML =
      '<strong>Not on the plan.</strong> Place it in the map tool first — ' +
      'there is no bearing without a position.';
    return;
  }

  if (!targets().length) {
    const count = neighbours(current).length;
    el.hint.innerHTML =
      `<strong>Nothing to sight from here.</strong> This node ${
        count ? 'connects only to nodes that are not on the plan yet' : 'has no links at all'
      }. Switch to <strong>Link</strong> and click any node on the plan — ` +
      'numbering does not matter, only whether you can walk between them.';
    return;
  }

  if (needsCalibration() && targets().length >= 2 && sightings.length < 2) {
    el.hint.innerHTML =
      `Turn until <strong>${pad(target())}</strong> is on the crosshair, then ` +
      '<strong>Record sighting</strong>. ' +
      `<span class="muted">Sighting a second doorway here (${sightings.length}/2) ` +
      'would also confirm the handedness, which is worth doing once.</span>';
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
  el.target.addEventListener('change', () => { drawPlan(); syncHint(); syncArrows(); });
  el.record.addEventListener('click', record);
  el.save.addEventListener('click', saveAndNext);
  el.skip.addEventListener('click', () => step(1));
  el.undo.addEventListener('click', undoLast);
  el.saveAll.addEventListener('click', saveEverything);
  el.plan.addEventListener('click', onPlanClick);
  el.photo.addEventListener('click', openLibrary);
  el.libraryClose.addEventListener('click', () => { el.library.hidden = true; });

  el.recalibrate.addEventListener('click', () => {
    mirrored = null;
    sightings = [];
    el.calibration.hidden = true;
    hideStatus();
    drawPlan();
    syncChrome();
    toast('Handedness cleared — sight two doorways again');
  });

  for (const button of el.modes) {
    button.addEventListener('click', () => setMode(button.dataset.mode));
  }

  window.addEventListener('resize', fitPlan);

  window.addEventListener('beforeunload', (event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });

  window.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      undoLast();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      saveEverything();
      return;
    }

    if (event.target.matches('input, select')) return;

    if (event.key === 'Escape') { el.library.hidden = true; }
    if (event.key === '1') setMode('sight');
    if (event.key === '2') setMode('place');
    if (event.key === '3') setMode('link');
    if (event.key === '4') setMode('add');
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

  // A node with two placed neighbours is a better place to begin, because
  // sighting both also confirms the handedness. It is a preference, not a
  // requirement — anchoring works from one sighting anywhere.
  if (needsCalibration()) {
    const better = NODES.find((n) => targets(n).length >= 2 && !isAnchored(n));
    if (better !== undefined) return better;
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
