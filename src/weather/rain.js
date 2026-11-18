// GPU precipitation streaks and ground splashes.
//
// What makes it read as rain instead of a line field:
//  - 9k instanced camera-facing quads, wrapped in a box that is fixed in the
//    world (the player walks through the rain instead of carrying it)
//  - streak width never drops below one pixel; sub-pixel drops widen and fade
//    instead, so there is no aliasing shimmer
//  - drops are lit: ambient + sun through a forward-scattering phase function,
//    so rain glows when backlit and nearly vanishes with the sun behind you
//  - near/far fades, and crown-shaped splashes on the ground around the player
//
// Everything is computed in a spherical tangent frame around the camera: the
// mesh sits at the camera with its basis (side, up, forward), `uOffset` carries
// the accumulated player displacement in that frame, and splash heights come
// from a small terrain height grid supplied by the game. The game renders with
// a logarithmic depth buffer, so both shaders carry three's logdepth chunks.

import * as THREE from 'three';

const PHASE_GLSL = /* glsl */`
float wPhase(float c){ float g = 0.72; return (1.0 - g * g) / (12.566 * pow(1.0 + g * g - 2.0 * g * c, 1.5)); }
uniform vec4 uGround[13];   // 7x7 height grid, packed 4 per vec4 (49 values)
uniform float uGroundSpan;  // half extent of the grid (m)
uniform float uGroundValid;
float groundCell(int i){ vec4 v = uGround[i / 4]; int k = i - (i / 4) * 4; return k == 0 ? v.x : k == 1 ? v.y : k == 2 ? v.z : v.w; }
float groundAt(vec2 xz){
  vec2 g = clamp((xz / uGroundSpan * 0.5 + 0.5) * 6.0, 0.0, 5.999);
  vec2 i = floor(g), f = g - i;
  int a = int(i.y) * 7 + int(i.x);
  float h00 = groundCell(a), h10 = groundCell(a + 1), h01 = groundCell(a + 7), h11 = groundCell(a + 8);
  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}
`;

const DROP_VERT = /* glsl */`
uniform float uTime, uRain, uPix; uniform vec3 uVel, uBox, uOffset, uSunDir, uSunCol, uAmb;
attribute vec4 aSeed;
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vCol; varying float vA; varying vec2 vUv;
${PHASE_GLSL}
void main(){
  vUv = position.xy;
  float sp = 0.82 + 0.36 * aSeed.w;
  vec3 vel = uVel * sp;
  vec3 p = aSeed.xyz * uBox + vel * uTime - uOffset;
  p = mod(p + 0.5 * uBox, uBox) - 0.5 * uBox;           // camera-centred, world-fixed field
  float len = 0.03 * length(vel);
  float kill = fract(aSeed.w * 7.13 + aSeed.x) > uRain ? 1.0 : 0.0;
  if (uGroundValid > 0.5 && abs(p.x) < uGroundSpan && abs(p.z) < uGroundSpan && p.y < groundAt(p.xz)) kill = 1.0;
  vec3 dir = normalize(vel);
  float dist = length(p);
  vec3 side = normalize(cross(dir, p + vec3(1e-4)));
  float w0 = 0.005 + 0.004 * fract(aSeed.w * 3.7);
  float w = max(w0, dist * uPix * 0.75);
  vec3 wp = p + dir * (len * (position.y - 0.5)) + side * (w * position.x);
  float a = (w0 / w) * smoothstep(0.7, 2.6, dist) * (1.0 - smoothstep(0.38, 0.5, dist / uBox.x));
  float c = dot(p / max(dist, 1e-3), uSunDir);
  vCol = uAmb + uSunCol * wPhase(c);
  vA = a * (0.55 + 0.45 * fract(aSeed.w * 13.3));
  gl_Position = kill > 0.5 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * modelViewMatrix * vec4(wp, 1.0);
  #include <logdepthbuf_vertex>
}`;

const DROP_FRAG = /* glsl */`
#include <logdepthbuf_pars_fragment>
varying vec3 vCol; varying float vA; varying vec2 vUv;
void main(){
  #include <logdepthbuf_fragment>
  float x = 1.0 - abs(vUv.x) * 2.0;
  float e = smoothstep(0.0, 0.12, vUv.y) * smoothstep(1.0, 0.55, vUv.y);
  gl_FragColor = vec4(vCol, vA * x * e);
}`;

