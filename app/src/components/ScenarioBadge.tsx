import { useAtlasStore } from '../state/atlasStore';
import { useUiStore } from '../state/uiStore';

/** Shown over the map whenever the atlas is a scenario rather than the record (plan Phase 6 §1). */
export function ScenarioBadge() {
  const scenario = useAtlasStore((s) => s.scenario);
  const setScenario = useAtlasStore((s) => s.setScenario);
  const setTab = useUiStore((s) => s.setPanelTab);
  if (!scenario) return null;
  const skipped = scenario.skipped.length;
  return (
    <div className="scenario-badge" data-testid="scenario-badge" role="status">
      <button className="link-button" onClick={() => setTab('scenario')}>
        <span className="eyebrow">Scenario</span> {scenario.scenario.name}
      </button>
      {skipped > 0 && (
        <span className="hint">
          {skipped} base event{skipped === 1 ? '' : 's'} skipped
        </span>
      )}
      <button className="link-button" onClick={() => setScenario(null)} data-testid="scenario-exit">
        Back to the record
      </button>
    </div>
  );
}
