import * as THREE from 'three/webgpu';
import { cameraPosition, color, float, normalWorld, positionWorld, uniform } from 'three/tsl';
import type { FlightState, StarSystem } from '../game/types';
import { mulberry32 } from '../simulation/Galaxy';
import { ShipView } from './Ship';
import { createCloudTexture, createPlanetTexture, createTerrainTexture } from './materials';

export class SpaceWorld {
  private static marsTexture?: THREE.Texture;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(57, 1, .1, 520_000);
  readonly ship = new ShipView();
  readonly planetCenter = new THREE.Vector3();
  private planet = new THREE.Group();
  private stars?: THREE.Points;
  private dust?: THREE.Points;
  private speedLines?: THREE.LineSegments;
  private speedLinePositions?: Float32Array;
  private speedLineBaseZ?: Float32Array;
  private speedLineVelocity?: Float32Array;
  private speedLineLength?: Float32Array;
  private speedLineTravel = 0;
  private boostVisual = 0;
  private previousBoost = 0;
  private boostKick = 0;
  private sun = new THREE.DirectionalLight(0xffe2bd, 1.65);
  private system!: StarSystem;
  private targetCamera = new THREE.Vector3();
  private lookTarget = new THREE.Vector3();
  private desiredLookTarget = new THREE.Vector3();
  private lastUpdateTime = 0;
  private cloud?: THREE.Group;
  private atmosphereEntry = uniform(0);

  constructor(system: StarSystem, quality: 'high' | 'balanced') {
    this.scene.background = new THREE.Color(0x01040a); this.scene.fog = new THREE.FogExp2(0x02060c, .0000015);
    this.camera.position.set(0, 7, 32); this.camera.lookAt(0, 0, -30);
    this.sun.position.set(-900, 450, 350); this.sun.castShadow = true; this.scene.add(this.sun);
    this.scene.add(new THREE.HemisphereLight(0x79a9bc, 0x020306, .62));
    const heroFill = new THREE.PointLight(0x8fe8ff, 950, 360, 1.15); heroFill.position.set(-24, 24, 42); this.scene.add(heroFill);
    const rimFill = new THREE.DirectionalLight(0x486dff, 1.25); rimFill.position.set(180, -80, -240); this.scene.add(rimFill);
    this.scene.add(this.ship); this.buildStars(quality === 'high' ? 9000 : 5000); this.setSystem(system);
  }

  setSystem(system: StarSystem): void {
    this.system = system;
    this.planetCenter.set(system.planet.radius * .08, -system.planet.radius * .045, -system.planet.radius * 2.24);
    this.planet.removeFromParent(); this.planet = this.buildPlanet(system); this.scene.add(this.planet);
  }

  resetShip(): void { this.ship.position.set(0, 0, 0); this.ship.quaternion.identity(); }

  distanceToAtmosphere(position: [number, number, number]): number {
    return this.planetCenter.distanceTo(new THREE.Vector3(...position)) - (this.system.planet.radius + this.system.planet.atmosphere);
  }

