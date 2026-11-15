// Deep-space reflection probe for the ship (legacy render look only: the
// radiance path hands the hull the universe's own environment instead).
import * as THREE from 'three';
import { makeRng } from '../rng.js';
import { getSharedPmremGenerator } from '../shared-pmrem.js';

/** Procedural HDRI-ish environment: deep space with a hot key star,
 *  a cool rim fill and a planetary bounce. Drives all metal specular. */
export function buildEnvironment(renderer, seed = 'HALCYON-VII') {
  const pmrem = getSharedPmremGenerator(renderer);
  const rand = makeRng(`${seed}:legacy-ship-environment:v1`);

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
    const x = rand() * size * 2;
    const y = size * (0.15 + rand() * 0.7);
    blob(x, y, 90 + rand() * 240, 'rgba(52,86,150,A)', 0.16);
  }
  for (let i = 0; i < 14; i++) {
    blob(rand() * size * 2, size * (0.2 + rand() * 0.6), 80 + rand() * 200,
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
    const x = rand() * size * 2, y = rand() * size;
    const a = rand() * 0.8;
    g.fillStyle = `rgba(255,255,255,${a})`;
    g.fillRect(x, y, 1, 1);
  }

  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  const env = pmrem.fromEquirectangular(t).texture;
  t.dispose();
  return env;
}
