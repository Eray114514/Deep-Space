import * as THREE from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { Biome, StarSystem } from '../game/types';
import { mulberry32, terrainHeight } from '../simulation/Galaxy';
import { ShipView } from './Ship';
import { createSurfaceCloudTexture, createTerrainTexture } from './materials';

interface ResourceNode { mesh: THREE.Object3D; kind: 'ferrite' | 'crystal' | 'biomass'; amount: number; }

function createFracturedRock(seed: number): THREE.BufferGeometry {
  let geometry: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, 2); if (geometry.index) geometry = geometry.toNonIndexed();
  const p = geometry.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i += 1) { const x = p.getX(i), y = p.getY(i), z = p.getZ(i); const n = .78 + (Math.sin(x * 17.3 + seed) + Math.sin(y * 23.7 - seed * .7) + Math.cos(z * 19.1 + seed * .31)) * .075; p.setXYZ(i, x * n, y * n, z * n); }
  geometry.computeVertexNormals(); return geometry;
}

function createStratifiedCliff(seed: number): THREE.BufferGeometry {
  let geometry: THREE.BufferGeometry = new THREE.CylinderGeometry(1, 1, 1, 11, 8, false); const p = geometry.attributes.position as THREE.BufferAttribute;
  const shoulder = .88 + Math.sin(seed * 1.71) * .055;
  const crown = .68 + Math.cos(seed * 2.13) * .08;
  const profile = [1.1, 1.03, .99, .96, .93, shoulder, .84, crown * 1.08, crown];
  for (let i = 0; i < p.count; i += 1) { const x = p.getX(i), y = p.getY(i), z = p.getZ(i); const layer = THREE.MathUtils.clamp(Math.round((y + .5) * 8), 0, 8); const angular = .9 + Math.sin(Math.atan2(z, x) * 5 + seed) * .09 + Math.cos(Math.atan2(z, x) * 3 - seed) * .05; p.setXYZ(i, x * profile[layer] * angular, y, z * profile[layer] * angular); }
  if (geometry.index) geometry = geometry.toNonIndexed(); geometry.computeVertexNormals(); return geometry;
}

export class SurfaceWorld {
  private static outpostSource?: Promise<THREE.Group>;
  private static droneSource?: Promise<THREE.Group>;
  private static rockSource?: Promise<THREE.Group>;
  private static cliffSource?: Promise<THREE.Group>;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(64, 1, .08, 18_000);
  readonly ship = new ShipView();
  readonly resources: ResourceNode[] = [];
  readonly drones: THREE.Group[] = [];
  readonly stationPosition = new THREE.Vector3();
  readonly beaconPosition = new THREE.Vector3();
  readonly boardingPosition = new THREE.Vector3();
  private system!: StarSystem;
  private sun = new THREE.DirectionalLight(0xffd6a8, 4.8);
  private terrain?: THREE.Mesh;
  private farTerrain?: THREE.Mesh;
  private sky?: THREE.Mesh;
  private propRoot = new THREE.Group();
  private clouds?: THREE.Group;
  private onFootTarget = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private flightLookTarget = new THREE.Vector3();
  private desiredFlightLookTarget = new THREE.Vector3();
  private lastFlightUpdateTime = 0;
  private flightBoostVisual = 0;
  private previousFlightBoost = 0;
  private flightBoostKick = 0;
  private beacon?: THREE.Group;
  private outpostTemplate?: THREE.Group;
  private droneTemplate?: THREE.Group;
  private rockTemplate?: THREE.Mesh;
  private cliffTemplate?: THREE.Mesh;
  private readonly landedClearance = 2.14;
  private readonly quality: 'high' | 'balanced';

  constructor(system: StarSystem, quality: 'high' | 'balanced') {
    this.quality = quality;
    this.scene.background = new THREE.Color(0x66838c); this.scene.fog = new THREE.FogExp2(0x71858a, .0005);
    this.sun.position.set(-900, 1450, 600); this.sun.castShadow = true; this.sun.shadow.mapSize.set(quality === 'high' ? 2048 : 1024, quality === 'high' ? 2048 : 1024); this.sun.shadow.camera.left = -450; this.sun.shadow.camera.right = 450; this.sun.shadow.camera.top = 450; this.sun.shadow.camera.bottom = -450; this.sun.shadow.bias = -.0002; this.scene.add(this.sun);
    this.scene.add(new THREE.HemisphereLight(0xb9deea, 0x2e1e18, 1.4)); this.scene.add(this.ship, this.propRoot); this.setSystem(system, quality);
  }

