/**
 * The Native Land gate.
 *
 * Native Land Digital's territory and language polygons are the obvious thing to draw before the
 * atlas begins, and they are not ours to draw: their data is used only with permission, and the
 * request is in docs/native-land-permission-request.md. Until `permissions.native_land_permission`
 * in pipeline/artefacts.yaml says `granted`, the pipeline fetches nothing of theirs and the app
 * shows a plain base and says why — rather than quietly showing an empty country, which would be
 * its own kind of claim.
 *
 * The permission value is inlined at build time (see vite.config.ts).
 */

export type NativeLandPermission = 'granted' | 'pending' | 'refused';

export interface NativeLandPlan {
  granted: boolean;
  /** Where the built layer would be served from, once there is one. */
  url: string | null;
  notice: string;
}

export const NATIVE_LAND_ATTRIBUTION =
  'Territory data © <a href="https://native-land.ca">Native Land Digital</a>, used with permission';

export function nativeLandPlan(permission: string, base = '/'): NativeLandPlan {
  if (permission === 'granted') {
    return {
      granted: true,
      url: `${base}layers/native_land.v1.topojson.gz`,
      notice:
        'Indigenous territories are shown from Native Land Digital, which is a living map of ' +
        'nations, not an authoritative record of boundaries.',
    };
  }
  const refused = permission === 'refused';
  return {
    granted: false,
    url: null,
    notice: refused
      ? 'Indigenous nations’ territories are not drawn here: permission to use Native Land Digital’s data was not given.'
      : 'Indigenous nations’ territories are not drawn here yet: Native Land Digital’s data is used only with permission, which we have asked for and not yet received.',
  };
}

export const NATIVE_LAND_PERMISSION: string = __NATIVE_LAND_PERMISSION__;
