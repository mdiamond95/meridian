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
