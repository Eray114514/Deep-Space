// Camera-centred warp medium. A formation front moves from the vanishing
// point over the hull. Stars and fog share that front on entry and exit.
import * as THREE from 'three';

export const CONDUIT_PERIOD = 36000.0;

const FORMATION = /* glsl */`
uniform float uEnter;   // 0..1 formation front
uniform float uExit;    // 0..1 opening front
uniform float uDMax;    // conduit length
uniform float uScale;   // radius / 60
uniform float uFrontNear; // how far behind the ship a front ends (reference units)
float frontPos(float k){
  float q = 1.0 - k;
  return mix(-uFrontNear * uScale, uDMax + 1500.0 * uScale, q * q);
}
float formation(float d){
  float fe = frontPos(uEnter);
  float we = 120.0 * uScale + 0.22 * max(fe, 0.0);
  float fx = frontPos(uExit);
  float wx = 140.0 * uScale + 0.26 * max(fx, 0.0);
  return smoothstep(fe - we, fe + we, d) * (1.0 - smoothstep(fx - wx, fx + wx, d));
}
// The axis wanders: the far conduit curves away, the near part stays on the
// heading so it lines up with the real sky at entry and exit.
uniform vec2 uBend;
vec2 bendAt(float d){
  float q = max(d, 0.0) / (1800.0 * uScale);
  return uBend * 1800.0 * uScale * q * q / (1.0 + q);
}
`;

// A back-facing box supplies one direction per visible pixel. The optical
// depth comes from samples in space, independent of the box faces.
const FOG_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vRay;
void main(){
  vRay = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const FOG_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
precision highp sampler3D;
uniform sampler3D uCloud;
uniform float uDrift;
uniform float uR;
uniform vec3 uColThroat;
varying vec3 vRay;
${FORMATION}
void main(){
  #include <logdepthbuf_fragment>
  vec3 ray = normalize(vRay);
  vec2 vanishing = ray.xy - uBend * .65 * max(-ray.z, 0.0);
  float angle = length(vanishing);
  float reach = min(58.0, 2.85 / max(angle, .025));
  float stepLen = reach / float(FOG_STEPS);
  float jitter = .5;
  #ifndef FILTERED_FOG
    jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(.06711056,.00583715))));
  #endif
  float transmit = 1.0;
  vec3 scatter = vec3(0.0);
  for(int i = 0; i < FOG_STEPS; i++){
    vec3 p = ray * ((float(i) + .28 + .44*jitter) * stepLen);
    float d = -p.z * uR;
    p.xy -= bendAt(d) / uR;
    // Longitudinal flow stretches the large billows, with a separate
    // shorter-scale curl folded into their boundaries.
    vec3 uv = p * vec3(.22, .22, .055) - vec3(0., 0., uDrift);
    vec3 curl = texture(uCloud, uv * .5 + vec3(.31,.62,.17)).rgb - .5;
    uv += curl * .36;
    vec3 field = texture(uCloud, uv).rgb;
    float radius = length(p.xy);
    float bank = smoothstep(.15, .95, radius + (field.r-.5)*2.4);
    float depth = max(0., -p.z);
    // Broad billows taper into the distance. Light cuts through torn
    // membranes within them and rediscovers the same edge at several depths.
    float body = field.g + .35*(curl.b-.5) + .12*(texture(uCloud,uv*2.5 + curl*.14).b-.5);
    float fringe = exp(-abs(body-.52)*13.0);
    float density = (.36*smoothstep(.44,.76,body) + .62*fringe) * bank;
    density *= smoothstep(.004,.095, angle + .024*(field.r-.5));
    float opacity = 1.0 - exp(-density * min(stepLen,1.4) * 1.68 * formation(d));
    float shadow = texture(uCloud, uv + vec3(-.033,.023,-.053)).g;
    float grazing = smoothstep(-.12,.22,field.g-shadow);
    float beam = smoothstep(.30,.71,texture(uCloud,vec3(
      p.xy/max(radius,.35)*.31 + depth*.019, uDrift*.5)).r);
    float lit = fringe * grazing * (.10+1.2*beam) * (.57+field.b*.6);
    vec3 radiance = vec3(.006,.021,.047)
      + vec3(.19,.62,1.01) * lit * (.61+.64*smoothstep(.5, 12.0, depth));
    scatter += transmit * opacity * radiance;
    transmit *= 1.0 - opacity;
  }
  // Behind the finite volume, the same front seals the gap during the
  // system swap and exposes the destination through the centre on exit.
  float backdrop = formation(min(uDMax, -ray.z*uR / max(angle,.012)));
  float forward = smoothstep(.15,.9,-ray.z);
  float glow = forward * (.24*exp(-angle*7.5) + 1.55*exp(-angle*42.0));
  vec3 sky = vec3(.0025,.009,.027) + glow * mix(vec3(.44,.88,1.12),uColThroat,.32);
  float alpha = 1.0 - transmit*(1.0-backdrop);
  if(alpha < .002) { gl_FragColor = vec4(0.0); return; }
  gl_FragColor = vec4((scatter + transmit*backdrop*sky)/alpha, alpha);
}
`;

// Preserve the full-resolution hull depth test when reconstructing filtered fog.
const FOG_LOOKUP_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vScreen;
void main(){
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  vScreen = gl_Position.xyw;
  #include <logdepthbuf_vertex>
}
`;

