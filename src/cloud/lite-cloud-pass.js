// Lite volumetric clouds: one low-resolution ray march of a spherical cloud
// shell, composited over the lit scene after the atmosphere pass.
//
// It replaces the legacy production cloud stack (light banks, column tiles,
// far/near split programs) as the default. The whole feature is this pass and
// a 64^3 noise volume: no baking, no per-planet GPU caches, no warm-up.
//
// Inputs it shares with the rest of the frame, so every consumer agrees:
//   - planet.cloudShadowTex: the weather coverage atlas that terrain and water
//     already sample for cloud shadows (same uCloudMat spin).
//   - AtmospherePass uniforms: camera/planet frame, suns, optical-depth LUT.
// Units are metres in the planet-local frame.
import * as THREE from 'three';
import { Pass, FullScreenQuad } from '../../vendor/jsm/postprocessing/Pass.js';
import { atmosphereTransportGLSL, atmosphereUniformGLSL } from '../atmosphere-transport-glsl.js';
import { weatherAtlasGLSL } from './weather-atlas.js';
import { liteCloudNoiseTexture } from './lite-cloud-noise.js';

const _matrix = new THREE.Matrix4();
const _quaternion = new THREE.Quaternion();

const vertexShader = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const marchShader = /* glsl */`
  precision highp float;
  precision highp sampler3D;
  #define VIEW_STEPS 8
  uniform sampler3D uNoise;
  uniform sampler2D uCloudTex;
  uniform mat3 uCloudMat;
  uniform float uSynoptic, uShellBase, uShellTop, uFrame, uExtinction, uScatterGain;
  uniform vec3 uCloudTint;
  ${atmosphereUniformGLSL}
  varying vec2 vUv;
  layout(location = 1) out highp vec4 gAux;
  ${atmosphereTransportGLSL}
  ${weatherAtlasGLSL}

  float sat(float x) { return clamp(x, 0.0, 1.0); }
  float remap(float v, float a, float b, float c, float d) { return c + (v - a) / (b - a) * (d - c); }

  // Cancellation-safe sphere intersection: h = (r-|d|)(r+|d|). The textbook
  // b*b-c form loses hundreds of metres at grazing angles on a 1e6 m body.
  vec2 shellHits(vec3 origin, vec3 direction, float radius) {
    float b = dot(origin, direction);
    float ld = length(origin - b * direction);
    float h = (radius - ld) * (radius + ld);
    if (h < 0.0) return vec2(-1.0);
    h = sqrt(h);
    return vec2(-b - h, -b + h);
  }

  // Synoptic coverage from the shared weather atlas, with a mid-scale breakup
  // so the 256-texel atlas does not draw straight, blurry weather borders.
  float coverageAt(vec3 p) {
    vec3 q = uCloudMat * p;
    float c = weatherAtlasSample(uCloudTex, q).r;
    if (uSynoptic > 0.5) c = synopticCoverage(c, 0.12);
    float breakup = textureLod(uNoise, q / 93000.0, 0.0).b;
    c = sat(c * 1.12 + (breakup - 0.5) * 0.55 - 0.06);
    // Mesoscale regimes inside a weather system: closed decks with cracks
    // alternate with broken, open-cell fields instead of one uniform texture.
    float regime = textureLod(uNoise, q.yzx / 310000.0 + 0.61, 0.0).b;
    return c * mix(0.5, 1.0, smoothstep(0.32, 0.62, regime));
  }

  // lod 0: light march / far field. 1: view march. 2: view march near camera.
  float cloudDensity(vec3 p, float cover, int lod, float near) {
    float h = (length(p) - uShellBase) / (uShellTop - uShellBase);
    if (h < 0.0 || h > 1.0) return 0.0;
    float cov = cover * 0.92;                       // never fully closed: the deck keeps its pores
    if (cov < 0.02) return 0.0;
    vec3 q = uCloudMat * p;
    // Worley-led closed cells: values fall along cell walls, which opens a
    // natural pore network instead of blocky cut-outs.
    float base = textureLod(uNoise, q / 27000.0, 0.0).r;
    float wide = textureLod(uNoise, q.yzx / 63000.0 + 0.5, 0.0).r;
    float thick = textureLod(uNoise, q.zxy / 149000.0 + 0.37, 0.0).b;
    // Beyond ~170 km single cells are a few pixels: lean on the wider octave
    // so the far field reads as soft sheets, not confetti.
    base = lod > 0 ? base * 0.72 + wide * 0.28 : base * 0.35 + wide * 0.65;
    base = sat((base - 0.22) / 0.6);
    // Stratocumulus profile: rounded base, cloud-top height driven by the
    // slow thickness field and by each cell (cell cores bulge upward).
    float top = mix(0.5, 1.0, smoothstep(0.35, 0.75, thick)) * mix(0.55, 1.0, base);
    if (lod > 0) top *= 0.82 + 0.18 * textureLod(uNoise, q / 7300.0, 0.0).g;   // cauliflower tops
    float profile = smoothstep(0.0, 0.16, h) * smoothstep(top, top * 0.42, h);
    float d = sat(remap(base * profile, 1.0 - cov, 1.0, 0.0, 1.0));
    if (d <= 0.0) return 0.0;
    if (lod > 0) {
      // Erode only where the cloud is already thin; cores stay solid.
      float e = (1.0 - textureLod(uNoise, q / 7300.0, 0.0).g) * 0.34 * (1.0 - d);
      if (lod > 1) e += (1.0 - textureLod(uNoise, q.zxy / 1900.0 + 0.13, 0.0).g) * 0.26 * near * (1.0 - d);
      e = min(e, 0.9);
      d = sat((d - e) / (1.0 - e));
    }
    return d * cov * 1.25;
  }

  float hgPhase(float mu, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * mu, 1.5));
  }

  // Direct sunlight reaching a point above the ground, through the shared
  // optical-depth LUT (alpha = fraction of the solar path clear of the planet).
  vec3 sunAt(vec3 p, vec3 sunDirection) {
    float r = length(p);
    float altitude = clamp(r - uGroundR, 0.0, uTopAltitude);
    vec4 depth = sunlightOpticalDepth(altitude, dot(p / r, sunDirection));
    vec3 tau = (uBetaRayleigh * depth.r * uRayleighScaleHeight
      + uBetaMieExtinction * depth.g * uMieScaleHeight
      + uBetaOzone * depth.b * uOzoneHalfWidth) * uDensityScale;
    return exp(-min(tau, vec3(50.0))) * depth.a;
  }

  void main() {
    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
    gAux = vec4(40.0, 40.0, 0.0, 1.0);
    vec4 view = uInvProjection * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
    vec3 directionView = normalize(view.xyz / max(abs(view.w), 1e-6));
    vec3 directionWorld = normalize((uCameraWorld * vec4(directionView, 0.0)).xyz);
    vec3 rd = normalize((uWorldToLocal * vec4(directionWorld, 0.0)).xyz);
    vec3 ro = uCameraLocal;

    // Shell interval for a camera above, inside or below the layer.
    float r0 = length(ro), t0 = -1.0, t1 = -1.0;
    vec2 outer = shellHits(ro, rd, uShellTop), inner = shellHits(ro, rd, uShellBase);
    bool ground = shellHits(ro, rd, uGroundR - 3000.0).x > 0.0;
    if (r0 > uShellTop) { if (outer.y > 0.0) { t0 = max(outer.x, 0.0); t1 = inner.x > 0.0 ? inner.x : outer.y; } }
    else if (r0 > uShellBase) { t0 = 0.0; t1 = inner.x > 0.0 ? inner.x : outer.y; }
    else if (!ground) { t0 = inner.y; t1 = outer.y; }
    if (t1 <= t0) return;
    t1 = min(t1, t0 + 320000.0);
    float span = t1 - t0;

    // Coverage varies over tens of kilometres: five atlas samples along the
    // ray replace a full atlas lookup in every march and light step.
    float cover[5];
    float coverMax = 0.0;
    for (int i = 0; i < 5; i++) {
      cover[i] = coverageAt(ro + rd * (t0 + span * float(i) * 0.25));
      coverMax = max(coverMax, cover[i]);
    }
    if (coverMax < 0.03) return;

    vec3 sunDirection = normalize(uSunDirection0);
    vec3 irradiance = uSunColor0 * uSunEnergy0 * uRadianceScale;
    vec3 sunNear = sunAt(ro + rd * t0, sunDirection);
    vec3 sunFar = sunAt(ro + rd * t1, sunDirection);
    float mu = dot(rd, sunDirection);

    float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))) + uFrame * 0.61803);
    float dmin = max(min(min(50.0 + 0.004 * t0, span / 90.0), 300.0), 20.0);
    float t = t0 + dmin * jitter;
    float T = 1.0, weight = 0.0, weighted = 0.0, tFront = -1.0, tBack = t0;
    vec3 L = vec3(0.0);
    for (int i = 0; i < MARCH_STEPS; i++) {
      if (t > t1) break;
      float dt = max(dmin, 0.055 * (t - t0));
      vec3 p = ro + rd * t;
      float s = sat((t - t0) / span) * 4.0;
      int cell = int(min(floor(s), 3.0));
      float cov = mix(cover[cell], cover[cell + 1], s - float(cell));
      float near = sat(1.0 - t / 28000.0);
      float d = cov < 0.03 ? 0.0 : cloudDensity(p, cov, t > 170000.0 ? 0 : near > 0.0 ? 2 : 1, near);
      if (d > 0.002) {
        if (tFront < 0.0) tFront = t;
        float h = (length(p) - uShellBase) / (uShellTop - uShellBase);
        // Optical depth toward the sun: four growing steps.
        float tau = 0.0, ls = 320.0;
        vec3 pl = p;
        for (int j = 0; j < 4; j++) { pl += sunDirection * ls; tau += cloudDensity(pl, cov, 0, 0.0) * ls; ls *= 1.8; }
        tau *= uExtinction;
        // Multi-scattering octaves: each order loses extinction and
        // anisotropy. Gives silver linings and keeps thick cores from going black.
        float scatter = 0.0, a = 1.0;
        for (int k = 0; k < 4; k++) {
          scatter += a * exp(-tau * a) * mix(hgPhase(mu, 0.82 * a), hgPhase(mu, -0.25 * a), 0.28);
          a *= 0.48;
        }
        scatter *= mix(1.0, 1.0 - exp(-tau * 2.0 - d * 3.0), 0.35 * sat(0.5 - 0.5 * mu) + 0.15);
        vec3 sun = irradiance * mix(sunNear, sunFar, sat((t - t0) / span));
        float day = smoothstep(-0.12, 0.12, dot(normalize(p), sunDirection));
        vec3 ambient = irradiance * mix(vec3(0.012, 0.017, 0.028), vec3(0.045, 0.062, 0.095), h)
          * (0.55 + 0.45 * exp(-d * 2.5)) * (0.25 + 0.75 * day);
        vec3 source = (sun * scatter * uScatterGain + ambient) * uCloudTint;
        float Ti = exp(-d * uExtinction * dt);
        float w = T * (1.0 - Ti);
        L += w * source; weighted += w * t; weight += w;
        T *= Ti;
        tBack = t;
        if (T < 0.008) { T = 0.0; break; }
      }
      t += dt;
    }
    if (weight < 1e-4) return;

    // Air between the camera and the cloud. The scene behind already carries
    // its own full-path air, so only the cloud-covered fraction adds this.
    vec3 airRadiance, airTransmittance;
    airIntegrate(ro, rd, 0.0, weighted / weight, airRadiance, airTransmittance);
    gl_FragColor = vec4(airRadiance * (1.0 - T) + airTransmittance * L, T);
    gAux = vec4(log2(1.0 + tFront), log2(1.0 + max(tBack, tFront + 1.0)), 0.0, 1.0);
  }`;

