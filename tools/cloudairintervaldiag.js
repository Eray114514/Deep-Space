// Diagnostic only. Compare complete native cloud column dispatch structure.
// Physical 64-point expressions stay intact; no runtime candidate is installed.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';
import { cloudAirIntervalCandidate } from './cloud-air-interval-candidate.js';
import { cloudColumnHalvesCandidate } from './cloud-column-halves-candidate.js';

const input = process.argv.find(arg => arg.startsWith('--input='))?.slice(8)
  || 'docs/baselines/foundation-cloud-readiness-2026-10-26/candidate-page/failure.json.gz';
const arms = (process.argv.find(arg => arg.startsWith('--arms='))?.slice(7) || 'interval,interval-halves').split(',');
assert.ok(arms.length && arms.every(arm => ['reference', 'interval', 'interval-halves'].includes(arm)));
const union = Number(process.argv.find(arg => arg.startsWith('--union='))?.slice(8) ?? 1);
assert.ok(union === 0 || union === 1);
const pollCopies = 2, deadlineMs = 120000, pollIntervalMs = 10;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = await readFile(input), source = JSON.parse(input.endsWith('.gz') ? gunzipSync(bytes) : bytes);
const probe = source.finalState?.probe || source.state?.probe;
const shaders = new Map(probe.shaders.map(shader => [shader.id, shader]));
const programs = probe.programs.map(program => ({ id: program.id,
  shaders: program.shaderIds.map(id => shaders.get(id)) }));
const selected = [0, 1].map(cache => programs.find(program => program.shaders.some(shader => shader.type === 35632
  && shader.source?.includes('uViewCapacity') && shader.source.includes('#define CLOUD_FAR_VIEW 1')
  && shader.source.includes(`#define CLOUD_FAR_CACHE ${cache}`))));
assert.ok(selected.every(Boolean), 'Full native CACHE0 and CACHE1 inputs required');
assert.ok(selected.every(program => program.shaders.length === 2 && program.shaders.every(shader =>
  !shader.truncated && shader.source.length === shader.sourceLength)), 'Truncated native input rejected');
const nativeShader = (program, type) => program.shaders.find(shader => shader.type === type).source;
assert.equal(nativeShader(selected[0], 35633), nativeShader(selected[1], 35633)
  .replace('#define CLOUD_FAR_CACHE 1', '#define CLOUD_FAR_CACHE 0'), 'Only CACHE vertex prefix differs');
assert.equal(nativeShader(selected[0], 35632), nativeShader(selected[1], 35632)
  .replace('#define CLOUD_FAR_CACHE 1', '#define CLOUD_FAR_CACHE 0'), 'Only CACHE define differs');
