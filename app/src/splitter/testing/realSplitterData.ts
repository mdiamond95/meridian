// The splitter's data from the committed artefacts, for tests and the presets script (Node only).
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { decodeAtlas, type LoadedAtlas } from '../../atlas/loadAtlas';
import { AtlasFileSchema } from '../../schema/atlas';
import { PlacesFileSchema, SnapFileSchema } from '../../schema/places';
import { TopologySchema } from '../../schema/topojson';
import { splitterData, type AttrsWire, type MeshWire, type SplitterData } from '../data';

const BUILD = new URL('../../../../data/build/', import.meta.url);

function readGz(name: string): unknown {
  return JSON.parse(gunzipSync(readFileSync(new URL(name, BUILD))).toString('utf8'));
}

let cached: SplitterData | null = null;

export function realSplitterData(): SplitterData {
  cached ??= splitterData(
    readGz('mesh.v1.json.gz') as MeshWire,
    readGz('attrs.v1.json.gz') as AttrsWire,
    PlacesFileSchema.parse(readGz('places.v1.json.gz')),
    SnapFileSchema.parse(readGz('snap.v1.json.gz')),
  );
  return cached;
}

let atlasCache: LoadedAtlas | null = null;

/** The committed atlas, decoded, for atlas scopes in tests and the presets script. */
export function realAtlas(): LoadedAtlas {
  atlasCache ??= decodeAtlas(
    AtlasFileSchema.parse(JSON.parse(readFileSync(new URL('atlas.v1.json', BUILD), 'utf8'))),
    TopologySchema.parse(readGz('atlas.v1.topojson.gz')),
  );
  return atlasCache;
}
