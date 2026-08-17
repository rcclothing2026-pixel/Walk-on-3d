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
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RENDITION_ORDER, nodeId, panoFilename } from '../src/lib/paths.js';
import { findRaw, listRaw, loadSources } from './raw.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'src/data');
const RAW = path.join(ROOT, 'raw');
const PANOS = path.join(ROOT, 'panos');
const PREVIEWS = path.join(PANOS, '.previews');
const NAMES_JSON = path.join(DATA, 'names.json');
const SOURCES_JSON = path.join(DATA, 'sources.json');

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
          if (req.method === 'GET' && url === '/photos') return json(res, await listPhotos());
          if (req.method === 'GET' && url === '/preview') {
            return sendPreview(res, new URL(req.url, 'http://x').searchParams.get('file'));
          }
          if (req.method === 'POST' && url.startsWith('/save/')) {
            return json(res, await save(url.slice('/save/'.length), await body(req)));
          }
          if (req.method === 'POST' && url === '/process') {
            return json(res, await runPipeline(await body(req)));
          }
          if (req.method === 'POST' && url === '/assign') return json(res, await assign(await body(req)));
          if (req.method === 'POST' && url === '/rename') return json(res, await rename(await body(req)));
          if (req.method === 'POST' && url === '/add-node') return json(res, await addNode(await body(req)));
          if (req.method === 'POST' && url === '/remove-node') {
            return json(res, await removeNode(await body(req)));
          }
          return json(res, { error: 'not found' }, 404);
        } catch (err) {
          return json(res, { error: err.message }, 400);
        }
      });
    },
  };
}

/**
 * The roster, read from disk on every call rather than imported.
 *
 * `src/lib/nodes.js` imports names.json statically, and importing that here
 * would pull the file into Vite's config dependency graph — so every rename,
 * add or remove would restart the whole dev server and drop the request that
 * caused it. The studio edits this file constantly, so it has to be read, not
 * imported.
 */
