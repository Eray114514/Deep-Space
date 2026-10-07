// Query-time stellar ephemerides must match the actual mutable renderer state,
// without moving the current universe just to answer an old/future query.
import assert from 'node:assert/strict';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
const {server,port}=await startServer(0);let browser;
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath(),headless:true});
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&freeze=1&time=9.5&quality=ultra&vclouds=1&post=1&nolock=1`);
  await page.waitForFunction('window.NMS?.booted',null,{timeout:180000});
  const metrics=await page.evaluate(()=>{
    const system=NMS._internals.universe.system,planets=system.planets.filter(p=>p.weatherField?.synoptic);
    let directionError=0,powerError=0,nightError=0,cases=0;
    const smooth=(a,b,x)=>{const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t);};
    const state=()=>JSON.stringify({stars:system.starViews.map(v=>v.positionUniv.toArray()),
      planets:planets.map(p=>[p.posUniv.toArray(),p.frameOrientation.toArray(),p.weatherHours])});
    for(const hours of [-12,0,9.5,24,48.5]) {
      const before=state(),queries=planets.map(p=>p.stellarDirectionsAt(hours));
      if(state()!==before)throw Error('Read-only stellar query moved the universe');
      NMS.setTime(hours);
      for(let i=0;i<planets.length;i++) {
        const p=planets[i],actual=p.stellarLightField.sources;
        if(actual.length!==queries[i].length)throw Error('Stellar source lost');
        for(const query of queries[i]) {
          const matches=actual.map(light=>({light,difference:Math.hypot(...query.direction.map((x,k)=>
            x-light.localDirection.toArray()[k]))})).sort((a,b)=>a.difference-b.difference);
          directionError=Math.max(directionError,matches[0].difference);
          powerError=Math.max(powerError,Math.abs(matches[0].light.irradianceFraction-query.irradianceFraction));
        }
        for(let k=0;k<16;k++) {
          const y=1-2*(k+.5)/16,a=k*2.399963229728653;
          const d={x:Math.cos(a)*Math.sqrt(1-y*y),y,z:Math.sin(a)*Math.sqrt(1-y*y)};
          const cos=Math.max(-1,...actual.filter(s=>s.irradianceFraction>0).map(s=>
            d.x*s.localDirection.x+d.y*s.localDirection.y+d.z*s.localDirection.z));
          nightError=Math.max(nightError,Math.abs(p.weatherField.sampleRaw(d,hours).nightSide-smooth(.1,-.14,cos)));cases++;
        }
      }
    }
    NMS.setTime(9.5);return {worlds:planets.length,stars:system.starViews.length,cases,directionError,powerError,nightError};
  });
  console.log({metrics,errors});assert.deepEqual(errors,[]);assert.ok(metrics.stars>=2);
  assert.ok(metrics.worlds>=3);assert.ok(metrics.directionError<1e-10);
  assert.ok(metrics.powerError<1e-10);assert.ok(metrics.nightError<1e-10);
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
