import type { SplitSpec } from './split';

/**
 * Share links (plan Phase 3 Sitting B §5). The hash carries either a whole split spec
 * (`#split=<base64url JSON>`, reproduced by running it again; edits are not included) or a pack from
 * the library (`#pack=<id>`).
 */

export type HashState = { kind: 'split'; spec: SplitSpec } | { kind: 'pack'; id: string } | { kind: 'none' };

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): string {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

export function encodeHash(state: HashState): string {
  if (state.kind === 'split') return `#split=${toBase64Url(JSON.stringify(state.spec))}`;
  if (state.kind === 'pack') return `#pack=${encodeURIComponent(state.id)}`;
  return '';
}

export function decodeHash(hash: string): HashState {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const split = params.get('split');
  if (split) {
    try {
      const spec = JSON.parse(fromBase64Url(split)) as SplitSpec;
      if (spec && typeof spec === 'object' && spec.scope && typeof spec.n === 'number')
        return { kind: 'split', spec };
    } catch {
      return { kind: 'none' };
    }
  }
  const pack = params.get('pack');
  if (pack && /^[a-z0-9-]+$/.test(pack)) return { kind: 'pack', id: pack };
  return { kind: 'none' };
}
