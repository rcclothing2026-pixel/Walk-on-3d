/**
 * Map point picker.
 *
 * The mini-map needs an x/y per node measured on the floor plan. Without them
 * Photo Sphere Viewer's map plugin cannot draw at all — its renderer bails out
 * when the current node has no centre — so the tour hides the map entirely
 * until these exist.
 *
 * Coordinates are in the floor plan's own pixel space (its natural size), which
 * is what the map plugin expects, so they stay correct if the plan is later
 * re-exported at a different display size.
 *
 * Click the plan to place the selected node; placing jumps to the next unplaced
 * node so the list can be worked straight through. Download writes the merged
 * nodes.json and links.json into the tour's own folder.
 */

import { floorplanUrl, dataUrl, nodeId as pad } from '../src/lib/paths.js';
import { loadTourData } from '../src/lib/tour-data.js';
import { downloadJson, saveData, postTour } from './save.js';
import {
  escapeHtml,
  hideStatus,
  initialNode,
  nodeOptions,
  showStatus,
  toast,
} from './lib.js';
import { mountNav } from './nav.js';
import { announceNode, connectFrame } from './frame.js';

let NODES = [];
let tourData = null;

const el = {
  stage: document.getElementById('stage'),
  wrap: document.getElementById('plan-wrap'),
  plan: document.getElementById('plan'),
  overlay: document.getElementById('overlay'),
  node: document.getElementById('node'),
  prev: document.getElementById('prev'),
  next: document.getElementById('next'),
  name: document.getElementById('node-name'),
  type: document.getElementById('node-type'),
  coords: document.getElementById('node-coords'),
  progress: document.getElementById('progress'),
  placedCount: document.getElementById('placed-count'),
  list: document.getElementById('node-list'),
  download: document.getElementById('download'),
  zoom: document.getElementById('zoom'),
  zoomValue: document.getElementById('zoom-value'),
  fit: document.getElementById('fit'),
  clearNode: document.getElementById('clear-node'),
  rebuild: document.getElementById('rebuild'),
  upload: document.getElementById('upload'),
  file: document.getElementById('file'),
  showLinks: document.getElementById('show-links'),
  hint: document.getElementById('hint'),
  modes: [...document.querySelectorAll('[data-mode]')],
  status: document.getElementById('status'),
};

let tour = null;
let links = { edges: [] };
let current = 1;
let scale = 1;

/**
 * What a click on the plan does.
 *
 *   place — position the selected node (the original behaviour)
 *   add   — create a node where you clicked
 *   link  — connect two nodes by clicking each in turn
 *
 * Modes rather than modifier keys because placing 40 nodes and then drawing 50
 * connections are two separate passes, not two things you alternate between.
 */
let mode = 'place';

/** The first node of a link being drawn, if any. */
let linkFrom = null;

/** Whether anything has been placed or linked since the last successful save. */
let dirty = false;

start();

async function start() {
  mountNav({ tool: 'map', node: () => current });
  tourData = await loadTourData();
  NODES = tourData.numbers();

  tour = await loadTour();
  links = (await loadLinks()) ?? { edges: [] };
  current = initialNode();

  // An empty venue has nothing to place, so the only useful click is one that
  // creates a node. Starting in Add rather than Place saves the operator from
  // wondering why clicking the plan does nothing.
  if (!NODES.length) mode = 'add';

  buildNodeOptions();
  wireControls();
  wireKeyboard();
  wireUnloadGuard();
  await loadPlan();

  redraw();

  // Last: a pane must know its roster before the split view can move it.
  connectFrame({ current: () => current, goto: selectNode });
}

/**
 * The generated graph, or an empty one.
 *
 * A tour that has never been built has no nodes.json, and that is the normal
 * state for a venue being set up here — the whole point of this page is to
 * produce the map points and links a first build needs.
 */
async function loadTour() {
  try {
    const response = await fetch(dataUrl('nodes'));
    if (!response.ok) throw new Error(String(response.status));
    const data = await response.json();
    return { ...data, nodes: data.nodes ?? {} };
  } catch {
    return { nodes: {} };
  }
}

/**
 * Shows a floor plan, and reports whether there was one to show.
 *
 * A missing plan is a normal starting state rather than an error — the
 * footer's upload button is how a venue gets one — so it is reported here
 * instead of stopping the page.
 */
