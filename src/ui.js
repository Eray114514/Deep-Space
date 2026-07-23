// HUD: system info, target card, contextual hints, land prompt,
// HUD, transitions and input affordances. Pure DOM, no dependencies.

import { ShipHUD } from './ship-hud.js';

export class UI {
  constructor(callbacks = {}) {
    this.cb = callbacks;
    this.shipHud = new ShipHUD();
    const $ = (id) => document.getElementById(id);
    this.els = {
      system: $('sys-name'), systemCatalog: $('sys-catalog'), cosmicTime: $('cosmic-time'), seed: $('sys-seed'), planetCount: $('sys-planets'),
      hint: $('hint'), land: $('land-btn'), crosshair: $('crosshair'),
      fade: $('fade'), stats: $('stats'), devFps: $('dev-fps'),
      loading: $('loading'), loadingText: $('loading-text'),
      altitude: $('flight-telemetry'),
      altitudeValue: $('altitude-value'), altitudeUnit: $('altitude-unit'),
      speedValue: $('speed-value'), speedUnit: $('speed-unit'),
      headingCardinal: $('heading-cardinal'), headingDegrees: $('heading-degrees'),
      starMapBtn: $('star-map-btn'),
      destinationMarker: $('destination-marker'), destinationMarkerName: $('destination-marker-name'),
      destinationMarkerDistance: $('destination-marker-distance'),
      routeChoice: $('route-choice'), routeChoiceName: $('route-choice-name'),
      routeWarp: $('route-warp-btn'), routeRift: $('route-rift-btn'), routeCancel: $('route-cancel-btn'),
      brandSystem: $('brand-system'),
      touchUI: $('touch-ui'), joystick: $('joystick'), knob: $('joystick-knob'),
      performanceNotice: $('performance-notice'), hero: $('hero-overlay'), heroStart: $('hero-start-btn'),
      heroSettings: $('hero-settings-btn'), graphicsPanel: $('graphics-settings-panel'),
      graphicsClose: $('graphics-settings-close'), graphicsCancel: $('graphics-settings-cancel'),
      graphicsApply: $('graphics-settings-apply'), graphicsGpu: $('graphics-gpu'),
      graphicsBackend: $('graphics-backend'), graphicsNote: $('graphics-settings-note'),
      graphicsRestartMask: $('graphics-restart-mask'),
      heroSplash: $('hero-splash'),
      heroPerfHint: $('hero-perf-hint'), perfTutorial: $('perf-tutorial'), perfTutorialClose: $('perf-tutorial-close'),
      arrivalTitle: $('arrival-title'), arrivalKicker: $('arrival-kicker'),
      arrivalName: $('arrival-name'), arrivalSystem: $('arrival-system'),
      heroSeed: $('hero-seed'), heroBuild: $('hero-build'),
      driveMode: $('drive-mode'), driveSpeed: $('drive-speed'), driveBoost: $('drive-boost'), driveAtmo: $('drive-atmo'),
      driveSpeedFill: $('drive-speed-fill'), driveBoostFill: $('drive-boost-fill'), driveAtmoFill: $('drive-atmo-fill'),
      pulseFuel: $('pulse-fuel'),
      timeWarp: $('time-warp-indicator'), timeWarpLabel: $('time-warp-label'),
      timeWarpProgress: $('time-warp-progress'), timeWarpRate: $('time-warp-rate'),
    };
    this.els.land.addEventListener('click', () => this.cb.onLand && this.cb.onLand());
    this.els.starMapBtn.addEventListener('click', () => this.cb.onStarMap && this.cb.onStarMap());
    this.els.routeWarp.addEventListener('click', () => this.cb.onRouteWarp?.());
    this.els.routeRift.addEventListener('click', () => this.cb.onRouteRift?.());
    this.els.routeCancel.addEventListener('click', () => this.cb.onRouteCancel?.());
    this.els.heroStart.addEventListener('click', () => {
      // The overlay fades while main.js runs the pull-back camera cinematic.
      this.hideHero();
      this.cb.onStart?.();
      window.dispatchEvent(new CustomEvent('game-user-start'));
    });
    this.els.heroSettings?.addEventListener('click', () => this.showGraphicsSettings(true));
    this.els.graphicsClose?.addEventListener('click', () => this.showGraphicsSettings(false));
    this.els.graphicsCancel?.addEventListener('click', () => this.showGraphicsSettings(false));
    this.els.graphicsPanel?.addEventListener('click', (event) => {
      if (event.target === this.els.graphicsPanel) this.showGraphicsSettings(false);
    });
    this.els.graphicsApply?.addEventListener('click', () => {
      const quality = this.els.graphicsPanel.querySelector('input[name="graphics-quality"]:checked')?.value || 'auto';
      this.els.graphicsRestartMask?.classList.remove('hidden');
      this.cb.onApplyGraphics?.({ quality });
    });
    if (this.els.heroPerfHint) {
      this.els.heroPerfHint.addEventListener('click', () => this.showPerfTutorial(true));
    }
    if (this.els.perfTutorialClose) {
      this.els.perfTutorialClose.addEventListener('click', () => this.showPerfTutorial(false));
    }
    if (this.els.perfTutorial) {
      // Click on the backdrop (not the panel) closes the dialog.
      this.els.perfTutorial.addEventListener('click', (e) => {
        if (e.target === this.els.perfTutorial) this.showPerfTutorial(false);
      });
    }
    this._perfTutorialKey = (e) => {
      if (e.key === 'Escape' && this.els.graphicsPanel && !this.els.graphicsPanel.classList.contains('hidden')) {
        e.stopImmediatePropagation();
        this.showGraphicsSettings(false);
        return;
      }
      if (e.key === 'Escape' && this.els.perfTutorial && !this.els.perfTutorial.classList.contains('hidden')) {
        this.showPerfTutorial(false);
      }
    };
    document.addEventListener('keydown', this._perfTutorialKey);
    // Pre-hero splash: click / Enter / Space dissolves into the hero. The
    // loading veil sits above the splash until bootstrap finishes, so this
    // stays inert until setLoading(false) plays the entrance animation.
    if (this.els.heroSplash) {
      this.els.heroSplash.addEventListener('click', () => this.hideSplash());
      this.els.heroSplash.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.hideSplash(); }
      });
    }
    this.setupTouch();
  }

  setupTouch() {
    const { joystick, knob } = this.els;
    if (!joystick || !knob) return;
    let pid = null;
    const R = 36;                      // knob travel radius (px)
    const emit = (x, y) => this.cb.onJoystick && this.cb.onJoystick(x, y);
    const move = (e) => {
      if (e.pointerId !== pid) return;
      const r = joystick.getBoundingClientRect();
      let dx = e.clientX - (r.left + r.width / 2);
      let dy = e.clientY - (r.top + r.height / 2);
      const len = Math.hypot(dx, dy);
      if (len > R) { dx *= R / len; dy *= R / len; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      emit(dx / R, -dy / R);           // stick up = forward
    };
    const end = (e) => {
      if (e.pointerId !== pid) return;
      pid = null;
      knob.style.transform = '';
      emit(0, 0);
    };
    joystick.addEventListener('pointerdown', (e) => {
      pid = e.pointerId;
      try { joystick.setPointerCapture(pid); } catch { /* synthetic pointers */ }
      move(e);
    });
    joystick.addEventListener('pointermove', move);
    joystick.addEventListener('pointerup', end);
    joystick.addEventListener('pointercancel', end);

  }

  showTouchUI(show) {
    if (!this.els.touchUI) return;
    this.els.touchUI.classList.toggle('hidden', !show);
    if (!show) {
      if (this.els.knob) this.els.knob.style.transform = '';
      if (this.cb.onJoystick) this.cb.onJoystick(0, 0);
      if (this.cb.onJump) this.cb.onJump(false);
    }
  }

  setSystem(name, planetCount, seed, catalogId = '', showSeed = false) {
    this.els.system.textContent = name;
    this.els.planetCount.textContent = `已测绘天体 · ${planetCount}`;
    const galaxyName = this.cb.galaxyName || '银河系';
    this.els.seed.textContent = showSeed
      ? `银河实验 · ${galaxyName} / ${seed}`
      : `银河 · ${galaxyName}`;
    if (this.els.systemCatalog) this.els.systemCatalog.textContent = catalogId;
    if (this.els.brandSystem) this.els.brandSystem.textContent = name;
  }

  setAltitude(alt, speed) {
    if (alt == null) {
      this._setText(this.els.altitudeValue, '—');
      this._setText(this.els.altitudeUnit, '');
      return;
    }
    this._setText(this.els.altitudeValue, alt > 9999 ? (alt / 1000).toFixed(1) : alt.toFixed(0));
    this._setText(this.els.altitudeUnit, alt > 9999 ? 'km' : 'm');
  }

  setCosmicTime(hours, localHours = null, scale = 60) {
    const day = Math.floor(hours / 24);
    const hour = ((hours % 24) + 24) % 24;
    const local = localHours == null ? '' : ` · 本地 ${String(Math.floor(localHours) % 24).padStart(2, '0')}:${String(Math.floor((localHours % 1) * 60)).padStart(2, '0')}`;
    const rate = scale >= 1000 ? `${(scale / 1000).toFixed(scale >= 10000 ? 0 : 1)}k` : Math.round(scale);
    if (this.els.cosmicTime) this.els.cosmicTime.textContent = `UT ${String(day).padStart(4, '0')}:${String(Math.floor(hour)).padStart(2, '0')} · ×${rate}${local}`;
  }

  setFlightTelemetry({ speed = 0, speedLimit = 1, boost = 0, atmosphere = 0,
    pulse = 0, pulseFuel = 100, pulseFuelMax = 100, pulseRecharging = false }) {
    const speedK = Math.max(0, Math.min(1, speed / Math.max(1, speedLimit)));
    const boostK = Math.max(0, Math.min(1, boost));
    const atmoK = Math.max(0, Math.min(1, atmosphere));
    const pulseK = Math.max(0, Math.min(1, pulse));
    this._setText(this.els.driveMode, pulseK > 0.12 ? '脉冲冲刺' : boostK > 0.12 ? '加力' : atmoK > 0.42 ? '大气内' : '巡航');
    this._setText(this.els.driveSpeed, speed > 1000 ? `${(speed / 1000).toFixed(1)} km/s` : `${speed.toFixed(0)} m/s`);
    this._setText(this.els.driveBoost, pulseK > 0.12
      ? `脉冲 ${Math.round(pulseK * 100)}%`
      : boostK > 0.12 ? `加力 ${Math.round(boostK * 100)}%` : '待命');
    this._setText(this.els.driveAtmo, `${Math.round(atmoK * 100)}%`);
    if (this.els.driveSpeedFill) this.els.driveSpeedFill.style.width = `${Math.max(3, speedK * 100).toFixed(1)}%`;
    if (this.els.driveBoostFill) this.els.driveBoostFill.style.width = `${(Math.max(boostK, pulseK) * 100).toFixed(1)}%`;
    if (this.els.driveAtmoFill) this.els.driveAtmoFill.style.width = `${(atmoK * 100).toFixed(1)}%`;
    this._setText(this.els.pulseFuel,
      `${Math.ceil(Math.max(0, pulseFuel))}/${Math.ceil(pulseFuelMax)}${pulseRecharging ? ' ↑' : ''}`);
    this.els.pulseFuel?.parentElement?.classList.toggle('pulse-recharging', pulseRecharging);
    this.shipHud.setTelemetry({ speed, speedLimit, boost, pulse, pulseFuel, pulseFuelMax });
  }

  beginWarpPower() { this.shipHud.beginWarpPower(); }

  endWarpPower(immediate = false) { this.shipHud.endWarpPower(immediate); }

  getPowerState() { return this.shipHud.getPowerState(); }

  getPowerEffects() { return this.shipHud.getPowerEffects(); }

  _setText(el, value) { if (el && el.textContent !== value) el.textContent = value; }

  setHeading(degrees) {
    const d = ((degrees % 360) + 360) % 360;
    const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    this._setText(this.els.headingCardinal, names[Math.round(d / 45) % 8]);
    this._setText(this.els.headingDegrees, `${String(Math.round(d)).padStart(3, '0')}°`);
  }

  setHint(text, persistent = false) {
    if (this._hint === text) return;
    this._hint = text;
    clearTimeout(this._hintTimer);
    this.els.hint.innerHTML = text || '';
    // setState is intentionally kept out of the DOM API. The two gameplay
    // hints are stable state signals and let the HUD switch presentation
    // without changing the runtime integration contract.
    if (text && (/WASD|摇杆/.test(text))) {
      document.body.classList.add('ui-walk');
      document.body.classList.remove('ui-space');
    } else if (text && (/鼠标|单指/.test(text))) {
      document.body.classList.add('ui-space');
      document.body.classList.remove('ui-walk');
    }
    this.els.hint.classList.toggle('hidden', !text);
    this.els.hint.classList.remove('hint-faded');
    if (text && !persistent) {
      this._hintTimer = setTimeout(() => this.els.hint.classList.add('hint-faded'), 8000);
    }
  }

  showLand(show, text = 'LAND — walk the surface') {
    this.els.land.textContent = text.startsWith('DIVE') ? '潜入并离开飞船' :
      text.startsWith('LAND') ? '着陆并离开飞船  [L]' : text;
    this.els.land.classList.toggle('hidden', !show);
  }

  showHero(show = true) {
    const hero = this.els.hero;
    hero.classList.toggle('hidden', !show);
    hero.classList.remove('hero-leaving');
    // Hides every piece of flight chrome while the start page owns the screen.
    document.body.classList.toggle('hero-active', show);
    if (this.els.heroSeed) {
      this.els.heroSeed.textContent = this.cb.worldLab
        ? new URLSearchParams(location.search).get('seed') || 'NAVEMI-382'
        : 'DEEP SPACE';
    }
    if (this.els.heroBuild) this.els.heroBuild.textContent = document.getElementById('version')?.textContent || '—';
    if (show) {
      // Fade the overlay in (used when dissolving from the splash). hero-faded
      // holds opacity 0 for one committed frame before the transition fires.
      hero.classList.add('hero-faded');
      requestAnimationFrame(() => requestAnimationFrame(() => hero.classList.remove('hero-faded')));
      queueMicrotask(() => this.els.heroStart.focus());
    } else {
      hero.classList.remove('hero-faded');
    }
  }

  // Pre-hero title card. Shown behind the loading veil at init; the entrance
  // animation is triggered by setLoading(false) once bootstrap completes.
  showSplash(show = true) {
    const splash = this.els.heroSplash;
    if (!splash || !show) return;
    this._splashAnimated = false;
    document.body.classList.add('hero-active');
    document.body.classList.remove('hud-cloaked');
    splash.classList.remove('hidden', 'splash-leaving', 'hero-splash-in');
  }

  playSplashEntrance() {
    const splash = this.els.heroSplash;
    if (!splash || splash.classList.contains('hidden') || this._splashAnimated) return;
    this._splashAnimated = true;
    // Restart the keyframes from a clean frame.
    splash.classList.remove('hero-splash-in');
    void splash.offsetWidth;
    splash.classList.add('hero-splash-in');
  }

  hideSplash() {
    const splash = this.els.heroSplash;
    if (!splash || splash.classList.contains('hidden')) return;
    splash.classList.add('splash-leaving');
    // Cross-dissolve: hero fades in behind the splash veil as it fades out.
    this.showHero(true);
    // First user gesture — unlock audio so the hero start page has sound.
    this.cb.onEnterHero?.();
    setTimeout(() => {
      splash.classList.add('hidden');
      splash.classList.remove('splash-leaving', 'hero-splash-in');
      this._splashAnimated = false;
    }, 620);
  }

  // Lifts a chrome-hiding state (hero-active / travel-cinematic) with a fade
  // instead of a snap. Adds a one-frame opacity cloak so the display:none ->
  // display:block switch happens while opacity is 0, then removes the cloak on
  // the next frame so the .8s opacity transition fires.
  _revealChrome(hidingClass) {
    const body = document.body;
    body.classList.remove('hud-cloaked');
    if (!body.classList.contains(hidingClass)) return;
    body.classList.add('hud-cloaked');
    body.classList.remove(hidingClass);
    requestAnimationFrame(() => requestAnimationFrame(() => body.classList.remove('hud-cloaked')));
  }

  // Called by main.js when the hero pull-back cinematic finishes — the ship is
  // in formation, so cockpit chrome can fade in.
  revealChrome() { this._revealChrome('hero-active'); }

  // Start button: fade the overlay out, then hand off to the cinematic start.
  // hero-active stays until revealChrome() lifts it at the end of the pull-back
  // so cockpit chrome stays hidden while the ship slides into formation.
  hideHero() {
    this.els.hero.classList.add('hero-leaving');
    setTimeout(() => {
      this.els.hero.classList.add('hidden');
      this.els.hero.classList.remove('hero-faded');
    }, 580);
  }

  setTimeWarp(show, { label = '', progress = 0, scale = 60 } = {}) {
    this.els.timeWarp.classList.toggle('hidden', !show);
    if (!show) return;
    this._setText(this.els.timeWarpLabel, label);
    this.els.timeWarpProgress.style.width = `${Math.max(0, Math.min(100, progress * 100)).toFixed(1)}%`;
    const rate = scale >= 1000 ? `${(scale / 1000).toFixed(scale >= 10000 ? 0 : 1)}k` : Math.round(scale);
    this._setText(this.els.timeWarpRate, `×${rate}`);
  }

  setPerformanceNotice(text, timeout = 8000) {
    clearTimeout(this._performanceNoticeTimer);
    clearTimeout(this._performanceNoticeFadeTimer);
    const notice = this.els.performanceNotice;
    notice.textContent = text || '';
    notice.classList.toggle('hidden', !text);
    notice.classList.remove('notice-fade');
    if (!text || timeout <= 0) return;
    this._performanceNoticeTimer = setTimeout(() => {
      notice.classList.add('notice-fade');
      this._performanceNoticeFadeTimer = setTimeout(() => notice.classList.add('hidden'), 700);
    }, timeout);
  }

  // Surfaces an inline hint on the hero start page when a low-power GPU is
  // detected. The hint is clickable and opens a short Windows graphics-setup
  // tutorial so the player can switch the browser to its discrete GPU before
  // the first frame. gpuName customises the title for the detected adapter.
  setHeroPerfHint(visible, gpuName = '') {
    const hint = this.els.heroPerfHint;
    if (!hint) return;
    if (visible && gpuName) {
      const sub = hint.querySelector('.hero-perf-hint-sub');
      if (sub && !/Intel|AMD|SwiftShader|llvmpipe|Basic Render/i.test(gpuName)) {
        sub.textContent = '当前设备图形性能受限 · 点击查看优化教程';
      }
    }
    hint.classList.toggle('hidden', !visible);
  }

  showPerfTutorial(show = true) {
    const dialog = this.els.perfTutorial;
    if (!dialog) return;
    dialog.classList.toggle('hidden', !show);
    if (show) {
      queueMicrotask(() => this.els.perfTutorialClose?.focus());
    } else if (this.els.heroPerfHint && !this.els.hero?.classList.contains('hidden')) {
      this.els.heroPerfHint.focus();
    }
  }

  setGraphicsSettings(settings, profile, { gpu = '', actualBackend = '', reason = '' } = {}) {
    const panel = this.els.graphicsPanel;
    if (!panel) return;
    const quality = panel.querySelector(`input[name="graphics-quality"][value="${settings.quality}"]`);
    if (quality) quality.checked = true;
    for (const label of panel.querySelectorAll('.graphics-choice-grid label')) {
      label.classList.toggle('is-recommended', label.querySelector('input')?.value === profile.id);
    }
    this._setText(this.els.graphicsGpu, gpu || '未能读取设备名称');
    this._setText(this.els.graphicsBackend,
      `WebGPU 自动 · 实际 ${(actualBackend || 'unknown').toUpperCase()} · 当前 ${profile.label}`);
    if (reason?.includes('fallback')) {
      this._setText(this.els.graphicsNote,
        `WebGPU 未能启动，已自动回落 WebGL 2（${reason}）。调整画质后将重新启动。`);
    }
  }

  showGraphicsSettings(show = true) {
    const panel = this.els.graphicsPanel;
    if (!panel) return;
    panel.classList.toggle('hidden', !show);
    this.els.heroSettings?.setAttribute('aria-expanded', String(show));
    if (show) queueMicrotask(() => panel.querySelector('input:checked')?.focus());
    else this.els.heroSettings?.focus();
  }

  showRouteChoice(show, name = '') {
    this.els.routeChoice.classList.toggle('hidden', !show);
    document.body.classList.toggle('route-choice-active', show);
    if (show) this._setText(this.els.routeChoiceName, name || '未命名星系');
  }

  beginTravel() {
    clearTimeout(this._arrivalTimer);
    clearTimeout(this._arrivalHideTimer);
    this.els.arrivalTitle.classList.add('hidden');
    this.els.arrivalTitle.classList.remove('arrival-visible');
    // Cancel any in-flight chrome reveal so the cloak does not linger across
    // the next travel cycle.
    document.body.classList.remove('hud-cloaked');
    document.body.classList.add('travel-cinematic');
  }

  showArrival(name, systemName = '', kicker = '抵达') {
    clearTimeout(this._arrivalTimer);
    clearTimeout(this._arrivalHideTimer);
    cancelAnimationFrame(this._arrivalRaf);
    document.body.classList.add('travel-cinematic');
    this._setText(this.els.arrivalKicker, kicker);
    this._setText(this.els.arrivalName, name || systemName || '未知星域');
    this._setText(this.els.arrivalSystem, systemName && systemName !== name ? systemName : '航行坐标已确认');
    this.els.arrivalTitle.classList.remove('hidden');
    this.els.arrivalTitle.classList.remove('arrival-visible');
    this._arrivalRaf = requestAnimationFrame(() => this.els.arrivalTitle.classList.add('arrival-visible'));
    this._arrivalTimer = setTimeout(() => {
      this.els.arrivalTitle.classList.remove('arrival-visible');
      this._arrivalHideTimer = setTimeout(() => {
        this.els.arrivalTitle.classList.add('hidden');
        // Cockpit chrome fades back in as the arrival title clears, instead
        // of snapping on at the end of the travel cinematic.
        this._revealChrome('travel-cinematic');
      }, 700);
    }, 2800);
  }

  endTravel() {
    clearTimeout(this._arrivalTimer);
    clearTimeout(this._arrivalHideTimer);
    cancelAnimationFrame(this._arrivalRaf);
    this.els.arrivalTitle.classList.add('hidden');
    this.els.arrivalTitle.classList.remove('arrival-visible');
    this._revealChrome('travel-cinematic');
  }

  setDestinationMarker({ show = false, name = '', distance = '', x = 0, y = 0, behind = false } = {}) {
    const marker = this.els.destinationMarker;
    marker.classList.toggle('hidden', !show);
    if (!show) return;
    marker.style.left = `${x}px`;
    marker.style.top = `${y}px`;
    marker.classList.toggle('is-behind', behind);
    this._setText(this.els.destinationMarkerName, name);
    this._setText(this.els.destinationMarkerDistance, distance);
  }

  setCrosshair(show) { this.els.crosshair.classList.toggle('hidden', !show); }

  fadeTo(opacity, color = '#000', ms = 600) {
    const f = this.els.fade;
    f.style.transitionDuration = ms + 'ms';
    f.style.background = color;
    f.style.opacity = opacity;
  }

  setLoading(show, text) {
    this.els.loading.classList.toggle('hidden', !show);
    if (text) this.els.loadingText.textContent = text;
    if (!show) {
      // The loading veil has just lifted — now play the pre-hero splash
      // entrance so the title animation isn't wasted behind the veil.
      this.playSplashEntrance();
    }
  }

  // Drives the loading bar from the per-frame startup readiness check in
  // main.js. `progress` is 0..1; the bar only moves forward (we never lie
  // about regressing) and snaps to 1 just before setLoading(false) hides the
  // screen.
  setLoadingProgress(progress) {
    const p = Math.max(0, Math.min(1, progress));
    if (this._loadingProgress === p) return;
    this._loadingProgress = p;
    this.els.loading.style.setProperty('--loading-progress', p.toFixed(4));
  }

  setStats(text) { this.els.stats.textContent = text; }

  setDevFps(fps) { this.els.devFps.textContent = `${Math.max(0, Math.round(fps))} FPS`; }

  // Release every pending timer / rAF the HUD scheduled. The HUD itself is
  // a singleton for the page lifetime; dispose() is for hot-reload and
  // context-loss recovery where the universe is rebuilt but the DOM nodes
  // stick around. DOM listeners attached in the constructor are on those
  // persistent nodes and intentionally left intact — a future UI instance
  // would rebind to the same elements.
  dispose() {
    clearTimeout(this._hintTimer);
    clearTimeout(this._performanceNoticeTimer);
    clearTimeout(this._performanceNoticeFadeTimer);
    clearTimeout(this._arrivalTimer);
    clearTimeout(this._arrivalHideTimer);
    cancelAnimationFrame(this._arrivalRaf);
    this._hint = null;
  }

}
