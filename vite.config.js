import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';

import { devApi } from './scripts/dev-api.js';

/**
 * The tour is served from Laravel's `public/tour/`, so `base` is '/tour/' in
 * both dev and build. Keeping the same base in both means a path that works in
 * development works in production — the alternative ('./') silently rewrites
 * root-relative URLs in index.html and leaves them disagreeing with the ones in
 * the stylesheet.
 *
 * The dev server therefore serves the tour at http://localhost:5173/tour/ and
 * the tools at /tour/tools/align.html.
 *
 * Panoramas live in `panos/` at the project root rather than in `public/`
 * on purpose: publicDir is copied wholesale into dist, and 43 nodes is
 * several hundred megabytes that must not be part of the bundle. They are
 * uploaded to public/tour/panos/ (or object storage) separately, and served
 * during development by the middleware below.
 */
export default defineConfig({
  base: '/tour/',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
  },
  // Both are dev-only (`apply: 'serve'`): the API writes to disk and spawns the
  // image pipeline, so it must never be part of a build.
  plugins: [servePanoramas(), devApi()],
});

/** Serves ./panos at /tour/panos/ during development only. */
function servePanoramas() {
  const dir = path.resolve(process.cwd(), 'panos');

  return {
    name: 'serve-panoramas',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/tour/panos', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '').split('?')[0]);
        const file = path.join(dir, rel);

        // Never let a crafted path escape the panorama directory.
        if (!file.startsWith(dir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          next();
          return;
        }

        res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'image/jpeg');
        res.setHeader('Cache-Control', 'no-cache');
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}
