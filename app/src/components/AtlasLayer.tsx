import { useCallback, useEffect, useMemo, useRef } from 'react';
import L from 'leaflet';
import { resolveUnits, resolvedAt } from '../atlas/resolve';
import { unitStyle } from '../atlas/style';
import type { AtlasUnit } from '../schema/atlas';
import { activeTruthLayers, useAtlasStore } from '../state/atlasStore';
import { useUiStore } from '../state/uiStore';

// The drawing and the claim tooltip are baked into a cached layer, so they are part of its key: a
// scenario's row can share a base row's id and date and still be drawn differently.
const rowKey = (u: AtlasUnit) => `${u.id}@${u.validFrom}@${u.geometryRef}@${u.sovereign}@${u.name}`;

/** How long one cache-warming slice may hold the main thread. */
const SLICE_MS = 8;

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

  // Resolving at the current event's date, not the slider's date, keeps this array identical
  // across every step inside one event window, so the effects below do nothing until the set
  // actually changes.
  const asOf = useMemo(() => (data ? resolvedAt(data.atlas, date) : ''), [data, date]);
  const units = useMemo(
    () => (data && visible && asOf ? resolveUnits(data.atlas, asOf, activeTruthLayers(truth)) : []),
    [data, asOf, visible, truth],
  );

  // Build one unit row's Leaflet layer, or return the one already built.
  const ensureLayer = useCallback(
    (unit: AtlasUnit): L.GeoJSON | null => {
      const key = rowKey(unit);
      const existing = layers.current.get(key);
      if (existing) return existing;
      const geometry = data?.geometries.get(unit.geometryRef);
      if (!geometry) return null;
      const layer = L.geoJSON(geometry, { bubblingMouseEvents: false });
      // A hatch has to say whose claim it is; two claims over the same ground each get their own.
      if (unit.truth === 'disputed') {
        layer.bindTooltip(`${unit.name} — claimed by ${unit.sovereign}`, { sticky: true });
      }
      layer.on('click', () => {
        select(unit.id);
        openPanel();
      });
      layers.current.set(key, layer);
      return layer;
    },
    [data, select, openPanel],
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
      const layer = ensureLayer(unit);
      if (layer && !g.hasLayer(layer)) g.addLayer(layer);
    }
  }, [units, data, ensureLayer]);

  // Warm the cache while the browser is idle. Building a row's paths is the expensive part of a
  // slider step (p95 was 35 ms the first time an event was crossed, docs/perf.md); once every row
  // is built, crossing an event only adds and removes layers that already exist.
  useEffect(() => {
    if (!data) return;
    const pending = [...data.atlas.units];
    const container = map.getContainer();
    let handle = 0;
    let cancelled = false;
    // requestIdleCallback where it exists (not Safari), a timeout otherwise. Either way each slice
    // is capped at SLICE_MS of work, so warming never holds the main thread through an interaction.
    const hasIdle = typeof window.requestIdleCallback === 'function';
    const schedule = (run: () => void) => {
      handle = hasIdle ? window.requestIdleCallback(run, { timeout: 500 }) : window.setTimeout(run, 16);
    };
    const cancel = () => (hasIdle ? window.cancelIdleCallback(handle) : window.clearTimeout(handle));
    const step = () => {
      const started = performance.now();
      while (pending.length && performance.now() - started < SLICE_MS) {
        ensureLayer(pending.shift() as AtlasUnit);
      }
      if (pending.length && !cancelled) schedule(step);
      // Every row is built: the slider can now cross any event without building paths.
      else if (!cancelled) container.dataset.atlasWarm = 'true';
    };
    delete container.dataset.atlasWarm;
    schedule(step);
    return () => {
      cancelled = true;
      cancel();
    };
  }, [data, map, ensureLayer]);

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
