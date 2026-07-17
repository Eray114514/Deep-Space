// Half-resolution atmosphere/cloud pass with camera reprojection.
//
// Atmospheric scattering and clouds are both expensive participating-media
// effects. Rendering them into a smaller HDR target, reprojecting the previous
// frame and then edge-aware upsampling follows the same broad architecture used
// by modern large-scale planet renderers. Geometry and the ship remain in the
// full-resolution scene; volume meshes live on VOLUME_LAYER only.

import * as THREE from 'three';
import { Pass, FullScreenQuad } from '../vendor/jsm/postprocessing/Pass.js';

export const VOLUME_LAYER = 2;

const _clear = new THREE.Color();
const _savedClear = new THREE.Color();

function target(w, h, name) {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
  rt.texture.name = name;
  rt.texture.generateMipmaps = false;
  return rt;
}

export class VolumetricPass extends Pass {
  constructor(scene, camera, { scale = 0.5 } = {}) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.scale = scale;
    this.width = 1;
    this.height = 1;
    this.current = target(1, 1, 'volume.current');
    this.historyA = target(1, 1, 'volume.historyA');
    this.historyB = target(1, 1, 'volume.historyB');
    this.historyRead = this.historyA;
    this.historyWrite = this.historyB;
    this.historyValid = false;
    this.enabled = true;
    this.needsSwap = true;

    this.nav = new THREE.Vector3();
    this.prevNav = new THREE.Vector3();
    this.center = new THREE.Vector3();
    this.radius = 1;
    this.motion = 1;
    this.frame = 0;
    this.activePlanet = null;
    this.prevViewProjection = new THREE.Matrix4();

