// Material library — ported 1:1 from 3aaa-spaceship-flight-prototype/src/game/materials.ts
// (types stripped only; logic, constants and comments unchanged).
import * as THREE from 'three';
import { screenTexture, gradientStrip } from './textures.js';
import { loadBaked, dress } from './baked.js';

/* ------------------------------------------------------------------ *
 *  TILING SCALE
 *
 *  buildLoft() writes UVs as ARC LENGTH IN METRES / uvScale, so one UV
 *  unit is `uvScale` metres and a physically correct repeat is
 *  `uvScale / tileMetres`.  The panel tile is 2.0 m and the deck tile
 *  1.5 m, which is where these numbers come from — they are not taste.
 *
 *  bevelBox() and the other prims write NORMALISED 0..1 UVs per part, so
 *  a 10 cm trim bar and a 2 m panel both get one full tile.  Stamping a
 *  whole plate layout with welds and stencils onto a 10 cm bar looks
 *  wrong, so parts that are mostly small prims take `micro`: the normal
 *  and ORM maps only, for prefiltered surface relief and baked cavity
 *  roughness, with `color` alone carrying the look.  Surfaces that are
 *  mostly lofted skin take `full`, albedo included.
 * ------------------------------------------------------------------ */
const PANEL_M = 2.0;
const DECK_M = 1.5;

/* ------------------------------------------------------------------ *
 *  THE PALETTE  —  and why almost every number here changed.
 *
 *  These are lifted from TheLongSilence's own material review, which is
 *  worth stating because they look arbitrary and are not.  Three findings
 *  from that review each describe something this project was doing:
 *
 *  1  PAINT IS NOT METAL.  Everything here was authored at metalness
 *     0.85-0.98, including interior wall liner and deck plate.  A metal
 *     surface has NO diffuse term: it returns a specular reflection of
 *     the environment and nothing else, and a smooth bright environment
 *     turns that into a uniform glossy sheen with no material identity.
 *     That is the "shiny plastic / toy" read, and no amount of texture
 *     fixes it.  Painted surfaces are now metalness 0.0, and bare alloy
 *     appears only where the bake says the paint is rubbed through (see
 *     `bare` in baked.js, which makes the ORM's B channel ADDITIVE).
 *
 *  2  DARK ALBEDO IS A TRAP.  0x23-0x4c is 1.6%-8% linear reflectance.
 *     Coal is 4%.  No amount of light rescues a room built out of coal,
 *     and real crewed volumes are painted pale precisely so a dropped
 *     bolt can be found.  So the interior gets PALER here, not darker —
 *     the first pass of this rewrite darkened it and that was wrong.
 *
 *  3  ONE HUE READS AS A TEXTURE PASS, NOT AN OBJECT.  This ship was
 *     blue-grey end to end.  The families below are deliberately split
 *     into a warm painted half (bone/sand), a near-neutral cool machined
 *     half, one muted oxide accent, and exactly ONE material allowed a
 *     real highlight (`brushed`, anodised alloy).  That highlight only
 *     reads as metal because everything around it is three times rougher
 *     — which is also why each family gets its own roughness FLOOR
 *     rather than a multiply.
 *
 *  envMapIntensity is likewise 0.1-0.35 rather than the old 0.6-1.5.
 *  The environment here is a smooth procedural probe; leaning on it is
 *  what produced the even plastic sheen in the first place.
 * ------------------------------------------------------------------ */

/** painted, dielectric, with a roughness floor.  The dominant surface. */
const paint = (
  color, rough, env,
  set, rep,
  o,
) => dress(new THREE.MeshStandardMaterial({
  color, metalness: 0, roughness: rough, envMapIntensity: env,
}), set, {
  rep, normalScale: o.ns ?? 1, ao: o.ao ?? 1, micro: o.micro, albRep: o.albRep,
  roughLo: o.lo, roughHi: o.hi, bare: o.bare ?? 0,
  cav: o.cav ?? 0.9, edge: o.edge ?? 0.30, edgeTint: o.edgeTint,
  macro: o.macro ?? 0, macroScale: o.macroScale ?? 3.0,
  microRep: o.microRep ?? 0, microN: o.microN, microR: o.microR,
});

