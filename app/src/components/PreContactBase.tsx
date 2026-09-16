import { indigenousShown } from '../atlas/loadIndigenous';
import { currentEvent } from '../atlas/resolve';
import { familyColour } from '../atlas/style';
import { INDIGENOUS_CAVEAT } from '../schema/indigenous';
import { useAtlasStore } from '../state/atlasStore';

/**
 * What the map says about Indigenous nations, and about the time before the atlas begins.
 *
 * Before the first event the base is the Indigenous language families and community names
 * (src/components/IndigenousLayer.tsx); they can also be switched on at any date. Whenever either
 * is drawn, its caveat is shown, and it comes from the schema, not from the data: this is a modern
 * and linguistic reconstruction drawn under historical dates, and must say so every time. The
 * contact frontier's caveat joins it whenever that layer is doing the talking.
 */
export function PreContactBase() {
  const data = useAtlasStore((s) => s.data);
  const date = useAtlasStore((s) => s.date);
  const start = useAtlasStore((s) => s.start);
  const contact = useAtlasStore((s) => s.contact);
  const contactVisible = useAtlasStore((s) => s.contactVisible);
  const familiesVisible = useAtlasStore((s) => s.familiesVisible);
  const communitiesVisible = useAtlasStore((s) => s.communitiesVisible);
  const indigenous = useAtlasStore((s) => s.indigenous);
  const indigenousError = useAtlasStore((s) => s.indigenousError);

  const before = data ? currentEvent(data.atlas, date) === null : false;
  const shown = indigenousShown({ familiesVisible, communitiesVisible }, before);
  const showIndigenous = shown.families || shown.communities;
  const showContactCaveat = contactVisible || start === 'frontier';
  if (!showIndigenous && !showContactCaveat) return null;

  const drawnFamilies = new Set(indigenous?.indigenous.areas.map((a) => a.family));
  const legend = indigenous?.indigenous.families.filter((f) => drawnFamilies.has(f.code)) ?? [];

  return (
    <aside className="pre-contact" data-testid="pre-contact" aria-live="polite">
      {showIndigenous && (
        <section data-testid="indigenous-caveat">
          <p className="pre-contact-notice">
            <strong>{INDIGENOUS_CAVEAT}</strong>
          </p>
          {indigenousError && (
            <p className="pre-contact-notice">
              The Indigenous layers could not be loaded ({indigenousError}).
            </p>
          )}
          {shown.families && legend.length > 0 && (
            <details className="pre-contact-caveat" data-testid="family-legend">
              <summary>Language families</summary>
              <ul className="family-legend">
                {legend.map((family) => (
                  <li key={family.code}>
                    <span className="family-swatch" style={{ background: familyColour(family.code) }} />
                    {family.label}
                  </li>
                ))}
              </ul>
              <p>
                Solid: the family with the most mother-tongue speakers (2021 Census). Faint: no speakers
                counted, so the nearest language in Glottolog, including extinct ones.
              </p>
            </details>
          )}
          {indigenous && (
            <details className="pre-contact-caveat">
              <summary>Sources</summary>
              <ul className="source-list">
                {indigenous.indigenous.attribution.map((a) => (
                  <li key={a.source}>
                    {a.text}{' '}
                    <a href={a.url} target="_blank" rel="noreferrer">
                      {a.licence}
                    </a>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}
      {showContactCaveat && contact && (
        <details className="pre-contact-caveat" data-testid="contact-caveat">
          <summary>About these contact dates</summary>
          <p>{contact.contact.caveat}</p>
        </details>
      )}
    </aside>
  );
}
