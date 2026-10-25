// Native evidence for an atomic WORLD material/light publication, including
// existing receivers. Each control owns a fresh page, renderer and real Planets.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const verifier = 'tools/worldpublicationgputest.js';
const out = `test-results/world-publication-gpu/${new Date().toISOString().replace(/[:.]/g, '-')}`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const addonFiles = ['node_modules/three/package.json',
  ...['loaders/KTX2Loader.js', 'utils/WorkerPool.js', 'libs/ktx-parse.module.js', 'libs/zstddec.module.js', 'math/ColorSpaces.js']
    .map(file => `node_modules/three/examples/jsm/${file}`)];
const addons = async () => Promise.all(addonFiles.map(async file => { const bytes = await readFile(file);return { path: file, bytes: bytes.length, sha256: hash(bytes) }; }));
await mkdir(`${out}/inputs`, { recursive: true });
const verifierBytes = await readFile(verifier);await writeFile(`${out}/verifier.js`, verifierBytes);
const report = { scope: 'Atomic visible WORLD publication: real existing Planet terrain/water and two new real Planet roots; controlled existing-body Point/Hemisphere, city Point and orphan-site Point lights; synthetic parked hull and shared-material ordinary/instanced receivers. Independent full-future-scene reference, runtime publication candidate and new-body-only negative control for 1/2 stars x sun shadow off/on. Native HDR, compiler completeness and held readiness only; no actual Ship/city GLB, destination gameplay, cloud transport, cold-start or FPS acceptance.',
  before: await evidenceFingerprint(verifier), addonBefore: await addons(), cases: [], comparisons: [], errors: [], warnings: [], driverWarnings: [] };
