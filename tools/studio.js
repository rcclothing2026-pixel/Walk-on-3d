/**
 * The studio dashboard.
 *
 * One screen showing, for all 43 nodes, what is done and what is not: photo in
 * raw/, renditions built, alignment recorded, arrows picked, position placed on
 * the plan. Each row links into whichever tool does the next missing step, at
 * that node.
 *
 * State is read fresh from disk on every refresh, so dropping a file into raw/
 * in Finder and pressing Refresh is enough to see it appear.
 *
 * Development only — it talks to the API in scripts/dev-api.js, which is not
 * part of the production build.
 */

import { tourLink, tourSlug, withTour } from './save.js';

const API = '/tour/api';

const el = {
  tour: document.getElementById('tour'),
  newTour: document.getElementById('new-tour'),
  summary: document.getElementById('summary'),
  cards: document.getElementById('cards'),
  rows: document.getElementById('rows'),
  refresh: document.getElementById('refresh'),
  addNode: document.getElementById('add-node'),
  tray: document.getElementById('tray'),
  trayStrip: document.getElementById('tray-strip'),
  trayCount: document.getElementById('tray-count'),
  log: document.getElementById('log'),
  logTitle: document.getElementById('log-title'),
  logBody: document.getElementById('log-body'),
  logClose: document.getElementById('log-close'),
  openTour: document.getElementById('open-tour'),
  split: document.getElementById('split'),
  design: document.getElementById('design'),
  status: document.getElementById('status'),
};

let state = null;
let photos = null;
let tours = [];
let slug = tourSlug();

start();

async function start() {
  el.refresh.addEventListener('click', refresh);
  el.addNode.addEventListener('click', addNode);
  el.newTour.addEventListener('click', createTour);
  el.tour.addEventListener('change', () => selectTour(el.tour.value));
  el.logClose.addEventListener('click', () => (el.log.hidden = true));

  window.addEventListener('keydown', (event) => {
    if (event.target.matches('input, select, textarea')) return;
    if (event.key === 'r' || event.key === 'R') refresh();
    if (event.key === 'Escape') el.log.hidden = true;
  });

  await refresh();
}

async function refresh() {
  el.refresh.disabled = true;

  try {
    await loadTours();
    if (!slug) return;

    const [stateRes, photosRes] = await Promise.all([
      fetch(withTour('/state', { tour: slug })),
      fetch(withTour('/photos', { tour: slug })),
    ]);
    if (!stateRes.ok) throw new Error(String(stateRes.status));

    state = await stateRes.json();
    photos = photosRes.ok ? await photosRes.json() : { photos: [], unassigned: 0 };
    render();
    hideStatus();
  } catch (err) {
    showStatus(
      '<strong>The studio API is not responding.</strong><br /><br />' +
        'It only exists under <code>npm run dev</code>. If the dev server is ' +
        'running, check its console for an error.',
      'error',
    );
    console.error('[studio]', err);
  } finally {
    el.refresh.disabled = false;
  }
}

/**
 * Loads the tour list and settles on one.
 *
 * With several tours the choice has to be explicit and sticky, so it is kept in
 * the URL — that way every link out to a tool carries it, and a reload does not
 * silently land you on a different venue.
 */
async function loadTours() {
  const response = await fetch(`${API}/tours`);
  if (!response.ok) throw new Error(String(response.status));

  tours = (await response.json()).tours ?? [];

  if (!tours.length) {
    el.tour.innerHTML = '';
    showStatus(
      '<strong>No tours yet.</strong><br /><br />Press <strong>+ Tour</strong> to create one.',
    );
    return;
  }

  if (!tours.some((t) => t.slug === slug)) slug = tours[0].slug;

  // Put it in the URL before anything renders — tourLink() reads it from there.
  syncUrl();

  el.tour.innerHTML = tours
    .map(
      (t) =>
        `<option value="${escapeHtml(t.slug)}"${t.slug === slug ? ' selected' : ''}>` +
        `${escapeHtml(t.title)} (${t.nodes})</option>`,
    )
    .join('');

  syncUrl();
  el.openTour.href = tourLink('/tour/');
  el.split.href = tourLink('/tour/tools/split.html');
  el.design.href = tourLink('/tour/tools/design.html');
}

