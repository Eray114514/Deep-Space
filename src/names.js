// Deterministic Chinese-localised astronomical names.
// Public proper names are readable; catalogue designations remain canonical.

import { makeRng, strHash32 } from './rng.js';

const SYSTEM_NAMES = [
  ['奥林匹斯', 'Olympus'], ['南门', 'Nanmen'], ['阿尔戈斯', 'Argos'], ['卡西尼', 'Cassini'],
  ['开普勒', 'Kepler'], ['伽利略', 'Galileo'], ['哥白尼', 'Copernicus'], ['第谷', 'Tycho'],
  ['哈雷', 'Halley'], ['赫歇尔', 'Herschel'], ['拉格朗日', 'Lagrange'], ['麦哲伦', 'Magellan'],
  ['欧罗巴', 'Europa'], ['亚特拉斯', 'Atlas'], ['阿波罗', 'Apollo'], ['阿尔忒弥斯', 'Artemis'],
  ['赫利俄斯', 'Helios'], ['塞勒涅', 'Selene'], ['俄刻阿诺斯', 'Oceanus'], ['忒提斯', 'Tethys'],
  ['安塔瑞斯', 'Antares'], ['阿尔泰尔', 'Altair'], ['织女', 'Vega'], ['轩辕', 'Xuanyuan'],
  ['天狼', 'Sirius'], ['猎户', 'Orion'], ['天鹅', 'Cygnus'], ['仙女', 'Andromeda'],
  ['英仙', 'Perseus'], ['半人马', 'Centaurus'], ['武仙', 'Hercules'], ['天琴', 'Lyra'],
  ['帕洛马', 'Palomar'], ['阿雷西博', 'Arecibo'], ['格林尼治', 'Greenwich'], ['冒纳凯阿', 'Mauna Kea'],
  ['维拉', 'Vera'], ['钱德拉', 'Chandra'], ['哈勃', 'Hubble'], ['旅行者', 'Voyager'],
  ['先锋', 'Pioneer'], ['水手', 'Mariner'], ['曙光', 'Dawn'], ['朱诺', 'Juno'],
  ['麦克斯韦', 'Maxwell'], ['法拉第', 'Faraday'], ['牛顿', 'Newton'], ['欧拉', 'Euler'],
  ['高斯', 'Gauss'], ['惠更斯', 'Huygens'], ['罗默', 'Romer'], ['布拉赫', 'Brahe'],
  ['阿蒙森', 'Amundsen'], ['沙克尔顿', 'Shackleton'], ['库克', 'Cook'], ['梅卡托', 'Mercator'],
  ['塔斯曼', 'Tasman'], ['富兰克林', 'Franklin'], ['达尔文', 'Darwin'], ['洪堡', 'Humboldt'],
];

const BODY_NAMES = [
  ['杰米森', 'Jamison'], ['新亚特兰蒂斯', 'New Atlantis'], ['阿基拉', 'Akila'], ['庞特斯', 'Pontus'],
  ['伊萨卡', 'Ithaca'], ['德尔斐', 'Delphi'], ['罗德斯', 'Rhodes'], ['塞浦路斯', 'Cyprus'],
  ['阿卡迪亚', 'Arcadia'], ['伊庇鲁斯', 'Epirus'], ['卡拉布里亚', 'Calabria'], ['萨莫斯', 'Samos'],
  ['塔尔西斯', 'Tharsis'], ['乌托邦', 'Utopia'], ['埃律西昂', 'Elysium'], ['阿卡迪亚平原', 'Arcadia Planitia'],
  ['阿蒙森', 'Amundsen'], ['罗斯', 'Ross'], ['威德尔', 'Weddell'], ['恩德比', 'Enderby'],
  ['巴芬', 'Baffin'], ['班克斯', 'Banks'], ['富兰克林', 'Franklin'], ['埃尔斯米尔', 'Ellesmere'],
  ['卡戎', 'Charon'], ['米玛斯', 'Mimas'], ['恩克拉多斯', 'Enceladus'], ['狄俄涅', 'Dione'],
  ['瑞亚', 'Rhea'], ['伊阿珀托斯', 'Iapetus'], ['阿玛尔忒亚', 'Amalthea'], ['希玛利亚', 'Himalia'],
  ['奈里德', 'Nereid'], ['普罗透斯', 'Proteus'], ['拉里萨', 'Larissa'], ['伽拉忒亚', 'Galatea'],
  ['塞德娜', 'Sedna'], ['奥尔库斯', 'Orcus'], ['夸欧尔', 'Quaoar'], ['瓦鲁纳', 'Varuna'],
  ['居里', 'Curie'], ['麦哲伦', 'Magellan'], ['费米', 'Fermi'], ['薛定谔', 'Schrodinger'],
  ['玻尔', 'Bohr'], ['开尔文', 'Kelvin'], ['焦耳', 'Joule'], ['赫兹', 'Hertz'],
  ['欧几里得', 'Euclid'], ['阿贝尔', 'Abel'], ['诺特', 'Noether'], ['黎曼', 'Riemann'],
  ['特斯拉', 'Tesla'], ['伏打', 'Volta'], ['安培', 'Ampere'], ['卢瑟福', 'Rutherford'],
  ['香农', 'Shannon'], ['图灵', 'Turing'], ['巴贝奇', 'Babbage'], ['洛夫莱斯', 'Lovelace'],
  ['巴塔哥尼亚', 'Patagonia'], ['安纳托利亚', 'Anatolia'], ['撒哈拉', 'Sahara'], ['卡拉哈里', 'Kalahari'],
  ['勘察者', 'Surveyor'], ['领航员', 'Navigator'], ['信使', 'Messenger'], ['远征者', 'Expedition'],
];

