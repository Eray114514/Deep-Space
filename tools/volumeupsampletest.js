// Static contract for the WebGPU participating-media upsample.
//
// A reduced-resolution atmosphere/cloud pass must not be hardware-bilinearly
// stretched over opaque terrain. The production graph reconstructs four
// low-resolution texels and weights them with full-resolution scene depth.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/node-render-pipeline.js', import.meta.url), 'utf8');

assert.match(source, /function depthGuidedVolumeUpsample\s*\(/,
  'pipeline must own a dedicated depth-guided volume reconstruction');
assert.match(source, /logarithmicDepthToViewZ\s*\(/,
  'bilateral weights must use the production logarithmic depth contract');
assert.match(source, /centerHasDepth\.select\([\s\S]*tapHasDepth\.select\(/,
  'opaque and background samples must be separate ownership classes');
assert.match(source, /volumeTexture\.sample\(uv\)\.mul\(weight\)/,
  'volume color taps must consume the depth-guided weights');
assert.match(source, /tap00[\s\S]*tap10[\s\S]*tap01[\s\S]*tap11/,
  'upsample must reconstruct all four bilinear source texels');
assert.match(source, /weightSum\.max\(0\.00001\)/,
  'an unmatched opaque sub-pixel must resolve conservatively without NaN');
assert.match(source, /mix\(\s*volumeTexture\.sample\(screenUV\),\s*guidedVolume,\s*this\._volumeUpsample/s,
  'full-resolution volume must retain an exact direct-sample reference path');
assert.match(source, /getDrawingBufferSize\(this\._volumeResolution\.value\)[\s\S]*multiplyScalar\(this\.volumeScale\)/,
  'source texel centres must track drawing-buffer size and adaptive volume scale');
assert.match(source, /setVolumeScale\(scale\)[\s\S]*this\._volumeUpsample\.value\s*=/,
  'adaptive resolution changes must update reconstruction ownership');

console.log('PASS: WebGPU volume uses logarithmic-depth-guided bilateral upsampling');
