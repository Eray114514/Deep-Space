// CPU-only authored fixture contracts; no Planet renderer or browser/GPU.
import assert from 'node:assert/strict';
import { canonicalHomeBody } from './canonical-planet-fixture.js';
import { ACTIVE_GALAXY_ID, getGalaxyConfig, resolveBodyTuning } from '../src/world-config.js';
import { GalaxyCatalog, HOME_SYSTEM_ID } from '../src/galaxy-layout.js';
import { generateSystemSpec } from '../src/astronomy.js';

const home=canonicalHomeBody(),ocean=canonicalHomeBody({bodyId:'planet-1'});
assert.equal(home.seed,'MILKY-038');assert.equal(home.star.id,HOME_SYSTEM_ID);
assert.equal(home.spec.bodyId,'planet-0');assert.equal(home.spec.radius,6000000);
assert.equal(home.tuning.radiusMeters,6000000);assert.equal(home.spec.type,'lush');
assert.equal(home.provenance.mode,'authored');assert.equal(home.provenance.authoredTuningApplied,true);
assert.equal(home.provenance.stellarSource,'standalone-fallback');
assert.equal(home.provenance.radiusMeters,home.spec.radius);assert.equal(home.provenance.bodySeed,home.spec.seed);
assert.equal(home.tuning.atmosphereHeightMeters,630000);assert.equal(home.tuning.cloudCoverage,.64);
assert.equal(ocean.spec.bodyId,'planet-1');assert.equal(ocean.spec.radius,560000);assert.equal(ocean.spec.type,'ocean');
assert.equal(ocean.tuning.radiusMeters,560000);assert.equal(ocean.tuning.oceanProfile,'pelagic-storm');
assert.equal(ocean.tuning.seaLevelOffset,1650);assert.equal(ocean.provenance.mode,'authored');
assert.deepEqual(ocean.spec.atmosphere,ocean.tuning.atmosphere);assert.deepEqual(ocean.spec.clouds,ocean.tuning.clouds);
const seed=getGalaxyConfig(ACTIVE_GALAXY_ID).seed,star=new GalaxyCatalog(seed).getSystem(HOME_SYSTEM_ID);
const raw=generateSystemSpec(seed,star);
for(const bodyId of ['planet-0','planet-1']) {
  const stress=canonicalHomeBody({bodyId,untunedStress:true}),expected=raw.bodies.find(body=>body.bodyId===bodyId);
  assert.deepEqual(stress.spec,expected,'Explicit stress must be the unchanged raw generator dossier');
  assert.deepEqual(stress.tuning,{});assert.equal(stress.provenance.mode,'untuned-stress');
  assert.equal(stress.provenance.authoredTuningApplied,false);assert.deepEqual(stress.provenance.tuningKeys,[]);
  assert.equal(stress.provenance.radiusMeters,expected.radius);assert.notEqual(stress.spec.radius,bodyId==='planet-0'?6000000:560000);
}
assert.equal(canonicalHomeBody({untunedStress:true}).spec.radius,286012.9330866039);
assert.equal(canonicalHomeBody({bodyId:'planet-1',untunedStress:true}).spec.type,'barren');
for(const bodyId of ['',null,1,{},'planet-404','PLANET-0'])assert.throws(()=>canonicalHomeBody({bodyId}));
for(const invalid of [null,'planet-0',[],3])assert.throws(()=>canonicalHomeBody(invalid));
for(const untunedStress of ['true',1,null])assert.throws(()=>canonicalHomeBody({untunedStress}));
for(const invalid of [undefined,null,[],ACTIVE_GALAXY_ID,'',1,false])assert.throws(()=>resolveBodyTuning(invalid),
  'A malformed tuning call must never silently return the untuned fixture');
for(const bodyId of ['planet-0','planet-1']) {
  assert.throws(()=>resolveBodyTuning(ACTIVE_GALAXY_ID,star.id,bodyId),'Legacy positional tuning calls must fail');
  assert.equal(resolveBodyTuning({galaxyId:ACTIVE_GALAXY_ID,seed,systemId:star.id,bodyId}).radiusMeters,
    bodyId==='planet-0'?6000000:560000);
}
assert.deepEqual(canonicalHomeBody(),home,'Helper calls must preserve deterministic independent fixture identity');
console.log(JSON.stringify({passed:true,scope:'CPU authored fixture and API-shape contracts only; no runtime Planet/GPU or visual acceptance.',
  authored:[home.provenance,ocean.provenance],stress:canonicalHomeBody({untunedStress:true}).provenance},null,2));