const GREEK_ZH = ['阿尔法', '贝塔', '伽马', '德尔塔', '艾普西隆', '泽塔', '伊塔', '西塔'];
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const LEGACY_ONSET = ['ka', 've', 'ro', 'na', 'mi', 'la', 'so', 'da', 'he', 'io'];

function pick(rand, arr) { return arr[Math.floor(rand() * arr.length) % arr.length]; }

// Retained for random universe seed generation; it is never shown as a body name.
export function makeWord(rand, minSyl = 2, maxSyl = 3) {
  const n = minSyl + Math.floor(rand() * (maxSyl - minSyl + 1));
  let out = '';
  for (let i = 0; i < n; i++) out += pick(rand, LEGACY_ONSET);
  return out.charAt(0).toUpperCase() + out.slice(1);
}

export function catalogueId(starCell) {
  const id = typeof starCell === 'string' ? starCell : starCell.id;
  const [x = 0, y = 0, z = 0] = id.split(',').map(Number);
  const h = strHash32(`catalogue:${id}`);
  const hh = String((Math.abs(x * 7 + z * 13) + (h % 24)) % 24).padStart(2, '0');
  const mm = String((h >>> 5) % 60).padStart(2, '0');
  const sign = y < 0 ? '-' : '+';
  const dd = String((Math.abs(y * 3) + ((h >>> 11) % 90)) % 90).padStart(2, '0');
  const dm = String((h >>> 17) % 60).padStart(2, '0');
  // The sky-coordinate-looking prefix is for flavour; the signed cell tuple
  // makes the fictional catalogue key unique across the infinite lattice.
  const enc = (n) => `${n < 0 ? 'M' : 'P'}${Math.abs(n).toString(36).toUpperCase()}`;
  const suffix = `${enc(x)}${enc(y)}${enc(z)}`;
  return `AF J${hh}${mm}${sign}${dd}${dm}-${suffix}`;
}

export function generateCelestialNames(seed, starCell, bodyCount, moonCount = 0) {
  const id = typeof starCell === 'string' ? starCell : starCell.id;
  const rand = makeRng(`${seed}:names:v2:${id}`);
  const systemBase = pick(rand, SYSTEM_NAMES);
  // Survey-style qualifiers keep the currently reachable map free of alias
  // collisions without inventing fantasy syllables. The home system keeps a
  // clean proper name; remote aliases read like real observing programmes.
  const nameHash = strHash32(`${seed}:proper-name:${id}`);
  const qualifier = id === '0,0,0'
    ? ''
    : ` ${GREEK_ZH[nameHash % GREEK_ZH.length]}-${String(1000 + ((nameHash >>> 4) % 9000)).padStart(4, '0')}`;
  const system = {
    zh: `${systemBase[0]}${qualifier}`,
    latin: systemBase[1],
    sourceCategory: systemBase[2] || '真实地理、航海与科学史',
    appliesTo: ['system', 'star'],
    displayName: `${systemBase[0]}${qualifier}星系`,
    catalogId: catalogueId(id),
  };
  const used = new Set([systemBase[0]]);
  const takeBody = (index, moon = false) => {
    let item;
    for (let tries = 0; tries < BODY_NAMES.length; tries++) {
      item = BODY_NAMES[(Math.floor(rand() * BODY_NAMES.length) + index + tries) % BODY_NAMES.length];
      if (!used.has(item[0])) break;
    }
    used.add(item[0]);
    return {
      zh: item[0], latin: item[1],
      sourceCategory: item[2] || '真实地理、航海与科学史',
      appliesTo: moon ? ['moon'] : ['planet', 'moon'],
      displayName: moon ? item[0] : `${item[0]}星`,
    };
  };
  const bodies = Array.from({ length: bodyCount }, (_, i) => takeBody(i, false));
  const moons = Array.from({ length: moonCount }, (_, i) => takeBody(bodyCount + i, true));
  return { system, bodies, moons };
}

// Compatibility wrappers for older callers; new systems should use generateSystemSpec.
export function systemName(rand) { return `${pick(rand, SYSTEM_NAMES)[0]}星系`; }
export function planetName(rand, _sysName, _index) { return `${pick(rand, BODY_NAMES)[0]}星`; }
export function moonName(rand) { return pick(rand, BODY_NAMES)[0]; }
export { ROMAN };
