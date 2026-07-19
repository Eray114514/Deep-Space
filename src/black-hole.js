import * as THREE from 'three';

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
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uInner: { value: innerRadius },
      uOuter: { value: outerRadius },
      uHeat: { value: THREE.MathUtils.clamp((temperatureK - 2200) / 3200, 0, 1) },
      uIntensity: { value: 1 },
    },
    vertexShader: /* glsl */`
      varying vec3 vLocal;
      varying vec3 vWorld;
      varying vec3 vTangentWorld;
      void main() {
        vLocal = position;
        vTangentWorld = normalize(mat3(modelMatrix) * normalize(vec3(-position.y, position.x, 0.0)));
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */`
      uniform float uTime;
      uniform float uInner;
      uniform float uOuter;
      uniform float uHeat;
      uniform float uIntensity;
      varying vec3 vLocal;
      varying vec3 vWorld;
      varying vec3 vTangentWorld;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main() {
        float radius = length(vLocal.xy);
        float radial = clamp((radius - uInner) / max(1.0, uOuter - uInner), 0.0, 1.0);
        float angle = atan(vLocal.y, vLocal.x);
        float lanes = sin(radial * 92.0 - angle * 7.0 + uTime * 1.8) * 0.5 + 0.5;
        float turbulence = hash(vec2(floor(angle * 38.0), floor(radial * 46.0 + uTime * 0.7)));
        float density = smoothstep(0.0, 0.12, radial) * (1.0 - smoothstep(0.72, 1.0, radial));
        density *= 0.42 + lanes * 0.48 + turbulence * 0.22;
        vec3 viewDir = normalize(cameraPosition - vWorld);
        float doppler = dot(vTangentWorld, viewDir);
        vec3 cool = vec3(1.8, 0.24, 0.045);
        vec3 hot = vec3(1.5, 0.82, 0.34);
        vec3 color = mix(cool, hot, uHeat + (1.0 - radial) * 0.25);
        color *= mix(0.52, 1.75, smoothstep(-0.8, 0.8, doppler));
        gl_FragColor = vec4(color * density * uIntensity, density * 0.9 * uIntensity);
      }
    `,
  });
}

export function makePhotonMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */`
      varying vec3 vNormal;
      varying vec3 vWorld;
      void main() {
        vNormal = normalize(mat3(modelMatrix) * normal);
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */`
      uniform float uTime;
      varying vec3 vNormal;
      varying vec3 vWorld;
      void main() {
        vec3 viewDir = normalize(cameraPosition - vWorld);
        float rim = pow(1.0 - abs(dot(viewDir, vNormal)), 13.0);
        float pulse = 0.86 + 0.14 * sin(uTime * 1.7);
        gl_FragColor = vec4(vec3(1.55, 0.82, 0.34) * rim * pulse, rim * 0.72);
      }
    `,
  });
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
