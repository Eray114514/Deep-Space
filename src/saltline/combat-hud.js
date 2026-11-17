// Walk-mode tactical HUD overlay (dynamic spread crosshair, hitmarker,
// directional damage indicator, explorer suit shield bar, and grenade/stance
// readout). Follows docs/ui-design-language.md: line-art HUD directly over the
// viewport with dark halo (--hud-halo), no opaque plates, Barlow Semi Condensed.

const STYLE_ID = 'nms-combat-hud-style';

const CSS = `
#nms-combat-hud {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 14;
  font-family: var(--font-hud, 'Barlow Semi Condensed', 'Segoe UI', sans-serif);
  font-weight: 500;
  letter-spacing: 0.08em;
  color: var(--ship-cream, #eef5f7);
  filter: var(--hud-halo, drop-shadow(0 1px 2px rgba(4, 10, 14, 0.92)));
  transition: opacity 0.16s ease;
}
#nms-combat-hud.hidden {
  opacity: 0;
  visibility: hidden;
}
body.hero-active #nms-combat-hud,
body.travel-cinematic #nms-combat-hud,
body.hide-hud #nms-combat-hud,
body.starmap-open #nms-combat-hud,
body.route-choice-active #nms-combat-hud {
  opacity: 0 !important;
  visibility: hidden !important;
}
.nms-ch-center {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 0;
  height: 0;
}
.nms-ch-dot {
  position: absolute;
  left: -1.5px;
  top: -1.5px;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: rgba(238, 247, 250, 0.92);
  transition: opacity 0.12s ease;
}
.nms-ch-tick {
  position: absolute;
  background: rgba(226, 242, 248, 0.88);
  transition: opacity 0.12s ease;
}
.nms-ch-tick.top, .nms-ch-tick.bottom {
  width: 1.5px;
  height: 8px;
  left: -0.75px;
}
.nms-ch-tick.left, .nms-ch-tick.right {
  width: 8px;
  height: 1.5px;
  top: -0.75px;
}
.nms-ch-ring {
  position: absolute;
  border: 1.4px dashed rgba(226, 242, 248, 0.66);
  border-radius: 50%;
  transform: translate(-50%, -50%);
  opacity: 0;
  transition: opacity 0.14s ease;
}
.nms-hitmarker {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 28px;
  height: 28px;
  transform: translate(-50%, -50%) scale(0.85);
  opacity: 0;
}
.nms-hitmarker svg {
  width: 100%;
  height: 100%;
  overflow: visible;
}
.nms-dmg-ring {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 180px;
  height: 180px;
  transform: translate(-50%, -50%);
}
.nms-dmg-arc {
  position: absolute;
  inset: 0;
  opacity: 0;
}
.nms-suit-shield {
  position: fixed;
  right: clamp(20px, 3vw, 42px);
  bottom: clamp(114px, 14vh, 152px);
  width: 176px;
  display: grid;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.25s ease;
}
.nms-suit-shield.visible {
  opacity: 1;
}
.nms-suit-shield-head {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--ship-cyan, #9fdbe8);
}
.nms-suit-shield.low .nms-suit-shield-head {
  color: #ff6a52;
}
.nms-suit-shield-track {
  height: 3px;
  background: rgba(255, 255, 255, 0.18);
  position: relative;
}
.nms-suit-shield-fill {
  height: 100%;
  width: 100%;
  background: var(--ship-cyan, #9fdbe8);
  transform-origin: left center;
  transition: background-color 0.18s ease;
}
.nms-suit-shield.low .nms-suit-shield-fill {
  background: #ff5a42;
}
.nms-weapon-aux {
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: flex-end;
  margin-top: 5px;
  font-family: var(--font-hud, 'Barlow Semi Condensed', sans-serif);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.08em;
  color: rgba(226, 240, 245, 0.82);
}
.nms-weapon-aux kbd {
  font-family: inherit;
  font-size: 10px;
  padding: 0 4px;
  border: 1px solid rgba(200, 230, 240, 0.45);
  color: var(--ship-cyan, #9fdbe8);
  margin-right: 3px;
}
.nms-dmg-vignette {
  position: fixed;
  inset: 0;
  pointer-events: none;
  background: radial-gradient(circle at 50% 50%, transparent 56%, rgba(215, 42, 24, 0.38) 100%);
  opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
  #nms-combat-hud, .nms-suit-shield { transition: none; }
}
`;

