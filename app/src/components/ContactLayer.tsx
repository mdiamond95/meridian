import { useEffect, useMemo, useRef } from 'react';
import L from 'leaflet';
import { CONTACT_TOPOLOGY_URL, CONTACT_URL } from '../atlas/assets';
import { loadContact } from '../atlas/loadContact';
import { dateToYear } from '../atlas/resolve';
import { BAND_INDEX, bandStyle, unreachedStyle } from '../atlas/style';
import { useAtlasStore } from '../state/atlasStore';

/**
 * The contact frontier: the earliest documented European presence, as bands.
 *
 * Two jobs, one layer. With the layer switched on, every band is drawn as a choropleth. With the
 * timeline's "contact frontier" start, the bands contact had not yet reached on the current date
 * are shaded instead, so dragging the slider moves the frontier across the country.
 *
 * The data is fetched the first time either is asked for, never on load.
 */
export function ContactLayer({ map }: { map: L.Map }) {
  const date = useAtlasStore((s) => s.date);
  const visible = useAtlasStore((s) => s.contactVisible);
  const start = useAtlasStore((s) => s.start);
  const contact = useAtlasStore((s) => s.contact);
  const setContact = useAtlasStore((s) => s.setContact);
  const setContactError = useAtlasStore((s) => s.setContactError);

  const wanted = visible || start === 'frontier';
  const layers = useRef(new Map<string, L.GeoJSON>());

  useEffect(() => {
    if (!wanted || contact) return;
    let cancelled = false;
    loadContact(CONTACT_URL, CONTACT_TOPOLOGY_URL)
      .then((loaded) => !cancelled && setContact(loaded))
      .catch((err: unknown) => {
        console.error(err);
        if (!cancelled) setContactError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [wanted, contact, setContact, setContactError]);

  useEffect(() => {
    if (!contact) return;
    contact.contact.bands.forEach((band, i) => BAND_INDEX.set(band.geometryRef, i));
  }, [contact]);

  const year = dateToYear(date);
  const drawn = useMemo(() => {
    if (!contact) return [];
    return contact.contact.bands.map((band) => {
      // A band is "reached" once the current year is inside or past it.
      const reached = band.fromYear === null || band.fromYear <= year;
      return { band, reached };
    });
  }, [contact, year]);

  useEffect(() => {
    if (!contact) return;
    const group = L.featureGroup().addTo(map);
    const cache = layers.current;
    for (const { band, reached } of drawn) {
      if (!reached && !(visible || start === 'frontier')) continue;
      if (reached && !visible) continue;
      let layer = cache.get(band.geometryRef);
      if (!layer) {
        const geometry = contact.geometries.get(band.geometryRef);
        if (!geometry) continue;
        layer = L.geoJSON(geometry, { interactive: false });
        cache.set(band.geometryRef, layer);
      }
      layer.setStyle(reached ? bandStyle(band) : unreachedStyle());
      layer.bindTooltip(
        reached
          ? `Documented European presence: ${band.label}`
          : `Not yet reached in ${year} (${band.label})`,
        { sticky: true },
      );
      group.addLayer(layer);
    }
    // Under the atlas units, which are the subject; this is context.
    group.bringToBack();
    return () => {
      group.remove();
    };
  }, [map, contact, drawn, visible, start]);

  return null;
}
