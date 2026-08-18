import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';

import { devApi } from './scripts/dev-api.js';
import { gate } from './scripts/gate.js';

/**
 * A built tour is self-contained — its page, data, floor plan and panoramas all
 * sit in one directory that can be handed to a customer and dropped anywhere.
 * Everything is therefore addressed relative to the page.
 *
 * Development is the awkward case: one server hosts every tour at once, so
 * there is no single directory to be relative to. The middleware below
 * synthesises the deployed layout per tour under /tour/t/<slug>/:
 *
 *   /tour/t/<slug>/data/nodes.json   →  tours/<slug>/nodes.json
 *   /tour/t/<slug>/floorplan.png     →  tours/<slug>/floorplan.png
 *   /tour/t/<slug>/panos/04-mid.jpg  →  panos/<slug>/04-mid.jpg
 *
 * Both modes therefore see identical relative paths, which is the point: a path
 * that works locally works deployed.
 *
 * Panoramas live outside tours/ deliberately. They are hundreds of megabytes
 * per venue and must never be copied into a bundle or committed.
 */
export default defineConfig({
  base: '/tour/',
  publicDir: 'public',
  server: {
    // Vite refuses requests whose Host header it does not recognise, which is
    // what stops a stranger's DNS record from pointing at this machine. Behind
    // a tunnel the Host is the public hostname, so it has to be named:
    //
    //   WALK_HOSTS=studio.example.ir            in the studio's env file
    //
    // Unset, only loopback works — the right default for a laptop.
    allowedHosts: (process.env.WALK_HOSTS ?? '')
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
  },
  // Both plugins are dev-only (`apply: 'serve'`): they read and write project
  // files, so they must never be part of a build.
  // gate() is first on purpose: when WALK_TOKEN is set nothing else gets to see
  // the request until the caller has proved who they are.
  plugins: [gate(), serveTours(), devApi()],
});

/** Serves each tour's data, floor plan and panoramas in its deployed shape. */
function serveTours() {
  const root = process.cwd();

  return {
    name: 'serve-tours',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/tour/t', (req, res, next) => {
        const url = decodeURIComponent((req.url ?? '').split('?')[0]);
        const [, slug, ...rest] = url.split('/');
        const tail = rest.join('/');

        if (!isSafeSlug(slug) || !tail) return next();

        const file = resolve(root, slug, tail);
        if (!file || !isFile(file)) return next();

        res.setHeader('Content-Type', contentType(file));
        res.setHeader('Cache-Control', 'no-cache');
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

/**
 * Maps a request tail onto a real file.
 *
 * Returns null for anything outside the two directories a tour owns, so a
 * crafted path cannot reach the rest of the project.
 */
function resolve(root, slug, tail) {
  const bases = {
    'data/': path.join(root, 'tours', slug),
    'panos/': path.join(root, 'panos', slug),
  };

  for (const [prefix, base] of Object.entries(bases)) {
    if (!tail.startsWith(prefix)) continue;
    const file = path.join(base, tail.slice(prefix.length));
    return file.startsWith(base + path.sep) ? file : null;
  }

  // Everything else is a file at the root of the tour folder, such as the plan.
  const base = path.join(root, 'tours', slug);
  const file = path.join(base, tail);
  return file.startsWith(base + path.sep) ? file : null;
}

function isSafeSlug(slug) {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug ?? '');
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function contentType(file) {
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  if (file.endsWith('.png')) return 'image/png';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  return 'image/jpeg';
}
