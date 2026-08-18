/**
 * A door on the studio.
 *
 * The builder was written to run on a laptop behind a locked front door: its
 * API writes project files and spawns the image pipeline, and it asks nobody
 * who they are. That is fine on localhost and catastrophic the moment the
 * machine is reachable from the internet — which is exactly what putting it
 * behind a tunnel does.
 *
 * So: set WALK_TOKEN in the environment and every request must carry it. Leave
 * it unset and this is completely inert, so working locally is unchanged.
 *
 * This is a bolt, not a security system. It stops the studio being wide open;
 * it does not replace putting Cloudflare Access (or any real identity layer) in
 * front of the tunnel, which is what you want if more than one person ever
 * needs in.
 */

import { timingSafeEqual } from 'node:crypto';

const COOKIE = 'walk_token';

/** How long a browser stays signed in after presenting the key once. */
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

export function gate() {
  const secret = (process.env.WALK_TOKEN ?? '').trim();

  if (!secret) {
    return {
      name: 'walk-gate',
      apply: 'serve',
      configureServer() {
        // Said once at startup rather than never: an unguarded studio is the
        // right default on a laptop and the wrong one anywhere else, and the
        // difference should not be silent.
        if (process.env.WALK_EXPECT_TOKEN) {
          console.warn('\n  [gate] WALK_TOKEN is empty — the studio is open to anyone who can reach it.\n');
        }
      },
    };
  }

  if (secret.length < 24) {
    throw new Error('WALK_TOKEN is too short to be worth having — use at least 24 characters.');
  }

  return {
    name: 'walk-gate',
    apply: 'serve',

    configureServer(server) {
      // Ahead of everything, including Vite's own middleware, so no asset or
      // module graph request slips past.
      server.middlewares.use((req, res, next) => {
        if (presented(req, secret)) return next();

        const url = new URL(req.url ?? '/', 'http://studio');
        const key = url.searchParams.get('key');

        if (key && matches(key, secret)) {
          // Accepted from the query string once, then moved into a cookie and
          // stripped from the URL — a key in an address bar ends up in history,
          // in screenshots and in any log the tunnel keeps.
          url.searchParams.delete('key');
          res.setHeader('Set-Cookie',
            `${COOKIE}=${encodeURIComponent(secret)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax`);
          res.statusCode = 302;
          res.setHeader('Location', url.pathname + (url.search || ''));
          return res.end();
        }

        res.statusCode = 401;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(
          '<!doctype html><meta charset="utf-8">' +
          '<title>Studio</title>' +
          '<body style="font:16px/1.6 system-ui;margin:12vh auto;max-width:34em;padding:0 1em">' +
          '<h1 style="font-size:1.3em">This studio is closed to you.</h1>' +
          '<p>Add <code>?key=…</code> to the address once, and this browser stays signed in.</p>' +
          '</body>',
        );
      });
    },
  };
}

function presented(req, secret) {
  const header = req.headers['x-walk-token'];
  if (typeof header === 'string' && matches(header, secret)) return true;

  const cookies = String(req.headers.cookie ?? '');
  for (const part of cookies.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE && matches(decodeURIComponent(rest.join('=')), secret)) return true;
  }

  return false;
}

/** Constant-time, so the token cannot be recovered a character at a time. */
function matches(given, secret) {
  const a = Buffer.from(String(given));
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
