import { useEffect, useMemo, useRef } from 'react';
import L from 'leaflet';
import { resolveUnits } from '../atlas/resolve';
import { unitStyle } from '../atlas/style';
import type { AtlasUnit } from '../schema/atlas';
import { activeTruthLayers, useAtlasStore } from '../state/atlasStore';
import { useUiStore } from '../state/uiStore';

const rowKey = (u: AtlasUnit) => `${u.id}@${u.validFrom}`;

/**
 * Draws the units valid on the store's date. Leaflet layers are built once per unit row and kept,
 * so dragging the slider only adds and removes layers when it crosses an event.
 */
export function AtlasLayer({ map }: { map: L.Map }) {
  const data = useAtlasStore((s) => s.data);
  const date = useAtlasStore((s) => s.date);
  const visible = useAtlasStore((s) => s.visible);
  const truth = useAtlasStore((s) => s.truth);
  const selected = useAtlasStore((s) => s.selected);
  const select = useAtlasStore((s) => s.select);
  const openPanel = useUiStore((s) => s.openPanel);

  const group = useRef<L.FeatureGroup | null>(null);
  const layers = useRef(new Map<string, L.GeoJSON>());

  const units = useMemo(
    () => (data && visible ? resolveUnits(data.atlas, date, activeTruthLayers(truth)) : []),
    [data, date, visible, truth],
  );

  useEffect(() => {
    const g = L.featureGroup().addTo(map);
    const cache = layers.current;
    group.current = g;
    return () => {
      g.remove();
      cache.clear();
      group.current = null;
    };
  }, [map]);

  // Add and remove layers for the resolved set; de jure first so other truth layers draw on top.
  useEffect(() => {
    const g = group.current;
    if (!g || !data) return;
    const wanted = new Set(units.map(rowKey));
    for (const [key, layer] of layers.current) {
      if (!wanted.has(key) && g.hasLayer(layer)) g.removeLayer(layer);
    }
    for (const unit of units) {
      const key = rowKey(unit);
      let layer = layers.current.get(key);
      if (!layer) {
        const geometry = data.geometries.get(unit.geometryRef);
        if (!geometry) continue;
        layer = L.geoJSON(geometry, { bubblingMouseEvents: false });
        layer.on('click', () => {
          select(unit.id);
          openPanel();
        });
        layers.current.set(key, layer);
      }
      if (!g.hasLayer(layer)) g.addLayer(layer);
    }
  }, [units, data, select, openPanel]);

  // Restyle when the selection changes; the selected unit is raised so its outline is whole.
  useEffect(() => {
    for (const unit of units) {
      const layer = layers.current.get(rowKey(unit));
      if (!layer) continue;
      const isSelected = unit.id === selected;
      layer.setStyle(unitStyle(unit, isSelected));
      if (isSelected) layer.bringToFront();
    }
  }, [units, selected]);

  // Clicking the map outside every unit clears the selection.
  useEffect(() => {
    const clear = () => select(null);
    map.on('click', clear);
    return () => {
      map.off('click', clear);
    };
  }, [map, select]);

  return null;
}