  setSystem(system: StarSystem, quality: 'high' | 'balanced'): void {
    this.system = system; this.terrain?.removeFromParent(); this.farTerrain?.removeFromParent(); this.sky?.removeFromParent(); this.propRoot.clear(); this.resources.length = 0; this.drones.length = 0;
    this.buildTerrain(quality === 'high' ? 192 : 144); this.buildSky(); this.buildProps(quality === 'high' ? 850 : 420); this.buildStation(); this.buildBeacon(); this.buildDrones();
    const ground = this.heightAt(0, 22); this.ship.position.set(0, ground + this.landedClearance, 22); this.ship.rotation.set(0, 0, 0); this.ship.setLanded(true); this.updateBoardingAnchor();
  }

  async loadHeroAssets(): Promise<void> {
    const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
    SurfaceWorld.outpostSource ??= loader.loadAsync('/assets/outpost.glb').then((gltf) => gltf.scene);
    SurfaceWorld.droneSource ??= loader.loadAsync('/assets/sentinel-drone.glb').then((gltf) => gltf.scene);
    SurfaceWorld.rockSource ??= loader.loadAsync('/assets/surface-rock.glb').then((gltf) => gltf.scene);
    SurfaceWorld.cliffSource ??= loader.loadAsync('/assets/surface-cliff.glb').then((gltf) => gltf.scene);
    const [outpost, drone, rock, cliff] = await Promise.all([SurfaceWorld.outpostSource, SurfaceWorld.droneSource, SurfaceWorld.rockSource, SurfaceWorld.cliffSource]);
    this.outpostTemplate = outpost; this.droneTemplate = drone;
    rock.traverse((node) => { if (!this.rockTemplate && node instanceof THREE.Mesh) this.rockTemplate = node; });
    cliff.traverse((node) => { if (!this.cliffTemplate && node instanceof THREE.Mesh) this.cliffTemplate = node; });
    this.setSystem(this.system, this.quality);
  }

  heightAt(x: number, z: number): number {
    const rawHeight = (px: number, pz: number): number => {
      const radius = Math.hypot(px, pz); const basin = -28 * Math.exp(-(radius * radius) / 520000); const rim = 24 * Math.exp(-((radius - 880) * (radius - 880)) / 42000);
      return terrainHeight(px, pz, this.system.planet.seed) + basin + rim - Math.min(180, (px * px + pz * pz) / 46000);
    };
    // The abandoned outpost was built on a cut-and-fill pad. Blending the
    // terrain itself avoids the unmistakable "prop hovering over noise" look.
    const stationX = -150, stationZ = -190;
    const distance = Math.hypot(x - stationX, z - stationZ);
    const padBlend = 1 - THREE.MathUtils.smoothstep(distance, 48, 104);
    return THREE.MathUtils.lerp(rawHeight(x, z), rawHeight(stationX, stationZ), padBlend);
  }

  updateAtmosphere(time: number, progress: number, startAltitude = 1900, endAltitude = 1450): void {
    const eased = 1 - Math.pow(1 - progress, 3); const altitude = THREE.MathUtils.lerp(startAltitude, endAltitude, eased);
    const z = THREE.MathUtils.lerp(1850, 720, eased); const x = Math.sin(progress * 3.4) * 58;
    this.ship.position.set(x, this.heightAt(x, z) + altitude, z); this.ship.rotation.set(-.11 + Math.sin(time * 8) * .008, 0, Math.sin(time * 11) * .012); this.ship.setThrottle(.65); this.ship.update(time);
    const behind = new THREE.Vector3(0, 24 + progress * 8, 66).applyQuaternion(this.ship.quaternion); this.camera.position.copy(this.ship.position).add(behind);
    const groundAhead = this.heightAt(x, z - 1050); this.camera.lookAt(this.ship.position.x, groundAhead + 120, this.ship.position.z - 1050);
    this.camera.fov = 70 - progress * 7; this.camera.updateProjectionMatrix(); if (this.clouds) this.clouds.position.z += .18;
    if (this.scene.fog instanceof THREE.FogExp2) this.scene.fog.density = THREE.MathUtils.lerp(.00028, this.system.planet.biome === 'mycelium' ? .00042 : .00018, THREE.MathUtils.smoothstep(progress, .12, .9));
  }

