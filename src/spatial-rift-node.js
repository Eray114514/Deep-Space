// Reusable spatial passage based on the standalone rift prototype. The
// defaults intentionally preserve that prototype's silhouette, layered rim,
// tunnel thickness, projected destination and two-stage opening motion.

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from '../vendor/three.webgpu.js';
import {
  Fn, If, attribute, cameraPosition, cameraProjectionMatrix, cameraViewMatrix,
  cos, exp, float, fract, fwidth, length, max, mix, modelWorldMatrix,
  mx_atan2, normalize, positionLocal, pow, screenUV, sin, smoothstep as tslSmoothstep,
  texture, uniform, vec2, vec3, vec4,
} from '../vendor/three.tsl.js';
import { clamp, lerp, smoothstep } from './noise.js';

const TAU = Math.PI * 2;
const _center = new THREE.Vector3();
const _edgeX = new THREE.Vector3();
const _edgeY = new THREE.Vector3();
const _localPrev = new THREE.Vector3();
const _localCurr = new THREE.Vector3();

function edgeMotion(angle, time) {
  return 0.030 * Math.sin(angle * 4 - time * 0.72 + 0.8)
    + 0.018 * Math.sin(angle * 9 + time * 1.18 - 1.6)
    + 0.010 * Math.sin(angle * 23 - time * 2.05)
    + 0.006 * Math.sin(angle * 47 + time * 3.4);
}

function riftBoundary(angle, openNode, timeNode) {
  return float(1)
    .add(sin(angle.mul(3).add(0.72)).mul(0.100))
    .add(sin(angle.mul(5).sub(1.18)).mul(0.052))
    .add(sin(angle.mul(11).add(2.16)).mul(0.030))
    .add(sin(angle.mul(17).sub(0.45)).mul(0.020))
    .add(pow(max(float(0), sin(angle.mul(7).add(1.7))), 8).mul(0.030))
    .add(openNode.mul(
      sin(angle.mul(4).sub(timeNode.mul(0.72)).add(0.8)).mul(0.030)
        .add(sin(angle.mul(9).add(timeNode.mul(1.18)).sub(1.6)).mul(0.018))
        .add(sin(angle.mul(23).sub(timeNode.mul(2.05))).mul(0.010))
        .add(sin(angle.mul(47).add(timeNode.mul(3.4))).mul(0.006)),
    ));
}

/**
 * Node-post equivalent of the former full-screen ShaderPass. The returned
 * uniform nodes intentionally expose `.value`, so SpatialRift.updateDistortion
 * can drive this controller without knowing which renderer backend is active.
 */
export function createRiftDistortionNode(inputNode) {
  const uniforms = {
    uCenter: uniform(new THREE.Vector2(0.5, 0.5)),
    uRadius: uniform(new THREE.Vector2(0.15, 0.15)),
    uOpen: uniform(0),
    uTime: uniform(0),
    uStrength: uniform(1),
    uTension: uniform(0),
    uBurst: uniform(0),
  };
  const node = Fn(() => {
    const sampleUv = screenUV;
    const base = inputNode.sample(sampleUv);
    const result = vec4(base.rgb, 1).toVar();
    const activity = max(uniforms.uOpen, max(uniforms.uTension, uniforms.uBurst));
    // Legacy ShaderPass skipped the whole rift pass while closed.  Keep the
    // WebGPU render graph resident, but put all trigonometry and the three
    // additional scene samples behind a real uniform branch during ordinary
    // flight.
    If(activity.greaterThan(0.001), () => {
      const safeR = max(uniforms.uRadius, vec2(0.0001));
      const q = sampleUv.sub(uniforms.uCenter).div(safeR);
      const angle = mx_atan2(q.y, q.x);
      const distance = length(q);
      const boundary = riftBoundary(angle, uniforms.uOpen, uniforms.uTime);
      const band = exp(pow(distance.sub(boundary).div(0.082), 2).negate());
      const outer = exp(pow(distance.sub(boundary).div(0.21), 2).negate());
      const tear = exp(pow(distance.sub(boundary).div(0.030), 2).negate());
      const direction = normalize(q.add(vec2(0.00001)));
      const tangent = vec2(direction.y.negate(), direction.x);
      const pulse = sin(uniforms.uTime.mul(2.1).add(angle.mul(9))).mul(0.28).add(0.72);
      const strainPulse = sin(uniforms.uTime.mul(10.5).add(angle.mul(17))).mul(0.18).add(0.82);
      const fold = uniforms.uOpen.add(uniforms.uTension.mul(0.72)).add(uniforms.uBurst.mul(0.32));
      const pull = direction.negate().mul(safeR).mul(band.mul(0.050).add(outer.mul(0.012)))
        .mul(fold).mul(uniforms.uStrength).mul(pulse).toVar();
      pull.addAssign(direction.negate().mul(safeR).mul(outer.mul(0.024).add(band.mul(0.018)))
        .mul(uniforms.uTension).mul(strainPulse));
      pull.addAssign(tangent.mul(safeR).mul(band).mul(0.010)
        .mul(sin(angle.mul(13).sub(uniforms.uTime.mul(1.7)))).mul(fold));
      pull.addAssign(tangent.mul(safeR).mul(outer).mul(0.014)
        .mul(sin(angle.mul(23).add(uniforms.uTime.mul(6)))).mul(uniforms.uTension));
      pull.addAssign(tangent.mul(safeR).mul(0.018).mul(tear)
        .mul(sin(angle.mul(41).sub(uniforms.uTime.mul(4.2)))).mul(uniforms.uOpen));
      const warpedUv = sampleUv.add(pull);
      const split = float(0.0007).add(band.mul(0.0032)).add(tear.mul(0.0065))
        .mul(fold).mul(uniforms.uStrength).add(uniforms.uBurst.mul(band).mul(0.0065));
      const red = inputNode.sample(warpedUv.add(direction.mul(split))).r;
      const green = inputNode.sample(warpedUv).g;
      const blue = inputNode.sample(warpedUv.sub(direction.mul(split))).b;
      const distorted = vec3(red, green, blue).toVar();
      distorted.addAssign(vec3(0.02, 0.05, 0.09).mul(band).mul(uniforms.uOpen));
      distorted.addAssign(vec3(0.12, 0.34, 0.92).mul(tear).mul(uniforms.uOpen)
        .mul(sin(angle.mul(29).sub(uniforms.uTime.mul(3.1))).mul(0.32).add(0.48)));
      distorted.addAssign(vec3(0.08, 0.20, 0.48).mul(band).mul(uniforms.uTension).mul(0.55));
      distorted.addAssign(vec3(0.55, 0.30, 0.82).mul(band).mul(uniforms.uBurst).mul(0.28));
      result.assign(vec4(distorted, 1));
    });
    return result;
  })();
  return { node, uniforms };
}

