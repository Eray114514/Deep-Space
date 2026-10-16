import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchBrowser, launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const out = 'test-results/terrain-detail';
await mkdir(out, { recursive: true });
const fingerprint = await evidenceFingerprint('tools/terraindetailgputest.js');
const { server, port } = await startServer(0);
const errors = [];
let browser;
try {
  browser = process.argv.includes('--hardware')
    ? await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined }) : await launchBrowser();
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/terrain-detail-fixture.html', route => route.fulfill({ contentType: 'text/html',
    body: '<script type="importmap">{"imports":{"three":"/vendor/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>' }));
  await page.goto(`http://127.0.0.1:${port}/terrain-detail-fixture.html`);
  const report = await page.evaluate(async () => {
    const T = await import('three');
    const { applyTerrainDetail } = await import('/src/shaders-webgl.js');
    const { terrainDetailDomains, terrainDetailGLSL } = await import('/src/terrain-detail-frame.js');
    const { ChunkedLOD } = await import('/src/quadtree.js');
    const renderer = new T.WebGLRenderer({ logarithmicDepthBuffer: true });
    const gl = renderer.getContext(), extension = gl.getExtension('WEBGL_debug_renderer_info');
    const camera = new T.PerspectiveCamera(62, 1, 0.1, 1e10);
    const scene = new T.Scene(), group = new T.Group(); scene.add(group);
    const size = 32, bytes = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      bytes[i] = (x * 37 + y * 13) % 256; bytes[i + 1] = (x * 7 + y * 53) % 256;
      bytes[i + 2] = 0; bytes[i + 3] = 255;
    }
    const tex = new T.DataTexture(bytes, size, size);
    tex.wrapS = tex.wrapT = T.RepeatWrapping;
    tex.minFilter = tex.magFilter = T.NearestFilter; tex.needsUpdate = true;
    const fract = x => x - Math.floor(x);
    const circular = (a, b) => Math.abs(a - b - Math.round(a - b));
    const sample = (u, v, ch) => bytes[(Math.floor(fract(v) * size) * size + Math.floor(fract(u) * size)) * 4 + ch] / 255;
    const tri = (p, scale, ch) => sample(p.y * scale, p.z * scale, ch) * 0.2
      + sample(p.z * scale, p.x * scale, ch) * 0.5 + sample(p.x * scale, p.y * scale, ch) * 0.3;
    const color = new T.Color(0.2, 0.4, 0.3);
    const palU = { landT: [0,1,1,1,1,1,1], landC: Array(7).fill(color), landN: 2,
      seaT: [0,1,1,1,1,1,1], seaC: Array(7).fill(color), seaN: 2, hasSea: 0,
      t0: 0, tSpan: 1, seaDepthSpan: 1, rock: color, slopeLo: 0.1, slopeHi: 0.5,
      forest: color, blotch: color, stripeA: color, stripeB: color, stripeK: 0, extraC: color, extraMode: 0 };
    let samples = 0, maxPhaseError = 0, maxNormalError = 0, maxPbrError = 0, maxOldError = 0, maxMetres = 0;
    let compiled = 0, failure = null, missingPhaseControl = 0, wrongRockControl = 0;
    const rows = [];
    try {
      for (const radius of [6e6, 2e7]) for (const scale1 of [1 / 26, 0.0397]) {
        const domains = terrainDetailDomains(scale1);
        const planet = { R: radius, hAmp: 1, gridCells: 4, skirtDrop: 0.081,
          group, _invFrame: new T.Quaternion(), type: 'lush', palU, skyColor: color,
          sunDirLocal: new T.Vector3(0,1,0), pal: { slopeLo: 0, slopeHi: 1 },
          freqAtLevel: level => level, height: (dir, level) => 0.137 + Math.sin(dir.y * 19000) * 0.017 + level * 0.0031 };
        const material = applyTerrainDetail(new T.MeshStandardMaterial(), planet, 0.2, 0.4, scale1);
        const deform = material.onBeforeCompile;
        const selector = { value: 0 }, mode = { value: 0 }, normal = { value: new T.Vector3(0,0,1) };
        const variants = [];
        material.onBeforeCompile = (shader, renderer) => {
          deform(shader, renderer); compiled++;
          variants.push(shader.uniforms.uTerrainDomains);
          if (variants.some(uniform => uniform !== material.userData.terrainDetailUniforms.uTerrainDomains)) throw Error('Stale shader variant owner.');
          shader.uniforms.uDetailTex = { value: tex };
          shader.uniforms.uProbeDomain = selector; shader.uniforms.uProbeMode = mode;
          shader.uniforms.uProbeNormal = normal;
          shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
            attribute vec2 aProbeCorner; attribute float aProbeSlot;`)
            .replace('#include <project_vertex>', `#include <project_vertex>
              gl_Position=vec4(2.0*(aProbeSlot+0.5+aProbeCorner.x)/10.0-1.0,aProbeCorner.y,0,1);`);
          const functions = shader.fragmentShader.slice(shader.fragmentShader.indexOf('vec2 surfaceMaterialUv('),
            shader.fragmentShader.indexOf('float terrainHash('));
          shader.fragmentShader = `varying vec3 vViewPosition;
            uniform sampler2D uDetailTex; uniform int uProbeDomain,uProbeMode; uniform vec3 uProbeNormal;
            ${terrainDetailGLSL(domains)} ${functions}
            void main() {
              vec3 p=terrainDetailPosition(); vec4 d=uTerrainDomains[uProbeDomain];
              vec3 q=p*d.w+d.xyz;
              if(uProbeMode==1) q.xy=surfaceMaterialUv(p,uProbeNormal,d);
              if(uProbeMode==2) q=p*d.w;
              if(uProbeMode==3) q=(p*terrainGrass.w+terrainGrass.xyz)*.78+.17;
              vec3 delta=uProbeMode==1?vec3(0,.35,0):vec3(.35,0,0);
              float gradient=triDetail(p+delta,vec3(.2,.5,.3),terrainGrainFine,1)
                -triDetail(p-delta,vec3(.2,.5,.3),terrainGrainFine,1);
              gl_FragColor=vec4(fract(q),gradient);
            }`;
        };
        material.customProgramCacheKey = () => `terrain-detail-probe-${scale1}`;
        material.depthTest = false; material.depthWrite = false; material.blending = T.NoBlending;
        planet.terrainMaterial = material;
        const lod = Object.create(ChunkedLOD.prototype); lod.planet = planet;
        const node = (u0,v0,span,level,parent=null,childX=0,childY=0) => ({
          face: 0, u0,v0,u1:u0+span,v1:v0+span,level,parent,childX,childY,ix:0,iy:0,morph:0,
          centerPos: new T.Vector3(1,v0+span/2,-(u0+span/2)).normalize().multiplyScalar(radius),
        });
        const parent = node(0.13,-0.17,2/8192,13); lod.buildNodeMesh(parent);
        const nodes = [parent];
        for(const x of [0,1]) for(const y of [0,1]) {
          const span=(parent.u1-parent.u0)/2;
          const child=node(parent.u0+x*span,parent.v0+y*span,span,14,parent,x,y);
          lod.buildNodeMesh(child); nodes.push(child);
        }
        const probes = [];
        nodes.forEach((node, index) => {
          group.remove(node.mesh);
          for(const [j, vertex] of [4,29].entries()) {
            const source=node.mesh.geometry, geo=new T.BufferGeometry();
            for(const name of Object.keys(source.attributes)) {
              const attribute=source.getAttribute(name), values=[];
              for(let k=0;k<6;k++) for(let axis=0;axis<attribute.itemSize;axis++) values.push(attribute.getComponent(vertex,axis));
              geo.setAttribute(name,new T.Float32BufferAttribute(values,attribute.itemSize));
            }
            // Poison large shader-only positions: metre detail must not use them.
            geo.getAttribute('aLocal').array.fill(12345678);
            geo.setAttribute('aProbeCorner',new T.Float32BufferAttribute([-.5,-1,.5,-1,.5,1,-.5,-1,.5,1,-.5,1],2));
            geo.setAttribute('aProbeSlot',new T.Float32BufferAttribute(Array(6).fill(index*2+j),1));
            const mesh=new T.Mesh(geo,material); mesh.position.copy(node.mesh.position);
            mesh.frustumCulled=false; mesh.renderOrder=index*2+j; group.add(mesh);
            probes.push({mesh,node,vertex});
          }
        });
        const target=new T.WebGLRenderTarget(10,1,{type:T.FloatType,depthBuffer:false});
        const pixels=new Float32Array(40);
        for(const pose of [0,1,2]) for(const rebase of [0,1e8,-1e8,0]) for(const morph of [0,0.37,1]) {
          normal.value.set(pose===0?1:0,pose===1?1:0,pose===2?1:0);
          group.quaternion.setFromEuler(new T.Euler(.32+pose*.4,-.44,.15));
          planet._invFrame.copy(group.quaternion).invert();
          const anchor=parent.centerPos.clone().add(new T.Vector3(1.137+pose*117.031,-2.319,3.731));
          group.position.copy(anchor).applyQuaternion(group.quaternion).negate().add(new T.Vector3(rebase,234,-117));
          camera.position.set(rebase+2.3,235.7,-122.1);
          camera.quaternion.setFromEuler(new T.Euler(-.21,.61+pose*.3,-.34));
          camera.updateMatrixWorld(true);
          for(const {mesh} of probes) {mesh.geometry.getAttribute('aLodMorph').array.fill(morph);mesh.geometry.getAttribute('aLodMorph').needsUpdate=true;}
          for(let domainIndex=0;domainIndex<domains.length;domainIndex++) for(const probeMode of [0,1]) {
            selector.value=domainIndex;mode.value=probeMode;
            renderer.setRenderTarget(target);renderer.render(scene,camera);
            renderer.readRenderTargetPixels(target,0,0,10,1,pixels);
            if(gl.getError()) throw Error('GPU GL error.');
            probes.forEach(({mesh}, slot) => {
              const a=mesh.geometry.getAttribute('position'), delta=mesh.geometry.getAttribute('aPositionDelta');
              const canonical=mesh.position.clone();
              ['x','y','z'].forEach((axis,i)=> canonical[axis]+=Math.fround(a.getComponent(0,i)+Math.fround(delta.getComponent(0,i)*morph)));
              const domain=domains[domainIndex];
              const q=canonical.clone().multiplyScalar(domain.scale).addScalar(domain.shift);
              if(probeMode) {const uv=pose===0?[q.y,q.z]:pose===1?[q.z,q.x]:[q.x,q.y];q.x=uv[0];q.y=uv[1];}
              ['x','y','z'].forEach((axis,i)=> {
                const expected=q[axis];
                const error=circular(pixels[slot*4+i],expected);
                if(probeMode) maxPbrError=Math.max(maxPbrError,error); else maxPhaseError=Math.max(maxPhaseError,error);
                if(!probeMode) maxOldError=Math.max(maxOldError,circular(Math.fround(Math.fround(canonical[axis])*Math.fround(domain.scale))+domain.shift,expected));
                // The largest 20 Mm fixture chunks span kilometres. Express
                // the precision gate in metres rather than cycles at unlike scales.
                maxMetres=Math.max(maxMetres,error/domain.scale);
                if(error/domain.scale>0.002) throw Error(`Phase ${radius}/${pose}/${rebase}/${morph}/${domain.name}/${slot}/${axis}: ${error/domain.scale} m`);
              });
              const axis=probeMode?'y':'x';
              const plus=canonical.clone();plus[axis]+=.35;const minus=canonical.clone();minus[axis]-=.35;
              const expected=tri(plus,1/3.2,1)-tri(minus,1/3.2,1);
              const normalError=Math.abs(pixels[slot*4+3]-expected);
              maxNormalError=Math.max(maxNormalError,normalError);
              if(normalError>0.00001) throw Error(`Normal derivative error ${normalError}`);
              samples++;
            });
          }
        }
        selector.value=11;mode.value=0;renderer.render(scene,camera);
        renderer.readRenderTargetPixels(target,0,0,10,1,pixels);
        const correct=pixels.slice();
        for(const control of [2,3]) {
          mode.value=control;renderer.render(scene,camera);renderer.readRenderTargetPixels(target,0,0,10,1,pixels);
          let error=0;
          for(let i=0;i<pixels.length;i++) if(i%4<3) error=Math.max(error,circular(pixels[i],correct[i]));
          if(control===2)missingPhaseControl=Math.max(missingPhaseControl,error);else wrongRockControl=Math.max(wrongRockControl,error);
          if(error<0.1)throw Error('GPU negative control did not expose phase ownership failure.');
        }
        rows.push({radius,scale1,variants:variants.length});
        group.clear(); probes.forEach(({mesh})=>mesh.geometry.dispose());
        nodes.forEach(node=>node.mesh.geometry.dispose()); material.dispose();target.dispose();
      }
    } catch(error) { failure=String(error); }
    finally {renderer.setRenderTarget(null);tex.dispose();renderer.dispose();}
    return {samples,maxPhaseError,maxPbrError,maxNormalError,maxOldError,maxMetres,missingPhaseControl,wrongRockControl,compiled,rows,failure,
      gpu:extension?gl.getParameter(extension.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)};
  });
  const final = await evidenceFingerprint('tools/terraindetailgputest.js');
  const stableSource = fingerprint.sourceDigest === final.sourceDigest && fingerprint.verifierDigest === final.verifierDigest;
  const path = `${out}/${process.argv.includes('--hardware')?'hardware':'swiftshader'}-gpu.json`;
  await writeFile(path,JSON.stringify({fingerprint,stableSource,report,errors},null,2));
  console.log(JSON.stringify(report));
  assert.equal(stableSource,true);assert.deepEqual(errors,[]);assert.equal(report.failure,null);
  assert.equal(report.samples,34560);assert.equal(report.compiled,8);assert.equal(report.rows.length,4);
  assert.ok(report.maxOldError>0.1);
  console.log(`PASS: ${path}`);
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
