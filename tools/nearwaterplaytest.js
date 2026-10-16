// Real-input near-water traversal. GPU execution must be serialized externally.
// CPU triangle reconstruction below is attribution, NOT GPU pixel/depth parity.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser,resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const out = `test-results/near-water-player/${new Date().toISOString().replace(/[:.]/g, '-')}`;
const caps = process.env.NEAR_WATER_FPS ? [Number(process.env.NEAR_WATER_FPS)] : [60, 30];
const volumeClouds=process.env.NEAR_WATER_VCLOUDS!=='0';
const reference=process.env.NEAR_WATER_REFERENCE||null;
const browserChoice=process.env.NEAR_WATER_BROWSER||'bundled';
assert.ok(caps.every((fps) => [30, 60].includes(fps)));
await mkdir(out, { recursive: true });
const fingerprint = await evidenceFingerprint('tools/nearwaterplaytest.js');
const { server, port } = await startServer(0);
const browser = await launchHardwareBrowser({ headless: true,
  executablePath:browserChoice==='system'?resolveSystemChromePath()||undefined:undefined });
const evidence = { ...fingerprint, volumeClouds, reference, browserChoice, boundary: 'Normal HUD/post and real flight inputs after initial QA pose. '
  + 'CPU reconstruction of committed mesh attributes is not GPU raster/depth readback. '
  + 'RAF cap limits maximum presentation rate; actual frame times and speeds are measured, never assumed.', runs: [] };
