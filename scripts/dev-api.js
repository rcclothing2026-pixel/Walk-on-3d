/**
 * The studio's back end.
 *
 * A small API mounted on the Vite dev server so the tools can save straight to
 * a tour's folder instead of making you download a file and move it over the
 * old one — which, across dozens of nodes and several tools, is the single most
 * tedious part of building a tour.
 *
 * Every endpoint is scoped to one tour via ?tour=<slug>. Nothing is global: two
 * venues in the same install cannot see or overwrite each other's data.
 *
 * DEVELOPMENT ONLY. The plugin declares `apply: 'serve'`, so none of this is
 * ever part of `npm run build` or reaches a deployed bundle. It writes to disk
 * and spawns the image pipeline, so it must stay that way.
 *
 * Everything it can touch is fixed up front:
 *
 *   - writes go only to the known files inside tours/<slug>/
 *   - slugs are validated against a strict pattern, so none can climb out of
 *     tours/
 *   - the only spawn is the pipeline, with a node number checked against the
 *     roster and passed as an argv element, never through a shell
 */

import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { RENDITION_ORDER, nodeId, panoFilename } from '../src/lib/paths.js';
import { ROOT, TOURS_DIR, assertSlug, listTours, readJson, tourPaths } from './tours.js';
import { loadRoster } from './roster.js';
import { findRaw, listRaw } from './raw.js';

/** The files the API will write, by the key the tools use. */
const WRITABLE = new Set(['alignment', 'nodes', 'brands', 'sources', 'names', 'tour', 'links']);

/** Cap on a posted body, so a runaway request cannot exhaust memory. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export function devApi() {
  return {
    name: 'tour-dev-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/tour/api', async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://studio');
        const route = url.pathname;
        const slug = url.searchParams.get('tour');

        try {
          if (req.method === 'GET' && route === '/tours') return json(res, await tourList());
          if (req.method === 'POST' && route === '/tours') {
            return json(res, await createTour(await body(req)));
          }

          if (req.method === 'GET' && route === '/state') return json(res, await readState(slug));
          if (req.method === 'GET' && route === '/photos') return json(res, await listPhotos(slug));
          if (req.method === 'GET' && route === '/preview') {
            // Awaited deliberately: returning the promise would let a rejection
            // escape this try and take the dev server down with it.
            return await sendPreview(res, slug, url.searchParams.get('file'));
          }

          if (req.method === 'POST' && route.startsWith('/save/')) {
            return json(res, await save(slug, route.slice('/save/'.length), await body(req)));
          }
          if (req.method === 'POST' && route === '/process') {
            return json(res, await runPipeline(slug, await body(req)));
          }
          if (req.method === 'POST' && route === '/assign') {
            return json(res, await assign(slug, await body(req)));
          }
          if (req.method === 'POST' && route === '/rename') {
            return json(res, await rename(slug, await body(req)));
          }
          if (req.method === 'POST' && route === '/add-node') {
            return json(res, await addNode(slug, await body(req)));
          }
          if (req.method === 'POST' && route === '/remove-node') {
            return json(res, await removeNode(slug, await body(req)));
          }
          if (req.method === 'POST' && route === '/add-node-at') {
            return json(res, await addNodeAt(slug, await body(req)));
          }
          if (req.method === 'POST' && route === '/rebuild') {
            return json(res, await rebuild(slug));
          }
          if (req.method === 'POST' && route === '/floorplan') {
            return json(res, await uploadFloorplan(slug, req, url.searchParams.get('name')));
          }

          return json(res, { error: 'not found' }, 404);
        } catch (err) {
          // No request may crash the studio. A malformed slug or a missing file
          // is a 400, not a dead server.
          if (res.headersSent) return res.end();
          return json(res, { error: err.message }, 400);
        }
      });
    },
  };
}

/* ------------------------------------------------------------------ *
 * Tours
 * ------------------------------------------------------------------ */

