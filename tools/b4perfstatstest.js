// Acceptance telemetry must retain a severe player-visible stall.
import assert from 'node:assert/strict';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
const {server,port}=await startServer(0);let browser;
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath(),headless:true});
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&freeze=1&time=9.5&quality=low&vclouds=1&post=1&nolock=1`);
  await page.waitForFunction('window.NMS?.booted',null,{timeout:180000});
  const result=await page.evaluate(async()=>{
    NMS.resetPerformanceStats();
    const start=performance.now();
    while(performance.now()-start<800) {} // deliberate regression stimulus
    const stimulus=performance.now()-start;
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    return {stimulus,stats:NMS.stats()};
  });
  const {stimulus,stats}=result;
  assert.deepEqual(errors,[]);
  assert.ok(stats.maximumFrameMs>=stimulus-25,'Severe stall was discarded');
  assert.ok(stats.longFrames>=1 && stats.longFrameRatio>0,'Stall must count as a long frame');
  assert.ok(stats.performanceWindowSeconds>=stimulus/1000-.025,'Measured window omitted the stall');
  assert.ok(stats.averageFps<20,'The stall must affect the reported average');
  console.log('PASS severe-stall telemetry:',{stimulus,frames:stats.performanceFrames,
    window:stats.performanceWindowSeconds,maximum:stats.maximumFrameMs,average:stats.averageFps});
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
