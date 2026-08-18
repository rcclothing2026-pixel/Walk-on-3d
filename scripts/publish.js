/**
 * `npm run publish` — sending a finished venue to StoqS.
 *
 * The builder does not live on the web server. It runs wherever the panoramas,
 * Node and sharp are: a machine with the photographs on it, reachable from
 * nowhere in particular. StoqS is a PHP host that serves the tour to visitors
 * and knows nothing about how it was made.
 *
 * This is the seam between them. It pushes the documents, then the heavy files,
 * then asks the site to make the venue live:
 *
 *   npm run publish -- --tour=hammam --to=https://stoqs.example
 *
 * Authentication is a per-venue publish key, minted in StoqS under Super Admin →
 * Virtual tours. It goes in the environment, not on the command line, so it does
 * not end up in a shell history:
 *
 *   export WALK_PUBLISH_KEY=…            # or WALK_PUBLISH_KEY_HAMMAM for one venue
 *   export WALK_PUBLISH_TO=https://…     # or pass --to
 *
 * Incremental by default. The site is asked what it already holds and only
 * files whose contents differ are sent, because a venue is ninety megabytes and
 * correcting one panorama should not mean re-uploading forty. `--force` sends
 * everything.
 *
 * Safe to interrupt and re-run: every route overwrites rather than appends, and
 * a half-sent upload is repaired by running the command again.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { RENDITION_ORDER } from '../src/lib/paths.js';
import { TOUR_FILES, exists, readJson, resolveTour } from './tours.js';

/** Uploads in flight at once. More than this and a domestic uplink just queues. */
const CONCURRENCY = 3;

/** Attempts per file before the run gives up, with a widening pause between. */
const ATTEMPTS = 4;

const argv = process.argv.slice(2);

main().catch((error) => {
  console.error(`\n✗ ${error.message}`);
  process.exitCode = 1;
});

async function main() {
  const tour = await resolveTour(argv);
  const site = siteUrl();
  const key = publishKey(tour.slug);
  const force = argv.includes('--force');
  const dryRun = argv.includes('--dry-run');

  const api = endpoint(site, tour.slug, key);

  console.log(`Publishing "${tour.slug}" to ${site}`);
  if (dryRun) console.log('(dry run — nothing will be sent)\n');

  // What the site already holds. This also proves the key before anything
  // large is sent: a wrong key should fail in a second, not after ninety
  // megabytes.
  const remote = await api('manifest');
  console.log(`  site holds ${Object.keys(remote.files).length} file(s), status "${remote.status}"\n`);

  const docs = await collectDocs(tour);
  const files = await collectFiles(tour);

  const pending = force
    ? files
    : files.filter((file) => remote.files[file.name]?.sha256 !== file.sha256);
  const skipped = files.length - pending.length;

  console.log(`  documents  ${Object.keys(docs).join(', ')}`);
  console.log(`  files      ${pending.length} to send${skipped ? `, ${skipped} unchanged` : ''}`);
  console.log(`             ${mb(pending.reduce((sum, f) => sum + f.bytes.length, 0))}\n`);

  if (dryRun) {
    for (const file of pending) console.log(`  would send ${file.name} (${mb(file.bytes.length)})`);
    return;
  }

  const wrote = await api('docs', {
    json: { title: tour.config.title, docs },
  });
  console.log(`  ✓ documents: ${wrote.wrote.join(', ')}`);

  let done = 0;
  await inParallel(pending, CONCURRENCY, async (file) => {
    await withRetries(file.name, () =>
      api('asset', { query: file.query, body: file.bytes, type: file.type }),
    );
    done += 1;
    process.stdout.write(`\r  ✓ files: ${done}/${pending.length}   `);
  });
  if (pending.length) process.stdout.write('\n');

  const live = await api('finish');
  if (!live.ok) {
    throw new Error(`the site refused to publish:\n    - ${live.problems.join('\n    - ')}`);
  }

  console.log(`\n✓ live — ${live.nodes} nodes at ${new URL(live.url, site).href}`);
}

/* ------------------------------------------------------------------ *
 * What gets sent
 * ------------------------------------------------------------------ */

/** Every document the tour owns, as parsed JSON, keyed by document name. */
async function collectDocs(tour) {
  const docs = {};

  for (const [name, spec] of Object.entries(TOUR_FILES)) {
    const data = await readJson(tour.file(name));
    if (data) docs[name] = data;
    else if (spec.required) throw new Error(`${spec.file} is missing — this venue is not ready`);
  }

  if (!Object.keys(docs.names?.nodes ?? {}).length) {
    throw new Error('names.json lists no nodes — refusing to publish an empty venue');
  }

  if (!docs.nodes) {
    throw new Error('nodes.json has not been built. Run `npm run nodes` first.');
  }

  return docs;
}

