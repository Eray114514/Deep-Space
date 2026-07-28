export const GRAPHICS_SETTINGS_KEY = 'deep-space.graphics.v1';
export const GRAPHICS_SETTINGS_VERSION = 1;

export const QUALITY_PROFILES = Object.freeze({
  performance: Object.freeze({
    id: 'performance', label: '性能', dprMin: 0.85, dprTarget: 0.9, dprMax: 1.0,
    volumeScale: 0.45, cloudSteps: 48, cloudStepsWebGPU: 24, shadowMap: 1024, shadowDistance: 180,
    terrainScreenError: 1.35, grassRadius: 28, grassDensity: 0.62,
    treeDensity: 0.55, waterInteractionSize: 256, waterReflectionHz: 15,
    waterReflectionScale: 0.35, parallaxDistance: 0, analyticSkyFallback: true,
    adaptiveOrder: ['volumeScale', 'cloudSteps', 'waterReflectionHz', 'grassDensity',
      'shadowDistance', 'treeDensity', 'dpr'],
  }),
  balanced: Object.freeze({
    id: 'balanced', label: '均衡', dprMin: 0.95, dprTarget: 1.0, dprMax: 1.35,
    volumeScale: 0.6, cloudSteps: 80, cloudStepsWebGPU: 40, shadowMap: 2048, shadowDistance: 350,
    terrainScreenError: 1.0, grassRadius: 45, grassDensity: 0.82,
    treeDensity: 0.8, waterInteractionSize: 512, waterReflectionHz: 30,
    waterReflectionScale: 0.5, parallaxDistance: 0, analyticSkyFallback: false,
    adaptiveOrder: ['volumeScale', 'cloudSteps', 'waterReflectionHz', 'grassDensity',
      'shadowDistance', 'treeDensity', 'dpr'],
  }),
  ultra: Object.freeze({
    id: 'ultra', label: '极致', dprMin: 1.15, dprTarget: 1.25, dprMax: 1.5,
    volumeScale: 0.75, cloudSteps: 124, cloudStepsWebGPU: 56, shadowMap: 4096, shadowDistance: 650,
    terrainScreenError: 0.72, grassRadius: 70, grassDensity: 1,
    treeDensity: 1, waterInteractionSize: 1024, waterReflectionHz: 60,
    waterReflectionScale: 0.75, parallaxDistance: 15, analyticSkyFallback: false,
    adaptiveOrder: ['volumeScale', 'cloudSteps', 'waterReflectionHz', 'grassDensity',
      'shadowDistance', 'treeDensity', 'dpr'],
  }),
});

const QUALITY_VALUES = new Set(['auto', 'performance', 'balanced', 'ultra']);
const RENDERER_VALUES = new Set(['auto', 'webgl', 'webgpu']);

export function sanitizeGraphicsSettings(value = {}) {
  return {
    version: GRAPHICS_SETTINGS_VERSION,
    quality: QUALITY_VALUES.has(value.quality) ? value.quality : 'auto',
    // Renderer is not a player preference. Keep the field for V1 migration
    // and diagnostics, but discard any previously saved manual backend.
    renderer: 'auto',
  };
}

export function readGraphicsSettings(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(GRAPHICS_SETTINGS_KEY) || 'null');
    return parsed?.version === GRAPHICS_SETTINGS_VERSION
      ? sanitizeGraphicsSettings(parsed) : sanitizeGraphicsSettings();
  } catch {
    return sanitizeGraphicsSettings();
  }
}

export function writeGraphicsSettings(settings, storage = globalThis.localStorage) {
  const value = sanitizeGraphicsSettings(settings);
  storage?.setItem(GRAPHICS_SETTINGS_KEY, JSON.stringify(value));
  return value;
}

function urlQuality(params) {
  const value = params?.get?.('quality');
  if (value === 'low') return 'performance';
  if (value === 'high') return 'ultra';
  return QUALITY_VALUES.has(value) ? value : null;
}

function urlRenderer(params) {
  const value = params?.get?.('renderer');
  return RENDERER_VALUES.has(value) ? value : null;
}

export function resolveGraphicsSettings({ params = new URLSearchParams(), storage = globalThis.localStorage } = {}) {
  const saved = readGraphicsSettings(storage);
  const qualityOverride = urlQuality(params);
  const rendererOverride = urlRenderer(params);
  return {
    ...sanitizeGraphicsSettings({ quality: qualityOverride || saved.quality }),
    renderer: rendererOverride || 'auto',
    source: {
      quality: qualityOverride ? 'url' : saved.quality !== 'auto' ? 'saved' : 'auto',
      renderer: rendererOverride ? 'url' : 'auto',
    },
  };
}

