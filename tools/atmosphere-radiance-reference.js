// Independent fine uniform integration, with direct Simpson solar columns.
// No production LUT, view quadrature or GLSL imports.
import { referenceColumn } from './atmosphere-reference.js';

export function referenceAir(profile, { origin, direction, distance, sun, densityScale = 1,
  radianceScale = 3.2, steps = 4096, sunSteps = 256 }) {
  const R = profile.groundRadiusMeters, top = profile.topRadiusMeters;
  const L = [0, 0, 0], T = [1, 1, 1], ds = distance / steps;
  const mu = direction.reduce((v, x, i) => v + x * sun[i], 0);
  const rayPhase = 3 / (16 * Math.PI) * (1 + mu * mu);
  const miePhase = (1 - 0.8 ** 2) / (4 * Math.PI * (1 + 0.8 ** 2 - 1.6 * mu) ** 1.5);
  for (let i = 0; i < steps; i++) {
    const p = origin.map((x, c) => x + direction[c] * (i + 0.5) * ds);
    const r = Math.hypot(...p), h = r - R;
    if (h < 0 || h > profile.topAltitudeMeters) continue;
    const ray = Math.exp(-h / profile.rayleighScaleHeightMeters) * densityScale;
    const mie = Math.exp(-h / profile.mieScaleHeightMeters) * densityScale;
    const ozone = Math.max(0, 1 - Math.abs(h - profile.ozoneCenterMeters) / profile.ozoneHalfWidthMeters) * densityScale;
    const sunMu = p.reduce((v, x, c) => v + x * sun[c], 0) / r;
    const groundDisc = (r * sunMu) ** 2 + R * R - r * r;
    const blocked = groundDisc >= 0 && -r * sunMu - Math.sqrt(groundDisc) > 0;
    const sunDistance = -r * sunMu + Math.sqrt((r * sunMu) ** 2 + top * top - r * r);
    const column = blocked ? [0, 0, 0] : referenceColumn(profile, r, sunMu, sunDistance, sunSteps).map((x) => x * densityScale);
    for (let c = 0; c < 3; c++) {
      const ext = profile.rayleigh[c] * ray + profile.mie.extinction[c] * mie + profile.ozoneAbsorption[c] * ozone;
      const sunT = blocked ? 0 : Math.exp(-(profile.rayleigh[c] * column[0]
        + profile.mie.extinction[c] * column[1] + profile.ozoneAbsorption[c] * column[2]));
      const source = (profile.rayleigh[c] * ray * rayPhase + profile.mie.scattering[c] * mie * miePhase) * sunT * radianceScale;
      L[c] += T[c] * source * (ext ? -Math.expm1(-ext * ds) / ext : ds);
      T[c] *= Math.exp(-ext * ds);
    }
  }
  return { L, T };
}
