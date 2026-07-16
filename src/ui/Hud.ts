import type { GameSnapshot, StarSystem } from '../game/types';

export class Hud {
  readonly root: HTMLElement;
  private readonly modeLabel: HTMLElement;
  private readonly speed: HTMLElement;
  private readonly altitude: HTMLElement;
  private readonly health: HTMLElement;
  private readonly shield: HTMLElement;
  private readonly integrity: HTMLElement;
  private readonly objective: HTMLElement;
  private readonly prompt: HTMLElement;
  private readonly location: HTMLElement;
  private readonly scanner: HTMLElement;
  private readonly resources: HTMLElement;
  private readonly startScreen: HTMLElement;
  private readonly map: HTMLElement;
  private readonly mapCanvas: HTMLCanvasElement;
  private readonly targetName: HTMLElement;
  private readonly targetMeta: HTMLElement;
  private readonly warpButton: HTMLButtonElement;
  private readonly pause: HTMLElement;
  private mapSystems: StarSystem[] = [];
  private selected?: StarSystem;

  onStart?: () => void;
  onResume?: () => void;
  onWarp?: (system: StarSystem) => void;
  onMapClose?: () => void;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'ui-root';
    this.root.innerHTML = `
      <div class="vignette"></div><div class="grain"></div><div class="boost-fx"></div>
      <section class="start-screen" data-ui="start">
        <div class="brand-kicker">DEEP RANGE SURVEY // S-09</div>
        <h1><span>ASTRAL</span> FRONTIER</h1>
        <div class="cn-title">星渊边界</div>
        <p>穿越折叠空间。降落未知世界。把失落的信标带回群星。</p>
        <button class="primary-start" data-action="start"><i></i>开始探索<span>ENTER THE FRONTIER</span></button>
        <div class="system-check"><b></b> ASTERION S-9 // 系统待机 <em>BUILD 0.9.18 · ASSET R4</em></div>
      </section>
      <div class="hud" data-ui="hud">
        <div class="top-line"><div class="brand-mini">AF<span>//</span>S9</div><div class="compass"><i></i><b>N</b><span>018°</span><i></i></div><div class="mode" data-ui="mode">近轨飞行</div></div>
        <div class="reticle"><i></i><b></b><span></span></div>
        <aside class="status-card">
          <div class="micro-title">ASTERION S-9 <span>FLIGHT STATUS</span></div>
          <div class="metric"><label>速度</label><strong data-ui="speed">0</strong><small>M/S</small></div>
          <div class="metric"><label>高度</label><strong data-ui="altitude">0</strong><small>KM</small></div>
          <div class="bars">
            <label>船体 <span data-ui="integrity">100</span></label><i><b class="bar-integrity"></b></i>
            <label>护盾 <span data-ui="shield">100</span></label><i><b class="bar-shield"></b></i>
            <label>生命 <span data-ui="health">100</span></label><i><b class="bar-health"></b></i>
          </div>
        </aside>
        <aside class="objective-card">
          <div class="micro-title">ACTIVE DIRECTIVE <span>01</span></div>
          <strong data-ui="objective">接近维斯佩拉 IV</strong>
          <p data-ui="location">赫利俄斯-9 // 近轨</p>
          <div class="scan-line"><i></i><span data-ui="scanner"></span></div>
        </aside>
        <div class="resources" data-ui="resources"></div>
        <div class="prompt" data-ui="prompt"></div>
        <div class="flight-help"><b>W</b> 推进　<b>S</b> 制动　<b>A D</b> 横滚　<b>SHIFT</b> 加力　<b>TAB</b> 星图　<b>F</b> 互动</div>
      </div>
      <section class="star-map" data-ui="map">
        <header><div><span>NAVIGATION MATRIX</span><h2>深空星图</h2></div><button data-action="map-close">返回驾驶舱　ESC</button></header>
        <canvas data-ui="map-canvas"></canvas>
        <div class="map-legend"><span><i class="reachable"></i>跃迁范围内</span><span><i></i>远距信标</span><b>拖动旋转 · 滚轮缩放 · 点击选点</b></div>
        <aside class="target-panel">
          <span>SELECTED DESTINATION</span><h3 data-ui="target-name">选择一个恒星</h3><p data-ui="target-meta">点击明亮节点读取导航数据</p>
          <button data-action="warp" disabled>锁定航线并跃迁</button>
        </aside>
      </section>
      <section class="pause" data-ui="pause"><div><span>FLIGHT SUSPENDED</span><h2>暂停</h2><p>鼠标控制已释放，飞船姿态锁定。</p><button data-action="resume">返回游戏</button></div></section>
    `;
    parent.appendChild(this.root);
    const q = <T extends Element>(selector: string) => {
      const element = this.root.querySelector<T>(selector); if (!element) throw new Error(`Missing UI ${selector}`); return element;
    };
    this.modeLabel = q('[data-ui="mode"]'); this.speed = q('[data-ui="speed"]'); this.altitude = q('[data-ui="altitude"]');
    this.health = q('[data-ui="health"]'); this.shield = q('[data-ui="shield"]'); this.integrity = q('[data-ui="integrity"]');
    this.objective = q('[data-ui="objective"]'); this.prompt = q('[data-ui="prompt"]'); this.location = q('[data-ui="location"]');
    this.scanner = q('[data-ui="scanner"]'); this.resources = q('[data-ui="resources"]'); this.startScreen = q('[data-ui="start"]');
    this.map = q('[data-ui="map"]'); this.mapCanvas = q('[data-ui="map-canvas"]'); this.targetName = q('[data-ui="target-name"]');
    this.targetMeta = q('[data-ui="target-meta"]'); this.warpButton = q('[data-action="warp"]'); this.pause = q('[data-ui="pause"]');
    q('[data-action="start"]').addEventListener('click', () => this.onStart?.());
    q('[data-action="resume"]').addEventListener('click', () => this.onResume?.());
    q('[data-action="map-close"]').addEventListener('click', () => this.onMapClose?.());
    this.warpButton.addEventListener('click', () => { if (this.selected) this.onWarp?.(this.selected); });
    this.mapCanvas.addEventListener('click', this.pickStar);
  }

  hideStart(): void { this.startScreen.classList.add('hidden'); this.root.classList.add('playing'); }
  showPause(visible: boolean): void { this.pause.classList.toggle('visible', visible); }

  showMap(visible: boolean, systems: StarSystem[] = []): void {
    this.map.classList.toggle('visible', visible);
    if (visible) { this.mapSystems = systems; this.selected = undefined; this.drawMap(); }
  }

  update(snapshot: GameSnapshot): void {
    this.root.style.setProperty('--boost', snapshot.boost.toFixed(3));
    const modeNames: Record<string, string> = { opening: '折叠空间', space: '近轨飞行', 'warp-charge': '航向锁定', warp: '跃迁中', 'warp-arrival': '航道退出', atmosphere: '大气层进入', ascent: '大气层脱离', 'surface-flight': '低空飞行', landed: '着陆锁定', 'on-foot': '地表勘探', paused: '姿态锁定' };
    this.modeLabel.textContent = modeNames[snapshot.mode] ?? snapshot.mode;
    this.speed.textContent = Math.round(snapshot.speed).toLocaleString();
    this.altitude.textContent = snapshot.altitude > 999 ? (snapshot.altitude / 1000).toFixed(1) : snapshot.altitude.toFixed(1);
    this.health.textContent = Math.round(snapshot.health).toString(); this.shield.textContent = Math.round(snapshot.shield).toString();
    this.integrity.textContent = Math.round(snapshot.shipIntegrity).toString(); this.objective.textContent = snapshot.objective;
    this.location.textContent = `${snapshot.system.name} // ${snapshot.system.planet.name}`; this.prompt.textContent = snapshot.prompt;
    this.prompt.classList.toggle('visible', Boolean(snapshot.prompt));
    this.scanner.style.width = `${snapshot.scanner * 100}%`;
    this.resources.innerHTML = `<span>FE ${snapshot.inventory.ferrite}</span><span>CR ${snapshot.inventory.crystal}</span><span>BIO ${snapshot.inventory.biomass}</span><b>跃迁电池 ${snapshot.inventory.warpCells}</b>`;
    this.root.querySelector<HTMLElement>('.bar-health')!.style.width = `${snapshot.health}%`;
    this.root.querySelector<HTMLElement>('.bar-shield')!.style.width = `${snapshot.shield}%`;
    this.root.querySelector<HTMLElement>('.bar-integrity')!.style.width = `${snapshot.shipIntegrity}%`;
  }

  flash(text: string): void {
    const node = document.createElement('div'); node.className = 'system-flash'; node.textContent = text; this.root.appendChild(node);
    requestAnimationFrame(() => node.classList.add('visible')); setTimeout(() => node.classList.remove('visible'), 1800); setTimeout(() => node.remove(), 2400);
  }

  private drawMap(): void {
    const rect = this.mapCanvas.getBoundingClientRect(); const dpr = Math.min(devicePixelRatio, 2);
    this.mapCanvas.width = rect.width * dpr; this.mapCanvas.height = rect.height * dpr;
    const ctx = this.mapCanvas.getContext('2d'); if (!ctx) return; ctx.scale(dpr, dpr);
    const w = rect.width, h = rect.height; ctx.clearRect(0, 0, w, h);
    const gradient = ctx.createRadialGradient(w * 0.48, h * 0.5, 0, w * 0.48, h * 0.5, Math.max(w, h) * 0.7);
    gradient.addColorStop(0, 'rgba(25,80,96,.18)'); gradient.addColorStop(1, 'rgba(0,3,8,0)'); ctx.fillStyle = gradient; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(99,211,222,.08)'; ctx.lineWidth = 1;
    for (let r = 80; r < w * 0.5; r += 80) { ctx.beginPath(); ctx.ellipse(w * 0.48, h * 0.52, r, r * 0.38, -0.22, 0, Math.PI * 2); ctx.stroke(); }
    for (const system of this.mapSystems) {
      const x = w * 0.48 + system.position[0] * 1.6 + system.position[2] * 0.25;
      const y = h * 0.52 + system.position[2] * 0.55 - system.position[1] * 3.2;
      if (x < 8 || x > w - 8 || y < 8 || y > h - 8) continue;
      const radius = system.reachable ? 2.2 : 0.75;
      ctx.fillStyle = system.reachable ? `#${system.color.toString(16).padStart(6, '0')}` : 'rgba(155,190,202,.35)';
      if (system.reachable) { ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 10; }
      ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
      (system as StarSystem & { mapX?: number; mapY?: number }).mapX = x; (system as StarSystem & { mapX?: number; mapY?: number }).mapY = y;
    }
  }

  private pickStar = (event: MouseEvent): void => {
    const rect = this.mapCanvas.getBoundingClientRect(); const x = event.clientX - rect.left; const y = event.clientY - rect.top;
    let best: StarSystem | undefined; let bestD = 14;
    for (const system of this.mapSystems) {
      const mapped = system as StarSystem & { mapX?: number; mapY?: number }; if (mapped.mapX === undefined) continue;
      const d = Math.hypot(x - mapped.mapX, y - mapped.mapY!); if (d < bestD) { bestD = d; best = system; }
    }
    if (!best) return; this.selected = best; this.targetName.textContent = best.name;
    this.targetMeta.innerHTML = `${best.spectral} 型恒星　·　${best.distance} 光年<br>${best.planet.name}　·　${best.planet.landable ? '可大气进入' : '轨道扫描限定'}`;
    this.warpButton.disabled = !best.reachable || best.id === 0; this.warpButton.textContent = best.reachable ? (best.id === 0 ? '当前位置' : '锁定航线并跃迁') : '超出跃迁范围';
    this.drawMap();
  };
}