function selectTour(next) {
  slug = next;
  syncUrl();
  refresh();
}

/** Keeps ?tour= in the address bar without stacking history entries. */
function syncUrl() {
  const url = new URL(location.href);
  url.searchParams.set('tour', slug);
  history.replaceState(null, '', url);
}

/** Creates an empty tour: no nodes, no links, ready to be built up. */
async function createTour() {
  const title = window.prompt('Name for the new tour (shown to visitors):');
  if (!title?.trim()) return;

  const suggested = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

  const wanted = window.prompt(
    'Short id — used for the folder and the URL.\nLower-case letters, digits and hyphens.',
    suggested || 'tour',
  );
  if (!wanted?.trim()) return;

  const result = await post('/tours', { slug: wanted.trim(), title: title.trim() });
  if (result.error) {
    openLog('Could not create that tour', result.error);
    return;
  }

  slug = result.slug;
  await refresh();
  openLog(
    `Tour "${result.slug}" created`,
    'It has no nodes yet.\n\n' +
      `1. Put its photographs somewhere and set rawDir in tours/${result.slug}/tour.json\n` +
      '2. Add a floor plan as floorplan.png in that folder\n' +
      '3. Press + Node for each shooting point, then assign photos to them',
  );
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function render() {
  const { totals } = state;

  el.summary.textContent =
    `${totals.processed}/${totals.nodes} built · ` +
    `${totals.aligned}/${totals.nodes} aligned · ` +
    `${totals.linksPicked}/${totals.links} arrows · ` +
    `${totals.mapped}/${totals.nodes} on the map`;

  renderCards(totals);
  renderTray();
  renderRows();
}

/**
 * Photos that no node claims.
 *
 * With 42 photographs against 43 names against 44 shooting points, the two
 * sequences do not line up, and the mismatch is only resolvable by looking at
 * the pictures. Anything the numeric fallback could not place shows up here to
 * be dragged onto the row it belongs to.
 */
function renderTray() {
  const loose = photos.photos.filter((p) => !p.node);

  el.tray.hidden = loose.length === 0;
  el.trayCount.textContent = `${loose.length} of ${photos.photos.length}`;

  el.trayStrip.innerHTML = loose
    .map(
      (photo) => `
      <figure class="chip" draggable="true" data-file="${escapeHtml(photo.file)}">
        <img src="${withTour('/preview', { file: photo.file })}" alt="" loading="lazy" />
        <figcaption>${escapeHtml(photo.file)}</figcaption>
      </figure>`,
    )
    .join('');

  for (const chip of el.trayStrip.children) wireDragSource(chip);
}

function wireDragSource(node) {
  node.addEventListener('dragstart', (event) => {
    event.dataTransfer.setData('text/plain', node.dataset.file);
    event.dataTransfer.effectAllowed = 'move';
    node.classList.add('is-dragging');
  });
  node.addEventListener('dragend', () => node.classList.remove('is-dragging'));
}

/**
 * The four steps, in the order they have to be done.
 *
 * Alignment before hotspots is not a preference: arrows picked on an unaligned
 * panorama are placed against a yaw that will move.
 */
function renderCards(totals) {
  const steps = [
    {
      title: '1 · Photos',
      done: totals.processed,
      total: totals.nodes,
      // The real folder, not a hardcoded `raw/` — every venue points somewhere
      // different, and telling an operator the wrong place to put photographs
      // is worse than telling them nothing.
      hint: `Drop exports into ${state.rawDir ?? 'the tour\u2019s photo folder'}, then build`,
      action: totals.raw > totals.processed ? { label: 'Build all', run: processAll } : null,
    },
    {
      title: '2 · Alignment',
      done: totals.aligned,
      total: totals.nodes,
      hint: 'Must be finished before arrows',
      link: tourLink('/tour/tools/align.html'),
    },
    {
      title: '3 · Arrows',
      done: totals.linksPicked,
      total: totals.links,
      hint: 'Auto-placed until picked',
      link: tourLink('/tour/tools/hotspots.html'),
    },
    {
      title: '4 · Map points',
      done: totals.mapped,
      total: totals.nodes,
      hint: 'The mini-map needs at least one',
      link: tourLink('/tour/tools/map.html'),
    },
  ];

  el.cards.innerHTML = steps
    .map(
      (step, index) => `
      <article class="card ${step.done === step.total ? 'is-done' : ''}">
        <h2>${step.title}</h2>
        <p class="card__count">${step.done}<span>/${step.total}</span></p>
        <div class="card__bar"><div style="width:${percent(step.done, step.total)}%"></div></div>
        <p class="card__hint">${step.hint}</p>
        ${
          step.link
            ? `<a class="btn" href="${step.link}">Open tool</a>`
            : `<button class="btn" data-step="${index}"${step.action ? '' : ' disabled'}>${
                step.action?.label ?? 'Nothing to build'
              }</button>`
        }
      </article>`,
    )
    .join('');

  for (const button of el.cards.querySelectorAll('[data-step]')) {
    const step = steps[Number(button.dataset.step)];
    if (step.action) button.addEventListener('click', step.action.run);
  }
}

function renderRows() {
  el.rows.innerHTML = state.nodes
    .map(
      (node) => `
      <tr data-node="${node.node}" class="${node.raw ? '' : 'is-missing'}">
        <td class="mono">${node.id}</td>
        <td class="grid__photo" data-drop="${node.node}">
          ${
            node.source
              ? `<img src="${withTour('/preview', { file: node.source })}"
                      alt="" loading="lazy" title="${escapeHtml(node.source)}" />
                 <span class="grid__file ${node.assigned ? 'is-explicit' : ''}">
                   ${escapeHtml(node.source)}
                 </span>`
              : '<span class="grid__empty">drop a photo</span>'
          }
        </td>
        <td class="grid__name">
          <input class="name-input" dir="rtl" value="${escapeHtml(node.name)}"
                 data-rename="${node.node}" />
          ${node.unconfirmed ? '<span class="tag tag--warn">?</span>' : ''}
        </td>
        <td class="muted">${node.type}</td>
        <td>${tick(node.processed)}</td>
        <td>${tick(node.aligned)}${node.aligned ? `<span class="mono muted"> ${node.pan}°</span>` : ''}</td>
        <td class="${node.linksPicked === node.links ? 'ok' : 'muted'} mono">
          ${node.linksPicked}/${node.links}
        </td>
        <td>${tick(Boolean(node.map))}</td>
        <td class="grid__actions">
          <a class="btn btn--tiny" href="${tourLink('/tour/tools/align.html', { node: node.node })}">align</a>
          <a class="btn btn--tiny" href="${tourLink('/tour/tools/hotspots.html', { node: node.node })}">arrows</a>
          <a class="btn btn--tiny" href="${tourLink('/tour/tools/map.html', { node: node.node })}">map</a>
          <a class="btn btn--tiny" href="${tourLink('/tour/', { node: node.node })}" target="_blank" rel="noopener">view</a>
          <button class="btn btn--tiny" data-build="${node.node}"${node.raw ? '' : ' disabled'}>
            rebuild
          </button>
          <button class="btn btn--tiny btn--danger" data-remove="${node.node}"
                  title="Remove this node from the roster">&times;</button>
        </td>
      </tr>`,
    )
    .join('');

  for (const button of el.rows.querySelectorAll('[data-build]')) {
    button.addEventListener('click', () => processNode(Number(button.dataset.build)));
  }
  for (const button of el.rows.querySelectorAll('[data-remove]')) {
    button.addEventListener('click', () => removeNode(Number(button.dataset.remove)));
  }
  for (const input of el.rows.querySelectorAll('[data-rename]')) {
    wireRename(input);
  }
  for (const cell of el.rows.querySelectorAll('[data-drop]')) {
    wireDropTarget(cell);
  }
}

/** Commits on blur or Enter; Escape puts the old value back. */
function wireRename(input) {
  const original = input.value;

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') input.blur();
    if (event.key === 'Escape') {
      input.value = original;
      input.blur();
    }
  });

  input.addEventListener('blur', async () => {
    const name = input.value.trim();
    if (!name || name === original) {
      input.value = original || name;
      return;
    }

    const result = await post('/rename', { node: Number(input.dataset.rename), name });
    if (result.error) {
      input.value = original;
      openLog('Rename failed', result.error);
      return;
    }
    await refresh();
  });
}

