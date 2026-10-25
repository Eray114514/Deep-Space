// Destination WORLD preparation: independent complete-source reference versus
// the selected compiler-only view, with real Planet terrain/water and native HDR.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const verifier = 'tools/destinationpreparationgputest.js', hash = bytes => createHash('sha256').update(bytes).digest('hex');
const out = `test-results/destination-preparation-gpu/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(`${out}/inputs`, { recursive: true });
const verifierBytes = await readFile(verifier);await writeFile(`${out}/verifier.js`, verifierBytes);
const addonFiles = ['node_modules/three/package.json',
  ...['loaders/KTX2Loader.js', 'utils/WorkerPool.js', 'libs/ktx-parse.module.js', 'libs/zstddec.module.js', 'math/ColorSpaces.js']
    .map(file => `node_modules/three/examples/jsm/${file}`)];
const addons = async () => Promise.all(addonFiles.map(async file => { const bytes = await readFile(file);return { path: file, bytes: bytes.length, sha256: hash(bytes) }; }));
const report = { scope: 'Fresh real Planet roots/materials, synthetic PBR parked-hull and persistent instanced/ordinary witnesses, exact destination WORLD lights and target including controlled body-local Point/Hemisphere and orphan-station Point lights (artificial-sites.js light-domain witnesses). Complete-source reference versus compileDestinationVariant for 1/2 stellar sources x shadow off/on, each in independent fresh pages. Native HDR and preparation identity only; no actual Ship GLB, artificial-site model acceptance, destination gameplay, cloud transport, cold-start or FPS acceptance.',
  before: await evidenceFingerprint(verifier), addonBefore: await addons(), errors: [], driverWarnings: [], warnings: [], cases: [], comparisons: [] };
let server, browser, page;
try {
  const manifest = [];
  for (const file of [...new Set([...report.before.sourceFiles, ...addonFiles, 'tools/browser.js', 'tools/server.js', 'tools/evidence-fingerprint.js', 'tools/canonical-planet-fixture.js'])]) {
    const bytes = await readFile(file), destination = `${out}/inputs/${file}`;await mkdir(path.dirname(destination), { recursive: true });await writeFile(destination, bytes);
    manifest.push({ path: file, bytes: bytes.length, sha256: hash(bytes) });
  }
  await writeFile(`${out}/inputs/manifest.json`, JSON.stringify(manifest, null, 2));
  const serving = await startServer(0);server = serving.server;
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined, headless: true });report.browserVersion = browser.version();
  page = await browser.newPage({ viewport: { width: 860, height: 360 }, deviceScaleFactor: 1 });page.setDefaultTimeout(180000);
  page.on('pageerror', error => report.errors.push(String(error)));
  page.on('console', message => {
    const text = message.text();if (message.type() === 'error') report.errors.push(text);
    if (message.type() === 'warning') { report.warnings.push(text);if (/GL_INVALID|CONTEXT_LOST|INVALID_(?:ENUM|VALUE|OPERATION)|GL_OUT_OF_MEMORY|Program object expected/i.test(text)) report.driverWarnings.push(text); }
  });
  await page.route('**/__destination-preparation*', route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><title>Destination preparation</title><link rel="icon" href="data:,">'
    + '<script type="importmap">{"imports":{"three":"/vendor/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>'
    + '<style>body{background:#172332;color:#e2e8ed;font:14px system-ui}canvas{width:192px;height:192px;image-rendering:pixelated;margin:6px}#fixture{display:none}</style>'
    + '<p>Real Planet terrain/water; synthetic hull/persistent witnesses. Native HDR preparation identity only.</p>'
    + '<canvas id="fixture"></canvas><canvas id="combined" width="32" height="32"></canvas><canvas id="terrain" width="32" height="32"></canvas><canvas id="water" width="32" height="32"></canvas><pre id="status">running</pre>' }));
  for (const stars of [1, 2]) for (const shadows of [false, true]) for (const implementation of ['reference', 'candidate']) {
    await page.goto(`http://127.0.0.1:${serving.port}/__destination-preparation?vclouds=1&stars=${stars}&shadows=${Number(shadows)}&implementation=${implementation}`);
    const result = await page.evaluate(async ({ stars, shadows, implementation }) => {
      const T = await import('three');
      const { Planet } = await import('/src/planet.js');
      const { createGameRenderer } = await import('/src/renderer-runtime.js');
      const { compilePrograms } = await import('/src/program-preparation.js');
      const { withSurfaceWarmupVariant } = await import('/src/render-prewarm.js');
      const { compileDestinationVariant } = await import('/src/destination-preparation.js');
      const result = { implementation, stars, shadows, checks: [], gl: [], captures: {}, sources: [], draws: [],
        preparation: null, shaderErrors: [], contextLosses: [],
        input: { seed: 'destination-preparation-real-surface', radiusMeters: 6e6, size: 32, halfFloat: true,
          realPlanetTerrainWater: true, syntheticHull: true, syntheticPersistentObjects: true, weatherWorker: false,
          controlledLocalLights: { source: 'src/artificial-sites.js addPad PointLight; floatingCity Hemisphere/Point lights; orphan station under universeRoot',
            bodyFutureVisibleRoot: true, bodyVisiblePoint: true, bodyVisibleHemisphere: true, orphanVisiblePoint: true, bodyHiddenDescendantPointExcluded: true },
          analyticalCloudDecksAndFallbackAtmosphereHiddenForSurfaceIsolation: true, receiverScreenScope: true,
          sourcePoison: 'Hidden source-system mesh; unrelated real source Planet; hidden WORLD exclude and layer2 witnesses; ship interior; parented site outside target body.' } };
      const check = (name, pass, details) => { result.checks.push({ name, pass: Boolean(pass), ...(details === undefined ? {} : { details }) });if (!pass) throw Error(name); };
      // Preparation misses must retain the actual first-draw program evidence
      // and all native comparisons. These are still hard final-report gates.
      const contract = (name, pass, details) => result.checks.push({ name, pass: Boolean(pass), ...(details === undefined ? {} : { details }) });
      const ids = new WeakMap();let nextId = 0;const id = value => { if (!value) return null;if (!ids.has(value)) ids.set(value, ++nextId);return ids.get(value); };
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      const objects = [], materials = [], geometries = [], referenceInstances = [], planets = [];
      let r, gl, target, caller, originalCompile, originalDirect, poisonCalls = 0, phase = 'construct';
      const sha = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', value))].map(x => x.toString(16).padStart(2, '0')).join('');
      const shaText = value => sha(new TextEncoder().encode(value));
      const checkpoint = name => { const errors = [];for (let i = 0; i < 16; i++) { const n = gl.getError();if (!n) break;errors.push(n); }const lost = gl.isContextLost();result.gl.push({ name, errors, lost });check(`GL0/live ${name}`, !errors.length && !lost); };
      const programSet = material => new Set(r.properties.get(material).programs?.values() || []);
      const programRow = async program => ({ id: program.id, native: id(program.program), cacheKey: program.cacheKey,
        vertexSha256: await shaText(gl.getShaderSource(program.vertexShader) || ''), fragmentSha256: await shaText(gl.getShaderSource(program.fragmentShader) || '') });
      const snapshot = list => list.map(object => ({ name: object.name, id: id(object), parent: id(object.parent), children: object.children.map(id),
        visible: object.visible, culled: object.frustumCulled, cast: object.castShadow, receive: object.receiveShadow, layers: object.layers.mask,
        matrixAuto: object.matrixAutoUpdate, worldAuto: object.matrixWorldAutoUpdate, worldDirty: object.matrixWorldNeedsUpdate,
        position: object.position.toArray(), quaternion: object.quaternion.toArray(), scale: object.scale.toArray(),
        matrix: object.matrix.toArray(), world: object.matrixWorld.toArray(), count: object.isInstancedMesh ? object.count : null,
        instanceMatrix: object.instanceMatrix ? { attribute: id(object.instanceMatrix), array: id(object.instanceMatrix.array), values: Array.from(object.instanceMatrix.array), version: object.instanceMatrix.version } : null,
        instanceColor: object.instanceColor ? { attribute: id(object.instanceColor), array: id(object.instanceColor.array), values: Array.from(object.instanceColor.array), version: object.instanceColor.version } : null }));
      const read = (output, ArrayType = Uint16Array) => {
        const saved = r.getRenderTarget(), face = r.getActiveCubeFace(), mip = r.getActiveMipmapLevel(), bits = new ArrayType(output.width * output.height * 4);
        try { r.setRenderTarget(output);r.readRenderTargetPixels(output, 0, 0, output.width, output.height, bits); }
        finally { r.setRenderTarget(saved, face, mip); }return bits;
      };
      const metadata = async (bits, clear) => { let nonfinite = 0, nonclearRGB = 0, nonzeroRGB = 0, hdrRGB = 0;const red = new Set();
        for (let i = 0; i < bits.length; i++) { const value = T.DataUtils.fromHalfFloat(bits[i]);if (!Number.isFinite(value)) nonfinite++;
          if (i % 4 !== 3) { if (bits[i] !== clear[i]) nonclearRGB++;if (value !== 0) nonzeroRGB++;if (value > 1) hdrRGB++; }else continue;
          if (i % 4 === 0) red.add(bits[i]); }
        return { sha256: await sha(bits), nonfinite, nonclearRGB, nonzeroRGB, hdrRGB, distinctRed: red.size }; };
      try {
        const canvas = document.getElementById('fixture');canvas.addEventListener('webglcontextlost', event => result.contextLosses.push({ at: event.timeStamp, message: event.statusMessage }));
        ({ renderer: r } = await createGameRenderer({}, { canvas, logarithmicDepthBuffer: true, antialias: false }));gl = r.getContext();
        const debug = gl.getExtension('WEBGL_debug_renderer_info');result.gpu = gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
        check('Real hardware WebGL2/half-float', r.capabilities.isWebGL2 && !/swiftshader|software|llvmpipe/i.test(result.gpu) && gl.getExtension('EXT_color_buffer_float'));
        r.setPixelRatio(1);r.setSize(32, 32);r.setClearColor(0x111a23, 0);r.shadowMap.enabled = true;r.shadowMap.type = T.PCFShadowMap;r.toneMapping = T.NoToneMapping;
        r.debug.checkShaderErrors = true;r.debug.onShaderError = (context, program, vertex, fragment) => result.shaderErrors.push({ program: context.getProgramInfoLog(program), vertex: context.getShaderInfoLog(vertex), fragment: context.getShaderInfoLog(fragment) });
        target = new T.WebGLRenderTarget(32, 32, { type: T.HalfFloatType, depthBuffer: true });target.texture.colorSpace = T.NoColorSpace;
        caller = new T.WebGLCubeRenderTarget(8, { generateMipmaps: true, minFilter: T.LinearMipmapLinearFilter });
        const scene = new T.Scene(), universeRoot = new T.Group(), sourceSystem = new T.Group(), destinationGroup = new T.Group();scene.add(universeRoot);universeRoot.add(sourceSystem, destinationGroup);
        const eye = new T.Vector3(.35, .5, .8).normalize(), sun = new T.Vector3(.25, .65, .72).normalize(), right = new T.Vector3().crossVectors(eye, new T.Vector3(0, 1, 0)).normalize(), up = new T.Vector3().crossVectors(right, eye).normalize(), R = 6e6;
        const camera = new T.PerspectiveCamera(50, 1, .12, 1e8);camera.position.copy(eye).multiplyScalar(R * 1.35);camera.lookAt(0, 0, 0);
        const cameraRig = new T.Group();cameraRig.name = 'attached-camera-rig-clone-sentinel';cameraRig.clone = () => { throw Error('Camera preparation recursively cloned the attached rig'); };camera.add(cameraRig);camera.updateMatrixWorld(true);
        const body = new Planet({ seed: result.input.seed, name: 'Destination surface witness', posUniv: new T.Vector3(), type: 'lush', radius: R,
          tuning: { cloudCoverage: .64, weatherStyle: 'temperate-synoptic' } });planets.push(body);destinationGroup.add(body.group);body.group.visible = false;
        // Controlled witnesses for landing-pad and floating-city local light
        // families. The body root will be enabled for the future WORLD draw;
        // visible descendants count even while that current root is hidden.
        const bodyPoint = new T.PointLight(0x7dc5ff, R * R * .12, R * .8, 2);bodyPoint.name = 'body-visible-pad-point';
        bodyPoint.position.copy(eye).multiplyScalar(R * 1.2).addScaledVector(right, -.15 * R);body.group.add(bodyPoint);
        const bodyHemi = new T.HemisphereLight(0x9ccde7, 0x322015, .65);bodyHemi.name = 'body-visible-city-hemisphere';bodyHemi.position.copy(up).multiplyScalar(R);body.group.add(bodyHemi);
        const hiddenBodyBranch = new T.Group();hiddenBodyBranch.name = 'body-hidden-local-light-branch';hiddenBodyBranch.visible = false;
        const hiddenBodyPoint = new T.PointLight(0xff00ff, R * R * 100, R * 10, 2);hiddenBodyPoint.name = 'body-hidden-descendant-point';hiddenBodyBranch.add(hiddenBodyPoint);body.group.add(hiddenBodyBranch);
        const sourcePlanet = new Planet({ seed: 'unrelated-destination-source', name: 'Excluded actual source Planet', posUniv: new T.Vector3(1e10, 0, 0), type: 'lush', radius: R, tuning: { cloudCoverage: 0 } });planets.push(sourcePlanet);sourceSystem.add(sourcePlanet.group);sourceSystem.visible = false;
        const poison = name => { const material = new T.MeshBasicMaterial();material.onBeforeCompile = () => { poisonCalls++;throw Error(`unwanted-source:${name}`); };materials.push(material);const mesh = new T.Mesh(new T.BoxGeometry(), material);geometries.push(mesh.geometry);mesh.name = name;return mesh; };
        const sourcePoison = poison('source-only-poison');sourceSystem.add(sourcePoison);sourceSystem.children.splice(sourceSystem.children.indexOf(sourcePoison), 1);sourceSystem.children.unshift(sourcePoison);
        for (let i = 0; i < 2; i++) { const light = new T.DirectionalLight(0xff00ff, 30);light.position.set(0, R * 2, 0);sourceSystem.add(light); }
        const roots = [];
        for (const [family, lod] of [['terrain', body.lod], ['water', body.waterLod]]) for (const [i, root] of (lod?.roots || []).entries()) {
          if (!root.mesh) continue;root.mesh.name = `${family}-root-${i}`;root.mesh.visible = true;roots.push(root.mesh);
        }
        const targetExtras = [body.nearWaterPatch?.mesh, body.atmoMesh, body.cloudMesh, body.cloudMesh2, body.ringMesh].filter(Boolean);
        for (const [i, mesh] of targetExtras.entries()) if (!mesh.name) mesh.name = `target-hidden-or-ring-${i}`;
        for (const mesh of [body.atmoMesh, body.cloudMesh, body.cloudMesh2].filter(Boolean)) mesh.visible = false;
        const destination = { starViews: [], artificialSites: [] }, sourceField = [];
        for (let i = 0; i < stars; i++) {
          const group = new T.Group(), light = new T.DirectionalLight(i ? 0xadcaff : 0xffeed9, i ? 1.1 : 2.6), direction = i ? new T.Vector3(-.32, .48, .81).normalize() : sun;
          light.position.copy(direction).multiplyScalar(R * 3);group.add(light, light.target);group.visible = false;destinationGroup.add(group);
          const material = new T.MeshBasicMaterial({ color: i ? 0x80baff : 0xffbd72 });materials.push(material);
          const visual = new T.Mesh(new T.BoxGeometry(R * .01, R * .01, R * .01), material);geometries.push(visual.geometry);visual.name = `destination-star-${i}`;visual.position.copy(eye).multiplyScalar(R * 4);group.add(visual);
          destination.starViews.push({ group, light });sourceField.push({ direction: direction.toArray(), color: i ? [.68, .8, 1] : [1, .98, .94], distance: 1e12, radius: 2e10, irradianceFraction: i ? .35 : 1 });
        }
        body.setStellarLights({ sources: sourceField, radianceScale: 3.2 });body.setStellarOccluders([]);
        const ambient = new T.AmbientLight(0x8bacdd, .55), hemi = new T.HemisphereLight(0xbacbff, 0x352c20, .25);scene.add(ambient, hemi);
        const shadowLight = new T.DirectionalLight(0xffe5bf, 1.7);shadowLight.position.copy(sun).multiplyScalar(R * 3);shadowLight.castShadow = true;shadowLight.visible = false;
        shadowLight.shadow.mapSize.set(64, 64);Object.assign(shadowLight.shadow.camera, { left: -R * 1.4, right: R * 1.4, top: R * 1.4, bottom: -R * 1.4, near: .1, far: R * 6 });shadowLight.shadow.camera.updateProjectionMatrix();scene.add(shadowLight, shadowLight.target);
        const shared = new T.MeshStandardMaterial({ color: 0x6c9c85, roughness: .43, metalness: .22 });materials.push(shared);
        const place = (object, x, y, z = 1.12) => { object.position.copy(eye).multiplyScalar(R * z).addScaledVector(right, x * R).addScaledVector(up, y * R);object.castShadow = true;object.receiveShadow = true;return object; };
        const geometry = new T.BoxGeometry(R * .065, R * .065, R * .065);geometries.push(geometry);
        const persistent = new T.Group(), ordinary = place(new T.Mesh(geometry, shared), -.11, .08);ordinary.name = 'persistent-shared-mesh';persistent.add(ordinary);scene.add(persistent);
        const instances = place(new T.InstancedMesh(geometry, shared, 2), .10, .08);instances.name = 'persistent-shared-instances';instances.setMatrixAt(0, new T.Matrix4());instances.setMatrixAt(1, new T.Matrix4().makeTranslation(R * .08, 0, 0));instances.setColorAt(0, new T.Color(.9, .5, .2));instances.setColorAt(1, new T.Color(.2, .6, .9));persistent.add(instances);
        const zero = new T.InstancedMesh(geometry, shared, 1);zero.name = 'zero-count-instance-family';zero.count = 0;zero.setColorAt(0, new T.Color(1, 0, 1));persistent.add(zero);
        const hullMaterial = new T.MeshStandardMaterial({ color: 0x697c93, metalness: .74, roughness: .32 });materials.push(hullMaterial);
        const ship = { group: new T.Group(), int: { group: new T.Group() }, separateInterior: true };
        const hull = place(new T.Mesh(geometry, hullMaterial), 0, -.11, 1.15);hull.name = 'synthetic-future-world-hull';hull.layers.set(3);ship.group.add(hull, ship.int.group);ship.group.visible = false;scene.add(ship.group);
        const cabin = poison('isolated-cabin-poison');cabin.layers.set(6);ship.int.group.add(cabin);const cabinLight = new T.PointLight(0xff0000, 99);cabinLight.layers.set(6);ship.int.group.add(cabinLight);
        const station = place(new T.Group(), -.12, -.10, 1.13);station.name = 'orphan-station-root';destinationGroup.add(station);destination.artificialSites.push({ group: station, parentBody: null });
        const stationMesh = new T.Mesh(geometry, shared);stationMesh.name = 'independent-destination-site';stationMesh.castShadow = true;stationMesh.receiveShadow = true;station.add(stationMesh);
        const orphanPoint = new T.PointLight(0xffb45f, R * R * .004, R * .45, 2);orphanPoint.name = 'orphan-station-visible-point';orphanPoint.position.copy(eye).multiplyScalar(R * .05);station.add(orphanPoint);
        const attached = poison('parented-site-outside-body');attached.visible = false;destinationGroup.add(attached);destination.artificialSites.push({ group: attached, parentBody: body });
        const excluded = new T.Group();excluded.visible = false;excluded.add(poison('explicit-exclude-poison'));scene.add(excluded);
        const otherLayer = poison('layer-two-poison');otherLayer.layers.set(2);otherLayer.visible = false;scene.add(otherLayer);
        scene.updateMatrixWorld(true);
        const intended = [...roots, ...targetExtras, ordinary, instances, zero, hull, stationMesh, ...destination.starViews.flatMap(view => view.group.children.filter(child => child.isMesh))];
        const intendedNames = intended.map(object => object.name).sort();check('Actual nonempty terrain and water roots exist', roots.filter(x => x.material === body.terrainMaterial).length === 6 && roots.filter(x => x.material === body.liquidMat).length === 6);
        const track = [];scene.traverse(object => track.push(object));camera.traverse(object => track.push(object));const beforeState = snapshot(track);
        const expectedMaterials = [...new Set(intended.flatMap(object => [object.material].flat()))], allPrepared = new Map();
        check('Fresh actual surface owner has no prepared GPU program or prebound draw uniforms', expectedMaterials.every(material => programSet(material).size === 0)
          && !body.terrainMaterial.userData.surfaceMedium && !body.liquidMat.userData.surfaceMedium);
        const lightTuple = light => ({ name: light.name, type: light.type, shadow: light.castShadow, intensity: light.intensity, color: light.color.toArray(),
          groundColor: light.groundColor?.toArray(), distance: light.distance, decay: light.decay,
          position: light.position.toArray(), quaternion: light.quaternion.toArray(), scale: light.scale.toArray(), layers: light.layers.mask, visible: light.visible,
          target: light.target?.position.toArray(), shadowCamera: light.castShadow ? { left: light.shadow.camera.left, right: light.shadow.camera.right,
            top: light.shadow.camera.top, bottom: light.shadow.camera.bottom, near: light.shadow.camera.near, far: light.shadow.camera.far } : null });
        // Explicit truth order matches the future WORLD scene traversal, not
        // the helper's discovery. This also preserves native light-addition
        // order for the independent full-scene formal reference draw.
        const truthLights = [bodyPoint, bodyHemi, ...destination.starViews.map(view => view.light), orphanPoint, ambient, hemi, ...(shadows ? [shadowLight] : [])];
        const expectedLights = truthLights.map(light => {
          const position = new T.Vector3(), quaternion = new T.Quaternion(), scale = new T.Vector3();light.matrixWorld.decompose(position, quaternion, scale);
          return { ...lightTuple(light), position: position.toArray(), quaternion: quaternion.toArray(), scale: scale.toArray(), visible: true, layers: 1 };
        });
        const canonicalLights = rows => rows.map(row => JSON.stringify(row)).sort();result.expectedLights = expectedLights;
        let truthScene = null, truthObjects = null;
        if (implementation === 'reference') {
          truthScene = new T.Scene();truthObjects = [];
          // This explicit truth list is authored above, independently of the
          // helper's discovery traversal. Borrow attributes without serializing
          // or cloning userData/CPU instance arrays.
          for (const object of intended) {
            const copy = object.isInstancedMesh ? new T.InstancedMesh(object.geometry, object.material, object.instanceMatrix.count) : new T.Mesh(object.geometry, object.material);
            if (copy.isInstancedMesh) { copy.instanceMatrix = object.instanceMatrix;copy.instanceColor = object.instanceColor;copy.count = object.count;referenceInstances.push(copy); }
            copy.name = object.name;copy.userData = object.userData;copy.layers.set(0);copy.visible = object.visible;copy.frustumCulled = object.frustumCulled;copy.renderOrder = object.renderOrder;
            copy.castShadow = object.castShadow;copy.receiveShadow = object.receiveShadow;copy.customDepthMaterial = object.customDepthMaterial;copy.customDistanceMaterial = object.customDistanceMaterial;
            copy.onBeforeRender = object.onBeforeRender;copy.onBeforeShadow = object.onBeforeShadow;copy.matrixAutoUpdate = false;copy.matrix.copy(object.matrixWorld);truthScene.add(copy);truthObjects.push(copy);
          }
          for (const light of truthLights) {
            const copy = light.clone(false);copy.visible = true;copy.layers.set(0);light.matrixWorld.decompose(copy.position, copy.quaternion, copy.scale);
            if (copy.target) { light.target.matrixWorld.decompose(copy.target.position, copy.target.quaternion, copy.target.scale);truthScene.add(copy.target); }truthScene.add(copy);objects.push(copy);
          }
        }
        originalCompile = r.compile;
        r.compile = function(source, compileCamera, lighting) {
          const selected = [];source.traverse(object => { if (object.isMesh) selected.push({ name: object.name, actual: intended.includes(object), instanced: !!object.isInstancedMesh, count: object.isInstancedMesh ? object.count : null, matrixAttribute: id(object.instanceMatrix), colorAttribute: id(object.instanceColor), parent: id(object.parent),
            surface: object.material === body.terrainMaterial || object.material === body.liquidMat, screen: object.material.defines?.SURFACE_CLOUD_SCREEN, stellarUnion: object.material.defines?.STELLAR_UNION_OCCLUSION }); });
          const lights = []; (lighting || source).traverseVisible(object => { if (object.isLight && object.layers.test(compileCamera.layers)) lights.push(lightTuple(object)); });
          result.preparation = { selected, lights, targetMatches: r.getRenderTarget() === target, face: r.getActiveCubeFace(), mip: r.getActiveMipmapLevel(), cameraMask: compileCamera.layers.mask };
          return originalCompile.call(this, source, compileCamera, lighting);
        };
        r.setRenderTarget(caller, 3, 1);phase = 'compile';let pending;
        if (implementation === 'candidate') pending = compileDestinationVariant(r, { scene, camera, universeRoot, body, destination, ship, shadowLight, target, shadows, exclude: [excluded] });
        else { r.setRenderTarget(target);try { pending = withSurfaceWarmupVariant(truthScene, () => compilePrograms(r, truthScene, camera)); }finally { r.setRenderTarget(caller, 3, 1); } }
        check('Synchronous compiler sees exact explicit destination source list', same(result.preparation.selected.map(x => x.name).sort(), intendedNames));
        check('Actual instanced objects/count0/attributes survive compiler view', result.preparation.selected.some(x => x.name === zero.name && x.count === 0)
          && (implementation !== 'candidate' || result.preparation.selected.every(x => x.actual)));
        contract('Destination WORLD target and light counts are exact', result.preparation.targetMatches && result.preparation.cameraMask === 1
          && result.preparation.lights.filter(x => x.type === 'DirectionalLight').length === stars + Number(shadows)
          && result.preparation.lights.filter(x => x.type === 'PointLight').length === 2
          && result.preparation.lights.filter(x => x.type === 'HemisphereLight').length === 2
          && result.preparation.lights.filter(x => x.shadow).length === Number(shadows));
        contract('Complete destination light colors/transforms/shadow cameras match explicit truth', same(canonicalLights(result.preparation.lights), canonicalLights(expectedLights)));
        check('Real surface compile selects production SCREEN1 and owner stellar macro', result.preparation.selected.filter(row => row.surface).every(row => row.screen === 1 && row.stellarUnion === 0));
        check('Source objects and CPU instance arrays unchanged before readiness', same(beforeState, snapshot(track)));
        check('Complete caller cube face/mip restored before readiness', r.getRenderTarget() === caller && r.getActiveCubeFace() === 3 && r.getActiveMipmapLevel() === 1);
        check('No excluded/source/cabin material compiled', poisonCalls === 0);
        await pending;check('Source objects remain unchanged after readiness', same(beforeState, snapshot(track)));
        for (const material of expectedMaterials) allPrepared.set(material, programSet(material));
        result.prepared = await Promise.all(expectedMaterials.map(async material => ({ material: material.type, ids: await Promise.all([...allPrepared.get(material)].map(programRow)) })));
        r.compile = originalCompile;originalCompile = null;
        // Perform the future parked-world transition only after the immutable
        // preparation check. Reference clones represent this same WORLD pass.
        body.group.visible = true;ship.group.visible = true;hull.layers.set(0);shadowLight.visible = shadows;
        for (const view of destination.starViews) view.group.visible = true;
        const drawScene = truthScene || scene, drawObjects = truthObjects || intended;
        const sourceToDraw = object => truthObjects ? truthObjects[intended.indexOf(object)] : object;
        originalDirect = r.renderBufferDirect;
        r.renderBufferDirect = function(renderCamera, renderScene, drawGeometry, material, object, group) {
          const value = originalDirect.call(this, renderCamera, renderScene, drawGeometry, material, object, group), program = r.properties.get(material).currentProgram;
          result.draws.push({ phase, name: object.name, materialType: material.type, depth: !!(material.isMeshDepthMaterial || material.isMeshDistanceMaterial), program: program?.id, native: id(program?.program) });return value;
        };
        const beforePrograms = new Set(r.info.programs), firstDrawColorNew = [];
        r.setRenderTarget(target);r.clear();const clear = read(target);
        const render = async name => {
          phase = name;r.setRenderTarget(target);withSurfaceWarmupVariant(truthScene || { traverse(work) { for (const object of intended) work(object); } }, () => r.render(drawScene, camera));
          const bits = read(target), meta = await metadata(bits, clear);result.captures[name] = { ...meta, nativeBits: Array.from(bits) };
          check(`${name}: finite occupied real material pixels`, meta.nonfinite === 0 && meta.nonclearRGB > 1000 && meta.nonzeroRGB > 1000 && meta.distinctRed > 12);
          const canvas = document.getElementById(name), context2d = canvas?.getContext('2d');if (context2d) {
            const image = context2d.createImageData(32, 32);for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) for (let c = 0; c < 4; c++) {
              const value = T.DataUtils.fromHalfFloat(bits[((31 - y) * 32 + x) * 4 + c]);image.data[(y * 32 + x) * 4 + c] = c === 3 ? 255 : Math.round(Math.pow(Math.max(0, value) / (1 + Math.max(0, value)), 1 / 2.2) * 255);
            }context2d.putImageData(image, 0, 0);
          }return bits;
        };
        const first = await render('combined');
        for (const material of expectedMaterials) for (const program of programSet(material)) if (!allPrepared.get(material).has(program)) firstDrawColorNew.push(await programRow(program));
        result.firstDrawColorNew = firstDrawColorNew;result.firstDrawNewPrograms = [];
        for (const program of r.info.programs) if (!beforePrograms.has(program)) result.firstDrawNewPrograms.push({ ...await programRow(program), depthDrawWitnesses: result.draws.filter(row => row.phase === 'combined' && row.program === program.id && row.depth).length });
        contract('First formal receiver/hull/instancing color draw creates no unprepared program', firstDrawColorNew.length === 0);
        contract('Any extra first-formal programs are explicitly witnessed shadow-depth families', result.firstDrawNewPrograms.every(row => row.depthDrawWitnesses > 0), result.firstDrawNewPrograms);
        for (const material of [body.terrainMaterial, body.liquidMat]) {
          const program = r.properties.get(material).currentProgram, location = program && gl.getUniformLocation(program.program, 'uLocalStarCount');
          check('Actual Planet physical stellar count uploaded', location && gl.getUniform(program.program, location) === stars);
        }
        if (shadows) {
          const light = truthScene ? objects.find(object => object.isDirectionalLight && object.castShadow) : shadowLight;
          check('Real shadow pass allocated a target and submitted depth geometry', light?.shadow?.map && result.draws.some(row => row.phase === 'combined' && row.depth));
          const bits = read(light.shadow.map, Uint8Array);result.shadow = { width: light.shadow.map.width, height: light.shadow.map.height, nonwhite: bits.filter(value => value !== 255).length };
          check('Actual shadow target contains nonclear depth', result.shadow.nonwhite > 100);
        }
        const repeated = await render('combined-repeat');check('Native full-world repeat is exact', same(Array.from(first), Array.from(repeated)));
        const originalVisible = new Map(drawObjects.map(object => [object, object.visible]));
        for (const family of ['terrain', 'water']) {
          for (const object of drawObjects) object.visible = object.material === (family === 'terrain' ? body.terrainMaterial : body.liquidMat) && object.geometry.getAttribute('position')?.count > 0;
          await render(family);for (const [object, visible] of originalVisible) object.visible = visible;
        }
        checkpoint('formal/repeat/isolated material draws');
        // A full source compile must actually encounter the poison. Run this
        // independently after measurement; no poisoned control warms a case.
        let detected = false;r.setRenderTarget(target);try { compilePrograms(r, scene, camera); }catch (error) { detected = String(error).includes('unwanted-source:'); }
        check('Unfiltered whole-scene source poison is an effective negative control', detected && poisonCalls === 1);result.poisonCalls = poisonCalls;
        r.setRenderTarget(caller, 3, 1);checkpoint('negative source traversal control');
        result.passed = result.checks.every(row => row.pass);
      } catch (error) { result.failure = { message: String(error), stack: error?.stack };result.passed = false; }
      finally {
        if (r && originalCompile) r.compile = originalCompile;if (r && originalDirect) r.renderBufferDirect = originalDirect;
        for (const copy of referenceInstances) copy.dispose();for (const light of objects) light.shadow?.dispose();
        for (const planet of planets) planet.dispose();for (const material of materials) material.dispose();for (const geometry of geometries) geometry.dispose();target?.dispose();caller?.dispose();
        if (r) {
          const deadline = performance.now() + 10000;while (r.programRetirement.snapshot().pending && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
          result.retirement = r.programRetirement.snapshot();check('Guarded native programs retire completely', result.retirement.pending === 0 && !result.retirement.blocked && !result.retirement.faults.length);
          checkpoint('retirement');r.dispose();
        }
      }
      check('No shader errors or context loss', !result.shaderErrors.length && !result.contextLosses.length);
      document.getElementById('status').textContent = JSON.stringify({ implementation, stars, shadows, passed: result.passed, firstColorNew: result.firstDrawColorNew?.length,
        firstShadowDepthNew: result.firstDrawNewPrograms?.length, failure: result.failure?.message }, null, 2);return result;
    }, { stars, shadows, implementation });
    report.cases.push(result);await page.screenshot({ path: `${out}/${implementation}-${stars}-${Number(shadows)}.png` });await writeFile(`${out}/${implementation}-${stars}-${Number(shadows)}.json`, JSON.stringify(result, null, 2));
    await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  }
  for (const stars of [1, 2]) for (const shadows of [false, true]) {
    const pair = report.cases.filter(row => row.stars === stars && row.shadows === shadows);
    for (const stage of ['combined', 'combined-repeat', 'terrain', 'water']) {
      const [a, b] = pair.map(row => row.captures[stage]?.nativeBits);const changed = a && b ? a.reduce((n, value, i) => n + Number(value !== b[i]), 0) : null;
      report.comparisons.push({ stars, shadows, stage, nativeChanged: changed });
    }
  }
  report.physicalControls = [];
  for (const implementation of ['reference', 'candidate']) for (const shadows of [false, true]) {
    const [a, b] = [1, 2].map(stars => report.cases.find(row => row.implementation === implementation && row.stars === stars && row.shadows === shadows)?.captures.combined?.nativeBits);
    report.physicalControls.push({ implementation, shadows, oneVsTwoStarRGB: a && b ? a.reduce((n, value, i) => n + Number(i % 4 !== 3 && value !== b[i]), 0) : null });
  }
  report.after = await evidenceFingerprint(verifier);report.addonAfter = await addons();
  report.passed = report.cases.length === 8 && report.cases.every(row => row.passed && row.checks.every(check => check.pass))
    && report.comparisons.length === 16 && report.comparisons.every(row => row.nativeChanged === 0)
    && report.physicalControls.every(row => row.oneVsTwoStarRGB > 0) && !report.errors.length && !report.driverWarnings.length
    && JSON.stringify(report.before) === JSON.stringify(report.after) && JSON.stringify(report.addonBefore) === JSON.stringify(report.addonAfter);
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));assert.ok(report.passed, `Destination preparation native controls failed: ${out}/report.json`);
  console.log(JSON.stringify({ out, passed: true, cases: 8, nativeComparisons: 16, scope: report.scope }));
} catch (error) {
  report.failure = { message: String(error), stack: error?.stack };await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));throw error;
} finally { await browser?.close();if (server) await new Promise(resolve => server.close(resolve)); }
