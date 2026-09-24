import { useEffect, useMemo } from 'react';
import L from 'leaflet';
import { OVERLAYS, type OverlayDef } from '../overlays/overlays';
import { ensureSplitterData } from '../splitter/controller';
import { useSplitStore } from '../state/splitStore';
import { useUiStore } from '../state/uiStore';

/** Five steps of one hue, light to dark, for an overlay's value. */
const RAMP = ['#f3d9c4', '#e5a97f', '#cf7a45', '#a8521f', '#6f3210'];
const rampColour = (value: number) => RAMP[Math.min(RAMP.length - 1, Math.floor(value * RAMP.length))];
const PANE = 'overlays';

/**
 * Draws the overlays switched on in the layers menu (plan Phase 6 §3) in their own pane above the
 * atlas and the split, so they sit over any partition and never change which region a cell is in.
 */
export function OverlayLayer({ map }: { map: L.Map }) {
  const on = useUiStore((s) => s.overlays);
  const data = useSplitStore((s) => s.data);
  const active = useMemo(() => OVERLAYS.filter((o) => on[o.id]), [on]);

  useEffect(() => {
    if (active.length) void ensureSplitterData();
  }, [active.length]);

  useEffect(() => {
    if (!map.getPane(PANE)) map.createPane(PANE).style.zIndex = '450';
    if (!data || active.length === 0) return;
    const group = L.featureGroup();
    for (const overlay of active) draw(overlay, data, group);
    group.addTo(map);
    return () => {
      group.remove();
    };
  }, [map, data, active]);

  return null;
}

function draw(overlay: OverlayDef, data: Parameters<OverlayDef['build']>[0], group: L.FeatureGroup) {
  if (overlay.kind === 'point') {
    for (const p of overlay.build(data)) {
      const colour = rampColour(p.value);
      L.circleMarker([p.lat, p.lng], {
        pane: PANE,
        radius: 5 + 25 * p.size,
        color: RAMP[RAMP.length - 1],
        weight: 1.5,
        fillColor: colour,
        fillOpacity: 0.55,
        className: `overlay-${overlay.id}`,
      })
        .bindTooltip(p.detail)
        .addTo(group);
    }
    return;
  }
  for (const f of overlay.build(data)) {
    L.polyline(
      [
        [f.from[1], f.from[0]],
        [f.to[1], f.to[0]],
      ],
      {
        pane: PANE,
        color: RAMP[3],
        weight: 1 + 7 * f.weight,
        opacity: 0.7,
        className: `overlay-${overlay.id}`,
      },
    )
      .bindTooltip(f.label)
      .addTo(group);
  }
}
