// Isolate Chromium's automatic KHR program-completion query from the game.
// No renderer/program polling in the immediate-delete modes. Error reads are
// explicit terminal checkpoints, not per-call synchronization or a speed gate.
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';
import assert from 'node:assert/strict';
const out = `test-results/program-retirement/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });
const before = await evidenceFingerprint('tools/programretirementdiag.js');
const { server, port } = await startServer(0);let browser;const records = [];
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined });
  for (const mode of ['no-khr-delete', 'khr-delete', 'khr-complete-delete', 'khr-retain', 'khr-adapter-delete']) {
    const page = await browser.newPage(), warnings = [], logs = [];let warningCount = 0, logCount = 0;
    page.on('console', message => { if (message.type() === 'warning' || message.type() === 'error') {
      warningCount++;if (warnings.length < 256) warnings.push(message.text());
    } });
    const cdp = await page.context().newCDPSession(page);
    cdp.on('Log.entryAdded', ({ entry }) => { logCount++;if (logs.length < 128) logs.push(entry); });await cdp.send('Log.enable');
    await page.route('**/program-retirement.html', route => route.fulfill({ contentType: 'text/html', body: '<link rel="icon" href="data:,"><canvas id="fixture" width="64" height="64"></canvas>' }));
    await page.goto(`http://127.0.0.1:${port}/program-retirement.html`);
    const result = await page.evaluate(async mode => {
      const canvas = document.querySelector('canvas'), gl = canvas.getContext('webgl2');
      const ext = mode === 'no-khr-delete' ? null : gl.getExtension('KHR_parallel_shader_compile');
      const adapter = mode === 'khr-adapter-delete'
        ? (await import('/src/program-retirement.js')).installProgramRetirement({ getContext: () => gl, domElement: canvas, dispose() {} }) : null;
      const initialError = gl.getError(), retained = [];
      const vertex = '#version 300 es\nvoid main(){gl_Position=vec4(0,0,0,1);gl_PointSize=1.;}';
      const fragment = '#version 300 es\nprecision highp float;out vec4 color;void main(){color=vec4(.25,.5,.75,1);}';
      for (let i = 0; i < 12; i++) {
        const a = gl.createShader(gl.VERTEX_SHADER), b = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(a, vertex);gl.shaderSource(b, fragment);gl.compileShader(a);gl.compileShader(b);
        const program = gl.createProgram();gl.attachShader(program, a);gl.attachShader(program, b);gl.linkProgram(program);
        if (mode === 'khr-complete-delete' && ext) {
          const start = performance.now();
          while (!gl.getProgramParameter(program, ext.COMPLETION_STATUS_KHR)) {
            if (performance.now() - start > 10000) throw Error('Completion deadline');
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }
        if (mode === 'khr-retain') retained.push(program);else gl.deleteProgram(program);
        gl.deleteShader(a);gl.deleteShader(b);
      }
      for (let i = 0; i < 20; i++) await new Promise(requestAnimationFrame);
      const beforeRetirementError = gl.getError();
      // Retained programs are known complete only after an explicit readiness
      // check, never merely because twenty RAFs or a draw have happened.
      for (const program of retained) {
        if (ext) {
          const start = performance.now();
          while (!gl.getProgramParameter(program, ext.COMPLETION_STATUS_KHR)) {
            if (performance.now() - start > 10000) throw Error('Retirement deadline');
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }
        gl.deleteProgram(program);
      }
      for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame);
      return { mode, initialError, beforeRetirementError, finalError: gl.getError(), lost: gl.isContextLost(),
        enabledKhr: Boolean(ext), timeOrigin: performance.timeOrigin, capturedAt: performance.now(), retirement: adapter?.snapshot() };
    }, mode);
    records.push({ result, warnings, logs, warningCount, logCount, logDropped: logCount - logs.length });await cdp.detach();await page.close();
  }
  const after = await evidenceFingerprint('tools/programretirementdiag.js');
  const report = { before, after, browserVersion: browser.version(), records,
    scope: 'Raw 12-program link/delete controls. KHR activation and explicit completion are isolated. No game runtime/performance or universal browser claim.' };
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  assert.deepEqual(before, after);
  for (const record of records.filter(r => r.result.mode !== 'khr-delete')) {
    assert.equal(record.result.initialError, 0);assert.equal(record.result.beforeRetirementError, 0);
    assert.equal(record.result.finalError, 0);assert.equal(record.result.lost, false);assert.equal(record.warningCount, 0);
  }
  const guarded = records.find(r => r.result.mode === 'khr-adapter-delete').result.retirement;
  assert.equal(guarded.pending, 0);assert.equal(guarded.nativeDeletes, 12);assert.deepEqual(guarded.faults, []);
  console.log(JSON.stringify({ out, browser: report.browserVersion, records: records.map(r => ({ ...r.result, warnings: r.warnings.length, logs: r.logs.length })) }));
} catch (error) {
  await writeFile(`${out}/failure.json`, JSON.stringify({ before, records, error: String(error), stack: error.stack }, null, 2));throw error;
} finally { await browser?.close();await new Promise(resolve => server.close(resolve)); }