export class CombatHud {
  constructor() {
    this.hitTimer = 0;
    this.hitDuration = 0.14;
    this.hitKind = 'normal';
    this.damageArcs = [];
    this.vignette = 0;
    this.shield = 1;
    this.shieldHoldT = 0;
    this.domReady = false;
    if (typeof document !== 'undefined') this._mount();
  }

  _mount() {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    let root = document.getElementById('nms-combat-hud');
    if (root) root.remove();
    root = document.createElement('div');
    root.id = 'nms-combat-hud';
    root.className = 'hidden';
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML = `
      <div class="nms-dmg-vignette" data-vignette></div>
      <div class="nms-ch-center" data-crosshair>
        <div class="nms-ch-dot" data-dot></div>
        <div class="nms-ch-ring" data-ring></div>
        <div class="nms-ch-tick top" data-top></div>
        <div class="nms-ch-tick bottom" data-bottom></div>
        <div class="nms-ch-tick left" data-left></div>
        <div class="nms-ch-tick right" data-right></div>
      </div>
      <div class="nms-hitmarker" data-hitmarker>
        <svg viewBox="-16 -16 32 32">
          <path data-hm-path d="M-10,-10 L-4,-4 M10,-10 L4,-4 M-10,10 L-4,4 M10,10 L4,4"
            fill="none" stroke="#eef5f7" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
      </div>
      <div class="nms-dmg-ring" data-dmg-ring></div>
      <div class="nms-suit-shield" data-shield>
        <div class="nms-suit-shield-head">
          <span>护盾 · SUIT</span><strong data-shield-pct>100%</strong>
        </div>
        <div class="nms-suit-shield-track">
          <div class="nms-suit-shield-fill" data-shield-fill></div>
        </div>
      </div>
    `;
    document.body.appendChild(root);
    this.root = root;
    this.els = {
      vignette: root.querySelector('[data-vignette]'),
      crosshair: root.querySelector('[data-crosshair]'),
      dot: root.querySelector('[data-dot]'),
      ring: root.querySelector('[data-ring]'),
      top: root.querySelector('[data-top]'),
      bottom: root.querySelector('[data-bottom]'),
      left: root.querySelector('[data-left]'),
      right: root.querySelector('[data-right]'),
      hitmarker: root.querySelector('[data-hitmarker]'),
      hmPath: root.querySelector('[data-hm-path]'),
      dmgRing: root.querySelector('[data-dmg-ring]'),
      shield: root.querySelector('[data-shield]'),
      shieldPct: root.querySelector('[data-shield-pct]'),
      shieldFill: root.querySelector('[data-shield-fill]'),
    };
    this.domReady = true;
  }

  syncWeaponSlots(weapons, activeIndex = 0, grenades = 2, stance = 'stand') {
    if (typeof document === 'undefined') return;
    const panel = document.getElementById('surface-weapon');
    if (!panel) return;
    const slots = panel.querySelector('.surface-weapon-slots');
    if (slots && slots.dataset.count !== String(weapons.length)) {
      slots.dataset.count = String(weapons.length);
      slots.innerHTML = weapons
        .map((w, i) => `<span class="${i === activeIndex ? 'active' : ''}" data-weapon-slot="${i}">${i + 1} ${w.short}</span>`)
        .join('');
    }
    let aux = panel.querySelector('.nms-weapon-aux');
    if (!aux) {
      aux = document.createElement('div');
      aux.className = 'nms-weapon-aux';
      panel.appendChild(aux);
    }
    const stanceLabel = stance === 'slide' ? 'SLIDE' : stance === 'crouch' ? 'CROUCH' : '';
    aux.innerHTML = `<span><kbd>Q</kbd>FRAG ×${grenades}</span>${stanceLabel ? `<span>${stanceLabel}</span>` : ''}`;
  }

  triggerHit({ weakpoint = false, killed = false } = {}) {
    this.hitKind = killed ? 'kill' : weakpoint ? 'weak' : 'normal';
    this.hitDuration = killed ? 0.24 : 0.14;
    this.hitTimer = this.hitDuration;
    if (!this.domReady) return;
    const color = killed ? '#ff5a36' : weakpoint ? '#ffb84d' : '#eef5f7';
    this.els.hmPath.setAttribute('stroke', color);
    this.els.hmPath.setAttribute('stroke-width', killed ? '2.3' : weakpoint ? '2.0' : '1.7');
  }

