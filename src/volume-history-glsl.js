// Cloud correction is signed, unexposed HDR; alpha is 1 - gray transmittance.
// Filter color/depth from identical history taps before reconstructing color.
// This bounds local reuse; it does not supply cloud/object motion or depth.
export const volumeHistoryGLSL = /* glsl */`
  float volumeHistoryDepthSupport(float currentDepth, float previousDepth, float uvMotion) {
    bool currentSky = currentDepth >= 0.999999;
    bool previousSky = previousDepth >= 0.999999;
    if (currentSky != previousSky) return 0.0;
    if (currentSky) return 1.0;
    // No world-surface motion yet: only reuse a nearly stationary matching
    // opaque ray. Log-depth proximity alone does not prove the same surface.
    return (1.0 - smoothstep(0.000001, 0.00001, abs(currentDepth - previousDepth)))
      * exp(-uvMotion * 1000.0) * (1.0 - step(0.001, uMotion));
  }

  vec4 volumeHistorySample(vec2 uv, float currentDepth, float uvMotion, out float support) {
    ivec2 size = textureSize(tHistory, 0);
    if (uStationaryHistory > 0.5) {
      // Exact CPU pose/projection identity, not an epsilon for small motion.
      // Avoid introducing bilinear rounding/drift into a stationary half-float
      // history. gl_FragCoord addresses the original history texel exactly.
      ivec2 tap = clamp(ivec2(gl_FragCoord.xy), ivec2(0), size - 1);
      support = volumeHistoryDepthSupport(currentDepth, texelFetch(tHistoryDepth, tap, 0).r, 0.0);
      return texelFetch(tHistory, tap, 0);
    }
    vec2 pixel = uv * vec2(size) - 0.5;
    ivec2 first = ivec2(floor(pixel));
    vec2 f = fract(pixel);
    vec4 sum = vec4(0.0);
    support = 0.0;
    for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) {
      ivec2 tap = clamp(first + ivec2(x, y), ivec2(0), size - 1);
      float depth = texelFetch(tHistoryDepth, tap, 0).r;
      float weight = (x == 0 ? 1.0 - f.x : f.x) * (y == 0 ? 1.0 - f.y : f.y);
      weight *= volumeHistoryDepthSupport(currentDepth, depth, uvMotion);
      // Rejection must exclude the color fetch/accumulation itself; multiplying
      // a rejected nonfinite HDR value by zero is not a portable rejection.
      if (weight <= 0.0) continue;
      sum += texelFetch(tHistory, tap, 0) * weight;
      support += weight;
    }
    return sum / max(support, 1e-8);
  }

  bool volumeCurrentDepthSupport(float currentDepth, float neighborDepth) {
    bool currentSky = currentDepth >= 0.999999;
    bool neighborSky = neighborDepth >= 0.999999;
    if (currentSky != neighborSky) return false;
    if (currentSky) return true;
    float distance = pow(uCameraFar + 1.0, currentDepth) - 1.0;
    float neighborDistance = pow(uCameraFar + 1.0, neighborDepth) - 1.0;
    return abs(distance - neighborDistance) <= max(2.0, distance * 0.005);
  }

  vec4 volumeHistoryClip(vec4 history, vec4 current, float currentDepth) {
    ivec2 size = textureSize(tCurrent, 0);
    ivec2 pixel = clamp(ivec2(gl_FragCoord.xy), ivec2(0), size - 1);
    vec4 lower = current, upper = current;
    for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
      if (x == 0 && y == 0) continue;
      ivec2 tap = clamp(pixel + ivec2(x, y), ivec2(0), size - 1);
      // The current color grid is low-resolution; opaque depth is borrowed
      // full-resolution. Sample depth at THIS color texel's center.
      vec2 uv = (vec2(tap) + 0.5) / vec2(size);
      float depth = texture2D(tSceneDepth, uv).r;
      if (!volumeCurrentDepthSupport(currentDepth, depth)) continue;
      vec4 value = texelFetch(tCurrent, tap, 0);
      lower = min(lower, value);upper = max(upper, value);
    }
    // Never clamp signed correction to zero, to alpha, or to display RGB.
    return clamp(history, lower, upper);
  }
`;
