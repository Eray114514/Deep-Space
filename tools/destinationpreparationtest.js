// The real destination compiler view/adapter, with a CPU renderer capturing
// material and light walks. This does not compile GLSL, upload buffers or prove
// real-scene lighting, native HDR equivalence or cold-performance acceptance.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import * as THREE from 'three';
import {compileDestinationVariant} from '../src/destination-preparation.js';
import {compileRenderVariant,createCompileCamera} from '../src/render-prewarm.js';

const files=['src/destination-preparation.js','src/program-preparation.js','src/render-prewarm.js','tools/destinationpreparationtest.js'];
const frozen=new Map(await Promise.all(files.map(async path=>[path,await readFile(path)])));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const out=`test-results/destination-preparation/${new Date().toISOString().replace(/[:.]/g,'-')}`;
await mkdir(out,{recursive:true});
for(const [path,bytes] of frozen)await writeFile(`${out}/${path.split('/').at(-1)}`,bytes);
const cases=[],fixtures=[];
const microtasks=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
const caught=work=>{let threw=false,error;try {work();} catch(value){threw=true;error=value;}assert.equal(threw,true);return error;};
async function test(name,work) {
  const start=fixtures.length;
  try {await work();cases.push({name,passed:true});}
  catch(error){cases.push({name,passed:false,error:String(error),stack:error?.stack});}
  finally {for(const f of fixtures.slice(start))f.dispose();await microtasks();}
}
const renderable=object=>object.isMesh||object.isPoints||object.isLine||object.isSprite;
const names=objects=>objects.map(object=>object.name).sort();
function fixture({separateInterior=true,stars=2,shadows=false,programs=false}={}) {
  const objects=[],geometries=new Set(),materials=new Set(),clones=[],records=[];
  const controller=new AbortController(),canvas=new EventTarget();
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(64,1.7,.2,1e8);
  scene.name='live-scene';scene.environment=new THREE.Texture();scene.environmentIntensity=.37;
  scene.environmentRotation.set(.17,.28,.39);scene.fog=new THREE.FogExp2(0x334455,.008);
  camera.layers.set(7);camera.position.set(11,12,13);camera.quaternion.setFromAxisAngle(new THREE.Vector3(0,1,0),.7);
  camera.matrixWorldNeedsUpdate=true;
  const add=(object,name,layer=0)=>{object.name=name;object.layers.set(layer);objects.push(object);return object;};
  const group=(name,layer=0)=>add(new THREE.Group(),name,layer);
  const shared=new THREE.MeshStandardMaterial({roughness:.5});materials.add(shared);
  const geometry=new THREE.BoxGeometry();geometries.add(geometry);
  const mesh=(name,layer=0,{instanced=false,count=1,empty=false,material=shared}={})=>{
    const geom=empty?new THREE.BufferGeometry():geometry;geometries.add(geom);for(const value of [material].flat())materials.add(value);
    const object=instanced?new THREE.InstancedMesh(geom,material,Math.max(count,1)):new THREE.Mesh(geom,material);
    if(instanced)object.count=count;
    return add(object,name,layer);
  };
  let unexpectedDisposals=0,ownershipEvents=0,cloneShadowDisposals=0,recording=true;
  const light=(name,layer=0,{shadow=false,kind='directional'}={})=>{
    const object=add(kind==='ambient'?new THREE.AmbientLight():kind==='point'?new THREE.PointLight()
      :kind==='hemisphere'?new THREE.HemisphereLight():new THREE.DirectionalLight(),name,layer);
    object.castShadow=shadow;object.position.set(3,4,5);
    if(object.target){object.target.name=`${name}-target`;objects.push(object.target);}
    const clone=object.clone;
    object.clone=function(...args){
      const copy=clone.apply(this,args);clones.push(copy);
      if(copy.shadow){const dispose=copy.shadow.dispose;copy.shadow.dispose=function(){cloneShadowDisposals++;return dispose.call(this);};}
      return copy;
    };
    if(object.shadow){const dispose=object.shadow.dispose;object.shadow.dispose=function(){if(recording)unexpectedDisposals++;return dispose.call(this);};}
    return object;
  };
  const persistent=mesh('persistent-hidden');persistent.visible=false;
  const persistentZero=mesh('persistent-zero',0,{instanced:true,count:0});persistentZero.visible=false;
  const persistentEmpty=mesh('persistent-empty',0,{empty:true});
  const persistentOther=mesh('persistent-volume',2);
  const persistentLayers=mesh('persistent-world-plus-volume',2);persistentLayers.layers.enable(0);
  const pointsMaterial=new THREE.PointsMaterial();materials.add(pointsMaterial);
  const lineMaterial=new THREE.LineBasicMaterial();materials.add(lineMaterial);
  const spriteMaterial=new THREE.SpriteMaterial();materials.add(spriteMaterial);
  const points=add(new THREE.Points(geometry,pointsMaterial),'persistent-points');
  const line=add(new THREE.Line(geometry,lineMaterial),'persistent-line');
  const sprite=add(new THREE.Sprite(spriteMaterial),'persistent-sprite');
  const globalFrame=group('global-frame');globalFrame.position.set(100,200,300);
  const ambient=light('global-ambient',0,{kind:'ambient'}),globalSun=light('global-sun');globalFrame.add(ambient,globalSun,globalSun.target);
  const hiddenFrame=group('hidden-global-frame');hiddenFrame.visible=false;const hiddenGlobal=light('hidden-global');hiddenFrame.add(hiddenGlobal);
  const otherLayerLight=light('volume-light',2),shadowLight=light('main-shadow',0,{shadow:true});shadowLight.visible=false;shadowLight.intensity=7;
  const universeRoot=group('universe-root'),sourceBody=group('source-body'),targetGroup=group('destination-body'),otherBody=group('unselected-destination-body');
  const sourceMesh=mesh('source-world'),sourceLight=light('source-star'),otherMesh=mesh('unselected-world');
  sourceBody.add(sourceMesh,sourceLight);otherBody.add(otherMesh);universeRoot.add(sourceBody,targetGroup,otherBody);
  targetGroup.visible=false;targetGroup.position.set(700,800,900);targetGroup.scale.setScalar(2);
  const bodyOpaque=mesh('body-opaque'),bodyInstanced=mesh('body-instanced',0,{instanced:true}),bodyZero=mesh('body-zero',0,{instanced:true,count:0}),
    bodyEmpty=mesh('body-empty',0,{empty:true}),bodyVolume=mesh('body-volume',2);
  bodyOpaque.visible=false;bodyInstanced.frustumCulled=false;bodyOpaque.castShadow=true;bodyOpaque.receiveShadow=true;
  bodyOpaque.userData.lodMorph=.35;bodyOpaque.onBeforeRender=()=>{};bodyOpaque.onBeforeShadow=()=>{};
  const depth=new THREE.MeshDepthMaterial(),distance=new THREE.MeshDistanceMaterial();materials.add(depth);materials.add(distance);
  bodyOpaque.customDepthMaterial=depth;bodyOpaque.customDistanceMaterial=distance;
  const arrayMaterial=[shared,new THREE.MeshStandardMaterial()];materials.add(arrayMaterial[1]);const bodyArray=mesh('body-array',0,{material:arrayMaterial});
  const skinned=add(new THREE.SkinnedMesh(geometry,shared),'body-skinned');
  targetGroup.add(bodyOpaque,bodyInstanced,bodyZero,bodyEmpty,bodyVolume,bodyArray,skinned);
  const starViews=[];
  for(let i=0;i<stars;i++) {
    const root=group(`destination-star-${i}`),surface=mesh(`star-surface-${i}`),volume=mesh(`star-volume-${i}`,2),sun=light(`destination-light-${i}`,i?2:0);
    root.visible=false;sun.visible=false;sun.intensity=i+2;root.add(surface,volume);universeRoot.add(root,sun,sun.target);
    starViews.push({group:root,light:sun,surface,volume});
  }
  const siteRoot=group('free-site'),freeSite=mesh('free-site-mesh'),siteVolume=mesh('free-site-volume',2);
  siteRoot.visible=false;siteRoot.add(freeSite,siteVolume);universeRoot.add(siteRoot);
  const attachedRoot=group('attached-other-site'),attachedSite=mesh('attached-other-site-mesh');attachedRoot.add(attachedSite);universeRoot.add(attachedRoot);
  const shipRoot=group('ship-root'),exterior=group('ship-exterior'),interior=group('ship-interior');
  const hull=mesh('ship-hull',3),glass=mesh('ship-glass',3),shipZero=mesh('ship-zero',3,{instanced:true,count:0}),cabin=mesh('ship-cabin',6);
  hull.visible=false;exterior.add(hull,glass,shipZero);interior.add(cabin);
  const cabinLight=light('cabin-light',6),hiddenCabinLight=light('hidden-cabin-light',6);hiddenCabinLight.visible=false;
  const hiddenCabinGroup=group('hidden-cabin-group');hiddenCabinGroup.visible=false;const ancestorHiddenLight=light('ancestor-hidden-cabin-light',6);hiddenCabinGroup.add(ancestorHiddenLight);
  interior.add(cabinLight,hiddenCabinLight,hiddenCabinGroup);shipRoot.add(exterior,interior);
  const excludedRoot=group('excluded-root'),excludedMesh=mesh('excluded-mesh'),excludedLight=light('excluded-light');excludedRoot.add(excludedMesh,excludedLight);
  scene.add(persistent,persistentZero,persistentEmpty,persistentOther,persistentLayers,points,line,sprite,globalFrame,hiddenFrame,otherLayerLight,
    shadowLight,shadowLight.target,universeRoot,shipRoot,excludedRoot);
  const ship={group:shipRoot,separateInterior,int:{group:interior}},body={group:targetGroup};
  const destination={starViews,artificialSites:[{group:siteRoot,parentBody:null},{group:attachedRoot,parentBody:otherBody}]};
  const initialTarget={name:'caller-cube'},hdr={name:'live-hdr-target'};let target=initialTarget,face=4,mip=2,ready=false,compileCalls=0;
  let compileFailed=false,compileError,bindFailed=false,bindError,restoreFailed=false,restoreError;
  const properties=new Map(),program={program:{},isReady:()=>ready};
  const renderer={domElement:canvas,getContext:()=>({isContextLost:()=>false}),properties:{get:material=>properties.get(material),has:material=>properties.has(material)},
    getRenderTarget:()=>target,getActiveCubeFace:()=>face,getActiveMipmapLevel:()=>mip,
    setRenderTarget(value,nextFace=0,nextMip=0){
      target=value;face=nextFace;mip=nextMip;
      if(value===hdr&&bindFailed)throw bindError;
      if(value===initialTarget&&restoreFailed)throw restoreError;
    },
    compile(source,compileCamera,lighting){
      compileCalls++;const selected=[],sourceLights=[],lights=[],lightingRenderables=[];
      source.traverse(object=>{if(renderable(object))selected.push(object);if(object.isLight)sourceLights.push(object);});
      source.traverseVisible(object=>{if(object.isLight)sourceLights.push(object);});
      lighting.traverseVisible(object=>{if(object.isLight)lights.push(object);if(renderable(object))lightingRenderables.push(object);});
      const record={source,compileCamera,lighting,selected,sourceLights,lights,lightingRenderables,target,face,mip,
        lightStates:lights.map(object=>({name:object.name,position:object.position.toArray(),mask:object.layers.mask,visible:object.visible,
          intensity:object.intensity,castShadow:object.castShadow})),beforeCleanupState:snapshot()};records.push(record);
      if(compileFailed)throw compileError;
      if(!programs)return new Set();
      const used=new Set(selected.flatMap(object=>[object.material].flat()));
      for(const material of used)properties.set(material,{programs:new Map([['actual-family',program]]),currentProgram:program});
      return used;
    }};
  for(const object of objects) {
    object.addEventListener('added',()=>{if(recording)ownershipEvents++;});object.addEventListener('removed',()=>{if(recording)ownershipEvents++;});
    object.updateMatrixWorld=()=>assert.fail(`Live matrix update: ${object.name}`);
    object.updateWorldMatrix=()=>assert.fail(`Live world matrix update: ${object.name}`);
    if(renderable(object))object.clone=()=>assert.fail(`Borrowed renderable cloned: ${object.name}`);
  }
  for(const resource of [...geometries,...materials])resource.addEventListener('dispose',()=>{if(recording)unexpectedDisposals++;});
  let prunedReads=0;
  for(const object of [universeRoot,excludedRoot])Object.defineProperty(object,'children',{get(){prunedReads++;throw Error(`Pruned subtree visited: ${object.name}`);}});
  function snapshot() {
    return objects.map(object=>({object,parent:object.parent,visible:object.visible,mask:object.layers.mask,frustumCulled:object.frustumCulled,
      position:object.position.toArray(),quaternion:object.quaternion.toArray(),scale:object.scale.toArray(),
      matrix:object.matrix.toArray(),matrixWorld:object.matrixWorld.toArray(),matrixWorldNeedsUpdate:object.matrixWorldNeedsUpdate,
      matrixAutoUpdate:object.matrixAutoUpdate,matrixWorldAutoUpdate:object.matrixWorldAutoUpdate,geometry:object.geometry,material:object.material,
      instance:object.instanceMatrix?.array,instanceBytes:object.instanceMatrix?Array.from(object.instanceMatrix.array):null,
      instanceVersion:object.instanceMatrix?.version,count:object.count,onBeforeRender:object.onBeforeRender,onBeforeShadow:object.onBeforeShadow,
      customDepth:object.customDepthMaterial,customDistance:object.customDistanceMaterial}));
  }
  const args={scene,camera,universeRoot,body,destination,ship,shadowLight,target:hdr,shadows,exclude:[excludedRoot]};
  const expected=[persistent,persistentZero,persistentEmpty,persistentLayers,points,line,sprite,bodyOpaque,bodyInstanced,bodyZero,bodyEmpty,bodyArray,skinned,
    ...starViews.map(view=>view.surface),freeSite,hull,glass,shipZero,...(separateInterior?[]:[cabin])];
  const f={args,scene,camera,ship,body,destination,shadowLight,records,clones,controller,renderer,expected,objects,
    persistent,persistentZero,persistentEmpty,bodyOpaque,bodyInstanced,bodyZero,bodyEmpty,bodyArray,skinned,shared,globalFrame,globalSun,cabinLight,
    shipRoot,interior,hiddenCabinGroup,starViews,initialTarget,hdr,snapshot,light,group,
    get compileCalls(){return compileCalls;},get prunedReads(){return prunedReads;},get unexpectedDisposals(){return unexpectedDisposals;},
    get ownershipEvents(){return ownershipEvents;},get cloneShadowDisposals(){return cloneShadowDisposals;},
    set ready(value){ready=value;},setCompileError(error){compileFailed=true;compileError=error;},setBindError(error){bindFailed=true;bindError=error;},
    setRestoreError(error){restoreFailed=true;restoreError=error;},
    run(overrides={},options={signal:controller.signal}){return compileDestinationVariant(renderer,{...args,...overrides},options);},
    restored(){assert.equal(target,initialTarget);assert.equal(face,4);assert.equal(mip,2);},
    setPlayerTarget(value,nextFace=1,nextMip=3){target=value;face=nextFace;mip=nextMip;},
    currentTarget(){return {target,face,mip};},
    dispose(){recording=false;controller.abort();scene.environment.dispose();for(const resource of [...geometries,...materials])resource.dispose();},
  };fixtures.push(f);return f;
}

