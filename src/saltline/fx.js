// Surface & combat visual effects ported from Saltline (`Cf` in module `Sv`,
// see docs/saltline-reuse.md).
//
// Adapted for Deep Space:
//  - WebGL2 logarithmic depth buffer chunks in both instanced particle shaders
//  - Pure-Node safe texture generation (procedural DataTexture decal atlas when
//    `document` is unavailable, full Canvas2D decal painter in browser)
//  - Dynamic lighting uniforms (`setLighting`) instead of hardcoded port sun/sky
//  - Arbitrary local `up` direction & per-particle contact planes so gravity,
//    sparks, debris, water rings, and shockwaves work on spherical planets
//  - `shiftOrigin(deltaVec3)` for Deep Space's floating-origin camera

import * as THREE from 'three';

function makeSeededNoise(seed) {
  const table = new Float32Array(4096);
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < 4096; i++) table[i] = rnd();
  const noise = (x, y) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    let fx = x - ix;
    let fy = y - iy;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    const x0 = ix & 63;
    const x1 = (ix + 1) & 63;
    const y0 = (iy & 63) * 64;
    const y1 = ((iy + 1) & 63) * 64;
    const a = table[y0 + x0];
    const b = table[y0 + x1];
    const c = table[y1 + x0];
    const d = table[y1 + x1];
    return a + (b - a) * fx + (c - a + (a - b - c + d) * fx) * fy;
  };
  const fbm = (x, y, oct = 4) => {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    let px = x;
    let py = y;
    for (let i = 0; i < oct; i++) {
      sum += noise(px, py) * amp;
      norm += amp;
      px = px * 2.03 + 17.1;
      py = py * 2.03 + 9.7;
      amp *= 0.5;
    }
    return sum / norm;
  };
  return { noise, fbm, rnd };
}

