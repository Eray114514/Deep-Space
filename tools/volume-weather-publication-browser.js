// Real weather upload + real resolve. Clone an endpoint without modifying its
// bytes so only the source identity changes during the observed draw.
export async function verifyVolumeWeatherPublication(game) {
  const pipeline=game._pipeline, pass=pipeline.volumePass, planet=pass.activePlanet;
  const stream=planet.weatherStream, second=stream?.committedSecond;
  const publication=planet.cloudWeatherPublication;
  if(!stream||!second||!publication||stream.frames.get(second.hours)!==second
    ||pass.resolveMaterial.uniforms.uHistoryValid.value!==1)
    throw Error('Weather history probe needs a published bracket and valid cloud history');
  const profile=pass.profilePhase, rows=[];
  const frozen=game.time().frozen;
  let timeout;
  game.setTimeFrozen();
  try {
    await new Promise((resolve,reject)=>{
      timeout=setTimeout(()=>reject(Error('No two weather history resolve frames')),30000);
      pass.profilePhase=function(name,work,options) {
        const result=profile.call(this,name,work,options);
        if(name==='volume-resolve'&&rows.length<2) {
          rows.push({sequence:pipeline.frameState.sequence,history:pass.resolveMaterial.uniforms.uHistoryValid.value,
            currentSource:pipeline.frameState.current.weather===planet.cloudWeatherPublication});
          if(rows.length===2)resolve();
        }
        return result;
      };
      stream.frames.set(second.hours,{...second});
      stream.update(planet.weatherHours,true);
      const changed=planet.cloudWeatherPublication;
      if(changed===publication||changed.owner!==publication.owner||changed.first!==publication.first
        ||changed.second===publication.second)reject(Error('Weather probe did not replace exactly one published endpoint'));
    });
    if(rows[0].history!==0||rows[1].history!==1||rows[1].sequence!==rows[0].sequence+1
      ||rows.some(row=>!row.currentSource))
      throw Error('Weather replacement history did not invalidate and recover: '+JSON.stringify(rows));
    return {rows,oldRevision:publication.second,newRevision:planet.cloudWeatherPublication.second};
  } finally {
    clearTimeout(timeout);
    pass.profilePhase=profile;
    stream.frames.set(second.hours,second);
    stream.update(planet.weatherHours,true);
    game.setTimeFrozen(frozen);
  }
}