/**
 * A row accepts a photo dragged from the tray, from another row, or straight
 * from Finder.
 *
 * A file dragged in from outside is matched by name against the raw folder —
 * the browser never reveals its real path, and copying a 20 MB panorama in
 * would duplicate what is already there.
 */
function wireDropTarget(cell) {
  const node = Number(cell.dataset.drop);

  cell.addEventListener('dragover', (event) => {
    event.preventDefault();
    cell.classList.add('is-over');
  });
  cell.addEventListener('dragleave', () => cell.classList.remove('is-over'));

  cell.addEventListener('drop', async (event) => {
    event.preventDefault();
    cell.classList.remove('is-over');

    const dropped =
      event.dataTransfer.getData('text/plain') || event.dataTransfer.files?.[0]?.name;
    if (!dropped) return;

    const result = await post('/assign', { node, file: dropped });
    if (result.error) {
      openLog('Could not assign that photo', result.error);
      return;
    }
    await refresh();
  });

  // Rows are drag sources too, so a photo can be moved from one node to another.
  const img = cell.querySelector('img');
  if (!img) return;

  cell.draggable = true;
  cell.addEventListener('dragstart', (event) => {
    event.dataTransfer.setData('text/plain', img.title);
    event.dataTransfer.effectAllowed = 'move';
  });
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

/** Re-runs the pipeline for one node, for when a photo has been replaced. */
async function processNode(node) {
  const id = String(node).padStart(2, '0');
  openLog(`Building node ${id}…`, 'Running the image pipeline. Large decodes take a moment.');

  try {
    const response = await fetch(withTour('/process'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ node }),
    });

    const result = await response.json();
    openLog(`Node ${id} — ${result.ok ? 'done' : 'failed'}`, result.output || result.error || '');
    await refresh();
  } catch (err) {
    openLog(`Node ${id} — failed`, String(err));
  }
}

