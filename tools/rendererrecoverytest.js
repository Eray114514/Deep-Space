import assert from 'node:assert/strict';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { startServer } from './server.js';

const {server,port} = await startServer(0);
let browser;
try {
  browser = await launchHardwareBrowser({executablePath:resolveSystemChromePath() || undefined});
  const page = await browser.newPage();
  await page.route('**/recovery-fixture.html',route => route.fulfill({contentType:'text/html',body:
    '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>'}));
  await page.goto(`http://127.0.0.1:${port}/recovery-fixture.html`);
  const result = await page.evaluate(async () => {
    const T = await import('three');
    const {createGameRenderer} = await import('/src/renderer-runtime.js');
    const methods = ['deleteBuffer','deleteVertexArray','deleteTexture','deleteFramebuffer','deleteRenderbuffer'];

    async function cycle(renderer,count) {
      const gl = renderer.getContext(), canvas = renderer.domElement;
      const failures = [], restored = [], teardown = [];
      for (const name of methods) {
        const native = gl[name], own = Object.getOwnPropertyDescriptor(gl,name);
        const probe = function(...args) {
          const result = native.apply(this,args), error = gl.getError();
          if (error && error !== gl.CONTEXT_LOST_WEBGL) failures.push({name,error});
          return result;
        };
        gl[name] = probe;
        teardown.push(() => { if (own) Object.defineProperty(gl,name,own);else delete gl[name]; });
      }
      const wait = (type,trigger) => new Promise((resolve,reject) => {
        const timer = setTimeout(() => reject(Error(type+' timeout')),15000);
        canvas.addEventListener(type,() => {clearTimeout(timer);resolve();},{once:true});
        trigger();
      });
      function makeScene() {
        const scene = new T.Scene(), camera = new T.PerspectiveCamera(60,1,.01,100);
        camera.position.z = 4;
        const image = new T.DataTexture(new Uint8Array([255,80,48,255]),1,1);
        image.needsUpdate = true;
        const mesh = new T.InstancedMesh(new T.BoxGeometry(),new T.MeshBasicMaterial({map:image}),1);
        mesh.setMatrixAt(0,new T.Matrix4());
        scene.add(mesh);
        const target = new T.WebGLRenderTarget(16,16,{depthBuffer:true});
        return {
          draw() {
            renderer.setRenderTarget(target);
            renderer.render(scene,camera);
            renderer.setRenderTarget(null);
            const pixel = new Uint8Array(4);
            renderer.readRenderTargetPixels(target,8,8,1,1,pixel);
            return [...pixel];
          },
          dispose() {
            mesh.geometry.dispose();mesh.dispose();mesh.material.dispose();image.dispose();target.dispose();
          },
        };
      }
      document.body.appendChild(canvas);
      try {
        const scene = makeScene();
        for (let i=0;i<count;i++) {
          const initial = scene.draw(), initialError = gl.getError();
          await wait('webglcontextlost',() => renderer.forceContextLoss());
          // Restoration is allowed once the lost event has finished dispatching.
          await new Promise(resolve => setTimeout(resolve,100));
          await wait('webglcontextrestored',() => renderer.forceContextRestore());
          const beforeDrawError = gl.getError(), rebuilt = scene.draw(), redrawError = gl.getError();
          const buffer = gl.createBuffer();
          gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
          const liveBeforeDelete = gl.isBuffer(buffer);
          gl.deleteBuffer(buffer);
          const liveAfterDelete = gl.isBuffer(buffer);
          restored.push({initial,rebuilt,initialError,beforeDrawError,redrawError,
            liveBeforeDelete,liveAfterDelete,lost:gl.isContextLost()});
        }
        scene.dispose();
        const disposeError = gl.getError();
        // Leave validation of unowned handles with WebGL.
        const foreign = document.createElement('canvas').getContext('webgl2');
        const foreignBuffer = foreign.createBuffer();
        const removeProbe = teardown.shift();
        removeProbe();
        gl.deleteBuffer(foreignBuffer);
        const foreignError = gl.getError();
        foreign.deleteBuffer(foreignBuffer);
        return {failures,restored,disposeError,foreignError};
      } finally {
        for (const restore of teardown) restore();
        renderer.dispose();canvas.remove();
      }
    }

    const control = await cycle(new T.WebGLRenderer(),1);
    const {renderer} = await createGameRenderer({reason:'context-recovery-test'});
    const fixed = await cycle(renderer,2);
    return {control,fixed,methods};
  });
  console.log(JSON.stringify(result));
  assert.deepEqual(new Set(result.control.failures.map(failure => failure.name)),new Set(result.methods));
  assert.ok(result.control.failures.every(failure => failure.error === 1282));
  assert.deepEqual(result.fixed.failures,[]);
  assert.equal(result.fixed.disposeError,0);
  assert.equal(result.fixed.foreignError,1282);
  for (const sample of result.fixed.restored) {
    assert.deepEqual(sample.rebuilt,sample.initial);
    assert.ok(sample.rebuilt[0]>0 && sample.rebuilt[0]>sample.rebuilt[1]);
    for (const field of ['initialError','beforeDrawError','redrawError']) assert.equal(sample[field],0);
    assert.equal(sample.liveBeforeDelete,true);assert.equal(sample.liveAfterDelete,false);
    assert.equal(sample.lost,false);
  }
  console.log('PASS: retained geometry, textures and render targets survive two context rebuilds');
} finally {
  await browser?.close();
  server.close();
}
