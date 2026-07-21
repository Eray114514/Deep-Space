const SVG_NS = 'http://www.w3.org/2000/svg';
const POWER_MAX = 8;
const POWER_CAPACITY = 23;
export const DEFAULT_POWER = Object.freeze({
  weapon: 4,
  nav: 3,
  thermal: 3,
  gravity: 4,
  shield: 3,
  warp: 0,
});
const POWER_SYSTEMS = [
  { id: 'weapon', short: '武', name: '脉冲炮阵列', description: '飞船武器供能' },
  { id: 'nav', short: '航', name: '航姿控制', description: '推进与姿态控制' },
  { id: 'thermal', short: '散', name: '热管理', description: '散热与持续工作' },
  { id: 'gravity', short: '引', name: '引力驱动', description: '常规引力推进' },
  { id: 'shield', short: '护', name: '护盾发生器', description: '船体周界防护' },
  { id: 'warp', short: '重', name: '重力核心', description: '恒星跃迁专用供能' },
];

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));

function powerMultiplier(value, baseline, gain) {
  const points = Math.max(0, Number(value) || 0);
  if (points === 0) return 0;
  return clamp(1 + (points - baseline) * gain, .45, 1.5);
}

// These multipliers are the gameplay contract for the distribution panel.
// Every authored default resolves to exactly 1.0, preserving the established
// flight and weapon feel until the player deliberately reroutes power.
export function powerEffectsFor(power = DEFAULT_POWER) {
  return {
    weapon: powerMultiplier(power.weapon, DEFAULT_POWER.weapon, .09),
    navigation: powerMultiplier(power.nav, DEFAULT_POWER.nav, .08),
    thermal: powerMultiplier(power.thermal, DEFAULT_POWER.thermal, .10),
    gravity: powerMultiplier(power.gravity, DEFAULT_POWER.gravity, .075),
    shield: powerMultiplier(power.shield, DEFAULT_POWER.shield, .12),
    warp: clamp((Number(power.warp) || 0) / POWER_MAX),
  };
}

export class ShipHUD {
  constructor() {
    this.stage = document.getElementById('ship-hud-stage');
    this.svg = document.getElementById('ship-hud-svg');
    this.speedValue = document.getElementById('speed-value');
    this.pulseFuel = document.getElementById('pulse-fuel');
    this.pulseLabel = document.getElementById('ship-hud-pulse-label');
    this.gunValue = document.getElementById('gun-value');
    this.hullNumber = document.getElementById('ship-hud-hull-number');
    this.hullBar = document.getElementById('ship-hud-hull-bar');
    this.powerHelp = document.getElementById('ship-hud-power-help');
    this.powerCounter = document.getElementById('ship-hud-power-counter');
    this.powerCells = document.getElementById('ship-hud-power-cells');
    this.powerCursor = document.getElementById('ship-hud-power-cursor');
    this.powerDpad = document.getElementById('ship-hud-dpad');
    this.powerCols = [...document.querySelectorAll('#ship-hud-power-cols .ship-hud-power-col')];
    this.powerLabels = [...document.querySelectorAll('#ship-hud-power-labels span')];

    this.power = { ...DEFAULT_POWER };
    this.selectedPower = 3;
    this.powerTransition = null;
    this.preWarpPower = null;
    this.warpRouting = false;
    this.speed = 0;
    this.speedLimit = 1;
    this.pulse = 0;
    this.pulseFuelValue = 140;
    this.pulseFuelMax = 140;
    this.boost = 0;
    this.shield = 100;
    this.hull = 100;
    this.gun = 100;
    this.scale = 1;
    this.lastWidth = 0;
    this.lastHeight = 0;
    this.centerX = 800;
    this.centerY = 500;

    this.buildCockpitGeometry();
    this.buildPowerPanel();
    this.bindInput();
    this.resize();
    document.fonts?.ready.then(() => this.layoutControlLabels());
    window.shipHUD = Object.freeze({
      getPowerState: () => this.getPowerState(),
      getPowerEffects: () => this.getPowerEffects(),
      selectPower: (system) => this.selectPowerSystem(system),
      adjustPower: (system, delta) => this.adjustPower(system, delta),
      beginWarpPower: () => this.beginWarpPower(),
      endWarpPower: (immediate = false) => this.endWarpPower(immediate),
      getControlLayout: () => ({ ...this.controlLayout }),
      getTelemetry: () => ({
        speed: this.speed,
        speedLimit: this.speedLimit,
        speedRatio: clamp(this.speed / this.speedLimit),
        speedPointerY: Number(this.speedPointer.getAttribute('y1')),
        speedTopY: this.yTop,
        speedBottomY: this.yBottom,
      }),
      refreshLayout: () => this.resize(),
    });
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(document.documentElement);
    this.lastFrame = performance.now();
    this.frame = requestAnimationFrame((time) => this.tick(time));
  }

