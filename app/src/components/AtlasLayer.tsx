import { useCallback, useEffect, useMemo, useRef } from 'react';
import L from 'leaflet';
import type { Geometry } from 'geojson';
import { resolveUnits, resolvedAt } from '../atlas/resolve';
import { unitStyle } from '../atlas/style';
import type { AtlasUnit } from '../schema/atlas';
import { activeTruthLayers, useAtlasStore } from '../state/atlasStore';
import { useUiStore } from '../state/uiStore';

// The drawing and the claim tooltip are baked into a cached layer, so they are part of its key: a
// scenario's row can share a base row's id and date and still be drawn differently.
const rowKey = (u: AtlasUnit) => `${u.id}@${u.validFrom}@${u.geometryRef}@${u.sovereign}@${u.name}`;

/** How long one idle slice may hold the main thread while the user is moving the slider. */
const SLICE_MS = 8;
/** Once the slider has been still this long, a slice may take a whole idle period. */
const STILL_MS = 150;
const STILL_SLICE_MS = 50;
/**
 * Attaching a row (Leaflet projecting and drawing its path) costs about one millisecond per this
 * many vertices: measured at 2,750 in the Codespace's headless Chromium (docs/perf.md), rounded down
 * for slower devices. The refill starts a row only when it expects the row to fit the time left.
 */
const VERTICES_PER_MS = 2000;

/**
 * Event windows either side of the current one whose rows are kept on the map, hidden. Stepping
 * the slider across an event then only shows and hides paths that are already projected, and idle
 * slices re-fill the far edge after each crossing (docs/perf.md).
 */
export const LOOKAHEAD = 3;

/** One unit row: a single path for its whole drawing, attached to the map or not, shown or not. */
interface Row {
  unit: AtlasUnit;
  layer: L.Polygon;
  vertices: number;
  attached: boolean;
  shown: boolean;
  /** the selection state its style was last set for */
  selected: boolean;
}

function polygons(geometry: Geometry): number[][][][] {
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  if (geometry.type === 'GeometryCollection') return geometry.geometries.flatMap(polygons);
  return [];
}

/** Show or hide a row's path without detaching it: a style flip, no projection. */
function setShown(row: Row, shown: boolean) {
  row.shown = shown;
  const el = row.layer.getElement() as SVGElement | undefined;
  if (el) el.style.display = shown ? '' : 'none';
}

/**
 * Draws the units valid on the store's date. A row's layer is built once and kept; the rows of the
 * LOOKAHEAD event windows either side of the current one stay attached with their paths hidden, so
 * a slider step across an event is a visibility swap, not a projection.
 */
