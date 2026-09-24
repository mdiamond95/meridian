# Performance

Measured budgets and results. Each section says how it was measured, so the numbers can be re-taken.

## Pipeline memory on the development Codespace

### The limit is lower than the machine
- **The Codespace has 7.9 GB of RAM and no swap.** With VS Code, its extensions, the Playwright test servers and Claude Code running, about 5 GB is in use before any build starts. That leaves 2.7–2.8 GB "available" (`free -m`).
- **When available memory falls below roughly 1 GB, the Codespaces host terminates the largest process with SIGTERM.**
  - It is not the kernel OOM killer: `dmesg` shows nothing and `/sys/fs/cgroup/memory.events` counts no `oom` or `oom_kill`.
  - A wrapper that blocks SIGTERM and logs `sigwaitinfo` recorded the sender as pid 0 with a uid unknown inside the container, which means the signal came from outside the container.
  - In the traced run, available memory was 988 MB five seconds before the signal.
- **So a pipeline step has about 1.7 GB of headroom here, counting any child process such as mapshaper.** The "3 GB" target would not survive on this machine while the editor is open. It would on a runner with nothing else loaded.

### Before
- `make verify` died three times with `CalledProcessError … died with <Signals.SIGTERM: 15>`: twice in `attributes.py` and once in `polygons.py`.
- The standalone baseline of `attributes.py` reached **1,708 MB peak RSS before it started reading DAs.** At that point it held:
  - the mesh;
  - the H3 cell polygons;
  - every 2021 census subdivision (CSD) polygon;
  - the CMA polygons.
- It was then terminated while GDAL parsed the DA GeoJSON. The final peak was never reached.
- `polygons.py` held 1.36 GB of CSD, CD and province frames while mapshaper built the boundary topology. Available memory fell to 819 MB and the step was terminated.

### What changed (outputs unchanged, byte-for-byte)
- **`census.da_points`** reads DAs one province at a time (`where="PRUID = '…'"`, only `DAUID` and `PRUID`). It keeps representative points and never all polygons.
  - GDAL's GeoJSON driver still parses the whole 88 MB file on each read, about 11 s and 550 MB transient. The 13 reads add about 2 minutes to the step.
- **`census.release_memory`** runs `gc.collect()` then `malloc_trim(0)`. It is called after each heavy stage, because glibc otherwise keeps freed arenas and RSS only grows.
- **`attributes.py`:**
  - DA points are computed first, before the CSDs are loaded.
  - CMA polygons are read with only `CMATYPE`.
  - Frames are dropped after use.
  - NHN work units (about 25 M vertices) are read, dissolved and overlaid one major drainage area at a time; a sub-drainage area never spans two.
  - Aboriginal Lands are read with `where="ALTYPE = 'Indian Reserve'"`.
  - Census Profile CSVs are read with only the three columns used.
- **`polygons.py`:**
  - Each layer exports its GeoJSON in its own function, so its frames are freed before mapshaper starts, and `simplify` releases memory before it runs mapshaper.
  - The basins layer simplifies and dissolves NHN one major drainage area at a time.
- **Peak RSS is now in every `[attrs …]` and `[layers …]` log line.**

### After (2026-09-15, codespace with the editor open)

| Step | Peak RSS (Python) | Child (mapshaper) | Lowest available | Output |
|---|---|---|---|---|
| `attributes.py` alone | 1,740 MB | — | 1,340 MB | identical to SHA256SUMS |
| `polygons.py` alone | 1,646 MB (CSD dissolves) | 1,044 MB (boundaries, after Python released) | 1,241 MB | all 8 layers identical |

Measured with the `ru_maxrss` value in the step logs, plus a 3 s sampler of `free -m` and per-process RSS.

The largest remaining allocations are:
- the GeoJSON parse inside GDAL, which `malloc_trim` cannot return and about 1.5 GB of which stays resident after the DA step;
- the CSD dissolves in `polygons.py`.

Both fit the budget, with at least 240 MB of margin above the host's threshold.