async function tourList() {
  const slugs = await listTours();

  const tours = await Promise.all(
    slugs.map(async (slug) => {
      const paths = await tourPaths(slug);
      const roster = await loadRoster(paths);
      const nodes = (await readJson(paths.file('nodes')))?.nodes ?? {};
      const links = Object.values(nodes).flatMap((n) => n.links ?? []);

      return {
        slug,
        title: paths.config.title ?? slug,
        nodes: roster.count,
        links: links.length,
        linksPicked: links.filter((l) => !l.auto).length,
      };
    }),
  );

  return { tours };
}

/**
 * Creates a tour folder from scratch.
 *
 * Starts genuinely empty — no nodes, no links. Nodes are added in the studio,
 * which is the only way a second venue can work: its layout is not knowable in
 * advance.
 */
async function createTour({ slug, title, rawDir }) {
  assertSlug(slug);

  const dir = path.join(TOURS_DIR, slug);
  if (await exists(path.join(dir, 'tour.json'))) throw new Error(`Tour "${slug}" already exists`);

  await mkdir(dir, { recursive: true });

  await writeJsonAt(path.join(dir, 'tour.json'), {
    slug,
    title: title?.trim() || slug,
    lang: 'fa',
    dir: 'rtl',
    startNode: 1,
    rawDir: rawDir?.trim() || `raw/${slug}`,
    mapFromNode: 1,
  });

  await writeNames(path.join(dir, 'names.json'), {
    _comment: 'Display names and node types, one node per line. Edited from the studio.',
    nodes: {},
  });
  await writeJsonAt(path.join(dir, 'sources.json'), { sources: {} });
  await writeJsonAt(path.join(dir, 'brands.json'), { brands: {} });

  return { slug, created: true };
}

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