/** anodised / machined alloy: a real but narrow highlight over a diffuse term */
const alloy = (
  color, metal, rough, env,
  set, rep,
  o,
) => dress(new THREE.MeshStandardMaterial({
  color, metalness: metal, roughness: rough, envMapIntensity: env,
}), set, {
  rep, normalScale: o.ns ?? 0.6, ao: o.ao ?? 0.6, micro: o.micro, albRep: o.albRep,
  roughLo: o.lo, roughHi: o.hi, bare: 0.001,
  cav: o.cav ?? 0.85, edge: o.edge ?? 0.45, edgeTint: o.edgeTint ?? [0.82, 0.83, 0.85],
  macro: o.macro ?? 0, macroScale: o.macroScale ?? 3.0,
  microRep: o.microRep ?? 0, microN: o.microN, microR: o.microR,
});

export function buildMaterials(maxAniso = 8) {
  const baked = loadBaked(maxAniso);
  const { panel, deck: deckTiles, soft } = baked;

  /* ---- exterior: painted hull, warm neutral half ------------------------
     Slightly higher envMapIntensity than the interior families because out
     here the environment probe IS the lighting — a hard star, a planet
     bounce and a cool rim fill, not a smooth room. */
  /* WHY THE ENV GAIN AND THE MACRO FIELD ARE HIGH OUT HERE
     Rule 1 above (paint is not metal) is about a lit ROOM, where a bright
     smooth probe turns metal into featureless sheen.  Vacuum is the opposite
     case: there is one hard star, a planet bounce and a cool rim fill, and the
     environment probe IS the lighting.  Taking the exterior down to a 0.34
     gain and metalness 0 removed the only specular the hull had, and the
     result was the flat clay read — correct physics for a room, wrong for
     outside.  So the hull keeps a real reflection and a touch of metalness,
     and gets the panel-to-panel value variation that a single repeated tile
     cannot express (see `macro` in baked.js). */
  /* WHY microRep IS ONLY ON THE LOFTED SKINS
     TLS's dressInterior gives every family a second, finer projection scaled
     to the parts it is used on.  That idea transfers only PARTLY here, and the
     reason is the UV convention: buildLoft writes arc length in metres, so a
     second projection on a hull skin genuinely adds sub-tile relief at a fixed
     physical size.  bevelBox, which is what every fitting is made of, writes
     NORMALISED 0..1 UVs per part — so `trim` at 2.5 already puts 2.5 tile
     cycles across a 40 mm bracket, and a finer second projection there would
     not add resolution, it would add noise.  So the micro layer goes on the
     metre-mapped skins, where the coarse tile is genuinely under-resolved at
     ~2 m, and nowhere else.  Applying it everywhere is the same mistake as
     taking the exterior env gain down to a lit-room value. */
  const hull = paint(0x8d8b83, 0.72, 0.78, panel, 2.4 / PANEL_M,
    { ns: 1.15, lo: 0.44, hi: 0.88, bare: 0.55, macro: 0.85, macroScale: 3.4,
      microRep: (2.4 / PANEL_M) * 6, microN: 0.34, microR: 0.15 });

  const hullWhite = paint(0xb6b2a8, 0.68, 0.70, panel, 1.2 / PANEL_M,
    { ns: 1.0, lo: 0.42, hi: 0.84, bare: 0.40, macro: 0.75, macroScale: 2.6,
      microRep: (1.2 / PANEL_M) * 6, microN: 0.30, microR: 0.14 });

  /* the cool machined half: near-neutral grey, anodised rather than painted */
  const hullDark = alloy(0x4a4c4e, 0.34, 0.52, 0.72, panel, 1.2 / PANEL_M,
    { ns: 1.1, ao: 1, lo: 0.34, hi: 0.74, macro: 0.7, macroScale: 2.2,
      microRep: (1.2 / PANEL_M) * 6, microN: 0.32, microR: 0.16 });

  /* the ONE saturated colour in the ship, and muted — oxide, not safety orange */
  const hullAccent = paint(0x8e5c31, 0.74, 0.42, panel, 0.8 / PANEL_M,
    { ns: 0.85, lo: 0.48, hi: 0.88, bare: 0.45, macro: 0.9, macroScale: 1.7 });

  /* ---- machined parts: frames, brackets, consoles, conduit -------------- */
  const trim = alloy(0x3e4043, 0.12, 0.62, 0.28, panel, 2.5,
    { micro: true, albRep: 6, ns: 0.55, ao: 0.6, lo: 0.50, hi: 0.84,
      microRep: 9, microN: 0.30, microR: 0.14 });

  const darkMetal = alloy(0x6c6e70, 0.30, 0.56, 0.34, panel, 3.0,
    { micro: true, albRep: 5, ns: 0.5, ao: 0.55, lo: 0.46, hi: 0.78,
      microRep: 8, microN: 0.28, microR: 0.13 });

  /* moulded gloss black: a dielectric, NOT a dark mirror */
  const blackMetal = paint(0x24262a, 0.56, 0.20, panel, 3.5,
    { micro: true, albRep: 6, ns: 0.45, ao: 0.5, lo: 0.44, hi: 0.72,
      microRep: 9, microN: 0.26, microR: 0.12 });

  /* Anodised alloy worn bright by hands — grab rails, glazing retaining
     strips, canopy waist rails.  THE one material in the ship allowed a real
     highlight, and it only reads as metal because the painted alloy either
     side of it sits three times rougher.  Anodised is not chrome: the
     highlight is narrow, over a surface that still has a diffuse term. */
  const brushed = alloy(0x9a9a97, 0.70, 0.52, 0.34, panel, 4.0,
    { micro: true, albRep: 7, ns: 0.35, ao: 0.45, lo: 0.44, hi: 0.64,
      microRep: 11, microN: 0.22, microR: 0.10 });

  const copper = alloy(0x8f6238, 0.80, 0.46, 0.30, panel, 4.0,
    { micro: true, albRep: 6, ns: 0.4, ao: 0.4, lo: 0.38, hi: 0.62,
      microRep: 9, microN: 0.24, microR: 0.11 });

  /* warm bone matte — thermal tile / composite, the palest thing outside */
  const ceramic = paint(0xc9c0ae, 0.86, 0.28, soft, 2.0,
    { micro: true, ns: 0.7, ao: 0.6, lo: 0.72, hi: 1.0, macro: 0.85, macroScale: 1.3 });

  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x0d1a24,
    metalness: 0.0,
    roughness: 0.035,
    transmission: 0.0,
    transparent: true,
    opacity: 0.30,
    side: THREE.DoubleSide,
    envMapIntensity: 2.6,
    clearcoat: 1,
    clearcoatRoughness: 0.02,
    depthWrite: false,
    ior: 1.5,
  });
  const glassInner = new THREE.MeshPhysicalMaterial({
    color: 0x8fd4ff,
    metalness: 0,
    roughness: 0.06,
    transparent: true,
    opacity: 0.06,
    side: THREE.BackSide,
    envMapIntensity: 1.2,
    depthWrite: false,
  });

  /* ---- interior ---------------------------------------------------------
     Paler than the exterior on purpose.  A crewed volume is painted pale so
     that a dropped bolt can be found, and the previous 0x23-0x4c range was
     a room built out of coal that no lamp could rescue. */

  /* deck plate.  floorStrip() writes uv = position * 0.55, so one UV unit is
     1/0.55 m.  The old version was a smooth plate with an inverse-square
     pool of light on it, which is what read as "wet floor" — the answer is
     the baked relief (anti-slip lozenges, countersunk fasteners, seams),
     not a roughness value. */
  const deck = paint(0x5b5851, 0.88, 0.09, deckTiles, (1 / 0.55) / DECK_M,
    { ns: 1.3, lo: 0.58, hi: 0.96, bare: 0.06, macro: 0.6, macroScale: 1.6,
      microRep: ((1 / 0.55) / DECK_M) * 6, microN: 0.30, microR: 0.13 });

  /* painted structural panelling — the warm bone half, and the single
     largest surface in the ship */
  /* CABIN LINER.
     normalScale is 0.62 and not 1.05, and the plate tile is 40% larger.
     The cockpit wall is seen almost edge-on from anywhere in the cabin, and
     at that incidence a strong normal map on a panel pattern stops reading
     as plating and starts reading as separate shelves bolted to the wall —
     which is what "缺面 / 一堆悬浮的板" was describing.  Bigger plates with
     shallower relief read as a lined wall.

     `bare` is 0, and that is the important one.  There is only ONE
     environment probe in the scene and it is the SKY, so any metalness on an
     interior surface mirrors deep space: the wear patches were showing up as
     hard-edged navy blotches across a warm grey wall.  Outside, the probe IS
     the lighting and metalness is essential (see the hull family); inside it
     is simply wrong, and interior wear has to come from the roughness spread
     instead — which is what lo/hi 0.62..0.97 is doing. */
  const liner = paint(0x827b70, 0.86, 0.10, panel, 1.12 / PANEL_M,
    { ns: 0.62, lo: 0.62, hi: 0.97, bare: 0.0, macro: 0.55, macroScale: 2.3,
      microRep: (1.12 / PANEL_M) * 6, microN: 0.20, microR: 0.12 });

  /* upholstery, warmer than the panelling on purpose: a cool neutral seat is
     half of why the pilot's chair read as the same moulding as the wall */
  /* SEAT UPHOLSTERY.
     0x4c4438 is 7% linear reflectance — inside the range TLS's review calls
     out as "coal" — and with roughness pinned at 0.88..1.0 it had no
     specular either.  The result was the largest object on the flight deck
     rendering as a black slab with no readable form.  Lifted to ~15% with a
     broad soft sheen: fabric and worn leather both have one, and it is the
     sheen that describes the curvature of a seat back. */
  const seat = paint(0x6b6252, 0.78, 0.07, soft, 1.4,
    { micro: true, albRep: 3, ns: 0.9, ao: 0.8, lo: 0.62, hi: 0.92,
      microRep: 5.5, microN: 0.34, microR: 0.16 });
  const seatTrim = paint(0x7a6f58, 0.74, 0.09, soft, 2.0,
    { micro: true, albRep: 4, ns: 0.7, ao: 0.7, lo: 0.56, hi: 0.88,
      microRep: 6.5, microN: 0.30, microR: 0.14 });
  /* moulded rubber: deadest response in the set, and no plate structure —
     moulded rubber has no seams, and it scuffs rather than wearing to alloy */
  const rubber = paint(0x2e2e30, 0.96, 0.05, soft, 3.0,
    { micro: true, ns: 0.8, ao: 0.6, lo: 0.90, hi: 1.0 });

  const glowMat = (hex, i) =>
    new THREE.MeshStandardMaterial({
      color: 0x000000, emissive: hex, emissiveIntensity: i,
      metalness: 0, roughness: 1, toneMapped: false,
    });

  const engineCore = new THREE.MeshStandardMaterial({
    color: 0x000000, emissive: 0x59b7ff, emissiveIntensity: 3.2,
    metalness: 0, roughness: 1, toneMapped: false,
  });
  /* heat-stained refractory: the nozzle is soot and oxide, not polished steel */
  const nozzle = alloy(0x3a332d, 0.40, 0.62, 0.45, panel, 3.0,
    { micro: true, ns: 0.6, ao: 0.5, lo: 0.46, hi: 0.90, macro: 0.8, macroScale: 0.9 });

  /* Screens and light coves are TONE MAPPED, unlike the small indicator LEDs.
     `toneMapped: false` writes straight to display-referred values, so those
     surfaces ignore exposure and always clip to white — acceptable for a 5 mm
     annunciator, wrong for a 6 m light cove or a display you are meant to
     read.  Under AgX they now roll off and hold their hue, and the bloom pass
     still picks them up because they are the brightest thing in frame. */
  const screens = [0, 1, 2, 3, 4, 5].map((k) => {
    const t = screenTexture(k);
    return new THREE.MeshStandardMaterial({
      map: t, emissiveMap: t, emissive: 0xffffff, emissiveIntensity: 2.6,
      color: 0x000000, metalness: 0, roughness: 0.9,
    });
  });

  const stripTex = gradientStrip('#9fd0f0');
  const strip = new THREE.MeshStandardMaterial({
    map: stripTex, emissiveMap: stripTex, emissive: 0xffffff, emissiveIntensity: 1.15,
    color: 0x000000, metalness: 0, roughness: 1,
  });

  const lib = {
    hull, hullDark, hullAccent, hullWhite, trim, darkMetal, blackMetal, brushed, copper,
    glass, glassInner, deck, liner, seat, seatTrim, rubber,
    glowCyan: glowMat(0x63d9ff, 2.4),
    glowWarm: glowMat(0xffd9a0, 2.0),
    glowRed: glowMat(0xff3b30, 3.0),
    glowGreen: glowMat(0x35ff86, 3.0),
    glowAmber: glowMat(0xffa63d, 2.6),
    engineCore, nozzle, ceramic, screens, strip,
    dispose() {
      baked.dispose();
      for (const v of Object.values(this)) {
        if (v instanceof THREE.Material) v.dispose();
        else if (Array.isArray(v)) v.forEach((m) => m instanceof THREE.Material && m.dispose());
      }
    },
  };
  return lib;
}