/**
 * The floor plan and every rendition of every panorama, hashed so unchanged
 * ones can be left alone.
 *
 * A node with no panorama is reported rather than skipped silently — the site
 * will refuse the venue for it anyway, and finding out here is quicker.
 */
async function collectFiles(tour) {
  const files = [];

  if (!(await exists(tour.floorplan))) throw new Error('floorplan.png is missing');
  files.push(await describe(tour.floorplan, 'floorplan.png', { kind: 'floorplan' }, 'image/png'));

  const ids = Object.keys((await readJson(tour.file('names')))?.nodes ?? {});
  const present = new Set(await readdir(tour.panos).catch(() => []));
  const missing = [];

  for (const id of ids) {
    if (!present.has(`${id}-mid.jpg`)) missing.push(id);

    for (const rendition of RENDITION_ORDER) {
      const name = `${id}-${rendition}.jpg`;
      if (!present.has(name)) continue;
      files.push(
        await describe(
          path.join(tour.panos, name),
          name,
          { kind: 'pano', file: name },
          'image/jpeg',
        ),
      );
    }
  }

  if (missing.length) {
    throw new Error(
      `${missing.length} node(s) have no panorama in ${tour.panos}: ` +
        `${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''}\n` +
        '  Run `npm run process` on the machine holding the photographs.',
    );
  }

  return files;
}

async function describe(file, name, query, type) {
  const bytes = await readFile(file);
  return { name, query, type, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/* ------------------------------------------------------------------ *
 * Talking to the site
 * ------------------------------------------------------------------ */

/** A caller bound to one site and one venue's key. */
function endpoint(site, slug, key) {
  return async function call(route, { json, body, type, query = {} } = {}) {
    const url = new URL(`tour/publish/${route}`, ensureSlash(site));
    url.searchParams.set('tour', slug);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Walk-Key': key,
        'Content-Type': json ? 'application/json' : (type ?? 'application/octet-stream'),
      },
      body: json ? JSON.stringify(json) : body,
    });

    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      // A login page or a proxy error, not the API. Show the beginning of it —
      // "unexpected token <" tells nobody which server said no.
      throw new Error(
        `${url.pathname} answered ${response.status} with something that is not JSON:\n` +
          `    ${text.slice(0, 200).replace(/\s+/g, ' ')}`,
      );
    }

    // `finish` reports its refusals in a 422 body, which the caller reads.
    if (!response.ok && response.status !== 422) {
      throw new Error(`${route}: ${payload.error ?? response.status}`);
    }

    return payload;
  };
}

/**
 * Retries a single upload.
 *
 * Only worth doing for the heavy files: a dropped connection halfway through
 * forty panoramas should cost that one file, not the run.
 */
async function withRetries(label, attempt) {
  for (let n = 1; ; n += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (n >= ATTEMPTS) throw new Error(`${label}: ${error.message}`);
      const pause = 2 ** n * 1000;
      process.stdout.write(`\n  … ${label} failed (${error.message}), retrying in ${pause / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, pause));
    }
  }
}

/** Runs `worker` over `items`, at most `limit` at a time, in order. */
async function inParallel(items, limit, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await worker(queue.shift());
  });
  await Promise.all(runners);
}

/* ------------------------------------------------------------------ *
 * Arguments and environment
 * ------------------------------------------------------------------ */

function siteUrl() {
  const flag = argv.find((arg) => arg.startsWith('--to='))?.slice('--to='.length);
  const site = (flag || process.env.WALK_PUBLISH_TO || '').trim();

  if (!site) {
    throw new Error(
      'No destination. Pass --to=https://your-stoqs-site or set WALK_PUBLISH_TO.',
    );
  }

  let url;
  try {
    url = new URL(site);
  } catch {
    throw new Error(`"${site}" is not a URL.`);
  }

  // The key travels in a header. Over http:// it travels in the clear, and it
  // is the only thing standing between a stranger and this venue's photographs.
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error(`${site} is not https — the publish key would be sent in the clear.`);
  }

  return url.href;
}

/**
 * The key, from the environment.
 *
 * A per-venue variable wins over the general one so a machine that builds two
 * venues can hold both keys without swapping them between runs.
 */
function publishKey(slug) {
  const specific = `WALK_PUBLISH_KEY_${slug.toUpperCase().replace(/-/g, '_')}`;
  const key = (process.env[specific] || process.env.WALK_PUBLISH_KEY || '').trim();

  if (!key) {
    throw new Error(
      `No publish key. In StoqS open Super Admin → Virtual tours → ${slug} → publish key,\n` +
        `  then:  export ${specific}=…   (or WALK_PUBLISH_KEY for every venue)`,
    );
  }

  if (key.length < 32) throw new Error('That publish key is too short to be one.');

  return key;
}

const ensureSlash = (url) => (url.endsWith('/') ? url : `${url}/`);
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
