// Diagnostic only. Replay the exact failed game programs, changing only whether
// CACHE1 is linked before CACHE0 completes. Every arm gets a fresh browser/context.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const input = process.argv.find(arg => arg.startsWith('--input='))?.slice(8)
  || 'docs/baselines/foundation-cloud-readiness-2026-10-26/candidate-page/failure.json.gz';
const arms = (process.argv.find(arg => arg.startsWith('--arms='))?.slice(7) || 'solo,overlap').split(',');
assert.ok(arms.length && arms.every(arm => arm === 'solo' || arm === 'overlap'));
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
const before = await evidenceFingerprint('tools/cloudprograminterleavingdiag.js');
const out = `test-results/cloud-program-interleaving/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });
await writeFile(`${out}/native-inputs.json.gz`, gzipSync(Buffer.from(JSON.stringify(selected)), { level: 9 }));
await writeFile(`${out}/verifier.js`, await readFile('tools/cloudprograminterleavingdiag.js'));
const cases = [], errors = [], warnings = [];
let browser;
try {
  for (const [index, arm] of arms.entries()) {
    browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined });
    const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) warnings.push(message.text()); });
    await page.setContent('<canvas width="64" height="64"></canvas><pre>Native compile interleaving control</pre>');
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
        const c0 = submit(selected[0], 0), c1 = arm === 'overlap' ? submit(selected[1], 1) : null;
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
          item.row.reflection = { atMs: begin - start, reflectionMs, uniformCount, linked, log };
        }
        await new Promise(resolve => setTimeout(resolve, 30));
        const result = { arm, gpu, userAgent: navigator.userAgent, deadlineMs, pollIntervalMs, pollCopies,
          observationEndedAtMs, wallMs: performance.now() - start, rows, events, ticks,
          maximumHeartbeatGapMs: Math.max(0, ...gaps, performance.now() - last),
          contextAttributes: gl.getContextAttributes(), gl: gl.getError(), lost: gl.isContextLost(),
          allReady: rows.every(row => row.firstCompleteAtMs !== null && row.firstCompleteAtMs <= deadlineMs) };
        document.querySelector('pre').textContent = JSON.stringify(result, null, 2);return result;
      } finally { clearInterval(timer); }
    }, { selected, arm, pollCopies, deadlineMs, pollIntervalMs });
    cases.push(result);
    await page.screenshot({ path: `${out}/${index}-${arm}.png` });
    await writeFile(`${out}/cases.json`, JSON.stringify(cases, null, 2));
    console.log(JSON.stringify(result));
    await browser.close();browser = null;
  }
  const after = await evidenceFingerprint('tools/cloudprograminterleavingdiag.js');
  assert.deepEqual(after, before, 'Runtime/verifier changed during capture');
  const report = { before, after, input, inputSha256: hash(bytes), inputSourceDigest: source.sourceDigest,
    inputs: selected.map((program, cache) => ({ cache, sourceProgramId: program.id, shaders: program.shaders.map(shader =>
      ({ type: shader.type, sha256: hash(shader.source), sourceLength: shader.source.length })) })),
    arms, cases, errors, warnings, diagnosticComplete: true,
    passed: cases.every(result => result.allReady && !result.gl && !result.lost
      && result.rows.every(row => row.reflection?.linked === true && row.reflection.uniformCount > 0)) && !errors.length,
    boundary: 'Exact original native sources; fresh browser and context per arm. No draw, Three, flush, finish, retirement, '
      + 'or other context workload. Original 120s criterion. Does not prove game readiness or cost reduction; driver caches are not reset.' };
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out, passed: report.passed }));
  assert.ok(report.passed, 'At least one native arm failed its original 120 second deadline');
} catch (error) {
  await writeFile(`${out}/failure.json`, JSON.stringify({ before, input, cases, errors, warnings, error: String(error) }, null, 2));
  throw error;
} finally { await browser?.close(); }
