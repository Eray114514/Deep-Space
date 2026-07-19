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
      seed: 'NAVEMI-382',
      blackHoleSystem: Object.freeze({
        id: 'black-hole:erebus',
        name: '厄瑞玻斯',
        systemName: '厄瑞玻斯引力观测区',
        catalogId: 'AF BH-001',
        positionCells: Object.freeze([17.4, -1.6, -16.2]),
      }),
      bodyTuning: Object.freeze({
        '0,0,0': Object.freeze({
          'planet-0': Object.freeze({
            seaLevelOffset: -420,
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
