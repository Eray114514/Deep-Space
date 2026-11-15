import assert from 'node:assert/strict';
import { AdaptiveQualityGovernor, FrameGpuTimer } from '../src/adaptive-quality.js';

function simulate(gov, state, { durationMs, stepMs, cpuWorkMs, gpuWorkMs, activeMs = stepMs, streaming = false }) {
  const transitions = [];
  const end = state.now + durationMs;
  while (state.now < end) {
    state.now += stepMs;
    const gpuVal = typeof gpuWorkMs === 'function' ? gpuWorkMs(state) : gpuWorkMs;
    const cpuVal = typeof cpuWorkMs === 'function' ? cpuWorkMs(state) : cpuWorkMs;
    const actVal = typeof activeMs === 'function' ? activeMs(state) : activeMs;
    const res = gov.update({
      now: state.now,
      ready: true,
      locked: false,
      streaming,
      activeMs: actVal,
      cpuWorkMs: cpuVal,
      gpuWorkMs: gpuVal,
      stage: state.stage,
      renderDpr: state.dpr,
      ceilingDpr: 1.0,
      dprMin: 0.9,
    });
    if (res.action === 'stage') {
      state.stage = res.stage;
      state.dpr = state.stage >= 5 ? 0.9 : state.stage >= 4 ? 0.92 : 1.0;
      transitions.push({ t: Math.round(state.now), stage: state.stage, dpr: state.dpr });
    } else if (res.action === 'dpr') {
      state.dpr = res.dpr;
      transitions.push({ t: Math.round(state.now), stage: state.stage, dpr: +state.dpr.toFixed(2) });
    }
  }
  return transitions;
}

// 1. Capable GPU pinned on 60 Hz VSync (activeMs = 16.67 ms, CPU 5.5 ms, GPU 9.5 ms)
//    must remain at full Ultra quality (stage 0, dpr 1.0) indefinitely.
{
  const gov = new AdaptiveQualityGovernor({ targetFrameMs: 16.67, initialNow: 0 });
  const state = { now: 0, stage: 0, dpr: 1.0 };
  const changes = simulate(gov, state, { durationMs: 20000, stepMs: 16.67, cpuWorkMs: 5.5, gpuWorkMs: 9.5 });
  assert.equal(state.stage, 0, '60 Hz VSync with <10 ms GPU load must stay at stage 0');
  assert.equal(state.dpr, 1.0);
  assert.equal(changes.length, 0);
}

// 2. High-altitude / descent streaming spikes must NOT trigger downgrade.
{
  const gov = new AdaptiveQualityGovernor({ targetFrameMs: 16.67, initialNow: 0 });
  const state = { now: 0, stage: 0, dpr: 1.0 };
  simulate(gov, state, { durationMs: 3000, stepMs: 16.67, cpuWorkMs: 5.0, gpuWorkMs: 8.0 });
  // 7 seconds of heavy chunk streaming bursts (activeMs 24 ms while streaming=true)
  const changes = simulate(gov, state, {
    durationMs: 7000, stepMs: 24.0, cpuWorkMs: 7.0, gpuWorkMs: 11.0, streaming: true,
  });
  assert.equal(state.stage, 0, 'Transient streaming bursts must not push adaptiveStage above 0');
  assert.equal(changes.length, 0);
}

// 3. Genuine overload downgrades, then 60 Hz VSync recovery (16.67 ms cadence,
//    and even 20 ms 2x100Hz cadence when CPU+GPU work < 8 ms) climbs all the way back to stage 0!
{
  const gov = new AdaptiveQualityGovernor({ targetFrameMs: 16.67, initialNow: 0 });
  const state = { now: 0, stage: 0, dpr: 1.0 };
  simulate(gov, state, { durationMs: 2500, stepMs: 16.67, cpuWorkMs: 5.0, gpuWorkMs: 7.0 });
  // 6 seconds of 28 ms CPU/GPU overload -> must downgrade significantly
  simulate(gov, state, { durationMs: 6000, stepMs: 28.0, cpuWorkMs: 26.0, gpuWorkMs: 9.0 });
  assert.ok(state.stage >= 3, `Expected downgrade to >= stage 3 under 6s 28ms overload, got ${state.stage}`);

  // Remove load, lock onto 60 Hz VSync (16.67 ms wall cadence, 5 ms CPU, 6 ms GPU) for 10s
  simulate(gov, state, { durationMs: 10000, stepMs: 16.67, cpuWorkMs: 5.0, gpuWorkMs: 6.0 });
  assert.equal(state.stage, 0, `Expected full recovery to stage 0 on 60 Hz VSync within 10s, got ${state.stage}`);
  assert.equal(state.dpr, 1.0);
}

