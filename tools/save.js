/**
 * Saving from the tools.
 *
 * Writes straight to src/data/ through the studio API, so there is no
 * download-and-move step. Across 43 nodes and three tools that step was the
 * most tedious part of building the tour.
 *
 * Falls back to a download if the API is not reachable — the tools stay usable
 * if someone opens them without the dev server, they just cannot write.
 */

const API = '/tour/api';

/**
 * @param {'alignment'|'nodes'|'brands'} file
 * @param {object} payload
 * @returns {Promise<{ok: boolean, saved?: string, error?: string}>}
 */
export async function saveData(file, payload) {
  try {
    const response = await fetch(`${API}/save/${file}`, {
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
