// Flight-deck display faces for the HALCYON VII.
//
// Each multi-function display gets its own page, drawn once to a canvas at
// the screen's true aspect: a primary flight display, a tactical plot, a
// system chart, a ship status page and a comms stack.  They share one frame
// (title bar, soft-key row) and one four-colour language, the way a real
// avionics suite does — cyan for data, amber for the selected or own-ship
// item, green for nominal, red for a fault.
import * as THREE from 'three';

const INK = '#6fe3ff', AMBER = '#ffb454', GREEN = '#7dffb0', RED = '#ff5a4a';
const DIM = 'rgba(111,227,255,0.38)', GRID = 'rgba(111,227,255,0.13)', BG = '#02070b';
const FONT = (px, weight = 600) => `${weight} ${px}px "Segoe UI", "Helvetica Neue", Arial, sans-serif`;

/** deterministic RNG so the pages are identical every load */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** plan outline of the ship, starboard half: [x, z] in metres, nose at -z */
export const SHIP_PLAN = [
  [0, -16.4], [0.12, -15.6], [1.0, -14.2], [2.1, -11.0], [2.3, -8.6], [4.6, -6.6], [4.6, -5.6],
  [2.75, -5.1], [3.3, -1.0], [3.55, 0.4], [4.5, 0.5], [4.8, 1.6], [10.7, 7.9], [10.8, 9.5],
  [10.6, 9.3], [4.8, 8.0], [4.8, 10.5], [4.5, 11.7], [2.75, 11.7], [2.45, 10.4], [2.5, 11.0], [0, 11.0],
];

function planPath(g, cx, cy, scale) {
  g.beginPath();
  SHIP_PLAN.forEach(([x, z], i) => (i ? g.lineTo(cx + x * scale, cy + z * scale) : g.moveTo(cx + x * scale, cy + z * scale)));
  for (let i = SHIP_PLAN.length - 1; i >= 0; i--) g.lineTo(cx - SHIP_PLAN[i][0] * scale, cy + SHIP_PLAN[i][1] * scale);
  g.closePath();
}

function text(g, s, x, y, px, color = INK, align = 'left', weight = 600) {
  g.font = FONT(px, weight);
  g.fillStyle = color;
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.fillText(s, x, y);
}

function frame(g, W, H, title, keys) {
  g.fillStyle = BG;
  g.fillRect(0, 0, W, H);
  g.strokeStyle = GRID;
  g.lineWidth = 1;
  for (let x = 0; x <= W; x += 64) { g.beginPath(); g.moveTo(x, 56); g.lineTo(x, H - 56); g.stroke(); }
  for (let y = 56; y <= H - 56; y += 64) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
  g.fillStyle = 'rgba(111,227,255,0.10)';
  g.fillRect(0, 0, W, 50);
  g.fillStyle = INK;
  g.fillRect(0, 50, W, 2);
  text(g, title, 22, 26, 26, INK, 'left', 700);
  text(g, 'HX-2291', W - 22, 26, 22, DIM, 'right');
  const n = keys.length, kw = W / n;
  g.fillStyle = INK;
  g.fillRect(0, H - 52, W, 2);
  keys.forEach((k, i) => {
    const on = k.startsWith('*');
    if (on) { g.fillStyle = 'rgba(255,180,84,0.20)'; g.fillRect(i * kw + 4, H - 46, kw - 8, 40); }
    text(g, on ? k.slice(1) : k, i * kw + kw / 2, H - 25, 20, on ? AMBER : DIM, 'center');
    if (i) { g.fillStyle = GRID; g.fillRect(i * kw, H - 50, 1, 50); }
  });
}

