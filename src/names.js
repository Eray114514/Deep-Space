// Procedural names for systems and planets, NMS flavoured.

const ONSET = ['k', 'v', 'r', 'z', 'th', 'n', 'm', 'l', 's', 'x', 'qu', 'd', 'br', 'kr', 'ph', 'g', 'y', 'h', ''];
const VOWEL = ['a', 'e', 'i', 'o', 'u', 'ae', 'ia', 'ei', 'oa', 'y', 'ui'];
const CODA = ['', '', 'n', 'r', 's', 'l', 'th', 'x', 'm', 'sh', 'k', 'nd', 'rr'];
const TAIL = ['Prime', 'Major', 'Minor', 'Expanse', 'Reach', 'Drift', 'Terminus', 'Verge', 'Cluster'];

export const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

function pick(rand, arr) { return arr[(rand() * arr.length) | 0]; }

export function makeWord(rand, minSyl = 2, maxSyl = 3) {
  const syl = minSyl + ((rand() * (maxSyl - minSyl + 1)) | 0);
  let w = '';
  for (let i = 0; i < syl; i++) {
    w += pick(rand, ONSET) + pick(rand, VOWEL);
    if (i === syl - 1 || rand() < 0.35) w += pick(rand, CODA);
  }
  return w.charAt(0).toUpperCase() + w.slice(1);
}

export function systemName(rand) {
  let name = makeWord(rand);
  if (rand() < 0.3) name += ' ' + pick(rand, TAIL);
  if (rand() < 0.25) name += '-' + (1 + ((rand() * 98) | 0));
  return name;
}

export function planetName(rand, sysName, index) {
  if (rand() < 0.55) return makeWord(rand, 2, 4);
  const base = sysName.split(' ')[0].split('-')[0];
  return base + ' ' + ROMAN[index % ROMAN.length];
}

export function moonName(rand, parentName) {
  if (rand() < 0.5) return parentName.split(' ')[0] + "'s Moon";
  return makeWord(rand, 2, 2);
}
