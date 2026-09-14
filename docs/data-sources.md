# Data sources

Every external dataset Meridian reads or displays. The pipeline's dry run (`make dry-run`)
cross-checks the `id` column against `pipeline/artefacts.yaml`, and `pipeline/download.py`
(Phase 1) fetches each row into `data/raw/<id>/`.

**Phase 1 fills the empty cells.** Confirm each licence line before any artefact built from
that source is committed (docs/plan.md, Phase 1 "You do").

Code is MIT; data keeps its own licence, listed here. Every attribution string ends up on
the in-app licences page (Phase 7).

## Pipeline inputs

| id | source | url | licence | attribution | refresh |
|---|---|---|---|---|---|
| `statcan_pr_2021` | Statistics Canada 2021 boundary file: provinces/territories | | | | |
| `statcan_cd_2021` | Statistics Canada 2021 boundary file: census divisions | | | | |
| `statcan_csd_2021` | Statistics Canada 2021 boundary file: census subdivisions | | | | |
| `statcan_cmaca_2021` | Statistics Canada 2021 boundary file: CMA/CA | | | | |
| `statcan_da_2021` | Statistics Canada 2021 boundary file: dissemination areas | | | | |
| `statcan_profile_da_2021` | Statistics Canada 2021 Census Profile, DA level | | | | |
| `statcan_profile_csd_2021` | Statistics Canada 2021 Census Profile, CSD level | | | | |
| `statcan_gdp_36100402` | Statistics Canada table 36-10-0402, provincial GDP by industry | | | | |
| `cirnac_pre1975_treaties` | Open Government: Pre-1975 Historic Treaties | | | | |
| `cirnac_modern_treaties` | Open Government: Modern Treaties | | | | |
| `cirnac_reserves` | Open Government: Indian Reserves | | | | |
| `ab_metis_settlements` | Alberta Métis Settlements | | | | |
| `itk_inuit_nunangat` | Inuit Nunangat regions | | | | |
| `nrcan_ecozones` | NRCan Terrestrial Ecozones | | | | |
| `nrcan_drainage_areas` | NRCan Atlas of Canada drainage areas (incl. Saskatchewan–Nelson sub-basins) | | | | |
| `nrcan_rivers` | NRCan rivers network | | | | |
| `elections_fed_2023` | Elections Canada 2023 Representation Order federal electoral districts | | | | |
| `elections_results_latest` | Elections Canada latest general election results by district | | | | |
| `native_land_territories` | Native Land Digital API: territories | | | | |
| `native_land_languages` | Native Land Digital API: languages | | | | |

## Displayed in the app

| Layer | url | licence | attribution | refresh |
|---|---|---|---|---|
| CARTO Positron basemap | https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png | CARTO basemaps free tier (API key required; see decisions.md) | © OpenStreetMap contributors © CARTO | Live tiles |
| OpenStreetMap standard tiles (fallback when no CARTO key at build time; not used on Pages) | https://tile.openstreetmap.org/{z}/{x}/{y}.png | ODbL data; tiles under the OSMF Tile Usage Policy (light development use only) | © OpenStreetMap contributors | Live tiles |