const compositeShader = /* glsl */`
  precision highp float;
  uniform sampler2D tBase, tSceneDepth, tCloud, tCloudAux;
  uniform mat4 uInvProjection;
  uniform float uCameraFar;
  varying vec2 vUv;
  void main() {
    vec4 base = texture2D(tBase, vUv);
    vec4 cloud = texture2D(tCloud, vUv);
    float coverage = 1.0;
    float sceneDepth = texture2D(tSceneDepth, vUv).x;
    if (sceneDepth < 0.999999) {
      // Opaque geometry: keep the fraction of the cloud column in front of it.
      vec4 view = uInvProjection * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
      vec3 directionView = normalize(view.xyz / max(abs(view.w), 1e-6));
      float distance = (pow(uCameraFar + 1.0, sceneDepth) - 1.0) / max(-directionView.z, 0.0005);
      vec2 aux = texture2D(tCloudAux, vUv).xy;
      float front = exp2(aux.x) - 1.0, back = exp2(aux.y) - 1.0;
      coverage = smoothstep(front, max(back, front + 1.0), distance);
    }
    gl_FragColor = vec4(base.rgb * mix(1.0, cloud.a, coverage) + cloud.rgb * coverage, base.a);
  }`;

export class LiteCloudPass extends Pass {
  constructor(camera, atmospherePass, { scale = 0.5, steps = 96, maxPixels = 520000 } = {}) {
    super();
    this.camera = camera;
    this.atmospherePass = atmospherePass;
    this.scale = scale;
    this.maxPixels = maxPixels;
    this.activePlanet = null;
    this.visualEnabled = true;
    this.enabled = false;
    this.needsSwap = true;
    this.frame = 0;
    this.animateJitter = false;
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      count: 2, type: THREE.HalfFloatType, depthBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    this.target.textures[0].name = 'lite-cloud.radiance';
    this.target.textures[1].name = 'lite-cloud.depth-range';
    // Share the atmosphere pass's uniform objects: one camera/planet/sun state.
    this.marchMaterial = new THREE.ShaderMaterial({
      name: 'Lite cloud march',
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
      defines: { MARCH_STEPS: steps },
      uniforms: {
        ...atmospherePass.material.uniforms,
        uNoise: { value: null },
        uCloudTex: { value: null },
        uCloudMat: { value: new THREE.Matrix3() },
        uSynoptic: { value: 0 },
        uShellBase: { value: 1 },
        uShellTop: { value: 2 },
        uFrame: { value: 0 },
        uExtinction: { value: 0.0026 },
        // The four scattering octaves stand in for the many orders a thick cloud
        // really has; this gain restores a bright (albedo ~0.8) sunlit deck
        // against Lambert surfaces lit by the same irradiance.
        uScatterGain: { value: 3.6 },
        uCloudTint: { value: new THREE.Color(1, 1, 1) },
      },
      vertexShader, fragmentShader: marchShader,
    });
    this.compositeMaterial = new THREE.ShaderMaterial({
      name: 'Lite cloud composite',
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
      uniforms: {
        tBase: { value: null }, tSceneDepth: { value: null },
        tCloud: { value: this.target.textures[0] }, tCloudAux: { value: this.target.textures[1] },
        uInvProjection: this.marchMaterial.uniforms.uInvProjection,
        uCameraFar: this.marchMaterial.uniforms.uCameraFar,
      },
      vertexShader, fragmentShader: compositeShader,
    });
    this.marchQuad = new FullScreenQuad(this.marchMaterial);
    this.compositeQuad = new FullScreenQuad(this.compositeMaterial);
  }

