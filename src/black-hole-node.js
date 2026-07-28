import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  abs, color, dot, float, length, mix, mx_fractal_noise_float, normalWorld,
  positionLocal, positionWorldDirection, pow, sin, smoothstep, uniform, vec3,
} from 'three/tsl';

export function makeBlackHoleImpostorTexture(size = 1024) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = Math.round(size * 0.625);
  const ctx = canvas.getContext('2d');
  const cx = canvas.width * 0.5;
  const cy = canvas.height * 0.51;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(cx, cy);

  // A broad, low-contrast lens halo gives the silhouette weight before the
  // bright structures are added. Multiple shells avoid a single neon ring.
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 12; i++) {
    const radius = 92 + i * 9;
    ctx.beginPath();
    ctx.ellipse(0, 0, radius, radius * (0.96 + i * 0.003), 0, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,126,45,${0.014 * (1 - i / 12)})`;
    ctx.lineWidth = 8 + i * 2;
    ctx.stroke();
  }

  // The direct disc is built from nested projected rings.  The previous
  // horizontal strokes collapsed into a light bar through a black circle;
  // these ellipses preserve the inner cavity and make the disc read as a
  // rotating surface even in the small system-preview framing.
  for (let i = 0; i < 70; i++) {
    const t = i / 69;
    const radius = 112 + Math.pow(t, 0.86) * 310;
    const thickness = 23 + t * 34 + Math.sin(i * 1.83) * 2.6;
    const alpha = 0.16 + (1 - t) * 0.26;
    const gradient = ctx.createLinearGradient(-radius, 0, radius, 0);
    gradient.addColorStop(0, `rgba(218,244,255,${alpha * 1.28})`);
    gradient.addColorStop(0.24, `rgba(255,236,187,${alpha})`);
    gradient.addColorStop(0.58, `rgba(255,139,48,${alpha * 0.78})`);
    gradient.addColorStop(1, `rgba(126,24,8,${alpha * 0.16})`);
    ctx.beginPath();
    ctx.ellipse(0, 0, radius, thickness, -0.025, 0, Math.PI * 2);
    ctx.strokeStyle = gradient;
    ctx.lineWidth = 0.8 + (1 - t) * 1.9;
    ctx.setLineDash(i % 4 === 0 ? [radius * 0.17, 5 + (i % 7)] : []);
    ctx.lineDashOffset = i * 13.7;
    ctx.shadowBlur = 5 + (1 - t) * 6;
    ctx.shadowColor = i % 3 ? '#ff7622' : '#ffe9bd';
    ctx.stroke();

    // A restrained near-side pass gives the foreground half of the disc
    // enough density to sit in front of the shadow without becoming a beam.
    if (i % 2 === 0) {
      ctx.beginPath();
      ctx.ellipse(0, 3.5, radius, thickness * 1.08, -0.025, 0.05 * Math.PI, 0.95 * Math.PI);
      ctx.strokeStyle = gradient;
      ctx.lineWidth = 1.05;
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);

  // Light from the far side of the same disc is bent above and below the
  // shadow. These incomplete nested arcs are the missing black-hole cue in
  // the previous implementation.
  ctx.shadowBlur = 5;
  for (let i = 0; i < 34; i++) {
    const radius = 86 + i * 2.45;
    const alpha = 0.18 + (1 - i / 34) * 0.30;
    const gradient = ctx.createLinearGradient(-radius, 0, radius, 0);
    gradient.addColorStop(0, `rgba(225,246,255,${alpha * 1.35})`);
    gradient.addColorStop(0.48, `rgba(255,227,157,${alpha})`);
    gradient.addColorStop(1, `rgba(255,89,25,${alpha * 0.48})`);
    ctx.strokeStyle = gradient;
    ctx.lineWidth = 1.35 + (34 - i) * 0.045;
    ctx.shadowColor = i < 12 ? '#fff0c2' : '#ff6a20';
    ctx.beginPath();
    ctx.ellipse(0, 0, radius * 1.04, radius * 0.86, 0, Math.PI * 1.04, Math.PI * 1.96);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(0, 0, radius * 1.04, radius * 0.86, 0, Math.PI * 0.04, Math.PI * 0.96);
    ctx.stroke();
  }

  // Event-horizon shadow and the narrow photon ring. Drawing the shadow last
  // makes it swallow every layer instead of reading as a dark painted sphere.
  ctx.globalCompositeOperation = 'source-over';
  ctx.shadowBlur = 34;
  ctx.shadowColor = 'rgba(0,0,0,1)';
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.arc(0, 0, 82, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'lighter';
  ctx.shadowBlur = 16;
  ctx.shadowColor = '#fff0c4';
  const photon = ctx.createLinearGradient(-100, 0, 100, 0);
  photon.addColorStop(0, '#e7f7ff');
  photon.addColorStop(0.42, '#fff1be');
  photon.addColorStop(1, '#ff6b24');
  ctx.strokeStyle = photon;
  ctx.lineWidth = 3.2;
  ctx.beginPath();
  ctx.arc(0, 0, 88, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

export function makeAccretionMaterial(innerRadius, outerRadius, temperatureK) {
  const nodes = {
    uTime: uniform(0),
    uInner: uniform(innerRadius),
    uOuter: uniform(outerRadius),
    uHeat: uniform(THREE.MathUtils.clamp((temperatureK - 2200) / 3200, 0, 1)),
    uIntensity: uniform(1),
  };
  const radius = length(positionLocal.xy);
  const radial = radius.sub(nodes.uInner).div(nodes.uOuter.sub(nodes.uInner).max(1)).clamp(0, 1);
  const lanes = sin(radial.mul(92).add(positionLocal.x.mul(0.00017))
    .sub(positionLocal.y.mul(0.00013)).add(nodes.uTime.mul(1.8))).mul(0.5).add(0.5);
  const turbulence = mx_fractal_noise_float(positionLocal.mul(vec3(0.00008, 0.00008, 1))
    .add(vec3(nodes.uTime.mul(0.03), 0, 0)), 3);
  let density = smoothstep(0, 0.12, radial).mul(smoothstep(1, 0.72, radial));
  density = density.mul(float(0.42).add(lanes.mul(0.48)).add(turbulence.mul(0.22)));
  const hotMix = nodes.uHeat.add(float(1).sub(radial).mul(0.25)).clamp(0, 1);
  let discColor = mix(vec3(1.8, 0.24, 0.045), vec3(1.5, 0.82, 0.34), hotMix);
  const tangent = vec3(positionLocal.y.negate(), positionLocal.x, 0).normalize();
  const doppler = dot(tangent, positionWorldDirection);
  discColor = discColor.mul(mix(0.52, 1.75, smoothstep(-0.8, 0.8, doppler)));
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  material.colorNode = discColor.mul(density).mul(nodes.uIntensity);
  material.opacityNode = density.mul(0.9).mul(nodes.uIntensity);
  material.uniforms = nodes;
  return material;
}

export function makePhotonMaterial() {
  const nodes = { uTime: uniform(0) };
  const rim = pow(float(1).sub(abs(dot(positionWorldDirection, normalWorld))), 13);
  const pulse = float(0.86).add(sin(nodes.uTime.mul(1.7)).mul(0.14));
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
  });
  material.colorNode = vec3(1.55, 0.82, 0.34).mul(rim).mul(pulse);
  material.opacityNode = rim.mul(0.72);
  material.uniforms = nodes;
  return material;
}

export class BlackHole {
  constructor({ spec, posUniv, fadeIn = false }) {
    this.spec = spec;
    this.seed = spec.seed;
    this.bodyId = spec.bodyId;
    this.name = spec.name;
    this.properName = spec.properName;
    this.catalogName = spec.catalogName;
    this.type = 'blackHole';
    this.typeLabel = '恒星级黑洞';
    this.isBlackHole = true;
    this.isMoon = false;
    this.landable = false;
    this.R = spec.radius;
    this.posUniv = posUniv.clone();
    this.frameVelocity = new THREE.Vector3();
    this.group = new THREE.Group();
    this.group.name = `black-hole:${this.name}`;

    const horizon = new THREE.Mesh(
      new THREE.SphereGeometry(this.R, 72, 48),
      new THREE.MeshBasicMaterial({ color: 0x000000, fog: false }),
    );
    horizon.renderOrder = 7;
    this.group.add(horizon);

    this.photonMaterial = makePhotonMaterial();
    const photonShell = new THREE.Mesh(
      new THREE.SphereGeometry(this.R * 1.72, 72, 48),
      this.photonMaterial,
    );
    photonShell.renderOrder = 8;
    this.group.add(photonShell);

    const inner = this.R * 2.25;
    const outer = spec.accretionRadius;
    this.accretionMaterial = makeAccretionMaterial(inner, outer, spec.blackHole.discTemperatureK);
    const disc = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 256, 18), this.accretionMaterial);
    disc.rotation.x = -Math.PI / 2;
    disc.rotation.z = spec.axialTilt;
    disc.renderOrder = 6;
    this.group.add(disc);

    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0xffc47c,
      transparent: true,
      opacity: 0.68,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    const photonRing = new THREE.Mesh(
      new THREE.TorusGeometry(this.R * 1.55, this.R * 0.055, 16, 160),
      ringMaterial,
    );
    photonRing.rotation.x = Math.PI / 2;
    photonRing.renderOrder = 9;
    this.group.add(photonRing);

    this.impostorTexture = makeBlackHoleImpostorTexture();
    this.impostor = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.impostorTexture,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
    }));
    this.impostor.scale.set(spec.accretionRadius * 2.75, spec.accretionRadius * 1.72, 1);
    this.impostor.renderOrder = 12;
    this.group.add(this.impostor);

    this.group.scale.setScalar(fadeIn ? 0.001 : 1);
    this.appear = fadeIn ? 0 : 1;
  }

  setFrame() {}
  setSunDir() {}

  updateVisual(timeSeconds) {
    this.accretionMaterial.uniforms.uTime.value = timeSeconds;
    this.photonMaterial.uniforms.uTime.value = timeSeconds;
    if (this.appear < 1) {
      this.appear = Math.min(1, this.appear + 0.035);
      const eased = this.appear * this.appear * (3 - 2 * this.appear);
      this.group.scale.setScalar(Math.max(0.001, eased));
    }
  }

  dispose() {
    this.group.traverse((object) => {
      object.geometry?.dispose?.();
      if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
      else object.material?.dispose?.();
    });
    this.impostorTexture.dispose();
  }
}