async function readRoster() {
  const names = (await readJson(NAMES_JSON))?.nodes ?? {};
  const numbers = Object.keys(names)
    .map(Number)
    .filter(Number.isInteger)
    .sort((a, b) => a - b);

  return {
    numbers,
    info(n) {
      const entry = names[nodeId(n)];
      return {
        name: entry?.name ?? `؟ (${nodeId(n)})`,
        type: entry?.type ?? 'unknown',
        unconfirmed: Boolean(entry?.unconfirmed),
      };
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
  const [alignment, tour, sources, roster] = await Promise.all([
    readJson(WRITABLE.alignment),
    readJson(WRITABLE.nodes),
    loadSources(),
    readRoster(),
  ]);

  const nodes = await Promise.all(
    roster.numbers.map(async (n) => {
      const id = nodeId(n);
      const info = roster.info(n);
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
        // Same tolerant lookup the pipeline uses: 7.jpg counts as node 7.
        source: sourceFile(await findRaw(RAW, n, sources)),
        raw: Boolean(await findRaw(RAW, n, sources)),
        assigned: Boolean(sources[id]),
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

function sourceFile(fullPath) {
  return fullPath ? path.basename(fullPath) : null;
}

/* ------------------------------------------------------------------ *
 * Photos
 * ------------------------------------------------------------------ */

/** Every photo in the raw directory, with which node (if any) claims it. */
async function listPhotos() {
  const [files, sources, roster] = await Promise.all([listRaw(RAW), loadSources(), readRoster()]);
  const claimedBy = new Map();

  for (const [id, file] of Object.entries(sources)) claimedBy.set(path.basename(file), id);

  // findRaw already refuses to fall back onto a file another node has claimed,
  // so anything it returns here is genuinely free.
  for (const n of roster.numbers) {
    const id = nodeId(n);
    if (sources[id]) continue;

    const found = await findRaw(RAW, n, sources);
    if (found) claimedBy.set(path.basename(found), id);
  }

  const photos = await Promise.all(
    files.map(async (file) => ({
      file,
      bytes: (await statOrNull(path.join(RAW, file)))?.size ?? 0,
      node: claimedBy.get(file) ?? null,
      explicit: Boolean(
        Object.entries(sources).find(([, f]) => path.basename(f) === file),
      ),
    })),
  );

  return { photos, unassigned: photos.filter((p) => !p.node).length };
}

/**
 * A small preview of a source photo, so the studio can show what each node
 * actually contains rather than a filename.
 *
 * Generated on demand and cached — these come from 71-megapixel originals, and
 * decoding one per row on every page load would be unusable.
 */
async function sendPreview(res, file) {
  if (!file || file !== path.basename(file)) return json(res, { error: 'bad file' }, 400);

  const source = path.join(RAW, file);
  if (!(await statOrNull(source))) return json(res, { error: 'no such photo' }, 404);

  await mkdir(PREVIEWS, { recursive: true });
  const cached = path.join(PREVIEWS, `${file.replace(/\.[^.]+$/, '')}.jpg`);

  try {
    if (!(await statOrNull(cached))) {
      const { default: sharp } = await import('sharp');
      await sharp(source, { limitInputPixels: 512 * 1024 * 1024 })
        .resize(320, 160, { fit: 'cover' })
        .jpeg({ quality: 72 })
        .toFile(cached);
    }

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-cache');
    createReadStream(cached).pipe(res);
  } catch (err) {
    json(res, { error: err.message }, 500);
  }
}

/** Points a node at a specific photo, or clears the assignment. */
async function assign({ node, file }) {
  const id = requireNode(node);
  const sources = await loadSources();

  if (file === null || file === '') {
    delete sources[id];
  } else {
    const name = path.basename(String(file));
    if (!(await statOrNull(path.join(RAW, name)))) {
      throw new Error(`"${name}" is not in the raw folder`);
    }
    // One photo per node: clear any other node holding this file, or the same
    // panorama would silently appear in two places.
    for (const [other, held] of Object.entries(sources)) {
      if (path.basename(held) === name && other !== id) delete sources[other];
    }
    sources[id] = name;
  }

  await writeSources(sources);
  return { node: id, file: sources[id] ?? null };
}

/* ------------------------------------------------------------------ *
 * Roster
 * ------------------------------------------------------------------ */

/** Renames a node, or changes its type / unconfirmed flag. */
async function rename({ node, name, type, unconfirmed }) {
  const id = requireNode(node);
  const names = await readJson(NAMES_JSON);
  const entry = names.nodes[id];

  if (typeof name === 'string' && name.trim()) entry.name = name.trim();
  if (typeof type === 'string' && type.trim()) entry.type = type.trim();

  if (unconfirmed === true) entry.unconfirmed = true;
  else if (unconfirmed === false) delete entry.unconfirmed;

  await writeJson(NAMES_JSON, names);
  return { node: id, ...entry };
}

/**
 * Adds a node to the roster.
 *
 * Appends after the highest existing number rather than renumbering, because
 * renumbering would invalidate every alignment, arrow and map point already
 * recorded against the old numbers.
 */
async function addNode({ name, type } = {}) {
  const names = await readJson(NAMES_JSON);
  const next = Math.max(0, ...Object.keys(names.nodes).map(Number)) + 1;
  const id = nodeId(next);

  names.nodes[id] = {
    name: typeof name === 'string' && name.trim() ? name.trim() : `نود ${next}`,
    type: typeof type === 'string' && type.trim() ? type.trim() : 'booth',
    unconfirmed: true,
  };

  await writeJson(NAMES_JSON, names);
  return { node: id, added: true };
}

/**
 * Removes a node from the roster and everything keyed to it.
 *
 * Leaves the remaining numbers alone for the same reason `addNode` appends: the
 * numbers are referenced by alignment.json, nodes.json and sources.json, and
 * shifting them would silently reattach recorded work to the wrong panoramas.
 */
async function removeNode({ node }) {
  const id = requireNode(node);
  const names = await readJson(NAMES_JSON);

  if (Object.keys(names.nodes).length <= 1) throw new Error('cannot remove the last node');
  delete names.nodes[id];
  await writeJson(NAMES_JSON, names);

  const sources = await loadSources();
  if (sources[id]) {
    delete sources[id];
    await writeSources(sources);
  }

  for (const file of [WRITABLE.alignment, WRITABLE.nodes]) {
    const data = await readJson(file);
    if (!data) continue;
    if (data[id]) delete data[id];
    if (data.nodes?.[id]) delete data.nodes[id];
    await writeJson(file, data);
  }

  return { node: id, removed: true };
}

function requireNode(node) {
  const n = Number(node);
  if (!Number.isInteger(n) || n < 1 || n > 999) throw new Error(`"${node}" is not a node number`);
  return nodeId(n);
}

async function writeSources(sources) {
  const existing = (await readJson(SOURCES_JSON)) ?? {};
  await writeJson(SOURCES_JSON, { ...existing, sources });
}

async function writeJson(file, payload) {
  const body = file === NAMES_JSON ? serialiseNames(payload) : JSON.stringify(payload, null, 2);
  await writeFile(file, `${body}\n`);
}

/**
 * Writes names.json one node per line, in numeric order.
 *
 * Two reasons not to use plain JSON.stringify here. It expands every node to
 * four lines, which buries a name change in noise; and JS hoists integer-like
 * keys, so "10"…"44" would come out ahead of "01"…"09" and the file would no
 * longer read in tour order.
 */
function serialiseNames(payload) {
  const ids = Object.keys(payload.nodes).sort((a, b) => Number(a) - Number(b));

  const lines = ids.map((id) => {
    const { name, type, unconfirmed } = payload.nodes[id];
    const fields = [`"name": ${JSON.stringify(name)}`, `"type": ${JSON.stringify(type)}`];
    if (unconfirmed) fields.push('"unconfirmed": true');
    return `    ${JSON.stringify(id)}: { ${fields.join(', ')} }`;
  });

  const comment = payload._comment ? `  ${JSON.stringify('_comment')}: ${JSON.stringify(payload._comment)},\n` : '';
  return `{\n${comment}  "nodes": {\n${lines.join(',\n')}\n  }\n}`;
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
async function runPipeline({ node }) {
  const n = Number(node);
  const roster = await readRoster();
  if (!roster.numbers.includes(n)) throw new Error(`"${node}" is not a node in the roster`);

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
  return Boolean(await statOrNull(file));
}

async function statOrNull(file) {
  try {
    const s = await stat(file);
    return s.isFile() ? s : null;
  } catch {
    return null;
  }
}

/** The pipeline colours its output; the browser shows it as plain text. */
function stripAnsi(value) {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\[[0-9;]*m/g, '');
}
