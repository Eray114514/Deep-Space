// Independent dense Simpson reference. No production quadrature/LUT imports.
export function referenceColumn(profile, radius, mu, distance, steps = 32768) {
  const result = [0, 0, 0];
  const dt = distance / steps;
  for (let i = 0; i <= steps; i++) {
    const t = i * dt;
    const h = Math.max(0, Math.sqrt(radius ** 2 + t ** 2 + 2 * radius * mu * t)
      - profile.groundRadiusMeters);
    const density = [Math.exp(-h / profile.rayleighScaleHeightMeters),
      Math.exp(-h / profile.mieScaleHeightMeters),
      Math.max(0, 1 - Math.abs(h - profile.ozoneCenterMeters) / profile.ozoneHalfWidthMeters)];
    const weight = i === 0 || i === steps ? 1 : i % 2 ? 4 : 2;
    for (let c = 0; c < 3; c++) result[c] += density[c] * weight * dt / 3;
  }
  return result;
}

export function columnFixtures(profile) {
  const R = profile.groundRadiusMeters;
  const top = profile.topRadiusMeters;
  const up = (name, h, mu) => {
    const radius = R + h;
    return { name, radius, mu,
      distance: -radius * mu + Math.sqrt((radius * mu) ** 2 + top ** 2 - radius ** 2) };
  };
  const tangent = (h) => {
    const half = Math.sqrt(top ** 2 - (R + h) ** 2);
    return { name: `orbit-tangent-${h}`, radius: top, mu: -half / top, distance: 2 * half };
  };
  return [up('zenith', 0, 1), up('low-oblique', 100, 0.08), up('ground-grazing', 0, 0),
    up('sunset', 1000, -0.01), up('high-up', Math.min(32000, profile.topAltitudeMeters * 0.8), 0.1), tangent(100), tangent(8000),
    { name: 'orbit-nadir', radius: top, mu: -1, distance: top - R }];
}
