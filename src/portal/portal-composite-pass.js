// Per-pixel portal composite for the main view.
//
// The far side of a portal is rendered by a second instance of the production
// pipeline from the mapped camera (portal-view.js), at the same resolution and
// with the same passes, so the pixels seen through the opening are exactly the
// pixels that will fill the screen once the camera crosses. This pass decides,
// for every pixel, whether its view ray meets the opening before any opaque
// source geometry: a ray/plane test against the live contour plus a depth test
// against the scene's logarithmic depth. Because it is analytic there is no
// portal mesh to be clipped by the near plane - crossing is just the boundary
// sweeping across the screen.
//
// The seam itself is drawn as a fold in space rather than an object: source
// light bends around the boundary (a gravitational-lens style displacement of
// the source image), the far side is gently magnified toward the edge, and a
// thin incandescent filament marks where the two spaces meet.

import * as THREE from 'three';
import { Pass, FullScreenQuad } from '../../vendor/jsm/postprocessing/Pass.js';

export const PORTAL_HARMONICS = 4;
const _center = new THREE.Vector3();

export const PortalCompositeShader = {
  uniforms: {
    tBase: { value: null },
    tSceneDepth: { value: null },
    tPortal: { value: null },
    uPortalReady: { value: 0 },
    uInvProjection: { value: new THREE.Matrix4() },
    uCameraWorld: { value: new THREE.Matrix4() },
    uCameraFar: { value: 1 },
    uAspect: { value: 1 },
    uCenter: { value: new THREE.Vector3() },
    uRight: { value: new THREE.Vector3(1, 0, 0) },
    uUp: { value: new THREE.Vector3(0, 1, 0) },
    uNormal: { value: new THREE.Vector3(0, 0, 1) },
    uHalf: { value: new THREE.Vector2(1, 1) },
    uOpen: { value: new THREE.Vector2(0, 0) },
    uCenterUv: { value: new THREE.Vector2(0.5, 0.5) },
    uTime: { value: 0 },
    uHarmK: { value: new THREE.Vector4(3, 5, 7, 11) },
    uHarmA: { value: new THREE.Vector4(0.06, 0.035, 0.02, 0.012) },
    uHarmP: { value: new THREE.Vector4(0.7, 2.1, 4.0, 1.3) },
    uHarmS: { value: new THREE.Vector4(0.12, -0.2, 0.3, 0.5) },
    uLiving: { value: 1 },
    uRimWidth: { value: 0.006 },
    uRimColor: { value: new THREE.Color(0.78, 0.9, 1.0) },
    uRimIntensity: { value: 6 },
    uLensing: { value: 0.05 },
    uLensWidth: { value: 0.18 },
    uTension: { value: 0 },
    uFlash: { value: 0 },
    uFarLight: { value: new THREE.Color(1, 1, 1) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tBase, tSceneDepth, tPortal;
    uniform float uPortalReady, uCameraFar, uAspect, uTime, uLiving;
    uniform mat4 uInvProjection, uCameraWorld;
    uniform vec3 uCenter, uRight, uUp, uNormal;
    uniform vec2 uHalf, uOpen, uCenterUv;
    uniform vec4 uHarmK, uHarmA, uHarmP, uHarmS;
    uniform float uRimWidth, uRimIntensity, uLensing, uLensWidth, uTension, uFlash;
    uniform vec3 uRimColor, uFarLight;
    varying vec2 vUv;

    float hash11(float p) { p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }

    // Live contour of the opening in normalised portal coordinates.
    float contour(float a) {
      vec4 phase = uHarmK * a + uHarmP + uHarmS * uTime * uLiving;
      return 1.0 + dot(uHarmA, sin(phase));
    }

    vec2 viewRay(vec2 uv, out vec3 dirView) {
      vec4 view = uInvProjection * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
      dirView = normalize(view.xyz / max(abs(view.w), 1e-6));
      return uv;
    }

    void main() {
      vec4 base = texture2D(tBase, vUv);
      float depth = texture2D(tSceneDepth, vUv).x;
      gl_FragDepth = depth;
      if (uOpen.x <= 0.0005) { gl_FragColor = base; return; }

      vec3 dirView;
      viewRay(vUv, dirView);
      vec3 dir = normalize((uCameraWorld * vec4(dirView, 0.0)).xyz);
      vec3 origin = uCameraWorld[3].xyz;
      float sceneDist = depth < 0.999999
        ? (pow(uCameraFar + 1.0, depth) - 1.0) / max(-dirView.z, 5e-4) : 1e30;

      float denom = dot(dir, uNormal);
      float t = abs(denom) > 1e-6 ? dot(uCenter - origin, uNormal) / denom : -1.0;
      bool hit = t > 0.0 && t < sceneDist;
      vec3 p = origin + dir * max(t, 0.0);
      vec2 halfOpen = max(uHalf * uOpen, vec2(1e-3));
      vec2 q = vec2(dot(p - uCenter, uRight), dot(p - uCenter, uUp)) / halfOpen;
      float rho = length(q);
      float a = atan(q.y, q.x);
      float boundary = contour(a);
      // signed distance to the seam in units of the portal's smaller half size
      float edge = (rho - boundary) * min(halfOpen.x, halfOpen.y) / max(min(uHalf.x, uHalf.y), 1e-3);
      float aa = max(fwidth(edge) * 1.25, 1e-5);
      float inside = hit ? 1.0 - smoothstep(-aa, aa, edge) : 0.0;

      // Screen direction away from the opening's centre, for the lens offsets.
      vec2 away = (vUv - uCenterUv) * vec2(uAspect, 1.0);
      float awayLen = length(away);
      vec2 awayDir = awayLen > 1e-5 ? away / awayLen : vec2(0.0);
      vec2 awayUv = awayDir / vec2(uAspect, 1.0);

      // Source light bends around the fold: outside the seam the source image
      // is pulled toward the boundary, strongest right at it.
      float lensFall = hit || t > 0.0 ? exp(-max(edge, 0.0) / max(uLensWidth, 1e-3)) : 0.0;
      float lens = uLensing * (uOpen.y) * lensFall * step(0.0, edge);
      vec2 sourceUv = clamp(vUv - awayUv * lens * .08, vec2(.001), vec2(.999));
      vec3 source = lens > 1e-5 ? texture2D(tBase, sourceUv).rgb : base.rgb;

      // The far side is gently magnified toward the seam (Einstein-ring stretch),
      // with a faint dispersion where the two spaces meet.
      float innerFall = exp(min(edge, 0.0) / max(uLensWidth * .6, 1e-3));
      vec2 farUv = clamp(vUv + awayUv * uLensing * innerFall * .05, vec2(.001), vec2(.999));
      float disp = innerFall * uLensing * .006;
      vec3 far = vec3(
        texture2D(tPortal, farUv + awayUv * disp).r,
        texture2D(tPortal, farUv).g,
        texture2D(tPortal, farUv - awayUv * disp).b);
      far *= uPortalReady;
      // while the fold is still tearing, the far side arrives as light first
      far = mix(uFarLight * .25 * (.6 + .4 * hash11(floor(a * 40.0) + floor(uTime * 24.0))), far,
        smoothstep(.15, .75, uOpen.y));

      vec3 col = mix(source, far, inside);

      // the seam: a thin white-hot filament with a cool sheath, flickering
      // along its length; the whole seam brightens with tension and flashes
      // once as the fold tears through
      float w = uRimWidth * (1.0 + 1.5 * uTension);
      float filament = exp(-pow(edge / max(w, 1e-5), 2.0));
      float sheath = exp(-abs(edge) / max(w * 7.0, 1e-5));
      // energy travels along the seam in broken pulses; between them the
      // filament nearly vanishes and only the bent light marks the boundary
      float travel = sin(a * 5.0 - uTime * 1.7) * .5 + sin(a * 11.0 + uTime * 2.6) * .3 + sin(a * 23.0 - uTime * 4.1) * .2;
      float pulses = smoothstep(.42, .92, travel * .5 + .5);
      float crackle = hash11(floor(a * 90.0) + floor(uTime * 18.0)) * .35;
      float flicker = .06 + .94 * pulses + crackle * pulses;
      float seamVisible = (hit || t > 0.0) ? 1.0 : 0.0;
      // dispersion: the seam's cool outer fringe and warm inner fringe
      vec3 fringe = mix(vec3(1.0, .72, .5), vec3(.55, .78, 1.0), smoothstep(-w * 2.0, w * 2.0, edge));
      vec3 rim = (uRimColor * 1.4 + vec3(.5)) * filament * flicker + fringe * sheath * .06 * (.4 + .6 * pulses);
      col += rim * uRimIntensity * (1.0 + 2.0 * uTension + 4.0 * uFlash) * seamVisible
        * smoothstep(0.0, 0.05, uOpen.x);

      if (inside > .5) {
        float viewDepth = t * max(-dirView.z, 5e-4);
        gl_FragDepth = log2(viewDepth + 1.0) / log2(uCameraFar + 1.0);
      }
      gl_FragColor = vec4(col, base.a);
    }
  `,
};

export class PortalCompositePass extends Pass {
  constructor(camera) {
    super();
    this.camera = camera;
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(PortalCompositeShader.uniforms),
      vertexShader: PortalCompositeShader.vertexShader,
      fragmentShader: PortalCompositeShader.fragmentShader,
      depthTest: false,
      depthWrite: true,
      toneMapped: false,
    });
    this.material.name = 'portal-composite';
    this.uniforms = this.material.uniforms;
    this.quad = new FullScreenQuad(this.material);
    this.enabled = false;
    this.needsSwap = true;
  }

  render(renderer, writeBuffer, readBuffer) {
    const u = this.uniforms;
    u.tBase.value = readBuffer.texture;
    u.tSceneDepth.value = readBuffer.depthTexture || null;
    u.uCameraFar.value = this.camera.far;
    u.uAspect.value = this.camera.aspect;
    this.camera.updateMatrixWorld(true);
    u.uInvProjection.value.copy(this.camera.projectionMatrixInverse);
    u.uCameraWorld.value.copy(this.camera.matrixWorld);
    _center.copy(u.uCenter.value).project(this.camera);
    u.uCenterUv.value.set(_center.x * 0.5 + 0.5, _center.y * 0.5 + 0.5);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    this.material.dispose();
    this.quad.dispose();
  }
}
