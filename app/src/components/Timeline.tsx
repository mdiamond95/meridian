import { useMemo, useRef, type KeyboardEvent } from 'react';
import {
  currentEvent,
  dateToYear,
  formatDate,
  nextEvent,
  previousEvent,
  yearRange,
  yearToDate,
} from '../atlas/resolve';
import { eventKey } from '../scenario/apply';
import { startYear, useAtlasStore } from '../state/atlasStore';

/** Bottom timeline: a year slider with a tick per atlas event. */
export function Timeline() {
  const data = useAtlasStore((s) => s.data);
  const status = useAtlasStore((s) => s.status);
  const date = useAtlasStore((s) => s.date);
  const setDate = useAtlasStore((s) => s.setDate);
  const scenario = useAtlasStore((s) => s.scenario);

  const start = useAtlasStore((s) => s.start);
  const range = useMemo(() => (data ? yearRange(data.atlas, new Date()) : null), [data]);
  const event = data ? currentEvent(data.atlas, date) : null;
  const ticks = useRef<HTMLOListElement>(null);

  if (!data || !range) {
    return (
      <footer className="timeline" data-testid="timeline" aria-label="Timeline">
        <p className="placeholder">{status === 'error' ? 'Atlas failed to load.' : 'Loading atlas…'}</p>
      </footer>
    );
  }

  // The atlas begins in 1670; the start selector reaches back before it, where the map has only
  // the pre-contact base and, with "frontier", the contact bands.
  const [firstEvent, max] = range;
  const min = Math.min(firstEvent, startYear(start));
  const year = dateToYear(date);
  const offset = (y: number) => `${((y - min) / (max - min || 1)) * 100}%`;
  const events = data.atlas.events;
  // The tick that takes the row's one tab stop: the current event's, or the first before any.
  const focusable = event ?? events[0];

  // Page Up and Page Down on the slider jump to the next and previous event (the slider's own
  // Page keys would move a tenth of 1,000 years). Arrow keys, Home and End keep their meaning.
  const onSliderKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'PageUp' && e.key !== 'PageDown') return;
    e.preventDefault();
    const target = e.key === 'PageUp' ? nextEvent(events, date) : previousEvent(events, date);
    if (target) setDate(target.date);
  };

  // The ticks are one tab stop: arrows move between events (and the map with them), Home and End
  // go to the first and last event.
  const onTickKey = (e: KeyboardEvent<HTMLOListElement>) => {
    const at = focusable ? events.indexOf(focusable) : 0;
    const to =
      e.key === 'ArrowRight' || e.key === 'ArrowUp'
        ? Math.min(events.length - 1, at + 1)
        : e.key === 'ArrowLeft' || e.key === 'ArrowDown'
          ? Math.max(0, at - 1)
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? events.length - 1
              : -1;
    if (to < 0) return;
    e.preventDefault();
    setDate(events[to].date);
    ticks.current?.querySelectorAll<HTMLButtonElement>('.timeline-tick')[to]?.focus();
  };

  return (
    <footer className="timeline" data-testid="timeline" aria-label="Timeline">
      <div className="timeline-readout">
        <output className="timeline-year" htmlFor="timeline-slider" data-testid="timeline-year">
          {year}
        </output>
        <span className="timeline-event" data-testid="timeline-event">
          {event ? `${event.title} · ${formatDate(event.date)}` : 'Before the first event'}
        </span>
      </div>
      <div className="timeline-track">
        <input
          id="timeline-slider"
          className="timeline-slider"
          type="range"
          min={min}
          max={max}
          step={1}
          value={year}
          aria-label="Year"
          aria-valuetext={event ? `${year}: ${event.title}` : String(year)}
          aria-describedby="timeline-keys"
          onChange={(e) => setDate(yearToDate(Number(e.target.value)))}
          onKeyDown={onSliderKey}
        />
        <p id="timeline-keys" className="visually-hidden">
          Arrow keys move one year; Page Up and Page Down jump to the next and previous event.
        </p>
        <ol className="timeline-ticks" aria-label="Events" ref={ticks} onKeyDown={onTickKey}>
          {data.atlas.events.map((e) => (
            <li key={eventKey(e)} style={{ left: offset(dateToYear(e.date)) }}>
              <button
                className="timeline-tick"
                data-active={event === e}
                data-scenario={scenario?.scenarioEvents.has(eventKey(e)) || undefined}
                tabIndex={e === focusable ? 0 : -1}
                title={`${formatDate(e.date)}: ${e.title}`}
                aria-label={`${formatDate(e.date)}: ${e.title}`}
                onClick={() => setDate(e.date)}
              />
            </li>
          ))}
        </ol>
      </div>
    </footer>
  );
}