  static supports(planet) {
    return Boolean(planet?.cloudShadowTex && planet.cloudMesh && planet.atmoMesh);
  }

  setVisualEnabled(enabled) {
    this.visualEnabled = Boolean(enabled);
    this.#refresh();
  }

  setQuality({ scale, steps } = {}) {
    if (Number.isFinite(scale)) this.scale = THREE.MathUtils.clamp(scale, 0.2, 1);
    if (Number.isInteger(steps) && steps !== this.marchMaterial.defines.MARCH_STEPS) {
      this.marchMaterial.defines.MARCH_STEPS = steps;
      this.marchMaterial.needsUpdate = true;
    }
  }

  setActivePlanet(planet) {
    const next = LiteCloudPass.supports(planet) ? planet : null;
    if (next !== this.activePlanet) {
      if (this.activePlanet) this.activePlanet.liteCloudActive = false;
      this.activePlanet = next;
      if (next) {
        const u = this.marchMaterial.uniforms;
        u.uNoise.value = liteCloudNoiseTexture();
        u.uSynoptic.value = next.weatherField?.synoptic ? 1 : 0;
        const floor = next.hasLiquid && Number.isFinite(next.seaLevel) ? Math.max(next.seaLevel, 0) : 0;
        const base = floor + THREE.MathUtils.clamp((next.hAmp || 0) * 0.25, 1500, 3500);
        u.uShellBase.value = next.R + base;
        u.uShellTop.value = next.R + base + 5200;
        u.uCloudTint.value.set(next.type === 'toxic' ? 0xc8e890 : 0xffffff);
        this.layerMeters = { base, top: base + 5200 };
      }
    }
    this.#refresh();
  }

