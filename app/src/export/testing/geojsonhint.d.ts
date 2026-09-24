// @mapbox/geojsonhint ships no types; this is the one function the tests call.
declare module '@mapbox/geojsonhint' {
  export interface HintError {
    message: string;
    line?: number;
    level?: 'message' | 'error';
  }
  export function hint(geojson: string | object, options?: { precisionWarning?: boolean }): HintError[];
}
