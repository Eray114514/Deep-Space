import assert from 'node:assert/strict';
import vm from 'node:vm';
import { installFoundationGLProbe } from './foundation-gl-probe.js';

function fixture(extraMethods = 0) {
  let time = 0;
  let pendingError = 0;
  let errorCalls = 0;
  let failDraw = false;
  const deletedPrograms = new WeakSet();
  const prototype = {};
  const native = {};
  const gl = Object.create(prototype);
  const method = (name, fn) => {
    const original = function (...args) {
      assert.equal(this, gl, `${name} must preserve its GL receiver`);
      return fn(...args);
    };
    native[name] = original;
    Object.defineProperty(prototype, name, { configurable: true, writable: true, value: original });
  };
  method('getError', () => { errorCalls++; const value = pendingError; pendingError = 0; return value; });
  method('createShader', type => ({ type }));
  method('shaderSource', () => {});
  method('compileShader', () => { time += 17; });
  method('getShaderParameter', () => true);
  method('createProgram', () => ({}));
  method('attachShader', () => {});
  method('detachShader', () => {});
  method('linkProgram', () => { time += 23; });
  method('useProgram', () => {});
  method('deleteShader', () => {});
  method('deleteProgram', program => { if (program) deletedPrograms.add(program); });
  method('getProgramParameter', (program, parameter) => {
    if (deletedPrograms.has(program)) { pendingError = 1281; return null; }
    if (parameter === 0x8b86) return 0;
    return true;
  });
  method('getProgramInfoLog', () => '');
  method('getActiveUniform', () => null);
  method('getActiveAttrib', () => null);
  method('isProgram', program => !deletedPrograms.has(program));
  method('drawElements', () => { time += 12; if (failDraw) pendingError = 1281; });
  method('texImage2D', () => { time += 3; });
  method('throwingAPI', () => { throw new Error('native API failed'); });
  for (let index = 0; index < extraMethods; index++) method(`extra${index}`, () => {});
  const pipeline = {
    updateCloudLighting() { gl.compileShader(shader); },
    volumePass: { render() { gl.useProgram(program); gl.drawElements(4, 3, 5123, 0); } },
    renderPass: { render() { gl.texImage2D(1, 2, 3); } },
    render() { this.updateCloudLighting(); this.renderPass.render(); this.volumePass.render(); },
  };
  const originalRender = pipeline.render;
  const originalVolume = pipeline.volumePass.render;
  const host = { NMS: { _renderer: { getContext: () => gl }, _pipeline: pipeline } };
  const sandbox = vm.createContext({ window: host, performance: { now: () => time } });
  // Execute the serialized body, exactly as browser page.evaluate does. An
  // accidental module closure would fail in this isolated context.
  const installed = vm.runInContext(`(${installFoundationGLProbe.toString()})()`, sandbox);
  const probe = host.__foundationGLProbe;
  const shader = gl.createShader(35632);
  const program = gl.createProgram();
  return { gl, native, pipeline, probe, installed, shader, program, originalRender, originalVolume,
    errors: () => errorCalls, setError: value => { pendingError = value; },
    failDraw: value => { failDraw = value; }, host, sandbox };
}

{
  const f = fixture();
  f.probe.mark('cold-first-cloud');
  f.gl.shaderSource(f.shader, 'void main() { gl_FragColor = vec4(1.0); }');
  f.gl.attachShader(f.program, f.shader);
  f.gl.linkProgram(f.program);
  f.pipeline.render();
  const data = f.probe.snapshot();
  assert.equal(f.errors(), 0, 'passive timing must not issue getError');
  assert.equal(data.errorChecks, 0);
  assert.equal(data.mode, 'passive-timing');
  assert.equal(data.performanceAcceptanceAllowed, true);
  assert.equal(data.shaders[0].source.includes('gl_FragColor'), true);
  assert.equal(data.programs[0].shaderIds[0], data.shaders[0].id);
  const link = data.slowCalls.find(row => row.name === 'linkProgram');
  assert.equal(link.ms, 23);
  assert.equal(link.programId, data.programs[0].id);
  const compile = data.slowCalls.find(row => row.name === 'compileShader');
  assert.equal(compile.stage, 'cold-first-cloud');
  assert.equal(compile.scope, 'pipeline.render > pipeline.updateCloudLighting');
  assert.equal(compile.attachedProgramIds[0], data.programs[0].id);
  assert.match(compile.stack, /foundation|wrapper|compileShader/);
  const draw = data.slowCalls.find(row => row.name === 'drawElements');
  assert.equal(draw.scope, 'pipeline.render > volumePass.render');
  assert.equal(draw.programId, data.programs[0].id);
  assert.equal(data.totals.find(row => row.name === 'drawElements').calls, 1);
  assert.equal(data.totals.find(row => row.name === 'pipeline.render').totalMs, 32);
  assert.equal(data.scope, 'outside-pipeline-scope');
  assert.doesNotThrow(() => JSON.stringify(data));
  f.setError(1282);
  assert.equal(f.gl.getError(), 1282, 'passive application getError must retain native behavior');
  assert.equal(f.errors(), 1);
  f.probe.dispose();
  assert.equal(f.gl.drawElements, f.native.drawElements);
  assert.equal(Object.hasOwn(f.gl, 'drawElements'), false);
  assert.equal(f.pipeline.render, f.originalRender);
  assert.equal(f.pipeline.volumePass.render, f.originalVolume);
  assert.equal(f.probe.snapshot().disposed, true);
  assert.throws(() => f.probe.armErrors(), /disposed/);
}

