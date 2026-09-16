"""Fetch every source in docs/data-sources.md into data/raw/<id>/.

    make download                 fetch anything missing or changed
    make download ARGS="--only statcan_csd_2021 --refresh"

The URL column of docs/data-sources.md selects a fetcher:

    https://...                    plain file download (Wayback copies use id_ raw URLs)
    arcgis:<layer url>?<params>    paged ArcGIS REST query → <id>.geojson, features in OBJECTID
                                   order; the server fails often, so pages retry and shrink
    sdmx:<dataflow>:<ids>[:<n>]    StatCan Census Profile API (api.statcan.gc.ca), counts for the
                                   listed characteristic ids, n ids per request → <id>.csv
    sparql:<query file>            a SPARQL query (path relative to the repo root) sent to the Wikidata
                                   Query Service → <id>.csv, rows sorted so a rerun of an unchanged
                                   result is byte-identical
    gha:<workflow>:<artifact>:<file>
                                   the file from the latest successful run of a GitHub Actions
                                   fetch workflow (for hosts that block this machine), via `gh`
    manual:<filename>              a file that cannot be fetched from here; place it at
                                   data/raw/<id>/<filename> by hand and its hash is recorded

Idempotent: a source is skipped when MANIFEST.json already records its URL and the file on disk
still matches the recorded SHA-256. URLs may contain {ENV_VAR} placeholders; the manifest stores
the template, never the value. A source whose variable is unset is skipped with a warning.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import os
import re
import shutil
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import parse_qsl, unquote, urlencode, urlparse

import requests

from common import MANIFEST, RAW, ROOT, sha256_file, write_bytes
from dry_run import SOURCES_PATH, Report, parse_sources

PLACEHOLDER = re.compile(r"\{([A-Z][A-Z0-9_]*)\}")
LINK = re.compile(r"^<?\[?(https?://[^\s\]>)]+)")
USER_AGENT = "meridian-pipeline/1 (+https://github.com/mdiamond95/meridian)"


SDMX_BASE = (
    "https://api.statcan.gc.ca/census-recensement/profile/sdmx/rest/data/STC_CP,{flow}/A5..1.{chars}.1"
)
SDMX_COLUMNS = ["ALT_GEO_CODE", "CHARACTERISTIC", "OBS_VALUE", "FLAG"]
SPARQL_ENDPOINT = "https://query.wikidata.org/sparql"


def source_url(cell: str) -> str | None:
    """The URL cell may be `code`, <url>, [text](url), a bare URL, or an arcgis:/sdmx:/manual: spec."""
    cell = cell.strip().strip("`").strip()
    if not cell:
        return None
    if cell.startswith(("arcgis:", "sdmx:", "sparql:", "gha:", "manual:")):
        return cell
    md_link = re.search(r"\]\((https?://[^)\s]+)\)", cell)
    if md_link:
        return md_link.group(1)
    bare = LINK.match(cell)
    return bare.group(1) if bare else None


def filename_for(source_id: str, url: str) -> str:
    if url.startswith("arcgis:"):
        return f"{source_id}.geojson"
    if url.startswith(("sdmx:", "sparql:")):
        return f"{source_id}.csv"
    if url.startswith("manual:"):
        return url.removeprefix("manual:")
    if url.startswith("gha:"):
        return url.split(":")[3]
    name = unquote(Path(urlparse(url).path).name)
    if "{" in name or "." not in name:
        return f"{source_id}.json"
    return re.sub(r"[^A-Za-z0-9._-]", "_", name)


def get_with_retry(url: str, *, attempts: int = 8, timeout: int = 300, **kwargs) -> requests.Response:
    headers = {"User-Agent": USER_AGENT, **kwargs.pop("headers", {})}
    for attempt in range(1, attempts + 1):
        try:
            resp = requests.get(url, timeout=(30, timeout), headers=headers, **kwargs)
            resp.raise_for_status()
            return resp
        except requests.RequestException as exc:
            if attempt == attempts:
                raise
            print(f"    retry {attempt}: {type(exc).__name__}", file=sys.stderr, flush=True)
            time.sleep(min(60, 3 * attempt))
    raise AssertionError("unreachable")


def fetch_arcgis(spec: str, dest: Path) -> None:
    """Page through an ArcGIS REST layer. The server fails often, so pages are cached on disk
    (dest/../.pages/<hash>/<offset>.json) and a rerun resumes where the last one stopped."""
    import hashlib

    parsed = urlparse(spec.removeprefix("arcgis:"))
    layer = parsed._replace(query="").geturl()
    params = dict(parse_qsl(parsed.query))
    page_size = int(params.pop("pageSize", "1000"))
    fields = params.get("outFields", "*")
    if fields != "*" and "OBJECTID" not in fields.split(","):
        params["outFields"] = f"OBJECTID,{fields}"
    base = {"where": "1=1", "outFields": "*", "f": "geojson", "orderByFields": "OBJECTID", **params}
    cache = dest.parent / ".pages" / hashlib.sha256(spec.encode()).hexdigest()[:16]
    cache.mkdir(parents=True, exist_ok=True)

    features: list[dict] = []
    offset = 0
    while True:
        cached = cache / f"{offset:08d}.json"
        if cached.exists():
            doc = json.loads(cached.read_text(encoding="utf-8"))
        else:
            query = {**base, "resultOffset": offset, "resultRecordCount": page_size}
            doc = None
            for attempt in range(1, 13):
                try:
                    resp = get_with_retry(f"{layer}/query?{urlencode(query)}", attempts=1, timeout=600)
                    doc = resp.json()
                    if "error" in doc:
                        raise ValueError(doc["error"])
                    break
                except (requests.RequestException, ValueError, OSError) as exc:
                    if attempt >= 3 and query["resultRecordCount"] > 1:
                        query["resultRecordCount"] = max(1, query["resultRecordCount"] // 2)
                    size = query["resultRecordCount"]
                    print(f"    @{offset} retry {attempt} {type(exc).__name__} size={size}", file=sys.stderr)
                    time.sleep(min(60, 3 * attempt))
            if doc is None:
                raise requests.RequestException(f"page at offset {offset} kept failing")
            doc = {"features": doc.get("features", []), "requested": query["resultRecordCount"]}
            write_bytes(cached, json.dumps(doc, separators=(",", ":")).encode("utf-8"))
        page = doc["features"]
        features.extend(page)
        if offset // 5000 != (offset + len(page)) // 5000:
            print(f"    {offset + len(page)} features", flush=True)
        offset += len(page)
        if len(page) < doc["requested"]:
            break

    object_ids = [f["properties"]["OBJECTID"] for f in features]
    if len(object_ids) != len(set(object_ids)):
        raise ValueError("duplicate OBJECTIDs across pages; server ordering is unstable")
    features.sort(key=lambda f: f["properties"]["OBJECTID"])
    body = json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":"))
    write_bytes(dest, body.encode("utf-8"))
    shutil.rmtree(cache)


def fetch_sdmx(spec: str, dest: Path) -> None:
    """Census Profile counts (gender total, statistic = count) for a list of characteristic ids."""
    _, flow, ids, *rest = spec.split(":")
    per_request = int(rest[0]) if rest else 1
    chars = ids.split(",")
    batches = ["+".join(chars[i : i + per_request]) for i in range(0, len(chars), per_request)]

    def one(batch: str) -> list[list[str]]:
        resp = get_with_retry(
            SDMX_BASE.format(flow=flow, chars=batch),
            timeout=600,
            headers={"Accept": "application/vnd.sdmx.data+csv;version=1.0.0", "Accept-Encoding": "gzip"},
        )
        reader = csv.DictReader(io.StringIO(resp.content.decode("utf-8-sig")))
        rows = [[row[c] for c in SDMX_COLUMNS] for row in reader]
        print(f"    {flow} {batch}: {len(rows)} rows", flush=True)
        return rows

    with ThreadPoolExecutor(max_workers=4) as pool:
        rows = [row for batch_rows in pool.map(one, batches) for row in batch_rows]
    rows.sort(key=lambda r: (r[0], int(r[1])))
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(SDMX_COLUMNS)
    writer.writerows(rows)
    write_bytes(dest, out.getvalue().encode("utf-8"))


def fetch_gha(spec: str, dest: Path) -> None:
    """Download `file` from artifact `artifact` of the latest successful run of `workflow`."""
    import subprocess
    import tempfile

    _, workflow, artifact, name = spec.split(":")
    listing = subprocess.run(
        ["gh", "run", "list", "--workflow", workflow, "--status", "success", "--limit", "1",
         "--json", "databaseId", "--jq", ".[0].databaseId"],
        capture_output=True, text=True, check=True, cwd=ROOT,
    )  # fmt: skip
    run_id = listing.stdout.strip()
    if not run_id:
        raise ValueError(f"no successful run of {workflow}; trigger it first (pipeline/README.md)")
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["gh", "run", "download", run_id, "-n", artifact, "-D", tmp], check=True, cwd=ROOT)
        src = Path(tmp) / name
        checksum = Path(tmp) / f"{name}.sha256"
        if checksum.exists() and checksum.read_text().split()[0] != sha256_file(src):
            raise ValueError(f"{name} does not match the checksum recorded by the workflow")
        dest.parent.mkdir(parents=True, exist_ok=True)
        write_bytes(dest, src.read_bytes())
    print(f"    from {workflow} run {run_id}")


def fetch_sparql(spec: str, dest: Path) -> None:
    """Run a recorded query on the Wikidata Query Service and keep the CSV, header first and rows
    sorted: the service returns rows in no fixed order."""
    query = (ROOT / spec.removeprefix("sparql:")).read_text(encoding="utf-8")
    resp = None
    for attempt in range(1, 6):
        try:
            resp = requests.post(
                SPARQL_ENDPOINT,
                data={"query": query},
                headers={"User-Agent": USER_AGENT, "Accept": "text/csv"},
                timeout=(30, 120),
            )
            resp.raise_for_status()
            break
        except requests.RequestException as exc:
            if attempt == 5:
                raise
            print(f"    retry {attempt}: {type(exc).__name__}", file=sys.stderr, flush=True)
            time.sleep(15 * attempt)
    rows = list(csv.reader(io.StringIO(resp.content.decode("utf-8"))))
    if not rows:
        raise ValueError("empty SPARQL result")
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(rows[0])
    writer.writerows(sorted(rows[1:]))
    write_bytes(dest, out.getvalue().encode("utf-8"))
    print(f"    {len(rows) - 1} rows")


def resolve(template: str) -> str | None:
    missing = [var for var in PLACEHOLDER.findall(template) if not os.environ.get(var)]
    if missing:
        return None
    return PLACEHOLDER.sub(lambda m: os.environ[m.group(1)], template)


def fetch(url: str, dest: Path, attempts: int = 3) -> None:
    part = dest.with_suffix(dest.suffix + ".part")
    part.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(1, attempts + 1):
        try:
            with requests.get(
                url, stream=True, timeout=(30, 300), headers={"User-Agent": USER_AGENT}
            ) as resp:
                resp.raise_for_status()
                done, next_report = 0, 50 << 20
                with part.open("wb") as fh:
                    for chunk in resp.iter_content(chunk_size=1 << 20):
                        fh.write(chunk)
                        done += len(chunk)
                        if done >= next_report:
                            print(f"    {done >> 20} MB", flush=True)
                            next_report += 50 << 20
            part.replace(dest)
            return
        except requests.RequestException as exc:
            # Never echo the resolved URL: it may carry an API key.
            print(f"    attempt {attempt} failed: {type(exc).__name__}", file=sys.stderr)
            if attempt == attempts:
                raise
            time.sleep(5 * attempt)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--only", nargs="*", help="source ids to fetch (default: all)")
    parser.add_argument("--refresh", action="store_true", help="re-download even if the manifest matches")
    args = parser.parse_args(argv)

    report = Report()
    sources = parse_sources(SOURCES_PATH.read_text(encoding="utf-8"), report)
    if report.errors:
        print("\n".join(report.errors), file=sys.stderr)
        return 1
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.exists() else {}

    failures = 0
    for sid, source in sources.items():
        if args.only and sid not in args.only:
            continue
        template = source_url(source.url)
        if template is None:
            print(f"- {sid}: no URL in docs/data-sources.md yet, skipped")
            continue
        url = resolve(template)
        if url is None:
            print(f"! {sid}: {', '.join(PLACEHOLDER.findall(template))} not set, skipped", file=sys.stderr)
            continue

        name = filename_for(sid, template)
        dest = RAW / sid / name
        entry = manifest.get(sid)
        if (
            not args.refresh
            and entry
            and entry.get("url") == template
            and entry.get("file") == name
            and dest.exists()
            and sha256_file(dest) == entry.get("sha256")
        ):
            print(f"✓ {sid}: up to date")
            continue

        if template.startswith("manual:"):
            if not dest.exists():
                print(
                    f"! {sid}: place {dest.relative_to(ROOT)} by hand (see docs/data-sources.md)",
                    file=sys.stderr,
                )
                continue
        else:
            print(f"↓ {sid}: {template}", flush=True)
            try:
                if template.startswith("arcgis:"):
                    fetch_arcgis(url, dest)
                elif template.startswith("sdmx:"):
                    fetch_sdmx(url, dest)
                elif template.startswith("sparql:"):
                    fetch_sparql(url, dest)
                elif template.startswith("gha:"):
                    fetch_gha(url, dest)
                else:
                    fetch(url, dest)
            except (requests.RequestException, ValueError, OSError) as exc:
                print(f"✗ {sid}: {type(exc).__name__}", file=sys.stderr)
                failures += 1
                continue
        manifest[sid] = {
            "url": template,
            "file": name,
            "bytes": dest.stat().st_size,
            "sha256": sha256_file(dest),
            "fetched": dt.date.today().isoformat(),
        }
        print(f"  {name}: {manifest[sid]['bytes']:,} bytes, sha256 {manifest[sid]['sha256'][:12]}…")
        write_bytes(MANIFEST, (json.dumps(dict(sorted(manifest.items())), indent=2) + "\n").encode())

    print(f"Manifest: {MANIFEST}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
