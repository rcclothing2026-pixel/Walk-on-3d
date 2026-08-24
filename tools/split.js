/**
 * Two tools, side by side, on the same node.
 *
 * Aligning a node and placing it on the plan are the same decision seen from
 * two directions: which way the camera was facing, and where it was standing.
 * Doing them in separate tabs means carrying the answer in your head across a
 * page load, which is exactly where it gets lost.
 *
 * Each pane is the real tool in a frame, not a reimplementation. They keep
 * their own viewer, their own floor plan and their own save path; the only
 * thing that crosses between them is which node is being worked on, and only
 * while "same node" is ticked.
 */

import { tourLink, tourSlug, API } from './save.js';
import { escapeHtml } from './lib.js';
import { CHANNEL } from './frame.js';

const TOOLS = [
  { id: 'design', label: 'Initial design — anchor', href: '/tour/tools/design.html' },
  { id: 'align', label: 'Align — set north', href: '/tour/tools/align.html' },
  { id: 'hotspots', label: 'Arrows — aim them', href: '/tour/tools/hotspots.html' },
  { id: 'map', label: 'Map — place on plan', href: '/tour/tools/map.html' },
  { id: 'tour', label: 'Tour — walk it', href: '/tour/' },
];

const el = {
  studio: document.getElementById('studio'),
  tour: document.getElementById('tour'),
  left: document.getElementById('left'),
  right: document.getElementById('right'),
  leftTool: document.getElementById('left-tool'),
  rightTool: document.getElementById('right-tool'),
  swap: document.getElementById('swap'),
  sync: document.getElementById('sync'),
  nodeLabel: document.getElementById('node-label'),
  panes: document.getElementById('panes'),
  divider: document.getElementById('divider'),
};

const params = new URLSearchParams(location.search);

let node = Number(params.get('node')) || 1;
let sides = {
  left: pick(params.get('left'), 'align'),
  right: pick(params.get('right'), 'map'),
};

start();

function start() {
  el.studio.href = tourLink('/tour/tools/studio.html');

  for (const select of [el.leftTool, el.rightTool]) {
    select.innerHTML = TOOLS.map((t) => `<option value="${t.id}">${t.label}</option>`).join('');
  }

  loadTours();
  wire();
  render();
}

function wire() {
  el.leftTool.addEventListener('change', () => {
    sides.left = el.leftTool.value;
    render();
  });

  el.rightTool.addEventListener('change', () => {
    sides.right = el.rightTool.value;
    render();
  });

  el.swap.addEventListener('click', () => {
    sides = { left: sides.right, right: sides.left };
    render();
  });

  el.tour.addEventListener('change', () => {
    const url = new URL(location.href);
    url.searchParams.set('tour', el.tour.value);
    url.searchParams.delete('node');
    location.href = url.toString();
  });

  window.addEventListener('message', onPaneMessage);
  wireDivider();
}

/**
 * A pane moved to a node; put the other one there too.
 *
 * The frame that sent it is skipped, so the two cannot bounce a node back and
 * forth. Panes also guard against being told to go where they already are.
 */
function onPaneMessage(event) {
  if (event.origin !== location.origin || event.data?.channel !== CHANNEL) return;

  // A pane that has just finished loading is moved to the node this page is
  // on, rather than being allowed to drag the other pane to wherever it
  // happened to open.
  if (event.data.type === 'ready') {
    if (el.sync.checked && Number(event.data.node) !== node) {
      event.source?.postMessage({ channel: CHANNEL, type: 'goto', node }, location.origin);
    }
    return;
  }

  if (event.data.type !== 'node') return;

  const moved = Number(event.data.node);
  if (!Number.isFinite(moved)) return;

  node = moved;
  el.nodeLabel.textContent = `node ${String(node).padStart(2, '0')}`;
  rememberNode();

  if (!el.sync.checked) return;

  for (const [side, frame] of [['left', el.left], ['right', el.right]]) {
    if (frame.contentWindow === event.source) continue;

    if (sides[side] === 'tour') {
      moveTourPane(frame);
      continue;
    }

    frame.contentWindow?.postMessage(
      { channel: CHANNEL, type: 'goto', node },
      location.origin,
    );
  }
}

/**
 * Moves a pane showing the tour itself.
 *
 * The tour is the finished thing, not a tool — it has no idea this page exists,
 * and teaching it would mean shipping split-view code in the customer's bundle.
 * So it is moved the only way it understands: reloaded at the new node. It also
 * never reports back, so this cannot loop.
 */
function moveTourPane(frame) {
  const src = tourLink('/tour/', { node });

  // Never reload it onto the node it is already showing. Both panes open on
  // the same node, so the other one's first announcement asks for exactly
  // where the tour already is — and reloading there tears down a viewer
  // mid-fetch. With small test panoramas that reload wins the race and nothing
  // shows; with real ones it can abort the load outright.
  if (frame.getAttribute('src') === src) return;

  frame.setAttribute('src', src);
}

function render() {
  el.leftTool.value = sides.left;
  el.rightTool.value = sides.right;
  el.nodeLabel.textContent = `node ${String(node).padStart(2, '0')}`;

  setPane(el.left, sides.left);
  setPane(el.right, sides.right);
  rememberNode();
}

/** Only reloads a pane when its tool actually changed. */
function setPane(frame, tool) {
  const entry = TOOLS.find((t) => t.id === tool) ?? TOOLS[0];
  const src = tourLink(entry.href, { node });
  if (frame.getAttribute('src') !== src) frame.setAttribute('src', src);
}

/** Keeps the address bar current, so a reload or a bookmark lands back here. */
function rememberNode() {
  const url = new URL(location.href);
  url.searchParams.set('tour', tourSlug());
  url.searchParams.set('node', String(node));
  url.searchParams.set('left', sides.left);
  url.searchParams.set('right', sides.right);
  history.replaceState(null, '', url);
}

async function loadTours() {
  try {
    const response = await fetch(`${API}/tours`);
    const { tours = [] } = await response.json();

    el.tour.innerHTML = tours
      .map(
        (entry) =>
          `<option value="${entry.slug}" ${entry.slug === tourSlug() ? 'selected' : ''}>` +
          `${escapeHtml(entry.title || entry.slug)}</option>`,
      )
      .join('');
    el.tour.disabled = tours.length < 2;
  } catch {
    el.tour.disabled = true;
  }
}

/**
 * Drag the bar between the panes.
 *
 * Frames swallow pointer events, so they are switched off for the duration of
 * the drag — without that, the pointer is lost the moment it crosses into one.
 */
function wireDivider() {
  let dragging = false;

  el.divider.addEventListener('pointerdown', (event) => {
    dragging = true;
    el.divider.setPointerCapture(event.pointerId);
    el.panes.classList.add('is-dragging');
  });

  el.divider.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const rect = el.panes.getBoundingClientRect();
    const share = ((event.clientX - rect.left) / rect.width) * 100;
    el.panes.style.setProperty('--split', `${Math.min(85, Math.max(15, share))}%`);
  });

  const end = (event) => {
    if (!dragging) return;
    dragging = false;
    el.divider.releasePointerCapture(event.pointerId);
    el.panes.classList.remove('is-dragging');
  };

  el.divider.addEventListener('pointerup', end);
  el.divider.addEventListener('pointercancel', end);
}

function pick(value, fallback) {
  return TOOLS.some((t) => t.id === value) ? value : fallback;
}
