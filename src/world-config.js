// Authored world definition layered over deterministic generation.
// A galaxy owns one generation seed; sparse body tuning keeps curated changes
// explicit without forking the procedural algorithms.

export const ACTIVE_GALAXY_ID = 'milky-way';

export const WORLD_CONFIG = Object.freeze({
  worldId: 'deep-space',
  galaxies: Object.freeze({
    'milky-way': Object.freeze({
      id: 'milky-way',
      name: '银河系',
      seed: 'MILKY-038',
      catalogVersion: 3,
      systemCount: 1024,
      morphology: Object.freeze({
        type: 'barred-spiral',
        majorArms: 2,
        minorArms: 2,
        radiusCells: 52,
        homeRegion: 'spur',
      }),
      blackHoleSystem: Object.freeze({
        id: 'black-hole:sagittarius-a',
        name: '人马座 A*',
        systemName: '银河中心引力观测区',
        catalogId: 'MW CORE-001',
        positionCells: Object.freeze([0, 0, 0]),
      }),
      bodyTuning: Object.freeze({
        // The selected home terrain has 18.6 km of peak-to-trough relief.
        // The former 900 km body fixed the worst asteroid silhouette, but its
        // horizon still made synoptic cloud systems and the troposphere read
        // as a miniature model. A 6,000 km authored radius retains the curated
        // terrain stream while giving surface flight, cloud parallax and the
        // atmosphere an honestly terrestrial curvature. The 120 km outer
        // medium is only 2% of the radius; optical density still falls on the
        // physical 8 km / 1.2 km Rayleigh/Mie scale heights.
        '0,0,0': Object.freeze({
          'planet-0': Object.freeze({
            radiusMeters: 6000000,
            atmosphereHeightMeters: 120000,
            cloudCoverage: 0.64,
            weatherStyle: 'temperate-synoptic',
            cloudLayer: Object.freeze({
              minAltitudeMeters: 2000,
              maxAltitudeMeters: 16000,
            }),
            clouds: Object.freeze({
              coverage: 0.64,
              probability: 0.9,
              condensates: Object.freeze(['H₂O液滴', 'H₂O冰晶']),
              regime: '多层温带锋面与对流云系',
            }),
          }),
          // Preserve the authored moon's 3.6-parent-radius spacing after the
          // larger planetary curation. StarSystem scales its period with r^1.5.
          'planet-0-moon-0': Object.freeze({
            orbitRadiusMeters: 21600000,
          }),
          // The original prompt explicitly calls for a water-dominated world
          // with violent open seas, shallow shelves and only scattered land.
          // Keep it in the home system so the category is immediately visible
          // in the deterministic system preview and can be visited without
          // searching the catalogue.
          'planet-1': Object.freeze({
            type: 'ocean',
            radiusMeters: 560000,
            seaLevelOffset: 1650,
            cloudCoverage: 0.72,
            oceanProfile: 'pelagic-storm',
            bathymetryScale: 0.24,
            atmosphere: Object.freeze({
              composition: Object.freeze(['N₂', 'O₂', 'H₂O']),
              pressureBar: 2.7,
              greenhouseK: 48,
              state: '稳定湿润温室层',
            }),
            clouds: Object.freeze({
              coverage: 0.72,
              probability: 0.94,
              condensates: Object.freeze(['H₂O液滴', 'H₂O冰晶']),
              regime: '广域风暴云系',
            }),
          }),
        }),
      }),
    }),
  }),
});

export function getGalaxyConfig(id = ACTIVE_GALAXY_ID) {
  return WORLD_CONFIG.galaxies[id] || WORLD_CONFIG.galaxies[ACTIVE_GALAXY_ID];
}

function finiteParam(params, key) {
  if (!params?.has(key)) return null;
  const value = Number(params.get(key));
  return Number.isFinite(value) ? value : null;
}

export function resolveBodyTuning({
  galaxyId = ACTIVE_GALAXY_ID,
  seed,
  systemId,
  bodyId,
  worldLabParams = null,
}) {
  const galaxy = getGalaxyConfig(galaxyId);
  const authored = seed === galaxy.seed
    ? galaxy.bodyTuning?.[systemId]?.[bodyId] || null
    : null;
  const tuning = authored ? { ...authored } : {};

  if (worldLabParams) {
    const targetSystem = worldLabParams.get('system') || '0,0,0';
    const targetBody = worldLabParams.get('body') || 'planet-0';
    if (systemId === targetSystem && bodyId === targetBody) {
      const seaLevelOffset = finiteParam(worldLabParams, 'sea');
      const cloudCoverage = finiteParam(worldLabParams, 'clouds');
      if (seaLevelOffset !== null) tuning.seaLevelOffset = Math.max(-6000, Math.min(6000, seaLevelOffset));
      if (cloudCoverage !== null) tuning.cloudCoverage = Math.max(0, Math.min(0.85, cloudCoverage));
    }
  }

  return tuning;
}

// Apply the sparse authored layer to the astronomy dossier itself. Runtime
// bodies, ephemeris frames and the two-level star-map preview must all consume
// the same tuned spec; applying radius/type only inside Planet construction
// made the 900 km home world remain a 286 km body in the system preview.
export function applySystemBodyTuning(spec, resolveTuning) {
  if (!spec || typeof resolveTuning !== 'function') return spec;
  const tuneBody = (body) => {
    const tuning = resolveTuning(body.bodyId) || null;
    if (!tuning) return body;
    const tuned = { ...body, orbit: body.orbit ? { ...body.orbit } : body.orbit };
    if (typeof tuning.type === 'string') tuned.type = tuning.type;
    if (Number.isFinite(tuning.radiusMeters)) tuned.radius = Math.max(1000, tuning.radiusMeters);
    if (tuning.atmosphere) tuned.atmosphere = { ...tuning.atmosphere };
    if (tuning.clouds) tuned.clouds = { ...tuning.clouds };
    if (tuned.orbit && Number.isFinite(tuning.orbitRadiusMeters)) {
      const previousRadius = Math.max(1, tuned.orbit.renderRadius || tuning.orbitRadiusMeters);
      tuned.orbit.renderRadius = Math.max(1000, tuning.orbitRadiusMeters);
      if (Number.isFinite(tuned.orbit.periodHours)) {
        tuned.orbit.periodHours *= Math.pow(tuned.orbit.renderRadius / previousRadius, 1.5);
      }
    }
    return tuned;
  };
  return {
    ...spec,
    bodies: (spec.bodies || []).map(tuneBody),
    compactObjects: (spec.compactObjects || []).map(tuneBody),
  };
}