  svgElement(name, attrs, parent = this.svg) {
    const element = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
    parent.appendChild(element);
    return element;
  }

  point(radius, angle) {
    const radians = angle * Math.PI / 180;
    return [this.centerX + radius * Math.cos(radians), this.centerY - radius * Math.sin(radians)];
  }

  arc(radius, startAngle, endAngle) {
    const [x1, y1] = this.point(radius, startAngle);
    const [x2, y2] = this.point(radius, endAngle);
    return `M${x1.toFixed(1)} ${y1.toFixed(1)} A${radius} ${radius} 0 0 ${endAngle > startAngle ? 0 : 1} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  }

  buildCockpitGeometry() {
    const centerX = this.centerX;
    const centerY = this.centerY;
    const innerRadius = 270;
    const outerRadius = 302;
    const leftOuterRadius = 354;
    const rightOuterRadius = outerRadius + 30;
    const random = (index) => {
      const value = Math.sin(index * 12.9898) * 43758.5453;
      return value - Math.floor(value);
    };
    this.innerRadius = innerRadius;

    this.svgElement('circle', {
      cx: centerX, cy: centerY, r: innerRadius, fill: 'none', stroke: '#73bbc8',
      'stroke-width': 1.6, opacity: .9,
    });
    [
      [outerRadius, 64, 116, '#8a949a', 4.5, .95],
      [outerRadius, 133, 162, '#ece8d4', 5, 1],
      [outerRadius, 18, 47, '#ece8d4', 5, 1],
    ].forEach(([radius, from, to, color, width, opacity]) => this.svgElement('path', {
      d: this.arc(radius, from, to), fill: 'none', stroke: color,
      'stroke-width': width, opacity, 'stroke-linecap': 'butt',
    }));

    const yTop = centerY + outerRadius * Math.sin(6 * Math.PI / 180);
    const yBottom = centerY + outerRadius * Math.sin(33 * Math.PI / 180);
    const topAngle = Math.asin((yTop - centerY) / outerRadius) * 180 / Math.PI;
    const bottomAngle = Math.asin((yBottom - centerY) / outerRadius) * 180 / Math.PI;
    this.svgElement('path', {
      d: this.arc(outerRadius, 162.8, 180 + topAngle - 1), fill: 'none', stroke: '#536166',
      'stroke-width': 2.2, opacity: .82, 'stroke-linecap': 'butt',
    });
    this.svgElement('path', {
      d: this.arc(outerRadius, -topAngle + 1, 17.2), fill: 'none', stroke: '#536166',
      'stroke-width': 2.2, opacity: .82, 'stroke-linecap': 'butt',
    });
    this.svgElement('path', {
      d: `M ${centerX - 70} ${centerY + 14} H ${centerX - 44} L ${centerX - 34} ${centerY + 2}
          M ${centerX + 70} ${centerY + 14} H ${centerX + 44} L ${centerX + 34} ${centerY + 2}`,
      fill: 'none', stroke: '#ece8d4', 'stroke-width': 2, opacity: .84,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    });
    this.svgElement('path', {
      d: `M ${centerX - 20} ${centerY} H ${centerX - 12} M ${centerX + 12} ${centerY} H ${centerX + 20}`,
      fill: 'none', stroke: '#73bbc8', 'stroke-width': 2.4, opacity: .9,
      'stroke-linecap': 'round',
    });
    this.svgElement('circle', {
      cx: centerX, cy: centerY, r: 2.8, fill: '#86cdd8', opacity: .98,
    });

    const rowCount = 20;
    this.rows = [];
    for (let index = 0; index < rowCount; index++) {
      const y = yTop + (yBottom - yTop) * index / (rowCount - 1);
      const deltaY = y - centerY;
      this.rows.push({
        y,
        leftInner: centerX - Math.sqrt(outerRadius * outerRadius - deltaY * deltaY),
        leftOuter: centerX - Math.sqrt(leftOuterRadius * leftOuterRadius - deltaY * deltaY),
        rightInner: centerX + Math.sqrt(outerRadius * outerRadius - deltaY * deltaY),
        rightOuter: centerX + Math.sqrt(rightOuterRadius * rightOuterRadius - deltaY * deltaY),
      });
    }
    this.meterGap = 8.5;
    this.engineFills = [];
    this.engineSeeds = [];
    for (let index = 0; index < rowCount; index++) {
      const row = this.rows[index];
      const x0 = row.leftOuter;
      const x1 = row.leftInner - this.meterGap;
      this.svgElement('rect', {
        x: x0, y: row.y - 1.55, width: Math.max(1, x1 - x0), height: 3.1,
        fill: '#39474d', opacity: .78,
      });
      this.engineFills.push(this.svgElement('rect', {
        x: x1 - 8, y: row.y - 1.65, width: 8, height: 3.3,
        fill: '#82c7d2', opacity: .94,
      }));
      this.engineSeeds.push({
        speed: 3.4 + random(index + 40) * 3,
        phase: random(index + 80) * Math.PI * 2,
        jitter: (random(index + 1) - .5) * .07,
      });
    }
    this.fuelMain = [];
    this.fuelRim = [];
    for (const row of this.rows) {
      this.fuelMain.push(this.svgElement('rect', {
        x: row.rightInner + this.meterGap, y: row.y - 1.65,
        width: 12.5, height: 3.3, fill: '#82c7d2',
      }));
      this.fuelRim.push(this.svgElement('rect', {
        x: row.rightInner + this.meterGap + 16.5, y: row.y - 1.65,
        width: 4, height: 3.3, fill: '#a0dce4',
      }));
    }
    this.svgElement('path', {
      d: this.arc(outerRadius, 180 + topAngle - .35, 180 + bottomAngle + .55),
      fill: 'none', stroke: '#687277', 'stroke-width': 7, opacity: .96, 'stroke-linecap': 'butt',
    });
    this.svgElement('path', {
      d: this.arc(outerRadius, -bottomAngle - .55, -topAngle + .35),
      fill: 'none', stroke: '#687277', 'stroke-width': 7, opacity: .96, 'stroke-linecap': 'butt',
    });
    this.speedPointer = this.svgElement('line', { stroke: '#ece8d4', 'stroke-width': 3.2, 'stroke-linecap': 'round' });
    this.fuelPointer = this.svgElement('line', { stroke: '#ece8d4', 'stroke-width': 3.2, 'stroke-linecap': 'round' });

    this.yTop = yTop;
    this.yBottom = yBottom;
    this.outerRadius = outerRadius;

    const rings = document.getElementById('ship-hud-shield-rings');
    this.ringDefinitions = [
      { base: 60, amplitude: 2.2, lobes: 10, speed: .46, phase: .2, alpha: .64, width: 1.35 },
      { base: 68, amplitude: 2.8, lobes: 12, speed: -.34, phase: 1.7, alpha: .52, width: 1.25 },
      { base: 76, amplitude: 3.3, lobes: 9, speed: .27, phase: 3.1, alpha: .38, width: 1.18 },
      { base: 84, amplitude: 3.8, lobes: 13, speed: -.21, phase: 4.4, alpha: .27, width: 1.12 },
    ];
    this.ringElements = this.ringDefinitions.map((definition) => this.svgElement('path', {
      fill: 'none', stroke: '#8fd1dc', 'stroke-width': definition.width,
      opacity: definition.alpha, 'vector-effect': 'non-scaling-stroke',
    }, rings));
  }

  buildPowerPanel() {
    for (let index = 0; index < POWER_SYSTEMS.length; index++) {
      const system = POWER_SYSTEMS[index];
      const pips = this.powerCols[index].querySelector('.ship-hud-pips');
      for (let pipIndex = 0; pipIndex < POWER_MAX; pipIndex++) {
        const pip = document.createElement('span');
        pip.className = 'ship-hud-pip';
        pips.appendChild(pip);
      }
      const title = `${system.short} · ${system.name}：${system.description}`;
      this.powerCols[index].title = title;
      this.powerLabels[index].title = title;
    }
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < POWER_CAPACITY; index++) {
      const cell = document.createElement('span');
      cell.className = 'ship-hud-power-cell';
      fragment.appendChild(cell);
    }
    this.powerCells.style.setProperty('--power-total', POWER_CAPACITY);
    this.powerCells.appendChild(fragment);
    this.renderPower();
  }

  bindInput() {
    this.onKeyDown = (event) => {
      const powerKey = event.code.startsWith('Arrow')
        || (event.altKey && ['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(event.code));
      if (!powerKey || this.warpRouting || !document.body.classList.contains('ui-space')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.code === 'ArrowLeft' || event.code === 'KeyA') this.selectPower(this.selectedPower - 1);
      if (event.code === 'ArrowRight' || event.code === 'KeyD') this.selectPower(this.selectedPower + 1);
      if (event.code === 'ArrowUp' || event.code === 'KeyW') this.adjustSelectedPower(1);
      if (event.code === 'ArrowDown' || event.code === 'KeyS') this.adjustSelectedPower(-1);
    };
    window.addEventListener('keydown', this.onKeyDown, { capture: true });
    window.addEventListener('pointerdown', (event) => {
      if (event.button === 0) document.getElementById('ship-hud-key-lmb')?.classList.add('is-on');
      if (event.button === 2) document.getElementById('ship-hud-key-rmb')?.classList.add('is-on');
    }, { capture: true });
    window.addEventListener('pointerup', (event) => {
      if (event.button === 0) document.getElementById('ship-hud-key-lmb')?.classList.remove('is-on');
      if (event.button === 2) document.getElementById('ship-hud-key-rmb')?.classList.remove('is-on');
    }, { capture: true });
    window.addEventListener('blur', () => {
      document.getElementById('ship-hud-key-lmb')?.classList.remove('is-on');
      document.getElementById('ship-hud-key-rmb')?.classList.remove('is-on');
    });
  }

  selectPower(index) {
    this.selectedPower = (index + POWER_SYSTEMS.length) % POWER_SYSTEMS.length;
    this.flashDpad();
    this.renderPower();
  }

  adjustSelectedPower(delta) {
    const system = POWER_SYSTEMS[this.selectedPower];
    const allocated = Object.values(this.power).reduce((sum, value) => sum + value, 0);
    if (delta > 0 && (allocated >= POWER_CAPACITY || this.power[system.id] >= POWER_MAX)) {
      this.flashDpad();
      return false;
    }
    if (delta < 0 && this.power[system.id] <= 0) {
      this.flashDpad();
      return false;
    }
    this.power[system.id] += delta > 0 ? 1 : -1;
    this.flashDpad();
    this.renderPower();
    return true;
  }

  selectPowerSystem(system) {
    const index = typeof system === 'number'
      ? system
      : POWER_SYSTEMS.findIndex((entry) => entry.id === system);
    if (index < 0) return false;
    this.selectPower(index);
    return true;
  }

  adjustPower(system, delta) {
    const direction = Math.sign(Number(delta) || 0);
    if (!direction || this.warpRouting || !this.selectPowerSystem(system)) return false;
    return this.adjustSelectedPower(direction);
  }

  flashDpad() {
    this.powerDpad.classList.add('is-flashing');
    clearTimeout(this.dpadTimer);
    this.dpadTimer = setTimeout(() => this.powerDpad.classList.remove('is-flashing'), 110);
  }

  renderPower() {
    const allocated = Object.values(this.power).reduce((sum, value) => sum + value, 0);
    const reserve = Math.max(0, POWER_CAPACITY - allocated);
    POWER_SYSTEMS.forEach((system, index) => {
      const value = this.power[system.id];
      const col = this.powerCols[index];
      const label = this.powerLabels[index];
      col.classList.toggle('is-selected', index === this.selectedPower);
      col.classList.toggle('is-max', value >= POWER_MAX);
      col.classList.toggle('is-routing', this.warpRouting && system.id === 'warp');
      label.classList.toggle('is-selected', index === this.selectedPower);
      label.classList.toggle('is-routing', this.warpRouting && system.id === 'warp');
      [...col.querySelectorAll('.ship-hud-pip')].forEach((pip, pipIndex) => {
        pip.classList.toggle('is-on', pipIndex < value);
      });
    });
    this.powerCounter.textContent = `${reserve}/${POWER_CAPACITY}`;
    [...this.powerCells.children].forEach((cell, index) => cell.classList.toggle('is-on', index < reserve));
    this.powerCursor.setAttribute('d', `M${20 + this.selectedPower * 49} 6 V16`);
  }

  transitionPower(target, duration = .82, onDone = null) {
    this.powerTransition = {
      from: { ...this.power },
      target: { ...target },
      elapsed: 0,
      duration,
      onDone,
    };
  }

  beginWarpPower() {
    if (this.warpRouting) return;
    this.preWarpPower = { ...this.power, warp: 0 };
    this.warpRouting = true;
    this.selectedPower = POWER_SYSTEMS.findIndex((system) => system.id === 'warp');
    this.powerHelp.textContent = '自动配电 · 重力核心充能';
    this.transitionPower({ weapon: 0, nav: 0, thermal: 0, gravity: 0, shield: 0, warp: POWER_MAX }, .9);
    this.renderPower();
  }

  endWarpPower(immediate = false) {
    if (!this.warpRouting && !this.preWarpPower) return;
    const restored = { ...(this.preWarpPower || DEFAULT_POWER), warp: 0 };
    const finish = () => {
      this.warpRouting = false;
      this.preWarpPower = null;
      this.powerHelp.textContent = 'ALT+WASD / 方向键';
      this.selectedPower = POWER_SYSTEMS.findIndex((system) => system.id === 'gravity');
      this.renderPower();
    };
    this.powerHelp.textContent = '跃迁结束 · 恢复常规供能';
    if (immediate) {
      this.powerTransition = null;
      this.power = restored;
      finish();
    } else {
      this.transitionPower(restored, .9, finish);
    }
  }

  setTelemetry({
    speed = 0,
    speedLimit = 1,
    boost = 0,
    pulse = 0,
    pulseFuel = 140,
    pulseFuelMax = 140,
    shield = 100,
    hull = 100,
    gun = 100,
  } = {}) {
    this.speed = Math.max(0, Number(speed) || 0);
    this.speedLimit = Math.max(1, Number(speedLimit) || 1);
    this.boost = clamp(Number(boost) || 0);
    this.pulse = clamp(Number(pulse) || 0);
    this.pulseFuelValue = Math.max(0, Number(pulseFuel) || 0);
    this.pulseFuelMax = Math.max(1, Number(pulseFuelMax) || 1);
    this.shield = clamp(Number(shield) || 0, 0, 150);
    this.hull = clamp(Number(hull) || 0, 0, 100);
    this.gun = clamp(Number(gun) || 0, 0, 150);
    const speedText = this.speed >= 1e6
      ? `${(this.speed / 1e6).toFixed(1)}M`
      : this.speed >= 1000 ? `${(this.speed / 1000).toFixed(1)}k` : this.speed.toFixed(0);
    if (this.speedValue.textContent !== speedText) this.speedValue.textContent = speedText;
    const fuelText = `${Math.ceil(this.pulseFuelValue)}/${Math.ceil(this.pulseFuelMax)}`;
    if (this.pulseFuel.textContent !== fuelText) this.pulseFuel.textContent = fuelText;
    this.gunValue.textContent = Math.round(this.gun);
    document.getElementById('ship-hud-key-rmb')?.classList.toggle('is-on', this.boost > .12);
    document.getElementById('ship-hud-key-space')?.classList.toggle('is-on', this.pulse > .12);
  }

  getPowerState() {
    const allocated = Object.values(this.power).reduce((sum, value) => sum + value, 0);
    return {
      total: POWER_CAPACITY,
      allocated,
      remaining: POWER_CAPACITY - allocated,
      selected: POWER_SYSTEMS[this.selectedPower].id,
      automatic: this.warpRouting,
      systems: Object.fromEntries(POWER_SYSTEMS.map((system) => [system.id, {
        short: system.short,
        name: system.name,
        value: this.power[system.id],
        max: POWER_MAX,
      }])),
    };
  }

  getPowerEffects() {
    return powerEffectsFor(this.power);
  }

  controlKeyBox(labelId, keyId) {
    const label = document.getElementById(labelId);
    const key = document.getElementById(keyId);
    if (!label || !key || key.offsetWidth <= 0 || key.offsetHeight <= 0) return null;
    const stageRect = this.stage.getBoundingClientRect();
    const labelRect = label.getBoundingClientRect();
    const keyRect = key.getBoundingClientRect();
    const stageScale = stageRect.width / 1600 || 1;
    return {
      label,
      key,
      left: (keyRect.left - stageRect.left) / stageScale,
      top: (keyRect.top - stageRect.top) / stageScale,
      width: keyRect.width / stageScale,
      height: keyRect.height / stageScale,
      relativeLeft: (keyRect.left - labelRect.left) / stageScale,
      relativeTop: (keyRect.top - labelRect.top) / stageScale,
    };
  }

  circleClearance(box) {
    const nearestX = clamp(this.centerX, box.left, box.left + box.width);
    const nearestY = clamp(this.centerY, box.top, box.top + box.height);
    return Math.hypot(nearestX - this.centerX, nearestY - this.centerY) - this.innerRadius;
  }

  keyCenterRadiusForClearance(angle, width, height, clearance) {
    const radians = angle * Math.PI / 180;
    let low = this.innerRadius;
    let high = this.innerRadius + 120;
    for (let iteration = 0; iteration < 24; iteration++) {
      const radius = (low + high) / 2;
      const centerX = this.centerX + radius * Math.cos(radians);
      const centerY = this.centerY - radius * Math.sin(radians);
      const box = {
        left: centerX - width / 2,
        top: centerY - height / 2,
        width,
        height,
      };
      if (this.circleClearance(box) < clearance) low = radius;
      else high = radius;
    }
    return (low + high) / 2;
  }

  placeControlKey(labelId, keyId, angle, clearance) {
    const box = this.controlKeyBox(labelId, keyId);
    if (!box) return null;
    const radius = this.keyCenterRadiusForClearance(angle, box.width, box.height, clearance);
    const [keyCenterX, keyCenterY] = this.point(radius, angle);
    box.label.style.right = 'auto';
    box.label.style.left = `${(keyCenterX - box.relativeLeft - box.width / 2).toFixed(2)}px`;
    box.label.style.top = `${(keyCenterY - box.relativeTop - box.height / 2).toFixed(2)}px`;
    const placed = this.controlKeyBox(labelId, keyId);
    return placed ? {
      angle,
      radius,
      clearance: this.circleClearance(placed),
      centerX: placed.left + placed.width / 2,
      centerY: placed.top + placed.height / 2,
    } : null;
  }

  layoutControlLabels() {
    const lowerKeys = [
      this.controlKeyBox('ship-hud-speed', 'ship-hud-key-ws'),
      this.controlKeyBox('ship-hud-pulse', 'ship-hud-key-space'),
    ].filter(Boolean);
    if (lowerKeys.length !== 2) return;
    const lowerClearances = lowerKeys.map((box) => this.circleClearance(box));
    const referenceClearance = (lowerClearances[0] + lowerClearances[1]) / 2;
    // The top gaps span 116°–133° and 47°–64°. Their exact mid-angles keep
    // each key cap visually locked between the grey crown and cream side arc.
    const lmb = this.placeControlKey('ship-hud-gun', 'ship-hud-key-lmb', 124.5, lowerClearances[0]);
    const rmb = this.placeControlKey('ship-hud-boost', 'ship-hud-key-rmb', 55.5, lowerClearances[1]);
    this.controlLayout = {
      referenceClearance,
      wsClearance: lowerClearances[0],
      spaceClearance: lowerClearances[1],
      lmbClearance: lmb?.clearance ?? null,
      rmbClearance: rmb?.clearance ?? null,
      lmbAngle: lmb?.angle ?? null,
      rmbAngle: rmb?.angle ?? null,
    };
  }

  resize() {
    const viewport = window.visualViewport;
    const width = viewport ? viewport.width : document.documentElement.clientWidth;
    const height = viewport ? viewport.height : document.documentElement.clientHeight;
    const offsetX = viewport ? viewport.offsetLeft : 0;
    const offsetY = viewport ? viewport.offsetTop : 0;
    const safeX = Math.max(4, Math.min(18, width * .012));
    const safeY = Math.max(4, Math.min(14, height * .014));
    this.scale = Math.max(.05, Math.min((width - safeX * 2) / 1600, (height - safeY * 2) / 1000));
    const x = offsetX + (width - 1600 * this.scale) / 2;
    const y = offsetY + (height - 1000 * this.scale) / 2;
    this.stage.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) scale(${this.scale})`;
    document.documentElement.style.setProperty('--ship-hud-scale', this.scale.toFixed(4));
    // Let the corner modules use otherwise empty letterbox space while keeping
    // a small physical-screen inset at every aspect ratio.
    const screenInset = Math.max(20, Math.min(52, width * .025));
    const powerLeft = (offsetX + screenInset - x) / this.scale;
    const integrityLeft = (offsetX + width - screenInset - x) / this.scale - 302;
    this.stage.style.setProperty('--ship-power-left', `${powerLeft.toFixed(2)}px`);
    this.stage.style.setProperty('--ship-integrity-left', `${integrityLeft.toFixed(2)}px`);
    this.layoutControlLabels();
    this.lastWidth = width;
    this.lastHeight = height;
  }