function attitude(g, W, H) {
  frame(g, W, H, 'PFD', ['*ATT', 'HSI', 'VNAV', 'APP', 'TCAS', 'MENU']);
  const cx = W / 2, cy = H / 2 + 4, R = Math.min(W * 0.27, H * 0.33);
  g.save();
  g.beginPath(); g.rect(cx - R * 1.25, cy - R, R * 2.5, R * 2); g.clip();
  g.translate(cx, cy); g.rotate(-0.10);
  const pitch = 26;
  g.fillStyle = '#0c2a44'; g.fillRect(-W, -H + pitch, W * 2, H);
  g.fillStyle = '#2a1c10'; g.fillRect(-W, pitch, W * 2, H);
  g.strokeStyle = '#e8f6ff'; g.lineWidth = 3;
  g.beginPath(); g.moveTo(-W, pitch); g.lineTo(W, pitch); g.stroke();
  g.lineWidth = 2;
  for (let d = -30; d <= 30; d += 5) {
    if (!d) continue;
    const y = pitch - d * 7, w = d % 10 ? 28 : 62;
    g.beginPath(); g.moveTo(-w, y); g.lineTo(w, y); g.stroke();
    if (d % 10 === 0) { text(g, String(Math.abs(d)), -w - 10, y, 18, '#e8f6ff', 'right'); text(g, String(Math.abs(d)), w + 10, y, 18, '#e8f6ff'); }
  }
  g.restore();
  g.strokeStyle = INK; g.lineWidth = 2; g.strokeRect(cx - R * 1.25, cy - R, R * 2.5, R * 2);
  // own-ship symbol and roll scale
  g.strokeStyle = AMBER; g.lineWidth = 5;
  g.beginPath(); g.moveTo(cx - 110, cy); g.lineTo(cx - 38, cy); g.lineTo(cx - 38, cy + 16);
  g.moveTo(cx + 110, cy); g.lineTo(cx + 38, cy); g.lineTo(cx + 38, cy + 16); g.stroke();
  g.fillStyle = AMBER; g.fillRect(cx - 5, cy - 5, 10, 10);
  g.strokeStyle = INK; g.lineWidth = 2;
  g.beginPath(); g.arc(cx, cy, R * 0.92, -Math.PI * 0.82, -Math.PI * 0.18); g.stroke();
  for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
    const t = (a - 90) * Math.PI / 180, r0 = R * 0.92, r1 = r0 + (a % 30 ? 10 : 18);
    g.beginPath(); g.moveTo(cx + Math.cos(t) * r0, cy + Math.sin(t) * r0); g.lineTo(cx + Math.cos(t) * r1, cy + Math.sin(t) * r1); g.stroke();
  }
  // speed and altitude tapes
  const tape = (x, label, value, step, unit) => {
    const w = W * 0.13, top = cy - R, h = R * 2;
    g.fillStyle = 'rgba(2,7,11,0.86)'; g.fillRect(x, top, w, h);
    g.strokeStyle = INK; g.strokeRect(x, top, w, h);
    for (let i = -4; i <= 4; i++) {
      const y = cy - i * (h / 9);
      g.fillStyle = DIM; g.fillRect(x + (x < cx ? w - 14 : 0), y - 1, 14, 2);
      if (i) text(g, String(value + i * step), x + w / 2, y, 19, DIM, 'center');
    }
    g.fillStyle = BG; g.fillRect(x - 4, cy - 22, w + 8, 44);
    g.strokeStyle = AMBER; g.lineWidth = 2; g.strokeRect(x - 4, cy - 22, w + 8, 44);
    text(g, String(value), x + w / 2, cy, 27, AMBER, 'center', 700);
    text(g, label, x + w / 2, top - 18, 18, INK, 'center');
    text(g, unit, x + w / 2, top + h + 18, 16, DIM, 'center');
  };
  tape(cx - R * 1.25 - W * 0.13 - 14, 'SPD', 412, 20, 'M/S');
  tape(cx + R * 1.25 + 14, 'ALT', 8620, 100, 'KM');
  text(g, 'HDG 274', cx, cy + R + 24, 22, GREEN, 'center');
  text(g, 'AP  ATT HOLD', 24, 78, 19, GREEN);
  text(g, 'G 1.02', W - 24, 78, 19, INK, 'right');
}

function radar(g, W, H) {
  frame(g, W, H, 'TACTICAL', ['RNG-', 'RNG+', '*PLOT', 'IFF', 'TRK', 'MENU']);
  const rand = rng(41), cx = W * 0.44, cy = H / 2 + 2, R = Math.min(W * 0.36, H * 0.38);
  const sweep = g.createConicGradient(-0.9, cx, cy);
  sweep.addColorStop(0, 'rgba(111,227,255,0.30)'); sweep.addColorStop(0.12, 'rgba(111,227,255,0)'); sweep.addColorStop(1, 'rgba(111,227,255,0)');
  g.fillStyle = sweep; g.beginPath(); g.arc(cx, cy, R, 0, 7); g.fill();
  g.strokeStyle = DIM; g.lineWidth = 2;
  [0.25, 0.5, 0.75, 1].forEach((k, i) => {
    g.beginPath(); g.arc(cx, cy, R * k, 0, 7); g.stroke();
    text(g, `${(i + 1) * 5}`, cx + 6, cy - R * k + 12, 16, DIM);
  });
  for (let a = 0; a < 360; a += 10) {
    const t = a * Math.PI / 180, r1 = R + (a % 30 ? 8 : 16);
    g.beginPath(); g.moveTo(cx + Math.sin(t) * R, cy - Math.cos(t) * R); g.lineTo(cx + Math.sin(t) * r1, cy - Math.cos(t) * r1); g.stroke();
    if (a % 90 === 0) text(g, String(a).padStart(3, '0'), cx + Math.sin(t) * (R + 34), cy - Math.cos(t) * (R + 30), 17, INK, 'center');
  }
  g.beginPath(); g.moveTo(cx - R, cy); g.lineTo(cx + R, cy); g.moveTo(cx, cy - R); g.lineTo(cx, cy + R); g.stroke();
  g.fillStyle = AMBER; planPath(g, cx, cy, R * 0.011); g.fill();
  const rows = [];
  for (let i = 0; i < 7; i++) {
    const a = rand() * 7, r = (0.2 + rand() * 0.75) * R, x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    const hostile = i === 2, col = hostile ? RED : i % 3 ? INK : GREEN;
    g.strokeStyle = col; g.lineWidth = 2.5;
    g.beginPath();
    if (hostile) { g.moveTo(x, y - 10); g.lineTo(x + 10, y); g.lineTo(x, y + 10); g.lineTo(x - 10, y); g.closePath(); } else g.rect(x - 7, y - 7, 14, 14);
    g.stroke();
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a * 3) * 22, y + Math.sin(a * 3) * 22); g.stroke();
    const id = `T${String(11 + i * 7).padStart(2, '0')}`;
    text(g, id, x + 12, y - 12, 15, col);
    rows.push([id, `${(r / R * 20).toFixed(1)}`, col]);
  }
  const lx = W * 0.83;
  text(g, 'TRK   RNG', lx, 84, 17, DIM, 'center');
  rows.forEach(([id, d, col], i) => text(g, `${id}   ${d.padStart(4, ' ')}`, lx, 116 + i * 30, 19, col, 'center'));
}

