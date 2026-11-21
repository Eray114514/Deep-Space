import * as THREE from 'three';
import { makeRng } from './rng.js';
import { OCEAN_ARCHETYPES } from './ocean-climate.js';

const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _refrSun = new THREE.Vector3();
const _shaftAxis = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _yAxis = new THREE.Vector3(0, 1, 0);

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(a, b, x) {
  const t = clamp((x - a) / Math.max(b - a, 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}

// Physical Beer-Lambert depth-graded underwater optics derived from the planet's
// ocean climate & sea-state archetype. Replaces the old flat fogDensity=0.03
// shortcut with sunlit turquoise reefs, deep sapphire mid-water, pitch abyssal
// trenches, and distinct toxic / mineral / lava signatures.
export function computeUnderwaterEnvironment(planet, {
  subDepth = 0,
  day = 1,
  sunset = 0,
} = {}) {
  const depth = Math.max(0, Number(subDepth) || 0);
  if (planet?.liquid === 'lava') {
    return {
      fogColor: [1.15, 0.24, 0.02],
      fogDensity: 0.18,
      sunTransmit: [0.15, 0.05, 0.01],
      hemiSky: [1.1, 0.32, 0.06],
      hemiGround: [0.35, 0.06, 0.01],
      hemiIntensity: 0.55,
      shaftStrength: 0,
      biolumGlow: 0,
      biolumColor: [1.0, 0.4, 0.05],
      scatterColor: [1.1, 0.28, 0.04],
      depthAttenuation: 1,
    };
  }

  const climate = planet?.oceanClimate;
  const archetype = climate?.archetype || 'temperate-swell';
  const seaState = climate?.seaState || OCEAN_ARCHETYPES[archetype] || OCEAN_ARCHETYPES['temperate-swell'];
  const abs = climate?.absorption || [0.16, 0.034, 0.016];
  const scatter = seaState.underwaterScatter || [0.025, 0.24, 0.42];
  const abyss = seaState.underwaterAbyss || [0.004, 0.022, 0.072];
  const biolumCol = seaState.biolumColor || [0.04, 0.85, 0.76];

  // Downwelling spectral transmission (red fades in ~6-12m, green ~25-45m, blue ~60-110m)
  const effectiveDepth = depth * (1.15 / Math.max(0.45, seaState.underwaterClarity || 1));
  const sunTransmit = [
    Math.exp(-abs[0] * effectiveDepth * 0.62),
    Math.exp(-abs[1] * effectiveDepth * 0.62),
    Math.exp(-abs[2] * effectiveDepth * 0.62),
  ];

  // Smooth transition from luminous sunlit epipelagic reef -> mesopelagic twilight -> abyss.
  // Keep linear chromaticity rich (low red relative to cyan/blue) so ACES Filmic
  // tone mapping preserves vivid turquoise-sapphire water rather than pale grey.
  const depthGrade = 1 - Math.exp(-effectiveDepth / 30);
  const lightLevel = 0.05 + 0.95 * clamp(day * 0.88 + sunset * 0.30, 0, 1);
  const sunsetTint = [
    lerp(1.0, 1.32, sunset * 0.60),
    lerp(1.0, 0.78, sunset * 0.50),
    lerp(1.0, 0.62, sunset * 0.60),
  ];

  const fogColor = [0, 1, 2].map((c) => {
    const chromaMul = c === 0 ? 0.42 : c === 1 ? 0.68 : 0.76;
    const shallowCol = scatter[c] * chromaMul * sunsetTint[c] * (0.45 + 0.65 * sunTransmit[c]);
    const deepCol = abyss[c] * 0.72;
    const col = lerp(shallowCol, deepCol, clamp(depthGrade * 0.92, 0, 1)) * lightLevel;
    return Math.max(0.0015, col);
  });

  // Visibility widens in clear shallow reefs and tightens smoothly into dark trenches
  const baseFog = seaState.underwaterFogDensity || 0.016;
  const fogDensity = clamp(baseFog * (0.95 + depthGrade * 0.85), 0.010, 0.072);

  const hemiSky = [0, 1, 2].map((c) => clamp(
    lerp(scatter[c] * 1.45, abyss[c] * 2.2, depthGrade) * (0.28 + 0.95 * day + 0.25 * sunset),
    0.008, 1.4,
  ));
  const hemiGround = [0, 1, 2].map((c) => clamp(
    abyss[c] * (0.45 + 0.75 * day),
    0.003, 0.4,
  ));
  const hemiIntensity = clamp(
    (0.14 + 0.52 * day + 0.16 * sunset) * lerp(1.0, 0.32, depthGrade),
    0.06, 0.78,
  );

  // Volumetric sunlit shafts peak in top 0.5..35m on clear sunny water
  const clarity = clamp(seaState.underwaterClarity || 1, 0.35, 1.6);
  const shaftStrength = clamp(
    day * clarity * (1 - smoothstep(18 * clarity, 52 * clarity, depth))
    * (1 - smoothstep(0.0, 0.65, sunset * 0.5)),
    0, 1.25,
  );

  const nightFactor = 1 - smoothstep(0.0, 0.26, day);
  const deepFactor = smoothstep(18, 70, depth);
  const isBiolum = climate?.composition === 'bioluminescent' || archetype === 'abyssal-biolum';
  const biolumGlow = isBiolum
    ? clamp(Math.max(nightFactor, deepFactor * 0.85) * 1.15, 0.12, 1.25)
    : clamp((climate?.biologicalActivity || 0) * Math.max(nightFactor * 0.45, deepFactor * 0.35), 0, 0.55);

  return {
    fogColor,
    fogDensity,
    sunTransmit,
    hemiSky,
    hemiGround,
    hemiIntensity,
    shaftStrength,
    biolumGlow,
    biolumColor: biolumCol,
    scatterColor: scatter,
    depthAttenuation: 1 - depthGrade,
  };
}

// Camera-local underwater marine snow / rising micro-bubbles, Snell-refracted
// sunlit light shafts, and surface skim / water-entry spray droplets.
// Pure-Node safe (no DOM/canvas calls) and zero GPU cost when inactive.
export class UnderwaterSystem {
  constructor({ snowCount = 520, shaftCount = 14, sprayCount = 160 } = {}) {
    this.group = new THREE.Group();
    this.group.name = 'underwater-effects';
    this.group.frustumCulled = false;
    this.disposed = false;
    this.time = 0;

    // ---- 1. GPU-wrapped underwater marine snow & rising micro-bubbles ------
    const rand = makeRng('underwater-marine-snow:v1');
    const snowBox = 34;
    const snowPos = new Float32Array(snowCount * 3);
    const snowMeta = new Float32Array(snowCount * 4); // x: size, y: bubble(0..1), z: phase, w: driftSpeed
    for (let i = 0; i < snowCount; i++) {
      snowPos[i * 3] = (rand() - 0.5) * snowBox;
      snowPos[i * 3 + 1] = (rand() - 0.5) * snowBox * 0.78;
      snowPos[i * 3 + 2] = (rand() - 0.5) * snowBox;
      const isBubble = rand() < 0.28 ? 1 : 0;
      snowMeta[i * 4] = isBubble ? (2.2 + rand() * 3.4) : (1.1 + rand() * 2.1);
      snowMeta[i * 4 + 1] = isBubble;
      snowMeta[i * 4 + 2] = rand() * Math.PI * 2;
      snowMeta[i * 4 + 3] = isBubble ? (0.45 + rand() * 0.85) : (0.06 + rand() * 0.16);
    }
    const snowGeo = new THREE.BufferGeometry();
    snowGeo.setAttribute('position', new THREE.BufferAttribute(snowPos, 3));
    snowGeo.setAttribute('aMeta', new THREE.BufferAttribute(snowMeta, 4));
    this.snowMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uBox: { value: new THREE.Vector3(snowBox, snowBox * 0.78, snowBox) },
        uScroll: { value: new THREE.Vector3() },
        uUp: { value: new THREE.Vector3(0, 1, 0) },
        uRight: { value: new THREE.Vector3(1, 0, 0) },
        uForward: { value: new THREE.Vector3(0, 0, 1) },
        uColor: { value: new THREE.Color(0.28, 0.72, 0.84) },
        uBiolumColor: { value: new THREE.Color(0.04, 0.94, 0.80) },
        uBiolumGlow: { value: 0 },
        uOpacity: { value: 0 },
        uPixelRatio: { value: 1 },
      },
      vertexShader: /* glsl */`
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute vec4 aMeta;
        uniform float uTime, uOpacity, uPixelRatio;
        uniform vec3 uBox, uScroll, uUp, uRight, uForward;
        varying float vAlpha;
        varying float vBubble;
        varying float vSpark;
        void main() {
          vec3 p = position - uScroll;
          // Bubbles rise gently along local up; marine snow sways lazily in current
          p.y += uTime * aMeta.w * mix(0.22, 1.0, aMeta.y);
          p.x += sin(uTime * 0.65 + aMeta.z) * 0.42;
          p.z += cos(uTime * 0.52 + aMeta.z * 1.37) * 0.42;
          // Wrap toroidally inside camera-local cube
          p = mod(p + uBox * 0.5, uBox) - uBox * 0.5;
          vec3 worldOffset = uRight * p.x + uUp * p.y + uForward * p.z;
          vec4 mvPosition = modelViewMatrix * vec4(worldOffset, 1.0);
          float dist = max(length(mvPosition.xyz), 0.6);
          float edgeFade = smoothstep(2.4, 5.2, dist) * (1.0 - smoothstep(uBox.x * 0.34, uBox.x * 0.49, dist));
          float pulse = 0.72 + 0.28 * sin(uTime * 2.2 + aMeta.z * 3.1);
          vAlpha = edgeFade * uOpacity * pulse;
          vBubble = aMeta.y;
          vSpark = fract(aMeta.z * 1.713);
          gl_PointSize = clamp(aMeta.x * uPixelRatio * (11.5 / dist), 1.2, 6.8);
          gl_Position = projectionMatrix * mvPosition;
          #include <logdepthbuf_vertex>
        }
      `,
      fragmentShader: /* glsl */`
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform vec3 uColor, uBiolumColor;
        uniform float uBiolumGlow;
        varying float vAlpha;
        varying float vBubble;
        varying float vSpark;
        void main() {
          vec2 uv = gl_PointCoord * 2.0 - 1.0;
          float r2 = dot(uv, uv);
          if (r2 > 1.0) discard;
          float r = sqrt(r2);
          // Micro-bubbles have a crisp specular rim + bright off-center glint;
          // marine snow is a soft bokeh mote.
          float mote = exp(-r2 * 3.8);
          float rim = smoothstep(0.42, 0.88, r) * (1.0 - smoothstep(0.88, 1.0, r));
          float spec = exp(-dot(uv - vec2(-0.32, -0.34), uv - vec2(-0.32, -0.34)) * 18.0);
          float shape = mix(mote * 0.62, rim * 0.68 + spec * 0.95 + mote * 0.22, vBubble);
          float bioSelect = smoothstep(0.45, 0.9, vSpark) * uBiolumGlow;
          vec3 col = mix(uColor, uBiolumColor * 1.65, clamp(bioSelect, 0.0, 1.0));
          float alpha = shape * vAlpha * mix(0.65, 1.25, bioSelect);
          if (alpha < 0.004) discard;
          gl_FragColor = vec4(col * alpha, alpha);
          #include <logdepthbuf_fragment>
        }
      `,
    });
    this.snowPoints = new THREE.Points(snowGeo, this.snowMat);
    this.snowPoints.frustumCulled = false;
    this.snowPoints.visible = false;
    this.snowPoints.renderOrder = 3;
    this.group.add(this.snowPoints);

    // ---- 2. Snell-refracted underwater sunlit god-ray curtains -------------
    this.shaftGroup = new THREE.Group();
    this.shaftGroup.frustumCulled = false;
    this.shaftGroup.visible = false;
    const shaftRand = makeRng('underwater-sun-shafts:v1');
    const shaftPositions = [];
    const shaftUvs = [];
    const shaftSeeds = [];
    const shaftIndices = [];
    for (let i = 0; i < shaftCount; i++) {
      const angle = (i / shaftCount) * Math.PI * 2 + (shaftRand() - 0.5) * 0.35;
      const dist = 5.5 + shaftRand() * 17.5;
      const cx = Math.cos(angle) * dist;
      const cz = Math.sin(angle) * dist;
      const width = 1.6 + shaftRand() * 3.4;
      const height = 26 + shaftRand() * 18;
      const yaw = shaftRand() * Math.PI;
      const dx = Math.cos(yaw) * width * 0.5;
      const dz = Math.sin(yaw) * width * 0.5;
      const topY = height * 0.58;
      const botY = -height * 0.42;
      const seedVal = shaftRand() * 6.28318;
      const base = i * 4;
      shaftPositions.push(
        cx - dx, botY, cz - dz,
        cx + dx, botY, cz + dz,
        cx + dx * 0.72, topY, cz + dz * 0.72,
        cx - dx * 0.72, topY, cz - dz * 0.72,
      );
      shaftUvs.push(0, 0, 1, 0, 1, 1, 0, 1);
      shaftSeeds.push(seedVal, seedVal, seedVal, seedVal);
      shaftIndices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    const shaftGeo = new THREE.BufferGeometry();
    shaftGeo.setAttribute('position', new THREE.Float32BufferAttribute(shaftPositions, 3));
    shaftGeo.setAttribute('uv', new THREE.Float32BufferAttribute(shaftUvs, 2));
    shaftGeo.setAttribute('aSeed', new THREE.Float32BufferAttribute(shaftSeeds, 1));
    shaftGeo.setIndex(shaftIndices);
    this.shaftMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(0.28, 0.78, 0.88) },
        uStrength: { value: 0 },
      },
      vertexShader: /* glsl */`
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute float aSeed;
        uniform float uTime;
        varying vec2 vUv;
        varying float vSeed;
        varying float vDistFade;
        void main() {
          vUv = uv;
          vSeed = aSeed;
          vec3 p = position;
          // Gentle horizontal wave refraction sway near the top of each shaft
          p.x += sin(uTime * 0.85 + aSeed + uv.y * 2.4) * 0.65 * uv.y;
          p.z += cos(uTime * 0.72 + aSeed * 1.4 - uv.y * 2.0) * 0.65 * uv.y;
          vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
          float d = length(mvPosition.xyz);
          vDistFade = smoothstep(2.0, 5.5, d) * (1.0 - smoothstep(20.0, 34.0, d));
          gl_Position = projectionMatrix * mvPosition;
          #include <logdepthbuf_vertex>
        }
      `,
      fragmentShader: /* glsl */`
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform float uTime, uStrength;
        uniform vec3 uColor;
        varying vec2 vUv;
        varying float vSeed;
        varying float vDistFade;
        void main() {
          // Soft horizontal beam envelope with animated multi-ribbon wave modulation
          float xEdge = sin(vUv.x * 3.14159265);
          float beam = pow(max(xEdge, 0.0), 2.2);
          float ribbon = 0.55 + 0.45 * sin(vUv.x * 11.0 + uTime * 1.4 + vSeed * 2.0)
            * cos(vUv.x * 6.5 - uTime * 0.95 + vSeed);
          // Brightest toward surface (vUv.y -> 1), tapering softly downward & fading at top cap
          float vert = smoothstep(0.0, 0.68, vUv.y) * (1.0 - smoothstep(0.88, 1.0, vUv.y));
          float shimmer = 0.65 + 0.35 * sin(uTime * 1.15 + vSeed * 3.1);
          float alpha = beam * ribbon * vert * shimmer * vDistFade * uStrength * 0.24;
          if (alpha < 0.002) discard;
          gl_FragColor = vec4(uColor * alpha, alpha);
          #include <logdepthbuf_fragment>
        }
      `,
    });
    this.shaftMesh = new THREE.Mesh(shaftGeo, this.shaftMat);
    this.shaftMesh.frustumCulled = false;
    this.shaftMesh.renderOrder = 3;
    this.shaftGroup.add(this.shaftMesh);
    this.group.add(this.shaftGroup);

    // ---- 3. Surface skim spray & water-entry splash droplets ---------------
    this.sprayCount = sprayCount;
    this.sprayCursor = 0;
    this.sprayPositions = new Float32Array(sprayCount * 3);
    this.sprayVelocities = new Float32Array(sprayCount * 3);
    this.sprayAges = new Float32Array(sprayCount);
    this.sprayLifetimes = new Float32Array(sprayCount);
    this.spraySizes = new Float32Array(sprayCount);
    this.sprayAges.fill(99);
    this.sprayLifetimes.fill(1);
    const sprayGeo = new THREE.BufferGeometry();
    sprayGeo.setAttribute('position', new THREE.BufferAttribute(this.sprayPositions, 3));
    sprayGeo.setAttribute('aLife', new THREE.BufferAttribute(new Float32Array(sprayCount), 1));
    sprayGeo.setAttribute('aSize', new THREE.BufferAttribute(this.spraySizes, 1));
    this.sprayMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      fog: false,
      uniforms: {
        uColor: { value: new THREE.Color(0.88, 0.95, 0.99) },
        uPixelRatio: { value: 1 },
      },
      vertexShader: /* glsl */`
        #include <common>
        #include <logdepthbuf_pars_vertex>
        attribute float aLife;
        attribute float aSize;
        uniform float uPixelRatio;
        varying float vLife;
        void main() {
          vLife = aLife;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          float dist = max(length(mvPosition.xyz), 0.5);
          gl_PointSize = aLife > 0.001 ? clamp(aSize * uPixelRatio * (26.0 / dist), 1.5, 42.0) : 0.0;
          gl_Position = projectionMatrix * mvPosition;
          #include <logdepthbuf_vertex>
        }
      `,
      fragmentShader: /* glsl */`
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform vec3 uColor;
        varying float vLife;
        void main() {
          if (vLife <= 0.001) discard;
          vec2 uv = gl_PointCoord * 2.0 - 1.0;
          float r2 = dot(uv, uv);
          if (r2 > 1.0) discard;
          float puff = exp(-r2 * 2.6) * (1.0 - r2);
          float alpha = puff * vLife * 0.52;
          if (alpha < 0.004) discard;
          gl_FragColor = vec4(uColor, alpha);
          #include <logdepthbuf_fragment>
        }
      `,
    });
    this.sprayPoints = new THREE.Points(sprayGeo, this.sprayMat);
    this.sprayPoints.frustumCulled = false;
    this.sprayPoints.visible = false;
    this.sprayPoints.renderOrder = 4;
    this.group.add(this.sprayPoints);
    this._sprayRand = makeRng('ocean-spray:v1');
    this._sprayAccum = 0;
  }

  // Emit a radial splash burst (e.g. diving into or emerging from water)
  emitSplash(originOffset, upDir, { count = 28, speed = 8, size = 3.8 } = {}) {
    if (this.disposed) return;
    _up.copy(upDir).normalize();
    _right.set(Math.abs(_up.y) < 0.9 ? 0 : 1, Math.abs(_up.y) < 0.9 ? 1 : 0, 0)
      .cross(_up).normalize();
    _forward.crossVectors(_up, _right).normalize();
    for (let k = 0; k < count; k++) {
      const idx = this.sprayCursor++ % this.sprayCount;
      const ang = this._sprayRand() * Math.PI * 2;
      const rad = 0.6 + this._sprayRand() * 2.4;
      const upSpeed = speed * (0.45 + this._sprayRand() * 0.9);
      const outSpeed = speed * (0.35 + this._sprayRand() * 0.75);
      const cx = Math.cos(ang), cz = Math.sin(ang);
      this.sprayPositions[idx * 3] = originOffset.x + (_right.x * cx + _forward.x * cz) * rad;
      this.sprayPositions[idx * 3 + 1] = originOffset.y + (_right.y * cx + _forward.y * cz) * rad;
      this.sprayPositions[idx * 3 + 2] = originOffset.z + (_right.z * cx + _forward.z * cz) * rad;
      this.sprayVelocities[idx * 3] = _up.x * upSpeed + (_right.x * cx + _forward.x * cz) * outSpeed;
      this.sprayVelocities[idx * 3 + 1] = _up.y * upSpeed + (_right.y * cx + _forward.y * cz) * outSpeed;
      this.sprayVelocities[idx * 3 + 2] = _up.z * upSpeed + (_right.z * cx + _forward.z * cz) * outSpeed;
      this.sprayAges[idx] = 0;
      this.sprayLifetimes[idx] = 0.65 + this._sprayRand() * 0.85;
      this.spraySizes[idx] = size * (0.6 + this._sprayRand() * 1.15);
    }
  }

  update({
    dt = 0,
    underwater = false,
    planet = null,
    subDepth = 0,
    day = 1,
    sunset = 0,
    upDir = null,
    sunDirWorld = null,
    cameraPosUniv = null,
    shipOffset = null,
    shipVel = null,
    waterContact = 0,
    pixelRatio = 1,
  } = {}) {
    if (this.disposed) return;
    const step = Math.min(Math.max(dt, 0), 0.1);
    this.time += step;

    const hasPlanetUp = Boolean(upDir && upDir.lengthSq() > 0.5);
    if (hasPlanetUp) _up.copy(upDir).normalize();
    else _up.set(0, 1, 0);
    _right.set(Math.abs(_up.y) < 0.9 ? 0 : 1, Math.abs(_up.y) < 0.9 ? 1 : 0, 0)
      .cross(_up).normalize();
    _forward.crossVectors(_up, _right).normalize();

    // ---- 1 & 2. Underwater marine snow + Snell-refracted sun shafts --------
    if (underwater && planet && planet.liquid !== 'lava') {
      const env = computeUnderwaterEnvironment(planet, { subDepth, day, sunset });
      this.snowPoints.visible = true;
      const su = this.snowMat.uniforms;
      su.uTime.value = this.time;
      su.uUp.value.copy(_up);
      su.uRight.value.copy(_right);
      su.uForward.value.copy(_forward);
      if (cameraPosUniv) {
        const box = su.uBox.value;
        su.uScroll.value.set(
          ((cameraPosUniv.dot(_right) % box.x) + box.x) % box.x,
          ((cameraPosUniv.dot(_up) % box.y) + box.y) % box.y,
          ((cameraPosUniv.dot(_forward) % box.z) + box.z) % box.z,
        );
      }
      su.uColor.value.setRGB(
        clamp(env.scatterColor[0] * 1.8 + 0.16, 0.12, 1.0),
        clamp(env.scatterColor[1] * 1.8 + 0.24, 0.18, 1.0),
        clamp(env.scatterColor[2] * 1.8 + 0.28, 0.22, 1.0),
      ).multiplyScalar(0.32 + 0.68 * day * env.depthAttenuation);
      su.uBiolumColor.value.setRGB(...env.biolumColor);
      su.uBiolumGlow.value = env.biolumGlow;
      su.uOpacity.value = clamp(0.42 + 0.45 * Math.max(day * env.depthAttenuation, env.biolumGlow), 0.2, 0.92);
      su.uPixelRatio.value = Math.max(1, pixelRatio);

      // Sunlit volumetric god-ray curtains tilted along Snell-refracted sun ray
      const showShafts = env.shaftStrength > 0.03 && sunDirWorld && sunDirWorld.dot(_up) > 0.04;
      this.shaftGroup.visible = showShafts;
      if (showShafts) {
        const sunElev = clamp(sunDirWorld.dot(_up), 0.04, 1);
        // Snell refraction bends incoming sunlight steeper toward vertical (n_air/n_water = 0.75)
        const sinIn = Math.sqrt(Math.max(0, 1 - sunElev * sunElev));
        const sinRefr = sinIn * 0.75;
        const cosRefr = Math.sqrt(Math.max(0.01, 1 - sinRefr * sinRefr));
        _refrSun.copy(sunDirWorld).addScaledVector(_up, -sunElev);
        if (_refrSun.lengthSq() > 1e-6) _refrSun.normalize().multiplyScalar(sinRefr);
        _shaftAxis.copy(_up).multiplyScalar(cosRefr).add(_refrSun).normalize();
        _q.setFromUnitVectors(_yAxis, _shaftAxis);
        this.shaftGroup.quaternion.copy(_q);

        const shu = this.shaftMat.uniforms;
        shu.uTime.value = this.time;
        shu.uStrength.value = env.shaftStrength * smoothstep(0.04, 0.24, sunElev);
        shu.uColor.value.setRGB(
          clamp(env.scatterColor[0] * 1.6 + 0.28, 0.2, 1.0),
          clamp(env.scatterColor[1] * 1.8 + 0.36, 0.35, 1.0),
          clamp(env.scatterColor[2] * 1.7 + 0.42, 0.4, 1.0),
        );
      }
    } else {
      this.snowPoints.visible = false;
      this.shaftGroup.visible = false;
    }

    // ---- 3. Surface skim spray & splash burst simulation -------------------
    if (!underwater && waterContact > 0.06 && shipOffset && shipVel && planet?.liquid !== 'lava') {
      const rate = 22 + waterContact * 55;
      this._sprayAccum += step * rate;
      const emitCount = Math.min(8, Math.floor(this._sprayAccum));
      this._sprayAccum -= emitCount;
      for (let k = 0; k < emitCount; k++) {
        const idx = this.sprayCursor++ % this.sprayCount;
        const side = (this._sprayRand() < 0.5 ? -1 : 1) * (2.6 + this._sprayRand() * 4.5);
        const back = -(2.0 + this._sprayRand() * 5.0);
        const velLen = Math.max(1, shipVel.length());
        const fx = shipVel.x / velLen, fy = shipVel.y / velLen, fz = shipVel.z / velLen;
        // Lateral axis perpendicular to ship velocity and planet up
        const sx = _up.y * fz - _up.z * fy;
        const sy = _up.z * fx - _up.x * fz;
        const sz = _up.x * fy - _up.y * fx;
        const sInv = 1 / Math.max(Math.hypot(sx, sy, sz), 1e-5);
        this.sprayPositions[idx * 3] = shipOffset.x + fx * back + sx * sInv * side - _up.x * 1.8;
        this.sprayPositions[idx * 3 + 1] = shipOffset.y + fy * back + sy * sInv * side - _up.y * 1.8;
        this.sprayPositions[idx * 3 + 2] = shipOffset.z + fz * back + sz * sInv * side - _up.z * 1.8;
        const lift = 3.5 + this._sprayRand() * 7.5 * waterContact;
        const spread = (this._sprayRand() - 0.5) * 6.0 + Math.sign(side) * (4.5 + this._sprayRand() * 5.0);
        this.sprayVelocities[idx * 3] = _up.x * lift + sx * sInv * spread - fx * (velLen * 0.25);
        this.sprayVelocities[idx * 3 + 1] = _up.y * lift + sy * sInv * spread - fy * (velLen * 0.25);
        this.sprayVelocities[idx * 3 + 2] = _up.z * lift + sz * sInv * spread - fz * (velLen * 0.25);
        this.sprayAges[idx] = 0;
        this.sprayLifetimes[idx] = 0.45 + this._sprayRand() * 0.65;
        this.spraySizes[idx] = (2.2 + this._sprayRand() * 3.8) * (0.65 + waterContact * 0.65);
      }
    }

    let alive = 0;
    const lifeAttr = this.sprayPoints.geometry.attributes.aLife;
    const posAttr = this.sprayPoints.geometry.attributes.position;
    const sizeAttr = this.sprayPoints.geometry.attributes.aSize;
    const gravity = Math.max(2, Math.min(25, planet?.gravity || 9.81));
    for (let i = 0; i < this.sprayCount; i++) {
      const age = this.sprayAges[i];
      const life = this.sprayLifetimes[i];
      if (age >= life) {
        lifeAttr.array[i] = 0;
        continue;
      }
      alive++;
      const nextAge = age + step;
      this.sprayAges[i] = nextAge;
      const t = clamp(nextAge / life, 0, 1);
      // Apply gravity + gentle drag in camera-relative space
      const drag = Math.exp(-step * 1.8);
      this.sprayVelocities[i * 3] = (this.sprayVelocities[i * 3] - _up.x * gravity * step) * drag;
      this.sprayVelocities[i * 3 + 1] = (this.sprayVelocities[i * 3 + 1] - _up.y * gravity * step) * drag;
      this.sprayVelocities[i * 3 + 2] = (this.sprayVelocities[i * 3 + 2] - _up.z * gravity * step) * drag;
      this.sprayPositions[i * 3] += this.sprayVelocities[i * 3] * step;
      this.sprayPositions[i * 3 + 1] += this.sprayVelocities[i * 3 + 1] * step;
      this.sprayPositions[i * 3 + 2] += this.sprayVelocities[i * 3 + 2] * step;
      lifeAttr.array[i] = Math.sin(t * Math.PI);
    }
    this.sprayPoints.visible = alive > 0;
    if (alive > 0) {
      const bright = 0.28 + 0.72 * clamp(day + sunset * 0.45, 0, 1);
      this.sprayMat.uniforms.uColor.value.setRGB(
        (0.86 + sunset * 0.14) * bright,
        (0.93 - sunset * 0.14) * bright,
        (0.98 - sunset * 0.28) * bright,
      );
      this.sprayMat.uniforms.uPixelRatio.value = Math.max(1, pixelRatio);
      posAttr.needsUpdate = true;
      lifeAttr.needsUpdate = true;
      sizeAttr.needsUpdate = true;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.snowPoints?.geometry?.dispose();
    this.snowMat?.dispose();
    this.shaftMesh?.geometry?.dispose();
    this.shaftMat?.dispose();
    this.sprayPoints?.geometry?.dispose();
    this.sprayMat?.dispose();
  }
}
