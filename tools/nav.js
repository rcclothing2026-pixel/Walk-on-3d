/**
 * The drawer behind the ☰ button.
 *
 * Every tool works on one node at a time, and building a tour means visiting
 * the same node in three of them: set its north, aim its arrows, put it on the
 * plan. Going back to the studio between each was the whole trip — a list of
 * forty rows, find the row again, click the next button along.
 *
 * So the tools carry the studio's per-node actions with them. The drawer knows
 * which node you are on and points everything at that node, in this tour.
 *
 * Switching tool is still a page load. Each tool owns a viewer, a floor plan or
 * a panorama decode, and merging them into one page would mean holding all of
 * that at once to save a reload that takes a moment. What was slow was the
 * navigation, not the load.
 */

import { tourLink, tourSlug, withTour } from './save.js';

const TOOLS = [
  { id: 'align', label: 'Align', href: '/tour/tools/align.html', hint: 'set this node’s north' },
  { id: 'hotspots', label: 'Arrows', href: '/tour/tools/hotspots.html', hint: 'aim its floor arrows' },
  { id: 'map', label: 'Map', href: '/tour/tools/map.html', hint: 'place it on the plan' },
];

/**
 * Replaces a tool's ☰ button with the drawer.
 *
 * @param {object} options
 * @param {'align'|'hotspots'|'map'} options.tool  which tool is mounting it
 * @param {() => number|null} options.node         the node in view, read on open
 */
export function mountNav({ tool, node }) {
  const toggle = document.getElementById('home');
  if (!toggle) return;

  const drawer = build();
  document.body.append(drawer.root);

  // The markup ships a plain link to the studio so the button still does
  // something useful if this module ever fails to load. Now that it has, the
  // click opens the drawer instead.
  toggle.addEventListener('click', (event) => {
    event.preventDefault();
    open();
  });

  drawer.root.addEventListener('click', (event) => {
    if (event.target === drawer.root) close();
  });
  drawer.close.addEventListener('click', close);

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !drawer.root.hidden) close();
  });

  drawer.tours.addEventListener('change', () => {
    const url = new URL(location.href);
    url.searchParams.set('tour', drawer.tours.value);
    url.searchParams.delete('node');
    location.href = url.toString();
  });

  drawer.build.addEventListener('click', () => run(drawer.build, '/process', { node: node() }));
  drawer.rebuild.addEventListener('click', () => run(drawer.rebuild, '/rebuild', {}));

  function open() {
    const current = node();
    render(drawer, { tool, node: current });
    drawer.root.hidden = false;
    drawer.panel.focus();
    loadTours(drawer);
  }

  function close() {
    drawer.root.hidden = true;
    toggle.focus();
  }
}

/** Points every link at the node in view, in this tour. */
function render(drawer, { tool, node }) {
  const params = Number.isFinite(node) ? { node } : {};

  drawer.node.textContent = Number.isFinite(node)
    ? `Node ${String(node).padStart(2, '0')}`
    : 'No node selected';

  drawer.links.innerHTML = TOOLS.map(
    (entry) => `
      <a class="drawer__link ${entry.id === tool ? 'is-current' : ''}"
         href="${tourLink(entry.href, params)}">
        <span class="drawer__link-label">${entry.label}</span>
        <span class="drawer__link-hint">${entry.hint}</span>
      </a>`,
  ).join('');

  drawer.view.href = tourLink('/tour/', params);
  drawer.studio.href = tourLink('/tour/tools/studio.html');
  drawer.build.disabled = !Number.isFinite(node);
  drawer.message.hidden = true;
}

/** The venue switcher. Fetched on open so a tour added meanwhile shows up. */
async function loadTours(drawer) {
  try {
    const response = await fetch('/tour/api/tours');
    const { tours = [] } = await response.json();

    drawer.tours.innerHTML = tours
      .map(
        (entry) =>
          `<option value="${entry.slug}" ${entry.slug === tourSlug() ? 'selected' : ''}>` +
          `${escapeHtml(entry.title || entry.slug)} (${entry.nodes})</option>`,
      )
      .join('');
    drawer.tours.disabled = tours.length < 2;
  } catch {
    // No dev server: the tools still work read-only, so this is not worth an
    // error box. The switcher simply stays as it is.
    drawer.tours.disabled = true;
  }
}

/** Runs one of the studio's actions without leaving the tool. */
async function run(button, endpoint, payload) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Working…';

  try {
    const response = await fetch(withTour(endpoint), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    show(button, result.ok === false || result.error ? 'error' : 'ok',
      result.output || result.error || 'Done.');
  } catch (err) {
    show(button, 'error', err.message);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

function show(button, kind, text) {
  const message = button.closest('.drawer__panel').querySelector('.drawer__message');
  message.dataset.kind = kind;
  message.textContent = text;
  message.hidden = false;
}

function build() {
  const root = document.createElement('div');
  root.className = 'drawer';
  root.hidden = true;
  root.innerHTML = `
    <div class="drawer__panel" role="dialog" aria-label="Tools" tabindex="-1">
      <header class="drawer__head">
        <select class="drawer__tours select" aria-label="Venue"></select>
        <button class="btn drawer__close" aria-label="Close">&times;</button>
      </header>

      <p class="drawer__node"></p>
      <nav class="drawer__links"></nav>

      <div class="drawer__group">
        <a class="btn drawer__wide" target="_blank" rel="noopener"
           data-role="view">Open the tour here ↗</a>
        <button class="btn drawer__wide" data-role="build">Rebuild this photo</button>
        <button class="btn drawer__wide" data-role="rebuild">Rebuild the graph</button>
      </div>

      <p class="drawer__message" hidden></p>

      <footer class="drawer__foot">
        <a class="btn drawer__wide" data-role="studio">All nodes — the studio</a>
      </footer>
    </div>`;

  const pick = (selector) => root.querySelector(selector);

  return {
    root,
    panel: pick('.drawer__panel'),
    close: pick('.drawer__close'),
    tours: pick('.drawer__tours'),
    node: pick('.drawer__node'),
    links: pick('.drawer__links'),
    view: pick('[data-role="view"]'),
    build: pick('[data-role="build"]'),
    rebuild: pick('[data-role="rebuild"]'),
    studio: pick('[data-role="studio"]'),
    message: pick('.drawer__message'),
  };
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );
}
