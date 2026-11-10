import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { startServer } from './server.js';

const out=`test-results/surface-shadow-grid/${new Date().toISOString().replace(/[:.]/g,'-')}`;
await mkdir(out,{recursive:true});
const report={errors:[],passed:false};
let server,browser;
try {
  const serving=await startServer(0);server=serving.server;
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath()||undefined});
  const page=await browser.newPage({viewport:{width:960,height:540}});
  page.on('pageerror',error=>report.errors.push(String(error)));
  page.on('console',message=>{if(message.type()==='error')report.errors.push(message.text());});
  await page.goto(`http://127.0.0.1:${serving.port}/?nohero=1&quality=balanced&vclouds=0&buildms=25`);
  await page.waitForFunction(()=>window.NMS?.booted,null,{timeout:120000});
  await page.evaluate(()=>{
    NMS.setTimeFrozen();
    if(!NMS.land(0,0,'meadow'))throw Error('Could not land on the home planet');
  });
  await page.waitForFunction(()=>{
    const light=NMS._internals.scene.children.find(node=>node.isDirectionalLight&&node.castShadow);
    return light?.visible&&light.shadow.map?.depthTexture&&NMS.state==='walk';
  });
  await page.screenshot({path:`${out}/before.png`});
  await page.evaluate(()=>{
    const {scene,nav}=NMS._internals;
    const {Vector3,Matrix4}=NMS._THREE;
    const light=scene.children.find(node=>node.isDirectionalLight&&node.castShadow);
    const planet=NMS._planet(0);
    const fixed=planet.worldPositionToLocal(nav.pos).add(new Vector3(3,-2,4));
    const anchor=planet.localPositionToWorld(fixed);
    const matrix=new Matrix4(), relative=new Vector3(), uv=new Vector3(), old=new Vector3();
    const samples=[];
    const origin=nav.pos.clone();
    const read=()=>{
      const map=light.shadow.map;
      relative.subVectors(anchor,nav.pos);
      uv.copy(relative).applyMatrix4(light.shadow.matrix);
      // Remove only the projected center shift to reproduce the old grid.
      const camera=light.shadow.camera;
      matrix.makeOrthographic(-(camera.right-camera.left)/2,(camera.right-camera.left)/2,
        (camera.top-camera.bottom)/2,-(camera.top-camera.bottom)/2,camera.near,camera.far,camera.coordinateSystem);
      old.copy(relative).applyMatrix4(camera.matrixWorldInverse).applyMatrix4(matrix);
      samples.push({moved:nav.pos.distanceTo(origin),x:uv.x*map.width,y:uv.y*map.height,
        oldX:(old.x*.5+.5)*map.width,oldY:(old.y*.5+.5)*map.height,
        sequence:NMS._pipeline.frameState.sequence,width:map.width,height:map.height,visible:light.visible});
    };
    read();
    const sample=()=>{
      if(window.__surfaceShadowGridProbe.active) {
        if(samples.at(-1).sequence!==NMS._pipeline.frameState.sequence)read();
        requestAnimationFrame(sample);
      }
    };
    window.__surfaceShadowGridProbe={active:true,samples};
    requestAnimationFrame(sample);
  });
  await page.keyboard.down('w');
  try {await page.waitForFunction(()=>window.__surfaceShadowGridProbe.samples.at(-1).moved>2,null,{timeout:30000});}
  finally {await page.keyboard.up('w');}
  report.samples=await page.evaluate(()=>{
    window.__surfaceShadowGridProbe.active=false;
    const gl=NMS._renderer.getContext();
    if(gl.getError()!==gl.NO_ERROR||gl.isContextLost())throw Error('Surface shadow WebGL failure');
    return window.__surfaceShadowGridProbe.samples;
  });
  await page.screenshot({path:`${out}/after.png`});
  const first=report.samples[0], phase=value=>Math.abs(value-Math.round(value));
  const phaseError=keys=>Math.max(...report.samples.map(row=>Math.max(...keys.map(key=>phase(row[key]-first[key])))));
  report.snapped=phaseError(['x','y']);report.previous=phaseError(['oldX','oldY']);
  assert.ok(report.samples.length>=6&&report.samples.every(row=>row.visible&&row.width===first.width&&row.height===first.height));
  assert.ok(report.snapped<.001,`Unexpected subtexel phase drift ${report.snapped}`);
  assert.ok(report.previous>.15,'Old projection did not exercise a fractional texel shift');
  assert.deepEqual(report.errors,[]);
  report.passed=true;
  console.log(JSON.stringify({out,passed:true,samples:report.samples.length,drift:report.snapped,oldDrift:report.previous}));
} finally {
  await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));
  await browser?.close();
  server?.close();
}
