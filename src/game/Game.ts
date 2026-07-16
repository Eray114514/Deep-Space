import * as THREE from 'three/webgpu';
import { AudioEngine } from './AudioEngine';
import { InputController } from './Input';
import { SaveStore } from './SaveStore';
import type { FlightState, GameMode, GameSnapshot, InventoryState, StarSystem } from './types';
import { createGalaxy } from '../simulation/Galaxy';
import { Hud } from '../ui/Hud';
import { SpaceWorld } from '../render/SpaceWorld';
import { WarpWorld } from '../render/WarpWorld';
import { SurfaceWorld } from '../render/SurfaceWorld';

const FIXED_STEP = 1 / 60;
const ATMOSPHERE_DURATION = 16.5;
const ASCENT_DURATION = 13.8;
const WARP_CHARGE_DURATION = 2.4;
const WARP_DURATION = 10.8;
const WARP_ARRIVAL_DURATION = 3.2;
const SURFACE_ENTRY_ALTITUDE = 1450;
const SURFACE_FLIGHT_CEILING = 3200;

export class Game {
  private readonly renderer: THREE.WebGPURenderer;
  private readonly input: InputController;
  private readonly audio = new AudioEngine();
  private readonly saveStore = new SaveStore();
  private readonly hud: Hud;
  private readonly galaxy = createGalaxy();
  private readonly quality: 'high' | 'balanced';
  private system: StarSystem;
  private target?: StarSystem;
  private space: SpaceWorld;
  private warp = new WarpWorld();
  private surface: SurfaceWorld;
  private mode: GameMode = 'menu';
  private resumeMode: GameMode = 'space';
  private previousTime = performance.now();
  private accumulator = 0;
  private modeTime = 0;
  private playTime = 0;
  private saveTimer = 0;
  private scanner = 0;
  private fireCooldown = 0;
  private boostIntensity = 0;
  private surfaceBoostIntensity = 0;
  private beaconActivated = false;
  private destroyedDrones = 0;
  private objective = '接近维斯佩拉 IV · 穿越大气层';
  private prompt = '';
  private health = 100;
  private shield = 100;
  private shipIntegrity = 100;
  private inventory: InventoryState;
  private discovered = new Set<number>([0]);
  private flight: FlightState = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], speed: 145, throttle: .35, rollInput: 0 };
  private readonly previousFlight: FlightState = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], speed: 145, throttle: .35, rollInput: 0 };
  private readonly renderedFlight: FlightState = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 0], speed: 145, throttle: .35, rollInput: 0 };
  private surfacePosition = new THREE.Vector3(0, 0, 230);
  private previousSurfacePosition = new THREE.Vector3(0, 0, 230);
  private renderedSurfacePosition = new THREE.Vector3(0, 0, 230);
  private surfaceAltitude = 155;
  private previousSurfaceAltitude = 155;
  private surfaceSpeed = 80;
  private previousSurfaceSpeed = 80;
  private surfaceQuaternion = new THREE.Quaternion();
  private previousSurfaceQuaternion = new THREE.Quaternion();
  private renderedSurfaceQuaternion = new THREE.Quaternion();
  private atmosphereStart = new THREE.Vector3();
  private atmosphereEnd = new THREE.Vector3();
  private atmosphereStartQuaternion = new THREE.Quaternion();
  private atmosphereEndQuaternion = new THREE.Quaternion();
  private ascentInner = new THREE.Vector3();
  private ascentOuter = new THREE.Vector3();
  private ascentQuaternion = new THREE.Quaternion();
  private ascentSurfaceStart = new THREE.Vector2();
  private playerPosition = new THREE.Vector3(7, 0, 33);
  private playerYaw = Math.PI;
  private playerPitch = 0;
  private playerVerticalVelocity = 0;
  private jetpackFuel = 1;
  private readonly tempV = new THREE.Vector3();
  private readonly tempQ = new THREE.Quaternion();
  private readonly interpolationQ = new THREE.Quaternion();
  private readonly interpolationTargetQ = new THREE.Quaternion();
  private readonly tempEuler = new THREE.Euler(0, 0, 0, 'YXZ');

  constructor(private readonly root: HTMLElement) {
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8; this.quality = memory >= 6 ? 'high' : 'balanced';
    this.renderer = new THREE.WebGPURenderer({ antialias: true, powerPreference: 'high-performance', alpha: false });
    this.renderer.domElement.className = 'webgl'; this.renderer.domElement.tabIndex = 0; this.renderer.domElement.setAttribute('aria-label', '3D 游戏画布'); this.renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault());
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, this.quality === 'high' ? 1.75 : 1.25)); this.renderer.setSize(innerWidth, innerHeight); this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.12; this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.root.appendChild(this.renderer.domElement); this.input = new InputController(this.renderer.domElement); this.hud = new Hud(root);
    const save = this.saveStore.load() ?? this.saveStore.default(); this.inventory = { ...save.inventory }; this.health = save.health; this.shield = save.shield; this.shipIntegrity = save.shipIntegrity; this.discovered = new Set(save.discovered); this.system = this.galaxy[save.systemId] ?? this.galaxy[0];
    this.space = new SpaceWorld(this.system, this.quality); this.surface = new SurfaceWorld(this.system, this.quality);
    this.bindEvents(); window.addEventListener('resize', this.resize); document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  async boot(): Promise<void> {
    await Promise.all([this.space.ship.loadHeroAsset(), this.warp.ship.loadHeroAsset(), this.surface.ship.loadHeroAsset(), this.surface.loadHeroAssets()]);
    await this.renderer.init(); this.resize(); this.space.resetShip(); this.renderer.setAnimationLoop(this.frame);
  }

  private bindEvents(): void {
    this.hud.onStart = async () => { await this.audio.start(); this.hud.hideStart(); this.input.enabled = true; this.input.requestLock(); const params = new URLSearchParams(location.search); const debugScene = params.get('scene'); if (debugScene === 'surface' || debugScene === 'surface-high') { this.finishOpening(); this.surfacePosition.set(0, 0, debugScene === 'surface-high' ? 1450 : 230); this.surfaceAltitude = debugScene === 'surface-high' ? 3060 : 92; this.surfaceSpeed = debugScene === 'surface-high' ? 210 : 70; this.setMode('surface-flight'); this.objective = debugScene === 'surface-high' ? '高层大气稀薄 · 抬头加速可返回轨道' : '寻找平坦区域并着陆'; } else if (debugScene === 'orbit-near') { this.finishOpening(); const outward = new THREE.Vector3(.1, .025, 1).normalize(); const start = this.space.planetCenter.clone().addScaledVector(outward, this.system.planet.radius + this.system.planet.atmosphere + 6200); const inward = outward.clone().negate(); this.flight.position = start.toArray(); this.flight.quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), inward).toArray(); this.flight.speed = 520; this.flight.throttle = .48; this.objective = `接近 ${this.system.planet.name} 外层大气`; } else if (debugScene === 'warp') { this.finishOpening(); this.beginWarp(this.galaxy[1]); } else if (debugScene === 'warp-cruise') { this.finishOpening(); this.target = this.galaxy[1]; this.setMode('warp'); this.modeTime = WARP_DURATION * .46; this.objective = `折叠航道 · ${this.target.name}`; } else if (debugScene === 'warp-arrival') { this.finishOpening(); this.system = this.galaxy[1]; this.space.setSystem(this.system); this.flight.speed = 240; this.flight.throttle = .72; this.setMode('warp-arrival'); this.modeTime = WARP_ARRIVAL_DURATION * .34; this.objective = `抵达 ${this.system.name} · 航道减速`; } else if (debugScene === 'atmosphere') { this.finishOpening(); const outward = new THREE.Vector3(.12, .04, 1).normalize(); const start = this.space.planetCenter.clone().addScaledVector(outward, this.system.planet.radius + this.system.planet.atmosphere + 90); const inward = outward.clone().negate(); const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), inward); this.flight.position = start.toArray(); this.flight.quaternion = q.toArray(); this.flight.speed = 920; this.beginAtmosphere(); } else if (debugScene === 'drone') { this.finishOpening(); this.playerPosition.copy(this.surface.beaconPosition).add(new THREE.Vector3(0, 0, 46)); this.playerYaw = 0; this.playerPitch = -.06; this.beaconActivated = true; this.setMode('on-foot'); this.objective = `信标遭到锁定 · 摧毁守卫无人机 0/${this.surface.drones.length}`; } else if (debugScene === 'station') { this.finishOpening(); this.playerPosition.copy(this.surface.stationPosition).add(new THREE.Vector3(0, 0, 30)); this.playerYaw = 0; this.playerPitch = -.08; this.setMode('on-foot'); this.objective = '检查废弃站结构 · 接入维护终端'; } else if (debugScene === 'foot') { this.finishOpening(); this.playerPosition.copy(this.surface.getBoardingSpawn()); this.playerYaw = 0; this.playerPitch = -.06; this.setMode('on-foot'); this.objective = '前往坠毁勘探信标 · 回收导航数据'; } else if (params.has('skipIntro')) this.finishOpening(); else { this.setMode('opening'); this.audio.pulse('warp'); this.hud.flash('折叠航道建立 · HELIOS-9'); } };
    this.hud.onResume = () => { void this.resume(); }; this.hud.onMapClose = () => this.closeMap(); this.hud.onWarp = (target) => this.beginWarp(target);
    this.input.onToggleMap = () => { if (this.mode === 'starmap') this.closeMap(); else if (this.mode === 'space') this.openMap(); };
    this.input.onInteract = () => this.interact(); this.input.onPause = () => { if (this.mode === 'starmap') this.closeMap(); else if (this.mode === 'paused') void this.resume(); else if (this.mode !== 'menu') this.pause(); };
    this.input.onUnexpectedUnlock = () => { if (!['menu', 'paused', 'starmap', 'opening', 'warp-charge', 'warp', 'warp-arrival', 'atmosphere', 'ascent'].includes(this.mode)) this.pause(); };
    this.input.onScan = () => { if (this.mode === 'on-foot') { this.scanner = 1; this.audio.pulse('scan'); this.hud.flash('地形脉冲 · 资源信号已标记'); } };
  }

  private frame = (now: number): void => {
    const delta = Math.min((now - this.previousTime) / 1000, .1); this.previousTime = now; this.accumulator += delta;
    while (this.accumulator >= FIXED_STEP) { this.fixedUpdate(FIXED_STEP); this.accumulator -= FIXED_STEP; }
    this.render(now / 1000); this.hud.update(this.snapshot());
  };

  private fixedUpdate(dt: number): void {
    if (this.mode === 'menu' || this.mode === 'paused' || this.mode === 'starmap') return;
    this.playTime += dt; this.modeTime += dt; this.saveTimer += dt; this.fireCooldown = Math.max(0, this.fireCooldown - dt); this.scanner = Math.max(0, this.scanner - dt * .35);
    if (this.saveTimer > 30) { this.save(); this.saveTimer = 0; }
    switch (this.mode) {
      case 'opening': if (this.modeTime >= 8.8) this.finishOpening(); break;
      case 'warp-charge': if (this.modeTime >= WARP_CHARGE_DURATION) { this.setMode('warp'); this.audio.pulse('warp'); } break;
      case 'space': this.updateSpaceFlight(dt); break;
      case 'warp': if (this.modeTime >= WARP_DURATION) this.finishWarp(); break;
      case 'warp-arrival': if (this.modeTime >= WARP_ARRIVAL_DURATION) this.finishWarpArrival(); break;
      case 'atmosphere': if (this.modeTime >= ATMOSPHERE_DURATION) this.finishAtmosphere(); break;
      case 'ascent': if (this.modeTime >= ASCENT_DURATION) this.finishAscent(); break;
      case 'surface-flight': this.updateSurfaceFlight(dt); break;
      case 'landed': this.updateLanded(); break;
      case 'on-foot': this.updateOnFoot(dt); break;
    }
    const speed = this.mode === 'surface-flight' ? this.surfaceSpeed : this.mode === 'space' ? this.flight.speed : 0;
    const boost = this.mode === 'surface-flight' ? this.surfaceBoostIntensity : this.mode === 'space' ? this.boostIntensity : 0;
    this.audio.setFlight(speed, this.mode === 'surface-flight' ? 1 : 0, boost);
  }

  private updateSpaceFlight(dt: number): void {
    this.capturePreviousFlight();
    const [mx, my] = this.input.consumeMouse(.0015); const roll = (this.input.isDown('KeyA') ? 1 : 0) - (this.input.isDown('KeyD') ? 1 : 0);
    const precision = this.input.isDown('ControlLeft') ? .42 : 1; this.tempEuler.set(-my * precision, -mx * precision, roll * dt * 1.1, 'YXZ'); this.tempQ.setFromEuler(this.tempEuler);
    const q = new THREE.Quaternion(...this.flight.quaternion).multiply(this.tempQ).normalize(); this.flight.quaternion = q.toArray();
    const thrust = this.input.isDown('KeyW'), brake = this.input.isDown('KeyS'), boost = this.input.isDown('ShiftLeft') || this.input.altFire;
    const altitudeBeforeMove = Math.max(0, this.space.distanceToAtmosphere(this.flight.position));
    const altitudeScale = THREE.MathUtils.smoothstep(altitudeBeforeMove, 1200, 30_000);
    this.boostIntensity = THREE.MathUtils.damp(this.boostIntensity, boost && !brake ? 1 : 0, boost ? 8.5 : 4.2, dt);
    const targetSpeed = brake ? 48 : boost ? THREE.MathUtils.lerp(920, 7200, altitudeScale) : thrust ? THREE.MathUtils.lerp(440, 2600, altitudeScale) : THREE.MathUtils.lerp(145, 720, altitudeScale);
    this.flight.speed = THREE.MathUtils.damp(this.flight.speed, targetSpeed, brake ? 5.8 : boost ? 2.55 : thrust ? 2.05 : 1.2, dt);
    const targetThrottle = brake ? .08 : boost ? 1 : thrust ? .72 : .28; this.flight.throttle = THREE.MathUtils.lerp(this.flight.throttle, targetThrottle, 1 - Math.exp(-dt * 9));
    this.flight.boost = this.boostIntensity;
    const travelScale = THREE.MathUtils.lerp(.08, .12, altitudeScale);
    const forward = this.tempV.set(0, 0, -1).applyQuaternion(q); const p = new THREE.Vector3(...this.flight.position).addScaledVector(forward, this.flight.speed * dt * travelScale); this.flight.position = p.toArray(); this.flight.velocity = forward.multiplyScalar(this.flight.speed).toArray();
    const altitude = this.space.distanceToAtmosphere(this.flight.position);
    this.prompt = altitude < 900 ? '大气层外缘接近 · 减速并保持切入角' : altitude < 7000 ? '行星引力井 · 大气层厚度已锁定' : '';
    if (altitude <= 45) this.beginAtmosphere();
    if (this.input.fire && this.fireCooldown <= 0) { this.audio.pulse('shot'); this.fireCooldown = .16; }
  }

  private updateSurfaceFlight(dt: number): void {
    this.previousSurfacePosition.copy(this.surfacePosition); this.previousSurfaceAltitude = this.surfaceAltitude; this.previousSurfaceSpeed = this.surfaceSpeed; this.previousSurfaceQuaternion.copy(this.surfaceQuaternion);
    const [mx, my] = this.input.consumeMouse(.00145); const roll = (this.input.isDown('KeyA') ? 1 : 0) - (this.input.isDown('KeyD') ? 1 : 0);
    this.tempEuler.set(-my, -mx, roll * dt * .85, 'YXZ'); this.surfaceQuaternion.multiply(this.tempQ.setFromEuler(this.tempEuler)).normalize();
    const thrust = this.input.isDown('KeyW'), brake = this.input.isDown('KeyS'), boost = this.input.isDown('ShiftLeft') || this.input.altFire;
    this.surfaceBoostIntensity = THREE.MathUtils.damp(this.surfaceBoostIntensity, boost && !brake ? 1 : 0, boost ? 8.5 : 4.2, dt);
    const highAltitude = THREE.MathUtils.smoothstep(this.surfaceAltitude, 500, SURFACE_FLIGHT_CEILING);
    const target = brake ? 10 : boost ? THREE.MathUtils.lerp(280, 520, highAltitude) : thrust ? THREE.MathUtils.lerp(155, 260, highAltitude) : THREE.MathUtils.lerp(62, 110, highAltitude); this.surfaceSpeed = THREE.MathUtils.damp(this.surfaceSpeed, target, brake ? 7 : boost ? 3.8 : 2.8, dt);
    const forward = this.tempV.set(0, 0, -1).applyQuaternion(this.surfaceQuaternion); this.surfacePosition.x += forward.x * this.surfaceSpeed * dt; this.surfacePosition.z += forward.z * this.surfaceSpeed * dt; this.surfaceAltitude += forward.y * this.surfaceSpeed * dt;
    this.surfaceAltitude = THREE.MathUtils.clamp(this.surfaceAltitude, 6, SURFACE_FLIGHT_CEILING);
    this.prompt = this.surfaceAltitude < 20 && this.surfaceSpeed < 65 ? 'F · 执行自动着陆' : this.surfaceAltitude < 8 ? '拉起机头 · 地形警告' : this.surfaceAltitude > 2600 ? '高层大气稀薄 · 抬头加速可返回轨道' : this.surfaceAltitude > 800 ? '云下地形层 · 继续下降以寻找着陆点' : '';
    if (this.surfaceAltitude >= SURFACE_FLIGHT_CEILING - 35 && forward.y > .1 && this.surfaceSpeed > 180) this.beginAscent();
  }

  private updateLanded(): void {
    this.prompt = 'F · 离开飞船　　W · 垂直起飞'; if (this.input.isDown('KeyW')) { this.surfaceAltitude = 9; this.surfaceSpeed = 26; this.surfacePosition.set(0, 0, 22); this.surfaceQuaternion.identity(); this.setMode('surface-flight'); this.audio.pulse('land'); this.hud.flash('起落架收回 · 地表飞行'); }
  }

  private updateOnFoot(dt: number): void {
    const [mx, my] = this.input.consumeMouse(.0017); this.playerYaw -= mx; this.playerPitch = THREE.MathUtils.clamp(this.playerPitch - my, -1.38, 1.38);
    const forward = this.tempV.set(-Math.sin(this.playerYaw), 0, -Math.cos(this.playerYaw)); const right = new THREE.Vector3(Math.cos(this.playerYaw), 0, -Math.sin(this.playerYaw)); const move = new THREE.Vector3();
    if (this.input.isDown('KeyW')) move.add(forward); if (this.input.isDown('KeyS')) move.sub(forward); if (this.input.isDown('KeyD')) move.add(right); if (this.input.isDown('KeyA')) move.sub(right);
    if (move.lengthSq() > 0) { move.normalize().multiplyScalar((this.input.isDown('ShiftLeft') ? 25 : 14) * dt); this.playerPosition.add(move); }
    const ground = this.surface.heightAt(this.playerPosition.x, this.playerPosition.z) + 1.72; const grounded = this.playerPosition.y <= ground + .035;
    if (grounded) { this.playerPosition.y = ground; this.playerVerticalVelocity = Math.max(0, this.playerVerticalVelocity); this.jetpackFuel = Math.min(1, this.jetpackFuel + dt * .72); if (this.input.isDown('Space')) { this.playerVerticalVelocity = 8.8; this.jetpackFuel = Math.max(.35, this.jetpackFuel); } }
    else if (this.input.isDown('Space') && this.jetpackFuel > 0) { this.playerVerticalVelocity = Math.min(11.5, this.playerVerticalVelocity + 19 * dt); this.jetpackFuel = Math.max(0, this.jetpackFuel - dt * .48); }
    this.playerVerticalVelocity -= 18 * dt; this.playerPosition.y += this.playerVerticalVelocity * dt; if (this.playerPosition.y < ground) { this.playerPosition.y = ground; this.playerVerticalVelocity = 0; }
    const resource = this.surface.nearestResource(this.playerPosition, 10); const shipDistance = this.surface.distanceToShip(this.playerPosition); const stationDistance = this.surface.distanceToStation(this.playerPosition); const beaconDistance = this.surface.distanceToBeacon(this.playerPosition);
    this.prompt = shipDistance < 7.5 ? 'F · 通过侧舱门登上 ASTERION S-9' : beaconDistance < 9 && !this.beaconActivated ? 'F · 启动坠毁勘探信标' : stationDistance < 18 ? 'F · 接入废弃站终端' : resource ? `鼠标左键 · 采集 ${resource.kind.toUpperCase()}（可选）` : 'V · 扫描　SHIFT · 动力冲刺　SPACE · 喷气背包　鼠标左键 · 武器';
    if (this.input.fire && resource && this.fireCooldown <= 0) { const drop = this.surface.harvest(resource); this.inventory[drop.kind] += drop.amount; this.audio.pulse('shot'); this.hud.flash(`已采集 ${drop.kind.toUpperCase()} +${drop.amount}`); this.fireCooldown = .28; if (this.inventory.crystal >= 8 && this.inventory.ferrite >= 25) this.objective = '资源充足 · 返回飞船并打开星图'; }
    const drone = this.surface.nearestDrone(this.playerPosition); if (this.input.fire && !resource && drone && this.fireCooldown <= 0) { const destroyed = this.surface.hitDrone(drone); this.audio.pulse('shot'); this.fireCooldown = .18; if (destroyed) { this.destroyedDrones += 1; this.inventory.ferrite += 3; if (this.beaconActivated && this.destroyedDrones >= this.surface.drones.length) { this.inventory.warpCells += 1; this.objective = '防卫完成 · 信标已解锁跃迁电池 · 返回飞船'; this.hud.flash('勘探数据回收 · 跃迁电池 +1'); } else this.hud.flash(`守卫无人机摧毁 · ${this.destroyedDrones}/${this.surface.drones.length}`); } }
    for (const drone of this.surface.drones) if (drone.position.distanceTo(this.playerPosition) < 22) { this.shield = Math.max(0, this.shield - dt * 3.8); if (this.shield <= 0) this.health = Math.max(1, this.health - dt * 2.1); }
  }

  private render(time: number): void {
    if (this.mode === 'menu') {
      this.flight.position = [0, Math.sin(time * .3) * .8, 0]; this.space.update(this.flight, time, .86); this.renderer.render(this.space.scene, this.space.camera); return;
    }
    if (this.mode === 'warp-charge') { const p = THREE.MathUtils.clamp(this.modeTime / WARP_CHARGE_DURATION, 0, 1); this.space.update(this.flight, time); this.space.setWarpCharge(p); this.renderer.render(this.space.scene, this.space.camera); return; }
    if (this.mode === 'opening' || this.mode === 'warp') {
      const duration = this.mode === 'opening' ? 8.8 : WARP_DURATION, progress = THREE.MathUtils.clamp(this.modeTime / duration, 0, 1); this.warp.update(time, progress, this.target ?? this.system, this.mode === 'warp' ? this.system : undefined); this.audio.warpSweep(Math.sin(progress * Math.PI)); this.renderer.render(this.warp.scene, this.warp.camera); return;
    }
    if (this.mode === 'warp-arrival') { const p = THREE.MathUtils.clamp(this.modeTime / WARP_ARRIVAL_DURATION, 0, 1); this.space.update(this.flight, time, .18 * (1 - p)); this.space.setWarpCharge(1 - p); this.renderer.render(this.space.scene, this.space.camera); return; }
    if (this.mode === 'atmosphere') { const p = THREE.MathUtils.clamp(this.modeTime / ATMOSPHERE_DURATION, 0, 1); if (p < .45) { const entryProgress = THREE.MathUtils.smoothstep(p / .45, 0, 1); const position = this.atmosphereStart.clone().lerp(this.atmosphereEnd, entryProgress); const quaternion = this.atmosphereStartQuaternion.clone().slerp(this.atmosphereEndQuaternion, THREE.MathUtils.smoothstep(entryProgress, .04, .82)); const entryFlight: FlightState = { ...this.flight, position: position.toArray(), quaternion: quaternion.toArray(), speed: THREE.MathUtils.lerp(this.flight.speed, 340, entryProgress), throttle: THREE.MathUtils.lerp(.62, .86, entryProgress) }; this.space.setAtmosphereIntensity(entryProgress); this.space.update(entryFlight, time); this.renderer.render(this.space.scene, this.space.camera); } else { const highAltitude = Math.max(SURFACE_ENTRY_ALTITUDE + 420, this.system.planet.atmosphere * .55); this.surface.updateAtmosphere(time, (p - .45) / .55, highAltitude, SURFACE_ENTRY_ALTITUDE); this.renderer.render(this.surface.scene, this.surface.camera); } return; }
    if (this.mode === 'ascent') { const p = THREE.MathUtils.clamp(this.modeTime / ASCENT_DURATION, 0, 1); if (p < .46) { this.surface.updateAscent(time, p / .46, this.ascentSurfaceStart.x, this.ascentSurfaceStart.y, this.surfaceQuaternion); this.renderer.render(this.surface.scene, this.surface.camera); } else { const exitProgress = THREE.MathUtils.smoothstep((p - .46) / .54, 0, 1); const position = this.ascentInner.clone().lerp(this.ascentOuter, exitProgress); const exitFlight: FlightState = { ...this.flight, position: position.toArray(), quaternion: this.ascentQuaternion.toArray(), speed: THREE.MathUtils.lerp(520, 1450, exitProgress), throttle: .95 }; this.space.setAtmosphereIntensity(1 - exitProgress); this.space.update(exitFlight, time); this.renderer.render(this.space.scene, this.space.camera); } return; }
    if (this.mode === 'surface-flight') {
      const alpha = THREE.MathUtils.clamp(this.accumulator / FIXED_STEP, 0, 1);
      this.renderedSurfacePosition.copy(this.previousSurfacePosition).lerp(this.surfacePosition, alpha);
      this.renderedSurfaceQuaternion.copy(this.previousSurfaceQuaternion).slerp(this.surfaceQuaternion, alpha);
      const altitude = THREE.MathUtils.lerp(this.previousSurfaceAltitude, this.surfaceAltitude, alpha);
      const speed = THREE.MathUtils.lerp(this.previousSurfaceSpeed, this.surfaceSpeed, alpha);
      this.surface.updateFlight(time, this.renderedSurfacePosition.x, this.renderedSurfacePosition.z, altitude, this.renderedSurfaceQuaternion, Math.min(speed / 125, 1), this.surfaceBoostIntensity);
      this.renderer.render(this.surface.scene, this.surface.camera); return;
    }
    if (this.mode === 'landed') { this.surface.updateLanded(time); this.renderer.render(this.surface.scene, this.surface.camera); return; }
    if (this.mode === 'on-foot') { this.surface.updateOnFoot(time, this.playerPosition, this.playerYaw, this.playerPitch, this.scanner); this.renderer.render(this.surface.scene, this.surface.camera); return; }
    this.space.update(this.interpolateFlight(THREE.MathUtils.clamp(this.accumulator / FIXED_STEP, 0, 1)), time); this.renderer.render(this.space.scene, this.space.camera);
  }

  private finishOpening(): void { this.space.resetShip(); this.flight = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, -145], speed: 145, throttle: .35, rollInput: 0 }; this.setMode('space'); this.objective = `进入 ${this.system.planet.name} 大气层`; this.hud.flash(`${this.system.name} · 跃迁抵达`); }
  private beginWarp(target: StarSystem): void { if (this.inventory.warpCells <= 0 || target.id === this.system.id) return; this.target = target; this.inventory.warpCells -= 1; this.hud.showMap(false); this.input.releaseLock(); this.setMode('warp-charge'); this.audio.pulse('scan'); this.hud.flash(`航向锁定 · ${target.name}`); this.save(); }
  private finishWarp(): void { if (!this.target) return; this.system = this.target; this.target = undefined; this.discovered.add(this.system.id); this.space.setSystem(this.system); this.surface.setSystem(this.system, this.quality); this.beaconActivated = false; this.destroyedDrones = 0; this.flight = { position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, -240], speed: 240, throttle: .72, rollInput: 0 }; this.setMode('warp-arrival'); this.objective = this.system.planet.landable ? `进入 ${this.system.planet.name} 大气层` : '完成轨道扫描'; this.hud.flash(`${this.system.name} · 航道减速`); this.save(); }
  private finishWarpArrival(): void { this.setMode('space'); this.input.requestLock(); this.flight.speed = 165; this.flight.throttle = .38; this.hud.flash(`${this.system.name} · 航道退出完成`); }
  private beginAtmosphere(): void { if (!this.system.planet.landable) { this.hud.flash('该天体无法安全进入大气层'); this.flight.speed = 40; return; } const start = new THREE.Vector3(...this.flight.position); const outward = start.clone().sub(this.space.planetCenter).normalize(); const tangent = new THREE.Vector3(0, 1, 0).cross(outward); if (tangent.lengthSq() < .01) tangent.set(1, 0, 0); tangent.normalize(); const endRadial = outward.clone().addScaledVector(tangent, .19).normalize(); this.atmosphereStart.copy(start); this.atmosphereEnd.copy(this.space.planetCenter).addScaledVector(endRadial, this.system.planet.radius + Math.max(SURFACE_ENTRY_ALTITUDE + 420, this.system.planet.atmosphere * .55)); const pathDirection = this.atmosphereEnd.clone().sub(this.atmosphereStart).normalize(); this.atmosphereStartQuaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), pathDirection); this.atmosphereEndQuaternion.copy(this.atmosphereStartQuaternion).multiply(new THREE.Quaternion().setFromAxisAngle(tangent, -.08)); this.setMode('atmosphere'); const debugPhase = Number(new URLSearchParams(location.search).get('phase')); if (Number.isFinite(debugPhase)) this.modeTime = ATMOSPHERE_DURATION * THREE.MathUtils.clamp(debugPhase, 0, .98); this.objective = '穿越外层大气 · 云层与地表仍在下方'; this.audio.pulse('land'); this.save(); }
  private finishAtmosphere(): void { this.space.setAtmosphereIntensity(0); this.surfacePosition.set(0, 0, 720); this.surfaceAltitude = SURFACE_ENTRY_ALTITUDE; this.surfaceSpeed = 118; this.surfaceQuaternion.identity(); this.setMode('surface-flight'); this.objective = '下降穿过云层 · 寻找平坦区域'; this.hud.flash(`${this.system.planet.name} · 云下飞行层`); }
  private beginAscent(): void { const outward = new THREE.Vector3(.12, .04, 1).normalize(); const tangent = new THREE.Vector3(0, 1, 0).cross(outward).normalize(); const outerDirection = outward.clone().addScaledVector(tangent, -.2).normalize(); this.ascentSurfaceStart.set(this.surfacePosition.x, this.surfacePosition.z); this.ascentInner.copy(this.space.planetCenter).addScaledVector(outward, this.system.planet.radius + this.system.planet.atmosphere * .72); this.ascentOuter.copy(this.space.planetCenter).addScaledVector(outerDirection, this.system.planet.radius + this.system.planet.atmosphere + 760); this.ascentQuaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), this.ascentOuter.clone().sub(this.ascentInner).normalize()); this.setMode('ascent'); this.objective = '保持抬头 · 穿出云层与外层散射带'; this.audio.pulse('land'); this.hud.flash(`${this.system.planet.name} · 大气层脱离`); this.save(); }
  private finishAscent(): void { this.space.setAtmosphereIntensity(0); this.flight = { position: this.ascentOuter.toArray(), quaternion: this.ascentQuaternion.toArray(), velocity: new THREE.Vector3(0, 0, -1).applyQuaternion(this.ascentQuaternion).multiplyScalar(1450).toArray(), speed: 1450, throttle: .72, rollInput: 0 }; this.setMode('space'); this.input.requestLock(); this.objective = '近轨航行 · TAB 打开星图'; this.hud.flash(`${this.system.planet.name} · 轨道空间恢复`); this.save(); }

  private interact(): void {
    if (this.mode === 'surface-flight') { if (this.surfaceAltitude < 20 && this.surfaceSpeed < 65) { this.setMode('landed'); this.surfacePosition.set(0, 0, 22); this.audio.pulse('land'); this.objective = '离开飞船 · 调查废弃信标'; this.hud.flash('着陆完成 · 舱压稳定'); this.save(); } else this.hud.flash('降低速度与高度后再着陆'); return; }
    if (this.mode === 'landed') { this.playerPosition.copy(this.surface.getBoardingSpawn()); this.playerYaw = 0; this.playerPitch = 0; this.setMode('on-foot'); this.audio.pulse('ui'); this.objective = '前往坠毁勘探信标 · 回收导航数据'; this.hud.flash('侧舱门开启 · 外部环境可生存'); this.save(); return; }
    if (this.mode === 'on-foot' && this.surface.distanceToBeacon(this.playerPosition) < 9 && !this.beaconActivated) { this.beaconActivated = true; this.surface.activateBeacon(); this.objective = `信标遭到锁定 · 摧毁守卫无人机 0/${this.surface.drones.length}`; this.audio.pulse('scan'); this.hud.flash('勘探信标上线 · 敌对信号接近'); return; }
    if (this.mode === 'on-foot' && this.surface.distanceToStation(this.playerPosition) < 18) { if (!this.beaconActivated) { this.objective = '终端定位成功 · 前往东南方坠毁信标'; this.hud.flash('旧航路恢复 · 信标坐标已标记'); } else if (this.destroyedDrones < this.surface.drones.length) this.hud.flash('终端被守卫无人机信号压制'); else { this.shield = 100; this.shipIntegrity = 100; this.hud.flash('废弃终端接入 · 护盾与船体修复完成'); } this.audio.pulse('scan'); this.save(); return; }
    if (this.mode === 'on-foot' && this.surface.distanceToShip(this.playerPosition) < 7.5) { this.setMode('landed'); this.audio.pulse('ui'); this.objective = 'W 起飞或再次离船'; this.hud.flash('侧舱门关闭 · 驾驶权限恢复'); this.save(); }
  }

  private openMap(): void { this.resumeMode = this.mode; this.setMode('starmap'); this.input.releaseLock(); this.hud.showMap(true, this.galaxy); this.audio.pulse('ui'); }
  private closeMap(): void { if (this.mode !== 'starmap') return; this.hud.showMap(false); this.setMode(this.resumeMode === 'starmap' ? 'space' : this.resumeMode); this.input.requestLock(); this.audio.pulse('ui'); }
  private pause(): void {
    if (this.mode === 'menu' || this.mode === 'paused' || ['opening', 'warp-charge', 'warp', 'warp-arrival', 'atmosphere', 'ascent'].includes(this.mode)) return;
    this.resumeMode = this.mode; this.setMode('paused'); this.input.releaseLock(); this.audio.setFlight(0, 0); this.hud.showPause(true);
  }
  private async resume(): Promise<void> {
    if (this.mode !== 'paused') return;
    await this.audio.start();
    const locked = await this.input.requestLock();
    if (this.mode !== 'paused') return;
    if (!locked) { this.hud.flash('点击返回游戏以重新捕获鼠标'); return; }
    this.previousTime = performance.now(); this.accumulator = 0;
    this.hud.showPause(false); this.setMode(this.resumeMode === 'paused' ? 'space' : this.resumeMode);
  }
  private setMode(mode: GameMode): void { this.mode = mode; this.modeTime = 0; this.prompt = ''; this.syncRenderState(); }

  private capturePreviousFlight(): void {
    this.previousFlight.position[0] = this.flight.position[0]; this.previousFlight.position[1] = this.flight.position[1]; this.previousFlight.position[2] = this.flight.position[2];
    this.previousFlight.quaternion[0] = this.flight.quaternion[0]; this.previousFlight.quaternion[1] = this.flight.quaternion[1]; this.previousFlight.quaternion[2] = this.flight.quaternion[2]; this.previousFlight.quaternion[3] = this.flight.quaternion[3];
    this.previousFlight.velocity[0] = this.flight.velocity[0]; this.previousFlight.velocity[1] = this.flight.velocity[1]; this.previousFlight.velocity[2] = this.flight.velocity[2];
    this.previousFlight.speed = this.flight.speed; this.previousFlight.throttle = this.flight.throttle; this.previousFlight.rollInput = this.flight.rollInput; this.previousFlight.boost = this.flight.boost;
  }

  private interpolateFlight(alpha: number): FlightState {
    for (let i = 0; i < 3; i += 1) {
      this.renderedFlight.position[i] = THREE.MathUtils.lerp(this.previousFlight.position[i], this.flight.position[i], alpha);
      this.renderedFlight.velocity[i] = THREE.MathUtils.lerp(this.previousFlight.velocity[i], this.flight.velocity[i], alpha);
    }
    this.interpolationQ.set(...this.previousFlight.quaternion).slerp(this.interpolationTargetQ.set(...this.flight.quaternion), alpha).toArray(this.renderedFlight.quaternion);
    this.renderedFlight.speed = THREE.MathUtils.lerp(this.previousFlight.speed, this.flight.speed, alpha);
    this.renderedFlight.throttle = THREE.MathUtils.lerp(this.previousFlight.throttle, this.flight.throttle, alpha);
    this.renderedFlight.rollInput = THREE.MathUtils.lerp(this.previousFlight.rollInput, this.flight.rollInput, alpha);
    this.renderedFlight.boost = THREE.MathUtils.lerp(this.previousFlight.boost ?? 0, this.flight.boost ?? 0, alpha);
    return this.renderedFlight;
  }

  private syncRenderState(): void {
    this.capturePreviousFlight();
    this.previousSurfacePosition.copy(this.surfacePosition); this.renderedSurfacePosition.copy(this.surfacePosition);
    this.previousSurfaceAltitude = this.surfaceAltitude; this.previousSurfaceSpeed = this.surfaceSpeed;
    this.previousSurfaceQuaternion.copy(this.surfaceQuaternion); this.renderedSurfaceQuaternion.copy(this.surfaceQuaternion);
  }

  private snapshot(): GameSnapshot {
    const altitude = this.mode === 'space' ? Math.max(0, this.space.distanceToAtmosphere(this.flight.position)) : ['surface-flight', 'landed', 'on-foot'].includes(this.mode) ? (this.mode === 'surface-flight' ? this.surfaceAltitude : 0) : this.mode === 'atmosphere' ? THREE.MathUtils.lerp(this.system.planet.atmosphere, SURFACE_ENTRY_ALTITUDE, this.modeTime / ATMOSPHERE_DURATION) : this.mode === 'ascent' ? THREE.MathUtils.lerp(SURFACE_FLIGHT_CEILING, this.system.planet.atmosphere + 760, this.modeTime / ASCENT_DURATION) : 0;
    return { mode: this.mode, speed: this.mode === 'surface-flight' ? this.surfaceSpeed : this.mode === 'on-foot' ? 0 : this.mode === 'ascent' ? THREE.MathUtils.lerp(this.surfaceSpeed, 285, this.modeTime / ASCENT_DURATION) : this.flight.speed, altitude, health: this.health, shield: this.shield, shipIntegrity: this.shipIntegrity, inventory: this.inventory, system: this.system, target: this.target, objective: this.objective, prompt: this.prompt, scanner: this.scanner, quality: this.quality, boost: this.mode === 'surface-flight' ? this.surfaceBoostIntensity : this.mode === 'space' ? this.boostIntensity : 0 };
  }

  private save(): void { const saveMode = this.mode === 'on-foot' ? 'on-foot' : this.mode === 'landed' ? 'landed' : this.mode === 'surface-flight' ? 'surface-flight' : 'space'; this.saveStore.save({ systemId: this.system.id, mode: saveMode, inventory: this.inventory, health: this.health, shield: this.shield, shipIntegrity: this.shipIntegrity, discovered: [...this.discovered] }); }
  private resize = (): void => { const w = innerWidth, h = innerHeight; this.renderer.setSize(w, h); for (const camera of [this.space.camera, this.warp.camera, this.surface.camera]) { camera.aspect = w / h; camera.updateProjectionMatrix(); } };
  private onVisibilityChange = (): void => {
    if (document.hidden) { this.pause(); return; }
    this.previousTime = performance.now(); this.accumulator = 0;
  };
}
