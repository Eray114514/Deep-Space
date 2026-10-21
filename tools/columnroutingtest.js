// Run the production route independently of WebGL. Bank snapshot/source
// scheduling is tested by columnbankreadinesstest.js; this checks selection.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { minimumCloudRayCone } from '../src/cloud/cloud-footprint.js';
import { setCloudFarCacheEnabled } from '../src/cloud/cloud-column-bank.js';
import { originalCloudColumnRoutingBody } from './fixtures/cloud-column-routing-original.js';

const originalBodySha256=createHash('sha256').update(originalCloudColumnRoutingBody).digest('hex');
assert.equal(originalBodySha256,'004ff7f133e42c780dddfbc65b3b91cd7c283dbc48b5f271f58784ea0155d7e4',
  'Keep the original inline block exact; the regression does not require Git history');
const source=(await readFile('src/volumetric-pass-webgl.js','utf8')).replace(/\r\n/g,'\n');
const signature='  updateCloudColumns(renderer) {';
assert.equal(source.split(signature).length-1,1,'Extract exactly one production route');
const start=source.indexOf(signature),end=source.indexOf('\n  }',start);
assert.ok(end>start);const method=source.slice(start,end+4);
const samplerNames=['uOpticalColumns','uOpticalColumnsNext','uColumnHeights','uColumnHeightsNext'];
const fixtures=[];
function fixture(original=false) {
  const banks=[];
  class FakeBank {
    constructor(planet) {
      this.planet=planet;this.disposed=false;this.disposals=0;this.updates=0;this.sources=[];
      this.textures=samplerNames.map(name=>({name,bank:this}));banks.push(this);
    }
    unbind() {
      const u=this.planet.volCloudMat.uniforms;
      u.uColumnsReady.value=0;u.uColumnsJointReady.value=0;
      for(const name of samplerNames)u[name].value=u.uWeatherMap.value;
    }
    update(renderer) {
      assert.equal(renderer,null);assert.equal(this.disposed,false);this.updates++;
      this.unbind();const stream=this.planet.weatherStream;this.sources.push(stream);
      // A ready worker pair can still have unfinished column maps. Production
      // bank scheduling/identity is intentionally not reimplemented here.
      if(stream?.ready && !stream.disposed && stream.columnsComplete) {
        const u=this.planet.volCloudMat.uniforms;
        u.uColumnsReady.value=1;u.uColumnsJointReady.value=1;
        samplerNames.forEach((name,i)=>{u[name].value=this.textures[i];});
      }
    }
    dispose() {
      if(this.disposed)return;this.unbind();this.disposed=true;this.disposals++;
      if(this.planet.cloudColumnMap===this)this.planet.cloudColumnMap=null;
      // Preserve the OLD disposal contract for both routes. Resetting CACHE1
      // here would mask the original active-route defect. Real bank.dispose's
      // new define reset is covered separately by columnbankreadinesstest.js.
    }
  }
  const dependencies={CloudColumnBank:FakeBank,minimumCloudRayCone,setCloudFarCacheEnabled};
  const update=original
    ?vm.runInNewContext(`(function(renderer){const planet=this.activePlanet;\n${originalCloudColumnRoutingBody}\n})`,dependencies)
    :vm.runInNewContext(`({${method}}).updateCloudColumns`,dependencies);
  const projection=new Array(16).fill(0);projection[0]=projection[5]=1;
  const pass={activePlanet:null,columnMaps:new Map(),width:64,height:64,
    camera:{projectionMatrix:{elements:projection}}};
  const cone=minimumCloudRayCone(projection,pass.width,pass.height),boundary=2400/cone;
  assert.equal(boundary,240150);assert.equal(boundary*cone,2400);
  const bodies=[];
  const f={pass,banks,boundary,body({distance=boundary+1000,ready=true,columnsComplete=true}={}) {
    const far={defines:{CLOUD_FAR_VIEW:1,CLOUD_FAR_CACHE:0},version:0,
      set needsUpdate(value){if(value===true)this.version++;}};
    const u={uColumnsReady:{value:0},uColumnsJointReady:{value:0},uWeatherMap:{value:{}},uEngage:{value:1}};
    for(const name of samplerNames)u[name]={value:u.uWeatherMap.value};
    const near={defines:{CLOUD_FAR_VIEW:0},uniforms:u};
    const p={distance,volCloudMat:near,volCloudFarMat:far,volCloudBand:{rOut:1024},
      weatherField:{synoptic:true},weatherStream:{ready,disposed:false,columnsComplete},
      volCloudMesh:{visible:true,material:near}};
    u.uCameraLocal={value:{length:()=>p.volCloudBand.rOut+p.distance}};
    bodies.push(p);return p;
  },tick(p=pass.activePlanet) {
    pass.activePlanet=p;update.call(pass,null);
    for(const body of bodies) {
      assert.equal(body.volCloudMesh.visible,true,'Routing must not hide physical clouds');
      assert.equal(body.volCloudMat.uniforms.uEngage.value,1,'Routing must not zero physical cloud engagement');
      assert.ok([body.volCloudMat,body.volCloudFarMat].includes(body.volCloudMesh.material));
    }
  },unbound(p) {
    const u=p.volCloudMat.uniforms;assert.equal(u.uColumnsReady.value,0);assert.equal(u.uColumnsJointReady.value,0);
    assert.ok(samplerNames.every(name=>u[name].value===u.uWeatherMap.value));
  },safe(p) {
    if(p.volCloudFarMat.defines.CLOUD_FAR_CACHE===1)
      assert.equal(p.volCloudMat.uniforms.uColumnsReady.value,1,'CACHE1 cannot sample unbound weather fallbacks');
  },close() {
    for(const bank of banks)bank.dispose();
  }};
  fixtures.push(f);return f;
}