// 4. Genuinely GPU-limited machine on 60 Hz VSync (stage 0..2 takes 20-26 ms GPU,
//    stage 3 takes 14.6 ms GPU) must settle at stage 3 and NEVER oscillate!
{
  const gov = new AdaptiveQualityGovernor({ targetFrameMs: 16.67, initialNow: 0 });
  const state = { now: 0, stage: 0, dpr: 1.0 };
  const gpuCostByStage = [26.0, 22.5, 19.8, 14.6, 12.8, 11.2];
  const changes = simulate(gov, state, {
    durationMs: 30000,
    stepMs: 16.67,
    cpuWorkMs: 5.2,
    gpuWorkMs: (s) => gpuCostByStage[s.stage],
    activeMs: (s) => Math.max(16.67, gpuCostByStage[s.stage]),
  });
  assert.equal(state.stage, 3, `Expected steady convergence to stage 3, got ${state.stage}`);
  // After reaching stage 3, zero further oscillation transitions over remaining ~20s!
  const firstAt3 = changes.findIndex((c) => c.stage === 3);
  assert.ok(firstAt3 >= 0);
  assert.equal(changes.slice(firstAt3 + 1).length, 0, 'Must hold stage 3 with zero ping-pong oscillation');
}

// 5. Fallback without EXT_disjoint_timer_query_webgl2 (gpuWorkMs = null):
//    recovers on 60 Hz VSync when light, and bounce-backoff prevents oscillation when GPU-heavy!
{
  const gov = new AdaptiveQualityGovernor({ targetFrameMs: 16.67, initialNow: 0 });
  const state = { now: 0, stage: 0, dpr: 1.0 };
  simulate(gov, state, { durationMs: 2500, stepMs: 16.67, cpuWorkMs: 5.0, gpuWorkMs: null });
  simulate(gov, state, { durationMs: 6000, stepMs: 28.0, cpuWorkMs: 25.0, gpuWorkMs: null });
  assert.ok(state.stage >= 3);
  simulate(gov, state, { durationMs: 10000, stepMs: 16.67, cpuWorkMs: 5.0, gpuWorkMs: null });
  assert.equal(state.stage, 0, 'Fallback mode without GPU timer must also recover to stage 0 on 60 Hz VSync');

  // Now simulate hidden GPU load without GPU timer where stage <= 2 drops to 42 FPS (23.8 ms)
  // while stage 3 holds 60 Hz VSync (16.67 ms): bounce-backoff must bound transitions!
  const changes = simulate(gov, state, {
    durationMs: 35000,
    stepMs: 16.67,
    cpuWorkMs: 5.0,
    gpuWorkMs: null,
    activeMs: (s) => (s.stage <= 2 ? 23.8 : 16.67),
  });
  assert.equal(state.stage, 3);
  assert.ok(changes.length <= 9, `Bounce backoff must prevent endless ping-pong, got ${changes.length} transitions`);
}

// 6. FrameGpuTimer skips nested queries when an external TIME_ELAPSED_EXT query is active.
{
  let created = 0, activeExternal = true;
  const mockExt = { TIME_ELAPSED_EXT: 0x88BF, GPU_DISJOINT_EXT: 0x8FBB };
  const mockGl = {
    CURRENT_QUERY: 0x8865,
    QUERY_RESULT_AVAILABLE: 0x8867,
    QUERY_RESULT: 0x8866,
    isContextLost: () => false,
    getExtension: (name) => (name === 'EXT_disjoint_timer_query_webgl2' ? mockExt : null),
    getParameter: () => false,
    getQuery: () => (activeExternal ? {} : null),
    createQuery: () => { created++; return {}; },
    beginQuery() {},
    endQuery() {},
    getQueryParameter: (_q, pname) => (pname === 0x8867 ? true : 8_400_000),
    deleteQuery() {},
  };
  const timer = new FrameGpuTimer({ getContext: () => mockGl, domElement: null }, { sampleEvery: 1 });
  timer.measure(() => true);
  assert.equal(created, 0, 'Must never start nested TIME_ELAPSED_EXT when external query is active');
  activeExternal = false;
  timer.measure(() => true);
  assert.equal(created, 1);
  timer.measure(() => true);
  assert.ok(Math.abs(timer.latestMs() - 8.4) < 1e-6);
  timer.dispose();
}

