import { useMemo } from 'react';
import { currentEvent, dateToYear, formatDate, yearRange, yearToDate } from '../atlas/resolve';
import { useAtlasStore } from '../state/atlasStore';

/** Bottom timeline: a year slider with a tick per atlas event. */
export function Timeline() {
  const data = useAtlasStore((s) => s.data);
  const status = useAtlasStore((s) => s.status);
  const date = useAtlasStore((s) => s.date);
  const setDate = useAtlasStore((s) => s.setDate);

  const range = useMemo(() => (data ? yearRange(data.atlas, new Date()) : null), [data]);
  const event = data ? currentEvent(data.atlas, date) : null;

  if (!data || !range) {
    return (
      <footer className="timeline" data-testid="timeline" aria-label="Timeline">
        <p className="placeholder">{status === 'error' ? 'Atlas failed to load.' : 'Loading atlas…'}</p>
      </footer>
    );
  }

  const [min, max] = range;
  const year = dateToYear(date);
  const offset = (y: number) => `${((y - min) / (max - min || 1)) * 100}%`;

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
          onChange={(e) => setDate(yearToDate(Number(e.target.value)))}
        />
        <ol className="timeline-ticks" aria-label="Events">
          {data.atlas.events.map((e) => (
            <li key={e.date} style={{ left: offset(dateToYear(e.date)) }}>
              <button
                className="timeline-tick"
                data-active={event?.date === e.date}
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
