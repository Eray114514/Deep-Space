// Diagnostic injection only. This function deliberately has no module closures so
// Playwright can serialize it with page.evaluate(installFoundationGLProbe).
export function installFoundationGLProbe(acquiredContext = null) {
  const host = window;
  const nms = host.NMS;
  if (!acquiredContext && !nms?._renderer?.getContext) throw new Error('Foundation GL probe needs NMS._renderer or an acquired context');
  host.__foundationGLProbe?.dispose?.();
  const gl = acquiredContext || nms._renderer.getContext();
  const installedAtMs = performance.now();
  const originalGetError = gl.getError;
  // Navigation capture includes boot/ship programs absent from the post-boot
  // observer (164 shaders in the measured scene). Keep an explicit bounded
  // budget for that larger scope, without changing ordinary capture limits.
  const limits = { methods: 512, slowCalls: 256, lifetimeFaults: 128, programQueryFailures: 128, programQueryObservations: 128, marks: 128, shaders: acquiredContext ? 256 : 128, programs: 128,
    shaderBytes: (acquiredContext ? 16 : 8) * 1024 * 1024, shaderChars: 2 * 1024 * 1024, stackChars: 5000 };
  const totals = new Map();
  const slowCalls = [];
  const lifetimeFaults = [];
  const programQueryFailures = [];
  const programQueryObservations = [];
  const marks = [];
  const shaders = new Map();
  const programs = new Map();
  const shaderIds = new WeakMap();
  const programIds = new WeakMap();
  const restores = [];
  const scopeNames = [];
  const scopeStack = [];
  const faults = [];
  const dropped = { methods: 0, slowCalls: 0, lifetimeFaults: 0, programQueryFailures: 0, programQueryObservations: 0, marks: 0, shaders: 0, programs: 0, shaderChars: 0 };
  // These APIs require a live program handle. isProgram is intentionally not
  // included: testing a deleted handle is a valid application operation.
  const programInspections = new Set(['getProgramParameter', 'getProgramInfoLog',
    'getAttachedShaders', 'getActiveUniform', 'getActiveAttrib', 'getUniformLocation',
    'getAttribLocation', 'getUniform', 'getUniformIndices', 'getActiveUniforms',
    'getUniformBlockIndex', 'getActiveUniformBlockParameter', 'getActiveUniformBlockName',
    'getFragDataLocation', 'getTransformFeedbackVarying']);
  const programArguments = new Set([...programInspections, 'useProgram', 'linkProgram', 'validateProgram',
    'attachShader', 'detachShader', 'deleteProgram', 'bindAttribLocation', 'transformFeedbackVaryings']);
  let stage = 'installed';
  let disposed = false;
  let armed = false;
  let errorChecks = 0;
  let currentProgram = null;
  let nextShaderId = 1;
  let nextProgramId = 1;
  let shaderChars = 0;
  let firstError = null;
  const errorArms = [];
  const clock = () => performance.now();
  const stack = () => String(new Error().stack || '').slice(0, limits.stackChars);
  const scope = () => scopeStack.join(' > ') || 'outside-pipeline-scope';
  const location = () => ({ stage, scope: scope(), atMs: clock() });
  const resource = (value, ids) => value && (typeof value === 'object' || typeof value === 'function') ? ids.get(value) || null : null;
  const observeProgram = (name, args, callLocation) => {
    if (!programArguments.has(name) || !args[0] || typeof args[0] !== 'object' || programIds.has(args[0])) return;
    const id = nextProgramId++;programIds.set(args[0], id);
    if (programs.size < limits.programs) programs.set(id,
      { id, shaderIds: [], deleted: false, creationUnobserved: true, firstObserved: { name, ...callLocation } });
    else dropped.programs++;
  };
  const summarize = value => {
    const shaderId = resource(value, shaderIds);
    if (shaderId) return { shaderId };
    const programId = resource(value, programIds);
    if (programId) return { programId };
    if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value ?? null;
    if (typeof value === 'string') return { type: 'string', length: value.length, preview: value.slice(0, 100) };
    if (ArrayBuffer.isView(value)) return { type: value.constructor?.name || 'ArrayBufferView', length: value.length ?? null, byteLength: value.byteLength };
    if (value instanceof ArrayBuffer) return { type: 'ArrayBuffer', byteLength: value.byteLength };
    if (Array.isArray(value)) return { type: 'Array', length: value.length, preview: value.slice(0, 8).map(v => typeof v === 'number' ? v : typeof v) };
    return { type: value?.constructor?.name || typeof value };
  };
  const context = (name, args) => {
    const explicitProgram = resource(args[0], programIds);
    const shaderId = resource(args[0], shaderIds);
    return { programId: programArguments.has(name) ? explicitProgram : currentProgram, shaderId,
      ...(shaderId ? { attachedProgramIds: [...programs.values()].filter(p => p.shaderIds.includes(shaderId)).map(p => p.id) } : {}) };
  };
  const record = (kind, name, ms, args, callLocation, callContext, threw) => {
    const key = `${kind}:${name}`;
    let row = totals.get(key);
    if (!row && totals.size < limits.methods) {
      row = { kind, name, calls: 0, totalMs: 0, maxMs: 0, slowCalls: 0, throws: 0 };
      totals.set(key, row);
    }
    if (row) {
      row.calls++;
      row.totalMs += ms;
      row.maxMs = Math.max(row.maxMs, ms);
      row.throws += threw ? 1 : 0;
      if (ms >= 10) row.slowCalls++;
    } else dropped.methods++;
    if (ms < 10) return;
    if (slowCalls.length >= limits.slowCalls) { dropped.slowCalls++; return; }
    slowCalls.push({ kind, name, ms, ...callLocation, ...callContext,
      args: args.slice(0, 10).map(summarize), threw, stack: stack() });
  };
  const inspectLifetime = (name, args, callLocation) => {
    if (!programInspections.has(name)) return;
    const row = programs.get(resource(args[0], programIds));
    if (!row?.deleted) return;
    if (lifetimeFaults.length >= limits.lifetimeFaults) { dropped.lifetimeFaults++; return; }
    // This is JS handle-lifetime evidence, not an extra native validity/error
    // query. Keep fast stale KHR polls that do not reach the slow-call limit.
    lifetimeFaults.push({ name, ...callLocation, programId: row.id,
      args: args.slice(0, 10).map(summarize), stack: stack(),
      deletion: { ...row.deletion } });
  };
  const track = (name, args, result, callLocation) => {
    if (name === 'createShader' && result) {
      const id = nextShaderId++;
      shaderIds.set(result, id);
      if (shaders.size < limits.shaders) shaders.set(id, { id, type: args[0], source: '', sourceLength: 0, truncated: false, deleted: false });
      else dropped.shaders++;
    } else if (name === 'createProgram' && result) {
      const id = nextProgramId++;
      programIds.set(result, id);
      if (programs.size < limits.programs) programs.set(id, { id, shaderIds: [], deleted: false });
      else dropped.programs++;
    } else if (name === 'shaderSource') {
      const row = shaders.get(resource(args[0], shaderIds));
      if (row) {
        const source = String(args[1]);
        shaderChars -= row.source.length;
        const allowed = Math.max(0, Math.min(limits.shaderChars, limits.shaderBytes / 2 - shaderChars));
        row.source = source.slice(0, allowed);
        shaderChars += row.source.length;
        row.sourceLength = source.length;
        row.truncated = row.source.length !== source.length;
        dropped.shaderChars += source.length - row.source.length;
      }
    } else if (name === 'attachShader' || name === 'detachShader') {
      const row = programs.get(resource(args[0], programIds));
      const id = resource(args[1], shaderIds);
      if (row && id) {
        if (name === 'attachShader' && !row.shaderIds.includes(id)) row.shaderIds.push(id);
        if (name === 'detachShader') row.shaderIds = row.shaderIds.filter(value => value !== id);
      }
    } else if (name === 'useProgram') currentProgram = resource(args[0], programIds);
    else if (name === 'deleteShader') {
      const row = shaders.get(resource(args[0], shaderIds));
      if (row) row.deleted = true;
    } else if (name === 'deleteProgram') {
      const id = resource(args[0], programIds);
      const row = programs.get(id);
      if (row && !row.deleted) {
        row.deleted = true;
        row.deletion = { ...callLocation, stack: stack() };
      }
    }
  };
  const checkError = (name, args, result, callLocation, callContext) => {
    if (!armed) return;
    try {
      // getError itself consumes the error; never consume a second one here.
      const error = name === 'getError' ? result : originalGetError.call(gl);
      if (name !== 'getError') errorChecks++;
      if (error) {
        firstError = { ...callLocation, name, error, ...callContext,
          args: args.slice(0, 10).map(summarize), consumedByApplication: name === 'getError', stack: stack() };
        armed = false;
      }
    } catch (error) {
      faults.push({ ...location(), operation: 'error-check', message: String(error) });
      armed = false;
    }
  };
  const wrap = (object, name, original, kind) => {
    const own = Object.getOwnPropertyDescriptor(object, name);
    const wrapper = function (...args) {
      if (kind === 'scope') scopeStack.push(name);
      const callLocation = { stage, scope: scope(), atMs: clock() };
      if (kind === 'gl') observeProgram(name, args, callLocation);
      const callContext = kind === 'gl' ? context(name, args) : {};
      if (kind === 'gl') inspectLifetime(name, args, callLocation);
      const started = clock();
      let result;
      let failure;
      let threw = false;
      try { result = original.apply(this, args); }
      catch (error) { failure = error; threw = true; }
      const elapsed = clock() - started;
      if (kind === 'gl') {
        // Invalid queries can return null in microseconds, including for a
        // handle born before probe installation. Preserve the native result
        // and stack without adding getError/isProgram/flush synchronization.
        if (name === 'getProgramParameter' && !threw && result === null) {
          if (programQueryFailures.length < limits.programQueryFailures) programQueryFailures.push({
            ...callLocation, queriedProgramId: resource(args[0], programIds), parameter: args[1],
            argumentNull: args[0] == null, stack: stack() });
          else dropped.programQueryFailures++;
        }
        // Zero active counts and inactive locations can be legitimate. Record
        // them as observations, never as proof of a GL error. Native implicit
        // GetProgramiv failures need not become a JS null return.
        const emptyReflection = (name === 'getProgramParameter' && (result === 0 || result === null))
          || (['getActiveUniform', 'getActiveAttrib', 'getUniformLocation'].includes(name) && result === null)
          || (name === 'getAttribLocation' && result === -1);
        const deletedUse = ['useProgram', 'linkProgram', 'validateProgram'].includes(name)
          && programs.get(resource(args[0], programIds))?.deleted;
        if (!threw && (emptyReflection || deletedUse)) {
          if (programQueryObservations.length < limits.programQueryObservations) programQueryObservations.push({
            name, ...callLocation, queriedProgramId: resource(args[0], programIds), args: args.slice(0, 3).map(summarize),
            result: summarize(result), deletedUse: Boolean(deletedUse), stack: stack() });
          else dropped.programQueryObservations++;
        }
        if (!threw) track(name, args, result, callLocation);
        checkError(name, args, result, callLocation, callContext);
      }
      record(kind, name, elapsed, args, callLocation, callContext, threw);
      if (kind === 'scope') scopeStack.pop();
      if (threw) throw failure;
      return result;
    };
    try {
      Object.defineProperty(object, name, { configurable: true, writable: true, enumerable: own?.enumerable ?? false, value: wrapper });
      restores.push(() => {
        if (object[name] !== wrapper) return;
        if (own) Object.defineProperty(object, name, own);
        else delete object[name];
      });
      return true;
    } catch (error) {
      faults.push({ operation: 'wrap', name, message: String(error) });
      return false;
    }
  };
  const names = new Set();
  for (let prototype = gl; prototype && prototype !== Object.prototype; prototype = Object.getPrototypeOf(prototype)) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (name !== 'constructor' && typeof Object.getOwnPropertyDescriptor(prototype, name)?.value === 'function') names.add(name);
    }
  }
  let wrappedMethods = 0;
  for (const name of names) if (wrap(gl, name, gl[name], 'gl')) wrappedMethods++;
  const scopeOwners = new WeakMap();
  const addScope = (object, name, label) => {
    if (!object || typeof object[name] !== 'function') return;
    let names = scopeOwners.get(object);
    if (!names) { names = new Set();scopeOwners.set(object, names); }
    if (names.has(name)) return;
    names.add(name);
    // Use the readable owner-qualified name in both scope and totals.
    const own = Object.getOwnPropertyDescriptor(object, name);
    const original = object[name];
    const facade = { [label]: original };
    if (!wrap(facade, label, original, 'scope')) return;
    const wrapper = facade[label];
    try {
      Object.defineProperty(object, name, { configurable: true, writable: true, enumerable: own?.enumerable ?? false, value: wrapper });
      restores.push(() => {
        if (object[name] !== wrapper) return;
        if (own) Object.defineProperty(object, name, own);
        else delete object[name];
      });
      scopeNames.push(label);
    } catch (error) { faults.push({ operation: 'scope-wrap', name: label, message: String(error) }); }
  };
  const attachPipeline = () => {
    const pipeline = host.NMS?._pipeline;
    addScope(pipeline, 'render', 'pipeline.render');
    addScope(pipeline, 'updateCloudLighting', 'pipeline.updateCloudLighting');
    addScope(pipeline?.volumePass, 'render', 'volumePass.render');
    addScope(pipeline?.renderPass, 'render', 'sceneRenderPass.render');
    addScope(pipeline?.atmospherePass, 'render', 'atmospherePass.render');
    addScope(pipeline?.cloudSurfaceShadow, 'render', 'cloudSurfaceShadow.render');
    addScope(pipeline?.foregroundPass, 'render', 'foregroundPass.render');
  };
  attachPipeline();
  const api = {
    attachPipeline() {
      if (disposed) throw new Error('Foundation GL probe was disposed');
      attachPipeline();return [...scopeNames];
    },
    mark(value) {
      stage = String(value).slice(0, 160);
      if (marks.length < limits.marks) marks.push(location());
      else dropped.marks++;
    },
    armErrors() {
      if (disposed) throw new Error('Foundation GL probe was disposed');
      // This explicit intrusive mode is attribution only. Its preexisting
      // error is retained even when no subsequent API produces an error.
      const preexisting = originalGetError.call(gl);
      errorChecks++;
      const arm = { ...location(), preexisting };
      if (errorArms.length < limits.marks) errorArms.push(arm);
      else dropped.marks++;
      armed = firstError === null;
      return { ...arm, armed, intrusive: true, performanceAcceptanceAllowed: false };
    },
    snapshot() {
      return { installed: true, installedAtMs, disposed, stage, scope: scope(), wrappedMethods, scopeNames: [...scopeNames],
        mode: errorArms.length ? 'intrusive-error-attribution' : 'passive-timing',
        performanceAcceptanceAllowed: errorArms.length === 0, armed, errorChecks,
        firstError: firstError ? { ...firstError } : null, errorArms: errorArms.map(value => ({ ...value })),
        marks: marks.map(value => ({ ...value })), totals: [...totals.values()].map(value => ({ ...value })),
        slowCalls: slowCalls.map(value => ({ ...value })), shaders: [...shaders.values()].map(value => ({ ...value })),
        lifetimeFaults: lifetimeFaults.map(value => ({ ...value, deletion: { ...value.deletion } })),
        programQueryFailures: programQueryFailures.map(value => ({ ...value })),
        programQueryObservations: programQueryObservations.map(value => ({ ...value })),
        programs: [...programs.values()].map(value => ({ ...value, shaderIds: [...value.shaderIds],
          ...(value.deletion ? { deletion: { ...value.deletion } } : {}) })),
        shaderChars, limits: { ...limits }, dropped: { ...dropped }, faults: faults.map(value => ({ ...value })) };
    },
    dispose() {
      if (disposed) return;
      armed = false;
      for (const restore of restores.reverse()) restore();
      disposed = true;
    },
  };
  host.__foundationGLProbe = api;
  api.mark('installed');
  return { installed: true, wrappedMethods, scopeNames: [...scopeNames] };
}
