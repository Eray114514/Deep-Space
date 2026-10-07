import assert from 'node:assert/strict';
import * as THREE from 'three';
import {TileSet,dress} from '../src/halcyon/baked.js';

const original=globalThis.document;
globalThis.document={createElement:()=>({width:1,height:1,getContext:()=>({fillRect(){}})})};
try {
  const loads=[],loader={load(url,ready){loads.push({url,ready});}};
  const tiles=new TileSet('panel',8,loader,'#fff','#fff');
  const material=new THREE.MeshStandardMaterial();
  dress(material,tiles,{rep:3,repY:2,microRep:30,roughLo:.3,roughHi:.8});
  const count=()=>[tiles.alb,tiles.nrm,tiles.orm].map(tile=>tile.views.length);
  const initial=count();
  for(let variant=0;variant<6;variant++) {
    const shader={uniforms:{},vertexShader:'',fragmentShader:''};material.onBeforeCompile(shader);
    assert.equal(shader.uniforms.uMicroNrm.value,material.normalMap);
    assert.equal(shader.uniforms.uMicroOrm.value,material.roughnessMap);
    assert.deepEqual(count(),initial,'Shader variants created redundant texture views');
  }
  const tile=tiles.nrm,owned=[tile.base,...tile.views],oldSource=tile.base.source;
  const identities=owned.slice(),disposed=[],listeners=new Map();
  for(const texture of owned) {
    const listener=()=>{
      assert.equal(texture.source,oldSource,'Release must occur before replacing the shared source');disposed.push(texture);
    };
    listeners.set(texture,listener);texture.addEventListener('dispose',listener);
  }
  const image={width:2048,height:2048};loads[1].ready({image});
  assert.deepEqual(disposed,owned);assert.notEqual(tile.base.source,oldSource);
  assert.deepEqual(owned,identities);assert.ok(owned.every(texture=>texture.source===tile.base.source&&texture.image===image));
  assert.equal(material.normalMap,identities[1]);assert.deepEqual(material.normalMap.repeat.toArray(),[3,2]);
  const late=tile.view(7,5);assert.equal(late.source,tile.base.source);
  assert.deepEqual(late.repeat.toArray(),[7,5]);
  // These listeners validated the placeholder transaction, not final teardown.
  for(const texture of owned)texture.removeEventListener('dispose',listeners.get(texture));
  const delayed=tiles.alb,source=delayed.base.source;
  tiles.dispose();tiles.dispose();loads[0].ready({image});
  assert.equal(delayed.base.source,source);assert.equal(delayed.image,null);
  assert.throws(()=>delayed.view(1),/disposed/);material.dispose();
  console.log('PASS: all placeholder owners released before shared-source replacement, stable material/UV identity, reused micro views, late-load cancellation and disposal.');
} finally {globalThis.document=original;}