function smoothstep(e0, e1, x) {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

const LIT_COLS = 4;
const LIT_ROWS = 2;

function buildLitAtlas(cellSize = 128) {
  const width = cellSize * LIT_COLS;
  const height = cellSize * LIT_ROWS;
  const data = new Uint8Array(width * height * 4);
  const sn = makeSeededNoise(9173);
  const hBuf = new Float32Array(cellSize * cellSize);
  const aBuf = new Float32Array(cellSize * cellSize);
  const tBuf = new Float32Array(cellSize * cellSize);

  for (let cell = 0; cell < LIT_COLS * LIT_ROWS; cell++) {
    const cx = cell % LIT_COLS;
    const cy = Math.floor(cell / LIT_COLS);
    const ox = cell * 13.37 + 3.1;
    const oy = cell * 7.77 + 1.3;
    for (let y = 0; y < cellSize; y++) {
      for (let x = 0; x < cellSize; x++) {
        const gx = ((x + 0.5) / cellSize) * 2 - 1;
        const gy = ((y + 0.5) / cellSize) * 2 - 1;
        const border = 1 - smoothstep(0.78, 0.98, Math.max(Math.abs(gx), Math.abs(gy)));
        let alpha;
        let thick;
        let heightVal;
        if (cell === 6) {
          const v = gy * 0.5 + 0.5;
          const cone = 0.16 + 0.5 * v * v;
          const warp = (sn.fbm(gx * 2 + ox, v * 2 + oy, 3) - 0.5) * 0.25;
          const side = 1 - smoothstep(cone * 0.3, cone, Math.abs(gx + warp * v));
          const tex = sn.fbm(gx * 9 + ox, v * 2.2 + oy, 4);
          const top = 1 - smoothstep(0.55, 0.95, v - (sn.noise(gx * 6 + ox, 3.3) - 0.5) * 0.35);
          const bot = smoothstep(0, 0.12, v);
          alpha = side * top * bot * smoothstep(0.22, 0.7, tex + 0.25 * (1 - v));
          thick = side * top;
          heightVal = alpha * 0.5;
        } else {
          const dense = cell === 7;
          const warpAmt = dense ? 0.3 : 0.6;
          const wx = (sn.fbm(gx * 1.4 + ox, gy * 1.4 + oy, 3) - 0.5) * warpAmt;
          const wy = (sn.fbm(gx * 1.4 + oy + 5.2, gy * 1.4 + ox + 1.7, 3) - 0.5) * warpAmt;
          const zx = gx + wx;
          const zy = gy + wy;
          const dist = Math.sqrt(zx * zx + zy * zy);
          const rim = (sn.fbm(zx * 2.2 + ox, zy * 2.2 + oy, 3) - 0.5) * 0.6;
          const base = 1 - smoothstep(0, dense ? 0.84 : 0.8, dist + rim);
          const billow = sn.fbm(zx * 4.2 + ox * 2, zy * 4.2 + oy * 2, 5);
          const body = base * (dense ? 0.8 + 0.7 * billow : 0.25 + 1.5 * billow);
          alpha = smoothstep(dense ? 0.02 : 0.06, dense ? 0.7 : 0.95, body);
          thick = base;
          heightVal = base * 0.55 + base * sn.fbm(zx * 3.1 + ox * 3, zy * 3.1 + oy * 3, 3) * 0.9;
        }
        const idx = y * cellSize + x;
        aBuf[idx] = alpha * border;
        tBuf[idx] = thick;
        hBuf[idx] = heightVal * border;
      }
    }
    for (let y = 0; y < cellSize; y++) {
      for (let x = 0; x < cellSize; x++) {
        const xm = Math.max(0, x - 2);
        const xp = Math.min(cellSize - 1, x + 2);
        const ym = Math.max(0, y - 2);
        const yp = Math.min(cellSize - 1, y + 2);
        const dx = ((hBuf[y * cellSize + xp] - hBuf[y * cellSize + xm]) * cellSize) / 8;
        const dy = ((hBuf[yp * cellSize + x] - hBuf[ym * cellSize + x]) * cellSize) / 8;
        const k = 0.55;
        let nx = -dx * k;
        let ny = -dy * k;
        const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
        nx *= inv;
        ny *= inv;
        const outIdx = ((cy * cellSize + y) * width + cx * cellSize + x) * 4;
        const srcIdx = y * cellSize + x;
        data[outIdx] = Math.round((nx * 0.5 + 0.5) * 255);
        data[outIdx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        data[outIdx + 2] = Math.min(255, Math.round(tBuf[srcIdx] * 255));
        data[outIdx + 3] = Math.min(255, Math.round(aBuf[srcIdx] * 255));
      }
    }
  }

  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const ADD_COLS = 4;
const ADD_ROWS = 2;
const FRAME_GLOW = 0;
const FRAME_SPARK = 1;
const FRAME_BURST_A = 2;
const FRAME_BURST_B = 3;
const FRAME_RING = 4;
const FRAME_FIRE = 5;
const FRAME_DROP = 6;
const FRAME_TRACER = 7;

function buildAdditiveAtlas(cellSize = 128) {
  const width = cellSize * ADD_COLS;
  const height = cellSize * ADD_ROWS;
  const data = new Uint8Array(width * height * 4);
  const sn = makeSeededNoise(4441);
  const rays = [0, 1].map(() => {
    const count = 7 + Math.floor(sn.rnd() * 4);
    const list = [];
    for (let i = 0; i < count; i++) {
      list.push({
        a: (i / count + (sn.rnd() - 0.5) * 0.12) * Math.PI * 2,
        l: 0.35 + sn.rnd() * 0.6,
        w: 0.018 + sn.rnd() * 0.05,
        g: 0.5 + sn.rnd() * 0.5,
      });
    }
    return list;
  });

  for (let cell = 0; cell < 8; cell++) {
    const cx = cell % ADD_COLS;
    const cy = Math.floor(cell / ADD_COLS);
    for (let y = 0; y < cellSize; y++) {
      for (let x = 0; x < cellSize; x++) {
        const fx = ((x + 0.5) / cellSize) * 2 - 1;
        const fy = ((y + 0.5) / cellSize) * 2 - 1;
        const d = Math.sqrt(fx * fx + fy * fy);
        const border = 1 - smoothstep(0.86, 0.99, Math.max(Math.abs(fx), Math.abs(fy)));
        let v = 0;
        if (cell === FRAME_GLOW) {
          const b = Math.max(0, 1 - d);
          v = b * b * b * 0.75 + Math.exp(-d * d * 22) * 0.5;
        } else if (cell === FRAME_SPARK) {
          const b = Math.pow(Math.max(0, 1 - fx * fx), 1.5);
          v = Math.exp(-(fy * fy) / (0.42 * 0.42)) * b;
        } else if (cell === FRAME_BURST_A || cell === FRAME_BURST_B) {
          const set = rays[cell - FRAME_BURST_A];
          const ang = Math.atan2(fy, fx);
          for (const ray of set) {
            let da = Math.abs(ang - ray.a) % (Math.PI * 2);
            if (da > Math.PI) da = Math.PI * 2 - da;
            const perp = Math.sin(Math.min(da, 1.5)) * d;
            if (da < 1.5) {
              v += ray.g * Math.exp(-(perp * perp) / (ray.w * ray.w * (0.4 + d))) * Math.pow(Math.max(0, 1 - d / ray.l), 1.4);
            }
          }
          v = v * (0.7 + 0.6 * sn.fbm(fx * 5 + cell * 9, fy * 5, 3)) + Math.exp(-d * d * 70) * 1.2 + Math.max(0, 1 - d * 2.2) * 0.06;
        } else if (cell === FRAME_RING) {
          const ang = Math.atan2(fy, fx);
          const rad = 0.78 + (sn.noise(Math.cos(ang) * 2 + 5, Math.sin(ang) * 2 + 5) - 0.5) * 0.04;
          v = Math.exp(-((d - rad) * (d - rad)) / (0.03 * 0.03)) * (0.6 + 0.4 * sn.noise(Math.cos(ang) * 5 + 9, Math.sin(ang) * 5 + 9))
            + 0.05 * smoothstep(0.2, 0.78, d) * (1 - smoothstep(0.78, 0.8, d));
        } else if (cell === FRAME_FIRE) {
          const wx = (sn.fbm(fx * 1.6 + 3.3, fy * 1.6 + 8.1, 3) - 0.5) * 0.5;
          const wy = (sn.fbm(fx * 1.6 + 7.7, fy * 1.6 + 2.2, 3) - 0.5) * 0.5;
          const zx = fx + wx;
          const zy = fy + wy;
          const rd = Math.sqrt(zx * zx + zy * zy);
          const base = 1 - smoothstep(0, 0.84, rd);
          const billow = sn.fbm(zx * 4 + 1.1, zy * 4 + 6.6, 5);
          v = smoothstep(0.04, 0.9, base * (0.3 + 1.4 * billow)) * (0.45 + 0.75 * base);
        } else if (cell === FRAME_DROP) {
          v = 1 - smoothstep(0.3, 0.62, d);
        } else if (cell === FRAME_TRACER) {
          const u = fx * 0.5 + 0.5;
          const w = 0.22 + 0.3 * u;
          let jet = Math.exp(-(fy * fy) / (w * w)) * Math.pow(u, 1.8);
          const tail = (fx - 0.8) / 0.16;
          if (fx > 0.8) jet *= Math.max(0, 1 - tail * tail);
          v = jet * 1.15;
        }
        v *= border;
        const byte = Math.max(0, Math.min(255, Math.round(v * 255)));
        const idx = ((cy * cellSize + y) * width + cx * cellSize + x) * 4;
        data[idx] = byte;
        data[idx + 1] = byte;
        data[idx + 2] = byte;
        data[idx + 3] = 255;
      }
    }
  }

  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const DECAL_COLS = 4;
const DECAL_ROWS = 2;
const DECAL_SLOTS = {
  bullet_metal: [0, 1],
  bullet_concrete: [2, 3],
  bullet_wood: [4],
  scorch: [5],
  soot: [6],
  bullet_glass: [7],
};
const DECAL_SIZES = {
  bullet_metal: 0.25,
  bullet_concrete: 0.34,
  bullet_wood: 0.24,
  scorch: 2.4,
  soot: 0.3,
  bullet_glass: 0.3,
};

function buildDecalAtlasDataFallback(cellSize = 64) {
  const width = cellSize * DECAL_COLS;
  const height = cellSize * DECAL_ROWS;
  const mapData = new Uint8Array(width * height * 4);
  const ormData = new Uint8Array(width * height * 4);
  const nrmData = new Uint8Array(width * height * 4);
  const sn = makeSeededNoise(77123);

  for (let cell = 0; cell < DECAL_COLS * DECAL_ROWS; cell++) {
    const cx = cell % DECAL_COLS;
    const cy = Math.floor(cell / DECAL_COLS);
    for (let y = 0; y < cellSize; y++) {
      for (let x = 0; x < cellSize; x++) {
        const fx = ((x + 0.5) / cellSize) * 2 - 1;
        const fy = ((y + 0.5) / cellSize) * 2 - 1;
        const r = Math.hypot(fx, fy);
        const n = sn.fbm(fx * 4 + cell * 5, fy * 4 + cell * 3, 3);
        const core = 1 - smoothstep(0.06, 0.22 + (n - 0.5) * 0.08, r);
        const halo = (1 - smoothstep(0.18, 0.85, r)) * (0.4 + 0.6 * n);
        let cr = 24;
        let cg = 23;
        let cb = 22;
        let alpha = Math.max(core, halo * (cell === 5 ? 0.85 : 0.45));
        let rough = 220;
        let metal = 0;
        if (cell <= 1) {
          const rim = smoothstep(0.12, 0.22, r) * (1 - smoothstep(0.22, 0.38, r));
          cr = Math.round(14 + rim * 170);
          cg = Math.round(14 + rim * 172);
          cb = Math.round(16 + rim * 178);
          rough = Math.round(220 - rim * 140);
          metal = Math.round(rim * 245);
        } else if (cell <= 3) {
          cr = Math.round(20 + halo * 95);
          cg = Math.round(19 + halo * 92);
          cb = Math.round(18 + halo * 86);
        } else if (cell === 4) {
          cr = Math.round(28 + halo * 150);
          cg = Math.round(20 + halo * 120);
          cb = Math.round(12 + halo * 82);
        } else if (cell === 7) {
          cr = 225;
          cg = 235;
          cb = 240;
          alpha = (1 - smoothstep(0.05, 0.78, r)) * (0.35 + 0.65 * n);
        }
        const idx = ((cy * cellSize + y) * width + cx * cellSize + x) * 4;
        mapData[idx] = cr;
        mapData[idx + 1] = cg;
        mapData[idx + 2] = cb;
        mapData[idx + 3] = Math.min(255, Math.round(alpha * 255));
        ormData[idx] = 255;
        ormData[idx + 1] = rough;
        ormData[idx + 2] = metal;
        ormData[idx + 3] = 255;
        const slope = r > 1e-4 && r < 0.45 ? -0.35 * (1 - r / 0.45) : 0;
        const nx = (fx / Math.max(r, 1e-4)) * slope;
        const ny = (fy / Math.max(r, 1e-4)) * slope;
        const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
        nrmData[idx] = Math.round((nx * inv * 0.5 + 0.5) * 255);
        nrmData[idx + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
        nrmData[idx + 2] = Math.round((inv * 0.5 + 0.5) * 255);
        nrmData[idx + 3] = 255;
      }
    }
  }

  const mkTex = (arr, srgb) => {
    const t = new THREE.DataTexture(arr, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
  };
  const pad = 2 / cellSize;
  return {
    map: mkTex(mapData, true),
    orm: mkTex(ormData, false),
    nrm: mkTex(nrmData, false),
    uv: (slot) => {
      const col = slot % DECAL_COLS;
      const row = Math.floor(slot / DECAL_COLS);
      return [(col + pad) / DECAL_COLS, 1 - (row + 1 - pad) / DECAL_ROWS, (col + 1 - pad) / DECAL_COLS, 1 - (row + pad) / DECAL_ROWS];
    },
  };
}

function buildDecalAtlas(cellSize = 256) {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    return buildDecalAtlasDataFallback(64);
  }
  const e = cellSize * DECAL_COLS;
  const t = cellSize * DECAL_ROWS;
  const n = document.createElement('canvas');
  n.width = e;
  n.height = t;
  const s = document.createElement('canvas');
  s.width = e;
  s.height = t;
  const o = document.createElement('canvas');
  o.width = e;
  o.height = t;
  const r = n.getContext('2d');
  const a = s.getContext('2d');
  const l = o.getContext('2d', { willReadFrequently: true });
  if (!r || !a || !l) {
    return buildDecalAtlasDataFallback(64);
  }
  l.fillStyle = 'rgb(128,128,128)';
  l.fillRect(0, 0, e, t);
  const c = (stops, rad) => {
    const grad = l.createRadialGradient(0, 0, 0, 0, 0, rad);
    for (const [stop, val] of stops) grad.addColorStop(stop, `rgb(${val},${val},${val})`);
    l.fillStyle = grad;
    l.beginPath();
    l.arc(0, 0, rad, 0, Math.PI * 2);
    l.fill();
  };
  const h = makeSeededNoise(77123).rnd;
  a.fillStyle = 'rgb(0,235,0)';
  a.fillRect(0, 0, e, t);
  const TAU = Math.PI * 2;
  const poly = (ctx, rad, jag, seg = 22, sy = 1) => {
    ctx.beginPath();
    for (let k = 0; k < seg; k++) {
      const ang = (k / seg) * TAU;
      const rr = rad * (1 + (h() - 0.5) * jag);
      const px = Math.cos(ang) * rr;
      const py = Math.sin(ang) * rr * sy;
      if (k) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    }
    ctx.closePath();
  };
  const crack = (ctx, ang0, r0, r1, spread, lw, stroke) => {
    ctx.beginPath();
    let rr = r0;
    let ang = ang0;
    ctx.moveTo(Math.cos(ang) * rr, Math.sin(ang) * rr);
    const steps = 5 + Math.floor(h() * 4);
    for (let k = 1; k <= steps; k++) {
      rr = r0 + ((r1 - r0) * k) / steps;
      ang += (h() - 0.5) * spread;
      ctx.lineTo(Math.cos(ang) * rr, Math.sin(ang) * rr);
    }
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  };
  const inCell = (slot, fn) => {
    const cx = ((slot % DECAL_COLS) + 0.5) * cellSize;
    const cy = (Math.floor(slot / DECAL_COLS) + 0.5) * cellSize;
    const half = cellSize / 2;
    for (const ctx of [r, a, l]) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(cx - half, cy - half, cellSize, cellSize);
      ctx.clip();
      ctx.translate(cx, cy);
    }
    fn(half);
    r.restore();
    a.restore();
    l.restore();
  };
  const radGrad = (ctx, r0, r1, stops) => {
    const g = ctx.createRadialGradient(0, 0, r0, 0, 0, r1);
    for (const [k, col] of stops) g.addColorStop(k, col);
    return g;
  };

  for (const slot of DECAL_SLOTS.bullet_metal) {
    inCell(slot, (M) => {
      r.fillStyle = radGrad(r, M * 0.1, M * 0.6, [[0, 'rgba(14,13,12,0.4)'], [0.5, 'rgba(18,17,16,0.14)'], [1, 'rgba(20,20,20,0)']]);
      r.fillRect(-M, -M, 2 * M, 2 * M);
      const crN = 6 + Math.floor(h() * 5);
      for (let k = 0; k < crN; k++) crack(r, h() * TAU, M * 0.2, M * (0.38 + h() * 0.45), 0.3, 0.8 + h(), 'rgba(8,8,8,0.55)');
      const w = M * (0.24 + h() * 0.08);
      const sy = 0.7 + h() * 0.5;
      const chip = (tx, ty, rad, rot, jag, seg) => {
        for (const ctx of [r, a]) { ctx.save(); ctx.translate(tx, ty); ctx.rotate(rot); }
        const pts = [];
        for (let k = 0; k < seg; k++) pts.push(1 + (h() - 0.5) * jag);
        const path = (ctx, sc) => {
          ctx.beginPath();
          for (let k = 0; k < seg; k++) {
            const ang = (k / seg) * TAU;
            const rr = rad * pts[k] * sc;
            const px = Math.cos(ang) * rr;
            const py = Math.sin(ang) * rr * sy;
            if (k) ctx.lineTo(px, py); else ctx.moveTo(px, py);
          }
          ctx.closePath();
        };
        path(r, 1);
        r.lineJoin = 'miter';
        r.strokeStyle = 'rgba(92,54,36,0.95)';
        r.lineWidth = Math.max(1.5, rad * 0.14);
        r.stroke();
        const sh = 150 + Math.floor(h() * 50);
        path(r, 1);
        r.fillStyle = radGrad(r, 0, rad * 1.2, [[0, `rgb(${sh - 30},${sh - 26},${sh - 20})`], [0.7, `rgb(${sh + 30},${sh + 33},${sh + 36})`], [1, `rgb(${sh},${sh + 3},${sh + 6})`]]);
        r.fill();
        path(a, 1);
        a.fillStyle = 'rgb(0,85,255)';
        a.fill();
        r.restore();
        a.restore();
      };
      chip(0, 0, w, h() * TAU, 0.75, 11);
      const nSub = 2 + Math.floor(h() * 4);
      for (let k = 0; k < nSub; k++) {
        const ang = h() * TAU;
        const dist = w * (1 + h() * 0.7);
        chip(Math.cos(ang) * dist, Math.sin(ang) * dist, w * (0.15 + h() * 0.3), h() * TAU, 0.8, 7);
      }
      const hole = M * (0.1 + h() * 0.025);
      a.beginPath();
      a.arc(0, 0, hole * 1.8, 0, TAU);
      a.fillStyle = 'rgb(0,60,255)';
      a.fill();
      poly(r, hole, 0.3, 11);
      r.fillStyle = radGrad(r, 0, hole, [[0, '#000000'], [0.8, '#040404'], [1, '#141414']]);
      r.fill();
      c([[0, 0], [0.26, 10], [0.36, 240], [0.5, 200], [0.62, 100], [1, 128]], hole * 3.4);
      poly(a, hole, 0.1, 11);
      a.fillStyle = 'rgb(0,250,0)';
      a.fill();
    });
  }

  for (const slot of DECAL_SLOTS.bullet_concrete) {
    inCell(slot, (M) => {
      r.fillStyle = radGrad(r, M * 0.2, M * 0.9, [[0, 'rgba(186,180,168,0.22)'], [0.6, 'rgba(180,175,165,0.07)'], [1, 'rgba(170,165,155,0)']]);
      r.fillRect(-M, -M, 2 * M, 2 * M);
      const crN = 4 + Math.floor(h() * 4);
      for (let k = 0; k < crN; k++) crack(r, h() * TAU, M * 0.25, M * (0.5 + h() * 0.42), 0.35, 1.3 + h() * 1.3, 'rgba(20,19,18,0.75)');
      const w = M * (0.33 + h() * 0.09);
      const seg = 12;
      const pts = [];
      for (let k = 0; k < seg; k++) pts.push(1 + (h() - 0.5) * 0.6);
      const crater = (ctx, sc, ox, oy) => {
        ctx.beginPath();
        for (let k = 0; k < seg; k++) {
          const ang = (k / seg) * TAU;
          const rr = w * pts[k] * sc;
          if (k) ctx.lineTo(Math.cos(ang) * rr + ox, Math.sin(ang) * rr + oy);
          else ctx.moveTo(Math.cos(ang) * rr + ox, Math.sin(ang) * rr + oy);
        }
        ctx.closePath();
      };
      crater(r, 1.05, 1.5, 1.5);
      r.fillStyle = 'rgba(22,21,20,0.8)';
      r.fill();
      crater(r, 1, 0, 0);
      r.fillStyle = radGrad(r, w * 0.1, w * 1.1, [[0, '#35332f'], [0.4, '#6f6b63'], [0.8, '#8f8b82'], [1, '#9a968c']]);
      r.fill();
      poly(r, w * 0.3, 0.45, 9);
      r.fillStyle = radGrad(r, 0, w * 0.33, [[0, '#060606'], [0.7, '#161514'], [1, '#2c2a27']]);
      r.fill();
      c([[0, 0], [0.24, 20], [0.3, 70], [0.8, 112], [0.88, 150], [1, 128]], w * 1.15);
    });
  }

  for (const slot of DECAL_SLOTS.bullet_wood) {
    inCell(slot, (M) => {
      poly(r, M * 0.27, 0.7, 11, 1.45);
      r.fillStyle = 'rgba(206,182,140,0.85)';
      r.fill();
      for (let k = 0; k < 40; k++) {
        const x = (h() - 0.5) * M * 0.62;
        const len = M * (0.25 + h() * 0.6) * (1 - Math.abs(x) / (M * 0.4));
        const y = (h() - 0.5) * M * 0.2;
        r.beginPath();
        r.moveTo(x, y - len);
        r.lineTo(x + (h() - 0.5) * 5, y + len);
        r.strokeStyle = h() < 0.5 ? 'rgba(236,216,172,0.85)' : 'rgba(88,62,38,0.7)';
        r.lineWidth = 0.8 + h() * 2.2;
        r.stroke();
      }
      poly(r, M * 0.1, 0.5, 9, 1.1);
      r.fillStyle = radGrad(r, 0, M * 0.12, [[0, '#050403'], [0.8, '#140f0a'], [1, '#3a2a1a']]);
      r.fill();
      c([[0, 0], [0.5, 30], [0.8, 140], [1, 128]], M * 0.17);
    });
  }

  for (const slot of DECAL_SLOTS.scorch) {
    inCell(slot, (M) => {
      r.fillStyle = radGrad(r, 0, M * 0.98, [[0, 'rgba(6,5,5,0.92)'], [0.3, 'rgba(10,9,8,0.85)'], [0.55, 'rgba(22,18,15,0.5)'], [0.8, 'rgba(30,24,20,0.16)'], [1, 'rgba(30,24,20,0)']]);
      r.fillRect(-M, -M, 2 * M, 2 * M);
      for (let k = 0; k < 72; k++) {
        const ang = h() * TAU;
        const r0 = M * (0.1 + h() * 0.3);
        const r1 = M * (0.5 + h() * 0.46);
        r.beginPath();
        r.moveTo(Math.cos(ang - 0.03) * r0, Math.sin(ang - 0.03) * r0);
        r.lineTo(Math.cos(ang) * r1, Math.sin(ang) * r1);
        r.lineTo(Math.cos(ang + 0.03) * r0, Math.sin(ang + 0.03) * r0);
        r.closePath();
        r.fillStyle = `rgba(8,7,6,${0.12 + h() * 0.3})`;
        r.fill();
      }
    });
  }

  for (const slot of DECAL_SLOTS.soot) {
    inCell(slot, (M) => {
      for (let k = 0; k < 14; k++) {
        const ang = h() * TAU;
        const rr = h() * M * 0.3;
        const rad = M * (0.15 + h() * 0.3);
        const px = Math.cos(ang) * rr;
        const py = Math.sin(ang) * rr;
        const g = r.createRadialGradient(px, py, 0, px, py, rad);
        g.addColorStop(0, 'rgba(8,8,8,0.4)');
        g.addColorStop(1, 'rgba(8,8,8,0)');
        r.fillStyle = g;
        r.fillRect(-M, -M, 2 * M, 2 * M);
      }
      poly(r, M * 0.1, 0.4, 12);
      r.fillStyle = 'rgba(0,0,0,0.9)';
      r.fill();
    });
  }

  for (const slot of DECAL_SLOTS.bullet_glass) {
    inCell(slot, (M) => {
      r.fillStyle = radGrad(r, 0, M * 0.5, [[0, 'rgba(235,240,242,0.55)'], [1, 'rgba(235,240,242,0)']]);
      r.fillRect(-M, -M, 2 * M, 2 * M);
      for (let k = 0; k < 13; k++) {
        crack(r, ((k + h() * 0.6) / 13) * TAU, M * 0.07, M * (0.5 + h() * 0.45), 0.12, 0.9 + h(), 'rgba(240,246,248,0.85)');
      }
      poly(r, M * 0.07, 0.3, 10);
      r.fillStyle = '#060606';
      r.fill();
    });
  }

  const map = new THREE.CanvasTexture(n);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  const orm = new THREE.CanvasTexture(s);
  orm.colorSpace = THREE.NoColorSpace;
  const pad = 2 / cellSize;
  const uv = (slot) => {
    const col = slot % DECAL_COLS;
    const row = Math.floor(slot / DECAL_COLS);
    return [(col + pad) / DECAL_COLS, 1 - (row + 1 - pad) / DECAL_ROWS, (col + 1 - pad) / DECAL_COLS, 1 - (row + pad) / DECAL_ROWS];
  };
  let nrm = null;
  try {
    const img = l.getImageData(0, 0, e, t);
    const M = img.data;
    if (M && M.length === e * t * 4) {
      const out = l.createImageData(e, t);
      const w = out.data;
      const sc = 5 / 255;
      for (let y = 0; y < t; y++) {
        const ym = Math.max(0, y - 1) * e;
        const yp = Math.min(t - 1, y + 1) * e;
        for (let x = 0; x < e; x++) {
          const xm = Math.max(0, x - 1);
          const xp = Math.min(e - 1, x + 1);
          const dx = (M[(y * e + xp) * 4] - M[(y * e + xm) * 4]) * sc;
          const dy = (M[(yp + x) * 4] - M[(ym + x) * 4]) * sc;
          const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
          const idx = (y * e + x) * 4;
          w[idx] = (-dx * inv * 0.5 + 0.5) * 255;
          w[idx + 1] = (dy * inv * 0.5 + 0.5) * 255;
          w[idx + 2] = (inv * 0.5 + 0.5) * 255;
          w[idx + 3] = 255;
        }
      }
      l.putImageData(out, 0, 0);
      nrm = new THREE.CanvasTexture(o);
      nrm.colorSpace = THREE.NoColorSpace;
    }
  } catch {
    nrm = null;
  }
  return { map, orm, nrm, uv };
}

const PARTICLE_VERT = /* glsl */`
attribute vec4 aPos;    // xyz centre, w size (m)
attribute vec4 aAxis;   // mode 1: stretch axis (length = streak length); mode 2: plane normal; w = roll (rad)
attribute vec4 aCol;    // rgb (HDR), a
attribute vec4 aMisc;   // x atlas frame, y mode (0 billboard, 1 velocity-stretched, 2 surface-aligned), z age 0..1, w sun visibility
uniform vec2 uAtlas;
uniform float uPx;
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
varying vec4 vCol;
varying vec3 vOff;
varying vec3 vToCam;
varying vec3 vInfo;
varying vec3 vT;
varying vec3 vB;
void main() {
  vec2 c = position.xy;
  vec3 center = aPos.xyz;
  float size = aPos.w;
  float mode = aMisc.y;
  vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 toCam = cameraPosition - center;
  float dist = length(toCam);
  toCam /= max(dist, 1e-4);
  float sn = sin(aAxis.w), cs = cos(aAxis.w);
  vec2 rc = vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs);
  vec3 off;
  float comp = 1.0;
  if (mode < 0.5) {
    off = (camR * rc.x + camU * rc.y) * size;
    vT = camR * cs + camU * sn;
    vB = camU * cs - camR * sn;
  } else if (mode < 1.5) {
    float len = length(aAxis.xyz);
    vec3 d = aAxis.xyz / max(len, 1e-5);
    vec3 side = cross(d, toCam);
    float sl = length(side);
    side = sl > 1e-3 ? side / sl : camR;
    float w = max(size, dist * uPx * 1.4);
    comp = size / w;
    if (aMisc.w > 1.5) w = min(w, dist * uPx * aMisc.w);
    off = d * (c.x * max(len, w)) + side * (c.y * w);
    vT = d;
    vB = side;
  } else {
    vec3 n = normalize(aAxis.xyz);
    vec3 t = normalize(abs(n.y) > 0.9 ? cross(n, vec3(1.0, 0.0, 0.0)) : cross(vec3(0.0, 1.0, 0.0), n));
    vec3 b = cross(n, t);
    off = (t * rc.x + b * rc.y) * size;
    vT = t * cs + b * sn;
    vB = b * cs - t * sn;
  }
  vec4 mv = viewMatrix * vec4(center + off, 1.0);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
  float f = floor(aMisc.x + 0.5);
  float col = mod(f, uAtlas.x);
  float row = floor(f / uAtlas.x);
  vUv = (vec2(col, row) + c + 0.5) / uAtlas;
  vCol = vec4(aCol.rgb * comp, aCol.a);
  vOff = off / max(size, 1e-4);
  vToCam = toCam;
  vInfo = vec3(mv.z, aMisc.z, aMisc.w);
}`;

const PARTICLE_FRAG_HEAD = /* glsl */`
uniform sampler2D uTex;
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec2 vUv;
varying vec4 vCol;
varying vec3 vOff;
varying vec3 vToCam;
varying vec3 vInfo;
varying vec3 vT;
varying vec3 vB;
`;

const PARTICLE_LIT_FRAG = PARTICLE_FRAG_HEAD + /* glsl */`
uniform vec3 uSun, uSunDir, uAmbLo, uAmbHi, uUpDir;
void main() {
  vec4 t = texture2D(uTex, vUv);
  float er = vInfo.y * 0.45;
  float a = smoothstep(er, er + (vInfo.z > 1.5 ? 0.38 : 0.6), t.a) * vCol.a;
  a *= smoothstep(0.15, 0.85, -vInfo.x);
  if (a < 0.004) discard;
  #include <logdepthbuf_fragment>
  vec3 V = normalize(vToCam);
  vec3 q = vOff * 2.0;
  float r2 = min(dot(q, q), 1.0);
  vec3 Ns = q + V * (sqrt(1.0 - r2) * 0.9 + 0.05);
  vec2 tn = t.rg * 2.0 - 1.0;
  vec3 Nb = vT * tn.x + vB * tn.y + V * sqrt(max(1.0 - dot(tn, tn), 0.0));
  vec3 N = normalize(Ns * 0.55 + Nb);
  float wrap = clamp((dot(N, uSunDir) + 0.45) / 1.45, 0.0, 1.0);
  float back = pow(clamp(dot(-V, uSunDir), 0.0, 1.0), 5.0);
  float thin = 1.0 - t.b * smoothstep(0.0, 0.5, a);
  float hot = step(1.5, vInfo.z);
  float shade = vInfo.z - 2.0 * hot;
  vec3 sun = uSun * (wrap * wrap * 0.85 + back * (0.15 + 1.3 * thin)) * shade;
  vec3 amb = mix(uAmbLo, uAmbHi, dot(N, uUpDir) * 0.5 + 0.5) * (1.0 - 0.35 * t.b);
  vec3 col = vCol.rgb * (amb + sun);
  if (hot > 0.5) {
    float lump = clamp(dot(tn, vec2(0.6, 0.8)) * 0.6 + 0.5, 0.0, 1.0);
    float core = t.b * t.b * smoothstep(0.15, 0.9, t.a);
    vec3 fire = vCol.rgb * (0.10 + 1.7 * core) * (0.45 + 1.1 * lump);
    col = vec3(0.045, 0.042, 0.04) * (amb + sun) + fire;
  }
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb *= gl_FragColor.a;
}`;

const PARTICLE_ADD_FRAG = PARTICLE_FRAG_HEAD + /* glsl */`
void main() {
  float t = texture2D(uTex, vUv).r;
  float k = t * vCol.a;
  if (k < 0.002) discard;
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(vCol.rgb * k, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const _drawSize = new THREE.Vector2();

function createParticleBatch(cap, { lit, tex, cols, rows, renderOrder, lighting }) {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -0.5, -0.5, 0,
    0.5, -0.5, 0,
    0.5, 0.5, 0,
    -0.5, 0.5, 0,
  ]), 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const mkAttr = (name) => {
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(name, attr);
    return attr;
  };
  const aPos = mkAttr('aPos');
  const aAxis = mkAttr('aAxis');
  const aCol = mkAttr('aCol');
  const aMisc = mkAttr('aMisc');
  geo.instanceCount = 0;

  const uniforms = {
    uTex: { value: tex },
    uAtlas: { value: new THREE.Vector2(cols, rows) },
    uPx: { value: 1e-3 },
  };
  if (lit) {
    Object.assign(uniforms, {
      uSun: { value: lighting.sun },
      uSunDir: { value: lighting.sunDir },
      uAmbLo: { value: lighting.ambLo },
      uAmbHi: { value: lighting.ambHi },
      uUpDir: { value: lighting.up },
    });
  }

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: PARTICLE_VERT,
    fragmentShader: lit ? PARTICLE_LIT_FRAG : PARTICLE_ADD_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    fog: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: lit ? THREE.OneMinusSrcAlphaFactor : THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  mat.name = lit ? 'fx_lit' : 'fx_add';

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.name = mat.name;
  mesh.visible = false;
  mesh.onBeforeRender = (renderer, _scene, camera) => {
    const target = renderer.getRenderTarget();
    let h = 720;
    if (target) {
      h = target.height;
    } else if (renderer.getDrawingBufferSize) {
      renderer.getDrawingBufferSize(_drawSize);
      h = _drawSize.y;
    }
    const proj = camera.projectionMatrix.elements;
    uniforms.uPx.value = 2 / (Math.max(proj[5], 1e-3) * Math.max(h, 1));
  };

  const posArr = aPos.array;
  const axisArr = aAxis.array;
  const colArr = aCol.array;
  const miscArr = aMisc.array;
  const attrs = [aPos, aAxis, aCol, aMisc];

  const batch = {
    mesh,
    cap,
    n: 0,
    begin() {
      batch.n = 0;
    },
    push(px, py, pz, size, ax, ay, az, rot, r, g, b, a, frame, mode, ageN, shade) {
      const idx = batch.n;
      if (idx >= cap) return false;
      const o = idx * 4;
      posArr[o] = px; posArr[o + 1] = py; posArr[o + 2] = pz; posArr[o + 3] = size;
      axisArr[o] = ax; axisArr[o + 1] = ay; axisArr[o + 2] = az; axisArr[o + 3] = rot;
      colArr[o] = r; colArr[o + 1] = g; colArr[o + 2] = b; colArr[o + 3] = a;
      miscArr[o] = frame; miscArr[o + 1] = mode; miscArr[o + 2] = ageN; miscArr[o + 3] = shade;
      batch.n = idx + 1;
      return true;
    },
    end() {
      const count = batch.n;
      geo.instanceCount = count;
      mesh.visible = count > 0;
      if (count > 0) {
        for (let i = 0; i < 4; i++) {
          const attr = attrs[i];
          attr.clearUpdateRanges();
          attr.addUpdateRange(0, count * 4);
          attr.needsUpdate = true;
        }
      }
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
  return batch;
}

const FLAG_BOUNCE = 1;
const FLAG_KILL = 2;
const FLAG_STOP = 4;

class ParticlePool {
  constructor(cap, sorted, rnd) {
    this.cap = cap;
    this.sorted = sorted;
    this.rnd = rnd;
    this.n = 0;
    this.freeTop = cap;
    const f = () => new Float32Array(cap);
    this.px = f(); this.py = f(); this.pz = f();
    this.vx = f(); this.vy = f(); this.vz = f();
    this.nx = f(); this.ny = f().fill(1); this.nz = f();
    this.age = f(); this.life = f();
    this.s0 = f(); this.s1 = f(); this.sk = f();
    this.rot = f(); this.rotv = f();
    this.r = f(); this.g = f(); this.b = f(); this.a = f();
    this.drag = f(); this.grav = f(); this.wind = f(); this.turb = f();
    this.seed = f(); this.fin = f(); this.fout = f();
    this.stretch = f(); this.shade = f(); this.key = f();
    this.planeD = f();
    this.frame = new Uint8Array(cap);
    this.mode = new Uint8Array(cap);
    this.flags = new Uint8Array(cap);
    this.ramp = new Uint8Array(cap);
    this.order = new Uint16Array(cap);
    this.free = new Uint16Array(cap);
    for (let i = 0; i < cap; i++) this.free[i] = cap - 1 - i;
  }

  clear() {
    this.n = 0;
    this.freeTop = this.cap;
    for (let i = 0; i < this.cap; i++) this.free[i] = this.cap - 1 - i;
  }

  emit(x, y, z, vx, vy, vz, life, s0, s1, up) {
    if (this.freeTop === 0) return -1;
    const u = this.free[--this.freeTop];
    this.order[this.n++] = u;
    this.px[u] = x; this.py[u] = y; this.pz[u] = z;
    this.vx[u] = vx; this.vy[u] = vy; this.vz[u] = vz;
    this.nx[u] = up.x; this.ny[u] = up.y; this.nz[u] = up.z;
    this.age[u] = -1;
    this.life[u] = life;
    this.s0[u] = s0; this.s1[u] = s1; this.sk[u] = 2;
    this.rot[u] = 0; this.rotv[u] = 0;
    this.r[u] = 1; this.g[u] = 1; this.b[u] = 1; this.a[u] = 1;
    this.drag[u] = 0; this.grav[u] = 0; this.wind[u] = 0; this.turb[u] = 0;
    this.seed[u] = this.rnd() * 100;
    this.fin[u] = 0; this.fout[u] = 0.5;
    this.stretch[u] = 0.02;
    this.shade[u] = 1;
    this.key[u] = 0;
    this.planeD[u] = x * up.x + y * up.y + z * up.z - 1.2;
    this.frame[u] = 0;
    this.mode[u] = 0;
    this.flags[u] = 0;
    this.ramp[u] = 0;
    return u;
  }

  shiftOrigin(dx, dy, dz, upDelta) {
    for (let i = 0; i < this.n; i++) {
      const u = this.order[i];
      this.px[u] -= dx;
      this.py[u] -= dy;
      this.pz[u] -= dz;
      this.planeD[u] -= upDelta;
    }
  }

  update(dt, batch, camPos, windVec, up, time) {
    const { px, py, pz, vx, vy, vz, age, life, order, flags } = this;
    const cx = camPos.x;
    const cy = camPos.y;
    const cz = camPos.z;
    let alive = 0;
    const count = this.n;
    for (let i = 0; i < count; i++) {
      const u = order[i];
      if (age[u] < 0) {
        age[u] = 0;
      } else {
        age[u] += dt;
        if (age[u] >= life[u]) {
          this.free[this.freeTop++] = u;
          continue;
        }
        const dragK = 1 - Math.exp(-this.drag[u] * dt);
        const wK = this.wind[u];
        const grav = this.grav[u] * dt;
        vx[u] += (windVec.x * wK - vx[u]) * dragK - up.x * grav;
        vy[u] += (windVec.y * wK - vy[u]) * dragK - up.y * grav;
        vz[u] += (windVec.z * wK - vz[u]) * dragK - up.z * grav;
        const turb = this.turb[u];
        if (turb > 0) {
          const sd = this.seed[u];
          vx[u] += Math.sin(py[u] * 2.3 + sd + time * 1.7) * turb * dt;
          vz[u] += Math.cos(px[u] * 1.9 + sd * 1.3 + time * 1.3) * turb * dt;
          vy[u] += Math.sin(pz[u] * 2.1 + sd * 0.7 + time * 2.1) * turb * 0.4 * dt;
        }
        px[u] += vx[u] * dt;
        py[u] += vy[u] * dt;
        pz[u] += vz[u] * dt;
        this.rot[u] += this.rotv[u] * dt;

        const fl = flags[u];
        if (fl) {
          const h = px[u] * up.x + py[u] * up.y + pz[u] * up.z;
          const floorH = this.planeD[u] + 0.012;
          if (h < floorH) {
            if (fl & FLAG_KILL) {
              this.free[this.freeTop++] = u;
              continue;
            }
            const push = floorH - h;
            px[u] += up.x * push;
            py[u] += up.y * push;
            pz[u] += up.z * push;
            if (fl & FLAG_BOUNCE) {
              const vn = vx[u] * up.x + vy[u] * up.y + vz[u] * up.z;
              if (vn < 0) {
                const rest = 0.25 + (this.seed[u] % 1) * 0.3;
                const tx = vx[u] - up.x * vn;
                const ty = vy[u] - up.y * vn;
                const tz = vz[u] - up.z * vn;
                vx[u] = tx * 0.65 - up.x * vn * rest;
                vy[u] = ty * 0.65 - up.y * vn * rest;
                vz[u] = tz * 0.65 - up.z * vn * rest;
              }
            } else if (fl & FLAG_STOP) {
              vx[u] = 0;
              vy[u] = 0;
              vz[u] = 0;
            }
          }
        }
      }
      if (this.sorted) {
        const dx = px[u] - cx;
        const dy = py[u] - cy;
        const dz = pz[u] - cz;
        this.key[u] = dx * dx + dy * dy + dz * dz;
      }
      order[alive++] = u;
    }

    this.n = alive;
    if (this.sorted && alive > 1) {
      const key = this.key;
      for (let i = 1; i < alive; i++) {
        const id = order[i];
        const kv = key[id];
        let j = i - 1;
        while (j >= 0 && key[order[j]] < kv) {
          order[j + 1] = order[j];
          j--;
        }
        order[j + 1] = id;
      }
    }

    for (let i = 0; i < alive; i++) {
      const u = order[i];
      const t = age[u] / life[u];
      const rem = 1 - t;
      const ease = 1 - Math.pow(rem, this.sk[u]);
      const sz = this.s0[u] + (this.s1[u] - this.s0[u]) * ease;
      let alpha = this.a[u];
      const fin = this.fin[u];
      const fout = this.fout[u];
      if (fin > 0 && t < fin) alpha *= t / fin;
      if (t > fout) {
        const q = 1 - (t - fout) / (1 - fout);
        alpha *= q * q * (3 - 2 * q);
      }
      let cr = this.r[u];
      let cg = this.g[u];
      let cb = this.b[u];
      const ramp = this.ramp[u];
      if (ramp === 1) {
        cr *= Math.pow(rem, 0.5);
        cg *= Math.pow(rem, 1.4);
        cb *= Math.pow(rem, 3);
      } else if (ramp === 2) {
        const q = 1 - Math.pow(t, 1.6);
        const k = q * Math.sqrt(q);
        cr *= k;
        cg *= (0.22 + 0.78 * Math.pow(q, 1.3)) * k;
        cb *= (0.04 + 0.96 * Math.pow(q, 3.5)) * k;
      } else if (ramp === 3) {
        const q = 0.55 + 0.45 * Math.sin(time * 17 + this.seed[u] * 9);
        cr *= q;
        cg *= q * (0.6 + 0.4 * rem);
        cb *= q * rem;
      }
      const mode = this.mode[u];
      let ax = this.nx[u];
      let ay = this.ny[u];
      let az = this.nz[u];
      if (mode === 1) {
        const st = this.stretch[u];
        ax = vx[u] * st;
        ay = vy[u] * st;
        az = vz[u] * st;
      }
      if (!batch.push(px[u], py[u], pz[u], sz, ax, ay, az, this.rot[u], cr, cg, cb, alpha, this.frame[u], mode, t, this.shade[u])) {
        break;
      }
    }
  }
}

const TRACER_FIELDS = ['fx', 'fy', 'fz', 'dx', 'dy', 'dz', 'dist', 'speed', 'trav', 'len', 'width', 'r', 'g', 'b'];

class TracerPool {
  constructor(cap, rnd) {
    this.cap = cap;
    this.rnd = rnd;
    this.n = 0;
    const f = () => new Float32Array(cap);
    this.fx = f(); this.fy = f(); this.fz = f();
    this.dx = f(); this.dy = f(); this.dz = f();
    this.dist = f(); this.speed = f(); this.trav = f();
    this.len = f(); this.width = f();
    this.r = f(); this.g = f(); this.b = f();
    this.frames = new Uint8Array(cap);
  }

  clear() {
    this.n = 0;
  }

  shiftOrigin(dx, dy, dz) {
    for (let i = 0; i < this.n; i++) {
      this.fx[i] -= dx;
      this.fy[i] -= dy;
      this.fz[i] -= dz;
    }
  }

  add(from, to, r, g, b, speed, width) {
    let slot = this.n;
    if (slot >= this.cap) slot = 0; else this.n++;
    const cx = to.x - from.x;
    const cy = to.y - from.y;
    const cz = to.z - from.z;
    const len = Math.hypot(cx, cy, cz);
    if (len < 1e-3) {
      if (slot === this.n - 1) this.n--;
      return;
    }
    this.fx[slot] = from.x; this.fy[slot] = from.y; this.fz[slot] = from.z;
    this.dx[slot] = cx / len; this.dy[slot] = cy / len; this.dz[slot] = cz / len;
    this.dist[slot] = len;
    this.speed[slot] = speed;
    this.trav[slot] = 0;
    this.len[slot] = Math.min(Math.max(speed * 0.022, 2), 7);
    this.width[slot] = width;
    this.r[slot] = r; this.g[slot] = g; this.b[slot] = b;
    this.frames[slot] = 0;
  }

  update(dt, batch) {
    let count = this.n;
    for (let i = 0; i < count; i++) {
      const sp = this.speed[i];
      const dist = this.dist[i];
      const segLen = this.len[i];
      if (this.frames[i] === 0) {
        this.trav[i] = Math.min(dist, sp * Math.max(dt, 8e-3) * (0.35 + this.rnd() * 0.4));
      } else {
        this.trav[i] += sp * dt;
      }
      let head = Math.min(this.trav[i], dist);
      let tail = Math.max(0, this.trav[i] - segLen);
      if (tail >= dist) {
        if (this.frames[i] >= 2) {
          count--;
          if (i !== count) {
            for (const f of TRACER_FIELDS) this[f][i] = this[f][count];
            this.frames[i] = this.frames[count];
          }
          i--;
          continue;
        }
        tail = Math.max(0, dist - segLen * 0.5);
        head = dist;
      }
      this.frames[i] = Math.min(250, this.frames[i] + 1);
      const mid = (head + tail) * 0.5;
      const span = Math.max(head - tail, 0.05);
      const dx = this.dx[i];
      const dy = this.dy[i];
      const dz = this.dz[i];
      const w = this.width[i];
      const mx = this.fx[i] + dx * mid;
      const my = this.fy[i] + dy * mid;
      const mz = this.fz[i] + dz * mid;
      const cr = this.r[i];
      const cg = this.g[i];
      const cb = this.b[i];
      batch.push(mx, my, mz, w, dx * span, dy * span, dz * span, 0, cr, cg, cb, 1, FRAME_TRACER, 1, 0, 5);
      batch.push(mx, my, mz, w * 6, dx * span * 1.05, dy * span * 1.05, dz * span * 1.05, 0, cr * 0.04, cg * 0.032, cb * 0.028, 1, FRAME_TRACER, 1, 0, 28);
      batch.push(this.fx[i] + dx * head, this.fy[i] + dy * head, this.fz[i] + dz * head, w * 5, 0, 1, 0, 0, cr * 0.2, cg * 0.16, cb * 0.12, 1, FRAME_GLOW, 0, 0, 1);
    }
    this.n = count;
  }
}

const _m4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _vPos = new THREE.Vector3();
const _vScale = new THREE.Vector3();
const _vAxis = new THREE.Vector3();

function buildDebrisChipGeometry() {
  let geo = new THREE.BoxGeometry(1, 1, 1, 2, 1, 2);
  const pos = geo.attributes.position;
  let s = 1234.5;
  const rnd = () => {
    s = Math.sin(s * 12.9898 + 78.233) * 43758.5453;
    s -= Math.floor(s);
    return s;
  };
  const welded = new Map();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
    let pt = welded.get(key);
    if (!pt) {
      let x = pos.getX(i);
      let y = pos.getY(i);
      let z = pos.getZ(i);
      const pinch = Math.abs(x) > 0.49 && Math.abs(z) > 0.49 ? 0.72 + rnd() * 0.2 : 1;
      x = x * pinch + (rnd() - 0.5) * 0.14;
      z = z * pinch + (rnd() - 0.5) * 0.14;
      y = y * (0.8 + rnd() * 0.3) + (rnd() - 0.5) * 0.1;
      pt = [x, y, z];
      welded.set(key, pt);
    }
    pos.setXYZ(i, pt[0], pt[1], pt[2]);
  }
  geo = geo.toNonIndexed();
  geo.computeVertexNormals();
  return geo;
}

class DebrisPool {
  constructor(cap, rnd) {
    this.cap = cap;
    this.rnd = rnd;
    this.next = 0;
    this.live = 0;
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0.05 });
    mat.name = 'fx_debris';
    const mesh = new THREE.InstancedMesh(buildDebrisChipGeometry(), mat, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.name = 'fx_debris';
    mesh.visible = false;
    this.mesh = mesh;

    const f = () => new Float32Array(cap);
    this.px = f(); this.py = f(); this.pz = f();
    this.vx = f(); this.vy = f(); this.vz = f();
    this.ax = f(); this.ay = f(); this.az = f();
    this.ang = f(); this.spin = f();
    this.sx = f(); this.sy = f(); this.sz = f();
    this.age = f(); this.life = f(); this.planeD = f();
    this.state = new Uint8Array(cap);
    _m4.makeScale(0, 0, 0);
    for (let i = 0; i < cap; i++) _m4.toArray(mesh.instanceMatrix.array, i * 16);
  }

  clear() {
    this.state.fill(0);
    _m4.makeScale(0, 0, 0);
    for (let i = 0; i < this.cap; i++) _m4.toArray(this.mesh.instanceMatrix.array, i * 16);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.live = 0;
    this.mesh.visible = false;
  }

  shiftOrigin(dx, dy, dz, upDelta) {
    const arr = this.mesh.instanceMatrix.array;
    let dirty = false;
    for (let i = 0; i < this.cap; i++) {
      if (!this.state[i]) continue;
      this.px[i] -= dx;
      this.py[i] -= dy;
      this.pz[i] -= dz;
      this.planeD[i] -= upDelta;
      arr[i * 16 + 12] = this.px[i];
      arr[i * 16 + 13] = this.py[i];
      arr[i * 16 + 14] = this.pz[i];
      dirty = true;
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }

  add(x, y, z, vx, vy, vz, sx, sy, sz, r, g, b, life, planeD) {
    const slot = this.next;
    this.next = (slot + 1) % this.cap;
    if (!this.state[slot]) this.live++;
    this.px[slot] = x; this.py[slot] = y; this.pz[slot] = z;
    this.vx[slot] = vx; this.vy[slot] = vy; this.vz[slot] = vz;
    const ax = this.rnd() - 0.5;
    const ay = this.rnd() - 0.5;
    const az = this.rnd() - 0.5;
    const al = Math.hypot(ax, ay, az) || 1;
    this.ax[slot] = ax / al; this.ay[slot] = ay / al; this.az[slot] = az / al;
    this.ang[slot] = this.rnd() * 6.283;
    this.spin[slot] = (this.rnd() - 0.5) * 50;
    this.sx[slot] = sx; this.sy[slot] = sy; this.sz[slot] = sz;
    this.age[slot] = 0;
    this.life[slot] = life;
    this.planeD[slot] = planeD;
    this.state[slot] = 1;
    _vAxis.set(this.ax[slot], this.ay[slot], this.az[slot]);
    _quat.setFromAxisAngle(_vAxis, this.ang[slot]);
    _vPos.set(x, y, z);
    _vScale.set(sx, sy, sz);
    _m4.compose(_vPos, _quat, _vScale);
    _m4.toArray(this.mesh.instanceMatrix.array, slot * 16);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.visible = true;
    const col = this.mesh.instanceColor.array;
    col[slot * 3] = r;
    col[slot * 3 + 1] = g;
    col[slot * 3 + 2] = b;
    this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt, up) {
    const state = this.state;
    const arr = this.mesh.instanceMatrix.array;
    let live = 0;
    let dirty = false;
    for (let i = 0; i < this.cap; i++) {
      const st = state[i];
      if (!st) continue;
      this.age[i] += dt;
      const rem = this.life[i] - this.age[i];
      if (rem <= 0) {
        state[i] = 0;
        _m4.makeScale(0, 0, 0);
        _m4.toArray(arr, i * 16);
        dirty = true;
        continue;
      }
      live++;
      if (st === 2 && rem > 0.5) continue;
      if (st === 1) {
        const grav = 9.81 * dt;
        this.vx[i] -= up.x * grav;
        this.vy[i] -= up.y * grav;
        this.vz[i] -= up.z * grav;
        this.px[i] += this.vx[i] * dt;
        this.py[i] += this.vy[i] * dt;
        this.pz[i] += this.vz[i] * dt;
        this.ang[i] += this.spin[i] * dt;
        const floorH = this.planeD[i] + Math.min(this.sx[i], this.sy[i], this.sz[i]) * 0.5;
        const h = this.px[i] * up.x + this.py[i] * up.y + this.pz[i] * up.z;
        const vn = this.vx[i] * up.x + this.vy[i] * up.y + this.vz[i] * up.z;
        if (h < floorH && vn < 0) {
          const push = floorH - h;
          this.px[i] += up.x * push;
          this.py[i] += up.y * push;
          this.pz[i] += up.z * push;
          if (vn > -1.2) {
            state[i] = 2;
            this.vx[i] = 0; this.vy[i] = 0; this.vz[i] = 0;
          } else {
            const tx = this.vx[i] - up.x * vn;
            const ty = this.vy[i] - up.y * vn;
            const tz = this.vz[i] - up.z * vn;
            this.vx[i] = tx * 0.55 - up.x * vn * 0.32;
            this.vy[i] = ty * 0.55 - up.y * vn * 0.32;
            this.vz[i] = tz * 0.55 - up.z * vn * 0.32;
            this.spin[i] *= 0.5;
          }
        }
      }
      const sc = rem < 0.5 ? rem / 0.5 : 1;
      _vAxis.set(this.ax[i], this.ay[i], this.az[i]);
      _quat.setFromAxisAngle(_vAxis, this.ang[i]);
      _vPos.set(this.px[i], this.py[i], this.pz[i]);
      _vScale.set(this.sx[i] * sc, this.sy[i] * sc, this.sz[i] * sc);
      _m4.compose(_vPos, _quat, _vScale);
      _m4.toArray(arr, i * 16);
      dirty = true;
    }
    this.live = live;
    this.mesh.visible = live > 0;
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

class DecalRingBuffer {
  constructor(cap, rnd) {
    this.cap = cap;
    this.rnd = rnd;
    this.next = 0;
    this.count = 0;
    this.atlas = buildDecalAtlas(256);

    const geo = new THREE.BufferGeometry();
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.pos = new THREE.BufferAttribute(new Float32Array(cap * 12), 3);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    this.nor = new THREE.BufferAttribute(new Float32Array(cap * 12), 3);
    this.nor.setUsage(THREE.DynamicDrawUsage);
    this.uv = new THREE.BufferAttribute(new Float32Array(cap * 8), 2);
    this.uv.setUsage(THREE.DynamicDrawUsage);
    this.col = new THREE.BufferAttribute(new Float32Array(cap * 16), 4);
    this.col.setUsage(THREE.DynamicDrawUsage);
    this.baseA = new Float32Array(cap);

    geo.setAttribute('position', this.pos);
    geo.setAttribute('normal', this.nor);
    geo.setAttribute('uv', this.uv);
    geo.setAttribute('color', this.col);

    const idx = new Uint16Array(cap * 6);
    for (let i = 0; i < cap; i++) {
      const v = i * 4;
      const o = i * 6;
      idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2;
      idx[o + 3] = v; idx[o + 4] = v + 2; idx[o + 5] = v + 3;
    }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));

    const mat = new THREE.MeshStandardMaterial({
      map: this.atlas.map,
      roughnessMap: this.atlas.orm,
      metalnessMap: this.atlas.orm,
      roughness: 1,
      metalness: 1,
      transparent: true,
      vertexColors: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    if (this.atlas.nrm) {
      mat.normalMap = this.atlas.nrm;
      mat.normalScale = new THREE.Vector2(1, 1);
    }
    mat.name = 'fx_decals';

    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.renderOrder = -5;
    mesh.matrixAutoUpdate = false;
    mesh.name = 'fx_decals';
    mesh.visible = false;
    this.mesh = mesh;

    this.uvs = {};
    for (const key of Object.keys(DECAL_SLOTS)) {
      this.uvs[key] = DECAL_SLOTS[key].map((slot) => this.atlas.uv(slot));
    }
  }

  clear() {
    this.col.array.fill(0);
    this.pos.array.fill(0);
    this.col.needsUpdate = true;
    this.pos.needsUpdate = true;
    this.next = 0;
    this.count = 0;
    this.mesh.visible = false;
  }

  shiftOrigin(dx, dy, dz) {
    if (this.count === 0) return;
    const arr = this.pos.array;
    const active = this.count;
    for (let i = 0; i < active; i++) {
      const base = i * 12;
      for (let v = 0; v < 4; v++) {
        arr[base + v * 3] -= dx;
        arr[base + v * 3 + 1] -= dy;
        arr[base + v * 3 + 2] -= dz;
      }
    }
    this.pos.needsUpdate = true;
  }

  add(point, normal, kind, size, shade = 1, alpha = 1) {
    const frames = this.uvs[kind] || this.uvs.bullet_concrete;
    const rect = frames[(this.rnd() * frames.length) | 0];
    const half = (size || DECAL_SIZES[kind] || 0.25) * (0.85 + this.rnd() * 0.3) * 0.5;
    const slot = this.next;
    this.next = (slot + 1) % this.cap;
    if (this.count < this.cap) this.count++;

    let nx = normal.x;
    let ny = normal.y;
    let nz = normal.z;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;

    let tx;
    let ty;
    let tz;
    if (Math.abs(ny) > 0.9) { tx = 1; ty = 0; tz = 0; }
    else { tx = -nz; ty = 0; tz = nx; }
    const dot = tx * nx + ty * ny + tz * nz;
    tx -= nx * dot; ty -= ny * dot; tz -= nz * dot;
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;

    const bx = ny * tz - nz * ty;
    const by = nz * tx - nx * tz;
    const bz = nx * ty - ny * tx;
    const ang = kind === 'bullet_wood' ? (this.rnd() - 0.5) * 0.3 : this.rnd() * 6.283;
    const cs = Math.cos(ang);
    const sn = Math.sin(ang);
    const ux = (tx * cs + bx * sn) * half;
    const uy = (ty * cs + by * sn) * half;
    const uz = (tz * cs + bz * sn) * half;
    const vx = (bx * cs - tx * sn) * half;
    const vy = (by * cs - ty * sn) * half;
    const vz = (bz * cs - tz * sn) * half;

    const lift = 0.008 + (slot % 7) * 0.0005;
    const cx = point.x + nx * lift;
    const cy = point.y + ny * lift;
    const cz = point.z + nz * lift;

    const pArr = this.pos.array;
    const nArr = this.nor.array;
    const uArr = this.uv.array;
    const cArr = this.col.array;
    let o = slot * 12;
    pArr[o] = cx - ux - vx; pArr[o + 1] = cy - uy - vy; pArr[o + 2] = cz - uz - vz;
    pArr[o + 3] = cx + ux - vx; pArr[o + 4] = cy + uy - vy; pArr[o + 5] = cz + uz - vz;
    pArr[o + 6] = cx + ux + vx; pArr[o + 7] = cy + uy + vy; pArr[o + 8] = cz + uz + vz;
    pArr[o + 9] = cx - ux + vx; pArr[o + 10] = cy - uy + vy; pArr[o + 11] = cz - uz + vz;
    for (let v = 0; v < 4; v++) {
      nArr[o + v * 3] = nx;
      nArr[o + v * 3 + 1] = ny;
      nArr[o + v * 3 + 2] = nz;
    }

    o = slot * 8;
    uArr[o] = rect[0]; uArr[o + 1] = rect[1];
    uArr[o + 2] = rect[2]; uArr[o + 3] = rect[1];
    uArr[o + 4] = rect[2]; uArr[o + 5] = rect[3];
    uArr[o + 6] = rect[0]; uArr[o + 7] = rect[3];

    o = slot * 16;
    this.baseA[slot] = alpha;
    for (let v = 0; v < 4; v++) {
      cArr[o + v * 4] = shade;
      cArr[o + v * 4 + 1] = shade;
      cArr[o + v * 4 + 2] = shade;
      cArr[o + v * 4 + 3] = alpha;
    }

    const fadeSpan = Math.min(14, Math.floor(this.cap * 0.15));
    if (this.count >= this.cap && fadeSpan > 0) {
      for (let f = 0; f < fadeSpan; f++) {
        const old = (this.next + f) % this.cap;
        const faded = (this.baseA[old] * (f + 1)) / (fadeSpan + 1);
        const co = old * 16;
        cArr[co + 3] = faded;
        cArr[co + 7] = faded;
        cArr[co + 11] = faded;
        cArr[co + 15] = faded;
      }
    }

    this.pos.needsUpdate = true;
    this.nor.needsUpdate = true;
    this.uv.needsUpdate = true;
    this.col.needsUpdate = true;
    this.mesh.visible = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.atlas.map.dispose();
    this.atlas.orm.dispose();
    if (this.atlas.nrm) this.atlas.nrm.dispose();
  }
}

const _nrm = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _refl = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _pt = new THREE.Vector3();
const _camOrigin = new THREE.Vector3();
const _colorTmp = new THREE.Color();

function readRgb(input, dr, dg, db) {
  if (input == null) return [dr, dg, db];
  if (Array.isArray(input)) return [input[0], input[1], input[2]];
  if (input.isColor) return [input.r, input.g, input.b];
  if (input.isVector3) return [input.x, input.y, input.z];
  _colorTmp.set(input);
  return [_colorTmp.r, _colorTmp.g, _colorTmp.b];
}

function coneSample(axis, spread, rnd, out) {
  const rx = rnd() * 2 - 1;
  const ry = rnd() * 2 - 1;
  const rz = rnd() * 2 - 1;
  const rl = Math.hypot(rx, ry, rz) || 1;
  const k = (spread * Math.cbrt(rnd())) / rl;
  out.set(axis.x + rx * k, axis.y + ry * k, axis.z + rz * k);
  const len = out.length();
  return len < 1e-4 ? out.copy(axis) : out.multiplyScalar(1 / len);
}

export function createSaltlineFx({
  scene = null,
  maxParticles = 512,
  maxDecals = 120,
  seed = 0x5f37,
} = {}) {
  const rng = makeSeededNoise(seed).rnd;
  const randRange = (lo, hi) => lo + (hi - lo) * rng();

  const litCap = Math.max(64, maxParticles | 0);
  const addCap = Math.max(128, litCap * 2);
  const debrisCap = Math.min(256, Math.max(48, Math.round(litCap * 0.5)));
  const decalCap = Math.max(16, maxDecals | 0);

  const lighting = {
    sunDir: new THREE.Vector3(0.55, 0.76, 0.34).normalize(),
    sun: new THREE.Vector3(2.3, 2.15, 1.95),
    ambHi: new THREE.Vector3(0.22, 0.27, 0.34),
    ambLo: new THREE.Vector3(0.09, 0.095, 0.105),
    up: new THREE.Vector3(0, 1, 0),
  };
  const wind = new THREE.Vector3(-0.6, 0, 0.25);

  const litTex = buildLitAtlas(typeof document === 'undefined' ? 64 : 128);
  const addTex = buildAdditiveAtlas(typeof document === 'undefined' ? 64 : 128);

  const litBatch = createParticleBatch(litCap, {
    lit: true, tex: litTex, cols: LIT_COLS, rows: LIT_ROWS, renderOrder: 10, lighting,
  });
  const addBatch = createParticleBatch(addCap, {
    lit: false, tex: addTex, cols: ADD_COLS, rows: ADD_ROWS, renderOrder: 20, lighting,
  });

  const litPool = new ParticlePool(litCap, true, rng);
  const addPool = new ParticlePool(Math.max(64, addCap - 96), false, rng);
  const tracers = new TracerPool(32, rng);
  const debris = new DebrisPool(debrisCap, rng);
  const decals = new DecalRingBuffer(decalCap, rng);

  const root = new THREE.Group();
  root.name = 'saltline-fx';
  root.frustumCulled = false;
  root.add(decals.mesh, debris.mesh, litBatch.mesh, addBatch.mesh);
  if (scene) scene.add(root);

  let elapsed = 0;

  function contactPlaneFor(point, normal) {
    const up = lighting.up;
    const pDot = point.x * up.x + point.y * up.y + point.z * up.z;
    if (normal && (normal.x * up.x + normal.y * up.y + normal.z * up.z) > 0.45) {
      return pDot;
    }
    return pDot - 1.2;
  }

  function emitSmoke(x, y, z, vx, vy, vz, life, s0, s1, r, g, b, a, shade, drag, rise, windK, frame) {
    const u = litPool.emit(x, y, z, vx, vy, vz, life, s0, s1, lighting.up);
    if (u < 0) return -1;
    litPool.r[u] = r; litPool.g[u] = g; litPool.b[u] = b; litPool.a[u] = a;
    litPool.shade[u] = shade;
    litPool.drag[u] = drag;
    litPool.grav[u] = -rise;
    litPool.wind[u] = windK;
    litPool.turb[u] = 0.5;
    litPool.rot[u] = rng() * 6.283;
    litPool.rotv[u] = (rng() - 0.5) * 1.2;
    litPool.frame[u] = frame < 0 ? (rng() * 6) | 0 : frame;
    litPool.fin[u] = 0.06;
    litPool.fout[u] = 0.3;
    litPool.sk[u] = 2.5;
    return u;
  }

  function emitSpark(x, y, z, vx, vy, vz, life, size, r, g, b, flags, planeD) {
    const u = addPool.emit(x, y, z, vx, vy, vz, life, size, size * 0.5, lighting.up);
    if (u < 0) return -1;
    addPool.mode[u] = 1;
    addPool.frame[u] = FRAME_SPARK;
    addPool.stretch[u] = 0.03;
    addPool.grav[u] = 9.81;
    addPool.drag[u] = 0.9;
    addPool.ramp[u] = 1;
    addPool.r[u] = r * 0.6;
    addPool.g[u] = g * 0.6;
    addPool.b[u] = b * 0.6;
    addPool.fout[u] = 0.55;
    addPool.flags[u] = flags;
    addPool.planeD[u] = planeD;
    addPool.sk[u] = 1;
    return u;
  }

  function emitSparkBurst(point, axis, count, vMin, vMax, spread, lMin, lMax, r, g, b, flags, planeD, scale = 1) {
    for (let i = 0; i < count; i++) {
      coneSample(axis, spread, rng, _tmp);
      const sp = randRange(vMin, vMax) * (0.35 + 0.65 * rng()) * Math.sqrt(scale);
      emitSpark(
        point.x, point.y, point.z,
        _tmp.x * sp, _tmp.y * sp, _tmp.z * sp,
        randRange(lMin, lMax),
        randRange(0.01, 0.02) * scale,
        r * randRange(0.6, 1.2),
        g * randRange(0.6, 1.2),
        b,
        flags,
        planeD,
      );
    }
  }

  function emitFlash(x, y, z, life, s0, s1, r, g, b, frame) {
    const u = addPool.emit(x, y, z, 0, 0, 0, life, s0, s1, lighting.up);
    if (u < 0) return -1;
    addPool.frame[u] = frame;
    addPool.r[u] = r; addPool.g[u] = g; addPool.b[u] = b;
    addPool.fout[u] = 0.2;
    addPool.rot[u] = rng() * 6.283;
    addPool.sk[u] = 1.5;
    return u;
  }

  function emitSurfaceRing(x, y, z, normal, life, s0, s1, r, g, b) {
    const u = addPool.emit(x, y, z, 0, 0, 0, life, s0, s1, normal || lighting.up);
    if (u < 0) return -1;
    addPool.mode[u] = 2;
    addPool.frame[u] = FRAME_RING;
    addPool.r[u] = r; addPool.g[u] = g; addPool.b[u] = b;
    addPool.fout[u] = 0.15;
    addPool.fin[u] = 0.08;
    addPool.sk[u] = 2.2;
    addPool.rot[u] = rng() * 6.283;
    return u;
  }

  function emitDebrisBurst(point, axis, count, vMin, vMax, sx0, sx1, sy0, sy1, sz0, sz1, r, g, b, spread, planeD) {
    const up = lighting.up;
    for (let i = 0; i < count; i++) {
      coneSample(axis, spread, rng, _tmp);
      const sp = randRange(vMin, vMax);
      const shade = randRange(0.8, 1.15);
      debris.add(
        point.x + _tmp.x * 0.02,
        point.y + _tmp.y * 0.02,
        point.z + _tmp.z * 0.02,
        _tmp.x * sp + up.x * 0.8,
        _tmp.y * sp + up.y * 0.8,
        _tmp.z * sp + up.z * 0.8,
        randRange(sx0, sx1),
        randRange(sy0, sy1),
        randRange(sz0, sz1),
        r * shade, g * shade, b * shade,
        randRange(3.2, 5.5),
        planeD,
      );
    }
  }

  function emitDust(point, normal, scale = 1, r = 0.5, g = 0.48, b = 0.45) {
    _nrm.copy(normal || lighting.up);
    if (_nrm.lengthSq() < 1e-6) _nrm.copy(lighting.up);
    _nrm.normalize();
    for (let i = 0; i < 8; i++) {
      coneSample(_nrm, 0.5, rng, _tmp);
      const sp = randRange(1, 4.5) * scale;
      const sh = randRange(0.85, 1.1);
      emitSmoke(
        point.x + _nrm.x * 0.03, point.y + _nrm.y * 0.03, point.z + _nrm.z * 0.03,
        _tmp.x * sp, _tmp.y * sp, _tmp.z * sp,
        randRange(0.5, 1.1), 0.08 * scale, randRange(0.35, 0.7) * scale,
        r * sh, g * sh, b * sh, 0.9, 1, 3.5, 0.15, 0.6, i < 3 ? 7 : -1,
      );
    }
    for (let i = 0; i < 2; i++) {
      emitSmoke(
        point.x + _nrm.x * 0.15, point.y + _nrm.y * 0.15, point.z + _nrm.z * 0.15,
        _nrm.x * 0.5 + (rng() - 0.5) * 0.3,
        _nrm.y * 0.5 + (rng() - 0.5) * 0.3,
        _nrm.z * 0.5 + (rng() - 0.5) * 0.3,
        randRange(2.0, 3.4), 0.25 * scale, randRange(0.9, 1.5) * scale,
        r, g, b, 0.28, 1, 1.5, 0.1, 1, -1,
      );
    }
  }

  function splash(point, scale = 1, normal = null) {
    const up = _nrm.copy(normal || lighting.up);
    if (up.lengthSq() < 1e-6) up.copy(lighting.up);
    up.normalize();
    const planeD = point.x * lighting.up.x + point.y * lighting.up.y + point.z * lighting.up.z;

    for (let i = 0; i < 5; i++) {
      const sz = randRange(0.35, 0.6) * scale;
      const vel = randRange(1.6, 2.8) * Math.sqrt(scale);
      const u = emitSmoke(
        point.x + up.x * 0.1 * scale + (rng() - 0.5) * 0.08 * scale,
        point.y + up.y * 0.1 * scale + (rng() - 0.5) * 0.08 * scale,
        point.z + up.z * 0.1 * scale + (rng() - 0.5) * 0.08 * scale,
        up.x * vel + (rng() - 0.5) * 0.5,
        up.y * vel + (rng() - 0.5) * 0.5,
        up.z * vel + (rng() - 0.5) * 0.5,
        randRange(0.4, 0.65), sz * 0.3, sz,
        0.72, 0.78, 0.84, 0.95, 1, 0.5, -7, 0, 6,
      );
      if (u >= 0) {
        litPool.rot[u] = (rng() - 0.5) * 0.3;
        litPool.rotv[u] = 0;
        litPool.turb[u] = 0;
        litPool.sk[u] = 3;
        litPool.fout[u] = 0.4;
      }
    }
    for (let i = 0; i < 2; i++) {
      emitSmoke(
        point.x + up.x * 0.15 * scale,
        point.y + up.y * 0.15 * scale,
        point.z + up.z * 0.15 * scale,
        up.x * 0.5 + (rng() - 0.5) * 0.5,
        up.y * 0.5 + (rng() - 0.5) * 0.5,
        up.z * 0.5 + (rng() - 0.5) * 0.5,
        randRange(0.7, 1.1), 0.2 * scale, 0.7 * scale,
        0.7, 0.75, 0.8, 0.18, 1, 2, 0, 0.8, -1,
      );
    }
    const dropCount = Math.round(14 * Math.min(scale, 1.6));
    for (let i = 0; i < dropCount; i++) {
      coneSample(up, 0.75, rng, _tmp);
      const sp = randRange(1.5, 4.8) * Math.sqrt(scale);
      const u = addPool.emit(
        point.x + up.x * 0.03, point.y + up.y * 0.03, point.z + up.z * 0.03,
        _tmp.x * sp, _tmp.y * sp, _tmp.z * sp,
        randRange(0.5, 1), randRange(0.012, 0.024), 0.01, lighting.up,
      );
      if (u >= 0) {
        addPool.mode[u] = 1;
        addPool.frame[u] = FRAME_DROP;
        addPool.stretch[u] = 0.012;
        addPool.grav[u] = 9.81;
        addPool.drag[u] = 0.4;
        addPool.r[u] = 2.25;
        addPool.g[u] = 1.95;
        addPool.b[u] = 1.6;
        addPool.fout[u] = 0.7;
        addPool.flags[u] = FLAG_KILL;
        addPool.sk[u] = 1;
        addPool.planeD[u] = planeD;
      }
    }
    emitSurfaceRing(
      point.x + up.x * 0.012, point.y + up.y * 0.012, point.z + up.z * 0.012,
      up, 0.9, 0.12 * scale, 1.5 * scale, 0.38, 0.36, 0.32,
    );
    const r2 = emitSurfaceRing(
      point.x + up.x * 0.012, point.y + up.y * 0.012, point.z + up.z * 0.012,
      up, 1.3, 0.05 * scale, 1.0 * scale, 0.25, 0.24, 0.22,
    );
    if (r2 >= 0) addPool.fin[r2] = 0.35;
  }

  function sparks(point, normal, count = 12) {
    _nrm.copy(normal || lighting.up);
    if (_nrm.lengthSq() < 1e-6) _nrm.copy(lighting.up);
    _nrm.normalize();
    const planeD = contactPlaneFor(point, _nrm);
    emitSparkBurst(point, _nrm, count, 5, 18, 0.6, 0.15, 0.5, 36, 22, 9, FLAG_BOUNCE, planeD, 1);
    emitFlash(point.x, point.y, point.z, 0.05, 0.2, 0.35, 10, 6.5, 3, FRAME_GLOW);
  }

  function muzzleSmoke(point, dir, { scale = 1, count = 5 } = {}) {
    _dir.copy(dir || lighting.up);
    if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, -1);
    _dir.normalize();
    const sc = Math.max(0.25, scale);
    for (let i = 0; i < count; i++) {
      const fwd = (0.06 + i * 0.09) * sc;
      const spd = randRange(1.4, 3.8) * sc * (1 - i / Math.max(count + 1, 2));
      const u = emitSmoke(
        point.x + _dir.x * fwd + (rng() - 0.5) * 0.03 * sc,
        point.y + _dir.y * fwd + (rng() - 0.5) * 0.03 * sc,
        point.z + _dir.z * fwd + (rng() - 0.5) * 0.03 * sc,
        _dir.x * spd + (rng() - 0.5) * 0.35,
        _dir.y * spd + lighting.up.y * 0.22 + (rng() - 0.5) * 0.35,
        _dir.z * spd + (rng() - 0.5) * 0.35,
        randRange(0.45, 0.95),
        0.05 * sc,
        randRange(0.28, 0.55) * sc,
        0.54, 0.54, 0.56,
        0.22,
        1,
        3.2,
        0.35,
        0.8,
        -1,
      );
      if (u >= 0) litPool.fin[u] = 0.08;
    }
  }

  function muzzleFlash(point, dir, opts = {}) {
    const sc = opts.scale || 1;
    _dir.copy(dir || lighting.up);
    if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, -1);
    _dir.normalize();
    const [cr, cg, cb] = readRgb(opts.color, 1, 0.68, 0.32);
    emitFlash(point.x + _dir.x * 0.1 * sc, point.y + _dir.y * 0.1 * sc, point.z + _dir.z * 0.1 * sc, 0.045, 0.75 * sc, 1.15 * sc, 34 * cr, 34 * cg, 34 * cb, FRAME_BURST_A);
    emitFlash(point.x + _dir.x * 0.14 * sc, point.y + _dir.y * 0.14 * sc, point.z + _dir.z * 0.14 * sc, 0.035, 0.5 * sc, 0.85 * sc, 22 * cr, 22 * cg, 22 * cb, FRAME_BURST_B);
    emitFlash(point.x + _dir.x * 0.05 * sc, point.y + _dir.y * 0.05 * sc, point.z + _dir.z * 0.05 * sc, 0.045, 0.13 * sc, 0.2 * sc, 22, 22 * (cg + 0.25), 22 * (cb + 0.3), FRAME_GLOW);
    const jet = addPool.emit(
      point.x + _dir.x * 0.4 * sc, point.y + _dir.y * 0.4 * sc, point.z + _dir.z * 0.4 * sc,
      -_dir.x, -_dir.y, -_dir.z, 0.04, 0.11 * sc, 0.14 * sc, lighting.up,
    );
    if (jet >= 0) {
      addPool.mode[jet] = 1;
      addPool.frame[jet] = FRAME_TRACER;
      addPool.stretch[jet] = 0.9 * sc;
      addPool.r[jet] = 18 * cr; addPool.g[jet] = 18 * cg; addPool.b[jet] = 18 * cb;
      addPool.fout[jet] = 0.3;
    }
    muzzleSmoke(point, _dir, { scale: sc, count: 2 });
  }

  function impact(optsOrPoint, normalArg, surfaceArg = 'concrete', dirArg = null, enemyArg = false) {
    let point;
    let normal;
    let surface;
    let dir;
    let scale = 1;
    if (optsOrPoint && optsOrPoint.point) {
      point = optsOrPoint.point;
      normal = optsOrPoint.normal;
      surface = optsOrPoint.enemy ? 'enemy' : (optsOrPoint.surface || 'concrete');
      dir = optsOrPoint.dir || null;
      if (optsOrPoint.scale !== undefined) scale = optsOrPoint.scale;
    } else {
      point = optsOrPoint;
      normal = normalArg;
      surface = enemyArg ? 'enemy' : (surfaceArg || 'concrete');
      dir = dirArg;
    }
    if (!point) return;

    const sc = Math.max(0.25, scale);
    _pt.copy(point);
    _nrm.copy(normal || lighting.up);
    if (_nrm.lengthSq() < 1e-6) _nrm.copy(lighting.up);
    _nrm.normalize();

    if (dir && dir.lengthSq() > 1e-6) {
      _dir.copy(dir).normalize();
    } else {
      _dir.copy(_nrm).negate();
    }
    _refl.copy(_dir).addScaledVector(_nrm, -2 * _dir.dot(_nrm)).normalize();

    const planeD = contactPlaneFor(_pt, _nrm);
    const nx = _nrm.x;
    const ny = _nrm.y;
    const nz = _nrm.z;

    switch (surface) {
      case 'metal': {
        _tmp.copy(_refl).addScaledVector(_nrm, 0.6).normalize();
        _dir.copy(_tmp);
        emitSparkBurst(_pt, _dir, 18, 6, 24, 0.55, 0.1, 0.38, 40, 25, 10.5, 0, planeD, sc);
        emitSparkBurst(_pt, _dir, 2 + ((rng() * 2) | 0), 9, 18, 0.9, 0.7, 1.3, 32, 18, 7, FLAG_BOUNCE, planeD, sc);
        emitFlash(_pt.x + nx * 0.03, _pt.y + ny * 0.03, _pt.z + nz * 0.03, 0.05, 0.25 * sc, 0.45 * sc, 16, 11, 5.5, FRAME_GLOW);
        emitFlash(_pt.x + nx * 0.04, _pt.y + ny * 0.04, _pt.z + nz * 0.04, 0.04, 0.35 * sc, 0.5 * sc, 9, 6, 2.6, FRAME_BURST_A + ((rng() * 2) | 0));
        for (let i = 0; i < 2; i++) {
          emitSmoke(
            _pt.x + nx * 0.04, _pt.y + ny * 0.04, _pt.z + nz * 0.04,
            nx * 0.8 + (rng() - 0.5) * 0.5, ny * 0.8 + 0.2, nz * 0.8 + (rng() - 0.5) * 0.5,
            randRange(0.5, 0.9), 0.06 * sc, randRange(0.3, 0.5) * sc,
            0.4, 0.4, 0.41, 0.4, 1, 2.5, 0.3, 0.8, -1,
          );
        }
        emitDebrisBurst(_pt, _nrm, 2, 1.5, 4, 0.012 * sc, 0.03 * sc, 0.003 * sc, 0.005 * sc, 0.01 * sc, 0.025 * sc, 0.2, 0.21, 0.23, 0.8, planeD);
        decals.add(_pt, _nrm, 'bullet_metal', DECAL_SIZES.bullet_metal * sc);
        break;
      }
      case 'enemy': {
        _tmp.copy(_refl).addScaledVector(_nrm, 0.8).normalize();
        _dir.copy(_tmp);
        emitSparkBurst(_pt, _dir, 13, 5, 20, 0.9, 0.12, 0.45, 42, 29, 14, 0, planeD, sc);
        emitSparkBurst(_pt, _dir, 2, 6, 12, 1.0, 0.6, 1.1, 32, 18, 7, FLAG_BOUNCE, planeD, sc);
        emitFlash(_pt.x, _pt.y, _pt.z, 0.06, 0.3 * sc, 0.55 * sc, 18, 12, 6, FRAME_GLOW);
        emitFlash(_pt.x, _pt.y, _pt.z, 0.04, 0.3 * sc, 0.45 * sc, 8, 5, 2.4, FRAME_BURST_A + ((rng() * 2) | 0));
        for (let i = 0; i < 2; i++) {
          emitSmoke(
            _pt.x, _pt.y, _pt.z,
            nx * 0.5 + (rng() - 0.5) * 0.4, ny * 0.5 + 0.3, nz * 0.5 + (rng() - 0.5) * 0.4,
            randRange(0.6, 1.1), 0.06 * sc, randRange(0.3, 0.5) * sc,
            0.13, 0.13, 0.14, 0.65, 1, 2.2, 0.5, 0.9, -1,
          );
        }
        const orangeChip = rng() < 0.35;
        emitDebrisBurst(_pt, _nrm, 3, 2, 6, 0.012 * sc, 0.035 * sc, 0.004 * sc, 0.008 * sc, 0.012 * sc, 0.03 * sc, 0.6, orangeChip ? 0.2 : 0.62, orangeChip ? 0.05 : 0.64, 0.8, planeD);
        break;
      }
      case 'wood': {
        emitDust(_pt, _nrm, 0.75 * sc, 0.5, 0.42, 0.32);
        emitDebrisBurst(_pt, _nrm, 7, 2, 6, 0.004 * sc, 0.009 * sc, 0.03 * sc, 0.1 * sc, 0.004 * sc, 0.012 * sc, 0.62, 0.5, 0.33, 0.7, planeD);
        if (rng() < 0.3) emitFlash(_pt.x, _pt.y, _pt.z, 0.04, 0.1 * sc, 0.2 * sc, 3, 2, 1, FRAME_GLOW);
        decals.add(_pt, _nrm, 'bullet_wood', DECAL_SIZES.bullet_wood * sc);
        break;
      }
      case 'water': {
        splash(_pt, sc, _nrm);
        break;
      }
      case 'rubber':
      case 'dirt': {
        const isDirt = surface === 'dirt';
        const cr = isDirt ? 0.3 : 0.14;
        const cg = isDirt ? 0.25 : 0.14;
        const cb = isDirt ? 0.19 : 0.14;
        for (let i = 0; i < 5; i++) {
          coneSample(_nrm, 0.6, rng, _tmp);
          const sp = randRange(0.6, 2.6) * sc;
          emitSmoke(
            _pt.x + nx * 0.03, _pt.y + ny * 0.03, _pt.z + nz * 0.03,
            _tmp.x * sp, _tmp.y * sp, _tmp.z * sp,
            randRange(0.5, 1), 0.07 * sc, randRange(0.3, 0.55) * sc,
            cr, cg, cb, 0.85, 1, 3.5, 0.1, 0.6, i < 2 ? 7 : -1,
          );
        }
        emitDebrisBurst(_pt, _nrm, 3, 1.5, 4, 0.01 * sc, 0.03 * sc, 0.008 * sc, 0.02 * sc, 0.01 * sc, 0.03 * sc, cr * 0.8, cg * 0.8, cb * 0.8, 0.7, planeD);
        decals.add(_pt, _nrm, 'soot', 0.2 * sc, 1, 0.8);
        break;
      }
      case 'glass': {
        for (let i = 0; i < 12; i++) {
          coneSample(_nrm, 0.9, rng, _tmp);
          const sp = randRange(1.5, 6) * sc;
          const u = addPool.emit(_pt.x, _pt.y, _pt.z, _tmp.x * sp, _tmp.y * sp, _tmp.z * sp, randRange(0.4, 0.9), randRange(0.012, 0.02) * sc, 0.008 * sc, lighting.up);
          if (u >= 0) {
            addPool.mode[u] = 1;
            addPool.frame[u] = FRAME_DROP;
            addPool.stretch[u] = 0.01;
            addPool.grav[u] = 9.81;
            addPool.r[u] = 2.6; addPool.g[u] = 2.7; addPool.b[u] = 2.8;
            addPool.flags[u] = FLAG_KILL;
            addPool.planeD[u] = planeD;
            addPool.ramp[u] = 3;
          }
        }
        emitDebrisBurst(_pt, _nrm, 4, 1.5, 5, 0.01 * sc, 0.03 * sc, 0.002 * sc, 0.004 * sc, 0.01 * sc, 0.03 * sc, 0.62, 0.72, 0.74, 0.8, planeD);
        emitSmoke(_pt.x, _pt.y, _pt.z, nx * 0.6, ny * 0.6 + 0.2, nz * 0.6, 0.6, 0.08 * sc, 0.4 * sc, 0.75, 0.8, 0.82, 0.2, 1, 2.5, 0.2, 0.8, -1);
        decals.add(_pt, _nrm, 'bullet_glass', DECAL_SIZES.bullet_glass * sc);
        break;
      }
      case 'rock':
      case 'concrete':
      default: {
        const isRock = surface === 'rock';
        const dr = isRock ? 0.47 : 0.52;
        const dg = isRock ? 0.43 : 0.5;
        const db = isRock ? 0.38 : 0.47;
        emitDust(_pt, _nrm, sc, dr, dg, db);
        emitDebrisBurst(_pt, _nrm, 4, 1.5, 5.5, 0.012 * sc, 0.035 * sc, 0.008 * sc, 0.02 * sc, 0.012 * sc, 0.035 * sc, dr * 0.82, dg * 0.82, db * 0.82, 0.7, planeD);
        _tmp.copy(_refl).addScaledVector(_nrm, 0.7).normalize();
        _dir.copy(_tmp);
        for (let i = 0; i < 4; i++) {
          coneSample(_dir, 0.5, rng, _tmp);
          const sp = randRange(3, 9) * sc;
          const u = emitSmoke(
            _pt.x, _pt.y, _pt.z,
            _tmp.x * sp, _tmp.y * sp, _tmp.z * sp,
            randRange(0.25, 0.45), 0.03 * sc, 0.09 * sc,
            0.6, 0.58, 0.54, 0.7, 1, 2, -6, 0.2, 7,
          );
          if (u >= 0) litPool.turb[u] = 0;
        }
        if (rng() < 0.35) emitSparkBurst(_pt, _dir, 3, 4, 10, 0.6, 0.08, 0.2, 26, 15, 6, 0, planeD, sc);
        decals.add(_pt, _nrm, 'bullet_concrete', DECAL_SIZES.bullet_concrete * sc);
        break;
      }
    }
  }

  const emitters = Array.from({ length: 16 }, () => ({
    active: false,
    kind: 'smolder',
    pos: new THREE.Vector3(),
    acc: 0,
    ttl: 0,
    scale: 1,
    t: 0,
    stop() { this.active = false; },
  }));

  function spawnSmolder(x, y, z, ttl, scale) {
    for (const em of emitters) {
      if (!em.active) {
        em.active = true;
        em.kind = 'smolder';
        em.pos.set(x, y, z);
        em.acc = 0;
        em.ttl = ttl;
        em.scale = scale;
        em.t = 0;
        return em;
      }
    }
    return null;
  }

  function stepEmitters(dt) {
    const up = lighting.up;
    for (const em of emitters) {
      if (!em.active) continue;
      em.t += dt;
      if (em.t > em.ttl) {
        em.stop();
        continue;
      }
      if (em.kind === 'smolder') {
        const sc = em.scale;
        em.acc += dt * 9 * (1 - em.t / em.ttl);
        while (em.acc > 1) {
          em.acc -= 1;
          const sh = randRange(0.05, 0.11);
          const rise = randRange(1.2, 2.4);
          const u = emitSmoke(
            em.pos.x + (rng() - 0.5) * 0.5 * sc,
            em.pos.y + (rng() - 0.5) * 0.5 * sc,
            em.pos.z + (rng() - 0.5) * 0.5 * sc,
            up.x * rise + (rng() - 0.5) * 0.6,
            up.y * rise + (rng() - 0.5) * 0.6,
            up.z * rise + (rng() - 0.5) * 0.6,
            randRange(2.4, 3.8), 0.5 * sc, randRange(1.6, 2.6) * sc,
            sh, sh, sh, 0.6, 1, 1, 0.9, 1, -1,
          );
          if (u >= 0) {
            litPool.fin[u] = 0.12;
            litPool.turb[u] = 1;
          }
        }
      }
    }
  }

  function explosion(point, radius = 4) {
    if (!point) return;
    const up = lighting.up;
    const P = THREE.MathUtils.clamp((radius || 4) / 4, 0.35, 4);
    const Z = Math.sqrt(P);
    const planeD = point.x * up.x + point.y * up.y + point.z * up.z;
    const cx = point.x + up.x * 0.35 * P;
    const cy = point.y + up.y * 0.35 * P;
    const cz = point.z + up.z * 0.35 * P;

    // 1. Core flash + starburst
    emitFlash(cx, cy, cz, 0.055, 1.5 * P, 2.3 * P, 16, 13.5, 9.5, FRAME_GLOW);
    emitFlash(cx, cy, cz, 0.05, 2.6 * P, 4.2 * P, 7, 5, 2.4, FRAME_BURST_A + ((rng() * 2) | 0));
    emitFlash(cx, cy, cz, 0.3, 3.5 * P, 5.5 * P, 0.35, 0.2, 0.08, FRAME_GLOW);

    // 2. Billowing fireball lobes (lit emissive + additive core)
    const fireLobes = Math.round(13 + 5 * P);
    for (let i = 0; i < fireLobes; i++) {
      coneSample(up, 1.6, rng, _tmp);
      const uDot = _tmp.dot(up);
      if (uDot < -0.1) _tmp.addScaledVector(up, -1.5 * uDot).normalize();
      const sp = randRange(2.2, 7.5) * Z;
      const sh = randRange(0.7, 1.15);
      const u = litPool.emit(
        cx + _tmp.x * 0.3 * P, cy + _tmp.y * 0.3 * P, cz + _tmp.z * 0.3 * P,
        _tmp.x * sp + up.x * 1.4, _tmp.y * sp + up.y * 1.4, _tmp.z * sp + up.z * 1.4,
        randRange(0.55, 1.05), 0.85 * P, randRange(1.8, 2.7) * P, up,
      );
      if (u >= 0) {
        litPool.frame[u] = i % 4 === 0 ? 7 : (rng() * 6) | 0;
        litPool.ramp[u] = 2;
        litPool.r[u] = 5.8 * sh; litPool.g[u] = 2.4 * sh; litPool.b[u] = 0.5 * sh;
        litPool.a[u] = 0.96;
        litPool.shade[u] = 3; // >= 2 triggers hot emissive fire lobe in shader
        litPool.drag[u] = 4;
        litPool.grav[u] = -2.6;
        litPool.wind[u] = 0.6;
        litPool.turb[u] = 1.5;
        litPool.rot[u] = rng() * 6.283;
        litPool.rotv[u] = (rng() - 0.5) * 2.5;
        litPool.sk[u] = 3;
        litPool.fin[u] = 0;
        litPool.fout[u] = 0.6;
      }
    }
    for (let i = 0; i < 5; i++) {
      coneSample(up, 1.4, rng, _tmp);
      const sp = randRange(2, 5) * Z;
      const u = addPool.emit(
        cx + _tmp.x * 0.3 * P, cy + _tmp.y * 0.3 * P, cz + _tmp.z * 0.3 * P,
        _tmp.x * sp + up.x * 1.2, _tmp.y * sp + up.y * 1.2, _tmp.z * sp + up.z * 1.2,
        randRange(0.3, 0.55), 0.6 * P, randRange(1.2, 1.8) * P, up,
      );
      if (u >= 0) {
        addPool.frame[u] = FRAME_FIRE;
        addPool.ramp[u] = 2;
        addPool.r[u] = 2.4; addPool.g[u] = 1.1; addPool.b[u] = 0.3;
        addPool.drag[u] = 4;
        addPool.grav[u] = -2.5;
        addPool.rot[u] = rng() * 6.283;
        addPool.sk[u] = 3;
        addPool.fout[u] = 0.4;
      }
    }

    // 3. Expanding dark smoke + smolder tail
    const smokeCount = Math.round(11 + 5 * P);
    for (let i = 0; i < smokeCount; i++) {
      const fast = i % 2 === 0;
      coneSample(up, 1.4, rng, _tmp);
      const uDot = _tmp.dot(up);
      if (uDot < 0) _tmp.addScaledVector(up, -1.4 * uDot).normalize();
      const sp = (fast ? randRange(4.5, 9) : randRange(1.5, 5)) * Z;
      const sh = randRange(0.04, 0.1);
      const off = fast ? 0.75 : 0.3;
      const u = emitSmoke(
        cx + _tmp.x * off * P, cy + _tmp.y * off * P, cz + _tmp.z * off * P,
        _tmp.x * sp + up.x * 0.8, _tmp.y * sp + up.y * 0.8, _tmp.z * sp + up.z * 0.8,
        randRange(2.8, 4.8), (fast ? 0.8 : 1.2) * P, randRange(2.6, 4.2) * P,
        sh, sh * 0.95, sh * 0.9, fast ? 0.7 : 0.8, 1, 3.4, randRange(0.8, 1.7), 1, i % 3 === 0 ? 7 : -1,
      );
      if (u >= 0) {
        litPool.fin[u] = fast ? 0.025 : 0.16;
        litPool.fout[u] = 0.35;
        litPool.turb[u] = 1.2;
      }
    }
    spawnSmolder(point.x + up.x * 0.3 * P, point.y + up.y * 0.3 * P, point.z + up.z * 0.3 * P, 1.3 + 0.3 * P, P);

    // 4. Sparks + embers + 3D debris chunks
    const sparkCount = Math.min(80, Math.round(30 * P));
    for (let i = 0; i < sparkCount; i++) {
      coneSample(up, 1.5, rng, _tmp);
      const uDot = _tmp.dot(up);
      if (uDot < 0) _tmp.addScaledVector(up, -2 * uDot);
      const sp = randRange(6, 26) * Z;
      const u = emitSpark(
        point.x + up.x * 0.05, point.y + up.y * 0.05, point.z + up.z * 0.05,
        _tmp.x * sp, _tmp.y * sp, _tmp.z * sp,
        randRange(0.5, 1.5), randRange(0.014, 0.028), 40, 23, 8, FLAG_BOUNCE, planeD,
      );
      if (u >= 0) {
        addPool.drag[u] = 1.4;
        addPool.stretch[u] = 0.035;
      }
    }
    const emberCount = Math.round(10 * P);
    for (let i = 0; i < emberCount; i++) {
      coneSample(up, 1.2, rng, _tmp);
      const sp = randRange(1, 5);
      const u = addPool.emit(
        point.x + up.x * 0.3, point.y + up.y * 0.3, point.z + up.z * 0.3,
        _tmp.x * sp + up.x, _tmp.y * sp + up.y, _tmp.z * sp + up.z,
        randRange(1.4, 3), 0.035, 0.02, up,
      );
      if (u >= 0) {
        addPool.frame[u] = FRAME_GLOW;
        addPool.ramp[u] = 3;
        addPool.r[u] = 9; addPool.g[u] = 4; addPool.b[u] = 1;
        addPool.drag[u] = 1.2;
        addPool.grav[u] = 0.6;
        addPool.turb[u] = 3;
        addPool.wind[u] = 1;
        addPool.fout[u] = 0.5;
      }
    }
    _pt.copy(point).addScaledVector(up, 0.1);
    emitDebrisBurst(_pt, up, Math.round(12 + 6 * P), 4, 13 * Z, 0.04, 0.13, 0.025, 0.08, 0.04, 0.13, 0.07, 0.066, 0.062, 1.1, planeD);

    // 5. Shockwave ring + radial ground dust + scorch decal
    emitSurfaceRing(
      point.x + up.x * 0.02, point.y + up.y * 0.02, point.z + up.z * 0.02,
      up, 0.34, 0.6 * P, (radius * 2.1), 1.6, 1.2, 0.75,
    );
    const tAxis = Math.abs(up.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const tang = new THREE.Vector3().crossVectors(tAxis, up).normalize();
    const bitn = new THREE.Vector3().crossVectors(up, tang);
    const ringPuffs = Math.round(12 + 3 * P);
    for (let i = 0; i < ringPuffs; i++) {
      const ang = ((i + rng()) / ringPuffs) * 6.283;
      const cs = Math.cos(ang);
      const sn = Math.sin(ang);
      const rx = tang.x * cs + bitn.x * sn;
      const ry = tang.y * cs + bitn.y * sn;
      const rz = tang.z * cs + bitn.z * sn;
      const sp = randRange(5, 10) * Z;
      const sh = randRange(0.42, 0.55);
      const u = emitSmoke(
        point.x + rx * 0.4 * P + up.x * 0.2,
        point.y + ry * 0.4 * P + up.y * 0.2,
        point.z + rz * 0.4 * P + up.z * 0.2,
        rx * sp + up.x * 0.4, ry * sp + up.y * 0.4, rz * sp + up.z * 0.4,
        randRange(1.2, 2.2), 0.4 * P, randRange(1.2, 1.9) * P,
        sh, sh * 0.96, sh * 0.9, 0.26, 1, 3, 0.15, 0.7, -1,
      );
      if (u >= 0) litPool.fin[u] = 0.1;
    }
    decals.add(point, up, 'scorch', 2.3 * P, 1, 0.92);
  }

  function tracer(from, to, opts = {}) {
    if (!from || !to) return;
    const [cr, cg, cb] = readRgb(opts.color, 1, 0.8, 0.46);
    const intensity = opts.intensity || 16;
    tracers.add(from, to, cr * intensity, cg * intensity, cb * intensity, opts.speed || 260, opts.width || 0.024);
  }

  function setLighting({ sunDir, sunColor, skyColor, groundColor, up } = {}) {
    if (sunDir) {
      lighting.sunDir.set(sunDir.x, sunDir.y, sunDir.z);
      if (lighting.sunDir.lengthSq() > 1e-8) lighting.sunDir.normalize();
    }
    if (sunColor !== undefined && sunColor !== null) {
      const [r, g, b] = readRgb(sunColor, 1, 0.95, 0.88);
      const gain = Math.max(r, g, b) <= 1.2 ? 2.4 : 1.0;
      lighting.sun.set(r * gain, g * gain, b * gain);
    }
    if (skyColor !== undefined && skyColor !== null) {
      const [r, g, b] = readRgb(skyColor, 0.22, 0.27, 0.34);
      lighting.ambHi.set(r, g, b);
    }
    if (groundColor !== undefined && groundColor !== null) {
      const [r, g, b] = readRgb(groundColor, 0.09, 0.095, 0.105);
      lighting.ambLo.set(r, g, b);
    }
    if (up) {
      lighting.up.set(up.x, up.y, up.z);
      if (lighting.up.lengthSq() > 1e-8) lighting.up.normalize();
    }
  }

  function clear() {
    litPool.clear();
    addPool.clear();
    tracers.clear();
    debris.clear();
    decals.clear();
    for (const em of emitters) if (em.active) em.stop();
    litBatch.begin();
    litBatch.end();
    addBatch.begin();
    addBatch.end();
  }

  // Shifts active world-space particles/decals by -deltaVec3 when the
  // floating-origin camera moves by +deltaVec3 (clears on large teleports).
  function shiftOrigin(deltaVec3) {
    if (!deltaVec3) return;
    const dx = deltaVec3.x || 0;
    const dy = deltaVec3.y || 0;
    const dz = deltaVec3.z || 0;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 === 0) return;
    if (d2 > 500 * 500) {
      clear();
      return;
    }
    const upDelta = dx * lighting.up.x + dy * lighting.up.y + dz * lighting.up.z;
    litPool.shiftOrigin(dx, dy, dz, upDelta);
    addPool.shiftOrigin(dx, dy, dz, upDelta);
    tracers.shiftOrigin(dx, dy, dz);
    debris.shiftOrigin(dx, dy, dz, upDelta);
    decals.shiftOrigin(dx, dy, dz);
    for (const em of emitters) {
      if (em.active) {
        em.pos.x -= dx;
        em.pos.y -= dy;
        em.pos.z -= dz;
      }
    }
  }

  function update(dt, cameraPos = null) {
    const step = dt > 0 ? Math.min(dt, 0.25) : 0;
    elapsed += step;
    stepEmitters(step);
    const cam = cameraPos || _camOrigin.set(0, 0, 0);
    litBatch.begin();
    litPool.update(step, litBatch, cam, wind, lighting.up, elapsed);
    litBatch.end();

    addBatch.begin();
    addPool.update(step, addBatch, cam, wind, lighting.up, elapsed);
    tracers.update(step, addBatch);
    addBatch.end();

    debris.update(step, lighting.up);
  }

  function dispose() {
    clear();
    if (root.parent) root.parent.remove(root);
    litBatch.dispose();
    addBatch.dispose();
    litTex.dispose();
    addTex.dispose();
    debris.dispose();
    decals.dispose();
  }

  return {
    root,
    wind,
    impact,
    sparks,
    muzzleSmoke,
    muzzleFlash,
    tracer,
    explosion,
    splash,
    decal(point, normal, kind = 'bullet_concrete', size) {
      _nrm.copy(normal || lighting.up);
      if (_nrm.lengthSq() < 1e-6) _nrm.copy(lighting.up);
      _nrm.normalize();
      decals.add(point, _nrm, kind, size);
    },
    shiftOrigin,
    clear,
    setLighting,
    update,
    dispose,
    stats() {
      return {
        lit: litPool.n,
        add: addPool.n,
        tracers: tracers.n,
        debris: debris.live,
        decals: decals.count,
      };
    },
  };
}