  updateAscent(time: number, progress: number, startX: number, startZ: number, quaternion: THREE.Quaternion): void {
    const eased = THREE.MathUtils.smoothstep(progress, 0, 1); const altitude = THREE.MathUtils.lerp(3100, 3900, eased); const x = THREE.MathUtils.lerp(startX, 0, eased); const z = THREE.MathUtils.lerp(startZ, 1850, eased);
    this.ship.position.set(x, this.heightAt(x, z) + altitude, z); this.ship.quaternion.copy(quaternion); this.ship.rotateX(-eased * .16); this.ship.setThrottle(.95); this.ship.setLanded(false); this.ship.update(time);
    const behind = new THREE.Vector3(0, 18 + eased * 5, 58).applyQuaternion(this.ship.quaternion); this.camera.position.copy(this.ship.position).add(behind); const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.ship.quaternion); this.camera.up.lerp(new THREE.Vector3(0, 1, 0).applyQuaternion(this.ship.quaternion), .12); this.camera.lookAt(this.tmp.copy(this.ship.position).addScaledVector(forward, 220)); this.camera.fov = 62 + eased * 5; this.camera.updateProjectionMatrix();
    if (this.scene.fog instanceof THREE.FogExp2) this.scene.fog.density = THREE.MathUtils.lerp(this.system.planet.biome === 'mycelium' ? .0008 : .00048, .0042, THREE.MathUtils.smoothstep(progress, .18, 1));
  }

  updateFlight(time: number, x: number, z: number, altitude: number, quaternion: THREE.Quaternion, throttle: number, boost = 0): void {
    const renderDelta = this.lastFlightUpdateTime > 0 ? THREE.MathUtils.clamp(time - this.lastFlightUpdateTime, 1 / 240, .05) : 1 / 60;
    this.lastFlightUpdateTime = time;
    const requestedBoost = THREE.MathUtils.clamp(boost, 0, 1); const boostRise = Math.max(0, requestedBoost - this.previousFlightBoost); this.previousFlightBoost = requestedBoost;
    this.flightBoostKick = Math.min(1, this.flightBoostKick + boostRise * 2.2); this.flightBoostKick = THREE.MathUtils.damp(this.flightBoostKick, 0, 5.5, renderDelta);
    this.flightBoostVisual = THREE.MathUtils.damp(this.flightBoostVisual, requestedBoost, requestedBoost > this.flightBoostVisual ? 11 : 5, renderDelta);
    const ground = this.heightAt(x, z); this.ship.position.set(x, ground + altitude, z); this.ship.quaternion.copy(quaternion); this.ship.setThrottle(throttle, this.flightBoostVisual); this.ship.setLanded(false); this.ship.update(time);
    const back = new THREE.Vector3(-5.5, 7.5, 28 + Math.min(throttle * 5, 5) + this.flightBoostVisual * 4 + this.flightBoostKick * 2).applyQuaternion(quaternion); this.camera.position.lerp(this.tmp.copy(this.ship.position).add(back), 1 - Math.exp(-renderDelta * 9));
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion); this.camera.up.lerp(new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion), 1 - Math.exp(-renderDelta * 9));
    this.desiredFlightLookTarget.copy(this.ship.position).addScaledVector(forward, 85 + this.flightBoostVisual * 34); this.flightLookTarget.lerp(this.desiredFlightLookTarget, 1 - Math.exp(-renderDelta * 13)); this.camera.lookAt(this.flightLookTarget);
    this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, 60 + this.flightBoostVisual * 7 + this.flightBoostKick * 1.2, 1 - Math.exp(-renderDelta * 8)); this.camera.updateProjectionMatrix();
  }

  updateLanded(time: number): void {
    this.ship.setThrottle(0); this.ship.setLanded(true); this.ship.update(time); const ground = this.heightAt(0, 22); this.ship.position.y = ground + this.landedClearance; this.updateBoardingAnchor();
    this.camera.position.lerp(new THREE.Vector3(24, ground + 13, 45), .045); this.camera.lookAt(0, ground + 3, 8);
  }

  updateOnFoot(time: number, position: THREE.Vector3, yaw: number, pitch: number, scanner: number): void {
    position.y = Math.max(position.y, this.heightAt(position.x, position.z) + 1.72);
    this.camera.position.copy(position); this.camera.rotation.order = 'YXZ'; this.camera.rotation.set(pitch, yaw, 0);
    this.camera.fov = scanner > 0 ? 58 : 67; this.camera.updateProjectionMatrix();
    for (let i = 0; i < this.drones.length; i += 1) {
      const drone = this.drones[i]; const base = drone.userData.base as THREE.Vector3; drone.position.set(base.x + Math.sin(time * .7 + i) * 9, base.y + Math.sin(time * 2 + i) * 1.8, base.z + Math.cos(time * .7 + i) * 9); drone.rotation.y = time * .8;
    }
  }

  nearestResource(position: THREE.Vector3, maxDistance = 12): ResourceNode | undefined {
    let best: ResourceNode | undefined; let distance = maxDistance;
    for (const node of this.resources) { if (!node.mesh.visible) continue; const d = node.mesh.position.distanceTo(position); if (d < distance) { distance = d; best = node; } }
    return best;
  }

  harvest(node: ResourceNode): { kind: ResourceNode['kind']; amount: number } {
    node.mesh.visible = false; return { kind: node.kind, amount: node.amount };
  }

  distanceToShip(position: THREE.Vector3): number { return position.distanceTo(this.boardingPosition); }
  distanceToStation(position: THREE.Vector3): number { return position.distanceTo(this.stationPosition); }
  distanceToBeacon(position: THREE.Vector3): number { return position.distanceTo(this.beaconPosition); }
  getBoardingSpawn(): THREE.Vector3 { return this.boardingPosition.clone().add(new THREE.Vector3(3.25, 0, 2.8)); }
  activateBeacon(): void { if (!this.beacon) return; const light = this.beacon.getObjectByName('beacon-light') as THREE.Mesh | undefined; if (light?.material instanceof THREE.MeshBasicMaterial) light.material.color.set(0x62f5ff); }
  nearestDrone(position: THREE.Vector3, maxDistance = 58): THREE.Group | undefined { return this.drones.find((drone) => drone.visible && drone.position.distanceTo(position) < maxDistance); }
  hitDrone(drone: THREE.Group): boolean { drone.userData.health = (drone.userData.health as number) - 1; if (drone.userData.health <= 0) { drone.visible = false; return true; } return false; }

  private updateBoardingAnchor(): void { const ground = this.heightAt(4.35, 24.4); this.boardingPosition.set(4.35, ground + 1.55, 24.4); }

  private buildTerrain(segments: number): void {
    const size = 6400; const geometry = new THREE.PlaneGeometry(size, size, segments, segments); geometry.rotateX(-Math.PI / 2);
    const pos = geometry.attributes.position as THREE.BufferAttribute; const colors: number[] = []; const c1 = new THREE.Color(this.system.planet.primary), c2 = new THREE.Color(this.system.planet.secondary), c3 = new THREE.Color(this.system.planet.accent);
    for (let i = 0; i < pos.count; i += 1) {
      const x = pos.getX(i), z = pos.getZ(i), h = this.heightAt(x, z); pos.setY(i, h);
      const slopeNoise = .5 + Math.sin(x * .017 + Math.cos(z * .011)) * .3; const heightMix = THREE.MathUtils.smoothstep(h, -25, 55); const color = c1.clone().lerp(c2, heightMix * .68 + slopeNoise * .18);
      if (this.system.planet.biome === 'ice' && h > 35) color.lerp(new THREE.Color(0xe2f4f4), .7); if (this.system.planet.biome === 'mycelium' && slopeNoise > .68) color.lerp(c3, .2); colors.push(color.r, color.g, color.b);
    }
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); geometry.computeVertexNormals();
    const terrainMap = createTerrainTexture(this.system.planet.biome, this.system.planet.seed);
    const material = new THREE.MeshStandardMaterial({ map: terrainMap, bumpMap: terrainMap, bumpScale: this.system.planet.biome === 'ice' ? .7 : 1.35, vertexColors: true, roughness: this.system.planet.biome === 'ice' ? .46 : .9, metalness: this.system.planet.biome === 'ice' ? .1 : .015 });
    this.terrain = new THREE.Mesh(geometry, material); this.terrain.receiveShadow = true; this.scene.add(this.terrain);
    this.buildFarTerrain(size);
  }

  private buildFarTerrain(innerSize: number): void {
    const outerSize = 25_600, segments = 128, stride = segments + 1, halfInner = innerSize * .5;
    const positions = new Float32Array(stride * stride * 3); const colors = new Float32Array(stride * stride * 3); const uvs = new Float32Array(stride * stride * 2); const indices: number[] = [];
    const low = new THREE.Color(this.system.planet.primary), high = new THREE.Color(this.system.planet.secondary), tint = new THREE.Color();
    for (let zIndex = 0; zIndex <= segments; zIndex += 1) {
      const z = -outerSize * .5 + outerSize * (zIndex / segments);
      for (let xIndex = 0; xIndex <= segments; xIndex += 1) {
        const x = -outerSize * .5 + outerSize * (xIndex / segments); const index = zIndex * stride + xIndex; const height = this.heightAt(x, z);
        positions[index * 3] = x; positions[index * 3 + 1] = height; positions[index * 3 + 2] = z;
        uvs[index * 2] = xIndex / segments; uvs[index * 2 + 1] = 1 - zIndex / segments;
        tint.copy(low).lerp(high, THREE.MathUtils.smoothstep(height, -120, 70) * .64); colors[index * 3] = tint.r; colors[index * 3 + 1] = tint.g; colors[index * 3 + 2] = tint.b;
      }
    }
    for (let zIndex = 0; zIndex < segments; zIndex += 1) for (let xIndex = 0; xIndex < segments; xIndex += 1) {
      const cellX = -outerSize * .5 + outerSize * ((xIndex + .5) / segments); const cellZ = -outerSize * .5 + outerSize * ((zIndex + .5) / segments);
      if (Math.abs(cellX) < halfInner && Math.abs(cellZ) < halfInner) continue;
      const a = zIndex * stride + xIndex, b = a + 1, c = a + stride, d = c + 1; indices.push(a, c, b, b, c, d);
    }
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3)); geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3)); geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2)); geometry.setIndex(indices); geometry.computeVertexNormals(); geometry.computeBoundingSphere();
    const terrainMap = createTerrainTexture(this.system.planet.biome, this.system.planet.seed + 701); terrainMap.repeat.set(38, 38);
    const material = new THREE.MeshStandardMaterial({ map: terrainMap, vertexColors: true, roughness: .96, metalness: .005 });
    this.farTerrain = new THREE.Mesh(geometry, material); this.farTerrain.receiveShadow = true; this.scene.add(this.farTerrain);
  }

  private buildSky(): void {
    const color = this.system.planet.biome === 'basalt' ? 0x8a7370 : this.system.planet.biome === 'ice' ? 0x6c97aa : 0x536f71;
    this.scene.background = new THREE.Color(color); this.scene.fog = new THREE.FogExp2(color, this.system.planet.biome === 'mycelium' ? .0008 : .00048);
    const skyGeometry = new THREE.SphereGeometry(12_000, 128, 96); const skyPos = skyGeometry.attributes.position as THREE.BufferAttribute; const skyColors: number[] = [];
    const horizon = new THREE.Color(color), zenith = new THREE.Color(this.system.planet.biome === 'basalt' ? 0x273744 : this.system.planet.biome === 'ice' ? 0x193a50 : 0x102e31), nadir = new THREE.Color(this.system.planet.primary);
    for (let i = 0; i < skyPos.count; i += 1) { const ny = skyPos.getY(i) / 12_000; const c = ny >= 0 ? horizon.clone().lerp(zenith, Math.pow(ny, .55)) : horizon.clone().lerp(nadir, Math.min(1, -ny * 2)); skyColors.push(c.r, c.g, c.b); }
    skyGeometry.setAttribute('color', new THREE.Float32BufferAttribute(skyColors, 3)); this.sky = new THREE.Mesh(skyGeometry, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false })); this.scene.add(this.sky);
    const sunDisc = new THREE.Mesh(new THREE.SphereGeometry(55, 24, 12), new THREE.MeshBasicMaterial({ color: 0xfff0cf, toneMapped: false })); sunDisc.position.set(-1700, 2100, -3300); this.scene.add(sunDisc);
  }

  private buildProps(count: number): void {
    const random = mulberry32(this.system.planet.seed + 72); const biome = this.system.planet.biome;
    const rockGeo = this.rockTemplate ? this.rockTemplate.geometry.clone() : createFracturedRock(this.system.planet.seed + 19);
    if (this.rockTemplate) { rockGeo.computeBoundingBox(); const size = rockGeo.boundingBox?.getSize(new THREE.Vector3()) ?? new THREE.Vector3(1, 1, 1); rockGeo.scale(1 / Math.max(size.x, size.y, size.z), 1 / Math.max(size.x, size.y, size.z), 1 / Math.max(size.x, size.y, size.z)); rockGeo.computeVertexNormals(); }
    const importedRockMaterial = this.rockTemplate?.material instanceof THREE.MeshStandardMaterial ? this.rockTemplate.material.clone() : undefined;
    const rockMat = importedRockMaterial ?? new THREE.MeshStandardMaterial({ roughness: biome === 'ice' ? .4 : .94, metalness: .035, flatShading: !this.rockTemplate });
    rockMat.color.multiply(new THREE.Color(biome === 'ice' ? 0xc2e5ea : biome === 'mycelium' ? 0x527b70 : 0x9a695a)); rockMat.roughness = biome === 'ice' ? .48 : .96;
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, count); rocks.castShadow = true; rocks.receiveShadow = true; const matrix = new THREE.Matrix4(), quat = new THREE.Quaternion(), scale = new THREE.Vector3();
    for (let i = 0; i < count; i += 1) { let x: number, z: number; if (i < Math.min(190, count)) { const angle = random() * Math.PI * 2, radius = 105 + Math.sqrt(random()) * 760; x = Math.cos(angle) * radius; z = 22 + Math.sin(angle) * radius; } else { x = (random() - .5) * 3800; z = (random() - .5) * 3800; } if (Math.hypot(x, z - 22) < 95) { x += x < 0 ? -110 : 110; z += z < 22 ? -110 : 110; } const s = .8 + Math.pow(random(), 3.15) * (i < 190 ? 11.5 : 8.2); quat.setFromEuler(new THREE.Euler((random() - .5) * .18, random() * Math.PI * 2, (random() - .5) * .18)); scale.set(s * (.62 + random() * 1.25), s * (.48 + random() * .8), s * (.7 + random() * 1.1)); matrix.compose(new THREE.Vector3(x, this.heightAt(x, z) - .08, z), quat, scale); rocks.setMatrixAt(i, matrix); }
    this.propRoot.add(rocks);
    if (this.cliffTemplate) {
      const cliffMaterial = this.cliffTemplate.material instanceof THREE.MeshStandardMaterial ? this.cliffTemplate.material.clone() : new THREE.MeshStandardMaterial({ roughness: .98 });
      cliffMaterial.color.multiply(new THREE.Color(biome === 'ice' ? 0x9cbec6 : biome === 'mycelium' ? 0x345d51 : 0x7f5143)); cliffMaterial.roughness = .98;
      const cliffs = new THREE.InstancedMesh(this.cliffTemplate.geometry, cliffMaterial, 7); cliffs.castShadow = true; cliffs.receiveShadow = true;
      const cliffSites: Array<[number, number]> = [[-560, -920], [510, -1080], [-1040, -1450], [980, -1580], [40, -1950], [-1450, -1040], [1410, -900]];
      for (let i = 0; i < cliffSites.length; i += 1) { const [x, z] = cliffSites[i]; const widthScale = 2.2 + random() * 2.8; quat.setFromEuler(new THREE.Euler((random() - .5) * .018, random() * Math.PI * 2, (random() - .5) * .018)); scale.set(widthScale, 6.5 + random() * 8.5, widthScale * (.82 + random() * .42)); matrix.compose(new THREE.Vector3(x, this.heightAt(x, z) - 1.2, z), quat, scale); cliffs.setMatrixAt(i, matrix); }
      this.propRoot.add(cliffs);
    } else {
      const formationGeometries = Array.from({ length: 4 }, (_, index) => createStratifiedCliff(this.system.planet.seed * .001 + index * 2.73)); const formationMaterial = new THREE.MeshStandardMaterial({ color: 0x3b2923, roughness: .98, flatShading: true });
      for (let i = 0; i < 8; i += 1) { const cliff = new THREE.Mesh(formationGeometries[i % formationGeometries.length], formationMaterial); const x = (random() - .5) * 2700, z = -420 - random() * 1180, h = 48 + random() * 125, w = 52 + random() * 110; cliff.position.set(x, this.heightAt(x, z) + h * .5, z); cliff.scale.set(w, h, w * .65); cliff.rotation.y = random() * Math.PI; this.propRoot.add(cliff); }
    }
    this.clouds = new THREE.Group(); const cloudTexture = createSurfaceCloudTexture();
    for (let i = 0; i < 28; i += 1) {
      const upperDeck = i >= 18;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: cloudTexture, color: upperDeck ? 0xe7f0f3 : 0xd9e7eb, transparent: true, opacity: (upperDeck ? .1 : .16) + random() * .08, depthWrite: false, fog: true }));
      sprite.position.set((random() - .5) * 5200, upperDeck ? 1050 + random() * 520 : 380 + random() * 560, (random() - .5) * 5200);
      const width = (upperDeck ? 520 : 280) + random() * (upperDeck ? 720 : 460); sprite.scale.set(width, width * (upperDeck ? .13 + random() * .08 : .2 + random() * .13), 1); this.clouds.add(sprite);
    }
    this.propRoot.add(this.clouds);
    for (let i = 0; i < 22; i += 1) {
      const x = (random() - .5) * 560, z = (random() - .5) * 560; if (Math.hypot(x, z - 22) < 34) continue;
      const kind = biome === 'mycelium' ? 'biomass' : random() > .58 ? 'crystal' : 'ferrite'; const color = kind === 'crystal' ? 0x7eefff : kind === 'biomass' ? 0x7cff9a : 0x765247;
      const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: kind === 'ferrite' ? .025 : .56, roughness: kind === 'ferrite' ? .88 : .36, metalness: kind === 'ferrite' ? .18 : .08, flatShading: true });
      const node = new THREE.Group(); const pieces = kind === 'ferrite' ? 4 : 3 + Math.floor(random() * 3);
      for (let piece = 0; piece < pieces; piece += 1) {
        const geometry = kind === 'ferrite' ? createFracturedRock(this.system.planet.seed + i * 19 + piece) : new THREE.ConeGeometry(.7, 4.2, 5);
        const shard = new THREE.Mesh(geometry, mat); const height = kind === 'ferrite' ? .7 + random() * 1.15 : .65 + random() * 1.15;
        shard.position.set((random() - .5) * 3.6, kind === 'ferrite' ? height * .62 : height * 2, (random() - .5) * 3.6); shard.scale.set(.55 + random() * .65, height, .55 + random() * .65); shard.rotation.set((random() - .5) * .28, random() * Math.PI, (random() - .5) * .28); shard.castShadow = true; node.add(shard);
      }
      node.position.set(x, this.heightAt(x, z), z); this.propRoot.add(node); this.resources.push({ mesh: node, kind, amount: 2 + Math.floor(random() * 4) });
    }
    if (biome === 'mycelium') this.buildMushrooms(random, matrix, quat);
  }

  private buildMushrooms(random: () => number, matrix: THREE.Matrix4, quat: THREE.Quaternion): void {
    const stem = new THREE.InstancedMesh(new THREE.CylinderGeometry(.18, .32, 3.2, 7), new THREE.MeshStandardMaterial({ color: 0x37584d, roughness: .8 }), 260); const cap = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x59c9aa, emissive: 0x2cf0d8, emissiveIntensity: 1.1, roughness: .5 }), 260);
    for (let i = 0; i < 260; i += 1) { const x = (random() - .5) * 1200, z = (random() - .5) * 1200, y = this.heightAt(x, z), s = .45 + random() * 2.2; matrix.compose(new THREE.Vector3(x, y + s * 1.5, z), quat.identity(), new THREE.Vector3(s, s, s)); stem.setMatrixAt(i, matrix); matrix.compose(new THREE.Vector3(x, y + s * 3, z), quat.identity(), new THREE.Vector3(s * 1.4, s * .7, s * 1.4)); cap.setMatrixAt(i, matrix); } this.propRoot.add(stem, cap);
  }

  private buildStation(): void {
    const sx = -150, sz = -190; const ground = this.heightAt(sx, sz);
    this.stationPosition.set(sx, ground + 2.2, sz + 19);
    if (!this.outpostTemplate) return;
    const root = new THREE.Group(); root.position.set(sx, ground + .3, sz); root.rotation.y = -.38;
    const visual = this.outpostTemplate.clone(true); visual.traverse((object) => { if (object instanceof THREE.Mesh) { object.castShadow = true; object.receiveShadow = true; } }); root.add(visual);
    const foundationMaterial = new THREE.MeshStandardMaterial({ color: 0x252c2e, roughness: .72, metalness: .62 });
    const lower = new THREE.Mesh(new THREE.CylinderGeometry(22.5, 24, 1.35, 16), foundationMaterial); lower.position.y = .12; lower.receiveShadow = true; lower.castShadow = true;
    const upper = new THREE.Mesh(new THREE.CylinderGeometry(19.8, 21.7, .72, 16), foundationMaterial); upper.position.y = .72; upper.receiveShadow = true; upper.castShadow = true;
    root.add(lower, upper);
    this.propRoot.add(root);
  }

  private buildBeacon(): void {
    const x = -48, z = -72, ground = this.heightAt(x, z); const root = new THREE.Group(); root.position.set(x, ground, z); this.beaconPosition.set(x, ground + 2.2, z); this.beacon = root;
    const metal = new THREE.MeshStandardMaterial({ color: 0x3b474c, roughness: .42, metalness: .82 }); const dark = new THREE.MeshStandardMaterial({ color: 0x12181b, roughness: .3, metalness: .9 }); const warning = new THREE.MeshBasicMaterial({ color: 0xff7048, toneMapped: false });
    const base = new THREE.Mesh(new RoundedBoxGeometry(6.5, 1.3, 6.5, 4, .45), metal); base.position.y = .65; base.castShadow = true; root.add(base);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(.42, .72, 6.5, 16), dark); mast.position.y = 4; root.add(mast);
    for (const side of [-1, 1]) { const panel = new THREE.Mesh(new RoundedBoxGeometry(4.8, .28, 2.8, 3, .18), metal); panel.position.set(side * 3.1, 4.6, 0); panel.rotation.z = side * -.22; root.add(panel); }
    const light = new THREE.Mesh(new THREE.OctahedronGeometry(.72, 2), warning); light.name = 'beacon-light'; light.position.y = 7.6; root.add(light); const ring = new THREE.Mesh(new THREE.TorusGeometry(1.25, .08, 8, 36), warning); ring.position.y = 7.6; ring.rotation.x = Math.PI / 2; root.add(ring); this.propRoot.add(root);
  }

  private buildDrones(): void {
    if (!this.droneTemplate) return;
    for (let i = 0; i < 4; i += 1) {
      const d = new THREE.Group(); d.userData.health = 3;
      const visual = this.droneTemplate.clone(true); visual.rotation.y = Math.PI * .5; visual.traverse((object) => { if (object instanceof THREE.Mesh) { object.castShadow = true; object.receiveShadow = true; } }); d.add(visual);
      const angle = i / 4 * Math.PI * 2 + .45, radius = 22 + i * 3; const x = this.beaconPosition.x + Math.cos(angle) * radius, z = this.beaconPosition.z + Math.sin(angle) * radius; const base = new THREE.Vector3(x, this.heightAt(x, z) + 8 + i * .7, z);
      d.userData.base = base; d.position.copy(base); this.propRoot.add(d); this.drones.push(d);
    }
  }
}
