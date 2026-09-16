import { useEffect, useMemo } from 'react';
import L from 'leaflet';
import { INDIGENOUS_TOPOLOGY_URL, INDIGENOUS_URL } from '../atlas/assets';
import {
  COMMUNITY_ATTRIBUTION,
  INDIGENOUS_ATTRIBUTION,
  indigenousShown,
  labelledAreas,
  loadIndigenous,
} from '../atlas/loadIndigenous';
import { currentEvent } from '../atlas/resolve';
import { familyStyle } from '../atlas/style';
import { useAtlasStore } from '../state/atlasStore';

/**
 * Indigenous language families as a choropleth, and community names as labels.
 *
 * Before the atlas begins they are the pre-contact base and are drawn without being asked; at any
 * date each can be switched on from the layers menu. Families sit in their own pane under the
 * atlas and the contact frontier, which stay the subject; names sit above everything.
 *
 * Community names appear from zoom 6 (CSS on `data-community-labels`), because 600-odd labels at
 * country scale are unreadable; below that only the dots are drawn.
 */
const FAMILY_PANE = 'indigenous-families';
const COMMUNITY_PANE = 'indigenous-communities';
const COMMUNITY_LABEL_ZOOM = 6;
const PEOPLE_LABELS = { first_nation: 'First Nation', inuit: 'Inuit community', metis: 'Métis Settlement' };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function ensurePane(map: L.Map, name: string, zIndex: number) {
  const pane = map.getPane(name) ?? map.createPane(name);
  pane.style.zIndex = String(zIndex);
}

export function IndigenousLayer({ map }: { map: L.Map }) {
  const data = useAtlasStore((s) => s.data);
  const date = useAtlasStore((s) => s.date);
  const familiesVisible = useAtlasStore((s) => s.familiesVisible);
  const communitiesVisible = useAtlasStore((s) => s.communitiesVisible);
  const indigenous = useAtlasStore((s) => s.indigenous);
  const setIndigenous = useAtlasStore((s) => s.setIndigenous);
  const setIndigenousError = useAtlasStore((s) => s.setIndigenousError);

  const beforeAtlas = data ? currentEvent(data.atlas, date) === null : false;
  const shown = indigenousShown({ familiesVisible, communitiesVisible }, beforeAtlas);
  const wanted = shown.families || shown.communities;

  useEffect(() => {
    if (!wanted || indigenous) return;
    let cancelled = false;
    loadIndigenous(INDIGENOUS_URL, INDIGENOUS_TOPOLOGY_URL)
      .then((loaded) => !cancelled && setIndigenous(loaded))
      .catch((err: unknown) => {
        console.error(err);
        if (!cancelled) setIndigenousError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [wanted, indigenous, setIndigenous, setIndigenousError]);

  const labels = useMemo(
    () => new Map(indigenous?.indigenous.families.map((f) => [f.code, f.label]) ?? []),
    [indigenous],
  );

  useEffect(() => {
    if (!indigenous || !shown.families) return;
    ensurePane(map, FAMILY_PANE, 350);
    const group = L.featureGroup();
    const named = new Set(labelledAreas(indigenous.indigenous.areas).map((a) => a.geometryRef));
    for (const area of indigenous.indigenous.areas) {
      const geometry = indigenous.geometries.get(area.geometryRef);
      if (!geometry) continue;
      const name = labels.get(area.family) ?? `Family ${area.family}`;
      const how =
        area.source === 'census'
          ? 'most mother-tongue speakers, 2021 Census'
          : 'nearest language in Glottolog, inferred';
      const layer = L.geoJSON(geometry, {
        pane: FAMILY_PANE,
        style: familyStyle(area),
        attribution: INDIGENOUS_ATTRIBUTION,
      });
      layer.bindTooltip(`${escapeHtml(name)} — ${how} (confidence ${area.confidence})`, { sticky: true });
      group.addLayer(layer);
      // The family's name on the map, so no family is identified by colour alone.
      if (!named.has(area.geometryRef)) continue;
      group.addLayer(
        L.marker([area.labelPoint[1], area.labelPoint[0]], {
          pane: FAMILY_PANE,
          interactive: false,
          keyboard: false,
          icon: L.divIcon({
            className: `family-label family-label-${area.source}`,
            html: `<span>${escapeHtml(name)}</span>`,
            iconSize: [0, 0],
          }),
        }),
      );
    }
    group.addTo(map);
    return () => {
      group.remove();
    };
  }, [map, indigenous, labels, shown.families]);

  useEffect(() => {
    if (!indigenous || !shown.communities) return;
    ensurePane(map, COMMUNITY_PANE, 620);
    const container = map.getContainer();
    const onZoom = () => {
      container.dataset.communityLabels = map.getZoom() >= COMMUNITY_LABEL_ZOOM ? 'on' : 'off';
    };
    onZoom();
    map.on('zoomend', onZoom);
    const group = L.featureGroup();
    for (const community of indigenous.indigenous.communities) {
      const dot = L.circleMarker([community.lat, community.lng], {
        pane: COMMUNITY_PANE,
        radius: 2.5,
        color: '#ffffff',
        weight: 1,
        fillColor: '#2b2a27',
        fillOpacity: 0.9,
        attribution: COMMUNITY_ATTRIBUTION,
      });
      dot.bindTooltip(`${escapeHtml(community.name)} · ${PEOPLE_LABELS[community.people]}`, {
        permanent: true,
        direction: 'right',
        offset: [6, 0],
        className: 'community-label',
      });
      group.addLayer(dot);
    }
    group.addTo(map);
    return () => {
      map.off('zoomend', onZoom);
      delete container.dataset.communityLabels;
      group.remove();
    };
  }, [map, indigenous, shown.communities]);

  return null;
}
