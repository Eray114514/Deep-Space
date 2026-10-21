import assert from 'node:assert/strict';
import * as THREE from 'three';
import { withSurfaceWarmupVariant } from '../src/render-prewarm.js';
import { cloudSurfaceReceiverReady } from '../src/cloud/cloud-surface-shadow-pass.js';
import { bindSurfaceClouds, registerSurfaceCloudOwner, withCloudSurfacePreparation } from '../src/cloud/surface-clouds.js';

const key='SURFACE_CLOUD_SCREEN';
const geometry=new THREE.BoxGeometry();
const resources=[];
function material(owner,defines={}) {
  const result=new THREE.MeshStandardMaterial();result.defines=defines;resources.push(result);
  if(owner)registerSurfaceCloudOwner(result,owner);
  return result;
}
function body({production=true,published=true,forecast=false,visible=true}={}) {
  const species=new THREE.DataArrayTexture(new Float32Array(4),1,1,1);
  resources.push(species);
  const mat=new THREE.ShaderMaterial({defines:{PRODUCTION_CLOUD_MEDIUM:Number(production)},uniforms:{
    uBandsReady:{value:Number(published)},uSpeciesMap:{value:species},uNoise3:{value:{}},uWeatherMapHi:{value:{}},
  }});
  resources.push(mat);
  return {volCloudMesh:new THREE.Mesh(geometry,mat),volCloudMat:mat,cloudSpeciesTex:species,
    cloudVisualEnabled:visible,weatherStream:{ready:forecast}};
}
function source(...materials) {
  const group=new THREE.Group();
  for(const value of materials)group.add(new THREE.Mesh(geometry,value));
  return group;
}
// Observe the actual binder's global preparation branch, without GL or private
// state access. A body without a screen cache leaves only that branch eligible.
function preparing() {
  const uniforms={uSurfaceCloudEnabled:{value:-1},uCloudForeignReceiver:{value:-1},uCloudReceiverId:{value:-1},
    uCloudSkyEnv:{value:null},uCloudSkyReady:{value:0}};
  const target=new THREE.MeshStandardMaterial();
  bindSurfaceClouds(uniforms,{},null,null,target);
  const result={enabled:uniforms.uSurfaceCloudEnabled.value,screen:target.defines[key]};
  target.dispose();return result;
}
function selected(group,screen) {
  const result=withSurfaceWarmupVariant(group,()=>{
    group.traverse(object=>{
      if(object.isMesh)for(const m of [object.material].flat()) {
        if(m.userData.testOwned)assert.equal(m.defines[key],screen);
      }
    });
    assert.deepEqual(preparing(),{enabled:screen?0:1,screen});return 17;
  });
  assert.equal(result,17);assert.deepEqual(preparing(),{enabled:1,screen:0});
}
function owned(owner,defines) {const m=material(owner,defines);m.userData.testOwned=true;return m;}