/** Procedural HDRI-ish environment: deep space with a hot key star,
 *  a cool rim fill and a planetary bounce. Drives all metal specular. */
export function buildEnvironment(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();

  const size = 512;
  const c = document.createElement('canvas');
  c.width = size * 2;
  c.height = size;
  const g = c.getContext('2d');

  const sky = g.createLinearGradient(0, 0, 0, size);
  sky.addColorStop(0, '#0a1020');
  sky.addColorStop(0.45, '#050810');
  sky.addColorStop(0.62, '#070a12');
  sky.addColorStop(1, '#101826');
  g.fillStyle = sky;
  g.fillRect(0, 0, size * 2, size);

  // nebula bands
  const blob = (x, y, r, col, a) => {
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, col.replace('A', String(a)));
    grd.addColorStop(1, col.replace('A', '0'));
    g.fillStyle = grd;
    g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
  };
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * size * 2;
    const y = size * (0.15 + Math.random() * 0.7);
    blob(x, y, 90 + Math.random() * 240, 'rgba(52,86,150,A)', 0.16);
  }
  for (let i = 0; i < 14; i++) {
    blob(Math.random() * size * 2, size * (0.2 + Math.random() * 0.6), 80 + Math.random() * 200,
      'rgba(150,60,110,A)', 0.10);
  }

  // key star
  const sx = size * 0.62, sy = size * 0.30;
  blob(sx, sy, 300, 'rgba(120,150,210,A)', 0.35);
  blob(sx, sy, 120, 'rgba(255,240,220,A)', 0.95);
  g.fillStyle = '#fffdf6';
  g.beginPath(); g.arc(sx, sy, 26, 0, 7); g.fill();

  // planet bounce (bottom, warm)
  const pg = g.createLinearGradient(0, size * 0.68, 0, size);
  pg.addColorStop(0, 'rgba(90,70,60,0)');
  pg.addColorStop(1, 'rgba(150,110,80,0.5)');
  g.fillStyle = pg;
  g.fillRect(0, size * 0.68, size * 2, size * 0.32);

  // rim fill (cool, opposite side)
  blob(size * 1.65, size * 0.55, 260, 'rgba(70,140,200,A)', 0.30);

  // stars
  for (let i = 0; i < 900; i++) {
    const x = Math.random() * size * 2, y = Math.random() * size;
    const a = Math.random() * 0.8;
    g.fillStyle = `rgba(255,255,255,${a})`;
    g.fillRect(x, y, 1, 1);
  }

  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  const env = pmrem.fromEquirectangular(t).texture;
  t.dispose();
  pmrem.dispose();
  return env;
}
