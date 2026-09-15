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

### Re-taking these numbers

```sh
make verify                 # peaks appear in the [attrs …] and [layers …] log lines
free -m                     # available memory before starting
```

Close the Playwright test servers and other editor processes first if the margin matters; they held
about 1 GB during these runs.