/** What is done and what is not, per node, read fresh from disk every time. */
async function readState(slug) {
  const paths = await tourPaths(slug);
  const [alignment, tour, sourcesFile, roster] = await Promise.all([
    readJson(paths.file('alignment')),
    readJson(paths.file('nodes')),
    readJson(paths.file('sources')),
    loadRoster(paths),
  ]);

  const sources = sourcesFile?.sources ?? {};

  const nodes = await Promise.all(
    roster.numbers.map(async (n) => {
      const id = nodeId(n);
      const info = roster.info(n);
      const entry = tour?.nodes?.[id];
      const links = entry?.links ?? [];
      const pan = alignment?.[id];
      const source = await findRaw(paths.raw, n, sources);

      const renditions = {};
      for (const rendition of RENDITION_ORDER) {
        renditions[rendition] = await exists(path.join(paths.panos, panoFilename(n, rendition)));
      }

      return {
        id,
        node: n,
        name: info.name,
        type: info.type,
        unconfirmed: info.unconfirmed,
        source: source ? path.basename(source) : null,
        raw: Boolean(source),
        assigned: Boolean(sources[id]),
        renditions,
        processed: RENDITION_ORDER.every((r) => renditions[r]),
        // A pan of 0 with no entry means "never visited", which is not the same
        // as a deliberate 0°.
        aligned: Boolean(pan && !pan.todo && Number.isFinite(pan.pan)),
        pan: entry?.pan ?? 0,
        links: links.length,
        linksPicked: links.filter((l) => !l.auto).length,
        map: entry?.map ?? null,
      };
    }),
  );

  return {
    slug: paths.slug,
    config: paths.config,
    rawDir: path.relative(ROOT, paths.raw),
    hasFloorplan: await exists(paths.floorplan),
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
 * Photos
 * ------------------------------------------------------------------ */

async function listPhotos(slug) {
  const paths = await tourPaths(slug);
  const [files, sourcesFile, roster] = await Promise.all([
    listRaw(paths.raw),
    readJson(paths.file('sources')),
    loadRoster(paths),
  ]);

  const sources = sourcesFile?.sources ?? {};
  const claimedBy = new Map();

  for (const [id, file] of Object.entries(sources)) claimedBy.set(path.basename(file), id);

  // findRaw already refuses to fall back onto a file another node has claimed,
  // so anything it returns here is genuinely free.
  for (const n of roster.numbers) {
    const id = nodeId(n);
    if (sources[id]) continue;
    const found = await findRaw(paths.raw, n, sources);
    if (found) claimedBy.set(path.basename(found), id);
  }

  const photos = await Promise.all(
    files.map(async (file) => ({
      file,
      bytes: (await statOrNull(path.join(paths.raw, file)))?.size ?? 0,
      node: claimedBy.get(file) ?? null,
      explicit: Object.values(sources).some((f) => path.basename(f) === file),
    })),
  );

  return { photos, unassigned: photos.filter((p) => !p.node).length };
}

/**
 * A small preview of a source photo, cached.
 *
 * These come from 71-megapixel originals; decoding one per row on every page
 * load would be unusable.
 */
async function sendPreview(res, slug, file) {
  if (!file || file !== path.basename(file)) return json(res, { error: 'bad file' }, 400);

  const paths = await tourPaths(slug);
  const source = path.join(paths.raw, file);
  if (!(await statOrNull(source))) return json(res, { error: 'no such photo' }, 404);

  const previews = path.join(paths.panos, '.previews');
  await mkdir(previews, { recursive: true });
  const cached = path.join(previews, `${file.replace(/\.[^.]+$/, '')}.jpg`);

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
async function assign(slug, { node, file }) {
  const paths = await tourPaths(slug);
  const id = requireNode(node);
  const sources = (await readJson(paths.file('sources')))?.sources ?? {};

  if (file === null || file === '') {
    delete sources[id];
  } else {
    const name = path.basename(String(file));
    if (!(await statOrNull(path.join(paths.raw, name)))) {
      throw new Error(`"${name}" is not in the raw folder`);
    }
    // One photo per node: clear any other node holding this file, or the same
    // panorama would silently appear in two places.
    for (const [other, held] of Object.entries(sources)) {
      if (path.basename(held) === name && other !== id) delete sources[other];
    }
    sources[id] = name;
  }

  await writeJsonAt(paths.file('sources'), { sources });
  return { node: id, file: sources[id] ?? null };
}

/* ------------------------------------------------------------------ *
 * Roster
 * ------------------------------------------------------------------ */

async function rename(slug, { node, name, type, unconfirmed }) {
  const paths = await tourPaths(slug);
  const id = requireNode(node);
  const names = (await readJson(paths.file('names'))) ?? { nodes: {} };
  const entry = (names.nodes[id] ??= { name: '', type: 'booth' });

  if (typeof name === 'string' && name.trim()) entry.name = name.trim();
  if (typeof type === 'string' && type.trim()) entry.type = type.trim();

  if (unconfirmed === true) entry.unconfirmed = true;
  else if (unconfirmed === false) delete entry.unconfirmed;

  await writeNames(paths.file('names'), names);
  return { node: id, ...entry };
}

/**
 * Appends a node.
 *
 * Appends after the highest existing number rather than renumbering, because
 * renumbering would invalidate every alignment, arrow and map point already
 * recorded against the old numbers.
 */
async function addNode(slug, { name, type } = {}) {
  const paths = await tourPaths(slug);
  const names = (await readJson(paths.file('names'))) ?? { nodes: {} };
  const next = Math.max(0, ...Object.keys(names.nodes).map(Number)) + 1;
  const id = nodeId(next);

  names.nodes[id] = {
    name: name?.trim() || `نقطه ${next}`,
    type: type?.trim() || 'booth',
    unconfirmed: true,
  };

  await writeNames(paths.file('names'), names);
  return { node: id, added: true };
}

/** Removes a node and everything keyed to it. Survivors keep their numbers. */
async function removeNode(slug, { node }) {
  const paths = await tourPaths(slug);
  const id = requireNode(node);
  const names = await readJson(paths.file('names'));

  if (Object.keys(names?.nodes ?? {}).length <= 1) throw new Error('cannot remove the last node');
  delete names.nodes[id];
  await writeNames(paths.file('names'), names);

  for (const key of ['sources', 'alignment', 'nodes']) {
    const file = paths.file(key);
    const data = await readJson(file);
    if (!data) continue;

    let touched = false;

    if (data[id]) {
      delete data[id];
      touched = true;
    }
    if (data.sources?.[id]) {
      delete data.sources[id];
      touched = true;
    }
    if (data.nodes?.[id]) {
      delete data.nodes[id];
      touched = true;
    }

    // Links pointing at the removed node have to go too, or the next build
    // fails on a link to a node that is not in the roster.
    for (const entry of Object.values(data.nodes ?? {})) {
      const before = entry.links?.length ?? 0;
      if (before) entry.links = entry.links.filter((l) => l.node !== id);
      if ((entry.links?.length ?? 0) !== before) touched = true;
    }

    if (touched) await writeJsonAt(file, data);
  }

  return { node: id, removed: true };
}

/**
 * Creates a node and places it on the plan in one step.
 *
 * Adding a node and then finding it in a list to position it are the same
 * action from the operator's point of view — they clicked a spot on the plan
 * because that is where the shooting point is.
 */
async function addNodeAt(slug, { x, y, name, type }) {
  if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) {
    throw new Error('x and y are required');
  }

  const created = await addNode(slug, { name, type });
  const paths = await tourPaths(slug);
  const nodes = (await readJson(paths.file('nodes'))) ?? { nodes: {} };

  nodes.nodes ??= {};
  nodes.nodes[created.node] = {
    ...(nodes.nodes[created.node] ?? {}),
    id: created.node,
    map: { x: Math.round(Number(x)), y: Math.round(Number(y)) },
    links: nodes.nodes[created.node]?.links ?? [],
  };

  await writeJsonAt(paths.file('nodes'), nodes);
  return { ...created, map: nodes.nodes[created.node].map };
}

/**
 * Regenerates nodes.json from the tour's roster and links.
 *
 * Called after the link graph is edited, so newly drawn connections turn into
 * arrows without dropping to a terminal. Picked angles and map points survive,
 * exactly as they do on the command line.
 */
async function rebuild(slug) {
  const paths = await tourPaths(slug);

  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(ROOT, 'scripts/build-nodes.js'), `--tour=${paths.slug}`],
      { cwd: ROOT, timeout: 60 * 1000 },
      (err, stdout, stderr) => {
        resolve({ ok: !err, output: stripAnsi(`${stdout}${stderr}`).trim() });
      },
    );
  });
}