{
  const f = fixture();
  const unknown = {};f.native.deleteProgram.call(f.gl, unknown);
  assert.equal(f.gl.getProgramParameter(unknown, 0x91b1), null);
  const data = f.probe.snapshot();
  assert.equal(f.errors(), 0, 'Failed-query capture must remain passive');
  assert.equal(data.slowCalls.length, 0);
  assert.equal(data.programQueryFailures.length, 1);
  const id = data.programQueryFailures[0].queriedProgramId;
  assert.ok(Number.isInteger(id));assert.notEqual(id, data.programs[0].id, 'Unknown queried handle must not inherit the current draw program');
  assert.equal(data.programs.find(p => p.id === id).creationUnobserved, true);
  assert.equal(data.programQueryFailures[0].parameter, 0x91b1);
  assert.ok(data.programQueryFailures[0].stack.includes('wrapper'));
  assert.equal(f.gl.getError(), 1281, 'Native error must remain available to the application');
  for (let i = 0; i < 130; i++) f.gl.getProgramParameter(unknown, 0x91b1);
  assert.equal(f.probe.snapshot().programQueryFailures.length, data.limits.programQueryFailures);
  assert.equal(f.probe.snapshot().dropped.programQueryFailures, 3);
  f.probe.dispose();
}

{
  const f = fixture(), unknown = {};
  f.gl.useProgram(unknown);
  f.gl.getActiveUniform(unknown, 3);
  const data = f.probe.snapshot(), row = data.programQueryObservations[0];
  assert.equal(f.errors(), 0);assert.equal(row.name, 'getActiveUniform');assert.equal(row.result, null);
  assert.equal(row.queriedProgramId, data.programs.find(p => p.creationUnobserved).id);
  assert.equal(data.programQueryFailures.length, 0, 'Empty reflection alone is not a GL failure');
  assert.equal(f.gl.getProgramParameter(unknown, 0x8b86), 0);
  assert.equal(f.probe.snapshot().programQueryObservations.at(-1).result, 0);
  assert.equal(f.probe.snapshot().programQueryFailures.length, 0);assert.equal(f.errors(), 0);
  f.gl.deleteProgram(unknown);f.gl.useProgram(unknown);
  assert.equal(f.probe.snapshot().programQueryObservations.at(-1).deletedUse, true);
  for (let i = 0; i < 140; i++) f.gl.getActiveAttrib(f.program, 0);
  assert.equal(f.probe.snapshot().programQueryObservations.length, data.limits.programQueryObservations);
  assert.ok(f.probe.snapshot().dropped.programQueryObservations > 0);f.probe.dispose();
}

{
  const f = fixture();
  f.probe.mark('error-reproduction');
  f.setError(1282);
  const arm = f.probe.armErrors();
  assert.equal(arm.preexisting, 1282);
  assert.equal(arm.performanceAcceptanceAllowed, false);
  assert.equal(f.errors(), 1, 'arming must read exactly one preexisting error');
  f.gl.useProgram(f.program);
  assert.equal(f.errors(), 2);
  f.failDraw(true);
  f.pipeline.volumePass.render();
  const after = f.probe.snapshot();
  assert.equal(after.firstError.name, 'drawElements');
  assert.equal(after.firstError.error, 1281);
  assert.equal(after.firstError.programId, after.programs[0].id);
  assert.equal(after.firstError.args[0], 4);
  assert.equal(after.firstError.stage, 'error-reproduction');
  assert.equal(after.firstError.scope, 'volumePass.render');
  assert.equal(after.firstError.consumedByApplication, false);
  assert.equal(after.errorArms[0].preexisting, 1282, 'preexisting error must remain disclosed');
  assert.equal(after.armed, false);
  assert.equal(after.mode, 'intrusive-error-attribution');
  assert.equal(after.performanceAcceptanceAllowed, false);
  const callsAtFailure = f.errors();
  f.gl.drawElements(4, 3, 5123, 0);
  assert.equal(f.errors(), callsAtFailure, 'first API error must stop per-call checking');
  assert.equal(f.gl.getError(), 1281, 'after disarming, application receives native pending error');
  f.probe.dispose();
}

{
  const f = fixture();f.gl.useProgram(f.program);f.probe.armErrors();f.setError(1281);
  f.gl.getProgramParameter(null, 0x8b86);
  assert.equal(f.probe.snapshot().firstError.programId, null, 'An explicit null handle must not inherit the last requested draw program');
  assert.equal(f.probe.snapshot().firstError.args[0], null);f.probe.dispose();
}

