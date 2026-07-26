import { clamp, smoothstep } from './noise.js';

export function createEnvironmentState() {
  return {
    atmosphere: 0, cameraHeight: Infinity, solarElevation: 1,
    directTransmittance: 1, skyIrradiance: 0, opticalDepth: 0,
    aerialPerspective: 0, cloudDensity: 0, underwater: false,
    day: 1, eclipse: 0, sunset: 0, exposure: 1.05,
  };
}

export function updateEnvironmentState(state, {
  cameraHeight = Infinity, atmosphereHeight = 0, atmosphereDensity = 0,
  solarElevation = 1, eclipse = 0, cloudDensity = 0, underwater = false,
  dt = 1 / 60,
} = {}) {
  const heightK = atmosphereHeight > 0
    ? clamp(cameraHeight / atmosphereHeight, 0, 1.5) : 1.5;
  const atmosphere = (1 - smoothstep(0.02, 1.08, heightK)) * atmosphereDensity;
  const tangentBoost = 1 + 3.5 * (1 - Math.abs(clamp(solarElevation, -1, 1)));
  const opticalDepth = atmosphere * tangentBoost;
  const directTransmittance = Math.exp(-opticalDepth * 0.34) * (1 - eclipse * 0.92);
  const day = smoothstep(-0.2, 0.24, solarElevation) * (0.08 + 0.92 * (1 - eclipse));
  const sunset = atmosphere * (1 - smoothstep(0.08, 0.34, solarElevation))
    * smoothstep(-0.24, -0.035, solarElevation);
  const skyIrradiance = atmosphere * (0.025 + day * 0.975);
  const targetExposure = clamp(1.11 - skyIrradiance * 0.12 + (1 - day) * atmosphere * 0.08, 0.92, 1.18);
  const adapt = 1 - Math.exp(-Math.max(0, dt) * (targetExposure > state.exposure ? 0.8 : 0.45));

  Object.assign(state, {
    atmosphere, cameraHeight, solarElevation, directTransmittance,
    skyIrradiance, opticalDepth, aerialPerspective: 1 - Math.exp(-opticalDepth * 0.22),
    cloudDensity, underwater, day, eclipse, sunset,
    exposure: state.exposure + (targetExposure - state.exposure) * adapt,
  });
  return state;
}