/**
 * Builds every node that has a photo but no renditions.
 *
 * Sequential on purpose: the pipeline already runs its own decodes
 * concurrently, and firing 40 of them at once would just thrash memory.
 */
async function processAll() {
  const pending = state.nodes.filter((n) => n.raw && !n.processed);
  if (!pending.length) return;

  for (const [index, node] of pending.entries()) {
    openLog(
      `Building ${index + 1} of ${pending.length}…`,
      `Node ${node.id} — ${node.name}\n\nThis runs one node at a time; leave the tab open.`,
    );

    await fetch(withTour('/process'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ node: node.node }),
    }).catch(() => null);
  }

  openLog('Done', `Built ${pending.length} node(s).`);
  await refresh();
}

/** Appends a node to the roster. */
async function addNode() {
  const result = await post('/add-node', {});
  if (result.error) {
    openLog('Could not add a node', result.error);
    return;
  }

  await refresh();
  // The new row is at the bottom; take the operator there.
  el.rows.lastElementChild?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.rows.lastElementChild?.querySelector('.name-input')?.focus();
}

/**
 * Removes a node from the roster, together with its alignment, arrows and map
 * point.
 *
 * The remaining nodes keep their numbers. Renumbering would look tidier but
 * would silently reattach every recorded value to a different panorama.
 */
async function removeNode(node) {
  const entry = state.nodes.find((n) => n.node === node);
  const done = [
    entry?.aligned && 'its alignment',
    entry?.linksPicked && `${entry.linksPicked} placed arrow(s)`,
    entry?.map && 'its map point',
  ].filter(Boolean);

  const warning = done.length ? `\n\nThis also discards ${done.join(', ')}.` : '';
  if (!window.confirm(`Remove node ${entry?.id ?? node} — ${entry?.name ?? ''}?${warning}`)) return;

  const result = await post('/remove-node', { node });
  if (result.error) {
    openLog('Could not remove that node', result.error);
    return;
  }

  await refresh();
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
 * Helpers
 * ------------------------------------------------------------------ */

function tick(done) {
  return done ? '<span class="ok">●</span>' : '<span class="muted">○</span>';
}

function percent(done, total) {
  return total ? Math.round((done / total) * 100) : 0;
}

function openLog(title, text) {
  el.logTitle.textContent = title;
  el.logBody.textContent = text;
  el.log.hidden = false;
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
