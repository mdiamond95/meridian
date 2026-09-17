// The splitter's artefacts, fingerprinted into the build and fetched the first time Generate opens.
import attrsUrl from '../../../data/build/attrs.v1.json.gz?url';
import cellsUrl from '../../../data/build/cells.v1.topojson.gz?url';
import meshUrl from '../../../data/build/mesh.v1.json.gz?url';
import placesUrl from '../../../data/build/places.v1.json.gz?url';
import snapUrl from '../../../data/build/snap.v1.json.gz?url';

export const SPLITTER_URLS = { mesh: meshUrl, attrs: attrsUrl, places: placesUrl, snap: snapUrl };
export const CELLS_URL = cellsUrl;