    this.resolveMaterial = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      uniforms: {
        tCurrent: { value: this.current.texture },
        tHistory: { value: this.historyRead.texture },
        uHistoryValid: { value: 0 },
        uMotion: { value: 1 },
        uCenter: { value: this.center },
        uRadius: { value: this.radius },
        uNavDelta: { value: new THREE.Vector3() },
        uInvProjection: { value: new THREE.Matrix4() },
        uCameraWorld: { value: new THREE.Matrix4() },
        uPrevViewProjection: { value: this.prevViewProjection },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D tCurrent, tHistory;
        uniform float uHistoryValid, uMotion, uRadius;
        uniform vec3 uCenter, uNavDelta;
        uniform mat4 uInvProjection, uCameraWorld, uPrevViewProjection;
        varying vec2 vUv;

        vec2 sphereHits(vec3 origin, float r, vec3 dir) {
          vec3 oc = origin - uCenter;
          float b = dot(oc, dir);
          float d = b * b - dot(oc, oc) + r * r;
          if (d < 0.0) return vec2(-1.0);
          float s = sqrt(d);
          return vec2(-b - s, -b + s);
        }

        void main() {
          vec4 cur = texture2D(tCurrent, vUv);
          vec4 clip = vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
          vec4 view = uInvProjection * clip;
          vec3 dirView = normalize(view.xyz / max(abs(view.w), 1e-5));
          vec3 dirWorld = normalize((uCameraWorld * vec4(dirView, 0.0)).xyz);
          vec2 hit = sphereHits(vec3(0.0), uRadius, dirWorld);

          vec2 prevUv = vec2(-2.0);
          if (hit.y > 0.0) {
            // Outside: the near shell is a good stable reprojection surface.
            // Inside: bias into the volume instead of using the far boundary.
            float nearT = max(hit.x, 0.0);
            float t = hit.x > 0.0 ? nearT : mix(nearT, hit.y, 0.42);
            vec3 prevRelative = dirWorld * t + uNavDelta;
            vec4 prevClip = uPrevViewProjection * vec4(prevRelative, 1.0);
            if (prevClip.w > 0.0) prevUv = prevClip.xy / prevClip.w * 0.5 + 0.5;
          }

          float inside = step(0.0, prevUv.x) * step(prevUv.x, 1.0)
            * step(0.0, prevUv.y) * step(prevUv.y, 1.0);
          vec4 hist = texture2D(tHistory, clamp(prevUv, 0.0, 1.0));
          float uvMotion = length(prevUv - vUv);
          float alphaReject = smoothstep(0.34, 0.04, abs(hist.a - cur.a));
          float stable = exp(-uvMotion * 48.0) * alphaReject;
          float historyWeight = uHistoryValid * inside * stable
            * mix(0.86, 0.18, clamp(uMotion, 0.0, 1.0));
          // Current samples always dominate newly revealed edges.
          historyWeight *= smoothstep(0.0, 0.12, cur.a + hist.a);
          gl_FragColor = mix(cur, hist, historyWeight);
        }`,
    });
    this.resolveQuad = new FullScreenQuad(this.resolveMaterial);

    this.compositeMaterial = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      uniforms: {
        tBase: { value: null },
        tVolume: { value: this.historyWrite.texture },
        uTexel: { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }`,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D tBase, tVolume;
        uniform vec2 uTexel;
        varying vec2 vUv;

        vec4 volumeSample(vec2 uv) {
          vec4 c = texture2D(tVolume, uv);
          vec4 a = texture2D(tVolume, uv + vec2(uTexel.x, 0.0));
          vec4 b = texture2D(tVolume, uv - vec2(uTexel.x, 0.0));
          vec4 d = texture2D(tVolume, uv + vec2(0.0, uTexel.y));
          vec4 e = texture2D(tVolume, uv - vec2(0.0, uTexel.y));
          // Alpha similarity preserves cloud silhouettes while filtering the
          // sparse raymarch signal in smooth interiors.
          float wa = exp(-abs(a.a - c.a) * 18.0);
          float wb = exp(-abs(b.a - c.a) * 18.0);
          float wd = exp(-abs(d.a - c.a) * 18.0);
          float we = exp(-abs(e.a - c.a) * 18.0);
          return (c * 3.0 + a * wa + b * wb + d * wd + e * we)
            / (3.0 + wa + wb + wd + we);
        }

        void main() {
          vec4 base = texture2D(tBase, vUv);
          vec4 volume = volumeSample(vUv);
          gl_FragColor = vec4(volume.rgb + base.rgb * (1.0 - volume.a), base.a);
        }`,
    });
    this.compositeQuad = new FullScreenQuad(this.compositeMaterial);
  }

  setActivePlanet(planet, nav, motion = 0) {
    if (!planet || !planet.atmoMesh) {
      this.activePlanet = null;
      this.historyValid = false;
      this.radius = 1;
      this.center.set(0, 0, -1e12);
      return;
    }
    if (this.activePlanet !== planet) {
      this.activePlanet = planet;
      this.historyValid = false;
      this.prevNav.copy(nav);
    } else if (this.historyValid && this.prevNav.distanceTo(nav) > this.radius * 0.18) {
      // Teleports/warps have no valid correspondence in the old history.
      this.historyValid = false;
    }
    this.nav.copy(nav);
    this.center.copy(planet.posUniv).sub(nav);
    this.radius = planet.R + planet.atmoHeight;
    this.motion = THREE.MathUtils.clamp(motion, 0, 1);
  }

  resetHistory() {
    this.historyValid = false;
  }

  setSize(width, height) {
    this.width = Math.max(1, Math.round(width * this.scale));
    this.height = Math.max(1, Math.round(height * this.scale));
    this.current.setSize(this.width, this.height);
    this.historyA.setSize(this.width, this.height);
    this.historyB.setSize(this.width, this.height);
    this.compositeMaterial.uniforms.uTexel.value.set(1 / this.width, 1 / this.height);
    this.historyValid = false;
  }

  render(renderer, writeBuffer, readBuffer) {
    const oldTarget = renderer.getRenderTarget();
    const oldMask = this.camera.layers.mask;
    const oldAutoClear = renderer.autoClear;
    const oldAlpha = renderer.getClearAlpha();
    renderer.getClearColor(_savedClear);

    // Render only atmospheric/cloud volume meshes into a half-resolution HDR
    // buffer. Clear alpha is important: discarded rays must stay transparent.
    this.camera.layers.set(VOLUME_LAYER);
    renderer.autoClear = true;
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this.current);
    renderer.clear(true, false, false);
    renderer.render(this.scene, this.camera);

    this.camera.layers.mask = oldMask;
    renderer.autoClear = oldAutoClear;
    renderer.setClearColor(_savedClear, oldAlpha);

    this.camera.updateMatrixWorld(true);
    const u = this.resolveMaterial.uniforms;
    u.tCurrent.value = this.current.texture;
    u.tHistory.value = this.historyRead.texture;
    u.uHistoryValid.value = this.historyValid ? 1 : 0;
    u.uMotion.value = this.motion;
    u.uCenter.value.copy(this.center);
    u.uRadius.value = this.radius;
    u.uNavDelta.value.copy(this.nav).sub(this.prevNav);
    u.uInvProjection.value.copy(this.camera.projectionMatrixInverse);
    u.uCameraWorld.value.copy(this.camera.matrixWorld);
    u.uPrevViewProjection.value.copy(this.prevViewProjection);
    renderer.setRenderTarget(this.historyWrite);
    this.resolveQuad.render(renderer);

    this.compositeMaterial.uniforms.tBase.value = readBuffer.texture;
    this.compositeMaterial.uniforms.tVolume.value = this.historyWrite.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.compositeQuad.render(renderer);

    this.prevNav.copy(this.nav);
    this.prevViewProjection.multiplyMatrices(
      this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.historyValid = true;
    const swap = this.historyRead;
    this.historyRead = this.historyWrite;
    this.historyWrite = swap;
    this.frame++;
    renderer.setRenderTarget(oldTarget);
  }

  dispose() {
    this.current.dispose();
    this.historyA.dispose();
    this.historyB.dispose();
    this.resolveMaterial.dispose();
    this.compositeMaterial.dispose();
    this.resolveQuad.dispose();
    this.compositeQuad.dispose();
  }
}
