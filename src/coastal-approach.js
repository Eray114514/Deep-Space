import { Vector3 } from 'three';

// A charted inlet on the home planet. These are navigation coordinates;
// every contour, water depth and landing site is evaluated by the generator.
export const homeBay = {
  direction: [-0.2984226167430815, -0.14803814206060892, 0.9428831583560366],
  landward: [-0.19513392435399501, -0.9575671505246057, -0.21210352142856193],
};

export function coastalApproach(planet, site = homeBay) {
  const up = new Vector3(...site.direction).normalize();
  const inland = new Vector3(...site.landward).projectOnPlane(up).normalize();
  const along = new Vector3().crossVectors(up, inland).normalize();
  const directionAt = (x, y) => up.clone()
    .addScaledVector(inland, x / planet.R).addScaledVector(along, y / planet.R).normalize();
  const elevation = (x, y) => planet.height(directionAt(x, y), planet.fullMaxFreq) - planet.seaLevel;

  // Find a dry terrace with room for the ship's entire footprint.
  let pad = site.pad;
  if (!pad || elevation(...pad) < 5) {
    pad = null;
    let best = -Infinity;
    for (let x = 160; x <= 1600; x += 80) {
      for (let y = -900; y <= 900; y += 90) {
        const h = elevation(x, y);
        if (h < 5 || h > 180) continue;
        const neighbors = [elevation(x - 28, y), elevation(x + 28, y),
          elevation(x, y - 28), elevation(x, y + 28)];
        const relief = Math.max(...neighbors.map(v => Math.abs(v - h)));
        const score = -2 * relief - Math.abs(x - 600) / 800 - Math.abs(y) / 1200;
        if (score > best) { best = score; pad = [x, y]; }
      }
    }
  }
  if (!pad) throw new Error('No dry landing terrace along this coast');

  let offshore = site.offshore;
  if (!offshore) {
    let best = -Infinity;
    for (let degrees = -84; degrees <= 84; degrees += 4) {
      const angle = degrees * Math.PI / 180;
      const axis = [-Math.cos(angle), Math.sin(angle)];
      if (elevation(axis[0] * 850, axis[1] * 850) >= -3) continue;
      let score = 0;
      for (const distance of [180, 380, 700, 1200, 2400, 4000, 6500, 9000]) {
        const depth = -elevation(axis[0] * distance, axis[1] * distance);
        score += Math.max(-100, Math.min(depth, 60)) * (distance < 2500 ? 2 : 1);
      }
      if (score > best) { best = score; offshore = axis; }
    }
  }
  if (!offshore) throw new Error('No open-water approach to this coast');

  // Trace the final leg to its actual shallow-water crossing, not an
  // assumed distance from the charted shoreline.
  let wet = 0, dry = 1;
  for (let step = 0; step < 18; step++) {
    const t = (wet + dry) / 2;
    const x = offshore[0] * 850 * (1 - t) + pad[0] * t;
    const y = offshore[1] * 850 * (1 - t) + pad[1] * t;
    if (elevation(x, y) < -2) wet = t;
    else dry = t;
  }
  const bearing = Math.atan2(-offshore[1], -offshore[0]);
  return {
    route: { direction: up.toArray(), landward: inland.toArray(), pad, offshore, surfFraction: wet },
    along: along.toArray(),
    pose(distance, padFraction, clearance, pitch, turn) {
      const dir = directionAt(offshore[0] * distance + pad[0] * padFraction,
        offshore[1] * distance + pad[1] * padFraction);
      const forward = inland.clone().multiplyScalar(Math.cos(bearing + turn))
        .addScaledVector(along, Math.sin(bearing + turn));
      return { dir: dir.toArray(), forward: forward.toArray(), clearance, pitch };
    },
  };
}
