import { useEffect, useMemo } from 'react';
import L from 'leaflet';
import { resolveReferences } from '../atlas/resolve';
import { REFERENCE_STYLE } from '../atlas/style';
import { useAtlasStore } from '../state/atlasStore';

/**
 * NRCan's drawing where the atlas departs from it (AtlasFile.references), as a dashed outline
 * over the atlas. Off by default; the OGL attribution appears while it is shown.
 */
export function ReferenceLayer({ map }: { map: L.Map }) {
  const data = useAtlasStore((s) => s.data);
  const date = useAtlasStore((s) => s.date);
  const visible = useAtlasStore((s) => s.visible && s.nrcanVisible);

  const references = useMemo(
    () => (data && visible ? resolveReferences(data.atlas, date) : []),
    [data, date, visible],
  );

  useEffect(() => {
    if (!data || references.length === 0) return;
    const group = L.featureGroup();
    for (const ref of references) {
      const geometry = data.geometries.get(ref.geometryRef);
      if (!geometry) continue;
      const layer = L.geoJSON(geometry, {
        style: REFERENCE_STYLE,
        attribution: ref.attribution,
        interactive: false,
      });
      layer.bindTooltip(`NRCan's drawing: ${ref.name}`, { sticky: true });
      group.addLayer(layer);
    }
    group.addTo(map);
    return () => {
      group.remove();
    };
  }, [map, data, references]);

  return null;
}