// 7. Timerless fallback under realistic 60 Hz D3D11/RAF presentation micro-jitter
//    (activeEmaMs ~19.3-20.2 ms due to ~18% 2-VBlank 33.3 ms beats while CPU is ~7.9 ms)
//    plus steady 50 Hz / 20 ms display cadence: must stay at stage 0, never slip
//    further down on recovery, and climb all the way back to stage 0 within 10 s.
{
  const gov = new AdaptiveQualityGovernor({ targetFrameMs: 16.67, initialNow: 0 });
  const state = { now: 0, stage: 0, dpr: 1.0 };
  let frameIdx = 0;
  const jittery60Hz = () => {
    frameIdx++;
    // Deterministic 11-frame pattern: nine ~16.7 ms single-VBlank frames and two
    // 33.3 ms missed-beat frames -> mean 19.7 ms (> 17.5 ms), median/p70 ~16.7 ms.
    const slot = frameIdx % 11;
    if (slot === 4 || slot === 9) return 33.33;
    return 16.55 + (slot % 3) * 0.12;
  };
  const normalChanges = simulate(gov, state, {
    durationMs: 8000,
    stepMs: 19.7,
    activeMs: jittery60Hz,
    cpuWorkMs: 7.9,
    gpuWorkMs: null,
  });
  assert.ok(gov.snapshot().activeEmaMs > 18.8,
    `Expected jittery 60 Hz activeEmaMs > 18.8 ms, got ${gov.snapshot().activeEmaMs}`);
  assert.equal(state.stage, 0, 'Jittery 60 Hz VSync with 7.9 ms CPU must stay at stage 0');
  assert.equal(normalChanges.length, 0);

  // Induce overload -> downgrades to >= stage 4
  simulate(gov, state, { durationMs: 8000, stepMs: 36.0, activeMs: 36.0, cpuWorkMs: 30.0, gpuWorkMs: null });
  const overloadedStage = state.stage;
  assert.ok(overloadedStage >= 4, `Expected >= stage 4 after overload, got ${overloadedStage}`);

  // Switch back to jittery 60 Hz VSync for 10 s: must NOT slip higher and must recover to stage 0
  const recoveryChanges = simulate(gov, state, {
    durationMs: 10000,
    stepMs: 19.7,
    activeMs: jittery60Hz,
    cpuWorkMs: 7.9,
    gpuWorkMs: null,
  });
  assert.ok(recoveryChanges.every((c) => c.stage <= overloadedStage),
    `Recovery on jittery 60 Hz must not downgrade further from stage ${overloadedStage}: ${JSON.stringify(recoveryChanges)}`);
  assert.equal(state.stage, 0,
    `Expected full recovery to stage 0 on jittery 60 Hz within 10 s, got stage ${state.stage}`);
  assert.equal(state.dpr, 1.0);

  // Steady 50 Hz / 20.0 ms display cadence also stays at stage 0 and recovers cleanly
  const gov50 = new AdaptiveQualityGovernor({ targetFrameMs: 16.67, initialNow: 0 });
  const state50 = { now: 0, stage: 0, dpr: 1.0 };
  simulate(gov50, state50, { durationMs: 6000, stepMs: 20.0, activeMs: 20.0, cpuWorkMs: 7.3, gpuWorkMs: null });
  assert.equal(state50.stage, 0, 'Steady 50 Hz / 20 ms VSync must stay at stage 0');
  simulate(gov50, state50, { durationMs: 6000, stepMs: 30.0, activeMs: 30.0, cpuWorkMs: 26.0, gpuWorkMs: null });
  assert.ok(state50.stage >= 3);
  simulate(gov50, state50, { durationMs: 10000, stepMs: 20.0, activeMs: 20.0, cpuWorkMs: 7.3, gpuWorkMs: null });
  assert.equal(state50.stage, 0, 'Steady 50 Hz / 20 ms VSync must recover to stage 0 within 10 s');

  // Genuine quantized VSync GPU overload (alternating 16.67 / 33.33 ms = 40 FPS at stage <= 2) still downgrades!
  let qIdx = 0;
  simulate(gov, state, {
    durationMs: 12000,
    stepMs: 20.0,
    cpuWorkMs: 5.5,
    gpuWorkMs: null,
    activeMs: (s) => {
      qIdx++;
      if (s.stage <= 2) return qIdx % 2 === 0 ? 33.33 : 16.67;
      return jittery60Hz();
    },
  });
  assert.equal(state.stage, 3, `Quantized 40 FPS VSync GPU overload must settle at stage 3, got ${state.stage}`);
}

