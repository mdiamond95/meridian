# Meridian — a boundary generator for Canada

*Working title. Named for the Dominion Land Survey meridians, which is what a boundary tool for this country should be named for. Alternatives: Survey, Cartouche, Partition (too loaded).*

## 1. What this is

A single tool that treats every way we have carved up Canada — by lens, by population, by history, by chance — as the same operation: assign small pieces of land to a set of regions under rules, then describe what you made. Every previous project did this by hand in prose. This one does it with geometry, and produces output the other projects (cities atlas, Birdseye, the games) can import.

Four things it must do on launch:

1. **Split Canada into provinces** according to input factors.
2. **Isolate one province** and split it the same way.
3. **Split Canada into N regions** by population, geography, culture, demographics, economy, or randomly, for any year from the last day before European discovery to today.
4. **Historical atlas** — accurate first-order boundaries for every year in that range, as a standalone view and as the base other pieces build on.

## 2. The core design decision

Everything above rests on one thing: **a fine-grained base mesh of Canada with attributes per cell.** Regions are never drawn; they are aggregations of cells. That is what makes 1, 2 and 3 a single engine.

**Base mesh candidates** (pick one, can support two):

| Mesh | Cells | Strengths | Weaknesses |
|---|---|---|---|
| Census subdivisions (CSD) | ~5,000 | Real population/language/income data attach directly; municipal edges | Huge in the north, tiny in cities; pre-1871 meaningless |
| Census divisions (CD) | ~300 | Clean, familiar, good for Canada-scale splits | Too coarse for a province at 15 regions |
| Hex grid (H3 res 4–6) | 10k–100k | Uniform; ideal for random/organic splits; historical-era friendly | Must interpolate every attribute onto it |
| DLS township grid (Prairies only) | ~30k | Snaps to Township Road 360 like the Alberta N/S line did | West of Ontario only |

Recommendation: **CSD for present-day attribute fidelity, H3 hexes as the universal working mesh.** Attributes are area-weighted from CSD onto hexes once, at build time. Historical years use the hex mesh with era-appropriate attributes (see §5).

**Per-cell attributes (v1):** population (by census year, interpolated), land area, centroid, province/territory, CD/CSD id, ecozone, drainage basin, mother tongue split (EN/FR/Indigenous/other), Indigenous identity share, treaty area / modern agreement / unceded, urban–rural class, dominant industry proxy, estimated GDP share, historical unit-by-year lookup.

## 3. The splitter engine

### 3.1 Split methods

