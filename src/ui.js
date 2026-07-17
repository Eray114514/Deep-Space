// HUD: system info, target card, contextual hints, land prompt,
// floating planet labels, transitions. Pure DOM, no dependencies.

export class UI {
  constructor(callbacks = {}) {
    this.cb = callbacks;
    const $ = (id) => document.getElementById(id);
    this.els = {
      system: $('sys-name'), seed: $('sys-seed'), planetCount: $('sys-planets'),
      card: $('target-card'), cardName: $('tc-name'), cardType: $('tc-type'),
      cardInfo: $('tc-info'), cardDist: $('tc-dist'),
      hint: $('hint'), land: $('land-btn'), crosshair: $('crosshair'),
      fade: $('fade'), labels: $('labels'), stats: $('stats'),
      loading: $('loading'), loadingText: $('loading-text'),
      altitude: $('flight-ring'), newBtn: $('new-universe'),
      altitudeValue: $('altitude-value'), altitudeUnit: $('altitude-unit'),
      speedValue: $('speed-value'), speedUnit: $('speed-unit'),
      headingCardinal: $('heading-cardinal'), headingDegrees: $('heading-degrees'),
      starMapBtn: $('star-map-btn'),
      brandSystem: $('brand-system'), walkSystem: $('walk-system'),
      touchUI: $('touch-ui'), joystick: $('joystick'), knob: $('joystick-knob'),
      btnJump: $('btn-jump'), btnTakeoff: $('btn-takeoff'),
      performanceNotice: $('performance-notice'), hero: $('hero-overlay'), heroStart: $('hero-start-btn'),
    };
    this.labelPool = [];
    this._labelNext = 0;
    this._hudRectStamp = 0;
    this._hudRects = [];
    window.addEventListener('resize', () => { this._hudRectStamp = 0; });
    this.els.land.addEventListener('click', () => this.cb.onLand && this.cb.onLand());
    this.els.newBtn.addEventListener('click', () => this.cb.onNewUniverse && this.cb.onNewUniverse());
    this.els.starMapBtn.addEventListener('click', () => this.cb.onStarMap && this.cb.onStarMap());
    this.els.heroStart.addEventListener('click', () => {
      this.els.hero.classList.add('hidden');
      this.cb.onStart?.();
      window.dispatchEvent(new CustomEvent('game-user-start'));
    });
    this.setupTouch();
  }

