// Diagnostic only: exact captured programs, reconstructed context prelude.
// The older probe records shader inputs and first reflections, not a complete
// API trace. These are deliberately bounded controls, not an exact game replay.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const input = 'docs/baselines/foundation-cloud-readiness-2026-10-26/candidate-page/failure.json.gz';
const arms = (process.argv.find(arg => arg.startsWith('--arms='))?.slice(7)
  || 'none,resident,released').split(',');
assert.ok(arms.length && arms.every(arm => ['none', 'resident', 'released'].includes(arm)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = await readFile(input), source = JSON.parse(gunzipSync(bytes));
const probe = source.state.probe, shaders = new Map(probe.shaders.map(shader => [shader.id, shader]));
const inputs = probe.programs.filter(program => program.id <= 29).map(program => ({
  id: program.id, reflectedAtMs: program.firstReflectionAtMs ?? null,
  shaders: program.shaderIds.map(id => shaders.get(id)),
}));
assert.deepEqual(inputs.map(program => program.id), Array.from({ length: 29 }, (_, i) => i + 1));
assert.ok(inputs.every(program => program.shaders.length === 2 && program.shaders.every(shader =>
  !shader.truncated && shader.source.length === shader.sourceLength)));
for (const [cache, program] of inputs.slice(-2).entries()) assert.ok(program.shaders.some(shader =>
  shader.type === 35632 && shader.source.includes('#define CLOUD_FAR_VIEW 1')
  && shader.source.includes(`#define CLOUD_FAR_CACHE ${cache}`)));
const before = await evidenceFingerprint('tools/cloudprogrampreludediag.js');
const out = `test-results/cloud-program-prelude/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });
await writeFile(`${out}/native-inputs.json.gz`, gzipSync(Buffer.from(JSON.stringify(inputs)), { level: 9 }));
await writeFile(`${out}/verifier.js`, await readFile('tools/cloudprogrampreludediag.js'));
const cases = [], errors = [], warnings = [];
let browser;
try {
  for (const [index, arm] of arms.entries()) {
    browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined });
    const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
      else if (message.type() === 'warning') warnings.push(message.text());
    });
    await page.setContent('<canvas width="64" height="64"></canvas><pre>Cloud context prelude</pre>');
    console.log(JSON.stringify({ arm, out, status: 'started' }));
    const result = await page.evaluate(async ({ inputs, arm }) => {
      const gl = document.querySelector('canvas').getContext('webgl2');
      if (!gl) throw Error('WebGL2 required');
      const ext = gl.getExtension('KHR_parallel_shader_compile');
      if (!ext) throw Error('Parallel compilation required');
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      const start = performance.now(), rows = [], events = [], gaps = [];
      let last = start, phase = 'prelude';
      const timer = setInterval(() => {
        const now = performance.now();gaps.push(now - last);last = now;
        document.querySelector('pre').textContent = `${arm} ${phase}: ${Math.round(now - start)} ms`;
      }, 20);
      const submit = input => {
        const program = gl.createProgram(), nativeShaders = [], begin = performance.now();
        for (const source of input.shaders) {
          const shader = gl.createShader(source.type);nativeShaders.push(shader);
          gl.shaderSource(shader, source.source);gl.compileShader(shader);gl.attachShader(program, shader);
        }
        gl.bindAttribLocation(program, 0, 'position');gl.linkProgram(program);
        const row = { sourceProgramId: input.id, phase, submittedAtMs: begin - start,
          linkReturnedAtMs: performance.now() - start, polls: 0, completeAtMs: null, reflection: null, released: false };
        rows.push(row);return { input, program, nativeShaders, row };
      };
      const poll = item => {
        if (item.row.completeAtMs !== null) return;
        const complete = gl.getProgramParameter(item.program, ext.COMPLETION_STATUS_KHR);item.row.polls++;
        if (typeof complete !== 'boolean') throw Error('Invalid completion status');
        if (complete) item.row.completeAtMs = performance.now() - start;
      };
      const awaitReady = async (items, deadlineMs, copies) => {
        const begin = performance.now();
        while (performance.now() - begin < deadlineMs) {
          for (let copy = 0; copy < copies; copy++) for (const item of items) poll(item);
          if (items.every(item => item.row.completeAtMs !== null)) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        return { beginAtMs: begin - start, endedAtMs: performance.now() - start, deadlineMs,
          ready: items.every(item => item.row.completeAtMs !== null && item.row.completeAtMs - (begin - start) <= deadlineMs) };
      };
      const reflect = item => {
        if (item.row.completeAtMs === null) return;
        const begin = performance.now(), linked = gl.getProgramParameter(item.program, gl.LINK_STATUS);
        const log = gl.getProgramInfoLog(item.program);
        const uniformCount = linked ? gl.getProgramParameter(item.program, gl.ACTIVE_UNIFORMS) : 0;
        if (linked) for (let i = 0; i < uniformCount; i++) {
          const uniform = gl.getActiveUniform(item.program, i);gl.getUniformLocation(item.program, uniform.name);
        }
        const attributeCount = linked ? gl.getProgramParameter(item.program, gl.ACTIVE_ATTRIBUTES) : 0;
        if (linked) for (let i = 0; i < attributeCount; i++) {
          const attribute = gl.getActiveAttrib(item.program, i);gl.getAttribLocation(item.program, attribute.name);
        }
        item.row.reflection = { atMs: begin - start, durationMs: performance.now() - begin,
          linked, uniformCount, attributeCount, log };
        events.push({ type: 'reflection', sourceProgramId: item.input.id, atMs: begin - start });
      };
      try {
        const prelude = arm === 'none' ? [] : inputs.slice(0, 27).map(submit);
        // Finish preceding compilation before testing retained context state.
        // Original first-reflection order is used only for those recorded calls;
        // all remaining programs are checked afterwards, with no draw or upload.
        const preludeWait = await awaitReady(prelude, 120000, 1);
        const reflectionOrder = [...prelude].sort((a, b) =>
          (a.input.reflectedAtMs ?? Infinity) - (b.input.reflectedAtMs ?? Infinity) || a.input.id - b.input.id);
        reflectionOrder.forEach(reflect);
        const preludeValid = preludeWait.ready && prelude.every(item => item.row.reflection?.linked);
        if (arm === 'released' && preludeValid) for (const item of prelude) {
          for (const shader of item.nativeShaders) gl.deleteShader(shader);
          gl.deleteProgram(item.program);item.row.released = true;
        }
        phase = 'cloud';
        const clouds = preludeValid ? inputs.slice(27).map(submit) : [];
        const cloudWait = clouds.length === 2 ? await awaitReady(clouds, 120000, 2) : null;
        clouds.forEach(reflect);
        const result = { arm, gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
          userAgent: navigator.userAgent, contextAttributes: gl.getContextAttributes(), rows, events,
          preludeWait, cloudWait, preludeValid, wallMs: performance.now() - start,
          maximumHeartbeatGapMs: Math.max(0, ...gaps, performance.now() - last),
          gl: gl.getError(), lost: gl.isContextLost(), passed: preludeValid && cloudWait?.ready === true
            && clouds.every(item => item.row.reflection?.linked && item.row.reflection.uniformCount > 0) };
        document.querySelector('pre').textContent = JSON.stringify({ ...result, rows: rows.slice(-2) }, null, 2);
        return result;
      } finally { clearInterval(timer); }
    }, { inputs, arm });
    cases.push(result);
    await page.screenshot({ path: `${out}/${index}-${arm}.png` });
    await writeFile(`${out}/cases.json`, JSON.stringify(cases, null, 2));
    console.log(JSON.stringify({ ...result, rows: result.rows.slice(-2) }));
    await browser.close();browser = null;
  }
  const after = await evidenceFingerprint('tools/cloudprogrampreludediag.js');
  assert.deepEqual(after, before, 'Runtime/verifier changed during capture');
  const report = { before, after, input, inputSha256: hash(bytes),
    inputs: inputs.map(program => ({ id: program.id, shaders: program.shaders.map(shader => ({
      type: shader.type, sha256: hash(shader.source), length: shader.source.length })) })),
    cases, errors, warnings, diagnosticComplete: true,
    passed: cases.every(result => result.passed && !result.gl && !result.lost) && !errors.length
      && !warnings.some(value => /GL_INVALID_|CONTEXT_LOST|Program object expected/.test(value)),
    boundary: 'Exact captured VS/FS; reconstructed submission of preceding 27 programs, followed by KHR readiness and reflection. '
      + 'Not a complete API trace: original link times, attribute bindings, texture/draw work and deletion order were not recorded. '
      + 'Fresh browser/context per arm; driver caches not reset; cloud deadline stays 120 seconds. No production changes.' };
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out, passed: report.passed }));
  assert.ok(report.passed, 'At least one context prelude arm failed');
} catch (error) {
  await writeFile(`${out}/failure.json`, JSON.stringify({ before, input, cases, errors, warnings, error: String(error) }, null, 2));
  throw error;
} finally { await browser?.close(); }