const FOG_LOOKUP_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D tFog;
varying vec3 vScreen;
void main(){
  #include <logdepthbuf_fragment>
  gl_FragColor = texture2D(tFog, .5 + .5*vScreen.xy/vScreen.z);
}
`;

// Periodic trilinear fields at three scales. Baked once so marching a ray
// costs texture fetches rather than dozens of procedural hashes per sample.
function cloudNoise() {
  const size = 48;
  const rnd = mulberry32(0x75edcb);
  const lattice = (n) => {
    const data = Float32Array.from({ length: n ** 3 }, rnd);
    const at = (x,y,z) => data[x % n + n * (y % n + n * (z % n))];
    const fade = (x) => x*x*(3-2*x);
    const mix = (a,b,t) => a+(b-a)*t;
    return (x,y,z) => {
      x *= n/size; y *= n/size; z *= n/size;
      const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z);
      const dx = fade(x-i), dy = fade(y-j), dz = fade(z-k);
      const row = (j,k) => mix(at(i,j,k),at(i+1,j,k),dx);
      return mix(mix(row(j,k),row(j+1,k),dy),mix(row(j,k+1),row(j+1,k+1),dy),dz);
    };
  };
  const broad = lattice(4), billow = lattice(9), fine = lattice(22);
  const data = new Uint8Array(size ** 3 * 4);
  let i = 0;
  for (let z = 0; z < size; z++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const a = broad(x,y,z), b = billow(x,y,z), c = fine(x,y,z);
    data[i++] = 255*a;
    data[i++] = 255*(.52*a+.35*b+.13*c);
    data[i++] = 255*c;
    data[i++] = 255;
  }
  const volume = new THREE.Data3DTexture(data, size, size, size);
  volume.format = THREE.RGBAFormat;
  volume.minFilter = volume.magFilter = THREE.LinearFilter;
  volume.wrapS = volume.wrapT = volume.wrapR = THREE.RepeatWrapping;
  volume.needsUpdate = true;
  return volume;
}

// Near-field star streaks: a cylinder of points that flows past the ship at
// the visual warp speed, so streak length follows depth (1/z) and every star
// visibly rushes by. The formation field folds them onto the conduit radius.
const STAR_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec4 aSeed;   // r0, theta, z01, magnitude
attribute vec3 aColor;
uniform float uTravel;
uniform float uFieldNear;
uniform float uFieldLen;
uniform float uStreak;
uniform vec2 uRes;
uniform float uPx;
uniform float uR;
uniform float uWide;
uniform float uGain;
uniform vec3 uColFil;
varying vec3 vColor;
varying float vAlpha;
varying vec2 vQ;
varying float vLen;
varying float vHW;
${FORMATION}
void main(){
  float r0 = aSeed.x;
  float th = aSeed.y;
  float mag = aSeed.w;
  float z = uFieldNear - uFieldLen + mod(aSeed.z * uFieldLen + uTravel, uFieldLen);
  float d = -z;
  float F = formation(max(d, -60.0 * uScale));
  float h = fract(mag * 17.13 + aSeed.z * 5.7);
  float rt = uR * mix(uWide, 1.0, F) * (0.9 + 0.2 * h);
  float r = mix(r0, rt, F);
  th += F * (h - 0.5) * 0.18;
  vec2 axis = bendAt(d) * F;
  vec3 head = vec3(cos(th) * r + axis.x, sin(th) * r + axis.y, z);
  float exposure = mix(1.0, mix(.22, 1.18, mag), smoothstep(0.0, .12, uEnter));
  vec3 tail = head - vec3(0.0, 0.0, uStreak * exposure);
  tail.z = max(tail.z, uFieldNear - uFieldLen);

  vec4 hv = modelViewMatrix * vec4(head, 1.0);
  vec4 tv = modelViewMatrix * vec4(tail, 1.0);
  const float NZ = -0.5;
  vAlpha = 0.0; vQ = vec2(0.0); vLen = 0.0; vHW = 1.0; vColor = vec3(0.0);
  if (hv.z > NZ && tv.z > NZ) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  if (hv.z > NZ) hv = mix(tv, hv, (NZ - tv.z) / (hv.z - tv.z));
  else if (tv.z > NZ) tv = mix(hv, tv, (NZ - hv.z) / (tv.z - hv.z));
  vec4 ch = projectionMatrix * hv;
  vec4 ct = projectionMatrix * tv;
  vec2 sh = (ch.xy / ch.w * 0.5 + 0.5) * uRes;
  vec2 st = (ct.xy / ct.w * 0.5 + 0.5) * uRes;
  vec2 dv = sh - st;
  float lpx = length(dv);
  vec2 dir = lpx > 1e-3 ? dv / lpx : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float hw = (0.55 + 1.35 * mag) * uPx;
  float ext = hw * 2.0;
  float along = position.x;
  float side = position.y;
  vec2 p = mix(st, sh, along) + dir * (along * 2.0 - 1.0) * ext + nrm * side * ext;
  vQ = vec2(along * lpx + (along * 2.0 - 1.0) * ext, side * ext);
  vLen = lpx;
  vHW = hw;
  float energy = pow(hw * 3.0 / (lpx + hw * 3.0), mix(0.35, 0.75, 1.0 - mag));
  float farFade = smoothstep(uFieldNear - uFieldLen, uFieldNear - uFieldLen + 700.0 * uScale, z);
  float absorb = 1.0 - smoothstep(0.5, 0.95, F);
  float flare = 1.0 + 1.1 * F * (1.0 - F) * 4.0;
  vAlpha = (0.05 + 1.1 * mag * mag) * energy * farFade * absorb * flare * uGain;
  vColor = mix(aColor, uColFil, smoothstep(0.1, 0.8, F));
  vec4 cc = mix(ct, ch, along);
  gl_Position = vec4((p / uRes) * 2.0 - 1.0, cc.z / cc.w, 1.0);
  #ifdef USE_LOGDEPTHBUF
    vFragDepth = 1.0 + cc.w;
    vIsPerspective = 1.0;
  #endif
}
`;

