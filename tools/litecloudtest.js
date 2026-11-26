// Pure-Node contract tests for LiteCloudPass:
//  - History buffer resolution stays decoupled from adaptive march scale steps
//    so adaptive quality transitions never wipe temporal cloud history.
//  - Portal hand-off exchanges baseScale alongside temporal targets.
//  - Stratified raymarch progression covers full horizon & limb spans on all
//    quality tiers with bounded step spacing (zero 2x gaps, zero starvation).
//  - Shader sources retain step-aware bandlimiting, slant-aware cirrus LOD,
//    Catmull-Rom history reconstruction, and foreground depth dilation.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { LiteCloudPass } from '../src/cloud/lite-cloud-pass.js';
import { QUALITY_PROFILES } from '../src/graphics-settings.js';

function makeStubAtmosphere() {
  return {
    material: {
      uniforms: {
        uCameraLocal: { value: new THREE.Vector3(0, 1205400, 0) },
        uCameraFar: { value: 1e10 },
        uInvProjection: { value: new THREE.Matrix4() },
        uCameraWorld: { value: new THREE.Matrix4() },
        uWorldToLocal: { value: new THREE.Matrix4() },
        uSunDirection0: { value: new THREE.Vector3(0.4, 0.8, 0.4).normalize() },
        uSunColor0: { value: new THREE.Color(1, 1, 1) },
        uSunEnergy0: { value: 1 },
        uSunDirection1: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor1: { value: new THREE.Color(1, 1, 1) },
        uSunEnergy1: { value: 0 },
        uRadianceScale: { value: 3.2 },
        uGroundR: { value: 1200000 },
        uTopAltitude: { value: 126000 },
        uTopR: { value: 1326000 },
        uRayleighScaleHeight: { value: 8500 },
        uMieScaleHeight: { value: 1200 },
        uOzoneCenter: { value: 25000 },
        uOzoneHalfWidth: { value: 15000 },
        uBetaRayleigh: { value: new THREE.Vector3(5.8e-6, 1.35e-5, 3.31e-5) },
        uBetaMieScatter: { value: new THREE.Vector3(2.1e-5, 2.1e-5, 2.1e-5) },
        uBetaMieExtinction: { value: new THREE.Vector3(2.3e-5, 2.3e-5, 2.3e-5) },
        uBetaOzone: { value: new THREE.Vector3(0.65e-6, 1.88e-6, 0.085e-6) },
        uMieAsymmetry: { value: 0.78 },
        uDensityScale: { value: 1 },
        tOpticalDepth: { value: null },
        tMultipleScattering: { value: null },
        uMultipleEnabled: { value: 0 },
        uLocalOccluderCount: { value: 0 },
        uEclipseEnabled: { value: 0 },
      },
    },
    profileState: { profile: { topAltitudeMeters: 65000 } },
    sceneDepthTexture: null,
  };
}

function makeStubPlanet() {
  const atlas = { width: 2, height: 2, data: new Uint8Array(16).fill(180), scale: 255 };
  const tex = new THREE.DataTexture(new Uint8Array(16).fill(180), 2, 2);
  tex.userData.weatherAtlas = atlas;
  return {
    R: 1200000,
    type: 'lush',
    hAmp: 8000,
    hasLiquid: true,
    seaLevel: 0,
    cloudSpin: 0.1,
    weatherHours: 10.5,
    cloudShadowTex: tex,
    cloudWeatherHiTex: tex,
    cloudMesh: { quaternion: new THREE.Quaternion() },
    atmoMesh: {},
    weatherField: {
      synoptic: true,
      surfaceRangeMeters: 8000,
      surfaceBoundsMeters: [-2000, 6000],
      surfaceAt: () => 500,
    },
  };
}

