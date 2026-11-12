import assert from 'node:assert/strict';
import { makeCloudVolumeMaterial, disposeCloudNoiseTexture } from '../src/clouds-webgl.js';
import { cloudFarSplitShaders } from '../src/cloud/cloud-far-split-shaders.js';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';

const mat = makeCloudVolumeMaterial({ R: 6000000 },
  { rIn: 6000000, rOut: 6040000, localWeather: true, ox: 0, oy: 0, oz: 0 }, null, null, null);
mat.defines.CLOUD_FAR_VIEW = 1;
const shadersDefault = cloudFarSplitShaders(mat.fragmentShader, { splitPoint: false });
const shadersSplit = cloudFarSplitShaders(mat.fragmentShader, { splitPoint: true });
const { server, port } = await startServer(0);
let browser;
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined });
  const page = await browser.newPage();
  await page.route('**/far-compile.html', route => route.fulfill({
    contentType: 'text/html',
    body: '<script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>',
  }));
  await page.goto(`http://127.0.0.1:${port}/far-compile.html`);
  const res = await page.evaluate(async ({ shadersDefault, shadersSplit, vertex, defines }) => {
    const T = await import('three'), r = new T.WebGLRenderer(), scene = new T.Scene(), camera = new T.Camera(), logs = [];
    r.debug.onShaderError = (gl, p, vs, fs) => logs.push({
      vs: gl.getShaderInfoLog(vs),
      fs: gl.getShaderInfoLog(fs),
      prog: gl.getProgramInfoLog(p),
    });
    const gl = r.getContext(), geo = new T.PlaneGeometry(), records = [];
    for (const [group, dict] of [['default', shadersDefault], ['splitPoint', shadersSplit]]) {
      for (const [name, fs] of Object.entries(dict)) {
        if (typeof fs !== 'string') continue;
        const m = new T.ShaderMaterial({
          vertexShader: vertex,
          fragmentShader: fs,
          defines: { ...defines, CLOUD_FAR_CACHE: name === 'cachedDirect' ? 1 : 0 },
        });
        const mesh = new T.Mesh(geo, m);
        scene.add(mesh);
        r.compile(scene, camera);
        const prog = r.properties.get(m).currentProgram;
        prog.getUniforms();
        records.push({ group, name, linked: gl.getProgramParameter(prog.program, gl.LINK_STATUS) });
        scene.remove(mesh);
        m.dispose();
      }
    }
    const err = gl.getError();
    geo.dispose();
    r.dispose();
    return { logs, records, err };
  }, {
    shadersDefault: Object.fromEntries(Object.entries(shadersDefault).filter(([, v]) => typeof v === 'string')),
    shadersSplit: Object.fromEntries(Object.entries(shadersSplit).filter(([, v]) => typeof v === 'string')),
    vertex: mat.vertexShader,
    defines: mat.defines,
  });
  console.log(JSON.stringify(res, null, 2));
  assert.deepEqual(res.logs, []);
  for (const r of res.records) assert.equal(r.linked, true, `${r.group}:${r.name}`);
  assert.equal(res.err, 0);
} finally {
  mat.dispose();
  disposeCloudNoiseTexture();
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
