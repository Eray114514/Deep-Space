// Reusable spatial passage based on the standalone rift prototype. The
// defaults intentionally preserve that prototype's silhouette, layered rim,
// tunnel thickness, projected destination and two-stage opening motion.

import * as THREE from 'three';
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

export const RiftDistortionShader = {
  uniforms: {
    tDiffuse: { value: null },
    uCenter: { value: new THREE.Vector2(0.5, 0.5) },
    uRadius: { value: new THREE.Vector2(0.15, 0.15) },
    uOpen: { value: 0 },
    uTime: { value: 0 },
    uStrength: { value: 1 },
    uTension: { value: 0 },
    uBurst: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 uCenter;
    uniform vec2 uRadius;
    uniform float uOpen;
    uniform float uTime;
    uniform float uStrength;
    uniform float uTension;
    uniform float uBurst;
    varying vec2 vUv;
    float boundary(float a) {
      return 1.0
        + .100 * sin(a * 3.0 + .72)
        + .052 * sin(a * 5.0 - 1.18)
        + .030 * sin(a * 11.0 + 2.16)
        + .020 * sin(a * 17.0 - .45)
        + .030 * pow(max(0.0, sin(a * 7.0 + 1.7)), 8.0)
        + uOpen * (
          .030 * sin(a * 4.0 - uTime * .72 + .8)
          + .018 * sin(a * 9.0 + uTime * 1.18 - 1.6)
          + .010 * sin(a * 23.0 - uTime * 2.05)
          + .006 * sin(a * 47.0 + uTime * 3.4)
        );
    }
    void main() {
      vec2 safeR = max(uRadius, vec2(.0001));
      vec2 q = (vUv - uCenter) / safeR;
      float a = atan(q.y, q.x);
      float d = length(q);
      float b = boundary(a);
      float band = exp(-pow((d - b) / .030, 2.0));
      float outer = exp(-pow((d - b) / .075, 2.0));
      float tear = exp(-pow((d - b) / .010, 2.0));
      vec2 dir = normalize(q + vec2(1e-5));
      float pulse = .72 + .28 * sin(uTime * 2.1 + a * 9.0);
      float strainPulse = .82 + .18 * sin(uTime * 10.5 + a * 17.0);
      float fold = uOpen + uTension * .72 + uBurst * .32;
      vec2 pull = -dir * safeR * (.012 * band + .002 * outer) * fold * uStrength * pulse;
      pull += -dir * safeR * (.006 * outer + .004 * band) * uTension * strainPulse;
      vec2 tangent = vec2(-dir.y, dir.x);
      pull += tangent * safeR * (.003 * band * sin(a * 13.0 - uTime * 1.7)) * fold;
      pull += tangent * safeR * (.004 * outer * sin(a * 23.0 + uTime * 6.0)) * uTension;
      pull += tangent * safeR * .006 * tear * sin(a * 41.0 - uTime * 4.2) * uOpen;
      vec2 uv = vUv + pull;
      float split = (.0002 + .0010 * band + .0022 * tear) * fold * uStrength
        + uBurst * band * .0020;
      float r = texture2D(tDiffuse, uv + dir * split).r;
      float g = texture2D(tDiffuse, uv).g;
      float bcol = texture2D(tDiffuse, uv - dir * split).b;
      vec3 col = vec3(r, g, bcol);
      col += vec3(.006, .015, .030) * band * uOpen;
      col += vec3(.10, .22, .52) * tear * uOpen * (.36 + .24 * sin(a * 29.0 - uTime * 3.1));
      col += vec3(.025, .07, .18) * band * uTension * .35;
      col += vec3(.28, .16, .42) * band * uBurst * .18;
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

export const DEFAULT_RIFT_PROFILE = Object.freeze({
  width: 820,
  height: 630,
  depth: 96,
  edgeThickness: 1,
  ribbonSegments: 520,
  tunnelSegments: 300,
  tunnelRings: 28,
  renderScale: 1,
  rimLayers: Object.freeze([
    { scale: 1.000, band: 5, z: 8, alpha: 0.74, phase: 0, brightness: 1.22 },
    { scale: 1.008, band: 9, z: 2, alpha: 0.22, phase: 1.7, brightness: 0.78 },
    { scale: 0.994, band: 4, z: 14, alpha: 0.66, phase: 3.2, brightness: 1.32 },
    { scale: 1.018, band: 14, z: -4, alpha: 0.05, phase: 5.0, brightness: 0.58 },
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
    this.portalVolumeLayerRendered = false;

    this.portalCamera = mainCamera.clone();
    this.portalCamera.matrixAutoUpdate = true;
    this.portalRT = new THREE.WebGLRenderTarget(1280, 768, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
    });
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
      color: phase % 2 ? 0x9bcfff : 0xf1f7ff,
      transparent: true,
      opacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const line = new THREE.Line(geometry, material);
    line.userData.filament = { scale, phase, count, opacity };
    line.renderOrder = 7;
    return line;
  }

  _updateLivingFilaments(time, open) {
    for (const line of this.livingFilaments) {
      const { scale, phase, count, opacity } = line.userData.filament;
      const positions = line.geometry.attributes.position.array;
      for (let i = 0; i < count; i++) {
        const angle = (i % (count - 1)) / (count - 1) * TAU;
        const motion = edgeMotion(angle + phase * 0.015, time * (1 + phase * 0.04)) * open;
        const electric = Math.sin(angle * (13 + phase * 2) - time * (2.1 + phase * 0.17)) * 0.006 * open;
        const radius = (this.contour(angle) + motion + electric) * scale;
        const fracture = Math.pow(Math.max(0, Math.sin(angle * (19 + phase * 3)
          - time * (2.4 + phase * 0.21) + phase)), 18);
        const index = i * 3;
        positions[index] = Math.cos(angle) * this.width * 0.5 * radius;
        positions[index + 1] = Math.sin(angle) * this.height * 0.5 * radius;
        positions[index + 2] = 15 + phase * 1.5
          + Math.sin(angle * 19 + time * 2.8 + phase) * (3 + fracture * 9) * open;
      }
      line.geometry.attributes.position.needsUpdate = true;
      line.material.opacity = opacity * smoothstep(0.02, 0.20, open);
    }
  }

  _rimShader(alpha = 1, phase = 0, brightness = 1) {
    return new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      uniforms: {
        uTime: { value: 0 }, uOpen: { value: 0 }, uTension: { value: 0 }, uBurst: { value: 0 },
        uAlpha: { value: alpha }, uPhase: { value: phase }, uBrightness: { value: brightness },
      },
      vertexShader: /* glsl */`
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute float aAcross; attribute float aAngle; attribute float aRand;
        varying float vAcross; varying float vAngle; varying float vRand;
        uniform float uTime; uniform float uOpen; uniform float uTension; uniform float uBurst; uniform float uPhase;
        void main() {
          vec3 p = position;
          float alive = smoothstep(.02, .30, uOpen);
          float strain = sin(aAngle * 37.0 - uTime * 8.5 + uPhase) * uTension;
          float arcTip = pow(max(0.0, sin(aAngle * 17.0 - uTime * 2.7 + uPhase)), 28.0)
            + pow(max(0.0, sin(aAngle * 31.0 + uTime * 1.9 - uPhase)), 42.0);
          p.z += sin(aAngle * 19.0 + uTime * 2.5 + uPhase) * 3.5 * alive + strain * 8.0;
          float livingEdge =
            .030 * sin(aAngle * 4.0 - uTime * .72 + .8)
            + .018 * sin(aAngle * 9.0 + uTime * 1.18 - 1.6)
            + .010 * sin(aAngle * 23.0 - uTime * 2.05)
            + .006 * sin(aAngle * 47.0 + uTime * 3.4);
          float layerRipple = sin(aAngle * 7.0 - uTime * 1.1 + uPhase) * .007;
          p.xy *= 1.0 + (livingEdge + layerRipple) * alive + strain * .0035
            + aAcross * arcTip * (.014 + .016 * uTension) * alive;
          p.z += aAcross * arcTip * (4.0 + 5.0 * uTension);
          p.xy *= 1.0 + uBurst * .018;
          vAcross = aAcross; vAngle = aAngle; vRand = aRand;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
          #include <logdepthbuf_vertex>
        }
      `,
      fragmentShader: /* glsl */`
        #include <common>
        #include <logdepthbuf_pars_fragment>
        varying float vAcross; varying float vAngle; varying float vRand;
        uniform float uTime; uniform float uOpen; uniform float uTension; uniform float uBurst;
        uniform float uAlpha; uniform float uPhase; uniform float uBrightness;
        vec3 spectrum(float t) {
          vec3 c = .58 + .42 * cos(6.28318 * (vec3(t) + vec3(0.0, .31, .63)));
          return pow(max(c, 0.0), vec3(.72));
        }
        void main() {
          #include <logdepthbuf_fragment>
          float core = pow(max(0.0, sin(vAcross * 3.1415926)), .38);
          float f1 = pow(max(0.0, sin(vAngle * 13.0 - uTime * 2.15 + uPhase + vRand * 2.0)), 12.0);
          float f2 = pow(max(0.0, sin(vAngle * 29.0 + uTime * 1.45 - uPhase)), 22.0);
          float flow = .34 + .66 * (f1 * .72 + f2 * .45);
          float hue = fract(vAngle / 6.28318 + uTime * .018 + vRand * .11 + uPhase * .03);
          vec3 chroma = spectrum(hue);
          vec3 c = mix(vec3(.08, .30, .82), chroma, .24) + vec3(.72, .26, .10) * f1 * .34;
          c += vec3(1.65, 1.90, 2.65) * pow(core, 4.0) * (f1 * .7 + .25);
          float charge = pow(max(0.0, sin(vAngle * 41.0 - uTime * 9.0 + uPhase)), 18.0);
          c += vec3(.72, 1.05, 1.65) * (charge * .95 + .16) * uTension;
          c += vec3(1.75, 1.25, 1.85) * (1.0 - core * .25) * uBurst * .82;
          // A white-hot inner filament sells a cut in space without flooding
          // the destination image. Broken angular gates keep it electrical,
          // while the broader ribbons remain the cooler displaced membrane.
          float inner = exp(-vAcross * 22.0);
          float gate = .34 + .66 * max(f1, charge);
          float tear = inner * gate;
          c += vec3(3.8, 4.6, 7.2) * tear;
          float fracture = .06 + .94 * max(f1, max(f2 * .72, charge));
          float a = (.04 + .96 * core) * fracture * (.22 + .78 * flow)
            * uAlpha * smoothstep(.02, .20, uOpen);
          a += tear * uAlpha * .82 * smoothstep(.03, .18, uOpen);
          a *= 1.0 + uTension * .95 + uBurst * .75;
          gl_FragColor = vec4(c * uBrightness, a);
        }
      `,
    });
  }

  _makeStructure() {
    const curve = new THREE.CatmullRomCurve3(this._curvePoints(0, 1.016), true, 'catmullrom', 0.12);
    this.massMat = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      depthWrite: true,
      uniforms: {
        uTime: { value: 0 }, uOpen: { value: 0 }, uTension: { value: 0 }, uBurst: { value: 0 },
        uHalfSize: { value: new THREE.Vector2(this.width * 0.5, this.height * 0.5) },
      },
      vertexShader: /* glsl */`
        #include <common>
        #include <logdepthbuf_pars_vertex>
        uniform float uTime; uniform float uOpen; uniform float uTension; uniform float uBurst;
        uniform vec2 uHalfSize;
        varying float vCharge;
        void main() {
          vec3 p = position;
          float a = atan(p.y / uHalfSize.y, p.x / uHalfSize.x);
          float livingEdge =
            .030 * sin(a * 4.0 - uTime * .72 + .8)
            + .018 * sin(a * 9.0 + uTime * 1.18 - 1.6)
            + .010 * sin(a * 23.0 - uTime * 2.05)
            + .006 * sin(a * 47.0 + uTime * 3.4);
          p.xy *= 1.0 + livingEdge * smoothstep(.03, .28, uOpen);
          p.z += sin(a * 19.0 + uTime * 2.5) * (2.4 + 6.0 * uTension);
          p.xy *= 1.0 + uBurst * .018;
          vCharge = .5 + .5 * sin(a * 11.0 - uTime * 1.4);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
          #include <logdepthbuf_vertex>
        }
      `,
      fragmentShader: /* glsl */`
        #include <common>
        #include <logdepthbuf_pars_fragment>
        varying float vCharge;
        uniform float uOpen; uniform float uTension; uniform float uBurst;
        void main() {
          #include <logdepthbuf_fragment>
          float broken = smoothstep(.28, .58, vCharge + uTension * .16 + uBurst * .3);
          if (broken < .08) discard;
          vec3 base = vec3(.0004, .0012, .0035);
          vec3 charge = vec3(.003, .012, .034) * (.25 + .75 * vCharge);
          vec3 color = base + charge * (.22 + uTension * .55) + vec3(.08, .035, .12) * uBurst;
          gl_FragColor = vec4(color * smoothstep(.015, .12, uOpen), 1.0);
        }
      `,
    });
    this.mass = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 520, 5 * this.profile.edgeThickness, 5, true),
      this.massMat,
    );
    this.mass.renderOrder = 3;
    this.visual.add(this.mass);

    this.tunnelMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      uniforms: { uTime: { value: 0 }, uOpen: { value: 0 }, uTension: { value: 0 }, uBurst: { value: 0 } },
      vertexShader: /* glsl */`
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute float aAngle; attribute float aDepth;
        varying float vAngle; varying float vDepth; varying vec3 vN;
        uniform float uTime; uniform float uOpen; uniform float uTension; uniform float uBurst;
        void main() {
          vec3 p = position;
          float livingEdge =
            .030 * sin(aAngle * 4.0 - uTime * .72 + .8)
            + .018 * sin(aAngle * 9.0 + uTime * 1.18 - 1.6)
            + .010 * sin(aAngle * 23.0 - uTime * 2.05)
            + .006 * sin(aAngle * 47.0 + uTime * 3.4);
          p.xy *= 1.0 + livingEdge * uOpen * (1.0 - aDepth * .48);
          p.xy *= 1.0 + sin(aAngle * 8.0 + aDepth * 18.0 - uTime * 1.15) * .010 * uOpen;
          p.xy *= 1.0 + sin(aAngle * 29.0 - aDepth * 12.0 - uTime * 7.0) * .006 * uTension;
          p.xy *= 1.0 + uBurst * .016 * (1.0 - aDepth);
          vAngle = aAngle; vDepth = aDepth; vN = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
          #include <logdepthbuf_vertex>
        }
      `,
      fragmentShader: /* glsl */`
        #include <common>
        #include <logdepthbuf_pars_fragment>
        varying float vAngle; varying float vDepth; varying vec3 vN;
        uniform float uTime; uniform float uOpen; uniform float uTension; uniform float uBurst;
        vec3 spectral(float t) { return .58 + .42 * cos(6.28318 * (vec3(t) + vec3(0., .33, .67))); }
        void main() {
          #include <logdepthbuf_fragment>
          float l1 = pow(max(0.0, sin(vAngle * 17.0 - vDepth * 29.0 - uTime * 2.1)), 18.0);
          float l2 = pow(max(0.0, sin(vAngle * 31.0 + vDepth * 41.0 + uTime * 1.3)), 28.0);
          float ribs = pow(max(0.0, sin(vDepth * 25.0 - vAngle * 3.0)), 20.0);
          float fracture = max(l1, max(l2 * .72, ribs * .42));
          vec3 c = spectral(fract(vAngle / 6.28318 + vDepth * .3 + uTime * .015)) * (l1 * .58 + l2 * .32);
          c += vec3(.08, .34, .90) * ribs * .18;
          c += spectral(fract(vAngle / 6.28318 + uTime * .08)) * uTension * (l1 * .55 + .08);
          c += vec3(.72, .48, 1.08) * uBurst * (.12 + .88 * fracture) * (1.0 - vDepth);
          c *= smoothstep(.045, .20, uOpen) + uTension * .10;
          float alpha = (.002 + fracture * .08) * (1.0 - vDepth * .84)
            * smoothstep(.045, .20, uOpen);
          gl_FragColor = vec4(c, min(alpha, .12));
        }
      `,
    });
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
    const exitMaterial = this._rimShader(0.07, 2.4, 0.58);
    const exitRim = new THREE.Mesh(this._makeRibbonGeometry(0.982, 6, -this.depth + 3, 2.4), exitMaterial);
    exitRim.renderOrder = 4;
    this.rimMaterials.push(exitMaterial);
    this.visual.add(exitRim);

    this.livingFilaments = [
      this._makeLivingFilament(0.994, 0.34, 0),
      this._makeLivingFilament(1.003, 0.48, 1),
      this._makeLivingFilament(1.014, 0.26, 2),
    ];
    for (const filament of this.livingFilaments) this.visual.add(filament);

    this.portalMat = new THREE.ShaderMaterial({
      // The destination is a real opaque window. Treating this plane as a
      // blended surface let nearby source-system planets bleed through it and
      // visually sit on top of the tunnel wall. The irregular silhouette is
      // still cut out in the fragment shader; only the luminous rim blends.
      transparent: false,
      depthWrite: true,
      depthTest: true,
      side: THREE.DoubleSide,
      toneMapped: false,
      uniforms: {
        tPortal: { value: this.portalRT.texture },
        uTextureMatrix: { value: this.textureMatrix },
        uOpen: { value: 0 }, uTension: { value: 0 }, uBurst: { value: 0 }, uTime: { value: 0 },
        uHalfSize: { value: new THREE.Vector2(this.width * 0.5, this.height * 0.5) },
      },
      vertexShader: /* glsl */`
        #include <common>
        #include <logdepthbuf_pars_vertex>
        uniform mat4 uTextureMatrix;
        varying vec4 vProj; varying vec2 vLocal;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vProj = uTextureMatrix * world;
          vLocal = position.xy;
          gl_Position = projectionMatrix * viewMatrix * world;
          #include <logdepthbuf_vertex>
        }
      `,
      fragmentShader: /* glsl */`
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform sampler2D tPortal; uniform float uOpen; uniform float uTension; uniform float uBurst;
        uniform float uTime; uniform vec2 uHalfSize;
        varying vec4 vProj; varying vec2 vLocal;
        float boundary(float a) {
          return 1.0 + .100 * sin(a * 3.0 + .72) + .052 * sin(a * 5.0 - 1.18)
            + .030 * sin(a * 11.0 + 2.16) + .020 * sin(a * 17.0 - .45)
            + .030 * pow(max(0.0, sin(a * 7.0 + 1.7)), 8.0)
            + uOpen * (
              .030 * sin(a * 4.0 - uTime * .72 + .8)
              + .018 * sin(a * 9.0 + uTime * 1.18 - 1.6)
              + .010 * sin(a * 23.0 - uTime * 2.05)
              + .006 * sin(a * 47.0 + uTime * 3.4)
            );
        }
        void main() {
          #include <logdepthbuf_fragment>
          vec2 p = vLocal / uHalfSize;
          float a = atan(p.y, p.x), r = length(p), b = boundary(a) * .965;
          float aa = max(fwidth(r) * 1.6, .002);
          float mask = 1.0 - smoothstep(b - aa, b + aa, r);
          if (mask < .45 || uOpen < .035) discard;
          vec2 uv = vProj.xy / max(vProj.w, 1e-5);
          float edge = smoothstep(b - .055, b, r);
          float wave = sin(a * 19.0 - uTime * 1.8) + sin(a * 7.0 + uTime * 1.15);
          vec2 dir = normalize(p + vec2(1e-5));
          vec2 tangent = vec2(-dir.y, dir.x);
          uv += tangent * wave * .0018 * edge * uOpen;
          float d = (.00055 + .0045 * edge) * uOpen;
          float rr = texture2D(tPortal, uv + dir * d).r;
          float gg = texture2D(tPortal, uv).g;
          float bb = texture2D(tPortal, uv - dir * d).b;
          vec3 col = vec3(rr, gg, bb);
          col += vec3(.035, .08, .18) * pow(edge, 5.0) * .24;
          col += vec3(.10, .20, .46) * pow(edge, 3.0) * uTension * .16;
          col += vec3(.42, .24, .62) * pow(edge, 2.0) * uBurst * .22;
          float reveal = smoothstep(.055, .20, uOpen) + uTension * .045;
          if (reveal < .035) discard;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
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
    // The destination atmosphere and volumetric cloud shell live on layer 2
    // in the main render graph. The portal is a direct offscreen render, so it
    // must opt into that same layer or the planet is shown bare until crossing.
    const oldLayerMask = this.portalCamera.layers.mask;
    this.portalCamera.layers.enable(2);
    this.portalVolumeLayerRendered = this.portalCamera.layers.isEnabled(2);
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
    this.portalCamera.layers.mask = oldLayerMask;
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