function nav(g, W, H) {
  frame(g, W, H, 'NAV  /  SYSTEM', ['SYS', '*ROUTE', 'WPT', 'ORB', 'FUEL', 'MENU']);
  const sx = W * 0.26, sy = H * 0.52;
  const glow = g.createRadialGradient(sx, sy, 0, sx, sy, 60);
  glow.addColorStop(0, 'rgba(255,214,150,0.95)'); glow.addColorStop(0.3, 'rgba(255,180,84,0.45)'); glow.addColorStop(1, 'rgba(255,180,84,0)');
  g.fillStyle = glow; g.beginPath(); g.arc(sx, sy, 60, 0, 7); g.fill();
  const orbits = [[0.20, 2.0, 5], [0.34, 4.1, 8], [0.50, 0.7, 12], [0.70, 5.3, 7]];
  const pts = [];
  orbits.forEach(([k, a, r], i) => {
    const rx = W * k, ry = H * k * 0.62;
    g.strokeStyle = DIM; g.lineWidth = 1.5;
    g.beginPath(); g.ellipse(sx, sy, rx, ry, 0, 0, 7); g.stroke();
    const x = sx + Math.cos(a) * rx, y = sy + Math.sin(a) * ry;
    pts.push([x, y]);
    g.fillStyle = i === 2 ? GREEN : INK; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    text(g, ['I', 'II', 'III', 'IV'][i], x + r + 8, y - r - 4, 17, DIM);
  });
  // route: own ship -> target
  const [ox, oy] = [pts[1][0] + 46, pts[1][1] - 30], [tx, ty] = pts[2];
  g.strokeStyle = AMBER; g.lineWidth = 2.5; g.setLineDash([12, 8]);
  g.beginPath(); g.moveTo(ox, oy); g.quadraticCurveTo((ox + tx) / 2, Math.min(oy, ty) - 70, tx, ty); g.stroke();
  g.setLineDash([]);
  g.beginPath(); g.moveTo(ox, oy - 11); g.lineTo(ox + 9, oy + 8); g.lineTo(ox - 9, oy + 8); g.closePath(); g.fillStyle = AMBER; g.fill();
  g.strokeRect(tx - 22, ty - 22, 44, 44);
  const lx = W * 0.72;
  g.fillStyle = 'rgba(2,7,11,0.82)'; g.fillRect(lx - 14, 70, W - lx, H - 140);
  text(g, 'ROUTE', lx, 92, 19, INK);
  [['DEP', 'II  ORBIT', DIM], ['WPT 1', '0.42 AU', INK], ['*DEST', 'III  0.91 AU', AMBER], ['ETA', '00:14:32', GREEN], ['dV', '3.18 KM/S', INK], ['FUEL', '71 %', GREEN]]
    .forEach(([k, v, col], i) => {
      text(g, k.replace('*', ''), lx, 132 + i * 44, 17, DIM);
      text(g, v, lx, 152 + i * 44, 21, col, 'left', 700);
    });
}

