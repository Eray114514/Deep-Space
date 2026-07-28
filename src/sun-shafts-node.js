// Lightweight WebGPU screen-space aerial shafts.
//
// This is intentionally a bounded post process, not a fake full-screen bloom:
// it gathers only HDR radiance along the line toward the projected dominant
// star, and the runtime enables it only inside humid air near the horizon.

import * as THREE from 'three';
import {
  dot, float, Fn, length, mix, screenUV, smoothstep, uniform, vec2, vec3, vec4,
} from 'three/tsl';

export function createSunShaftNode(inputTexture, sceneDepthTexture, reversedDepth = false) {
  const uniforms = {
    uSunUv: uniform(new THREE.Vector2(0.5, 0.5)),
    uStrength: uniform(0),
    uTint: uniform(new THREE.Color(1, 0.72, 0.42)),
    uDepthReversed: uniform(reversedDepth ? 1 : 0),
  };
  const outputNode = Fn(() => {
    const base = inputTexture.sample(screenUV);
    const ray = uniforms.uSunUv.sub(screenUV);
    const rayLength = length(ray).max(0.0001);
    const perpendicular = vec2(ray.y.negate(), ray.x).div(rayLength);
    const gathered = vec3(0).toVar();
    // Eight fixed taps keep the pass predictable on integrated GPUs. Offset
    // alternating taps across the radial line and reject the stellar disc:
    // sampling the HDR disc itself at every point on the sun-to-camera axis
    // created a solid "light sabre" instead of broken atmospheric shafts.
    for (let index = 1; index <= 8; index++) {
      const fraction = index / 8;
      const side = index % 2 === 0 ? 1 : -1;
      const spread = (0.004 + fraction * 0.016) * side;
      const sampleUv = screenUV.add(ray.mul(fraction * 0.72))
        .add(perpendicular.mul(spread)).clamp(0.001, 0.999);
      const sampleColor = inputTexture.sample(sampleUv).rgb;
      const luminance = dot(sampleColor, vec3(0.2126, 0.7152, 0.0722));
      const rawDepth = sceneDepthTexture.sample(sampleUv).r;
      const sceneDepth = mix(rawDepth, float(1).sub(rawDepth), uniforms.uDepthReversed);
      // Only sky/participating-media pixels may emit shaft energy. Bright
      // snow, sand and water are opaque receivers, not atmospheric sources.
      const skyVisibility = smoothstep(0.9995, 0.99998, sceneDepth);
      const outsideDisc = smoothstep(0.14, 0.28,
        length(uniforms.uSunUv.sub(sampleUv)));
      const source = smoothstep(0.68, 1.7, luminance)
        .mul(outsideDisc).mul(skyVisibility);
      gathered.addAssign(sampleColor.min(vec3(1.8)).mul(source)
        .mul((9 - index) / 44));
    }
    const radialMask = smoothstep(1.12, 0.07, rayLength)
      .mul(smoothstep(0.025, 0.1, rayLength));
    const shaft = gathered.mul(uniforms.uTint)
      .mul(uniforms.uStrength).mul(radialMask);
    return vec4(base.rgb.add(shaft), base.a.max(float(shaft.length().mul(0.08))));
  })();
  return { outputNode, uniforms };
}
