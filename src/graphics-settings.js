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

export function isLowPowerGpu(gpuName = '') {
  return /SwiftShader|llvmpipe|Microsoft Basic Render/i.test(gpuName)
    || /ANGLE \(Intel,|Intel.*(?:UHD|HD Graphics|Iris|Xe|Arc)/i.test(gpuName)
    || /AMD Radeon\(TM\) Graphics/i.test(gpuName);
}

export function chooseAutomaticQuality(gpuName = '', { touch = false, width = 1920, height = 1080 } = {}) {
  // 低功耗/软件渲染才降到性能档;带触摸屏的 Windows 笔记本(5080 等高端卡也会
  // 被报告 touch)不应因此直接锁性能。
  if (isLowPowerGpu(gpuName)) return 'performance';
  // 高端 GPU 优先识别:NVIDIA 30/40/50 系、AMD RDNA2/3 直接极致,不受分辨率/触摸压制。
  if (/RTX\s*(?:30\d0|40[6789]0|50\d0)|RX\s*(?:6[89]\d0|7[89]\d0)|blackwell|lovelace|ampere/i.test(gpuName)) return 'ultra';
  // 未知/中端 GPU 在高分辨率或触摸设备上取均衡,不再盲目性能档。
  if (touch || width * height > 2560 * 1440) return 'balanced';
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
