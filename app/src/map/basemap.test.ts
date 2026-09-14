import { describe, expect, it } from 'vitest';
import { selectBasemap } from './basemap';

describe('selectBasemap', () => {
  it('uses CARTO Positron with the key when one is set', () => {
    const basemap = selectBasemap('abc123');
    expect(basemap.provider).toBe('carto-positron');
    expect(basemap.url).toContain('basemaps.cartocdn.com/light_all/');
    expect(basemap.url).toMatch(/\?key=abc123$/);
    expect(basemap.options.attribution).toContain('CARTO');
    expect(basemap.options.attribution).toContain('OpenStreetMap');
  });

  it.each([undefined, '', '   '])('falls back to OpenStreetMap standard tiles when the key is %j', (key) => {
    const basemap = selectBasemap(key);
    expect(basemap.provider).toBe('osm-standard');
    expect(basemap.url).toBe('https://tile.openstreetmap.org/{z}/{x}/{y}.png');
    expect(basemap.options.attribution).toContain('openstreetmap.org/copyright');
    expect(basemap.options.attribution).toContain('OpenStreetMap</a> contributors');
    expect(basemap.options.maxZoom).toBe(19);
  });
});
