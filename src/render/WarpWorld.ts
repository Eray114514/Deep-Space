import * as THREE from 'three/webgpu';
import type { StarSystem } from '../game/types';
import { mulberry32 } from '../simulation/Galaxy';
import { ShipView } from './Ship';
import { createCloudTexture, createPlanetTexture } from './materials';

export class WarpWorld {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(67, 1, .1, 5000);
  readonly ship = new ShipView();
  private streaks: THREE.LineSegments;
  private tunnel: THREE.Mesh;
  private glow: THREE.PointLight;
  private destination = new THREE.Group();
  private departure = new THREE.Group();
  private positions: Float32Array;
  private random = mulberry32(17191);
  private arrivalMarsTexture: THREE.Texture;
  private arrivalTargetId = -1;
  private departureSystemId = -1;

  constructor() {
    this.scene.background = new THREE.Color(0x01050b); this.camera.position.set(0, 7, 31); this.camera.lookAt(0, 0, -50);
    this.scene.add(new THREE.HemisphereLight(0x77ddec, 0x010205, 2.5)); this.glow = new THREE.PointLight(0x68e9ff, 65, 260); this.glow.position.set(0, 0, -35); this.scene.add(this.glow);
    this.ship.position.set(0, -2.5, -4); this.scene.add(this.ship);
    const starRandom = mulberry32(7712); const starPositions = new Float32Array(1800 * 3); const starColors = new Float32Array(1800 * 3); const starColor = new THREE.Color();
    for (let i = 0; i < 1800; i += 1) { const r = 500 + starRandom() * 3600, phi = Math.acos(2 * starRandom() - 1), theta = starRandom() * Math.PI * 2; starPositions[i * 3] = r * Math.sin(phi) * Math.cos(theta); starPositions[i * 3 + 1] = r * Math.cos(phi); starPositions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta); starColor.setHSL(.54 + starRandom() * .1, .16 + starRandom() * .24, .7 + starRandom() * .25); starColors[i * 3] = starColor.r; starColors[i * 3 + 1] = starColor.g; starColors[i * 3 + 2] = starColor.b; }
    const starGeometry = new THREE.BufferGeometry(); starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3)); starGeometry.setAttribute('color', new THREE.BufferAttribute(starColors, 3)); this.scene.add(new THREE.Points(starGeometry, new THREE.PointsMaterial({ size: 2.2, sizeAttenuation: true, vertexColors: true, transparent: true, opacity: .82, depthWrite: false })));
    const count = 480; this.positions = new Float32Array(count * 6); const colors = new Float32Array(count * 6);
    for (let i = 0; i < count; i += 1) {
      const a = this.random() * Math.PI * 2, r = 4 + Math.pow(this.random(), .4) * 90, z = -this.random() * 1900 + 70;
      this.positions.set([Math.cos(a) * r, Math.sin(a) * r, z, Math.cos(a) * r, Math.sin(a) * r, z - 20], i * 6);
      const col = new THREE.Color().setHSL(.52 + this.random() * .08, .3, .62 + this.random() * .26); colors.set([col.r, col.g, col.b, col.r, col.g, col.b], i * 6);
    }
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3)); geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.streaks = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: .22, blending: THREE.AdditiveBlending, depthWrite: false })); this.scene.add(this.streaks);
    this.tunnel = new THREE.Mesh(new THREE.CylinderGeometry(48, 130, 980, 72, 24, true), new THREE.MeshBasicMaterial({ color: 0x174457, transparent: true, opacity: .006, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false })); this.tunnel.rotation.x = Math.PI / 2; this.tunnel.position.z = -450; this.scene.add(this.tunnel);
    this.arrivalMarsTexture = new THREE.TextureLoader().load('/assets/planet/mars-viking-4k.jpg'); this.arrivalMarsTexture.colorSpace = THREE.SRGBColorSpace; this.arrivalMarsTexture.wrapS = THREE.RepeatWrapping; this.arrivalMarsTexture.anisotropy = 16;
    const planet = new THREE.Mesh(new THREE.SphereGeometry(180, 128, 64), new THREE.MeshStandardMaterial({ map: this.arrivalMarsTexture, bumpMap: this.arrivalMarsTexture, bumpScale: 4.2, color: 0x9e8c82, roughness: .9, transparent: true, opacity: 0 })); planet.name = 'arrival-planet'; this.destination.add(planet);
    const cloudMap = createCloudTexture(123971);
    const clouds = new THREE.Mesh(new THREE.SphereGeometry(184, 96, 48), new THREE.MeshStandardMaterial({ map: cloudMap, transparent: true, opacity: 0, depthWrite: false, roughness: 1 })); clouds.name = 'arrival-clouds'; this.destination.add(clouds);
    const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(193, 96, 48), new THREE.MeshBasicMaterial({ color: 0x69d9ff, transparent: true, opacity: 0, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false })); atmosphere.name = 'arrival-atmosphere'; this.destination.add(atmosphere); this.destination.position.set(95, -48, -620); this.scene.add(this.destination);
    const departurePlanet = new THREE.Mesh(new THREE.SphereGeometry(180, 128, 64), new THREE.MeshStandardMaterial({ map: this.arrivalMarsTexture, bumpMap: this.arrivalMarsTexture, bumpScale: 4.2, color: 0xffffff, roughness: .9, transparent: true, opacity: 0 })); departurePlanet.name = 'departure-planet'; this.departure.add(departurePlanet);
    const departureClouds = new THREE.Mesh(new THREE.SphereGeometry(184, 96, 48), new THREE.MeshStandardMaterial({ map: createCloudTexture(7881), transparent: true, opacity: 0, depthWrite: false, roughness: 1 })); departureClouds.name = 'departure-clouds'; this.departure.add(departureClouds);
    const departureAtmosphere = new THREE.Mesh(new THREE.SphereGeometry(193, 96, 48), new THREE.MeshBasicMaterial({ color: 0x69d9ff, transparent: true, opacity: 0, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false })); departureAtmosphere.name = 'departure-atmosphere'; this.departure.add(departureAtmosphere); this.departure.position.set(95, -48, -300); this.scene.add(this.departure);
  }

  update(time: number, progress: number, target: StarSystem, source?: StarSystem): void {
    const planet = this.destination.getObjectByName('arrival-planet') as THREE.Mesh;
    if (this.arrivalTargetId !== target.id && planet.material instanceof THREE.MeshStandardMaterial) { this.arrivalTargetId = target.id; const map = target.planet.biome === 'basalt' ? this.arrivalMarsTexture : createPlanetTexture(target.planet.seed, target.planet.primary, target.planet.secondary); planet.material.map = map; planet.material.bumpMap = map; planet.material.needsUpdate = true; const arrivalClouds = this.destination.getObjectByName('arrival-clouds') as THREE.Mesh; if (arrivalClouds.material instanceof THREE.MeshStandardMaterial) { arrivalClouds.material.map = createCloudTexture(target.planet.seed); arrivalClouds.material.needsUpdate = true; } }
    const phase = Math.sin(Math.min(progress, 1) * Math.PI); const speed = 8 + phase * 92;
    const departurePlanet = this.departure.getObjectByName('departure-planet') as THREE.Mesh; const departureClouds = this.departure.getObjectByName('departure-clouds') as THREE.Mesh; const departureAtmosphere = this.departure.getObjectByName('departure-atmosphere') as THREE.Mesh;
    if (source && this.departureSystemId !== source.id && departurePlanet.material instanceof THREE.MeshStandardMaterial) { this.departureSystemId = source.id; const map = source.planet.biome === 'basalt' ? this.arrivalMarsTexture : createPlanetTexture(source.planet.seed, source.planet.primary, source.planet.secondary); departurePlanet.material.map = map; departurePlanet.material.bumpMap = map; departurePlanet.material.color.set(source.planet.biome === 'basalt' ? 0xd3b4a4 : source.planet.primary); departurePlanet.material.needsUpdate = true; if (departureClouds.material instanceof THREE.MeshStandardMaterial) { departureClouds.material.map = createCloudTexture(source.planet.seed); departureClouds.material.needsUpdate = true; } }
    const departureAlpha = source ? 1 - THREE.MathUtils.smoothstep(progress, .035, .24) : 0; this.departure.visible = departureAlpha > .001; this.departure.position.z = THREE.MathUtils.lerp(-300, -170, THREE.MathUtils.smoothstep(progress, 0, .24)); this.departure.rotation.y = time * .008; this.departure.scale.setScalar(1 + THREE.MathUtils.smoothstep(progress, 0, .24) * .08);
    if (departurePlanet.material instanceof THREE.MeshStandardMaterial) departurePlanet.material.opacity = departureAlpha;
    if (departureClouds.material instanceof THREE.MeshStandardMaterial) departureClouds.material.opacity = departureAlpha * .5;
    if (departureAtmosphere.material instanceof THREE.MeshBasicMaterial) { departureAtmosphere.material.color.set(source?.planet.accent ?? 0x69d9ff); departureAtmosphere.material.opacity = departureAlpha * .18; }
    for (let i = 0; i < this.positions.length; i += 6) {
      this.positions[i + 2] += speed; this.positions[i + 5] = this.positions[i + 2] - (8 + phase * 105);
      if (this.positions[i + 2] > 80) { const a = this.random() * Math.PI * 2, r = 4 + Math.pow(this.random(), .4) * 90; this.positions[i] = this.positions[i + 3] = Math.cos(a) * r; this.positions[i + 1] = this.positions[i + 4] = Math.sin(a) * r; this.positions[i + 2] = -1800; }
    }
    this.streaks.geometry.attributes.position.needsUpdate = true; this.streaks.rotation.z = time * .035 + Math.sin(progress * 22) * .025;
    if (this.streaks.material instanceof THREE.LineBasicMaterial) this.streaks.material.opacity = THREE.MathUtils.smoothstep(progress, .04, .24) * (1 - THREE.MathUtils.smoothstep(progress, .74, .98)) * .22;
    this.tunnel.rotation.z = -time * .045; this.tunnel.scale.setScalar(.9 + phase * .13); this.glow.color.set(target.color); this.glow.intensity = 18 + phase * 42;
    this.ship.setThrottle(1); this.ship.update(time); this.ship.rotation.z = Math.sin(time * 1.8) * .018 * phase; this.ship.position.z = -4 - phase * 10;
    const arrival = THREE.MathUtils.smoothstep(progress, .68, 1); this.destination.position.z = THREE.MathUtils.lerp(-620, -300, arrival); this.destination.rotation.y = time * .012;
    const atmosphere = this.destination.getObjectByName('arrival-atmosphere') as THREE.Mesh;
    const clouds = this.destination.getObjectByName('arrival-clouds') as THREE.Mesh;
    if (planet.material instanceof THREE.MeshStandardMaterial) { planet.material.color.set(target.planet.biome === 'basalt' ? 0xd3b4a4 : target.planet.primary).lerp(new THREE.Color(target.planet.secondary), target.planet.biome === 'basalt' ? .08 : .32); planet.material.opacity = arrival; }
    if (atmosphere.material instanceof THREE.MeshBasicMaterial) { atmosphere.material.color.set(target.planet.accent); atmosphere.material.opacity = arrival * .2; }
    if (clouds.material instanceof THREE.MeshStandardMaterial) clouds.material.opacity = arrival * .5;
    clouds.rotation.y = -time * .009; departureClouds.rotation.y = -time * .007; this.camera.position.x = Math.sin(time * 7) * phase * .025; this.camera.position.y = 7 + Math.sin(time * 9) * phase * .02; this.camera.fov = 61 + phase * 7 - arrival * 4; this.camera.updateProjectionMatrix(); this.camera.lookAt(0, 0, -80);
  }
}
