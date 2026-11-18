// Procedural habitat material library & interior habitation/furniture props
// (WebGL2 baseline, pure-Node safe via DataTexture fallback).

import * as THREE from 'three';
import { mergeGeometries, mergeVertices, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';

const Vn = mergeGeometries;
const a9 = mergeVertices;
const th = toCreasedNormals;

const NAMED_COLORS = {
  '#fff': [255, 255, 255, 255],
  '#ffffff': [255, 255, 255, 255],
  white: [255, 255, 255, 255],
  '#000': [0, 0, 0, 255],
  '#000000': [0, 0, 0, 255],
  black: [0, 0, 0, 255],
  transparent: [0, 0, 0, 0],
};

function parseCssColor(style) {
  if (!style) return [0, 0, 0, 255];
  if (typeof style === 'object' && style.__stops) {
    const stops = style.__stops;
    if (!stops.length) return [128, 128, 128, 255];
    let r = 0, g = 0, b = 0, a = 0;
    for (let i = 0; i < stops.length; i++) {
      r += stops[i][0];
      g += stops[i][1];
      b += stops[i][2];
      a += stops[i][3];
    }
    const inv = 1 / stops.length;
    return [Math.round(r * inv), Math.round(g * inv), Math.round(b * inv), Math.round(a * inv)];
  }
  const s = String(style).trim();
  if (NAMED_COLORS[s]) return NAMED_COLORS[s];
  if (s[0] === '#') {
    if (s.length === 4) {
      return [
        parseInt(s[1], 16) * 17,
        parseInt(s[2], 16) * 17,
        parseInt(s[3], 16) * 17,
        255,
      ];
    }
    if (s.length >= 7) {
      return [
        parseInt(s.slice(1, 3), 16) || 0,
        parseInt(s.slice(3, 5), 16) || 0,
        parseInt(s.slice(5, 7), 16) || 0,
        255,
      ];
    }
  }
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i.exec(s);
  if (m) {
    return [
      Math.max(0, Math.min(255, Math.round(Number(m[1])))),
      Math.max(0, Math.min(255, Math.round(Number(m[2])))),
      Math.max(0, Math.min(255, Math.round(Number(m[3])))),
      m[4] !== undefined ? Math.max(0, Math.min(255, Math.round(Number(m[4]) * 255))) : 255,
    ];
  }
  return [128, 128, 128, 255];
}

function createNodeGradient() {
  return {
    __stops: [],
    addColorStop(_offset, color) {
      this.__stops.push(parseCssColor(color));
    },
  };
}

function createNodeCanvas(width, height) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const data = new Uint8ClampedArray(w * h * 4);
  const u32 = new Uint32Array(data.buffer);
  let tx = 0, ty = 0, sx = 1, sy = 1;
  let clipX0 = 0, clipY0 = 0, clipX1 = w, clipY1 = h;
  const stack = [];
  let pMinX = Infinity, pMinY = Infinity, pMaxX = -Infinity, pMaxY = -Infinity;

  const markPt = (x, y) => {
    const px = x * sx + tx;
    const py = y * sy + ty;
    if (px < pMinX) pMinX = px;
    if (py < pMinY) pMinY = py;
    if (px > pMaxX) pMaxX = px;
    if (py > pMaxY) pMaxY = py;
  };

  const fillBox = (x0f, y0f, x1f, y1f, style, alphaScale = 1) => {
    const x0 = Math.max(clipX0, Math.floor(Math.min(x0f, x1f)));
    const y0 = Math.max(clipY0, Math.floor(Math.min(y0f, y1f)));
    const x1 = Math.min(clipX1, Math.ceil(Math.max(x0f, x1f)));
    const y1 = Math.min(clipY1, Math.ceil(Math.max(y0f, y1f)));
    if (x1 <= x0 || y1 <= y0) return;
    const [cr, cg, cb, ca] = parseCssColor(style);
    const a = Math.max(0, Math.min(255, Math.round(ca * ctx.globalAlpha * alphaScale)));
    if (a <= 0) return;
    if (ctx.globalCompositeOperation === 'destination-out') {
      const keep = 1 - a / 255;
      for (let y = y0; y < y1; y++) {
        let idx = (y * w + x0) * 4 + 3;
        for (let x = x0; x < x1; x++, idx += 4) data[idx] = Math.round(data[idx] * keep);
      }
      return;
    }
    if (a === 255 && ctx.globalCompositeOperation === 'source-over') {
      const packed = ((255 << 24) | (cb << 16) | (cg << 8) | cr) >>> 0;
      if (x0 === 0 && x1 === w) {
        u32.fill(packed, y0 * w, y1 * w);
      } else {
        for (let y = y0; y < y1; y++) u32.fill(packed, y * w + x0, y * w + x1);
      }
      return;
    }
    const af = a / 255;
    const inv = 1 - af;
    for (let y = y0; y < y1; y++) {
      let idx = (y * w + x0) * 4;
      for (let x = x0; x < x1; x++, idx += 4) {
        data[idx] = cr * af + data[idx] * inv;
        data[idx + 1] = cg * af + data[idx + 1] * inv;
        data[idx + 2] = cb * af + data[idx + 2] * inv;
        data[idx + 3] = Math.min(255, a + data[idx + 3] * inv);
      }
    }
  };

  const ctx = {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    font: '16px sans-serif',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    letterSpacing: '0px',
    shadowColor: 'transparent',
    shadowBlur: 0,
    filter: 'none',
    imageSmoothingQuality: 'low',
    save() {
      stack.push([
        tx, ty, sx, sy, clipX0, clipY0, clipX1, clipY1,
        this.fillStyle, this.strokeStyle, this.lineWidth, this.globalAlpha,
        this.globalCompositeOperation, this.font, this.textAlign, this.textBaseline,
      ]);
    },
    restore() {
      const s = stack.pop();
      if (!s) return;
      [
        tx, ty, sx, sy, clipX0, clipY0, clipX1, clipY1,
        this.fillStyle, this.strokeStyle, this.lineWidth, this.globalAlpha,
        this.globalCompositeOperation, this.font, this.textAlign, this.textBaseline,
      ] = s;
    },
    translate(dx, dy) { tx += dx * sx; ty += dy * sy; },
    scale(kx, ky) { sx *= kx; sy *= ky; },
    rotate() {},
    transform() {},
    resetTransform() { tx = 0; ty = 0; sx = 1; sy = 1; },
    setTransform(a, _b, _c, d, e, f) { sx = a; sy = d; tx = e; ty = f; },
    setLineDash() {},
    beginPath() { pMinX = Infinity; pMinY = Infinity; pMaxX = -Infinity; pMaxY = -Infinity; },
    closePath() {},
    moveTo(x, y) { markPt(x, y); },
    lineTo(x, y) { markPt(x, y); },
    arcTo(x1, y1, x2, y2) { markPt(x1, y1); markPt(x2, y2); },
    quadraticCurveTo(cpx, cpy, x, y) { markPt(cpx, cpy); markPt(x, y); },
    bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y) { markPt(cp1x, cp1y); markPt(cp2x, cp2y); markPt(x, y); },
    rect(x, y, rw, rh) { markPt(x, y); markPt(x + rw, y + rh); },
    roundRect(x, y, rw, rh) { markPt(x, y); markPt(x + rw, y + rh); },
    arc(x, y, r) { markPt(x - r, y - r); markPt(x + r, y + r); },
    ellipse(x, y, rx, ry) { markPt(x - rx, y - ry); markPt(x + rx, y + ry); },
    clip() {
      if (Number.isFinite(pMinX)) {
        clipX0 = Math.max(clipX0, Math.max(0, Math.floor(pMinX)));
        clipY0 = Math.max(clipY0, Math.max(0, Math.floor(pMinY)));
        clipX1 = Math.min(clipX1, Math.min(w, Math.ceil(pMaxX)));
        clipY1 = Math.min(clipY1, Math.min(h, Math.ceil(pMaxY)));
      }
    },
    fill() {
      if (Number.isFinite(pMinX)) fillBox(pMinX, pMinY, pMaxX, pMaxY, this.fillStyle);
    },
    stroke() {
      if (Number.isFinite(pMinX)) {
        const pad = Math.max(0.5, this.lineWidth * 0.5);
        fillBox(pMinX - pad, pMinY - pad, pMaxX + pad, pMaxY + pad, this.strokeStyle, 0.35);
      }
    },
    fillRect(x, y, rw, rh) {
      fillBox(x * sx + tx, y * sy + ty, (x + rw) * sx + tx, (y + rh) * sy + ty, this.fillStyle);
    },
    strokeRect(x, y, rw, rh) {
      const lw = Math.max(1, this.lineWidth);
      const x0 = x * sx + tx, y0 = y * sy + ty, x1 = (x + rw) * sx + tx, y1 = (y + rh) * sy + ty;
      fillBox(x0, y0, x1, y0 + lw, this.strokeStyle);
      fillBox(x0, y1 - lw, x1, y1, this.strokeStyle);
      fillBox(x0, y0, x0 + lw, y1, this.strokeStyle);
      fillBox(x1 - lw, y0, x1, y1, this.strokeStyle);
    },
    clearRect(x, y, rw, rh) {
      const x0 = Math.max(0, Math.floor(x * sx + tx));
      const y0 = Math.max(0, Math.floor(y * sy + ty));
      const x1 = Math.min(w, Math.ceil((x + rw) * sx + tx));
      const y1 = Math.min(h, Math.ceil((y + rh) * sy + ty));
      if (x0 === 0 && x1 === w) u32.fill(0, y0 * w, y1 * w);
      else for (let row = y0; row < y1; row++) u32.fill(0, row * w + x0, row * w + x1);
    },
    fillText(str, x, y) {
      const m = /(\d+(?:\.\d+)?)px/.exec(this.font);
      const px = m ? Number(m[1]) : 14;
      const tw = String(str).length * px * 0.52;
      const ox = this.textAlign === 'center' ? x - tw * 0.5 : this.textAlign === 'right' ? x - tw : x;
      fillBox(ox * sx + tx, (y - px * 0.35) * sy + ty, (ox + tw) * sx + tx, (y + px * 0.35) * sy + ty, this.fillStyle, 0.75);
    },
    strokeText() {},
    measureText(str) {
      const m = /(\d+(?:\.\d+)?)px/.exec(this.font);
      const px = m ? Number(m[1]) : 14;
      return { width: String(str).length * px * 0.55 };
    },
    createLinearGradient() { return createNodeGradient(); },
    createRadialGradient() { return createNodeGradient(); },
    createImageData(iw, ih) {
      const cw = Math.max(1, Math.round(iw));
      const ch = Math.max(1, Math.round(ih));
      return { width: cw, height: ch, data: new Uint8ClampedArray(cw * ch * 4) };
    },
    getImageData(ix, iy, iw, ih) {
      const cw = Math.max(1, Math.round(iw));
      const ch = Math.max(1, Math.round(ih));
      if (ix === 0 && iy === 0 && cw === w && ch === h) {
        return { width: w, height: h, data: new Uint8ClampedArray(data) };
      }
      const out = new Uint8ClampedArray(cw * ch * 4);
      for (let r = 0; r < ch; r++) {
        const syRow = Math.max(0, Math.min(h - 1, Math.floor(iy + r)));
        for (let c = 0; c < cw; c++) {
          const sxCol = Math.max(0, Math.min(w - 1, Math.floor(ix + c)));
          const sIdx = (syRow * w + sxCol) * 4;
          const dIdx = (r * cw + c) * 4;
          out[dIdx] = data[sIdx];
          out[dIdx + 1] = data[sIdx + 1];
          out[dIdx + 2] = data[sIdx + 2];
          out[dIdx + 3] = data[sIdx + 3];
        }
      }
      return { width: cw, height: ch, data: out };
    },
    putImageData(img, dx, dy) {
      if (!img || !img.data) return;
      const ox = Math.round(dx);
      const oy = Math.round(dy);
      if (ox === 0 && oy === 0 && img.width === w && img.height === h) {
        data.set(img.data);
        return;
      }
      for (let r = 0; r < img.height; r++) {
        const tyRow = oy + r;
        if (tyRow < 0 || tyRow >= h) continue;
        const c0 = Math.max(0, -ox);
        const c1 = Math.min(img.width, w - ox);
        if (c1 <= c0) continue;
        const srcOff = (r * img.width + c0) * 4;
        const dstOff = (tyRow * w + (ox + c0)) * 4;
        data.set(img.data.subarray(srcOff, srcOff + (c1 - c0) * 4), dstOff);
      }
    },
    drawImage(src, dx = 0, dy = 0, dw = src.width, dh = src.height) {
      if (!src || !src.__data) return;
      const x0 = Math.round(dx * sx + tx);
      const y0 = Math.round(dy * sy + ty);
      const rw = Math.max(1, Math.round(dw * sx));
      const rh = Math.max(1, Math.round(dh * sy));
      const sData = src.__data;
      const sw = src.width, sh = src.height;
      for (let r = 0; r < rh; r++) {
        const py = y0 + r;
        if (py < clipY0 || py >= clipY1) continue;
        const sr = Math.min(sh - 1, Math.floor((r / rh) * sh));
        for (let c = 0; c < rw; c++) {
          const px = x0 + c;
          if (px < clipX0 || px >= clipX1) continue;
          const sc = Math.min(sw - 1, Math.floor((c / rw) * sw));
          const si = (sr * sw + sc) * 4;
          const di = (py * w + px) * 4;
          const sa = sData[si + 3];
          if (sa === 255) {
            data[di] = sData[si];
            data[di + 1] = sData[si + 1];
            data[di + 2] = sData[si + 2];
            data[di + 3] = 255;
          } else if (sa > 0) {
            const af = sa / 255, inv = 1 - af;
            data[di] = sData[si] * af + data[di] * inv;
            data[di + 1] = sData[si + 1] * af + data[di + 1] * inv;
            data[di + 2] = sData[si + 2] * af + data[di + 2] * inv;
            data[di + 3] = Math.min(255, sa + data[di + 3] * inv);
          }
        }
      }
    },
  };

  return {
    __isNodeCanvas: true,
    __data: data,
    width: w,
    height: h,
    getContext() { return ctx; },
  };
}

var Vt = Math.PI * 2, jn = Math.PI / 180, Zt = (o2, t, e) => o2 < t ? t : o2 > e ? e : o2, ns = (o2) => o2 < 0 ? 0 : o2 > 1 ? 1 : o2, Ht = (o2, t, e) => o2 + (t - o2) * e, EY = (o2, t, e) => ns((e - o2) / (t - o2));
var Fo = (o2, t, e) => {
  let s = EY(o2, t, e);
  return s * s * (3 - 2 * s);
}, Ee = (o2, t, e, s) => Ht(o2, t, 1 - Math.exp(-e * s)), TL = (o2) => 1 - Math.pow(1 - ns(o2), 3), db = (o2) => (o2 = ns(o2), o2 * o2 * (3 - 2 * o2));
function Re(o2 = 1) {
  let t = o2 >>> 0, e = () => {
    t = t + 1831565813 >>> 0;
    let s = t;
    return s = Math.imul(s ^ s >>> 15, s | 1), s ^= s + Math.imul(s ^ s >>> 7, s | 61), ((s ^ s >>> 14) >>> 0) / 4294967296;
  };
  return e.range = (s, n) => s + (n - s) * e(), e.int = (s, n) => Math.floor(s + (n - s + 1) * e()), e.pick = (s) => s[Math.floor(e() * s.length)], e.sign = () => e() < 0.5 ? -1 : 1, e;
}
function _L(o2) {
  let t = o2.index ? o2.toNonIndexed() : o2;
  t.attributes.normal || t.computeVertexNormals(), t.attributes.uv || t.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(t.attributes.position.count * 2), 2));
  for (let e of Object.keys(t.attributes)) e !== "position" && e !== "normal" && e !== "uv" && t.deleteAttribute(e);
  return t.morphAttributes = {}, t;
}
function we(o2, t = o2) {
  if (typeof document !== 'undefined' && document && typeof document.createElement === 'function') {
    const e = document.createElement('canvas');
    e.width = o2;
    e.height = t;
    return e;
  }
  return createNodeCanvas(o2, t);
}
function _n(o2 = 1) {
  let t = Re(o2), e = new Uint8Array(512), s = Array.from({ length: 256 }, (c, h) => h);
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
var Hr = 256, Vm = Hr - 1, Wo = Math.PI * 2;
function yb(o2, t, e, s = 0.5) {
  let n = _n(o2), i = new Float32Array(Hr * Hr), a = t / Hr, r = 1, l = 0;
  for (let h = 0, f = 0; h < Hr; h++) for (let u = 0; u < Hr; u++, f++) {
    let d = n.fbm(u * a, h * a, e, t, s);
    i[f] = d, d < r && (r = d), d > l && (l = d);
  }
  let c = 1 / (l - r);
  for (let h = 0; h < i.length; h++) i[h] = (i[h] - r) * c;
  return i;
}
function ZY(o2, t) {
  let e = new Float32Array(t * t), s = new Float32Array(t * t);
  for (let r = 0; r < t; r++) for (let l = 0; l < t; l++) e[r * t + l] = l + 0.1 + 0.8 * Rn(l, r, o2), s[r * t + l] = r + 0.1 + 0.8 * Rn(l, r, o2 + 1);
  let n = new Float32Array(Hr * Hr), i = new Float32Array(Hr * Hr), a = t / Hr;
  for (let r = 0; r < Hr; r++) for (let l = 0; l < Hr; l++) {
    let c = (l + 0.5) * a, h = (r + 0.5) * a, f = Math.floor(c), u = Math.floor(h), d = 9, m = 9;
    for (let p = -1; p <= 1; p++) for (let x = -1; x <= 1; x++) {
      let g = f + x, b = u + p, v = (g % t + t) % t, y = (b % t + t) % t, M = y * t + v, w = e[M] + (g - v) - c, T = s[M] + (b - y) - h, S = Math.sqrt(w * w + T * T);
      S < d ? (m = d, d = S) : S < m && (m = S);
    }
    n[r * Hr + l] = d > 1 ? 1 : d, i[r * Hr + l] = m - d > 1 ? 1 : m - d;
  }
  return [n, i];
}
var Ga, yn, En, qo, Va, E9, T9;
function Be(o2, t, e) {
  let s = Math.floor(t), n = Math.floor(e), i = t - s, a = e - n;
  s &= Vm, n &= Vm;
  let r = s + 1 & Vm, l = n << 8, c = (n + 1 & Vm) << 8, h = o2[l + s], f = o2[l + r], u = o2[c + s], d = o2[c + r];
  return h + (f - h) * i + (u - h) * a + (h - f - u + d) * i * a;
}
var QY = Array.from({ length: 14 }, () => new Float32Array(Hr + 1));
function Oe(o2, t, e) {
  let s = QY[o2], n = Math.floor(e), i = e - n;
  n &= Vm;
  let a = n << 8, r = (n + 1 & Vm) << 8;
  for (let l = 0; l < Hr; l++) {
    let c = t[a + l];
    s[l] = c + (t[r + l] - c) * i;
  }
  return s[Hr] = s[0], s;
}
function Ne(o2, t) {
  let e = Math.floor(t), s = e & Vm;
  return o2[s] + (o2[s + 1] - o2[s]) * (t - e);
}
function Rn(o2, t, e = 0) {
  let s = Math.imul(o2 | 0, 374761393) + Math.imul(t | 0, 668265263) + Math.imul(e | 0, 1442695041) | 0;
  return s = Math.imul(s ^ s >>> 13, 1274126177), s ^= s >>> 16, (s >>> 0) / 4294967296;
}
function ze(o2, t, e) {
  let s = (e - o2) / (t - o2);
  return s = s < 0 ? 0 : s > 1 ? 1 : s, s * s * (3 - 2 * s);
}
var Gm = (o2, t) => (o2 % t + t) % t, xe = (o2, t, e) => o2 + (t - o2) * e, S9 = (o2) => o2 < 0 ? 0 : o2 > 1 ? 1 : o2;
function oh(o2) {
  let t = o2 >>> 0;
  return () => (t = Math.imul(t, 1664525) + 1013904223 >>> 0) / 4294967296;
}
var _9 = 8;
function Dd(o2, t, e, s, n) {
  let i = new THREE.DataTexture(new Uint8Array(o2.buffer), t, e, THREE.RGBAFormat, THREE.UnsignedByteType);
  return i.wrapS = i.wrapT = THREE.RepeatWrapping, i.magFilter = THREE.LinearFilter, i.minFilter = THREE.LinearMipmapLinearFilter, i.generateMipmaps = true, i.anisotropy = _9, s && (i.colorSpace = THREE.SRGBColorSpace), i.repeat.set(1 / n[0], 1 / n[1]), i.userData.tile = n, i.needsUpdate = true, i;
}
function nD(o2, t, e, s, n, i = 1) {
  let a = new Uint8ClampedArray(t * e * 4), r = t - 1, l = e - 1, c = i * 0.125 / s, h = i * 0.125 / n;
  for (let f = 0; f < e; f++) {
    let u = (f - 1 & l) * t, d = f * t, m = (f + 1 & l) * t;
    for (let p = 0; p < t; p++) {
      let x = p - 1 & r, g = p + 1 & r, b = o2[u + x], v = o2[u + g], y = o2[m + x], M = o2[m + g], w = -(v + 2 * o2[d + g] + M - (b + 2 * o2[d + x] + y)) * c, T = -(y + 2 * o2[m + p] + M - (b + 2 * o2[u + p] + v)) * h, S = 1 / Math.sqrt(w * w + T * T + 1), E = d + p << 2;
      a[E] = (w * S * 0.5 + 0.5) * 255 + 0.5, a[E + 1] = (T * S * 0.5 + 0.5) * 255 + 0.5, a[E + 2] = (S * 0.5 + 0.5) * 255 + 0.5, a[E + 3] = 255;
    }
  }
  return a;
}
function Wa(o2) {
  let t = Array.isArray(o2.tile) ? o2.tile : [o2.tile, o2.tile], e = { tile: t };
  return o2.alb && (e.map = Dd(o2.alb, o2.W, o2.H, true, t)), o2.hgt && (e.normalMap = Dd(nD(o2.hgt, o2.W, o2.H, t[0] * 1e3 / o2.W, t[1] * 1e3 / o2.H, o2.gain ?? 1), o2.W, o2.H, false, t)), o2.orm && (e.roughnessMap = Dd(o2.orm, o2.W, o2.H, false, t)), e;
}
var Dn = (o2) => new Uint8ClampedArray(o2 * 4);
function vb(o2, t, e, s, n, i, a) {
  let r = n - e, l = i - s, c = Math.max(1, Math.ceil(Math.hypot(r, l) * 1.4)), h = t - 1, f = a / 1.4;
  for (let u = 0; u <= c; u++) {
    let d = u / c, m = e + r * d, p = s + l * d, x = Math.floor(m), g = Math.floor(p), b = m - x, v = p - g, y = f * Math.min(1, 6 * d, 6 * (1 - d)), M = (g & h) * t, w = (g + 1 & h) * t, T = x & h, S = x + 1 & h;
    o2[M + T] += y * (1 - b) * (1 - v), o2[M + S] += y * b * (1 - v), o2[w + T] += y * (1 - b) * v, o2[w + S] += y * b * v;
  }
}
function Mg(o2, t, e, s, n, i, a = 0.5) {
  let r = t - 1, l = Math.floor(e - n - 1), c = Math.ceil(e + n + 1), h = Math.floor(s - n - 1), f = Math.ceil(s + n + 1);
  for (let u = h; u <= f; u++) for (let d = l; d <= c; d++) {
    let m = Math.hypot(d + 0.5 - e, u + 0.5 - s) / n, p = i * (1 - ze(a, 1.15, m)), x = (u & r) * t + (d & r);
    p > o2[x] && (o2[x] = p);
  }
}
function nw(o2, t, e, s, n, i, a, r, l = 0.012) {
  let c = 0;
  for (let h = 0; h < a; ) {
    let f = 3 + e() * 6;
    c = c * 0.7 + (e() - 0.5) * 0.9;
    let u = i + c, d = s + Math.cos(u) * f, m = n + Math.sin(u) * f;
    vb(o2, t, s, n, d, m, r * (0.55 + 0.45 * e()) * Math.min(1, (a - h) / 40 + 0.25)), s = d, n = m, h += f, i += (e() - 0.5) * 0.12, e() < l * f && a - h > 30 && nw(o2, t, e, s, n, i + (e() < 0.5 ? -1 : 1) * (0.5 + e() * 0.6), (a - h) * 0.45, r * 0.7, 0);
  }
}
function Mb(o2, t, e, s, n, i) {
  let a = nD(t, o2, o2, 1, 1, n), r = o2 * o2, l = 0, c = 0;
  for (let f = 0; f < r; f++) e && (l += e[f] < -1 ? -1 : e[f] > 1 ? 1 : e[f]), s && (c += s[f] < -1 ? -1 : s[f] > 1 ? 1 : s[f]);
  l /= r, c /= r;
  for (let f = 0, u = 0; f < r; f++, u += 4) a[u + 2] = 127.5 + 127.5 * (e ? (e[f] < -1 ? -1 : e[f] > 1 ? 1 : e[f]) - l : 0), a[u + 3] = 127.5 + 127.5 * (s ? (s[f] < -1 ? -1 : s[f] > 1 ? 1 : s[f]) - c : 0);
  let h = Dd(a, o2, o2, false, [1, 1]);
  return h.userData.tile = [i, i], h;
}
function JY() {
  let e = new Float32Array(262144), s = new Float32Array(262144), n = oh(4101);
  for (let l = 0; l < 230; l++) {
    let c = n() * Wo, h = 14 + n() * n() * 150, f = n() * 512, u = n() * 512;
    vb(e, 512, f, u, f + Math.cos(c) * h, u + Math.sin(c) * h, 0.25 + n() * 0.75);
  }
  for (let l = 0; l < 7; l++) {
    let c = n() * Wo, h = n() * 512, f = n() * 512, u = 60 + n() * 150;
    for (let d = 0; d < 9; d++) {
      let m = (n() - 0.5) * 16, p = c + (n() - 0.5) * 0.08, x = (n() - 0.5) * 30, g = h - Math.sin(c) * m + Math.cos(c) * x, b = f + Math.cos(c) * m + Math.sin(c) * x;
      vb(e, 512, g, b, g + Math.cos(p) * u * (0.4 + n() * 0.6), b + Math.sin(p) * u * (0.4 + n() * 0.6), 0.2 + n() * 0.5);
    }
  }
  for (let l = 0; l < 110; l++) Mg(s, 512, n() * 512, n() * 512, 0.7 + n() * n() * 1.6, 0.4 + n() * 0.6, 0.3);
  let i = new Float32Array(262144), a = new Float32Array(262144), r = new Float32Array(262144);
  for (let l = 0, c = 0; l < 512; l++) for (let h = 0; h < 512; h++, c++) {
    let f = e[c] > 1 ? 1 : e[c], u = Be(En, h + 9, l + 31) - 0.5, d = Be(yn, h * 0.5 + 77, l * 0.5 + 5) - 0.5;
    i[c] = -f * 0.5 - s[c] * 1.6 + u * 1.1, a[c] = f * 0.9 + s[c] * 0.7 + d * 0.35 + (Rn(h, l, 5) - 0.5) * 0.12, r[c] = -s[c] * 0.8 - f * 0.1 + (Be(E9, h * 3 + 5, l * 3 + 9) - 0.5) * 0.3 + (Rn(h, l, 6) - 0.5) * 0.1;
  }
  return Mb(512, i, a, r, 1, 0.33);
}
function tj() {
  let e = new Float32Array(262144), s = oh(4202);
  for (let r = 0; r < 620; r++) Mg(e, 512, s() * 512, s() * 512, 0.8 + s() * s() * s() * 4.2, 0.45 + s() * 0.55, 0.35);
  let n = new Float32Array(262144), i = new Float32Array(262144), a = new Float32Array(262144);
  for (let r = 0, l = 0; r < 512; r++) for (let c = 0; c < 512; c++, l++) {
    let h = 0.45 * Rn(c, r, 7) + 0.55 * Be(qo, c * 2 + 3, r * 2 + 8), f = Be(En, c + 40, r + 12) - 0.5, u = e[l];
    n[l] = (h - 0.5) * 1.5 + f * 1.2 - u * 3.4, i[l] = (h - 0.5) * 0.9 + u * 0.5 + f * 0.3, a[l] = (h - 0.5) * 0.42 + f * 0.2 - u * 1;
  }
  return Mb(512, n, i, a, 1, 0.31);
}
function ej() {
  let s = 0.0859375, n = new Float32Array(22 * 22), i = new Float32Array(22 * 22), a = new Float32Array(22 * 22), r = new Float32Array(22 * 22);
  for (let h = 0; h < 22; h++) for (let f = 0; f < 22; f++) {
    let u = h * 22 + f;
    n[u] = f + 0.15 + 0.7 * Rn(f, h, 31), i[u] = h + 0.15 + 0.7 * Rn(f, h, 32), a[u] = Rn(f, h, 33), r[u] = Rn(f, h, 34) * Wo;
  }
  let l = new Float32Array(65536), c = new Float32Array(65536);
  for (let h = 0, f = 0; h < 256; h++) for (let u = 0; u < 256; u++, f++) {
    let d = (u + 0.5) * s, m = (h + 0.5) * s, p = Math.floor(d), x = Math.floor(m), g = 9, b = 9, v = 0, y = 0, M = 0;
    for (let E = -1; E <= 1; E++) for (let _ = -1; _ <= 1; _++) {
      let R = p + _, C = x + E, L = Gm(R, 22), A = Gm(C, 22), O = A * 22 + L, H = n[O] + (R - L) - d, F = i[O] + (C - A) - m, P = Math.sqrt(H * H + F * F);
      P < g ? (b = g, g = P, v = O, y = H, M = F) : P < b && (b = P);
    }
    let w = ze(0, 0.42, b - g), T = 0.5 + 0.5 * Math.sin(Math.atan2(M, y) * 3 + r[v] + g * 9), S = Rn(u, h, 35);
    l[f] = w * (2.2 + 0.9 * T) + (y * Math.cos(r[v]) + M * Math.sin(r[v])) * 1.3 + S * 0.5, c[f] = (w - 0.62) * 1 + (a[v] - 0.5) * 0.7 + (T - 0.5) * 0.22 * w + (S - 0.5) * 0.25;
  }
  return Mb(256, l, null, c, 0.55, 0.07);
}
function sj() {
  let e = new Float32Array(262144), s = oh(4404);
  for (let l = 0; l < 46; l++) {
    let c = (s() - 0.5) * 2.4 + (s() < 0.5 ? 0 : Math.PI / 2), h = 20 + s() * 130, f = s() * 512, u = s() * 512;
    vb(e, 512, f, u, f + Math.cos(c) * h, u + Math.sin(c) * h, 0.3 + s() * 0.7);
  }
  let n = new Float32Array(262144), i = new Float32Array(262144), a = new Float32Array(262144), r = (l, c, h, f) => {
    let u = l / h, d = Math.floor(u), m = u - d, p = m * m * (3 - 2 * m), x = 512 / h;
    return xe(Rn(d % x, c, f), Rn((d + 1) % x, c, f), p);
  };
  for (let l = 0, c = 0; l < 512; l++) for (let h = 0; h < 512; h++, c++) {
    let f = l + 1 & 511, u = 0.42 * Rn(7, l, 40) + 0.3 * r(h, l, 128, 41) + 0.28 * r(h + 37, l, 32, 42), d = 0.42 * Rn(7, f, 40) + 0.3 * r(h, f, 128, 41) + 0.28 * r(h + 37, f, 32, 42), m = u * 0.75 + d * 0.25, p = e[c] > 1 ? 1 : e[c], x = Be(yn, h * 0.5, l * 0.5) - 0.5;
    n[c] = m * 1.6 - p * 1.5, i[c] = (m - 0.5) * 1.5 + p * 0.6 + x * 0.08, a[c] = (m - 0.5) * 0.6 - p * 0.2;
  }
  return Mb(512, n, i, a, 0.75, 0.24);
}
function nj() {
  let e = new Float32Array(262144), s = oh(4505), n = 511;
  for (let c = 0; c < 40; c++) {
    let h = s() * 512, f = s() * 512, u = s() * Wo, d = 7 + s() * 7, m = d * (1.3 + s() * 0.6), p = 0.35 + s() * 0.65, x = Math.cos(u), g = Math.sin(u), b = Math.ceil(m + 2);
    for (let v = -b; v <= b; v++) for (let y = -b; y <= b; y++) {
      let M = (y * x + v * g) / d, w = (-y * g + v * x) / m, T = Math.sqrt(M * M + w * w);
      if (T >= 1.1) continue;
      let S = ((f + v | 0) & n) * 512 + ((h + y | 0) & n), E = 0.72 + 0.28 * Math.sin((Math.hypot(M * d, w * m * 0.8) + M * 2) * 2.6), _ = p * (1 - ze(0.55, 1.05, T)) * E * (0.6 + 0.4 * Be(qo, (h + y) * 2, (f + v) * 2));
      _ > e[S] && (e[S] = _);
    }
  }
  let i = new Float32Array(262144);
  for (let c = 0; c < 9; c++) {
    let h = s() * 512, f = s() * 512, u = s() * Wo, d = (s() - 0.5) * 0.02, m = 0.05 + s() * 0.08;
    for (let p = 0; p < 70; p++) {
      let x = h + Math.cos(u) * 6, g = f + Math.sin(u) * 6;
      for (let b = -7; b <= 7; b += 1.4) vb(i, 512, h - Math.sin(u) * b, f + Math.cos(u) * b, x - Math.sin(u) * b, g + Math.cos(u) * b, m * (0.4 + 0.6 * Rn(b * 10, c, 46)));
      h = x, f = g, u += d;
    }
  }
  let a = new Float32Array(262144), r = new Float32Array(262144), l = new Float32Array(262144);
  for (let c = 0; c < 262144; c++) r[c] = e[c] + Math.min(0.5, i[c]) - 0.08, l[c] = -e[c] * 0.06;
  return Mb(512, a, r, l, 1, 0.3);
}
function oj() {
  let e = Dn(262144), s = new Float32Array(262144), n = new Float32Array(262144);
  for (let a = 0, r = 0; a < 512; a++) {
    let l = a * 0.5, c = Oe(0, Ga, l), h = Oe(1, yn, l + 90), f = Oe(2, Va, l + 30), u = Oe(3, yn, l * 2 + 3), d = Oe(4, Ga, l + 5), m = Oe(5, Ga, l + 33), p = Oe(6, En, l * 2 + 70), x = Oe(7, En, l + 9), g = Oe(8, qo, l + 3), b = Oe(9, yn, l + 77);
    for (let v = 0; v < 512; v++, r++) {
      let y = v * 0.5, M = r << 2;
      e[M] = (Ne(c, y) * 0.65 + Ne(h, y + 40) * 0.35) * 255, e[M + 1] = (Ne(f, y + 120) * 0.7 + Ne(u, y * 2 + 7) * 0.3) * 255;
      let w = (Ne(d, y + 17) - 0.5) * 70, T = (Ne(m, y + 91) - 0.5) * 70;
      s[r] = Be(Va, y + w + 60, l + T + 10) * 0.5 + Be(yn, y * 2 + w + 11, l * 2 + T + 50) * 0.32 + Ne(p, y * 2 + 3) * 0.18, n[r] = Ne(x, y * 8 + 5) * 0.5 + Ne(g, y * 4 + 9) * 0.3 + Ne(b, y * 2) * 0.2;
    }
  }
  let i = (a, r) => {
    let l = new Uint32Array(4096);
    for (let f = 0; f < 262144; f++) l[Math.min(4095, a[f] * 4096 | 0)]++;
    let c = new Float32Array(4096), h = 0;
    for (let f = 0; f < 4096; f++) h += l[f], c[f] = h / 262144;
    for (let f = 0; f < 262144; f++) e[(f << 2) + r] = c[Math.min(4095, a[f] * 4096 | 0)] * 255;
  };
  return i(s, 2), i(n, 3), Dd(e, 512, 512, false, [1, 1]);
}
function w9(o2, t, e, s, n) {
  let i = Dd(new Uint8ClampedArray([o2, t, e, s]), 1, 1, n, [1, 1]);
  return i.generateMipmaps = false, i.minFilter = THREE.LinearFilter, i.anisotropy = 1, i;
}
function ij() {
  let e = Dn(1048576), s = Dn(1048576), n = new Float32Array(1048576);
  for (let i = 0; i < 1024; i++) {
    let a = i / 1024, r = i * 0.25, l = Oe(0, Ga, r), c = Oe(1, Va, r + 77), h = Oe(2, En, r * 2 + 40), f = Oe(3, qo, i * 0.5 + 9), u = Oe(4, yn, r + 40), d = Oe(5, Va, r * 2 + 10), m = Oe(6, En, r * 2 + 17), p = Oe(7, yn, r * 2 + 150), x = Oe(8, yn, r * 2 + 190), g = Oe(9, yn, r + 250), b = Oe(10, Va, r * 2 + 140);
    for (let v = 0; v < 1024; v++) {
      let y = v / 1024, M = v * 0.25, w = i * 1024 + v, T = Ne(l, M) - 0.5, S = Ne(c, M + 31) - 0.5, E = Ne(h, M * 2 + 5) - 0.5, _ = Ne(f, v * 0.5 + 3) - 0.5, R = Ne(u, M + 200), C = Ne(d, M * 2 + 300), L = ze(0.3, 0.6, C), A = Ne(m, M * 2 + 61), O = 2 * y + a + T * 0.42 + S * 0.22 + E * 0.04 + _ * 2e-3, H = Math.abs(O - Math.floor(O) - 0.5), F = 6e-3 + 0.04 * R * R, P = (1 - ze(F * 0.15, F, H)) * L * (0.45 + 0.75 * A), z = Math.abs(H - F * (0.35 + 0.5 * A)), k = (1 - ze(4e-4, 4e-3, z)) * L * ze(0.2, 0.5, R + A * 0.4), I = (1 - ze(4e-4, 34e-4 + 4e-3 * R, H)) * (0.25 + 0.75 * L), G = (1 - ze(0, F * 2.2 + 0.02, H)) * L, K = Ne(p, M * 2 + 70);
      O += 0.035 + (K - 0.5) * 0.12;
      let $ = Math.abs(O - Math.floor(O) - 0.5), n0 = (1 - ze(5e-4, 42e-4, $)) * ze(0.34, 0.6, K) * 0.6, e0 = Ne(x, M * 2 + 9);
      O = -y + 2 * a + T * 0.5 - S * 0.6 + E * 0.05 + _ * 2e-3;
      let p0 = Math.abs(O - Math.floor(O) - 0.5), t0 = (1 - ze(8e-4, 5e-3, p0)) * ze(0.56, 0.8, e0) * 0.55, M0 = ze(0.3, 0.8, Ne(g, M + 400));
      O = 3 * y - a + S * 0.7 + T * 0.3 + E * 0.08;
      let f0 = Math.abs(O - Math.floor(O) - 0.5), _0 = (1 - ze(3e-4, 32e-4, f0)) * ze(0.6, 0.85, Ne(b, M * 2 + 90)) * 0.3, F0 = ze(0.02, 0.22, S) * ze(0.35, 0.6, A), m0 = 230, S0 = 225, T0 = 216;
      m0 = xe(m0, 213, M0 * 0.5), S0 = xe(S0, 207, M0 * 0.5), T0 = xe(T0, 199, M0 * 0.5);
      let j0 = G * 0.24;
      m0 = xe(m0, 194, j0), S0 = xe(S0, 188, j0), T0 = xe(T0, 180, j0);
      let Z0 = Math.min(1, P) * 0.72;
      m0 = xe(m0, xe(156, 196, F0), Z0), S0 = xe(S0, xe(154, 172, F0), Z0), T0 = xe(T0, xe(155, 136, F0), Z0);
      let lt = Math.min(1, k * 0.8 + I * 0.9);
      m0 = xe(m0, xe(92, 150, F0), lt), S0 = xe(S0, xe(91, 116, F0), lt), T0 = xe(T0, xe(96, 70, F0), lt), m0 = xe(m0, 128, n0), S0 = xe(S0, 121, n0), T0 = xe(T0, 114, n0), m0 = xe(m0, 146, t0), S0 = xe(S0, 137, t0), T0 = xe(T0, 126, t0), m0 = xe(m0, 160, _0), S0 = xe(S0, 152, _0), T0 = xe(T0, 142, _0);
      let H0 = 1 + E * 0.035 + _ * 0.025, Y0 = w << 2;
      e[Y0] = m0 * H0, e[Y0 + 1] = S0 * H0, e[Y0 + 2] = T0 * H0, e[Y0 + 3] = 255, n[w] = T * 5 + S * 2.4 + E * 0.3 - lt * 0.035 - n0 * 0.015;
      let et = R * 0.5 + A * 0.5;
      s[Y0] = 255 * (1 - 0.1 * lt), s[Y0 + 1] = 255 * Math.min(1, 0.066 + 0.07 * et * et + lt * 0.07 + n0 * 0.03 + t0 * 0.02 + Z0 * 0.02), s[Y0 + 2] = 255, s[Y0 + 3] = 0;
    }
  }
  return Wa({ W: 1024, H: 1024, alb: e, hgt: n, orm: s, tile: 2.4 });
}
function aj() {
  let e = Dn(1048576), s = Dn(1048576), n = new Float32Array(1048576);
  for (let i = 0; i < 1024; i++) {
    let a = i / 1024, r = i * 0.25, l = Oe(0, Ga, r), c = Oe(1, Va, r + 77), h = Oe(2, En, r + 40), f = Oe(3, qo, i * 0.5 + 9), u = Oe(4, yn, r + 40), d = Oe(5, Va, r + 10), m = Oe(6, En, r * 2 + 3), p = Oe(7, yn, r + 150), x = Oe(8, yn, r * 2 + 190), g = Oe(9, yn, r + 250), b = Oe(10, En, r * 2 + 71), v = Oe(11, Va, r * 2 + 140), y = Oe(12, Ga, r + 3), M = Oe(13, En, r);
    for (let w = 0; w < 1024; w++) {
      let T = w / 1024, S = w * 0.25, E = i * 1024 + w, _ = Ne(l, S) - 0.5, R = Ne(c, S + 31) - 0.5, C = Ne(h, S + 5) - 0.5, L = Ne(f, w * 0.5 + 3) - 0.5, A = Ne(u, S + 200), O = ze(0.36, 0.7, Ne(d, S + 300)), H = 2 * T + a + _ * 1 + R * 0.5 + C * 0.05 + L * 4e-3, F = Math.abs(H - Math.floor(H) - 0.5), P = 5e-3 + 0.026 * A * A, z = (1 - ze(P * 0.08, P * 0.45, Math.abs(F - P * 0.3 * (Ne(m, S * 2 + 80) - 0.3)))) * O, k = (1 - ze(P * 0.3, P, F)) * O, I = (1 - ze(0, P * 3 + 0.03, F)) * O * 0.5;
      H = 2 * T + a + 0.37 + R * 1.4 - _ * 0.45 + C * 0.1 + L * 4e-3;
      let G = Math.abs(H - Math.floor(H) - 0.5), K = (1 - ze(25e-4, 0.01, G)) * ze(0.58, 0.82, Ne(p, S + 70)) * 0.85;
      H = -T + 3 * a + _ * 0.8 - R * 1.2 + C * 0.16 + L * 5e-3;
      let $ = Math.abs(H - Math.floor(H) - 0.5), n0 = (1 - ze(2e-3, 9e-3, $)) * ze(0.62, 0.86, Ne(x, S * 2 + 9)) * 0.55, e0 = Ne(g, S + 400), p0 = ze(0.6, 0.9, Ne(b, S * 2 + 33)) * ze(0.4, 0.7, e0), t0 = ze(0.55, 0.8, Ne(v, S * 2 + 90));
      H = 3 * T - 2 * a + R * 0.9 + _ * 0.4 + C * 0.12;
      let M0 = Math.abs(H - Math.floor(H) - 0.5), f0 = (1 - ze(6e-4, 3e-3, M0)) * t0 * 0.35, _0 = 48 + e0 * 12, F0 = 45 + e0 * 10, m0 = 46 + e0 * 9;
      _0 = xe(_0, 74, p0 * 0.45), F0 = xe(F0, 72, p0 * 0.45), m0 = xe(m0, 74, p0 * 0.45), _0 = xe(_0, 92, I * 0.3), F0 = xe(F0, 66, I * 0.3), m0 = xe(m0, 38, I * 0.3), _0 = xe(_0, 190, k), F0 = xe(F0, 142, k), m0 = xe(m0, 70, k), _0 = xe(_0, 232, z * 0.8), F0 = xe(F0, 190, z * 0.8), m0 = xe(m0, 112, z * 0.8), _0 = xe(_0, 176, K), F0 = xe(F0, 132, K), m0 = xe(m0, 70, K), _0 = xe(_0, 208, n0), F0 = xe(F0, 203, n0), m0 = xe(m0, 192, n0), _0 = xe(_0, 150, f0), F0 = xe(F0, 146, f0), m0 = xe(m0, 140, f0);
      let S0 = 1 + L * 0.08 + C * 0.05, T0 = E << 2;
      e[T0] = _0 * S0, e[T0 + 1] = F0 * S0, e[T0 + 2] = m0 * S0, e[T0 + 3] = 255, n[E] = (Ne(y, S + 77) - 0.5) * 3.2 + R * 1.2 - k * 0.05 - n0 * 0.02, s[T0] = 255 * (1 - 0.12 * k), s[T0 + 1] = 255 * (0.06 + 0.07 * Ne(M, S) + k * 0.09 + n0 * 0.05 + f0 * 0.04), s[T0 + 2] = 255, s[T0 + 3] = 0;
    }
  }
  return Wa({ W: 1024, H: 1024, alb: e, hgt: n, orm: s, tile: 2 });
}
function eD(o2) {
  let n = Dn(524288), i = Dn(524288), a = new Float32Array(524288), r = o2.early, l = o2.late, c = o2.pore;
  for (let h = 0; h < 512; h++) {
    let f = h / 512, u = h * 0.5, d = Oe(0, Ga, u), m = Oe(1, yn, u + 9), p = Oe(2, En, u * 2 + o2.seed), x = Oe(3, yn, u * 2 + 13), g = Oe(4, qo, h * 4 + 3), b = Oe(5, En, h * 2 + 51), v = Oe(6, qo, h * 4 + 77), y = Oe(7, qo, h * 2 + 19), M = Oe(8, yn, u + 60);
    for (let w = 0; w < 1024; w++) {
      let T = h * 1024 + w, S = w * 0.25, E = Ne(d, S + o2.seed) - 0.5, _ = Ne(m, S + 40 + o2.seed) - 0.5, R = Ne(p, S + 7) - 0.5, C = o2.rings * f + E * o2.sweep + _ * o2.sweep * 0.45 + R * 0.5, L = Math.floor(C), A = C - L, O = Gm(L, o2.rings), H = Rn(O, 3, o2.seed), F = Rn(O, 5, o2.seed), P = ze(0.35 + 0.2 * H, 0.9, A) * (1 - ze(0.94, 1, A)) * (0.35 + 0.65 * F) * (0.45 + 0.55 * Ne(x, S + 77 + o2.seed)), z = Ne(g, S + 11) * 0.6 + Ne(b, S + 90) * 0.4, k = Ne(v, w + 7), I = ze(o2.poreLo, o2.poreLo + 0.16, k) * (o2.ringPorous ? (1 - ze(0.05, 0.6, A)) * 0.85 + 0.15 : 0.6), G = o2.rays ? ze(0.8, 0.92, Ne(y, w * 2 + 31)) * o2.rays : 0, K = Ne(M, S + 140), $ = o2.streak ? ze(0.62, 0.9, Be(Va, S + 9 + o2.seed, u * 2 + 33 + E * 30)) * o2.streak : 0, n0 = xe(r[0], l[0], P), e0 = xe(r[1], l[1], P), p0 = xe(r[2], l[2], P), t0 = (0.9 + 0.2 * z) * (0.93 + 0.14 * K) * (1 - 0.3 * $);
      n0 *= t0, e0 *= t0 * (1 - 0.05 * $), p0 *= t0 * (1 - 0.02 * $), n0 = xe(n0, c[0], I * 0.8), e0 = xe(e0, c[1], I * 0.8), p0 = xe(p0, c[2], I * 0.8), n0 *= 1 - 0.22 * G, e0 *= 1 - 0.26 * G, p0 *= 1 - 0.3 * G;
      let M0 = T << 2;
      n[M0] = n0, n[M0 + 1] = e0, n[M0 + 2] = p0, n[M0 + 3] = 255, a[T] = P * 0.035 - I * 0.09 + (z - 0.5) * 0.03 - G * 0.015 + _ * 0.2, i[M0] = 255 * (1 - 0.45 * I - 0.1 * G), i[M0 + 1] = 255 * Math.min(1, o2.rough + 0.1 * (1 - P) + I * 0.3 + (z - 0.5) * 0.1 + G * 0.06), i[M0 + 2] = 255, i[M0 + 3] = 0;
    }
  }
  return Wa({ W: 1024, H: 512, alb: n, hgt: a, orm: i, tile: o2.tile, gain: o2.gain });
}
var rj = { seed: 0, tile: [1.8, 0.18], rings: 34, sweep: 7, ringPorous: true, poreLo: 0.6, rays: 0.8, streak: 0, rough: 0.33, gain: 1.6, early: [208, 172, 124], late: [164, 123, 80], pore: [112, 80, 50] }, lj = { seed: 97, tile: [2.4, 0.3], rings: 44, sweep: 11, ringPorous: false, poreLo: 0.66, rays: 0, streak: 0.8, rough: 0.3, gain: 1.6, early: [102, 76, 55], late: [74, 53, 38], pore: [46, 32, 23] };
function oD(o2, t, e, { carve: s = 1.6, shade: n = 0.12 } = {}) {
  let a = o2.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, t, t).data, r = new Float32Array(t * t), l = 256 / t;
  for (let c = 0; c < t; c++) {
    let h = Oe(0, yn, c * l), f = Oe(1, Va, c * l * 2), u = Oe(2, En, c * l * 2 + 30), d = Rn(3, c >> 1, 6) - 0.5;
    for (let m = 0; m < t; m++) {
      let p = c * t + m, x = p << 2, g = Ne(h, m * l) * 0.6 + Ne(f, m * l * 2 + 40) * 0.4, b = Ne(u, m * l * 2), v = ze(4, 46, a[x] - a[x + 2]), y = (0.92 + 0.16 * b + 0.05 * d) * (1 - n + 2 * n * g);
      a[x] *= y, a[x + 1] *= y, a[x + 2] *= y, r[p] = -v * s + g * 1.2 + b * 0.5 + d * 0.25;
    }
  }
  return Wa({ W: t, H: t, alb: a, hgt: r, tile: e, gain: 0.8 });
}
function cj() {
  let e = we(1024), s = e.getContext("2d", { willReadFrequently: true });
  s.fillStyle = "#12263a", s.fillRect(0, 0, 1024, 1024);
  let n = "#a98a52", i = "#8a7346";
  for (let a = -1; a <= 1024 / 256 + 1; a++) for (let r = -1; r <= 1024 / (2 * 256) + 1; r++) {
    let l = r * 2 * 256 + (a & 1) * 256, c = a * 256, h = (r + (a >> 1) & 1) === 0, f = s.createRadialGradient(l, c, 256 * 0.1, l, c, 256);
    h ? (f.addColorStop(0, "#1f5058"), f.addColorStop(1, "#163c45")) : (f.addColorStop(0, "#1b3852"), f.addColorStop(1, "#132a42")), s.fillStyle = f, s.beginPath(), s.arc(l, c, 257, 0, Wo), s.fill(), s.strokeStyle = i, s.lineWidth = 3, s.lineCap = "butt";
    for (let u = 1; u < 16; u++) {
      let d = Math.PI + u / 16 * Math.PI;
      s.beginPath(), s.moveTo(l + Math.cos(d) * 256 * 0.3, c + Math.sin(d) * 256 * 0.3), s.lineTo(l + Math.cos(d) * 256 * 0.955, c + Math.sin(d) * 256 * 0.955), s.stroke();
    }
    s.strokeStyle = n, s.lineWidth = 8, s.beginPath(), s.arc(l, c, 252, Math.PI, Wo), s.stroke(), s.lineWidth = 3, s.beginPath(), s.arc(l, c, 256 * 0.93, Math.PI, Wo), s.stroke(), s.lineWidth = 3, s.beginPath(), s.arc(l, c, 256 * 0.64, Math.PI, Wo), s.stroke(), s.lineWidth = 5, s.beginPath(), s.arc(l, c, 256 * 0.3, Math.PI, Wo), s.stroke(), s.lineWidth = 2.5, s.beginPath(), s.arc(l, c, 256 * 0.24, Math.PI, Wo), s.stroke(), s.fillStyle = h ? "#9a5a34" : n, s.beginPath(), s.arc(l, c, 256 * 0.12, Math.PI, Wo), s.fill();
  }
  return oD(e, 1024, 2.4, { carve: 1.8, shade: 0.12 });
}
function hj() {
  let e = we(1024), s = e.getContext("2d", { willReadFrequently: true });
  s.fillStyle = "#39373b", s.fillRect(0, 0, 1024, 1024);
  let n = (i, a, r) => {
    s.beginPath(), s.moveTo(i, a - r), s.lineTo(i + r, a), s.lineTo(i, a + r), s.lineTo(i - r, a), s.closePath();
  };
  for (let i = -1; i <= 1024 / 256 + 1; i++) for (let a = -1; a <= 1024 / 256 + 1; a++) {
    let r = a * 256, l = i * 256;
    s.strokeStyle = "#514a45", s.lineWidth = 3.2, n(r, l, 256 * 0.5 - 12), s.stroke(), s.strokeStyle = "#8f4d2c", s.lineWidth = 8, n(r, l, 256 * 0.5), s.stroke(), s.fillStyle = "#3f2e28", n(r, l, 256 * 0.2), s.fill(), s.strokeStyle = "#8f4d2c", s.lineWidth = 4, n(r, l, 256 * 0.2), s.stroke(), s.fillStyle = "#9a8054", n(r + 256 * 0.5, l + 256 * 0.5, 10), s.fill();
  }
  return oD(e, 1024, 1.6, { carve: 1.3, shade: 0.16 });
}
function fj() {
  let e = Dn(1048576), s = Dn(1048576), n = new Float32Array(1048576);
  for (let i = 0; i < 1024; i++) {
    let a = i * 0.25, r = Oe(0, yn, a), l = Oe(1, En, a + 20), c = Oe(2, yn, i * 0.5 + 77), h = Oe(3, En, i * 0.5 + 41), f = Oe(4, En, i + 5), u = Oe(5, Ga, a + 60);
    for (let d = 0; d < 1024; d++) {
      let m = i * 1024 + d, p = d * 0.25, x = (Ne(r, p) - 0.5) * 44 + (Ne(l, p + 50) - 0.5) * 9, g = i + x, b = Be(Ga, p + 11, g), v = Be(En, p + 71, g + 30), y = Be(qo, p, g + 5), M = Ne(c, d * 0.5 + 9) * 0.6 + Ne(h, d * 0.5 + 3) * 0.4, w = 0.3 * b + 0.28 * v + 0.14 * y + 0.28 * M, T = ze(0.56, 0.78, Be(yn, p + 91, g * 0.5 + 17)), S = 0, E = 0, _ = 0;
      if (T > 0) {
        let F = Be(qo, d + 3, g * 2 + 8), P = ze(0.7, 0.79, F) * T;
        S = P * ze(0.6, 0.72, Ne(f, d + 13)), E = P - S, _ = ze(0.64, 0.7, F) * T * (1 - P);
      }
      let R = ze(0.66, 0.9, Be(Va, p + 200, g * 0.5 + 90)) * 0.5, C = w < 0.5 ? xe(180, 205, w * 2) : xe(205, 226, w * 2 - 1), L = w < 0.5 ? xe(162, 190, w * 2) : xe(190, 214, w * 2 - 1), A = w < 0.5 ? xe(137, 167, w * 2) : xe(167, 194, w * 2 - 1);
      C = xe(C, 196, R * 0.3), L = xe(L, 160, R * 0.3), A = xe(A, 118, R * 0.3), C = xe(C, 214, E * 0.75), L = xe(L, 205, E * 0.75), A = xe(A, 188, E * 0.75);
      let O = 1 - 0.62 * S - 0.14 * _, H = m << 2;
      e[H] = C * O, e[H + 1] = L * O, e[H + 2] = A * O * (1 - 0.05 * S), e[H + 3] = 255, n[m] = -S * 1.7 - E * 0.06 + (y - 0.5) * 0.3 + (v - 0.5) * 0.3 + (Ne(u, p + 150) - 0.5) * 2.2, s[H] = 255 * (1 - 0.6 * S - 0.1 * _), s[H + 1] = 255 * Math.min(1, 0.6 + 0.14 * (1 - w) + S * 0.25 + E * 0.14 + 0.06 * M), s[H + 2] = 255 * (0.12 + 0.88 * T) * (1 - E), s[H + 3] = 0;
    }
  }
  return Wa({ W: 1024, H: 1024, alb: e, hgt: n, orm: s, tile: 1.8 });
}
var sD = [[17, 90, 118], [26, 128, 142], [70, 176, 172]];
function uj() {
  let e = Dn(262144), s = Dn(262144), n = new Float32Array(262144), i = new Float32Array(262144), a = oh(606);
  for (let r = 0; r < 260; r++) Mg(i, 512, a() * 512, a() * 512, 0.8 + a() * 1.6, 0.5 + a() * 0.5, 0.2);
  for (let r = 0; r < 512; r++) for (let l = 0; l < 512; l++) {
    let c = r * 512 + l, h = l * 0.5, f = r * 0.5, u = (Be(yn, h + 30, f + 80) - 0.5) * 24, d = Be(Ga, h + u, f - u), m = S9(d * 1.2 - 0.1) * 1.999, p = m | 0, x = m - p, g = sD[p], b = sD[p + 1], v = Be(En, h + u * 0.5, f * 4 + 7) - 0.5, y = Be(qo, l, r * 2) - 0.5, M = i[c], w = 1 + v * 0.05 + y * 0.04 + M * 0.22, T = c << 2;
    e[T] = xe(g[0], b[0], x) * w, e[T + 1] = xe(g[1], b[1], x) * w, e[T + 2] = xe(g[2], b[2], x) * w, e[T + 3] = 255, n[c] = v * 0.05 + (Be(En, l + 5, r + 9) - 0.5) * 0.05 - M * 0.05, s[T] = 255, s[T + 1] = 255 * (0.07 + 0.07 * Be(yn, h + 111, f + 3) + M * 0.1), s[T + 2] = 255, s[T + 3] = 0;
  }
  return Wa({ W: 512, H: 512, alb: e, hgt: n, orm: s, tile: 0.32 });
}
function dj() {
  let e = Dn(262144), s = Dn(262144), n = new Float32Array(262144), i = new Float32Array(262144), a = oh(707);
  for (let r = 0; r < 420; r++) Mg(i, 512, a() * 512, a() * 512, 0.7 + a() * a() * 2.6, 0.4 + a() * 0.6, 0.3);
  for (let r = 0; r < 512; r++) for (let l = 0; l < 512; l++) {
    let c = r * 512 + l, h = l * 0.5, f = r * 0.5, u = Be(yn, h, f), d = Be(En, h + 31, f + 9), m = Be(qo, h, r * 2 + 5), p = ze(0.86, 0.95, Be(qo, l * 2 + 1, r * 2 + 3)), x = i[c], g = (0.86 + 0.2 * d + 0.1 * (m - 0.5)) * (1 - 0.45 * p) * (1 - 0.5 * x), b = c << 2;
    e[b] = xe(70, 84, u) * g, e[b + 1] = xe(58, 62, u) * g, e[b + 2] = xe(52, 49, u) * g, e[b + 3] = 255, n[c] = (d - 0.5) * 0.25 + (m - 0.5) * 0.1 - x * 0.7 + (Be(Ga, h + 70, f) - 0.5) * 1.2, s[b] = 255 * (1 - 0.5 * x), s[b + 1] = 255 * Math.min(1, 0.42 + 0.22 * d + 0.1 * u + x * 0.2), s[b + 2] = 255 * (1 - x), s[b + 3] = 0;
  }
  return Wa({ W: 512, H: 512, alb: e, hgt: n, orm: s, tile: 0.8 });
}
function pj() {
  let e = Dn(262144), s = Dn(262144), n = new Float32Array(262144), i = new Float32Array(262144), a = oh(808);
  for (let r = 0; r < 90; r++) Mg(i, 512, a() * 512, a() * 512, 0.6 + a() * 0.9, 0.5 + a() * 0.5, 0.2);
  for (let r = 0; r < 512; r++) for (let l = 0; l < 512; l++) {
    let c = r * 512 + l, h = l * 0.5, f = r * 0.5, u = Be(yn, h, f) - 0.5, d = Be(En, l + 3, r + 7) - 0.5, m = Be(qo, h + 9, f + 4) - 0.5, p = ze(0.66, 0.86, Be(Va, h + 40, f + 90)), x = p > 0 ? (1 - ze(0.01, 0.045, Be(T9, l * 2 + 5, r * 2 + 9))) * p : 0, g = i[c], b = 1 + u * 0.03 - x * 0.1 - g * 0.35, v = c << 2;
    e[v] = 232 * b, e[v + 1] = 229 * b, e[v + 2] = 222 * b * (1 - x * 0.06), e[v + 3] = 255, n[c] = d * 0.2 + m * 0.05 + u * 0.5 - g * 0.15 - x * 0.01, s[v] = 255 * (1 - 0.3 * g), s[v + 1] = 255 * (0.07 + 0.06 * (u + 0.5) + g * 0.3 + x * 0.06), s[v + 2] = 255, s[v + 3] = 0;
  }
  return Wa({ W: 512, H: 512, alb: e, hgt: n, orm: s, tile: 0.6 });
}
function mj() {
  let e = Dn(1048576), s = Dn(1048576), n = Dn(1048576), i = new Float32Array(1048576), a = new Float32Array(1048576), r = oh(909);
  for (let h = 0; h < 5; h++) nw(a, 1024, r, r() * 1024, r() * 1024, r() < 0.6 ? Math.PI / 2 + (r() - 0.5) * 0.7 : r() * Wo, 160 + r() * 300, 0.8, 6e-3);
  for (let h = 0; h < 1024; h++) {
    let f = h * 0.25, u = Oe(0, Ga, f), d = Oe(1, Va, f * 2 + 60), m = Oe(2, qo, h * 0.5 + 60);
    for (let p = 0; p < 1024; p++) {
      let x = h * 1024 + p, g = p * 0.25, b = Ne(u, g), v = Ne(d, g * 2 + 30), y = Be(En, (p + h) * 0.25, (h * 4 - p) * 0.25), M = Be(En, (p * 3 - h) * 0.25 + 90, (p + h * 2) * 0.25 + 17), w = y * 0.6 + M * 0.4, T = Ne(m, p * 0.5 + 5), S = ze(0.55, 0.8, Be(yn, (p * 2 + h) * 0.25 + 31, (h * 2 - p) * 0.25 + 7)), E = a[x] > 1 ? 1 : a[x];
      i[x] = (b - 0.5) * 8 + (v - 0.5) * 3.6 + (w - 0.5) * 1.7 + (T - 0.5) * 0.14;
      let _ = 0.95 + 0.06 * v + 0.05 * (w - 0.5) + 0.03 * (b - 0.5) + (T - 0.5) * 0.03 + S * 0.012, R = x << 2;
      e[R] = 226 * _, e[R + 1] = 214 * _, e[R + 2] = 197 * _, e[R + 3] = 255;
      let C = 0.82 + 0.26 * v + 0.2 * (w - 0.5) + 0.12 * S + (T - 0.5) * 0.08;
      s[R] = 56 * C, s[R + 1] = 54 * C, s[R + 2] = 55 * C, s[R + 3] = 255, n[R] = 255, n[R + 1] = 255 * (0.86 + 0.1 * (w - 0.5) - 0.13 * S + 0.04 * (T - 0.5)), n[R + 2] = 255, n[R + 3] = 255 * E;
    }
  }
  let l = Wa({ W: 1024, H: 1024, alb: e, hgt: i, orm: n, tile: 3 }), c = Wa({ W: 1024, H: 1024, alb: s, tile: 3 });
  return c.normalMap = l.normalMap, c.roughnessMap = l.roughnessMap, { light: l, dark: c };
}
function gj() {
  let s = Dn(1048576), n = Dn(1048576), i = new Float32Array(1048576), a = new Float32Array(1048576), r = new Float32Array(1048576), l = oh(1010);
  for (let c = 0; c < 1150; c++) {
    let h = l() < 0.03;
    Mg(a, 1024, l() * 1024, l() * 1024, h ? 2.2 + l() * 2.6 : 0.6 + l() * l() * 1.8, 0.5 + l() * 0.5, 0.45);
  }
  for (let c = 0; c < 4; c++) nw(r, 1024, l, l() * 1024, l() * 1024, l() * Wo, 150 + l() * 300, 0.8, 6e-3);
  for (let c = 0; c < 1024; c++) {
    let h = c >> 6, f = ((c & 63) + 0.5) / 64, u = Rn(h, 1, 71), d = Rn(h, 2, 72), m = Rn(h, 3, 73), p = c * 0.25, x = Math.min(f, 1 - f) * 64, g = 1 - ze(0, 1.5, x), b = ze(0.6, 1, Rn(c >> 8, 9, 74)) * (1 - ze(0, 26, Math.abs((c & 255) - 128))), v = Oe(0, En, f * 48 + d * 256), y = Oe(1, qo, f * 100 + u * 256), M = Oe(2, Ga, p), w = Oe(3, yn, p + 20), T = Oe(4, En, c * 0.5 + 7), S = Oe(5, Va, p), E = Oe(6, yn, p + 40), _ = Oe(7, En, 3);
    for (let R = 0; R < 1024; R++) {
      let C = c * 1024 + R, L = R * 0.25, A = Ne(v, L + u * 256) * 0.6 + Ne(y, L * 2 + d * 256) * 0.4, O = Ne(M, L) * 0.6 + Ne(w, L + 60) * 0.4, H = Ne(T, R * 0.5 + 3), F = ze(0.55, 0.9, Ne(S, L * 4)) * ze(0.3, 0.7, Ne(E, L + 99)), P = g * (0.4 + 0.6 * Ne(_, R * 0.5 + m * 256)), z = a[C], k = r[C] > 1 ? 1 : r[C], I = Gm(R - 256, 512) - 256, G = Gm(c - 128, 256) - 128, K = Math.sqrt(I * I + G * G), $ = 1 - ze(3.6, 5.4, K), n0 = 1 - ze(0, 5.4, K), e0 = (1 - ze(5.4, 9, K)) * (1 - $), p0 = 0.86 + 0.13 * O + 0.09 * (A - 0.5) + 0.07 * (H - 0.5) - 0.05 * F - 0.05 * P + (u - 0.5) * 0.06 - 0.04 * b;
      p0 *= (1 - 0.45 * z) * (1 - 0.6 * $) * (1 + 0.06 * e0);
      let t0 = C << 2;
      s[t0] = 153 * p0, s[t0 + 1] = 148 * p0, s[t0 + 2] = 139 * p0 * (1 - 0.03 * F), s[t0 + 3] = 255, i[C] = (A - 0.5) * 0.4 + (u - 0.5) * 0.9 + P * 0.8 - z * 2.4 - $ * 3 - n0 * 4 + (O - 0.5) * 1.6 + e0 * 0.2, n[t0] = 255 * (1 - 0.6 * z) * (1 - 0.75 * $) * (1 - 0.12 * g), n[t0 + 1] = 255 * Math.min(1, 0.76 + 0.14 * A + 0.06 * F + 0.06 * (H - 0.5)), n[t0 + 2] = 255 * (1 - z) * (1 - $), n[t0 + 3] = 255 * k;
    }
  }
  return Wa({ W: 1024, H: 1024, alb: s, hgt: i, orm: n, tile: 2.4 });
}
function xj() {
  let e = Dn(262144), s = Dn(262144), n = new Float32Array(262144);
  for (let i = 0; i < 512; i++) for (let a = 0; a < 512; a++) {
    let r = i * 512 + a, l = ze(0.72, 0.82, Be(qo, a * 0.5 + 17, i * 1.5 + 3)) * ze(0.35, 0.6, Be(En, a * 0.5, i * 0.5)), c = ze(0.8, 0.88, Be(qo, a * 1.5 + 40, i * 0.5 + 77)) * ze(0.5, 0.7, Be(En, a * 0.5 + 60, i * 0.5 + 20)) * 0.7, h = Rn(a, i, 81) > 0.985 ? 1 : 0, f = Math.min(1, l + c + h), u = Be(qo, a, i) - 0.5, d = Be(yn, a * 0.5 + 9, i * 0.5 + 5) - 0.5, m = 1 - 0.45 * f + u * 0.05 + d * 0.025, p = r << 2;
    e[p] = 226 * m, e[p + 1] = 223 * m, e[p + 2] = 215 * m, e[p + 3] = 255, n[r] = -f * 1.8 + u * 0.5, s[p] = 255 * (1 - 0.6 * f), s[p + 1] = 244, s[p + 2] = 255 * (1 - f), s[p + 3] = 0;
  }
  return Wa({ W: 512, H: 512, alb: e, hgt: n, orm: s, tile: 0.6 });
}
function bj() {
  let e = Dn(262144), s = Dn(262144), n = new Float32Array(262144);
  for (let i = 0; i < 512; i++) for (let a = 0; a < 512; a++) {
    let r = i * 512 + a, l = a * 0.5, c = i * 0.5, h = Be(En, l, i * 4 + 9) * 0.6 + Be(qo, l + 30, i * 4) * 0.4, f = Be(yn, l + 60, c + 14), u = Be(Ga, l, c + 90), d = Be(Ga, l + 120, c + 33) - 0.5, m = 0.9 + (h - 0.5) * 0.07 + (f - 0.5) * 0.14 + (u - 0.5) * 0.1, p = r << 2;
    e[p] = xe(96, 104, u) * m, e[p + 1] = xe(80, 78, u) * m, e[p + 2] = xe(62, 56, u) * m, e[p + 3] = 255, n[r] = d * 10 + (h - 0.5) * 0.3, s[p] = 255, s[p + 1] = 255 * (0.3 + 0.1 * h + 0.14 * f), s[p + 2] = 255, s[p + 3] = 0;
  }
  return Wa({ W: 512, H: 512, alb: e, hgt: n, orm: s, tile: 2.4 });
}
function yj() {
  let s = Dn(262144), n = Dn(262144), i = new Float32Array(262144), a = new Float32Array(262144), r = oh(1111);
  for (let h = 0; h < 7; h++) nw(a, 512, r, r() * 512, r() * 512, r() * Wo, 140 + r() * 260, 1, 6e-3);
  for (let h = 0; h < 2; h++) {
    let f = a.slice(), u = 511;
    for (let d = 0; d < 512; d++) for (let m = 0; m < 512; m++) {
      let p = (d - 1 & u) * 512, x = d * 512, g = (d + 1 & u) * 512, b = m - 1 & u, v = m + 1 & u;
      a[x + m] = (f[p + b] + f[p + m] * 2 + f[p + v] + f[x + b] * 2 + f[x + m] * 4 + f[x + v] * 2 + f[g + b] + f[g + m] * 2 + f[g + v]) / 16;
    }
  }
  let l = new Float32Array(104 * 104), c = new Float32Array(104 * 104);
  for (let h = 0; h < 104; h++) for (let f = 0; f < 104; f++) l[h * 104 + f] = f + 0.12 + 0.76 * Rn(f, h, 111), c[h * 104 + f] = h + 0.12 + 0.76 * Rn(f, h, 112);
  for (let h = 0; h < 512; h++) for (let f = 0; f < 512; f++) {
    let u = 1 + (Be(yn, f * 0.5, h * 0.5) - 0.5) * 0.5, d = (f + 0.5) / 512 * 104, m = (h + 0.5) / 512 * 104, p = Math.floor(d), x = Math.floor(m), g = 9, b = 9;
    for (let _ = -1; _ <= 1; _++) for (let R = -1; R <= 1; R++) {
      let C = p + R, L = x + _, A = Gm(C, 104), O = Gm(L, 104), H = O * 104 + A, F = l[H] + (C - A) - d, P = (c[H] + (L - O) - m) * u, z = Math.sqrt(F * F + P * P);
      z < g ? (b = g, g = z) : z < b && (b = z);
    }
    let v = h * 512 + f, y = ze(0.03, 0.34, b - g), M = Math.min(1, a[v] * 1.6), w = Be(yn, f * 0.5 + 40, h * 0.5 + 9), T = Rn(f, h, 113) - 0.5;
    i[v] = y * (0.11 - 0.04 * g) - M * 0.35 + T * 0.012 + (Be(Ga, f * 0.5, h * 0.5 + 30) - 0.5) * 0.5;
    let S = (0.76 + 0.24 * y) * (0.92 + 0.16 * w) * (1 - 0.2 * M) + T * 0.03, E = v << 2;
    s[E] = 255 * S, s[E + 1] = 255 * S * (0.985 + 0.015 * y), s[E + 2] = 255 * S * (0.96 + 0.04 * y), s[E + 3] = 255, n[E] = 255 * (0.62 + 0.38 * y) * (1 - 0.35 * M), n[E + 1] = 255 * (0.66 - 0.24 * y + 0.1 * Be(En, f * 0.5, h * 0.5) + M * 0.12), n[E + 2] = 255, n[E + 3] = 0;
  }
  return Wa({ W: 512, H: 512, alb: s, hgt: i, orm: n, tile: 0.16 });
}
function vj() {
  let s = Dn(65536), n = Dn(65536), i = new Float32Array(65536);
  for (let a = 0; a < 256; a++) for (let r = 0; r < 256; r++) {
    let l = r >> 3, c = a >> 3, h = ((r & 7) + 0.5) / 8, f = ((a & 7) + 0.5) / 8, u = a * 256 + r, d = Math.sin(Math.PI * h), m = Math.sin(Math.PI * f), p = 0.75 + 0.5 * Rn(l, 0, 121) * Be(yn, l * 9, a), x = 0.75 + 0.5 * Rn(0, c, 122) * Be(yn, r, c * 9), g = (l + c & 1) === 0, b = g ? d * (0.55 + 0.45 * m) * p : m * (0.55 + 0.45 * d) * x, v = 0.5 + 0.5 * Math.sin((g ? a + r * 0.6 : r + a * 0.6) * 2.4), y = Rn(r, a, 123) - 0.5;
    i[u] = b * 0.3 + v * 0.03 * b + y * 0.03;
    let M = 1 + (Rn(g ? l : 7, g ? 9 : c, 124) - 0.5) * 0.14, w = (0.6 + 0.4 * ze(0.05, 0.75, b)) * M * (0.95 + 0.07 * v) + y * 0.04, T = u << 2;
    s[T] = 255 * w, s[T + 1] = 255 * w, s[T + 2] = 255 * w, s[T + 3] = 255, n[T] = 255 * (0.55 + 0.45 * ze(0.05, 0.7, b)), n[T + 1] = 255 * (0.98 - 0.08 * b), n[T + 2] = 255, n[T + 3] = 0;
  }
  return Wa({ W: 256, H: 256, alb: s, hgt: i, orm: n, tile: 0.1, gain: 0.9 });
}
function Mj() {
  let e = Dn(262144), s = new Float32Array(262144);
  for (let n = 0; n < 512; n++) for (let i = 0; i < 512; i++) {
    let a = n * 512 + i, r = i * 0.5, l = n * 0.5, c = (Be(Ga, r + 9, l + 70) - 0.5) * 50, h = Be(yn, r + c, l * 2 - c) * 0.6 + Be(En, r * 2 + c, l + 31) * 0.4, f = Be(Va, r + 100, l + 3), d = 0.78 + 0.34 * (ze(0.3, 0.85, h) * 0.36 + (f - 0.5) * 0.24) + (Be(qo, i, n) - 0.5) * 0.06, m = a << 2;
    e[m] = 255 * Math.min(1, d), e[m + 1] = 255 * Math.min(1, d * 1.01), e[m + 2] = 255 * Math.min(1, d * 1.02), e[m + 3] = 255, s[a] = h * 2.2 + f * 1.5 + (Be(qo, i * 2, n * 2) - 0.5) * 0.25;
  }
  return Wa({ W: 512, H: 512, alb: e, hgt: s, tile: 0.6 });
}
function wj() {
  let e = Dn(65536), s = new Float32Array(65536);
  for (let n = 0; n < 256; n++) for (let i = 0; i < 256; i++) {
    let a = n * 256 + i, r = Be(En, i + 77, n) * 0.6 + Be(qo, i, n + 77) * 0.4, l = Be(T9, i * 2, n * 2), c = Rn(i, n, 131), h = Rn(i >> 1, n >> 1, 132) > 0.985 ? 1 : 0, f = ze(0.8, 0.9, Be(qo, i * 2 + 9, n + 3));
    s[a] = r * 5 + ze(0, 0.3, l) * 2 + c * 0.8 + h * 1.5;
    let u = (0.62 + 0.55 * r) * (0.75 + 0.25 * ze(0, 0.25, l)) + (c - 0.5) * 0.12, d = a << 2;
    e[d] = 255 * Math.min(1, u * (1 + 0.5 * f) + h * 0.8), e[d + 1] = 255 * Math.min(1, u * (1 + 0.25 * f) + h * 0.8), e[d + 2] = 255 * Math.min(1, u + h * 0.75), e[d + 3] = 255;
  }
  return Wa({ W: 256, H: 256, alb: e, hgt: s, tile: 0.5, gain: 0.6 });
}
function Ej() {
  let e = Dn(65536), s = new Float32Array(65536);
  for (let n = 0; n < 256; n++) for (let i = 0; i < 256; i++) {
    let a = n * 256 + i, r = Rn(i, n, 141), l = Be(qo, i * 2, n * 2), c = Be(En, i * 2 + 9, n * 2 + 40), h = a << 2;
    s[a] = r * 0.02 + l * 0.03 + c * 0.05, e[h] = 255, e[h + 1] = 255 * (0.82 + 0.18 * (0.5 * r + 0.5 * l)), e[h + 2] = 255, e[h + 3] = 0;
  }
  return Wa({ W: 256, H: 256, hgt: s, orm: e, tile: 0.12 });
}
function Tj() {
  let s = Dn(65536), n = Dn(65536), i = new Float32Array(65536);
  for (let r = 0; r < 256; r++) for (let l = 0; l < 256; l++) {
    let c = l >> 2, h = r >> 2, f = ((l & 3) + 0.5) / 4, u = ((r & 3) + 0.5) / 4, d = r * 256 + l, m = Math.sin(Math.PI * f), p = Math.sin(Math.PI * u), x = 0.82 + 0.3 * Rn(c, 1, 151) * Be(yn, c * 7, r), g = 0.82 + 0.3 * Rn(2, h, 152) * Be(yn, l, h * 7), b = Math.min(1, Math.max(m * x, p * g)), v = ze(0.86, 0.97, Rn(c, 5, 153)) * ze(0.45, 0.75, Be(En, c * 3, r)) + ze(0.88, 0.98, Rn(6, h, 154)) * ze(0.45, 0.75, Be(En, l, h * 3)), y = Be(yn, l, r) - 0.5;
    i[d] = (c + h & 1 ? p * (0.5 + 0.5 * m) * g : m * (0.5 + 0.5 * p) * x) * 0.18;
    let M = Math.min(1, (1 - 0.26 * b) * (1 - 0.1 * Math.min(1, v)) * (1 + y * 0.06)), w = 0.72 + 0.28 * b, T = d << 2;
    n[T] = 255 * M, n[T + 1] = 255 * M * (0.9 + 0.1 * (1 - b)), n[T + 2] = 255 * M * (0.8 + 0.2 * (1 - b)), n[T + 3] = 255, s[T] = 255 * w, s[T + 1] = 255 * w, s[T + 2] = 255 * w, s[T + 3] = 255;
  }
  let a = Wa({ W: 256, H: 256, alb: s, hgt: i, tile: 0.06 });
  return a.emissiveMap = Dd(n, 256, 256, true, a.tile), a;
}
var JM = (o2) => (o2 -= Math.floor(o2), o2 = o2 < 0.5 ? o2 * 2 : 2 - o2 * 2, o2 * o2 * (3 - 2 * o2)), tw = [[0, 122, 40, 6], [0.38, 196, 88, 15], [0.72, 236, 142, 42], [1, 255, 196, 104]];
function Sj() {
  let e = Dn(1048576), s = Dn(1048576), n = new Float32Array(1048576);
  for (let i = 0; i < 1024; i++) {
    let a = i / 1024, r = i * 0.25, l = Oe(0, Ga, r), c = Oe(1, Va, r + 90), h = Oe(2, yn, r), f = Oe(3, En, r * 2 + 9), u = Oe(4, Va, r + 20), d = Oe(5, En, r), m = Oe(6, Va, r * 2 + 33), p = Oe(7, En, r + 20), x = Oe(8, E9, i * 2 + 3), g = Oe(9, qo, i);
    for (let b = 0; b < 1024; b++) {
      let v = b / 1024, y = b * 0.25, M = i * 1024 + b, w = Ne(l, y), T = Ne(c, y + 50), S = Ne(h, y), E = Ne(f, y * 2 + 21), _ = 2 * v + a + (w - 0.5) * 1.15 + (T - 0.5) * 0.45 + (E - 0.5) * 0.03, R = JM(_), C = JM(_ * 4 + S * 0.56), L = JM(_ * 13 + T * 1.43), A = JM(_ * 47 + E * 0.8), O = 0.48 * R + 0.2 * C + 0.07 * L + 0.035 * A + 0.215 * S;
      O = ze(0.08, 0.95, O);
      let H = 0;
      for (; H < tw.length - 2 && O > tw[H + 1][0]; ) H++;
      let F = tw[H], P = tw[H + 1], z = (O - F[0]) / (P[0] - F[0]), k = xe(F[1], P[1], z), I = xe(F[2], P[2], z), G = xe(F[3], P[3], z), K = ze(0.55, 0.9, Ne(u, y + 170)) * (0.4 + 0.6 * Ne(d, y + w * 60)) * 0.6;
      k = xe(k, 255, K * 0.75), I = xe(I, 214, K * 0.75), G = xe(G, 150, K * 0.75);
      let $ = (1 - ze(3e-3, 0.012, Math.abs(Be(yn, y * 2 + w * 50, r * 2 + T * 50) - 0.5))) * ze(0.5, 0.8, T) * 0.55;
      k = xe(k, 255, $), I = xe(I, 234, $), G = xe(G, 194, $);
      let n0 = (1 - ze(2e-3, 0.012, Math.abs(Be(Va, y * 2 + S * 40 + 9, r * 2 + w * 40 + 70) - 0.47))) * ze(0.45, 0.75, S) * 0.6;
      k = xe(k, 150, n0), I = xe(I, 44, n0), G = xe(G, 12, n0);
      let e0 = ze(0.5, 0.8, Ne(m, y * 2 + 240)), p0 = 3 * v - 2 * a + (T - 0.5) * 1.3 + (S - 0.5) * 0.6 + (E - 0.5) * 0.1, t0 = (1 - ze(1e-3, 6e-3, Math.abs(p0 - Math.floor(p0) - 0.5))) * e0 * 0.5;
      k = xe(k, 255, t0), I = xe(I, 224, t0), G = xe(G, 170, t0);
      let M0 = ze(0.76, 0.94, Ne(p, y + 140)) * ze(0.4, 0.7, w) * 0.4;
      k *= 1 - M0 * 0.6, I *= 1 - M0 * 0.8, G *= 1 - M0;
      let f0 = 1 + (Ne(x, b * 2 + 5) - 0.5) * 0.09 + (Ne(g, b) - 0.5) * 0.05, _0 = M << 2;
      e[_0] = k * f0, e[_0 + 1] = I * f0, e[_0 + 2] = G * f0, e[_0 + 3] = 255, n[M] = (w - 0.5) * 3 + (S - 0.5) * 1 - n0 * 0.06 - t0 * 0.04 + (A - 0.5) * 0.012, s[_0] = 255, s[_0 + 1] = 255 * (0.1 + 0.07 * E + n0 * 0.1 + M0 * 0.2), s[_0 + 2] = 255 * S9(1 - M0 * 1.6 - n0 * 0.7 + K * 0.2), s[_0 + 3] = 0;
    }
  }
  return Wa({ W: 1024, H: 1024, alb: e, hgt: n, orm: s, tile: 2 });
}
function R9(o2, { srgb: t = true } = {}) {
  const e = o2 && o2.__isNodeCanvas
    ? new THREE.DataTexture(new Uint8Array(o2.__data.buffer), o2.width, o2.height, THREE.RGBAFormat, THREE.UnsignedByteType)
    : new THREE.CanvasTexture(o2);
  if (t) e.colorSpace = THREE.SRGBColorSpace;
  e.anisotropy = _9;
  e.generateMipmaps = true;
  e.magFilter = THREE.LinearFilter;
  e.minFilter = THREE.LinearMipmapLinearFilter;
  e.needsUpdate = true;
  return e;
}
function _j(o2, t, e = 0.4) {
  let s = o2.width, n = o2.height, i = o2.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, s, n).data, a = new Float32Array(s * n), r = 256 / s;
  for (let u = 0, d = 0, m = 0; u < n; u++) for (let p = 0; p < s; p++, d++, m += 4) {
    let x = i[m], g = i[m + 1], b = i[m + 2], v = x > g ? x > b ? x : b : g > b ? g : b, y = x < g ? x < b ? x : b : g < b ? g : b, M = (x * 0.3 + g * 0.59 + b * 0.11) * 63e-4 + (v - y) * 55e-4, w = (Be(qo, p * r * 4 + M * 25, u * r * 1.5) - 0.5) * (0.5 + M);
    a[d] = M + w * 0.9 + ((p >> 1) + (u >> 1) & 1) * e * (1.3 - Math.min(1, M * 0.6)) + Rn(p, u, 151) * 0.1;
  }
  let l = Dn(s * n), c = Dn(s * n), h = t * 0.5;
  for (let u = 0; u < n; u++) {
    let d = Math.max(0, u - 1) * s, m = Math.min(n - 1, u + 1) * s, p = (n - 1 - u) * s;
    for (let x = 0; x < s; x++) {
      let g = Math.max(0, x - 1), b = Math.min(s - 1, x + 1), v = u * s + x, y = -(a[u * s + b] - a[u * s + g]) * h, M = (a[m + x] - a[d + x]) * h, w = 1 / Math.sqrt(y * y + M * M + 1), T = p + x << 2;
      l[T] = (y * w * 0.5 + 0.5) * 255, l[T + 1] = (M * w * 0.5 + 0.5) * 255, l[T + 2] = (w * 0.5 + 0.5) * 255, l[T + 3] = 255, c[T] = 255, c[T + 1] = 255 * (0.8 - 0.4 * S9(a[v] * 0.3)), c[T + 2] = 255, c[T + 3] = 255;
    }
  }
  let f = (u) => {
    let d = Dd(u, s, n, false, [1, 1]);
    return d.wrapS = d.wrapT = THREE.ClampToEdgeWrapping, d;
  };
  return { normalMap: f(l), roughnessMap: f(c) };
}
var ac = { cream: "#e9dfc8", bone: "#d8ccb0", teal: "#1f5f66", deepTeal: "#123a40", rust: "#a8502a", ember: "#c96b2c", gold: "#c39a4a", charcoal: "#26272a", ink: "#1c1e22", sand: "#cdb48a" };
function ew(o2, t, e, s, n) {
  let i = o2.getImageData(0, 0, t, e), a = i.data, r = 512 / t;
  for (let l = 0, c = 0; l < t * e; l++, c += 4) {
    let h = l % t * r, f = (l / t | 0) * r, u = 1 + (Rn(l % t, l / t | 0, s) - 0.5) * n + (Be(En, h * 0.7, f * 0.7) - 0.5) * n * 1.4 + (Be(Ga, h * 0.33, f * 0.33) - 0.5) * n;
    a[c] *= u, a[c + 1] *= u, a[c + 2] *= u;
  }
  o2.putImageData(i, 0, 0);
}
function lu(o2, t, e, s, n, i, a, r, l, c, h = 0.9, f = 24, u = 0.9) {
  let d = Math.max(5, Math.floor(l * u));
  o2.lineCap = "round";
  for (let m = 0; m < d; m++) {
    let p = (m / (d - 1) - 0.5) * l, x = t(), g = -(r - s), b = a - e, v = Math.hypot(g, b) || 1, y = g / v * p, M = b / v * p;
    o2.strokeStyle = c, o2.globalAlpha = h * (0.35 + 0.65 * t()), o2.lineWidth = 0.8 + t() * 2.2;
    let w = t() * 0.08, T = 1 - x * x * 0.45;
    o2.beginPath();
    for (let S = 0; S <= f; S++) {
      let E = w + (T - w) * (S / f), _ = 1 - E, R = _ * _ * e + 2 * _ * E * n + E * E * a + y + (t() - 0.5) * 1.2, C = _ * _ * s + 2 * _ * E * i + E * E * r + M + (t() - 0.5) * 1.2;
      S === 0 ? o2.moveTo(R, C) : o2.lineTo(R, C);
    }
    o2.stroke();
  }
  o2.globalAlpha = 1;
}
function vg(o2, t, e, s, n, i, a, r = 3) {
  o2.save(), o2.shadowColor = i, o2.shadowBlur = a, o2.fillStyle = i;
  for (let l = 0; l < r; l++) o2.fillRect(t, e, s, n);
  o2.restore();
}
function Ld(o2, t, e, s, n, i, a, r, l, c, h) {
  for (let f = 0; f < r; f++) {
    let u = e + t() * n, d = s + t() * i, m = (t() - 0.5) * 1.2 + (t() < 0.2 ? 1.57 : 0), p = l * (0.4 + t());
    lu(o2, t, u, d, u + Math.cos(m) * p * 0.5 + (t() - 0.5) * 8, d + Math.sin(m) * p * 0.5 + (t() - 0.5) * 8, u + Math.cos(m) * p, d + Math.sin(m) * p, c * (0.5 + t()), a[t() * a.length | 0], h * 1.5, 5, 0.3);
  }
}
function sw(o2) {
  let e = we(640), s = e.getContext("2d", { willReadFrequently: true }), n = oh(900 + o2 * 77);
  if (o2 === 0) {
    s.fillStyle = ac.cream, s.fillRect(0, 0, 640, 640), Ld(s, n, 0, 0, 640, 640, ["#efe6d2", "#e2d6bb", "#dccfb2"], 60, 90, 30, 0.16), s.fillStyle = ac.deepTeal, s.beginPath(), s.arc(640 * 0.36, 640 * 0.6, 640 * 0.3, Math.PI, Wo), s.fill(), s.fillStyle = ac.rust, s.beginPath(), s.arc(640 * 0.36, 640 * 0.6, 640 * 0.3, 0, Math.PI), s.fill(), s.fillStyle = ac.gold, s.beginPath(), s.arc(640 * 0.68, 640 * 0.3, 640 * 0.13, 0, Wo), s.fill(), s.fillStyle = ac.charcoal, s.fillRect(640 * 0.6, 640 * 0.5, 640 * 0.08, 640 * 0.38), s.fillStyle = ac.teal, s.fillRect(640 * 0.72, 640 * 0.62, 640 * 0.16, 640 * 0.26), s.fillStyle = ac.sand, s.beginPath(), s.arc(640 * 0.36, 640 * 0.6, 640 * 0.13, 0, Wo), s.fill(), s.save(), s.beginPath(), s.arc(640 * 0.36, 640 * 0.6, 640 * 0.3, Math.PI, Wo), s.clip(), Ld(s, n, 640 * 0.06, 640 * 0.3, 640 * 0.6, 640 * 0.3, ["#1a4f57", "#0e3036", "#22606a"], 30, 110, 26, 0.3), s.restore(), s.save(), s.beginPath(), s.arc(640 * 0.36, 640 * 0.6, 640 * 0.3, 0, Math.PI), s.clip(), Ld(s, n, 640 * 0.06, 640 * 0.6, 640 * 0.6, 640 * 0.3, ["#b85a2e", "#974424", "#c56a36"], 30, 110, 26, 0.3), s.restore(), s.save(), s.beginPath(), s.arc(640 * 0.68, 640 * 0.3, 640 * 0.13, 0, Wo), s.clip(), Ld(s, n, 640 * 0.55, 640 * 0.17, 640 * 0.26, 640 * 0.26, ["#d2aa58", "#b48a3c", "#e0bd72"], 16, 60, 16, 0.35), s.restore(), s.strokeStyle = ac.ink, s.lineWidth = 3.5, s.beginPath(), s.moveTo(640 * 0.08, 640 * 0.6), s.lineTo(640 * 0.94, 640 * 0.6), s.stroke(), s.beginPath(), s.arc(640 * 0.68, 640 * 0.3, 640 * 0.2, Math.PI * 0.9, Math.PI * 1.9), s.stroke(), s.lineWidth = 2.4;
    for (let i = 0; i < 5; i++) s.beginPath(), s.moveTo(640 * 0.1, 640 * (0.14 + i * 0.03)), s.lineTo(640 * 0.36, 640 * (0.14 + i * 0.03)), s.stroke();
    ew(s, 640, 640, 201, 0.1);
  } else if (o2 === 1) {
    s.fillStyle = "#242224", s.fillRect(0, 0, 640, 640), Ld(s, n, 0, 0, 640, 640, ["#2c292a", "#1e1c1e", "#33302f"], 40, 120, 34, 0.25), vg(s, 640 * 0.13, 640 * 0.1, 640 * 0.74, 640 * 0.4, "#b4532a", 56, 4), vg(s, 640 * 0.16, 640 * 0.13, 640 * 0.68, 640 * 0.3, "#cf6e2e", 72, 2), vg(s, 640 * 0.13, 640 * 0.58, 640 * 0.74, 640 * 0.3, "#174a52", 56, 4), vg(s, 640 * 0.18, 640 * 0.62, 640 * 0.64, 640 * 0.2, "#1f6068", 72, 2), vg(s, 640 * 0.13, 640 * 0.525, 640 * 0.74, 640 * 0.012, "#c8a257", 16, 2), Ld(s, n, 640 * 0.12, 640 * 0.1, 640 * 0.76, 640 * 0.4, ["#d67a36", "#a94a24", "#e08a44", "#8f3c1e"], 50, 150, 30, 0.12), Ld(s, n, 640 * 0.12, 640 * 0.58, 640 * 0.76, 640 * 0.3, ["#256e76", "#123e45", "#2d7c82"], 40, 150, 30, 0.12);
    for (let i = 0; i < 40; i++) lu(s, n, 640 * 0.12, 640 * (0.1 + n() * 0.8), 640 * 0.5, 640 * (0.1 + n() * 0.8), 640 * 0.88, 640 * (0.1 + n() * 0.8), 10, i % 3 ? "#000000" : "#e8c9a0", 0.05, 12);
    ew(s, 640, 640, 202, 0.16);
  } else if (o2 === 2) {
    s.fillStyle = ac.bone, s.fillRect(0, 0, 640, 640), Ld(s, n, 0, 0, 640, 640, ["#e0d5ba", "#cfc2a4", "#d4c8ac"], 50, 100, 32, 0.2), vg(s, 640 * 0.1, 640 * 0.55, 640 * 0.5, 640 * 0.3, "#cdbf9f", 96, 2), lu(s, n, 640 * 0.08, 640 * 0.72, 640 * 0.4, 640 * 0.1, 640 * 0.9, 640 * 0.36, 144, ac.ink, 0.9), lu(s, n, 640 * 0.2, 640 * 0.9, 640 * 0.7, 640 * 0.75, 640 * 0.86, 640 * 0.5, 84, ac.teal, 0.85), lu(s, n, 640 * 0.14, 640 * 0.3, 640 * 0.5, 640 * 0.55, 640 * 0.92, 640 * 0.2, 52, ac.gold, 0.9), lu(s, n, 640 * 0.55, 640 * 0.92, 640 * 0.62, 640 * 0.6, 640 * 0.5, 640 * 0.4, 32, ac.rust, 0.9), lu(s, n, 640 * 0.1, 640 * 0.16, 640 * 0.3, 640 * 0.1, 640 * 0.46, 640 * 0.2, 18, "#f1e8d2", 0.8);
    for (let i = 0; i < 56; i++) {
      let a = n() * Wo, r = Math.pow(n(), 2) * 640 * 0.33;
      s.fillStyle = i % 4 ? ac.ink : ac.gold, s.globalAlpha = 0.85, s.beginPath(), s.arc(640 * 0.56 + Math.cos(a) * r, 640 * 0.4 + Math.sin(a) * r, 1 + n() * n() * 11, 0, Wo), s.fill();
    }
    s.globalAlpha = 1, ew(s, 640, 640, 203, 0.09);
  } else {
    let i = ["#16282d", "#1c3d44", "#22575c", "#6a4a38", "#a5552c", "#cf7b33", "#d9a257", "#e6cf9c", "#ece2c8"];
    s.fillStyle = i[i.length - 1], s.fillRect(0, 0, 640, 640);
    for (let a = i.length - 2; a >= 0; a--) {
      let r = 640 * (0.2 + (i.length - 2 - a) * 0.092), l = 640 * (0.012 + n() * 0.03), c = n() * Wo, h = 1 + n() * 2.2, f = (u) => r + Math.sin(u / 640 * Wo * h + c) * l + Math.sin(u / 640 * Wo * h * 2.7 + c * 2) * l * 0.35;
      s.fillStyle = i[a], s.beginPath(), s.moveTo(0, 640);
      for (let u = 0; u <= 640; u += 8) s.lineTo(u, f(u));
      s.lineTo(640, 640), s.closePath(), s.fill();
      for (let u = 0; u < 12; u++) {
        let d = n() * 640, m = 40 + n() * 120, p = f(d) + 4 + n() * 22;
        lu(s, n, d, p, d + m * 0.5, p + (n() - 0.5) * 6, d + m, f(d + m) + 4 + n() * 22, 8 + n() * 12, i[a + 1], 0.3, 6, 0.4);
      }
      if (a % 2 === 0) {
        s.strokeStyle = "#d7b46a", s.lineWidth = 1.9, s.globalAlpha = 0.8, s.beginPath();
        for (let u = 0; u <= 640; u += 8) {
          let d = f(u) + 5;
          u === 0 ? s.moveTo(u, d) : s.lineTo(u, d);
        }
        s.stroke(), s.globalAlpha = 1;
      }
    }
    s.fillStyle = "#f0c36a", s.beginPath(), s.arc(640 * 0.7, 640 * 0.2, 640 * 0.07, 0, Wo), s.fill();
    for (let a = 0; a < 30; a++) lu(s, n, 0, 640 * n(), 640 * 0.5, 640 * n(), 640, 640 * n(), 14, a % 2 ? "#000000" : "#fff2d0", 0.04, 12);
    ew(s, 640, 640, 204, 0.12);
  }
  return { map: R9(e), ..._j(e, o2 === 2 ? 2.4 : 1.7, o2 === 1 ? 0.55 : 0.4) };
}
function Rj() {
  let e = we(1280, 720), s = e.getContext("2d"), n = oh(1717), i = 1280 / 1024, a = s.createLinearGradient(0, 0, 0, 720);
  a.addColorStop(0, "#0a1a2a"), a.addColorStop(0.42, "#23344a"), a.addColorStop(0.62, "#8a4a36"), a.addColorStop(0.72, "#e08a3c"), a.addColorStop(0.78, "#f6c070"), a.addColorStop(1, "#2a1a14"), s.fillStyle = a, s.fillRect(0, 0, 1280, 720);
  let r = 1280 * 0.74, l = 720 * 0.7, c = s.createRadialGradient(r, l, 8, r, l, 420 * i);
  c.addColorStop(0, "rgba(255,214,150,0.95)"), c.addColorStop(0.2, "rgba(255,160,80,0.5)"), c.addColorStop(1, "rgba(240,110,40,0)"), s.fillStyle = c, s.fillRect(0, 0, 1280, 720), s.fillStyle = "#fff0cc", s.beginPath(), s.arc(r, l, 34 * i, 0, Wo), s.fill();
  for (let g = 0; g < 26; g++) {
    let b = 720 * (0.2 + n() * 0.45), v = n() * 1280, y = (120 + n() * 380) * i, M = s.createLinearGradient(v, 0, v + y, 0), w = b > 720 * 0.5 ? "255,170,110" : "150,150,190";
    M.addColorStop(0, `rgba(${w},0)`), M.addColorStop(0.5, `rgba(${w},${0.1 + n() * 0.16})`), M.addColorStop(1, `rgba(${w},0)`), s.fillStyle = M, s.fillRect(v, b, y, (2 + n() * 7) * i);
  }
  for (let g = 0; g < 2; g++) {
    let b = -20;
    for (; b < 1280; ) {
      let v = (26 + n() * 60) * i, y = 720 * (g ? 0.1 + n() * 0.2 : 0.06 + n() * 0.13), M = 720 * 0.79 - y;
      if (s.fillStyle = g ? "#0c1118" : "#3a2c33", s.fillRect(b, M, v, y + 720 * 0.03), g) for (let w = M + 6; w < 720 * 0.78; w += 7 * i) for (let T = b + 4; T < b + v - 4; T += 6 * i) n() < 0.24 && (s.fillStyle = n() < 0.8 ? "rgba(255,196,120,0.85)" : "rgba(190,220,255,0.8)", s.fillRect(T, w, 2.6 * i, 3.2 * i));
      b += v + n() * 8 * i;
    }
  }
  let h = s.createLinearGradient(0, 720 * 0.8, 0, 720);
  h.addColorStop(0, "#c9783a"), h.addColorStop(0.25, "#3c4a5a"), h.addColorStop(1, "#0a1620"), s.fillStyle = h, s.fillRect(0, 720 * 0.81, 1280, 720 * 0.19);
  for (let g = 0; g < 40; g++) {
    s.fillStyle = `rgba(255,200,130,${0.05 + n() * 0.2})`;
    let b = 720 * (0.82 + n() * 0.17);
    s.fillRect(r - (60 + n() * 240) * i * (b / 720 - 0.78) * 4, b, (40 + n() * 200) * i, 1.6 * i);
  }
  let f = s.createLinearGradient(0, 0, 1280 * 0.62, 0);
  f.addColorStop(0, "rgba(6,14,22,0.82)"), f.addColorStop(0.7, "rgba(6,14,22,0.5)"), f.addColorStop(1, "rgba(6,14,22,0)"), s.fillStyle = f, s.fillRect(0, 0, 1280 * 0.62, 720);
  let u = 'Bahnschrift, "Segoe UI", "Helvetica Neue", Arial, sans-serif', d = (g) => Math.round(g * i);
  s.textBaseline = "alphabetic", s.strokeStyle = "#e9c98a", s.lineWidth = 2 * i, s.beginPath(), s.arc(d(88), d(84), d(22), Math.PI, Wo), s.stroke(), s.beginPath(), s.moveTo(d(56), d(84)), s.lineTo(d(120), d(84)), s.stroke();
  for (let g = 0; g < 5; g++) {
    let b = Math.PI + (g + 1) / 6 * Math.PI;
    s.beginPath(), s.moveTo(d(88) + Math.cos(b) * d(27), d(84) + Math.sin(b) * d(27)), s.lineTo(d(88) + Math.cos(b) * d(35), d(84) + Math.sin(b) * d(35)), s.stroke();
  }
  s.fillStyle = "#e9c98a", s.font = `500 ${d(20)}px ${u}`, s.fillText("W E L C O M E   T O", d(64), d(156)), s.fillStyle = "#ffffff", s.font = `300 ${d(84)}px ${u}`, s.fillText("HALCYON", d(58), d(240)), s.fillStyle = "#e9c98a", s.font = `400 ${d(24)}px ${u}`, s.fillText("F R O N T I E R   H A B I T A T", d(64), d(280)), s.fillStyle = "rgba(233,201,138,0.7)", s.fillRect(d(64), d(304), d(300), Math.max(1, d(1.5))), s.fillStyle = "rgba(255,255,255,0.9)", s.font = `400 ${d(23)}px ${u}`, s.fillText("Bay 04  \xB7  Deck 02", d(64), d(346)), s.fillStyle = "rgba(255,255,255,0.62)", s.font = `400 ${d(18)}px ${u}`, s.fillText("Local 19:58   \xB7   1.01 atm   \xB7   Airlock seal nominal", d(64), d(378));
  let m = ["ROOM SERVICE", "SPA", "CONCIERGE", "SKY BAR", "CHECK-OUT"], p = ["\u25D4", "\u274B", "\u260E", "\u266A", "\u2794"];
  for (let g = 0; g < m.length; g++) {
    let b = d(64 + g * 184), v = d(452), y = d(170), M = d(84);
    s.fillStyle = g === 3 ? "rgba(233,150,70,0.94)" : "rgba(14,26,36,0.62)", s.fillRect(b, v, y, M), s.strokeStyle = g === 3 ? "rgba(255,230,190,0.9)" : "rgba(255,255,255,0.26)", s.lineWidth = Math.max(1, 1.5 * i), s.strokeRect(b + 0.5, v + 0.5, y - 1, M - 1), s.fillStyle = g === 3 ? "#1a1008" : "#e9c98a", s.font = `400 ${d(22)}px "Segoe UI Symbol", ${u}`, s.fillText(p[g], b + d(14), v + d(34)), s.fillStyle = g === 3 ? "#1a1008" : "#ffffff", s.font = `600 ${d(16)}px ${u}`, s.fillText(m[g], b + d(14), v + d(64));
  }
  s.fillStyle = "rgba(255,255,255,0.5)", s.font = `400 ${d(14)}px ${u}`, s.fillText("\u25C0 \u25B6  Navigate      OK  Select      \u2302  Home", d(64), d(566)), s.fillStyle = "rgba(255,255,255,0.86)", s.font = `300 ${d(46)}px ${u}`, s.textAlign = "right", s.fillText("19:42", 1280 - d(60), d(96)), s.fillStyle = "rgba(255,255,255,0.6)", s.font = `400 ${d(16)}px ${u}`, s.fillText("FRI 14 JUNE", 1280 - d(62), d(122)), s.textAlign = "left";
  let x = s.createRadialGradient(1280 / 2, 720 / 2, 720 * 0.3, 1280 / 2, 720 / 2, 1280 * 0.7);
  return x.addColorStop(0, "rgba(0,0,0,0)"), x.addColorStop(1, "rgba(0,0,0,0.28)"), s.fillStyle = x, s.fillRect(0, 0, 1280, 720), R9(e);
}
function makeNodeTexSet(seed, rgb, rough, tile, opts = {}) {
  const S = 32;
  const alb = Dn(S * S);
  const orm = Dn(S * S);
  const hgt = new Float32Array(S * S);
  const rng = oh(seed);
  for (let i = 0; i < S * S; i++) {
    const n = (rng() - 0.5) * 0.16;
    const p = i * 4;
    alb[p] = Math.max(0, Math.min(255, Math.round(rgb[0] * (1 + n))));
    alb[p + 1] = Math.max(0, Math.min(255, Math.round(rgb[1] * (1 + n))));
    alb[p + 2] = Math.max(0, Math.min(255, Math.round(rgb[2] * (1 + n))));
    alb[p + 3] = 255;
    hgt[i] = n * 2;
    orm[p] = 255;
    orm[p + 1] = Math.max(0, Math.min(255, Math.round((rough + n * 0.25) * 255)));
    orm[p + 2] = 255;
    orm[p + 3] = 0;
  }
  const set = Wa({
    W: S,
    H: S,
    alb: opts.noAlb ? null : alb,
    hgt,
    orm: opts.noOrm ? null : orm,
    tile,
  });
  if (opts.emissive) {
    const tArr = Array.isArray(tile) ? tile : [tile, tile];
    set.emissiveMap = Dd(alb, S, S, true, tArr);
  }
  return set;
}
function makeNodeDetailTex(seed, tile) {
  const S = 32;
  const h = new Float32Array(S * S);
  const r = new Float32Array(S * S);
  const a = new Float32Array(S * S);
  const rng = oh(seed);
  for (let i = 0; i < S * S; i++) {
    h[i] = (rng() - 0.5) * 0.8;
    r[i] = (rng() - 0.5) * 0.4;
    a[i] = (rng() - 0.5) * 0.3;
  }
  return Mb(S, h, r, a, 0.8, tile);
}
function iD(o2 = 8) {
  if (typeof document === 'undefined' || !globalThis.HABITAT_FULL_TEX) {
    _9 = o2;
    Ga = yb(11, 3, 2);
    yn = yb(23, 6, 3);
    En = yb(37, 16, 4);
    qo = yb(53, 48, 2);
    Va = yb(71, 5, 4);
    [E9, T9] = ZY(5, 16);
    const macroBuf = Dn(32 * 32);
    const mrng = oh(99);
    for (let i = 0; i < 32 * 32 * 4; i++) macroBuf[i] = Math.round(96 + mrng() * 64);
    return {
      timings: {},
      flat: w9(128, 128, 255, 255, false),
      white: w9(255, 255, 255, 255, true),
      ormWhite: w9(255, 255, 255, 0, false),
      macro: Dd(macroBuf, 32, 32, false, [1, 1]),
      detail: {
        polish: makeNodeDetailTex(4101, 0.33),
        grit: makeNodeDetailTex(4202, 0.31),
        fibre: makeNodeDetailTex(4303, 0.07),
        brushed: makeNodeDetailTex(4404, 0.24),
        smudge: makeNodeDetailTex(4505, 0.3),
      },
      marble: makeNodeTexSet(101, [218, 212, 202], 0.1, 2.4),
      marbleDark: makeNodeTexSet(102, [62, 56, 52], 0.12, 2.0),
      oak: makeNodeTexSet(103, [190, 152, 106], 0.35, [1.8, 0.18]),
      walnut: makeNodeTexSet(104, [88, 64, 46], 0.32, [2.4, 0.3]),
      carpetLobby: makeNodeTexSet(105, [26, 62, 72], 0.88, 2.4),
      carpetHall: makeNodeTexSet(106, [62, 54, 56], 0.88, 1.6),
      travertine: makeNodeTexSet(107, [198, 182, 158], 0.65, 1.8),
      poolGlass: makeNodeTexSet(108, [36, 130, 144], 0.12, 0.32),
      quarry: makeNodeTexSet(109, [76, 60, 50], 0.55, 0.8),
      glaze: makeNodeTexSet(110, [228, 224, 216], 0.12, 0.6),
      plaster: {
        light: makeNodeTexSet(111, [224, 212, 196], 0.85, 3.0),
        dark: makeNodeTexSet(112, [56, 54, 55], 0.82, 3.0),
      },
      concrete: makeNodeTexSet(113, [148, 143, 134], 0.8, 2.4),
      ceilingFibre: makeNodeTexSet(114, [222, 219, 211], 0.92, 0.6),
      bronze: makeNodeTexSet(115, [100, 79, 59], 0.38, 2.4),
      leather: makeNodeTexSet(116, [218, 214, 208], 0.55, 0.16),
      weave: makeNodeTexSet(117, [212, 212, 212], 0.94, 0.1),
      velvet: makeNodeTexSet(118, [216, 218, 220], 0.9, 0.6, { noOrm: true }),
      soil: makeNodeTexSet(119, [168, 162, 156], 0.95, 0.5, { noOrm: true }),
      speckle: makeNodeTexSet(120, [200, 200, 200], 0.88, 0.12, { noAlb: true }),
      shade: makeNodeTexSet(121, [235, 225, 210], 0.85, 0.06, { noOrm: true, emissive: true }),
      onyx: makeNodeTexSet(122, [212, 126, 38], 0.18, 2.0),
      art: [
        makeNodeTexSet(131, [210, 180, 142], 0.75, 1.0),
        makeNodeTexSet(132, [140, 82, 54], 0.75, 1.0),
        makeNodeTexSet(133, [208, 196, 170], 0.75, 1.0),
        makeNodeTexSet(134, [64, 98, 96], 0.75, 1.0),
      ],
      screen: makeNodeTexSet(135, [52, 64, 82], 0.2, 1.0).map,
    };
  }
  _9 = o2;
  let t = { timings: {} }, e = performance.now(), s = (n) => {
    let i = performance.now();
    t.timings[n] = Math.round(i - e), e = i;
  };
  return Ga = yb(11, 3, 2), yn = yb(23, 6, 3), En = yb(37, 16, 4), qo = yb(53, 48, 2), Va = yb(71, 5, 4), [E9, T9] = ZY(5, 16), s("fields"), t.flat = w9(128, 128, 255, 255, false), t.white = w9(255, 255, 255, 255, true), t.ormWhite = w9(255, 255, 255, 0, false), t.macro = oj(), s("macro"), t.detail = { polish: JY(), grit: tj(), fibre: ej(), brushed: sj(), smudge: nj() }, s("detail"), t.marble = ij(), s("marble"), t.marbleDark = aj(), s("marbleDark"), t.oak = eD(rj), t.walnut = eD(lj), s("wood"), t.carpetLobby = cj(), s("carpetLobby"), t.carpetHall = hj(), s("carpetHall"), t.travertine = fj(), s("travertine"), t.poolGlass = uj(), t.quarry = dj(), t.glaze = pj(), s("tiles"), t.plaster = mj(), s("plaster"), t.concrete = gj(), s("concrete"), t.ceilingFibre = xj(), t.bronze = bj(), s("ceiling+bronze"), t.leather = yj(), t.weave = vj(), t.velvet = Mj(), t.soil = wj(), t.speckle = Ej(), t.shade = Tj(), s("small"), t.onyx = Sj(), s("onyx"), t.art = [sw(0), sw(1), sw(2), sw(3)], s("art"), t.screen = Rj(), s("screen"), t;
}
function aD(o2, { w: t, h: e, color: s, bg: n, font: i }) {
  let r = Math.max(64, Math.round(1024 * e / t)), l = we(1024, r), c = l.getContext("2d");
  n ? (c.fillStyle = n, c.fillRect(0, 0, 1024, r)) : (c.globalAlpha = 2 / 255, c.fillStyle = s, c.fillRect(0, 0, 1024, r), c.globalAlpha = 1);
  let h = /(\d+(?:\.\d+)?)px/.exec(i), f = h ? parseFloat(h[1]) : 120, u = () => {
    c.font = h ? i.replace(h[0], f + "px") : i;
  };
  u();
  let d = Math.min(1024 * 0.92 / Math.max(1, c.measureText(o2).width), r * 0.74 / f);
  return f *= d, u(), c.textAlign = "center", c.textBaseline = "middle", c.fillStyle = s, c.fillText(o2, 1024 / 2, r / 2 + f * 0.04), R9(l);
}
var A9 = { marbleFloor: "marble", marbleDark: "marble", oakFloor: "wood", carpetLobby: "carpet", carpetHall: "carpet", terraceStone: "stone", poolTile: "tile", kitchenFloor: "tile", kitchenTile: "tile", plaster: "plaster", plasterDark: "plaster", walnut: "wood", woodDark: "wood", woodLight: "wood", concrete: "concrete", ceiling: "plaster", ceilingTile: "plaster", exterior: "metal", brass: "metal", steel: "metal", chrome: "metal", blackMetal: "metal", leatherTan: "fabric", leatherBlack: "fabric", velvetTeal: "fabric", fabricCream: "fabric", fabricCharcoal: "fabric", bedLinen: "fabric", onyx: "stone", lampShade: "fabric", bulbWarm: "glass", bulbCool: "glass", ledStrip: "plastic", screenOn: "glass", screenOff: "glass", foliage: "foliage", soil: "foliage", terracotta: "ceramic", ceramicWhite: "ceramic", ceramicBlack: "ceramic", rubber: "plastic", plasticBlack: "plastic", plasticWhite: "plastic", paper: "fabric", bottleGreen: "glass", bottleAmber: "glass", bottleClear: "glass", art1: "fabric", art2: "fabric", art3: "fabric", art4: "fabric", brassAged: "metal", marbleHoned: "marble", oakPlank: "wood", travertineWall: "stone" }, Aj = `
varying vec2 vGhUv;
varying vec2 vGhW;
`, kj = `
	vGhUv = uv;
	{
		vec4 ghWp = vec4( transformed, 1.0 );
		vec3 ghWn = objectNormal;
		#ifdef USE_INSTANCING
			ghWp = instanceMatrix * ghWp; ghWn = mat3( instanceMatrix ) * ghWn;
		#endif
		vGhW = vec2( ( modelMatrix * ghWp ).y, normalize( mat3( modelMatrix ) * ghWn ).y );
	}
`, Cj = `
uniform sampler2D ghMacro;
#ifdef HAB_DETAIL
	uniform sampler2D ghDetail;
#endif
uniform vec4 ghP, ghT, ghL, ghX, ghD, ghD2, ghJ, ghJc, ghC, ghW0, ghW1, ghW2, ghFl;
uniform vec3 ghWc;
varying vec2 vGhUv;
varying vec2 vGhW;
float ghHash( vec2 p ) { vec3 p3 = fract( vec3( p.xyx ) * 0.1031 ); p3 += dot( p3, p3.yzx + 33.33 ); return fract( ( p3.x + p3.y ) * p3.z ); }
`, Pj = `
	vec2 ghM = vGhUv, ghDxM = dFdx( vGhUv ), ghDyM = dFdy( vGhUv );
	vec2 ghUv = ghM * ghT.xy, ghDx = ghDxM * ghT.xy, ghDy = ghDyM * ghT.xy;
	mat2 ghR = mat2( 1.0, 0.0, 0.0, 1.0 );
	vec3 ghH = vec3( 0.5 );
	vec2 ghEn = vec2( 0.0 ), ghCc = vec2( 0.0 );
	float ghE = 1.0, ghLod = 1.0, ghJt = 0.0, ghBv = 0.0, ghAO = 1.0;
	if ( ghL.x > 0.5 ) {
		// ghL.x: 1 grid \xB7 2 boards along V \xB7 3 herringbone \xB7 4 strips along U
		vec2 gId, gL0, gAx = vec2( 1.0, 0.0 ), gAy = vec2( 0.0, 1.0 );
		float gCs = ghT.z;
		bool gHerr = ghL.x > 2.5 && ghL.x < 3.5;
		if ( ghL.x < 1.5 ) {
			// rectangular tiles, optional rounded corners (ghL.z = radius)
			vec2 gt = ghM / ghT.zw, gf = fract( gt );
			gId = floor( gt );
			vec2 ed = min( gf, 1.0 - gf ) * ghT.zw, sg = vec2( gf.x < 0.5 ? -1.0 : 1.0, gf.y < 0.5 ? -1.0 : 1.0 ), rk = max( ghL.z - ed, 0.0 );
			bool crn = rk.x > 0.0 && rk.y > 0.0;
			ghE = crn ? ghL.z - length( rk ) : min( ed.x, ed.y );
			ghEn = ( crn ? normalize( rk ) : ( ed.x < ed.y ? vec2( 1.0, 0.0 ) : vec2( 0.0, 1.0 ) ) ) * sg;
			ghCc = gf * 2.0 - 1.0;
			gL0 = ( gf - 0.5 ) * ghT.zw;
			gCs = min( ghT.z, ghT.w );
		} else if ( gHerr ) {
			// 45\xB0 herringbone: planks ghT.z wide, ghL.w widths long; texture U follows each plank
			vec2 hp = ghM / ghT.z;
			float hX = ( hp.x + hp.y ) * 0.70710678, hY = ( hp.x - hp.y ) * 0.70710678, hn = ghL.w;
			float hrow = floor( hY ), hxs = hX - hrow, hm = mod( floor( hxs ), 2.0 * hn ), ha, hc;
			if ( hm < hn ) {
				float hb = floor( hxs / ( 2.0 * hn ) ) * 2.0 * hn;
				ha = hxs - hb; hc = hY - hrow; gId = vec2( hb + hrow, hrow );
				gAx = vec2( 0.70710678, 0.70710678 ); gAy = vec2( 0.70710678, -0.70710678 );
			} else {
				float hcx = floor( hX ), hj = 2.0 * hn - 1.0 - hm;
				ha = hj + ( hY - hrow ); hc = hX - hcx; gId = vec2( hcx + 0.5, hrow - hj );
				gAx = vec2( 0.70710678, -0.70710678 ); gAy = vec2( 0.70710678, 0.70710678 );
			}
			vec2 ed = vec2( min( ha, hn - ha ), min( hc, 1.0 - hc ) ) * ghT.z;
			ghE = min( ed.x, ed.y );
			ghEn = ed.x < ed.y ? gAx * ( ha < hn * 0.5 ? -1.0 : 1.0 ) : gAy * ( hc < 0.5 ? -1.0 : 1.0 );
			gL0 = vec2( ha - hn * 0.5, hc - 0.5 ) * ghT.z;
		} else {
			// boards: running along V (wall panelling) or along U (furniture staves); texture U follows the board
			bool gU = ghL.x > 3.5;
			float gt = ( gU ? ghM.y : ghM.x ) / ghT.z, gi = floor( gt ), gf = gt - gi;
			vec2 gAc = gU ? vec2( 0.0, 1.0 ) : vec2( 1.0, 0.0 );
			gId = vec2( gi, 7.0 );
			ghE = min( gf, 1.0 - gf ) * ghT.z;
			ghEn = gAc * ( gf < 0.5 ? -1.0 : 1.0 );
			ghCc = gAc * ( gf * 2.0 - 1.0 );
			gAx = gU ? vec2( 1.0, 0.0 ) : vec2( 0.0, 1.0 ); gAy = gAc;
			gL0 = vec2( gU ? ghM.x : ghM.y, ( gf - 0.5 ) * ghT.z );
		}
		// every cell crops its own window of the slab: random offset, mirror / half turn, optional quarter turn
		ghH = vec3( ghHash( gId + 17.0 ), ghHash( gId.yx + vec2( 59.0, 3.0 ) ), ghHash( gId * 1.31 + 113.5 ) );
		float gSx = ghH.z > 0.5 ? -1.0 : 1.0;
		float gSy = ghL.x < 1.5 ? ( fract( ghH.z * 2.0 ) > 0.5 ? -1.0 : 1.0 ) : ( gHerr ? gSx : 1.0 );
		gL0 *= vec2( gSx, gSy ); gAx *= gSx; gAy *= gSy;
		if ( fract( ghH.z * 4.0 ) < ghL.y ) { gL0 = gL0.yx; vec2 gsw = gAx; gAx = gAy; gAy = gsw; }
		ghUv = gL0 * ghT.xy + ghH.xy * vec2( 7.31, 5.77 );
		ghDx = vec2( dot( ghDxM, gAx ), dot( ghDxM, gAy ) ) * ghT.xy;
		ghDy = vec2( dot( ghDyM, gAx ), dot( ghDyM, gAy ) ) * ghT.xy;
		ghR = mat2( gAx, gAy );
		// per-cell variation fades once cells approach a pixel (geometric-mean footprint: survives grazing views)
		ghLod = clamp( 1.5 - 1.6 * sqrt( length( ghDxM ) * length( ghDyM ) ) / gCs, 0.0, 1.0 );
		// tiny cells (mosaic): as they shrink to a pixel each one samples a wider average of the slab (no sparkle)
		float gCb = 1.0 + ( 1.0 - ghLod ) * ghX.z;
		ghDx *= gCb; ghDy *= gCb;
		// analytic joint: grout line, bevelled arris, contact AO \u2014 all box-filtered by the pixel footprint
		float gAa = abs( dot( ghDxM, ghEn ) ) + abs( dot( ghDyM, ghEn ) ) + 1e-5, gBw = max( ghJ.y, 1e-6 );
		ghJt = clamp( ( ghJ.x - ghE ) / gAa + 0.5, 0.0, 1.0 ) * min( 1.0, 2.0 * ghJ.x / ( ghJ.x + 0.5 * gAa ) );
		ghBv = clamp( ( ghE - ghJ.x ) / gAa + 0.5, 0.0, 1.0 ) * clamp( ( ghJ.x + ghJ.y - ghE ) / gAa + 0.5, 0.0, 1.0 )
			* min( 1.0, ghJ.y / gAa ) * ( 1.0 - 0.6 * clamp( ( ghE - ghJ.x ) / gBw, 0.0, 1.0 ) );
		float gAw = ghJ.x + 2.5 * ghJ.y + 1e-6;
		ghAO *= 1.0 - ghJ.w * ( 1.0 - smoothstep( 0.0, gAw + gAa, ghE ) ) * min( 1.0, gAw / ( 0.5 * gAw + gAa ) );
	}
	vec4 ghMc = texture2D( ghMacro, ghM * ghP.z );
	if ( ghX.x > 0.0 ) {
		vec2 gWs = vec2( ghP.z * 1.7 );
		ghUv += ( textureGrad( ghMacro, ghM * gWs + 0.31, ghDxM * gWs, ghDyM * gWs ).rg - 0.5 ) * ghX.x;
	}
	float ghPa = 0.0, ghRim = 0.0, ghSt = 0.0, ghBd = 0.0;
	#ifdef HAB_WEAR
		vec4 ghWr = texture2D( ghMacro, ghM * ghP.w + vec2( 0.37, 0.61 ) );
		ghPa = smoothstep( ghW0.x, ghW0.y, ghWr.b + ( ghMc.g - 0.5 ) * ghW0.z );
		ghSt = ghWr.a - 0.5;
		if ( ghFl.z + ghFl.w > 0.0 ) {
			// height above the floor it stands on: grime line at the skirting, hand polish at rail height
			float gHt = vGhW.x - ( vGhW.x > ghFl.y - 0.06 ? ghFl.y : ghFl.x );
			float gWall = 1.0 - smoothstep( 0.35, 0.75, abs( vGhW.y ) );
			float gSc = textureGrad( ghMacro, vec2( gHt * 2.3 + 0.11, ghM.x * 0.21 ), vec2( 0.0, length( ghDxM ) * 0.21 ), vec2( 0.0, length( ghDyM ) * 0.21 ) ).a;
			ghBd = ghFl.z * gWall * ( exp( - max( gHt, 0.0 ) * 13.0 ) * ( 0.3 + 1.4 * ghWr.b )
				+ 0.5 * smoothstep( 0.9, 0.97, gSc ) * smoothstep( 0.0, 0.03, gHt ) * ( 1.0 - smoothstep( 0.1, 0.3, gHt ) ) );
			ghPa *= 1.0 - ghFl.w * exp( - ( gHt - 1.0 ) * ( gHt - 1.0 ) * 14.0 );
		}
		ghRim = ghPa * ( 1.0 - ghPa ) * 4.0;
	#endif
	vec4 ghOrm = textureGrad( roughnessMap, ghUv, ghDx, ghDy );
	vec4 ghDt = vec4( 0.5 );
	#ifdef HAB_DETAIL
		ghDt = texture2D( ghDetail, ghM * ghD.xy );
	#endif
	float ghDm = mix( 1.0, ghOrm.b, ghD2.y ) * ( 1.0 - ghJt );
	ghAO *= ghOrm.r;
`, zj = `
	vec4 sampledDiffuseColor = textureGrad( map, ghUv, ghDx, ghDy );
	if ( ghX.y > 0.0 ) {
		// second, rotated + rescaled sample max-blended in (bright veins on dark stone never line up)
		mat2 gDu = mat2( 0.57524, 0.44968, -0.44968, 0.57524 );
		sampledDiffuseColor.rgb = max( sampledDiffuseColor.rgb, textureGrad( map, gDu * ( ghM * ghT.xy ) + vec2( 0.37, 0.61 ), gDu * ( ghDxM * ghT.xy ), gDu * ( ghDyM * ghT.xy ) ).rgb * ghX.y );
	}
	diffuseColor *= sampledDiffuseColor;
	diffuseColor.rgb *= ( 1.0 + ( ghH.x - 0.5 ) * ghC.x * ghLod ) * ( 1.0 + ( ghMc.r - 0.5 ) * 2.0 * ghP.x ) * ( 1.0 + ( ghDt.a - 0.5 ) * ghD2.x * ghDm );
#ifdef HAB_WEAR
	diffuseColor.rgb *= mix( vec3( 1.0 ), ghWc, ghPa ) * ( 1.0 + ghW1.y * ghRim + ghW2.x * ghSt ) * ( 1.0 - ghW1.x * ghBd );
	diffuseColor.rgb *= 1.0 - ghOrm.a * ghW0.w * smoothstep( 0.84, 0.92, ghMc.b );
#endif
	diffuseColor.rgb *= 1.0 + ghD2.w * ghBv;
	diffuseColor.rgb = mix( diffuseColor.rgb, ghJc.rgb * ( 0.7 + 0.6 * ghDt.a ) * ( 1.0 - 0.3 * ghPa ), ghJt );
`, Lj = `
float roughnessFactor = roughness * ghOrm.g;
roughnessFactor *= ( 1.0 + ( ghH.y - 0.5 ) * ghC.w * ghLod ) * ( 1.0 + ( ghMc.g - 0.5 ) * 2.0 * ghP.y );
roughnessFactor += ghW1.z * ghPa + ghW1.w * ghRim + ghW2.y * ghSt + ghW2.z * ghBd;
roughnessFactor += ( ghDt.b - 0.5 ) * ghD.w * ghDm * ( 1.0 + ghD2.z * ghPa ) - 0.5 * ghD2.w * ghBv;
roughnessFactor = clamp( mix( roughnessFactor, ghJc.a, ghJt ), 0.04, 1.0 );
`, Dj = THREE.ShaderChunk.normal_fragment_begin.replace("vNormalMapUv", "vGhUv"), Ij = `
	vec3 mapN = textureGrad( normalMap, ghUv, ghDx, ghDy ).xyz * 2.0 - 1.0;
	mapN.xy *= normalScale;
	mapN.xy = ghR * mapN.xy + ( ghDt.rg - 0.5 ) * 2.0 * ghD.z * ghDm;
	mapN.xy += ( ( ghH.xy - 0.5 ) * ghC.y + ghCc * ghCc * ghCc * ghC.z ) * ghLod;
	mapN.xy = mapN.xy * ( 1.0 - ghJt ) + ghEn * ( ghJ.z * ghBv );
	normal = normalize( tbn * mapN );
`, Hj = `
#ifdef USE_EMISSIVEMAP
	vec4 emissiveColor = textureGrad( emissiveMap, ghUv, ghDx, ghDy );
	#ifdef HAB_DEPTH
	{
		// back-lit stone: a deeper layer of the same slab, seen through the surface, slides with the eye
		vec3 ghV = normalize( vViewPosition );
		vec2 ghPx = vec2( dot( ghV, tbn[ 0 ] ), dot( ghV, tbn[ 1 ] ) ) / max( dot( ghV, nonPerturbedNormal ), 0.3 );
		vec2 ghUd = ( ghUv - ghPx * ghT.xy * HAB_DEPTH ) * 0.57 + vec2( 0.31, 0.67 );
		vec3 ghDeep = textureGrad( emissiveMap, ghUd, ghDx * 0.57, ghDy * 0.57 ).rgb;
		vec2 ghUe = ( ghUv - ghPx * ghT.xy * HAB_DEPTH * 0.4 ) * 1.31 + vec2( 0.13, 0.41 );
		vec3 ghMid = textureGrad( emissiveMap, ghUe, ghDx * 1.31, ghDy * 1.31 ).rgb;
		emissiveColor.rgb = emissiveColor.rgb * ( 0.34 + 0.66 * ghOrm.b ) * ( 0.46 + 1.0 * ghDeep.g + 0.3 * ghMid.r ) + ghDeep * 0.05;
		emissiveColor.rgb *= 1.0 + ( ghMc.r - 0.5 ) * 0.5;
	}
	#endif
	totalEmissiveRadiance *= emissiveColor.rgb;
#endif
`, Fj = `
	reflectedLight.indirectDiffuse *= ghAO;
	reflectedLight.indirectSpecular *= ghAO;
	reflectedLight.directDiffuse *= 0.55 + 0.45 * ghAO;
	reflectedLight.directSpecular *= ghAO;
`, Oj = { grid: 1, boards: 2, herringbone: 3, strips: 4 }, rD = (o2) => {
  let t = new THREE.Color(o2);
  return [t.r, t.g, t.b];
};
function Nj(o2, t, e = {}) {
  if (t.lite) return o2;
  let s = e.tile || o2.map && o2.map.userData.tile || o2.roughnessMap && o2.roughnessMap.userData.tile || o2.normalMap && o2.normalMap.userData.tile || [1, 1], n = o2.defines = o2.defines || {}, i = e.layout ? Array.isArray(e.cell) ? e.cell : [e.cell, e.cell] : [1, 1], a = e.layout ? e.joint : null, r = e.cellVar || {}, l = t.lite ? null : e.detail, c = t.lite ? null : e.wear;
  t.lite || (n.HAB_DETAIL = "", n.HAB_WEAR = ""), e.depth && (n.HAB_DEPTH = Number(e.depth).toFixed(5)), o2.map || (o2.map = t.white), o2.roughnessMap || (o2.roughnessMap = t.ormWhite), o2.normalMap || (o2.normalMap = t.flat, o2.normalScale.set(1, 1));
  let h = l ? Array.isArray(l.tile) ? l.tile : [l.tile, l.tile] : [1, 1], f = a ? rD(a.color ?? 2105376) : [0, 0, 0], u = c && c.tint !== void 0 ? Array.isArray(c.tint) ? c.tint : rD(c.tint) : [1, 1, 1], d = (v, y, M, w) => ({ value: new THREE.Vector4(v, y, M, w) }), m = { ghMacro: { value: t.macro }, ghDetail: { value: l ? l.map : t.anyDetail }, ghP: d(e.macro || 0, e.macroRough || 0, 1 / (e.period || 13.7), c ? 1 / (c.period || 6.3) : 1), ghT: d(1 / s[0], 1 / s[1], i[0], i[1]), ghL: d(e.layout ? Oj[e.layout] : 0, e.layout === "grid" && e.turn || 0, e.round || 0, e.herr || 5), ghX: d(e.warp || 0, e.dual ? 0.9 : 0, e.chips ? 15 : 0, 0), ghD: l ? d(1 / h[0], 1 / h[1], l.normal ?? 0.3, l.rough ?? 0.1) : d(1, 1, 0, 0), ghD2: d(l ? l.albedo ?? 0 : 0, l ? l.mask ?? 0 : 0, l ? l.boost ?? 0 : 0, a && a.burnish || 0), ghJ: a ? d(a.w ?? 1e-3, a.bevel ?? 2e-3, a.slope ?? 0.6, a.ao ?? 0.5) : d(0, 0, 0, 0), ghJc: d(f[0], f[1], f[2], a ? a.rough ?? 0.85 : 1), ghC: d(r.tone || 0, r.tilt || 0, r.pillow || 0, r.rough || 0), ghW0: c ? d(c.lo ?? 0.55, c.hi ?? 0.7, c.breakup ?? 0.3, c.crack || 0) : d(2, 3, 0, 0), ghW1: c ? d(c.baseAlbedo ?? 0.45, c.rim || 0, c.rough || 0, c.rimRough || 0) : d(0, 0, 0, 0), ghW2: c ? d(c.streak || 0, c.streakRough || 0, c.baseRough ?? 0.25, 0) : d(0, 0, 0, 0), ghFl: d(t.floors[0], t.floors[1], c && e.world !== false && c.base || 0, c && c.hand || 0), ghWc: { value: new THREE.Vector3(u[0], u[1], u[2]) } };
  Object.defineProperty(o2, "ghUniforms", { value: m, configurable: true });
  let p = (v) => {
    Object.assign(v.uniforms, m), v.vertexShader = v.vertexShader.replace("#include <common>", `#include <common>
` + Aj).replace("#include <project_vertex>", `#include <project_vertex>
` + kj), v.fragmentShader = v.fragmentShader.replace("void main() {", Cj + "void main() {" + Pj).replace("#include <map_fragment>", zj).replace("#include <roughnessmap_fragment>", Lj).replace("#include <normal_fragment_begin>", Dj).replace("#include <normal_fragment_maps>", Ij).replace("#include <emissivemap_fragment>", Hj).replace("#include <aomap_fragment>", Fj);
  }, x = o2.onBeforeCompile, g = Object.prototype.hasOwnProperty.call(o2, "onBeforeCompile");
  o2.onBeforeCompile = g ? (v, y) => {
    x(v, y), p(v);
  } : p;
  let b = Object.prototype.hasOwnProperty.call(o2, "customProgramCacheKey") ? o2.customProgramCacheKey : null;
  return o2.customProgramCacheKey = () => (b ? b() : "") + "gh-surface2", o2.clone = function() {
    let v = Object.getPrototypeOf(this).clone.call(this);
    return v.onBeforeCompile = this.onBeforeCompile, v.customProgramCacheKey = this.customProgramCacheKey, Object.assign(v.defines, this.defines), v.clone = this.clone, Object.defineProperty(v, "ghUniforms", { value: m, configurable: true }), v;
  }, o2;
}
function lD({ anisotropy: o2 = 8, floors: t = [0, 3.8], detail: e = false } = {}) {
  globalThis.HABITAT_MAT_LITE && (e = false);
  let s = performance.now(), n = iD(o2), i = performance.now() - s, a = { macro: n.macro, flat: n.flat, white: n.white, ormWhite: n.ormWhite, anyDetail: n.detail.polish, floors: t, lite: !e }, r = (C, L) => Nj(C, a, L), l = n.detail, c = (C, L = C) => new THREE.Vector2(C, L), h = (C) => {
    for (let L of Object.keys(C)) C[L] === void 0 && delete C[L];
    return C;
  }, f = (C) => new THREE.MeshStandardMaterial(h(C)), u = (C) => new THREE.MeshPhysicalMaterial(h(C)), d = (C, L = {}) => ({ map: C.map, normalMap: C.normalMap, roughnessMap: C.roughnessMap, roughness: 1, metalness: 0, ...L }), m = (C, L, A = L) => {
    let O = C.clone();
    return O.repeat.set(1 / L, 1 / A), O.userData = { tile: [L, A] }, O.needsUpdate = true, O;
  }, p = {};
  Object.defineProperty(p, 'isLite', { value: !e, enumerable: false });
  p.marbleFloor = r(f(d(n.marble, { envMapIntensity: 1.2 })), { layout: "grid", cell: 1.2, joint: { w: 11e-4, bevel: 26e-4, slope: 0.85, ao: 0.55, color: 9077364, rough: 0.9 }, cellVar: { tone: 0.05, tilt: 0.014, rough: 0.3 }, macro: 0.03, macroRough: 0.3, detail: { map: l.polish, tile: 0.33, normal: 0.035, rough: 0.07, albedo: 0.12, boost: 2.2 }, wear: { period: 7.9, lo: 0.3, hi: 0.85, breakup: 0.35, tint: [0.975, 0.97, 0.96], rough: 0.12, streakRough: 0.03 } }), p.marbleDark = r(f(d(n.marbleDark, { envMapIntensity: 1.2 })), { dual: true, warp: 0.3, macroRough: 0.3, detail: { map: l.polish, tile: 0.29, normal: 0.03, rough: 0.07, albedo: 0.04, boost: 1.5 }, wear: { period: 2.9, lo: 0.3, hi: 0.9, tint: [0.98, 0.98, 0.98], rough: 0.07, streakRough: 0.025, base: 0.5, baseAlbedo: 0.25, baseRough: 0.3 } }), p.oakFloor = r(f(d(n.oak, { color: 14201996 })), { layout: "herringbone", cell: 0.09, herr: 5, joint: { w: 35e-5, bevel: 11e-4, slope: 0.7, ao: 0.6, color: 1839884, rough: 0.9, burnish: 0.1 }, cellVar: { tone: 0.42, tilt: 0.012, rough: 0.3 }, macro: 0.07, macroRough: 0.2, detail: { map: l.polish, tile: 0.27, normal: 0.03, rough: 0.07, boost: 1.6 }, wear: { period: 6.7, lo: 0.3, hi: 0.85, tint: [1.04, 1.03, 1.02], rough: 0.12, streakRough: 0.04 } });
  let x = (C, L = {}) => r(f(d(C, { roughness: 1, envMapIntensity: 0.5 })), { macro: 0.08, detail: { map: l.fibre, tile: 0.07, normal: 0.85, rough: 0, albedo: 0.55 }, wear: { period: 4.3, lo: 0.3, hi: 0.9, breakup: 0.5, tint: [1.1, 1.09, 1.08], streak: 0.08, base: 0 }, ...L });
  p.carpetLobby = x(n.carpetLobby), p.carpetHall = x(n.carpetHall), p.terraceStone = r(f(d(n.travertine)), { layout: "grid", cell: 0.9, turn: 0.3, joint: { w: 28e-4, bevel: 4e-3, slope: 0.75, ao: 0.6, color: 7234130, rough: 0.95 }, cellVar: { tone: 0.1, tilt: 0.02, rough: 0.12 }, macro: 0.06, macroRough: 0.1, detail: { map: l.grit, tile: 0.31, normal: 0.5, rough: 0.14, albedo: 0.36, mask: 0.55 }, wear: { period: 5.3, lo: 0.8, hi: 0.87, breakup: 0.5, tint: [0.86, 0.84, 0.81], rim: 0.06, rough: -0.3, rimRough: 0.06, streak: 0.03 } }), p.poolTile = r(f(d(n.poolGlass)), { layout: "grid", cell: 0.04, round: 4e-3, chips: true, joint: { w: 12e-4, bevel: 22e-4, slope: 0.9, ao: 0.5, color: 12174012, rough: 0.85 }, cellVar: { tone: 0.4, tilt: 0.05, pillow: 0.06, rough: 0.5 }, macro: 0.08, detail: { map: l.polish, tile: 0.17, normal: 0.05, rough: 0.06 }, wear: { period: 3.1, lo: 0.5, hi: 0.8, tint: [1.05, 1.06, 1.05], rough: 0.14, streakRough: 0.05 } }), p.kitchenFloor = r(f(d(n.quarry)), { layout: "grid", cell: 0.2, turn: 0.5, joint: { w: 26e-4, bevel: 3e-3, slope: 0.8, ao: 0.6, color: 4867392, rough: 0.9 }, cellVar: { tone: 0.28, tilt: 0.03, pillow: 0.03, rough: 0.35 }, macro: 0.06, macroRough: 0.25, detail: { map: l.grit, tile: 0.23, normal: 0.3, rough: 0.12, albedo: 0.3 }, wear: { period: 3.7, lo: 0.3, hi: 0.9, tint: [0.93, 0.92, 0.91], rough: -0.1, streakRough: 0.06, streak: 0.04 } }), p.kitchenTile = r(f(d(n.glaze)), { layout: "grid", cell: 0.15, turn: 0.5, joint: { w: 14e-4, bevel: 35e-4, slope: 0.8, ao: 0.4, color: 10328204, rough: 0.9 }, cellVar: { tone: 0.035, tilt: 0.03, pillow: 0.05, rough: 0.4 }, macroRough: 0.3, detail: { map: l.polish, tile: 0.21, normal: 0.04, rough: 0.05 }, wear: { period: 2.7, lo: 0.5, hi: 0.8, tint: [0.985, 0.975, 0.955], rough: 0.12, streakRough: 0.06, base: 0.5, baseAlbedo: 0.2, baseRough: 0.3 } });
  let g = { period: 5.9, lo: 0.4, hi: 0.95, tint: [0.985, 0.98, 0.975], rough: -0.04, streak: 0.012, crack: 0.5, base: 0.55, baseAlbedo: 0.22, baseRough: 0.1 };
  p.plaster = r(f(d(n.plaster.light)), { warp: 0.12, macro: 0.05, macroRough: 0.06, detail: { map: l.grit, tile: 0.37, normal: 0.22, rough: 0.08, albedo: 0.1 }, wear: g }), p.plasterDark = r(f(d(n.plaster.dark, { roughness: 0.82 })), { warp: 0.12, macro: 0.1, macroRough: 0.1, detail: { map: l.grit, tile: 0.37, normal: 0.2, rough: 0.1, albedo: 0.14 }, wear: { ...g, tint: [1.05, 1.05, 1.05], rough: -0.07, baseAlbedo: -0.25, crack: 0.3 } }), p.walnut = r(f(d(n.walnut)), { layout: "boards", cell: 0.15, joint: { w: 6e-4, bevel: 32e-4, slope: 1.1, ao: 0.6, color: 1182728, rough: 0.9, burnish: 0.22 }, cellVar: { tone: 0.34, tilt: 0.012, rough: 0.25 }, macro: 0.07, macroRough: 0.2, detail: { map: l.polish, tile: 0.23, normal: 0.02, rough: 0.05 }, wear: { period: 3.3, lo: 0.5, hi: 0.8, tint: [1.03, 1.02, 1.01], rough: -0.06, streakRough: 0.05, base: 0.45, baseAlbedo: 0.2, baseRough: 0.25 } });
  let b = (C, L) => r(f(d(C, { color: L })), { layout: "strips", cell: 0.11, cellVar: { tone: 0.16, rough: 0.2 }, detail: { map: l.polish, tile: 0.21, normal: 0.02, rough: 0.06 }, wear: { period: 1.3, lo: 0.5, hi: 0.8, tint: [1.03, 1.02, 1.01], rough: -0.07, streakRough: 0.04 } });
  p.woodDark = b(n.walnut, 15117706), p.woodLight = b(n.oak, 16777215), p.concrete = r(f(d(n.concrete)), { macro: 0.14, macroRough: 0.06, detail: { map: l.grit, tile: 0.29, normal: 0.45, rough: 0.1, albedo: 0.4, mask: 0.5 }, wear: { period: 6.1, lo: 0.66, hi: 0.76, breakup: 0.5, tint: [0.91, 0.905, 0.895], rim: 0.11, rough: 0.03, streak: 0.05, crack: 0.6, base: 0.4, baseAlbedo: -0.12, baseRough: 0.1 } }), p.ceiling = r(f({ color: 15131352, roughness: 1, metalness: 0, normalMap: n.plaster.light.normalMap, normalScale: c(0.3), roughnessMap: n.plaster.light.roughnessMap }), { tile: n.plaster.light.tile, macro: 0.03, detail: { map: l.grit, tile: 0.41, normal: 0.14, rough: 0.05, albedo: 0.06 } }), p.ceilingTile = r(f(d(n.ceilingFibre)), { layout: "grid", cell: 0.6, turn: 0.5, joint: { w: 0.012, bevel: 4e-3, slope: -0.7, ao: 0.45, color: 14605266, rough: 0.5 }, cellVar: { tone: 0.03, tilt: 0.012 }, macro: 0.03, detail: { map: l.grit, tile: 0.19, normal: 0.3, rough: 0.05, albedo: 0.3 } }), p.exterior = r(f(d(n.bronze, { metalness: 1 })), { layout: "grid", cell: [1.2, 0.6], joint: { w: 5e-3, bevel: 6e-3, slope: 0.9, ao: 0.7, color: 723465, rough: 0.9 }, cellVar: { tone: 0.16, tilt: 0.03, pillow: 0.02, rough: 0.2 }, macro: 0.08, macroRough: 0.12, detail: { map: l.brushed, tile: 0.24, normal: 0.12, rough: 0.08, albedo: 0.06 }, wear: { period: 4.7, lo: 0.35, hi: 0.9, tint: [0.96, 0.965, 0.965], rough: 0.03, streak: 0.035, streakRough: 0.02, base: 0.4, baseAlbedo: 0.25, baseRough: 0.15 } });
  let v = (C, L = {}) => {
    let A = (C.sheen !== void 0 ? u : f)({ map: n.white, normalMap: n.flat, roughnessMap: n.ormWhite, metalness: 0, ...C });
    return r(A, { tile: [1, 1], ...L, detail: L.detail || { map: l.polish, tile: 0.2, normal: 0, rough: 0 }, wear: { period: 1.1, ...L.wear || {} } });
  }, y = (C, L = {}) => ({ lo: 0.25, hi: 0.9, breakup: 0.4, tint: [0.98, 0.98, 0.98], rough: C, streakRough: C * 0.4, ...L });
  p.brass = v({ color: 14464104, metalness: 1, roughness: 0.2 }, { detail: { map: l.brushed, tile: 0.17, normal: 0.035, rough: 0.05, albedo: 0.03 }, wear: { period: 0.83, lo: 0.3, hi: 0.9, breakup: 0.5, tint: [0.9, 0.85, 0.76], rough: 0.1, streakRough: 0.03, hand: 0.85 } }), p.steel = v({ color: 11975358, metalness: 1, roughness: 0.34 }, { detail: { map: l.brushed, tile: 0.21, normal: 0.12, rough: 0.13, albedo: 0.05 }, wear: { period: 0.9, lo: 0.3, hi: 0.9, breakup: 0.5, tint: [0.987, 0.985, 0.98], rough: 0.028, streakRough: 0.03 } }), p.chrome = v({ color: 15264492, metalness: 1, roughness: 0.035 }, { detail: { map: l.smudge, tile: 0.31, normal: 0, rough: 0.1 }, wear: { period: 0.7, ...y(0.045) } }), p.blackMetal = v({ color: 3158325, roughness: 0.52, normalMap: n.speckle.normalMap, normalScale: c(0.5), roughnessMap: n.speckle.roughnessMap }, { tile: n.speckle.tile, detail: { map: l.smudge, tile: 0.37, normal: 0, rough: 0.1 }, wear: { period: 1.3, lo: 0.3, hi: 0.9, tint: [1.08, 1.07, 1.06], rough: 0.06, streakRough: 0.03 } });
  let M = (C) => v({ color: C, roughness: 1, map: n.leather.map, normalMap: n.leather.normalMap, normalScale: c(1), roughnessMap: n.leather.roughnessMap }, { tile: n.leather.tile, detail: { map: l.smudge, tile: 0.43, normal: 0, rough: 0.08 }, wear: { period: 0.9, lo: 0.3, hi: 0.9, breakup: 0.5, tint: [1.05, 1.045, 1.04], rough: -0.1, streakRough: 0.03 } });
  p.leatherTan = M(9064744), p.leatherBlack = M(4472120), p.velvetTeal = v({ color: 1332058, roughness: 0.95, sheen: 1, sheenColor: new THREE.Color(7391422), sheenRoughness: 0.42, map: n.velvet.map, normalMap: n.velvet.normalMap, normalScale: c(0.7) }, { tile: n.velvet.tile, detail: { map: l.fibre, tile: 0.034, normal: 0.25, rough: 0, albedo: 0.3 }, wear: { period: 0.8, lo: 0.25, hi: 0.95, breakup: 0.6, tint: [1.14, 1.13, 1.12], streak: 0.08 } });
  let w = (C, L, A = {}) => v({ color: C, roughness: 0.96, map: L.map, normalMap: L.normalMap, normalScale: c(0.9), roughnessMap: L.roughnessMap, ...A }, { tile: L.tile, detail: { map: l.fibre, tile: 0.021, normal: 0.12, rough: 0, albedo: 0.14 }, wear: { period: 0.9, lo: 0.4, hi: 0.8, tint: [1.05, 1.05, 1.05], streak: 0.03 } });
  p.fabricCream = w(15129282, n.weave), p.fabricCharcoal = w(4145479, n.weave);
  let T = { map: m(n.weave.map, 0.045), normalMap: m(n.weave.normalMap, 0.045), roughnessMap: m(n.weave.roughnessMap, 0.045), tile: [0.045, 0.045] };
  p.bedLinen = w(15328733, T, { roughness: 0.9, normalScale: c(0.45) }), p.onyx = r(f({ color: 13816530, map: n.onyx.map, emissiveMap: n.onyx.map, emissive: 16777215, emissiveIntensity: 2.5, roughness: 1, metalness: 0, normalMap: n.onyx.normalMap, normalScale: c(0.6), roughnessMap: n.onyx.roughnessMap }), { warp: 0.28, depth: 0.045, detail: { map: l.polish, tile: 0.31, normal: 0.03, rough: 0.07 }, wear: { period: 2.3, lo: 0.5, hi: 0.8, rough: 0.07, streakRough: 0.04 } }), p.lampShade = f({ color: 15783590, map: n.shade.map, emissive: 16757866, emissiveMap: n.shade.emissiveMap, emissiveIntensity: 1.6, roughness: 0.9, metalness: 0, normalMap: n.shade.normalMap, normalScale: c(0.7), side: THREE.DoubleSide }), p.bulbWarm = f({ color: 2759696, emissive: 16757866, emissiveIntensity: 8, roughness: 0.4, metalness: 0 }), p.bulbCool = f({ color: 1843752, emissive: 13625599, emissiveIntensity: 6, roughness: 0.4, metalness: 0 }), p.ledStrip = f({ color: 2757640, emissive: 16747068, emissiveIntensity: 5, roughness: 0.5, metalness: 0 }), p.screenOn = f({ color: 0, emissive: 16777215, emissiveMap: n.screen, emissiveIntensity: 2.2, roughness: 0.22, metalness: 0 }), p.screenOff = v({ color: 2500137, roughness: 0.06, envMapIntensity: 1.3 }, { detail: { map: l.smudge, tile: 0.29, normal: 0, rough: 0.14 }, wear: { period: 0.8, ...y(0.05, { tint: [1.12, 1.12, 1.12] }) } }), p.foliage = f({ color: 4156717, roughness: 0.52, metalness: 0, side: THREE.DoubleSide }), p.foliage.onBeforeCompile = (C) => {
    C.fragmentShader = C.fragmentShader.replace("#include <lights_physical_pars_fragment>", `#include <lights_physical_pars_fragment>
void RE_Direct_Leaf( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
	RE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	float back = saturate( dot( -geometryNormal, directLight.direction ) );
	reflectedLight.directDiffuse += back * directLight.color * material.diffuseColor * vec3( 0.95, 1.0, 0.3 ) * ( 0.62 * RECIPROCAL_PI );
}
#undef RE_Direct
#define RE_Direct RE_Direct_Leaf`);
  }, p.foliage.customProgramCacheKey = () => "gh-foliage", p.soil = v({ color: 4995371, roughness: 1, normalMap: n.soil.normalMap, normalScale: c(1.3), map: n.soil.map }, { tile: n.soil.tile, detail: { map: l.grit, tile: 0.13, normal: 0.6, rough: 0, albedo: 0.5 } }), p.terracotta = v({ color: 11624506, roughness: 0.84, normalMap: n.speckle.normalMap, normalScale: c(0.8) }, { tile: n.speckle.tile, detail: { map: l.grit, tile: 0.17, normal: 0.35, rough: 0.1, albedo: 0.3 }, wear: { period: 0.6, lo: 0.4, hi: 0.85, breakup: 0.6, tint: [0.94, 0.935, 0.93], rim: 0.06, rough: 0.05, streak: 0.04 } });
  let S = (C, L) => v({ color: C, roughness: L }, { detail: { map: l.smudge, tile: 0.33, normal: 0, rough: 0.08 }, wear: { period: 0.7, ...y(0.04) } });
  p.ceramicWhite = S(15328731, 0.14), p.ceramicBlack = S(3158068, 0.16), p.rubber = v({ color: 3158064, roughness: 0.9, normalMap: n.speckle.normalMap, normalScale: c(0.5) }, { tile: n.speckle.tile, detail: { map: l.grit, tile: 0.11, normal: 0.25, rough: 0.06, albedo: 0.2 }, wear: { lo: 0.5, hi: 0.8, tint: [1.25, 1.22, 1.18], rough: 0.06 } }), p.plasticBlack = v({ color: 3158065, roughness: 0.46, roughnessMap: n.speckle.roughnessMap, normalMap: n.speckle.normalMap, normalScale: c(0.4) }, { tile: n.speckle.tile, detail: { map: l.smudge, tile: 0.31, normal: 0, rough: 0.12 }, wear: { ...y(-0.07, { tint: [1.08, 1.08, 1.08] }) } }), p.plasticWhite = v({ color: 15131612, roughness: 0.4, roughnessMap: n.speckle.roughnessMap, normalMap: n.speckle.normalMap, normalScale: c(0.3) }, { tile: n.speckle.tile, detail: { map: l.smudge, tile: 0.31, normal: 0, rough: 0.1 }, wear: { ...y(0.06, { tint: [0.97, 0.965, 0.95] }) } }), p.paper = v({ color: 15525332, roughness: 0.92 }, { detail: { map: l.fibre, tile: 0.045, normal: 0.1, rough: 0, albedo: 0.07 } });
  let E = (C, L) => f({ color: C, transparent: true, opacity: L, roughness: 0.06, metalness: 0, envMapIntensity: 1.6 });
  p.bottleGreen = E(1923628, 0.58), p.bottleAmber = E(8141838, 0.6), p.bottleClear = E(13624038, 0.34);
  for (let C = 0; C < 4; C++) {
    let L = n.art[C];
    p["art" + (C + 1)] = f({ map: L.map, normalMap: L.normalMap, normalScale: c(0.6), roughnessMap: L.roughnessMap, roughness: 1, metalness: 0 });
  }
  p.brassAged = v({ color: 11569740, metalness: 1, roughness: 0.38 }, { detail: { map: l.brushed, tile: 0.17, normal: 0.1, rough: 0.14, albedo: 0.1 }, wear: { period: 0.6, lo: 0.2, hi: 0.8, breakup: 0.6, tint: [0.66, 0.6, 0.5], rough: 0.2, streak: 0.08, streakRough: 0.06, hand: 0.9 } }), p.marbleHoned = r(f(d(n.marble, { roughness: 3.4 })), { layout: "grid", cell: [1.2, 0.6], joint: { w: 9e-4, bevel: 2e-3, slope: 0.7, ao: 0.5, color: 9077364, rough: 0.9 }, cellVar: { tone: 0.05, tilt: 8e-3, rough: 0.15 }, macro: 0.03, macroRough: 0.15, detail: { map: l.grit, tile: 0.27, normal: 0.07, rough: 0.08, albedo: 0.04 }, wear: { period: 3.1, lo: 0.5, hi: 0.8, rough: -0.06, base: 0.4, baseAlbedo: 0.2 } }), p.oakPlank = r(f(d(n.oak, { color: 14861472 })), { layout: "boards", cell: 0.14, joint: { w: 6e-4, bevel: 2e-3, slope: 0.9, ao: 0.6, color: 1839884, rough: 0.9 }, cellVar: { tone: 0.26, tilt: 0.01, rough: 0.25 }, macro: 0.06, macroRough: 0.2, detail: { map: l.polish, tile: 0.23, normal: 0.02, rough: 0.05 }, wear: { period: 3.3, lo: 0.5, hi: 0.8, tint: [1.03, 1.02, 1.01], rough: -0.05, streakRough: 0.05, base: 0.4, baseAlbedo: 0.2 } }), p.travertineWall = r(f(d(n.travertine)), { layout: "grid", cell: [0.6, 0.3], joint: { w: 15e-4, bevel: 3e-3, slope: 0.7, ao: 0.55, color: 7234130, rough: 0.95 }, cellVar: { tone: 0.12, tilt: 0.015, rough: 0.12 }, macro: 0.06, macroRough: 0.1, detail: { map: l.grit, tile: 0.31, normal: 0.5, rough: 0.14, albedo: 0.5, mask: 0.8 }, wear: { period: 4.1, lo: 0.6, hi: 0.8, tint: [0.93, 0.92, 0.9], streak: 0.05, base: 0.5, baseAlbedo: 0.25 } });
  for (let C of Object.keys(p)) p[C].name = C;
  let _ = /* @__PURE__ */ new Map();
  p.makeSign = (C, { w: L = 1, h: A = 0.25, color: O = "#e9c98a", bg: H = null, glow: F = 0, font: P = '600 120px Bahnschrift, "Segoe UI", sans-serif' } = {}) => {
    let z = aD(String(C), { w: L, h: A, color: O, bg: H, font: P }), k = new THREE.MeshStandardMaterial({ map: z, roughness: 0.45, metalness: 0, transparent: !H, alphaTest: H ? 0 : 0.03, depthWrite: !!H, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    F > 0 && (k.emissive.set(16777215), k.emissiveMap = z, k.emissiveIntensity = F), k.name = "sign";
    let I = L + "x" + A;
    _.has(I) || _.set(I, new THREE.PlaneGeometry(L, A));
    let G = new THREE.Mesh(_.get(I), k);
    return G.name = "sign", G.userData.sign = true, G;
  }, p.textures = n;
  let R = performance.now() - s;
  return p.genTimeMs = R,  p;
}
var wb = new THREE.Vector3();
function ih(o2, t, e, s, n, i) {
  let a = 2 * Math.PI * n / 4, r = Math.max(i - 2 * n, 0), l = Math.PI / 4;
  wb.copy(t), wb[s] = 0, wb.normalize();
  let c = 0.5 * a / (a + r), h = 1 - wb.angleTo(o2) / l;
  return Math.sign(wb[e]) === 1 ? h * c : r / (a + r) + c + c * (1 - h);
}
var Ll = class o extends THREE.BoxGeometry {
  constructor(t = 1, e = 1, s = 1, n = 2, i = 0.1) {
    let a = n * 2 + 1;
    if (i = Math.min(t / 2, e / 2, s / 2, i), super(1, 1, 1, a, a, a), this.type = "RoundedBoxGeometry", this.parameters = { width: t, height: e, depth: s, segments: n, radius: i }, a === 1) return;
    let r = this.toNonIndexed();
    this.index = null, this.attributes.position = r.attributes.position, this.attributes.normal = r.attributes.normal, this.attributes.uv = r.attributes.uv;
    let l = new THREE.Vector3(), c = new THREE.Vector3(), h = new THREE.Vector3(t, e, s).divideScalar(2).subScalar(i), f = this.attributes.position.array, u = this.attributes.normal.array, d = this.attributes.uv.array, m = f.length / 6, p = new THREE.Vector3(), x = 0.5 / a;
    for (let g = 0, b = 0; g < f.length; g += 3, b += 2) switch (l.fromArray(f, g), c.copy(l), c.x -= Math.sign(c.x) * x, c.y -= Math.sign(c.y) * x, c.z -= Math.sign(c.z) * x, c.normalize(), f[g + 0] = h.x * Math.sign(l.x) + c.x * i, f[g + 1] = h.y * Math.sign(l.y) + c.y * i, f[g + 2] = h.z * Math.sign(l.z) + c.z * i, u[g + 0] = c.x, u[g + 1] = c.y, u[g + 2] = c.z, Math.floor(g / m)) {
      case 0:
        p.set(1, 0, 0), d[b + 0] = ih(p, c, "z", "y", i, s), d[b + 1] = 1 - ih(p, c, "y", "z", i, e);
        break;
      case 1:
        p.set(-1, 0, 0), d[b + 0] = 1 - ih(p, c, "z", "y", i, s), d[b + 1] = 1 - ih(p, c, "y", "z", i, e);
        break;
      case 2:
        p.set(0, 1, 0), d[b + 0] = 1 - ih(p, c, "x", "z", i, t), d[b + 1] = ih(p, c, "z", "x", i, s);
        break;
      case 3:
        p.set(0, -1, 0), d[b + 0] = 1 - ih(p, c, "x", "z", i, t), d[b + 1] = 1 - ih(p, c, "z", "x", i, s);
        break;
      case 4:
        p.set(0, 0, 1), d[b + 0] = 1 - ih(p, c, "x", "y", i, t), d[b + 1] = 1 - ih(p, c, "y", "x", i, e);
        break;
      case 5:
        p.set(0, 0, -1), d[b + 0] = ih(p, c, "x", "y", i, t), d[b + 1] = 1 - ih(p, c, "y", "x", i, e);
        break;
    }
  }
  static fromJSON(t) {
    return new o(t.width, t.height, t.depth, t.segments, t.radius);
  }
};
var qa = new THREE.Vector3(0, 1, 0), cD = new THREE.Vector3(), hD = new THREE.Quaternion(), fD = new THREE.Euler(), ow = new THREE.Vector3(), oo = (o2, t) => new THREE.Vector2(o2, t), De = (o2, t, e) => new THREE.Vector3(o2, t, e), zs = (o2, t, e) => new THREE.BoxGeometry(o2, t, e), Te = (o2, t, e, s = 8e-3, n = 1) => new Ll(o2, t, e, n, Math.min(s, o2 / 2, t / 2, e / 2)), ks = (o2, t, e, s = 12, n = false) => new THREE.CylinderGeometry(o2, t, e, s, 1, n), dr = (o2, t = 12, e = 8) => new THREE.SphereGeometry(o2, t, e), Sa = (o2, t, e = 6, s = 24, n = Vt) => new THREE.TorusGeometry(o2, t, e, s, n), iw = (o2, t, e = 1, s = 1) => new THREE.PlaneGeometry(o2, t, e, s), ke = (o2, t = 16) => new THREE.LatheGeometry(o2.map((e) => oo(e[0], e[1])), t);
function k9(o2, t, e) {
  return cD.set(o2 ? o2[0] : 0, o2 ? o2[1] : 0, o2 ? o2[2] : 0), fD.set(t ? t[0] : 0, t ? t[1] : 0, t ? t[2] : 0, "YXZ"), hD.setFromEuler(fD), typeof e == "number" ? ow.set(e, e, e) : e ? ow.set(e[0], e[1], e[2]) : ow.set(1, 1, 1), new THREE.Matrix4().compose(cD, hD, ow);
}
function rc(o2, t, e) {
  let s = t.clone().normalize(), n = e.clone().addScaledVector(s, -e.dot(s));
  n.lengthSq() < 1e-8 && n.set(1, 0, 0).addScaledVector(s, -s.x), n.normalize();
  let i = new THREE.Vector3().crossVectors(s, n);
  return new THREE.Matrix4().makeBasis(i, s, n).setPosition(o2);
}
function Yi(o2, t) {
  let e = o2.attributes.position, s = new THREE.Vector3();
  for (let n = 0; n < e.count; n++) s.fromBufferAttribute(e, n), t(s), e.setXYZ(n, s.x, s.y, s.z);
  return o2.computeVertexNormals(), o2;
}
function uD(o2, t = false) {
  let e = o2.index ? o2.toNonIndexed() : o2;
  return e.computeVertexNormals(), t && e.setIndex([...Array(e.attributes.position.count).keys()]), e;
}
function pe(o2, t = 42) {
  let e = o2.index ? o2.toNonIndexed() : o2, s = e.attributes.position.array, n = s.length / 9, i = new Float32Array(n * 3), a = new Float32Array(n * 3), r = new Array(n * 3), l = /* @__PURE__ */ new Map();
  for (let f = 0; f < n; f++) {
    let u = f * 9, d = s[u + 3] - s[u], m = s[u + 4] - s[u + 1], p = s[u + 5] - s[u + 2], x = s[u + 6] - s[u], g = s[u + 7] - s[u + 1], b = s[u + 8] - s[u + 2], v = m * b - p * g, y = p * x - d * b, M = d * g - m * x, w = Math.hypot(v, y, M) || 1;
    i[f * 3] = v, i[f * 3 + 1] = y, i[f * 3 + 2] = M, a[f * 3] = v / w, a[f * 3 + 1] = y / w, a[f * 3 + 2] = M / w;
    for (let T = 0; T < 3; T++) {
      let S = u + T * 3, E = Math.round(s[S] * 2e4) + "," + Math.round(s[S + 1] * 2e4) + "," + Math.round(s[S + 2] * 2e4);
      r[f * 3 + T] = E;
      let _ = l.get(E);
      _ || l.set(E, _ = []), _.push(f);
    }
  }
  let c = Math.cos(t * Math.PI / 180), h = new Float32Array(n * 9);
  for (let f = 0; f < n; f++) for (let u = 0; u < 3; u++) {
    let d = l.get(r[f * 3 + u]), m = 0, p = 0, x = 0;
    for (let v = 0; v < d.length; v++) {
      let y = d[v];
      y !== f && a[f * 3] * a[y * 3] + a[f * 3 + 1] * a[y * 3 + 1] + a[f * 3 + 2] * a[y * 3 + 2] < c || (m += i[y * 3], p += i[y * 3 + 1], x += i[y * 3 + 2]);
    }
    let g = Math.hypot(m, p, x) || 1, b = f * 9 + u * 3;
    h[b] = m / g, h[b + 1] = p / g, h[b + 2] = x / g;
  }
  return e.setAttribute("normal", new THREE.BufferAttribute(h, 3)), e;
}
function C9(o2, t, e = 0.01, s = 8, n = 1) {
  return new THREE.ExtrudeGeometry(o2, { depth: t, bevelEnabled: e > 0, bevelThickness: e, bevelSize: e, bevelSegments: n, curveSegments: s, steps: 1 });
}
var Wm = (o2, t, e, s) => C9(o2, t, e, s).rotateY(-Math.PI / 2).translate(t / 2, 0, 0);
function fi(o2, t, e = 4e-3, s = 10, n = 2) {
  let i = Math.min(e, t / 2 - 1e-4), a = new THREE.ExtrudeGeometry(o2, { depth: t - 2 * i, bevelEnabled: i > 0, bevelThickness: i, bevelSize: i, bevelOffset: -i, bevelSegments: n, curveSegments: s, steps: 1 });
  return pe(a.translate(0, 0, i).rotateX(-Math.PI / 2), 50);
}
function Fr(o2, t, e = 4e-3, s = 10, n = 2) {
  let i = Math.min(e, t / 2 - 1e-4), a = new THREE.ExtrudeGeometry(o2, { depth: t - 2 * i, bevelEnabled: i > 0, bevelThickness: i, bevelSize: i, bevelOffset: -i, bevelSegments: n, curveSegments: s, steps: 1 });
  return pe(a.translate(0, 0, i), 50);
}
function ui(o2, t, e) {
  let s = new THREE.Shape(), n = -o2 / 2, i = -t / 2;
  return e = Math.min(e, o2 / 2, t / 2), s.moveTo(n + e, i), s.lineTo(n + o2 - e, i), s.absarc(n + o2 - e, i + e, e, -Math.PI / 2, 0, false), s.lineTo(n + o2, i + t - e), s.absarc(n + o2 - e, i + t - e, e, 0, Math.PI / 2, false), s.lineTo(n + e, i + t), s.absarc(n + e, i + t - e, e, Math.PI / 2, Math.PI, false), s.lineTo(n, i + e), s.absarc(n + e, i + e, e, Math.PI, Math.PI * 1.5, false), s;
}
function dD(o2, t, e = 16) {
  let s = new THREE.SplineCurve(o2.map((a) => oo(a[0], a[1]))), n = [], i = [];
  for (let a = 0; a <= e; a++) {
    let r = a / e, l = s.getPoint(r), c = s.getTangent(r);
    n.push(oo(l.x - c.y * t / 2, l.y + c.x * t / 2)), i.push(oo(l.x + c.y * t / 2, l.y - c.x * t / 2));
  }
  return new THREE.Shape([...n, ...i.reverse()]);
}
var aw = (o2) => o2.isVector3 ? o2.clone() : De(o2[0], o2[1], o2[2]);
function Bj(o2, t = 0.02, e = 4, s = false) {
  let n = o2.map(aw), i = [], a = n.length;
  for (let r = 0; r < a; r++) {
    let l = n[r];
    if (!s && (r === 0 || r === a - 1)) {
      i.push(l.clone());
      continue;
    }
    let c = n[(r - 1 + a) % a], h = n[(r + 1) % a], f = c.clone().sub(l), u = h.clone().sub(l), d = f.length(), m = u.length();
    f.multiplyScalar(1 / d), u.multiplyScalar(1 / m);
    let p = Math.acos(Zt(f.dot(u), -1, 1));
    if (p > Math.PI - 0.02) {
      i.push(l.clone());
      continue;
    }
    let x = Math.min(t / Math.tan(p / 2), d * 0.49, m * 0.49), g = l.clone().addScaledVector(f, x), b = l.clone().addScaledVector(u, x);
    for (let v = 0; v <= e; v++) {
      let y = v / e, M = (1 - y) * (1 - y), w = 2 * y * (1 - y), T = y * y;
      i.push(De(g.x * M + l.x * w + b.x * T, g.y * M + l.y * w + b.y * T, g.z * M + l.z * w + b.z * T));
    }
  }
  return i;
}
function ra(o2, t = 16, e = false) {
  let n = new THREE.CatmullRomCurve3(o2.map(aw), e, "centripetal").getPoints(t);
  return e && n.pop(), n;
}
function Qo(o2, t = 0.01, e = 6, s = false, n = true) {
  let i = o2.map(aw), a = i.length, r = [], l = [], c = [], h = [], f = [];
  for (let x = 0; x < a; x++) {
    let g = i[s ? (x - 1 + a) % a : Math.max(0, x - 1)], b = i[s ? (x + 1) % a : Math.min(a - 1, x + 1)];
    c.push(b.clone().sub(g).normalize());
  }
  let u = Math.abs(c[0].y) < 0.9 ? De(0, 1, 0) : De(1, 0, 0);
  h.push(u.addScaledVector(c[0], -u.dot(c[0])).normalize());
  let d = new THREE.Quaternion();
  for (let x = 1; x < a; x++) d.setFromUnitVectors(c[x - 1], c[x]), h.push(h[x - 1].clone().applyQuaternion(d).normalize());
  if (s) {
    d.setFromUnitVectors(c[a - 1], c[0]);
    let x = h[a - 1].clone().applyQuaternion(d), g = new THREE.Vector3().crossVectors(c[0], h[0]), b = Math.atan2(x.dot(g), x.dot(h[0]));
    for (let v = 1; v < a; v++) h[v].applyAxisAngle(c[v], -b * v / a);
  }
  for (let x = 0; x < a; x++) f.push(new THREE.Vector3().crossVectors(c[x], h[x]));
  for (let x = 0; x < a; x++) {
    let g = typeof t == "function" ? t(x, x / (a - 1)) : t;
    for (let b = 0; b < e; b++) {
      let v = b / e * Vt, y = Math.cos(v) * g, M = Math.sin(v) * g;
      r.push(i[x].x + h[x].x * y + f[x].x * M, i[x].y + h[x].y * y + f[x].y * M, i[x].z + h[x].z * y + f[x].z * M);
    }
  }
  let m = s ? a : a - 1;
  for (let x = 0; x < m; x++) for (let g = 0; g < e; g++) {
    let b = x * e + g, v = x * e + (g + 1) % e, y = (x + 1) % a * e + g, M = (x + 1) % a * e + (g + 1) % e;
    l.push(b, v, y, v, M, y);
  }
  if (!s && n) {
    let x = r.length / 3;
    r.push(i[0].x, i[0].y, i[0].z);
    let g = x + 1;
    r.push(i[a - 1].x, i[a - 1].y, i[a - 1].z);
    for (let b = 0; b < e; b++) l.push(x, (b + 1) % e, b), l.push(g, (a - 1) * e + b, (a - 1) * e + (b + 1) % e);
  }
  let p = new THREE.BufferGeometry();
  return p.setAttribute("position", new THREE.Float32BufferAttribute(r, 3)), p.setIndex(l), p.computeVertexNormals(), n && !s ? pe(p, 60) : p;
}
var lc = (o2, t, e = 0.03, s = 8, n = false, i = 5) => Qo(Bj(o2, e, i, n), t, s, n);
function _i(o2, t, { closed: e = true, up: s = qa, profClosed: n = true, deg: i = 40, caps: a = true } = {}) {
  let r = t.map(aw), l = r.length, c = o2.length, h = [], f = [], u = s.clone().normalize(), d = new THREE.Vector3(), m = new THREE.Vector3(), p = new THREE.Vector3(), x = new THREE.Vector3(), g = new THREE.Vector3();
  for (let M = 0; M < l; M++) {
    let w = e || M > 0, T = e || M < l - 1;
    w && d.subVectors(r[M], r[(M - 1 + l) % l]).normalize(), T && m.subVectors(r[(M + 1) % l], r[M]).normalize(), w || d.copy(m), T || m.copy(d), p.crossVectors(d, u).normalize(), x.crossVectors(m, u).normalize(), g.addVectors(p, x).normalize();
    let S = 1 / Math.max(0.3, g.dot(p));
    for (let [E, _] of o2) h.push(r[M].x + g.x * E * S + u.x * _, r[M].y + g.y * E * S + u.y * _, r[M].z + g.z * E * S + u.z * _);
  }
  let b = e ? l : l - 1, v = n ? c : c - 1;
  for (let M = 0; M < b; M++) for (let w = 0; w < v; w++) {
    let T = M * c + w, S = M * c + (w + 1) % c, E = (M + 1) % l * c + w, _ = (M + 1) % l * c + (w + 1) % c;
    f.push(T, S, E, S, _, E);
  }
  if (!e && a && n) {
    let M = THREE.ShapeUtils.triangulateShape(o2.map((w) => oo(w[0], w[1])), []);
    for (let w of M) f.push(w[0], w[1], w[2]), f.push((l - 1) * c + w[2], (l - 1) * c + w[1], (l - 1) * c + w[0]);
  }
  let y = new THREE.BufferGeometry();
  return y.setAttribute("position", new THREE.Float32BufferAttribute(h, 3)), y.setIndex(f), y = y.toNonIndexed(), Eb(y) < 0 && q2(y), pe(y, i);
}
function Dl(o2, t, e, s = 40) {
  let n = [[-o2 / 2, -t / 2, 0], [o2 / 2, -t / 2, 0], [o2 / 2, t / 2, 0], [-o2 / 2, t / 2, 0]];
  return _i(e.map(([i, a]) => [-i, a]), n, { closed: true, up: De(0, 0, 1), deg: s });
}
function di(o2, t, e, s = 0, n = 5, i = "xz") {
  let a = o2 / 2 - e, r = t / 2 - e, l = [];
  for (let c = 0; c < 4; c++) {
    let h = c === 0 || c === 3 ? a : -a, f = c < 2 ? r : -r;
    for (let u = 0; u <= n; u++) {
      let d = (c + u / n) * Math.PI / 2, m = h + Math.cos(d) * e, p = f + Math.sin(d) * e;
      l.push(i === "xz" ? De(m, s, p) : i === "xy" ? De(m, p, s) : De(s, p, m));
    }
  }
  return l;
}
var P9 = (o2, t = 0, e = 24) => Array.from({ length: e }, (s, n) => De(Math.sin(n / e * Vt) * o2, t, Math.cos(n / e * Vt) * o2));
function Eb(o2) {
  let t = o2.attributes.position.array, e = 0;
  for (let s = 0; s < t.length; s += 9) e += t[s] * (t[s + 4] * t[s + 8] - t[s + 5] * t[s + 7]) - t[s + 1] * (t[s + 3] * t[s + 8] - t[s + 5] * t[s + 6]) + t[s + 2] * (t[s + 3] * t[s + 7] - t[s + 4] * t[s + 6]);
  return e / 6;
}
function q2(o2) {
  for (let t of ["position", "normal", "uv"]) {
    let e = o2.attributes[t];
    if (!e) continue;
    let s = e.itemSize, n = e.array;
    for (let i = 0; i < n.length; i += s * 3) for (let a = 0; a < s; a++) {
      let r = n[i + s + a];
      n[i + s + a] = n[i + 2 * s + a], n[i + 2 * s + a] = r;
    }
  }
  return o2;
}
function cu(o2) {
  let t = o2.index ? o2 : a9(o2), e = t.clone(), s = e.index.array, n = e.attributes.normal.array;
  for (let i = 0; i < s.length; i += 3) {
    let a = s[i + 1];
    s[i + 1] = s[i + 2], s[i + 2] = a;
  }
  for (let i = 0; i < n.length; i++) n[i] = -n[i];
  return Vn([t, e], false);
}
function Jo(o2, t, e, s = {}) {
  let n = [o2 / 2, t / 2, e / 2], i = Math.min(s.r ?? 0.03, n[0] * 0.98, n[1] * 0.98, n[2] * 0.98), a = typeof s.seg == "number" ? [s.seg, s.seg, s.seg] : s.seg || [6, 3, 6], r = Math.max(1, Math.round((s.arc || 2) / 2)), l = [0, 1, 2].map((S) => {
    let E = [], _ = n[S] - i, R = Math.max(1, a[S]);
    for (let C = r; C >= 1; C--) E.push(-(_ + i * Math.tan(Math.PI / 4 * C / r)));
    for (let C = 0; C <= R; C++) E.push(-_ + 2 * _ * C / R);
    for (let C = 1; C <= r; C++) E.push(_ + i * Math.tan(Math.PI / 4 * C / r));
    return E;
  }), c = l.map((S) => S.length - 1), h = new THREE.BoxGeometry(1, 1, 1, c[0], c[1], c[2]);
  h.deleteAttribute("normal"), h.deleteAttribute("uv"), h = a9(h, 1e-4);
  let f = s.crown || 0, u = typeof f == "number" ? [0, 0, f, f, 0, 0] : Array.isArray(f) ? [f[0], f[0], f[1], f[1], f[2], f[2]] : [f.px || 0, f.nx || 0, f.py || 0, f.ny || 0, f.pz || 0, f.nz || 0], d = s.plateau || 2.4, m = s.lump || 0, p = s.lumpScale || 7, x = m ? _n(s.seed || 7) : null, g = h.attributes.position, b = [0, 0, 0], v = [0, 0, 0], y = [0, 0, 0], M = new THREE.Vector3(), w = new THREE.Vector3(), T = [0, 0, 0];
  for (let S = 0; S < g.count; S++) {
    let E = [g.getX(S), g.getY(S), g.getZ(S)], _ = 0;
    for (let R = 0; R < 3; R++) b[R] = l[R][Math.round((E[R] + 0.5) * c[R])], v[R] = Zt(b[R], -(n[R] - i), n[R] - i), _ += (b[R] - v[R]) ** 2;
    _ = Math.sqrt(_) || 1;
    for (let R = 0; R < 3; R++) y[R] = (b[R] - v[R]) / _, b[R] = v[R] + y[R] * i, T[R] = b[R] / n[R];
    for (let R = 0; R < 3; R++) {
      let C = y[R] >= 0 ? u[R * 2] : u[R * 2 + 1];
      if (!C) continue;
      let L = (R + 1) % 3, A = (R + 2) % 3, O = y[R] * y[R];
      b[R] += Math.sign(y[R]) * C * O * (1 - Math.pow(Math.abs(T[L]), d)) * (1 - Math.pow(Math.abs(T[A]), d));
    }
    if (M.set(b[0], b[1], b[2]), w.set(y[0], y[1], y[2]), s.sculpt && s.sculpt(M, w, T), x) {
      let R = (x.fbm(M.x * p + M.z * p * 0.63 + 11, M.y * p - M.z * p * 0.41 + 5, 3) - 0.5) * 2 * m;
      M.addScaledVector(w, R);
    }
    g.setXYZ(S, M.x, M.y, M.z);
  }
  return h.computeVertexNormals(), h;
}
function Id(o2, t, e, s, n = "tb", i = 45e-4, a = 4, r = 5, l = 0.55) {
  let c = [o2 / 2, t / 2, e / 2], h = Math.SQRT1_2, f = [];
  s = Math.min(s, c[0] * 0.98, c[1] * 0.98, c[2] * 0.98);
  for (let u of n) {
    let d = "rltbfk".indexOf(u) >> 1, m = "rltbfk".indexOf(u) % 2 ? -1 : 1, p = (d + 1) % 3, x = (d + 2) % 3, g = [];
    for (let b = 0; b < 4; b++) {
      let v = (b === 0 || b === 3 ? 1 : -1) * (c[p] - s), y = (b < 2 ? 1 : -1) * (c[x] - s);
      for (let M = 0; M <= a; M++) {
        let w = (b + M / a) * Math.PI / 2, T = [0, 0, 0], S = s + i * l;
        T[d] = m * (c[d] - s + S * h), T[p] = v + Math.cos(w) * S * h, T[x] = y + Math.sin(w) * S * h, g.push(De(T[0], T[1], T[2]));
      }
    }
    f.push(Qo(g, i, r, true));
  }
  return f.length > 1 ? Vn(f, false) : f[0];
}
var rw = (o2, t, e, s) => {
  let n = 0;
  for (let i of e) {
    let a = ((o2 - i[0]) ** 2 + (t - i[1]) ** 2) / (s * s);
    a < 4 && (n = Math.max(n, Math.exp(-a * 1.6)));
  }
  return n;
}, lw = (o2, t, e = 0.6) => Math.pow(Math.abs(Math.sin(Math.PI * o2 / t)), e);
function pD(o2, t, e, { seg: s = 8, pinch: n = 0.05, plump: i = 2.2, lump: a = 4e-3, seed: r = 3 } = {}) {
  let l = s + 1, c = [], h = [], f = _n(r), u = new Int32Array(l * l), d = (b, v, y) => {
    let M = Math.sin((b / s * 2 - 1) * Math.PI / 2), w = Math.sin((v / s * 2 - 1) * Math.PI / 2), T = Math.pow(1 - Math.pow(Math.abs(M), i), 0.62) * Math.pow(1 - Math.pow(Math.abs(w), i), 0.62), S = (f.fbm(M * 2.3 + 9 + y * 3, w * 2.3 + 4, 3) - 0.5) * 2 * a;
    return c.push(M * o2 / 2 * (1 - n * (1 - w * w)), w * t / 2 * (1 - n * (1 - M * M)), y * (e / 2 + S) * T), c.length / 3 - 1;
  }, m = [];
  for (let b = 0; b < l; b++) for (let v = 0; v < l; v++) m.push(d(v, b, 1));
  for (let b = 0; b < l; b++) for (let v = 0; v < l; v++) u[b * l + v] = v === 0 || b === 0 || v === s || b === s ? m[b * l + v] : d(v, b, -1);
  for (let b = 0; b < s; b++) for (let v = 0; v < s; v++) {
    let y = b * l + v, M = y + 1, w = y + l, T = w + 1;
    h.push(m[y], m[M], m[w], m[M], m[T], m[w]), h.push(u[y], u[w], u[M], u[M], u[w], u[T]);
  }
  let p = new THREE.BufferGeometry();
  p.setAttribute("position", new THREE.Float32BufferAttribute(c, 3)), p.setIndex(h), p.computeVertexNormals();
  let x = [], g = (b, v) => {
    let y = m[v * l + b] * 3;
    return De(c[y], c[y + 1], c[y + 2]);
  };
  for (let b = 0; b < s; b++) x.push(g(b, 0));
  for (let b = 0; b < s; b++) x.push(g(s, b));
  for (let b = s; b > 0; b--) x.push(g(b, s));
  for (let b = s; b > 0; b--) x.push(g(0, b));
  return p.userData.edge = x, p;
}
function Uj(o2, t) {
  let e = o2.attributes.position.array, s = o2.attributes.uv.array;
  for (let n = 0, i = 0; n < e.length; n += 9, i += 6) {
    let a = e[n + 3] - e[n], r = e[n + 4] - e[n + 1], l = e[n + 5] - e[n + 2], c = e[n + 6] - e[n], h = e[n + 7] - e[n + 1], f = e[n + 8] - e[n + 2], u = Math.abs(r * f - l * h), d = Math.abs(l * c - a * f), m = Math.abs(a * h - r * c), p = u >= d && u >= m ? 0 : d >= m ? 1 : 2;
    for (let x = 0; x < 3; x++) {
      let g = e[n + x * 3], b = e[n + x * 3 + 1], v = e[n + x * 3 + 2], y, M;
      p === 0 ? t === "y" ? (y = b, M = v) : (y = v, M = b) : p === 1 ? t === "z" ? (y = v, M = g) : (y = g, M = v) : t === "y" ? (y = b, M = g) : (y = g, M = b), s[i + x * 2] = y, s[i + x * 2 + 1] = M;
    }
  }
}
function Vj(o2) {
  let t = _L(o2.geo.clone());
  if (o2.m && (t.applyMatrix4(o2.m), o2.m.determinant() < 0 && q2(t)), o2.uv !== true && (Uj(t, typeof o2.uv == "string" ? o2.uv : null), Array.isArray(o2.uv))) {
    let e = t.attributes.uv.array;
    for (let s = 0; s < e.length; s += 2) e[s] += o2.uv[0], e[s + 1] += o2.uv[1];
  }
  return t;
}
function Gj() {
  let o2 = [], t = [], e = { parts: o2, keeps: t, cast: true, add(s, n, i, a, r, l) {
    return o2.push({ geo: s, mat: n, m: k9(i, a, r), uv: l }), e;
  }, addM(s, n, i, a) {
    return o2.push({ geo: s, mat: n, m: i || new THREE.Matrix4(), uv: a }), e;
  }, rod(s, n, i, a, r = 8, l = a, c) {
    let h = De(n[0], n[1], n[2]), f = De(i[0], i[1], i[2]), u = f.clone().sub(h), d = u.length(), m = new THREE.Quaternion().setFromUnitVectors(qa, u.normalize());
    return o2.push({ geo: ks(l, a, d, r), mat: s, m: new THREE.Matrix4().compose(h.add(f).multiplyScalar(0.5), m, De(1, 1, 1)), uv: c }), e;
  }, keep(s, n, i, a, r, l, c = {}) {
    return t.push({ name: s, geo: n, mat: i, m: c.m || k9(a, r, l), uv: c.uv, clone: c.clone !== false }), e;
  }, at(s, n, i, a) {
    typeof n == "function" ? (a = n, n = null, i = null) : typeof i == "function" && (a = i, i = null);
    let r = s && s.isMatrix4 ? s : k9(s, n, i), l = o2.length, c = t.length;
    a(e);
    for (let h = l; h < o2.length; h++) o2[h].m = r.clone().multiply(o2[h].m);
    for (let h = c; h < t.length; h++) t[h].m = r.clone().multiply(t[h].m);
    return e;
  }, shift(s, n, i) {
    let a = new THREE.Matrix4().makeTranslation(s, n, i);
    for (let r of [...o2, ...t]) r.m = a.clone().multiply(r.m);
    return e;
  } };
  return e;
}
function Wj(o2, t) {
  let e = (n, i) => {
    let a = /* @__PURE__ */ new Map();
    for (let r of n) {
      let l = i(r);
      a.has(l) || a.set(l, { first: r, geos: [] }), a.get(l).geos.push(Vj(r));
    }
    return [...a.values()].map(({ first: r, geos: l }) => {
      let c = l.length > 1 ? Vn(l, false) : l[0];
      if (l.length > 1) for (let h of l) h.dispose();
      return c.computeBoundingSphere(), c.computeBoundingBox(), { geometry: c, material: r.mat, name: r.name, clone: r.clone };
    });
  }, s = { meshes: e(o2.parts, (n) => n.mat.uuid), keeps: e(o2.keeps, (n) => n.name + "|" + n.mat.uuid), ud: t, cast: o2.cast, tris: 0 };
  for (let n of [...s.meshes, ...s.keeps]) s.tris += n.geometry.attributes.position.count / 3;
  return s;
}
function qj(o2) {
  let t = new THREE.Group();
  t.name = o2.ud.kind;
  for (let s of o2.meshes) {
    let n = new THREE.Mesh(s.geometry, s.material);
    n.castShadow = o2.cast && !s.material.transparent, n.receiveShadow = true, t.add(n);
  }
  for (let s of o2.keeps) {
    let n = new THREE.Mesh(s.geometry, s.clone ? s.material.clone() : s.material);
    n.name = s.name, n.userData.keep = true, n.castShadow = false, n.receiveShadow = false, t.add(n);
  }
  let e = o2.ud;
  return t.userData = { ...e, size: [...e.size], tris: o2.tris, colliders: e.colliders.map((s) => ({ min: [...s.min], max: [...s.max] })), light: e.light ? { ...e.light, pos: [...e.light.pos] } : void 0 }, t;
}
var $s = (o2, t, e, s, n, i) => ({ min: [o2, t, e], max: [s, n, i] }), rs = (o2, t, e = {}) => ({ kind: o2, size: t, colliders: [], surf: "wood", dynamic: false, mass: 10, breakable: null, ...e });
function ll(o2, { srgb: t = true, tile: e = null, aniso: s = 8, repeatU: n = false } = {}) {
  const i = o2 && o2.__isNodeCanvas
    ? new THREE.DataTexture(new Uint8Array(o2.__data.buffer), o2.width, o2.height, THREE.RGBAFormat, THREE.UnsignedByteType)
    : new THREE.CanvasTexture(o2);
  if (t) i.colorSpace = THREE.SRGBColorSpace;
  i.anisotropy = s;
  i.generateMipmaps = true;
  i.magFilter = THREE.LinearFilter;
  i.minFilter = THREE.LinearMipmapLinearFilter;
  if (e) {
    const a = Array.isArray(e) ? e[0] : e;
    const r = Array.isArray(e) ? e[1] : e;
    i.wrapS = i.wrapT = THREE.RepeatWrapping;
    i.repeat.set(1 / a, 1 / r);
  }
  if (n) i.wrapS = THREE.RepeatWrapping;
  i.needsUpdate = true;
  return i;
}
var hu = (o2, t, e, s, n, i) => [o2 / n, 1 - (t + s) / i, (o2 + e) / n, 1 - t / i];
function cc(o2, t, e = [0, 0, 1, 1], s = 1, n = 1) {
  let i = new THREE.PlaneGeometry(o2, t, s, n), a = i.attributes.uv;
  for (let r = 0; r < a.count; r++) a.setXY(r, e[0] + (e[2] - e[0]) * a.getX(r), e[1] + (e[3] - e[1]) * a.getY(r));
  return i;
}
function Hd(o2, t = 2, e = true) {
  let s = o2.width, n = o2.height, i = o2.getContext("2d").getImageData(0, 0, s, n).data, a = we(s, n), r = a.getContext("2d"), l = r.createImageData(s, n), c = l.data, h = (f, u) => (e ? (f = (f + s) % s, u = (u + n) % n) : (f = Zt(f, 0, s - 1), u = Zt(u, 0, n - 1)), i[(u * s + f) * 4] / 255);
  for (let f = 0; f < n; f++) for (let u = 0; u < s; u++) {
    let d = (h(u + 1, f) - h(u - 1, f)) * t, m = (h(u, f + 1) - h(u, f - 1)) * t, p = 1 / Math.hypot(d, m, 1), x = (f * s + u) * 4;
    c[x] = (-d * p * 0.5 + 0.5) * 255, c[x + 1] = (m * p * 0.5 + 0.5) * 255, c[x + 2] = (p * 0.5 + 0.5) * 255, c[x + 3] = 255;
  }
  return r.putImageData(l, 0, 0), a;
}
function Kj(o2 = 1024) {
  let t = Re(91), e = we(o2, o2), s = e.getContext("2d"), n = 118, i = o2 / n;
  s.fillStyle = "#2a2a2a", s.fillRect(0, 0, o2, o2), s.globalCompositeOperation = "lighten";
  for (let l = 0; l < n; l++) for (let c = 0; c < n; c++) {
    let h = (c + 0.5 + (t() - 0.5) * 0.95) * i, f = (l + 0.5 + (t() - 0.5) * 0.95) * i, u = i * (0.62 + t() * 0.5), d = 150 + t() * 100 | 0;
    for (let m of h < u ? [0, o2] : h > o2 - u ? [0, -o2] : [0]) for (let p of f < u ? [0, o2] : f > o2 - u ? [0, -o2] : [0]) {
      let x = s.createRadialGradient(h + m, f + p, u * 0.15, h + m, f + p, u);
      x.addColorStop(0, `rgb(${d},${d},${d})`), x.addColorStop(0.55, `rgb(${d * 0.86 | 0},${d * 0.86 | 0},${d * 0.86 | 0})`), x.addColorStop(1, "rgb(20,20,20)"), s.fillStyle = x, s.beginPath(), s.ellipse(h + m, f + p, u, u * (0.8 + t() * 0.3), t() * 3.14, 0, Vt), s.fill();
    }
  }
  s.globalCompositeOperation = "multiply";
  for (let l = 0; l < 46; l++) {
    let c = t() * o2, h = t() * o2, f = t() * Vt, u = 40 + t() * 150, d = 1.2 + t() * 2.2;
    for (let m of [-o2, 0, o2]) for (let p of [-o2, 0, o2]) {
      let x = c + m, g = h + p, b = f, v = Re(l * 13 + 5);
      s.strokeStyle = `rgba(60,60,60,${0.35 + t() * 0.3})`, s.lineWidth = d, s.lineCap = "round", s.beginPath(), s.moveTo(x, g);
      for (let y = 0; y < u; y += 8) b += (v() - 0.5) * 0.5, x += Math.cos(b) * 8, g += Math.sin(b) * 8, s.lineTo(x, g);
      s.stroke();
    }
  }
  s.globalCompositeOperation = "source-over";
  let a = we(o2, o2), r = a.getContext("2d");
  r.drawImage(e, 0, 0), r.globalCompositeOperation = "difference", r.fillStyle = "#fff", r.fillRect(0, 0, o2, o2), r.globalCompositeOperation = "source-over", r.fillStyle = "rgba(172,172,172,0.72)", r.fillRect(0, 0, o2, o2);
  for (let l = 0; l < 60; l++) {
    let c = t() * o2, h = t() * o2, f = 60 + t() * 160, u = r.createRadialGradient(c, h, 0, c, h, f), d = t() < 0.5 ? 255 : 60;
    u.addColorStop(0, `rgba(${d},${d},${d},0.07)`), u.addColorStop(1, `rgba(${d},${d},${d},0)`), r.fillStyle = u, r.fillRect(c - f, h - f, 2 * f, 2 * f);
  }
  return { normalMap: ll(Hd(e, 2.2), { srgb: false, tile: 0.3 }), roughnessMap: ll(a, { srgb: false, tile: 0.3 }) };
}
function mD(o2, t) {
  let e = /* @__PURE__ */ new Map(), s = /* @__PURE__ */ new Map(), n = {}, i = (h, f) => {
    if (!s.has(h)) {
      let u = f();
      u.name = u.name || "prop:" + h, s.set(h, u), n[h] = u;
    }
    return s.get(h);
  };
  function a(h, f, u) {
    t[h] = (d = {}) => {
      let m = h + "|" + (f ? f(d) : ""), p = e.get(m);
      if (!p) {
        let x = Gj();
        p = Wj(x, u(x, d)), e.set(m, p);
      }
      return qj(p);
    }, t[h].hero = true;
  }
  let r = (h, f) => o2[h] || o2[f], l = null;
  return { M: o2, P: t, L: n, _geoCache: e, _matCache: s, def: a, lib: i, mt: r, fine: (h) => {
    let f = typeof h == "string" ? h : h && h.name, u = o2[f];
    return o2.isLite || (u && u.ghUniforms) || (f !== "leatherTan" && f !== "leatherBlack") ? u || h : i(f + "Fine", () => {
      l = l || Kj();
      let d = u.clone();
      return d.normalMap = l.normalMap, d.roughnessMap = l.roughnessMap, d.normalScale = new THREE.Vector2(0.55, 0.55), d.roughness = f === "leatherBlack" ? 0.94 : 1, d.name = f + "Fine", d;
    });
  } };
}
function gD({ M: o2, def: t, lib: e, mt: s, fine: n }) {
  let i = (f, u, [d, m, p], x, g, b, v, y) => {
    let M = Jo(d, m, p, x);
    if (y && Yi(M, y), f.add(M, u, b, v), g) {
      let w = Id(d, m, p, x.r ?? 0.03, g, x.pr || 45e-4, (x.r ?? 0.03) > 0.05 ? 5 : 3, x.prs || 5);
      y && Yi(w, y), f.add(w, u, b, v);
    }
  }, a = (f, u, d, m, p, x, g) => {
    let b = pD(d, d, m, { seg: 8, seed: g, pinch: 0.075, lump: 0.01, plump: 2 });
    f.add(b, u, p, x), f.add(Qo(b.userData.edge, 4e-3, 5, true), u, p, x);
  }, r = (f, u, d, m, p = 0.024, x = 0.014) => f.add(pe(ke([[0, 0], [x * 0.8, 0], [x + 15e-4, 2e-3], [x + 15e-4, 0.012], [x, 0.014], [x + (p - x) * 0.1, 0.02], [p, m - 0.022], [p + 3e-3, m - 0.02], [p + 3e-3, m - 0.012], [p, m - 0.01], [p + 0.012, m - 6e-3], [p + 0.014, m - 4e-3], [p + 0.014, m], [0, m]], 14), 38), o2.brass, [u, 0, d]);
  function l(f, { seats: u, seatW: d, armW: m, d: p, mat: x, pillowMats: g }) {
    let b = u * d + m * 2, v = 0.12, y = 0.2, M = v + y, w = Re(u * 7 + Math.round(p * 100)), T = b / 2 - 0.08, S = p / 2 - 0.08;
    for (let E of [-1, 1]) for (let _ of [-1, 1]) r(f, E * T, _ * S, v + 0.012);
    if (u > 2) for (let E of [-1, 1]) r(f, 0, E * S, v + 0.012);
    f.add(Te(b - 0.1, 0.028, p - 0.11, 4e-3), o2.woodDark, [0, v + 6e-3, 0], null, null, "x"), i(f, x, [b - 0.02, y, p - 0.03], { r: 0.03, seg: [8, 1, 3], arc: 2, crown: { pz: 4e-3 }, lump: 15e-4, seed: 3 }, "tb", [0, v + y / 2, 0]), i(f, x, [b - m * 2 + 0.06, 0.52, 0.16], { r: 0.055, seg: [8, 4, 1], arc: 4, crown: { nz: 6e-3 }, lump: 2e-3, seed: 5 }, "k", [0, M + 0.24, -p / 2 + 0.105], [-0.1, 0, 0]);
    for (let E of [-1, 1]) i(f, x, [m, 0.36, p - 0.02], { r: 0.07, seg: [2, 3, 8], arc: 4, crown: [6e-3, 0.012, 4e-3], plateau: 3, lump: 2e-3, seed: 11 + E }, "fk", [E * (b / 2 - m / 2), M + 0.16, 0], null, (_) => {
      let R = Zt((_.y + 0.18) / 0.36, 0, 1);
      _.x *= 0.955 + 0.045 * R;
    });
    for (let E = 0; E < u; E++) {
      let _ = (E - (u - 1) / 2) * d, R = 20 + E * 3 + u;
      i(f, x, [d - 0.012, 0.15, p - 0.3], { r: 0.045, seg: [7, 2, 7], arc: 4, crown: { py: 0.022, pz: 0.01, px: 3e-3, nx: 3e-3 }, plateau: 2.6, lump: 35e-4, lumpScale: 6, seed: R, sculpt: (C, L, A) => {
        L.y > 0.3 && (C.y -= 4e-3 * Math.max(0, 1 - (A[0] * A[0] + (A[2] + 0.15) * (A[2] + 0.15)) * 2.2) * w.range(0.5, 1));
      } }, "tb", [_, M + 0.06, 0.085], [0, w.range(-6e-3, 6e-3), 0]), i(f, x, [d - 0.02, 0.44, 0.17], { r: 0.065, seg: [6, 5, 1], arc: 4, crown: { pz: 0.032, nz: 8e-3, py: 8e-3 }, plateau: 2.2, lump: 5e-3, lumpScale: 5, seed: R + 40 }, "f", [_, M + 0.335, -p / 2 + 0.26], [-0.2, 0, w.range(-0.012, 0.012)], (C) => {
        let L = Zt(C.y / 0.44 + 0.5, 0, 1);
        C.z *= 1.06 - 0.16 * L, C.z += 0.012 * Math.sin(L * Math.PI);
      });
    }
    return g.forEach((E, _) => {
      let R = _ % 2 ? 1 : -1, C = _ < 2, L = u > 1 ? R * (b / 2 - m - (C ? 0.2 : 0.42)) : 0.02;
      a(f, n(E), C ? 0.43 : 0.35, C ? 0.15 : 0.13, [L, M + (C ? 0.34 : 0.3), -p / 2 + (C ? 0.42 : 0.47)], [-0.32, R * -0.35, R * 0.12], 30 + _);
    }), b;
  }
  let c = { leatherTan: ["velvetTeal", "fabricCream"], leatherBlack: ["fabricCream", "velvetTeal"], velvetTeal: ["fabricCream", "leatherTan"], fabricCream: ["velvetTeal", "fabricCharcoal"], fabricCharcoal: ["fabricCream", "velvetTeal"] }, h = (f) => c[f.mat] ? f.mat : "leatherTan";
  t("sofa", (f) => `${f.seats === 2 ? 2 : 3}${h(f)}`, (f, u) => {
    let d = u.seats === 2 ? 2 : 3, m = h(u), p = 0.94, x = c[m].map((b) => o2[b]), g = l(f, { seats: d, seatW: 0.68, armW: 0.2, d: p, mat: n(m), pillowMats: d === 3 ? [x[0], x[1], x[1]] : [x[0], x[1]] });
    return rs("sofa", [g, 0.88, p], { surf: "fabric", mass: 55 + d * 12, colliders: [$s(-g / 2, 0, -p / 2, g / 2, 0.47, p / 2), $s(-g / 2, 0.47, -p / 2, g / 2, 0.86, -p / 2 + 0.3)] });
  }), t("armchair", (f) => h(f), (f, u) => {
    let d = h(u), m = 0.88, p = l(f, { seats: 1, seatW: 0.6, armW: 0.17, d: m, mat: n(d), pillowMats: [o2[c[d][0]]] });
    return rs("armchair", [p, 0.88, m], { surf: "fabric", mass: 38, colliders: [$s(-p / 2, 0, -m / 2, p / 2, 0.47, m / 2), $s(-p / 2, 0.47, -m / 2, p / 2, 0.86, -m / 2 + 0.3)] });
  }), t("loungeChair", (f) => s(f.mat, "velvetTeal") === o2[f.mat] ? f.mat : "velvetTeal", (f, u) => {
    let d = n(s(u.mat, "velvetTeal")), m = o2.woodDark, p = [[0.4, 0.375], [0.24, 0.392], [-0.06, 0.36], [-0.25, 0.375], [-0.36, 0.5], [-0.42, 0.7], [-0.47, 0.9]];
    f.add(pe(Yi(Wm(dD(p, 0.022, 30), 0.63, 5e-3, 1), (v) => {
      let y = Zt((v.y - 0.48) / 0.42, 0, 1), M = Zt((v.z - 0.2) / 0.2, 0, 1);
      v.x *= 1 - 0.16 * y * y - 0.05 * M * M;
    }), 55), m, null, null, null, "z");
    for (let v of [-0.13, 0.13]) for (let [y, M] of [[0.6, -0.398], [0.8, -0.452]]) f.add(pe(ke([[0, 0], [0.011, 0], [0.011, 3e-3], [6e-3, 7e-3], [0, 8e-3]], 10), 50), o2.brass, [v, y, M], [-Math.PI / 2 - 0.3, 0, 0]);
    let x = [[-0.13, 0.02], [0.13, 0.02]], g = (v, y) => (M, w) => {
      if ((y === "y" ? w.y : w.z) > 0.3) {
        let S = rw(M.x, y === "y" ? M.z : M.y, v, 0.055);
        y === "y" ? M.y -= 0.013 * S : M.z -= 0.013 * S;
      }
    };
    i(f, d, [0.56, 0.075, 0.52], { r: 0.03, seg: [8, 1, 8], arc: 4, crown: { py: 0.014, pz: 6e-3 }, plateau: 2.6, lump: 3e-3, seed: 3, sculpt: g(x, "y") }, "tb", [0, 0.425, 0.1], [0.06, 0, 0]), f.at([0, 0.425, 0.1], [0.06, 0, 0], () => {
      for (let [v, y] of x) f.add(dr(0.011, 8, 5), d, [v, 0.04, y], null, [1, 0.45, 1]);
    });
    let b = [[-0.13, 0.05], [0.13, 0.05]];
    i(f, d, [0.54, 0.44, 0.075], { r: 0.03, seg: [8, 6, 1], arc: 4, crown: { pz: 0.016, py: 4e-3 }, plateau: 2.4, lump: 3e-3, seed: 5, sculpt: g(b, "z") }, "fk", [0, 0.66, -0.345], [-0.33, 0, 0], (v) => {
      v.x *= 1 - 0.1 * Zt(v.y / 0.44 + 0.5, 0, 1);
    }), f.at([0, 0.66, -0.345], [-0.33, 0, 0], () => {
      for (let [v, y] of b) f.add(dr(0.011, 8, 5), d, [v * 0.95, y, 0.0415], null, [1, 1, 0.45]);
    }), i(f, d, [0.36, 0.11, 0.07], { r: 0.034, seg: [4, 1, 1], arc: 4, crown: { pz: 0.012 }, lump: 2e-3, seed: 8 }, "f", [0, 0.86, -0.415], [-0.26, 0, 0]);
    for (let v of [-1, 1]) {
      for (let [y, M] of [[[0.24, 0.372, 0.24], [0.3, 0, 0.33]], [[0.24, 0.372, -0.2], [0.3, 0, -0.36]]]) {
        let w = De(v * y[0], y[1], y[2]), T = De(v * M[0], M[1], M[2]), S = (E) => w.clone().lerp(T, E).toArray();
        f.rod(m, S(0), S(0.9), 0.021, 10, 0.0138, "y"), f.rod(o2.brass, S(0.86), S(0.995), 0.0152, 10, 0.0128), f.rod(o2.brass, S(0.995), S(1), 0.013, 10, 0.011);
      }
      f.add(Te(0.028, 0.04, 0.47, 8e-3), m, [v * 0.243, 0.352, 0.02], null, null, "z"), f.rod(m, [v * 0.268, 0.2, 0.285], [v * 0.268, 0.2, -0.28], 9e-3, 8, 9e-3, "z"), f.add(lc([[v * 0.262, 0.345, 0.3], [v * 0.345, 0.36, 0.305], [v * 0.345, 0.6, 0.31], [v * 0.345, 0.6, -0.19], [v * 0.338, 0.47, -0.36]], 0.0105, 0.045, 7), o2.brass), f.add(Yi(Jo(0.062, 0.024, 0.36, { r: 0.011, seg: [1, 1, 5], arc: 2, crown: 2e-3 }), (y) => {
        y.x *= 1 - 0.3 * Math.pow(Math.abs(y.z) / 0.18, 2.2);
      }), m, [v * 0.345, 0.6185, 0.035], null, null, "z");
      for (let y of [-0.07, 0.14]) f.add(ks(4e-3, 4e-3, 0.012, 6), o2.brass, [v * 0.345, 0.607, y]);
    }
    return f.add(Te(0.5, 0.036, 0.026, 8e-3), m, [0, 0.352, 0.23], null, null, "x"), f.add(Te(0.5, 0.036, 0.026, 8e-3), m, [0, 0.352, -0.19], null, null, "x"), f.rod(o2.brass, [-0.268, 0.2, 0.02], [0.268, 0.2, 0.02], 7e-3, 8), rs("loungeChair", [0.72, 0.92, 0.9], { surf: "fabric", mass: 18, colliders: [$s(-0.34, 0, -0.42, 0.34, 0.46, 0.4), $s(-0.34, 0.46, -0.48, 0.34, 0.9, -0.24)] });
  }), t("diningChair", (f) => s(f.mat, "velvetTeal") === o2[f.mat] ? f.mat : "velvetTeal", (f, u) => {
    let d = n(s(u.mat, "velvetTeal")), m = o2.woodDark, p = (g) => {
      g.z += 0.7 * g.x * g.x;
    };
    f.add(_i([[0, -0.024], [2e-3, -0.026], [0.02, -0.026], [0.022, -0.024], [0.022, 0.02], [0.02, 0.022], [2e-3, 0.022], [0, 0.02]].map(([g, b]) => [g - 0.011, b]), di(0.425, 0.415, 0.03, 0.405, 3), { deg: 50 }), m, null, null, null, "x"), i(f, d, [0.45, 0.075, 0.44], { r: 0.03, seg: [4, 1, 4], arc: 4, crown: { py: 0.014, pz: 4e-3 }, plateau: 2.5, lump: 25e-4, seed: 4 }, "t", [0, 0.46, 5e-3]);
    for (let g of [-1, 1]) {
      let b = De(g * 0.19, 0.4, 0.185), v = De(g * 0.2, 0, 0.2), y = (w) => b.clone().lerp(v, w).toArray();
      f.rod(m, y(0), y(0.9), 0.0205, 10, 0.0135, "y"), f.rod(o2.brass, y(0.87), y(1), 0.0148, 10, 0.012);
      let M = ra([[g * 0.2, 0, -0.238], [g * 0.198, 0.2, -0.222], [g * 0.19, 0.41, -0.2], [g * 0.188, 0.66, -0.243], [g * 0.185, 0.905, -0.3]], 14);
      f.add(Qo(M, (w, T) => 0.0128 + 82e-4 * Math.sin(Math.PI * Math.pow(T, 0.75)), 8), m, null, null, null, "y"), f.rod(o2.brass, [g * 0.2, 0, -0.2385], [g * 0.1994, 0.05, -0.2345], 0.0125, 10, 0.0152), f.rod(m, [g * 0.1965, 0.16, 0.19], [g * 0.1985, 0.16, -0.224], 85e-4, 6, 85e-4, "z");
    }
    f.rod(m, [-0.197, 0.16, -0.02], [0.197, 0.16, -0.02], 85e-4, 6, 85e-4, "x");
    let x = Jo(0.4, 0.36, 0.05, { r: 0.02, seg: [6, 3, 1], arc: 2, crown: { pz: 0.012, nz: 5e-3 }, lump: 2e-3, seed: 6 });
    return f.add(Yi(x, p), d, [0, 0.69, -0.262], [-0.2, 0, 0]), f.add(Yi(Id(0.4, 0.36, 0.05, 0.02, "fk", 4e-3, 3, 4), p), d, [0, 0.69, -0.262], [-0.2, 0, 0]), f.add(Yi(Jo(0.42, 0.036, 0.032, { r: 0.012, seg: [6, 1, 1], arc: 2 }), p), m, [0, 0.895, -0.31], [-0.2, 0, 0], null, "x"), f.add(Yi(Jo(0.37, 0.03, 0.022, { r: 8e-3, seg: [6, 1, 1], arc: 2 }), p), m, [0, 0.49, -0.223], [-0.2, 0, 0], null, "x"), rs("diningChair", [0.48, 0.92, 0.56], { surf: "wood", dynamic: true, mass: 6 });
  }), t("barStool", (f) => f.mat === "leatherBlack" ? "b" : "t", (f, u) => {
    let d = n(u.mat === "leatherBlack" ? "leatherBlack" : "leatherTan"), m = o2.brass;
    f.add(pe(ke([[0, 0], [0.196, 0], [0.206, 4e-3], [0.208, 0.01], [0.203, 0.016], [0.19, 0.019], [0.12, 0.026], [0.07, 0.036], [0.042, 0.052], [0.034, 0.07], [0.034, 0.078], [0.03, 0.08], [0.03, 0.34], [0.034, 0.342], [0.034, 0.36], [0.03, 0.363], [0.0225, 0.366], [0.0225, 0.7], [0.03, 0.704], [0.05, 0.71], [0, 0.71]], 24), 36), m), f.add(Sa(0.155, 0.0105, 6, 26), m, [0, 0.3, 0], [Math.PI / 2, 0, 0]), f.add(pe(ke([[0.03, 0.276], [0.04, 0.28], [0.042, 0.3], [0.04, 0.32], [0.03, 0.324]], 14), 40), m);
    for (let x = 0; x < 3; x++) {
      let g = x / 3 * Vt + 0.5;
      f.rod(m, [Math.sin(g) * 0.036, 0.3, Math.cos(g) * 0.036], [Math.sin(g) * 0.152, 0.3, Math.cos(g) * 0.152], 95e-4, 7, 7e-3);
    }
    f.add(pe(ke([[0, 0.708], [0.09, 0.708], [0.092, 0.71], [0.092, 0.716], [0.15, 0.72], [0.166, 0.727], [0.166, 0.733], [0.15, 0.737], [0, 0.737]], 24), 36), m), f.add(ke([[0, 0.735], [0.15, 0.735], [0.182, 0.74], [0.194, 0.752], [0.197, 0.772], [0.193, 0.79], [0.181, 0.803], [0.15, 0.811], [0.09, 0.815], [0.04, 0.8145], [0.018, 0.811], [6e-3, 0.806], [0, 0.805]], 26), d), f.add(Qo(P9(0.186, 0.8015, 26), 42e-4, 4, true), d), f.add(Qo(P9(0.187, 0.7445, 26), 42e-4, 4, true), d), f.add(dr(0.011, 8, 5), d, [0, 0.809, 0], null, [1, 0.5, 1]), f.add(lc([[-0.105, 0.722, -0.125], [-0.126, 0.975, -0.218], [0.126, 0.975, -0.218], [0.105, 0.722, -0.125]], 8e-3, 0.035, 7), m);
    let p = (x) => {
      x.z += 1.2 * x.x * x.x;
    };
    return f.add(Yi(Jo(0.34, 0.13, 0.042, { r: 0.02, seg: [6, 2, 1], arc: 2, crown: { pz: 0.01, nz: 3e-3 }, lump: 2e-3, seed: 9 }), p), d, [0, 0.97, -0.21], [-0.12, 0, 0]), f.add(Yi(Id(0.34, 0.13, 0.042, 0.02, "fk", 38e-4, 3, 4), p), d, [0, 0.97, -0.21], [-0.12, 0, 0]), rs("barStool", [0.44, 1.04, 0.44], { surf: "metal", dynamic: true, mass: 9 });
  }), t("officeChair", null, (f) => {
    let u = n("leatherBlack"), d = o2.chrome, m = o2.plasticBlack, p = o2.blackMetal;
    for (let b = 0; b < 5; b++) {
      let v = b / 5 * Vt;
      f.at([0, 0, 0], [0, v, 0], () => {
        f.add(Yi(Jo(0.03, 0.03, 0.27, { r: 0.012, seg: [1, 1, 4], arc: 2 }), (y) => {
          let M = y.z / 0.27 + 0.5;
          y.x *= 1.25 - 0.55 * M, y.y = y.y * (1.2 - 0.5 * M) - 0.04 * M * M;
        }), d, [0, 0.112, 0.165]), f.add(ks(8e-3, 8e-3, 0.03, 8), d, [0, 0.07, 0.3]), f.add(pe(ke([[0.014, 0.03], [0.03, 0.044], [0.027, 0.058], [0, 0.064]], 8), 40), m, [0, -4e-3, 0.3]);
        for (let y of [-1, 1]) f.add(pe(ke([[0, 0], [0.025, 0], [0.0275, 3e-3], [0.0275, 0.011], [0, 0.013]], 10), 40), m, [y * 4e-3, 0.0275, 0.293], [0, 0, -y * Math.PI / 2]);
      });
    }
    f.add(pe(ke([[0, 0.085], [0.04, 0.085], [0.046, 0.09], [0.046, 0.128], [0.036, 0.14], [0.03, 0.142], [0.03, 0.2], [0.026, 0.202], [0.026, 0.27], [0.022, 0.272], [0.022, 0.33], [0, 0.33]], 14), 40), m), f.add(ks(0.0165, 0.0165, 0.1, 12), d, [0, 0.375, 0]), f.add(Te(0.2, 0.05, 0.26, 0.012), p, [0, 0.428, -0.01]), f.add(Te(0.3, 0.014, 0.3, 5e-3), p, [0, 0.449, 0]), f.rod(p, [0.09, 0.425, 0.05], [0.22, 0.42, 0.07], 5e-3, 6), f.add(Te(0.05, 8e-3, 0.022, 3e-3), m, [0.235, 0.42, 0.072], [0, 0.15, 0]), f.add(pe(ke([[0, 0], [0.022, 0], [0.024, 4e-3], [0.024, 0.02], [0.02, 0.024], [0, 0.024]], 12), 40), m, [0, 0.4, 0.13], [Math.PI / 2, 0, 0]), i(f, u, [0.5, 0.09, 0.48], { r: 0.04, seg: [5, 1, 5], arc: 4, crown: { py: 0.016, pz: 0.01 }, plateau: 2.6, lump: 3e-3, seed: 12, prs: 4 }, "tb", [0, 0.495, 0.01]);
    let x = (b) => {
      b.z += 0.5 * b.x * b.x;
    }, g = Jo(0.47, 0.64, 0.07, { r: 0.034, seg: [6, 10, 1], arc: 4, crown: { pz: 0.012 }, lump: 2e-3, seed: 13, sculpt: (b, v) => {
      v.z > 0.3 && (b.z -= 0.016 * (1 - lw(b.y + 0.286, 0.1144, 0.4)));
    } });
    f.add(Yi(g, x), u, [0, 0.9, -0.255], [-0.12, 0, 0]), f.add(Yi(Id(0.47, 0.64, 0.07, 0.034, "fk", 42e-4, 3, 4), x), u, [0, 0.9, -0.255], [-0.12, 0, 0]), f.add(lc([[0, 0.44, -0.08], [0, 0.44, -0.25], [0, 0.6, -0.283], [0, 0.98, -0.316]], 0.013, 0.06, 6), p, null, null, [1.9, 1, 1]);
    for (let b of [0.74, 0.92]) f.add(Te(0.16, 0.03, 0.012, 4e-3), p, [0, b, -0.2795 - (b - 0.6) * 0.087], [-0.087, 0, 0]);
    for (let b of [-1, 1]) f.add(lc([[b * 0.15, 0.452, 0.09], [b * 0.29, 0.46, 0.12], [b * 0.29, 0.69, 0.135], [b * 0.29, 0.69, -0.17], [b * 0.225, 0.63, -0.232]], 0.011, 0.045, 6), d), f.add(Jo(0.056, 0.03, 0.27, { r: 0.012, seg: [1, 1, 4], arc: 2, crown: 3e-3 }), u, [b * 0.29, 0.706, -5e-3]);
    return rs("officeChair", [0.64, 1.22, 0.64], { surf: "fabric", dynamic: true, mass: 12 });
  });
}
function bD(o2) {
  let t = o2.index ? o2.toNonIndexed() : o2, e = t.attributes.position.array, s = t.attributes.uv ? t.attributes.uv.array : null, n = [], i = [];
  for (let r = 0, l = 0; r < e.length; r += 9, l += 6) {
    let c = e[r + 3] - e[r], h = e[r + 4] - e[r + 1], f = e[r + 5] - e[r + 2], u = e[r + 6] - e[r], d = e[r + 7] - e[r + 1], m = e[r + 8] - e[r + 2], p = h * m - f * d, x = f * u - c * m, g = c * d - h * u;
    if (!(p * p + x * x + g * g < 1e-18)) {
      for (let b = 0; b < 9; b++) n.push(e[r + b]);
      if (s) for (let b = 0; b < 6; b++) i.push(s[l + b]);
    }
  }
  let a = new THREE.BufferGeometry();
  return a.setAttribute("position", new THREE.Float32BufferAttribute(n, 3)), s && a.setAttribute("uv", new THREE.Float32BufferAttribute(i, 2)), a;
}
var ji = (o2, t = 24, e = 40) => pe(bD(ke(o2, t)), e);
function z9(o2, t = 1, e = 0, s = 0) {
  let n = o2.attributes.position, i = new Float32Array(n.count * 2);
  for (let a = 0; a < n.count; a++) i[a * 2] = e + n.getX(a) * t, i[a * 2 + 1] = s + n.getZ(a) * t;
  return o2.setAttribute("uv", new THREE.BufferAttribute(i, 2)), o2;
}
var Xj = (o2, t, e) => e > 0 ? [[-o2 / 2 + e, -t / 2], [o2 / 2 - e, -t / 2], [o2 / 2, -t / 2 + e], [o2 / 2, t / 2 - e], [o2 / 2 - e, t / 2], [-o2 / 2 + e, t / 2], [-o2 / 2, t / 2 - e], [-o2 / 2, -t / 2 + e]] : [[-o2 / 2, -t / 2], [o2 / 2, -t / 2], [o2 / 2, t / 2], [-o2 / 2, t / 2]], xD = new THREE.Vector3(0, 0, 1), _o0 = new THREE.Vector3(1, 0, 0), L9 = (o2, t, e, s, n = 2e-3, i = qa, a = true) => _i(Xj(e, s, n), [o2, t], { closed: false, up: i, caps: a });
function Yj(o2, t, e, s = 6, n = e) {
  let i = De(o2[0], o2[1], o2[2]), a = De(t[0], t[1], t[2]), r = a.clone().sub(i), l = r.length(), c = new THREE.Matrix4().compose(i.add(a).multiplyScalar(0.5), new THREE.Quaternion().setFromUnitVectors(qa, r.normalize()), De(1, 1, 1));
  return ks(n, e, l, s, true).applyMatrix4(c);
}
function hc(o2, t = "out", e = 40) {
  let s = o2[0].length, n = [], i = new THREE.Vector3();
  for (let l of o2) for (let c of l) i.add(c);
  i.multiplyScalar(1 / (s * o2.length));
  let a = 0;
  for (let l = 0; l < o2.length - 1; l++) for (let c = 0; c < s; c++) {
    let h = o2[l][c], f = o2[l][(c + 1) % s], u = o2[l + 1][(c + 1) % s], d = o2[l + 1][c];
    n.push(h.x, h.y, h.z, f.x, f.y, f.z, u.x, u.y, u.z, h.x, h.y, h.z, u.x, u.y, u.z, d.x, d.y, d.z);
    let m = u.x - h.x, p = u.y - h.y, x = u.z - h.z, g = d.x - f.x, b = d.y - f.y, v = d.z - f.z, y = p * v - x * b, M = x * g - m * v, w = m * b - p * g;
    a += t === "up" ? M : t === "down" ? -M : y * ((h.x + u.x) / 2 - i.x) + w * ((h.z + u.z) / 2 - i.z);
  }
  let r = new THREE.BufferGeometry();
  return r.setAttribute("position", new THREE.Float32BufferAttribute(n, 3)), a < 0 && q2(r), pe(bD(r), e);
}
function Tb(o2, t = [], e = o2[0].y) {
  let s = (i) => i.map((a) => oo(a.x, -a.z)), n = new THREE.Shape(s(o2));
  for (let i of t) n.holes.push(new THREE.Path(s(i)));
  return new THREE.ShapeGeometry(n).rotateX(-Math.PI / 2).translate(0, e, 0);
}
var jj = (o2, t, e) => o2.map((s) => De(s.x + t, s.y, s.z + e));
function yD({ M: o2, L: t, def: e, lib: s, mt: n, fine: i, P: a }) {
  let r = (A) => ji([[0, -A / 2], [34e-4, -A / 2], [46e-4, -A / 2 + 15e-4], [46e-4, -A * 0.09], [56e-4, -A * 0.075], [56e-4, A * 0.075], [46e-4, A * 0.09], [46e-4, A / 2 - 15e-4], [34e-4, A / 2], [0, A / 2]], 10), l = ji([[0, 0], [95e-4, 0], [0.0105, 12e-4], [0.0105, 22e-4], [6e-3, 42e-4], [42e-4, 7e-3], [42e-4, 0.019]], 12);
  function c(A, O, H, F, P = 0.11) {
    for (let z of [-1, 1]) A.add(l, o2.brass, [O + z * P * 0.34, H, F], [Math.PI / 2, 0, 0]);
    A.add(r(P), o2.brass, [O, H, F + 0.019], [0, 0, Math.PI / 2]);
  }
  e("coffeeTable", (A) => A.variant ? 1 : 0, (A, O) => {
    if (O.variant) {
      let n0 = ji([[0, 0.39], [0.4, 0.39], [0.484, 0.399], [0.496, 0.4045], [0.5, 0.41], [0.4988, 0.4152], [0.4945, 0.418], [0, 0.418]], 48, 30);
      A.add(z9(n0, 1, 0.6 + 2.4, 0.6 + 1.2), o2.marbleFloor, null, null, null, true), A.add(ji([[0, 0.3805], [0.366, 0.3805], [0.372, 0.3825], [0.372, 0.3905], [0, 0.3905]], 40), o2.brass), A.add(Sa(0.33, 0.011, 6, 40), o2.brass, [0, 0.011, 0], [Math.PI / 2, 0, 0]), A.add(Sa(0.36, 95e-4, 6, 40), o2.brass, [0, 0.372, 0], [Math.PI / 2, 0, 0]);
      let e0 = 18, p0 = 0.82;
      for (let t0 = 0; t0 < e0; t0++) for (let M0 of [-1, 1]) {
        let f0 = t0 / e0 * Vt, _0 = f0 + M0 * p0;
        A.add(Yj([Math.sin(f0) * 0.33, 0.011, Math.cos(f0) * 0.33], [Math.sin(_0) * 0.36, 0.372, Math.cos(_0) * 0.36], 45e-4, 6), o2.brass);
      }
      return rs("coffeeTable", [1, 0.42, 1], { surf: "stone", mass: 40, colliders: [$s(-0.45, 0, -0.45, 0.45, 0.42, 0.45)] });
    }
    let H = 1.2, F = 0.62, P = 0.024, z = H / 2 - 0.035, k = F / 2 - 0.035, I = 0.394;
    A.add(fi(ui(H, F, 8e-3), 0.022, 35e-4, 3, 2), o2.marbleDark, [0, 0.398, 0], null, null, [0.31, 0.17]), A.add(zs(H - 0.08, 4e-3, F - 0.08), o2.blackMetal, [0, 0.396, 0]);
    let G = [[-0.01, -0.015], [82e-4, -0.015], [82e-4, -0.0128]];
    for (let $ = 0; $ < 3; $++) {
      let n0 = -83e-4 + $ * 83e-4;
      G.push([98e-4, n0 - 31e-4], [0.0116, n0], [98e-4, n0 + 31e-4]), $ < 2 && G.push([84e-4, n0 + 415e-5]);
    }
    G.push([82e-4, 0.0128], [82e-4, 0.015], [-0.01, 0.015]);
    for (let $ of [-1, 1]) for (let n0 of [-1, 1]) {
      let e0 = $ * z, p0 = n0 * k;
      A.add(L9([e0, 8e-3, p0], [e0, I, p0], P, P, 3e-3, xD), o2.brass), A.add(ji([[0, 0], [85e-4, 0], [0.01, 15e-4], [0.01, 45e-4], [65e-4, 6e-3], [65e-4, 9e-3]], 8), o2.blackMetal, [e0, 0, p0]), A.add(Sa(0.027, 42e-4, 5, 16), o2.brass, [e0 - $ * (P / 2 + 0.027), I - 0.03 - 0.027, p0]), A.add(Sa(0.027, 42e-4, 5, 16), o2.brass, [e0, I - 0.03 - 0.027, p0 - n0 * (P / 2 + 0.027)], [0, Math.PI / 2, 0]);
    }
    let K = P / 2 - 1e-3;
    for (let $ of [-1, 1]) A.add(_i(G, [[-$ * (z - K), I - 0.015, $ * k], [$ * (z - K), I - 0.015, $ * k]], { closed: false, caps: false }), o2.brass), A.add(L9([-(z - K), 0.138, $ * k], [z - K, 0.138, $ * k], 0.02, 0.022, 25e-4, qa, false), o2.brass), A.add(zs(H - 0.1 + 0.012, 3e-3, 0.014), o2.brass, [0, 0.1295, $ * (k - 0.014)]);
    for (let $ of [-1, 1]) A.add(_i(G, [[$ * z, I - 0.015, $ * (k - K)], [$ * z, I - 0.015, -$ * (k - K)]], { closed: false, caps: false }), o2.brass), A.add(L9([$ * z, 0.138, -(k - K)], [$ * z, 0.138, k - K], 0.02, 0.022, 25e-4, qa, false), o2.brass), A.add(zs(0.014, 3e-3, F - 0.1 - 0.02), o2.brass, [$ * (z - 0.014), 0.1295, 0]);
    return A.add(Te(H - 0.1, 0.018, F - 0.1, 4e-3), o2.woodDark, [0, 0.14, 0], null, null, "x"), rs("coffeeTable", [H, 0.42, F], { surf: "stone", mass: 45, colliders: [$s(-H / 2, 0, -F / 2, H / 2, 0.42, F / 2)] });
  }), e("sideTable", null, (A) => {
    A.add(ji([[0, 0], [0.144, 0], [0.15, 3e-3], [0.15, 9e-3], [0.146, 0.0125], [0.134, 0.0145], [0.07, 0.022], [0.034, 0.03], [0.026, 0.036], [0.026, 0.042], [0.0185, 0.046]], 28), o2.brass), A.add(ji([[0.0135, 0.044], [0.0135, 0.455], [0.0155, 0.459], [0.021, 0.466], [0.021, 0.472], [0.0155, 0.479], [0.0135, 0.483], [0.0135, 0.505]], 10), o2.brass), A.add(ji([[0.0135, 0.497], [0.026, 0.503], [0.085, 0.518], [0.196, 0.5275], [0.216, 0.529], [0.2225, 0.5305], [0.225, 0.534], [0.225, 0.556], [0.2238, 0.5584], [0.2188, 0.5584], [0.2182, 0.5574]], 28), o2.brass);
    let O = ji([[0.19, 0.529], [0.2185, 0.531], [0.2185, 0.558], [0, 0.558]], 32);
    return A.add(z9(O, 1, 0.83, 0.41), o2.marbleDark, null, null, null, true), rs("sideTable", [0.45, 0.56, 0.45], { surf: "stone", dynamic: true, mass: 9 });
  });
  let h = (A, O, H, F, P, z) => {
    let k = (I, G) => {
      let K = [];
      for (let $ = 0; $ < P; $++) for (let n0 = 0; n0 < 4; n0++) {
        let e0 = ($ + n0 / 4) / P * Vt, p0 = I - z * Math.sin(Math.PI * n0 / 4) * (n0 ? 1 : 0);
        K.push(De(Math.sin(e0) * p0, G, Math.cos(e0) * p0));
      }
      return K;
    };
    return hc([k(A, H), k(O, F)], "out", 34);
  }, f = ji([[0.074, 0], [0.1212, 0.0146], [0.122, 0.0158], [0.1185, 0.0166], [0.089, 0.0124], [0.067, 6e-3], [0, 6e-3]], 28, 50), u = ji([[0, 0], [0.031, 0], [0.0352, 2e-3], [0.0352, 45e-4], [0.0125, 0.017], [0.011, 0.038], [0.0155, 0.044], [0.011, 0.05], [0.031, 0.066], [0.034, 0.075], [0.034, 0.0985], [0.0326, 0.1], [0.0312, 0.0985], [0.0312, 0.069], [0.027, 0.064], [0, 0.064]], 10);
  e("diningTable", (A) => (A.r || 0.55).toFixed(2), (A, O) => {
    let H = O.r || 0.55;
    A.add(ji([[0, 0], [0.266, 0], [0.28, 5e-3], [0.28, 0.014], [0.262, 0.0235], [0.2, 0.041], [0.118, 0.054], [0.078, 0.09], [0.078, 0.108], [0.052, 0.118]], 22), o2.brass), A.add(h(0.054, 0.047, 0.116, 0.602, 12, 45e-4), o2.brass), A.add(ji([[0.046, 0.6], [0.06, 0.606], [0.06, 0.618], [0.05, 0.624], [0.1, 0.674], [0.214, 0.705], [0.22, 0.7165]], 22), o2.brass);
    let F = Math.min(1, 0.56 / H), P = Math.round(H * 100) % 4, z = ji([[0.2, 0.716], [H - 0.075, 0.716], [H - 6e-3, 0.7275], [H - 52e-4, 0.752], [0, 0.752]], 48, 30);
    A.add(z9(z, F, 0.6 + P * 1.2, 0.6 + P % 2 * 2.4), o2.marbleFloor, null, null, null, true), A.add(ji([[H - 7e-3, 0.7266], [H, 0.7276], [H, 0.7506], [H - 12e-4, 0.7526], [H - 56e-4, 0.7522]], 48), o2.brass);
    let k = H < 0.5 ? 2 : 4;
    for (let I = 0; I < k; I++) {
      let G = I / k * Vt + Math.PI / 4;
      A.add(f, o2.ceramicWhite, [Math.sin(G) * H * 0.62, 0.752, Math.cos(G) * H * 0.62], [0, G, 0]);
    }
    return A.add(u, o2.brass, [0, 0.752, 0]), rs("diningTable", [H * 2, 0.76, H * 2], { surf: "stone", mass: 60, colliders: [$s(-H * 0.8, 0.68, -H * 0.8, H * 0.8, 0.76, H * 0.8), $s(-0.14, 0, -0.14, 0.14, 0.68, 0.14)] });
  });
  function d(A, O, H, F, P, z) {
    let k = [], I = A / 2 - H, G = O / 2 - H, K = ($) => [$ === 0 || $ === 3 ? I : -I, $ < 2 ? G : -G];
    for (let $ = 0; $ < 4; $++) {
      let [n0, e0] = K($), [p0, t0] = K(($ + 1) % 4);
      for (let Z0 = 0; Z0 <= 3; Z0++) {
        let lt = ($ + Z0 / 3) * Math.PI / 2;
        k.push(De(n0 + Math.cos(lt) * H, z, e0 + Math.sin(lt) * H));
      }
      let M0 = ($ + 1) * Math.PI / 2, f0 = Math.cos(M0), _0 = Math.sin(M0), F0 = n0 + f0 * H, m0 = e0 + _0 * H, S0 = p0 + f0 * H, T0 = t0 + _0 * H, j0 = Math.max(1, Math.round(Math.hypot(S0 - F0, T0 - m0) / F));
      for (let Z0 = 0; Z0 < j0; Z0++) for (let lt = Z0 ? 0 : 1; lt < 4; lt++) {
        let H0 = (Z0 + lt / 4) / j0, Y0 = P * Math.sin(Math.PI * lt / 4);
        k.push(De(F0 + (S0 - F0) * H0 - f0 * Y0, z, m0 + (T0 - m0) * H0 - _0 * Y0));
      }
    }
    return k;
  }
  let m = (A, O) => pe(q2(Tb(A, [], O).toNonIndexed()));
  e("conferenceTable", null, (A) => {
    let z = i("leatherBlack"), k = ($, n0) => di(3.2 - 2 * $, 1.2 - 2 * $, 0.42 - $, n0, 14);
    A.add(hc([k(0.03, 0.756 - 0.026), k(5e-3, 0.756 - 0.026), k(0, 0.756 - 0.022), k(0, 0.756 - 4e-3), k(12e-4, 0.756 - 12e-4), k(4e-3, 0.756), k(0.075, 0.756)]), o2.woodDark, null, null, null, "x"), A.add(hc([k(0.075, 0.756), k(0.0795, 0.756)], "up"), o2.brass);
    let I = di(2.3, 0.24, 0.1, 0.756, 6), G = di(2.29, 0.23, 0.095, 0.756, 6);
    A.add(Tb(k(0.0795, 0.756), [I]), o2.woodDark, null, null, null, "x"), A.add(hc([I, G], "up"), o2.brass);
    let K = ($, n0) => di(0.43 - 2 * $, 0.118 - 2 * $, Math.max(4e-3, 0.014 - $), n0, 3);
    A.add(Tb(G, [K(0, 0.756)]), z), A.add(hc([K(0, 0.756), K(8e-4, 0.756 + 22e-4), K(16e-4, 0.756 + 3e-3), K(65e-4, 0.756 + 3e-3), K(75e-4, 0.756 + 16e-4)]), o2.brass), A.add(zs(4e-3, 4e-3, 0.103), o2.brass, [0, 0.756 + 1e-3, 0]);
    for (let $ of [-1, 1]) A.add(fi(ui(0.2045, 0.1028, 6e-3), 4e-3, 8e-4, 2, 1), o2.blackMetal, [$ * 0.1048, 0.756 - 22e-4, 0]), A.add(ji([[62e-4, 4e-4], [0.0112, 0], [0.0126, 1e-3], [0.0126, 22e-4], [0.0108, 32e-4], [78e-4, 32e-4], [62e-4, 14e-4]], 12), o2.rubber, [$ * 0.1, 0.756 + 17e-4, 0]), A.add(zs(8e-3, 6e-4, 0.034), o2.rubber, [$ * 0.19, 0.756 + 19e-4, 0]);
    A.add(hc([k(0.03, 0.756 - 0.031), k(0.03, 0.756 - 0.026)]), o2.brass), A.add(hc([k(0.03, 0.756 - 0.031), k(0.022, 0.756 - 0.031), k(0.022, 0.756 - 0.044), k(0.11, 0.756 - 0.058)]), o2.woodDark, null, null, null, "x"), A.add(m(k(0.11, 0.756 - 0.058), 0.756 - 0.058), o2.woodDark, null, null, null, "x");
    for (let $ of [-1, 1]) A.at([$ * 0.95, 0, 0], () => {
      A.add(fi(ui(0.68, 0.56, 0.04), 0.03, 5e-3, 4, 2), o2.brass), A.add(hc([d(0.62, 0.5, 0.035, 0.03, 6e-3, 0.03), d(0.62, 0.5, 0.035, 0.03, 6e-3, 0.628)], "out", 42), o2.blackMetal);
      let n0 = (e0, p0) => di(0.62 + 2 * e0, 0.5 + 2 * e0, 0.035 + e0, p0, 3);
      A.add(hc([n0(-8e-3, 0.626), n0(3e-3, 0.628), n0(4e-3, 0.632), n0(4e-3, 0.646), n0(3e-3, 0.65), n0(-0.022, 0.652)]), o2.brass), A.add(hc([n0(-0.022, 0.65), n0(-0.022, 0.7)]), o2.blackMetal);
    });
    return A.add(Te(1.32, 0.085, 0.18, 0.012), o2.blackMetal, [0, 0.6555, 0]), rs("conferenceTable", [3.2, 0.76, 1.2], { surf: "wood", mass: 180, colliders: [$s(-1.6, 0.66, -0.6, 1.6, 0.76, 0.6), $s(-1.26, 0, -0.25, -0.64, 0.66, 0.25), $s(0.64, 0, -0.25, 1.26, 0.66, 0.25)] });
  }), e("desk", null, (A) => {
    let H = i("leatherBlack"), F = (e0, p0) => di(1.5 - 2 * e0, 0.7 - 2 * e0, Math.max(4e-3, 0.016 - e0), p0, 4), P = (e0) => jj(di(0.86 - 2 * e0, 0.46 - 2 * e0, Math.max(3e-3, 0.014 - e0), 0.76, 4), 0, 0.04);
    A.add(hc([F(0.03, 0.76 - 0.028), F(5e-3, 0.76 - 0.028), F(0, 0.76 - 0.023), F(0, 0.76 - 6e-3), F(2e-3, 0.76 - 15e-4), F(6e-3, 0.76)]), o2.woodDark, null, null, null, "x"), A.add(Tb(F(6e-3, 0.76), [P(0)]), o2.woodDark, null, null, null, "x"), A.add(hc([P(0), P(0.014)], "up"), H), A.add(hc([P(0.014), P(0.0156)], "up"), o2.brass), A.add(Tb(P(0.0156)), H), A.add(fi(ui(1.38, 0.6, 0.014), 0.108, 3e-3, 3, 1), o2.woodDark, [0, 0.624, 0], null, null, "x");
    let z = (e0, p0) => di(1.38 + 2 * e0, 0.6 + 2 * e0, 0.014 + e0, p0, 3);
    A.add(hc([z(0, 0.622), z(3e-3, 0.623), z(3e-3, 0.628), z(0, 0.629)]), o2.brass);
    let k = [[0, 0], [3e-3, 0], [3e-3, 12e-4], [15e-4, 2e-3], [0, 12e-4]], I = [[0, 0], [8e-3, 0], [8e-3, 2e-3], [4e-3, 35e-4], [0, 2e-3]];
    for (let e0 = -1; e0 <= 1; e0++) A.add(Fr(ui(0.43, 0.078, 3e-3), 0.01, 25e-4, 2, 2), o2.woodDark, [e0 * 0.455, 0.678, 0.3], null, null, "x"), A.add(Dl(0.4, 0.05, k), o2.brass, [e0 * 0.455, 0.678, 0.31]), c(A, e0 * 0.455, 0.678, 0.31, 0.11);
    A.add(Dl(1.26, 0.072, I), o2.woodDark, [0, 0.678, -0.3], [0, Math.PI, 0], null, "x");
    for (let e0 of [-1, 1]) A.add(Dl(0.48, 0.072, I), o2.woodDark, [e0 * 0.69, 0.678, 0], [0, e0 * Math.PI / 2, 0], null, "z");
    let G = Math.hypot(0.043, 0.63, 0.043), K = ji([[0.0146, 0.06], [0.0262, G - 0.034], [0.0262, G]], 14), $ = ji([[0, -2e-3], [0.0118, -2e-3], [0.0135, 2e-3], [0.0145, 0.05], [0.0168, 0.052], [0.0168, 0.058], [0.0149, 0.0605]], 14), n0 = ji([[0.0262, G - 0.036], [0.029, G - 0.034], [0.029, G - 0.026], [0.0262, G - 0.024]], 14);
    for (let e0 of [-1, 1]) for (let p0 of [-1, 1]) {
      let t0 = rc(De(e0 * 0.703, 0, p0 * 0.313), De(-e0 * 0.043, 0.63, -p0 * 0.043), xD);
      A.addM(K, o2.woodDark, t0, "y"), A.addM($, o2.brass, t0), A.addM(n0, o2.brass, t0);
    }
    return rs("desk", [1.5, 0.76, 0.7], { surf: "wood", mass: 45, colliders: [$s(-0.75, 0.62, -0.35, 0.75, 0.76, 0.35)] });
  });
  let p = ji([[0, 0], [85e-4, 0], [0.011, 2e-3], [0.0115, 0.01], [0.0165, 0.098], [0.0165, 0.104], [0.023, 0.108], [0.025, 0.112], [0.025, 0.1215]], 12);
  e("nightstand", null, (A) => {
    for (let H of [-1, 1]) for (let F of [-1, 1]) A.add(p, o2.brass, [H * 0.2, 0, F * 0.16]);
    A.add(fi(ui(0.5, 0.42, 0.012), 0.42, 4e-3, 3, 2), o2.woodDark, [0, 0.12, 0], null, null, "y");
    let O = (H, F) => di(0.5 + 2 * H, 0.42 + 2 * H, 0.012 + H, F, 3);
    A.add(hc([O(-4e-3, 0.5355), O(25e-4, 0.536), O(25e-4, 0.5405), O(-4e-3, 0.541)]), o2.brass), A.add(fi(ui(0.53, 0.45, 8e-3), 0.021, 3e-3, 3, 2), o2.marbleDark, [0, 0.541, 0], null, null, [0.2, 0.55]);
    for (let H of [0.2305, 0.4295]) A.add(Fr(ui(0.466, 0.188, 4e-3), 0.012, 3e-3, 2, 2), o2.woodDark, [0, H, 0.21], null, null, "x"), c(A, 0, H + 0.03, 0.222, 0.13);
    return rs("nightstand", [0.53, 0.56, 0.45], { surf: "wood", mass: 16, colliders: [$s(-0.26, 0, -0.22, 0.26, 0.56, 0.22)] });
  });
  let x = Math.PI / 2, g = 1024, b = 1024, v = (A, O, H, F) => hu(A, O, H, F, g, b), y = { keys: v(0, 0, 704, 272), pad: v(2, 282, 252, 156), pages: v(266, 282, 252, 60), ports: v(528, 562, 128, 30), cover0: v(0, 460, 256, 360), cover1: v(264, 560, 256, 360) }, M = (A) => v(528, 280 + A * 44, 480, 40), w = () => s("tablesAtlas", () => {
    let A = we(g, b), O = A.getContext("2d"), H = we(g, b), F = H.getContext("2d"), P = Re(808);
    F.fillStyle = "#808080", F.fillRect(0, 0, g, b);
    let z = (n0, e0, p0, t0, M0, f0) => {
      n0.beginPath(), n0.moveTo(e0 + f0, p0), n0.lineTo(e0 + t0 - f0, p0), n0.quadraticCurveTo(e0 + t0, p0, e0 + t0, p0 + f0), n0.lineTo(e0 + t0, p0 + M0 - f0), n0.quadraticCurveTo(e0 + t0, p0 + M0, e0 + t0 - f0, p0 + M0), n0.lineTo(e0 + f0, p0 + M0), n0.quadraticCurveTo(e0, p0 + M0, e0, p0 + M0 - f0), n0.lineTo(e0, p0 + f0), n0.quadraticCurveTo(e0, p0, e0 + f0, p0), n0.closePath();
    };
    O.fillStyle = "#17181a", O.fillRect(0, 0, 704, 272), F.fillStyle = "#5a5a5a", F.fillRect(0, 0, 704, 272);
    let k = [[14, 0.62], [14, 1], [14, 1], [13, 1], [12, 1], [9, 1]], I = ["", "`1234567890-=", "QWERTYUIOP[]\\", "ASDFGHJKL;'", "ZXCVBNM,./", ""], G = 8;
    k.forEach(([n0, e0], p0) => {
      let t0 = 44 * e0, M0 = Array.from({ length: n0 }, (F0, m0) => p0 === 5 ? m0 === 4 ? 5.2 : 1 : p0 > 0 && (m0 === 0 || m0 === n0 - 1) ? 1 + p0 * 0.28 : 1), f0 = M0.reduce((F0, m0) => F0 + m0, 0), _0 = 8;
      M0.forEach((F0, m0) => {
        let S0 = (688 - (n0 - 1) * 5) * F0 / f0;
        O.fillStyle = "#0b0b0c", z(O, _0, G, S0, t0 - 5, 4), O.fill(), O.strokeStyle = "rgba(255,255,255,0.08)", O.lineWidth = 1, O.stroke(), F.fillStyle = "#c8c8c8", z(F, _0, G, S0, t0 - 5, 5), F.fill(), F.fillStyle = "#b4b4b4", z(F, _0 + 4, G + 4, S0 - 8, t0 - 13, 4), F.fill();
        let T0 = I[p0][m0 - (p0 > 0 && p0 < 5 ? p0 === 1 ? 0 : 1 : 99)];
        O.fillStyle = "rgba(214,218,224,0.82)", O.font = `600 ${p0 === 0 ? 9 : 15}px "Segoe UI", Arial, sans-serif`, O.textAlign = "left", O.textBaseline = "top", T0 ? O.fillText(T0, _0 + 6, G + 5) : (p0 !== 5 || m0 !== 4) && O.fillRect(_0 + 6, G + (t0 - 5) / 2 - 1, Math.min(14, S0 - 12), 2), _0 += S0 + 5;
      }), G += t0;
    }), O.fillStyle = "#9a9da1", O.fillRect(0, 280, 256, 160), O.strokeStyle = "rgba(20,20,22,0.55)", O.lineWidth = 3, z(O, 3, 283, 250, 154, 10), O.stroke(), F.fillStyle = "#6c6c6c", z(F, 3, 283, 250, 154, 10), F.fill(), O.fillStyle = "#e9e1cc", O.fillRect(264, 280, 256, 64);
    for (let n0 = 280; n0 < 344; n0 += 2) O.fillStyle = `rgba(${90 + P() * 60 | 0},${80 + P() * 50 | 0},${60 + P() * 40 | 0},${0.1 + P() * 0.22})`, O.fillRect(264, n0, 256, 1), F.fillStyle = P() < 0.5 ? "#8c8c8c" : "#747474", F.fillRect(264, n0, 256, 1);
    O.fillStyle = "#b9bcc0", O.fillRect(528, 560, 128, 32), O.fillStyle = "#060607";
    for (let [n0, e0, p0] of [[6, 26, 12], [40, 26, 12], [76, 14, 8], [100, 18, 18]]) z(O, 528 + n0, 576 - p0 / 2, e0, p0, p0 > 14 ? 9 : 3), O.fill();
    let K = "#d9b25a";
    ["DEEP SPACE ATLAS", "HALCYON \xB7 A HISTORY", "ATLAS OF HARBOURS", "NOCTURNES", "ON LIGHT & STONE", "ORBITAL MECHANICS"].forEach((n0, e0) => {
      let p0 = 280 + e0 * 44;
      O.fillStyle = K, O.font = `${e0 % 2 ? "italic 600" : "700"} ${e0 % 2 ? 26 : 22}px ${e0 % 2 ? "Georgia, serif" : '"Segoe UI", Arial, sans-serif'}`, O.textAlign = "center", O.textBaseline = "middle", "letterSpacing" in O && (O.letterSpacing = e0 % 2 ? "1px" : "4px"), O.fillText(n0, 768, p0 + 21), "letterSpacing" in O && (O.letterSpacing = "0px"), O.fillRect(536, p0 + 6, 28, 3), O.fillRect(536, p0 + 31, 28, 3), O.fillRect(972, p0 + 6, 28, 3), O.fillRect(972, p0 + 31, 28, 3);
    });
    for (let [n0, e0, p0, t0, M0] of [[0, 460, "NOCTURNES", "collected photographs", 1], [264, 560, "ATLAS", "OF HARBOURS", 0]]) O.strokeStyle = K, O.fillStyle = K, O.lineWidth = 3, O.strokeRect(n0 + 14, e0 + 14, 228, 332), O.lineWidth = 1.5, O.strokeRect(n0 + 22, e0 + 22, 212, 316), O.textAlign = "center", O.textBaseline = "middle", O.font = M0 ? "italic 600 34px Georgia, serif" : '700 40px "Segoe UI", Arial, sans-serif', O.fillText(p0, n0 + 128, e0 + 130), O.font = M0 ? '600 15px "Segoe UI", Arial, sans-serif' : '600 20px "Segoe UI", Arial, sans-serif', O.fillText(t0, n0 + 128, e0 + 172), O.beginPath(), O.moveTo(n0 + 128, e0 + 226), O.lineTo(n0 + 142, e0 + 244), O.lineTo(n0 + 128, e0 + 262), O.lineTo(n0 + 114, e0 + 244), O.closePath(), O.stroke(), O.fillRect(n0 + 60, e0 + 243, 44, 2), O.fillRect(n0 + 152, e0 + 243, 44, 2);
    return new THREE.MeshStandardMaterial({ map: ll(A), normalMap: ll(Hd(H, 2.4, false), { srgb: false }), normalScale: new THREE.Vector2(0.9, 0.9), roughness: 0.5, metalness: 0, alphaTest: 0.5 });
  }), T = (A, O) => {
    let H = A.attributes.uv;
    for (let F = 0; F < H.count; F++) H.setXY(F, O[0] + (O[2] - O[0]) * H.getX(F), O[1] + (O[3] - O[1]) * H.getY(F));
    return A;
  };
  e("tv", (A) => (A.w || 1.4).toFixed(2), (A, O) => {
    let H = O.w || 1.4, F = H * 0.5625, P = o2.blackMetal, z = o2.plasticBlack;
    A.add(Te(H * 0.3, F * 0.34, 6e-3, 2e-3), P, [0, 0, 3e-3]);
    for (let k of [-1, 1]) {
      A.add(Te(0.032, F * 0.46, 0.022, 4e-3), P, [k * H * 0.11, 0, 0.015]);
      for (let I of [-1, 1]) A.add(ks(6e-3, 6e-3, 4e-3, 6), P, [k * H * 0.11, I * F * 0.17, 0.027], [x, 0, 0]);
    }
    A.add(Te(0.05, F * 0.3, 0.014, 4e-3), z, [0, -F * 0.3, 0.012]), A.add(Te(H * 0.64, F * 0.62, 0.02, 7e-3), z, [0, -F * 0.05, 0.034]);
    for (let k = 0; k < 9; k++) A.add(zs(H * 0.4, 4e-3, 3e-3), P, [0, F * 0.262, 0.0265 + k * 18e-4], null, null);
    return A.add(Te(H, F, 0.014, 35e-4), z, [0, 0, 0.051]), A.add(Dl(H, F, [[0, 0], [0, 4e-3], [18e-4, 45e-4], [58e-4, 36e-4], [58e-4, 0]], 35), P, [0, 0, 0.058]), A.add(Dl(H - 0.0116, F - 0.0116, [[0, 0], [0, 37e-4], [64e-4, 37e-4], [64e-4, 0]], 35), z, [0, 0, 0.058]), A.add(Te(0.06, 32e-4, 12e-4, 5e-4), P, [0, -F / 2 + 64e-4, 0.0622]), A.keep("screen", iw(H - 0.024, F - 0.024), o2.screenOn, [0, 0, 0.062], null, null, { clone: false, uv: true }), rs("tv", [H, F, 0.06], { surf: "glass", wall: true, mountY: 1.5, mass: 18, breakable: "glass", colliders: [$s(-H / 2, -F / 2, 0, H / 2, F / 2, 0.06)] });
  }), e("painting", (A) => `${(A.variant | 0) % 4}_${A.w || 1.2}x${A.h || 0.9}${A.frame || ""}`, (A, O) => {
    let H = (O.variant | 0) % 4, F = O.w || 1.2, P = O.h || 0.9, z = 0.05, k = Math.min(F, P) * 0.07, I = (O.frame ? O.frame === "brass" : H % 2 === 0) ? o2.brass : o2.blackMetal;
    A.add(Dl(F, P, [[0, 0], [0, 0.02], [3e-3, 0.027], [0.01, 0.0335], [0.016, 0.036], [0.022, 0.0345], [0.026, 0.03], [0.034, 0.027], [0.038, 0.0225], [0.043, 0.0235], [0.047, 0.022], [0.05, 0.018], [0.05, 0]], 32), I);
    let G = F - z * 2 + 0.01, K = P - z * 2 + 0.01, $ = F - z * 2 - k * 2, n0 = P - z * 2 - k * 2;
    A.add(zs(G, K, 6e-3), o2.paper, [0, 0, 0.011]);
    {
      let e0 = new THREE.Shape([oo(-G / 2, -K / 2), oo(G / 2, -K / 2), oo(G / 2, K / 2), oo(-G / 2, K / 2)]);
      e0.holes.push(new THREE.Path([oo(-$ / 2, -n0 / 2), oo(-$ / 2, n0 / 2), oo($ / 2, n0 / 2), oo($ / 2, -n0 / 2)])), A.add(pe(new THREE.ExtrudeGeometry(e0, { depth: 1e-3, bevelEnabled: true, bevelThickness: 22e-4, bevelSize: 22e-4, bevelOffset: -22e-4, bevelSegments: 1 }), 30), o2.paper, [0, 0, 0.0166]);
    }
    return A.add(iw($ + 8e-3, n0 + 8e-3), o2["art" + (H + 1)] || o2.paper, [0, 0, 0.0172], null, null, true), rs("painting", [F, P, 0.036], { surf: "wood", wall: true, mountY: 1.6, mass: 6 });
  });
  let S = /* @__PURE__ */ new Map(), E = (A, O, H, F, P) => {
    A.beginPath(), A.moveTo(O, H - P), A.lineTo(O + F, H), A.lineTo(O, H + P), A.lineTo(O - F, H), A.closePath();
  }, _ = [(A, O, H) => {
    let F = H * 0.06;
    A.fillStyle = "#6f2a1a", A.fillRect(0, 0, O, H), A.fillStyle = "#e3d3b4", A.fillRect(F * 0.6, F * 0.6, O - F * 1.2, H - F * 1.2), A.fillStyle = "#1d4447", A.fillRect(F * 0.9, F * 0.9, O - F * 1.8, H - F * 1.8), A.fillStyle = "#8b3a22", A.fillRect(F * 2.1, F * 2.1, O - F * 4.2, H - F * 4.2), A.fillStyle = "#d9b877";
    for (let z = F * 1.5; z < O - F; z += F * 0.9) E(A, z, F * 1.5, F * 0.28, F * 0.42), A.fill(), E(A, z, H - F * 1.5, F * 0.28, F * 0.42), A.fill();
    for (let z = F * 1.5; z < H - F; z += F * 0.9) E(A, F * 1.5, z, F * 0.42, F * 0.28), A.fill(), E(A, O - F * 1.5, z, F * 0.42, F * 0.28), A.fill();
    A.save(), A.beginPath(), A.rect(F * 2.1, F * 2.1, O - F * 4.2, H - F * 4.2), A.clip(), A.fillStyle = "rgba(227,211,180,0.5)";
    for (let z = 0, k = 0; k < H; k += F * 1.1, z++) for (let I = z % 2 * F * 0.8; I < O; I += F * 1.6) E(A, I, k, F * 0.16, F * 0.22), A.fill();
    ["#1d4447", "#e3d3b4", "#b5532c", "#1d4447", "#d9b877"].forEach((z, k) => {
      A.fillStyle = z, E(A, O / 2, H / 2, O * (0.3 - k * 0.055), H * (0.36 - k * 0.066)), A.fill();
    });
    for (let [z, k] of [[F * 2.1, F * 2.1], [O - F * 2.1, F * 2.1], [F * 2.1, H - F * 2.1], [O - F * 2.1, H - F * 2.1]]) ["#1d4447", "#e3d3b4", "#b5532c"].forEach((I, G) => {
      A.fillStyle = I, E(A, z, k, O * (0.13 - G * 0.035), H * (0.17 - G * 0.045)), A.fill();
    });
    A.restore();
  }, (A, O, H) => {
    A.fillStyle = "#14373b", A.fillRect(0, 0, O, H);
    let F = H / 7;
    A.lineWidth = Math.max(2, H / 180);
    for (let z = 0, k = H + F; k > -F; k -= F * 0.5, z++) for (let I = z % 2 * F - F; I < O + F; I += F * 2) {
      A.fillStyle = z % 4 < 2 ? "#14373b" : "#183f44", A.beginPath(), A.arc(I, k, F, Math.PI, 0), A.fill(), A.strokeStyle = "#c6a25a";
      for (let G of [1, 0.72, 0.44]) A.beginPath(), A.arc(I, k, F * G, Math.PI, 0), A.stroke();
    }
    let P = H * 0.05;
    A.fillStyle = "#0e2629", A.fillRect(0, 0, O, P), A.fillRect(0, H - P, O, P), A.fillRect(0, 0, P, H), A.fillRect(O - P, 0, P, H), A.strokeStyle = "#c6a25a", A.lineWidth = Math.max(2, H / 150), A.strokeRect(P * 0.45, P * 0.45, O - P * 0.9, H - P * 0.9), A.strokeRect(P, P, O - P * 2, H - P * 2);
  }, (A, O, H) => {
    A.fillStyle = "#ded3bd", A.fillRect(0, 0, O, H), A.fillStyle = "#a4482a", A.beginPath(), A.arc(O * 0.2, H * 1.05, H * 0.8, 0, Vt), A.fill(), A.fillStyle = "#2c2b2a", A.beginPath(), A.moveTo(O * 0.52, 0), A.lineTo(O, 0), A.lineTo(O, H * 0.55), A.quadraticCurveTo(O * 0.72, H * 0.5, O * 0.52, 0), A.fill(), A.fillStyle = "#2a5759", A.beginPath(), A.arc(O * 0.7, H * 0.66, H * 0.2, 0, Vt), A.fill(), A.strokeStyle = "#c6a25a", A.lineWidth = Math.max(2, H / 120), A.beginPath(), A.arc(O * 0.2, H * 1.05, H * 0.9, 0, Vt), A.stroke(), A.beginPath(), A.moveTo(0, H * 0.22), A.bezierCurveTo(O * 0.3, H * 0.1, O * 0.6, H * 0.5, O, H * 0.82), A.stroke();
  }];
  function R(A, O) {
    let H = A + ":" + O.toFixed(1);
    if (S.has(H)) return S.get(H);
    let F = 512, P = Zt(Math.round(F * O / 32) * 32, 512, 1024), z = Math.round(P * 0.02), k = P - 2 * z, I = we(k, F), G = I.getContext("2d"), K = Re(31 + A * 7), $ = _n(40 + A);
    _[A](G, k, F);
    for (let f0 = 0; f0 < k; f0 += 4) {
      let _0 = ($.fbm(f0 * 0.012, A * 3.1, 3) - 0.5) * 0.3;
      G.fillStyle = _0 > 0 ? `rgba(255,236,200,${_0})` : `rgba(20,10,0,${-_0})`, G.fillRect(f0, 0, 4, F);
    }
    for (let f0 = 0; f0 < F; f0 += 3) G.fillStyle = `rgba(0,0,0,${0.03 + 0.05 * K()})`, G.fillRect(0, f0, k, 1);
    for (let f0 = 0; f0 < 12e3; f0++) G.fillStyle = K() < 0.5 ? "rgba(0,0,0,0.08)" : "rgba(255,240,215,0.07)", G.fillRect(K() * k, K() * F, 2, 2);
    G.strokeStyle = "rgba(30,18,10,0.55)", G.lineWidth = 5, G.strokeRect(2.5, 2.5, k - 5, F - 5);
    let n0 = we(P, F), e0 = n0.getContext("2d"), p0 = we(P, F), t0 = p0.getContext("2d");
    e0.drawImage(I, z, 0), t0.filter = "grayscale(1) contrast(0.6)", t0.drawImage(I, z, 0), t0.filter = "none";
    for (let f0 = 0; f0 < F; f0 += 3) t0.fillStyle = "rgba(0,0,0,0.22)", t0.fillRect(z, f0, k, 1);
    for (let f0 = 0; f0 < 9e3; f0++) t0.fillStyle = K() < 0.5 ? "rgba(0,0,0,0.2)" : "rgba(255,255,255,0.2)", t0.fillRect(z + K() * k, K() * F, 2, 2);
    for (let f0 of [-1, 1]) for (let _0 = 3; _0 < F - 2; _0 += 5) {
      let F0 = f0 < 0 ? z : P - z, m0 = z * (0.72 + K() * 0.28), S0 = (K() - 0.5) * 5;
      for (let T0 of [e0, t0]) T0.strokeStyle = T0 === e0 ? `rgb(${214 + K() * 26 | 0},${200 + K() * 22 | 0},${168 + K() * 22 | 0})` : "#d0d0d0", T0.lineWidth = 2.2, T0.beginPath(), T0.moveTo(F0, _0), T0.lineTo(F0 + f0 * m0, _0 + S0), T0.stroke();
    }
    let M0 = new THREE.MeshStandardMaterial({ map: ll(n0), normalMap: ll(Hd(p0, 1.6, false), { srgb: false }), roughness: 1, metalness: 0, alphaTest: 0.5 });
    return M0.name = "rug" + H, M0.userData.fringe = z / P, S.set(H, M0), M0;
  }
  e("rug", (A) => `${A.w || 3}x${A.d || 2}v${(A.variant | 0) % 3}`, (A, O) => {
    let H = O.w || 3, F = O.d || 2, P = (O.variant | 0) % 3, z = F > H, k = Math.max(H, F), I = Math.min(H, F), G = R(P, k / I), K = G.userData.fringe, $ = k * K, n0 = k - 2 * $;
    A.cast = false;
    let e0 = fi(ui(n0, I, 0.012), 0.012, 4e-3, 3), p0 = e0.attributes.position, t0 = new Float32Array(p0.count * 2);
    for (let m0 = 0; m0 < p0.count; m0++) t0[m0 * 2] = K + (p0.getX(m0) / n0 + 0.5) * (1 - 2 * K), t0[m0 * 2 + 1] = 0.5 - p0.getZ(m0) / I;
    e0.setAttribute("uv", new THREE.BufferAttribute(t0, 2));
    let M0 = new THREE.BufferGeometry(), f0 = [], _0 = [];
    for (let m0 of [-1, 1]) {
      let S0 = m0 * n0 / 2, T0 = m0 * k / 2, j0 = m0 < 0 ? K : 1 - K, Z0 = m0 < 0 ? 0 : 1, lt = [S0, 0.0105, I / 2], H0 = [T0, 25e-4, I / 2], Y0 = [T0, 25e-4, -I / 2], et = [S0, 0.0105, -I / 2], ct = m0 > 0 ? [lt, H0, Y0, lt, Y0, et] : [lt, Y0, H0, lt, et, Y0], D0 = m0 > 0 ? [[j0, 0], [Z0, 0], [Z0, 1], [j0, 0], [Z0, 1], [j0, 1]] : [[j0, 0], [Z0, 1], [Z0, 0], [j0, 0], [j0, 1], [Z0, 1]];
      for (let u0 of ct) f0.push(...u0);
      for (let u0 of D0) _0.push(...u0);
    }
    M0.setAttribute("position", new THREE.Float32BufferAttribute(f0, 3)), M0.setAttribute("uv", new THREE.Float32BufferAttribute(_0, 2)), M0.computeVertexNormals();
    let F0 = z ? [0, x, 0] : null;
    return A.add(e0, G, null, F0, null, true), A.add(M0, G, null, F0, null, true), rs("rug", [H, 0.012, F], { surf: "carpet", mass: 8 });
  }), e("books", (A) => (A.variant | 0) % 4, (A, O) => {
    let H = w(), F = (O.variant | 0) % 4, P = Re(11 + F * 5), z = [i("leatherTan"), o2.velvetTeal, o2.fabricCharcoal], k = 0, I = 3 + F % 2;
    for (let G = 0; G < I; G++) {
      let K = P.range(0.16, 0.21) - G * 8e-3, $ = P.range(0.23, 0.28) - G * 0.01, n0 = P.range(0.026, 0.05), e0 = P.range(-0.3, 0.3), p0 = z[(G + (O.variant | 0)) % 3], t0 = 32e-4, M0 = n0 * 0.2;
      A.at([0, k, 0], [0, e0, 0], () => {
        A.add(Te(K, t0, $, 12e-4), p0, [0, t0 / 2, 0]), A.add(Te(K, t0, $, 12e-4), p0, [0, n0 - t0 / 2, 0]), A.add(new THREE.CylinderGeometry(n0 / 2, n0 / 2, $, 7, 1, false, Math.PI, Math.PI).rotateX(x), p0, [-K / 2 + 15e-4, n0 / 2, 0], null, [M0 / (n0 / 2), 1, 1]), A.add(T(new THREE.BoxGeometry(K - 9e-3, n0 - t0 * 2, $ - 8e-3), y.pages), H, [22e-4, n0 / 2, 0], null, null, true), A.add(cc($ * 0.72, Math.min(0.026, n0 * 0.6), M((G * 2 + F) % 6)), H, [-K / 2 + 15e-4 - M0 - 4e-4, n0 / 2, 0], [0, -x, 0], null, true);
        for (let f0 of [-$ / 2 + 0.014, $ / 2 - 0.014]) A.add(new THREE.CylinderGeometry(n0 / 2 + 6e-4, n0 / 2 + 6e-4, 4e-3, 7, 1, true, Math.PI, Math.PI).rotateX(x), p0, [-K / 2 + 15e-4, n0 / 2, f0], null, [M0 / (n0 / 2), 1, 1]);
        G === I - 1 && A.add(cc(K * 0.86, $ * 0.86, F % 2 ? y.cover1 : y.cover0), H, [4e-3, n0 + 4e-4, 0], [-x, 0, x * (F % 2, 0)], null, true);
      }), k += n0;
    }
    return rs("books", [0.26, k, 0.32], { surf: "fabric", dynamic: true, mass: 2 });
  }), e("laptop", null, (A) => {
    let O = w(), H = o2.steel, F = o2.plasticBlack, P = (k, I, G) => new THREE.Matrix4().makeTranslation(k, I, G);
    A.add(fi(ui(0.33, 0.225, 0.012), 0.014, 25e-4, 4), H), A.add(cc(0.288, 0.1113, y.keys), O, [0, 0.01425, -0.034], [-x, 0, 0], null, true), A.add(cc(0.104, 0.0644, y.pad), O, [0, 0.01425, 0.067], [-x, 0, 0], null, true), A.add(cc(0.07, 85e-4, y.ports), O, [-0.1652, 68e-4, 0.01], [0, -x, 0], null, true), A.add(cc(0.07, 85e-4, y.ports), O, [0.1652, 68e-4, -0.02], [0, x, 0], null, true), A.add(ks(58e-4, 58e-4, 0.25, 8), F, [0, 0.0128, -0.1085], [0, 0, x]);
    let z = P(0, 0.014, -0.11).multiply(new THREE.Matrix4().makeRotationX(-0.3)).multiply(P(0, 0.105, 0));
    return A.addM(Fr(ui(0.33, 0.21, 0.012), 75e-4, 2e-3, 4), H, z.clone().multiply(P(0, 0, -4e-3))), A.addM(Fr(ui(0.322, 0.202, 9e-3), 22e-4, 6e-4, 3), F, z.clone().multiply(P(0, 0, 35e-4))), A.addM(Te(0.034, 0.034, 8e-4, 3e-4), F, z.clone().multiply(P(0, 0.01, -42e-4))), A.keep("screen", iw(0.31, 0.19), o2.screenOn, null, null, null, { clone: false, uv: true, m: z.clone().multiply(P(0, 0, 65e-4)) }), rs("laptop", [0.33, 0.22, 0.27], { surf: "metal", dynamic: true, mass: 1.5 });
  }), e("receptionBell", null, (A) => (A.add(ji([[0, 0], [0.05, 0], [0.056, 2e-3], [0.058, 6e-3], [0.0555, 85e-4], [0.05, 95e-4], [0.047, 0.013], [0.03, 0.015], [0, 0.015]], 28), o2.ceramicBlack), A.add(ji([[4e-3, 0.015], [0.0505, 0.0168], [0.0512, 0.0185], [0.0498, 0.03], [0.0478, 0.0338], [0.0472, 0.0346], [0.0426, 0.047], [0.034, 0.0565], [0.022, 0.063], [0.012, 0.0665], [0.0102, 0.068], [86e-4, 0.0686], [7e-3, 0.073], [7e-3, 0.079], [0, 0.079]], 28, 28), o2.brass), A.add(ji([[0, 0.079], [42e-4, 0.079], [42e-4, 0.0842], [0.0104, 0.085], [0.012, 0.088], [0.0104, 0.0914], [6e-3, 0.0927], [0, 0.093]], 14), o2.ceramicBlack), A.add(Te(0.012, 4e-3, 0.02, 15e-4), o2.brass, [0.052, 0.0125, 0]), rs("receptionBell", [0.116, 0.092, 0.116], { surf: "metal", mass: 0.4, colliders: [$s(-0.058, 0, -0.058, 0.058, 0.09, 0.058)] })));
  let C = [[[0, 0.011], [0.014, 7e-3], [0.028, 0], [0.0355, 2e-3], [0.0372, 8e-3], [0.0372, 0.172], [0.035, 0.19], [0.027, 0.209], [0.0165, 0.232], [0.0135, 0.248], [0.0135, 0.29], [0.0158, 0.2925], [0.0158, 0.304], [0.0135, 0.31], [0, 0.31]], [[0, 4e-3], [0.036, 0], [0.0445, 3e-3], [0.046, 0.011], [0.046, 0.148], [0.0425, 0.165], [0.032, 0.181], [0.0205, 0.191], [0.017, 0.201], [0.017, 0.232], [0.021, 0.2345], [0.0215, 0.257], [0.018, 0.262], [0, 0.262]], [[0, 6e-3], [0.022, 2e-3], [0.0315, 0], [0.035, 6e-3], [0.035, 0.2], [0.0315, 0.222], [0.0195, 0.248], [0.0135, 0.264], [0.0125, 0.275], [0.0125, 0.312], [0.0152, 0.3145], [0.0155, 0.329], [0.0125, 0.335], [0, 0.335]]], L = [];
  a.bottleGeometry = (A = 0) => {
    let O = ((A | 0) % 3 + 3) % 3;
    return L[O] || (L[O] = { geometry: ke(C[O], 16), material: [o2.bottleGreen, o2.bottleAmber, o2.bottleClear][O] }), L[O];
  };
}
var pr = 1024, Eg = 1024, qm = 4, Rb = { shade: [8, 224], liner: [248, 96], tape: [360, 24], glass: [400, 96], tube: [512, 96], refl: [624, 48] }, Sb = [8, 696, 512, 248], _b = [544, 704, 32, 32], MD = 64, vD = (o2) => [1 - (Rb[o2][0] + Rb[o2][1]) / Eg, 1 - Rb[o2][0] / Eg], wg = (o2) => Math.round(255 * Zt(o2 <= 31308e-7 ? o2 * 12.92 : 1.055 * Math.pow(o2, 1 / 2.4) - 0.055, 0, 1)), cw = (o2, t, e) => `rgb(${wg(o2 / qm)},${wg(t / qm)},${wg(e / qm)})`;
function $j() {
  let o2 = Re(4107), t = (M) => {
    let w = we(pr, Eg), T = w.getContext("2d");
    return T.fillStyle = M, T.fillRect(0, 0, pr, Eg), [w, T];
  }, [e, s] = t("#000"), [n, i] = t("#cfc8ba"), [a, r] = t("#808080"), l = new Float32Array(7), c = (M, w) => {
    let [T, S] = Rb[M], E = 6, _ = S + E * 2, R = s.createImageData(pr, _), C = i.createImageData(pr, _), L = r.createImageData(pr, _);
    for (let A = 0; A < _; A++) {
      let O = Zt(A - E, 0, S - 1), H = 1 - (O + 0.5) / S;
      for (let F = 0; F < pr; F++) {
        l[6] = 0.5, w(H, F, O);
        let P = (A * pr + F) * 4, z = Math.round(Zt(l[6], 0, 1) * 255);
        R.data[P] = wg(l[0] / qm), R.data[P + 1] = wg(l[1] / qm), R.data[P + 2] = wg(l[2] / qm), R.data[P + 3] = 255, C.data[P] = l[3], C.data[P + 1] = l[4], C.data[P + 2] = l[5], C.data[P + 3] = 255, L.data[P] = L.data[P + 1] = L.data[P + 2] = z, L.data[P + 3] = 255;
      }
    }
    s.putImageData(R, 0, T - E), i.putImageData(C, 0, T - E), r.putImageData(L, 0, T - E);
  }, h = (M, w, T, S = 1) => {
    l[0] = M[0] * w, l[1] = M[1] * w, l[2] = M[2] * w, l[3] = T[0] * S, l[4] = T[1] * S, l[5] = T[2] * S;
  }, f = Rb.shade[1], u = new Float32Array(f), d = new Float32Array(pr), m = new Float32Array(pr * f);
  for (let M = 0; M < f; M++) u[M] = 1 + (o2() - 0.5) * 0.1;
  for (let M = 0; M < pr; M++) d[M] = 1 + (o2() - 0.5) * 0.06;
  for (let M = 0; M < 300; M++) {
    let w = o2.int(0, f - 1), T = o2.int(0, pr - 1), S = 14 + o2() * o2() * 170, E = o2() < 0.22 ? 2 : 1, _ = o2() < 0.84 ? -(0.07 + o2() * 0.2) : 0.05 + o2() * 0.06;
    for (let R = 0; R < S; R++) {
      let C = Math.pow(Math.sin(Math.PI * R / S), 0.6);
      for (let L = 0; L < E; L++) w + L < f && (m[(w + L) * pr + (T + R) % pr] += _ * C);
    }
  }
  let p = (M) => Math.pow(1 / (1 + Math.pow((M - 0.5) * 1.72, 2)), 1.5), x = [1.2, 0.8, 0.4], g = [240, 216, 172];
  c("shade", (M, w, T) => {
    let S = p(M), E = m[T * pr + w], _ = u[T] * d[w] * (1 + E), R = w < 9 || w > pr - 10 ? 0.7 : w < 11 || w > pr - 12 ? 0.9 : 1, C = _ * R;
    l[0] = x[0] * Math.pow(S, 0.85) * C, l[1] = x[1] * Math.pow(S, 1.2) * C, l[2] = x[2] * Math.pow(S, 1.75) * C;
    let L = 1 + (_ - 1) * 0.6;
    l[3] = g[0] * L, l[4] = g[1] * L, l[5] = g[2] * L, l[6] = 0.5 - E * 1.3 + (u[T] - 1) * 1.6 + (d[w] - 1) * 1.2;
  }), c("liner", (M) => {
    let w = p(M);
    h([2.3 * Math.pow(w, 0.6), 1.62 * Math.pow(w, 0.8), 0.92 * Math.pow(w, 1.1)], 1, [244, 238, 226]);
  }), c("tape", (M, w, T) => {
    let S = 0.5 + 0.5 * Math.sin((w + T * 1.5) * 1.3);
    h([0.2, 0.085, 0.026], 0.9 + 0.2 * S, [228, 200, 152], 0.96 + 0.04 * S), l[6] = 0.42 + 0.16 * S;
  }), c("glass", (M) => {
    let w = Fo(0, 0.6, M);
    h([Ht(2.6, 4, w), Ht(1.7, 3.5, w), Ht(0.8, 2.6, w)], 1, [250, 243, 230]);
  }), c("tube", (M, w) => {
    let T = Math.pow(Math.sin(Math.PI * Zt(M, 0.02, 0.98)), 0.45), S = 0.5 + 0.5 * Math.cos(w / pr * MD * Vt);
    h([Ht(0.8, 1.55, T), Ht(0.44, 1, T), Ht(0.17, 0.5, T)], 0.8 + 0.34 * S * S, [242, 234, 216]), l[6] = 0.5;
  }), c("refl", (M) => {
    let w = Math.pow(M, 1.25);
    h([Ht(0.62, 1.7, w), Ht(0.34, 1.12, w), Ht(0.12, 0.55, w)], 1, [240, 231, 208]);
  });
  let b = (M, w, T) => {
    let [S, E, _, R] = Sb;
    M.fillStyle = w, M.fillRect(S - 8, E - 8, _ + 16, R + 16), M.fillStyle = T, M.strokeStyle = T, M.lineCap = "round", M.lineJoin = "round", M.lineWidth = 3, M.strokeRect(S + 10.5, E + 10.5, _ - 21, R - 21), M.font = '700 190px Bahnschrift, "Arial Narrow", "Segoe UI", sans-serif', M.textBaseline = "alphabetic", M.textAlign = "left";
    let C = M.measureText("EXIT").width || 300;
    M.save(), M.translate(S + 30, E + R / 2 + 66), M.scale(248 / C, 1), M.fillText("EXIT", 0, 0), M.restore();
    let L = S + 296, A = E + 46, O = 1.56, H = (z, k) => {
      M.lineWidth = k * O, M.beginPath(), z.forEach((I, G) => G ? M.lineTo(L + I[0] * O, A + I[1] * O) : M.moveTo(L + I[0] * O, A + I[1] * O)), M.stroke();
    };
    M.beginPath(), M.arc(L + 60 * O, A + 12 * O, 9.5 * O, 0, Vt), M.fill(), H([[52, 31], [40, 57]], 14), H([[54, 31], [70, 42], [82, 34]], 7), H([[49, 32], [33, 36], [24, 49]], 7), H([[41, 57], [59, 66], [57, 91]], 9), H([[39, 58], [25, 73], [6, 76]], 9);
    let F = S + 436, P = E + R / 2;
    M.beginPath(), M.moveTo(F, P - 11), M.lineTo(F + 28, P - 11), M.lineTo(F + 28, P - 30), M.lineTo(F + 58, P), M.lineTo(F + 28, P + 30), M.lineTo(F + 28, P + 11), M.lineTo(F, P + 11), M.closePath(), M.fill();
  };
  b(s, cw(0.012, 0.42, 0.11), cw(2.5, 3.3, 2.8)), b(i, "rgb(8,72,38)", "rgb(226,244,232)");
  let v = (M, w, T) => {
    let [S, E, _] = _b, R = M.createRadialGradient(S + _ / 2, E + _ / 2, 1, S + _ / 2, E + _ / 2, _ / 2);
    R.addColorStop(0, w), R.addColorStop(0.55, w), R.addColorStop(1, T), M.fillStyle = R, M.fillRect(S - 4, E - 4, _ + 8, _ + 8);
  };
  v(s, cw(0.6, 4, 1.2), cw(0.02, 0.2, 0.05)), v(i, "rgb(150,240,170)", "rgb(20,60,30)");
  let y = { srgb: true, repeatU: true };
  return { map: ll(n, y), em: ll(e, y), nrm: ll(Hd(a, 1.5, true), { srgb: false, repeatU: true }) };
}
var D9 = class extends THREE.MeshStandardMaterial {
  onBeforeCompile(t) {
    t.fragmentShader = t.fragmentShader.replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
	{
		vec3 ghT = inverseTransformDirection( refract( - normalize( vViewPosition ), normal, 0.64 ), viewMatrix );
		vec3 ghK = vec3( dot( ghT, vec3( 31.0, 17.0, 23.0 ) ), dot( ghT, vec3( -13.0, 37.0, 19.0 ) ), dot( ghT, vec3( 21.0, -11.0, 41.0 ) ) );
		vec3 ghF = vec3( 0.0 );
		for ( int i = 0; i < 3; i ++ ) {
			float sc = 0.99 + 0.01 * float( i );
			float gq = sin( ghK.x * sc ) * sin( ghK.y * sc + 1.7 ) * sin( ghK.z * sc + 0.6 );
			ghF[ i ] = 0.12 + 0.55 * smoothstep( -0.2, 0.4, gq ) + 7.0 * pow( max( gq, 0.0 ), 3.0 );
		}
		totalEmissiveRadiance *= ghF;
	}`);
  }
  customProgramCacheKey() {
    return "gh-crystal";
  }
};
function wD({ M: o2, def: t, lib: e }) {
  let n = () => e("lampGlow", () => {
    let p = $j();
    return new THREE.MeshStandardMaterial({ color: 16777215, map: p.map, emissive: 16777215, emissiveMap: p.em, emissiveIntensity: qm * o2.lampShade.emissiveIntensity / 1.05, normalMap: p.nrm, normalScale: new THREE.Vector2(0.8, 0.8), roughness: 0.74, metalness: 0 });
  }), i = () => e("crystal", () => new D9({ color: 16773598, metalness: 1, roughness: 0.07, emissive: 16761466, emissiveIntensity: 1.1 })), a = (p, x, g, b = 1, v = 0, y = 1) => {
    let M = ke(p, x), w = M.attributes.uv, T = p.length, [S, E] = vD(g), _ = [0];
    for (let R = 1; R < T; R++) _.push(_[R - 1] + Math.hypot(p[R][0] - p[R - 1][0], p[R][1] - p[R - 1][1]));
    for (let R = 0; R <= x; R++) for (let C = 0; C < T; C++) w.setXY(R * T + C, R / x * b, Ht(S, E, Ht(v, y, _[C] / _[T - 1])));
    return M;
  }, r = (p, x, g, b, v) => p.keep("bulb", x, n(), g, b, v, { uv: true }), l = (p, x) => new THREE.SplineCurve(p.map((g) => oo(g[0], g[1]))).getPoints(x).map((g) => [Math.max(0, g.x), g.y]), c = (p, x) => p.map((g) => [g[0], g[1] + x]), h = (p, x) => new THREE.Shape([oo(-p / 2, -x / 2), oo(p / 2, -x / 2), oo(p / 2, x / 2), oo(-p / 2, x / 2)]);
  function f(p, x, g, b, v, y, M = true) {
    let S = g - x, E = (H) => b + (v - b) * (H - x) / S, _ = [0, Math.PI, 0], R = x + 0.013, C = g - 0.013, L = 16e-4, A = 13e-4, O = 0.013 / S;
    r(p, a([[E(R), R], [E(C), C]], y, "shade", 1, O, 1 - O), null, _), r(p, a([[E(C) - 22e-4, C], [E(R) - 22e-4, R]], y, "liner", 1, 1 - O, O), null, _), r(p, a([[E(R) - 22e-4, R], [b - 22e-4 - L, x + 3e-3], ...M ? [[b - 22e-4 - 2e-4, x - A], [b + 2e-4, x - A]] : [[b - 22e-4 / 2, x - A - 3e-4]], [b + L, x + 3e-3], [E(R), R]], y, "tape", 6)), r(p, a([[E(C), C], [v + L, g - 3e-3], ...M ? [[v + 2e-4, g + A], [v - 22e-4 - 2e-4, g + A]] : [[v - 22e-4 / 2, g + A + 3e-4]], [v - 22e-4 - L, g - 3e-3], [E(C) - 22e-4, C]], y, "tape", 6));
  }
  let u = (p, x, g, b, v = 95e-4) => p.add(pe(ke([[v, 0], [v - 4e-4, 16e-4], [v - 2e-3, 24e-4], [44e-4, 2e-3]], 8)), x, [g, 0, b]);
  t("floorLamp", null, (p) => {
    let x = o2.brass, g = o2.plasticBlack;
    p.add(pe(ke([[0.1535, 0], [0.1588, 16e-4], [0.1588, 58e-4], [0.1562, 66e-4]], 36)), x), p.add(pe(ke([[0.1562, 66e-4], [0.1562, 0.03], [0.1536, 0.0356], [0.147, 0.0386], [0.03, 0.04]], 36), 40), o2.marbleDark), p.add(pe(ke([[0.047, 0.0392], [0.047, 0.0442], [0.044, 0.0464], [0.034, 0.0476], [0.0235, 0.057], [0.0185, 0.074], [0.0185, 0.08], [0.011, 0.0835]], 20)), x), p.add(ks(0.011, 0.011, 1.21, 12, true), x, [0, 0.087 + 0.605, 0]);
    for (let v of [0.5, 0.92]) p.add(pe(ke(c([[0.011, -0.016], [0.0138, -0.0135], [0.0138, -2e-3], [0.0124, 0], [0.0138, 2e-3], [0.0138, 0.0135], [0.011, 0.016]], v), 10)), x);
    p.add(pe(ke([[0.011, 1.29], [0.0138, 1.294], [0.0138, 1.302], [0.0115, 1.3045], [0.0115, 1.311], [0.0212, 1.333], [0.0212, 1.3445], [0.0192, 1.3465], [0.0192, 1.401], [0.0165, 1.4055]], 10)), x), p.add(pe(new THREE.BoxGeometry(0.064, 26e-4, 0.011)), x, [0, 1.3465, 0]);
    {
      let y = [Math.sin(0.9), Math.cos(0.9)];
      p.rod(g, [y[0] * 0.018, 1.374, y[1] * 0.018], [y[0] * 0.034, 1.374, y[1] * 0.034], 26e-4, 4), p.rod(g, [y[0] * 0.033, 1.374, y[1] * 0.033], [y[0] * 0.042, 1.374, y[1] * 0.042], 62e-4, 8, 54e-4);
    }
    let b = [[0.0285, 1.3475], [0.0295, 1.362], [0.04, 1.395], [0.052, 1.44], [0.054, 1.5], [0.046, 1.56], [0.026, 1.598], [6e-3, 1.6095], [0, 1.6105]];
    for (let v of [-1, 1]) p.add(Qo(ra(b.map((y) => [y[0] * v, y[1], 0]), 15), 21e-4, 4, false, false), x);
    p.add(ks(0.013, 0.013, 34e-4, 8), x, [0, 1.6118, 0]);
    for (let v = 0; v < 3; v++) {
      let y = v / 3 * Vt + 0.52;
      p.rod(x, [Math.sin(y) * 0.011, 1.612, Math.cos(y) * 0.011], [Math.sin(y) * 0.1625, 1.627, Math.cos(y) * 0.1625], 2e-3, 4);
    }
    p.add(pe(ke([[9e-3, 1.6135], [9e-3, 1.619], [44e-4, 1.6215], [44e-4, 1.6255], [86e-4, 1.6296], [0.013, 1.6385], [0.0138, 1.6455], [0.0116, 1.654], [55e-4, 1.6635], [0, 1.671]], 10)), x), r(p, a(c([[0.0135, 0], [0.0135, 0.012], [0.019, 0.03], [0.027, 0.052], [0.03, 0.072], [0.0285, 0.09], [0.021, 0.108], [0.01, 0.118], [0, 0.121]], 1.404), 8, "glass")), f(p, 1.32, 1.63, 0.2, 0.165, 36, false);
    {
      let v = (y, M) => [0.5 * y, M, -0.866 * y];
      p.rod(g, v(0.153, 0.018), v(0.1645, 0.018), 56e-4, 6, 46e-4), p.add(Qo(ra([v(0.162, 0.018), v(0.172, 0.0172), v(0.1815, 0.0115), v(0.1862, 4e-3), v(0.187, -5e-3)], 7), 3e-3, 5), g), u(p, x, 0.5 * 0.187, -0.866 * 0.187, 0.0105);
    }
    return rs("floorLamp", [0.4, 1.67, 0.4], { surf: "metal", dynamic: true, mass: 7, breakable: "bulb", light: { pos: [0, 1.48, 0], color: 16757866, intensity: 1, range: 6 } });
  }), t("tableLamp", (p) => p.variant ? 1 : 0, (p, x) => {
    let g = o2.brass, b = o2.plasticBlack;
    p.add(pe(ke([[0.075, 0], [0.08, 2e-3], [0.08, 72e-4], [0.0765, 0.0104], [0.058, 0.012]], 22)), g), p.add(ke([[0.0605, 0.012], ...l([[0.0612, 0.0135], [0.0585, 0.022], [0.0565, 0.034], [0.064, 0.06], [0.0815, 0.1], [0.0935, 0.146], [0.0905, 0.188], [0.075, 0.23], [0.051, 0.264], [0.0345, 0.284], [0.0292, 0.293], [0.0286, 0.3]], 11)], 20), x.variant ? o2.ceramicBlack : o2.ceramicWhite), p.add(pe(ke([[0.0304, 0.291], [0.0342, 0.2945], [0.0342, 0.3005], [0.03, 0.304], [0.019, 0.3068], [0.013, 0.312], [0.013, 0.3262], [0.0185, 0.3315], [0.0185, 0.3735], [0.015, 0.3772]], 10)), g);
    {
      let y = [Math.sin(1), Math.cos(1)];
      p.rod(b, [y[0] * 0.017, 0.353, y[1] * 0.017], [y[0] * 0.031, 0.353, y[1] * 0.031], 24e-4, 4), p.rod(b, [y[0] * 0.03, 0.353, y[1] * 0.03], [y[0] * 0.038, 0.353, y[1] * 0.038], 56e-4, 8, 5e-3);
    }
    p.add(ks(0.0245, 0.0245, 22e-4, 8), g, [0, 0.3318, 0]);
    for (let v = 0; v < 3; v++) {
      let y = v / 3 * Vt + 0.52;
      p.rod(g, [Math.sin(y) * 0.022, 0.3318, Math.cos(y) * 0.022], [Math.sin(y) * 0.1565, 0.3322, Math.cos(y) * 0.1565], 19e-4, 4);
    }
    return r(p, a(c([[0.0125, 0], [0.0125, 8e-3], [0.017, 0.016], [0.0235, 0.03], [0.0255, 0.043], [0.023, 0.056], [0.015, 0.064], [0, 0.067]], 0.376), 8, "glass")), f(p, 0.33, 0.55, 0.16, 0.125, 28, false), p.rod(b, [0, 58e-4, -0.076], [0, 58e-4, -0.0835], 48e-4, 5, 4e-3), p.add(Qo(ra([[0, 58e-4, -0.082], [5e-4, 52e-4, -0.093], [5e-3, 34e-4, -0.106], [0.013, 3e-3, -0.119], [0.0165, 32e-4, -0.131], [0.0168, 1e-3, -0.1375], [0.0168, -6e-3, -0.139]], 9), 27e-4, 4), b), u(p, b, 0.0168, -0.139), rs("tableLamp", [0.32, 0.55, 0.32], { surf: "ceramic", dynamic: true, mass: 2.5, breakable: "bulb", light: { pos: [0, 0.44, 0], color: 16757866, intensity: 0.7, range: 4.5 } });
  }), t("pendantLamp", (p) => (p.drop || 1).toFixed(2), (p, x) => {
    let g = x.drop || 1, b = o2.brass;
    p.add(pe(ke([[46e-4, -0.047], [78e-4, -0.046], [78e-4, -0.035], [0.012, -0.0315], [0.031, -0.029], [0.046, -0.022], [0.052, -0.012], [0.052, -62e-4], [0.056, -52e-4], [0.056, 0]], 14)), b);
    for (let y of [-1, 1]) p.add(pe(ks(22e-4, 38e-4, 26e-4, 6)), b, [y * 0.0505, -0.0165, 0], [0, 0, -y * 1.2]);
    p.add(ks(36e-4, 36e-4, g - 0.31, 6, true), o2.blackMetal, [0, -(g - 0.31) / 2 - 0.045, 0]), p.add(pe(ke(c([[86e-4, 0.258], [86e-4, 0.266], [6e-3, 0.2685], [37e-4, 0.29]], -g), 6)), o2.blackMetal);
    let v = [[0.1712, -0.0185], [0.1752, -0.0215], [0.1808, -0.0178], [0.1802, -0.0105], ...l([[0.1792, -6e-3], [0.1765, 0.03], [0.165, 0.07], [0.145, 0.112], [0.115, 0.15], [0.08, 0.18], [0.05, 0.197]], 7), [0.041, 0.2], [0.041, 0.206], [0.026, 0.213], [0.022, 0.224], [0.022, 0.235], [0.0135, 0.2385], [96e-4, 0.258]];
    return p.add(pe(ke(c(v, -g), 28)), b), r(p, a(c([[0.018, 0.187], [0.06, 0.18], [0.113, 0.138], [0.152, 0.085], [0.172, 0.03], [0.176, -2e-3], [0.1712, -0.0185]], -g), 28, "refl", 1, 1, 0)), p.add(pe(ke(c([[0.0145, 0.118], [0.0185, 0.12], [0.0185, 0.164], [0.022, 0.168], [0.022, 0.188]], -g), 8)), b), r(p, a(c([[0, 0.026], [0.02, 0.0315], [0.036, 0.047], [0.0425, 0.07], [0.036, 0.092], [0.022, 0.106], [0.014, 0.114], [0.014, 0.121]], -g), 10, "glass", 1, 1, 0)), rs("pendantLamp", [0.36, g + 0.02, 0.36], { surf: "metal", ceiling: true, mass: 3, breakable: "bulb", light: { pos: [0, -g - 0.04, 0], color: 16757866, intensity: 1, range: 6 } });
  });
  function d(p, x, g, b, v) {
    let y = p * 2, M = [], w = [], T = [], [S, E] = vD("tube");
    for (let C = 0; C <= y; C++) {
      let L = Math.PI + C / y * Vt, A = C % 2 ? g : x, O = C / 2 / MD;
      if (M.push(Math.sin(L) * A, b, Math.cos(L) * A, Math.sin(L) * A, v, Math.cos(L) * A), w.push(O, S, O, E), C < y) {
        let H = C * 2;
        T.push(H, H + 2, H + 1, H + 1, H + 2, H + 3);
      }
    }
    let _ = new THREE.BufferGeometry();
    _.setAttribute("position", new THREE.Float32BufferAttribute(M, 3)), _.setAttribute("uv", new THREE.Float32BufferAttribute(w, 2)), _.setIndex(T), _.computeVertexNormals();
    let R = _.attributes.normal;
    for (let C of [0, 1]) {
      let L = R.getX(C) + R.getX(y * 2 + C), A = R.getZ(C) + R.getZ(y * 2 + C), O = Math.hypot(L, A) || 1;
      R.setXYZ(C, L / O, 0, A / O), R.setXYZ(y * 2 + C, L / O, 0, A / O);
    }
    return _;
  }
  t("wallSconce", null, (p) => {
    let x = o2.brass, g = 0.088, b = new THREE.Shape(), v = [[0.027, 0.18], [0.027, 0.167], [0.036, 0.167], [0.036, 0.152], [0.045, 0.152]];
    [...v.map(([S, E]) => [S, -E]), ...v.slice().reverse(), ...v.map(([S, E]) => [-S, E]), ...v.slice().reverse().map(([S, E]) => [-S, -E])].forEach((S, E) => E ? b.lineTo(S[0], S[1]) : b.moveTo(S[0], S[1])), p.add(Fr(b, 6e-3, 15e-4, 1, 1), x), p.add(Fr(h(0.07, 0.268), 62e-4, 18e-4, 1, 1), x, [0, 0, 58e-4]);
    for (let S of [-1, 1]) for (let E of [-1, 1]) p.add(pe(ks(16e-4, 3e-3, 18e-4, 5)), x, [E * 0.0402, S * 0.108, 67e-4], [Math.PI / 2, 0, 0]);
    let M = new THREE.Shape();
    [[8e-3, 0.1545], [0.062, 0.1545], [0.062, 0.1715], [0.038, 0.1715], [0.038, 0.1775], [0.023, 0.1775], [0.023, 0.1835], [8e-3, 0.1835]].forEach((S, E) => E ? M.lineTo(S[0], S[1]) : M.moveTo(S[0], S[1]));
    let w = pe(ke([[0.0395, 0.1492], [0.0436, 0.1484], [0.047, 0.151], [0.047, 0.163], [0.0392, 0.166], [0.0392, 0.174], [0.0302, 0.177], [0.0302, 0.183], [0.013, 0.186], [86e-4, 0.19], [0.0122, 0.1945], [0, 0.2]], 14));
    for (let S of [1, -1]) p.at(null, null, [1, S, 1], () => {
      p.add(pe(Wm(M, 0.02, 12e-4, 1)), x), p.add(w, x, [0, 0, g]);
      for (let E of [-1, 1]) p.add(new THREE.BoxGeometry(0.011, 75e-4, 0.01), x, [E * 0.0505, 0.157, g]);
    });
    let T = new THREE.Shape();
    [[-0.012, -0.187], [0, -0.187], [0, -0.1995], [0.012, -0.1995], [0.012, 0.1995], [0, 0.1995], [0, 0.187], [-0.012, 0.187]].forEach((S, E) => E ? T.lineTo(S[0], S[1]) : T.moveTo(S[0], S[1]));
    for (let S of [-1, 1]) p.add(pe(Wm(T, 5e-3, 9e-4, 1)), x, [S * 0.058, 0, g]);
    return r(p, d(16, 0.04, 0.0368, -0.151, 0.151), [0, 0, g]), rs("wallSconce", [0.13, 0.4, 0.14], { surf: "metal", wall: true, mountY: 1.75, mass: 2, breakable: "bulb", light: { pos: [0, 0, 0.16], color: 16757866, intensity: 0.6, range: 4 } });
  });
  function m(p, x, g = 0.13, b = 0.04) {
    let v = [[p / 2, 0], [p / 4, x / 2], [-p / 4, x / 2], [-p / 2, 0], [-p / 4, -x / 2], [p / 4, -x / 2]], y = [];
    for (let w = 0; w < 6; w++) {
      let [T, S] = v[w], [E, _] = v[(w + 1) % 6];
      y.push(0, 0, 0, T, -b, S, E, -b, _), y.push(T, -b, S, T, -1 + g, S, E, -b, _, E, -b, _, T, -1 + g, S, E, -1 + g, _), y.push(T, -1 + g, S, 0, -1, 0, E, -1 + g, _);
    }
    let M = new THREE.BufferGeometry();
    return M.setAttribute("position", new THREE.Float32BufferAttribute(y, 3)), Eb(M) < 0 && q2(M), M.computeVertexNormals(), M;
  }
  t("chandelier", null, (p) => {
    let x = o2.brass, g = i(), b = Re(1931), v = (C, L, A, O) => p.keep("bulb", C, g, L, A, O);
    p.add(pe(ke([[0.013, -0.118], [0.022, -0.115], [0.022, -0.104], [0.03, -0.098], [0.03, -0.09], [0.045, -0.078], [0.07, -0.07], [0.078, -0.064], [0.078, -0.05], [0.098, -0.044], [0.105, -0.038], [0.105, -0.016], [0.118, -0.012], [0.125, -8e-3], [0.125, 0]], 32)), x);
    for (let C = 0; C < 4; C++) {
      let L = C / 4 * Vt + 0.4;
      p.add(dr(58e-4, 6, 4), x, [Math.sin(L) * 0.088, -0.0475, Math.cos(L) * 0.088]);
    }
    p.add(ks(0.013, 0.013, 1.13, 10, true), x, [0, -0.118 - 0.565, 0]);
    let y = [[0.013, -0.05], [0.019, -0.046], [0.019, -0.036], [0.015, -0.032], [0.024, -0.022], [0.031, -8e-3], [0.031, 8e-3], [0.024, 0.022], [0.015, 0.032], [0.019, 0.036], [0.019, 0.046], [0.013, 0.05]];
    for (let C of [-0.42, -0.8]) p.add(pe(ke(c(y, C), 16)), x);
    p.add(pe(ke([[0.01, -1.642], [0.02, -1.637], [0.026, -1.62], [0.05, -1.61], [0.056, -1.6], [0.056, -1.588], [0.04, -1.58], [0.032, -1.56], [0.032, -1.54], [0.045, -1.52], [0.06, -1.48], [0.064, -1.44], [0.058, -1.4], [0.042, -1.36], [0.03, -1.33], [0.03, -1.31], [0.07, -1.3], [0.076, -1.292], [0.076, -1.28], [0.05, -1.272], [0.028, -1.25], [0.02, -1.235], [0.013, -1.23]], 24)), x), p.add(ks(95e-4, 95e-4, 0.66, 8, true), x, [0, -1.97, 0]), p.add(pe(ke([[0, -2.35], [0.018, -2.35], [0.03, -2.343], [0.15, -2.328], [0.158, -2.32], [0.158, -2.311], [0.15, -2.307], [0.03, -2.298], [95e-4, -2.288]], 24)), x);
    let M = m(0.022, 0.011), w = new THREE.OctahedronGeometry(88e-4, 0).scale(1, 1.2, 1), T = (C, L, A, O, H, F = 1) => {
      let P = O + b.range(-0.5, 0.5), z = b.range(-0.035, 0.035), k = b.range(-0.035, 0.035);
      v(w, [C, L - 0.0105 * F, A], [0, P + 0.6, 0], F), v(M, [C, L - 0.02 * F, A], [z, P, k], [F, H - 0.02 * F, F]);
    }, S = pe(ke([[0.0125, -0.03], [0.0145, -0.028], [0.0145, -4e-3], [0.0105, 0], [0, 0]], 6)), E = [[0, -0.108], [9e-3, -0.104], [0.0155, -0.09], [0.0165, -0.07], [0.0145, -0.046], [0.011, -0.03]], _ = [[-0.018, -0.03], [-0.014, -0.034], [0.014, -0.034], [0.018, -0.03], [0.018, -0.013], [0.022, -9e-3], [0.022, 9e-3], [0.018, 0.013], [0.018, 0.03], [0.014, 0.034], [-0.014, 0.034], [-0.018, 0.03], [-0.018, -0.03]];
    [[1.2, -1.62, 80, 168, 8, [0.03, -0.8], 14], [0.82, -1.92, 56, 120, 6, [0.07, -1.29], 10], [0.45, -2.2, 40, 60, 6, [0.052, -1.594], 6]].forEach(([C, L, A, O, H, F, P], z) => {
      p.add(pe(ke(_.map(([k, I]) => [C + k, L + I]), A), 35), x);
      for (let k = 0; k < H; k++) {
        let I = k / H * Vt + z * 0.5, G = Math.sin(I), K = Math.cos(I), $ = [G * F[0], F[1], K * F[0]], n0 = [G * C, L + 0.04, K * C], e0 = (p0) => [Ht($[0], n0[0], p0), Ht($[1], n0[1], p0), Ht($[2], n0[2], p0)];
        p.rod(x, $, n0, 34e-4, 6), p.rod(x, e0(0.8), e0(0.8 + 0.06 / C), 68e-4, 6), p.add(ks(5e-3, 75e-4, 0.016, 6), x, [G * C, L + 0.041, K * C]);
      }
      for (let k = 0; k < O; k++) {
        let I = k / O * Vt, G = 0.3 + 0.14 * Math.cos(I * 6 + z) + k % 2 * 0.07;
        T(Math.sin(I) * C, L - 0.034, Math.cos(I) * C, I, Math.min(G, 2.735 + L - 0.034));
      }
      for (let k = 0; k < P; k++) {
        let I = (k + 0.5) / P * Vt + z * 0.5, G = Math.sin(I), K = Math.cos(I), $ = C - 0.056;
        p.add(new THREE.BoxGeometry(0.01, 7e-3, 0.042), x, [G * (C - 0.036), L - 0.027, K * (C - 0.036)], [0, I, 0]), p.add(S, x, [G * $, L - 0.024, K * $]), r(p, a(E, 6, "glass", 1, 1, 0.1), [G * $, L - 0.024, K * $]);
      }
    });
    for (let C = 0; C < 22; C++) {
      let L = C / 22 * Vt;
      T(Math.sin(L) * 0.15, -2.328, Math.cos(L) * 0.15, L, 0.2 + C % 2 * 0.07 + 0.05 * Math.cos(L * 2));
    }
    for (let C = 0; C < 9; C++) {
      let L = C / 9 * Vt + 0.2;
      T(Math.sin(L) * 0.08, -2.338, Math.cos(L) * 0.08, L, 0.3 + C % 2 * 0.05);
    }
    return v(w, [0, -2.362, 0], null, 1.5), v(uD(ke([[0, -2.728], [0.02, -2.67], [0.036, -2.59], [0.03, -2.49], [0.014, -2.4], [0, -2.376]], 8)), null, [0, 0.2, 0]), rs("chandelier", [2.44, 2.72, 2.44], { surf: "metal", ceiling: true, mass: 120, breakable: "bulb", light: { pos: [0, -2, 0], color: 16761466, intensity: 3, range: 14 } });
  }), t("exitSign", (p) => p.ceiling ? "c" : "w", (p, x) => {
    let g = o2.blackMetal, b = o2.brass, v = n(), y = { color: 5111706, intensity: 0.3, range: 3 }, M = cc(0.332, 0.161, hu(Sb[0], Sb[1], Sb[2], Sb[3], pr, Eg)), w = Dl(0.352, 0.182, [[0, 0], [0, 35e-4], [2e-3, 55e-4], [9e-3, 55e-4], [0.011, 35e-4], [0.011, 0]]), T = (E, _) => p.at([0, 0, 0], [0, _, 0], null, () => {
      p.add(w, b, [0, 0, E]), p.add(M, v, [0, 0, E + 16e-4], null, null, true);
    }), S = (E, _) => {
      p.add(ks(4e-3, 4e-3, 3e-3, 6), b, [0.135, E - 12e-4, _]), p.add(cc(7e-3, 7e-3, hu(_b[0], _b[1], _b[2], _b[3], pr, Eg)), v, [0.118, E - 4e-4, _], [Math.PI / 2, 0, 0], null, true);
    };
    if (x.ceiling) {
      p.add(fi(h(0.3, 0.038), 7e-3, 2e-3, 1, 1), g, [0, -7e-3, 0]);
      for (let E of [-1, 1]) p.add(ks(52e-4, 52e-4, 0.114, 6, true), b, [E * 0.12, -0.064, 0]), p.add(pe(ke([[52e-4, -0.022], [85e-4, -0.02], [85e-4, -0.0105], [0.013, -9e-3], [0.013, -7e-3]], 6)), b, [E * 0.12, 0, 0]), p.add(pe(ke([[0.0105, -0.1205], [0.0105, -0.117], [75e-4, -0.1155], [52e-4, -0.11]], 6)), b, [E * 0.12, 0, 0]);
      return p.add(Fr(h(0.36, 0.19), 0.046, 4e-3, 1, 1), g, [0, -0.215, -0.023]), T(0.023, 0), T(0.023, Math.PI), p.parts.slice(-4).forEach((E) => {
        E.m = new THREE.Matrix4().makeTranslation(0, -0.215, 0).multiply(E.m);
      }), S(-0.31, 0), rs("exitSign", [0.36, 0.31, 0.05], { surf: "plastic", ceiling: true, mass: 1.5, light: { ...y, pos: [0, -0.22, 0] } });
    }
    return p.add(Fr(h(0.36, 0.19), 0.046, 4e-3, 1, 1), g), T(0.046, 0), p.add(Qo(ra([[0.1, 0.092, 0.03], [0.1, 0.108, 0.029], [0.1, 0.119, 0.02], [0.1, 0.121, 0]], 5), 7e-3, 6), g), p.add(pe(ke([[98e-4, 0.094], [98e-4, 0.1], [78e-4, 0.1015]], 6)), b, [0.1, 0, 0.03]), S(-0.095, 0.03), rs("exitSign", [0.36, 0.19, 0.05], { surf: "plastic", wall: true, mountY: 2.35, mass: 1.5, light: { ...y, pos: [0, 0, 0.15] } });
  });
}
var K2 = Math.PI / 180, uw = typeof location < "u" && /[?&]atlas=1/.test(location.search), la = 2048, gr = 1024, mr = (o2, t, e, s, n = true, i = 4) => ({ x: o2, y: t, w: e, h: s, horiz: n, pad: i }), Ks = { leaflet: [0, 1, 2, 3].map((o2) => mr(0, o2 * 56, 640, 56)), pampas: [0, 1].map((o2) => mr(640, o2 * 112, 448, 112)), sans: [0, 1].map((o2) => mr(0, 224 + o2 * 112, 1024, 112)), fig: [mr(1088, 0, 320, 448, false), mr(1408, 0, 320, 448, false), mr(1728, 0, 320, 448, false), mr(1152, 448, 320, 448, false)], fan: mr(0, 448, 384, 200, false), mulch: mr(384, 448, 256, 256, false, 2), pebble: mr(640, 448, 256, 256, false, 2), moss: mr(896, 448, 256, 256, false, 2), bark: mr(0, 896, 512, 128), petiole: mr(512, 896, 384, 128), trunk: mr(896, 896, 256, 128), branch: mr(1152, 896, 256, 128), straw: mr(1408, 896, 128, 128), dark: mr(1536, 896, 64, 128), twig: mr(1600, 896, 256, 128), spear: mr(1856, 896, 192, 128) }, Ab = (o2, t, e) => o2.horiz ? [o2.x + o2.pad + t * (o2.w - 2 * o2.pad), o2.y + o2.h / 2 - e * (o2.h / 2 - o2.pad)] : [o2.x + o2.w / 2 + e * (o2.w / 2 - o2.pad), o2.y + o2.h - o2.pad - t * (o2.h - 2 * o2.pad)], pw = (o2, t, e) => {
  let s = Ab(o2, t, e);
  return [s[0] / la, 1 - s[1] / gr];
}, kb = (o2) => 0.9 * (o2 < 0.28 ? 0.3 + 0.7 * Math.sin(Math.PI / 2 * o2 / 0.28) : Math.pow(Math.max(0, 1 - Math.pow((o2 - 0.28) / 0.72, 1.9)), 0.85)), Cb = (o2) => 0.9 * Ht(0.58, 1, Fo(0, 0.4, o2)) * (o2 > 0.6 ? Math.pow(Math.max(0, 1 - Math.pow((o2 - 0.6) / 0.4, 2.3)), 0.9) : 1), Pb = (o2) => o2 < 0.1 ? 0.05 : Math.max(0.05, 0.94 * Math.pow(Math.sin(Math.PI * Math.pow((o2 - 0.1) / 0.9, 0.62)), 0.8)), Km = [[0.085, 0], [0.068, 0.1], [0.06, 0.22], [0.072, 0.33], [0.11, 0.44], [0.16, 0.52], [0.24, 0.575], [0.34, 0.56], [0.44, 0.52], [0.55, 0.66], [0.66, 0.88], [0.76, 0.98], [0.85, 0.95], [0.92, 0.78], [0.97, 0.48], [0.995, 0.14], [1, 0]], I9 = 0.93, Zj = [[0, 0.07], [0.055, 0.44], [0.16, 0.6], [0.42, 0.58], [0.62, 0.89], [0.78, 0.99], [0.92, 0.87], [1, 0.3]], F9 = (o2, t, e = 1.06) => t.map((s, n) => {
  let i = (s + t[Math.max(0, n - 1)]) / 2, a = (s + t[Math.min(t.length - 1, n + 1)]) / 2, r = 0;
  for (let l = 0; l <= 12; l++) r = Math.max(r, o2(i + (a - i) * l / 12));
  return [s, Zt(r * e, 0.05, 1)];
}), Qj = F9(kb, [0, 0.3, 0.68, 1]), Jj = [[0, 0.6], [0.42, 0.95], [1, 0.25]], t$ = F9(Cb, [0, 0.14, 0.3, 0.48, 0.64, 0.78, 0.9, 1]), e$ = F9(Pb, [0, 0.1, 0.24, 0.44, 0.72, 1], 1.03), dw = 12, zb = 1.5, ED = 0.6;
function s$() {
  let o2 = [0, 1, 2, 3].map(() => we(la, gr)), [t, e, s, n] = o2.map((F) => F.getContext("2d", { willReadFrequently: true })), i = [t, e, s, n], a = (F, P = 1) => {
    let z = Math.round(Zt(F, 0, 1) * 255);
    return `rgba(${z},${z},${z},${P})`;
  }, r = (F, P, z) => {
    F.fillStyle = z, F.fillRect(P.x, P.y, P.w, P.h);
  };
  t.fillStyle = "#2f4f22", t.fillRect(0, 0, la, gr), e.fillStyle = "#000", e.fillRect(0, 0, la, gr), s.fillStyle = a(0.5), s.fillRect(0, 0, la, gr), n.fillStyle = a(0.6), n.fillRect(0, 0, la, gr);
  let l = (F, P) => {
    for (let z of i) z.save(), z.beginPath(), z.rect(F.x, F.y, F.w, F.h), z.clip(), z.lineCap = "round", z.lineJoin = "round";
    P();
    for (let z of i) z.restore();
  }, c = (F, P, z) => {
    F.beginPath(), F.moveTo(P[0][0], P[0][1]);
    for (let k = 1; k < P.length; k++) F.lineTo(P[k][0], P[k][1]);
    F.closePath(), z && (F.fillStyle = z, F.fill());
  }, h = (F, P, z, k) => {
    F.beginPath(), F.moveTo(P[0][0], P[0][1]);
    for (let I = 1; I < P.length; I++) F.lineTo(P[I][0], P[I][1]);
    F.lineWidth = z, F.strokeStyle = k, F.stroke();
  }, f = (F, P, z, k, I) => {
    F.strokeStyle = I;
    for (let G = 1; G < P.length; G++) F.beginPath(), F.moveTo(P[G - 1][0], P[G - 1][1]), F.lineTo(P[G][0], P[G][1]), F.lineWidth = Ht(z, k, (G - 0.5) / (P.length - 1)), F.stroke();
  }, u = (F, P, z, k, I, G, K = k) => {
    let $ = F.createRadialGradient(0, 0, 0, 0, 0, k);
    $.addColorStop(0, `rgba(${I},${G})`), $.addColorStop(1, `rgba(${I},0)`), F.save(), F.translate(P, z), F.scale(1, K / k), F.fillStyle = $, F.fillRect(-k, -k, 2 * k, 2 * k), F.restore();
  }, d = (F, P, z, k = 10) => {
    let I = [];
    for (let G = 0; G <= k; G++) {
      let K = G / k, $ = (1 - K) * (1 - K), n0 = 2 * K * (1 - K), e0 = K * K;
      I.push([F[0] * $ + P[0] * n0 + z[0] * e0, F[1] * $ + P[1] * n0 + z[1] * e0]);
    }
    return I;
  }, m = (F, P, { base: z, hi: k, lo: I, rib: G, tip: K = 0, wash: $ = null }) => l(F, () => {
    let n0 = Re(P), e0 = (m0, S0) => Ab(F, m0, S0), p0 = 48, t0 = [];
    for (let m0 = 0; m0 <= p0; m0++) t0.push(e0(m0 / p0, kb(m0 / p0)));
    for (let m0 = p0; m0 >= 0; m0--) t0.push(e0(m0 / p0, -kb(m0 / p0)));
    r(t, F, z), r(s, F, a(0.5)), r(n, F, a(0.4)), c(e, t0, "#fff");
    let M0 = e0(0, 0)[0], f0 = e0(1, 0)[0], _0 = t.createLinearGradient(M0, 0, f0, 0);
    _0.addColorStop(0, k), _0.addColorStop(0.2, z), _0.addColorStop(0.75, z), _0.addColorStop(1, I), t.globalAlpha = 0.6, r(t, F, _0), t.globalAlpha = 1;
    for (let m0 = 0; m0 < 30; m0++) {
      let S0 = e0(n0(), n0.range(-0.8, 0.8)), T0 = n0() < 0.5;
      u(t, S0[0], S0[1], 8 + n0() * 26, T0 ? "10,34,8" : "128,168,62", 0.1 + n0() * 0.12, 5 + n0() * 6);
    }
    for (let m0 = 0; m0 <= 18; m0++) {
      let S0 = -1 + 2 * m0 / 18, T0 = [];
      for (let Z0 = 0; Z0 <= 20; Z0++) {
        let lt = Z0 / 20;
        T0.push(e0(lt, S0 * kb(lt) * 0.97));
      }
      let j0 = m0 % 2 === 0;
      h(t, T0, 0.8 + n0() * 1.1, j0 ? `rgba(156,196,96,${0.1 + n0() * 0.16})` : `rgba(8,26,6,${0.12 + n0() * 0.18})`), h(s, T0, 2.4, a(j0 ? 0.68 : 0.34));
    }
    let F0 = [e0(0, 0), e0(0.985, 0)];
    h(t, F0, 4, "rgba(16,36,10,0.4)"), f(t, d(F0[0], e0(0.5, 0), F0[1], 6), 2.6, 1.1, G), h(s, F0, 6, a(0.7)), h(s, F0, 2.4, a(0.92)), h(n, F0, 3, a(0.32));
    for (let m0 of [-1, 1]) {
      let S0 = [];
      for (let T0 = 1; T0 <= 19; T0++) {
        let j0 = T0 / 20;
        S0.push(e0(j0, m0 * 0.5 * kb(j0)));
      }
      h(t, S0, 1.3, "rgba(120,160,70,0.4)"), h(s, S0, 3, a(0.74));
    }
    if ($ && (t.globalAlpha = $[1], r(t, F, $[0]), t.globalAlpha = 1), K > 0) {
      let m0 = e0(1 - K * 2.1, 0)[0], S0 = t.createLinearGradient(m0, 0, f0, 0);
      S0.addColorStop(0, "rgba(176,166,60,0)"), S0.addColorStop(0.32, "rgba(178,164,62,0.8)"), S0.addColorStop(0.5, "rgba(170,132,72,1)"), S0.addColorStop(1, "rgba(104,72,40,1)"), t.fillStyle = S0, t.fillRect(m0, F.y, f0 - m0 + 8, F.h);
      let T0 = n.createLinearGradient(m0, 0, f0, 0);
      T0.addColorStop(0, a(0.85, 0)), T0.addColorStop(0.5, a(0.85, 1)), n.fillStyle = T0, n.fillRect(m0, F.y, f0 - m0 + 8, F.h);
      for (let j0 = 0; j0 < 14; j0++) {
        let Z0 = e0(n0.range(1 - K * 1.6, 1), n0.range(-0.4, 0.4));
        u(t, Z0[0], Z0[1], 2 + n0() * 4, "70,46,24", 0.5);
      }
    }
  }), p = (F, P, { base: z, vein: k, mott: I, dark: G, pet: K, rough: $ = 0.33, brown: n0 = 0, soft: e0 = 1 }) => l(F, () => {
    let p0 = Re(P), t0 = (Y0, et) => Ab(F, Y0, et), M0 = Km.length, f0 = (Y0, et, ct) => {
      let D0 = [];
      for (let u0 = 0; u0 < M0 - 1; u0++) for (let w0 = 0; w0 < 6; w0++) {
        let P0 = w0 / 6, st = Km[Math.max(0, u0 - 1)], J0 = Km[u0], q0 = Km[u0 + 1], v0 = Km[Math.min(M0 - 1, u0 + 2)], x0 = (O0, B0, ot, Q0) => 0.5 * (2 * B0 + (ot - O0) * P0 + (2 * O0 - 5 * B0 + 4 * ot - Q0) * P0 * P0 + (3 * B0 - O0 - 3 * ot + Q0) * P0 * P0 * P0), C0 = x0(st[0], J0[0], q0[0], v0[0]), k0 = Math.max(0, x0(st[1], J0[1], q0[1], v0[1]));
        D0.push(t0(C0, Y0 * k0 * I9 * ct * (1 + 0.032 * Math.sin(C0 * 34 + et) + 0.014 * Math.sin(C0 * 83 + et * 2.3))));
      }
      return D0.push(t0(1, 0)), D0;
    }, _0 = (Y0) => {
      for (let et = 3; et < M0 - 1; et++) {
        let ct = Km[et], D0 = Km[et + 1];
        if (Y0 <= D0[0]) return I9 * Ht(ct[1], D0[1], Zt((Y0 - ct[0]) / (D0[0] - ct[0]), 0, 1));
      }
      return 0;
    }, F0 = f0(1, p0() * 6, 1), m0 = f0(-1, p0() * 6, 0.96), S0 = [...F0, ...m0.reverse()];
    r(t, F, z), r(s, F, a(0.5)), r(n, F, a($)), c(e, S0, "#fff");
    let T0 = [t0(0, 0), t0(0.1, 0)];
    h(e, T0, 11, "#fff");
    for (let Y0 = 0; Y0 < 90; Y0++) {
      let et = p0.range(0.08, 0.99), ct = t0(et, p0.range(-1, 1) * _0(et)), D0 = p0() < 0.45;
      u(t, ct[0], ct[1], 12 + p0() * 38, D0 ? G : I, 0.1 + p0() * 0.16);
    }
    t.save(), c(t, S0), t.clip(), t.lineJoin = "round", h(t, [...S0, S0[0]], 16, `rgba(${G},0.22)`), h(t, [...S0, S0[0]], 5, `rgba(${G},0.25)`), t.restore(), s.save(), c(s, S0), s.clip(), h(s, [...S0, S0[0]], 22, a(0.38, 0.5)), s.restore();
    let j0 = [0.1, 0.118, 0.2, 0.31, 0.42, 0.53, 0.635, 0.735, 0.825, 0.9], Z0 = { "-1": [], 1: [] };
    for (let Y0 of [-1, 1]) j0.forEach((et, ct) => {
      let D0 = p0.range(-0.012, 0.012), u0, w0;
      ct === 0 ? (u0 = 0.078, w0 = 0.29 * I9) : ct === 1 ? (u0 = 0.19, w0 = _0(0.19) * 0.9) : (u0 = Math.min(0.985, et + 0.1 + 0.05 * p0() - (ct > 7 ? 0.035 : 0)), w0 = _0(u0) * 0.87), Z0[Y0].push(d(t0(et + D0, 0), t0(et + D0 + (u0 - et) * 0.22, Y0 * w0 * 0.66), t0(u0, Y0 * w0), 12));
    });
    let lt = `rgba(${k},${0.95 * e0})`;
    for (let Y0 of [-1, 1]) {
      let et = Z0[Y0];
      for (let ct = 1; ct < et.length - 1; ct++) {
        let D0 = et[ct], u0 = et[ct + 1];
        for (let q0 = 3; q0 <= 11; q0++) {
          let v0 = D0[q0], x0 = u0[Math.max(1, q0 - 1)], C0 = [(v0[0] + x0[0]) / 2 + p0.range(-3, 3), (v0[1] + x0[1]) / 2 + p0.range(-3, 3)], k0 = d(v0, C0, x0, 4);
          h(t, k0, 1, `rgba(${k},${0.28 * e0})`), h(s, k0, 2.2, a(0.36, 0.7));
        }
        for (let q0 = 3; q0 <= 10; q0 += 2) {
          let v0 = D0[q0], x0 = u0[q0 - 1];
          u(s, (v0[0] + x0[0]) / 2, (v0[1] + x0[1]) / 2, 13 + q0 * 1.3, "235,235,235", 0.45);
        }
        let w0 = D0[12], P0 = u0[10], st = (j0[ct] + j0[ct + 1]) / 2 + 0.11, J0 = d(w0, t0(Math.min(0.99, st), Y0 * _0(Math.min(0.99, st)) * 0.94), P0, 6);
        h(t, J0, 1.6, `rgba(${k},${0.6 * e0})`), h(s, J0, 3, a(0.3, 0.8));
      }
      for (let ct of et) f(s, ct, 9, 4, a(0.2, 0.55)), f(s, ct, 4, 1.6, a(0.12)), f(t, ct, 5.5, 2.4, `rgba(${G},0.3)`), f(t, ct, 3.4, 1.3, lt), f(n, ct, 4, 2, a(0.44));
    }
    let H0 = [t0(0.085, 0), t0(0.3, 4e-3), t0(0.6, -4e-3), t0(0.99, 0)];
    f(s, H0, 15, 5, a(0.22, 0.6)), f(s, H0, 8, 2, a(0.1)), f(t, H0, 11, 4, `rgba(${G},0.35)`), f(t, H0, 7.5, 1.8, `rgb(${k})`), f(t, H0, 2, 0.6, "rgba(235,240,190,0.5)"), f(n, H0, 8, 2, a(0.4)), h(t, T0, 13, K), h(t, T0, 3, "rgba(230,235,180,0.35)"), h(s, T0, 10, a(0.8)), h(n, T0, 13, a(0.5));
    for (let Y0 = 0; Y0 < n0; Y0++) {
      let et = p0.range(0.35, 0.95), ct = p0.sign(), D0 = t0(et, ct * _0(et) * 0.97), u0 = 16 + p0() * 22;
      u(t, D0[0], D0[1], u0 * 1.7, "168,150,64", 0.55), u(t, D0[0], D0[1], u0, "92,62,34", 1), u(t, D0[0], D0[1], u0 * 0.6, "70,46,26", 0.9), u(n, D0[0], D0[1], u0 * 1.2, "225,225,225", 1), u(s, D0[0], D0[1], u0, "70,70,70", 0.6);
      for (let w0 = 0; w0 < 5; w0++) {
        let P0 = t0(p0.range(0.2, 0.95), p0.range(-0.8, 0.8) * _0(0.6));
        u(t, P0[0], P0[1], 2.5 + p0() * 4, "84,58,30", 0.8);
      }
    }
  }), x = (F, P, { dark: z, band: k, margin: I, mw: G }) => l(F, () => {
    let K = Re(P), $ = _n(P + 3), n0 = (T0, j0) => Ab(F, T0, j0), e0 = 64, p0 = [], t0 = [];
    for (let T0 = 0; T0 <= e0; T0++) p0.push(n0(T0 / e0, Cb(T0 / e0))), t0.push(n0(T0 / e0, Math.max(0, Cb(T0 / e0) - G * (0.75 + 0.5 * $.noise(T0 * 0.35, 1)))));
    for (let T0 = e0; T0 >= 0; T0--) p0.push(n0(T0 / e0, -Cb(T0 / e0))), t0.push(n0(T0 / e0, -Math.max(0, Cb(T0 / e0) - G * (0.75 + 0.5 * $.noise(T0 * 0.35, 9)))));
    r(t, F, I), r(s, F, a(0.56)), r(n, F, a(0.36)), c(e, p0, "#fff");
    for (let T0 = 0; T0 < 40; T0++) {
      let j0 = n0(K(), K.sign() * K.range(0.6, 1));
      u(t, j0[0], j0[1], 10 + K() * 30, K() < 0.5 ? "226,214,150" : "176,150,58", 0.25, 6);
    }
    t.save(), c(t, t0), t.clip(), r(t, F, z);
    let M0 = n0(0, 0)[0], f0 = n0(1, 0)[0], _0 = t.createLinearGradient(M0, 0, f0, 0);
    _0.addColorStop(0, "rgba(150,170,120,0.5)"), _0.addColorStop(0.12, "rgba(60,90,50,0)"), _0.addColorStop(1, "rgba(10,30,14,0.25)"), r(t, F, _0);
    let F0 = 0.012;
    for (; F0 < 0.975; ) {
      let T0 = K.range(4e-3, 0.012), j0 = [], Z0 = [];
      for (let lt = 0; lt <= 16; lt++) {
        let H0 = -1 + 2 * lt / 16, Y0 = ($.noise(F0 * 60, lt * 0.8) - 0.5) * 0.02 + 4e-3 * Math.sin(lt * 2.3 + F0 * 70);
        j0.push(n0(F0 + Y0 + T0 * (0.4 + K() * 0.9), H0)), Z0.push(n0(F0 + Y0 - T0 * (0.4 + K() * 0.9), H0));
      }
      c(t, [...j0, ...Z0.reverse()], `rgba(${k},${0.42 + K() * 0.45})`), F0 += T0 + K.range(0.01, 0.03);
    }
    for (let T0 = 0; T0 < 44; T0++) {
      let j0 = K.range(-1, 1), Z0 = [n0(0, j0 * 0.6), n0(0.4, j0), n0(1, j0 * 0.2)];
      h(t, d(Z0[0], Z0[1], Z0[2], 8), 1, T0 % 2 ? "rgba(8,24,10,0.14)" : "rgba(170,200,160,0.1)"), h(s, d(Z0[0], Z0[1], Z0[2], 8), 1.6, a(T0 % 2 ? 0.44 : 0.62, 0.6));
    }
    t.restore(), h(t, t0.slice(0, e0 + 1), 1.6, "rgba(24,48,22,0.55)"), h(t, t0.slice(e0 + 1), 1.6, "rgba(24,48,22,0.55)"), h(s, p0.slice(0, e0 + 1), 5, a(0.4, 0.8)), h(s, p0.slice(e0 + 1), 5, a(0.4, 0.8));
    let m0 = n0(0.965, 0)[0], S0 = t.createLinearGradient(m0, 0, f0, 0);
    S0.addColorStop(0, "rgba(150,120,70,0)"), S0.addColorStop(0.6, "rgba(138,104,62,1)"), S0.addColorStop(1, "rgba(90,62,38,1)"), t.fillStyle = S0, t.fillRect(m0, F.y, f0 - m0 + 8, F.h);
  }), g = (F, P) => l(F, () => {
    let z = Re(P), k = ($, n0) => Ab(F, $, n0), I = [];
    r(t, F, "#d6c6a2"), r(s, F, a(0.3)), r(n, F, a(0.96));
    for (let $ = 0; $ <= 30; $++) {
      let n0 = 0.1 + 0.86 * $ / 30;
      I.push(k(n0, Pb(n0) * 0.42));
    }
    for (let $ = 30; $ >= 0; $--) {
      let n0 = 0.1 + 0.86 * $ / 30;
      I.push(k(n0, -Pb(n0) * 0.42));
    }
    c(e, I, "#fff"), c(s, I, a(0.5));
    let G = ["236,226,200", "222,208,174", "204,186,146", "242,236,216", "190,170,128"];
    for (let $ = 0; $ < 620; $++) {
      let n0 = Math.pow(z(), 0.8) * 0.84 + 0.1, e0 = z.sign(), p0 = z.range(0.07, 0.2), t0 = Math.min(0.995, n0 + p0), M0 = Pb(t0) * z.range(0.3, 1), f0 = d(k(n0, e0 * 0.02), k(n0 + p0 * 0.6, e0 * M0 * 0.3), k(t0, e0 * M0), 6);
      h(e, f0, 2.6 + z() * 1.2, "#fff"), h(t, f0, 1.4 + z() * 1.6, `rgba(${z.pick(G)},${0.55 + z() * 0.45})`), h(s, f0, 2, a(0.5 + z() * 0.45));
    }
    for (let $ = 0; $ < 260; $++) {
      let n0 = z.range(0.12, 0.97), e0 = k(n0, z.range(-1, 1) * Pb(n0) * 0.8);
      u(t, e0[0], e0[1], 2 + z() * 3, z() < 0.5 ? "250,246,232" : "170,148,104", 0.5);
    }
    let K = [k(0, 0), k(0.6, 0)];
    h(e, [k(0, 0), k(0.14, 0)], 6, "#fff"), f(t, d(K[0], k(0.3, 0), K[1], 6), 5, 1.5, "rgb(170,146,98)"), h(s, K, 4, a(0.8));
  }), b = (F) => l(F, () => {
    let P = Re(31), z = F.x + F.w / 2, k = F.y + F.h - F.pad, I = Math.min(F.h - 2 * F.pad, F.w / 2 - F.pad), G = (K, $) => [z + Math.sin(K) * $, k - Math.cos(K) * $];
    r(t, F, "#cdb98e"), r(s, F, a(0.5)), r(n, F, a(0.8));
    for (let K = 0; K < dw; K++) {
      let $ = -zb + 2 * zb * (K + 0.5) / dw, n0 = zb / dw, e0 = I * P.range(0.86, 0.99), p0 = I * ED, t0 = G($, 0), M0 = G($ - n0, p0), f0 = G($ + n0, p0), _0 = G($ + P.range(-0.02, 0.02), e0);
      c(e, [t0, M0, _0, f0], "#fff"), c(t, [t0, M0, _0], K % 2 ? "#d8c89e" : "#cfbd92"), c(t, [t0, _0, f0], K % 2 ? "#bca97c" : "#c4b084"), c(s, [t0, M0, _0], a(0.34)), c(s, [t0, _0, f0], a(0.66));
      for (let F0 = 0; F0 < 5; F0++) {
        let m0 = P.range(-0.8, 0.8);
        h(t, [t0, G($ + n0 * m0, p0), _0], 0.8, "rgba(120,98,60,0.22)");
      }
      h(t, [t0, _0], 1.6, "rgba(150,128,84,0.9)"), h(t, [t0, M0], 1.2, "rgba(110,90,56,0.5)"), h(s, [t0, _0], 2.5, a(0.9)), u(t, _0[0], _0[1], 12, "150,116,70", 0.5);
    }
    u(t, z, k, 40, "150,124,78", 0.6);
  }), v = (F) => l(F, () => {
    let P = Re(57), z = F.x + F.w / 2, k = F.y + F.h / 2, I = ["92,58,34", "108,70,40", "64,42,26", "124,86,52", "78,50,30", "54,36,24"];
    r(t, F, "#4a3020"), r(s, F, a(0.2)), r(n, F, a(0.95)), u(e, z, k, 86, "255,255,255", 1), e.fillStyle = "#fff", e.beginPath(), e.arc(z, k, 62, 0, Vt), e.fill(), u(t, z, k, 120, "30,20,14", 0.9);
    for (let G = 0; G < 230; G++) {
      let K = G > 90, $ = P() * Vt, n0 = Math.sqrt(P()) * (K ? 108 : 100), e0 = z + Math.cos($) * n0, p0 = k + Math.sin($) * n0, t0 = P.range(7, 19) * (K ? 1 : 0.8), M0 = t0 * P.range(0.35, 0.6), f0 = P() * Math.PI, _0 = 5 + (P() * 3 | 0), F0 = [];
      for (let Z0 = 0; Z0 < _0; Z0++) {
        let lt = Z0 / _0 * Vt + P.range(-0.3, 0.3), H0 = P.range(0.75, 1.1), Y0 = Math.cos(lt) * t0 * H0, et = Math.sin(lt) * M0 * H0;
        F0.push([e0 + Y0 * Math.cos(f0) - et * Math.sin(f0), p0 + Y0 * Math.sin(f0) + et * Math.cos(f0)]);
      }
      let m0 = P.pick(I), S0 = t.createLinearGradient(e0 - t0, p0 - t0, e0 + t0, p0 + t0);
      S0.addColorStop(0, `rgb(${m0})`), S0.addColorStop(1, "rgb(40,26,18)"), c(e, F0, "#fff"), c(t, F0, S0), h(t, [...F0, F0[0]], 1, "rgba(20,12,8,0.6)");
      for (let Z0 = 0; Z0 < 3; Z0++) {
        let lt = P.range(-0.6, 0.6);
        h(t, [[e0 - Math.cos(f0) * t0 * 0.8 - Math.sin(f0) * M0 * lt, p0 - Math.sin(f0) * t0 * 0.8 + Math.cos(f0) * M0 * lt], [e0 + Math.cos(f0) * t0 * 0.8 - Math.sin(f0) * M0 * lt, p0 + Math.sin(f0) * t0 * 0.8 + Math.cos(f0) * M0 * lt]], 0.8, "rgba(160,120,80,0.25)");
      }
      let T0 = P.range(0.35, 0.95), j0 = s.createLinearGradient(e0 - t0, p0 - t0, e0 + t0, p0 + t0);
      j0.addColorStop(0, a(T0)), j0.addColorStop(1, a(T0 * 0.55)), c(s, F0, j0);
    }
  }), y = (F) => l(F, () => {
    let P = Re(83), z = F.x + F.w / 2, k = F.y + F.h / 2, I = ["214,208,194", "188,180,166", "150,144,134", "228,222,208", "170,160,142", "108,102,94", "200,188,168"];
    r(t, F, "#6e6a60"), r(s, F, a(0.12)), r(n, F, a(0.62)), e.fillStyle = "#fff", e.beginPath(), e.arc(z, k, 70, 0, Vt), e.fill(), u(t, z, k, 124, "34,30,26", 0.95);
    let G = [];
    for (let K = 0; K < 900 && G.length < 150; K++) {
      let $ = P() * Vt, n0 = Math.sqrt(P()) * 112, e0 = z + Math.cos($) * n0, p0 = k + Math.sin($) * n0, t0 = P.range(6, 15) * (G.length < 60 ? 1.15 : 0.75);
      if (G.some((m0) => Math.hypot(m0[0] - e0, m0[1] - p0) < (m0[2] + t0) * 0.82)) continue;
      G.push([e0, p0, t0]);
      let M0 = t0 * P.range(0.62, 0.92), f0 = P() * Math.PI, _0 = P.pick(I);
      for (let [m0, S0] of [[e, "#fff"], [t, `rgb(${_0})`]]) m0.fillStyle = S0, m0.beginPath(), m0.ellipse(e0, p0, t0, M0, f0, 0, Vt), m0.fill();
      t.save(), t.beginPath(), t.ellipse(e0, p0, t0, M0, f0, 0, Vt), t.clip(), u(t, e0 - t0 * 0.3, p0 - t0 * 0.35, t0 * 1.1, "255,252,244", 0.35), u(t, e0 + t0 * 0.5, p0 + t0 * 0.55, t0 * 1.2, "20,16,12", 0.5);
      for (let m0 = 0; m0 < 6; m0++) u(t, e0 + P.range(-t0, t0), p0 + P.range(-M0, M0), 1 + P() * 2, P() < 0.5 ? "90,84,76" : "240,236,226", 0.35);
      P() < 0.25 && h(t, [[e0 - t0, p0 + P.range(-M0, M0) * 0.6], [e0 + t0, p0 + P.range(-M0, M0) * 0.6]], 1 + P() * 1.5, "rgba(250,246,236,0.4)"), t.restore(), s.save(), s.translate(e0, p0), s.rotate(f0), s.scale(1, M0 / t0);
      let F0 = s.createRadialGradient(0, 0, 0, 0, 0, t0);
      F0.addColorStop(0, a(1)), F0.addColorStop(0.55, a(0.86)), F0.addColorStop(0.85, a(0.5)), F0.addColorStop(1, a(0.14)), s.fillStyle = F0, s.beginPath(), s.arc(0, 0, t0, 0, Vt), s.fill(), s.restore(), n.fillStyle = a(P() < 0.3 ? 0.36 : 0.6), n.beginPath(), n.ellipse(e0, p0, t0, M0, f0, 0, Vt), n.fill();
    }
  }), M = (F) => l(F, () => {
    let P = Re(29), z = _n(41), k = F.x + F.w / 2, I = F.y + F.h / 2, G = ["74,104,34", "96,124,40", "58,84,28", "118,138,48", "48,70,24", "136,150,62"];
    r(t, F, "#44601f"), r(s, F, a(0.2)), r(n, F, a(0.97));
    for (let K = 0; K < 1500; K++) {
      let $ = P() * Vt, n0 = 78 + 34 * z.fbm(Math.cos($) * 1.6 + 5, Math.sin($) * 1.6 + 5, 3), e0 = Math.sqrt(P()) * n0, p0 = k + Math.cos($) * e0, t0 = I + Math.sin($) * e0, M0 = P.range(2.5, 6.5);
      e.fillStyle = "#fff", e.beginPath(), e.arc(p0, t0, M0 * 0.9, 0, Vt), e.fill(), u(t, p0, t0, M0 * 1.5, P.pick(G), 0.9), u(t, p0 - M0 * 0.3, t0 - M0 * 0.3, M0 * 0.6, "176,190,90", 0.35), u(s, p0, t0, M0 * 1.4, "255,255,255", 0.75);
    }
    for (let K = 0; K < 60; K++) {
      let $ = P() * Vt, n0 = Math.sqrt(P()) * 80;
      u(t, k + Math.cos($) * n0, I + Math.sin($) * n0, 8 + P() * 14, P() < 0.5 ? "30,48,16" : "150,150,60", 0.25);
    }
  }), w = (F, P, z, k) => l(F, () => {
    r(t, F, P), r(e, F, "#fff"), r(s, F, a(0.5)), r(n, F, a(z)), k(Re(F.x + 7), F);
  }), T = (F, P, z, k, I) => {
    F.fillStyle = I, F.fillRect(P.x + z, P.y, k, P.h);
  }, S = (F, P, z, k, I, G, K = 2) => {
    let $ = [];
    for (let n0 = 0; n0 <= P.w; n0 += 16) $.push([P.x + n0, P.y + k + z.range(-K, K)]);
    h(F, $, I, G);
  };
  w(Ks.bark, "#8b7b67", 0.9, (F, P) => {
    for (let z = 0; z < 46; z++) u(t, P.x + F() * P.w, P.y + F() * P.h, 14 + F() * 40, F.pick(["150,140,124", "96,82,66", "120,104,84", "168,160,146", "86,78,60"]), 0.3, 10 + F() * 20);
    for (let z = 0; z < 40; z++) {
      let k = F() * P.h;
      S(t, P, F, k, 0.8 + F(), `rgba(50,40,30,${0.12 + F() * 0.2})`, 3), S(s, P, F, k, 2, a(0.3, 0.5), 3);
    }
    for (let z = 12 + F() * 30; z < P.w; z += 34 + F() * 52) T(t, P, z, 2.5, "rgba(60,48,36,0.5)"), T(t, P, z + 2.5, 2, "rgba(176,164,144,0.5)"), T(s, P, z - 1, 6, a(0.72, 0.8)), T(s, P, z + 1, 2, a(0.3));
    for (let z = 0; z < 150; z++) {
      let k = P.x + F() * P.w, I = P.y + F() * P.h, G = 4 + F() * 12;
      t.fillStyle = "rgba(190,176,150,0.75)", t.fillRect(k, I, 2, G), t.fillStyle = "rgba(50,40,30,0.4)", t.fillRect(k + 2, I, 1, G), s.fillStyle = a(0.85), s.fillRect(k - 0.5, I, 3, G);
    }
  }), w(Ks.petiole, "#4f7a30", 0.46, (F, P) => {
    let z = t.createLinearGradient(P.x, 0, P.x + P.w, 0);
    z.addColorStop(0, "#5a4c2a"), z.addColorStop(0.1, "#5e6130"), z.addColorStop(0.3, "#4c7430"), z.addColorStop(1, "#6c9640"), r(t, P, z);
    for (let I = 0; I < 26; I++) {
      let G = F() * P.h;
      S(t, P, F, G, 1 + F() * 2, I % 2 ? "rgba(150,190,96,0.16)" : "rgba(14,34,10,0.2)", 1), S(s, P, F, G, 3, a(I % 2 ? 0.66 : 0.36, 0.6), 1);
    }
    for (let I = 0; I < 260; I++) {
      let G = Math.pow(F(), 2.6);
      u(t, P.x + G * P.w * 0.5, P.y + F() * P.h, 1.5 + F() * 3, "52,34,18", 0.7 * (1 - G));
    }
    let k = n.createLinearGradient(P.x, 0, P.x + P.w, 0);
    k.addColorStop(0, a(0.85)), k.addColorStop(0.25, a(0.46)), r(n, P, k);
  }), w(Ks.trunk, "#5f7438", 0.62, (F, P) => {
    for (let k = 0; k < 30; k++) u(t, P.x + F() * P.w, P.y + F() * P.h, 10 + F() * 30, F.pick(["84,106,52", "70,86,40", "110,116,60", "96,84,50"]), 0.3);
    let z = t.createLinearGradient(P.x, 0, P.x + P.w, 0);
    z.addColorStop(0, "rgba(96,74,46,0.85)"), z.addColorStop(0.35, "rgba(96,84,48,0.25)"), z.addColorStop(1, "rgba(96,84,48,0)"), r(t, P, z);
    for (let k = 10; k < P.w; k += 22 + F() * 16) {
      let I = t.createLinearGradient(P.x + k, 0, P.x + k + 16, 0);
      I.addColorStop(0, "rgba(30,40,16,0.5)"), I.addColorStop(1, "rgba(30,40,16,0)"), t.fillStyle = I, t.fillRect(P.x + k, P.y, 16, P.h), T(t, P, k - 3, 3.5, "rgba(176,158,110,0.9)"), T(t, P, k - 4, 1, "rgba(70,56,34,0.7)"), T(s, P, k - 4, 5, a(0.82)), T(s, P, k + 1, 3, a(0.3)), T(n, P, k - 3, 4, a(0.85));
    }
    for (let k = 0; k < 20; k++) {
      let I = F() * P.h;
      S(t, P, F, I, 1, "rgba(20,30,12,0.18)", 2);
    }
  }), w(Ks.branch, "#4c3b2d", 0.9, (F, P) => {
    for (let z = 0; z < 30; z++) u(t, P.x + F() * P.w, P.y + F() * P.h, 8 + F() * 26, F.pick(["88,68,50", "50,38,30", "110,90,68", "66,52,42"]), 0.4);
    for (let z = 0; z < 26; z++) {
      let k = F() * P.h;
      S(t, P, F, k, 1, z % 2 ? "rgba(140,116,90,0.25)" : "rgba(20,14,10,0.3)", 2), S(s, P, F, k, 2.5, a(z % 2 ? 0.7 : 0.3, 0.7), 2);
    }
    for (let z = 20; z < P.w; z += 40 + F() * 40) T(t, P, z, 4, "rgba(120,98,74,0.6)"), T(s, P, z, 5, a(0.8, 0.8));
    for (let z = 0; z < 70; z++) u(t, P.x + F() * P.w, P.y + F() * P.h, 1.5 + F() * 2, "170,150,120", 0.6);
  }), w(Ks.straw, "#c5ab74", 0.8, (F, P) => {
    for (let z = 0; z < 22; z++) {
      let k = F() * P.h;
      S(t, P, F, k, 1 + F() * 2, z % 2 ? "rgba(232,214,160,0.4)" : "rgba(120,96,54,0.35)", 1), S(s, P, F, k, 3, a(z % 2 ? 0.68 : 0.34, 0.7), 1);
    }
    for (let z = 30; z < P.w; z += 44) T(t, P, z, 3, "rgba(110,88,50,0.6)"), T(s, P, z, 4, a(0.78));
  }), w(Ks.dark, "#050505", 1, () => {
  }), w(Ks.twig, "#7b6a52", 0.8, (F, P) => {
    let z = t.createLinearGradient(P.x, 0, P.x + P.w, 0);
    z.addColorStop(0, "#85745f"), z.addColorStop(0.5, "#7a6c4c"), z.addColorStop(0.8, "#727a40"), z.addColorStop(1, "#7c9044"), r(t, P, z);
    for (let I = 0; I < 20; I++) u(t, P.x + F() * P.w, P.y + F() * P.h, 8 + F() * 22, F.pick(["150,138,116", "90,76,56", "110,110,64"]), 0.3);
    for (let I = 8; I < P.w; I += 16 + F() * 14) T(t, P, I, 2, "rgba(58,44,30,0.6)"), T(t, P, I + 2, 1.5, "rgba(190,176,140,0.5)"), T(s, P, I - 1, 5, a(0.78, 0.9)), T(s, P, I + 3, 2, a(0.3));
    for (let I = 0; I < 60; I++) {
      let G = P.x + F() * P.w, K = P.y + F() * P.h;
      t.fillStyle = "rgba(200,188,160,0.7)", t.fillRect(G, K, 1.5, 3 + F() * 5);
    }
    let k = n.createLinearGradient(P.x, 0, P.x + P.w, 0);
    k.addColorStop(0.5, a(0.82)), k.addColorStop(1, a(0.5)), r(n, P, k);
  }), w(Ks.spear, "#7ea446", 0.42, (F, P) => {
    let z = t.createLinearGradient(P.x, 0, P.x + P.w, 0);
    z.addColorStop(0, "#6b9440"), z.addColorStop(0.7, "#86ab4a"), z.addColorStop(1, "#a4b858"), r(t, P, z);
    for (let k = 3; k < P.h; k += 9) S(t, P, F, k, 2, "rgba(30,56,16,0.45)", 0.6), S(t, P, F, k + 4, 1.6, "rgba(190,220,120,0.3)", 0.6), S(s, P, F, k, 3.5, a(0.2), 0.6), S(s, P, F, k + 4.5, 3.5, a(0.82), 0.6);
  }), m(Ks.leaflet[0], 11, { base: "#3b6b2b", hi: "#5b8a38", lo: "#44742c", rib: "rgb(150,184,90)" }), m(Ks.leaflet[1], 12, { base: "#2f5c27", hi: "#4f7e34", lo: "#356428", rib: "rgb(132,170,84)" }), m(Ks.leaflet[2], 13, { base: "#3a6427", hi: "#5c8436", lo: "#6a7c30", rib: "rgb(150,176,84)", tip: 0.085, wash: ["#8a8a30", 0.12] }), m(Ks.leaflet[3], 14, { base: "#5d9238", hi: "#86b04a", lo: "#6aa03c", rib: "rgb(190,214,120)" }), x(Ks.sans[0], 21, { dark: "#274a2b", band: "128,156,124", margin: "#cdb957", mw: 0.2 }), x(Ks.sans[1], 22, { dark: "#2d5230", band: "146,170,136", margin: "#d6c66c", mw: 0.16 }), g(Ks.pampas[0], 41), g(Ks.pampas[1], 42), p(Ks.fig[0], 61, { base: "#2b4a1d", vein: "168,190,104", mott: "70,112,44", dark: "14,30,10", pet: "#75803e" }), p(Ks.fig[1], 62, { base: "#31531f", vein: "176,196,110", mott: "82,122,48", dark: "18,36,12", pet: "#75803e" }), p(Ks.fig[2], 63, { base: "#5c8f33", vein: "200,220,130", mott: "128,166,64", dark: "50,90,28", pet: "#93a850", rough: 0.28, soft: 0.8 }), p(Ks.fig[3], 64, { base: "#2f4c1c", vein: "170,186,100", mott: "96,116,44", dark: "16,30,10", pet: "#75803e", brown: 3 }), b(Ks.fan), v(Ks.mulch), y(Ks.pebble), M(Ks.moss);
  let E = t.getImageData(0, 0, la, gr).data, _ = e.getImageData(0, 0, la, gr).data, R = s.getImageData(0, 0, la, gr).data, C = n.getImageData(0, 0, la, gr).data, L = new Uint8Array(la * gr * 4), A = new Uint8Array(la * gr * 4), O = 2.6 / 255;
  for (let F = 0; F < gr; F++) {
    let P = F * la * 4, z = (gr - 1 - F) * la * 4, k = Math.max(0, F - 1) * la * 4, I = Math.min(gr - 1, F + 1) * la * 4;
    for (let G = 0; G < la; G++) {
      let K = G * 4, $ = Math.max(0, G - 1) * 4, n0 = Math.min(la - 1, G + 1) * 4;
      L[z + K] = E[P + K], L[z + K + 1] = E[P + K + 1], L[z + K + 2] = E[P + K + 2], L[z + K + 3] = _[P + K];
      let e0 = (R[P + n0] - R[P + $]) * O, p0 = (R[I + K] - R[k + K]) * O, t0 = 1 / Math.hypot(e0, p0, 1);
      A[z + K] = (-e0 * t0 * 0.5 + 0.5) * 255, A[z + K + 1] = (p0 * t0 * 0.5 + 0.5) * 255, A[z + K + 2] = (t0 * 0.5 + 0.5) * 255, A[z + K + 3] = C[P + K];
    }
  }
  let H = (F, P) => {
    let z = new THREE.DataTexture(F, la, gr, THREE.RGBAFormat, THREE.UnsignedByteType);
    return P && (z.colorSpace = THREE.SRGBColorSpace), z.generateMipmaps = true, z.minFilter = THREE.LinearMipmapLinearFilter, z.magFilter = THREE.LinearFilter, z.anisotropy = 8, z.needsUpdate = true, z;
  };
  return uw && typeof window !== "undefined" && (window.__plantAtlas = o2), { map: H(L, true), normalMap: H(A, false) };
}
function hw(o2, t, e, s, { segW: n = 2, bend: i = 0.5, bendPow: a = 1.6, cup: r = 0.2, cupPow: l = 1, belly: c = 0, twist: h = 0, side: f = 0, wave: u = 0, waveN: d = 3, wavePh: m = 0, edge: p = false } = {}) {
  let x = [], g = [], b = [], v = n + 1, y = 0, M = 0, w = 0;
  return s.forEach(([T, S], E) => {
    let _ = i * Math.pow(T, a);
    if (E) {
      let P = (T + w) / 2, z = i * Math.pow(P, a), k = (T - w) * t;
      y += Math.cos(z) * k, M += Math.sin(z) * k;
    }
    w = T;
    let R = S * e / 2, C = h * T, L = Math.cos(C), A = Math.sin(C), O = -Math.sin(_), H = Math.cos(_), F = f * t * T * T;
    for (let P = 0; P <= n; P++) {
      let z = P / n * 2 - 1, k = Math.abs(z), I = r * R * Math.pow(k, l) - c * R * Math.sin(Math.PI * k) + u * R * k * Math.sin(T * d * Math.PI + m + (z > 0 ? 0 : 1.9)), G = p ? I : z * R * L - I * A, K = p ? z * R : z * R * A + I * L, $ = pw(o2, T, z * S);
      x.push(G + F, y + O * K, M + H * K), g.push($[0], $[1]);
    }
    if (E) for (let P = 0; P < n; P++) {
      let z = (E - 1) * v + P, k = E * v + P;
      b.push(z, z + 1, k, z + 1, k + 1, k);
    }
  }), mw(x, g, b);
}
function mw(o2, t, e) {
  let s = new THREE.BufferGeometry();
  return s.setAttribute("position", new THREE.Float32BufferAttribute(o2, 3)), s.setAttribute("uv", new THREE.Float32BufferAttribute(t, 2)), s.setIndex(e), s.computeVertexNormals(), s;
}
function fu(o2, t, e, s = 5, { rep: n = 1, u0: i = 0, u1: a = 1 } = {}) {
  let r = t.length, l = [], c = [], h = [], f = [], u = [0];
  for (let g = 0; g < r; g++) f.push(t[Math.min(r - 1, g + 1)].clone().sub(t[Math.max(0, g - 1)]).normalize());
  for (let g = 1; g < r; g++) u.push(u[g - 1] + t[g].distanceTo(t[g - 1]));
  let d = Math.abs(f[0].y) < 0.9 ? De(0, 1, 0) : De(1, 0, 0), m = new THREE.Quaternion(), p = new THREE.Vector3(), x = d.addScaledVector(f[0], -d.dot(f[0])).normalize();
  for (let g = 0; g < r; g++) {
    g && (m.setFromUnitVectors(f[g - 1], f[g]), x = x.clone().applyQuaternion(m).normalize()), p.crossVectors(f[g], x);
    let b = u[g] / u[r - 1], v = typeof e == "function" ? e(b) : e, y = (i + (a - i) * b) * n;
    y -= Math.floor(y / 2) * 2, y > 1 && (y = 2 - y);
    for (let M = 0; M < s; M++) {
      let w = M / s * Vt, T = Math.cos(w) * v, S = Math.sin(w) * v, E = pw(o2, 0.015 + 0.97 * y, (1 - Math.abs(2 * M / s - 1)) * 1.84 - 0.92);
      l.push(t[g].x + x.x * T + p.x * S, t[g].y + x.y * T + p.y * S, t[g].z + x.z * T + p.z * S), c.push(E[0], E[1]);
    }
  }
  for (let g = 0; g < r - 1; g++) for (let b = 0; b < s; b++) {
    let v = g * s + b, y = g * s + (b + 1) % s, M = v + s, w = y + s;
    h.push(v, M, y, y, M, w);
  }
  return mw(l, c, h);
}
function Xm(o2, t, e = 8) {
  let s = [0, 0, 0], n = pw(o2, 0.5, 0), i = [n[0], n[1]], a = [];
  for (let r = 0; r < e; r++) {
    let l = (r + 0.5) / e * Vt, c = pw(o2, 0.5 + 0.5 * Math.cos(l), Math.sin(l));
    s.push(Math.sin(l) * t, 0, Math.cos(l) * t), i.push(c[0], c[1]), a.push(0, 1 + r, 1 + (r + 1) % e);
  }
  return mw(s, i, a);
}
function n$(o2, t, e = 0.012, s = 0.25) {
  let n = o2.x + o2.w / 2, i = o2.y + o2.h - o2.pad, a = Math.min(o2.h - 2 * o2.pad, o2.w / 2 - o2.pad), r = [0, 0, 0], l = [n / la, 1 - i / gr], c = [], h = dw * 2, f = [0.34, 1];
  for (let u = 0; u <= h; u++) {
    let d = -zb + 2 * zb * u / h, m = u % 2 === 1;
    for (let p of f) {
      let x = p === 1 ? m ? 1 : ED + 0.04 : p * (m ? 1 : 0.9), g = x * t;
      r.push(Math.sin(d) * g, Math.cos(d) * g, (m ? e : -e) * x + s * t * x * x), l.push((n + Math.sin(d) * x * a) / la, 1 - (i - Math.cos(d) * x * a) / gr);
    }
  }
  for (let u = 0; u < h; u++) {
    let d = 1 + u * 2, m = d + 2;
    c.push(0, m, d, d, m, d + 1, m, m + 1, d + 1);
  }
  return mw(r, l, c);
}
var H9 = (o2) => {
  let t = new THREE.Box3(), e = new THREE.Vector3();
  for (let { geo: s, m: n } of o2) {
    let i = s.attributes.position;
    for (let a = 0; a < i.count; a++) e.fromBufferAttribute(i, a), n && e.applyMatrix4(n), t.expandByPoint(e);
  }
  return t;
}, fw = (o2, t = 20) => new THREE.CircleGeometry(o2, t).rotateX(-Math.PI / 2);
function TD({ M: o2, def: t, lib: e }) {
  let s = () => e("leaf", () => {
    let r = s$(), l = new THREE.MeshStandardMaterial({ map: r.map, normalMap: r.normalMap, normalScale: new THREE.Vector2(1, 1), roughness: 1, metalness: 0, alphaTest: 0.5, side: THREE.DoubleSide });
    return l.alphaToCoverage = true, l.onBeforeCompile = (c) => {
      c.fragmentShader = c.fragmentShader.replace("#include <lights_physical_pars_fragment>", `#include <lights_physical_pars_fragment>
void RE_Direct_Leaf( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
	RE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	float back = saturate( dot( -geometryNormal, directLight.direction ) );
	vec3 dc = material.diffuseColor;
	float green = saturate( ( dc.g - max( dc.r, dc.b ) ) / max( dc.g, 0.001 ) * 4.0 );
	vec3 tint = mix( vec3( 1.0, 0.82, 0.55 ), vec3( 0.95, 1.0, 0.3 ), green );
	reflectedLight.directDiffuse += back * directLight.color * dc * tint * ( 0.62 * RECIPROCAL_PI ) * step( 0.126, vMapUv.y );
}
#undef RE_Direct
#define RE_Direct RE_Direct_Leaf`).replace("#include <map_fragment>", `#include <map_fragment>
	{
		vec2 ghT = vMapUv * vec2( ${la}.0, ${gr}.0 ), ghDx = dFdx( ghT ), ghDy = dFdy( ghT );
		diffuseColor.a *= 1.0 + max( 0.0, 0.5 * log2( max( dot( ghDx, ghDx ), dot( ghDy, ghDy ) ) ) ) * 0.3;
		if ( gl_FrontFacing && vMapUv.y > 0.126 ) diffuseColor.rgb = mix( diffuseColor.rgb, vec3( dot( diffuseColor.rgb, vec3( 0.3, 0.6, 0.1 ) ) ) * vec3( 1.05, 1.12, 0.9 ) + 0.012, 0.35 );
	}`).replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
	roughnessFactor *= texture2D( normalMap, vNormalMapUv ).a;`);
    }, l.customProgramCacheKey = () => "gh-leaf-atlas", l;
  });
  function n(r, l) {
    let c = s(), h = Re(4107), f = [], u = (v, y) => f.push({ geo: v, m: y || null }), d = [[0.06, 20, 0.3, 0.033, 5], [0.064, 150, 0.22, 0.029, 7], [0.06, 262, 0.15, 0.026, 9]].map(([v, y, M, w, T]) => {
      let S = y * K2, E = De(Math.sin(S), 0, Math.cos(S)), _ = E.clone().multiplyScalar(v).setY(l - 0.025), R = qa.clone().addScaledVector(E, Math.tan(T * K2)).normalize(), C = _.clone().addScaledVector(R, M + 0.025), L = [];
      for (let A = 0; A <= 5; A++) L.push(_.clone().lerp(C, A / 5));
      return u(fu(Ks.trunk, L, (A) => w * (0.94 + 0.36 * Math.pow(1 - A, 2.5)), 7, { u0: 0, u1: 0.4 + M })), { top: C, axis: R, r: w };
    }), m = [[0, 10, 1.9, 7, 80, 2.2, 0.5, 0.1], [0, 148, 1.98, 10, 94, 2, 0.48, 0.3], [0, 285, 1.9, 14, 106, 1.9, 0.47, 0.5], [0, 62, 1.78, 21, 118, 1.8, 0.45, 0.7], [1, 200, 1.84, 12, 98, 2, 0.48, 0.35], [1, 338, 1.76, 18, 112, 1.8, 0.46, 0.6], [1, 115, 1.6, 27, 126, 1.7, 0.44, 0.85], [2, 245, 1.7, 16, 106, 1.9, 0.47, 0.45], [2, 30, 1.56, 25, 122, 1.7, 0.45, 0.78], [2, 172, 1.4, 36, 138, 1.6, 0.42, 1]], p = ([v, y, M, w, T, S, E, _], R) => {
      let C = d[v], L = y * K2, A = De(Math.sin(L), 0, Math.cos(L)), O = De(Math.cos(L), 0, -Math.sin(L)), H = C.top.clone().addScaledVector(C.axis, -0.03 - Math.max(0, _) * 0.1).addScaledVector(A, C.r * 0.5), F = 10, P = [H.clone()], z = H.clone(), k = h.range(-0.12, 0.12);
      for (let K = 1; K <= F; K++) {
        let $ = (K - 0.5) / F, n0 = (w + (T - w) * Math.pow($, S)) * K2;
        z.addScaledVector(qa, Math.cos(n0) * M / F).addScaledVector(A, Math.sin(n0) * M / F).addScaledVector(O, k * $ * M / F), P.push(z.clone());
      }
      u(fu(Ks.petiole, P, (K) => 3e-3 + 56e-4 * (1 - K) + 0.012 * Math.pow(Math.max(0, 1 - K / 0.08), 2), 4, { u0: R ? 0.3 : 0, u1: 1 }));
      let I = (K) => {
        let $ = K * F, n0 = Math.min(F - 1, Math.floor($));
        return [P[n0].clone().lerp(P[n0 + 1], $ - n0), P[n0 + 1].clone().sub(P[n0]).normalize()];
      }, G = R ? 12 : Math.round(15 + 4 * (M - 1.4) / 0.6);
      for (let K = 0; K < G; K++) {
        let $ = (K + 0.5) / G, [n0, e0] = I(E + (1 - E) * Math.pow($, 0.9) * 0.99), p0 = new THREE.Vector3().crossVectors(e0, O).normalize(), t0 = 0.5 + 0.5 * Math.sin(Math.PI * Math.pow($, 0.7)), M0 = (R ? 0.27 : 0.41 - 0.05 * _) * (M / 1.9) * t0 * (1 - 0.32 * $ * $ * $), f0 = (R ? Ht(24, 12, $) : Ht(64, 28, Math.pow($, 1.3))) * K2, _0 = (R ? 14 : Ht(18, 6, $)) * K2;
        for (let F0 of [-1, 1]) {
          let m0 = e0.clone().multiplyScalar(Math.cos(f0)).addScaledVector(O, F0 * Math.sin(f0) * Math.cos(_0)).addScaledVector(p0, Math.sin(f0) * Math.sin(_0)).normalize(), S0 = R ? h.range(0.1, 0.3) : (0.95 + 0.4 * _) * h.range(0.82, 1.18) * Zt(1 + m0.y * 0.7, 0.3, 1.25), T0 = R ? 3 : _ > 0.75 ? h() < 0.45 ? 2 : 1 : h() < 0.06 ? 2 : h() < 0.5 ? 0 : 1, j0 = hw(Ks.leaflet[T0], M0 * h.range(0.93, 1.05), 0.048 * (0.72 + 0.28 * t0), K >= G - 5 ? Jj : Qj, { segW: 2, bend: S0, bendPow: 1.5, cup: R ? 0.7 : 0.42, twist: F0 * h.range(-0.3, 0.12) });
          u(j0, rc(n0.clone().addScaledVector(p0, 2e-3), m0, De(0, -1, 0).addScaledVector(p0, -0.35)));
        }
      }
    };
    m.forEach((v) => p(v, false)), p([1, 60, 1.5, 3, 24, 1.5, 0.56, -0.2], true);
    for (let [v, y, M, w] of [[0, 215, 1, 5], [2, 320, 0.62, 9]]) {
      let T = d[v], S = y * K2, E = De(Math.sin(S), 0, Math.cos(S)), _ = [];
      for (let R = 0; R <= 6; R++) {
        let C = R / 6;
        _.push(T.top.clone().addScaledVector(T.axis, -0.03).addScaledVector(qa, M * C).addScaledVector(E, Math.tan(w * K2) * M * C * (0.5 + 0.5 * C)));
      }
      u(fu(Ks.spear, _, (R) => 12e-4 + 75e-4 * Math.pow(1 - R, 0.7), 5));
    }
    let x = H9(f), g = [2.44 / (x.max.x - x.min.x), (2.195 - l) / (x.max.y - l), 2.54 / (x.max.z - x.min.z)];
    uw && console.log("palm fit", g.map((v) => v.toFixed(3)).join(" "), "bbox", [x.min.x, x.max.x, x.min.z, x.max.z, x.max.y].map((v) => v.toFixed(2)).join(" "));
    let b = new THREE.Matrix4().makeTranslation(0, l, 0).multiply(new THREE.Matrix4().makeScale(g[0], g[1], g[2])).multiply(new THREE.Matrix4().makeTranslation(0, -l, 0));
    for (let { geo: v, m: y } of f) r.addM(v, c, y ? b.clone().multiply(y) : b, true);
    r.add(Xm(Ks.mulch, 0.1), c, [0, l + 4e-3, 0], [0, 0.4, 0], null, true);
    for (let v = 0; v < 6; v++) {
      let y = v / 6 * Vt + 0.3;
      r.add(Xm(Ks.mulch, 0.098), c, [Math.sin(y) * 0.132, l + 1e-3 + v % 3 * 25e-4, Math.cos(y) * 0.132], [0, v * 1.9, 0], [1, 1, v % 2 ? -1 : 1], true);
    }
    for (let v = 0; v < 6; v++) {
      let y = (v + 0.5) / 6 * Vt + 0.3;
      r.add(Xm(Ks.mulch, 0.05), c, [Math.sin(y) * 0.183, l + 6e-3, Math.cos(y) * 0.183], [0, v * 2.7, 0], null, true);
    }
  }
  function i(r, l) {
    let c = s(), h = Re(2311), f = [], u = (y, M) => f.push({ geo: y, m: M || null }), d = ra([[0, l - 0.03, 0], [3e-3, l + 0.06, 2e-3], [0.02, 0.68, 0.014], [0.024, 0.92, -6e-3], [4e-3, 1.1, -0.016], [0, 1.2, -8e-3]], 15), m = (y) => 0.0165 + 65e-4 * (1 - y) + 0.02 * Math.exp(-y * 34);
    u(fu(Ks.bark, d, m, 8, { rep: 2 }));
    for (let y = 0; y < 5; y++) {
      let M = y * 1.26 + 0.5 + h.range(-0.2, 0.2), w = De(Math.sin(M), 0, Math.cos(M)), T = h.range(0.07, 0.11), S = ra([De(0, l + 0.035, 0).addScaledVector(w, 0.012), De(0, l + 0.014, 0).addScaledVector(w, T * 0.5), De(0, l - 0.012, 0).addScaledVector(w, T)], 4);
      u(fu(Ks.bark, S, (E) => Ht(0.014, 5e-3, E), 5, { u0: 0.1, u1: 0.3 }));
    }
    [[1, 40, 0.035, 0.4, 13], [0.9, 35, 0.25, 0.3, 10], [0.84, 160, 0.27, 0.25, 10], [0.95, 275, 0.23, 0.33, 10]].forEach(([y, M, w, T, S], E) => {
      let _ = M * K2, R = De(Math.sin(_), 0, Math.cos(_)), C = d[Math.round(y * 15)].clone(), L = E === 0 ? ra([C, C.clone().addScaledVector(qa, T * 0.5).addScaledVector(R, w), C.clone().addScaledVector(qa, T)], 7) : ra([C, C.clone().addScaledVector(R, w * 0.62).addScaledVector(qa, T * 0.3), C.clone().addScaledVector(R, w).addScaledVector(qa, T)], 7), A = (P) => Ht(E === 0 ? 0.0155 : 0.0125, 65e-4, P);
      u(fu(Ks.twig, L, A, 6, { u0: E === 0 ? 0.25 : 0.1, u1: 1 }));
      let O = (P) => {
        let z = P * 7, k = Math.min(6, Math.floor(z));
        return [L[k].clone().lerp(L[k + 1], z - k), L[k + 1].clone().sub(L[k]).normalize()];
      };
      for (let P = 0; P < S; P++) {
        let z = P / (S - 1), k = 0.16 + 0.84 * Math.pow(z, 0.85), [I, G] = O(k), K = P >= S - 1, $ = E > 0 && P < 2, n0 = new THREE.Vector3().crossVectors(G, Math.abs(G.y) < 0.95 ? qa : De(1, 0, 0)).normalize(), e0 = new THREE.Vector3().crossVectors(G, n0), p0 = P * 2.39996 + E * 1.7, t0 = n0.multiplyScalar(Math.cos(p0)).addScaledVector(e0, Math.sin(p0)), M0 = (K ? 10 : $ ? h.range(108, 128) : Ht(92, 34, Math.pow(z, 0.8)) + h.range(-8, 8)) * K2, f0 = G.clone().multiplyScalar(Math.cos(M0)).addScaledVector(t0, Math.sin(M0));
        f0.y -= 0.22 * (1 - z) * (K ? 0 : 1), f0.normalize();
        let _0 = K ? h.range(0.16, 0.2) : Ht(0.37, 0.27, z) * h.range(0.88, 1.1), F0 = K || P === S - 2 && h() < 0.7 ? 2 : h() < 0.34 - 0.3 * z ? 3 : h() < 0.5 ? 0 : 1, m0 = hw(Ks.fig[F0], _0, _0 * (320 / 448), Zj, { segW: 4, bend: K ? 0.1 : h.range(0.25, 0.5) + 0.35 * (1 - z), bendPow: 1.5, cup: K ? -0.7 : -h.range(0.16, 0.3), belly: 0.07, twist: h.range(-0.22, 0.22), wave: K ? 0.04 : h.range(0.08, 0.15), waveN: 4.5, wavePh: h() * 6 });
        u(m0, rc(I.clone().addScaledVector(t0, A(k) * 0.8), f0, G.clone().multiplyScalar(-1).addScaledVector(qa, -0.15)));
      }
      let [H, F] = O(1);
      u(fu(Ks.branch, [H.clone(), H.clone().addScaledVector(F, 0.022), H.clone().addScaledVector(F, 0.05)], (P) => 62e-4 * (1 - P) + 6e-4, 4, { u0: 0.2, u1: 0.5 }));
    });
    let x = f.slice(6), g = H9(x), b = Math.min(0.86 / (g.max.x - g.min.x), 0.86 / (g.max.z - g.min.z), 1.15);
    uw && console.log("fig fit", b.toFixed(3), ((1.845 - l) / (g.max.y - l)).toFixed(3), "bbox", [g.min.x, g.max.x, g.min.z, g.max.z, g.max.y].map((y) => y.toFixed(2)).join(" "));
    let v = new THREE.Matrix4().makeTranslation(0, l, 0).multiply(new THREE.Matrix4().makeScale(b, (1.845 - l) / (g.max.y - l), b)).multiply(new THREE.Matrix4().makeTranslation(0, -l, 0));
    for (let { geo: y, m: M } of f) r.addM(y, c, M ? v.clone().multiply(M) : v, true);
    for (let [y, M, w, T] of [[0.09, 0.05, 0.085, 0.3], [-0.08, 0.08, 0.075, 2.1], [-0.07, -0.09, 0.09, 4], [0.1, -0.08, 0.07, 5.2], [0, 0.13, 0.055, 1.2], [-0.135, -0.01, 0.05, 3.3]]) r.add(Xm(Ks.moss, w), c, [y, l + 4e-3 + w * 0.03, M], [0, T, 0], null, true);
  }
  function a(r, l) {
    let c = s(), h = Re(913), f = [];
    [[-0.288, 6e-3, 9], [0.022, -0.016, 8], [0.292, 0.01, 9]].forEach(([m, p, x], g) => {
      for (let b = 0; b < x; b++) {
        let v = b / (x - 1), y = b * 2.39996 + g * 1.9, M = De(Math.sin(y), 0, Math.cos(y) * 0.7).normalize(), w = Ht(0.095, 0.014, Math.pow(v, 0.8)) * h.range(0.85, 1.15), T = b === x - 1, S = De(m + M.x * w, l - 0.012, p + M.z * w * 0.62), E = Ht(0.26, 0.03, v) * h.range(0.6, 1.2) * (Math.abs(M.z) > 0.6 ? 0.55 : 1), _ = T ? h.range(0.3, 0.42) : Ht(0.5, 0.96, Math.pow(v, 0.6)) * h.range(0.86, 1.04), R = (T ? 0.05 : Ht(0.088, 0.07, v) * h.range(0.92, 1.08)) / 0.9, C = hw(Ks.sans[(b + g) % 2], _, R, t$, { segW: 4, bend: h.range(0.04, 0.22), bendPow: 1.4, cup: T ? -1.1 : -h.range(0.35, 0.6), cupPow: 2, twist: h.sign() * h.range(0.35, 1.25), side: h.range(-0.035, 0.035) });
        f.push({ geo: C, m: rc(S, qa.clone().addScaledVector(M, Math.tan(E)), M) });
      }
    });
    let u = H9(f);
    uw && console.log("snake fit", ((1.395 - l) / (u.max.y - l)).toFixed(3), "bbox", [u.min.x, u.max.x, u.min.z, u.max.z, u.max.y].map((m) => m.toFixed(2)).join(" "));
    let d = new THREE.Matrix4().makeTranslation(0, l, 0).multiply(new THREE.Matrix4().makeScale(1, (1.395 - l) / (u.max.y - l), 1)).multiply(new THREE.Matrix4().makeTranslation(0, -l, 0));
    for (let { geo: m, m: p } of f) r.addM(m, c, d.clone().multiply(p), true);
  }
  t("planter", (r) => (r.variant | 0) % 3, (r, l) => {
    let c = (l.variant | 0) % 3;
    if (c === 0) return r.add(pe(ke([[0.16, 0], [0.172, 4e-3], [0.172, 0.02], [0.18, 0.03], [0.212, 0.19], [0.238, 0.35], [0.258, 0.49], [0.27, 0.503], [0.2725, 0.518], [0.266, 0.531], [0.25, 0.535], [0.24, 0.528], [0.235, 0.47]], 28), 40), o2.ceramicBlack), r.add(pe(ke([[0.2, 0], [0.216, 7e-3], [0.222, 0.026], [0.214, 0.0275], [0.206, 0.011], [0.17, 0.011]], 28), 40), o2.ceramicBlack), r.add(fw(0.237), o2.soil, [0, 0.482, 0]), n(r, 0.485), rs("planter", [2.5, 2.2, 2.6], { surf: "ceramic", mass: 45, colliders: [$s(-0.26, 0, -0.26, 0.26, 0.56, 0.26)] });
    if (c === 1) return r.add(pe(ke([[0.162, 0], [0.168, 4e-3], [0.168, 0.014], [0.19, 0.022], [0.208, 0.04], [0.215, 0.07], [0.215, 0.392], [0.214, 0.404], [0.208, 0.412], [0.199, 0.409], [0.195, 0.398], [0.195, 0.36]], 28), 40), o2.ceramicWhite), r.add(pe(ke([[0.205, 0], [0.229, 6e-3], [0.236, 0.026], [0.2335, 0.031], [0.228, 0.031], [0.2225, 0.014], [0.19, 0.012]], 28), 40), o2.ceramicWhite), r.add(fw(0.196), o2.soil, [0, 0.373, 0]), i(r, 0.375), rs("planter", [0.9, 1.85, 0.9], { surf: "ceramic", mass: 30, colliders: [$s(-0.22, 0, -0.22, 0.22, 0.45, 0.22)] });
    r.add(_i([[2e-3, 0], [0, 2e-3], [0, 0.027], [3e-3, 0.03]], di(0.86, 0.26, 8e-3, 0, 3), { profClosed: false }), o2.brass), r.add(_i([[0.02, 0.03], [4e-3, 0.03], [0, 0.034], [0, 0.445], [4e-3, 0.45], [0.013, 0.45], [0.016, 0.447], [0.016, 0.43]], di(0.9, 0.3, 0.022, 0, 4), { profClosed: false }), o2.ceramicBlack), r.add(_i([[8e-4, 0.396], [-12e-4, 0.3975], [-12e-4, 0.4045], [8e-4, 0.406]], di(0.9, 0.3, 0.022, 0, 4), { profClosed: false }), o2.brass), r.add(new THREE.PlaneGeometry(0.87, 0.27).rotateX(-Math.PI / 2), o2.soil, [0, 0.444, 0]);
    let h = s(), f = Re(5);
    for (let u = 0; u < 9; u++) r.add(Xm(Ks.pebble, 0.125), h, [(u - 4) * 0.076 + f.range(-0.01, 0.01), 0.4465 + u % 3 * 22e-4, f.range(-6e-3, 6e-3)], [0, f() * Vt, 0], [1, 1, u % 2 ? -1 : 1], true);
    for (let u of [-1, 1]) for (let d of [-1, 1]) r.add(Xm(Ks.pebble, 0.062), h, [u * 0.366, 0.4475, d * 0.068], [0, f() * Vt, 0], null, true);
    return a(r, 0.447), rs("planter", [0.9, 1.4, 0.36], { surf: "ceramic", mass: 40, colliders: [$s(-0.45, 0, -0.15, 0.45, 0.5, 0.15)] });
  }), t("vase", (r) => (r.variant | 0) % 3, (r, l) => {
    let c = (l.variant | 0) % 3, h = { surf: "ceramic", dynamic: true, mass: 3, breakable: "ceramic" };
    if (c === 0) return r.add(pe(ke([[0, 0], [0.069, 0], [0.072, 3e-3], [0.072, 0.011], [0.066, 0.017], [0.058, 0.024], [0.064, 0.05], [0.086, 0.095], [0.112, 0.15], [0.13, 0.205], [0.135, 0.25], [0.129, 0.3], [0.11, 0.35], [0.082, 0.395], [0.058, 0.43], [0.0465, 0.455], [0.0445, 0.472], [0.05, 0.488], [0.059, 0.498], [0.0575, 0.5], [0.0525, 0.4985], [0.046, 0.488], [0.04, 0.47], [0.041, 0.452], [0.045, 0.44]], 24), 40), o2.ceramicWhite), r.add(fw(0.047, 12), o2.rubber, [0, 0.44, 0]), rs("vase", [0.27, 0.5, 0.27], h);
    if (c === 1) return r.add(pe(ke([[0, 0], [0.06, 0], [0.064, 4e-3], [0.062, 0.012], [0.086, 0.036], [0.118, 0.074], [0.14, 0.115], [0.15, 0.16], [0.146, 0.205], [0.128, 0.245], [0.1, 0.273], [0.074, 0.289], [0.069, 0.296], [0.069, 0.311], [0.0735, 0.317], [0.071, 0.32], [0.063, 0.317], [0.059, 0.302], [0.063, 0.28]], 24), 40), o2.ceramicBlack), r.add(pe(ke([[0.0685, 0.292], [0.0765, 0.2935], [0.078, 0.297], [0.0755, 0.3025], [0.078, 0.308], [0.0745, 0.3125], [0.0685, 0.3125]], 24), 36), o2.brass), r.add(fw(0.066, 12), o2.rubber, [0, 0.28, 0]), rs("vase", [0.3, 0.32, 0.3], h);
    r.add(pe(ke([[0, 0], [0.074, 0], [0.08, 4e-3], [0.08, 0.014], [0.076, 0.02], [0.086, 0.06], [0.094, 0.13], [0.096, 0.2], [0.091, 0.28], [0.079, 0.36], [0.064, 0.44], [0.05, 0.51], [0.041, 0.57], [0.0375, 0.62], [0.0385, 0.66], [0.0445, 0.685], [0.051, 0.697], [0.0495, 0.7], [0.044, 0.699], [0.038, 0.688], [0.032, 0.66], [0.032, 0.62]], 20), 40), o2.terracotta);
    let f = s(), u = Re(5);
    r.add(Xm(Ks.dark, 0.034, 10), f, [0, 0.62, 0], null, null, true);
    let d = (m, p, x, g, b, v, y = 3, M = 8) => {
      let w = ra([De(p, 0.6, x), ...g.map((T) => De(T[0], T[1], T[2]))], M);
      return r.addM(fu(m, w, (T) => Ht(b, v, T), y, { rep: 2 }), f, null, true), w;
    };
    for (let [m, p, x, g, b, v, y] of [[-4e-3, -8e-3, -0.03, -0.035, 0.86, 0.44, 0], [0.012, 4e-3, 0.1, 0.02, 0.8, 0.4, 1], [-0.012, 8e-3, -0.12, 0.04, 0.74, 0.36, 0]]) {
      let M = d(Ks.straw, m, p, [[m + x * 0.25, 0.72, p + g * 0.25], [x * 0.75, b, g * 0.75], [x * 0.82, b + 0.03, g * 0.82]], 34e-4, 24e-4, 4, 5), w = M[M.length - 2], T = M[M.length - 1].clone().sub(M[M.length - 3]).normalize(), S = De(x, -0.05, g).normalize();
      for (let E = 0; E < 2; E++) r.addM(hw(Ks.pampas[(y + E) % 2], v, 0.125, e$, { segW: 2, bend: 0.55 + y * 0.12, bendPow: 1.7, cup: E ? 0.12 : 0.22, edge: E === 1 }), f, rc(w, T, S), true);
    }
    for (let [m, p, x, g, b, v, y] of [[0.016, -4e-3, 0.13, 0.84, 0.07, 0.115, 0.5], [-0.016, -2e-3, -0.125, 0.78, -0.06, 0.1, -0.7]]) {
      let M = d(Ks.straw, m, p, [[m + x * 0.2, 0.7, p + b * 0.2], [x * 0.8, g - 0.06, b * 0.8], [x, g, b]], 3e-3, 2e-3, 3, 5), w = M[M.length - 1].clone().sub(M[M.length - 2]).normalize().lerp(qa, 0.35).normalize();
      r.addM(n$(Ks.fan, v, 8e-3, 0.22), f, rc(M[M.length - 1], w, De(Math.sin(y), -0.2, Math.cos(y))), true);
    }
    for (let [m, p, x] of [[6e-3, 0.012, [[0.03, 0.76, 0.03], [0.1, 0.9, 0.01], [0.13, 1.03, -0.05], [0.19, 1.14, -0.03]]], [-8e-3, -0.012, [[-0.03, 0.78, -0.03], [-0.06, 0.94, -0.07], [-0.14, 1.02, -0.04], [-0.19, 1.07, -0.09]]], [2e-3, -0.014, [[0.02, 0.8, -0.04], [0, 0.98, -0.09], [0.05, 1.12, -0.08], [0.04, 1.27, -0.11]]], [-0.01, 0.01, [[-0.04, 0.74, 0.04], [-0.05, 0.86, 0.09], [-0.1, 0.95, 0.1], [-0.09, 1.04, 0.13]]]]) {
      let g = d(Ks.branch, m, p, x, 42e-4, 12e-4, 3, 9);
      for (let [b, v] of [[4, 1], [6, -1]]) {
        let y = g[b], M = g[b + 1].clone().sub(g[b - 1]).normalize(), w = new THREE.Vector3().crossVectors(M, De(0.3, 0.2, 1)).normalize().multiplyScalar(v), T = u.range(0.1, 0.17), S = ra([y, y.clone().addScaledVector(M, T * 0.4).addScaledVector(w, T * 0.35), y.clone().addScaledVector(M, T * 0.75).addScaledVector(w, T * 0.5).addScaledVector(qa, T * 0.25)], 4);
        r.addM(fu(Ks.branch, S, (E) => Ht(22e-4, 8e-4, E), 3, { u0: 0.3, u1: 0.8 }), f, null, true);
      }
    }
    return rs("vase", [0.45, 1.3, 0.3], { ...h, mass: 4 });
  });
}
var Tn = Math.PI, go = Tn / 2, So = Math.sin, pi = Math.cos, Fd = (o2) => o2 * Tn / 180, Nd = 2048, Bd = 1024, uu = { dial: [0, 0, 448, 448], ind: [0, 448, 448, 240], btnUp: [0, 688, 96, 96], btnDn: [96, 688, 96, 96], plq: [192, 688, 256, 96], name: [0, 784, 448, 56], rbadge: [0, 840, 224, 48], crest: [224, 840, 224, 96], cbadge: [0, 888, 160, 56], lock: [0, 944, 128, 80], burl: [448, 0, 512, 832], cloth: [960, 0, 256, 256], back: [960, 256, 384, 512], zip: [1216, 0, 256, 32], stitch: [1216, 40, 256, 16], satin: [1216, 80, 48, 48], feltRed: [1264, 80, 48, 48], steel: [1312, 80, 48, 48], copper: [1360, 80, 48, 48], feltWhite: [1408, 80, 48, 48], darkWood: [1456, 80, 48, 48], slot: [1504, 80, 48, 48], grey: [1552, 80, 48, 48], tri: [1232, 160, 32, 32], bi: [1312, 160, 32, 32], wound: [1392, 160, 32, 32], tag: [1344, 256, 160, 256], st1: [1504, 256, 224, 224], st2: [1728, 256, 304, 192], st3: [1504, 480, 240, 272] }, Ud = (o2, t = 0) => {
  let [e, s, n, i] = uu[o2];
  return hu(e + t, s + t, n - 2 * t, i - 2 * t, Nd, Bd);
};
function o$() {
  let o2 = we(Nd, Bd), t = o2.getContext("2d"), e = we(Nd / 2, Bd / 2), s = e.getContext("2d");
  s.scale(0.5, 0.5);
  let n = we(Nd / 2, Bd / 2), i = n.getContext("2d");
  i.scale(0.5, 0.5);
  let a = (y, M) => `rgb(0,${y * 255 | 0},${M * 255 | 0})`, r = (y) => `rgb(${y},${y},${y})`;
  t.fillStyle = "#777", t.fillRect(0, 0, Nd, Bd), s.fillStyle = a(0.6, 0), s.fillRect(0, 0, Nd, Bd), i.fillStyle = r(128), i.fillRect(0, 0, Nd, Bd);
  let l = Re(4711), c = 'Bahnschrift, "Segoe UI", Arial, sans-serif', h = '"Palatino Linotype", "Book Antiqua", Georgia, serif', f = (y, M = 600, w = c, T = "") => `${T} ${M} ${y}px ${w}`, u = (y, M, w, T) => {
    let [S, E, _, R] = uu[y];
    return t.fillStyle = M, t.fillRect(S, E, _, R), s.fillStyle = a(w, T), s.fillRect(S, E, _, R), [S, E, _, R];
  }, d = (y, M, w, T, S) => {
    t.fillStyle = t.strokeStyle = y, T(t), s.fillStyle = s.strokeStyle = a(M, w), T(s), S !== void 0 && (i.fillStyle = i.strokeStyle = r(S), T(i));
  }, m = (y, M, w, T, S = 0) => (E) => {
    E.font = T, E.textAlign = "center", E.textBaseline = "middle", "letterSpacing" in E && (E.letterSpacing = S + "px"), E.fillText(y, M + S / 2, w), "letterSpacing" in E && (E.letterSpacing = "0px");
  }, p = (y, M, w, T, S, E, _) => {
    y.save(), y.translate(w + pi(E) * S, T + So(E) * S), y.rotate(E + go), y.font = _, y.textAlign = "center", y.textBaseline = "middle", y.fillText(M, 0, 0), y.restore();
  }, x = (y, M, w, T, S, E, _, R = 1.5) => {
    for (let C = 0; C < S; C++) t.fillStyle = E, t.globalAlpha = _ * l(), t.fillRect(y + l() * w, M + l() * T, 0.5 + l() * R, 0.5 + l() * R);
    t.globalAlpha = 1;
  };
  {
    let [y, M, w] = u("dial", "#22130a", 0.3, 0), T = y + w / 2, S = M + w / 2, E = w / 2 - 6, _ = t.createRadialGradient(T, S + 40, 10, T, S, E);
    _.addColorStop(0, "#ffe6b0"), _.addColorStop(0.55, "#ffc878"), _.addColorStop(1, "#e58a34"), t.fillStyle = _, t.beginPath(), t.arc(T, S, E, 0, Vt), t.fill();
    let R = "#2a1405", C = "#8a1a08", L = Tn * 0.78, A = Tn * 2.22, O = (F) => L + (A - L) * F;
    t.strokeStyle = R, t.fillStyle = R, t.lineCap = "butt";
    for (let [F, P] of [[E - 8, 3], [E - 62, 1.5], [E - 118, 1.5], [70, 2]]) t.lineWidth = P, t.beginPath(), t.arc(T, S, F, 0, Vt), t.stroke();
    for (let F = 0; F <= 110; F++) {
      let P = O(F / 110), z = E - (F % 10 === 0 ? 40 : F % 5 === 0 ? 31 : 24);
      t.lineWidth = F % 10 === 0 ? 3 : 1.6, t.beginPath(), t.moveTo(T + pi(P) * (E - 12), S + So(P) * (E - 12)), t.lineTo(T + pi(P) * z, S + So(P) * z), t.stroke();
    }
    ["55", "60", "70", "80", "100", "120", "140", "160"].forEach((F, P) => p(t, F, T, S, E - 51, O(0.02 + P * 0.137), f(21, 700))), t.strokeStyle = C, t.fillStyle = C;
    for (let F = 0; F <= 60; F++) {
      let P = O(F / 60);
      t.lineWidth = F % 5 === 0 ? 2.4 : 1.2, t.beginPath(), t.moveTo(T + pi(P) * (E - 66), S + So(P) * (E - 66)), t.lineTo(T + pi(P) * (E - (F % 5 === 0 ? 82 : 74)), S + So(P) * (E - (F % 5 === 0 ? 82 : 74))), t.stroke();
    }
    ["6", "7", "9", "11", "13", "15", "18"].forEach((F, P) => p(t, F, T, S, E - 98, O(0.04 + P * 0.153), f(17, 700))), t.fillStyle = R, ["PARIS", "ROMA", "WIEN", "LISBOA", "CAIRO", "OSLO", "RIO"].forEach((F, P) => p(t, F, T, S, E - 134, O(0.05 + P * 0.15), f(12, 700))), p(t, "KC", T, S, E - 51, Tn * 0.5 + 0.34, f(13, 700)), t.fillStyle = C, p(t, "MC", T, S, E - 98, Tn * 0.5 + 0.42, f(12, 700)), t.fillStyle = R, m("Vespera", T, S + 112, f(30, 600, h, "italic"))(t), m("SUPERHETERODYNE", T, S + 140, f(10, 700), 2)(t);
    let H = t.createRadialGradient(T, S, E * 0.55, T, S, E);
    H.addColorStop(0, "rgba(60,20,0,0)"), H.addColorStop(1, "rgba(60,20,0,0.42)"), t.fillStyle = H, t.beginPath(), t.arc(T, S, E, 0, Vt), t.fill();
  }
  {
    let [y, M, w, T] = u("ind", "#070605", 0.28, 0), S = y + w / 2, E = M + T - 18, _ = "#ffb055";
    t.strokeStyle = _, t.lineWidth = 2.5;
    for (let C of [204, 138]) t.beginPath(), t.arc(S, E, C, Tn, Vt), t.stroke();
    t.lineWidth = 2, t.beginPath(), t.moveTo(S - 204, E), t.lineTo(S + 204, E), t.stroke(), ["L", "8", "16", "24", "32", "40", "47"].forEach((C, L) => {
      let A = Tn + Tn * (L + 0.5) / 7;
      t.fillStyle = L === 6 ? "#fff0c8" : _, L === 6 && (t.save(), t.shadowColor = "#ffb055", t.shadowBlur = 14, p(t, C, S, E, 171, A, f(40, 700, h)), t.restore()), p(t, C, S, E, 171, A, f(L === 6 ? 40 : 34, 700, h));
    });
    for (let C = 0; C <= 7; C++) {
      let L = Tn + Tn * C / 7;
      t.lineWidth = 3, t.beginPath(), t.moveTo(S + pi(L) * 204, E + So(L) * 204), t.lineTo(S + pi(L) * 190, E + So(L) * 190), t.stroke(), t.beginPath(), t.moveTo(S + pi(L) * 138, E + So(L) * 138), t.lineTo(S + pi(L) * 150, E + So(L) * 150), t.stroke();
    }
    for (let C = 0; C < 28; C++) {
      let L = Tn + Tn * (C + 0.5) / 28;
      t.lineWidth = 1.5, t.beginPath(), t.moveTo(S + pi(L) * 138, E + So(L) * 138), t.lineTo(S + pi(L) * 131, E + So(L) * 131), t.stroke();
    }
    t.fillStyle = _, m("FLOOR", S, E - 78, f(15, 700), 6)(t);
  }
  for (let [y, M] of [["btnUp", 1], ["btnDn", 0]]) {
    let [w, T, S] = u(y, "#0b0908", 0.25, 0), E = w + S / 2, _ = T + S / 2, R = M ? 1 : -1, C = M ? "#ffc070" : "#5a3a1c";
    t.strokeStyle = C, t.lineWidth = 5, t.beginPath(), t.arc(E, _, 36, 0, Vt), t.stroke(), t.fillStyle = M ? "#ffe2a8" : "#6a4826", t.beginPath(), t.moveTo(E, _ - 20 * R), t.lineTo(E + 19, _ + 13 * R), t.lineTo(E - 19, _ + 13 * R), t.closePath(), t.fill();
  }
  let g = (y) => {
    let [M, w, T, S] = u(y, "#cba660", 0.3, 1), E = t.createLinearGradient(M, w, M, w + S);
    E.addColorStop(0, "rgba(255,240,200,0.14)"), E.addColorStop(1, "rgba(60,35,0,0.14)"), t.fillStyle = E, t.fillRect(M, w, T, S);
    for (let _ = 0; _ < T * 1.2; _++) t.fillStyle = l() < 0.5 ? "rgba(255,245,215,0.05)" : "rgba(70,45,10,0.05)", t.fillRect(M, w + l() * S, T, 1);
    return [M, w, T, S];
  };
  {
    let [y, M, w, T] = g("plq");
    d("#231608", 0.7, 0, (S) => {
      S.lineWidth = 2, S.strokeRect(y + 7, M + 7, w - 14, T - 14), m("47", y + 62, M + T / 2 + 2, f(56, 700, h))(S), m("SKY LOBBY", y + 168, M + 36, f(19, 700), 3)(S), m("HALCYON OUTPOST", y + 168, M + 62, f(11, 600), 2.5)(S), S.fillRect(y + 112, M + 49, 112, 1.5);
    }, 70);
  }
  {
    let [y, M, w, T] = g("rbadge");
    d("#231608", 0.7, 0, (S) => {
      S.lineWidth = 1.5, S.strokeRect(y + 5, M + 5, w - 10, T - 10), m("VESPERA", y + w / 2, M + T / 2 + 1, f(22, 700, h), 7)(S);
    }, 70);
  }
  {
    let [y, M, w, T] = g("crest"), S = y + w / 2;
    d("#231608", 0.7, 0, (E) => {
      E.lineWidth = 1.5, E.strokeRect(y + 5, M + 5, w - 10, T - 10), E.beginPath(), E.arc(S, M + 44, 13, Tn, Vt), E.fill();
      for (let _ = 0; _ < 9; _++) {
        let R = Tn + Tn * (_ + 0.5) / 9;
        E.lineWidth = 2, E.beginPath(), E.moveTo(S + pi(R) * 17, M + 44 + So(R) * 17), E.lineTo(S + pi(R) * (_ % 2 ? 26 : 31), M + 44 + So(R) * (_ % 2 ? 26 : 31)), E.stroke();
      }
      E.fillRect(S - 44, M + 47, 88, 2), m("HALCYON", S, M + 64, f(19, 700, h), 5)(E), m("OUTPOST  \xB7  FIELD SERVICE", S, M + 82, f(8, 700), 1.5)(E);
    }, 70);
  }
  {
    let [y, M, w, T] = u("name", "rgb(14,14,16)", 0.18, 0);
    d("#d8b266", 0.28, 1, (S) => {
      m("Morgenthal", y + 150, M + T / 2 + 1, f(40, 600, h, "italic"))(S), m("& S\xD6HNE", y + 338, M + T / 2 + 4, f(22, 600, h), 5)(S), S.fillRect(y + 262, M + T / 2 + 3, 16, 1.5);
    });
  }
  {
    let [y, M, w, T] = u("cbadge", "#c2c6ca", 0.3, 1);
    for (let S = 0; S < 90; S++) t.fillStyle = l() < 0.5 ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.07)", t.fillRect(y, M + l() * T, w, 1);
    d("#16171a", 0.6, 0, (S) => {
      S.lineWidth = 2, S.strokeRect(y + 5, M + 5, w - 10, T - 10), m("NORDAL", y + w / 2, M + T / 2 + 1, f(24, 700), 5)(S);
    }, 80);
  }
  {
    let [y, M, w, T] = u("lock", "#141416", 0.5, 0);
    ["0", "4", "7"].forEach((S, E) => {
      let _ = y + 14 + E * 26;
      d("#3a3b40", 0.4, 0.6, (R) => R.fillRect(_, M + 16, 22, 48)), t.fillStyle = "rgba(0,0,0,0.45)", t.fillRect(_, M + 16, 22, 9), t.fillRect(_, M + 55, 22, 9), t.fillStyle = "#e8e6e0", m(S, _ + 11, M + 41, f(20, 700))(t);
    }), d("#b9bcc2", 0.3, 1, (S) => {
      S.beginPath(), S.arc(y + 108, M + 40, 11, 0, Vt), S.fill();
    }), t.fillStyle = "#101012", t.fillRect(y + 106, M + 33, 4, 14);
  }
  {
    let [y, M, w, T] = u("burl", "#6b3d18", 0.2, 0), S = w / 2, E = T / 2, _ = _n(77), R = we(S, E), C = R.getContext("2d"), L = C.createImageData(S, E), A = L.data;
    for (let O = 0; O < E; O++) for (let H = 0; H < S; H++) {
      let F = H < S / 2 ? H : S - 1 - H, P = F * 0.021, z = O * 0.0125, k = _.fbm(P * 1.3 + 3, z * 1.3 + 7, 4), I = _.fbm(P * 1.1 + 31, z * 1.6 + 2, 4), G = So((P * 1.6 + k * 10 + I * 5) * 3.3) * 0.5 + 0.5, K = _.fbm(P * 16, z * 3 + k * 5, 3), $ = Math.pow(_.fbm(P * 5.5 + 50, z * 5.5 + 50, 3), 3.2), n0 = Zt(0.5 * G + 0.34 * K + 0.22 * I - $ * 1.5 + 0.06, 0, 1), e0 = (O * S + H) * 4;
      A[e0] = Ht(52, 176, n0), A[e0 + 1] = Ht(25, 104, n0), A[e0 + 2] = Ht(9, 44, n0), A[e0 + 3] = 255;
    }
    C.putImageData(L, 0, 0), t.imageSmoothingQuality = "high", t.drawImage(R, y, M, w, T);
    for (let O = 0; O < 2600; O++) {
      let H = y + l() * w, F = M + l() * T;
      t.fillStyle = `rgba(30,12,2,${0.1 + l() * 0.18})`, t.fillRect(H, F, 1, 3 + l() * 9);
    }
    t.fillStyle = "rgba(20,8,0,0.55)", t.fillRect(y + w / 2 - 0.75, M, 1.5, T);
  }
  {
    let [y, M, w, T] = u("cloth", "#7a5d30", 0.86, 0), S = t.createImageData(w, T), E = S.data, _ = i.createImageData(w / 2, T / 2);
    for (let R = 0; R < T; R++) for (let C = 0; C < w; C++) {
      let L = C >> 2, A = R >> 2, O = L + A & 1, H = So(O ? (R & 3) / 3 * Tn : (C & 3) / 3 * Tn), F = Math.abs(C % 64 - 32) + Math.abs(R % 64 - 32), P = F > 21 && F < 27 || F < 7 ? 0.7 : 1, k = L % 8 === 3 && !O ? [205, 170, 96] : O ? [150, 116, 60] : [104, 78, 40], I = (0.62 + 0.38 * H) * P * (0.92 + 0.16 * l()), G = (R * w + C) * 4;
      if (E[G] = k[0] * I, E[G + 1] = k[1] * I, E[G + 2] = k[2] * I, E[G + 3] = 255, !(C & 1) && !(R & 1)) {
        let K = ((R >> 1) * (w / 2) + (C >> 1)) * 4, $ = 70 + 150 * H;
        _.data[K] = _.data[K + 1] = _.data[K + 2] = $, _.data[K + 3] = 255;
      }
    }
    t.putImageData(S, y, M), i.putImageData(_, y / 2, M / 2);
  }
  {
    let [y, M, w, T] = u("back", "#5c452c", 0.92, 0);
    x(y, M, w, T, 9e3, "#2a1c0e", 0.5, 2.2), x(y, M, w, T, 5e3, "#9a7a52", 0.4, 2);
    for (let S = 0; S < 7; S++) for (let E = 0; E < 12; E++) {
      let _ = y + 60 + E * 24 + S % 2 * 12, R = M + 60 + S * 22;
      t.fillStyle = "#080604", t.beginPath(), t.arc(_, R, 6.5, 0, Vt), t.fill(), t.strokeStyle = "rgba(160,130,90,0.35)", t.lineWidth = 1, t.beginPath(), t.arc(_, R + 0.8, 6.5, 0.2, Tn - 0.2), t.stroke();
    }
    t.fillStyle = "#e4d6b2", t.fillRect(y + 82, M + 300, 220, 104), t.strokeStyle = "#3a2a16", t.lineWidth = 2, t.strokeRect(y + 88, M + 306, 208, 92), t.fillStyle = "#3a2412", m("Vespera", y + 192, M + 326, f(22, 600, h, "italic"))(t), m("RADIO CORPORATION", y + 192, M + 346, f(9, 700), 2)(t), m("MODEL 37-C   \xB7   110-125 V ~ 50/60 C/S   \xB7   85 W", y + 192, M + 364, f(8, 700))(t), m("SERIAL No.  204417", y + 192, M + 380, f(10, 700), 1)(t), x(y + 82, M + 300, 220, 104, 500, "#8a6a3c", 0.35, 2);
    for (let [S, E] of [[18, 18], [w - 18, 18], [18, T - 18], [w - 18, T - 18], [w / 2, 18], [w / 2, T - 18]]) d("#9a9488", 0.45, 1, (_) => {
      _.beginPath(), _.arc(y + S, M + E, 7, 0, Vt), _.fill();
    }, 190), t.fillStyle = "#2a2622", t.fillRect(y + S - 6, M + E - 1, 12, 2);
  }
  {
    let [y, M, w, T] = u("zip", "#161618", 0.86, 0);
    for (let S = 0; S < w; S += 2) t.fillStyle = `rgba(255,255,255,${0.03 + 0.03 * l()})`, t.fillRect(y + S, M, 1, T);
    i.fillStyle = r(110), i.fillRect(y, M, w, T);
    for (let S = 0; S < w / 8; S++) {
      let E = y + S * 8 + 1.5, _ = S & 1;
      d("#a4a7ae", 0.36, 1, (R) => {
        R.fillRect(E, M + (_ ? 9 : 13), 5, 10);
      }, 230), t.fillStyle = "rgba(255,255,255,0.35)", t.fillRect(E, M + (_ ? 9 : 13), 5, 2), t.fillStyle = "rgba(0,0,0,0.4)", t.fillRect(E + 4, M + (_ ? 9 : 13), 1, 10);
    }
  }
  {
    let [y, M, w, T] = uu.stitch;
    t.clearRect(y - 4, M - 6, w + 8, T + 12), s.fillStyle = a(0.8, 0), s.fillRect(y - 4, M - 6, w + 8, T + 12);
    for (let S = 0; S < w / 16; S++) {
      let E = y + S * 16 + 8;
      d("#e2cf9c", 0.8, 0, (_) => {
        _.save(), _.translate(E, M + T / 2), _.rotate(-0.16), _.beginPath(), _.roundRect(-5.5, -2.6, 11, 5.2, 2.4), _.fill(), _.restore();
      }, 215);
    }
  }
  for (let [y, M, w, T] of [["satin", "rgb(15,15,17)", 0.36, 0], ["feltRed", "#8e1418", 1, 0], ["steel", "#b9bec4", 0.32, 1], ["copper", "#b87248", 0.38, 1], ["feltWhite", "#d9d3c2", 1, 0], ["darkWood", "#33200f", 0.55, 0], ["slot", "#050505", 0.9, 0], ["grey", "#5a5c60", 0.7, 0]]) u(y, M, w, T);
  let b = (y, M, w, T, S, E) => {
    let _ = t.createLinearGradient(y, 0, y + w, 0);
    _.addColorStop(0, S), _.addColorStop(0.45, E), _.addColorStop(1, S), t.fillStyle = _, t.fillRect(y, M, w, T);
  };
  {
    let [y, M] = uu.tri;
    t.clearRect(y - 16, M - 16, 64, 64), s.fillStyle = a(0.3, 1), s.fillRect(y - 16, M - 16, 64, 64);
    for (let w of [5, 16, 27]) b(y + w - 3, M - 16, 6, 64, "#70757c", "#eef1f4");
  }
  {
    let [y, M] = uu.bi;
    t.clearRect(y - 16, M - 16, 64, 64), s.fillStyle = a(0.4, 1), s.fillRect(y - 16, M - 16, 64, 64);
    for (let w of [7, 25]) b(y + w - 6, M - 16, 12, 64, "#5e2f18", "#e09a68");
  }
  {
    let [y, M] = uu.wound;
    s.fillStyle = a(0.4, 1), s.fillRect(y - 16, M - 16, 64, 64), b(y, M - 16, 32, 64, "#58290f", "#e3a070"), t.fillStyle = "#58290f", t.fillRect(y - 16, M - 16, 16, 64), t.fillRect(y + 32, M - 16, 16, 64);
    for (let w = -16; w < 48; w += 3) t.fillStyle = "rgba(40,14,0,0.35)", t.fillRect(y, M + w, 32, 1);
  }
  {
    let [y, M, w, T] = uu.tag;
    t.clearRect(y, M, w, T), s.fillStyle = a(0.9, 0), s.fillRect(y, M, w, T);
    let S = (E) => {
      E.beginPath(), E.moveTo(y + 44, M + 6), E.lineTo(y + w - 44, M + 6), E.lineTo(y + w - 8, M + 50), E.lineTo(y + w - 8, M + T - 16), E.quadraticCurveTo(y + w - 8, M + T - 6, y + w - 18, M + T - 6), E.lineTo(y + 18, M + T - 6), E.quadraticCurveTo(y + 8, M + T - 6, y + 8, M + T - 16), E.lineTo(y + 8, M + 50), E.closePath();
    };
    t.fillStyle = "#e6d9b8", S(t), t.fill(), t.save(), S(t), t.clip(), x(y, M, w, T, 1400, "#a08a5c", 0.3, 2.4), t.fillStyle = "#9c2a1a", t.fillRect(y + 8, M + 62, w - 16, 30), t.fillStyle = "#f2e6c8", m("HALCYON", y + w / 2, M + 78, f(19, 700, h), 4)(t), t.fillStyle = "#4a3a22", m("CREW GEAR", y + w / 2, M + 106, f(10, 700), 2)(t), t.strokeStyle = "#7a6a48", t.lineWidth = 1;
    for (let E of [140, 172, 204]) t.beginPath(), t.moveTo(y + 20, M + E), t.lineTo(y + w - 20, M + E), t.stroke();
    t.fillStyle = "#6a5a3a", t.font = f(7, 700), t.textAlign = "left", t.fillText("NAME", y + 20, M + 148), t.fillText("ROOM", y + 20, M + 180), t.fillText("ONWARD TO", y + 20, M + 212), t.strokeStyle = "#1c2a55", t.lineWidth = 1.8, t.lineJoin = "round";
    for (let [E, _] of [[134, 9], [166, 4], [198, 7]]) {
      t.beginPath();
      let R = y + 30;
      t.moveTo(R, M + E);
      for (let C = 0; C < _ * 3; C++) R += 3.6 + l() * 2.5, t.lineTo(R, M + E - 8 * l() + (C % 3 === 1 ? 5 : 0));
      t.stroke();
    }
    t.restore(), d("#c9a45e", 0.3, 1, (E) => {
      E.beginPath(), E.arc(y + w / 2, M + 30, 11, 0, Vt), E.arc(y + w / 2, M + 30, 6, 0, Vt, true), E.fill("evenodd");
    }), t.save(), t.globalCompositeOperation = "destination-out", t.beginPath(), t.arc(y + w / 2, M + 30, 6, 0, Vt), t.fill(), t.restore();
  }
  let v = (y, M, w, T, S) => {
    for (let E = 0; E < S; E++) {
      t.strokeStyle = `rgba(${150 + l() * 60 | 0},${110 + l() * 40 | 0},${70 + l() * 30 | 0},${0.25 + l() * 0.4})`, t.lineWidth = 0.6 + l() * 1.6;
      let _ = y + l() * w, R = M + l() * T, C = l() * Vt, L = 3 + l() * 16;
      t.beginPath(), t.moveTo(_, R), t.lineTo(_ + pi(C) * L, R + So(C) * L), t.stroke();
    }
  };
  {
    let [y, M, w, T] = uu.st1, S = y + w / 2, E = M + T / 2;
    t.clearRect(y, M, w, T), s.fillStyle = a(0.7, 0), s.fillRect(y, M, w, T), t.save(), t.beginPath(), t.arc(S, E, 108, 0, Vt), t.clip(), t.fillStyle = "#0f5560", t.fillRect(y, M, w, T), t.fillStyle = "#efe2bd", t.beginPath(), t.arc(S, E, 74, 0, Vt), t.fill();
    let _ = t.createLinearGradient(0, E - 70, 0, E + 30);
    _.addColorStop(0, "#f4b03a"), _.addColorStop(1, "#d6482a"), t.fillStyle = _, t.beginPath(), t.arc(S, E, 68, 0, Vt), t.fill(), t.fillStyle = "#f9df9a", t.beginPath(), t.arc(S, E + 12, 26, Tn, Vt), t.fill(), t.strokeStyle = "#f9df9a", t.lineWidth = 3;
    for (let L = 0; L < 9; L++) {
      let A = Tn + Tn * (L + 0.5) / 9;
      t.beginPath(), t.moveTo(S + pi(A) * 32, E + 12 + So(A) * 32), t.lineTo(S + pi(A) * 62, E + 12 + So(A) * 62), t.stroke();
    }
    t.fillStyle = "#0f3a4a", t.fillRect(S - 70, E + 12, 140, 60), t.strokeStyle = "#5fb8b4", t.lineWidth = 2;
    for (let L = 0; L < 4; L++) t.beginPath(), t.moveTo(S - 60 + L * 9, E + 24 + L * 11), t.lineTo(S + 60 - L * 9, E + 24 + L * 11), t.stroke();
    t.fillStyle = "#f3e7c4";
    let R = "HALCYON STATION", C = "SECTOR 04";
    for (let L = 0; L < R.length; L++) p(t, R[L], S, E, 90, Tn * 1.5 + (L - (R.length - 1) / 2) * 0.132, f(17, 700));
    for (let L = 0; L < C.length; L++) {
      let A = Tn * 0.5 - (L - (C.length - 1) / 2) * 0.17;
      t.save(), t.translate(S + pi(A) * 91, E + So(A) * 91), t.rotate(A - go), t.font = f(17, 700), t.textAlign = "center", t.textBaseline = "middle", t.fillText(C[L], 0, 0), t.restore();
    }
    v(y, M, w, T, 150), t.restore();
  }
  {
    let [y, M, w, T] = u("st2", "#eadcb6", 0.7, 0), S = t.createLinearGradient(0, M + 10, 0, M + T - 10);
    S.addColorStop(0, "#f0a030"), S.addColorStop(0.62, "#d2452a"), S.addColorStop(0.63, "#14345a"), S.addColorStop(1, "#0c2140"), t.fillStyle = S, t.fillRect(y + 10, M + 10, w - 20, T - 20), t.fillStyle = "#10161f", t.beginPath(), t.moveTo(y + 54, M + 106), t.lineTo(y + 262, M + 106), t.lineTo(y + 240, M + 132), t.lineTo(y + 76, M + 132), t.closePath(), t.fill(), t.fillRect(y + 96, M + 92, 130, 14);
    for (let E of [116, 152, 188]) t.fillStyle = "#b3261a", t.fillRect(y + E, M + 64, 18, 28), t.fillStyle = "#10161f", t.fillRect(y + E, M + 64, 18, 7);
    t.fillStyle = "#f6e9c6", m("TRANSATLANTIQUE", y + w / 2, M + 36, f(21, 700), 3)(t), m("S.S. AURORE   \xB7   LE HAVRE \u2014 NEW YORK", y + w / 2, M + 160, f(11, 700), 1)(t), v(y, M, w, T, 170);
  }
  {
    let [y, M, w, T] = uu.st3, S = y + w / 2;
    t.clearRect(y, M, w, T), s.fillStyle = a(0.7, 0), s.fillRect(y, M, w, T);
    let E = () => {
      t.beginPath(), t.moveTo(y + 14, M + 10), t.lineTo(y + w - 14, M + 10), t.lineTo(y + w - 14, M + 150), t.quadraticCurveTo(y + w - 14, M + 226, S, M + T - 8), t.quadraticCurveTo(y + 14, M + 226, y + 14, M + 150), t.closePath();
    };
    t.save(), E(), t.clip(), t.fillStyle = "#14233f", t.fillRect(y, M, w, T), t.fillStyle = "#e9a23a", t.beginPath(), t.arc(S, M + 150, 42, Tn, Vt), t.fill(), t.strokeStyle = "#e9a23a", t.lineWidth = 4;
    for (let _ = 0; _ < 11; _++) {
      let R = Tn + Tn * (_ + 0.5) / 11;
      t.beginPath(), t.moveTo(S + pi(R) * 50, M + 150 + So(R) * 50), t.lineTo(S + pi(R) * (_ % 2 ? 76 : 92), M + 150 + So(R) * (_ % 2 ? 76 : 92)), t.stroke();
    }
    t.fillStyle = "#c7772c", t.fillRect(y, M + 150, w, 6), t.fillStyle = "#f1dfb4", m("HALCYON", S, M + 182, f(30, 700, h), 4)(t), m("FRONTIER HABITAT", S, M + 208, f(11, 700), 2.5)(t), m("47", S, M + 236, f(20, 700, h))(t), t.strokeStyle = "#d9b566", t.lineWidth = 5, E(), t.stroke(), v(y, M, w, T, 150), t.restore();
  }
  return { map: ll(o2), orm: ll(e, { srgb: false }), nrm: ll(Hd(n, 2.4, false), { srgb: false }) };
}
function Od() {
  let o2 = [], t = [], e = { tri(s, n, i, a, r, l) {
    return o2.push(s[0], s[1], s[2], n[0], n[1], n[2], i[0], i[1], i[2]), a ? t.push(a[0], a[1], r[0], r[1], l[0], l[1]) : t.push(0, 0, 0, 0, 0, 0), e;
  }, quad(s, n, i, a, r) {
    return r ? (e.tri(s, n, i, [r[0], r[1]], [r[2], r[1]], [r[2], r[3]]), e.tri(s, i, a, [r[0], r[1]], [r[2], r[3]], [r[0], r[3]])) : (e.tri(s, n, i), e.tri(s, i, a)), e;
  }, obox(s, n, i, a, r = "xXyYzZ", l) {
    let c = (h, f, u) => [s[0] + h * n[0] + f * i[0] + u * a[0], s[1] + h * n[1] + f * i[1] + u * a[1], s[2] + h * n[2] + f * i[2] + u * a[2]];
    return r.includes("Y") && e.quad(c(-1, 1, 1), c(1, 1, 1), c(1, 1, -1), c(-1, 1, -1), l), r.includes("y") && e.quad(c(-1, -1, -1), c(1, -1, -1), c(1, -1, 1), c(-1, -1, 1), l), r.includes("X") && e.quad(c(1, -1, 1), c(1, -1, -1), c(1, 1, -1), c(1, 1, 1), l), r.includes("x") && e.quad(c(-1, -1, -1), c(-1, -1, 1), c(-1, 1, 1), c(-1, 1, -1), l), r.includes("Z") && e.quad(c(-1, -1, 1), c(1, -1, 1), c(1, 1, 1), c(-1, 1, 1), l), r.includes("z") && e.quad(c(1, -1, -1), c(-1, -1, -1), c(-1, 1, -1), c(1, 1, -1), l), e;
  }, geo(s) {
    let n = new THREE.BufferGeometry();
    return n.setAttribute("position", new THREE.Float32BufferAttribute(o2, 3)), n.setAttribute("uv", new THREE.Float32BufferAttribute(t, 2)), n.computeVertexNormals(), s ? pe(n, s) : n;
  } };
  return e;
}
function N9(o2, { caps: t = true, deg: e = 45 } = {}) {
  let s = o2[0].length, n = [], i = [];
  for (let l of o2) for (let c of l) n.push(c[0], c[1], c[2]);
  for (let l = 0; l < o2.length - 1; l++) for (let c = 0; c < s; c++) {
    let h = l * s + c, f = l * s + (c + 1) % s, u = (l + 1) * s + (c + 1) % s, d = (l + 1) * s + c;
    i.push(h, f, u, h, u, d);
  }
  let a = (o2.length - 1) * s;
  for (let l = 1; l < s - 1; l++) i.push(0, l + 1, l), i.push(a, a + l, a + l + 1);
  let r = new THREE.BufferGeometry();
  if (r.setAttribute("position", new THREE.Float32BufferAttribute(n, 3)), r.setIndex(i), r = r.toNonIndexed(), Eb(r) < 0 && q2(r), !t) {
    let l = r.attributes.position.array.slice(0, o2.length > 1 ? (o2.length - 1) * s * 18 : 0);
    r = new THREE.BufferGeometry(), r.setAttribute("position", new THREE.BufferAttribute(l, 3));
  }
  return r.computeVertexNormals(), pe(r, e);
}
var i$ = (o2, t, e = 4e-3, s = 0, n = 0, i = o2) => {
  let a = Math.max(o2 - e, o2 * 0.3), r = Math.max(i - e, i * 0.3);
  return [[o2, -r], [o2, r], [a, i], [-a, i], [-o2, r], [-o2, -r], [-a, -i], [a, -i]].map(([l, c]) => [l + s, t, c + n]);
}, Lb = (o2, t = 4e-3, e = 40) => N9(o2.map(([s, n, i, a]) => i$(s, n, t, i || 0, a || 0)), { deg: e });
function gw(o2, t) {
  let e = o2.index ? o2.toNonIndexed() : o2, s = Ud(t), n = (s[0] + s[2]) / 2, i = (s[1] + s[3]) / 2, a = e.attributes.position.count, r = new Float32Array(a * 2);
  for (let l = 0; l < a; l++) r[l * 2] = n, r[l * 2 + 1] = i;
  return e.setAttribute("uv", new THREE.BufferAttribute(r, 2)), e;
}
var O9 = (o2) => {
  let t = Ud(o2), e = (t[0] + t[2]) / 2, s = (t[1] + t[3]) / 2;
  return [e, s, e, s];
};
function SD(o2, t) {
  let e = o2.index ? o2.toNonIndexed() : o2, s = e.attributes.position, n = new Float32Array(s.count * 2);
  for (let i = 0; i < s.count; i++) {
    let a = t(s.getX(i), s.getY(i), s.getZ(i));
    n[i * 2] = a[0] / Nd, n[i * 2 + 1] = 1 - a[1] / Bd;
  }
  return e.setAttribute("uv", new THREE.BufferAttribute(n, 2)), e;
}
function fc(o2, t, e, s = 1, n = 1, i = 1) {
  let a = Ud(e, s), r = new THREE.PlaneGeometry(o2, t, n, i), l = r.attributes.uv;
  for (let c = 0; c < l.count; c++) l.setXY(c, a[0] + (a[2] - a[0]) * l.getX(c), a[1] + (a[3] - a[1]) * l.getY(c));
  return r;
}
var xw = (o2, t, e, s, n) => Fr(o2, t, e, s, n).rotateY(-go).translate(t / 2, 0, 0), Ym = (o2) => new THREE.Shape(o2.map((t) => oo(t[0], t[1]))), bw = (o2, t) => o2.map((e, s) => {
  let n = o2[Math.max(0, s - 1)], i = o2[Math.min(o2.length - 1, s + 1)], a = i[0] - n[0], r = i[1] - n[1], l = Math.hypot(a, r) || 1;
  return [e[0] + r / l * t, e[1] - a / l * t];
}), a$ = (o2, t, e = 50) => {
  let s = o2.attributes.position, n = new THREE.Vector3();
  for (let i = 0; i < s.count; i++) n.fromBufferAttribute(s, i), t(n), s.setXYZ(i, n.x, n.y, n.z);
  return pe(o2, e);
};
function _D({ M: o2, def: t, lib: e, fine: s }) {
  let n = () => e("lobbyAtlas", () => {
    let f = o$();
    return new THREE.MeshStandardMaterial({ map: f.map, roughnessMap: f.orm, metalnessMap: f.orm, normalMap: f.nrm, normalScale: new THREE.Vector2(0.8, 0.8), roughness: 1, metalness: 1, alphaTest: 0.5 });
  }), i = () => e("lobbyGlow", () => {
    let f = n();
    return new THREE.MeshStandardMaterial({ map: f.map, color: 7368816, emissiveMap: f.map, emissive: 16777215, emissiveIntensity: 3.2, roughness: 0.3, metalness: 0 });
  });
  t("piano", null, (f) => {
    let u = o2.ceramicBlack, d = o2.brass, m = n(), p = o2.woodLight, x = s("leatherBlack"), g = 0.588, b = 0.912, v = 0.752, y = 0.06, M = ra([[-v, -1.02], [-v, -1.3], [-v, -1.47], [-0.725, -1.585], [-0.62, -1.64], [-0.4, -1.652], [-0.12, -1.632], [0.08, -1.56], [0.215, -1.42], [0.285, -1.24], [0.335, -1.04], [0.405, -0.84], [0.52, -0.65], [0.645, -0.46], [0.725, -0.27], [v, -0.07], [v, 0.1]].map(([k, I]) => De(k, 0, I)), 64).map((k) => [Zt(k.x, -v, v), k.z]), w = [];
    for (let k of [90, 60, 30, 0]) w.push([0.557 + 0.022 * So(Fd(k)), 0.778 + 0.022 * pi(Fd(k))]);
    w.push([0.52, 0.8]);
    for (let k of [90, 72, 54, 36, 18, 0]) w.push([0.47 - 0.072 * pi(Fd(k)), b - 0.112 * So(Fd(k))]);
    w.push([0.396, b], [0.3, b]);
    let T = [{ x: -v, z: 0.583, top: 0.775, d: 4e-3 }];
    for (let [k, I] of w) T.push({ x: -v, z: k, top: I, d: 0 });
    for (let k of [0, -0.5]) T.push({ x: -v, z: k, top: b, d: 0 });
    for (let [k, I] of M) T.push({ x: k, z: I, top: b, d: 0 });
    for (let [k, I] of [...w].reverse()) T.push({ x: v, z: k, top: I, d: 0 });
    T.push({ x: v, z: 0.583, top: 0.775, d: 4e-3 });
    let S = (k, I) => [[-y + I, g + 4e-3 + I], [-y + I, k - 5e-3 - I], [-y + 5e-3 + I, k - I], [-5e-3 - I, k - I], [-I, k - 5e-3 - I], [-I, g + 4e-3 + I], [-4e-3 - I, g + I], [-y + 4e-3 + I, g + I]];
    f.add(N9(T.map((k, I) => {
      let G = T[Math.max(0, I - 1)], K = T[Math.min(T.length - 1, I + 1)], $ = K.x - G.x, n0 = K.z - G.z, e0 = Math.hypot($, n0), p0 = n0 / e0, t0 = -$ / e0;
      return S(k.top, k.d).map(([M0, f0]) => [k.x + p0 * M0, f0, k.z + t0 * M0]);
    }), { deg: 50 }), u);
    let E = [[-v, 0.372], [-v, 0], [-v, -0.5], ...M, [v, 0.372]], _ = new THREE.ShapeGeometry(Ym(bw(E, -(y - 6e-3)).map(([k, I]) => [k, -I]))).rotateX(-go);
    f.add(_, p, [0, 0.832, 0], null, null, "z");
    {
      let k = q2(_.clone().toNonIndexed());
      k.computeVertexNormals(), f.add(k, p, [0, 0.616, 0], null, null, "z");
    }
    let R = ra([[0.628, 0.096], [0.585, 0.082], [0.5, 0.03], [0.4, -0.07], [0.3, -0.2], [0.2, -0.36], [0.1, -0.53], [0, -0.7], [-0.12, -0.87], [-0.25, -1.02], [-0.38, -1.14], [-0.5, -1.22]].map(([k, I]) => De(k, 0, I)), 44), C = ra([[-0.3, -1.33], [-0.15, -1.325], [0, -1.29], [0.07, -1.245]].map(([k, I]) => De(k, 0, I)), 10), L = ra([[0.655, 0.06], [0.6, -0.015], [0.5, -0.09], [0.4, -0.19], [0.3, -0.32], [0.2, -0.47], [0.1, -0.64], [0, -0.8], [-0.12, -0.965], [-0.25, -1.11], [-0.38, -1.225], [-0.5, -1.3], [-0.64, -1.345]].map(([k, I]) => De(k, 0, I)), 26).map((k) => [k.x, k.z]);
    {
      let k = Ym(bw(E, -(y + 6e-3)).map(([G, K]) => [G, -K])), I = (G) => k.holes.push(new THREE.Path(G.map(([K, $]) => oo(K, -$))));
      I([[-0.64, 0.145], [0.655, 0.145], ...L]), I([[-5e-3, -0.93], [0.085, -1.2], [0.105, -1.3], [0.07, -1.37], [0, -1.42], [-0.25, -1.45], [-0.47, -1.44], [-0.56, -1.4], [-0.5, -1.35], [-0.38, -1.275], [-0.25, -1.16], [-0.12, -1.015]]);
      for (let [G, K, $] of [[0.53, -0.2, 0.042], [0.45, -0.4, 0.055], [0.33, -0.62, 0.06], [0.21, -0.86, 0.06], [0.185, -1.07, 0.038]]) I(Array.from({ length: 14 }, (n0, e0) => [G + pi(e0 / 14 * Vt) * $, K + So(e0 / 14 * Vt) * $]));
      f.add(fi(k, 0.014, 3e-3, 4, 1), d, [0, 0.848, 0]);
    }
    let A = (k, I, G, K, $ = 0.04) => f.add(Te(Math.hypot(G - k, K - I), $, 0.034, 0.012), d, [(k + G) / 2, 0.858 + $ / 2, (I + K) / 2], [0, Math.atan2(-(K - I), G - k), 0]);
    A(-0.338, 0.15, 0.118, -1.215, 0.046), A(0.095, 0.15, 0.092, -0.67), A(0.385, 0.15, 0.39, -0.2), f.add(Te(1.3, 0.03, 0.02, 8e-3), d, [75e-4, 0.874, 0.152]);
    {
      let k = bw(E, -(y + 0.03));
      for (let I = 5; I < k.length - 2; I += 6) f.add(dr(8e-3, 8, 4, 0, Vt, 0, go), d, [k[I][0], 0.861, k[I][1]]);
    }
    f.add(gw(_i([[-0.014, 0], [-0.014, 0.047], [-0.011, 0.0495], [0.011, 0.0495], [0.014, 0.047], [0.014, 0]], R.map((k) => De(k.x, 0.832, k.z)), { closed: false }), "darkWood"), m, null, null, null, true), f.add(gw(_i([[-0.016, 0], [-0.016, 0.056], [-0.013, 0.0585], [0.013, 0.0585], [0.016, 0.056], [0.016, 0]], C.map((k) => De(k.x, 0.832, k.z)), { closed: false }), "darkWood"), m, null, null, null, true);
    {
      let k = Od(), I = Od(), G = Od(), K = Od(), $ = Ud("tri"), n0 = Ud("bi"), e0 = Ud("wound"), p0 = O9("steel"), t0 = O9("feltRed"), M0 = (T0, j0, Z0, lt) => {
        let H0 = j0[0] - T0[0], Y0 = j0[2] - T0[2], et = Math.hypot(H0, Y0), ct = -Y0 / et * Z0 / 2, D0 = H0 / et * Z0 / 2;
        k.quad([T0[0] - ct, T0[1], T0[2] - D0], [T0[0] + ct, T0[1], T0[2] + D0], [j0[0] + ct, j0[1], j0[2] + D0], [j0[0] - ct, j0[1], j0[2] - D0], lt);
      }, f0 = (T0, j0) => K.obox([T0, 0.875, j0], [24e-4, 0, 24e-4], [0, 0.013, 0], [-24e-4, 0, 24e-4], "xXYzZ", p0), _0 = (T0, j0, Z0, lt, H0, Y0) => {
        G.obox([T0, j0 + 0.014, Z0], [-H0 * 46e-4, 0, lt * 46e-4], [0, 8e-3, 0], [lt * Y0 / 2, 0, H0 * Y0 / 2], "xXYzZ"), I.obox([T0, j0 + 3e-3, Z0], [-H0 * 4e-3, 0, lt * 4e-3], [0, 3e-3, 0], [lt * (Y0 / 2 - 2e-3), 0, H0 * (Y0 / 2 - 2e-3)], "xXzZ", t0);
      }, F0 = (T0, j0, Z0) => {
        for (let lt = 0; lt < R.length - 1; lt++) {
          let H0 = R[lt], Y0 = R[lt + 1], et = H0.x - (T0 + Z0 * (j0 - H0.z)), ct = Y0.x - (T0 + Z0 * (j0 - Y0.z));
          if (et * ct <= 0) {
            let D0 = et / (et - ct || 1);
            return [Ht(H0.x, Y0.x, D0), Ht(H0.z, Y0.z, D0)];
          }
        }
        return [T0, j0 - 0.06];
      }, m0 = 0.152;
      for (let T0 = 0; T0 < 68; T0++) {
        let j0 = T0 < 30 ? Ht(-0.3, 0.065, T0 / 29) : T0 < 50 ? Ht(0.125, 0.352, (T0 - 30) / 19) : Ht(0.418, 0.612, (T0 - 50) / 17), Z0 = Ht(-0.14, 0, Math.pow(T0 / 67, 0.7)), [lt, H0] = F0(j0, m0, Z0), Y0 = Math.hypot(Z0, 1), et = -Z0 / Y0 * -1, ct = -1 / Y0, D0 = 0.205 + T0 % 3 * 0.028;
        if (M0([j0, 0.8835, m0], [lt + et * 0.105, 0.8835, H0 + ct * 0.105], 66e-4, $), M0([j0, 0.878, D0], [j0, 0.8835, m0 + 8e-3], 66e-4, $), f0(j0 - 2e-3, D0), f0(j0 + 2e-3, D0 + 0.092), T0 < 48) {
          let u0 = Ht(0.115, 0.04, T0 / 47);
          _0(j0 + et * u0, 0.8835, m0 + ct * u0, et, ct, Ht(0.04, 0.02, T0 / 47));
        }
      }
      for (let T0 = 0; T0 < 20; T0++) {
        let j0 = -0.615 + T0 * 0.24 / 19, Z0 = C[Math.round(T0 / 19 * (C.length - 1))], lt = Z0.x - j0, H0 = Z0.z - m0, Y0 = Math.hypot(lt, H0), et = lt / Y0, ct = H0 / Y0, D0 = 0.21 + T0 % 2 * 0.03, u0 = T0 < 8;
        M0([j0, 0.8925, m0], [Z0.x + et * 0.13, 0.8925, Z0.z + ct * 0.13], u0 ? Ht(5e-3, 36e-4, T0 / 7) : 86e-4, u0 ? e0 : n0), M0([j0, 0.879, D0], [j0, 0.8925, m0 + 8e-3], u0 ? 4e-3 : 86e-4, u0 ? e0 : n0), f0(j0 - (u0 ? 0 : 25e-4), D0), u0 || f0(j0 + 25e-4, D0 + 0.085), _0(j0 + et * 0.15, 0.8925, m0 + ct * 0.15, et, ct, 0.046);
      }
      f.add(k.geo(), m, null, null, null, true), f.add(K.geo(), m, null, null, null, true), f.add(I.geo(), m, null, null, null, true), f.add(G.geo(55), u);
      let S0 = Od();
      S0.obox([75e-4, 0.8635, 0.176], [0.64, 0, 0], [0, 2e-3, 0], [0, 0, -8e-3], "xXYzZ", t0);
      for (let T0 = 0; T0 < L.length - 2; T0++) {
        let j0 = L[T0], Z0 = L[T0 + 1];
        S0.quad([j0[0], 0.8632, j0[1] - 0.012], [j0[0], 0.8632, j0[1] - 0.034], [Z0[0], 0.8632, Z0[1] - 0.034], [Z0[0], 0.8632, Z0[1] - 0.012], t0);
      }
      f.add(S0.geo(), m, null, null, null, true);
    }
    f.add(zs(1.39, 0.082, 0.026), u, [0, 0.629, 0.273]);
    for (let [k, I, G, K] of [[-0.45, 0.26, -0.5, -1.56], [-0.05, 0.26, 0.02, -1.5], [0.36, 0.26, 0.3, -1.05], [0.6, 0.26, 0.6, -0.42]]) f.add(zs(Math.hypot(G - k, K - I), 0.07, 0.06), u, [(k + G) / 2, 0.627, (I + K) / 2], [0, Math.atan2(-(K - I), G - k), 0]);
    for (let k = 0; k < 9; k++) {
      let I = 0.1 - k * 0.185, G = k < 2 ? 0.66 : k < 4 ? 0.58 : k < 6 ? 0.46 : 0.36;
      f.add(zs(G * 2, 0.02, 0.022), p, [Ht(0, -0.26, k / 8) + 0.02, 0.606, I], [0, 0.5, 0], null, "x");
    }
    let O = new THREE.Matrix4().makeTranslation(-0.75, 0.93, 0).multiply(new THREE.Matrix4().makeRotationZ(0.6)).multiply(new THREE.Matrix4().makeTranslation(0.75, 0, 0)), H = bw([[-v, 0.13], [-v, 0], [-v, -0.5], ...M.slice(0, -1), [v, 0.13]], 4e-3);
    f.at(O, () => {
      f.add(fi(Ym(H.map(([k, I]) => [k, -I])), 0.03, 7e-3, 4, 2), u, [0, -6e-3, 0]), f.add(fi(ui(1.496, 0.196, 8e-3), 0.03, 7e-3, 4, 2), u, [0, 0.0255, 0.03]), f.rod(d, [-0.735, 0.0248, 0.1345], [0.735, 0.0248, 0.1345], 42e-4, 8);
      for (let k of [-0.9, -0.2]) f.add(zs(3e-3, 0.024, 0.085), d, [-0.7575, 8e-3, k]);
      f.add(pe(ke([[0, 0], [0.016, 0], [0.019, -4e-3], [0.019, -9e-3], [0.012, -0.012], [9e-3, -5e-3], [0, -5e-3]], 14)), d, [0.56, -6e-3, -0.3]);
    });
    for (let k of [-0.9, -0.2]) f.add(pe(ke([[0, -0.05], [35e-4, -0.048], [58e-4, -0.044], [58e-4, 0.044], [35e-4, 0.048], [0, 0.05]], 10)), d, [-0.7585, 0.927, k], [go, 0, 0]), f.add(zs(3e-3, 0.034, 0.085), d, [-0.7535, 0.905, k]);
    {
      let k = De(0.56, -0.011, -0.3).applyMatrix4(O), I = [0.612, 0.9, -0.3], G = k.clone().sub(De(...I)).normalize(), K = k.clone().addScaledVector(G, -0.03);
      f.rod(u, I, [K.x, K.y, K.z], 0.0105, 10, 85e-4), f.rod(d, [K.x, K.y, K.z], [k.x, k.y, k.z], 9e-3, 10, 65e-4), f.add(Te(0.05, 0.024, 0.034, 5e-3), d, [0.636, 0.886, -0.3]), f.add(ks(75e-4, 75e-4, 0.042, 8), d, [0.612, 0.9, -0.3], [go, 0, 0]);
    }
    f.add(xw(Ym([[0.28, 0.6], [0.586, 0.6], [0.586, 0.668], [0.28, 0.668]]), 1.39, 6e-3, 4, 2), u), f.add(xw(Ym([[0.561, 0.668], [0.581, 0.668], [0.581, 0.701], [0.561, 0.701]]), 1.386, 4e-3, 4, 2), u);
    for (let k of [-1, 1]) f.add(Te(0.08, 0.07, 0.165, 6e-3), u, [k * 0.6525, 0.701, 0.4805]);
    f.add(xw(Ym([[0.3965, 0.7155], [0.3875, 0.842], [0.3855, 0.8475], [0.381, 0.85], [0.3695, 0.85], [0.374, 0.7155]]), 1.386, 25e-4, 4, 1), u), f.add(fc(0.25, 0.0313, "name", 2), m, [0, 0.796, 0.3912], [-0.071, 0, 0], null, true), f.add(zs(1.384, 0.06, 0.03), u, [0, 0.882, 0.375]), f.add(zs(1.226, 0.04, 0.164), u, [0, 0.6895, 0.4715]), f.add(gw(zs(1.226, 4e-3, 6e-3), "feltRed"), m, [0, 0.7135, 0.3995], null, null, true);
    {
      let k = Od(), I = Od(), G = 1.224 / 52, K = Re(88), $ = 0.557, n0 = 0.398, e0 = O9("satin");
      for (let p0 = 0; p0 < 52; p0++) {
        let t0 = -0.612 + G * p0 + 55e-5, M0 = t0 + G - 11e-4, f0 = 0.712 + (K() - 0.5) * 5e-4, _0 = [[n0, f0], [$ - 22e-4, f0], [$ - 7e-4, f0 - 6e-4], [$, f0 - 2e-3], [$, f0 - 42e-4], [$ - 16e-4, f0 - 42e-4], [$ - 16e-4, 0.69]];
        for (let m0 = 0; m0 < _0.length - 1; m0++) k.quad([t0, _0[m0][1], _0[m0][0]], [t0, _0[m0 + 1][1], _0[m0 + 1][0]], [M0, _0[m0 + 1][1], _0[m0 + 1][0]], [M0, _0[m0][1], _0[m0][0]]);
        k.quad([t0, f0, n0], [t0, f0 - 28e-4, n0], [t0, f0 - 28e-4, $ - 1e-3], [t0, f0, $ - 1e-3]), k.quad([M0, f0, $ - 1e-3], [M0, f0 - 28e-4, $ - 1e-3], [M0, f0 - 28e-4, n0], [M0, f0, n0]), k.quad([t0, f0 - 4e-3, $ - 16e-4], [t0, 0.69, $ - 16e-4], [t0, 0.69, $ - 36e-4], [t0, f0 - 4e-3, $ - 36e-4]), k.quad([M0, f0 - 4e-3, $ - 36e-4], [M0, 0.69, $ - 36e-4], [M0, 0.69, $ - 16e-4], [M0, f0 - 4e-3, $ - 16e-4]);
        let F0 = p0 % 7;
        if (p0 < 51 && [0, 2, 3, 5, 6].includes(F0)) {
          let m0 = -0.612 + G * (p0 + 1) + [26e-4, 0, -22e-4, 22e-4, 0, -3e-3, 0][F0], S0 = 0.7118, T0 = 0.0125 + (K() - 0.5) * 4e-4, j0 = 0.4995, Z0 = [[-58e-4, 0], [-52e-4, T0 - 22e-4], [-38e-4, T0], [38e-4, T0], [52e-4, T0 - 22e-4], [58e-4, 0]];
          for (let lt = 0; lt < 5; lt++) {
            let H0 = Z0[lt], Y0 = Z0[lt + 1], et = j0 - H0[1] * 0.62, ct = j0 - Y0[1] * 0.62;
            I.quad([m0 + H0[0], S0 + H0[1], n0], [m0 + H0[0], S0 + H0[1], et], [m0 + Y0[0], S0 + Y0[1], ct], [m0 + Y0[0], S0 + Y0[1], n0], e0);
          }
          for (let lt = 1; lt < 5; lt++) I.tri([m0 + Z0[0][0], S0, j0], [m0 + Z0[lt + 1 > 5 ? 5 : lt + 1][0], S0 + Z0[lt + 1][1], j0 - Z0[lt + 1][1] * 0.62], [m0 + Z0[lt][0], S0 + Z0[lt][1], j0 - Z0[lt][1] * 0.62], e0, e0, e0);
        }
      }
      f.add(k.geo(48), o2.plasticWhite), f.add(I.geo(38), m, null, null, null, true);
    }
    f.add(Dl(1.376, 0.17, [[0, 0], [0, 0.011], [2e-3, 0.013], [0.026, 0.013], [0.028, 0.011], [0.028, 0]]), u, [0, 0.9, 0.22], [-go, 0, 0]);
    for (let k of [-1, 1]) f.add(zs(0.03, 0.013, 0.17), u, [k * 0.345, 0.9065, 0.22]);
    f.add(Te(0.66, 0.014, 0.052, 4e-3), u, [0, 0.922, 0.25]), f.add(Te(0.66, 9e-3, 8e-3, 3e-3), u, [0, 0.9325, 0.272]), f.at([0, 1.035, 0.2], [-0.3, 0, 0], () => {
      f.add(Fr(ui(0.64, 0.25, 0.014), 0.012, 35e-4, 5, 2), u, [0, 0, -6e-3]);
      for (let k of [-1, 1]) f.add(ks(4e-3, 4e-3, 0.05, 8), d, [k * 0.22, -0.127, -6e-3], [0, 0, go]);
      f.add(zs(0.016, 4e-3, 0.16), d, [0, -0.02, -0.084], [0.62, 0, 0]);
    });
    let F = pe(ke([[7e-3, -62e-4], [0.0235, -66e-4], [0.027, -3e-3], [0.027, 3e-3], [0.0235, 66e-4], [7e-3, 62e-4]], 14), 35), P = xw(Ym([[0.014, 0.054], [0.011, 0.043], [-6e-3, 0.0185], [-0.016, 0.0155], [-0.0245, 0.019], [-0.0275, 0.027], [-0.027, 0.04], [-0.021, 0.054]]), 75e-4, 15e-4, 4, 1);
    [[-0.62, 0.3, 0.5], [0.62, 0.3, -0.9], [-0.22, -1.32, 2.2]].forEach(([k, I, G]) => {
      f.add(Lb([[0.064, 0.616], [0.064, 0.552], [0.058, 0.546], [0.058, 0.538], [0.05, 0.53], [0.0475, 0.522], [0.0312, 0.118]], 5e-3), u, [k, 0, I]), f.add(Lb([[0.029, 0.066], [0.0325, 0.07], [0.0335, 0.12], [0.0345, 0.124], [0.0345, 0.13], [0.0318, 0.133]], 4e-3), d, [k, 0, I]), f.at([k, 0, I], [0, G, 0], () => {
        f.add(pe(ke([[0, 0.05], [0.012, 0.05], [0.019, 0.054], [0.02, 0.062], [0.016, 0.068], [0, 0.068]], 12)), d), f.add(P, d);
        for (let K of [-1, 1]) f.add(F, d, [K * 0.0112, 0.027, -0.016], [0, 0, go]), f.add(dr(6e-3, 8, 4, 0, Vt, 0, go), d, [K * 0.0172, 0.027, -0.016], [0, 0, -K * go]);
      });
    }), f.add(Te(0.27, 0.036, 0.1, 6e-3), u, [0, 0.583, 0.36]);
    for (let k of [-1, 1]) f.add(Lb([[0.019, 0.16, k * 0.098], [0.0185, 0.2, k * 0.097], [0.0225, 0.52, k * 0.084], [0.027, 0.535, k * 0.083], [0.027, 0.567, k * 0.083]], 4e-3), u, [0, 0, 0.36]);
    f.add(fi(ui(0.29, 0.115, 0.03), 0.072, 7e-3, 6, 2), u, [0, 0.094, 0.37]), f.add(Te(0.2, 0.034, 3e-3, 12e-4), d, [0, 0.118, 0.4285]);
    let z = (() => {
      let k = new THREE.Shape();
      return k.moveTo(-75e-4, 0.02), k.lineTo(-75e-4, -0.04), k.quadraticCurveTo(-85e-4, -0.06, -0.0155, -0.074), k.absarc(0, -0.0835, 0.0165, Tn * 0.82, Tn * 0.18 + Tn, false), k.quadraticCurveTo(85e-4, -0.06, 75e-4, -0.04), k.lineTo(75e-4, 0.02), a$(fi(k, 8e-3, 28e-4, 8, 2), (I) => {
        let G = Zt(I.z / 0.1, 0, 1);
        I.y -= 0.02 * G * G;
      });
    })();
    for (let k of [-0.07, 0, 0.07]) f.add(z, d, [k, 0.112, 0.424]), f.add(gw(zs(0.022, 0.016, 2e-3), "slot"), m, [k, 0.118, 0.4302], null, null, true), f.rod(d, [k * 0.55, 0.166, 0.375], [k * 0.55, 0.566, 0.365], 35e-4, 6);
    for (let k of [-1, 1]) f.rod(d, [k * 0.11, 0.15, 0.325], [k * 0.15, 0.598, 0.09], 55e-4, 8), f.add(dr(9e-3, 8, 6), d, [k * 0.11, 0.15, 0.325]), f.add(Te(0.03, 0.01, 0.03, 3e-3), d, [k * 0.15, 0.603, 0.088]);
    return f.at([0, 0, 1], () => {
      for (let T0 of [-1, 1]) for (let j0 of [-1, 1]) f.add(Lb([[0.0185, 0.034], [0.0245, 0.36], [0.0255, 0.37], [0.0255, 0.41]], 3e-3), u, [T0 * 0.4, 0, j0 * 0.13]), f.add(Lb([[0.0165, 0], [0.0185, 4e-3], [0.0195, 0.036], [0.0205, 0.04], [0.0205, 0.046], [0.019, 0.049]], 3e-3), d, [T0 * 0.4, 0, j0 * 0.13]);
      f.add(fi(ui(0.9, 0.36, 0.016), 0.058, 4e-3, 5, 2), u, [0, 0.402, 0]), f.add(fi(ui(0.912, 0.372, 0.02), 0.01, 4e-3, 5, 2), u, [0, 0.458, 0]);
      for (let T0 of [-1, 1]) f.add(pe(ke([[0, 0], [0.012, 0], [0.012, 0.012], [0.03, 0.014], [0.033, 0.018], [0.033, 0.03], [0.029, 0.035], [0.012, 0.036], [0, 0.036]], 20)), u, [T0 * 0.45, 0.431, 0], [0, 0, -T0 * go]), f.add(pe(ke([[0, 0.0355], [0.011, 0.0355], [0.01, 0.0385], [0, 0.0395]], 12)), d, [T0 * 0.45, 0.431, 0], [0, 0, -T0 * go]);
      let k = 0.442, I = 0.172, G = 0.022, K = 0.5335, $ = 0.07, n0 = 0.1, e0 = (T0, j0) => {
        let Z0 = [];
        for (let H0 of [90, 60, 30]) Z0.push([-T0, -Fd(H0)]);
        let lt = Math.round(2 * T0 / j0);
        for (let H0 = 0; H0 <= lt; H0++) Z0.push([-T0 + 2 * T0 * H0 / lt, 0]);
        for (let H0 of [30, 60, 90]) Z0.push([T0, Fd(H0)]);
        return Z0;
      }, p0 = e0(k - G, $ / 3), t0 = e0(I - G, n0 / 4), M0 = [], f0 = [], _0 = p0.length, F0 = [];
      for (let T0 of [-n0, 0, n0]) for (let j0 = -0.42; j0 <= 0.421; j0 += $) Math.abs(j0) < 0.4 && Math.abs((Math.round(j0 / $) + Math.round(T0 / n0)) % 2) === 0 && F0.push([Math.round(j0 / $) * $, T0]);
      for (let [T0, j0] of t0) for (let [Z0, lt] of p0) {
        let H0 = Math.abs(lt) > 1.5 ? 1e6 * Math.sign(lt) : Math.tan(lt), Y0 = Math.abs(j0) > 1.5 ? 1e6 * Math.sign(j0) : Math.tan(j0), et = Math.hypot(H0, 1, Y0), ct = K - G + G / et;
        if (!lt && !j0) {
          let D0 = Fo(0, 0.06, Math.min(k - G - Math.abs(Z0), I - G - Math.abs(T0))), u0 = (Z0 / $ + T0 / n0) / 2, w0 = (-Z0 / $ + T0 / n0) / 2, P0 = 0;
          for (let st of F0) P0 = Math.max(P0, Math.exp(-((Z0 - st[0]) ** 2 + (T0 - st[1]) ** 2) / 42e-5));
          ct += D0 * (78e-4 * Math.pow(Math.abs(So(Tn * u0) * So(Tn * w0)), 0.55) - 42e-4 * P0) + 3e-3 * (1 - (Z0 / k) ** 2) * (1 - (T0 / I) ** 2);
        }
        M0.push(Z0 + G * H0 / et, ct, T0 + G * Y0 / et);
      }
      for (let T0 = 0; T0 < t0.length - 1; T0++) for (let j0 = 0; j0 < _0 - 1; j0++) {
        let Z0 = T0 * _0 + j0, lt = Z0 + 1, H0 = Z0 + _0, Y0 = H0 + 1;
        f0.push(Z0, H0, lt, lt, H0, Y0);
      }
      let m0 = new THREE.BufferGeometry();
      m0.setAttribute("position", new THREE.Float32BufferAttribute(M0, 3)), m0.setIndex(f0), m0.computeVertexNormals(), f.add(m0, x);
      let S0 = (T0, j0 = 0) => di(2 * k + j0, 2 * I + j0, G + j0 / 2, T0, 4).map((Z0) => [Z0.x, Z0.y, Z0.z]);
      f.add(N9([S0(K - G), S0(K - G - 0.02, 5e-3), S0(0.468)], { deg: 60 }), x);
      for (let T0 of [K - G - 15e-4, 0.4705]) f.add(Qo(di(2 * k + 4e-3, 2 * I + 4e-3, G + 2e-3, T0, 4), 42e-4, 5, true), x);
      for (let [T0, j0] of F0) f.add(dr(0.0105, 8, 4, 0, Vt, 0, go), x, [T0, K - 35e-4, j0], null, [1, 0.5, 1]);
    }), f.shift(0, 0, 0.23), rs("piano", [1.5, 1.78, 2.84], { surf: "wood", mass: 420, colliders: [$s(-0.75, 0, -1.42, 0.75, 0.94, 0.83), $s(-0.46, 0, 1.03, 0.46, 0.54, 1.42)] });
  });
  let a = (f, u, d = 0) => {
    let m = new THREE.Shape();
    return m.moveTo(-f / 2, d), m.lineTo(f / 2, d), m.lineTo(f / 2, d + u), m.absarc(0, d + u, f / 2, 0, Tn, false), m.lineTo(-f / 2, d), m;
  }, r = (f, u, d = 28) => {
    let m = Ud(u, 2), p = new THREE.CircleGeometry(f, d), x = p.attributes.uv;
    for (let g = 0; g < x.count; g++) x.setXY(g, m[0] + (m[2] - m[0]) * x.getX(g), m[1] + (m[3] - m[1]) * x.getY(g));
    return p;
  }, l = (f, u) => {
    let d = [], m = f.length, p = 0;
    for (let x = 0; x < m; x++) {
      let g = f[x], b = f[(x + 1) % m], v = g.distanceTo(b), y = p;
      for (; y < v; ) d.push(g.clone().lerp(b, y / v)), y += u;
      p = y - v;
    }
    return d;
  }, c = (f, u, d, m = 1e-3) => {
    let p = Od(), x = Ud(d, 1), g = f.length, b = new THREE.Vector3();
    for (let v of f) b.add(v);
    b.multiplyScalar(1 / g);
    for (let v = 0; v < g; v++) {
      let y = f[v], M = f[(v + 1) % g], w = M.x - y.x, T = M.y - y.y, S = Math.hypot(w, T) || 1, E = T / S, _ = -w / S;
      E * (y.x - b.x) + _ * (y.y - b.y) < 0 && (E = -E, _ = -_);
      let R = [y.x + E * m, y.y + _ * m], C = [M.x + E * m, M.y + _ * m], L = [[R[0], R[1], y.z - u], [C[0], C[1], y.z - u], [C[0], C[1], y.z + u], [R[0], R[1], y.z + u]], A = [L[1][0] - L[0][0], L[1][1] - L[0][1]];
      A[0] * _ - A[1] * E > 0 ? p.quad(L[1], L[0], L[3], L[2], x) : p.quad(L[0], L[1], L[2], L[3], x);
    }
    return p.geo();
  }, h = (f, u, d = 12) => pe(ke([[0, -u / 2], [f * 0.55, -u / 2], [f * 0.62, -u / 2 + 2e-3], [f - 4e-3, -u / 2 + 1e-3], [f, -u / 2 + 5e-3], [f, u / 2 - 5e-3], [f - 4e-3, u / 2 - 1e-3], [f * 0.62, u / 2 - 2e-3], [f * 0.55, u / 2], [0, u / 2]], d), 40).rotateZ(go);
  t("speaker", null, (f) => {
    let u = n(), d = o2.woodDark, m = o2.brass, p = 0.172, x = 0.6;
    for (let b of [-1, 1]) for (let v of [-1, 1]) f.rod(d, [b * 0.26, 0.09, v * 0.12], [b * 0.283, 0.026, v * 0.143], 0.024, 10, 0.0155, "y"), f.rod(m, [b * 0.2815, 0.032, v * 0.1415], [b * 0.287, 0, v * 0.147], 0.0168, 10, 0.014);
    f.add(fi(ui(0.66, 0.38, 0.012), 0.03, 5e-3, 4), d, [0, 0.08, 0], null, null, "x"), f.add(fi(ui(0.64, 0.362, 0.01), 0.014, 4e-3, 4), d, [0, 0.108, 0], null, null, "x"), f.add(Fr(a(0.624, 0.712), 0.344, 0.012, 20), d, [0, 0.108, -p], null, null, "y");
    {
      let b = a(0.6, 0.7);
      b.holes.push(new THREE.Path(a(0.53, 0.675, 0.03).getPoints(14))), f.add(Fr(b, 0.012, 4e-3, 14), d, [0, 0.12, p - 4e-3], null, null, "y"), f.add(SD(new THREE.ShapeGeometry(a(0.53, 0.675, 0.03), 14), (v, y) => [452 + (v / 0.53 + 0.5) * 504, 4 + (1 - (y - 0.03) / 0.94) * 824]), u, [0, 0.12, p + 12e-4], null, null, true);
    }
    f.add(SD(new THREE.ShapeGeometry(a(0.44, 0.2), 14), (b, v) => [962 + (b / 0.44 + 0.5) * 252, 2 + (1 - v / 0.42) * 252]), u, [0, x, p + 3e-3], null, null, true);
    {
      let b = [[-0.22, x, p + 8e-3], [-0.22, x + 0.2, p + 8e-3]];
      for (let v = 1; v < 12; v++) {
        let y = Tn - v / 12 * Tn;
        b.push([pi(y) * 0.22, x + 0.2 + So(y) * 0.22, p + 8e-3]);
      }
      b.push([0.22, x + 0.2, p + 8e-3], [0.22, x, p + 8e-3]), f.add(Qo(b, 9e-3, 6), m);
      for (let v = 0; v < 9; v++) {
        let y = Fd(18 + v * 18), M = pi(y), w = So(y), T = 0.22 / Math.max(1e-3, Math.abs(M)), S = T * w <= 0.2 ? T : 0.2 * w + Math.sqrt(0.04 * w * w + 84e-4);
        f.rod(m, [M * 0.05, x + w * 0.05, p + 7e-3], [M * (S - 6e-3), x + w * (S - 6e-3), p + 7e-3], v % 2 ? 38e-4 : 52e-4, 6);
      }
      for (let v of [0.058, 0.13]) f.add(Sa(v, 4e-3, 5, 16, Tn), m, [0, x, p + 8e-3]);
      f.add(Te(0.48, 0.02, 0.022, 6e-3), m, [0, x - 6e-3, p + 8e-3]);
    }
    f.add(fc(0.09, 0.0193, "rbadge"), u, [0, x - 0.045, p + 95e-4], null, null, true), f.keep("bulb", r(0.085, "dial"), i(), [0, 0.36, p + 6e-3], null, null, { uv: true }), f.add(pe(ke([[0.083, 0], [0.104, 0], [0.106, 4e-3], [0.098, 0.012], [0.09, 0.013], [0.085, 9e-3], [0.083, 9e-3]], 28), 40), m, [0, 0.36, p + 4e-3], [go, 0, 0]), f.add(zs(35e-4, 0.072, 2e-3), o2.blackMetal, [0.0165, 0.39, p + 0.0105], [0, 0, -0.5]), f.add(pe(ke([[0, 0], [9e-3, 0], [9e-3, 3e-3], [5e-3, 6e-3], [0, 6e-3]], 10), 40), m, [0, 0.36, p + 95e-4], [go, 0, 0]);
    let g = (b, v, y) => {
      f.add(pe(ke([[0, 0], [y * 1.25, 0], [y * 1.25, 4e-3], [y * 1.05, 6e-3]], 16), 40), m, [b, v, p + 8e-3], [go, 0, 0]), f.add(pe(ke([[y, 4e-3], [y * 0.96, 0.02], [y * 0.82, 0.026], [y * 0.5, 0.027], [y * 0.46, 0.03], [0, 0.03]], 16), 35), o2.blackMetal, [b, v, p + 8e-3], [go, 0, 0]), f.add(zs(y * 0.12, y * 0.5, 2e-3), m, [b, v + y * 0.55, p + 0.0355]);
    };
    return g(-0.19, 0.34, 0.027), g(0.19, 0.34, 0.027), g(-0.085, 0.238, 0.016), g(0.085, 0.238, 0.016), f.add(Te(0.5, 0.01, 0.01, 3e-3), m, [0, 0.19, p + 8e-3]), f.add(fc(0.5, 0.666, "back"), u, [0, 0.5, -p - 5e-4], [0, Tn, 0], null, true), rs("speaker", [0.66, 1.14, 0.38], { surf: "wood", mass: 35, colliders: [$s(-0.33, 0, -0.19, 0.33, 1.12, 0.19)], light: { pos: [0, 0.4, 0.3], color: 16751164, intensity: 0.5, range: 3 } });
  }), t("elevatorDoor", null, (f) => {
    let u = n(), d = i(), m = o2.brass, p = o2.blackMetal;
    for (let x of [-1, 1]) {
      f.add(Te(0.594, 2.2, 0.016, 3e-3), m, [x * 0.3, 0, 0.01]), f.add(Dl(0.594, 2.2, [[0, 0], [0, 5e-3], [4e-3, 8e-3], [0.042, 8e-3], [0.048, 3e-3], [0.048, 0]]), m, [x * 0.3, 0, 0.016]), f.add(Te(0.5, 0.05, 7e-3, 3e-3), m, [x * 0.3, -0.36, 0.0205]);
      for (let g = 0; g < 9; g++) f.add(ks(0.024, 0.024, 0.6, 6), m, [x * (0.076 + g * 0.056), -0.71, 0.0165], null, [1, 1, 0.28]);
      for (let g = 0; g < 6; g++) {
        let b = Fd(9 + g * 15), v = pi(b), y = So(b), M = 0.31, w = Math.min(0.49 / v, 1.3 / y) - 0.012, T = (M + w) / 2;
        f.add(zs(w - M, 45e-4, 3e-3), p, [x * (0.05 + v * T), -0.32 + y * T, 0.0185], [0, 0, x * b]);
      }
      for (let g of [0.12, 0.2, 0.28]) f.add(Sa(g, 45e-4, 4, 10, go), m, [x * 0.05, -0.32, 0.0185], [0, 0, x > 0 ? 0 : go]);
      for (let g of [0.99, 1.02]) f.add(zs(0.47, 4e-3, 3e-3), p, [x * 0.3, g, 0.0185]);
      f.add(Te(0.022, 2.2, 0.05, 4e-3), p, [x * 0.611, 0, 0.025]), f.add(Te(0.158, 0.15, 0.08, 5e-3), m, [x * 0.69, -1.025, 0.04]);
    }
    f.add(zs(8e-3, 2.2, 0.012), p, [0, 0, 0.02]), f.add(Te(1.22, 0.022, 0.05, 4e-3), p, [0, 1.111, 0.025]), f.add(_i([[-0.07, 0], [-0.07, 0.03], [-0.062, 0.038], [-0.05, 0.038], [-0.046, 0.05], [-0.02, 0.05], [-0.016, 0.062], [0.03, 0.062], [0.036, 0.07], [0.052, 0.07], [0.058, 0.062], [0.07, 0.05], [0.07, 0]], [[-0.69, -0.95, 0], [-0.69, 1.2, 0], [0.69, 1.2, 0], [0.69, -0.95, 0]], { closed: false, up: De(0, 0, 1), deg: 35 }), m), f.add(Te(1.6, 0.03, 0.085, 6e-3), m, [0, 1.295, 0.0425]), f.add(Te(1.55, 0.016, 0.078, 5e-3), m, [0, 1.272, 0.039]), f.add(Te(1.2, 0.012, 0.07, 3e-3), p, [0, -1.094, 0.035]);
    for (let x of [0.018, 0.034, 0.056]) f.add(zs(1.19, 3e-3, 5e-3), m, [0, -1.0875, x]);
    {
      let x = new THREE.Shape();
      x.moveTo(0.19, 0), x.absarc(0, 0, 0.19, 0, Tn, false), x.lineTo(0.19, 0), f.add(Fr(x, 0.02, 4e-3, 14), m, [0, 1.308, 0]), f.add(fc(0.33, 0.1768, "ind"), d, [0, 1.308 + 4e-3 + 0.0884, 0.0206], null, null, true);
      let g = 1.312 + 0.1768 * 18 / 240, b = Tn * (1 - 6.5 / 7);
      f.add(zs(0.108, 35e-4, 2e-3), m, [pi(b) * 0.056, g + So(b) * 0.056, 0.0225], [0, 0, b]), f.add(ks(8e-3, 8e-3, 4e-3, 10), m, [0, g, 0.0225], [go, 0, 0]);
    }
    f.add(Te(0.1, 0.24, 0.012, 4e-3), m, [0.92, 0, 6e-3]), f.add(fc(0.036, 0.036, "btnUp", 3), d, [0.92, 0.035, 0.0128], null, null, true), f.add(fc(0.036, 0.036, "btnDn", 3), u, [0.92, -0.035, 0.0128], null, null, true);
    for (let x of [0.035, -0.035]) f.add(Sa(0.0195, 3e-3, 5, 18), m, [0.92, x, 0.0125]);
    f.add(fc(0.076, 0.0285, "plq"), u, [0.92, 0.092, 0.0128], null, null, true), f.add(ks(7e-3, 7e-3, 4e-3, 10), p, [0.92, -0.092, 0.013], [go, 0, 0]);
    for (let x of [-1, 1]) for (let g of [-1, 1]) f.add(ks(35e-4, 35e-4, 3e-3, 6), p, [0.92 + x * 0.04, g * 0.108, 0.0125], [go, 0, 0]);
    return rs("elevatorDoor", [1.94, 2.6, 0.085], { surf: "metal", wall: true, mountY: 1.1, mass: 300, colliders: [$s(-0.76, -1.1, 0, 0.76, 1.31, 0.07)] });
  }), t("luggageCart", null, (f) => {
    let u = o2.brass, d = o2.woodDark, m = o2.rubber;
    f.add(fi(ui(1.1, 0.6, 0.05), 0.05, 7e-3, 5), d, [0, 0.16, 0], null, null, "x"), f.add(fi(ui(1.04, 0.54, 0.032), 0.021, 4e-3, 5), o2.carpetLobby, [0, 0.208, 0]), f.add(Qo(di(1.046, 0.546, 0.034, 0.2105, 4), 4e-3, 5, true), u), f.add(Qo(di(1.13, 0.63, 0.075, 0.2, 4), 0.012, 6, true), u);
    for (let [x, g] of [[-0.3, 0.315], [0.3, 0.315], [-0.3, -0.315], [0.3, -0.315], [0.565, 0.14], [0.565, -0.14], [-0.565, 0.14], [-0.565, -0.14]]) {
      let b = Math.abs(x) > 0.5 ? Math.sign(x) * 0.54 : x, v = Math.abs(x) > 0.5 ? g : Math.sign(g) * 0.29;
      f.rod(u, [b, 0.195, v], [x, 0.2, g], 7e-3, 6);
    }
    let p = (x, g, b, v = 0.016, y = 0.03) => f.add(pe(ke([[v, -y / 2], [v + 5e-3, -y / 2 + 3e-3], [v + 7e-3, 0], [v + 5e-3, y / 2 - 3e-3], [v, y / 2]], 12), 40), u, [x, g, b]);
    for (let x of [-1, 1]) {
      let g = x * 0.5;
      f.add(Qo(ra([[g, 0.2, -0.27], [g, 0.9, -0.27], [g, 1.4, -0.26], [g, 1.66, -0.17], [g, 1.76, 0], [g, 1.66, 0.17], [g, 1.4, 0.26], [g, 0.9, 0.27], [g, 0.2, 0.27]], 30), 0.016, 7), u);
      for (let b of [-1, 1]) f.add(pe(ke([[0.034, 0], [0.036, 4e-3], [0.036, 8e-3], [0.024, 0.016], [0.022, 0.05], [0.016, 0.052]], 14), 40), u, [g, 0.208, b * 0.27]), p(g, 0.9, b * 0.27), p(g, 0.55, b * 0.27, 0.016, 0.018);
      f.add(pe(ke([[0.016, 0], [0.024, 6e-3], [0.02, 0.016], [0.012, 0.02], [0.012, 0.026], [0.024, 0.036], [0.03, 0.052], [0.026, 0.068], [0.012, 0.079], [0, 0.081]], 14), 40), u, [g, 1.752, 0]), f.add(dr(0.021, 10, 6), u, [x * 0.37, 1.64, 0]), f.rod(u, [x * 0.3, 1.755, 0], [x * 0.3, 1.645, 0], 6e-3, 6);
      for (let b of [-1, 1]) {
        let v = x * 0.42, y = b * 0.22;
        f.add(h(0.05, 0.03, 12), m, [v, 0.05, y]), f.add(ks(0.02, 0.02, 0.034, 10), u, [v, 0.05, y], [0, 0, go]);
        for (let M of [-1, 1]) f.add(pe(new THREE.ExtrudeGeometry(new THREE.Shape([oo(-0.022, 0), oo(0.022, 0), oo(0.03, 0.07), oo(0.022, 0.1), oo(-0.022, 0.1), oo(-0.03, 0.07)]), { depth: 4e-3, bevelEnabled: false }), 30), u, [v + M * 0.019 - 2e-3, 0.036, y], [0, go, 0]);
        f.add(Te(0.046, 8e-3, 0.06, 3e-3), u, [v, 0.138, y]), f.add(ks(0.03, 0.03, 0.012, 12), u, [v, 0.151, y]);
      }
    }
    return f.rod(u, [-0.5, 1.76, 0], [0.5, 1.76, 0], 0.014, 8), f.rod(u, [-0.37, 1.64, 0], [0.37, 1.64, 0], 8e-3, 7), rs("luggageCart", [1.14, 1.83, 0.64], { surf: "metal", mass: 30, colliders: [$s(-0.56, 0, -0.31, 0.56, 0.26, 0.31)] });
  }), t("suitcase", (f) => (f.variant | 0) % 3, (f, u) => {
    let d = (u.variant | 0) % 3, m = n(), p = o2.brass;
    if (d === 1) {
      let L = s("leatherTan"), A = s("leatherBlack"), O = 0.215;
      f.add(Jo(0.62, 0.42, 0.2, { r: 0.03, seg: [6, 4, 2], arc: 4, crown: { pz: 6e-3, nz: 6e-3 }, lump: 2e-3, seed: 21 }), L, [0, O, 0]);
      for (let H of [0.034, -0.092, 0.092]) f.add(_i([[-3e-3, -6e-3], [35e-4, -6e-3], [35e-4, 6e-3], [-3e-3, 6e-3]], di(H === 0.034 ? 0.62 : 0.606, H === 0.034 ? 0.42 : 0.406, H === 0.034 ? 0.03 : 0.024, H, 4, "xy"), { up: De(0, 0, 1), deg: 50 }), H === 0.034 ? A : L, [0, O, 0]);
      for (let H of [-0.17, 0.17]) f.add(_i([[-95e-4, -0.018], [95e-4, -0.018], [95e-4, 0.018], [-95e-4, 0.018]], di(0.2, 0.42, 0.03, H, 4, "zy"), { up: De(1, 0, 0), deg: 50 }), A, [0, O, 0]), f.add(Dl(0.052, 0.04, [[0, 0], [0, 6e-3], [7e-3, 6e-3], [7e-3, 0]]), p, [H, 0.3, 0.1085]), f.rod(p, [H - 0.02, 0.3, 0.113], [H + 0.014, 0.3, 0.113], 22e-4, 5), f.add(Te(0.044, 0.012, 7e-3, 2e-3), A, [H, 0.262, 0.111]), f.add(Te(0.03, 0.044, 0.01, 3e-3), p, [H * 0.42, 0.398, 0.1], [-0.1, 0, 0]);
      for (let H of [-1, 1]) for (let F of [-1, 1]) for (let P of [-1, 1]) f.add(dr(0.034, 8, 5), p, [H * 0.288, O + F * 0.188, P * 0.078], null, [1, 1, 0.85]);
      f.add(lc([[-0.075, 0.428, 0], [-0.062, 0.468, 0], [0.062, 0.468, 0], [0.075, 0.428, 0]], 75e-4, 0.024, 6), A, null, null, [1, 1, 1.7]);
      for (let H of [-1, 1]) f.add(Te(0.026, 8e-3, 0.036, 3e-3), p, [H * 0.075, 0.428, 0]), f.add(Sa(0.011, 28e-4, 5, 10), p, [H * 0.075, 0.438, 0], [0, go, 0]);
      return f.add(fc(0.13, 0.13, "st1"), m, [-0.02, 0.2, 0.1068], [0, 0, 0.12], null, true), f.add(fc(0.15, 0.095, "st2"), m, [0.07, 0.115, 0.1066], [0, 0, -0.2], null, true), f.add(fc(0.1, 0.113, "st3"), m, [0.06, 0.25, -0.1068], [0, Tn, 0.3], null, true), f.add(cu(fc(0.05, 0.08, "tag")), m, [0.105, 0.385, 0.111], [0.12, 0, -0.3], null, true), rs("suitcase", [0.62, 0.47, 0.21], { surf: "fabric", dynamic: true, mass: 12 });
    }
    let [x, g, b, v] = d === 0 ? [0.46, 0.64, 0.27, o2.plasticBlack] : [0.36, 0.5, 0.22, o2.plasticWhite], y = 0.055, M = y + g / 2, w = y + g, T = d === 0 ? 6 : 5, S = g - 0.1, E = o2.rubber, _ = o2.steel;
    f.add(Jo(x, g, b, { r: 0.05, seg: [3, T * 2, 2], arc: 4, crown: { pz: 4e-3, nz: 4e-3 }, sculpt: (L, A, O) => {
      Math.abs(A.z) > 0.6 && (L.z -= Math.sign(A.z) * 8e-3 * (1 - lw(L.y + S / 2, S / T, 0.3)) * (1 - Math.pow(Math.abs(O[0]), 8)));
    } }), v, [0, M, 0]);
    {
      let L = di(x, g, 0.05, 0, 5, "xy");
      f.add(_i([[-2e-3, -0.011], [2e-3, -0.011], [2e-3, 0.011], [-2e-3, 0.011]], L, { up: De(0, 0, 1), deg: 50 }), E, [0, M, 0]), f.add(c(l(L, 0.03), 75e-4, "zip", 26e-4), m, [0, M, 0], null, null, true);
      for (let A of [0.04, -0.02]) f.add(Te(0.012, 0.03, 6e-3, 2e-3), _, [x / 2 + 6e-3, M + A, 6e-3], [0, 0, 0.2]), f.add(Te(6e-3, 0.012, 0.012, 2e-3), _, [x / 2 + 4e-3, M + A + 0.016, 0]);
    }
    for (let L of [-1, 1]) for (let A of [-1, 1]) {
      let O = L * (x / 2 - 0.05), H = A * (b / 2 - 0.045);
      for (let F of [-1, 1]) f.add(ks(0.027, 0.027, 0.012, 12), E, [O + F * 95e-4, 0.027, H], [0, 0, go]);
      f.add(ks(0.011, 0.011, 0.034, 8), _, [O, 0.027, H], [0, 0, go]), f.add(Te(0.05, 0.034, 0.058, 0.012), v, [O, 0.066, H]), f.add(ks(6e-3, 6e-3, 0.03, 6), _, [O, 0.045, H]);
    }
    let R = d === 0 ? 0.3 : 0.03, C = -b / 2 + 0.05;
    f.add(Te(0.25, 0.01, 0.056, 4e-3), v, [0, w + 1e-3, C]);
    for (let L of [-1, 1]) f.add(ks(88e-4, 88e-4, R * 0.55 + 0.012, 8), _, [L * 0.08, w + (R * 0.55 + 0.012) / 2, C]), d === 0 && (f.add(ks(68e-4, 68e-4, R * 0.5, 8), _, [L * 0.08, w + R * 0.55 + R * 0.25, C]), f.add(ks(98e-4, 98e-4, 0.01, 8), E, [L * 0.08, w + R * 0.55 + 0.012, C]));
    f.add(Jo(0.2, 0.024, 0.032, { r: 0.011, seg: [3, 1, 1], arc: 2, crown: 2e-3 }), E, [0, w + R + 0.012, C]), f.add(Te(0.03, 4e-3, 0.012, 2e-3), _, [0, w + R + 0.0245, C]), f.add(lc([[-0.062, w - 4e-3, 0.02], [-0.05, w + 0.017, 0.02], [0.05, w + 0.017, 0.02], [0.062, w - 4e-3, 0.02]], 6e-3, 0.014, 6), E, null, null, [1, 1, 1], null), f.add(lc([[x / 2 - 4e-3, M - 0.062, 0.03], [x / 2 + 0.014, M - 0.05, 0.03], [x / 2 + 0.014, M + 0.05, 0.03], [x / 2 - 4e-3, M + 0.062, 0.03]], 6e-3, 0.014, 6), E);
    for (let L of [M - g * 0.3, M + g * 0.3]) f.add(ks(0.012, 0.014, 0.012, 8), E, [-x / 2 - 4e-3, L, -b * 0.25], [0, 0, go]);
    return f.add(Te(0.074, 0.03, 6e-3, 3e-3), v, [0, M + g * 0.36, b / 2 + 3e-3]), f.add(fc(0.064, 0.0224, "cbadge"), m, [0, M + g * 0.36, b / 2 + 64e-4], null, null, true), f.add(fc(0.044, 0.0275, "lock"), m, [x / 2 + 35e-4, M + g * 0.22, 0.03], [0, go, 0], null, true), d === 2 && (f.add(fc(0.1, 0.063, "st2"), m, [0.03, M - 0.06, b / 2 + 62e-4], [0, 0, 0.25], null, true), f.add(fc(0.075, 0.085, "st3"), m, [-0.07, M + 0.03, b / 2 + 62e-4], [0, 0, -0.15], null, true)), rs("suitcase", [x + 0.01, 0.055 + g + R + 0.03, b + 0.02], { surf: "plastic", dynamic: true, mass: d === 0 ? 14 : 8 });
  });
}
var jm = Math.PI, Or = jm / 2;
function T1(o2, t, e, { wrapU: s = false, flip: n = false } = {}) {
  let i = s ? o2 : o2 + 1, a = new Float32Array(i * (t + 1) * 3), r = [], l = new THREE.Vector3();
  for (let h = 0; h <= t; h++) for (let f = 0; f < i; f++) {
    e(f, h, l);
    let u = (h * i + f) * 3;
    a[u] = l.x, a[u + 1] = l.y, a[u + 2] = l.z;
  }
  for (let h = 0; h < t; h++) for (let f = 0; f < o2; f++) {
    let u = h * i + f, d = h * i + (f + 1) % i, m = u + i, p = d + i;
    n ? r.push(u, m, d, d, m, p) : r.push(u, d, m, d, p, m);
  }
  let c = new THREE.BufferGeometry();
  return c.setAttribute("position", new THREE.BufferAttribute(a, 3)), c.setIndex(r), c.computeVertexNormals(), c;
}
function Vd(o2, t, e, s = "z", n = 4e-3) {
  let i = new THREE.Shape(), a = o2 / 2, r = t / 2;
  i.moveTo(-a + n, -r), i.lineTo(a - n, -r), i.lineTo(a, -r + n), i.lineTo(a, r - n), i.lineTo(a - n, r), i.lineTo(-a + n, r), i.lineTo(-a, r - n), i.lineTo(-a, -r + n), i.closePath();
  let l = C9(i, e, 0).translate(0, 0, -e / 2);
  return s === "x" ? l.rotateY(Or) : s === "y" && l.rotateX(-Or), pe(l, 50);
}
function r$(o2, t) {
  let e = o2.attributes.position, s = o2.index.array, n = [], i = (a) => t(e.getX(a), e.getY(a), e.getZ(a));
  for (let a = 0; a < s.length; a += 3) i(s[a]) && i(s[a + 1]) && i(s[a + 2]) || n.push(s[a], s[a + 1], s[a + 2]);
  return o2.setIndex(n), o2;
}
function Db(o2, t, e, s = {}) {
  let n = s.nu || 12, i = s.nv || n, a = s.plump ?? 2.4, r = s.round ?? 0.6, l = s.pinch ?? 0.05, c = s.sag || 0, h = s.lump ?? 5e-3, f = s.seed || 3, u = _n(f), d = s.pucker ?? 0.2, m = s.npuck || 6, p = s.back ?? 1, x = s.crease ?? 0.22, g = s.wave ?? 4e-3, b = s.droop || 0, v = n + 1, y = [], M = [], w = new THREE.Vector3(), T = (A, O) => {
    let H = A / O * 2 - 1;
    return Ht(H, Math.sin(H * Or), 0.5);
  }, S = (A, O, H) => {
    let F = T(A, n), P = T(O, i), z = Math.abs(F), k = Math.abs(P), I = Math.pow(1 - Math.pow(z, a), r) * Math.pow(1 - Math.pow(k, a), r), G = I, K = Math.exp(-Math.pow((1 - k) / 0.34, 2)), $ = Math.exp(-Math.pow((1 - z) / 0.34, 2));
    I *= 1 + d * (K * (1 - $) * Math.cos(m * jm * F + H + f) + $ * (1 - K) * Math.cos(m * jm * P * t / o2 + 1.7 * H + f));
    let n0 = 1 - z, e0 = 1 - k;
    I *= 1 + x * Math.cos(6 * Math.atan2(e0, n0) + f * 1.3) * Math.exp(-(n0 * n0 + e0 * e0) / 0.09), I *= 1 - c * P * 0.45;
    let p0 = (u.fbm(F * 2.1 + 9 + H * 3.3, P * 2.1 + 4, 3) - 0.5) * 2 * h, t0 = g * Math.sin(F * 4.3 + P * 3.1 + f) - b * F * F * P * P, M0;
    return H > 0 ? M0 = (e / 2 + p0) * I : s.flat ? M0 = -s.flat * (1 - Math.pow(1 - Math.min(1, G * 1.45), 2.2)) : M0 = -(e / 2 + p0) * I * p, w.set(F * o2 / 2 * (1 - l * (1 - P * P)) * (1 - c * 0.05 * P), P * t / 2 * (1 - l * (1 - F * F)), t0 + M0), s.sculpt && s.sculpt(w, H, F, P), y.push(w.x, w.y, w.z), y.length / 3 - 1;
  }, E = [], _ = [];
  for (let A = 0; A <= i; A++) for (let O = 0; O <= n; O++) E.push(S(O, A, 1));
  for (let A = 0; A <= i; A++) for (let O = 0; O <= n; O++) _.push(O === 0 || A === 0 || O === n || A === i ? E[A * v + O] : S(O, A, -1));
  for (let A = 0; A < i; A++) for (let O = 0; O < n; O++) {
    let H = A * v + O, F = H + 1, P = H + v, z = P + 1;
    M.push(E[H], E[F], E[P], E[F], E[z], E[P], _[H], _[P], _[F], _[F], _[P], _[z]);
  }
  let R = new THREE.BufferGeometry();
  R.setAttribute("position", new THREE.Float32BufferAttribute(y, 3)), R.setIndex(M), R.computeVertexNormals();
  let C = [], L = (A, O) => {
    let H = E[O * v + A] * 3;
    return { p: De(y[H], y[H + 1], y[H + 2]), ox: A === 0 ? -1 : A === n ? 1 : 0, oy: O === 0 ? -1 : O === i ? 1 : 0 };
  };
  for (let A = 0; A < n; A++) C.push(L(A, 0));
  for (let A = 0; A < i; A++) C.push(L(n, A));
  for (let A = n; A > 0; A--) C.push(L(A, i));
  for (let A = i; A > 0; A--) C.push(L(0, A));
  return R.userData.edge = C, R;
}
var yw = (o2, t = 45e-4, e = 4) => Qo(o2.userData.edge.map((s) => s.p), t, e, true);
function l$(o2, t, e = 4e-3) {
  let s = o2.userData.edge, n = s.length;
  return cu(T1(n, 2, (i, a, r) => {
    let l = s[i % n], c = a / 2;
    r.set(l.p.x + l.ox * t * c, l.p.y + l.oy * t * c, l.p.z + e * c * Math.sin(i * 1.9) - 6e-3 * c * c);
  }, { wrapU: true }));
}
function c$(o2, t, e = 9e-3, s = 0.9) {
  let i = (c) => o2 - e + e * c / 16, a = t / 2, r = [[-a + 6e-3, 0], [-a - 2e-3, 0.45], [-a - 4e-3, 0.8], [-a, 0.95], [-a + 0.014, 1], [-a * 0.5, 1.015], [0, 1.02], [a * 0.5, 1.015], [a - 0.014, 1], [a, 0.95], [a + 4e-3, 0.8], [a + 2e-3, 0.45], [a - 6e-3, 0]], l = (c, h, f, u) => {
    let d = s + f / 16 * Vt, m = r[h];
    c.set(m[0], Math.max(Math.cos(d) * u * m[1], -o2 * 0.94), Math.sin(d) * u * m[1]);
  };
  return Vn([T1(16, r.length - 1, (c, h, f) => l(f, h, c, i(c))), T1(1, r.length - 1, (c, h, f) => l(f, h, 0, i(c ? 0 : 16)))], false);
}
function B9(o2, t, e) {
  let s = new THREE.BoxGeometry(o2, e, t).translate(0, e / 2, 0).toNonIndexed(), n = s.attributes.position, i = s.attributes.normal, a = s.attributes.uv;
  for (let r = 0; r < n.count; r++) Math.abs(i.getX(r)) > 0.5 ? a.setXY(r, n.getY(r), n.getZ(r) + 0.13) : Math.abs(i.getZ(r)) > 0.5 ? a.setXY(r, n.getY(r), n.getX(r) + 0.31) : a.setXY(r, n.getX(r), n.getZ(r));
  return s;
}
function RD({ M: o2, L: t, def: e, lib: s, mt: n, fine: i, P: a }) {
  e("cushion", (l) => o2[l.mat] ? l.mat : "velvetTeal", (l, c) => {
    let h = i(n(c.mat, "velvetTeal")), f = 0.062, u = Db(0.45, 0.45, 0.244, { nu: 12, plump: 2.5, pinch: 0.055, lump: 4e-3, seed: 5, flat: f, droop: 0.014, npuck: 5, pucker: 0.2, wave: 3e-3 });
    return l.add(u, h, [0, f, 0], [-Or, 0, 0]), l.add(yw(u, 5e-3, 4), h, [0, f, 0], [-Or, 0, 0]), rs("cushion", [0.46, 0.17, 0.46], { surf: "fabric", dynamic: true, mass: 0.6 });
  }), e("sunLounger", null, (l) => {
    let h = Math.cos(0.56), f = Math.sin(0.56), u = -0.26, d = 0.325, m = o2.woodLight, p = o2.steel, x = o2.fabricCream, g = ke([[0, 32e-4], [45e-4, 24e-4], [65e-4, 0]], 6), b = (E, _, R, C) => l.add(g, p, [E, _, R], [0, 0, -C * Or]), v = (E) => Vd(0.062, 0.016, E, "x", 35e-4);
    for (let E of [-1, 1]) {
      let _ = E * 0.3125;
      l.add(Vd(0.045, 0.058, 1.98, "z", 5e-3), m, [_, 0.286, 0], null, null, "z"), l.add(Yi(Vd(0.045, 0.07, 0.256, "y", 5e-3), (R) => {
        R.z *= 0.8 + 0.2 * (R.y / 0.256 + 0.5);
      }), m, [_, 0.134, 0.82], null, null, "y"), l.add(ks(0.017, 0.019, 7e-3, 6), o2.rubber, [_, 35e-4, 0.82]), l.add(Yi(Vd(0.045, 0.07, 0.212, "y", 5e-3), (R) => {
        R.z *= 0.72 + 0.28 * (R.y / 0.212 + 0.5);
      }), m, [_, 0.156, -0.82], null, null, "y");
      for (let R of [0.82, -0.82]) for (let C of [-0.017, 0.017]) b(E * 0.3355, 0.288, R + C, E);
      for (let R of [-0.9675, 0.9675]) l.add(zs(3e-3, 0.03, 0.019), m, [E * 0.3352, 0.287, R], null, null, "y");
      l.at([E * 0.258, 0.085, -0.82], [0, 0, Or], null, () => {
        for (let R of [-1, 1]) l.add(pe(ke(R < 0 ? [[0.014, -0.012], [0.03, -0.0145], [0.071, -0.0145]] : [[0.071, 0.0145], [0.03, 0.0145], [0.014, 0.012]], 20), 40), m, null, null, null, "x");
        l.add(ke([[0.069, -0.0155], [0.082, -0.0135], [0.085, -6e-3], [0.085, 6e-3], [0.082, 0.0135], [0.069, 0.0155]], 20), o2.rubber), l.add(pe(ke([[6e-3, -0.02], [0.016, -0.018], [0.016, 0.018], [6e-3, 0.02]], 6), 40), p);
      }), b(E * 0.3355, 0.085, -0.82, E);
    }
    l.rod(p, [-0.335, 0.085, -0.82], [0.335, 0.085, -0.82], 55e-4, 6);
    for (let E of [-0.9675, 0.9675]) l.add(Vd(0.035, 0.05, 0.58, "x", 4e-3), m, [0, 0.287, E], null, null, "x");
    for (let E of [-0.225, 0.37]) l.add(Vd(0.03, 0.036, 0.58, "x", 3e-3), m, [0, 0.283, E], null, null, "x");
    for (let E = 0; E < 14; E++) l.add(zs(0.6, 0.016, 0.062), m, [0, 0.323, -0.19 + E * 0.0885], null, null, "x");
    let y = (E, _, R) => (C, L) => {
      for (let A of E) {
        let O = C.z - A, H = Math.abs(O);
        if (H > R * 1.5) continue;
        let F = H < R * 0.5 ? 1 : 0.1;
        H > R * 0.5 && (C.z = A + Math.sign(O) * 0.021), C.x -= L.x * 6e-3 * F, C.y -= Math.max(0, L.y) * 0.011 * F;
      }
      if (L.y > 0.5) for (let [A, O] of _) {
        let H = C.x - A, F = C.z - O, P = Math.hypot(H, F);
        if (P > 0.095) continue;
        if (P < 1e-3) {
          C.y -= 0.012;
          continue;
        }
        let z = Math.max(0.03, 0.03 + (P - 0.05) * 0.42);
        C.x = A + H / P * z, C.z = O + F / P * z, C.y -= 0.012 * Math.exp(-Math.pow(z / 0.03, 2) * 1.25);
      }
    }, M = ke([[0.013, 0], [95e-4, 4e-3], [0, 6e-3]], 6), w = (E, _, R, C, L, A, O, H) => {
      let P = (R - 0.056) / C, z = Jo(E, _, R, { r: 0.028, seg: [8, 1, C], arc: 2, crown: { py: 3e-3 }, plateau: 5, lump: 1e-3, lumpScale: 5, seed: O, sculpt: y(L, A, P) });
      l.add(H ? r$(z, (k, I) => I < -_ / 2 + 4e-3) : z, x);
      for (let k of [1, -1]) {
        let G = 0.0302 * Math.SQRT1_2, K = E / 2 - 0.028, $ = R / 2 - 0.028, n0 = k * (_ / 2 - 0.028 + G), e0 = [], p0 = (t0) => {
          for (let M0 of t0 < 0 ? [...L].reverse() : L) for (let f0 of t0 < 0 ? [2, 1, 0, -1, -2] : [-2, -1, 0, 1, 2]) {
            let _0 = [1, 0.45, 0.04][Math.abs(f0)];
            e0.push(De(t0 * (K + G - 42e-4 * _0), n0 - 78e-4 * _0, M0 + f0 * 0.019));
          }
        };
        for (let t0 = 0; t0 < 4; t0++) {
          let M0 = (t0 === 0 || t0 === 3 ? 1 : -1) * K, f0 = (t0 < 2 ? 1 : -1) * $;
          for (let _0 = 0; _0 <= 3; _0++) {
            let F0 = (t0 + _0 / 3) * Or;
            e0.push(De(M0 + Math.cos(F0) * G, n0, f0 + Math.sin(F0) * G));
          }
          t0 === 1 && k > 0 && p0(-1), t0 === 3 && k > 0 && p0(1);
        }
        l.add(Qo(e0, 4e-3, 4, true), x);
      }
      for (let [k, I] of A) l.add(M, x, [k, _ / 2 + 3e-3 - 0.0125, I]);
    };
    l.at([0, d, u], [0.56, 0, 0], null, () => {
      for (let _ of [-1, 1]) l.add(Vd(0.04, 0.04, 0.78, "z", 4e-3), m, [_ * 0.27, -6e-3, -0.39], null, null, "z"), l.add(zs(0.014, 0.02, 0.032), p, [_ * 0.27, -0.035, -0.5]), l.add(ks(4e-3, 4e-3, 0.03, 6), p, [_ * 0.27, -0.038, -0.5], [0, 0, Or]);
      l.add(Vd(0.036, 0.04, 0.5, "x", 4e-3), m, [0, -6e-3, -0.762], null, null, "x");
      for (let _ = 0; _ < 7; _++) l.add(v(0.56), m, [0, 0.012, -(0.085 + _ * 0.1)], null, null, "x");
      l.at([0, 0.0635, -0.4], null, null, () => w(0.6, 0.082, 0.78, 12, [0], [[-0.136, -0.181], [0.136, -0.181], [-0.136, 0.181], [0.136, 0.181]], 21));
      let E = Db(0.42, 0.2, 0.1, { nu: 10, nv: 6, plump: 2.6, pinch: 0.04, lump: 3e-3, seed: 9, flat: 0.026, npuck: 5, pucker: 0.16, crease: 0.15 });
      l.add(E, x, [0, 0.13, -0.615], [-Or, 0, 0]), l.add(yw(E, 4e-3, 4), x, [0, 0.13, -0.615], [-Or, 0, 0]);
      for (let _ of [-1, 1]) {
        let R = [[0.128, -0.7], [0.113, -0.755], [0.104, -0.785], [0.082, -0.7975], [0.03, -0.797], [-0.03, -0.79], [-0.075, -0.787]];
        l.add(cu(T1(1, R.length - 1, (C, L, A) => A.set(_ * 0.12 + (C - 0.5) * 0.03, R[L][0], R[L][1]))), x);
      }
    });
    for (let E of [-1, 1]) {
      l.add(zs(0.03, 4e-3, 0.06), p, [E * 0.3125, 0.317, u]), l.add(zs(5e-3, 0.026, 0.03), p, [E * 0.2935, 0.326, u]), l.add(ks(55e-4, 55e-4, 0.05, 8), p, [E * 0.283, d - 4e-3, u], [0, 0, Or]);
      let _ = new THREE.Shape();
      _.moveTo(-0.93, 0.287), _.lineTo(-0.63, 0.287), _.lineTo(-0.63, 0.31), _.lineTo(-0.645, 0.319);
      for (let R of [-0.715, -0.775, -0.835, -0.895]) _.lineTo(R + 0.013, 0.319), _.lineTo(R + 4e-3, 0.305), _.lineTo(R - 6e-3, 0.305), _.lineTo(R - 0.013, 0.319);
      _.lineTo(-0.93, 0.319), _.closePath(), l.add(pe(Wm(_, 0.022, 0), 40), m, [E * 0.279, 0, 0], null, null, "z");
    }
    let T = d + f * 0.5 - 0.038 * h, S = u - h * 0.5 - 0.038 * f;
    return l.add(lc([[-0.27, T, S], [-0.27, 0.312, -0.775], [0.27, 0.312, -0.775], [0.27, T, S]], 6e-3, 0.022, 6, false, 3), p), l.at([0, 0.3725, 0.37], null, null, () => w(0.6, 0.082, 1.22, 18, [-0.194, 0.194], [-0.388, 0, 0.388].flatMap((E) => [[-0.136, E], [0.136, E]]), 11, true)), l.add(c$(0.062, 0.46), o2.velvetTeal, [0, 0.4745, 0.8], [0, 0.04, 0]), l.add(T1(16, 1, (E, _, R) => {
      let C = 0.9 + E / 16 * Vt, L = (0.062 - 9e-3 + 9e-3 * E / 16) * 1.02 + 15e-4;
      R.set((_ - 0.5) * 0.05, Math.max(Math.cos(C) * L, -0.06), Math.sin(C) * L);
    }), x, [0, 0.4745, 0.8], [0, 0.04, 0]), rs("sunLounger", [0.68, 0.82, 2], { surf: "wood", mass: 22, colliders: [$s(-0.34, 0, -1, 0.34, 0.42, 1), $s(-0.34, 0.42, -0.98, 0.34, 0.78, -0.4)] });
  }), e("parasol", (l) => l.open === false ? "c" : "o", (l, c) => {
    let h = c.open !== false, f = o2.woodLight, u = o2.steel, d = o2.fabricCream, m = o2.rubber, p = 8, x = 2.58, g = 2.165, b = 0.03, v = 1.49;
    l.add(pe(ke([[0.266, 0], [0.278, 8e-3], [0.28, 0.022], [0.277, 0.06], [0.264, 0.076], [0.24, 0.084], [0.07, 0.096]], 26), 32), o2.concrete), l.add(pe(ke([[0.078, 0.094], [0.078, 0.101], [0.074, 0.105], [0.037, 0.105], [0.037, 0.3], [0.034, 0.305], [0.0235, 0.305]], 14), 40), u);
    let y = ke([[0, 45e-4], [6e-3, 35e-4], [8e-3, 0]], 6);
    for (let z = 0; z < 4; z++) {
      let k = (z + 0.5) * Or;
      l.add(y, u, [Math.sin(k) * 0.06, 0.105, Math.cos(k) * 0.06]);
    }
    l.rod(u, [0.03, 0.235, 0], [0.066, 0.235, 0], 5e-3, 6), l.add(pe(ke([[0, 0], [0.017, 0], [0.023, 4e-3], [0.023, 0.014], [0.016, 0.02], [0, 0.021]], 7), 40), m, [0.058, 0.235, 0], [0, 0, -Or]);
    for (let z of [-1, 1]) l.add(lc([[-0.05, 0.08, 0], [-0.05, 0.122, 0], [0.05, 0.122, 0], [0.05, 0.08, 0]], 55e-4, 0.016, 5, false, 2), u, [0, 0, z * 0.172]);
    l.add(ks(0.0235, 0.0235, 2.28, 12, true), f, [0, 1.44, 0], null, null, "y"), l.add(pe(ke([[0.0235, -0.05], [0.027, -0.045], [0.027, 0.045], [0.0235, 0.05]], 12), 40), u, [0, 1.3, 0]);
    for (let z of [1.275, 1.325]) l.add(y, u, [0.027, z, 0], [0, 0, -Or]);
    l.add(Te(0.07, 0.125, 0.086, 0.014), u, [0, 0.8, 0.01]), l.add(ks(0.012, 0.012, 0.012, 8), u, [0, 0.79, 0.058], [Or, 0, 0]), l.add(Te(0.016, 0.092, 7e-3, 3e-3), u, [0.022, 0.76, 0.068], [0, 0, 0.65]), l.add(pe(ke([[0, 0], [9e-3, 0], [0.012, 4e-3], [0.0125, 0.05], [9e-3, 0.056], [0, 0.056]], 8), 40), m, [0.046, 0.729, 0.071], [Or, 0, 0]), l.add(pe(ke([[0.03, 2.6], [0.035, 2.607], [0.035, 2.616], [0.02, 2.628], [0.017, 2.642], [0.03, 2.66], [0.031, 2.672], [0.018, 2.695], [7e-3, 2.707], [3e-3, 2.71], [0, 2.71]], 12), 35), f);
    let M = (z) => x - (x - g) * (z - b) / (v - b), w = (z) => {
      let k = z / p * Vt;
      return [Math.sin(k), Math.cos(k)];
    }, T = Te(0.036, 0.062, 0.03, 6e-3);
    if (h) {
      l.add(Qo([[0.012, 0.862, 0.03], [0.026, 1.2, 0.012], [0.034, 1.95 - 0.06, 6e-3]], 24e-4, 3, false, false), d), l.add(pe(ke([[0.0235, 2.535], [0.04, 2.54], [0.052, 2.555], [0.052, 2.575], [0.044, 2.582], [0.044, 2.594], [0.03, 2.6]], 12), 40), f), l.add(pe(ke([[0.0235, -0.045], [0.036, -0.045], [0.04, -0.038], [0.04, -0.016], [0.052, -8e-3], [0.052, 0.014], [0.044, 0.02], [0.044, 0.034], [0.0235, 0.04]], 12), 40), f, [0, 1.95, 0]), l.add(Sa(0.053, 28e-4, 4, 16), u, [0, 1.95 + 3e-3, 0], [Or, 0, 0]);
      let k = new THREE.Vector3(), I = new THREE.Vector3(), G = De(0, 1, 0);
      for (let e0 = 0; e0 < p; e0++) {
        let [p0, t0] = w(e0);
        k.set(p0 * b, x, t0 * b), I.set(p0 * v, g, t0 * v);
        let M0 = I.clone().sub(k), f0 = M0.length();
        l.addM(B9(0.02, 0.016, f0), f, rc(k, M0, G), true), l.addM(T, d, rc(k.clone().addScaledVector(M0, (f0 - 0.022) / f0), M0, G));
        let _0 = 0.72, F0 = De(p0 * _0, M(_0) - 0.011, t0 * _0), m0 = De(p0 * 0.04, 1.95 + 3e-3, t0 * 0.04), S0 = F0.clone().sub(m0);
        l.addM(B9(0.017, 0.013, S0.length()), f, rc(m0, S0, G), true), l.addM(zs(0.026, 0.034, 0.024), u, rc(F0.clone().addScaledVector(S0, -0.012 / S0.length()), M0, G));
      }
      let K = (e0, p0, t0) => {
        let [M0, f0] = w(e0);
        return t0.set(M0 * p0, M(p0), f0 * p0);
      }, $ = (e0, p0, t0, M0, f0, _0, F0, m0 = 1) => T1(f0, M0, (S0, T0, j0) => {
        let Z0 = T0 / M0, lt = S0 / f0, H0 = p0 + (t0 - p0) * Z0, Y0 = 4 * lt * (1 - lt);
        K(e0, H0, k), K(e0 + 1, H0, I), j0.lerpVectors(k, I, lt), j0.y = x + (j0.y - x) * m0 + F0 - _0 * Math.pow(Z0, 1.25) * Y0;
        let et = 1 - 0.022 * Y0 * Math.pow(Z0, 5);
        j0.x *= et, j0.z *= et;
      }, { flip: true }), n0 = [];
      for (let e0 = 0; e0 < p; e0++) {
        let p0 = $(e0, 0.25, 1.5, 7, 8, 0.06, 0.011), t0 = p0.attributes.position, M0 = 7 * 9;
        n0.push(p0), n0.push(T1(16, 1, (F0, m0, S0) => {
          let T0 = M0 + (F0 >> 1), j0 = M0 + (F0 + 1 >> 1), Z0 = F0 / 16;
          if (S0.set((t0.getX(T0) + t0.getX(j0)) / 2, (t0.getY(T0) + t0.getY(j0)) / 2, (t0.getZ(T0) + t0.getZ(j0)) / 2), m0) {
            let lt = 1 + (4e-3 + 7e-3 * Math.sin(Z0 * 9.4 + e0 * 2.1)) / 1.45;
            S0.x *= lt, S0.z *= lt, S0.y -= 0.088 + 0.04 * Math.pow(Math.abs(Math.sin(3 * jm * Z0)), 0.7);
          }
        }, { flip: true }));
        let f0 = $(e0, 0.026, 0.37, 2, 3, 0.012, 0.046, 0.86), _0 = f0.attributes.position;
        n0.push(f0), n0.push(T1(3, 1, (F0, m0, S0) => {
          let T0 = 8 + F0;
          S0.set(_0.getX(T0), _0.getY(T0) - m0 * 0.032, _0.getZ(T0)), m0 && (S0.x *= 1.004, S0.z *= 1.004);
        }, { flip: true }));
      }
      return l.add(cu(Vn(n0, false)), d), rs("parasol", [3, 2.71, 3], { surf: "fabric", mass: 35, colliders: [$s(-0.06, 0, -0.06, 0.06, 2.6, 0.06), $s(-0.28, 0, -0.28, 0.28, 0.1, 0.28)] });
    }
    let S = _n(17), E = 2.6, _ = 1, R = 1.56, C = 32, L = 16, A = (z) => Math.atan2(0.78 * Math.sin(z), 1 - 0.78 * Math.cos(z)) / 0.895, O = (z) => {
      let k = (E - z) / (E - _), I = 0.03 + 0.105 * Math.pow(k, 0.8) + 0.018 * Fo(0.86, 1, k);
      return I += 0.012 * Math.exp(-Math.pow((z - 2.42) / 0.035, 2)) * (z < 2.42 ? 0.3 : 1), I * (1 - 0.3 * Math.exp(-Math.pow((z - R) / 0.085, 2)));
    }, H = (z, k, I, G = 0) => {
      let K = (E - k) / (E - _), $ = z / C * Vt, n0 = $ * p + 2.4 * K + 0.6 * Math.sin(K * 5), e0 = (0.1 + 0.3 * K) * (1 - 0.7 * Math.exp(-Math.pow((k - R) / 0.07, 2))), p0 = O(k) * (1 + e0 * A(n0)) + (S.fbm($ * 3 + 2, k * 6, 2) - 0.5) * 0.012 * K + G;
      return I.set(Math.sin($) * p0, k, Math.cos($) * p0);
    }, F = [...Array(L + 1)].map((z, k) => Ht(E, _, Math.pow(k / L, 0.92)));
    F[2] = 2.42, F[10] = R, F.sort((z, k) => k - z);
    let P = (z) => 0.03 * Math.cos(z / C * Vt * p + 2.4) - 0.012;
    l.add(T1(C, L, (z, k, I) => {
      H(z, F[k], I), k === L && (I.y += P(z));
    }, { wrapU: true, flip: true }), d), l.add(T1(C, 1, (z, k, I) => {
      k ? I.set(0, _ + 0.2, 0) : (H(z, _, I), I.y += P(z));
    }, { wrapU: true, flip: true }), d), l.add(T1(C, 1, (z, k, I) => H(z, R + (k ? -0.02 : 0.02), I, 4e-3), { wrapU: true, flip: true }), d);
    {
      let z = H(4, R, new THREE.Vector3(), 6e-3);
      l.add(Te(0.034, 0.046, 8e-3, 3e-3), u, [z.x, z.y, z.z], [0, Math.atan2(z.x, z.z), 0]), l.add(cu(T1(1, 3, (k, I, G) => G.set(z.x * (1 + 0.03 * I) + (k - 0.5) * 0.03, R - 0.01 - I * 0.045, z.z * (1.02 + 0.05 * I) + 0.012))), d);
    }
    for (let z = 0; z < p; z++) {
      let k = (z + 0.3) / p * Vt, I = Math.sin(k), G = Math.cos(k), K = De(I * 0.07, 1.4, G * 0.07), $ = De(I * 0.105, 1.062, G * 0.105).sub(K);
      l.addM(B9(0.02, 0.016, $.length()), f, rc(K, $, De(I, 0, G)), true), l.addM(T, d, rc(K.clone().addScaledVector($, 1 - 0.02 / $.length()), $, De(I, 0, G)));
    }
    return l.add(pe(ke([[0.0235, 2.56], [0.034, 2.585], [0.03, 2.6]], 10), 40), f), rs("parasol", [0.56, 2.71, 0.56], { surf: "fabric", mass: 35, colliders: [$s(-0.1, 0, -0.1, 0.1, 2.6, 0.1), $s(-0.28, 0, -0.28, 0.28, 0.1, 0.28)] });
  });
  function r(l, c, h, f, { r: u = 0.06, nx: d = 24, nz: m = 20, ne: p = 7, quilt: x = 0, cellsX: g = 6, cellsZ: b = 5, seed: v = 5, fold: y = 0.016, foot: M = true, rumple: w = 0.01 } = {}) {
    let T = jm * u / 2, S = _n(v), E = [], _ = [];
    for (let C = p; C >= 1; C--) E.push(-l - (T + f) * Math.pow(C / p, 1.2));
    for (let C = 0; C <= d; C++) E.push(-l + 2 * l * C / d);
    for (let C = 1; C <= p; C++) E.push(l + (T + f) * Math.pow(C / p, 1.2));
    for (let C = 0; C <= m; C++) _.push(c + (h - c) * C / m);
    if (M) for (let C = 1; C <= p; C++) _.push(h + (T + f) * Math.pow(C / p, 1.2));
    let R = (C) => C <= 0 ? [0, 0] : C < T ? [u * Math.sin(C / u), u * (1 - Math.cos(C / u))] : [u, u + C - T];
    return T1(E.length - 1, _.length - 1, (C, L, A) => {
      let O = E[C], H = _[L], F = R(Math.abs(O) - l), P = R(M ? H - h : -1), z = Math.max(F[1], P[1]), k = Zt((z - u) / f, 0, 1), I = Math.sign(O) * (Math.min(Math.abs(O), l) + F[0]), G = Math.min(H, M ? h : H) + P[0], K = -z;
      if (z <= 1e-6) {
        let $ = Math.abs(Math.sin(jm * (I + l) / (2 * l) * g)), n0 = Math.abs(Math.sin(jm * (G - c) / (h - c) * b));
        K += x * Math.pow($ * n0, 0.45) + (S.fbm(I * 1.7 + 3, G * 1.7, 3) - 0.5) * 2 * w;
      } else {
        let $ = F[1] > P[1], n0 = $ ? G : I, e0 = y * k * (0.55 + 0.9 * S.noise(n0 * 2.3 + 1.7, v * 1.3)), p0 = Math.sin(n0 * 8.5 + S.fbm(n0 * 1.4 + 7, 1.5, 2) * 7) * e0 + e0 * 0.6 + 0;
        if ($ ? I += Math.sign(O) * p0 : G += p0, F[1] > 0 && P[1] > 0) {
          let t0 = Math.min(F[1], P[1]) / (u + f);
          I -= Math.sign(O) * 0.07 * t0, G -= 0.07 * t0;
        }
      }
      A.set(I, K, G);
    }, { flip: true });
  }
  e("bed", null, (l) => {
    let c = o2.woodDark, h = o2.bedLinen, f = o2.fabricCharcoal, u = o2.velvetTeal, d = o2.brass;
    l.add(zs(1.9, 0.05, 1.98), c, [0, 0.025, 0]), l.add(_i([[-0.03, 0], [0, 0], [0, 0.012], [-4e-3, 0.016], [-4e-3, 0.2], [0, 0.204], [0, 0.238], [-6e-3, 0.25], [-0.03, 0.25]], [[-1.01, 0.05, 1.05], [1.01, 0.05, 1.05], [1.01, 0.05, -1.05], [-1.01, 0.05, -1.05]], { deg: 40 }), c, null, null, null, "x"), l.add(zs(1.97, 0.02, 2.05), c, [0, 0.288, 0]), l.add(_i([[-35e-4, 0], [12e-4, 0], [12e-4, 8e-3], [-35e-4, 8e-3]], [[-1.006, 0.262, 1.046], [1.006, 0.262, 1.046], [1.006, 0.262, -1.046], [-1.006, 0.262, -1.046]], { deg: 60 }), d);
    for (let p of [-1, 1]) l.add(Te(0.05, 0.07, 0.05, 4e-3), d, [p * 0.992, 0.086, 1.032]);
    l.add(Jo(1.94, 0.25, 2.02, { r: 0.06, seg: [6, 1, 6], arc: 4, crown: { py: 0.01 }, plateau: 4, lump: 2e-3, seed: 2 }), h, [0, 0.42, 0]), l.add(Id(1.94, 0.25, 2.02, 0.06, "tb", 5e-3, 4, 4), h, [0, 0.42, 0]), l.add(r(0.985, -0.34, 1.02, 0.2, { r: 0.06, quilt: 0.013, seed: 5, fold: 0.017 }), h, [0, 0.6, 0]), l.add(Jo(2.07, 0.058, 0.3, { r: 0.0285, seg: [14, 1, 3], arc: 4, crown: { py: 9e-3 }, lump: 9e-3, lumpScale: 3.2, seed: 9 }), h, [0, 0.606, -0.4], [0.035, 0, 0]), l.add(Jo(2.09, 0.02, 0.17, { r: 9e-3, seg: [12, 1, 2], arc: 2, crown: { py: 3e-3 }, lump: 3e-3, lumpScale: 5, seed: 12 }), h, [0, 0.642, -0.335], [0.02, 4e-3, 0]);
    for (let p of [-1, 1]) l.add(Jo(0.02, 0.2, 0.3, { r: 9e-3, seg: [1, 3, 3], arc: 2, lump: 4e-3, seed: 14 + p }), h, [p * 1.043, 0.52, -0.4], [0, 0, p * 0.05]);
    l.add(r(0.992, 0.42, 0.94, 0.3, { r: 0.068, nx: 20, nz: 6, ne: 6, seed: 21, fold: 0.012, foot: false, rumple: 4e-3 }), f, [0, 0.63, 0]);
    for (let p of [0.42, 0.94]) l.add(Qo([[-0.99, 0.631, p], [-0.5, 0.633, p + 4e-3], [0, 0.631, p - 3e-3], [0.5, 0.633, p + 3e-3], [0.99, 0.631, p]], 6e-3, 5), f);
    for (let p of [-1, 1]) {
      let x = Db(0.74, 0.48, 0.2, { nu: 12, nv: 10, plump: 2.3, pinch: 0.035, lump: 6e-3, seed: 30 + p, sag: 0.25, npuck: 7, pucker: 0.14 }), g = [p * 0.47, 0.775, -0.905], b = [-0.36, p * 0.03, p * -0.015];
      l.add(x, h, g, b), l.add(l$(x, 0.045, 4e-3), h, g, b);
      let v = Db(0.46, 0.46, 0.17, { nu: 10, plump: 2.4, pinch: 0.05, lump: 6e-3, seed: 40 + p, sag: 0.2, npuck: 5, pucker: 0.18 }), y = [p * 0.34, 0.76, -0.72], M = [-0.52, p * 0.14, p * 0.03];
      l.add(v, u, y, M), l.add(yw(v, 45e-4, 4), u, y, M);
    }
    {
      let p = Db(0.7, 0.3, 0.15, { nu: 12, nv: 7, plump: 2.6, pinch: 0.03, lump: 4e-3, seed: 50, sag: 0.15, npuck: 6, pucker: 0.12 });
      l.add(p, f, [0, 0.768, -0.585], [-0.62, 0, 0]), l.add(yw(p, 45e-4, 4), f, [0, 0.768, -0.585], [-0.62, 0, 0]);
    }
    l.add(Te(2.24, 1.2, 0.05, 8e-3), c, [0, 0.62, -1.165], null, null, "x");
    let m = [];
    for (let p = 0; p <= 4; p++) for (let x = 0; x <= 8; x++) (x + p) % 2 === 0 && p > 0 && p < 4 && x > 0 && x < 8 && m.push([-1.016 + x * 0.254, -0.448 + p * 0.224]);
    l.add(Jo(2.13, 0.996, 0.1, { r: 0.05, seg: [16, 8, 1], arc: 4, crown: { pz: 0.014 }, plateau: 5, lump: 2e-3, seed: 60, sculpt: (p, x) => {
      x.z > 0.3 && (p.z -= 0.026 * rw(p.x, p.y, m, 0.085));
    } }), f, [0, 0.715, -1.095]), l.add(Id(2.13, 0.996, 0.1, 0.05, "f", 55e-4, 5, 4), f, [0, 0.715, -1.095]);
    for (let [p, x] of m) l.add(dr(0.014, 7, 4), f, [p, 0.715 + x, -1.0535], null, [1, 1, 0.5]);
    return l.add(_i([[-0.028, -0.062], [0.028, -0.062], [0.028, 0.055], [0.022, 0.062], [-0.022, 0.062], [-0.028, 0.055]], [[-1.092, 0.02, -1.118], [-1.092, 1.222, -1.118], [1.092, 1.222, -1.118], [1.092, 0.02, -1.118]], { closed: false, up: De(0, 0, 1), deg: 40 }), c, null, null, null, "y"), l.add(Te(2.24, 0.03, 0.15, 6e-3), c, [0, 1.235, -1.115], null, null, "x"), rs("bed", [2.24, 1.25, 2.38], { surf: "fabric", mass: 140, colliders: [$s(-1.03, 0, -1.05, 1.03, 0.64, 1.05), $s(-1.12, 0, -1.19, 1.12, 1.25, -1.03)] });
  });
}
var hl = Math.PI, Hi = hl / 2, AD = 1024, kD = 1024, Ko = (o2, t = 20, e = 38) => pe(ke(o2, t), e), e2 = (o2, t, e, s) => hu(o2 + 1, t + 1, e - 2, s - 2, AD, kD), cl = { cartonA: e2(0, 0, 320, 224), cartonB: e2(320, 0, 320, 224), tinA: e2(640, 0, 384, 128), tinB: e2(640, 128, 384, 128), gauge: e2(0, 232, 128, 128), label: e2(128, 232, 192, 256), wet: e2(320, 232, 256, 512), dial: e2(576, 264, 96, 96), plate: e2(576, 360, 160, 64), ctrl: e2(576, 424, 224, 64), kraft: e2(800, 264, 64, 64) }, vw = (o2, t) => {
  let e = o2.attributes.uv;
  for (let s = 0; s < e.count; s++) e.setXY(s, t[0] + (t[2] - t[0]) * e.getX(s), t[1] + (t[3] - t[1]) * e.getY(s));
  return o2;
};
function h$() {
  let o2 = we(AD, kD), t = o2.getContext("2d"), e = Re(515), s = '"Segoe UI", Arial, sans-serif', n = 'Bahnschrift, "Arial Narrow", "Segoe UI", sans-serif', i = (a, r, l, c, h = "#111", f = "center") => {
    t.font = c, t.fillStyle = h, t.textAlign = f, t.textBaseline = "middle", t.fillText(a, r, l);
  };
  for (let [a, r, l] of [[0, "HALCYON", "PROVISIONS  \xB7  12 \xD7 750 ml"], [320, "ORBITAL", "DRY GOODS  \xB7  KEEP DRY"]]) {
    t.fillStyle = "#a9824f", t.fillRect(a, 0, 320, 224);
    for (let c = 0; c < 900; c++) t.fillStyle = `rgba(${60 + e() * 60 | 0},${40 + e() * 40 | 0},20,${0.04 + e() * 0.07})`, t.fillRect(a + e() * 320, e() * 224, 6 + e() * 26, 1);
    t.fillStyle = "rgba(214,190,140,0.9)", t.fillRect(a, 96, 320, 30), t.fillStyle = "rgba(60,40,20,0.25)", t.fillRect(a, 96, 320, 1.5), t.fillRect(a, 125, 320, 1.5), i(r, a + 160, 44, `800 34px ${n}`, "#2a1c10"), i(l, a + 160, 74, `600 13px ${s}`, "#2a1c10"), t.strokeStyle = "#2a1c10", t.lineWidth = 2.5;
    for (let c of [a + 36, a + 66]) t.beginPath(), t.moveTo(c, 204), t.lineTo(c, 150), t.moveTo(c - 10, 162), t.lineTo(c, 148), t.lineTo(c + 10, 162), t.stroke();
    t.strokeRect(a + 22, 140, 60, 70), t.strokeRect(a + 236, 140, 60, 70), t.beginPath(), t.moveTo(a + 254, 150), t.lineTo(a + 278, 150), t.lineTo(a + 272, 176), t.lineTo(a + 260, 176), t.closePath(), t.moveTo(a + 266, 176), t.lineTo(a + 266, 198), t.moveTo(a + 254, 200), t.lineTo(a + 278, 200), t.stroke(), i("FRAGILE", a + 160, 176, `800 20px ${n}`, "#2a1c10");
  }
  t.fillStyle = "#a9824f", t.fillRect(800, 264, 64, 64);
  for (let [a, r, l, c, h] of [[0, "#a8261a", "#f4e6c4", "POMODORO", "pelati \xB7 2,5 kg"], [128, "#e9dcb6", "#1f4a3a", "OLIVE VERDI", "in salamoia \xB7 2 kg"]]) {
    t.fillStyle = "#b9bcc0", t.fillRect(640, a, 384, 128), t.fillStyle = r, t.fillRect(640, a + 14, 384, 100);
    for (let f of [736, 928]) t.fillStyle = l, t.beginPath(), t.ellipse(f, a + 64, 78, 40, 0, 0, Vt), t.fill(), i(c, f, a + 58, `800 22px ${n}`, r), i(h, f, a + 80, `600 11px ${s}`, r);
    t.fillStyle = "rgba(0,0,0,0.25)";
    for (let f = 0; f < 8; f++) t.fillRect(640, a + 2 + f * 1.5 * (f % 2), 384, 1);
  }
  t.fillStyle = "#16171a", t.fillRect(0, 232, 128, 128), t.fillStyle = "#f2efe6", t.beginPath(), t.arc(64, 296, 56, 0, Vt), t.fill(), t.lineWidth = 12, t.strokeStyle = "#c0261c", t.beginPath(), t.arc(64, 296, 40, hl * 0.8, hl * 1.25), t.stroke(), t.strokeStyle = "#2a9a44", t.beginPath(), t.arc(64, 296, 40, hl * 1.25, hl * 1.75), t.stroke(), t.strokeStyle = "#c0261c", t.beginPath(), t.arc(64, 296, 40, hl * 1.75, hl * 2.2), t.stroke(), t.strokeStyle = "#111", t.lineWidth = 4, t.beginPath(), t.moveTo(64, 296), t.lineTo(64 + Math.cos(hl * 1.5 + 0.12) * 44, 296 + Math.sin(hl * 1.5 + 0.12) * 44), t.stroke(), t.fillStyle = "#111", t.beginPath(), t.arc(64, 296, 6, 0, Vt), t.fill(), i("bar", 64, 326, `700 12px ${s}`);
  {
    t.fillStyle = "#f3f0e8", t.fillRect(128, 232, 192, 256), t.fillStyle = "#b3160f", t.fillRect(128, 232, 192, 52), i("FIRE", 224, 252, `800 26px ${n}`, "#fff"), i("ABC POWDER  6 kg", 224, 273, `700 12px ${s}`, "#fff");
    for (let l = 0; l < 3; l++) {
      let c = 296 + l * 46;
      t.fillStyle = "#b3160f", t.fillRect(138, c, 38, 38), i(String(l + 1), 157, c + 20, `800 24px ${n}`, "#fff"), i(["PULL THE PIN", "AIM AT THE BASE", "SQUEEZE \xB7 SWEEP"][l], 184, c + 12, `800 13px ${n}`, "#111", "left"), t.fillStyle = "#555", t.fillRect(184, c + 23, 118, 2), t.fillRect(184, c + 29, 92, 2);
    }
    for (let [l, c, h] of [[0, "A", "#2a9a44"], [1, "B", "#c0261c"], [2, "C", "#2a5aa8"]]) t.fillStyle = h, t.fillRect(140 + l * 58, 438, 50, 40), i(c, 165 + l * 58, 459, `800 26px ${n}`, "#fff");
  }
  t.fillStyle = "#e9b20e", t.fillRect(320, 232, 256, 512), i("CAUTION", 448, 302, `800 50px ${n}`, "#15120a"), t.fillStyle = "#15120a", t.beginPath(), t.moveTo(448, 350), t.lineTo(546, 528), t.lineTo(350, 528), t.closePath(), t.fill(), t.fillStyle = "#e9b20e", t.beginPath(), t.moveTo(448, 382), t.lineTo(518, 512), t.lineTo(378, 512), t.closePath(), t.fill(), t.strokeStyle = "#15120a", t.fillStyle = "#15120a", t.lineWidth = 9, t.lineCap = "round", t.beginPath(), t.arc(470, 420, 9, 0, Vt), t.fill(), t.beginPath(), t.moveTo(462, 436), t.lineTo(438, 468), t.lineTo(412, 482), t.moveTo(438, 468), t.lineTo(460, 494), t.moveTo(456, 444), t.lineTo(432, 438), t.moveTo(458, 446), t.lineTo(482, 460), t.stroke(), t.lineWidth = 4, t.beginPath(), t.moveTo(398, 504), t.lineTo(498, 504), t.stroke(), i("WET", 448, 588, `800 64px ${n}`, "#15120a"), i("FLOOR", 448, 652, `800 64px ${n}`, "#15120a"), i("PISO MOJADO  \xB7  SOL MOUILL\xC9", 448, 708, `700 13px ${s}`, "#15120a");
  {
    t.fillStyle = "#0c0c0d", t.fillRect(576, 264, 96, 96), t.strokeStyle = "#e8e4da", t.lineWidth = 2;
    for (let l = 0; l <= 8; l++) {
      let c = hl * 0.75 + l / 8 * hl * 1.5;
      t.beginPath(), t.moveTo(624 + Math.cos(c) * 36, 312 + Math.sin(c) * 36), t.lineTo(624 + Math.cos(c) * (l % 4 ? 41 : 45), 312 + Math.sin(c) * (l % 4 ? 41 : 45)), t.stroke();
    }
    i("OFF", 624, 352, `700 10px ${s}`, "#e8e4da"), t.fillStyle = "#c0261c", t.beginPath(), t.arc(660, 282, 3, 0, Vt), t.fill(), t.fillStyle = "#c9ccd0", t.fillRect(576, 360, 160, 64), t.strokeStyle = "#333", t.lineWidth = 1.5, t.strokeRect(580, 364, 152, 56), i("VULCANO", 656, 380, `800 20px ${n}`, "#222"), i("MOD. 6B-90   GAS  G20   24 kW", 656, 400, `600 8px ${s}`, "#222"), i("N\xB0 47-01193", 656, 412, `600 8px ${s}`, "#222"), t.fillStyle = "#0b0c0e", t.fillRect(576, 424, 224, 64), i("\xB0C", 668, 456, `700 20px ${s}`, "#9fb4c4", "left");
    for (let l = 0; l < 3; l++) t.strokeStyle = "#8a8f96", t.lineWidth = 2, t.strokeRect(704 + l * 30, 444, 22, 22), i(["\u25B2", "\u25BC", "\u2744"][l], 715 + l * 30, 456, `600 12px ${s}`, "#c8ccd2");
    i("POLAR 1300", 600, 476, `700 9px ${s}`, "#8a8f96", "left");
  }
  return ll(o2);
}
function CD({ M: o2, def: t, lib: e }) {
  let s = () => e("serviceAtlas", () => new THREE.MeshStandardMaterial({ map: h$(), roughness: 0.62, metalness: 0 })), n = () => e("yellow", () => new THREE.MeshStandardMaterial({ color: 15315470, roughness: 0.55 })), i = () => e("red", () => new THREE.MeshStandardMaterial({ color: 11015182, roughness: 0.28, metalness: 0.15 })), a = o2.steel, r = o2.chrome, l = o2.blackMetal, c = (u, d, m, p = 0.1, x = 0.02) => u.add(Ko([[0, 0], [x * 0.9, 0], [x * 1.1, 4e-3], [x * 1.1, 0.014], [x * 0.6, 0.02], [x * 0.6, 0.034], [x, 0.038], [x, p]], 10), a, [d, 0, m]), h = (u, d, m, p, x, g = 7e-3) => {
    u.add(ks(g, g, x, 8), r, [d, m, p + 0.03], [0, 0, Hi]);
    for (let b of [-1, 1]) u.add(ks(g * 0.8, g * 0.8, 0.03, 6), r, [d + b * (x / 2 - 0.02), m, p + 0.015], [Hi, 0, 0]);
  }, f = (u, d, m, p) => {
    u.add(ks(6e-3, 6e-3, 0.05, 6), a, [d, m, p]), u.add(zs(0.022, 0.044, 3e-3), a, [d, m, p - 4e-3]);
  };
  t("kitchenCounter", (u) => (u.len || 2).toFixed(2), (u, d) => {
    let m = d.len || 2, p = Math.max(1, Math.round(m / 0.55)), x = m / p, g = m + 0.02;
    u.add(zs(m - 0.04, 0.1, 0.5), l, [0, 0.05, -0.06]);
    for (let b = 0; b <= p; b++) c(u, Zt(-m / 2 + x * b, -m / 2 + 0.04, m / 2 - 0.04), 0.245, 0.1, 0.018);
    u.add(Te(m, 0.78, 0.64, 5e-3), a, [0, 0.49, -0.02], null, null, "y"), u.add(_i([[-0.35, 0.88], [0.336, 0.88], [0.346, 0.884], [0.35, 0.894], [0.35, 0.908], [0.346, 0.917], [0.338, 0.92], [-0.318, 0.92], [-0.328, 0.923], [-0.33, 0.932], [-0.33, 1.036], [-0.334, 1.04], [-0.35, 1.04]], [[-g / 2, 0, 0], [g / 2, 0, 0]], { closed: false, deg: 34 }), a, null, null, null, "x");
    for (let b = 0; b < p; b++) {
      let v = -m / 2 + x * (b + 0.5), y = p > 2 && b % 4 === 1;
      u.add(Te(x - 0.012, 0.15, 0.016, 4e-3), a, [v, 0.785, 0.306], null, null, "x"), u.add(Te(x - 0.012, 0.52, 0.016, 4e-3), a, [v, 0.44, 0.306], null, null, "y"), u.add(zs(x - 0.02, 0.69, 4e-3), l, [v, 0.525, 0.298]), h(u, v, 0.785, 0.314, x * 0.5), h(u, v, 0.66, 0.314, x * 0.5);
      let M = v + (b % 2 ? 1 : -1) * (x / 2 - 0.012);
      if (f(u, M, 0.26, 0.318), f(u, M, 0.62, 0.318), y) for (let w = 0; w < 7; w++) u.add(zs(x * 0.6, 8e-3, 4e-3), l, [v, 0.25 + w * 0.022, 0.3145]);
    }
    return rs("kitchenCounter", [m + 0.02, 1.04, 0.7], { surf: "metal", mass: 60 * m, colliders: [$s(-m / 2, 0, -0.35, m / 2, 0.92, 0.35)] });
  }), t("stove", null, (u) => {
    let d = s();
    for (let m of [-1, 1]) for (let p of [-1, 1]) c(u, m * 0.4, p * 0.32, 0.07, 0.024);
    u.add(Te(0.9, 0.84, 0.76, 6e-3), a, [0, 0.48, 0], null, null, "y"), u.add(Te(0.88, 0.02, 0.62, 4e-3), l, [0, 0.908, 0.05]), u.add(Dl(0.9, 0.66, [[0, 0], [0, 0.012], [4e-3, 0.016], [0.012, 0.016], [0.016, 0.01], [0.016, 0]]).rotateX(-Hi), a, [0, 0.905, 0.05]);
    for (let m = 0; m < 6; m++) {
      let p = (m % 3 - 1) * 0.28, x = m < 3 ? -0.1 : 0.2;
      u.add(Ko([[0, 0], [0.05, 0], [0.056, 4e-3], [0.056, 8e-3], [0.044, 0.012], [0.044, 0.016], [0.036, 0.02], [0.03, 0.02], [0.03, 0.017], [0, 0.017]], 14), l, [p, 0.918, x]), u.add(Sa(0.071, 5e-3, 4, 16), l, [p, 0.924, x], [Hi, 0, 0]);
      for (let g of [0, Hi, hl, -Hi]) u.at([p, 0, x], [0, g, 0], () => {
        u.add(zs(0.012, 0.016, 0.085), l, [0, 0.937, 0.085]), u.add(zs(0.262, 0.014, 0.012), l, [0, 0.932, 0.126]);
      });
    }
    u.add(Te(0.9, 0.1, 0.035, 8e-3), a, [0, 0.84, 0.392], [-0.25, 0, 0], null, "x");
    for (let m = 0; m < 7; m++) u.at([-0.36 + m * 0.12, 0.84, 0.4095], [Hi - 0.25, 0, 0], () => {
      u.add(vw(new THREE.CircleGeometry(0.03, 16), cl.dial).rotateX(-Hi), d, [0, 6e-4, 0], null, null, true), u.add(Ko([[0.021, 1e-3], [0.023, 6e-3], [0.0215, 0.024], [0.018, 0.028], [0, 0.028]], 12), l), u.add(zs(5e-3, 6e-3, 0.036), a, [0, 0.0285, 0]);
    });
    u.add(Te(0.82, 0.52, 0.022, 6e-3), a, [0, 0.45, 0.387], null, null, "x"), u.add(Dl(0.56, 0.26, [[0, 0], [0, 5e-3], [4e-3, 8e-3], [0.014, 8e-3], [0.02, 3e-3], [0.02, 0]]), a, [0, 0.48, 0.398]), u.add(Te(0.52, 0.22, 6e-3, 2e-3), o2.screenOff, [0, 0.48, 0.399]), u.add(ks(0.011, 0.011, 0.72, 10), r, [0, 0.74, 0.435], [0, 0, Hi]);
    for (let m of [-1, 1]) u.add(Ko([[0.012, 0], [0.012, 4e-3], [75e-4, 8e-3], [75e-4, 0.04]], 8), r, [m * 0.33, 0.74, 0.397], [Hi, 0, 0]), f(u, m * 0.36, 0.2, 0.4);
    for (let m = 0; m < 5; m++) u.add(zs(0.5, 6e-3, 4e-3), l, [0, 0.105 + m * 0.014, 0.3795]);
    u.add(cc(0.085, 0.034, cl.plate), d, [0.33, 0.13, 0.381], null, null, true), u.add(Te(0.9, 0.4, 0.05, 8e-3), a, [0, 1.1, -0.355], null, null, "x");
    for (let m = 0; m < 6; m++) u.add(zs(0.7, 0.01, 4e-3), l, [0, 1 + m * 0.024, -0.3285]);
    u.add(Te(0.9, 0.022, 0.26, 6e-3), a, [0, 1.3, -0.25], null, null, "x");
    for (let m of [-1, 1]) u.add(pe(new THREE.ExtrudeGeometry(new THREE.Shape([oo(0, 0), oo(0.2, 0), oo(0, -0.16)]), { depth: 4e-3, bevelEnabled: false }), 30), a, [m * 0.44 - 2e-3, 1.289, -0.33], [0, -Hi, 0]);
    return rs("stove", [0.9, 1.31, 0.82], { surf: "metal", mass: 150, colliders: [$s(-0.45, 0, -0.38, 0.45, 0.94, 0.4), $s(-0.45, 0.94, -0.38, 0.45, 1.31, -0.3)] });
  }), t("fridge", null, (u) => {
    let d = s();
    for (let m of [-1, 1]) for (let p of [-1, 1]) c(u, m * 0.58, p * 0.32, 0.07, 0.026);
    u.add(Te(1.3, 1.96, 0.76, 0.012), a, [0, 1.04, -0.02], null, null, "y"), u.add(Te(1.24, 0.17, 0.012, 4e-3), l, [0, 1.905, 0.362]);
    for (let m = 0; m < 9; m++) u.add(zs(0.8, 7e-3, 0.016), a, [0.18, 1.838 + m * 0.0165, 0.371], [0.5, 0, 0]);
    u.add(cc(0.21, 0.06, cl.ctrl), d, [-0.4, 1.905, 0.3686], null, null, true), u.add(Te(0.07, 0.03, 4e-3, 1e-3), o2.bulbCool, [-0.47, 1.905, 0.3695]), u.add(zs(1.26, 0.07, 0.01), l, [0, 0.095, 0.362]);
    for (let m of [-1, 1]) {
      u.add(Te(0.63, 1.68, 0.035, 0.012), a, [m * 0.322, 0.97, 0.378], null, null, "y"), u.add(zs(0.618, 1.668, 6e-3), l, [m * 0.322, 0.97, 0.3595]), u.add(ks(0.012, 0.012, 0.62, 10), r, [m * 0.06, 1.1, 0.432]);
      for (let p of [0.83, 1.37]) u.add(Te(0.022, 0.03, 0.045, 5e-3), r, [m * 0.06, p, 0.412]);
      for (let p of [0.24, 0.97, 1.7]) f(u, m * 0.642, p, 0.392);
      u.add(Ko([[0, 0], [9e-3, 0], [9e-3, 4e-3], [6e-3, 6e-3], [0, 6e-3]], 10), r, [m * 0.06, 0.62, 0.3955], [Hi, 0, 0]);
    }
    return u.add(cc(0.09, 0.036, cl.plate), d, [0.5, 1.72, 0.3962], null, null, true), rs("fridge", [1.3, 2.02, 0.84], { surf: "metal", mass: 220, colliders: [$s(-0.65, 0, -0.4, 0.65, 2.02, 0.4)] });
  }), t("shelfRack", null, (u) => {
    let d = s(), m = o2.ceramicWhite;
    for (let g of [-1, 1]) for (let b of [-1, 1]) {
      u.add(ks(0.013, 0.013, 1.78, 8), r, [g * 0.58, 0.93, b * 0.2]), u.add(Ko([[0, 0], [0.016, 0], [0.019, 4e-3], [0.019, 0.012], [8e-3, 0.018], [8e-3, 0.04]], 8), r, [g * 0.58, 0, b * 0.2]), u.add(dr(0.014, 8, 5), r, [g * 0.58, 1.82, b * 0.2], null, [1, 0.7, 1]);
      for (let v of [0.14, 0.64, 1.14, 1.62]) u.add(Ko([[0.013, -0.022], [0.019, -0.016], [0.017, 0.012], [0.013, 0.016]], 6), r, [g * 0.58, v, b * 0.2]);
    }
    for (let g of [0.14, 0.64, 1.14, 1.62]) {
      u.add(Te(1.18, 0.016, 0.42, 4e-3), a, [0, g, 0], null, null, "x");
      for (let b of [-1, 1]) {
        u.rod(r, [-0.58, g + 0.03, b * 0.2], [0.58, g + 0.03, b * 0.2], 5e-3, 6), u.rod(r, [-0.58, g - 0.014, b * 0.205], [0.58, g - 0.014, b * 0.205], 5e-3, 6);
        let v = [];
        for (let y = 0; y <= 12; y++) v.push([-0.56 + y * 0.0933, g + (y % 2 ? 0.028 : -0.012), b * 0.2025]);
        u.add(Qo(v, 28e-4, 3, false, false), r);
      }
      for (let b of [-1, 1]) u.rod(r, [b * 0.58, g + 0.03, -0.2], [b * 0.58, g + 0.03, 0.2], 5e-3, 6);
    }
    let p = (g, b, v, y, M, w, T, S) => {
      let E = new THREE.BoxGeometry(g, b, v), _ = E.attributes.uv;
      for (let R = 0; R < _.count; R++) {
        let C = R >> 2, L = C === 4 || C === 5 ? S : C < 2 ? S === cl.cartonA ? cl.cartonB : cl.cartonA : cl.kraft;
        _.setXY(R, L[0] + (L[2] - L[0]) * _.getX(R), L[1] + (L[3] - L[1]) * _.getY(R));
      }
      u.add(E, d, [y, M, w], [0, T, 0], null, true);
    };
    p(0.42, 0.3, 0.34, -0.3, 0.3, 0, 0, cl.cartonA), p(0.36, 0.24, 0.3, 0.22, 0.27, 0.01, 0.12, cl.cartonB), p(0.3, 0.2, 0.28, 0.32, 1.73, 0, -0.1, cl.cartonA), p(0.34, 0.16, 0.3, -0.28, 1.71, 0.01, 0, cl.cartonB);
    let x = [[0, 0]];
    for (let g = 0; g < 7; g++) x.push([0.127, g * 0.025 + 4e-3], [0.136, g * 0.025 + 0.02]);
    x.push([0, 0.18]);
    for (let g of [-0.4, -0.1]) u.add(Ko(x, 12, 30), m, [g, 0.648, 0]);
    u.add(Ko([[0, 0], [0.14, 0], [0.15, 0.01], [0.15, 0.236], [0.156, 0.24], [0.156, 0.245], [0.146, 0.245], [0.144, 0.02], [0, 0.018]], 18), a, [0.33, 0.648, 0]);
    for (let g of [-1, 1]) u.add(Sa(0.032, 5e-3, 5, 10, hl), a, [0.33 + g * 0.152, 0.84, 0], [Hi, g * Hi, 0]);
    for (let g = 0; g < 7; g++) {
      let b = -0.46 + g * 0.115, v = -0.08 + g % 2 * 0.1;
      u.add(Ko([[0, 0], [0.05, 2e-3], [0.05, 0.128], [0.044, 0.127], [0, 0.127]], 10), a, [b, 1.148, v]), u.add(vw(new THREE.CylinderGeometry(0.0506, 0.0506, 0.1, 10, 1, true), g % 2 ? cl.tinA : cl.tinB), d, [b, 1.213, v], [0, g * 1.3, 0], null, true);
    }
    for (let g = 0; g < 4; g++) u.add(Ko([[0, 0], [0.055, 0], [0.06, 8e-3], [0.06, 0.128], [0.042, 0.146], [0.046, 0.156], [0.046, 0.168], [0, 0.17]], 10), m, [0.1 + g * 0.13, 1.148, 0.1]);
    return rs("shelfRack", [1.2, 1.85, 0.46], { surf: "metal", mass: 70, colliders: [$s(-0.6, 0, -0.23, 0.6, 1.85, 0.23)] });
  }), t("pot", (u) => (u.variant | 0) % 3, (u, d) => {
    let m = (d.variant | 0) % 3, p = (x, g, b, v) => u.add(dr(45e-4, 6, 4), x, [g, b, v]);
    if (m === 0) {
      u.add(Ko([[0, 0], [0.146, 0], [0.152, 3e-3], [0.154, 0.012], [0.16, 0.016], [0.16, 0.214], [0.163, 0.221], [0.167, 0.224], [0.167, 0.2275], [0.161, 0.2275], [0.1545, 0.221], [0.154, 0.026], [0.146, 0.02], [0, 0.02]], 24), a);
      for (let x of [-1, 1]) {
        u.add(lc([[x * 0.156, 0.17, -0.045], [x * 0.196, 0.172, -0.04], [x * 0.196, 0.172, 0.04], [x * 0.156, 0.17, 0.045]], 58e-4, 0.02, 6), a);
        for (let g of [-0.045, 0.045]) u.add(Te(6e-3, 0.022, 0.024, 2e-3), a, [x * 0.161, 0.17, g]), p(a, x * 0.164, 0.17, g);
      }
      return rs("pot", [0.4, 0.23, 0.33], { surf: "metal", dynamic: true, mass: 2.5 });
    }
    return m === 1 ? (u.add(Ko([[0, 0], [0.088, 0], [0.094, 3e-3], [0.096, 0.01], [0.1, 0.014], [0.105, 0.108], [0.109, 0.113], [0.109, 0.116], [0.103, 0.116], [0.0985, 0.11], [0.0945, 0.022], [0.088, 0.018], [0, 0.018]], 20), a), u.add(Te(0.02, 0.03, 0.03, 4e-3), a, [0.108, 0.094, 0]), p(a, 0.119, 0.1, 8e-3), p(a, 0.119, 0.1, -8e-3), u.add(Yi(Jo(0.2, 0.014, 0.026, { r: 6e-3, seg: [5, 1, 1], arc: 2 }), (x) => {
      let g = x.x / 0.2 + 0.5;
      x.z *= 0.75 + 0.5 * g, x.y += 6e-3 * Math.sin(g * hl);
    }), o2.plasticBlack, [0.2, 0.1, 0], [0, 0, 0.12]), u.add(Sa(8e-3, 25e-4, 4, 8), a, [0.303, 0.1135, 0], [0, 0, 0.12]), rs("pot", [0.42, 0.13, 0.22], { surf: "metal", dynamic: true, mass: 1.2 })) : (u.add(Ko([[0, 0], [0.108, 0], [0.118, 3e-3], [0.126, 9e-3], [0.146, 0.044], [0.15, 0.047], [0.15, 0.05], [0.144, 0.05], [0.14, 0.046], [0.121, 0.015], [0.11, 0.012], [0, 0.012]], 24), l), u.add(Yi(Jo(0.2, 0.012, 0.028, { r: 5e-3, seg: [5, 1, 1], arc: 2 }), (x) => {
      let g = x.x / 0.2 + 0.5;
      x.z *= 1.15 - 0.45 * Math.abs(g - 0.6), x.y += 0.014 * g * g;
    }), l, [0.24, 0.057, 0], [0, 0, 0.14]), p(l, 0.152, 0.049, 8e-3), p(l, 0.152, 0.049, -8e-3), rs("pot", [0.5, 0.08, 0.3], { surf: "metal", dynamic: true, mass: 1.4 }));
  }), t("extinguisher", null, (u) => {
    let d = s(), m = i(), p = 0.085;
    u.add(Te(0.1, 0.34, 6e-3, 2e-3), a, [0, -0.02, 3e-3]);
    for (let x of [0.12, -0.16]) u.add(ks(6e-3, 6e-3, 4e-3, 6), l, [0, x, 75e-4], [Hi, 0, 0]);
    return u.add(Te(0.05, 0.03, p - 0.06, 4e-3), a, [0, 0.04, (p - 0.06) / 2 + 4e-3]), u.add(Sa(0.0685, 45e-4, 5, 22), a, [0, 0.04, p], [Hi, 0, 0], [1, 1, 3.2]), u.add(Te(0.03, 0.022, 8e-3, 2e-3), a, [0, 0.04, p + 0.071]), u.add(Ko([[0, -0.214], [0.05, -0.214], [0.058, -0.22], [0.064, -0.22], [0.066, -0.214], [0.066, -0.2], [0.0665, -0.196], [0.0665, 0.086], [0.064, 0.108], [0.056, 0.132], [0.042, 0.152], [0.03, 0.162], [0.024, 0.166], [0.024, 0.18], [0, 0.18]], 22), m, [0, 0, p]), u.add(vw(new THREE.CylinderGeometry(0.0672, 0.0672, 0.17, 12, 1, true, -0.95, 1.9), cl.label), d, [0, -0.045, p], null, null, true), u.add(Ko([[0.024, 0], [0.027, 3e-3], [0.027, 0.012], [0.02, 0.016], [0.02, 0.04], [0.014, 0.046], [0, 0.046]], 8, 30), l, [0, 0.178, p]), u.add(Yi(Jo(0.13, 8e-3, 0.022, { r: 3e-3, seg: [4, 1, 1], arc: 2 }), (x) => {
      let g = x.x / 0.13 + 0.5;
      x.y += 0.012 * g * g;
    }), l, [0.045, 0.228, p], [0, 0, 0.06]), u.add(Yi(Jo(0.12, 8e-3, 0.022, { r: 3e-3, seg: [4, 1, 1], arc: 2 }), (x) => {
      let g = x.x / 0.12 + 0.5;
      x.y += 0.03 * g * g;
    }), l, [0.04, 0.244, p], [0, 0, 0.2]), u.rod(a, [4e-3, 0.234, p - 0.018], [4e-3, 0.234, p + 0.02], 22e-4, 5), u.add(Sa(0.011, 18e-4, 4, 12), a, [4e-3, 0.228, p + 0.03], [0, Hi, 0]), u.add(Ko([[0, 0], [0.017, 0], [0.018, 3e-3], [0.018, 0.012], [0.0155, 0.014]], 14), a, [0, 0.2, p + 0.018], [Hi, 0, 0]), u.add(vw(new THREE.CircleGeometry(0.0155, 14), cl.gauge), d, [0, 0.2, p + 0.0312], null, null, true), u.add(Qo(ra([[-0.02, 0.2, p], [-0.06, 0.204, p + 8e-3], [-0.086, 0.15, p + 0.018], [-0.088, 0.02, p + 0.026], [-0.082, -0.1, p + 0.024], [-0.08, -0.14, p + 0.02]], 14), 8e-3, 6), l), u.add(ks(0.0105, 0.0105, 0.02, 8), a, [-0.03, 0.201, p + 2e-3], [0, 0, Hi]), u.add(Ko([[0.0105, 0.03], [0.0105, 0.012], [0.012, 8e-3], [0.017, -0.03], [0.015, -0.032], [0, -0.03]], 10), l, [-0.08, -0.17, p + 0.02]), u.add(Te(0.016, 0.02, 0.03, 3e-3), l, [-0.073, -0.1, p + 0.012]), rs("extinguisher", [0.19, 0.5, 0.16], { surf: "metal", wall: true, mountY: 1, mass: 9, colliders: [$s(-0.1, -0.24, 0, 0.09, 0.27, 0.16)] });
  }), t("serviceTrolley", null, (u) => {
    let d = o2.brass, m = o2.woodDark, p = o2.fabricCream;
    for (let g of [-1, 1]) for (let b of [-1, 1]) {
      let v = g * 0.42, y = b * 0.22;
      u.add(Ko([[0.0125, 0.1], [0.0125, 0.2], [0.017, 0.204], [0.017, 0.236], [0.0125, 0.24], [0.0125, 0.808], [0.017, 0.812], [0.017, 0.84]], 10), d, [v, 0, y]), u.add(dr(0.04, 12, 8), r, [v, 0.04, y]), u.add(Ko([[0.03, 0.05], [0.034, 0.06], [0.03, 0.078], [0.016, 0.09], [0.014, 0.102]], 12), d, [v, 0, y]);
    }
    u.add(fi(ui(0.88, 0.48, 0.02), 0.022, 4e-3, 3), m, [0, 0.209, 0], null, null, "x"), u.add(Qo(di(0.84, 0.44, 0.02, 0.27, 2), 6e-3, 6, true), d);
    for (let g of [-1, 1]) for (let b of [-0.1, 0.1]) u.rod(d, [g * 0.42, 0.23, b], [g * 0.42, 0.27, b], 4e-3, 5);
    for (let g of [-0.2, 0, 0.2]) for (let b of [-1, 1]) u.rod(d, [g, 0.23, b * 0.22], [g, 0.27, b * 0.22], 4e-3, 5);
    u.add(fi(ui(0.9, 0.5, 0.02), 0.026, 4e-3, 3), m, [0, 0.817, 0], null, null, "x"), u.add(Jo(0.94, 0.02, 0.54, { r: 9e-3, seg: [8, 1, 4], arc: 2, lump: 15e-4, seed: 4 }), p, [0, 0.852, 0]);
    let x = (g, b, v) => cu(Yi(new THREE.PlaneGeometry(g, 0.26, b, 3), (y) => {
      let M = 0.5 - y.y / 0.26, w = Math.pow(Math.abs(y.x) / (g / 2), 3);
      y.z = M * M * (0.014 * Math.sin(y.x * 21 + v) + 9e-3 * Math.sin(y.x * 47 + v * 2) + 0.01 * w) + 4e-3 * M, y.y -= 0.01 * w * M;
    }));
    for (let g of [-1, 1]) u.add(x(0.94, 16, 1 + g), p, [0, 0.73, g * 0.268], [0, g > 0 ? 0 : hl, 0]);
    for (let g of [-1, 1]) u.add(x(0.54, 10, 4 + g), p, [g * 0.468, 0.73, 0], [0, g * Hi, 0]);
    u.add(lc([[-0.42, 0.835, -0.22], [-0.555, 0.955, -0.21], [-0.555, 0.955, 0.21], [-0.42, 0.835, 0.22]], 0.011, 0.05, 7), d), u.add(Ko([[0.17, 0.862], [0.173, 0.864], [0.173, 0.868], [0.166, 0.872], [0.158, 0.9], [0.134, 0.948], [0.096, 0.984], [0.05, 1.006], [0.016, 1.014], [0, 1.015]], 24, 30), r, [0.18, 0, 0]), u.add(Ko([[6e-3, 1.012], [6e-3, 1.022], [0.014, 1.028], [0.016, 1.036], [0.01, 1.044], [0, 1.045]], 12), d, [0.18, 0, 0]), u.add(Ko([[0, 0.862], [0.066, 0.862], [0.072, 0.866], [0.1, 1.036], [0.104, 1.044], [0.104, 1.05], [0.097, 1.05], [0.094, 1.04], [0.067, 0.878], [0, 0.876]], 18), r, [-0.24, 0, 0.04]);
    for (let g of [-1, 1]) u.add(Sa(0.018, 35e-4, 5, 10), r, [-0.24 + g * 0.106, 1, 0.04], [0, 0, 0]);
    return u.at([-0.228, 0.885, 0.032], [0.2, 0, -0.26], () => {
      u.add(Ko([[0, 0], [0.036, 0], [0.036, 0.06], [0.03, 0.09], [0.016, 0.115], [0.0135, 0.15]], 12), r), u.add(Ko([[0.0145, 0.118], [0.0155, 0.15], [0.017, 0.152], [0.017, 0.166], [0.012, 0.172], [0, 0.173]], 10), d);
    }), rs("serviceTrolley", [1.1, 1.06, 0.56], { surf: "metal", dynamic: true, mass: 18 });
  }), t("trashBin", null, (u) => (u.add(Ko([[0, 6e-3], [0.126, 6e-3], [0.132, 0.01], [0.1405, 0.04], [0.1415, 0.046], [0.1425, 0.2], [0.141, 0.205], [0.1425, 0.21], [0.1505, 0.59], [0.149, 0.595], [0.151, 0.6], [0.153, 0.618], [0.158, 0.626], [0.158, 0.636], [0.152, 0.645], [0.143, 0.645], [0.139, 0.636]], 28, 30), o2.steel, null, null, null, "x"), u.add(Ko([[0.126, 0], [0.145, 3e-3], [0.1465, 0.034], [0.141, 0.04], [0.13, 0.012]], 28), o2.rubber), u.add(Ko([[0.14, 0.632], [0.136, 0.642], [0.128, 0.642], [0.126, 0.632], [0.118, 0.07], [0.112, 0.06], [0, 0.06]], 24), l), rs("trashBin", [0.32, 0.65, 0.32], { surf: "metal", dynamic: true, mass: 5 }))), t("wetFloorSign", null, (u) => {
    let d = s(), m = n(), p = o2.plasticBlack, x = new THREE.Shape();
    x.moveTo(-0.142, 0.012), x.quadraticCurveTo(-0.15, 0, -0.138, 0), x.lineTo(0.138, 0), x.quadraticCurveTo(0.15, 0, 0.142, 0.012), x.lineTo(0.112, 0.604), x.quadraticCurveTo(0.11, 0.62, 0.094, 0.62), x.lineTo(-0.094, 0.62), x.quadraticCurveTo(-0.11, 0.62, -0.112, 0.604), x.lineTo(-0.142, 0.012);
    let g = new THREE.Path();
    g.absarc(-0.035, 0.57, 0.015, Hi, hl * 1.5, false), g.absarc(0.035, 0.57, 0.015, -Hi, Hi, false), x.holes.push(g);
    for (let b of [0, hl]) {
      let v = new THREE.Matrix4().makeTranslation(0, 0.612, 0).multiply(new THREE.Matrix4().makeRotationY(b)).multiply(new THREE.Matrix4().makeRotationX(-0.2)).multiply(new THREE.Matrix4().makeTranslation(0, -0.62, 0));
      u.at(v, () => {
        u.add(Fr(x, 0.012, 3e-3, 5), m), u.add(_i([[-6e-3, 0], [6e-3, 0], [6e-3, 4e-3], [-6e-3, 4e-3]], [[-0.128, 0.03, 0.012], [-0.101, 0.535, 0.012], [0.101, 0.535, 0.012], [0.128, 0.03, 0.012]], { up: De(0, 0, 1), deg: 50 }), m), u.add(cc(0.196, 0.392, cl.wet), d, [0, 0.283, 0.0126], null, null, true);
        for (let y of [0.16, 0.34]) u.add(zs(0.2 - y * 0.08, 8e-3, 6e-3), m, [0, y, -2e-3]);
        for (let y of [-1, 1]) u.add(Te(0.03, 0.01, 0.016, 3e-3), p, [y * 0.11, 4e-3, 6e-3]);
      });
    }
    return u.add(Te(0.16, 0.016, 0.03, 5e-3), p, [0, 0.616, 0]), u.add(ks(5e-3, 5e-3, 0.2, 6), p, [0, 0.607, 0], [0, 0, Hi]), u.add(zs(0.018, 2e-3, 0.16), p, [0.06, 0.2, 0]), rs("wetFloorSign", [0.3, 0.62, 0.3], { surf: "plastic", dynamic: true, mass: 1.5 });
  });
}
function PD(o2) {
  const t = {};
  const e = mD(o2, t);
  for (const s of [gD, yD, wD, TD, _D, RD, CD]) s(e);
  t.names = Object.keys(t).filter((s) => t[s].hero);
  t._ctx = e;
  return t;
}


function disposeTextureSet(val, seen) {
  if (!val || typeof val !== 'object' || seen.has(val)) return;
  seen.add(val);
  if (val.isTexture) {
    val.dispose();
    return;
  }
  if (val.isMaterial) {
    for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'alphaMap', 'aoMap']) {
      if (val[k] && val[k].isTexture) disposeTextureSet(val[k], seen);
    }
    val.dispose();
    return;
  }
  if (Array.isArray(val)) {
    for (const item of val) disposeTextureSet(item, seen);
    return;
  }
  for (const k of Object.keys(val)) {
    if (k === 'timings') continue;
    disposeTextureSet(val[k], seen);
  }
}

const _sharedMaterialSets = new Map();

export function createHabitatMaterials({ anisotropy = 4, detail = false, floors = [0, 3.8], shared = true } = {}) {
  const effectiveDetail = globalThis.HABITAT_MAT_LITE ? false : !!detail;
  const cacheKey = shared && !effectiveDetail && floors[0] === 0 && floors[1] === 3.8
    ? `default:${anisotropy}`
    : null;
  if (cacheKey && _sharedMaterialSets.has(cacheKey)) {
    return _sharedMaterialSets.get(cacheKey);
  }
  const mats = lD({ anisotropy, floors, detail: effectiveDetail });
  mats.names = Object.keys(A9);
  mats.isShared = Boolean(cacheKey);
  mats.dispose = () => {
    if (mats.isShared) return;
    const seen = new Set();
    for (const name of Object.keys(A9)) {
      if (mats[name]) disposeTextureSet(mats[name], seen);
    }
    if (mats.textures) disposeTextureSet(mats.textures, seen);
  };
  if (cacheKey) _sharedMaterialSets.set(cacheKey, mats);
  return mats;
}

export function createHabitatFurniture({ materials = null, anisotropy = 4, detail = false } = {}) {
  const mats = materials || createHabitatMaterials({ anisotropy, detail });
  const ownsMaterials = !materials && !mats.isShared;
  const registry = PD(mats);
  const names = [...registry.names];
  const createdExtras = new Set();

  return {
    materials: mats,
    names,
    create(name, opts = {}) {
      const builder = registry[name];
      if (typeof builder !== 'function' || !builder.hero) {
        throw new Error(`Unknown habitat furniture prop "${name}". Available: ${names.join(', ')}`);
      }
      const group = builder(opts);
      group.name = name;
      group.castShadow = true;
      group.receiveShadow = true;
      group.traverse((child) => {
        if (child.isMesh) {
          if (!child.userData.keep) {
            child.castShadow = true;
            child.receiveShadow = true;
          } else if (child.material && child.material !== mats[child.material.name]) {
            createdExtras.add(child.material);
          }
        }
      });
      const ud = group.userData || (group.userData = {});
      ud.propName = name;
      ud.surface = ud.surf || 'wood';
      ud.dynamic = Boolean(ud.dynamic);
      if (!Array.isArray(ud.size) || ud.size.length !== 3) {
        const box = new THREE.Box3().setFromObject(group);
        const sz = new THREE.Vector3();
        box.getSize(sz);
        ud.size = [sz.x, sz.y, sz.z];
      }
      return group;
    },
    dispose() {
      const ctx = registry._ctx;
      const seen = new Set();
      if (ctx && ctx._geoCache) {
        for (const cached of ctx._geoCache.values()) {
          for (const m of cached.meshes || []) m.geometry.dispose();
          for (const k of cached.keeps || []) k.geometry.dispose();
        }
        ctx._geoCache.clear();
      }
      if (ctx && ctx._matCache) {
        for (const m of ctx._matCache.values()) disposeTextureSet(m, seen);
        ctx._matCache.clear();
      }
      for (const m of createdExtras) disposeTextureSet(m, seen);
      createdExtras.clear();
      if (ownsMaterials && typeof mats.dispose === 'function') {
        mats.dispose();
      }
    },
  };
}
