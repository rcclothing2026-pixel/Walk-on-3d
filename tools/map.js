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
 * nodes.json over src/data/nodes.json.
 */

import { floorplanUrl, dataUrl } from '../src/lib/paths.js';
import { loadTourData } from '../src/lib/tour-data.js';
import { downloadJson, saveData, tourLink } from './save.js';

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
  copy: document.getElementById('copy'),
  download: document.getElementById('download'),
  zoom: document.getElementById('zoom'),
  zoomValue: document.getElementById('zoom-value'),
  fit: document.getElementById('fit'),
  clearNode: document.getElementById('clear-node'),
  clearAll: document.getElementById('clear-all'),
  status: document.getElementById('status'),
};

let tour = null;
let current = 1;
let scale = 1;

start();

async function start() {
  tourData = await loadTourData();
  NODES = tourData.numbers();
  current = NODES[0] ?? 1;

  tour = await loadTour();
  if (!tour) return;

  current = initialNode();
  buildNodeOptions();
  wireControls();
  wireKeyboard();
  wireUnloadGuard();
  await loadPlan();

  renderList();
  syncChrome();
}

async function loadTour() {
  try {
    const response = await fetch(dataUrl('nodes'));
    if (!response.ok) throw new Error(String(response.status));
    return await response.json();
  } catch {
    showStatus(
      '<strong>No node graph yet.</strong><br /><br />' +
        'Run <code>npm run nodes</code> to generate <code>src/data/nodes.json</code>, then reload.',
      'error',
    );
    return null;
  }
}

function loadPlan() {
  return new Promise((resolve) => {
    el.plan.addEventListener('load', () => {
      fitToWindow();
      resolve();
    }, { once: true });

    el.plan.addEventListener('error', () => {
      showStatus(
        '<strong>No floor plan.</strong><br /><br />' +
          `Expected <code>${floorplanUrl()}</code><br />` +
          'Generate it with <code>npm run floorplan</code>.',
        'error',
      );
      resolve();
    }, { once: true });

    el.plan.src = floorplanUrl();
  });
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

function place(event) {
  const point = pointFromEvent(event);
  if (!point) return;

  nodeData().map = point;
  renderList();
  renderOverlay();
  syncChrome();
  advanceToNextUnplaced();
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

  const dots = NODES.filter(isPlaced)
    .map((n) => {
      const { x, y } = tour.nodes[pad(n)].map;
      const active = n === current;
      return `
        <g class="plan-dot ${active ? 'is-active' : ''}">
          <circle cx="${x}" cy="${y}" r="${active ? r * 1.5 : r}" />
          <text x="${x}" y="${y - r * 2}" font-size="${r * 2.2}">${pad(n)}</text>
        </g>`;
    })
    .join('');

  el.overlay.innerHTML = dots;
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
  const { name, type } = tourData.info(current);
  const point = tour.nodes[pad(current)]?.map;
  const placed = NODES.filter(isPlaced).length;

  el.node.value = String(current);
  el.name.textContent = name;
  el.type.textContent = type;
  el.coords.textContent = placed && point ? `${point.x}, ${point.y}` : 'not placed';

  el.prev.disabled = NODES.indexOf(current) === 0;
  el.next.disabled = NODES.indexOf(current) === NODES.length - 1;

  el.progress.textContent = `${placed}/${NODES.length} placed`;
  el.progress.dataset.complete = String(placed === NODES.length);
  el.placedCount.textContent = `${placed}/${NODES.length}`;

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
    if (!dragged) place(event);
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
  el.clearAll.addEventListener('click', clearAll);

  el.copy.addEventListener('click', copyPoints);
  el.download.addEventListener('click', downloadTour);

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
      default:
    }
  });
}

function wireUnloadGuard() {
  window.addEventListener('beforeunload', (event) => {
    if (!NODES.some(isPlaced)) return;
    event.preventDefault();
    event.returnValue = '';
  });
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
  renderList();
  renderOverlay();
  syncChrome();
}

function clearAll() {
  if (!window.confirm('Remove every placed point?')) return;
  for (const n of NODES) delete tour.nodes[pad(n)]?.map;
  renderList();
  renderOverlay();
  syncChrome();
}

/* ------------------------------------------------------------------ *
 * Output
 * ------------------------------------------------------------------ */

async function copyPoints() {
  const points = Object.fromEntries(
    NODES.filter(isPlaced).map((n) => [pad(n), tour.nodes[pad(n)].map]),
  );
  const json = `${JSON.stringify(points, null, 2)}\n`;

  try {
    await navigator.clipboard.writeText(json);
    toast(`Copied ${Object.keys(points).length} point(s)`);
  } catch {
    console.log(json);
    toast('Clipboard blocked — logged to console', 'error');
  }
}

/** Writes straight to src/data/nodes.json via the studio API. */
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
  return tour.nodes[pad(current)];
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

function toast(message, kind = 'ok') {
  const node = document.createElement('div');
  node.className = 'toast';
  node.dataset.kind = kind;
  node.textContent = message;
  document.body.append(node);
  setTimeout(() => node.remove(), 2000);
}
