import { useEffect, useState } from 'react';
import { NATIVE_LAND_PERMISSION, nativeLandPlan } from '../atlas/nativeLand';
import { currentEvent } from '../atlas/resolve';
import { useAtlasStore } from '../state/atlasStore';

/**
 * What the map says about the time before the atlas begins.
 *
 * Before the first event there are no units to draw, and the honest thing is to say why rather
 * than show an empty country: the territories that would fill it are Native Land Digital's, and
 * their data is used only with permission (see src/atlas/nativeLand.ts). When the flag is granted
 * the layer loads; until then this notice stands in for it, with the contact frontier's caveat
 * beside it whenever that layer is doing the talking.
 */
export function PreContactBase() {
  const data = useAtlasStore((s) => s.data);
  const date = useAtlasStore((s) => s.date);
  const start = useAtlasStore((s) => s.start);
  const contact = useAtlasStore((s) => s.contact);
  const contactVisible = useAtlasStore((s) => s.contactVisible);
  const [layerError, setLayerError] = useState<string | null>(null);

  const plan = nativeLandPlan(NATIVE_LAND_PERMISSION, import.meta.env.BASE_URL);
  const before = data ? currentEvent(data.atlas, date) === null : false;

  useEffect(() => {
    if (!plan.granted || !plan.url || !before) return;
    let cancelled = false;
    // Permission granted: the layer is fetched at runtime, not bundled, because it does not exist
    // in the build until the pipeline has been allowed to fetch it.
    fetch(plan.url)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .then(() => !cancelled && setLayerError(null))
      .catch((err: unknown) => {
        if (!cancelled) setLayerError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [plan.granted, plan.url, before]);

  const showCaveat = contactVisible || start === 'frontier';
  if (!before && !showCaveat) return null;

  return (
    <aside className="pre-contact" data-testid="pre-contact" aria-live="polite">
      {before && <p className="pre-contact-notice">{plan.notice}</p>}
      {before && layerError && (
        <p className="pre-contact-notice">
          Native Land’s layer is permitted but has not been built yet ({layerError}).
        </p>
      )}
      {showCaveat && contact && (
        <details className="pre-contact-caveat" data-testid="contact-caveat">
          <summary>About these contact dates</summary>
          <p>{contact.contact.caveat}</p>
        </details>
      )}
    </aside>
  );
}
