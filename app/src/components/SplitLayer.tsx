import { useEffect, useMemo, useRef } from 'react';
import L from 'leaflet';
import { nearestPlace, paintCell } from '../splitter/controller';
import { cellLocator, regionRings } from '../splitter/outline';
import { useSplitStore } from '../state/splitStore';

/**
 * The current split on the map (plan Phase 3 Sitting B §3–4): regions dissolved from the hex topology
 * and filled by colour, their names at their largest place, hover stats; and the map tools — paint
 * cells into the selected region, draw a scope polygon, pick places for pins.
 */

const PANE = 'split-regions';
const COMPARE_PANE = 'split-compare';
const fmt = new Intl.NumberFormat('en-CA');

function escapeHtml(text: string) {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function SplitLayer({ map }: { map: L.Map }) {
  const split = useSplitStore((s) => s.split);
  const topology = useSplitStore((s) => s.topology);
  const data = useSplitStore((s) => s.data);
  const selected = useSplitStore((s) => s.selectedRegion);
  const tool = useSplitStore((s) => s.tool);
  const drawPoints = useSplitStore((s) => s.drawPoints);
  const spec = useSplitStore((s) => s.spec);
  const pinDraft = useSplitStore((s) => s.pinDraft);
  const renderer = useRef<L.Canvas | null>(null);

  const compare = useSplitStore((s) => s.compare);
  const locate = useMemo(() => (data ? cellLocator(data.arrays) : null), [data]);
  const compareRings = useMemo(
    () => (compare && topology ? regionRings(topology, compare.assignment) : null),
    [compare, topology],
  );
  const rings = useMemo(
    () => (split && topology ? regionRings(topology, split.assignment) : null),
    [split, topology],
  );

  // Fit the map to a new split's scope (a new prepared split, not a painted cell).
  const fitted = useRef<unknown>(null);
  useEffect(() => {
    if (!split || !rings || fitted.current === split.prepared) return;
    fitted.current = split.prepared;
    const bounds = L.latLngBounds([]);
    for (const shape of rings.values())
      for (const ring of shape) for (const point of ring) bounds.extend(point);
    // Keep the scope clear of the panel (right on wide screens, a sheet below on iPad), as MapView does.
    const narrow = window.matchMedia('(max-width: 1024px)').matches;
    const padding: L.FitBoundsOptions = narrow
      ? { paddingTopLeft: [16, 60], paddingBottomRight: [16, 150] }
      : { paddingTopLeft: [60, 16], paddingBottomRight: [396, 110] };
    if (bounds.isValid()) map.fitBounds(bounds, { ...padding, maxZoom: 8 });
  }, [map, split, rings]);

  // Regions and their names.
  useEffect(() => {
    if (!split || !rings || !data) return;
    if (!map.getPane(PANE)) map.createPane(PANE).style.zIndex = '450';
    renderer.current ??= L.canvas({ pane: PANE, padding: 0.5 });
    const group = L.featureGroup();
    for (const region of split.regions) {
      const shape = rings.get(region.id);
      if (!shape) continue;
      const isSelected = selected === region.id;
      const polygon = L.polygon(shape, {
        renderer: renderer.current,
        pane: PANE,
        color: '#1f2328',
        weight: isSelected ? 3 : 1.2,
        opacity: 0.9,
        fillColor: split.colours[region.id],
        fillOpacity: isSelected ? 0.6 : 0.42,
        fillRule: 'evenodd',
        interactive: tool === 'none',
      });
      polygon.bindTooltip(
        `<strong>${escapeHtml(region.name)}</strong><br>${fmt.format(region.population)} people · ` +
          `${fmt.format(Math.round(region.areaKm2))} km²` +
          (region.gdp !== null
            ? `<br>GDP ≈ $${fmt.format(Math.round(region.gdp))} M (estimate, allocated)`
            : '') +
          `<br>compactness ${region.compactness.toFixed(2)}${region.pieces > 1 ? ` · ${region.pieces} pieces` : ''}`,
        { sticky: true },
      );
      polygon.on('click', () => useSplitStore.getState().selectRegion(isSelected ? null : region.id));
      group.addLayer(polygon);

      const place = data.places
        .filter((p) => split.assignment[p.cell] === region.id)
        .reduce<(typeof data.places)[number] | null>(
          (best, p) => (!best || p.population > best.population ? p : best),
          null,
        );
      if (place) {
        group.addLayer(
          L.marker([place.lat, place.lng], {
            pane: PANE,
            interactive: false,
            keyboard: false,
            icon: L.divIcon({
              className: 'region-label',
              html: `<span>${escapeHtml(region.name)}</span>`,
              iconSize: [0, 0],
            }),
          }),
        );
      }
    }
    group.addTo(map);
    return () => {
      group.remove();
    };
  }, [map, split, rings, data, selected, tool]);

  // Pinned places and the group being picked.
  useEffect(() => {
    if (!data) return;
    const group = L.featureGroup();
    const mark = (csd: string, kind: string) => {
      const place = data.placeByCsd.get(csd);
      if (!place) return;
      group.addLayer(
        L.circleMarker([place.lat, place.lng], {
          radius: 6,
          color: '#ffffff',
          weight: 2,
          fillColor: kind === 'apart' ? '#e34948' : kind === 'together' ? '#2a78d6' : '#2b2a27',
          fillOpacity: 1,
          pane: 'markerPane',
        }).bindTooltip(`${escapeHtml(place.name)} · ${kind === 'draft' ? 'picked' : `keep ${kind}`}`),
      );
    };
    spec.together.flat().forEach((csd) => mark(csd, 'together'));
    spec.apart.flat().forEach((csd) => mark(csd, 'apart'));
    pinDraft.forEach((csd) => mark(csd, 'draft'));
    if (drawPoints.length) {
      group.addLayer(
        L.polyline(
          drawPoints.map(([lng, lat]) => [lat, lng]),
          { color: '#1f2328', weight: 2, dashArray: '4 4' },
        ),
      );
    }
    group.addTo(map);
    return () => {
      group.remove();
    };
  }, [map, data, spec.together, spec.apart, pinDraft, drawPoints]);

  // The other split, right of the divider; this split is clipped to the left of it.
  useEffect(() => {
    const pane = map.getPane(PANE);
    if (!compare || !compareRings) {
      if (pane) pane.style.clipPath = '';
      return;
    }
    if (!map.getPane(COMPARE_PANE)) map.createPane(COMPARE_PANE).style.zIndex = '451';
    const other = map.getPane(COMPARE_PANE) as HTMLElement;
    const percent = Math.round(compare.divider * 100);
    if (pane) pane.style.clipPath = `inset(0 ${100 - percent}% 0 0)`;
    other.style.clipPath = `inset(0 0 0 ${percent}%)`;
    const group = L.featureGroup();
    compare.names.forEach((name, id) => {
      const shape = compareRings.get(id);
      if (!shape) return;
      const polygon = L.polygon(shape, {
        pane: COMPARE_PANE,
        renderer: L.canvas({ pane: COMPARE_PANE, padding: 0.5 }),
        color: '#1f2328',
        weight: 1.2,
        opacity: 0.9,
        fillColor: compare.colours[id],
        fillOpacity: 0.42,
        fillRule: 'evenodd',
        interactive: false,
      });
      polygon.bindTooltip(`${escapeHtml(name)} — ${escapeHtml(compare.name)}`, { sticky: true });
      group.addLayer(polygon);
    });
    group.addTo(map);
    return () => {
      group.remove();
      other.style.clipPath = '';
      if (pane) pane.style.clipPath = '';
    };
  }, [map, compare, compareRings]);

  // Map tools.
  useEffect(() => {
    if (tool === 'none') return;
    const container = map.getContainer();
    container.dataset.tool = tool;
    let painting = false;
    const paintAt = (e: L.LeafletMouseEvent) => {
      if (locate) paintCell(locate(e.latlng.lng, e.latlng.lat));
    };
    const onDown = (e: L.LeafletMouseEvent) => {
      if (tool !== 'paint') return;
      painting = true;
      paintAt(e);
    };
    const onMove = (e: L.LeafletMouseEvent) => {
      if (tool === 'paint' && painting) paintAt(e);
    };
    const onUp = () => {
      painting = false;
    };
    const onClick = (e: L.LeafletMouseEvent) => {
      const store = useSplitStore.getState();
      if (tool === 'draw') store.set({ drawPoints: [...store.drawPoints, [e.latlng.lng, e.latlng.lat]] });
      if (tool === 'together' || tool === 'apart') {
        const place = nearestPlace(e.latlng.lng, e.latlng.lat);
        if (place) store.set({ pinDraft: [...new Set([...store.pinDraft, place.csd])] });
      }
    };
    if (tool === 'paint') map.dragging.disable();
    map.doubleClickZoom.disable();
    map.on('mousedown', onDown);
    map.on('mousemove', onMove);
    map.on('mouseup', onUp);
    map.on('click', onClick);
    return () => {
      delete container.dataset.tool;
      map.dragging.enable();
      map.doubleClickZoom.enable();
      map.off('mousedown', onDown);
      map.off('mousemove', onMove);
      map.off('mouseup', onUp);
      map.off('click', onClick);
    };
  }, [map, tool, locate]);

  return null;
}
