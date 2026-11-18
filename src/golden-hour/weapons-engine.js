// Procedural weapon & attachment geometry engine ported from Golden Hour
// (`D:\Eray0\下载\GOLDEN HOUR — Solstice Hotel\dist\game.js`).
//
// Keeps all high-detail receivers, barrels, handguards, stocks, rails, moving
// parts, modular optics/muzzles/underbarrels, procedural camo/wear shaders, and
// the fragmentation grenade, with Golden Hour's `hf` arm rig and brute-force
// finger-collision search stripped in favor of Saltline's gloved hand rig.
// Includes a fast headless DataTexture + 2D raster shim when `document` is
// absent so pure-Node tests construct every weapon and camo with zero DOM.
import * as THREE from 'three';
import {
  mergeGeometries as Vn,
  mergeVertices as a9,
  toCreasedNormals as th,
} from 'three/addons/utils/BufferGeometryUtils.js';
import {
  applyDetailShader,
  SHARED_RAIN_WETNESS,
  countObjectTriangles,
} from '../saltline/viewmodel-kit.js';

const IS_HEADLESS = typeof document === 'undefined';

function parseCssRgba(style) {
  if (!style) return [255, 255, 255, 1];
  if (typeof style === 'object' && style._stops?.length) {
    return parseCssRgba(style._stops[0]);
  }
  const s = String(style).trim();
  if (s.startsWith('#')) {
    if (s.length === 4) {
      return [
        parseInt(s[1] + s[1], 16),
        parseInt(s[2] + s[2], 16),
        parseInt(s[3] + s[3], 16),
        1,
      ];
    }
    if (s.length >= 7) {
      return [
        parseInt(s.slice(1, 3), 16),
        parseInt(s.slice(3, 5), 16),
        parseInt(s.slice(5, 7), 16),
        1,
      ];
    }
  }
  const m = s.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const p = m[1].split(',').map((v) => parseFloat(v.trim()));
    return [p[0] || 0, p[1] || 0, p[2] || 0, p.length > 3 ? p[3] : 1];
  }
  return [255, 255, 255, 1];
}

function createHeadlessCanvas(w, h = w) {
  const width = Math.max(1, w | 0);
  const height = Math.max(1, h | 0);
  const buf = new Uint8ClampedArray(width * height * 4);
  const stack = [];
  let tx = 0, ty = 0;
  let pathPts = [];

  const blendPixel = (px, py, r, g, b, a, op) => {
    if (px < 0 || py < 0 || px >= width || py >= height || a <= 0) return;
    const idx = (py * width + px) * 4;
    if (op === 'lighter') {
      buf[idx] = Math.min(255, buf[idx] + r * a);
      buf[idx + 1] = Math.min(255, buf[idx + 1] + g * a);
      buf[idx + 2] = Math.min(255, buf[idx + 2] + b * a);
      buf[idx + 3] = Math.min(255, buf[idx + 3] + a * 255);
    } else if (op === 'destination-out') {
      buf[idx + 3] = Math.max(0, buf[idx + 3] * (1 - a));
    } else {
      const inv = 1 - a;
      buf[idx] = r * a + buf[idx] * inv;
      buf[idx + 1] = g * a + buf[idx + 1] * inv;
      buf[idx + 2] = b * a + buf[idx + 2] * inv;
      buf[idx + 3] = Math.min(255, a * 255 + buf[idx + 3] * inv);
    }
  };

  const ctx = {
    canvas: null,
    fillStyle: '#000',
    strokeStyle: '#fff',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    font: '12px sans-serif',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    save() {
      stack.push([tx, ty, this.fillStyle, this.strokeStyle, this.lineWidth, this.globalAlpha, this.globalCompositeOperation]);
    },
    restore() {
      const st = stack.pop();
      if (st) {
        [tx, ty, this.fillStyle, this.strokeStyle, this.lineWidth, this.globalAlpha, this.globalCompositeOperation] = st;
      }
    },
    translate(dx, dy) { tx += dx; ty += dy; },
    rotate() {},
    scale() {},
    setTransform(a, b, c, d, e = 0, f = 0) { tx = e; ty = f; },
    resetTransform() { tx = 0; ty = 0; },
    beginPath() { pathPts = []; },
    closePath() { if (pathPts.length > 1) pathPts.push(pathPts[0]); },
    moveTo(x, y) { pathPts.push([x + tx, y + ty]); },
    lineTo(x, y) { pathPts.push([x + tx, y + ty]); },
    quadraticCurveTo(cx, cy, x, y) { pathPts.push([cx + tx, cy + ty], [x + tx, y + ty]); },
    bezierCurveTo(c1x, c1y, c2x, c2y, x, y) { pathPts.push([c1x + tx, c1y + ty], [c2x + tx, c2y + ty], [x + tx, y + ty]); },
    arc(x, y, r) { pathPts.push([x + tx - r, y + ty], [x + tx + r, y + ty]); },
    arcTo(x1, y1, x2, y2) { pathPts.push([x1 + tx, y1 + ty], [x2 + tx, y2 + ty]); },
    ellipse(x, y, rx) { pathPts.push([x + tx - rx, y + ty], [x + tx + rx, y + ty]); },
    rect(x, y, rw, rh) {
      pathPts.push([x + tx, y + ty], [x + tx + rw, y + ty], [x + tx + rw, y + ty + rh], [x + tx, y + ty + rh]);
    },
    roundRect(x, y, rw, rh) { this.rect(x, y, rw, rh); },
    clip() {},
    setLineDash() {},
    fill() {
      if (pathPts.length < 2) return;
      let minX = width, maxX = 0, minY = height, maxY = 0;
      for (const [px, py] of pathPts) {
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
      this.fillRect(minX - tx, minY - ty, Math.max(1, maxX - minX), Math.max(1, maxY - minY));
    },
    stroke() {
      if (pathPts.length < 2) return;
      const [r, g, b, a0] = parseCssRgba(this.strokeStyle);
      const a = Math.max(0, Math.min(1, a0 * this.globalAlpha));
      const op = this.globalCompositeOperation;
      for (let i = 0; i < pathPts.length - 1; i++) {
        const [x0, y0] = pathPts[i], [x1, y1] = pathPts[i + 1];
        const steps = Math.min(256, Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0))));
        for (let s = 0; s <= steps; s++) {
          const px = Math.round(x0 + (x1 - x0) * (s / steps));
          const py = Math.round(y0 + (y1 - y0) * (s / steps));
          blendPixel(px, py, r, g, b, a, op);
        }
      }
    },
    fillRect(rx, ry, rw, rh) {
      const [r, g, b, a0] = parseCssRgba(this.fillStyle);
      const a = Math.max(0, Math.min(1, a0 * this.globalAlpha));
      const op = this.globalCompositeOperation;
      const x0 = Math.max(0, Math.floor(rx + tx));
      const y0 = Math.max(0, Math.floor(ry + ty));
      const x1 = Math.min(width, Math.ceil(rx + tx + rw));
      const y1 = Math.min(height, Math.ceil(ry + ty + rh));
      if (a >= 0.999 && op === 'source-over') {
        for (let y = y0; y < y1; y++) {
          let row = (y * width + x0) * 4;
          for (let x = x0; x < x1; x++, row += 4) {
            buf[row] = r; buf[row + 1] = g; buf[row + 2] = b; buf[row + 3] = 255;
          }
        }
      } else {
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) blendPixel(x, y, r, g, b, a, op);
        }
      }
    },
    strokeRect(rx, ry, rw, rh) {
      this.beginPath();
      this.rect(rx, ry, rw, rh);
      this.closePath();
      this.stroke();
    },
    clearRect(rx, ry, rw, rh) {
      const x0 = Math.max(0, Math.floor(rx + tx));
      const y0 = Math.max(0, Math.floor(ry + ty));
      const x1 = Math.min(width, Math.ceil(rx + tx + rw));
      const y1 = Math.min(height, Math.ceil(ry + ty + rh));
      for (let y = y0; y < y1; y++) {
        buf.fill(0, (y * width + x0) * 4, (y * width + x1) * 4);
      }
    },
    fillText(text, x, y) {
      const wTxt = Math.min(width, String(text).length * 6);
      this.fillRect(x, y - 4, wTxt, 8);
    },
    strokeText() {},
    measureText(text) {
      return { width: String(text).length * 7.5, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 };
    },
    createLinearGradient() {
      return { _stops: [], addColorStop(_o, col) { this._stops.push(col); } };
    },
    createRadialGradient() {
      return { _stops: [], addColorStop(_o, col) { this._stops.push(col); } };
    },
    createImageData(iw, ih) {
      return { width: iw, height: ih, data: new Uint8ClampedArray(iw * ih * 4) };
    },
    putImageData(img, dx = 0, dy = 0) {
      if (dx === 0 && dy === 0 && img.width === width && img.height === height) {
        buf.set(img.data);
        return;
      }
      for (let y = 0; y < img.height; y++) {
        const ty2 = y + dy;
        if (ty2 < 0 || ty2 >= height) continue;
        for (let x = 0; x < img.width; x++) {
          const tx2 = x + dx;
          if (tx2 < 0 || tx2 >= width) continue;
          const si = (y * img.width + x) * 4;
          const di = (ty2 * width + tx2) * 4;
          buf[di] = img.data[si];
          buf[di + 1] = img.data[si + 1];
          buf[di + 2] = img.data[si + 2];
          buf[di + 3] = img.data[si + 3];
        }
      }
    },
    getImageData(sx = 0, sy = 0, sw = width, sh = height) {
      if (sx === 0 && sy === 0 && sw === width && sh === height) {
        return { width: sw, height: sh, data: new Uint8ClampedArray(buf) };
      }
      const out = new Uint8ClampedArray(sw * sh * 4);
      for (let y = 0; y < sh; y++) {
        const sy2 = Math.min(height - 1, Math.max(0, sy + y));
        for (let x = 0; x < sw; x++) {
          const sx2 = Math.min(width - 1, Math.max(0, sx + x));
          const si = (sy2 * width + sx2) * 4;
          const di = (y * sw + x) * 4;
          out[di] = buf[si];
          out[di + 1] = buf[si + 1];
          out[di + 2] = buf[si + 2];
          out[di + 3] = buf[si + 3];
        }
      }
      return { width: sw, height: sh, data: out };
    },
  };
  const canvas = {
    width,
    height,
    _buf: buf,
    getContext() { return ctx; },
  };
  ctx.canvas = canvas;
  return canvas;
}

function makeCanvas(w, h = w) {
  if (!IS_HEADLESS) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  return createHeadlessCanvas(w, h);
}

function makeCanvasTexture(canvas) {
  if (!IS_HEADLESS) {
    return new THREE.CanvasTexture(canvas);
  }
  const tex = new THREE.DataTexture(
    new Uint8Array(canvas._buf.buffer, canvas._buf.byteOffset, canvas._buf.byteLength),
    canvas.width,
    canvas.height,
    THREE.RGBAFormat,
    THREE.UnsignedByteType
  );
  tex.needsUpdate = true;
  return tex;
}

var Vt = Math.PI * 2, jn = Math.PI / 180, Zt = (o, t, e) => o < t ? t : o > e ? e : o, ns = (o) => o < 0 ? 0 : o > 1 ? 1 : o, Ht = (o, t, e) => o + (t - o) * e, EY = (o, t, e) => ns((e - o) / (t - o));
function Re(o = 1) {
  let t = o >>> 0, e = () => {
    t = t + 1831565813 >>> 0;
    let s = t;
    return s = Math.imul(s ^ s >>> 15, s | 1), s ^= s + Math.imul(s ^ s >>> 7, s | 61), ((s ^ s >>> 14) >>> 0) / 4294967296;
  };
  return e.range = (s, n) => s + (n - s) * e(), e.int = (s, n) => Math.floor(s + (n - s + 1) * e()), e.pick = (s) => s[Math.floor(e() * s.length)], e.sign = () => e() < 0.5 ? -1 : 1, e;
}
function we(o, t = o) { return makeCanvas(o, t); }
function _n(o = 1) {
  let t = Re(o), e = new Uint8Array(512), s = Array.from({ length: 256 }, (c, h) => h);
  for (let c = 255; c > 0; c--) {
    let h = Math.floor(t() * (c + 1));
    [s[c], s[h]] = [s[h], s[c]];
  }
  for (let c = 0; c < 512; c++) e[c] = s[c & 255];
  let n = new Float32Array(256);
  for (let c = 0; c < 256; c++) n[c] = t();
  let i = (c, h) => n[e[(c & 255) + e[h & 255]] & 255], a = (c) => c * c * c * (c * (c * 6 - 15) + 10);
  function r(c, h, f = 0) {
    let u = Math.floor(c), d = Math.floor(h), m = a(c - u), p = a(h - d), x = u + 1, g = d + 1;
    f && (u = (u % f + f) % f, d = (d % f + f) % f, x = (x % f + f) % f, g = (g % f + f) % f);
    let b = i(u, d), v = i(x, d), y = i(u, g), M = i(x, g);
    return Ht(Ht(b, v, m), Ht(y, M, m), p);
  }
  function l(c, h, f = 4, u = 0, d = 0.5, m = 2) {
    let p = 0.5, x = 0, g = 0, b = u;
    for (let v = 0; v < f; v++) x += p * r(c, h, b), g += p, c *= m, h *= m, b *= m, p *= d;
    return x / g;
  }
  return { noise: r, fbm: l };
}
var Ya = { ar: { id: "ar", name: "KR-7 CARBINE", cls: "ASSAULT RIFLE", auto: true, rpm: 720, dmg: [31, 22], range: [20, 46], head: 1.55, mag: 30, reserve: 150, adsTime: 0.23, zoom: 1.34, sprintOut: 0.19, hip: [1.5, 5.2], ads: 0.05, pellets: 1, recoil: { v: 1.05, h: 0.4, rec: 6.5, climb: 0.55, first: 1.3, punch: 0.55 }, kick: 1.35, mobility: 1, adsMove: 1, casing: 0, flash: 1, shake: 0.11, impulse: 7 }, smg: { id: "smg", name: "VESPER 9", cls: "SUBMACHINE GUN", auto: true, rpm: 910, dmg: [25, 15], range: [11, 30], head: 1.4, mag: 32, reserve: 160, adsTime: 0.17, zoom: 1.22, sprintOut: 0.12, hip: [1.1, 4], ads: 0.09, pellets: 1, recoil: { v: 0.78, h: 0.56, rec: 8, climb: 0.5, first: 1.15, punch: 0.42 }, kick: 1, mobility: 1.06, adsMove: 1.15, casing: 1, flash: 0.8, shake: 0.085, impulse: 5 }, shotgun: { id: "shotgun", name: "M12 BREACHER", cls: "SHOTGUN", auto: false, rpm: 72, dmg: [23, 7], range: [7, 17], head: 1.2, mag: 6, reserve: 30, adsTime: 0.25, zoom: 1.14, sprintOut: 0.2, hip: [2.7, 3.6], ads: 2.1, pellets: 9, recoil: { v: 5.4, h: 1.5, rec: 4.5, climb: 0.35, first: 1, punch: 2.4 }, kick: 3, mobility: 0.98, adsMove: 1, casing: 2, flash: 1.5, shake: 0.42, impulse: 6, pump: true }, pistol: { id: "pistol", name: "STRIX 9", cls: "PISTOL", auto: false, rpm: 400, dmg: [40, 22], range: [13, 32], head: 1.5, mag: 15, reserve: 60, adsTime: 0.13, zoom: 1.16, sprintOut: 0.09, hip: [1.3, 3.6], ads: 0.12, pellets: 1, recoil: { v: 2.3, h: 0.62, rec: 8, climb: 0.3, first: 1, punch: 1.1 }, kick: 1.9, mobility: 1.08, adsMove: 1.2, casing: 1, flash: 0.8, shake: 0.14, impulse: 6 } }, rZ = /* @__PURE__ */ new Set(["wood", "plaster", "fabric", "plastic", "ceramic", "foliage", "carpet", "glass"]), jd = new THREE.Vector3(), Nw = new THREE.Vector3(), vn = new THREE.Vector3(), n2 = new THREE.Vector3(), $d = new THREE.Vector3(), uI = new THREE.Vector3(), dI = new THREE.Vector3(), Bw = new THREE.Vector3(), br = { t: 0, nx: 0, ny: 0, nz: 0, col: null }, bu = { t: 0, body: null, nx: 0, ny: 0, nz: 0 }, yu = { t: 0, pane: null, a: 0, y: 0 };
var R1 = ["optic", "muzzle", "underbarrel", "magazine", "stock"], iR = { optic: "OPTIC", muzzle: "MUZZLE", underbarrel: "UNDERBARREL", magazine: "MAGAZINE", stock: "STOCK" }, Lg = { optic: { irons: { name: "IRON SIGHTS", desc: "Nothing between you and the target. Fastest to the eye.", mods: { adsTime: 0.93 } }, reflex: { name: "KITE REFLEX", desc: "Open red dot. Precise and quick.", mods: {} }, holo: { name: "HALO HOLOGRAPHIC", desc: "Wide window with a ring-and-dot reticle.", mods: { adsTime: 1.04, zoom: 1.05 } }, prism: { name: "VANTAGE 2.5\xD7", desc: "Magnified prism sight for the long lanes.", mods: { adsTime: 1.15, zoom: 1.7, adsMove: 0.9 } } }, muzzle: { none: { name: "FACTORY MUZZLE", desc: "Standard flash hider.", mods: {} }, suppressor: { name: "MONOLITH SUPPRESSOR", desc: "Quiet report and a hidden flash. Enemies hear you late.", mods: { range: 0.92, adsTime: 1.05, flash: 0.22 }, suppressed: true }, comp: { name: "PORTED COMPENSATOR", desc: "Vents gas upward to hold the muzzle down.", mods: { recoilV: 0.8 } }, brake: { name: "SLOTTED BRAKE", desc: "Kills side-to-side drift.", mods: { recoilH: 0.7 } }, choke: { name: "FULL CHOKE", desc: "Tighter pattern, longer reach.", mods: { hip: 0.72, range: 1.18 } } }, underbarrel: { none: { name: "NO UNDERBARREL", desc: "Bare handguard.", mods: {} }, vgrip: { name: "VERTICAL FOREGRIP", desc: "A firm hold that steadies sustained fire.", mods: { recoilV: 0.9, recoilH: 0.84, mobility: 0.985 } }, angled: { name: "ANGLED FOREGRIP", desc: "Snappier to the shoulder and out of a sprint.", mods: { adsTime: 0.91, sprintOut: 0.88 } }, laser: { name: "TAC LASER", desc: "Visible beam. Tightens hip fire.", mods: { hip: 0.74, sprintOut: 0.94 }, laser: true } }, magazine: { std: { name: "STANDARD MAG", desc: "Factory capacity.", mods: {} }, ext: { name: "EXTENDED MAG", desc: "Half again as many rounds; a little slower to handle.", mods: { mag: 1.5, reload: 1.1, adsTime: 1.04, mobility: 0.99 } }, fast: { name: "SPEED MAG", desc: "Flared well and a pull tab for faster changes.", mods: { reload: 0.8 } } }, stock: { std: { name: "FACTORY STOCK", desc: "Balanced.", mods: {} }, light: { name: "SKELETON STOCK", desc: "Light and fast; kicks harder.", mods: { mobility: 1.03, adsMove: 1.12, sprintOut: 0.88, recoilV: 1.08 } }, heavy: { name: "PADDED STOCK", desc: "Soaks up recoil at the cost of speed.", mods: { recoilV: 0.87, recoilH: 0.9, adsTime: 1.06 } } } }, vu = { ar: { optic: ["reflex", "irons", "holo", "prism"], muzzle: ["none", "suppressor", "comp", "brake"], underbarrel: ["none", "vgrip", "angled", "laser"], magazine: ["std", "ext", "fast"], stock: ["std", "light", "heavy"] }, smg: { optic: ["irons", "reflex", "holo"], muzzle: ["none", "suppressor", "comp"], underbarrel: ["none", "vgrip", "laser"], magazine: ["std", "ext", "fast"], stock: ["std", "light"] }, shotgun: { optic: ["irons", "reflex"], muzzle: ["none", "choke", "brake"], underbarrel: ["none", "laser"], magazine: ["std", "ext"], stock: ["std", "heavy"] }, pistol: { optic: ["irons", "reflex"], muzzle: ["none", "suppressor", "comp"], underbarrel: ["none", "laser"], magazine: ["std", "ext"], stock: [] } }, yr = [{ id: "factory", name: "FACTORY", tier: 0, need: null, desc: "As issued." }, { id: "dune", name: "DUNE", tier: 1, need: { kills: 5 }, desc: "Flat dark earth with worn edges." }, { id: "timberline", name: "TIMBERLINE", tier: 1, need: { kills: 15 }, desc: "Hand-sprayed woodland through netting." }, { id: "fracture", name: "FRACTURE", tier: 1, need: { kills: 30 }, desc: "Urban shards in three greys." }, { id: "tigerstripe", name: "TIGERSTRIPE", tier: 2, need: { headshots: 5 }, desc: "Black brushstrokes over olive and tan." }, { id: "topo", name: "EMBER TOPO", tier: 2, need: { headshots: 15 }, desc: "Burnt-orange contour lines on matte black." }, { id: "carbon", name: "CARBON WEAVE", tier: 2, need: { kills: 60 }, desc: "Twill-weave carbon under clear coat." }, { id: "damascus", name: "DAMASCUS", tier: 3, need: { kills: 100 }, desc: "Folded-steel waves, acid etched." }, { id: "gold", name: "SOLSTICE GOLD", tier: 3, need: { kills: 150, headshots: 30 }, desc: "Polished gold with engraved scrollwork." }, { id: "obsidian", name: "MOLTEN OBSIDIAN", tier: 4, need: { allGold: true }, desc: "Black glass with a slow ember glow in the cracks." }], Ol = ["ar", "smg", "shotgun", "pistol"], Gw = ["ar", "smg", "shotgun"], mI = "golden-hour-builds-v1", gI = "golden-hour-profile-v1";
var hh = (o) => o * Math.PI / 180, hs = (o, t, e) => new THREE.Vector3(o, t, e), $n = (o, t, e) => new THREE.Vector3(o, t, -e), Bi = false, Vg = new THREE.Matrix4(), kZ = new THREE.Quaternion(), mR = new THREE.Vector3(), MR = new THREE.Vector3(0, 1, 0);
function Mr(o) {
  o.index && (o = o.toNonIndexed()), o.attributes.normal || o.computeVertexNormals();
  let t = o.attributes.position.count;
  o.attributes.uv || o.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(t * 2), 2));
  for (let e of Object.keys(o.attributes)) e !== "position" && e !== "normal" && e !== "uv" && e !== "color" && o.deleteAttribute(e);
  return o.attributes.color || o.setAttribute("color", new THREE.BufferAttribute(new Float32Array(t * 3).fill(1), 3)), o.clearGroups(), o;
}
function $2(o, t, e) {
  let s = o.attributes.uv;
  for (let n = 0; n < s.count; n++) s.setXY(n, s.getX(n) * t, s.getY(n) * e);
  return o;
}
var DI = (o) => {
  let t = 0;
  for (let e = 0; e < o.length; e++) {
    let s = o[e], n = o[(e + 1) % o.length];
    t += s[0] * n[1] - n[0] * s[1];
  }
  return t;
};
function II(o, t) {
  let e = t.length;
  for (let s = 0; s < e; s++) {
    let n = t[s], i = t[(s + e - 1) % e], a = t[(s + 1) % e], r = Bi && (n[2] || 0) < 8e-3 ? 0 : n[2] || 0;
    if (r > 0) {
      let l = Math.hypot(i[0] - n[0], i[1] - n[1]), c = Math.hypot(a[0] - n[0], a[1] - n[1]), h = Math.min(r, l * 0.48), f = Math.min(r, c * 0.48), u = n[0] + (i[0] - n[0]) * h / l, d = n[1] + (i[1] - n[1]) * h / l, m = n[0] + (a[0] - n[0]) * f / c, p = n[1] + (a[1] - n[1]) * f / c;
      s === 0 ? o.moveTo(u, d) : o.lineTo(u, d), o.quadraticCurveTo(n[0], n[1], m, p);
    } else s === 0 ? o.moveTo(n[0], n[1]) : o.lineTo(n[0], n[1]);
  }
  o.closePath();
}
function UI(o, t) {
  DI(o) < 0 && (o = o.slice().reverse());
  let e = new THREE.Shape();
  if (II(e, o), t) for (let s of t) {
    DI(s) > 0 && (s = s.slice().reverse());
    let n = new THREE.Path();
    II(n, s), e.holes.push(n);
  }
  return e;
}
function CZ(o) {
  let t = o.attributes.position, e = t.count, s = new Float32Array(e * 3).fill(1), n = new THREE.Vector3(), i = new THREE.Vector3(), a = new THREE.Vector3();
  for (let r = 0; r < e; r += 3) {
    n.fromBufferAttribute(t, r), i.fromBufferAttribute(t, r + 1), a.fromBufferAttribute(t, r + 2), i.sub(n), a.sub(n), i.cross(a);
    let l = i.length();
    if (l < 1e-12) continue;
    let c = Math.abs(i.z / l);
    c > 0.12 && c < 0.985 && s.fill(2, r * 3, r * 3 + 9);
  }
  o.setAttribute("color", new THREE.BufferAttribute(s, 3));
}
function wR(o, t, e) {
  let s = Bi ? 0 : Math.min(e.b ?? 8e-4, t * 0.45), n = new THREE.ExtrudeGeometry(UI(o, Bi && !e.keepHoles ? null : e.holes), { depth: t - 2 * s, steps: 1, curveSegments: Bi ? 1 : e.cs ?? 4, bevelEnabled: s > 0, bevelThickness: s, bevelSize: s, bevelOffset: -s, bevelSegments: e.bs ?? 1 });
  return s > 0 && CZ(n), e.soft && !Bi && (n = th(n, e.soft === true ? 0.85 : e.soft)), n.userData.b = s, n.userData.depth = t - 2 * s, n;
}
function te(o, t, e = {}) {
  let s = wR(o, t, e);
  return Vg.set(0, 0, 1, (e.x || 0) - s.userData.depth / 2, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 0, 1), Mr(s.applyMatrix4(Vg));
}
function Kc(o, t) {
  let e = [], s = [], n = o.length;
  for (let i = 0; i < n; i++) {
    let a = o[Math.max(0, i - 1)], r = o[Math.min(n - 1, i + 1)], l = r[0] - a[0], c = r[1] - a[1], h = Math.hypot(l, c) || 1;
    l /= h, c /= h;
    let f = (o[i][2] ?? t) / 2;
    e.push([o[i][0] - c * f, o[i][1] + l * f]), s.push([o[i][0] + c * f, o[i][1] - l * f]);
  }
  return e.concat(s.reverse());
}
function Xo(o, t, e = {}) {
  let s = new THREE.CylinderGeometry(o, o, t, Bi ? 6 : e.seg || 12);
  return $2(s, Math.PI * 2 * o, t), s.rotateZ(Math.PI / 2), s.translate(e.x || 0, e.y || 0, -(e.u || 0)), Mr(s);
}
function Ug(o, t, e = {}) {
  let s = new THREE.CylinderGeometry(e.r2 ?? o, o, t, Bi ? 6 : e.seg || 12);
  return $2(s, Math.PI * 2 * o, t), s.translate(e.x || 0, (e.y || 0) + t / 2, -(e.u || 0)), Mr(s);
}
function Ra() {
  let o = /* @__PURE__ */ new Map();
  return { add(t, ...e) {
    let s = Bi ? HI : t, n = o.get(s);
    n || o.set(s, n = []);
    let i = t.userData.wear || 1, a = t.userData.base;
    for (let r of e) {
      if (!r) continue;
      let l = r.attributes.color.array;
      for (let c = 0; c < l.length; c += 3) {
        let h = l[c] > 1.5 ? i : 1;
        Bi ? (l[c] = a.r * h, l[c + 1] = a.g * h, l[c + 2] = a.b * h) : l[c] = l[c + 1] = l[c + 2] = h;
      }
      n.push(r);
    }
  }, build(t, e) {
    for (let [s, n] of o) {
      let i = n.length > 1 ? Vn(n, false) : n[0];
      e && i.translate(-e.x, -e.y, -e.z);
      let a = s === HI ? tp().world : s, r = new THREE.Mesh(i, a);
      r.castShadow = !a.transparent, r.receiveShadow = !a.transparent, a.userData.keep && (r.userData.keep = true, r.name = a.userData.keep), a.transparent && (r.renderOrder = 2), t.add(r);
    }
    o.clear();
  } };
}
var HI = {};
function Bg(o, t, e, s) {
  let n = new Float32Array(o * o);
  for (let u = 0; u < o; u++) for (let d = 0; d < o; d++) n[u * o + d] = t(d, u);
  let i = we(o), a = i.getContext("2d"), r = a.createImageData(o, o), l = we(o), c = l.getContext("2d"), h = c.createImageData(o, o);
  for (let u = 0; u < o; u++) for (let d = 0; d < o; d++) {
    let m = (u * o + d) * 4, p = (n[u * o + (d + 1) % o] - n[u * o + (d + o - 1) % o]) * e, x = (n[(u + 1) % o * o + d] - n[(u + o - 1) % o * o + d]) * e, g = 1 / Math.hypot(p, x, 1);
    r.data[m] = (-p * g * 0.5 + 0.5) * 255, r.data[m + 1] = (x * g * 0.5 + 0.5) * 255, r.data[m + 2] = (g * 0.5 + 0.5) * 255, r.data[m + 3] = 255;
    let b = Math.max(0, Math.min(1, s ? s(d, u, n[u * o + d]) : 1)) * 255;
    h.data[m] = h.data[m + 1] = h.data[m + 2] = b, h.data[m + 3] = 255;
  }
  a.putImageData(r, 0, 0), c.putImageData(h, 0, 0);
  let f = (u) => {
    let d = makeCanvasTexture(u);
    return d.wrapS = d.wrapT = THREE.RepeatWrapping, d.anisotropy = 4, d;
  };
  return { n: f(i), r: f(l) };
}
var Wb = (o, t, e = t) => {
  let s = o.clone();
  return s.repeat.set(t, e), s.needsUpdate = true, s;
}, xR = null;
function tp() { return ao(); }
function Z2() {
  let o = tp(), t = Ra(), e = new THREE.Group();
  e.name = "grenade";
  let s = new THREE.SphereGeometry(0.031, 64, 44), n = s.attributes.position, i = new THREE.Vector3(), a = (r, l, c) => {
    let h = Math.min(1, Math.max(0, (c - r) / (l - r)));
    return h * h * (3 - 2 * h);
  };
  for (let r = 0; r < n.count; r++) {
    i.fromBufferAttribute(n, r);
    let l = Math.atan2(i.z, i.x) / (Math.PI * 2) + 0.5, c = Math.acos(Math.max(-1, Math.min(1, i.y / 0.031))) / Math.PI, h = l * 8 % 1, f = (c * 7 + 0.5) % 1, u = a(0.1, 0.2, c) * a(0.1, 0.2, 1 - c), d = Math.min(1 - u + u * a(0.02, 0.11, Math.min(h, 1 - h)), a(0.03, 0.16, Math.min(f, 1 - f)) + (1 - u));
    i.multiplyScalar(1 - 0.095 * (1 - Math.min(1, d))), i.y *= 1.13, n.setXYZ(r, i.x, i.y, i.z);
  }
  s.computeVertexNormals(), $2(s, 0.19, 0.11), t.add(o.olive, Mr(s)), t.add(o.steel, Ug(0.0118, 7e-3, { y: 0.0325, seg: 14 }), Ug(88e-4, 0.017, { y: 0.039, seg: 12 }), Ug(0.0105, 4e-3, { y: 0.047, seg: 6 })), t.add(o.olive, te(Kc([[6e-3, 0.0572], [-0.013, 0.0572], [-0.027, 0.043], [-0.0345, 0.016], [-0.0345, -0.012]], 16e-4), 0.013, { b: 5e-4 })), t.add(o.steelBright, Xo(12e-4, 0.026, { x: 4e-3, y: 0.0505, seg: 6 }));
  {
    let r = new THREE.TorusGeometry(0.0105, 11e-4, 6, 18);
    r.rotateY(Math.PI / 2), r.rotateX(0.5), r.translate(0.0175, 0.043, 4e-3), t.add(o.steelBright, Mr(r));
  }
  return t.build(e), e;
}
var Ze = (o) => o * Math.PI / 180, Bt = (o, t, e) => new THREE.Vector3(o, t, e), Gt = (o, t, e) => new THREE.Vector3(o, t, -e), C1 = false, p4 = new THREE.Matrix4(), hr0 = new THREE.Quaternion(), fr0 = new THREE.Vector3(), ur0 = new THREE.Vector3(0, 1, 0);
function Qe(o) {
  o.index && (o = o.toNonIndexed()), o.attributes.normal || o.computeVertexNormals();
  let t = o.attributes.position.count;
  o.attributes.uv || o.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(t * 2), 2));
  for (let e of Object.keys(o.attributes)) e !== "position" && e !== "normal" && e !== "uv" && e !== "color" && o.deleteAttribute(e);
  return o.attributes.color || o.setAttribute("color", new THREE.BufferAttribute(new Float32Array(t * 3).fill(1), 3)), o.clearGroups(), o;
}
function JE(o, t, e) {
  let s = o.attributes.uv;
  for (let n = 0; n < s.count; n++) s.setXY(n, s.getX(n) * t, s.getY(n) * e);
  return o;
}
var KH = (o) => {
  let t = 0;
  for (let e = 0; e < o.length; e++) {
    let s = o[e], n = o[(e + 1) % o.length];
    t += s[0] * n[1] - n[0] * s[1];
  }
  return t;
};
function XH(o, t) {
  let e = t.length;
  for (let s = 0; s < e; s++) {
    let n = t[s], i = t[(s + e - 1) % e], a = t[(s + 1) % e], r = C1 && (n[2] || 0) < 8e-3 ? 0 : n[2] || 0;
    if (r > 0) {
      let l = Math.hypot(i[0] - n[0], i[1] - n[1]), c = Math.hypot(a[0] - n[0], a[1] - n[1]), h = Math.min(r, l * 0.48), f = Math.min(r, c * 0.48), u = n[0] + (i[0] - n[0]) * h / l, d = n[1] + (i[1] - n[1]) * h / l, m = n[0] + (a[0] - n[0]) * f / c, p = n[1] + (a[1] - n[1]) * f / c;
      s === 0 ? o.moveTo(u, d) : o.lineTo(u, d), o.quadraticCurveTo(n[0], n[1], m, p);
    } else s === 0 ? o.moveTo(n[0], n[1]) : o.lineTo(n[0], n[1]);
  }
  o.closePath();
}
function PQ(o, t) {
  KH(o) < 0 && (o = o.slice().reverse());
  let e = new THREE.Shape();
  if (XH(e, o), t) for (let s of t) {
    KH(s) > 0 && (s = s.slice().reverse());
    let n = new THREE.Path();
    XH(n, s), e.holes.push(n);
  }
  return e;
}
function zQ(o) {
  let t = o.attributes.position, e = t.count, s = new Float32Array(e * 3).fill(1), n = new THREE.Vector3(), i = new THREE.Vector3(), a = new THREE.Vector3();
  for (let r = 0; r < e; r += 3) {
    n.fromBufferAttribute(t, r), i.fromBufferAttribute(t, r + 1), a.fromBufferAttribute(t, r + 2), i.sub(n), a.sub(n), i.cross(a);
    let l = i.length();
    if (l < 1e-12) continue;
    let c = Math.abs(i.z / l);
    c > 0.12 && c < 0.985 && s.fill(2, r * 3, r * 3 + 9);
  }
  o.setAttribute("color", new THREE.BufferAttribute(s, 3));
}
function bp(o, t, e) {
  let s = C1 ? 0 : Math.min(e.b ?? 8e-4, t * 0.45), n = new THREE.ExtrudeGeometry(PQ(o, C1 && !e.keepHoles ? null : e.holes), { depth: t - 2 * s, steps: 1, curveSegments: C1 ? 1 : e.cs ?? 4, bevelEnabled: s > 0, bevelThickness: s, bevelSize: s, bevelOffset: -s, bevelSegments: e.bs ?? 1 });
  return s > 0 && zQ(n), e.soft && !C1 && (n = th(n, e.soft === true ? 0.85 : e.soft)), n.userData.b = s, n.userData.depth = t - 2 * s, n;
}
function us(o, t, e = {}) {
  let s = bp(o, t, e);
  return p4.set(0, 0, 1, (e.x || 0) - s.userData.depth / 2, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 0, 1), Qe(s.applyMatrix4(p4));
}
function si(o, t, e = {}) {
  let s = (i) => i.map((a) => [-a[0], a[1], a[2]]), n = bp(s(o), t, { ...e, holes: e.holes ? e.holes.map(s) : null });
  if (p4.set(-1, 0, 0, e.x || 0, 0, 1, 0, e.y || 0, 0, 0, -1, -((e.u || 0) + n.userData.b), 0, 0, 0, 1), e.swapUV) {
    let i = n.attributes.uv;
    for (let a = 0; a < i.count; a++) i.setXY(a, i.getY(a), i.getX(a));
  }
  return Qe(n.applyMatrix4(p4));
}
function jc(o, t, e = {}) {
  let s = bp(o, t, e);
  return p4.set(1, 0, 0, 0, 0, 0, 1, (e.y || 0) + s.userData.b, 0, -1, 0, 0, 0, 0, 0, 1), Qe(s.applyMatrix4(p4));
}
var se = (o, t, e, s, n = 0) => [[o, t, n], [e, t, n], [e, s, n], [o, s, n]], m4 = (o, t, e, s) => se(o - e / 2, t - s / 2, o + e / 2, t + s / 2, s * 0.49), Kr = (o, t, e, s = 14) => Array.from({ length: s }, (n, i) => [o + Math.cos(i / s * Math.PI * 2) * e, t + Math.sin(i / s * Math.PI * 2) * e]), tT = (o) => Array.from({ length: 8 }, (t, e) => {
  let s = Ze(22.5 + 45 * e), n = o / Math.cos(Ze(22.5));
  return [Math.cos(s) * n, Math.sin(s) * n];
});
function Sc(o, t) {
  let e = [], s = [], n = o.length;
  for (let i = 0; i < n; i++) {
    let a = o[Math.max(0, i - 1)], r = o[Math.min(n - 1, i + 1)], l = r[0] - a[0], c = r[1] - a[1], h = Math.hypot(l, c) || 1;
    l /= h, c /= h;
    let f = (o[i][2] ?? t) / 2;
    e.push([o[i][0] - c * f, o[i][1] + l * f]), s.push([o[i][0] + c * f, o[i][1] - l * f]);
  }
  return e.concat(s.reverse());
}
function fa(o, t, e = {}) {
  let s = C1 ? Math.max(6, (e.seg || 16) >> 1) : e.seg || 16, n = new THREE.CylinderGeometry(e.r2 ?? o, o, t, s, 1, !!e.open);
  return JE(n, Math.PI * 2 * o, t), n.rotateX(-Math.PI / 2), n.translate(e.x || 0, e.y || 0, -((e.u || 0) + t / 2)), Qe(n);
}
function Wn(o, t, e = {}) {
  let s = new THREE.CylinderGeometry(o, o, t, C1 ? 6 : e.seg || 12);
  return JE(s, Math.PI * 2 * o, t), s.rotateZ(Math.PI / 2), s.translate(e.x || 0, e.y || 0, -(e.u || 0)), Qe(s);
}
function T5(o, t, e = {}) {
  let s = new THREE.CylinderGeometry(e.r2 ?? o, o, t, C1 ? 6 : e.seg || 12);
  return JE(s, Math.PI * 2 * o, t), s.translate(e.x || 0, (e.y || 0) + t / 2, -(e.u || 0)), Qe(s);
}
function ni(o, t = {}) {
  let e = new THREE.LatheGeometry(o.map(([s, n]) => new THREE.Vector2(Math.max(n, 1e-5), s)), C1 ? 8 : t.seg || 20);
  return JE(e, 0.06, 0.2), C1 || (e = th(e, t.crease ?? 0.6)), e.rotateX(-Math.PI / 2), e.translate(t.x || 0, t.y || 0, 0), Qe(e);
}
var xh = (o, t, e) => (o.translate(0, -e, 0), o.rotateZ(Ze(t)), o.translate(0, e, 0), o), bh = (o, t, e, s) => (o.translate(t, e, -s), o);
function g4() {
  let o = /* @__PURE__ */ new Map();
  return { add(t, ...e) {
    let s = C1 ? YH : t, n = o.get(s);
    n || o.set(s, n = []);
    let i = t.userData.wear || 1, a = t.userData.base;
    for (let r of e) {
      if (!r) continue;
      let l = r.attributes.color.array;
      for (let c = 0; c < l.length; c += 3) {
        let h = l[c] > 1.5 ? i : 1;
        C1 ? (l[c] = a.r * h, l[c + 1] = a.g * h, l[c + 2] = a.b * h) : l[c] = l[c + 1] = l[c + 2] = h;
      }
      n.push(r);
    }
  }, build(t, e) {
    for (let [s, n] of o) {
      let i = n.length > 1 ? Vn(n, false) : n[0];
      e && i.translate(-e.x, -e.y, -e.z);
      let a = s === YH ? ao().world : s, r = new THREE.Mesh(i, a);
      r.castShadow = !a.transparent, r.receiveShadow = !a.transparent, a.userData.keep && (r.userData.keep = true, r.name = a.userData.keep), a.transparent && (r.renderOrder = 2), t.add(r);
    }
    o.clear();
  } };
}
var YH = {};
function ff(o, t, e, s) {
  let n = new Float32Array(o * o);
  for (let u = 0; u < o; u++) for (let d = 0; d < o; d++) n[u * o + d] = t(d, u);
  let i = we(o), a = i.getContext("2d"), r = a.createImageData(o, o), l = we(o), c = l.getContext("2d"), h = c.createImageData(o, o);
  for (let u = 0; u < o; u++) for (let d = 0; d < o; d++) {
    let m = (u * o + d) * 4, p = (n[u * o + (d + 1) % o] - n[u * o + (d + o - 1) % o]) * e, x = (n[(u + 1) % o * o + d] - n[(u + o - 1) % o * o + d]) * e, g = 1 / Math.hypot(p, x, 1);
    r.data[m] = (-p * g * 0.5 + 0.5) * 255, r.data[m + 1] = (x * g * 0.5 + 0.5) * 255, r.data[m + 2] = (g * 0.5 + 0.5) * 255, r.data[m + 3] = 255;
    let b = Math.max(0, Math.min(1, s ? s(d, u, n[u * o + d]) : 1)) * 255;
    h.data[m] = h.data[m + 1] = h.data[m + 2] = b, h.data[m + 3] = 255;
  }
  a.putImageData(r, 0, 0), c.putImageData(h, 0, 0);
  let f = (u) => {
    let d = makeCanvasTexture(u);
    return d.wrapS = d.wrapT = THREE.RepeatWrapping, d.anisotropy = 4, d;
  };
  return { n: f(i), r: f(l) };
}
var x2 = (o, t, e = t) => {
  let s = o.clone();
  return s.repeat.set(t, e), s.needsUpdate = true, s;
}, QR = null;
function ao() {
  if (QR) return QR;
  let o = _n(4107), t = Re(99), e = 256, s = new Float32Array(e * e);
  for (let L = 0; L < 60; L++) {
    let A = t() * e, O = t() * e, H = (t() - 0.5) * 0.9 + (t() < 0.5 ? 0 : 1.57), F = 4 + t() * 22, P = Math.cos(H), z = Math.sin(H), k = 0.25 + t() * 0.5;
    for (let I = 0; I < F; I++) s[((O | 0) + e) % e * e + ((A | 0) + e) % e] = k, A += P, O += z;
  }
  let n = new Float32Array(e * e);
  for (let L = 0; L < n.length; L++) n[L] = t();
  let i = ff(e, (L, A) => n[A * e + L] * 0.55 + o.fbm(L / 8, A / 8, 3, 32) * 0.9, 1.1, (L, A) => 0.8 + 0.26 * o.fbm(L / 32 + 9, A / 32, 3, 8) - s[A * e + L] * 0.16), a = ff(e, (L, A) => o.fbm(L / 2, A / 2, 2, 128) + n[A * e + L] * 0.3, 1.8, (L, A) => 0.84 + 0.2 * o.fbm(L / 32, A / 32 + 4, 3, 8) - s[A * e + L] * 0.14), r = ff(e, (L, A) => {
    let O = o.fbm(L / 3.2, A / 3.2, 2, e / 3.2);
    return O * O * 2.2;
  }, 2.6, (L, A) => 0.86 + 0.16 * o.fbm(L / 32 + 2, A / 32, 2, e / 32)), l = ff(e, (L, A) => {
    let H = Math.floor(A / 8), F = (L + (H & 1) * 8 / 2) % 8 - 8 / 2, P = A % 8 - 8 / 2;
    return Math.max(0, 1 - Math.hypot(F, P) / 3.4);
  }, 4.5, (L, A, O) => 0.95 - O * 0.25), c = ff(e, (L, A) => Math.sin(L * Math.PI / 4) * Math.sin(A * Math.PI / 4) * 0.5 + 0.5 + n[A * e + L] * 0.35, 2.2, (L, A) => 0.9 + 0.1 * o.noise(L / 16, A / 16, e / 16)), h = ff(e, (L, A) => (Math.sin((L + A) * Math.PI / 3) * 0.5 + 0.5) * 0.6 + o.fbm(L / 32, A / 32, 3, 8) * 2.4 + n[A * e + L] * 0.3, 2.4, () => 1), f = we(512, 256), u = f.getContext("2d"), d = u.createImageData(512, 256);
  for (let L = 0; L < 256; L++) for (let A = 0; A < 512; A++) {
    let O = o.fbm(A / 200, L / 50, 3, 0) * 34, H = Math.sin((L + O) * 0.85 + o.fbm(A / 110, L / 18, 2, 0) * 4) * 0.5 + 0.5, F = o.fbm(A / 140, L / 2.2, 3, 0), P = o.fbm(A / 260 + 3, L / 90, 2, 0), z = Math.pow(H, 2.2) * 0.16 + F * 0.52 + P * 0.32, k = (L * 512 + A) * 4;
    d.data[k] = 44 + z * 50, d.data[k + 1] = 25 + z * 30, d.data[k + 2] = 15 + z * 17, d.data[k + 3] = 255;
  }
  u.putImageData(d, 0, 0);
  let m = makeCanvasTexture(f);
  m.wrapS = m.wrapT = THREE.RepeatWrapping, m.colorSpace = THREE.SRGBColorSpace, m.repeat.set(3.2, 9), m.anisotropy = 8;
  let p = we(256), x = p.getContext("2d"), g = x.createImageData(256, 256), b = [[52, 54, 46], [70, 68, 54], [36, 39, 35], [88, 80, 62]];
  for (let L = 0; L < 256; L++) for (let A = 0; A < 256; A++) {
    let O = o.fbm(A / 42, L / 30, 3, 0), H = o.fbm(A / 20 + 40, L / 26 + 7, 2, 0), F = b[O > 0.56 ? H > 0.5 ? 3 : 1 : H > 0.58 ? 2 : 0], P = (L * 256 + A) * 4, z = 0.9 + n[(L * 256 + A) % n.length] * 0.2;
    g.data[P] = F[0] * z, g.data[P + 1] = F[1] * z, g.data[P + 2] = F[2] * z, g.data[P + 3] = 255;
  }
  x.putImageData(g, 0, 0);
  let v = makeCanvasTexture(p);
  v.wrapS = v.wrapT = THREE.RepeatWrapping, v.colorSpace = THREE.SRGBColorSpace, v.repeat.set(5, 5);
  let y = (L, A, O, H, F, P, z = {}) => {
    let k = new THREE.MeshStandardMaterial({ color: L, metalness: A, roughness: O, vertexColors: true, ...H ? { normalMap: x2(H.n, F), roughnessMap: x2(H.r, H === l ? F : 12), normalScale: new THREE.Vector2(P, P) } : {}, ...z });
    return k.userData.base = new THREE.Color(L), k.userData.wear = z.wear || 1, delete k.wear, k;
  }, M = { alu: y(2434602, 0.62, 0.44, i, 90, 0.2), aluLt: y(3421755, 0.62, 0.42, i, 90, 0.18), steel: y(2829359, 0.88, 0.4, a, 80, 0.2), steelBright: y(9409174, 1, 0.27, i, 90, 0.16), poly: y(1447447, 0, 0.6, r, 60, 0.26), polyMag: y(2303014, 0, 0.55, r, 60, 0.24), polyFDE: y(6706751, 0, 0.58, r, 60, 0.22), gripFDE: y(6246459, 0, 0.7, l, 34, 0.8), grip: y(1315861, 0, 0.72, l, 34, 0.9), rubber: y(855310, 0, 0.86, r, 50, 0.4), brass: y(12159548, 1, 0.26, i, 90, 0.14), copper: y(11823678, 1, 0.3, null), black: y(263172, 0, 1, null), white: y(14211282, 0, 0.6, null), red: y(11871772, 0, 0.5, null), wood: y(16777215, 0, 0.46, h, 0, 0, { map: m }), olive: y(3883056, 0.25, 0.62, r, 60, 0.3), trit: y(1845786, 0, 0.4, null, 0, 0, { emissive: 9305978, emissiveIntensity: 2.6 }), fiber: y(2754566, 0, 0.4, null, 0, 0, { emissive: 16726562, emissiveIntensity: 2.2 }), glove: y(1382170, 0, 0.86, c, 0, 0.8), gloveRub: y(526602, 0, 0.56, r, 0, 0.5), leather: y(1447706, 0, 0.62, r, 0, 0.7), strap: y(2369066, 0, 0.9, c, 0, 1), sleeve: y(16777215, 0, 0.92, h, 0, 1, { map: v }), watch: y(723724, 0, 0.5, null), world: new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.45, roughness: 0.5 }) }, w = { alu: 2.6, aluLt: 2.2, steel: 2, steelBright: 1.25, poly: 1.3, polyMag: 1.35, polyFDE: 1.18, gripFDE: 1.1, grip: 1.2, brass: 1.15, wood: 1, olive: 1.5, gloveRub: 1.6 };
  for (let L in w) M[L].userData.wear = w[L];
  M.wood.userData.base = new THREE.Color(4204570), M.sleeve.userData.base = new THREE.Color(3816498);
  for (let [L, A] of [["glove", 260], ["gloveRub", 60], ["leather", 70], ["strap", 300], ["sleeve", 26]]) {
    let O = { glove: c, gloveRub: r, leather: r, strap: c, sleeve: h }[L];
    M[L].normalMap = x2(O.n, A), M[L].roughnessMap = x2(O.r, A);
  }
  M.wood.normalMap = x2(i.n, 46), M.wood.normalScale.set(0.14, 0.14), M.wood.roughnessMap = null;
  let T = we(1024, 512), S = T.getContext("2d");
  S.fillStyle = "#fff", S.textBaseline = "middle";
  let E = {}, _ = (L, A, O, H, F, P) => {
    S.save(), S.translate(A, O), P(H, F), S.restore(), E[L] = [A / 1024, 1 - (O + F) / 512, (A + H) / 1024, 1 - O / 512];
  }, R = (L, A = 600) => `${A} ${L}px Bahnschrift, "Segoe UI", Arial, sans-serif`;
  _("ar", 0, 0, 384, 160, (L) => {
    S.font = R(74, 700), S.fillText("KR-7", 8, 44), S.font = R(30), S.fillText("CAL 5.56 NATO", 10, 100), S.fillText("SN GH07731", 10, 136), S.strokeStyle = "#fff", S.lineWidth = 4, S.strokeRect(250, 14, 118, 58), S.font = R(26, 700), S.fillText("MK II", 272, 45);
  }), _("smg", 384, 0, 384, 160, () => {
    S.font = R(64, 700), S.fillText("VESPER 9", 8, 42), S.font = R(30), S.fillText("9x19  PARABELLUM", 10, 98), S.fillText("SN V9-20418", 10, 134);
  }), _("sg", 0, 160, 448, 128, () => {
    S.font = R(58, 700), S.fillText("M12 BREACHER", 8, 40), S.font = R(30), S.fillText('12 GA  2\xBE" & 3"   SN B12-0932', 10, 96);
  }), _("pistol", 448, 160, 448, 128, () => {
    S.font = R(66, 700), S.fillText("STRIX 9", 8, 44), S.font = R(30), S.fillText("9x19   GH-ARMS", 10, 100);
  }), _("safe", 0, 300, 120, 44, () => {
    S.font = R(34, 700), S.fillText("SAFE", 4, 24);
  }), _("semi", 128, 300, 120, 44, () => {
    S.font = R(34, 700), S.fillText("SEMI", 4, 24);
  }), _("auto", 256, 300, 120, 44, () => {
    S.font = R(34, 700), S.fillText("AUTO", 4, 24);
  }), _("picto", 384, 300, 200, 60, () => {
    S.fillRect(8, 8, 36, 44), S.clearRect(14, 14, 24, 32), S.fillRect(22, 20, 8, 20);
    for (let L = 0; L < 3; L++) S.fillRect(70 + L * 40, 8, 30, 44), S.clearRect(75 + L * 40, 13, 20, 34), S.fillRect(81 + L * 40, 18, 8, 24);
  }), _("warn", 600, 300, 400, 44, () => {
    S.font = R(24), S.fillText("WARNING - REFER TO OPERATORS MANUAL", 4, 24);
  }), _("nums", 0, 360, 60, 150, () => {
    S.font = R(22, 700), [10, 20, 30].forEach((L, A) => S.fillText(String(L), 6, 24 + A * 48));
  });
  let C = makeCanvasTexture(T);
  return C.anisotropy = 8, C.colorSpace = THREE.SRGBColorSpace, M.mark = new THREE.MeshStandardMaterial({ map: C, color: 11843773, transparent: true, roughness: 0.5, metalness: 0.2, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), M.mark.userData = { base: new THREE.Color(6974576), wear: 1, cells: E }, M.markRed = M.mark.clone(), M.markRed.color.set(12728874), M.markRed.userData = M.mark.userData, M.lens = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, premultipliedAlpha: true, uniforms: { uDot: { value: 27e-4 }, uColor: { value: new THREE.Vector3(6, 0.3, 0.2) } }, vertexShader: `varying vec3 vView; varying vec3 vFwd; varying vec3 vN;
      void main(){ vec4 p = modelViewMatrix * vec4(position, 1.0); vView = p.xyz;
        vFwd = normalize((modelViewMatrix * vec4(0.0, 0.0, -1.0, 0.0)).xyz); vN = normalMatrix * normal;
        gl_Position = projectionMatrix * p; }`, fragmentShader: `uniform float uDot; uniform vec3 uColor; varying vec3 vView; varying vec3 vFwd; varying vec3 vN;
      void main(){ vec3 d = normalize(vView); vec3 f = normalize(vFwd);
        float fres = pow(1.0 - abs(dot(d, normalize(vN))), 3.0); vec3 col; float a;
        if (dot(d, f) > 0.0) {
          a = 0.035 + 0.3 * fres; col = vec3(0.03, 0.07, 0.08) * a;
          vec2 dl = d.xy / max(-d.z, 1e-4) - f.xy / max(-f.z, 1e-4); float r = length(dl);
          col += uColor * ((1.0 - smoothstep(uDot * 0.5, uDot, r)) + 0.09 * exp(-r * r / (uDot * uDot * 16.0)));
        } else { a = 0.42 + 0.5 * fres; col = vec3(1.1, 0.32, 0.10) * a * 0.55; }
        gl_FragColor = vec4(col, a); }` }), M.lens.userData = { base: new THREE.Color(3149834), wear: 1, keep: "lens" }, QR = M;
}
function x4(o, t, e, s, n, i, a, r) {
  let l = ao(), c = l.mark.userData.cells[o], h = new THREE.PlaneGeometry(t, e), f = h.attributes.uv;
  for (let u = 0; u < f.count; u++) f.setXY(u, c[0] + f.getX(u) * (c[2] - c[0]), c[1] + f.getY(u) * (c[3] - c[1]));
  return h.rotateY(a < 0 ? -Math.PI / 2 : Math.PI / 2), h.translate(s, n, -i), Qe(h);
}
function xy(o, t, e, s = 0.0206) {
  if (C1) return us(se(o, e, t, e + 75e-4), s);
  let n = 52e-4, i = 42e-4, a = 75e-4, r = [[o, e], [o, e + i]];
  for (let l = o + 24e-4; l + n < t - 12e-4; l += 0.01) r.push([l, e + i], [l, e + a], [l + n, e + a], [l + n, e + i]);
  return r.push([t, e + i], [t, e]), us(r, s, { b: 6e-4 });
}
function eT(o, t, e, s, n, i, a, r) {
  t.add(o.brass, fa(a, i, { x: e, y: s, u: n, seg: 10 })), t.add(o.copper, ni([[n + i, a * 0.98], [n + i + r * 0.25, a * 0.86], [n + i + r * 0.7, a * 0.5], [n + i + r, a * 0.08]], { x: e, y: s, seg: 10, crease: 1.2 }));
}
function Du(o, t, e, s) {
  let n = new THREE.Group();
  return n.name = e, n.position.copy(s), n.userData.keep = true, n.userData.rest = s.clone(), o.add(n), t[e] = n, n;
}
var jH = new THREE.Matrix4(), LQ = new THREE.Quaternion();
function Zn(o, t, e = 0, s = null) {
  let n = t[0] - e, i = t[1] - e, a = t[2] - e, r = o[0], l = o[1], c = o[2], h = null;
  return s && (jH.makeRotationFromQuaternion(LQ.copy(s).invert()), h = jH.elements.slice()), (f, u, d) => {
    if (f -= r, u -= l, d -= c, h) {
      let y = h[0] * f + h[4] * u + h[8] * d, M = h[1] * f + h[5] * u + h[9] * d, w = h[2] * f + h[6] * u + h[10] * d;
      f = y, u = M, d = w;
    }
    let m = Math.abs(f) - n, p = Math.abs(u) - i, x = Math.abs(d) - a, g = Math.max(m, 0), b = Math.max(p, 0), v = Math.max(x, 0);
    return Math.sqrt(g * g + b * b + v * v) + Math.min(Math.max(m, p, x), 0) - e;
  };
}
function b2(o, t, e) {
  let s = o[0], n = o[1], i = o[2], a = t[0] - s, r = t[1] - n, l = t[2] - i, c = 1 / (a * a + r * r + l * l);
  return (h, f, u) => {
    h -= s, f -= n, u -= i;
    let d = (h * a + f * r + u * l) * c;
    return d = d < 0 ? 0 : d > 1 ? 1 : d, h -= a * d, f -= r * d, u -= l * d, Math.sqrt(h * h + f * f + u * u) - e;
  };
}
function ml(o, t, e, s = 0) {
  let n = o[0], i = o[1], a = o[2], r = t[0] - n, l = t[1] - i, c = t[2] - a, h = Math.hypot(r, l, c);
  return r /= h, l /= h, c /= h, (f, u, d) => {
    f -= n, u -= i, d -= a;
    let m = f * r + u * l + d * c;
    f -= r * m, u -= l * m, d -= c * m;
    let p = Math.sqrt(f * f + u * u + d * d) - (e - s), x = Math.abs(m - h / 2) - (h / 2 - s), g = Math.max(p, 0), b = Math.max(x, 0);
    return Math.sqrt(g * g + b * b) + Math.min(Math.max(p, x), 0) - s;
  };
}
function $H(o) {
  let t = o.length, e = new Float64Array(t), s = new Float64Array(t);
  for (let n = 0; n < t; n++) e[n] = o[n][0], s[n] = o[n][1];
  return (n, i) => {
    let a = 1 / 0, r = 1;
    for (let l = 0, c = t - 1; l < t; c = l, l++) {
      let h = e[c] - e[l], f = s[c] - s[l], u = n - e[l], d = i - s[l], m = (u * h + d * f) / (h * h + f * f);
      m = m < 0 ? 0 : m > 1 ? 1 : m;
      let p = u - h * m, x = d - f * m, g = p * p + x * x;
      g < a && (a = g);
      let b = i >= s[l], v = i < s[c], y = h * d > f * u;
      (b && v && y || !b && !v && !y) && (r = -r);
    }
    return r * Math.sqrt(a);
  };
}
var ZH = (o, t, e) => {
  let s = Math.max(o + e, 0), n = Math.max(t + e, 0);
  return Math.sqrt(s * s + n * n) + Math.min(Math.max(o + e, t + e), 0) - e;
};
function Zs(o, t, e = {}) {
  let s = $H(o), n = t / 2, i = e.x || 0, a = e.r || 0;
  return (r, l, c) => ZH(s(-c, l), Math.abs(r - i) - n, a);
}
function Iu(o, t, e, s = {}) {
  let n = $H(o), i = (t + e) / 2, a = (e - t) / 2, r = s.r || 0, l = s.y || 0;
  return (c, h, f) => ZH(n(c, h - l), Math.abs(-f - i) - a, r);
}
function QH(o, t, e, s, n, i = 0, a = Math.PI / 8) {
  let r = [], l = t / Math.cos(Math.PI / o);
  for (let c = 0; c < o; c++) {
    let h = a + c * 2 * Math.PI / o;
    r.push([Math.cos(h) * l, Math.sin(h) * l]);
  }
  return Iu(r, s, n, { y: e, r: i });
}
function ds(...o) {
  o = o.flat().filter(Boolean);
  let t = o.length;
  return (e, s, n) => {
    let i = 1 / 0;
    for (let a = 0; a < t; a++) {
      let r = o[a](e, s, n);
      r < i && (i = r);
    }
    return i;
  };
}
var sT = (o, t, e, s) => (n, i, a) => o(n - t, i - e, a - s);
var Hs = Math.PI / 180, Pn = Math.PI * 2, nF = new THREE.Quaternion(), JH = new THREE.Euler(), DQ = new THREE.Vector3(), IQ = new THREE.Matrix4(), tF = new THREE.Vector3(), by = new THREE.Vector3(), yy = new THREE.Vector3(), HQ = new THREE.Vector3(0, 0, -1), wr = (o, t, e = {}) => us(o, t, { b: 0.5, ...e }), jo = (o, t, e = {}) => si(o, t, { b: 0.5, ...e }), oF = (o, t, e = {}) => jc(o, t, { b: 0.5, ...e }), gl = (o, t, e = 0, s = 0, n = 0) => [[s - o / 2, n - t / 2, e], [s + o / 2, n - t / 2, e], [s + o / 2, n + t / 2, e], [s - o / 2, n + t / 2, e]], yh = (o, t, e = 0, s = 0, n = 0) => Array.from({ length: o }, (i, a) => [s + Math.cos(e + a / o * Pn) * t, n + Math.sin(e + a / o * Pn) * t]);
function b4(o, t, e) {
  return e && (JH.set(e[0] * Hs, e[1] * Hs, e[2] * Hs, "XYZ"), o.applyQuaternion(nF.setFromEuler(JH))), t && o.translate(t[0], t[1], -t[2]), o;
}
var FQ = { "x+": [1, 0, 0], "x-": [-1, 0, 0], "y+": [0, 1, 0], "y-": [0, -1, 0], "u+": [0, 0, -1], "u-": [0, 0, 1] };
function _c(o, t, e) {
  let s = typeof t == "string" ? FQ[t] : t;
  return o.applyQuaternion(nF.setFromUnitVectors(HQ, DQ.set(s[0], s[1], s[2]).normalize())), e && o.translate(e[0], e[1], -e[2]), o;
}
var OQ = { L: [[-1, 0, 0], [0, 1, 0]], R: [[1, 0, 0], [0, 1, 0]], T: [[0, 1, 0], [0, 0, -1]], B: [[0, 0, 1], [0, 1, 0]], F: [[0, 0, -1], [0, 1, 0]], D: [[0, -1, 0], [0, 0, -1]] };
function Ie(o, t, e, s = 0) {
  let [n, i] = typeof e == "string" ? OQ[e] : e;
  return yy.set(n[0], n[1], n[2]).normalize(), by.set(i[0], i[1], i[2]), by.addScaledVector(yy, -by.dot(yy)).normalize(), tF.crossVectors(by, yy), s && o.rotateZ(s * Hs), o.applyMatrix4(IQ.makeBasis(tF, by, yy)), t && o.translate(t[0], t[1], -t[2]), o;
}
var tA = [0, 0], $c = class {
  constructor() {
    this.p = [], this.n = [], this.t = [], this.c = [];
  }
  tri(t, e, s, n, i, a = 1) {
    let r = e[0] - t[0], l = e[1] - t[1], c = e[2] - t[2], h = s[0] - t[0], f = s[1] - t[1], u = s[2] - t[2], d = l * u - c * f, m = c * h - r * u, p = r * f - l * h, x = Math.hypot(d, m, p);
    if (x < 1e-7) return;
    this.p.push(t[0], t[1], t[2], e[0], e[1], e[2], s[0], s[1], s[2]), n ? this.n.push(n[0][0], n[0][1], n[0][2], n[1][0], n[1][1], n[1][2], n[2][0], n[2][1], n[2][2]) : (d /= x, m /= x, p /= x, this.n.push(d, m, p, d, m, p, d, m, p));
    let g = i ? i[0] : tA, b = i ? i[1] : tA, v = i ? i[2] : tA;
    this.t.push(g[0], g[1], b[0], b[1], v[0], v[1]), this.c.push(a, a, a, a, a, a, a, a, a);
  }
  quad(t, e, s, n, i, a, r = 1) {
    this.tri(t, e, n, i && [i[0], i[1], i[3]], a && [a[0], a[1], a[3]], r), this.tri(e, s, n, i && [i[1], i[2], i[3]], a && [a[1], a[2], a[3]], r);
  }
  quadFacing(t, e, s, n, i, a = 1, r = false) {
    let l = e[0] - t[0], c = e[1] - t[1], h = e[2] - t[2], f = n[0] - t[0], u = n[1] - t[1], d = n[2] - t[2], m = c * d - h * u, p = h * f - l * d, x = l * u - c * f;
    m * (i[0] - t[0]) + p * (i[1] - t[1]) + x * (i[2] - t[2]) >= 0 !== r ? this.quad(t, e, s, n, null, null, a) : this.quad(t, n, s, e, null, null, a);
  }
  geo() {
    let t = new THREE.BufferGeometry();
    return t.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.p), 3)), t.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(this.n), 3)), t.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(this.t), 2)), t.setAttribute("color", new THREE.BufferAttribute(new Float32Array(this.c), 3)), t;
  }
};
function cn(o, t = {}) {
  let e = t.flute || null, s = e ? e.trap ? [0, 0, 1, 1] : [0, 1] : [0], n = e ? e.n * s.length : t.seg || 24, i = o.length, a = Math.cos((t.crease ?? 32) * Hs), r = [];
  for (let p = 0; p < i - 1; p++) {
    let x = o[p + 1][0] - o[p][0], g = o[p + 1][1] - o[p][1], b = Math.hypot(x, g) || 1;
    r.push([-g / b, x / b]);
  }
  let l = 0;
  for (let p of o) l = Math.max(l, p[1]);
  let c = new $c(), h = t.x || 0, f = t.y || 0, u = (p, x) => {
    let g = o[p], b = Math.max(0, g[1] - (g[3] || 0) * s[x % s.length]), v = x / n * Pn;
    return [h + b * Math.cos(v), f + b * Math.sin(v), -g[0]];
  }, d = (p, x) => {
    let g = p[0] + x[0], b = p[1] + x[1], v = Math.hypot(g, b) || 1;
    return [g / v, b / v];
  }, m = 0;
  for (let p = 0; p < i - 1; p++) {
    let x = o[p], g = o[p + 1], b = Math.hypot(g[0] - x[0], g[1] - x[1]), v = e && ((x[3] || 0) > 0 || (g[3] || 0) > 0), y = r[p], M = r[p];
    p > 0 && r[p - 1][0] * r[p][0] + r[p - 1][1] * r[p][1] > a && (y = d(r[p - 1], r[p])), p < i - 2 && r[p + 1][0] * r[p][0] + r[p + 1][1] * r[p][1] > a && (M = d(r[p + 1], r[p]));
    for (let w = 0; w < n; w++) {
      let T = u(p, w), S = u(p + 1, w), E = u(p + 1, w + 1), _ = u(p, w + 1), R = w / n * Pn, C = (w + 1) / n * Pn, L = [[R * l, m], [R * l, m + b], [C * l, m + b], [C * l, m]], A = g[2] ? 2 : 1, O = null;
      if (v) e.wear && s[w % s.length] === 0 && s[(w + 1) % s.length] === 0 && (A = 2);
      else if (!t.flat) {
        let H = Math.cos(R), F = Math.sin(R), P = Math.cos(C), z = Math.sin(C);
        O = [[y[1] * H, y[1] * F, -y[0]], [M[1] * H, M[1] * F, -M[0]], [M[1] * P, M[1] * z, -M[0]], [y[1] * P, y[1] * z, -y[0]]];
      }
      c.quad(T, S, E, _, O, L, A);
    }
    m += b;
  }
  return c.geo();
}
var Zc = (o, t) => cn(o, t).rotateX(Math.PI);
function vh(o, t, e = {}) {
  let s = bp(o, t, { b: 0.3, ...e });
  return s.translate(0, 0, s.userData.b), Qe(s);
}
function iT(o) {
  let t = o.a00 ?? -90, e = o.step || 15, s = o.ch ?? 0.35, n = o.x || 0, i = o.y || 0, a = o.ports || [], r = o.rFn || (() => o.r), l = o.ri, c = 1e-4, h = s / o.r / Hs, f = (w, T, S, E) => {
    w = w.filter((R) => R >= T - E && R <= S + E).map((R) => Math.min(S, Math.max(T, R))).sort((R, C) => R - C);
    let _ = [];
    for (let R of w) (!_.length || R - _[_.length - 1] > E) && _.push(R);
    return _;
  }, u = [];
  for (let w = 0; w <= 360 + c; w += e) u.push(t + w);
  let d = [o.u0, o.u1];
  for (let w of a) u.push(w.a0, w.a1, w.a0 - h, w.a1 + h), d.push(w.u0, w.u1, w.u0 - s, w.u1 + s);
  for (let w of o.breaks || []) u.push(w);
  u = f(u, t, t + 360, 0.05), d = f(d, o.u0, o.u1, 0.01);
  let m = (w, T) => a.some((S) => w > S.a0 && w < S.a1 && T > S.u0 && T < S.u1), p = (w, T) => a.some((S) => w >= S.a0 - 0.02 && w <= S.a1 + 0.02 && T >= S.u0 - 2e-3 && T <= S.u1 + 2e-3), x = (w, T, S) => [n + S * Math.cos(w * Hs), i + S * Math.sin(w * Hs), -T], g = (w, T) => r(w) - (p(w, T) ? s : 0), b = (w, T) => {
    let S = (w + T * 0.05) * Hs, E = r(w + T * 0.05), _ = (r(w + T * 0.05 + 0.02) - r(w + T * 0.05 - 0.02)) / (0.04 * Hs), R = _ * Math.sin(S) + E * Math.cos(S), C = -_ * Math.cos(S) + E * Math.sin(S), L = Math.hypot(R, C);
    return [R / L, C / L, 0];
  }, v = new $c(), y = new $c(), M = [n, i];
  for (let w = 0; w < u.length - 1; w++) {
    let T = u[w], S = u[w + 1], E = (T + S) / 2, _ = b(T, 1), R = b(S, -1), C = [-Math.cos(T * Hs), -Math.sin(T * Hs), 0], L = [-Math.cos(S * Hs), -Math.sin(S * Hs), 0], A = -1, O = (P) => {
      if (A < 0) return;
      let z = d[A], k = d[P];
      v.quad(x(T, z, r(T)), x(T, k, r(T)), x(S, k, r(S)), x(S, z, r(S)), [_, _, R, R], [[T * Hs * o.r, z], [T * Hs * o.r, k], [S * Hs * o.r, k], [S * Hs * o.r, z]], 1), A = -1;
    }, H = -1, F = (P) => {
      if (H < 0) return;
      let z = d[H], k = d[P];
      y.quad(x(T, z, l), x(S, z, l), x(S, k, l), x(T, k, l), [C, L, L, C], null, 1), H = -1;
    };
    for (let P = 0; P < d.length - 1; P++) {
      let z = d[P], k = d[P + 1], I = (z + k) / 2;
      if (m(E, I)) {
        O(P), F(P);
        continue;
      }
      if (H < 0 && (H = P), p(T, z) || p(T, k) || p(S, z) || p(S, k)) {
        O(P);
        let K = [x(T, z, g(T, z)), x(T, k, g(T, k)), x(S, k, g(S, k)), x(S, z, g(S, z))], $ = p(T, z), n0 = p(S, k);
        $ !== n0 ? (v.tri(K[0], K[1], K[3], null, null, 2), v.tri(K[1], K[2], K[3], null, null, 2)) : (v.tri(K[0], K[1], K[2], null, null, 2), v.tri(K[0], K[2], K[3], null, null, 2));
      } else A < 0 && (A = P);
    }
    O(d.length - 1), F(d.length - 1);
    for (let [P, z, k] of [[o.capRear, o.u0, 1], [o.capFront, o.u1, -1]]) !P || m(E, z + k * 0.01) || y.quadFacing(x(T, z, g(T, z)), x(S, z, g(S, z)), x(S, z, l), x(T, z, l), [n, i, -(z - k * 100)], 1);
  }
  for (let w of a) {
    let T = x((w.a0 + w.a1) / 2, (w.u0 + w.u1) / 2, (o.r + l) / 2);
    for (let _ = 0; _ < u.length - 1; _++) {
      let R = u[_], C = u[_ + 1];
      if (!(R < w.a0 - 0.02 || C > w.a1 + 0.02)) for (let L of [w.u0, w.u1]) L <= o.u0 + 0.01 || L >= o.u1 - 0.01 || y.quadFacing(x(R, L, r(R) - s), x(C, L, r(C) - s), x(C, L, l), x(R, L, l), T, 1);
    }
    let S = Math.max(w.u0, o.u0), E = Math.min(w.u1, o.u1);
    for (let _ of [w.a0, w.a1]) y.quadFacing(x(_, S, r(_) - s), x(_, E, r(_) - s), x(_, E, l), x(_, S, l), T, 1);
  }
  return { outer: v.geo(), inner: y.geo() };
}
function Qc(o, t, e, s = 1, n = {}) {
  if (o > t) {
    let h = o;
    o = t, t = h;
  }
  let i = n.seg || 20, a = new $c(), r = n.x || 0, l = n.y || 0, c = [0, 0, -s];
  for (let h = 0; h < i; h++) {
    let f = h / i * Pn, u = (h + 1) / i * Pn, d = [r + t * Math.cos(f), l + t * Math.sin(f), -e], m = [r + t * Math.cos(u), l + t * Math.sin(u), -e], p = [r + o * Math.cos(u), l + o * Math.sin(u), -e], x = [r + o * Math.cos(f), l + o * Math.sin(f), -e];
    s > 0 ? a.quad(d, x, p, m, [c, c, c, c], null, n.flag || 1) : a.quad(d, m, p, x, [c, c, c, c], null, n.flag || 1);
  }
  return a.geo();
}
function iF(o, t = {}) {
  let e = o.length, s = o[0].length, n = new Float32Array(e * s * 3), i = [];
  for (let p = 0; p < e; p++) for (let x = 0; x < s; x++) n.set(o[p][x], (p * s + x) * 3);
  for (let p = 0; p < e - 1; p++) for (let x = 0; x < s; x++) {
    let g = p * s + x, b = p * s + (x + 1) % s, v = (p + 1) * s + (x + 1) % s, y = (p + 1) * s + x;
    i.push(g, b, y, b, v, y);
  }
  let a = new THREE.BufferGeometry();
  a.setAttribute("position", new THREE.BufferAttribute(n, 3)), a.setIndex(i), a.computeVertexNormals();
  let r = a.attributes.normal, l = 0;
  for (let p = 0; p < e; p++) {
    let x = 0, g = 0, b = 0;
    for (let v of o[p]) x += v[0], g += v[1], b += v[2];
    x /= s, g /= s, b /= s;
    for (let v = 0; v < s; v++) {
      let y = o[p][v], M = p * s + v;
      l += (y[0] - x) * r.getX(M) + (y[1] - g) * r.getY(M) + (y[2] - b) * r.getZ(M);
    }
  }
  let c = l < 0, h = new $c(), f = (p) => {
    let x = c ? -1 : 1;
    return [r.getX(p) * x, r.getY(p) * x, r.getZ(p) * x];
  }, u = o.map((p) => {
    let x = [0];
    for (let g = 0; g < s; g++) {
      let b = p[g], v = p[(g + 1) % s];
      x.push(x[g] + Math.hypot(v[0] - b[0], v[1] - b[1], v[2] - b[2]));
    }
    return x;
  }), d = u[0].map((p, x) => u.reduce((g, b) => g + b[x], 0) / e), m = 0;
  for (let p = 0; p < e - 1; p++) {
    let x = Math.hypot(o[p + 1][0][0] - o[p][0][0], o[p + 1][0][1] - o[p][0][1], o[p + 1][0][2] - o[p][0][2]), g = t.flag ? t.flag(p) : 1;
    for (let b = 0; b < s; b++) {
      let v = (b + 1) % s, y = p * s + b, M = p * s + v, w = (p + 1) * s + v, T = (p + 1) * s + b, S = o[p][b], E = o[p][v], _ = o[p + 1][v], R = o[p + 1][b], C = [[d[b], m], [d[b + 1], m], [d[b + 1], m + x], [d[b], m + x]];
      c ? h.quad(S, R, _, E, [f(y), f(T), f(w), f(M)], [C[0], C[3], C[2], C[1]], g) : h.quad(S, E, _, R, [f(y), f(M), f(w), f(T)], C, g);
    }
    m += x;
  }
  for (let [p, x, g] of [[t.capA, o[0], o[1]], [t.capB, o[e - 1], o[e - 2]]]) {
    if (!p) continue;
    let b = [0, 0, 0], v = [0, 0, 0];
    for (let y = 0; y < s; y++) for (let M = 0; M < 3; M++) b[M] += x[y][M] / s, v[M] += g[y][M] / s;
    for (let y = 0; y < s; y++) {
      let M = x[y], w = x[(y + 1) % s], T = M[0] - b[0], S = M[1] - b[1], E = M[2] - b[2], _ = w[0] - b[0], R = w[1] - b[1], C = w[2] - b[2], L = S * C - E * R, A = E * _ - T * C, O = T * R - S * _;
      L * (b[0] - v[0]) + A * (b[1] - v[1]) + O * (b[2] - v[2]) >= 0 ? h.tri(b, M, w) : h.tri(b, w, M);
    }
  }
  return h.geo();
}
function Mh(o, t, e = {}) {
  let s = new THREE.CatmullRomCurve3(o.map((i) => new THREE.Vector3(i[0], i[1], -i[2])), false, "centripetal"), n = new THREE.TubeGeometry(s, e.seg || o.length * 4, t, e.radial || 6, false);
  return Qe(n);
}
function y4(o, t, e = 1, s = {}) {
  let n = o.attributes.position, i = o.attributes.normal, a = n.count, r = new Float32Array(a * 3), l = s.x || 0, c = s.y || 0;
  for (let h = 0; h < a; h += 3) {
    let f = true, u = [0, 0, 0];
    for (let m = 0; m < 3; m++) Math.abs(i.getZ(h + m)) > (s.cone ?? 0.6) && (f = false), u[m] = Math.atan2(n.getY(h + m) - c, n.getX(h + m) - l);
    if (!f) continue;
    let d = Math.max(u[0], u[1], u[2]);
    for (let m = 0; m < 3; m++) {
      d - u[m] > Math.PI && (u[m] += Pn);
      let p = Math.hypot(n.getX(h + m) - l, n.getY(h + m) - c), x = Pn * (s.r || p) / t;
      r[(h + m) * 3] = u[m] / Pn * t, r[(h + m) * 3 + 1] = -n.getZ(h + m) / x, r[(h + m) * 3 + 2] = e;
    }
  }
  return o.setAttribute("aK", new THREE.BufferAttribute(r, 3)), o;
}
function aF(o, t, e = 4, s = {}) {
  let n = o.attributes.position, i = o.attributes.normal, a = n.count, r = new Float32Array(a * 3);
  for (let l = 0; l < a; l++) i.getZ(l) < (s.minZ ?? 0.5) || (r[l * 3] = n.getX(l) / t, r[l * 3 + 1] = n.getY(l) / t, r[l * 3 + 2] = e);
  return o.setAttribute("aK", new THREE.BufferAttribute(r, 3)), o;
}
function nA(o, t) {
  let e = o.attributes.position, s = o.attributes.color;
  for (let n = 0; n < e.count; n++) {
    let i = t(e.getX(n), e.getY(n), e.getZ(n));
    i && s.setXYZ(n, s.getX(n) * i[0], s.getY(n) * i[1], s.getZ(n) * i[2]);
  }
  return o;
}
var Xr = (o) => new THREE.Color(o), NQ = { steel: { c: Xr(2829359), m: 0.88, r: 0.4, wear: 2 }, oxide: { c: Xr(1513498), m: 0.85, r: 0.44, wear: 2.6 }, bright: { c: Xr(9409174), m: 1, r: 0.27, wear: 1.25 }, alu: { c: Xr(2434602), m: 0.62, r: 0.44, wear: 2.6 }, aluLt: { c: Xr(3421755), m: 0.62, r: 0.42, wear: 2.2 }, black: { c: Xr(263172), m: 1, r: 1, wear: 1 }, matte: { c: Xr(657931), m: 0.75, r: 0.8, wear: 1.5 }, rubber: { c: Xr(855310), m: 0.5, r: 0.84, wear: 1.15 }, poly: { c: Xr(1447447), m: 0, r: 0.6, wear: 1.3 }, brass: { c: Xr(12159548), m: 1, r: 0.28, wear: 1.15 }, ti: { c: Xr(9078144), m: 0.95, r: 0.34, wear: 1.2 }, soot: { c: Xr(789517), m: 0.35, r: 0.88, wear: 1.6 }, glass: { c: Xr(263946), m: 0, r: 0.05, wear: 1 }, amber: { c: Xr(2757126), m: 0, r: 0.06, wear: 1 }, redGlass: { c: Xr(3802371), m: 0, r: 0.08, wear: 1 }, white: { c: Xr(14211282), m: 0, r: 0.6, wear: 1 }, redPaint: { c: Xr(11871772), m: 0, r: 0.5, wear: 1 } }, v4 = (o, t) => ({ c: Xr(o), m: 0, r: 0.4, wear: 1, e: t }), BQ = `
#ifdef USE_NORMALMAP_TANGENTSPACE
{
	vec2 kq = vK.xy;
	float kfw = max( fwidth( kq.x ), fwidth( kq.y ) ) + 1e-5;
	mat3 ktb = getTangentFrame( - vViewPosition, normal, kq );
	if ( vK.z > 0.5 ) {
		float kfade = 1.0 - smoothstep( 0.28, 0.85, kfw );
		float kw = kfw * 1.2 + 0.03;
		vec2 kg = vec2( 0.0 ); float kh = 0.5;
		if ( vK.z < 1.5 ) {
			vec2 kp = vec2( kq.x + kq.y, kq.x - kq.y );
			vec2 kt = fract( kp ) - 0.5; vec2 ka = abs( kt );
			kh = 1.0 - 2.0 * max( ka.x, ka.y );
			vec2 ks = clamp( kt / kw, -1.0, 1.0 ) * clamp( ( 0.5 - ka ) / kw, 0.0, 1.0 );
			vec2 gp = ka.x > ka.y ? vec2( -ks.x, 0.0 ) : vec2( 0.0, -ks.y );
			kg = vec2( gp.x + gp.y, gp.x - gp.y );
		} else if ( vK.z < 2.5 ) {
			float kt = fract( kq.x ) - 0.5; kh = 1.0 - 2.0 * abs( kt );
			kg = vec2( -clamp( kt / kw, -1.0, 1.0 ) * clamp( ( 0.5 - abs( kt ) ) / kw, 0.0, 1.0 ), 0.0 ) * 1.3;
		} else if ( vK.z < 3.5 ) {
			float kt = fract( kq.y ) - 0.5; kh = 1.0 - 2.0 * abs( kt );
			kg = vec2( 0.0, -clamp( kt / kw, -1.0, 1.0 ) * clamp( ( 0.5 - abs( kt ) ) / kw, 0.0, 1.0 ) ) * 1.3;
		} else {
			vec2 kc = kq; kc.x += 0.5 * mod( floor( kc.y ), 2.0 );
			vec2 kt = fract( kc ) - 0.5; float kd = length( kt );
			kh = 1.0 - smoothstep( 0.10, 0.44, kd );
			kg = kd > 1e-4 ? -( kt / kd ) * smoothstep( 0.06, 0.2, kd ) * ( 1.0 - smoothstep( 0.36, 0.46, kd ) ) * 1.5 : vec2( 0.0 );
		}
		normal = normalize( normal - ( ktb[ 0 ] * kg.x + ktb[ 1 ] * kg.y ) * kfade );
		diffuseColor.rgb *= mix( 1.0, 0.62 + 0.78 * kh * kh, kfade );
	}
}
#endif
`, eA = null;
function rF() {
  if (eA) return eA;
  let o = ao(), t = new THREE.MeshStandardMaterial({ color: 16777215, metalness: 1, roughness: 1, vertexColors: true, normalMap: o.steel.normalMap, roughnessMap: o.steel.roughnessMap, normalScale: new THREE.Vector2(0.2, 0.2) });
  return t.onBeforeCompile = (e) => {
    e.vertexShader = e.vertexShader.replace("#include <common>", `#include <common>
attribute vec3 aMR;
attribute vec3 aK;
varying vec3 vMR;
varying vec3 vK;`).replace("#include <begin_vertex>", `#include <begin_vertex>
vMR = aMR; vK = aK;`), e.fragmentShader = e.fragmentShader.replace("#include <common>", `#include <common>
varying vec3 vMR;
varying vec3 vK;`).replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
roughnessFactor = clamp( roughnessFactor * vMR.y, 0.03, 1.0 );`).replace("#include <metalnessmap_fragment>", `#include <metalnessmap_fragment>
metalnessFactor = vMR.x;`).replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
` + BQ).replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
totalEmissiveRadiance += vColor.rgb * vMR.z;`);
  }, t.customProgramCacheKey = () => "gh-att-hard-1", t.name = "att:hardware", t.userData = { base: new THREE.Color(2829359), wear: 1 }, eA = t;
}
var nT = "#b9bdc2", ua = "#e6e3da", eF = "#c9412f", oT = "#e2b320", sA = null;
function aT() {
  if (sA) return sA;
  let o = 2048, t = 1024, e = we(o, t), s = e.getContext("2d"), n = {};
  s.textBaseline = "middle", s.fillStyle = nT, s.strokeStyle = nT;
  let i = (x, g = 600) => `${g} ${x}px Bahnschrift, "Segoe UI", Arial, sans-serif`, a = 0, r = 0, l = 0, c = (x, g, b, v) => {
    if (a + g > o && (a = 0, r += l + 4, l = 0), r + b > t) throw new Error("attachments: label atlas is full at " + x);
    s.save(), s.translate(a, r), s.beginPath(), s.rect(0, 0, g, b), s.clip(), s.fillStyle = nT, s.strokeStyle = nT, s.lineWidth = 3, v(g, b), s.restore(), n[x] = [a / o, 1 - (r + b) / t, (a + g) / o, 1 - r / t, g / b], a += g + 4, l = Math.max(l, b);
  }, h = (x, g, b, v, y, M) => {
    s.font = i(g, y), M && (s.fillStyle = M), s.fillText(x, b, v);
  }, f = (x, g, b, v, y = 7) => {
    let M = Math.atan2(v - g, b - x);
    s.beginPath(), s.moveTo(x, g), s.lineTo(b - Math.cos(M) * y, v - Math.sin(M) * y), s.stroke(), s.beginPath(), s.moveTo(b, v), s.lineTo(b - Math.cos(M - 0.5) * y * 2, v - Math.sin(M - 0.5) * y * 2), s.lineTo(b - Math.cos(M + 0.5) * y * 2, v - Math.sin(M + 0.5) * y * 2), s.closePath(), s.fill();
  }, u = (x, g, b, v, y, M, w = 3) => {
    for (let T = 0; T < v; T++) {
      let S = T / v * Pn - Math.PI / 2, E = T % y === 0 ? M * 1.8 : M;
      s.lineWidth = T % y === 0 ? w * 1.4 : w, s.beginPath(), s.moveTo(x + Math.cos(S) * b, g + Math.sin(S) * b), s.lineTo(x + Math.cos(S) * (b - E), g + Math.sin(S) * (b - E)), s.stroke();
    }
  }, d = (x, g, b, v, y, M, w, T = 700) => {
    s.font = i(y, T), s.textAlign = "center";
    for (let S = 0; S < x.length; S++) {
      let E = M + S * w;
      s.save(), s.translate(g + Math.sin(E) * v, b - Math.cos(E) * v), s.rotate(E), s.fillText(x[S], 0, 0), s.restore();
    }
    s.textAlign = "left";
  };
  c("kite", 300, 112, () => {
    h("KITE", 84, 6, 46, 700), h("RDS-2 \xB7 2 MOA", 26, 9, 94), s.lineWidth = 4, s.beginPath(), s.moveTo(214, 70), s.lineTo(250, 14), s.lineTo(286, 70), s.lineTo(250, 52), s.closePath(), s.stroke();
  }), c("kiteSN", 300, 40, () => {
    h("SN KR2-118406   GH-ARMS", 24, 4, 22);
  }), c("halo", 372, 112, () => {
    h("HALO", 84, 6, 46, 700), s.lineWidth = 5, s.beginPath(), s.arc(316, 44, 30, 0, Pn), s.stroke(), s.beginPath(), s.arc(316, 44, 5, 0, Pn), s.fill();
    for (let x = 0; x < 4; x++) {
      let g = x * Math.PI / 2;
      s.beginPath(), s.moveTo(316 + Math.cos(g) * 30, 44 + Math.sin(g) * 30), s.lineTo(316 + Math.cos(g) * 42, 44 + Math.sin(g) * 42), s.stroke();
    }
    h("HOLOGRAPHIC WEAPON SIGHT", 22, 9, 96);
  }), c("haloSN", 330, 64, () => {
    h("MODEL H1   SN 3310476", 24, 4, 18), h("GH-ARMS  \xB7  1\xD7 \xB7 68 MOA RING", 20, 4, 48);
  }), c("vantage", 430, 104, () => {
    h("VANTAGE", 70, 6, 40, 700), h("2.5\xD732 PRISM  \xB7  FOV 12.4\xB0", 26, 9, 86);
  }), c("vantSN", 300, 40, () => {
    h("SN VP25-01937", 26, 4, 22);
  }), c("micro", 300, 76, () => {
    h("KITE\xB7MICRO", 46, 4, 26, 700), h("3.25 MOA   SN KM-55218", 20, 6, 60);
  }), c("up", 120, 72, () => {
    h("UP", 40, 6, 38, 700), s.lineWidth = 5, s.beginPath(), s.arc(86, 40, 20, Math.PI * 0.9, Math.PI * 1.9), s.stroke(), f(100, 26, 106, 40, 6);
  }), c("rt", 120, 72, () => {
    h("R", 40, 10, 38, 700), s.lineWidth = 5, s.beginPath(), s.arc(76, 40, 20, Math.PI * 0.9, Math.PI * 1.9), s.stroke(), f(90, 26, 96, 40, 6);
  }), c("plus", 64, 64, () => {
    s.fillStyle = ua, s.fillRect(12, 27, 40, 10), s.fillRect(27, 12, 10, 40);
  }), c("minus", 64, 64, () => {
    s.fillStyle = ua, s.fillRect(12, 27, 40, 10);
  }), c("nv", 64, 64, () => {
    h("NV", 34, 8, 34, 700, ua);
  }), c("tri", 64, 64, () => {
    s.fillStyle = ua, s.beginPath(), s.moveTo(32, 10), s.lineTo(56, 52), s.lineTo(8, 52), s.closePath(), s.fill();
  }), c("ticks", 256, 256, () => {
    u(128, 128, 124, 36, 3, 14), d("0369", 128, 128, 84, 34, 0, Math.PI / 2);
  }), c("dial", 256, 256, () => {
    u(128, 128, 124, 16, 2, 12, 4), d("0123456N", 128, 128, 88, 34, 0, Pn / 8);
  }), c("modes", 256, 256, () => {
    s.fillStyle = ua, s.strokeStyle = ua, u(128, 128, 122, 8, 2, 12, 5), s.font = i(30, 700), s.textAlign = "center";
    let x = ["OFF", "VIS", "IR", "DUAL"];
    for (let g = 0; g < 4; g++) {
      let b = -Math.PI * 0.42 + g * Math.PI * 0.28;
      s.save(), s.translate(128 + Math.sin(b) * 84, 128 - Math.cos(b) * 84), s.rotate(b), s.fillText(x[g], 0, 0), s.restore();
    }
    s.textAlign = "left";
  }), c("batt", 210, 44, () => {
    h("CR2032  3V  +", 28, 4, 24);
  }), c("batt123", 210, 44, () => {
    h("CR123A  3V", 28, 4, 24);
  }), c("focus", 200, 44, () => {
    h("\u2212   0   +", 34, 22, 23, 700, ua);
  }), c("lock", 200, 44, () => {
    s.fillStyle = ua, s.strokeStyle = ua, h("LOCK", 30, 70, 24, 700, ua), f(60, 22, 8, 22, 8);
  }), c("warnY", 320, 160, (x, g) => {
    s.fillStyle = oT, s.fillRect(0, 0, x, g), s.fillStyle = "#0c0c0c", s.strokeStyle = "#0c0c0c", s.fillRect(6, 6, x - 12, 34), h("DANGER", 30, 104, 24, 700, oT), s.fillStyle = "#0c0c0c", s.lineWidth = 3;
    for (let b = 0; b < 12; b++) {
      let v = b / 12 * Pn;
      s.beginPath(), s.moveTo(50 + Math.cos(v) * 10, 98 + Math.sin(v) * 10), s.lineTo(50 + Math.cos(v) * (b % 2 ? 26 : 36), 98 + Math.sin(v) * (b % 2 ? 26 : 36)), s.stroke();
    }
    s.beginPath(), s.arc(50, 98, 7, 0, Pn), s.fill(), h("LASER RADIATION", 24, 100, 62, 700), h("AVOID DIRECT EYE", 21, 100, 90, 600), h("EXPOSURE", 21, 100, 114, 600), h("635 nm / 850 nm  <5 mW  CLASS 3R", 15, 100, 142, 600);
  }), c("class", 236, 60, (x, g) => {
    s.fillStyle = oT, s.fillRect(0, 0, x, g), s.fillStyle = "#0c0c0c", h("CLASS 2 LASER PRODUCT", 19, 8, 20, 700), h("DO NOT STARE INTO BEAM", 17, 8, 43, 600);
  }), c("mono", 560, 92, () => {
    h("MONOLITH", 78, 6, 44, 700), s.lineWidth = 4, s.strokeRect(404, 12, 96, 58), h("QD", 40, 424, 42, 700);
  }), c("cal556", 300, 44, () => {
    h("CAL 5.56 NATO", 32, 4, 24);
  }), c("cal9", 300, 44, () => {
    h("CAL 9\xD719 MM", 32, 4, 24);
  }), c("cal12", 300, 44, () => {
    h("12 GAUGE", 32, 4, 24);
  }), c("suppSN", 420, 44, () => {
    h("SN MS-04417   GH-ARMS", 30, 4, 24);
  }), c("suppWarn", 520, 36, () => {
    h("ENSURE MOUNT IS LOCKED BEFORE FIRING", 22, 4, 19);
  }), c("choke", 620, 52, () => {
    h("FULL  \xB7  .690  \xB7  12 GA  \xB7  STEEL OK", 36, 4, 28, 700);
  }), c("comp", 170, 40, () => {
    h("PC-556", 30, 4, 22, 700);
  }), c("brake", 170, 40, () => {
    h("SB-3M", 30, 4, 22, 700);
  }), c("vfg", 250, 90, () => {
    s.lineWidth = 5, s.strokeRect(6, 8, 74, 70), h("GH", 46, 14, 45, 700), h("VFG-2", 48, 96, 44, 700);
  }), c("afg", 250, 90, () => {
    s.lineWidth = 5, s.strokeRect(6, 8, 74, 70), h("GH", 46, 14, 45, 700), h("AFG-K", 48, 96, 44, 700);
  }), c("tl1", 300, 84, () => {
    h("TL-1", 60, 4, 32, 700, ua), h("TAC LASER  \xB7  VIS / IR", 22, 6, 68, 600, ua);
  }), c("fire", 110, 40, () => {
    h("FIRE", 32, 6, 22, 700, ua);
  }), c("el", 110, 44, () => {
    s.fillStyle = ua, s.strokeStyle = ua, h("EL", 30, 4, 24, 700, ua), f(62, 34, 62, 8, 6), f(88, 8, 88, 36, 6);
  }), c("wd", 110, 44, () => {
    s.fillStyle = ua, s.strokeStyle = ua, h("WD", 28, 4, 24, 700, ua), f(64, 14, 104, 14, 6), f(104, 32, 64, 32, 6);
  }), c("remote", 150, 36, () => {
    h("REMOTE", 26, 4, 20, 700, ua);
  }), c("redDot", 40, 40, () => {
    s.fillStyle = eF, s.beginPath(), s.arc(20, 20, 15, 0, Pn), s.fill();
  }), c("whiteDot", 40, 40, () => {
    s.fillStyle = ua, s.beginPath(), s.arc(20, 20, 15, 0, Pn), s.fill();
  }), c("line", 40, 40, () => {
    s.fillStyle = ua, s.fillRect(0, 0, 40, 40);
  }), c("redLine", 40, 40, () => {
    s.fillStyle = eF, s.fillRect(0, 0, 40, 40);
  }), c("whiteLine", 40, 40, () => {
    s.fillStyle = "#d9d4c6", s.fillRect(0, 0, 40, 40);
  }), c("yelLine", 40, 40, () => {
    s.fillStyle = oT, s.fillRect(0, 0, 40, 40);
  });
  let m = makeCanvasTexture(e);
  m.anisotropy = 8, m.colorSpace = THREE.SRGBColorSpace;
  let p = new THREE.MeshStandardMaterial({ map: m, color: 16777215, transparent: true, roughness: 0.55, metalness: 0.15, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  return p.name = "att:marks", p.userData = { base: new THREE.Color(6974576), wear: 1, cells: n }, sA = p;
}
function An(o, t, e) {
  let s = aT().userData.cells[o];
  if (!s) throw new Error("attachments: unknown label " + o);
  e || (e = t / s[4]);
  let n = new THREE.PlaneGeometry(t, e), i = n.attributes.uv;
  for (let a = 0; a < i.count; a++) i.setXY(a, s[0] + i.getX(a) * (s[2] - s[0]), s[1] + i.getY(a) * (s[3] - s[1]));
  return n.translate(0, 0, 0.05), Qe(n);
}
function M4(o, t, e, s = {}) {
  let n = aT().userData.cells[o];
  if (!n) throw new Error("attachments: unknown label " + o);
  let i = s.h || e / n[4], a = (s.phi ?? 180) * Hs, r = s.u || 0, l = s.x || 0, c = s.y || 0, h = t + 0.05, f = new $c(), u = s.along !== false, d = u ? i : e, m = Math.max(2, Math.ceil(d / t / (9 * Hs))), p = Math.cos(a) < -1e-6 || Math.abs(Math.cos(a)) <= 1e-6 && s.flip ? 1 : -1;
  for (let x = 0; x < m; x++) {
    let g = x / m, b = (x + 1) / m, v = [];
    for (let [y, M] of u ? [[0, g], [1, g], [1, b], [0, b]] : [[g, 0], [b, 0], [b, 1], [g, 1]]) {
      let w, T;
      u ? (w = a - p * (M - 0.5) * i / t, T = -r + p * (y - 0.5) * e) : (w = a - (y - 0.5) * e / t, T = -(r + (M - 0.5) * i)), v.push({ p: [l + h * Math.cos(w), c + h * Math.sin(w), T], n: [Math.cos(w), Math.sin(w), 0], t: [n[0] + y * (n[2] - n[0]), n[1] + M * (n[3] - n[1])] });
    }
    for (let [y, M, w] of [[v[0], v[1], v[2]], [v[0], v[2], v[3]]]) {
      let T = M.p[0] - y.p[0], S = M.p[1] - y.p[1], E = M.p[2] - y.p[2], _ = w.p[0] - y.p[0], R = w.p[1] - y.p[1], C = w.p[2] - y.p[2];
      (S * C - E * R) * y.n[0] + (E * _ - T * C) * y.n[1] > 0 ? f.tri(y.p, M.p, w.p, [y.n, M.n, w.n], [y.t, M.t, w.t]) : f.tri(y.p, w.p, M.p, [y.n, w.n, M.n], [y.t, w.t, M.t]);
    }
  }
  return f.geo();
}
function sF(o, t, e, s, n) {
  let i = o.attributes.color.array;
  for (let a = 0; a < i.length; a += 3) {
    let r = i[a] > 1.5 ? n : 1;
    i[a] = t * r, i[a + 1] = e * r, i[a + 2] = s * r;
  }
}
function Jc(o) {
  let t = { body: [], hard: [], mark: [], lens: [] }, e = o && o.userData.wear || 1, s = { body(...n) {
    for (let i of n.flat()) i && (sF(i, 1, 1, 1, e), t.body.push(i));
    return s;
  }, hard(n, ...i) {
    let a = typeof n == "string" ? NQ[n] : n;
    if (!a) throw new Error("attachments: unknown look " + n);
    for (let r of i.flat()) {
      if (!r) continue;
      sF(r, a.c.r, a.c.g, a.c.b, a.wear || 1);
      let l = r.attributes.position.count, c = new Float32Array(l * 3);
      for (let h = 0; h < l; h++) c[h * 3] = a.m, c[h * 3 + 1] = a.r, c[h * 3 + 2] = a.e || 0;
      r.setAttribute("aMR", new THREE.BufferAttribute(c, 3)), r.attributes.aK || r.setAttribute("aK", new THREE.BufferAttribute(new Float32Array(l * 3), 3)), t.hard.push(r);
    }
    return s;
  }, mark(...n) {
    for (let i of n.flat()) i && t.mark.push(i);
    return s;
  }, lens(...n) {
    for (let i of n.flat()) i && t.lens.push(i);
    return s;
  }, screw(n, i, a = {}) {
    let r = a.r || 1.9, l = a.h ?? 0.8, c = Math.min(0.35, l * 0.45, r * 0.3), h = a.seg || 10, f = a.drive || "torx";
    s.hard(a.look || "oxide", Ie(Zc([[0, r], [l - c, r], [l, r - c, 1], [l, 0]], { seg: h }), n, i));
    let u = null;
    if (f === "hex") u = yh(6, r * 0.56, a.roll ? a.roll * Hs : 0.3);
    else if (f === "torx") u = Array.from({ length: 12 }, (d, m) => {
      let p = m / 12 * Pn + 0.2, x = m % 2 ? r * 0.34 : r * 0.62;
      return [Math.cos(p) * x, Math.sin(p) * x];
    });
    else if (f === "slot") {
      let d = (a.roll || 0) * Hs, m = Math.cos(d), p = Math.sin(d), x = r * 0.86, g = Math.max(0.22, r * 0.16);
      u = [[-x, -g], [x, -g], [x, g], [-x, g]].map(([b, v]) => [b * m - v * p, b * p + v * m]);
    }
    if (u) {
      let d = new THREE.Shape();
      d.moveTo(u[0][0], u[0][1]);
      for (let p = 1; p < u.length; p++) d.lineTo(u[p][0], u[p][1]);
      d.closePath();
      let m = new THREE.ShapeGeometry(d);
      m.translate(0, 0, l + 0.02), s.hard("black", Ie(Qe(m), n, i));
    }
    return s;
  }, stripe(n, i, a = 4.2, r = 30, l = "redLine") {
    let c = An(l, a, 0.55);
    return c.translate(a * 0.32, 0, 0), s.mark(Ie(c, n, i, r)), s;
  }, finish() {
    let n = { tris: 0, parts: {} };
    for (let i in t) {
      if (!t[i].length) {
        n[i] = null;
        continue;
      }
      let a = i === "body" ? ["position", "normal", "uv", "color"] : i === "hard" ? ["position", "normal", "uv", "color", "aMR", "aK"] : i === "mark" ? ["position", "normal", "uv"] : ["position", "normal", "aGlass"], r = t[i].map((c) => {
        c.index && (c = c.toNonIndexed());
        for (let h of Object.keys(c.attributes)) a.includes(h) || c.deleteAttribute(h);
        for (let h of a) if (!c.attributes[h]) throw new Error(`attachments: ${i} part without ${h}`);
        return c.morphAttributes = {}, c.clearGroups(), c;
      }), l = r.length > 1 ? Vn(r, false) : r[0];
      if (l.scale(1e-3, 1e-3, 1e-3), l.attributes.uv) {
        let c = l.attributes.uv.array;
        for (let h = 0; h < c.length; h++) c[h] *= i === "mark" ? 1 : 1e-3;
      }
      l.computeBoundingBox(), l.computeBoundingSphere(), n[i] = l, n.parts[i] = l.attributes.position.count / 3, n.tris += n.parts[i];
    }
    return n;
  } };
  return s;
}
function lF(o, t, e, s = 1, n = 20.6) {
  let i = [[o, e + s * 7.5], [o, e + s * 3.3]];
  for (let a = o + 2.4; a + 5.2 < t - 1.2; a += 10) i.push([a, e + s * 3.3], [a, e], [a + 5.2, e], [a + 5.2, e + s * 3.3]);
  return i.push([t, e + s * 3.3], [t, e + s * 7.5]), wr(i, n, { b: 0.45 });
}
function rT(o, t, e = {}) {
  let s = e.hw || 14.3, n = e.top ?? 9, i = e.u0 ?? -t / 2;
  o.body(jo([[-10.4, 0], [-10.4, -5.4], [-12.4, -5.4, 0.5], [-16, -2.4, 0.8], [-16, 5.2, 0.8], [-s, 7.4, 0.5], [-s, n], [s, n], [s, 3.2], [10.4, 3.2], [10.4, 0]], t, { u: i, b: 0.5 }));
  let a = t - (e.inset ?? 6);
  o.body(jo([[10.45, 2.9], [16.2, 2.9, 0.8], [16.2, -2.4, 0.8], [12.6, -5.4, 0.5], [10.45, -5.4]], a, { u: i + (t - a) / 2, b: 0.5 }));
}
function cF(o, t, e, s = {}) {
  let n = s.hw || 14.3, i = e - (s.depth ?? 9), a = s.u0 ?? -t / 2, r = (h) => e - h, l = (h) => s.look ? o.hard(s.look, h) : o.body(h);
  l(jo([[-10.4, r(0)], [-10.4, r(-5.4)], [-12.4, r(-5.4), 0.5], [-16, r(-2.4), 0.8], [-16, r(5.2), 0.8], [-n, r(7.4), 0.5], [-n, i], [n, i], [n, r(3.2)], [10.4, r(3.2)], [10.4, r(0)]], t, { u: a, b: 0.5 }));
  let c = t - (s.inset ?? 6);
  l(jo([[10.45, r(2.9)], [16.2, r(2.9), 0.8], [16.2, r(-2.4), 0.8], [12.6, r(-5.4), 0.5], [10.45, r(-5.4)]], c, { u: a + (t - c) / 2, b: 0.5 }));
}
function w4(o, t, e = {}) {
  let s = o / 2 / Math.cos(Math.PI / 6), n = Math.min(0.6, t * 0.3);
  return cn([[0, s], [t - n, s], [t, s - n * 1.2, 1], [t, e.bore ?? 0]], { seg: 6, flat: true }).rotateX(Math.PI);
}
function oA(o, t, e, s = 5) {
  let n = [], i = o / 2, a = t / 2;
  e = Math.min(e, i, a);
  for (let [r, l, c] of [[i - e, a - e, 0], [-i + e, a - e, 0.25], [-i + e, -a + e, 0.5], [i - e, -a + e, 0.75]]) for (let h = 0; h <= s; h++) {
    let f = (c + h / s * 0.25) * Pn;
    n.push([r + Math.cos(f) * e, l + Math.sin(f) * e]);
  }
  return n;
}
var iA = (o, t = 28) => Array.from({ length: t }, (e, s) => [Math.cos(s / t * Pn) * o, Math.sin(s / t * Pn) * o]);
function fF(o, t) {
  let e = new Float32Array(o.length * 3), s = /* @__PURE__ */ new Map(), n = [], i = (h) => {
    let f = Math.round(h[0] * 1e4) + "," + Math.round(h[1] * 1e4) + "," + Math.round(h[2] * 1e4), u = s.get(f);
    return u === void 0 && (u = n.length, s.set(f, u), n.push([0, 0, 0])), u;
  }, a = o.map(i);
  for (let h = 0; h < o.length; h += 3) {
    let f = o[h], u = o[h + 1], d = o[h + 2], m = [(u[1] - f[1]) * (d[2] - f[2]) - (u[2] - f[2]) * (d[1] - f[1]), (u[2] - f[2]) * (d[0] - f[0]) - (u[0] - f[0]) * (d[2] - f[2]), (u[0] - f[0]) * (d[1] - f[1]) - (u[1] - f[1]) * (d[0] - f[0])];
    for (let p = 0; p < 3; p++) {
      let x = n[a[h + p]];
      x[0] += m[0], x[1] += m[1], x[2] += m[2];
    }
  }
  let r = new Float32Array(o.length * 3), l = new Float32Array(o.length).fill(t);
  o.forEach((h, f) => {
    e.set(h, f * 3);
    let u = n[a[f]], d = Math.hypot(u[0], u[1], u[2]) || 1;
    r.set([u[0] / d, u[1] / d, u[2] / d], f * 3);
  });
  let c = new THREE.BufferGeometry();
  return c.setAttribute("position", new THREE.BufferAttribute(e, 3)), c.setAttribute("normal", new THREE.BufferAttribute(r, 3)), c.setAttribute("aGlass", new THREE.BufferAttribute(l, 1)), c;
}
function Hu(o, t = {}) {
  let e = o.r ? iA(o.r, o.n || 28) : oA(o.w, o.h, o.rc || 0, 5), s = t.x || 0, n = t.y || 0, i = t.back ? 1 : -1, a = -(t.u || 0), r = t.bulge || 0, l = [0.5, 1], c = [], h = (d, m) => {
    let p = e[(d + e.length) % e.length];
    return [s + p[0] * m, n + p[1] * m, a + i * r * (1 - m * m)];
  }, f = (d, m, p) => {
    t.back ? c.push(d, m, p) : c.push(d, p, m);
  }, u = [s, n, a + i * r];
  for (let d = 0; d < e.length; d++) {
    f(u, h(d, l[0]), h(d + 1, l[0]));
    for (let m = 0; m < l.length - 1; m++) {
      let p = h(d, l[m]), x = h(d + 1, l[m]), g = h(d + 1, l[m + 1]), b = h(d, l[m + 1]);
      f(p, b, g), f(p, g, x);
    }
  }
  return fF(c, t.kind ?? 0);
}
function S5(o, t, e = {}) {
  let s = o.r ? iA(o.r, o.n || 28) : oA(o.w, o.h, o.rc || 0, 5), n = o.r ? iA(o.r - t, o.n || 28) : oA(o.w - 2 * t, o.h - 2 * t, Math.max(0.2, (o.rc || 0) - t), 5), i = e.x || 0, a = e.y || 0, r = [];
  for (let l = 0; l < s.length; l++) {
    let c = (l + 1) % s.length, h = [i + s[l][0], a + s[l][1], -e.u0], f = [i + s[c][0], a + s[c][1], -e.u0], u = [i + n[c][0], a + n[c][1], -e.u1], d = [i + n[l][0], a + n[l][1], -e.u1];
    e.back ? r.push(h, f, u, h, u, d) : r.push(h, u, f, h, d, u);
  }
  return fF(r, 2);
}
var UQ = `
attribute float aGlass;
uniform vec3 uCenter;
varying vec3 vView; varying vec3 vN; varying vec3 vF; varying vec3 vR; varying vec3 vU; varying vec3 vC; varying vec3 vLocal; varying float vGlass;
void main() {
	vec4 p = modelViewMatrix * vec4( position, 1.0 );
	vView = p.xyz;
	vF = normalize( ( modelViewMatrix * vec4( 0.0, 0.0, -1.0, 0.0 ) ).xyz );
	vR = normalize( ( modelViewMatrix * vec4( 1.0, 0.0, 0.0, 0.0 ) ).xyz );
	vU = normalize( ( modelViewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
	vC = ( modelViewMatrix * vec4( uCenter, 1.0 ) ).xyz;
	vN = normalMatrix * normal;
	vLocal = position; vGlass = aGlass;
	gl_Position = projectionMatrix * p;
}`, VQ = `
uniform vec3 uColor; uniform float uBright; uniform vec4 uTint; uniform vec4 uCoat; uniform vec4 uRet; uniform vec4 uScope; uniform vec3 uCenter; uniform float uObjR;
varying vec3 vView; varying vec3 vN; varying vec3 vF; varying vec3 vR; varying vec3 vU; varying vec3 vC; varying vec3 vLocal; varying float vGlass;
// what the glass mirrors, in the gun's own frame (x right, y up, z back): teal sky, warm horizon, a low orange sun
// behind the shooter's left shoulder
vec3 envMap( vec3 r ) {
	vec3 c = mix( vec3( 0.075, 0.055, 0.042 ), vec3( 0.15, 0.25, 0.36 ), smoothstep( -0.3, 0.6, r.y ) );
	// a run of tall sunset-lit windows all around (bright panes, dark mullions), strongest towards the sun
	float az = atan( r.x, r.z );
	float pane = smoothstep( 0.15, 0.5, sin( az * 7.0 + 0.9 ) );
	float band = smoothstep( -0.16, -0.05, r.y ) * ( 1.0 - smoothstep( 0.38, 0.5, r.y ) );
	float sunSide = 0.22 + 0.78 * max( 0.0, dot( normalize( r.xz + 1e-5 ), vec2( -0.464, 0.886 ) ) );
	c += vec3( 1.9, 1.1, 0.52 ) * pane * band * sunSide;
	c += vec3( 0.5, 0.56, 0.62 ) * smoothstep( 0.80, 0.9, r.y ) * 0.5;                  // soft ceiling light
	float sun = max( dot( r, vec3( -0.44, 0.31, 0.84 ) ), 0.0 );
	c += vec3( 5.2, 2.7, 1.1 ) * ( pow( sun, 70.0 ) + 0.08 * pow( sun, 6.0 ) );
	return c;
}
float seg( vec2 p, vec2 a, vec2 b ) { vec2 pa = p - a, ba = b - a; return length( pa - ba * clamp( dot( pa, ba ) / dot( ba, ba ), 0.0, 1.0 ) ); }
float hash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
void main() {
	vec3 d = normalize( vView ), f = normalize( vF ), rr = normalize( vR ), uu = normalize( vU );
	vec3 n = normalize( vN ); if ( ! gl_FrontFacing ) n = -n;
	float ndv = clamp( -dot( d, n ), 0.0, 1.0 ), fres = pow( 1.0 - ndv, 4.0 );
	vec3 rv = reflect( d, n );
	vec3 E = envMap( vec3( dot( rv, rr ), dot( rv, uu ), -dot( rv, f ) ) );
	float fz = dot( d, f );
	vec2 ang = vec2( dot( d, rr ), dot( d, uu ) ) / max( abs( fz ), 1e-4 );      // tan-angles off the optical axis
	vec2 fwa = fwidth( ang ); float px = 0.7 * max( fwa.x, fwa.y ) + 1e-6;
	float rad = length( ang );
	vec3 col = vec3( 0.0 ); float a = 0.0;
	if ( vGlass > 1.5 && vGlass < 2.5 ) {
		// ground edge: frosted, greenish, catches the light
		a = 0.62 + 0.3 * fres;
		col = vec3( 0.035, 0.07, 0.062 ) * ( 0.25 + 0.9 * E.g ) + E * ( 0.05 + 0.5 * fres );
	} else if ( vGlass > 2.5 ) {
		// objective: you look into a black tube through multi-coated glass
		float t = 1.0 - ndv;
		vec3 coat = mix( vec3( 0.16, 0.85, 0.42 ), vec3( 0.78, 0.22, 0.95 ), smoothstep( 0.03, 0.55, t ) );
		float lr = length( vLocal.xy - uCenter.xy ) / uObjR;
		vec3 rv2 = reflect( d, normalize( n + f * 1.35 ) );                        // ghost off the inner elements
		vec3 E2 = envMap( vec3( dot( rv2, rr ), dot( rv2, uu ), -dot( rv2, f ) ) );
		col = vec3( 0.004, 0.005, 0.007 ) + E * coat * ( 0.05 + 0.8 * fres ) + E2 * coat.zxy * 0.025 * ( 1.0 - lr * lr );
		col += coat * 0.01 * smoothstep( 0.55, 1.0, lr );
		a = 1.0;
	} else if ( fz > 0.0 ) {
		// looking down-range through the glass
#if RET == 2
		if ( vGlass < 0.5 ) {
			vec3 e = vec3( -dot( vC, rr ), -dot( vC, uu ), dot( vC, f ) );          // eye in the scope's frame, metres; e.z = behind the ocular
			float fs = 1.0 - smoothstep( uScope.z - 0.016, uScope.z, rad );          // field stop
			vec2 bp = e.xy + ang * ( e.z - uScope.x );                               // where this field angle's beam passes the eye
			float ep = 1.0 - smoothstep( uScope.y * 0.5, uScope.y, length( bp ) );   // exit pupil (scope shadow)
			float vis = fs * ep * step( 0.0, e.z );
#ifdef NO_PORTAL
			vis = 0.0;
#endif
			vis *= 1.0 - 0.32 * smoothstep( uScope.z * 0.62, uScope.z, rad );        // falloff towards the edge of the field
			vec2 p = ang / uRet.x;
			// etched glass reticle
			float chev = min( seg( p, vec2( 0.0 ), vec2( -0.0105, -0.0185 ) ), seg( p, vec2( 0.0 ), vec2( 0.0105, -0.0185 ) ) ) - 0.0016;
			float pa = atan( p.x, -p.y ), pr = length( p ), g0 = 0.72;
			float shoe = abs( pr - 0.052 ) - 0.0024;
			if ( abs( pa ) < g0 ) shoe = min( length( p - 0.052 * vec2( sin( g0 ), -cos( g0 ) ) ), length( p - 0.052 * vec2( -sin( g0 ), -cos( g0 ) ) ) ) - 0.0024;
			float lit = min( chev, shoe );
			float etch = seg( p, vec2( 0.0, -0.030 ), vec2( 0.0, -0.152 ) ) - 0.0008;
			etch = min( etch, seg( p, vec2( -0.020, -0.047 ), vec2( 0.020, -0.047 ) ) - 0.0010 );
			etch = min( etch, seg( p, vec2( -0.016, -0.072 ), vec2( 0.016, -0.072 ) ) - 0.0010 );
			etch = min( etch, seg( p, vec2( -0.0125, -0.100 ), vec2( 0.0125, -0.100 ) ) - 0.0010 );
			etch = min( etch, seg( p, vec2( -0.0095, -0.131 ), vec2( 0.0095, -0.131 ) ) - 0.0010 );
			vec2 q = abs( p );
			etch = min( etch, max( abs( q.y ) - 0.0042 * smoothstep( 0.098, 0.125, q.x ) - 0.0006, 0.100 - q.x ) );      // side posts, tapered tips
			etch = min( etch, max( abs( p.x ) - 0.0042 * smoothstep( 0.168, 0.195, -p.y ) - 0.0006, 0.170 + p.y ) );     // bottom post
			float w = px / uRet.x;
			float mEtch = 1.0 - smoothstep( -w, w, min( etch, lit ) );
			float mLit = 1.0 - smoothstep( -w, w, lit );
			float glow = exp( -max( lit, 0.0 ) / 0.0045 ) * 0.16;
			float clearA = uTint.a;
			a = 1.0 - vis * ( 1.0 - clearA ) * ( 1.0 - 0.95 * mEtch );
			col = uTint.rgb * clearA * vis;
			col += uColor * uBright * uScope.w * vis * ( mLit + glow * ( 1.0 - mLit ) );
			col += E * vec3( 0.55, 0.36, 0.8 ) * ( 0.006 + 0.5 * ( 1.0 - ndv ) * ( 1.0 - ndv ) );   // coating sheen on the eyepiece
		} else
#endif
		{
			a = uTint.a + 0.22 * fres;
			col = uTint.rgb * a + E * ( 0.004 + 0.34 * fres );
			if ( vGlass < 0.5 ) {
#if RET == 0
				float core = 1.0 - smoothstep( uRet.x - px, uRet.x + px, rad );
				float halo = 0.11 * exp( -rad * rad / ( uRet.x * uRet.x * 14.0 ) ) + 0.018 * exp( -rad / ( uRet.x * 7.0 ) );
				col += uColor * uBright * ( core + halo );
#elif RET == 1
				float ring = abs( rad - uRet.x ) - uRet.y;
				vec2 q = abs( ang ); vec2 t = q.x > q.y ? q : q.yx;
				float tick = max( t.y - uRet.y * 0.9, max( uRet.x - t.x, t.x - uRet.x - uRet.z ) );
				float m = 1.0 - smoothstep( -px, px, min( ring, tick ) );
				float core = 1.0 - smoothstep( uRet.w - px, uRet.w + px, rad );
				float sp = 0.74 + 0.5 * hash( floor( ang * 4200.0 ) );                 // laser speckle
				float halo = 0.07 * exp( -max( min( ring, tick ), 0.0 ) / ( uRet.y * 3.0 ) ) + 0.10 * exp( -rad * rad / ( uRet.w * uRet.w * 12.0 ) );
				col += uColor * uBright * ( ( m * 0.82 + core ) * sp + halo );
#endif
			}
		}
	} else {
		// from the muzzle side: the coating mirrors the world
		a = uCoat.a + ( 1.0 - uCoat.a ) * fres;
		col = uCoat.rgb * ( E * 0.9 + 0.035 ) * a;
	}
	gl_FragColor = vec4( col, a );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
}`, GQ = { reflex: { ret: 0, color: [6.5, 0.32, 0.2], tint: [0.03, 0.07, 0.08, 0.045], coat: [1.05, 0.36, 0.13, 0.46], dims: [21e-4, 0, 0, 0] }, microdot: { ret: 0, color: [6.5, 0.32, 0.2], tint: [0.03, 0.07, 0.08, 0.04], coat: [1.05, 0.36, 0.13, 0.46], dims: [24e-4, 0, 0, 0] }, holo: { ret: 1, color: [6, 0.36, 0.22], tint: [0.03, 0.06, 0.045, 0.04], coat: [0.36, 0.62, 0.5, 0.34], dims: [0.015, 85e-5, 36e-4, 12e-4] }, prism: { ret: 2, color: [5, 0.42, 0.16], tint: [0.05, 0.05, 0.07, 0.03], coat: [0.5, 0.4, 0.8, 1], dims: [1, 0, 0, 0] } }, hF = /* @__PURE__ */ new Map();
function vy(o, t = {}) {
  let e = o === "prism" && t.portal !== false, s = o + (o === "prism" && !e ? ":solid" : ""), n = hF.get(s);
  if (n) return n;
  let i = GQ[o];
  return n = new THREE.ShaderMaterial({ defines: o === "prism" && !e ? { RET: i.ret, NO_PORTAL: 1 } : { RET: i.ret }, uniforms: { uColor: { value: new THREE.Vector3(...i.color) }, uBright: { value: 1 }, uTint: { value: new THREE.Vector4(...i.tint) }, uCoat: { value: new THREE.Vector4(...i.coat) }, uRet: { value: new THREE.Vector4(...i.dims) }, uScope: { value: new THREE.Vector4(t.relief || 0.05, t.pupil || 75e-4, t.field || 0.24, 1) }, uCenter: { value: new THREE.Vector3(...t.center || [0, 0, 0]) }, uObjR: { value: t.objective && t.objective.r || 0.014 } }, vertexShader: UQ, fragmentShader: VQ, ...e ? { transparent: false, depthWrite: true, side: THREE.FrontSide, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor } : { transparent: true, depthWrite: false, side: THREE.DoubleSide, premultipliedAlpha: true } }), n.name = "att:lens:" + s, n.userData = { base: new THREE.Color(3149834), wear: 1, keep: "lens", portal: e }, hF.set(s, n), n;
}
function My(o, t, e, s, n = 0.9, i = 0, a = "black") {
  let r = new THREE.PlaneGeometry(s, n);
  r.translate(0, 0, 0.03), o.hard(a, Ie(Qe(r), t, e, i));
}
var wy = (o) => o > 0 ? "R" : "L";
function uF() {
  let o = ao(), t = Jc(o.aluLt), e = 34.5;
  rT(t, 58);
  for (let i of [-20, 20]) t.screw([16.2, 0.2, i], "R", { r: 2.6, h: 1.7, drive: "torx", seg: 12 }), t.stripe([17.92, 0.2, i], "R", 3, i > 0 ? 40 : 155), t.screw([-16, 0.6, i], "L", { r: 2, h: 0.45, drive: "none", seg: 8 });
  t.body(wr([[-29, 9], [29, 9], [29, 12.5, 1], [26.5, 14.5, 1], [-6, 14.5, 1.2], [-9.5, 19.5, 1.5], [-25, 19.5, 2], [-29, 15.5, 1.5]], 28.6, { b: 1.1 }));
  for (let i of [-1, 1]) t.body(wr([[-27.8, 10.2, 1], [-8.2, 10.2, 1], [-8.2, 13.4, 1], [-10.8, 18, 1.2], [-24.4, 18, 1.6], [-27.8, 14.8, 1.2]], 1.3, { x: i * 14.9, b: 0.45 }));
  for (let i = 0; i < 5; i++) t.body(wr(se(-3.6 + i * 2.6, 14.2, -2.3 + i * 2.6, 15.15), 20, { b: 0.3 }));
  for (let [i, a] of [[-22.6, "plus"], [-14.6, "minus"]]) t.hard("rubber", Ie(vh(gl(6.4, 4.8, 1.4), 1, { b: 0.4 }), [-15.55, 14.1, i], "L")), t.mark(Ie(An(a, 2.9), [-16.56, 14.1, i], "L"));
  for (let [i, a] of [[-22.2, 20], [-13.8, 75]]) t.screw([15.55, 14.1, i], "R", { r: 2.1, h: 0.45, drive: "slot", look: "steel", roll: a }), t.mark(Ie(An("ticks", 7.4), [15.55, 14.1, i], "R"));
  {
    let i = [0, 19.5, -17.2];
    t.hard("rubber", Ie(Zc([[0, 6.25], [0.35, 6.25]], { seg: 20 }), i, "T")), t.hard("alu", Ie(Zc([[0.35, 5.7, 0, 0.32], [1.5, 5.7, 0, 0.32], [1.9, 5.25, 1]], { flute: { n: 20, wear: true } }), i, "T")), t.hard("alu", Ie(vh(yh(18, 5.27), 0.75, { b: 0.15, holes: [gl(7.8, 1.3, 0.3)] }).translate(0, 0, 1.15), i, "T", 18)), My(t, [0, 19.5 + 1.2, -17.2], "T", 7.8, 1.3, 18), t.mark(Ie(An("batt", 7.2), [-10.2, 19.5, -12.3], "T", 0));
  }
  t.mark(Ie(An("kite", 10.5), [0, 17.5, -27], [[0, 0.7071, 0.7071], [0, 0.7071, -0.7071]])), t.mark(Ie(An("kiteSN", 15), [0, 12, -29], "B"));
  {
    let i = [0, 17, -7.75], a = [[0, 0.573, -0.819], [0, 0.819, 0.573]];
    t.hard("matte", Ie(vh(gl(9.6, 3.9, 0.9), 0.3, { b: 0.12 }), i, a)), t.hard("amber", Ie(vh(gl(8, 2.6, 0.6), 0.25, { b: 0.1 }).translate(0, 0, 0.2), i, a)), t.hard(v4(16722450, 7), Ie(vh(yh(8, 0.5), 0.1, { b: 0 }).translate(0, 0, 0.46), i, a));
  }
  t.body(jo([[-20.5, 9, 1.2], [20.5, 9, 1.2], [20.5, 21, 1.5], [-20.5, 21, 1.5]], 18, { u: 9, b: 0.8 })), t.body(jo([[-20.5, 18], [20.5, 18], [20.5, 51.5, 7.5], [-20.5, 51.5, 7.5]], 9, { u: 13, b: 0.8, cs: 8, soft: 0.5, holes: [[[-17.5, 22, 4.5], [17.5, 22, 4.5], [17.5, 47, 4.5], [-17.5, 47, 4.5]]] })), t.hard("rubber", jo(gl(37, 27, 5.5, 0, e), 0.4, { u: 12.6, b: 0, holes: [gl(35, 25, 4.5, 0, e)] }));
  for (let i of [-1, 1]) {
    t.hard("steel", wr([[8.5, 10, 1], [26.6, 10, 1], [27.4, 42], [10, 42], [7.5, 24, 3]], 1.1, { x: i * 21.75, b: 0.35, holes: [[[11.8, 18, 2], [24.2, 18, 2], [24.6, 38, 2], [12.4, 38, 2]]] }));
    for (let a of [11.4, 24.6]) t.hard("steel", Ie(Zc([[0, 2.5], [0.72, 2.5]], { seg: 8 }), [i * 20.5, 14, a], wy(i))), t.screw([i * 22.3, 14, a], wy(i), { r: 1.8, h: 0.7, seg: 8 });
  }
  t.hard("steel", jo([[-22.3, 41], [-22.3, 48.4], [-16.2, 54.9], [16.2, 54.9], [22.3, 48.4], [22.3, 41], [21.2, 41], [21.2, 47.95], [15.75, 53.8], [-15.75, 53.8], [-21.2, 47.95], [-21.2, 41]], 17.4, { u: 10, b: 0.35 }));
  let s = { w: 35.8, h: 25.8, rc: 4.9 }, n = { w: 33.6, h: 23.6, rc: 3.8 };
  return t.lens(Hu(n, { y: e, u: 18.5, back: false, bulge: 0.45, kind: 1 }), S5(s, 1.1, { y: e, u0: 18, u1: 18.5, back: false })), t.lens(S5(s, 1.1, { y: e, u0: 17, u1: 16.5, back: true }), Hu(n, { y: e, u: 16.5, back: true, bulge: -0.3, kind: 0 })), { ...t.finish(), bodyMat: o.aluLt, paint: "metal", lensMat: vy("reflex"), eye: [0, e, -107], height: e, zoom: 1, relief: 123.5, window: [33.6, 23.6], bolts: [-20, 20] };
}
function dF() {
  let o = ao(), t = Jc(o.aluLt), e = 38;
  rT(t, 84, { top: 10 }), t.hard("steel", _c(cn([[0, 0], [0, 3.3], [0.5, 3.8, 1], [6.9, 3.8], [7.4, 3.3, 1], [7.4, 0]], { seg: 14 }), "y+", [-18.4, -3.9, -28])), t.hard("steel", oF([[-16.3, -30, 1], [-16.3, 20, 1], [-18.6, 23.5, 1.5], [-22.8, 22, 1.2], [-22.4, 14.5, 2.5], [-19.6, 8, 4], [-19.6, -30, 1]], 6.4, { y: -3.4, b: 0.7 }));
  for (let i = 0; i < 4; i++) t.hard("steel", jo(se(-23.3, -2.6, -22.5, 2.2), 0.8, { u: 15.2 + i * 1.7, b: 0.2 }));
  t.screw([-18.4, 3.5, -28], "T", { r: 1.9, h: 0.4, drive: "slot", look: "bright", roll: 35 }), t.mark(Ie(An("lock", 9.5), [-19.65, -0.2, -8], "L")), t.hard("steel", Ie(w4(7.4, 3), [16.2, 0.2, -28], "R", 10)), t.screw([19.2, 0.2, -28], "R", { r: 1.9, h: 0.5, drive: "slot", look: "bright", roll: 50 }), t.screw([16.2, 0.2, 20], "R", { r: 2.6, h: 1.7, drive: "torx", seg: 12 }), t.body(wr([[-43, 10], [34.5, 10], [34.5, 24], [-18, 24, 2.5], [-43, 18, 2]], 34, { b: 0.8 })), t.body(jo([[-17, 10], [17, 10], [20.2, 13, 0.5], [20.2, 24.6, 1], [-20.2, 24.6, 1], [-20.2, 13, 0.5]], 31, { u: -16.5, b: 0.7 })), t.body(_c(cn([[-18.5, 0], [-18.5, 9.7], [-17.4, 10.8, 1], [18.5, 10.8]], { seg: 24 }), "x+", [0, 19.3, 34.5]));
  {
    let i = [18.8, 19.3, 34.5];
    t.hard("rubber", _c(cn([[-0.3, 10.3], [0.05, 10.3]], { seg: 24 }), "x+", i)), t.hard("alu", _c(cn([[0, 10.5], [0.7, 10.5], [0.9, 11.5, 1, 0.5], [5, 11.5, 0, 0.5], [5.9, 10.6, 1, 0], [5.9, 0]], { flute: { n: 24, wear: true } }), "x+", i)), My(t, [18.8 + 5.92, 19.3, 34.5], "R", 14, 1.7, 20), t.hard("rubber", Mh([[23.6, 30, 34.5], [26.5, 32.5, 31], [26, 31, 24.5], [21, 26.5, 19.5], [17.4, 22.5, 18.2]], 0.5, { seg: 14, radial: 5 })), t.screw([17, 22.3, 18], "R", { r: 1.5, h: 0.6, drive: "hex" }), t.mark(Ie(An("batt123", 10), [-18.55, 19.3, 34.5], "L"));
  }
  for (let i of [-11, 11]) t.screw([i, 24, 19.6], "T", { r: 1.6, h: 0.5, drive: "hex" });
  t.body(jo(gl(37, 28.5, 3.5, 0, 38.25), 26, { u: -14, b: 0.8, cs: 6, soft: 0.5, holes: [gl(31.8, 24, 2.2, 0, e)] })), t.hard("matte", jo(gl(31.8, 24, 2.2, 0, e), 25.2, { u: -13.6, b: 0, holes: [gl(31, 23.2, 1.9, 0, e)] }));
  for (let i of [-1, 1]) {
    t.body(wr([[-16.5, 11.5, 1.2], [14.5, 11.5, 1.2], [14.5, 22, 1], [13.5, 50], [-15.5, 50], [-16.5, 22, 1]], 2.2, { x: i * 21.3, b: 0.6, holes: [[[-10.5, 29, 2.5], [8.5, 29, 2.5], [8.5, 46, 2.5], [-10.5, 46, 2.5]]] }));
    for (let a of [-12.5, 10.5]) t.screw([i * 22.4, 17, a], wy(i), { r: 2.1, h: 0.8 });
  }
  t.body(jo([[20.2, 49.5], [22.4, 49.5], [22.4, 51.6, 0.6], [17.6, 56.8, 0.6], [-17.6, 56.8, 0.6], [-22.4, 51.6, 0.6], [-22.4, 49.5], [-20.2, 49.5], [-20.2, 50.8], [-16.7, 54.6], [16.7, 54.6], [20.2, 50.8]], 29, { u: -15.5, b: 0.5 }));
  for (let i of [-12.2, -4.1, 4.1, 12.2]) t.body(jo([[i - 1.1, 56.5], [i + 1.1, 56.5], [i + 0.8, 57.8], [i - 0.8, 57.8]], 24, { u: -13, b: 0.3 }));
  t.mark(Ie(An("halo", 19), [-22.45, 23.2, -1], "L"), Ie(An("haloSN", 17), [22.45, 23.4, -1], "R")), t.body(wr([[-40.8, 11.6, 1.4], [-17.6, 11.6, 1.4], [-17.6, 22.2, 1.4], [-40.8, 17.4, 1.4]], 1, { x: -17.5, b: 0.4 }));
  for (let [i, a] of [[-35.4, 0], [-27, 180]]) t.hard("rubber", Ie(vh(gl(7, 4.6, 1.4), 1, { b: 0.4 }), [-18, 14.5, i], "L")), t.mark(Ie(An("tri", 2.6), [-19.01, 14.5, i], "L", a));
  t.hard("rubber", Ie(Zc([[0, 2.3], [0.7, 2.3], [1, 1.9, 1], [1, 0]], { seg: 12 }), [-18, 16.4, -20.6], "L")), t.mark(Ie(An("nv", 2.3), [-19.01, 16.4, -20.6], "L"));
  for (let [i, a, r] of [[-35.5, 14.4, 25], [-25, 15.4, 70]]) t.screw([17, a, i], "R", { r: 2.7, h: 0.7, drive: "slot", look: "steel", seg: 12, roll: r }), t.mark(Ie(An("ticks", 8.6), [17, a, i], "R"));
  t.mark(Ie(An("up", 4.4), [17.05, 20.6, -22.5], "R")), t.mark(Ie(An("class", 14.5), [0, 13.9, -43], "B"));
  let s = { w: 31, h: 23.2, rc: 1.9 }, n = { w: 29.2, h: 21.4, rc: 1.2 };
  return t.lens(Hu(n, { y: e, u: 9.3, back: false, kind: 1 }), S5(s, 0.9, { y: e, u0: 8.5, u1: 9.3, back: false })), t.lens(S5(s, 0.9, { y: e, u0: -10.5, u1: -11.3, back: true }), Hu(n, { y: e, u: -11.3, back: true, kind: 0 })), { ...t.finish(), bodyMat: o.aluLt, paint: "metal", lensMat: vy("holo"), eye: [0, e, -121], height: e, zoom: 1, relief: 109.7, window: [29.2, 21.4], bolts: [-28, 20] };
}
function pF(o = true) {
  let t = ao(), e = Jc(t.aluLt), s = 40, n = { y: s }, i = 50, a = 13.5;
  rT(e, 70, { top: 9 });
  for (let l of [-20, 20]) e.hard("steel", Ie(Zc([[0, 5.4], [0.6, 5.4], [0.6, 0]], { seg: 14 }), [16.2, 0, l], "R")), e.hard("steel", Ie(w4(8.6, 3.6).translate(0, 0, 0.6), [16.2, 0, l], "R", 15 + l)), My(e, [16.2 + 4.22, 0, l], "R", 8.2, 1.3, 15 + l), e.stripe([16.2 + 4.24, 0, l], "R", 5.2, 105 + l, "whiteLine"), e.screw([-16, 0.6, l], "L", { r: 2.3, h: 0.5, drive: "none" });
  e.body(wr([[-33, 9], [33, 9], [29, 20.6, 2], [-29, 20.6, 2]], 22, { b: 0.8, holes: [se(-18, 12.2, 18, 16.8, 2.2)] })), e.body(jo([[-13, 20], [13, 20], [20, 27, 1], [20, 53, 1], [13, 60, 1], [-13, 60, 1], [-20, 53, 1], [-20, 27, 1]], 44, { u: -26, b: 1 }));
  for (let l of [-1, 1]) for (let c of [-1, 1]) e.screw([l * 15.2, s + c * 15.2, -26], "B", { r: 1.5, h: 0.5, drive: "hex" }), e.screw([l * 15.2, s + c * 15.2, 18], "F", { r: 1.5, h: 0.5, drive: "hex" });
  e.body(cn([[-36.4, 16.6], [-36, 17.6, 1], [-29.5, 17.6], [-28.5, 18.9, 1], [-26, 18.9]], { seg: 28, ...n })), e.hard("alu", cn([[-47.1, 17.6], [-46.7, 18.6, 1], [-46.2, 19.5, 0, 1], [-37.6, 19.5, 0, 1], [-37.1, 18.6, 0, 0], [-36.7, 17.6, 1]], { flute: { n: 14, trap: true, wear: true }, ...n })), e.hard("rubber", cn([[-53.4, 15.6], [-54.4, 16.5], [-54.6, 18.4], [-53.8, 19.5], [-48.4, 19.7], [-47.5, 18.9], [-47.2, 17.7]], { seg: 40, crease: 50, ...n })), e.hard("matte", cn([[-46, a], [-46.6, a + 0.9], [-49.5, 14.6], [-49.5, 15.1], [-53.4, 15.6]], { seg: 40, ...n })), e.mark(Ie(An("whiteDot", 1.3), [0, s + 17.62, -33], "T"), M4("focus", 17.65, 9, { phi: 128, u: -32.6, y: s })), e.body(cn([[18, 17.4], [23, 17.4], [30.5, 19.7], [50.6, 19.7], [51, 20.1, 1], [53.2, 20.1], [54, 19.3, 1], [54, 17.7]], { seg: 28, ...n })), e.hard("matte", y4(cn([[54, 17.7], [50.2, 17.7], [50.2, 16.7], [47.4, 16.7], [47.4, 15.7], [44.6, 15.7], [44.6, 14.7], [44, 14.7]], { seg: 28, ...n }), 150, 3, n)), e.mark(M4("vantage", 19.72, 19, { phi: 150, u: 40.4, y: s }), Ie(An("vantSN", 13), [-11.05, 18.7, 0], "L"));
  for (let [l, c, h, f, u] of [[[0, 60, -2], "y+", "T", [0, 60, 12.5], "up"], [[20, s, -2], "x+", "R", [20, s, 12.5], "rt"]]) {
    e.body(_c(cn([[0, 9.8], [2, 9.8], [2.6, 9.2, 1], [2.6, 8]], { seg: 20 }), c, l)), e.hard("alu", _c(cn([[2.7, 8.3], [3.2, 8.3], [3.5, 9, 1, 0.75], [9.6, 9, 0, 0.75], [10.4, 8, 1, 0], [10.4, 0]], { flute: { n: 16, wear: true } }), c, l));
    let d = c === "y+" ? [0, 70.4, -2] : [30.4, s, -2];
    e.mark(Ie(An("ticks", 13), d, h), Ie(An(u, 5), c === "y+" ? [0, 60, 13] : [20, s, 13], h)), My(e, c === "y+" ? [0, 70.42, -2] : [30.42, s, -2], h, 5.4, 0.9, 0);
  }
  {
    let l = [-20, s, -2];
    e.body(_c(cn([[0, 11.2], [1.4, 11.2], [1.9, 10.6, 1], [1.9, 9]], { seg: 22 }), "x-", l)), e.hard("alu", _c(cn([[2, 10], [2.4, 10], [2.7, 10.9, 1, 0.6], [7.8, 10.9, 0, 0.6], [8.6, 10, 1, 0], [8.6, 6.2], [9.2, 5.8, 1], [9.2, 0]], { flute: { n: 20, wear: true } }), "x-", l)), e.mark(Ie(An("dial", 19.4), [-28.6, s, -2], "L")), My(e, [-29.22, s, -2], "L", 8, 1.1, 30);
  }
  e.lens(Hu({ r: a, n: 40 }, { y: s, u: -46, back: true, kind: 0, bulge: 0.5 })), e.lens(Hu({ r: 14.7 }, { y: s, u: 44, back: false, kind: 3, bulge: 1.4 }));
  let r = vy("prism", { portal: o, center: [0, s / 1e3, 0.046], relief: (i + 10) / 1e3, pupil: 0.0115, field: 0.93 * a / i, objective: { r: 0.0147 } });
  return { ...e.finish(), bodyMat: t.aluLt, paint: "metal", lensMat: r, eye: [0, s, -46 - i], height: s, zoom: 2.5, relief: i, window: [a * 2, a * 2], bolts: [-20, 20], portal: o };
}
function mF() {
  let o = ao(), t = Jc(o.aluLt), e = 17.3;
  t.hard("steel", wr([[-23.5, 0], [23.5, 0], [23.5, 1.5, 0.5], [22.9, 2.2], [-22.9, 2.2], [-23.5, 1.5, 0.5]], 27.2, { b: 0.4 })), t.body(wr([[-23, 2.2], [23, 2.2], [23, 5, 0.8], [21, 7.5, 0.8], [-6, 7.5, 0.8], [-9, 10.6, 1], [-20, 10.6, 1.5], [-23, 8, 1]], 26, { b: 0.6 })), t.body(jo([[-14, 4.6, 1], [14, 4.6, 1], [14, 24.5, 2.5], [9, 28, 2], [-9, 28, 2], [-14, 24.5, 2.5]], 10.5, { u: 9, b: 0.6, cs: 6, soft: 0.5, holes: [gl(22.4, 15, 2.6, 0, e)] }));
  for (let s of [-1, 1]) t.body(wr([[9.2, 7.5], [9.2, 21.5, 1.5], [-3.5, 7.5, 1]], 2.6, { x: s * 12.7, b: 0.6 })), t.screw([s * 7.4, 7.5, 2.6], "T", { r: 2.3, h: 0.5, drive: "torx", seg: 12 }), t.hard("rubber", Ie(vh(gl(6, 3.4, 1.2), 0.8, { b: 0.3, bs: 2 }), [s * 13, 6.3, -15], wy(s))), t.mark(Ie(An(s < 0 ? "plus" : "minus", 2.1), [s * 13.81, 6.3, -15], wy(s)));
  t.screw([0, 10.6, -14.5], "T", { r: 2.1, h: 0.35, drive: "slot", look: "steel", seg: 12, roll: 60 }), t.mark(Ie(An("ticks", 7.6), [0, 10.6, -14.5], "T")), t.screw([13, 5, 3], "R", { r: 1.5, h: 0.4, drive: "slot", look: "steel", roll: 15 }), t.mark(Ie(An("micro", 9.6), [-14.05, 8.4, 14.25], "L"));
  for (let s of [-7, 7]) t.body(jo(se(s - 2.2, 3.4, s + 2.2, 9.2), 0.9, { u: -23.5, b: 0.3 }));
  {
    let s = [0, 9.05, -7.5], n = [[0, 0.696, -0.719], [0, 0.719, 0.696]];
    t.hard("amber", Ie(vh(gl(7, 2.2, 0.5), 0.25, { b: 0.1 }), s, n)), t.hard(v4(16722450, 7), Ie(vh(yh(8, 0.4), 0.1, { b: 0 }).translate(0, 0, 0.27), s, n));
  }
  return t.lens(Hu({ w: 20.6, h: 13.2, rc: 1.8 }, { y: e, u: 15.6, back: false, bulge: 0.3, kind: 1 }), S5({ w: 22.9, h: 15.5, rc: 2.9 }, 1.15, { y: e, u0: 15, u1: 15.6, back: false })), t.lens(S5({ w: 22.9, h: 15.5, rc: 2.9 }, 1.15, { y: e, u0: 13.8, u1: 13.2, back: true }), Hu({ w: 20.6, h: 13.2, rc: 1.8 }, { y: e, u: 13.2, back: true, bulge: -0.2, kind: 0 })), { ...t.finish(), bodyMat: o.aluLt, paint: "metal", lensMat: vy("microdot"), eye: [0, e, -265], height: e, zoom: 1, relief: 278, window: [20.6, 13.2], bolts: [] };
}
var E4 = { rifle: { bore: 3.3, rear: 10.6, lab: "cal556", supp: [19.5, 168], comp: 56, brake: 60, choke: 40 }, pistol: { bore: 5, rear: 9.6, lab: "cal9", supp: [17.5, 150], comp: 46, brake: 52, choke: 36 }, shotgun: { bore: 9.4, rear: 13, lab: "cal12", supp: [23.5, 190], comp: 62, brake: 68, choke: 43 } }, aA = (o, t) => o.hard("bright", cn([[0, t.rear - 1.3], [0.35, t.rear - 0.5, 1], [1.7, t.rear - 0.5], [2.05, t.rear - 1.3, 1]], { seg: 20 })), lT = (o, t, e) => o.hard("black", Qc(0.01, t, e, 1, { seg: 12 }));
function WQ(o, t, e, s, n, i = 0) {
  let a = new THREE.PlaneGeometry(s, n);
  a.translate(0, 0, 0.03), o.hard("black", Ie(Qe(a), t, e, i));
}
function gF(o) {
  let t = E4[o], e = ao(), s = Jc(e.steel), [n, i] = t.supp, a = t.rear;
  aA(s, t), s.hard("steel", jo(yh(8, (a + 2.4) / Math.cos(Math.PI / 8), Math.PI / 8), 8.8, { u: 2.2, b: 0.6 })), s.hard("steel", cn([[11.2, a + 2.6], [11.6, a + 4.4, 1], [12, a + 5.4, 0, 1.2], [18.4, a + 5.4, 0, 1.2], [18.9, a + 4.4, 0, 0], [19.4, a + 3, 1]], { flute: { n: 11, trap: true, wear: true } }));
  let r = 42, l = i - 46, c = n * 0.925, h = Math.acos(0.925) / Hs;
  s.body(cn([[19.2, a + 3.2], [20.4, a + 4.4], [28.6, n - 0.8], [30, n, 1], [34, n], [34.4, n - 0.7, 1], [35.4, n - 0.7], [35.8, n, 1], [38, n], [38.4, n - 0.7, 1], [39.4, n - 0.7], [39.8, n, 1], [r, n]], { seg: 24 }));
  let f = [];
  for (let v = 0; v < 6; v++) {
    let y = 90 + v * 60;
    for (let M of [y - h, y + h, y + 30]) f.push([Math.cos(M * Hs) * n, Math.sin(M * Hs) * n]);
  }
  s.body(jo(f, l - r, { u: r, b: 0.5 })), s.body(Qc(c - 1.5, n, r, 1, { seg: 24 }), Qc(c - 1.5, n, l, -1, { seg: 24 }));
  let u = cn([[l, n], [l + 6, n], [l + 6.4, n - 0.6, 1], [l + 7.6, n - 0.6], [l + 8, n, 1], [l + 13, n], [l + 13.4, n - 0.6, 1], [l + 14.6, n - 0.6], [l + 15, n, 1], [l + 20, n], [l + 20.4, n - 0.6, 1], [l + 21.6, n - 0.6], [l + 22, n, 1], [i - 13.6, n], [i - 13, n - 0.5, 1], [i - 13, n - 1.6]], { seg: 24 });
  s.body(u);
  let d = (v) => v <= 0 ? null : v < 0.4 ? [1 + 0.05 * (v / 0.4), 1 - 0.2 * (v / 0.4), 1 - 0.5 * (v / 0.4)] : v < 0.75 ? [1.05 - 0.35 * ((v - 0.4) / 0.35), 0.8 - 0.1 * ((v - 0.4) / 0.35), 0.5 + 0.5 * ((v - 0.4) / 0.35)] : [0.7 - 0.2 * ((v - 0.75) / 0.25), 0.7 + 0.1 * ((v - 0.75) / 0.25), 1 + 0.5 * ((v - 0.75) / 0.25)];
  nA(u, (v, y, M) => d((-M - (i - 44)) / 30));
  let m = cn([[i - 12.7, n - 0.5], [i - 1.2, n - 0.5], [i, n - 1.7, 1], [i, n - 5.2], [i - 0.5, n - 5.8, 1], [i - 2.4, n - 5.8], [i - 2.4, t.bore + 5.2], [i - 0.6, t.bore + 4.4, 1], [i - 0.6, t.bore + 1.1], [i - 1.7, t.bore, 1], [i - 17, t.bore]], { seg: 36 });
  s.hard("ti", m), nA(m, (v, y, M) => {
    let w = Math.hypot(v, y), T = (w - t.bore) / (n - t.bore), S = -M;
    return S < i - 3 ? [0.86 - 0.3 * Math.max(0, (S - (i - 12)) / 9), 0.72, 0.62 + 0.5 * Math.max(0, (S - (i - 12)) / 9)] : T < 0.3 ? [0.32, 0.42, 0.95] : T < 0.55 ? [0.62, 0.36, 0.78] : T < 0.8 ? [0.98, 0.66, 0.34] : [0.95, 0.86, 0.7];
  }), lT(s, t.bore, i - 16.5);
  for (let v = 0; v < 4; v++) {
    let y = (45 + v * 90) * Hs, M = (n - 5.8 + t.bore + 5.2) / 2;
    WQ(s, [Math.cos(y) * M, Math.sin(y) * M, i - 2.38], "F", 3.2, 2, -(45 + v * 90));
  }
  let p = (r + l) / 2, x = (v, y) => [[Math.cos(v * Hs), Math.sin(v * Hs), 0], y ? [-Math.sin(v * Hs), Math.cos(v * Hs), 0] : [Math.sin(v * Hs), -Math.cos(v * Hs), 0]], g = (v, y) => [Math.cos(v * Hs) * c, Math.sin(v * Hs) * c, y], b = n / 19.5;
  return s.mark(Ie(An("mono", 46 * b), g(150, p), x(150, false))), s.mark(Ie(An(t.lab, 21 * b), g(90, p + 18 * b), x(90, false)), Ie(An("suppSN", 30 * b), g(90, p - 12 * b), x(90, false))), s.mark(Ie(An("suppWarn", 44 * b), g(30, p), x(30, true))), { ...s.finish(), bodyMat: e.steel, paint: "metal", length: i, radius: n, rear: a + 5.4 };
}
function xF(o) {
  let t = E4[o], e = ao(), s = Jc(e.steel), n = t.comp, i = t.rear + 0.6, a = t.bore + 2.2, r = t.bore + 0.3, l = i + 0.9;
  aA(s, t), s.hard("steel", cn([[2.3, l - 1.4], [3.1, l, 1], [8.7, l], [9.5, l - 1.4, 1], [9.5, i - 2.2]], { seg: 6, flat: true })), s.body(cn([[9.7, i - 2.2], [10.2, i - 1.3, 1], [11, i - 1.3], [11.3, i - 1.9, 1], [11.9, i - 1.9], [12.2, i - 1.3, 1], [12.5, i - 1.3], [13, i, 1]], { seg: 24 }));
  let c = 13, h = n - 4, f = h - c, u = [], d = [0.17, 0.42, 0.67].map((x) => c + f * x), m = Math.max(4, f * 0.115);
  for (let x of d) u.push({ a0: 52, a1: 128, u0: x - m / 2, u1: x + m / 2 });
  for (let x of [-25, 155]) u.push({ a0: x, a1: x + 50, u0: c + f * 0.79, u1: c + f * 0.95 });
  let p = iT({ r: i, ri: a, u0: c, u1: h, ports: u, step: 18, ch: 0.4 });
  s.body(p.outer), s.hard("soot", p.inner);
  for (let x of [0.295, 0.545, 0.74]) {
    let g = c + f * x;
    s.hard("soot", Qc(r, a, g - 0.9, -1, { seg: 16 }), Qc(r, a, g + 0.9, 1, { seg: 16 }));
  }
  return s.hard("soot", Qc(r, a, c + 0.4, 1, { seg: 16 })), s.body(cn([[h, i], [n - 3.2, i], [n - 0.9, i - 1.5, 1], [n, i - 2.3, 1], [n, r + 2.6], [n - 0.7, r + 1.9, 1], [n - 0.7, r + 1.1], [n - 1.6, r, 1]], { seg: 24 })), s.hard("soot", cn([[n - 1.6, r], [h - 0.2, r], [h - 0.2, a]], { seg: 16 })), lT(s, r, c + 0.5), s.mark(M4("comp", i, 9, { phi: 180, u: c + f * 0.3 })), { ...s.finish(), bodyMat: e.steel, paint: "metal", length: n, radius: i, rear: l };
}
function bF(o) {
  let t = E4[o], e = ao(), s = Jc(e.steel), n = t.brake, i = t.rear + 2, a = i * 0.82, r = t.bore + 3.6, l = t.bore + 0.3;
  aA(s, t), s.body(jo(yh(8, (i - 1) / Math.cos(Math.PI / 8), Math.PI / 8), 10.4, { u: 2.3, b: 0.7 })), s.body(cn([[12.6, i - 2.6], [14.2, i - 2.6]], { seg: 20 }));
  let c = 14.2, h = n, f = h - c, u = [], d = 3, m = f * 0.085, p = (f - m * (d + 1)) / d, x = Math.asin(a / i) / Hs, g = (y) => {
    let M = Math.abs(Math.sin(y * Hs));
    return M * i > a ? a / M : i;
  }, b = [];
  for (let y = 0; y < d; y++) {
    let M = c + m + y * (p + m), w = M + p;
    b.push([M, w]);
    for (let T of [-40, 140]) u.push({ a0: T, a1: T + 80, u0: M, u1: w });
  }
  for (let y of [1, 2]) {
    let M = (b[y][0] + b[y][1]) / 2;
    u.push({ a0: 77, a1: 103, u0: M - p * 0.24, u1: M + p * 0.24 });
  }
  let v = iT({ r: i, ri: r, u0: c, u1: h, ports: u, step: 20, ch: 0.45, rFn: g, breaks: [x, 180 - x, 180 + x, -x], capRear: true, capFront: true });
  s.body(v.outer), s.hard("soot", v.inner);
  for (let y = 0; y < d; y++) s.hard("soot", Qc(l, r, b[y][0], 1, { seg: 16 }), Qc(l, r, b[y][1], -1, { seg: 16 }));
  return s.hard("steel", cn([[h, r + 0.02], [h - 1.3, l + 0.9, 1], [h - 2.6, l]], { seg: 16 })), lT(s, l, c + 1), s.mark(Ie(An("brake", 8.5), [0, a, (b[0][0] + b[0][1]) / 2], "T", -90)), { ...s.finish(), bodyMat: e.steel, paint: "metal", length: n, radius: i, rear: i };
}
function yF(o) {
  let t = E4[o], e = ao(), s = Jc(e.steel), n = t.choke, i = t.rear, a = i + 0.3, r = t.bore + 0.5;
  s.body(cn([[0, i - 1.2], [0, i - 0.4], [2.6, i - 0.4], [3, i + 0.3, 1]], { seg: 28 }));
  let l = cn([[3, i + 0.2], [3.5, i + 1, 1], [12.3, i + 1], [12.8, i + 0.2, 1]], { seg: 32 });
  s.hard("steel", y4(l, Math.round(Pn * (i + 1) / 1.15), 1)), s.hard("brass", cn([[12.9, i - 0.3], [13.2, i + 0.25, 1], [14.6, i + 0.25], [14.9, i - 0.3, 1]], { seg: 28 })), s.body(cn([[15, i - 0.3], [15.4, a, 1], [23, a]], { seg: 28 }));
  let c = [], h = n - 23;
  for (let u = 0; u < 10; u++) c.push({ a0: -81 + u * 36 - 6.5, a1: -81 + u * 36 + 6.5, u0: 23 + h * 0.1, u1: 23 + h * 0.4 }), c.push({ a0: -63 + u * 36 - 6.5, a1: -63 + u * 36 + 6.5, u0: 23 + h * 0.52, u1: 23 + h * 0.82 });
  for (let u of [-45, 45, 135, 225]) c.push({ a0: u - 7, a1: u + 7, u0: n - 2.4, u1: n + 1 });
  let f = iT({ r: a, ri: r, u0: 23, u1: n, ports: c, step: 36, ch: 0.3, capFront: true });
  return s.body(f.outer), s.hard("steel", f.inner), s.hard("bright", cn([[23, r], [0, r - 0.3]], { seg: 20 })), lT(s, r - 0.3, 0.2), s.mark(M4("choke", a, 34, { phi: 120, u: 19, along: false })), { ...s.finish(), bodyMat: e.steel, paint: "metal", length: n, radius: i + 1, rear: i + 1 };
}
var rA = (o) => o > 0 ? "R" : "L";
function cT(o, t, e, s, n, i, a = 0) {
  let r = new THREE.PlaneGeometry(n, i);
  r.translate(0, 0, 0.03), o.hard(t, Ie(Qe(r), e, s, a));
}
function vF(o, t, e, s = {}) {
  let n = t === "rail" ? 0 : -7.5;
  if (t !== "rail") {
    let i = lF(-30, 30, -7.5, 1);
    s.look ? o.hard(s.look, i) : o.body(i);
    for (let a of [-25, 25]) o.screw([0, -7.5, a], "D", { r: 2.2, h: 0.3, drive: "hex", seg: 8 });
  }
  return cF(o, e, n, s), n;
}
function MF(o, t, e, s, n = { n: 10, wear: true }) {
  o.hard("steel", _c(cn([[0, 3.4], [0.9, 3.4], [1.1, 7.2, 1, 0.9], [5, 7.2, 0, 0.9], [5.8, 6.3, 1, 0], [5.8, 0]], { flute: n }), s < 0 ? "x-" : "x+", [s * 16.1, t - 0.4, e])), cT(o, "black", [s * 21.9, t - 0.4, e], rA(s), 9.6, 1.5, 25), o.hard("steel", Ie(w4(7.6, 2.6), [-s * 16.1, t - 0.4, e], rA(-s), 12));
}
function qQ(o, t) {
  let e = 0;
  for (; e < o.length - 2 && t > o[e + 1][0]; ) e++;
  let s = o[Math.max(0, e - 1)], n = o[e], i = o[e + 1], a = o[Math.min(o.length - 1, e + 2)], r = Math.min(1, Math.max(0, (t - n[0]) / (i[0] - n[0])));
  return n.map((l, c) => {
    if (c === 0) return t;
    let h = (i[c] - s[c]) / (i[0] - s[0]) * (i[0] - n[0]), f = (a[c] - n[c]) / (a[0] - n[0]) * (i[0] - n[0]), u = r * r, d = u * r;
    return (2 * d - 3 * u + 1) * n[c] + (d - 2 * u + r) * h + (-2 * d + 3 * u) * i[c] + (d - u) * f;
  });
}
function wF(o = "mlok") {
  let t = ao(), e = Jc(t.grip), s = vF(e, o, 44, { look: "poly" });
  MF(e, s, 0, -1, { n: 8, trap: true, wear: true });
  let n = [[9, 14.6, 21.6, 5], [12.5, 13.9, 19.2, 3.6], [17.5, 13, 16.8, 2.8], [30, 14, 17.7, 2.6], [50, 15.4, 19.4, 2.5], [68, 14.7, 18.5, 2.5], [79, 15.5, 19.5, 2.6], [84, 16, 20, 2.8], [86.4, 15.3, 19.3, 2.8]], i = [9, 10.6, 12.5, 15, 17.5, 21];
  for (let u = 0; u <= 20; u++) i.push(24 + u * 2.1);
  i.push(69, 73, 77, 80.5, 83.2, 84.8, 86.4);
  let a = 22, r = (u) => -(u - 9) * 0.035, l = [];
  i.forEach((u) => {
    let [, d, m, p] = qQ(n, u), x = u >= 24 && u <= 66 ? Math.round((u - 24) / 2.1) % 2 * 0.95 : 0, g = [];
    for (let b = 0; b < a; b++) {
      let v = b / a * Pn, y = Math.cos(v), M = Math.sin(v), w = 2 / p, T = d * Math.sign(y) * Math.pow(Math.abs(y), w) * (1 - 0.07 * Math.max(0, -M)), S = m * Math.sign(M) * Math.pow(Math.abs(M), w), E = Math.min(1, Math.max(0, (Math.abs(M) - 0.5) / 0.35)), _ = 1 - x * E * E * (3 - 2 * E) / Math.hypot(T, S);
      g.push([T * _, s - u, S * _ + r(u)]);
    }
    l.push(g);
  }), e.body(iF(l, { capB: true }));
  let c = r(86.4), h = [0, s - 86.3, -c];
  e.hard("rubber", _c(cn([[-0.6, 13.7], [0.1, 13.7]], { seg: 22 }), "y-", h)), e.hard("poly", _c(cn([[0, 13.2], [0.7, 13.2], [0.9, 14.3, 1, 0.55], [4.8, 14.3, 0, 0.55], [5.6, 13.5, 1, 0], [5.6, 0]], { flute: { n: 18, wear: true } }), "y-", h)), cT(e, "black", [0, s - 86.3 - 5.6, -c], "D", 15, 2.2);
  for (let u of [-1, 1]) e.screw([u * 15.05, s - 75.5, -r(75.5)], rA(u), { r: 1.5, h: 0.25, drive: "none", look: "steel", seg: 8 });
  e.mark(Ie(An("vfg", 13), [-15.42, s - 45, -r(45)], "L"));
  let f = ds(Zn([0, (s - 49) / 1e3, r(49) / 1e3], [0.0154, 0.0405, 0.0194], 0.0148), Zn([0, (s - 2) / 1e3, 0], [0.0162, 75e-4, 0.022], 1e-3));
  return f.hold = { at: [-0.0154, (s - 46) / 1e3, r(46) / 1e3], fingers: [0, 0.12, -1], palm: [1, 0, 0] }, { ...e.finish(), bodyMat: t.grip, paint: "furniture", grip: f, drop: 92 - s, yR: s };
}
function EF(o = "mlok") {
  let t = ao(), e = Jc(t.poly), s = o === "rail" ? 0 : -7.5;
  o !== "rail" && e.body(wr(se(-61, -7.5, 61, 0, 1.2), 20.6, { b: 0.6 }));
  let n = (c) => c.map(([h, f, u]) => [h, s + f, u]), i = [[-62, -0.3, 2], [62, -0.3, 2], [62, -10, 3], [57, -19, 5], [49, -19.5, 4], [43, -13.5, 6], [30, -16, 10], [-30, -44, 12], [-42, -47, 7], [-55, -40, 8], [-62, -16, 6]], a = [[14, -4.5, 1.5], [58, -4.5, 2], [60, -9, 2], [22, -11.5, 2]];
  e.body(wr(n(i), 31, { b: 2.6, bs: 3, soft: true, holes: [n([[-46, -9, 3.5], [-8, -9, 3.5], [-41, -30, 3.5]])] })), e.body(wr(n(a), 41, { b: 2.2, bs: 2, soft: true }));
  for (let c of [-1, 1]) {
    e.body(jo([[c * 10.4, s - 4], [c * 10.4, s + 5.2], [c * 12.4, s + 5.2, 0.5], [c * 15.5, s + 2.4, 0.8], [c * 15.5, s - 4]], 112, { u: -56, b: 0.5 }));
    for (let h = 0; h < 5; h++) e.body(wr(se(24 + h * 6.5, s - 4.7, 25.5 + h * 6.5, s - 3.95), 4, { x: c * 18.1, b: 0.25 }));
  }
  for (let c of [-22, 38]) e.screw([15.5, s - 0.9, c], "R", { r: 2.4, h: 1.1, drive: "torx", seg: 12 }), e.hard("steel", Ie(w4(5.6, 1.5), [-15.5, s - 0.9, c], "L", 8));
  for (let c = 0; c < 9; c++) {
    let h = 9 + c * 6;
    e.body(b4(wr(se(-0.9, -0.2, 0.9, 0.8), 21, { b: 0.3 }), [0, s - 16 - 0.423 * h, 30 - 0.906 * h], [205, 0, 0]));
  }
  e.mark(Ie(An("afg", 13), [-15.56, s - 20, 6], "L"));
  let r = (c) => c.map(([h, f]) => [h / 1e3, (s + f) / 1e3]), l = ds(Zs(r(i), 0.031, { r: 26e-4 }), Zs(r(a), 0.041, { r: 22e-4 }));
  return l.hold = { at: [0, (s - 30) / 1e3, 0], fingers: [1, 0, 0], palm: [0, 0.906, 0.423] }, { ...e.finish(), bodyMat: t.poly, paint: "polymer", grip: l, drop: 47 - s, yR: s };
}
function TF(o = "mlok") {
  let t = ao(), e = Jc(t.aluLt), s = vF(e, o, 44, { depth: 6 }), n = (c) => s + c;
  MF(e, s, 0, 1);
  let i = (c, h) => [[-18 + c, n(-5 - c), h && 1.5], [18 - c, n(-5 - c), h && 1.5], [18 - c, n(-26), h], [14.5 - c * 0.6, n(-31 + c), h], [-14.5 + c * 0.6, n(-31 + c), h], [-18 + c, n(-26), h]];
  e.body(jo(i(0, 1), 58, { u: -29, b: 0.8 }));
  let a = [-9, n(-12.5)], r = [-9, n(-23.5)], l = [7, n(-18)];
  e.hard("alu", jo(i(1, 0), 2.6, { u: 29, b: 0.4, holes: [yh(10, 3.5, 0, a[0], a[1]), yh(10, 3.5, 0, r[0], r[1]), yh(14, 7.3, 0, l[0], l[1])] })), e.hard("redGlass", Qc(0.01, 3.7, 29.9, 1, { x: a[0], y: a[1], seg: 10 })), e.hard(v4(16720916, 6), Qc(0.01, 0.9, 30.05, 1, { x: a[0], y: a[1], seg: 8 })), e.hard("glass", Qc(0.01, 3.7, 29.9, 1, { x: r[0], y: r[1], seg: 10 })), e.hard("bright", cn([[30.8, 7.4], [25.6, 2.3], [25.6, 0]], { seg: 14, x: l[0], y: l[1] })), e.hard(v4(16767108, 0.9), Qc(0.01, 1.3, 25.9, 1, { x: l[0], y: l[1], seg: 4 }));
  for (let [c, h, f] of [[a, 3.5, 10], [r, 3.5, 10]]) e.hard("steel", cn([[31.6, h + 1.3], [32.5, h + 1.3], [32.9, h + 0.9, 1], [32.9, h + 0.1], [31.6, h + 0.1]], { seg: f, x: c[0], y: c[1] }));
  e.hard("steel", y4(cn([[31.6, 9], [33.2, 9], [33.7, 8.5, 1], [33.7, 7.4], [31.6, 7.4]], { seg: 16, x: l[0], y: l[1] }), 36, 2, { x: l[0], y: l[1] })), e.hard("alu", jo(i(1, 0), 2, { u: -31, b: 0.4 }));
  {
    let c = [7.5, n(-17.5), -31];
    e.hard("steel", Ie(Zc([[0, 6.3], [0.8, 6.3], [1, 5.8, 1, 0.5], [4.2, 5.8, 0, 0.5], [4.8, 5.1, 1, 0], [4.8, 0]], { flute: { n: 9, wear: true } }), c, "B")), cT(e, "white", [7.5, n(-17.5) + 2.5, -35.8], "B", 0.9, 4.4), e.mark(Ie(An("modes", 20.5), c, "B"));
  }
  {
    let c = [-10.5, n(-23), -31];
    e.hard("steel", Ie(Zc([[0, 3.1], [1.2, 3.1], [1.5, 2.8, 1], [1.5, 1.7]], { seg: 10 }), c, "B")), e.hard("rubber", Ie(Zc([[1, 2.3], [5.5, 2.3], [6.8, 1.5]], { seg: 8 }), c, "B")), e.mark(Ie(An("remote", 8.5), [-10.5, n(-17.4), -31], "B"));
  }
  for (let c of [-1, 1]) e.screw([c * 14.6, n(-8.6), -31], "B", { r: 1.3, h: 0.4, drive: "hex", seg: 8 });
  e.hard("rubber", Ie(aF(vh(gl(26, 6.2, 2), 2.4, { b: 0.8 }), 1.7, 2), [-16, n(-1.4), 2], "L")), e.hard("rubber", Mh([[-18, n(-1.4), -11.3], [-18.9, n(-3.6), -19], [-19.7, n(-10), -28.6], [-18, n(-19), -37], [-13.2, n(-22.8), -39.6], [-10.5, n(-23), -37.6]], 1.2, { seg: 14, radial: 5 })), e.hard("poly", jo(se(-21.5, n(-12.2), -17.8, n(-7.6)), 3.2, { u: -30.2, b: 0.6 }));
  {
    let c = [-18, n(-15.5), -12];
    e.hard("steel", Ie(Zc([[0, 6.7], [0.8, 6.7], [1.1, 6.3, 1], [1.1, 5.5]], { seg: 14 }), c, "L")), e.hard("rubber", Ie(Zc([[0.2, 5.3], [1.5, 5.3], [2.3, 4.2], [2.5, 0]], { seg: 12, crease: 50 }), c, "L")), e.mark(Ie(An("fire", 6), [-18.05, n(-24.3), -12], "L"));
  }
  for (let [c, h] of [[-11, "el"], [-21.5, "wd"]]) e.screw([-18.2, n(c), 15], "L", { r: 2.5, h: 0.7, drive: "hex", look: "brass", seg: 10 }), e.mark(Ie(An(h, 5.6), [-18.05, n(c), 23], "L"));
  e.mark(Ie(An("tl1", 11.5), [-18.05, n(-8.3), 2.5], "L"));
  {
    let c = [18, n(-16), 13];
    e.hard("alu", Ie(Zc([[0, 6.6], [0.5, 6.6], [0.7, 7.2, 1, 0.45], [2.6, 7.2, 0, 0.45], [3.2, 6.5, 1, 0], [3.2, 0]], { flute: { n: 11, wear: true } }), c, "R")), cT(e, "black", [21.2, n(-16), 13], "R", 9, 1.3, 35);
  }
  return e.mark(Ie(An("warnY", 17), [18.05, n(-15.5), -12], "R")), { ...e.finish(), bodyMat: t.aluLt, paint: "metal", laser: [a[0], a[1], 33], drop: 31 - s, yR: s };
}
var Oo = Math.PI * 2, t1 = (o) => o < 0 ? 0 : o > 1 ? 1 : o, Wl = (o, t, e) => o + (t - o) * e, $o = (o, t, e) => {
  let s = (e - o) / (t - o);
  return s = s < 0 ? 0 : s > 1 ? 1 : s, s * s * (3 - 2 * s);
};
function wh(o = 1) {
  let t = o >>> 0, e = () => {
    t = t + 1831565813 >>> 0;
    let s = t;
    return s = Math.imul(s ^ s >>> 15, s | 1), s ^= s + Math.imul(s ^ s >>> 7, s | 61), ((s ^ s >>> 14) >>> 0) / 4294967296;
  };
  return e.range = (s, n) => s + (n - s) * e(), e.int = (s, n) => Math.floor(s + (n - s + 1) * e()), e.pick = (s) => s[Math.floor(e() * s.length)], e.sign = () => e() < 0.5 ? -1 : 1, e;
}
function ql(o, t, e) {
  e = e || new Float32Array(o * o);
  let s = Math.imul(t | 0, 2654435761) ^ 2654435769 | 0;
  s || (s = 1);
  for (let n = 0; n < e.length; n++) s ^= s << 13, s ^= s >>> 17, s ^= s << 5, e[n] = (s >>> 8) / 16777216;
  return e;
}
function T4(o, t, e, s, n, i = 1) {
  let a = wh(n), r = e * s, l = new Float32Array(r), c = new Float32Array(r);
  for (let x = 0; x < r; x++) {
    let g = a() * Oo;
    l[x] = Math.cos(g), c[x] = Math.sin(g);
  }
  let h = new Int32Array(t), f = new Int32Array(t), u = new Float32Array(t), d = new Float32Array(t);
  for (let x = 0; x < t; x++) {
    let g = x * e / t, b = Math.floor(g), v = g - b;
    h[x] = b % e, f[x] = (b + 1) % e, u[x] = v, d[x] = v * v * v * (v * (v * 6 - 15) + 10);
  }
  let m = i * 1.5, p = 0;
  for (let x = 0; x < t; x++) {
    let g = x * s / t, b = Math.floor(g), v = g - b, y = v * v * v * (v * (v * 6 - 15) + 10), M = v - 1, w = b % s * e, T = (b + 1) % s * e;
    for (let S = 0; S < t; S++) {
      let E = w + h[S], _ = w + f[S], R = T + h[S], C = T + f[S], L = u[S], A = L - 1, O = d[S], H = l[E] * L + c[E] * v, F = l[_] * A + c[_] * v, P = l[R] * L + c[R] * M, z = l[C] * A + c[C] * M, k = H + (F - H) * O, I = P + (z - P) * O;
      o[p++] += m * (k + (I - k) * y);
    }
  }
  return o;
}
function uf(o, t, e, s, n, i = 0.5) {
  let a = new Float32Array(o * o), r = 1, l = 0;
  for (let h = 0; h < s && !(t > o / 2 || e > o / 2); h++) T4(a, o, t, e, n + h * 131, r), l += r, r *= i, t *= 2, e *= 2;
  let c = 0.5 / l;
  for (let h = 0; h < a.length; h++) a[h] = a[h] * c + 0.5;
  return a;
}
function _o(o, t, e, s, n, i = 0.5, a = 256) {
  return a >= o ? uf(o, t, e, s, n, i) : df(uf(a, t, e, s, n, i), a, o);
}
function df(o, t, e, s) {
  s = s || new Float32Array(e * e);
  let n = t / e, i = new Int32Array(e), a = new Int32Array(e), r = new Float32Array(e);
  for (let c = 0; c < e; c++) {
    let h = (c + 0.5) * n - 0.5, f = Math.floor(h);
    i[c] = (f + t) % t, a[c] = (f + 1 + t) % t, r[c] = h - f;
  }
  let l = 0;
  for (let c = 0; c < e; c++) {
    let h = (c + 0.5) * n - 0.5, f = Math.floor(h), u = h - f, d = (f + t) % t * t, m = (f + 1 + t) % t * t;
    for (let p = 0; p < e; p++) {
      let x = o[d + i[p]], g = o[d + a[p]], b = o[m + i[p]], v = o[m + a[p]], y = r[p], M = x + (g - x) * y, w = b + (v - b) * y;
      s[l++] = M + (w - M) * u;
    }
  }
  return s;
}
function lA(o, t, e, s = 2) {
  let n = new Float32Array(o), i = new Float32Array(t * t), a = 2 * e + 1, r = 1 / a, l = new Float64Array(t);
  for (let c = 0; c < s; c++) {
    for (let h = 0; h < t; h++) {
      let f = h * t, u = 0;
      for (let d = -e; d <= e; d++) u += n[f + (d % t + t) % t];
      for (let d = 0; d < t; d++) {
        i[f + d] = u * r;
        let m = d + e + 1;
        m >= t && (m -= t);
        let p = d - e;
        p < 0 && (p += t), u += n[f + m] - n[f + p];
      }
    }
    l.fill(0);
    for (let h = -e; h <= e; h++) {
      let f = (h % t + t) % t * t;
      for (let u = 0; u < t; u++) l[u] += i[f + u];
    }
    for (let h = 0; h < t; h++) {
      let f = h * t, u = h + e + 1;
      u >= t && (u -= t);
      let d = h - e;
      d < 0 && (d += t);
      let m = u * t, p = d * t;
      for (let x = 0; x < t; x++) n[f + x] = l[x] * r, l[x] += i[m + x] - i[p + x];
    }
  }
  return n;
}
function pf(o, t, e = 1) {
  let s = new Float32Array(o), n = new Float32Array(t * t);
  for (let i = 0; i < e; i++) {
    for (let a = 0; a < t; a++) {
      let r = a * t;
      n[r] = (s[r + t - 1] + 2 * s[r] + s[r + 1]) * 0.25;
      for (let l = 1; l < t - 1; l++) n[r + l] = (s[r + l - 1] + 2 * s[r + l] + s[r + l + 1]) * 0.25;
      n[r + t - 1] = (s[r + t - 2] + 2 * s[r + t - 1] + s[r]) * 0.25;
    }
    for (let a = 0; a < t; a++) {
      let r = a * t, l = (a ? a - 1 : t - 1) * t, c = (a < t - 1 ? a + 1 : 0) * t;
      for (let h = 0; h < t; h++) s[r + h] = (n[l + h] + 2 * n[r + h] + n[c + h]) * 0.25;
    }
  }
  return s;
}
function hT(o, t, e, s, n, i = null, a = 0) {
  let r = new Float32Array(t * t), l = t - 1, c = 0;
  for (let h = 0; h < t; h++) for (let f = 0; f < t; f++, c++) {
    let u = f + (e[c] - 0.5) * n + (i ? (i[c] - 0.5) * a : 0) + t, d = h + (s[c] - 0.5) * n + t, m = Math.floor(u), p = Math.floor(d), x = u - m, g = d - p, b = m & l, v = m + 1 & l, y = (p & l) * t, M = (p + 1 & l) * t, w = o[y + b], T = o[y + v], S = o[M + b], E = o[M + v], _ = w + (T - w) * x, R = S + (E - S) * x;
    r[c] = _ + (R - _) * g;
  }
  return r;
}
function P1(o, t) {
  let e = Math.max(1, Math.floor(o.length / 16384)), s = Math.floor(o.length / e), n = new Float32Array(s);
  for (let i = 0; i < s; i++) n[i] = o[i * e];
  return n.sort(), n[Math.min(s - 1, Math.max(0, Math.floor(t * s)))];
}
function _5(o) { let t = makeCanvas(o, o), e = t.getContext("2d", { willReadFrequently: true }); return e.fillStyle = "#000", e.fillRect(0, 0, o, o), e; }
function y2(o, t, e, s, n, i) {
  for (let a = -t; a <= t; a += t) if (!(s + a + n < 0 || s + a - n > t)) for (let r = -t; r <= t; r += t) e + r + n < 0 || e + r - n > t || (o.save(), o.translate(r, a), i(), o.restore());
}
function S4(o, t, e = "r") {
  let s = o.getImageData(0, 0, t, t).data, n = [];
  for (let i of e) {
    let a = "rgba".indexOf(i), r = new Float32Array(t * t);
    for (let l = 0, c = a; l < r.length; l++, c += 4) r[l] = s[c] * (1 / 255);
    n.push(r);
  }
  return n;
}
function z1(o, t, e, s, n = 7, i = null, a = null) {
  let r = n * 7919 + 13 | 0, l = 0;
  for (let c = 0; c < t; c++) {
    let h = c * t, f = (c < t - 1 ? c + 1 : 0) * t, u = (c ? c - 1 : t - 1) * t;
    for (let d = 0; d < t; d++, l += 4) {
      let m = d ? d - 1 : t - 1, p = d < t - 1 ? d + 1 : 0, x = (o[h + p] - o[h + m]) * e, g = (o[f + d] - o[u + d]) * e;
      i && (x += i[h + d], g += a[h + d]);
      let b = 1 / Math.sqrt(x * x + g * g + 1);
      r ^= r << 13, r ^= r >>> 17, r ^= r << 5;
      let v = (r & 255) / 255, y = (r >>> 8 & 255) / 255;
      s[l] = (-x * b * 0.5 + 0.5) * 255 + v, s[l + 1] = (-g * b * 0.5 + 0.5) * 255 + y, s[l + 2] = (b * 0.5 + 0.5) * 255 + 0.5, s[l + 3] = 255;
    }
  }
  return s;
}
function SF(o, t, e, s, n) {
  let i = wh(e), a = o / t, r = t * t, l = new Float32Array(r), c = new Float32Array(r), h = new Uint16Array(r);
  for (let y = 0; y < t; y++) for (let M = 0; M < t; M++) l[y * t + M] = (M + 0.5 + (i() - 0.5) * s) * a, c[y * t + M] = (y + 0.5 + (i() - 0.5) * s) * a;
  if (n) {
    let y = [], M = [];
    for (let w = 0; w < n; w++) y.push(i() * o), M.push(i() * o);
    for (let w = 0; w < r; w++) {
      let T = 1e9, S = 0;
      for (let E = 0; E < n; E++) {
        let _ = Math.abs(l[w] - y[E]), R = Math.abs(c[w] - M[E]);
        _ > o / 2 && (_ = o - _), R > o / 2 && (R = o - R);
        let C = _ * _ + R * R;
        C < T && (T = C, S = E);
      }
      h[w] = S;
    }
  }
  let f = new Float32Array(r * 9), u = new Float32Array(r * 9), d = new Int32Array(r * 9);
  for (let y = 0; y < t; y++) for (let M = 0; M < t; M++) {
    let w = (y * t + M) * 9;
    for (let T = -1; T <= 1; T++) for (let S = -1; S <= 1; S++, w++) {
      let E = M + S, _ = y + T, R = (E + t) % t, C = (_ + t) % t, L = C * t + R;
      f[w] = l[L] + (E - R) * a, u[w] = c[L] + (_ - C) * a, d[w] = L;
    }
  }
  let m = new Uint16Array(o * o), p = new Float32Array(o * o), x = new Float32Array(o * o), g = new Float32Array(o * o), b = new Float32Array(o * o), v = 0;
  for (let y = 0; y < o; y++) {
    let M = Math.min(t - 1, Math.floor(y / a));
    for (let w = 0; w < o; w++, v++) {
      let T = Math.min(t - 1, Math.floor(w / a)), S = (M * t + T) * 9, E = 1e9, _ = 0;
      for (let k = S; k < S + 9; k++) {
        let I = f[k] - w, G = u[k] - y, K = I * I + G * G;
        K < E && (E = K, _ = k);
      }
      let R = d[_], C = f[_], L = u[_], A = h[R], O = C - l[R], H = L - c[R], F = R * 9, P = 1e9, z = 1e9;
      for (let k = F; k < F + 9; k++) {
        let I = d[k];
        if (I === R) continue;
        let G = f[k] + O, K = u[k] + H, $ = G - C, n0 = K - L, e0 = (((C + G) * 0.5 - w) * $ + ((L + K) * 0.5 - y) * n0) / Math.sqrt($ * $ + n0 * n0);
        e0 < P && (P = e0), h[I] !== A && e0 < z && (z = e0);
      }
      m[v] = R, p[v] = P, x[v] = z, g[v] = w - C, b[v] = y - L;
    }
  }
  return { id: m, edge: p, crack: x, vx: g, vy: b, plate: h, cells: r };
}
var Fu = (o) => ({ alb: new Uint8ClampedArray(o * o * 4), nrm: new Uint8ClampedArray(o * o * 4), orm: new Uint8ClampedArray(o * o * 4) });
function KQ(o, t, { n: e = 60, len: s = [20, 200], alpha: n = [0.15, 1], width: i = [0.8, 1.4], bias: a = 0.6, scuffs: r = 0, scuffAlpha: l = 0.2 } = {}) {
  let c = _5(o), h = wh(t);
  c.globalCompositeOperation = "lighter", c.lineCap = "round";
  let f = (u, d, m, p, x, g) => {
    let b = Math.cos(m) * p / 2, v = Math.sin(m) * p / 2, y = (h() - 0.5) * p * 0.14;
    c.strokeStyle = `rgba(255,255,255,${x.toFixed(3)})`, c.lineWidth = g, y2(c, o, u, d, p / 2 + 6, () => {
      c.beginPath(), c.moveTo(u - b, d - v), c.quadraticCurveTo(u - Math.sin(m) * y, d + Math.cos(m) * y, u + b, d + v), c.stroke();
    });
  };
  for (let u = 0; u < e; u++) {
    let d = h() < a ? (h() - 0.5) * 0.5 + (h() < 0.5 ? 0 : Math.PI) : h() * Oo, m = h();
    f(h() * o, h() * o, d, s[0] + (s[1] - s[0]) * h() * h(), n[0] + (n[1] - n[0]) * m * m * m, i[0] + (i[1] - i[0]) * h());
  }
  for (let u = 0; u < r; u++) {
    let d = h() * o, m = h() * o, p = h() * Oo, x = 8 + (h() * 22 | 0), g = 6 + h() * 26, b = 14 + h() * 60, v = l * (0.4 + h());
    for (let y = 0; y < x; y++) {
      let M = (h() - 0.5) * g, w = (h() - 0.5) * b * 0.6;
      f(d - Math.sin(p) * M + Math.cos(p) * w, m + Math.cos(p) * M + Math.sin(p) * w, p + (h() - 0.5) * 0.08, b * (0.4 + h() * 0.8), v * (0.5 + h()), 0.8);
    }
  }
  return S4(c, o, "r")[0];
}
var _F = /* @__PURE__ */ new Map();
function yp(o) {
  let t = _F.get(o);
  return t || _F.set(o, t = { S: KQ(o, 106, { n: 44, len: [16, 300], alpha: [0.12, 1], bias: 0.7, scuffs: 24, scuffAlpha: 0.18 }), chip: uf(o, 44, 44, 3, 1047, 0.62) }), t;
}
function Ey(o, t, e, s = 0.94, n = 1) {
  let { S: i, chip: a } = yp(o), r = _o(o, 6, 6, 3, t), l = new Float32Array(o * o);
  for (let f = 0; f < l.length; f++) l[f] = r[f] * 0.6 + a[f] * 0.4;
  let c = P1(l, 0.02), h = 1 / (P1(l, 0.995) - c);
  for (let f = 0; f < l.length; f++) {
    let u = (l[f] - c) * h;
    u = u < 0 ? 0 : u > 1 ? 1 : u, u *= s * (e ? 0.84 + 0.16 * e[f] : 1);
    let d = i[f] * n;
    l[f] = u > d ? u : d;
  }
  return l;
}
var Ty = 0.1;
function XQ(o = 1024) {
  let e = 200 / o, s = Fu(o), { alb: n, orm: i } = s, a = _o(o, 3, 3, 4, 101), r = _o(o, 6, 6, 3, 102), l = _o(o, 2, 3, 3, 103), c = _o(o, 1, 8, 2, 109), h = ql(o, 105), f = ql(o, 108), u = yp(o).S, d = Ey(o, 104, l), m = pf(h, o, 2), p = new Float32Array(o * o), x = 1 - Ty;
  for (let g = 0, b = 0; g < p.length; g++, b += 4) {
    let v = $o(0.55, 0.76, l[g]), y = u[g], M = d[g], w = $o(x - 0.05, x + 0.02, M), T = 0.8 + 0.24 * a[g] + 0.16 * c[g] + (h[g] - 0.5) * 0.04 + (m[g] - 0.5) * 0.09 - v * 0.15;
    f[g] > 0.992 ? T *= 0.88 : f[g] < 8e-3 && (T *= 1.08);
    let S = r[g] - 0.5;
    n[b] = (119 + S * 13) * T + y * 22, n[b + 1] = (106 + S * 2) * T + y * 20, n[b + 2] = (83 - S * 14) * T + y * 16, n[b + 3] = 255, i[b] = M * 255, i[b + 1] = (0.62 - v * 0.26 + (h[g] - 0.5) * 0.07 - y * 0.2 + (c[g] - 0.5) * 0.14) * 255, i[b + 2] = 0, i[b + 3] = 255, p[g] = -0.04 * w - 0.025 * y + (m[g] - 0.5) * 0.02;
  }
  return z1(p, o, 1.6 / (2 * e), s.nrm, 11), { N: o, tile: 0.2, ...s };
}
function YQ(o = 1024) {
  let e = 320 / o, s = 1 / e, n = Fu(o), { alb: i, orm: a } = n, r = wh(2207), l = _o(o, 3, 3, 4, 201), c = _o(o, 5, 5, 3, 202), h = _o(o, 2, 3, 3, 203), f = ql(o, 204), u = _5(o);
  u.globalCompositeOperation = "lighter";
  let d = (P, z, k, I, G) => y2(u, o, P, z, k, () => {
    let K = u.createRadialGradient(P, z, 0, P, z, k);
    K.addColorStop(0, `rgba(${I},${G})`), K.addColorStop(0.45, `rgba(${I},${G * 0.72})`), K.addColorStop(1, `rgba(${I},0)`), u.fillStyle = K, u.fillRect(P - k, z - k, k * 2, k * 2);
  }), m = [];
  for (let P = 0; P < 400 && m.length < 15; P++) {
    let z = r() * o, k = r() * o, I = true;
    for (let G of m) {
      let K = Math.abs(z - G[0]), $ = Math.abs(k - G[1]);
      if (K > o / 2 && (K = o - K), $ > o / 2 && ($ = o - $), K * K + $ * $ < (62 * s) ** 2) {
        I = false;
        break;
      }
    }
    I && m.push([z, k]);
  }
  u.fillStyle = "rgb(0,255,0)";
  let p = (P, z) => {
    u.beginPath(), u.moveTo(0, 0), u.bezierCurveTo(P * 0.25, -z, P * 0.7, -z * 0.8, P, 0), u.bezierCurveTo(P * 0.7, z * 0.8, P * 0.25, z, 0, 0), u.fill();
  };
  m.forEach(([P, z], k) => {
    let I = r() * Oo, G = k % 3 !== 2, K = (G ? r.range(58, 92) : r.range(40, 58)) * s, $ = r.range(-0.5, 0.5);
    y2(u, o, P, z, K, () => {
      if (u.save(), u.translate(P, z), u.rotate(I), u.translate(-K / 2, 0), G) {
        let p0 = Math.floor(K / (5.2 * s));
        for (let t0 = 0; t0 <= p0; t0++) {
          let M0 = t0 / p0, f0 = M0 * K, _0 = Math.sin(M0 * 2.2) * $ * K * 0.25, F0 = Math.sin(Math.PI * Math.pow(M0, 0.62)) * (1 - M0 * 0.35), m0 = (5 + 17 * F0) * s, S0 = (1.1 + 1.5 * F0) * s;
          for (let T0 of [-1, 1]) u.save(), u.translate(f0, _0), u.rotate(T0 * (1.02 - M0 * 0.35) + $ * 0.3), p(m0, S0), u.restore();
        }
        u.fillRect(0, -0.6 * s, K, 1.2 * s);
      } else {
        let p0 = 4 + (r() * 3 | 0);
        for (let t0 = 0; t0 < p0; t0++) {
          let M0 = t0 / (p0 - 1), f0 = t0 % 2 ? 1 : -1;
          u.save(), u.translate(M0 * K * 0.8, 0), u.rotate(t0 === p0 - 1 ? 0 : f0 * r.range(0.55, 0.95)), p(r.range(20, 30) * s, r.range(4.5, 7) * s), u.restore();
        }
        u.fillRect(0, -0.7 * s, K * 0.8, 1.4 * s);
      }
      u.restore();
    });
    let n0 = Math.cos(I), e0 = Math.sin(I);
    for (let p0 = -1; p0 <= 1; p0++) d(P + n0 * p0 * K * 0.3 + r.range(-8, 8) * s, z + e0 * p0 * K * 0.3 + r.range(-8, 8) * s, K * r.range(0.5, 0.68), "255,0,0", 0.85);
  });
  for (let P = 0; P < 9; P++) {
    let z = r() * o, k = r() * o;
    d(z, k, r.range(38, 62) * s, "0,0,255", 0.95), d(z + r.range(-30, 30) * s, k + r.range(-30, 30) * s, r.range(26, 40) * s, "0,0,255", 0.8);
  }
  let [x, g, b] = S4(u, o, "rgb"), v = pf(g, o, 2), y = yp(o).S, M = Ey(o, 205, h, 0.955), w = o / 45, T = o / 26, S = Math.sqrt(3) / 2, E = new Float32Array(o * o), _ = 1 - Ty, R = P1(l, 0.62), C = [142, 129, 93], L = [82, 61, 43], A = [70, 80, 45], O = [35, 43, 31], H = 0, F = 0;
  for (let P = 0; P < o; P++) for (let z = 0; z < o; z++, H++, F += 4) {
    let k = f[H] - 0.5, I = $o(R - 0.015, R + 0.06, l[H]), G = t1(x[H] * 1.45) * (1 - 0.94 * v[H]), K = t1(b[H] * 1.5);
    if (K > 0.01) {
      let F0 = z + (l[H] - 0.5) * 110, m0 = P + (c[H] - 0.5) * 110, S0 = F0 / w, T0 = m0 / T;
      S0 -= Math.floor(S0), T0 -= Math.floor(T0);
      let j0 = S0 + 0.5, Z0 = T0 + 0.5;
      j0 -= Math.floor(j0), Z0 -= Math.floor(Z0), S0 = Math.abs(S0 - 0.5) * w, T0 = Math.abs(T0 - 0.5) * w * 1.7320508, j0 = Math.abs(j0 - 0.5) * w, Z0 = Math.abs(Z0 - 0.5) * w * 1.7320508;
      let lt = Math.max(S0, S0 * 0.5 + T0 * S), H0 = Math.max(j0, j0 * 0.5 + Z0 * S), Y0 = w * 0.5 - Math.min(lt, H0);
      K *= 1 - (0.3 + 0.5 * c[H]) * (1 - $o(0.3, 4, Y0));
    }
    I = t1(I + k * 0.5 * (4 * I * (1 - I))), G = t1(G + k * 0.9 * (4 * G * (1 - G))), K = t1(K + k * 0.9 * (4 * K * (1 - K)));
    let $ = 0.92 + 0.16 * c[H] + k * 0.05, n0 = y[H], e0 = $o(0.58, 0.8, h[H]), p0 = C[0], t0 = C[1], M0 = C[2];
    p0 += (L[0] - p0) * I * 0.96, t0 += (L[1] - t0) * I * 0.96, M0 += (L[2] - M0) * I * 0.96, p0 += (A[0] - p0) * G, t0 += (A[1] - t0) * G, M0 += (A[2] - M0) * G, p0 += (O[0] - p0) * K, t0 += (O[1] - t0) * K, M0 += (O[2] - M0) * K;
    let f0 = $ * (1 - e0 * 0.06);
    i[F] = p0 * f0 + n0 * 20, i[F + 1] = t0 * f0 + n0 * 19, i[F + 2] = M0 * f0 + n0 * 16, i[F + 3] = 255;
    let _0 = 4 * (G * (1 - G) + K * (1 - K));
    a[F] = M[H] * 255, a[F + 1] = (0.72 + _0 * 0.12 - e0 * 0.24 + k * 0.06 - n0 * 0.2 + (c[H] - 0.5) * 0.12) * 255, a[F + 2] = 0, a[F + 3] = 255, E[H] = 0.012 * (I + G + K) + _0 * k * 0.02 + k * 8e-3 - 0.045 * $o(_ - 0.05, _ + 0.02, M[H]) - 0.025 * n0;
  }
  return z1(E, o, 1.7 / (2 * e), n.nrm, 12), { N: o, tile: 0.32, ...n };
}
function jQ(o = 1024) {
  let e = 240 / o, s = 1 / e, n = Fu(o), { alb: i, orm: a } = n, r = wh(3301), l = _5(o);
  l.globalCompositeOperation = "lighter";
  let c = [-0.56, 0.3, 1.24], h = (R, C, L) => {
    let A = r() * o, O = r() * o, H = r.pick(c) + r.range(-0.13, 0.13) + (r() < 0.5 ? Math.PI : 0), F = r.range(C[0], C[1]) * s, P = r.range(L[0], L[1]) * s, z = r() < 0.35 ? [[-F / 2, r.range(-0.2, 0.2) * P], [F * r.range(-0.2, 0.25), P / 2], [F / 2, r.range(-0.5, 0.1) * P]] : [[-F / 2, r.range(-0.3, 0.3) * P], [F * r.range(-0.3, 0.05), P / 2], [F / 2, r.range(-0.1, 0.4) * P], [F * r.range(0, 0.35), -P / 2]];
    l.fillStyle = R, y2(l, o, A, O, F / 2 + 2, () => {
      l.save(), l.translate(A, O), l.rotate(H), l.beginPath(), z.forEach((k, I) => I ? l.lineTo(k[0], k[1]) : l.moveTo(k[0], k[1])), l.closePath(), l.fill(), l.restore();
    });
  };
  for (let R = 0; R < 92; R++) h("rgb(255,0,0)", [18, 62], [6, 19]);
  for (let R = 0; R < 70; R++) h("rgb(0,255,0)", [14, 50], [4, 14]);
  for (let R = 0; R < 30; R++) h("rgb(0,0,255)", [10, 30], [2.5, 7]);
  let [f, u, d] = S4(l, o, "rgb"), m = pf(f, o, 1), p = pf(u, o, 1), x = pf(d, o, 1), g = _o(o, 4, 4, 4, 302), b = _o(o, 2, 3, 3, 303), v = ql(o, 304), y = yp(o).S, M = Ey(o, 305, b, 0.93), w = new Float32Array(o * o), T = 1 - Ty, S = [112, 119, 126], E = [68, 74, 83], _ = [30, 33, 40];
  for (let R = 0, C = 0; R < w.length; R++, C += 4) {
    let L = f[R], A = u[R], O = d[R], H = v[R] - 0.5, F = y[R], P = S[0] + (E[0] - S[0]) * L, z = S[1] + (E[1] - S[1]) * L, k = S[2] + (E[2] - S[2]) * L;
    P += (_[0] - P) * A, z += (_[1] - z) * A, k += (_[2] - k) * A, P += (S[0] * 1.05 - P) * O, z += (S[1] * 1.05 - z) * O, k += (S[2] * 1.05 - k) * O;
    let I = 0.9 + 0.2 * g[R] + H * 0.05, G = 1 - P / 118;
    i[C] = P * I + F * 34 * G, i[C + 1] = z * I + F * 34 * G, i[C + 2] = k * I + F * 34 * G, i[C + 3] = 255;
    let K = $o(0.58, 0.8, b[R]);
    a[C] = M[R] * 255, a[C + 1] = (0.56 - G * 0.1 - K * 0.18 + H * 0.06 - F * 0.2 + (g[R] - 0.5) * 0.14) * 255, a[C + 2] = 0, a[C + 3] = 255;
    let $ = 4 * m[R] * (1 - m[R]), n0 = 4 * p[R] * (1 - p[R]), e0 = 4 * x[R] * (1 - x[R]);
    w[R] = 0.02 * (m[R] + p[R] + x[R]) + 0.03 * ($ * $ + n0 * n0 + e0 * e0) - 0.045 * $o(T - 0.05, T + 0.02, M[R]) - 0.022 * F + H * 6e-3;
  }
  return z1(w, o, 2.2 / (2 * e), n.nrm, 13), { N: o, tile: 0.24, ...n };
}
function $Q(o = 1024) {
  let e = 300 / o, s = Fu(o), { alb: n, orm: i } = s, a = _o(o, 2, 2, 3, 401), r = _o(o, 3, 2, 3, 402), l = new Float32Array(o * o);
  T4(l, o, 3, 96, 412, 0.32), T4(l, o, 7, 210, 413, 0.16);
  for (let S = 0; S < l.length; S++) l[S] += 0.5;
  let c = hT(_o(o, 3, 9, 4, 403, 0.5, 512), o, a, r, 120, l, 40), h = hT(_o(o, 6, 21, 4, 404, 0.5, 512), o, r, a, 170, l, 50), f = new Float32Array(o * o);
  T4(f, o, 9, 240, 405, 0.55), T4(f, o, 21, 480, 406, 0.45);
  let u = _o(o, 4, 4, 3, 407), d = _o(o, 2, 3, 3, 408), m = ql(o, 409), p = yp(o).S, x = Ey(o, 410, d, 0.945), g = P1(c, 0.42), b = P1(h, 0.68), v = new Float32Array(o * o), y = 1 - Ty, M = [126, 112, 80], w = [68, 75, 44], T = [21, 21, 20];
  for (let S = 0, E = 0; S < v.length; S++, E += 4) {
    let _ = f[S], R = m[S] - 0.5, C = p[S], L = $o(g - 3e-3, g + 6e-3, c[S] + _ * 0.012), A = h[S] - b + _ * 0.012, O = $o(-3e-3, 5e-3, A), H = O * (1 - $o(0, 0.06, A)), F = H * t1(-_ * 3.2 - 0.3), P = O * (1 - 0.85 * F), z = M[0] + (w[0] - M[0]) * L, k = M[1] + (w[1] - M[1]) * L, I = M[2] + (w[2] - M[2]) * L;
    z += (T[0] - z) * P, k += (T[1] - k) * P, I += (T[2] - I) * P;
    let G = 0.93 + 0.14 * u[S] + R * 0.04 + _ * 0.07 * (L + P);
    n[E] = z * G + C * 24, n[E + 1] = k * G + C * 23, n[E + 2] = I * G + C * 19, n[E + 3] = 255;
    let K = $o(0.58, 0.8, d[S]), $ = 0.66 - L * 0.1 - P * 0.26 + _ * 0.22 * (0.5 * L + P) - K * 0.16 + R * 0.05 - C * 0.2;
    i[E] = x[S] * 255, i[E + 1] = $ * 255, i[E + 2] = 0, i[E + 3] = 255, v[S] = (0.02 * L + 0.05 * P) * (0.8 + _ * 1.1) + R * 6e-3 - 0.05 * $o(y - 0.05, y + 0.02, x[S]) - 0.022 * C;
  }
  return z1(v, o, 2 / (2 * e), s.nrm, 14), { N: o, tile: 0.3, ...s };
}
function ZQ(o = 1024) {
  let e = 200 / o, s = Fu(o), { alb: n, orm: i } = s, a = uf(o, 3, 3, 3, 501, 0.4), r = _o(o, 4, 4, 3, 502), l = _o(o, 2, 3, 3, 503), c = ql(o, 504), h = yp(o).S, f = Ey(o, 505, l, 0.93), u = new Float32Array(o * o);
  for (let E = 0, _ = 0; E < o; E++) {
    let R = (E < o - 1 ? E + 1 : 0) * o, C = (E ? E - 1 : o - 1) * o, L = E * o;
    for (let A = 0; A < o; A++, _++) {
      let O = (a[L + (A < o - 1 ? A + 1 : 0)] - a[L + (A ? A - 1 : o - 1)]) * 0.5, H = (a[R + A] - a[C + A]) * 0.5;
      u[_] = Math.sqrt(O * O + H * H);
    }
  }
  let d = P1(u, 0.5), m = Math.max(4, Math.round(1 / (5.5 / e * d))), p = d * 0.22, x = P1(a, 0.03), g = 1 / (P1(a, 0.97) - x), b = new Float32Array(o * o);
  for (let E = 0; E < b.length; E++) {
    let _ = a[E] * m, R = Math.round(_), C = Math.abs(_ - R) / (m * (u[E] > p ? u[E] : p)), L = (R % 5 === 0 ? 0.42 : 0.2) / e;
    b[E] = 1 - $o(L - 0.6, L + 0.6, C);
  }
  let v = pf(b, o, 1), y = new Float32Array(o * o), M = 1 - Ty, w = o / 8, T = 0, S = 0;
  for (let E = 0; E < o; E++) for (let _ = 0; _ < o; _++, T++, S += 4) {
    let R = b[T], C = c[T] - 0.5, L = h[T], A = Math.abs((_ + w / 2) % w - w / 2), O = Math.abs((E + w / 2) % w - w / 2), H = A < 7 && O < 0.9 || O < 7 && A < 0.9 ? 1 : 0, F = Math.max(1 - $o(0.4, 1.3, Math.min(A, O)), H) * (1 - R), P = t1((a[T] - x) * g), z = (0.72 + 0.62 * P * P) * (0.92 + 0.16 * r[T]) + C * 0.08, k = 0.9 + 0.14 * r[T] + C * 0.05;
    n[S] = Wl(19 * z, 194 * k, R) + L * 24, n[S + 1] = Wl(20 * z, 90 * k, R) + L * 22, n[S + 2] = Wl(24 * z, 22 * k, R) + L * 20, n[S + 3] = 255;
    let I = $o(0.58, 0.8, l[T]);
    i[S] = f[T] * 255, i[S + 1] = (Wl(0.72 - F * 0.34, 0.3, R) - I * 0.2 * (1 - R) + C * 0.06 - L * 0.2) * 255, i[S + 2] = 0, i[S + 3] = 255, y[T] = 0.034 * v[T] + 8e-3 * F + C * 6e-3 * (1 - R) - 0.045 * $o(M - 0.05, M + 0.02, f[T]) - 0.022 * L;
  }
  return z1(y, o, 2 / (2 * e), s.nrm, 15), { N: o, tile: 0.2, ...s };
}
function QQ(o = 1024) {
  let s = 96 / o, n = o / 48, i = Fu(o), { alb: a, orm: r } = i, l = _o(o, 2, 2, 2, 601), c = _o(o, 2, 2, 2, 602), h = _o(o, 3, 3, 2, 603), f = ql(o, 604), u = wh(605), d = 16, m = new Float32Array(48 * 2), p = new Float32Array(48 * 2 * d);
  for (let y = 0; y < m.length; y++) m[y] = u();
  for (let y = 0; y < p.length; y++) p[y] = u();
  let x = new Float32Array(o * o), g = new Uint8ClampedArray(o * o * 4), b = 0, v = 0;
  for (let y = 0; y < o; y++) for (let M = 0; M < o; M++, b++, v += 4) {
    let w = (M + (l[b] - 0.5) * n * 1.3) / n + 48, T = (y + (c[b] - 0.5) * n * 1.3) / n + 48, S = Math.floor(w), E = Math.floor(T), _ = w - S, R = T - E, C = ((S - E) % 4 + 4) % 4, L, A, O;
    C < 2 ? (L = _, A = 1 - C + R, O = S % 48) : (L = R, A = C - 2 + _, O = 48 + E % 48);
    let H = Math.abs(L * 2 - 1), F = H * H, P = 1 - F * F, z = Math.sin(Math.PI * A * 0.5), k = 0.5 + 0.5 * z, I = L * (d - 1), G = Math.floor(I), K = I - G, $ = O * d + G, n0 = p[$] + (p[$ + (G < d - 1 ? 1 : 0)] - p[$]) * K;
    x[b] = 0.11 * P * k + 0.02 * (n0 - 0.5) * P + (f[b] - 0.5) * 4e-3;
    let e0 = F * F * F * F, p0 = (0.45 + 0.55 * k) * (1 - 0.8 * e0) * (0.84 + 0.32 * m[O]) * (0.9 + 0.2 * h[b]), t0 = 0.88 + 0.24 * n0;
    a[v] = 70 * p0 * t0, a[v + 1] = 72 * p0 * t0, a[v + 2] = 78 * p0 * t0, a[v + 3] = 255, r[v] = 0, r[v + 1] = (0.34 + e0 * 0.3 + (n0 - 0.5) * 0.12) * 255, r[v + 2] = 255, r[v + 3] = 255, C < 2 ? (g[v] = 255, g[v + 1] = 128) : (g[v] = 128, g[v + 1] = 255), g[v + 2] = 255 * P * (0.75 + 0.25 * k), g[v + 3] = 255;
  }
  return z1(x, o, 1.3 / (2 * s), i.nrm, 16), { N: o, tile: 0.096, ...i, ani: g };
}
function JQ(o = 1024) {
  let e = 200 / o, s = Fu(o), { alb: n, orm: i } = s, a = _o(o, 2, 2, 3, 701), r = _o(o, 2, 3, 3, 702), l = hT(uf(o, 2, 3, 4, 703, 0.48), o, a, r, 150), c = _o(o, 5, 9, 2, 704), h = ql(o, 705), f = _o(o, 3, 3, 3, 706), u = yp(o).S, d = 38, m = 19, p = new Float32Array(o * o);
  for (let M = 0, w = 0; M < o; M++) {
    let T = m * M / o;
    for (let S = 0; S < o; S++, w++) p[w] = d * l[w] + T;
  }
  let x = new Float32Array(o * o), g = wh(708), b = new Float32Array(256);
  for (let M = 0; M < 256; M++) b[M] = g();
  let v = 0, y = 0;
  for (let M = 0; M < o; M++) {
    let w = (M < o - 1 ? M + 1 : 0) * o, T = (M ? M - 1 : o - 1) * o, S = M * o;
    for (let E = 0; E < o; E++, v++, y += 4) {
      let _ = (p[S + (E < o - 1 ? E + 1 : 0)] - p[S + (E ? E - 1 : o - 1)]) * 0.5, R = p[w + E] - p[T + E];
      (M === 0 || M === o - 1) && (R += m), R *= 0.5;
      let C = Math.sqrt(_ * _ + R * R) * Oo, L = p[v], A = (c[v] - 0.5) * 1.1, O = Math.sin(Oo * L) + A + 0.4 * Math.sin(Oo * 2 * L + 1.3), H = Math.max(0.02, C * 1.1), F = $o(-H, H, O), P = $o(0.5, 1.6, C);
      F = F + (0.55 - F) * P;
      let z = b[Math.floor(L) & 255], k = h[v] - 0.5, I = u[v] * 0.5, G = 0.9 + 0.16 * f[v], K = 0.84 + 0.32 * z, $ = (122 + z * 10) * K, n0 = (117 + z * 4) * K, e0 = (112 - z * 8 + 8) * K;
      n[y] = Wl($, 200 * G, F) + I * 60 * (1 - F), n[y + 1] = Wl(n0, 197 * G, F) + I * 60 * (1 - F), n[y + 2] = Wl(e0, 190 * G, F) + I * 60 * (1 - F), n[y + 3] = 255, i[y] = I * 0.5 * 255, i[y + 1] = (Wl(0.5 + k * 0.16, 0.19 + k * 0.04, F) + I * 0.1 * F - I * 0.12 * (1 - F)) * 255, i[y + 2] = 255, i[y + 3] = 255, x[v] = 0.05 * F + (1 - F) * k * 0.014 - 0.012 * I;
    }
  }
  return z1(pf(x, o, 1), o, 1.5 / (2 * e), s.nrm, 17), { N: o, tile: 0.2, ...s };
}
function tJ(o = 2048) {
  let e = 180 / o, s = 1 / e, n = Fu(o), { alb: i, orm: a } = n, r = wh(8088), l = _5(o);
  l.lineCap = "round", l.lineJoin = "round";
  let c = (H) => {
    l.globalCompositeOperation = "source-over", H > 0 && (l.strokeStyle = d ? "rgb(0,0,255)" : "#000", l.lineWidth = H * 2, l.stroke()), l.fillStyle = d ? "rgb(255,0,255)" : "rgb(255,0,0)", l.fill();
  }, h = (H) => {
    l.globalCompositeOperation = "lighter", l.strokeStyle = "rgb(0,255,0)", l.lineWidth = H, l.stroke();
  }, f = 0.17 * s, u = [], d = false, m = (H, F, P) => {
    for (let z of u) {
      let k = Math.abs(H - z[0]), I = Math.abs(F - z[1]);
      if (k > o / 2 && (k = o - k), I > o / 2 && (I = o - I), k * k + I * I < (P + z[2]) * (P + z[2])) return false;
    }
    return true;
  }, p = [[o * 0.27, o * 0.3, 15.5 * s], [o * 0.77, o * 0.8, 15.5 * s]];
  for (let H of p) u.push([H[0], H[1], H[2] * 1.05]);
  let x = (H, F, P) => {
    y2(l, o, H, F, P * 1.1, () => {
      l.save(), l.translate(H, F), l.globalCompositeOperation = "multiply", l.fillStyle = "rgb(0,0,255)", l.beginPath(), l.arc(0, 0, P * 1.035, 0, Oo), l.fill(), l.globalCompositeOperation = "lighter", l.fillStyle = "rgb(0,0,255)", l.beginPath(), l.arc(0, 0, P * 0.985, 0, Oo), l.fill(), l.beginPath(), l.arc(0, 0, P, 0, Oo), l.arc(0, 0, P * 0.925, 0, Oo, true), c(f * 0.5);
      let z = 46;
      for (let I = 0; I < z; I++) {
        let G = I / z * Oo;
        l.beginPath(), l.arc(Math.cos(G) * P * 0.868, Math.sin(G) * P * 0.868, P * 0.036, 0, Oo), c(0);
      }
      l.beginPath(), l.arc(0, 0, P * 0.812, 0, Oo), l.arc(0, 0, P * 0.785, 0, Oo, true), c(0);
      let k = 16;
      for (let I = 0; I < k * 2; I++) {
        let G = I / (k * 2) * Oo, K = I % 2 === 0, $ = P * 0.25, n0 = P * (K ? 0.765 : 0.54), e0 = P * (K ? 0.052 : 0.036);
        l.save(), l.rotate(G), l.beginPath(), l.moveTo($, -e0), l.lineTo(n0, 0), l.lineTo($, e0), l.closePath(), c(0), K && (l.beginPath(), l.moveTo($ * 1.15, 0), l.lineTo(n0 * 0.9, 0), h(0.12 * s)), l.restore();
      }
      l.beginPath(), l.arc(0, 0, P * 0.24, 0, Oo), c(f * 0.6), l.beginPath(), l.arc(0, 0, P * 0.165, 0, Oo), h(0.2 * s), l.beginPath(), l.arc(0, 0, P * 0.963, 0, Oo), h(0.16 * s), l.restore();
    });
  }, g = 1.6, b = 1 / g, v = [];
  for (let [H, F] of [[10.5, 500], [8.6, 800], [7, 1200], [5.6, 2e3], [4.4, 3e3], [3.4, 4500], [2.7, 5e3]]) for (let P = 0; P < F; P++) {
    let z = H * (0.93 + 0.14 * r()) * s, k = r() * o, I = r() * o;
    if (!m(k, I, z * 0.8)) continue;
    let G = 1e9, K = r() * Oo;
    for (let n0 of u) {
      let e0 = n0[0] - k, p0 = n0[1] - I;
      e0 > o / 2 ? e0 -= o : e0 < -o / 2 && (e0 += o), p0 > o / 2 ? p0 -= o : p0 < -o / 2 && (p0 += o);
      let t0 = Math.hypot(e0, p0) - n0[2];
      t0 < G && (G = t0, K = Math.atan2(p0, e0));
    }
    let $ = v.length % 2 ? 1 : -1;
    u.push([k, I, z]), v.push({ x: k, y: I, R0: z, hand: $, a0: K + $ * 2 });
  }
  let y = (H) => {
    let { R0: F, hand: P, a0: z } = H, k = F * 0.8, I = ($) => $ < 0 ? k * (1 - $ * 1.5) : k * (0.9 * Math.pow(1 - $, 0.82) + 0.1);
    return { rad: I, wid: ($) => F * ($ < 0 ? 0.082 * Math.pow(Math.max(0, 1 + $ / 0.2), 0.8) : 0.082 - 0.04 * $), pt: ($) => {
      let n0 = z + P * $ * g * Oo, e0 = I($);
      return [Math.cos(n0) * e0, Math.sin(n0) * e0, n0, e0];
    } };
  };
  for (let H of v) {
    let { wid: F, pt: P } = y(H), z = 84;
    y2(l, o, H.x, H.y, H.R0 * 1.25, () => {
      l.save(), l.translate(H.x, H.y);
      let k = [], I = [];
      for (let K = -17; K <= z; K++) {
        let $ = K / z, n0 = P($), e0 = Math.max(0.2, F($)), p0 = Math.cos(n0[2]), t0 = Math.sin(n0[2]);
        k.push([n0[0] + p0 * e0, n0[1] + t0 * e0]), I.push([n0[0] - p0 * e0, n0[1] - t0 * e0]);
      }
      l.beginPath(), k.forEach((K, $) => $ ? l.lineTo(K[0], K[1]) : l.moveTo(K[0], K[1]));
      for (let K = I.length - 1; K >= 0; K--) l.lineTo(I[K][0], I[K][1]);
      l.closePath(), c(f);
      let G = P(1);
      l.beginPath(), l.arc(G[0], G[1], H.R0 * 0.115, 0, Oo), c(f), l.beginPath();
      for (let K = -6; K < z - 8; K++) {
        let $ = P(K / z);
        K === -6 ? l.moveTo($[0], $[1]) : l.lineTo($[0], $[1]);
      }
      h(0.13 * s), l.restore();
    });
  }
  for (let H of v) {
    let { rad: F, wid: P, pt: z } = y(H), { R0: k, hand: I } = H, G = k < 4.6 * s, K = Math.round((G ? 9 : 13) + k / (1.6 * s));
    y2(l, o, H.x, H.y, k * 1.25, () => {
      l.save(), l.translate(H.x, H.y);
      for (let $ = 0; $ < K; $++) {
        let n0 = -0.06 + ($ + 0.5) / K * 0.92, e0 = z(n0), p0 = P(n0), M0 = (n0 < b ? k * 1.2 : F(n0 - b) - P(n0 - b) * 1.2) - e0[3] - p0;
        if (M0 < k * 0.07) continue;
        let f0 = 0.92, _0 = Math.min(M0 / Math.cos(f0) * 0.98, k * 0.62) * (0.9 + 0.2 * r()), F0 = Math.min(_0 * 0.56, k * 0.3);
        if (l.save(), l.translate(e0[0] + Math.cos(e0[2]) * p0 * 0.7, e0[1] + Math.sin(e0[2]) * p0 * 0.7), l.rotate(e0[2] - I * f0), I > 0 && l.scale(1, -1), l.beginPath(), l.moveTo(0, F0 * 0.28), l.bezierCurveTo(_0 * 0.22, F0 * 0.62, _0 * 0.72, F0 * 0.5, _0, -F0 * 0.28), l.bezierCurveTo(_0 * 0.82, -F0 * 0.2, _0 * 0.6, -F0 * 0.6, _0 * 0.3, -F0 * 0.52), l.bezierCurveTo(_0 * 0.12, -F0 * 0.46, 0, -F0 * 0.3, 0, F0 * 0.28), c(f), _0 > 1.3 * s && (l.beginPath(), l.moveTo(_0 * 0.06, 0), l.quadraticCurveTo(_0 * 0.5, F0 * 0.16, _0 * 0.9, -F0 * 0.2), h(0.12 * s)), _0 > 2.6 * s) for (let m0 = 1; m0 <= 2; m0++) {
          let S0 = 0.22 + m0 * 0.2;
          l.beginPath(), l.moveTo(_0 * S0, F0 * 0.05), l.quadraticCurveTo(_0 * (S0 + 0.1), -F0 * 0.2, _0 * (S0 + 0.05), -F0 * 0.4), h(0.09 * s);
        }
        l.restore();
      }
      l.restore();
    });
  }
  for (let H = 0; H < 4200; H++) {
    let F = r.range(0.36, 0.62) * s, P = r() * o, z = r() * o;
    m(P, z, F + 0.5 * s) && (u.push([P, z, F + 0.4 * s]), y2(l, o, P, z, F + f, () => {
      l.beginPath(), l.arc(P, z, F, 0, Oo), c(0);
    }));
  }
  d = true;
  for (let H of p) x(H[0], H[1], H[2]);
  let M = l.getImageData(0, 0, o, o).data, w = o * o, T = new Float32Array(w);
  for (let H = 0, F = 0; H < w; H++, F += 4) T[H] = M[F] * (1 / 255);
  let S = lA(T, o, 2, 2), E = o >> 1, _ = new Float32Array(E * E);
  for (let H = 0; H < E; H++) for (let F = 0; F < E; F++) {
    let P = H * 2 * o + F * 2;
    _[H * E + F] = (T[P] + T[P + 1] + T[P + o] + T[P + o + 1]) * 0.25;
  }
  let R = df(lA(_, E, 4, 2), E, o), C = ql(o, 801), L = _o(o, 3, 3, 3, 802), A = df(yp(E).S, E, o), O = new Float32Array(w);
  for (let H = 0, F = 0; H < w; H++, F += 4) {
    let P = T[H], z = S[H], k = R[H], I = M[F + 1] * (1 / 255) * P, G = C[H] - 0.5, K = A[H] * 0.45, $ = $o(0.3, 0.92, z) * 0.55 + $o(0.35, 1, k) * 0.45, n0 = 1 - $o(0.12, 0.5, z), e0 = M[F + 2] > 128 ? 1 : 0;
    O[H] = 0.17 * $ - 0.06 * I + n0 * G * (e0 ? 0.035 : 0.085) - 5e-3 * K * P;
    let p0 = 4 * z * (1 - z), t0 = t1(n0 * 0.7 + p0 * 0.3 + I * 0.8), M0 = 0.95 + 0.1 * L[H];
    i[F] = Wl(250 * M0, 146, t0) - G * 26 * n0, i[F + 1] = Wl(203 * M0, 98, t0) - G * 20 * n0, i[F + 2] = Wl(108 * M0, 36, t0) - G * 8 * n0, i[F + 3] = 255;
    let f0 = Wl(0.12 + (L[H] - 0.5) * 0.1 + K * 0.3, 0.5 + G * 0.22, t1(n0 + I * 0.85));
    a[F] = 0, a[F + 1] = f0 * 255, a[F + 2] = 255, a[F + 3] = 255;
  }
  return z1(O, o, 1.2 / (2 * e), n.nrm, 18), { N: o, tile: 0.18, ...n };
}
function eJ(o = 1024) {
  let e = 200 / o, s = Fu(o), { alb: n, orm: i } = s, a = o >> 1, r = e * 2, l = SF(a, 13, 901, 0.9, 20), c = wh(902), h = l.cells, f = new Float32Array(h), u = new Float32Array(h), d = new Float32Array(h), m = new Float32Array(h), p = new Float32Array(h), x = new Float32Array(h), g = new Float32Array(h), b = new Float32Array(h);
  for (let $ = 0; $ < h; $++) {
    let n0 = c() * Oo, e0 = 0.015 + 0.05 * c();
    f[$] = Math.cos(n0) * e0, u[$] = Math.sin(n0) * e0, d[$] = (c() < 0.8 ? 1 : -0.6) * (0.012 + 0.022 * c());
    let p0 = c() * Oo, t0 = 13 + 9 * c();
    m[$] = Math.cos(p0) * t0, p[$] = Math.sin(p0) * t0, x[$] = c() < 0.55 ? 2.4 + 2.6 * c() : 0, g[$] = c() < 0.08 ? 0.16 + 0.2 * c() : 0, b[$] = c();
  }
  let v = new Float32Array(a * a), y = new Float32Array(a * a), M = new Float32Array(a * a), w = new Float32Array(a * a);
  for (let $ = 0; $ < v.length; $++) {
    let n0 = l.id[$], e0 = l.vx[$] * r, p0 = l.vy[$] * r, t0 = e0 - m[n0], M0 = p0 - p[n0], f0 = Math.hypot(t0, M0) + 1e-3, _0 = x[n0] ? Math.sin(f0 * Oo / x[n0]) * 0.2 * Math.exp(-f0 * 0.085) : 0;
    v[$] = f[n0] + e0 * d[n0] + t0 / f0 * _0, y[$] = u[n0] + p0 * d[n0] + M0 / f0 * _0, M[$] = g[n0], w[$] = b[n0];
  }
  let T = df(v, a, o), S = df(y, a, o), E = df(M, a, o), _ = df(w, a, o), R = df(l.edge, a, o), C = df(l.crack, a, o), L = _o(o, 2, 2, 3, 903), A = _o(o, 2, 2, 2, 904), O = _o(o, 9, 9, 2, 905), H = ql(o, 906), F = _o(o, 4, 4, 3, 907), P = new Uint8ClampedArray(o * o * 4), z = new Float32Array(o * o), k = P1(L, 0.22), I = P1(L, 0.75), G = P1(A, 0.01), K = 1 / (P1(A, 0.99) - G);
  for (let $ = 0, n0 = 0; $ < z.length; $++, n0 += 4) {
    let e0 = C[$] * r, p0 = R[$] * r, t0 = H[$] - 0.5, M0 = 0.2 + 0.6 * O[$] * O[$], f0 = 1 - $o(M0 * 0.55, M0 * 1.25, e0), _0 = 1 - $o(M0, M0 + 0.8, e0), F0 = 1 - $o(0, 0.35, p0), m0 = $o(k, I, L[$]), S0 = (1 - $o(M0 * 0.15, M0 * 0.95, e0)) * (0.25 + 0.75 * m0), T0 = e0 < 6 ? Math.exp(-e0 / 0.9) * m0 * 0.12 : 0;
    z[$] = -0.4 * f0 - 0.05 * _0 + 0.012 * F0;
    let j0 = _[$], Z0 = 0.8 + 0.4 * F[$], lt = E[$], H0 = (9 + j0 * 7 + lt * 26) * Z0, Y0 = (9 + j0 * 2 + lt * 25) * Z0, et = (11 - j0 * 3 + lt * 26) * Z0;
    n[n0] = Wl(H0, 30, f0 * 0.6) + t0 * 2, n[n0 + 1] = Wl(Y0, 22, f0 * 0.6) + t0 * 2, n[n0 + 2] = Wl(et, 18, f0 * 0.6) + t0 * 2, n[n0 + 3] = 255, i[n0] = 0, i[n0 + 1] = (0.055 + lt + f0 * 0.6 + F0 * 0.08 + t0 * 0.025) * 255, i[n0 + 2] = 0, i[n0 + 3] = 255, P[n0] = 255 * t1(S0 * 1.2 + T0 * 2.2), P[n0 + 1] = 255 * t1(S0 * S0 * 0.6 + T0 * 0.3), P[n0 + 2] = 255 * t1(S0 * S0 * S0 * 0.2), P[n0 + 3] = t1((A[$] - G) * K) * 255;
    let ct = 1 - f0;
    T[$] *= ct, S[$] *= ct;
  }
  return z1(z, o, 1.2 / (2 * e), s.nrm, 19, T, S), { N: o, tile: 0.2, ...s, emi: P };
}
var RF = { dune: XQ, timberline: YQ, fracture: jQ, tigerstripe: $Q, topo: ZQ, carbon: QQ, damascus: JQ, gold: tJ, obsidian: eJ };
var sJ = {}, hA = { metal: { detail: "spray", dN: 0.26, dR: 0.1, under: 3421242, underRM: [0.42, 0.65], bare: 11119794, bareRM: [0.42, 1], bareK: 0.86, edgeMul: 1, roughAdd: 0, metalMul: 1 }, polymer: { detail: "grain", dN: 0.5, dR: 0.12, under: 2828840, underRM: [0.55, 0], bare: 2828840, bareRM: [0.55, 0], bareK: 0, edgeMul: 0.8, roughAdd: 0.05, metalMul: 0.6 }, furniture: { detail: "stipple", dN: 0.9, dR: 0.14, under: 2039325, underRM: [0.66, 0], bare: 2039325, bareRM: [0.66, 0], bareK: 0, edgeMul: 0.7, roughAdd: 0.09, metalMul: 0.45 } }, R5 = { dune: { span: 0.062, at: [0.5, 0.5], all: { wear: [0.1, 0.34] } }, timberline: { span: 0.15, at: [0.42, 0.5], all: { wear: [0.1, 0.42] } }, fracture: { span: 0.105, at: [0.5, 0.5], all: { wear: [0.1, 0.3] } }, tigerstripe: { span: 0.125, at: [0.5, 0.5], all: { wear: [0.1, 0.34] } }, topo: { span: 0.075, at: [0.5, 0.5], all: { wear: [0.1, 0.3] } }, carbon: { span: 0.036, at: [0.5, 0.5], physical: true, all: { wear: [0, 0], clearcoat: 1, clearcoatRoughness: 0.035, dN: 0, dR: 0, anisotropy: 0.8 }, polymer: { clearcoat: 0.8, clearcoatRoughness: 0.09, dN: 0.16, dR: 0.06, metalMul: 1, roughAdd: 0.04 }, furniture: { clearcoat: 0.5, clearcoatRoughness: 0.2, dN: 0.5, dR: 0.1, metalMul: 1, roughAdd: 0.1 } }, damascus: { span: 0.075, at: [0.5, 0.5], all: { wear: [0.06, 0.3], under: 12172221, underRM: [0.26, 1], bareK: 0 }, metal: { detail: "hairline", dN: 0.12, dR: 0.1 }, polymer: { metalMul: 0.95, roughAdd: 0.05, dN: 0.34 }, furniture: { metalMul: 0.92, roughAdd: 0.09, dN: 0.6 } }, gold: { span: 0.066, at: [0.27, 0.3], all: { wear: [0, 0] }, metal: { detail: "hairline", dN: 0.07, dR: 0.16 }, polymer: { metalMul: 0.97, roughAdd: 0.05, dN: 0.26 }, furniture: { metalMul: 0.95, roughAdd: 0.09, dN: 0.36 } }, obsidian: { span: 0.085, at: [0.5, 0.5], physical: true, emissive: 4.6, all: { wear: [0, 0], ior: 2 }, metal: { detail: "hairline", dN: 0.04, dR: 0.05 }, polymer: { roughAdd: 0.2, dN: 0.12, ior: 1.7 }, furniture: { roughAdd: 0.3, dN: 0.4, ior: 1.6 } } }, PF = (o, t) => ({ ...hA[t], ...R5[o].all || {}, ...R5[o][t] || {} }), fT = /* @__PURE__ */ new Map(), _4 = null;
function fA(o) {
  let t = fT.get(o);
  return t || fT.set(o, t = {}), t;
}
function zF(o) {
  let t = fA(o);
  if (!t.raw) {
    let e = performance.now();
    if (t.raw = RF[o](256), sJ[o] = performance.now() - e, t.N = t.raw.N, t.tile = t.raw.tile, LF(o), !t.tex) {
      if (_4 && _4 !== o) {
        let s = fT.get(_4);
        s && !s.tex && (s.raw = null);
      }
      _4 = o;
    }
  }
  return t.raw;
}
function LF(o) {
  let t = fA(o);
  if (t.crop) return t.crop;
  let e = o === "factory" ? rJ() : zF(o);
  if (t.crop) return t.crop;
  let s = R5[o] || { span: 0.05, at: [0.5, 0.5] }, n = e.N, i = n - 1, a = s.span / e.tile * n, r = Math.max(1, Math.ceil(a / 512)), l = Math.round(a / r), c = Math.round(s.at[0] * n - a / 2), h = Math.round(s.at[1] * n - a / 2), f = 1 / (r * r), u = (d) => {
    if (!d) return null;
    let m = new Uint8ClampedArray(l * l * 4);
    for (let p = 0, x = 0; p < l; p++) for (let g = 0; g < l; g++, x += 4) {
      let b = 0, v = 0, y = 0, M = 0;
      for (let w = 0; w < r; w++) {
        let T = (h + p * r + w & i) * n;
        for (let S = 0; S < r; S++) {
          let E = (T + (c + g * r + S & i)) * 4;
          b += d[E], v += d[E + 1], y += d[E + 2], M += d[E + 3];
        }
      }
      m[x] = b * f, m[x + 1] = v * f, m[x + 2] = y * f, m[x + 3] = M * f;
    }
    return m;
  };
  return t.crop = { n: l, alb: u(e.alb), nrm: u(e.nrm), orm: u(e.orm), emi: u(e.emi) };
}
function nJ(o) {
  let t = fA(o);
  if (t.tex) return t.tex;
  let e = zF(o), s = (n, i) => {
    let a = new THREE.DataTexture(new Uint8Array(n.buffer), e.N, e.N, THREE.RGBAFormat, THREE.UnsignedByteType);
    return a.wrapS = a.wrapT = THREE.RepeatWrapping, a.magFilter = THREE.LinearFilter, a.minFilter = THREE.LinearMipmapLinearFilter, a.generateMipmaps = true, a.anisotropy = 8, a.repeat.set(1 / e.tile, 1 / e.tile), i && (a.colorSpace = THREE.SRGBColorSpace), a.needsUpdate = true, a;
  };
  return t.tex = { map: s(e.alb, true), normalMap: s(e.nrm, false), orm: s(e.orm, false) }, e.emi && (t.tex.emissiveMap = s(e.emi, true)), e.ani && (t.tex.anisotropyMap = s(e.ani, false)), t.raw = null, _4 === o && (_4 = null), t.tex;
}
var oJ = { spray: 0.032, grain: 0.04, stipple: 0.0324, hairline: 0.05, none: 1 }, cA = {};
function iJ(o) {
  if (cA[o]) return cA[o];
  let t = o === "none" ? 2 : 256, e = new Float32Array(t * t), s = new Float32Array(t * t).fill(0.5), n = 1;
  if (o === "spray") {
    let r = ql(t, 31), l = pf(r, t, 1), c = uf(t, 90, 90, 2, 32);
    for (let h = 0; h < e.length; h++) e[h] = (l[h] - 0.5) * 1.3 + (c[h] - 0.5) * 2.2 + (r[h] - 0.5) * 0.22, s[h] = 0.5 + (r[h] - 0.5) * 0.5 + (c[h] - 0.5) * 0.9;
    n = 1;
  } else if (o === "grain") {
    let r = uf(t, 104, 104, 2, 33), l = ql(t, 34);
    for (let c = 0; c < e.length; c++) {
      let h = r[c] * 1.6 - 0.3;
      e[c] = h * h * 2.4 + (l[c] - 0.5) * 0.12, s[c] = 0.5 + (r[c] - 0.5) * 1.2;
    }
    n = 1.25;
  } else if (o === "stipple") {
    let c = t / 36, h = t / 42, f = ql(t, 35);
    for (let u = 0, d = 0; u < t; u++) for (let m = 0; m < t; m++, d++) {
      let p = Math.floor(u / h), x = (m + (p & 1) * c * 0.5) % c / c - 0.5, g = u % h / h - 0.5, b = Math.hypot(x * c, g * h) / (c * 0.44), v = b < 1 ? Math.cos(b * Math.PI * 0.5) : 0;
      e[d] = v * 2.6 + (f[d] - 0.5) * 0.12, s[d] = 0.62 - v * 0.3;
    }
    n = 1;
  } else if (o === "hairline") {
    let r = _5(t), l = wh(36);
    r.globalCompositeOperation = "lighter";
    for (let h = 0; h < 1300; h++) {
      let f = l() * t, u = l() * t, d = l() < 0.5 ? (l() - 0.5) * 0.7 : l() * Oo, m = 20 + l() * l() * 300, p = 0.05 + 0.5 * l() * l() * l();
      r.strokeStyle = `rgba(255,255,255,${p.toFixed(3)})`, r.lineWidth = 0.7 + l() * 0.5, y2(r, t, f, u, m / 2 + 2, () => {
        r.beginPath(), r.moveTo(f - Math.cos(d) * m / 2, u - Math.sin(d) * m / 2), r.lineTo(f + Math.cos(d) * m / 2, u + Math.sin(d) * m / 2), r.stroke();
      });
    }
    let c = S4(r, t, "r")[0];
    for (let h = 0; h < e.length; h++) e[h] = -c[h] * 1.6, s[h] = 0.5 + Math.min(0.5, c[h] * 0.9);
    n = 1;
  }
  let i = new Uint8ClampedArray(t * t * 4);
  z1(e, t, n * 0.5, i, 3);
  for (let r = 0, l = 0; r < s.length; r++, l += 4) i[l + 2] = s[r] * 255, i[l + 3] = 255;
  let a = new THREE.DataTexture(new Uint8Array(i.buffer), t, t, THREE.RGBAFormat, THREE.UnsignedByteType);
  return a.wrapS = a.wrapT = THREE.RepeatWrapping, a.magFilter = THREE.LinearFilter, a.minFilter = THREE.LinearMipmapLinearFilter, a.generateMipmaps = true, a.anisotropy = 4, a.needsUpdate = true, cA[o] = a;
}
var DF = { value: 0 }, AF = /* @__PURE__ */ new Map();
function aJ(o, t, e) {
  o.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, t), s.fragmentShader = s.fragmentShader.replace("#include <common>", `#include <common>
uniform sampler2D uDetailMap; uniform vec3 uDetail; uniform vec3 uWear; uniform vec3 uUnderCol; uniform vec3 uBareCol; uniform vec4 uWearRM; uniform vec2 uRoughMA; uniform float uCamoTime; uniform vec4 uEmber;`).replace("#include <color_fragment>", `
vec4 camoD = texture2D( uDetailMap, vNormalMapUv * uDetail.x );
float camoEdge = 0.0;
float camoWorn = 0.0;
#ifdef USE_COLOR
	camoEdge = step( 1.05, vColor.r );
#endif`).replace("#include <metalnessmap_fragment>", `#include <metalnessmap_fragment>
{
	float cw = texelRoughness.r;
	float lvl = mix( uWear.x, uWear.y, camoEdge );
	float t1 = smoothstep( 0.96 - lvl, 1.03 - lvl, cw ) * step( 0.001, lvl );
	float l2 = lvl * uWear.z;
	float t2 = smoothstep( 0.955 - l2, 1.045 - l2, cw ) * step( 0.001, l2 );
	roughnessFactor = clamp( roughnessFactor * uRoughMA.x + uRoughMA.y + ( camoD.b - 0.5 ) * uDetail.z, 0.03, 1.0 );
	diffuseColor.rgb = mix( diffuseColor.rgb, uUnderCol, t1 );
	roughnessFactor = mix( roughnessFactor, uWearRM.x, t1 ); metalnessFactor = mix( metalnessFactor, uWearRM.y, t1 );
	diffuseColor.rgb = mix( diffuseColor.rgb, uBareCol, t2 );
	roughnessFactor = mix( roughnessFactor, uWearRM.z, t2 ); metalnessFactor = mix( metalnessFactor, uWearRM.w, t2 );
	camoWorn = t1;
}`).replace("#include <normal_fragment_maps>", `
vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
mapN.xy *= normalScale;
mapN.xy += ( camoD.xy * 2.0 - 1.0 ) * uDetail.y * ( 1.0 - 0.7 * camoWorn );
normal = normalize( tbn * mapN );`), e && (s.fragmentShader = s.fragmentShader.replace("#include <emissivemap_fragment>", `
vec4 emissiveColor = texture2D( emissiveMap, vEmissiveMapUv );
float cph = 0.5 + 0.5 * sin( 6.2831853 * ( emissiveColor.a * uEmber.x - uCamoTime * uEmber.y ) );
cph = cph * cph * ( 3.0 - 2.0 * cph );
float cbr = 0.84 + 0.16 * sin( uCamoTime * uEmber.z );
// cooler embers are redder: green and blue fall away first
totalEmissiveRadiance *= emissiveColor.rgb * vec3( 1.0, mix( 0.5, 1.0, cph ), mix( 0.25, 1.0, cph ) ) * mix( uEmber.w, 1.0, cph ) * cbr;`));
  }, o.customProgramCacheKey = () => "gh-camo-2" + (e ? "-ember" : "");
}
function xl(o, t = "metal") {
  if (o === "factory" || !R5[o]) return null;
  hA[t] || (t = "metal");
  let e = o + "|" + t, s = AF.get(e);
  if (s) return s;
  let n = R5[o], i = PF(o, t), a = nJ(o), r = fT.get(o), l = { map: a.map, normalMap: a.normalMap, roughnessMap: a.orm, metalnessMap: a.orm, roughness: 1, metalness: i.metalMul, vertexColors: true, envMapIntensity: 1 };
  a.emissiveMap && (l.emissiveMap = a.emissiveMap, l.emissive = new THREE.Color(16777215), l.emissiveIntensity = n.emissive), n.physical ? (s = new THREE.MeshPhysicalMaterial(l), i.clearcoat != null && (s.clearcoat = i.clearcoat, s.clearcoatRoughness = i.clearcoatRoughness), i.ior != null && (s.ior = i.ior), i.anisotropy && a.anisotropyMap && (s.anisotropy = i.anisotropy, s.anisotropyMap = a.anisotropyMap)) : s = new THREE.MeshStandardMaterial(l);
  let c = { uDetailMap: { value: iJ(i.dN || i.dR ? i.detail : "none") }, uDetail: { value: new THREE.Vector3(r.tile / oJ[i.detail], i.dN, i.dR) }, uWear: { value: new THREE.Vector3(i.wear[0], i.wear[1] * i.edgeMul, i.bareK) }, uUnderCol: { value: new THREE.Color(i.under) }, uBareCol: { value: new THREE.Color(i.bare) }, uWearRM: { value: new THREE.Vector4(i.underRM[0], i.underRM[1], i.bareRM[0], i.bareRM[1]) }, uRoughMA: { value: new THREE.Vector2(1, i.roughAdd) }, uCamoTime: DF, uEmber: { value: new THREE.Vector4(2, 0.07, 0.55, 0.14) } };
  return aJ(s, c, !!a.emissiveMap), s.name = "camo:" + e, s.userData.camo = o, s.userData.part = t, s.userData.tile = r.tile, AF.set(e, s), s;
}
function rJ() {
  let t = new Uint8ClampedArray(262144), e = new Uint8ClampedArray(256 * 256 * 4), s = new Uint8ClampedArray(256 * 256 * 4), n = ql(256, 5), i = uf(256, 4, 4, 4, 6), a = new Float32Array(256 * 256);
  for (let r = 0, l = 0; r < a.length; r++, l += 4) {
    let c = 0.9 + 0.2 * i[r] + (n[r] - 0.5) * 0.08;
    t[l] = 40 * c, t[l + 1] = 41 * c, t[l + 2] = 46 * c, t[l + 3] = 255, s[l] = i[r] * 200, s[l + 1] = (0.42 + (n[r] - 0.5) * 0.08) * 255, s[l + 2] = 0.65 * 255, s[l + 3] = 255, a[r] = n[r] * 0.01;
  }
  return z1(a, 256, 1, e, 4), { N: 256, tile: 0.06, alb: t, nrm: e, orm: s };
}
var uA = new THREE.Vector3(), FF = new THREE.Vector3(), OF = new THREE.Vector3(), cJ = new THREE.Vector3(), uT = new THREE.Vector3();
function Rc(o, t = null) {
  let e = o.index ? o.toNonIndexed() : o, s = e.attributes.position, n = new Float32Array(s.count * 2), i = [uA, FF, OF];
  for (let a = 0; a + 2 < s.count; a += 3) {
    for (let h = 0; h < 3; h++) i[h].fromBufferAttribute(s, a + h), t && i[h].applyMatrix4(t);
    uT.subVectors(FF, uA).cross(cJ.subVectors(OF, uA));
    let r = Math.abs(uT.x), l = Math.abs(uT.y), c = Math.abs(uT.z);
    for (let h = 0; h < 3; h++) {
      let f = i[h], u = (a + h) * 2;
      r >= l && r >= c ? (n[u] = f.z, n[u + 1] = f.y) : l >= c ? (n[u] = f.z, n[u + 1] = f.x) : (n[u] = f.x, n[u + 1] = f.y);
    }
  }
  return e.setAttribute("uv", new THREE.BufferAttribute(n, 2)), e;
}
var hJ = {}, NF = /* @__PURE__ */ new Map();
function dA(o, t) {
  let e = NF.get(o);
  if (!e) {
    let l = performance.now();
    e = t(), NF.set(o, e), hJ[o] = { tris: e.tris, parts: e.parts, ms: performance.now() - l };
  }
  let s = new THREE.Group();
  s.name = "att_" + o, s.userData.keep = true, s.userData.attachment = o;
  let n = (l, c, h, f) => {
    if (!c) return null;
    let u = new THREE.Mesh(c, h);
    return u.name = l, u.castShadow = f, u.receiveShadow = f, s.add(u), u;
  }, i = n("body", e.body, e.bodyMat, true);
  i && (i.userData.paint = e.paint, i.userData.factory = { geometry: e.body, material: e.bodyMat }), n("hardware", e.hard, rF(), true);
  let a = n("marks", e.mark, aT(), false);
  a && (a.renderOrder = 1);
  let r = n("lens", e.lens, e.lensMat, false);
  return r && (r.userData.keep = true, r.renderOrder = e.portal ? -100 : 2), { c: e, group: s };
}
var UF = (o) => new THREE.Vector3(o[0] / 1e3, o[1] / 1e3, -o[2] / 1e3);
function Mp(o, t = {}) {
  let e = { reflex: uF, holo: dF, prism: pF, microdot: mF }[o];
  if (!e) throw new Error("buildOptic: unknown optic " + o);
  let s = o === "prism" && t.portal === false, { c: n, group: i } = dA("optic:" + o + (s ? ":solid" : ""), () => e(!s));
  return { kind: o, group: i, eye: UF(n.eye), height: n.height / 1e3, zoomHint: n.zoom, relief: n.relief / 1e3, window: [n.window[0] / 1e3, n.window[1] / 1e3], bolts: n.bolts.map((a) => -a / 1e3), tris: n.tris };
}
function gf(o, { caliber: t = "rifle" } = {}) {
  let e = { suppressor: gF, comp: xF, brake: bF, choke: yF }[o];
  if (!e) throw new Error("buildMuzzle: unknown muzzle device " + o);
  if (!E4[t]) throw new Error("buildMuzzle: unknown caliber " + t);
  let { c: s, group: n } = dA(`muzzle:${o}:${t}`, () => e(t));
  return { kind: o, caliber: t, group: n, length: s.length / 1e3, radius: s.radius / 1e3, rear: s.rear / 1e3, tris: s.tris };
}
function wp(o, t = {}) {
  let e = { vgrip: wF, angled: EF, laser: TF }[o];
  if (!e) throw new Error("buildUnderbarrel: unknown underbarrel " + o);
  let s = t.mount === "rail" ? "rail" : "mlok", { c: n, group: i } = dA(`under:${o}:${s}`, () => e(s)), a = { kind: o, mount: s, group: i, drop: n.drop / 1e3, tris: n.tris };
  return n.grip && (a.grip = n.grip), n.laser && (a.laser = UF(n.laser), a.laserDir = new THREE.Vector3(0, 0, -1)), a;
}
var BF = /* @__PURE__ */ new Map();
function fJ(o, t) {
  let e = o.uuid + "|" + Array.from(t.elements, (n) => Math.round(n * 1e5)).join(","), s = BF.get(e);
  if (!s) {
    s = new THREE.BufferGeometry();
    for (let n of ["position", "normal", "color"]) s.setAttribute(n, o.attributes[n]);
    s.boundingBox = o.boundingBox, s.boundingSphere = o.boundingSphere, Rc(s, t), BF.set(e, s);
  }
  return s;
}
function uJ(o) {
  let t = null;
  for (let s = o.parent; s; s = s.parent) if (s.name && s.name.startsWith("gun") || s.userData.gunRoot) {
    t = s;
    break;
  }
  let e = new THREE.Matrix4();
  if (!t) return e;
  for (let s = o; s && s !== t; s = s.parent) s.updateMatrix(), e.premultiply(s.matrix);
  return e;
}
function Ou(o, t, e = {}) {
  let s = o && o.isObject3D ? o : o.group, n = e.toGun || uJ(s);
  return s.traverse((i) => {
    if (!i.isMesh || !i.userData.paint) return;
    let a = i.userData.factory, r = t && t !== "factory" ? xl(t, i.userData.paint) : null;
    if (!r) {
      i.geometry = a.geometry, i.material = a.material;
      return;
    }
    i.geometry = fJ(a.geometry, n), i.material = r;
  }), s.userData.camo = t || "factory", o;
}
var Yr = Math.PI / 180, A5 = Math.PI * 2, Ja = false, Sy = (o) => {
  Ja = !!o;
}, sn = () => Ja, WF = new THREE.Quaternion(), VF = new THREE.Euler(), pJ = new THREE.Vector3(), mJ = new THREE.Matrix4(), Nu = new THREE.Vector3(), Bu = new THREE.Vector3(), v2 = new THREE.Vector3(), dT = (o) => o.map((t) => (t[2] || 0) < 2.5 ? [t[0], t[1]] : t), pA = (o) => ({ x: o.x, y: o.y, u: o.u, b: 0, cs: 1, holes: o.keepHoles ? o.holes : null, keepHoles: o.keepHoles }), Pe = (o, t, e = {}) => Ja ? us(dT(o), t, pA(e)) : us(o, t, { b: 0.5, soft: 0.5, cs: 2, ...e }), pa = (o, t, e = {}) => Ja ? si(dT(o), t, pA(e)) : si(o, t, { b: 0.5, soft: 0.5, cs: 2, ...e }), R4 = (o, t, e = {}) => Ja ? jc(dT(o), t, pA(e)) : jc(o, t, { b: 0.5, soft: 0.5, cs: 2, ...e }), mn = (o, t, e, s, n = 0) => [[o, t, n], [e, t, n], [e, s, n], [o, s, n]], Er = (o, t, e = 0, s = 0, n = 0) => [[s - o / 2, n - t / 2, e], [s + o / 2, n - t / 2, e], [s + o / 2, n + t / 2, e], [s - o / 2, n + t / 2, e]], e1 = (o, t, e = 0, s = 0, n = 0) => Array.from({ length: o }, (i, a) => [s + Math.cos(e + a / o * A5) * t, n + Math.sin(e + a / o * A5) * t]);
function Eh(o, t) {
  let e = [], s = [], n = o.length;
  for (let i = 0; i < n; i++) {
    let a = o[Math.max(0, i - 1)], r = o[Math.min(n - 1, i + 1)], l = r[0] - a[0], c = r[1] - a[1], h = Math.hypot(l, c) || 1;
    l /= h, c /= h;
    let f = (o[i][2] ?? t) / 2;
    e.push([o[i][0] - c * f, o[i][1] + l * f]), s.push([o[i][0] + c * f, o[i][1] - l * f]);
  }
  return e.concat(s.reverse());
}
function qF(o, t) {
  let e = o.length;
  if (t <= o[0][0]) return o[0].map((u, d) => d ? u : t);
  if (t >= o[e - 1][0]) return o[e - 1].map((u, d) => d ? u : t);
  let s = 0;
  for (; s < e - 2 && t > o[s + 1][0]; ) s++;
  let n = o[Math.max(0, s - 1)], i = o[s], a = o[s + 1], r = o[Math.min(e - 1, s + 2)], l = a[0] - i[0], c = (t - i[0]) / l, h = c * c, f = h * c;
  return i.map((u, d) => {
    if (d === 0) return t;
    let m = (a[d] - n[d]) / (a[0] - n[0]) * l, p = (r[d] - i[d]) / (r[0] - i[0]) * l;
    return (2 * f - 3 * h + 1) * i[d] + (f - 2 * h + c) * m + (-2 * f + 3 * h) * a[d] + (f - h) * p;
  });
}
function A4(o, t, e, s) {
  return e && (s && o.translate(-s[0], -s[1], s[2]), VF.set(e[0] * Yr, e[1] * Yr, e[2] * Yr, "XYZ"), o.applyQuaternion(WF.setFromEuler(VF)), s && o.translate(s[0], s[1], -s[2])), t && o.translate(t[0], t[1], -t[2]), o;
}
var gJ = { "x+": [1, 0, 0], "x-": [-1, 0, 0], "y+": [0, 1, 0], "y-": [0, -1, 0], "u+": [0, 0, -1], "u-": [0, 0, 1] }, xJ = new THREE.Vector3(0, 0, -1);
function Uu(o, t, e) {
  let s = typeof t == "string" ? gJ[t] : t;
  return o.applyQuaternion(WF.setFromUnitVectors(xJ, pJ.set(s[0], s[1], s[2]).normalize())), e && o.translate(e[0], e[1], -e[2]), o;
}
var bJ = { L: [[-1, 0, 0], [0, 1, 0]], R: [[1, 0, 0], [0, 1, 0]], T: [[0, 1, 0], [0, 0, -1]], B: [[0, 0, 1], [0, 1, 0]], F: [[0, 0, -1], [0, 1, 0]], D: [[0, -1, 0], [0, 0, -1]] };
function cs(o, t, e, s = 0) {
  let [n, i] = typeof e == "string" ? bJ[e] : e;
  return v2.set(n[0], n[1], n[2]).normalize(), Bu.set(i[0], i[1], i[2]), Bu.addScaledVector(v2, -Bu.dot(v2)).normalize(), Nu.crossVectors(Bu, v2), s && o.rotateZ(s * Yr), o.applyMatrix4(mJ.makeBasis(Nu, Bu, v2)), t && o.translate(t[0], t[1], -t[2]), o;
}
var KF = (o, t, e, s = 0) => (o.translate(-s, -e, 0), o.rotateZ(t * Yr), o.translate(s, e, 0), o);
var Ep = class {
  constructor() {
    this.p = [], this.n = [], this.c = [];
  }
  tri(t, e, s, n, i = 1) {
    let a = e[0] - t[0], r = e[1] - t[1], l = e[2] - t[2], c = s[0] - t[0], h = s[1] - t[1], f = s[2] - t[2], u = r * f - l * h, d = l * c - a * f, m = a * h - r * c, p = Math.hypot(u, d, m);
    p < 1e-9 || (this.p.push(t[0], t[1], t[2], e[0], e[1], e[2], s[0], s[1], s[2]), n ? this.n.push(n[0][0], n[0][1], n[0][2], n[1][0], n[1][1], n[1][2], n[2][0], n[2][1], n[2][2]) : (u /= p, d /= p, m /= p, this.n.push(u, d, m, u, d, m, u, d, m)), this.c.push(i, i, i, i, i, i, i, i, i));
  }
  quad(t, e, s, n, i, a = 1) {
    this.tri(t, e, n, i && [i[0], i[1], i[3]], a), this.tri(e, s, n, i && [i[1], i[2], i[3]], a);
  }
  geo() {
    let t = new THREE.BufferGeometry(), e = this.p.length / 3;
    return t.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.p), 3)), t.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(this.n), 3)), t.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(e * 2), 2)), t.setAttribute("color", new THREE.BufferAttribute(new Float32Array(this.c), 3)), t;
  }
};
function uo(o, t = {}) {
  let e = !Ja && t.flute ? t.flute : null, s = e ? e.trap ? [0, 0, 1, 1] : [0, 1] : [0], n = e ? e.n * s.length : Ja ? Math.max(6, (t.seg || 20) >> 1) : t.seg || 20, i = o.length, a = Math.cos((t.crease ?? 32) * Yr), r = t.arc ? t.arc[0] * Yr : 0, l = t.arc ? (t.arc[1] - t.arc[0]) * Yr : A5, c = [];
  for (let p = 0; p < i - 1; p++) {
    let x = o[p + 1][0] - o[p][0], g = o[p + 1][1] - o[p][1], b = Math.hypot(x, g) || 1;
    c.push([-g / b, x / b]);
  }
  let h = new Ep(), f = t.x || 0, u = t.y || 0, d = (p, x) => {
    let g = o[p], b = Math.max(0, g[1] - (e ? (g[3] || 0) * s[x % s.length] : 0)), v = r + x / n * l;
    return [f + b * Math.cos(v), u + b * Math.sin(v), -g[0]];
  }, m = (p, x) => {
    let g = p[0] + x[0], b = p[1] + x[1], v = Math.hypot(g, b) || 1;
    return [g / v, b / v];
  };
  for (let p = 0; p < i - 1; p++) {
    let x = o[p], g = o[p + 1], b = e && ((x[3] || 0) > 0 || (g[3] || 0) > 0), v = c[p], y = c[p];
    p > 0 && c[p - 1][0] * c[p][0] + c[p - 1][1] * c[p][1] > a && (v = m(c[p - 1], c[p])), p < i - 2 && c[p + 1][0] * c[p][0] + c[p + 1][1] * c[p][1] > a && (y = m(c[p + 1], c[p]));
    for (let M = 0; M < n; M++) {
      let w = d(p, M), T = d(p + 1, M), S = d(p + 1, M + 1), E = d(p, M + 1), _ = r + M / n * l, R = r + (M + 1) / n * l, C = g[2] ? 2 : 1, L = null;
      if (b) s[M % s.length] === 0 && s[(M + 1) % s.length] === 0 && (C = 2);
      else if (!t.flat) {
        let A = Math.cos(_), O = Math.sin(_), H = Math.cos(R), F = Math.sin(R);
        L = [[v[1] * A, v[1] * O, -v[0]], [y[1] * A, y[1] * O, -y[0]], [y[1] * H, y[1] * F, -y[0]], [v[1] * H, v[1] * F, -v[0]]];
      }
      h.quad(w, T, S, E, L, C);
    }
  }
  return h.geo();
}
function s1(o, t, e, s = {}) {
  let n = Ja ? 0 : Math.min(s.c ?? 0.3, o * 0.5), i = s.ri || 0, a = [[t, i], [t, o - n], [t + n, o, 1], [e - n, o], [e, o - n, 1], [e, i]];
  return i && a.push([t, i]), uo(n ? a : [[t, i], [t, o], [e, o], [e, i]], { seg: s.seg || 12, x: s.x, y: s.y, crease: 20 });
}
var bl = (o, t, e, s, n = {}) => Uu(s1(o, 0, t, n), e, s);
function yJ(o) {
  let t = 0, e = 0, s = 0, n = o.length;
  for (let a = 0; a < n; a++) {
    let r = o[a], l = o[(a + 1) % n];
    t += (r[1] - l[1]) * (r[2] + l[2]), e += (r[2] - l[2]) * (r[0] + l[0]), s += (r[0] - l[0]) * (r[1] + l[1]);
  }
  v2.set(t, e, s).normalize(), Nu.set(Math.abs(v2.x) < 0.9 ? 1 : 0, Math.abs(v2.x) < 0.9 ? 0 : 1, 0), Nu.addScaledVector(v2, -Nu.dot(v2)).normalize(), Bu.crossVectors(v2, Nu);
  let i = o.map((a) => new THREE.Vector2(a[0] * Nu.x + a[1] * Nu.y + a[2] * Nu.z, a[0] * Bu.x + a[1] * Bu.y + a[2] * Bu.z));
  return THREE.ShapeUtils.triangulateShape(i, []);
}
function k4(o, t = {}) {
  let e = o.length, s = o[0].length, n = [];
  for (let m = 0; m < e - 1; m++) for (let p = 0; p < s; p++) {
    let x = (p + 1) % s, g = o[m][p], b = o[m][x], v = o[m + 1][x], y = o[m + 1][p], M = t.flag ? t.flag(m, p) : 1;
    typeof M == "number" && (M = [M, 1]), n.push([g, b, y, M[0], M[1]], [b, v, y, M[0], M[1]]);
  }
  for (let [m, p] of [[t.capA, o[0]], [t.capB, o[e - 1]]]) {
    if (!m) continue;
    let x = typeof m == "number" ? m : 1;
    for (let g of yJ(p)) n.push([p[g[0]], p[g[1]], p[g[2]], 1, x, true]);
  }
  let i = o.map((m) => {
    let p = [0, 0, 0];
    for (let x of m) p[0] += x[0] / s, p[1] += x[1] / s, p[2] += x[2] / s;
    return p;
  }), a = 0, r = (m) => {
    let p = m[0], x = m[1], g = m[2];
    return [(x[1] - p[1]) * (g[2] - p[2]) - (x[2] - p[2]) * (g[1] - p[1]), (x[2] - p[2]) * (g[0] - p[0]) - (x[0] - p[0]) * (g[2] - p[2]), (x[0] - p[0]) * (g[1] - p[1]) - (x[1] - p[1]) * (g[0] - p[0])];
  }, l = 0;
  for (let m = 0; m < e - 1; m++) for (let p = 0; p < s * 2; p++) {
    let x = n[l++], g = r(x), b = i[m];
    a += g[0] * (x[0][0] - b[0]) + g[1] * (x[0][1] - b[1]) + g[2] * (x[0][2] - b[2]);
  }
  let c = t.inside ? a > 0 : a < 0, h = [i[0][0], i[0][1], i[0][2]];
  e > 1 && (h[0] = (i[0][0] + i[e - 1][0]) / 2, h[1] = (i[0][1] + i[e - 1][1]) / 2, h[2] = (i[0][2] + i[e - 1][2]) / 2);
  let f = [], u = [];
  for (let m of n) {
    let p = m[0], x = m[1], g = m[2];
    if (m[5]) {
      let b = r(m);
      if (b[0] * (p[0] - h[0]) + b[1] * (p[1] - h[1]) + b[2] * (p[2] - h[2]) < 0 != !!t.inside) {
        let y = x;
        x = g, g = y;
      }
    } else if (c) {
      let b = x;
      x = g, g = b;
    }
    f.push(p[0], p[1], p[2], x[0], x[1], x[2], g[0], g[1], g[2]);
    for (let b = 0; b < 3; b++) u.push(m[3], m[4], 0);
  }
  let d = new THREE.BufferGeometry();
  return d.setAttribute("position", new THREE.BufferAttribute(new Float32Array(f), 3)), d.setAttribute("color", new THREE.BufferAttribute(new Float32Array(u), 3)), d = th(d, Ja ? 0.9 : t.crease ?? 0.6), d.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(d.attributes.position.count * 2), 2)), d.userData.aoBaked = true, d;
}
function vJ(o, t = 0.5) {
  if (Ja) return o.map((n) => [n[0], n[1], 0]);
  let e = o.length, s = [];
  for (let n = 0; n < e; n++) {
    let i = o[n], a = o[(n + e - 1) % e], r = o[(n + 1) % e], l = i[2] ?? t;
    if (!(l > 0)) {
      s.push([i[0], i[1], 0]);
      continue;
    }
    let c = Math.hypot(a[0] - i[0], a[1] - i[1]), h = Math.hypot(r[0] - i[0], r[1] - i[1]), f = Math.min(l, c * 0.45), u = Math.min(l, h * 0.45);
    s.push([i[0] + (a[0] - i[0]) * f / c, i[1] + (a[1] - i[1]) * f / c, 2], [i[0] + (r[0] - i[0]) * u / h, i[1] + (r[1] - i[1]) * u / h, 0]);
  }
  return s;
}
function GF(o, t) {
  let e = o.length, s = [], n = 0;
  for (let a = 0; a < e; a++) {
    let r = o[a], l = o[(a + 1) % e];
    n += r[0] * l[1] - l[0] * r[1];
  }
  let i = n > 0 ? 1 : -1;
  for (let a = 0; a < e; a++) {
    let r = o[a], l = o[(a + e - 1) % e], c = o[(a + 1) % e], h = r[0] - l[0], f = r[1] - l[1], u = c[0] - r[0], d = c[1] - r[1], m = Math.hypot(h, f) || 1, p = Math.hypot(u, d) || 1;
    h /= m, f /= m, u /= p, d /= p;
    let x = -(f + d) * i, g = (h + u) * i, b = Math.hypot(x, g) || 1;
    x /= b, g /= b;
    let v = t / Math.max(0.35, -f * i * x + h * i * g);
    s.push([r[0] + x * v, r[1] + g * v, r[2]]);
  }
  return s;
}
function xf(o, t = {}) {
  let e = o.map((r) => ({ u: r.u, pts: r.pts })), s = Ja ? 0 : t.bevA || 0, n = Ja ? 0 : t.bevB || 0;
  if (s) {
    let r = e[0];
    e[0] = { u: r.u + s, pts: r.pts }, e.unshift({ u: r.u, pts: GF(r.pts, s) });
  }
  if (n) {
    let r = e[e.length - 1];
    e[e.length - 1] = { u: r.u - n, pts: r.pts }, e.push({ u: r.u, pts: GF(r.pts, n) });
  }
  let i = e.map((r) => r.pts.map((l) => [l[0], l[1], -r.u])), a = e.length;
  return k4(i, { capA: t.capA, capB: t.capB, crease: t.crease ?? 0.3, inside: t.inside, flag: (r, l) => [s && r === 0 || n && r === a - 2 || e[r].pts[l][2] === 2 || e[r + 1].pts[l][2] === 2 ? 2 : 1, t.ao ? t.ao(r, l, e[r].pts[l]) : 1] });
}
var mA = (o, t, e, s = {}) => {
  let n = vJ(o, s.c ?? 0.5);
  return xf([{ u: t, pts: n }, { u: e, pts: n }], { capA: true, capB: true, bevA: s.b ?? 0.5, bevB: s.b ?? 0.5, ...s });
};
function Th(o, t, e = 0.03) {
  let s = new THREE.PlaneGeometry(o, t);
  return s.translate(0, 0, e), Qe(s);
}
function yl(o, t = 12, e = 0.03) {
  let s = new THREE.CircleGeometry(o, Ja ? 6 : t);
  return s.translate(0, 0, e), Qe(s);
}
function n1(o, t, e = {}) {
  let s = Ja ? bp(dT(o), t, { b: 0, cs: 1 }) : bp(o, t, { b: 0.3, soft: 0.5, cs: 2, ...e });
  return s.translate(0, 0, s.userData.b), Qe(s);
}
var gA = (o, t = 0.6) => th(o, t), xA = (o, t) => (o.userData.ao = (o.userData.ao ?? 1) * t, o), jr = (o) => (o.userData.alt = 1, o);
function C4(o, t) {
  let e = o.attributes.position, s = o.attributes.color, n = o.userData.aoBaked;
  for (let i = 0; i < e.count; i++) s.setY(i, (n ? s.getY(i) : 1) * t(e.getX(i), e.getY(i), -e.getZ(i)));
  return o.userData.aoBaked = true, o;
}
var da = (o) => new THREE.Color(o), MJ = { steel: { c: da(5197645), m: 0.5, r: 0.56, wear: 1.7 }, oxide: { c: da(4342599), m: 0.55, r: 0.4, wear: 1.8 }, bright: { c: da(10724776), m: 1, r: 0.26, wear: 1.15 }, nib: { c: da(9407104), m: 1, r: 0.33, wear: 1.2 }, alu: { c: da(5395289), m: 0.3, r: 0.53, wear: 1.5 }, bronze: { c: da(8021320), m: 0.6, r: 0.4, wear: 1.5 }, black: { c: da(328966), m: 1, r: 1, wear: 1 }, shadow: { c: da(1184533), m: 1, r: 0.85, wear: 1.3 }, rubber: { c: da(4013118), m: 0, r: 0.88, wear: 1.1 }, poly: { c: da(4145220), m: 0, r: 0.56, wear: 1.3 }, fde: { c: da(9205591), m: 0, r: 0.64, wear: 1.2 }, orange: { c: da(12867354), m: 0, r: 0.55, wear: 1.1 }, brass: { c: da(12028735), m: 1, r: 0.3, wear: 1.15 }, copper: { c: da(11889730), m: 1, r: 0.32, wear: 1.1 }, white: { c: da(14079180), m: 0, r: 0.6, wear: 1 }, red: { c: da(11740700), m: 0, r: 0.5, wear: 1 } }, wJ = { metal: da(5395289), poly: da(4145220), furn: da(9205591) }, EJ = { metal: da(4868945), poly: da(9205591), furn: da(9205591) };
function bA(o = {}) {
  let t = { metal: [], poly: [], furn: [], hard: [], mark: [] }, e = !!o.paint, s = (i) => (...a) => {
    for (let r of a.flat()) {
      if (!r) continue;
      r.index && (r = r.toNonIndexed());
      let l = r.attributes.color.array, c = r.userData.ao ?? 1, h = null, f = r.userData.aoBaked;
      if (Ja && !e) {
        let u = (r.userData.alt ? EJ : wJ)[i];
        for (let d = 0; d < l.length; d += 3) {
          let m = c * (f ? l[d + 1] : 1) * (h ? h[d / 3] : 1);
          l[d] = u.r * m, l[d + 1] = u.g * m, l[d + 2] = u.b * m;
        }
        t.hard.push(r);
        continue;
      }
      for (let u = 0; u < l.length; u += 3) l[u] = l[u] > 1.5 ? 2 : 1, l[u + 1] = c * (f ? l[u + 1] : 1) * (h ? h[u / 3] : 1), l[u + 2] = r.userData.alt || 0;
      t[i].push(r);
    }
    return n;
  }, n = { metal: s("metal"), poly: s("poly"), furn: s("furn"), hard(i, ...a) {
    let r = typeof i == "string" ? MJ[i] : i;
    if (!r) throw new Error("kr7: unknown look " + i);
    for (let l of a.flat()) {
      if (!l) continue;
      l.index && (l = l.toNonIndexed());
      let c = l.attributes.color.array, h = c.length / 3, f = l.userData.ao ?? 1, u = null, d = l.userData.aoBaked, m = Ja ? null : new Float32Array(h * 3);
      for (let p = 0; p < h; p++) {
        let x = c[p * 3] > 1.5, g = f * (d ? c[p * 3 + 1] : 1) * (u ? u[p] : 1) * (x && !Ja ? r.wear : 1);
        c[p * 3] = r.c.r * g, c[p * 3 + 1] = r.c.g * g, c[p * 3 + 2] = r.c.b * g, m && (m[p * 3] = r.m, m[p * 3 + 1] = r.r * (x ? 0.86 : 1), m[p * 3 + 2] = x ? 1 : 0);
      }
      m && l.setAttribute("aMR", new THREE.BufferAttribute(m, 3)), t.hard.push(l);
    }
    return n;
  }, mark(...i) {
    if (!Ja) for (let a of i.flat()) a && t.mark.push(a.index ? a.toNonIndexed() : a);
    return n;
  }, empty() {
    return !t.metal.length && !t.poly.length && !t.furn.length && !t.hard.length && !t.mark.length;
  }, finish() {
    let i = { tris: 0 };
    for (let a in t) {
      if (!t[a].length) {
        i[a] = null;
        continue;
      }
      let r = a === "hard" ? Ja ? ["position", "normal", "color"] : ["position", "normal", "uv", "color", "aMR"] : a === "mark" ? ["position", "normal", "uv"] : ["position", "normal", "uv", "color"], l = t[a].map((h) => {
        for (let f of Object.keys(h.attributes)) r.includes(f) || h.deleteAttribute(f);
        for (let f of r) if (!h.attributes[f]) throw new Error(`kr7: ${a} part without ${f}`);
        return h.morphAttributes = {}, h.clearGroups(), h;
      }), c = l.length > 1 ? Vn(l, false) : l[0];
      c.scale(1e-3, 1e-3, 1e-3), a !== "mark" && !(Ja && a === "hard") && (c = Rc(c)), i[a] = c, i.tris += c.attributes.position.count / 3;
    }
    return i;
  } };
  return n;
}
function yA(o) {
  let t = { tris: 0 };
  for (let e of ["metal", "poly", "furn", "hard", "mark"]) {
    let s = o.map((n) => n && n[e]).filter(Boolean);
    t[e] = s.length ? s.length === 1 ? s[0] : Vn(s, false) : null, t[e] && (t.tris += t[e].attributes.position.count / 3);
  }
  return t;
}
var XF = Math.PI / 180, vA = null;
function TJ() {
  let t = _n(7707), e = Re(31), s = new Uint8Array(256 * 256 * 4), n = new Float32Array(256 * 256);
  for (let a = 0; a < 150; a++) {
    let r = e() * 256, l = e() * 256, c = (e() - 0.5) * 0.7 + (e() < 0.75 ? 0 : 1.57), h = 3 + e() * 26, f = Math.cos(c), u = Math.sin(c), d = 0.35 + e() * 0.65;
    for (let m = 0; m < h; m++) {
      let p = ((l | 0) + 256) % 256 * 256 + ((r | 0) + 256) % 256;
      n[p] = Math.max(n[p], d * (1 - Math.abs(m / h - 0.5) * 1.2)), r += f, l += u;
    }
  }
  for (let a = 0; a < 256; a++) for (let r = 0; r < 256; r++) {
    let l = (a * 256 + r) * 4, c = t.fbm(r / 20, a / 20, 4, 256 / 20), h = t.fbm(r / 3.1, a / 3.1, 2, Math.round(256 / 3.1)), f = Math.min(1, c * 0.62 + h * 0.3 + n[a * 256 + r] * 0.55);
    s[l] = f * 255, s[l + 1] = t.fbm(r / 34 + 5, a / 34, 3, 256 / 32) * 255, s[l + 2] = t.fbm(r / 60 + 11, a / 60 + 3, 3, Math.round(256 / 64)) * 255, s[l + 3] = 255;
  }
  let i = new THREE.DataTexture(s, 256, 256, THREE.RGBAFormat, THREE.UnsignedByteType);
  return i.wrapS = i.wrapT = THREE.RepeatWrapping, i.magFilter = THREE.LinearFilter, i.minFilter = THREE.LinearMipmapLinearFilter, i.generateMipmaps = true, i.anisotropy = 4, i.needsUpdate = true, i;
}
var gT = (o, t) => {
  let e = o.clone();
  return e.repeat.set(t, t), e.needsUpdate = true, e;
};
function MA(o, t, e) {
  let s = new THREE.MeshStandardMaterial({ color: t.color, metalness: t.metal, roughness: t.rough, vertexColors: true, normalMap: gT(t.n, t.nRep), roughnessMap: gT(t.r, 14), normalScale: new THREE.Vector2(t.ns, t.ns) }), n = { uWearMap: { value: e }, uWear: { value: new THREE.Vector4(t.wear[0], t.wear[1], t.wear[2], t.wearTile / t.nRep) }, uBareCol: { value: new THREE.Color(t.bare) }, uBareRM: { value: new THREE.Vector2(t.bareRM[0], t.bareRM[1]) }, uAltCol: { value: new THREE.Color(t.alt ?? t.color) }, uAltBare: { value: new THREE.Color(t.altBare ?? t.bare) }, uEdge: { value: new THREE.Vector2(t.edge[0], t.edge[1]) } };
  return s.onBeforeCompile = (i) => {
    Object.assign(i.uniforms, n), i.fragmentShader = i.fragmentShader.replace("#include <common>", `#include <common>
uniform sampler2D uWearMap; uniform vec4 uWear; uniform vec3 uBareCol; uniform vec2 uBareRM; uniform vec3 uAltCol; uniform vec3 uAltBare; uniform vec2 uEdge;`).replace("#include <color_fragment>", `
float krEdge = 0.0; float krAO = 1.0; float krAlt = 0.0;
#ifdef USE_COLOR
	krEdge = smoothstep( 1.05, 1.9, vColor.r ); krAO = clamp( vColor.g, 0.0, 1.0 ); krAlt = clamp( vColor.b, 0.0, 1.0 );
	diffuseColor.rgb = mix( diffuseColor.rgb, uAltCol, krAlt );
#endif`).replace("#include <metalnessmap_fragment>", `#include <metalnessmap_fragment>
{
	vec4 kw = texture2D( uWearMap, vNormalMapUv * uWear.w );
	vec4 kv = texture2D( uWearMap, vNormalMapUv * uWear.w * 0.27 + vec2( 0.37, 0.11 ) );
	float lvl = mix( uWear.x, uWear.y, krEdge );
	float kt = smoothstep( 0.98 - lvl, 1.08 - lvl, kw.r * 0.8 + kv.r * 0.2 ) * step( 0.001, lvl ) * uWear.z;
	// burnished edges: a little lighter and smoother even where the finish has not worn through
	diffuseColor.rgb *= 1.0 + uEdge.x * krEdge;
	roughnessFactor *= 1.0 - uEdge.y * krEdge;
	diffuseColor.rgb *= 0.88 + 0.24 * kv.b;
	roughnessFactor = clamp( roughnessFactor * ( 0.86 + 0.28 * kv.g ), 0.04, 1.0 );
	diffuseColor.rgb = mix( diffuseColor.rgb, mix( uBareCol, uAltBare, krAlt ), kt );
	roughnessFactor = mix( roughnessFactor, uBareRM.x, kt ); metalnessFactor = mix( metalnessFactor, uBareRM.y, kt );
	diffuseColor.rgb *= mix( 0.3, 1.0, krAO );
	roughnessFactor = mix( min( 1.0, roughnessFactor + 0.35 ), roughnessFactor, krAO );
}`);
  }, s.customProgramCacheKey = () => "kr7-body-1", s.name = "kr7:" + o, s.userData = { base: new THREE.Color(t.color), wear: 1, kr: n }, s;
}
function SJ(o, t) {
  let e = new THREE.MeshStandardMaterial({ color: 16777215, metalness: 1, roughness: 1, vertexColors: true, normalMap: gT(o.steel.normalMap, 80), roughnessMap: gT(o.steel.roughnessMap, 14), normalScale: new THREE.Vector2(0.22, 0.22) }), s = { uWearMap: { value: t } };
  return e.onBeforeCompile = (n) => {
    Object.assign(n.uniforms, s), n.vertexShader = n.vertexShader.replace("#include <common>", `#include <common>
attribute vec3 aMR;
varying vec3 vMR;`).replace("#include <begin_vertex>", `#include <begin_vertex>
vMR = aMR;`), n.fragmentShader = n.fragmentShader.replace("#include <common>", `#include <common>
varying vec3 vMR;
uniform sampler2D uWearMap;`).replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
vec4 kv = texture2D( uWearMap, vNormalMapUv * 0.045 + vec2( 0.2, 0.6 ) );
roughnessFactor = clamp( roughnessFactor * vMR.y * ( 0.88 + 0.26 * kv.g ), 0.04, 1.0 );
diffuseColor.rgb *= 0.9 + 0.2 * kv.b;`).replace("#include <metalnessmap_fragment>", `#include <metalnessmap_fragment>
metalnessFactor = vMR.x;`);
  }, e.customProgramCacheKey = () => "kr7-hard-1", e.name = "kr7:hardware", e.userData = { base: new THREE.Color(3881786), wear: 1 }, e;
}
var pT = "#c9ccd1", $r = "#ecebe4", k5 = "#d6432e", mT = "#8d9096";
function _J() {
  let e = we(2048, 1024), s = e.getContext("2d"), n = {};
  s.textBaseline = "middle";
  let i = (p, x = 600) => `${x} ${p}px Bahnschrift, "DIN Alternate", "Segoe UI", Arial, sans-serif`, a = 0, r = 0, l = 0, c = (p, x, g, b) => {
    a + x > 2048 && (a = 0, r += l + 6, l = 0), s.save(), s.translate(a, r), s.beginPath(), s.rect(0, 0, x, g), s.clip(), s.fillStyle = pT, s.strokeStyle = pT, s.lineWidth = 3, s.textAlign = "left", b(x, g), s.restore(), n[p] = [a / 2048, 1 - (r + g) / 1024, (a + x) / 2048, 1 - r / 1024, x / g], a += x + 6, l = Math.max(l, g);
  }, h = (p, x, g, b, v, y, M = 0) => {
    if (s.font = i(x, v), y && (s.fillStyle = y), !M) {
      s.fillText(p, g, b);
      return;
    }
    let w = g;
    for (let T of p) s.fillText(T, w, b), w += s.measureText(T).width + M;
  }, f = (p, x, g, b = pT) => {
    s.save(), s.strokeStyle = b, s.fillStyle = b, s.lineWidth = Math.max(2, g * 0.11), s.beginPath(), s.arc(p, x, g, 0, 6.2832), s.stroke(), s.beginPath(), s.arc(p, x + g * 0.12, g * 0.44, Math.PI, 0), s.closePath(), s.fill();
    for (let v = 0; v < 5; v++) {
      let y = Math.PI + (v + 0.5) / 5 * Math.PI;
      s.beginPath(), s.moveTo(p + Math.cos(y) * g * 0.56, x + g * 0.12 + Math.sin(y) * g * 0.56), s.lineTo(p + Math.cos(y) * g * 0.82, x + g * 0.12 + Math.sin(y) * g * 0.82), s.stroke();
    }
    s.fillRect(p - g * 0.66, x + g * 0.3, g * 1.32, g * 0.11), s.fillRect(p - g * 0.46, x + g * 0.52, g * 0.92, g * 0.1), s.restore();
  }, u = (p, x, g, b, v = true) => {
    let y = g * 0.3;
    s.save(), s.fillStyle = b, s.strokeStyle = b, s.lineWidth = 4, s.beginPath(), s.moveTo(p - y / 2, x + g / 2), s.lineTo(p - y / 2, x - g * 0.12), s.quadraticCurveTo(p - y / 2, x - g * 0.36, p, x - g / 2), s.quadraticCurveTo(p + y / 2, x - g * 0.36, p + y / 2, x - g * 0.12), s.lineTo(p + y / 2, x + g / 2), s.closePath(), v ? s.fill() : s.stroke(), s.restore();
  };
  c("kr7", 760, 300, () => {
    f(84, 92, 62), h("KR-7", 150, 176, 84, 700), s.lineWidth = 5, s.strokeRect(574, 34, 168, 78), h("MK II", 46, 596, 76, 700), h("CAL 5.56\xD745 NATO", 50, 16, 206, 600, null, 2), h("GH-ARMS  \xB7  SOLSTICE CITY", 36, 18, 266, 500, mT, 1.5);
  }), c("sn", 420, 56, () => {
    h("SN GH07731", 46, 6, 30, 600, null, 3);
  }), c("safe", 110, 110, () => {
    s.strokeStyle = $r, s.lineWidth = 6, s.strokeRect(8, 8, 94, 94), u(55, 55, 66, $r), s.strokeStyle = $r, s.lineWidth = 8, s.beginPath(), s.moveTo(20, 90), s.lineTo(90, 20), s.stroke();
  }), c("semi", 110, 110, () => {
    s.strokeStyle = k5, s.lineWidth = 6, s.strokeRect(8, 8, 94, 94), u(55, 55, 66, k5);
  }), c("auto", 110, 110, () => {
    s.strokeStyle = k5, s.lineWidth = 6, s.strokeRect(8, 8, 94, 94);
    for (let p of [-24, 0, 24]) u(55 + p, 55, 62, k5);
  }), c("dm", 260, 110, () => {
    let p = Re(77), x = 14, g = 7;
    s.fillStyle = pT;
    for (let b = 0; b < x; b++) for (let v = 0; v < x; v++) (v === 0 || b === x - 1 || b === 0 && v % 2 === 0 || v === x - 1 && b % 2 === 1 || v > 0 && b > 0 && b < x - 1 && v < x - 1 && p() < 0.5) && s.fillRect(6 + v * g, 6 + b * g, g, g);
    h("UID", 30, 116, 26, 700), h("1005-GH-07731", 22, 116, 60, 500), h("MFR 7GH42", 22, 116, 88, 500, mT);
  }), c("warn", 760, 44, () => {
    h("WARNING \u2014 REFER TO OPERATOR MANUAL BEFORE USE", 30, 4, 24, 500, null, 1);
  }), c("proof", 150, 60, () => {
    s.lineWidth = 4, s.beginPath();
    for (let p = 0; p < 10; p++) {
      let x = p / 10 * 6.2832 - 1.5708, g = p % 2 ? 9 : 22;
      s[p ? "lineTo" : "moveTo"](30 + Math.cos(x) * g, 30 + Math.sin(x) * g);
    }
    s.closePath(), s.stroke(), h("NP", 34, 62, 32, 700), s.strokeRect(112, 12, 30, 36);
  }), c("brl", 620, 44, () => {
    h("5.56 NATO  1/7  CHF  GH 11\xB726", 32, 4, 24, 600, null, 2);
  }), c("hg", 520, 44, () => {
    h("KR-7 MLR\xB710   M-LOK", 32, 4, 24, 600, null, 2);
  }), c("torque", 300, 40, () => {
    h("35 IN\xB7LB  \u27F3", 28, 4, 22, 600, mT, 1);
  }), c("gas", 230, 60, () => {
    h("S", 40, 14, 32, 700, $r), h("N", 40, 98, 32, 700, $r), h("A", 40, 182, 32, 700, k5);
  }), c("mag30", 420, 150, () => {
    f(46, 48, 34), h("KR\xB7MAG", 62, 98, 46, 700), h("30 RD  5.56\xD745", 40, 8, 116, 600, null, 1.5);
  }), c("mag45", 420, 150, () => {
    f(46, 48, 34), h("KR\xB7MAG", 62, 98, 46, 700), h("45 RD  5.56\xD745", 40, 8, 116, 600, null, 1.5);
  }), c("speed", 420, 70, () => {
    h("SPEED\xB7PLATE", 54, 6, 38, 700, $r, 2);
  }), c("pane", 96, 256, (p, x) => {
    s.fillStyle = "rgba(14,16,20,0.36)", s.fillRect(0, 0, p, x);
    let g = s.createLinearGradient(0, 0, p, 0);
    g.addColorStop(0, "rgba(8,9,12,0.34)"), g.addColorStop(0.3, "rgba(8,9,12,0)"), g.addColorStop(0.72, "rgba(8,9,12,0)"), g.addColorStop(1, "rgba(8,9,12,0.3)"), s.fillStyle = g, s.fillRect(0, 0, p, x);
    let b = s.createLinearGradient(0, 0, p, x * 0.5);
    b.addColorStop(0.36, "rgba(205,215,230,0)"), b.addColorStop(0.47, "rgba(205,215,230,0.13)"), b.addColorStop(0.55, "rgba(205,215,230,0)"), s.fillStyle = b, s.fillRect(0, 0, p, x), s.strokeStyle = "rgba(215,222,232,0.2)", s.lineWidth = 1.2, s.beginPath(), s.moveTo(22, 40), s.lineTo(58, 150), s.moveTo(64, 96), s.lineTo(80, 232), s.stroke();
  }), c("stockn", 420, 56, () => {
    for (let p = 0; p < 6; p++) h(String(p + 1), 40, 14 + p * 68, 30, 700, $r);
  }), c("roundel", 150, 150, () => {
    f(75, 75, 62);
  }), c("gh", 300, 80, () => {
    h("GH-ARMS", 60, 6, 42, 700, null, 3);
  }), c("arrow", 60, 60, () => {
    s.fillStyle = $r, s.beginPath(), s.moveTo(30, 6), s.lineTo(54, 52), s.lineTo(6, 52), s.closePath(), s.fill();
  }), c("rdot", 60, 60, () => {
    s.fillStyle = k5, s.beginPath(), s.arc(30, 30, 24, 0, 6.2832), s.fill();
  }), c("wdot", 60, 60, () => {
    s.fillStyle = $r, s.beginPath(), s.arc(30, 30, 24, 0, 6.2832), s.fill();
  }), c("wline", 60, 60, () => {
    s.fillStyle = $r, s.fillRect(0, 0, 60, 60);
  }), c("rline", 60, 60, () => {
    s.fillStyle = k5, s.fillRect(0, 0, 60, 60);
  }), c("up", 190, 56, () => {
    h("UP", 40, 6, 30, 700, $r), s.strokeStyle = $r, s.lineWidth = 5, s.beginPath(), s.arc(120, 30, 18, Math.PI * 0.9, Math.PI * 1.95), s.stroke(), s.fillStyle = $r, s.beginPath(), s.moveTo(140, 22), s.lineTo(148, 36), s.lineTo(130, 34), s.closePath(), s.fill();
  }), c("lr", 150, 56, () => {
    h("L", 40, 6, 30, 700, $r), h("R", 40, 116, 30, 700, $r), s.strokeStyle = $r, s.lineWidth = 5, s.beginPath(), s.moveTo(40, 30), s.lineTo(104, 30), s.stroke();
  }), c("zero", 240, 44, () => {
    h("200 \xB7 300 \xB7 400", 30, 4, 24, 600, $r, 1);
  }), c("push", 190, 44, () => {
    h("PUSH", 34, 6, 24, 700, mT, 3);
  });
  for (let p = 2; p <= 44; p += 2) c("t" + p, p < 10 ? 34 : 54, 44, () => {
    h(String(p), 40, 3, 24, 700, $r);
  });
  let d = makeCanvasTexture(e);
  d.anisotropy = 8, d.colorSpace = THREE.SRGBColorSpace;
  let m = new THREE.MeshStandardMaterial({ map: d, color: 16777215, transparent: true, roughness: 0.6, metalness: 0.1, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  return m.name = "kr7:marks", m.userData = { base: new THREE.Color(6974576), wear: 1, cells: n }, m;
}
function P4() {
  if (vA) return vA;
  let o = ao(), t = TJ(), e = globalThis.GH_TUNE || {}, s = (r, l) => e[r] != null ? e[r] : l, n = { metal: MA("anodised", { color: s("cMetal", 5395289), metal: s("mMetal", 0.3), rough: s("rMetal", 0.4), n: o.alu.normalMap, r: o.alu.roughnessMap, nRep: 90, ns: 0.3, wear: [s("wFlat", 0.025), s("wEdge", 0.31), 0.8], edge: [0.55, 0.22], wearTile: 16, bare: 9409175, bareRM: [0.4, 1], alt: s("cMetal2", 4868945) }, t), poly: MA("polymer", { color: s("cPoly", 4145220), metal: 0, rough: s("rPoly", 0.52), n: o.poly.normalMap, r: o.poly.roughnessMap, nRep: 60, ns: 0.3, wear: [0.015, 0.2, 0.7], edge: [0.3, 0.18], wearTile: 13, bare: 6711147, bareRM: [0.42, 0], alt: s("cFde", 9205591), altBare: 11245690 }, t), furn: MA("furniture", { color: s("cFurn", 9205591), metal: 0, rough: s("rFurn", 0.68), n: o.gripFDE.normalMap, r: o.gripFDE.roughnessMap, nRep: 34, ns: 0.9, wear: [0.015, 0.18, 0.7], edge: [0.25, 0.15], wearTile: 13, bare: 11245690, bareRM: [0.5, 0] }, t), hard: SJ(o, t), mark: _J(), world: new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.42, roughness: 0.56 }) };
  n.world.name = "kr7:world", n.world.userData = { base: new THREE.Color(3421755), wear: 1 };
  let i = n.studio = { ...n }, a = (r, l, c, h, f) => {
    let u = r.clone();
    return u.color.setHex(l), f != null && (u.metalness = f), u.userData = { ...r.userData, kr: { ...r.userData.kr, uAltCol: { value: new THREE.Color(c) }, uAltBare: { value: new THREE.Color(h) } } }, u.onBeforeCompile = (d) => {
      r.onBeforeCompile(d), Object.assign(d.uniforms, u.userData.kr);
    }, u.customProgramCacheKey = r.customProgramCacheKey, u;
  };
  return i.metal = a(n.metal, 3685185, 3356220, 10330278, 0.74), i.poly = a(n.poly, 2368550, 6182983, 8747368), i.furn = a(n.furn, 6182983, 6182983, 9667178), i.hard = n.hard.clone(), i.hard.color.setScalar(0.6), i.hard.onBeforeCompile = n.hard.onBeforeCompile, i.hard.customProgramCacheKey = n.hard.customProgramCacheKey, i.hard.userData = n.hard.userData, vA = n;
}
function tr(o, t, e) {
  let s = P4().mark.userData.cells[o];
  if (!s) throw new Error("kr7: unknown label " + o);
  e || (e = t / s[4]);
  let n = new THREE.PlaneGeometry(t, e), i = n.attributes.uv;
  for (let a = 0; a < i.count; a++) i.setXY(a, s[0] + i.getX(a) * (s[2] - s[0]), s[1] + i.getY(a) * (s[3] - s[1]));
  return n.translate(0, 0, 0.05), Qe(n);
}
function YF(o, t, e, s = {}) {
  let n = P4().mark.userData.cells[o];
  if (!n) throw new Error("kr7: unknown label " + o);
  let i = s.h || e / n[4], a = (s.phi ?? 180) * XF, r = s.u || 0, l = s.x || 0, c = s.y || 0, h = t + 0.05, f = new Ep(), u = [], d = Math.max(2, Math.ceil(i / t / (10 * XF))), m = Math.cos(a) < -1e-6 ? 1 : -1;
  for (let x = 0; x < d; x++) {
    let g = [];
    for (let [b, v] of [[0, x / d], [1, x / d], [1, (x + 1) / d], [0, (x + 1) / d]]) {
      let y = a - m * (v - 0.5) * i / t, M = -r + m * (b - 0.5) * e;
      g.push({ p: [l + h * Math.cos(y), c + h * Math.sin(y), M], n: [Math.cos(y), Math.sin(y), 0], t: [n[0] + b * (n[2] - n[0]), n[1] + v * (n[3] - n[1])] });
    }
    for (let [b, v, y] of [[g[0], g[1], g[2]], [g[0], g[2], g[3]]]) {
      let M = v.p[0] - b.p[0], w = v.p[1] - b.p[1], T = v.p[2] - b.p[2], S = y.p[0] - b.p[0], E = y.p[1] - b.p[1], _ = y.p[2] - b.p[2];
      (w * _ - T * E) * b.n[0] + (T * S - M * _) * b.n[1] > 0 ? (f.tri(b.p, v.p, y.p, [b.n, v.n, y.n]), u.push(...b.t, ...v.t, ...y.t)) : (f.tri(b.p, y.p, v.p, [b.n, y.n, v.n]), u.push(...b.t, ...y.t, ...v.t));
    }
  }
  let p = f.geo();
  return p.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(u), 2)), p;
}
var Ms = { B: 46, DECK: 24, TOP: 67, RT: 77, HG0: 163, HG1: 432, HGW: 19.5, CROWN: 452, FH: 50, RIB0: 163.23, PITCH: 10, RIB: 4.77, SIGHT: 35, TUBE: 14.8 }, P5 = (o) => Ms.RIB0 - 2.615 - Ms.PITCH * o;
function QF(o) {
  let t = o.slice().reverse().map(([e, s]) => [-e, s, 0]);
  for (let e = 0; e < o.length; e++) o[e][2] === 2 && (t[o.length - 2 - e][2] = 2);
  return o.map((e) => [e[0], e[1], e[2] || 0]).concat(t);
}
var RJ = [[15.2, 24], [15.2, 26], [16, 26.8], [16, 59.15, 2], [15.75, 59.75], [10.8, 64.7], [10.8, Ms.TOP]], AJ = [[15.2, 24], [15.2, 26], [16, 26.8], [16, 51.65, 2], [15.75, 52.25], [11.5, 57.5], [10.8, 58.5]], _A = QF(RJ), RA = [[11, -19.5], [19.5, -11], [19.5, 9], [9, 19.5], [-9, 19.5], [-19.5, 9], [-19.5, -11], [-11, -19.5]], AA = [[-48, 13, 4], [-18, 4, 6], [-4, -7, 4], [34, -7, 1.5], [40, -12, 1.5], [86, -12], [88, 14], [-34, 14], [-34, 38], [-48, 38]], kA = [[-34, 24], [176, 24], [178, 12, 2], [171.5, 5, 3], [158, 5], [150, 13], [-30, 13], [-34, 16]], C5 = (o) => -38 - (o - 88) * 0.11, bT = [[86, 22], [160, 22], [160, 4], [157.6, C5(157.6)], [87.4, C5(87.4)], [86, -12]], CA = [[31.5, -20.6], [35.5, -26.5], [43, -37.5], [51, -42.8], [76, -43.6], [87.5, -36]], PA = [[61, -7], [58.8, -15], [57.4, -22], [57.6, -29], [59.8, -34.5]], oi = { c0: [14.5, -8], ax: [-0.2924, -0.9563], keys: [[-8, 1.5, 22.5, 12.3, 3.2], [6, 2.25, 23.25, 14.6, 3], [22, 0.6, 20.2, 15.9, 3.1], [44, 0, 20.5, 16.4, 3.5], [66, -0.1, 20.7, 15.9, 3.5], [80, 0.25, 21.6, 15.5, 2.8], [88, 0.5, 22.3, 15.7, 3]], s0: -8, s1: 88 }, jF = false, _y = (o) => {
  if (!jF) {
    jF = true;
    let t = (globalThis.GH_TUNE && globalThis.GH_TUNE.heel) ?? 4;
    for (let [e, s] of [[4, 0.5], [5, 0.85], [6, 1]]) oi.keys[e][1] -= t * s, oi.keys[e][2] += t * s;
  }
  return qF(oi.keys, o);
}, z4 = null, kJ = () => {
  if (z4) return z4;
  let o = globalThis.GH_TUNE || {}, t = o.swell ?? 1;
  return z4 = [[2, -0.5, 10, 0.45, (o.sw1 ?? 3.6) * t], [22, -0.35, 11, 0.4, (o.sw2 ?? 2.2) * t], [42, -0.6, 11, 0.4, (o.sw3 ?? 0.4) * t], [o.sw4p ?? 60, o.sw4q ?? -1, o.sw4s ?? 12, o.sw4c ?? 0.35, (o.sw4 ?? 0) * t]], z4.g0 = o.swg0 ?? 0.05, z4.g1 = o.swg1 ?? 0.3, z4;
}, EA = (o, t) => {
  let e = 0, s = kJ(), n = Math.min(1, Math.max(0, (s.g0 - o) / s.g1));
  if (n <= 0) return 1;
  for (let i of s) {
    let a = (t - i[0]) / i[2], r = (o - i[1]) / i[3];
    e += i[4] * Math.exp(-a * a - (r > 0 ? r * r : 0));
  }
  return 1 + e * n * n * (3 - 2 * n) / 16 * Math.min(1, Math.max(0, (t + 8) / 5)) * Math.min(1, Math.max(0, (88 - t) / 10));
};
var _h = { std: { len: 113.4, rounds: 30, pad: 6.5 }, ext: { len: 176, rounds: 45, pad: 6.5 }, fast: { len: 113.4, rounds: 30, pad: 15 } }, yf = 419, er = 31.25, L4 = 121.25, $F = 12, CJ = 22.4, Vi = (o, t) => {
  let e = o / yf;
  return [L4 + yf * (1 - Math.cos(e)) + t * Math.cos(e), -46 - yf * Math.sin(e) + t * Math.sin(e)];
}, yT = (o, t) => Vi(o, t);
function zA(o) {
  let t = _h[o], e = sn() ? 3 : Math.max(5, Math.round(t.len / 19)), s = [[L4 + er, $F], [L4 + er, -46]];
  for (let n = 1; n <= e; n++) s.push(Vi(t.len * n / e, er));
  for (let n = e; n >= 1; n--) s.push(Vi(t.len * n / e, -er));
  return s.push([L4 - er, -46], [L4 - er, $F]), s;
}
function LA(o) {
  let t = _h[o], e = o === "fast";
  return [Vi(t.len - 1.5, er + 2.4), Vi(t.len + t.pad, er + (e ? 4.5 : 2.6)), Vi(t.len + t.pad, -er - (e ? 3.5 : 2.2)), Vi(t.len - 1.5, -er - 2)];
}
function DA(o) {
  let t = _h[o], e = [], s = [];
  for (let n = 4; n < t.len - 4; n += 12) e.push(Vi(n, er + 0.9)), s.push(Vi(n, -er - 0.7));
  return e.push(Vi(t.len - 4, er + 0.9)), s.push(Vi(t.len - 4, -er - 0.7)), { front: Eh(e, 2.6), fw: 9.5, rear: Eh(s, 2.2), rw: 7 };
}
function vT(o) {
  let t = _h[o], e = t.len + t.pad, s = e / yf;
  return { p: Vi(e, 0), down: [Math.sin(s), -Math.cos(s)], len: e, hw: o === "fast" ? 14.5 : 13.2 };
}
function TA(o, t, e, s, n = {}) {
  let i = Ms.RT, a = i - 3, r = n.alt ? (h) => o.metal(jr(h)) : (h) => o.metal(h);
  if (sn()) {
    let h = [[t, s], [t, a]];
    for (let f = Math.ceil((t + 0.6 - Ms.RIB0) / Ms.PITCH); Ms.RIB0 + f * Ms.PITCH + Ms.RIB <= e - 0.4; f++) {
      let u = Ms.RIB0 + f * Ms.PITCH;
      h.push([u, a], [u, i], [u + Ms.RIB, i], [u + Ms.RIB, a]);
    }
    h.push([e, a], [e, s]), r(Pe(h, 19.4));
    return;
  }
  let l = [[-8.2, s], [8.2, s], [8.2, a - 1.9], [10.1, a], [-10.1, a], [-8.2, a - 1.9]];
  r(xf([{ u: t, pts: l }, { u: e, pts: l }], { capA: true, capB: true, bevA: n.bevA ?? 0.5, bevB: n.bevB ?? 0.5 }));
  let c = [[-10.1, a], [10.1, a], [10.35, a + 0.25], [7.6, i], [-7.6, i], [-10.35, a + 0.25]];
  for (let h = Math.ceil((t + 0.6 - Ms.RIB0) / Ms.PITCH); Ms.RIB0 + h * Ms.PITCH + Ms.RIB <= e - 0.4; h++) {
    let f = Ms.RIB0 + h * Ms.PITCH;
    r(xf([{ u: f, pts: c }, { u: f + Ms.RIB, pts: c }], { capA: true, capB: true, bevA: 0.35, bevB: 0.35 }));
  }
}
function tO(o, t, e, s) {
  let n = s;
  for (let i = 60; i >= -40; i--) {
    let a = P5(i);
    a < t + 3 || a > e - 3 || i & 1 || (n <= 44 && o.mark(cs(tr("t" + n, n < 10 ? 2.2 : 3.4, 2.9), [0, Ms.RT - 3, a], "T", 90)), n += 2);
  }
}
var wn = { u0: 58, u1: 130, y0: 39, y1: 57.5, r: 13.2 };
function IA(o) {
  let t = _A, e = QF(AJ);
  if (o.metal(xf([{ u: -34, pts: e }, { u: -15, pts: t }, { u: wn.u0, pts: t }], { capA: true, capB: 0.3, bevA: 0.6 })), sn()) o.metal(xf([{ u: wn.u0, pts: t }, { u: wn.u1, pts: t }], {})), o.hard("black", cs(Th(wn.u1 - wn.u0, wn.y1 - wn.y0, 0.25), [16, (wn.y0 + wn.y1) / 2, (wn.u0 + wn.u1) / 2], "R")), o.hard("nib", cs(Th(wn.u1 - wn.u0 - 8, 9, 0.4), [16, Ms.B + 2, (wn.u0 + wn.u1) / 2 - 2], "R"));
  else {
    let a = Math.asin((wn.y0 - Ms.B) / wn.r), r = Math.asin((wn.y1 - Ms.B) / wn.r) - A5, l = 22, c = [[15.2, 24, 0], [15.2, 26, 0], [16, 26.8, 0], [16, wn.y0, 0]];
    for (let h = 0; h <= l; h++) {
      let f = a + (r - a) * h / l;
      c.push([Math.cos(f) * wn.r, Ms.B + Math.sin(f) * wn.r, 9]);
    }
    c.push([16, wn.y1, 0], ...t.slice(3)), o.metal(xf([{ u: wn.u0, pts: c }, { u: wn.u1, pts: c }], { ao: (h, f, u) => u[2] === 9 ? 0.32 : 1, crease: 0.35 }));
  }
  o.metal(xf([{ u: wn.u1, pts: t }, { u: 160, pts: t }], { capA: 0.3, capB: true, bevB: 0.6 }));
  let s = [[-30, 30, 1], [156, 30, 1.5], [156, 58.4, 1.5], [-14.5, 58.4, 1], [-30, 51.8, 1]], n = [[-6, 36.5, 1.5], [84, 36.5, 1.5], [90, 42.5, 1.5], [90, 54, 1.5], [1, 54, 1.5], [-6, 47, 1.5]], i = [[124, 36.5, 1.5], [150, 36.5, 1.5], [150, 54, 1.5], [124, 54, 1.5]];
  if (o.metal(Pe(s, 1.2, { x: -16.6, b: 0.4, holes: [n, i] })), o.metal(Pe(s, 1.2, { x: 16.6, b: 0.4, holes: [mn(wn.u0 + 1.6, wn.y0 + 0.5, wn.u1 - 1.6, wn.y1 - 0.5, 2.2), [[-8, 36.5, 1.5], [30, 36.5, 1.5], [30, 46, 1.5], [22, 54, 1.5], [-8, 54, 1.5]]] })), sn() || (o.metal(mA([[-10.8, Ms.TOP - 0.1], [10.8, Ms.TOP - 0.1], [9.6, Ms.TOP + 2.2], [-9.6, Ms.TOP + 2.2]], -15, -11.4, { c: 0.3, b: 0.3 })), o.mark(cs(tr("proof", 7.5), [-16.02, 45.5, 137], "L"), cs(tr("warn", 40), [17.22, 33.4, 96], "R"))), o.metal(R4([[16.4, 31], [16.4, 57.5], [23, 54.5, 1.5], [23, 49.5, 1.5]], 17.5, { y: 40.5, b: 1 })), o.hard("steel", s1(1.5, wn.u0 - 3, wn.u1 + 3, { x: Tp.x, y: Tp.y, seg: 8 })), !sn()) for (let a of [wn.u0 - 3.4, wn.u1 + 2.2]) o.hard("steel", s1(2.1, a, a + 1.2, { x: Tp.x, y: Tp.y, seg: 8 }));
  sn() && HA(o), TA(o, -11.5, 158, Ms.TOP), sn() || tO(o, -11.5, 158, 2);
}
var Tp = { x: 17.9, y: wn.y0 - 1.3, u: (wn.u0 + wn.u1) / 2 };
function HA(o) {
  let t = [Pe(mn(wn.u0 + 0.5, 19.2, wn.u1 - 0.5, 36.4, 2), 1.3, { x: 0, b: 0.4 })];
  sn() || t.push(Pe(mn(wn.u0 + 5, 22.4, wn.u1 - 5, 33.4, 1.5), 0.7, { x: 0.9, b: 0.3 }), Pe(mn(91, 19.6, 97, 22.6, 0.8), 2.2, { x: 0.4, b: 0.3 }));
  for (let e of t) o.metal(A4(e, [18.3, 0, 0], [0, 0, 7], [0, 37.7, 0]));
}
function eO(o) {
  let t = Ms.B;
  if (!sn()) {
    o.hard("nib", uo([[36, 0], [36, 12.5], [104, 12.5], [106, 11.6, 1], [124, 11.6], [125.5, 10.4, 1], [125.5, 0]], { y: t, seg: 16 }));
    for (let e = 0; e < 7; e++) o.hard("steel", xA(cs(Th(1.3, 4.6, 0.05), [12.5, t - 0.5, 78 + e * 3.4], "R"), 0.55));
    for (let e of [111, 116.5]) o.hard("black", cs(yl(1.3, 8, 0.05), [10.05, t + 5.84, e], [[0.86, 0.5, 0], [0, 0, -1]]));
    o.hard("steel", uo([[125.5, 0], [125.5, 9.3], [143, 9.3], [144, 8.6, 1], [149, 8.6], [149, 0]], { y: t, seg: 14 }));
    for (let e = 0; e < 7; e++) o.hard("steel", KF(Pe(mn(143.5, t + 7.6, 149, t + 10.4), 3.4, { b: 0.4 }), e * 360 / 7 + 12, t));
    o.hard("oxide", Pe(mn(133, t - 2.6, 148.6, t + 2.6, 0.6), 2.2, { x: 9.2, b: 0.4 }));
  }
}
function sO(o) {
  sn() || SA(o, 0, Ms.B, 149.2);
}
var ma = { y0: 59.2, h: 5.2, u0: -51.5, u1: -41, hw: 24.5, hinge: [-8, 61.8, -43] }, nO = (o) => [[o * 7, -41, 0.6], [o * 25.5, -41.6, 1.2], [o * 27.6, -45.2, 1.5], [o * 25, -46.6, 1], [o * 7, -44.4, 0.6]];
function FA(o) {
  let t = ma.y0;
  if (o.hard("alu", R4([[-5.5, 20], [5.5, 20], [5.5, -40.5], [7.5, -44.6, 1], [24.5, -46.6, 1.5], [24.5, -51.5, 3], [-24.5, -51.5, 3], [-24.5, -46.6, 1.5], [-7.5, -44.6, 1], [-5.5, -40.5]], ma.h, { y: t, b: 0.9 })), o.hard("steel", R4(nO(1), 4.2, { y: t + 0.5, b: 0.7 })), !sn()) {
    o.hard("shadow", cs(Th(22, 3.2, 0.04), [0, t + ma.h, -28], "T", 90));
    for (let e = 0; e < 5; e++) o.hard("alu", Pe(mn(-52.1, t + 0.9, -51.3, t + ma.h - 0.9), 3, { x: -9 + e * 4.5, b: 0.25 }));
    for (let e = 0; e < 4; e++) o.hard("steel", Pe(mn(-41.9 - e * 0.07, t + 1.1, -40.9 - e * 0.07, t + 4.1), 1.3, { x: 14 + e * 2.6, b: 0.25 }));
    o.hard("oxide", Uu(s1(1.5, 0, ma.h + 0.5, { seg: 8 }), "y+", [8, t - 0.25, -43]));
  }
}
function OA(o) {
  let t = ma.y0;
  if (o.hard("steel", R4(nO(-1), 4.2, { y: t + 0.5, b: 0.7 })), !sn()) {
    for (let e = 0; e < 4; e++) o.hard("steel", Pe(mn(-41.9 - e * 0.07, t + 1.1, -40.9 - e * 0.07, t + 4.1), 1.3, { x: -14 - e * 2.6, b: 0.25 }));
    o.hard("oxide", Uu(s1(1.5, 0, ma.h + 0.5, { seg: 8 }), "y+", [-8, t - 0.25, -43]));
  }
}
var qn = { selector: [10, 12], catchPivot: [106, 23.4], magRel: [78, 6], trigPivot: [60.5, -7], takedown: [-20, 17], pivot: [166, 14.5], trigPin: [50, 3], hamPin: [29, 8], housingHW: 12.5, deckHW: 15.2, wellHW: 14.5, wellIn: 11.6, catchX: -20.8, magRelX: 16.4, selX: 16.7 };
function NA(o) {
  let t = qn.housingHW, e = qn.deckHW, s = qn.wellHW;
  o.metal(Pe(AA, t * 2, { b: 0.9 })), o.metal(Pe(kA, e * 2, { b: 0.7 })), o.metal(uo([[-48, 14.9], [-48, 17], [-47.2, 17.8, 1], [-34.8, 17.8], [-34, 17, 1], [-34, 14.9]], { y: Ms.B, seg: 24 }));
  let n = [[97, -29, 2], [150.5, -34.8, 2], [151.5, 13.5, 2], [105, 13.5, 4], [97, 5.5, 3]], i = [[97, -29, 2], [150.5, -34.8, 2], [151.5, -4, 2], [97, -4, 2]];
  for (let a of [-1, 1]) o.metal(Pe(bT, 1.9, { x: a * 12.55, b: 0.3 })), o.metal(Pe(bT, 1, { x: a * 14, b: 0.4, holes: [a < 0 ? n : i] }));
  if (o.metal(Pe([[155.2, 22], [160, 22], [160, 4], [157.6, C5(157.6)], [155.2, C5(155.2)]], s * 2, { b: 0.6 })), o.metal(Pe([[86, 20], [89.2, 20], [89.2, C5(89.2)], [87.4, C5(87.4)], [86, -12]], s * 2, { b: 0.6 })), !sn()) {
    let a = (r, l, c, h, f) => {
      let u = [], m = [[c - f, r - f, 0], [l + f, r - f, 90], [l + f, -r + f, 180], [c - f, -r + f, 270]];
      for (let [p, x, g] of m) for (let b = 0; b <= 4; b++) {
        let v = (g + 90 * b / 4) * Yr, y = p + Math.cos(v) * f, M = x + Math.sin(v) * f;
        u.push([M, C5(y) + h, -y]);
      }
      return u;
    };
    o.metal(k4([a(14.5, 86, 160, 9, 2.5), a(14.6, 85.9, 160.2, 7, 2.6), a(17, 83.6, 162.6, 0.6, 4), a(16.6, 84, 162.2, 0, 3.8), a(15.2, 85.4, 160.8, 0, 2.8), a(11.7, 89.1, 155.3, 6.5, 1.2)], { crease: 0.5, flag: (r) => [r === 2 || r === 3 ? 2 : 1, r === 4 ? 0.55 : 1] }));
    for (let r of [-1, 1]) o.hard("shadow", xA(Pe(mn(89.4, -32, 155, 21), 0.2, { x: r * 11.55, b: 0 }), 0.6));
    o.hard("black", Pe(mn(89.4, 21, 155, 21.6), 23, { b: 0 }), pa(Er(23.2, 52, 0, 0, -6), 0.2, { u: 89.3, b: 0 }), pa(Er(23.2, 60, 0, 0, -10), 0.2, { u: 155, b: 0 })), o.hard("steel", Pe(mn(134, 18.6, 153, 20.4, 0.4), 14, { b: 0.3 }));
    for (let r = 0; r < 5; r++) o.metal(Pe(mn(159.6, -33 + r * 7.4, 161, -30.2 + r * 7.4), 22, { b: 0.45 }));
    for (let r of [-1, 1]) {
      let l = r > 0 ? "R" : "L";
      o.metal(R4([[r * 12.2, 62], [r * 14.4, 86.4], [r * 12.2, 86.4]], 24, { y: -11.5, b: 0.5 })), o.metal(cs(n1(e1(10, 6.9), 0.9, { b: 0.35 }), [r * e, qn.pivot[1], qn.pivot[0]], l), cs(n1(e1(10, 6.9), 0.9, { b: 0.35 }), [r * e, qn.takedown[1], qn.takedown[0]], l)), o.metal(Pe([[-10, -3.2, 1.2], [52, -8.4, 1.2], [64, -8.4, 1.2], [70, -1.5, 1], [-12, 3, 1]], 0.8, { x: r * (t + 0.4), b: 0.35 }));
    }
  }
  for (let a of [-1, 1]) {
    for (let [r, l] of [qn.pivot, qn.takedown]) o.hard("oxide", bl(3.7, 1.3, a > 0 ? "x+" : "x-", [a * (e + 0.7), l, r], { seg: 10, c: 0.45 })), !sn() && a < 0 && o.hard("black", cs(yl(1.1, 8, 0.03), [a * (e + 2), l, r], "L"));
    if (!sn()) for (let [r, l] of [qn.trigPin, qn.hamPin]) o.hard("oxide", bl(1.95, 0.9, a > 0 ? "x+" : "x-", [a * (t + 0.1), l, r], { seg: 10, c: 0.3 }));
  }
  if (o.metal(Pe(Eh(CA, 3.2), 15, { b: 0.9 })), !sn()) {
    o.metal(cs(n1(e1(14, 7.6), 2.6, { b: 0.6, holes: [e1(10, 5)] }), [t, qn.magRel[1], qn.magRel[0]], "R")), o.hard("shadow", cs(yl(5, 14, 0.05), [t, qn.magRel[1], qn.magRel[0]], "R"));
    for (let a of [98.5, 111.5]) o.metal(Pe(mn(a, 16.5, a + 3, 26.5, 0.8), 3.6, { x: -(e + 1.5), b: 0.5 }));
    o.hard("oxide", s1(1.1, 98, 115, { x: -(e + 1.8), y: qn.catchPivot[1], seg: 6, c: 0 }));
    for (let a of [-1, 1]) {
      let r = a > 0 ? "R" : "L", [l, c] = qn.selector, h = a * (t + 0.02);
      o.metal(cs(n1(e1(12, 6.6), 0.7, { b: 0.3 }), [a * t, c, l], r)), o.mark(cs(tr("safe", 4.6), [h, c - 1.6, l + 21.5], r), cs(tr("semi", 4.6), [a * (e + 0.02), c + 7.6, l], r), cs(tr("auto", 4.6), [h, c - 5.6, l - 15.5], r));
    }
    o.mark(cs(tr("kr7", 44), [-(s - 1 + 0.02), -6.5, 125], "L"), cs(tr("sn", 21), [-(t + 0.02), 7.6, 48], "L")), o.mark(cs(tr("dm", 17), [s - 1 + 0.02, -17, 124], "R"), cs(tr("gh", 15), [t + 0.02, 6.5, 43], "R"));
  }
}
function BA(o) {
  let [t, e] = qn.selector, s = qn.housingHW;
  for (let n of [-1, 1]) {
    let i = n > 0 ? "R" : "L", a = n < 0 ? 21 : 14, r = n < 0 ? 1 : -1;
    if (o.hard("oxide", bl(4.6, 3.4, n > 0 ? "x+" : "x-", [n * (s + 0.6), e, t], { seg: 10, c: 0.5 })), !sn()) {
      o.hard("oxide", cs(n1([[-3 * r, -3.2, 1], [a * r, -2.4, 1.6], [a * r, 2.4, 1.6], [-3 * r, 3.2, 1]], 2.6, { b: 0.6 }), [n * (s + 1.6), e, t], i));
      for (let l = 0; l < 4; l++) o.hard("oxide", cs(n1(Er(1, 4.2, 0, r * (a - 2.2 - l * 2.2), 0), 0.6, { b: 0.2 }), [n * (s + 4.2), e, t], i));
      o.mark(cs(tr("wline", 4.5, 0.7), [n * (s + 4.22), e, t - 5], i));
    }
  }
}
function UA(o) {
  let t = qn.catchX;
  if (o.hard("steel", Pe([[100.5, 17.5, 1], [111, 17.5, 1], [112, 29, 1], [117, 33, 2], [117, 47, 3], [105, 51, 3], [99.5, 36, 2]], 3.2, { x: t + 1.6, b: 0.8 })), !sn()) {
    for (let e = 0; e < 5; e++) o.hard("steel", Pe(mn(103.5, 35.6 + e * 3, 115, 37 + e * 3), 0.9, { x: t - 0.3, b: 0.3 }));
    o.hard("steel", Pe(mn(101, 18.5, 110.5, 23.5), 1, { x: t - 0.2, b: 0.3 }));
  }
}
function VA(o) {
  let [t, e] = qn.magRel, s = qn.housingHW;
  if (o.hard("steel", bl(4.5, qn.magRelX - s, "x+", [s, e, t], { seg: 12, c: 0.5 })), !sn()) {
    for (let n = 0; n < 4; n++) o.hard("steel", Pe(mn(t - 3.6 + n * 2.1, e - 3, t - 2.7 + n * 2.1, e + 3), 0.5, { x: qn.magRelX + 0.15, b: 0.2 }));
    o.hard("steel", Pe(mn(70, e - 3.3, 90.5, e + 3.3, 1.2), 1.8, { x: -(s + 0.5), b: 0.5 })), o.hard("oxide", bl(1.5, 0.5, "x-", [-(s + 1.4), e, t], { seg: 8, c: 0.2 }));
  }
}
function GA(o) {
  o.hard("oxide", Pe(Eh(PA, 4.2), 6.6, { b: 1.3, bs: 2, soft: true }));
}
function WA(o) {
  let t = sn() ? [-8, 20, 50, 88] : [-8, -2, 6, 14, 22, 30, 38, 46, 54, 62, 70, 78, 84, 88], e = sn() ? 10 : 24, s = [], n = (h, f, u) => [u, oi.c0[1] + oi.ax[1] * h + oi.ax[0] * f, -(oi.c0[0] + oi.ax[0] * h - oi.ax[1] * f)];
  for (let h of t) {
    let [, f, u, d, m] = _y(h), p = [], x = 2 / m;
    for (let g = 0; g < e; g++) {
      let b = g / e * A5, v = Math.cos(b), y = Math.sin(b), M = Math.sign(v) * Math.pow(Math.abs(v), x);
      p.push(n(h, f + u * M, d * EA(M, h) * Math.sign(y) * Math.pow(Math.abs(y), x)));
    }
    s.push(p);
  }
  if (!sn()) {
    let [, h, f, u] = _y(88), d = [];
    for (let m = 0; m < e; m++) {
      let p = m / e * A5;
      d.push(n(89.8, h + (f - 2.4) * Math.cos(p), (u - 2.4) * Math.sin(p)));
    }
    s.push(d);
  }
  if (o.furn(k4(s, { capB: true, crease: 0.75 })), sn()) return;
  let i = (h, f, u) => {
    let [, d, m, p, x] = _y(h), g = 2 / x, b = Math.cos(f), v = Math.sin(f), y = m * Math.sign(b) * Math.pow(Math.abs(b), g), M = p * EA(y / m, h) * Math.sign(v) * Math.pow(Math.abs(v), g), w = Math.hypot(y / m, M / p) || 1;
    return n(h, d + y + u * (y / m) / w, M + u * (M / p) / w);
  }, a = (h, f, u, d, m, p, x, g = 1) => {
    let b = new Ep(), v = (y, M) => i(h + (f - h) * y / p, u + (d - u) * M / x, y === 0 || y === p || M === 0 || M === x ? 0.05 : m);
    for (let y = 0; y < p; y++) for (let M = 0; M < x; M++) b.quad(v(y, M), v(y, M + 1), v(y + 1, M + 1), v(y + 1, M), null, y === 0 || y === p - 1 || M === 0 || M === x - 1 ? g : 1);
    return gA(b.geo(), 0.9);
  };
  for (let h = 0; h < 9; h++) o.furn(a(26 + h * 6.2, 29.4 + h * 6.2, -0.62, 0.62, 0.9, 2, 4, 2));
  o.hard("rubber", a(14, 80, Math.PI - 0.5, Math.PI + 0.5, 0.7, 11, 4, 2));
  let r = (h, f, u, d, m, p, x, g = 3.2) => {
    let b = new Ep(), v = (h + f) / 2, y = (f - h) / 2, M = (u + d) / 2, w = (d - u) / 2, T = (S, E) => {
      let _ = h + (f - h) * S / p, R = Math.pow(Math.max(0, 1 - Math.pow(Math.abs(_ - v) / y, g)), 1 / g);
      return i(_, M + w * (0.45 + 0.55 * R) * (2 * E / x - 1), S === 0 || S === p || E === 0 || E === x ? 0.05 : m);
    };
    for (let S = 0; S < p; S++) for (let E = 0; E < x; E++) b.quad(T(S, E), T(S, E + 1), T(S + 1, E + 1), T(S + 1, E), null, S === 0 || S === p - 1 || E === 0 || E === x - 1 ? 2 : 1);
    return gA(b.geo(), 0.9);
  };
  for (let h of [1, -1]) {
    let f = h > 0 ? Math.PI / 2 : 3 * Math.PI / 2, u = h > 0 ? f - 0.56 : f - 0.66, d = h > 0 ? f + 0.66 : f + 0.56;
    o.hard("rubber", r(11, 70, u, d, 0.75, 14, 6));
    for (let m of [75.5, 79.5]) o.furn(a(m, m + 1.9, u + 0.08, d - 0.08, 0.5, 2, 5, 2));
  }
  {
    let h = i(40, 3 * Math.PI / 2 + 0.03, 0.82);
    o.mark(cs(tr("roundel", 9.5), [h[0], h[1], -h[2]], "L", 17));
  }
  let l = n(89.9, _y(88)[1], 0), c = [[0, oi.ax[1], -oi.ax[0]], [1, 0, 0]];
  o.hard("poly", cs(n1(Er(24, 19, 5), 0.8, { b: 0.3 }), [l[0], l[1], -l[2]], c)), o.hard("oxide", cs(n1(e1(12, 2.6), 0.5, { b: 0.2 }), [l[0], l[1] - 0.7, -l[2] - 0.2], c));
}
function qA(o, t) {
  let e = Ms.B, s = (n) => C4(n, (i, a, r) => r > Ms.HG0 && r < Ms.HG1 - 4 ? 0.6 : 1);
  if (o.hard("steel", uo([[160, 14], [160, 16.8, 1], [166.5, 16.8], [167, 14, 1]], { y: e, seg: 20 })), o.hard("steel", s(uo([[164, 12.6], [198, 12.6], [203, 10.6, 1], [317, 10.6], [318, 11.2], [348, 11.2], [349, 9.3, 1], [444, 9.3], [445, 9.8, 1], [Ms.CROWN - 0.4, 9.8], [Ms.CROWN, 9.3, 1], [Ms.CROWN, 3.4]], { y: e, seg: 18 }))), sn()) o.hard("steel", Pe(mn(319, e + 7, 347, e + 16), 13));
  else {
    o.hard("steel", s(uo([[319, 11.2], [319, 13.4], [320, 14, 1], [345, 14], [346, 13.4, 1], [346, 11.2]], { y: e, seg: 16 }))), o.hard("steel", s(Pe([[318.5, e + 7, 1], [347, e + 7, 1], [347, e + 16.4, 2], [322, e + 16.4, 2], [318.5, e + 13.5, 1]], 13.5, { b: 0.7 }))), o.hard("oxide", s(uo([[346.5, 3.2], [347.5, 4.3, 1, 0.5], [354, 4.3, 0, 0.5], [354.8, 3.6, 1], [354.8, 0]], { y: e + 12.2, flute: { n: 10 } }))), o.hard("steel", s(uo([[296, 3.6], [297, 4.1, 1], [318.5, 4.1]], { y: e + 12.2, seg: 10 })), s(s1(2.4, 166, 297, { y: e + 12.2, seg: 8, c: 0 })));
    for (let n of [-1, 1]) o.hard("oxide", s(bl(1.6, 0.6, n > 0 ? "x+" : "x-", [n * 6.6, e + 12, 332], { seg: 8, c: 0.2 })));
    o.mark(YF("brl", 9.3, 34, { phi: 148, u: 414, y: e, h: 2.6 }));
  }
  t ? KA(o) : o.hard("black", cs(yl(3.4, 10, 0.02), [0, e, Ms.CROWN], "F"));
}
function KA(o) {
  let t = Ms.B, e = Ms.CROWN, s = Ms.FH;
  if (sn()) {
    o.hard("steel", uo([[e, 9.3], [e + 2, 11.2], [e + 11, 11.2], [e + 12, 10.6], [e + 17, 10.6], [e + 18, 9.8], [e + s - 3, 9.8], [e + s, 8.4], [e + s, 5.6], [e + 18, 5.6]], { y: t, seg: 12 }));
    return;
  }
  o.hard("bright", uo([[e, 8.4], [e + 0.3, 9.6, 1], [e + 1.7, 9.6], [e + 2, 8.4, 1]], { y: t, seg: 16 })), o.hard("steel", pa(e1(8, 11.2 / Math.cos(Math.PI / 8), Math.PI / 8, 0, t), 9, { u: e + 2.1, b: 0.6 })), o.hard("steel", uo([[e + 11, 5.4], [e + 11, 10.2], [e + 11.6, 10.8, 1], [e + 17, 10.8], [e + 17.6, 10.3, 1], [e + 17.6, 5.6]], { y: t, seg: 20 })), o.hard("black", uo([[e + 17.5, 5.5], [e + 9, 5.5], [e + 9, 0]], { y: t, seg: 12 }));
  for (let n = 0; n < 3; n++) {
    let i = (90 + n * 120 - 36) * Yr, a = (90 + n * 120 + 36) * Yr, r = 5, l = (c, h, f) => {
      let u = [];
      for (let d = 0; d <= r; d++) {
        let m = i + f + (a - i - 2 * f) * d / r;
        u.push([Math.cos(m) * c, t + Math.sin(m) * c, 0]);
      }
      for (let d = r; d >= 0; d--) {
        let m = i + f + (a - i - 2 * f) * d / r;
        u.push([Math.cos(m) * h, t + Math.sin(m) * h, d === 0 ? 0 : 9]);
      }
      return u;
    };
    o.hard("steel", xf([{ u: e + 17.2, pts: l(10.3, 5.6, 0) }, { u: e + s - 3, pts: l(10, 5.6, 0.02) }, { u: e + s, pts: l(8.6, 6.4, 0.12) }], { capB: true, crease: 0.45, ao: (c, h, f) => f[2] === 9 ? 0.45 : 1 }));
  }
}
function XA(o) {
  let t = Ms.B, e = 2.6, s = Ms.HG0, n = Ms.HG1, i = RA, a = i.map((u) => [u[0], u[1] + t]);
  if (sn()) {
    let u = (d, m, p) => [[d - m, -p], [d + m, -p], [d + m, p], [d - m, p]];
    for (let d = 0; d < 8; d++) {
      let m = i[d], p = i[(d + 1) % 8], x = (m[0] + p[0]) / 2, g = (m[1] + p[1]) / 2, b = Math.hypot(p[0] - m[0], p[1] - m[1]), v = Math.hypot(x, g), y = Math.atan2(g, x), M = Math.abs(x) < 1 && g > 0, w = Math.abs(g) < 1 || Math.abs(x) < 1, T = M ? null : w ? [205, 245, 285, 325, 365, 405].map((E) => u(E, 16, 3.5)) : g > 0 ? [225, 265, 305, 345, 385].map((E) => u(E, 13, 2.4)) : [245, 285, 325, 365].map((E) => u(E, 11, 2.6)), S = Pe(mn(s + 21, -b / 2, n, b / 2), e, { x: v - e / 2, keepHoles: true, holes: T });
      S.rotateZ(y), S.translate(0, t, 0), o.metal(jr(S));
    }
    o.metal(jr(xf([{ u: s, pts: a }, { u: s + 21, pts: a }], { capA: true, capB: true }))), o.metal(jr(Pe([[s + 0.6, t - 27.5], [s + 18, t - 27.5], [s + 21, t - 19.4], [s + 0.6, t - 19.4]], 17))), TA(o, s + 0.6, n - 1, t + 19.3, { alt: true });
    return;
  }
  let r = (u) => mn(u - 16, -3.5, u + 16, 3.5, 1.3), l = (u, d, m, p, x, g) => Array.from({ length: u }, (b, v) => mn(d + v * m - p / 2, -x / 2, d + v * m + p / 2, x / 2, g ?? x * 0.49)), c = s + 21.2, h = n - 3.5;
  for (let u = 0; u < 8; u++) {
    let d = i[u], m = i[(u + 1) % 8], p = (d[0] + m[0]) / 2, x = (d[1] + m[1]) / 2, g = Math.hypot(m[0] - d[0], m[1] - d[1]) + 0.9, b = Math.hypot(p, x), v = Math.atan2(x, p), y = Math.abs(p) < 1 && x > 0, M = Math.abs(x) < 1 || Math.abs(p) < 1, w = !M && x > 0, T = y ? null : M ? [205, 245, 285, 325, 365, 405].map(r) : w ? l(5, 225, 40, 26, 4.8, 1.6) : l(4, 245, 40, 22, 5.2, 1.6), S = Pe(mn(c, -g / 2, h, g / 2), e, { x: b - e / 2, b: 0.55, cs: 1, holes: T });
    C4(S, (E) => E < b - e + 0.4 ? 0.3 : 1), S.rotateZ(v), S.translate(0, t, 0), o.metal(jr(S));
  }
  let f = i.map((u) => [u[0] * 0.84, u[1] * 0.84 + t]);
  o.metal(jr(pa(a, 21, { u: s + 0.4, b: 0.6, holes: [f] }))), o.metal(jr(pa(a, 3.2, { u: n - 3.4, b: 0.7, holes: [e1(12, 15.2, 0, 0, t)] }))), o.metal(jr(Pe([[s + 0.6, t - 27.5, 1.5], [s + 18, t - 27.5, 3], [s + 21, t - 19.4], [s + 0.6, t - 19.4]], 17, { b: 0.8 }))), o.hard("black", Pe(mn(s + 0.5, t - 27.7, s + 19, t - 19.6), 0.7, { b: 0 }));
  for (let u of [s + 5.5, s + 14]) o.hard("oxide", bl(3, 1.2, "x+", [8.5, t - 23.6, u], { seg: 12, c: 0.4 }), bl(3.3, 1, "x-", [-8.5, t - 23.6, u], { seg: 6, c: 0.3 })), o.hard("black", cs(yl(1.5, 6, 0.03), [9.7, t - 23.6, u], "R"));
  for (let u of [-1, 1]) o.metal(jr(Pe([[150, 50, 1], [s + 1, 50], [s + 1, 59], [152, 59, 1.5]], 2, { x: u * 18.2, b: 0.6 }))), xT(o, [u * 14.28, t + 14.28, s + 11], [[u * 0.7071, 0.7071, 0], [0, 0, -1]]);
  o.hard("oxide", bl(4.5, 7.4, [-0.7071, 0.7071, 0], [-14.28, t + 14.28, s + 11], { seg: 10, c: 0.5 }), s1(4.9, Sh.u - 3.1, Sh.u + 3.1, { x: Sh.x, y: Sh.y, seg: 10, c: 0.8 })), o.hard("bright", bl(1.7, 0.5, [-0.7071, 0.7071, 0], [Sh.x - 3.5, Sh.y + 3.5, Sh.u], { seg: 8, c: 0.15 })), o.mark(cs(tr("hg", 19), [-19.55, t + 4.5, s + 11], "L"), cs(tr("torque", 12), [19.55, t - 6.5, s + 11], "R")), TA(o, s + 0.6, n - 1, t + 19.3, { bevA: 0.3, alt: true }), tO(o, s + 0.6, n - 1, 20);
}
var Sh = { x: -14.28 - 7.1, y: Ms.B + 14.28 + 7.1, u: Ms.HG0 + 11, drop: 23, half: 12.5 };
function oO(o) {
  let { x: t, y: e, u: s, drop: n, half: i } = Sh, a = 4.2, r = [];
  for (let [l, c, h] of [[i - a, -a, 90], [i - a, -n + a, 0], [-i + a, -n + a, -90], [-i + a, -a, -180]]) for (let f = 0; f <= 3; f++) {
    let u = (h - f * 30) * Yr;
    r.push(new THREE.Vector3(t, e + c + Math.sin(u) * a, -(s + l + Math.cos(u) * a)));
  }
  o.hard("steel", Qe(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(r, true, "centripetal", 0.5), sn() ? 12 : 32, 1.35, 5, true)));
}
function xT(o, t, e) {
  o.hard("steel", cs(uo([[0, 6], [1, 6], [1.3, 5.7, 1], [1.3, 4.4], [0.2, 4.4]], { seg: 14 }).rotateX(Math.PI), t, e)), o.hard("black", cs(yl(4.4, 12, 0.2), t, e));
}
function YA(o) {
  let t = Ms.B;
  if (o.hard("alu", uo([[-232, 0], [-232, 13.6], [-231, 14.8, 1], [-56, 14.8]], { y: t, seg: 20 })), o.hard("steel", uo([[-60, 14.8], [-60, 18.4, 0, 1.6], [-59.4, 19.6, 1, 1.6], [-54.6, 19.6, 0, 1.6], [-54, 19.6], [-51.8, 19.6], [-51.4, 18.6, 1], [-51.4, 14.8]], { y: t, flute: { n: 6, trap: true } })), o.hard("steel", pa([[-17.5, t - 27, 5], [17.5, t - 27, 5], [19.5, t, 3], [17.5, t + 20.5, 6], [-17.5, t + 20.5, 6], [-19.5, t, 3]], 3, { u: -51.2, b: 0.7 })), !sn()) {
    for (let e of [38, 142]) o.hard("black", cs(yl(0.9, 6, 0.03), [Math.cos(e * Yr) * 16.5, t + Math.sin(e * Yr) * 16.5, -51.2], "B"));
    for (let e = 0; e < 6; e++) o.hard("black", cs(yl(2.1, 8, 0.02), [0, t - 14.8, -92 - e * 19], "D"));
  }
}
var jA = { std: [[-96, 67], [-268, 67], [-283, 58], [-284, -60], [-262, -63], [-196, -18], [-128, 26], [-96, 26]], light: [[-150, 67], [-262, 67], [-272, 60], [-272, -44], [-256, -46], [-166, 26], [-150, 26]], heavy: [[-92, 82], [-266, 82], [-296, 64], [-297, -72], [-262, -74], [-150, -22], [-110, 24], [-92, 24]] };
function wA(o, t, e, s) {
  if (o.hard("rubber", Pe(t, e, { b: 3.2, bs: 1, soft: true })), sn() || !s) return;
  let n = t.map((l) => l[1]), i = Math.min(...n) + 9, a = Math.max(...n) - 9, r = Math.min(...t.map((l) => l[0]));
  for (let l = 0; l < s; l++) {
    let c = i + (a - i) * l / (s - 1);
    o.hard("rubber", Pe(mn(r - 0.7, c - 2.2, r + 0.8, c + 2.2), e - 9, { b: 0.45 }));
  }
}
function $A(o, t) {
  let e = Ms.B;
  if (t === "light") {
    if (o.metal(mA(e1(8, 19.2 / Math.cos(Math.PI / 8), Math.PI / 8, 0, e), -236, -150, { c: 0.8, b: 0.8 })), o.metal(Pe([[-236, 66, 2], [-262, 66, 3], [-264, -44, 4], [-252, -46, 3], [-250, 30, 6], [-236, 30, 2]], 22, { b: 1.4, bs: 2, soft: 0.6 })), o.metal(Pe(Eh([[-166, 31], [-206, 0], [-254, -37]], 7.5), 11, { b: 1, soft: 0.6 })), wA(o, [[-263, 65, 2], [-271, 60, 4], [-272, -42, 4], [-264, -46, 2]], 24, 5), sn()) return;
    for (let r of [-162, -224]) o.hard("oxide", bl(2.6, 1.2, "x+", [19.2, e - 7, r], { seg: 10, c: 0.4 }), bl(2.9, 1, "x-", [-19.2, e - 7, r], { seg: 6, c: 0.3 }));
    for (let r = 0; r < 3; r++) o.hard("shadow", cs(Th(16, 5, 0.04), [-19.22, e + 5, -176 - r * 21], "L"), cs(Th(16, 5, 0.04), [19.22, e + 5, -176 - r * 21], "R"));
    xT(o, [-11.05, 20, -243], "L"), xT(o, [11.05, 20, -243], "R");
    return;
  }
  let s = t === "heavy", n = s ? 68.5 : 67, i = s ? -92 : -96, a = s ? -266 : -254;
  if (o.poly(jr(pa([[-17.5, 25, 3], [17.5, 25, 3], [20.8, 46, 6], [14.5, n, 8], [-14.5, n, 8], [-20.8, 46, 6]], i - a + 2, { u: a - 2, b: 1.6, bs: 2, cs: 3, soft: true }))), s) {
    o.poly(jr(Pe([[-108, 30, 3], [-266, 30, 3], [-266, -70, 6], [-248, -74, 5], [-160, -24, 12]], 30, { b: 3.2, bs: 2, soft: true, keepHoles: true, holes: [[[-196, 12, 4], [-250, 12, 4], [-250, -40, 5], [-232, -40, 5]]] }))), o.poly(jr(Pe([[-262, 70, 4], [-282, 70, 4], [-284, -72, 5], [-262, -74, 4]], 42, { b: 3, bs: 2, soft: true }))), wA(o, [[-282, 68, 3], [-295.5, 62, 6], [-297, -66, 7], [-284, -72, 3]], 39, 6), o.poly(jr(pa([[-16.5, 71, 2], [16.5, 71, 2], [17.5, 76, 4], [11, 81, 5], [-11, 81, 5], [-17.5, 76, 4]], 104, { u: -236, b: 1.6, bs: 1, cs: 3, soft: true }))), o.hard("rubber", pa([[-10.5, 80.4], [10.5, 80.4], [9.5, 82.6], [-9.5, 82.6]], 92, { u: -230, b: 0.8, soft: true }));
    for (let r of [-214, -154]) o.hard("steel", Uu(s1(4.2, 0, 6, { seg: 10 }), "y+", [0, 66.5, r]));
    if (!sn()) {
      o.hard("steel", Uu(uo([[0, 3], [0.6, 8.8, 1, 0.9], [5.2, 8.8, 0, 0.9], [5.8, 7.6, 1], [5.8, 0]], { flute: { n: 14 } }), "x+", [20.2, 52, -184])), o.metal(Pe(mn(-246, -76.5, -206, -72.5, 1), 15, { b: 0.6 }));
      for (let r = 0; r < 3; r++) o.metal(Pe(mn(-243 + r * 12.6, -79.6, -237 + r * 12.6, -76.2, 0.4), 15, { b: 0.5 }));
    }
  } else o.poly(jr(Pe([[-126, 30, 3], [-256, 30, 3], [-256, -58, 6], [-242, -61, 5], [-190, -17, 14]], 27, { b: 3.2, bs: 2, soft: true, keepHoles: true, holes: [[[-212, 15, 4], [-246, 15, 4], [-246, -30, 5]]] }))), o.poly(jr(Pe([[-252, 68, 4], [-269, 68, 4], [-271, -61, 5], [-252, -63, 4]], 40, { b: 3, bs: 2, soft: true }))), wA(o, [[-269, 66, 3], [-281.5, 61, 5], [-283, -57, 6], [-271, -61, 3]], 37, 6);
  if (!sn()) {
    o.poly(jr(Pe(Eh([[i - 14, 22.5], [i - 40, 15.5, 3.4], [i - 62, 16.5, 2.6]], 4), 15, { b: 1.2, soft: true }))), o.hard("oxide", bl(2.2, 36.4, "x+", [-18.2, 27.5, i - 14], { seg: 8, c: 0.3 }));
    for (let r of [-1, 1]) {
      for (let l = 0; l < 5; l++) o.poly(jr(Pe(mn(i - 22 - l * 9, 37, i - 18 - l * 9, 51), 1, { x: r * 20.2, b: 0.45, soft: true })));
      xT(o, [r * 20.7, 44, a + 14], r > 0 ? "R" : "L");
    }
    o.mark(cs(tr("roundel", 9), [-20.82, 45, i - 92], "L"), cs(tr("stockn", 30), [0, n + 0.03, i - 50], "T", 90));
  }
}
function SA(o, t, e, s, n, i = 12) {
  let a = (r) => n ? C4(r, n) : r;
  o.hard("brass", a(uo([[s, 0], [s, 4.2], [s + 0.45, 4.75, 1], [s + 1.2, 4.75], [s + 1.5, 4.1], [s + 2.6, 4.1], [s + 3.1, 4.75], [s + 36.5, 4.5], [s + 39.8, 3.22], [s + 44.5, 3.2], [s + 44.7, 3, 1]], { x: t, y: e, seg: i, crease: 50 }))), o.hard("copper", a(uo([[s + 44.6, 2.84], [s + 46.2, 2.84], [s + 46.5, 2.7], [s + 46.9, 2.84], [s + 49, 2.72], [s + 52, 2.2], [s + 55, 1.35], [s + 56.9, 0.62], [s + 57.2, 0.5, 1], [s + 57.2, 0]], { x: t, y: e, seg: i, crease: 60 }))), sn() || o.hard("bright", cs(yl(2.1, 10, 0.03), [t, e, s], "B"), cs(yl(0.55, 6, 0.06), [t, e, s], "B"));
}
var PJ = 5.2, zJ = 15, Ry = (o) => PJ * (o - 1) - (zJ + 46);
function iO(o) {
  let t = _h[o], e = 24, s = t.len - 20, n = 1, i = t.rounds;
  for (; Ry(n) < e + 2.6; ) n++;
  for (; Ry(i) > s - 2.6; ) i--;
  return { s0: e, s1: s, o0: 3, o1: 20, i0: n, i1: i, part: Math.round(t.rounds * 0.7) };
}
var bf = (o, t, e = 0, s = 0) => {
  let n = t >= 0 ? Vi(t, e) : [L4 + e, -46 - t];
  return A4(o, [s, n[1], n[0]], [t > 0 ? t / yf / Yr : 0, 0, 0]);
}, ZF = (o, t, e, s, n = 0, i = 8) => {
  let a = [];
  for (let r = 0; r <= i; r++) a.push([...Vi(o + (t - o) * r / i, s), r === 0 || r === i ? n : 0]);
  for (let r = i; r >= 0; r--) a.push([...Vi(o + (t - o) * r / i, e), r === 0 || r === i ? n : 0]);
  return a;
};
function ZA(o, t) {
  let e = _h[t], s = CJ, n = (f) => f / yf / Yr, i = iO(t);
  o.poly(Pe(zA(t), s, { b: 2, bs: 2, soft: true, holes: sn() ? null : [ZF(i.s0, i.s1, i.o0, i.o1, 3.2, Math.max(6, Math.round((i.s1 - i.s0) / 9)))] }));
  let a = LA(t);
  if (t === "fast") {
    if (o.hard("bronze", Pe(a.map((f, u) => [f[0], f[1], [1.2, 3.5, 3.5, 1.2][u]]), 29, { b: 1.4, bs: 2, soft: 0.6 })), !sn()) {
      let f = Vi(e.len + 8, 0), u = n(e.len + 8);
      for (let d = -1; d <= 1; d++) o.hard("shadow", A4(cs(Th(11, 4.2, 0.05), [14.52, 0, d * 16], "R"), [0, f[1], f[0]], [u, 0, 0]));
      o.mark(A4(cs(tr("speed", 34), [-14.52, 0, 0], "L"), [0, f[1], f[0]], [u, 0, 0]));
    }
  } else o.poly(Pe(a.map((f, u) => [f[0], f[1], [1, 2.2, 2.2, 1][u]]), 26.4, { b: 1.3, bs: 2, soft: true }));
  if (sn()) {
    o.hard("brass", Pe(mn(96, 9, 148, 15), 12));
    return;
  }
  let r = t === "fast" ? 29 : 26.4, l = e.len + e.pad, c = [[0, -Math.cos(l / yf), -Math.sin(l / yf)], [1, 0, 0]];
  o.hard("shadow", Pe(Eh([Vi(e.len - 1.7, -er - 1.95), Vi(e.len - 1.7, er + 2.35)], 0.55), r + 0.16, { b: 0 }));
  {
    let f = Vi(l, 1.5), u = Vi(l, 18), d = Vi(l, -16);
    o.hard("shadow", cs(n1(Er(12.4, 17.6, 2.4), 0.12, { b: 0 }), [0, f[1], f[0]], c)), o.hard(t === "fast" ? "alu" : "poly", cs(n1(Er(10, 15.2, 1.8), 0.7, { b: 0.35 }), [0, f[1], f[0]], c));
    for (let m = -1; m <= 1; m++) {
      let p = Vi(l, 1.5 + m * 2.6);
      o.hard("shadow", cs(n1(Er(0.9, 10.6, 0), 0.74, { b: 0 }), [0, p[1], p[0]], c));
    }
    o.hard("black", cs(yl(1.5, 8, 0.05), [0, u[1], u[0]], c)), o.hard("shadow", cs(n1(Er(4, 8, 0.8), 0.1, { b: 0 }), [0, d[1], d[0]], c));
  }
  if (t !== "fast") for (let f of [-13, 0, 13]) o.poly(bf(Pe(mn(-3.6, -1.9, 3.6, 1.9, 0.9), r + 1.1, { b: 0.5, cs: 1, soft: true }), e.len + e.pad * 0.5 + 0.4, f));
  for (let f = i.s0 - 1; f <= e.len - 10.5; f += 6.4) o.poly(bf(Pe(mn(-3.6, -1.55, 3.6, 1.55, 1.3), s + 1.5, { b: 0.62, cs: 1, soft: true }), f, 25.6)), o.poly(bf(Pe(mn(-12.6, -1.55, 12.6, 1.55, 1.3), s + 1.5, { b: 0.62, cs: 1, soft: true }), f, -11.6));
  let h = DA(t);
  o.poly(Pe(h.front, h.fw, { b: 0.8, soft: true }), Pe(h.rear, h.rw, { b: 0.7, soft: true }));
  for (let f = 9; f <= e.len - 6; f += 4.3) o.poly(bf(Pe(mn(-1, -1, 1, 1, 0.4), 8.4, { b: 0.45, cs: 1 }), f, er + 1.5));
  {
    let f = Vi(12.5, 1);
    o.mark(A4(cs(tr(t === "ext" ? "mag45" : "mag30", 26), [-(s / 2 + 0.03), 0, 0], "L"), [0, f[1], f[0]], [n(12.5), 0, 0]));
  }
  for (let f of [-1, 1]) {
    let u = f > 0 ? "R" : "L";
    for (let p = 0; p < 2; p++) for (let x = 0; x < 10; x++) o.hard("shadow", bf(cs(yl(0.8, 6, 0.05), [0, 0, 0], u), e.len - 4.2 - p * 2.9, -21 + x * 4.6 + p * 2.3 - 1, f * s / 2));
    let d = Math.max(3, Math.round((i.s1 - i.s0) / 24)), m = (i.s1 - i.s0) / d;
    for (let p = 0; p < d; p++) {
      let x = i.s0 + m * (p + 0.5);
      o.mark(bf(cs(tr("pane", i.o1 - i.o0 + 6, m + 1.2), [0, 0, 0], u), x, (i.o0 + i.o1) / 2, f * (s / 2 - 1.55)));
    }
    o.hard("shadow", cs(n1(f < 0 ? Er(10.5, 5.4, 0.6) : Er(6, 3.2, 0.6), 0.12, { b: 0 }), [f * s / 2, 6, f < 0 ? 97.2 : 99], u));
  }
  o.hard("black", Pe(ZF(i.s0 - 4, i.s1 + 4, i.o0 - 4, i.o1 + 4, 0, 6), 5.6, { b: 0 })), o.hard("black", Pe(mn(92.5, 11.6, 150.5, 12.1), 18, { b: 0 }));
  for (let f of [-1, 1]) o.poly(pa([[f * 11.2, 10.5], [f * 11.2, 16.2, 1.5], [f * 7.2, 18, 0.6], [f * 6.6, 16.8], [f * 9.6, 15.2, 1], [f * 9.6, 10.5]], 47, { u: 91.5, b: 0.4 }));
  o.poly(Pe(mn(90, 10.5, 93.5, 17.2, 0.8), 20, { b: 0.6 })), o.hard("orange", Pe([[94.5, 9.5], [150, 9.5], [150, 12.2, 1], [118, 13.6, 2], [94.5, 12.8, 1]], 13, { b: 0.8 })), o.hard("orange", uo([[96, 3.6], [130, 3.4], [139, 2.4, 1], [146, 0.8]], { x: -2.6, y: 10.2, seg: 10, arc: [20, 160], crease: 40 }));
}
function aO(o) {
  if (sn()) return;
  let t = (e, s) => s < 11.5 ? 0.35 : 1;
  SA(o, 3, 15, 94.5, t), SA(o, -3, 9.8, 94.5, t);
}
function rO(o, t, e) {
  if (sn()) return;
  let s = _h[t], n = iO(t), i = e === "full" ? n.i1 : e === "part" ? Math.min(n.i1, n.part) : 0, a = (l) => {
    let c = Math.min(1, Math.max(0, (Math.abs(l) - 1.5) / 7.6));
    return 0.26 + 0.62 * c * c;
  };
  for (let l = n.i0; l <= i; l++) {
    let c = l & 1 ? 1 : -1;
    o.hard("brass", bf(C4(uo([[-1.5, 4.71], [9.75, 4.5], [13.05, 3.22, 1], [17.75, 3.2], [17.95, 3.02, 1]], { seg: 10, crease: 40 }), a), Ry(l), 0, c * 4.4)), o.hard("copper", bf(C4(uo([[17.85, 2.84], [19.5, 2.84], [19.8, 2.7], [20.2, 2.84], [22.6, 2.66]], { seg: 10, crease: 60 }), a), Ry(l), 0, c * 4.4));
  }
  if (e === "full") return;
  let r = e === "part" ? Ry(i + 1) + 1.6 : n.s0 - 7;
  if (e === "part") {
    o.hard("orange", bf(Pe([[-14, -3.4, 0.8], [11, -3.4, 0.8], [11, 3, 1.2], [-14, 3, 1.2]], 18.6, { b: 0.7 }), r + 0.4, 0));
    for (let l of [-1, 1]) for (let c of [-9.5, 5.5]) o.hard("orange", bf(Pe(mn(-2.2, -9, 2.2, -3, 0.8), 1.6, { x: l * 8.5, b: 0.4 }), r + 0.4, c));
  }
  for (let l of [-1, 1]) {
    let c = [], h = 0;
    for (let f = r + 6; f <= s.len - 5; f += 5.6, h++) c.push(Vi(f, (h & 1) === (l > 0 ? 0 : 1) ? -13.5 : 9.5));
    c.length > 1 && o.hard("bright", Pe(Eh(c, 4.6), 1.15, { x: l * 7.9, b: 0.3, cs: 1 }));
  }
}
var vl = { rearU: P5(15), frontU: P5(-25), hingeY: 6.2, apR: 3, arm: Ms.SIGHT - 6.2 };
function lO(o, t, e) {
  let s = Ms.RT, n = t - 17, i = t + 13 * e;
  if (o.hard("alu", pa([[-10.5, s], [-10.5, s - 5.2], [-12.4, s - 5.2], [-14.2, s - 2.8], [-14.2, s + 3.2], [-11.8, s + 4.6], [11.8, s + 4.6], [14.2, s + 3.2], [14.2, s - 2.8], [12.4, s - 5.2], [10.5, s - 5.2], [10.5, s]], 34, { u: n, b: 0.5 })), !sn()) {
    o.hard("oxide", bl(2.7, 1.6, "x+", [14.2, s - 0.6, t - 9 * e], { seg: 12, c: 0.4 }), bl(3, 1.2, "x-", [-14.2, s - 0.6, t - 9 * e], { seg: 6, c: 0.3 })), o.hard("black", cs(yl(1.4, 6, 0.03), [15.82, s - 0.6, t - 9 * e], "R"));
    for (let a of [-1, 1]) o.hard("alu", Pe([[i - 3.2, s + 4.4], [i + 3.2, s + 4.4], [i + 3.2, s + 7.6], [i + 1.6, s + 9.2], [i - 1.6, s + 9.2], [i - 3.2, s + 7.6]], 3, { x: a * 9.7, b: 0.5 }));
    o.hard("oxide", bl(1.5, 23, "x+", [-11.5, s + vl.hingeY, i], { seg: 8, c: 0.3 }));
  }
}
function cO(o, t, e, s, n) {
  let i = e + 13 * s, a = (s > 0 ? 1 : -1) * 88 * Yr;
  for (let [r, l] of t) n || l.rotateX(a), l.translate(0, Ms.RT + vl.hingeY, -i), o.hard(r, l);
}
function MT(o, t, e = "all") {
  let s = vl.rearU, n = vl.arm, i = [];
  e !== "arm" && lO(o, s, -1), e !== "base" && (i.push(["alu", pa([[-8.6, -1.4], [-7.4, -2.6], [7.4, -2.6], [8.6, -1.4], [8.6, n - 9], [6.6, n + 3.6], [4.2, n + 6.4], [-4.2, n + 6.4], [-6.6, n + 3.6], [-8.6, n - 9]], 4.4, { u: -2.2, b: 0.6, keepHoles: true, holes: sn() ? [e1(8, 3.6, 0, 0, n)] : [e1(20, 5, 0, 0, n), [[-4.2, 3.6, 1.2], [4.2, 3.6, 1.2], [4.2, n - 13, 1.2], [-4.2, n - 13, 1.2]]] })]), sn() || (i.push(["oxide", uo([[-2.6, vl.apR + 0.25], [-2.6, 4.8], [-2.2, 5.2, 1], [2.2, 5.2], [2.6, 4.8, 1], [2.6, 3.9], [-1.9, vl.apR, 1], [-2.6, vl.apR + 0.25]], { y: n, seg: 24 })]), i.push(["steel", Uu(uo([[0, 2.2], [0.5, 4.4, 1, 0.5], [3.6, 4.4, 0, 0.5], [4.2, 3.6, 1], [4.2, 0]], { flute: { n: 9 } }), "x+", [8.6, n - 2.5, 0])]), i.push(["white", cs(Th(0.5, 2.2, 0.03), [0, n + 5.2, 2.2], "B")])), cO(o, i, s, -1, t));
}
function wT(o, t, e = "all") {
  let s = vl.frontU, n = vl.arm, i = [];
  if (e !== "arm" && lO(o, s, 1), e !== "base") {
    i.push(["alu", pa([[-8.2, -1.4], [-7, -2.6], [7, -2.6], [8.2, -1.4], [8.2, n - 12], [6.4, n - 8.4], [-6.4, n - 8.4], [-8.2, n - 12]], 5, { u: -2.5, b: 0.6, keepHoles: true, holes: sn() ? null : [[[-4, 3.4, 1.2], [4, 3.4, 1.2], [4, n - 15, 1.2], [-4, n - 15, 1.2]]] })]);
    for (let a of [-1, 1]) i.push(["alu", Pe([[-2.3, n - 9], [2.3, n - 9], [1.3, n + 4.6], [-1.3, n + 4.6]], 2.2, { x: a * 5.6, b: 0.5 })]);
    i.push(["oxide", Uu(s1(1.15, 0, 8.6, { seg: 8, c: 0.2 }), "y+", [0, n - 8.6, 0])]), sn() || i.push(["oxide", Uu(uo([[0, 3.3, 0, 0.4], [1.1, 3.3, 0, 0.4], [1.1, 1.2]], { flute: { n: 8 } }), "y+", [0, n - 8.5, 0])]), cO(o, i, s, 1, t);
  }
}
var Ce = Ms, ie = (o) => o / 1e3, Rh = (o) => o.map((t) => [t[0] / 1e3, t[1] / 1e3]), VJ = { camo: "factory", optic: "reflex", muzzle: "none", underbarrel: "none", magazine: "std", stock: "std" }, ST = { reflex: 8, holo: 7, prism: 6 }, SO = { reflex: 0.062, holo: 0.076, prism: 0.05, irons: 0.052 }, zy = { vgrip: 292, angled: 286, laser: 385 }, _O = (o) => {
  let t = { ...VJ, ...o || {} };
  return _h[t.magazine] || (t.magazine = "std"), jA[t.stock] || (t.stock = "std"), ST[t.optic] || (t.optic = t.optic === "irons" ? "irons" : "reflex"), zy[t.underbarrel] || (t.underbarrel = "none"), ["suppressor", "comp", "brake"].includes(t.muzzle) || (t.muzzle = "none"), t;
}, yO = /* @__PURE__ */ new Map();
function o1(o, t, e = false, s = null) {
  let n = (e ? "L:" : "H:") + o, i = yO.get(n);
  if (!i) {
    Sy(e);
    try {
      let a = bA();
      t(a), i = a.finish();
    } finally {
      Sy(false);
    }
    if (s) for (let a of ["metal", "poly", "furn", "hard", "mark"]) i[a] && i[a].translate(-s.x, -s.y, -s.z);
    for (let a of ["metal", "poly", "furn", "hard", "mark"]) i[a] && (i[a].computeBoundingBox(), i[a].computeBoundingSphere());
    yO.set(n, i);
  }
  return i;
}
var vO = /* @__PURE__ */ new Map();
function GJ(o, t) {
  let e = o.muzzle === "none", s = `${e ? 1 : 0}|${o.stock}|${t ? 1 : 0}`, n = vO.get(s);
  if (!n) {
    n = yA([o1("upper", IA), o1("lower", NA), o1("grip", WA), o1("barrel" + (e ? ":fh" : ""), (i) => qA(i, e)), o1("handguard", XA), o1("tube", YA), o1("stock:" + o.stock, (i) => $A(i, o.stock)), o1("buisRB", (i) => MT(i, false, "base")), o1("buisFB", (i) => wT(i, false, "base"))]);
    for (let i of ["metal", "poly", "furn", "hard", "mark"]) n[i] && (n[i].computeBoundingBox(), n[i].computeBoundingSphere());
    vO.set(s, n);
  }
  return n;
}
var RO = false;
function ky(o, t, e, s = false) {
  let n = RO ? P4().studio : P4(), i = [], a = (l, c, h) => {
    if (!l) return;
    let f = new THREE.Mesh(l, c);
    return f.name = h, f.castShadow = f.receiveShadow = s, o.add(f), i.push(f), f;
  };
  a(t.metal, xl(e, "metal") || n.metal, "metal"), a(t.poly, xl(e, "polymer") || n.poly, "poly"), a(t.furn, xl(e, "furniture") || n.furn, "furn"), a(t.hard, n.hard, "hardware");
  let r = a(t.mark, n.mark, "marks");
  return r && (r.renderOrder = 1, r.castShadow = false), i;
}
var WJ = (o) => {
  let t = 0;
  return o.traverse((e) => {
    e.isMesh && !e.isSkinnedMesh && (t += (e.geometry.index ? e.geometry.index.count : e.geometry.attributes.position.count) / 3);
  }), Math.round(t);
}, Cy = { bolt: Gt(0, ie(Ce.B), 0.094), chargingHandle: Gt(0, 0.062, -0.045), selector: Gt(0, ie(qn.selector[1]), ie(qn.selector[0])), boltCatch: Gt(-0.0172, ie(qn.catchPivot[1]), ie(qn.catchPivot[0])), magRelease: Gt(ie(qn.housingHW), ie(qn.magRel[1]), ie(qn.magRel[0])), trigger: Gt(0, ie(qn.trigPivot[1]), ie(qn.trigPivot[0])), mag: Gt(0, -0.04, 0.122), chLatch: Gt(ie(ma.hinge[0]), ie(ma.hinge[1]), ie(ma.hinge[2])), dustCover: Gt(ie(Tp.x), ie(Tp.y), ie(Tp.u)), slingLoop: Gt(ie(Sh.x), ie(Sh.y), ie(Sh.u)), buisRearArm: Gt(0, ie(Ce.RT + vl.hingeY), ie(vl.rearU - 13)), buisFrontArm: Gt(0, ie(Ce.RT + vl.hingeY), ie(vl.frontU + 13)) };
function AO(o) {
  let t = { ironsUp: o.optic === "irons" };
  return t.muzzleP = Gt(0, ie(Ce.B), ie(Ce.CROWN)), t.underP = o.underbarrel !== "none" ? Gt(0, ie(Ce.B - Ce.HGW), ie(zy[o.underbarrel])) : Gt(0, ie(Ce.B - Ce.HGW), 0.3), t.opticP = Gt(0, ie(Ce.RT), ie(P5(ST[o.optic] || 8))), t.adsDist = SO[o.optic] || 0.07, t;
}
function ak(o = {}) {
  if (o.detail === "world") return JJ(o);
  let t = _O(o.build), e = AO(t), s = new THREE.Group(), n = {};
  s.name = "gun_ar", RO = o.portal === false;
  let i = performance.now();
  ky(s, GJ(t, e.ironsUp), t.camo);
  let a = (m, p, x, g = s, b = null) => {
    let v = Cy[m], y = new THREE.Group();
    return y.name = m, y.userData.keep = true, y.position.copy(v), b && y.position.sub(b), y.userData.rest = y.position.clone(), g.add(y), n[m] = y, ky(y, o1(p, x, false, v), t.camo), y;
  }, r = a("bolt", "bolt", eO);
  {
    let m = new THREE.Group();
    m.name = "chamberRound", m.userData.keep = true, m.userData.hidden = true, m.visible = false, m.userData.rest = new THREE.Vector3(), r.add(m), n.chamberRound = m, ky(m, o1("chamberRound", sO, false, Cy.bolt), t.camo);
  }
  let l = a("chargingHandle", "ch", FA);
  a("chLatch", "chLatch", OA, l, Cy.chargingHandle), a("selector", "selector", BA), a("boltCatch", "boltCatch", UA), a("magRelease", "magRelease", VA), a("trigger", "trigger", GA), a("dustCover", "dustCover", HA), a("slingLoop", "slingLoop", oO), a("buisRearArm", "buisRA:" + e.ironsUp, (m) => MT(m, e.ironsUp, "arm")), a("buisFrontArm", "buisFA:" + e.ironsUp, (m) => wT(m, e.ironsUp, "arm"));
  let c = a("mag", "mag:" + t.magazine, (m) => ZA(m, t.magazine));
  {
    let m = new THREE.Group();
    m.name = "magRounds", m.userData.keep = true, m.userData.rest = new THREE.Vector3(), c.add(m), n.magRounds = m, ky(m, o1("magRounds", aO, false, Cy.mag), t.camo);
  }
  for (let m of ["full", "part", "empty"]) {
    let p = "magFill" + m[0].toUpperCase() + m.slice(1), x = new THREE.Group();
    x.name = p, x.userData.keep = true, x.userData.rest = new THREE.Vector3(), m !== "full" && (x.userData.hidden = true, x.visible = false), c.add(x), n[p] = x, ky(x, o1(`magFill:${t.magazine}:${m}`, (g) => rO(g, t.magazine, m), false, Cy.mag), t.camo);
  }
  let h = {}, f = {};
  for (let [m, p] of [["optic", e.opticP], ["muzzle", e.muzzleP], ["underbarrel", e.underP]]) {
    let x = new THREE.Object3D();
    x.name = "mount_" + m, x.position.copy(p), x.userData.keep = true, s.add(x), h[m] = x;
  }
  t.optic !== "irons" && (f.optic = Mp(t.optic, { portal: o.portal !== false }), h.optic.add(f.optic.group)), t.muzzle !== "none" && (f.muzzle = gf(t.muzzle, { caliber: "rifle" }), h.muzzle.add(f.muzzle.group)), t.underbarrel !== "none" && (f.underbarrel = wp(t.underbarrel, { mount: "mlok" }), h.underbarrel.add(f.underbarrel.group));
  for (let m in f) Ou(f[m], t.camo);
  let u = f.optic ? e.opticP.clone().add(f.optic.eye) : Gt(0, ie(Ce.RT + Ce.SIGHT), ie(vl.rearU - 13) - SO.irons), d = { id: "ar", root: s, parts: n, build: t, mounts: h, attachments: f, anchors: { muzzle: f.muzzle ? e.muzzleP.clone().add(Bt(0, 0, -f.muzzle.length)) : Gt(0, ie(Ce.B), ie(Ce.CROWN + Ce.FH)), eject: Gt(0.019, 0.049, 0.096), ejectDir: Bt(0.86, 0.36, 0.36).normalize(), sight: u.clone().add(Bt(0, 0, -e.adsDist)), eye: u, gripR: new THREE.Object3D(), gripL: new THREE.Object3D() }, hip: { pos: Bt(0.112, -0.152, -0.275), rot: new THREE.Euler(0.03, 0.07, 0) }, adsDist: e.adsDist, zoomHint: f.optic ? f.optic.zoomHint : 1 };
  f.underbarrel && f.underbarrel.laser && (d.anchors.laser = e.underP.clone().add(f.underbarrel.laser)), d.anchors.gripR.name = "gripR", d.anchors.gripL.name = "gripL", s.add(d.anchors.gripR, d.anchors.gripL);
  {
    let m = f.muzzle ? f.muzzle.group.children.find((g) => g.name === "body") : null, p = f.muzzle ? f.muzzle.length : ie(Ce.FH), x = new THREE.Mesh(m ? m.geometry : o1("fh", KA).hard, qJ(f.muzzle ? 0 : -ie(Ce.CROWN), p));
    x.name = "heat", x.visible = false, x.renderOrder = 3, x.userData.keep = true, (f.muzzle ? h.muzzle : s).add(x), d.heat = x;
  }
  d.magLen = vT(t.magazine).len / 1e3;
  d.dims = { BORE: ie(Ce.B), RAIL_TOP: ie(Ce.RT), BOLT_TRAVEL: 0.058, CH_PULL: 0.055, magLen: d.magLen };
  d.tris = WJ(s);
  return d;
}
function qJ(o, t) {
  return new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, fog: false, uniforms: { uHeat: { value: 0 }, uZ: { value: new THREE.Vector2(o, t) } }, vertexShader: "uniform vec2 uZ; varying float vK; varying vec3 vN; varying vec3 vV; void main(){ vK = clamp((uZ.x - position.z) / uZ.y, 0.0, 1.0); vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalMatrix * normal; vV = -mv.xyz; gl_Position = projectionMatrix * mv; }", fragmentShader: "uniform float uHeat; varying float vK; varying vec3 vN; varying vec3 vV; void main(){ float f = 0.5 + 0.5 * abs(dot(normalize(vN), normalize(vV))); float k = smoothstep(0.1, 1.0, vK); vec3 c = mix(vec3(0.85, 0.05, 0.01), vec3(2.4, 0.62, 0.1), k * uHeat) * uHeat * (0.16 + 0.84 * k) * f; gl_FragColor = vec4(c, 1.0); }" });
}
var Cs = 0.036, vo = 0.0585, ii = 0.011, Mo = 0.019, Iy = 0.016, Ml = 0.0505, sr = Ml + Mo, Ac = 0.0865, Pa = -0.031, M2 = 0.172, I5 = 0.305, Tr = 0.0205, zO = 28e-4, F1 = 0.292, kc = 150, mk = 0.08, gk = Ze(-34), i1 = 0.066, wf = 0.12, I1 = 0.03, a1 = 0.053, H5 = -8e-3, s00 = 0.046, Sr = 0.1165, Hy = 1.35, Cp = -0.022, za = 0.034, nr = 0.0212, Dy = 0.012, NO = -0.034, Pp = { std: -0.158, ext: -0.218, fast: -0.158 }, Hn = 0.083, Rp = 0.3525, Vu = Cs - Tr - 7e-3, BO = { vgrip: 0.226, laser: 0.288 }, H1 = (o) => o.map((t) => [t[0], t[1]]), RT = (o, t, e, s, n, i) => Array.from({ length: i + 1 }, (a, r) => {
  let l = Ze(s + (n - s) * r / i);
  return [o + Math.cos(l) * e, t + Math.sin(l) * e];
}), UO = (o = 12) => [[-Mo, Iy, 3e-3], [Mo, Iy, 3e-3], ...RT(0, Ml, Mo, 0, 180, o)], n00 = () => [[-Mo, Iy, 3e-3], [Mo, Iy, 3e-3], [Mo, I1], [H5, I1], [H5, a1], [Math.sqrt(Mo * Mo - (a1 - Ml) ** 2), a1], ...RT(0, Ml, Mo, 9, 180, 19)], VO = [[0.04, -0.01], [0.0405, -0.022, 3e-3], [0.033, -0.036, 6e-3], [0.011, -0.104, 8e-3], [-0.04, -0.1, 0.01], [-0.016, -0.034, 0.03], [-5e-3, -4e-3, 8e-3], [-0.018, 4e-3, 3e-3], [-0.016, 9e-3], [0.03, -6e-3]], GO = [[-0.058, 0.018, 2e-3], [0.0925, 0.018], [0.0925, -0.012, 2e-3], [0.04, -0.012], [0.034, -7e-3], [-4e-3, -7e-3], [-0.018, 4e-3, 6e-3], [-0.058, 0.013, 4e-3]], WO = Sc([[0.037, -0.028], [0.046, -0.0425], [0.074, -0.0445], [0.0885, -0.038], [0.0905, -0.01]], 36e-4), qO = Sc([[0.0665, -0.011], [0.0642, -0.018], [0.0628, -0.025], [0.063, -0.031], [0.0652, -0.0365]], 42e-4), KO = [[0.0955, 0.018], [0.1375, 0.018], [0.1392, -0.03, 2e-3], [0.0965, -0.0345, 2e-3]], o00 = [[0.0955, 0.018], [0.1375, 0.018], [0.1392, -0.03, 2e-3], [0.1347, -0.0305], [0.1347, 0.0125], [0.0983, 0.0125], [0.0983, -0.0343], [0.0965, -0.0345, 2e-3]], dk = [[0.0955, 0.018], [0.1375, 0.018], [0.138, -0.013, 3e-3], [0.0958, -0.016, 3e-3]], XO = [[0.094, -0.0345], [0.0975, -0.0345], [0.0978, -0.05], [0.0966, -0.06, 2e-3], [0.0936, -0.068, 2e-3], [0.0884, -0.0698, 15e-4], [0.0876, -0.0668, 15e-4], [0.0922, -0.0605, 2e-3], [0.0938, -0.05]], LO = [[-0.168, 0.066, 6e-3], [-0.181, 0.062, 6e-3], [-0.183, -0.046, 8e-3], [-0.17, -0.052, 6e-3], [-0.1635, -0.02, 0.012], [-0.1635, 0.04, 0.012]], DO = [[-0.0745, 0.062], [-0.186, 0.066, 8e-3], [-0.191, -0.03, 8e-3], [-0.18, -0.036, 4e-3], [-0.0745, 0.026]], i00 = [[-0.084, 0.055], [-0.179, 0.0585, 5e-3], [-0.183, -0.022, 5e-3], [-0.178, -0.026, 3e-3], [-0.084, 0.034]], zp = (o) => Sr + Hy * Math.max(0, Cp - o) ** 2;
function xk(o, t = Dy, e = 0.012) {
  let s = t > Cp ? [[Sr, t]] : [];
  for (let n = Math.min(Cp, t); n > o + 4e-3; n -= e) s.push([zp(n), n]);
  return s.push([zp(o), o]), s;
}
var a00 = (o) => Sc(xk(Pp[o] ?? Pp.std), za);
function AT(o) {
  let t = Pp[o] ?? Pp.std, e = 2 * Hy * (Cp - t), s = Math.hypot(e, 1);
  return { o: [zp(t), t], t: [e / s, -1 / s], n: [1 / s, e / s] };
}
var r00 = (o) => {
  let t = AT(o), e = [t.o[0] - t.t[0] * 1e-3, t.o[1] - t.t[1] * 1e-3], s = [t.o[0] + t.t[0] * 42e-4, t.o[1] + t.t[1] * 42e-4];
  return Sc([e, s], za + 52e-4);
}, kp = { r: 26e-4, d: 11e-4, w: 23e-4, c: 82e-4, wall: 9e-4, seam: -52e-4 }, _T = (o, t, e) => {
  let s = Math.min(1, Math.max(0, (e - o) / (t - o)));
  return s * s * (3 - 2 * s);
};
function w2(o, t, e, s = new THREE.Vector3()) {
  let n = 2 * Hy * Math.max(0, Cp - e), i = Math.hypot(n, 1);
  return s.set(o, e + t * n / i, -(zp(e) + t / i));
}
var F5 = (o) => Math.atan(2 * Hy * Math.max(0, Cp - o));
function IO(o, t) {
  let e = nr / 2, s = za / 2, n = kp.r, i = [], a = (l, c, h, f) => {
    for (let u of [1, 2]) {
      let d = Ze(h + f * 30 * u);
      i.push([l + Math.cos(d) * n, c + Math.sin(d) * n, 2]);
    }
  }, r = () => {
    let l = [[s - n, 0, 2]];
    for (let c of [kp.c, -kp.c]) {
      for (let [h, f, u] of [[1.4, 0, 1], [1, 0.05, 2], [0.55, 0.82, 1], [0, 1, 1], [-0.55, 0.82, 1], [-1, 0.05, 2], [-1.4, 0, 1]]) l.push([c + h * kp.w, f * o * kp.d, o > 0.5 ? u : 1]);
      c > 0 && l.push([0, 0, 1]);
    }
    return l.push([-(s - n), 0, 2]), l;
  };
  for (let [l, c, h] of r()) i.push([e - c, l, h]);
  a(e - n, -s + n, 0, -1), i.push([e - n, -s, 2]);
  for (let [l, c, h] of [[17e-4, 0, 1], [8e-4, 0.8, 2], [0, 1, 1], [-8e-4, 0.8, 2], [-17e-4, 0, 1]]) i.push([kp.seam + l, -s - 6e-4 * c * t, t > 0.5 ? h : 1]);
  i.push([-e + n, -s, 2]), a(-e + n, -s + n, -90, -1);
  for (let [l, c, h] of r().reverse()) i.push([-e + c, l, h]);
  return a(-e + n, s - n, 180, -1), i.push([-e + n, s, 2], [0, s, 1], [e - n, s, 2]), a(e - n, s - n, 90, -1), i;
}
function l00(o) {
  let t = [Dy, -0.01, Cp, -0.03, -0.036, -0.04, -0.044, -0.05];
  for (let M = -0.059; M > o + 0.024; M -= 9e-3) t.push(M);
  t.push(o + 0.018, o + 0.014, o + 0.01, o + 5e-3, o);
  let e = [], s = [], n = [], i = new THREE.Vector3(), a = 0;
  for (let M of t) {
    let w = IO(_T(-0.036, -0.046, M) * _T(o + 8e-3, o + 0.017, M), _T(-0.03, -0.038, M) * _T(o + 2e-3, o + 8e-3, M));
    a = w.length;
    for (let [T, S, E] of w) w2(T, S, M, i), e.push(i.x, i.y, i.z), s.push(E, E, E);
  }
  for (let M = 0; M < t.length - 1; M++) for (let w = 0; w < a; w++) {
    let T = M * a + w, S = M * a + (w + 1) % a, E = T + a, _ = S + a;
    n.push(T, E, S, S, E, _);
  }
  let r = (M, w, T) => {
    let S = new THREE.BufferGeometry();
    return S.setAttribute("position", new THREE.Float32BufferAttribute(M, 3)), S.setAttribute("color", new THREE.Float32BufferAttribute(w, 3)), S.setIndex(T), S.computeVertexNormals(), S;
  }, l = r(e, s, n);
  if (l.attributes.normal.getX(3 * a) < 0) {
    for (let M = 0; M < n.length; M += 3) {
      let w = n[M + 1];
      n[M + 1] = n[M + 2], n[M + 2] = w;
    }
    l = r(e, s, n);
  }
  let c = IO(0, 0), h = (nr / 2 - kp.wall) / (nr / 2), f = (za / 2 - kp.wall) / (za / 2), u = [], d = [], m = [], p = [], x = [], g = [], b = 45e-4;
  c.forEach(([M, w], T) => {
    w2(M, w, Dy, i), u.push(i.x, i.y, i.z), w2(M * h, w * f, Dy, i), u.push(i.x, i.y, i.z), d.push(2, 2, 2, 2, 2, 2), p.push(i.x, i.y, i.z, i.x, i.y - b, i.z), x.push(1, 1, 1, 1, 1, 1);
  });
  let v = c.length;
  for (let M = 0; M < v; M++) {
    let w = 2 * M, T = 2 * ((M + 1) % v);
    m.push(w, w + 1, T, T, w + 1, T + 1), g.push(w, w + 1, T, T, w + 1, T + 1);
  }
  p.push(0, Dy - b, -Sr), x.push(1, 1, 1);
  for (let M = 0; M < v; M++) g.push(2 * v, 2 * ((M + 1) % v) + 1, 2 * M + 1);
  let y = (M, w) => {
    M.computeVertexNormals();
    let T = M.attributes.normal, S = 0;
    for (let E = 0; E < T.count; E++) S += T.getY(E);
    if (S < 0 === w) {
      let E = M.index.array;
      for (let _ = 0; _ < E.length; _ += 3) {
        let R = E[_ + 1];
        E[_ + 1] = E[_ + 2], E[_ + 2] = R;
      }
      M.computeVertexNormals();
    }
    return M;
  };
  return { body: Qe(l), rim: Qe(y(r(u, d, m), true)), cavity: Qe(y(r(p, x, g), true)) };
}
function HO(o, t, e, s, n, i = 14) {
  t.add(o.brass, ni([[n, 12e-4], [n, 49e-4 * 0.93], [n + 4e-4, 49e-4], [n + 13e-4, 49e-4], [n + 15e-4, 49e-4 * 0.86], [n + 24e-4, 49e-4 * 0.86], [n + 31e-4, 49e-4], [n + 0.019, 49e-4 * 0.985], [n + 0.019, 49e-4 * 0.91]], { x: e, y: s, seg: i, crease: 0.9 })), t.add(o.copper, ni([[n + 0.0188, 49e-4 * 0.905], [n + 0.0212, 49e-4 * 0.9], [n + 0.024, 49e-4 * 0.8], [n + 0.0265, 49e-4 * 0.62], [n + 0.0283, 49e-4 * 0.4], [n + 0.0293, 49e-4 * 0.17], [n + 0.0295, 6e-5]], { x: e, y: s, seg: i, crease: 1.4 }));
}
function Ap(o, t, e, s, n = 14) {
  let i = new THREE.CircleGeometry(o, n);
  return i.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), e)), i.translate(t.x + e.x * s, t.y + e.y * s, t.z + e.z * s), Qe(i);
}
var c00 = { camo: "factory", optic: "irons", muzzle: "none", underbarrel: "none", magazine: "std", stock: "std" }, ck = { optic: ["irons", "reflex", "holo"], muzzle: ["none", "suppressor", "comp"], underbarrel: ["none", "vgrip", "laser"], magazine: ["std", "ext", "fast"], stock: ["std", "light"] };
function h00(o) {
  let t = { ...c00, ...o || {} };
  for (let e in ck) ck[e].includes(t[e]) || (t[e] = ck[e][0]);
  return t.camo || (t.camo = "factory"), t;
}
var f00 = (o) => [o.optic, o.muzzle, o.underbarrel, o.magazine, o.stock].join("."), pk = "", F4 = null, Ah = (o) => {
  pk = o;
};
function I4() {
  let o = /* @__PURE__ */ new Map();
  return { map: o, add(t, ...e) {
    let s = o.get(t);
    s || o.set(t, s = []);
    for (let n of e) n && (s.push(n), F4 && (F4[pk] = (F4[pk] || 0) + (n.index ? n.index.count : n.attributes.position.count) / 3));
  }, build(t, e) {
    for (let [s, n] of o) {
      let i = !!s.userData.camo, a = i || !!s.userData.finish, r = s.userData.wear || 1;
      for (let h of n) {
        let f = h.attributes.color.array;
        for (let u = 0; u < f.length; u += 3) {
          let d = f[u] > 1.5 ? a ? 2 : r : 1;
          f[u] = f[u + 1] = f[u + 2] = d;
        }
      }
      let l = n.length > 1 ? Vn(n, false) : n[0];
      e && l.translate(-e.x, -e.y, -e.z), i && (l = Rc(l, e ? new THREE.Matrix4().makeTranslation(e.x, e.y, e.z) : null));
      let c = new THREE.Mesh(l, s);
      c.castShadow = !s.transparent, c.receiveShadow = !s.transparent, s.userData.keep && (c.userData.keep = true, c.name = s.userData.keep), s.transparent && (c.renderOrder = 2), t.add(c);
    }
    o.clear();
  } };
}
function u00() {
  let t = _n(9109), e = Re(77), s = new Uint8Array(256 * 256 * 4), n = new Float32Array(256 * 256);
  for (let a = 0; a < 170; a++) {
    let r = e() * 256, l = e() * 256, c = (e() - 0.5) * 0.6 + (e() < 0.8 ? 0 : 1.57), h = 3 + e() * 30, f = Math.cos(c), u = Math.sin(c), d = 0.35 + e() * 0.65;
    for (let m = 0; m < h; m++) {
      let p = ((l | 0) + 256) % 256 * 256 + ((r | 0) + 256) % 256;
      n[p] = Math.max(n[p], d * (1 - Math.abs(m / h - 0.5) * 1.2)), r += f, l += u;
    }
  }
  for (let a = 0; a < 256; a++) for (let r = 0; r < 256; r++) {
    let l = (a * 256 + r) * 4, c = t.fbm(r / 20, a / 20, 4, Math.round(256 / 20)), h = t.fbm(r / 3.1, a / 3.1, 2, Math.round(256 / 3.1));
    s[l] = Math.min(1, c * 0.62 + h * 0.3 + n[a * 256 + r] * 0.55) * 255, s[l + 1] = t.fbm(r / 34 + 5, a / 34, 3, Math.round(256 / 34)) * 255, s[l + 2] = t.fbm(r / 60 + 11, a / 60 + 3, 3, Math.round(256 / 60)) * 255, s[l + 3] = Math.min(1, n[a * 256 + r] * 1.4) * 255;
  }
  let i = new THREE.DataTexture(s, 256, 256, THREE.RGBAFormat, THREE.UnsignedByteType);
  return i.wrapS = i.wrapT = THREE.RepeatWrapping, i.magFilter = THREE.LinearFilter, i.minFilter = THREE.LinearMipmapLinearFilter, i.generateMipmaps = true, i.anisotropy = 4, i.needsUpdate = true, i;
}
function H4(o, t, e) {
  let s = new THREE.MeshStandardMaterial({ color: t.color, metalness: t.metal, roughness: t.rough, vertexColors: true, normalMap: t.n.normalMap, roughnessMap: t.n.roughnessMap, normalScale: new THREE.Vector2(t.ns, t.ns) }), n = { uWearMap: { value: e }, uWear: { value: new THREE.Vector4(t.wear[0], t.wear[1], t.wear[2] ?? 1, 1 / (t.tile || 0.09)) }, uBareCol: { value: new THREE.Color(t.bare) }, uBareRM: { value: new THREE.Vector2(t.bareRM[0], t.bareRM[1]) }, uEdge: { value: new THREE.Vector2(t.edge[0], t.edge[1]) }, uVar: { value: new THREE.Vector3(t.tone ?? 0.3, t.sheen ?? 0.45, t.scratch ?? 0.25) } };
  return s.onBeforeCompile = (i) => {
    Object.assign(i.uniforms, n), i.vertexShader = i.vertexShader.replace("#include <common>", `#include <common>
varying vec3 vSmgP; varying vec3 vSmgN;`).replace("#include <begin_vertex>", `#include <begin_vertex>
vSmgP = position; vSmgN = normal;`), i.fragmentShader = i.fragmentShader.replace("#include <common>", `#include <common>
varying vec3 vSmgP; varying vec3 vSmgN; uniform sampler2D uWearMap; uniform vec4 uWear; uniform vec3 uBareCol; uniform vec2 uBareRM; uniform vec2 uEdge; uniform vec3 uVar;
vec4 smgTri( vec3 p, vec3 w ) { return texture2D( uWearMap, p.zy ) * w.x + texture2D( uWearMap, p.zx ) * w.y + texture2D( uWearMap, p.xy ) * w.z; }`).replace("#include <color_fragment>", `float smgEdge = 0.0;
#ifdef USE_COLOR
	smgEdge = smoothstep( 1.05, 1.9, vColor.r );
#endif`).replace("#include <metalnessmap_fragment>", `#include <metalnessmap_fragment>
{
	vec3 sw = pow( abs( normalize( vSmgN ) ), vec3( 4.0 ) ); sw /= ( sw.x + sw.y + sw.z );
	vec4 kw = smgTri( vSmgP * uWear.w, sw );
	vec4 kv = smgTri( vSmgP * uWear.w * 0.23 + vec3( 0.37, 0.11, 0.53 ), sw );
	float lvl = mix( uWear.x, uWear.y, smgEdge );
	float kt = smoothstep( 0.98 - lvl, 1.08 - lvl, kw.r * 0.8 + kv.r * 0.2 ) * step( 0.001, lvl ) * uWear.z;
	diffuseColor.rgb *= 1.0 + uEdge.x * smgEdge;                                  // burnished edges even where the finish holds
	roughnessFactor *= 1.0 - uEdge.y * smgEdge;
	diffuseColor.rgb *= 1.0 - 0.5 * uVar.x + uVar.x * kv.b;                        // tone drifts across a panel
	roughnessFactor = clamp( roughnessFactor * ( 1.0 - 0.5 * uVar.y + uVar.y * kv.g ) - uVar.z * kw.a * 0.5, 0.05, 1.0 );   // sheen: handled areas, scratches
	diffuseColor.rgb = mix( diffuseColor.rgb, uBareCol, kt );
	roughnessFactor = mix( roughnessFactor, uBareRM.x, kt ); metalnessFactor = mix( metalnessFactor, uBareRM.y, kt );
}`);
  }, s.customProgramCacheKey = () => "smg-finish-1", s.name = "smg:" + o, s.userData = { base: new THREE.Color(t.color).lerp(new THREE.Color(t.bare), 0.06), wear: t.worldWear ?? 1.5, finish: true, U: n }, s;
}
var hk = null;
function bk() {
  if (hk) return hk;
  let o = ao(), t = u00(), e = { ...o }, s = (n, i, a, r, l) => {
    let c = n.clone();
    return c.color.set(i), c.metalness = a, c.roughness = r, c.userData = { base: new THREE.Color(i), wear: l }, c;
  };
  return e.recv = H4("recv", { color: 3158582, metal: 0.22, rough: 0.58, n: o.alu, ns: 0.22, wear: [0.07, 0.5, 1], bare: 10132898, bareRM: [0.3, 1], edge: [0.42, 0.3], tile: 0.085, tone: 0.34, sheen: 0.55, scratch: 0.5 }, t), e.steel = H4("phos", { color: 3816512, metal: 0.42, rough: 0.64, n: o.steel, ns: 0.3, wear: [0.07, 0.5, 1], bare: 11119792, bareRM: [0.34, 1], edge: [0.5, 0.25], tile: 0.06, tone: 0.3, sheen: 0.4, scratch: 0.4 }, t), e.mag = H4("mag", { color: 3421754, metal: 0.38, rough: 0.6, n: o.alu, ns: 0.14, wear: [0.06, 0.44, 1], bare: 10264484, bareRM: [0.4, 1], edge: [0.35, 0.2], tile: 0.07, tone: 0.3, sheen: 0.45, scratch: 0.45 }, t), e.poly = H4("poly", { color: 3486771, metal: 0, rough: 0.64, n: o.poly, ns: 0.3, wear: [0.05, 0.36, 0.8], bare: 7894901, bareRM: [0.78, 0], edge: [0.4, 0.14], tile: 0.1, tone: 0.24, sheen: 0.36, scratch: 0.2 }, t), e.grip = H4("grip", { color: 3092013, metal: 0, rough: 0.76, n: o.grip, ns: 0.9, wear: [0.04, 0.3, 0.8], bare: 7631729, bareRM: [0.6, 0], edge: [0.35, 0.2], tile: 0.1, tone: 0.2, sheen: 0.5, scratch: 0.1 }, t), e.alu = H4("alu", { color: 3421754, metal: 0.35, rough: 0.5, n: o.alu, ns: 0.2, wear: [0.08, 0.6, 1], bare: 12764359, bareRM: [0.36, 1], edge: [0.5, 0.3], tile: 0.07, tone: 0.2, sheen: 0.4, scratch: 0.4 }, t), e.aluLt = e.alu, e.rubber = s(o.rubber, 2828841, 0, 0.9, 1.25), e.pin = s(o.steelBright, 6974834, 0.9, 0.42, 1.2), hk = e;
}
var fk = null;
function YO() {
  if (fk) return fk;
  let o = bk(), t = we(512, 256), e = t.getContext("2d"), s = {}, n = (d, m, p, x, g, b) => {
    e.save(), e.translate(m, p), b(x, g), e.restore(), s[d] = [m / 512, 1 - (p + g) / 256, (m + x) / 512, 1 - p / 256];
  }, i = (d, m = 600) => `${m} ${d}px Bahnschrift, "Segoe UI", Arial, sans-serif`, a = (d, m, p, x) => {
    e.beginPath(), e.moveTo(d, m + x), e.lineTo(d, m + x * 0.38), e.quadraticCurveTo(d, m + x * 0.1, d + p / 2, m), e.quadraticCurveTo(d + p, m + x * 0.1, d + p, m + x * 0.38), e.lineTo(d + p, m + x), e.closePath(), e.fill();
  }, r = (d, m, p) => {
    e.strokeStyle = p, e.lineWidth = 5, e.beginPath(), e.roundRect(4, 4, d - 8, m - 8, 9), e.stroke();
  };
  n("safe", 0, 0, 96, 72, (d, m) => {
    r(d, m, "#e9e9e4"), e.fillStyle = "#e9e9e4", a(38, 14, 20, 44), e.strokeStyle = "#e9e9e4", e.lineWidth = 5, e.beginPath(), e.moveTo(20, 56), e.lineTo(76, 16), e.stroke();
  }), n("semi", 96, 0, 96, 72, (d, m) => {
    r(d, m, "#d2301f"), e.fillStyle = "#d2301f", a(38, 14, 20, 44);
  }), n("auto", 192, 0, 160, 72, (d, m) => {
    r(d, m, "#d2301f"), e.fillStyle = "#d2301f";
    for (let p = 0; p < 5; p++) a(18 + p * 26, 14, 18, 44);
  }), e.fillStyle = "#fff", e.textBaseline = "middle", n("proof", 0, 80, 224, 48, () => {
    e.font = i(30, 700), e.fillText("GH", 4, 26), e.beginPath(), e.moveTo(66, 38), e.lineTo(80, 10), e.lineTo(94, 38), e.closePath(), e.lineWidth = 3, e.strokeStyle = "#fff", e.stroke(), e.font = i(26), e.fillText("11/26  N", 108, 26);
  }), n("made", 224, 80, 288, 48, () => {
    e.font = i(20), e.fillText("GH-ARMS \xB7 SOLSTICE WORKS", 4, 26);
  }), n("cal", 0, 136, 200, 44, () => {
    e.font = i(30, 700), e.fillText("9 mm \xD7 19", 4, 24);
  }), n("n32", 208, 136, 64, 44, () => {
    e.font = i(30, 700), e.fillText("32", 6, 24);
  }), n("n48", 272, 136, 64, 44, () => {
    e.font = i(30, 700), e.fillText("48", 6, 24);
  }), n("drum", 0, 188, 256, 40, () => {
    e.font = i(26, 700), ["1", "2", "3", "4"].forEach((d, m) => e.fillText(d, 10 + m * 64, 22));
  }), ["10", "20", "30", "40"].forEach((d, m) => n("w" + d, 264 + m * 60, 188, 56, 40, () => {
    e.font = i(30, 700), e.fillText(d, 6, 22);
  })), n("dot", 352, 0, 32, 32, () => {
    e.beginPath(), e.arc(16, 16, 11, 0, 6.3), e.fill();
  }), n("line", 392, 0, 64, 16, () => {
    e.fillRect(2, 4, 60, 8);
  });
  let l = makeCanvasTexture(t);
  l.anisotropy = 8, l.colorSpace = THREE.SRGBColorSpace;
  let c = new THREE.MeshStandardMaterial({ map: l, color: 13224910, transparent: true, roughness: 0.55, metalness: 0.1, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  c.userData = { base: new THREE.Color(9079952), wear: 1, cells: s };
  let h = ff(64, (d, m) => 0.5 + 0.5 * Math.sin(d * Math.PI / 8 + Math.sin(m * Math.PI / 16) * 0.9), 3.2, () => 0.62), f = ao().steel.clone();
  f.normalMap = x2(h.n, 170), f.roughnessMap = x2(h.r, 170), f.normalScale = new THREE.Vector2(1.1, 1.1), f.color.set(6974834), f.metalness = 0.7, f.roughness = 0.5, f.userData = { base: new THREE.Color(6974834), wear: 1.3 };
  let u = ao().poly.clone();
  return u.color.set(11817498), u.userData = { base: new THREE.Color(11817498), wear: 1.1 }, fk = { mark: c, weld: f, orange: u };
}
function D5(o, t, e, s, n, i, a) {
  let r = YO().mark.userData.cells[o], l = new THREE.PlaneGeometry(t, e), c = l.attributes.uv;
  for (let h = 0; h < c.count; h++) c.setXY(h, r[0] + c.getX(h) * (r[2] - r[0]), r[1] + c.getY(h) * (r[3] - r[1]));
  return l.rotateY(a < 0 ? -Math.PI / 2 : Math.PI / 2), l.translate(s, n, -i), Qe(l);
}
function Ly(o, t, e, s, n, i = 12) {
  let a = Wn(o, e - t, { x: (t + e) / 2, seg: i });
  return a.rotateZ(Ze(s)), a.translate(0, vo, -n), a;
}
function uk(o, t, e, s, n = 20) {
  return [...RT(0, 0, o, e, s, n), ...RT(0, 0, t, s, e, n)];
}
function d00(o, t, e, s, n, i, a = 5, r = 2) {
  let l = () => ({ p: [], n: [], u: [] }), c = l(), h = l(), f = new THREE.Vector3(), u = new THREE.Vector3(), d = new THREE.Vector3(), m = new THREE.Vector3(), p = new THREE.Vector3(), x = new THREE.Vector3(), g = (v, y, M, w) => {
    f.fromArray(y.p), u.fromArray(M.p), d.fromArray(w.p), m.fromArray(y.n).add(p.fromArray(M.n)).add(x.fromArray(w.n));
    let T = p.subVectors(u, f).cross(x.subVectors(d, f)).dot(m) < 0;
    for (let S of T ? [y, w, M] : [y, M, w]) v.p.push(...S.p), v.n.push(...S.n), v.u.push(...S.u);
  };
  for (let v = 0; v < 4; v++) {
    let y = v * Math.PI / 2, M = Math.cos(y), w = Math.sin(y), T = i[v], S = (C, L, A) => [C * M + A * w, L, -C * w + A * M], E = (C, L, A) => {
      let O = C * Math.SQRT1_2, H = [];
      for (let z = 0; z < a; z++) H.push([-O + 2 * O * z / a, e]);
      for (let z = 0; z < a; z++) H.push([O, e + (s - e) * z / a]);
      for (let z = 0; z < a; z++) H.push([O - 2 * O * z / a, s]);
      for (let z = 0; z < a; z++) H.push([-O, s - (s - e) * z / a]);
      let F = H.length, P = [];
      for (let z = 0; z < F; z++) {
        let k = H[z], I = k[0], G = k[1] - n, K = Math.hypot(I, G), $ = I / K * T, n0 = n + G / K * T, e0 = [];
        for (let p0 = 0; p0 <= r; p0++) {
          let t0 = $ + (k[0] - $) * p0 / r, M0 = n0 + (k[1] - n0) * p0 / r, f0 = Math.sqrt(Math.max(C * C - t0 * t0, 0));
          e0.push({ p: S(t0, M0, f0), n: S(L * t0 / C, 0, L * f0 / C), u: [C * (Math.asin(t0 / C) + y), M0] });
        }
        P.push(e0);
      }
      for (let z = 0; z < F; z++) for (let k = 0; k < r; k++) {
        let I = (z + 1) % F;
        g(A, P[z][k], P[z][k + 1], P[I][k + 1]), g(A, P[z][k], P[I][k + 1], P[I][k]);
      }
    };
    E(o, 1, c), E(t, -1, h);
    let _ = 20, R = [];
    for (let C = 0; C <= _; C++) {
      let L = C / _ * Math.PI * 2, A = T * Math.cos(L), O = n + T * Math.sin(L), H = S(-Math.cos(L), -Math.sin(L), 0);
      R.push([{ p: S(A, O, Math.sqrt(o * o - A * A)), n: H, u: [C / _ * 0.03, 0] }, { p: S(A, O, Math.sqrt(t * t - A * A)), n: H, u: [C / _ * 0.03, 2e-3] }]);
    }
    for (let C = 0; C < _; C++) g(c, R[C][0], R[C][1], R[C + 1][1]), g(c, R[C][0], R[C + 1][1], R[C + 1][0]);
  }
  let b = (v) => {
    let y = new THREE.BufferGeometry();
    return y.setAttribute("position", new THREE.Float32BufferAttribute(v.p, 3)), y.setAttribute("normal", new THREE.Float32BufferAttribute(v.n, 3)), y.setAttribute("uv", new THREE.Float32BufferAttribute(v.u, 2)), Qe(y);
  };
  return { wall: b(c), liner: b(h) };
}
function jO(o, t) {
  let e = bk(), s = YO(), n = new THREE.Group(), i = {}, a = I4();
  n.name = "gun_smg";
  let r = (H0 = {}) => t ? H0 : { ...H0, b: (H0.b ?? 8e-4) >= 14e-4 ? H0.b : 0, bs: 1, cs: 3, holes: H0.keepHoles ? H0.holes : null }, l = (H0) => t ? H0 : H0.map((Y0) => Y0[2] && Y0[2] < 3e-3 ? [Y0[0], Y0[1]] : Y0), c = (H0, Y0, et) => us(l(H0), Y0, r(et)), h = (H0, Y0, et) => si(l(H0), Y0, r(et)), f = (H0, Y0, et) => jc(l(H0), Y0, r(et)), u = (H0 = {}, Y0 = 16) => t ? H0 : { ...H0, seg: Math.max(6, (H0.seg || Y0) >> 1) }, d = (H0, Y0, et) => fa(H0, Y0, u(et, 16)), m = (H0, Y0) => ni(H0, u(Y0, 20)), p = (H0, Y0, et) => Wn(H0, Y0, u(et, 12)), x = (H0, Y0, et) => T5(H0, Y0, u(et, 12)), g = o.camo && o.camo !== "factory" ? o.camo : null, b = (H0, Y0) => g && xl(g, t ? H0 : "metal") || Y0, v = b("metal", e.recv), y = b("polymer", e.poly), M = b("furniture", e.grip), w = b("metal", e.mag), T = (H0, Y0, et, ct = false) => {
    if (!t) return ct || et(a), null;
    let D0 = Du(n, i, H0, Y0), u0 = I4();
    return et(u0), u0.build(D0, Y0), D0;
  }, S = { gripR: new THREE.Object3D(), gripL: new THREE.Object3D() }, E = {};
  S.gripR.name = "gripR", S.gripL.name = "gripL", n.add(S.gripR, S.gripL);
  let att = {}, _ = (H0, Y0) => {
    let et = new THREE.Object3D();
    return et.name = "mount_" + H0, et.position.copy(Y0), n.add(et), E[H0] = et, et;
  }, R = {}, C = null, L = (H0) => (H0.group.updateMatrixWorld(true), new THREE.Box3().setFromObject(H0.group)), A = (H0, Y0) => (Y0.add(H0.group), g && Ou && Ou(H0, g), H0), O = (H0, Y0, et = 2e-3) => {
    let ct = H0.getCenter(new THREE.Vector3()).add(Y0), D0 = H0.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    return Zn([ct.x, ct.y, ct.z], [D0.x, D0.y, D0.z], et);
  };
  Ah("receiver");
  let H = UO(t ? 20 : 10);
  if (t) {
    a.add(v, h(H, i1 + 0.06, { u: -0.06, b: 0, soft: true }), h(n00(), wf - i1, { u: i1, b: 0, soft: true }), h(H, 0.17 - wf, { u: wf, b: 0, soft: true }));
    let H0 = Mo - 15e-4 - H5, Y0 = (H5 + Mo - 15e-4) / 2;
    a.add(e.black, c(se(i1, I1, wf, a1), 4e-4, { x: H5 + 2e-4, b: 0 })), a.add(e.black, c(se(i1, I1, wf, I1 + 4e-4), H0, { x: Y0, b: 0 }), c(se(i1, a1 - 4e-4, wf, a1), H0, { x: Y0, b: 0 })), a.add(e.black, h(se(H5, I1, Mo - 15e-4, a1), 4e-4, { u: i1, b: 0 }), h(se(H5, I1, Mo - 15e-4, a1), 4e-4, { u: wf - 4e-4, b: 0 })), a.add(v, c(se(i1 - 45e-4, I1 - 4e-3, wf + 45e-4, a1 + 2e-3, 45e-4), 13e-4, { x: Mo + 2e-4, b: 5e-4, cs: 2, holes: [se(i1, I1, wf, a1, 2e-3)] })), a.add(v, c([[i1 - 0.02, I1 + 4e-3, 3e-3], [i1 - 6e-3, I1 + 2e-3, 2e-3], [i1 - 6e-3, a1 - 3e-3, 2e-3], [i1 - 0.02, a1 - 7e-3, 3e-3]], 3e-3, { x: Mo + 8e-4, b: 13e-4, bs: 2 })), a.add(e.steel, d(92e-4, 9e-3, { y: Cs, u: 0.1125, seg: 16 })), a.add(e.black, d(53e-4, 4e-4, { y: Cs, u: 0.1121, seg: 12 }));
    let et = (ct, D0, u0, w0, P0, st = 13e-4) => c(se(ct, u0, D0, w0, (w0 - u0) * 0.49), st, { x: P0 * (Mo + 2e-4), b: 6e-4, cs: 2 });
    a.add(v, et(-0.046, 0.152, 0.044, 0.0496, -1), et(-0.046, 0.058, 0.0245, 0.029, -1), et(-0.046, 0.04, 0.044, 0.0496, 1), et(0.13, 0.16, 0.0385, 0.0445, 1), et(-0.046, 0.058, 0.0245, 0.029, 1));
    for (let ct of [-6e-3, 0.096]) for (let D0 of [48, 132]) {
      let u0 = c(se(ct - 7e-3, -35e-4, ct + 7e-3, 35e-4, 12e-4), 5e-4, { x: Mo + 5e-5, b: 0 });
      u0.translate(0, Ml, 0), a.add(e.black, xh(u0, D0, Ml));
    }
    for (let [ct, D0] of [[0.14, 0.0235], [0.16, 0.0235], [0.15, 0.034]]) for (let u0 of [-1, 1]) a.add(e.pin, p(24e-4, 1e-3, { x: u0 * (Mo + 3e-4), y: D0, u: ct, seg: 8 }));
    a.add(e.pin, p(3e-3, 0.04, { y: 0.0225, u: -0.052, seg: 8 }), p(44e-4, 12e-4, { x: -(Mo + 4e-4), y: 0.0225, u: -0.052, seg: 10 })), a.add(e.mark, x4("smg", 0.046, 0.019, -(Mo + 35e-5), 0.0335, 0.112, -1)), a.add(s.mark, D5("proof", 0.022, 47e-4, -(Mo + 35e-5), 0.0205, 0.076, -1), D5("made", 0.04, 66e-4, Mo + 35e-5, 0.0225, 0.094, 1));
    for (let ct of [-1, 1]) a.add(s.weld, c(se(0.097, 0.0168, 0.136, 0.0186, 8e-4), 12e-4, { x: ct * 0.0169, b: 5e-4 }));
  } else a.add(v, h(H, 0.23, { u: -0.06, b: 0, soft: true })), a.add(e.steelBright, c(se(i1, I1, wf - 8e-3, a1), 8e-4, { x: Mo, b: 0 }));
  {
    let H0 = (Iy + sr) / 2, Y0 = (et) => H.map((ct) => [ct[0] * et, H0 + (ct[1] - H0) * (1 + (et - 1) * 0.9), ct[2]]);
    if (a.add(v, h(Y0(1.05), 0.015, { u: -0.0745, b: t ? 16e-4 : 3e-3, bs: 2, soft: true })), t) {
      a.add(v, h(Y0(1.05), 24e-4, { u: -0.0769, b: 1e-3, bs: 2, cs: 3, holes: [Y0(0.84)] })), a.add(v, h(Kr(0, Ml, 0.0118, 24), 1e-3, { u: -0.0755, b: 5e-4, holes: [Kr(0, Ml, 79e-4, 20)] })), a.add(e.steel, m([[-0.0774, 1e-4], [-0.0774, 52e-4], [-0.0768, 63e-4], [-0.0745, 68e-4]], { y: Ml, seg: 20 })), a.add(e.black, c(se(-0.07765, Ml - 6e-4, -0.0772, Ml + 6e-4), 86e-4, { b: 0 }));
      for (let et of [45, 165, 285]) a.add(e.black, d(7e-4, 3e-4, { x: Math.cos(Ze(et)) * 96e-4, y: Ml + Math.sin(Ze(et)) * 96e-4, u: -0.0758, seg: 6 }));
      a.add(s.weld, h(Y0(1.062), 16e-4, { u: -0.0606, b: 6e-4, holes: [Y0(1)] }));
      for (let et of [62, 118]) {
        let ct = x(19e-4, 5e-4, { y: Ml + Mo * 1.045 - 1e-4, u: -0.0672, seg: 8 });
        a.add(e.black, xh(ct, et - 90, Ml));
      }
      a.add(e.steel, c([[-0.0736, 0.057, 1e-3], [-0.064, 0.057, 1e-3], [-0.064, 0.065, 2e-3], [-0.0736, 0.065, 2e-3]], 3e-3, { x: -(Mo * 1.05 + 12e-4), b: 8e-4, holes: [se(-0.0716, 0.059, -0.066, 0.063, 1e-3)] }));
      for (let et of [-1, 1]) a.add(e.pin, d(21e-4, 8e-4, { x: et * 0.0222, y: 0.031, u: -0.0753, seg: 8 }));
      for (let [et, ct, D0, u0, w0] of [["proof", 0.0105, 23e-4, -92e-4, 0.0432], ["n32", 26e-4, 18e-4, 0.0112, 0.0436]]) {
        let P0 = s.mark.userData.cells[et], st = new THREE.PlaneGeometry(ct, D0), J0 = st.attributes.uv;
        for (let q0 = 0; q0 < J0.count; q0++) J0.setXY(q0, P0[0] + J0.getX(q0) * (P0[2] - P0[0]), P0[1] + J0.getY(q0) * (P0[3] - P0[1]));
        st.translate(u0, w0, 0.0745 + 25e-5), a.add(s.mark, Qe(st));
      }
    }
  }
  Ah("bolt"), T("bolt", Gt(4e-3, 0.0415, 0.085), (H0) => {
    H0.add(e.steelBright, c(se(0.05, I1 + 12e-4, 0.1045, a1 - 14e-4, 3e-3), 0.0236, { x: 42e-4, b: 3e-3, bs: 2, cs: 2, soft: true })), H0.add(e.steelBright, c(se(0.104, 0.0305, 0.1123, 0.0415), 0.015, { x: 35e-4, b: 16e-4 })), H0.add(e.steel, c(se(0.0975, 0.034, 0.1126, 0.0376), 16e-4, { x: 0.0114, b: 0 }), p(15e-4, 14e-4, { x: 0.0116, y: 0.0358, u: 0.1, seg: 6 })), H0.add(e.black, c(m4(0.079, 0.0462, 0.022, 34e-4), 4e-4, { x: 0.0161, b: 0, cs: 2 }), c(m4(0.062, 0.0375, 0.01, 3e-3), 4e-4, { x: 0.0161, b: 0, cs: 2 }));
    for (let Y0 = 0; Y0 < 5; Y0++) H0.add(e.steel, c(se(0.066 + Y0 * 42e-4, 0.034, 0.0676 + Y0 * 42e-4, 0.042), 6e-4, { x: 0.0163, b: 0 }));
  }, true), T("chamberRound", Gt(0, Cs, 0.123), (H0) => {
    eT(e, H0, 0, Cs, 0.1136, 0.019, 49e-4, 0.0105), H0.add(e.steelBright, d(19e-4, 3e-4, { y: Cs, u: 0.1134, seg: 8 }));
  }, true), Ah("tube");
  let F = b("metal", e.steel), P = F1 - mk - 6e-3, z = F1 + 7e-3, k = 15;
  if (a.add(F, d(ii, P - 0.168, { y: vo, u: 0.168, seg: 20 }), d(ii, 0.334 - z, { y: vo, u: z, seg: 20 })), t ? (a.add(F, h(uk(ii, ii - 19e-4, kc + k, kc - k + 360), z - (P + 0.013), { u: P + 0.013, y: vo, b: 0, soft: true })), a.add(F, h(uk(ii, ii - 19e-4, kc + k, kc + p00(gk) - k + 360), 0.013, { u: P, y: vo, b: 0, soft: true })), a.add(e.black, d(ii - 21e-4, z - P, { y: vo, u: P, seg: 14 })), a.add(e.steel, d(52e-4, z - P, { y: vo, u: P, seg: 10 })), a.add(F, m([[0.334, ii], [0.3372, ii - 1e-3], [0.3385, ii - 36e-4], [0.3385, 1e-4]], { y: vo, seg: 20 })), a.add(F, m([[0.1655, ii + 42e-4], [0.172, ii + 42e-4], [0.1765, ii + 8e-4], [0.1765, ii - 1e-3]], { y: vo, seg: 20 })), a.add(s.weld, m([[0.1762, ii + 2e-4], [0.1772, ii + 12e-4], [0.1784, ii + 2e-4]], { y: vo, seg: 20, crease: 1.4 }))) : a.add(F, d(ii, z - P, { y: vo, u: P, seg: 20 })), T("chargingHandle", Gt(0, vo, F1), (H0) => {
    if (H0.add(e.steel, Ly(36e-4, 45e-4, 0.0215, kc, F1, 10)), H0.add(e.poly, Ly(66e-4, 0.019, 0.0385, kc, F1, 14)), t) {
      for (let Y0 of [0.0218, 0.0262, 0.0306, 0.035]) H0.add(e.poly, Ly(72e-4, Y0, Y0 + 22e-4, kc, F1, 10));
      H0.add(e.poly, Ly(52e-4, 0.0385, 0.0402, kc, F1, 12)), H0.add(e.steel, Ly(52e-4, 0.0166, 0.019, kc, F1, 12));
    }
  }), Ah("front"), a.add(e.steel, m([[0.15, 95e-4], [0.3, 95e-4], [0.3, 8e-3], [0.3355, 8e-3], [0.3355, 98e-4], [0.3495, 98e-4], [Rp, 88e-4], [Rp, 48e-4], [0.325, 48e-4]], { y: Cs })), a.add(F, c([[0.3135, Cs - 0.0118, 3e-3], [0.3345, Cs - 0.0118, 3e-3], [0.3345, vo + 4e-3], [0.3135, vo + 4e-3]], 0.015, { b: 16e-4, bs: 2 })), a.add(F, m([[0.3125, ii], [0.3135, ii + 24e-4], [0.3345, ii + 24e-4], [0.3355, ii]], { y: vo, seg: 20 }), m([[0.3125, 98e-4], [0.3135, 0.0122], [0.3345, 0.0122], [0.3355, 98e-4]], { y: Cs, seg: 18 })), o.optic === "irons") a.add(F, c([[0.3128, vo + 85e-4], [0.3352, vo + 85e-4], [0.334, Ac - 0.0122, 1e-3], [0.314, Ac - 0.0122, 1e-3]], 0.013, { b: 1e-3 })), a.add(F, h(Kr(0, 0, 0.0128, t ? 24 : 12), 0.0135, { u: 0.3172, y: Ac, keepHoles: true, holes: [Kr(0, 0, 0.0106, t ? 20 : 12)], b: 9e-4, soft: true })), a.add(e.steel, c([[0.3224, Ac - 0.0116], [0.3262, Ac - 0.0116], [0.3256, Ac], [0.3231, Ac]], 2e-3, { b: 3e-4 }));
  else if (a.add(F, c([[0.3128, vo + 85e-4], [0.3352, vo + 85e-4], [0.3338, vo + 0.014, 15e-4], [0.3142, vo + 0.014, 15e-4]], 0.013, { b: 1e-3 })), t) for (let H0 of [0.3185, 0.3295]) a.add(e.steel, x(19e-4, 6e-4, { y: vo + 0.0138, u: H0, seg: 8 }));
  if (t) {
    if (a.add(e.black, d(48e-4, 5e-4, { y: Cs, u: 0.3252, seg: 10 })), o.muzzle !== "suppressor") for (let H0 = 0; H0 < 3; H0++) a.add(e.steel, xh(bh(c(se(0.3375, 94e-4, 0.344, 0.0121), 58e-4, { b: 6e-4 }), 0, Cs, 0), H0 * 120 + 60, Cs));
    a.add(e.pin, p(22e-4, 0.0162, { y: vo + 5e-4, u: 0.319, seg: 8 }), p(22e-4, 0.0162, { y: Cs - 6e-3, u: 0.329, seg: 8 })), a.add(s.weld, m([[0.3108, ii + 2e-4], [0.3118, ii + 11e-4], [0.3128, ii + 2e-4]], { y: vo, seg: 20, crease: 1.4 }));
  }
  let I = {}, G = (H0, Y0, et, ct, D0 = 82e-4) => {
    a.add(e.pin, p(26e-4, 52e-4, { x: Y0 + 2e-3, y: et, u: ct, seg: 8 }), p(4e-3, 12e-4, { x: Y0 - 1e-3, y: et, u: ct, seg: 8 }));
    let u0 = new THREE.TorusGeometry(D0, 13e-4, t ? 5 : 4, t ? 14 : 8);
    if (u0.rotateY(Math.PI / 2), u0.translate(0, -D0 + 12e-4, 0), !t) {
      u0.translate(Y0, et, -ct), a.add(e.pin, Qe(u0));
      return;
    }
    let w0 = new THREE.Group();
    w0.name = "sling_" + H0, w0.position.copy(Gt(Y0, et, ct)), w0.userData.keep = true, n.add(w0);
    let P0 = I4();
    P0.add(e.pin, Qe(u0)), P0.build(w0), I[H0] = w0;
  };
  G("slingF", -0.0102, Cs + 0.0105, 0.324, 74e-4), G("slingR", -(Mo * 1.05 + 3e-3), 0.0445, -0.0672, 9e-3), Ah("muzzle");
  let K = Rp;
  if (_("muzzle", Gt(0, Cs, Rp)), o.muzzle === "none") {
    if (t) {
      a.add(e.steel, m([[0.3452, 98e-4], [0.346, 0.0107], [0.3512, 0.0107], [0.352, 98e-4]], { y: Cs, seg: 18 }));
      for (let H0 = 0; H0 < 18; H0++) a.add(e.steel, xh(bh(c(se(0.3464, 0.0104, 0.3508, 0.0111), 12e-4, { b: 0 }), 0, Cs, 0), H0 * 20, Cs));
    }
  } else {
    let H0 = gf(o.muzzle, { caliber: "pistol" }), Y0 = H0.radius ?? 0.0175;
    if (K = Rp + H0.length, o.muzzle === "suppressor") {
      let et = Math.min(0.0152, H0.rear ?? 0.0152);
      if (a.add(e.steel, m([[0.329, 0.01], [0.3305, et], [0.35, et], [0.3525, et - 16e-4], [0.3525, 0.01]], { y: Cs, seg: 20 })), t) {
        for (let ct = 0; ct < 12; ct++) a.add(e.steel, xh(bh(c(se(0.3325, et - 4e-4, 0.344, et + 6e-4), 26e-4, { b: 0 }), 0, Cs, 0), ct * 30, Cs));
        for (let ct = 0; ct < 3; ct++) a.add(e.black, xh(bh(c(se(0.3455, et - 5e-5, 0.3505, et + 2e-4), 52e-4, { b: 0 }), 0, Cs, 0), ct * 120 + 60, Cs));
      }
    }
    if (t) { A(H0, E.muzzle); att.muzzle = H0; }
    else if (o.muzzle === "suppressor") {
      let et = Rp, ct = K, D0 = b("metal", e.steel);
      a.add(D0, ni([[et - 2e-3, Y0 * 0.56], [et + 2e-3, Y0 * 0.78], [et + 0.016, Y0 * 0.78], [et + 0.018, Y0], [et + 0.046, Y0], [et + 0.047, Y0 * 0.93], [et + 0.05, Y0 * 0.93], [et + 0.051, Y0], [ct - 0.03, Y0], [ct - 0.029, Y0 * 0.93], [ct - 0.026, Y0 * 0.93], [ct - 0.025, Y0], [ct - 4e-3, Y0], [ct, Y0 * 0.84], [ct, Y0 * 0.42], [ct - 0.01, Y0 * 0.3]], { y: Cs, seg: 12 })), a.add(e.black, fa(Y0 * 0.3, 5e-4, { y: Cs, u: ct - 0.01, seg: 8 }));
    } else {
      let et = Rp, ct = K;
      a.add(b("metal", e.steel), ni([[et, Y0 * 0.8], [et + 3e-3, Y0], [ct - 3e-3, Y0], [ct, Y0 * 0.86], [ct, 56e-4], [ct - 0.012, 56e-4]], { y: Cs, seg: 10 }));
      for (let D0 = 0; D0 < 3; D0++) for (let u0 of [62, 118]) {
        let w0 = us(se(et + 8e-3 + D0 * 0.011, -26e-4, et + 0.014 + D0 * 0.011, 26e-4), 6e-4, { x: Y0 + 1e-4, b: 0 });
        w0.rotateZ(Ze(u0)), w0.translate(0, Cs, 0), a.add(e.black, w0);
      }
    }
    R.muzzle = ml([0, Cs, -Rp], [0, Cs, -K], Y0 + 5e-4, 2e-3);
  }
  S.muzzle = Gt(0, Cs, K), Ah("handguard");
  let $ = y, n0 = 2 * Tr * Math.tan(Math.PI / 8) + 22e-4;
  if (t) {
    let H0 = (ct, D0, u0 = I5 - 4e-3) => {
      let w0 = c(se(M2 + 8e-3, -n0 / 2, u0, n0 / 2), zO, { x: Tr - zO / 2, b: 7e-4, cs: 2, holes: D0 });
      return w0.rotateZ(Ze(ct)), w0.translate(0, Cs, 0), w0;
    }, Y0 = [m4(0.213, 0, 0.032, 7e-3), m4(0.265, 0, 0.032, 7e-3)], et = Array.from({ length: 6 }, (ct, D0) => m4(0.1965 + D0 * 0.0186, 12e-4, 0.0115, 44e-4));
    for (let ct of [0, 180, 270]) a.add($, H0(ct, Y0));
    for (let ct of [45, 135]) a.add($, H0(ct, et));
    for (let ct of [225, 315]) {
      a.add($, H0(ct, null));
      let D0 = c(se(M2 + 0.02, -7e-3, I5 - 0.018, 7e-3, 3e-3), 9e-4, { x: Tr + 3e-4, b: 4e-4, cs: 2 });
      D0.rotateZ(Ze(ct)), D0.translate(0, Cs, 0), a.add(M, D0);
    }
    a.add($, h(tT(Tr + 1e-3), 0.0125, { u: M2 - 2e-3, y: Cs, holes: [Kr(0, 0, 0.0104)], b: 1e-3 })), a.add($, h(tT(Tr + 7e-4), 52e-4, { u: I5 - 57e-4, y: Cs, holes: [Kr(0, 0, 0.01)], b: 8e-4 }));
    for (let ct of [-1, 1]) a.add(e.steel, p(3e-3, 14e-4, { x: ct * (Tr + 11e-4), y: Cs - 5e-4, u: M2 + 4e-3, seg: 10 }), p(16e-4, 18e-4, { x: ct * (Tr + 11e-4), y: Cs - 5e-4, u: M2 + 4e-3, seg: 6 }));
    a.add(e.alu, d(0.0145, I5 - M2 - 0.022, { y: Cs, u: M2 + 0.011, seg: 12, open: true }));
  } else a.add($, h(tT(Tr), I5 - M2, { u: M2, y: Cs, b: 0 }));
  if (o.underbarrel !== "laser" && (a.add($, c([[0.289, Cs - Tr + 6e-4], [0.3035, Cs - Tr + 6e-4], [0.305, Cs - Tr - 66e-4, 3e-3], [0.296, Cs - Tr - 66e-4, 3e-3]], 0.018, { b: 22e-4, bs: 2, soft: true })), R.handstop = Zn([0, Cs - Tr - 3e-3, -0.2975], [9e-3, 36e-4, 75e-4], 2e-3)), Ah("under"), o.underbarrel !== "none") {
    let H0 = BO[o.underbarrel] ?? 0.24, Y0 = Cs - Tr, et = _("underbarrel", Gt(0, Vu, H0)), ct = et.position;
    {
      let P0 = t ? xy(H0 - 0.027, H0 + 0.027, 0) : c(se(H0 - 0.027, 0, H0 + 0.027, 75e-4), 0.0206, { b: 0 });
      P0.rotateZ(Math.PI), P0.translate(0, Y0 + 5e-4, 0), a.add(e.alu, P0);
    }
    if (t) for (let P0 of [-0.019, 0.019]) a.add(e.steel, x(26e-4, 12e-4, { y: Y0 - 1e-3, u: H0 + P0, x: 0, seg: 6 }));
    let D0 = wp(o.underbarrel, { mount: "rail" }), u0 = L(D0), w0 = D0.drop ?? -u0.min.y;
    if (D0.laser && (S.laser = D0.laser.clone().add(ct)), D0.grip) {
      R.vgrip = sT(D0.grip, ct.x, ct.y, ct.z);
      let P0 = D0.grip.hold;
      P0 && (C = { at: Bt(P0.at[0], P0.at[1], P0.at[2]).add(ct), fingers: Bt(P0.fingers[0], P0.fingers[1], P0.fingers[2]), palm: Bt(P0.palm[0], P0.palm[1], P0.palm[2]) });
    } else R.under = O(u0, ct);
    if (t) { A(D0, et); att.underbarrel = D0; }
    else if (D0.grip) {
      let P0 = b("furniture", e.grip), st = Vu - 0.012, J0 = Vu - w0;
      a.add(P0, us([[H0 - 0.022, Vu], [H0 + 0.022, Vu], [H0 + 0.02, st, 3e-3], [H0 - 0.02, st, 3e-3]], 0.032, { b: 16e-4 })), a.add(e.pin, Wn(65e-4, 5e-3, { x: -0.0185, y: Vu - 65e-4, u: H0, seg: 8 }));
      let q0 = new THREE.LatheGeometry([[0.0146, 0], [0.0128, 6e-3], [0.0138, 0.022], [0.0152, 0.044], [0.0146, 0.064], [0.0158, st - J0 - 6e-3], [0.015, st - J0], [1e-4, st - J0]].map(([v0, x0]) => new THREE.Vector2(v0, -x0)).reverse(), 10);
      q0.scale(0.98, 1, 1.26), q0.rotateX(0.035), q0.translate(0, st, -(H0 - 1e-3)), a.add(P0, Qe(q0));
    } else {
      let P0 = b("metal", e.aluLt), st = -(u0.max.z + ct.z), J0 = -(u0.min.z + ct.z), q0 = Vu - 6e-3, v0 = u0.min.y + ct.y, x0 = Math.min(0.04, u0.max.x - u0.min.x);
      a.add(P0, us([[st, q0, 2e-3], [J0, q0, 2e-3], [J0, v0 + 4e-3], [J0 - 4e-3, v0], [st + 6e-3, v0], [st, v0 + 6e-3]], x0, { b: 3e-3 })), a.add(P0, us(se(H0 - 0.02, q0, H0 + 0.02, Vu, 1e-3), 0.026, { b: 0 })), a.add(e.pin, fa(62e-4, 3e-3, { x: -9e-3, y: (q0 + v0) / 2 - 1e-3, u: J0 - 5e-4, seg: 8 }), fa(45e-4, 3e-3, { x: 8e-3, y: (q0 + v0) / 2 - 1e-3, u: J0 - 5e-4, seg: 8 }), Wn(55e-4, 4e-3, { x: x0 / 2 + 15e-4, y: (q0 + v0) / 2, u: H0 + 4e-3, seg: 8 }));
    }
    R.urail = Zn([0, Y0 - 36e-4, -H0], [0.0103, 4e-3, 0.027], 6e-4);
  } else _("underbarrel", Gt(0, Cs - Tr, 0.24));
  if (Ah("housing"), a.add(y, c(GO, 0.033, { b: 16e-4, bs: 2 })), a.add(M, c(VO, 0.033, { b: 45e-4, bs: 2, cs: 3, soft: true })), a.add(y, c(WO, 0.014, { b: 11e-4, bs: 2, soft: true })), t) {
    for (let H0 of [-1, 1]) a.add(y, c([[-0.05, 0.01, 2e-3], [0.086, 0.0145, 2e-3], [0.086, 0.0165, 1e-3], [-0.05, 0.0165, 1e-3]], 1e-3, { x: H0 * 0.0166, b: 4e-4 })), a.add(e.pin, p(34e-4, 12e-4, { x: H0 * 0.0168, y: 0.0115, u: -0.049, seg: 10 }), p(34e-4, 12e-4, { x: H0 * 0.0168, y: 0.0125, u: 0.0735, seg: 10 })), a.add(e.pin, p(17e-4, 8e-4, { x: H0 * 0.0167, y: -35e-4, u: 0.06, seg: 6 }), p(17e-4, 8e-4, { x: H0 * 0.0167, y: 5e-4, u: 0.038, seg: 6 }));
    a.add(y, c([[0.012, -0.102, 3e-3], [-0.0395, -0.098, 4e-3], [-0.0405, -0.101, 2e-3], [0.0112, -0.105, 2e-3]], 0.03, { b: 14e-4, bs: 2 })), a.add(s.mark, D5("safe", 72e-4, 54e-4, -0.01665, 0.0118, 0.052, -1), D5("semi", 72e-4, 54e-4, -0.01665, 4e-3, 0.0525, -1), D5("auto", 0.011, 5e-3, -0.01665, -4e-3, 0.052, -1)), a.add(s.mark, D5("dot", 22e-4, 22e-4, 0.01665, 0.0118, 0.04, 1), D5("cal", 0.015, 33e-4, 0.01665, 8e-3, 5e-3, 1));
  }
  if (T("trigger", Gt(0, -0.011, 0.066), (H0) => {
    H0.add(e.steel, c(qO, 66e-4, { b: 13e-4, bs: 2, soft: true }));
  }), T("selector", Gt(-0.0165, 8e-3, 0.02), (H0) => {
    H0.add(e.steel, p(55e-4, 3e-3, { x: -0.0172, y: 8e-3, u: 0.02, seg: 14 }), c([[0.016, 55e-4, 1e-3], [0.04, 9e-3, 15e-4], [0.04, 0.0125, 15e-4], [0.016, 0.0105, 1e-3]], 3e-3, { x: -0.0195, b: 1e-3 }));
    for (let Y0 = 0; Y0 < 3; Y0++) H0.add(e.steel, c(se(0.032 + Y0 * 26e-4, 86e-4, 0.0332 + Y0 * 26e-4, 0.0122), 8e-4, { x: -0.0212, b: 0 }));
    H0.add(e.steel, p(46e-4, 22e-4, { x: 0.017, y: 8e-3, u: 0.02, seg: 12 }), c(se(0.0205, 74e-4, 0.0262, 86e-4, 4e-4), 6e-4, { x: 0.0183, b: 2e-4 }));
  }, true), Ah("well"), t) {
    a.add(v, c(o00, 0.0292, { b: 12e-4 }));
    for (let H0 of [-1, 1]) a.add(v, c(dk, 22e-4, { x: H0 * 0.0154, b: 1e-3 }));
    for (let H0 of [-1, 1]) a.add(v, c([[0.098, -0.0343], [0.135, -0.0305], [0.135, 0.0128], [0.098, 0.0128]], 32e-4, { x: H0 * 0.013, b: 3e-4 })), a.add(e.black, c(se(0.0986, -0.012, 0.1344, 0.0122), 2e-4, { x: H0 * 0.01135, b: 0 })), a.add(v, c(se(0.104, -0.01, 0.1085, 0.0105, 16e-4), 1e-3, { x: H0 * 0.0167, b: 4e-4, cs: 2 }), c(se(0.124, -9e-3, 0.1285, 0.0105, 16e-4), 1e-3, { x: H0 * 0.0167, b: 4e-4, cs: 2 })), a.add(v, c([[0.0983, -0.0345], [0.1347, -0.0307], [0.1347, -0.0282], [0.0983, -0.032]], 12e-4, { x: H0 * 0.0119, b: 5e-4 }));
    a.add(e.black, c(se(0.0986, 0.0118, 0.1344, 0.0124), 0.0228, { b: 0 })), a.add(e.black, h(se(-0.0113, -0.012, 0.0113, 0.0122), 2e-4, { u: 0.0985, b: 0 }), h(se(-0.0113, -0.012, 0.0113, 0.0122), 2e-4, { u: 0.1343, b: 0 }));
    for (let H0 = 0; H0 < 4; H0++) a.add(v, c(se(0.1392, -0.024 + H0 * 8e-3, 0.1404, -0.0205 + H0 * 8e-3), 0.02, { b: 0 }));
  } else a.add(v, c(KO, 0.0292, { b: 0 }), c(dk, 0.033, { b: 0 }));
  if (o.magazine === "fast") {
    for (let H0 of [-1, 1]) a.add(y, c([[0.101, -0.02, 2e-3], [0.1405, -0.017, 2e-3], [0.143, -0.0368, 2e-3], [0.101, -0.0408, 2e-3]], 34e-4, { x: H0 * 0.0162, b: 12e-4 }));
    a.add(y, c([[0.1385, -0.016, 1e-3], [0.144, -0.016, 2e-3], [0.1462, -0.037, 2e-3], [0.1392, -0.0372, 1e-3]], 0.0358, { b: 14e-4 })), R.funnel = Zn([0, -0.0285, -0.1235], [0.0179, 0.012, 0.0228], 15e-4);
  }
  T("magPaddle", Gt(0, -0.0362, 0.0958), (H0) => {
    if (H0.add(e.steel, c(XO, 0.015, { b: 12e-4, bs: 2 }), p(2e-3, 0.02, { y: -0.0362, u: 0.0958, seg: 8 })), t) for (let Y0 = 0; Y0 < 4; Y0++) H0.add(e.steel, c(se(0.0872 + Y0 * 2e-4, -0.069 + Y0 * 22e-4, 0.0886 + Y0 * 1e-3, -0.068 + Y0 * 22e-4), 0.013, { b: 0 }));
  }), T("magButton", Gt(0.0165, 0.0105, 0.086), (H0) => {
    H0.add(e.steel, p(42e-4, 34e-4, { x: 0.0172, y: 0.0105, u: 0.086, seg: 14 }));
    for (let Y0 = 0; Y0 < 3; Y0++) H0.add(e.steel, c(se(0.0838 + Y0 * 18e-4, 77e-4, 0.0846 + Y0 * 18e-4, 0.0133), 4e-4, { x: 0.0191, b: 0 }));
  }, true), t && a.add(y, c(se(0.0795, 4e-3, 0.0925, 0.017, 3e-3), 12e-4, { x: 0.0168, b: 5e-4, holes: [Kr(0.086, 0.0105, 47e-4, 12)] })), Ah("mag");
  let e0 = o.magazine, p0 = a00(e0), t0 = r00(e0), M0 = AT(e0), f0 = Pp[e0], _0 = Gt(0, NO, Sr), F0 = (H0, Y0) => [M0.o[0] + M0.n[0] * H0 + M0.t[0] * Y0, M0.o[1] + M0.n[1] * H0 + M0.t[1] * Y0], m0 = (e0 === "ext" ? [-0.064, -0.104, -0.144, -0.184] : [-0.062, -0.094, -0.126]).filter((H0) => H0 > f0 + 0.022), S0 = (H0) => {
    let Y0 = 2 * Hy * Math.max(0, Cp - H0), et = Math.hypot(Y0, 1);
    return Bt(0, -Y0 / et, 1 / et);
  }, T0 = (H0, Y0, et) => {
    let ct = s.mark.userData.cells[H0], D0 = new THREE.PlaneGeometry(Y0, et), u0 = D0.attributes.uv;
    for (let w0 = 0; w0 < u0.count; w0++) u0.setXY(w0, ct[0] + u0.getX(w0) * (ct[2] - ct[0]), ct[1] + u0.getY(w0) * (ct[3] - ct[1]));
    return D0;
  }, j0 = T("mag", _0, (H0) => {
    let Y0 = e0 === "fast" ? y : w;
    if (t) {
      let et = l00(f0), ct = (za + 52e-4) / 2;
      H0.add(w, et.body, et.rim), H0.add(e.black, et.cavity), H0.add(w, c([F0(-za / 2 - 7e-4, -48e-4), F0(za / 2 + 7e-4, -48e-4), F0(za / 2 + 7e-4, -8e-4), F0(-za / 2 - 7e-4, -8e-4)], nr + 14e-4, { b: 5e-4 })), H0.add(Y0, c([[...F0(-ct, -1e-3), 8e-4], [...F0(ct, -1e-3), 8e-4], [...F0(ct + 4e-4, 16e-4), 16e-4], [...F0(ct - 16e-4, 42e-4), 14e-4], [...F0(-ct + 12e-4, 42e-4), 14e-4], [...F0(-ct - 4e-4, 16e-4), 16e-4]], nr + 34e-4, { b: 14e-4, bs: 2, soft: true }));
      {
        let D0 = F0(45e-4, 42e-4), u0 = Bt(0, M0.t[1], -M0.t[0]), w0 = Gt(0, D0[1], D0[0]);
        H0.add(e.black, Ap(32e-4, w0, u0, 8e-5)), H0.add(e.pin, Ap(25e-4, w0, u0, 16e-5, 12));
      }
      H0.add(e.black, c(se(Sr - za / 2 - 22e-5, -0.0102, Sr - za / 2 + 3e-4, -58e-4), 74e-4, { b: 0 })), m0.forEach((D0, u0) => {
        let w0 = S0(D0), P0 = w2(1e-3, -za / 2, D0);
        H0.add(e.pin, Ap(24e-4, P0, w0, 6e-5)), H0.add(e.black, Ap(185e-5, P0, w0, 12e-5));
        for (let q0 of [-1, 1]) {
          let v0 = w2(q0 * nr / 2, 0, D0), x0 = Bt(q0, 0, 0);
          H0.add(e.pin, Ap(24e-4, v0, x0, 6e-5)), H0.add(e.black, Ap(185e-5, v0, x0, 12e-5));
        }
        let st = T0("w" + (u0 + 1) * 10, 4e-3, 29e-4), J0 = w2(61e-4, -za / 2, D0).addScaledVector(w0, 25e-5);
        st.rotateX(F5(D0)), st.translate(J0.x, J0.y, J0.z), H0.add(s.mark, Qe(st));
      });
      for (let [D0, u0, w0, P0] of [[e0 === "ext" ? "n48" : "n32", 56e-4, 39e-4, 0.0108], ["cal", 0.015, 33e-4, -36e-4]]) {
        let st = f0 + 7e-3, J0 = T0(D0, u0, w0), q0 = w2(-nr / 2 - 2e-4, P0, st);
        J0.rotateY(-Math.PI / 2), J0.rotateX(F5(st)), J0.translate(q0.x, q0.y, q0.z), H0.add(s.mark, Qe(J0));
      }
      for (let D0 of [-1, 1]) H0.add(w, h([[D0 * 0.0106, 0.0116], [D0 * 0.0106, 0.0156, 3e-3], [D0 * 72e-4, 0.0186, 12e-4], [D0 * 56e-4, 0.0181], [D0 * 6e-3, 0.0171, 6e-4], [D0 * 94e-4, 0.015, 24e-4], [D0 * 97e-4, 0.0116]], 0.0152, { u: Sr - 0.0168, b: 4e-4, cs: 3 })), H0.add(w, h([[D0 * 0.0106, 0.0116], [D0 * 0.0106, 0.0149, 26e-4], [D0 * 84e-4, 0.0171, 1e-3], [D0 * 73e-4, 0.0166], [D0 * 76e-4, 0.0158, 5e-4], [D0 * 95e-4, 0.0141, 18e-4], [D0 * 97e-4, 0.0116]], 0.0112, { u: Sr - 16e-4, b: 4e-4, cs: 3 }));
      H0.add(w, c(se(Sr - 0.017, 0.0114, Sr - 0.0142, 0.0176, 8e-4), nr - 24e-4, { b: 6e-4 }));
    } else H0.add(w, c(p0, nr, { b: 16e-4, bs: 2, soft: true })), H0.add(Y0, c(t0, nr + 34e-4, { b: 14e-4, bs: 2 }));
    if (e0 === "fast") {
      H0.add(e.rubber, c([[...F0(-0.015, 35e-4), 3e-3], [...F0(0.015, 35e-4), 3e-3], [...F0(0.0125, 0.033), 9e-3], [...F0(-0.0125, 0.033), 9e-3]], 0.012, { b: 26e-4, bs: 2, soft: true, keepHoles: true, holes: [[[...F0(-85e-4, 0.01), 3e-3], [...F0(85e-4, 0.01), 3e-3], [...F0(7e-3, 0.0265), 5e-3], [...F0(-7e-3, 0.0265), 5e-3]]] }));
      let et = f0 + 0.03;
      if (H0.add(y, c(Sc(xk(et - 0.011, et + 4e-3, 4e-3), za + 4e-3), nr + 46e-4, { b: 14e-4, bs: 2 })), t) for (let ct of [-1, 1]) H0.add(e.steel, p(22e-4, 12e-4, { x: ct * (nr / 2 + 26e-4), y: et - 35e-4, u: zp(et - 35e-4) + 0.01, seg: 6 }), p(22e-4, 12e-4, { x: ct * (nr / 2 + 26e-4), y: et - 35e-4, u: zp(et - 35e-4) - 0.01, seg: 6 }));
    }
  });
  if (t) {
    let H0 = new THREE.Group();
    for (H0.name = "magIn", H0.userData.keep = true; j0.children.length; ) H0.add(j0.children[0]);
    j0.add(H0), I.magIn = H0;
    let Y0 = new THREE.Group();
    Y0.name = "magRounds", Y0.userData.keep = true, Y0.userData.rest = new THREE.Vector3(), H0.add(Y0), i.magRounds = Y0;
    let et = I4();
    HO(e, et, 26e-4, 0.0142, Sr - 0.0152), HO(e, et, -26e-4, 98e-4, Sr - 0.0152);
    for (let u0 of m0) {
      et.add(e.brass, Ap(175e-5, w2(1e-3, -za / 2, u0), S0(u0), 18e-5, 10));
      for (let w0 of [-1, 1]) et.add(e.brass, Ap(175e-5, w2(w0 * nr / 2, 0, u0), Bt(w0, 0, 0), 18e-5, 10));
    }
    et.build(Y0, _0);
    let ct = new THREE.Group();
    ct.name = "magFollower", ct.userData.keep = true, ct.userData.rest = new THREE.Vector3(), ct.userData.hidden = true, ct.visible = false, H0.add(ct), i.magFollower = ct;
    let D0 = I4();
    D0.add(s.orange, c([[Sr - 0.015, 8e-3], [Sr + 0.0152, 8e-3], [Sr + 0.0152, 0.012, 1e-3], [Sr + 5e-3, 0.0144, 2e-3], [Sr - 0.015, 0.0156, 1e-3]], nr - 52e-4, { b: 8e-4 })), D0.add(s.orange, d(4e-3, 0.02, { x: 28e-4, y: 0.013, u: Sr - 0.0142, seg: 12 })), D0.build(ct, _0);
  }
  Ah("stock");
  let Z0 = t ? I4() : a, lt = Gt(0, 0.031, -0.066);
  if (o.stock === "light") Z0.add(y, c(DO, 0.014, { b: 3e-3, bs: 2, soft: true, keepHoles: true, holes: [i00] })), Z0.add(e.rubber, c([[-0.188, 0.0655, 3e-3], [-0.194, 0.061, 3e-3], [-0.1958, -0.03, 4e-3], [-0.1905, -0.035, 3e-3]], 0.02, { b: 3e-3, bs: 2, soft: true })), a.add(e.steel, p(34e-4, 0.017, { y: 0.044, u: -0.076, seg: 8 })), R.stock = Zs(H1(DO), 0.014, { r: 3e-3 });
  else {
    for (let H0 of [-1, 1]) Z0.add(e.steel, d(42e-4, 0.19, { x: H0 * 0.0222, y: 0.031, u: -0.17, seg: 8 })), a.add(v, c(se(-0.058, 0.0245, 0.026, 0.0375, 3e-3), 4e-3, { x: H0 * 0.0206, b: 12e-4 })), t && Z0.add(e.steel, d(48e-4, 3e-3, { x: H0 * 0.0222, y: 0.031, u: 0.0185, seg: 8 }));
    if (a.add(v, c(se(-0.0745, 0.024, -0.0605, 0.038, 2e-3), 0.054, { b: 14e-4 })), Z0.add(e.steel, c(se(-0.1725, 0.0235, -0.16, 0.0385, 3e-3), 0.053, { b: 16e-4 })), Z0.add(y, c(LO, 0.046, { b: 6e-3, bs: 2, cs: 3, soft: true })), t) {
      for (let H0 = 0; H0 < 6; H0++) Z0.add(e.rubber, c(se(-0.1846, -0.04 + H0 * 0.017, -0.1826, -0.032 + H0 * 0.017), 0.036, { b: 0 }));
      a.add(e.steel, c([[-0.0745, 0.0252], [-0.0745, 0.0372], [-0.0768, 0.0366, 1e-3], [-0.0792, 0.0282, 15e-4], [-0.0786, 0.0252, 1e-3]], 0.013, { x: 0, b: 12e-4, bs: 2 }));
      for (let H0 = 0; H0 < 4; H0++) a.add(e.steel, c(se(-0.0796 + H0 * 65e-5, 0.0276 + H0 * 21e-4, -0.0786 + H0 * 65e-5, 0.0288 + H0 * 21e-4), 0.0118, { x: 0, b: 0 }));
      a.add(e.pin, p(15e-4, 0.015, { y: 0.0358, u: -0.0756, seg: 6 }));
    }
    R.stock = ds(ml([0.0222, 0.031, 0.17], [0.0222, 0.031, -0.02], 42e-4), ml([-0.0222, 0.031, 0.17], [-0.0222, 0.031, -0.02], 42e-4), Zs(H1(LO), 0.046, { r: 6e-3 }));
  }
  if (t) {
    let H0 = new THREE.Group();
    H0.name = "stock", H0.position.copy(lt), H0.userData.keep = true, n.add(H0), Z0.build(H0, lt), I.stock = H0;
  }
  if (Ah("sights"), o.optic === "irons") {
    a.add(e.steel, c([[Pa - 0.021, sr - 3e-3], [Pa + 0.019, sr - 3e-3], [Pa + 0.017, sr + 6e-3, 2e-3], [Pa - 0.019, sr + 6e-3, 2e-3]], 0.022, { b: 12e-4 }));
    let H0 = sr + 6e-3, Y0 = Ac - 85e-4, et = Ac + 85e-4, ct = 98e-4;
    if (a.add(e.steel, x(ct + 8e-4, Y0 - H0, { y: H0, u: Pa, seg: 24 }), x(ct + 6e-4, 34e-4, { y: et, u: Pa, seg: 24, r2: ct - 8e-4 })), t) {
      let D0 = d00(ct, ct - 19e-4, Y0, et, Ac, [54e-4, 36e-4, 62e-4, 3e-3]);
      a.add(e.steel, bh(D0.wall, 0, 0, Pa)), a.add(e.black, bh(D0.liner, 0, 0, Pa));
      for (let u0 = 0; u0 < 20; u0++) {
        let w0 = c(se(-6e-4, et + 5e-4, 6e-4, et + 3e-3), 8e-4, { x: ct + 6e-4, b: 0 });
        w0.rotateY(Ze(u0 * 18)), w0.translate(0, 0, -Pa), a.add(e.steel, w0);
      }
      a.add(e.steel, x(3e-3, 1e-3, { y: et + 32e-4, u: Pa, seg: 10 }));
      {
        let u0 = s.mark.userData.cells.drum, w0 = (u0[2] - u0[0]) / 4;
        for (let P0 = 0; P0 < 4; P0++) {
          let st = new THREE.PlaneGeometry(21e-4, 26e-4), J0 = st.attributes.uv;
          for (let q0 = 0; q0 < J0.count; q0++) J0.setXY(q0, u0[0] + w0 * (P0 + 0.02 + J0.getX(q0) * 0.52), u0[1] + J0.getY(q0) * (u0[3] - u0[1]));
          st.translate(0, Ac + 68e-4, ct + 22e-5), st.rotateY(-P0 * Math.PI / 2), st.translate(0, 0, -Pa), a.add(s.mark, Qe(st));
        }
      }
      a.add(e.white, h(se(-4e-4, sr + 12e-4, 4e-4, sr + 5e-3), 4e-4, { u: Pa - 0.0204, b: 0 })), a.add(e.steel, p(3e-3, 4e-3, { x: 0.0125, y: sr + 2e-3, u: Pa, seg: 10 }), p(16e-4, 5e-3, { x: 0.0128, y: sr + 2e-3, u: Pa, seg: 6 })), a.add(e.white, c(se(Pa - 96e-4, sr + 1e-3, Pa - 86e-4, sr + 46e-4), 6e-4, { x: -0.0111, b: 0 }));
      for (let u0 of [-1, 1]) a.add(e.steel, c(se(Pa - 0.0185, sr + 0, Pa - 0.0125, sr + 85e-4, 15e-4), 3e-3, { x: u0 * 92e-4, b: 1e-3 }));
    } else a.add(e.steel, x(ct, et - Y0, { y: Y0, u: Pa, seg: 12 }));
    S.sight = Gt(0, Ac, Pa), R.rsight = Zn([0, sr + 0.014, -Pa], [0.011, 0.016, 0.0115], 3e-3), _("optic", Gt(0, sr, 0.04));
  } else {
    let et = o.optic === "holo" ? 0.034 : 0.024;
    a.add(e.alu, c([[-0.05, sr - 4e-3], [0.106, sr - 4e-3], [0.106, Hn - 74e-4], [-0.05 + 4e-3, Hn - 74e-4, 2e-3], [-0.05, Hn - 0.011, 1e-3]], 0.0206, { b: 1e-3 })), a.add(e.alu, t ? xy(-0.05 + 4e-3, 0.106, Hn - 75e-4) : c(se(-0.05 + 4e-3, Hn - 75e-4, 0.106, Hn), 0.0206, { b: 0 }));
    for (let P0 of [-0.03, 0.082]) a.add(e.alu, h(uk(Mo + 34e-4, Mo - 8e-4, -12, 192, t ? 10 : 6), 0.016, { u: P0 - 8e-3, y: Ml, b: 1e-3, soft: true })), t && a.add(e.steel, p(62e-4, 5e-3, { x: -(Mo + 58e-4), y: Ml + 3e-3, u: P0, seg: 8 }), p(36e-4, 3e-3, { x: Mo + 46e-4, y: Ml + 3e-3, u: P0, seg: 8 }));
    let ct = _("optic", Gt(0, Hn, et)), D0 = ct.position, u0 = Mp(o.optic), w0 = L(u0);
    if (S.sight = u0.eye.clone().add(D0), S.sight.z -= yk[o.optic] ?? 0.11, t) { A(u0, ct); att.optic = u0; }
    else {
      let P0 = -(w0.max.z + D0.z), st = -(w0.min.z + D0.z), J0 = u0.window || [0.03, 0.022], q0 = Hn + (u0.height ?? 0.035), v0 = J0[0] / 2, x0 = J0[1] / 2, C0 = 45e-4, k0 = Math.min(0.03, (st - P0) * 0.55), O0 = b("metal", e.aluLt);
      if (o.optic === "holo") a.add(O0, us([[P0, Hn - 4e-3], [st, Hn - 4e-3], [st, Hn + 0.012], [st - 6e-3, Hn + 0.019], [P0 + 0.03, Hn + 0.019], [P0 + 0.022, Hn + 0.012], [P0, Hn + 0.012]], 0.04, { b: 2e-3 })), a.add(O0, si([[-v0 - C0, Hn + 0.016], [v0 + C0, Hn + 0.016], [v0 + C0, q0 + x0 + C0 - 4e-3], [v0 + C0 - 4e-3, q0 + x0 + C0], [-v0 - C0 + 4e-3, q0 + x0 + C0], [-v0 - C0, q0 + x0 + C0 - 4e-3]], k0, { u: st - k0 - 4e-3, keepHoles: true, holes: [se(-v0, q0 - x0, v0, q0 + x0)], b: 0 })), a.add(O0, us([[st - k0 - 4e-3, Hn + 0.019], [st - k0 - 0.02, Hn + 0.019], [st - k0 - 4e-3, q0 + x0]], 3e-3, { x: v0 + C0 - 15e-4, b: 0 }), us([[st - k0 - 4e-3, Hn + 0.019], [st - k0 - 0.02, Hn + 0.019], [st - k0 - 4e-3, q0 + x0]], 3e-3, { x: -(v0 + C0 - 15e-4), b: 0 })), a.add(e.pin, Wn(85e-4, 6e-3, { x: v0 + C0 + 4e-3, y: Hn + 0.01, u: P0 + 0.014, seg: 8 }));
      else {
        a.add(O0, us([[P0, Hn - 4e-3], [st, Hn - 4e-3], [st, Hn + 0.01], [st - 4e-3, Hn + 0.013], [P0 + 0.02, Hn + 0.013], [P0 + 0.01, Hn + 0.02, 3e-3], [P0, Hn + 0.018]], 0.036, { b: 18e-4 }));
        let B0 = si([[-v0 - C0, Hn + 0.012], [v0 + C0, Hn + 0.012], [v0 + C0, q0 + x0 + C0 - 5e-3], [v0 + C0 - 5e-3, q0 + x0 + C0], [-v0 - C0 + 5e-3, q0 + x0 + C0], [-v0 - C0, q0 + x0 + C0 - 5e-3]], 6e-3, { u: 0, keepHoles: true, holes: [se(-v0, q0 - x0, v0, q0 + x0)], b: 0 });
        B0.translate(0, -(Hn + 0.012), 0), B0.rotateX(-0.14), B0.translate(0, Hn + 0.012, -(st - 0.012)), a.add(O0, B0);
      }
      a.add(e.pin, Wn(52e-4, 5e-3, { x: -0.0205, y: Hn + 4e-3, u: (P0 + st) / 2 - 0.012, seg: 6 }), Wn(52e-4, 5e-3, { x: -0.0205, y: Hn + 4e-3, u: (P0 + st) / 2 + 0.014, seg: 6 }));
    }
  }
  return S.eject = Gt(Mo + 1e-3, 0.0425, 0.094), S.ejectDir = Bt(0.88, 0.34, 0.33).normalize(), a.build(n), { root: n, parts: i, anchors: S, mounts: E, attachments: att, hold: C, fx: I, bins: a, MAGP: p0, MFLOOR: t0, magPivot: _0 };
}
var p00 = (o) => o * 180 / Math.PI, yk = { irons: 0.135, reflex: 0.11, holo: 0.11 };
function vk(o = {}) {
  let t = h00(o.build);
  F4 = {};
  let s = jO(t, true), { root: n, parts: i, anchors: a } = s, r = F4;
  F4 = null;
  return {
    id: "smg",
    root: n,
    parts: i,
    build: t,
    anchors: a,
    mounts: s.mounts,
    attachments: s.attachments || {},
    triStats: r,
    fx: s.fx,
    hold: s.hold,
    hip: { pos: Bt(0.112, -0.142, -0.3), rot: new THREE.Euler(0.03, 0.07, 0) },
    adsDist: yk[t.optic] ?? 0.11,
    dims: { BORE: Cs, TUBE: vo, TR: ii, CH_U: F1, CH_ANG: kc, CH_PULL: mk, CH_LOCK: gk, BOLT_TRAVEL: s00, WELL_Y: NO, MAG_C0: Sr, magBottom: Pp[t.magazine], SIGHT: Ac, HG0: M2, HG1: I5 },
    tris: WJ(n),
  };
}
var No = 0.0235, or = 85e-4, Jn = 0.035, N1 = 0.0129, kh = -0.04, O1 = 0.137, Mi = 0.0131, _r = or - 6e-4, El = 0.0215, Gu = 0.0565, CT = No + 2e-3, Lp = Jn - 56e-4, Ek = 9e-4, x00 = 0.042, N5 = Math.tan(Ze(16.5)), b00 = 21e-4, FT = 0.0332, r1 = 0.0222, Cc = -5e-4, ga = -0.101, wo = (o) => b00 + (o + 0.108) * N5, ai = (o) => wo(o) - FT, B1 = (o) => o.map((t) => [t[0], t[1]]), tN = (o, t, e) => o + (t - o) * e, Ip = (o, t = 0) => {
  let e = t / 52e-4, s = 42e-4 * (1 - e);
  return [[-o, or], [o, or], [o, Jn - 52e-4, 5e-4], [o - s, Jn - t, 5e-4], [-(o - s), Jn - t, 5e-4], [-o, Jn - 52e-4, 5e-4]];
}, BT = [[-3e-3, _r], [0.132, _r, 8e-4], [0.1328, 3e-3, 2e-3], [0.1314, -58e-4, 28e-4], [0.0964, -8e-3, 1e-3], [0.0946, -95e-4, 6e-4], [0.0445, -95e-4], [0.0438, -0.015], [-3e-3, -0.015]], Ck = Sc([[0.0225, -0.0293, 48e-4], [0.032, -0.0297, 48e-4], [0.044, -0.0306, 48e-4], [0.054, -0.0317, 48e-4], [0.064, -0.0346, 5e-3], [0.073, -0.037, 54e-4], [0.085, -0.037, 54e-4], [0.09, -0.0348, 54e-4], [0.0931, -0.0304, 54e-4], [0.0943, -0.024, 54e-4], [0.0946, -0.017, 54e-4], [0.0947, -85e-4, 54e-4]], 54e-4), U1 = 0.068, uN = Sc([[U1, -0.01], [U1 - 11e-4, -0.015], [U1 - 21e-4, -0.0202], [U1 - 25e-4, -0.025], [U1 - 16e-4, -0.0296]], 46e-4), Xl = -0.0128, Hp = 0.101, Fp = 0.13, UT = 0.0206, PT = 0.1225, y00 = (() => {
  let o = [[Hp, -8e-3], [Fp, -62e-4], [Fp, Xl]];
  for (let t of [0.1225, 0.1143, 0.1061]) o.push([t + 22e-4, Xl], [t + 22e-4, Xl + 27e-4], [t - 22e-4, Xl + 27e-4], [t - 22e-4, Xl]);
  return o.push([Hp, Xl]), o;
})(), dN = (o) => {
  let t = o === "ext" ? ga - 0.021 : ga - 1e-3, e = o === "ext" ? ga - 0.03 : ga - 76e-4, s = ga - 2e-4, n = [[wo(Cc), Cc], [wo(t), t], [ai(t), t], [ai(Cc), Cc]], i = o === "ext" ? [[wo(s) + 4e-3, s, 15e-4], [wo(e) + 62e-4, e + 4e-4, 4e-3], [ai(e) - 22e-4, e, 4e-3], [ai(s) - 12e-4, s, 15e-4]] : [[wo(s) + 46e-4, s, 15e-4], [wo(e) + 58e-4, e + 4e-4, 25e-4], [ai(e) - 15e-4, e, 25e-4], [ai(s) - 12e-4, s, 15e-4]];
  return { body: n, base: i, yb: t, y1: e, baseW: o === "ext" ? 0.0258 : 0.025 };
};
function Vy(o) {
  return (t) => {
    let e = o.length;
    if (t <= o[0][0]) return o[0][1];
    if (t >= o[e - 1][0]) return o[e - 1][1];
    let s = 0;
    for (; t > o[s + 1][0]; ) s++;
    let n = o[Math.max(0, s - 1)], i = o[s], a = o[s + 1], r = o[Math.min(e - 1, s + 2)], l = a[0] - i[0], c = (t - i[0]) / l, h = (a[1] - n[1]) / (a[0] - n[0]) * l, f = (r[1] - i[1]) / (r[0] - i[0]) * l, u = c * c, d = u * c;
    return (2 * d - 3 * u + 1) * i[1] + (d - 2 * u + c) * h + (-2 * d + 3 * u) * a[1] + (d - u) * f;
  };
}
var v00 = Vy([[ga, 86e-4], [-0.097, 82e-4], [-0.09, 0.0104], [-0.075, 0.0149], [-0.06, 0.0195], [-0.048, 0.023], [-0.038, 0.0262], [-0.032, 0.0296], [-0.025, 0.0372], [-0.017, 0.0432], [-0.01, 0.0445], [_r, 0.0445]]), M00 = (o) => o > -0.01 ? 26e-4 : v00(o), w00 = Vy([[ga, -0.0478], [-0.097, -0.0463], [-0.09, -0.0442], [-0.075, -0.0396], [-0.06, -0.034], [-0.045, -0.0272], [-0.03, -0.0198], [-0.019, -0.0125], [-0.0105, -72e-4], [-65e-4, -62e-4], [-37e-4, -85e-4], [-15e-4, -0.0135], [1e-4, -0.0215], [11e-4, -0.0296], [19e-4, -0.0338], [31e-4, -0.0345], [_r, -0.0345]]), pN = Vy([[ga, 0.0158], [-0.096, 0.015], [-0.075, 0.0151], [-0.045, 0.0148], [-0.028, 0.0141], [-0.015, 0.0133], [-6e-3, 0.0128], [_r, 0.0128]]), E00 = Vy([[ga, 7e-3], [-0.09, 76e-4], [-0.045, 7e-3], [-0.02, 45e-4], [-0.0125, 35e-4], [-0.01, 2e-3], [_r, 2e-3]]), T00 = Vy([[ga, 0.0105], [-0.08, 0.0118], [-0.04, 0.0112], [-0.016, 8e-3], [-0.0105, 58e-4], [-45e-4, 6e-3], [-13e-4, 85e-4], [11e-4, 0.0118], [31e-4, 0.011], [_r, 8e-3]]), Wu = new THREE.Vector3(), eN = new THREE.Vector3(), sN = new THREE.Vector3();
function By(o, t, e) {
  let s = M00(t), n = w00(t), i = pN(t), a = Math.min(E00(t), i - 1e-4), r = Math.min(T00(t), i - 1e-4);
  if (a + r > s - n - 2e-4) {
    let g = (s - n - 2e-4) / (a + r);
    a *= g, r *= g;
  }
  o = (o % 8 + 8) % 8;
  let l = Math.floor(o), c = o - l, h = Math.PI / 2, f = s - a, u = n + r, d = i - a, m = i - r, p, x;
  switch (l) {
    case 0:
      p = d + a * Math.cos(c * h), x = f + a * Math.sin(c * h);
      break;
    case 1:
      p = d * (1 - 2 * c), x = s;
      break;
    case 2:
      p = -d - a * Math.sin(c * h), x = f + a * Math.cos(c * h);
      break;
    case 3:
      p = -i, x = f + (u - f) * c;
      break;
    case 4:
      p = -m - r * Math.cos(c * h), x = u - r * Math.sin(c * h);
      break;
    case 5:
      p = -m * (1 - 2 * c), x = n;
      break;
    case 6:
      p = m + r * Math.sin(c * h), x = u - r * Math.cos(c * h);
      break;
    default:
      p = i, x = u + (f - u) * c;
  }
  return e.set(p, t, -x);
}
var mN = [ga, -0.0985, -0.095, -0.09, -0.083, -0.075, -0.065, -0.055, -0.047, -0.04, -0.034, -0.026, -0.018, -0.0125, -85e-4, -55e-4, -33e-4, -17e-4, -5e-4, 5e-4, 13e-4, 21e-4, 33e-4, 52e-4, _r];
function gN(o, t) {
  let e = [];
  for (let f = 0; f < 8; f++) for (let u = 0; u < t[f]; u++) e.push(f + u / t[f]);
  let s = e.length, n = [], i = [], a = [], r = new THREE.Vector3(), l = new THREE.Vector3();
  for (let f = 0; f < o.length; f++) {
    let u = 0;
    for (let d = 0; d <= s; d++) By(e[d % s], o[f], r), d && (u += r.distanceTo(l)), l.copy(r), n.push(r.x, r.y, r.z), i.push(u, o[f]);
  }
  for (let f = 0; f < o.length - 1; f++) for (let u = 0; u < s; u++) {
    let d = f * (s + 1) + u, m = d + 1, p = d + s + 1, x = p + 1;
    a.push(d, m, p, m, x, p);
  }
  let c = new THREE.BufferGeometry();
  c.setAttribute("position", new THREE.Float32BufferAttribute(n, 3)), c.setAttribute("uv", new THREE.Float32BufferAttribute(i, 2)), c.setIndex(a), c.computeVertexNormals();
  let h = c.attributes.normal;
  for (let f = 0; f < o.length; f++) {
    let u = f * (s + 1), d = u + s;
    r.fromBufferAttribute(h, u).add(l.fromBufferAttribute(h, d)).normalize(), h.setXYZ(u, r.x, r.y, r.z), h.setXYZ(d, r.x, r.y, r.z);
  }
  return Qe(c);
}
function Uy(o, t, e, s) {
  let n = new THREE.Shape(), i = new THREE.Vector3(), a = true;
  for (let l = 0; l < 8; l++) for (let c = 0; c < t[l]; c++) By(l + c / t[l], o, i), a ? (n.moveTo(i.x, i.z), a = false) : n.lineTo(i.x, i.z);
  if (n.closePath(), s) {
    let l = new THREE.Path();
    l.moveTo(s[0][0], s[0][1]);
    for (let c = 1; c < s.length; c++) l.lineTo(s[c][0], s[c][1]);
    l.closePath(), n.holes.push(l);
  }
  let r = new THREE.ShapeGeometry(n);
  if (r.rotateX(Math.PI / 2), r.translate(0, o, 0), e) {
    let l = r.index.array;
    for (let c = 0; c < l.length; c += 3) {
      let h = l[c + 1];
      l[c + 1] = l[c + 2], l[c + 2] = h;
    }
    r.deleteAttribute("normal"), r.computeVertexNormals();
  }
  return Qe(r);
}
function S00(o) {
  let t = ga, e = ga + o, s = r1 / 2 + 5e-4, n = 6e-4, i = [], a = (c, h, f, u) => i.push(...c, ...h, ...f, ...c, ...f, ...u), r = (c, h, f) => [c, h, -(f ? wo(h) + n : ai(h) - n)];
  a(r(-s, t, 1), r(s, t, 1), r(s, e, 1), r(-s, e, 1)), a(r(s, t, 0), r(-s, t, 0), r(-s, e, 0), r(s, e, 0)), a(r(-s, t, 0), r(-s, t, 1), r(-s, e, 1), r(-s, e, 0)), a(r(s, t, 1), r(s, t, 0), r(s, e, 0), r(s, e, 1)), a(r(-s, e, 1), r(s, e, 1), r(s, e, 0), r(-s, e, 0));
  let l = new THREE.BufferGeometry();
  return l.setAttribute("position", new THREE.Float32BufferAttribute(i, 3)), l.computeVertexNormals(), Qe(l);
}
var OT = 14e-4, _00 = 19e-4;
function R00() {
  let o = r1 / 2 + 5e-4, t = 6e-4, e = OT, s = ga, n = ga + _00, i = [], a = (u, d, m, p) => i.push(...u, ...d, ...m, ...u, ...m, ...p), r = -(wo(s) + t + e), l = -(ai(s) - t - e), c = -(wo(n) + t), h = -(ai(n) - t);
  a([-o - e, s, r], [o + e, s, r], [o, n, c], [-o, n, c]), a([o + e, s, l], [-o - e, s, l], [-o, n, h], [o, n, h]), a([-o - e, s, l], [-o - e, s, r], [-o, n, c], [-o, n, h]), a([o + e, s, r], [o + e, s, l], [o, n, h], [o, n, c]);
  let f = new THREE.BufferGeometry();
  return f.setAttribute("position", new THREE.Float32BufferAttribute(i, 3)), f.computeVertexNormals(), f.setAttribute("color", new THREE.BufferAttribute(new Float32Array(i.length).fill(2), 3)), Qe(f);
}
function A00(o, t, e = 3e-3, s = 4) {
  let n = [], i = [], a = [], r = 4 * (s + 1), l = new THREE.Vector3(), c = new THREE.Vector3();
  for (let u = 0; u < o.length; u++) {
    let d = o[u], m = t(d), p = Math.min(e, m * 0.46), x = wo(d), g = ai(d), b = 0, v = 0, y = 0;
    for (let M = 0; M <= r; M++) {
      let w = Math.floor(M % r / (s + 1)), T = (w + M % r % (s + 1) / s) * Math.PI / 2, S = (w === 0 || w === 3 ? 1 : -1) * (m - p), E = w < 2 ? x - p : g + p, _ = S + p * Math.cos(T), R = E + p * Math.sin(T);
      M && (b += Math.hypot(_ - v, R - y)), v = _, y = R, n.push(_, d, -R), i.push(b, d);
    }
  }
  for (let u = 0; u < o.length - 1; u++) for (let d = 0; d < r; d++) {
    let m = u * (r + 1) + d, p = m + 1, x = m + r + 1, g = x + 1;
    a.push(m, p, x, p, g, x);
  }
  let h = new THREE.BufferGeometry();
  h.setAttribute("position", new THREE.Float32BufferAttribute(n, 3)), h.setAttribute("uv", new THREE.Float32BufferAttribute(i, 2)), h.setIndex(a), h.computeVertexNormals();
  let f = h.attributes.normal;
  for (let u = 0; u < o.length; u++) {
    let d = u * (r + 1), m = d + r;
    l.fromBufferAttribute(f, d).add(c.fromBufferAttribute(f, m)).normalize(), f.setXYZ(d, l.x, l.y, l.z), f.setXYZ(m, l.x, l.y, l.z);
  }
  return Qe(h);
}
var Tk = (o, t, e = 0, s = 26e-4) => [[-(t - e), ai(o) + e, s], [t - e, ai(o) + e, s], [t - e, wo(o) - e, s], [-(t - e), wo(o) - e, s]];
function U4(o, t, e, s, n = 12) {
  let i = new THREE.CylinderGeometry(o, o, t, n);
  return i.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), s)), i.translate(e.x, e.y, e.z), Qe(i);
}
function nN(o, t, e, s, n = 0, i = 14) {
  let a = (r) => (n && (r.translate(0, -e, s), r.rotateX(n), r.translate(0, e, -s)), r);
  o("brass", a(ni([[s, 4e-3], [s + 3e-4, 492e-5], [s + 12e-4, 492e-5], [s + 14e-4, 43e-4], [s + 22e-4, 43e-4], [s + 3e-3, 495e-5], [s + 0.0188, 482e-5], [s + 0.0191, 465e-5]], { x: t, y: e, seg: i, crease: 0.8 }))), o("brass", a(U4(4e-3, 2e-4, Gt(t, e, s + 8e-5), Bt(0, 0, 1), i))), o("primer", a(U4(22e-4, 2e-4, Gt(t, e, s - 6e-5), Bt(0, 0, 1), 10))), o("copper", a(ni([[s + 0.0189, 448e-5], [s + 0.0222, 446e-5], [s + 0.025, 405e-5], [s + 0.027, 33e-4], [s + 0.0284, 235e-5], [s + 0.0292, 135e-5], [s + 0.02955, 45e-5], [s + 0.02962, 2e-5]], { x: t, y: e, seg: i, crease: 1.4 })));
}
function zT(o, t, e, s, n, i, a = 34e-5, r = 3e-4) {
  let l = [], c = [], h = [], f = new THREE.Vector3(), u = (m, p) => 0.5 - 0.5 * Math.cos(Math.PI * m / p);
  for (let m = 0; m <= i; m++) {
    let p = 0;
    for (let x = 0; x <= n; x++) {
      let g = u(x, n), b = u(m, i), v = tN(o, t, g), y = tN(e, s, b);
      By(v, y, Wu), By(v + 0.02, y, eN), By(v, y + 4e-4, sN), f.crossVectors(eN.sub(Wu), sN.sub(Wu)).normalize();
      let M = Math.pow((1 - Math.pow(Math.abs(2 * g - 1), 8)) * (1 - Math.pow(Math.abs(2 * b - 1), 8)), 0.55);
      Wu.addScaledVector(f, -r + (a + r) * M), x && (p += Math.hypot(Wu.x - l[l.length - 3], Wu.z - l[l.length - 1])), l.push(Wu.x, Wu.y, Wu.z), c.push(p, y);
    }
  }
  for (let m = 0; m < i; m++) for (let p = 0; p < n; p++) {
    let x = m * (n + 1) + p, g = x + 1, b = x + n + 1, v = b + 1;
    h.push(x, g, b, g, v, b);
  }
  let d = new THREE.BufferGeometry();
  return d.setAttribute("position", new THREE.Float32BufferAttribute(l, 3)), d.setAttribute("uv", new THREE.Float32BufferAttribute(c, 2)), d.setIndex(h), d.computeVertexNormals(), Qe(d);
}
var oN = {}, Sk = null;
var _k = null;
function VT() {
  if (_k) return _k;
  let o = ao(), t = (c, h, f = {}, u = c.userData.wear) => {
    let d = c.clone();
    return d.color.set(h), Object.assign(d, f), d.userData = { base: new THREE.Color(h), wear: u }, d;
  }, e = makeCanvas(512, 256);
  let s = e.getContext("2d"), n = {};
  s.fillStyle = "#fff", s.textBaseline = "middle";
  let i = (c, h = 600) => `${h} ${c}px Bahnschrift, "Segoe UI", Arial, sans-serif`, a = (c, h, f, u, d, m) => {
    s.save(), s.translate(h, f), m(u, d), s.restore(), n[c] = [h / 512, 1 - (f + d) / 256, (h + u) / 512, 1 - f / 256];
  };
  a("maker", 0, 0, 400, 56, () => {
    s.font = i(30), s.fillText("GH-ARMS  \xB7  SOLSTICE CITY", 6, 30);
  }), a("serial", 0, 60, 230, 46, () => {
    s.font = i(30, 700), s.fillText("SX9-04127", 6, 25);
  }), a("hood", 240, 60, 130, 46, () => {
    s.font = i(32, 700), s.fillText("9x19", 8, 25);
  }), ["5", "10", "15", "20"].forEach((c, h) => a("n" + c, h * 64, 112, 64, 44, () => {
    s.font = i(34, 700), s.fillText(c, 6, 24);
  })), a("warn", 0, 162, 400, 40, () => {
    s.font = i(22), s.fillText("READ MANUAL BEFORE USE", 6, 21), s.beginPath(), s.moveTo(330, 34), s.lineTo(348, 6), s.lineTo(366, 34), s.closePath(), s.lineWidth = 3, s.strokeStyle = "#fff", s.stroke();
  });
  let r = makeCanvasTexture(e);
  r.anisotropy = 8, r.colorSpace = THREE.SRGBColorSpace;
  let l = o.mark.clone();
  return l.map = r, l.userData = { base: new THREE.Color(6974576), wear: 1, cells: n }, _k = { slide: t(o.steel, 5593184, { roughness: 0.42, metalness: 0.5 }, 2.6), frame: t(o.poly, 4540236, { roughness: 0.6 }, 1.35), gripTex: t(o.grip, 4145220, {}, 1.15), base: t(o.polyMag, 4474443, {}, 1.35), ctrl: t(o.steel, 5658718, { roughness: 0.44, metalness: 0.5 }, 2.2), follower: t(o.red, 13128988, { roughness: 0.55 }, 1.1), mark: l, magSteel: t(o.steel, 6448492, { roughness: 0.47, metalness: 0.45 }, 2.1), magLip: t(o.steel, 7106679, { roughness: 0.38, metalness: 0.6 }, 1.9), brass: t(o.brass, 12619839, { roughness: 0.24 }, 1.2), copper: t(o.copper, 12086336, { roughness: 0.28 }, 1), primer: t(o.steelBright, 11052186, { roughness: 0.3 }, 1) };
}
function N4(o, t, e, s, n, i, a) {
  let r = VT().mark.userData.cells[o], l = new THREE.PlaneGeometry(t, e), c = l.attributes.uv;
  for (let h = 0; h < c.count; h++) c.setXY(h, r[0] + c.getX(h) * (r[2] - r[0]), r[1] + c.getY(h) * (r[3] - r[1]));
  return a === "T" ? l.rotateX(-Math.PI / 2) : l.rotateY(a === "L" ? -Math.PI / 2 : Math.PI / 2), l.translate(s, n, -i), Qe(l);
}
var Fy = { slide: Gt(0, 0.022, 0.05), barrel: Gt(0, No, 0.118), trigger: Gt(0, -0.01, U1), trigBlade: Gt(0, -0.019, U1), slideStop: Gt(-Mi, 3e-3, 0.06), magRelease: Gt(-0.015, -0.0235, 0.024), mag: Gt(0, Cc, wo(Cc) - FT / 2), magRounds: Gt(0, Cc, wo(Cc) - FT / 2), magFollower: Gt(0, Cc, wo(Cc) - FT / 2), chamberRound: Gt(0, No, 0.0222) }, NT = [6, 2, 6, 3, 7, 2, 7, 3], P00 = [2, 1, 2, 1, 3, 1, 3, 1];
function iN(o, t) {
  let e = ao(), s = VT(), n = t.lo, i = !n, a = N1 - Ek, r = Jn + t.sightH, l = (c) => n ? 0 : c;
  {
    let c = (h, ...f) => o("slide", h, ...f);
    if (n) c(s.slide, si(Ip(N1), O1 - kh, { u: kh, b: 8e-4 }));
    else {
      t.optic ? c(s.slide, si(Ip(a), 0.012, { u: kh, b: 1e-3 }), si(Ip(a, 22e-4), 0.048, { u: -0.028, b: 0 }), si(Ip(a), El - 0.02, { u: 0.02, b: 5e-4 })) : c(s.slide, si(Ip(a), El - kh, { u: kh, b: 1e-3 })), c(s.slide, si([[-a, or], [-a + 34e-4, or], [-a + 34e-4, Jn - 42e-4], [-15e-4, Jn - 42e-4], [-15e-4, Jn], [-(a - 42e-4), Jn, 5e-4], [-a, Jn - 52e-4, 5e-4]], Gu - El, { u: El, b: 0 })), c(s.slide, si([[a - 34e-4, or], [a, or], [a, CT], [a - 34e-4, CT]], Gu - El, { u: El, b: 0 })), c(s.slide, si(Ip(a), O1 - Gu, { u: Gu, b: 13e-4, holes: [Kr(0, No, 75e-4, 18), Kr(0, No - 0.0118, 41e-4, 12)] }));
      let h = (f, u) => Array.from({ length: u }, (d, m) => {
        let p = f + m * 41e-4;
        return [[p, or + 34e-4], [p + 19e-4, or + 34e-4], [p + 65e-4, Lp - 26e-4], [p + 46e-4, Lp - 26e-4]];
      });
      for (let f of [-1, 1]) {
        let u = [[kh + 8e-4, or + 4e-4, 6e-4]];
        f < 0 && u.push([0.0715, or + 4e-4], [0.0715, or + 27e-4, 4e-4], [0.089, or + 27e-4, 4e-4], [0.089, or + 4e-4]), u.push([O1 - 0.012, or + 4e-4, 1e-3], [O1 - 0.016, Lp, 1e-3]), f > 0 && u.push([Gu + 8e-4, Lp], [Gu + 8e-4, CT, 15e-4], [El - 8e-4, CT, 15e-4], [El - 8e-4, Lp]), u.push([kh + 8e-4, Lp, 6e-4]);
        let d = [[0.0668, or + 62e-4, 12e-4], [0.0836, or + 62e-4, 12e-4], [0.0872, Lp - 44e-4, 12e-4], [0.0704, Lp - 44e-4, 12e-4]];
        c(s.slide, us(u, Ek, { x: f * (N1 - Ek / 2), b: 28e-5, holes: [...h(-0.0362, 8), ...h(0.0895, 5), d] }));
      }
      for (let f = -3; f <= 3; f++) c(s.slide, us(se(0.06, Jn - 2e-4, 0.1175, Jn + 32e-5), 8e-4, { x: f * 19e-4, b: 0 })), t.optic || c(s.slide, us(se(-0.027, Jn - 2e-4, 0.0185, Jn + 32e-5), 8e-4, { x: f * 19e-4, b: 0 }));
      c(s.ctrl, si(se(-5e-3, or + 36e-4, 5e-3, Jn - 64e-4, 12e-4), 6e-4, { u: kh - 4e-4, b: 2e-4 })), c(e.black, fa(13e-4, 3e-4, { y: No - 1e-3, u: kh - 6e-4, seg: 10 })), c(s.ctrl, us(se(-6e-3, No + 15e-4, El + 1e-3, No + 47e-4, 8e-4), 1e-3, { x: N1 + 2e-4, b: 3e-4 }), Wn(11e-4, 8e-4, { x: N1 + 5e-4, y: No + 31e-4, u: 3e-3, seg: 8 })), c(e.mark, x4("pistol", 0.046, 0.0131, -(N1 + 12e-5), 0.02, 0.03, -1)), c(s.mark, N4("maker", 0.05, 7e-3, N1 + 12e-5, 0.015, 0.042, "R"));
    }
    if (c(s.ctrl, si([[-88e-4, Jn - 4e-4], [88e-4, Jn - 4e-4], [88e-4, r - 14e-4, 6e-4], [79e-4, r, 4e-4], [22e-4, r], [22e-4, r - 44e-4], [-22e-4, r - 44e-4], [-22e-4, r], [-79e-4, r, 4e-4], [-88e-4, r - 14e-4, 6e-4]], 9e-3, { u: -0.0385, b: l(4e-4) })), c(s.ctrl, us([[0.1212, Jn - 4e-4], [0.1312, Jn - 4e-4], [0.13, r], [0.123, r]], 38e-4, { b: l(4e-4) })), i) {
      for (let h of [-1, 1]) c(e.white, fa(165e-5, 3e-4, { x: h * 54e-4, y: r - 24e-4, u: -0.03868, seg: 12 })), c(e.trit, fa(11e-4, 3e-4, { x: h * 54e-4, y: r - 24e-4, u: -0.03885, seg: 10 }));
      c(e.white, fa(165e-5, 3e-4, { y: r - 24e-4, u: 0.12215, seg: 12 })), c(e.trit, fa(11e-4, 3e-4, { y: r - 24e-4, u: 0.12198, seg: 10 })), c(s.ctrl, us(se(-0.0392, Jn - 4e-4, -0.0288, Jn + 9e-4, 4e-4), 0.0172, { b: 3e-4 }));
    }
  }
  {
    let c = (f, ...u) => o("barrel", f, ...u), h = t.threaded ? 0.1475 : O1 + 14e-4;
    if (c(e.steelBright, us(se(El + 4e-4, No - 4e-3, Gu - 4e-4, Jn - 4e-4, 1e-3), 0.0158, { b: l(8e-4) })), c(e.steelBright, fa(71e-4, h - 16e-4 - Gu, { y: No, u: Gu - 4e-4, seg: 18 })), c(e.steelBright, ni([[h - 2e-3, 71e-4], [h - 6e-4, 71e-4], [h, 64e-4], [h, 52e-4], [h - 16e-4, 46e-4], [h - 0.02, 46e-4]], { y: No, seg: n ? 10 : 18 })), i) {
      if (c(e.black, fa(46e-4, 4e-4, { y: No, u: h - 0.02, seg: 10 })), t.threaded) {
        let u = [[O1 + 52e-4, 71e-4]];
        for (let d = 0; d < 7; d++) u.push([O1 + 56e-4 + d * 6e-4, 74e-4], [O1 + 59e-4 + d * 6e-4, 69e-4]);
        c(e.steel, ni(u, { y: No, seg: 16 }));
      }
      c(e.steelBright, us([[El + 4e-4, No - 4e-3], [El + 4e-4, No - 0.01], [El - 5e-3, No - 0.0128], [El - 5e-3, No - 0.0108]], 9e-3, { b: 4e-4 })), c(e.black, si(Kr(0, No, 5e-3, 14), 3e-4, { u: El + 2e-4, b: 0 })), c(s.mark, N4("hood", 0.0115, 41e-4, 795e-5, No + 66e-4, 0.04, "R")), o("", s.ctrl, fa(3e-3, 0.079, { y: No - 0.0118, u: 0.0585, seg: 10 }), fa(3e-3, 12e-4, { y: No - 0.0118, u: 0.1375, r2: 2e-3, seg: 10 })), eT(e, { add: (u, ...d) => o("chamberRound", u, ...d) }, 0, No, 0.0224, 0.019, 49e-4, 0.0105), o("chamberRound", e.brass, us(se(El + 3e-4, Jn - 12e-4, El + 22e-4, Jn - 2e-4), 34e-4, { b: 0 }));
    }
  }
  {
    let c = (m, ...p) => o("", m, ...p);
    if (n) c(s.frame, us(BT, 2 * Mi, { b: 0 }));
    else {
      for (let m of [-1, 1]) c(s.frame, us(BT, 18e-4, { x: m * (Mi - 9e-4), b: 9e-4 }));
      c(s.frame, us([[-3e-3, _r - 2e-4], [ai(_r) - 6e-4, _r - 2e-4], [-3e-3, -0.0112]], 2 * Mi - 34e-4, { b: 0 })), c(s.frame, us([[wo(_r) + 6e-4, _r - 2e-4], [0.1318, _r - 2e-4], [0.1326, 3e-3], [0.1312, -56e-4], [0.0962, -78e-4], [0.0946, -93e-4], [wo(-95e-4) + 6e-4, -93e-4]], 2 * Mi - 34e-4, { b: 0 }));
    }
    let h = n ? P00 : NT, f = n ? [ga, -0.096, -0.075, -0.047, -0.034, -0.0125, -65e-4, -15e-4, 11e-4, 31e-4, _r] : mN;
    if (c(s.frame, gN(f, h), Uy(_r, h, true)), n) c(s.frame, Uy(ga, h, false));
    else {
      {
        let m = r1 / 2 + 5e-4 + OT, p = -(wo(ga) + 6e-4 + OT), x = -(ai(ga) - 6e-4 - OT);
        c(s.frame, Uy(ga, h, false, [[-m, p], [m, p], [m, x], [-m, x]]), R00());
      }
      c(e.black, S00(0.04)), c(s.gripTex, zT(2.62, 4.4, -0.0935, -0.04, 16, 14), zT(6.6, 8.38, -0.0935, -0.033, 16, 14), zT(0.72, 2.28, -0.0935, -0.042, 12, 12), zT(4.74, 6.26, -0.0935, -0.022, 12, 14));
      for (let m of [-1, 1]) c(s.gripTex, us([[0.087, -82e-4, 15e-4], [0.093, -74e-4, 15e-4], [0.12, -46e-4, 15e-4], [0.12, 26e-4, 15e-4], [0.087, 26e-4, 15e-4]], 6e-4, { x: m * (Mi + 1e-4), b: 2e-4 }));
    }
    if (c(s.frame, us(Ck, 0.015, n ? { b: 2e-3 } : { b: 26e-4, bs: 3, soft: true })), c(s.frame, us(n ? se(Hp, Xl, Fp, -7e-3) : y00, UT, { b: l(14e-4) })), i) {
      c(s.ctrl, us(se(0.074, -56e-4, 0.0835, -16e-4, 1e-3), 2 * Mi + 14e-4, { b: 5e-4 }));
      for (let [m, p, x] of [[U1, -68e-4, 17e-4], [0.06, 22e-4, 19e-4], [5e-3, -6e-3, 16e-4]]) c(s.ctrl, Wn(x, 2 * Mi + 5e-4, { y: p, u: m, seg: 10 }));
      c(s.mark, N4("serial", 0.019, 38e-4, Mi + 2e-4, 53e-4, 0.104, "R"), N4("warn", 0.036, 36e-4, -(Mi + 2e-4), 52e-4, 0.105, "L"));
    }
    let u = (m, ...p) => o("slideStop", m, ...p);
    if (u(s.ctrl, us([[0.061, 6e-4, 8e-4], [0.061, 5e-3, 8e-4], [0.045, 58e-4], [0.045, 2e-3]], 11e-4, { x: -(Mi + 55e-5), b: l(3e-4) })), u(s.ctrl, us(se(0.03, 12e-4, 0.046, 68e-4, 12e-4), 18e-4, { x: -(Mi + 9e-4), b: l(6e-4) })), i) for (let m = 0; m < 4; m++) u(s.ctrl, us(se(0.032 + m * 34e-4, 66e-4, 0.0333 + m * 34e-4, 73e-4), 15e-4, { x: -(Mi + 9e-4), b: 2e-4 }));
    let d = (m, ...p) => o("magRelease", m, ...p);
    if (d(s.ctrl, us(se(0.0195, -0.0275, 0.0285, -0.0195, 2e-3), 3e-3, { x: -0.0146, b: l(8e-4) })), i) for (let m = 0; m < 3; m++) d(s.ctrl, us(se(0.0211 + m * 25e-4, -0.0262, 0.0219 + m * 25e-4, -0.0208), 5e-4, { x: -0.01625, b: 1e-4 }));
    o("trigger", s.frame, us(uN, 7e-3, n ? { b: 0 } : { b: 15e-4, bs: 2, soft: true })), i && (o("trigger", s.ctrl, Wn(15e-4, 74e-4, { y: -0.01, u: U1, seg: 8 })), o("trigBlade", s.frame, us(Sc([[U1 + 1e-3, -0.014], [U1 + 1e-4, -0.02], [U1 - 3e-4, -0.0266]], 2e-3), 2e-3, { b: 5e-4 })));
  }
  {
    let c = t.magP, h = (u, ...d) => o("mag", u, ...d), f = (u, ...d) => o("magRounds", u, ...d);
    if (h(s.base, us(c.base, c.baseW, n ? { b: 1e-3 } : { b: 22e-4, bs: 2, soft: true })), i) {
      let p = r1 / 2, x = (R) => R <= 0 ? 0 : R >= 1 ? 1 : R * R * (3 - 2 * R), g = (R) => p + (68e-4 - p) * x((R - -0.0265) / (-85e-4 - -0.0265)), b = [c.yb];
      for (let R = c.yb + 0.012; R < -0.0265 - 6e-3; R += 0.014) b.push(R);
      for (let R = 0; R <= 6; R++) b.push(-0.0265 + (-85e-4 - -0.0265) * R / 6);
      b.push(Cc - 3e-3, Cc), h(s.magSteel, A00(b, g));
      let v = Cc, y = ai(v), M = wo(v);
      h(s.magLip, jc(Tk(v, 68e-4), 12e-4, { y: v - 12e-4, b: 3e-4, holes: [Tk(v, 68e-4, 1e-3, 16e-4)] })), h(e.black, jc(Tk(v, 68e-4, 6e-4, 2e-3), 3e-4, { y: v - 26e-4, b: 0 })), h(s.magLip, us(se(y, v - 1e-3, y + 24e-4, v + 6e-3, 8e-4), 2 * 68e-4 - 12e-4, { b: 5e-4 }));
      for (let R of [-1, 1]) h(s.magLip, si([[R * 68e-4, v - 1e-3], [R * 68e-4, v + 44e-4, 22e-4], [R * 36e-4, v + 8e-3, 5e-4], [R * 31e-4, v + 71e-4, 3e-4], [R * (68e-4 - 1e-3), v + 38e-4, 16e-4], [R * (68e-4 - 1e-3), v - 1e-3]], 0.0236, { u: y + 1e-3, b: 4e-4 }));
      let w = -0.03, T = c.yb + 0.0105;
      h(s.magSteel, us([[wo(w) - 68e-4, w, 14e-4], [wo(w) - 0.01, w, 14e-4], [wo(T) - 0.01, T, 14e-4], [wo(T) - 68e-4, T, 14e-4]], r1 + 8e-4, { b: 4e-4 })), h(s.magSteel, us([[ai(w) + 0.0118, w - 6e-3, 24e-4], [ai(w) + 62e-4, w - 6e-3, 24e-4], [ai(T) + 62e-4, T, 24e-4], [ai(T) + 0.0118, T, 24e-4]], r1 + 5e-4, { b: 25e-5 }));
      for (let R of [-1, 1]) h(e.black, us(se(wo(-0.034) - 92e-4, -0.0374, wo(-0.034) - 36e-4, -0.032, 6e-4), 6e-4, { x: R * (r1 / 2 - 18e-5), b: 0 }));
      let S = c.yb < -0.11 ? [[-0.044, "5"], [-0.062, "10"], [-0.08, "15"], [-0.098, "20"]] : [[-0.044, "5"], [-0.062, "10"], [-0.08, "15"]];
      for (let [R, C] of S) {
        let L = ai(R) + 9e-3;
        h(e.black, Wn(23e-4, r1 + 75e-5, { y: R, u: L, seg: 14 })), f(s.brass, Wn(18e-4, r1 + 9e-4, { y: R, u: L, seg: 12 })), h(s.mark, N4("n" + C, 52e-4, 36e-4, r1 / 2 + 2e-4, R, L + 68e-4, "R"), N4("n" + C, 52e-4, 36e-4, -(r1 / 2 + 2e-4), R, L + 68e-4, "L"));
      }
      {
        let R = Bt(0, Math.sin(Math.atan(N5)), Math.cos(Math.atan(N5)));
        for (let C = -0.036; C > c.yb + 0.012; C -= 0.011) {
          let L = Gt(0, C, ai(C));
          h(e.black, U4(15e-4, 3e-4, L, R, 10)), f(s.brass, U4(105e-5, 5e-4, L, R, 8));
        }
      }
      for (let R = 0; R < 3; R++) h(s.base, us(se(ai(c.y1 + 4e-3) + 6e-3, c.y1 + 2e-3 + R * 17e-4, wo(c.y1 + 4e-3) - 1e-3, c.y1 + 3e-3 + R * 17e-4, 4e-4), c.baseW + 8e-4, { b: 3e-4 }));
      {
        let R = (wo(c.y1) + ai(c.y1)) / 2 + 2e-3, C = Bt(0, -1, 0);
        h(e.black, U4(42e-4, 3e-4, Gt(0, c.y1 - 3e-5, R), C, 16)), h(s.ctrl, U4(32e-4, 5e-4, Gt(0, c.y1 - 1e-4, R), C, 14)), h(s.base, us(se(R + 75e-4, c.y1 - 4e-4, R + 9e-3, c.y1 + 4e-4), c.baseW * 0.62, { b: 2e-4 }), us(se(R - 9e-3, c.y1 - 4e-4, R - 75e-4, c.y1 + 4e-4), c.baseW * 0.62, { b: 2e-4 }));
      }
      let E = (R, C) => f(s[R], C);
      nN(E, 0, v + 3e-3, y + 32e-4, 0.045, 18), nN(E, -8e-4, v - 687e-5, ai(v - 687e-5) + 3e-3, 0.03, 10);
      let _ = (...R) => o("magFollower", s.follower, ...R);
      _(us([[y + 32e-4, v - 16e-4], [M - 36e-4, v - 16e-4], [M - 36e-4, v + 16e-4, 1e-3], [y + 0.015, v + 46e-4, 3e-3], [y + 32e-4, v + 5e-3, 1e-3]], 0.0106, { b: 9e-4, bs: 2, soft: true })), _(us([[y + 45e-4, v + 46e-4], [M - 6e-3, v + 12e-4], [M - 6e-3, v + 24e-4, 6e-4], [y + 0.015, v + 56e-4, 2e-3], [y + 45e-4, v + 6e-3, 6e-4]], 3e-3, { b: 6e-4 })), _(us(se(M - 0.0125, v + 4e-4, M - 5e-3, v + 4e-3, 6e-4), 24e-4, { x: -42e-4, b: 5e-4 }));
    }
  }
}
var Oy = (o, t) => (globalThis.GH_TUNE || {})[o] ?? t, aN = /* @__PURE__ */ new Map(), Rk = 0.26, bN = Gt(-0.12, -0.06, 0.02);
function z00(o) {
  let t = o || {};
  return { camo: t.camo || "factory", optic: t.optic === "reflex" ? "reflex" : "irons", muzzle: t.muzzle === "suppressor" || t.muzzle === "comp" ? t.muzzle : "none", underbarrel: t.underbarrel === "laser" ? "laser" : "none", magazine: t.magazine === "ext" ? "ext" : "std" };
}
function GT(o = {}) {
  let t = z00(o.build), e = o.detail === "world", s = performance.now(), n = t.optic === "reflex" ? Mp("microdot") : null, i = t.muzzle !== "none" ? gf(t.muzzle, { caliber: "pistol" }) : null, a = t.underbarrel === "laser" ? wp("laser", { mount: "rail" }) : null, r = i ? No + i.radius - Jn : 0, l = n ? n.height - 22e-4 - n.window[1] / 6 : r > 3e-3 ? Math.min(0.0125, Math.max(0.01, r + 36e-4)) : 58e-4, c = { lo: e, optic: !!n, threaded: !!i, sightH: l, magP: dN(t.magazine) }, h = Gt(0, No, i ? 0.1475 : O1 + 14e-4), f = Gt(0, Jn - 22e-4, -4e-3), u = Gt(0, Xl, PT), d = { muzzle: i ? h.clone().add(Bt(0, 0, -i.length)) : h.clone(), eject: Gt(0.0105, 0.0315, 0.039), ejectDir: Bt(0.72, 0.58, 0.38).normalize(), sight: n ? f.clone().add(n.eye).add(Bt(0, 0, -Rk)) : Gt(0, Jn + l - 4e-4, -0.0385), gripR: new THREE.Object3D(), gripL: new THREE.Object3D() };
  a && a.laser && (d.laser = u.clone().add(a.laser)), d.gripR.name = "gripR", d.gripL.name = "gripL";
  let m = { pos: Bt(0.06, -0.062, -0.3), rot: new THREE.Euler(0.03, 0.07, -0.02) };
  if (e) {
    let L = new THREE.Group();
    L.name = "gun_pistol";
    let A = [t.optic, t.muzzle, t.underbarrel, t.magazine, t.camo].join("."), O = aN.get(A);
    if (!O) {
      let H = VT(), F = [], P = [], z = xl(t.camo, "metal"), k = new THREE.Color(), I = ($, n0, e0) => {
        if ($.transparent) return;
        if (e0 && (n0 = n0.clone().applyMatrix4(e0)), z && ($ === H.slide || $ === H.frame || $ === H.base)) {
          P.push(n0);
          return;
        }
        k.copy($.userData && $.userData.base && $.userData.base.isColor ? $.userData.base : $.color || k.set(2105378)), $.emissive && $.emissiveIntensity > 1 && k.copy($.emissive);
        let p0 = n0.attributes.color.array;
        for (let t0 = 0; t0 < p0.length; t0 += 3) p0[t0] = k.r, p0[t0 + 1] = k.g, p0[t0 + 2] = k.b;
        F.push(n0);
      };
      iN(($, n0, ...e0) => {
        if (!($ === "chamberRound" || $ === "magRounds" || $ === "magFollower")) for (let p0 of e0) I(n0, p0);
      }, c);
      let G = ao(), K = Jn - 22e-4;
      i && I(G.alu, fa(i.radius, i.length, { y: No, u: 0.1475, seg: 20 })), n && (I(G.aluLt, us(se(-0.0275, K, 0.019, K + 6e-3), 0.027, { b: 0 })), I(G.aluLt, si([[-0.0135, K + 5e-3], [0.0135, K + 5e-3], [0.0135, K + 0.024], [95e-4, K + 0.028], [-95e-4, K + 0.028], [-0.0135, K + 0.024]], 8e-3, { u: 9e-3, b: 0, holes: [[[-0.0105, K + 0.0105], [0.0105, K + 0.0105], [0.0105, K + 0.024], [-0.0105, K + 0.024]]] }))), a && I(G.alu, us(se(PT - 0.029, Xl - 0.031, PT + 0.029, Xl + 5e-3, 4e-3), 0.036, { b: 0 })), O = { plain: F.length ? Vn(F, false) : null, paint: P.length ? Rc(Vn(P, false)) : null, cm: z }, aN.set(A, O);
    }
    if (O.plain) {
      let H = new THREE.Mesh(O.plain, ao().world);
      H.castShadow = H.receiveShadow = true, L.add(H);
    }
    if (O.paint) {
      let H = new THREE.Mesh(O.paint, O.cm);
      H.castShadow = H.receiveShadow = true, L.add(H);
    }
    return d.gripR.position.set(4e-3, -0.05, 0.012), d.gripL.position.set(-0.014, -0.062, -6e-3), L.add(d.gripR, d.gripL), { id: "pistol", root: L, anchors: d, hip: m, adsDist: Rk, hands: null, clips: null, build: o.build || null, mounts: null, resetPose() {
    } };
  }
  let p = new THREE.Group(), x = {}, g = {}, b = VT();
  p.name = "gun_pistol", iN((L, A, ...O) => {
    (g[L] || (g[L] = g4())).add(A, ...O);
  }, c);
  for (let L of ["slide", "barrel", "trigger", "slideStop", "magRelease", "mag", "chamberRound"]) {
    let A = Du(p, x, L, Fy[L]);
    g[L].build(A, Fy[L]);
  }
  let y = (L, A, O) => {
    let H = new THREE.Group();
    return H.name = A, H.userData.keep = true, H.userData.rest = Fy[A].clone().sub(Fy[L]), H.position.copy(H.userData.rest), O && (H.userData.hidden = true, H.visible = false), x[L].add(H), x[A] = H, g[A].build(H, Fy[A]), H;
  };
  y("trigger", "trigBlade"), y("mag", "magRounds"), y("mag", "magFollower", true);
  {
    let L = Du(p, x, "frag", bN);
    L.userData.hidden = true, L.visible = false, L.add(Z2());
  }
  g[""].build(p);
  let M = (L, A, O) => {
    let H = new THREE.Object3D();
    return H.name = "mount_" + A, H.position.copy(O), L !== p && H.position.sub(L.userData.rest), L.add(H), H;
  }, w = { optic: M(x.slide, "optic", f), muzzle: M(x.barrel, "muzzle", h), underbarrel: M(p, "underbarrel", u) };
  if (n && w.optic.add(n.group), i && w.muzzle.add(i.group), a && w.underbarrel.add(a.group), t.camo !== "factory" && xl(t.camo, "metal")) {
    let L = /* @__PURE__ */ new Map([[b.slide, "metal"], [b.frame, "polymer"], [b.base, "polymer"], [b.gripTex, "furniture"]]), A = new THREE.Matrix4(), O = new THREE.Matrix4();
    p.updateMatrixWorld(true), A.copy(p.matrixWorld).invert(), p.traverse((H) => {
      !H.isMesh || !L.has(H.material) || (H.geometry = Rc(H.geometry, O.multiplyMatrices(A, H.matrixWorld)), H.material = xl(t.camo, L.get(H.material)));
    });
  }
  if (t.camo !== "factory") for (let L of [n, i, a]) L && Ou(L, t.camo);
  p.add(d.gripR, d.gripL);
  let T = { id: "pistol", root: p, parts: x, anchors: d, mounts: w, hip: m, adsDist: Rk, build: o.build || null, underKind: t.underbarrel, opticKind: t.optic, magKind: t.magazine, magP: c.magP, dims: { TRAVEL: x00, BORE: No, ST: Jn, SB: or, sightH: l, mf: wo, mb: ai, MT0: Cc } };
  T.setSlide = (L) => {
    let A = x, O = Math.min(1, Math.max(0, (L - 12e-4) / 45e-4)), H = O * O * (3 - 2 * O);
    A.slide.position.z = A.slide.userData.rest.z + L, A.barrel.position.z = A.barrel.userData.rest.z + Math.min(L, 3e-3), A.barrel.rotation.set(0.021 * H, 0, 0), A.chamberRound.position.z = A.chamberRound.userData.rest.z + Math.min(L, 0.03);
  };
  T.attachments = {};
  if (n) T.attachments.optic = n;
  if (i) T.attachments.muzzle = i;
  if (a) T.attachments.underbarrel = a;
  T.tris = WJ(p);
  return T;
}
var l1 = { BORE: 0.042, TUBEY: 0.0145, RW: 0.0195, RB: 45e-4, RT: 0.0585, U0: 0.022, U1: 0.228, RAIL0: 0.064, RAIL1: 0.174, RAILY: 0.059, PUMP0: 0.314, PUMP1: 0.474, STROKE: 0.082, BOLT: 0.076, UNLOCK: 6e-3, MUZ: 0.64, TUBE_STD: 0.552, TUBE_EXT: 0.626, PORT: { u0: 0.13, u1: 0.206, y0: 0.0315, y1: 0.0525 }, LOAD: { u0: 0.104, u1: 0.206, hw: 0.0136, top: 0.0538 }, SHELL: { r: 0.0101, len: 0.06, rim: 0.0112, head: 0.016 }, SHELL_REST: [0, 0.0145, 0.166], LIFT_PIVOT: [0, 6e-3, 0.06] }, { BORE: Ws, TUBEY: Ts, RW: po, RB: Li, RT: c1, U0: SN, U1: qT, RAIL0: Xu, RAIL1: V5, RAILY: Np, PUMP0: ir, PUMP1: Zr, MUZ: xa, PORT: Ro, LOAD: hn, SHELL: La } = l1, Ch = Np + 75e-4, Ef = Ch + 0.0125, W4 = 0.0236, Wy = 1.07, Gy = Ts + 0.019, qy = 0.0142, _N = (o) => o.map((t) => [t[0], t[1]]), Bp = (o, t, e) => o < t ? t : o > e ? e : o, Tf = (o, t, e) => {
  let s = Bp((e - o) / (t - o), 0, 1);
  return s * s * (3 - 2 * s);
};
function V00(o) {
  let t = o.length, e = o[0].length - 1;
  return (s, n = new Array(e)) => {
    if (s <= o[0][0]) {
      for (let m = 0; m < e; m++) n[m] = o[0][m + 1];
      return n;
    }
    if (s >= o[t - 1][0]) {
      for (let m = 0; m < e; m++) n[m] = o[t - 1][m + 1];
      return n;
    }
    let i = 0;
    for (; s > o[i + 1][0]; ) i++;
    let a = o[Math.max(0, i - 1)], r = o[i], l = o[i + 1], c = o[Math.min(t - 1, i + 2)], h = l[0] - r[0], f = (s - r[0]) / h, u = f * f, d = u * f;
    for (let m = 1; m <= e; m++) {
      let p = (l[m] - a[m]) / (l[0] - a[0]) * h, x = (c[m] - r[m]) / (c[0] - r[0]) * h;
      n[m - 1] = (2 * d - 3 * u + 1) * r[m] + (d - 2 * u + f) * p + (-2 * d + 3 * u) * l[m] + (d - u) * x;
    }
    return n;
  };
}
function U5(o, t, e = {}) {
  let s = o.map((v, y) => t(v, y)), n = o.length, i = s[0].length, a = [0];
  for (let v = 1; v < n; v++) {
    let y = 0;
    for (let M = 0; M < i; M++) y += Math.hypot(s[v][M][0] - s[v - 1][M][0], s[v][M][1] - s[v - 1][M][1], o[v] - o[v - 1]);
    a.push(a[v - 1] + y / i);
  }
  let r = a[n - 1], l = [], c = [], h = [], f = 0;
  {
    let v = s[n >> 1];
    for (let y = 0; y < i; y++) {
      let M = v[y], w = v[(y + 1) % i];
      f += Math.hypot(M[0] - w[0], M[1] - w[1]);
    }
  }
  for (let v = 0; v < n; v++) for (let y = 0; y <= i; y++) {
    let M = s[v][y % i];
    l.push(M[0], M[1], -o[v]), e.metric ? c.push(a[v], y / i * f) : c.push(a[v] / r, y / i);
  }
  for (let v = 0; v < n - 1; v++) for (let y = 0; y < i; y++) {
    let M = v * (i + 1) + y, w = M + 1, T = M + i + 1, S = T + 1;
    h.push(M, T, w, w, T, S);
  }
  for (let [v, y] of [[e.capA, 0], [e.capB, n - 1]]) {
    if (!v) continue;
    let M = 0, w = 0;
    for (let E of s[y]) M += E[0] / i, w += E[1] / i;
    let T = l.length / 3;
    for (let E = 0; E <= i; E++) {
      let _ = s[y][E % i];
      l.push(_[0], _[1], -o[y]), c.push(e.metric ? a[y] : a[y] / r, e.metric ? E / i * f : E / i);
    }
    let S = l.length / 3;
    l.push(M, w, -o[y]), c.push(e.metric ? a[y] : a[y] / r, 0.5);
    for (let E = 0; E < i; E++) y === 0 ? h.push(S, T + E, T + E + 1) : h.push(S, T + E + 1, T + E);
  }
  let u = new THREE.BufferGeometry();
  u.setAttribute("position", new THREE.Float32BufferAttribute(l, 3)), u.setAttribute("uv", new THREE.Float32BufferAttribute(c, 2));
  let d = 0, m = 0, p = 0;
  for (let v = 0; v < l.length; v += 3) p += l[v], m += l[v + 1], d += l[v + 2];
  p /= l.length / 3, m /= l.length / 3, d /= l.length / 3;
  let x = 0;
  for (let v = 0; v < h.length; v += 3) {
    let y = h[v] * 3, M = h[v + 1] * 3, w = h[v + 2] * 3, T = l[y] - p, S = l[y + 1] - m, E = l[y + 2] - d, _ = l[M] - p, R = l[M + 1] - m, C = l[M + 2] - d, L = l[w] - p, A = l[w + 1] - m, O = l[w + 2] - d;
    x += T * (R * O - C * A) - S * (_ * O - C * L) + E * (_ * A - R * L);
  }
  if (x < 0) for (let v = 0; v < h.length; v += 3) {
    let y = h[v + 1];
    h[v + 1] = h[v + 2], h[v + 2] = y;
  }
  u.setIndex(h), u = e.flat ? u.toNonIndexed() : th(u, e.crease ?? 0.75), e.flat && u.computeVertexNormals();
  let g = [0, 0];
  return { geo: u, at: (v, y, M) => {
    let w = v * r, T = 0;
    for (; T < n - 2 && a[T + 1] < w; ) T++;
    let S = a[T + 1] > a[T] ? Bp((w - a[T]) / (a[T + 1] - a[T]), 0, 1) : 0, E = (y % 1 + 1) % 1 * i, _ = Math.floor(E) % i, R = E - Math.floor(E), C = (_ + 1) % i, L = s[T], A = s[T + 1];
    return g[0] = (L[_][0] * (1 - R) + L[C][0] * R) * (1 - S) + (A[_][0] * (1 - R) + A[C][0] * R) * S, g[1] = (L[_][1] * (1 - R) + L[C][1] * R) * (1 - S) + (A[_][1] * (1 - R) + A[C][1] * R) * S, M.set(g[0], g[1], -(o[T] * (1 - S) + o[T + 1] * S));
  }, L: r, per: f };
}
function Ik(o, t) {
  let e = [], s = o[2], n = o[3], i = o[4], a = o[0] - o[1];
  if (n + i > a) {
    let c = a / (n + i);
    n *= c, i *= c;
  }
  let r = o[0] - n, l = o[1] + i;
  for (let c = 0; c <= t; c++) {
    let h = Math.PI * c / t, f = Math.cos(h), u = Math.sin(h);
    e.push([s * Math.sign(f) * Math.pow(Math.abs(f), 2 / o[5]), r + n * Math.pow(u, 2 / o[5])]);
  }
  for (let c = 0; c <= t; c++) {
    let h = Math.PI * c / t, f = -Math.cos(h), u = Math.sin(h);
    e.push([s * Math.sign(f) * Math.pow(Math.abs(f), 2 / o[6]), l - i * Math.pow(u, 2 / o[6])]);
  }
  return e;
}
function G00(o, t) {
  let e = o[3], s = o[4], n = o[0] - o[1];
  if (e + s > n) {
    let r = n / (e + s);
    e *= r, s *= r;
  }
  let i = o[0] - e, a = o[1] + s;
  return t > o[0] || t < o[1] ? 0 : t > i ? o[2] * Math.pow(Math.max(0, 1 - Math.pow((t - i) / e, o[5])), 1 / o[5]) : t < a ? o[2] * Math.pow(Math.max(0, 1 - Math.pow((a - t) / s, o[6])), 1 / o[6]) : o[2];
}
var q00 = [[-0.295, 0.0165, -0.101, 0.0208, 0.014, 0.014, 2.8, 2.8], [-0.25, 0.02, -0.09, 0.0208, 0.014, 0.015, 2.6, 2.5], [-0.2, 0.024, -0.079, 0.0204, 0.013, 0.016, 2.5, 2.4], [-0.15, 0.0272, -0.069, 0.0196, 0.012, 0.016, 2.5, 2.3], [-0.12, 0.0275, -0.07, 0.019, 0.012, 0.016, 2.5, 2.3], [-0.104, 0.025, -0.0745, 0.0188, 0.013, 0.015, 2.4, 2.3], [-0.09, 0.02, -0.081, 0.0187, 0.014, 0.013, 2.3, 2.4], [-0.078, 0.014, -0.085, 0.0186, 0.015, 0.012, 2.2, 2.6], [-0.066, 92e-4, -0.086, 0.0184, 0.016, 0.014, 2.2, 2.6], [-0.054, 68e-4, -0.081, 0.018, 0.016, 0.02, 2.2, 2.3], [-0.04, 6e-3, -0.067, 0.0176, 0.016, 0.023, 2.2, 2.2], [-0.026, 66e-4, -0.05, 0.0174, 0.0155, 0.023, 2.2, 2.2], [-0.012, 85e-4, -0.033, 0.0176, 0.015, 0.021, 2.2, 2.2], [0, 0.0128, -0.018, 0.0182, 0.014, 0.016, 2.4, 2.3], [0.01, 0.0215, -65e-4, 0.0192, 0.012, 0.01, 2.8, 2.8], [0.022, 0.033, 15e-4, 0.0187, 9e-3, 4e-3, 3.4, 3.6]], G4 = V00(q00), K00 = [-0.295, -0.272, -0.246, -0.218, -0.19, -0.165, -0.146, -0.132, -0.121, -0.112, -0.104, -0.097, -0.09, -0.083, -0.076, -0.069, -0.062, -0.055, -0.048, -0.041, -0.034, -0.027, -0.02, -0.013, -6e-3, 0, 5e-3, 0.01, 0.014, 0.018, 0.022], zN = 11, LN = 0.0128, DN = ir + 0.016;
function X00(o) {
  let t = W4;
  for (let s = 0; s < zN; s++) {
    let n = Math.abs(o - (DN + s * LN));
    n < 24e-4 && (t -= 15e-4 * (1 - Tf(5e-4, 24e-4, n)));
  }
  let e = Math.min(o - ir, Zr - o);
  return e < 45e-4 && (t -= 45e-4 * (1 - Math.sqrt(Math.max(0, 1 - Math.pow(1 - e / 45e-4, 2))))), t;
}
function Y00(o, t) {
  let e = Ws - Ts;
  return t.map((s) => {
    let n = Math.cos(s), i = Math.sin(s), a = Wy * n, r = o;
    if (i > 0) {
      r = Math.min(r, (Gy - Ts) / i);
      let l = a * a + i * i, c = e * e * i * i - l * (e * e - qy * qy);
      c > 0 && (r = Math.min(r, (e * i - Math.sqrt(c)) / l));
    }
    return [Wy * r * n, Ts + r * i];
  });
}
function j00(o) {
  let t = Ws - Ts, e = Math.asin(Bp((Gy - Ts) / W4, -1, 1)), s = Math.atan2((Gy - Ts) * Wy, Math.sqrt(Math.max(1e-9, qy * qy - Math.pow(t - (Gy - Ts), 2)))), n = [], i = (l, c, h) => {
    for (let f = 0; f < h; f++) n.push(l + (c - l) * f / h);
  }, a = Math.PI - e, r = e;
  return i(a, Math.PI + 0.35, o ? 4 : 2), i(Math.PI + 0.35, 2 * Math.PI - 0.35, o ? 12 : 5), i(2 * Math.PI - 0.35, 2 * Math.PI + r, o ? 4 : 2), i(r, s, o ? 2 : 1), i(s, Math.PI - s, o ? 5 : 2), i(Math.PI - s, a, o ? 2 : 1), n;
}
function KT(o) {
  let t = Re(o), e = new Float32Array(4096);
  for (let l = 0; l < 4096; l++) e[l] = t();
  let s = (l, c, h) => e[(Math.imul(l, 73856093) ^ Math.imul(c, 19349663) ^ Math.imul(h, 83492791)) & 4095], n = (l) => l * l * (3 - 2 * l), i = (l, c, h) => l + (c - l) * h, a = (l, c, h) => {
    let f = Math.floor(l), u = Math.floor(c), d = Math.floor(h), m = n(l - f), p = n(c - u), x = n(h - d);
    return i(i(i(s(f, u, d), s(f + 1, u, d), m), i(s(f, u + 1, d), s(f + 1, u + 1, d), m), p), i(i(s(f, u, d + 1), s(f + 1, u, d + 1), m), i(s(f, u + 1, d + 1), s(f + 1, u + 1, d + 1), m), p), x);
  };
  return { noise: a, fbm: (l, c, h, f) => {
    let u = 0.5, d = 0, m = 0;
    for (let p = 0; p < f; p++) d += u * a(l, c, h), m += u, l *= 2.03, c *= 2.03, h *= 2.03, u *= 0.5;
    return d / m;
  } };
}
var Tl = (o, t) => (globalThis.GH_TUNE || {})[o] ?? t;
function Z00(o, t, e, s, n) {
  let i = o - 0.055 - e * 0.09, a = t + 0.11 * n.off + e * 0.22 * n.skew, r = Math.hypot(i, a);
  r += (s.fbm(o * 6, t * 6, e * 1.6, 3) - 0.5) * 0.075 + (s.fbm(o * 30, t * 30, e * 5, 2) - 0.5) * 4e-3;
  let l = r / 9e-3, c = l - Math.floor(l), h = Tf(0.25, 0.85, c) * (1 - Tf(0.85, 1, c)), f = s.fbm(o * 44, t * 44, e * 2.2, 4), u = Tf(0.46, 0.74, s.fbm(o * 13 + 7, t * 13, e * 1.2 + 3, 3)), d = Tf(0.61, 0.66, s.fbm(o * 90 + 3, t * 90, e * 1, 3)), m = Tf(0.7, 0.9, s.fbm(o * 900, t * 900, e * 150, 2)) * (0.4 + 0.6 * c), p = Tf(0.42, 0.72, s.fbm(o * 7 + 11, t * 7, e * 2.4, 2)), x = (Math.sin(e * 250 + s.fbm(o * 16, t * 16, e * 9, 2) * 28) * 0.5 + 0.5) * p + 0.5 * (1 - p), g = s.fbm(o * 420, t * 420, e * 9, 2), b = s.fbm(o * 9 + 2, t * 9, e * 6 + 5, 3);
  return Bp(0.58 + (f - 0.5) * Tl("ws", 0.36) + (b - 0.5) * 0.3 - h * Tl("wl", 0.034) - u * Tl("wm", 0.2) - d * 0.17 - m * 0.2 + (g - 0.5) * 0.22 + (x - 0.5) * 0.17 * n.curl, 0, 1);
}
var WT = [[19, 11, 7], [38, 22, 13], [61, 37, 22], [86, 54, 33], [110, 73, 47]];
function RN(o, t, e, s, n) {
  let i = we(o, t), a = i.getContext("2d"), r = a.createImageData(o, t), l = r.data, c = new THREE.Vector3(), h = KT(s);
  for (let u = 0; u < t; u++) for (let d = 0; d < o; d++) {
    e((d + 0.5) / o, (u + 0.5) / t, c);
    let m = Z00(c.x, c.y, c.z, h, n) * (WT.length - 1), p = Math.min(WT.length - 2, Math.floor(m)), x = m - p, g = WT[p], b = WT[p + 1], v = (u * o + d) * 4;
    l[v] = g[0] + (b[0] - g[0]) * x, l[v + 1] = g[1] + (b[1] - g[1]) * x, l[v + 2] = g[2] + (b[2] - g[2]) * x, l[v + 3] = 255;
  }
  a.putImageData(r, 0, 0);
  let f = makeCanvasTexture(i);
  return f.flipY = false, f.colorSpace = THREE.SRGBColorSpace, f.anisotropy = 8, f.wrapS = THREE.ClampToEdgeWrapping, f.wrapT = THREE.RepeatWrapping, f;
}
var Hk = null;
function Q00() {
  if (Hk) return Hk;
  let o = ao(), t = Re(71), e = 256, s = (v, y, M, w, T = 1) => {
    let S = v.clone();
    return S.color.set(y), S.roughness = M, S.envMapIntensity = T, S.userData = { base: new THREE.Color(y), wear: w }, S;
  }, n = new Float32Array(e * e);
  for (let v = 0; v < n.length; v++) n[v] = t();
  let i = KT(5), a = ff(e, (v, y) => {
    let M = i.noise(v / 18, y / 1.3, 0.5);
    return (M > 0.62 ? -(M - 0.62) * 3.2 : 0) + i.noise(v / 60, y / 5, 9) * 0.25 + n[y * e + v] * 0.05;
  }, 2.2, (v, y) => 0.42 + 0.3 * i.noise(v / 18, y / 1.3, 0.5) + 0.12 * i.noise(v / 40, y / 40, 4)), r = {}, l = (v, y, M, w) => {
    if (r[v]) return r[v];
    let T = new THREE.MeshPhysicalMaterial({ map: y(), roughness: 1, metalness: 0, clearcoat: Tl("wcc", 0.34), clearcoatRoughness: Tl("wcr", 0.3), normalMap: x2(a.n, M, w), normalScale: new THREE.Vector2(0.55, 0.55), roughnessMap: x2(a.r, M, w) });
    return T.userData = { base: new THREE.Color(4860437), wear: 1 }, r[v] = T;
  }, c = (() => {
    let T = Ze(16), S = Math.sin(T), E = Math.cos(T), _ = 1.45, R = 0.55, C = Math.sin(Ze(32)), L = Math.cos(Ze(32)), A = new Float32Array(512 * 256), O = new Float32Array(512 * 256), H = new Float32Array(512 * 256), F = KT(41), P = -73.7 / 2 * S + 30 / 2 * E, z = 73.7 / 2 * S + 30 / 2 * E, k = (M0) => 1 - Math.abs(2 * (M0 - Math.floor(M0)) - 1);
    for (let M0 = 0; M0 < 256; M0++) for (let f0 = 0; f0 < 512; f0++) {
      let _0 = (f0 + 0.5) / 512 * 73.7, F0 = (M0 + 0.5) / 256 * 30, m0 = -_0 * S + F0 * E, S0 = _0 * S + F0 * E, T0 = Math.min(13.4 - Math.abs(F0 - 30 / 2), (35.2 - Math.abs(_0 - 73.7 / 2)) * C - Math.abs(F0 - 30 / 2) * L), j0 = M0 * 512 + f0;
      O[j0] = T0;
      let Z0 = Bp(1.15 * (1 - Tf(0.8, 5.5, T0)) + 1.5 * Tf(0.52, 0.78, F.fbm(_0 * 0.16, F0 * 0.16, 2.5, 3)) - 0.15, 0, 1);
      H[j0] = Z0;
      let lt = Math.min(k(m0 / _), k(S0 / _));
      A[j0] = T0 < 0.25 ? 1 : T0 < 0.8 ? 0.05 : Math.min(lt, 1 - 0.72 * Z0);
    }
    let I = (M0) => {
      let f0 = we(512, 256), _0 = f0.getContext("2d");
      return { c: f0, g: _0, img: _0.createImageData(512, 256), srgb: M0 };
    }, G = I(true), K = I(false), $ = I(false), n0 = R / (73.7 / 512), e0 = R / (30 / 256);
    for (let M0 = 0; M0 < 256; M0++) for (let f0 = 0; f0 < 512; f0++) {
      let _0 = M0 * 512 + f0, F0 = _0 * 4, m0 = A[_0], S0 = A[M0 * 512 + Math.min(511, f0 + 1)] - A[M0 * 512 + Math.max(0, f0 - 1)], T0 = A[Math.min(255, M0 + 1) * 512 + f0] - A[Math.max(0, M0 - 1) * 512 + f0], j0 = -S0 * 0.5 * n0, Z0 = -T0 * 0.5 * e0, lt = 1 / Math.hypot(j0, Z0, 1);
      K.img.data[F0] = (j0 * lt * 0.5 + 0.5) * 255, K.img.data[F0 + 1] = (Z0 * lt * 0.5 + 0.5) * 255, K.img.data[F0 + 2] = (lt * 0.5 + 0.5) * 255, K.img.data[F0 + 3] = 255;
      let H0 = m0 >= 1 - 0.72 * H[_0] - 1e-4 && O[_0] >= 0.8 ? H[_0] : 0, Y0 = 0.4 + 0.46 * m0 + 0.5 * H0, et = 0.92 + 0.16 * F.noise(f0 * 0.9, M0 * 0.9, 7);
      G.img.data[F0] = Math.min(255, 58 * Y0 * et), G.img.data[F0 + 1] = Math.min(255, 31 * Y0 * et), G.img.data[F0 + 2] = Math.min(255, 15 * Y0 * et), G.img.data[F0 + 3] = O[_0] > 0.25 ? 255 : 0;
      let ct = Bp(0.92 - 0.42 * H0 - 0.1 * m0, 0.3, 1) * 255;
      $.img.data[F0] = $.img.data[F0 + 1] = $.img.data[F0 + 2] = ct, $.img.data[F0 + 3] = 255;
    }
    let p0 = (M0) => {
      M0.g.putImageData(M0.img, 0, 0);
      let f0 = makeCanvasTexture(M0.c);
      return f0.flipY = false, f0.anisotropy = 8, M0.srgb && (f0.colorSpace = THREE.SRGBColorSpace), f0;
    }, t0 = new THREE.MeshStandardMaterial({ map: p0(G), normalMap: p0(K), roughnessMap: p0($), roughness: 1, metalness: 0, normalScale: new THREE.Vector2(1.9, 1.9), alphaTest: 0.5, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    return t0.userData = { base: new THREE.Color(2889483), wear: 1 }, t0;
  })(), h = J00(), f = we(1024, 256), u = f.getContext("2d"), d = {};
  u.fillStyle = "#fff", u.textBaseline = "middle";
  let m = (v, y = 600) => y + " " + v + 'px Bahnschrift, "Segoe UI", Arial, sans-serif', p = (v, y, M, w, T, S) => {
    u.save(), u.translate(y, M), S(w, T), u.restore(), d[v] = [y / 1024, 1 - (M + T) / 256, (y + w) / 1024, 1 - M / 256];
  };
  p("gauge", 0, 0, 640, 64, () => {
    u.font = m(40, 700), u.fillText("12 GA", 6, 34), u.font = m(30), u.fillText("FOR 2\xBE AND 3 INCH SHELLS", 150, 35);
  }), p("maker", 0, 72, 800, 56, () => {
    u.font = m(30), u.fillText("GH-ARMS  \xB7  SOLSTICE WORKS  \xB7  CYL BORE  \xB7  STEEL SHOT OK", 6, 30);
  }), p("proof", 0, 136, 200, 80, () => {
    u.lineWidth = 4, u.strokeStyle = "#fff", u.beginPath(), u.arc(38, 40, 28, 0, 6.283), u.stroke(), u.font = m(30, 700), u.fillText("GH", 17, 42), u.strokeRect(84, 14, 52, 52), u.fillText("P", 100, 42), u.font = m(24, 700), u.fillText("N", 152, 42);
  }), p("safe", 220, 136, 150, 80, () => {
    u.font = m(26, 700), u.fillText("PUSH", 4, 22), u.fillText("SAFE", 4, 56), u.beginPath(), u.moveTo(96, 40), u.lineTo(140, 40), u.lineTo(126, 28), u.moveTo(140, 40), u.lineTo(126, 52), u.lineWidth = 5, u.strokeStyle = "#fff", u.stroke();
  });
  let x = makeCanvasTexture(f);
  x.anisotropy = 8, x.colorSpace = THREE.SRGBColorSpace;
  let g = o.mark.clone();
  return g.map = x, g.userData = { base: new THREE.Color(6974576), wear: 1, cells: d }, Hk = { mark: g, sgDecal: (v, y, M, w, T, S) => {
    let E = d[v], _ = y * ((E[3] - E[1]) * 256) / ((E[2] - E[0]) * 1024), R = new THREE.PlaneGeometry(y, _), C = R.attributes.uv;
    for (let L = 0; L < C.count; L++) C.setXY(L, E[0] + C.getX(L) * (E[2] - E[0]), E[1] + C.getY(L) * (E[3] - E[1]));
    return R.rotateY(S < 0 ? -Math.PI / 2 : Math.PI / 2), R.translate(M, w, -T), Qe(R);
  }, blued: s(o.steel, 2106153, Tl("brg", 0.45), 2.1, Tl("ben", 0.85)), bluedMatte: s(o.steel, 2303531, Tl("mrg", 0.9), 2.1, 0.5), carrier: s(o.steel, 5001044, Tl("crg", 0.85), 1.6, 0.6), tubeSteel: s(o.steel, 2369067, 0.38, 1.9), barrel: s(o.steel, 1908516, 0.34, 1.8), bolt: s(o.steelBright, 10132898, 0.24, 1.2), plate: s(o.alu, 1776671, Tl("prg", 0.95), 2.4, Tl("pen", 0.5)), pad: s(o.rubber, 789517, 0.9, 1), spacer: s(o.poly, 14209732, 0.6, 1), riser: s(o.leather, 1184532, 0.74, 1), wood: l, chequer: c, shell: h, pores: a };
}
var IN = { W: 1024, H: 512, SW: 640, LT: 0.07, DX: 939, DR: 82, DY: [86, 256, 426], SX0: 664, SX1: 836, FOLDS: 6 };
function J00() {
  let { W: o, H: t, SW: e, LT: s, DX: n, DR: i, DY: a, SX0: r, SX1: l, FOLDS: c } = IN, h = Re(1207), f = KT(77), u = t / s, d = e / (2 * Math.PI * La.r), m = i / La.rim, p = (t0) => t - t0 * u, x = we(o, t), g = x.getContext("2d"), b = we(o, t), v = b.getContext("2d"), y = we(o, t), M = y.getContext("2d"), w = (t0, M0) => `rgb(255,${Math.round(t0 * 255)},${Math.round(M0 * 255)})`, T = (t0) => {
    let M0 = Math.round(128 + t0 * 127);
    return `rgb(${M0},${M0},${M0})`;
  }, S = (t0, M0 = 700) => `${M0} ${t0}px Bahnschrift, "Segoe UI", Arial, sans-serif`;
  v.fillStyle = T(0), v.fillRect(0, 0, o, t), M.fillStyle = w(0.9, 0), M.fillRect(0, 0, o, t), g.fillStyle = "#1a1512", g.fillRect(0, 0, o, t);
  let E = p(La.head), _ = p(0.0548);
  {
    let t0 = g.createLinearGradient(0, 0, 0, E);
    t0.addColorStop(0, "#84120e"), t0.addColorStop(0.22, "#a21811"), t0.addColorStop(0.8, "#a61912"), t0.addColorStop(1, "#8e1510"), g.fillStyle = t0, g.fillRect(0, 0, e, E);
  }
  M.fillStyle = w(0.36, 0), M.fillRect(0, 0, e, E);
  let R = 80, C = e / R;
  for (let t0 = 0; t0 < R; t0++) {
    let M0 = t0 * C;
    g.fillStyle = `rgba(40,0,0,${0.16 + 0.1 * h()})`, g.fillRect(M0, _ - 6, 1.6, E - _ + 6), g.fillStyle = "rgba(255,120,90,0.10)", g.fillRect(M0 + C * 0.5, _ - 6, 1.4, E - _ + 6), v.fillStyle = T(-0.5), v.fillRect(M0, _ - 4, 2, E - _ + 4), v.fillStyle = T(0.3), v.fillRect(M0 + C * 0.45, _ - 4, 2.4, E - _ + 4);
  }
  g.fillStyle = "rgba(30,0,0,0.35)", g.fillRect(e * 0.5 - 1, 0, 1.5, E), v.fillStyle = T(0.5), v.fillRect(e * 0.5 - 1.5, 0, 3, E);
  for (let t0 = 0; t0 < 2 * c; t0++) {
    let M0 = (t0 + 0.5) / (2 * c) * e, f0 = t0 % 2 === 0, _0 = g.createLinearGradient(0, _ + 10, 0, 0);
    _0.addColorStop(0, "rgba(40,0,0,0)"), _0.addColorStop(0.3, f0 ? "rgba(40,0,0,0.5)" : "rgba(255,150,120,0.28)"), _0.addColorStop(1, f0 ? "rgba(40,0,0,0.6)" : "rgba(255,150,120,0.34)"), g.fillStyle = _0, g.fillRect(M0 - 1.5, 0, 3, _ + 10), v.fillStyle = T(f0 ? -0.8 : 0.6), v.fillRect(M0 - 2, 0, 4, _ + 4);
  }
  {
    let t0 = g.createLinearGradient(0, 0, 0, _);
    t0.addColorStop(0, "rgba(255,190,170,0.20)"), t0.addColorStop(1, "rgba(255,190,170,0)"), g.fillStyle = t0, g.fillRect(0, 0, e, _);
  }
  let L = "#f2e2b4";
  for (let t0 of [e * 0.25, e * 0.75]) g.save(), g.translate(t0, (_ + E) / 2 + 4), g.rotate(-Math.PI / 2), g.textAlign = "center", g.textBaseline = "middle", g.fillStyle = L, g.font = S(64, 800), g.fillText("00 BUCK", 0, -46), g.font = S(33, 700), g.fillText("BREACHER  12 GA", 0, 8), g.font = S(23, 600), g.fillText("2\xBE IN \xB7 9 PELLETS \xB7 1325 FPS", 0, 46), g.fillRect(-128, 70, 256, 5), g.font = S(17, 600), g.fillText("GH-ARMS  LOT 24B-0932", 0, 92), g.restore(), M.save(), M.translate(t0, (_ + E) / 2 + 4), M.rotate(-Math.PI / 2), M.textAlign = "center", M.textBaseline = "middle", M.fillStyle = w(0.55, 0), M.font = S(64, 800), M.fillText("00 BUCK", 0, -46), M.font = S(33, 700), M.fillText("BREACHER  12 GA", 0, 8), M.restore();
  g.fillStyle = L, g.fillRect(0, _ + 12, e, 3), g.fillRect(0, _ + 19, e, 1.5), g.fillStyle = "rgba(40,0,0,0.5)", g.fillRect(0, E - 5, e, 5);
  for (let t0 = 0; t0 < 90; t0++) {
    let M0 = h() * e, f0 = _ + h() * (E - _), _0 = 6 + h() * 34, F0 = 0.6 + h() * 1.2;
    g.fillStyle = `rgba(255,205,190,${0.05 + 0.13 * h()})`, g.fillRect(M0, f0, F0, _0), M.fillStyle = w(0.6, 0), M.fillRect(M0, f0, F0, _0);
  }
  {
    let t0 = g.createLinearGradient(0, E, 0, t);
    t0.addColorStop(0, "#c7a04e"), t0.addColorStop(0.5, "#d8b662"), t0.addColorStop(0.86, "#cfa954"), t0.addColorStop(1, "#e6cb82"), g.fillStyle = t0, g.fillRect(0, E, e, t - E);
  }
  M.fillStyle = w(0.3, 1), M.fillRect(0, E, e, t - E);
  for (let t0 = Math.floor(E); t0 < t; t0++) {
    let M0 = h();
    g.fillStyle = M0 > 0.5 ? `rgba(255,240,190,${(M0 - 0.5) * 0.22})` : `rgba(70,45,10,${(0.5 - M0) * 0.26})`, g.fillRect(0, t0, e, 1), M.fillStyle = w(0.24 + 0.16 * M0, 1), M.fillRect(0, t0, e, 1);
  }
  for (let t0 = 0; t0 < 60; t0++) {
    let M0 = h() * e, f0 = E + h() * (t - E), _0 = 5 + h() * 22, F0 = g.createRadialGradient(M0, f0, 0, M0, f0, _0);
    F0.addColorStop(0, `rgba(96,62,22,${0.1 + 0.14 * h()})`), F0.addColorStop(1, "rgba(96,62,22,0)"), g.fillStyle = F0, g.fillRect(M0 - _0, f0 - _0, 2 * _0, 2 * _0);
  }
  for (let t0 of [0.0104, 0.0128]) {
    let M0 = p(t0);
    g.fillStyle = "rgba(60,36,6,0.55)", g.fillRect(0, M0 - 2, e, 4), g.fillStyle = "rgba(255,236,170,0.30)", g.fillRect(0, M0 + 2, e, 1.2), v.fillStyle = T(-0.85), v.fillRect(0, M0 - 2.5, e, 5), M.fillStyle = w(0.5, 1), M.fillRect(0, M0 - 2, e, 4), v.strokeStyle = T(-0.2), v.lineWidth = 1, v.beginPath();
    for (let f0 = -8; f0 < e + 8; f0 += 4) v.moveTo(f0, M0 + 2.5), v.lineTo(f0 + 5, M0 - 2.5);
    v.stroke();
  }
  g.fillStyle = "rgba(50,30,6,0.5)", g.fillRect(0, E, e, 2.5), g.fillStyle = "rgba(255,240,180,0.35)", g.fillRect(0, E + 2.5, e, 1.5), v.fillStyle = T(0.5), v.fillRect(0, E, e, 4);
  {
    let t0 = p(19e-4);
    g.fillStyle = "rgba(60,36,6,0.45)", g.fillRect(0, t0 - 2, e, 3), g.fillStyle = "rgba(255,244,200,0.45)", g.fillRect(0, t0 + 1, e, t - t0), M.fillStyle = w(0.2, 1), M.fillRect(0, t0 + 1, e, t - t0);
  }
  {
    let t0 = g.createLinearGradient(0, 0, 0, t);
    t0.addColorStop(0, "#5a2a1c"), t0.addColorStop(0.12, "#2b201b"), t0.addColorStop(1, "#0d0c0b"), g.fillStyle = t0, g.fillRect(r, 0, l - r, t);
  }
  for (let t0 = 0; t0 < 260; t0++) g.fillStyle = `rgba(${150 + 60 * h()},${130 + 50 * h()},${110 + 40 * h()},${0.03 + 0.07 * h()})`, g.fillRect(r + h() * (l - r), h() * t, 1 + h() * 2, 4 + h() * 40);
  M.fillStyle = w(0.92, 0), M.fillRect(r - 8, 0, l - r + 16, t);
  let A = (t0, M0) => {
    for (let f0 of [g, v, M]) f0.save(), f0.translate(n, a[t0]);
    M0();
    for (let f0 of [g, v, M]) f0.restore();
  }, O = (t0, M0, f0, _0) => {
    t0.fillStyle = _0, t0.beginPath(), t0.arc(0, 0, f0, 0, 6.2832), t0.arc(0, 0, M0, 0, 6.2832, true), t0.fill("evenodd");
  }, H = (t0, M0) => A(t0, () => {
    let f0 = i + 3, _0 = 31e-4 * m, F0 = 38e-4 * m;
    {
      let S0 = g.createRadialGradient(0, 0, F0, 0, 0, f0);
      S0.addColorStop(0, "#caa552"), S0.addColorStop(0.7, "#d6b560"), S0.addColorStop(0.93, "#cda852"), S0.addColorStop(1, "#ecd590"), O(g, 0, f0, S0);
    }
    O(M, 0, f0, w(0.3, 1));
    for (let S0 = F0; S0 < f0; S0 += 1) {
      let T0 = h();
      g.strokeStyle = T0 > 0.5 ? `rgba(255,240,190,${(T0 - 0.5) * 0.3})` : `rgba(70,45,10,${(0.5 - T0) * 0.3})`, g.lineWidth = 1, g.beginPath(), g.arc(0, 0, S0, 0, 6.2832), g.stroke(), M.strokeStyle = w(0.22 + 0.18 * T0, 1), M.lineWidth = 1, M.beginPath(), M.arc(0, 0, S0, 0, 6.2832), M.stroke();
    }
    let m0 = (S0, T0, j0) => {
      for (let [Z0, lt] of [[g, "rgba(58,36,8,0.82)"], [v, T(-0.9)], [M, w(0.55, 1)]]) Z0.save(), Z0.rotate(T0), Z0.translate(0, -71e-4 * m), Z0.font = S(j0, 800), Z0.textAlign = "center", Z0.textBaseline = "middle", Z0.fillStyle = lt, Z0.fillText(S0, 0, 0), Z0.restore();
    };
    m0("12", 0, 25), m0("12", Math.PI, 25), m0("GH", Math.PI / 2, 21), m0("GA", -Math.PI / 2, 21);
    for (let S0 of [0.25, 0.75, 1.25, 1.75]) m0("\u2605", S0 * Math.PI, 13);
    O(g, _0, F0, "#3a2610"), O(v, _0 - 1, F0 + 1, T(-0.9)), O(g, _0 - 0.5, _0 + 2.2, M0 ? "rgba(40,20,12,0.9)" : "rgba(150,26,18,0.85)"), O(M, _0, F0, w(0.7, 0.3));
    {
      let S0 = g.createRadialGradient(-_0 * 0.25, -_0 * 0.3, 0, 0, 0, _0);
      S0.addColorStop(0, "#f1eee6"), S0.addColorStop(0.7, "#c9c6bd"), S0.addColorStop(1, "#8f8c84"), O(g, 0, _0, S0);
    }
    O(M, 0, _0, w(0.22, 1));
    {
      let S0 = v.createRadialGradient(0, 0, 0, 0, 0, _0);
      S0.addColorStop(0, T(0.5)), S0.addColorStop(1, T(0.1)), O(v, 0, _0, S0);
    }
    if (M0) {
      let S0 = 4e-4 * m, T0 = -3e-4 * m, j0 = 11e-4 * m;
      for (let [Z0, lt, H0] of [[g, "rgba(30,26,22,0.95)", "rgba(30,26,22,0)"], [v, T(-1), T(0.2)]]) {
        let Y0 = Z0.createRadialGradient(S0, T0, 0, S0, T0, j0);
        Y0.addColorStop(0, lt), Y0.addColorStop(0.55, lt), Y0.addColorStop(1, H0), Z0.fillStyle = Y0, Z0.beginPath(), Z0.arc(S0, T0, j0, 0, 6.2832), Z0.fill();
      }
      {
        let Z0 = g.createRadialGradient(0, 0, F0, 0, 0, F0 * 2.3);
        Z0.addColorStop(0, "rgba(30,22,16,0.6)"), Z0.addColorStop(1, "rgba(30,22,16,0)"), O(g, F0, F0 * 2.3, Z0), O(M, F0, F0 * 1.8, w(0.7, 0.6));
      }
    }
  });
  H(0, false), H(2, true), A(1, () => {
    let t0 = i * 0.72;
    {
      let M0 = g.createRadialGradient(0, 0, 0, 0, 0, t0);
      M0.addColorStop(0, "#7c120d"), M0.addColorStop(0.5, "#a51912"), M0.addColorStop(1, "#b21c14"), O(g, 0, t0, M0);
    }
    O(M, 0, t0, w(0.42, 0));
    {
      let M0 = v.createRadialGradient(0, 0, 0, 0, 0, t0);
      M0.addColorStop(0, T(-0.5)), M0.addColorStop(1, T(0.2)), O(v, 0, t0, M0);
    }
    for (let M0 = 0; M0 < c; M0++) {
      let f0 = (M0 + 0.5) / c * 6.2832;
      for (let [F0, m0, S0] of [[g, "rgba(34,0,0,0.75)", 2.4], [v, T(-1), 4.5]]) F0.save(), F0.rotate(f0), F0.strokeStyle = m0, F0.lineWidth = S0, F0.lineCap = "round", F0.beginPath(), F0.moveTo(1.5, 0), F0.lineTo(t0 * 0.93, 0), F0.stroke(), F0.restore();
      g.save(), g.rotate(f0 + 0.5 / c * 6.2832);
      let _0 = g.createLinearGradient(0, 0, t0, 0);
      _0.addColorStop(0.2, "rgba(255,170,140,0)"), _0.addColorStop(0.75, "rgba(255,170,140,0.26)"), _0.addColorStop(1, "rgba(255,170,140,0.05)"), g.strokeStyle = _0, g.lineWidth = 7, g.beginPath(), g.moveTo(t0 * 0.2, 0), g.lineTo(t0 * 0.95, 0), g.stroke(), g.restore();
    }
    O(g, 0, 4.5, "#2a0503"), O(v, 0, 5, T(-1));
  });
  let F = v.getImageData(0, 0, o, t).data, P = we(o, t), z = P.getContext("2d"), k = z.createImageData(o, t), I = k.data, G = g.getImageData(0, 0, o, t), K = G.data, $ = (t0, M0) => F[(Math.min(t - 1, Math.max(0, M0)) * o + Math.min(o - 1, Math.max(0, t0))) * 4] / 255;
  for (let t0 = 0; t0 < t; t0++) for (let M0 = 0; M0 < o; M0++) {
    let f0 = (t0 * o + M0) * 4, _0 = M0 < e ? d / u : 1, F0 = ($(M0 + 1, t0) - $(M0 - 1, t0)) * 2.2 * _0, m0 = ($(M0, t0 + 1) - $(M0, t0 - 1)) * 2.2, S0 = 1 / Math.hypot(F0, m0, 1);
    I[f0] = (-F0 * S0 * 0.5 + 0.5) * 255, I[f0 + 1] = (m0 * S0 * 0.5 + 0.5) * 255, I[f0 + 2] = (S0 * 0.5 + 0.5) * 255, I[f0 + 3] = 255;
    let T0 = 0.94 + 0.12 * f.fbm(M0 / 40, t0 / 40, 3.3, 3);
    K[f0] *= T0, K[f0 + 1] *= T0, K[f0 + 2] *= T0;
  }
  z.putImageData(k, 0, 0), g.putImageData(G, 0, 0);
  let n0 = (t0, M0) => {
    let f0 = makeCanvasTexture(t0);
    return M0 && (f0.colorSpace = THREE.SRGBColorSpace), f0.anisotropy = 8, f0;
  }, e0 = n0(y, false), p0 = new THREE.MeshStandardMaterial({ map: n0(x, true), normalMap: n0(P, false), normalScale: new THREE.Vector2(0.9, 0.9), roughnessMap: e0, metalnessMap: e0, roughness: 1, metalness: 1 });
  return p0.name = "shell", p0.userData = { base: new THREE.Color(9050644), wear: 1 }, p0;
}
var Fk = {};
function AN(o = false) {
  let t = o ? "fired" : "live";
  if (Fk[t]) return Fk[t];
  let { W: e, H: s, SW: n, LT: i, DX: a, DR: r, DY: l, SX0: c, SX1: h, FOLDS: f } = IN, u = 6 * f, d = La.len, m = La.r, p = La.rim, x = m + 3e-4, g = Math.PI * 2, b = [], v = [], y = [], M = (P) => 0.5 + 0.5 * Math.cos((P / u * f - 0.5) * g), w = (P, z, k = 0) => {
    let I = b.length / 3;
    for (let G = 0; G <= u; G++) {
      let K = G / u * g, $ = z + k * (0.35 - M(G));
      b.push(Math.cos(K) * $, Math.sin(K) * $, d / 2 - P), v.push((1 - G / u) * n / e, P / i);
    }
    return I;
  }, T = (P, z, k, I = 0, G = k) => {
    let K = b.length / 3;
    for (let $ = 0; $ <= u; $++) {
      let n0 = $ / u * g, e0 = Math.cos(n0), p0 = Math.sin(n0);
      b.push(e0 * k, p0 * k, d / 2 - z + I * M($)), v.push((a + e0 * G / p * r) / e, 1 - (l[P] - p0 * G / p * r) / s);
    }
    return K;
  }, S = (P, z, k = 0) => {
    let I = b.length / 3;
    for (let G = 0; G <= u; G++) {
      let K = G / u * g, $ = z + k * (0.35 - M(G));
      b.push(Math.cos(K) * $, Math.sin(K) * $, d / 2 - P), v.push((c + (h - c) * G / u) / e, 1 - (0.07 - P) / 0.045);
    }
    return I;
  }, E = (P, z) => {
    for (let k = 0; k < u; k++) y.push(P + k, P + k + 1, z + k, P + k + 1, z + k + 1, z + k);
  }, _ = (P, z, k, I, G = false) => {
    let K = b.length / 3;
    b.push(0, 0, d / 2 - z), v.push(k, I);
    for (let $ = 0; $ < u; $++) G ? y.push(K, P + $ + 1, P + $) : y.push(K, P + $, P + $ + 1);
  }, R = (P) => {
    for (let z = 0; z < P.length - 1; z++) E(P[z], P[z + 1]);
  }, C = o ? 2 : 0, L = a / e, A = (P) => 1 - l[P] / s;
  {
    let P = [];
    o && P.push(T(C, 75e-5, 7e-4)), P.push(T(C, o ? 12e-5 : -4e-5, 16e-4), T(C, 8e-5, 3e-3), T(C, 4e-4, 325e-5), T(C, 4e-4, 37e-4), T(C, 0, 4e-3), T(C, 0, p - 5e-4), T(C, 45e-5, p)), _(P[0], o ? 95e-5 : -8e-5, L, A(C), true), R(P);
  }
  let O = [w(45e-5, p), w(145e-5, p), w(185e-5, x + 12e-5), w(22e-4, x), w(0.01, x), w(0.0104, x - 16e-5), w(0.0108, x), w(0.0124, x), w(0.0128, x - 16e-5), w(0.0132, x), w(La.head - 3e-4, x), w(La.head, x - 12e-5), w(La.head + 1e-4, m), w(0.035, m), w(0.0548, m)];
  if (o) {
    O.push(w(0.06, m, 12e-5), w(0.065, m + 1e-4, 42e-5), w(0.0688, m + 3e-4, 62e-5), w(0.07, m + 1e-4, 66e-5)), R(O);
    let P = [S(0.07, m - 5e-4, 6e-4), S(0.065, m - 7e-4, 3e-4), S(0.05, m - 8e-4), S(0.03, m - 8e-4), S(0.0292, m - 3e-3)];
    E(O[O.length - 1], P[0]), R(P), _(P[P.length - 1], 0.0286, (c + h) / 2 / e, 0.02);
  } else {
    O.push(w(0.057, m - 5e-4), w(0.0586, m - 16e-4), w(0.05955, m - 3e-3, 2e-4)), R(O);
    let P = [T(1, 0.05955, m - 3e-3, 0, 8e-3), T(1, 0.0596, 54e-4, 5e-4, 6e-3), T(1, 0.0593, 36e-4, 85e-5, 4e-3), T(1, 0.0588, 18e-4, 7e-4, 2e-3), T(1, 0.0582, 6e-4, 0, 7e-4)];
    {
      let z = O[O.length - 1] * 3, k = P[0] * 3;
      for (let I = 0; I < (u + 1) * 3; I++) b[k + I] = b[z + I];
    }
    R(P), _(P[P.length - 1], 0.0576, L, A(1));
  }
  let H = 0;
  for (let P = 0; P < y.length; P += 3) {
    let z = y[P] * 3, k = y[P + 1] * 3, I = y[P + 2] * 3;
    H += b[z] * (b[k + 1] * b[I + 2] - b[k + 2] * b[I + 1]) - b[z + 1] * (b[k] * b[I + 2] - b[k + 2] * b[I]) + b[z + 2] * (b[k] * b[I + 1] - b[k + 1] * b[I]);
  }
  if (H < 0) for (let P = 0; P < y.length; P += 3) {
    let z = y[P + 1];
    y[P + 1] = y[P + 2], y[P + 2] = z;
  }
  let F = new THREE.BufferGeometry();
  return F.setAttribute("position", new THREE.Float32BufferAttribute(b, 3)), F.setAttribute("uv", new THREE.Float32BufferAttribute(v, 2)), F.setIndex(y), F = th(F, 0.8), Fk[t] = F;
}
function HN(o, t) {
  let n = Math.min(0.0125, (o - Li) * 0.45), i = o - n, a = t > 2 ? 2 : 1, r = 7e-4, l = [[-po, Li + 22e-4 + r]], c = [[po - 22e-4 - r, Li]], h = [[po, i - r]], f = [[-75e-4 + r, o]];
  for (let u = 0; u <= a; u++) {
    let d = Math.PI * (1 + 0.5 * u / a);
    l.push([-po + 22e-4 + 22e-4 * Math.cos(d), Li + 22e-4 + 22e-4 * Math.sin(d)]);
  }
  for (let u = 0; u <= a; u++) {
    let d = Math.PI * (1.5 + 0.5 * u / a);
    c.push([po - 22e-4 + 22e-4 * Math.cos(d), Li + 22e-4 + 22e-4 * Math.sin(d)]);
  }
  for (let u = 0; u <= t; u++) {
    let d = Math.PI / 2 * u / t;
    h.push([75e-4 + (po - 75e-4) * Math.cos(d), i + n * Math.sin(d)]);
  }
  for (let u = 0; u <= t; u++) {
    let d = Math.PI / 2 * (1 + u / t);
    f.push([-75e-4 + (po - 75e-4) * Math.cos(d), i + n * Math.sin(d)]);
  }
  return l.push([-po + 22e-4 + r, Li]), c.push([po, Li + 22e-4 + r]), h.push([75e-4 - r, o]), f.push([-po, i - r]), { BL: l, BR: c, SR: h, SL: f, ys: i, sh: n, xf: 75e-4 };
}
var kN = (o, t) => {
  let e = HN(o, t);
  return [...e.BL, ...e.BR, ...e.SR, ...e.SL];
}, tt0 = (o) => o >= 0.066 ? c1 : c1 - (c1 - 0.0343) * Math.pow((0.066 - o) / 0.044, 2.2), CN = /* @__PURE__ */ new Map(), et0 = true, st0 = { camo: "factory", optic: "irons", muzzle: "none", underbarrel: "none", magazine: "std", stock: "std" };
function Ok(o = {}) {
  let t = { ...st0, ...(o.build || {}) };
  let z = FN(t, true);
  z.build = t;
  z.dims = z.dim;
  z.attachments = {};
  if (z.optic) z.attachments.optic = z.optic;
  for (let att of z.fitted || []) {
    if (att === z.optic) continue;
    if (att.caliber) z.attachments.muzzle = att;
    else z.attachments.underbarrel = att;
  }
  z.tris = WJ(z.root);
  return z;
}
function FN(o, t) {
  let e = ao(), s = Q00(), n = new THREE.Group(), i = {};
  n.name = "gun_shotgun";
  let a = g4(), r = g4(), l = (k) => t ? k : { ...k, b: 0, soft: false, cs: 1, bs: 1 }, c = (k, I, G = {}) => us(k, I, l(G)), h = (k, I, G = {}) => si(k, I, l(G)), f = (k, I, G = {}) => jc(k, I, l(G)), u = (k) => t ? k : Math.max(8, Math.round(k * 0.6)), d = o.camo && o.camo !== "factory" ? o.camo : null, m = [], p = (k, I, G, K = false) => {
    let $ = Du(n, i, k, I);
    K && ($.userData.hidden = true, $.visible = false);
    let n0 = g4(), e0 = G(n0, $) || [];
    n0.build($, I);
    for (let p0 of e0) p0.position.sub(I), $.add(p0);
    return $;
  }, x = t ? 6 : 3;
  {
    let k = HN(c1, x), I = hn.hw, G = hn.top, K = [...k.BL, ...k.BR, ...k.SR, ...k.SL], $ = { b: 0, soft: true }, n0 = (p0) => r.add(s.blued, Rc(p0)), e0 = t ? Array.from({ length: 23 }, (p0, t0) => 0.022 + 0.044 * t0 / 22) : [0.022, 0.03, 0.042, 0.054, 0.066];
    if (n0(Qe(U5(e0, (p0) => kN(tt0(p0), x), { metric: true, capA: true, crease: 0.9 }).geo)), n0(h(K, hn.u0 - 0.066, { ...$, u: 0.066 })), t) {
      n0(h([[-I, Li], ...k.BL.slice().reverse(), ...k.SL.slice().reverse(), ...k.SR.slice().reverse(), ...k.BR.slice().reverse(), [I, Li], [I, G], [-I, G]], Ro.u0 - hn.u0, { ...$, u: hn.u0 }));
      let p0 = Math.asin((Ro.y1 - k.ys) / k.sh), t0 = [k.xf + (po - k.xf) * Math.cos(p0), Ro.y1], M0 = k.SR.filter((f0) => f0[1] > Ro.y1 + 1e-5);
      n0(h([[-I, Li], ...k.BL.slice().reverse(), ...k.SL.slice().reverse(), ...M0.reverse(), t0, [I, Ro.y1], [I, G], [-I, G]], Ro.u1 - Ro.u0, { ...$, u: Ro.u0 })), n0(h([[I, Li], ...k.BR, [po, Ro.y0], [I, Ro.y0]], Ro.u1 - Ro.u0, { ...$, u: Ro.u0 })), r.add(s.blued, c(Sc([[Ro.u0 - 12e-4, Ro.y0 - 12e-4], [Ro.u1 + 12e-4, Ro.y0 - 12e-4]], 12e-4), 14e-4, { x: po - 4e-4, b: 6e-4 })), r.add(s.blued, c(se(Ro.u0 - 18e-4, Ro.y0 - 16e-4, Ro.u0, Ro.y1 - 1e-3, 6e-4), 14e-4, { x: po - 4e-4, b: 6e-4 }), c(se(Ro.u1, Ro.y0 - 16e-4, Ro.u1 + 18e-4, Ro.y1 - 1e-3, 6e-4), 14e-4, { x: po - 4e-4, b: 6e-4 })), a.add(e.black, c(se(hn.u0, Li + 4e-4, hn.u1, G), 3e-4, { x: -I + 3e-4, b: 0 }), c(se(hn.u0, Li + 4e-4, Ro.u0, G), 3e-4, { x: I - 3e-4, b: 0 }), c(se(Ro.u0, Li + 4e-4, Ro.u1, Ro.y0), 3e-4, { x: I - 3e-4, b: 0 })), a.add(e.black, c(se(hn.u0, G - 6e-4, hn.u1, G - 3e-4), 2 * I, { b: 0 }), h(se(-I, Li, I, G), 3e-4, { u: hn.u0 + 2e-4, b: 0 }), h(se(-I, Li, I, G), 3e-4, { u: hn.u1 - 6e-4, b: 0 })), a.add(s.bolt, ni([[hn.u1 - 8e-4, 0.0103], [hn.u1 - 3e-3, 0.0112], [hn.u1 - 3e-3, 0.0138]], { y: Ws, seg: 16 })), a.add(e.steel, ni([[hn.u1 - 8e-4, 0.0105], [hn.u1 - 22e-4, 0.0112], [hn.u1 - 22e-4, 0.0128]], { y: Ts, seg: 16 }));
      for (let f0 of [-1, 1]) a.add(s.bolt, c(se(hn.u1 - 0.016, Ts - 3e-3, hn.u1 - 1e-3, Ts + 3e-3, 1e-3), 12e-4, { x: f0 * (I - 12e-4), b: 4e-4 }));
    } else n0(h(K, hn.u1 - hn.u0, { ...$, u: hn.u0 }));
    if (n0(h(K, qT - hn.u1, { ...$, u: hn.u1 })), t) {
      for (let [p0, t0, M0, f0] of [[-0.0173, hn.u0, -I - 1e-4, hn.u1], [I + 1e-4, hn.u0, 0.0173, hn.u1], [-0.0173, hn.u1, 0.0173, qT - 4e-4]]) r.add(s.bluedMatte, Rc(f(se(p0, t0, M0, f0), 25e-5, { y: Li - 25e-5, b: 0 })));
      r.add(s.blued, h(kN(c1 - 12e-4, x).map((p0) => [p0[0] * 0.95, Li + 1e-3 + (p0[1] - Li) * 0.965]), 22e-4, { u: qT - 2e-4, b: 8e-4 }));
      for (let [p0, t0] of [[0.058, 0.0165], [0.118, 0.02]]) a.add(e.steel, Wn(26e-4, 2 * po + 6e-4, { y: t0, u: p0, seg: 10 }));
      for (let p0 of [-1, 1]) a.add(e.black, Wn(11e-4, 2e-4, { x: p0 * (po + 35e-5), y: 0.0165, u: 0.058, seg: 6 }), Wn(11e-4, 2e-4, { x: p0 * (po + 35e-5), y: 0.02, u: 0.118, seg: 6 }));
      a.add(e.mark, x4("sg", 0.07, 0.02, -(po + 25e-5), 0.033, 0.156, -1)), a.add(s.mark, s.sgDecal("gauge", 0.062, po + 25e-5, 0.0185, 0.08, 1), s.sgDecal("proof", 0.012, po + 25e-5, 0.04, 0.214, 1), s.sgDecal("proof", 0.011, -(po + 25e-5), 0.013, 0.212, -1));
      {
        let p0 = s.sgDecal("maker", 0.098, 0, 0, 0, -1);
        p0.translate(0, 0, 0), p0.rotateZ(Ze(-38)), p0.translate(-0.0124 * Math.cos(Ze(38)) - 1e-4, Ws + 0.0124 * Math.sin(Ze(38)) + 1e-4, -0.33), a.add(s.mark, p0);
      }
      for (let p0 = 0; p0 < 12; p0++) a.add(e.black, f(se(-68e-4, V5 + 65e-4 + p0 * 38e-4, 68e-4, V5 + 78e-4 + p0 * 38e-4), 2e-4, { y: c1 - 5e-5, b: 0 }));
    }
    if (r.add(s.blued, c(se(Xu - 3e-3, c1 - 4e-3, V5 + 3e-3, Np + 2e-4, 1e-3), 0.0176, { b: 8e-4 })), r.add(s.blued, t ? xy(Xu, V5, Np) : c(se(Xu, Np, V5, Ch), 0.0206)), t) for (let p0 of [Xu + 0.02, V5 - 0.02]) a.add(e.steel, T5(24e-4, 6e-4, { y: Np + 42e-4, u: p0 + 74e-4, seg: 6 }));
  }
  p("bolt", Gt(0, Ws, 0.16), (k) => {
    t && (k.add(s.bolt, ni([[0.128, 0.01], [0.13, 0.0115], [0.201, 0.0115], [0.2032, 0.0106], [0.2032, 1e-4]], { y: Ws, seg: 16 })), k.add(e.steel, c(se(0.176, Ws - 32e-4, 0.2032, Ws + 32e-4, 8e-4), 16e-4, { x: 0.0112, b: 5e-4 })), k.add(e.black, c(se(0.176, Ws - 4e-3, 0.1765, Ws + 4e-3), 4e-4, { x: 0.01165, b: 0 }), c(se(0.13, Ws + 12e-4, 0.168, Ws + 2e-3), 4e-4, { x: 0.01158, b: 0 }), c(se(0.13, Ws - 6e-3, 0.16, Ws - 52e-4), 4e-4, { x: 0.01012, b: 0 })), k.add(e.steel, c(se(0.138, Ws + 6e-3, 0.172, Ws + 0.0104, 1e-3), 9e-3, { b: 6e-4 })), k.add(e.steel, c([[0.112, Ws - 0.0165], [0.196, Ws - 0.0165], [0.2, Ws - 0.0105], [0.112, Ws - 0.0105]], 0.02, { b: 8e-4 })), k.add(e.black, fa(52e-4, 4e-4, { y: Ws, u: 0.2031, seg: 10 })));
  }), p("lifter", Gt(...l1.LIFT_PIVOT), (k) => {
    if (!t) return;
    let I = 5e-3, G = 68e-4;
    k.add(s.carrier, f([[-0.0114, 0.108, 1e-3], [0.0114, 0.108, 1e-3], [0.0114, 0.196, 3e-3], [4e-3, 0.2015, 2e-3], [4e-3, 0.16, 2e-3], [-4e-3, 0.16, 2e-3], [-4e-3, 0.2015, 2e-3], [-0.0114, 0.196, 3e-3]], G - I, { y: I, b: 4e-4 })), k.add(e.black, f(se(-4e-3, 0.16, 4e-3, 0.2015), 2e-4, { y: G - 1e-4, b: 0 })), k.add(e.steel, Wn(19e-4, 2 * hn.hw, { y: 6e-3, u: 0.1085, seg: 8 }));
    for (let K = 0; K < 3; K++) k.add(e.black, f(se(-85e-4, 0.118 + K * 6e-3, 85e-4, 0.1192 + K * 6e-3), 2e-4, { y: I - 2e-4, b: 0 }));
  });
  let g = t ? 17 : 9, b = Sc(Array.from({ length: g }, (k, I) => {
    let G = Math.PI * (1 + I / (g - 1)), K = Math.cos(G), $ = Math.abs(Math.sin(G));
    return [0.0618 + 0.0318 * Math.sign(K) * Math.pow(Math.abs(K), 2 / 2.7), 22e-4 - 0.0342 * Math.pow($, 2 / 2.7)];
  }), 36e-4), v = Sc([[0.0668, 16e-4], [0.0646, -5e-3], [0.0632, -0.012], [0.0634, -0.0182], [0.0656, -0.0238]], 44e-4);
  r.add(s.plate, c([[0.0245, 2e-4, 1e-3], [0.1035, 2e-4, 1e-3], [0.1035, 48e-4], [0.0245, 48e-4]], 0.03, { b: 1e-3 })), r.add(s.plate, c(b, 0.0158, { b: 11e-4, bs: 2 })), p("trigger", Gt(0, 12e-4, 0.0668), (k) => {
    k.add(e.steel, c(v, 64e-4, { b: 13e-4, bs: 2, soft: true }));
  }), p("safety", Gt(0, -3e-3, 0.0385), (k) => {
    t && (k.add(e.steel, Wn(36e-4, 0.033, { x: -12e-4, y: -3e-3, u: 0.0385, seg: 12 })), k.add(e.red, Wn(365e-5, 16e-4, { x: -0.0148, y: -3e-3, u: 0.0385, seg: 12 })));
  }), t && a.add(s.plate, Wn(5e-3, 0.0318, { y: -3e-3, u: 0.0385, seg: 12 })), p("actionRelease", Gt(-75e-4, 5e-4, 0.0985), (k) => {
    if (t) {
      k.add(e.steel, c([[0.095, 12e-4], [0.101, 12e-4], [0.1016, -48e-4, 12e-4], [0.0962, -6e-3, 12e-4]], 74e-4, { x: -72e-4, b: 8e-4 }));
      for (let I = 0; I < 3; I++) k.add(e.black, c(se(0.0966 + I * 15e-4, -61e-4, 0.0972 + I * 15e-4, -57e-4), 66e-4, { x: -72e-4, b: 0 }));
    }
  }), a.add(s.barrel, ni([[0.2262, 0.0138], [0.25, 0.0138], [0.262, 0.0124], [0.6, 0.0116], [xa - 16e-4, 0.0114], [xa, 0.0106], [xa, 94e-4]], { y: Ws, seg: u(20) })), a.add(e.black, ni([[xa, 94e-4], [xa - 15e-4, 92e-4], [xa - 0.045, 92e-4], [xa - 0.045, 1e-4]], { y: Ws, seg: u(16) })), t && a.add(s.barrel, ni([[0.25, 0.0138], [0.25, 0.0146], [0.256, 0.0146], [0.2575, 0.0138]], { y: Ws, seg: 20 }));
  {
    let k = Ef + 16e-4, I = Ws + 0.0113;
    if (a.add(e.steel, ni([[0.604, 0.0116], [0.605, 0.0136], [0.631, 0.0136], [0.632, 0.0116]], { y: Ws, seg: u(18) })), a.add(e.steel, c([[0.6045, I], [0.6315, I], [0.63, k - 5e-3], [0.6235, k, 1e-3], [0.617, k, 1e-3], [0.606, I + 6e-3]], 4e-3, { b: 7e-4 })), t) {
      for (let G of [-1, 1]) a.add(e.steel, c([[0.605, I - 1e-3], [0.631, I - 1e-3], [0.63, k - 1e-3, 2e-3], [0.623, k + 32e-4, 3e-3], [0.613, k + 1e-3, 3e-3], [0.6055, I + 5e-3]], 22e-4, { x: G * 86e-4, b: 8e-4 }));
      a.add(e.steel, c(se(0.605, I - 1e-3, 0.631, I + 34e-4, 1e-3), 0.0194, { b: 8e-4 })), a.add(e.fiber, fa(16e-4, 0.01, { y: Ef - 2e-4, u: 0.6162, seg: 10 }));
    }
  }
  let y = o.magazine === "ext", M = y ? l1.TUBE_EXT : l1.TUBE_STD;
  r.add(s.tubeSteel, fa(0.0125, l1.TUBE_STD - 0.2275, { y: Ts, u: 0.2275, seg: u(18) }));
  let w = (k, I) => {
    let K = Ws - Ts, $ = Math.acos(K / 2 / 0.0156), n0 = [], e0 = t ? 10 : 5;
    for (let p0 = 0; p0 <= e0; p0++) {
      let t0 = -Math.PI / 2 + $ + (2 * Math.PI - 2 * $) * p0 / e0;
      n0.push([0.0156 * Math.cos(t0), Ws + 0.0156 * Math.sin(t0)]);
    }
    for (let p0 = 1; p0 < e0; p0++) {
      let t0 = Math.PI / 2 + $ + (2 * Math.PI - 2 * $) * p0 / e0;
      n0.push([0.0156 * Math.cos(t0), Ts + 0.0156 * Math.sin(t0)]);
    }
    return h(n0, I, { u: k, b: 9e-4, holes: t ? [Kr(0, Ws, 0.0117, 14), Kr(0, Ts, 0.0124, 14)] : null });
  };
  a.add(e.steel, w(0.529, 0.011)), t && a.add(e.steel, Wn(26e-4, 0.035, { y: (Ws + Ts) / 2, u: 0.5345, seg: 6 }), Wn(42e-4, 2e-3, { x: 0.0172, y: (Ws + Ts) / 2, u: 0.5345, seg: 6 }), Wn(42e-4, 2e-3, { x: -0.0172, y: (Ws + Ts) / 2, u: 0.5345, seg: 6 }));
  let T = (k, I, G) => {
    if (k.add(I, ni([[G, 0.0125], [G, 0.0142], [G + 14e-4, 0.0147], [G + 0.013, 0.0147], [G + 0.0152, 0.0138], [G + 0.017, 0.0118], [G + 0.017, 1e-4]], { y: Ts, seg: u(18) })), !!t) {
      for (let K = 0; K < 18; K++) a.add(e.black, xh(bh(c(se(G + 22e-4, 0.01472, G + 0.0122, 0.0149), 11e-4, { b: 0 }), 0, Ts, 0), K * 20, Ts));
      a.add(e.steel, T5(26e-4, 6e-3, { y: Ts - 0.0205, u: G + 8e-3, seg: 8 }), Wn(4e-3, 3e-3, { y: Ts - 0.0222, u: G + 8e-3, seg: 10 })), p("swivelF", Gt(0, Ts - 0.0222, G + 8e-3), (K) => {
        let $ = new THREE.TorusGeometry(72e-4, 11e-4, 6, 16);
        $.rotateY(Math.PI / 2), $.translate(0, Ts - 0.0222 - 66e-4, -(G + 8e-3)), K.add(e.steel, Qe($));
      });
    }
  };
  if (!y) T(r, s.tubeSteel, l1.TUBE_STD);
  else {
    let k = l1.TUBE_STD;
    if (r.add(s.tubeSteel, ni([[k - 1e-3, 0.0125], [k, 0.015], [k + 0.0125, 0.015], [k + 0.014, 0.0131], [M, 0.0131]], { y: Ts, seg: u(18) })), t) for (let I = 0; I < 6; I++) a.add(e.black, xh(bh(c(se(k + 2e-3, 0.01502, k + 0.0105, 0.0152), 42e-4, { b: 0 }), 0, Ts, 0), I * 60, Ts));
    a.add(e.steel, w(0.588, 0.01)), t && a.add(e.steel, Wn(26e-4, 0.035, { y: (Ws + Ts) / 2, u: 0.593, seg: 6 }), Wn(42e-4, 2e-3, { x: 0.0172, y: (Ws + Ts) / 2, u: 0.593, seg: 6 }), Wn(42e-4, 2e-3, { x: -0.0172, y: (Ws + Ts) / 2, u: 0.593, seg: 6 })), T(r, s.tubeSteel, M);
  }
  let S = null;
  p("pump", Gt(0, Ts, (ir + Zr) / 2), (k) => {
    let I = j00(t), G = [], K = [ir, ir + 12e-4, ir + 28e-4, ir + 46e-4];
    for (let n0 = 0; n0 < zN; n0++) {
      let e0 = DN + n0 * LN;
      t ? K.push(e0 - 24e-4, e0 - 6e-4, e0 + 6e-4, e0 + 24e-4) : K.push(e0 - 24e-4, e0, e0 + 24e-4);
    }
    K.push(Zr - 46e-4, Zr - 28e-4, Zr - 12e-4, Zr), G.push(ir, ...K, Zr);
    let $ = 0.0139;
    if (S = U5(G, (n0, e0) => Y00(e0 === 0 || e0 === G.length - 1 ? $ : X00(n0), I), { crease: 0.62 }), k.add(e.steel, fa(0.0137, Zr - ir + 4e-3, { y: Ts, u: ir - 2e-3, seg: u(16), open: true })), k.add(e.steel, ni([[Zr - 5e-4, 0.0137], [Zr - 5e-4, 0.0166], [Zr + 42e-4, 0.0166], [Zr + 55e-4, 0.015], [Zr + 55e-4, 0.0128]], { y: Ts, seg: u(16) })), k.add(e.steel, ni([[ir - 0.01, 0.0128], [ir - 0.01, 0.0152], [ir - 85e-4, 0.016], [ir + 5e-4, 0.016], [ir + 5e-4, 0.0137]], { y: Ts, seg: u(16) })), t) for (let n0 = 0; n0 < 4; n0++) k.add(e.black, xh(bh(c(se(Zr + 8e-4, 0.01662, Zr + 36e-4, 0.0168), 46e-4, { b: 0 }), 0, Ts, 0), n0 * 90 + 45, Ts));
    for (let n0 of [-1, 1]) k.add(e.steel, c([[0.199, Ts + 15e-4, 1e-3], [ir - 4e-3, Ts + 15e-4], [ir - 4e-3, Ts + 0.0105], [0.26, Ts + 0.0105, 4e-3], [0.252, Ts + 9e-3, 3e-3], [0.199, Ts + 9e-3, 1e-3]], 21e-4, { x: n0 * 0.01415, b: 6e-4 }));
  });
  {
    let k = i.pump.userData.rest, I = S.geo;
    I.translate(-k.x, -k.y, -k.z);
    let G = new THREE.Mesh(I, t && !d ? s.wood("forend", () => RN(128, 64, S.at, 23, { off: 1.25, skew: -0.7, curl: 0.6 }), 22, 9) : null);
    G.name = "forend", G.userData.base = 4860437, i.pump.add(G), m.push([G, "furniture", k]);
  }
  let E = o.stock === "heavy", _ = E ? -0.327 : -0.311;
  {
    let k = t ? 12 : 6, G = U5(t ? K00 : [-0.295, -0.24, -0.19, -0.15, -0.124, -0.102, -0.085, -0.069, -0.053, -0.037, -0.021, -6e-3, 7e-3, 0.022], (M0) => Ik(G4(M0), k), { crease: 0.9 }), K = new THREE.Mesh(G.geo, t && !d ? s.wood("stock", () => RN(256, 256, G.at, 11, { off: 1, skew: 1, curl: 1 }), 46, 18) : null);
    K.name = "stock", K.userData.base = 4860437, n.add(K), m.push([K, "furniture", null]);
    let $ = G4(-0.295), n0 = ($[0] + $[1]) / 2, e0 = (M0) => Ik($, k).map((f0) => [f0[0] * M0, n0 + (f0[1] - n0) * (1 - (1 - M0) * 0.4)]);
    a.add(s.spacer, Qe(U5([-0.295, -0.2972], () => e0(1.004), { metric: true, crease: 0.9 }).geo));
    let p0 = E ? [-0.2972, -0.319, -0.324, -0.3262, _] : [-0.2972, -0.305, -0.3086, -0.3104, _], t0 = [1, 0.992, 0.972, 0.93, 0.8];
    if (a.add(s.pad, Qe(U5(p0, (M0, f0) => e0(t0[f0]), { metric: true, capB: true, crease: 0.9 }).geo)), t) {
      for (let M0 = 0; M0 < 7; M0++) a.add(s.pad, c(se(_ - 1e-3, $[1] + 0.012 + M0 * 0.0145, _ + 8e-4, $[1] + 0.019 + M0 * 0.0145, 6e-4), 0.03, { b: 5e-4 }));
      if (E) for (let M0 of [-1, 1]) for (let f0 = 0; f0 < 3; f0++) a.add(e.black, c(se(-0.3165, $[1] + 0.024 + f0 * 0.03, -0.303, $[1] + 0.04 + f0 * 0.03, 3e-3), 3e-4, { x: M0 * ($[2] * 0.994 + 1e-4), b: 0 }));
      if (a.add(e.steel, T5(26e-4, 0.0165, { y: -0.102, u: -0.236, seg: 8 }), T5(48e-4, 16e-4, { y: -0.0885, u: -0.236, seg: 12 }), Wn(4e-3, 3e-3, { y: -0.101, u: -0.236, seg: 10 })), p("swivelR", Gt(0, -0.101, -0.236), (M0) => {
        let f0 = new THREE.TorusGeometry(85e-4, 11e-4, 6, 16);
        f0.rotateY(Math.PI / 2), f0.translate(0, -0.101 - 78e-4, 0.236), M0.add(e.steel, Qe(f0));
      }), !d) for (let M0 of [-1, 1]) {
        let f0 = [-4e-3, -5e-3], _0 = [-0.05, -0.0625], F0 = [-0.076, -0.052], m0 = [-0.036, 0], S0 = 18, T0 = 8, j0 = [], Z0 = [], lt = [], H0 = new Array(7), Y0 = [_0[0] - f0[0], _0[1] - f0[1]], et = Math.hypot(Y0[0], Y0[1]);
        Y0[0] /= et, Y0[1] /= et;
        let ct = Ze(17), D0 = [Y0[0] * Math.sin(ct) + Y0[1] * Math.cos(ct), Y0[1] * Math.sin(ct) - Y0[0] * Math.cos(ct)], u0 = [Y0[0] * Math.sin(ct) - Y0[1] * Math.cos(ct), Y0[1] * Math.sin(ct) + Y0[0] * Math.cos(ct)], w0 = 135e-5;
        for (let J0 = 0; J0 <= T0; J0++) for (let q0 = 0; q0 <= S0; q0++) {
          let v0 = q0 / S0, x0 = J0 / T0, C0 = 4e-3 * Math.sin(Math.PI * v0), k0 = (f0[0] + (_0[0] - f0[0]) * v0) * (1 - x0) + (m0[0] + (F0[0] - m0[0]) * v0) * x0 + C0 * (x0 - 0.5) * 0.6, O0 = (f0[1] + (_0[1] - f0[1]) * v0) * (1 - x0) + (m0[1] + (F0[1] - m0[1]) * v0) * x0, B0 = G00(G4(k0, H0), O0) + 16e-5;
          j0.push(M0 * B0, O0, -k0), Z0.push(v0, x0);
        }
        for (let J0 = 0; J0 < T0; J0++) for (let q0 = 0; q0 < S0; q0++) {
          let v0 = J0 * (S0 + 1) + q0, x0 = v0 + 1, C0 = v0 + S0 + 1, k0 = C0 + 1;
          M0 > 0 ? lt.push(v0, x0, C0, x0, k0, C0) : lt.push(v0, C0, x0, x0, C0, k0);
        }
        let P0 = new THREE.BufferGeometry();
        if (P0.setAttribute("position", new THREE.Float32BufferAttribute(j0, 3)), P0.setAttribute("uv", new THREE.Float32BufferAttribute(Z0, 2)), P0.setIndex(lt), P0.computeVertexNormals(), P0.attributes.normal.getX(0) * M0 < 0) {
          for (let J0 = 0; J0 < lt.length; J0 += 3) {
            let q0 = lt[J0 + 1];
            lt[J0 + 1] = lt[J0 + 2], lt[J0 + 2] = q0;
          }
          P0.setIndex(lt), P0.computeVertexNormals();
        }
        let st = new THREE.Mesh(P0, s.chequer);
        st.name = "chequer", n.add(st);
      }
    }
    if (E) {
      let _0 = t ? [-0.262, -0.258, -0.25, -0.22, -0.18, -0.145, -0.13, -0.122, -0.118] : [-0.262, -0.25, -0.19, -0.13, -0.118], F0 = new Array(7), m0 = (S0) => {
        let T0 = G4(S0, F0), j0 = Tf(0, 0.014, Math.min(S0 - -0.262, -0.118 - S0)), Z0 = T0[0] - 0.036, lt = T0[2] + 16e-4 + 3e-3 * j0, H0 = T0[0] + 2e-3 + 0.0105 * j0, Y0 = 0.0125, et = t ? 10 : 4, ct = [[lt, Z0]];
        for (let D0 = 0; D0 <= et; D0++) {
          let u0 = Math.PI * D0 / et, w0 = Math.cos(u0);
          ct.push([lt * Math.sign(w0) * Math.pow(Math.abs(w0), 2 / 2.7), H0 - Y0 + Y0 * Math.pow(Math.sin(u0), 2 / 2.7)]);
        }
        return ct.push([-lt, Z0], [-T0[2] * 0.9, Z0], [T0[2] * 0.9, Z0]), ct;
      };
      if (a.add(s.riser, Qe(U5(_0, m0, { metric: true, capA: true, capB: true, crease: 1 }).geo)), t) for (let S0 of [-0.238, -0.142]) {
        let T0 = G4(S0, F0);
        a.add(e.strap, Qe(U5([S0 - 0.011, S0 + 0.011], (j0) => Ik([T0[0] + 0.015, T0[1] - 12e-4, T0[2] + 62e-4, T0[3] + 4e-3, T0[4], 2.4, T0[6]], 8), { metric: true, crease: 0.9 }).geo));
      }
    }
  }
  let R = 0.5225, C = Ts - 0.0125 - 8e-3, L = { optic: new THREE.Object3D(), muzzle: new THREE.Object3D(), underbarrel: new THREE.Object3D() };
  L.optic.position.copy(Gt(0, Ch, Xu + 0.06)), L.muzzle.position.copy(Gt(0, Ws, xa)), L.underbarrel.position.copy(Gt(0, C, R));
  for (let k in L) L[k].name = "mount_" + k, n.add(L[k]);
  let A = { muzzle: Gt(0, Ws, xa), eject: Gt(po + 3e-3, Ws, 0.17), ejectDir: Bt(0.86, 0.36, 0.36).normalize(), sight: Gt(0, Ef, Xu + 0.012), gripR: new THREE.Object3D(), gripL: new THREE.Object3D() };
  A.gripR.name = "gripR", A.gripL.name = "gripL", n.add(A.gripR, A.gripL);
  let O = 0.13, H = null, F = [];
  if (o.optic === "reflex") O = 0.1, H = Mp("reflex"), L.optic.add(H.group), F.push(H), A.sight = L.optic.position.clone().add(H.eye), A.sight.z -= O;
  else {
    let k = Xu + 2e-3, I = 0.0105;
    if (a.add(e.steel, c([[k - 4e-3, Np + 12e-4, 1e-3], [k + 0.024, Np + 12e-4, 1e-3], [k + 0.024, Ch + 22e-4], [k + 0.018, Ch + 4e-3, 2e-3], [k - 4e-3, Ch + 4e-3, 2e-3]], 0.024, { b: 12e-4 })), t) {
      a.add(e.steel, h(Kr(0, 0, 82e-4, 24), 32e-4, { u: k + 9e-3, y: Ef, holes: [Kr(0, 0, 58e-4, 20)], b: 6e-4 }));
      for (let G of [-1, 1]) a.add(e.steel, c([[k - 2e-3, Ch + 3e-3], [k + 0.022, Ch + 3e-3], [k + 0.02, Ef + 5e-3, 4e-3], [k + 0.01, Ef + 0.01, 4e-3], [k + 2e-3, Ef + 5e-3, 4e-3]], 2e-3, { x: G * 0.0112, b: 8e-4 }));
      a.add(e.steel, Wn(5e-3, 5e-3, { x: I + 3e-3, y: Ch + 9e-3, u: k + 0.01, seg: 12 }), Wn(36e-4, 36e-4, { x: -0.0148, y: Np + 38e-4, u: k + 0.01, seg: 6 }));
      for (let G = 0; G < 8; G++) {
        let K = G * Math.PI / 4;
        a.add(e.black, Wn(7e-4, 52e-4, { x: I + 3e-3, y: Ch + 9e-3 + 5e-3 * Math.sin(K), u: k + 0.01 + 5e-3 * Math.cos(K), seg: 4 }));
      }
    } else a.add(e.steel, h(Kr(0, 0, 9e-3, 8), 36e-4, { u: k + 9e-3, y: Ef }));
  }
  if (o.muzzle === "choke" || o.muzzle === "brake") {
    let k = gf(o.muzzle, { caliber: "shotgun" });
    A.muzzle = Gt(0, Ws, xa + k.length), t ? (L.muzzle.add(k.group), F.push(k)) : a.add(e.steel, ni([[xa - 2e-3, 0.0114], [xa, k.radius], [xa + k.length - 4e-3, k.radius], [xa + k.length, k.radius - 3e-3], [xa + k.length, 95e-4]], { y: Ws, seg: 10 }));
  } else if (t) {
    a.add(e.steel, ni([[xa - 0.0125, 0.01155], [xa - 0.012, 0.0125], [xa - 3e-3, 0.0125], [xa - 2e-3, 0.01145]], { y: Ws, seg: 20 }));
    for (let k = 0; k < 18; k++) a.add(e.black, xh(bh(c(se(xa - 0.0108, 0.01252, xa - 42e-4, 0.0127), 1e-3, { b: 0 }), 0, Ws, 0), k * 20, Ws));
  }
  if (o.underbarrel === "laser") {
    for (let k of [R - 0.0245, R + 0.0235]) a.add(e.steel, ni([[k - 45e-4, 0.0125], [k - 45e-4, 0.0146], [k - 33e-4, 0.0152], [k + 33e-4, 0.0152], [k + 45e-4, 0.0146], [k + 45e-4, 0.0125]], { y: Ts, seg: u(18) })), t && a.add(e.steel, Wn(24e-4, 0.033, { y: Ts - 0.0168, u: k, seg: 6 }), Wn(4e-3, 2e-3, { x: 0.0172, y: Ts - 0.0168, u: k, seg: 6 }), Wn(4e-3, 2e-3, { x: -0.0172, y: Ts - 0.0168, u: k, seg: 6 }));
    a.add(e.steel, c([[R - 0.031, C + 62e-4, 1e-3], [R + 0.03, C + 62e-4, 1e-3], [R + 0.03, C, 12e-4], [R - 0.031, C, 12e-4]], 0.023, { b: 9e-4 }));
    for (let k of [-1, 1]) a.add(e.steel, c(se(R - 0.029, C + 4e-3, R + 0.028, Ts - 4e-3, 1e-3), 22e-4, { x: k * 0.0142, b: 7e-4 }));
    {
      let k = wp("laser", { mount: "mlok" });
      L.underbarrel.add(k.group), F.push(k), A.laser = L.underbarrel.position.clone().add(k.laser);
    }
  }
  if (t) {
    let k = AN(false), I = AN(true);
    {
      let G = new THREE.BufferGeometry();
      G.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 4e-4, 0, 0, 0, 4e-4, 0], 3)), G.setAttribute("normal", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3)), G.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 2));
      let K = new THREE.Mesh(G, s.shell);
      K.name = "shellWarm", K.position.copy(Gt(0, Ws, 0.15)), n.add(K);
    }
    for (let G of ["shell", "hull", "liftShell"]) {
      let K = Du(n, i, G, Gt(...l1.SHELL_REST));
      K.userData.hidden = true, K.visible = false;
      let $ = new THREE.Mesh(G === "hull" ? I : k, s.shell);
      $.name = G + "Mesh", K.add($);
    }
  }
  if (t) {
    let k = Du(n, i, "frag", Gt(0, -0.075, 0.17));
    k.userData.hidden = true, k.visible = false;
    let I = Z2();
    I.name = "fragMesh", k.add(I);
  }
  let P = new THREE.Group();
  P.name = "painted", r.build(P), n.add(P);
  for (let k of P.children) m.push([k, "metal", null]);
  a.build(n);
  let z = { id: "shotgun", root: n, parts: i, anchors: A, mounts: L, hip: { pos: Bt(Tl("hx", 0.104), Tl("hy", -0.118), Tl("hz", -0.33)), rot: new THREE.Euler(Tl("hrx", 0.035), Tl("hry", 0.095), Tl("hrz", 0.09)) }, adsDist: O, painted: m, optic: H, fitted: F, dim: { ...l1, TGUARD: b, TRIG: v, tubeEnd: M, IRON: Ef, RAILTOP: Ch, ext: y, heavy: E, padEnd: _ } };
  if (t && d) {
    nt0(z, d);
    for (let k of F) Ou(k, d);
  }
  return z;
}
function nt0(o, t) {
  let e = new THREE.Matrix4();
  for (let [s, n, i] of o.painted) {
    let a = xl(t, n);
    a && (s.geometry = Rc(s.geometry.clone(), i ? e.makeTranslation(i.x, i.y, i.z) : null), s.geometry.attributes.color || s.geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(s.geometry.attributes.position.count * 3).fill(1), 3)), s.material = a);
  }
}


// ---------------------------------------------------------------- exports

function patchGoldenHourMaterialsForWetness(root, wetUniform = SHARED_RAIN_WETNESS) {
  root.traverse((obj) => {
    obj.frustumCulled = false;
    if (!obj.isMesh || !obj.material) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) {
      if (!mat || (!mat.isMeshStandardMaterial && !mat.isMeshPhysicalMaterial)) continue;
      if (mat.transparent || mat.alphaTest > 0) continue;
      const hasCustomShader =
        Boolean(mat.onBeforeCompile && mat.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile)
        && !mat.userData?._vmDetailPatched;
      const detailKind = hasCustomShader ? -1 : (mat.metalness > 0.35 ? 1 : 2);
      applyDetailShader(mat, detailKind, wetUniform);
    }
  });
}

const GUN_BUILDERS = {
  ar: ak,
  smg: vk,
  shotgun: Ok,
  pistol: GT,
};

export const GH_WEAPON_SPECS = Ya;
export const GH_ATTACHMENTS = Lg;
export const GH_CAMOS = yr;

export function buildGoldenHourOptic(kind, opts = {}) {
  return Mp(kind, opts);
}

export function buildGoldenHourMuzzle(kind, opts = {}) {
  return gf(kind, opts);
}

export function buildGoldenHourUnderbarrel(kind, opts = {}) {
  return wp(kind, opts);
}

export function getGoldenHourCamoMaterial(camoId, surface = 'metal') {
  return xl(camoId, surface);
}

export function buildGoldenHourGun(kind, buildSpec = {}, { wetUniform = SHARED_RAIN_WETNESS } = {}) {
  const fn = GUN_BUILDERS[kind];
  if (!fn) throw new Error(`buildGoldenHourGun: unknown weapon kind "${kind}"`);
  const built = fn({ detail: 'view', build: buildSpec });
  // Hide unused bundled frag child inside shotgun/pistol view roots (standalone buildFragGrenade is exported).
  if (built.parts?.frag) {
    built.parts.frag.parent?.remove(built.parts.frag);
    delete built.parts.frag;
  }
  patchGoldenHourMaterialsForWetness(built.root, wetUniform);
  const tris = countObjectTriangles(built.root);
  return {
    id: built.id,
    kind,
    build: built.build,
    root: built.root,
    parts: built.parts,
    anchors: built.anchors,
    mounts: built.mounts,
    attachments: built.attachments || {},
    dims: built.dims || built.dim || {},
    hip: built.hip,
    adsDist: built.adsDist,
    setSlide: built.setSlide || null,
    heat: built.heat || null,
    tris,
  };
}

const _fragGrenadeCache = new WeakMap();

export function buildFragGrenade({ wetUniform = SHARED_RAIN_WETNESS } = {}) {
  let cached = _fragGrenadeCache.get(wetUniform);
  if (!cached) {
    const root = Z2();
    root.name = 'gh-frag-grenade';
    patchGoldenHourMaterialsForWetness(root, wetUniform);
    const tris = countObjectTriangles(root);
    cached = { root, tris };
    _fragGrenadeCache.set(wetUniform, cached);
  }
  return { root: cached.root.clone(true), tris: cached.tris };
}
