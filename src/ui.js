// HUD: system info, target card, contextual hints, land prompt,
// HUD, transitions and input affordances. Pure DOM, no dependencies.

export class UI {
  constructor(callbacks = {}) {
    this.cb = callbacks;
    const $ = (id) => document.getElementById(id);
    this.els = {
      system: $('sys-name'), systemCatalog: $('sys-catalog'), cosmicTime: $('cosmic-time'), seed: $('sys-seed'), planetCount: $('sys-planets'),
      hint: $('hint'), land: $('land-btn'), crosshair: $('crosshair'),
      fade: $('fade'), stats: $('stats'), devFps: $('dev-fps'),
      loading: $('loading'), loadingText: $('loading-text'),
      altitude: $('flight-ring'),
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
      this.els.hero.classList.add('hidden');
      this.cb.onStart?.();
      window.dispatchEvent(new CustomEvent('game-user-start'));
    });
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
    this.els.seed.textContent = showSeed ? `世界实验种子 · ${seed}` : '正式宇宙 · 深空';
    if (this.els.systemCatalog) this.els.systemCatalog.textContent = catalogId;
    if (this.els.brandSystem) this.els.brandSystem.textContent = name;
  }

  setAltitude(alt, speed) {
    if (alt == null) {
      this._setText(this.els.altitudeValue, '—');
      this._setText(this.els.altitudeUnit, '');
      this._setText(this.els.speedValue, Number.isFinite(speed) ? (speed > 1000 ? (speed / 1000).toFixed(1) : speed.toFixed(0)) : '0');
      this._setText(this.els.speedUnit, speed > 1000 ? 'km/s' : 'm/s');
      return;
    }
    this._setText(this.els.altitudeValue, alt > 9999 ? (alt / 1000).toFixed(1) : alt.toFixed(0));
    this._setText(this.els.altitudeUnit, alt > 9999 ? 'km' : 'm');
    this._setText(this.els.speedValue, speed > 1000 ? (speed / 1000).toFixed(1) : speed.toFixed(0));
    this._setText(this.els.speedUnit, speed > 1000 ? 'km/s' : 'm/s');
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
    this._setText(this.els.driveMode, pulseK > 0.12 ? '脉冲巡航' : boostK > 0.12 ? '加力' : atmoK > 0.42 ? '大气内' : '巡航');
    this._setText(this.els.driveSpeed, speed > 1000 ? `${(speed / 1000).toFixed(1)} km/s` : `${speed.toFixed(0)} m/s`);
    this._setText(this.els.driveBoost, pulseK > 0.12
      ? `脉冲 ${Math.round(pulseK * 100)}%`
      : boostK > 0.12 ? `加力 ${Math.round(boostK * 100)}%` : '待命');
    this._setText(this.els.driveAtmo, `${Math.round(atmoK * 100)}%`);
    this.els.driveSpeedFill.style.width = `${Math.max(3, speedK * 100).toFixed(1)}%`;
    this.els.driveBoostFill.style.width = `${(Math.max(boostK, pulseK) * 100).toFixed(1)}%`;
    this.els.driveAtmoFill.style.width = `${(atmoK * 100).toFixed(1)}%`;
    this._setText(this.els.pulseFuel,
      `${Math.ceil(Math.max(0, pulseFuel))}/${Math.ceil(pulseFuelMax)}${pulseRecharging ? ' ↑' : ''}`);
    this.els.pulseFuel.parentElement.classList.toggle('pulse-recharging', pulseRecharging);
  }

  _setText(el, value) { if (el.textContent !== value) el.textContent = value; }

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

  showHero(show = true, subtitle = '') {
    this.els.hero.classList.toggle('hidden', !show);
    const copy = this.els.hero.querySelector('p');
    if (subtitle) copy.textContent = subtitle;
    if (this.els.heroSeed) {
      this.els.heroSeed.textContent = this.cb.worldLab
        ? new URLSearchParams(location.search).get('seed') || 'NAVEMI-382'
        : 'DEEP SPACE';
    }
    if (this.els.heroBuild) this.els.heroBuild.textContent = document.getElementById('version')?.textContent || '—';
    if (show) queueMicrotask(() => this.els.heroStart.focus());
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
    const notice = this.els.performanceNotice;
    notice.textContent = text || '';
    notice.classList.toggle('hidden', !text);
    notice.classList.remove('notice-fade');
    if (!text || timeout <= 0) return;
    this._performanceNoticeTimer = setTimeout(() => {
      notice.classList.add('notice-fade');
      setTimeout(() => notice.classList.add('hidden'), 700);
    }, timeout);
  }

  showRouteChoice(show, name = '') {
    this.els.routeChoice.classList.toggle('hidden', !show);
    if (show) this._setText(this.els.routeChoiceName, name || '未命名星系');
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
  }

  setStats(text) { this.els.stats.textContent = text; }

  setDevFps(fps) { this.els.devFps.textContent = `${Math.max(0, Math.round(fps))} FPS`; }

}