  setupTouch() {
    const { joystick, knob, btnJump, btnTakeoff } = this.els;
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

    // jump latches on press; the controller clears it when consumed, so a
    // quick tap can never disappear between two slow frames
    btnJump.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (this.cb.onJump) this.cb.onJump(true);
    });
    btnTakeoff.addEventListener('click', () => this.cb.onTakeoff && this.cb.onTakeoff());
  }

  showTouchUI(show) {
    this.els.touchUI.classList.toggle('hidden', !show);
    if (!show) {
      this.els.knob.style.transform = '';
      if (this.cb.onJoystick) this.cb.onJoystick(0, 0);
      if (this.cb.onJump) this.cb.onJump(false);
    }
  }

  setSystem(name, planetCount, seed) {
    this.els.system.textContent = name;
    this.els.planetCount.textContent = `已测绘天体 · ${planetCount}`;
    this.els.seed.textContent = `星域种子 · ${seed}`;
    if (this.els.brandSystem) this.els.brandSystem.textContent = name;
    if (this.els.walkSystem) this.els.walkSystem.textContent = name;
  }

  setTarget(planet, dist) {
    if (!planet) { this.els.card.classList.add('hidden'); return; }
    this.els.card.classList.remove('hidden');
    this.els.cardName.textContent = planet.name;
    this.els.cardType.textContent = (planet.isMoon ? '卫星 · ' : '行星 · ') + planet.typeLabel;
    const bits = [`r ${(planet.R / 1000).toFixed(1)} km`, `g ${(planet.gravity / 9.81).toFixed(2)}`];
    if (planet.liquid === 'water') bits.push('液态水');
    if (planet.liquid === 'lava') bits.push('岩浆海');
    if (planet.liquid === 'ice') bits.push('冰盖');
    if (planet.liquid === 'toxic') bits.push('毒性海洋');
    if (planet.cloudMesh) bits.push('云层');
    this.els.cardInfo.textContent = bits.join(' · ');
    this.setTargetDist(dist);
  }

  setStarTarget(name, dist, sub) {
    this.els.card.classList.remove('hidden');
    this.els.cardName.textContent = name;
    this.els.cardType.textContent = `恒星系 · ${sub}`;
    this.els.cardInfo.textContent = '未测绘星域 · 再次确认以启动跃迁';
    this.setTargetDist(dist);
  }

  setTargetDist(dist) {
    this.els.cardDist.textContent = dist == null ? '' :
      dist > 10000 ? `${(dist / 1000).toFixed(0)} km` :
      dist > 1000 ? `${(dist / 1000).toFixed(1)} km` : `${dist.toFixed(0)} m`;
    const progress = dist == null ? 0 : Math.max(0.03, Math.min(1, 1 - Math.log10(1 + Math.max(0, dist)) / 8));
    this.els.card.style.setProperty('--target-progress', `${(progress * 100).toFixed(1)}%`);
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
    if (show) queueMicrotask(() => this.els.heroStart.focus());
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

  // items: [{x, y, name, sub, dim, key}]
  updateLabels(items) {
    const now = performance.now();
    if (now < this._labelNext) return;
    this._labelNext = now + 72; // DOM labels do not need the WebGL frame rate
    while (this.labelPool.length < items.length) {
      const el = document.createElement('div');
      el.className = 'planet-label';
      el.innerHTML = '<span class="pl-dot"></span><span class="pl-name"></span><span class="pl-sub"></span>';
      el.addEventListener('click', () => {
        if (el._key != null && this.cb.onLabelClick) this.cb.onLabelClick(el._key);
      });
      this.els.labels.appendChild(el);
      this.labelPool.push(el);
    }
    if (now - this._hudRectStamp > 500) {
      this._hudRectStamp = now;
      this._hudRects = [];
      for (const id of ['brand', 'compass', 'target-card', 'hud', 'ship-integrity', 'resource-strip', 'walk-hud']) {
        const node = document.getElementById(id);
        if (!node || node.offsetParent === null) continue;
        const r = node.getBoundingClientRect();
        this._hudRects.push({ left: r.left - 6, top: r.top - 6, right: r.right + 6, bottom: r.bottom + 6 });
      }
    }
    const occupied = this._hudRects.slice();
    const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    for (let i = 0; i < this.labelPool.length; i++) {
      const el = this.labelPool[i];
      if (i >= items.length) { el.style.display = 'none'; continue; }
      const it = items[i];
      el.style.display = '';
      el.classList.toggle('dim', !!it.dim);
      el._key = it.key;
      if (el.children[1].textContent !== it.name) el.children[1].textContent = it.name;
      const sub = it.sub || '';
      if (el.children[2].textContent !== sub) el.children[2].textContent = sub;
      const w = Math.min(250, Math.max(80, 34 + Math.max(it.name.length * 9, sub.length * 6)));
      const h = 34;
      const x = Math.max(8, Math.min(window.innerWidth - w - 8, it.x));
      let y = Math.max(72, Math.min(window.innerHeight - h - 72, it.y));
      let rect = { left: x, top: y, right: x + w, bottom: y + h };
      let tries = 0;
      while (occupied.some((other) => intersects(rect, other)) && tries < 6) {
        y = Math.min(window.innerHeight - h - 72, y + h + 5);
        rect = { left: x, top: y, right: x + w, bottom: y + h };
        tries++;
      }
      if (occupied.some((other) => intersects(rect, other)) && it.dim) {
        el.style.display = 'none';
        continue;
      }
      occupied.push(rect);
      el.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px)`;
    }
  }
}
