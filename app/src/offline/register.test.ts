import { describe, expect, it } from 'vitest';
import { visibleTileUrls } from './register';

describe('visibleTileUrls', () => {
  it("reports the loaded tiles of the map's zoom, not the level Leaflet is still fading out", () => {
    const pane = document.createElement('div');
    pane.innerHTML = [
      '<img class="leaflet-tile leaflet-tile-loaded" src="https://a.example/light_all/4/2/4.png?key=k">',
      '<img class="leaflet-tile leaflet-tile-loaded" src="https://a.example/light_all/6/10/18@2x.png?key=k">',
      '<img class="leaflet-tile leaflet-tile-loaded" src="https://tile.example/6/10/19.png">',
      '<img class="leaflet-tile" src="https://tile.example/6/10/20.png">',
    ].join('');
    expect(visibleTileUrls(pane, 6)).toEqual([
      'https://a.example/light_all/6/10/18@2x.png?key=k',
      'https://tile.example/6/10/19.png',
    ]);
  });
});
