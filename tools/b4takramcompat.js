// Isolated pinned upstream compatibility probe, not game acceptance. Prepare
// ignored test-results/references/takram-compat dependencies and bundle first.
import {mkdir,writeFile,copyFile,access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
const referenceRoot=new URL('../test-results/references/takram-compat/',import.meta.url);
if(process.argv.includes('--prepare')) {
  await mkdir(referenceRoot,{recursive:true});
  for(const name of ['probe.js','probe.html','entry.js','build.mjs','package.json','package-lock.json'])
    await copyFile(new URL(`fixtures/takram-compat/${name}`,import.meta.url),new URL(name,referenceRoot));
  console.log('Reference source prepared. Run npm ci --prefix test-results/references/takram-compat, then this probe with --build.');
  process.exit(0);
}
if(process.argv.includes('--build')) {
  execFileSync(process.execPath,['build.mjs'],{cwd:fileURLToPath(referenceRoot),stdio:'inherit'});
  process.exit(0);
}
await access(new URL('bundle.js',referenceRoot)).catch(()=>{
  throw Error('Prepare the pinned reference with --prepare, npm ci in its ignored directory, and --build. See tools/fixtures/takram-compat/README.md.');
});
const {server,port}=await startServer(0);let browser;
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath(),headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:720}}),errors=[];
  await page.addInitScript(()=>{window.__referenceFailure=null;window.addEventListener('error',event=>{
    window.__referenceFailure=String(event.error||event.message);});});
  page.on('pageerror',e=>{errors.push(String(e));console.error(String(e));});
  page.on('console',m=>{if(m.type()==='error'){errors.push(m.text());console.error(m.text().slice(0,1000));}});
  await page.goto(`http://127.0.0.1:${port}/test-results/references/takram-compat/probe.html`);
  await page.waitForFunction('window.reference?.frames>0 || window.__referenceFailure',null,{timeout:180000});
  const failure=await page.evaluate(()=>window.__referenceFailure);if(failure)throw Error(failure);
  const records=[];await mkdir('test-results/b4-takram-compat',{recursive:true});
  for(const pose of ['below','above','orbit']) {
    const start=await page.evaluate(pose=>{reference.pose(pose);return reference.frames;},pose);
    await page.waitForFunction(start=>reference.frames>start+64,start,{timeout:180000});
    await page.screenshot({path:`test-results/b4-takram-compat/${pose}.png`});
    records.push(await page.evaluate(pose=>({pose,camera:reference.camera.position.toArray(),glError:reference.renderer.getContext().getError(),frames:reference.frames}),pose));
    console.log(pose);
  }
  await writeFile('test-results/b4-takram-compat/report.json',JSON.stringify({versions:{clouds:'0.7.6',atmosphere:'0.19.1',geospatial:'0.9.1',postprocessing:'6.39.5',three:'185'},scope:'Single flat liquid sphere, one ordinary deck, one star, upstream approximate transport. Synthetic jitter replaces STBN; no HUD, gameplay, shared weather, log depth or B5 joint transfer acceptance.',records,errors},null,2));
  if(errors.length)throw Error(errors.join('\n'));
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