let server, browser;
try {
  const manifest = [];
  for (const file of [...new Set([...report.before.sourceFiles, ...addonFiles, verifier, 'tools/browser.js', 'tools/server.js', 'tools/evidence-fingerprint.js', 'tools/canonical-planet-fixture.js'])]) {
    const bytes = await readFile(file), destination = `${out}/inputs/${file}`;
    await mkdir(path.dirname(destination), { recursive: true });await writeFile(destination, bytes);manifest.push({ path: file, bytes: bytes.length, sha256: hash(bytes) });
  }
  await writeFile(`${out}/inputs/manifest.json`, JSON.stringify(manifest, null, 2));
  const serving = await startServer(0);server = serving.server;
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined, headless: true });report.browserVersion = browser.version();
  const page = await browser.newPage({ viewport: { width: 1000, height: 370 }, deviceScaleFactor: 1 });page.setDefaultTimeout(240000);
  let label = '';
  page.on('pageerror', error => report.errors.push({ label, text: String(error) }));
  page.on('console', message => {
    const row = { label, text: message.text() };
    if (message.type() === 'error') report.errors.push(row);
    else if (message.type() === 'warning') { report.warnings.push(row);if (/GL_INVALID|GL_CONTEXT_LOST|Program object expected|INVALID_(?:ENUM|VALUE|OPERATION)|GL_OUT_OF_MEMORY|WebGL.*(?:error|lost)/i.test(row.text)) report.driverWarnings.push(row); }
  });
  await page.route('**/__world-publication*', route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><title>Atomic WORLD publication</title><link rel="icon" href="data:,">'
    + '<script type="importmap">{"imports":{"three":"/vendor/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>'
    + '<style>body{background:#172332;color:#e2e8ed;font:14px system-ui}canvas{width:180px;height:180px;image-rendering:pixelated;margin:6px}#fixture{display:none}</style>'
    + '<p>Existing real surface remains visible while the WORLD batch compiles. Synthetic hull/city witnesses; native HDR only.</p><canvas id="fixture"></canvas>'
    + '<canvas id="old-before" width="32" height="32"></canvas><canvas id="old-ready-held" width="32" height="32"></canvas>'
    + '<canvas id="published" width="32" height="32"></canvas><canvas id="published-lights-only" width="32" height="32"></canvas><pre id="status">running</pre>' }));
  for (const stars of [1, 2]) for (const shadows of [false, true]) for (const implementation of ['reference', 'candidate', 'new-body-only']) {
    label = `${implementation}-${stars}-${Number(shadows)}`;
    await page.goto(`http://127.0.0.1:${serving.port}/__world-publication?vclouds=1&case=${label}`);
    const result = await page.evaluate(async ({ stars, shadows, implementation }) => {
      const T = await import('three');
      const { Planet } = await import('/src/planet.js');
      const { createGameRenderer } = await import('/src/renderer-runtime.js');
      const { compilePrograms } = await import('/src/program-preparation.js');
      const { compileRenderVariant, withSurfaceWarmupVariant } = await import('/src/render-prewarm.js');
      const { withCloudSurfacePreparation } = await import('/src/cloud/surface-clouds.js');
      const { compileWorldPublicationVariant, worldPublicationRevision } = await import('/src/destination-preparation.js');
      const { captureWorldPublication } = await import('/src/world-publication.js');
      const result = { stars, shadows, implementation, checks: [], captures: {}, compilation: [], draws: [], gl: [], shaderErrors: [], contextLosses: [],
        input: { oldSeed: 'world-publication-existing-surface', newSeeds: ['world-publication-new-body-a', 'world-publication-new-body-b'], radiusMeters: 6e6, size: 32,
          realPlanetTerrainWater: true, syntheticHullCitySite: true, syntheticOrdinaryAndInstancedReceivers: true, worker: false,
          source: 'src/artificial-sites.js landing-pad Point; floating-city Hemisphere and Points; orbital-site lights',
          heldReadiness: true, hiddenFallbackAtmosphereAnalyticalClouds: true, cloudTransportDrawn: false,
          control: 'new-body-only calls the original compileRenderVariant on one hidden new body against the still-visible old scene, without warming existing receivers or future staged lights' } };
      const record = (name, pass, details) => result.checks.push({ name, pass: Boolean(pass), ...(details === undefined ? {} : { details }) });
      const check = (name, pass, details) => { record(name, pass, details);if (!pass) throw Error(name); };
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      const ids = new WeakMap();let nextId = 0;const id = value => { if (!value) return null;if (!ids.has(value)) ids.set(value, ++nextId);return ids.get(value); };
      const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
      const planets = [], ownMaterials = [], ownGeometry = [], ownLights = [], clonedInstances = [], clonedLights = [];
      let r, gl, target, caller, publication, releaseHeld, originalCompile, originalDirect, phase = 'construct';
      const programSet = material => new Set(r.properties.get(material).programs?.values() || []);
      const snapshot = objects => objects.map(object => ({ id: id(object), name: object.name, parent: id(object.parent), children: object.children.map(id),
        visible: object.visible, layers: object.layers.mask, culled: object.frustumCulled, cast: object.castShadow, receive: object.receiveShadow,
        matrixAuto: object.matrixAutoUpdate, worldAuto: object.matrixWorldAutoUpdate, dirty: object.matrixWorldNeedsUpdate,
        position: object.position.toArray(), quaternion: object.quaternion.toArray(), scale: object.scale.toArray(), matrix: object.matrix.toArray(), world: object.matrixWorld.toArray(),
        count: object.isInstancedMesh ? object.count : null, instanceMatrix: object.instanceMatrix ? { id: id(object.instanceMatrix), array: id(object.instanceMatrix.array), version: object.instanceMatrix.version, values: Array.from(object.instanceMatrix.array) } : null,
        instanceColor: object.instanceColor ? { id: id(object.instanceColor), array: id(object.instanceColor.array), version: object.instanceColor.version, values: Array.from(object.instanceColor.array) } : null }));
      const lightTuple = light => ({ name: light.name, type: light.type, color: light.color.toArray(), groundColor: light.groundColor?.toArray(),
        intensity: light.intensity, distance: light.distance, decay: light.decay, shadow: light.castShadow, visible: light.visible, layers: light.layers.mask,
        position: light.position.toArray(), quaternion: light.quaternion.toArray(), scale: light.scale.toArray(), target: light.target?.position.toArray() });
      const canonical = rows => rows.map(row => JSON.stringify(row)).sort();
      const checkpoint = name => { const errors = [];for (let i = 0; i < 16; i++) { const error = gl.getError();if (!error) break;errors.push(error); }result.gl.push({ name, errors, lost: gl.isContextLost() });check(`GL0/live ${name}`, !errors.length && !gl.isContextLost()); };
      const read = (output, ArrayType = Uint16Array) => {
        const saved = r.getRenderTarget(), face = r.getActiveCubeFace(), mip = r.getActiveMipmapLevel(), bits = new ArrayType(output.width * output.height * 4);
        try { r.setRenderTarget(output);r.readRenderTargetPixels(output, 0, 0, output.width, output.height, bits); }
        finally { r.setRenderTarget(saved, face, mip); }return bits;
      };
      const capture = async (name, bits) => {
        let nonfinite = 0, nonzeroRGB = 0, hdrRGB = 0;const red = new Set();
        for (let i = 0; i < bits.length; i++) { const value = T.DataUtils.fromHalfFloat(bits[i]);if (!Number.isFinite(value)) nonfinite++;
          if (i % 4 !== 3) { if (value !== 0) nonzeroRGB++;if (value > 1) hdrRGB++; }if (i % 4 === 0) red.add(bits[i]); }
        result.captures[name] = { sha256: await digest(bits), nonfinite, nonzeroRGB, hdrRGB, distinctRed: red.size, nativeBits: Array.from(bits) };
        check(`${name}: finite nonblack real surface`, !nonfinite && nonzeroRGB > 1000 && red.size > 12);
        const context = document.getElementById(name)?.getContext('2d');if (context) {
          const image = context.createImageData(32, 32);for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) for (let c = 0; c < 4; c++) {
            const value = Math.max(0, T.DataUtils.fromHalfFloat(bits[((31 - y) * 32 + x) * 4 + c]));image.data[(y * 32 + x) * 4 + c] = c === 3 ? 255 : Math.round(Math.pow(value / (1 + value), 1 / 2.2) * 255);
          }context.putImageData(image, 0, 0);
        }return bits;
      };
      const render = async (name, scene, camera) => {
        // Real onBeforeRender selects and retains SCREEN1 as the production
        // receiver path does. Do not repeatedly mutate/restore hidden future
        // materials with the compiler's temporary macro scope during readiness.
        phase = name;r.setRenderTarget(target);withCloudSurfacePreparation(true, () => r.render(scene, camera));return capture(name, read(target));
      };
      try {
        const canvas = document.getElementById('fixture');canvas.addEventListener('webglcontextlost', event => result.contextLosses.push({ at: event.timeStamp, message: event.statusMessage }));
        ({ renderer: r } = await createGameRenderer({}, { canvas, logarithmicDepthBuffer: true, antialias: false }));gl = r.getContext();
        const debug = gl.getExtension('WEBGL_debug_renderer_info');result.gpu = gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
        check('Real hardware WebGL2/half-float', r.capabilities.isWebGL2 && !/swiftshader|software|llvmpipe/i.test(result.gpu) && gl.getExtension('EXT_color_buffer_float'));
        r.setPixelRatio(1);r.setSize(32, 32);r.setClearColor(0x111a23, 0);r.toneMapping = T.NoToneMapping;r.shadowMap.enabled = true;r.shadowMap.type = T.PCFShadowMap;
        r.debug.checkShaderErrors = true;r.debug.onShaderError = (context, program, vertex, fragment) => result.shaderErrors.push({ program: context.getProgramInfoLog(program), vertex: context.getShaderInfoLog(vertex), fragment: context.getShaderInfoLog(fragment) });
        target = new T.WebGLRenderTarget(32, 32, { type: T.HalfFloatType, depthBuffer: true });target.texture.colorSpace = T.NoColorSpace;
        caller = new T.WebGLCubeRenderTarget(8, { generateMipmaps: true, minFilter: T.LinearMipmapLinearFilter });
        const R = 6e6, eye = new T.Vector3(.35, .5, .8).normalize(), sun = new T.Vector3(.25, .65, .72).normalize();
        const right = new T.Vector3().crossVectors(eye, new T.Vector3(0, 1, 0)).normalize(), up = new T.Vector3().crossVectors(right, eye).normalize();
        const pointAt = (x, y, z) => eye.clone().multiplyScalar(R * z).addScaledVector(right, R * x).addScaledVector(up, R * y);
        const scene = new T.Scene(), universeRoot = new T.Group(), systemRoot = new T.Group();scene.add(universeRoot);universeRoot.add(systemRoot);
        const camera = new T.PerspectiveCamera(50, 1, .12, 1e8);camera.position.copy(eye).multiplyScalar(R * 1.35);camera.lookAt(0, 0, 0);
        const rig = new T.Group();rig.name = 'attached-camera-rig-clone-sentinel';rig.clone = () => { throw Error('Camera preparation cloned its attached rig'); };camera.add(rig);camera.updateMatrixWorld(true);
        const starField = [];
        for (let i = 0; i < stars; i++) {
          const direction = i ? new T.Vector3(-.32, .48, .81).normalize() : sun, light = new T.DirectionalLight(i ? 0xadcaff : 0xffeed9, i ? 1.1 : 2.6);
          light.name = `world-star-${i}`;light.position.copy(direction).multiplyScalar(R * 3);systemRoot.add(light, light.target);
          starField.push({ direction: direction.toArray(), color: i ? [.68, .8, 1] : [1, .98, .94], distance: 1e12, radius: 2e10, irradianceFraction: i ? .35 : 1 });
        }
        const starLights = systemRoot.children.filter(object => object.isDirectionalLight);
        const makePlanet = (seed, name, radius = R, center = new T.Vector3()) => {
          const planet = new Planet({ seed, name, posUniv: center.clone(), type: 'lush', radius, tuning: { cloudCoverage: .64, weatherStyle: 'temperate-synoptic' } });
          planets.push(planet);planet.group.position.copy(center);planet.group.name = name;planet.setStellarLights({ sources: starField, radianceScale: 3.2 });planet.setStellarOccluders([]);
          const meshes = [];
          for (const [family, lod] of [['terrain', planet.lod], ['water', planet.waterLod]]) for (const [i, root] of (lod?.roots || []).entries()) {
            root.mesh.name = `${name}-${family}-${i}`;root.mesh.visible = true;root.mesh.frustumCulled = false;meshes.push(root.mesh);
          }
          const hidden = [planet.nearWaterPatch?.mesh, planet.atmoMesh, planet.cloudMesh, planet.cloudMesh2, planet.ringMesh].filter(Boolean);
          for (const [i, object] of hidden.entries()) { object.visible = false;object.name = `${name}-hidden-world-${i}`; }
          check(`${name}: actual six terrain and six water roots`, meshes.filter(mesh => mesh.material === planet.terrainMaterial).length === 6 && meshes.filter(mesh => mesh.material === planet.liquidMat).length === 6);
          return { planet, meshes, compilerMeshes: [...meshes, ...hidden] };
        };
        const old = makePlanet(result.input.oldSeed, 'existing-body');systemRoot.add(old.planet.group);
        const system = { planets: [old.planet], compactObjects: [], artificialSites: [] };
        const ambient = new T.AmbientLight(0x8bacdd, .55), hemi = new T.HemisphereLight(0xbacbff, 0x352c20, .25);ambient.name = 'global-ambient';hemi.name = 'global-hemisphere';scene.add(ambient, hemi);
        const shadowLight = new T.DirectionalLight(0xffe5bf, 1.7);shadowLight.name = 'sun-shadow-light';shadowLight.position.copy(sun).multiplyScalar(R * 3);shadowLight.visible = shadows;shadowLight.castShadow = true;
        shadowLight.shadow.mapSize.set(64, 64);Object.assign(shadowLight.shadow.camera, { left: -R * 1.4, right: R * 1.4, top: R * 1.4, bottom: -R * 1.4, near: .1, far: R * 6 });shadowLight.shadow.camera.updateProjectionMatrix();scene.add(shadowLight, shadowLight.target);ownLights.push(shadowLight);
        const shared = new T.MeshStandardMaterial({ color: 0x6c9c85, roughness: .43, metalness: .22 }), hullMaterial = new T.MeshStandardMaterial({ color: 0x697c93, metalness: .74, roughness: .32 });ownMaterials.push(shared, hullMaterial);
        const geometry = new T.BoxGeometry(R * .055, R * .055, R * .055);ownGeometry.push(geometry);
        const place = (object, x, y, z) => { object.position.copy(pointAt(x, y, z));object.castShadow = true;object.receiveShadow = true;object.frustumCulled = false;return object; };
        const ordinary = place(new T.Mesh(geometry, shared), -.11, .10, 1.12);ordinary.name = 'existing-shared-ordinary';scene.add(ordinary);
        const instances = place(new T.InstancedMesh(geometry, shared, 2), .10, .10, 1.12);instances.name = 'existing-shared-instanced';instances.setMatrixAt(0, new T.Matrix4());instances.setMatrixAt(1, new T.Matrix4().makeTranslation(R * .07, 0, 0));instances.setColorAt(0, new T.Color(.9, .5, .2));instances.setColorAt(1, new T.Color(.2, .6, .9));scene.add(instances);
        const ship = { group: new T.Group(), int: { group: new T.Group() }, separateInterior: true };
        const hull = place(new T.Mesh(geometry, hullMaterial), .01, -.10, 1.15);hull.name = 'existing-synthetic-world-hull';ship.group.add(hull, ship.int.group);scene.add(ship.group);
        let poisonCalls = 0;
        const poisonMaterial = new T.MeshBasicMaterial();poisonMaterial.onBeforeCompile = () => { poisonCalls++;throw Error('Unrelated hidden source or isolated cabin compiled'); };ownMaterials.push(poisonMaterial);
        const hiddenSource = new T.Group();hiddenSource.visible = false;const hiddenMesh = new T.Mesh(geometry, poisonMaterial);hiddenMesh.name = 'hidden-source-poison';hiddenSource.add(hiddenMesh);universeRoot.add(hiddenSource);
        const cabin = new T.Mesh(geometry, poisonMaterial);cabin.name = 'isolated-cabin-poison';cabin.layers.set(6);ship.int.group.add(cabin);
        scene.updateMatrixWorld(true);
        const beforeStage = await render('old-before', scene, camera);const oldProgramSets = new Map([old.planet.terrainMaterial, old.planet.liquidMat, shared, hullMaterial].map(material => [material, programSet(material)]));
        const newBodies = [], newMeshes = [], newCompilerMeshes = [], localLights = [], stagedRoots = [];
        publication = captureWorldPublication(system, { build() {
          const point = new T.PointLight(0x7dc5ff, R * R * .08, R * .8, 2);point.name = 'staged-body-point';point.position.copy(pointAt(-.14, .02, 1.2));old.planet.group.add(point);localLights.push(point);stagedRoots.push(point);
          const fill = new T.HemisphereLight(0x9ccde7, 0x322015, .65);fill.name = 'staged-body-hemisphere';fill.position.copy(up).multiplyScalar(R);old.planet.group.add(fill);localLights.push(fill);stagedRoots.push(fill);
          const city = new T.Group();city.name = 'staged-city-root';city.position.copy(pointAt(.12, -.10, 1.11));old.planet.group.add(city);stagedRoots.push(city);
          const cityMesh = new T.Mesh(geometry, shared);cityMesh.name = 'staged-city-mesh';cityMesh.castShadow = true;cityMesh.receiveShadow = true;city.add(cityMesh);newMeshes.push(cityMesh);newCompilerMeshes.push(cityMesh);
          for (let i = 0; i < 2; i++) { const flood = new T.PointLight(i ? 0xffb45f : 0x8edcff, R * R * .003, R * .45, 2);flood.name = `staged-city-point-${i}`;flood.position.copy(eye).multiplyScalar(R * .035).addScaledVector(right, R * (i ? .03 : -.03));city.add(flood);localLights.push(flood); }
          const hiddenBranch = new T.Group();hiddenBranch.visible = false;hiddenBranch.name = 'hidden-city-light-branch';const hiddenLight = new T.PointLight(0xff00ff, R * R * 100, R * 10, 2);hiddenLight.name = 'hidden-city-point';hiddenBranch.add(hiddenLight);city.add(hiddenBranch);
          system.artificialSites.push({ group: city, parentBody: old.planet });
          const site = new T.Group();site.name = 'staged-orphan-site-root';site.position.copy(pointAt(-.12, -.10, 1.11));systemRoot.add(site);stagedRoots.push(site);
          const siteMesh = new T.Mesh(geometry, shared);siteMesh.name = 'staged-orphan-site-mesh';siteMesh.castShadow = true;siteMesh.receiveShadow = true;site.add(siteMesh);newMeshes.push(siteMesh);newCompilerMeshes.push(siteMesh);
          const beacon = new T.PointLight(0xffb45f, R * R * .003, R * .45, 2);beacon.name = 'staged-orphan-site-point';beacon.position.copy(eye).multiplyScalar(R * .045);site.add(beacon);localLights.push(beacon);system.artificialSites.push({ group: site, parentBody: null });
          for (let i = 0; i < 2; i++) { const next = makePlanet(result.input.newSeeds[i], `staged-body-${i}`, R * .075, pointAt(i ? .20 : -.20, .01, 1.04));newBodies.push(next.planet);newMeshes.push(...next.meshes);newCompilerMeshes.push(...next.compilerMeshes);systemRoot.add(next.planet.group);system.planets.push(next.planet);stagedRoots.push(next.planet.group); }
        } });
        check('Capture owns every new body/site/existing-body child root', stagedRoots.length === 6 && stagedRoots.every(root => publication.visibility.has(root)) && publication.visibility.size === stagedRoots.length);
        check('Capture immediately hides all publication roots', stagedRoots.every(root => !root.visible));
        result.publicationSnapshots = [{ phase: 'captured', ...publication.snapshot() }];
        scene.updateMatrixWorld(true);const track = [];scene.traverse(object => track.push(object));camera.traverse(object => track.push(object));const sourceBefore = snapshot(track);
        const config = { scene, camera, universeRoot, ship, target, shadowLight, shadows, publication };
        const revision = worldPublicationRevision(r, config);result.initialRevision = revision;
        check('Publication revision is stable and excludes sun-shadow request volatility', typeof revision === 'string' && revision.length > 0 && worldPublicationRevision(r, config) === revision
          && worldPublicationRevision(r, { ...config, shadows: !shadows }) === revision);
        const expectedObjects = [...old.compilerMeshes, ordinary, instances, hull, ...newCompilerMeshes], expectedMaterials = [...new Set(expectedObjects.map(object => object.material))];
        // Future traversal order, authored independently of the candidate view:
        // system stars; old body local roots/city; orphan site; global lights.
        const truthLights = [...starLights, localLights[0], localLights[1], localLights[2], localLights[3], localLights[4], ambient, hemi, ...(shadows ? [shadowLight] : [])];
        const expectedLights = truthLights.map(light => {
          const position = new T.Vector3(), quaternion = new T.Quaternion(), scale = new T.Vector3();light.matrixWorld.decompose(position, quaternion, scale);
          return { ...lightTuple(light), visible: true, layers: 1, position: position.toArray(), quaternion: quaternion.toArray(), scale: scale.toArray() };
        });result.expectedLights = expectedLights;
        const truthScene = new T.Scene(), truthMeshes = [];
        if (implementation === 'reference') {
          for (const object of expectedObjects) {
            const copy = object.isInstancedMesh ? new T.InstancedMesh(object.geometry, object.material, object.instanceMatrix.count) : new T.Mesh(object.geometry, object.material);
            if (copy.isInstancedMesh) { copy.instanceMatrix = object.instanceMatrix;copy.instanceColor = object.instanceColor;copy.count = object.count;clonedInstances.push(copy); }
            copy.name = object.name;copy.userData = object.userData;copy.visible = object.visible;copy.layers.set(0);copy.frustumCulled = object.frustumCulled;copy.castShadow = object.castShadow;copy.receiveShadow = object.receiveShadow;copy.renderOrder = object.renderOrder;
            copy.customDepthMaterial = object.customDepthMaterial;copy.customDistanceMaterial = object.customDistanceMaterial;copy.onBeforeRender = object.onBeforeRender;copy.onBeforeShadow = object.onBeforeShadow;
            copy.matrixAutoUpdate = false;copy.matrix.copy(object.matrixWorld);truthScene.add(copy);truthMeshes.push(copy);
          }
          for (const light of truthLights) {
            const copy = light.clone(false);copy.visible = true;copy.layers.set(0);light.matrixWorld.decompose(copy.position, copy.quaternion, copy.scale);
            if (copy.target) { light.target.matrixWorld.decompose(copy.target.position, copy.target.quaternion, copy.target.scale);truthScene.add(copy.target); }truthScene.add(copy);clonedLights.push(copy);
          }
        }
        originalCompile = r.compile;
        r.compile = function(source, compileCamera, lighting) {
          const selected = [];source.traverse(object => { if (object.isMesh) selected.push({ name: object.name, actual: expectedObjects.includes(object), instanced: !!object.isInstancedMesh,
            count: object.isInstancedMesh ? object.count : null, matrixAttribute: id(object.instanceMatrix), colorAttribute: id(object.instanceColor), parent: id(object.parent) }); });
          const lights = [];(lighting || source).traverseVisible(object => { if (object.isLight && object.layers.test(compileCamera.layers)) lights.push(lightTuple(object)); });
          result.compilation.push({ phase, selected, lights, worldMask: compileCamera.layers.mask, target: r.getRenderTarget() === target });return originalCompile.call(this, source, compileCamera, lighting);
        };
        const held = new Promise(resolve => { releaseHeld = resolve; });let readyResolve, readyReject, actualReadySettled = false;
        const realReady = new Promise((resolve, reject) => { readyResolve = resolve;readyReject = reject; });realReady.catch(() => {});
        r.setRenderTarget(caller, 3, 1);phase = 'publication-prepare';
        const commit = publication.publish(async () => {
          try {
            let prepared;
            if (implementation === 'candidate') prepared = await compileWorldPublicationVariant(r, config);
            else if (implementation === 'reference') {
              const saved = r.getRenderTarget(), face = r.getActiveCubeFace(), mip = r.getActiveMipmapLevel();let pending;
              try { r.setRenderTarget(target);pending = withSurfaceWarmupVariant(truthScene, () => compilePrograms(r, truthScene, camera)); }
              finally { r.setRenderTarget(saved, face, mip); }
              await pending;prepared = worldPublicationRevision(r, config);
            } else {
              await withSurfaceWarmupVariant(newBodies[0].group, () => compileRenderVariant(r, newBodies[0].group, camera, scene, { layer: 0, target, shadowLight: shadows ? shadowLight : null }));
              prepared = worldPublicationRevision(r, config);
            }
            result.preparedRevision = prepared;actualReadySettled = true;readyResolve();await held;return prepared;
          } catch (error) { readyReject(error);throw error; }
        }, { isCurrent: () => true, canPublish: () => true, getRevision: () => worldPublicationRevision(r, config) });commit.catch(() => {});
        await Promise.resolve();check('Real compiler submitted without cloning attached camera rig', result.compilation.length > 0);
        check('Preparation restores complete caller cube target tuple synchronously', r.getRenderTarget() === caller && r.getActiveCubeFace() === 3 && r.getActiveMipmapLevel() === 1);
        check('Source flags/parents/CPU instance arrays unchanged by compiler submission', same(sourceBefore, snapshot(track)));
        check('Publication remains hidden while actual driver readiness is outstanding', stagedRoots.every(root => !root.visible));
        const preparedCall = result.compilation[0];
        if (implementation !== 'new-body-only') {
          record('Whole future WORLD receiver set is submitted', same(preparedCall.selected.map(row => row.name).sort(), expectedObjects.map(object => object.name).sort()));
          record('Actual existing and new mesh objects enter candidate compiler view', implementation !== 'candidate' || preparedCall.selected.every(row => row.actual));
          record('Future light tuple includes all staged body/city/site lights', same(canonical(preparedCall.lights), canonical(expectedLights)));
          record('Future WORLD camera and explicit HDR target match', preparedCall.worldMask === 1 && preparedCall.target);
        } else record('Negative control compiles one new body and excludes all staged lights', preparedCall.selected.every(row => !row.name.startsWith('existing-')) && preparedCall.lights.every(light => !light.name.startsWith('staged-')));
        check('Old WORLD frame is submitted before the real preparation promise resolves', !actualReadySettled);
        const duringReady = await render('old-pending', scene, camera);check('Old WORLD native HDR unchanged during actual preparation', same(Array.from(beforeStage), Array.from(duringReady)));
        await realReady;check('Publication roots remain hidden after driver ready while supplier is held', stagedRoots.every(root => !root.visible));
        result.publicationSnapshots.push({ phase: 'actual-ready-supplier-held', ...publication.snapshot() });
        const afterReady = await render('old-ready-held', scene, camera);check('Old WORLD native HDR unchanged after readiness before commit', same(Array.from(beforeStage), Array.from(afterReady)));
        check('All original source flags and instance arrays survive the held readiness', same(sourceBefore, snapshot(track)));
        r.compile = originalCompile;originalCompile = null;
        const preparedSets = new Map(expectedMaterials.map(material => [material, programSet(material)]));
        result.preparedCounts = expectedMaterials.map(material => ({ name: material.name, type: material.type, variants: preparedSets.get(material).size }));
        const beforeFormalPrograms = new Set(r.info.programs);
        releaseHeld();const published = await commit;result.published = published;
        result.publicationSnapshots.push({ phase: 'committed', ...publication.snapshot() });
        check('One successful publication exposes every root together', published === true && stagedRoots.every(root => root.visible));
        check('Successful native publication releases its pending root/owner references', publication.state === 'committed' && publication.visibility.size === 0 && publication.system === null && !publication.snapshot().inFlight);
        check('Current publication has no hidden-source or cabin poison compilation', poisonCalls === 0);
        const drawScene = implementation === 'reference' ? truthScene : scene;
        originalDirect = r.renderBufferDirect;
        r.renderBufferDirect = function(drawCamera, drawScene, drawGeometry, material, object, group) {
          const value = originalDirect.call(this, drawCamera, drawScene, drawGeometry, material, object, group), program = r.properties.get(material).currentProgram;
          result.draws.push({ phase, name: object.name, type: material.type, program: program?.id, depth: !!(material.isMeshDepthMaterial || material.isMeshDistanceMaterial) });return value;
        };
        const first = await render('published', drawScene, camera);
        result.firstColorNew = [];
        for (const material of expectedMaterials) for (const program of programSet(material)) if (!preparedSets.get(material).has(program)) result.firstColorNew.push({ materialType: material.type,
          receivers: expectedObjects.filter(object => object.material === material).map(object => object.name), program: program.id, cacheKey: program.cacheKey });
        result.firstExistingColorNew = result.firstColorNew.filter(row => row.receivers.some(name => name.startsWith('existing-')));
        result.firstGlobalNew = r.info.programs.filter(program => !beforeFormalPrograms.has(program)).map(program => ({ id: program.id, cacheKey: program.cacheKey,
          depthDraws: result.draws.filter(draw => draw.phase === 'published' && draw.program === program.id && draw.depth).length }));
        if (implementation === 'new-body-only') {
          record('Old new-body-only path is a real first-color-program miss control', result.firstColorNew.length > 0, result.firstColorNew.length);
          record('Negative control specifically misses already-visible WORLD receiver programs', result.firstExistingColorNew.length > 0, result.firstExistingColorNew.length);
        }
        else {
          record('First published WORLD draw adds zero receiver/hull/instancing color programs', result.firstColorNew.length === 0, result.firstColorNew.length);
          record('Every extra first-formal native program is witnessed shadow depth', result.firstGlobalNew.every(program => program.depthDraws > 0), result.firstGlobalNew);
        }
        for (const planet of [old.planet, ...newBodies]) for (const material of [planet.terrainMaterial, planet.liquidMat]) {
          const program = r.properties.get(material).currentProgram, location = program && gl.getUniformLocation(program.program, 'uLocalStarCount');
          check('Real published Planet physical star count is uploaded', location && gl.getUniform(program.program, location) === stars);
        }
        if (shadows) {
          const light = implementation === 'reference' ? clonedLights.find(light => light.castShadow) : shadowLight;
          check('Published native shadow target and real depth draws exist', light?.shadow?.map && result.draws.some(row => row.phase === 'published' && row.depth));
          const bits = read(light.shadow.map, Uint8Array);result.shadow = { width: light.shadow.map.width, height: light.shadow.map.height, nonwhite: bits.filter(value => value !== 255).length };
          check('Published shadow target contains real occupied depth', result.shadow.nonwhite > 100);
        }
        const repeated = await render('published-repeat', drawScene, camera);check('Published full WORLD native repeat is exact', same(Array.from(first), Array.from(repeated)));
        const newDrawMeshes = implementation === 'reference' ? newMeshes.map(mesh => truthMeshes[expectedObjects.indexOf(mesh)]) : newMeshes;
        const visible = new Map(newDrawMeshes.map(mesh => [mesh, mesh.visible]));for (const mesh of newDrawMeshes) mesh.visible = false;
        const lightsOnly = await render('published-lights-only', drawScene, camera);for (const [mesh, state] of visible) mesh.visible = state;
        result.localLightRGBEffect = lightsOnly.reduce((count, value, i) => count + Number(i % 4 !== 3 && value !== beforeStage[i]), 0);
        check('New local lights positively affect existing unchanged WORLD geometry', result.localLightRGBEffect > 100);
        result.existingMaterialOldVariants = [...oldProgramSets.values()].map(set => set.size);
        checkpoint('published/full-repeat/local-light-only');result.passed = result.checks.every(row => row.pass);
      } catch (error) { result.passed = false;result.failure = { message: String(error), stack: error?.stack, phase }; }
      finally {
        try {
          publication?.abandon();releaseHeld?.();if (originalCompile && r) r.compile = originalCompile;if (originalDirect && r) r.renderBufferDirect = originalDirect;
          for (const instance of clonedInstances) instance.dispose();for (const light of [...clonedLights, ...ownLights]) light.shadow?.dispose();
          for (const planet of planets) planet.dispose();for (const material of ownMaterials) material.dispose();for (const geometry of ownGeometry) geometry.dispose();target?.dispose();caller?.dispose();
          if (r) {
            const deadline = performance.now() + 10000;while (r.programRetirement.snapshot().pending && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
            result.retirement = r.programRetirement.snapshot();record('Guarded native programs drain without faults', !result.retirement.pending && !result.retirement.blocked && !result.retirement.faults.length);checkpoint('retirement');
          }
        } catch (error) { result.cleanupFailure = { message: String(error), stack: error?.stack }; }
        finally { try { r?.dispose(); }catch (error) { result.disposeFailure = { message: String(error), stack: error?.stack }; } }
      }
      record('No native shader errors or context loss', !result.shaderErrors.length && !result.contextLosses.length);
      result.passed = Boolean(result.passed && result.checks.every(row => row.pass) && !result.cleanupFailure && !result.disposeFailure);
      document.getElementById('status').textContent = JSON.stringify({ implementation, stars, shadows, passed: result.passed, published: result.published,
        firstColorNew: result.firstColorNew?.length, localLightRGBEffect: result.localLightRGBEffect, failure: result.failure?.message }, null, 2);return result;
    }, { stars, shadows, implementation });
    report.cases.push(result);await page.screenshot({ path: `${out}/${label}.png` });await writeFile(`${out}/${label}.json`, JSON.stringify(result, null, 2));await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  }
  for (const stars of [1, 2]) for (const shadows of [false, true]) for (const stage of ['old-before', 'old-pending', 'old-ready-held', 'published', 'published-repeat', 'published-lights-only']) {
    const pair = ['reference', 'candidate'].map(implementation => report.cases.find(row => row.stars === stars && row.shadows === shadows && row.implementation === implementation)?.captures[stage]?.nativeBits);
    report.comparisons.push({ stars, shadows, stage, nativeChanged: pair.every(Boolean) ? pair[0].reduce((count, value, i) => count + Number(value !== pair[1][i]), 0) : null });
  }
  report.after = await evidenceFingerprint(verifier);report.addonAfter = await addons();
  report.passed = report.cases.length === 12 && report.cases.every(row => row.passed && row.checks.every(check => check.pass))
    && report.comparisons.length === 24 && report.comparisons.every(row => row.nativeChanged === 0)
    && !report.errors.length && !report.driverWarnings.length && JSON.stringify(report.before) === JSON.stringify(report.after) && JSON.stringify(report.addonBefore) === JSON.stringify(report.addonAfter);
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));assert.ok(report.passed, `WORLD publication native controls failed: ${out}/report.json`);
  console.log(JSON.stringify({ out, passed: true, cases: 12, nativeComparisons: 24, scope: report.scope }));
} catch (error) { report.failure = { message: String(error), stack: error?.stack };await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));throw error; }
finally { await browser?.close();if (server) await new Promise(resolve => server.close(resolve)); }
