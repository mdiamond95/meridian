import type L from 'leaflet';
import { CLAIM_HATCH_ID, HATCH_ID } from '../atlas/style';

/**
 * SVG hatch patterns for the fills that must not read as solid colour: ground contact had not
 * reached, and ground two powers both claimed. A hatch says "this is a statement about a claim",
 * where a flat fill would say "this is how it was".
 *
 * Leaflet has no API for pattern fills, so the patterns are appended to the overlay pane's <svg>
 * and referenced as `fill="url(#id)"`. The pane's <svg> only exists once something has been drawn
 * into it, so this retries on animation frames until it appears.
 */

const PATTERNS = `
<pattern id="${HATCH_ID}" patternUnits="userSpaceOnUse" width="7" height="7" patternTransform="rotate(45)">
  <rect width="7" height="7" fill="#eef0f2" fill-opacity="0.55"/>
  <line x1="0" y1="0" x2="0" y2="7" stroke="#8b929b" stroke-width="1.6" stroke-opacity="0.8"/>
</pattern>
<pattern id="${CLAIM_HATCH_ID}" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(135)">
  <rect width="8" height="8" fill="#f6e2d8" fill-opacity="0.5"/>
  <line x1="0" y1="0" x2="0" y2="8" stroke="#c0532a" stroke-width="2" stroke-opacity="0.85"/>
</pattern>`;

export function installPatterns(map: L.Map): () => void {
  let frame = 0;
  let cancelled = false;
  const attach = () => {
    if (cancelled) return;
    const svg = map.getContainer().querySelector('.leaflet-overlay-pane svg');
    if (!svg) {
      frame = requestAnimationFrame(attach);
      return;
    }
    if (svg.querySelector(`#${HATCH_ID}`)) return;
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = PATTERNS;
    svg.insertBefore(defs, svg.firstChild);
  };
  attach();
  return () => {
    cancelled = true;
    if (frame) cancelAnimationFrame(frame);
  };
}
