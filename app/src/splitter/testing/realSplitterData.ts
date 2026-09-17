// The splitter's data from the committed artefacts, for tests and the presets script (Node only).
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { PlacesFileSchema, SnapFileSchema } from '../../schema/places';
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
