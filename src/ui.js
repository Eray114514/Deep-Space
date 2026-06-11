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
      altitude: $('altitude'), newBtn: $('new-universe'),
      touchUI: $('touch-ui'), joystick: $('joystick'), knob: $('joystick-knob'),
      btnJump: $('btn-jump'), btnTakeoff: $('btn-takeoff'),
    };
    this.labelPool = [];
    this.els.land.addEventListener('click', () => this.cb.onLand && this.cb.onLand());
    this.els.newBtn.addEventListener('click', () => this.cb.onNewUniverse && this.cb.onNewUniverse());
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

    const jump = (down) => this.cb.onJump && this.cb.onJump(down);
    btnJump.addEventListener('pointerdown', (e) => { e.preventDefault(); jump(true); });
    btnJump.addEventListener('pointerup', () => jump(false));
    btnJump.addEventListener('pointercancel', () => jump(false));
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
    this.els.planetCount.textContent = `${planetCount} bodies charted`;
    this.els.seed.textContent = `seed · ${seed}`;
  }

  setTarget(planet, dist) {
    if (!planet) { this.els.card.classList.add('hidden'); return; }
    this.els.card.classList.remove('hidden');
    this.els.cardName.textContent = planet.name;
    this.els.cardType.textContent = (planet.isMoon ? 'Moon · ' : 'Planet · ') + planet.typeLabel;
    const bits = [`r ${(planet.R / 1000).toFixed(1)} km`, `g ${(planet.gravity / 9.81).toFixed(2)}`];
    if (planet.liquid === 'water') bits.push('water');
    if (planet.liquid === 'lava') bits.push('magma seas');
    if (planet.liquid === 'ice') bits.push('ice sheets');
    if (planet.liquid === 'toxic') bits.push('toxic seas');
    if (planet.cloudMesh) bits.push('clouds');
    this.els.cardInfo.textContent = bits.join(' · ');
    this.setTargetDist(dist);
  }

  setStarTarget(name, dist, sub) {
    this.els.card.classList.remove('hidden');
    this.els.cardName.textContent = name;
    this.els.cardType.textContent = `Star system — ${sub}`;
    this.els.cardInfo.textContent = 'an unexplored system awaits';
    this.setTargetDist(dist);
  }

  setTargetDist(dist) {
    this.els.cardDist.textContent = dist == null ? '' :
      dist > 10000 ? `${(dist / 1000).toFixed(0)} km` :
      dist > 1000 ? `${(dist / 1000).toFixed(1)} km` : `${dist.toFixed(0)} m`;
  }

  setAltitude(alt, speed) {
    if (alt == null) { this.els.altitude.classList.add('hidden'); return; }
    this.els.altitude.classList.remove('hidden');
    const a = alt > 9999 ? `${(alt / 1000).toFixed(1)} km` : `${alt.toFixed(0)} m`;
    const s = speed > 1000 ? `${(speed / 1000).toFixed(1)} km/s` : `${speed.toFixed(0)} m/s`;
    this.els.altitude.textContent = `ALT ${a}   SPD ${s}`;
  }

  setHint(text) {
    if (this._hint === text) return;
    this._hint = text;
    this.els.hint.innerHTML = text || '';
    this.els.hint.classList.toggle('hidden', !text);
  }

  showLand(show, text = 'LAND — walk the surface') {
    this.els.land.textContent = text;
    this.els.land.classList.toggle('hidden', !show);
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
    for (let i = 0; i < this.labelPool.length; i++) {
      const el = this.labelPool[i];
      if (i >= items.length) { el.style.display = 'none'; continue; }
      const it = items[i];
      el.style.display = '';
      el.style.transform = `translate(${it.x.toFixed(0)}px, ${it.y.toFixed(0)}px)`;
      el.classList.toggle('dim', !!it.dim);
      el._key = it.key;
      el.children[1].textContent = it.name;
      el.children[2].textContent = it.sub || '';
    }
  }
}
