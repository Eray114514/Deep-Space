// Concentrate integration cells around the closest point to the planet.
// Squared distance covers both legs of a tangent ray and also concentrates
// samples at the dense end of a vertical ray, in either viewing direction.
export const ATMOSPHERE_VIEW_STEPS = 48;
export const ATMOSPHERE_LUT_STEPS = 64;

export function atmosphereSampleBoundary(t0, t1, closest, fraction) {
  const center = Math.max(t0, Math.min(t1, closest));
  const left = Math.sqrt(center - t0);
  const right = Math.sqrt(t1 - center);
  const q = -left + (left + right) * fraction;
  return center + q * Math.abs(q);
}

// The browser regression evaluates this production GLSL against an independent
// dense uniform reference, including grazing rays and reversed paths.
export const atmosphereQuadratureGLSL = /* glsl */`
  float atmosphereSampleBoundary(float t0, float t1, float closest, float fraction) {
    float center = clamp(closest, t0, t1);
    float left = sqrt(max(center - t0, 0.0));
    float right = sqrt(max(t1 - center, 0.0));
    float q = mix(-left, right, fraction);
    return center + q * abs(q);
  }
`;
