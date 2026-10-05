import { canonical } from '../splitter/tree';

/**
 * Published packs are immutable (docs/interop.md, versioning rule 7). A file under packs/ that was in
 * a release keeps its content for good: a regeneration that changes a pack is written beside it as
 * <slug>.<meshVersion>.<n>.json (n = 2, 3, ...), and index.json moves to the new file. Content is
 * compared as canonical JSON (keys sorted, no whitespace), so reformatting a file is not a change.
 */

const PACK_FILE = /^([a-z0-9-]+)\.(v\d+)(?:\.([1-9]\d*))?\.json$/;

/** index.json is the library listing, not a pack: it moves when a pack is regenerated. */
export const LIBRARY_FILE = 'index.json';

export interface PackFileName {
  slug: string;
  meshVersion: string;
  /** 1 for the first file, `<slug>.<meshVersion>.json`; 2 and up for regenerations. */
  n: number;
}

export function parsePackFile(file: string): PackFileName | null {
  const m = PACK_FILE.exec(file);
  if (!m || m[3] === '1') return null;
  return { slug: m[1], meshVersion: m[2], n: m[3] ? Number(m[3]) : 1 };
}

export function packFileName({ slug, meshVersion, n }: PackFileName): string {
  return n === 1 ? `${slug}.${meshVersion}.json` : `${slug}.${meshVersion}.${n}.json`;
}

/** The canonical form of a pack file's text; two files with equal content give equal strings. */
export function packContent(text: string): string {
  return canonical(JSON.parse(text));
}

/**
 * Where a (re)generated pack goes: the slug's latest file on this mesh if its content is the same,
 * otherwise the next free number. `files` maps the names under packs/ to their text.
 */
export function choosePackFile(
  files: ReadonlyMap<string, string>,
  slug: string,
  meshVersion: string,
  text: string,
): string {
  const latest = [...files.keys()]
    .map(parsePackFile)
    .filter((f): f is PackFileName => !!f && f.slug === slug && f.meshVersion === meshVersion)
    .sort((a, b) => b.n - a.n)[0];
  if (!latest) return packFileName({ slug, meshVersion, n: 1 });
  const file = packFileName(latest);
  const previous = files.get(file);
  return previous !== undefined && packContent(previous) === packContent(text)
    ? file
    : packFileName({ ...latest, n: latest.n + 1 });
}

export interface PackViolation {
  file: string;
  problem: 'deleted' | 'changed';
}

/** Every file published in `released` (packs/ at a release tag) must still be in `now`, unchanged. */
export function immutabilityViolations(
  released: ReadonlyMap<string, string>,
  now: ReadonlyMap<string, string>,
): PackViolation[] {
  const violations: PackViolation[] = [];
  for (const [file, text] of released) {
    if (file === LIBRARY_FILE) continue;
    const current = now.get(file);
    if (current === undefined) violations.push({ file, problem: 'deleted' });
    else if (packContent(current) !== packContent(text)) violations.push({ file, problem: 'changed' });
  }
  return violations.sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Unit tables (docs/interop.md, "Unit tables"; 1.0.3) are published under data/build/ as gzipped JSON
 * and are immutable like packs: one released keeps its content in every later release. This says
 * whether a file's JSON text is one.
 */
export function isUnitTable(text: string): boolean {
  try {
    return (JSON.parse(text) as { format?: unknown }).format === 'meridian.unitTable';
  } catch {
    return false;
  }
}
