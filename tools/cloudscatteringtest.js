import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {cloudSlabSolver,CLOUD_SCATTERING_ALBEDO} from '../src/cloud/cloud-scattering-lut.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';

// Independent analogue photon transport. Only the first collision uses the
// dual HG law; subsequent collisions are isotropic, matching the stated
// closure. This does not reuse the solver's sweeps, matrix or quadrature.
function photons(tau,solar,count=100000) {
  let seed=0x62b54e31,reflected=0,transmitted=0,absorbed=0;
  const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return((seed>>>0)+.5)/4294967296;};
  for(let p=0;p<count;p++) {
    let z=0,mu=solar,first=true;
    for(let collision=0;collision<200000;collision++) {
      z+=mu*(-Math.log(random()));
      if(z<=0){reflected++;break;}if(z>=tau){transmitted++;break;}
      if(random()>CLOUD_SCATTERING_ALBEDO){absorbed++;break;}
      if(first) {
        const g=random()<.8?.65:-.25,u=random();
        const c=(1+g*g-Math.pow((1-g*g)/(1-g+2*g*u),2))/(2*g);
        mu=solar*c+Math.sqrt((1-solar*solar)*(1-c*c))*Math.cos(random()*Math.PI*2);first=false;
      } else mu=random()*2-1;
      assert.ok(collision<199999,'photon path cap must not silently absorb energy');
    }
  }
  return {reflected:reflected/count,transmitted:transmitted/count,absorbed:absorbed/count};
}
const records=[];
// Gates fixed before running candidates. Flux error is an absolute fraction
// of incident energy; MC tolerance includes finite-packet sampling noise.
for(const tau of [.3,1,8,32]) {
  const production=cloudSlabSolver(tau),fine=cloudSlabSolver(tau,{depthCells:128,angleCells:24});
  for(const solar of [.2,.6,1]) {
    const a=production(solar),b=fine(solar),reference=photons(tau,solar);
    const convergence=Math.max(Math.abs(a.reflected-b.reflected),Math.abs(a.transmitted-b.transmitted));
    const error=Math.max(Math.abs(a.reflected-reference.reflected),Math.abs(a.transmitted-reference.transmitted));
    records.push({tau,solar,actual:{reflected:a.reflected,transmitted:a.transmitted,absorbed:a.absorbed},
      fine:{reflected:b.reflected,transmitted:b.transmitted},reference,convergence,error,energyError:a.energyError});
    assert.ok(a.multiple.every(x=>Number.isFinite(x)&&x>=0),'finite nonnegative source');
    assert.ok(a.energyError<1e-8,`energy conservation ${a.energyError}`);
    assert.ok(convergence<.006,`solver refinement ${convergence}`);
    assert.ok(error<.015,`independent photon flux ${tau}/${solar}: ${error}`);
  }
}
assert.ok(records.reduce((sum,r)=>sum+r.error,0)/records.length<.008);
await mkdir('test-results/b4-scattering',{recursive:true});
await writeFile('test-results/b4-scattering/report.json',JSON.stringify({fingerprint:await evidenceFingerprint('tools/cloudscatteringtest.js'),
  model:'dual HG first collision; isotropic subsequent collisions; omega .999; black slab boundaries',records},null,2));
console.log('PASS independent cloud scattering:',{cases:records.length,maxFluxError:Math.max(...records.map(r=>r.error)),
  maxRefinement:Math.max(...records.map(r=>r.convergence)),maxEnergyError:Math.max(...records.map(r=>r.energyError))});
