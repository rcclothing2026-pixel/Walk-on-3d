# Walk on 3D — 360° virtual tours

Turns a set of 360° photographs and a floor plan into a walkable virtual tour:
panoramas linked as a node graph, a floor-plan mini-map, clickable brand
markers, Persian RTL interface.

Each tour ships as a **self-contained static bundle** — a directory that can be
dropped into an existing Laravel app at `public/tour/`, or handed to whoever is
paying for it and served from anywhere. No server-side rendering, no build-time
API calls.

**Any venue, no code changes.** A tour is a folder under `tours/<slug>/` that
owns its own roster, floor plan, link graph and brands. Adding a second venue is
a folder, not a fork. The first tour in this repo is `hammam`, a historic
courtyard bathhouse complex.

## Status

| Phase | | |
|---|---|---|
| 1 | Image pipeline | **done — awaiting review** |
| 2 | Alignment tool | **done — awaiting review** |
| 3 | Hotspot picker | **done — awaiting review** |
| 4 | Viewer | **done — awaiting review** |
| 5 | Mobile & polish | **done — awaiting review** |
| 6 | Deployment | **done — awaiting review** |
| 7 | Multi-tour + venue editor | **done — awaiting review** |

## Setup

Everything runs locally. Nothing is uploaded anywhere — the photographs never
leave the machine.

```bash
npm install
npm run dev
```

Then open **http://localhost:5173/tour/tools/studio.html** — the studio is the
front door: it lists the venues, shows what is done and what is not, and links
into the right tool for the next missing step.

Node 22+ and `npm install` is the whole setup; sharp ships prebuilt binaries, so
there is no native toolchain. `poppler` (`pdftoppm`) is needed only to cut a
floor plan out of an architect's PDF.

The dev server serves everything under **`/tour/`**, matching where it lives in
production, so a path that works locally works deployed. Every page and every
API call carries `?tour=<slug>`:

| | |
|---|---|
| the studio | `/tour/tools/studio.html?tour=hammam` |
| the tour | `/tour/?tour=hammam` |
| the tools | `/tour/tools/{align,hotspots,map}.html?tour=hammam` |

## A new venue, start to finish

Nothing below needs a terminal after `npm run dev`.

1. **Create the tour.** In the studio, **+ Tour** — a slug and a title. That
   writes `tours/<slug>/` with an empty roster.
2. **Upload the floor plan.** Open `tools/map.html`, press **Floor plan…** and
   pick a PNG, a JPG, or the architect's PDF. A PDF is rendered and cropped to
   the drawing automatically.
3. **Place the shooting points.** In **Add** mode, click the plan once per
   camera position. Each click creates a node and places it in one action.
4. **Draw the links.** In **Link** mode, click a node then the node you can walk
   to from it. Clicking the same pair again removes the link. **Rebuild** turns
   the links into arrows.
5. **Assign the photographs.** Back in the studio, drag each thumbnail onto its
   node, rename the nodes, then **process** to build the renditions.
6. **Align and aim.** `tools/align.html` sets each panorama's north;
   `tools/hotspots.html` puts each arrow where the doorway actually is.
7. **Build.** `npm run build` emits `dist/<slug>/` — that directory *is* the
   deliverable.

Steps 2–4 are the venue editor; step 5 is the studio; steps 6–7 are unchanged
from a single-tour build.

## Where a tour lives

```
tours/<slug>/
  tour.json        title, start node, where the photographs are, map cutoff
  names.json       the roster — which nodes exist, and their names
  links.json       which nodes connect to which
  nodes.json       generated: the graph the viewer walks
  alignment.json   each panorama's north
  brands.json      brand pins
  floorplan.png    the mini-map drawing
panos/<slug>/      generated renditions — hundreds of MB, never committed
dist/<slug>/       the built bundle for that venue
```

`panos/` sits outside `tours/` on purpose: it is the only part measured in
hundreds of megabytes, and nothing that large should be inside the folder that
describes a venue.

## The studio

`/tour/tools/studio.html` — a venue picker, then one screen per venue: every
node, with columns of state — photo assigned, renditions built, alignment
recorded, arrows picked, position on the plan. Each row links into the tool that
does the next missing step, at that node, plus a **rebuild** button for when a
photo has been replaced.

It is also where the roster is edited: **drag a thumbnail onto a node** to
assign that photograph, rename a node in place, add a node, remove one. Photos
that belong to no node sit in a tray at the bottom.