try {
  const clear=owned({}),legacy=owned(body({production:false})),pending=owned(body({published:false}));
  const published=body({forecast:false}),ready=owned(published);
  assert.equal(cloudSurfaceReceiverReady(published),true,'A published production field does not wait for the forecast worker');
  selected(source(clear,legacy,pending),0);
  selected(source(ready),1);
  selected(source(clear,legacy,pending,ready),1);
  for(const owner of [body({visible:false}),body({published:false}),body({production:false})]) {
    assert.equal(cloudSurfaceReceiverReady(owner),false);selected(source(owned(owner)),0);
  }
  const wrongBinding=body();wrongBinding.volCloudMat.uniforms.uSpeciesMap.value={};
  assert.equal(cloudSurfaceReceiverReady(wrongBinding),false);selected(source(owned(wrongBinding)),0);
  const noNoise=body();noNoise.volCloudMat.uniforms.uNoise3.value=null;
  assert.equal(cloudSurfaceReceiverReady(noNoise),false);selected(source(owned(noNoise)),0);

  const unowned=material(null,{[key]:7,UNRELATED:3}),unownedDefines=unowned.defines,unownedVersion=unowned.version;
  withSurfaceWarmupVariant(source(ready,unowned),()=>assert.equal(unowned.defines[key],7));
  assert.equal(unowned.defines,unownedDefines);assert.equal(unowned.version,unownedVersion);
  const lineMaterial=owned(published,{[key]:9}),line=new THREE.Line(geometry,lineMaterial);
  withSurfaceWarmupVariant(line,()=>assert.equal(lineMaterial.defines[key],9));

  const absent=owned(published,{KEEP:2}),defines=absent.defines,version=absent.version;
  const shared=source([absent,absent],absent);
  shared.children[0].visible=false; // compile traverses hidden representatives too.
  withSurfaceWarmupVariant(shared,()=>{
    assert.equal(absent.defines,defines);assert.equal(absent.defines[key],1);
    assert.equal(absent.version,version+1,'A shared material is selected once');absent.defines.ADDED=4;
  });
  assert.equal(absent.defines,defines);assert.equal(Object.hasOwn(defines,key),false);
  assert.deepEqual(defines,{KEEP:2,ADDED:4});assert.equal(absent.version,version+2);

  const existing=owned(published,{[key]:undefined,KEEP:5}),existingDefines=existing.defines;
  withSurfaceWarmupVariant(source(existing),()=>{existing.defines.KEEP=6;});
  assert.equal(existing.defines,existingDefines);assert.equal(Object.hasOwn(existing.defines,key),true);
  assert.equal(existing.defines[key],undefined);assert.equal(existing.defines.KEEP,6);
  withSurfaceWarmupVariant(source(existing),()=>{existing.defines={[key]:0,OTHER:8};});
  assert.equal(existing.defines,existingDefines);assert.deepEqual(existing.defines,{[key]:undefined,OTHER:8});

  const noDictionary=owned(published);delete noDictionary.defines;
  withSurfaceWarmupVariant(source(noDictionary),()=>assert.equal(noDictionary.defines[key],1));
  assert.equal(Object.hasOwn(noDictionary,'defines'),false);
  noDictionary.defines=undefined;
  withSurfaceWarmupVariant(source(noDictionary),()=>{});
  assert.equal(Object.hasOwn(noDictionary,'defines'),true);assert.equal(noDictionary.defines,undefined);
  withSurfaceWarmupVariant(source(noDictionary),()=>{noDictionary.defines.NEW=2;});
  assert.deepEqual(noDictionary.defines,{NEW:2},'Unrelated new defines must survive a temporary dictionary');

  assert.throws(()=>withSurfaceWarmupVariant(source(absent),()=>{
    assert.equal(absent.defines[key],1);assert.deepEqual(preparing(),{enabled:0,screen:1});throw Error('draw fault');
  }),/draw fault/);
  assert.equal(absent.defines,defines);assert.equal(Object.hasOwn(defines,key),false);
  assert.deepEqual(preparing(),{enabled:1,screen:0});

  let complete;
  const pendingWork=new Promise(resolve=>{complete=resolve;});
  const returned=withSurfaceWarmupVariant(source(absent),()=>pendingWork);
  assert.equal(returned,pendingWork);assert.equal(Object.hasOwn(defines,key),false);
  assert.deepEqual(preparing(),{enabled:1,screen:0});
  defines[key]=7;complete('done');assert.equal(await returned,'done');
  assert.equal(defines[key],7,'Promise settlement cannot restore an obsolete material snapshot');delete defines[key];
  const failure=withSurfaceWarmupVariant(source(absent),()=>Promise.reject(Error('later fault')));
  assert.equal(Object.hasOwn(defines,key),false);assert.deepEqual(preparing(),{enabled:1,screen:0});
  await assert.rejects(failure,/later fault/);

  withSurfaceWarmupVariant(source(absent),()=>{
    assert.equal(absent.defines[key],1);
    withCloudSurfacePreparation(false,()=>assert.deepEqual(preparing(),{enabled:1,screen:0}));
    assert.deepEqual(preparing(),{enabled:0,screen:1});
    assert.throws(()=>withCloudSurfacePreparation(false,()=>{throw Error('inner fault');}),/inner fault/);
    assert.deepEqual(preparing(),{enabled:0,screen:1});
    withSurfaceWarmupVariant(source(absent),()=>{
      assert.equal(absent.defines[key],1);assert.deepEqual(preparing(),{enabled:0,screen:1});
    });
    withSurfaceWarmupVariant(source(clear),()=>{
      assert.equal(clear.defines[key],0);assert.deepEqual(preparing(),{enabled:1,screen:0});
    });
    assert.equal(absent.defines[key],1);assert.deepEqual(preparing(),{enabled:0,screen:1});
  });
  assert.equal(Object.hasOwn(defines,key),false);assert.deepEqual(preparing(),{enabled:1,screen:0});

  const replaced=owned(published,{[key]:0,BEFORE:1}),originalDictionary=replaced.defines;
  withSurfaceWarmupVariant(source(replaced),()=>{
    const outerDictionary={[key]:1,OUTER:2};replaced.defines=outerDictionary;
    assert.throws(()=>withSurfaceWarmupVariant(source(replaced),()=>{
      replaced.defines={[key]:0,INNER:3};throw Error('nested replacement fault');
    }),/nested replacement fault/);
    assert.equal(replaced.defines,outerDictionary);assert.deepEqual(replaced.defines,{[key]:1,INNER:3});
    assert.deepEqual(preparing(),{enabled:0,screen:1});
  });
  assert.equal(replaced.defines,originalDictionary);assert.deepEqual(replaced.defines,{[key]:0,INNER:3});
  assert.deepEqual(preparing(),{enabled:1,screen:0});

  console.log('PASS: surface warm-up shares production receiver eligibility; registered/shared materials, SCREEN0/1, define identity, unrelated edits, exceptions, Promise and nested scopes restore synchronously; no GPU.');
} finally {
  geometry.dispose();for(const resource of resources)resource.dispose();
}
