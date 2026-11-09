import { compilePrograms } from '../src/program-preparation.js';
import { createCompileCamera } from '../src/render-prewarm.js';
import { VOLUME_LAYER } from '../src/render-layers.js';
import { readGpuDisjointEpoch } from '../src/gpu-query-state.js';
import { farPointVariants } from './cloud-far-point-variants.js';
import { farPointMomentShaders } from './cloud-far-point-moments.js';
import { farPointBeamShader } from './cloud-far-point-beams.js';
import { farPointEmptyBoundsShader, pointEmptyBounds } from './cloud-far-point-empty-bounds.js';
import { farPointSolarTailShader } from './cloud-far-point-solar-tail.js';
import { farPointRadialShader } from './cloud-far-point-radial.js';
import { farPointRadialEdgesShader } from './cloud-far-point-radial-edges.js';
import { farPointAdvectionShader, pointAdvectionRotation } from './cloud-far-point-advection.js';

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
  const solarTail = mode === 'solar-tail';
  const radialEdge = mode === 'radial-edge', radial = mode === 'radial' || radialEdge;
  const advection = mode === 'advection', bounded = radial || advection;
  const privateCompare = solarTail || bounded;
  const {density,shared} = farPointVariants(original.fragmentShader);
  const momentSources = splitMoments && farPointMomentShaders(original.fragmentShader,density);
  const sources = nativeCounts ? {} : radialEdge ? {tail:farPointRadialEdgesShader(original.fragmentShader)}
    : radial ? {tail:farPointRadialShader(original.fragmentShader)}
    : advection ? {tail:farPointAdvectionShader(original.fragmentShader)}
    : solarTail ? {tail:farPointSolarTailShader(original.fragmentShader)}
    : splitMoments ? momentSources : splitBeams ? {beams:farPointBeamShader(original.fragmentShader)}
    : emptyBounds ? {bounds:farPointEmptyBoundsShader(original.fragmentShader),clone:original.fragmentShader}
    : {density,shared};
  const momentTarget = splitMoments ? new T.WebGLRenderTarget(width,height,{
    format:T.RGFormat,type:T.FloatType,depthBuffer:false,minFilter:T.NearestFilter,magFilter:T.NearestFilter,
  }) : null;
  const privateTarget = type => new T.WebGLRenderTarget(width,height,{
    type,depthBuffer:false,minFilter:T.NearestFilter,magFilter:T.NearestFilter,
  });
  const tailPoint = privateCompare ? privateTarget(T.FloatType) : null;
  const tailHdr = privateCompare ? privateTarget(T.HalfFloatType) : null;
  const candidate = nativeCounts ? null : radialEdge ? 'radial-edge' : radial ? 'radial-cell' : advection ? 'advection'
    : solarTail ? 'tail-capped' : splitMoments ? 'moments+light'
    : splitBeams ? 'all-beams' : emptyBounds ? 'bounds' : 'shared';
  const tailBudget = 1/4096;
  const beamMasks = {'all-beams':15,solar:3,radial:12,'no-beams':0};
  const pathCounts = {'no-beams':0,solar:2,'solar+above':3};
  const source = new T.Group(), variants = {original}, queries = [];
  const observation = window.__farPointCompare = {dimensions:[width,height], mode,candidate,
    scratchBytes:momentTarget ? width*height*8 : privateCompare ? width*height*24 : 0, rows:[]};
  const privateFrames = [];
  if (privateCompare) observation[solarTail?'tailFrames':'privateFrames'] = privateFrames;
  const radialArms = radialEdge ? ['radial-cell','radial-edge'] : ['radial-atlas','radial-cell'];
  const parityArms = radial ? radialArms : [candidate];
  const boundedArms = ['tail-zero',...parityArms];
  const radialModes = {'tail-zero':0,'radial-atlas':1,'radial-cell':2,'radial-edge':3};
  const parityLimit = parityArms.length*3, timingLimit = bounded ? boundedArms.length*(radialEdge ? 5 : 3) : 5;
  const profile = pass.profilePhase;
  let hook, deadline, boundsTexture, boundsSource, boundsVersion, pacer;
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
    if (solarTail) variants.tail.uniforms.uPointSolarTail = {value:0};
    if (radial) variants.tail.uniforms.uPointRadialMode = {value:0};
    if (advection) {
      variants.tail.uniforms.uPointAdvectionMode = {value:0};
      variants.tail.uniforms.uPointAdvectionRotation = {value:new Float32Array(32)};
    }
    const at = performance.now();
    if (source.children.length) await pipeline.prepare(() => {
      const target = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
      try {
        renderer.setRenderTarget(tailPoint || split.scratch[0]);
        return compilePrograms(renderer,source,createCompileCamera(camera,VOLUME_LAYER),scene);
      } finally { renderer.setRenderTarget(target,face,mip); }
    },{label:'compare-far-point'});
    observation.prepareMs = performance.now()-at;
    if (bounded && !pipeline.framePacer) pacer = pipeline.startFramePacing();
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
        } else if (privateCompare && arm !== 'original') {
          if (radial) variants.tail.uniforms.uPointRadialMode.value = radialModes[arm];
          else if (advection) variants.tail.uniforms.uPointAdvectionMode.value = arm === 'tail-zero' ? 0 : 1;
          else variants.tail.uniforms.uPointSolarTail.value = arm === 'tail-zero' ? 0 : tailBudget;
          submitPoint(variants.tail,target);
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

    function composeTail() {
      const combine = split.materials.combine, uniform = combine.uniforms.uSplitPoint;
      const saved = uniform.value, previous = mesh.material, autoClear = renderer.autoClear;
      try {
        uniform.value = tailPoint.texture;
        renderer.autoClear = false;
        renderer.setRenderTarget(tailHdr);
        renderer.clear(true,false,false);
        mesh.material = combine;
        combine.uniformsNeedUpdate = true;
        renderer.render(scene,camera);
      } finally {
        uniform.value = saved;
        combine.uniformsNeedUpdate = true;
        mesh.material = previous;
        renderer.autoClear = autoClear;
        renderer.setRenderTarget(current);
      }
      return read(tailHdr,Uint16Array);
    }

    function tailParity(pointTarget,arm) {
      const half = T.DataUtils.fromHalfFloat;
      const productionPoint = read(pointTarget,Float32Array), production = read(current,Uint16Array);
      drawPoint('original',tailPoint,false);
      const repeat = difference(productionPoint,read(tailPoint,Float32Array));
      const composeRepeat = difference(production,composeTail(),half);
      drawPoint('tail-zero',tailPoint,false);
      const first = difference(productionPoint,read(tailPoint,Float32Array));
      if (!bounded || first.changed) drawPoint('tail-zero',tailPoint,false);
      const reference = read(tailPoint,Float32Array), referenceHdr = composeTail();
      drawPoint(arm,tailPoint,false);
      const pixels = read(tailPoint,Float32Array), composed = composeTail();
      const untouchedPoint = difference(productionPoint,read(pointTarget,Float32Array));
      const untouchedHdr = difference(production,read(current,Uint16Array),half);
      if (repeat.changed || composeRepeat.changed || untouchedPoint.changed || untouchedHdr.changed)
        throw Error('Far point oracle or private target isolation failed');
      return {arm,frame:pass.frame,hours:owner.weatherHours,budget:solarTail?tailBudget:undefined,first,repeat,composeRepeat,untouchedPoint,untouchedHdr,
        warm:difference(productionPoint,reference),warmHdr:difference(production,referenceHdr,half),
        relativePoint:difference(reference,pixels),relativeHdr:difference(referenceHdr,composed,half),
        actualPoint:difference(productionPoint,pixels),actualHdr:difference(production,composed,half)};
    }

    await new Promise((resolve,reject) => {
      deadline = setTimeout(() => reject(Error('Far point comparison did not receive matched frames')),bounded?70000:45000);
      hook = function(name,work,options) {
        let originalQuery;
        const timed = bounded && name==='volume-current' && privateFrames.length===parityLimit
          && observation.rows.length<timingLimit && split.lastRoute==='combine';
        const render = renderer.render;
        if (timed) renderer.render = function(...args) {
          if (mesh.material!==original) return render.apply(this,args);
          if (originalQuery || native.getQuery(timer.TIME_ELAPSED_EXT,native.CURRENT_QUERY))
            throw Error('Overlapping live Far point query');
          originalQuery = native.createQuery();
          if (!originalQuery) throw Error('Cannot time live Far point draw');
          queries.push(originalQuery);
          native.beginQuery(timer.TIME_ELAPSED_EXT,originalQuery);
          try { return render.apply(this,args); }
          finally { if (!native.isContextLost()) native.endQuery(timer.TIME_ELAPSED_EXT); }
        };
        let result;
        try { result = timed ? work() : profile.call(this,name,work,options); }
        finally { if (timed) renderer.render = render; }
        if (name !== 'volume-current' || pass.activePlanet !== owner || !pass.previousSplitDraw
          || split.lastRoute !== 'combine' || !split.plan || observation.rows.length>=timingLimit) return result;
        try {
          if (pass.current !== current || split.materials.point !== original || split.plan.mesh !== mesh
            || owner.volCloudMat.uniforms.uColumnsReady.value !== 1) throw Error('Far point comparison inputs changed');
          const point = split.scratch[0];
          if (advection) pointAdvectionRotation(original.uniforms.uSpeciesParameters.value,
            original.uniforms.uCloudAdvectionPhase.value,variants.tail.uniforms.uPointAdvectionRotation.value);
          if (privateCompare && privateFrames.length<parityLimit) {
            const row = tailParity(point,parityArms[privateFrames.length%parityArms.length]);
            privateFrames.push(row);
            observation.parity = row;
            if (row.warm.changed || row.warmHdr.changed || row.actualPoint.alphaChanged || row.actualHdr.alphaChanged
              || !(row.actualPoint.maximumError<=.002) || !(row.actualHdr.maximumError<=.002))
              observation.candidateRejected = true;
            return result;
          }
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
          if (bounded) {
            if (!originalQuery) return result;
            const arm = boundedArms[observation.rows.length%boundedArms.length];
            observation.rows.push({frame:pass.frame,hours:owner.weatherHours,order:['original',arm],
              queries:{original:originalQuery,[arm]:drawPoint(arm,tailPoint,true)}});
            if (observation.rows.length===timingLimit) resolve();
            return result;
          }
          const index = observation.rows.length;
          const densityArm = splitMoments ? 'moments' : 'density';
          const order = solarTail ? ['original','tail-zero',candidate]
            : nativeCounts ? ['original','solar','solar+above','no-beams']
            : splitBeams ? ['original',candidate,'solar','radial','no-beams']
            : emptyBounds ? ['original',candidate,'solar','solar+above','no-beams'] : ['original',densityArm,candidate];
          if (index%2) order.reverse();
          const row = {frame:pass.frame,hours:owner.weatherHours,order,queries:{}};
          for (const arm of order) row.queries[arm] = drawPoint(arm,tailPoint || point,true);
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
    if (pacer && pipeline.framePacer===pacer) pipeline.stopFramePacing();
    if (!native.isContextLost()) for (const query of queries) native.deleteQuery(query);
    for (const [name,material] of Object.entries(variants)) if (name !== 'original') material.dispose();
    momentTarget?.dispose();
    tailPoint?.dispose();tailHdr?.dispose();
    boundsTexture?.dispose();
  }
}
