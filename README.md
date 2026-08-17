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
| 2 | Alignment tool | **done — awaiting review** |
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

## Phase 2 — alignment tool

Each panorama was shot with the camera facing a different direction, so yaw 0°
means something different in every file. This records, per node, the
`sphereCorrection.pan` that rotates the sphere onto one common reference
direction. It has to be done before any hotspot work — arrows placed on
unaligned nodes would all point wrong.

```bash
npm run dev
# then open http://localhost:5173/tools/align.html
```

Per node:

1. **Home** (or "Center view") parks the camera at yaw 0.
2. Drag the slider, or hold **←/→**, until your reference direction sits under
   the crosshair. **Shift+←/→** moves 10° at a time.
3. **Enter** records the value and advances to the next node.

The reference direction is yours to choose — building north, the courtyard's
main axis, anything — as long as it is the *same* real-world direction in every
node. The tour never displays an absolute bearing, so only consistency matters.

`?node=17` opens the tool straight at a node. **PgUp/PgDn** step through them.

When you are done, **Download** and save the file to `src/data/alignment.json`.
The tool reads that file back on load, so alignment can be done across several
sittings. Nodes you have not visited are written as `{ "pan": 0, "todo": true }`
so an untouched node can never be mistaken for a deliberate 0°.

Two things worth knowing:

- **Nothing is persisted automatically.** The project rules forbid
  localStorage, so values live in memory until you download them. The page
  warns before unload, and prompts before you leave a node with an unsaved
  value.
- **A node with no panorama** shows the expected filename and the command to
  generate it, rather than Photo Sphere Viewer's generic error.

## The floor plan

`public/tour/floorplan.png` is generated from the architect's AutoCAD sheet:

```bash
npm run floorplan
```

Source is `docs/blueprint-basement-r3.pdf` — an A3 sheet titled
**زیر زمین ‑ حمام** (basement / hammam), showing the main level at −5.00, the
حیاط خلوت courtyard and WC at −3.20, and the entrance staircase arriving at
±0.00. That matches the tour's shape: nodes 1–3 descend a staircase, and the
body of the tour sits below.

The script needs `pdftoppm` from poppler-utils — a system tool, not an npm
dependency (`apt-get install poppler-utils` / `brew install poppler`).

It does not carry a hardcoded crop box. It renders the page, measures the ink
in each row, takes the tallest contiguous band as the drawing, and crops to
that band's extent — so a revised sheet with the plan in a different position
still works. Output is a 16-colour palette PNG, which is plenty for a line
drawing and about 4× smaller than greyscale.

```bash
npm run floorplan -- --pdf=docs/blueprint-r4.pdf   # a revised sheet
npm run floorplan -- --width=2400 --dpi=600        # more resolution
npm run floorplan -- --keep-render                 # keep the full page to inspect
```

Everything reads the plan through `floorplanUrl()` in `src/lib/paths.js`, so
swapping it is a one-file change.

### Still missing: node positions on the plan

The mini-map needs an x/y for every node **on this drawing**. What exists today
is a set of shooting points on a *different* drawing — the photographed event
board in `docs/shooting-plan.jpg`, which is perspective-distorted and uses its
own numbering. Those positions cannot be transferred mechanically.

The cheapest fix is a small picker along the lines of `tools/align.html`: show
the floor plan, click once per node, emit the coordinates. That is Phase 4 work
and it needs the numbering question below settled first.

### Cosmetic note

The plan still carries its survey callouts (`−5/00`, `−3/20`, the level
markers) and the `حمام` / `حیاط خلوت` / `WC` labels. At mini-map size these
read as faint specks. Stripping them means editing the vector, so it is left
until the mini-map exists and it is clear whether they actually hurt.

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

### 1. The shooting plan and the node table disagree — BLOCKING for Phase 3

`docs/shooting-plan.jpg` is the marked-up floor plan. It is titled **"SHOOTING
POINTS (44)"** and its numbering is **not** the brief's numbering. This has to
be settled before hotspots are placed, because every link and every arrow is
keyed to node numbers.

What is certain:

- **The plan has 44 points; the node table has 43 nodes.**
- **The two hubs are numbered differently.** The plan's red "shoot twice"
  points are **34** and **36**. The table's hubs are **35** (چهارسوق ماجرا) and
  **37** (حیاط).
- **Nodes 1–3 describe different things.** On the plan they are purple
  "Entrance approach" points on the approach walkway, with the stairs marked
  separately in orange. In the table they are the stair descent — سر پله /
  میان پله / پای پله.
- **The plan has a category the brief never mentions: "Hub — shoot twice."**
  If each hub yields two panoramas, the raw file count is 46, not 43.
- **The plan marks four orange stair points (39–42).** The table has stair-type
  nodes at 1, 2, 3, 40 and 41.

Across the upper range the plan runs consistently one *behind* the table —
plan 33/34/35/36/37/38 line up with table 34/35/36/37/38/39 (اتاق مخفی سلطان,
چهارسوق ماجرا, میتلونه, حیاط, دربار نقره, Sponsor). But that single offset does
**not** hold across the whole plan: the orange stair points and the C20 /
حوضخانه end run the other way. So this is not one clean off-by-one that can be
applied mechanically — at least one extra point has been inserted somewhere in
the low range, and the photo is too perspective-distorted to say where with
confidence.

**Which numbering is authoritative?** Everything downstream keys off the
answer. Until it is settled, `src/data/names.json` still holds the brief's 43
nodes, and the node roster is read from that one file (see `src/lib/nodes.js`)
so switching to the plan's numbering is a single-file edit.

Note that `docs/shooting-plan.jpg` is a photo of a physical board, shot at an
angle, with markers and a legend overlaid. It is reference material only. The
mini-map's actual plan now comes from the architect's PDF — see
[The floor plan](#the-floor-plan).

### 2. Problems inside the brief's own link graph

Two more things need a decision before Phase 3 wires up hotspots. Flagging
rather than guessing:

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
