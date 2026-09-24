// @vitest-environment node
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { DOMParser, type Element } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';
import { Dossier } from '../components/DossierPanel';
import { PLACEHOLDER_MARK, type RegionDossier, type SetAnalysis } from '../schema/dossier';
import { decodePack } from '../splitter/pack';
import { dossierMarkdown, setMarkdown } from './markdown';

/**
 * The Markdown export reproduces the Region panel: the same fields in the same order, with every
 * ⟨draft⟩ mark kept (plan Phase 5 brief).
 */

const pack = decodePack(
  JSON.parse(readFileSync(new URL('../../../packs/canada-26.v1.json', import.meta.url), 'utf8')),
);
const dossiers = pack.regions.map((r) => r.dossier as RegionDossier);

/** The panel's text, block by block, in document order. */
function panelBlocks(dossier: RegionDossier): string[] {
  const html = renderToStaticMarkup(<Dossier dossier={dossier} onClose={() => {}} />);
  const doc = new DOMParser().parseFromString(html, 'text/xml');
  const blocks: string[] = [];
  const walk = (el: Element) => {
    const tag = el.tagName;
    const wanted =
      tag === 'h2' ||
      tag === 'h3' ||
      tag === 'dt' ||
      tag === 'li' ||
      (tag === 'p' && el.getAttribute('class') === 'draft');
    if (wanted) blocks.push(el.textContent?.trim() ?? '');
    for (const child of Array.from(el.childNodes)) if (child.nodeType === 1) walk(child as Element);
  };
  if (doc.documentElement) walk(doc.documentElement);
  return blocks;
}

const count = (text: string, mark: string) => text.split(mark).length - 1;

describe('Markdown export follows the Region panel', () => {
  it.each(dossiers.map((d) => [d.name, d] as const))('%s: same fields, same order', (_, dossier) => {
    const markdown = dossierMarkdown(dossier);
    let from = 0;
    for (const block of panelBlocks(dossier)) {
      const at = markdown.indexOf(block, from);
      expect({ block, found: at >= 0 }).toEqual({ block, found: true });
      from = at + block.length;
    }
  });

  it('keeps every ⟨draft⟩ mark the panel shows', () => {
    for (const dossier of dossiers) {
      const html = renderToStaticMarkup(<Dossier dossier={dossier} onClose={() => {}} />);
      const drafts = [
        dossier.oneSentence,
        dossier.characterLine,
        dossier.whatWouldKillIt,
        dossier.whatWouldSaveIt,
      ].filter((t) => t.placeholder).length;
      expect(drafts).toBeGreaterThan(0);
      // The panel adds one explanatory line containing the mark; the Markdown does not.
      expect(count(html, PLACEHOLDER_MARK)).toBe(drafts + 1);
      expect(count(dossierMarkdown(dossier), PLACEHOLDER_MARK)).toBe(drafts);
    }
    const set = setMarkdown(pack.setAnalysis as SetAnalysis, dossiers);
    expect(count(set, PLACEHOLDER_MARK)).toBe(
      dossiers.reduce((sum, d) => sum + count(dossierMarkdown(d), PLACEHOLDER_MARK), 0),
    );
  });
});