### `make verify` end to end (2026-09-15)

Rebuilt every artefact from the raw inputs into a temporary directory and compared hashes:
**`verify: clean`**, about 35 minutes.

| Step | Peak process RSS | Lowest available | Margin above the ~1 GB threshold |
|---|---|---|---|
| `mesh.py` | 1,687 MB | 1,153 MB | 153 MB |
| `attributes.py` | 1,534 MB | 1,271 MB | 271 MB |
| `polygons.py` | 1,598 MB (mapshaper 1,005 MB) | 1,235 MB | 235 MB |
| `atlas.build` | 1,040 MB | 1,821 MB | 821 MB |

Sampled every 3 s across the whole run; "peak process" is the largest single process, Python or
mapshaper.

**`mesh.py` is now the tightest step.** It holds the Atlas of Canada 1:1M coverage, the candidate H3
cells and their polygons at once. It was not changed here beyond sharing the chunked DA reader, and
it is the first thing to make lean if the margin has to grow.

### `make verify` end to end again, with Sitting B's atlas (2026-09-16)

**`verify: clean`**, 01:27:40 to 02:05:56 — 38 minutes, the atlas now walking 50 events, not 25.

| Step | Peak process RSS | Lowest available |
|---|---|---|
| `mesh.py` | not instrumented | 1,128 MB |
| `attributes.py` | 1,736 MB | 1,257 MB |
| `polygons.py` | 1,650 MB | 1,368 MB |
| `atlas.build` | under 1,100 MB | over 1,700 MB |

Sampled every 5 s; the peak is the largest single process, Python or mapshaper.

**The margin is set by what else is running, not by the pipeline.** Two runs before this one were
killed at the attributes step by the same code that had passed the day before: a second VS Code
window had been opened on the `phase-2b` worktree, and its extension host and Pylance server held
about 1 GB, leaving 1.9 GB available instead of 2.6 GB. Stopping the two Pylance servers (VS Code
restarts them on demand) brought available memory back to 3.0 GB and the run finished.

So **check `free -m` before a full verify and close what you are not using. Below about 2.4 GB
available, the attributes step will be killed** — and the failure looks like a crash with no
traceback, not like an out-of-memory error.

### Re-taking these numbers

```sh
make verify                 # peaks appear in the [attrs …] and [layers …] log lines
free -m                     # available memory before starting
```

Close the Playwright test servers and other editor processes first if the margin matters; they held
about 1 GB during these runs.

## The slider's frame time (Phase 2 gate)

`npm run frame-time` in `app/`, which drives the built site headless in Chromium at the desktop and
iPad viewports (`app/tests/perf/frame-time.spec.ts`). It is deliberately **not** part of
`npm run smoke`: it measures the machine as much as the code.

**What is measured:** the main-thread work one slider step costs — from dispatching the range
input's `input` event (React flushes discrete input synchronously) to the handler returning, which
covers resolving the units for the new date, React's commit, and Leaflet adding, removing and
restyling paths. The paint that follows is reported separately, because in a headless browser that
number is mostly vsync.

### Measured 2026-09-16, 50 events, 148 unit rows

| Viewport | Date | Work, median | Work, p95 | To next frame |
|---|---|---|---|---|
| desktop | 1867 | 2.6 ms | 13.1 ms | 16.4 ms |
| desktop | 1999 | 0.7 ms | 19.2 ms | 16.8 ms |
| iPad | 1867 | 3.4 ms | 14.5 ms | 16.6 ms |
| iPad | 1999 | 0.8 ms | 21.1 ms | 16.7 ms |

**The typical step is 1–4 ms, well inside a 60 Hz frame.** The tail is the steps that cross an
event, where the map genuinely changes and Leaflet has to project and attach the new units' paths:
those cost one frame, 13–21 ms here. The test asserts the median against the 16 ms gate and guards
the p95 at 25 ms, rather than pretending an event crossing is free.

### What made it fast

Two changes, both measured:

1. **The layer cache is warmed while the browser is idle** (`AtlasLayer`), in slices of at most
   8 ms, and the map's container gets `data-atlas-warm` when every row is built. Before this, the
   *first* crossing of each event built its paths: p95 was 35 ms.
2. **The resolved set is memoized on the current event's date, not the slider's date**, so the
   steps inside one event window do no work at all. That took the median from 4.6 ms to under 1 ms
   at 1999.

Re-take with `npm run frame-time` after `npm run build`; close other editor windows first, for the
same reason as the pipeline numbers above.

## Browser tests on the Codespace (2026-09-17)

The Codespace has 8 GB, and the host terminates the largest process when free memory falls below
about 1 GB. Browser tests therefore run strictly one at a time:

- `app/playwright.config.ts` (smoke) has `workers: 1`, so desktop and iPad projects run in turn.
- `npm run determinism -w app` launches Chromium, closes it, then WebKit, then Firefox; only one engine
  is resident at any moment, and it needs no preview server.
- Order when checking by hand: `make verify` first, alone; then pytest; then `npm run build` (which
  exits); then `npm run smoke`; then `npm run determinism`. Never the build, the preview server and a
  browser engine at the same time, and never a browser run during `make verify`.

## Phase 7: event crossings, a 30-region split, memory (2026-09-24)

All numbers from `npm run frame-time -w app` after `npm run build`, on the Codespace in headless
Chromium, with the editor open. "iPad" is the 820×1180 touch viewport; the memory rows use
Playwright's full iPad Pro 11 descriptor (device scale factor 2, mobile user agent) in Chromium,
because Safari's heap cannot be read from Playwright. They are Chromium's accounting of the same
page, not an iPad's own numbers.

### Crossing an event is a visibility swap

**Before:** the Phase 2 numbers above. A step that crossed an event attached the new units' paths
inside the input handler, so Leaflet projected up to 45,000 vertices (the NWT of 1880 has 880 parts)
in that frame. Re-measured before any change: worst step 21.4 ms (desktop) and 30.8 ms (iPad) at
1867, 27.5 and 17.5 ms at 1999.

**After** (`AtlasLayer`):
- **Lookahead.** The rows of the three event windows either side of the current one stay attached,
  with `display: none` on their paths. A crossing only flips `display` on paths that are already
  projected. Rows further away are detached, because hidden paths are still re-projected on every
  zoom.
- **Refill.** After each crossing, the far edge is refilled in idle slices, nearest windows first.
  - Each row is a single path. Splitting the big drawings into one path per part was tried: 880
    elements for one row made crossings slower (up to 20 ms), and it was reverted.
  - A slice starts a row only if the row's vertex count, at 2,000 vertices per millisecond (2,750
    measured here), fits the time left. While the slider moves, the largest drawings wait until it
    has been still for 150 ms, then go in one at a time.
  - The idle request has a 250 ms timeout. Chromium once went more than 60 s without declaring an
    idle period after a pan with a split on the map, and the refill must not wait on that.
- **Styles** are set when a row is built. A crossing restyles nothing; only a change of selection
  does.

| Viewport | Date | Step work, median | p95 | **max** | Longest frame |
|---|---|---|---|---|---|
| desktop | 1867 | 1.2 ms | 2.6 ms | **3.3 ms** | 41.0 ms |
| desktop | 1999 | 0.7 ms | 1.5 ms | **1.7 ms** | 21.8 ms |
| iPad | 1867 | 1.1 ms | 5.6 ms | **7.3 ms** | 33.2 ms |
| iPad | 1999 | 0.8 ms | 3.1 ms | **5.1 ms** | 23.7 ms |

How it was measured:
- 24 one-year steps, one per frame (60 years a second), starting from a settled lookahead.
- The test now asserts the **maximum** step under 16 ms, where before it asserted the median.

**What is still over a frame is not the step.** A Chromium trace of the 1867 run shows the long
frames are young-generation GC (a 35 ms scavenge). It collects the projected points that the refill
allocated, while the slider is being dragged at 60 years a second. At a keyboard's repeat rate the
refill fits between steps.