  #refresh() {
    const planet = this.activePlanet;
    this.enabled = Boolean(planet && this.visualEnabled && planet.cloudVisualEnabled !== false);
    // The planet hides its analytic cloud decks while this pass draws them.
    if (planet) planet.liteCloudActive = this.enabled;
  }

  render(renderer, writeBuffer, readBuffer) {
    const planet = this.activePlanet;
    const u = this.marchMaterial.uniforms;
    u.uCloudTex.value = planet.cloudShadowTex;
    // Same inverse deck spin the terrain and water cloud shadows use.
    _matrix.makeRotationFromQuaternion(_quaternion.copy(planet.cloudMesh.quaternion).invert());
    u.uCloudMat.value.setFromMatrix4(_matrix);
    u.uFrame.value = this.animateJitter ? (this.frame = (this.frame + 1) % 64) : 0;

    const pixels = readBuffer.width * readBuffer.height;
    const scale = Math.min(this.scale, Math.sqrt(this.maxPixels / Math.max(1, pixels)));
    const width = Math.max(1, Math.round(readBuffer.width * scale));
    const height = Math.max(1, Math.round(readBuffer.height * scale));
    if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);

    renderer.setRenderTarget(this.target);
    this.marchQuad.render(renderer);

    const c = this.compositeMaterial.uniforms;
    c.tBase.value = readBuffer.texture;
    c.tSceneDepth.value = this.atmospherePass.sceneDepthTexture || readBuffer.depthTexture || null;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.compositeQuad.render(renderer);
  }

  releaseTargets() { this.target.dispose(); }

  dispose() {
    if (this.activePlanet) this.activePlanet.liteCloudActive = false;
    this.activePlanet = null;
    this.target.dispose();
    this.marchMaterial.dispose();
    this.compositeMaterial.dispose();
    this.marchQuad.dispose();
    this.compositeQuad.dispose();
  }
}
