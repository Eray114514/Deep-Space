// Per-pixel portal composite for the main view.
//
// The far side of a portal is rendered by a second instance of the production
// pipeline from the mapped camera (portal-view.js), at the same resolution and
// with the same passes. This pass decides per pixel what the eye sees where a
// view ray meets the portal, against the scene's logarithmic depth, with no
// portal mesh to be clipped by the near plane.
//
// Two shapes share it:
//   sphere - a wormhole mouth. From outside it is a lens: the departure sky
//            around it is bent by the point-lens relation (β = θ − θE²/θ),
//            which wraps the sky behind it into an Einstein ring, and the
//            destination inside is seen through the throat as a compressed,
//            wide-angle image. Crossing it is a short ride through the throat
//            (the conduit), not a flat boundary sweeping past.
//   plane  - a fold seam (doors, gates): the opening is a shaped plane.

import * as THREE from 'three';
import { Pass, FullScreenQuad } from '../../vendor/jsm/postprocessing/Pass.js';

export const PORTAL_HARMONICS = 4;
const _center = new THREE.Vector3();
const _edge = new THREE.Vector3();
const _right = new THREE.Vector3();

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
    uShape: { value: 1 },
    uCenter: { value: new THREE.Vector3() },
    uRight: { value: new THREE.Vector3(1, 0, 0) },
    uUp: { value: new THREE.Vector3(0, 1, 0) },
    uNormal: { value: new THREE.Vector3(0, 0, 1) },
    uHalf: { value: new THREE.Vector2(1, 1) },
    uRadius: { value: 1 },
    uOpen: { value: new THREE.Vector2(0, 0) },
    uCenterUv: { value: new THREE.Vector2(0.5, 0.5) },
    uScreenRadius: { value: 0.1 },
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
    uniform float uPortalReady, uCameraFar, uAspect, uTime, uLiving, uShape, uRadius, uScreenRadius;
    uniform mat4 uInvProjection, uCameraWorld;
    uniform vec3 uCenter, uRight, uUp, uNormal;
    uniform vec2 uHalf, uOpen, uCenterUv;
    uniform vec4 uHarmK, uHarmA, uHarmP, uHarmS;
    uniform float uRimWidth, uRimIntensity, uLensing, uLensWidth, uTension, uFlash;
    uniform vec3 uRimColor, uFarLight;
    varying vec2 vUv;

    float hash11(float p) { p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
    float contour(float a) {
      vec4 phase = uHarmK * a + uHarmP + uHarmS * uTime * uLiving;
      return 1.0 + dot(uHarmA, sin(phase));
    }
    vec3 sampleBase(vec2 uv) { return texture2D(tBase, clamp(uv, vec2(.001), vec2(.999))).rgb; }
    vec3 sampleFar(vec2 uv) { return texture2D(tPortal, clamp(uv, vec2(.001), vec2(.999))).rgb; }

    // ---- wormhole mouth --------------------------------------------------
    vec4 sphereMouth(vec4 base, float depth, vec3 dirView, vec3 dir, vec3 origin, float sceneDist) {
      float R = uRadius * uOpen.y;
      vec3 oc = origin - uCenter;
      float b = dot(oc, dir);
      float c = dot(oc, oc) - R * R;
      float disc = b * b - c;
      float tHit = disc > 0.0 ? -b - sqrt(disc) : -1.0;
      // occluded by opaque source geometry in front of the mouth
      float centerDist = length(oc);
      bool occluded = sceneDist < centerDist - R;

      // screen-space lens geometry around the projected centre
      vec2 d = (vUv - uCenterUv) * vec2(uAspect, 1.0);
      float r = length(d);
      vec2 dhat = r > 1e-6 ? d / r : vec2(0.0);
      float rs = max(uScreenRadius * uOpen.y, 1e-5);
      float rho = r / rs;
      vec2 toUv = vec2(1.0 / uAspect, 1.0);

      // Point-lens deflection of the departure sky around the mouth: a pixel
      // at angle θ shows the sky at β = θ − θE²/θ. Close to the rim β → 0,
      // so the sky directly behind the mouth wraps into an Einstein ring.
      float thetaE = rs * (0.82 + 0.18 * uTension) * uLensing;
      float beta = r - thetaE * thetaE / max(r, rs * 0.98);
      float outside = smoothstep(.985, 1.015, rho);
      float lensFade = 1.0 - smoothstep(2.0, 6.0, rho);
      vec2 lensUv = uCenterUv + dhat * mix(r, beta, lensFade) * toUv;
      vec3 bent = occluded ? base.rgb : sampleBase(lensUv);
      // a secondary (inverted, fainter) image just outside the rim
      float secondary = exp(-pow((rho - 1.06) / .05, 2.0)) * .5;
      bent += sampleBase(uCenterUv - dhat * max(thetaE * thetaE / max(r, rs) - r * .2, 0.0) * toUv) * secondary * (occluded ? 0.0 : 1.0);

      // Inside the throat: the destination, wide-angle and compressed toward
      // the rim, with a slow swirl and dispersion where the two spaces meet.
      float fisheye = 1.15 * (1.0 - smoothstep(.22, .55, rs));
      float swirl = .35 * pow(clamp(rho, 0.0, 1.0), 4.0) * sin(uTime * .4) * uLiving;
      float lr = rho * (1.0 + fisheye * rho * rho);
      float ca = cos(swirl), sa = sin(swirl);
      vec2 rot = vec2(dhat.x * ca - dhat.y * sa, dhat.x * sa + dhat.y * ca);
      vec2 farUv = uCenterUv + rot * lr * rs * toUv;
      float disp = .004 * pow(clamp(rho, 0.0, 1.0), 3.0);
      vec3 far = vec3(sampleFar(farUv + rot * disp).r, sampleFar(farUv).g, sampleFar(farUv - rot * disp).b);
      // before the far view is warm the throat shows the bent departure sky,
      // darkened like a lens bubble, and the destination's light
      vec3 bubble = sampleBase(uCenterUv - dhat * r * .6 * toUv) * .35 + uFarLight * .06;
      far = mix(bubble, far, uPortalReady);
      // limb: the image darkens and reddens at grazing angles of the throat
      float limb = 1.0 - .35 * pow(clamp(rho, 0.0, 1.0), 6.0);
      far *= limb;

      float inside = (!occluded && tHit > 0.0) ? 1.0 - outside : 0.0;
      vec3 col = mix(occluded ? base.rgb : bent, far, inside);
      // photon ring: thin, uneven, cool-white with a warm inner fringe
      float ringW = .012 + .02 * uTension;
      float ring = exp(-pow((rho - 1.0) / ringW, 2.0));
      float flow = .55 + .45 * sin(atan(dhat.y, dhat.x) * 7.0 - uTime * 1.3) * sin(atan(dhat.y, dhat.x) * 3.0 + uTime * .7);
      vec3 ringCol = mix(vec3(1.0, .78, .55), uRimColor, smoothstep(.97, 1.03, rho));
      col += ringCol * ring * flow * uRimIntensity * .35 * (1.0 + 3.0 * uFlash) * (occluded ? 0.0 : 1.0);
      // the throat's light leaking out around the mouth
      col += uFarLight * exp(-max(rho - 1.0, 0.0) * 6.0) * outside * .04 * uPortalReady * (occluded ? 0.0 : 1.0);
      float outDepth = depth;
      if (inside > .5) outDepth = log2(tHit * max(-dirView.z, 5e-4) + 1.0) / log2(uCameraFar + 1.0);
      return vec4(col, outDepth);
    }

    // ---- planar fold seam ------------------------------------------------
    vec4 planeSeam(vec4 base, float depth, vec3 dirView, vec3 dir, vec3 origin, float sceneDist) {
      float denom = dot(dir, uNormal);
      float t = abs(denom) > 1e-6 ? dot(uCenter - origin, uNormal) / denom : -1.0;
      bool hit = t > 0.0 && t < sceneDist;
      vec3 p = origin + dir * max(t, 0.0);
      vec2 halfOpen = max(uHalf * uOpen, vec2(1e-3));
      vec2 q = vec2(dot(p - uCenter, uRight), dot(p - uCenter, uUp)) / halfOpen;
      float rho = length(q);
      float a = atan(q.y, q.x);
      float edge = (rho - contour(a)) * min(halfOpen.x, halfOpen.y) / max(min(uHalf.x, uHalf.y), 1e-3);
      float aa = max(fwidth(edge) * 1.25, 1e-5);
      float inside = hit ? 1.0 - smoothstep(-aa, aa, edge) : 0.0;
      vec2 away = (vUv - uCenterUv) * vec2(uAspect, 1.0);
      float awayLen = length(away);
      vec2 awayUv = (awayLen > 1e-5 ? away / awayLen : vec2(0.0)) / vec2(uAspect, 1.0);
      float lens = uLensing * uOpen.y * exp(-max(edge, 0.0) / max(uLensWidth, 1e-3)) * step(0.0, edge) * (t > 0.0 ? 1.0 : 0.0);
      vec3 source = lens > 1e-5 ? sampleBase(vUv - awayUv * lens * .08) : base.rgb;
      float innerFall = exp(min(edge, 0.0) / max(uLensWidth * .6, 1e-3));
      vec2 farUv = vUv + awayUv * uLensing * innerFall * .05;
      float disp = innerFall * uLensing * .006;
      vec3 far = vec3(sampleFar(farUv + awayUv * disp).r, sampleFar(farUv).g, sampleFar(farUv - awayUv * disp).b) * uPortalReady;
      far = mix(uFarLight * .25 * (.6 + .4 * hash11(floor(a * 40.0) + floor(uTime * 24.0))), far, smoothstep(.15, .75, uOpen.y));
      vec3 col = mix(source, far, inside);
      float w = uRimWidth * (1.0 + 1.5 * uTension);
      float filament = exp(-pow(edge / max(w, 1e-5), 2.0));
      float sheath = exp(-abs(edge) / max(w * 7.0, 1e-5));
      float travel = sin(a * 5.0 - uTime * 1.7) * .5 + sin(a * 11.0 + uTime * 2.6) * .3 + sin(a * 23.0 - uTime * 4.1) * .2;
      float pulses = smoothstep(.42, .92, travel * .5 + .5);
      float flicker = .06 + .94 * pulses + hash11(floor(a * 90.0) + floor(uTime * 18.0)) * .35 * pulses;
      vec3 fringe = mix(vec3(1.0, .72, .5), vec3(.55, .78, 1.0), smoothstep(-w * 2.0, w * 2.0, edge));
      vec3 rim = (uRimColor * 1.4 + vec3(.5)) * filament * flicker + fringe * sheath * .06 * (.4 + .6 * pulses);
      col += rim * uRimIntensity * (1.0 + 2.0 * uTension + 4.0 * uFlash) * (t > 0.0 ? 1.0 : 0.0) * smoothstep(0.0, 0.05, uOpen.x);
      float outDepth = depth;
      if (inside > .5) outDepth = log2(t * max(-dirView.z, 5e-4) + 1.0) / log2(uCameraFar + 1.0);
      return vec4(col, outDepth);
    }

    void main() {
      vec4 base = texture2D(tBase, vUv);
      float depth = texture2D(tSceneDepth, vUv).x;
      gl_FragDepth = depth;
      if (uOpen.x <= 0.0005) { gl_FragColor = base; return; }
      vec4 view = uInvProjection * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
      vec3 dirView = normalize(view.xyz / max(abs(view.w), 1e-6));
      vec3 dir = normalize((uCameraWorld * vec4(dirView, 0.0)).xyz);
      vec3 origin = uCameraWorld[3].xyz;
      float sceneDist = depth < 0.999999
        ? (pow(uCameraFar + 1.0, depth) - 1.0) / max(-dirView.z, 5e-4) : 1e30;
      vec4 result = uShape > .5
        ? sphereMouth(base, depth, dirView, dir, origin, sceneDist)
        : planeSeam(base, depth, dirView, dir, origin, sceneDist);
      gl_FragDepth = result.a;
      gl_FragColor = vec4(result.rgb, base.a);
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
    // projected radius of the sphere (aspect-corrected screen units)
    const distance = Math.max(u.uCenter.value.distanceTo(this.camera.position), 1e-3);
    const radius = Math.min(u.uRadius.value * u.uOpen.value.y, distance * 0.999);
    _right.setFromMatrixColumn(this.camera.matrixWorld, 0);
    _edge.copy(u.uCenter.value).addScaledVector(_right, radius).project(this.camera);
    const angular = Math.asin(Math.min(1, radius / distance));
    const tanHalf = Math.tan(this.camera.fov * Math.PI / 360);
    u.uScreenRadius.value = 0.5 * Math.tan(angular) / tanHalf / Math.max(u.uOpen.value.y, 1e-3);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    this.material.dispose();
    this.quad.dispose();
  }
}