await test('WORLD obligations use the real selected objects and prune the source universe rather than its visibility',async()=>{
  const f=fixture(),before=f.snapshot(),promise=f.run(),r=f.records[0];
  assert.deepEqual(names(r.selected),names(f.expected));assert.equal(new Set(r.selected).size,r.selected.length);
  assert.ok(r.selected.every(object=>f.expected.includes(object)));assert.equal(f.prunedReads,0);
  assert.deepEqual(r.beforeCleanupState,before);assert.deepEqual(f.snapshot(),before);assert.equal(f.ownershipEvents,0);
  f.restored();await promise;assert.deepEqual(f.snapshot(),before);assert.equal(f.unexpectedDisposals,0);
});
await test('shared material ordinary and instanced objects remain separate compile obligations, including empty and zero-count representatives',async()=>{
  const f=fixture();await f.run();const selected=f.records[0].selected;
  assert.ok(selected.includes(f.bodyOpaque)&&selected.includes(f.bodyInstanced));assert.equal(f.bodyOpaque.material,f.bodyInstanced.material);
  for(const object of [f.bodyZero,f.bodyEmpty,f.persistentZero,f.persistentEmpty])assert.ok(selected.includes(object));
  assert.ok(selected.includes(f.skinned));assert.equal(f.skinned.isSkinnedMesh,true);assert.ok(selected.includes(f.bodyArray));
});
await test('the source light walk is empty and only private light copies supply destination WORLD lighting',async()=>{
  const f=fixture();await f.run();const r=f.records[0];
  assert.deepEqual(r.sourceLights,[]);assert.deepEqual(r.lightingRenderables,[]);
  assert.deepEqual(names(r.lights),['destination-light-0','destination-light-1','global-ambient','global-sun'].sort());
  assert.ok(r.lights.every(light=>!f.objects.includes(light)&&light.layers.mask===1&&light.visible));
  assert.equal(r.lighting.environment,f.scene.environment);assert.equal(r.lighting.fog,f.scene.fog);
  assert.equal(r.lighting.environmentIntensity,f.scene.environmentIntensity);
  assert.deepEqual(r.lighting.environmentRotation.toArray(),f.scene.environmentRotation.toArray());
});
await test('hidden destination stars on a non-WORLD authored light layer still provide their explicit future lighting family',async()=>{
  const f=fixture();await f.run();const r=f.records[0];assert.equal(f.starViews[1].light.layers.mask,4);assert.equal(f.starViews[1].light.visible,false);
  const clone=r.lightStates.find(light=>light.name==='destination-light-1');assert.equal(clone.mask,1);assert.equal(clone.visible,true);assert.equal(clone.intensity,3);
});
await test('one and two destination stars produce distinct complete light domains without stale source stars',async()=>{
  for(const stars of [1,2]){const f=fixture({stars});await f.run();assert.equal(f.records[0].lights.filter(light=>light.name.startsWith('destination-light')).length,stars);
    assert.ok(f.records[0].lights.every(light=>!light.name.startsWith('source-')));}
});
await test('the same light object supplied twice is collected only once',async()=>{
  const f=fixture();f.destination.starViews.push(f.destination.starViews[0]);await f.run();
  assert.equal(f.records[0].lights.filter(light=>light.name==='destination-light-0').length,1);
  assert.equal(f.records[0].selected.filter(object=>object===f.starViews[0].surface).length,1);
});
await test('shadow light membership comes only from the explicit shadows option, including a hidden authored shadow light',async()=>{
  const f=fixture();f.shadowLight.visible=true;await f.run({shadows:false});f.shadowLight.visible=false;await f.run({shadows:true});
  assert.ok(!f.records[0].lights.some(light=>light.name==='main-shadow'));
  assert.ok(f.records[1].lights.some(light=>light.name==='main-shadow'&&light.castShadow));assert.equal(f.shadowLight.visible,false);
});
await test('separate cabin renderables/lights remain excluded while future parked foreground hulls compile in WORLD',async()=>{
  const f=fixture();await f.run();const r=f.records[0];assert.ok(r.selected.some(object=>object.name==='ship-hull'&&object.layers.mask===8));
  assert.ok(r.selected.every(object=>object.name!=='ship-cabin'));assert.ok(r.lights.every(light=>!light.name.includes('cabin')));
  assert.equal(r.compileCamera.layers.mask,1);assert.equal(f.camera.layers.mask,128);
});
await test('legacy combined ship mode retains cabin renderables and visible cabin light in the WORLD family',async()=>{
  const f=fixture({separateInterior:false}),before=f.snapshot();await f.run();const r=f.records[0];
  assert.deepEqual(names(r.selected),names(f.expected));assert.ok(r.lights.some(light=>light.name==='cabin-light'&&light.layers.mask===1));
  assert.ok(r.lights.every(light=>!['hidden-cabin-light','ancestor-hidden-cabin-light'].includes(light.name)));assert.deepEqual(f.snapshot(),before);
});
await test('legacy cabin light collection respects hidden ancestors',async()=>{
  const f=fixture({separateInterior:false});f.interior.visible=false;await f.run();
  assert.ok(f.records[0].selected.some(object=>object.name==='ship-cabin'));assert.ok(f.records[0].lights.every(light=>!light.name.includes('cabin')));
});
await test('a future-visible hidden target root supplies its WORLD landing-pad and floating-city light families without hidden descendants',async()=>{
  const f=fixture(),beacon=f.light('target-pad-beacon',0,{kind:'point'}),city=f.group('target-floating-city'),
    skyFill=f.light('target-city-fill',0,{kind:'hemisphere'}),flood=f.light('target-city-flood',0,{kind:'point'}),
    hidden=f.group('target-hidden-building'),hiddenFlood=f.light('target-hidden-flood',0,{kind:'point'}),
    volumeFlood=f.light('target-volume-flood',2,{kind:'point'}),disabledFlood=f.light('target-disabled-flood',0,{kind:'point'});
  beacon.intensity=65;beacon.position.set(0,7,0);skyFill.intensity=1.35;flood.intensity=220000;
  hidden.visible=false;disabledFlood.visible=false;hidden.add(hiddenFlood);city.add(skyFill,flood,hidden,volumeFlood,disabledFlood);f.body.group.add(beacon,city);
  assert.equal(f.body.group.visible,false);const before=f.snapshot();await f.run();const r=f.records[0];
  assert.deepEqual(r.lightStates.filter(light=>light.name.startsWith('target-')).map(light=>light.name).sort(),
    ['target-pad-beacon','target-city-fill','target-city-flood'].sort());
  assert.ok(r.lights.some(light=>light.name==='target-pad-beacon'&&light.isPointLight));
  assert.ok(r.lights.some(light=>light.name==='target-city-fill'&&light.isHemisphereLight));
  assert.deepEqual(r.lightStates.find(light=>light.name==='target-pad-beacon').position,[700,814,900]);
  assert.deepEqual(f.snapshot(),before);assert.equal(f.prunedReads,0);f.restored();
});
await test('a visible orphan station supplies visible WORLD lights once, without source-world or hidden/non-WORLD lights',async()=>{
  const f=fixture(),entry=f.destination.artificialSites.find(site=>!site.parentBody),station=entry.group;
  const beacon=f.light('orphan-pad-beacon',0,{kind:'point'}),hidden=f.group('orphan-hidden-deck'),
    hiddenBeacon=f.light('orphan-hidden-beacon',0,{kind:'point'}),volumeBeacon=f.light('orphan-volume-beacon',2,{kind:'point'});
  station.visible=true;hidden.visible=false;hidden.add(hiddenBeacon);station.add(beacon,hidden,volumeBeacon);
  f.destination.artificialSites.push(entry);const before=f.snapshot();await f.run();const r=f.records[0];
  assert.equal(r.lights.filter(light=>light.name==='orphan-pad-beacon').length,1);
  assert.ok(r.lights.every(light=>!['orphan-hidden-beacon','orphan-volume-beacon','source-star','excluded-light'].includes(light.name)));
  assert.deepEqual(f.snapshot(),before);assert.equal(f.prunedReads,0);assert.equal(f.unexpectedDisposals,0);
});
await test('a future-visible hidden orphan root supplies WORLD lights while preserving hidden descendant and layer exclusions',async()=>{
  const f=fixture(),station=f.destination.artificialSites.find(site=>!site.parentBody).group,
    beacon=f.light('future-orphan-beacon',0,{kind:'point'}),hidden=f.group('orphan-hidden-branch'),
    hiddenBeacon=f.light('orphan-hidden-descendant',0,{kind:'point'}),volumeBeacon=f.light('orphan-nonworld-descendant',2,{kind:'point'});
  hidden.visible=false;hidden.add(hiddenBeacon);station.add(beacon,hidden,volumeBeacon);assert.equal(station.visible,false);
  const before=f.snapshot();await f.run();const r=f.records[0];assert.ok(r.selected.some(object=>object.name==='free-site-mesh'));
  assert.equal(r.lights.filter(light=>light.name==='future-orphan-beacon').length,1);
  assert.ok(r.lights.every(light=>!['orphan-hidden-descendant','orphan-nonworld-descendant','source-star'].includes(light.name)));
  assert.equal(beacon.visible,true);assert.equal(station.visible,false);assert.deepEqual(f.snapshot(),before);assert.equal(f.prunedReads,0);
});
await test('private light transforms compose parent-local state without updating source world matrices',async()=>{
  const f=fixture(),before=f.snapshot();await f.run();const copy=f.records[0].lightStates.find(light=>light.name==='global-sun');
  assert.deepEqual(copy.position,[103,204,305]);assert.deepEqual(f.snapshot(),before);
});
await test('explicit world-matrix boundaries are honored without writing live transforms',async()=>{
  const f=fixture();f.globalFrame.matrixWorldAutoUpdate=false;f.globalFrame.matrixWorld.makeTranslation(400,500,600);
  const before=f.snapshot();await f.run();assert.deepEqual(f.records[0].lightStates.find(light=>light.name==='global-sun').position,[403,504,605]);
  assert.deepEqual(f.snapshot(),before);
});
await test('compiler view and cloned light resources release synchronously while borrowed geometries/materials survive',async()=>{
  const f=fixture(),promise=f.run(),r=f.records[0],remaining=[];r.source.traverse(object=>{if(renderable(object))remaining.push(object);});
  assert.deepEqual(remaining,[]);assert.equal(r.source.children.length,0);assert.equal(r.lighting.children.length,0);
  assert.equal(f.cloneShadowDisposals,f.clones.filter(light=>light.shadow).length);assert.equal(f.unexpectedDisposals,0);assert.equal(f.ownershipEvents,0);
  await promise;
});
await test('the private camera does not clone attached render rigs or their instance buffers',async()=>{
  const f=fixture(),rig=new THREE.Group(),mesh=new THREE.InstancedMesh(f.bodyOpaque.geometry,f.shared,1);
  mesh.clone=()=>assert.fail('Attached render rig must not be cloned for compile camera');rig.add(mesh);f.camera.add(rig);
  await f.run();assert.equal(mesh.parent,rig);assert.equal(rig.parent,f.camera);assert.equal(f.records[0].compileCamera.children.length,0);mesh.dispose();
});
await test('shared compile cameras preserve lens/correspondence fields and never duplicate attached renderables',async()=>{
  const camera=new THREE.PerspectiveCamera(67,1.45,.3,7e8),rig=new THREE.Group(),geometry=new THREE.BoxGeometry(),material=new THREE.MeshBasicMaterial(),mesh=new THREE.InstancedMesh(geometry,material,2);
  camera.position.set(11,12,13);camera.quaternion.setFromAxisAngle(new THREE.Vector3(0,0,1),.25);camera.zoom=1.2;
  camera.setViewOffset(1600,900,100,50,1280,720);camera.layers.set(7);rig.add(mesh);camera.add(rig);
  const instance=mesh.instanceMatrix.array,positions=Array.from(instance),original=camera.projectionMatrix.toArray();
  mesh.clone=()=>assert.fail('Compile camera cloned an attached rig');
  try {
    for(const layer of [0,3,6]) {
      const copy=createCompileCamera(camera,layer);assert.notEqual(copy,camera);assert.equal(copy.isPerspectiveCamera,true);
      assert.equal(copy.layers.mask,1<<layer);assert.equal(copy.children.length,0);assert.deepEqual(copy.position.toArray(),camera.position.toArray());
      assert.deepEqual(copy.quaternion.toArray(),camera.quaternion.toArray());assert.deepEqual(copy.projectionMatrix.toArray(),original);
      assert.deepEqual(copy.projectionMatrixInverse.toArray(),camera.projectionMatrixInverse.toArray());assert.deepEqual(copy.view,camera.view);
      assert.notEqual(copy.view,camera.view);assert.equal(copy.fov,67);assert.equal(copy.zoom,1.2);assert.equal(copy.far,7e8);
    }
    assert.equal(camera.layers.mask,128);assert.equal(mesh.parent,rig);assert.equal(rig.parent,camera);
    assert.equal(mesh.instanceMatrix.array,instance);assert.deepEqual(Array.from(instance),positions);
  } finally {mesh.dispose();geometry.dispose();material.dispose();}
});
await test('the existing startup compileRenderVariant path also avoids cloning attached camera rigs',async()=>{
  const scene=new THREE.Scene(),source=new THREE.Group(),camera=new THREE.PerspectiveCamera(),geometry=new THREE.BoxGeometry(),material=new THREE.MeshStandardMaterial();
  const representative=new THREE.Mesh(geometry,material),rig=new THREE.InstancedMesh(geometry,material,1);representative.layers.set(3);
  source.add(representative);scene.add(source);camera.add(rig);rig.clone=()=>assert.fail('Startup compile camera cloned a render rig');
  let target='player',face=3,mip=1,calls=0;const originalMask=camera.layers.mask;
  const renderer={domElement:new EventTarget(),getContext:()=>({isContextLost:()=>false}),properties:{},
    getRenderTarget:()=>target,getActiveCubeFace:()=>face,getActiveMipmapLevel:()=>mip,
    setRenderTarget(value,nextFace=0,nextMip=0){target=value;face=nextFace;mip=nextMip;},
    compile(group,compileCamera){calls++;assert.equal(compileCamera.children.length,0);assert.equal(compileCamera.layers.mask,8);
      const selected=[];group.traverse(object=>{if(object.isMesh)selected.push(object);});assert.equal(selected.length,1);
      assert.equal(selected[0].geometry,geometry);assert.equal(selected[0].material,material);return new Set();},
  };
  try {
    const pending=compileRenderVariant(renderer,source,camera,scene,{layer:3,target:'hdr'});
    assert.equal(target,'player');assert.equal(face,3);assert.equal(mip,1);await pending;
    assert.equal(calls,1);assert.equal(rig.parent,camera);assert.equal(source.parent,scene);assert.equal(camera.layers.mask,originalMask);
  } finally {rig.dispose();geometry.dispose();material.dispose();}
});
await test('HDR target/face/mip restore before shader readiness and delayed cancellation does not roll back later player state',async()=>{
  const f=fixture({programs:true}),before=f.snapshot(),pending=f.run();f.restored();assert.deepEqual(f.snapshot(),before);
  const playerTarget={name:'next-player'};f.camera.layers.set(5);f.bodyOpaque.visible=true;f.setPlayerTarget(playerTarget,2,1);
  f.controller.abort();await assert.rejects(pending,{code:'aborted'});assert.deepEqual(f.currentTarget(),{target:playerTarget,face:2,mip:1});
  assert.equal(f.camera.layers.mask,32);assert.equal(f.bodyOpaque.visible,true);
});
await test('actual adapter readiness completes only after retained program becomes ready, after all source leases ended',async()=>{
  const f=fixture({programs:true});let settled=false;const pending=f.run().then(()=>{settled=true;});
  f.restored();await new Promise(resolve=>setTimeout(resolve,18));assert.equal(settled,false);f.ready=true;await pending;assert.equal(settled,true);
  assert.equal(f.records[0].lighting.children.length,0);assert.equal(f.unexpectedDisposals,0);
});
await test('pre-aborted readiness does not invoke renderer.compile and still returns the caller target/resources',async()=>{
  const f=fixture(),abort=new AbortController();abort.abort();const pending=f.run({}, {signal:abort.signal});
  f.restored();assert.equal(f.compileCalls,0);await assert.rejects(pending,{code:'aborted'});assert.equal(f.unexpectedDisposals,0);
});
for(const error of [Error('compile'),null,undefined,false,0,''])await test(`synchronous compile ${String(error)} preserves source identity and caller target`,async()=>{
  const f=fixture(),before=f.snapshot();f.setCompileError(error);assert.equal(caught(()=>f.run()),error);
  f.restored();assert.deepEqual(f.snapshot(),before);assert.equal(f.unexpectedDisposals,0);assert.equal(f.ownershipEvents,0);
  assert.equal(f.cloneShadowDisposals,f.clones.filter(light=>light.shadow).length);assert.equal(f.records[0].lighting.children.length,0);
});
for(const error of [Error('compile-original'),null,undefined,false,0,''])await test(`compile ${String(error)} wins over a later target restoration exception`,async()=>{
  const f=fixture(),before=f.snapshot();f.setCompileError(error);f.setRestoreError(Error('secondary restore'));
  assert.equal(caught(()=>f.run()),error);f.restored();assert.deepEqual(f.snapshot(),before);assert.equal(f.unexpectedDisposals,0);
});
await test('HDR bind failure restores the full caller tuple and retires only owned temporary lights',async()=>{
  const f=fixture(),error=Error('bind'),before=f.snapshot();f.setBindError(error);assert.equal(caught(()=>f.run()),error);
  f.restored();assert.equal(f.compileCalls,0);assert.deepEqual(f.snapshot(),before);assert.equal(f.unexpectedDisposals,0);
  assert.equal(f.cloneShadowDisposals,f.clones.filter(light=>light.shadow).length);
});
await test('restore failure consumes outstanding compiler rejection instead of leaking an unhandled promise',async()=>{
  const f=fixture({programs:true}),error=Error('restore'),unhandled=[];f.setRestoreError(error);
  const observe=(reason)=>unhandled.push(reason);process.on('unhandledRejection',observe);
  try {
    assert.equal(caught(()=>f.run()),error);f.restored();f.controller.abort();await new Promise(resolve=>setTimeout(resolve,20));
    assert.deepEqual(unhandled,[]);assert.equal(f.unexpectedDisposals,0);
  } finally {process.off('unhandledRejection',observe);}
});

const sources=[];
for(const [path,bytes] of frozen){const after=await readFile(path);sources.push({path,bytes:bytes.length,sha256:sha(bytes),stable:sha(bytes)===sha(after)});}
const report={kind:'cpu-contracts',scope:'Actual destination compiler source/light selection and synchronous lease restoration; fake renderer/program readiness; no native GPU or performance evidence',
  passed:cases.filter(item=>item.passed).length,total:cases.length,sources,cases};
await writeFile(`${out}/report.json`,`${JSON.stringify(report,null,2)}\n`);
console.log(JSON.stringify({out,passed:report.passed,total:report.total,failures:cases.filter(item=>!item.passed)},null,2));
assert.ok(sources.every(source=>source.stable),'Destination preparation inputs changed during execution');assert.equal(report.passed,report.total);
