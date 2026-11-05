// Actual cloud depth-kernel and sampler binding regression. Cloud geometry is
// replaced by labelled probe planes; this is not cloud-image/FPS acceptance.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const verifier = 'tools/cloudfadingresourcegputest.js', referenceCommit = 'ab79588';
// Fixed before the first capture. Eye vectors are uploaded as Float32 at
// approximately 20 million metres; matrices remain order-one numbers.
const tolerance = { eyeMeters: 2.1, matrix: 1e-6, green: 1 / 1024, blue: .0041 };
const before = await evidenceFingerprint(verifier), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const referencePaths = ['src/volumetric-pass-webgl.js', 'src/atmosphere-pass-webgl.js', 'src/clouds-webgl.js'];
const references = new Map(referencePaths.map(path => [path, execFileSync('git', ['show', `${referenceCommit}:${path}`])]));
const out = `test-results/cloud-fading-resources-gpu/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });
await writeFile(`${out}/verifier.js`, await readFile(verifier));
for (const [path, bytes] of references) await writeFile(`${out}/reference-${path.slice(4)}.gz`, gzipSync(bytes));
const { server, port } = await startServer(0), cases = [], errors = [], warnings = [];
let browser, activePage;
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined });
  for (const mode of ['reference', 'current']) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });activePage = page;
    page.on('pageerror', error => errors.push({ mode, message: String(error) }));
    page.on('console', message => {
      if (message.type() === 'error') errors.push({ mode, message: message.text() });
      else if (message.type() === 'warning') warnings.push({ mode, message: message.text() });
    });
    if (mode === 'reference') for (const [path, bytes] of references) {
      await page.route(`**/${path}`, route => route.fulfill({ contentType: 'text/javascript', body: bytes }));
    }
    await page.route('**/cloud-fading-resource-fixture.html', route => route.fulfill({ contentType: 'text/html', body:
      '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>'
      + '<style>body{background:#14202b;color:white;font:15px sans-serif}.row{display:flex;gap:16px;align-items:center}canvas{width:384px;height:256px;image-rendering:pixelated}p{width:340px}</style>'
      + `<h2>${mode}: fading-cloud depth and sampler bindings</h2><p>Left A, right B. Red: opaque surface occludes a 1400m probe. Green: ray limit / 20000m. Blue: reconstructed-position error / 1000m. Actual depth-kernel probe, not full cloud imagery.</p>` }));
    await page.goto(`http://127.0.0.1:${port}/cloud-fading-resource-fixture.html`);
    const result = await page.evaluate(async ({ mode, tolerance }) => {
      const T = await import('three');
      const { Planet, setVolumetricCloudsEnabled } = await import('/src/planet.js');
      const { AtmospherePass } = await import('/src/atmosphere-pass-webgl.js');
      const { VolumetricPass } = await import('/src/volumetric-pass-webgl.js');
      const { installProgramRetirement } = await import('/src/program-retirement.js');
      const require = (condition, message) => { if (!condition) throw Error(message); };
      const renderer = new T.WebGLRenderer({ antialias: false });renderer.setSize(64, 32);
      const gl = renderer.getContext(), retirement = installProgramRetirement(renderer);
      const scene = new T.Scene(), camera = new T.PerspectiveCamera(80, 2, .1, 1e9);
      const volume = new VolumetricPass(scene, camera), atmosphere = new AtmospherePass(camera);
      volume.setSize(64, 32);volume.sceneDepthSource = atmosphere;
      const planets = [], targets = [], records = [], sources = [], nativeSources = new Map(), handleIds = new WeakMap();
      window.__fadingResourceProbe = { mode, records, sources, pending: null };
      let nextHandleId = 1, uploads = [], frameExpected = null;
      const identify = handle => {
        if (!handle) return null;
        if (!handleIds.has(handle)) handleIds.set(handle, nextHandleId++);
        return handleIds.get(handle);
      };
      function target(width, height, depth = false) {
        const rt = new T.WebGLRenderTarget(width, height, { type: T.HalfFloatType,
          depthBuffer: depth, depthTexture: depth ? new T.DepthTexture(width, height, T.UnsignedIntType) : null });
        if (rt.depthTexture) { rt.depthTexture.minFilter = T.NearestFilter;rt.depthTexture.magFilter = T.NearestFilter; }
        targets.push(rt);return rt;
      }
      const firstOpaque = target(64, 32, true), nextOpaque = target(96, 64, true);
      const depthless = target(96, 64), airColor = target(64, 32), finalColor = target(64, 32);
      const scratch = target(1, 1), quadScene = new T.Scene(), quadCamera = new T.Camera();
      const quadGeometry = new T.PlaneGeometry(2, 2), quad = new T.Mesh(quadGeometry, null);quadScene.add(quad);
      const depthMaterial = new T.ShaderMaterial({ depthTest: true, depthWrite: true,
        uniforms: { uFar: { value: camera.far }, uForward: { value: 512 } },
        vertexShader: 'void main(){gl_Position=vec4(position.xy,0.,1.);}',
        fragmentShader: 'uniform float uFar,uForward;void main(){gl_FragDepth=log2(1.0+uForward)/log2(1.0+uFar);gl_FragColor=vec4(.1,.15,.2,1.);}' });
      function writeOpaque(rt, distance) {
        depthMaterial.uniforms.uFar.value = camera.far;depthMaterial.uniforms.uForward.value = distance;
        quad.material = depthMaterial;renderer.setRenderTarget(rt);renderer.setClearColor(new T.Color(.1, .15, .2), 1);
        renderer.autoClear = true;renderer.clear(true, true, false);renderer.render(quadScene, quadCamera);
      }
      function sampler(program, name) {
        const location = gl.getUniformLocation(program, name);
        require(location !== null, `Native sampler must remain active: ${name}`);
        const unit = gl.getUniform(program, location), previous = gl.getParameter(gl.ACTIVE_TEXTURE);
        gl.activeTexture(gl.TEXTURE0 + unit);
        const handle = gl.getParameter(gl.TEXTURE_BINDING_2D);
        gl.activeTexture(previous);
        return { unit, handle: identify(handle) };
      }
      // A real draw establishes the renderer's null-sampler fallback handle.
      const fallbackMaterial = new T.ShaderMaterial({ depthTest: false, depthWrite: false,
        uniforms: { uEmptyA: { value: null }, uEmptyB: { value: null } },
        vertexShader: 'void main(){gl_Position=vec4(position.xy,0.,1.);}',
        fragmentShader: 'uniform sampler2D uEmptyA,uEmptyB;void main(){gl_FragColor=texture2D(uEmptyA,vec2(.5))+texture2D(uEmptyB,vec2(.25));}' });
      quad.material = fallbackMaterial;renderer.setRenderTarget(scratch);renderer.render(quadScene, quadCamera);
      const fallbackProgram = renderer.properties.get(fallbackMaterial).currentProgram.program;
      const defaultSampler = sampler(fallbackProgram, 'uEmptyA');
      require(defaultSampler.handle !== null && defaultSampler.handle === sampler(fallbackProgram, 'uEmptyB').handle,
        'Null 2D samplers must use the same initialized renderer fallback texture');
      function extractFunction(source, signature) {
        require(source.split(signature).length === 2, `One production kernel required: ${signature}`);
        const start = source.indexOf(signature), brace = source.indexOf('{', start);let i = brace + 1, level = 1;
        while (level && i < source.length) { if (source[i] === '{') level++;if (source[i] === '}') level--;i++; }
        require(level === 0, 'Kernel braces');return source.slice(start, i);
      }
      setVolumetricCloudsEnabled(true);
      function makePlanet(name, x, radius, angle, probeX) {
        const planet = new Planet({ seed: `fading-resource-gpu-${name}`, name,
          posUniv: new T.Vector3(x, 0, -2e7), type: 'lush', radius,
          ringSystem: { present: false }, tuning: { cloudCoverage: .64, weatherStyle: 'temperate-synoptic' } });
        planets.push(planet);scene.add(planet.group);
        planet.setFrame(new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 0, 1), angle));
        planet.setStellarLights({ sources: [{ direction: [0, 1, 0], color: [1, .98, .94],
          distance: 1e12, radius: 2e10, irradianceFraction: 1 }], radianceScale: 3.2 });
        planet.setStellarOccluders([]);
        const original = planet.volCloudMat.fragmentShader;
        const kernels = ['vec2 sphereHits(', 'vec4 opaqueLocalPosition(', 'float sceneRayLimit(']
          .map(signature => extractFunction(original, signature)).join('\n');
        sources.push({ planet: name, kernel: kernels });
        planet.volCloudMesh.geometry.dispose();planet.volCloudMesh.geometry = new T.PlaneGeometry(2, 2);
        const uniforms = planet.volCloudMat.uniforms;
        uniforms.uProbeX = { value: probeX };
        uniforms.uProbeInvProjection = { value: new T.Matrix4() };
        uniforms.uProbeViewToLocal = { value: new T.Matrix3() };
        uniforms.uProbeEye = { value: new T.Vector3() };
        uniforms.uProbeSize = { value: new T.Vector2() };
        const vertexShader = `uniform float uProbeX;uniform mat4 uProbeInvProjection;uniform mat3 uProbeViewToLocal;
          varying vec3 vDirection,vViewDirection;
          void main(){vec2 ndc=vec2(position.x*.5+uProbeX,position.y);gl_Position=vec4(ndc,0.,1.);
            vec4 view=uProbeInvProjection*vec4(ndc,1.,1.);vViewDirection=view.xyz;vDirection=uProbeViewToLocal*view.xyz;}`;
        const fragmentShader = `uniform sampler2D tSceneDepth,air_tOpticalDepth,air_tMultipleScattering;
          uniform float uDepthReady,uCameraFar,uOpaqueMinR,uOpaqueMaxR,air_uEnabled;
          uniform vec2 uVolumeSize,uProbeSize;uniform vec3 uCameraLocal,uProbeEye;
          uniform mat4 uDepthInvProjection,uProbeInvProjection;uniform mat3 uDepthViewToLocal,uProbeViewToLocal;
          varying vec3 vDirection,vViewDirection;
          ${kernels}
          void main(){
            float limit=sceneRayLimit();
            ivec2 size=ivec2(uProbeSize);ivec2 cell=ivec2(gl_FragCoord.xy);
            vec2 uv=(vec2(cell)+.5)/uProbeSize;
            vec3 ray=normalize((uProbeInvProjection*vec4(uv*2.-1.,1.,1.)).xyz);
            vec3 expected=uProbeEye+normalize(uProbeViewToLocal*ray)*(10000./max(-ray.z,.035));
            vec3 actual=opaqueLocalPosition(cell,size,10000.).xyz;
            float error=length(actual-expected)/1000.;
            // Keep both real air samplers active even for disabled clouds.
            // The tiny positive alpha term rounds to 1 in this RGBA16F target.
            float borrowed=texture2D(air_tOpticalDepth,vec2(.5)).r+texture2D(air_tMultipleScattering,vec2(.5)).r;
            gl_FragColor=vec4(limit<1400.?1.:0.,min(limit/20000.,1.),min(error,1.),1.+air_uEnabled*min(abs(borrowed),1.)*1e-7);
          }`;
        for (const material of [planet.volCloudMat, planet.volCloudFarMat]) {
          material.vertexShader = vertexShader;material.fragmentShader = fragmentShader;
          material.transparent = false;material.blending = T.NoBlending;material.depthTest = false;material.depthWrite = false;
          material.side = T.DoubleSide;material.toneMapped = false;material.needsUpdate = true;
        }
        planet.volCloudMesh.onAfterRender = (_renderer, _scene, _camera, _geometry, material) => {
          const program = renderer.properties.get(material).currentProgram.program;
          if (!nativeSources.has(program)) nativeSources.set(program, { program: identify(program),
            shaders: gl.getAttachedShaders(program).map(shader => ({ type: gl.getShaderParameter(shader, gl.SHADER_TYPE),
              source: gl.getShaderSource(shader) })) });
          const get = key => {
            const location = gl.getUniformLocation(program, key);require(location !== null, `Native uniform missing: ${key}`);
            const value = gl.getUniform(program, location);return ArrayBuffer.isView(value) ? Array.from(value) : value;
          };
          const optical = atmosphere.material.uniforms.tOpticalDepth.value, multiple = atmosphere.material.uniforms.tMultipleScattering.value;
          const expected = frameExpected.get(planet);
          uploads.push({ planet: name, family: material === planet.volCloudFarMat ? 'far' : 'near',
            engage: material.uniforms.uEngage.value, depthReady: get('uDepthReady'), far: get('uCameraFar'),
            size: get('uVolumeSize'), inverseProjection: get('uDepthInvProjection'), viewToLocal: get('uDepthViewToLocal'),
            eye: get('uCameraLocal'), enabled: get('air_uEnabled'), expected,
            depthSampler: sampler(program, 'tSceneDepth'), opticalSampler: sampler(program, 'air_tOpticalDepth'),
            multipleSampler: sampler(program, 'air_tMultipleScattering'),
            expectedDepthHandle: expected.depthReady ? identify(renderer.properties.get(expected.depthTexture).__webglTexture) : defaultSampler.handle,
            expectedOpticalHandle: optical ? identify(renderer.properties.get(optical).__webglTexture) : defaultSampler.handle,
            expectedMultipleHandle: multiple ? identify(renderer.properties.get(multiple).__webglTexture) : defaultSampler.handle,
            jsOpticalNull: material.uniforms.air_tOpticalDepth.value === null,
            jsMultipleNull: material.uniforms.air_tMultipleScattering.value === null });
          // The report must remain JSON-only; the native texture is for the
          // in-callback expected-handle lookup, never serialized.
          delete uploads.at(-1).expected.depthTexture;
        };
        return planet;
      }
      const a = makePlanet('A', -7e6, 6e6, 0, -.5), b = makePlanet('B', 7e6, 5e6, .6, .5);
      const navA = new T.Vector3(-1e6, 0, 0), navB = new T.Vector3(3e6, 0, 0);
      const maxError = (actual, expected) => Math.max(...actual.map((value, i) => Math.abs(value - Math.fround(expected[i]))));
      function callerState() {
        return { target: renderer.getRenderTarget() === finalColor, face: renderer.getActiveCubeFace(), mip: renderer.getActiveMipmapLevel(),
          mask: camera.layers.mask, auto: renderer.autoClear, alpha: renderer.getClearAlpha(),
          color: renderer.getClearColor(new T.Color()).toArray() };
      }
      function draw(name, active, nav, opaque, distance, { update = true, common = true } = {}) {
        if (update) for (const planet of planets) {
          planet.group.position.copy(planet.posUniv).sub(nav);
          planet.update(nav.clone().sub(planet.posUniv), 1 / 60, planet === active, 0);
        }
        camera.updateMatrixWorld(true);scene.updateMatrixWorld(true);
        writeOpaque(opaque, distance);
        atmosphere.setActivePlanet(active, nav);atmosphere.render(renderer, airColor, opaque);
        volume.setActivePlanet(active, nav);volume.resetHistory();
        const sourceDepth = atmosphere.sceneDepthTexture || airColor.depthTexture || null;
        frameExpected = new Map();
        for (const planet of planets) {
          const transform = planet.volCloudMesh.matrixWorld.clone().invert().multiply(camera.matrixWorld);
          const eye = new T.Vector3().setFromMatrixPosition(transform), rotation = new T.Matrix3().setFromMatrix4(transform);
          const u = planet.volCloudMat.uniforms;
          u.uProbeInvProjection.value.copy(camera.projectionMatrixInverse);u.uProbeViewToLocal.value.copy(rotation);
          u.uProbeEye.value.copy(eye);u.uProbeSize.value.set(volume.width, volume.height);
          frameExpected.set(planet, { depthReady: sourceDepth ? 1 : 0, depthTexture: sourceDepth,
            far: camera.far, size: [volume.width, volume.height], inverseProjection: camera.projectionMatrixInverse.toArray(),
            viewToLocal: rotation.toArray(), eye: eye.toArray(), matched: planet === active && atmosphere.activePlanet === active });
        }
        const sharedBefore = [atmosphere.material.uniforms.uEnabled.value, atmosphere.material.uniforms.uMultipleEnabled.value,
          atmosphere.material.uniforms.tOpticalDepth.value, atmosphere.material.uniforms.tMultipleScattering.value];
        renderer.setRenderTarget(finalColor);renderer.autoClear = false;renderer.setClearColor(new T.Color(.2, .3, .4), .375);
        const stateBefore = callerState();uploads = [];volume.render(renderer, finalColor, airColor);
        const stateAfter = callerState();
        const sharedAfter = [atmosphere.material.uniforms.uEnabled.value, atmosphere.material.uniforms.uMultipleEnabled.value,
          atmosphere.material.uniforms.tOpticalDepth.value, atmosphere.material.uniforms.tMultipleScattering.value];
        require(sharedAfter.every((value, i) => value === sharedBefore[i]), 'Cloud binding must not mutate shared atmosphere state');
        const pixels = new Uint16Array(volume.width * volume.height * 4);
        renderer.readRenderTargetPixels(volume.current, 0, 0, volume.width, volume.height, pixels);
        const row = { name, common, active: active?.name || null, width: volume.width, height: volume.height,
          opaqueForward: distance, currentDepth: !!sourceDepth, stateBefore, stateAfter, uploads,
          native: Array.from(pixels), gl: gl.getError(), lost: gl.isContextLost(), samples: [] };
        window.__fadingResourceProbe.pending = row;
        for (const upload of uploads) {
          const x = Math.floor(volume.width * (upload.planet === 'A' ? .25 : .75)), y = Math.floor(volume.height * .5);
          const i = (y * volume.width + x) * 4;
          const rgba = Array.from(pixels.slice(i, i + 4), value => T.DataUtils.fromHalfFloat(value));
          const ray4 = new T.Vector4((x + .5) / volume.width * 2 - 1, (y + .5) / volume.height * 2 - 1, 1, 1)
            .applyMatrix4(camera.projectionMatrixInverse);
          const ray = new T.Vector3(ray4.x, ray4.y, ray4.z).normalize();
          const expectedLimit = sourceDepth ? distance / Math.max(-ray.z, .035) : 1e20;
          row.samples.push({ planet: upload.planet, pixel: [x, y], rgba,
            expectedRed: expectedLimit < 1400 ? 1 : 0, expectedGreen: Math.min(expectedLimit / 20000, 1),
            expectedBlue: 0 });
          if (mode === 'current') {
            const e = upload.expected;
            require(upload.depthReady === e.depthReady && upload.far === Math.fround(e.far), 'Current native depth ready/far');
            require(upload.size.every((n, j) => n === e.size[j]), 'Current native depth viewport');
            require(maxError(upload.inverseProjection, e.inverseProjection) <= tolerance.matrix, 'Current native inverse projection');
            require(maxError(upload.viewToLocal, e.viewToLocal) <= tolerance.matrix, 'Current native view-to-local');
            require(maxError(upload.eye, e.eye) <= tolerance.eyeMeters, 'Current native local eye');
            require(upload.depthSampler.handle === upload.expectedDepthHandle, 'Current actual depth sampler handle');
            require(upload.enabled === Number(e.matched), 'Current air enable ownership');
            if (e.matched) {
              require(upload.opticalSampler.handle === upload.expectedOpticalHandle && upload.multipleSampler.handle === upload.expectedMultipleHandle,
                'Matched cloud must bind real current atmosphere LUT handles');
              require(upload.opticalSampler.handle !== defaultSampler.handle && upload.multipleSampler.handle !== defaultSampler.handle,
                'Matched cloud needs real LUT textures, not the fallback');
            } else {
              require(upload.jsOpticalNull && upload.jsMultipleNull, 'Disabled cloud owns null sampler values');
              require(upload.opticalSampler.handle === defaultSampler.handle && upload.multipleSampler.handle === defaultSampler.handle,
                'Disabled cloud must upload the actual initialized fallback handles');
            }
            require(rgba[0] === Number(expectedLimit < 1400), 'Current opaque occlusion output');
            require(Math.abs(rgba[1] - Math.min(expectedLimit / 20000, 1)) <= tolerance.green, 'Current reconstructed ray limit');
            require(rgba[2] <= tolerance.blue && rgba[3] === 1, 'Current opaque point agrees with independent matrices');
          }
        }
        records.push(row);
        const display = document.createElement('div');display.className = 'row';
        const label = document.createElement('p');label.textContent = name;display.append(label);
        const canvas = document.createElement('canvas');canvas.width = row.width;canvas.height = row.height;
        const context = canvas.getContext('2d'), image = context.createImageData(row.width, row.height);
        for (let i = 0; i < pixels.length; i++) image.data[i] = Math.round(Math.max(0, Math.min(1, T.DataUtils.fromHalfFloat(pixels[i]))) * 255);
        context.putImageData(image, 0, 0);display.append(canvas);document.body.append(display);
        return row;
      }
      draw('A initial: real opaque depth and LUTs', a, navA, firstOpaque, 512);
      camera.position.set(17, -3, 5);camera.rotation.set(.07, .11, -.03);
      draw('B: camera motion only, A fades', b, navB, firstOpaque, 512);
      camera.fov = 68;camera.aspect = 1.5;camera.far = 2e9;camera.updateProjectionMatrix();
      renderer.setSize(96, 64);volume.setSize(96, 64);airColor.setSize(96, 64);finalColor.setSize(96, 64);
      draw('B: replaced depth, resized view, FOV/far changed', b, navB, nextOpaque, 2048);
      draw('B: exact repeat of depth bindings', b, navB, nextOpaque, 2048, { update: false });
      draw('B: no current depth while A fades', b, navB, depthless, 2048);
      draw('No active cloud: A and B still fade', null, navB, nextOpaque, 2048);
      draw('Return to A: restore actual LUT borrowing', a, navA, nextOpaque, 2048);
      draw('Return to B: detach A again', b, navB, nextOpaque, 2048);
      if (mode === 'current') {
        // Dispose only after the deterministic old/new comparison has used a
        // live old RT. Never use uninitialized disposed depth as a pixel oracle.
        firstOpaque.dispose();
        draw('Current only: retired first depth stays unbound', b, navB, nextOpaque, 2048, { update: false, common: false });
      }
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      const result = { mode, tolerance, defaultSampler, records, sources, nativeSources: [...nativeSources.values()],
        gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null, userAgent: navigator.userAgent };
      volume.dispose();atmosphere.dispose();for (const planet of planets) planet.dispose();
      for (const rt of targets) rt.dispose();quadGeometry.dispose();depthMaterial.dispose();fallbackMaterial.dispose();renderer.dispose();
      for (let i = 0; i < 200 && retirement.snapshot().pending; i++) await new Promise(resolve => setTimeout(resolve, 10));
      result.retirement = retirement.snapshot();result.gl = gl.getError();result.lost = gl.isContextLost();
      setVolumetricCloudsEnabled(false);return result;
    }, { mode, tolerance });
    for (const source of result.sources) source.sha256 = hash(source.kernel);
    for (const program of result.nativeSources) for (const shader of program.shaders) shader.sha256 = hash(shader.source);
    cases.push(result);await page.screenshot({ path: `${out}/${mode}.png`, fullPage: true });await page.close();activePage = null;
  }
  const [reference, current] = cases;
  assert.equal(reference.records.length, 8);assert.equal(current.records.length, 9);
  assert.deepEqual(reference.records[0].native, current.records[0].native, 'Initial matched output remains exact');
  for (const c of cases) {
    assert.deepEqual(c.records[2].native, c.records[3].native, 'Repeated depth state must have exact native output');
    for (const r of c.records) { assert.deepEqual(r.stateAfter, r.stateBefore);assert.equal(r.gl, 0);assert.equal(r.lost, false); }
    assert.equal(c.gl, 0);assert.equal(c.lost, false);assert.equal(c.retirement.pending, 0);assert.deepEqual(c.retirement.faults, []);
  }
  const changed = (a, b) => a.reduce((n, value, i) => n + Number(value !== b[i]), 0);
  const comparisons = [];
  for (let i = 0; i < reference.records.length; i++) {
    const old = reference.records[i], now = current.records[i];
    comparisons.push({ name: now.name, changed: changed(old.native, now.native) });
    // Current active B retains the original valid path and exact outputs.
    if (i === 2 || i === 3) for (let y = 0; y < now.height; y++) for (let x = now.width / 2; x < now.width; x++) {
      const at = (y * now.width + x) * 4;
      assert.deepEqual(old.native.slice(at, at + 4), now.native.slice(at, at + 4), 'Active B half must remain exact');
    }
  }
  const oldA = reference.records[2].uploads.find(u => u.planet === 'A');
  assert.equal(oldA.depthReady, 1);assert.notEqual(oldA.depthSampler.handle, oldA.expectedDepthHandle);
  assert.notDeepEqual(oldA.size, oldA.expected.size);assert.notEqual(oldA.far, Math.fround(oldA.expected.far));
  assert.equal(reference.records[2].samples.find(s => s.planet === 'A').rgba[0], 1, 'Old A wrongly occludes the depth probe');
  assert.equal(current.records[2].samples.find(s => s.planet === 'A').rgba[0], 0, 'Fixed A sees the current opaque distance');
  assert.ok(reference.records[1].samples.find(s => s.planet === 'A').rgba[2] > tolerance.blue, 'Motion-only old local-frame error detected');
  assert.equal(reference.records[4].uploads.find(u => u.planet === 'A').depthReady, 1);
  assert.equal(current.records[4].uploads.find(u => u.planet === 'A').depthReady, 0);
  assert.equal(oldA.enabled, 0);assert.equal(oldA.opticalSampler.handle, oldA.expectedOpticalHandle);
  assert.equal(oldA.multipleSampler.handle, oldA.expectedMultipleHandle);
  assert.notEqual(oldA.opticalSampler.handle, reference.defaultSampler.handle, 'Disabled old A still uploads foreign real LUTs');
  assert.ok(comparisons[2].changed > 0);assert.deepEqual(errors, []);
  assert.deepEqual(warnings.filter(w => /GL_INVALID_|CONTEXT_LOST|Program object expected/.test(w.message)), []);
  const after = await evidenceFingerprint(verifier);assert.deepEqual(after, before);
  await writeFile(`${out}/report.json`, JSON.stringify({ before, after, referenceCommit, tolerance,
    referenceSources: [...references].map(([path, bytes]) => ({ path, sha256: hash(bytes) })),
    cases, comparisons, errors, warnings, passed: true,
    boundary: 'Actual Planet fade, AtmospherePass LUT production and volume rendering with production depth kernels on diagnostic planes. Independent camera/mesh oracle, initialized opaque depth and native sampler handles. No full cloud transport, player visual or performance acceptance.' }, null, 2));
  console.log(JSON.stringify({ out, comparisons, passed: true }));
} catch (error) {
  const partial = await activePage?.evaluate(() => window.__fadingResourceProbe || null).catch(() => null);
  await activePage?.screenshot({ path: `${out}/failure.png`, fullPage: true }).catch(() => {});
  await writeFile(`${out}/failure.json`, JSON.stringify({ before, referenceCommit, tolerance, cases, errors, warnings,
    partial, error: String(error), stack: error.stack }, null, 2));throw error;
} finally { await browser?.close();await new Promise(resolve => server.close(resolve)); }
