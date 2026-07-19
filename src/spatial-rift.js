// Reusable spatial passage based on the standalone rift prototype. The
// defaults intentionally preserve that prototype's silhouette, layered rim,
// tunnel thickness, projected destination and two-stage opening motion.

import * as THREE from 'three';
import { clamp, lerp, smoothstep } from './noise.js';

const TAU = Math.PI * 2;
const _origin = new THREE.Vector3();
const _center = new THREE.Vector3();
const _edgeX = new THREE.Vector3();
const _edgeY = new THREE.Vector3();
const _localPrev = new THREE.Vector3();
const _localCurr = new THREE.Vector3();

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
        + .030 * pow(max(0.0, sin(a * 7.0 + 1.7)), 8.0);
    }
    void main() {
      vec2 safeR = max(uRadius, vec2(.0001));
      vec2 q = (vUv - uCenter) / safeR;
      float a = atan(q.y, q.x);
      float d = length(q);
      float b = boundary(a);
      float band = exp(-pow((d - b) / .082, 2.0));
      float outer = exp(-pow((d - b) / .21, 2.0));
      vec2 dir = normalize(q + vec2(1e-5));
      float pulse = .72 + .28 * sin(uTime * 2.1 + a * 9.0);
      float strainPulse = .82 + .18 * sin(uTime * 10.5 + a * 17.0);
      float fold = uOpen + uTension * .72 + uBurst * .32;
      vec2 pull = -dir * safeR * (.050 * band + .012 * outer) * fold * uStrength * pulse;
      pull += -dir * safeR * (.024 * outer + .018 * band) * uTension * strainPulse;
      vec2 tangent = vec2(-dir.y, dir.x);
      pull += tangent * safeR * (.010 * band * sin(a * 13.0 - uTime * 1.7)) * fold;
      pull += tangent * safeR * (.014 * outer * sin(a * 23.0 + uTime * 6.0)) * uTension;
      vec2 uv = vUv + pull;
      float split = (.0007 + .0032 * band) * fold * uStrength + uBurst * band * .0065;
      float r = texture2D(tDiffuse, uv + dir * split).r;
      float g = texture2D(tDiffuse, uv).g;
      float bcol = texture2D(tDiffuse, uv - dir * split).b;
      vec3 col = vec3(r, g, bcol);
      col += vec3(.02, .05, .09) * band * uOpen;
      col += vec3(.08, .20, .48) * band * uTension * .55;
      col += vec3(.55, .30, .82) * band * uBurst * .28;
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

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
    { scale: 1.000, band: 34, z: 8, alpha: 0.92, phase: 0, brightness: 1.16 },
    { scale: 1.025, band: 58, z: 1, alpha: 0.56, phase: 1.7, brightness: 1.00 },
    { scale: 0.982, band: 22, z: 14, alpha: 0.76, phase: 3.2, brightness: 1.28 },
    { scale: 1.068, band: 82, z: -9, alpha: 0.28, phase: 5.0, brightness: 0.92 },
    { scale: 1.120, band: 110, z: -16, alpha: 0.14, phase: 7.1, brightness: 0.78 },
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
        attribute float aAcross; attribute float aAngle; attribute float aRand;
        varying float vAcross; varying float vAngle; varying float vRand;
        uniform float uTime; uniform float uOpen; uniform float uTension; uniform float uBurst; uniform float uPhase;
        void main() {
          vec3 p = position;
          float alive = smoothstep(.02, .30, uOpen);
          float strain = sin(aAngle * 37.0 - uTime * 8.5 + uPhase) * uTension;
          p.z += sin(aAngle * 19.0 + uTime * 2.5 + uPhase) * 3.5 * alive + strain * 8.0;
          p.xy *= 1.0 + sin(aAngle * 7.0 - uTime * 1.1 + uPhase) * .006 * alive + strain * .0035;
          p.xy *= 1.0 + uBurst * .018;
          vAcross = aAcross; vAngle = aAngle; vRand = aRand;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        varying float vAcross; varying float vAngle; varying float vRand;
        uniform float uTime; uniform float uOpen; uniform float uTension; uniform float uBurst;
        uniform float uAlpha; uniform float uPhase; uniform float uBrightness;
        vec3 spectrum(float t) {
          vec3 c = .58 + .42 * cos(6.28318 * (vec3(t) + vec3(0.0, .31, .63)));
          return pow(max(c, 0.0), vec3(.72));
        }
        void main() {
          float core = pow(max(0.0, sin(vAcross * 3.1415926)), .38);
          float f1 = pow(max(0.0, sin(vAngle * 13.0 - uTime * 2.15 + uPhase + vRand * 2.0)), 12.0);
          float f2 = pow(max(0.0, sin(vAngle * 29.0 + uTime * 1.45 - uPhase)), 22.0);
          float flow = .34 + .66 * (f1 * .72 + f2 * .45);
          float hue = fract(vAngle / 6.28318 + uTime * .018 + vRand * .11 + uPhase * .03);
          vec3 chroma = spectrum(hue);
          vec3 c = mix(vec3(.10, .52, 1.35), chroma, .67) + vec3(1.35, .42, .08) * f1 * .72;
          c += vec3(1.45, 1.18, .96) * pow(core, 4.0) * (f1 * .6 + .35);
          float charge = pow(max(0.0, sin(vAngle * 41.0 - uTime * 9.0 + uPhase)), 18.0);
          c += vec3(.72, 1.05, 1.65) * (charge * .95 + .16) * uTension;
          c += vec3(1.75, 1.25, 1.85) * (1.0 - core * .25) * uBurst * .82;
          float a = (.08 + .92 * core) * (.28 + .72 * flow) * uAlpha * smoothstep(.02, .20, uOpen);
          a *= 1.0 + uTension * .95 + uBurst * .75;
          gl_FragColor = vec4(c * uBrightness, a);
        }
      `,
    });
  }

  _makeStructure() {
    const curve = new THREE.CatmullRomCurve3(this._curvePoints(0, 1.016), true, 'catmullrom', 0.12);
    this.mass = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 520, 34 * this.profile.edgeThickness, 10, true),
      new THREE.MeshStandardMaterial({
        color: 0x020409, metalness: 0.36, roughness: 0.44,
        emissive: 0x061426, emissiveIntensity: 0.55,
      }),
    );
    this.mass.renderOrder = 3;
    this.visual.add(this.mass);

    this.tunnelMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      transparent: false,
      depthWrite: true,
      toneMapped: false,
      uniforms: { uTime: { value: 0 }, uOpen: { value: 0 }, uTension: { value: 0 }, uBurst: { value: 0 } },
      vertexShader: /* glsl */`
        attribute float aAngle; attribute float aDepth;
        varying float vAngle; varying float vDepth; varying vec3 vN;
        uniform float uTime; uniform float uOpen; uniform float uTension; uniform float uBurst;
        void main() {
          vec3 p = position;
          p.xy *= 1.0 + sin(aAngle * 8.0 + aDepth * 18.0 - uTime * 1.15) * .010 * uOpen;
          p.xy *= 1.0 + sin(aAngle * 29.0 - aDepth * 12.0 - uTime * 7.0) * .006 * uTension;
          p.xy *= 1.0 + uBurst * .016 * (1.0 - aDepth);
          vAngle = aAngle; vDepth = aDepth; vN = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        varying float vAngle; varying float vDepth; varying vec3 vN;
        uniform float uTime; uniform float uOpen; uniform float uTension; uniform float uBurst;
        vec3 spectral(float t) { return .58 + .42 * cos(6.28318 * (vec3(t) + vec3(0., .33, .67))); }
        void main() {
          float l1 = pow(max(0.0, sin(vAngle * 17.0 - vDepth * 29.0 - uTime * 2.1)), 18.0);
          float l2 = pow(max(0.0, sin(vAngle * 31.0 + vDepth * 41.0 + uTime * 1.3)), 28.0);
          float ribs = pow(max(0.0, sin(vDepth * 25.0 - vAngle * 3.0)), 20.0);
          vec3 base = mix(vec3(.002, .006, .014), vec3(.015, .035, .075), .5 + .5 * sin(vAngle * 5.0));
          vec3 c = base + spectral(fract(vAngle / 6.28318 + vDepth * .3 + uTime * .015)) * (l1 * .82 + l2 * .48);
          c += vec3(.10, .42, 1.15) * ribs * .30;
          c += spectral(fract(vAngle / 6.28318 + uTime * .08)) * uTension * (l1 * .55 + .08);
          c += vec3(.95, .62, 1.35) * uBurst * (.20 + .80 * (1.0 - vDepth));
          c *= smoothstep(.045, .20, uOpen) + uTension * .10;
          gl_FragColor = vec4(c, 1.0);
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
    const exitMaterial = this._rimShader(0.45, 2.4, 0.82);
    const exitRim = new THREE.Mesh(this._makeRibbonGeometry(0.96, 30, -this.depth + 3, 2.4), exitMaterial);
    exitRim.renderOrder = 4;
    this.rimMaterials.push(exitMaterial);
    this.visual.add(exitRim);

    this.portalMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: true,
      side: THREE.DoubleSide,
      toneMapped: false,
      uniforms: {
        tPortal: { value: this.portalRT.texture },
        uTextureMatrix: { value: this.textureMatrix },
        uOpen: { value: 0 }, uTension: { value: 0 }, uBurst: { value: 0 }, uTime: { value: 0 },
        uHalfSize: { value: new THREE.Vector2(this.width * 0.5, this.height * 0.5) },
      },
      vertexShader: /* glsl */`
        uniform mat4 uTextureMatrix;
        varying vec4 vProj; varying vec2 vLocal;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vProj = uTextureMatrix * world;
          vLocal = position.xy;
          gl_Position = projectionMatrix * viewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D tPortal; uniform float uOpen; uniform float uTension; uniform float uBurst;
        uniform float uTime; uniform vec2 uHalfSize;
        varying vec4 vProj; varying vec2 vLocal;
        float boundary(float a) {
          return 1.0 + .100 * sin(a * 3.0 + .72) + .052 * sin(a * 5.0 - 1.18)
            + .030 * sin(a * 11.0 + 2.16) + .020 * sin(a * 17.0 - .45)
            + .030 * pow(max(0.0, sin(a * 7.0 + 1.7)), 8.0);
        }
        void main() {
          vec2 p = vLocal / uHalfSize;
          float a = atan(p.y, p.x), r = length(p), b = boundary(a) * .965;
          float aa = max(fwidth(r) * 1.6, .002);
          float mask = 1.0 - smoothstep(b - aa, b + aa, r);
          if (mask < .002 || uOpen < .035) discard;
          vec2 uv = vProj.xy / max(vProj.w, 1e-5);
          float edge = smoothstep(b - .25, b, r);
          float wave = sin(a * 19.0 - uTime * 1.8) + sin(a * 7.0 + uTime * 1.15);
          vec2 dir = normalize(p + vec2(1e-5));
          vec2 tangent = vec2(-dir.y, dir.x);
          uv += tangent * wave * .0018 * edge * uOpen;
          float d = (.00055 + .0045 * edge) * uOpen;
          float rr = texture2D(tPortal, uv + dir * d).r;
          float gg = texture2D(tPortal, uv).g;
          float bb = texture2D(tPortal, uv - dir * d).b;
          vec3 col = vec3(rr, gg, bb);
          col += vec3(.10, .24, .48) * pow(edge, 5.0) * .42;
          col += vec3(.22, .42, .92) * pow(edge, 3.0) * uTension * .24;
          col += vec3(.72, .42, 1.05) * pow(edge, 2.0) * uBurst * .34;
          float reveal = smoothstep(.055, .20, uOpen) + uTension * .045;
          gl_FragColor = vec4(col, mask * clamp(reveal, 0.0, 1.0));
        }
      `,
    });
    this.portalSurface = new THREE.Mesh(new THREE.PlaneGeometry(this.width * 1.22, this.height * 1.22), this.portalMat);
    this.portalSurface.position.z = -this.depth - 0.5;
    this.portalSurface.renderOrder = 1;
    this.visual.add(this.portalSurface);
    this.visual.scale.set(0.34, 0.025, 0.04).multiplyScalar(this.profile.renderScale);
  }

  _openCurve(t) {
    const times = [0, 0.055, 0.12, 0.19, 0.56, 0.625, 0.73, 0.86, 1];
    const values = [0, 0.018, 0.105, 0.135, 0.165, 0.205, 0.855, 0.985, 1];
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

  setTransform(position, quaternion, targetAnchor) {
    this.group.position.copy(position);
    this.group.quaternion.copy(quaternion);
    if (targetAnchor) this.targetAnchor.copy(targetAnchor);
  }

  openPassage() {
    this.traversed = false;
    this.handoffActive = false;
    this.handoffFade = 0;
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
  }

  crossed(previousRenderPosition, currentRenderPosition) {
    if (this.open < 0.96 || this.traversed) return false;
    this.group.updateMatrixWorld(true);
    this.visual.worldToLocal(_localPrev.copy(previousRenderPosition));
    this.visual.worldToLocal(_localCurr.copy(currentRenderPosition));
    const crossed = _localPrev.z > -this.depth && _localCurr.z <= -this.depth;
    if (!crossed) return false;
    const angle = Math.atan2(_localCurr.y / (this.height * 0.5), _localCurr.x / (this.width * 0.5));
    const radius = Math.hypot(_localCurr.x / (this.width * 0.5), _localCurr.y / (this.height * 0.5));
    return radius <= this.contour(angle) * 0.8;
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
      this.group.updateMatrixWorld(true);
      const cameraLocal = this.visual.worldToLocal(_origin.clone());
      if (cameraLocal.z < -this.depth - 28) this.handoffFade = clamp(this.handoffFade + dt / 0.72, 0, 1);
      if (this.handoffFade >= 1) {
        this.handoffActive = false;
        this.group.visible = false;
        this.open = 0;
        this.targetOpen = 0;
        this.animating = false;
      }
    }

    const visualOpen = this.open * (1 - smoothstep(0, 1, this.handoffFade));
    const eased = visualOpen < 0.5 ? 2 * visualOpen * visualOpen : 1 - Math.pow(-2 * visualOpen + 2, 3) / 2;
    const progress = this.animDirection > 0 && this.animating ? timeline : 1;
    this.openTimeline = progress;
    const micro = this.animDirection > 0 && this.animating ? this._tearImpulse(progress, 0.105, 0.020) : 0;
    const preVisible = this.animDirection > 0 && this.animating
      ? smoothstep(0.075, 0.18, progress) * (1 - smoothstep(0.61, 0.76, progress)) : 0;
    this.tension = this.animDirection > 0 && this.animating
      ? smoothstep(0.14, 0.585, progress) * (1 - smoothstep(0.61, 0.72, progress)) : 0;
    this.burst = this.animDirection > 0 && this.animating ? this._tearImpulse(progress, 0.655, 0.046) : 0;
    const preStretch = preVisible * (0.23 + 0.14 * this.tension);
    const settle = this.targetOpen > 0.5 ? Math.sin(Math.min(1, visualOpen) * Math.PI) * 0.016 : 0;
    const scale = this.profile.renderScale;
    this.visual.scale.set(
      0.34 + (0.66 + settle) * eased + preStretch * 1.18 + micro * 0.07 + this.burst * 0.22,
      0.025 + 0.975 * Math.pow(Math.max(eased, 0), 0.78) + preVisible * 0.018 + micro * 0.014 + this.burst * 0.18,
      0.04 + 0.96 * Math.pow(Math.max(eased, 0), 1.42) + preVisible * (0.11 + 0.09 * this.tension) + micro * 0.05 + this.burst * 0.32,
    ).multiplyScalar(scale);
    this.visual.rotation.z = 0.035 + Math.sin(time * 0.31) * 0.008 * eased
      + Math.sin(time * 13) * this.tension * 0.006 + Math.sin(time * 27) * this.burst * 0.042;
    this.stability = smoothstep(0.84, 0.995, this.open);
    for (const material of [this.portalMat, this.tunnelMat, ...this.rimMaterials]) {
      material.uniforms.uOpen.value = visualOpen;
      material.uniforms.uTension.value = this.tension;
      material.uniforms.uBurst.value = this.burst;
      material.uniforms.uTime.value = time;
    }
  }

  renderPortal({ beforeRender, afterRender } = {}) {
    if (this.open < 0.025 || this.traversed) return;
    this.mainCamera.updateMatrixWorld(true);
    this.group.updateMatrixWorld(true);
    const sourceSurface = this.visual.localToWorld(_center.set(0, 0, -this.depth));
    const offset = _edgeX.copy(this.targetAnchor).sub(sourceSurface);
    this.offsetMatrix.makeTranslation(offset.x, offset.y, offset.z);
    this.portalCamera.position.copy(this.mainCamera.position).add(offset);
    this.portalCamera.quaternion.copy(this.mainCamera.quaternion);
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
