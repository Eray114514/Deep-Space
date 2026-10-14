import assert from 'node:assert/strict';
import {makeCloudVolumeMaterial} from '../src/clouds-webgl.js';
import {CloudLightBatchRenderer} from '../src/cloud/cloud-light-batch-renderer.js';

const source=makeCloudVolumeMaterial({R:6000000},
  {rIn:6000000,rOut:6040000,localWeather:true,ox:0,oy:0,oz:0},null,null,null);
const options={width:589,height:331,budgetBytes:8*1024*1024};
const stage=new CloudLightBatchRenderer(source,options),programs=[...stage.materials];
const dictionaries=programs.map(material=>material.uniforms);
let disposedPrograms=0,disposedTargets=0;
for(const material of programs)material.addEventListener('dispose',()=>disposedPrograms++);
for(const target of stage.targets)target.addEventListener('dispose',()=>disposedTargets++);
const owner=source.clone();owner.uniforms={...source.uniforms,uLightQuadratureSteps:{value:16},oldOwnerOnly:{value:{}}};
try {
  stage.configure(owner,options);
  assert.deepEqual(stage.materials,programs);assert.equal(disposedPrograms,0);assert.equal(disposedTargets,0);
  assert.equal(stage.prepare.uniforms.uLightQuadratureSteps,owner.uniforms.uLightQuadratureSteps);
  stage.configure(source,{...options,width:442,height:248});
  assert.equal(disposedTargets,4);assert.equal(disposedPrograms,0);
  assert.ok(!('oldOwnerOnly' in stage.prepare.uniforms),'Obsolete owners must not accumulate');
  stage.configure(source,{...options,budgetBytes:1024});
  assert.equal(stage.plan.direct,true);assert.equal(stage.targets.length,0);assert.equal(stage.source,null);
  assert.ok(stage.materials.every(material=>Object.keys(material.uniforms).every(name=>name in stage.page)));
  assert.ok(Object.entries(stage.page).filter(([name])=>name.startsWith('tPage')).every(([,uniform])=>uniform.value===null));
  stage.configure(source,options);assert.deepEqual(stage.materials,programs);
  stage.materials.forEach((material,i)=>assert.equal(material.uniforms,dictionaries[i],'Three caches the uniform dictionary'));
  stage.releaseScratch();stage.configure(owner,options);assert.deepEqual(stage.materials,programs);
  assert.throws(()=>stage.configure(owner,{...options,width:NaN}),/Invalid/);
  assert.equal(stage.source,owner);assert.equal(stage.targets.length,4,'Invalid migration must preserve the previous configuration');
  owner.fragmentShader+='\n// distinct physical source revision\n';stage.configure(owner,options);
  assert.equal(disposedPrograms,6);assert.equal(stage.materials.length,6);
  assert.notEqual(stage.prepare,programs[0],'A source revision must invalidate the old family');
  stage.dispose();stage.dispose();assert.equal(stage.source,null);assert.equal(stage.targets.length,0);assert.equal(stage.materials.length,0);
  assert.throws(()=>stage.configure(source,options),/disposed/);
  const direct=new CloudLightBatchRenderer(source,{...options,budgetBytes:0});
  assert.equal(direct.materials.length,0);direct.configure(source,options);assert.equal(direct.materials.length,6);direct.dispose();
  console.log('PASS bounded program family, scratch migration/direct fallback, uniform owner replacement, source revision, invalid options and final release.');
}finally{stage.dispose();owner.dispose();source.dispose();}
