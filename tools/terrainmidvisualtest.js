import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

// Attribution only: this deliberately settled, frozen comparison does not
// replace the normal moving continuous-descent acceptance suite.
const fixturePath = process.env.TERRAIN_MID_FIXTURE
  || 'test-results/stage-a-continuous/2026-09-08T08-53-21-489Z/report.json';
const sourceReport = JSON.parse(await readFile(fixturePath, 'utf8'));
const coast = sourceReport.coastFixture;
const latticeComparison = process.env.TERRAIN_MID_KERNEL === 'lattice';
const ownershipComparison = process.env.TERRAIN_MID_OWNERSHIP === '1';
assert.ok(coast?.direction && coast.landward && Number.isFinite(coast.renderedWeather?.hour));
const out = `test-results/terrain-mid-visual/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });
const fingerprint = await evidenceFingerprint('tools/terrainmidvisualtest.js');
const report = { ...fingerprint, fixturePath, coast,
  scope: 'Settled attribution: normal HUD/post/clouds/farflora; no visual-score pass threshold.',
  caveat: 'Cloud temporal jitter and unrelated particles can evolve; only camera/clock/exposure/grade/water time are explicitly held.', captures: [] };
if (latticeComparison) report.candidate = { path: 'tools/terrain-continuous-candidate.js',
  sha256: createHash('sha256').update(await readFile('tools/terrain-continuous-candidate.js')).digest('hex') };
const { server, port } = await startServer(0);
const browser = await launchHardwareBrowser({ headless: true });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
async function restore() {
  await page.evaluate(() => {
    const held = window.__terrainMid;
    if (!held) return;
    NMS._pipeline.render = held.render;
    for (const object of held.objects) object.material = held.material;
    for (const entry of held.shadowFlags || []) entry.object.receiveShadow = entry.receiveShadow;
    for (const entry of held.drawHooks || []) entry.object.onBeforeRender = entry.callback;
    held.material.userData.shader = held.originalShader;
    for (const clone of held.clones) clone.dispose();
    delete window.__terrainMid;
  });
}
try {
  await page.goto(`http://127.0.0.1:${port}/?renderer=auto&quality=ultra&nohero=1&post=1&vclouds=1&farflora=1&freeze=1`);
  await page.waitForFunction(() => window.NMS?.booted, null, { timeout: 90000 });
  await page.evaluate((hour) => { NMS.setTime(hour); NMS.setTimeFrozen(true); }, coast.renderedWeather.hour);
  // Let the normal loop consume the ephemeris/reference-body frame jump
  // before positioning. Posing in the same call as setTime lets the next
  // follow-frame update apply the old-to-new body displacement a second time.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  for (const altitude of [52000, 8000]) {
    const fixture = await page.evaluate(({ coast, altitude }) => {
      NMS.setBuildBudget(42);
      NMS.setTimeFrozen(true);
      const p = NMS._planet(0), T = NMS._THREE;
      const forward = new T.Vector3(...coast.landward);
      const target = new T.Vector3(...coast.direction).addScaledVector(forward, 2000 / p.R).normalize();
      const direction = target.clone().addScaledVector(forward, -Math.max(3200, altitude * 0.32) / p.R).normalize();
      // Cancel startup/walk transition ownership before applying the precise
      // continuous-flight pose; that helper intentionally does not clear it.
      NMS.teleport(0, altitude / p.R, { dir: direction.toArray() });
      const result = NMS.setContinuousAtmosphereAltitude(0, altitude, {
        dir: direction.toArray(), forward: coast.landward, surfaceTargetDirection: target.toArray(),
      });
      return { result, target: target.toArray(), direction: direction.toArray() };
    }, { coast, altitude });
    await page.waitForFunction(() => NMS.idle(), null, { timeout: 150000 });
    assert.equal(await page.evaluate(() => NMS.setBuildBudget(0)), 0);
    await page.waitForTimeout(1500);
    const held = await page.evaluate(() => {
      const p = NMS._planet(0), pipeline = NMS._pipeline;
      const { camera, renderer } = NMS._internals;
      const material = p.terrainMaterial;
      const value = { material, originalShader: material.userData.shader, render: pipeline.render,
        position: camera.position.clone(), quaternion: camera.quaternion.clone(),
        exposure: renderer.toneMappingExposure, gradeTime: pipeline.grade?.uniforms.uTime.value,
        oceanTime: p.liquidMat.userData.shader.uniforms.uTime.value, objects: [], clones: [], drawHooks: [], drawRecords: new Map() };
      p.group.traverse((object) => { if (object.material === material) value.objects.push(object); });
      value.shadowFlags = value.objects.map((object) => ({ object, receiveShadow: object.receiveShadow }));
      const terrainSet = new Set(value.objects);
      NMS._internals.scene.traverse((object) => {
        if (!object.isMesh && !object.isPoints && !object.isLine) return;
        const callback = object.onBeforeRender;
        value.drawHooks.push({ object, callback });
        object.onBeforeRender = function (...args) {
          if (!terrainSet.has(object)) {
            const drawMaterial = args[4] || object.material;
            const previous = value.drawRecords.get(object.uuid);
            const path = []; for (let owner = object; owner; owner = owner.parent) path.push(owner.name || owner.type);
            value.drawRecords.set(object.uuid, { uuid: object.uuid, name: object.name, type: object.type,
              path: path.reverse().join('/'), geometryType: object.geometry?.type,
              triangles: object.geometry?.index?.count / 3 || object.geometry?.attributes.position?.count / 3 || 0,
              material: { type: drawMaterial?.type, name: drawMaterial?.name, transparent: drawMaterial?.transparent,
                opacity: drawMaterial?.opacity, depthTest: drawMaterial?.depthTest, depthWrite: drawMaterial?.depthWrite,
                side: drawMaterial?.side, polygonOffset: drawMaterial?.polygonOffset },
              renderOrder: object.renderOrder, layers: object.layers.mask, receiveShadow: object.receiveShadow,
              castShadow: object.castShadow, draws: (previous?.draws || 0) + 1 });
          }
          return callback.apply(this,args);
        };
      });
      window.__terrainMid = value;
      pipeline.render = function (...args) {
        camera.position.copy(value.position); camera.quaternion.copy(value.quaternion); camera.updateMatrixWorld(true);
        renderer.toneMappingExposure = value.exposure;
        if (pipeline.grade) pipeline.grade.uniforms.uTime.value = value.gradeTime;
        p.liquidMat.userData.shader.uniforms.uTime.value = value.oceanTime;
        return value.render.apply(this, args);
      };
      return { cosmicHours: NMS.stats().cosmicHours, exposure: value.exposure,
        gradeTime: value.gradeTime, oceanTime: value.oceanTime,
        cameraPosition: value.position.toArray(), cameraQuaternion: value.quaternion.toArray(),
        terrainObjects: value.objects.length };
    });
    assert.ok(held.terrainObjects > 0);
    const modes = ownershipComparison
      ? ['identity', 'full-normal', 'full-normal-no-shadow', 'full-normal-constant-albedo', 'mesh-normal', 'restored']
      : latticeComparison
      ? ['identity', 'full-normal', 'continuous-full-normal', 'restored-full-normal', 'restored']
      : ['identity', 'full-normal', 'full-normal-vertexfields', 'restored'];
    for (const mode of modes) {
      let kernelRebuild = null;
      if (mode === 'continuous-full-normal' || mode === 'restored-full-normal') {
        kernelRebuild = await page.evaluate(async (mode) => {
          const { continuousTerrainNoise } = await import('/tools/terrain-continuous-candidate.js');
          const p = NMS._planet(0), held = window.__terrainMid;
          window.__terrainKernelOriginal ||= ['nA', 'nB', 'nC', 'nD'].map((key) =>
            ({ key, method: p[key].noise, own: Object.hasOwn(p[key], 'noise') }));
          window.__terrainKernelCalls = 0;
          for (const entry of window.__terrainKernelOriginal) {
            if (mode === 'continuous-full-normal') p[entry.key].noise = function (x, y, z) {
              window.__terrainKernelCalls++;
              return continuousTerrainNoise.call(this, x, y, z);
            };
            else if (entry.own) p[entry.key].noise = entry.method;
            else delete p[entry.key].noise;
          }
          const old = p.lod, oldGeometry = old.roots[0].mesh.geometry.uuid;
          old.dispose();
          p.lod = new old.constructor(p);
          p.lod.focused = true;
          held.objects = [];
          NMS.setBuildBudget(42);
          return { oldGeometry, newGeometry: p.lod.roots[0].mesh.geometry.uuid,
            terrainNoiseOnly: true, changedInstances: ['nA', 'nB', 'nC', 'nD'],
            caveat: 'Other noise consumers and existing water depth buffers stay production; coastline differences reflect the deliberately changed terrain only.' };
        }, mode);
        await page.waitForFunction(() => NMS.idle(), null, { timeout: 150000 });
        await page.evaluate(() => {
          NMS.setBuildBudget(0);
          const held = window.__terrainMid;
          NMS._planet(0).group.traverse((object) => { if (object.material === held.material) held.objects.push(object); });
        });
        assert.notEqual(kernelRebuild.oldGeometry, kernelRebuild.newGeometry);
      }
      await page.evaluate((mode) => {
        const held = window.__terrainMid;
        held.drawRecords.clear();
        for (const entry of held.shadowFlags) entry.object.receiveShadow = mode === 'full-normal-no-shadow' ? false : entry.receiveShadow;
        if (mode === 'restored') {
          for (const object of held.objects) object.material = held.material;
          held.current = held.material;
          return;
        }
        if (mode === 'mesh-normal') {
          const clone = new NMS._THREE.MeshNormalMaterial();
          held.clones.push(clone); held.current = clone;
          for (const object of held.objects) object.material = clone;
          return;
        }
        const clone = held.material.clone();
        clone.onBeforeRender = held.material.onBeforeRender;
        clone.onBeforeCompile = (shader, renderer) => {
          held.material.onBeforeCompile(shader, renderer);
          const replaceRequired = (from, to) => {
            if (!shader.fragmentShader.includes(from)) throw new Error(`Missing ${mode} target: ${from}`);
            shader.fragmentShader = shader.fragmentShader.replace(from, to);
          };
          if (mode !== 'identity') {
            const legacy = 'float geometricNormalWeight = mix(0.22, 1.0, normalVertexFieldFade);';
            if (shader.fragmentShader.includes(legacy)) replaceRequired(legacy,
              'float geometricNormalWeight = 1.0; // TERRAIN_MID_FULL_NORMAL');
            else replaceRequired('normal = normalize(normal);',
              'normal = normalize(normal); // TERRAIN_MID_FULL_NORMAL: production already preserves relief');
          }
          if (mode === 'full-normal-vertexfields') {
            const pattern = /float vertexFieldFade = 1\.0 - smoothstep\(4500\.0, 24000\.0,\s*length\(vViewPosition\)\);/;
            if (pattern.test(shader.fragmentShader)) shader.fragmentShader = shader.fragmentShader.replace(pattern,
              'float vertexFieldFade = 1.0; // TERRAIN_MID_VERTEX_FIELDS');
            else replaceRequired('float vertexFieldFade = 1.0;',
              'float vertexFieldFade = 1.0; // TERRAIN_MID_VERTEX_FIELDS: production already preserves provinces');
          }
          if (mode === 'full-normal-constant-albedo') {
            // Replace the final accumulated albedo (including all vertex
            // palettes, cloud-atlas multiplication and eclipse tint), not just
            // its initial base. Keep the physical normal and lighting path.
            replaceRequired('#include <roughnessmap_fragment>',
              'diffuseColor.rgb = vec3(0.35); // TERRAIN_MID_CONSTANT_ALBEDO\n#include <roughnessmap_fragment>');
          }
          clone.userData.midShader = shader;
        };
        clone.customProgramCacheKey = () => `terrain-mid-attribution-${mode}`;
        held.clones.push(clone); held.current = clone;
        for (const object of held.objects) object.material = clone;
      }, mode);
      await page.waitForTimeout(1000);
      const artifact = `${altitude}m-${mode}`;
      await page.screenshot({ path: `${out}/${artifact}.png` });
      const capture = await page.evaluate(() => {
        const held = window.__terrainMid, p = NMS._planet(0);
        const { camera, renderer } = NMS._internals;
        const properties = renderer.properties.get(held.current), gl = renderer.getContext();
        const local = p.worldPositionToLocal(NMS._internals.nav.pos, new NMS._THREE.Vector3());
        return { stats: NMS.stats(), radialAltitude: local.length() - p.R,
          terrainAltitude: local.length() - p.surfaceRadius(local.clone().normalize()),
          terrain: p.lod.debugStats(), water: p.waterLod.debugStats(),
          cosmicHours: NMS.stats().cosmicHours, exposure: renderer.toneMappingExposure,
          gradeTime: NMS._pipeline.grade?.uniforms.uTime.value,
          oceanTime: p.liquidMat.userData.shader.uniforms.uTime.value,
          cameraPosition: camera.position.toArray(), cameraQuaternion: camera.quaternion.toArray(),
          candidateNoiseCalls: window.__terrainKernelCalls || 0,
          nonTerrainDraws: [...held.drawRecords.values()],
          terrainShadowFlags: { objects: held.objects.length,
            receiving: held.objects.filter((object) => object.receiveShadow).length },
          shadowLights: (() => { const lights = []; NMS._internals.scene.traverse((light) => {
            if (light.isLight) lights.push({ name:light.name,type:light.type,visible:light.visible,
              intensity:light.intensity,castShadow:light.castShadow,
              shadow:light.shadow ? {bias:light.shadow.bias,normalBias:light.shadow.normalBias,
                near:light.shadow.camera.near,far:light.shadow.camera.far,
                left:light.shadow.camera.left,right:light.shadow.camera.right,
                top:light.shadow.camera.top,bottom:light.shadow.camera.bottom} : null});
            }); return lights; })(),
          programs: [...(properties.programs?.values() || [])].map((program) => ({ key: program.cacheKey,
            vertex: gl.getShaderSource(program.vertexShader), fragment: gl.getShaderSource(program.fragmentShader) })) };
      });
      if (mode === 'identity') {
        const ownership = await page.evaluate(() => {
          const p = NMS._planet(0), lod = p.lod, T = NMS._THREE;
          const { camera, renderer } = NMS._internals;
          const viewport = renderer.domElement.getBoundingClientRect();
          const width = viewport.width, height = viewport.height;
          const projection = new T.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
          const frustum = new T.Frustum().setFromProjectionMatrix(projection);
          const address = (node) => node ? `${node.face}/${node.level}/${node.ix}/${node.iy}` : null;
          const records = [], histogram = {}, frustumHistogram = {};
          const screenVertex = new T.Vector3();
          const walk = (node) => {
            if (node.mesh?.visible) {
              const mesh = node.mesh, geometry = mesh.geometry;
              const position = geometry.getAttribute('position');
              const normal = geometry.getAttribute('normal');
              const delta = geometry.getAttribute('aPositionDelta');
              const morph = geometry.getAttribute('aLodMorph');
              const N = p.gridCellsAtLevel(node.level);
              const inFrustum = frustum.intersectsObject(mesh);
              histogram[node.level] = (histogram[node.level] || 0) + 1;
              if (inFrustum) frustumHistogram[node.level] = (frustumHistogram[node.level] || 0) + 1;
              const d = lod.nodeDistance(node);
              const pxPerRad = height / (2 * Math.tan(camera.fov * Math.PI / 360));
              const influence = T.MathUtils.smoothstep(Math.max(0, lod.camLocal.length() - p.R), 5000, 15000);
              const row = { address: address(node), level: node.level, inFrustum,
                parent: address(node.parent), children: node.children?.map(address) || [],
                splitActive: node.splitActive, mergePending: node.mergePending,
                childrenReady: !!node.children?.every((child) => child.mesh),
                boundaryPeersReady: lod.faceBoundaryPeersReady(node), beyondHorizon: lod.beyondHorizon(node),
                levelCap: lod._levelCap, forceLevel: lod._forceLevel,
                forcedAcrossFace: node.forceSplitUntil >= lod._frame,
                forcedByMinimumLevel: node.level < lod._forceLevel,
                screenWantSplit: node.level <= 10 && node.size / Math.max(d, 1) * pxPerRad / N * influence > lod.maxCellPixels,
                distanceInNodeSizes: d / node.size,
                distanceScale: p.lodDistanceScaleAtLevel(node.level),
                boundaryPeers: lod.boundaryEdges(node).map((edge) => {
                  const a = lod.neighbourAddress(node, edge), peer = lod.findNode(a.face, node.level, a.ix, a.iy, false);
                  return { edge, address: address(peer), missing: !peer,
                    beyondHorizon: peer ? lod.beyondHorizon(peer) : null,
                    splitActive: peer?.splitActive, processedFrame: peer?.processedFrame,
                    childrenReady: !!peer?.children?.every((child) => child.mesh),
                    children: peer?.children?.map((child) => ({ address: address(child), mesh: !!child.mesh, queued: child.queued })) };
                }),
                material: { name: mesh.material.name, type: mesh.material.type, key: mesh.material.customProgramCacheKey() },
                attributes: Object.fromEntries(['position', 'normal', 'aNormalDelta', 'aLodMorph'].map((name) => {
                  const a = geometry.getAttribute(name);
                  return [name, a ? { count: a.count, itemSize: a.itemSize, arrayType: a.array.constructor.name,
                    interleaved: !!a.isInterleavedBufferAttribute, normalized: a.normalized } : null];
                })), maxProjectedCellEdgePx: 0, viewportTriangles: 0, largestTriangles: [] };
              if (inFrustum) {
                const projected = new Float64Array((N + 1) ** 2 * 3);
                for (let i = 0; i < (N + 1) ** 2; i++) {
                  const m = morph?.getX(i) || 0;
                  screenVertex.set(position.getX(i) + (delta?.getX(i) || 0) * m,
                    position.getY(i) + (delta?.getY(i) || 0) * m,
                    position.getZ(i) + (delta?.getZ(i) || 0) * m).applyMatrix4(mesh.matrixWorld).project(camera);
                  projected[i * 3] = (screenVertex.x * 0.5 + 0.5) * width;
                  projected[i * 3 + 1] = (0.5 - screenVertex.y * 0.5) * height;
                  projected[i * 3 + 2] = screenVertex.z;
                }
                const triangle = (a, b, c) => {
                  const points = [a, b, c].map((i) => [projected[i * 3], projected[i * 3 + 1], projected[i * 3 + 2]]);
                  // Reject near-plane crossings rather than reporting infinite
                  // projection lengths. Frustum overlap is not depth visibility;
                  // terrain behind another mesh is explicitly still counted.
                  if (points.some((v) => v[2] < -1 || v[2] > 1)) return;
                  if (Math.max(...points.map((v) => v[0])) < 0 || Math.min(...points.map((v) => v[0])) > width
                    || Math.max(...points.map((v) => v[1])) < 0 || Math.min(...points.map((v) => v[1])) > height) return;
                  const edgePx = Math.max(...points.map((v, i) => Math.hypot(v[0] - points[(i + 1) % 3][0], v[1] - points[(i + 1) % 3][1])));
                  row.viewportTriangles++;
                  if (edgePx > row.maxProjectedCellEdgePx) row.maxProjectedCellEdgePx = edgePx;
                  if (row.largestTriangles.length < 3 || edgePx > row.largestTriangles.at(-1).edgePx) {
                    row.largestTriangles.push({ edgePx, indices: [a, b, c], points });
                    row.largestTriangles.sort((a, b) => b.edgePx - a.edgePx); row.largestTriangles.length = Math.min(3, row.largestTriangles.length);
                  }
                };
                for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
                  const a = y * (N + 1) + x, b = a + 1, c = a + N + 1;
                  triangle(a, b, c); triangle(b, c + 1, c);
                }
              }
              records.push(row);
            }
            for (const child of node.children || []) walk(child);
          };
          for (const root of lod.roots) walk(root);
          records.sort((a, b) => b.maxProjectedCellEdgePx - a.maxProjectedCellEdgePx);
          return { width, height, lodFrame: lod._frame, histogram, frustumHistogram, records,
            caveat: 'Exact morphed mesh vertex projection in CSS screenshot pixels; frustum/AABB overlap does not prove depth-visible terrain. No split-distance constant is guessed; screen/min-level/force requests and actual ownership state are separate.' };
        });
        await writeFile(`${out}/${altitude}m-visible-ownership.json`, JSON.stringify(ownership, null, 2));
        capture.ownershipArtifact = `${altitude}m-visible-ownership.json`;
      }
      assert.ok(capture.programs.length > 0, 'A/B material must actually compile and draw.');
      assert.ok(Math.abs(capture.radialAltitude - altitude) <= 1,
        `${mode}: radial altitude ${capture.radialAltitude} differs from requested ${altitude}`);
      for (const program of capture.programs) {
        assert.equal(program.fragment.includes('TERRAIN_MID_FULL_NORMAL'), !['identity','restored','mesh-normal'].includes(mode));
        assert.equal(program.fragment.includes('TERRAIN_MID_VERTEX_FIELDS'), mode === 'full-normal-vertexfields');
        assert.equal(program.fragment.includes('TERRAIN_MID_CONSTANT_ALBEDO'), mode === 'full-normal-constant-albedo');
      }
      if (mode === 'full-normal-no-shadow') assert.equal(capture.terrainShadowFlags.receiving,0);
      for (const key of ['cosmicHours', 'exposure', 'gradeTime', 'oceanTime']) assert.equal(capture[key], held[key], `${mode}: ${key} drift`);
      assert.deepEqual(capture.cameraPosition, held.cameraPosition);
      assert.deepEqual(capture.cameraQuaternion, held.cameraQuaternion);
      assert.equal(capture.terrain.pending, 0);
      if (mode === 'continuous-full-normal') assert.ok(capture.candidateNoiseCalls > 10000,
        'Candidate noise must actually feed rebuilt terrain, not just replace an unused method.');
      if (mode === 'continuous-full-normal') {
        capture.normalParity = await page.evaluate(() => {
          const p = NMS._planet(0), T = NMS._THREE, nodes = [];
          const walk = (node) => { if (node.mesh?.visible && !p.lod.beyondHorizon(node)) nodes.push(node);
            for (const child of node.children || []) walk(child); };
          for (const root of p.lod.roots) walk(root);
          nodes.sort((a, b) => p.lod.nodeDistance(a) - p.lod.nodeDistance(b));
          const fixtures = nodes.slice(0, 16).map((node) => {
            const N = p.gridCellsAtLevel(node.level), i = Math.floor(N / 2), j = Math.floor(N / 2);
            const u = node.u0 + (node.u1 - node.u0) * i / N, v = node.v0 + (node.v1 - node.v0) * j / N;
            const q = new T.Vector3(...[[1,v,-u],[-1,v,u],[u,1,-v],[u,-1,v],[u,v,1],[-u,v,-1]][node.face]).normalize();
            const a = node.mesh.geometry.getAttribute('normal'), index = j * (N + 1) + i;
            return { q, eps: Math.PI / 2 / (N * 2 ** node.level) * .5, freq: p.freqAtLevel(node.level),
              actual: new T.Vector3(a.getX(index),a.getY(index),a.getZ(index)).normalize(),
              address: `${node.face}/${node.level}/${node.ix}/${node.iy}` };
          });
          const expected = ({ q, eps, freq }) => {
            const tangent = Math.abs(q.y) < .95 ? new T.Vector3(-q.z,0,q.x).normalize()
              : new T.Vector3(1,0,0).projectOnPlane(q).normalize();
            const bitangent = new T.Vector3().crossVectors(q,tangent);
            const a = q.clone().addScaledVector(tangent,eps).normalize();
            const b = q.clone().addScaledVector(bitangent,eps).normalize();
            const base = q.clone().multiplyScalar(p.R + p.height(q,freq));
            return a.multiplyScalar(p.R + p.height(a,freq)).sub(base)
              .cross(b.multiplyScalar(p.R + p.height(b,freq)).sub(base)).normalize();
          };
          const angle = (a,b) => T.MathUtils.radToDeg(Math.acos(T.MathUtils.clamp(a.dot(b),-1,1)));
          const rows = fixtures.map((f) => ({ address:f.address, candidateErrorDegrees:angle(f.actual,expected(f)) }));
          const current = window.__terrainKernelOriginal.map(({key}) => ({key,method:p[key].noise}));
          try {
            for (const entry of window.__terrainKernelOriginal) p[entry.key].noise = entry.method;
            fixtures.forEach((f,i) => { rows[i].legacyErrorDegrees = angle(f.actual,expected(f)); });
          } finally { for (const entry of current) p[entry.key].noise = entry.method; }
          return rows;
        });
        assert.ok(capture.normalParity.length > 0);
        assert.ok(Math.max(...capture.normalParity.map((row) => row.candidateErrorDegrees)) < .001,
          'Actual rebuilt normal attributes must match the candidate terrain sampler.');
      }
      await writeFile(`${out}/${artifact}-programs.json`, JSON.stringify(capture.programs, null, 2));
      delete capture.programs;
      report.captures.push({ requestedAltitude: altitude, mode, artifact, fixture, held, kernelRebuild, ...capture });
      console.log(`${artifact}: actual HUD altitude ${capture.stats.alt}, terrain L${capture.terrain.visibleMaxLevel}`);
    }
    await restore();
  }
  assert.deepEqual(errors, []);
  report.endFingerprint = await evidenceFingerprint('tools/terrainmidvisualtest.js');
  assert.equal(report.endFingerprint.sourceDigest, fingerprint.sourceDigest, 'Source changed during attribution.');
  report.status = 'attribution-captured-not-visual-pass';
} catch (error) {
  report.status = 'fail'; report.error = String(error.stack || error);
  report.failureState = await page.evaluate(() => ({ stats: NMS.stats(),
    farFloraPending: NMS._ff.pending(),
    bodies: NMS._internals.universe.system.planets.map((p) => ({ id: p.bodyId,
      terrain: p.lod?.debugStats?.(), water: p.waterLod?.debugStats?.(),
      near: p.nearWaterPatch?.debugStats?.() })) })).catch(() => null);
  await page.screenshot({ path: `${out}/failure.png` }).catch(() => {});
  throw error;
} finally {
  report.errors = errors;
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  await restore().catch(() => {});
  await context.close(); await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