The tools **save straight into `tours/<slug>/`**; there is no download-and-move
step. That runs through a small API in `scripts/dev-api.js` mounted on the Vite
dev server.

That API is **development only** — the plugin declares `apply: 'serve'`, so none
of it exists in `npm run build` or in the deployed bundle. It writes to disk and
spawns the image pipeline, so it has to stay that way. Everything it can touch
is fixed up front: every request is scoped to one `?tour=` slug, slugs are
validated against a strict pattern so none can climb out of `tours/`, writes go
only to that tour's whitelisted files, and the only processes it spawns are this
project's own scripts, with arguments passed as argv elements and never through
a shell.

If the API is unreachable the tools fall back to downloading the JSON, so they
still work if opened without the dev server.

## Replacing a photo

The pipeline is incremental, so fixing one bad panorama is cheap:

1. Drop the corrected export into the tour's photo folder, or drag it onto the
   node in the studio.
2. Press **rebuild** on that row in the studio (or
   `npm run process -- --tour=hammam --only=17`).
3. Re-check its alignment and arrows if the camera moved.

Nothing else is touched.

## Phase 1 — image pipeline

Put the Insta360 Studio exports in `raw/` as `01.jpg` … `43.jpg`, numbered in
route order to match the node table. They must be exported as **"Export 360
Photo (not reframed)"** — the pipeline warns if a source is not 2:1, which is
the usual sign of a reframed export.

```bash
npm run process
```

Emits three renditions per node into `panos/`:

| rendition | size | quality | role |
|---|---|---|---|
| `NN-thumb.jpg` | 1024×512 | 70 | instant placeholder while the real pano loads |
| `NN-mid.jpg` | 4096×2048 | 80 | the default panorama |

The 8192×4096 `full` rendition is **deliberately not built**. 4096×2048 already
exceeds the screens this runs on, and the extra copy roughly triples both the
disk footprint and the upload to the server for a difference only visible under
heavy zoom. Re-enabling it is adding `'full'` back to `RENDITION_ORDER` in
`src/lib/paths.js` — the pipeline, the manifest, the quality manager and the
build report all read from there.

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
# then open http://localhost:5173/tour/tools/align.html
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

**Save** writes `tours/<slug>/alignment.json`. The tool reads that file back on
load, so alignment can be done across several sittings. Nodes you have not visited are written as `{ "pan": 0, "todo": true }`
so an untouched node can never be mistaken for a deliberate 0°.

Two things worth knowing:

- **Nothing is persisted automatically.** The project rules forbid
  localStorage, so values live in memory until you download them. The page
  warns before unload, and prompts before you leave a node with an unsaved
  value.
- **A node with no panorama** shows the expected filename and the command to
  generate it, rather than Photo Sphere Viewer's generic error.

## The floor plan

`tours/<slug>/floorplan.png` is what the mini-map draws and what the venue
editor measures against. There are two ways to get one there: **Floor plan…** in
`tools/map.html`, which takes an image or a PDF, or the command line:

```bash
npm run floorplan -- --tour=hammam
```

