// Fresh real renderer/Planet/prepare queue control for the full captured cloud
// program. No game loop, texture prewarm, cloud draw or alternate shader input.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';
import { installFoundationGLProbe } from './foundation-gl-probe.js';
import { cloudOcclusionCandidateSource } from './cloud-occlusion-candidate.js';

const input = 'docs/baselines/foundation-cloud-readiness-2026-10-26/candidate-page/failure.json.gz';
const idleContexts = Number(process.argv.find(arg => arg.startsWith('--idle-contexts='))?.slice(16) || 0);
const unionOccluders = process.argv.includes('--union-occluders');
const nativeTail = process.argv.includes('--native-tail');
const candidatePlanet = unionOccluders ? cloudOcclusionCandidateSource(await readFile('src/planet.js', 'utf8')) : null;
assert.ok(Number.isInteger(idleContexts) && idleContexts >= 0 && idleContexts <= 2, 'Zero to two extra idle renderer contexts');
const inputBytes = await readFile(input), original = JSON.parse(gunzipSync(inputBytes)), probe = original.state.probe;
const shaderMap = new Map(probe.shaders.map(shader => [shader.id, shader]));
const expected = [28, 29].map(id => probe.programs.find(program => program.id === id).shaderIds.map(id => {
  const original = shaderMap.get(id);if (!unionOccluders) return original;
  const prefix = '#define STELLAR_UNION_OCCLUSION 0';
  assert.equal(original.source.split(prefix).length - 1, 1, 'One authored topology prefix');
  const source = original.source.replace(prefix, '#define STELLAR_UNION_OCCLUSION 1');
  return { ...original, source, sourceLength: source.length };
}));
assert.ok(expected.flat().every(shader => !shader.truncated && shader.source.length === shader.sourceLength));
const out = `test-results/cloud-program-owner/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });
const before = await evidenceFingerprint('tools/cloudprogramownerdiag.js');
const helperBefore = await evidenceFingerprint('tools/foundation-gl-probe.js');
await writeFile(`${out}/verifier.js`, await readFile('tools/cloudprogramownerdiag.js'));
await writeFile(`${out}/native-inputs.json.gz`, gzipSync(Buffer.from(JSON.stringify(expected)), { level: 9 }));
const { server, port } = await startServer(0);const errors = [], warnings = [];
let browser, state;
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined });
  const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
  if (candidatePlanet) {
    await writeFile(`${out}/candidate-planet.js.gz`, gzipSync(Buffer.from(candidatePlanet), { level: 9 }));
    await page.route('**/src/planet.js', route => route.fulfill({ contentType: 'text/javascript', body: candidatePlanet }));
  }
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text());else if (message.type() === 'warning') warnings.push(message.text()); });
  await page.route('**/cloud-owner-fixture.html', route => route.fulfill({ contentType: 'text/html', body:
    '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script><canvas></canvas><pre>Real cloud preparation; no draw.</pre>' }));
  await page.goto(`http://127.0.0.1:${port}/cloud-owner-fixture.html`);
  await page.evaluate(async idleContexts => {
    const T = await import('three');
    const renderer = new T.WebGLRenderer({ canvas: document.querySelector('canvas'), antialias: true,
      alpha: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
    renderer.setSize(64, 64);renderer.toneMapping = T.ACESFilmicToneMapping;renderer.debug.checkShaderErrors = false;
    window.NMS = { _renderer: renderer };
    // Match the number of extra startup map renderers, without map shaders or
    // draws. Only this context-count arm changes; all cloud sources stay exact.
    window.__idleCloudRenderers = Array.from({ length: idleContexts }, () => new T.WebGLRenderer({
      antialias: true, alpha: true, powerPreference: 'high-performance' }));
  }, idleContexts);
  await page.evaluate(installFoundationGLProbe);
  state = await page.evaluate(async ({ unionOccluders, nativeTail }) => {
    const T = await import('three'), renderer = NMS._renderer, gl = renderer.getContext();
    const { installProgramRetirement } = await import('/src/program-retirement.js');
    const { GameLegacyPipeline } = await import('/src/legacy-render-pipeline.js');
    const { Planet, setVolumetricCloudsEnabled } = await import('/src/planet.js');
    const retirement = installProgramRetirement(renderer);
    setVolumetricCloudsEnabled(true);
    const body = new Planet({ seed: 'far-occluder-topology', name: 'Full cloud owner fixture',
      posUniv: new T.Vector3(), type: 'lush', radius: 6e6,
      tuning: { cloudCoverage: .64, weatherStyle: 'temperate-synoptic' } });
    body.setStellarOccluders(unionOccluders ? [-1e5, 1e5].map(x => ({ centerLocal: new T.Vector3(x, 2e7, 0), radius: 1.8e5 })) : []);
    const scene = new T.Scene(), camera = new T.PerspectiveCamera(60, 1, .12, 1.2e11);camera.layers.set(2);scene.add(body.group);
    const pipeline = new GameLegacyPipeline(renderer, scene, camera, { volume: true, cloudProgramPreparation: true });
    pipeline.setSize(64, 64, 1);
    const config = { scene, camera, target: pipeline.volumePass.current,
      requests: [{ mesh: body.volCloudMesh, material: body.volCloudFarMat, cacheVariants: [0, 1] }] };
    const begin = performance.now(), gaps = [];let last = begin, ticks = 0;
    const timer = setInterval(() => {
      const now = performance.now();gaps.push(now - last);last = now;ticks++;
      document.querySelector('pre').textContent = `Real owner waiting ${Math.round(now - begin)} ms; ${ticks} timer callbacks`;
    }, 20);
    let ready = false;
    try {
      while (performance.now() - begin < 125000) {
        ready = pipeline.cloudPrograms.ensure(config);
        if (ready || pipeline.cloudPrograms.snapshot().failed) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      const endedAtMs = performance.now() - begin, reflections = [];
      const programs = [...new Set(renderer.properties.get(body.volCloudFarMat).programs.values())];
      let tail = null;
      if (!ready && nativeTail) {
        const start = performance.now(), ext = gl.getExtension('KHR_parallel_shader_compile');
        tail = { startAtMs: start, deadlineMs: 120000, rows: programs.map(program => ({ programId: program.id,
          polls: 0, firstCompleteAtMs: null, linked: null, reflectionMs: null })), endReason: null,
          boundary: 'Bounded native observation after original owner failure; no retry or deadline change. Original readiness result remains false.' };
        while (ext && performance.now() - start < tail.deadlineMs && !gl.isContextLost()) {
          for (const [i, program] of programs.entries()) {
            const row = tail.rows[i];if (row.firstCompleteAtMs !== null) continue;
            if (!program.program) throw Error('Tail program released');
            const complete = gl.getProgramParameter(program.program, ext.COMPLETION_STATUS_KHR);row.polls++;
            if (typeof complete !== 'boolean') throw Error('Invalid native tail status');
            if (complete) row.firstCompleteAtMs = performance.now();
          }
          if (tail.rows.every(row => row.firstCompleteAtMs !== null)) { tail.endReason = 'observed-all';break; }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        tail.endReason ||= gl.isContextLost() ? 'context-lost' : 'diagnostic-deadline';tail.endedAtMs = performance.now();
        for (const [i, program] of programs.entries()) if (tail.rows[i].firstCompleteAtMs !== null) {
          const row = tail.rows[i];row.linked = gl.getProgramParameter(program.program, gl.LINK_STATUS);
          if (row.linked) { const start = performance.now();program.getUniforms();row.reflectionMs = performance.now() - start; }
        }
        tail.allLinked = tail.rows.every(row => row.linked === true);
      }
      if (ready) for (const program of programs) {
        const start = performance.now();program.getUniforms();
        reflections.push({ programId: program.id, reflectionMs: performance.now() - start,
          linked: gl.getProgramParameter(program.program, gl.LINK_STATUS) });
      }
      await new Promise(resolve => setTimeout(resolve, 30));
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      const result = { ready, endedAtMs, observationEndedAtMs: performance.now() - begin, nativeTail: tail,
        snapshots: { cloud: pipeline.cloudPrograms.snapshot(), queue: pipeline.preparations.snapshot() },
        reflections, probe: __foundationGLProbe.snapshot(), gl: gl.getError(), lost: gl.isContextLost(), ticks,
        maximumHeartbeatGapMs: Math.max(0, ...gaps, performance.now() - last), contextAttributes: gl.getContextAttributes(),
        gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
        liveRestored: body.volCloudMesh.material === body.volCloudMat && body.volCloudFarMat.defines.CLOUD_FAR_CACHE === 0,
        idleContexts: window.__idleCloudRenderers.length,
        occluderCount: body.stellarOccluders.length, unionDefine: body.volCloudFarMat.defines.STELLAR_UNION_OCCLUSION,
        boundary: 'Real full shader and actual renderer/queue/cloud owner/retirement; optional extra idle renderer contexts. No cloud draw, game or texture workload. Adapter deadlines remain 120s.' };
      document.querySelector('pre').textContent = JSON.stringify({ ...result, probe: undefined }, null, 2);
      pipeline.dispose();body.dispose();for (const idle of window.__idleCloudRenderers) idle.dispose();renderer.dispose();
      for (let i = 0; i < 200 && retirement.snapshot().pending; i++) await new Promise(resolve => setTimeout(resolve, 10));
      result.retirement = retirement.snapshot();result.finalGL = gl.getError();result.finalLost = gl.isContextLost();return result;
    } finally { clearInterval(timer); }
  }, { unionOccluders, nativeTail });
  await page.screenshot({ path: `${out}/owner.png` });
  await writeFile(`${out}/state.json.gz`, gzipSync(Buffer.from(JSON.stringify(state)), { level: 9 }));
  const actualShaders = new Map(state.probe.shaders.map(shader => [shader.id, shader]));
  const actual = state.probe.programs.map(program => program.shaderIds.map(id => actualShaders.get(id)));
  const hashes = [];
  assert.equal(actual.length, 2, 'Exactly two cloud programs, no background compilation');
  for (let cache = 0; cache < 2; cache++) for (const expectedShader of expected[cache]) {
    const actualProgram = actual.find(program => program.some(shader => shader.type === 35632 && shader.source.includes(`#define CLOUD_FAR_CACHE ${cache}`)));
    const shader = actualProgram?.find(shader => shader.type === expectedShader.type);
    assert.ok(shader && !shader.truncated && shader.source.length === shader.sourceLength);
    assert.equal(shader.source, expectedShader.source, `CACHE${cache}, shader ${expectedShader.type}: exact selected-topology native source`);
    hashes.push({ cache, type: shader.type, sha256: createHash('sha256').update(shader.source).digest('hex') });
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings.filter(value => /GL_INVALID_|CONTEXT_LOST/.test(value)), []);
  const after = await evidenceFingerprint('tools/cloudprogramownerdiag.js');assert.deepEqual(after, before);
  assert.deepEqual(await evidenceFingerprint('tools/foundation-gl-probe.js'), helperBefore);
  const passed = state.ready && state.endedAtMs < 120000 && !state.gl && !state.lost && !state.finalGL && !state.finalLost && state.liveRestored
    && state.reflections.length === 2 && state.reflections.every(value => value.linked)
    && !state.retirement.pending && !state.retirement.faults.length;
  await writeFile(`${out}/report.json`, JSON.stringify({ before, after, helperBefore, input,
    inputSha256: createHash('sha256').update(inputBytes).digest('hex'), inputSourceDigest: original.sourceDigest,
    idleContexts, unionOccluders, nativeTail, candidateInstalledInRuntime: false,
    candidatePlanetSha256: candidatePlanet ? createHash('sha256').update(candidatePlanet).digest('hex') : null,
    hashes, state: { ...state, probe: undefined },
    errors, warnings, nativeSourceExact: !unionOccluders, selectedTopologySourceExact: true,
    sourceDerivation: unionOccluders ? 'Only STELLAR_UNION_OCCLUSION prefix 0 to 1 in both original programs; actual Planet setter selects it.' : 'Original failed-page native sources unchanged', passed }, null, 2));
  console.log(JSON.stringify({ out, passed, nativeSourceExact: !unionOccluders, selectedTopologySourceExact: true, state: { ...state, probe: undefined } }));
  assert.ok(passed, 'Real cloud owner failed its unchanged readiness contracts');
} catch (error) {
  await writeFile(`${out}/failure.json`, JSON.stringify({ before, helperBefore, idleContexts, unionOccluders, nativeTail, state, errors, warnings, error: String(error), stack: error.stack }, null, 2));throw error;
} finally { await browser?.close();server.close(); }
