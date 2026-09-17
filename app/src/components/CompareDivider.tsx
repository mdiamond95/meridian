import { useEffect, useRef } from 'react';
import { setDivider } from '../splitter/controller';
import { useSplitStore } from '../state/splitStore';

/** The swipe divider over the map in compare mode: drag it, or use the slider in the panel. */
export function CompareDivider() {
  const compare = useSplitStore((s) => s.compare);
  const handle = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = handle.current;
    if (!element || !compare) return;
    const move = (event: PointerEvent) => {
      const parent = element.parentElement;
      if (!parent) return;
      const box = parent.getBoundingClientRect();
      setDivider((event.clientX - box.left) / box.width);
    };
    const up = (event: PointerEvent) => {
      element.releasePointerCapture(event.pointerId);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    const down = (event: PointerEvent) => {
      element.setPointerCapture(event.pointerId);
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    };
    element.addEventListener('pointerdown', down);
    return () => {
      element.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [compare]);

  if (!compare) return null;
  return (
    <div
      ref={handle}
      className="compare-divider"
      data-testid="compare-divider"
      style={{ left: `${compare.divider * 100}%` }}
      role="separator"
      aria-label="Compare divider"
      aria-valuenow={Math.round(compare.divider * 100)}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') setDivider(compare.divider - 0.02);
        if (e.key === 'ArrowRight') setDivider(compare.divider + 0.02);
      }}
    >
      <span className="compare-grip" aria-hidden="true" />
    </div>
  );
}