function loadPlan(src = floorplanUrl()) {
  return new Promise((resolve) => {
    const settle = (ok) => {
      el.plan.removeEventListener('load', onLoad);
      el.plan.removeEventListener('error', onError);
      resolve(ok);
    };

    const onLoad = () => {
      hideStatus(el.status);
      fitToWindow();
      settle(true);
    };

    const onError = () => {
      showStatus(
        el.status,
        '<strong>No floor plan yet.</strong><br /><br />' +
          'Use <strong>Floor plan…</strong> below to upload the venue plan — ' +
          'a PNG, a JPG, or the architect\u2019s PDF.',
      );
      settle(false);
    };

    el.plan.addEventListener('load', onLoad);
    el.plan.addEventListener('error', onError);
    el.plan.src = src;
  });
}

/** The tour's edge list. A tour that has never been linked has none. */
async function loadLinks() {
  try {
    const response = await fetch(dataUrl('links'));
    return response.ok ? await response.json() : { edges: [] };
  } catch {
    return { edges: [] };
  }
}

/* ------------------------------------------------------------------ *
 * Placing
 * ------------------------------------------------------------------ */

/**
 * Converts a click to floor-plan pixel coordinates.
 *
 * Uses the image's natural size rather than its rendered size, so the numbers
 * survive a zoom change here and a different display size in the viewer.
 */