  update(flight: FlightState, time: number, cinematic = 0): void {
    const renderDelta = this.lastUpdateTime > 0 ? THREE.MathUtils.clamp(time - this.lastUpdateTime, 1 / 240, .05) : 1 / 60;
    this.lastUpdateTime = time;
    const requestedBoost = THREE.MathUtils.clamp(flight.boost ?? 0, 0, 1);
    const boostRise = Math.max(0, requestedBoost - this.previousBoost); this.previousBoost = requestedBoost;
    this.boostKick = Math.min(1, this.boostKick + boostRise * 2.4); this.boostKick = THREE.MathUtils.damp(this.boostKick, 0, 5.2, renderDelta);
    this.boostVisual = THREE.MathUtils.damp(this.boostVisual, requestedBoost, requestedBoost > this.boostVisual ? 11 : 4.8, renderDelta);
    this.ship.position.set(...flight.position); this.ship.quaternion.set(...flight.quaternion); if (cinematic > 0) this.ship.rotateY(.3 * cinematic); this.ship.setThrottle(flight.throttle, this.boostVisual); this.ship.setLanded(false); this.ship.update(time);
    const flightQuaternion = new THREE.Quaternion(...flight.quaternion);
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(flightQuaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(flightQuaternion);
    const speedFactor = THREE.MathUtils.smoothstep(flight.speed, 160, 2400);
    const desiredDistance = cinematic > 0 ? THREE.MathUtils.lerp(42, 22, cinematic) : 30 + speedFactor * 2.5 + this.boostVisual * 3 + this.boostKick * 1.5;
    this.targetCamera.copy(this.ship.position).addScaledVector(forward, desiredDistance).addScaledVector(up, 8.5);
    if (cinematic > 0) this.targetCamera.addScaledVector(new THREE.Vector3(1, 0, 0).applyQuaternion(flightQuaternion), -13 * cinematic);
    this.camera.position.lerp(this.targetCamera, 1 - Math.exp(-renderDelta * (cinematic > 0 ? 4.1 : 8.3)));
    this.desiredLookTarget.copy(this.ship.position).addScaledVector(forward, -80).addScaledVector(up, 1.5);
    this.lookTarget.lerp(this.desiredLookTarget, 1 - Math.exp(-renderDelta * 13));
    this.camera.up.lerp(up, 1 - Math.exp(-renderDelta * 10)); this.camera.lookAt(this.lookTarget);
    const flightFov = 57 + speedFactor * 5 + this.boostVisual * 6.5 + this.boostKick * 1.25;
    this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, flightFov, 1 - Math.exp(-renderDelta * 8)); this.camera.updateProjectionMatrix();
    this.planet.rotation.y = time * .0035; if (this.cloud) { this.cloud.rotation.y = -time * .006; this.cloud.children.forEach((layer, index) => { layer.rotation.y = time * (.0015 + index * .0007); }); }
    if (this.stars) this.stars.rotation.y = time * .0007;
    if (this.dust) {
      this.dust.position.copy(this.ship.position); this.dust.quaternion.copy(flightQuaternion);
      if (this.dust.material instanceof THREE.PointsMaterial) { this.dust.material.opacity = Math.max(this.atmosphereEntry.value * .16, speedFactor * .035 + this.boostVisual * .15); this.dust.material.size = 1.15 + this.boostVisual * 1.65; }
    }
    if (this.speedLines) {
      this.speedLines.position.copy(this.ship.position); this.speedLines.quaternion.copy(flightQuaternion);
      this.updateSpeedLines(renderDelta, flight.speed, speedFactor);
      if (this.speedLines.material instanceof THREE.LineBasicMaterial) this.speedLines.material.opacity = speedFactor * .04 + this.boostVisual * .3;
    }
  }

  setAtmosphereIntensity(value: number): void {
    this.atmosphereEntry.value = value;
    const haze = THREE.MathUtils.smoothstep(value, .48, 1); const hazeColor = new THREE.Color(this.system.planet.biome === 'basalt' ? 0x8a7370 : this.system.planet.biome === 'ice' ? 0x6c97aa : 0x536f71);
    if (this.scene.background instanceof THREE.Color) this.scene.background.copy(new THREE.Color(0x01040a).lerp(hazeColor, haze));
    if (this.scene.fog instanceof THREE.FogExp2) { this.scene.fog.color.copy(new THREE.Color(0x02060c).lerp(hazeColor, haze)); this.scene.fog.density = THREE.MathUtils.lerp(.0000015, .00052, Math.pow(haze, 1.35)); }
    if (this.dust && this.dust.material instanceof THREE.PointsMaterial) { this.dust.material.opacity = value * .16; this.dust.material.size = 1.1 + value * 2.2; this.dust.material.color.set(0xb9e9f2); }
  }

  setWarpCharge(value: number): void {
    const p = THREE.MathUtils.smoothstep(value, 0, 1); this.camera.fov = THREE.MathUtils.lerp(57, 64, p); this.camera.updateProjectionMatrix();
    if (this.dust?.material instanceof THREE.PointsMaterial) { this.dust.material.opacity = p * .2; this.dust.material.size = 1.1 + p * 2.5; this.dust.material.color.set(0xa7e9f4); }
  }