const STAR_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vColor;
varying float vAlpha;
varying vec2 vQ;
varying float vLen;
varying float vHW;
void main(){
  #include <logdepthbuf_fragment>
  if (vAlpha < 0.001) discard;
  float dx = max(0.0, max(-vQ.x, vQ.x - vLen));
  float dist2 = dx * dx + vQ.y * vQ.y;
  float prof = exp(-dist2 / (vHW * vHW) * 1.1);
  float t = clamp(vQ.x / max(vLen, 1e-3), 0.0, 1.0);
  float grad = mix(0.12, 1.0, pow(t, 1.3));
  grad = mix(1.0, grad, smoothstep(vHW * 1.5, vHW * 8.0, vLen));
  float a = prof * grad * vAlpha;
  if (a < 0.002) discard;
  gl_FragColor = vec4(vColor * a, a);
}
`;

// Palettes in sRGB; converted to linear on use.
export const CONDUIT_STYLES = Object.freeze({
  abyssal: { deep: '#020409', mid: '#0d2144', filament: '#a8ccff', rib: '#d6e6ff',
    throat: '#e4f0ff', edge: '#6fa4ff', light: '#cfe2ff', ambient: '#1a2c55' },
});

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class WarpConduit {
  // radius: conduit radius in metres; layer: the render layer to draw on.
  constructor({ radius = 220, layer = 0, quality = 'medium', renderOrder = 40 } = {}) {
    this.radius = radius;
    this.scale = radius / 60;
    this.group = new THREE.Group();
    this.group.name = 'warp-conduit';
    this.group.visible = false;
    const k = this.scale;
    this.shared = {
      uEnter: { value: 0 }, uExit: { value: 0 }, uDMax: { value: 4000 * k }, uScale: { value: k },
      uFrontNear: { value: 1700 }, uR: { value: radius }, uWide: { value: 7.0 },
      uBend: { value: new THREE.Vector2() },
      uColFil: { value: new THREE.Color() }, uColThroat: { value: new THREE.Color() },
    };
    this.setStyle(CONDUIT_STYLES.abyssal);
    const make = (vertexShader, fragmentShader, extra, blending, name) => {
      const material = new THREE.ShaderMaterial({
        vertexShader, fragmentShader, uniforms: { ...this.shared, ...extra },
        transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide, blending,
        toneMapped: false,
      });
      material.name = name;
      return material;
    };
    this.cloud = cloudNoise();
    this.fogDrift = { value: 0 };
    const bounds = new THREE.BoxGeometry(800*k, 800*k, 800*k);
    const volume = make(FOG_VERT, FOG_FRAG, { uCloud: { value: this.cloud }, uDrift: this.fogDrift },
      THREE.NormalBlending, 'conduit-volume');
    volume.side = THREE.BackSide;
    volume.defines = { FOG_STEPS: 18 };
    if (quality === 'low') {
      this.fogTarget = new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
        depthBuffer: false, stencilBuffer: false,
      });
      volume.defines.FILTERED_FOG = 1;
      volume.transparent = false;
      volume.blending = THREE.NoBlending;
      volume.depthTest = false;
      this.lowVolume = new THREE.Mesh(bounds, volume);
      this.lowVolume.layers.enableAll();
      this.lowVolume.frustumCulled = false;
      const lookup = make(FOG_LOOKUP_VERT, FOG_LOOKUP_FRAG, { tFog: { value: this.fogTarget.texture } },
        THREE.NormalBlending, 'conduit-fog-reconstruction');
      lookup.side = THREE.BackSide;
      this.fog = new THREE.Mesh(bounds, lookup);
    } else {
      this.fog = new THREE.Mesh(bounds, volume);
    }
    this.starGeometry = this.#buildStars(quality === 'low' ? 1600 : 2600);
    this.starMaterial = make(STAR_VERT, STAR_FRAG, {
      uTravel: { value: 0 }, uFieldNear: { value: 1200 * k }, uFieldLen: { value: 4400 * k },
      uStreak: { value: 0 }, uRes: { value: new THREE.Vector2(1920, 1080) }, uPx: { value: 1 }, uGain: { value: 1 },
    }, THREE.CustomBlending, 'conduit-stars');
    // premultiplied additive: colour already carries its alpha
    this.starMaterial.blendSrc = THREE.OneFactor;
    this.starMaterial.blendDst = THREE.OneFactor;
    this.stars = new THREE.Mesh(this.starGeometry, this.starMaterial);
    this.fog.renderOrder = renderOrder;
    this.stars.renderOrder = renderOrder + 1;
    for (const mesh of [this.fog, this.stars]) {
      mesh.frustumCulled = false;
      mesh.layers.set(layer);
      this.group.add(mesh);
    }
    this.travel = 0;
    this.state = { enclosure: 0, coverage: 0, glow: 0, ribPulse: 0 };
  }

  setStyle(style) {
    const s = this.shared;
    s.uColFil.value.set(style.filament);
    s.uColThroat.value.set(style.throat);
  }

  // Tint the far end toward the destination star (linear colour).
  setDestinationTint(color, amount = 0.3) {
    this.shared.uColThroat.value.set(CONDUIT_STYLES.abyssal.throat).lerp(color, amount);
  }

  setSize(width, height, pixelRatio) {
    this.starMaterial.uniforms.uRes.value.set(width, height);
    this.starMaterial.uniforms.uPx.value = pixelRatio;
    const scale = Math.min(.25, 384 / Math.max(1, width, height));
    this.fogTarget?.setSize(Math.max(1, Math.ceil(width*scale)), Math.max(1, Math.ceil(height*scale)));
  }

  renderLowFog(renderer, camera) {
    if (!this.lowVolume || !this.group.visible || !this.fog.visible) return;
    this.lowVolume.position.copy(this.group.position);
    this.lowVolume.quaternion.copy(this.group.quaternion);
    const target = renderer.getRenderTarget();
    const face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
    const autoClear = renderer.autoClear;
    try {
      renderer.autoClear = false;
      renderer.setRenderTarget(this.fogTarget);
      // The eye is inside the box. Its back faces overwrite every texel.
      renderer.render(this.lowVolume, camera);
    } finally {
      renderer.setRenderTarget(target, face, mip);
      renderer.autoClear = autoClear;
    }
  }

  #buildStars(count) {
    const k = this.scale;
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const seed = new Float32Array(count * 4);
    const color = new Float32Array(count * 3);
    const rnd = mulberry32(1337);
    const rMin = 5 * k, rMax = 1700 * k;
    const tint = [[0.72, 0.82, 1.0], [0.86, 0.91, 1.0], [1.0, 0.97, 0.93], [1.0, 0.86, 0.68], [1.0, 0.74, 0.55]];
    for (let i = 0; i < count; i++) {
      seed[i * 4] = Math.sqrt(rMin * rMin + (rMax * rMax - rMin * rMin) * Math.pow(rnd(), 1.15));
      seed[i * 4 + 1] = rnd() * Math.PI * 2;
      seed[i * 4 + 2] = rnd();
      seed[i * 4 + 3] = Math.pow(rnd(), 3.2);
      color.set(tint[Math.min(4, Math.floor(Math.pow(rnd(), 1.4) * 5))], i * 3);
    }
    geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 4));
    geometry.setAttribute('aColor', new THREE.InstancedBufferAttribute(color, 3));
    geometry.instanceCount = count;
    return geometry;
  }

  // CPU mirror of the GLSL formation field.
  formationAt(d, enter, exit) {
    const k = this.scale, dmax = 4000 * k, near = this.shared.uFrontNear.value;
    const front = (x) => { const q = 1 - x; return -near * k + (dmax + 1500 * k + near * k) * q * q; };
    const fe = front(enter), we = 120 * k + 0.22 * Math.max(fe, 0);
    const fx = front(exit), wx = 140 * k + 0.26 * Math.max(fx, 0);
    return smooth(fe - we, fe + we, d) * (1 - smooth(fx - wx, fx + wx, d));
  }

  // Per frame. `frame` gives the conduit's world pose (camera-relative render
  // space, -Z along the heading); `params`: enter, exit (0..1 fronts), warp
  // (0..1 flow), speed (visual m/s), streak (metres), glow, bend (vec2).
  update(dt, frame, params) {
    const { enter = 0, exit = 0, warp = 0, speed = 0, streak = 0, starGain = 1, bend = null } = params;
    const k = this.scale;
    const active = enter > 0.0005 && exit < 0.9995;
    const starsLive = warp > 0.001 || active;
    this.group.visible = active || starsLive;
    this.group.position.copy(frame.position);
    this.group.quaternion.copy(frame.quaternion);
    this.group.updateMatrixWorld(true);
    this.travel += speed * dt;
    const s = this.shared;
    s.uEnter.value = enter;
    s.uExit.value = exit;
    if (bend) s.uBend.value.copy(bend);
    const enclosure = active ? this.formationAt(0, enter, exit) : 0;
    const coverage = Math.min(enter, 1 - exit);
    this.fog.visible = active;
    // Two wraps keep the half-frequency curl continuous across the repeat.
    this.fogDrift.value = (this.travel / this.radius * .006) % 2;
    this.stars.visible = starsLive && !(coverage > 0.999 && enclosure > 0.999);
    const sm = this.starMaterial.uniforms;
    sm.uTravel.value = this.travel % (4400 * k);
    sm.uStreak.value = Math.min(streak, 1100 * k);
    sm.uGain.value = starGain * (1 + 0.15 * warp);
    const cloudPhase = this.travel / this.radius * .18;
    this.state.enclosure = enclosure;
    this.state.coverage = coverage;
    this.state.glow = .35 + .65 * smooth(.15, 1, warp);
    this.state.ribPulse = .5 + .32*Math.sin(cloudPhase) + .18*Math.sin(cloudPhase*.61);
    return this.state;
  }

  dispose() {
    this.group.removeFromParent();
    this.fog.geometry.dispose();
    this.cloud.dispose();
    this.fogTarget?.dispose();
    this.lowVolume?.material.dispose();
    this.starGeometry.dispose();
    for (const mesh of [this.fog, this.stars]) mesh.material.dispose();
  }
}
