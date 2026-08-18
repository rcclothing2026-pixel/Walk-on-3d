/**
 * Running a tool inside a pane of the split view.
 *
 * The tools are separate pages on purpose — each owns a panorama decode, a
 * viewer or a floor plan, and none of them wants to share a document with the
 * others. The split view puts two of them side by side in frames instead, which
 * keeps that separation and still lets a node be aligned and placed in one
 * sitting.
 *
 * All they need to cooperate is to agree on which node is being worked on. A
 * tool says which node it moved to; the page above forwards that to the other
 * pane. Nothing else crosses the boundary.
 *
 * Standalone, every function here is inert, so a tool opened on its own behaves
 * exactly as it did before.
 */

const CHANNEL = 'walk-on-3d';

/** Whether this page is a pane of the split view rather than the whole tab. */
export function isFramed() {
  try {
    return window.parent !== window;
  } catch {
    return false;
  }
}

/**
 * Lets the page above drive this tool's node.
 *
 * Call this once the tool has loaded its data and opened a node — not at
 * startup. The page above answers `ready` immediately, and a tool that is told
 * to move before it knows its own roster has nothing to move.
 *
 * @param {object} options
 * @param {() => number|null} options.current  the node in view, to ignore echoes
 * @param {(node: number) => void} options.goto
 */
export function connectFrame({ current, goto }) {
  if (!isFramed()) return;

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (data?.channel !== CHANNEL || data.type !== 'goto') return;

    // A round trip ends here: the other pane echoes the node it was just sent,
    // and acting on that would bounce it back for ever.
    const node = Number(data.node);
    if (!Number.isFinite(node) || node === current()) return;

    goto(node);
  });

  // Reports where this pane starts, so the page above can pull it into line
  // with the other one rather than the other way round.
  post({ type: 'ready', node: current() });
}

/** Tells the page above which node this tool moved to. */
export function announceNode(node) {
  if (!isFramed() || !Number.isFinite(Number(node))) return;
  post({ type: 'node', node: Number(node) });
}

function post(message) {
  // Same origin only — these pages are served by the dev server and nothing
  // else should be listening.
  window.parent.postMessage({ channel: CHANNEL, ...message }, location.origin);
}