  private buildPlanet(system: StarSystem): THREE.Group {
    const group = new THREE.Group(); group.position.copy(this.planetCenter);
    const p = system.planet; const segments = 224;
    const texture = p.biome === 'basalt' ? this.getMarsTexture() : createPlanetTexture(p.seed, p.primary, p.secondary);
    const surfaceDetail = createTerrainTexture(p.biome, p.seed + 411, 1024); surfaceDetail.repeat.set(38, 19);
    const surfaceColor = p.biome === 'basalt' ? 0xe8d7cc : 0xffffff;
    const geometry = new THREE.SphereGeometry(p.radius, segments, segments / 2);
    const positions = geometry.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(positions.count * 3);
    const normal = new THREE.Vector3();
    const entryDirection = this.planetCenter.clone().negate().normalize();
    const lowColor = new THREE.Color(p.biome === 'basalt' ? 0xa98778 : p.secondary);
    const highColor = new THREE.Color(p.biome === 'basalt' ? 0xe3c8b8 : p.primary);
    const vertexColor = new THREE.Color();
    for (let i = 0; i < positions.count; i += 1) {
      normal.set(positions.getX(i), positions.getY(i), positions.getZ(i)).normalize();
      const continental = (Math.sin(normal.x * 4.7 + p.seed * .013) + Math.sin(normal.y * 6.1 - p.seed * .009) + Math.cos(normal.z * 5.3 + normal.x * 2.2)) / 3;
      const ridges = 1 - Math.abs(Math.sin((normal.x * 8.7 + normal.z * 6.4 - normal.y * 4.1) + p.seed * .017));
      const detail = Math.sin(normal.x * 29 + p.seed) * Math.cos(normal.z * 31 - p.seed * .4) * Math.sin(normal.y * 23 + 1.7);
      const angle = Math.acos(THREE.MathUtils.clamp(normal.dot(entryDirection), -1, 1));
      const basin = Math.exp(-(angle * angle) / (.34 * .34 * 2));
      const basinRim = Math.exp(-((angle - .36) * (angle - .36)) / (.06 * .06 * 2));
      const elevation = p.radius * (continental * .010 + ridges * .006 + detail * .0025 - basin * .018 + basinRim * .012);
      normal.multiplyScalar(p.radius + elevation); positions.setXYZ(i, normal.x, normal.y, normal.z);
      const colorMix = THREE.MathUtils.clamp(.54 + elevation / (p.radius * .045), .12, .94);
      vertexColor.copy(lowColor).lerp(highColor, colorMix); colors[i * 3] = vertexColor.r; colors[i * 3 + 1] = vertexColor.g; colors[i * 3 + 2] = vertexColor.b;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3)); geometry.computeVertexNormals(); geometry.computeBoundingSphere();
    const surface = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map: texture, color: surfaceColor, vertexColors: p.biome !== 'basalt', roughness: .9, roughnessMap: surfaceDetail, metalness: .012 })); surface.receiveShadow = true; group.add(surface);
    this.cloud = new THREE.Group();
    const cloudHeights = [.24]; const cloudOpacities = [.18];
    for (let i = 0; i < cloudHeights.length; i += 1) {
      const cloudMap = createCloudTexture(p.seed + i * 197);
      const layer = new THREE.Mesh(
        new THREE.SphereGeometry(p.radius + p.atmosphere * cloudHeights[i], 176, 88),
        new THREE.MeshStandardMaterial({ map: cloudMap, color: i === 0 ? 0xe7eef0 : 0xffffff, transparent: true, opacity: cloudOpacities[i], alphaTest: .018, depthWrite: false, roughness: 1 }),
      );
      layer.rotation.set(i * .007, i * .53, i * .011); this.cloud.add(layer);
    }
    group.add(this.cloud);
    const atmosphereColor = p.biome === 'basalt' ? 0x8ec9d4 : p.accent;
    const shellGeometry = new THREE.SphereGeometry(p.radius + p.atmosphere, 128, 64);
    const viewDirection = cameraPosition.sub(positionWorld).normalize();
    const fresnel = normalWorld.dot(viewDirection).abs().oneMinus();
    const atmosphereMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, toneMapped: false });
    atmosphereMaterial.colorNode = color(atmosphereColor).mul(float(.7).add(fresnel.mul(.9)));
    // Outside the atmosphere this reads as a bright limb. As the camera crosses
    // the shell it yields to aerial haze instead of becoming a giant glass wall.
    atmosphereMaterial.opacityNode = fresnel.pow(12).mul(.58).add(fresnel.pow(1.6).mul(.04)).mul(this.atmosphereEntry.oneMinus().pow(4));
    const atmosphere = new THREE.Mesh(shellGeometry, atmosphereMaterial); atmosphere.name = 'atmosphere-optical-shell'; group.add(atmosphere);
    const lowerShellGeometry = new THREE.SphereGeometry(p.radius + p.atmosphere * .5, 144, 72);
    const lowerAtmosphereMaterial = new THREE.MeshBasicNodeMaterial({ transparent: true, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, toneMapped: false });
    lowerAtmosphereMaterial.colorNode = color(atmosphereColor).mul(float(.28).add(fresnel.mul(.42)));
    lowerAtmosphereMaterial.opacityNode = fresnel.pow(2.2).mul(.035).mul(this.atmosphereEntry.oneMinus().pow(3));
    const lowerAtmosphere = new THREE.Mesh(lowerShellGeometry, lowerAtmosphereMaterial); lowerAtmosphere.name = 'atmosphere-lower-haze'; group.add(lowerAtmosphere);
    const moon = new THREE.Mesh(new THREE.SphereGeometry(p.radius * .12, 48, 24), new THREE.MeshStandardMaterial({ color: 0x918d84, roughness: 1 })); moon.position.set(-p.radius * 2.1, p.radius * .82, -p.radius * .88); group.add(moon);
    return group;
  }

  private getMarsTexture(): THREE.Texture {
    if (!SpaceWorld.marsTexture) {
      const texture = new THREE.TextureLoader().load('/assets/planet/mars-viking-4k.jpg');
      texture.colorSpace = THREE.SRGBColorSpace; texture.wrapS = THREE.RepeatWrapping; texture.anisotropy = 16;
      SpaceWorld.marsTexture = texture;
    }
    return SpaceWorld.marsTexture;
  }

  private buildStars(count: number): void {
    const random = mulberry32(82013); const positions = new Float32Array(count * 3); const colors = new Float32Array(count * 3); const color = new THREE.Color();
    for (let i = 0; i < count; i += 1) {
      const r = 120_000 + random() * 340_000, phi = Math.acos(2 * random() - 1), theta = random() * Math.PI * 2;
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta); positions[i * 3 + 1] = r * Math.cos(phi); positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
      color.setHSL(.52 + random() * .13, .25 + random() * .45, .68 + random() * .3); colors[i * 3] = color.r; colors[i * 3 + 1] = color.g; colors[i * 3 + 2] = color.b;
    }
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3)); geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.stars = new THREE.Points(geometry, new THREE.PointsMaterial({ size: 28, sizeAttenuation: true, vertexColors: true, transparent: true, opacity: .85, depthWrite: false })); this.scene.add(this.stars);
    const dCount = 1800; const dPos = new Float32Array(dCount * 3);
    for (let i = 0; i < dCount; i += 1) { dPos[i * 3] = (random() - .5) * 650; dPos[i * 3 + 1] = (random() - .5) * 420; dPos[i * 3 + 2] = (random() - .5) * 900; }
    const dg = new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.BufferAttribute(dPos, 3)); this.dust = new THREE.Points(dg, new THREE.PointsMaterial({ color: 0x87dded, size: 1.2, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })); this.scene.add(this.dust);
    const lineCount = 150; const linePositions = new Float32Array(lineCount * 6);
    this.speedLineBaseZ = new Float32Array(lineCount); this.speedLineVelocity = new Float32Array(lineCount); this.speedLineLength = new Float32Array(lineCount);
    for (let i = 0; i < lineCount; i += 1) {
      const angle = random() * Math.PI * 2; const radius = 34 + Math.pow(random(), .62) * 86; const x = Math.cos(angle) * radius; const y = Math.sin(angle) * radius * .58; const z = (random() - .5) * 190; const length = 1.5 + random() * 4;
      this.speedLineBaseZ[i] = z; this.speedLineVelocity[i] = .72 + random() * .68; this.speedLineLength[i] = length;
      const p = i * 6; linePositions[p] = x; linePositions[p + 1] = y; linePositions[p + 2] = z - length; linePositions[p + 3] = x; linePositions[p + 4] = y; linePositions[p + 5] = z + length;
    }
    this.speedLinePositions = linePositions;
    const lineGeometry = new THREE.BufferGeometry(); lineGeometry.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
    this.speedLines = new THREE.LineSegments(lineGeometry, new THREE.LineBasicMaterial({ color: 0xa9f5ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true }));
    this.speedLines.frustumCulled = false; this.scene.add(this.speedLines);
  }

  private updateSpeedLines(dt: number, speed: number, speedFactor: number): void {
    if (!this.speedLines || !this.speedLinePositions || !this.speedLineBaseZ || !this.speedLineVelocity || !this.speedLineLength) return;
    this.speedLineTravel += dt * (38 + Math.min(speed, 7200) * .022) * (.35 + this.boostVisual * 1.9);
    const range = 330, minZ = -205;
    for (let i = 0; i < this.speedLineBaseZ.length; i += 1) {
      const wrapped = ((this.speedLineBaseZ[i] + this.speedLineTravel * this.speedLineVelocity[i] - minZ) % range + range) % range;
      const z = minZ + wrapped; const length = this.speedLineLength[i] * (1 + speedFactor * 1.15 + this.boostVisual * 2.8); const p = i * 6;
      this.speedLinePositions[p + 2] = z - length * .5; this.speedLinePositions[p + 5] = z + length * .5;
    }
    const attribute = this.speedLines.geometry.getAttribute('position') as THREE.BufferAttribute; attribute.needsUpdate = true;
  }
}