try {
  // A positive control proves the new FakeBank disposal does not accidentally
  // repair the frozen route: the old branch drops its bank but keeps CACHE1.
  const old=fixture(true),oldBody=old.body();old.tick(oldBody);
  assert.equal(oldBody.volCloudFarMat.defines.CLOUD_FAR_CACHE,1);
  const retired=old.pass.columnMaps.get(oldBody);oldBody.weatherStream.ready=false;old.tick();
  assert.equal(retired.disposed,true);old.unbound(oldBody);
  assert.equal(oldBody.volCloudFarMat.defines.CLOUD_FAR_CACHE,1);
  assert.throws(()=>old.safe(oldBody),/CACHE1 cannot sample unbound weather fallbacks/);

  const pending=fixture(),cold=pending.body({ready:false,columnsComplete:false});pending.tick(cold);
  const earlyBank=pending.pass.columnMaps.get(cold);assert.ok(earlyBank);
  assert.equal(earlyBank.updates,1);pending.unbound(cold);pending.safe(cold);
  assert.equal(cold.volCloudFarMat.version,0,'Initial pending production keeps the uncached physical family');
  cold.weatherStream.ready=true;cold.weatherStream.columnsComplete=true;pending.tick();
  assert.equal(pending.pass.columnMaps.get(cold),earlyBank);assert.equal(pending.banks.length,1);pending.safe(cold);

  const f=fixture(),p=f.body();f.tick(p);const bank=f.pass.columnMaps.get(p);
  assert.equal(p.volCloudMesh.material,p.volCloudFarMat);assert.equal(p.volCloudFarMat.defines.CLOUD_FAR_CACHE,1);
  const version=p.volCloudFarMat.version;
  for(let i=0;i<3;i++)f.tick();
  assert.equal(p.volCloudFarMat.version,version,'Stable readiness must not toggle the shader every frame');
  p.weatherStream.ready=false;p.weatherStream.columnsComplete=false;f.tick();f.unbound(p);f.safe(p);
  assert.equal(f.pass.columnMaps.get(p),bank);assert.equal(bank.disposed,false);
  assert.equal(p.volCloudFarMat.defines.CLOUD_FAR_CACHE,0);assert.equal(p.volCloudFarMat.version,version+1);
  f.tick();assert.equal(p.volCloudFarMat.version,version+1);
  p.weatherStream.ready=true;f.tick();f.unbound(p);f.safe(p);
  assert.equal(p.volCloudFarMat.defines.CLOUD_FAR_CACHE,0,'Worker readiness alone cannot expose incomplete columns');
  p.weatherStream.columnsComplete=true;f.tick();f.safe(p);
  assert.equal(f.pass.columnMaps.get(p),bank);assert.equal(p.volCloudFarMat.defines.CLOUD_FAR_CACHE,1);
  assert.equal(f.banks.length,1);

  // A replacement stream stays on the same bank so the bank can invalidate
  // its own per-source maps. A missing/disposed stream retires that bank.
  p.weatherStream={ready:false,disposed:false,columnsComplete:false};f.tick();f.unbound(p);f.safe(p);
  assert.equal(bank.sources.at(-1),p.weatherStream);assert.equal(f.pass.columnMaps.get(p),bank);
  p.weatherStream.ready=true;p.weatherStream.columnsComplete=true;f.tick();f.safe(p);
  for(const sourceState of ['missing','disposed']) {
    const g=fixture(),body=g.body();g.tick(body);const previous=g.pass.columnMaps.get(body);
    if(sourceState==='missing')body.weatherStream=null;else body.weatherStream.disposed=true;
    g.tick();g.unbound(body);g.safe(body);
    assert.equal(previous.disposals,1);assert.equal(g.pass.columnMaps.has(body),false);
    assert.equal(body.volCloudFarMat.defines.CLOUD_FAR_CACHE,0);
    assert.equal(body.volCloudMesh.material,body.volCloudFarMat);
    const changed=body.volCloudFarMat.version;g.tick();assert.equal(body.volCloudFarMat.version,changed);
  }

  // Near/far (>200 km) and whole-screen unresolved (>2400 m) are independent
  // strict gates. Exercise the actual minimum-cone helper and a resize.
  const h=fixture(),body=h.body();h.tick(body);const farBank=h.pass.columnMaps.get(body);
  body.distance=200000;h.tick();h.safe(body);
  assert.equal(body.volCloudMesh.material,body.volCloudMat);assert.equal(farBank.disposed,true);
  assert.equal(body.volCloudFarMat.defines.CLOUD_FAR_CACHE,0);assert.equal(h.pass.columnMaps.has(body),false);
  body.distance=200001;h.tick();assert.equal(body.volCloudMesh.material,body.volCloudFarMat);
  assert.equal(body.volCloudFarMat.defines.CLOUD_FAR_CACHE,0);
  const resumed=h.pass.columnMaps.get(body);
  for(const [distance,expected] of [[h.boundary-1,0],[h.boundary,0],[h.boundary+1,1]]) {
    body.distance=distance;h.tick();h.safe(body);assert.equal(body.volCloudFarMat.defines.CLOUD_FAR_CACHE,expected);
    assert.equal(h.pass.columnMaps.get(body),resumed);
  }
  h.pass.width=128;h.pass.height=128;h.tick();h.safe(body);
  assert.equal(body.volCloudFarMat.defines.CLOUD_FAR_CACHE,0,'A finer pixel cone can resolve the same world footprint');
  h.pass.width=64;h.pass.height=64;h.tick();assert.equal(body.volCloudFarMat.defines.CLOUD_FAR_CACHE,1);
  body.weatherField.synoptic=false;h.tick();h.unbound(body);h.safe(body);
  assert.equal(resumed.disposed,true);assert.equal(body.volCloudFarMat.defines.CLOUD_FAR_CACHE,0);

  // The pass retains at most two banks and retires a non-active body. The
  // fading body's macro reset is the real Bank.dispose contract tested in
  // columnbankreadinesstest; this fake intentionally keeps the old contract.
  const m=fixture(),a=m.body(),b=m.body(),c=m.body();
  m.tick(a);const first=m.pass.columnMaps.get(a);m.tick(b);const second=m.pass.columnMaps.get(b);
  assert.equal(m.pass.columnMaps.size,2);m.tick(c);
  assert.equal(m.pass.columnMaps.size,2);assert.equal(first.disposals,1);m.unbound(a);
  assert.equal(m.pass.columnMaps.has(a),false);assert.equal(m.pass.columnMaps.get(b),second);
  assert.equal(second.disposed,false);assert.equal(m.pass.columnMaps.has(c),true);m.safe(c);
  const count=m.banks.length;m.tick(c);assert.equal(m.banks.length,count);
  m.tick(null);assert.equal(m.pass.columnMaps.size,2,'A null active body is a no-op; delayed release has its own owner');
} finally {
  for(const f of fixtures)f.close();
}
console.log(JSON.stringify({passed:true,source:'VolumetricPass.updateCloudColumns',
  original:'2272e923 inline fixture reproduces stale CACHE1 after lost readiness',
  originalBodySha256,
  scope:'CPU route regression only; real bank revision/snapshot scheduling and retirement macro reset are separate CPU tests; no GPU or cold/performance claim'}));