const SPLASH_VERT = /* glsl */`
uniform float uTime, uRain; uniform vec3 uOffset, uSunDir, uSunCol, uAmb;
attribute vec4 aSeed;
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vCol; varying float vA; varying vec2 vUv; varying float vLife;
${PHASE_GLSL}
vec2 sHash(vec2 p){ vec3 q = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); q += dot(q, q.yzx + 33.33); return fract((q.xx + q.yz) * q.zy); }
void main(){
  vUv = position.xy;
  float period = 0.26 + 0.14 * aSeed.z;
  float tt = uTime / period + aSeed.w * 10.0; float cyc = floor(tt); float life = fract(tt);
  vec2 r = sHash(aSeed.xy * 91.7 + cyc * 0.371);
  vec2 rr = r - 0.5; rr *= 0.35 + 1.3 * abs(rr);                    // denser near the player
  vec2 snap = floor(uOffset.xz / 4.0) * 4.0;                         // world-fixed 4 m grid
  vec2 xz = snap + rr * 30.0 - uOffset.xz;
  float k = fract(aSeed.w * 5.3 + cyc * 0.17);
  float kill = (k > 0.45 || k > 0.2 + 0.8 * uRain || uGroundValid < 0.5) ? 1.0 : 0.0;
  vec3 p = vec3(xz.x, groundAt(xz), xz.y);
  float sz = mix(0.04, 0.08, aSeed.z) * 0.8;
  float wd = sz * (0.7 + 1.5 * life), ht = sz * (0.4 + 1.3 * sin(life * 3.14159));
  float dist = length(p);
  vec3 side = normalize(vec3(p.z, 0.0, -p.x) + vec3(1e-4, 0.0, 0.0));
  vec3 wp = p + side * (wd * position.x * 2.0) + vec3(0.0, ht * position.y + 0.004, 0.0);
  float c = dot(p / max(dist, 1e-3), uSunDir);
  vCol = uAmb * 1.4 + uSunCol * wPhase(c) * 0.8;
  vA = (1.0 - life) * (1.0 - smoothstep(11.0, 15.0, dist)) * 0.75;
  vLife = life;
  gl_Position = kill > 0.5 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * modelViewMatrix * vec4(wp, 1.0);
  #include <logdepthbuf_vertex>
}`;

const SPLASH_FRAG = /* glsl */`
#include <logdepthbuf_pars_fragment>
varying vec3 vCol; varying float vA; varying vec2 vUv; varying float vLife;
void main(){
  #include <logdepthbuf_fragment>
  float x = vUv.x * 2.0, y = vUv.y;
  // little crown: a rim arc that opens outward
  float dome = smoothstep(1.0, 0.25, length(vec2(x * 1.15, y * 1.5)));
  float crown = dome * (0.35 + 0.65 * smoothstep(0.25, 0.75, length(vec2(x, y * 1.4))));
  float core = smoothstep(0.5, 0.0, length(vec2(x * 1.6, (y - 0.25) * 1.6))) * (1.0 - vLife);
  float a = clamp(crown * 0.5 + core * 0.8, 0.0, 1.0) * vA * 0.6;
  if (a < 0.003) discard;
  gl_FragColor = vec4(vCol, a);
}`;

function quadGeometry(count, rand) {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0]), 3));
  geometry.setIndex([0, 1, 2, 2, 1, 3]);
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < seeds.length; i++) seeds[i] = rand();
  geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  geometry.instanceCount = count;
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
  return geometry;
}

// deterministic seed stream (rain layout is cosmetic but should not flicker between runs)
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

const BOX = new THREE.Vector3(26, 15, 26);
// offset wrap keeps float precision; multiple of the box and of the 4 m splash grid
const WRAP = new THREE.Vector3(26 * 40, 15 * 40, 26 * 40);
export const GROUND_GRID = 7;
export const GROUND_SPAN = 16;

