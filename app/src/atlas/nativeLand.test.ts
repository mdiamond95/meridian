import { describe, expect, it } from 'vitest';
import { nativeLandPlan } from './nativeLand';

describe('nativeLandPlan', () => {
  it('draws nothing of theirs until permission is granted, and says why', () => {
    const plan = nativeLandPlan('pending');
    expect(plan.granted).toBe(false);
    expect(plan.url).toBeNull();
    expect(plan.notice).toMatch(/only with permission/);
  });

  it('says so plainly when permission was refused', () => {
    expect(nativeLandPlan('refused').notice).toMatch(/was not given/);
  });

  it('points at the built layer under the site base once granted', () => {
    const plan = nativeLandPlan('granted', '/meridian/');
    expect(plan.granted).toBe(true);
    expect(plan.url).toBe('/meridian/layers/native_land.v1.topojson.gz');
  });

  it('treats anything it does not recognise as not granted', () => {
    expect(nativeLandPlan('').granted).toBe(false);
    expect(nativeLandPlan('yes').granted).toBe(false);
  });
});
