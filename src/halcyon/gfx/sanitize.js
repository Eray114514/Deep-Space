// Bloom hardening — ported 1:1 from 3aaa-spaceship-flight-prototype/src/game/gfx/sanitize.ts
// (types stripped only; logic, constants and comments unchanged).

/* ------------------------------------------------------------------ *
 *  BLOOM HARDENING  —  what stopped the whole screen going black.
 *
 *  THE BUG (measured, not guessed: tools/blackframe.mjs reported 43% of
 *  frames fully black in chase view, 0% with bloom disabled, 0% with the
 *  engine FX hidden; tools/nanlocate.mjs then found the pixels and read
 *  their raw half-float bits as 0xFE00 = -Infinity in R and G).
 *
 *  UnrealBloomPass reads the HDR buffer, downsamples it through five mip
 *  levels and tents it back up.  A blur is a weighted sum, and any sum
 *  containing +/-Inf or NaN is +/-Inf or NaN, so ONE bad pixel anywhere in
 *  the scene reaches every pixel of the bloom, which is then composited
 *  over the frame.  One bad pixel therefore blacks out the entire frame.
 *
 *  The source has been fixed (see plumeMaterial() in ship/exterior.js),
 *  but every additive surface that can straddle the near plane is one typo
 *  away from re-introducing it, and this cockpit rebuild is about to add
 *  several.  So rather than trust the shaders, remove the amplifier: make
 *  the bloom incapable of turning a local defect into a global one.
 *
 *  This costs nothing — the high-pass shader already runs on every pixel;
 *  it now does four compares and a clamp more.  A standalone full-screen
 *  sanitize pass was measured 25% slower under the software rasteriser and
 *  buys only the cosmetic difference of a stray dark pixel, so it is not
 *  worth a pass of its own.
 *
 *  NaN needs the self-comparison (it is the only value not equal to
 *  itself) because min/max are undefined for it in GLSL; clamp handles
 *  +/-Inf exactly.  Written per channel: GLSL ES 1.00 has no mix()
 *  overload taking a bvec.
 * ------------------------------------------------------------------ */
export function hardenBloom(bloom, maxRadiance = 64) {
  const m = bloom.materialHighPassFilter;
  m.uniforms.uMax = { value: maxRadiance };
  m.fragmentShader = /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec3 defaultColor;
    uniform float defaultOpacity;
    uniform float luminosityThreshold;
    uniform float smoothWidth;
    uniform float uMax;
    varying vec2 vUv;
    void main() {
      vec4 texel = texture2D( tDiffuse, vUv );
      if (!(texel.r == texel.r)) texel.r = 0.0;
      if (!(texel.g == texel.g)) texel.g = 0.0;
      if (!(texel.b == texel.b)) texel.b = 0.0;
      if (!(texel.a == texel.a)) texel.a = 1.0;
      texel = vec4( clamp( texel.rgb, 0.0, uMax ), clamp( texel.a, 0.0, 1.0 ) );
      float v = dot( texel.xyz, vec3( 0.2126, 0.7152, 0.0722 ) );
      vec4 outputColor = vec4( defaultColor.rgb, defaultOpacity );
      float alpha = smoothstep( luminosityThreshold, luminosityThreshold + smoothWidth, v );
      gl_FragColor = mix( outputColor, texel, alpha );
    }`;
  m.needsUpdate = true;
}
