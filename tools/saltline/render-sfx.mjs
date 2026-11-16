#!/usr/bin/env node
// Render Saltline synthesized sounds to WAV for listening outside the game.
//
//   node tools/saltline/render-sfx.mjs --list
//   node tools/saltline/render-sfx.mjs <name> [variant] --out file.wav
//   node tools/saltline/render-sfx.mjs --demo --out pac9-demo.wav
//        (an 8-round burst with tails and casings, then a tactical reload)
import fs from 'node:fs';
import { renderSound, SOUND_TABLE } from '../../src/saltline/sfx-generators.js';

const argv = process.argv.slice(2);
const outIndex = argv.indexOf('--out');
const out = outIndex >= 0 ? argv[outIndex + 1] : null;

function writeWav(path, channels, sr) {
  const frames = channels[0].length, nch = channels.length;
  const data = Buffer.alloc(frames * nch * 2);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]));
      data.writeInt16LE(Math.round(v * 32767), (i * nch + c) * 2);
    }
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(nch, 22);
  header.writeUInt32LE(sr, 24); header.writeUInt32LE(sr * nch * 2, 28); header.writeUInt16LE(nch * 2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(path, Buffer.concat([header, data]));
}

// mix (name, variant, time s, gain) events into a stereo 44.1 kHz buffer
function mix(events, seconds) {
  const sr = 44100, L = new Float32Array(Math.ceil(seconds * sr)), R = new Float32Array(L.length);
  for (const [name, variant, at, gain] of events) {
    const s = renderSound(name, variant);
    const step = s.sr / sr;
    const len = Math.floor(s.ch[0].length / step);
    const l = s.ch[0], r = s.ch[1] || s.ch[0];
    for (let i = 0, o = Math.round(at * sr); i < len && o + i < L.length; i++) {
      const x = i * step, k = Math.floor(x), f = x - k;
      L[o + i] += gain * (l[k] + ((l[k + 1] ?? l[k]) - l[k]) * f);
      R[o + i] += gain * (r[k] + ((r[k + 1] ?? r[k]) - r[k]) * f);
    }
  }
  let peak = 0;
  for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const k = peak > 0.95 ? 0.95 / peak : 1;
  for (let i = 0; i < L.length; i++) { L[i] *= k; R[i] *= k; }
  return { channels: [L, R], sr };
}

if (argv.includes('--list')) {
  for (const [name, def] of Object.entries(SOUND_TABLE)) console.log(`${name.padEnd(16)} variants ${def.n}${def.loop ? ' loop' : ''}${def.music ? ' music' : ''}`);
} else if (argv.includes('--demo')) {
  const events = [];
  for (let i = 0; i < 8; i++) {
    const t = 0.3 + i * (60 / 720);
    events.push(['rifle_shot', i % 4, t, 1], ['rifle_tail_out', i % 2, t, 0.8]);
    if (i % 2 === 0) events.push(['shell_bounce', i % 3, t + 0.5 + (i % 3) * 0.07, 0.5]);
  }
  const r = 2.2; // reload starts; phases as in the PAC-9 controller
  events.push(['reload_magout', 0, r + 0.47, 1], ['reload_magin', 0, r + 1.345, 1]);
  events.push(['rifle_dry', 0, r + 3.0, 1]);
  const { channels, sr } = mix(events, r + 3.6);
  writeWav(out || 'pac9-demo.wav', channels, sr);
  console.log(`wrote ${out || 'pac9-demo.wav'}`);
} else {
  const name = argv.find((a) => !a.startsWith('--') && a !== out);
  const variant = Number(argv.find((a, i) => i > argv.indexOf(name) && /^\d+$/.test(a)) || 0);
  const s = renderSound(name, variant);
  if (!s) { console.error(`unknown sound "${name}" (see --list)`); process.exit(1); }
  writeWav(out || `${name}-${variant}.wav`, s.ch, s.sr);
  console.log(`wrote ${out || `${name}-${variant}.wav`}`);
}
