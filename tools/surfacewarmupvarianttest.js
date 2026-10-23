import assert from 'node:assert/strict';
import * as THREE from 'three';
import { withSurfaceWarmupVariant } from '../src/render-prewarm.js';
import { cloudSurfaceReceiverReady } from '../src/cloud/cloud-surface-shadow-pass.js';
import { bindSurfaceClouds, registerSurfaceCloudOwner, withCloudSurfacePreparation } from '../src/cloud/surface-clouds.js';
import { prepareSurfaceAtmosphere } from '../src/surface-atmosphere.js';
import { selectStellarOcclusionVariant, bindStellarOcclusion, stellarOcclusionUniforms } from '../src/stellar-occlusion.js';

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
    assert.equal(absent.version,version+2,'A shared material selects stellar topology and temporary SCREEN once each');absent.defines.ADDED=4;
  });
  assert.equal(absent.defines,defines);assert.equal(Object.hasOwn(defines,key),false);
  assert.deepEqual(defines,{KEEP:2,STELLAR_UNION_OCCLUSION:0,ADDED:4});assert.equal(absent.version,version+3);

  const existing=owned(published,{[key]:undefined,KEEP:5}),existingDefines=existing.defines;
  withSurfaceWarmupVariant(source(existing),()=>{existing.defines.KEEP=6;});
  assert.equal(existing.defines,existingDefines);assert.equal(Object.hasOwn(existing.defines,key),true);
  assert.equal(existing.defines[key],undefined);assert.equal(existing.defines.KEEP,6);
  withSurfaceWarmupVariant(source(existing),()=>{existing.defines={[key]:0,OTHER:8};});
  assert.equal(existing.defines,existingDefines);assert.deepEqual(existing.defines,{[key]:undefined,OTHER:8});

  const noDictionary=owned(published);delete noDictionary.defines;
  withSurfaceWarmupVariant(source(noDictionary),()=>assert.equal(noDictionary.defines[key],1));
  assert.equal(Object.hasOwn(noDictionary,'defines'),true);assert.deepEqual(noDictionary.defines,{STELLAR_UNION_OCCLUSION:0});
  noDictionary.defines=undefined;
  withSurfaceWarmupVariant(source(noDictionary),()=>{});
  assert.equal(Object.hasOwn(noDictionary,'defines'),true);assert.deepEqual(noDictionary.defines,{STELLAR_UNION_OCCLUSION:0});
  withSurfaceWarmupVariant(source(noDictionary),()=>{noDictionary.defines.NEW=2;});
  assert.deepEqual(noDictionary.defines,{STELLAR_UNION_OCCLUSION:0,NEW:2},'Current owner topology and unrelated defines survive temporary SCREEN restoration');

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

  const union='STELLAR_UNION_OCCLUSION';let topologyGroups=0;
  const blockers=count=>Array.from({length:count},(_value,i)=>({centerLocal:new THREE.Vector3(1e8,i*1e4,0),radius:1000}));
  const topologyBody=count=>Object.assign(body(),{R:6e6,group:new THREE.Group(),_invFrame:new THREE.Quaternion(),
    sunDirLocal:new THREE.Vector3(0,1,0),stellarOccluders:blockers(count)});
  const topologyMaterial=(planet,definitions)=>prepareSurfaceAtmosphere(owned(planet,definitions),planet);
  for(const count of [0,1,2]) {
    const planet=topologyBody(count),value=topologyMaterial(planet),definitions=value.defines;
    assert.equal(value.userData.surfaceMedium,undefined);assert.equal(Object.hasOwn(definitions,union),false);
    withSurfaceWarmupVariant(source(value),()=>{
      assert.equal(value.defines[union],Number(count>1));assert.equal(value.defines[key],1);
      assert.equal(value.userData.surfaceMedium,undefined,'Selecting the scalar topology must not allocate uniforms');
    });
    assert.equal(value.defines,definitions);assert.equal(Object.hasOwn(definitions,key),false);
    const uniforms=stellarOcclusionUniforms(),before=value.version;bindStellarOcclusion(uniforms,planet,value);
    assert.equal(value.defines[union],Number(count>1));assert.equal(value.version,before);
    assert.equal(uniforms.uLocalOccluderCount.value,count);topologyGroups++;
  }
  {
    const planet=topologyBody(2),value=topologyMaterial(planet,{[key]:1,KEEP:3}),definitions=value.defines;
    assert.equal(selectStellarOcclusionVariant(value,planet),true);const before=value.version;
    for(let i=0;i<4;i++)assert.equal(selectStellarOcclusionVariant(value,planet),false);
    bindStellarOcclusion(stellarOcclusionUniforms(),planet,value);assert.equal(value.version,before);
    withSurfaceWarmupVariant(source(value),()=>assert.equal(value.version,before));assert.equal(value.version,before);
    assert.equal(value.defines,definitions);topologyGroups++;
  }
  {
    const planet=topologyBody(2),value=topologyMaterial(planet);delete value.defines;
    withSurfaceWarmupVariant(source(value),()=>assert.equal(value.defines[union],1));
    assert.deepEqual(value.defines,{[union]:1});assert.equal(value.userData.surfaceMedium,undefined);topologyGroups++;
  }
  {
    const planet=topologyBody(0),value=topologyMaterial(planet,{[key]:1});withSurfaceWarmupVariant(source(value),()=>{});const before=value.version;
    planet.stellarOccluders=blockers(1);withSurfaceWarmupVariant(source(value),()=>{});assert.equal(value.version,before);
    planet.stellarOccluders=blockers(2);withSurfaceWarmupVariant(source(value),()=>{});assert.equal(value.version,before+1);
    planet.stellarOccluders=[];withSurfaceWarmupVariant(source(value),()=>{});assert.equal(value.version,before+2);topologyGroups++;
  }
  {
    const first=topologyBody(0),second=topologyBody(2),value=topologyMaterial(first,{[key]:1});
    withSurfaceWarmupVariant(source(value),()=>assert.equal(value.defines[union],0));registerSurfaceCloudOwner(value,second);
    withSurfaceWarmupVariant(source(value),()=>assert.equal(value.defines[union],1));topologyGroups++;
  }
  {
    const definitions={KEEP:7};Object.defineProperty(definitions,key,{value:0,writable:true,configurable:true,enumerable:false});
    const descriptor=Object.getOwnPropertyDescriptor(definitions,key),value=topologyMaterial(topologyBody(2),definitions);
    withSurfaceWarmupVariant(source(value),()=>{assert.equal(value.defines,definitions);assert.equal(value.defines[union],1);});
    assert.equal(value.defines,definitions);assert.deepEqual(Object.getOwnPropertyDescriptor(definitions,key),descriptor);
    assert.equal(definitions.KEEP,7);assert.equal(definitions[union],1);topologyGroups++;
  }
  {
    const planet=topologyBody(0),definitions={[key]:0},value=topologyMaterial(planet,definitions),fault=Error('topology draw fault');
    assert.throws(()=>withSurfaceWarmupVariant(source(value),()=>{
      planet.stellarOccluders=blockers(2);bindStellarOcclusion(stellarOcclusionUniforms(),planet,value);throw fault;
    }),error=>error===fault);
    assert.equal(value.defines,definitions);assert.equal(definitions[key],0);assert.equal(definitions[union],1);
    assert.deepEqual(preparing(),{enabled:1,screen:0});topologyGroups++;
  }
  {
    const planet=topologyBody(0),value=topologyMaterial(planet,{[key]:0});let complete;
    const pending=new Promise(resolve=>{complete=resolve;});assert.equal(withSurfaceWarmupVariant(source(value),()=>pending),pending);
    assert.equal(value.defines[key],0);planet.stellarOccluders=blockers(2);selectStellarOcclusionVariant(value,planet);
    const before=value.version;value.defines[key]=9;complete();await pending;
    assert.equal(value.defines[union],1);assert.equal(value.defines[key],9);assert.equal(value.version,before);
    const rejected=withSurfaceWarmupVariant(source(value),()=>Promise.reject(Error('later topology fault')));
    assert.equal(value.defines[key],9);await assert.rejects(rejected,/later topology fault/);assert.equal(value.defines[union],1);topologyGroups++;
  }
  {
    const planet=topologyBody(0),value=topologyMaterial(planet,{[key]:0});
    withSurfaceWarmupVariant(source(value),()=>{
      planet.stellarOccluders=blockers(2);withSurfaceWarmupVariant(source(value),()=>assert.equal(value.defines[union],1));
      assert.equal(value.defines[union],1);assert.deepEqual(preparing(),{enabled:0,screen:1});
    });
    assert.equal(value.defines[key],0);assert.equal(value.defines[union],1);assert.deepEqual(preparing(),{enabled:1,screen:0});topologyGroups++;
  }
  {
    const value=topologyMaterial(topologyBody(2),{[key]:1}),before=value.version;
    withSurfaceWarmupVariant(source(value,value),()=>assert.equal(value.version,before+1));assert.equal(value.version,before+1);topologyGroups++;
  }
  {
    const planet=topologyBody(2),value=topologyMaterial(planet),definitions=value.defines;
    assert.equal(selectStellarOcclusionVariant(null,planet),false);bindStellarOcclusion(null,planet,value);
    assert.equal(value.defines,definitions);assert.equal(Object.hasOwn(definitions,union),false);assert.equal(value.userData.surfaceMedium,undefined);topologyGroups++;
  }
  assert.equal(topologyGroups,13);
  console.log('PASS: surface warm-up receiver/SCREEN restoration and 13 fresh stellar-topology groups; current owner, lazy uniforms, stable versions, descriptors, callbacks and Promise/nested ownership; no GPU.');
} finally {
  geometry.dispose();for(const resource of resources)resource.dispose();
}