export const DEFAULT_RIFT_PROFILE = Object.freeze({
  width: 820,
  height: 630,
  depth: 245,
  edgeThickness: 1,
  ribbonSegments: 520,
  tunnelSegments: 300,
  tunnelRings: 28,
  renderScale: 1,
  rimLayers: Object.freeze([
    { scale: 1.000, band: 34, z: 8, alpha: 0.66, phase: 0, brightness: 1.02 },
    { scale: 1.025, band: 58, z: 1, alpha: 0.34, phase: 1.7, brightness: 0.88 },
    { scale: 0.982, band: 22, z: 14, alpha: 0.48, phase: 3.2, brightness: 1.08 },
    { scale: 1.068, band: 82, z: -9, alpha: 0.16, phase: 5.0, brightness: 0.80 },
    { scale: 1.120, band: 110, z: -16, alpha: 0.07, phase: 7.1, brightness: 0.68 },
  ]),
});

export function createRiftProfile(options = {}) {
  return {
    ...DEFAULT_RIFT_PROFILE,
    ...options,
    rimLayers: (options.rimLayers || DEFAULT_RIFT_PROFILE.rimLayers).map((layer) => ({ ...layer })),
    contour: options.contour || ((angle) => 1
      + 0.100 * Math.sin(angle * 3 + 0.72)
      + 0.052 * Math.sin(angle * 5 - 1.18)
      + 0.030 * Math.sin(angle * 11 + 2.16)
      + 0.020 * Math.sin(angle * 17 - 0.45)
      + 0.030 * Math.pow(Math.max(0, Math.sin(angle * 7 + 1.7)), 8)),
  };
}

