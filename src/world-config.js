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
      bodyTuning: Object.freeze({}),
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
