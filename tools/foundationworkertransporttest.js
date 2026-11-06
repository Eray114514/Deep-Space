// No WebGL. Isolate module-worker startup with identical main/worker bytes
// under direct HTTP, Playwright main fulfillment and local HTTP replacement.
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {installFoundationMainResponse} from './foundation-first-draw-route.js';

const main = `window.workerControl={rows:[],done:false};
const run=id=>new Promise(resolve=>{
  const started=performance.now(),worker=new Worker('/worker.js',{type:'module'});
  let finished=false;
  const finish=result=>{if(finished)return;finished=true;clearTimeout(timer);worker.terminate();
    window.workerControl.rows.push({id,ms:performance.now()-started,...result});resolve();};
  const timer=setTimeout(()=>finish({passed:false,error:'timeout'}),8000);
  worker.onmessage=event=>finish({passed:event.data.id===id&&event.data.value===id*3+1,data:event.data});
  worker.onerror=event=>finish({passed:false,error:event.message||event.type,eventClass:event.constructor.name});
  worker.postMessage({id});
});
for(let batch=0;batch<2;batch++) {
  const jobs=Array.from({length:8},(_,i)=>run(batch*8+i));
  const until=performance.now()+500;while(performance.now()<until){}
  await Promise.all(jobs);
}
window.workerControl.done=true;document.body.textContent=JSON.stringify(window.workerControl);`;
const fixture={
  '/': '<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module" src="/src/main.js?v=fixture"></script></body></html>',
  '/src/main.js':main,
  '/worker.js':"import {value} from './worker-dependency.js';self.onmessage=event=>self.postMessage({id:event.data.id,value:value(event.data.id)});",
  '/worker-dependency.js':'export const value=id=>id*3+1;',
};
const out=`test-results/foundation-worker-transport/${new Date().toISOString().replace(/[:.]/g,'-')}`;
await mkdir(out,{recursive:true});
await writeFile(`${out}/verifier.js`,await readFile('tools/foundationworkertransporttest.js'));
await writeFile(`${out}/response-helper.js`,await readFile('tools/foundation-first-draw-route.js'));
await writeFile(`${out}/fixture.json`,JSON.stringify(fixture,null,2));
const hash=value=>createHash('sha256').update(value).digest('hex');
const cases=[];
for(const mode of ['direct','browser-route','local-http-response']) {
  const requests=[],networkFailures=[],errors=[];
  const server=http.createServer((req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname;
    requests.push({path,at:Date.now()});
    if(!(path in fixture)){res.writeHead(path==='/favicon.ico'?204:404);res.end();return;}
    res.writeHead(200,{'content-type':path==='/'?'text/html; charset=utf-8':'text/javascript; charset=utf-8','cache-control':'no-store'});
    res.end(fixture[path]);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser,response;
  try {
    if(mode==='local-http-response')response=installFoundationMainResponse(server,main);
    browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath()||undefined});
    const page=await browser.newPage();
    await page.addInitScript(()=>{HTMLCanvasElement.prototype.getContext=()=>{throw Error('WebGL/canvas is excluded from this control');};});
    page.on('pageerror',error=>errors.push(String(error)));
    page.context().on('requestfailed',request=>networkFailures.push({url:request.url(),type:request.resourceType(),failure:request.failure()}));
    if(mode==='browser-route')await page.route('**/src/main.js*',route=>route.fulfill({contentType:'text/javascript',body:main}));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(()=>window.workerControl?.done,null,{timeout:25000});
    const result=await page.evaluate(()=>({rows:window.workerControl.rows,userAgent:navigator.userAgent}));
    response?.restore();
    const row={mode,...result,networkFailures,errors,requests,response:response?.snapshot()??null,
      passed:result.rows.length===16&&result.rows.every(row=>row.passed)&&!errors.length};
    cases.push(row);await writeFile(`${out}/cases.json`,JSON.stringify(cases,null,2));
    console.log(JSON.stringify({mode,passed:row.passed,workers:result.rows.length,errors:errors.length,networkFailures:networkFailures.length}));
  } finally {response?.restore();await browser?.close();await new Promise(resolve=>server.close(resolve));}
}
const report={fixtureSha256:hash(JSON.stringify(fixture)),helperSha256:hash(await readFile('tools/foundation-first-draw-route.js')),
  cases,passed:cases.filter(row=>row.mode!=='browser-route').every(row=>row.passed),
  boundary:'16 module workers per fresh browser, two batches, 500ms main-thread CPU block per batch; identical module bytes and no canvas/WebGL. Browser-route outcome is an attribution control, not proof of the cause of the full game worker failures or proof that routing is harmless under minute-long GPU service stalls.'};
await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify({out,passed:report.passed}));assert.ok(report.passed);
