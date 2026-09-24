import { useEffect, useMemo } from 'react';
import L from 'leaflet';
import { formatDate, resolvedAt } from '../atlas/resolve';
import { diffAtDate } from '../scenario/apply';
import { activeTruthLayers, useAtlasStore } from '../state/atlasStore';

/** The base atlas's drawing of a unit a scenario removed or redrew: a dashed outline, never a fill. */
const BASE_STYLE: L.PathOptions = {
  color: '#1f2328',
  weight: 2,
  opacity: 0.8,
  dashArray: '6 6',
  fill: false,
};

/**
 * Diff against the base on the map (plan Phase 6 §1): while a scenario is active, the base's units that
 * the scenario removed or redrew on the current date are outlined, so the branch shows what it replaced.
 */
export function BaseOutlineLayer({ map }: { map: L.Map }) {
  const base = useAtlasStore((s) => s.base);
  const data = useAtlasStore((s) => s.data);
  const scenario = useAtlasStore((s) => s.scenario);
  const date = useAtlasStore((s) => s.date);
  const on = useAtlasStore((s) => s.visible && s.baseOutlines);
  const truth = useAtlasStore((s) => s.truth);

  const asOf = useMemo(() => (data ? resolvedAt(data.atlas, date) : ''), [data, date]);
  const outlined = useMemo(() => {
    if (!base || !data || !scenario || !on || !asOf) return [];
    return diffAtDate(base, data, asOf, activeTruthLayers(truth)).flatMap((d) =>
      d.kind === 'removed' || (d.kind === 'changed' && d.fields.includes('boundary')) ? [d.base] : [],
    );
  }, [base, data, scenario, on, asOf, truth]);

  useEffect(() => {
    if (!base || outlined.length === 0) return;
    const group = L.featureGroup();
    for (const unit of outlined) {
      const geometry = base.geometries.get(unit.geometryRef);
      if (!geometry) continue;
      const layer = L.geoJSON(geometry, { style: BASE_STYLE, interactive: false });
      layer.bindTooltip(`In the base atlas: ${unit.name} (from ${formatDate(unit.validFrom)})`, {
        sticky: true,
      });
      group.addLayer(layer);
    }
    group.addTo(map);
    return () => {
      group.remove();
    };
  }, [map, base, outlined]);

  return null;
}
