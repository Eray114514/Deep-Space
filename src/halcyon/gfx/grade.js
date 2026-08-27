// Grade pass — ported 1:1 from 3aaa-spaceship-flight-prototype/src/game/gfx/grade.ts
// (types stripped only; logic, constants and comments unchanged).
// Adaptation: ShaderPass imported from this project's vendored jsm copy.
import { ShaderPass } from '../../../vendor/jsm/postprocessing/ShaderPass.js';

/* ------------------------------------------------------------------ *
 *  GRADE PASS  —  lens and film character, ported from
 *  high-fidelity-spaceship-cockpit/src/game/Game.ts
 *
 *  This is the cheapest large step toward "looks photographed rather
 *  than rendered", and it is a single full-screen pass:
 *
 *    chromatic aberration   scaled by r^2, so the centre stays sharp and
 *                           only the corners fringe, the way a real lens
 *                           behaves.  Sampled per channel with the green
 *                           channel left alone.
 *    vignette               a soft corner falloff; without it a rendered
 *                           frame reads as uniformly, unnaturally lit.
 *    grain                  a per-frame hash.  Its real job is to break
 *                           up the banding that a dark nebula gradient
 *                           shows after tonemapping, which is why it is
 *                           applied after the tonemap in OutputPass.
 *
 *  Runs LAST, after OutputPass, because all three are display-referred
 *  effects: they belong to the camera, not to the scene's radiance.
 * ------------------------------------------------------------------ */
export function gradePass() {
  return new ShaderPass({
    name: 'GradeShader',
    uniforms: {
      tDiffuse: { value: null },
      uTime: { value: 0 },
      uAberration: { value: 0.0016 },
      uVignette: { value: 0.62 },
      uGrain: { value: 0.025 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform float uTime;
      uniform float uAberration;
      uniform float uVignette;
      uniform float uGrain;
      varying vec2 vUv;

      float hash(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }

      void main(){
        vec2 c = vUv - 0.5;
        float r2 = dot(c, c);

        /* radial CA: displacement grows with r^2 so the centre is clean */
        vec2 d = c * r2 * uAberration * 4.0;
        vec3 col = vec3(
          texture2D(tDiffuse, clamp(vUv + d, 0.0, 1.0)).r,
          texture2D(tDiffuse, vUv).g,
          texture2D(tDiffuse, clamp(vUv - d, 0.0, 1.0)).b
        );

        float vig = smoothstep(1.05, 0.28, r2 * 2.2);
        col *= mix(1.0, vig, uVignette);

        /* mod() keeps the hash argument bounded no matter how long the
           session runs — an unbounded sin() argument is how the engine
           plume shader used to go non-finite. */
        col += (hash(vUv * 1024.0 + mod(uTime, 64.0)) - 0.5) * uGrain;

        gl_FragColor = vec4(max(col, 0.0), 1.0);
      }`,
  });
}
