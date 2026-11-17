// Full-screen General Relativistic Black Hole & Gravitational Lensing pass.
//
// Active ONLY when a BlackHole compact object is visible in the current scene
// (or wormhole destination view); completely disabled (0 GPU cost) across all
// ordinary planetary systems.
//
// Runs in linear HDR after participating media and before PortalCompositePass,
// ForegroundPass (ship hull & cockpit), TemporalAA, UnrealBloomPass and tonemap:
//   1. Bends background stars, nebulae, Milky Way band and system stars in tBase
//      along exact Schwarzschild / prograde-Kerr null geodesics (forming real
//      Einstein rings and swallowing all light inside the critical shadow curve).
//   2. Integrates primary (n=0), secondary under-lensed (n=1), and photon-ring
//      (n>=2) crossings of the differentially sheared spiral accretion disc with
//      relativistic Doppler beaming and gravitational redshift.

import * as THREE from 'three';
import { Pass, FullScreenQuad } from '../vendor/jsm/postprocessing/Pass.js';
import { BLACK_HOLE_RELATIVISTIC_GLSL } from './black-hole-webgl.js';

const _bhWorld = new THREE.Vector3();
const _camWorld = new THREE.Vector3();
const _worldToViewMat3 = new THREE.Matrix3();
const _viewMat4 = new THREE.Matrix4();