/**
 * Accepts a floor plan uploaded from the studio.
 *
 * A PDF goes through the same ink-detection crop the command line uses, so an
 * architect's sheet can be dropped in as-is rather than cropped by hand first.
 * Anything else is treated as an image and normalised to PNG.
 */
async function uploadFloorplan(slug, req, name = '') {
  const paths = await tourPaths(slug);
  const bytes = await rawBody(req, 64 * 1024 * 1024);

  if (!bytes.length) throw new Error('no file received');

  const isPdf = bytes.subarray(0, 5).toString('latin1') === '%PDF-' || /\.pdf$/i.test(name);

  if (isPdf) {
    const pdf = path.join(paths.dir, 'blueprint.pdf');
    await writeFile(pdf, bytes);

    const result = await new Promise((resolve) => {
      execFile(
        process.execPath,
        [path.join(ROOT, 'scripts/floorplan.js'), `--tour=${paths.slug}`],
        { cwd: ROOT, timeout: 5 * 60 * 1000 },
        (err, stdout, stderr) => resolve({ err, out: stripAnsi(`${stdout}${stderr}`) }),
      );
    });

    if (result.err) {
      throw new Error(
        `The PDF was saved but could not be converted.\n${result.out.trim()}\n\n` +
          'Converting a PDF needs pdftoppm (poppler-utils). A PNG can be uploaded instead.',
      );
    }

    return { from: 'pdf', output: result.out.trim() };
  }

  const { default: sharp } = await import('sharp');
  const info = await sharp(bytes, { limitInputPixels: 512 * 1024 * 1024 })
    .resize(2400, null, { withoutEnlargement: true })
    .png({ compressionLevel: 9, palette: true, colours: 32 })
    .toFile(paths.floorplan);

  return { from: 'image', width: info.width, height: info.height, bytes: info.size };
}

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

