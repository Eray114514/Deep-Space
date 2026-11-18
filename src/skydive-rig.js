import * as THREE from 'three';
import { buildHand } from './saltline/viewmodel-kit.js';
import { FOREGROUND_LAYER } from './render-layers.js';

const CELLS = 9;
const smooth = THREE.MathUtils.smoothstep;
const lerp = THREE.MathUtils.lerp;
const up = new THREE.Vector3(0, 1, 0);
const identity = new THREE.Quaternion();
const cameraLocal = new THREE.Quaternion();
const handBasis = new THREE.Quaternion();
const angles = new THREE.Euler(0, 0, 0, 'YXZ');
const segment = new THREE.Object3D();
const delta = new THREE.Vector3();
const tip = new THREE.Vector3();
const junction = new THREE.Vector3();
const ring = new THREE.Vector3();
const shoulder = new THREE.Vector3();
const grip = new THREE.Vector3();
const gripPoint = new THREE.Vector3(0, -0.026, -0.106);

// Continuous pattern cut across the panels before they are stitched together.
// Keeping the ink in wing UVs makes the registration bend with the fabric.
function makeSailcloth() {
  const canvas = document.createElement('canvas');
  canvas.width = 2048;
  canvas.height = 768;
  const g = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const fill = (color, points) => {
    g.fillStyle = color;
    g.beginPath();
    points.forEach(([x, y], i) => i ? g.lineTo(x * w, y * h) : g.moveTo(x * w, y * h));
    g.closePath();
    g.fill();
  };
  g.fillStyle = '#e9ddbb';
  g.fillRect(0, 0, w, h);
  fill('#c5512c', [[0, 0], [1, 0], [1, .66], [.8, .32], [.61, .28], [.43, .57], [.2, .68], [0, 1]]);
  fill('#e9823e', [[0, .72], [.2, .51], [.43, .44], [.61, .23], [.8, .27], [1, .52],
    [1, .62], [.8, .31], [.61, .27], [.43, .51], [.2, .59], [0, .85]]);
  fill('#25323a', [[0, 0], [.13, 0], [.15, .49], [.08, 1], [0, 1]]);
  fill('#25323a', [[.92, 0], [1, 0], [1, 1], [.97, 1], [.9, .42]]);
  g.fillStyle = '#35434a';
  g.fillRect(0, h * .965, w, h * .035);
  // Panel tapes, twin needle tracks and narrow cross-chord reinforcement.
  for (let i = 0; i <= CELLS; i++) {
    const x = i * w / CELLS;
    g.fillStyle = 'rgba(48,38,30,.24)';
    g.fillRect(x - 5, 0, 10, h);
    g.fillStyle = 'rgba(255,241,200,.6)';
    for (let y = 0; y < h; y += 8) {
      g.fillRect(x - 3, y, 1, 5);
      g.fillRect(x + 2, y, 1, 5);
    }
  }
  for (const v of [.06, .38, .78, .95]) {
    g.fillStyle = 'rgba(51,44,33,.3)';
    g.fillRect(0, v * h, w, 2);
    g.fillStyle = 'rgba(255,250,222,.55)';
    g.fillRect(0, v * h + 3, w, 1);
  }
  g.save();
  g.translate(w * .70, h * .82);
  g.scale(1, -1);
  g.fillStyle = '#35434a';
  g.font = 'bold 56px Arial';
  g.fillText('HC / VII', 0, 0);
  g.font = 'bold 15px Arial';
  g.fillText('HALCYON   •   AERO SYSTEMS', 2, 23);
  g.restore();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

// s runs from wingtip to wingtip, v from the cell mouth to its trailing hem.
// Each skin billows away from the structural ribs. The mouth stays open and
// the two skins meet at the tail, as on a pressurised double-surface wing.
function wingPoint(out, s, v, skin) {
  const a = s * 2 - 1;
  const arc = a * 0.98;
  const chord = 3.08 - 1.42 * Math.pow(Math.abs(a), 2.8);
  const pocket = Math.pow(Math.abs(Math.sin(Math.PI * CELLS * s)), .73);
  const foil = (1 - v) * (.16 + .26 * Math.sin(Math.PI * Math.sqrt(v)));
  const thickness = foil * (skin > 0 ? .72 + .70 * pocket : .30 + .88 * pocket);
  const profile = .16 * Math.sin(Math.PI * v) - .18 * v + skin * thickness;
  return out.set(4.75 * Math.sin(arc) + profile * Math.sin(arc),
    3.35 * (Math.cos(arc) - 1) + profile * Math.cos(arc),
    (v - .53) * chord + .40 * a * a + .11 * pocket * v * v * v);
}

function wingGeometry() {
  const pos = [], uv = [], shade = [], idx = [];
  function grid(nx, ny, point, flip) {
    const base = pos.length / 3;
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        const [s, v, light] = point(i / nx, j / ny);
        pos.push(tip.x, tip.y, tip.z);
        uv.push(s, 1 - v);
        shade.push(light, light, light);
        if (i === nx || j === ny) continue;
        const a = base + j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
        if (flip) idx.push(a, b, c, b, d, c);
        else idx.push(a, c, b, b, c, d);
      }
    }
  }
  for (let cell = 0; cell < CELLS; cell++) {
    for (const skin of [1, -1]) {
      grid(10, 18, (x, v) => {
        const s = (cell + x) / CELLS;
        wingPoint(tip, s, v, skin);
        const fullness = Math.pow(Math.max(0, Math.sin(Math.PI * x)), .5);
        return [s, v, skin > 0 ? .86 + .14 * fullness : .54 + .46 * fullness];
      }, skin < 0);
    }
    // A recessed intake baffle gives the nose real shadow depth.
    grid(10, 1, (x, t) => {
      const s = (cell + x) / CELLS;
      wingPoint(tip, s, .13, 1).lerp(wingPoint(delta, s, .13, -1), t);
      return [s, .02, .065];
    }, false);
  }
  for (let rib = 0; rib <= CELLS; rib++) {
    grid(18, 1, (v, t) => {
      const s = rib / CELLS;
      wingPoint(tip, s, v, 1).lerp(wingPoint(delta, s, v, -1), t);
      return [s, v, .39];
    }, rib === CELLS);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(shade, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// The foreground is a separate light domain. Evaluate a sky fill, transmitted
// light through the nylon, and a grazing sheen in the planet's actual frame.
function rigMaterial(light, { color = 0xffffff, sail = null, dial = null, glove = false, webbing = false } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { ...light, ink: { value: new THREE.Color(color) }, cloth: { value: sail || dial } },
    defines: { ...(sail ? { SAIL: 1 } : {}), ...(glove ? { GLOVE: 1 } : {}), ...(dial ? { DIAL: 1 } : {}) },
    vertexColors: !!sail || glove || webbing,
    side: sail ? THREE.DoubleSide : THREE.FrontSide,
    vertexShader: `
      #include <common>
      #include <morphtarget_pars_vertex>
      #include <logdepthbuf_pars_vertex>
      varying vec3 nW, tint, pLocal, eyeW;
      varying vec2 tex;
      uniform vec2 brakes;
      uniform float clock;
      void main() {
        #include <beginnormal_vertex>
        #include <morphnormal_vertex>
        #include <begin_vertex>
        #include <morphtarget_vertex>
        tex = uv;
        pLocal = transformed;
        tint = vec3(1.);
        #ifdef USE_COLOR
        tint = color;
        #endif
        #ifdef SAIL
        float tail = smoothstep(.65, 1., 1. - uv.y);
        float brake = mix(brakes.x, brakes.y, smoothstep(.45, .55, uv.x));
        transformed.y += tail * (-brake * .46 + .022 * sin(clock * 7. + position.x * 4.));
        #endif
        #include <defaultnormal_vertex>
        #include <project_vertex>
        nW = inverseTransformDirection(normalize(transformedNormal), viewMatrix);
        eyeW = inverseTransformDirection(normalize(-mvPosition.xyz), viewMatrix);
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform sampler2D cloth;
      uniform vec3 ink, sun, vertical;
      uniform float daylight, cloud;
      varying vec3 nW, tint, pLocal, eyeW;
      varying vec2 tex;
      void main() {
        #include <logdepthbuf_fragment>
        vec3 n = normalize(nW) * (gl_FrontFacing ? 1. : -1.);
        float nl = dot(n, sun);
        float sky = dot(n, vertical) * .5 + .5;
        vec3 base = ink * tint;
        vec3 light = mix(vec3(.28,.26,.25), vec3(.51,.59,.71), sky) + vec3(1.08,.94,.75) * max(nl, 0.);
        light = mix(light, vec3(.63, .67, .72) * (.86 + .25 * sky), cloud * .84);
        #ifdef DIAL
        base *= texture2D(cloth, tex).rgb;
        #endif
        #ifdef SAIL
        base *= texture2D(cloth, tex).rgb;
        light += vec3(.89,.74,.52) * (.27 + .52 * max(-nl, 0.));
        vec2 weave = tex * vec2(940., 325.);
        vec2 thread = smoothstep(vec2(.72), vec2(.99), cos(6.28318 * weave));
        base *= 1. - .068 * dot(thread, 1. - smoothstep(vec2(.17), vec2(.55), fwidth(weave)));
        // Shallow diagonal stress folds radiate out from each sewn line tab.
        float bay = fract(tex.x * 9. + .5) - .5;
        float tab = min(abs(tex.y - .84), abs(tex.y - .30));
        float tension = exp(-13. * abs(bay) - 9. * tab);
        base *= 1. + .16 * tension * sin(83. * abs(bay) - 62. * tab);
        #endif
        #ifdef GLOVE
        vec2 stitch = pLocal.xz * 1400.;
        base *= 1. + .045 * sin(stitch.x) * cos(stitch.y);
        #endif
        float rim = pow(1. - abs(dot(normalize(eyeW), n)), 3.);
        gl_FragColor = vec4((base * light + .028 * rim) * daylight, 1.);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

const forearmAxis = [.24, -.51, .83];

function gloveGeometry(side) {
  const make = (closed) => buildHand({
    mirror: side < 0, forearm: forearmAxis, upperArm: [-.58, -.3, .76],
    fingers: closed
      ? [[.86, 1.55, .92, .03], [.96, 1.55, 1.0, 0], [1.02, 1.5, 1.05, -.04], [1.12, 1.46, .99, -.075]]
      : [[.12, .12, .13, .16], [.08, .12, .1, .025], [.14, .15, .14, -.09], [.22, .23, .17, -.22]],
    thumb: closed ? [[-.57, -.28, -.77], [.25, -.37, -.90], [.84, -.26, -.47]]
      : [[-.88, -.12, -.43], [-.72, -.24, -.63], [-.63, -.28, -.73]],
  }).fabric;
  const open = make(false), closed = make(true);
  open.morphAttributes.position = [closed.attributes.position];
  open.morphAttributes.normal = [closed.attributes.normal];
  return open;
}

function toggleGeometry() {
  // A continuous folded tape with a reinforced grip and a narrow stitch line
  // along each selvage. Its loaded eye and the last brake-line segment coincide.
  const profile = [[-.052, .005], [-.042, 0], [.042, 0], [.052, .005], [.047, .019],
    [.018, .060], [.005, .077], [-.006, .077], [-.020, .059], [-.047, .019]];
  const path = new THREE.CatmullRomCurve3(profile.map(([x, y]) => new THREE.Vector3(x, y, 0)), true);
  const cross = [[-1, 0, .46], [-.92, 1, .78], [-.76, 1, 1.32], [-.62, 1, .82],
    [.62, 1, .82], [.76, 1, 1.32], [.92, 1, .78], [1, 0, .46], [.86, -1, .74], [-.86, -1, .74]];
  const pos = [], colors = [], idx = [];
  for (let i = 0; i < 80; i++) {
    const p = path.getPoint(i / 80), tangent = path.getTangent(i / 80);
    for (let j = 0; j < cross.length; j++) {
      const [u, z, shade] = cross[j];
      const offset = u * (p.y < .010 ? .008 : .0055);
      pos.push(p.x - tangent.y * offset, p.y + tangent.x * offset, z * .0026);
      const bartack = p.y < .012 && Math.abs(p.x) > .030 && Math.cos(p.x * 4500) > -.15 ? .5 : 1;
      colors.push(shade * bartack, shade * bartack, shade * bartack);
      const a = i * cross.length + j, b = i * cross.length + (j + 1) % cross.length;
      const c = ((i + 1) % 80) * cross.length + j, d = ((i + 1) % 80) * cross.length + (j + 1) % cross.length;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

function wristAltimeter(light, hand) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 384;
  const g = canvas.getContext('2d');
  g.translate(192, 192);
  g.fillStyle = '#242b2b';
  g.fillRect(-192, -192, 384, 384);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (let tick = 0; tick < 60; tick++) {
    const angle = tick / 60 * Math.PI * 2;
    const major = tick % 5 === 0;
    g.save();
    g.rotate(angle);
    g.fillStyle = tick < 5 ? '#ec854f' : '#eee8cc';
    g.fillRect(major ? -3 : -2, -171, major ? 6 : 4, major ? 26 : 12);
    g.restore();
    if (major) {
      g.fillStyle = '#eee8cc';
      g.font = 'bold 36px Arial';
      g.fillText(String(tick / 5), Math.sin(angle) * 117, -Math.cos(angle) * 117);
    }
  }
  g.fillStyle = '#c1c8bd';
  g.font = 'bold 19px Arial';
  g.fillText('km AGL', 0, 57);
  const dial = new THREE.CanvasTexture(canvas);
  dial.colorSpace = THREE.SRGBColorSpace;
  dial.anisotropy = 4;
  const mount = new THREE.Group();
  const axis = new THREE.Vector3().fromArray(forearmAxis);
  axis.x *= -1;
  mount.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis.normalize());
  mount.position.set(0, 0, .022);
  hand.add(mount);
  const caseMat = rigMaterial(light, { color: 0x343d42 });
  const band = new THREE.Mesh(new THREE.CylinderGeometry(.043, .042, .029, 24, 1, true), caseMat);
  band.rotation.x = Math.PI / 2;
  band.scale.z = .87;
  band.position.z = .063;
  mount.add(band);
  const housing = new THREE.Mesh(new THREE.CylinderGeometry(.039, .044, .017, 36), caseMat);
  housing.scale.setScalar(.72);
  housing.position.set(0, .037, .063);
  mount.add(housing);
  const face = new THREE.Mesh(new THREE.CircleGeometry(.035, 48), rigMaterial(light, { dial }));
  face.rotation.x = -Math.PI / 2;
  face.position.y = .0087;
  housing.add(face);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-.0032,-.006,0,.0032,-.006,0,.0006,.029,0], 3));
  geo.computeVertexNormals();
  const needle = new THREE.Mesh(geo, rigMaterial(light, { color: 0xfaa158 }));
  needle.position.z = .00065;
  face.add(needle);
  return { needle, dial };
}

function connectors(geometry, material, maxCount) {
  const mesh = new THREE.InstancedMesh(geometry, material, maxCount);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.count = 0;
  return mesh;
}

function connect(batch, a, b, width, depth = width) {
  delta.subVectors(b, a);
  const length = delta.length();
  if (length < .00001) return;
  segment.position.addVectors(a, b).multiplyScalar(.5);
  segment.quaternion.setFromUnitVectors(up, delta.multiplyScalar(1 / length));
  segment.scale.set(width, length, depth);
  segment.updateMatrix();
  batch.setMatrixAt(batch.count++, segment.matrix);
}

export function createSkydiveRig() {
  const root = new THREE.Group();
  root.name = 'halcyon-jump-harness';
  root.visible = false;
  const canopy = new THREE.Group();
  const wing = new THREE.Group();
  canopy.add(wing);
  root.add(canopy);
  const light = {
    sun: { value: new THREE.Vector3(.4, .8, .3).normalize() }, vertical: { value: up.clone() },
    daylight: { value: 1 }, cloud: { value: 0 }, brakes: { value: new THREE.Vector2() }, clock: { value: 0 },
  };
  const sail = makeSailcloth();
  const fabric = new THREE.Mesh(wingGeometry(), rigMaterial(light, { sail }));
  fabric.name = 'nine-cell-ram-air-wing';
  wing.add(fabric);
  const gloveMat = rigMaterial(light, { glove: true, color: 0x191c20 });
  const toggleMat = rigMaterial(light, { color: 0xdf9d39, webbing: true });
  toggleMat.side = THREE.DoubleSide;
  const tape = toggleGeometry();
  const cutWebbing = new THREE.BoxGeometry(1, 1, 1);
  const lines = connectors(new THREE.CylinderGeometry(.5, .5, 1, 5), rigMaterial(light, { color: 0xbdb6a2 }), 96);
  const straps = connectors(cutWebbing, rigMaterial(light, { color: 0x333d40 }), 8);
  const hardware = rigMaterial(light, { color: 0xa8ada8 });
  const link = new THREE.TorusGeometry(.025, .004, 6, 16);
  canopy.add(lines, straps);
  const arms = [-1, 1].map(side => {
    const hand = new THREE.Mesh(gloveGeometry(side), gloveMat);
    hand.name = side < 0 ? 'jump-glove-left' : 'jump-glove-right';
    root.add(hand);
    const toggle = new THREE.Mesh(tape, toggleMat);
    canopy.add(toggle);
    const rings = [0, 1].map(() => {
      const mesh = new THREE.Mesh(link, hardware);
      mesh.scale.set(.70, 1, 1);
      canopy.add(mesh);
      return mesh;
    });
    return { side, hand, toggle, rings };
  });
  const altimeter = wristAltimeter(light, arms[0].hand);
  root.traverse(o => o.layers.set(FOREGROUND_LAYER));
  const lineEnd = new THREE.Vector3();
  const crossbar = new THREE.Vector3(), tapeUp = new THREE.Vector3(), face = new THREE.Vector3();
  const tapeFrame = new THREE.Matrix4(), loop = new THREE.Vector3();
  const pointInRig = (point, mesh) => point.applyQuaternion(mesh.quaternion).add(mesh.position);
  const attach = (out, s, v) => wingPoint(out, s, v, -1).multiply(wing.scale)
    .applyQuaternion(wing.quaternion).add(wing.position);

  function update(ctl, bodyQuat, aspect) {
    root.visible = true;
    root.quaternion.copy(ctl.planet.frameOrientation).multiply(bodyQuat);
    cameraLocal.copy(bodyQuat).invert().multiply(ctl.quat);
    const t = ctl.deployT;
    const loaded = smooth(t, .20, .88);
    const catchToggle = smooth(t, .43, .92);
    const reach = Math.sin(Math.PI * smooth(t, .12, .89));
    canopy.visible = ctl.phase === 'canopy';
    handBasis.copy(cameraLocal).slerp(identity, loaded * .92);
    light.vertical.value.copy(ctl.posLocal).normalize().applyQuaternion(ctl.planet.frameOrientation);
    if (ctl.planet.sunDirWorld) light.sun.value.copy(ctl.planet.sunDirWorld);
    light.daylight.value = .23 + .77 * smooth(light.vertical.value.dot(light.sun.value), -.18, .34);
    light.clock.value = ctl.time;
    light.cloud.value = ctl.cloud || 0;
    altimeter.needle.rotation.z = -Math.PI * 2 * Math.min(ctl.agl / 12000, .995);
    light.brakes.value.set(ctl.brakeLeft, ctl.brakeRight);
    const span = .09 + .91 * smooth(t, .18, .95);
    wing.scale.set(span, .38 + .62 * loaded, .25 + .75 * smooth(t, .12, .76));
    wing.position.set(.14 * Math.sin(Math.PI * t * 2) * (1 - t),
      1.65 + 3.94 * smooth(t, 0, .62), -.44 - .72 * loaded);
    wing.rotation.z = -.12 * (ctl.brakeRight - ctl.brakeLeft);
    lines.count = straps.count = 0;
    const width = Math.min(1, aspect / 1.38);
    for (const { side, hand, toggle, rings } of arms) {
      const brake = side < 0 ? ctl.brakeLeft : ctl.brakeRight;
      const buffet = .35 * Math.sin(ctl.time * 7.3 + side) + .65 * Math.sin(ctl.time * 3.9 + side * 2);
      const flutter = buffet * Math.min(1, ctl.airspeed / 100) * (1 - loaded);
      const tuck = ctl.dive;
      const x = lerp(.35 - .038 * tuck, .314, loaded) * width;
      const y = lerp(-.19 - .018 * tuck, -.008 - .16 * brake, loaded);
      const z = lerp(-.415 + .029 * tuck, -.46 + .035 * brake, loaded);
      hand.position.set(side * (x + .028 * reach), y + .16 * reach + .012 * flutter, z - .045 * reach)
        .applyQuaternion(handBasis);
      angles.set(lerp(.54 + .12 * tuck, .91, loaded) + .07 * flutter,
        side * lerp(.58 + .09 * tuck, .18, loaded), side * lerp(.50, .27, loaded));
      hand.quaternion.copy(handBasis).multiply(segment.quaternion.setFromEuler(angles));
      hand.morphTargetInfluences[0] = catchToggle + (1 - catchToggle) * tuck * .23;
      if (!canopy.visible) continue;

      // Four risers lead from the harness to metal links, then cascade into
      // two ranks of suspension lines. All anchors share the inflating wing.
      for (let row = 0; row < 2; row++) {
        const r = rings[row];
        shoulder.set(side * .226, -.35, .12 + row * .04);
        ring.set(side * (.29 + .052 * row) * width, .30 + .042 * row - .055 * (1 - loaded), -.41 + .086 * row);
        r.position.copy(ring);
        connect(straps, shoulder, ring, .035, .007);
        for (let pair = 0; pair < 3; pair++) {
          const s = Math.min(4.25, pair * 2 + .5) / CELLS;
          const across = side < 0 ? s : 1 - s;
          const v = row ? .70 : .16;
          attach(junction, across, v).lerp(ring, .54);
          connect(lines, ring, junction, .008);
          for (let j = 0; j < 2; j++) {
            const rib = Math.min(4.5, pair * 2 + j) / CELLS;
            attach(lineEnd, side < 0 ? rib : 1 - rib, v);
            connect(lines, junction, lineEnd, .0052);
          }
        }
      }

      // Initially stowed on the rear riser, the webbing comes into the
      // curled palm as the fingers close. Its brake line stays reeved above.
      grip.copy(gripPoint);
      pointInRig(grip, hand);
      const rear = rings[1].position;
      toggle.position.copy(rear).addScaledVector(up, -.11).lerp(grip, catchToggle);
      crossbar.set(1, 0, 0).applyQuaternion(hand.quaternion);
      tapeUp.subVectors(rear, toggle.position).projectOnPlane(crossbar).normalize();
      face.crossVectors(crossbar, tapeUp);
      toggle.quaternion.setFromRotationMatrix(tapeFrame.makeBasis(crossbar, tapeUp, face));
      loop.copy(toggle.position).addScaledVector(tapeUp, .079);
      connect(lines, loop, rear, .004);
      attach(junction, side < 0 ? .2 : .8, .94).lerp(rear, .48);
      connect(lines, rear, junction, .006);
      for (const s of [.06, .19, .32]) {
        attach(lineEnd, side < 0 ? s : 1 - s, .94);
        lineEnd.y -= brake * .38 * wing.scale.y;
        connect(lines, junction, lineEnd, .0045);
      }
    }
    lines.instanceMatrix.needsUpdate = straps.instanceMatrix.needsUpdate = true;
  }

  function dispose() {
    const resources = new Set([sail, altimeter.dial]);
    root.traverse(o => {
      if (!o.isMesh) return;
      resources.add(o.geometry);
      resources.add(o.material);
      if (o.isInstancedMesh) resources.add(o);
    });
    for (const resource of resources) resource.dispose();
  }
  return { root, canopy, update, dispose };
}
