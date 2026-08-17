/**
 * The local studio's back end.
 *
 * A small API mounted on the Vite dev server so the tools can save straight to
 * src/data/ instead of making you download a file and move it over the old one
 * — which, across 43 nodes × three tools, is the single most tedious part of
 * building the tour.
 *
 * DEVELOPMENT ONLY. The plugin declares `apply: 'serve'`, so none of this is
 * ever part of `npm run build` or reaches the deployed bundle. It writes to
 * disk and spawns the image pipeline, so it must stay that way.
 *
 * Everything it will touch is fixed up front:
 *
 *   - writes go only to the three whitelisted files in src/data/
 *   - the only spawn is `node scripts/process.js --only=N`, with N validated
 *     against the node roster, never interpolated into a shell
 *
 * Endpoints (all under /tour/api/):
 *
 *   GET  state             per-node status: photo, alignment, arrows, map point
 *   POST save/:file        write alignment | nodes | brands
 *   POST process           re-run the pipeline for one node
 */

import { execFile } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RENDITION_ORDER, nodeId, panoFilename } from '../src/lib/paths.js';
import { nodeInfo, nodeNumbers } from '../src/lib/nodes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'src/data');
const RAW = path.join(ROOT, 'raw');
const PANOS = path.join(ROOT, 'panos');

/** The only files the API will ever write. */
const WRITABLE = {
  alignment: path.join(DATA, 'alignment.json'),
  nodes: path.join(DATA, 'nodes.json'),
  brands: path.join(DATA, 'brands.json'),
};

/** Cap on a posted body, so a runaway request cannot exhaust memory. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export function devApi() {
  return {
    name: 'tour-dev-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/tour/api', async (req, res) => {
        const url = (req.url ?? '/').split('?')[0];

        try {
          if (req.method === 'GET' && url === '/state') return json(res, await readState());
          if (req.method === 'POST' && url.startsWith('/save/')) {
            return json(res, await save(url.slice('/save/'.length), await body(req)));
          }
          if (req.method === 'POST' && url === '/process') {
            return json(res, await runPipeline(await body(req)));
          }
          return json(res, { error: 'not found' }, 404);
        } catch (err) {
          return json(res, { error: err.message }, 400);
        }
      });
    },
  };
}

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

/**
 * What is done and what is not, per node.
 *
 * Read fresh from disk on every request rather than cached — the whole point is
 * that you can drop a file into raw/ in Finder and see it appear.
 */
async function readState() {
  const [alignment, tour] = await Promise.all([
    readJson(WRITABLE.alignment),
    readJson(WRITABLE.nodes),
  ]);

  const nodes = await Promise.all(
    nodeNumbers().map(async (n) => {
      const id = nodeId(n);
      const info = nodeInfo(n);
      const entry = tour?.nodes?.[id];
      const links = entry?.links ?? [];
      const pan = alignment?.[id];

      const renditions = {};
      for (const rendition of RENDITION_ORDER) {
        renditions[rendition] = await exists(path.join(PANOS, panoFilename(n, rendition)));
      }

      return {
        id,
        node: n,
        name: info.name,
        type: info.type,
        unconfirmed: info.unconfirmed,
        raw: await exists(path.join(RAW, `${id}.jpg`)),
        renditions,
        processed: RENDITION_ORDER.every((r) => renditions[r]),
        // A pan of exactly 0 with no entry means "never visited", which is not
        // the same as a deliberate 0°.
        aligned: Boolean(pan && !pan.todo && Number.isFinite(pan.pan)),
        pan: entry?.pan ?? 0,
        links: links.length,
        linksPicked: links.filter((l) => !l.auto).length,
        map: entry?.map ?? null,
      };
    }),
  );

  return {
    nodes,
    totals: {
      nodes: nodes.length,
      raw: nodes.filter((n) => n.raw).length,
      processed: nodes.filter((n) => n.processed).length,
      aligned: nodes.filter((n) => n.aligned).length,
      mapped: nodes.filter((n) => n.map).length,
      links: nodes.reduce((sum, n) => sum + n.links, 0),
      linksPicked: nodes.reduce((sum, n) => sum + n.linksPicked, 0),
    },
    renditions: RENDITION_ORDER,
  };
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

async function save(name, payload) {
  const target = WRITABLE[name];
  if (!target) throw new Error(`"${name}" is not a writable file`);
  if (payload === null || typeof payload !== 'object') {
    throw new Error('body must be a JSON object');
  }

  await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`);
  return { saved: path.relative(ROOT, target) };
}

/* ------------------------------------------------------------------ *
 * Pipeline
 * ------------------------------------------------------------------ */

/**
 * Re-runs the image pipeline for a single node, so a replaced photo can be
 * picked up without leaving the browser.
 *
 * `node` is validated against the roster and passed as an argv element, never
 * interpolated into a shell string.
 */
function runPipeline({ node }) {
  const n = Number(node);
  if (!nodeNumbers().includes(n)) throw new Error(`"${node}" is not a node in the roster`);

  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(ROOT, 'scripts/process.js'), `--only=${n}`, '--force'],
      { cwd: ROOT, timeout: 5 * 60 * 1000 },
      (err, stdout, stderr) => {
        resolve({
          node: nodeId(n),
          ok: !err,
          output: stripAnsi(`${stdout}${stderr}`).trim(),
        });
      },
    );
  });
}

/* ------------------------------------------------------------------ *
 * Plumbing
 * ------------------------------------------------------------------ */

function body(req) {
  return new Promise((resolve, reject) => {
    let raw = '';

    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('body is not valid JSON'));
      }
    });

    req.on('error', reject);
  });
}

function json(res, payload, status = 200) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function exists(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** The pipeline colours its output; the browser shows it as plain text. */
function stripAnsi(value) {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\[[0-9;]*m/g, '');
}