async function save(slug, name, payload) {
  if (!WRITABLE.has(name)) throw new Error(`"${name}" is not a writable file`);
  if (payload === null || typeof payload !== 'object') {
    throw new Error('body must be a JSON object');
  }

  const paths = await tourPaths(slug);
  const target = paths.file(name);

  if (name === 'names') await writeNames(target, payload);
  else if (name === 'links') await writeLinks(target, payload);
  else await writeJsonAt(target, payload);

  return { saved: path.relative(ROOT, target) };
}

async function writeJsonAt(file, payload) {
  await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`);
}

/**
 * Writes links.json one edge per line.
 *
 * Plain JSON.stringify puts every number of every pair on its own line, so a
 * fifty-edge venue becomes three hundred lines and the graph stops being
 * readable in a diff. The node lists are folded the same way.
 */
async function writeLinks(file, payload) {
  const edges = (payload.edges ?? [])
    .map((edge) => [Number(edge[0]), Number(edge[1])].sort((a, b) => a - b))
    .filter(([a, b]) => Number.isInteger(a) && Number.isInteger(b) && a !== b);

  // De-duplicated: the same pair drawn twice would generate a doubled arrow.
  const seen = new Set();
  const unique = edges.filter(([a, b]) => {
    const key = `${a}-${b}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  unique.sort((p, q) => p[0] - q[0] || p[1] - q[1]);

  const parts = [];
  if (payload._comment) parts.push(`  "_comment": ${JSON.stringify(payload._comment)}`);
  for (const key of ['deadEnds', 'expectedSingleLink']) {
    if (Array.isArray(payload[key])) parts.push(`  ${JSON.stringify(key)}: [${payload[key].join(', ')}]`);
  }
  parts.push(
    unique.length
      ? `  "edges": [\n${unique.map(([a, b]) => `    [${a}, ${b}]`).join(',\n')}\n  ]`
      : '  "edges": []',
  );

  await writeFile(file, `{\n${parts.join(',\n')}\n}\n`);
}

/**
 * Writes names.json one node per line, in numeric order.
 *
 * Plain JSON.stringify expands every node to four lines, burying a name change
 * in noise, and JS hoists integer-like keys so "10"…"44" would come out ahead
 * of "01"…"09" and the file would stop reading in tour order.
 */
async function writeNames(file, payload) {
  const ids = Object.keys(payload.nodes).sort((a, b) => Number(a) - Number(b));

  const lines = ids.map((id) => {
    const { name, type, unconfirmed } = payload.nodes[id];
    const fields = [`"name": ${JSON.stringify(name)}`, `"type": ${JSON.stringify(type)}`];
    if (unconfirmed) fields.push('"unconfirmed": true');
    return `    ${JSON.stringify(id)}: { ${fields.join(', ')} }`;
  });

  const comment = payload._comment ? `  "_comment": ${JSON.stringify(payload._comment)},\n` : '';
  await writeFile(file, `{\n${comment}  "nodes": {\n${lines.join(',\n')}\n  }\n}\n`);
}

/* ------------------------------------------------------------------ *
 * Pipeline
 * ------------------------------------------------------------------ */

async function runPipeline(slug, { node }) {
  const paths = await tourPaths(slug);
  const roster = await loadRoster(paths);
  const n = Number(node);

  if (!roster.has(n)) throw new Error(`"${node}" is not a node in this tour`);

  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(ROOT, 'scripts/process.js'), `--tour=${paths.slug}`, `--only=${n}`, '--force'],
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

function requireNode(node) {
  const n = Number(node);
  if (!Number.isInteger(n) || n < 1 || n > 999) throw new Error(`"${node}" is not a node number`);
  return nodeId(n);
}

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

/** Collects a binary upload, capped so a huge file cannot exhaust memory. */
function rawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`file too large (over ${Math.round(limit / 1024 / 1024)} MB)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function json(res, payload, status = 200) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
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
  return value.replace(/\[[0-9;]*m/g, '');
}