- **Lens split (hierarchical, the 2→26 method).** Given N, find the region whose cells are most internally heterogeneous on the chosen lens, bisect it, repeat. Regions nest, so N and N+1 are comparable — exactly how the Canada and Alberta series worked. Lens = any weighted combination of attributes.
- **Balanced partition.** Equal population, equal GDP, equal area, or a target share (10%, 5%, 2.5%, 20% — last week's exercise). Contiguity enforced; the tool flags where contiguity forced an awkward pairing, as we did with the equal-population provinces.
- **Seeded growth.** User or algorithm places capitals; regions grow outward by travel-time or distance weighted by an attribute. This is the "city-states plus hinterlands" model from the redraw chat.
- **Random.** Seed-driven, fully reproducible (same discipline as the township generator). Options: Voronoi from random seeds, random hierarchical cuts, random walk on the hex graph.
- **Template.** Load a saved split: the 15-region Alberta, the 26-region Canada, the Incrementalist 14, the Spanish historic-nations model, and so on. Templates are just region packs (§7).
- **Manual override.** Click-drag cells between regions after any generation; recompute stats live. Because the lens work was always half judgement, the tool must not pretend otherwise.

### 3.2 Constraints and snapping

- Contiguity (hard / soft / off — off allows a "Rotational Canada" style non-contiguous region).
- Minimum and maximum population, area, or cell count per region.
- **Snap boundaries to:** rivers and drainage divides, Continental Divide, treaty boundaries, township/range lines, CD/CSD edges, parallels and meridians, highways, ecozone edges. Snap layers are what made the Alberta borders describable in words.
- Keep-together and keep-apart pins ("Red Deer must not be split," "Calgary and Edmonton in different regions").
- Enclave handling for CMAs: option to carve a metro as its own unit before splitting the rest.

### 3.3 Scope

Canada, any single province or territory, any saved region, or any drawn polygon. Isolating a province is just setting the scope; all methods apply unchanged.

## 4. Lenses and layers

Everything we used as a splitting rationale in past chats becomes a selectable weight or overlay:

**Economic** — accumulation vs extraction; dominant industry; GDP per capita; resource ownership; boom-bust exposure; rotational/FIFO workforce share.

**Demographic** — population density; growth trajectory; median age; immigrant share and source region ("the New Canada"); urban–rural–remote.

**Linguistic and cultural** — French mother tongue (Quebec heartland, Acadia, Francophonie de l'Ouest); Indigenous languages by family; heritage settlement belts (Ukrainian, Mennonite, Mormon, Icelandic, Scandinavian).

**Indigenous and constitutional** — numbered treaties 1–11, historic treaties, Douglas treaties, modern agreements (JBNQA, Nunavut, Nisga'a, Yukon), unceded territory, Métis homeland and settlements, Inuit Nunangat regions. Treaty vs unceded was the sharpest split in the 26-region model and deserves first-class status.

**Physical** — ecozones, drainage basins (the Saskatchewan-Nelson work is a ready sub-layer), Shield edge, treeline, permafrost, Continental Divide, climate.

**Political** — federal and provincial ridings, recent voting patterns (for the "hypothetical governing party" field), municipal boundaries.

**Internal-colony index** — a derived layer scoring distance-to-capital, resource outflow, and population share; it is what surfaces Northern Ontario, Interior BC, Labrador and Nunavik automatically instead of by hand.

Layers live in one toggleable menu (the pattern from the globe project), and every lens doubles as a choropleth so you can see why the engine cut where it did.

## 5. The historical atlas

### 5.1 Model

Not "a map per year." Canada's first-order boundaries changed on roughly 40 dates; the atlas stores **an event list** and resolves any date to a map. The year slider steps through ~450 years, but the data is a few dozen polygon sets plus transitions.

Each unit at each date carries: name, status (colony, province, territory, district, HBC charter, unorganized, foreign, disputed), sovereign, capital, and a short note in the voice of the Confederation sequence from the Pomodoro build.

### 5.2 Three truth layers

- **De jure** claims (Rupert's Land 1670, the 1763 Proclamation line).
- **De facto** control (fur posts, settlement extent, effective administration).
- **Disputed** (Oregon to 1846, Alaska panhandle to 1903, Labrador to 1927, Hans Island to 2022) — hatched.

Users choose which to display; most historical maps silently show de jure only, which is the lie the 26-region chat kept circling.

### 5.3 Pre-contact start

"Last day before discovery" needs a definition, and the tool should offer three:

1. 1000 CE (Norse at L'Anse aux Meadows).
2. 1497 (Cabot) — the conventional choice.
3. **Per-region first sustained contact** — Alberta's is 1754 (Henday), Nunavut's is arguably the 1570s or the 1820s. This renders as a layer showing the contact frontier advancing across the country, which is more honest and more interesting than a single date.

The pre-contact base is not blank: it shows Indigenous nations and language families (Native Land Digital, labelled approximate, with the caveat that these are living, contested and not boundaries in the European sense).

### 5.4 Key event dates (seed list)

1670 HBC charter · 1713 Utrecht · 1763 Proclamation · 1774 Quebec Act · 1783 Paris · 1784 New Brunswick and Cape Breton · 1791 Upper/Lower Canada · 1818 49th parallel to the Rockies · 1820 Cape Breton merged · 1841 Province of Canada · 1842 Webster–Ashburton · 1846 Oregon · 1849 Vancouver Island · 1858 British Columbia · 1866 BC merger · 1867 Confederation · 1870 Manitoba and NWT · 1871 BC · 1873 PEI · 1876 Keewatin · 1880 Arctic transfer · 1881 Manitoba enlarged · 1882 provisional districts · 1889 Ontario extended · 1895 new districts · 1898 Yukon, Quebec extended · 1903 Alaska award · 1905 Alberta and Saskatchewan · 1912 MB/ON/QC extensions · 1927 Labrador · 1949 Newfoundland · 1999 Nunavut · 2001 Newfoundland and Labrador rename · 2003 Nunavik and Nunatsiavut agreements (overlay).

### 5.5 Atlas as base for the splitter

Any historical date can be the splitter's scope and constraint: split the 1867 Dominion into five, split Rupert's Land as the HBC might have, split 1905 NWT into three provinces instead of two (Haultain's Buffalo). Historical attributes are thin, so the tool says so: population is interpolated between census points and flagged below a confidence threshold; pre-1871 uses settlement estimates.

## 6. Describing what you made — the dossier

Each generated region gets an auto-filled dossier using the fields we standardized across the Alberta, Canada and cities projects:

- Name (deterministic generator with the same seeded approach as the town names, plus a manual field), capital (largest place or user pick), main and secondary cities.
- Population, area, density, GDP estimate (provincial GDP allocated by cell population × industry weights — labelled as an estimate), growth trajectory.
- Primary industries, economic profile, dependency score.
- Borders in words: the tool composes them from snap layers ("north boundary at Township 54 / the North Saskatchewan; west along the Continental Divide"). This was the single most useful artefact of the Alberta series.
- Language and Indigenous profile; treaty status.
- Hypothetical governing party from riding results.
- Character line, rival region, the One Sentence, what would kill it / what would save it (lifted from the cities model).

**Set-level analysis** (from the redraw and equal-population chats): power ranking (economic leverage, chokepoints, infrastructure control, resource ownership); largest-to-smallest ratio; which metros were split; running GDP and population totals with a reconciliation check; federalism impact panel — what breaks in the Senate, the amending formula, equalization, Quebec asymmetry, territorial governance, asset partition; contiguity compromise log.

**Comparison mode:** two splits side by side or as a swipe, with a difference table. Actual Canada is always available as a baseline.

## 7. Export and interoperability

This is what makes it a tool and not another essay.

- **Region pack (JSON):** cells → region id, region metadata, dossiers, the seed and parameters that produced it. Schema shared with the cities atlas, Birdseye and future games. Reproducible from seed plus mesh version.
- **GeoJSON / TopoJSON** of dissolved region polygons.
- **KML** for Google My Maps (folders per region, capitals, dividing lines — the format we already used).
- **SVG / PNG** with legend, scale, date stamp.
- **Markdown dossier** of the whole set, so a split can drop straight into a writing project.
- **Import:** any GeoJSON or KML as a template, a snap layer, or a scope.

## 8. Games and scenarios (hooks, not v1)

- **Divergence mode:** pick a year in the atlas, edit the map, and carry the change forward — the branching-year structure of the Alberta-1500 game. Each later event checks whether it still applies.
- **Nesting drill-down:** split Canada into 5, then any of those into 4, then any of those into 3 — the fractal-grievance structure the 26-region chat kept finding. Saved as a tree.
- **Non-geographic regions** (Rotational Canada, the New Canada) as flow or point overlays rather than polygons, so they can coexist with a partition.
- **Counterfactual presets** from the provincial-defining-events chat: Newfoundland independent, no 1912 extensions, Acadian Maritimes, unified Buffalo province.
- **Score hooks:** expose per-region metrics to an external game (Victoria-style pops) through the region pack.

## 9. Technical shape

- **Data pipeline (Python, offline):** StatCan boundary files and census profiles, NRCan Territorial Evolution maps, Native Land Digital, treaty and modern-agreement polygons, ecozones and drainage from NRCan/USGS. Outputs one versioned mesh file plus one historical event file, simplified with mapshaper. Attribute joins and hex weighting happen here, once.
- **App:** single-file or lightly bundled HTML with Leaflet on OSM/CartoDB tiles (matching the Night Atlas), Web Worker for the partition solver so the UI never blocks, deterministic PRNG shared with the township generator. Must run on iPad through StackBlitz for the same reason the town generator does.
- **Solver:** region growing and swap-refinement on the hex graph with a contiguity check on every move; simulated annealing for balanced partitions. Good enough at 10k–30k cells in a few seconds; publish the cell count so results are reproducible.
- **State:** URL-encodable parameters plus seed so a split is a shareable link.

## 10. Roadmap

1. **Foundation** — mesh, attributes, historical event file, viewer with layers menu. Nothing generates yet; this is the atlas (launch item 4).
2. **Splitter** — lens, balanced, random, template; scope selection; contiguity; snapping. Items 1–3.
3. **Dossiers and analysis** — auto-descriptions, borders in words, power ranking, federalism panel, comparison mode.
4. **Export and interop** — region pack schema, GeoJSON/KML/SVG/Markdown, import.
5. **Scenarios** — divergence mode, nesting tree, counterfactual presets, game hooks.

## 11. Honest limits to decide up front

- Sub-provincial GDP is an allocation, never a measurement; the tool labels it so everywhere.
- Pre-1871 population is estimate and interpolation; pre-1600 is Indigenous population estimates with wide bands.
- Indigenous territory polygons are approximations of relationships that were not polygonal; the atlas says so on the layer itself.
- "Accurate borders for every year" is achievable for first-order units; it is not achievable for sub-provincial districts before roughly 1880 without a research project of its own. Scope districts to the events we can source.
- The engine will produce ugly regions where the data is thin (the North). The lens method's judgement — what a region would call itself — is not automatable; the manual override exists because of that.