try {
  for (const fps of caps) {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 },
      recordVideo: { dir: out, size: { width: 1920, height: 1080 } } });
    const page = await context.newPage();
    if(reference) {
      const source=execFileSync('git',['show',`${reference}:src/near-water-patch.js`],{encoding:'utf8'})
        +`\nNearWaterPatch.prototype.preferredBudget=function(altitude,dt=1/60) {
          return this.adaptiveLowBudget&&altitude<this.lowAltitude
            ?THREE.MathUtils.clamp(240*(Number.isFinite(dt)&&dt>0?dt:1/60),4,8):this.baseBuildBudgetMs;
        };\n`;
      await page.route('**/src/near-water-patch.js',route=>route.fulfill({contentType:'text/javascript',body:source}));
    }
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    try {
      await page.addInitScript((cap) => {
        const nativeRAF = window.requestAnimationFrame.bind(window);
        const nativeCancel = window.cancelAnimationFrame.bind(window);
        const requests = new Map();
        let serial = 0, lastFrame = -Infinity, scheduled = null;
        window.__nearFrameIntervals = [];
        const tick = (time) => {
          scheduled = null;
          if (time - lastFrame >= 1000 / cap - 0.5) {
            if (Number.isFinite(lastFrame)) window.__nearFrameIntervals.push(time - lastFrame);
            lastFrame = time;
            // All callbacks due in one frame receive one timestamp. A global
            // single-callback throttle could starve secondary RAF consumers.
            const due = [...requests.entries()];
            for (const [token, callback] of due) {
              if (!requests.has(token)) continue;
              requests.delete(token);
              callback(time);
            }
          }
          if (requests.size && scheduled == null) scheduled = nativeRAF(tick);
        };
        window.requestAnimationFrame = (callback) => {
          const token = ++serial;
          requests.set(token, callback);
          if (scheduled == null) scheduled = nativeRAF(tick);
          return token;
        };
        window.cancelAnimationFrame = (token) => {
          requests.delete(token);
          if (!requests.size && scheduled != null) { nativeCancel(scheduled); scheduled = null; }
        };
      }, fps);
      await page.goto(`http://127.0.0.1:${port}/?quality=ultra&nohero=1&nolock=1&post=1&vclouds=${Number(volumeClouds)}&farflora=1`);
      await page.waitForFunction(() => window.NMS?.booted, null, { timeout: 120000 });
      await page.evaluate(() => {
        const p = NMS._planet(0);
        // Accelerate only the unmeasured initial QA placement. Restore the
        // production build budget before any real-input traversal samples.
        NMS.setBuildBudget(80);
        NMS.teleport(0, (p.seaLevel + 40) / p.R,
          { dir: [0.34669147556655305, 0.07291666666666663, -0.9351407276403421], horizon: true, pitch: 0 });
        NMS.setLocalSunAltitude(0, 32);
        NMS.shipViewDebug.setViewMode('chase');
      });
      await page.waitForFunction(() => {
        const water = NMS.waterState(0);
        return water?.near?.visible && !water.near.pending && water.global.pending === 0;
      }, null, { timeout: 180000 });
      await page.evaluate(async () => {
        NMS.setBuildBudget(0);
        const { oceanSeconds } = await import('/src/ocean-clock.js');
        const T = NMS._THREE;
        const p = NMS._planet(0), { nav } = NMS._internals;
        // Last and only velocity assignment: every subsequent change is flight physics/input.
        const initialForward = new T.Vector3(0, 0, -1).applyQuaternion(nav.quat);
        nav.vel.copy(initialForward).multiplyScalar(150);
        const initialLocalForward = p.worldOffsetToLocal(initialForward).normalize();
        window.__nearSample = () => {
          const samplingStarted = performance.now();
          const { camera, spaceCtl } = NMS._internals;
          const patch = p.nearWaterPatch, mesh = patch.mesh;
          const local = p.worldPositionToLocal(nav.pos.clone().add(camera.position));
          const direction = local.clone().normalize();
          const center = patch.centerDirection;
          const result = { time: performance.now(), state: NMS.state, speed: nav.vel.length(),
            altitude: local.length() - p.seaRadius, position: local.toArray(),
            actualTurnDeg: initialLocalForward.angleTo(p.worldOffsetToLocal(
              new T.Vector3(0, 0, -1).applyQuaternion(nav.quat)).normalize()) * 180 / Math.PI,
            control: { throttle: spaceCtl.throttleInput, steer: { ...spaceCtl.steerInput },
              forwardSpeed: nav.vel.dot(new T.Vector3(0, 0, -1).applyQuaternion(nav.quat)),
              wheelGain: 0.012 * (1 - spaceCtl.atmosphereFactor * 0.55)
                * spaceCtl.speedScale * spaceCtl.gravityPower },
            patch: patch.debugStats(), samples: [] };
          if (!center || !mesh.visible) return result;
          result.actualAnchorOffset = direction.angleTo(center) * p.seaRadius;
          const tangent = new T.Vector3().crossVectors(center, Math.abs(center.y) < 0.92
            ? new T.Vector3(0, 1, 0) : new T.Vector3(1, 0, 0)).normalize();
          const bitangent = new T.Vector3().crossVectors(center, tangent).normalize();
          const position = mesh.geometry.getAttribute('position');
          const localAttribute = mesh.geometry.getAttribute('aLocal');
          const depth = mesh.geometry.getAttribute('aDepth');
          const cells = mesh.geometry.getAttribute('aWaterCell');
          const morph = mesh.geometry.getAttribute('aLodMorph');
          const nearPass = mesh.geometry.getAttribute('aNearPatchPass');
          if (mesh.quaternion.angleTo(new T.Quaternion()) > 1e-12
            || mesh.scale.distanceTo(new T.Vector3(1, 1, 1)) > 1e-12)
            throw new Error('Near mesh has a non-translation transform; update reconstruction');
          const uniforms = mesh.material.userData.waterUniforms;
          if (!uniforms?.uOceanTime) throw new Error('Missing authoritative water draw uniforms');
          const seconds = uniforms.uOceanTime.value;
          const hs = uniforms.uOceanHeight.value;
          const hours = p.weatherHours;
          result.clock = { oceanSeconds: seconds, weatherHours: hours,
            secondsDifference: seconds - oceanSeconds(hours) };
          result.centerUniformError = mesh.position.distanceTo(uniforms.uNearPatchCenter.value);
          if (result.centerUniformError > 1e-8 || Math.abs(result.clock.secondsDifference) > 1e-8)
            throw new Error('Committed mesh centre or water draw clock is not synchronized');
          const indexBuffer = mesh.geometry.index;
          const vertexCache = new Map();
          const waveFilter = (k, footprint) => {
            const t = T.MathUtils.clamp((footprint * k / (Math.PI * 2) - 0.125) * 8, 0, 1);
            return 1 - t * t * (3 - 2 * t);
          };
          const displacedVertex = (k) => {
            if (vertexCache.has(k)) return vertexCache.get(k);
            if (morph.getX(k) !== 0 || nearPass.getX(k) !== 1)
              throw new Error('Reconstruction requires committed non-morphing near-pass vertices');
            const meshRelative = new T.Vector3().fromBufferAttribute(position, k);
            const relative = meshRelative.clone().add(mesh.position)
              .sub(mesh.material.userData.oceanSamplingAnchor || mesh.position);
            const authored = new T.Vector3().fromBufferAttribute(localAttribute, k);
            const up = authored.clone().normalize();
            const footprint = Math.max(4, cells.getX(k));
            let wave = 0;
            // Evaluate the actual draw's reduced phases/modes, not a separately
            // reconstructed seed/time field. Arithmetic remains JS double.
            for (let modeIndex = 0; modeIndex < uniforms.uOceanModes.value.length; modeIndex++) {
              const mode = uniforms.uOceanModes.value[modeIndex];
              const phaseData = uniforms.uOceanPhases.value[modeIndex];
              const phase = mode.w * (relative.x * mode.x + relative.y * mode.y + relative.z * mode.z) + phaseData.x;
              wave += (waveFilter(mode.w, footprint) * Math.sin(phase)
                + 0.22 * waveFilter(2 * mode.w, footprint) * Math.sin(2 * phase)) * phaseData.y;
            }
            wave *= Math.max(0, hs) * uniforms.uOceanNormalization.value;
            const shoal = Math.min(1, Math.max(0, depth.getX(k)) * 0.62 / Math.max(hs, 0.001));
            const distance = meshRelative.length();
            const blend = T.MathUtils.smoothstep(distance, uniforms.uNearPatchRadius.value - 1840,
              uniforms.uNearPatchRadius.value - 640);
            const value = { footprint, position: meshRelative.addScaledVector(up, wave * shoal * (1 - blend) + 0.18)
              .add(mesh.position) };
            vertexCache.set(k, value);
            return value;
          };
          const find = (value) => {
            let lo = 0, hi = patch.cells;
            while (hi - lo > 1) {
              const mid = (lo + hi) >> 1;
              if (patch._gridCoordinate(mid) > value) hi = mid; else lo = mid;
            }
            return lo;
          };
          for (const radius of [0, 20, 100]) for (let heading = 0; heading < (radius ? 4 : 1); heading++) {
            const angle = heading * Math.PI / 2;
            const dir = direction.clone().addScaledVector(tangent, Math.cos(angle) * radius / p.seaRadius)
              .addScaledVector(bitangent, Math.sin(angle) * radius / p.seaRadius).normalize();
            const px = p.seaRadius * dir.dot(tangent) / dir.dot(center);
            const py = p.seaRadius * dir.dot(bitangent) / dir.dot(center);
            if (Math.max(Math.abs(px), Math.abs(py)) >= patch.size / 2) continue;
            const x = find(px), y = find(py);
            const ray = new T.Ray(new T.Vector3(), dir), hit = new T.Vector3();
            let surfaceRadius = -Infinity, footprint = 0, triangleOffset = null;
            // Exact radial intersection with the displaced committed triangles,
            // not parametric grid weights (projection changes barycentrics).
            // Adjacent cells cover tiny tangential offsets from Float32 aLocal.
            for (let iy = Math.max(0, y - 1); iy <= Math.min(patch.cells - 1, y + 1); iy++)
              for (let ix = Math.max(0, x - 1); ix <= Math.min(patch.cells - 1, x + 1); ix++)
                for (const triangle of [0, 3]) {
                  const offset = (iy * patch.cells + ix) * 6 + triangle;
                  const vertices = [0, 1, 2].map((v) => displacedVertex(indexBuffer.getX(offset + v)));
                  if (ray.intersectTriangle(...vertices.map((v) => v.position), false, hit)
                    && hit.length() > surfaceRadius) {
                    surfaceRadius = hit.length();
                    footprint = Math.max(...vertices.map((v) => v.footprint));
                    triangleOffset = offset;
                  }
                }
            if (!Number.isFinite(surfaceRadius)) throw new Error('No committed water triangle intersects the sampled radial ray');
            const logical = p.sampleWaterSurface(dir.clone().multiplyScalar(p.seaRadius), hours, { normal: false });
            result.samples.push({ radius, heading, footprint, wet: logical.wet,
              logicalHeight: logical.height, reconstructedHeight: surfaceRadius - p.seaRadius,
              errorMeters: surfaceRadius - p.seaRadius - logical.height, triangleOffset });
          }
          result.samplingCpuMs = performance.now() - samplingStarted;
          return result;
        };
        if (p.oceanSurface.tidalField) throw new Error('Ordinary-wave reconstruction requires a non-tidal fixture');
        NMS.resetPerformanceStats();
        window.__nearFrameIntervals.length = 0;
      });
      const samples = [], inputs = [];
      let w = false, s = false;
      const key = async (code, down) => {
        if ((code === 'KeyW' ? w : s) === down) return;
        await page.keyboard[down ? 'down' : 'up'](code);
        if (code === 'KeyW') w = down; else s = down;
        inputs.push({ milliseconds: Date.now(), code, down });
      };
      const sample = async (phase) => {
        const value = await page.evaluate(() => window.__nearSample());
        samples.push({ phase, ...value });
        return value;
      };
      const throttle = async (value) => {
        await key('KeyW', value.speed < 155);
        await key('KeyS', value.speed > 170);
        // Real mouse wheel throttle supplies the same impulse a player can use
        // if W alone cannot sustain the target. Never mutate flight state here.
        if (value.speed < 155 && value.control.wheelGain > 0) {
          const lateralSquared = Math.max(0, value.speed ** 2 - value.control.forwardSpeed ** 2);
          const delta = Math.max(0, Math.sqrt(Math.max(0, 170 ** 2 - lateralSquared))
            - value.control.forwardSpeed);
          const wheel = -Math.min(240, delta / value.control.wheelGain);
          await page.mouse.wheel(0, wheel);
          inputs.push({ milliseconds: Date.now(), wheel });
        }
      };
      for (let i = 0; i < 60; i++) {
        await throttle(await sample('straight'));
        await page.waitForTimeout(200);
      }
      await page.screenshot({ path: `${out}/${fps}-straight-player.png` });
      let turn = 0;
      for (let i = 0; i < 75 && turn < 82; i++) {
        const value = await sample('turn');
        turn = value.actualTurnDeg;
        await throttle(value);
        await page.mouse.move(850, 550);
        await page.mouse.down({ button: 'middle' });
        await page.mouse.move(915, 550, { steps: 3 });
        await page.mouse.up({ button: 'middle' });
        inputs.push({ milliseconds: Date.now(), middleDrag: [65, 0] });
        await page.waitForTimeout(200);
      }
      await page.screenshot({ path: `${out}/${fps}-turn-player.png` });
      await key('KeyW', false);
      await key('KeyS', false);
      for (let i = 0; i < 40; i++) {
        await sample('stop');
        await page.waitForTimeout(200);
      }
      await page.screenshot({ path: `${out}/${fps}-stopped-player.png` });
      const state = await page.evaluate(() => ({ stats: NMS.stats(), water: NMS.waterState(0),
        gl: NMS._renderer.getContext().getError(), contextLost: NMS._renderer.getContext().isContextLost(),
        frameIntervals: window.__nearFrameIntervals }));
      const moving = samples.filter((v) => v.phase !== 'stop');
      const nearSamples = samples.flatMap((v) => v.samples).filter((v) => v.wet);
      const measurements = {
        speedMin: Math.min(...moving.map((v) => v.speed)), speedMax: Math.max(...moving.map((v) => v.speed)),
        targetSpeedCoverage: moving.filter((v) => v.speed >= 130 && v.speed <= 170).length / moving.length,
        maximumTurnDeg: Math.max(...samples.map((v) => v.actualTurnDeg)),
        maxAnchor: Math.max(...samples.map((v) => v.actualAnchorOffset ?? 0)),
        maxCell: Math.max(...nearSamples.map((v) => v.footprint)),
        maxCpuHeightErrorMeters: Math.max(...nearSamples.map((v) => Math.abs(v.errorMeters))),
        stoppedSpeed: samples.at(-1).speed,
        actualFps: 1000 / (state.frameIntervals.reduce((a, b) => a + b, 0) / state.frameIntervals.length),
      };
      const gates = { noErrors: errors.length === 0, webgl2: state.stats.rendererBackend === 'webgl2',
        glClean: state.gl === 0, contextAlive: !state.contextLost,
        actualLowFlight: samples.every((v) => v.altitude > 0 && v.altitude < 100),
        targetSpeedExercised: measurements.targetSpeedCoverage >= 0.8,
        actualTurnExercised: measurements.maximumTurnDeg >= 70 && measurements.maximumTurnDeg <= 120,
        stopped: measurements.stoppedSpeed < 5,
        recentered: samples.at(-1).patch.rebuilds > samples[0].patch.rebuilds,
        coreCoverage: measurements.maxAnchor + 100 <= samples.at(-1).patch.coreRadius,
        cpuContactError: measurements.maxCpuHeightErrorMeters < 0.02 };
      evidence.runs.push({ fps, measurements, gates, samples, inputs, state, errors });
      await writeFile(`${out}/report.json`, JSON.stringify(evidence, null, 2));
      console.log(JSON.stringify({ fps, measurements, gates }));
    } catch (error) {
      let failureState = null;
      try {
        failureState = await page.evaluate(() => ({ stats: window.NMS?.stats?.(),
          water: window.NMS?.waterState?.(0), sample: window.__nearSample?.() }));
      } catch (captureError) { failureState = { captureError: String(captureError) }; }
      await page.screenshot({ path: `${out}/${fps}-failure-player.png` }).catch(() => {});
      evidence.failure = { fps, error: String(error), stack: error.stack, state: failureState, errors };
      await writeFile(`${out}/report.json`, JSON.stringify(evidence, null, 2));
      throw error;
    } finally { await context.close(); }
  }
  const finalFingerprint = await evidenceFingerprint('tools/nearwaterplaytest.js');
  evidence.stableSource = finalFingerprint.sourceDigest === fingerprint.sourceDigest
    && finalFingerprint.verifierDigest === fingerprint.verifierDigest;
  await writeFile(`${out}/report.json`, JSON.stringify(evidence, null, 2));
  assert.ok(evidence.stableSource, 'source changed while capture was running');
  assert.ok(evidence.runs.every((r) => Object.values(r.gates).every(Boolean)),
    'One or more measured traversal gates failed; inspect report, do not relabel target speed or turn as achieved.');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
