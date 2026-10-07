import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchBrowser, launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const out = 'test-results/vegetation-precision';
await mkdir(out, { recursive: true });
const fingerprint = await evidenceFingerprint('tools/vegetationgputest.js');
const { server, port } = await startServer(0);
let browser;
const errors = [];
try {
  browser = process.env.VEGETATION_HARDWARE === '1'
    ? await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined }) : await launchBrowser();
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/vegetation-gpu-fixture.html', route => route.fulfill({ contentType: 'text/html',
    body: '<!doctype html><script type="importmap">{"imports":{"three":"/vendor/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>' }));
  await page.goto(`http://127.0.0.1:${port}/vegetation-gpu-fixture.html`);
  const phaseControl = process.argv.includes('--no-origin-phase-control');
  const report = await page.evaluate(async phaseControl => {
    const T = await import('three');
    const { Scatter } = await import('/src/scatter.js');
    const { TIME, GROW, WIND } = await import('/src/shaders.js');
    const { surfaceInteraction } = await import('/src/surface-interaction.js');
    const { vegetationPrecisionFixture } = await import('/tools/vegetation-precision-fixture.js');
    const renderer = new T.WebGLRenderer({ logarithmicDepthBuffer: true });
    const gl = renderer.getContext(), adapter = gl.getExtension('WEBGL_debug_renderer_info');
    const target = new T.WebGLRenderTarget(1, 1, { type: T.FloatType, depthBuffer: false });
    const camera = new T.PerspectiveCamera(62, 1, 0.12, 1.2e11);
    camera.quaternion.setFromEuler(new T.Euler(-0.21, 0.37, 0.11));
    const inverseView = camera.quaternion.clone().invert();
    const points = new T.BufferGeometry();
    points.setAttribute('position', new T.Float32BufferAttribute([0,0,0, 0,0,0, 0,0,0], 3));
    points.setAttribute('normal', new T.Float32BufferAttribute([0,1,0, 0,1,0, 0,1,0], 3));
    points.setAttribute('color', new T.Float32BufferAttribute(new Float32Array(9).fill(1), 3));
    const countUniform = { value: 1 }, probeUniform = { value: new T.Vector3() };
    const materials = new Map(), scatter = new Scatter({ grassRadius: 36, grassDensity: 0.35 });
    const summary = Object.fromEntries(['visible', 'depth', 'distance'].map(name => [name,
      { samples: 0, maxPositionError: 0, maxPressureDistanceError: 0 }]));
    const nativeShadows = [];
    let failure = null;
    const probeMaterial = source => {
      const key = source.type + ':' + source.customProgramCacheKey();
      if (materials.has(key)) return materials.get(key);
      const material = source.clone(), deform = source.onBeforeCompile;
      // The native point-shadow renderer supplies this light before a draw.
      if (material.isMeshDistanceMaterial) renderer.properties.get(material).light = new T.PointLight();
      material.depthTest = false; material.depthWrite = false;
      material.blending = T.NoBlending; material.toneMapped = false;
      material.onBeforeCompile = (shader, renderer) => {
        deform(shader, renderer);
        shader.uniforms.uProbeCount = countUniform; shader.uniforms.uProbe = probeUniform;
        shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
          uniform vec3 uProbe; uniform float uProbeCount; varying vec4 vMeasured;`)
          .replace('#include <begin_vertex>', 'vec3 transformed = uProbe;')
          .replace('#include <project_vertex>', `#include <project_vertex>
            vMeasured = vec4(mvPosition.xyz, distance(instanceMatrix[3].xyz, uBendPos[0].xyz));
            vec2 corner=gl_VertexID==0?vec2(-.5,-1):gl_VertexID==1?vec2(.5,-1):vec2(0,1);
            gl_Position=vec4(2.0*(float(gl_InstanceID)+.5+corner.x)/uProbeCount-1.0,corner.y,0,1);`);
        shader.fragmentShader = 'varying vec4 vMeasured; void main(){gl_FragColor=vMeasured;}';
      };
      material.customProgramCacheKey = () => key + ':numerical-probe';
      materials.set(key, material); return material;
    };
    const smooth = (a, b, value) => { const t = Math.max(0, Math.min(1, (value-a)/(b-a))); return t*t*(3-2*t); };
    const checkNativeShadows = () => {
      const source = ['tree0','tree1','shrub'].map(kind => scatter.meshes[kind]).find(mesh => mesh.count);
      if (!source) throw Error('Native shadow fixture requires a real generated plant.');
      const savedOrigin = scatter.frame.origin.clone();
      const canonical = new T.Vector3().fromArray(source.instanceMatrix.array,12).add(source.position);
      scatter.frame.setOrigin(canonical); scatter.frame.syncInteractions('fixture');
      const caster = new T.InstancedMesh(source.geometry,source.material,1);
      const matrix = new T.Matrix4().fromArray(source.instanceMatrix.array); matrix.setPosition(0,0,0);
      caster.setMatrixAt(0,matrix); caster.instanceMatrix.needsUpdate = true; caster.frustumCulled = false;
      caster.customDepthMaterial = source.customDepthMaterial; caster.customDistanceMaterial = source.customDistanceMaterial;
      const root = new T.Group(); root.quaternion.setFromUnitVectors(canonical.clone().normalize(),new T.Vector3(0,1,0)); root.add(caster);
      const scene = new T.Scene(); scene.add(root);
      const view = new T.PerspectiveCamera(45,1,.12,100); view.position.set(3,3,4); view.lookAt(0,.5,0);
      renderer.setRenderTarget(null); renderer.setSize(64,64); renderer.shadowMap.enabled = true;
      try {
        for (const light of [new T.DirectionalLight(),new T.PointLight()]) {
          light.position.set(3,6,3); light.castShadow = true; light.shadow.mapSize.set(128,128);
          light.shadow.camera.near = .1; light.shadow.camera.far = 20;
          if (light.isDirectionalLight) Object.assign(light.shadow.camera,{ left:-2,right:2,top:2,bottom:-2 });
          let draws = 0;
          caster.onBeforeShadow = (...args) => { draws++; source.onBeforeShadow(...args); };
          scene.add(light);
          const capture = cast => {
            caster.castShadow = cast; renderer.shadowMap.needsUpdate = true; renderer.render(scene,view);
            const map = light.shadow.map, faces = map.isWebGLCubeRenderTarget ? 6 : 1;
            const bytes = map.width*map.height*4, pixels = new Uint8Array(bytes*faces);
            for (let face=0;face<faces;face++) renderer.readRenderTargetPixels(map,0,0,map.width,map.height,
              pixels.subarray(face*bytes,(face+1)*bytes), map.isWebGLCubeRenderTarget ? face : undefined);
            const error = gl.getError(); if (error) throw Error(`Native ${light.type} shadow GL ${error}`);
            return pixels;
          };
          const off = capture(false), on = capture(true); let changedPixels = 0;
          for (let i=0;i<on.length;i+=4) if (on.subarray(i,i+4).some((value,j)=>value!==off[i+j])) changedPixels++;
          nativeShadows.push({ light:light.type,draws,changedPixels });
          if (!draws || !changedPixels) throw Error(`Missing native ${light.type} shadow contribution.`);
          scene.remove(light); light.shadow.dispose();
        }
      } finally { renderer.shadowMap.enabled = false; caster.dispose(); scatter.frame.setOrigin(savedOrigin); }
    };
    // Independent double-precision wind/pressure reference in canonical space.
    const deformed = (tip, root, centre, amount, leaf, grow, age) => {
      const ph = root.x*.61 + root.y*.53 + root.z*.47, y = tip*grow;
      const envelope = 1+.4*(.52+.48*Math.sin(7.25*.23+ph*.11));
      const along = (.56*Math.sin(7.25*.82+ph)+.29*Math.sin(7.25*1.9+ph*1.67)
        +(leaf ? .08*Math.sin(7.25*7.6+ph*2.31) : 0))*envelope+.34*1.1;
      const across = .13*Math.sin(7.25*3.4+ph*.73)*envelope, k = amount*Math.max(y,0)*1.1;
      const pressure = (1-smooth(0,8.5,root.distanceTo(centre)))*.9*Math.exp(-age*1.25);
      const t = smooth(0,.65,Math.max(y,0));
      return new T.Vector3((.6*along-.8*across)*k+Math.sin(ph)*pressure*t*.7,
        y*(1-pressure*t*.68), (.8*along+.6*across)*k+Math.cos(ph)*pressure*t*.7);
    };
    try {
      TIME.value = 7.25; WIND.set(.6,.8,1.1,.4);
      const directions = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1],
        [1,1,1],[-1,-1,-1],[-2963,5053,134],[1,-2,-3]];
      for (const profile of ['flat','relief']) for (const radius of [286000,6000000,20000000]) {
        const fixture = vegetationPrecisionFixture(radius, profile), p = fixture.planet;
        try {
          scatter.setPlanet(p);
          for (const direction of directions) {
            const anchor = new T.Vector3(...direction).normalize().multiplyScalar(radius/9).round();
            scatter.beginJob(p,anchor.x,anchor.y,anchor.z,radius/9,9/radius);
            scatter.stepJob(Infinity); scatter.commitJob(scatter.job); scatter.job = null;
            if (!nativeShadows.length && !phaseControl) checkNativeShadows();
            const origin = scatter.frame.origin.clone(), cam = origin.clone().add(new T.Vector3(...direction).normalize().multiplyScalar(400));
            p.group.quaternion.setFromEuler(new T.Euler(.31,-.27,.41));
            p.group.position.copy(cam).applyQuaternion(p.group.quaternion).negate();
            const firstGrass = scatter.meshes.grassNear;
            const centre = new T.Vector3().fromArray(firstGrass.instanceMatrix.array,12).add(origin);
            surfaceInteraction.setPlanet('fixture'); surfaceInteraction.clear(); surfaceInteraction.cursor = 0;
            surfaceInteraction.inject(centre,8.5,.9,1.25);
            for (const [kind, source] of Object.entries(scatter.meshes)) {
              if (!source.count) continue;
              const count = Math.min(48,source.count), original = source.instanceMatrix.array;
              const selected = new Float32Array(count*16), roots = [];
              for (let i=0;i<count;i++) {
                const at = Math.floor(i*(source.count-1)/Math.max(1,count-1))*16;
                selected.set(original.subarray(at,at+16),i*16);
                roots.push(new T.Vector3().fromArray(original,at+12).add(origin));
              }
              const configuration = { uniforms:{},vertexShader:'',fragmentShader:'' };
              source.material.onBeforeCompile(configuration);
              const amount = configuration.uniforms.uSway.value, leaf = kind.startsWith('grass');
              const variants = [['visible',source.material],['depth',source.customDepthMaterial],['distance',source.customDistanceMaterial]];
              for (const renderOrigin of [origin,origin.clone().add(new T.Vector3(83.25,-47.125,61.875))]) {
                scatter.frame.setOrigin(renderOrigin);
                if (phaseControl) {
                  scatter.frame.uniforms.uWindPhase.value.set(0,0,0,0);
                  scatter.frame.uniforms.uWindFlutterPhase.value = 0;
                }
                for (const age of [0,.4]) for (const grow of [1,.73,0]) {
                  surfaceInteraction.data[0].x=age*1.25; scatter.frame.syncInteractions('fixture'); GROW.value=grow;
                  for (const [name, sourceMaterial] of variants) {
                    const mesh = new T.InstancedMesh(points,probeMaterial(sourceMaterial),count);
                    mesh.frustumCulled=false; mesh.position.copy(renderOrigin);
                    for (let i=0;i<count;i++) {
                      mesh.instanceMatrix.array.set(selected.subarray(i*16,i*16+16),i*16);
                      roots[i].clone().sub(renderOrigin).toArray(mesh.instanceMatrix.array,i*16+12);
                    }
                    const scene = new T.Scene(), root = new T.Group();
                    root.position.copy(p.group.position); root.quaternion.copy(p.group.quaternion); root.add(mesh); scene.add(root);
                    countUniform.value=count; target.setSize(count,1);
                    const pixels = new Float32Array(count*4);
                    for (const tip of [0,5]) {
                      probeUniform.value.set(0,tip,0); renderer.setRenderTarget(target); renderer.clear(); renderer.render(scene,camera);
                      renderer.readRenderTargetPixels(target,0,0,count,1,pixels);
                      const error=gl.getError(); if(error) throw Error(`GL ${error}, ${kind}/${name}`);
                      for (let i=0;i<count;i++) {
                        const matrix = new T.Matrix4().fromArray(selected,i*16); matrix.setPosition(roots[i]);
                        const expected=deformed(tip,roots[i],centre,amount,leaf,grow,age).applyMatrix4(matrix)
                          .sub(cam).applyQuaternion(p.group.quaternion).applyQuaternion(inverseView);
                        const error=new T.Vector3().fromArray(pixels,i*4).distanceTo(expected);
                        const pressureError=Math.abs(pixels[i*4+3]-roots[i].distanceTo(centre));
                        const stats=summary[name]; stats.samples++;
                        stats.maxPositionError=Math.max(stats.maxPositionError,error);
                        stats.maxPressureDistanceError=Math.max(stats.maxPressureDistanceError,pressureError);
                        if(!Number.isFinite(error+pressureError) || error>=.002 || pressureError>=.002) {
                          throw Error(`${kind}/${name} R=${radius}: position=${error}, pressure distance=${pressureError}`);
                        }
                      }
                    }
                    mesh.dispose();
                  }
                }
              }
            }
          }
        } finally { scatter.clear(); fixture.geometry.dispose(); }
      }
    } catch(error) { failure=String(error); }
    finally {
      renderer.setRenderTarget(null); target.dispose(); points.dispose();
      for(const material of materials.values()) material.dispose(); renderer.dispose();
    }
    return { summary,nativeShadows,failure,gpu:adapter?gl.getParameter(adapter.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER) };
  }, phaseControl);
  const finalFingerprint=await evidenceFingerprint('tools/vegetationgputest.js');
  const path=`${out}/${process.env.VEGETATION_HARDWARE==='1'?'hardware':'swiftshader'}-${phaseControl?'no-origin-control':'gpu'}.json`;
  await writeFile(path,JSON.stringify({fingerprint,stableSource:fingerprint.sourceDigest===finalFingerprint.sourceDigest,
    report,errors,scope:'Production vertex deformation and Three transforms; visible/depth/distance, 60 poses, rebasing, pressure recovery and grow; not full shadow-map or player acceptance'},null,2));
  console.log(JSON.stringify(report));
  assert.deepEqual(errors,[]); assert.equal(report.failure,null);
  assert.ok(Object.values(report.summary).every(value=>value.samples>100000));
  console.log(`PASS: visible and both shadow vertex paths retain placement, wind and pressure; ${path}`);
} finally { await browser?.close(); await new Promise(resolve=>server.close(resolve)); }
