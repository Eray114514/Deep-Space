// Browser/Node fixture identity: authored release bodies by default. The old
// uncurated generator output is available only as explicitly labelled stress.
import { GalaxyCatalog, HOME_SYSTEM_ID } from '../src/galaxy-layout.js';
import { generateSystemSpec } from '../src/astronomy.js';
import { ACTIVE_GALAXY_ID, getGalaxyConfig, resolveBodyTuning, applySystemBodyTuning } from '../src/world-config.js';

export function canonicalHomeBody({bodyId='planet-0',untunedStress=false}={}) {
  const options=arguments[0];
  if(options!==undefined&&(!options||typeof options!=='object'||Array.isArray(options)))throw TypeError('Canonical fixture options must be an object');
  if(typeof bodyId!=='string'||!bodyId)throw TypeError('Canonical fixture bodyId must be a nonempty string');
  if(typeof untunedStress!=='boolean')throw TypeError('untunedStress must be an explicit boolean');
  const galaxyId=ACTIVE_GALAXY_ID,seed=getGalaxyConfig(galaxyId).seed;
  const star=new GalaxyCatalog(seed).getSystem(HOME_SYSTEM_ID),systemId=star.id;
  const generated=generateSystemSpec(seed,star);
  const authoredTuning=id=>resolveBodyTuning({galaxyId,seed,systemId,bodyId:id});
  const system=untunedStress?generated:applySystemBodyTuning(generated,authoredTuning);
  const spec=system.bodies.find(body=>body.bodyId===bodyId);
  if(!spec)throw RangeError(`Unknown canonical home body: ${bodyId}`);
  const tuning=untunedStress?{}:authoredTuning(bodyId);
  return {seed,star,spec,tuning,provenance:{fixture:'canonical-home-body',version:1,
    mode:untunedStress?'untuned-stress':'authored',galaxyId,seed,systemId,bodyId,bodySeed:spec.seed,
    authoredTuningApplied:!untunedStress,radiusMeters:spec.radius,type:spec.type,
    stellarSource:'standalone-fallback',
    scope:'Authored body parameters in an independent Planet; not the full StarSystem ephemeris or foreground scene.',
    rawRadiusMeters:generated.bodies.find(body=>body.bodyId===bodyId).radius,
    tuningKeys:Object.keys(tuning).sort()}};
}
