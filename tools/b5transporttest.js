import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';
import { integrateMediumSlabs, MEDIUM_FIXTURES } from './medium-reference.js';

const fixtures = MEDIUM_FIXTURES.map((f) => ({ ...f,
  reference: integrateMediumSlabs(f.slabs, f.depth, f.background) }));
const production=process.argv.includes('--production');
const viewOffsets=process.argv.includes('--view-offsets');
const before=await evidenceFingerprint('tools/b5transporttest.js');
const oldVolume=viewOffsets?execFileSync('git',['show','f0e76e8:src/volumetric-pass-webgl.js']):null;
const { server, port } = await startServer(0);
let browser;
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined, headless: true });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/__b5', (r) => r.fulfill({ contentType: 'text/html', body:
    '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>' }));
  if(viewOffsets)await page.route('**/src/b5-view-reference.js',r=>r.fulfill({contentType:'text/javascript',body:oldVolume}));
  await page.goto(`http://127.0.0.1:${port}/__b5`);
  const result = await page.evaluate(async ({fixtures,production,viewOffsets}) => {
    const THREE = await import('three');
    const { AtmospherePass } = await import('/src/atmosphere-pass-webgl.js');
    const { VolumetricPass } = await import('/src/volumetric-pass-webgl.js');
    const Original=viewOffsets?(await import('/src/b5-view-reference.js')).VolumetricPass:null;
    const { makeCloudVolumeMaterial, disposeCloudNoiseTexture } = await import('/src/clouds-webgl.js');
    const renderer = new THREE.WebGLRenderer({ logarithmicDepthBuffer: true });
    renderer.setSize(1, 1);
    const camera = new THREE.PerspectiveCamera(45, 1, 1, 1e7);
    camera.rotation.x = Math.PI / 2; camera.updateMatrixWorld();
    const target = (depth = false) => new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.FloatType, depthBuffer: depth,
      ...(depth ? { depthTexture: new THREE.DepthTexture(1, 1, THREE.UnsignedIntType) } : {}),
    });
    const opaque = target(true), airTarget = target(true);
    const detail = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    detail.needsUpdate = true;
    const opaqueScene = new THREE.Scene(), geometry = new THREE.PlaneGeometry(1, 1);
    const surface = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    surface.rotation.x = Math.PI / 2;
    opaqueScene.add(surface);
    const air = new AtmospherePass(camera), volume = new VolumetricPass(new THREE.Scene(), camera);
    // Replace only medium/source samplers with controlled constants. Geometry,
    // depth decoding, clipping, joint transfer and final composite remain real.
    function replaceBody(shader, signature, body) {
      const start = shader.indexOf(signature);
      if (start < 0) throw Error(`Missing production sampler: ${signature}`);
      const open = shader.indexOf('{', start);
      let end = open + 1, nesting = 1;
      while (nesting) { if (shader[end] === '{') nesting++; if (shader[end++] === '}') nesting--; }
      return shader.slice(0, open + 1) + body + shader.slice(end - 1);
    }
    const constants = { uTestAirExt: { value: new THREE.Vector3() }, uTestAirSource: { value: new THREE.Vector3() },
      uTestCloudSource: { value: new THREE.Vector3() }, uTestSigma: { value: 1 } };
    const declarations = 'uniform vec3 uTestAirExt,uTestAirSource,uTestCloudSource; uniform float uTestSigma;\n';
    air.material.fragmentShader = declarations + replaceBody(air.material.fragmentShader,
      'void airSample(', 'extinction=uTestAirExt; source=uTestAirSource;');
    Object.assign(air.material.uniforms, constants);
    const R = 100000;
    const cloud = makeCloudVolumeMaterial({ R: R - 100, hasLiquid: false }, {
      rIn: R + 1, rOut: R + 2, cov0: 0.2, cov1: 0.7, ox: 0, oy: 0, oz: 0,
      localWeather:production,
    }, detail);
    cloud.side = THREE.FrontSide; cloud.blending = THREE.NoBlending; cloud.depthTest = false;
    cloud.vertexShader = 'varying vec3 vDirection,vViewDirection; void main(){vDirection=vec3(0,1,0);vViewDirection=vec3(0,0,-1);gl_Position=vec4(position.xy,0,1);}';
    cloud.fragmentShader = declarations + replaceBody(replaceBody(cloud.fragmentShader,
      'float densityAt(', 'return 1.0;'), 'void airSample(', 'extinction=uTestAirExt; source=uTestAirSource;');
    cloud.fragmentShader = cloud.fragmentShader.replace('float sigma = 3.80 / thick;', 'float sigma = uTestSigma;')
      .replace('cloudLight *= powder * uTint;', 'cloudLight = uTestCloudSource / max(sigma,1e-30);');
    if(production) {
      cloud.fragmentShader=replaceBody(cloud.fragmentShader,'float cloudExtinctionAt(','return uTestSigma;');
      cloud.fragmentShader=replaceBody(cloud.fragmentShader,'vec3 cloudCombinedSource(',
        'return uTestCloudSource/max(uTestSigma,1e-30);');
      cloud.uniforms.uLightQuadratureSteps.value=32;
    }
    Object.assign(cloud.uniforms, constants);
    const cloudMesh = new THREE.Mesh(new THREE.PlaneGeometry(2,2),cloud);
    cloudMesh.frustumCulled=false; cloudMesh.layers.set(2); volume.scene.add(cloudMesh);
    const body={volCloudMat:cloud,volCloudMesh:cloudMesh,volCloudBand:{rOut:R+30000},posUniv:new THREE.Vector3()};
    air.activePlanet=body; volume.sceneDepthSource=air;
    volume.setActivePlanet(body,new THREE.Vector3(0,R,0));
    const au = air.material.uniforms, cu = cloud.uniforms;
    au.uEnabled.value = 1; au.uGroundR.value = R - 100; au.uTopR.value = R + 30000;
    au.uCameraLocal.value.set(0, R, 0);
    au.uCameraWorld.value.makeRotationX(Math.PI / 2);
    au.uInvProjection.value.copy(camera.projectionMatrixInverse); au.uCameraFar.value = camera.far;
    au.uWorldToLocal.value.identity();
    for (const [name, u] of Object.entries(au)) if (name.startsWith('u') || name === 'tOpticalDepth'
      || name === 'tMultipleScattering') cu['air_' + name] = u;
    cu.uCameraLocal.value.set(0, R, 0); cu.uDepthReady.value = 1; cu.uCameraFar.value = camera.far;
    cu.uMaxSteps.value = 124; cu.uEngage.value = 1;
    cu.uSunEnergy.value = 1; cu.uSecondarySunEnergy.value = 0;
    const read = (rt) => { const half=rt.texture.type===THREE.HalfFloatType; const pixels=half?new Uint16Array(4):new Float32Array(4); renderer.readRenderTargetPixels(rt, 0, 0, 1, 1, pixels); return Array.from(pixels,x=>half?THREE.DataUtils.fromHalfFloat(x):x); };
    const cases = [],offsetCases=[];
    const original=Original?new Original(volume.scene,camera):null;
    if(original){original.sceneDepthSource=air;original.setActivePlanet(body,new THREE.Vector3(0,R,0));}
    const eyeBody={...body,sunDirLocal:new THREE.Vector3(0,1,0),_invFrame:new THREE.Quaternion(),
      worldOffsetToLocal(value,out){return out.copy(value);}};
    for (const fixture of fixtures) {
      const airSlab = fixture.slabs.find((s) => s.kind === 'air');
      const cloudSlab = fixture.slabs.find((s) => s.kind === 'cloud');
      constants.uTestAirExt.value.fromArray(airSlab?.extinction || [0, 0, 0]);
      constants.uTestAirSource.value.fromArray(airSlab?.source || [0, 0, 0]);
      constants.uTestCloudSource.value.fromArray(cloudSlab?.source || [0, 0, 0]);
      constants.uTestSigma.value = cloudSlab?.extinction[0] || 0;
      cu.uRin.value = R + (cloudSlab?.start ?? 40000); cu.uRout.value = R + (cloudSlab?.end ?? 50000);
      surface.position.y = fixture.depth; surface.scale.setScalar(fixture.depth * 4);
      surface.material.color.fromArray(fixture.background);
      renderer.setRenderTarget(opaque); renderer.clear(); renderer.render(opaqueScene, camera);
      air.render(renderer,airTarget,opaque);
      volume.resetHistory(); volume.render(renderer,opaque,airTarget);
      const glError = renderer.getContext().getError();
      if (glError !== 0) throw Error(`WebGL error ${glError}`);
      cases.push({ name: fixture.name, actual: read(opaque), cloudCorrection: read(volume.current), clearAir: read(airTarget) });
      if(viewOffsets) {
        const expected=cases.at(-1),origin=new THREE.Vector3(0,R,0);
        for(const offset of [[.125,.25,-.5],[3,32,4],[128,512,-64]]) {
          camera.position.fromArray(offset);camera.updateMatrixWorld(true);
          const nav=origin.clone().sub(camera.position);
          surface.position.set(offset[0],fixture.depth+offset[1],offset[2]);
          air.updatePlanetUniforms(eyeBody,nav);
          const airEyeError=au.uCameraLocal.value.distanceTo(origin);
          renderer.setRenderTarget(opaque);renderer.clear();renderer.render(opaqueScene,camera);
          air.render(renderer,airTarget,opaque);
          cu.uCameraLocal.value.copy(nav);volume.setActivePlanet(body,nav);volume.resetHistory();volume.render(renderer,opaque,airTarget);
          const actual=read(opaque),correction=read(volume.current);
          const cloudEyeError=cu.uCameraLocal.value.distanceTo(origin);
          // Reuse identical opaque/air inputs with the frozen previous pass.
          // Its cloud source eye still follows nav, reproducing the old error.
          cu.uCameraLocal.value.copy(nav);original.setActivePlanet(body,nav);original.resetHistory();original.render(renderer,opaque,airTarget);
          const wrong=read(opaque);
          offsetCases.push({name:fixture.name,offset,actual,correction,airEyeError,cloudEyeError,
            maxRgbError:Math.max(...actual.slice(0,3).map((v,i)=>Math.abs(v-expected.actual[i]))),
            cloudNativeChanged:correction.filter((v,i)=>v!==expected.cloudCorrection[i]).length,
            oldMaxRgbError:Math.max(...wrong.slice(0,3).map((v,i)=>Math.abs(v-expected.actual[i])))});
        }
        camera.position.set(0,0,0);camera.updateMatrixWorld(true);surface.position.set(0,fixture.depth,0);
        volume.setActivePlanet(body,origin);cu.uCameraLocal.value.copy(origin);air.updatePlanetUniforms(eyeBody,origin);
      }
    }
    // A one-pixel foreground pole has no corresponding low-resolution cloud
    // sample. The production upscale must keep its full-resolution air colour.
    const dataTexture = (width, height, sample) => {
      const data = new Float32Array(width * height * 4);
      for (let y=0;y<height;y++) for (let x=0;x<width;x++) data.set(sample(x,y),(y*width+x)*4);
      const texture = new THREE.DataTexture(data,width,height,THREE.RGBAFormat,THREE.FloatType);
      texture.needsUpdate=true; return texture;
    };
    const edgeBase=dataTexture(8,4,()=>[0.2,0.3,0.4,1]);
    const edgeDepth=dataTexture(8,4,(x)=>[x===1?0.3:1,0,0,1]);
    const edgeCloud=dataTexture(2,1,()=>[0.4,0.2,0.1,0.8]);
    const edgeTarget=new THREE.WebGLRenderTarget(8,4,{type:THREE.FloatType,depthBuffer:false});
    const eu=volume.compositeMaterial.uniforms;
    eu.tBase.value=edgeBase; eu.tVolume.value=edgeCloud; eu.tSceneDepth.value=edgeDepth;
    eu.uDepthReady.value=1; eu.uTexel.value.set(0.5,1);
    renderer.setRenderTarget(edgeTarget); volume.compositeQuad.render(renderer);
    const edgePixels=new Float32Array(8*4*4);
    renderer.readRenderTargetPixels(edgeTarget,0,0,8,4,edgePixels);
    let edgeError=0;
    for(let y=0;y<4;y++) for(let x=0;x<8;x++) {
      const expected=x===1?[0.2,0.3,0.4]:[0.44,0.26,0.18];
      expected.forEach((v,c)=>{edgeError=Math.max(edgeError,Math.abs(v-edgePixels[(y*8+x)*4+c]));});
    }
    if(renderer.getContext().getError()!==0) throw Error('Edge reconstruction WebGL error');
    renderer.setRenderTarget(null);
    for(const texture of [edgeBase,edgeDepth,edgeCloud]) texture.dispose(); edgeTarget.dispose();
    for (const rt of [opaque, airTarget]) rt.dispose();
    geometry.dispose(); surface.material.dispose(); air.dispose(); volume.dispose();original?.dispose(); cloudMesh.geometry.dispose(); cloud.dispose();
    detail.dispose(); disposeCloudNoiseTexture(); renderer.dispose();
    return { cases, offsetCases, edgeError };
  }, {fixtures,production,viewOffsets});
  assert.deepEqual(errors, []);
  assert.ok(result.edgeError<1e-6, `thin opaque foreground leak: ${result.edgeError}`);
  const cases = result.cases.map((actual, i) => {
    const reference = fixtures[i].reference;
    const error = Math.max(...reference.radiance.map((x, c) => Math.abs(x - actual.actual[c])));
    assert.ok(actual.actual.every(Number.isFinite) && actual.actual[3] === 1);
    assert.ok(error < 0.001, `${actual.name}: ${error}`);
    return { ...actual, reference, maxAbsoluteRgbError: error };
  });
  await mkdir('test-results/b5', { recursive: true });
  const after=await evidenceFingerprint('tools/b5transporttest.js');
  await writeFile(`test-results/b5/transport${production?'-production':''}${viewOffsets?'-view-offsets':''}.json`, JSON.stringify({ fingerprint:after,before,
    cases, offsetCases:result.offsetCases, edgeError: result.edgeError, errors, scope: 'Production air/cloud transfer and log depth from an actual opaque draw; prescribed constant coefficients/sources, includes thin-foreground upscale rejection. Optional offset controls hold the absolute eye fixed while rebasing nav and the actual camera; cloud sampler/vertex adapters remain the B5 slab fixture, not full weather or temporal reconstruction acceptance.' }, null, 2));
  assert.deepEqual(before,after);
  if(viewOffsets) {
    await writeFile('test-results/b5/view-reference-volumetric-pass-webgl.js',oldVolume);
    assert.equal(result.offsetCases.length,24);
    assert.ok(result.offsetCases.every(c=>c.airEyeError===0&&c.cloudEyeError===0&&c.maxRgbError<1e-6&&c.cloudNativeChanged===0),JSON.stringify(result.offsetCases));
    assert.ok(result.offsetCases.some(c=>c.oldMaxRgbError>.002),'Frozen old eye control must expose a visible transfer error');
  }
  console.log('PASS B5 joint transport + actual opaque depth:', cases.map((c) => [c.name, c.maxAbsoluteRgbError]));
} finally {
  await browser?.close(); await new Promise((resolve) => server.close(resolve));
}
