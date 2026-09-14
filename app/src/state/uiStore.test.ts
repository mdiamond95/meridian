import { beforeEach, describe, expect, it } from 'vitest';
import { useUiStore } from './uiStore';

describe('uiStore', () => {
  beforeEach(() => useUiStore.setState({ panelOpen: true, layersOpen: false }));

  it('toggles the panel and layers menu independently', () => {
    useUiStore.getState().togglePanel();
    expect(useUiStore.getState()).toMatchObject({ panelOpen: false, layersOpen: false });
    useUiStore.getState().toggleLayers();
    expect(useUiStore.getState()).toMatchObject({ panelOpen: false, layersOpen: true });
  });
});