{
  const f = fixture();
  f.probe.armErrors();
  f.setError(1281);
  assert.equal(f.gl.getError(), 1281);
  const data = f.probe.snapshot();
  assert.equal(data.firstError.name, 'getError');
  assert.equal(data.firstError.consumedByApplication, true);
  assert.equal(f.errors(), 2, 'application getError must not be followed by a second read');
  f.probe.dispose();
}

{
  const f = fixture(540);
  const source = 'x'.repeat(3 * 1024 * 1024);
  for (let index = 0; index < 132; index++) {
    const shader = f.gl.createShader(35632);
    f.gl.shaderSource(shader, source);
    f.gl.createProgram();
  }
  for (let index = 0; index < 300; index++) f.gl.drawElements(4, 3, 5123, 0);
  for (let index = 0; index < 160; index++) f.probe.mark(`stage-${index}`);
  for (let index = 0; index < 540; index++) f.gl[`extra${index}`]();
  assert.throws(() => f.gl.throwingAPI(), /native API failed/);
  const data = f.probe.snapshot();
  assert.equal(data.slowCalls.length, data.limits.slowCalls);
  assert.equal(data.dropped.slowCalls, 44);
  assert.equal(data.marks.length, data.limits.marks);
  assert.equal(data.shaders.length, data.limits.shaders);
  assert.equal(data.programs.length, data.limits.programs);
  assert.equal(data.totals.length, data.limits.methods);
  assert.ok(data.dropped.methods > 0);
  assert.ok(data.dropped.shaderChars > 0);
  assert.ok(data.dropped.shaders > 0);
  assert.ok(data.dropped.programs > 0);
  assert.ok(data.shaderChars <= data.limits.shaderBytes / 2);
  assert.equal(f.errors(), 0);
  f.probe.dispose();
}

{
  const f = fixture();
  f.probe.mark('valid-inspection');
  assert.equal(f.gl.getProgramParameter(f.program, 0x91b1), true);
  assert.equal(f.probe.snapshot().lifetimeFaults.length, 0);
  f.probe.mark('retired-owner');
  f.gl.deleteProgram(f.program);
  // Also capture a startup handle that existed before probe installation.
  const predatesProbe = f.native.createProgram.call(f.gl);
  f.gl.deleteProgram(predatesProbe);
  f.probe.mark('late-readiness-poll');
  assert.equal(f.gl.isProgram(f.program), false, 'isProgram on a deleted handle is legitimate');
  assert.equal(f.probe.snapshot().lifetimeFaults.length, 0);
  assert.equal(f.gl.getProgramParameter(f.program, 0x91b1), null);
  f.gl.getProgramInfoLog(predatesProbe);
  f.gl.getActiveUniform(f.program, 0);
  f.gl.getActiveAttrib(f.program, 0);
  const data = f.probe.snapshot();
  assert.equal(data.lifetimeFaults.length, 4);
  assert.equal(data.lifetimeFaults[0].name, 'getProgramParameter');
  assert.equal(data.lifetimeFaults[0].stage, 'late-readiness-poll');
  assert.equal(data.lifetimeFaults[0].deletion.stage, 'retired-owner');
  assert.match(data.lifetimeFaults[0].stack, /wrapper|inspectLifetime/);
  assert.match(data.lifetimeFaults[0].deletion.stack, /wrapper|track/);
  assert.equal(data.programs.find(program => program.id === data.lifetimeFaults[1].programId).creationUnobserved, true);
  assert.equal(data.totals.find(row => row.name === 'getProgramParameter').slowCalls, 0,
    'fast stale KHR polls must still retain lifetime evidence');
  assert.equal(f.errors(), 0, 'passive lifetime capture must not ask GL for validity or errors');
  assert.equal(f.gl.getError(), 1281, 'passive capture must preserve the native pending error');
  assert.equal(data.mode, 'passive-timing');
  assert.equal(data.performanceAcceptanceAllowed, true);
  assert.doesNotThrow(() => JSON.stringify(data));
  for (let index = 0; index < data.limits.lifetimeFaults + 8; index++) f.gl.getProgramInfoLog(f.program);
  const capped = f.probe.snapshot();
  assert.equal(capped.lifetimeFaults.length, capped.limits.lifetimeFaults);
  assert.equal(capped.dropped.lifetimeFaults, 12);
  data.lifetimeFaults[0].deletion.stage = 'external-mutation';
  assert.equal(f.probe.snapshot().lifetimeFaults[0].deletion.stage, 'retired-owner');
  f.probe.dispose();
  assert.equal(f.gl.getProgramParameter, f.native.getProgramParameter);
  assert.equal(f.gl.deleteProgram, f.native.deleteProgram);
}

{
  const f = fixture();
  const replaced = () => {};
  f.gl.drawElements = replaced;
  f.probe.dispose();
  assert.equal(f.gl.drawElements, replaced, 'dispose must not overwrite instrumentation installed later');
  vm.runInContext(`(${installFoundationGLProbe.toString()})()`, f.sandbox);
  assert.notEqual(f.host.__foundationGLProbe, f.probe);
  f.host.__foundationGLProbe.dispose();
}

console.log('PASS: serialized GL probe passive/active contracts, scope/program lifetime attribution, caps and restoration');