export class RainSystem {
  constructor(scene, { drops = 12000, splashes = 900, seed = 0x5a17 } = {}) {
    const rand = mulberry32(seed);
    this.group = new THREE.Group();
    this.group.name = 'surface-rain';
    this.group.matrixAutoUpdate = false;
    this.offset = new THREE.Vector3();
    this.ground = Array.from({ length: 13 }, () => new THREE.Vector4());
    const shared = {
      uTime: { value: 0 }, uRain: { value: 0 }, uOffset: { value: this.offset },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color(1, 0.95, 0.88) },
      uAmb: { value: new THREE.Color(0.05, 0.06, 0.07) },
      uGround: { value: this.ground }, uGroundSpan: { value: GROUND_SPAN }, uGroundValid: { value: 0 },
    };
    this.uniforms = shared;
    this.dropUniforms = { ...shared, uPix: { value: 2e-3 }, uVel: { value: new THREE.Vector3(-2.6, -9.4, 1.1) }, uBox: { value: BOX.clone() } };
    const material = (uniforms, vertexShader, fragmentShader) => new THREE.ShaderMaterial({
      uniforms, vertexShader, fragmentShader, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    });
    this.drops = new THREE.Mesh(quadGeometry(drops, rand), material(this.dropUniforms, DROP_VERT, DROP_FRAG));
    this.drops.name = 'rain-drops';
    this.drops.renderOrder = 6;
    this.splashes = new THREE.Mesh(quadGeometry(splashes, rand), material(shared, SPLASH_VERT, SPLASH_FRAG));
    this.splashes.name = 'rain-splashes';
    this.splashes.renderOrder = 6;
    for (const mesh of [this.drops, this.splashes]) {
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
    }
    this.group.visible = false;
    this.level = 0;
    scene.add(this.group);
    this._basis = new THREE.Matrix4();
    this._v = new THREE.Vector3();
    this._size = new THREE.Vector2();
  }

  // frame: { dt, time, level 0..1, origin (camera world pos), side, up, forward
  //   (world unit vectors), displacement (world, this frame), wind (world m/s),
  //   sunDir (world), sunColor (Color), ambient (Color), camera, renderer,
  //   groundHeights (Float32Array(49) | null, local y relative to origin) }
  update(frame) {
    const target = THREE.MathUtils.clamp(frame.level || 0, 0, 1);
    // Fade in smoothly (~1.5 s), but clear crisply (~0.8 s) when climbing above
    // clouds or leaving rain so streaks never trail kilometres into blue sky.
    const rate = target <= 0.001 ? 6.0 : (target < this.level ? 2.5 : 0.9);
    this.level += (target - this.level) * Math.min(1, (frame.dt || 0) * rate);
    if (target > 0 && this.level < 0.02) this.level = Math.min(target, 0.02);
    const visible = this.level > 0.01;
    this.group.visible = visible;
    if (!visible) {
      this.level = 0;
      return false;
    }
    const { side, up, forward } = frame;
    this._basis.makeBasis(side, up, forward).setPosition(frame.origin || this._v.set(0, 0, 0));
    this.group.matrix.copy(this._basis);
    this.group.matrixWorldNeedsUpdate = true;
    this.group.updateMatrixWorld(true);

    const u = this.uniforms;
    u.uTime.value = frame.time || 0;
    u.uRain.value = this.level;
    const d = frame.displacement;
    if (d) {
      this.offset.x += d.dot(side);
      this.offset.y += d.dot(up);
      this.offset.z += d.dot(forward);
      this.offset.set(
        THREE.MathUtils.euclideanModulo(this.offset.x, WRAP.x),
        THREE.MathUtils.euclideanModulo(this.offset.y, WRAP.y),
        THREE.MathUtils.euclideanModulo(this.offset.z, WRAP.z),
      );
    }
    const w = frame.wind;
    const wx = w ? THREE.MathUtils.clamp(w.dot(side), -12, 12) : -2.6;
    const wz = w ? THREE.MathUtils.clamp(w.dot(forward), -12, 12) : 1.1;
    this.dropUniforms.uVel.value.set(wx, -9.4, wz);
    if (frame.sunDir) u.uSunDir.value.set(frame.sunDir.dot(side), frame.sunDir.dot(up), frame.sunDir.dot(forward)).normalize();
    if (frame.sunColor) u.uSunCol.value.copy(frame.sunColor);
    if (frame.ambient) u.uAmb.value.copy(frame.ambient);
    if (frame.groundHeights) {
      for (let i = 0; i < 49; i++) this.ground[i >> 2].setComponent(i & 3, frame.groundHeights[i]);
      u.uGroundValid.value = 1;
    } else u.uGroundValid.value = 0;
    if (frame.camera && frame.renderer) {
      frame.renderer.getDrawingBufferSize(this._size);
      this.dropUniforms.uPix.value = 2 * Math.tan(frame.camera.fov * Math.PI / 360) / Math.max(1, this._size.y);
    }
    return true;
  }

  dispose() {
    this.group.parent?.remove(this.group);
    for (const mesh of [this.drops, this.splashes]) { mesh.geometry.dispose(); mesh.material.dispose(); }
  }
}
