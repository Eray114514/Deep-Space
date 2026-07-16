import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

/** The single runtime representation of Asterion S-9. No procedural fallback is kept. */
export class ShipView extends THREE.Group {
  private static heroSource?: Promise<THREE.Group>;
  private static thrusterTexture?: THREE.CanvasTexture;
  private throttle = 0;
  private throttleTarget = 0;
  private boost = 0;
  private boostTarget = 0;
  private lastUpdateTime = 0;
  private emissiveMaterials: THREE.MeshStandardMaterial[] = [];
  private loadedGearParts: THREE.Object3D[] = [];
  private loadedGearRoot?: THREE.Object3D;
  private loadedRampParts: THREE.Object3D[] = [];
  private thrusterGlows: THREE.Sprite[] = [];

  constructor() {
    super();
    this.name = 'Asterion_S9';
    this.visible = false;
  }

  async loadHeroAsset(): Promise<void> {
    if (!ShipView.heroSource) {
      const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
      // Versioned filename is intentional: GLB files in /public are not part of
      // Vite's module graph, so reusing the old URL can leave a live game on a
      // cached cockpit-forward model after an asset rebuild.
      ShipView.heroSource = loader.loadAsync('/assets/asterion-s9-rebuilt-20260716.glb').then((gltf) => gltf.scene);
    }
    const source = await ShipView.heroSource;
    const hero = source.clone(true);
    this.clear(); this.emissiveMaterials = []; this.loadedGearParts = []; this.loadedRampParts = []; this.loadedGearRoot = undefined; this.thrusterGlows = [];
    hero.traverse((object) => {
      if (object.name === 'LANDING_GEAR_ROOT') this.loadedGearRoot = object;
      if (/^(LANDING_GEAR_ROOT|Gear_)/.test(object.name)) this.loadedGearParts.push(object);
      if (/^(BOARDING_RAMP_ROOT|Ramp_)/.test(object.name)) this.loadedRampParts.push(object);
      if (!(object instanceof THREE.Mesh)) return;
      object.castShadow = true; object.receiveShadow = true;
      object.material = Array.isArray(object.material) ? object.material.map((material) => material.clone()) : object.material.clone();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!(material instanceof THREE.MeshStandardMaterial)) continue;
        material.color.multiplyScalar(.68); material.roughness = Math.max(material.roughness, .32);
        if (material.emissiveMap || /Engine|Emission/i.test(material.name)) { material.toneMapped = true; this.emissiveMaterials.push(material); }
      }
    });
    hero.rotation.y = Math.PI;
    this.add(hero); this.buildThrusterGlows(); this.scale.setScalar(.48); this.visible = true; this.setLanded(false);
  }

  setThrottle(value: number, boost = 0): void {
    this.throttleTarget = THREE.MathUtils.clamp(value, 0, 1);
    this.boostTarget = THREE.MathUtils.clamp(boost, 0, 1);
  }

  setLanded(landed: boolean): void {
    if (this.loadedGearRoot) this.loadedGearRoot.visible = landed;
    for (const part of this.loadedGearParts) part.visible = landed;
    for (const part of this.loadedRampParts) part.visible = false;
  }

  update(time: number): void {
    const dt = this.lastUpdateTime > 0 ? THREE.MathUtils.clamp(time - this.lastUpdateTime, 1 / 240, .05) : 1 / 60; this.lastUpdateTime = time;
    this.throttle = THREE.MathUtils.damp(this.throttle, this.throttleTarget, 7.5, dt);
    this.boost = THREE.MathUtils.damp(this.boost, this.boostTarget, this.boostTarget > this.boost ? 12 : 5.5, dt);
    const combustion = Math.sin(time * 19) * (.018 + this.boost * .018);
    for (const material of this.emissiveMaterials) material.emissiveIntensity = 1.05 + this.throttle * 2.35 + this.boost * 2.65 + combustion;
    for (let i = 0; i < this.thrusterGlows.length; i += 1) {
      const glow = this.thrusterGlows[i]; const isCore = i % 2 === 0;
      glow.material.opacity = (isCore ? .045 : .018) + this.throttle * (isCore ? .54 : .28) + this.boost * (isCore ? .3 : .42);
      const size = (isCore ? 3.1 : 6.8) * (1 + this.throttle * .18 + this.boost * (isCore ? .38 : .65));
      glow.scale.set(size, size, 1);
    }
  }

  private buildThrusterGlows(): void {
    const texture = ShipView.getThrusterTexture();
    for (const x of [-5.15, 0, 5.15]) {
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, color: 0x745dff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
      const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, color: 0xa9fbff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
      halo.position.set(x, -.55, 12.35); core.position.set(x, -.55, 12.55);
      this.add(core, halo); this.thrusterGlows.push(core, halo);
    }
  }

  private static getThrusterTexture(): THREE.CanvasTexture {
    if (ShipView.thrusterTexture) return ShipView.thrusterTexture;
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128;
    const context = canvas.getContext('2d');
    if (context) {
      const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 62);
      gradient.addColorStop(0, 'rgba(255,255,255,1)'); gradient.addColorStop(.12, 'rgba(255,255,255,.95)');
      gradient.addColorStop(.34, 'rgba(255,255,255,.42)'); gradient.addColorStop(.7, 'rgba(255,255,255,.08)'); gradient.addColorStop(1, 'rgba(255,255,255,0)');
      context.fillStyle = gradient; context.fillRect(0, 0, 128, 128);
    }
    ShipView.thrusterTexture = new THREE.CanvasTexture(canvas);
    return ShipView.thrusterTexture;
  }
}