// 8. gpuEmaMs expires cleanly when GPU timer sampling stops (skip: true when profiler
//    opens, or latestMs() ages out to null), falling back to timerless overload detection.
{
  let resultAvailable = true;
  const mockExt = { TIME_ELAPSED_EXT: 0x88BF, GPU_DISJOINT_EXT: 0x8FBB };
  const mockGl = {
    CURRENT_QUERY: 0x8865,
    QUERY_RESULT_AVAILABLE: 0x8867,
    QUERY_RESULT: 0x8866,
    isContextLost: () => false,
    getExtension: (name) => (name === 'EXT_disjoint_timer_query_webgl2' ? mockExt : null),
    getParameter: () => false,
    getQuery: () => null,
    createQuery: () => ({}),
    beginQuery() {},
    endQuery() {},
    getQueryParameter: (_q, pname) => (pname === 0x8867 ? resultAvailable : 8_800_000),
    deleteQuery() {},
  };
  const timer = new FrameGpuTimer(
    { getContext: () => mockGl, domElement: null },
    { sampleEvery: 3, maxSampleAgeFrames: 18 },
  );
  const gov = new AdaptiveQualityGovernor({ targetFrameMs: 16.67, initialNow: 0 });
  const state = { now: 0, stage: 0, dpr: 1.0 };

  const stepWithTimer = (frames, { skip = false, activeMs = 16.67, cpuWorkMs = 5.5 } = {}) => {
    for (let i = 0; i < frames; i++) {
      timer.measure(() => true, { skip });
      state.now += activeMs;
      const res = gov.update({
        now: state.now,
        ready: true,
        locked: false,
        streaming: false,
        activeMs,
        cpuWorkMs,
        gpuWorkMs: timer.latestMs(),
        stage: state.stage,
        renderDpr: state.dpr,
        ceilingDpr: 1.0,
        dprMin: 0.9,
      });
      if (res.action === 'stage') state.stage = res.stage;
      else if (res.action === 'dpr') state.dpr = res.dpr;
    }
  };

  // Warm up with active GPU timer (~8.8 ms GPU)
  stepWithTimer(150, { skip: false, activeMs: 16.67, cpuWorkMs: 5.5 });
  assert.ok(timer.latestMs() !== null && Math.abs(timer.latestMs() - 8.8) < 0.05);
  assert.ok(gov.snapshot().gpuEmaMs !== null && Math.abs(gov.snapshot().gpuEmaMs - 8.8) < 0.2);

  // Case A: profiler turns on (skip: true) -> both timer.latestMs() and gov.gpuEmaMs must expire to null!
  stepWithTimer(45, { skip: true, activeMs: 16.67, cpuWorkMs: 5.5 });
  assert.equal(timer.latestMs(), null, 'FrameGpuTimer.latestMs() must clear when skip: true persists');
  assert.equal(gov.snapshot().gpuEmaMs, null, 'AdaptiveQualityGovernor.gpuEmaMs must expire to null when sampling is skipped');

  // With gpuEmaMs expired, a 24.2 ms hidden GPU overload (under ipcCeilingMs=25.5 ms!)
  // must now be caught by the timerless fallback instead of masked by stale 8.8 ms gpuEmaMs!
  stepWithTimer(120, { skip: true, activeMs: 24.2, cpuWorkMs: 5.5 });
  assert.ok(state.stage >= 1, `Timerless fallback must catch 24.2 ms GPU overload once gpuEmaMs expires, got stage ${state.stage}`);

  // Case B: resume sampling, repopulate gpuEmaMs, then stall query availability past maxSampleAgeFrames
  stepWithTimer(20, { skip: false, activeMs: 16.67, cpuWorkMs: 5.5 });
  assert.ok(gov.snapshot().gpuEmaMs !== null, 'gpuEmaMs should repopulate when timer resumes');
  resultAvailable = false;
  stepWithTimer(60, { skip: false, activeMs: 16.67, cpuWorkMs: 5.5 });
  assert.equal(timer.latestMs(), null, 'FrameGpuTimer.latestMs() must age out when queries stop resolving');
  assert.equal(gov.snapshot().gpuEmaMs, null, 'AdaptiveQualityGovernor.gpuEmaMs must expire after latestMs() ages out');

  timer.dispose();
}

console.log('PASS: adaptive quality VSync awareness, streaming spike immunity, jittery 60 Hz fallback recovery, stale GPU expiry and anti-oscillation');
