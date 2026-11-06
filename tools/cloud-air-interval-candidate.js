// Tool-only Far transport candidate. Keep the public column entry points,
// physical airSample/mediumStep kernels and each interval's original nodes.
// Near cloudAirTransport and its persistent cell state are not rewritten.
import assert from 'node:assert/strict';

function once(source, before, after) {
  assert.equal(source.split(before).length, 2, 'Exact interval candidate anchor: ' + before.slice(0, 100));
  return source.replace(before, after);
}

export function cloudAirIntervalCandidate(source) {
  let result = source;
  const payload = `
      struct CloudColumnPayload {
        vec3 nearLight,farLight;
        float opacity,frontEnd,gapEnd,farT,crossOpacity,farVisible;
        bool gapEnabled,valid;
      };
      CloudColumnPayload cloudEmptyColumnPayload() {
        CloudColumnPayload p;
        p.nearLight=vec3(0);p.farLight=vec3(0);
        p.opacity=0.0;p.frontEnd=-1.0;p.gapEnd=0.0;
        p.farT=1.0;p.crossOpacity=0.0;p.farVisible=0.0;p.gapEnabled=false;p.valid=false;
        return p;
      }
`;
  result = once(result, '      vec4 cloudCachedColumn(vec3 dir,float start,float end) {',
    payload + `      CloudColumnPayload cloudPrepareCachedColumn(vec3 dir,float start,float end) {
        CloudColumnPayload payload=cloudEmptyColumnPayload();`);
  result = once(result, '        if(transmission>0.996) return vec4(0);',
    '        if(transmission>0.996) return payload;');
  result = once(result,
    `        vec2 air=air_sphereHits(uCameraLocal,air_uTopR,dir);
        vec3 beforeL,beforeT,gapL=vec3(0),gapT=vec3(1);
        airIntegrate(uCameraLocal,dir,max(0.0,air.x),min(first,air.y),beforeL,beforeT);
        if(highT<0.999999 && lowT<0.999999 && last>first)
          cloudAirGap(uCameraLocal,dir,first,last,gapL,gapT);
        vec3 correction=beforeL*(1.0-transmission)+beforeT*
          (nearLight*uTint+gapL*max(0.0,1.0-farT-crossOpacity)+gapT*farLight*uTint*farVisible);
        return vec4(correction,1.0-transmission);`,
    `        payload.nearLight=nearLight;payload.farLight=farLight;
        payload.opacity=1.0-transmission;payload.frontEnd=first;payload.gapEnd=last;
        payload.farT=farT;payload.crossOpacity=crossOpacity;payload.farVisible=farVisible;
        payload.gapEnabled=highT<0.999999 && lowT<0.999999 && last>first;payload.valid=true;
        return payload;`);
  result = once(result, '      vec4 cloudFarColumn(vec3 dir, float start, float end) {',
    `      CloudColumnPayload cloudPreparePointColumn(vec3 dir, float start, float end) {
        CloudColumnPayload payload=cloudEmptyColumnPayload();`);
  result = once(result, '        if(moment<0.004) return vec4(0.0);',
    '        if(moment<0.004) return payload;');
  result = once(result,
    `        vec2 air=air_sphereHits(uCameraLocal,air_uTopR,dir);
        vec3 light,transmission;
        airIntegrate(uCameraLocal,dir,max(0.0,air.x),min(t,air.y),light,transmission);
        return vec4((light+transmission*source*uTint)*moment,moment);`,
    `        payload.nearLight=source;payload.opacity=moment;payload.frontEnd=t;payload.valid=true;
        return payload;`);
  const transport = `
      // One physical sample/transfer call site for front and gap intervals.
      // Front retains airIntegrate's VIEW_STEPS quadrature. Gap reproduces
      // cloudAirTransport(reuseCells=false), including its final prefix combine.
      void cloudFarAirInterval(vec3 origin,vec3 dir,float a,float b,bool gap,
        out vec3 light,out vec3 transmission) {
        light=vec3(0);transmission=vec3(1);
        if(air_uEnabled<0.5 || b<=a)return;
        bool quadratic=true;
        int count=int(air_uViewSteps);
        float stride=0.0,previous=a;
        if(gap) {
          float cellLimit=min(air_uRayleighScaleHeight,air_uMieScaleHeight)*0.25;
          quadratic=b-a>cellLimit*min(32.0,air_uViewSteps);
          count=quadratic?int(air_uViewSteps)
            :int(clamp(ceil((b-a)/max(cellLimit,50.0)),1.0,32.0));
          stride=(b-a)/float(count);
        }
        for(int i=0;i<count;i++) {
          float next=a,distance;
          vec3 position;
          if(quadratic) {
            next=atmosphereSampleBoundary(a,b,-dot(origin,dir),float(i+1)/air_uViewSteps);
            distance=next-previous;
            position=origin+dir*(previous+next)*0.5;
          } else {
            distance=stride;
            position=origin+dir*(a+(float(i)+0.5)*stride);
          }
          vec3 extinction,source;
          airSample(position,dir,distance,extinction,source);
          mediumStep(light,transmission,extinction,source,distance);
          previous=next;
        }
        if(gap) {light=vec3(0)+vec3(1)*light;transmission=vec3(1)*transmission;}
      }
      vec4 cloudColumnResult(vec3 dir,float start,float end,bool cached) {
        CloudColumnPayload payload;
        #if CLOUD_FAR_CACHE
        payload=cloudPrepareCachedColumn(dir,start,end);
        #else
        if(cached)payload=cloudPrepareCachedColumn(dir,start,end);
        else payload=cloudPreparePointColumn(dir,start,end);
        #endif
        if(!payload.valid)return vec4(0);
        vec2 air=air_sphereHits(uCameraLocal,air_uTopR,dir);
        vec3 beforeL=vec3(0),beforeT=vec3(1),gapL=vec3(0),gapT=vec3(1);
        for(int interval=0;interval<(payload.gapEnabled?2:1);interval++) {
          bool gap=interval>0;
          float a=gap?payload.frontEnd:max(0.0,air.x);
          float b=gap?payload.gapEnd:min(payload.frontEnd,air.y);
          vec3 light,transmission;
          cloudFarAirInterval(uCameraLocal,dir,a,b,gap,light,transmission);
          if(gap) {gapL=light;gapT=transmission;}
          else {beforeL=light;beforeT=transmission;}
        }
        #if !CLOUD_FAR_CACHE
        if(!cached)return vec4((beforeL+beforeT*payload.nearLight*uTint)*payload.opacity,payload.opacity);
        #endif
        vec3 correction=beforeL*payload.opacity+beforeT*
          (payload.nearLight*uTint+gapL*max(0.0,1.0-payload.farT-payload.crossOpacity)
            +gapT*payload.farLight*uTint*payload.farVisible);
        return vec4(correction,payload.opacity);
      }
      // Keep the existing optical-fixture entry signatures. Production Far
      // dispatch below calls cloudColumnResult once through its method loop.
      vec4 cloudCachedColumn(vec3 dir,float start,float end) {
        return cloudColumnResult(dir,start,end,true);
      }
      vec4 cloudFarColumn(vec3 dir, float start, float end) {
        // Explicit point fixtures keep their meaning even in CACHE1 materials.
        // This entry is not called by the production dispatch.
        CloudColumnPayload payload=cloudPreparePointColumn(dir,start,end);
        if(!payload.valid)return vec4(0);
        vec2 air=air_sphereHits(uCameraLocal,air_uTopR,dir);
        vec3 light,transmission;
        cloudFarAirInterval(uCameraLocal,dir,max(0.0,air.x),min(payload.frontEnd,air.y),false,light,transmission);
        return vec4((light+transmission*payload.nearLight*uTint)*payload.opacity,payload.opacity);
      }
`;
  result = once(result, '      void main() {', transport + '\n      void main() {');
  const start = '        #if PRODUCTION_CLOUD_MEDIUM && CLOUD_FAR_VIEW\n        {';
  const end = '        #else\n\n        float seg = t1 - t0;';
  assert.equal(result.split(start).length, 2);assert.equal(result.split(end).length, 2);
  const a=result.indexOf(start),b=result.indexOf(end,a);assert.ok(b>a);
  const dispatch = `        #if PRODUCTION_CLOUD_MEDIUM && CLOUD_FAR_VIEW
        {
          float footprint=rayCone*t0;
          #if CLOUD_FAR_CACHE
          bool cachedOnly=true,useCached=true;
          #else
          bool cachedOnly=uColumnsReady>0.5 && footprint>2400.0;
          bool useCached=uColumnsReady>0.5 && footprint>900.0;
          #endif
          vec4 pointColumn=vec4(0),cachedColumn=vec4(0);
          for(int method=cachedOnly?1:0;method<(useCached?2:1);method++) {
            vec4 column=cloudColumnResult(dir,t0,t1,method>0);
            if(method==0)pointColumn=column;else cachedColumn=column;
          }
          vec4 column=cachedOnly?cachedColumn:pointColumn;
          if(!cachedOnly && useCached)column=mix(pointColumn,cachedColumn,smoothstep(900.0,2400.0,footprint));
          if(column.a<0.004)discard;
          gl_FragColor=column*uEngage;
          return;
        }
`;
  return result.slice(0,a)+dispatch+result.slice(b);
}
