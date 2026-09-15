"""Record and verify artefact hashes.

make build     ... then `python checksums.py write` records data/build/SHA256SUMS
make verify    rebuild everything into a temporary directory from the same raw inputs and
               compare every file's SHA-256 with data/build/SHA256SUMS
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

from common import BUILD, ROOT, sha256_file

SUMS = "SHA256SUMS"
STEPS = [["mesh.py"], ["attributes.py"], ["polygons.py"], ["-m", "atlas.build"]]
SKIP = {SUMS, ".gitkeep"}


def hashes(build: Path) -> dict[str, str]:
    return {
        p.relative_to(build).as_posix(): sha256_file(p)
        for p in sorted(build.rglob("*"))
        if p.is_file() and p.name not in SKIP and not p.name.endswith(".tmp")
    }


def write(build: Path = BUILD) -> int:
    lines = [f"{digest}  {name}" for name, digest in hashes(build).items()]
    (build / SUMS).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {build / SUMS} ({len(lines)} files)")
    return 0


def read(build: Path = BUILD) -> dict[str, str]:
    path = build / SUMS
    if not path.exists():
        return {}
    return {
        name: digest
        for digest, name in (line.split("  ", 1) for line in path.read_text().splitlines() if line)
    }


def verify() -> int:
    recorded = read()
    if not recorded:
        print(f"no {SUMS}; run make build first", file=sys.stderr)
        return 1
    problems = [f"committed file changed: {n}" for n, d in hashes(BUILD).items() if recorded.get(n) != d]
    with tempfile.TemporaryDirectory(prefix="meridian-verify-") as tmp:
        env = {**os.environ, "MERIDIAN_BUILD": tmp}
        for step in STEPS:
            print(f"rebuilding: {' '.join(step)}", flush=True)
            subprocess.run([sys.executable, *step], cwd=ROOT / "pipeline", env=env, check=True)
        rebuilt = hashes(Path(tmp))
    for name in sorted(set(recorded) | set(rebuilt)):
        if recorded.get(name) != rebuilt.get(name):
            problems.append(f"rebuild differs: {name}")
    for problem in problems:
        print(f"✗ {problem}")
    print("verify: clean" if not problems else f"verify: {len(problems)} difference(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else "verify"
    sys.exit(write() if command == "write" else verify())
