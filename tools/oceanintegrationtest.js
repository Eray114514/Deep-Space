import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const out = 'test-results/ocean-integration';
await mkdir(out, { recursive: true });
const fingerprint = await evidenceFingerprint('tools/oceanintegrationtest.js');
const { server, port } = await startServer(0);
const browser = await launchHardwareBrowser({ headless: true });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 },
  recordVideo: { dir: out, size: { width: 1920, height: 1080 } } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
try {
  await page.goto(`http://127.0.0.1:${port}/?quality=ultra&nohero=1&post=1&vclouds=1&farflora=1&buildms=80`);
  await page.waitForFunction(() => window.NMS?.booted, null, { timeout: 90000 });
  const fixture = await page.evaluate(() => {
    NMS.setWade(0, { depth: 0.9, overview: false, look: 'sea' });
    NMS.setLocalSunAltitude(0, 34);
    return NMS.waterState(0);
  });
  await page.waitForFunction(() => {
    const water = NMS.waterState(0);
    return water?.near?.visible && !water.near.pending && water.global.pending === 0;
  }, null, { timeout: 150000 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => NMS.resetPerformanceStats());
  await page.waitForTimeout(10000);
  await page.screenshot({ path: `${out}/01-shallow-eye-player.png` });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${out}/02-shallow-eye-moving.png` });
  const state = await page.evaluate(() => ({ stats: NMS.stats(), water: NMS.waterState(0) }));
  if (process.env.OCEAN_DIAGNOSTIC === '1') {
    await page.evaluate(() => NMS.setTimeFrozen(true));
    const capturePrograms = async (name) => {
      const programs = await page.evaluate(() => {
        const p = NMS._planet(0);
        const material = p.nearWaterPatch.mesh.material;
        const properties = NMS._renderer.properties.get(material);
        const gl = NMS._renderer.getContext();
        return { material: material.toJSON(), programs: [...(properties.programs?.values() || [])].map((program) => ({
          key: program.cacheKey,
          vertex: gl.getShaderSource(program.vertexShader),
          fragment: gl.getShaderSource(program.fragmentShader),
        })) };
      });
      await writeFile(`${out}/diagnostic-program-${name}.json`, JSON.stringify(programs, null, 2));
    };
    await capturePrograms('production');
    const shader = await page.evaluate(() => {
      const p = NMS._planet(0);
      const s = p.liquidMat.userData.shader;
      return { vertex: s.vertexShader, fragment: s.fragmentShader,
        uniforms: Object.fromEntries(Object.entries(s.uniforms).filter(([key]) =>
          ['uOceanHeight', 'uOceanNormalization', 'uNearPatchRadius', 'uDay', 'uSkyZenith', 'uSkyHorizon', 'uRippleCount'].includes(key))) };
    });
    await writeFile(`${out}/diagnostic-shader.json`, JSON.stringify(shader, null, 2));
    for (const mode of ['identity', 'grey-floor', 'floor-only', 'floor-radial-normal', 'floor-unlit',
      'floor-no-scan', 'floor-radial-albedo', 'floor-fixed-mip', 'floor-base-only', 'floor-fixed-height',
      'floor-constant', 'floor-no-ripples']) {
      await page.evaluate((mode) => {
        const p = NMS._planet(0);
        const terrain = p.terrainMaterial;
        terrain.userData.diagnosticCompile ||= terrain.onBeforeCompile;
        terrain.onBeforeCompile = (shader) => {
          terrain.userData.diagnosticCompile(shader);
          const replaceRequired = (from, to) => {
            if (!shader.fragmentShader.includes(from)) throw new Error(`Missing ${mode} shader diagnostic target: ${from}`);
            shader.fragmentShader = shader.fragmentShader.replace(from, to);
          };
          if (mode === 'floor-no-scan') replaceRequired(
            'float pbrNear = 1.0 - smoothstep(70.0, 720.0, length(vViewPosition));', 'float pbrNear = 0.0;');
          if (mode === 'floor-radial-albedo') {
            const from = 'normalize(vLocalNrm)';
            if (!shader.fragmentShader.includes(from)) throw new Error('Missing radial albedo diagnostic target.');
            shader.fragmentShader = shader.fragmentShader.replaceAll(from, 'normalize(vLocalPos)');
          }
          if (mode === 'floor-fixed-mip') {
            // Only triDetail's three lookups change; PBR/other texture paths
            // retain production sampling. Fixed LOD is attribution, not a fix.
            for (const axis of ['yz', 'zx', 'xy']) replaceRequired(
              `texture2D(uDetailTex, q.${axis}).rg`, `textureLod(uDetailTex, q.${axis}, 4.0).rg`);
          }
          const fixedHeight = mode === 'floor-fixed-height' || mode === 'floor-no-ripples';
          const baseOnly = mode === 'floor-base-only' || fixedHeight;
          if (fixedHeight) replaceRequired(
            'float hgt = vSurfaceHeight;', 'float hgt = uT0 - 1.0;');
          if (mode === 'floor-no-ripples') replaceRequired(
            'float rippleBars = smoothstep(0.28, 0.72,\n              triDetail(terrainDetailPosition(), seaW, terrainRipple, 1));',
            'float rippleBars = 0.5;');
          if (baseOnly) {
            replaceRequired('#include <common>', '#include <common>\nvec3 diagnosticBaseAlbedo = vec3(0.0);');
            replaceRequired('diffuseColor.rgb = base;', 'diffuseColor.rgb = base; diagnosticBaseAlbedo = base;');
          }
          // These albedo modes compare against floor-unlit. This prevents
          // changes in normal/roughness lighting from obscuring albedo causes.
          if (['floor-no-scan', 'floor-radial-albedo', 'floor-fixed-mip'].includes(mode) || baseOnly) {
            replaceRequired('#include <opaque_fragment>',
              `outgoingLight = ${baseOnly ? 'diagnosticBaseAlbedo' : 'diffuseColor.rgb'};\n#include <opaque_fragment>`);
          }
          if (mode === 'grey-floor') shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>',
            'outgoingLight = vec3(0.3);\n#include <opaque_fragment>');
          // Unlike grey-floor, the floor- prefix also hides the sea below.
          if (mode === 'floor-constant') replaceRequired('#include <opaque_fragment>',
            'outgoingLight = vec3(0.3);\n#include <opaque_fragment>');
          if (mode === 'floor-unlit') shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>',
            'outgoingLight = diffuseColor.rgb;\n#include <opaque_fragment>');
          if (mode === 'floor-radial-normal') shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_fragment>',
            'normal = normalize(vRadialView);\n#include <lights_physical_fragment>');
        };
        terrain.customProgramCacheKey = () => `diagnostic-terrain-${mode}`;
        terrain.needsUpdate = true;
        p.liquidMat.visible = !mode.startsWith('floor-');
        p.nearWaterPatch.mesh.receiveShadow = true;
        const material = p.liquidMat.clone();
        // Current diagnostics only vary terrain; preserve the production water
        // compile callback on its identity clone for comparable captures.
        material.onBeforeCompile = (shader) => p.liquidMat.onBeforeCompile(shader);
        material.onBeforeRender = p.liquidMat.onBeforeRender;
        material.customProgramCacheKey = () => `diagnostic-${mode}`;
        p.nearWaterPatch.mesh.material = material;
      }, mode);
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${out}/diagnostic-${mode}.png` });
      if (mode === 'identity') await capturePrograms(mode);
    }
    await page.evaluate(() => {
      const p = NMS._planet(0);
      p.liquidMat.visible = true;
      p.nearWaterPatch.mesh.material = p.liquidMat;
      p.nearWaterPatch.mesh.receiveShadow = true;
      p.terrainMaterial.onBeforeCompile = p.terrainMaterial.userData.diagnosticCompile;
      p.terrainMaterial.customProgramCacheKey = () => 'diagnostic-terrain-restored';
      p.terrainMaterial.needsUpdate = true;
    });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${out}/diagnostic-restored-production.png` });
    await page.evaluate(() => {
      const planet = NMS._planet(0);
      planet.nearWaterPatch.mesh.material = new NMS._THREE.MeshBasicMaterial({ color: 0xff0033, side: NMS._THREE.DoubleSide });
    });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${out}/diagnostic-patch-coverage.png` });
    await page.evaluate(() => NMS.setAtmosphereVisible(false));
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${out}/diagnostic-patch-no-atmosphere.png` });
  }
  assert.deepEqual(errors, [], errors.join('\n'));
  assert.equal(state.stats.rendererBackend, 'webgl2');
  assert.ok(state.water.ocean?.significantHeight > 0);
  await writeFile(`${out}/report.json`, JSON.stringify({ ...fingerprint, fixture, state, errors }, null, 2));
  console.log(JSON.stringify({ status: 'runtime-pass', ocean: state.water.ocean, gpu: state.stats.gpu }));
} finally {
  await context.close();
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
