/**
 * Helpers shared by every authoring tool.
 *
 * These were copied tool to tool for long enough that they had started to
 * drift — two toast durations, three POST helpers, eight copies of
 * escapeHtml. One module, imported by each page, ends that.
 *
 * Development only: none of this belongs in a customer's bundle, so the
 * viewer never imports it.
 */

/**
 * The ?node=NN a tool was opened at, or the first node of the roster.
 *
 * Every tool reads the same query parameter so a link from the studio, the
 * drawer or a split pane lands on the node being worked on.
 */
export function initialNode(nodes) {
  const requested = Number(new URLSearchParams(location.search).get('node'));
  return nodes.includes(requested) ? requested : nodes[0];
}

/**
 * The <option> list for a node picker, names escaped, in tour order.
 *
 * @param {number[]} nodes            roster order
 * @param {(n: number) => {name: string}} info  roster lookup
 */
export function nodeOptions(nodes, info) {
  return nodes
    .map((n) => {
      const { name } = info(n);
      return `<option value="${n}">${nodeId(n)} — ${escapeHtml(name)}</option>`;
    })
    .join('');
}

function nodeId(n) {
  return String(n).padStart(2, '0');
}

export function escapeHtml(value) {
  return String(value).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );
}

/**
 * A transient confirmation, bottom corner. Two seconds everywhere — enough to
 * read "Node 17 saved at −4.5°", not long enough to pile up.
 */
export function toast(message, kind = 'ok', ms = 2000) {
  const node = document.createElement('div');
  node.className = 'toast';
  node.dataset.kind = kind;
  node.textContent = message;
  document.body.append(node);
  setTimeout(() => node.remove(), ms);
}

/** The tool's status panel: a modal card over whatever the page shows. */
export function showStatus(statusEl, html, kind = 'info') {
  statusEl.innerHTML = html;
  statusEl.dataset.kind = kind;
  statusEl.hidden = false;
}

export function hideStatus(statusEl) {
  statusEl.hidden = true;
}

/**
 * Reports a tool that never got off the ground.
 *
 * A tool whose data did not load used to die mid-startup, leaving an empty
 * page — no roster, no plan, no panorama, and nothing on screen to say why.
 * Whatever went wrong belongs where the operator can read it: a locked door,
 * a file the studio machine does not have, a dev server that is not running.
 */
export function reportStartupFailure(statusEl, err) {
  console.error('[tool] startup failed:', err);
  const message = escapeHtml(err?.message ?? String(err));

  const hint = /401/.test(message)
    ? 'The studio is behind a key. Add <code>?key=…</code> to the address once — ' +
      'this browser then stays signed in — and reload.'
    : /404/.test(message)
      ? 'That file does not exist on the studio machine. Check the tour\u2019s folder there.'
      : 'Is <code>npm run dev</code> running on the studio machine, and are the ' +
        'tour\u2019s data files there with it?';

  showStatus(statusEl, `<strong>This tool could not start.</strong><br /><br />` +
    `<code>${message}</code><br /><br />${hint}`, 'error');
}

/**
 * Warns before an unload that would lose work.
 *
 * No localStorage by project rule, so unsaved edits are genuinely losable —
 * but the warning must mean something. Pass a predicate that answers for this
 * session's edits only, not "does any data exist on disk", or closing the page
 * after merely loading it nags for no reason.
 *
 * @param {() => boolean} hasUnsaved
 */
export function wireUnloadGuard(hasUnsaved) {
  window.addEventListener('beforeunload', (event) => {
    if (!hasUnsaved()) return;
    event.preventDefault();
    event.returnValue = '';
  });
}