export function AtlasLayer({ map }: { map: L.Map }) {
  const data = useAtlasStore((s) => s.data);
  const date = useAtlasStore((s) => s.date);
  const visible = useAtlasStore((s) => s.visible);
  const truth = useAtlasStore((s) => s.truth);
  const selected = useAtlasStore((s) => s.selected);
  const select = useAtlasStore((s) => s.select);
  const openPanel = useUiStore((s) => s.openPanel);

  const root = useRef<L.FeatureGroup | null>(null);
  const rows = useRef(new Map<string, Row>());
  /** When the slider last moved, for the refill's budget. */
  const moved = useRef(0);

  const truthLayers = useMemo(() => activeTruthLayers(truth), [truth]);
  // Resolving at the current event's date, not the slider's date, keeps this array identical
  // across every step inside one event window, so the effects below do nothing until the set
  // actually changes.
  const asOf = useMemo(() => (data ? resolvedAt(data.atlas, date) : ''), [data, date]);
  const units = useMemo(
    () => (data && visible && asOf ? resolveUnits(data.atlas, asOf, truthLayers) : []),
    [data, asOf, visible, truthLayers],
  );
  // Every distinct event date, oldest first: the windows the slider moves between.
  const windows = useMemo(() => (data ? [...new Set(data.atlas.events.map((e) => e.date))] : []), [data]);

  useEffect(() => {
    moved.current = performance.now();
  }, [date]);

  // Build one unit row's layer, or return the row already built. Nothing is projected here.
  const ensureRow = useCallback(
    (unit: AtlasUnit): Row | null => {
      const key = rowKey(unit);
      const existing = rows.current.get(key);
      if (existing) return existing;
      const geometry = data?.geometries.get(unit.geometryRef);
      if (!geometry) return null;
      const parts = polygons(geometry as Geometry);
      const layer = L.polygon(L.GeoJSON.coordsToLatLngs(parts, 2) as L.LatLng[][][], {
        ...unitStyle(unit, false),
        bubblingMouseEvents: false,
      });
      // A hatch has to say whose claim it is; two claims over the same ground each get their own.
      if (unit.truth === 'disputed') {
        layer.bindTooltip(`${unit.name} — claimed by ${unit.sovereign}`, { sticky: true });
      }
      layer.on('click', () => {
        select(unit.id);
        openPanel();
      });
      const vertices = parts.reduce((n, rings) => n + rings.reduce((m, ring) => m + ring.length, 0), 0);
      const row: Row = { unit, layer, vertices, attached: false, shown: false, selected: false };
      rows.current.set(key, row);
      return row;
    },
    [data, select, openPanel],
  );

  // Put a row's path on the map, hidden unless asked. SVG draws in DOM order and de jure rows belong
  // beneath the other truth layers, so a de jure row attached late sends those back above it.
  const attach = useCallback((row: Row, shown: boolean) => {
    if (!root.current || row.attached) return;
    root.current.addLayer(row.layer);
    row.attached = true;
    setShown(row, shown);
    if (row.unit.truth !== 'dejure') return;
    for (const other of rows.current.values()) {
      if (other.attached && other.unit.truth !== 'dejure') other.layer.bringToFront();
    }
  }, []);

  useEffect(() => {
    const g = L.featureGroup().addTo(map);
    const cache = rows.current;
    root.current = g;
    return () => {
      g.remove();
      cache.clear();
      root.current = null;
    };
  }, [map]);

  // The crossing: show the resolved set, hide the rest. Rows inside the lookahead are already
  // attached, so this is a style flip; a row the refill has not reached is attached here.
  useEffect(() => {
    if (!root.current || !data) return;
    const wanted = new Set(units.map(rowKey));
    for (const [key, row] of rows.current) if (row.shown && !wanted.has(key)) setShown(row, false);
    for (const unit of units) {
      const row = ensureRow(unit);
      if (!row) continue;
      if (!row.attached) attach(row, true);
      else if (!row.shown) setShown(row, true);
    }
  }, [units, data, ensureRow, attach]);

  // Keep the neighbouring windows attached and hidden, and let go of rows that fell out of range.
  // Runs in idle slices after every crossing, so it never lands inside a slider step. While the
  // slider is moving a slice starts a row only if it should fit the idle time left, so the refill
  // does not drop frames; the largest drawings wait until the slider is still.
  useEffect(() => {
    if (!data || !visible) return;
    const index = asOf ? windows.indexOf(asOf) : -1;
    // Nearest windows first (this one, the next, the previous, …), so a slice spent on the far edge
    // never delays the rows the next crossing needs.
    const order: number[] = [];
    for (let d = 0; d <= LOOKAHEAD; d += 1) {
      for (const i of d === 0 ? [index] : [index + d, index - d])
        if (i >= 0 && i < windows.length) order.push(i);
    }
    const pending: Row[] = [];
    const near = new Set<Row>();
    for (const i of order) {
      for (const unit of resolveUnits(data.atlas, windows[i], truthLayers)) {
        const row = ensureRow(unit);
        if (!row || near.has(row)) continue;
        near.add(row);
        if (!row.attached) pending.push(row);
      }
    }
    const container = map.getContainer();
    delete container.dataset.atlasLookahead;
    let handle = 0;
    let cancelled = false;
    // requestIdleCallback where it exists (not Safari), a timeout otherwise.
    const hasIdle = typeof window.requestIdleCallback === 'function';
    const schedule = (run: (deadline?: IdleDeadline) => void) => {
      // The timeout matters: Chromium can go seconds without declaring an idle period (seen after a
      // pan with a split on the map), and the refill must not wait on it.
      handle = hasIdle ? window.requestIdleCallback(run, { timeout: 250 }) : window.setTimeout(run, 16);
    };
    const step = (deadline?: IdleDeadline) => {
      if (cancelled) return;
      const started = performance.now();
      const still = started - moved.current > STILL_MS;
      // Inside an idle period its deadline is the budget; run by timeout or setTimeout, a fixed slice.
      const left = () =>
        deadline && !deadline.didTimeout
          ? deadline.timeRemaining()
          : (still ? STILL_SLICE_MS : SLICE_MS) - (performance.now() - started);
      let first = true;
      while (pending.length) {
        const row = pending[0];
        if (row.attached) {
          pending.shift();
          continue;
        }
        // A row too big for any slice goes in alone once the slider is still.
        const fits = row.vertices / VERTICES_PER_MS <= left();
        if (!fits && !(still && first)) break;
        attach(row, false);
        pending.shift();
        first = false;
      }
      if (pending.length) {
        schedule(step);
        return;
      }
      // Detach rows outside the range: they would otherwise be re-projected on every zoom.
      for (const row of rows.current.values()) {
        if (!row.attached || row.shown || near.has(row)) continue;
        root.current?.removeLayer(row.layer);
        row.attached = false;
      }
      container.dataset.atlasLookahead = asOf || 'none';
    };
    schedule(step);
    return () => {
      cancelled = true;
      if (hasIdle) window.cancelIdleCallback(handle);
      else window.clearTimeout(handle);
    };
  }, [data, visible, asOf, windows, truthLayers, map, ensureRow, attach]);

  // Warm the cache while the browser is idle: every row's layer is built (not attached), so even a
  // jump beyond the lookahead only projects paths, and never converts geometry.
  useEffect(() => {
    if (!data) return;
    const pending = [...data.atlas.units];
    const container = map.getContainer();
    let handle = 0;
    let cancelled = false;
    // Each slice is capped at SLICE_MS of work, so warming never holds the main thread through an
    // interaction.
    const hasIdle = typeof window.requestIdleCallback === 'function';
    const schedule = (run: () => void) => {
      handle = hasIdle ? window.requestIdleCallback(run, { timeout: 500 }) : window.setTimeout(run, 16);
    };
    const cancel = () => (hasIdle ? window.cancelIdleCallback(handle) : window.clearTimeout(handle));
    const step = () => {
      const started = performance.now();
      while (pending.length && performance.now() - started < SLICE_MS) {
        ensureRow(pending.shift() as AtlasUnit);
      }
      if (pending.length && !cancelled) schedule(step);
      // Every row is built: the slider can now cross any event without converting geometry.
      else if (!cancelled) container.dataset.atlasWarm = 'true';
    };
    delete container.dataset.atlasWarm;
    schedule(step);
    return () => {
      cancelled = true;
      cancel();
    };
  }, [data, map, ensureRow]);

  // Restyle only rows whose selection state changed; the selected unit is raised so its outline is
  // whole. Styles are set when a row is built, so a crossing restyles nothing.
  useEffect(() => {
    for (const unit of units) {
      const row = rows.current.get(rowKey(unit));
      if (!row) continue;
      const isSelected = unit.id === selected;
      if (row.selected !== isSelected) {
        row.layer.setStyle(unitStyle(unit, isSelected));
        row.selected = isSelected;
      }
      if (isSelected) row.layer.bringToFront();
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