// Classify the real WEBGL_debug_renderer_info / WebGPU adapter strings before
// mapping them to the renderer-independent quality profiles above.
export function classifyGpuTier(gpuName = '') {
  if (!gpuName) return 'unknown';
  if (/SwiftShader|llvmpipe|Microsoft Basic Render|Google SwiftShader/i.test(gpuName)) return 'low';

  if (/NVIDIA|GeForce/i.test(gpuName)) {
    if (/GeForce\s*(?:MX\d{3}|940M|930M|920M)/i.test(gpuName)) return 'low';
    if (/GeForce\s*(?:GTX\s*)?(?:10[45]0|16[35]0)/i.test(gpuName)) return 'low';
    if (/GeForce\s*(?:GTX\s*)?(?:1060|1070|1660)/i.test(gpuName)) return 'mid';
    if (/GeForce\s*(?:GTX\s*)?1080/i.test(gpuName)) return 'high';
    if (/RTX\s*20\d0/i.test(gpuName)) {
      return /RTX\s*20[89]0/i.test(gpuName) ? 'high' : 'mid';
    }
    if (/RTX\s*30\d0/i.test(gpuName)) {
      return /RTX\s*30(?:90|80)/i.test(gpuName) && !/Laptop/i.test(gpuName)
        ? 'high' : 'mid';
    }
    if (/RTX\s*40\d0/i.test(gpuName)) {
      if (/RTX\s*40(?:90|80)/i.test(gpuName) || /RTX\s*4070\s*Ti/i.test(gpuName)) return 'high';
      return /Laptop/i.test(gpuName) ? 'mid' : 'high';
    }
    if (/RTX\s*50[789]0/i.test(gpuName)) return 'high';
    if (/RTX\s*50[56]0/i.test(gpuName)) return /Laptop/i.test(gpuName) ? 'mid' : 'high';
    return 'mid';
  }

  if (/AMD|Radeon/i.test(gpuName)) {
    if (/Radeon\s*\(TM\)\s*Graphics|Vega\s*\d+|Vega Mobile/i.test(gpuName)) return 'low';
    if (/RX\s*9\d{3}/i.test(gpuName)) return 'high';
    if (/RX\s*7\d{3}/i.test(gpuName)) return /RX\s*79\d0/i.test(gpuName) ? 'high' : 'mid';
    if (/RX\s*6\d{3}/i.test(gpuName)) {
      if (/RX\s*6[45]\d0/i.test(gpuName)) return 'low';
      if (/RX\s*6(?:[89]\d0|95\d)/i.test(gpuName)) return 'high';
      return 'mid';
    }
    if (/RX\s*5\d{3}/i.test(gpuName)) return /RX\s*57\d0/i.test(gpuName) ? 'mid' : 'low';
    if (/Radeon\s*(?:RX\s*)?[45]\d{2,3}/i.test(gpuName)) return 'low';
    return 'mid';
  }

  if (/Intel/i.test(gpuName)) {
    if (/Arc[^\d]*[AB]\d{3,4}/i.test(gpuName)) {
      return /Arc[^\d]*[AB][5-8]\d{2,3}/i.test(gpuName) ? 'mid' : 'low';
    }
    return 'low';
  }

  if (/Apple\s*M/i.test(gpuName)) {
    return /Apple\s*M[1-4]\s*(?:Pro|Max|Ultra)/i.test(gpuName) ? 'high' : 'mid';
  }
  return 'unknown';
}

export function isLowPowerGpu(gpuName = '') {
  return classifyGpuTier(gpuName) === 'low';
}

export function chooseAutomaticQuality(gpuName = '', { width = 1920, height = 1080 } = {}) {
  const tier = classifyGpuTier(gpuName);
  if (tier === 'high') return 'ultra';
  if (tier === 'low') return 'performance';
  if (tier === 'unknown' && width * height > 3840 * 2160) return 'performance';
  return 'balanced';
}

export function resolveQualityProfile(settings, gpuName = '', display = {}) {
  const requested = sanitizeGraphicsSettings(settings).quality;
  const id = requested === 'auto' ? chooseAutomaticQuality(gpuName, display) : requested;
  return Object.freeze({ ...QUALITY_PROFILES[id], requested, automatic: requested === 'auto' });
}

export function rendererParamsForSettings(settings, params = new URLSearchParams()) {
  const next = new URLSearchParams(params);
  if (!next.has('renderer')) next.set('renderer', 'auto');
  return next;
}
