// Versioned atlas artefacts from data/build, fingerprinted into the bundle by Vite.
import atlasUrl from '../../../data/build/atlas.v1.json?url';
import topologyUrl from '../../../data/build/atlas.v1.topojson.gz?url';
import contactUrl from '../../../data/build/contact.v1.json?url';
import contactTopologyUrl from '../../../data/build/contact.v1.topojson.gz?url';

export const ATLAS_URL = atlasUrl;
export const ATLAS_TOPOLOGY_URL = topologyUrl;
// Fetched only when the contact frontier is asked for (src/components/ContactLayer.tsx).
export const CONTACT_URL = contactUrl;
export const CONTACT_TOPOLOGY_URL = contactTopologyUrl;
