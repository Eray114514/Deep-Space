import { compilePrograms } from '../src/program-preparation.js';
import { createCompileCamera } from '../src/render-prewarm.js';
import { VOLUME_LAYER } from '../src/render-layers.js';
import { readGpuDisjointEpoch } from '../src/gpu-query-state.js';
import { farPointVariants } from './cloud-far-point-variants.js';
import { farPointMomentShaders } from './cloud-far-point-moments.js';
import { farPointBeamShader } from './cloud-far-point-beams.js';
import { farPointEmptyBoundsShader, pointEmptyBounds } from './cloud-far-point-empty-bounds.js';

// The density-only arm is intentionally not a color reference. Read the
// original and equivalent candidate both before and after Far composition.
export async function compareFarPoint(game, mode = 'shared') {
  const pipeline = game._pipeline, renderer = game._renderer, T = game._THREE;
  const pass = pipeline.volumePass, {farSplit:split,scene,camera,current} = pass;
  const owner = pass.activePlanet, mesh = owner.volCloudMesh, original = split.materials.point;
  const native = renderer.getContext(), timer = native.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!timer) throw Error('Far point comparison needs GPU timers');
  const width = current.width, height = current.height;
  const splitMoments = mode === 'moments', splitBeams = mode === 'beams', emptyBounds = mode === 'bounds';
  const nativeCounts = mode === 'native-counts';
  const {density,shared} = farPointVariants(original.fragmentShader);
  const momentSources = splitMoments && farPointMomentShaders(original.fragmentShader,density);
  const sources = nativeCounts ? {} : splitMoments ? momentSources : splitBeams ? {beams:farPointBeamShader(original.fragmentShader)}
    : emptyBounds ? {bounds:farPointEmptyBoundsShader(original.fragmentShader),clone:original.fragmentShader}
    : {density,shared};
  const momentTarget = splitMoments ? new T.WebGLRenderTarget(width,height,{
    format:T.RGFormat,type:T.FloatType,depthBuffer:false,minFilter:T.NearestFilter,magFilter:T.NearestFilter,
  }) : null;
  const candidate = nativeCounts ? null : splitMoments ? 'moments+light' : splitBeams ? 'all-beams' : emptyBounds ? 'bounds' : 'shared';
  const beamMasks = {'all-beams':15,solar:3,radial:12,'no-beams':0};
  const pathCounts = {'no-beams':0,solar:2,'solar+above':3};
  const source = new T.Group(), variants = {original}, queries = [];
  const observation = window.__farPointCompare = {dimensions:[width,height], mode,candidate,
    scratchBytes:momentTarget ? width*height*8 : 0, rows:[]};
  const profile = pass.profilePhase;
  let hook, deadline, boundsTexture, boundsSource, boundsVersion;
  try {
    for (const [name,fragmentShader] of Object.entries(sources)) {
      const material = new T.ShaderMaterial().copy(Object.assign(Object.create(original),{uniforms:{}}));
      material.fragmentShader = fragmentShader;
      Object.assign(material.uniforms,original.uniforms);
      variants[name] = material;
      const proxy = new T.Mesh(mesh.geometry,material);
      proxy.layers.set(VOLUME_LAYER);
      source.add(proxy);
    }
    if (momentTarget) variants.light.uniforms.tPointMoments = {value:momentTarget.texture};
    if (splitBeams) variants.beams.uniforms.uPointBeamMask = {value:15};
    if (emptyBounds) variants.bounds.uniforms.tPointEmptyBounds = {value:null};
    const at = performance.now();
    if (source.children.length) await pipeline.prepare(() => {
      const target = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
      try {
        renderer.setRenderTarget(split.scratch[0]);
        return compilePrograms(renderer,source,createCompileCamera(camera,VOLUME_LAYER),scene);
      } finally { renderer.setRenderTarget(target,face,mip); }
    },{label:'compare-far-point'});
    observation.prepareMs = performance.now()-at;
    const epoch = readGpuDisjointEpoch(native,timer);
    function updateBounds() {
      const texture = original.uniforms.uBandCandidates.value;
      if (!texture?.image || original.uniforms.uCandidatesReady.value !== 1) throw Error('Expected production candidate bounds');
      if (boundsSource === texture && boundsVersion === texture.version) return;
      const {width,height,depth} = texture.image;
      const data = pointEmptyBounds(texture.image);
      boundsTexture?.dispose();
      boundsTexture = new T.DataArrayTexture(data,width,height,depth);
      boundsTexture.format = T.RGIntegerFormat;
      boundsTexture.type = T.UnsignedByteType;
      boundsTexture.needsUpdate = true;
      variants.bounds.uniforms.tPointEmptyBounds.value = boundsTexture;
      boundsSource = texture;boundsVersion = texture.version;
      observation.scratchBytes = data.byteLength;
    }

    function read(target,array) {
      const pixels = new array(width*height*4);
      renderer.readRenderTargetPixels(target,0,0,width,height,pixels);
      return pixels;
    }

    function difference(a,b,convert = value => value) {
      const result = {changed:0,alphaChanged:0,nonempty:0,maximumError:0,alphaMaximumError:0,alphaAboveGate:0,zeroCrossings:0};
      for (let i=0;i<a.length;i++) {
        const alpha = i%4===3;
        if (alpha && convert(a[i])>0) result.nonempty++;
        if (a[i] === b[i]) continue;
        result.changed++;
        const originalValue = convert(a[i]), candidateValue = convert(b[i]);
        const error = Math.abs(originalValue-candidateValue);
        if (alpha) {
          result.alphaChanged++;
          if (error>.002) result.alphaAboveGate++;
          if ((originalValue>0)!==(candidateValue>0)) result.zeroCrossings++;
          if (error>result.alphaMaximumError) {
            result.alphaMaximumError = error;
            const pixel = (i-3)/4;
            result.worstAlpha = {x:pixel%width,y:Math.floor(pixel/width),originalValue,candidateValue};
          }
        }
        result.maximumError = Math.max(result.maximumError,error);
      }
      return result;
    }

    function submitPoint(material,target) {
      Object.assign(material.uniforms,original.uniforms);
      mesh.material = material;
      renderer.setRenderTarget(target);
      renderer.clear(true,false,false);
      material.uniformsNeedUpdate = true;
      renderer.render(scene,camera);
    }

    function drawPoint(arm,target,timed) {
      const previous = mesh.material, autoClear = renderer.autoClear;
      let query;
      if (timed) {
        if (native.getQuery(timer.TIME_ELAPSED_EXT,native.CURRENT_QUERY)) throw Error('Overlapping Far point query');
        query = native.createQuery();
        if (!query) throw Error('Cannot create Far point query');
        queries.push(query);
        native.beginQuery(timer.TIME_ELAPSED_EXT,query);
      }
      try {
        renderer.autoClear = false;
        if (arm === candidate && momentTarget) {
          submitPoint(variants.moments,momentTarget);
          submitPoint(variants.light,target);
        } else if (splitBeams && arm !== 'original') {
          variants.beams.uniforms.uPointBeamMask.value = beamMasks[arm];
          submitPoint(variants.beams,target);
        } else if ((emptyBounds || nativeCounts) && Object.hasOwn(pathCounts,arm)) {
          const count = original.uniforms.uLightPathCount, program = renderer.properties.get(original).currentProgram;
          if (count.value !== 4) throw Error('Expected four production light paths');
          count.value = pathCounts[arm];
          try { submitPoint(original,target); }
          finally { count.value = 4;original.uniformsNeedUpdate = true; }
          if (renderer.properties.get(original).currentProgram !== program) throw Error('Path-count draw changed the production program');
        } else submitPoint(variants[arm],arm === 'moments' ? momentTarget : target);
      } finally {
        mesh.material = previous;
        renderer.autoClear = autoClear;
        renderer.setRenderTarget(current);
        if (query && !native.isContextLost()) native.endQuery(timer.TIME_ELAPSED_EXT);
      }
      return query;
    }

    function drawComposite(material) {
      const {frames,lastRoute,materials} = split;
      split.materials = {...materials,point:material};
      try {
        renderer.setRenderTarget(current);
        renderer.clear(true,false,false);
        if (!split.render(scene,camera,current,pass.columnMaps.get(owner))) throw Error('Far comparison lost the split draw');
      } finally { Object.assign(split,{frames,lastRoute,materials}); }
    }

    await new Promise((resolve,reject) => {
      deadline = setTimeout(() => reject(Error('Far point comparison did not receive matched frames')),45000);
      hook = function(name,work,options) {
        const result = profile.call(this,name,work,options);
        if (name !== 'volume-current' || pass.activePlanet !== owner || !pass.previousSplitDraw
          || split.lastRoute !== 'combine' || !split.plan || observation.rows.length>=5) return result;
        try {
          if (pass.current !== current || split.materials.point !== original || split.plan.mesh !== mesh
            || owner.volCloudMat.uniforms.uColumnsReady.value !== 1) throw Error('Far point comparison inputs changed');
          const point = split.scratch[0];
          if (emptyBounds) updateBounds();
          if (!observation.parity) {
            const half = T.DataUtils.fromHalfFloat;
            const productionPoint = read(point,Float32Array), production = read(current,Uint16Array);
            drawPoint('original',point,false);
            const repeat = difference(productionPoint,read(point,Float32Array));
            if (nativeCounts) {
              const controls = {}, alphaBetweenArms = {};
              for (const arm of Object.keys(pathCounts)) {
                drawPoint(arm,point,false);
                controls[arm] = read(point,Float32Array);
              }
              drawPoint('original',point,false);
              for (const arm of ['solar','solar+above'])
                alphaBetweenArms[arm] = difference(controls['no-beams'],controls[arm]).alphaChanged;
              observation.parity = {repeat, alphaBetweenArms,
                counts:Object.fromEntries(Object.entries(controls).map(([arm,pixels])=>[arm,difference(productionPoint,pixels)])),
                restored:difference(productionPoint,read(point,Float32Array)),
                composed:difference(production,read(current,Uint16Array),half)};
              if (repeat.changed || observation.parity.restored.changed || observation.parity.composed.changed)
                throw Error('Same-program point diagnostics disturbed the original output');
              return result;
            }
            try {
              if (momentTarget) drawPoint('moments',point,false);
              drawComposite(variants.light || variants.beams || variants.bounds || variants.shared);
              observation.parity = {repeat, payload:difference(productionPoint,read(point,Float32Array)),
                composite:difference(production,read(current,Uint16Array),half)};
            } finally { drawComposite(original); }
            observation.parity.restored = difference(production,read(current,Uint16Array),half);
            if (emptyBounds) {
              drawPoint('clone',point,false);
              observation.parity.clone = difference(productionPoint,read(point,Float32Array));
              observation.parity.nativeCounts = {};
              for (const arm of Object.keys(pathCounts)) {
                drawPoint(arm,point,false);
                observation.parity.nativeCounts[arm] = difference(productionPoint,read(point,Float32Array));
              }
            }
            const {payload,composite,restored} = observation.parity;
            if (!payload.nonempty || repeat.changed || restored.changed || payload.alphaChanged
              || composite.alphaChanged || !(payload.maximumError<=.002) || !(composite.maximumError<=.002))
              observation.candidateRejected = true;
            return result;
          }
          const index = observation.rows.length;
          const densityArm = splitMoments ? 'moments' : 'density';
          const order = nativeCounts ? ['original','solar','solar+above','no-beams']
            : splitBeams ? ['original',candidate,'solar','radial','no-beams']
            : emptyBounds ? ['original',candidate,'solar','solar+above','no-beams'] : ['original',densityArm,candidate];
          if (index%2) order.reverse();
          const row = {frame:pass.frame,hours:owner.weatherHours,order,queries:{}};
          for (const arm of order) row.queries[arm] = drawPoint(arm,point,true);
          observation.rows.push(row);
          if (observation.rows.length === 5) resolve();
        } catch(error) { reject(error); }
        return result;
      };
      pass.profilePhase = hook;
    });
    pass.profilePhase = profile;
    const end = performance.now()+30000;
    while (queries.some(query => !native.getQueryParameter(query,native.QUERY_RESULT_AVAILABLE))) {
      if (performance.now()>end || native.isContextLost()) throw Error('Far point timing did not complete');
      await new Promise(resolve => setTimeout(resolve,20));
    }
    if (readGpuDisjointEpoch(native,timer) !== epoch) throw Error('Far point timing became disjoint');
    for (const row of observation.rows) {
      row.gpuMs = Object.fromEntries(Object.entries(row.queries).map(([name,query]) =>
        [name,native.getQueryParameter(query,native.QUERY_RESULT)/1e6]));
      delete row.queries;
    }
    return {...observation,gl:native.getError(),lost:native.isContextLost()};
  } finally {
    clearTimeout(deadline);
    if (pass.profilePhase === hook) pass.profilePhase = profile;
    if (!native.isContextLost()) for (const query of queries) native.deleteQuery(query);
    for (const [name,material] of Object.entries(variants)) if (name !== 'original') material.dispose();
    momentTarget?.dispose();
    boundsTexture?.dispose();
  }
}