function pointFromEvent(event) {
  const rect = el.plan.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * el.plan.naturalWidth;
  const y = ((event.clientY - rect.top) / rect.height) * el.plan.naturalHeight;

  if (x < 0 || y < 0 || x > el.plan.naturalWidth || y > el.plan.naturalHeight) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

/** Routes a click on the plan according to the current mode. */
async function onPlanClick(event) {
  const point = pointFromEvent(event);
  if (!point) return;

  const hit = nodeAt(point);

  if (mode === 'link') return toggleLink(hit);
  if (mode === 'add') return addNodeHere(point);

  // Clicking an existing dot selects it rather than moving the current node on
  // top of it — otherwise a mis-aimed click silently stacks two nodes.
  if (hit && hit !== current) {
    current = hit;
    redraw();
    return;
  }

  nodeData().map = point;
  dirty = true;
  redraw();
  advanceToNextUnplaced();
}

/** The node whose dot covers a point, if any. */
function nodeAt(point) {
  const reach = Math.max(14, 18 / scale);

  for (const n of NODES) {
    const p = tour.nodes[pad(n)]?.map;
    if (!p) continue;
    if (Math.hypot(p.x - point.x, p.y - point.y) <= reach) return n;
  }

  return null;
}

/** Creates a node where the plan was clicked. */
async function addNodeHere(point) {
  // Adding writes the roster and the graph on the server, and the reload below
  // then replaces whatever is in memory — so anything placed or linked since
  // the last save is written out first rather than thrown away.
  if (!(await saveAll())) return;

  const result = await postTour('/add-node-at', { x: point.x, y: point.y });
  if (result.error) {
    toast(result.error, 'error');
    return;
  }

  // The roster changed on disk, so both it and the graph are re-read rather
  // than patched — the studio may have edited either of them meanwhile.
  tourData = await loadTourData();
  NODES = tourData.numbers();
  tour = await loadTour();
  links = (await loadLinks()) ?? { edges: [] };
  current = Number(result.node);

  buildNodeOptions();
  redraw();
  toast(`Added node ${result.node}`);
}

/**
 * Adds or removes an edge between the last-clicked node and this one.
 *
 * Clicking the same node twice cancels, so a mis-click costs nothing.
 */
function toggleLink(node) {
  if (!node) {
    linkFrom = null;
    redraw();
    return;
  }

  if (linkFrom === null) {
    linkFrom = node;
    redraw();
    return;
  }

  if (linkFrom === node) {
    linkFrom = null;
    redraw();
    return;
  }

  const [a, b] = [linkFrom, node].sort((x, y) => x - y);
  const index = links.edges.findIndex(([x, y]) => x === a && y === b);

  if (index === -1) {
    links.edges.push([a, b]);
    links.edges.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    toast(`Linked ${pad(a)} ↔ ${pad(b)}`);
  } else {
    links.edges.splice(index, 1);
    toast(`Unlinked ${pad(a)} ↔ ${pad(b)}`);
  }

  linkFrom = null;
  dirty = true;
  redraw();
}

function redraw() {
  renderList();
  renderOverlay();
  syncChrome();
}

/** Keeps the operator moving down the list rather than re-selecting by hand. */
function advanceToNextUnplaced() {
  const start = NODES.indexOf(current);
  for (let i = 1; i <= NODES.length; i++) {
    const candidate = NODES[(start + i) % NODES.length];
    if (!isPlaced(candidate)) {
      current = candidate;
      renderList();
      renderOverlay();
      syncChrome();
      return;
    }
  }
}

function isPlaced(node) {
  const point = tour.nodes[pad(node)]?.map;
  return Number.isFinite(point?.x) && Number.isFinite(point?.y);
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function renderOverlay() {
  const { naturalWidth: w, naturalHeight: h } = el.plan;
  if (!w) return;

  el.overlay.setAttribute('viewBox', `0 0 ${w} ${h}`);

  // Radius in plan pixels, kept visually constant as the view zooms.
  const r = Math.max(6, 9 / scale);

  const edges = el.showLinks.checked
    ? links.edges
        .map(([a, b]) => {
          const p = tour.nodes[pad(a)]?.map;
          const q = tour.nodes[pad(b)]?.map;
          if (!p || !q) return '';
          const live = a === linkFrom || b === linkFrom;
          return `<line class="plan-edge ${live ? 'is-live' : ''}"
                        x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}"
                        stroke-width="${Math.max(1.5, 2.5 / scale)}" />`;
        })
        .join('')
    : '';

  const dots = NODES.filter(isPlaced)
    .map((n) => {
      const { x, y } = tour.nodes[pad(n)].map;
      const active = n === current;
      const pending = n === linkFrom;
      return `
        <g class="plan-dot ${active ? 'is-active' : ''} ${pending ? 'is-pending' : ''}">
          <circle cx="${x}" cy="${y}" r="${active ? r * 1.5 : r}" />
          <text x="${x}" y="${y - r * 2}" font-size="${r * 2.2}">${pad(n)}</text>
        </g>`;
    })
    .join('');

  el.overlay.innerHTML = edges + dots;
}

function renderList() {
  el.list.innerHTML = NODES.map((n) => {
    const { name } = tourData.info(n);
    const point = tour.nodes[pad(n)]?.map;
    const placed = isPlaced(n);

    return `
      <li class="link ${n === current ? 'is-active' : ''}" data-node="${n}">
        <span class="link__id">${pad(n)}</span>
        <span class="link__name" dir="rtl">${escapeHtml(name)}</span>
        <span class="link__angles ${placed ? '' : 'is-bad'}">
          ${placed ? `${point.x}, ${point.y}` : 'not placed'}
        </span>
      </li>`;
  }).join('');

  for (const row of el.list.children) {
    row.addEventListener('click', () => {
      current = Number(row.dataset.node);
      renderList();
      renderOverlay();
      syncChrome();
    });
  }
}

function syncChrome() {
  const empty = !NODES.length;

  // Keeps the other pane of the split view on the same node. Inert otherwise.
  if (!empty) announceNode(current);
  const { name, type } = empty ? { name: '', type: '' } : tourData.info(current);
  const point = tour.nodes[pad(current)]?.map;
  const placed = NODES.filter(isPlaced).length;

  el.node.value = empty ? '' : String(current);
  el.name.textContent = empty ? 'No nodes yet' : name;
  el.type.textContent = type;
  el.coords.textContent = point ? `${point.x}, ${point.y}` : empty ? '' : 'not placed';

  // Everything that acts on the selected node is meaningless without one.
  for (const control of [el.node, el.prev, el.next, el.clearNode]) control.disabled = empty;
  el.modes.find((b) => b.dataset.mode === 'place').disabled = empty;
  el.modes.find((b) => b.dataset.mode === 'link').disabled = NODES.length < 2;

  if (!empty) {
    el.prev.disabled = NODES.indexOf(current) === 0;
    el.next.disabled = NODES.indexOf(current) === NODES.length - 1;
  }

  el.progress.textContent = `${placed}/${NODES.length} placed · ${links.edges.length} links`;
  el.progress.dataset.complete = String(placed === NODES.length && links.edges.length > 0);
  el.placedCount.textContent = `${placed}/${NODES.length}`;

  for (const button of el.modes) button.classList.toggle('is-on', button.dataset.mode === mode);

  el.hint.innerHTML = empty
    ? 'Click the plan in <strong>Add</strong> mode to create the first node.'
    : {
        place:
          'Click the plan to position the selected node. Placing advances to the next unplaced one.',
        add: 'Click anywhere on the plan to create a node there.',
        link: linkFrom
          ? `Now click the node to connect to <strong>${pad(linkFrom)}</strong>. Click it again to cancel.`
          : 'Click a node, then the node it connects to. Clicking an existing link removes it.',
      }[mode];

  el.list.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
}

/* ------------------------------------------------------------------ *
 * View
 * ------------------------------------------------------------------ */

function setScale(next) {
  scale = Math.min(4, Math.max(0.4, next));
  el.wrap.style.width = `${el.plan.naturalWidth * scale}px`;
  el.zoom.value = String(Math.round(scale * 100));
  el.zoomValue.textContent = `${Math.round(scale * 100)}%`;
  renderOverlay();
}

function fitToWindow() {
  const pad = 40;
  const available = {
    w: el.stage.clientWidth - pad,
    h: el.stage.clientHeight - pad,
  };
  const fit = Math.min(available.w / el.plan.naturalWidth, available.h / el.plan.naturalHeight);
  setScale(fit);
  renderOverlay();
}

/* ------------------------------------------------------------------ *
 * Controls
 * ------------------------------------------------------------------ */

function wireControls() {
  // A click that ends a drag must not drop a point.
  let dragged = false;
  let origin = null;

  el.stage.addEventListener('pointerdown', (event) => {
    dragged = false;
    origin = { x: event.clientX, y: event.clientY, l: el.stage.scrollLeft, t: el.stage.scrollTop };
  });

  el.stage.addEventListener('pointermove', (event) => {
    if (!origin || event.buttons !== 1) return;
    const dx = event.clientX - origin.x;
    const dy = event.clientY - origin.y;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) dragged = true;
    if (dragged) {
      el.stage.scrollLeft = origin.l - dx;
      el.stage.scrollTop = origin.t - dy;
    }
  });

  el.stage.addEventListener('pointerup', () => {
    origin = null;
  });

  el.plan.addEventListener('click', (event) => {
    if (!dragged) onPlanClick(event);
  });

  el.node.addEventListener('change', () => {
    current = Number(el.node.value);
    renderList();
    renderOverlay();
    syncChrome();
  });

  el.prev.addEventListener('click', () => step(-1));
  el.next.addEventListener('click', () => step(1));

  el.zoom.addEventListener('input', () => setScale(Number(el.zoom.value) / 100));
  el.fit.addEventListener('click', fitToWindow);

  el.clearNode.addEventListener('click', clearCurrent);
  el.rebuild.addEventListener('click', rebuild);
  el.showLinks.addEventListener('change', renderOverlay);

  for (const button of el.modes) {
    button.addEventListener('click', () => setMode(button.dataset.mode));
  }

  el.upload.addEventListener('click', () => el.file.click());
  el.file.addEventListener('change', () => uploadPlan(el.file.files?.[0]));

  el.download.addEventListener('click', saveAll);

  window.addEventListener('resize', renderOverlay);
}

function wireKeyboard() {
  window.addEventListener('keydown', (event) => {
    if (event.target.matches('input, select')) return;

    switch (event.key) {
      case 'PageUp':
        event.preventDefault();
        step(-1);
        break;
      case 'PageDown':
        event.preventDefault();
        step(1);
        break;
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        clearCurrent();
        break;
      case '1':
        setMode('place');
        break;
      case '2':
        setMode('add');
        break;
      case '3':
        setMode('link');
        break;
      case 'Escape':
        linkFrom = null;
        redraw();
        break;
      default:
    }
  });
}

function wireUnloadGuard() {
  window.addEventListener('beforeunload', (event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

/** Selects a node without moving it — what the other pane asks for. */
function selectNode(node) {
  if (!NODES.includes(node)) return;
  current = node;
  redraw();
}

function step(delta) {
  const index = NODES.indexOf(current) + delta;
  if (index < 0 || index >= NODES.length) return;
  current = NODES[index];
  renderList();
  renderOverlay();
  syncChrome();
}

function clearCurrent() {
  delete nodeData().map;
  dirty = true;
  renderList();
  renderOverlay();
  syncChrome();
}

function setMode(next) {
  if (next === 'place' && !NODES.length) return;
  if (next === 'link' && NODES.length < 2) return;
  mode = next;
  linkFrom = null;
  redraw();
}

/**
 * Turns the drawn links into arrows.
 *
 * The graph and the generated node file are separate on purpose — links are
 * what a human draws, arrows are derived from them — so drawing has to be
 * followed by a rebuild for the tour to change.
 */
async function rebuild() {
  el.rebuild.disabled = true;
  toast('Rebuilding…');

  const saved = await saveAll();
  if (!saved) {
    el.rebuild.disabled = false;
    return;
  }

  const result = await postTour('/rebuild', {});
  el.rebuild.disabled = false;

  if (result.error || result.ok === false) {
    showStatus(
      el.status,
      `<strong>Rebuild failed.</strong><br /><br /><code>${escapeHtml(
        result.error ?? result.output ?? '',
      )}</code>`,
      'error',
    );
    return;
  }

  tour = await loadTour();
  redraw();
  toast('Arrows rebuilt');
}

/** Replaces the floor plan with an uploaded image or PDF. */
async function uploadPlan(file) {
  if (!file) return;
  toast(`Uploading ${file.name}…`);

  const before = { w: el.plan.naturalWidth, h: el.plan.naturalHeight };

  try {
    const response = await fetch(withTour('/floorplan', { name: file.name }), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });

    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? String(response.status));

    // Cache-busted: the filename never changes, so the browser would otherwise
    // keep showing the plan that was just replaced.
    await loadPlan(`${floorplanUrl()}?v=${Date.now()}`);
    offerRescale(before);
    redraw();
    toast('Floor plan ready');
  } catch (err) {
    showStatus(
      el.status,
      `<strong>Could not use that file.</strong><br /><br /><code>${escapeHtml(err.message)}</code>`,
      'error',
    );
  } finally {
    el.file.value = '';
  }
}

/**
 * Offers to move existing points onto a replaced plan.
 *
 * Map points are in the plan's own pixels, so a plan of a different size puts
 * every dot in the wrong place. Offered rather than done silently: the same
 * drawing re-exported scales cleanly, a different drawing does not, and only
 * the operator knows which this is.
 */
function offerRescale(before) {
  const after = { w: el.plan.naturalWidth, h: el.plan.naturalHeight };
  const placed = NODES.filter(isPlaced);

  if (!before.w || !after.w) return;
  if (before.w === after.w && before.h === after.h) return;
  if (!placed.length) return;

  const ok = confirm(
    `The ${placed.length} point(s) already placed were measured on a ${before.w}×${before.h} ` +
      `plan. This one is ${after.w}×${after.h}.\n\n` +
      'OK — scale them to the new plan. Right if this is the same drawing re-exported.\n' +
      'Cancel — leave them, and reposition by hand.',
  );

  if (!ok) return;

  const sx = after.w / before.w;
  const sy = after.h / before.h;

  for (const n of placed) {
    const point = tour.nodes[pad(n)].map;
    point.x = Math.round(point.x * sx);
    point.y = Math.round(point.y * sy);
  }

  dirty = true;
  toast(`Scaled ${placed.length} point(s) to the new plan`);
}

/* ------------------------------------------------------------------ *
 * Output
 * ------------------------------------------------------------------ */

/**
 * Writes the map points and the link graph.
 *
 * Both, always: they are edited in the same pass here, and saving one without
 * the other would leave a plan whose dots and connections disagree.
 */
async function saveAll() {
  const nodesResult = await saveData('nodes', tour);
  const linksResult = await saveData('links', {
    _comment:
      'Which nodes connect to which. Every edge is a pair and is walkable both ways. Drawn in tools/map.html.',
    ...links,
  });

  if (nodesResult.ok && linksResult.ok) {
    dirty = false;
    toast('Saved');
    return true;
  }

  downloadJson('nodes.json', tour);
  downloadJson('links.json', links);
  toast('API unreachable — downloaded instead', 'error');
  return false;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * The graph entry for the selected node, created on demand.
 *
 * Nodes added here exist in the roster before they exist in the graph — the
 * graph is generated — so placing one has to be able to write into a slot the
 * last build never made.
 */
function nodeData() {
  const id = pad(current);
  tour.nodes[id] ??= { id, links: [] };
  return tour.nodes[id];
}

function buildNodeOptions() {
  el.node.innerHTML = nodeOptions(NODES, (n) => tourData.info(n));
}

