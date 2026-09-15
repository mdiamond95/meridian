import { AttrsFileSchema, type AttrsFile, type AttrsFileWire } from '../schema/attrs';
import { decodeColumn, type TypedColumn } from '../schema/columns';
import { MeshFileSchema, type MeshFile, type MeshFileWire } from '../schema/mesh';

/**
 * Fetch and decode the versioned mesh and attribute artefacts (data/build/mesh.v1.json.gz,
 * attrs.v1.json.gz) into typed arrays indexed by cell index.
 */

export interface LoadedMesh {
  mesh: MeshFile;
  attrs: AttrsFile;
}

export interface LoadMeshOptions {
  fetch?: typeof fetch;
  /** Zod-validate both files before decoding (default true). */
  validate?: boolean;
}

const GZIP_MAGIC = [0x1f, 0x8b];

/** Gunzip if the bytes are still gzip (static hosts serve .gz as-is; some decode on the fly). */
export async function maybeGunzip(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  const head = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength));
  if (head[0] !== GZIP_MAGIC[0] || head[1] !== GZIP_MAGIC[1]) return buffer;
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

async function fetchJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = await maybeGunzip(await response.arrayBuffer());
  return JSON.parse(new TextDecoder().decode(bytes));
}

function decodeColumns(columns: Record<string, Parameters<typeof decodeColumn>[0]>) {
  const out: Record<string, TypedColumn> = {};
  for (const [name, column] of Object.entries(columns)) out[name] = decodeColumn(column);
  return out;
}

export function decodeMesh(wire: MeshFileWire): MeshFile {
  return { ...wire, columns: decodeColumns(wire.columns) };
}

export function decodeAttrs(wire: AttrsFileWire): AttrsFile {
  const sideTables: AttrsFile['sideTables'] = {};
  for (const [name, table] of Object.entries(wire.sideTables ?? {})) {
    sideTables[name] = {
      offsets: decodeColumn(table.offsets) as Int32Array,
      values: decodeColumn(table.values) as Int32Array,
    };
  }
  return { ...wire, columns: decodeColumns(wire.columns), sideTables };
}

export async function loadMesh(
  meshUrl: string,
  attrsUrl: string,
  { fetch: fetchImpl = fetch, validate = true }: LoadMeshOptions = {},
): Promise<LoadedMesh> {
  const [meshJson, attrsJson] = await Promise.all([
    fetchJson(meshUrl, fetchImpl),
    fetchJson(attrsUrl, fetchImpl),
  ]);
  const meshWire = validate ? MeshFileSchema.parse(meshJson) : (meshJson as MeshFileWire);
  const attrsWire = validate ? AttrsFileSchema.parse(attrsJson) : (attrsJson as AttrsFileWire);

  if (attrsWire.meshVersion !== meshWire.version) {
    throw new Error(`attrs built for mesh ${attrsWire.meshVersion}, mesh is ${meshWire.version}`);
  }
  if (attrsWire.cellCount !== meshWire.cells.length) {
    throw new Error(`attrs has ${attrsWire.cellCount} cells, mesh has ${meshWire.cells.length}`);
  }
  return { mesh: decodeMesh(meshWire), attrs: decodeAttrs(attrsWire) };
}
