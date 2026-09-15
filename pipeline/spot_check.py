"""Print every attribute of the five Phase 1 spot-check cells (docs/plan.md, Phase 1 "You do").

make spot-check
"""

from __future__ import annotations

import gzip
import json
import sys

import h3

from columns import decode_column
from common import BUILD, MESH_VERSION

PLACES = {
    "Bonnie Doon, Edmonton": (53.5226, -113.4630),
    "Fort McMurray": (56.7267, -111.3810),
    "Grand Falls-Windsor": (48.9500, -55.6640),
    # Iqaluit CSD representative point (see tests/test_mesh_artefacts.py, CAPITAL_CSD_POINTS).
    "Iqaluit": (63.756345, -68.517626),
    "Old Montréal": (45.5075, -73.5540),
}


def load(name: str) -> dict:
    with gzip.open(BUILD / name, "rt", encoding="utf-8") as fh:
        return json.load(fh)


def main() -> int:
    mesh = load(f"mesh.{MESH_VERSION}.json.gz")
    attrs = load(f"attrs.{MESH_VERSION}.json.gz")
    index = {c["id"]: i for i, c in enumerate(mesh["cells"])}
    columns = {name: decode_column(column) for name, column in attrs["columns"].items()}
    lookups = attrs.get("lookups", {})

    for place, (lat, lng) in PLACES.items():
        cell = h3.latlng_to_cell(lat, lng, mesh["h3Resolution"])
        if cell not in index:
            print(f"== {place} ({lat}, {lng}): cell {cell} is NOT in the mesh\n")
            continue
        i = index[cell]
        c = mesh["cells"][i]
        print(
            f"== {place}  {cell}  {c['province']}  CD {c['cd']}  CSD {c['csd']}  "
            f"{c['area']} km²  {len(c['neighbours'])} neighbours"
        )
        shares = []
        for name, values in columns.items():
            value = values[i].item()
            if name.startswith("industry_share_"):
                shares.append((value, name.removeprefix("industry_share_")))
            elif name in lookups:
                print(f"  {name} = {int(value)} ({lookups[name].get(str(int(value)), '?')})")
            elif isinstance(value, float):
                unit = f" {attrs['columns'][name]['unit']}" if "unit" in attrs["columns"][name] else ""
                print(f"  {name} = {value:,.3f}{unit}")
            else:
                print(f"  {name} = {value:,}")
        top = ", ".join(f"{code} {share:.0%}" for share, code in sorted(shares, reverse=True)[:3])
        print(f"  top industries: {top}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
