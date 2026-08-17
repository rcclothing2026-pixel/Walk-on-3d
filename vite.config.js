import { defineConfig } from 'vite';

/**
 * The tour ships as a static bundle dropped into Laravel's public/tour/, so
 * every asset must resolve relative to that directory rather than the domain
 * root — hence `base: './'`.
 *
 * tools/*.html (the alignment tool and the hotspot picker) are dev-only
 * instruments. They are reachable from `npm run dev` because Vite serves the
 * whole project tree, but they are deliberately not listed as build inputs, so
 * they never reach dist/.
 */
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
  },
});
