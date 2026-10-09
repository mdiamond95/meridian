"""Founding, incorporation and city dates of places, from Wikidata (source `wikidata_csd_dates`, the query
in csd_dates.rq), for the hex table's settledYear and cityYear (hexboard.py; docs/interop.md,
"Settlement dates"). Dates are read, never estimated:

- A place is a places.v1 census subdivision, matched to Wikidata by its 7-digit geographic code (P3012).
- Its dated facts are the inceptions (P571) of its item, and the "instance of" (P31) statements of its
  item that have a start time (P580) and whose class is a city or town (a subclass of Q515 city, Q3957
  town or Q7930989 city or town in Wikidata itself); and the same facts of every predecessor on record
  (an item the place's item replaces, P1365, or one naming it in replaced by, P1366). Dates less
  precise than a year (a decade, a century) are not used.
- Its settled year is the earliest of those, its city year the earliest of the city ones (a subclass
  of Q515). Wikidata's "provincial or territorial capital city" is a subclass of city, but its start
  is the day a place became a capital (Edmonton, 1905), so it is not a city date.
- Amalgamations: Wikidata's inception of a Canadian municipality is the date of its present
  corporation, which for a merged one is the merger (Chatham-Kent, 1998). An earlier predecessor on
  record wins by being earlier. Where the data cannot tell a merger from a founding the year is null:
    - the earliest date is CUTOFF or later: from then on, mergers (Chatham-Kent 1998, Cape Breton
      1995, Clarington 1974) and new towns (Thompson 1956, Elliot Lake 1955) carry the same kind of
      inception, and nothing in the data tells them apart;
    - the place has a predecessor on record, but no predecessor carries a date: its own date may be
      the merger.
  `withheld` keeps what was set aside, for the coverage report.
"""

from __future__ import annotations

import csv
import re
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

CUTOFF = 1950
YEAR_PRECISION = 9
# Provincial or territorial capital city in Canada: its start is the day a place became a capital.
NOT_CITY_DATES = {"Q21507383"}
ENTITY = "http://www.wikidata.org/entity/"
TIME = re.compile(r"^([+-]?\d{1,4})-(\d\d)-(\d\d)T")


@dataclass(frozen=True)
class Fact:
    year: int
    date: str  # as precise as stated: YYYY, YYYY-MM or YYYY-MM-DD
    item: str  # the item holding the statement
    label: str
    property: str  # P571 inception or P31 instance of
    cls: str | None  # the class, for P31
    place_item: str  # the place's own item

    def source(self) -> dict:
        out = {"item": self.item, "label": self.label, "property": self.property, "date": self.date}
        if self.cls:
            out["class"] = self.cls
        if self.item != self.place_item:
            out["predecessorOf"] = self.place_item
        return out

    def key(self) -> tuple:
        # Earliest; on the same date, the place's own item before a predecessor; then by item.
        own = self.item == self.place_item
        return (self.date.ljust(10, "~"), not own, self.item, self.property, self.cls or "")


@dataclass
class PlaceDates:
    items: list[str] = field(default_factory=list)
    settled: Fact | None = None
    city: Fact | None = None
    withheld: dict[str, tuple[Fact, str]] = field(default_factory=dict)  # "settled" | "city" → (fact, why)


def _qid(uri: str) -> str:
    return uri.removeprefix(ENTITY) if uri else ""


def _date(time: str, precision: int) -> tuple[int, str] | None:
    m = TIME.match(time)
    if not m or precision < YEAR_PRECISION:
        return None
    year, month, day = int(m.group(1)), m.group(2), m.group(3)
    if precision == YEAR_PRECISION:
        return year, f"{year:04d}"
    if precision == YEAR_PRECISION + 1:
        return year, f"{year:04d}-{month}"
    return year, f"{year:04d}-{month}-{day}"


def read(path: Path, codes: set[str]) -> dict[str, PlaceDates]:
    """Dates for every code in `codes` that Wikidata has an item for."""
    rows = list(csv.DictReader(path.open(encoding="utf-8", newline="")))
    city_classes = {_qid(r["class"]) for r in rows if r["kind"] == "class" and r["label"] == "city"}
    town_classes = {_qid(r["class"]) for r in rows if r["kind"] == "class"}
    city_classes -= NOT_CITY_DATES
    town_classes -= NOT_CITY_DATES

    items: dict[str, set[str]] = defaultdict(set)
    labels: dict[str, str] = {}
    predecessors: dict[str, set[str]] = defaultdict(set)
    dated: dict[str, list[tuple]] = defaultdict(list)  # item → (year, date, property, class)
    for r in rows:
        code, item, via = r["code"], _qid(r["item"]), _qid(r["via"])
        if code and code in codes:
            items[code].add(item)
        kind = r["kind"]
        if kind == "label":
            labels[item] = r["label"]
        elif kind == "predecessor":
            predecessors[item].add(via)
            if r["label"]:
                labels.setdefault(via, r["label"])
        elif kind in ("inception", "instance", "predecessorInception", "predecessorInstance"):
            when = _date(r["time"], int(r["precision"] or 0))
            if when is None:
                continue
            holder = via if kind.startswith("predecessor") else item
            cls = _qid(r["class"]) or None
            if cls and cls not in town_classes:
                continue  # a dated instance of something other than a city or town
            dated[holder].append((*when, "P571" if cls is None else "P31", cls))

    out: dict[str, PlaceDates] = {}
    for code in sorted(items):
        place = PlaceDates(items=sorted(items[code]))
        facts: list[Fact] = []
        has_predecessor = False
        predecessor_dated = False
        for own in place.items:
            for holder in [own, *sorted(predecessors[own] - {own})]:
                for year, date, prop, cls in sorted(set(dated[holder])):
                    facts.append(Fact(year, date, holder, labels.get(holder, holder), prop, cls, own))
                if holder != own:
                    has_predecessor = True
                    predecessor_dated |= bool(dated[holder])
        facts.sort(key=Fact.key)
        for name, wanted in (("settled", facts), ("city", [f for f in facts if f.cls in city_classes])):
            if not wanted:
                continue
            first = wanted[0]
            if first.year >= CUTOFF:
                place.withheld[name] = (first, f"{first.year}: {CUTOFF} or later, merger or founding unknown")
            elif has_predecessor and not predecessor_dated:
                place.withheld[name] = (first, "a predecessor on record with no date")
            else:
                setattr(place, name, first)
        out[code] = place
    return out
