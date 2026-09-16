# Native Land Digital — permission request (draft, superseded)

Status: **not sent, and superseded.** Native Land Digital's data is declined permanently
(docs/decisions.md, 2026-09-16), so this request will not be sent. It is kept as a record of what was
considered and why the data was never fetched. `permissions.native_land_permission: declined` in
`pipeline/artefacts.yaml` records the decision, and no code path fetches or loads their data. The
pre-contact base is drawn instead from an in-house language-family layer built from the 2021 Census,
Glottolog and Wikidata (`pipeline/indigenous.py`).

---

**To:** Native Land Digital (via https://native-land.ca contact form or listed contact address)
**Subject:** Permission to cache territory and language polygons in a non-commercial atlas of Canada

Hello,

My name is Mark. I am building Meridian, a free, open-source atlas of Canada for education and
personal research. It shows historical boundaries, and it helps people understand how the country
has been, and could be, divided into regions. The code is public at
https://github.com/mdiamond95/meridian, and the site is non-commercial, with no ads, accounts or
paid features.

I have a Native Land API key. I would like to use your territory and language polygons as an
optional layer. Your API terms say that stored or redistributed data needs your explicit
permission, so I am asking before I do anything with it.

What I am asking permission for:

- Download the territories and languages GeoJSON once per update, and keep a cached copy with the
  project's build files.
- Record, for each cell of the atlas's grid (about 250 km² each), which territories overlap it.
  The atlas would publish this lookup and a simplified version of the polygons, as part of the
  open-source project's files.
- Show the layer on the public website.

How the data would be treated:

- Your attribution on the layer and in the credits: "Native Land Digital, https://native-land.ca".
  I would add a note that Indigenous communities are the rightful stewards of this knowledge.
- Your disclaimer shown on the layer itself: that the map does not represent or intend to represent
  official or legal boundaries of any Indigenous nations.
- No changes to the boundaries beyond simplifying them for display, and no commercial use.
- Refreshed from your API when you publish updates, and removed promptly if you ask.

If you would prefer something different, I am happy to follow your conditions. For example, you
could ask me not to cache the polygons, to link to your map instead, or to credit you in a
specific way.

Thank you for the work you do.

Mark
