/**
 * Saving from the tools, and knowing which tour is being edited.
 *
 * Writes straight into the tour's folder through the studio API, so there is no
 * download-and-move step. Across dozens of nodes and several tools that step
 * was the most tedious part of building a tour.
 *
 * Falls back to a download if the API is not reachable, so the tools stay
 * usable when opened without the dev server — they just cannot write.
 */

const API = '/tour/api';

/**
 * The tour these tools are editing, read from the URL on every call.
 *
 * Not captured once at module load: the studio switches tours by rewriting the
 * query string, so a snapshot taken at import time would still be the tour the
 * page happened to open with, and every link would carry the wrong venue.
 */
export function tourSlug() {
  return new URLSearchParams(location.search).get('tour') ?? '';
}

/** Appends the tour to a query string, so every call is scoped to one venue. */
export function withTour(url, params = {}) {
  const query = new URLSearchParams({ tour: tourSlug(), ...params });
  return `${API}${url}?${query}`;
}

/** Keeps ?tour= when linking between tools, so the selection survives. */
export function tourLink(href, params = {}) {
  const url = new URL(href, location.origin);
  url.searchParams.set('tour', tourSlug());
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.pathname + url.search;
}

/**
 * @param {'alignment'|'nodes'|'brands'|'sources'|'names'} file
 * @param {object} payload
 */
export async function saveData(file, payload) {
  try {
    const response = await fetch(withTour(`/save/${file}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const result = await response.json();
    if (!response.ok) return { ok: false, error: result.error ?? String(response.status) };

    return { ok: true, saved: result.saved };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** The fallback when there is nowhere to write to. */
export function downloadJson(filename, payload) {
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');

  a.href = url;
  a.download = filename;
  a.click();

  URL.revokeObjectURL(url);
}
