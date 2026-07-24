import assert from 'node:assert/strict';
import { classifyGpuTier, chooseAutomaticQuality, isLowPowerGpu } from '../src/graphics-settings.js';

// 真实 WEBGL_debug_renderer_info 暴露的 UNMASKED_RENDERER 字符串样本。
const SAMPLES = {
  // 高端 → ultra
  'ANGLE (NVIDIA, NVIDIA GeForce RTX 5080 Laptop GPU (0x00002C59) Direct3D11 vs_5_0 ps_5_0, D3D11)': 'high',
  'ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 Direct3D11 vs_5_0 ps_5_0, D3D11)': 'high',
  'ANGLE (NVIDIA, NVIDIA GeForce RTX 5070 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)': 'high',
  'ANGLE (NVIDIA, NVIDIA GeForce RTX 5060 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)': 'mid',
  'ANGLE (NVIDIA, NVIDIA GeForce RTX 5050 Direct3D11 vs_5_0 ps_5_0, D3D11)': 'mid',
  'ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)': 'high',
  'ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11 vs_5_0 ps_5_0, D3D11)': 'high',
  'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)': 'high',
  'ANGLE (NVIDIA, NVIDIA GeForce RTX 3090 Direct3D11 vs_5_0 ps_5_0, D3D11)': 'high',
  'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)': 'high',
  'ANGLE (NVIDIA, NVIDIA GeForce RTX 2080 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)': 'high',
  'ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)': 'high',
  'ANGLE (AMD, AMD Radeon RX 7900 XTX Direct3D11 vs_5_0 ps_5_0, D3D11)': 'high',
  'ANGLE (AMD, AMD Radeon RX 6900 XT Direct3D11 vs_5_0 ps_5_0, D3D11)': 'high',
  'ANGLE (AMD, AMD Radeon RX 9070 XT Direct3D11 vs_5_0 ps_5_0, D3D11)': 'high',
  'Apple M3 Max': 'high',
  'Apple M2 Pro': 'high',

  // 中端 → balanced
  'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)': 'mid',
  'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)': 'mid',
  'ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)': 'mid',
  'ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)': 'mid',
  'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)': 'mid',
  'ANGLE (NVIDIA, NVIDIA GeForce RTX 2070 Direct3D11 vs_5_0 ps_5_0, D3D11)': 'mid',
  'ANGLE (NVIDIA, NVIDIA GeForce RTX 2060 Direct3D11 vs_5_0 ps_5_0, D3D11)': 'mid',
  'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)': 'mid',
  'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 Direct3D11 vs_5_0 ps_5_0, D3D11)': 'mid',
  'ANGLE (AMD, AMD Radeon RX 7800 XT Direct3D11 vs_5_0 ps_5_0, D3D11)': 'mid',
  'ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)': 'mid',
  'ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)': 'mid',
  'ANGLE (AMD, AMD Radeon RX 5700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)': 'mid',
  'ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)': 'mid',
  'ANGLE (Intel, Intel(R) Arc(TM) B580 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)': 'mid',
  'Apple M1': 'mid',
  'Apple M2': 'mid',

  // 低端 → performance
  'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)': 'low',
  'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)': 'low',
  'ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)': 'low',
  'ANGLE (NVIDIA, NVIDIA GeForce MX450 Direct3D11 vs_5_0 ps_5_0, D3D11)': 'low',
  'ANGLE (NVIDIA, NVIDIA GeForce GTX 1050 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)': 'low',
  'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)': 'low',
  'ANGLE (AMD, AMD Radeon RX 6500 XT Direct3D11 vs_5_0 ps_5_0, D3D11)': 'low',
  'Google SwiftShader': 'low',
  'Microsoft Basic Render Driver': 'low',

  // 未知 → unknown
  'ANGLE (UnknownVendor, Mystery GPU 9000 Direct3D11 vs_5_0 ps_5_0, D3D11)': 'unknown',
};

let failures = 0;
for (const [sample, expected] of Object.entries(SAMPLES)) {
  const actual = classifyGpuTier(sample);
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${expected.padEnd(7)} ← ${sample.slice(0, 80)}`);
  if (!ok) {
    console.log(`        got ${actual}`);
    failures++;
  }
}

// 画质档映射:high→ultra, mid→balanced, low→performance。
assert.equal(chooseAutomaticQuality('NVIDIA GeForce RTX 5080 Laptop GPU'), 'ultra');
assert.equal(chooseAutomaticQuality('NVIDIA GeForce RTX 4060'), 'balanced');
assert.equal(chooseAutomaticQuality('Intel Iris Xe Graphics'), 'performance');
assert.equal(chooseAutomaticQuality(''), 'balanced');

// isLowPowerGpu 与 classifyGpuTier 保持一致。
assert.equal(isLowPowerGpu('Intel Iris Xe Graphics'), true);
assert.equal(isLowPowerGpu('NVIDIA GeForce RTX 5080 Laptop GPU'), false);
assert.equal(isLowPowerGpu(''), false);

// 5080 Laptop 必须识别为 high(用户实际设备,曾误判为性能档)。
assert.equal(classifyGpuTier('NVIDIA GeForce RTX 5080 Laptop GPU (0x00002C59)'), 'high');

if (failures > 0) {
  console.error(`${failures} GPU tier classification failures`);
  process.exit(1);
}
console.log('PASS: GPU tier classification matches expected performance bands');