function systems(g, W, H) {
  frame(g, W, H, 'SHIP  STATUS', ['*SYS', 'PWR', 'ECLSS', 'HULL', 'DOORS', 'MENU']);
  const cx = W * 0.30, cy = H * 0.50 + 6, sc = (H - 150) / 28.5;
  planPath(g, cx, cy + 2.3 * sc, sc);
  g.fillStyle = 'rgba(111,227,255,0.10)'; g.fill();
  g.strokeStyle = INK; g.lineWidth = 2.5; g.stroke();
  const zone = (x, z, w, h, col, label) => {
    const X = cx + x * sc, Y = cy + (z + 2.3) * sc;
    g.strokeStyle = col; g.lineWidth = 2; g.strokeRect(X - w * sc / 2, Y - h * sc / 2, w * sc, h * sc);
    g.globalAlpha = 0.18; g.fillStyle = col; g.fillRect(X - w * sc / 2, Y - h * sc / 2, w * sc, h * sc); g.globalAlpha = 1;
    text(g, label, X, Y, 14, col, 'center');
  };
  zone(0, -8.0, 3.6, 4.4, GREEN, 'FLT');
  zone(0, -3.2, 2.6, 4.2, GREEN, 'MID');
  zone(0, 2.8, 4.2, 6.6, GREEN, 'HOLD');
  zone(0, 7.4, 3.4, 2.2, AMBER, 'RAMP');
  zone(-3.6, 6.0, 2.0, 9.0, GREEN, 'E1');
  zone(3.6, 6.0, 2.0, 9.0, GREEN, 'E2');
  const lx = W * 0.60, bw = W * 0.34;
  [['MAIN BUS', 0.92, GREEN, '28.1 V'], ['REACTOR', 0.74, GREEN, '74 %'], ['PROPELLANT', 0.71, GREEN, '71 %'], ['COOLANT', 0.46, AMBER, '46 %'],
    ['CABIN O2', 0.98, GREEN, '20.9 %'], ['HULL', 1.0, GREEN, '100 %'], ['SHIELD', 0.88, INK, '88 %']].forEach(([k, v, col, val], i) => {
    const y = 96 + i * ((H - 190) / 7);
    text(g, k, lx, y, 18, DIM);
    text(g, val, lx + bw, y, 19, col, 'right', 700);
    g.strokeStyle = GRID; g.lineWidth = 1; g.strokeRect(lx, y + 14, bw, 12);
    g.fillStyle = col; g.fillRect(lx + 2, y + 16, (bw - 4) * v, 8);
  });
}

function comms(g, W, H) {
  frame(g, W, H, 'COMMS', ['*VHF', 'DEEP', 'DATA', 'XPDR', 'REC', 'MENU']);
  const rand = rng(77);
  [['TRAFFIC', '121.500', GREEN, 4], ['APPROACH', '134.275', INK, 3], ['*COMPANY', '248.900', AMBER, 5], ['BEACON', '406.025', INK, 2], ['GUARD', '243.000', DIM, 0]]
    .forEach(([name, f, col, bars], i) => {
      const y = 100 + i * 62, on = name.startsWith('*');
      if (on) { g.fillStyle = 'rgba(255,180,84,0.13)'; g.fillRect(14, y - 26, W * 0.56, 52); }
      text(g, name.replace('*', ''), 30, y, 21, col, 'left', 700);
      text(g, f, W * 0.40, y, 23, col, 'right', 700);
      for (let b = 0; b < 5; b++) { g.fillStyle = b < bars ? col : GRID; g.fillRect(W * 0.44 + b * 12, y + 10 - b * 5, 8, 6 + b * 5); }
    });
  const x0 = W * 0.62, w = W * 0.34, y0 = 86, h = H - 172;
  g.strokeStyle = DIM; g.lineWidth = 1.5; g.strokeRect(x0, y0, w, h);
  text(g, 'RX  248.900', x0 + 10, y0 + 18, 16, AMBER);
  g.strokeStyle = AMBER; g.lineWidth = 2; g.beginPath();
  for (let i = 0; i <= 90; i++) {
    const x = x0 + 6 + (w - 12) * i / 90, env = Math.sin(i / 90 * Math.PI) * (0.35 + 0.65 * Math.abs(Math.sin(i * 0.21)));
    const y = y0 + h * 0.56 + (rand() - 0.5) * h * 0.62 * env;
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.stroke();
}

const PAGES = { attitude, radar, nav, systems, comms };
export const DISPLAY_PAGES = Object.keys(PAGES);

/** emissive page for one display, drawn at the screen's own aspect */
export function displayTexture(page, aspect = 1.5) {
  const W = 1024, H = Math.max(256, Math.round(W / aspect / 4) * 4);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  (PAGES[page] || systems)(g, W, H);
  // faint scanlines and a vignette: a panel, not a printout
  g.fillStyle = 'rgba(0,0,0,0.13)';
  for (let y = 0; y < H; y += 4) g.fillRect(0, y, W, 1.5);
  const v = g.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, W * 0.62);
  v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.42)');
  g.fillStyle = v; g.fillRect(0, 0, W, H);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}