const before = await evidenceFingerprint('tools/cloudairintervaldiag.js');
const candidateHelper = await readFile('tools/cloud-column-halves-candidate.js');
const frontHelper = await readFile('tools/cloud-air-interval-candidate.js');
const variants = Object.fromEntries(arms.map(arm => [arm, selected.map(program => ({ ...program, shaders: program.shaders.map(shader => {
  assert.equal(shader.source.split('#define STELLAR_UNION_OCCLUSION 0').length, 2, 'One original UNION0 native prefix required');
  let source = shader.source.replace('#define STELLAR_UNION_OCCLUSION 0', '#define STELLAR_UNION_OCCLUSION ' + union);
  if (arm === 'interval-halves' && shader.type === 35632) source = cloudColumnHalvesCandidate(source);
  if (arm !== 'reference' && shader.type === 35632) source = cloudAirIntervalCandidate(source);
  return { ...shader, source, sourceLength: source.length };
}) }))]));
const out = `test-results/cloud-air-interval/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });
await writeFile(`${out}/native-inputs.json.gz`, gzipSync(Buffer.from(JSON.stringify(variants)), { level: 9 }));
await writeFile(`${out}/candidate-helper.js`, candidateHelper);
await writeFile(`${out}/front-helper.js`, frontHelper);
await writeFile(`${out}/verifier.js`, await readFile('tools/cloudairintervaldiag.js'));
const cases = [], errors = [], warnings = [];
let browser;
try {
  for (const [index, arm] of arms.entries()) {
    browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined });
    const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
      else if (message.type() === 'warning') warnings.push(message.text());
    });
    await page.setContent('<canvas width="64" height="64"></canvas><pre>Native stellar compiler control</pre>');
    console.log(JSON.stringify({ out, arm, union, status: 'started' }));
    const result = await page.evaluate(async ({ selected, arm, pollCopies, deadlineMs, pollIntervalMs }) => {
      const gl = document.querySelector('canvas').getContext('webgl2');
      if (!gl) throw Error('WebGL2 required');
      const ext = gl.getExtension('KHR_parallel_shader_compile');
      if (!ext) throw Error('KHR_parallel_shader_compile required');
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      const gpu = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      const start = performance.now(), events = [], rows = [], gaps = [];
      let last = start, ticks = 0;
      const timer = setInterval(() => {
        const now = performance.now();gaps.push(now - last);last = now;ticks++;
        document.querySelector('pre').textContent = `${arm}: ${Math.round(now - start)} ms, ${ticks} timer callbacks`;
      }, 20);
      const submit = (input, cache) => {
        const begin = performance.now(), program = gl.createProgram();
        for (const source of input.shaders) {
          const shader = gl.createShader(source.type);
          gl.shaderSource(shader, source.source);gl.compileShader(shader);gl.attachShader(program, shader);
        }
        gl.bindAttribLocation(program, 0, 'position');gl.linkProgram(program);
        const row = { cache, sourceProgramId: input.id, submitAtMs: begin - start, linkReturnedAtMs: performance.now() - start,
          submissionMs: performance.now() - begin, completionPolls: 0, incompletePolls: 0,
          firstCompletionQueryAtMs: null, firstCompleteAtMs: null, maximumQueryMs: 0, reflection: null };
        rows.push(row);events.push({ type: 'link-returned', cache, atMs: row.linkReturnedAtMs });
        return { program, row };
      };
      const poll = ({ program, row }) => {
        if (row.firstCompleteAtMs !== null) return;
        const begin = performance.now(), ready = gl.getProgramParameter(program, ext.COMPLETION_STATUS_KHR);
        const ended = performance.now();
        if (row.firstCompletionQueryAtMs === null) row.firstCompletionQueryAtMs = begin - start;
        row.completionPolls++;row.maximumQueryMs = Math.max(row.maximumQueryMs, ended - begin);
        if (ready) { row.firstCompleteAtMs = ended - start;events.push({ type: 'complete', cache: row.cache, atMs: ended - start }); }
        else row.incompletePolls++;
      };
      try {
        const c0 = submit(selected[0], 0), c1 = submit(selected[1], 1);
        while (performance.now() - start < deadlineMs && rows.some(row => row.firstCompleteAtMs === null)) {
          for (let i = 0; i < pollCopies; i++) poll(c0);
          if (c1) poll(c1);
          await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }
        const observationEndedAtMs = performance.now() - start;
        // Never force a timed-out program ready via reflection or LINK_STATUS.
        for (const item of [c0, c1].filter(Boolean)) if (item.row.firstCompleteAtMs !== null) {
          const begin = performance.now(), uniformCount = gl.getProgramParameter(item.program, gl.ACTIVE_UNIFORMS);
          const reflectionMs = performance.now() - begin;
          const linked = gl.getProgramParameter(item.program, gl.LINK_STATUS), log = gl.getProgramInfoLog(item.program);
          for (let i = 0; i < uniformCount; i++) gl.getActiveUniform(item.program, i);
          const shaderLogs=gl.getAttachedShaders(item.program).map(shader=>({
            type:gl.getShaderParameter(shader,gl.SHADER_TYPE),log:gl.getShaderInfoLog(shader)}));
          item.row.reflection = { atMs: begin - start, reflectionMs, uniformCount, linked, log, shaderLogs };
        }
        const translatedShaders = [], translator = gl.getExtension('WEBGL_debug_shaders');
        if (translator) for (const item of [c0, c1].filter(Boolean)) if (item.row.firstCompleteAtMs !== null) {
          for (const shader of gl.getAttachedShaders(item.program)) {
            const begin = performance.now(), text = translator.getTranslatedShaderSource(shader);
            translatedShaders.push({ cache: item.row.cache, type: gl.getShaderParameter(shader, gl.SHADER_TYPE),
              source: text, retrievalMs: performance.now() - begin });
          }
        }
        await new Promise(resolve => setTimeout(resolve, 30));
        const result = { arm, gpu, translatedShaders, userAgent: navigator.userAgent, deadlineMs, pollIntervalMs, pollCopies,
          observationEndedAtMs, wallMs: performance.now() - start, rows, events, ticks,
          maximumHeartbeatGapMs: Math.max(0, ...gaps, performance.now() - last),
          contextAttributes: gl.getContextAttributes(), gl: gl.getError(), lost: gl.isContextLost(),
          allReady: rows.every(row => row.firstCompleteAtMs !== null && row.firstCompleteAtMs <= deadlineMs) };
        document.querySelector('pre').textContent = JSON.stringify(result, null, 2);return result;
      } finally { clearInterval(timer); }
    }, { selected: variants[arm], arm, pollCopies, deadlineMs, pollIntervalMs });
    cases.push(result);
    await page.screenshot({ path: `${out}/${index}-${arm}.png` });
    await writeFile(`${out}/cases.json`, JSON.stringify(cases, null, 2));
    console.log(JSON.stringify({ arm, rows: result.rows.map(({ reflection, ...row }) => ({ ...row, reflection: reflection && { ...reflection, log: reflection.log.slice(0, 160) } })), allReady: result.allReady }));
    await browser.close();browser = null;
  }
  const after = await evidenceFingerprint('tools/cloudairintervaldiag.js');
  assert.deepEqual(after, before, 'Runtime/verifier changed during capture');
  assert.deepEqual(await readFile('tools/cloud-column-halves-candidate.js'), candidateHelper);
  assert.deepEqual(await readFile('tools/cloud-air-interval-candidate.js'), frontHelper);
  const report = { before, after, input, inputSha256: hash(bytes), inputSourceDigest: source.sourceDigest,
    union, installedInRuntime: false, candidateHelperSha256: hash(candidateHelper), frontHelperSha256: hash(frontHelper),
    nativeVariantHashes: Object.fromEntries(Object.entries(variants).map(([arm, programs]) => [arm, programs.map(program => ({ id: program.id, shaders: program.shaders.map(shader => ({ type: shader.type, sha256: hash(shader.source) })) }))])),
    inputs: selected.map((program, cache) => ({ cache, sourceProgramId: program.id, shaders: program.shaders.map(shader =>
      ({ type: shader.type, sha256: hash(shader.source), sourceLength: shader.source.length })) })),
    arms, cases, errors, warnings, diagnosticComplete: true,
    passed: cases.every(result => result.allReady && !result.gl && !result.lost
      && result.rows.every(row => row.reflection?.linked === true && row.reflection.uniformCount > 0)
      && result.rows.find(row => row.cache === 1)?.reflection?.uniformCount === 72) && !errors.length
      && !warnings.some(value => /GL_INVALID_|CONTEXT_LOST|Program object expected/.test(value)),
    boundary: 'Complete captured native cloud VS/FS; optional UNION prefix. interval shares Far front and deck-gap airSample and mediumStep call sites, retaining each quadrature and blend order. interval-halves additionally shares the two radial density loop call sites. Not numerically accepted until real pixel validation. Fresh browser/context per arm; driver caches not reset. Original 120s gate unchanged. Native compilation only, not pixel or player acceptance.' };
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out, passed: report.passed }));
  assert.ok(report.passed, 'At least one native arm failed its original 120 second deadline');
} catch (error) {
  await writeFile(`${out}/failure.json`, JSON.stringify({ before, input, cases, errors, warnings, error: String(error) }, null, 2));
  throw error;
} finally { await browser?.close(); }