The hammam's is cut from the architect's AutoCAD sheet,
`tours/hammam/blueprint.pdf` — an A3 sheet titled
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
npm run floorplan -- --tour=hammam --pdf=blueprint-r4.pdf   # a revised sheet
npm run floorplan -- --tour=hammam --width=2400 --dpi=600   # more resolution
npm run floorplan -- --tour=hammam --keep-render            # keep the full page
```

Everything reads the plan through `floorplanUrl()` in `src/lib/paths.js`, so
swapping it is a one-file change.

### Node positions on the plan — still to be done

The mini-map needs an x/y for every node measured on this drawing. Photo Sphere
Viewer's map plugin cannot draw *at all* without one: its renderer returns early
when the current node has no centre. Until at least one node is placed, the tour
leaves the map plugin out entirely and says so in the console.

`tools/map.html` produces them — see below. The shooting points in
`docs/shooting-plan.jpg` cannot be transferred mechanically: that is a
perspective photo of a different drawing under its own numbering.

### Cosmetic note

The plan still carries its survey callouts (`−5/00`, `−3/20`, the level
markers) and the `حمام` / `حیاط خلوت` / `WC` labels. At mini-map size these
read as faint specks. Stripping them means editing the vector, so it is left
until the mini-map exists and it is clear whether they actually hurt.

## Phase 3 — link graph and hotspots

`tours/<slug>/links.json` holds the link graph as a flat list of node pairs, and
`scripts/graph.js` expands it to a symmetric adjacency map. It is **data, not
code**: a venue's connections are drawn in `tools/map.html`, and nothing about
the hammam's shape is baked into the build.

```bash
npm run nodes -- --tour=hammam   # generate tours/hammam/nodes.json
npm run nodes -- --check         # audit every tour on disk, write nothing
npm run nodes -- --tour=hammam --reset   # discard picked arrow angles
```

`--check` runs across every tour, because auditing is harmless. Generating
demands an explicit `--tour=`: writing to a venue picked for you is not.

Re-running **merges**: hand-picked arrow angles and map points survive, only the
structure is rebuilt.

Validation splits findings deliberately. **Errors fail the build** — a one-way
link, or a link to a node that does not exist. **Warnings are printed and left
for a human** — an unreachable node, or a node with fewer links than expected.
The check runs against the emitted structure rather than the graph it came from,
so a hand edit or a bad export from the picker is caught.

Links whose arrows have not been picked yet are auto-placed, spread evenly
around the horizon at −20° and flagged `"auto": true`. That is what lets the
tour be walkable before a single hotspot exists — the arrows simply point in
arbitrary directions until someone picks them.

### tools/hotspots.html

Loads a node with its alignment applied and lists its neighbours from the graph.
Pick a target, click where its arrow belongs. Targets are not free-form, so an
arrow cannot point somewhere the graph does not connect to. Every link on the
node is drawn at once — the active one highlighted, anything outside the −15°
to −30° band in the warning colour.

**Tab** cycles targets, **PgUp/PgDn** changes node, **R** resets a link to auto.

### tools/map.html — the venue editor

Three modes, switched with the buttons or **1** / **2** / **3**:

| | |
|---|---|
| **Place** | click the plan to position the selected node; placing advances to the next unplaced one, so the list can be worked straight down |
| **Add** | click the plan to create a node there — this is how a venue gets its nodes in the first place |
| **Link** | click a node, then the node you can walk to from it. The same pair again removes the link. **Esc** cancels a half-drawn one |

**Floor plan…** replaces the drawing — PNG, JPG, or the architect's PDF, which
is rendered and cropped on the way in. If the new plan is a different size and
points have already been placed, it says so and offers to scale them rather than
moving them silently: the same drawing re-exported scales cleanly, a different
drawing does not, and only the operator knows which this is.

**Save** writes `nodes.json` and `links.json` together — they are edited in one
pass, and saving one without the other leaves a plan whose dots and connections
disagree. **Rebuild** then regenerates the graph so the new links become arrows.

Coordinates are stored in the plan's own pixel space, so they survive a
re-export at a different display size.

The page works on a venue that has nothing at all: no floor plan, no nodes, no
graph. That is the point — it is what produces them.

## Phase 4–5 — the tour

`src/main.js`. Virtual tour in `3d` mode, mini-map, brand markers, RTL side
panel, deep links, quality manager.

- **Preloading** is the plugin's `preload: true`, which fetches every linked
  node's panorama on arrival — verified by watching all five of node 06's
  neighbours load on entry.
- **`src/lib/quality.js`** keeps the thumb/mid/full policy in one module. `mid`
  is always the first fetch; `full` is an upgrade applied only after the user
  zooms past a threshold, never on a connection under ~2 Mbps, and with the
  camera held in place so the swap is invisible.
- **`?node=17`** opens at a node; the URL tracks movement via `replaceState`.
- **The brand panel** closes three ways: Escape, backdrop, node change.
- **`brands.json` may be empty** — the marker layer then contributes nothing
  rather than breaking.
- **The mini-map** is hidden on nodes 1–3 and appears from node 4.
- **The navbar differs by input type.** On touch the four `move` arrows are
  dropped (you drag to look) and a gyroscope toggle appears, off by default.
  The gyroscope is implemented directly against `DeviceOrientationEvent` rather
  than adding `@photo-sphere-viewer/gyroscope-plugin`, which is not on the
  approved dependency list.
- **`prefers-reduced-motion`** disables the inter-node transition.

### Known issue

Under touch emulation the **first tap on any navbar button is lost**: the bar
re-lays out during the press and the pointer ends up over a different element.
This affects Photo Sphere Viewer's own buttons identically — confirmed against
the built-in fullscreen button — so it is library behaviour, not something these
custom controls introduced. Priming the touch class and re-measuring after the
webfont settles were both tried and neither helped, so neither was kept. **Worth
checking on a real device** before deciding whether to work around it.

## Phase 6 — build and deployment

```bash
npm run build
```

Runs `npm run nodes -- --check` across every tour first, so a broken graph fails
the build before Vite starts. Then Vite builds once, and `scripts/bundle.js`
emits **one directory per venue** — `dist/<slug>/` — printing each bundle's
weight by group and its per-node panorama weight, with the 10-node walk checked
against the 15 MB budget.

`dist/<slug>/` **is** the payload for that venue — copy its contents into
Laravel's `public/tour/`. There is no nesting to unpick: every path inside a
bundle is resolved relative to `index.html`, so the same directory works at
`/tour/`, at a subdirectory, or at the root of its own domain. That is what
makes a bundle handable to a customer.

Panoramas are **not** in the bundle. They live in `panos/<slug>/` at the project
root, outside `publicDir`, precisely so that several hundred megabytes are never
copied into `dist/`. Upload them to `<bundle>/panos/` separately, or to object
storage with `VITE_PANO_BASE_URL` pointing at it. During development a small
Vite middleware serves them at `/tour/t/<slug>/panos/`.

Deployment files:

| file | goes to |
|---|---|
| `deploy/.htaccess` | `public/tour/.htaccess` |
| `deploy/routes.php` | merge into `routes/web.php` |

The cache policy is deliberately split: panoramas and hashed assets immutable
for a year, `index.html` always revalidated (it is what points at the current
asset hashes), tour JSON on a short TTL because the tools edit it.

## Image paths

`src/config.js` decides where everything is fetched from, and it resolves
against the page rather than a site root — `BASE_URL` is `'./'` in a built
bundle, and `/tour/t/<slug>/` in development, where one server hosts every
venue. Both modes see identical relative paths, which is the point: a path that
works locally works deployed.

`PANO_BASE_URL` is the one part that can be moved independently, since it is the
only part measured in hundreds of megabytes. Point `VITE_PANO_BASE_URL` at Arvan
Cloud object storage at build time and nothing else changes.

`src/lib/paths.js` is imported by both the Node pipeline and the browser
bundle, so the filename convention cannot drift between the two.

## Node names

`tours/<slug>/names.json` — one line per node, edited from the studio. Names
flagged `"unconfirmed": true` still need verifying on site; in the hammam that
is nodes 08, 12 and 33.

Keys are zero-padded (`"01"` … `"43"`) to match the panorama filenames. One
catch: `Object.keys()` does **not** return them in tour order, because JS hoists
canonical integer-like keys — `"10"`…`"43"` come out before `"01"`…`"09"`.
Read the roster through `loadRoster()` (Node) or `tourData.numbers()` (browser),
both of which sort numerically; don't iterate the object.

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
answer. Until it is settled, `tours/hammam/names.json` still holds the brief's 43
nodes, and the roster is read from that one file, so switching to the plan's
numbering is a single-file edit.

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
   guess about the physical space. **Still open** — every build warns about it.
   Drawing the edge takes two clicks in `tools/map.html`'s Link mode, but which
   two nodes is a question about the building, not the data.
2. **The "fewer than two links" build assertion would fail on 14 nodes, not
   2.** The brief exempts 23 and 43 as true dead ends, but nodes 1, 7, 10, 13,
   15, 17, 18, 20, 25, 28, 34 and 39 also have exactly one link. Most are
   booths hanging off a corridor, which is a normal shape for this kind of
   plan — so the exempt list probably just needs widening rather than the
   graph needing more edges.

Everything else checks out: 52 edges, all bidirectional, and every node except
30 is reachable from node 1.

## Ground rules

- Photographs and `panos/` are not committed.
- No `localStorage` / `sessionStorage` anywhere.
- No dependency is added without asking first. `three` is the only one added
  beyond the brief's list, and only because Photo Sphere Viewer requires it as
  a peer.
- An alignment, hotspot or coordinate that looks wrong is flagged, never
  silently corrected.
- No CSS framework — plain CSS with custom properties.
- Vazirmatn is self-hosted as woff2; Google Fonts is not reliably reachable.