  ringPath(definition, time, shieldRatio) {
    const phase = definition.phase + time * definition.speed;
    const breathe = 1 + .022 * Math.sin(time * .72 + definition.phase * 1.9);
    const energy = .55 + .45 * shieldRatio;
    let path = '';
    const steps = 112;
    for (let index = 0; index <= steps; index++) {
      const angle = index / steps * Math.PI * 2;
      const waveA = Math.sin(angle * definition.lobes + phase);
      const waveB = .48 * Math.sin(angle * (definition.lobes + 3) - phase * 1.36);
      const waveC = .22 * Math.sin(angle * 3 - time * .31 + definition.phase);
      const radius = definition.base * breathe + definition.amplitude * energy * (waveA + waveB + waveC);
      path += `${index ? 'L' : 'M'}${(radius * Math.cos(angle)).toFixed(2)} ${(radius * Math.sin(angle)).toFixed(2)}`;
    }
    return `${path}Z`;
  }

  tick(now) {
    const delta = Math.min(.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const time = now / 1000;
    if (this.powerTransition) {
      this.powerTransition.elapsed += delta;
      const progress = clamp(this.powerTransition.elapsed / this.powerTransition.duration);
      const eased = progress * progress * (3 - 2 * progress);
      for (const system of POWER_SYSTEMS) {
        const from = this.powerTransition.from[system.id];
        const to = this.powerTransition.target[system.id];
        this.power[system.id] = Math.round(from + (to - from) * eased);
      }
      this.renderPower();
      if (progress >= 1) {
        const done = this.powerTransition.onDone;
        this.power = { ...this.powerTransition.target };
        this.powerTransition = null;
        this.renderPower();
        done?.();
      }
    }

    const speedRatio = clamp(this.speed / this.speedLimit);
    for (let index = 0; index < this.rows.length; index++) {
      const row = this.rows[index];
      const seed = this.engineSeeds[index];
      const x0 = row.leftOuter;
      const x1 = row.leftInner - this.meterGap;
      const totalWidth = Math.max(1, x1 - x0);
      const vertical = index / (this.rows.length - 1);
      const profile = .93 - .34 * vertical + seed.jitter;
      const ripple = (.025 + .025 * speedRatio) * Math.sin(time * seed.speed + seed.phase)
        + .012 * Math.sin(time * seed.speed * 1.67 + seed.phase * 1.7);
      const fillRatio = clamp(.06 + speedRatio * (profile - .06) + ripple, .08, .97);
      const fillWidth = totalWidth * fillRatio;
      const fill = this.engineFills[index];
      fill.setAttribute('x', x1 - fillWidth);
      fill.setAttribute('width', fillWidth);
      fill.setAttribute('opacity', .7 + .28 * speedRatio);
    }

    const fuelRatio = clamp(this.pulseFuelValue / this.pulseFuelMax);
    const lowFuel = fuelRatio < .3;
    const filledRows = Math.round(fuelRatio * this.rows.length);
    for (let index = 0; index < this.rows.length; index++) {
      const filled = index >= this.rows.length - filledRows;
      const color = filled ? (lowFuel ? '#e2483d' : '#82c7d2') : '#445158';
      const rimColor = filled ? (lowFuel ? '#ef655b' : '#a9dfe6') : '#59666b';
      this.fuelMain[index].setAttribute('fill', color);
      this.fuelMain[index].setAttribute('opacity', filled ? .96 : .66);
      this.fuelRim[index].setAttribute('fill', rimColor);
      this.fuelRim[index].setAttribute('opacity', filled ? .96 : .66);
    }
    this.pulseLabel.classList.toggle('is-low', lowFuel);
    document.getElementById('ship-hud-pulse')?.classList.toggle('is-low', lowFuel);

    const speedY = this.yBottom - speedRatio * (this.yBottom - this.yTop);
    const speedDelta = speedY - this.centerY;
    const leftInner = this.centerX - Math.sqrt(this.outerRadius * this.outerRadius - speedDelta * speedDelta);
    this.speedPointer.setAttribute('x1', leftInner - 43);
    this.speedPointer.setAttribute('y1', speedY);
    this.speedPointer.setAttribute('x2', leftInner - 5);
    this.speedPointer.setAttribute('y2', speedY);

    const fuelY = this.yBottom - fuelRatio * (this.yBottom - this.yTop);
    const fuelDelta = fuelY - this.centerY;
    const rightInner = this.centerX + Math.sqrt(this.outerRadius * this.outerRadius - fuelDelta * fuelDelta);
    this.fuelPointer.setAttribute('x1', rightInner + 5);
    this.fuelPointer.setAttribute('y1', fuelY);
    this.fuelPointer.setAttribute('x2', rightInner + 37);
    this.fuelPointer.setAttribute('y2', fuelY);
    this.fuelPointer.setAttribute('stroke', lowFuel ? '#e2483d' : '#ece8d4');
    const shieldRatio = this.shield / 100;
    this.ringDefinitions.forEach((definition, index) => {
      const ring = this.ringElements[index];
      ring.setAttribute('d', this.ringPath(definition, time + index * .19, shieldRatio));
      ring.setAttribute('opacity', (definition.alpha * (.38 + .62 * shieldRatio)
        * (.92 + .08 * Math.sin(time * (.52 + index * .07) + definition.phase))).toFixed(3));
      ring.setAttribute('transform', `rotate(${(time * definition.speed * 7 + index * 11).toFixed(2)})`);
    });
    this.hullNumber.textContent = Math.round(this.hull);
    this.hullBar.style.transform = `scaleX(${(this.hull / 100).toFixed(3)})`;
    this.hullBar.style.background = this.hull < 30 ? '#e2483d' : '#f2ecd8';

    this.frame = requestAnimationFrame((frameTime) => this.tick(frameTime));
  }
}
