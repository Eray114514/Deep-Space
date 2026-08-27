// Diegetic instruments — ported 1:1 from 3aaa-spaceship-flight-prototype/src/game/ship/cockpit/holo.ts
// (types stripped only; logic, constants and comments unchanged).
// Adaptation: logdepthbuf includes in both shaders (this renderer runs
// logarithmicDepthBuffer).
import * as THREE from 'three';

/* ------------------------------------------------------------------ *
 *  DIEGETIC INSTRUMENTS  —  holoMat ported from TheLongSilence's
 *  src/ship/Cockpit.js.
 *
 *  TLS's rule, and the reason this file exists at all: NOTHING on a
 *  dashboard is a screen-space overlay.  Every readout is geometry
 *  standing in the cockpit, lit and occluded like everything else, so it
 *  moves with the ship, is hidden by the glareshield when you lean, and
 *  reflects in the canopy.  A HUD drawn over the frame can do none of
 *  that and always reads as a UI layer pasted on top of a render.
 *
 *  Two cues do almost all the work of "projected volume rather than solid
 *  object": a horizontal BUILD-UP BAND sweeping the height, and fine
 *  SLICE LINES.  Both are in local space, so they follow the object.
 *
 *  `gain` is per instrument rather than in the shader, and that is a
 *  measured decision from TLS: an additive line at unit radiance inside a
 *  genuinely dark machined well lands at a few thousandths of a display
 *  unit — present in the buffer, invisible on screen — while the same line
 *  in open cabin light needs no help at all.
 * ------------------------------------------------------------------ */

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vLocal;
void main(){
  vLocal = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;

const FRAG = /* glsl */ `
precision highp float;
#include <logdepthbuf_pars_fragment>
varying vec3 vLocal;
uniform vec3  uColor;
uniform float uTime;
uniform float uPower;
uniform float uScanH;
void main(){
  #include <logdepthbuf_fragment>
  /* mod() on time: an unbounded argument into fract()/sin() is how the
     engine plume shader went non-finite and blacked out whole frames */
  float t = mod(uTime, 64.0);
  /* Gaussian build-up band.  Squared by multiplication: the offset is
     negative below the band, and pow(negative, 2.0) is undefined in GLSL —
     the usual lowering is exp2(2.0*log2(x)), which NaNs.  The identical
     expression in the nebula shader was drawing NaN shards across the sky. */
  float bo = (vLocal.y - fract(t * 0.11) * uScanH * 2.0 + uScanH * 0.5)
             / (uScanH * 0.10);
  float band = exp(-bo * bo);
  float slice = 0.55 + 0.45 * sin(vLocal.y * 260.0);
  /* Additive, so anything over unity clips to white and the volume loses its
     shape.  Held under 1 except on the build-up band. */
  float a = uPower * (0.26 + band * 0.85) * slice;
  gl_FragColor = clamp(vec4(uColor * a, a), 0.0, 32.0);
}`;

export function holoMat(color, scanH = 0.2, gain = 1) {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uColor: { value: new THREE.Color(color).convertSRGBToLinear() },
      uTime: { value: 0 },
      uPower: { value: gain },
      uScanH: { value: scanH },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

/**
 * A volumetric tactical plot: concentric range rings, a sweep, contacts and
 * a vertical axis, all as real geometry above a bezel.
 */
function plot(color, r, gain) {
  const g = new THREE.Group();
  const mat = holoMat(color, r * 1.1, gain);
  for (let i = 1; i <= 3; i++) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r * (i / 3), 0.0035, 4, 44), mat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = r * 0.06;
    g.add(ring);
  }
  /* the sweep: a thin wedge that rotates, so the plot is alive without a
     texture update */
  const sweep = new THREE.Mesh(new THREE.CircleGeometry(r, 12, 0, 0.34), mat);
  sweep.rotation.x = -Math.PI / 2;
  sweep.position.y = r * 0.05;
  g.add(sweep);
  /* contacts at plausible bearings, each a small pip on a stalk */
  const seedRand = (s) => { let x = s; return () => (x = (x * 1664525 + 1013904223) >>> 0) / 4294967296; };
  const rnd = seedRand(9001);
  for (let i = 0; i < 7; i++) {
    const a = rnd() * Math.PI * 2, d = r * (0.25 + rnd() * 0.7), h = r * (0.1 + rnd() * 0.5);
    const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.0022, 0.0022, h, 4), mat);
    stalk.position.set(Math.cos(a) * d, r * 0.06 + h / 2, Math.sin(a) * d);
    g.add(stalk);
    const pip = new THREE.Mesh(new THREE.OctahedronGeometry(r * 0.035), mat);
    pip.position.set(Math.cos(a) * d, r * 0.06 + h, Math.sin(a) * d);
    g.add(pip);
  }
  return { obj: g, mat, sweep };
}

/**
 * Build the instrument layer over the station's display bays.
 *
 * The flat canvas planes stay: a hologram floating where a panel-mounted MFD
 * belongs would read as a gimmick.  These are the volumetric additions that
 * genuinely stand in the cockpit — a tactical plot in the centre well and a
 * navigation solid on the pedestal.
 */
export function buildInstruments(
  bays,
) {
  const group = new THREE.Group();
  group.name = 'instruments';
  const mats = [];
  const spinners = [];

  /* centre bay of the main panel: the tactical plot, in its own dark well so
     the gain has to be high — see the header */
  const centre = bays.find((b) => b.role === 'mfd-centre');
  if (centre) {
    const p = plot(0x7fe4ff, 0.115, 2.6);
    p.obj.applyMatrix4(centre.m);
    group.add(p.obj);
    mats.push(p.mat);
    spinners.push(p.sweep);
  }
  /* the pedestal display: a navigation solid — a slowly turning wireframe
     body with a track through it */
  const ped = bays.find((b) => b.role === 'pedestal');
  if (ped) {
    const holder = new THREE.Group();
    const mat = holoMat(0xffc27a, 0.16, 2.2);
    const body = new THREE.Mesh(new THREE.IcosahedronGeometry(0.052, 1), mat);
    body.position.y = 0.085;
    holder.add(body);
    const orbit = new THREE.Mesh(new THREE.TorusGeometry(0.082, 0.0028, 4, 40), mat);
    orbit.rotation.set(Math.PI / 2.3, 0, 0.22);
    orbit.position.y = 0.085;
    holder.add(orbit);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.002, 28), mat);
    base.position.y = 0.006;
    holder.add(base);
    holder.applyMatrix4(ped.m);
    group.add(holder);
    mats.push(mat);
    spinners.push(body, orbit);
  }

  return {
    group,
    mats,
    update(t, speed, throttle) {
      for (const m of mats) m.uniforms.uTime.value = t;
      /* the sweep rate rises with speed and the plot brightens under power:
         an instrument that never changes reads as a decal */
      spinners[0] && (spinners[0].rotation.z = -t * (0.9 + speed * 0.004));
      for (let i = 1; i < spinners.length; i++) spinners[i].rotation.y = t * (0.3 + i * 0.12);
      if (mats[0]) mats[0].uniforms.uPower.value = 2.2 + Math.abs(throttle) * 1.1;
    },
  };
}
