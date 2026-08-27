// Canopy glazing — ported 1:1 from 3aaa-spaceship-flight-prototype/src/game/ship/cockpit/glass.ts
// (types stripped only; logic, constants and comments unchanged).
// Adaptations:
//  - logdepthbuf includes in both shaders (this renderer runs logarithmicDepthBuffer).
//  - bindGlass's sun lookup prefers the directional light flagged with
//    userData.shipSun, because this project's scene carries more than one
//    DirectionalLight (the terrain-scale sunShadow light).
import * as THREE from 'three';

/* ------------------------------------------------------------------ *
 *  CANOPY GLAZING  —  ported from TheLongSilence's makeCanopyGlass /
 *  bindGlass (src/ship/interiorMaterials.js).
 *
 *  Ported rather than copied, because TLS's version is welded to TLS's
 *  cabin: its reflected-lamp positions are hand-transcribed from its own
 *  Interior.js and its cabin is a separate scene where cabin space is
 *  world space.  Three things had to change and each one is a fix:
 *
 *  1  SHIP-LOCAL, NOT WORLD.  This ship flies, so `modelMatrix` is not
 *     identity.  The shader therefore works in OBJECT space — raw
 *     `position` and `normal` — and bindGlass pushes the eye and the star
 *     down into the mesh's local frame.  Cheaper than transforming the
 *     lamp table every frame, and it cannot go stale.
 *
 *  2  THE LAMPS COME FROM datum.js.  TLS warns that these positions are a
 *     "standing obligation" and describes shipping a reflected cove 1.1 m
 *     forward of where the cove physically stopped — reflecting a lamp
 *     that was not there, in the part of the pane you look through.  Here
 *     the fixtures and their reflections read the same LAMPS table, so
 *     there is nothing to keep in sync.  The lobes are unrolled into the
 *     source from that table so the compiler folds them.
 *
 *  3  vUv IS CLAMPED.  A canopy pane is a large additive-ish surface that
 *     the near plane crosses when the camera moves through the hull, and
 *     an unclamped interpolated coordinate is exactly what produced the
 *     -Inf that blacked out whole frames (see gfx/sanitize.js).
 *
 *  Everything else is TLS's reasoning and worth keeping verbatim in
 *  spirit: the Fresnel is for a coated SLAB rather than an interface,
 *  because a pane the eye sees at 70-85 degrees over most of the frame
 *  turns an incidence-driven sheen into a veil; the sheen is put back
 *  only in the rim band where the glass really does curve away; the
 *  polish is anisotropic along the hull axis and faded out as its period
 *  approaches a pixel, because a hard step with no mip chain under it
 *  reads as corduroy; and the printed frit border is the single
 *  strongest cue that a pane is a physical object.
 * ------------------------------------------------------------------ */

/** shoulder line of the hull section, y = A + B*z, fitted over the flight deck */
const ARC = new THREE.Vector2(3.618, 0.324);

function lampLobes(lamps) {
  return lamps.map((l) => {
    const v = (p) => `vec3(${p.x.toFixed(4)},${p.y.toFixed(4)},${p.z.toFixed(4)})`;
    const c = `vec3(${l.c.r.toFixed(4)},${l.c.g.toFixed(4)},${l.c.b.toFixed(4)})`;
    return `  c += ${c} * lineLobe(p, r, ${v(l.a)}, ${v(l.b)}, ${l.sig.toFixed(4)});`;
  }).join('\n');
}

const VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vLPos;
varying vec3 vLNrm;
varying vec2 vGuv;
void main(){
  vGuv = uv;
  vLPos = position;
  vLNrm = normal;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;

const ENV = /* glsl */ `
/* Angular lobe of a line emitter, seen from o along d.  Closest approach
   between ray and segment, miss distance divided by range so it comes out as
   an angle.  Both clamps matter: s off the end means the lamp stops rather
   than running to infinity, and t behind the eye means a fixture BEHIND the
   pane contributes nothing instead of reflecting through it. */
float lineLobe(vec3 o, vec3 d, vec3 a, vec3 b, float sig){
  vec3 u = b - a;
  vec3 w = o - a;
  float uu = dot(u, u), ud = dot(u, d), uw = dot(u, w), dw = dot(d, w);
  float s = clamp((uw - dw * ud) / max(uu - ud * ud, 1e-4), 0.0, 1.0);
  float t = max(s * ud - dw, 0.0);
  float m = length(w + t * d - s * u) / max(t, 0.30);
  float q = m / sig;
  return exp(-q * q);
}

/* The painted shell as RADIANCE, not reflectance.
   Three values and not two, because the two that matter are adjacent: the
   walls are the brightest thing the room can offer a mirror — bone paint
   washed by the coves — and the deck is the darkest.  A single up/down ramp
   puts the crossover in the wrong place and makes the canopy brightest where
   it reflects the ceiling.  Across a wrapped pane the correct version runs
   dark at the crown, where the glass looks straight down at the floor, to
   bright at the sills where it looks across the deck — which is also the
   direction the edge sheen climbs in.  Plus a hole where the glazing is,
   because most of what a windscreen reflects is the window. */
vec3 cabinRoom(vec3 r){
  vec3 c = mix(vec3(0.086, 0.078, 0.062), vec3(0.215, 0.200, 0.172),
               smoothstep(-0.80, -0.06, r.y));
  c = mix(c, vec3(0.170, 0.186, 0.220), smoothstep(0.02, 0.72, r.y));
  c = mix(c, vec3(0.008, 0.013, 0.020),
          smoothstep(0.02, 0.55, -r.z) * smoothstep(-0.35, 0.28, r.y) * 0.88);
  return c;
}

/* What the pane reflects when the EYE IS OUTSIDE the hull.
 *
 *  TLS never needed this: its cabin is a separate scene and its canopy is
 *  only ever seen from the seat.  Here the same panes are the ship's
 *  windscreen in chase view, and reflecting a lit interior off the outside
 *  of the glass made the canopy read as an open pit rather than as glazing.
 *  So outside gets deep space plus the star's glare — the two things
 *  actually out there — and the Fresnel term already decides how much of it
 *  survives at a given angle. */
vec3 spaceSky(vec3 r, vec3 sunDir, vec3 sunCol){
  vec3 c = mix(vec3(0.010, 0.016, 0.030), vec3(0.028, 0.036, 0.062),
               r.y * 0.5 + 0.5);
  /* the galactic band, so a reflection sweeping across the pane has
     something with structure in it rather than a flat wash.
     Squared by multiplication, not by pow(): the band coordinate is
     negative over half the sphere of directions and pow(negative, 2.0) is
     undefined in GLSL — it is normally lowered to exp2(y*log2(x)), so it
     returns a NaN.  The same expression in the nebula was drawing pale
     NaN shards across the background. */
  float bx = (r.y * 1.8 + r.x * 0.35) * 2.2;
  float band = exp(-bx * bx);
  c += vec3(0.045, 0.055, 0.090) * band;
  float sd = dot(r, sunDir);
  c += sunCol * (pow(max(sd, 0.0), 220.0) * 6.0 + pow(max(sd, 0.0), 8.0) * 0.05);
  return c;
}`;

const FRAG = (lamps) => /* glsl */ `
precision highp float;
#include <logdepthbuf_pars_fragment>
varying vec3 vLPos;
varying vec3 vLNrm;
varying vec2 vGuv;

uniform vec3  uEye;       // eye in ship-local metres
uniform vec3  uSun;       // unit, ship-local, toward the star
uniform vec3  uSunCol;
uniform vec3  uTint;
uniform float uEnvGain;
uniform float uSheen;
uniform float uCover;
uniform float uCoverLum;
uniform float uCoat;
uniform float uGrime;
uniform float uPolish;
uniform float uLamp;
uniform float uRim;
uniform float uFrit;
uniform vec2  uSpan;
uniform vec2  uArc;

${ENV}

vec3 cabinLamps(vec3 p, vec3 r){
  vec3 c = vec3(0.0);
${lampLobes(lamps)}
  return c;
}

float h21(vec2 p){
  p = fract(p * vec2(139.71, 271.13));
  p += dot(p, p + 41.7);
  return fract(p.x * p.y);
}
float vn(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x),
             mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p){
  float a = 0.5, s = 0.0;
  for(int i = 0; i < 4; i++){ s += a * vn(p); p *= 2.03; a *= 0.5; }
  return s;
}

void main(){
  #include <logdepthbuf_fragment>
  /* clamp before use — a near-plane-straddling triangle interpolates
     varyings to +/-Inf and bloom would smear one bad pixel over the frame */
  vec2 guv = clamp(vGuv, 0.0, 1.0);

  vec3 N = normalize(vLNrm);
  vec3 V = normalize(uEye - vLPos);
  /* which side of the pane the eye is on, recorded BEFORE the normal is
     flipped: the geometry normal points out of the hull, so a positive dot
     means we are looking at the ship from outside. */
  float outside = step(0.0, dot(N, V));
  // one sheet drawn double-sided: face the normal at the eye
  if(dot(N, V) < 0.0) N = -N;
  float ndv = clamp(dot(N, V), 0.002, 1.0);

  /* Metres from the nearest edge, measured rather than taken from uv.
     Inverting the uv Jacobian against the world one is exact and costs six
     instructions; uv on a lofted pane is vertex-index-spaced, so anything
     authored against it is many times finer down the middle of the
     windscreen than at the sills, with a hard discontinuity either side. */
  vec3 dPx = dFdx(vLPos), dPy = dFdy(vLPos);
  vec2 dUx = dFdx(guv),   dUy = dFdy(guv);
  float det = dUx.x * dUy.y - dUx.y * dUy.x;
  float idet = 1.0 / (det + (step(0.0, det) * 2.0 - 1.0) * 1e-9);
  vec2 sp = clamp(vec2(length((dPx * dUy.y - dPy * dUx.y) * idet),
                       length((dPy * dUx.x - dPx * dUy.x) * idet)),
                  uSpan * 0.15, uSpan * 4.0);

  vec2 e2 = min(guv, 1.0 - guv) * sp;
  float edge = max(min(e2.x, e2.y), 0.0);

  /* Arc length from the crown, in metres, continuous, with no pole anywhere.
     A polar coordinate about a point inside the section puts a singularity ON
     the windscreen and every polish stroke then radiates from it.  For a
     rounded-rectangle section the pole-free version is x across the roof flat
     plus the vertical descent down the shoulder; the two agree on the
     centreline because the descent term is identically zero there. */
  float shoulder = uArc.x + uArc.y * vLPos.z;
  float run = max(shoulder - vLPos.y, 0.0);
  vec2 mp = vec2(vLPos.x + clamp(vLPos.x * 8.0, -1.0, 1.0) * run, vLPos.z);

  /* Fresnel for a coated SLAB, not an interface.  What is left after the coat
     is a near-constant 8%, which is what a coated window returns; an
     incidence-driven sheen on a pane seen at 70-85 degrees is a veil. */
  float f = 0.040 + 0.960 * pow(max(1.0 - ndv, 0.0), 5.0);
  float R = f * (2.0 - f);
  R *= mix(1.0, 0.145, uCoat * smoothstep(0.72, 0.04, ndv));

  // sheen put back only in the band before the seal, squared so the clean
  // middle of the pane is untouched
  float rim = 1.0 - smoothstep(0.0, uRim, edge);
  rim *= rim;
  R *= (1.0 + rim * 5.0) * uSheen;

  // polish: anisotropic along the hull axis, swirled — a perfectly parallel
  // scratch set reads as brushed metal, not glass
  vec3 tanZ = vec3(0.0, 0.0, 1.0) - N * N.z;
  float tl = length(tanZ);
  vec3 T = tl > 1e-3 ? tanZ / tl : normalize(cross(N, vec3(1.0, 0.0, 0.0)));
  vec3 Bt = cross(N, T);
  float sw = (fbm(mp * vec2(0.62, 0.71)) - 0.5) * 1.6;
  vec3 Ts = normalize(T * cos(sw) + Bt * sin(sw));
  vec3 Bs = cross(N, Ts);

  vec3 L = uSun;
  vec3 Hv = normalize(L + V);
  float ht = dot(Hv, Ts) / 0.022;
  float hb = dot(Hv, Bs) / 0.30;
  float aniso = exp(-(ht * ht + hb * hb));

  /* Individual scratches, prefiltered by their own footprint: 39 cycles to
     the metre is under two pixels wide at working resolution, which does not
     read as polish but as corduroy over the whole windscreen.  Fading the
     term as its period approaches a pixel is the mip chain it never had.
     Skipped where the star is nowhere near the mirror direction, which is
     most of the pane most of the time. */
  float polish = 0.0;
  if(aniso > 1.0e-4){
    const float SFREQ = 39.0;
    float scr = vn(mp * vec2(SFREQ, 3.75) + sw * 3.0);
    scr = smoothstep(0.56, 1.0, scr);
    scr *= scr * clamp(1.0 - fwidth(mp.x) * SFREQ * 2.4, 0.0, 1.0);
    float band = pow(max(vn(mp * vec2(4.6, 2.1) + 3.7), 0.0), 3.0);
    // weighted to the perimeter: a wiper sweeps the middle and never the corners
    float worn = 0.30 + 1.70 * rim;
    polish = uPolish * (0.03 + (2.4 * scr + 1.0 * band) * worn);
  }

  // the star's own disc, reflected — half a degree wide, authored in real HDR
  // so the bloom has something to find
  float mir = dot(reflect(-V, N), L);
  float disc = smoothstep(0.99900, 0.99986, mir);

  /* The seal: dirt, dried salt and the printed frit border, all of it in the
     last few centimetres and none of it across the middle.  The frit is the
     strongest single cue that a pane is a physical object — every glazed
     panel ever made has a ceramic band screened round its edge to hide the
     adhesive, solid at the rim and dithered out into a dot matrix.  It is
     opaque, so it goes into coverage rather than into colour. */
  float film = 0.0, salt = 0.0, frit = 0.0;
  if(edge < max(0.135, uRim * 0.58)){
    float grit = fbm(mp * 26.0);
    float fringe = 1.0 - smoothstep(0.0, 0.115, edge);
    fringe *= fringe;
    film = uGrime * fringe * (0.24 + 0.76 * grit);
    salt = uGrime * smoothstep(0.60, 0.90, fbm(mp * 38.0 + 11.3))
         * (1.0 - smoothstep(0.0, 0.055, edge));
    const float DFREQ = 78.0;
    float dots = smoothstep(0.38, 0.86, vn(mp * DFREQ + 5.1))
               * clamp(1.0 - fwidth(mp.x) * DFREQ * 2.2, 0.0, 1.0);
    frit = uFrit * clamp((1.0 - smoothstep(uRim * 0.04, uRim * 0.24, edge))
                         + dots * (1.0 - smoothstep(uRim * 0.14, uRim * 0.52, edge)) * 0.85,
                         0.0, 1.0);
  }

  // a scattering layer blazes when the source is behind it and merely glows
  // when the room lights it
  float fwd = pow(clamp(dot(V, -L) * 0.5 + 0.5, 0.0, 1.0), 4.0);
  vec3 dustLit = uSunCol * (0.03 + 0.97 * fwd) * 0.055
               + cabinRoom(N) * uEnvGain * 0.55;

  // the plate seen in its own thickness — rim-gated, not incidence-gated
  float thick = clamp(1.0 / ndv - 1.0, 0.0, 2.0) * rim;

  // the room with parallax and its lamps in it.  An environment sampled by
  // direction alone is constant over a pane whose normal barely changes, and
  // constant is fog.
  vec3 Rv = reflect(-V, N);
  vec3 env = mix(cabinRoom(Rv) * uEnvGain + cabinLamps(vLPos, Rv) * uLamp,
                 spaceSky(Rv, uSun, uSunCol), outside);
  vec3 refl = env * R;

  vec3 spec = refl
            + uSunCol * aniso * polish * uSheen
            + uSunCol * disc * 34.0 * uSheen
            + dustLit * (film * 0.9 + salt * 1.7)
            + uTint * uEnvGain * 0.055 * thick;

  /* Coverage: a small fixed share of the reflectance, tuned so the clean
     centre passes better than 99% of the sky, plus what the glass is actually
     showing — a hot streak hides what is behind it, clean glass does not.
     The seal is opaque and simply counts. */
  float lum = dot(spec, vec3(0.2126, 0.7152, 0.0722));
  float alpha = clamp(R * uCover + lum * uCoverLum
                      + (film + salt) * 0.30 + frit
                      + outside * 0.16, 0.0, 1.0);
  vec3 col = spec * (1.0 - frit * 0.88);
  gl_FragColor = clamp(vec4(col, alpha), 0.0, 32.0);
}`;

/* The lamp table is passed in rather than imported, so a pane can only ever
   reflect the fixtures its OWN ship actually has — see the standing-obligation
   note at the top of this file. */
export function makeCanopyGlass(lamps, o = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG(lamps),
    uniforms: {
      uEye: { value: new THREE.Vector3() },
      uSun: { value: new THREE.Vector3(0, 0.3, -1).normalize() },
      uSunCol: { value: new THREE.Color(0, 0, 0) },
      uTint: { value: new THREE.Color(0.42, 0.72, 0.68) },
      uEnvGain: { value: o.envGain ?? 1.0 },
      uSheen: { value: o.sheen ?? 1.0 },
      /* 0.13 of an 8% reflectance is one part in a hundred of the sky: nothing
         dims the planet dead ahead.  The glass earns its coverage back through
         uCoverLum wherever it is actually showing something. */
      uCover: { value: o.cover ?? 0.13 },
      uCoverLum: { value: o.coverLum ?? 0.55 },
      uCoat: { value: 1.0 },
      uGrime: { value: o.grime ?? 1.0 },
      uPolish: { value: o.polish ?? 1.0 },
      uLamp: { value: o.lamp ?? 1.3 },
      uRim: { value: o.rim ?? 0.30 },
      uFrit: { value: o.frit ?? 1.0 },
      uSpan: { value: new THREE.Vector2(o.spanU ?? 5.0, o.spanV ?? 2.4) },
      uArc: { value: ARC.clone() },
    },
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

const _inv = new THREE.Matrix4();
const _v = new THREE.Vector3();

/**
 * Feed a pane the eye and the star, from inside the render, in the mesh's own
 * local frame.
 *
 * A pane must not cast: three derives a depth material that ignores opacity
 * entirely, so a transparent sheet writes a SOLID silhouette into the shadow
 * map and the windscreen throws a shadow across the console.
 */
export function bindGlass(mesh, mat) {
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.onBeforeRender = (_r, scene, camera) => {
    const u = mat.uniforms;
    _inv.copy(mesh.matrixWorld).invert();
    u.uEye.value.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(_inv);
    let sun = mesh.userData._sun;
    if (sun === undefined) {
      sun = null;
      /* Prefer the light flagged as the ship's own key light; fall back to
         the first DirectionalLight found (the source project's behaviour,
         where only one exists). */
      scene.traverse((o) => {
        if (sun || !o.isDirectionalLight) return;
        if (sun === null && o.userData?.shipSun) sun = o;
      });
      if (!sun) {
        scene.traverse((o) => { if (!sun && o.isDirectionalLight) sun = o; });
      }
      mesh.userData._sun = sun;
    }
    if (sun) {
      /* direction only, so the inverse is applied without translation */
      _v.copy(sun.position).sub(sun.target.position).normalize();
      u.uSun.value.copy(_v).transformDirection(_inv).normalize();
      u.uSunCol.value.copy(sun.color).multiplyScalar(sun.intensity);
    }
  };
  return mesh;
}
