// Graphics quality profiles and persistence. The renderer backend is WebGL 2
// and not a player choice. Only quality tier (auto/performance/balanced/ultra)
// is exposed in the UI.

export const GRAPHICS_SETTINGS_KEY = 'deep-space.graphics.v1';
export const GRAPHICS_SETTINGS_VERSION = 1;

// DPR 倍率以 window.devicePixelRatio 为基准:1.0 = 点对点渲染,>1.0 = 超采样。
// 任何常规档位 floor 都不低于 1.0(点对点),避免升采样糊与纹理锯齿——
// 省性能靠阴影/体积/网格密度,而非降低分辨率。仅低功耗 GPU 的性能档
// 允许降采样保帧(resolveQualityProfile 会下调 floor)。
export const QUALITY_PROFILES = Object.freeze({
  performance: Object.freeze({
    id: 'performance', label: '性能',
    dprFloorMult: 1.0, dprTargetMult: 1.0, dprCeilingMult: 1.0,
    shadowMap: 1024, shadowDistance: 180,
    volumeScale: 0.46, gridCells: 18,
  }),
  balanced: Object.freeze({
    id: 'balanced', label: '均衡',
    dprFloorMult: 1.0, dprTargetMult: 1.15, dprCeilingMult: 1.3,
    shadowMap: 2048, shadowDistance: 300,
    volumeScale: 0.67, gridCells: 24,
  }),
  ultra: Object.freeze({
    id: 'ultra', label: '极致',
    dprFloorMult: 1.0, dprTargetMult: 1.2, dprCeilingMult: 1.3,
    shadowMap: 4096, shadowDistance: 650,
    volumeScale: 0.67, gridCells: 24,
  }),
});

const QUALITY_VALUES = new Set(['auto', 'performance', 'balanced', 'ultra']);