// 1. Adaptive march-scale adjustments must keep history size and historyValid intact.
{
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 1, 1e10);
  const atmo = makeStubAtmosphere();
  const planet = makeStubPlanet();
  const pass = new LiteCloudPass(camera, atmo, { scale: 0.5, steps: 96, maxPixels: 940000 });
  pass.setActivePlanet(planet);
  pass.shadowsEnabled = false;
  pass.targetTypeChosen = true;

  const renderer = {
    extensions: { has: () => true },
    setRenderTarget() {},
    render() {},
  };
  pass.marchQuad.render = () => {};
  pass.resolveQuad.render = () => {};
  pass.compositeQuad.render = () => {};
  const readBuffer = { width: 1280, height: 720, texture: null, depthTexture: null };
  const writeBuffer = { width: 1280, height: 720, texture: null, depthTexture: null };

  // First two frames build history at 1280x720 (baseScale 0.5 * ratio 2 = 1.0)
  pass.render(renderer, writeBuffer, readBuffer);
  pass.render(renderer, writeBuffer, readBuffer);
  assert.equal(pass.target.width, 640);
  assert.equal(pass.target.height, 360);
  assert.equal(pass.history[0].width, 1280);
  assert.equal(pass.history[0].height, 720);
  assert.equal(pass.historyValid, true);
  assert.equal(pass.resolveMaterial.uniforms.uHistoryWeight.value, 1);

  // Adaptive downgrade to 0.44 and 0.38 then recovery back to 0.50:
  // march target resizes, but history NEVER resizes and uHistoryWeight stays 1!
  for (const nextScale of [0.44, 0.38, 0.44, 0.50]) {
    pass.setQuality({ scale: nextScale });
    pass.render(renderer, writeBuffer, readBuffer);
    assert.equal(pass.target.width, Math.round(1280 * nextScale));
    assert.equal(pass.history[0].width, 1280, `history width must not shrink at scale=${nextScale}`);
    assert.equal(pass.history[0].height, 720, `history height must not shrink at scale=${nextScale}`);
    assert.equal(pass.historyValid, true);
    assert.equal(pass.resolveMaterial.uniforms.uHistoryWeight.value, 1,
      `history must stay continuous across adaptive scale=${nextScale}`);
  }

  // Adaptive DPR resize (changing readBuffer dimensions while keeping framing):
  // single-buffer history resize preserves uHistoryWeight=1 with zero wipe!
  for (const [w, h] of [[1152, 648], [1088, 612], [1280, 720], [1280, 720]]) {
    const rb = { width: w, height: h, texture: null, depthTexture: null };
    const wb = { width: w, height: h, texture: null, depthTexture: null };
    pass.render(renderer, wb, rb);
    assert.equal(pass.historyValid, true, `history must stay valid across DPR resize ${w}x${h}`);
    assert.equal(pass.resolveMaterial.uniforms.uHistoryWeight.value, 1,
      `history must resample seamlessly without reset on DPR resize ${w}x${h}`);
  }
  assert.equal(pass.history[0].width, 1280);
  assert.equal(pass.history[1].width, 1280);

  // CPU weatherSampleAt stays finite and bounded
  const sample = pass.weatherSampleAt(new THREE.Vector3(0, 1205400, 0));
  assert.ok(sample && Number.isFinite(sample.cloudBaseAlt) && sample.cover >= 0 && sample.cover <= 1);

  // Portal hand-off preserves baseScale
  const other = new LiteCloudPass(camera, atmo, { scale: 0.42, steps: 80, maxPixels: 400000 });
  pass.setQuality({ baseScale: 0.50, scale: 0.38 });
  other.setQuality({ baseScale: 0.42, scale: 0.42 });
  pass.exchangeTemporalState(other);
  assert.equal(pass.baseScale, 0.42);
  assert.equal(other.baseScale, 0.50);

  pass.dispose();
  other.dispose();
}

// 2. Stratified step progression reaches the full span on every preset with no 2x gaps.
{
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const smoothstep = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const scenarios = [
    { name: 'low-horizon-220km', t0: 0, span: 220000 },
    { name: 'high-horizon-320km', t0: 15000, span: 320000 },
    { name: 'orbit-limb-650km', t0: 250000, span: 650000 },
    { name: 'orbit-nadir-14km', t0: 150000, span: 14000 },
    { name: 'near-zenith-11km', t0: 2000, span: 11000 },
  ];
  for (const profile of Object.values(QUALITY_PROFILES)) {
    const MARCH_STEPS = profile.liteClouds.steps;
    for (const sc of scenarios) {
      const reach = clamp(sc.span / 55000, 1, 2);
      let baseSteps = MARCH_STEPS;
      if (MARCH_STEPS === 56) baseSteps += 40 * smoothstep(10000, 40000, sc.span);
      const steps = Math.floor(baseSteps * reach);
      const dmin = Math.max(Math.min(Math.min(44 + 0.0025 * sc.t0, sc.span / 80), 300), 20);
      const growth = Math.max(0.048, 8.6 / steps);
      const dtCap = Math.max(dmin, (1.42 + 0.34 * reach) * sc.span / steps);
      const t1 = sc.t0 + sc.span;
      for (const jitter of [0.05, 0.5, 0.95]) {
        let t = sc.t0, prevTs = null, maxRatio = 0;
        for (let i = 0; i < Math.max(MARCH_STEPS, 96) * 2; i++) {
          if (i >= steps || t >= t1) break;
          const baseDt = clamp(growth * (t - sc.t0), dmin, dtCap);
          const dt = Math.min(baseDt, t1 - t);
          const ts = t + dt * jitter;
          if (prevTs !== null && dt === baseDt) {
            maxRatio = Math.max(maxRatio, (ts - prevTs) / Math.max(dt, 1e-3));
          }
          prevTs = ts;
          t += dt;
        }
        assert.ok(t >= t1 - 1, `${profile.id}/${sc.name} starved before t1: reached ${t} of ${t1}`);
        assert.ok(maxRatio < 1.12, `${profile.id}/${sc.name} exceeded 1-step spacing: maxRatio=${maxRatio}`);
      }
    }
  }
}

// 3. Structural shader invariants in src/cloud/lite-cloud-pass.js.
{
  const src = await readFile(new URL('../src/cloud/lite-cloud-pass.js', import.meta.url), 'utf8');
  assert.ok(src.includes('sampleHistoryCatmullRom('), 'resolve shader must use Catmull-Rom history reconstruction');
  assert.ok(src.includes('result = clamp(result, tapMin, tapMax);'), 'Catmull-Rom history must clamp to 5-tap convex hull');
  assert.ok(src.includes('float gStepFilter = 0.0;'), 'cloud density must support step-aware bandlimiting');
  assert.ok(src.includes('float cirrusFootprint = cirrusT * uPixelAngle / max(slant'), 'cirrus must use slant-aware mip LOD');
  assert.ok(src.includes('float ts = t + dt * jitter;'), 'cumulus march must use 1-step stratified phase everywhere');
  assert.ok(src.includes('uFrame * 0.40450850'), 'temporal jitter phase must advance by golden ratio per 4-frame quadrant cycle');
  assert.ok(!src.includes('smoothstep(2500.0, 5000.0, dt)'), 'abrupt 2500-5000m step-dither pop-in must remain removed');
}

console.log('PASS: LiteCloudPass history decoupling, stratified march coverage, and shader anti-aliasing contracts');