export class SpatialRift {
  constructor({ scene, renderer, mainCamera, profile = {}, portalScale = 0.72 }) {
    this.scene = scene;
    this.renderer = renderer;
    this.mainCamera = mainCamera;
    this.profile = createRiftProfile(profile);
    this.width = this.profile.width;
    this.height = this.profile.height;
    this.depth = this.profile.depth;
    this.portalScale = portalScale;
    this.group = new THREE.Group();
    this.group.name = 'spatial-rift';
    this.group.visible = false;
    scene.add(this.group);
    // World placement and passage orientation stay on the parent. The rift's
    // own opening squash, overshoot and roll live on this child so animation
    // can never corrupt the ship-facing quaternion supplied by the runtime.
    this.visual = new THREE.Group();
    this.visual.name = 'spatial-rift-visual';
    this.group.add(this.visual);

    this.open = 0;
    this.targetOpen = 0;
    this.time = 0;
    this.traversed = false;
    this.handoffActive = false;
    this.handoffFade = 0;
    this.handoffElapsed = 0;
    this.stability = 0;
    this.animating = false;
    this.animFrom = 0;
    this.animTo = 0;
    this.animElapsed = 0;
    this.animDuration = 0;
    this.animDirection = 0;
    this.openTimeline = 0;
    this.tension = 0;
    this.burst = 0;

    this.portalCamera = mainCamera.clone();
    this.portalCamera.matrixAutoUpdate = true;
    this.portalRT = new THREE.RenderTarget(1280, 768, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
    });
    // The offscreen destination render is stored in the renderer output color
    // space. Tag it so sampling decodes back to linear before the main node
    // pipeline applies its single final tone/output transform.
    this.portalRT.texture.colorSpace = THREE.SRGBColorSpace;
    this.portalRT.texture.generateMipmaps = false;
    this.textureMatrix = new THREE.Matrix4();
    this.offsetMatrix = new THREE.Matrix4();
    this.sourceFrameMatrix = new THREE.Matrix4();
    this.targetFrameMatrix = new THREE.Matrix4();
    this.inverseSourceMatrix = new THREE.Matrix4();
    this.sourceQuaternion = new THREE.Quaternion();
    this.targetQuaternion = new THREE.Quaternion();
    this.frameRotation = new THREE.Quaternion();
    this.unitScale = new THREE.Vector3(1, 1, 1);
    this.biasMatrix = new THREE.Matrix4().set(
      0.5, 0, 0, 0.5,
      0, 0.5, 0, 0.5,
      0, 0, 0.5, 0.5,
      0, 0, 0, 1,
    );
    this.targetAnchor = new THREE.Vector3();
    this._makeStructure();
  }

  contour(angle) { return this.profile.contour(angle); }

  _curvePoints(z = 0, scale = 1) {
    const points = [];
    for (let i = 0; i < 220; i++) {
      const angle = i / 220 * TAU;
      const radius = this.contour(angle) * scale;
      points.push(new THREE.Vector3(
        Math.cos(angle) * this.width * 0.5 * radius,
        Math.sin(angle) * this.height * 0.5 * radius,
        z + Math.sin(angle * 9 + 1.6) * 7 + Math.sin(angle * 23) * 2.5,
      ));
    }
    return points;
  }

  _makeRibbonGeometry(scale = 1, band = 42, z = 0, phase = 0) {
    const segments = this.profile.ribbonSegments;
    const positions = [], across = [], angles = [], randoms = [], indices = [];
    for (let i = 0; i <= segments; i++) {
      const angle = i / segments * TAU;
      const base = this.contour(angle) * scale;
      const wave = Math.sin(angle * 13 + phase) * 0.15 + Math.sin(angle * 31 - phase) * 0.08;
      const outer = base + (band * this.profile.edgeThickness / Math.min(this.width, this.height)) * (1 + wave);
      const zNoise = Math.sin(angle * 9 + phase) * 8 + Math.sin(angle * 27 - phase) * 2;
      for (let side = 0; side < 2; side++) {
        const radius = side ? outer : base;
        positions.push(
          Math.cos(angle) * this.width * 0.5 * radius,
          Math.sin(angle) * this.height * 0.5 * radius,
          z + zNoise + side * 2,
        );
        across.push(side);
        angles.push(angle);
        randoms.push(Math.sin(angle * 71.13 + phase * 17.2) * 0.5 + 0.5);
      }
      if (i < segments) {
        const n = i * 2;
        indices.push(n, n + 1, n + 2, n + 1, n + 3, n + 2);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('aAcross', new THREE.Float32BufferAttribute(across, 1));
    geometry.setAttribute('aAngle', new THREE.Float32BufferAttribute(angles, 1));
    geometry.setAttribute('aRand', new THREE.Float32BufferAttribute(randoms, 1));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }

  _makeTunnelGeometry() {
    const segments = this.profile.tunnelSegments;
    const rings = this.profile.tunnelRings;
    const positions = [], angles = [], depths = [], indices = [];
    for (let j = 0; j <= rings; j++) {
      const t = j / rings;
      const neck = 1 - 0.045 * Math.sin(t * Math.PI) - 0.018 * t;
      for (let i = 0; i <= segments; i++) {
        const angle = i / segments * TAU;
        const twist = 0.035 * Math.sin(t * Math.PI) * Math.sin(angle * 2);
        const a = angle + twist;
        const radius = this.contour(angle) * neck * (1 + 0.012 * Math.sin(t * 11 + angle * 5));
        positions.push(Math.cos(a) * this.width * 0.5 * radius, Math.sin(a) * this.height * 0.5 * radius, -this.depth * t);
        angles.push(angle);
        depths.push(t);
      }
    }
    for (let j = 0; j < rings; j++) {
      for (let i = 0; i < segments; i++) {
        const a = j * (segments + 1) + i;
        const b = a + segments + 1;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('aAngle', new THREE.Float32BufferAttribute(angles, 1));
    geometry.setAttribute('aDepth', new THREE.Float32BufferAttribute(depths, 1));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }

  _makeLivingFilament(scale, opacity, phase) {
    const count = 321;
    const positions = new Float32Array(count * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({
      color: phase % 2 ? 0x8dcfff : 0xe6f5ff,
      transparent: true,
      opacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const line = new THREE.Line(geometry, material);
    line.userData.filament = { scale, phase, count };
    line.renderOrder = 7;
    return line;
  }

  _updateLivingFilaments(time, open) {
    for (const line of this.livingFilaments) {
      const { scale, phase, count } = line.userData.filament;
      const positions = line.geometry.attributes.position.array;
      for (let i = 0; i < count; i++) {
        const angle = (i % (count - 1)) / (count - 1) * TAU;
        const motion = edgeMotion(angle + phase * 0.015, time * (1 + phase * 0.04)) * open;
        const electric = Math.sin(angle * (13 + phase * 2) - time * (2.1 + phase * 0.17)) * 0.006 * open;
        const radius = (this.contour(angle) + motion + electric) * scale;
        const index = i * 3;
        positions[index] = Math.cos(angle) * this.width * 0.5 * radius;
        positions[index + 1] = Math.sin(angle) * this.height * 0.5 * radius;
        positions[index + 2] = 15 + phase * 1.5 + Math.sin(angle * 19 + time * 2.8 + phase) * 4 * open;
      }
      line.geometry.attributes.position.needsUpdate = true;
      line.material.opacity = (0.22 + phase * 0.08) * smoothstep(0.02, 0.20, open);
    }
  }

  _rimShader(alpha = 1, phase = 0, brightness = 1) {
    const uniforms = {
      uTime: uniform(0), uOpen: uniform(0), uTension: uniform(0), uBurst: uniform(0),
      uAlpha: uniform(alpha), uPhase: uniform(phase), uBrightness: uniform(brightness),
    };
    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    material.uniforms = uniforms;
    const across = attribute('aAcross');
    const angle = attribute('aAngle');
    const random = attribute('aRand');
    material.positionNode = Fn(() => {
      const p = positionLocal.toVar();
      const alive = tslSmoothstep(0.02, 0.30, uniforms.uOpen);
      const strain = sin(angle.mul(37).sub(uniforms.uTime.mul(8.5)).add(uniforms.uPhase)).mul(uniforms.uTension);
      const arcTip = pow(max(0, sin(angle.mul(17).sub(uniforms.uTime.mul(2.7)).add(uniforms.uPhase))), 28)
        .add(pow(max(0, sin(angle.mul(31).add(uniforms.uTime.mul(1.9)).sub(uniforms.uPhase))), 42));
      p.z.addAssign(sin(angle.mul(19).add(uniforms.uTime.mul(2.5)).add(uniforms.uPhase)).mul(3.5).mul(alive)
        .add(strain.mul(8)));
      const living = riftBoundary(angle, alive, uniforms.uTime).sub(riftBoundary(angle, float(0), uniforms.uTime));
      const ripple = sin(angle.mul(7).sub(uniforms.uTime.mul(1.35)).add(uniforms.uPhase)).mul(0.010)
        .add(sin(angle.mul(19).add(uniforms.uTime.mul(2.4)).sub(uniforms.uPhase)).mul(0.004));
      const radial = float(1).add(living.add(ripple).mul(alive)).add(strain.mul(0.0035))
        .add(across.mul(arcTip).mul(float(0.014).add(uniforms.uTension.mul(0.016))).mul(alive));
      p.xy.mulAssign(radial.mul(uniforms.uBurst.mul(0.018).add(1)));
      p.z.addAssign(across.mul(arcTip).mul(uniforms.uTension.mul(5).add(4)));
      return p;
    })();
    const spectrum = (hue) => pow(max(cos(vec3(hue).add(vec3(0, 0.31, 0.63)).mul(TAU)).mul(0.42).add(0.58), 0), vec3(0.72));
    const core = pow(max(0, sin(across.mul(Math.PI))), 0.38);
    const f1 = pow(max(0, sin(angle.mul(13).sub(uniforms.uTime.mul(2.15)).add(uniforms.uPhase).add(random.mul(2)))), 12);
    const f2 = pow(max(0, sin(angle.mul(29).add(uniforms.uTime.mul(1.45)).sub(uniforms.uPhase))), 22);
    const flow = f1.mul(0.72).add(f2.mul(0.45)).mul(0.66).add(0.34);
    const hue = fract(angle.div(TAU).add(uniforms.uTime.mul(0.018)).add(random.mul(0.11)).add(uniforms.uPhase.mul(0.03)));
    const charge = pow(max(0, sin(angle.mul(41).sub(uniforms.uTime.mul(9)).add(uniforms.uPhase))), 18);
    const tear = exp(across.mul(-22)).mul(max(f1, charge).mul(0.66).add(0.34));
    const stablePulse = sin(uniforms.uTime.mul(3.2).add(angle.mul(3)).add(uniforms.uPhase)).mul(0.18).add(0.92);
    material.colorNode = mix(vec3(0.10, 0.52, 1.35), spectrum(hue), 0.67)
      .add(vec3(1.35, 0.42, 0.08).mul(f1).mul(0.72))
      .add(vec3(1.45, 1.18, 0.96).mul(pow(core, 4)).mul(f1.mul(0.6).add(0.35)))
      .add(vec3(0.72, 1.05, 1.65).mul(charge.mul(0.95).add(0.16)).mul(uniforms.uTension))
      .add(vec3(1.75, 1.25, 1.85).mul(core.mul(0.25).oneMinus()).mul(uniforms.uBurst).mul(0.82))
      .add(vec3(3.8, 4.6, 7.2).mul(tear)).mul(uniforms.uBrightness).mul(stablePulse);
    material.opacityNode = core.mul(0.92).add(0.08).mul(flow.mul(0.72).add(0.28)).mul(uniforms.uAlpha)
      .mul(tslSmoothstep(0.02, 0.20, uniforms.uOpen))
      .add(tear.mul(uniforms.uAlpha).mul(0.82).mul(tslSmoothstep(0.03, 0.18, uniforms.uOpen)))
      .mul(uniforms.uTension.mul(0.95).add(uniforms.uBurst.mul(0.75)).add(1))
      .mul(stablePulse.mul(0.22).add(0.80));
    return material;
  }

  _makeStructure() {
    const curve = new THREE.CatmullRomCurve3(this._curvePoints(0, 1.016), true, 'catmullrom', 0.12);
    const massUniforms = {
      uTime: uniform(0), uOpen: uniform(0), uTension: uniform(0), uBurst: uniform(0),
      uHalfSize: uniform(new THREE.Vector2(this.width * 0.5, this.height * 0.5)),
    };
    this.massMat = new MeshBasicNodeMaterial({
      side: THREE.DoubleSide,
      depthWrite: true,
    });
    this.massMat.uniforms = massUniforms;
    const massAngle = mx_atan2(positionLocal.y.div(massUniforms.uHalfSize.y), positionLocal.x.div(massUniforms.uHalfSize.x));
    this.massMat.positionNode = Fn(() => {
      const p = positionLocal.toVar();
      const alive = tslSmoothstep(0.03, 0.28, massUniforms.uOpen);
      const living = riftBoundary(massAngle, alive, massUniforms.uTime).sub(riftBoundary(massAngle, float(0), massUniforms.uTime));
      p.xy.mulAssign(living.mul(alive).add(1).mul(massUniforms.uBurst.mul(0.018).add(1)));
      p.z.addAssign(sin(massAngle.mul(19).add(massUniforms.uTime.mul(2.5)))
        .mul(massUniforms.uTension.mul(6).add(2.4)));
      return p;
    })();
    const charge = sin(massAngle.mul(11).sub(massUniforms.uTime.mul(1.4))).mul(0.5).add(0.5);
    this.massMat.colorNode = vec3(0.0004, 0.0012, 0.0035)
      .add(vec3(0.004, 0.016, 0.045).mul(charge.mul(0.75).add(0.25))
        .mul(massUniforms.uTension.mul(0.8).add(0.35)))
      .add(vec3(0.16, 0.09, 0.24).mul(massUniforms.uBurst))
      .mul(tslSmoothstep(0.015, 0.12, massUniforms.uOpen));
    this.mass = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 520, 34 * this.profile.edgeThickness, 10, true),
      this.massMat,
    );
    this.mass.renderOrder = 3;
    this.visual.add(this.mass);

    const tunnelUniforms = { uTime: uniform(0), uOpen: uniform(0), uTension: uniform(0), uBurst: uniform(0) };
    this.tunnelMat = new MeshBasicNodeMaterial({
      side: THREE.BackSide,
      transparent: false,
      depthWrite: true,
      toneMapped: false,
    });
    this.tunnelMat.uniforms = tunnelUniforms;
    const tunnelAngle = attribute('aAngle');
    const tunnelDepth = attribute('aDepth');
    this.tunnelMat.positionNode = Fn(() => {
      const p = positionLocal.toVar();
      const living = riftBoundary(tunnelAngle, tunnelUniforms.uOpen, tunnelUniforms.uTime)
        .sub(riftBoundary(tunnelAngle, float(0), tunnelUniforms.uTime));
      const scaleNode = float(1).add(living.mul(tunnelUniforms.uOpen).mul(tunnelDepth.mul(0.48).oneMinus()))
        .mul(sin(tunnelAngle.mul(8).add(tunnelDepth.mul(18)).sub(tunnelUniforms.uTime.mul(1.15)))
          .mul(0.010).mul(tunnelUniforms.uOpen).add(1))
        .mul(sin(tunnelAngle.mul(29).sub(tunnelDepth.mul(12)).sub(tunnelUniforms.uTime.mul(7)))
          .mul(0.006).mul(tunnelUniforms.uTension).add(1))
        .mul(tunnelUniforms.uBurst.mul(0.016).mul(tunnelDepth.oneMinus()).add(1));
      p.xy.mulAssign(scaleNode);
      return p;
    })();
    const spectral = (hue) => cos(vec3(hue).add(vec3(0, 0.33, 0.67)).mul(TAU)).mul(0.42).add(0.58);
    const l1 = pow(max(0, sin(tunnelAngle.mul(17).sub(tunnelDepth.mul(29)).sub(tunnelUniforms.uTime.mul(2.1)))), 18);
    const l2 = pow(max(0, sin(tunnelAngle.mul(31).add(tunnelDepth.mul(41)).add(tunnelUniforms.uTime.mul(1.3)))), 28);
    const ribs = pow(max(0, sin(tunnelDepth.mul(25).sub(tunnelAngle.mul(3)))), 20);
    const tunnelHue = fract(tunnelAngle.div(TAU).add(tunnelDepth.mul(0.3)).add(tunnelUniforms.uTime.mul(0.015)));
    this.tunnelMat.colorNode = mix(vec3(0.002, 0.006, 0.014), vec3(0.015, 0.035, 0.075), sin(tunnelAngle.mul(5)).mul(0.5).add(0.5))
      .add(spectral(tunnelHue).mul(l1.mul(0.82).add(l2.mul(0.48))))
      .add(vec3(0.10, 0.42, 1.15).mul(ribs).mul(0.30))
      .add(spectral(fract(tunnelAngle.div(TAU).add(tunnelUniforms.uTime.mul(0.08))))
        .mul(tunnelUniforms.uTension).mul(l1.mul(0.55).add(0.08)))
      .add(vec3(0.95, 0.62, 1.35).mul(tunnelUniforms.uBurst).mul(tunnelDepth.oneMinus().mul(0.80).add(0.20)))
      .mul(tslSmoothstep(0.045, 0.20, tunnelUniforms.uOpen).add(tunnelUniforms.uTension.mul(0.10)));
    this.tunnel = new THREE.Mesh(this._makeTunnelGeometry(), this.tunnelMat);
    this.tunnel.renderOrder = 2;
    this.visual.add(this.tunnel);

    this.rimMaterials = [];
    for (const layer of this.profile.rimLayers) {
      const material = this._rimShader(layer.alpha, layer.phase, layer.brightness);
      const mesh = new THREE.Mesh(this._makeRibbonGeometry(layer.scale, layer.band, layer.z, layer.phase), material);
      mesh.renderOrder = 5;
      this.rimMaterials.push(material);
      this.visual.add(mesh);
    }
    const exitMaterial = this._rimShader(0.30, 2.4, 0.76);
    const exitRim = new THREE.Mesh(this._makeRibbonGeometry(0.96, 30, -this.depth + 3, 2.4), exitMaterial);
    exitRim.renderOrder = 4;
    this.rimMaterials.push(exitMaterial);
    this.visual.add(exitRim);

    // A small CPU-updated geometric filament remains razor sharp on both
    // WebGPU and the WebGL2 backend, while the wider membrane stays in TSL.
    // It also makes the stable passage visibly alive without a full-screen
    // temporal effect or a backend-specific line shader.
    this.livingFilaments = [
      this._makeLivingFilament(0.988, 0.22, 0),
      this._makeLivingFilament(1.000, 0.30, 1),
      this._makeLivingFilament(1.013, 0.24, 2),
      this._makeLivingFilament(1.028, 0.16, 3),
    ];
    for (const filament of this.livingFilaments) this.visual.add(filament);

    const portalUniforms = {
      uTextureMatrix: uniform(this.textureMatrix),
      uOpen: uniform(0), uTension: uniform(0), uBurst: uniform(0), uTime: uniform(0),
      uHalfSize: uniform(new THREE.Vector2(this.width * 0.5, this.height * 0.5)),
    };
    this.portalMat = new MeshBasicNodeMaterial({
      // The destination is a real opaque window. Treating this plane as a
      // blended surface let nearby source-system planets bleed through it and
      // visually sit on top of the tunnel wall. The irregular silhouette is
      // still cut out in the fragment shader; only the luminous rim blends.
      transparent: false,
      depthWrite: true,
      depthTest: true,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.portalMat.uniforms = portalUniforms;
    this.portalMat.alphaTest = 0.45;
    const portalTexture = texture(this.portalRT.texture);
    const portalOutput = Fn(() => {
      const p = positionLocal.xy.div(portalUniforms.uHalfSize);
      const angle = mx_atan2(p.y, p.x);
      const radius = length(p);
      const boundary = riftBoundary(angle, portalUniforms.uOpen, portalUniforms.uTime).mul(0.965);
      const aa = max(fwidth(radius).mul(1.6), 0.002);
      const mask = tslSmoothstep(boundary.sub(aa), boundary.add(aa), radius).oneMinus();
      const projected = portalUniforms.uTextureMatrix.mul(modelWorldMatrix.mul(vec4(positionLocal, 1)));
      const baseUv = projected.xy.div(max(projected.w, 0.00001));
      const edge = tslSmoothstep(boundary.sub(0.25), boundary, radius);
      const wave = sin(angle.mul(19).sub(portalUniforms.uTime.mul(1.8)))
        .add(sin(angle.mul(7).add(portalUniforms.uTime.mul(1.15))));
      const direction = normalize(p.add(vec2(0.00001)));
      const tangent = vec2(direction.y.negate(), direction.x);
      // The opened membrane never becomes a frozen screenshot: a restrained
      // whole-window shear plus stronger boundary displacement keeps the live
      // destination spatially connected to the moving tear.
      const membraneShear = edge.mul(0.0045).add(0.0012);
      const warpedUv = baseUv.add(tangent.mul(wave).mul(membraneShear).mul(portalUniforms.uOpen));
      const split = edge.mul(0.0045).add(0.00055).mul(portalUniforms.uOpen);
      const red = portalTexture.sample(warpedUv.add(direction.mul(split))).r;
      const green = portalTexture.sample(warpedUv).g;
      const blue = portalTexture.sample(warpedUv.sub(direction.mul(split))).b;
      const portalPulse = sin(portalUniforms.uTime.mul(2.35).add(angle.mul(5))).mul(0.12).add(0.96);
      const membrane = sin(portalUniforms.uTime.mul(3.1).add(p.x.mul(11)).add(p.y.mul(7)));
      // Preserve the destination's linear color/exposure through the window;
      // spectral energy belongs on the animated boundary, not as a tint over
      // the entire world that visibly disappears at the crossing plane.
      const col = vec3(red, green, blue).add(vec3(0.006, 0.0075, 0.009))
        .add(vec3(0.10, 0.24, 0.48).mul(pow(edge, 5)).mul(0.42))
        .add(vec3(0.22, 0.42, 0.92).mul(pow(edge, 3)).mul(portalUniforms.uTension).mul(0.24))
        .add(vec3(0.72, 0.42, 1.05).mul(pow(edge, 2)).mul(portalUniforms.uBurst).mul(0.34))
        .add(vec3(0.04, 0.08, 0.16).mul(membrane).mul(portalUniforms.uOpen).mul(pow(edge, 3)).mul(0.35))
        .mul(mix(float(1), portalPulse, edge.mul(0.72)));
      const reveal = tslSmoothstep(0.055, 0.20, portalUniforms.uOpen).add(portalUniforms.uTension.mul(0.045));
      return vec4(col, mask.mul(reveal.greaterThan(0.035)));
    })();
    // NodeMaterial does not infer the material opacity/alpha-test input from a
    // vec4 colorNode on every backend. Feeding the channels explicitly keeps
    // the rectangular portal quad from becoming an opaque black fullscreen
    // occluder under WebGPURenderer's WebGL2 and WebGPU backends.
    this.portalMat.colorNode = portalOutput.rgb;
    this.portalMat.opacityNode = portalOutput.a;
    this.portalSurface = new THREE.Mesh(new THREE.PlaneGeometry(this.width * 1.22, this.height * 1.22), this.portalMat);
    this.portalSurface.position.z = -this.depth - 0.5;
    this.portalSurface.renderOrder = 1;
    this.visual.add(this.portalSurface);
    this.visual.scale.set(0.055, 0.045, 0.10).multiplyScalar(this.profile.renderScale);
  }

  _openCurve(t) {
    const times = [0, 0.08, 0.18, 0.36, 0.58, 0.74, 0.88, 1];
    const values = [0, 0.018, 0.07, 0.24, 0.58, 0.92, 1.035, 1];
    t = clamp(t, 0, 1);
    let i = 0;
    while (i < times.length - 2 && t > times[i + 1]) i++;
    const u = (t - times[i]) / (times[i + 1] - times[i]);
    const eased = u * u * (3 - 2 * u);
    return lerp(values[i], values[i + 1], eased);
  }

  _tearImpulse(t, center, width) {
    const x = (t - center) / width;
    return Math.exp(-x * x);
  }

  setTransform(position, quaternion, targetAnchor, targetQuaternion = quaternion) {
    this.group.position.copy(position);
    this.group.quaternion.copy(quaternion);
    if (targetAnchor) this.targetAnchor.copy(targetAnchor);
    if (targetQuaternion) this.targetQuaternion.copy(targetQuaternion);
  }

  openPassage() {
    this.traversed = false;
    this.handoffActive = false;
    this.handoffFade = 0;
    this.handoffElapsed = 0;
    this.portalSurface.visible = true;
    this.group.visible = true;
    this.setOpen(1);
  }

  setOpen(value) {
    value = clamp(value, 0, 1);
    if (Math.abs(value - this.targetOpen) < 1e-4 && (!this.animating || Math.abs(value - this.animTo) < 1e-4)) return;
    this.targetOpen = value;
    this.animFrom = this.open;
    this.animTo = value;
    this.animElapsed = 0;
    this.animDirection = Math.sign(value - this.open);
    const remaining = Math.abs(value - this.open);
    this.animDuration = this.animDirection > 0 ? Math.max(0.72, 2.62 * remaining) : Math.max(0.42, 0.88 * remaining);
    this.animating = remaining > 0.001;
    this.group.visible = true;
  }

  markTraversed() {
    this.portalSurface.visible = false;
    this.traversed = true;
    this.handoffActive = true;
    this.handoffFade = 0;
    this.handoffElapsed = 0;
  }

  crossed(previousRenderPosition, currentRenderPosition) {
    if (this.open < 0.96 || this.traversed) return false;
    this.group.updateMatrixWorld(true);
    this.visual.worldToLocal(_localPrev.copy(previousRenderPosition));
    this.visual.worldToLocal(_localCurr.copy(currentRenderPosition));
    const planeZ = -this.depth;
    const crossed = _localPrev.z > planeZ && _localCurr.z <= planeZ;
    // A slow frame can leave both samples just behind the surface. Keep a
    // short catch volume behind the visible window so traversal never depends
    // on observing one exact frame at the plane.
    const justPassed = _localCurr.z <= planeZ && _localCurr.z >= planeZ - 180;
    if (!crossed && !justPassed) return false;
    const span = _localCurr.z - _localPrev.z;
    const t = crossed && Math.abs(span) > 1e-6 ? clamp((planeZ - _localPrev.z) / span, 0, 1) : 1;
    const hitX = lerp(_localPrev.x, _localCurr.x, t);
    const hitY = lerp(_localPrev.y, _localCurr.y, t);
    const angle = Math.atan2(hitY / (this.height * 0.5), hitX / (this.width * 0.5));
    const radius = Math.hypot(hitX / (this.width * 0.5), hitY / (this.height * 0.5));
    return radius <= (this.contour(angle) + edgeMotion(angle, this.time) * this.open) * 0.96;
  }

  update(dt, time) {
    this.time = time;
    let timeline = 1;
    if (this.animating) {
      this.animElapsed += dt;
      timeline = clamp(this.animElapsed / Math.max(this.animDuration, 0.001), 0, 1);
      const shaped = this.animDirection > 0 ? this._openCurve(timeline) : timeline * timeline * (3 - 2 * timeline);
      this.open = lerp(this.animFrom, this.animTo, shaped);
      if (timeline >= 1) { this.open = this.animTo; this.animating = false; }
    } else {
      this.open = this.targetOpen;
    }

    if (this.handoffActive) {
      this.handoffElapsed += dt;
      if (this.handoffElapsed > 0.08) this.handoffFade = clamp(this.handoffFade + dt / 0.68, 0, 1);
      if (this.handoffFade >= 1) {
        this.handoffActive = false;
        this.group.visible = false;
        this.open = 0;
        this.targetOpen = 0;
        this.animating = false;
      }
    }

    const collapse = smoothstep(0, 1, this.handoffFade);
    const visualOpen = this.open * (1 - collapse);
    const eased = visualOpen < 0.5 ? 2 * visualOpen * visualOpen : 1 - Math.pow(-2 * visualOpen + 2, 3) / 2;
    const progress = this.animDirection > 0 && this.animating ? timeline : 1;
    this.openTimeline = progress;
    const micro = this.animDirection > 0 && this.animating ? this._tearImpulse(progress, 0.12, 0.045) : 0;
    const preVisible = this.animDirection > 0 && this.animating
      ? smoothstep(0.035, 0.12, progress) * (1 - smoothstep(0.44, 0.72, progress)) : 0;
    this.tension = this.animDirection > 0 && this.animating
      ? smoothstep(0.08, 0.58, progress) * (1 - smoothstep(0.72, 0.90, progress)) : 0;
    this.burst = this.animDirection > 0 && this.animating ? this._tearImpulse(progress, 0.77, 0.072) : 0;
    if (this.handoffActive) {
      this.tension = Math.max(this.tension, Math.sin(collapse * Math.PI) * 0.72);
      this.burst = Math.max(this.burst, this._tearImpulse(collapse, 0.58, 0.14) * 0.7);
    }
    const preStretch = preVisible * (0.035 + 0.035 * this.tension);
    const settle = this.targetOpen > 0.5 ? Math.sin(Math.min(1, visualOpen) * Math.PI) * 0.012 : 0;
    const scale = this.profile.renderScale;
    this.visual.scale.set(
      0.055 + (0.945 + settle) * eased + preStretch + micro * 0.025 + this.burst * 0.10,
      0.045 + 0.955 * Math.pow(Math.max(eased, 0), 0.92) - preStretch * 0.35 + micro * 0.018 + this.burst * 0.13,
      0.10 + 0.90 * Math.pow(Math.max(eased, 0), 0.68) + preVisible * 0.05 + micro * 0.04 + this.burst * 0.18,
    ).multiplyScalar(scale);
    this.visual.rotation.z = 0.035 + Math.sin(time * 0.31) * 0.008 * eased
      + Math.sin(time * 13) * this.tension * 0.006 + Math.sin(time * 27) * this.burst * 0.042;
    this.stability = smoothstep(0.84, 0.995, this.open);
    for (const material of [this.portalMat, this.tunnelMat, this.massMat, ...this.rimMaterials]) {
      material.uniforms.uOpen.value = visualOpen;
      material.uniforms.uTension.value = this.tension;
      material.uniforms.uBurst.value = this.burst;
      material.uniforms.uTime.value = time;
    }
    this._updateLivingFilaments(time, visualOpen);
  }

  renderPortal({ beforeRender, afterRender } = {}) {
    if (this.open < 0.025 || this.traversed) return;
    this.mainCamera.updateMatrixWorld(true);
    this.group.updateMatrixWorld(true);
    const sourceSurface = this.visual.localToWorld(_center.set(0, 0, -this.depth));
    this.group.getWorldQuaternion(this.sourceQuaternion);
    this.sourceFrameMatrix.compose(sourceSurface, this.sourceQuaternion, this.unitScale);
    this.targetFrameMatrix.compose(this.targetAnchor, this.targetQuaternion, this.unitScale);
    this.inverseSourceMatrix.copy(this.sourceFrameMatrix).invert();
    this.offsetMatrix.copy(this.targetFrameMatrix).multiply(this.inverseSourceMatrix);
    this.portalCamera.position.copy(this.mainCamera.position).applyMatrix4(this.offsetMatrix);
    this.frameRotation.copy(this.targetQuaternion).multiply(this.sourceQuaternion.clone().invert());
    this.portalCamera.quaternion.copy(this.frameRotation).multiply(this.mainCamera.quaternion);
    this.portalCamera.scale.copy(this.mainCamera.scale);
    this.portalCamera.fov = this.mainCamera.fov;
    this.portalCamera.aspect = this.mainCamera.aspect;
    this.portalCamera.near = this.mainCamera.near;
    this.portalCamera.far = this.mainCamera.far;
    this.portalCamera.updateProjectionMatrix();
    this.portalCamera.updateMatrixWorld(true);
    this.textureMatrix.copy(this.biasMatrix)
      .multiply(this.portalCamera.projectionMatrix)
      .multiply(this.portalCamera.matrixWorldInverse)
      .multiply(this.offsetMatrix);
    this.portalMat.uniforms.uTextureMatrix.value.copy(this.textureMatrix);
    const wasVisible = this.group.visible;
    this.group.visible = false;
    beforeRender?.(this.portalCamera);
    const oldTarget = this.renderer.getRenderTarget();
    const oldXr = this.renderer.xr.enabled;
    this.renderer.xr.enabled = false;
    this.renderer.setRenderTarget(this.portalRT);
    this.renderer.clear();
    this.renderer.render(this.scene, this.portalCamera);
    this.renderer.setRenderTarget(oldTarget);
    this.renderer.xr.enabled = oldXr;
    afterRender?.();
    this.group.visible = wasVisible;
  }

  updateDistortion(pass) {
    if (!pass) return;
    if (!this.group.visible || this.traversed) {
      pass.uniforms.uOpen.value = 0;
      pass.uniforms.uTension.value = 0;
      pass.uniforms.uBurst.value = 0;
      return;
    }
    const center = this.visual.localToWorld(_center.set(0, 0, 0)).project(this.mainCamera);
    const edgeX = this.visual.localToWorld(_edgeX.set(this.width * 0.5, 0, 0)).project(this.mainCamera);
    const edgeY = this.visual.localToWorld(_edgeY.set(0, this.height * 0.5, 0)).project(this.mainCamera);
    const behind = center.z > 1;
    pass.uniforms.uCenter.value.set(center.x * 0.5 + 0.5, center.y * 0.5 + 0.5);
    pass.uniforms.uRadius.value.set(
      behind ? 0.0001 : Math.abs(edgeX.x - center.x) * 0.5,
      behind ? 0.0001 : Math.abs(edgeY.y - center.y) * 0.5,
    );
    pass.uniforms.uOpen.value = behind ? 0 : this.open;
    pass.uniforms.uTension.value = behind ? 0 : this.tension;
    pass.uniforms.uBurst.value = behind ? 0 : this.burst;
    pass.uniforms.uStrength.value = 1;
    pass.uniforms.uTime.value = this.time;
  }

  resize(width, height, pixelRatio = 1) {
    const targetWidth = Math.min(1536, Math.max(768, Math.round(width * pixelRatio * this.portalScale)));
    const targetHeight = Math.min(1024, Math.max(512, Math.round(height * pixelRatio * this.portalScale)));
    this.portalRT.setSize(targetWidth, targetHeight);
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((object) => {
      object.geometry?.dispose();
      if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
      else object.material?.dispose();
    });
    this.portalRT.dispose();
  }
}

