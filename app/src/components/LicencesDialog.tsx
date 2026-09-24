import { useEffect, useRef } from 'react';
import licences from '../licences/licences.json';
import { useUiStore } from '../state/uiStore';

/**
 * Licences and sources (plan Phase 7 §5): every attribution string in docs/data-sources.md, compiled
 * by `npm run licences` into src/licences/licences.json, with the sources each one covers. Opened
 * from the layers menu, the map's attribution line, or a #licences link.
 */

interface Source {
  id: string;
  name: string;
  licence: string;
  licenceUrl: string | null;
}
interface Attribution {
  attribution: string;
  use: 'built' | 'displayed';
  sources: Source[];
}

const GROUPS = licences as Attribution[];

function Group({ group }: { group: Attribution }) {
  const licenceNames = [...new Map(group.sources.map((s) => [s.licence, s.licenceUrl])).entries()];
  const list = (
    <ul className="licence-sources">
      {group.sources.map((s) => (
        <li key={s.id}>{s.name}</li>
      ))}
    </ul>
  );
  return (
    <li className="licence" data-testid="licence">
      <p className="licence-attribution">{group.attribution}</p>
      <p className="hint">
        {licenceNames.map(([name, url], i) => (
          <span key={name}>
            {i > 0 && '; '}
            {url ? (
              <a href={url} target="_blank" rel="noreferrer">
                {name}
              </a>
            ) : (
              name
            )}
          </span>
        ))}
      </p>
      {group.sources.length > 3 ? (
        <details>
          <summary>{group.sources.length} sources</summary>
          {list}
        </details>
      ) : (
        list
      )}
    </li>
  );
}

export function LicencesDialog() {
  const open = useUiStore((s) => s.licencesOpen);
  const setOpen = useUiStore((s) => s.setLicencesOpen);
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || typeof dialog.showModal !== 'function') return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const close = () => {
    setOpen(false);
    if (location.hash === '#licences') history.replaceState(null, '', location.pathname + location.search);
  };

  return (
    <dialog
      ref={ref}
      className="licences"
      data-testid="licences"
      aria-labelledby="licences-title"
      onClose={close}
    >
      <header className="licences-header">
        <h2 id="licences-title">Licences and sources</h2>
        <button onClick={close} aria-label="Close licences">
          Close
        </button>
      </header>
      <p>
        Meridian's code is under the MIT licence. Its data keeps the licence it was published under, and every
        source is credited below with the attribution its publisher asks for. The full table, with download
        addresses and refresh cadence, is <code>docs/data-sources.md</code> in the repository.
      </p>
      <h3>Built into the map's data</h3>
      <ul className="licence-list">
        {GROUPS.filter((g) => g.use === 'built').map((g) => (
          <Group key={g.attribution} group={g} />
        ))}
      </ul>
      <h3>Shown live</h3>
      <ul className="licence-list">
        {GROUPS.filter((g) => g.use === 'displayed').map((g) => (
          <Group key={g.attribution} group={g} />
        ))}
      </ul>
      <p className="hint">
        Native Land Digital's data is not used: its terms forbid storing or redistributing it, and the project
        declined it. The Indigenous language-family layer is built from the census and Glottolog instead.
      </p>
    </dialog>
  );
}
