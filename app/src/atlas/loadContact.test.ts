import { describe, expect, it } from 'vitest';
import type { Topology } from '../schema/topojson';
import { ContactFileSchema, type ContactFile } from '../schema/contact';
import { decodeContact } from './loadContact';

const TOPOLOGY: Topology = {
  type: 'Topology',
  transform: { scale: [1, 1], translate: [0, 0] },
  arcs: [
    [
      [0, 0],
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
    ],
  ],
  objects: { contact_start_1500: { type: 'Polygon', arcs: [[0]] } },
};

const FILE: ContactFile = {
  format: 'meridian.contact',
  version: 'v1',
  caveat: '"First contact" is a European frame.',
  bands: [{ label: 'Before 1500', fromYear: null, untilYear: 1500, geometryRef: 'contact_start_1500' }],
  regions: [
    {
      id: 'newfoundland_island',
      name: 'Newfoundland',
      year: 1497,
      event: "Cabot's landfall, 24 June 1497",
      confidence: 0.75,
      source: 'https://www.biographi.ca/en/bio/cabot_john_1E.html',
    },
  ],
};

describe('contact frontier', () => {
  it('decodes one polygon per band', () => {
    const loaded = decodeContact(FILE, TOPOLOGY);
    expect(loaded.geometries.get('contact_start_1500')?.type).toBe('Polygon');
    expect(loaded.contact.caveat).toMatch(/European frame/);
  });

  it('requires the caveat: these years never travel without it', () => {
    const { caveat, ...withoutCaveat } = FILE;
    expect(caveat).toBeTruthy();
    expect(() => ContactFileSchema.parse(withoutCaveat)).toThrow();
  });

  it('rejects a band that ends before it starts', () => {
    const broken = { ...FILE, bands: [{ ...FILE.bands[0], fromYear: 1600, untilYear: 1500 }] };
    expect(() => ContactFileSchema.parse(broken)).toThrow(/ends before it starts/);
  });

  it('rejects two bands sharing a geometry', () => {
    const broken = { ...FILE, bands: [FILE.bands[0], { ...FILE.bands[0], label: '1500–1599' }] };
    expect(() => ContactFileSchema.parse(broken)).toThrow(/duplicate band/);
  });
});
