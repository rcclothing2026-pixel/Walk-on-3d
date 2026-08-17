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

const API = '/tour/api';

const el = {
  summary: document.getElementById('summary'),
  cards: document.getElementById('cards'),
  rows: document.getElementById('rows'),
  refresh: document.getElementById('refresh'),
  log: document.getElementById('log'),
  logTitle: document.getElementById('log-title'),
  logBody: document.getElementById('log-body'),
  logClose: document.getElementById('log-close'),
  status: document.getElementById('status'),
};

let state = null;

start();

async function start() {
  el.refresh.addEventListener('click', refresh);
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
    const response = await fetch(`${API}/state`);
    if (!response.ok) throw new Error(String(response.status));

    state = await response.json();
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
  renderRows();
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
      hint: 'Drop exports into raw/, then build',
      action: totals.raw > totals.processed ? { label: 'Build all', run: processAll } : null,
    },
    {
      title: '2 · Alignment',
      done: totals.aligned,
      total: totals.nodes,
      hint: 'Must be finished before arrows',
      link: '/tour/tools/align.html',
    },
    {
      title: '3 · Arrows',
      done: totals.linksPicked,
      total: totals.links,
      hint: 'Auto-placed until picked',
      link: '/tour/tools/hotspots.html',
    },
    {
      title: '4 · Map points',
      done: totals.mapped,
      total: totals.nodes,
      hint: 'The mini-map needs at least one',
      link: '/tour/tools/map.html',
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
      <tr class="${node.raw ? '' : 'is-missing'}">
        <td class="mono">${node.id}</td>
        <td dir="rtl" class="grid__name">
          ${escapeHtml(node.name)}
          ${node.unconfirmed ? '<span class="tag tag--warn">?</span>' : ''}
        </td>
        <td class="muted">${node.type}</td>
        <td>${tick(node.raw)}</td>
        <td>${tick(node.processed)}</td>
        <td>${tick(node.aligned)}${node.aligned ? `<span class="mono muted"> ${node.pan}°</span>` : ''}</td>
        <td class="${node.linksPicked === node.links ? 'ok' : 'muted'} mono">
          ${node.linksPicked}/${node.links}
        </td>
        <td>${tick(Boolean(node.map))}</td>
        <td class="grid__actions">
          <a class="btn btn--tiny" href="/tour/tools/align.html?node=${node.node}">align</a>
          <a class="btn btn--tiny" href="/tour/tools/hotspots.html?node=${node.node}">arrows</a>
          <a class="btn btn--tiny" href="/tour/tools/map.html?node=${node.node}">map</a>
          <a class="btn btn--tiny" href="/tour/?node=${node.node}" target="_blank" rel="noopener">view</a>
          <button class="btn btn--tiny" data-build="${node.node}"${node.raw ? '' : ' disabled'}>
            rebuild
          </button>
        </td>
      </tr>`,
    )
    .join('');

  for (const button of el.rows.querySelectorAll('[data-build]')) {
    button.addEventListener('click', () => processNode(Number(button.dataset.build)));
  }
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

/** Re-runs the pipeline for one node, for when a photo has been replaced. */
async function processNode(node) {
  const id = String(node).padStart(2, '0');
  openLog(`Building node ${id}…`, 'Running the image pipeline. Large decodes take a moment.');

  try {
    const response = await fetch(`${API}/process`, {
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

    await fetch(`${API}/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ node: node.node }),
    }).catch(() => null);
  }

  openLog('Done', `Built ${pending.length} node(s).`);
  await refresh();
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
