// Canvas textures — ported 1:1 from 3aaa-spaceship-flight-prototype/src/game/textures.ts
// (types stripped only; logic, constants and comments unchanged).
import * as THREE from 'three';

/* ------------------------------------------------------------------ *
 *  CANVAS TEXTURES  —  what is left of the procedural foundry.
 *
 *  The hull plating, deck plate and wall liner generators that used to
 *  live here are gone: they are baked tiles now (see baked.js).  A
 *  procedural field is evaluated once per pixel and has no mip chain, so
 *  it cannot be prefiltered and shimmers at distance — which was a large
 *  part of what made the ship read as a toy.
 *
 *  What remains is the case canvas is genuinely right for: emissive
 *  imagery that has to be authored, is viewed roughly head-on, and never
 *  needs to tile — avionics displays and light-cove gradients.
 * ------------------------------------------------------------------ */

function cvs(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  return { c, g };
}

function tex(c, repeat = 1, srgb = false) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** deterministic RNG so the screen layouts are identical every load */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Glowing avionics display */
export function screenTexture(kind, size = 512) {
  const { c, g } = cvs(size);
  const rand = rng(1000 + kind * 77);
  g.fillStyle = '#03080e'; g.fillRect(0, 0, size, size);
  const accent = ['#5fe6ff', '#7dffc4', '#ffb35c', '#ff7a6b'][kind % 4];
  g.strokeStyle = 'rgba(90,160,190,0.20)'; g.lineWidth = 1;
  for (let i = 0; i <= 16; i++) {
    const p = (i / 16) * size;
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, size); g.stroke();
    g.beginPath(); g.moveTo(0, p); g.lineTo(size, p); g.stroke();
  }
  g.strokeStyle = accent; g.lineWidth = 3;
  g.strokeRect(14, 14, size - 28, size - 28);
  g.fillStyle = accent;
  g.fillRect(14, 14, 140, 22);

  if (kind % 4 === 0) {
    // radar sweep
    const cx = size / 2, cy = size / 2;
    g.strokeStyle = accent; g.lineWidth = 2;
    for (let r = 40; r < size / 2 - 30; r += 44) {
      g.globalAlpha = 0.5; g.beginPath(); g.arc(cx, cy, r, 0, 7); g.stroke();
    }
    g.globalAlpha = 1;
    g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + 180, cy - 120); g.stroke();
    for (let i = 0; i < 9; i++) {
      g.fillStyle = i % 3 ? accent : '#ff6b5c';
      const a = rand() * 7, r = 30 + rand() * 190;
      g.beginPath(); g.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 5, 0, 7); g.fill();
    }
  } else if (kind % 4 === 1) {
    // bar graphs + waveform
    for (let i = 0; i < 12; i++) {
      const h = 30 + rand() * 200;
      g.fillStyle = accent; g.globalAlpha = 0.35 + rand() * 0.6;
      g.fillRect(40 + i * 36, size - 60 - h, 24, h);
    }
    g.globalAlpha = 1;
    g.strokeStyle = accent; g.lineWidth = 3; g.beginPath();
    for (let x = 20; x < size - 20; x += 6) {
      const y = 120 + Math.sin(x * 0.05) * 40 + Math.sin(x * 0.13) * 18;
      x === 20 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.stroke();
  } else if (kind % 4 === 2) {
    // schematic
    g.strokeStyle = accent; g.lineWidth = 3; g.globalAlpha = 0.85;
    g.beginPath();
    g.moveTo(size / 2, 70); g.lineTo(size - 90, size - 110);
    g.lineTo(size / 2, size - 160); g.lineTo(90, size - 110); g.closePath(); g.stroke();
    g.globalAlpha = 0.2; g.fillStyle = accent; g.fill();
    g.globalAlpha = 1;
    for (let i = 0; i < 5; i++) {
      g.fillStyle = accent;
      g.fillRect(40, 60 + i * 26, 20 + rand() * 90, 10);
    }
  } else {
    // text readout
    for (let i = 0; i < 16; i++) {
      g.fillStyle = accent; g.globalAlpha = 0.35 + rand() * 0.55;
      g.fillRect(40, 60 + i * 26, 60 + rand() * 330, 11);
    }
    g.globalAlpha = 1;
  }
  // scanlines
  g.globalAlpha = 0.16; g.fillStyle = '#000';
  for (let y = 0; y < size; y += 4) g.fillRect(0, y, size, 2);
  g.globalAlpha = 1;
  const t = tex(c, 1, true);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** small emissive strip used for interior lighting coves */
export function gradientStrip(color = '#9fd8ff') {
  const { c, g } = cvs(64);
  const grd = g.createLinearGradient(0, 0, 0, 64);
  grd.addColorStop(0, '#000');
  grd.addColorStop(0.35, color);
  grd.addColorStop(0.65, color);
  grd.addColorStop(1, '#000');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  return tex(c, 1, true);
}
