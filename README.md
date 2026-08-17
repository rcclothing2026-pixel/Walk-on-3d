# Walk on 3D — 360° virtual tour

A self-contained 360° virtual tour of a historic courtyard complex: 43
equirectangular panoramas linked as a walkable node graph, with a floor-plan
mini-map and clickable brand markers.

Ships as a static bundle that drops into an existing Laravel 11 app at
`public/tour/`. No server-side rendering, no build-time API calls.

UI language is Persian, RTL.

## Status

| Phase | | |
|---|---|---|
| 1 | Image pipeline | **done — awaiting review** |
| 2 | Alignment tool | not started |
| 3 | Hotspot picker | not started |
| 4 | Viewer | not started |
| 5 | Mobile & polish | not started |
| 6 | Deployment | not started |

## Setup

```bash
npm install
```

`sharp` is the only heavy dependency and ships prebuilt binaries; no native
toolchain needed.

## Phase 1 — image pipeline

Put the Insta360 Studio exports in `raw/` as `01.jpg` … `43.jpg`, numbered in
route order to match the node table. They must be exported as **"Export 360
Photo (not reframed)"** — the pipeline warns if a source is not 2:1, which is
the usual sign of a reframed export.

```bash
npm run process
```

Emits three renditions per node into `public/tour/panos/`:

| rendition | size | quality | role |
|---|---|---|---|
| `NN-thumb.jpg` | 1024×512 | 70 | instant placeholder while the real pano loads |
| `NN-mid.jpg` | 4096×2048 | 80 | the default panorama |
| `NN-full.jpg` | 8192×4096 | 82 | fetched only when the user zooms past a threshold |

Options:

```bash
npm run process -- --only=1,5,17-20   # a subset
npm run process -- --force            # rebuild even if outputs are current
npm run process -- --concurrency=4    # default 2; these are 71 MP decodes
npm run process -- --no-mozjpeg       # plain libjpeg encoding
```

Reruns are incremental: a rendition is skipped when it exists and is not older
than its source. The run prints a per-node size table, the totals, and a
10-node-walk estimate checked against the 15 MB budget from the acceptance
criteria. It exits non-zero if any raw file is missing.

### Notes on the implementation

- **Metadata.** All EXIF (including GPS) is stripped. The XMP block is kept
  when present, because that is where the GPano projection metadata lives —
  and its pixel dimensions are rescaled per rendition, so a 4096px file does
  not advertise itself as an 11904px panorama.
- **Resampling.** Each rendition is resized from the original rather than
  cascading full → mid → thumb. One extra decode per rendition, but no
  compounding of resampling error.
- **mozjpeg** is on by default. It is part of sharp, not an extra dependency,
  and buys roughly 10–15% at the same visual quality — which matters directly
  for the transfer budget. `--no-mozjpeg` turns it off.
- **Seam.** sharp does not wrap horizontally when resampling, so the 0°/360°
  seam is resampled as an edge. At these scales the artifact is sub-pixel and
  invisible in the viewer; noting it in case a seam ever looks suspect.
- **`manifest.json`** is written alongside the panoramas with the byte size of
  every rendition. Phase 4's quality manager reads it to decide whether
  fetching `full` is worth it on the current connection. It is merged, not
  overwritten, so `--only` runs do not erase the other nodes' entries.

## Image paths

`src/config.js` holds `IMAGE_BASE_URL`, the single place that decides where
images are fetched from. Everything else goes through `src/lib/paths.js`.
Moving the panoramas to Arvan Cloud object storage is a one-line change there
(or `VITE_IMAGE_BASE_URL` at build time).

`src/lib/paths.js` is imported by both the Node pipeline and the browser
bundle, so the filename convention cannot drift between the two.

## Node names

`src/data/names.json` — one line per node. Names flagged `"unconfirmed": true`
(nodes 08, 12, 33) still need verifying on site.

Keys are zero-padded (`"01"` … `"43"`) to match the panorama filenames. One
catch: `Object.keys()` does **not** return them in tour order, because JS hoists
canonical integer-like keys — `"10"`…`"43"` come out before `"01"`…`"09"`.
Iterate `1..43` and pad, don't iterate the object.

## Open questions on the source data

Two things in the brief's link graph need a decision before Phase 3 wires up
hotspots. Flagging rather than guessing:

1. **Node 30 (موسلک) has no links at all.** It appears in the node table but
   in no spine entry, leaf list, or cluster chain, so it is unreachable. It
   most likely belongs on the 35 hub or in the 29/31 cluster, but that is a
   guess about the physical space.
2. **The "fewer than two links" build assertion would fail on 14 nodes, not
   2.** The brief exempts 23 and 43 as true dead ends, but nodes 1, 7, 10, 13,
   15, 17, 18, 20, 25, 28, 34 and 39 also have exactly one link. Most are
   booths hanging off a corridor, which is a normal shape for this kind of
   plan — so the exempt list probably just needs widening rather than the
   graph needing more edges.

Everything else checks out: 52 edges, all bidirectional, and every node except
30 is reachable from node 1.

## Ground rules

- `raw/` and `public/tour/panos/` are not committed.
- No `localStorage` / `sessionStorage` anywhere.
- No CSS framework — plain CSS with custom properties.
- Vazirmatn is self-hosted as woff2; Google Fonts is not reliably reachable.