  triggerDamage(relAngleRad = 0, amount01 = 0.35) {
    this.vignette = Math.min(1, this.vignette + 0.25 + amount01 * 0.65);
    this.shieldHoldT = 3.2;
    if (!this.domReady) return;
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    el.setAttribute('viewBox', '-90 -90 180 180');
    el.setAttribute('class', 'nms-dmg-arc');
    el.style.transform = `rotate(${(relAngleRad * 180 / Math.PI).toFixed(1)}deg)`;
    el.innerHTML = '<path d="M -28 -76 A 81 81 0 0 1 28 -76" fill="none" stroke="#ff5238" stroke-width="3.2" stroke-linecap="round"/>';
    this.els.dmgRing.appendChild(el);
    this.damageArcs.push({ el, life: 0.9, max: 0.9 });
    while (this.damageArcs.length > 6) {
      const old = this.damageArcs.shift();
      old.el.remove();
    }
  }

  update(dt, {
    active = false,
    paused = false,
    holstered = false,
    reloading = false,
    ads = 0,
    spread = 0.015,
    isShotgun = false,
    shield = 1,
    grenades = 2,
    stance = 'stand',
    weapons = null,
    weaponIndex = 0,
  } = {}) {
    if (weapons) this.syncWeaponSlots(weapons, weaponIndex, grenades, stance);
    if (!this.domReady) return;

    const show = active && !paused;
    this.root.classList.toggle('hidden', !show);
    if (!show) return;

    // Crosshair fades during ADS, reload, or holster
    const chAlpha = holstered ? 0 : Math.max(0, 1 - ads * 2.4) * (reloading ? 0.28 : 1);
    this.els.crosshair.style.opacity = chAlpha.toFixed(3);
    const gapPx = Math.max(5, Math.min(54, 4 + Math.tan(Math.max(0.002, spread)) * 560));
    if (isShotgun) {
      const d = Math.max(26, gapPx * 2.1);
      this.els.ring.style.width = `${d.toFixed(1)}px`;
      this.els.ring.style.height = `${d.toFixed(1)}px`;
      this.els.ring.style.opacity = (chAlpha * 0.85).toFixed(3);
      for (const k of ['top', 'bottom', 'left', 'right']) this.els[k].style.opacity = '0';
    } else {
      this.els.ring.style.opacity = '0';
      for (const k of ['top', 'bottom', 'left', 'right']) this.els[k].style.opacity = '1';
      this.els.top.style.transform = `translateY(${(-gapPx - 8).toFixed(1)}px)`;
      this.els.bottom.style.transform = `translateY(${gapPx.toFixed(1)}px)`;
      this.els.left.style.transform = `translateX(${(-gapPx - 8).toFixed(1)}px)`;
      this.els.right.style.transform = `translateX(${gapPx.toFixed(1)}px)`;
    }

    // Hitmarker decay
    if (this.hitTimer > 0) {
      this.hitTimer = Math.max(0, this.hitTimer - dt);
      const u = this.hitTimer / Math.max(0.01, this.hitDuration);
      const scale = this.hitKind === 'kill' ? 1.25 - u * 0.2 : 1.05 - u * 0.15;
      this.els.hitmarker.style.opacity = Math.min(1, u * 1.5).toFixed(3);
      this.els.hitmarker.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(3)})`;
    } else {
      this.els.hitmarker.style.opacity = '0';
    }

    // Directional damage arcs
    for (let i = this.damageArcs.length - 1; i >= 0; i--) {
      const arc = this.damageArcs[i];
      arc.life -= dt;
      if (arc.life <= 0) {
        arc.el.remove();
        this.damageArcs.splice(i, 1);
      } else {
        arc.el.style.opacity = (arc.life / arc.max).toFixed(3);
      }
    }

    // Damage vignette
    this.vignette = Math.max(0, this.vignette - dt * 1.8);
    this.els.vignette.style.opacity = this.vignette.toFixed(3);

    // Explorer suit shield readout (visible when < 99.5% or recently damaged)
    this.shield = Math.max(0, Math.min(1, shield));
    if (this.shield < 0.995) this.shieldHoldT = 2.4;
    else this.shieldHoldT = Math.max(0, this.shieldHoldT - dt);
    const showShield = this.shieldHoldT > 0;
    this.els.shield.classList.toggle('visible', showShield);
    this.els.shield.classList.toggle('low', this.shield < 0.35);
    if (showShield) {
      this.els.shieldPct.textContent = `${Math.round(this.shield * 100)}%`;
      this.els.shieldFill.style.transform = `scaleX(${this.shield.toFixed(3)})`;
    }
  }

  dispose() {
    if (this.root) this.root.remove();
    this.domReady = false;
  }
}
