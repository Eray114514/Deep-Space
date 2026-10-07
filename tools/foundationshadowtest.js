import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';
const out='test-results/foundation-shadow',before=await evidenceFingerprint('tools/foundationshadowtest.js');
const {server,port}=await startServer(0);let browser;
await mkdir(out,{recursive:true});const errors=[];
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath()||undefined});
  const page=await browser.newPage({viewport:{width:1280,height:720}});
  page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&nolock=1&freeze=1&quality=low&vclouds=0`);
  await page.waitForFunction(()=>NMS?.booted,null,{timeout:180000});
  const result=await page.evaluate(async()=>{
    const {withPreparedShadows}=await import('/src/render-shadow-state.js');
    const T=NMS._THREE,r=NMS._renderer,scene=new T.Scene();
    const camera=new T.PerspectiveCamera(50,1,.1,100);camera.position.set(5,6,8);camera.lookAt(0,0,0);
    const mat=new T.MeshStandardMaterial({color:0xcccccc}),cube=new T.Mesh(new T.BoxGeometry(1,2,1),mat);
    cube.position.y=1;cube.castShadow=true;scene.add(cube);
    const ground=new T.Mesh(new T.PlaneGeometry(12,12),mat);ground.rotation.x=-Math.PI/2;ground.receiveShadow=true;scene.add(ground);
    scene.add(new T.AmbientLight(0xffffff,.3));
    const light=new T.DirectionalLight(0xffffff,3);light.position.set(3,6,2);light.castShadow=true;
    light.shadow.mapSize.set(128,128);light.shadow.camera.left=-7;light.shadow.camera.right=7;
    light.shadow.camera.top=7;light.shadow.camera.bottom=-7;light.shadow.camera.near=.1;light.shadow.camera.far=30;scene.add(light,light.target);
    const target=new T.WebGLRenderTarget(128,128),saved=r.getRenderTarget(),face=r.getActiveCubeFace(),mip=r.getActiveMipmapLevel();
    const oldAuto=r.autoClear,oldShadowAuto=r.shadowMap.autoUpdate;let draws=0;
    cube.onBeforeShadow=()=>draws++;
    const image=()=>{const b=new Uint8Array(128*128*4);r.readRenderTargetPixels(target,0,0,128,128,b);return b;};
    const shadow=()=>{
      const map=light.shadow.map,b=new Uint8Array(map.width*map.height*4);
      r.readRenderTargetPixels(map,0,0,map.width,map.height,b);return b;
    };
    const records=[];
    try {
      r.autoClear=true;r.shadowMap.autoUpdate=true;r.setRenderTarget(target);
      for(const x of [0,2,-1]) {
        cube.position.x=x;
        const capture=prepared=>{
          draws=0;r.render(scene,camera);withPreparedShadows(r,prepared,()=>r.render(scene,camera));
          const color=image(),native=shadow();return {draws,color,native};
        };
        const reference=capture(false),current=capture(true);
        const diff=(a,b)=>a.reduce((n,v,i)=>n+(v!==b[i]),0);
        records.push({x,referenceDraws:reference.draws,currentDraws:current.draws,
          colorChanged:diff(reference.color,current.color),shadowChanged:diff(reference.native,current.native),
          shadowRange:[Math.min(...current.native.filter((_,i)=>i%4===0)),Math.max(...current.native.filter((_,i)=>i%4===0))],
          color:current.color});
      }
      let invalidationDraws=0;
      r.shadowMap.needsUpdate=true;draws=0;
      withPreparedShadows(r,true,()=>r.render(scene,camera));invalidationDraws=draws;
      let threw=false;try {withPreparedShadows(r,true,()=>{throw Error('draw');});}catch {threw=true;}
      return {records:records.map(({color,...record})=>record),movingShadowChanged:records[0].color.reduce((n,v,i)=>n+(v!==records[1].color[i]),0),
        invalidationDraws,restoredAuto:r.shadowMap.autoUpdate,threw,gl:r.getContext().getError()};
    } finally {r.setRenderTarget(saved,face,mip);r.autoClear=oldAuto;r.shadowMap.autoUpdate=oldShadowAuto;
      target.dispose();light.shadow.dispose();mat.dispose();cube.geometry.dispose();ground.geometry.dispose();}
  });
  const after=await evidenceFingerprint('tools/foundationshadowtest.js');
  await writeFile(`${out}/report.json`,JSON.stringify({before,after,result,errors},null,2));
  assert.equal(before.sourceDigest,after.sourceDigest);assert.deepEqual(errors,[]);assert.equal(result.gl,0);
  for(const r of result.records) {
    assert.equal(r.referenceDraws,2);assert.equal(r.currentDraws,1);
    assert.equal(r.colorChanged,0);assert.equal(r.shadowChanged,0);
    assert.ok(r.shadowRange[0]<r.shadowRange[1],'Need a real nonempty native shadow');
  }
  assert.ok(result.movingShadowChanged>100);assert.equal(result.invalidationDraws,1);
  assert.equal(result.restoredAuto,true);assert.equal(result.threw,true);
  console.log(`PASS: same-frame native shadow draws 2->1, exact image/map for three moving poses, invalidation and exception restoration; ${out}`);
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