export function sanitizeGraphicsSettings(value = {}) {
  return {
    version: GRAPHICS_SETTINGS_VERSION,
    quality: QUALITY_VALUES.has(value.quality) ? value.quality : 'auto',
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

// Legacy URL params: ?quality=low → performance, ?quality=high → ultra.
function urlQuality(params) {
  const value = params?.get?.('quality');
  if (value === 'low') return 'performance';
  if (value === 'high') return 'ultra';
  return QUALITY_VALUES.has(value) ? value : null;
}

export function resolveGraphicsSettings({ params = new URLSearchParams(), storage = globalThis.localStorage } = {}) {
  const saved = readGraphicsSettings(storage);
  const qualityOverride = urlQuality(params);
  return {
    ...sanitizeGraphicsSettings({ quality: qualityOverride || saved.quality }),
    source: qualityOverride ? 'url' : saved.quality !== 'auto' ? 'saved' : 'auto',
  };
}

// GPU 性能档位识别。输入来自 WEBGL_debug_renderer_info 的
// UNMASKED_RENDERER_WEBGL 字符串(经 renderer-runtime.js 透传),形如:
//   "ANGLE (NVIDIA, NVIDIA GeForce RTX 5080 Laptop GPU (0x00002C59) D3D11)"
//   "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0)"
//   "ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0)"
// 返回 high/mid/low/unknown;chooseAutomaticQuality 把它映射到画质档。
export function classifyGpuTier(gpuName = '') {
  if (!gpuName) return 'unknown';

  // 软件渲染 / 软光栅 — 永远 low。
  if (/SwiftShader|llvmpipe|Microsoft Basic Render|Google SwiftShader/i.test(gpuName)) return 'low';

  // -- NVIDIA -------------------------------------------------------------
  if (/NVIDIA|GeForce/i.test(gpuName)) {
    // MX 系列笔记本独显按集显处理。
    if (/GeForce\s*(?:MX\d{3}|940M|930M|920M)/i.test(gpuName)) return 'low';
    // GTX 10/16 系低端(1050/1050 Ti/1630/1650)
    if (/GeForce\s*(?:GTX\s*)?(?:10[45]0|16[35]0)/i.test(gpuName)) return 'low';
    // GTX 10/16 系中端(1060/1070/1660 等)
    if (/GeForce\s*(?:GTX\s*)?(?:1060|1070|1660)/i.test(gpuName)) return 'mid';
    // GTX 1080 仍按 high(实际性能足够)
    if (/GeForce\s*(?:GTX\s*)?1080/i.test(gpuName)) return 'high';

    // RTX 20 系:2080(含 Ti)高端;2070/2060 中端
    if (/RTX\s*20\d0/i.test(gpuName)) {
      if (/RTX\s*20[89]0/i.test(gpuName)) return 'high';
      return 'mid';
    }
    // RTX 30 系:3090/3080 桌面高端;其余(含所有 Laptop)中端
    if (/RTX\s*30\d0/i.test(gpuName)) {
      if (/RTX\s*30(?:90|80)/i.test(gpuName) && !/Laptop/i.test(gpuName)) return 'high';
      return 'mid';
    }
    // RTX 40 系:4090/4080/4070 Ti 高端;4070/4060/4050 中端
    if (/RTX\s*40\d0/i.test(gpuName)) {
      if (/RTX\s*40(?:90|80)/i.test(gpuName)) return 'high';
      if (/RTX\s*4070\s*Ti/i.test(gpuName)) return 'high';
      return 'mid';
    }
    // RTX 50 系:5070/5080/5090(含 Laptop)胜任极致档;
    // 5050/5060(含 Laptop)约等于 4060,归中端跑均衡。
    if (/RTX\s*50[789]0/i.test(gpuName)) return 'high';
    if (/RTX\s*50[56]0/i.test(gpuName)) return 'mid';

    // 未识别的 NVIDIA 默认按中端处理。
    return 'mid';
  }

  // -- AMD ----------------------------------------------------------------
  if (/AMD|Radeon/i.test(gpuName)) {
    // 集显(Vega Mobile / Radeon TM Graphics 等)
    if (/Radeon\s*\(TM\)\s*Graphics|Vega\s*\d+|Vega Mobile/i.test(gpuName)) return 'low';
    // RX 9000 系(9070/9070 XT 等)全部 high
    if (/RX\s*9\d{3}/i.test(gpuName)) return 'high';
    // RX 7000 系
    if (/RX\s*7\d{3}/i.test(gpuName)) {
      if (/RX\s*79\d0/i.test(gpuName)) return 'high';  // 7900 XTX/XT/GRE
      return 'mid';                                     // 7800/7700/7600
    }
    // RX 6000 系
    if (/RX\s*6\d{3}/i.test(gpuName)) {
      if (/RX\s*6[45]\d0/i.test(gpuName)) return 'low';               // 6400/6500
      if (/RX\s*6(?:[89]\d0|95\d)/i.test(gpuName)) return 'high';     // 6800/6900/6950
      return 'mid';                                                   // 6700/6600
    }
    // RX 5000 系:5700 中端,其余低端
    if (/RX\s*5\d{3}/i.test(gpuName)) {
      if (/RX\s*57\d0/i.test(gpuName)) return 'mid';
      return 'low';
    }
    // RX 500/400 老卡 → low
    if (/Radeon\s*(?:RX\s*)?[45]\d{2,3}/i.test(gpuName)) return 'low';
    return 'mid';
  }

  // -- Intel --------------------------------------------------------------
  if (/Intel/i.test(gpuName)) {
    // Arc 独显:兼容 "Arc(TM) A770" / "Arc A770" / "Arc B580" 等写法。
    // A770/A750/A580/B580/B570 归 mid(Battlemage 与 Alchemist 高型号);
    // A380 等入门型号归 low。
    if (/Arc[^\d]*[AB]\d{3,4}/i.test(gpuName)) {
      if (/Arc[^\d]*[AB][5-8]\d{2,3}/i.test(gpuName)) return 'mid';
      return 'low';
    }
    // 集显(Iris Xe / UHD / HD Graphics)一律 low
    return 'low';
  }

  // -- Apple Silicon ------------------------------------------------------
  if (/Apple\s*M/i.test(gpuName)) {
    if (/Apple\s*M[1-4]\s*(?:Pro|Max|Ultra)/i.test(gpuName)) return 'high';
    return 'mid';
  }

  return 'unknown';
}

export function isLowPowerGpu(gpuName = '') {
  return classifyGpuTier(gpuName) === 'low';
}

export function chooseAutomaticQuality(gpuName = '', { touch = false, width = 1920, height = 1080 } = {}) {
  const tier = classifyGpuTier(gpuName);
  if (tier === 'high') return 'ultra';
  if (tier === 'low') return 'performance';
  // mid 或 unknown 默认均衡;触摸屏 + 高分辨率不强制降档(中端独显仍能跑均衡)。
  if (tier === 'unknown' && width * height > 3840 * 2160) return 'performance';
  return 'balanced';
}

export function resolveQualityProfile(settings, gpuName = '', display = {}) {
  const requested = sanitizeGraphicsSettings(settings).quality;
  const id = requested === 'auto' ? chooseAutomaticQuality(gpuName, display) : requested;
  const base = QUALITY_PROFILES[id];
  // 低功耗 GPU 自动进入性能档时才允许降采样保帧;其余情况 floor 锁在点对点,
  // 杜绝升采样糊。5080 即便手动选性能档也保持点对点,只是关闭超采样与重阴影。
  const allowUndersample = id === 'performance' && isLowPowerGpu(gpuName);
  return Object.freeze({
    ...base,
    dprFloorMult: allowUndersample ? 0.7 : base.dprFloorMult,
    requested, automatic: requested === 'auto',
  });
}
