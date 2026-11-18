// Saltline material library: 27 procedural texture sets (concrete, paint,
// galvanised/bare/rusted steel, gun finishes, polymer, fabric, wood, rubber,
// glass…) baked on the GPU at first use into albedo / ORM / normal maps, and
// ~50 named materials on top of them. One shared onBeforeCompile patch adds
// triplanar mapping, macro variation, grime and rain wetness (darker, glossier
// up-facing faces, streaks on verticals, beads). No image files.
//
// Produced by
//   node tools/saltline/extract.mjs Gg --stop sa --effects Tn --rename tools/saltline/maps/materials.json
// (`async` dropped from the factory: it never awaited). Shader and recipe code
// is kept as generated. See docs/saltline-reuse.md.
//
//   const mats = createSaltlineMaterials({ renderer, params: { tex: 1024, wet: 0 } });
//   mats.get('paint_orange', { triplanar, vertexColors, scale, doubleSide, interior, color })
//   mats.uniforms.wet.value = 0..1   // global rain wetness for every material
//   mats.names                        // every material name
import * as THREE from 'three';
var BAKE_VERT = `
in vec3 position; out vec2 vUv;
void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`, BAKE_FRAG_HEAD = `
precision highp float; precision highp int;
uniform vec4 uP; uniform float uSeed; uniform float uTexel;
in vec2 vUv;
layout(location=0) out vec4 o0; layout(location=1) out vec4 o1; layout(location=2) out vec4 o2;
#define TAU 6.28318530718
#define sat(x) clamp(x, 0.0, 1.0)
#define OV(D, k) { float k_ = sat(k); nt = mix(nt, D, k_); ta = mix(ta, 0.0, k_); }
vec3 L(float r, float g, float b){ return pow(vec3(r, g, b), vec3(2.2)); }
uvec3 pcg3(uvec3 v){ v = v * 1664525u + 1013904223u; v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y; v ^= v >> 16u; v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y; return v; }
vec3 h3(vec2 c, vec2 per, float s){ c = mod(c, per); return vec3(pcg3(uvec3(uint(c.x + 0.5), uint(c.y + 0.5), uint(s + uSeed)))) * (1.0 / 4294967296.0); }
float gn(vec2 p, vec2 per, float s){
  vec2 i = floor(p), f = p - i; vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(h3(i, per, s).xy * 2.0 - 1.0, f);
  float b = dot(h3(i + vec2(1.0, 0.0), per, s).xy * 2.0 - 1.0, f - vec2(1.0, 0.0));
  float c = dot(h3(i + vec2(0.0, 1.0), per, s).xy * 2.0 - 1.0, f - vec2(0.0, 1.0));
  float d = dot(h3(i + vec2(1.0, 1.0), per, s).xy * 2.0 - 1.0, f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
// fractal noise, ~0..1 centred on 0.5 (std ~0.18)
float fbm(vec2 uv, vec2 f, int oct, float s){
  float a = 0.5, v = 0.0, t = 0.0;
  for (int i = 0; i < oct; i++){ v += a * gn(uv * f, f, s + float(i) * 7.0); t += a; a *= 0.5; f *= 2.0; }
  return sat(v / t * 1.8 + 0.5);
}
// voronoi: x = F1, y = F2, z = cell random, w = second cell random
vec4 vor(vec2 p, vec2 per, float s){
  vec2 i = floor(p), f = p - i; float d1 = 9.0, d2 = 9.0; vec2 id = vec2(0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
    vec2 o = vec2(float(x), float(y)); vec3 r = h3(i + o, per, s); vec2 d = o + r.xy - f; float dd = dot(d, d);
    if (dd < d1){ d2 = d1; d1 = dd; id = vec2(r.z, fract(r.z * 37.0 + r.x * 11.0)); } else if (dd < d2) d2 = dd;
  }
  return vec4(sqrt(d1), sqrt(d2), id);
}
// scattered straight scratches: f cells per tile, w half-width (cells), base angle + spread, density 0..1
float scr(vec2 uv, float f, float s, float w, float ang, float spread, float dens){
  vec2 p = uv * f; vec2 i = floor(p); vec2 fr = p - i; float m = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
    vec2 o = vec2(float(x), float(y)); vec3 r = h3(i + o, vec2(f), s); vec3 r2 = h3(i + o, vec2(f), s + 31.0);
    vec2 c = o + r.xy - fr; float a = ang + (r.z - 0.5) * spread; vec2 dir = vec2(cos(a), sin(a));
    float al = dot(c, dir), ac = dot(c, vec2(-dir.y, dir.x)); float len = 0.15 + r2.x * 0.8;
    m = max(m, smoothstep(w, w * 0.3, abs(ac)) * smoothstep(len, len * 0.7, abs(al)) * step(r2.y, dens) * (0.35 + 0.65 * r2.z));
  }
  return m;
}
void emit(vec3 c, float a, float h, float ao, float r, float m){
  o0 = vec4(sqrt(clamp(c, 0.0, 1.0)), sat(a));
  o1 = vec4(sat(ao), clamp(r, 0.03, 1.0), sat(m), 1.0);
  float hh = sat(h) * 255.0; float fl = floor(hh); o2 = vec4(fl / 255.0, hh - fl, 0.0, 1.0);
}
// soft, grainy rust patch mask: f = patch frequency, th = threshold (higher = rarer)
float rustMask(vec2 uv, vec2 f, float th, float s){
  float n = fbm(uv, f, 5, s), g = fbm(uv, f * 14.0, 3, s + 50.0);
  return smoothstep(th, th + 0.14, n + (g - 0.5) * 0.3) * (0.5 + 0.5 * g);
}
// ---- shared paint damage model ----
float chipsF(vec2 uv, vec2 f, float s, float dens, float rmax){
  vec4 v = vor(uv * f, f, s); float e = fbm(uv, f * 3.0, 3, s + 3.0) - 0.5; float r = rmax * (0.25 + 0.75 * v.w);
  return step(v.z, dens) * smoothstep(r, r * 0.55, v.x + e * 0.6);
}
// chip: 0 = intact paint .. 1 = through to substrate; stain: thin oxide halo; run: rust run below damage (-V is down)
void paintDmg(vec2 uv, float amt, out float chip, out float stain, out float run){
  float wearN = fbm(uv, vec2(3.0), 6, 21.0);
  float zone = smoothstep(0.58, 0.82, fbm(uv, vec2(2.0), 3, 22.0));      // damage clusters; most of the panel is clean
  float dn = (0.012 + 0.085 * zone) * (0.5 + amt);
  float c1 = chipsF(uv, vec2(20.0, 11.0), 23.0, dn, 0.24);                // vertically stretched flakes
  float c2 = chipsF(uv, vec2(64.0, 40.0), 24.0, dn * 1.6, 0.34);
  float th = 0.925 - 0.06 * amt;
  float c3 = smoothstep(th, th + 0.03, wearN + (fbm(uv, vec2(40.0), 3, 25.0) - 0.5) * 0.12);
  float s1 = scr(uv, 5.0, 26.0, 0.0035, 0.0, 0.4, 0.2 + 0.25 * amt);
  float s2 = scr(uv, 16.0, 27.0, 0.009, 1.57, 0.5, 0.12 + 0.2 * amt);
  float sbreak = smoothstep(0.4, 0.65, fbm(uv, vec2(50.0), 2, 28.0));
  chip = sat(max(max(c1, c2), max(c3, max(s1, s2) * sbreak)));
  vec4 v = vor(uv * vec2(20.0, 11.0), vec2(20.0, 11.0), 23.0);
  float b1 = step(v.z, dn) * smoothstep(0.42, 0.14, v.x) * (0.3 + 0.7 * v.w);
  float bn = fbm(uv, vec2(36.0), 4, 29.0);
  stain = sat(max(b1 * smoothstep(0.4, 0.7, bn) * 0.8, smoothstep(th - 0.03, th + 0.02, wearN) * smoothstep(0.4, 0.7, bn) * 0.7));
  float streak = fbm(uv, vec2(120.0, 1.0), 3, 30.0);
  float rr = 0.0;
  for (int i = 1; i <= 4; i++){
    vec2 q = uv + vec2(0.0, float(i) * 0.034);
    float src = max(chipsF(q, vec2(20.0, 11.0), 23.0, dn, 0.24), smoothstep(th, th + 0.03, fbm(q, vec2(3.0), 6, 21.0)));
    rr = max(rr, src * (1.0 - float(i) / 5.0));
  }
  run = rr * smoothstep(0.5, 0.78, streak);
}
`, BAKE_FRAG_TAIL = `
void main(){ surf(vUv); }`, SET_SHADERS = {};
SET_SHADERS.asphalt = `
void surf(vec2 uv){
  vec4 a = vor(uv * 110.0, vec2(110.0), 1.0);
  vec4 b = vor(uv * 230.0 + 3.0, vec2(230.0), 2.0);
  float big = fbm(uv, vec2(3.0), 4, 5.0), mid = fbm(uv, vec2(24.0), 4, 6.0), fine = fbm(uv, vec2(300.0), 2, 7.0);
  float jag = fbm(uv, vec2(420.0), 2, 8.0) - 0.5;
  float sa = smoothstep(0.46, 0.3, a.x + jag * 0.3 - (a.y - a.x) * 0.2 + (1.0 - a.w) * 0.12) * step(a.z, 0.62);
  float sb = smoothstep(0.46, 0.3, b.x + jag * 0.2 + (1.0 - b.w) * 0.15) * step(b.z, 0.85);
  float h = max(sa * (0.45 + 0.55 * a.w), sb * 0.5 * (0.5 + 0.5 * b.w));
  h = h * 0.6 + fine * 0.3 + mid * 0.1;
  float wearK = smoothstep(0.3, 0.7, big);
  float stone = sat(max(sa, sb * 0.8));
  vec3 stA = mix(L(0.28, 0.28, 0.29), L(0.45, 0.43, 0.41), a.w); stA = mix(stA, L(0.42, 0.35, 0.28), step(0.9, a.z * 0.5 + a.w * 0.6));
  vec3 stB = mix(L(0.26, 0.26, 0.28), L(0.44, 0.43, 0.42), b.w);
  vec3 col = L(0.13, 0.13, 0.135) * (0.8 + 0.4 * mid);
  col = mix(col, stB, sb * 0.7 * (0.45 + 0.55 * wearK));
  col = mix(col, stA, sa * (0.5 + 0.45 * wearK));
  col *= 0.8 + 0.4 * big;
  float cn = fbm(uv + vec2(0.13, 0.4), vec2(2.0), 3, 9.0);
  float band = smoothstep(0.016, 0.009, abs(cn - 0.5) + (fbm(uv, vec2(70.0), 2, 13.0) - 0.5) * 0.008) * smoothstep(0.4, 0.6, fbm(uv, vec2(2.0), 2, 12.0));
  col = mix(col, L(0.075, 0.075, 0.08), band * 0.93);
  h = mix(h, 0.74 + fine * 0.05 + sa * 0.04, band * 0.88);
  float r = mix(0.93, 0.74, stone * (0.4 + 0.6 * wearK)); r = mix(r, 0.36, band);
  float oil = smoothstep(0.72, 0.86, fbm(uv + 0.5, vec2(5.0), 4, 14.0)); col *= 1.0 - oil * 0.45; r = mix(r, 0.5, oil * 0.6);
  emit(col, 1.0, h, mix(0.55, 1.0, smoothstep(0.0, 0.6, h)), r, 0.0);
}`;
SET_SHADERS.concrete = `
void surf(vec2 uv){
  float big = fbm(uv, vec2(2.0), 5, 1.0), mid = fbm(uv, vec2(12.0), 5, 2.0), fine = fbm(uv, vec2(180.0), 3, 3.0);
  float form = fbm(uv, vec2(2.0, 7.0), 5, 4.0);
  vec4 po = vor(uv * 70.0, vec2(70.0), 5.0); float pore = step(po.z, 0.35) * smoothstep(0.16 * po.w + 0.03, 0.02, po.x);
  vec4 po2 = vor(uv * 260.0, vec2(260.0), 6.0); float pore2 = step(po2.z, 0.5) * smoothstep(0.3 * po2.w, 0.05, po2.x);
  vec2 wu = uv + (vec2(fbm(uv, vec2(6.0), 3, 7.0), fbm(uv, vec2(6.0), 3, 8.0)) - 0.5) * 0.12 + (vec2(fbm(uv, vec2(48.0), 3, 17.0), fbm(uv, vec2(48.0), 3, 18.0)) - 0.5) * 0.022;
  vec4 cr = vor(wu * 3.0, vec2(3.0), 9.0);
  float crack = smoothstep(0.0045, 0.0012, cr.y - cr.x) * smoothstep(0.45, 0.6, fbm(uv, vec2(3.0), 2, 10.0));
  float chip = smoothstep(0.83, 0.87, fbm(uv, vec2(7.0), 4, 11.0) + (fine - 0.5) * 0.08 + (mid - 0.5) * 0.06);
  vec4 ag = vor(uv * 140.0, vec2(140.0), 12.0); float stone = smoothstep(0.5, 0.3, ag.x) * step(ag.z, 0.6);
  vec2 dj = min(uv, 1.0 - uv); float jd = min(dj.x, dj.y);
  float joint = smoothstep(0.0022, 0.0012, jd), jstain = smoothstep(0.07, 0.0, jd + (mid - 0.5) * 0.04);
  float h = 0.6 + (mid - 0.5) * 0.25 + (fine - 0.5) * 0.12 + (form - 0.5) * 0.06;
  h -= pore * 0.35 + pore2 * 0.08 + crack * 0.2; h = mix(h, 0.42 + stone * 0.12 + fine * 0.08, chip); h = mix(h, 0.05, joint);
  vec3 col = L(0.53, 0.52, 0.49) * (0.72 + 0.4 * big + 0.22 * (mid - 0.5) + 0.08 * (form - 0.5));
  col *= mix(vec3(1.04, 1.0, 0.94), vec3(0.95, 1.0, 1.05), fbm(uv, vec2(3.0), 3, 13.0));
  float st = smoothstep(0.55, 0.8, fbm(uv, vec2(4.0), 5, 14.0)); col *= 1.0 - st * 0.3;
  float ef = smoothstep(0.66, 0.85, fbm(uv, vec2(5.0), 4, 15.0)) * sat(fine * 1.6 - 0.2); col = mix(col, L(0.68, 0.67, 0.64), ef * 0.22);
  col *= 1.0 - pore * 0.5 - pore2 * 0.2 - crack * 0.6;
  vec3 agc = mix(L(0.38, 0.37, 0.35), L(0.54, 0.52, 0.47), ag.w); agc = mix(agc, L(0.46, 0.41, 0.34), step(0.45, ag.z));
  col = mix(col, mix(L(0.4, 0.39, 0.37) * (0.8 + 0.4 * fine), agc, stone * 0.8), chip);
  col *= 1.0 - jstain * 0.25; col = mix(col, L(0.1, 0.1, 0.1), joint);
  float r = 0.82 + (mid - 0.5) * 0.2 - (form - 0.5) * 0.15; r = mix(r, 0.95, chip); r = mix(r, 0.62, st * 0.3);
  float ao = 1.0 - pore * 0.5 - crack * 0.5 - joint * 0.6 - chip * 0.15;
  float pa = smoothstep(0.40, 0.47, fbm(uv, vec2(9.0), 5, 16.0) + (mid - 0.5) * 0.2) * (1.0 - chip) * (1.0 - crack) * (1.0 - pore);
  emit(col, pa, h, ao, r, 0.0);
}`;
SET_SHADERS.brick = `
void surf(vec2 uv){
  float rows = 24.0, cols = 8.0; float y = uv.y * rows; float row = floor(y); float x = uv.x * cols + 0.5 * mod(row, 2.0); float cl = floor(x);
  vec2 f = vec2(fract(x), fract(y)); vec3 id = h3(vec2(cl, row), vec2(cols, rows), 1.0);
  float ed = fbm(uv, vec2(60.0), 3, 2.0);
  vec2 d = min(f, 1.0 - f) * vec2(225.0, 75.0);
  float mort = 5.0 + (ed - 0.5) * 5.0; float dm = min(d.x, d.y); float brick = smoothstep(mort, mort + 3.0, dm);
  float fine = fbm(uv, vec2(200.0), 3, 3.0), mid = fbm(uv, vec2(30.0), 4, 4.0);
  vec3 c = mix(L(0.52, 0.27, 0.2), L(0.42, 0.2, 0.15), id.x); c = mix(c, L(0.3, 0.17, 0.15), smoothstep(0.75, 1.0, id.y)); c = mix(c, L(0.58, 0.38, 0.26), smoothstep(0.85, 1.0, id.z));
  c *= (0.8 + 0.4 * mid) * (0.9 + 0.2 * fine);
  float pit = smoothstep(0.7, 0.8, fbm(uv, vec2(90.0), 3, 5.0)); c *= 1.0 - pit * 0.35;
  vec3 mc = L(0.5, 0.48, 0.44) * (0.75 + 0.5 * fine);
  float soot = smoothstep(0.5, 0.8, fbm(uv, vec2(3.0), 4, 6.0));
  vec3 col = mix(mc, c, brick) * (1.0 - soot * 0.35);
  float ef = smoothstep(0.7, 0.85, fbm(uv, vec2(5.0), 4, 7.0)) * brick; col = mix(col, L(0.7, 0.68, 0.64), ef * 0.3);
  float h = mix(0.25 + fine * 0.1, 0.7 + (mid - 0.5) * 0.15 + (fine - 0.5) * 0.1 - pit * 0.2 + (id.x - 0.5) * 0.12, brick);
  emit(col, 1.0, h, mix(0.6, 1.0, brick) * (1.0 - pit * 0.3), mix(0.95, 0.86 + (mid - 0.5) * 0.15, brick), 0.0);
}`;
SET_SHADERS.epoxy = `
void surf(vec2 uv){
  float big = fbm(uv, vec2(3.0), 5, 1.0), mid = fbm(uv, vec2(20.0), 4, 2.0), fine = fbm(uv, vec2(250.0), 2, 3.0), mott = fbm(uv, vec2(9.0), 5, 11.0);
  vec3 col = L(0.41, 0.445, 0.435) * (0.78 + 0.3 * big + 0.22 * (mott - 0.5));
  col *= mix(vec3(1.03, 1.0, 0.97), vec3(0.95, 1.0, 1.03), fbm(uv, vec2(2.0), 3, 19.0));
  vec4 ag = vor(uv * 180.0, vec2(180.0), 12.0); col *= 1.0 + (ag.w - 0.5) * 0.14 * smoothstep(0.5, 0.2, ag.x);
  float gloss = smoothstep(0.35, 0.62, fbm(uv, vec2(5.0), 5, 4.0));          // sealer still intact
  float lane = smoothstep(0.35, 0.65, fbm(uv, vec2(1.0, 3.0), 3, 13.0));     // traffic lanes worn matt
  float worn = sat(1.0 - gloss * 0.85 + lane * 0.45 - 0.15);
  float sc1 = scr(uv, 14.0, 5.0, 0.012, 0.5, 6.3, 0.7), sc2 = scr(uv, 40.0, 6.0, 0.02, 0.0, 6.3, 0.5);
  float t1 = abs(uv.y - 0.31 - 0.06 * sin(uv.x * TAU)), t2 = abs(uv.x - 0.62 - 0.09 * sin(uv.y * TAU + 1.0));
  float t3 = abs(uv.y - 0.74 - 0.1 * sin(uv.x * TAU * 2.0 + 2.0)), t4 = abs(uv.x - 0.2 - 0.05 * sin(uv.y * TAU + 4.0));
  float tread = 0.6 + 0.4 * sin((uv.x + uv.y) * TAU * 90.0);
  float tm = smoothstep(0.022, 0.016, t1) * smoothstep(0.35, 0.6, fbm(uv, vec2(8.0), 3, 7.0)) + smoothstep(0.02, 0.014, t2) * smoothstep(0.4, 0.65, fbm(uv, vec2(6.0), 3, 8.0))
           + smoothstep(0.026, 0.018, t3) * smoothstep(0.45, 0.7, fbm(uv, vec2(5.0), 3, 14.0)) + smoothstep(0.018, 0.012, t4) * smoothstep(0.4, 0.65, fbm(uv, vec2(7.0), 3, 15.0));
  tm = sat(tm * tread);
  col = mix(col, L(0.1, 0.1, 0.105), tm * 0.75);
  col *= 1.0 - worn * 0.1; col = mix(col, col * 1.25, sc1 * 0.4);
  float dirt = smoothstep(0.55, 0.85, fbm(uv, vec2(2.0), 4, 9.0)); col = mix(col, L(0.3, 0.29, 0.26), dirt * 0.3);
  float r = mix(0.1, 0.52, worn) + sc1 * 0.2 + sc2 * 0.15 + tm * 0.3 + dirt * 0.2 + (mid - 0.5) * 0.12 + (mott - 0.5) * 0.1;
  float h = 0.5 + (fine - 0.5) * 0.05 + (mid - 0.5) * 0.06 - sc1 * 0.2 - sc2 * 0.08 + tm * 0.05 + (gloss - 0.5) * 0.03;
  float chip = smoothstep(0.87, 0.9, fbm(uv, vec2(14.0), 5, 10.0) + (fine - 0.5) * 0.06); col = mix(col, L(0.44, 0.44, 0.43) * (0.75 + 0.5 * fine), chip); h -= chip * 0.3; r = mix(r, 0.85, chip);
  emit(col, 1.0, h, 1.0 - chip * 0.2, r, 0.0);
}`;
var n3 = `
  float fine = fbm(uv, vec2(260.0), 2, 1.0), mid = fbm(uv, vec2(16.0), 4, 2.0), big = fbm(uv, vec2(2.0), 4, 3.0);
  float chalk = smoothstep(0.3, 0.8, fbm(uv, vec2(1.0, 2.0), 4, 4.0));
  float dirt = smoothstep(0.42, 0.85, fbm(uv, vec2(3.0, 2.0), 5, 5.0));
  float vs1 = fbm(uv, vec2(70.0, 1.0), 3, 6.0), vs2 = fbm(uv, vec2(22.0, 1.0), 3, 16.0), vs3 = fbm(uv, vec2(9.0, 2.0), 3, 17.0);
  float steel = smoothstep(0.55, 0.8, chip);
  float primer = smoothstep(0.15, 0.4, chip) * (1.0 - steel);
  float rustN = fbm(uv, vec2(60.0), 4, 7.0);
  float fresh = steel * smoothstep(0.78, 0.86, fbm(uv, vec2(25.0), 3, 8.0));
  vec3 rustC = mix(L(0.2, 0.135, 0.105), L(0.36, 0.23, 0.15), rustN);
  rustC = mix(rustC, L(0.5, 0.33, 0.18), smoothstep(0.7, 0.95, fbm(uv, vec2(120.0), 2, 9.0)) * 0.5);
  vec3 nt = vec3(0.0); float ta = shade * (0.9 + 0.2 * (mid - 0.5) + 0.2 * (big - 0.5));
  // dirt film: broad grime + fine and broad vertical wash streaks
  float df = sat(dirt * 0.3 + smoothstep(0.55, 0.85, vs1) * 0.3 * (0.4 + dirt) + smoothstep(0.55, 0.8, vs2) * 0.38 * (0.3 + dirt) + smoothstep(0.5, 0.8, vs3) * 0.2);
  float clean = smoothstep(0.6, 0.85, 1.0 - vs2) * 0.5;            // rain-washed lighter streaks
  float rs = sat(stain * 0.7 + run * 0.85);
  ta *= 1.0 + clean * 0.08 - chalk * 0.06;
  OV(vec3(0.72), chalk * 0.075 + clean * 0.02);
  OV(L(0.24, 0.22, 0.19), df * 0.42);
  OV(mix(L(0.3, 0.2, 0.14), L(0.44, 0.28, 0.16), rustN), rs * 0.5);
  OV(mix(L(0.5, 0.25, 0.2), L(0.55, 0.54, 0.5), 0.35), primer);
  OV(rustC, steel);
  OV(L(0.55, 0.55, 0.57), fresh);
  float h = 0.62 + (fine - 0.5) * 0.05 + (mid - 0.5) * 0.04;
  h = mix(h, 0.5, primer); h = mix(h, 0.36 + rustN * 0.14, steel); h += rs * 0.02 * rustN;
  float r = baseR + chalk * 0.26 + df * 0.3 - clean * 0.06 + (mid - 0.5) * 0.14 + (big - 0.5) * 0.1; r = mix(r, 0.75, primer); r = mix(r, 0.92, steel); r = mix(r, 0.35, fresh); r = mix(r, 0.72, rs * 0.6);
  float m = fresh * 0.95 + (steel - fresh) * 0.15;
  float ao = 1.0 - steel * 0.25 - primer * 0.1;
`;
SET_SHADERS.paint = `
void surf(vec2 uv){
  float chip, stain, run; paintDmg(uv, uP.x, chip, stain, run);
  float shade = 0.8, baseR = 0.40;
  ${n3}
  emit(nt, ta, h, ao, r, m);
}`;
SET_SHADERS.hazard = `
void surf(vec2 uv){
  float chip, stain, run; paintDmg(uv, 1.4, chip, stain, run);
  float shade = 1.0, baseR = 0.5;
  ${n3}
  float s = fract((uv.x + uv.y) * 5.0);
  float yel = smoothstep(0.244, 0.256, abs(s - 0.5) + (fbm(uv, vec2(80.0), 2, 41.0) - 0.5) * 0.02);
  vec3 pc = mix(L(0.1, 0.1, 0.11), L(0.86, 0.66, 0.1), yel);
  emit(nt + pc * ta, 1.0, h, ao, r, m);
}`;
SET_SHADERS.hull = `
void surf(vec2 uv){
  float ry = uv.y * 2.0; float row = floor(ry); float fy = fract(ry); float sx = fract(uv.x + 0.5 * mod(row, 2.0));
  float dh = min(fy, 1.0 - fy) * 2.0, dv = min(sx, 1.0 - sx) * 4.0; float dseam = min(dh, dv);
  float wn = fbm(uv, vec2(200.0), 2, 1.0);
  float bead = smoothstep(0.012, 0.004, dseam + (wn - 0.5) * 0.004);
  float ripple = 0.75 + 0.25 * sin((uv.x + uv.y) * TAU * 400.0);
  float dish = cos(uv.x * TAU * 8.0) * 0.5 + 0.5;
  float big = fbm(uv, vec2(2.0), 4, 2.0), mid = fbm(uv, vec2(14.0), 4, 3.0), fine = fbm(uv, vec2(220.0), 2, 4.0);
  float roller = fbm(uv, vec2(120.0, 30.0), 3, 5.0);
  float seamK = smoothstep(0.12, 0.0, dseam);
  float pit = fbm(uv, vec2(70.0), 4, 7.0);
  float rust = smoothstep(0.72, 0.79, fbm(uv, vec2(10.0), 5, 6.0) + seamK * 0.2);
  rust *= smoothstep(0.3, 0.5, pit + rust * 0.3);
  float streak = fbm(uv, vec2(110.0, 1.0), 3, 8.0);
  float wp = 0.0;
  for (int i = 1; i <= 4; i++){
    vec2 q = uv + vec2(0.0, float(i) * 0.03); float qy = fract(q.y * 2.0);
    float qs = smoothstep(0.02, 0.0, min(qy, 1.0 - qy) * 2.0); float qr = smoothstep(0.72, 0.79, fbm(q, vec2(10.0), 5, 6.0));
    wp = max(wp, max(qs * 0.7, qr) * (1.0 - float(i) / 5.0));
  }
  float weep = wp * smoothstep(0.4, 0.75, streak);
  float salt = smoothstep(0.6, 0.85, fbm(uv, vec2(3.0, 9.0), 4, 9.0));
  vec3 nt = vec3(0.0); float ta = 0.82 * (0.88 + 0.2 * (big - 0.5) + 0.14 * (mid - 0.5) + 0.08 * (roller - 0.5));
  OV(vec3(0.6), salt * 0.025 * (0.5 + roller));
  OV(L(0.45, 0.27, 0.14), weep * 0.7);
  OV(mix(L(0.25, 0.16, 0.11), L(0.5, 0.31, 0.17), pit), rust);
  float h = 0.5 + (roller - 0.5) * 0.05 + (fine - 0.5) * 0.03 + bead * 0.35 * ripple + (dish - 0.5) * 0.1 - rust * 0.08 * (1.0 - pit);
  float r = 0.5 + (mid - 0.5) * 0.15 + salt * 0.2; r = mix(r, 0.9, rust); r = mix(r, 0.7, weep * 0.5);
  emit(nt, ta, h, 1.0 - rust * 0.2 - smoothstep(0.03, 0.012, dseam) * (1.0 - bead) * 0.3, r, rust * 0.1);
}`;
SET_SHADERS.galv = `
void surf(vec2 uv){
  vec2 wu = uv + (vec2(fbm(uv, vec2(8.0), 2, 1.0), fbm(uv, vec2(8.0), 2, 2.0)) - 0.5) * 0.03;
  vec4 a = vor(wu * 22.0, vec2(22.0), 3.0); vec4 b = vor(wu * 50.0 + 1.5, vec2(50.0), 4.0);
  float sp = mix(a.w, b.w, 0.35);
  float edge = smoothstep(0.0, 0.08, a.y - a.x);
  float big = fbm(uv, vec2(2.0), 4, 5.0), fine = fbm(uv, vec2(200.0), 2, 6.0), mid = fbm(uv, vec2(20.0), 4, 7.0);
  vec3 col = vec3(0.56, 0.58, 0.6) * (0.72 + 0.4 * sp) * (0.92 + 0.16 * big);
  float wr = smoothstep(0.55, 0.85, fbm(uv, vec2(6.0), 5, 8.0)) * (0.4 + 0.6 * fbm(uv, vec2(90.0), 3, 10.0));
  col = mix(col, L(0.74, 0.74, 0.72), wr * 0.4);
  float rs = rustMask(uv, vec2(9.0), 0.8, 9.0);
  col = mix(col, L(0.42, 0.27, 0.16) * (0.7 + 0.6 * fine), rs);
  float r = 0.3 + 0.28 * sp + (mid - 0.5) * 0.15 + wr * 0.3; r = mix(r, 0.9, rs);
  float h = 0.5 + (sp - 0.5) * 0.08 * edge + (fine - 0.5) * 0.04 + wr * 0.05 * fine - (1.0 - edge) * 0.03;
  emit(col, 1.0, h, 1.0, r, 1.0 - wr * 0.45 - rs * 0.9);
}`;
SET_SHADERS.metal = `
void surf(vec2 uv){
  float big = fbm(uv, vec2(2.0), 5, 1.0), mid = fbm(uv, vec2(18.0), 4, 2.0), fine = fbm(uv, vec2(240.0), 2, 3.0);
  float smudge = fbm(uv, vec2(5.0, 7.0), 5, 4.0);
  float s1 = scr(uv, 9.0, 5.0, 0.006, 0.2, 6.3, 0.6), s2 = scr(uv, 30.0, 6.0, 0.012, 1.0, 6.3, 0.5), s3 = scr(uv, 70.0, 7.0, 0.03, 2.0, 6.3, 0.4);
  float sc = sat(max(s1, max(s2 * 0.8, s3 * 0.5)));
  float rust = rustMask(uv, vec2(12.0), 0.74, 8.0) * uP.x;
  float scale_ = smoothstep(0.4, 0.7, fbm(uv, vec2(7.0), 4, 10.0));
  vec3 nt = vec3(0.0); float ta = 0.95 * (0.85 + 0.2 * (big - 0.5) + 0.16 * (mid - 0.5)) * (1.0 - scale_ * 0.18);
  OV(vec3(0.55, 0.56, 0.58), sc * 0.3);
  OV(mix(L(0.27, 0.17, 0.12), L(0.5, 0.31, 0.17), fbm(uv, vec2(90.0), 3, 11.0)), rust);
  float r = 0.42 + (smudge - 0.5) * 0.3 + (mid - 0.5) * 0.1 - sc * 0.15 + scale_ * 0.08; r = mix(r, 0.9, rust);
  float h = 0.5 + (fine - 0.5) * 0.04 + (mid - 0.5) * 0.04 - sc * 0.12 + rust * 0.08 * fine;
  emit(nt, ta, h, 1.0 - rust * 0.2, r, 1.0 - rust * 0.85);
}`;
SET_SHADERS.brushed = `
void surf(vec2 uv){
  float l1 = fbm(uv, vec2(2.0, 300.0), 3, 1.0), l2 = fbm(uv, vec2(6.0, 120.0), 3, 2.0), l3 = fbm(uv, vec2(1.0, 500.0), 2, 12.0);
  float big = fbm(uv, vec2(3.0), 4, 3.0), smudge = fbm(uv, vec2(6.0), 5, 4.0);
  float sc = scr(uv, 12.0, 5.0, 0.008, 0.6, 6.3, 0.4);
  float tar = smoothstep(0.45, 0.9, fbm(uv, vec2(5.0), 5, 6.0));
  vec3 nt = vec3(0.0); float ta = 0.95 * (0.82 + 0.16 * (l1 - 0.5) + 0.14 * (l2 - 0.5) + 0.1 * (big - 0.5)) * (1.0 - tar * 0.13);
  OV(vec3(0.7), sc * 0.2);
  float r = 0.3 + (l1 - 0.5) * 0.2 + (smudge - 0.5) * 0.2 + tar * 0.18 - sc * 0.08;
  float h = 0.5 + (l1 - 0.5) * 0.2 + (l3 - 0.5) * 0.2 + (l2 - 0.5) * 0.1 - sc * 0.2;
  emit(nt, ta, h, 1.0, r, 1.0);
}`;
SET_SHADERS.rust = `
void surf(vec2 uv){
  vec2 wu = uv + (vec2(fbm(uv, vec2(5.0), 3, 1.0), fbm(uv, vec2(5.0), 3, 2.0)) - 0.5) * 0.08;
  float n = fbm(wu, vec2(6.0), 7, 3.0);
  float fl = fbm(wu, vec2(11.0), 6, 4.0);
  float tf = fract(fl * 4.0); float layer = floor(fl * 4.0) / 4.0 + smoothstep(0.0, 0.45, tf) * 0.25;
  float flakeEdge = smoothstep(0.1, 0.0, tf) * smoothstep(0.4, 0.6, fbm(uv, vec2(9.0), 3, 14.0));
  vec4 pv = vor(uv * 70.0, vec2(70.0), 5.0); float pit = step(pv.z, 0.5) * smoothstep(0.35 * pv.w + 0.05, 0.03, pv.x);
  vec4 pv2 = vor(uv * 190.0, vec2(190.0), 15.0); float speck = smoothstep(0.35, 0.1, pv2.x) * step(pv2.z, 0.4);
  float grain = fbm(uv, vec2(220.0), 3, 6.0);
  float scaleI = smoothstep(0.75, 0.8, fbm(wu, vec2(4.0), 5, 7.0) + (grain - 0.5) * 0.1);
  float h = 0.25 + layer * 0.4 + (n - 0.5) * 0.3 + (grain - 0.5) * 0.14 - pit * 0.2 + speck * 0.04;
  h = mix(h, 0.8 + (grain - 0.5) * 0.04, scaleI);
  float t = sat(layer * 0.5 + n * 0.55 + (grain - 0.5) * 0.35);
  vec3 c = mix(L(0.26, 0.17, 0.13), L(0.4, 0.25, 0.16), smoothstep(0.25, 0.6, t));
  float bloom = smoothstep(0.55, 0.85, fbm(uv, vec2(7.0), 5, 8.0));
  c = mix(c, L(0.55, 0.34, 0.17), bloom * (0.35 + 0.65 * smoothstep(0.4, 0.7, t)));
  c = mix(c, L(0.62, 0.45, 0.25), smoothstep(0.7, 0.95, fbm(uv, vec2(34.0), 4, 18.0)) * 0.4);
  c = mix(c, L(0.2, 0.14, 0.12), sat(flakeEdge * 0.6 + pit * 0.7));
  c *= (0.8 + 0.4 * grain) * (0.9 + 0.2 * speck);
  float streak = fbm(uv, vec2(60.0, 2.0), 3, 9.0); c = mix(c, L(0.5, 0.31, 0.17), smoothstep(0.55, 0.8, streak) * 0.2);
  c = mix(c, L(0.3, 0.3, 0.33) * (0.8 + 0.4 * grain), scaleI);
  float r = 0.9 + (grain - 0.5) * 0.15 - bloom * 0.06; r = mix(r, 0.55, scaleI);
  emit(c, 1.0, h, 1.0 - pit * 0.4 - flakeEdge * 0.25, r, scaleI * 0.35);
}`;
SET_SHADERS.diamond = `
void surf(vec2 uv){
  vec2 p = uv * 12.0; vec2 i = floor(p); vec2 q = fract(p) - 0.5; float par = mod(i.x + i.y, 2.0);
  vec2 d = (par < 0.5 ? vec2(q.x + q.y, q.x - q.y) : vec2(q.x - q.y, q.x + q.y)) * 0.7071;
  float e = length(d * vec2(1.0 / 0.46, 1.0 / 0.13));
  float loz = smoothstep(1.0, 0.55, e), top = smoothstep(0.75, 0.4, e);
  float big = fbm(uv, vec2(2.0), 4, 1.0), mid = fbm(uv, vec2(16.0), 4, 2.0), fine = fbm(uv, vec2(200.0), 2, 3.0);
  float wear = smoothstep(0.3, 0.7, big);
  float grime = (1.0 - loz) * smoothstep(0.3, 0.65, fbm(uv, vec2(8.0), 4, 4.0));
  float sc = scr(uv, 20.0, 5.0, 0.02, 0.0, 6.3, 0.5);
  vec3 col = vec3(0.42, 0.43, 0.45) * (0.85 + 0.3 * (mid - 0.5));
  col = mix(col, vec3(0.68, 0.69, 0.7), top * (0.4 + 0.6 * wear));
  col = mix(col, L(0.22, 0.19, 0.16), grime * 0.8);
  float rust = smoothstep(0.7, 0.86, fbm(uv, vec2(10.0), 5, 6.0) + (fine - 0.5) * 0.12) * (1.0 - top) * (0.6 + 0.4 * fine); col = mix(col, L(0.42, 0.27, 0.16) * (0.7 + 0.6 * fine), rust);
  float r = 0.5 + (mid - 0.5) * 0.15; r = mix(r, 0.22, top * (0.4 + 0.6 * wear)); r = mix(r, 0.85, grime); r = mix(r, 0.9, rust); r -= sc * 0.1;
  float h = 0.2 + loz * 0.7 + (fine - 0.5) * 0.03 - sc * 0.03 * top;
  emit(col, 1.0, h, mix(1.0, 0.6, smoothstep(1.5, 1.0, e) * (1.0 - loz)), r, 1.0 - grime * 0.8 - rust * 0.9);
}`;
SET_SHADERS.corrugated = `
void surf(vec2 uv){
  float w = uv.x * 10.0; float cz = 0.5 + 0.5 * cos(w * TAU);
  float big = fbm(uv, vec2(2.0), 4, 1.0), fine = fbm(uv, vec2(160.0, 480.0), 2, 3.0);
  float streak = fbm(uv, vec2(40.0, 1.0), 3, 6.0), streak2 = fbm(uv, vec2(10.0, 1.0), 3, 16.0);
  float lapV = smoothstep(0.004, 0.0015, abs(uv.y - 0.012) * 2.286);
  float lapZone = smoothstep(0.32, 0.0, (uv.y - 0.012) * 2.286) * step(0.012, uv.y);       // drip end of the upper sheet
  float fi = floor(w + 0.5); float onC = step(mod(fi, 5.0), 0.5);
  float fd = length(vec2((w - fi) / 10.0 * 0.762, (uv.y - 0.5) * 2.286));
  float fast = onC * smoothstep(0.008, 0.006, fd), washer = onC * smoothstep(0.014, 0.011, fd) * (1.0 - fast);
  float rg = fbm(uv, vec2(90.0, 270.0), 3, 15.0);
  float which = smoothstep(0.45, 0.7, fbm(uv, vec2(3.0, 1.0), 3, 5.0));
  float rust = smoothstep(0.5, 0.95, lapZone * which * (0.55 + 0.9 * streak) + (rg - 0.5) * 0.22) * (0.5 + 0.5 * rg);
  vec3 col = vec3(0.43, 0.47, 0.52) * (0.9 + 0.2 * (big - 0.5)) * (0.95 + 0.1 * (streak2 - 0.5));
  col = mix(col, vec3(0.6, 0.62, 0.64), smoothstep(0.6, 0.9, streak) * 0.12);
  float dirtV = (1.0 - cz) * smoothstep(0.4, 0.75, fbm(uv, vec2(3.0, 2.0), 4, 7.0)) * 0.5;
  col = mix(col, L(0.25, 0.24, 0.22), dirtV * 0.6);
  col = mix(col, mix(L(0.24, 0.16, 0.12), L(0.42, 0.28, 0.17), rg), rust);
  col = mix(col, vec3(0.5, 0.52, 0.54), fast); col *= 1.0 - washer * 0.4;
  col *= 1.0 - lapV * 0.5;
  float h = cz * 0.9 + (fine - 0.5) * 0.008 + fast * 0.05 - lapV * 0.03;
  float r = 0.5 + (streak2 - 0.5) * 0.14 + (big - 0.5) * 0.12; r = mix(r, 0.8, dirtV); r = mix(r, 0.92, rust);
  emit(col, 1.0, h, mix(0.72, 1.0, smoothstep(0.0, 0.6, cz)) * (1.0 - lapV * 0.4), r, 0.72 * (1.0 - rust * 0.9) * (1.0 - dirtV * 0.6));
}`;
SET_SHADERS.chainlink = `
void surf(vec2 uv){
  float n = 7.0; float a = (uv.x + uv.y) * n, b = (uv.x - uv.y) * n;
  float da = abs(fract(a) - 0.5), db = abs(fract(b) - 0.5);
  float rw = 0.044;
  float over = mod(floor(a) + floor(b), 2.0) < 0.5 ? 1.0 : -1.0;
  float pa = sqrt(max(0.0, 1.0 - (da / rw) * (da / rw))), pb = sqrt(max(0.0, 1.0 - (db / rw) * (db / rw)));
  float za = over * cos((fract(b) - 0.5) * 3.14159), zb = -over * cos((fract(a) - 0.5) * 3.14159);
  float ha = da < rw ? 0.45 + 0.2 * za + 0.3 * pa : 0.0, hb = db < rw ? 0.45 + 0.2 * zb + 0.3 * pb : 0.0;
  float px = uTexel * n * 1.41421;
  float alpha = max(smoothstep(rw + px * 0.5, rw - px * 0.5, da), smoothstep(rw + px * 0.5, rw - px * 0.5, db));
  float fine = fbm(uv, vec2(120.0), 3, 1.0);
  vec3 col = vec3(0.6, 0.62, 0.64) * (0.8 + 0.3 * fine);
  float rust = smoothstep(0.62, 0.75, fbm(uv, vec2(9.0), 4, 3.0)); col = mix(col, L(0.42, 0.26, 0.15), rust * 0.8);
  emit(col, alpha, max(ha, hb), 1.0, mix(0.4 + 0.2 * fine, 0.9, rust), 1.0 - rust * 0.9);
}`;
SET_SHADERS.gunmetal = `
void surf(vec2 uv){
  float fine = fbm(uv, vec2(160.0), 3, 1.0), mid = fbm(uv, vec2(12.0), 4, 2.0), big = fbm(uv, vec2(2.0), 4, 3.0);
  vec4 g = vor(uv * 200.0, vec2(200.0), 4.0);
  float wear = smoothstep(0.66, 0.92, fbm(uv, vec2(4.0), 5, 5.0) + (fine - 0.5) * 0.1) * uP.x;
  float s1 = scr(uv, 8.0, 6.0, 0.005, 0.3, 6.3, 0.3), s2 = scr(uv, 24.0, 7.0, 0.011, 1.2, 6.3, 0.32), s3 = scr(uv, 60.0, 8.0, 0.03, 0.0, 6.3, 0.3);
  float sc = sat(max(s1 * uP.x, max(s2 * 0.8, s3 * 0.6)));
  float bright = sat(wear * 0.22 + sc * (0.3 + 0.4 * uP.x));
  float oil = smoothstep(0.4, 0.75, fbm(uv, vec2(3.0, 5.0), 4, 9.0));
  vec3 nt = vec3(0.0); float ta = 0.9 * (0.8 + 0.25 * (mid - 0.5) + 0.2 * (g.w - 0.5) + 0.15 * (big - 0.5));
  OV(vec3(0.42, 0.42, 0.44), bright * 0.6);
  float r = 0.58 + (g.w - 0.5) * 0.12 + (mid - 0.5) * 0.1 - oil * 0.14 - wear * 0.14; r = mix(r, 0.3, bright * 0.8);
  float h = 0.5 + (g.x - 0.5) * 0.12 + (fine - 0.5) * 0.1 - sc * 0.25 - wear * 0.05;
  emit(nt, ta, h, 1.0 - sc * 0.1, r, mix(0.75, 1.0, bright));
}`;
SET_SHADERS.polymer = `
void surf(vec2 uv){
  vec4 g = vor(uv * 40.0, vec2(40.0), 1.0); vec4 g2 = vor(uv * 90.0 + 0.5, vec2(90.0), 2.0);
  float fine = fbm(uv, vec2(120.0), 2, 3.0), big = fbm(uv, vec2(3.0), 4, 4.0);
  float stip = smoothstep(0.6, 0.1, g.x) * (0.5 + 0.5 * g.w) * 0.7 + smoothstep(0.6, 0.1, g2.x) * 0.3;
  float scuff = smoothstep(0.62, 0.8, fbm(uv, vec2(4.0), 5, 5.0));
  float sc = scr(uv, 10.0, 6.0, 0.01, 0.5, 6.3, 0.4);
  vec3 nt = vec3(0.0); float ta = 0.92 * (0.9 + 0.12 * (big - 0.5) + 0.08 * (fine - 0.5));
  OV(vec3(0.45), sc * 0.25 + scuff * 0.06);
  float h = 0.3 + stip * 0.6 * (1.0 - scuff * 0.6) + (fine - 0.5) * 0.05 - sc * 0.2;
  float r = 0.62 + (stip - 0.5) * 0.1 + (big - 0.5) * 0.1 - scuff * 0.22 + sc * 0.1;
  emit(nt, ta, h, 0.8 + 0.2 * stip, r, 0.0);
}`;
SET_SHADERS.carbon = `
void surf(vec2 uv){
  vec2 p = uv * 12.0; vec2 i = floor(p), q = fract(p);
  float warpTop = step(mod(i.x - i.y + 400.0, 4.0), 1.5);
  float prof = warpTop > 0.5 ? sin(q.x * 3.14159) : sin(q.y * 3.14159);
  float fib = warpTop > 0.5 ? fbm(uv, vec2(240.0, 12.0), 2, 1.0) : fbm(uv, vec2(12.0, 240.0), 2, 5.0);
  float h = 0.35 + 0.5 * pow(prof, 0.6) + (fib - 0.5) * 0.12;
  vec3 col = vec3(0.035, 0.036, 0.04) * (0.7 + 0.6 * fib) * (warpTop > 0.5 ? 1.0 : 0.8);
  float big = fbm(uv, vec2(2.0), 3, 2.0);
  emit(col, 1.0, h, 0.6 + 0.4 * prof, 0.32 + (fib - 0.5) * 0.2 + (big - 0.5) * 0.1, 0.0);
}`;
SET_SHADERS.fabric = `
void surf(vec2 uv){
  float f = 36.0; vec2 p = uv * f; vec2 i = floor(p), q = fract(p);
  float top = mod(i.x + i.y, 2.0);
  float pw = sin(q.x * 3.14159), pf = sin(q.y * 3.14159);
  float h = top > 0.5 ? pw * (0.6 + 0.4 * pf) : pf * (0.6 + 0.4 * pw) * 0.85;
  float fz = fbm(uv, vec2(150.0), 3, 1.0), big = fbm(uv, vec2(2.0), 4, 2.0);
  float thr = h3(vec2(top > 0.5 ? i.x : i.y, top), vec2(f), 3.0).x;
  float ta = 0.9 * (0.55 + 0.45 * h) * (0.85 + 0.2 * (thr - 0.5) + 0.2 * (fz - 0.5) + 0.2 * (big - 0.5));
  emit(vec3(0.0), ta, 0.2 + h * 0.7 + (fz - 0.5) * 0.15, 0.5 + 0.5 * h, 0.92, 0.0);
}`;
SET_SHADERS.armor = `
void surf(vec2 uv){
  float chip, stain, run; paintDmg(uv, 0.5, chip, stain, run);
  float fine = fbm(uv, vec2(200.0), 2, 1.0), mid = fbm(uv, vec2(14.0), 4, 2.0), big = fbm(uv, vec2(2.0), 4, 3.0);
  float grime = smoothstep(0.45, 0.8, fbm(uv, vec2(3.0, 4.0), 5, 4.0)); float sc = scr(uv, 14.0, 5.0, 0.008, 0.4, 6.3, 0.5);
  float sub = smoothstep(0.5, 0.75, chip), prim = smoothstep(0.15, 0.4, chip) * (1.0 - sub);
  vec3 nt = vec3(0.0); float ta = 0.85 * (0.92 + 0.14 * (mid - 0.5) + 0.1 * (big - 0.5));
  OV(L(0.2, 0.18, 0.15), grime * 0.07 * (0.5 + fine));
  OV(vec3(0.55), sc * 0.3);
  OV(L(0.5, 0.5, 0.47), prim);
  float wv = fbm(uv, vec2(160.0, 8.0), 2, 6.0);
  OV(L(0.4, 0.38, 0.33) * (0.6 + 0.8 * wv), sub);
  float h = 0.6 + (fine - 0.5) * 0.04 + (mid - 0.5) * 0.03 - prim * 0.1 - sub * 0.25 - sc * 0.08;
  float r = 0.36 + (mid - 0.5) * 0.1 + grime * 0.1 + sc * 0.15; r = mix(r, 0.6, prim); r = mix(r, 0.75, sub);
  emit(nt, ta, h, 1.0 - sub * 0.2, r, 0.0);
}`;
SET_SHADERS.wood = `
void surf(vec2 uv){
  vec4 kv = vor(uv * vec2(2.0, 4.0), vec2(2.0, 4.0), 1.0); float isK = step(kv.z, 0.3);
  float knot = isK * smoothstep(0.2, 0.0, length((kv.x) * vec2(1.0))), core = isK * smoothstep(0.05, 0.03, kv.x);
  float wob = fbm(uv, vec2(1.0, 3.0), 3, 2.0);
  float ring = fract(uv.y * 44.0 + (wob - 0.5) * 2.4 + knot * knot * 4.0 + (fbm(uv, vec2(4.0, 30.0), 2, 12.0) - 0.5) * 0.35);
  float late = smoothstep(0.5, 0.92, ring) * (1.0 - smoothstep(0.92, 1.0, ring));
  float fib = fbm(uv, vec2(3.0, 260.0), 3, 3.0), fib2 = fbm(uv, vec2(8.0, 90.0), 3, 4.0);
  float saw = 0.5 + 0.5 * sin((uv.x + 0.02 * sin(uv.y * TAU * 2.0)) * TAU * 240.0);
  float sawK = smoothstep(0.35, 0.7, fbm(uv, vec2(3.0), 3, 5.0));
  float grey = smoothstep(0.2, 0.68, fbm(uv, vec2(2.0, 3.0), 5, 6.0));
  float crack = smoothstep(0.84, 0.87, fbm(uv, vec2(2.0, 110.0), 3, 7.0)) * smoothstep(0.45, 0.65, fbm(uv, vec2(5.0, 3.0), 3, 8.0));
  vec3 early = L(0.58, 0.49, 0.38), lateC = L(0.36, 0.28, 0.2);
  float bigv = fbm(uv, vec2(1.0, 2.0), 3, 21.0);
  vec3 col = mix(early, lateC, late * 0.9) * (0.85 + 0.6 * (fib - 0.5) + 0.4 * (fib2 - 0.5)) * (0.78 + 0.44 * bigv);
  col = mix(col, lateC * 0.8, knot * 0.5); col = mix(col, L(0.28, 0.17, 0.09), core);
  col = mix(col, L(0.47, 0.465, 0.45) * (0.7 + 0.6 * fib) * (1.0 - late * 0.3), grey * 0.82);
  float dirt = smoothstep(0.55, 0.85, fbm(uv, vec2(4.0), 5, 9.0)); col *= 1.0 - dirt * 0.35;
  col *= 1.0 - crack * 0.55;
  float h = 0.5 + (fib - 0.5) * 0.4 + (late - 0.5) * 0.2 - (saw - 0.5) * 0.12 * sawK + (fib2 - 0.5) * 0.15 - crack * 0.3 + core * 0.05;
  emit(col, 1.0, h, 1.0 - crack * 0.5, 0.82 + (fib - 0.5) * 0.15 + grey * 0.08 - core * 0.15, 0.0);
}`;
SET_SHADERS.plastic = `
void surf(vec2 uv){
  float fine = fbm(uv, vec2(220.0), 3, 1.0), mid = fbm(uv, vec2(14.0), 4, 2.0), big = fbm(uv, vec2(2.0), 4, 3.0);
  float scuff = smoothstep(0.55, 0.75, fbm(uv, vec2(5.0, 8.0), 5, 4.0));
  float s1 = scr(uv, 7.0, 5.0, 0.005, 0.2, 6.3, 0.35), s2 = scr(uv, 22.0, 6.0, 0.012, 1.0, 6.3, 0.3), s3 = scr(uv, 50.0, 7.0, 0.03, 2.0, 6.3, 0.25);
  float sc = sat(max(s1, max(s2 * 0.8, s3 * 0.5)));
  float dirt = smoothstep(0.5, 0.85, fbm(uv, vec2(3.0), 5, 8.0));
  vec3 nt = vec3(0.0); float ta = 0.9 * (0.92 + 0.1 * (mid - 0.5) + 0.1 * (big - 0.5));
  OV(vec3(0.6), sc * 0.22 + scuff * 0.03 * fine);
  OV(L(0.25, 0.22, 0.18), dirt * 0.4);
  float h = 0.5 + (fine - 0.5) * 0.12 + (mid - 0.5) * 0.04 - sc * 0.25;
  emit(nt, ta, h, 1.0, 0.42 + (fine - 0.5) * 0.08 + scuff * 0.2 + sc * 0.2 + dirt * 0.2, 0.0);
}`;
SET_SHADERS.tarp = `
void surf(vec2 uv){
  vec2 wu = uv + (vec2(fbm(uv, vec2(2.0), 3, 1.0), fbm(uv, vec2(2.0), 3, 2.0)) - 0.5) * 0.12;
  float f1 = 1.0 - abs(gn(wu * vec2(2.0, 7.0), vec2(2.0, 7.0), 3.0)) * 2.4;        // long drape folds
  float f2 = 1.0 - abs(gn(wu * vec2(5.0, 13.0) + 2.0, vec2(5.0, 13.0), 4.0)) * 2.4; // finer wrinkles
  f1 = smoothstep(0.0, 1.0, sat(f1)); f2 = smoothstep(0.2, 1.0, sat(f2));
  float bill = fbm(wu, vec2(2.0, 3.0), 3, 5.0);
  float scrim = max(smoothstep(0.42, 0.5, abs(fract(uv.x * 200.0) - 0.5)), smoothstep(0.42, 0.5, abs(fract(uv.y * 200.0) - 0.5)));
  float fine = fbm(uv, vec2(240.0), 2, 6.0), mid = fbm(uv, vec2(14.0), 4, 7.0);
  float h = 0.25 + bill * 0.35 + f1 * 0.22 + f2 * 0.07 + scrim * 0.02 + (fine - 0.5) * 0.012;
  float dirt = smoothstep(0.5, 0.85, fbm(uv, vec2(4.0), 5, 8.0) + (0.5 - f1) * 0.08);
  vec3 nt = vec3(0.0); float ta = 0.9 * (0.88 + 0.14 * (mid - 0.5)) * (1.0 - scrim * 0.06);
  OV(vec3(0.5), smoothstep(0.85, 1.0, f1) * 0.03);
  OV(L(0.3, 0.27, 0.22), dirt * 0.3);
  emit(nt, ta, h, 0.9 + 0.1 * smoothstep(0.1, 0.7, f1), 0.48 + (mid - 0.5) * 0.15 + dirt * 0.25, 0.0);
}`;
SET_SHADERS.cardboard = `
void surf(vec2 uv){
  float fl = 0.5 + 0.5 * cos(uv.y * TAU * 140.0);
  float fib = fbm(uv, vec2(40.0, 160.0), 3, 1.0), fine = fbm(uv, vec2(250.0), 2, 2.0), big = fbm(uv, vec2(2.0), 4, 3.0);
  float sn = fbm(uv, vec2(3.0), 5, 4.0); float damp = smoothstep(0.62, 0.72, sn); float tide = smoothstep(0.61, 0.64, sn) * (1.0 - smoothstep(0.64, 0.7, sn));
  float crease = smoothstep(0.012, 0.004, abs(fbm(uv, vec2(2.0), 2, 5.0) - 0.5)) * smoothstep(0.5, 0.7, fbm(uv, vec2(3.0), 2, 6.0));
  vec3 col = L(0.66, 0.52, 0.36) * (0.85 + 0.2 * (fib - 0.5) + 0.12 * (fine - 0.5) + 0.2 * (big - 0.5)) * (0.97 + 0.06 * fl);
  col *= (1.0 - damp * 0.3) * (1.0 - tide * 0.18); col = mix(col, col * 1.25, crease * 0.5);
  col *= 1.0 - smoothstep(0.8, 0.9, fbm(uv, vec2(120.0), 2, 7.0)) * 0.2;
  float h = 0.5 + (fl - 0.5) * 0.12 + (fib - 0.5) * 0.15 + (fine - 0.5) * 0.08 - crease * 0.3 + damp * 0.2 * (fbm(uv, vec2(20.0), 3, 8.0) - 0.5);
  emit(col, 1.0, h, 1.0 - crease * 0.3, 0.9 - damp * 0.2 + (fib - 0.5) * 0.1, 0.0);
}`;
SET_SHADERS.rope = `
void surf(vec2 uv){
  float a = (uv.x + uv.y) * 4.0; float prof = sin(fract(a) * 3.14159);
  float fib = fbm(uv, vec2(60.0), 3, 1.0);
  float yarn = 0.5 + 0.5 * sin((uv.x - uv.y) * 4.0 * TAU * 5.0 + 2.0 * sin(a * TAU));
  float h = pow(prof, 0.7) * 0.8 + yarn * 0.1 + (fib - 0.5) * 0.15;
  vec3 col = L(0.66, 0.6, 0.46) * (0.6 + 0.4 * prof) * (0.85 + 0.3 * (fib - 0.5)) * (0.92 + 0.16 * yarn);
  float dirt = smoothstep(0.4, 0.8, fbm(uv, vec2(3.0), 4, 2.0)); col = mix(col, L(0.25, 0.22, 0.18), dirt * 0.5 * (1.0 - prof * 0.5));
  emit(col, 1.0, h, 0.45 + 0.55 * prof, 0.95, 0.0);
}`;
SET_SHADERS.tire = `
void surf(vec2 uv){
  float sv = fract(uv.y + 0.5) - 0.5; float v = abs(sv) * 2.0; float u = uv.x;
  float zig = 0.03 * abs(fract(u * 10.0) - 0.5) * 2.0;
  float g1 = smoothstep(0.035, 0.02, abs(v - 0.36 - zig)), g0 = smoothstep(0.03, 0.018, abs(v - zig * 0.5));
  float lat = smoothstep(0.06, 0.03, abs(fract(u * 10.0 + v * 1.2 * sign(sv)) - 0.5)) * step(0.4, v) * step(v, 0.8);
  float sipe = smoothstep(0.012, 0.005, abs(fract(u * 20.0 + v * 0.8) - 0.5)) * step(0.05, v) * step(v, 0.33);
  float groove = sat(max(max(g0, g1), max(lat, sipe * 0.6)));
  float side = smoothstep(0.84, 0.9, v);
  float rib = (0.5 + 0.5 * cos(v * TAU * 14.0)) * side;
  float fine = fbm(uv, vec2(200.0, 120.0), 3, 1.0), mid = fbm(uv, vec2(10.0, 6.0), 4, 2.0);
  float h = (1.0 - groove) * (1.0 - side) * 0.8 + side * (0.35 + rib * 0.1) + (fine - 0.5) * 0.04;
  float dust = smoothstep(0.4, 0.75, fbm(uv, vec2(4.0, 3.0), 5, 3.0));
  vec3 col = vec3(0.022) * (0.8 + 0.5 * (mid - 0.5)); col = mix(col, L(0.22, 0.2, 0.17), dust * 0.25 + groove * (1.0 - side) * 0.2);
  emit(col, 1.0, h, 1.0 - groove * 0.5 * (1.0 - side), 0.85 + (fine - 0.5) * 0.1 - side * 0.1, 0.0);
}`;
SET_SHADERS.glass = `
void surf(vec2 uv){
  float d = uP.x;
  float big = fbm(uv, vec2(2.0), 5, 1.0), mid = fbm(uv, vec2(12.0), 4, 2.0), fine = fbm(uv, vec2(200.0), 2, 3.0);
  float dust = sat(smoothstep(0.75 - 0.45 * d, 0.95 - 0.3 * d, big * 0.7 + mid * 0.3) + fine * 0.15 * d);
  float st2 = fbm(uv, vec2(120.0, 3.0), 2, 5.0);
  float trail = smoothstep(0.62, 0.72, fbm(uv, vec2(50.0, 1.0), 2, 4.0)) * smoothstep(0.3, 0.6, fbm(uv, vec2(50.0, 2.0), 2, 6.0));
  vec4 dv = vor(uv * 60.0, vec2(60.0), 7.0); float drop = step(dv.z, 0.45) * smoothstep(0.32 * dv.w + 0.06, 0.0, dv.x);
  vec4 dv2 = vor(uv * 150.0, vec2(150.0), 8.0); float drop2 = step(dv2.z, 0.5) * smoothstep(0.3 * dv2.w + 0.05, 0.0, dv2.x);
  dust *= 1.0 - trail * 0.7;
  vec3 col = mix(L(0.5, 0.6, 0.62) * 0.25, L(0.5, 0.47, 0.4), dust);
  float alpha = mix(0.16, 0.55 + 0.35 * d, dust) + drop * 0.08 + (st2 - 0.5) * 0.05 * d;
  float h = 0.3 + drop * 0.5 + drop2 * 0.15 + trail * 0.06 * st2;
  float r = mix(0.03, 0.55, dust); r = mix(r, 0.03, sat(drop * 2.0));
  emit(col, alpha, h, 1.0, r, 0.0);
}`;
SET_SHADERS.water = `
void surf(vec2 uv){
  float a = fbm(uv, vec2(6.0, 10.0), 4, 1.0), b = fbm(uv + 0.3, vec2(20.0, 30.0), 3, 2.0);
  emit(L(0.1, 0.16, 0.18) * 0.5, 1.0, 0.5 + (a - 0.5) * 0.6 + (b - 0.5) * 0.2, 1.0, 0.06, 0.0);
}`;
var NORMAL_FROM_HEIGHT_FRAG = `
precision highp float;
uniform sampler2D tH; uniform vec2 uK; uniform float uTexel; in vec2 vUv; out vec4 o;
float H(vec2 uv){ vec4 t = texture(tH, uv); return t.r + t.g / 255.0; }
void main(){
  vec2 e = vec2(uTexel, 0.0);
  float l = H(vUv - e.xy), r = H(vUv + e.xy), d = H(vUv - e.yx), u = H(vUv + e.yx);
  float ld = H(vUv - e.xx), rd = H(vUv + vec2(e.x, -e.x)), lu = H(vUv + vec2(-e.x, e.x)), ru = H(vUv + e.xx);
  float gx = (r - l) * 0.5 + (ru + rd - lu - ld) * 0.25, gy = (u - d) * 0.5 + (ru + lu - rd - ld) * 0.25;
  vec3 n = normalize(vec3(-gx * uK.x, -gy * uK.y, 1.0));
  o = vec4(n * 0.5 + 0.5, 1.0);
}`, COPY_FRAG = `
precision highp float;
uniform sampler2D tA; uniform float uSq; in vec2 vUv; out vec4 o;
void main(){ vec4 t = texture(tA, vUv); o = uSq > 0.5 ? vec4(t.rgb * t.rgb, t.a) : t; }`;
var o3 = '"Big Shoulders Display", "Barlow Condensed", "Arial Narrow", Impact, "Helvetica Neue", Arial, sans-serif', r3 = '"Barlow Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif', oA = '"IBM Plex Mono", "DejaVu Sans Mono", Menlo, Consolas, monospace', Ut = { white: [226, 223, 213], black: [24, 24, 26], yellow: [222, 172, 30], red: [168, 36, 28], navy: [24, 38, 58], orange: [206, 100, 30] }, An = (i, e = 1) => `rgba(${i[0]},${i[1]},${i[2]},${e})`, rA = /* @__PURE__ */ new Set(["I", "1", " ", "-", ".", "/", ":", ",", "'", "!", "\xB7"]);
function mulberry32(i) {
  let e = i >>> 0;
  return () => {
    e |= 0, e = e + 1831565813 | 0;
    let t = Math.imul(e ^ e >>> 15, 1 | e);
    return t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t, ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function fnv1a(i) {
  let e = 2166136261;
  for (let t = 0; t < i.length; t++) e ^= i.charCodeAt(t), e = Math.imul(e, 16777619);
  return e >>> 0;
}
function makeCanvas(i, e) {
  let t = document.createElement("canvas");
  return t.width = i, t.height = e, t;
}
function ra(i, e, t, n, s, o = 0.35, r = 9) {
  i.beginPath();
  for (let a = 0; a < r; a++) {
    let l = a / r * Math.PI * 2, c = n * (1 - o + s() * o * 2), u = e + Math.cos(l) * c, h = t + Math.sin(l) * c;
    a ? i.lineTo(u, h) : i.moveTo(u, h);
  }
  i.closePath();
}
function Ks(i, e, t, n, s) {
  if (n <= 0) return;
  i.save(), i.globalCompositeOperation = "destination-out";
  let o = Math.floor(n * e * t / 700);
  for (let r = 0; r < o; r++) {
    let a = Math.pow(s(), 3) * t * 0.09 + 0.6;
    i.globalAlpha = 0.45 + s() * 0.55, ra(i, s() * e, s() * t, a, s, 0.5, 7), i.fill();
  }
  i.lineCap = "round";
  for (let r = 0; r < n * 16; r++) {
    let a = s() * e, l = s() * t, c = (s() - 0.5) * 0.7, u = (0.1 + s() * 0.5) * e;
    i.globalAlpha = 0.5 + s() * 0.5, i.lineWidth = 0.5 + s() * s() * 3, i.beginPath(), i.moveTo(a, l), i.lineTo(a + Math.cos(c) * u, l + Math.sin(c) * u), i.stroke();
  }
  i.globalAlpha = 0.8;
  for (let r = 0; r < n * e * t / 60; r++) i.fillRect(s() * e, s() * t, 1 + s(), 1 + s());
  for (let r = 0; r < n * 6; r++) {
    let a = s() * e, l = s() * t, c = (0.1 + s() * 0.25) * t, u = i.createRadialGradient(a, l, 0, a, l, c);
    u.addColorStop(0, "rgba(0,0,0," + (0.25 + s() * 0.4) + ")"), u.addColorStop(1, "rgba(0,0,0,0)"), i.globalAlpha = 1, i.fillStyle = u, i.fillRect(a - c, l - c, c * 2, c * 2);
  }
  i.restore();
}
function a3(i, e, t, n, s, o) {
  i.font = `${s} ${t}px ${n}`;
  let r = 0;
  for (let a of e) r += i.measureText(a).width + o;
  return r - o;
}
function qa(i, e, t, n, s, o, r = {}) {
  let a = r.font === "sans" ? r3 : r.font === "mono" ? oA : o3, l = r.weight || 700, c = r.spacing !== void 0 ? r.spacing : s * 0.06, u = r.font !== "sans" && r.font !== "mono" && r.bridges !== false, h = a3(i, e, s, a, l, c), f = r.maxW && h > r.maxW ? r.maxW / h : r.fitW ? r.fitW / h : 1, p = makeCanvas(Math.ceil(h * f) + 8, Math.ceil(s * 1.4)), d = p.getContext("2d");
  d.font = `${l} ${s}px ${a}`, d.textBaseline = "alphabetic", d.fillStyle = o, d.scale(f, 1);
  let v = 4 / f, g = s * 1.08;
  for (let y of e) {
    let b = d.measureText(y).width;
    d.fillText(y, v, g), u && !rA.has(y) && (d.save(), d.globalCompositeOperation = "destination-out", d.fillRect(v + b * 0.5 - s * 0.032, 0, s * 0.064, s * 1.4), d.restore()), v += b + c;
  }
  let x = r.align === "center" ? t - h * f / 2 : r.align === "right" ? t - h * f : t;
  return i.drawImage(p, x - 4, n - g), h * f;
}
function createDecalLibrary(i, e = 4) {
  let t = /* @__PURE__ */ new Map(), n = [], s = 0;
  function o(v, g = {}) {
    let x = new THREE.CanvasTexture(v);
    x.colorSpace = THREE.SRGBColorSpace, x.anisotropy = e, x.generateMipmaps = true, x.minFilter = THREE.LinearMipmapLinearFilter, s += v.width * v.height * 4 * 1.34;
    let y = new THREE.MeshStandardMaterial({ map: x, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, roughness: g.rough !== void 0 ? g.rough : 0.7, metalness: g.metal || 0, opacity: g.opacity !== void 0 ? g.opacity : 1 });
    return y.name = "decal", g.doubleSide && (y.side = THREE.DoubleSide), { material: y, aspect: v.width / v.height, texture: x };
  }
  function r(v, g, x, y, b = {}) {
    let m = makeCanvas(g, x), A = m.getContext("2d"), _ = () => {
      A.setTransform(1, 0, 0, 1, 0, 0), A.clearRect(0, 0, g, x), A.globalAlpha = 1, A.globalCompositeOperation = "source-over", b.bleed && (A.fillStyle = An(b.bleed, 0.012), A.fillRect(0, 0, g, x)), y(A, g, x, mulberry32(fnv1a(v) + 17));
    };
    _();
    let M = o(m, b);
    return b.text && n.push(() => {
      _(), M.texture.needsUpdate = true;
    }), M;
  }
  function a(v, g, x, y) {
    v.lineJoin = "round", v.beginPath(), v.moveTo(g / 2, x * 0.12), v.lineTo(g * 0.9, x * 0.84), v.lineTo(g * 0.1, x * 0.84), v.closePath(), v.lineWidth = g * 0.11, v.strokeStyle = An(Ut.black), v.stroke(), v.fillStyle = y, v.fill(), v.lineWidth = g * 0.035, v.strokeStyle = An(Ut.black), v.stroke();
  }
  function l(v, g, x, y, b, m, A, _) {
    v.fillStyle = v.strokeStyle = An(y);
    let M = x;
    v.save(), v.translate(M * 0.5, M * 0.5), b(v, M * 0.38, An(_ || y)), v.restore(), qa(v, m, M * 1, x * 0.6, x * 0.42, An(y), { weight: 900, bridges: false, maxW: g - M * 1.05, spacing: x * 0.012 }), v.fillStyle = An(_ || y), v.fillRect(M * 1, x * 0.67, g - M * 1.12, x * 0.022), qa(v, A, M * 1, x * 0.84, x * 0.115, An(y), { font: "sans", weight: 600, spacing: x * 0.035, maxW: g - M * 1.1 });
  }
  let c = { hazard_flammable: () => r("hazard_flammable", 256, 256, (v, g, x, y) => {
    v.save(), v.translate(g / 2, x / 2), v.rotate(Math.PI / 4), v.fillStyle = An(Ut.red), v.fillRect(-86, -86, 172, 172), v.strokeStyle = An(Ut.white), v.lineWidth = 5, v.strokeRect(-76, -76, 152, 152), v.restore(), v.save(), v.translate(g / 2, x / 2 - 8), v.fillStyle = An(Ut.white), v.beginPath(), v.moveTo(2, -64), v.bezierCurveTo(34, -28, 40, 6, 24, 28), v.bezierCurveTo(12, 44, -12, 44, -24, 28), v.bezierCurveTo(-40, 6, -20, -12, -15, -34), v.bezierCurveTo(-6, -28, 0, -44, 2, -64), v.fill(), v.fillStyle = An(Ut.red), v.beginPath(), v.moveTo(1, -10), v.bezierCurveTo(15, 6, 15, 24, 0, 31), v.bezierCurveTo(-15, 24, -13, 8, 1, -10), v.fill(), v.fillStyle = An(Ut.white), v.fillRect(-34, 50, 68, 6), v.restore(), qa(v, "3", g / 2, x * 0.9, 34, An(Ut.white), { align: "center", weight: 900, bridges: false }), Ks(v, g, x, 0.3, y);
  }, { bleed: Ut.red, text: true }), hazard_voltage: () => r("hazard_voltage", 256, 256, (v, g, x, y) => {
    a(v, g, x, An(Ut.yellow)), v.fillStyle = An(Ut.black), v.save(), v.translate(g / 2, x * 0.56), v.beginPath(), [[12, -58], [-24, 4], [-3, 4], [-16, 50], [26, -14], [5, -14], [22, -58]].forEach((b, m) => m ? v.lineTo(b[0], b[1]) : v.moveTo(b[0], b[1])), v.closePath(), v.fill(), v.restore(), Ks(v, g, x, 0.3, y);
  }, { bleed: Ut.yellow }), hazard_general: () => r("hazard_general", 256, 256, (v, g, x, y) => {
    a(v, g, x, An(Ut.yellow)), v.fillStyle = An(Ut.black), v.beginPath(), v.moveTo(g / 2 - 13, x * 0.34), v.lineTo(g / 2 + 13, x * 0.34), v.lineTo(g / 2 + 7, x * 0.62), v.lineTo(g / 2 - 7, x * 0.62), v.closePath(), v.fill(), v.beginPath(), v.arc(g / 2, x * 0.715, 11, 0, 7), v.fill(), Ks(v, g, x, 0.3, y);
  }, { bleed: Ut.yellow }), arrow: () => r("arrow", 384, 192, (v, g, x, y) => {
    v.fillStyle = An(Ut.white), v.beginPath(), [[20, 68], [226, 68], [226, 22], [364, 96], [226, 170], [226, 124], [20, 124]].forEach((b, m) => m ? v.lineTo(b[0], b[1]) : v.moveTo(b[0], b[1])), v.closePath(), v.fill(), v.globalCompositeOperation = "destination-out", v.fillRect(118, 0, 9, x), v.fillRect(232, 0, 7, x), v.globalCompositeOperation = "source-over", Ks(v, g, x, 0.5, y);
  }, { bleed: Ut.white }), no_entry: () => r("no_entry", 256, 256, (v, g, x, y) => {
    v.fillStyle = An(Ut.white), v.beginPath(), v.arc(128, 128, 112, 0, 7), v.fill(), v.fillStyle = An(Ut.red), v.beginPath(), v.arc(128, 128, 102, 0, 7), v.fill(), v.fillStyle = An(Ut.white), v.fillRect(52, 106, 152, 44), Ks(v, g, x, 0.3, y);
  }, { bleed: Ut.red }), logo_a: () => r("logo_a", 640, 192, (v, g, x, y) => {
    l(v, g, x, Ut.white, (b, m, A) => {
      b.lineWidth = m * 0.13, b.beginPath(), b.arc(0, 0, m * 0.92, 0.25 * Math.PI, 1.75 * Math.PI), b.stroke(), b.beginPath(), b.moveTo(0, -m * 1.08), b.lineTo(m * 0.26, 0), b.lineTo(0, m * 0.62), b.lineTo(-m * 0.26, 0), b.closePath(), b.fill(), b.beginPath(), b.moveTo(m * 0.5, 0), b.lineTo(m * 1.12, -m * 0.1), b.lineTo(m * 1.12, m * 0.1), b.closePath(), b.fill();
    }, "NORDKAP LINE", "ARCTIC  \xB7  ATLANTIC  \xB7  FEEDER"), Ks(v, g, x, 0.35, y);
  }, { bleed: Ut.white, text: true }), logo_b: () => r("logo_b", 640, 192, (v, g, x, y) => {
    l(v, g, x, Ut.white, (b, m, A) => {
      b.fillStyle = A;
      for (let _ = 0; _ < 2; _++) {
        let M = -m * 0.35 + _ * m * 0.55, E = m * (0.3 - _ * 0.06);
        b.beginPath(), b.moveTo(-m * 1.05, M - m * 0.25), b.quadraticCurveTo(-m * 0.3, M - m * 0.2, 0, M + m * 0.35), b.quadraticCurveTo(m * 0.3, M - m * 0.2, m * 1.05, M - m * 0.25), b.quadraticCurveTo(m * 0.35, M + E * 0.2, 0, M + m * 0.35 + E), b.quadraticCurveTo(-m * 0.35, M + E * 0.2, -m * 1.05, M - m * 0.25), b.fill();
      }
    }, "TERN OCEANIC", "CONTAINER SERVICES", Ut.orange), Ks(v, g, x, 0.35, y);
  }, { bleed: Ut.white, text: true }), logo_c: () => r("logo_c", 640, 192, (v, g, x, y) => {
    l(v, g, x, Ut.navy, (b, m, A) => {
      b.beginPath(), b.arc(0, m * 0.25, m * 0.55, Math.PI, 0), b.closePath(), b.fill(), b.lineWidth = m * 0.1, b.lineCap = "butt";
      for (let _ = 0; _ < 7; _++) {
        let M = Math.PI + (_ + 0.5) / 7 * Math.PI;
        b.beginPath(), b.moveTo(Math.cos(M) * m * 0.7, m * 0.25 + Math.sin(M) * m * 0.7), b.lineTo(Math.cos(M) * m * 1.05, m * 0.25 + Math.sin(M) * m * 1.05), b.stroke();
      }
      b.fillRect(-m * 1.05, m * 0.42, m * 2.1, m * 0.13), b.fillRect(-m * 0.8, m * 0.68, m * 1.6, m * 0.1);
    }, "AUREL PACIFIC", "DEEP SEA  \xB7  REEFER  \xB7  BULK"), Ks(v, g, x, 0.35, y);
  }, { bleed: Ut.navy, text: true }), logo_d: () => r("logo_d", 640, 192, (v, g, x, y) => {
    l(v, g, x, Ut.white, (b, m, A) => {
      b.fillRect(-m, -m, m * 0.5, m * 2), b.fillRect(m * 0.5, -m, m * 0.5, m * 2), b.fillRect(-m, -m * 0.2, m * 2, m * 0.4), b.fillStyle = A, b.fillRect(-m * 0.32, -m, m * 0.64, m * 0.5), b.fillRect(-m * 0.32, m * 0.5, m * 0.64, m * 0.5);
    }, "HOLMGARD", "INTERMODAL  FREIGHT", Ut.yellow), Ks(v, g, x, 0.35, y);
  }, { bleed: Ut.white, text: true }), berth4: () => r("berth4", 640, 224, (v, g, x, y) => {
    v.strokeStyle = An(Ut.yellow), v.lineWidth = 12, v.strokeRect(14, 14, g - 28, x - 28), v.globalCompositeOperation = "destination-out";
    for (let b of [g * 0.25, g * 0.75]) v.fillRect(b - 6, 0, 12, x);
    v.globalCompositeOperation = "source-over", qa(v, "BERTH 4", g / 2, x * 0.76, x * 0.66, An(Ut.yellow), { align: "center", weight: 900, maxW: g - 80 }), Ks(v, g, x, 0.55, y);
  }, { bleed: Ut.yellow, text: true }), caution_stripes: () => r("caution_stripes", 512, 128, (v, g, x, y) => {
    v.fillStyle = An(Ut.black), v.fillRect(0, 8, g, x - 16), v.save(), v.beginPath(), v.rect(0, 8, g, x - 16), v.clip(), v.fillStyle = An(Ut.yellow);
    for (let b = -x; b < g + x; b += 64) v.beginPath(), v.moveTo(b, x), v.lineTo(b + 32, x), v.lineTo(b + 32 + x, 0), v.lineTo(b + x, 0), v.closePath(), v.fill();
    v.restore(), Ks(v, g, x, 0.5, y);
  }, { bleed: Ut.black }), grime_streak: () => r("grime_streak", 128, 256, (v, g, x, y) => {
    for (let b = 0; b < 46; b++) {
      let m = g * (0.12 + 0.76 * (y() * 0.5 + y() * 0.5)), A = x * (0.25 + y() * 0.7), _ = 1.5 + y() * y() * 12, M = 0.05 + y() * 0.16, E = v.createLinearGradient(0, 0, 0, A);
      E.addColorStop(0, `rgba(26,23,19,${M})`), E.addColorStop(0.15, `rgba(26,23,19,${M * 1.3})`), E.addColorStop(1, "rgba(26,23,19,0)"), v.fillStyle = E, v.fillRect(m - _ / 2 + (y() - 0.5) * 2, 0, _, A);
    }
  }, { rough: 0.85, bleed: [26, 23, 19] }), rust_run: () => r("rust_run", 128, 256, (v, g, x, y) => {
    for (let b = 0; b < 40; b++) {
      let m = g * (0.2 + 0.6 * (y() * 0.5 + y() * 0.5)), A = x * (0.2 + y() * 0.75), _ = 1.2 + y() * y() * 9, M = 0.08 + y() * 0.22, E = y() < 0.5 ? "118,52,18" : "150,78,26", w = v.createLinearGradient(0, 8, 0, A);
      w.addColorStop(0, `rgba(${E},${M * 1.4})`), w.addColorStop(0.3, `rgba(${E},${M})`), w.addColorStop(1, `rgba(${E},0)`), v.fillStyle = w, v.fillRect(m - _ / 2, 8, _, A);
    }
    for (let b = 0; b < 9; b++) v.fillStyle = `rgba(${y() < 0.5 ? "70,30,14" : "104,44,16"},${0.5 + y() * 0.4})`, ra(v, g * (0.3 + y() * 0.4), 6 + y() * 12, 3 + y() * 8, y, 0.5, 7), v.fill();
  }, { rough: 0.9, bleed: [118, 52, 18] }), oil_stain: () => r("oil_stain", 256, 256, (v, g, x, y) => {
    for (let b = 0; b < 26; b++) {
      let m = y() * 7, A = Math.pow(y(), 1.5) * g * 0.26, _ = g / 2 + Math.cos(m) * A, M = x / 2 + Math.sin(m) * A * 0.8, E = g * (0.06 + y() * 0.16), w = v.createRadialGradient(_, M, E * 0.2, _, M, E);
      w.addColorStop(0, `rgba(10,10,11,${0.35 + y() * 0.3})`), w.addColorStop(0.75, "rgba(12,11,10,0.22)"), w.addColorStop(1, "rgba(12,11,10,0)"), v.fillStyle = w, v.fillRect(_ - E, M - E, E * 2, E * 2);
    }
    for (let b = 0; b < 30; b++) {
      v.fillStyle = `rgba(10,10,11,${0.3 + y() * 0.4})`;
      let m = y() * 7, A = g * (0.25 + y() * 0.2);
      v.beginPath(), v.arc(g / 2 + Math.cos(m) * A, x / 2 + Math.sin(m) * A, 1 + y() * 4, 0, 7), v.fill();
    }
  }, { rough: 0.12, bleed: [10, 10, 11] }), leak_stain: () => r("leak_stain", 192, 256, (v, g, x, y) => {
    for (let b = 0; b < 18; b++) {
      let m = g * (0.3 + y() * 0.4), A = x * (0.12 + y() * 0.2), _ = g * (0.1 + y() * 0.2), M = v.createRadialGradient(m, A, _ * 0.5, m, A, _);
      M.addColorStop(0, "rgba(150,146,130,0.0)"), M.addColorStop(0.8, `rgba(168,162,140,${0.18 + y() * 0.2})`), M.addColorStop(1, "rgba(168,162,140,0)"), v.fillStyle = M, v.fillRect(m - _, A - _, _ * 2, _ * 2);
    }
    for (let b = 0; b < 22; b++) {
      let m = g * (0.25 + 0.5 * y()), A = x * (0.3 + y() * 0.6), _ = 2 + y() * 9, M = 0.08 + y() * 0.16, E = y() < 0.6 ? "160,154,132" : "60,66,52", w = v.createLinearGradient(0, x * 0.2, 0, x * 0.2 + A);
      w.addColorStop(0, `rgba(${E},${M})`), w.addColorStop(1, `rgba(${E},0)`), v.fillStyle = w, v.fillRect(m, x * 0.2, _, A);
    }
  }, { rough: 0.8, bleed: [160, 154, 132] }), bullet_metal: () => r("bullet_metal", 128, 128, (v, g, x, y) => {
    v.fillStyle = "rgba(96,52,40,0.9)", ra(v, 64, 64, 30, y, 0.4, 11), v.fill(), v.fillStyle = "rgba(150,152,156,0.95)", ra(v, 64, 64, 22, y, 0.3, 12), v.fill(), v.strokeStyle = "rgba(205,207,210,0.9)", v.lineWidth = 1;
    for (let m = 0; m < 14; m++) {
      let A = y() * 7;
      v.beginPath(), v.moveTo(64 + Math.cos(A) * 9, 64 + Math.sin(A) * 9), v.lineTo(64 + Math.cos(A) * (16 + y() * 10), 64 + Math.sin(A) * (16 + y() * 10)), v.stroke();
    }
    let b = v.createRadialGradient(64, 64, 2, 64, 64, 12);
    b.addColorStop(0, "rgba(4,4,5,1)"), b.addColorStop(0.75, "rgba(10,10,12,1)"), b.addColorStop(1, "rgba(70,72,76,0.9)"), v.fillStyle = b, ra(v, 64, 64, 12, y, 0.15, 12), v.fill(), v.strokeStyle = "rgba(230,232,235,0.85)", v.lineWidth = 1.5, v.beginPath(), v.arc(64, 64, 12.5, 3.6, 5.6), v.stroke();
  }, { rough: 0.4, metal: 0.8, bleed: [96, 52, 40] }), bullet_concrete: () => r("bullet_concrete", 128, 128, (v, g, x, y) => {
    let b = v.createRadialGradient(64, 64, 20, 64, 64, 60);
    b.addColorStop(0, "rgba(176,172,162,0.5)"), b.addColorStop(1, "rgba(176,172,162,0)"), v.fillStyle = b, v.fillRect(0, 0, g, x), v.fillStyle = "rgba(168,164,154,0.95)", ra(v, 64, 64, 32, y, 0.35, 13), v.fill(), v.fillStyle = "rgba(120,116,108,0.95)", ra(v, 65, 66, 20, y, 0.35, 11), v.fill(), v.strokeStyle = "rgba(40,38,36,0.8)", v.lineWidth = 1;
    for (let A = 0; A < 6; A++) {
      let _ = y() * 7, M = 64 + Math.cos(_) * 14, E = 64 + Math.sin(_) * 14;
      v.beginPath(), v.moveTo(M, E);
      for (let w = 0; w < 5; w++) _ += (y() - 0.5) * 0.9, M += Math.cos(_) * 8, E += Math.sin(_) * 8, v.lineTo(M, E);
      v.stroke();
    }
    let m = v.createRadialGradient(64, 64, 1, 64, 64, 11);
    m.addColorStop(0, "rgba(18,17,16,1)"), m.addColorStop(1, "rgba(60,58,54,0.95)"), v.fillStyle = m, ra(v, 64, 64, 10, y, 0.3, 9), v.fill();
    for (let A = 0; A < 40; A++) {
      v.fillStyle = `rgba(${y() < 0.5 ? "90,86,80" : "190,186,176"},0.8)`;
      let _ = y() * 7, M = 10 + y() * 24;
      v.fillRect(64 + Math.cos(_) * M, 64 + Math.sin(_) * M, 1 + y() * 2, 1 + y() * 2);
    }
  }, { rough: 0.95, bleed: [168, 164, 154] }), scorch: () => r("scorch", 256, 256, (v, g, x, y) => {
    for (let b = 0; b < 40; b++) {
      let m = y() * 7, A = Math.pow(y(), 1.2) * g * 0.3, _ = g / 2 + Math.cos(m) * A, M = x / 2 + Math.sin(m) * A, E = g * (0.07 + y() * 0.15) * (1.2 - A / (g * 0.4)), w = v.createRadialGradient(_, M, 0, _, M, Math.max(4, E));
      w.addColorStop(0, `rgba(8,7,6,${0.3 + y() * 0.3})`), w.addColorStop(1, "rgba(8,7,6,0)"), v.fillStyle = w, v.fillRect(0, 0, g, x);
    }
    v.strokeStyle = "rgba(8,7,6,0.25)";
    for (let b = 0; b < 50; b++) {
      let m = y() * 7, A = g * 0.1, _ = g * (0.25 + y() * 0.22);
      v.lineWidth = 1 + y() * 3, v.beginPath(), v.moveTo(g / 2 + Math.cos(m) * A, x / 2 + Math.sin(m) * A), v.lineTo(g / 2 + Math.cos(m) * _, x / 2 + Math.sin(m) * _), v.stroke();
    }
  }, { rough: 0.95, bleed: [8, 7, 6] }), crack: () => r("crack", 256, 256, (v, g, x, y) => {
    v.lineCap = "round", v.lineJoin = "round";
    let b = (m, A, _, M, E, w) => {
      v.strokeStyle = `rgba(20,19,18,${0.6 + 0.35 * Math.min(1, E / 2.5)})`, v.lineWidth = E, v.beginPath(), v.moveTo(m, A);
      let S = Math.floor(M / 9);
      for (let z = 0; z < S; z++) _ += (y() - 0.5) * 0.8, m += Math.cos(_) * 9, A += Math.sin(_) * 9, v.lineTo(m, A), w > 0 && y() < 0.22 && (v.stroke(), b(m, A, _ + (y() < 0.5 ? 1 : -1) * (0.5 + y() * 0.7), M * (0.3 + y() * 0.3), E * 0.6, w - 1), v.strokeStyle = `rgba(20,19,18,${0.6 + 0.35 * Math.min(1, E / 2.5)})`, v.lineWidth = E, v.beginPath(), v.moveTo(m, A));
      v.stroke();
    };
    b(g * 0.5, x * 0.5, y() * 7, g * 0.42, 2.6, 3), b(g * 0.5, x * 0.5, y() * 7 + 2, g * 0.4, 2.2, 3), b(g * 0.5, x * 0.5, y() * 7 + 4, g * 0.36, 1.8, 2);
  }, { rough: 0.95, bleed: [20, 19, 18] }), graffiti_tag: () => r("graffiti_tag", 384, 256, (v, g, x, y) => {
    v.lineCap = "round", v.lineJoin = "round";
    let b = (_, M, E) => {
      v.strokeStyle = E, v.lineWidth = M, v.beginPath(), v.moveTo(_[0][0], _[0][1]);
      for (let w = 1; w < _.length - 1; w += 2) v.quadraticCurveTo(_[w][0], _[w][1], _[w + 1][0], _[w + 1][1]);
      v.stroke();
    }, m = "rgba(206,214,208,0.92)", A = [[[40, 60], [36, 130], [48, 200], [70, 150], [44, 128], [80, 110], [104, 70]], [[104, 70], [76, 140], [108, 190], [150, 200], [150, 110], [140, 60], [112, 84]], [[168, 196], [172, 120], [186, 62], [200, 110], [226, 92], [214, 150], [236, 196]], [[250, 76], [300, 60], [318, 66], [282, 110], [262, 178], [300, 200], [334, 176]]];
    for (let _ of A) b(_, 12, "rgba(206,214,208,0.25)"), b(_, 7, m);
    b([[30, 222], [180, 236], [352, 206]], 5, m), b([[330, 40], [344, 30], [356, 44]], 5, m);
    for (let _ = 0; _ < 7; _++) {
      let M = 50 + y() * 290, E = 150 + y() * 50, w = 12 + y() * 46, S = v.createLinearGradient(0, E, 0, E + w);
      S.addColorStop(0, m), S.addColorStop(1, "rgba(206,214,208,0)"), v.fillStyle = S, v.fillRect(M, E, 2 + y() * 2, w);
    }
    for (let _ = 0; _ < 260; _++) v.fillStyle = `rgba(206,214,208,${y() * 0.5})`, v.fillRect(30 + y() * 330, 40 + y() * 190, 1.2, 1.2);
    Ks(v, g, x, 0.25, y);
  }, { rough: 0.6, bleed: [206, 214, 208] }), csc_plate: () => r("csc_plate", 288, 200, (v, g, x, y) => {
    let b = v.createLinearGradient(0, 0, g, x);
    b.addColorStop(0, "rgb(150,152,150)"), b.addColorStop(0.5, "rgb(176,178,176)"), b.addColorStop(1, "rgb(138,140,138)"), v.fillStyle = b, v.beginPath(), v.roundRect ? v.roundRect(3, 3, g - 6, x - 6, 8) : v.rect(3, 3, g - 6, x - 6), v.fill(), v.strokeStyle = "rgba(40,42,44,0.8)", v.lineWidth = 2, v.strokeRect(11, 11, g - 22, x - 22);
    for (let [_, M] of [[20, 20], [g - 20, 20], [20, x - 20], [g - 20, x - 20]]) v.fillStyle = "rgb(96,98,98)", v.beginPath(), v.arc(_, M, 5, 0, 7), v.fill(), v.fillStyle = "rgba(230,232,232,0.7)", v.beginPath(), v.arc(_ - 1.2, M - 1.2, 2, 0, 7), v.fill();
    let m = "rgba(28,30,32,0.92)";
    qa(v, "SAFETY APPROVAL PLATE", g / 2, 46, 19, m, { font: "sans", weight: 600, align: "center", spacing: 1.5, maxW: g - 60 }), ["APPROVAL REF   SL/PA-4207/19", "DATE MANUFACTURED   03/2019", "IDENT NO   SLTU 402719 6", "MAX GROSS   30 480 KG", "STACKING LOAD   192 000 KG", "RACKING TEST   150 KN", "NEXT EXAM   09/2027"].forEach((_, M) => {
      qa(v, _, 30, 70 + M * 16.5, 11, m, { font: "mono", weight: 500, spacing: 0, maxW: g - 60 }), v.fillStyle = "rgba(28,30,32,0.35)", v.fillRect(30, 73 + M * 16.5, g - 60, 1);
    }), v.fillStyle = "rgba(60,40,24,0.25)";
    for (let _ = 0; _ < 30; _++) ra(v, y() * g, y() * x, 2 + y() * 9, y, 0.5, 7), v.fill();
  }, { rough: 0.45, metal: 0.75, text: true }), numbers_0_9: () => r("numbers_0_9", 640, 128, (v, g, x, y) => {
    for (let b = 0; b < 10; b++) qa(v, String(b), b * 64 + 32, x * 0.86, x * 0.92, An(Ut.white), { align: "center", weight: 900, maxW: 54 });
    Ks(v, g, x, 0.3, y);
  }, { bleed: Ut.white, text: true }) }, u = Object.keys(c), h = /* @__PURE__ */ new Set();
  function f(v) {
    let g = t.get("d:" + v);
    if (g) return g;
    let x = c[v];
    if (!x) h.has(v) || (h.add(v), console.warn(`[mats] unknown decal "${v}"`)), g = f("grime_streak");
    else {
      let y = x();
      g = { material: y.material, aspect: y.aspect }, g.material.name = "decal_" + v;
    }
    return t.set("d:" + v, g), g;
  }
  function p(v) {
    let g = "n:" + v, x = t.get(g);
    if (x) return x;
    let y = f("numbers_0_9").material, b = y.map.clone();
    b.repeat.set(0.1, 1), b.offset.set(Math.abs(v | 0) % 10 / 10, 0), b.needsUpdate = true;
    let m = y.clone();
    return m.map = b, n.push(() => {
      b.needsUpdate = true;
    }), x = { material: m, aspect: 0.5 }, t.set(g, x), x;
  }
  function d(v, g = {}) {
    v = String(v === void 0 ? "" : v).toUpperCase() || " ";
    let x = Ut[g.color] ? g.color : "white", y = g.font === "sans" ? "sans" : "stencil", b = g.distress !== void 0 ? +g.distress : 0.35, m = `l:${v}|${x}|${y}|${b}`, A = t.get(m);
    if (A) return A;
    let _ = 128, M = 100, E = makeCanvas(4, 4).getContext("2d"), w = y === "sans" ? r3 : o3, S = y === "sans" ? 600 : 700, z = M * 0.06, H = a3(E, v, M, w, S, z), O = Math.min(1, 2e3 / (H + 32)), q = Math.max(48, Math.ceil((H + 32) * O)), U = Math.ceil(_ * O), T = r(m, q, U, (D, C, G, j) => {
      D.save(), D.scale(O, O), qa(D, v, 16, _ * 0.84, M, An(Ut[x]), { font: y, weight: S, spacing: z, fitW: H }), D.restore(), Ks(D, C, G, b, j);
    }, { bleed: Ut[x], text: true, rough: 0.65 });
    return A = { material: T.material, aspect: T.aspect }, A.material.name = "label", t.set(m, A), A;
  }
  try {
    if (typeof document < "u" && document.fonts && document.fonts.load) {
      let v = 0, g = () => {
        v = 0;
        for (let x of n) try {
          x();
        } catch {
        }
      };
      for (let x of ['700 20px "Big Shoulders Display"', '900 20px "Big Shoulders Display"', '600 20px "Barlow Condensed"', '500 20px "IBM Plex Mono"']) document.fonts.load(x).then((y) => {
        y && y.length && !v && (v = setTimeout(g, 120));
      }, () => {
      });
    }
  } catch {
  }
  return { decal: f, label: d, number: p, names: u, bytes: () => s };
}
var TEXTURE_SETS = { asphalt: { fn: "asphalt", size: 1, tile: 2, bump: 1.6, hero: true }, concrete: { fn: "concrete", size: 1, tile: 3, bump: 2.5 }, brick: { fn: "brick", size: 0.5, tile: 1.8, bump: 6 }, epoxy: { fn: "epoxy", size: 0.5, tile: 4, bump: 3 }, paint: { fn: "paint", size: 1, tile: 2.5, bump: 2.5, p: [0.5] }, hull: { fn: "hull", size: 0.5, tile: 4, bump: 12 }, galv: { fn: "galv", size: 0.5, tile: 1, bump: 0.8 }, metal: { fn: "metal", size: 0.5, tile: 1, bump: 0.5, p: [1] }, brushed: { fn: "brushed", size: 0.5, tile: 0.5, bump: 0.4 }, rust: { fn: "rust", size: 0.5, tile: 1.2, bump: 3 }, diamond: { fn: "diamond", size: 0.5, tile: 0.5, bump: 2 }, corrugated: { fn: "corrugated", size: 0.5, tile: [0.762, 2.286], bump: 19 }, chainlink: { fn: "chainlink", size: 0.5, tile: 0.5, bump: 5 }, hazard: { fn: "hazard", size: 0.5, tile: 1, bump: 2.5 }, gunmetal: { fn: "gunmetal", size: 0.5, tile: 0.25, bump: 0.3, p: [0.6] }, anodized: { fn: "gunmetal", size: 0.5, tile: 0.25, bump: 0.25, p: [0.2], seed: 11 }, polymer: { fn: "polymer", size: 0.25, tile: 0.1, bump: 0.4 }, carbon: { fn: "carbon", size: 0.25, tile: 0.05, bump: 0.5 }, fabric: { fn: "fabric", size: 0.25, tile: 0.05, bump: 0.4 }, armor: { fn: "armor", size: 0.5, tile: 0.5, bump: 0.8 }, wood: { fn: "wood", size: 0.5, tile: 1.2, bump: 2.6 }, plastic: { fn: "plastic", size: 0.5, tile: 1, bump: 1 }, tarp: { fn: "tarp", size: 0.5, tile: 1.5, bump: 20 }, cardboard: { fn: "cardboard", size: 0.5, tile: 1, bump: 0.8 }, rope: { fn: "rope", size: 0.25, tile: 0.1, bump: 4 }, tire: { fn: "tire", size: 0.5, tile: [0.5, 0.3], bump: 7 }, glass: { fn: "glass", size: 0.5, tile: 1.5, bump: 1.5, p: [0.3] }, glass_dirty: { fn: "glass", size: 0.5, tile: 1.5, bump: 1.5, p: [1], seed: 40 }, water: { fn: "water", size: 0.25, tile: 4, bump: 30 } }, cA = [0.42, 0.38, 0.5, 0], kc = [0.05, 0.62, 0.65, 0.7], aa = [0, 0.7, 0.55, 0.5], uA = [0.3, 0.6, 0.55, 0], i1 = [0.08, 0.62, 0.6, 0.5], u3 = [0.4, 0.5, 0.6, 0], s1 = [0, 1, 0, 0], o1 = [0.22, 0.12, 0.35, 0.35], hA = [0.14, 0.1, 0.8, 0.2], r1 = [0.07, 0.06, 3, 0], a1 = [0, 0, 1, 0], materialDef = (i, e = {}) => ({ set: i, tint: 0, color: 16777215, rough: 1, metal: 1, wet: cA, macro: hA, nrm: 1, ...e }), paintDef = (i) => materialDef("paint", { tint: 1, color: i, wet: kc, macro: [0.2, 0.16, 0.4, 0.45] }), MATERIALS = { asphalt: materialDef("asphalt", { wet: [0.45, 0.3, 0.5, 0], macro: o1 }), concrete: materialDef("concrete", { macro: o1 }), concrete_dirty: materialDef("concrete", { color: 13616822, macro: [0.3, 0.15, 0.35, 0.9] }), concrete_painted: materialDef("concrete", { tint: 2, color: 9343638, rough: 0.9, wet: [0.15, 0.55, 0.6, 0.3], macro: [0.14, 0.1, 0.5, 0.3] }), brick: materialDef("brick"), floor_epoxy: materialDef("epoxy", { wet: [0.04, 0.75, 0.4, 0], macro: [0.12, 0.2, 0.45, 0.25] }), paint_red: paintDef(8200729), paint_blue: paintDef(2047846), paint_green: paintDef(2906692), paint_yellow: paintDef(12159516), paint_orange: paintDef(11751962), paint_white: paintDef(12172214), paint_grey: paintDef(5922920), paint_teal: paintDef(2055523), steel_galv: materialDef("galv", { wet: aa }), steel_dark: materialDef("metal", { tint: 1, color: 4014406, rough: 1.15, wet: aa }), steel_worn: materialDef("metal", { tint: 1, color: 9080466, rough: 0.9, wet: aa }), steel_bare: materialDef("brushed", { tint: 1, color: 11843771, wet: aa, macro: r1 }), steel_rust: materialDef("rust", { wet: uA }), diamond_plate: materialDef("diamond", { wet: aa }), corrugated_roof: materialDef("corrugated", { wet: aa }), chainlink: materialDef("chainlink", { tint: 3, alphaCut: true, side: 2, wet: s1, macro: a1 }), aluminium: materialDef("brushed", { tint: 1, color: 12896459, rough: 1.15, wet: aa, macro: r1 }), brass: materialDef("brushed", { tint: 1, color: 12753477, rough: 0.9, wet: aa, macro: [0.1, 0.08, 20, 0] }), hazard_stripes: materialDef("hazard", { wet: kc }), gunmetal: materialDef("gunmetal", { tint: 1, color: 2764081, wet: [0, 0.75, 0.6, 0.5], macro: [0.08, 0.06, 6, 0] }), anodized_black: materialDef("anodized", { tint: 1, color: 1184790, rough: 0.72, metal: 0.9, wet: [0, 0.75, 0.6, 0.5], macro: [0.06, 0.05, 6, 0] }), polymer_black: materialDef("polymer", { tint: 1, color: 1513498, wet: [0, 0.7, 0.6, 0.5], macro: [0.06, 0.06, 6, 0] }), polymer_tan: materialDef("polymer", { tint: 1, color: 7299144, wet: [0, 0.7, 0.6, 0.5], macro: [0.06, 0.06, 6, 0] }), rubber: materialDef("polymer", { tint: 1, color: 1052688, rough: 1.4, wet: [0.05, 0.6, 0.6, 0.4], macro: [0.06, 0.06, 6, 0] }), carbon: materialDef("carbon", { wet: [0, 0.8, 0.6, 0.5], macro: [0.05, 0.05, 6, 0] }), glove_fabric: materialDef("fabric", { tint: 1, color: 2303530, wet: [0.3, 0.7, 0.6, 0], macro: [0.08, 0.04, 8, 0] }), armor_white: materialDef("armor", { tint: 1, color: 11449528, wet: kc, macro: [0.08, 0.08, 2.5, 0.15] }), armor_orange: materialDef("armor", { tint: 1, color: 12670234, wet: kc, macro: [0.08, 0.08, 2.5, 0.15] }), wood_pallet: materialDef("wood", { wet: u3, macro: [0.2, 0.1, 0.9, 0.4] }), wood_dark: materialDef("wood", { color: 9074794, wet: u3, macro: [0.2, 0.1, 0.9, 0.4] }), plastic_blue: materialDef("plastic", { tint: 1, color: 1920134, wet: i1 }), plastic_red: materialDef("plastic", { tint: 1, color: 9314074, wet: i1 }), plastic_grey: materialDef("plastic", { tint: 1, color: 4935508, wet: i1 }), tarp: materialDef("tarp", { tint: 1, color: 3885626, wet: i1, macro: [0.1, 0.1, 1.2, 0.2] }), cardboard: materialDef("cardboard", { wet: [0.4, 0.75, 0.6, 0] }), rope: materialDef("rope", { macro: r1 }), tire: materialDef("tire", { wet: [0.1, 0.6, 0.6, 0.3], macro: r1 }), glass: materialDef("glass", { tint: 3, transparent: true, wet: s1, macro: a1 }), glass_dirty: materialDef("glass_dirty", { tint: 3, transparent: true, wet: s1, macro: a1 }), hull_paint: materialDef("hull", { tint: 1, color: 1778219, wet: kc, macro: o1 }), hull_red: materialDef("hull", { tint: 1, color: 6233880, wet: kc, macro: o1 }), water_dark: materialDef("water", { wet: s1, macro: a1 }) }, FALLBACK_MATERIAL = materialDef("metal", { tint: 1, color: 8027520, wet: aa }), PATCH_VERT_PARS = `
varying vec3 vSlPos;
#ifdef SL_TRIPLANAR
varying vec3 vSlONrm; varying vec3 vSlAx; varying vec3 vSlAy;
#endif
`, PATCH_VERT_MAIN = `
#ifdef SL_TRIPLANAR
  vSlPos = position; vSlONrm = normal;
  vec3 slAx = vec3(1.0, 0.0, 0.0), slAy = vec3(0.0, 1.0, 0.0);
  #ifdef USE_SKINNING
    slAx = (skinMatrix * vec4(slAx, 0.0)).xyz; slAy = (skinMatrix * vec4(slAy, 0.0)).xyz;
  #endif
  #ifdef USE_INSTANCING
    slAx = mat3(instanceMatrix) * slAx; slAy = mat3(instanceMatrix) * slAy;
  #endif
  vSlAx = normalize(mat3(modelViewMatrix) * slAx); vSlAy = normalize(mat3(modelViewMatrix) * slAy);
#else
  vec4 slWP = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    slWP = instanceMatrix * slWP;
  #endif
  vSlPos = (modelMatrix * slWP).xyz;
#endif
`, PATCH_FRAG_PARS = `
uniform float uSlWet; uniform vec4 uSlWetP; uniform vec4 uSlMacro; uniform vec3 uSlUv; uniform vec2 uSlX;
varying vec3 vSlPos;
#ifdef SL_TRIPLANAR
varying vec3 vSlONrm; varying vec3 vSlAx; varying vec3 vSlAy;
vec3 slTw; vec2 slUx; vec2 slUy; vec2 slUz;
vec4 slTri(sampler2D t){ return texture2D(t, slUx) * slTw.x + texture2D(t, slUy) * slTw.y + texture2D(t, slUz) * slTw.z; }
#endif
vec4 slORM; vec2 slUv; float slWetK = 0.0; float slUp = 0.0; float slMac = 0.5; float slMac2 = 0.5; float slBead = 0.0;
float slH(vec3 p){ p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float slN3(vec3 x){
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(slH(i), slH(i + vec3(1.0, 0.0, 0.0)), f.x), mix(slH(i + vec3(0.0, 1.0, 0.0)), slH(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(slH(i + vec3(0.0, 0.0, 1.0)), slH(i + vec3(1.0, 0.0, 1.0)), f.x), mix(slH(i + vec3(0.0, 1.0, 1.0)), slH(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}
`, PATCH_MAP_FRAGMENT = `
#ifdef SL_TRIPLANAR
  { vec3 slOn = normalize(vSlONrm); vec3 slW3 = pow(abs(slOn), vec3(6.0)); slTw = slW3 / (slW3.x + slW3.y + slW3.z);
    vec3 slQ = vSlPos * uSlUv.z; slUx = slQ.zy; slUy = slQ.xz; slUz = slQ.xy; }
  vec4 sampledDiffuseColor = slTri(map);
  slORM = slTri(roughnessMap);
#else
  slUv = vMapUv * uSlUv.xy;
  vec4 sampledDiffuseColor = texture2D(map, slUv);
  slORM = texture2D(roughnessMap, slUv);
#endif
#ifdef SL_FX
  {
    #ifdef FLAT_SHADED
      vec3 slVN = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
    #else
      vec3 slVN = normalize(vNormal);
      #ifdef DOUBLE_SIDED
        slVN *= gl_FrontFacing ? 1.0 : -1.0;
      #endif
    #endif
    vec3 slWN = inverseTransformDirection(slVN, viewMatrix);
    vec3 slMp = vSlPos * uSlMacro.z;
    slMac = slN3(slMp); slMac2 = slN3(slMp * 3.7 + 11.3);
    float slM = slMac * 0.65 + slMac2 * 0.35 - 0.5;
    sampledDiffuseColor.rgb *= 1.0 + uSlMacro.x * slM * 2.0;
    float slGr = smoothstep(0.5, 0.85, slMac * 0.6 + slMac2 * 0.4 + (1.0 - slORM.r) * 0.3) * uSlMacro.w;
    sampledDiffuseColor.rgb *= 1.0 - slGr * 0.35;
    #if SL_TINT == 1
      sampledDiffuseColor.a *= 1.0 - slGr * 0.2;
    #endif
    // rain wetness: strongest on up-facing faces, streaky on verticals, none underneath
    slUp = smoothstep(0.15, 0.85, slWN.y);
    float slExpo = smoothstep(-0.4, -0.05, slWN.y);
    float slStreak = 0.0;
    #ifndef SL_TRIPLANAR
      float slSc = vSlPos.x + vSlPos.z;
      slStreak = slN3(vec3(slSc * 9.0, vSlPos.y * 0.55, slSc * 0.7 + 3.0)) * slN3(vec3(slSc * 29.0, vSlPos.y * 1.1, 7.0));
      slStreak = smoothstep(0.12, 0.42, slStreak) * smoothstep(0.3, 0.7, slN3(vec3(slSc * 1.1, vSlPos.y * 0.25, 1.7)));
    #endif
    float slW = uSlWet * uSlX.x * slExpo;
    slWetK = slW * mix(uSlWetP.z * (0.55 + 0.9 * slStreak), 0.75 + 0.5 * slMac, slUp);
    #ifndef SL_TRIPLANAR
      { float slLow = smoothstep(0.5, 0.0, vSlPos.y) * (1.0 - slUp) * slExpo;        // damp, splashed band where things meet the ground
        slWetK += slW * slLow * 0.6;
        float slLg = 1.0 - slLow * min(uSlMacro.w, 0.5) * 0.45;
        sampledDiffuseColor.rgb *= slLg;
        #if SL_TINT == 1
          sampledDiffuseColor.a *= slLg;
        #endif
      }
    #endif
    slWetK = clamp(slWetK, 0.0, 1.0);
    float slBf = clamp(1.0 - length(fwidth(vSlPos)) * 120.0, 0.0, 1.0);
    if (uSlWetP.w > 0.0 && slBf > 0.0) {
      float slB = slN3(vSlPos * 170.0) * 0.6 + slN3(vSlPos * 410.0 + 5.0) * 0.4;
      slBead = smoothstep(0.6, 0.68, slB) * uSlWetP.w * slW * slBf * (0.4 + 0.6 * slUp + 0.5 * slStreak);
    }
  }
#endif
#if SL_TINT == 1
  diffuseColor.rgb = sampledDiffuseColor.rgb + diffuse * sampledDiffuseColor.a;
#elif SL_TINT == 2
  { float slL = clamp(dot(sampledDiffuseColor.rgb, vec3(0.3333)) / 0.19, 0.55, 1.35);
    diffuseColor.rgb = mix(sampledDiffuseColor.rgb, diffuse * slL, sampledDiffuseColor.a * 0.96); }
#elif SL_TINT == 3
  diffuseColor *= sampledDiffuseColor;
#else
  diffuseColor.rgb *= sampledDiffuseColor.rgb;
#endif
#ifdef SL_FX
  { float slLum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
    diffuseColor.rgb = mix(vec3(slLum), diffuseColor.rgb, 1.0 + 0.25 * slWetK * uSlWetP.x * 2.0);
    diffuseColor.rgb *= 1.0 - uSlWetP.x * slWetK; }
#endif
#ifdef SL_ACUT
  // alpha-tested wire mesh that survives distance: wires stay ~1 px wide through the mips (lowered threshold),
  // then dissolve into a stable ~1/3-coverage dither veil once the diamonds themselves are sub-pixel.
  { vec2 slFw = fwidth(slUv) * 512.0; float slLod = log2(max(max(slFw.x, slFw.y), 1e-4));
    float slThC = 0.5 * exp2(-clamp(slLod - 1.0, 0.0, 4.0));
    float slIgn = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    float slTh = mix(slThC, 0.05 + slIgn * 0.80, smoothstep(3.5, 5.5, slLod));
    diffuseColor.a = sampledDiffuseColor.a > slTh ? 1.0 : 0.0;
    // sub-pixel wires: the surviving fragments stand in for a much thinner wire, so dim them (no white sheets in the sun)
    diffuseColor.rgb *= mix(1.0, 0.45, smoothstep(1.5, 4.5, slLod)); }
#endif
`, PATCH_ROUGHNESS_FRAGMENT = `
float roughnessFactor = roughness * slORM.g;
#ifdef SL_FX
  roughnessFactor += uSlMacro.y * ((slMac2 - 0.5) * 1.4 + (slMac - 0.5) * 0.8);
  roughnessFactor = mix(roughnessFactor, roughnessFactor * uSlWetP.y, slWetK);
  roughnessFactor = mix(roughnessFactor, 0.05, slBead);
#endif
#if defined( USE_NORMALMAP_TANGENTSPACE ) && !defined( SL_TRIPLANAR )
  { float slNl = length(texture2D(normalMap, slUv).xyz * 2.0 - 1.0);
    roughnessFactor = sqrt(roughnessFactor * roughnessFactor + clamp(1.0 - slNl, 0.0, 1.0) * 0.6); }
#endif
roughnessFactor = clamp(roughnessFactor, 0.045, 1.0);
`, PATCH_METALNESS_FRAGMENT = `
float metalnessFactor = metalness * slORM.b;
`, PATCH_NORMAL_FRAGMENT = `
#ifdef SL_TRIPLANAR
  { vec3 slOn = normalize(vSlONrm);
    vec3 slTx = texture2D(normalMap, slUx).xyz * 2.0 - 1.0, slTy = texture2D(normalMap, slUy).xyz * 2.0 - 1.0, slTz = texture2D(normalMap, slUz).xyz * 2.0 - 1.0;
    slTx.xy *= normalScale; slTy.xy *= normalScale; slTz.xy *= normalScale;
    slTx = vec3(slTx.xy + slOn.zy, abs(slTx.z) * slOn.x); slTy = vec3(slTy.xy + slOn.xz, abs(slTy.z) * slOn.y); slTz = vec3(slTz.xy + slOn.xy, abs(slTz.z) * slOn.z);
    vec3 slNo = normalize(slTx.zyx * slTw.x + slTy.xzy * slTw.y + slTz.xyz * slTw.z);
    vec3 slA = normalize(vSlAx), slB = normalize(vSlAy); vec3 slC = cross(slA, slB);
    normal = normalize(slA * slNo.x + slB * slNo.y + slC * slNo.z);
    #ifdef DOUBLE_SIDED
      normal *= faceDirection;
    #endif
  }
#elif defined( USE_NORMALMAP_TANGENTSPACE )
  { vec3 mapN = texture2D(normalMap, slUv).xyz * 2.0 - 1.0;
    mapN.xy *= normalScale * (1.0 - 0.45 * slWetK * slUp);
    normal = normalize(tbn * mapN); }
#endif
`, PATCH_AO_FRAGMENT = THREE.ShaderChunk.aomap_fragment.replace("texture2D( aoMap, vAoMapUv ).r", "slORM.r");
function applySaltlinePatch(i, e) {
  Object.assign(i.uniforms, e), i.vertexShader = i.vertexShader.replace("#include <common>", `#include <common>
` + PATCH_VERT_PARS).replace("#include <project_vertex>", `#include <project_vertex>
` + PATCH_VERT_MAIN), i.fragmentShader = i.fragmentShader.replace("#include <common>", `#include <common>
` + PATCH_FRAG_PARS).replace("#include <map_fragment>", PATCH_MAP_FRAGMENT).replace("#include <roughnessmap_fragment>", PATCH_ROUGHNESS_FRAGMENT).replace("#include <metalnessmap_fragment>", PATCH_METALNESS_FRAGMENT).replace("#include <normal_fragment_maps>", PATCH_NORMAL_FRAGMENT).replace("#include <aomap_fragment>", PATCH_AO_FRAGMENT);
}
function createSaltlineMaterials(i) {
  let e = i.renderer || i.render && i.render.renderer, t = i.params || {}, n = +(t.tex || 0) || i.quality && i.quality.tex || 1024, s = Math.min(n, 1024), o = Math.min(8, e.capabilities.getMaxAnisotropy ? e.capabilities.getMaxAnisotropy() : 1), r = { wet: { value: t.wet !== void 0 ? +t.wet : 1 } }, a = { sets: 0, bytes: 0, ms: 0 }, l = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), c = new THREE.Scene(), u = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  u.frustumCulled = false, c.add(u);
  let h = /* @__PURE__ */ new Map(), f = /* @__PURE__ */ new Map(), p = /* @__PURE__ */ new Map(), d = 0, v = null, g = (O, q) => new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: BAKE_VERT, fragmentShader: O, uniforms: q, depthTest: false, depthWrite: false });
  function x() {
    return v || (v = { normal: g(NORMAL_FROM_HEIGHT_FRAG, { tH: { value: null }, uK: { value: new THREE.Vector2() }, uTexel: { value: 0 } }), copy: g(COPY_FRAG, { tA: { value: null }, uSq: { value: 0 } }) }), v;
  }
  function y(O, q) {
    u.material = q, e.setRenderTarget(O), e.render(c, l);
  }
  function b(O, q) {
    let U = new THREE.WebGLRenderTarget(O, O, { depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, anisotropy: o, colorSpace: q ? THREE.SRGBColorSpace : THREE.NoColorSpace });
    return a.bytes += O * O * 4 * 1.34, U;
  }
  function m(O) {
    let q = Math.round(s * O.size);
    return O.hero && n >= 2048 && (q = 2048), Math.max(32, q);
  }
  function A(O) {
    let q = p.get(O);
    if (q) return q;
    let U = TEXTURE_SETS[O], T = performance.now(), D = m(U), C = Array.isArray(U.tile) ? U.tile : [U.tile, U.tile], G = h.get(D);
    G || (G = new THREE.WebGLRenderTarget(D, D, { count: 3, depthBuffer: false, generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping }), h.set(D, G));
    let j = f.get(U.fn);
    j || (j = g(BAKE_FRAG_HEAD + SET_SHADERS[U.fn] + BAKE_FRAG_TAIL, { uP: { value: new THREE.Vector4() }, uSeed: { value: 0 }, uTexel: { value: 0 } }), f.set(U.fn, j));
    let N = U.p || [];
    j.uniforms.uP.value.set(N[0] || 0, N[1] || 0, N[2] || 0, N[3] || 0), j.uniforms.uSeed.value = U.seed || 0, j.uniforms.uTexel.value = 1 / D;
    let Q = x(), K = e.getRenderTarget(), ie = e.autoClear, F = e.xr.enabled, X = e.shadowMap.autoUpdate;
    e.autoClear = true, e.xr.enabled = false, e.shadowMap.autoUpdate = false, y(G, j);
    let ne = b(D, true), re = b(D, false), $ = b(D, false);
    Q.copy.uniforms.tA.value = G.textures[0], Q.copy.uniforms.uSq.value = 1, y(ne, Q.copy), Q.copy.uniforms.tA.value = G.textures[1], Q.copy.uniforms.uSq.value = 0, y(re, Q.copy), Q.normal.uniforms.tH.value = G.textures[2], Q.normal.uniforms.uTexel.value = 1 / D, Q.normal.uniforms.uK.value.set(U.bump * 1e-3 * D / C[0], U.bump * 1e-3 * D / C[1]), y($, Q.normal), e.setRenderTarget(K), e.autoClear = ie, e.xr.enabled = F, e.shadowMap.autoUpdate = X;
    for (let ue of [ne, re, $]) ue.texture.repeat.set(1 / C[0], 1 / C[1]), ue.texture.name = "sl_" + O;
    return q = { key: O, albedo: ne.texture, orm: re.texture, normal: $.texture, tile: C, size: D, targets: [ne, re, $] }, p.set(O, q), a.sets++, a.ms += performance.now() - T, d = performance.now(), q;
  }
  function _() {
    for (let O of h.values()) O.dispose();
    h.clear();
    for (let O of f.values()) O.dispose();
    f.clear();
  }
  let M = /* @__PURE__ */ new Map(), E = /* @__PURE__ */ new Set();
  function w(O, q = {}) {
    let U = O + "|" + (q.vertexColors ? "v" : "") + (q.triplanar ? "t" + (q.scale || 1) : "") + (q.doubleSide ? "d" : "") + (q.interior ? "i" : "") + (q.color !== void 0 ? "c" + q.color : ""), T = M.get(U);
    if (T) return T;
    let D = MATERIALS[O];
    D || (E.has(O) || (E.add(O), console.warn(`[mats] unknown material "${O}" \u2014 using fallback`)), D = FALLBACK_MATERIAL);
    let C;
    try {
      C = A(D.set);
    } catch (K) {
      return E.has("gen:" + D.set) || (E.add("gen:" + D.set), console.error(`[mats] texture set "${D.set}" failed: ${K && K.message || K}`)), T = new THREE.MeshStandardMaterial({ color: q.color !== void 0 ? q.color : D.tint ? D.color : 8421504, roughness: 0.6, metalness: 0, vertexColors: !!q.vertexColors }), T.name = O, M.set(U, T), T;
    }
    let G = !!q.triplanar, j = !D.transparent && !D.alphaCut;
    T = new THREE.MeshStandardMaterial({ map: C.albedo, normalMap: C.normal, roughnessMap: C.orm, metalnessMap: C.orm, aoMap: C.orm, color: q.color !== void 0 ? q.color : D.color, roughness: D.rough, metalness: D.metal, vertexColors: !!q.vertexColors }), T.normalScale.set(D.nrm, D.nrm), T.name = O, (q.doubleSide || D.side === 2) && (T.side = THREE.DoubleSide), D.transparent && (T.transparent = true, T.depthWrite = false, T.envMapIntensity = 1.4), D.alphaCut && (T.alphaTest = 0.5), T.defines = { ...T.defines, SL_TINT: D.tint }, G && (T.defines.SL_TRIPLANAR = ""), j && (T.defines.SL_FX = ""), D.alphaCut && !G && (T.defines.SL_ACUT = "");
    let N = { uSlWet: r.wet, uSlWetP: { value: new THREE.Vector4(...D.wet) }, uSlMacro: { value: new THREE.Vector4(...D.macro) }, uSlUv: { value: new THREE.Vector3(1, 1, G ? (q.scale || 1) / C.tile[0] : C.size) }, uSlX: { value: new THREE.Vector2(q.interior ? 0.12 : 1, 0) } };
    T.userData.sl = N, T.userData.set = C.key, T.userData.tile = C.tile, q.interior && (T.userData.interior = true), T.onBeforeCompile = (K) => applySaltlinePatch(K, N);
    let Q = "sl2|" + D.tint + (G ? "t" : "") + (j ? "f" : "") + (D.alphaCut ? "a" : "");
    return T.customProgramCacheKey = () => Q, M.set(U, T), T;
  }
  function S(O = 16777215, q = 4) {
    let U = "em|" + O + "|" + q;
    if (M.has(U)) return M.get(U);
    let T = new THREE.MeshBasicMaterial({ color: new THREE.Color(O).multiplyScalar(q), toneMapped: true });
    return T.name = "emissive", M.set(U, T), T;
  }
  let z = createDecalLibrary(i, o);
  // [深空] Bake the texture sets behind `names` without stalling a frame: the
  // bake programs are compiled with compileAsync (parallel shader compile)
  // first, so the bakes that follow are only a few quad draws.
  async function prepareAsync(names) {
    const sets = [...new Set(names.map((name) => (MATERIALS[name] || FALLBACK_MATERIAL).set))].filter((set) => !p.has(set));
    if (!sets.length) return;
    const scene = new THREE.Scene(), Q = x();
    for (const mat of [Q.copy, Q.normal]) { const q = new THREE.Mesh(u.geometry, mat); q.frustumCulled = false; scene.add(q); }
    for (const set of sets) {
      const U = TEXTURE_SETS[set];
      let j = f.get(U.fn);
      j || (j = g(BAKE_FRAG_HEAD + SET_SHADERS[U.fn] + BAKE_FRAG_TAIL, { uP: { value: new THREE.Vector4() }, uSeed: { value: 0 }, uTexel: { value: 0 } }), f.set(U.fn, j));
      const q = new THREE.Mesh(u.geometry, j); q.frustumCulled = false; scene.add(q);
    }
    if (e.compileAsync) await e.compileAsync(scene, l);
    for (const set of sets) A(set);
  }
  return { get: w, emissive: S, prepareAsync, hasBaked(O) {
    let D = MATERIALS[O] || FALLBACK_MATERIAL;
    return p.has(D.set);
  }, decal: z.decal, label: z.label, number: z.number, names: Object.keys(MATERIALS), decalNames: z.names, uniforms: r, update(O) {
    h.size && performance.now() - d > 4e3 && _();
  }, prewarm(O) {
    for (let q of O || Object.keys(MATERIALS)) w(q);
  }, stats() {
    return { sets: a.sets, textureMB: +(a.bytes / 1048576).toFixed(1), genMs: +a.ms.toFixed(0), decalMB: +(z.bytes() / 1048576).toFixed(1) };
  }, tileOf(O) {
    let q = MATERIALS[O];
    return q ? TEXTURE_SETS[q.set].tile : 1;
  } };
}

export { createSaltlineMaterials, MATERIALS, TEXTURE_SETS };