**Limit:** a jump further than the lookahead (a tick three or more events away, or Home and End)
still attaches its rows inside the step, as before.

### A 30-region split of Canada

Canada into 30 regions with the Generate panel's defaults, drawn on the map (`tests/perf/split.spec.ts`).

| | desktop | iPad |
|---|---|---|
| Run to legend | 2.8 s | 3.0 s |
| Longest main-thread task during the run | 768 ms | 824 ms |
| Pan (drag), frame median / max | 16.7 / 50.0 ms | 16.7 / 16.8 ms |
| Hover over regions, frame max | 16.7 ms | 16.8 ms |
| Slider under the split: step max | 2.8 ms | 11.1 ms |

**The long task is the dossiers, not the drawing.** Profiled on an unminified build, the 922 ms
run is:
- `describeSplit`, 541 ms, most of it `buildDossiers` (434 ms: region aggregates 204 ms, border
  runs 197 ms);
- building the scope graph before the run, 300 ms (sea crossings 227 ms);
- dissolving the rings for the canvas, 162 ms.

The scope graph is now cached by mask (`cachedScopeGraph`), so re-running the same scope with
another N or seed skips it. The dossiers still run in the same task as the map update, because they
supply the region names on the map; moving them off the main thread is in `docs/backlog.md`.

### Memory: the whole mesh (38,432 cells) in iPad emulation

JS heap after a forced GC, and the renderer process's RSS, which includes the solver worker:

| Stage | JS heap | DOM nodes | Renderer RSS |
|---|---|---|---|
| Atlas loaded, layer cache warm | 84 MB | 433 | 244 MB |
| Splitter data decoded | 101 MB | 1,258 | 325 MB |
| Canada into 30 | 117 MB | 1,582 | 533 MB |
| With dossiers and set analysis | 116 MB | 1,011 | 594 MB |
| Run 2 | 117 MB | 1,597 | 606 MB |
| Run 3 | 117 MB | 1,597 | 698 MB |
| Run 4 | 117 MB | 1,597 | 688 MB |
| Run 5 | 117 MB | 1,597 | 692 MB |
| Run 6 | 117 MB | 1,597 | 686 MB |

- **The JS heap is flat run after run,** and the renderer levels off from the third run. The test
  asserts both: heap within 15% of the first run's, and RSS within 10% between the last two runs.
- The desktop viewport levels off at about 490 MB. The iPad descriptor's device scale factor of 2
  quadruples the canvas backing stores.
- The plan's gate says "memory under control on a 40k-cell Canada split". This is that split, and it
  is under control in Chromium. The manual iPad pass (plan Phase 7, "You do") is the check in Safari.

### Loading

- **The first view fetches only the atlas** (`atlas.v1.json` and its topology), as a smoke test now
  asserts. The mesh, attributes, cells, places, snap, contact and Indigenous artefacts wait until
  the panel or layer that needs them opens. The `data/build/layers/` TopoJSON never ships: the app
  draws nothing from it. That was already true; the plan's "lazy-load layer TopoJSON" is now tested
  rather than changed.
- **Decoded splitter data in IndexedDB,** keyed by the artefacts' fingerprinted URLs. Opening the
  Generate panel:
  - from the network: 885 ms (desktop), 899 ms (iPad);
  - from the cache: 395–465 ms.

  These are on a local server, so the network rows include no latency; over a real connection the
  cache also saves the 2 MB download. The cell topology (1.4 MB) is still fetched and parsed on
  each open.
- **The worker receives the mesh once.** Before, every run structured-cloned the mesh arrays and its
  columns into the worker. Now the mesh crosses once and each column the first time a run needs it.
  A template assignment is transferred; the result's assignment already was. The mask and snap edges
  are cloned, because the prepared split keeps them on the main thread.

### Re-taking these numbers

```sh
npm run build && npm run frame-time -w app   # frame-time.spec.ts and split.spec.ts, one at a time
```