export const BlackHolePassShader = {
  uniforms: {
    tBase: { value: null },
    tSceneDepth: { value: null },
    uHasDepth: { value: 0 },
    uInvProjection: { value: new THREE.Matrix4() },
    uProjection: { value: new THREE.Matrix4() },
    uCameraWorld: { value: new THREE.Matrix4() },
    uWorldToViewRot: { value: new THREE.Matrix3() },
    uCameraFar: { value: 1e11 },
    uTime: { value: 0 },
    uBhCenter: { value: new THREE.Vector3() },
    uRs: { value: 1.5e6 },
    uOuter: { value: 3.5e7 },
    uSpin: { value: 0.78 },
    uTempK: { value: 5600 },
    uIntensity: { value: 1.0 },
    uFovRad: { value: 1.08 },
    uViewportHeight: { value: 1080 },
    uDiscRight: { value: new THREE.Vector3(1, 0, 0) },
    uDiscNormal: { value: new THREE.Vector3(0, 1, 0) },
    uDiscForward: { value: new THREE.Vector3(0, 0, 1) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    precision highp float;

    uniform sampler2D tBase;
    uniform sampler2D tSceneDepth;
    uniform float uHasDepth;
    uniform mat4 uInvProjection;
    uniform mat4 uProjection;
    uniform mat4 uCameraWorld;
    uniform mat3 uWorldToViewRot;
    uniform float uCameraFar;
    uniform float uTime;
    uniform vec3 uBhCenter;
    uniform float uRs;
    uniform float uOuter;
    uniform float uSpin;
    uniform float uTempK;
    uniform float uIntensity;
    uniform float uFovRad;
    uniform float uViewportHeight;
    uniform vec3 uDiscRight;
    uniform vec3 uDiscNormal;
    uniform vec3 uDiscForward;
    varying vec2 vUv;

    ${BLACK_HOLE_RELATIVISTIC_GLSL}

    // Procedural 3D deep-space starfield & faint galactic dust fallback for
    // strongly deflected photon-ring rays (>50 deg) that wrap outside the camera's
    // screen-space frustum, preventing clamped screen-edge streaks.
    vec3 proceduralFarSky(vec3 dir) {
      vec3 d = normalize(dir);
      float band = exp(-pow(d.y * 4.2, 2.0));
      vec3 dust = mix(vec3(0.004, 0.006, 0.010), vec3(0.026, 0.020, 0.014), band) * (0.4 + 0.6 * band);

      // Multi-cell crisp procedural stars on the unit sphere
      vec3 cell = floor(d * 260.0);
      vec3 local = fract(d * 260.0) - 0.5;
      float h = bhHash13(cell);
      float star = 0.0;
      vec3 starCol = vec3(1.0);
      if (h > 0.986) {
        vec3 jitter = vec3(
          bhHash13(cell + 7.1),
          bhHash13(cell + 13.7),
          bhHash13(cell + 29.3)
        ) - 0.5;
        float dist2 = dot(local - jitter * 0.55, local - jitter * 0.55);
        float mag = smoothstep(0.986, 0.9995, h);
        star = exp(-dist2 * 52.0) * (0.35 + 2.4 * mag * mag);
        starCol = mix(vec3(0.76, 0.86, 1.0), vec3(1.0, 0.86, 0.68), bhHash13(cell + 43.1));
      }
      return dust + starCol * star;
    }

    vec3 sampleDeflectedSky(vec3 dOut, float bhDist, float outerR, float einsteinBoost) {
      vec3 viewDir = uWorldToViewRot * dOut;
      vec3 skyFallback = proceduralFarSky(dOut);
      if (viewDir.z >= -0.04) {
        return skyFallback * einsteinBoost;
      }
      vec4 clip = uProjection * vec4(viewDir, 1.0);
      vec2 ndc = clip.xy / max(clip.w, 1e-5);
      float edge = max(abs(ndc.x), abs(ndc.y));
      float inFrustum = 1.0 - smoothstep(0.86, 0.995, edge);
      if (inFrustum <= 0.001) {
        return skyFallback * einsteinBoost;
      }
      vec2 uvOut = clamp(ndc * 0.5 + 0.5, vec2(0.001), vec2(0.999));
      if (uHasDepth > 0.5) {
        float dSample = texture2D(tSceneDepth, uvOut).x;
        if (dSample < 0.999999) {
          float sampleDist = (pow(uCameraFar + 1.0, dSample) - 1.0) / max(-viewDir.z, 5e-4);
          // Do not ghost-clone objects sitting closer than the black hole
          if (sampleDist < bhDist - outerR * 1.15) {
            return skyFallback * einsteinBoost;
          }
        }
      }
      vec3 screenSky = min(texture2D(tBase, uvOut).rgb, vec3(2.2));
      return mix(skyFallback, screenSky, inFrustum) * einsteinBoost;
    }

    void main() {
      vec4 base = texture2D(tBase, vUv);
      float depth = uHasDepth > 0.5 ? texture2D(tSceneDepth, vUv).x : 1.0;
      gl_FragDepth = depth;

      vec4 viewPos = uInvProjection * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
      vec3 dirView = normalize(viewPos.xyz / max(abs(viewPos.w), 1e-6));
      vec3 rayDir = normalize((uCameraWorld * vec4(dirView, 0.0)).xyz);
      vec3 origin = uCameraWorld[3].xyz;

      vec3 p0 = origin - uBhCenter;
      float r0Sq = dot(p0, p0);
      float r0 = sqrt(max(r0Sq, 1.0));
      float tCa = -dot(p0, rayDir);

      // Early exit when looking away from the black hole
      float rLensMax = max(uOuter * 2.15, uRs * 26.0);
      if (tCa <= 0.0 && r0 > rLensMax) {
        gl_FragColor = base;
        return;
      }

      float bSq = (tCa > 0.0) ? max(0.0, r0Sq - tCa * tCa) : r0Sq;
      if (bSq >= rLensMax * rLensMax) {
        gl_FragColor = base;
        return;
      }

      // Respect opaque foreground geometry sitting in front of the black hole system center
      float sceneDist = (uHasDepth > 0.5 && depth < 0.999999)
        ? (pow(uCameraFar + 1.0, depth) - 1.0) / max(-dirView.z, 5e-4)
        : 1e30;
      if (sceneDist < r0 - uOuter * 1.18) {
        gl_FragColor = base;
        return;
      }

      float b = sqrt(bSq);
      float rGeodesic = max(uOuter * 1.18, uRs * 14.0);
      // Finite local-system celestial-sphere ratio D_LS / D_OS (DNGR, James et al. 2015)
      // keeps the Einstein ring sculpted around the relativistic arches instead of
      // inflating a detached fishbowl far outside the accretion disc.
      const float dlsOverDos = 0.34;

      // Fast analytical Einstein deflection in the outer weak-field halo (0 geodesic steps)
      if (b >= rGeodesic && r0 > rGeodesic) {
        vec3 perp = p0 + rayDir * tCa;
        float perpLen = length(perp);
        vec3 bHat = perpLen > 1e-4 ? perp / perpLen : vec3(0.0, 1.0, 0.0);
        float uRatio = uRs / max(b, uRs);
        float deflect = (2.0 * uRatio + 2.94524 * uRatio * uRatio) * dlsOverDos;
        float outerTaper = 1.0 - smoothstep(rLensMax * 0.58, rLensMax, b);
        vec3 dOut = normalize(rayDir - bHat * (deflect * outerTaper));
        vec3 lensedSky = sampleDeflectedSky(dOut, r0, uOuter, 1.0);
        gl_FragColor = vec4(mix(base.rgb, lensedSky, outerTaper), base.a);
        return;
      }

      // Full relativistic Schwarzschild/Kerr geodesic integration inside the accretion & shadow region
      float pixelRad = max(uFovRad / max(uViewportHeight, 256.0), 1e-4);
      BhTraceResult tr = bhTraceGeodesic(
        p0, rayDir, uRs, uOuter, uSpin, uTempK, uTime, uIntensity,
        uDiscRight, uDiscNormal, uDiscForward, pixelRad
      );

      vec3 finalRgb = tr.radiance;
      float outDepth = depth;

      if (tr.captured) {
        // Pure event-horizon shadow: 100% background absorption, keeping only foreground n=0 plasma
        float hitViewZ = max(1.0, (r0 - uRs * 2.2) * max(-dirView.z, 5e-4));
        outDepth = log2(hitViewZ + 1.0) / log2(uCameraFar + 1.0);
      } else {
        float bRs = b / uRs;
        float strongNearPhoton = 1.0 - smoothstep(2.6, 5.8, bRs);
        float lensMix = mix(dlsOverDos, 0.85, strongNearPhoton);
        float outerTaper = 1.0 - smoothstep(rLensMax * 0.58, rLensMax, b);
        vec3 skyDir = normalize(mix(rayDir, tr.escapedDir, lensMix * outerTaper));
        float einsteinBoost = 1.0 + 0.22 * exp(-abs(bRs - 3.25) * 0.85);
        vec3 bgSky = sampleDeflectedSky(skyDir, r0, uOuter, einsteinBoost);
        finalRgb += tr.transmittance * bgSky;

        if (tr.transmittance < 0.5) {
          float discViewZ = max(1.0, r0 * max(-dirView.z, 5e-4));
          outDepth = min(depth, log2(discViewZ + 1.0) / log2(uCameraFar + 1.0));
        }
      }

      gl_FragDepth = outDepth;
      gl_FragColor = vec4(max(finalRgb, vec3(0.0)), base.a);
    }
  `,
};

export class BlackHolePass extends Pass {
  constructor(camera, atmospherePass = null) {
    super();
    this.camera = camera;
    this.atmospherePass = atmospherePass;
    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(BlackHolePassShader.uniforms),
      vertexShader: BlackHolePassShader.vertexShader,
      fragmentShader: BlackHolePassShader.fragmentShader,
      depthTest: false,
      depthWrite: true,
      toneMapped: false,
    });
    this.material.name = 'relativistic-black-hole';
    this.uniforms = this.material.uniforms;
    this.quad = new FullScreenQuad(this.material);
    this.enabled = false;
    this.needsSwap = true;
    this.activeBlackHole = null;
  }

  syncFromScene(scene) {
    const set = scene?.userData?.blackHoles;
    if (!set || set.size === 0) {
      this.activeBlackHole = null;
      this.enabled = false;
      return false;
    }
    let chosen = null;
    let bestDistSq = Infinity;
    this.camera.updateMatrixWorld(true);
    _camWorld.setFromMatrixPosition(this.camera.matrixWorld);
    for (const bh of set) {
      if (!bh.isVisibleInScene(scene)) continue;
      bh.group.updateMatrixWorld(true);
      _bhWorld.setFromMatrixPosition(bh.group.matrixWorld);
      const dSq = _bhWorld.distanceToSquared(_camWorld);
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        chosen = bh;
      }
    }
    this.activeBlackHole = chosen;
    this.enabled = Boolean(chosen);
    return this.enabled;
  }

  render(renderer, writeBuffer, readBuffer) {
    const bh = this.activeBlackHole;
    if (!bh) {
      this.enabled = false;
      return;
    }
    const u = this.uniforms;
    const scale = Math.max(0.001, bh.group.scale.x);
    bh.group.updateMatrixWorld(true);
    _bhWorld.setFromMatrixPosition(bh.group.matrixWorld);

    this.camera.updateMatrixWorld(true);
    _viewMat4.copy(this.camera.matrixWorldInverse);
    _worldToViewMat3.setFromMatrix4(_viewMat4);

    const depthTex = (this.atmospherePass?.sceneDepthTexture
      && this.atmospherePass.sceneDepthTexture !== writeBuffer?.depthTexture)
      ? this.atmospherePass.sceneDepthTexture
      : (readBuffer.depthTexture || null);

    u.tBase.value = readBuffer.texture;
    u.tSceneDepth.value = depthTex;
    u.uHasDepth.value = depthTex ? 1 : 0;
    u.uInvProjection.value.copy(this.camera.projectionMatrixInverse);
    u.uProjection.value.copy(this.camera.projectionMatrix);
    u.uCameraWorld.value.copy(this.camera.matrixWorld);
    u.uWorldToViewRot.value.copy(_worldToViewMat3);
    u.uCameraFar.value = this.camera.far;
    u.uTime.value = bh.timeSeconds || performance.now() * 0.001;
    u.uBhCenter.value.copy(_bhWorld);
    u.uRs.value = bh.rs * scale;
    u.uOuter.value = bh.accretionRadius * scale;
    u.uSpin.value = bh.spin;
    u.uTempK.value = bh.discTemperatureK;
    u.uIntensity.value = 1.0;
    u.uFovRad.value = THREE.MathUtils.degToRad(this.camera.fov);
    u.uViewportHeight.value = readBuffer.height || 1080;
    u.uDiscRight.value.copy(bh.basis.right);
    u.uDiscNormal.value.copy(bh.basis.normal);
    u.uDiscForward.value.copy(bh.basis.forward);

    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);

    if (!this.renderToScreen && writeBuffer?.depthTexture && this.atmospherePass) {
      this.atmospherePass.sceneDepthTexture = writeBuffer.depthTexture;
    }
  }

  dispose() {
    this.activeBlackHole = null;
    this.material.dispose();
    this.quad.dispose();
  }
}
